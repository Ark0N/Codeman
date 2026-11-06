/**
 * @fileoverview A backup pass reads the backup folder once: one directory listing and one read per
 * manifest, shared by the recorded-retention fallback, the change check and the prune. Each used to
 * list the folder itself, which on a network folder meant every manifest read three times every five
 * minutes (found in review of #661).
 *
 * ⚠️ test/setup.ts gives the whole FILE one temp HOME. Port: N/A (no server).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const rec = vi.hoisted(() => ({ dir: '', calls: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const record = <F extends (...a: never[]) => unknown>(name: string, real: F): F =>
    ((path: unknown, ...rest: unknown[]) => {
      if (rec.dir && String(path).startsWith(rec.dir)) rec.calls.push(`${name} ${String(path)}`);
      return (real as unknown as (...a: unknown[]) => unknown)(path, ...rest);
    }) as unknown as F;
  const wrapped = {
    ...actual,
    readdirSync: record('readdirSync', actual.readdirSync),
    readFileSync: record('readFileSync', actual.readFileSync),
  };
  return { ...wrapped, default: wrapped };
});

import { runConfigBackup } from '../../src/web/routes/config-backup-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { getDataDir } from '../../src/config/instance.js';
import { createConfigBackup, defaultConfigBackupDir, listConfigBackups } from '../../src/config-backup.js';

const dir = () => defaultConfigBackupDir(getDataDir());
const DAY = 86_400_000;
const BASE = Date.UTC(2025, 0, 1);

beforeEach(() => {
  rec.dir = '';
  rec.calls.length = 0;
  rmSync(dir(), { recursive: true, force: true });
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
});
afterEach(() => {
  rec.dir = '';
  rmSync(dir(), { recursive: true, force: true });
  rmSync(SETTINGS_PATH, { force: true });
});

describe('one backup pass', () => {
  it('lists the folder once and reads each manifest once', async () => {
    // Only the OLDEST snapshot recorded a retention, so the fallback has to look through every one.
    for (let i = 0; i < 6; i++) {
      writeFileSync(SETTINGS_PATH, JSON.stringify({ displayName: `v${i}` }));
      createConfigBackup({
        dataDir: getDataDir(),
        backupDir: dir(),
        reason: 'auto',
        now: BASE + i * DAY,
        ...(i === 0 && { keepCount: 100, keepDays: 0 }),
      });
    }
    // A change (so the pass writes a snapshot and then prunes) and no retention keys (the fallback reads).
    writeFileSync(SETTINGS_PATH, JSON.stringify({ displayName: 'changed' }));
    rec.dir = dir();
    const out = await runConfigBackup('auto');
    rec.dir = '';

    expect(out?.result.status).toBe('created');
    expect(out?.removed).toEqual([]); // the recorded 100 / no age limit, not the defaults
    expect(rec.calls.filter((c) => c.startsWith('readdirSync'))).toHaveLength(1);
    const manifestReads = rec.calls.filter((c) => c.startsWith('readFileSync') && c.endsWith('manifest.json'));
    expect(manifestReads).toHaveLength(6);
    expect(new Set(manifestReads).size).toBe(6);
    expect(listConfigBackups(dir())).toHaveLength(7);
  });

  it('counts the snapshot it just made when it prunes', async () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ configBackupKeepCount: 2, configBackupKeepDays: 0, v: 0 }));
    for (let i = 0; i < 3; i++) {
      writeFileSync(SETTINGS_PATH, JSON.stringify({ configBackupKeepCount: 2, configBackupKeepDays: 0, v: i }));
      createConfigBackup({ dataDir: getDataDir(), backupDir: dir(), reason: 'auto', now: BASE + i * DAY });
    }
    const before = listConfigBackups(dir()).map((b) => b.id);
    writeFileSync(SETTINGS_PATH, JSON.stringify({ configBackupKeepCount: 2, configBackupKeepDays: 0, v: 9 }));
    const out = await runConfigBackup('auto');
    expect(out?.result.status).toBe('created');
    const kept = listConfigBackups(dir()).map((b) => b.id);
    // keep 2: the new one and the newest before it; the two older ones go
    expect(kept).toEqual([(out?.result as { id: string }).id, before[0]]);
    expect(out?.removed.sort()).toEqual([before[1], before[2]].sort());
  });
});
