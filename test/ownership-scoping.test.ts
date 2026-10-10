/**
 * @fileoverview Phase 3 ownership-scoping tests (live server, ephemeral port).
 *
 * Verifies multi-user isolation at the API level: case lists are disjoint per user,
 * a non-admin cannot read/kill another user's session, workingDir confinement +
 * shell gate + host-CRUD admin gate are enforced, and admins see everything.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';
import { canAccessOwned, findSessionOrFail, sessionCapacityState } from '../src/web/route-helpers.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

let server: WebServer;
let dataDir: string;
let spacesDir: string;
const saved: Record<string, string | undefined> = {};
const url = (p: string) => `http://localhost:${server.boundPort}${p}`;

// Route returns are wrapped in the {success,data} envelope; unwrap to the payload.
async function getJson(p: string, headers: Record<string, string>): Promise<unknown> {
  const body = await (await fetch(url(p), { headers })).json();
  return body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body;
}
const alice = { Authorization: basic('alice', 'alicepass1') };
const bob = { Authorization: basic('bob', 'bobpass1234') };
const admin = { Authorization: basic('root', 'rootpass123') };

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'own-data-'));
  spacesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'own-spaces-'));
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
  await createUser({ username: 'alice', role: 'user', password: 'alicepass1' });
  await createUser({ username: 'bob', role: 'user', password: 'bobpass1234' });

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

describe('case scoping', () => {
  it('creates cases in per-user spaces and lists them disjointly', async () => {
    const mk = await fetch(url('/api/cases'), {
      method: 'POST',
      headers: { ...alice, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'aliceproj' }),
    });
    expect(mk.status).toBe(200);

    // Case folder is under alice's space.
    expect(await exists(path.join(spacesDir, 'alice', 'cases', 'aliceproj'))).toBe(true);

    const aliceList = (await getJson('/api/cases', alice)) as Array<{ name: string }>;
    expect(aliceList.map((c) => c.name)).toContain('aliceproj');

    const bobList = (await getJson('/api/cases', bob)) as Array<{ name: string }>;
    expect(bobList.map((c) => c.name)).not.toContain('aliceproj');
  });
});

describe('host CRUD is admin-only', () => {
  it('rejects a non-admin defining a docker host', async () => {
    const res = await fetch(url('/api/docker-hosts'), {
      method: 'POST',
      headers: { ...bob, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'h1', label: 'x', image: 'codeman/agent:base' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows an admin to list docker hosts', async () => {
    const res = await fetch(url('/api/docker-hosts'), { headers: admin });
    expect(res.status).toBe(200);
  });
});

describe('session creation gates', () => {
  it('confines a non-admin workingDir to their space', async () => {
    const foreign = path.join(spacesDir, 'alice', 'cases', 'aliceproj');
    const res = await fetch(url('/api/sessions'), {
      method: 'POST',
      headers: { ...bob, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: foreign }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses shell mode for a non-granted user', async () => {
    const mine = path.join(spacesDir, 'bob', 'cases');
    await fs.mkdir(mine, { recursive: true });
    const res = await fetch(url('/api/sessions'), {
      method: 'POST',
      headers: { ...bob, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: mine, mode: 'shell' }),
    });
    expect(res.status).toBe(403);
  });
});

// The session-scoping logic (findSessionOrFail owner check, list filter, per-user
// cap) is tested directly against the helpers under the same multi-user env, since
// real session spawning is no-op'd in test mode and does not durably populate the
// live map. These are the exact functions every session route uses.
describe('session-scoping helpers (multi-user)', () => {
  const fakeSession = (owner?: string) => ({ owner }) as unknown as import('../src/session.js').Session;
  const ctxWith = (map: Map<string, unknown>) => ({ sessions: map }) as never;
  const reqAs = (username: string, role: 'admin' | 'user') => ({ authUser: { username, role } }) as never;

  it('canAccessOwned isolates non-admins to their own', () => {
    expect(canAccessOwned({ username: 'alice', role: 'user' }, 'alice')).toBe(true);
    expect(canAccessOwned({ username: 'alice', role: 'user' }, 'bob')).toBe(false);
    expect(canAccessOwned({ username: 'alice', role: 'user' }, undefined)).toBe(false);
    expect(canAccessOwned({ username: 'root', role: 'admin' }, 'bob')).toBe(true);
  });

  it('findSessionOrFail 404s a foreign session for a non-admin, returns it for owner/admin', () => {
    const map = new Map<string, unknown>([['s1', fakeSession('alice')]]);
    expect(() => findSessionOrFail(ctxWith(map), 's1', reqAs('bob', 'user'))).toThrow();
    expect(findSessionOrFail(ctxWith(map), 's1', reqAs('alice', 'user'))).toBeDefined();
    expect(findSessionOrFail(ctxWith(map), 's1', reqAs('root', 'admin'))).toBeDefined();
  });

  it('per-user session cap counts only the owner sessions', () => {
    const map = new Map<string, unknown>([
      ['a', fakeSession('alice')],
      ['b', fakeSession('alice')],
      ['c', fakeSession('bob')],
    ]);
    process.env.CODEMAN_MAX_SESSIONS_PER_USER = '2';
    expect(sessionCapacityState(map as never, 'alice').atUserCap).toBe(true);
    expect(sessionCapacityState(map as never, 'bob').atUserCap).toBe(false);
    delete process.env.CODEMAN_MAX_SESSIONS_PER_USER;
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
