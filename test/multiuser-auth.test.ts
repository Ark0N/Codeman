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
import { createUser, invalidateUsersCache, verifyPassword } from '../src/user-store.js';
import type { FastifyInstance } from 'fastify';
import { AUTH_FAILURE_MAX, AUTH_IP_FAILURE_MAX } from '../src/config/auth-config.js';
import type { StaleExpirationMap } from '../src/utils/stale-expiration-map.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

// Count scrypt verifies: the real verifyPassword, wrapped, so the middleware still checks
// the real store and a test can tell how many requests reached it.
vi.mock('../src/user-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/user-store.js')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});
const verifyCalls = vi.mocked(verifyPassword);

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
let sprayServer: WebServer;
const ipServers: WebServer[] = [];
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
  await sprayServer?.stop().catch(() => {});
  for (const s of ipServers) await s.stop().catch(() => {});
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidateUsersCache();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(spacesDir, { recursive: true, force: true }).catch(() => {});
});

const url = (p: string) => `http://localhost:${server.boundPort}${p}`;

/** The server's private failure buckets, read to count how many guesses reached the verify. */
type FailureBuckets = Record<'authFailures' | 'userFailures' | 'userIpFailures', StaleExpirationMap<string, number>>;

/**
 * A fresh multi-user server (empty failure buckets) and a login helper that sets the
 * client IP through inject's `remoteAddress`: a real fetch always arrives from
 * loopback, so it cannot show two sources.
 */
