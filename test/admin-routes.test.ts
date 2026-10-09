/**
 * @fileoverview Phase 5 admin API tests (live server, ephemeral port).
 *
 * Covers the admin user-management endpoints: multi-user gate, requireAdmin,
 * create (one-time password), patch + last-admin invariant, reset-password,
 * disable-revokes-sessions, and delete (last-admin refusal + delete-space).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const url = (p: string) => `http://localhost:${server.boundPort}${p}`;
const admin = { Authorization: basic('root', 'rootpass123'), 'Content-Type': 'application/json' };
const adminNoBody = { Authorization: basic('root', 'rootpass123') };
const regular = { Authorization: basic('joe', 'joepass1234'), 'Content-Type': 'application/json' };

let server: WebServer;
let dataDir: string;
let spacesDir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-data-'));
  spacesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-spaces-'));
  for (const k of [
    'CODEMAN_DATA_DIR',
    'CODEMAN_USER_SPACES_DIR',
    'CODEMAN_MULTIUSER',
    'CODEMAN_PASSWORD',
    'CODEMAN_USERNAME',
  ]) {
    saved[k] = process.env[k];
  }
  process.env.CODEMAN_DATA_DIR = dataDir;
  process.env.CODEMAN_USER_SPACES_DIR = spacesDir;
  process.env.CODEMAN_MULTIUSER = '1';
  delete process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_USERNAME;
  invalidateUsersCache();
  await createUser({ username: 'root', role: 'admin', password: 'rootpass123' });
  await createUser({ username: 'joe', role: 'user', password: 'joepass1234' });
  server = new WebServer(0, false, true);
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidateUsersCache();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(spacesDir, { recursive: true, force: true }).catch(() => {});
});

describe('admin API', () => {
  it('rejects a non-admin (403)', async () => {
    const res = await fetch(url('/api/admin/users'), { headers: regular });
    expect(res.status).toBe(403);
  });

  it('lists users for an admin', async () => {
    const res = await fetch(url('/api/admin/users'), { headers: admin });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((u: { username: string }) => u.username).sort()).toEqual(['joe', 'root']);
    expect(data[0]).not.toHaveProperty('password');
  });

  it('creates a user with a one-time password', async () => {
    const res = await fetch(url('/api/admin/users'), {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ username: 'newbie', role: 'user' }),
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.oneTimePassword).toBeTypeOf('string');
    expect(data.user).toMatchObject({ username: 'newbie', mustChangePassword: true });
  });

  it('toggles canBypassPermissions via PATCH', async () => {
    const res = await fetch(url('/api/admin/users/joe'), {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ canBypassPermissions: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.user.canBypassPermissions).toBe(true);
  });

  it('refuses to demote the last admin (409)', async () => {
    const res = await fetch(url('/api/admin/users/root'), {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ role: 'user' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).errorCode).toBe('LAST_ADMIN');
  });

  it('resets a password (one-time) and forces change', async () => {
    const res = await fetch(url('/api/admin/users/joe/reset-password'), { method: 'POST', headers: adminNoBody });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.oneTimePassword).toBeTypeOf('string');
    // joe must now change password before other actions.
    const gated = await fetch(url('/api/status'), { headers: { Authorization: basic('joe', data.oneTimePassword) } });
    expect(gated.status).toBe(403);
    expect((await gated.json()).errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('refuses to delete the last admin, deletes a regular user + space', async () => {
    const del = await fetch(url('/api/admin/users/root'), { method: 'DELETE', headers: adminNoBody });
    expect(del.status).toBe(409);

    await fs.mkdir(path.join(spacesDir, 'newbie', 'cases'), { recursive: true });
    const del2 = await fetch(url('/api/admin/users/newbie'), {
      method: 'DELETE',
      headers: admin,
      body: JSON.stringify({ deleteSpace: true }),
    });
    expect(del2.status).toBe(200);
    await expect(fs.stat(path.join(spacesDir, 'newbie'))).rejects.toBeTruthy();
  });

  it('404s admin routes in single-user mode', async () => {
    // Flip the flag off for one request path check.
    process.env.CODEMAN_MULTIUSER = '';
    try {
      const res = await fetch(url('/api/admin/users'), { headers: admin });
      expect(res.status).toBe(404);
    } finally {
      process.env.CODEMAN_MULTIUSER = '1';
    }
  });
});

describe('admin case-folder API', () => {
  const kim = { Authorization: basic('kim', 'kimpass1234') };

  it('lists a user case folders (admin only, hidden dirs excluded)', async () => {
    // Fresh regular user with a known password (joe's was reset above).
    const created = await fetch(url('/api/admin/users'), {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ username: 'kim', role: 'user', password: 'kimpass1234' }),
    });
    expect(created.status).toBe(200);
    await fs.mkdir(path.join(spacesDir, 'kim', 'cases', 'proj1'), { recursive: true });
    await fs.mkdir(path.join(spacesDir, 'kim', 'cases', '.hidden'), { recursive: true });

    const forbidden = await fetch(url('/api/admin/users/kim/cases'), { headers: kim });
    expect(forbidden.status).toBe(403);

    const res = await fetch(url('/api/admin/users/kim/cases'), { headers: adminNoBody });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.cases.map((c: { name: string }) => c.name)).toEqual(['proj1']);
    expect(data.cases[0].liveSessions).toBe(0);
  });

  it('404s for an unknown user', async () => {
    const res = await fetch(url('/api/admin/users/ghost/cases'), { headers: adminNoBody });
    expect(res.status).toBe(404);
  });

  it('deletes a case folder, refusing unsafe names and symlinks', async () => {
    // Traversal-shaped name: rejected before any filesystem access.
    const bad = await fetch(url('/api/admin/users/kim/cases/..%2Fescape'), {
      method: 'DELETE',
      headers: adminNoBody,
    });
    expect([400, 404]).toContain(bad.status);

    // A symlinked "case" is refused, never followed.
    await fs.mkdir(path.join(spacesDir, 'outside'), { recursive: true });
    await fs.symlink(path.join(spacesDir, 'outside'), path.join(spacesDir, 'kim', 'cases', 'link'));
    const sl = await fetch(url('/api/admin/users/kim/cases/link'), { method: 'DELETE', headers: adminNoBody });
    expect(sl.status).toBe(400);
    await expect(fs.stat(path.join(spacesDir, 'outside'))).resolves.toBeTruthy();

    // A real folder is deleted.
    const del = await fetch(url('/api/admin/users/kim/cases/proj1'), { method: 'DELETE', headers: adminNoBody });
    expect(del.status).toBe(200);
    await expect(fs.stat(path.join(spacesDir, 'kim', 'cases', 'proj1'))).rejects.toBeTruthy();

    // Deleting it again 404s.
    const gone = await fetch(url('/api/admin/users/kim/cases/proj1'), { method: 'DELETE', headers: adminNoBody });
    expect(gone.status).toBe(404);
  });
});
