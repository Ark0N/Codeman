/**
 * @fileoverview Server wiring for the reverse-proxy base path (#381): prefixed and
 * unprefixed forms both route, the shell gets the base injected, root-absolute
 * redirects are rebased without double-prefixing, and a WebSocket upgrade under the
 * prefix reaches the terminal route. The pure helpers are covered by
 * test/base-path.test.ts; this boots a real WebServer in test mode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';

describe('reverse-proxy base path: server wiring', () => {
  let server: WebServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  beforeAll(async () => {
    server = new WebServer(0, false, true, '127.0.0.1', undefined, false, '/codeman');
    await server.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app = (server as any).app;
  });
  afterAll(async () => {
    await server.stop();
  });

  it('routes prefixed, unprefixed and /api/v1 forms', async () => {
    for (const url of ['/codeman/api/status', '/api/status', '/codeman/api/v1/status']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(JSON.parse(r.body).success).toBe(true);
    }
  });

  it('serves the shell with the base injected at /codeman, /codeman/ and /codeman/session/:id', async () => {
    for (const url of ['/codeman', '/codeman/', '/codeman/session/abc']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toContain('<base href="/codeman/">');
      expect(r.body).toContain('window.__CODEMAN_BASE__="/codeman"');
    }
  });

  it('serves sw.js under the prefix', async () => {
    const r = await app.inject({ method: 'GET', url: '/codeman/sw.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('javascript');
  });

  it('rebases root-absolute redirects and never double-prefixes', async () => {
    const qr = await app.inject({ method: 'GET', url: '/codeman/q/abcdef' });
    expect(qr.statusCode).toBe(302);
    expect(qr.headers.location).toBe('/codeman/');
    const wv = await app.inject({ method: 'GET', url: '/codeman/webview/somecap' });
    expect(wv.statusCode).toBe(302);
    expect(wv.headers.location).toBe('/codeman/webview/somecap/');
  });

  it('unknown prefixed API path still gets the 404 envelope', async () => {
    const r = await app.inject({ method: 'GET', url: '/codeman/api/nope' });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).success).toBe(false);
  });

  it('routes a prefixed WebSocket upgrade to the terminal route', async () => {
    const { WebSocket } = await import('ws');
    const close = (path: string) =>
      new Promise<{ code: number; reason: string }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.boundPort}${path}`, {
          headers: { origin: `http://127.0.0.1:${server.boundPort}` },
        });
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on('error', (e) => resolve({ code: -1, reason: String(e) }));
      });
    const prefixed = await close('/codeman/ws/sessions/nosuch/terminal');
    const bare = await close('/ws/sessions/nosuch/terminal');
    expect(prefixed).toEqual({ code: 4004, reason: 'Session not found' });
    expect(prefixed).toEqual(bare);
  });
});
