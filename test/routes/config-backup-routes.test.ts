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
import { registerConfigBackupRoutes } from '../../src/web/routes/config-backup-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { getDataDir } from '../../src/config/instance.js';
import { defaultConfigBackupDir } from '../../src/config-backup.js';
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
    expect(d.restartRequired).toContain('clis.json');
    expect(d.restartRequired).toContain('settings.json'); // its watcher toggles are not re-run by a restore
    expect(d.safetySnapshot).toBeTruthy();
    expect(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).displayName).toBe('before');
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
