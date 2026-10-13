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
import { htmlViewCapabilities } from '../src/html-view-capabilities.js';
import type { HostPolicy } from '../src/web/network-auth-policy.js';

const POLICY: HostPolicy = { allowedHosts: [], allowLan: true };
const PASSWORD = 'test-password';

let app: FastifyInstance;
let capability: string;
let htmlCapability: string;
let savedPassword: string | undefined;

beforeEach(async () => {
  savedPassword = process.env.CODEMAN_PASSWORD;
  // The middleware reads this at registration time; auth is inert without it.
  process.env.CODEMAN_PASSWORD = PASSWORD;

  capability = webviewCapabilities.mint('webview-under-test', undefined);
  htmlCapability = htmlViewCapabilities.mint('/srv/report-under-test', undefined);

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
  app.all('/html-view/:cap/*', async () => ({ page: true }));
  app.all('/html-viewx/*', async () => 'lookalike');
  // Stand-in for @fastify/static mounted at '/', which is what actually serves
  // /static/app.js in production. It matches EVERY path, so the fence must treat a
  // root catch-all as "no real route" or the Referer form could never apply at all.
  app.get('/*', async () => 'static asset');
  await app.ready();
});

afterEach(async () => {
  await app.close();
  webviewCapabilities.revokeWebview('webview-under-test');
  htmlViewCapabilities.revokeOwner(undefined);
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
    expect((await app.inject({ method: 'GET', url: '/webviewfoo/bar', headers: lostFrame })).statusCode).toBe(401);
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

  /**
   * The landing page. The shim maps `/webview/<cap>/` to exactly `/`, so a reload
   * there asks for Codeman's ROOT as an iframe navigation, and `/` is a registered
   * route (the app shell), which the route-table fence cannot tell from a real
   * navigation. It used to answer 401 inside the frame (or the shell itself on a
   * passwordless install), with no recovery message and the failed-frame panel
   * cleared because the document loaded fine. Credentials are the separator:
   * nothing in Codeman frames its own root, and the sandboxed frame carries none.
   */
  describe('a reload on the dashboard landing page', () => {
    it('gets the recovery page when the iframe navigation of / carries no credentials', async () => {
      for (const url of ['/', '/?tab=2']) {
        const res = await app.inject({ method: 'GET', url, headers: lostFrame });
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toContain('codeman:webview-lost');
        expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      }
    });

    it('is the shell, or the usual 401, once a session cookie or Authorization header is present', async () => {
      const ok = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`;
      const shell = await app.inject({ method: 'GET', url: '/', headers: { ...lostFrame, authorization: ok } });
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toBe('app shell');
      const wrong = `Basic ${Buffer.from('admin:nope').toString('base64')}`;
      expect(
        (await app.inject({ method: 'GET', url: '/', headers: { ...lostFrame, authorization: wrong } })).statusCode
      ).toBe(401);
      const cookie = 'codeman_session=stale; other=1';
      expect((await app.inject({ method: 'GET', url: '/', headers: { ...lostFrame, cookie } })).statusCode).toBe(401);
    });

    it('is still a 401 for a top-level navigation of /, and for a frame asking for JSON', async () => {
      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/', headers: { ...lostFrame, 'sec-fetch-dest': 'document' } }))
          .statusCode
      ).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/', headers: { ...lostFrame, accept: 'application/json' } }))
          .statusCode
      ).toBe(401);
    });
  });
});

// The rendered-HTML route (/html-view/<cap>/...) has its own, narrower exemption:
// read-only, capability in the path only, no Referer form.
describe('the html-view exemption', () => {
  it('lets an unauthenticated GET and HEAD through with a live capability', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await app.inject({ method, url: `/html-view/${htmlCapability}/index.html` });
      expect(res.statusCode, method).toBe(200);
    }
  });

  it('never exempts a write on the capability path', async () => {
    for (const method of ['POST', 'PUT'] as const) {
      const res = await app.inject({ method, url: `/html-view/${htmlCapability}/index.html`, payload: {} });
      expect(res.statusCode, method).toBe(401);
    }
  });

  it('rejects an unknown capability', async () => {
    const res = await app.inject({ method: 'GET', url: '/html-view/AAAAAAAAAAAAAAAAAAAAAAAA/index.html' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked capability immediately', async () => {
    htmlViewCapabilities.revokeOwner(undefined);
    const res = await app.inject({ method: 'GET', url: `/html-view/${htmlCapability}/index.html` });
    expect(res.statusCode).toBe(401);
  });

  it('does not match a lookalike prefix', async () => {
    const res = await app.inject({ method: 'GET', url: `/html-viewx/${htmlCapability}/index.html` });
    expect(res.statusCode).toBe(401);
  });

  it('is not a web-tab capability, and a web-tab capability is not an html-view one', async () => {
    expect((await app.inject({ method: 'GET', url: `/webview/${htmlCapability}/x` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/html-view/${capability}/x.html` })).statusCode).toBe(401);
  });
});