async function startIpServer() {
  const s = new WebServer(0, false, true);
  await s.start();
  ipServers.push(s);
  const app = (s as unknown as { app: FastifyInstance }).app;
  const login = (ip: string, user: string, pass: string) =>
    app.inject({ method: 'GET', url: '/api/status', headers: { authorization: basic(user, pass) }, remoteAddress: ip });
  return { login, buckets: s as unknown as FailureBuckets };
}

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

  it('verify-first: the per-username bucket never denies a correct password and self-heals failures (#17)', async () => {
    rateServer = new WebServer(0, false, true);
    await rateServer.start();
    const rurl = (p: string) => `http://localhost:${rateServer.boundPort}${p}`;

    // Nine wrong passwords (one below the cap) are each rejected 401 — not throttled yet.
    for (let i = 0; i < AUTH_FAILURE_MAX - 1; i++) {
      const res = await fetch(rurl('/api/status'), { headers: { Authorization: basic('bob', `bad-${i}`) } });
      expect(res.status).toBe(401);
    }
    // Finding #17: the per-username bucket is checked AFTER the verify, so it never denies
    // a correct password, and success clears the failure buckets. Previously this returned
    // 429 (the DoS being fixed). Nine failures also stay under the per-(username, IP) gate,
    // which is checked before the verify; that is why the correct password is 200 here.
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

  it('per-IP pre-gate: wrong passwords spread across accounts are throttled at AUTH_IP_FAILURE_MAX, before scrypt', async () => {
    // Fresh server so no earlier test's failures sit in the per-IP bucket.
    sprayServer = new WebServer(0, false, true);
    await sprayServer.start();
    const surl = (p: string) => `http://localhost:${sprayServer.boundPort}${p}`;

    // Spread the guesses so no single username reaches its own AUTH_FAILURE_MAX bucket:
    // only the per-IP pre-gate can produce a 429 here.
    const perUser = AUTH_FAILURE_MAX - 1;
    for (let i = 0; i < AUTH_IP_FAILURE_MAX; i++) {
      const user = `spray${Math.floor(i / perUser)}`;
      const res = await fetch(surl('/api/status'), { headers: { Authorization: basic(user, `bad-${i}`) } });
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }

    // One more failure from the same IP is refused by the pre-gate.
    const over = await fetch(surl('/api/status'), { headers: { Authorization: basic('spray-extra', 'bad') } });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toMatch(/^\d+$/);

    // The pre-gate runs before the password check, so even a correct password is refused.
    const good = await fetch(surl('/api/status'), { headers: { Authorization: basic('alice', 'alicepass1') } });
    expect(good.status).toBe(429);
  });

  it('per-(username, IP) gate: failures lock that account on that IP only, before scrypt', async () => {
    const { login } = await startIpServer();
    const ipA = '203.0.113.10';
    const ipB = '203.0.113.20';

    // AUTH_FAILURE_MAX wrong passwords for bob from one IP. The last one is already a
    // 429 from the per-username bucket, which counts before it checks.
    for (let i = 0; i < AUTH_FAILURE_MAX; i++) {
      const res = await login(ipA, 'bob', `bad-${i}`);
      expect(res.statusCode, `attempt ${i + 1}`).toBe(i < AUTH_FAILURE_MAX - 1 ? 401 : 429);
    }

    // The (bob, ipA) bucket is checked before the password, so even the correct one is
    // refused from that IP, far below the per-IP pre-gate.
    expect(AUTH_FAILURE_MAX).toBeLessThan(AUTH_IP_FAILURE_MAX);
    const lockedOut = await login(ipA, 'bob', 'bobpass123');
    expect(lockedOut.statusCode).toBe(429);
    expect(String(lockedOut.headers['retry-after'])).toMatch(/^\d+$/);

    // Another IP cannot lock the account out: bob logs in from ipB.
    expect((await login(ipB, 'bob', 'bobpass123')).statusCode).toBe(200);
    // Another account behind the same IP is not locked out either.
    expect((await login(ipA, 'alice', 'alicepass1')).statusCode).toBe(200);
    // Neither success cleared bob's bucket on ipA: that one is per pair.
    expect((await login(ipA, 'bob', 'bobpass123')).statusCode).toBe(429);
  });

  it('per-IP pre-gate: a concurrent burst from one IP reaches the verify at most AUTH_IP_FAILURE_MAX times', async () => {
    const { login, buckets } = await startIpServer();
    const ip = '203.0.113.40';

    // More than AUTH_IP_FAILURE_MAX wrong passwords in flight at once, spread so neither
    // the pair nor the per-username bucket can refuse any of them. All the gate reads
    // happen before the first verify ends, so only a slot reserved before the scrypt
    // await stops the burst passing the pre-gate on one stale count.
    const extra = 10;
    const perUser = AUTH_FAILURE_MAX - 1;
    const burst = [];
    for (let i = 0; i < AUTH_IP_FAILURE_MAX + extra; i++) {
      burst.push(login(ip, `burst${Math.floor(i / perUser)}`, `bad-${i}`));
    }
    const codes = (await Promise.all(burst)).map((r) => r.statusCode);

    // No account fills a bucket of its own here, so every verified guess is a 401 and
    // every 429 is the pre-gate.
    expect(codes.filter((c) => c === 401).length).toBe(AUTH_IP_FAILURE_MAX);
    expect(codes.filter((c) => c === 429).length).toBe(extra);
    // Each admitted guess counted once: reserved before the verify, not again after it.
    expect(buckets.authFailures.get(ip)).toBe(AUTH_IP_FAILURE_MAX);

    // The bucket is full, so the next request from that IP is refused before scrypt,
    // a correct password included.
    expect((await login(ip, 'burst-next', 'bad')).statusCode).toBe(429);
    expect((await login(ip, 'alice', 'alicepass1')).statusCode).toBe(429);
  });

  it('per-(username, IP) gate: a concurrent burst cannot carry the right password past the cap', async () => {
    const { login, buckets } = await startIpServer();
    const ip = '203.0.113.50';

    // AUTH_FAILURE_MAX + 5 logins for bob from one IP, all in flight at once, the LAST
    // carrying the correct password. Counting only after the verify let every one of
    // them past the gate on the same stale read, and the correct one logged in.
    const burst = [];
    for (let i = 0; i < AUTH_FAILURE_MAX + 4; i++) burst.push(login(ip, 'bob', `bad-${i}`));
    burst.push(login(ip, 'bob', 'bobpass123'));
    const codes = (await Promise.all(burst)).map((r) => r.statusCode);

    expect(codes.at(-1)).toBe(429);
    expect(codes.filter((c) => c !== 401 && c !== 429)).toEqual([]);
    // Every failed verify adds one to bob's per-username bucket, so it counts the guesses
    // that reached scrypt: exactly the AUTH_FAILURE_MAX the pair gate admits. (The last
    // of those is a 429 from that bucket, which is why the 401s are fewer.)
    expect(buckets.userFailures.get('bob')).toBe(AUTH_FAILURE_MAX);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(AUTH_FAILURE_MAX);
    // Reserved once each, not counted again on failure.
    expect(buckets.userIpFailures.get(`${ip}\nbob`)).toBe(AUTH_FAILURE_MAX);
    expect(buckets.authFailures.get(ip)).toBe(AUTH_FAILURE_MAX);

    // The lockout is that pair's only: bob still logs in from another IP.
    expect((await login('203.0.113.51', 'bob', 'bobpass123')).statusCode).toBe(200);
  });

  it('identical in-flight logins share one verify: a burst of correct ones all log in', async () => {
    const { login, buckets } = await startIpServer();
    const ip = '203.0.113.60';
    verifyCalls.mockClear();

    // A browser whose cookie died with a server restart replays its cached Basic header
    // on many parallel requests. Had each reserved its own slot, every one past
    // AUTH_FAILURE_MAX would be refused although all carry the right password.
    const burst = [];
    for (let i = 0; i < AUTH_FAILURE_MAX + 5; i++) burst.push(login(ip, 'bob', 'bobpass123'));
    const responses = await Promise.all(burst);

    expect(responses.map((r) => r.statusCode)).toEqual(burst.map(() => 200));
    expect(verifyCalls).toHaveBeenCalledTimes(1);
    // Each request still gets a cookie session of its own.
    const tokens = responses.map((r) => /codeman_session=([^;]+)/.exec(String(r.headers['set-cookie']))?.[1]);
    expect(new Set(tokens).size).toBe(burst.length);
    expect(tokens).not.toContain(undefined);
    // The one success cleared the buckets, the reservation included.
    expect(buckets.userIpFailures.get(`${ip}\nbob`)).toBeUndefined();
    expect(buckets.authFailures.get(ip)).toBeUndefined();

    // The entry left the map when its verify settled: the next login verifies afresh.
    expect((await login(ip, 'bob', 'bobpass123')).statusCode).toBe(200);
    expect(verifyCalls).toHaveBeenCalledTimes(2);
  });

  it('identical in-flight logins share one verify: a burst of one wrong password counts once', async () => {
    const { login, buckets } = await startIpServer();
    const ip = '203.0.113.70';
    verifyCalls.mockClear();

    const burst = [];
    for (let i = 0; i < AUTH_FAILURE_MAX + 5; i++) burst.push(login(ip, 'bob', 'same-wrong'));
    const codes = (await Promise.all(burst)).map((r) => r.statusCode);

    // One guess, verified once, counted once in each bucket, and the same 401 for all.
    expect(codes).toEqual(burst.map(() => 401));
    expect(verifyCalls).toHaveBeenCalledTimes(1);
    expect(buckets.userFailures.get('bob')).toBe(1);
    expect(buckets.userIpFailures.get(`${ip}\nbob`)).toBe(1);
    expect(buckets.authFailures.get(ip)).toBe(1);
  });

  it('identical in-flight logins skip the gates: the slot their own verify took does not refuse them', async () => {
    const { login } = await startIpServer();
    const ip = '203.0.113.80';
    for (let i = 0; i < AUTH_FAILURE_MAX - 1; i++) {
      expect((await login(ip, 'bob', `bad-${i}`)).statusCode, `attempt ${i + 1}`).toBe(401);
    }
    verifyCalls.mockClear();

    // The first of these takes the pair's last slot; the rest join its verify, so a gate
    // check of their own would refuse them with a full bucket.
    const burst = [];
    for (let i = 0; i < 5; i++) burst.push(login(ip, 'bob', 'bobpass123'));
    const codes = (await Promise.all(burst)).map((r) => r.statusCode);

    expect(codes).toEqual(burst.map(() => 200));
    expect(verifyCalls).toHaveBeenCalledTimes(1);
  });

  it('a verify that throws leaves the in-flight map, and its joiners share the failure', async () => {
    const { login } = await startIpServer();
    const ip = '203.0.113.90';
    verifyCalls.mockClear();
    verifyCalls.mockRejectedValueOnce(new Error('user store unreadable'));

    const burst = [];
    for (let i = 0; i < 3; i++) burst.push(login(ip, 'bob', 'bobpass123'));
    const codes = (await Promise.all(burst)).map((r) => r.statusCode);

    expect(verifyCalls).toHaveBeenCalledTimes(1);
    expect(new Set(codes).size).toBe(1);
    expect(codes[0]).toBeGreaterThanOrEqual(500);

    // Removed in a finally, so the next identical login runs a verify of its own.
    expect((await login(ip, 'bob', 'bobpass123')).statusCode).toBe(200);
    expect(verifyCalls).toHaveBeenCalledTimes(2);
  });

  it('per-(username, IP) gate: a correct password clears the pair bucket', async () => {
    const { login } = await startIpServer();
    const ip = '203.0.113.30';

    for (let i = 0; i < AUTH_FAILURE_MAX - 1; i++) {
      expect((await login(ip, 'bob', `bad-${i}`)).statusCode, `attempt ${i + 1}`).toBe(401);
    }
    expect((await login(ip, 'bob', 'bobpass123')).statusCode).toBe(200);

    // Had the success left the pair at AUTH_FAILURE_MAX - 1, the second of these would
    // already be refused before the password check.
    for (let i = 0; i < AUTH_FAILURE_MAX - 1; i++) {
      expect((await login(ip, 'bob', `again-${i}`)).statusCode, `retry ${i + 1}`).toBe(401);
    }
    expect((await login(ip, 'bob', 'bobpass123')).statusCode).toBe(200);
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
