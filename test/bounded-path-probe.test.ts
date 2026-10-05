/**
 * @fileoverview Tests for the bounded path probe (src/utils/bounded-path-probe.ts):
 * a stat() that never settles (an unreachable hard network mount) must not hold
 * the caller past the timeout, must read as "unknown" rather than "absent", must
 * not be re-issued while it is still pending, must not let stalled probes pile up
 * in libuv's shared threadpool, and must not make unrelated healthy paths unknown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  default: { stat: vi.fn() },
}));

// The kernel mount table the probe scopes a stall by. `/mnt/nas` and `/mnt/nas b`
// (a mount point with a space, octal-escaped in the table) are network mounts;
// everything else sits on the root filesystem. `null` = no table (not Linux).
const mounts = vi.hoisted(() => ({
  table: null as string | null,
  default: [
    'sysfs /sys sysfs rw 0 0',
    '/dev/sda1 / ext4 rw 0 0',
    'nas:/export /mnt/nas nfs rw,hard 0 0',
    'nas:/other /mnt/nas\\040b nfs rw,hard 0 0',
    '',
  ].join('\n'),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (String(path) === '/proc/self/mounts') {
      if (mounts.table === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return mounts.table;
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

import fs from 'node:fs/promises';
import { boundedPathExists, isNearStalledPath, probePath, probePathKind } from '../src/utils/bounded-path-probe.js';
import { MAX_STALLED_PATH_PROBES, PATH_PROBE_STALL_CEILING, PATH_PROBE_TIMEOUT_MS } from '../src/config/path-probe.js';

const stat = vi.mocked(fs.stat);
const dirStats = { isDirectory: () => true } as never;
const fileStats = { isDirectory: () => false } as never;

let releases: Map<string, () => void>;
let warn: ReturnType<typeof vi.spyOn>;

/**
 * Make the first stat() of each given path hang until released (the mount is
 * down); every later stat, and every other path, answers "a directory exists".
 */
function hangOn(paths: string[]): Map<string, () => void> {
  stat.mockImplementation((path) => {
    if (!paths.includes(String(path)) || releases.has(String(path))) return Promise.resolve(dirStats);
    return new Promise((resolve) => {
      releases.set(String(path), () => resolve(dirStats));
    });
  });
  return releases;
}

/** Start probes for `paths` and let them time out, leaving each one stalled. */
async function stall(paths: string[]): Promise<void> {
  const pending = paths.map((p) => probePath(p));
  await vi.advanceTimersByTimeAsync(PATH_PROBE_TIMEOUT_MS);
  expect(await Promise.all(pending)).toEqual(paths.map(() => 'unknown'));
}

beforeEach(() => {
  mounts.table = mounts.default;
  releases = new Map();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  // Settle every stalled stat so module state does not leak into the next test.
  releases.forEach((release) => release());
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((r) => setTimeout(r, 0));
  vi.useRealTimers();
  stat.mockReset();
  warn.mockRestore();
});

