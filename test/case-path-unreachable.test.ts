/**
 * @fileoverview "Create in a custom folder" (#535) on a parent folder that does not
 * answer (#516): `prepareNewCasePath` must ask the bounded path probe first, and give
 * up with UNREACHABLE within the probe timeout instead of reaching the realpath / stat /
 * lstat / readdir calls that would wait on a hard mount forever.
 *
 * Only the chosen dead paths hang; everything else is the real filesystem.
 * Port: none.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = vi.hoisted(() => {
  // Short probe timeout so a stall costs ~100 ms, read at import.
  process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS = '100';
  return { dead: '/mnt/dead-nas-case-parent', releases: [] as Array<() => void>, touched: [] as string[] };
});

/** A call on the dead path never settles (a hard mount), until afterEach releases it. */
function hangOnDead<F extends (...a: never[]) => unknown>(name: string, real: F): F {
  return ((path: string, ...rest: unknown[]) => {
    if (String(path) === probe.dead || String(path).startsWith(probe.dead + '/')) {
      probe.touched.push(`${name} ${String(path)}`);
      return new Promise((_resolve, reject) => {
        probe.releases.push(() => reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      });
    }
    return (real as unknown as (...a: unknown[]) => unknown)(path, ...rest);
  }) as unknown as F;
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const stat = hangOnDead('stat', actual.stat);
  return { ...actual, stat, default: { ...actual, stat } };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const promises = {
    ...actual.promises,
    realpath: hangOnDead('realpath', actual.promises.realpath),
    stat: hangOnDead('stat', actual.promises.stat),
    lstat: hangOnDead('lstat', actual.promises.lstat),
    readdir: hangOnDead('readdir', actual.promises.readdir),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

import { prepareNewCasePath } from '../src/web/case-path.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'case-path-unreachable-')));
const ctx = { home: join(root, 'home'), dataDir: join(root, 'home', '.codeman'), casesDirs: [join(root, 'cases')] };

afterEach(async () => {
  probe.releases.splice(0).forEach((release) => release());
  probe.touched.length = 0;
  await new Promise((r) => setTimeout(r, 0));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS;
});

describe('prepareNewCasePath on a parent folder that does not answer', () => {
  it('answers UNREACHABLE within the probe timeout and never touches the path unbounded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await Promise.race([
      prepareNewCasePath(`${probe.dead}/new-case`, ctx),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    warn.mockRestore();

    expect(result).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect((result as { reason: string }).reason).toBe(
      `The parent folder is not responding or not readable: ${probe.dead}`
    );
    // Only the bounded probe's own stat reached the dead mount.
    expect(probe.touched).toEqual([`stat ${probe.dead}`]);
  });

  it('still reports a parent that definitely does not exist as NOT_FOUND', async () => {
    expect(await prepareNewCasePath(join(root, 'no-such-parent', 'new-case'), ctx)).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
  });
});
