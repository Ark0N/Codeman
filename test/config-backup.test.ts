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
  symlinkSync,
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
  diffConfigBackups,
  listConfigBackups,
  normalizeBackupDir,
  pruneConfigBackups,
  readConfigBackupSettings,
  resolveConfigBackupDir,
  restoreConfigBackup,
  configBackupOrigin,
  sweepConfigBackupTemps,
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
    expect(readConfigBackupSettings({ configBackupKeepCount: 0 }).keepCount).toBe(2);
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

  it('does not count a self-refreshed discovery timestamp as a change', () => {
    const hosts = (stamp: string, model = 'm1') =>
      JSON.stringify({ hosts: [{ id: 'h', models: [{ id: model }], lastDiscoveredAt: stamp }] });
    put('custom-model-hosts.json', hosts('2026-10-12T08:44:22.026Z'));
    const first = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 });

    // The 5-minute discovery poll rewrites only the timestamp: still the same state.
    put('custom-model-hosts.json', hosts('2026-10-12T08:49:22.025Z'));
    const again = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 1000 });
    expect(again).toEqual({ status: 'unchanged', id: (first as { id: string }).id });
    expect(listConfigBackups(backups)).toHaveLength(1);

    // A real edit next to a refreshed timestamp is still a change, stored exactly as written.
    const edited = hosts('2026-10-12T08:54:22.025Z', 'm2');
    put('custom-model-hosts.json', edited);
    const third = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 2000 });
    expect(third.status).toBe('created');
    expect(readFileSync(join(backups, (third as { id: string }).id, 'custom-model-hosts.json'), 'utf8')).toBe(edited);
  });

  it.each([
    [
      'webviews.json',
      (n: number) =>
        JSON.stringify([
          {
            id: 'w1',
            name: 'Grafana',
            url: 'http://localhost:3001',
            embedMode: 'proxy',
            trusted: false,
            createdAt: 1,
            lastOpenedAt: n,
          },
        ]),
      'name',
    ],
    [
      'docker-cases.json',
      (n: number) => JSON.stringify([{ name: 'app', hostId: 'h', lastClaudeSessionId: `c${n}` }]),
      'hostId',
    ],
    ['users.json', (n: number) => JSON.stringify({ users: [{ name: 'a', role: 'admin', lastLoginAt: n }] }), 'role'],
    ['settings.json', (n: number) => JSON.stringify({ displayName: 'x', lastUsedCase: `case-${n}` }), 'displayName'],
    [
      'intents.json',
      (n: number) => JSON.stringify({ profiles: [{ key: 'k', goals: 'g', updatedAt: n, recentPrompts: [`p${n}`] }] }),
      'goals',
    ],
  ])('does not count activity in %s as a change, but does count an edit next to it', (name, make, editKey) => {
    put(name, make(1));
    const first = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 });
    put(name, make(2));
    expect(createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 1000 })).toEqual({
      status: 'unchanged',
      id: (first as { id: string }).id,
    });
    put(name, make(3).replace(new RegExp(`"${editKey}":"[^"]*"`), `"${editKey}":"edited"`));
    expect(createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 2000 }).status).toBe(
      'created'
    );
  });

  it('compares a tracked file that is not valid JSON by its bytes', () => {
    put('custom-model-hosts.json', 'not json lastDiscoveredAt 1');
    createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 });
    put('custom-model-hosts.json', 'not json lastDiscoveredAt 2');
    expect(createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 1000 }).status).toBe(
      'created'
    );
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
    // Newest first: T0+4d, +3d, +2d, +1d, T0. A snapshot ages from its successor: T0+1d was live
    // until T0+2d, which sits exactly on the cutoff (kept); only T0 is over the count.
    expect(removed.length).toBe(1);
    expect(listConfigBackups(backups).map((b) => b.createdAt)).toEqual([
      T0 + 4 * DAY,
      T0 + 3 * DAY,
      T0 + 2 * DAY,
      T0 + DAY,
    ]);
  });

  it('keeps the last good copy when the first change comes after a quiet month', () => {
    put('settings.json', '{"theme":"good"}');
    createConfigBackup({ dataDir: data, backupDir: backups, reason: 'startup', now: T0 });
    put('settings.json', '{}'); // the bad write, 40 days later
    createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 40 * DAY });
    pruneConfigBackups(backups, { keepCount: 20, keepDays: 30, now: T0 + 40 * DAY });
    expect(listConfigBackups(backups).map((b) => b.createdAt)).toEqual([T0 + 40 * DAY, T0]);
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

