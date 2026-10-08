/**
 * @fileoverview Phase 2 multi-user auth integration tests (live server, ephemeral port).
 *
 * Verifies the multi-user auth branch end to end: per-user Basic verify, cookie
 * identity, wrong-password / disabled-user rejection, the mustChangePassword
 * lockbox + self-service change, per-account rate limiting, and QR identity binding
 * (tunnel-manager unit level). Single-user auth is covered by auth-security.test.ts.
 *
 * Ports: ephemeral (`new WebServer(0, …)`, read back through `boundPort`).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { TunnelManager } from '../src/tunnel-manager.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';
import { AUTH_FAILURE_MAX } from '../src/config/auth-config.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function cookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  const m = raw?.match(/codeman_session=([^;]+)/);
  return m ? `codeman_session=${m[1]}` : null;
}

let server: WebServer;
let rateServer: WebServer;
let dataDir: string;
let spacesDir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mu-auth-data-'));
  spacesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mu-auth-spaces-'));
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

  await createUser({ username: 'alice', role: 'admin', password: 'alicepass1' });
  await createUser({ username: 'bob', role: 'user', password: 'bobpass123' });
  await createUser({ username: 'carol', role: 'user', password: 'carolpass1' });
  await createUser({ username: 'carol', role: 'user', password: 'x' }).catch(() => {}); // no-op dup guard
  await createUser({ username: 'dave', role: 'user', password: 'davepass12', mustChangePassword: true });
  // Disable carol after creation.
  const { updateUser } = await import('../src/user-store.js');
  await updateUser('carol', { disabled: true });

  server = new WebServer(0, false, true);
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  await rateServer?.stop().catch(() => {});
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidateUsersCache();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(spacesDir, { recursive: true, force: true }).catch(() => {});
});

const url = (p: string) => `http://localhost:${server.boundPort}${p}`;

describe('multi-user auth', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(url('/api/status'));
    expect(res.status).toBe(401);
  });

  it('authenticates a valid user and issues an identity cookie', async () => {
    const res = await fetch(url('/api/status'), { headers: { Authorization: basic('alice', 'alicepass1') } });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect(cookie).toBeTruthy();

    const me = await fetch(url('/api/me'), { headers: { Cookie: cookie! } });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.data).toMatchObject({ username: 'alice', role: 'admin', mustChangePassword: false });
  });

  it('reports role for a regular user', async () => {
    const res = await fetch(url('/api/me'), { headers: { Authorization: basic('bob', 'bobpass123') } });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ username: 'bob', role: 'user' });
  });

  it('rejects a wrong password', async () => {
    const res = await fetch(url('/api/status'), { headers: { Authorization: basic('bob', 'wrongwrong') } });
    expect(res.status).toBe(401);
  });

  it('rejects a disabled user even with the correct password', async () => {
    const res = await fetch(url('/api/status'), { headers: { Authorization: basic('carol', 'carolpass1') } });
    expect(res.status).toBe(401);
  });

  it('is case-insensitive on the username', async () => {
    const res = await fetch(url('/api/status'), { headers: { Authorization: basic('ALICE', 'alicepass1') } });
    expect(res.status).toBe(200);
  });

  it('enforces the mustChangePassword lockbox and clears it on self-service change', async () => {
    // Basic auth as dave succeeds (cookie issued) but non-exempt routes 403.
    const authed = await fetch(url('/api/status'), { headers: { Authorization: basic('dave', 'davepass12') } });
    expect(authed.status).toBe(403);
    const body = await authed.json();
    expect(body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
    const cookie = cookieFrom(authed);
    expect(cookie).toBeTruthy();

    // /api/me is exempt.
    const me = await fetch(url('/api/me'), { headers: { Cookie: cookie! } });
    expect(me.status).toBe(200);
    expect((await me.json()).data.mustChangePassword).toBe(true);

    // Wrong current password is refused.
    const bad = await fetch(url('/api/me/password'), {
      method: 'POST',
      headers: { Cookie: cookie!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'nope', newPassword: 'brandnew123' }),
    });
    expect(bad.status).toBe(403);

    // Correct change clears the flag.
    const ok = await fetch(url('/api/me/password'), {
      method: 'POST',
      headers: { Cookie: cookie!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'davepass12', newPassword: 'brandnew123' }),
    });
    expect(ok.status).toBe(200);

    // Same cookie now reaches a non-exempt route.
    const after = await fetch(url('/api/status'), { headers: { Cookie: cookie! } });
    expect(after.status).toBe(200);
  });

  it('verify-first: a correct password is never rate-limited and self-heals failures (#17)', async () => {
    rateServer = new WebServer(0, false, true);
    await rateServer.start();
    const rurl = (p: string) => `http://localhost:${rateServer.boundPort}${p}`;

    // Nine wrong passwords (one below the cap) are each rejected 401 — not throttled yet.
    for (let i = 0; i < AUTH_FAILURE_MAX - 1; i++) {
      const res = await fetch(rurl('/api/status'), { headers: { Authorization: basic('bob', `bad-${i}`) } });
      expect(res.status).toBe(401);
    }
    // Finding #17: the CORRECT password must ALWAYS win (verified BEFORE the per-username
    // throttle) — the accumulated failures can never lock the account out — and success
    // clears the failure buckets. Previously this returned 429 (the DoS being fixed).
    const good = await fetch(rurl('/api/status'), { headers: { Authorization: basic('bob', 'bobpass123') } });
    expect(good.status).toBe(200);
    // Self-heal: a fresh wrong attempt is 401 again (the counter was reset by the success).
    const afterReset = await fetch(rurl('/api/status'), { headers: { Authorization: basic('bob', 'nope') } });
    expect(afterReset.status).toBe(401);

    // Sustained wrong passwords ARE still throttled: 429 once the cap is reached.
    let limited = false;
    for (let i = 0; i < AUTH_FAILURE_MAX + 1 && !limited; i++) {
      const res = await fetch(rurl('/api/status'), { headers: { Authorization: basic('bob', `x-${i}`) } });
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });
});

describe('QR token identity (tunnel-manager)', () => {
  it('binds a minted token to a user and returns it on consume (single-use)', () => {
    const tm = new TunnelManager();
    const code = tm.mintUserToken('alice');
    expect(code).toHaveLength(6);
    const first = tm.consumeTokenWithIdentity(code);
    expect(first).toEqual({ ok: true, username: 'alice' });
    // single-use
    expect(tm.consumeTokenWithIdentity(code)).toEqual({ ok: false });
  });

  it('unknown code is rejected', () => {
    const tm = new TunnelManager();
    expect(tm.consumeTokenWithIdentity('ZZZZZZ')).toEqual({ ok: false });
  });
});
