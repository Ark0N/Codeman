/**
 * @fileoverview Config backups (src/config-backup.ts): what is tracked, when a snapshot is made,
 * how retention prunes, and that restore verifies before it writes. Pure fs over temp dirs;
 * port: N/A.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_BACKUP_FILES,
  ConfigBackupCorruptError,
  ConfigBackupNotFoundError,
  createConfigBackup,
  defaultConfigBackupDir,
  listConfigBackups,
  normalizeBackupDir,
  pruneConfigBackups,
  readConfigBackupSettings,
  resolveConfigBackupDir,
  restoreConfigBackup,
} from '../src/config-backup.js';

let root: string;
let data: string;
let backups: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cfg-backup-'));
  data = join(root, 'data');
  backups = join(root, 'backups');
  mkdirSync(data);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (name: string, text: string) => writeFileSync(join(data, name), text);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

describe('settings', () => {
  it('defaults to ON, 20 copies, 30 days, default folder', () => {
    expect(readConfigBackupSettings({})).toEqual({ enabled: true, dir: null, keepCount: 20, keepDays: 30 });
    expect(readConfigBackupSettings(null).enabled).toBe(true);
  });

  it('only an explicit false turns it off, and numbers are clamped to their ranges', () => {
    expect(readConfigBackupSettings({ configBackupEnabled: false }).enabled).toBe(false);
    const s = readConfigBackupSettings({ configBackupKeepCount: 9999, configBackupKeepDays: -3 });
    expect(s.keepCount).toBe(500);
    expect(s.keepDays).toBe(0);
    expect(readConfigBackupSettings({ configBackupKeepCount: 0 }).keepCount).toBe(1);
    expect(readConfigBackupSettings({ configBackupKeepCount: 'abc' }).keepCount).toBe(20);
    expect(readConfigBackupSettings({ configBackupKeepCount: 7.9 }).keepCount).toBe(7);
  });

  it('expands ~ and refuses anything that is not an absolute path', () => {
    expect(normalizeBackupDir('~/cfg', '/home/u')).toBe('/home/u/cfg');
    expect(normalizeBackupDir('/mnt/backups/codeman', '/home/u')).toBe('/mnt/backups/codeman');
    for (const bad of ['', '   ', 'relative/dir', './here', undefined, 42, '/x\0y']) {
      expect(normalizeBackupDir(bad as never, '/home/u'), String(bad)).toBeNull();
    }
  });

  it('uses <data dir>/backups/config by default and never the data dir itself', () => {
    expect(resolveConfigBackupDir(readConfigBackupSettings({}), '/d')).toBe(defaultConfigBackupDir('/d'));
    expect(resolveConfigBackupDir(readConfigBackupSettings({ configBackupDir: '/elsewhere' }), '/d')).toBe(
      '/elsewhere'
    );
    expect(resolveConfigBackupDir(readConfigBackupSettings({ configBackupDir: '/d' }), '/d')).toBe(
      defaultConfigBackupDir('/d')
    );
  });
});

describe('createConfigBackup', () => {
  it('snapshots only the tracked files that exist, with a manifest', () => {
    put('settings.json', '{"a":1}');
    put('clis.json', '{"clis":{}}');
    put('state.json', '{"runtime":true}'); // not config: must not be copied
    put('hook-secret', 'x'); // regenerated: must not be copied
    const r = createConfigBackup({
      dataDir: data,
      backupDir: backups,
      reason: 'startup',
      appVersion: '1.2.3',
      now: T0,
    });
    expect(r.status).toBe('created');
    const [b] = listConfigBackups(backups);
    expect(b.files.map((f) => f.name).sort()).toEqual(['clis.json', 'settings.json']);
    expect(b.reason).toBe('startup');
    expect(b.appVersion).toBe('1.2.3');
    expect(b.createdAt).toBe(T0);
    expect(existsSync(join(backups, b.id, 'state.json'))).toBe(false);
    expect(readFileSync(join(backups, b.id, 'settings.json'), 'utf8')).toBe('{"a":1}');
  });

  it('tracks a fixed allowlist', () => {
    expect([...CONFIG_BACKUP_FILES]).toContain('settings.json');
    expect([...CONFIG_BACKUP_FILES]).not.toContain('state.json');
    expect([...CONFIG_BACKUP_FILES]).not.toContain('hook-secret');
  });

  it('makes no second snapshot while nothing changed, and one when something does', () => {
    put('settings.json', '{"a":1}');
    const first = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 });
    const again = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 1000 });
    expect(again).toEqual({ status: 'unchanged', id: (first as { id: string }).id });
    expect(listConfigBackups(backups)).toHaveLength(1);

    put('settings.json', '{"a":2}');
    expect(createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 2000 }).status).toBe(
      'created'
    );
    expect(listConfigBackups(backups)).toHaveLength(2);
  });

  it('force makes a snapshot even when unchanged, and two in one second get distinct ids', () => {
    put('settings.json', '{}');
    createConfigBackup({ dataDir: data, backupDir: backups, reason: 'a', now: T0 });
    const forced = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'manual', force: true, now: T0 });
    expect(forced.status).toBe('created');
    const ids = listConfigBackups(backups).map((b) => b.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('reports empty, creating nothing, when no tracked file exists', () => {
    expect(createConfigBackup({ dataDir: data, backupDir: backups, reason: 'x' })).toEqual({ status: 'empty' });
    expect(existsSync(backups)).toBe(false);
  });

  it('keeps snapshots private: 0700 folder and 0600 files', () => {
    put('settings.json', '{}');
    put('.env', 'CODEMAN_PASSWORD=secret');
    const r = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'x', now: T0 });
    const id = (r as { id: string }).id;
    expect(statSync(join(backups, id)).mode & 0o777).toBe(0o700);
    expect(statSync(join(backups, id, '.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(backups, id, 'manifest.json')).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp folder behind', () => {
    put('settings.json', '{}');
    createConfigBackup({ dataDir: data, backupDir: backups, reason: 'x', now: T0 });
    const stray = readdirSync(backups).filter((n) => n.startsWith('.tmp-'));
    expect(stray).toEqual([]);
  });
});

describe('retention', () => {
  const makeN = (n: number) => {
    for (let i = 0; i < n; i++) {
      put('settings.json', JSON.stringify({ i }));
      createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + i * DAY });
    }
  };

  it('keeps the newest keepCount', () => {
    makeN(6);
    const removed = pruneConfigBackups(backups, { keepCount: 3, keepDays: 0, now: T0 + 6 * DAY });
    expect(removed).toHaveLength(3);
    const left = listConfigBackups(backups);
    expect(left).toHaveLength(3);
    expect(left.map((b) => b.createdAt)).toEqual([T0 + 5 * DAY, T0 + 4 * DAY, T0 + 3 * DAY]);
  });

  it('drops anything older than keepDays, but never the newest', () => {
    makeN(4); // T0 .. T0+3d
    // At T0+100d everything is older than 30 days: the newest still survives.
    const removed = pruneConfigBackups(backups, { keepCount: 50, keepDays: 30, now: T0 + 100 * DAY });
    expect(removed).toHaveLength(3);
    expect(listConfigBackups(backups).map((b) => b.createdAt)).toEqual([T0 + 3 * DAY]);
  });

  it('applies both limits together and keepDays 0 means no age limit', () => {
    makeN(5);
    expect(pruneConfigBackups(backups, { keepCount: 50, keepDays: 0, now: T0 + 999 * DAY })).toEqual([]);
    const removed = pruneConfigBackups(backups, { keepCount: 4, keepDays: 3, now: T0 + 5 * DAY });
    // Newest first: T0+4d, +3d, +2d, +1d, T0. The oldest is over the count AND past the cutoff
    // (T0+2d); T0+1d is past the cutoff; T0+2d sits exactly on it and is kept.
    expect(removed.length).toBe(2);
    expect(listConfigBackups(backups).map((b) => b.createdAt)).toEqual([T0 + 4 * DAY, T0 + 3 * DAY, T0 + 2 * DAY]);
  });

  it('never deletes a folder it did not make', () => {
    makeN(3);
    mkdirSync(join(backups, 'photos'));
    writeFileSync(join(backups, 'photos', 'a.jpg'), 'x');
    mkdirSync(join(backups, 'cfg-20200101-000000')); // right name, no manifest: not ours
    writeFileSync(join(backups, 'notes.txt'), 'keep');
    pruneConfigBackups(backups, { keepCount: 1, keepDays: 1, now: T0 + 500 * DAY });
    expect(existsSync(join(backups, 'photos', 'a.jpg'))).toBe(true);
    expect(existsSync(join(backups, 'cfg-20200101-000000'))).toBe(true);
    expect(existsSync(join(backups, 'notes.txt'))).toBe(true);
    expect(listConfigBackups(backups)).toHaveLength(1);
  });

  it('does nothing for a folder that does not exist', () => {
    expect(pruneConfigBackups(join(root, 'nope'), { keepCount: 1, keepDays: 1 })).toEqual([]);
  });
});

describe('restoreConfigBackup', () => {
  it('puts the files back, atomically, after taking a pre-restore snapshot', () => {
    put('settings.json', '{"good":true}');
    put('clis.json', '{"clis":{"grok":{"enabled":true}}}');
    const made = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 }) as { id: string };

    put('settings.json', '{"polluted":true}');
    rmSync(join(data, 'clis.json'));

    const r = restoreConfigBackup({ dataDir: data, backupDir: backups, id: made.id, now: T0 + 1000 });
    expect(r.restored.sort()).toEqual(['clis.json', 'settings.json']);
    expect(readFileSync(join(data, 'settings.json'), 'utf8')).toBe('{"good":true}');
    expect(readFileSync(join(data, 'clis.json'), 'utf8')).toBe('{"clis":{"grok":{"enabled":true}}}');
    expect(statSync(join(data, 'settings.json')).mode & 0o777).toBe(0o600);

    // The state it replaced is recoverable.
    expect(r.safetySnapshot).toBeTruthy();
    const safety = listConfigBackups(backups).find((b) => b.id === r.safetySnapshot)!;
    expect(safety.reason).toBe('pre-restore');
    expect(readFileSync(join(backups, safety.id, 'settings.json'), 'utf8')).toBe('{"polluted":true}');
  });

  it('refuses a snapshot whose file no longer matches its checksum, changing nothing', () => {
    put('settings.json', '{"good":true}');
    const made = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 }) as { id: string };
    chmodSync(join(backups, made.id, 'settings.json'), 0o600);
    writeFileSync(join(backups, made.id, 'settings.json'), '{"tampered":true}');
    put('settings.json', '{"live":true}');
    expect(() => restoreConfigBackup({ dataDir: data, backupDir: backups, id: made.id })).toThrow(
      ConfigBackupCorruptError
    );
    expect(readFileSync(join(data, 'settings.json'), 'utf8')).toBe('{"live":true}');
    expect(listConfigBackups(backups)).toHaveLength(1); // no pre-restore snapshot for a refused restore
  });

  it('rejects unknown ids and anything that is not a snapshot name (no path traversal)', () => {
    put('settings.json', '{}');
    createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 });
    for (const id of ['cfg-19990101-000000', '../data', '..', 'photos', 'cfg-20261001-120000/../../x']) {
      expect(() => restoreConfigBackup({ dataDir: data, backupDir: backups, id }), id).toThrow(
        ConfigBackupNotFoundError
      );
    }
  });

  it('only ever writes allowlisted names, even if a manifest lists others', () => {
    put('settings.json', '{"a":1}');
    const made = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 }) as { id: string };
    const mpath = join(backups, made.id, 'manifest.json');
    const m = JSON.parse(readFileSync(mpath, 'utf8'));
    m.files.push({ name: '../escape.json', bytes: 1, sha256: 'x' }, { name: 'state.json', bytes: 1, sha256: 'x' });
    writeFileSync(mpath, JSON.stringify(m));
    restoreConfigBackup({ dataDir: data, backupDir: backups, id: made.id });
    expect(existsSync(join(root, 'escape.json'))).toBe(false);
    expect(existsSync(join(data, 'state.json'))).toBe(false);
  });
});