describe('diffConfigBackups', () => {
  const snap = (now: number) => {
    const r = createConfigBackup({ dataDir: data, backupDir: backups, reason: 't', force: true, now });
    if (r.status !== 'created') throw new Error('expected a snapshot');
    return r.id;
  };
  const diff = (from: string, to: string) => diffConfigBackups({ dataDir: data, backupDir: backups, from, to });
  const file = (d: ReturnType<typeof diff>, name: string) => d.files.find((f) => f.name === name)!;

  it('lists key-level changes between two backups', () => {
    put('settings.json', JSON.stringify({ displayName: 'a', theme: { mode: 'dark' }, tags: ['x'] }));
    const a = snap(T0);
    put('settings.json', JSON.stringify({ displayName: 'b', theme: { mode: 'dark' }, tags: ['x', 'y'], extra: 1 }));
    const b = snap(T0 + 1000);
    const f = file(diff(a, b), 'settings.json');
    expect(f.status).toBe('changed');
    expect(f.changes).toEqual([
      { path: 'displayName', kind: 'changed', before: '"a"', after: '"b"' },
      { path: 'extra', kind: 'added', after: '1' },
      { path: 'tags[1]', kind: 'added', after: '"y"' },
    ]);
  });

  it('compares a backup with the running config, and reports files that appeared or vanished', () => {
    put('settings.json', '{"a":1}');
    put('webhook.json', '{"url":"u"}');
    const a = snap(T0);
    put('settings.json', '{"a":2}');
    rmSync(join(data, 'webhook.json'));
    put('intents.json', '{"i":true}');
    const d = diff(a, 'current');
    expect(d.changed).toBe(3);
    expect(file(d, 'settings.json').changes).toEqual([{ path: 'a', kind: 'changed', before: '1', after: '2' }]);
    expect(file(d, 'webhook.json').status).toBe('removed');
    expect(file(d, 'intents.json').status).toBe('added');
    expect(diff(a, a).changed).toBe(0);
  });

  it('never returns a webhook URL, captured prompts, or URL userinfo and query', () => {
    put('webhook.json', JSON.stringify({ url: 'https://hooks.slack.com/services/T0/B0/oldsecret' }));
    put('intents.json', JSON.stringify({ profiles: [{ key: 'k', prompts: ['my password is pw1'] }] }));
    put('settings.json', JSON.stringify({ baseUrl: 'https://user:pw@host/p?token=t1#f' }));
    const a = snap(T0);
    put('webhook.json', JSON.stringify({ url: 'https://hooks.slack.com/services/T0/B0/newsecret' }));
    put('intents.json', JSON.stringify({ profiles: [{ key: 'k', prompts: ['my password is pw2'] }] }));
    put('settings.json', JSON.stringify({ baseUrl: 'https://user:pw@host/p?token=t2#f' }));
    const d = diff(a, 'current');
    const json = JSON.stringify(d);
    for (const s of ['secret', 'pw1', 'pw2', 'user:pw', 'token=', 'hooks.slack']) expect(json).not.toContain(s);
    expect(file(d, 'webhook.json').changes.every((c) => c.redacted)).toBe(true);
    expect(file(d, 'intents.json').changes.every((c) => c.redacted)).toBe(true);
  });

  it('never returns a credential value, only that it differs', () => {
    put('.env', 'SECRET_ONE=hunter2\nOTHER=abc\n');
    put('users.json', JSON.stringify({ admin: { name: 'root' } }));
    put('custom-model-hosts.json', JSON.stringify([{ name: 'h', apiKey: 'sk-old', url: 'http://x' }]));
    const a = snap(T0);
    put('.env', 'SECRET_ONE=hunter3\nOTHER=abd\n');
    put('users.json', JSON.stringify({ admin: { name: 'rooted' } }));
    put('custom-model-hosts.json', JSON.stringify([{ name: 'h', apiKey: 'sk-new', url: 'http://y' }]));
    const d = diff(a, 'current');
    const json = JSON.stringify(d);
    for (const secret of ['hunter', 'abc', 'abd', 'root', 'sk-old', 'sk-new']) expect(json).not.toContain(secret);
    expect(file(d, '.env').changes.every((c) => c.redacted)).toBe(true);
    expect(file(d, 'custom-model-hosts.json').changes).toEqual([
      { path: '[0].apiKey', kind: 'changed', redacted: true },
      { path: '[0].url', kind: 'changed', before: '"http://x"', after: '"http://y"' },
    ]);
  });

  it('does not count a self-refreshed discovery timestamp as a difference', () => {
    put('custom-model-hosts.json', JSON.stringify([{ name: 'h', lastDiscoveredAt: 1 }]));
    const a = snap(T0);
    put('custom-model-hosts.json', JSON.stringify([{ name: 'h', lastDiscoveredAt: 2 }]));
    const d = diff(a, 'current');
    expect(file(d, 'custom-model-hosts.json').status).toBe('unchanged');
    expect(d.changed).toBe(0);
  });

  it('reports a file that is not JSON as differing, without its content', () => {
    put('settings.json', 'not json at all');
    const a = snap(T0);
    put('settings.json', 'still not json');
    const f = file(diff(a, 'current'), 'settings.json');
    expect(f).toMatchObject({ status: 'changed', detail: 'bytes', changes: [] });
  });

  it('caps the changes listed per file', () => {
    put('settings.json', '{}');
    const a = snap(T0);
    put('settings.json', JSON.stringify(Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, i]))));
    const f = file(diff(a, 'current'), 'settings.json');
    expect(f.changes).toHaveLength(200);
    expect(f.truncated).toBe(true);
  });

  it('refuses unknown ids, path traversal and a tampered snapshot', () => {
    put('settings.json', '{"a":1}');
    const a = snap(T0);
    expect(() => diff('cfg-20200101-000000', 'current')).toThrow(ConfigBackupNotFoundError);
    expect(() => diff('../etc', 'current')).toThrow(ConfigBackupNotFoundError);
    writeFileSync(join(backups, a, 'settings.json'), '{"a":99}');
    expect(() => diff(a, 'current')).toThrow(ConfigBackupCorruptError);
  });
});