describe('probePath', () => {
  it('tells present, absent and unreadable apart', async () => {
    stat.mockImplementation(async (path) => {
      if (String(path) === '/present') return dirStats;
      if (String(path) === '/eio') throw Object.assign(new Error('EIO'), { code: 'EIO' });
      if (String(path) === '/notdir/child') throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(await probePath('/present')).toBe('present');
    expect(await probePath('/missing')).toBe('absent');
    expect(await probePath('/notdir/child')).toBe('absent');
    // A soft mount that gave up answers EIO: that is not proof the path is gone.
    expect(await probePath('/eio')).toBe('unknown');
    expect(await boundedPathExists('/present')).toBe(true);
    expect(await boundedPathExists('/missing')).toBe(false);
    expect(await boundedPathExists('/eio')).toBe(false);
  });

  it('reports whether a present path is a directory', async () => {
    stat.mockImplementation(async (path) => (String(path) === '/dir' ? dirStats : fileStats));
    expect(await probePathKind('/dir')).toBe('directory');
    expect(await probePathKind('/file')).toBe('file');
  });

  it('answers unknown (not absent) after the timeout, and does not re-probe until the stat settles', async () => {
    vi.useFakeTimers();
    hangOn(['/mnt/stalled/case']);

    const result = probePath('/mnt/stalled/case');
    await vi.advanceTimersByTimeAsync(PATH_PROBE_TIMEOUT_MS);
    expect(await result).toBe('unknown');

    // A second caller gets the cached verdict immediately, without another stat.
    expect(await probePath('/mnt/stalled/case')).toBe('unknown');
    expect(stat).toHaveBeenCalledTimes(1);

    // Once the mount answers, the path is probed afresh.
    releases.get('/mnt/stalled/case')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(await probePath('/mnt/stalled/case')).toBe('present');
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight stat between concurrent callers of the same path', async () => {
    hangOn(['/slow']);
    const a = probePath('/slow');
    const b = boundedPathExists('/slow');
    expect(stat).toHaveBeenCalledTimes(1);
    releases.get('/slow')!();
    expect(await a).toBe('present');
    expect(await b).toBe(true);
  });

  it('does not give concurrent healthy probes a false negative', async () => {
    stat.mockImplementation(async () => dirStats);
    const results = await Promise.all(['/a', '/b', '/c', '/d', '/e'].map((p) => boundedPathExists(p)));
    expect(results).toEqual([true, true, true, true, true]);
  });

  it('still probes a healthy path as present while fewer unrelated paths are stalled than the cap', async () => {
    vi.useFakeTimers();
    const dead = Array.from({ length: MAX_STALLED_PATH_PROBES - 1 }, (_, i) => `/mnt/nas-${i}/project`);
    hangOn(dead);
    await stall(dead);

    expect(await probePath('/home/user/codeman-cases/healthy')).toBe('present');
    expect(await boundedPathExists('/home/user/codeman-cases/healthy/CLAUDE.md')).toBe(true);
    expect(isNearStalledPath('/home/user/codeman-cases/healthy')).toBe(false);
  });

  it('answers unknown, without a stat, for paths near a stalled one', async () => {
    vi.useFakeTimers();
    hangOn(['/mnt/nas/project-one']);
    await stall(['/mnt/nas/project-one']);
    stat.mockClear();

    // Its own files, and a sibling linked case on the same mount.
    expect(await probePath('/mnt/nas/project-one/CLAUDE.md')).toBe('unknown');
    expect(await probePath('/mnt/nas/project-two')).toBe('unknown');
    expect(isNearStalledPath('/mnt/nas/project-two/.claude/settings.local.json')).toBe(true);
    expect(stat).not.toHaveBeenCalled();

    releases.get('/mnt/nas/project-one')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(isNearStalledPath('/mnt/nas/project-two')).toBe(false);
    expect(await probePath('/mnt/nas/project-two')).toBe('present');
  });

  it('reads octal-escaped mount points from the table', async () => {
    vi.useFakeTimers();
    hangOn(['/mnt/nas b/one']);
    await stall(['/mnt/nas b/one']);
    expect(isNearStalledPath('/mnt/nas b/two')).toBe(true);
    expect(isNearStalledPath('/mnt/nas/two')).toBe(false);
  });

  it('never takes the root filesystem down with a stalled path on it, only that path', async () => {
    vi.useFakeTimers();
    hangOn(['/srv/projects/stuck']);
    await stall(['/srv/projects/stuck']);

    expect(await probePath('/srv/projects/stuck/CLAUDE.md')).toBe('unknown');
    expect(await probePath('/srv/projects/other')).toBe('present');
    expect(await probePath('/home/user/codeman-cases/one')).toBe('present');
  });

  it('narrows a stall on a local mount to the stalled path, even when that mount is not /', async () => {
    // /home is its own local filesystem; ~/nas is a symlink to a network mount, so
    // the stalled path is typed under /home. Only network and FUSE mounts widen.
    vi.useFakeTimers();
    mounts.table = [mounts.default, '/dev/sdb1 /home ext4 rw,relatime 0 0', ''].join('\n');
    hangOn(['/home/user/nas/project']);
    await stall(['/home/user/nas/project']);
    stat.mockClear();

    expect(await probePath('/home/user/nas/project/CLAUDE.md')).toBe('unknown');
    expect(isNearStalledPath('/home/user/codeman-cases/one')).toBe(false);
    expect(await probePath('/home/user/codeman-cases/one')).toBe('present');
    expect(await probePath('/home/user/nas/other')).toBe('present');
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('widens a stall to the whole mount for network and FUSE filesystems', async () => {
    vi.useFakeTimers();
    mounts.table = [
      mounts.default,
      'nas:/four /srv/nas4 nfs4 rw,hard 0 0',
      'user@host:/ /srv/sshfs fuse.sshfs rw 0 0',
      '//nas/share /srv/smb cifs rw 0 0',
      '',
    ].join('\n');
    const dead = ['/srv/nas4/one', '/srv/sshfs/one'];
    hangOn(dead);
    await stall(dead);

    expect(isNearStalledPath('/srv/nas4/two')).toBe(true);
    expect(isNearStalledPath('/srv/sshfs/two')).toBe(true);
    expect(isNearStalledPath('/srv/smb/two')).toBe(false);
    expect(isNearStalledPath('/srv/elsewhere')).toBe(false);
  });

  it('narrows a stall to the stalled path when there is no mount table', async () => {
    vi.useFakeTimers();
    mounts.table = null;
    hangOn(['/mnt/nas/project-one']);
    await stall(['/mnt/nas/project-one']);

    expect(await probePath('/mnt/nas/project-one/CLAUDE.md')).toBe('unknown');
    expect(await probePath('/mnt/nas/project-two')).toBe('present');
  });

  it('refuses new stats once stalled probes would tie up the threadpool, answering unknown', async () => {
    vi.useFakeTimers();
    const dead = Array.from({ length: MAX_STALLED_PATH_PROBES }, (_, i) => `/mnt/dead-${i}/case`);
    hangOn(dead);
    await stall(dead);
    stat.mockClear();

    // Every slot is held by a stat that never returned: refuse another, but never
    // claim the path is absent.
    expect(await probePath('/healthy/elsewhere')).toBe('unknown');
    expect(stat).not.toHaveBeenCalled();

    // Once the stalled stats settle, probing resumes normally.
    releases.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
    expect(await probePath('/healthy/elsewhere')).toBe('present');
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it('lets a pastCap probe through the cap, still bounded and still recorded as stalled', async () => {
    vi.useFakeTimers();
    const dead = Array.from({ length: MAX_STALLED_PATH_PROBES }, (_, i) => `/mnt/full-${i}/case`);
    hangOn([...dead, '/mnt/another-dead/case']);
    await stall(dead);
    stat.mockClear();

    expect(await probePath('/healthy/explicit', { pastCap: true })).toBe('present');

    const hung = probePath('/mnt/another-dead/case', { pastCap: true });
    await vi.advanceTimersByTimeAsync(PATH_PROBE_TIMEOUT_MS);
    expect(await hung).toBe('unknown');
    // A retry is answered from the stall record, not with another stat.
    expect(await probePath('/mnt/another-dead/case', { pastCap: true })).toBe('unknown');
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('stops pastCap probes at the threadpool ceiling, answering unknown without a stat', async () => {
    vi.useFakeTimers();
    // Fill the bulk cap, then let pastCap probes stall until the ceiling is reached.
    const dead = Array.from({ length: PATH_PROBE_STALL_CEILING + 1 }, (_, i) => `/mnt/ceiling-${i}/case`);
    hangOn(dead);
    await stall(dead.slice(0, MAX_STALLED_PATH_PROBES));
    for (const path of dead.slice(MAX_STALLED_PATH_PROBES, PATH_PROBE_STALL_CEILING)) {
      const hung = probePath(path, { pastCap: true });
      await vi.advanceTimersByTimeAsync(PATH_PROBE_TIMEOUT_MS);
      expect(await hung).toBe('unknown');
    }
    stat.mockClear();

    // One worker must stay free: no new stat, even for an explicit request.
    const refused = probePath(dead[PATH_PROBE_STALL_CEILING], { pastCap: true });
    await vi.advanceTimersByTimeAsync(PATH_PROBE_TIMEOUT_MS);
    expect(await refused).toBe('unknown');
    expect(stat).not.toHaveBeenCalled();
    expect(await probePath('/healthy/explicit', { pastCap: true })).toBe('unknown');
    expect(stat).not.toHaveBeenCalled();

    // Once one stalled stat settles, an explicit request is probed again.
    releases.get(dead[0])!();
    await vi.advanceTimersByTimeAsync(0);
    expect(await probePath('/healthy/explicit', { pastCap: true })).toBe('present');
  });

  it('keeps the bulk cap below the ceiling, so a pastCap probe has room', () => {
    expect(MAX_STALLED_PATH_PROBES).toBeLessThan(PATH_PROBE_STALL_CEILING);
  });

  it('warns once when a path first stalls and once when the cap engages', async () => {
    vi.useFakeTimers();
    const dead = Array.from({ length: MAX_STALLED_PATH_PROBES }, (_, i) => `/mnt/gone-${i}/case`);
    hangOn(dead);
    await stall([dead[0]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('/mnt/gone-0/case');

    // Asking again about the same stalled path does not warn again.
    await probePath(dead[0]);
    expect(warn).toHaveBeenCalledTimes(1);

    await stall(dead.slice(1));
    warn.mockClear();
    await probePath('/healthy/one');
    await probePath('/healthy/two');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/stalled/i);
  });
});
