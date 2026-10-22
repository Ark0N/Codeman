/**
 * @fileoverview /api/config-backups: list, back up now, restore. Settings are read fresh from
 * settings.json, so a folder or retention change applies on the next request.
 *
 * ⚠️ test/setup.ts gives the whole FILE one temp HOME (and so one data dir). Port: N/A (inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerConfigBackupRoutes, runConfigBackup } from '../../src/web/routes/config-backup-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { getDataDir } from '../../src/config/instance.js';
import { createConfigBackup, defaultConfigBackupDir, listConfigBackups } from '../../src/config-backup.js';
import { intentStore } from '../../src/intent-store.js';

let custom: string;
const settings = (extra: Record<string, unknown> = {}) => {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ displayName: 'before', ...extra }));
};

beforeEach(() => {
  custom = mkdtempSync(join(tmpdir(), 'cfg-backup-route-'));
  rmSync(defaultConfigBackupDir(getDataDir()), { recursive: true, force: true });
  settings();
});
afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  rmSync(custom, { recursive: true, force: true });
  rmSync(SETTINGS_PATH, { force: true });
  rmSync(defaultConfigBackupDir(getDataDir()), { recursive: true, force: true });
});

describe('/api/config-backups', () => {
  it('lists the effective settings, the default folder and the tracked files', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/config-backups' });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.settings).toEqual({ enabled: true, dir: null, keepCount: 20, keepDays: 30 });
    expect(d.dir).toBe(defaultConfigBackupDir(getDataDir()));
    expect(d.tracked).toContain('settings.json');
    expect(d.backups).toEqual([]);
  });

  it('backs up now into the default folder and lists it', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const made = await app.inject({ method: 'POST', url: '/api/config-backups' });
    expect(made.statusCode).toBe(200);
    expect(made.json().data.status).toBe('created');
    const list = (await app.inject({ method: 'GET', url: '/api/config-backups' })).json().data;
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0].reason).toBe('manual');
    expect(list.backups[0].files.map((f: { name: string }) => f.name)).toContain('settings.json');
    // Names and sizes only, never content.
    expect(JSON.stringify(list)).not.toContain('before');
  });

  it('follows a custom folder and retention from settings on the next request', async () => {
    const dir = join(custom, 'snap');
    settings({ configBackupDir: dir, configBackupKeepCount: 2, configBackupKeepDays: 0 });
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    for (let i = 0; i < 4; i++) {
      writeFileSync(SETTINGS_PATH, JSON.stringify({ configBackupDir: dir, configBackupKeepCount: 2, i }));
      await app.inject({ method: 'POST', url: '/api/config-backups' });
      await new Promise((r) => setTimeout(r, 5));
    }
    const d = (await app.inject({ method: 'GET', url: '/api/config-backups' })).json().data;
    expect(d.dir).toBe(dir);
    expect(d.backups).toHaveLength(2);
    expect(existsSync(defaultConfigBackupDir(getDataDir()))).toBe(false);
  });

  it('restores a backup, reports what needs a restart and keeps a pre-restore copy', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    writeFileSync(join(dirname(SETTINGS_PATH), 'clis.json'), '{"schemaVersion":1,"clis":{}}', { mode: 0o600 });
    const id = (await app.inject({ method: 'POST', url: '/api/config-backups' })).json().data.id;
    writeFileSync(SETTINGS_PATH, JSON.stringify({ displayName: 'polluted' }));
    writeFileSync(join(dirname(SETTINGS_PATH), 'clis.json'), '{"clis":{"evil":{}}}');

    const res = await app.inject({ method: 'POST', url: `/api/config-backups/${id}/restore` });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.restored).toEqual(expect.arrayContaining(['settings.json', 'clis.json']));
    expect(d.restartRequired).not.toContain('clis.json'); // reloaded by the restore itself
    expect(d.restartRequired).toContain('settings.json'); // its watcher toggles are not re-run by a restore
    expect(d.safetySnapshot).toBeTruthy();
    expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).displayName).toBe('before');
  });

  it('a restore that fails partway names what it restored, what failed and the pre-restore copy', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const clis = join(dirname(SETTINGS_PATH), 'clis.json');
    writeFileSync(clis, '{"schemaVersion":1,"clis":{}}', { mode: 0o600 });
    const id = (await app.inject({ method: 'POST', url: '/api/config-backups' })).json().data.id;
    writeFileSync(SETTINGS_PATH, JSON.stringify({ displayName: 'polluted' }));
    // A file the server cannot replace: settings.json (first in the list) goes back, clis.json cannot.
    rmSync(clis);
    mkdirSync(clis);
    try {
      const res = await app.inject({ method: 'POST', url: `/api/config-backups/${id}/restore` });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
      expect(body.error).toContain('clis.json');
      expect(body.data.restored).toContain('settings.json');
      expect(body.data.failed.map((f: { name: string }) => f.name)).toEqual(['clis.json']);
      expect(body.data.restartRequired).toContain('settings.json');
      expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).displayName).toBe('before');
      // The undo copy exists, holds the state the restore replaced, and is the one named.
      const safety = body.data.safetySnapshot;
      expect(safety).toBeTruthy();
      expect(body.error).toContain(safety);
      const listed = (await app.inject({ method: 'GET', url: '/api/config-backups' })).json().data.backups;
      expect(listed.find((b: { id: string }) => b.id === safety)?.reason).toBe('pre-restore');
    } finally {
      rmSync(clis, { recursive: true, force: true });
    }
  });

  it('a restored intents.json is not reverted by the next captured prompt', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const dir = mkdtempSync(join(tmpdir(), 'cfg-backup-intent-'));
    try {
      intentStore.recordPrompt(undefined, dir, 's1', 'first prompt about the build pipeline');
      const id = (await app.inject({ method: 'POST', url: '/api/config-backups' })).json().data.id;
      intentStore.recordPrompt(undefined, dir, 's1', 'second prompt about the build pipeline');
      await app.inject({ method: 'POST', url: `/api/config-backups/${id}/restore` });
      intentStore.recordPrompt(undefined, dir, 's1', 'third prompt about the build pipeline');
      expect(intentStore.getProfile(undefined, dir).recentPrompts).toHaveLength(2);
    } finally {
      intentStore.deleteProfile(undefined, dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a custom folder whose parent is missing instead of creating it', async () => {
    settings({ configBackupDir: join(custom, 'no', 'such', 'dir') });
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/config-backups' });
    expect(res.statusCode).toBe(503);
    expect(existsSync(join(custom, 'no'))).toBe(false);
  });

  it('answers 404 for an unknown backup and 404 for a traversal attempt', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    for (const id of ['cfg-19990101-000000', '..%2F..%2Fetc', 'photos']) {
      const res = await app.inject({ method: 'POST', url: `/api/config-backups/${id}/restore` });
      expect(res.statusCode, id).toBe(404);
    }
  });

  it('is admin only in multi-user mode: a non-admin is refused on every verb', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    for (const [method, url] of [
      ['GET', '/api/config-backups'],
      ['POST', '/api/config-backups'],
      ['POST', '/api/config-backups/cfg-20261001-120000/restore'],
      ['GET', '/api/config-backups/diff?from=cfg-20261001-120000'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('multi-user: a restore is written to the admin audit log', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    const id = (await app.inject({ method: 'POST', url: '/api/config-backups' })).json().data.id;
    await app.inject({ method: 'POST', url: `/api/config-backups/${id}/restore` });
    const auditPath = join(getDataDir(), 'admin-audit.jsonl');
    const written = () => existsSync(auditPath) && readFileSync(auditPath, 'utf8').includes('config_backup_restore');
    for (let i = 0; i < 40 && !written(); i++) await new Promise((r) => setTimeout(r, 25));
    const last = JSON.parse(readFileSync(auditPath, 'utf8').trim().split('\n').pop()!);
    expect(last).toMatchObject({ admin: 'root', action: 'config_backup_restore', target: id });
    expect(last.detail.restored).toContain('settings.json');
    rmSync(auditPath, { force: true });
  });

  it('multi-user: an admin is allowed', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    expect((await app.inject({ method: 'GET', url: '/api/config-backups' })).json().success).toBe(true);
  });
});

describe('GET /api/config-backups/diff', () => {
  it('compares a backup with the running config, defaulting `to` to current', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const made = (await app.inject({ method: 'POST', url: '/api/config-backups' })).json().data;
    settings({ displayName: 'after' });
    const res = await app.inject({ method: 'GET', url: `/api/config-backups/diff?from=${made.id}` });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.to).toBe('current');
    expect(d.files.find((f: { name: string }) => f.name === 'settings.json').changes).toEqual([
      { path: 'displayName', kind: 'changed', before: '"before"', after: '"after"' },
    ]);
  });

  it('400 without `from`, 404 for an unknown backup', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    expect((await app.inject({ method: 'GET', url: '/api/config-backups/diff' })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/api/config-backups/diff?from=cfg-20200101-000000' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('retention survives an unreadable or reset settings.json', () => {
  const DAY = 86_400_000;
  const BASE = Date.UTC(2025, 0, 1);
  const dir = () => defaultConfigBackupDir(getDataDir());
  /** 30 snapshots a day apart, made under a long-history retention (100 copies, no age limit). */
  function seed(withKeys = true) {
    settings({ configBackupKeepCount: 100, configBackupKeepDays: 0 });
    for (let i = 0; i < 30; i++) {
      writeFileSync(
        SETTINGS_PATH,
        JSON.stringify(
          withKeys
            ? { displayName: `v${i}`, configBackupKeepCount: 100, configBackupKeepDays: 0 }
            : { displayName: `v${i}` }
        )
      );
      createConfigBackup({
        dataDir: getDataDir(),
        backupDir: dir(),
        reason: 'auto',
        now: BASE + i * DAY,
        keepCount: 100,
        keepDays: 0,
      });
    }
    expect(listConfigBackups(dir())).toHaveLength(30);
  }

  it('a settings.json that does not parse still gets a snapshot but prunes nothing', async () => {
    seed();
    writeFileSync(SETTINGS_PATH, '{ "displayName": "half-written", }');
    const out = await runConfigBackup('auto');
    expect(out?.result.status).toBe('created');
    expect(out?.removed).toEqual([]);
    expect(listConfigBackups(dir())).toHaveLength(31);
  });

  it('a reset settings.json prunes with the retention the newest snapshot recorded, not the defaults', async () => {
    seed();
    writeFileSync(SETTINGS_PATH, '{}');
    const out = await runConfigBackup('auto');
    expect(out?.result.status).toBe('created');
    // aged manifests (a year old) and keepDays 0: the defaults (20 copies, 30 days) would leave 20
    expect(listConfigBackups(dir())).toHaveLength(31);
  });

  it.each([true, false])(
    'a restore after a reset keeps the retention (the backup %s the four keys)',
    async (withKeys) => {
      seed(withKeys);
      const oldest = listConfigBackups(dir()).at(-1)!.id;
      writeFileSync(SETTINGS_PATH, '{}'); // the reset
      expect((await runConfigBackup('auto'))?.removed).toEqual([]);

      const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
      const res = await app.inject({ method: 'POST', url: `/api/config-backups/${oldest}/restore` });
      expect(res.statusCode).toBe(200);
      // the restored file carries the retention, or the recorded one still applies via the pre-restore copy
      const out = await runConfigBackup('auto');
      expect(out?.removed).toEqual([]);
      expect(listConfigBackups(dir()).length).toBeGreaterThanOrEqual(32);
      const status = (await app.inject({ method: 'GET', url: '/api/config-backups' })).json().data.settings;
      expect(status).toMatchObject({ keepCount: 100, keepDays: 0 }); // what the form shows is what the pass uses
    }
  );

  it("re-entering a custom folder after a reset finds that folder's recorded retention", async () => {
    const folder = join(custom, 'kept');
    settings({ configBackupDir: folder, configBackupKeepCount: 100, configBackupKeepDays: 0 });
    for (let i = 0; i < 30; i++) {
      createConfigBackup({
        dataDir: getDataDir(),
        backupDir: folder,
        reason: 'auto',
        force: true,
        now: BASE + i * DAY,
        keepCount: 100,
        keepDays: 0,
      });
    }
    writeFileSync(SETTINGS_PATH, '{}'); // the reset drops the folder too
    await runConfigBackup('auto'); // goes to the default folder, which holds none of those manifests
    // the user enters the folder again and saves; the form no longer sends retention it only displayed
    writeFileSync(SETTINGS_PATH, JSON.stringify({ configBackupDir: folder, configBackupEnabled: true }));
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const reported = (await app.inject({ method: 'GET', url: '/api/config-backups' })).json().data.settings;
    expect(reported).toMatchObject({ keepCount: 100, keepDays: 0 });
    const out = await runConfigBackup('auto');
    expect(out?.removed).toEqual([]);
    expect(listConfigBackups(folder).length).toBeGreaterThanOrEqual(30);
  });

  it('only the retention key the file lacks falls back to the recorded one', async () => {
    seed();
    writeFileSync(SETTINGS_PATH, JSON.stringify({ configBackupKeepDays: 3650 }));
    await runConfigBackup('auto');
    expect(listConfigBackups(dir())).toHaveLength(31); // keepCount 100 from the manifests, not the default 20
  });

  it('a settings.json that sets the retention still wins', async () => {
    seed();
    writeFileSync(SETTINGS_PATH, JSON.stringify({ configBackupKeepCount: 5, configBackupKeepDays: 0 }));
    await runConfigBackup('auto');
    expect(listConfigBackups(dir())).toHaveLength(5);
  });

  it('listing never creates config-backup-id', async () => {
    const { app } = await createRouteTestHarness(registerConfigBackupRoutes);
    const idFile = join(getDataDir(), 'config-backup-id');
    rmSync(idFile, { force: true });
    expect((await app.inject({ method: 'GET', url: '/api/config-backups' })).json().data.backups).toEqual([]);
    expect(existsSync(idFile)).toBe(false);
  });
});
