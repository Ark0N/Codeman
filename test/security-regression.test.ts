/**
 * Security regression tests for the 2026-06-09 hardening (v0.9.5).
 *
 * These assert the fixes as WIRED into the running Fastify server — complementing
 * the pure-function coverage in network-host-guard.test.ts. A regression that
 * unwires the guard (or drops a header) would pass the pure-function tests but
 * fail here. Covers:
 *   - Host-header allowlist (anti DNS-rebinding) — onRequest, before routing
 *   - cross-site Origin/CSRF guard on state-changing methods (incl. self-update)
 *   - security response headers (CSP, X-Frame-Options, X-Content-Type-Options; HSTS gated on https)
 *   - text/plain bodies kept RAW (the closed "simple request" CSRF vector)
 *   - WebSocket anti-CSWSH (Origin/Host validated on upgrade → close 4003)
 *
 * Port: ephemeral
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Raw HTTP request with full control over Host/Origin headers (fetch/undici rewrites Host). */
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.boundPort, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Open a WS to `path` with optional Origin and resolve with the close code the server sends. */
function wsCloseCode(path: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.boundPort}${path}`, {
      headers: origin ? { origin } : {},
    });
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error('WS did not close within timeout'));
    }, 8000);
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on('error', () => {
      /* a close frame with the code follows; let the close handler resolve */
    });
  });
}

let server: WebServer;

beforeAll(async () => {
  delete process.env.CODEMAN_PASSWORD; // guard must work even on the no-auth default
  server = new WebServer(0, false, true);
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe('Host-header allowlist (anti DNS-rebinding), wired', () => {
  it('rejects a rebound custom Host with 403', async () => {
    const res = await raw('GET', '/api/status', { Host: 'evil.attacker.example' });
    expect(res.status).toBe(403);
    expect(res.body).toContain('host not allowed');
  });

  it('allows a loopback Host', async () => {
    const res = await raw('GET', '/api/status', { Host: `localhost:${server.boundPort}` });
    expect(res.status).toBe(200);
  });

  it('allows an IP-literal Host (default when none specified)', async () => {
    const res = await raw('GET', '/api/status');
    expect(res.status).toBe(200);
  });
});

describe('cross-site Origin / CSRF guard, wired', () => {
  // Probe a non-existent route: the onRequest guard runs BEFORE routing, so a blocked
  // request 403s while an allowed one falls through to 404 — no side effects either way.
  const PROBE = '/api/__csrf_probe__';

  it('blocks a state-changing request from a foreign Origin with 403', async () => {
    const res = await raw('POST', PROBE, { Origin: 'https://evil.attacker.example' });
    expect(res.status).toBe(403);
    expect(res.body).toContain('cross-site request blocked');
  });

  it('allows a state-changing request with NO Origin (curl / CLI / hooks)', async () => {
    const res = await raw('POST', PROBE);
    expect(res.status).not.toBe(403); // 404 (route not found) — guard let it through
  });

  it('allows a state-changing request from a same-site Origin', async () => {
    const res = await raw('POST', PROBE, { Origin: `http://localhost:${server.boundPort}` });
    expect(res.status).not.toBe(403);
  });

  it('does NOT block safe methods (GET) from a foreign Origin', async () => {
    const res = await raw('GET', '/api/status', { Origin: 'https://evil.attacker.example' });
    expect(res.status).toBe(200);
  });

  it('blocks the self-update route (POST /api/system/update) from a foreign Origin', async () => {
    const res = await raw('POST', '/api/system/update', { Origin: 'https://evil.attacker.example' });
    expect(res.status).toBe(403);
    expect(res.body).toContain('cross-site request blocked');
  });
});

describe('security response headers, wired', () => {
  it('sets CSP, X-Frame-Options, and X-Content-Type-Options', async () => {
    const res = await raw('GET', '/api/status');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does NOT set HSTS over plain http (it is gated on https)', async () => {
    const res = await raw('GET', '/api/status');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('text/plain bodies are kept raw (closed simple-request CSRF vector)', () => {
  it('does not auto-JSON-parse a text/plain body into a JSON route', async () => {
    // Same-site (no Origin) so the CSRF guard allows it; the body is valid JSON but
    // arrives as a raw STRING, so the JSON schema validation must reject it.
    const res = await raw('POST', '/api/sessions', { 'Content-Type': 'text/plain' }, '{"workingDir":"/tmp"}');
    expect(res.status).not.toBe(200); // not parsed as an object → validation error, no session created
    expect(res.status).toBe(400);
  });
});

describe('WebSocket anti-CSWSH', () => {
  it('closes a WS upgrade from a foreign Origin with code 4003', async () => {
    const code = await wsCloseCode('/ws/sessions/nonexistent/terminal', 'https://evil.attacker.example');
    expect(code).toBe(4003);
  });

  it('passes the Origin check with no Origin (then closes 4004 for the unknown session)', async () => {
    const code = await wsCloseCode('/ws/sessions/nonexistent/terminal');
    expect(code).toBe(4004); // reached the session lookup → origin check passed
  });
});
