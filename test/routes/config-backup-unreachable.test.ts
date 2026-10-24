/**
 * @fileoverview A custom backup folder that stops answering (a network mount) must never be listed or
 * read before the bounded probe says it is there: GET, Back up now, diff and restore answer 503 without
 * touching it.
 * With only `configBackupDir` in settings.json the recorded-retention fallback would otherwise
 * `readdirSync` the folder first (found in review of #661).
 *
 * ⚠️ test/setup.ts gives the whole FILE one temp HOME. Port: N/A (inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const dead = vi.hoisted(() => ({ dir: '', touched: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const record = <F extends (...a: never[]) => unknown>(name: string, real: F): F =>
    ((path: unknown, ...rest: unknown[]) => {
      if (dead.dir && String(path).startsWith(dead.dir)) dead.touched.push(`${name} ${String(path)}`);
      return (real as unknown as (...a: unknown[]) => unknown)(path, ...rest);
    }) as unknown as F;
  const wrapped = {
    ...actual,
    readdirSync: record('readdirSync', actual.readdirSync),
    readFileSync: record('readFileSync', actual.readFileSync),
    statSync: record('statSync', actual.statSync),
    lstatSync: record('lstatSync', actual.lstatSync),
    existsSync: record('existsSync', actual.existsSync),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('../../src/utils/bounded-path-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/bounded-path-probe.js')>();
  return {
    ...actual,
    probePathKind: async (path: string, options?: { pastCap?: boolean }) =>
      dead.dir && path.startsWith(dead.dir) ? 'unknown' : actual.probePathKind(path, options),
  };
});

import { createRouteTestHarness } from './_route-test-utils.js';
import { registerConfigBackupRoutes } from '../../src/web/routes/config-backup-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { getDataDir } from '../../src/config/instance.js';
import { configBackupOrigin } from '../../src/config-backup.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cfg-backup-dead-'));
  dead.dir = join(root, 'mount');
  dead.touched.length = 0;
  configBackupOrigin(getDataDir()); // an instance that already has an id: the fallback has something to look for
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  // Only the folder: no retention keys, the shape that makes the recorded-retention fallback want to read it.
  writeFileSync(SETTINGS_PATH, JSON.stringify({ configBackupDir: dead.dir }));
});
afterEach(() => {
  dead.dir = '';
  rmSync(root, { recursive: true, force: true });
  rmSync(SETTINGS_PATH, { force: true });
});

describe('a custom backup folder that does not answer', () => {
  it.each([
    ['GET', '/api/config-backups'],
    ['POST', '/api/config-backups'],
    ['GET', '/api/config-backups/diff?from=cfg-20261001-120000'],
    ['POST', '/api/config-backups/cfg-20261001-120000/restore'],
  ] as const)('%s %s answers 503 without reading the folder', async (method, url) => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(503);
    expect(dead.touched).toEqual([]);
  });
});
