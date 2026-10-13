/**
 * @fileoverview Tests for reading a remote session's scrollback from the remote
 * tmux (`src/remote-pane-history.ts`) and splicing it above the local frame.
 *
 * The remote script is also run by a real `/bin/sh`, with a stub `tmux` first on
 * PATH: the script IS the remote command, so `sh -c <script>` is what sshd runs on
 * the other end, and quoting mistakes show up there and nowhere else.
 *
 * Port: N/A (no HTTP server).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRemoteScrollbackCommand,
  buildRemoteScrollbackScript,
  dropPartialFirstRow,
  fetchRemoteScrollback,
  parseRemoteScrollbackOutput,
  resetRemoteScrollbackBackoff,
} from '../src/remote-pane-history.js';
import {
  getActiveRemoteSshCount,
  getQueuedRemoteSshCount,
  getRemoteSshLimit,
  runWithRemoteSshLimit,
} from '../src/remote-ssh-limiter.js';
import { joinScrollbackAndFrame, remoteTmuxLocation } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types/session.js';

const SESSION_ID = '663e3eae-8da6-4c7f-9231-611eb2840641';
const remote: SessionRemote = {
  hostId: 'h1',
  label: 'proxx',
  host: 'proxx.lan',
  username: 'tim',
  port: 2222,
  remotePath: '/home/tim',
};

describe('remoteTmuxLocation', () => {
  it('an owned session is the launch command’s session on the private socket', () => {
    expect(remoteTmuxLocation(remote, SESSION_ID)).toEqual({
      socket: 'codeman-remote',
      sessionName: 'codeman-ssh-663e3eae',
    });
  });

  it('a discovered session is the one the attach command joined on -L codeman', () => {
    const discovered = { ...remote, owned: false, remoteSessionName: 'codeman-disco1' };
    expect(remoteTmuxLocation(discovered, SESSION_ID)).toEqual({ socket: 'codeman', sessionName: 'codeman-disco1' });
  });
});

describe('buildRemoteScrollbackCommand', () => {
  it('goes through the shared ssh options and reads history rows only', () => {
    const command = buildRemoteScrollbackCommand(remote, SESSION_ID, 10000, 2048);
    expect(command.startsWith('exec ssh -o BatchMode=yes')).toBe(true);
    expect(command).toContain('-p 2222');
    expect(command).toContain('tim@proxx.lan');
    // Socket and target are shellescaped inside the (itself shellescaped) script.
    expect(command).toContain('codeman-remote');
    expect(command).toContain('codeman-ssh-663e3eae');
    expect(command).toContain('capture-pane -p -e -J -S -10000 -E -1');
    expect(command).toContain('#{history_size}');
    expect(command).toContain('| tail -c 2048');
  });

  it('a byte cap of 0 (unbounded) runs no tail', () => {
    expect(buildRemoteScrollbackCommand(remote, SESSION_ID, 10000, 0)).not.toContain('tail -c');
  });
});

describe('dropPartialFirstRow', () => {
  it('drops the row a tail -c cut landed in, and only then', () => {
    expect(dropPartialFirstRow('ow 1\nrow 2\n', 11)).toBe('row 2\n');
    expect(dropPartialFirstRow('row 1\nrow 2\n', 100)).toBe('row 1\nrow 2\n');
    expect(dropPartialFirstRow('no newline at all', 17)).toBe('');
    expect(dropPartialFirstRow('row 1\nrow 2\n', 0)).toBe('row 1\nrow 2\n');
  });
});

describe('parseRemoteScrollbackOutput', () => {
  it('drops anything printed before the script (login banner, rc-file echo)', () => {
    expect(parseRemoteScrollbackOutput('Welcome to proxx\n\x0042\n\x00line a\nline b\n')).toBe('line a\nline b\n');
  });

  it('an empty history is empty, not the first visible row tmux clamps -E -1 to', () => {
    expect(parseRemoteScrollbackOutput('\x000\n\x00$ the prompt row\n')).toBe('');
  });

  it('rejects output that is not the script’s', () => {
    expect(parseRemoteScrollbackOutput('')).toBeNull();
    expect(parseRemoteScrollbackOutput('no markers at all')).toBeNull();
    expect(parseRemoteScrollbackOutput('\x0042\n')).toBeNull();
    expect(parseRemoteScrollbackOutput('\x00not a number\n\x00rows')).toBeNull();
  });
});

describe('the remote script under a real shell', () => {
  let dir: string;
  let callsFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'remote-scrollback-'));
    callsFile = join(dir, 'calls');
    // Stub tmux: logs its argv (one per line), answers display-message with a
    // history size and capture-pane with two rows.
    writeFileSync(
      join(dir, 'tmux'),
      [
        '#!/bin/sh',
        `for a in "$@"; do printf '%s\\n' "$a"; done >> '${callsFile}'`,
        `printf -- '--\\n' >> '${callsFile}'`,
        'case " $* " in',
        '  *" display-message "*) echo 2 ;;',
        '  *" capture-pane "*) printf "older row\\nnewer row\\n" ;;',
        'esac',
      ].join('\n')
    );
    chmodSync(join(dir, 'tmux'), 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the markers and rows the parser expects, with the target as one argument', () => {
    const script = buildRemoteScrollbackScript('codeman', "codeman-it's", 500, 10);
    const stdout = execFileSync('/bin/sh', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    // `tail -c 10` kept the newest bytes only: "newer row\n".
    expect(parseRemoteScrollbackOutput(stdout)).toBe('newer row\n');
    const calls = execFileSync('cat', [callsFile], { encoding: 'utf-8' }).split('--\n').filter(Boolean);
    expect(calls).toHaveLength(2);
    // One argv entry per line: the exact-match target with a quote in it arrived whole.
    expect(calls[0].split('\n').join('|')).toBe("-L|codeman|display-message|-p|-t|=codeman-it's:|#{history_size}|");
    expect(calls[1].split('\n').join('|')).toBe("-L|codeman|capture-pane|-p|-e|-J|-S|-500|-E|-1|-t|=codeman-it's:|");
  });
});

describe('joinScrollbackAndFrame', () => {
  it('puts the scrollback rows above the frame in tmux’s own row shape', () => {
    expect(joinScrollbackAndFrame('old 1\nold 2\n', 'frame 1\nframe 2\n')).toBe(
      'old 1\nold 2\x1b[0m\nframe 1\nframe 2\n'
    );
    expect(joinScrollbackAndFrame('old 1', 'frame 1')).toBe('old 1\x1b[0m\nframe 1');
  });

  it('resets SGR at the seam, so the last history row cannot bleed into the frame', () => {
    // A remote history row that ends with a background still set (a diff row).
    expect(joinScrollbackAndFrame('\x1b[41mRED ROW\n', 'plain\n')).toBe('\x1b[41mRED ROW\x1b[0m\nplain\n');
  });

  it('no scrollback leaves the frame alone', () => {
    expect(joinScrollbackAndFrame(undefined, 'frame\n')).toBe('frame\n');
    expect(joinScrollbackAndFrame('', 'frame\n')).toBe('frame\n');
  });
});

describe('fetchRemoteScrollback', () => {
  const OK = '\x002\n\x00older row\nnewer row\n';
  const READ = 'older row\nnewer row\n';
  /** An exec-shaped rejection: `code` is the exit status, `killed` a timeout kill. */
  const execError = (fields: { code?: number | string; killed?: boolean }) =>
    Object.assign(new Error('Command failed'), fields);

  beforeEach(() => {
    resetRemoteScrollbackBackoff();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never opens a connection under test without an injected runner', async () => {
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024)).toBeNull();
  });

  it('returns the remote rows, running the built command with the round-trip bounds', async () => {
    const run = vi.fn(async () => OK);
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, run)).toEqual(READ);
    expect(run).toHaveBeenCalledWith(buildRemoteScrollbackCommand(remote, SESSION_ID, 100, 1024), {
      timeout: 5000,
      maxBuffer: 1024 + 64 * 1024,
    });
  });

  it('backs the HOST off after a transport failure: ssh exit 255, a timeout, a spawn error, odd output', async () => {
    const failures: Array<() => Promise<string>> = [
      async () => Promise.reject(execError({ code: 255 })),
      async () => Promise.reject(execError({ killed: true, code: null as unknown as number })),
      async () => Promise.reject(execError({ code: 'ENOENT' })),
      async () => 'not the script output',
    ];
    for (const failure of failures) {
      resetRemoteScrollbackBackoff();
      expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, vi.fn(failure))).toBeNull();
      // Another session on the same host is skipped without a round trip.
      const next = vi.fn(async () => OK);
      expect(await fetchRemoteScrollback(remote, 'other-session', 100, 1024, next)).toBeNull();
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('a remote command failure (tmux exit 1: the session is gone) is that session only, no back-off', async () => {
    const gone = vi.fn(async () => Promise.reject(execError({ code: 1 })));
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, gone)).toBeNull();
    const next = vi.fn(async () => OK);
    expect(await fetchRemoteScrollback(remote, 'other-session', 100, 1024, next)).toEqual(READ);
    expect(next).toHaveBeenCalledOnce();
  });

  // Found live against a real host: the `| tail -c` pipe takes tail's exit
  // status, so a missing session comes back as exit 0 with both markers and
  // nothing between them. The script ran on the host; only this session is
  // gone, so the host must not be backed off.
  it('a missing session hidden behind the tail pipe (exit 0, empty markers) is that session only', async () => {
    const masked = vi.fn(async () => '\x00\x00');
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, masked)).toBeNull();
    const next = vi.fn(async () => OK);
    expect(await fetchRemoteScrollback(remote, 'other-session', 100, 1024, next)).toEqual(READ);
    expect(next).toHaveBeenCalledOnce();
  });

  it('the back-off ends after 30 s', async () => {
    vi.useFakeTimers();
    await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, async () => Promise.reject(execError({ code: 255 })));
    const next = vi.fn(async () => OK);
    vi.advanceTimersByTime(29_999);
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, next)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, next)).toEqual(READ);
  });

  it('gives up after 1.5 s queued behind a busy ssh pool: never runs, no slot leaked, no back-off', async () => {
    vi.useFakeTimers();
    const gates = Array.from({ length: getRemoteSshLimit() }, () => {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      return { promise, release };
    });
    const holders = gates.map((gate) => runWithRemoteSshLimit(() => gate.promise));
    await Promise.resolve();

    const run = vi.fn(async () => OK);
    const pending = fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, run);
    await vi.advanceTimersByTimeAsync(1499);
    expect(getQueuedRemoteSshCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(getQueuedRemoteSshCount()).toBe(0);

    for (const gate of gates) gate.release();
    await Promise.all(holders);
    expect(getActiveRemoteSshCount()).toBe(0);
    // A busy pool said nothing about the host.
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, run)).toEqual(READ);
  });
});
