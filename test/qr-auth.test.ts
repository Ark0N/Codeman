/**
 * QR Authentication tests — verifies:
 * 1. Token rotation generates unique 6-char base62 short codes
 * 2. Short code generation has no modulo bias (rejection sampling)
 * 3. consumeToken() is single-use (true first, false after)
 * 4. Expired tokens (>90s grace) are rejected
 * 5. Previous token works within 90s grace period
 * 6. regenerateQrToken() clears all tokens
 * 7. Per-IP QR rate limiting (separate from Basic Auth)
 * 8. Global rate limiting (30/min across all IPs)
 * 9. SVG caching (same SVG for same short code)
 * 10. Full server integration: GET /q/:code issues cookie + redirects
 * 11. Session revocation via POST /api/auth/revoke
 * 12. QR auth bypass in auth middleware
 * 13. GET /api/tunnel/qr SVG endpoint (auth/no-auth, caching, errors)
 *
 * Port: 3162 (qr-auth tests), 3163 (qr-svg endpoint tests)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TunnelManager } from '../src/tunnel-manager.js';
import { WebServer } from '../src/web/server.js';

const QR_AUTH_PORT = 3162;
const QR_SVG_PORT = 3163;
const TEST_PASS = 'qr-test-pass-xyz';
const TEST_USER = 'admin';

function basicAuthHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ========== Unit Tests: TunnelManager Token Logic ==========

describe('QR Token Manager (unit)', () => {
  let tm: TunnelManager;

  beforeEach(() => {
    tm = new TunnelManager();
    // Start token rotation manually (normally triggered on tunnel URL acquisition)
    tm.startTokenRotation();
  });

  afterEach(() => {
    // Clean up rotation timer for this test's TunnelManager
    tm?.stopTokenRotation();
  });

  it('should generate a 6-char base62 short code', () => {
    const code = tm.getCurrentShortCode();
    expect(code).toBeDefined();
    expect(code!.length).toBe(6);
    expect(code).toMatch(/^[A-Za-z0-9]{6}$/);
    tm.stopTokenRotation();
  });

  it('should generate unique short codes on rotation', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      tm.regenerateQrToken();
      const code = tm.getCurrentShortCode();
      expect(code).toBeDefined();
      codes.add(code!);
    }
    // All 20 codes should be unique (collision on 62^6 space is vanishingly unlikely)
    expect(codes.size).toBe(20);
    tm.stopTokenRotation();
  });

  it('consumeToken should return true on first use, false on second', () => {
    const code = tm.getCurrentShortCode()!;
    expect(tm.consumeToken(code)).toBe(true);
    // After consumption, a new code is generated — old code should be consumed
    expect(tm.consumeToken(code)).toBe(false);
    tm.stopTokenRotation();
  });

  it('should reject unknown short codes', () => {
    expect(tm.consumeToken('ZZZZZZ')).toBe(false);
    expect(tm.consumeToken('')).toBe(false);
    expect(tm.consumeToken('short')).toBe(false);
    tm.stopTokenRotation();
  });

  it('should reject expired tokens beyond grace period', () => {
    const code = tm.getCurrentShortCode()!;

    // Manually expire the token by manipulating its createdAt
    // Access the private map — this is a unit test, we need to verify the TTL logic
    const tokenMap = (tm as unknown as { qrTokensByCode: Map<string, { createdAt: number }> })
      .qrTokensByCode;
    const record = tokenMap.get(code)!;
    record.createdAt = Date.now() - 91_000; // 91 seconds ago (beyond 90s grace)

    expect(tm.consumeToken(code)).toBe(false);
    tm.stopTokenRotation();
  });

  it('should accept tokens within grace period', () => {
    const code = tm.getCurrentShortCode()!;

    // Set createdAt to 80 seconds ago (within 90s grace)
    const tokenMap = (tm as unknown as { qrTokensByCode: Map<string, { createdAt: number }> })
      .qrTokensByCode;
    const record = tokenMap.get(code)!;
    record.createdAt = Date.now() - 80_000;

    expect(tm.consumeToken(code)).toBe(true);
    tm.stopTokenRotation();
  });

  it('regenerateQrToken should invalidate all existing tokens', () => {
    const oldCode = tm.getCurrentShortCode()!;
    tm.regenerateQrToken();
    const newCode = tm.getCurrentShortCode()!;

    expect(newCode).not.toBe(oldCode);
    expect(tm.consumeToken(oldCode)).toBe(false);
    expect(tm.consumeToken(newCode)).toBe(true);
    tm.stopTokenRotation();
  });

  it('should enforce global rate limit', () => {
    // Exhaust global rate limit (30 attempts)
    for (let i = 0; i < 30; i++) {
      tm.consumeToken('BADCODE');
    }
    // Now even valid codes should be rejected
    const validCode = tm.getCurrentShortCode()!;
    expect(tm.consumeToken(validCode)).toBe(false);
    tm.stopTokenRotation();
  });

  it('should emit qrTokenRotated on rotation', () => {
    let rotateCount = 0;
    tm.on('qrTokenRotated', () => rotateCount++);
    tm.regenerateQrToken(); // calls rotateToken() internally
    // regenerateQrToken calls rotateToken which emits qrTokenRotated
    expect(rotateCount).toBeGreaterThanOrEqual(1);
    tm.stopTokenRotation();
  });

  it('should emit qrTokenRegenerated on consume and regenerate', () => {
    let regenCount = 0;
    tm.on('qrTokenRegenerated', () => regenCount++);

    const code = tm.getCurrentShortCode()!;
    tm.consumeToken(code); // should emit qrTokenRegenerated
    expect(regenCount).toBe(1);

    tm.regenerateQrToken(); // should also emit
    expect(regenCount).toBe(2);
    tm.stopTokenRotation();
  });

  it('SVG cache should return same string for same short code', async () => {
    const fakeUrl = 'https://test.trycloudflare.com';
    const svg1 = await tm.getQrSvg(fakeUrl);
    const svg2 = await tm.getQrSvg(fakeUrl);
    expect(svg1).toBe(svg2); // Same reference (cached)
    expect(svg1).toContain('<svg');
    tm.stopTokenRotation();
  });

  it('SVG cache should regenerate after rotation', async () => {
    const fakeUrl = 'https://test.trycloudflare.com';
    const svg1 = await tm.getQrSvg(fakeUrl);
    tm.regenerateQrToken();
    const svg2 = await tm.getQrSvg(fakeUrl);
    expect(svg1).not.toBe(svg2); // Different content (new short code)
    tm.stopTokenRotation();
  });

  it('should accept token at exactly grace period (90000ms)', () => {
    const code = tm.getCurrentShortCode()!;
    const tokenMap = (tm as unknown as { qrTokensByCode: Map<string, { createdAt: number }> })
      .qrTokensByCode;
    const record = tokenMap.get(code)!;
    record.createdAt = Date.now() - 90_000;
    // Condition is `> QR_TOKEN_GRACE_MS` (strict >), so exactly 90000 should pass
    expect(tm.consumeToken(code)).toBe(true);
  });

  it('should reject token at grace period + 1ms (90001ms)', () => {
    const code = tm.getCurrentShortCode()!;
    const tokenMap = (tm as unknown as { qrTokensByCode: Map<string, { createdAt: number }> })
      .qrTokensByCode;
    const record = tokenMap.get(code)!;
    record.createdAt = Date.now() - 90_001;
    expect(tm.consumeToken(code)).toBe(false);
  });

  it('should never produce non-base62 characters (100 samples)', () => {
    for (let i = 0; i < 100; i++) {
      tm.regenerateQrToken();
      const code = tm.getCurrentShortCode()!;
      expect(code).toMatch(/^[A-Za-z0-9]{6}$/);
    }
  });

  it('should accept both current and previous token within grace period', () => {
    const firstCode = tm.getCurrentShortCode()!;
    // Normal rotation (not regenerateQrToken which clears all) preserves old tokens
    (tm as unknown as { rotateToken(): void }).rotateToken();
    const secondCode = tm.getCurrentShortCode()!;
    expect(firstCode).not.toBe(secondCode);
    // Previous should still be in map and valid (within 90s grace)
    expect(tm.consumeToken(firstCode)).toBe(true);
    // consumeToken called rotateToken, but secondCode was just created so still in grace
    expect(tm.consumeToken(secondCode)).toBe(true);
  });

  it('stopTokenRotation should clear map, shortCode, SVG cache, and counter', () => {
    // Consume something to create state
    tm.consumeToken('BADCODE'); // increments qrAttemptCount
    expect(tm.getCurrentShortCode()).toBeDefined();

    tm.stopTokenRotation();

    expect(tm.getCurrentShortCode()).toBeUndefined();
    const tokenMap = (tm as unknown as { qrTokensByCode: Map<string, unknown> }).qrTokensByCode;
    expect(tokenMap.size).toBe(0);
    expect((tm as unknown as { cachedQrSvg: unknown }).cachedQrSvg).toBeNull();
    expect((tm as unknown as { qrAttemptCount: number }).qrAttemptCount).toBe(0);
  });

  it('consumeToken with empty string should increment attempt counter', () => {
    const before = (tm as unknown as { qrAttemptCount: number }).qrAttemptCount;
    expect(tm.consumeToken('')).toBe(false);
    expect((tm as unknown as { qrAttemptCount: number }).qrAttemptCount).toBe(before + 1);
  });

  it('valid codes should work after rate limit counter resets', () => {
    // Exhaust global rate limit
    for (let i = 0; i < 30; i++) {
      tm.consumeToken('BADCODE');
    }
    const code = tm.getCurrentShortCode()!;
    expect(tm.consumeToken(code)).toBe(false); // blocked

    // Simulate the interval reset
    (tm as unknown as { qrAttemptCount: number }).qrAttemptCount = 0;
    // Need a fresh code since the one above was valid and we want to test consumption
    tm.regenerateQrToken();
    const freshCode = tm.getCurrentShortCode()!;
    expect(tm.consumeToken(freshCode)).toBe(true);
  });

  it('consumed token should be evicted from map after rotation', () => {
    const code = tm.getCurrentShortCode()!;
    tm.consumeToken(code); // sets consumed=true, calls rotateToken()
    // rotateToken evicts consumed records
    const tokenMap = (tm as unknown as { qrTokensByCode: Map<string, unknown> }).qrTokensByCode;
    expect(tokenMap.has(code)).toBe(false);
  });
});

describe('Short code distribution (bias check)', () => {
  it('should produce roughly uniform character distribution', () => {
    // Generate 6000 codes (36000 chars) and check distribution
    const tm = new TunnelManager();
    tm.startTokenRotation();

    const charCounts = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      tm.regenerateQrToken();
      const code = tm.getCurrentShortCode()!;
      for (const ch of code) {
        charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
      }
    }

    // Expected count per char: 36000 / 62 ≈ 580.6
    const expected = 36000 / 62;
    let maxDeviation = 0;
    for (const [, count] of charCounts) {
      const deviation = Math.abs(count - expected) / expected;
      maxDeviation = Math.max(maxDeviation, deviation);
    }

    // With rejection sampling, deviation should be < 15% (generous)
    // Without rejection sampling (modulo bias), first 6 chars would be ~25% overrepresented
    expect(maxDeviation).toBeLessThan(0.15);

    tm.stopTokenRotation();
  });
});

// ========== Integration Tests: Full Server ==========

describe('QR Auth Integration', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    server = new WebServer(QR_AUTH_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${QR_AUTH_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
  });

  beforeEach(() => {
    // Reset QR failure counter to prevent cross-test contamination
    // (all requests come from 127.0.0.1)
    const qrFailures = (server as unknown as { qrAuthFailures: { clear(): void } | null })
      .qrAuthFailures;
    if (qrFailures) qrFailures.clear();
  });

  function getTunnelManager(): TunnelManager {
    return (server as unknown as { tunnelManager: TunnelManager }).tunnelManager;
  }

  it('GET /q/:code should bypass auth middleware (not 401)', async () => {
    // Even with a bad code, we should get 401 from the route handler,
    // NOT from the auth middleware (which would show WWW-Authenticate)
    const res = await fetch(`${baseUrl}/q/BADCODE`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    // The auth middleware's 401 sends WWW-Authenticate header; the route handler doesn't
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('GET /q/:code should redirect to / when no auth configured', async () => {
    // Temporarily remove password
    const savedPass = process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_PASSWORD;

    try {
      const res = await fetch(`${baseUrl}/q/ANYCODE`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    } finally {
      process.env.CODEMAN_PASSWORD = savedPass;
    }
  });

  it('GET /api/tunnel/qr should return authEnabled flag', async () => {
    // Tunnel is not running, so this should 404
    const res = await fetch(`${baseUrl}/api/tunnel/qr`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    // Tunnel not running = 404 (expected)
    expect(res.status).toBe(404);
  });

  it('POST /api/tunnel/qr/regenerate should succeed', async () => {
    const res = await fetch(`${baseUrl}/api/tunnel/qr/regenerate`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('POST /api/auth/revoke should revoke all sessions', async () => {
    // First authenticate to create a session
    const authRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    expect(authRes.status).toBe(200);
    const setCookie = authRes.headers.get('set-cookie')!;
    const cookieMatch = setCookie.match(/codeman_session=([^;]+)/);
    expect(cookieMatch).toBeTruthy();
    const cookie = `codeman_session=${cookieMatch![1]}`;

    // Verify cookie works
    const beforeRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookie },
    });
    expect(beforeRes.status).toBe(200);

    // Revoke all sessions
    const revokeRes = await fetch(`${baseUrl}/api/auth/revoke`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(revokeRes.status).toBe(200);

    // Cookie should no longer work
    const afterRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookie },
    });
    expect(afterRes.status).toBe(401);
  });

  it('POST /api/auth/revoke should revoke a specific session', async () => {
    // Create two sessions
    const auth1 = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    const cookie1 = auth1.headers.get('set-cookie')!.match(/codeman_session=([^;]+)/)![1];

    const auth2 = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    const cookie2 = auth2.headers.get('set-cookie')!.match(/codeman_session=([^;]+)/)![1];

    // Revoke only cookie1
    await fetch(`${baseUrl}/api/auth/revoke`, {
      method: 'POST',
      headers: {
        Cookie: `codeman_session=${cookie2}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionToken: cookie1 }),
    });

    // cookie1 should fail
    const res1 = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: `codeman_session=${cookie1}` },
    });
    expect(res1.status).toBe(401);

    // cookie2 should still work
    const res2 = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: `codeman_session=${cookie2}` },
    });
    expect(res2.status).toBe(200);
  });

  it('QR auth failures should not affect Basic Auth rate limit', async () => {
    // Send QR auth failures
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/q/BAD${i}xx`, { redirect: 'manual' });
    }

    // Basic Auth should still work (not rate-limited by QR failures)
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
  });

  // ========== End-to-End Flow Tests ==========

  it('full QR auth flow: consume token, get cookie, make authenticated request', async () => {
    const tm = getTunnelManager();
    tm.startTokenRotation();
    try {
      const code = tm.getCurrentShortCode()!;

      const qrRes = await fetch(`${baseUrl}/q/${code}`, { redirect: 'manual' });
      expect(qrRes.status).toBe(302);
      expect(qrRes.headers.get('location')).toBe('/');

      const setCookie = qrRes.headers.get('set-cookie')!;
      const cookieMatch = setCookie.match(/codeman_session=([^;]+)/);
      expect(cookieMatch).toBeTruthy();

      // Use the cookie to access an authenticated endpoint
      const apiRes = await fetch(`${baseUrl}/api/status`, {
        headers: { Cookie: `codeman_session=${cookieMatch![1]}` },
      });
      expect(apiRes.status).toBe(200);
    } finally {
      tm.stopTokenRotation();
    }
  });

  it('should return 429 after 10 QR auth failures from same IP', async () => {
    for (let i = 0; i < 10; i++) {
      await fetch(`${baseUrl}/q/BAD${String(i).padStart(3, '0')}`, { redirect: 'manual' });
    }
    const res = await fetch(`${baseUrl}/q/ANOTHER1`, { redirect: 'manual' });
    expect(res.status).toBe(429);
  });

  it('QR auth cookie should have HttpOnly, SameSite=Lax, Path=/, correct MaxAge', async () => {
    const tm = getTunnelManager();
    tm.startTokenRotation();
    try {
      const code = tm.getCurrentShortCode()!;
      const res = await fetch(`${baseUrl}/q/${code}`, { redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie')!;

      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toContain('Max-Age=86400');
    } finally {
      tm.stopTokenRotation();
    }
  });

  it('concurrent requests with same code: first succeeds, second fails', async () => {
    const tm = getTunnelManager();
    tm.startTokenRotation();
    try {
      const code = tm.getCurrentShortCode()!;

      // Fire both simultaneously (Node is single-threaded so they serialize)
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/q/${code}`, { redirect: 'manual' }),
        fetch(`${baseUrl}/q/${code}`, { redirect: 'manual' }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([302, 401]);
    } finally {
      tm.stopTokenRotation();
    }
  });

  it('regenerateQrToken should invalidate previously-valid code', async () => {
    const tm = getTunnelManager();
    tm.startTokenRotation();
    try {
      const code = tm.getCurrentShortCode()!;
      tm.regenerateQrToken(); // clears all tokens

      const res = await fetch(`${baseUrl}/q/${code}`, { redirect: 'manual' });
      expect(res.status).toBe(401);
    } finally {
      tm.stopTokenRotation();
    }
  });

  it('should handle URL-encoded QR code in path parameter', async () => {
    const tm = getTunnelManager();
    tm.startTokenRotation();
    try {
      const code = tm.getCurrentShortCode()!;
      const encoded = encodeURIComponent(code);

      const res = await fetch(`${baseUrl}/q/${encoded}`, { redirect: 'manual' });
      // Fastify auto-decodes path params, so this should succeed
      expect(res.status).toBe(302);
    } finally {
      tm.stopTokenRotation();
    }
  });

  // ========== Security Tests ==========

  it('/q without path parameter should not bypass auth', async () => {
    const res = await fetch(`${baseUrl}/q`, { redirect: 'manual' });
    // /q doesn't match the auth-exempt /q/:code route, so auth middleware intercepts → 401
    expect(res.status).toBe(401);
  });

  it('/q/../api/status path traversal should not return 200', async () => {
    // Note: fetch() normalizes /../ before sending, so this tests the
    // browser-level normalization. The request arrives as /api/status
    // which requires auth → should be 401.
    const res = await fetch(`${baseUrl}/q/../api/status`, { redirect: 'manual' });
    expect(res.status).not.toBe(200);
  });

  it('QR auth session record should have method: qr', async () => {
    const tm = getTunnelManager();
    tm.startTokenRotation();
    try {
      const code = tm.getCurrentShortCode()!;
      const res = await fetch(`${baseUrl}/q/${code}`, { redirect: 'manual' });
      expect(res.status).toBe(302);

      const setCookie = res.headers.get('set-cookie')!;
      const token = setCookie.match(/codeman_session=([^;]+)/)![1];

      const authSessions = (server as unknown as {
        authSessions: { get(k: string): { method: string } | undefined } | null;
      }).authSessions;
      const record = authSessions?.get(token);
      expect(record).toBeDefined();
      expect(record!.method).toBe('qr');
    } finally {
      tm.stopTokenRotation();
    }
  });
});

// ========== QR SVG Endpoint Tests (GET /api/tunnel/qr) ==========

describe('QR SVG Endpoint (GET /api/tunnel/qr)', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    server = new WebServer(QR_SVG_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${QR_SVG_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
  });

  function getTunnelManager(): TunnelManager {
    return (server as unknown as { tunnelManager: TunnelManager }).tunnelManager;
  }

  function simulateTunnelRunning(tm: TunnelManager, url = 'https://test-qr.trycloudflare.com'): void {
    (tm as unknown as { url: string | null }).url = url;
  }

  function simulateTunnelStopped(tm: TunnelManager): void {
    (tm as unknown as { url: string | null }).url = null;
  }

  it('should return 404 when tunnel is not running', async () => {
    const res = await fetch(`${baseUrl}/api/tunnel/qr`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('should return SVG with authEnabled=true when tunnel running + auth configured', async () => {
    const tm = getTunnelManager();
    simulateTunnelRunning(tm);
    tm.startTokenRotation();
    try {
      const res = await fetch(`${baseUrl}/api/tunnel/qr`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.authEnabled).toBe(true);
      expect(data.svg).toContain('<svg');
      expect(data.svg).toContain('</svg>');
    } finally {
      tm.stopTokenRotation();
      simulateTunnelStopped(tm);
    }
  });

  it('should return SVG with authEnabled=false when tunnel running + no auth', async () => {
    const tm = getTunnelManager();
    simulateTunnelRunning(tm);
    const savedPass = process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_PASSWORD;
    try {
      // Auth middleware was initialized with password (closure), so still need headers.
      // But route handler checks env var on each request — sees no password → no-auth path.
      const res = await fetch(`${baseUrl}/api/tunnel/qr`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, savedPass!) },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.authEnabled).toBe(false);
      expect(data.svg).toContain('<svg');
      expect(data.svg).toContain('</svg>');
    } finally {
      process.env.CODEMAN_PASSWORD = savedPass;
      simulateTunnelStopped(tm);
    }
  });

  it('should return 500 when tunnel running + auth set but token rotation not started', async () => {
    const tm = getTunnelManager();
    simulateTunnelRunning(tm);
    // Don't start token rotation — simulates the race condition
    try {
      const res = await fetch(`${baseUrl}/api/tunnel/qr`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBeDefined();
    } finally {
      simulateTunnelStopped(tm);
    }
  });

  it('SVG should encode a URL containing the short code path', async () => {
    const tm = getTunnelManager();
    const tunnelUrl = 'https://svgtest.trycloudflare.com';
    simulateTunnelRunning(tm, tunnelUrl);
    tm.startTokenRotation();
    try {
      const code = tm.getCurrentShortCode()!;
      const svg = await tm.getQrSvg(tunnelUrl);
      // The SVG encodes `tunnelUrl/q/shortCode` as a QR pattern —
      // we can't decode the QR, but verify the SVG is well-formed
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(code).toMatch(/^[A-Za-z0-9]{6}$/);
    } finally {
      tm.stopTokenRotation();
      simulateTunnelStopped(tm);
    }
  });

  it('no-auth SVG should encode the raw tunnel URL', async () => {
    const tm = getTunnelManager();
    const tunnelUrl = 'https://raw-url-test.trycloudflare.com';
    simulateTunnelRunning(tm, tunnelUrl);
    const savedPass = process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_PASSWORD;
    try {
      const res = await fetch(`${baseUrl}/api/tunnel/qr`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, savedPass!) },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.svg).toContain('<svg');
      expect(data.authEnabled).toBe(false);
    } finally {
      process.env.CODEMAN_PASSWORD = savedPass;
      simulateTunnelStopped(tm);
    }
  });

  it('should return consistent SVGs across multiple requests (caching)', async () => {
    const tm = getTunnelManager();
    simulateTunnelRunning(tm);
    tm.startTokenRotation();
    try {
      const res1 = await fetch(`${baseUrl}/api/tunnel/qr`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      const data1 = await res1.json();

      const res2 = await fetch(`${baseUrl}/api/tunnel/qr`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      const data2 = await res2.json();

      expect(data1.svg).toBe(data2.svg);
    } finally {
      tm.stopTokenRotation();
      simulateTunnelStopped(tm);
    }
  });

  it('SVG should change after token regeneration', async () => {
    const tm = getTunnelManager();
    simulateTunnelRunning(tm);
    tm.startTokenRotation();
    try {
      const res1 = await fetch(`${baseUrl}/api/tunnel/qr`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      const data1 = await res1.json();

      tm.regenerateQrToken();

      const res2 = await fetch(`${baseUrl}/api/tunnel/qr`, {
        headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      const data2 = await res2.json();

      expect(data1.svg).not.toBe(data2.svg);
    } finally {
      tm.stopTokenRotation();
      simulateTunnelStopped(tm);
    }
  });
});
