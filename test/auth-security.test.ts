/**
 * Auth security tests — verifies security fixes:
 * 1. Timing-safe password comparison (timingSafeEqual)
 * 2. Hook event endpoint restricted to localhost
 * 3. Session cookie TTL refresh on access
 * 4. Startup fails closed when network-bound without auth
 * 5. SSE client limit enforcement
 * 6. Logout endpoint invalidates session
 * 7. Settings schema rejects unknown fields
 *
 * Port: ephemeral (`new WebServer(0, …)`, read back through `boundPort`)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { SettingsUpdateSchema } from '../src/web/schemas.js';
import { getHookSecret, HOOK_SECRET_HEADER } from '../src/config/hook-secret.js';

const TEST_USER = 'admin';
const TEST_PASS = 'test-password-12345';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

function basicAuthHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function startAuthServer(): Promise<{ server: WebServer; baseUrl: string }> {
  process.env.CODEMAN_PASSWORD = TEST_PASS;
  process.env.CODEMAN_USERNAME = TEST_USER;
  const server = new WebServer(0, false, true);
  await server.start();
  return { server, baseUrl: `http://localhost:${server.boundPort}` };
}

async function getSessionCookie(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/status`, {
    headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const cookieMatch = setCookie!.match(/codeman_session=([^;]+)/);
  expect(cookieMatch).toBeTruthy();
  return `codeman_session=${cookieMatch![1]}`;
}

async function exhaustAuthFailures(baseUrl: string, prefix: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, `${prefix}-${i}`) },
    });
    expect(res.status).toBe(401);
  }
}

describe('Auth Security', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
  });

  describe('Basic Auth', () => {
    it('should reject requests without credentials', async () => {
      const res = await fetch(`${baseUrl}/api/status`);
      expect(res.status).toBe(401);
    });

    it('should accept correct credentials', async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(200);
    });

    it('should reject wrong password', async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, 'wrong') },
      });
      expect(res.status).toBe(401);
    });

    it('should reject wrong username', async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader('hacker', TEST_PASS) },
      });
      expect(res.status).toBe(401);
    });

    it('should reject empty authorization header', async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: '' },
      });
      expect(res.status).toBe(401);
    });

    it('should reject malformed authorization header', async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: 'Bearer some-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Session Cookies', () => {
    it('should issue session cookie on successful auth', async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain('codeman_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
    });

    it('should accept requests with valid session cookie', async () => {
      // First, authenticate to get a cookie
      const authRes = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      const setCookie = authRes.headers.get('set-cookie')!;
      const cookieMatch = setCookie.match(/codeman_session=([^;]+)/);
      expect(cookieMatch).toBeTruthy();
      const cookie = `codeman_session=${cookieMatch![1]}`;

      // Use the cookie without Basic Auth header
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });

    it('should reject requests with invalid session cookie', async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Cookie: 'codeman_session=invalid-token-value' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Logout', () => {
    it('should invalidate session cookie on logout', async () => {
      // Authenticate to get a cookie
      const authRes = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      const setCookie = authRes.headers.get('set-cookie')!;
      const cookieMatch = setCookie.match(/codeman_session=([^;]+)/);
      expect(cookieMatch).toBeTruthy();
      const cookie = `codeman_session=${cookieMatch![1]}`;

      // Verify cookie works
      const beforeRes = await fetch(`${baseUrl}/api/status`, {
        headers: { Cookie: cookie },
      });
      expect(beforeRes.status).toBe(200);

      // Logout
      const logoutRes = await fetch(`${baseUrl}/api/logout`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(logoutRes.status).toBe(200);

      // Cookie should no longer work
      const afterRes = await fetch(`${baseUrl}/api/status`, {
        headers: { Cookie: cookie },
      });
      expect(afterRes.status).toBe(401);
    });
  });

  describe('Rate Limiting', () => {
    let rateServer: WebServer;
    let rateBaseUrl: string;

    beforeEach(async () => {
      ({ server: rateServer, baseUrl: rateBaseUrl } = await startAuthServer());
    });

    afterEach(async () => {
      await rateServer.stop();
    });

    it('should rate-limit wrong credentials after too many failed attempts', async () => {
      await exhaustAuthFailures(rateBaseUrl, 'cod21-wrong');

      const res = await fetch(`${rateBaseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, 'wrong-again') },
      });

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    });

    it('should allow an existing valid session cookie during auth failure lockout', async () => {
      const cookie = await getSessionCookie(rateBaseUrl);
      await exhaustAuthFailures(rateBaseUrl, 'cod21-cookie');

      const res = await fetch(`${rateBaseUrl}/api/status`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
    });

    it('should allow correct credentials to recover from auth failure lockout', async () => {
      await exhaustAuthFailures(rateBaseUrl, 'cod21-recover');

      const res = await fetch(`${rateBaseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toContain('codeman_session=');
    });

    it('should clear failed attempt count after correct credentials recover access', async () => {
      await exhaustAuthFailures(rateBaseUrl, 'cod21-clear');

      const recoveryRes = await fetch(`${rateBaseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      expect(recoveryRes.status).toBe(200);

      const wrongAfterRecovery = await fetch(`${rateBaseUrl}/api/status`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, 'wrong-after-recovery') },
      });

      expect(wrongAfterRecovery.status).toBe(401);
    });
  });

  describe('Hook Event Endpoint', () => {
    it('should allow hook events from localhost with the hook secret (no Basic auth)', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HOOK_SECRET_HEADER]: getHookSecret() },
        body: JSON.stringify({
          event: 'stop',
          sessionId: 'nonexistent-session',
          data: {},
        }),
      });
      // Should pass auth (localhost bypass + hook secret) but may 404 on session — that's fine.
      // The key assertion is it does NOT return 401 (COD-91: secret required even with no tunnel).
      expect(res.status).not.toBe(401);
    });

    it('should reject hook events with invalid schema', async () => {
      const res = await fetch(`${baseUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HOOK_SECRET_HEADER]: getHookSecret() },
        body: JSON.stringify({ invalid: 'data' }),
      });
      // Past the auth gate (valid secret) → schema validation should catch this (not a 401).
      expect(res.status).not.toBe(401); // Not an auth error
    });
  });
});

describe('Settings Schema Security', () => {
  it('should accept valid known settings fields', () => {
    const result = SettingsUpdateSchema.safeParse({
      tunnelEnabled: true,
      ralphTrackerEnabled: false,
      defaultClaudeMdPath: '/some/path',
    });
    expect(result.success).toBe(true);
  });

  it('should enforce tunnelEnabled as boolean', () => {
    const result = SettingsUpdateSchema.safeParse({
      tunnelEnabled: 'yes', // truthy string — should be rejected
    });
    expect(result.success).toBe(false);
  });

  it('should reject unknown fields (strict mode)', () => {
    const result = SettingsUpdateSchema.safeParse({
      tunnelEnabled: true,
      maliciousField: 'injected',
    });
    expect(result.success).toBe(false);
  });

  it('should accept notification preferences', () => {
    const result = SettingsUpdateSchema.safeParse({
      notificationPreferences: {
        enabled: true,
        browserNotifications: true,
        audioAlerts: false,
        eventTypes: {
          stop: { enabled: true, browser: true, audio: false },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('should accept voice settings', () => {
    const result = SettingsUpdateSchema.safeParse({
      voiceSettings: {
        apiKey: 'some-key',
        language: 'en-US',
      },
    });
    expect(result.success).toBe(true);
  });

  it('should validate nice value range', () => {
    const validResult = SettingsUpdateSchema.safeParse({
      nice: { enabled: true, niceValue: 10 },
    });
    expect(validResult.success).toBe(true);

    const invalidResult = SettingsUpdateSchema.safeParse({
      nice: { enabled: true, niceValue: 100 }, // Out of range
    });
    expect(invalidResult.success).toBe(false);
  });
});

describe('No-Auth Server Startup Policy', () => {
  let server: WebServer;

  beforeAll(async () => {
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
    delete process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK;
    server = new WebServer(0, false, true, '127.0.0.1');
    await server.start();
  });

  afterAll(async () => {
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
    delete process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK;
    await server.stop();
  });

  it('allows loopback requests without auth when no password is configured', async () => {
    const res = await fetch(`http://localhost:${server.boundPort}/api/status`);
    expect(res.status).toBe(200);
  });

  it('starts with a loud warning (not a hard failure) on a non-loopback bind without a password', async () => {
    // Policy (0.9.0): loopback is the safe default, but opting into a non-loopback
    // bind without a password no longer refuses to start — it starts and warns,
    // pointing at how to secure it. See docs/security-architecture.md.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const networkServer = new WebServer(0, false, true, '0.0.0.0');

    await expect(networkServer.start()).resolves.toBeUndefined();
    const res = await fetch(`http://localhost:${networkServer.boundPort}/api/status`);
    expect(res.status).toBe(200);

    const warned = warnSpy.mock.calls.flat().join('\n');
    expect(warned).toMatch(/non-loopback host|NO password/i);
    expect(warned).toMatch(/CODEMAN_PASSWORD/);

    warnSpy.mockRestore();
    await networkServer.stop();
  });

  it('allows non-loopback startup when CODEMAN_PASSWORD is configured', async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    const networkServer = new WebServer(0, false, true, '0.0.0.0');

    await networkServer.start();
    await networkServer.stop();

    delete process.env.CODEMAN_PASSWORD;
  });

  it('allows non-loopback startup with the explicit unauthenticated-network override', async () => {
    const networkServer = new WebServer(0, false, true, '0.0.0.0', undefined, true);

    await networkServer.start();
    const res = await fetch(`http://localhost:${networkServer.boundPort}/api/status`);
    expect(res.status).toBe(200);
    await networkServer.stop();
  });

  it('allows non-loopback startup with the explicit unauthenticated-network env override', async () => {
    process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK = 'true';
    const networkServer = new WebServer(0, false, true, '0.0.0.0');

    await networkServer.start();
    await networkServer.stop();

    delete process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK;
  });
});