describe('instances sharing one backup folder', () => {
  it('keeps to its own snapshots: no churn, no prune, no restore of the other', () => {
    const other = join(root, 'other-data');
    mkdirSync(other, { recursive: true });
    put('settings.json', '{"a":1}');
    writeFileSync(join(other, 'settings.json'), '{"b":2}');
    const mine = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 });
    const theirs = createConfigBackup({ dataDir: other, backupDir: backups, reason: 'auto', now: T0 + 1000 });
    expect(theirs.status).toBe('created');
    // Each side's change check compares with its own newest snapshot, so a second tick is a no-op.
    expect(createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 + 2000 }).status).toBe(
      'unchanged'
    );
    expect(createConfigBackup({ dataDir: other, backupDir: backups, reason: 'auto', now: T0 + 3000 }).status).toBe(
      'unchanged'
    );
    expect(listConfigBackups(backups, configBackupOrigin(data))).toHaveLength(1);
    expect(
      pruneConfigBackups(backups, { keepCount: 1, keepDays: 1, now: T0 + 999 * DAY, origin: configBackupOrigin(data) })
    ).toEqual([]);
    expect(listConfigBackups(backups)).toHaveLength(2);
    const theirId = (theirs as { id: string }).id;
    expect(() => restoreConfigBackup({ dataDir: data, backupDir: backups, id: theirId })).toThrow(
      ConfigBackupNotFoundError
    );
    expect((mine as { id: string }).id).not.toBe(theirId);
  });

  it('a restore reports tracked files it left alone, and sweeps only old temp folders', () => {
    put('settings.json', '{"a":1}');
    const made = createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 }) as { id: string };
    put('webhook.json', '{"url":"u"}');
    expect(restoreConfigBackup({ dataDir: data, backupDir: backups, id: made.id }).untouched).toEqual(['webhook.json']);
    const stale = join(backups, '.tmp-cfg-20200101-000000-99999');
    mkdirSync(stale);
    sweepConfigBackupTemps(backups, Date.now() + 2 * 3_600_000);
    expect(existsSync(stale)).toBe(false);
  });
});

describe('restore trusts only what this module wrote', () => {
  const made = () =>
    createConfigBackup({ dataDir: data, backupDir: backups, reason: 'auto', now: T0 }) as { id: string };

  it('refuses a symlinked snapshot file and a snapshot file with group or world bits', () => {
    put('settings.json', '{"a":1}');
    put('clis.json', '{"clis":{}}');
    const { id } = made();
    const file = join(backups, id, 'clis.json');
    chmodSync(file, 0o644);
    expect(() => restoreConfigBackup({ dataDir: data, backupDir: backups, id })).toThrow(ConfigBackupCorruptError);

    chmodSync(file, 0o600);
    const real = join(root, 'elsewhere.json');
    writeFileSync(real, '{"clis":{}}');
    rmSync(file);
    symlinkSync(real, file);
    expect(() => restoreConfigBackup({ dataDir: data, backupDir: backups, id })).toThrow(/symlink/);
    // nothing was written and no pre-restore copy was taken for a refused restore
    expect(listConfigBackups(backups)).toHaveLength(1);
  });

  it('refuses a snapshot folder that others can write to', () => {
    put('settings.json', '{"a":1}');
    const { id } = made();
    chmodSync(join(backups, id), 0o777);
    expect(() => restoreConfigBackup({ dataDir: data, backupDir: backups, id })).toThrow(ConfigBackupCorruptError);
    chmodSync(join(backups, id), 0o700);
    expect(() => restoreConfigBackup({ dataDir: data, backupDir: backups, id })).not.toThrow();
  });

  it('keeps the current folder and retention when settings.json is restored', () => {
    put('settings.json', JSON.stringify({ displayName: 'old', configBackupDir: '/old', configBackupKeepCount: 5 }));
    const { id } = made();
    put('settings.json', JSON.stringify({ displayName: 'new', configBackupDir: '/new', configBackupKeepDays: 7 }));
    restoreConfigBackup({ dataDir: data, backupDir: backups, id });
    const after = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'));
    expect(after).toEqual({ displayName: 'old', configBackupDir: '/new', configBackupKeepDays: 7 });
  });
});
