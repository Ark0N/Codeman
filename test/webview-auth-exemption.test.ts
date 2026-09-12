/**
 * The web-tab proxy is exempt from Codeman's cookie auth and its cross-site Origin
 * guard, because a sandboxed dashboard iframe is opaque-origin: it sends no session
 * cookie and its writes arrive with `Origin: null`. The capability in the path is
 * the credential instead.
 *
 * That exemption is the security-sensitive part of this feature, so these tests pin
 * its EDGES: it must apply to a live capability and to nothing else. A regression
 * here would be an unauthenticated hole into an agent-spawning API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerAuthMiddleware, registerHostGuard, registerSecurityHeaders } from '../src/web/middleware/auth.js';
import { webviewCapabilities } from '../src/webview-capabilities.js';
import type { HostPolicy } from '../src/web/network-auth-policy.js';

const POLICY: HostPolicy = { allowedHosts: [], allowLan: true };
const PASSWORD = 'test-password';

let app: FastifyInstance;
let capability: string;
let savedPassword: string | undefined;

beforeEach(async () => {
  savedPassword = process.env.CODEMAN_PASSWORD;
  // The middleware reads this at registration time; auth is inert without it.
  process.env.CODEMAN_PASSWORD = PASSWORD;

  capability = webviewCapabilities.mint('webview-under-test', undefined);

  app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  // Same order as server.ts (host guard → auth → security headers), so hook
  // interactions are exercised for real. The OPTIONS short-circuit lives in
  // registerSecurityHeaders and is part of what these tests pin.
  registerHostGuard(app, () => POLICY);
  registerAuthMiddleware(app, false);
  registerSecurityHeaders(app, false);

  // Stand-ins for the real surfaces, so a reachable route means auth let it through.
  app.all('/webview/:cap/*', async () => ({ proxied: true }));
  app.all('/api/sessions', async () => ({ sensitive: true }));
  // Parametric on purpose: the exemption's fence has to resolve a CONCRETE url
  // against it, which is precisely what `hasRoute()` cannot do.
  app.all('/api/sessions/:id', async () => ({ sensitive: true }));
  app.all('/q/:token', async () => ({ qr: true }));
  app.get('/', async () => 'app shell');
  app.get('/webviewfoo/bar', async () => 'lookalike');
  // Stand-in for @fastify/static mounted at '/', which is what actually serves
  // /static/app.js in production. It matches EVERY path, so the fence must treat a
  // root catch-all as "no real route" or the Referer form could never apply at all.
  app.get('/*', async () => 'static asset');
  await app.ready();
});

afterEach(async () => {
  await app.close();
  webviewCapabilities.revokeWebview('webview-under-test');
  if (savedPassword === undefined) delete process.env.CODEMAN_PASSWORD;
  else process.env.CODEMAN_PASSWORD = savedPassword;
});

describe('the exemption applies to a live capability', () => {
  it('lets an unauthenticated GET through on the proxy path', async () => {
    const res = await app.inject({ method: 'GET', url: `/webview/${capability}/static/app.js` });
    expect(res.statusCode).toBe(200);
  });

  it('lets a write through despite Origin: null, which a sandboxed iframe always sends', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webview/${capability}/login`,
      headers: { origin: 'null' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('lets a CORS preflight reach the proxy instead of the global 204 short-circuit', async () => {
    // registerSecurityHeaders answers every OPTIONS with a bare 204, which carries
    // no Access-Control-Allow-Origin for the `null` origin a sandboxed frame sends.
    // The proxy must get the chance to answer with real CORS headers, or every
    // dashboard fetch fails its preflight.
    const res = await app.inject({
      method: 'OPTIONS',
      url: `/webview/${capability}/api/stats`,
      headers: { origin: 'null', 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(200); // reached the stand-in route, not the 204 hook
  });

  it('still short-circuits OPTIONS everywhere else', async () => {
    // Authenticated, because the auth hook runs before the security-headers hook
    // and would otherwise 401 first. With credentials the 204 short-circuit is
    // reached, proving it is intact for every non-webview path.
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/sessions',
      headers: {
        origin: 'null',
        'access-control-request-method': 'GET',
        authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a root-absolute asset when the Referer identifies the dashboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/static/app.js',
      headers: { referer: `http://localhost/webview/${capability}/panel` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("covers the dashboard's OWN /api namespace, which no Codeman route claims", async () => {
    // A dashboard serving `<img src="/api/hero?slug=x">` from page script is the
    // case this exists for: the URL is root-absolute, so it lands on Codeman, and
    // nothing here matches a real route. Refusing it by `/api` prefix (as this once
    // did) left dashboard images permanently broken with no way to rescue them.
    for (const url of ['/api/hero?slug=x', '/api/slide?owner=o&n=01', '/api/preview']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { referer: `http://localhost/webview/${capability}/panel` },
      });
      expect(res.statusCode, url).toBe(200);
    }
  });
});

describe('the exemption does NOT widen anywhere else', () => {
  it('rejects an unauthenticated request with no capability at all', async () => {
    expect((await app.inject({ method: 'GET', url: '/static/app.js' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
  });

  it('rejects a well-formed but UNKNOWN capability', async () => {
    const res = await app.inject({ method: 'GET', url: `/webview/${'Z'.repeat(32)}/x` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked capability immediately', async () => {
    webviewCapabilities.revokeWebview('webview-under-test');
    const res = await app.inject({ method: 'GET', url: `/webview/${capability}/x` });
    expect(res.statusCode).toBe(401);
  });

  it('does not match a lookalike prefix', async () => {
    expect((await app.inject({ method: 'GET', url: '/webviewfoo/bar' })).statusCode).toBe(401);
  });

  it('NEVER exempts a real Codeman API route, even with a valid capability in the Referer', async () => {
    // This is the hole the Referer form would open if it were not fenced.
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { referer: `http://localhost/webview/${capability}/panel` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('NEVER exempts a PARAMETRIC API route matched by a concrete url', async () => {
    // The fence has to route `/api/sessions/abc` onto `/api/sessions/:id`. A literal
    // pattern check (`hasRoute`) reports no match here and would hand out an
    // exemption on a live, session-scoped API route.
    for (const url of ['/api/sessions/abc', '/api/sessions/abc?x=1']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { referer: `http://localhost/webview/${capability}/panel` },
      });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('still refuses the websocket namespace outright', async () => {
    // `/q/` is deliberately absent here: QR login is PUBLIC by its own bypass
    // (an unauthenticated device is the entire point), so it can never demonstrate
    // anything about this exemption. The `/q/` guard alongside it is belt-and-braces.
    const res = await app.inject({
      method: 'GET',
      url: '/ws/anything',
      headers: { referer: `http://localhost/webview/${capability}/panel` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not exempt an unrouted /api path without a live capability in the Referer', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/hero?slug=x' })).statusCode).toBe(401);
    const stale = await app.inject({
      method: 'GET',
      url: '/api/hero?slug=x',
      headers: { referer: `http://localhost/webview/${'Z'.repeat(32)}/panel` },
    });
    expect(stale.statusCode).toBe(401);
  });

  it('does not let the Referer form carry a WRITE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/static/app.js',
      headers: { referer: `http://localhost/webview/${capability}/panel`, origin: 'null' },
      payload: {},
    });
    // Blocked as cross-site by the Origin guard, or as unauthenticated. Either is fine;
    // what matters is that it is not 200.
    expect(res.statusCode).not.toBe(200);
  });

  it('still blocks a genuinely cross-site write to the API', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: 'https://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('authenticated access is unaffected', () => {
  const basic = 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64');

  it('normal Basic auth still reaches the app', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { authorization: basic } });
    expect(res.statusCode).toBe(200);
  });

  it('a wrong password is still rejected', async () => {
    const wrong = 'Basic ' + Buffer.from('admin:nope').toString('base64');
    expect((await app.inject({ method: 'GET', url: '/', headers: { authorization: wrong } })).statusCode).toBe(401);
  });
});

/**
 * A web-tab frame that navigated itself off its proxy prefix. The runtime shim
 * masks `/webview/<cap>/` off the document URL so a single-page app routes on its
 * own path; a reload of that page (a dev server's full-reload HMR) then targets
 * Codeman's root with no capability, no cookie (opaque origin) and a Referer that
 * names the masked page. It gets the static recovery page, not a login challenge,
 * and it must not count as an auth failure.
 */
describe('a lost web-tab frame', () => {
  const lostFrame = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', accept: 'text/html,*/*;q=0.8' };

  it('gets the recovery page instead of a 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/about?tab=2', headers: lostFrame });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.body).toContain('codeman:webview-lost');
  });

  it('never for a path Codeman actually serves, and never for a plain navigation', async () => {
    expect((await app.inject({ method: 'GET', url: '/', headers: lostFrame })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/abc', headers: lostFrame })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/about' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/about', headers: { ...lostFrame, 'sec-fetch-dest': 'document' } }))
        .statusCode
    ).toBe(401);
  });

  it('does not count against the auth failure limit', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await app.inject({ method: 'GET', url: `/reload-${i}`, headers: lostFrame })).statusCode).toBe(200);
    }
    // A genuinely unauthenticated request afterwards is still a plain 401, not a 429.
    expect((await app.inject({ method: 'GET', url: '/static/app.js' })).statusCode).toBe(401);
  });
});
