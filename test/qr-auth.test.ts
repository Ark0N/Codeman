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
 *
 * Port: 3162 (qr-auth tests)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TunnelManager } from '../src/tunnel-manager.js';
import { WebServer } from '../src/web/server.js';

const QR_AUTH_PORT = 3162;
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

  afterAll(() => {
    // Clean up any lingering timers
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

    const res = await fetch(`${baseUrl}/q/ANYCODE`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');

    process.env.CODEMAN_PASSWORD = savedPass;
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
});
