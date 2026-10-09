/**
 * @fileoverview A web-tab frame reloading on its dashboard's landing page, on an
 * install with NO password.
 *
 * The proxy's runtime shim masks `/webview/<cap>/` off the page's URL, and the
 * landing page masks to exactly `/`. A `location.reload()` there (a Vite dev
 * server on a config change) therefore asks for Codeman's own root as an iframe
 * navigation. Without a password no auth hook runs, so the request used to reach
 * the index route and render Codeman's app shell INSIDE the web tab, with no
 * recovery message and the failed-frame panel cleared because the document loaded
 * fine. `test/webview-auth-exemption.test.ts` pins the password form; this boots a
 * real WebServer in test mode for the passwordless one, where the index route
 * itself has to answer.
 *
 * Port: ephemeral
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';

const lostFrame = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', accept: 'text/html,*/*;q=0.8' };

describe('landing-page reload of a proxied dashboard, passwordless install', () => {
  let server: WebServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  beforeAll(async () => {
    server = new WebServer(0);
    await server.start();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app = (server as any).app;
  });
  afterAll(async () => {
    await server.stop();
  });

  it('answers a credential-free iframe navigation of / with the recovery page, not the shell', async () => {
    for (const url of ['/', '/?tab=2']) {
      const res = await app.inject({ method: 'GET', url, headers: lostFrame });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('text/html');
      expect(res.headers['content-security-policy'], url).toContain("default-src 'none'");
      expect(res.headers['cache-control'], url).toBe('no-store');
      expect(res.body, url).toContain('codeman:webview-lost');
      expect(res.body, url).not.toContain('<base href');
    }
  });

  it('still serves the shell to a top-level navigation, and to a framed / that carries credentials', async () => {
    const top = await app.inject({ method: 'GET', url: '/' });
    expect(top.statusCode).toBe(200);
    expect(top.body).toContain('<base href');
    expect(top.body).not.toContain('codeman:webview-lost');
    for (const headers of [
      { ...lostFrame, cookie: 'codeman_session=abc' },
      { ...lostFrame, authorization: 'Basic YWRtaW46eA==' },
      { ...lostFrame, 'sec-fetch-dest': 'document' },
    ]) {
      const res = await app.inject({ method: 'GET', url: '/', headers });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<base href');
    }
  });

  it('keeps answering any other lost path from the 404 handler', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/users', headers: lostFrame });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('codeman:webview-lost');
    // The API-shaped 404 is untouched by the recovery path.
    const api = await app.inject({ method: 'GET', url: '/api/nope', headers: lostFrame });
    expect(api.statusCode).toBe(404);
    expect(JSON.parse(api.body).success).toBe(false);
  });
});
