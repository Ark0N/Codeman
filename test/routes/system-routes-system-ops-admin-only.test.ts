/**
 * @fileoverview Multi-user mode: the server-wide system operations are admin-only.
 *
 * docs/multi-user-plan.md lists the system operations (self-update, the tunnel,
 * span-displays) as admin-only, but these routes had no role check, so any signed-in
 * NON-ADMIN could run them. Pinned here:
 *  - POST /api/system/update, POST /api/system/span-displays, POST /api/tunnel/qr/regenerate
 *    and POST /api/cleanup-state answer 403 FORBIDDEN to a non-admin, and nothing runs;
 *  - POST /api/auth/revoke: a non-admin revokes only their OWN login sessions (the bare
 *    form used to clear every session on the server, every admin's included), and a named
 *    token only when it is one of theirs;
 *  - GET /api/tunnel/info lists only the caller's own logins for a non-admin;
 *  - an admin, and single-user mode, behave as before.
 *
 * Uses app.inject(), so no real HTTP port is needed. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';
import { StaleExpirationMap } from '../../src/utils/stale-expiration-map.js';
import type { AuthSessionRecord } from '../../src/web/ports/auth-port.js';

const { startUpdate } = vi.hoisted(() => ({
  startUpdate: vi.fn(async () => ({ ok: true, updateId: 'u1', toTag: 'v9.9.9', toVersion: '9.9.9' })),
}));

vi.mock('../../src/web/self-update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/self-update.js')>();
  return { ...actual, startUpdate };
});

const NON_ADMIN = { username: 'bob', role: 'user' } as const;
const ADMIN = { username: 'root', role: 'admin' } as const;

function makeTunnelManager() {
  return {
    regenerateQrToken: vi.fn(),
    isRunning: vi.fn(() => true),
    getUrl: vi.fn(() => 'https://example.trycloudflare.com'),
    getStatus: vi.fn(() => ({ running: true, url: 'https://example.trycloudflare.com' })),
  };
}

function record(username: string | undefined, ip: string): AuthSessionRecord {
  return {
    ip,
    ua: 'test-agent',
    createdAt: 1,
    method: 'basic',
    username,
    role: username === 'root' ? 'admin' : 'user',
  };
}

describe('server-wide system operations are admin-only in multi-user mode', () => {
  const savedMultiUser = process.env.CODEMAN_MULTIUSER;
  let harness: RouteTestHarness | undefined;
  let tunnel: ReturnType<typeof makeTunnelManager>;
  let sessions: StaleExpirationMap<string, AuthSessionRecord>;

  async function as(user: typeof NON_ADMIN | typeof ADMIN | null) {
    if (user) process.env.CODEMAN_MULTIUSER = '1';
    else delete process.env.CODEMAN_MULTIUSER;
    harness = await createRouteTestHarness(registerSystemRoutes, user ? { authUser: user } : undefined);
    tunnel = makeTunnelManager();
    sessions = new StaleExpirationMap<string, AuthSessionRecord>({ ttlMs: 60_000 });
    // Two logins of the non-admin, one of an admin, one single-user (no identity).
    sessions.set('bob-laptop', record('bob', '10.0.0.2'));
    sessions.set('bob-phone', record('bob', '10.0.0.3'));
    sessions.set('root-desk', record('root', '10.0.0.1'));
    Object.assign(harness.ctx as unknown as Record<string, unknown>, { tunnelManager: tunnel, authSessions: sessions });
    return harness;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
    sessions?.dispose();
    if (savedMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMultiUser;
  });

  const forbidden = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('FORBIDDEN');
  };

  describe('POST /api/system/update', () => {
    it('refuses a non-admin, and no update starts', async () => {
      const { app } = await as(NON_ADMIN);
      forbidden(await app.inject({ method: 'POST', url: '/api/system/update', payload: {} }));
      expect(startUpdate).not.toHaveBeenCalled();
    });

    for (const [label, user] of [
      ['an admin in multi-user mode', ADMIN],
      ['single-user mode', null],
    ] as const) {
      it(`starts it for ${label}`, async () => {
        const { app } = await as(user);
        const res = await app.inject({ method: 'POST', url: '/api/system/update', payload: {} });
        expect(res.statusCode).toBe(200);
        expect(startUpdate).toHaveBeenCalledTimes(1);
      });
    }
  });

  describe('POST /api/system/span-displays', () => {
    it('refuses a non-admin before anything else', async () => {
      const { app } = await as(NON_ADMIN);
      forbidden(await app.inject({ method: 'POST', url: '/api/system/span-displays' }));
    });

    it('lets an admin through the gate (off macOS the route then answers its own 400)', async () => {
      const { app } = await as(ADMIN);
      const res = await app.inject({ method: 'POST', url: '/api/system/span-displays' });
      if (process.platform === 'darwin') expect(res.statusCode).not.toBe(403);
      else expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/tunnel/qr/regenerate', () => {
    it("refuses a non-admin, and nobody's QR codes are cleared", async () => {
      const { app } = await as(NON_ADMIN);
      forbidden(await app.inject({ method: 'POST', url: '/api/tunnel/qr/regenerate' }));
      expect(tunnel.regenerateQrToken).not.toHaveBeenCalled();
    });

    for (const [label, user] of [
      ['an admin in multi-user mode', ADMIN],
      ['single-user mode', null],
    ] as const) {
      it(`regenerates for ${label}`, async () => {
        const { app } = await as(user);
        const res = await app.inject({ method: 'POST', url: '/api/tunnel/qr/regenerate' });
        expect(res.statusCode).toBe(200);
        expect(tunnel.regenerateQrToken).toHaveBeenCalledTimes(1);
      });
    }
  });

  describe('POST /api/cleanup-state', () => {
    it("refuses a non-admin, and no user's session records are touched", async () => {
      const { app, ctx } = await as(NON_ADMIN);
      forbidden(await app.inject({ method: 'POST', url: '/api/cleanup-state' }));
      expect(ctx.tabLayouts.runStaleSessionCleanup).not.toHaveBeenCalled();
      expect(ctx.store.cleanupSessionsByIds).not.toHaveBeenCalled();
    });

    it('runs for an admin', async () => {
      const { app, ctx } = await as(ADMIN);
      const res = await app.inject({ method: 'POST', url: '/api/cleanup-state' });
      expect(res.statusCode).toBe(200);
      expect(ctx.tabLayouts.runStaleSessionCleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/auth/revoke', () => {
    const tokens = () => [...sessions.keys()].sort();

    it('the bare form signs a non-admin out of their own sessions only, never anyone else', async () => {
      const { app } = await as(NON_ADMIN);
      const res = await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: {} });
      expect(res.statusCode).toBe(200);
      expect(tokens()).toEqual(['root-desk']);
    });

    it("a non-admin's named token is revoked only when it is theirs", async () => {
      const { app } = await as(NON_ADMIN);
      await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: { sessionToken: 'root-desk' } });
      expect(tokens()).toEqual(['bob-laptop', 'bob-phone', 'root-desk']);
      await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: { sessionToken: 'bob-phone' } });
      expect(tokens()).toEqual(['bob-laptop', 'root-desk']);
    });

    for (const [label, user] of [
      ['an admin in multi-user mode', ADMIN],
      ['single-user mode', null],
    ] as const) {
      it(`the bare form still clears every session for ${label}, a named token any session`, async () => {
        const { app } = await as(user);
        await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: { sessionToken: 'bob-phone' } });
        expect(tokens()).toEqual(['bob-laptop', 'root-desk']);
        const res = await app.inject({ method: 'POST', url: '/api/auth/revoke', payload: {} });
        expect(res.statusCode).toBe(200);
        expect(tokens()).toEqual([]);
      });
    }
  });

  describe('GET /api/tunnel/info', () => {
    const ips = (res: { body: string }) =>
      (JSON.parse(res.body).authSessions as { ip: string }[]).map((s) => s.ip).sort();

    it("lists only the non-admin's own logins", async () => {
      const { app } = await as(NON_ADMIN);
      const res = await app.inject({ method: 'GET', url: '/api/tunnel/info' });
      expect(res.statusCode).toBe(200);
      expect(ips(res)).toEqual(['10.0.0.2', '10.0.0.3']);
    });

    it('lists every login for an admin', async () => {
      const { app } = await as(ADMIN);
      const res = await app.inject({ method: 'GET', url: '/api/tunnel/info' });
      expect(ips(res)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    });
  });
});
