/**
 * @fileoverview Authentication and security middleware.
 *
 * Extracted from server.ts setupRoutes() — handles:
 * - HTTP Basic Auth with session cookies
 * - Rate limiting (per-IP failure tracking)
 * - Security headers (CSP, X-Frame-Options, HSTS)
 * - CORS (localhost only)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StaleExpirationMap } from '../../utils/index.js';
import type { AuthSessionRecord } from '../ports/auth-port.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import {
  AUTH_SESSION_TTL_MS,
  MAX_AUTH_SESSIONS,
  AUTH_FAILURE_MAX,
  AUTH_FAILURE_WINDOW_MS,
} from '../../config/auth-config.js';
import { getHookSecret, HOOK_SECRET_HEADER } from '../../config/hook-secret.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { findUser, setPassword, touchLastLogin, verifyPassword } from '../../user-store.js';
import { webviewCapabilities } from '../../webview-capabilities.js';
import {
  capabilityFromProxyPath,
  capabilityFromReferer,
  isLostWebviewFrameNavigation,
  lostWebviewFramePage,
  LOST_FRAME_PAGE_CSP,
} from '../webview-proxy.js';
import { ApiErrorCode, createErrorResponse, type AuthUser } from '../../types.js';

// Request-scoped identity (multi-user). Single-user leaves it undefined and the
// ownership helpers default to a synthetic admin (see route-helpers).
declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

// Auth session cookie name
export const AUTH_COOKIE_NAME = 'codeman_session';

/** State returned from registerAuthMiddleware for cleanup in server stop() */
interface AuthState {
  authSessions: StaleExpirationMap<string, AuthSessionRecord> | null;
  authFailures: StaleExpirationMap<string, number> | null;
  qrAuthFailures: StaleExpirationMap<string, number> | null;
  hookSecretFailures: StaleExpirationMap<string, number> | null;
  /** Per-username Basic-auth failure bucket (multi-user only). */
  userFailures: StaleExpirationMap<string, number> | null;
}

/** Rate-limit response for a client that exceeded the failure cap. */
function sendAuthRateLimit(reply: FastifyReply, failures: StaleExpirationMap<string, number>, key: string): void {
  const remainingMs = failures.getRemainingTtl(key) ?? AUTH_FAILURE_WINDOW_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  reply.header('Retry-After', String(retryAfterSeconds));
  reply.code(429).send('Too Many Requests — try again later');
}

/** Parse a `Basic base64(user:pass)` header into its parts, or null if malformed. */
function parseBasicAuth(header?: string): { username: string; password: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/**
 * The `/api/hook-event` + `/api/status-telemetry` localhost bypass, shared by the
 * single-user and multi-user auth hooks so the security-critical logic has ONE
 * source of truth. Returns:
 *  - 'bypass'   : loopback + valid hook secret; the caller should allow the request
 *  - 'rejected' : a reply was already sent (wrong secret rate-limited / 401)
 *  - 'continue' : not a hook request (or non-loopback); fall through to normal auth
 *
 * COD-91: the shared hook secret is required UNCONDITIONALLY on the loopback bypass
 * (a user's own loopback reverse proxy is indistinguishable from a real local hook).
 */
function checkHookSecretBypass(
  req: FastifyRequest,
  reply: FastifyReply,
  hookSecretFailures: StaleExpirationMap<string, number>
): 'bypass' | 'rejected' | 'continue' {
  if ((req.url === '/api/hook-event' || req.url === '/api/status-telemetry') && req.method === 'POST') {
    const ip = req.ip;
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (isLoopback) {
      const presented = Buffer.from(req.headers[HOOK_SECRET_HEADER.toLowerCase()]?.toString() ?? '');
      const expected = Buffer.from(getHookSecret());
      if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
        return 'bypass';
      }
      const hookIp = req.ip;
      const hookFailures = hookSecretFailures.get(hookIp) ?? 0;
      if (hookFailures >= AUTH_FAILURE_MAX) {
        sendAuthRateLimit(reply, hookSecretFailures, hookIp);
        return 'rejected';
      }
      hookSecretFailures.set(hookIp, hookFailures + 1);
      reply.code(401).send('Unauthorized: hook secret required');
      return 'rejected';
    }
    // Non-localhost hook requests fall through to normal auth
  }
  return 'continue';
}

/**
 * Requests that a `mustChangePassword` user may still reach: the identity probe,
 * the password-change endpoint, and any non-API path (static assets / index.html,
 * so the browser can load the app and render the change-password modal).
 */
function isPasswordChangeExempt(req: FastifyRequest): boolean {
  const url = (req.url ?? '').split('?')[0];
  if (url === '/api/me' || url === '/api/me/password') return true;
  // Security: the WebSocket terminal (/ws/...) is a functional channel, not a static
  // asset, so it must NOT be exempt, or a locked user keeps a working terminal.
  if (url.startsWith('/ws/')) return false;
  return !url.startsWith('/api/');
}

/**
 * Whether this request carries a VALID web-tab proxy capability.
 *
 * Requests under `/webview/<cap>/` cannot authenticate the normal way. The iframe
 * rendering a dashboard is sandboxed without `allow-same-origin`, so it runs in an
 * opaque origin: every request it makes is cross-site, meaning the `SameSite=lax`
 * `codeman_session` cookie is never attached, and non-GET requests and WebSocket
 * upgrades arrive with `Origin: null`. Both the cookie check and the CSRF Origin
 * guard would therefore reject a perfectly legitimate dashboard asset load.
 *
 * The capability in the path is the credential instead: 192 bits of entropy, held
 * in memory only (a restart invalidates it), rolling TTL, bound to the user who
 * minted it through an already-authenticated `POST /api/webviews/:id/open`, and
 * granting nothing but "relay bytes to this one saved URL".
 *
 * The exemption is deliberately narrow: it requires the capability to RESOLVE, so
 * a bare `/webview/anything` reaches nothing, and a `/webviewfoo` path does not
 * match the prefix at all. The Host allowlist is NOT bypassed, so DNS-rebinding
 * protection still applies to these requests.
 */
function hasValidWebviewCapability(req: FastifyRequest, basePath = ''): boolean {
  // req.url is already base-stripped by the server's rewriteUrl, so the path form
  // needs no base; the Referer form below is browser-supplied and does.
  const url = (req.url ?? '').split('?')[0];

  const fromPath = capabilityFromProxyPath(url);
  if (fromPath) return webviewCapabilities.resolve(fromPath) !== undefined;

  // Referer form: a dashboard subresource requested with a ROOT-ABSOLUTE URL, which
  // lands on Codeman's root and is relayed by the 404 fallback. Without this the
  // asset would be rejected here, before the fallback ever runs.
  //
  // This is the only exemption decided by a header the request itself supplies, so
  // it is fenced in hard: safe methods only, and never for Codeman's own functional
  // surfaces. Without those fences a page could present a webview Referer and skip
  // auth on /api. It is not a privilege escalation even so, holding a live
  // capability already implies an authenticated `POST /api/webviews/:id/open`, but
  // the exemption should stay no wider than the problem it solves.
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.startsWith('/ws/') || url.startsWith('/q/')) return false;
  // Anything that resolves to a REAL Codeman route is refused, which is the fence
  // that keeps this from being an auth bypass. `/api/` used to be refused by prefix
  // instead, but dashboards legitimately serve assets from their own `/api/...`
  // namespace (`<img src="/api/hero?slug=x">`), and those requests were the one
  // class the 404 relay could never rescue. See matchesRegisteredRoute.
  if (matchesRegisteredRoute(req, url)) return false;

  const fromReferer = capabilityFromReferer(
    typeof req.headers.referer === 'string' ? req.headers.referer : undefined,
    basePath
  );
  return !!fromReferer && webviewCapabilities.resolve(fromReferer) !== undefined;
}

/**
 * A web-tab frame that navigated itself off the proxy prefix (see
 * isLostWebviewFrameNavigation). It cannot authenticate: opaque origin, no cookie,
 * no capability left in the URL. Answer with the static recovery page here, BEFORE
 * the credential checks, so the reload of a proxied dashboard neither shows a
 * login challenge inside the tab nor counts as a failed attempt against the
 * caller's IP — a dev server that full-reloads on every save would otherwise
 * rate-limit its own user out of Codeman. Fenced like the Referer exemption: a
 * path that resolves to a real route (the app shell, /api, /q) is never answered
 * this way, so a genuine unauthenticated navigation still gets the 401.
 *
 * @returns true when the reply was sent.
 */
function serveLostWebviewFrame(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!isLostWebviewFrameNavigation(req)) return false;
  const url = (req.url ?? '').split('?')[0];
  if (url === '/' || url.startsWith('/api/') || url.startsWith('/ws/') || url.startsWith('/q/')) return false;
  if (matchesRegisteredRoute(req, url)) return false;
  reply.header('content-security-policy', LOST_FRAME_PAGE_CSP);
  reply.header('cache-control', 'no-store');
  reply.type('text/html; charset=utf-8').send(lostWebviewFramePage());
  return true;
}

/**
 * Whether `url` resolves to a route Codeman actually registered.
 *
 * `hasRoute()` is the wrong tool: it matches the registered PATTERN literally, so
 * `/api/sessions/abc` reports false against a registered `/api/sessions/:id` and
 * would hand out an exemption on a live API route. `findRoute()` performs the real
 * radix-tree lookup and fills in `params`, which is what this needs.
 *
 * The one complication is `@fastify/static`, mounted at `/`, which registers a
 * root-level catch-all that matches EVERY path. A match on that means "no real
 * route, this is heading for the 404 handler", and it is distinguishable because a
 * root catch-all is the only route whose `*` param comes back equal to the entire
 * request path. `test/webview-auth-exemption.test.ts` pins both halves of that.
 *
 * Fails CLOSED: anything unexpected counts as a real route, which merely denies the
 * exemption and restores the previous behavior.
 */
function matchesRegisteredRoute(req: FastifyRequest, url: string): boolean {
  try {
    const found = req.server.findRoute({ method: req.method as 'GET' | 'HEAD', url });
    if (!found) return false;
    const params = found.params ?? {};
    const keys = Object.keys(params);
    const isRootCatchAll = keys.length === 1 && keys[0] === '*' && `/${params['*']}` === url;
    return !isRootCatchAll;
  } catch {
    return true;
  }
}

/**
 * Register HTTP Basic Auth middleware with session cookies and rate limiting.
 * Only active when CODEMAN_PASSWORD is set.
 *
 * The `/api/hook-event` + `/api/status-telemetry` localhost bypass requires the
 * shared hook secret unconditionally (COD-91) — see the onRequest hook below.
 *
 * @returns AuthState for lifecycle management (dispose on server stop)
 */
export function registerAuthMiddleware(app: FastifyInstance, https: boolean, basePath = ''): AuthState {
  const state: AuthState = {
    authSessions: null,
    authFailures: null,
    qrAuthFailures: null,
    hookSecretFailures: null,
    userFailures: null,
  };

  // Always declare req.authUser so downstream reads are safe (single-user leaves it
  // undefined; the ownership helpers then default to a synthetic admin).
  if (!app.hasRequestDecorator('authUser')) app.decorateRequest('authUser', undefined);

  const multiUser = isMultiUserMode();
  const authPassword = process.env.CODEMAN_PASSWORD;

  // No auth at all: single-user with no password (byte-identical to legacy). In
  // multi-user mode auth is ALWAYS active (users authenticate individually), even
  // without CODEMAN_PASSWORD.
  if (!multiUser && !authPassword) return state;

  // Session token store — active sessions extend TTL on access
  state.authSessions = new StaleExpirationMap<string, AuthSessionRecord>({
    ttlMs: AUTH_SESSION_TTL_MS,
    refreshOnGet: true,
  });

  // Failure counter per IP — decay naturally after 15 minutes
  state.authFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  // Separate QR auth failure counter — independent from Basic Auth failures
  state.qrAuthFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  // Separate hook-secret failure counter (COD-54). MUST NOT share authFailures:
  // legacy (pre-secret) hook configs fire constantly from 127.0.0.1, and counting
  // their 401s against the shared bucket would 429 every cookie-less request from
  // loopback — locking out the Basic-Auth login path (and, through a tunnel, every
  // client, since tunneled traffic also arrives as 127.0.0.1).
  state.hookSecretFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  const authSessions = state.authSessions;
  const authFailures = state.authFailures;
  const hookSecretFailures = state.hookSecretFailures;

  if (multiUser) {
    // Per-username failure bucket: a botnet can't brute-force one account across
    // many IPs, and one user behind a NAT can't lock out everyone else.
    state.userFailures = new StaleExpirationMap<string, number>({
      ttlMs: AUTH_FAILURE_WINDOW_MS,
      refreshOnGet: false,
    });
    registerMultiUserAuthHook(app, https, authSessions, authFailures, hookSecretFailures, state.userFailures, basePath);
    return state;
  }

  // ── Single-user Basic Auth (unchanged behavior; CODEMAN_PASSWORD required) ──
  const authUsername = process.env.CODEMAN_USERNAME || 'admin';
  const expectedHeader = 'Basic ' + Buffer.from(`${authUsername}:${authPassword}`).toString('base64');

  app.addHook('onRequest', (req, reply, done) => {
    const bypass = checkHookSecretBypass(req, reply, hookSecretFailures);
    if (bypass === 'bypass') {
      done();
      return;
    }
    if (bypass === 'rejected') return;

    // QR auth path — handled by the route itself (token validation + rate limiting)
    if (req.url?.startsWith('/q/')) {
      done();
      return;
    }

    // Web-tab proxy, authenticated by the capability in the path, not the cookie.
    if (hasValidWebviewCapability(req, basePath)) {
      done();
      return;
    }
    // A web-tab frame that lost its prefix: hand it back to its tab, no credentials involved.
    if (serveLostWebviewFrame(req, reply)) return;

    const clientIp = req.ip;

    // Check session cookie first (avoids re-sending credentials on every request)
    // Use get() instead of has() so refreshOnGet extends the TTL on active sessions
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken && authSessions.get(sessionToken) !== undefined) {
      // Sliding cookie: re-issue on every authenticated request so the browser
      // cookie lifetime tracks the server-side sliding TTL (refreshOnGet above).
      reply.setCookie(AUTH_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        maxAge: AUTH_SESSION_TTL_MS / 1000, // seconds
        path: '/',
      });
      done();
      return;
    }

    // Check Basic Auth header (timing-safe comparison to prevent side-channel attacks)
    const auth = req.headers.authorization;
    const authBuf = Buffer.from(auth ?? '');
    const expectedBuf = Buffer.from(expectedHeader);
    if (authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf)) {
      // Issue session token cookie so browser doesn't need to re-send credentials
      const token = randomBytes(32).toString('hex');

      // Evict oldest if at capacity (prevent unbounded growth)
      if (authSessions.size >= MAX_AUTH_SESSIONS) {
        const oldestKey = authSessions.keys().next().value;
        if (oldestKey !== undefined) authSessions.delete(oldestKey);
      }

      authSessions.set(token, {
        ip: clientIp,
        ua: req.headers['user-agent'] ?? '',
        createdAt: Date.now(),
        method: 'basic',
      });

      // Reset failure count on successful auth
      authFailures.delete(clientIp);

      reply.setCookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        maxAge: AUTH_SESSION_TTL_MS / 1000, // seconds
        path: '/',
      });
      done();
      return;
    }

    // Rate limit only requests that failed to authenticate on this attempt.
    const failures = authFailures.get(clientIp) ?? 0;
    if (failures >= AUTH_FAILURE_MAX) {
      sendAuthRateLimit(reply, authFailures, clientIp);
      return;
    }

    // Auth failed — track failure count
    authFailures.set(clientIp, failures + 1);

    reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
    reply.code(401).send('Unauthorized');
  });

  return state;
}

/**
 * Multi-user auth hook (async, because password verification runs scrypt). Verifies
 * `username:password` against the user store, mints an identity-carrying cookie,
 * decorates `req.authUser`, enforces the per-IP + per-username rate limits, and the
 * `mustChangePassword` lockbox. The single-user hook above is left untouched.
 */
function registerMultiUserAuthHook(
  app: FastifyInstance,
  https: boolean,
  authSessions: StaleExpirationMap<string, AuthSessionRecord>,
  authFailures: StaleExpirationMap<string, number>,
  hookSecretFailures: StaleExpirationMap<string, number>,
  userFailures: StaleExpirationMap<string, number>,
  basePath = ''
): void {
  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: https,
      sameSite: 'lax',
      maxAge: AUTH_SESSION_TTL_MS / 1000,
      path: '/',
    });

  // Evict the oldest cookie session of the SAME user first (so one user logging in
  // 100 times cannot flush everyone else's sessions), falling back to global-oldest.
  const evictForCapacity = (username: string) => {
    let userKey: string | undefined;
    let userTs = Infinity;
    let globalKey: string | undefined;
    let globalTs = Infinity;
    for (const [k, v] of authSessions) {
      if (v.createdAt < globalTs) {
        globalTs = v.createdAt;
        globalKey = k;
      }
      if (v.username === username && v.createdAt < userTs) {
        userTs = v.createdAt;
        userKey = k;
      }
    }
    const key = userKey ?? globalKey;
    if (key !== undefined) authSessions.delete(key);
  };

  const enforcePasswordChange = (req: FastifyRequest, reply: FastifyReply, mustChange: boolean): boolean => {
    if (mustChange && !isPasswordChangeExempt(req)) {
      reply.code(403).send(createErrorResponse(ApiErrorCode.PASSWORD_CHANGE_REQUIRED));
      return true;
    }
    return false;
  };

  app.addHook('onRequest', async (req, reply) => {
    const bypass = checkHookSecretBypass(req, reply, hookSecretFailures);
    if (bypass === 'bypass' || bypass === 'rejected') return;

    // QR redemption path — handled by the route itself.
    if (req.url?.startsWith('/q/')) return;

    // Web-tab proxy, authenticated by the capability in the path, not the cookie.
    // `req.authUser` stays undefined here on purpose: the proxy handler enforces
    // ownership against the identity BOUND TO THE CAPABILITY, which is stricter
    // than re-deriving it from a request that carries no credentials.
    if (hasValidWebviewCapability(req, basePath)) return;
    // A web-tab frame that lost its prefix: hand it back to its tab, no credentials involved.
    if (serveLostWebviewFrame(req, reply)) return;

    const clientIp = req.ip;

    // 1. Cookie session (carries identity + mustChangePassword snapshot).
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    const record = sessionToken ? authSessions.get(sessionToken) : undefined;
    if (record && record.username) {
      // Security: re-validate the cookie identity against the store on every request so
      // an out-of-band mutation the in-memory map can't see (the `codeman users` CLI,
      // a separate process, deleting/disabling/demoting a user) takes effect promptly
      // instead of riding the 24h cookie. findUser is cached ~1s, so this is cheap.
      let live: Awaited<ReturnType<typeof findUser>>;
      try {
        live = await findUser(record.username);
      } catch {
        // The store is transiently unreadable/corrupt (readUsers throws on a non-ENOENT
        // read, #23). Fall back to the cookie's snapshot for THIS request rather than
        // 500-ing an already-authenticated client (pre-#24 behaviour); a persistently
        // corrupt store still fails all WRITES loudly at the mutator/bootstrap layer.
        req.authUser = { username: record.username, role: record.role ?? 'user' };
        setSessionCookie(reply, sessionToken!);
        enforcePasswordChange(req, reply, !!record.mustChangePassword);
        return;
      }
      if (!live || live.disabled) {
        authSessions.delete(sessionToken!);
        reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
        reply.code(401).send('Unauthorized');
        return;
      }
      // Trust the LIVE role/mustChangePassword, not the (possibly stale) cookie snapshot
      // (also defends #9/#13: a CLI demotion is reflected without a revoke).
      req.authUser = { username: live.username, role: live.role };
      setSessionCookie(reply, sessionToken!); // sliding re-issue
      enforcePasswordChange(req, reply, !!live.mustChangePassword);
      return;
    }

    // 2. Basic Auth against the user store (scrypt verify).
    // Per-IP pre-gate bounds scrypt CPU cost from one source (does NOT gate on the
    // per-username bucket here; see below).
    const ipFail = authFailures.get(clientIp) ?? 0;
    if (ipFail >= AUTH_FAILURE_MAX) {
      sendAuthRateLimit(reply, authFailures, clientIp);
      return;
    }
    const creds = parseBasicAuth(req.headers.authorization);
    if (creds) {
      const normUser = creds.username.trim().toLowerCase();
      // Security: VERIFY FIRST, then throttle only FAILED attempts. Consulting the
      // per-username bucket before verifying let throwaway IPs lock out a known account
      // (incl. admin) even with the correct password. A correct password must always
      // win and self-heal both buckets, regardless of the username-failure count.
      const result = await verifyPassword(creds.username, creds.password);
      if (result) {
        const { user, needsRehash: rehash } = result;
        if (rehash) void setPassword(user.username, creds.password).catch(() => {});
        void touchLastLogin(user.username).catch(() => {});
        authFailures.delete(clientIp);
        userFailures.delete(normUser);

        const token = randomBytes(32).toString('hex');
        if (authSessions.size >= MAX_AUTH_SESSIONS) evictForCapacity(user.username);
        authSessions.set(token, {
          ip: clientIp,
          ua: req.headers['user-agent'] ?? '',
          createdAt: Date.now(),
          method: 'basic',
          username: user.username,
          role: user.role,
          mustChangePassword: !!user.mustChangePassword,
        });
        req.authUser = { username: user.username, role: user.role };
        setSessionCookie(reply, token);
        enforcePasswordChange(req, reply, !!user.mustChangePassword);
        return;
      }
      // Failed guess: count it against BOTH buckets. Once the per-username bucket
      // reaches the cap, further FAILED attempts get 429 (throttles distributed
      // brute-force), but this path is only reached on a wrong password, so it can
      // never deny a correct one.
      const uFail = (userFailures.get(normUser) ?? 0) + 1;
      userFailures.set(normUser, uFail);
      authFailures.set(clientIp, ipFail + 1);
      if (uFail >= AUTH_FAILURE_MAX) {
        sendAuthRateLimit(reply, userFailures, normUser);
        return;
      }
      reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
      reply.code(401).send('Unauthorized');
      return;
    }

    // No credentials presented: count against the per-IP bucket and challenge.
    authFailures.set(clientIp, ipFail + 1);
    reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
    reply.code(401).send('Unauthorized');
  });
}

/** Methods that don't change server state and so skip the cross-site Origin check. */
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Register the anti-DNS-rebinding Host allowlist + cross-site (CSRF) Origin guard.
 *
 * This protects the API even on the default no-password install, where there is no
 * cookie/credential to gate on. It must be registered BEFORE the auth middleware so
 * forged cross-site or DNS-rebound requests are rejected up front. `getPolicy` is
 * evaluated per request so a tunnel started at runtime is reflected immediately.
 *
 * - Every request: the `Host` header must be in the allowlist (blocks DNS rebinding,
 *   where a custom domain is rebound to 127.0.0.1 but still sends its own name).
 * - State-changing methods: the `Origin` (when the client sends one — i.e. a browser)
 *   must be same-site (blocks cross-site CSRF, including the text/plain simple-request
 *   trick). Non-browser clients (curl, Claude Code hooks) omit Origin and pass.
 *
 * WebSocket upgrades are validated separately in the ws route handler.
 */
export function registerHostGuard(app: FastifyInstance, getPolicy: () => HostPolicy, basePath = ''): void {
  app.addHook('onRequest', (req, reply, done) => {
    const policy = getPolicy();
    if (!isAllowedRequestHost(req.headers.host, policy)) {
      reply.code(403).send('Forbidden: host not allowed');
      return;
    }
    // The Host allowlist above is NEVER bypassed. The Origin (CSRF) check is,
    // but only for a request carrying a valid web-tab capability: a sandboxed
    // dashboard is opaque-origin, so its form posts and uploads arrive with
    // `Origin: null`, which this guard rejects by design. The capability is the
    // credential in that case, and it is unguessable, see
    // hasValidWebviewCapability.
    if (
      !SAFE_HTTP_METHODS.has(req.method) &&
      !isAllowedRequestOrigin(req.headers.origin, policy) &&
      !hasValidWebviewCapability(req, basePath)
    ) {
      reply.code(403).send('Forbidden: cross-site request blocked');
      return;
    }
    done();
  });
}

/**
 * Register security headers and CORS middleware on every response.
 */
export function registerSecurityHeaders(app: FastifyInstance, https: boolean, basePath = ''): void {
  // Gesture-control overlay (opt-in via CODEMAN_GESTURE=1) runs MediaPipe, which
  // needs WebAssembly eval (script-src) and blob workers (worker-src). Its wasm
  // runtime + model are self-hosted under /gesture/ (same-origin, covered by
  // 'self'), so no CDN connect-src entries are needed. OFF by default so the
  // production CSP is byte-for-byte unchanged.
  const gesture = process.env.CODEMAN_GESTURE === '1';
  const scriptSrc =
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net" + (gesture ? " 'wasm-unsafe-eval'" : '');
  const connectSrc = "connect-src 'self' wss://api.deepgram.com";
  // blob: workers are needed unconditionally: terminal-ui's _safeYield tick
  // worker (throttling escape) is created from a Blob URL. Without this, every
  // page load logs a CSP violation and the worker leg of _safeYield is dead.
  // Risk is minimal — only same-origin scripts (already governed by script-src)
  // can construct blob workers.
  const workerSrc = "; worker-src 'self' blob:";
  const csp =
    `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; ` +
    `img-src 'self' data: blob:; ${connectSrc}; font-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'self'${workerSrc}`;

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Content-Security-Policy', csp);
    if (https) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // CORS: restrict to same-origin (localhost) only
    const origin = req.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
          reply.header('Access-Control-Allow-Origin', origin);
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          reply.header('Access-Control-Max-Age', '86400');
        }
      } catch {
        // Invalid origin header — do not set CORS headers
      }
    }

    // Handle CORS preflight.
    //
    // EXCEPT for the web-tab proxy, which must answer its own preflight. A
    // sandboxed dashboard iframe is opaque-origin, so it sends `Origin: null`;
    // the CORS block above only emits headers for localhost origins, so a bare
    // 204 from here carries no `Access-Control-Allow-Origin` and the browser
    // rejects the preflight. Every dashboard fetch then fails with an opaque
    // net::ERR_FAILED while the page itself renders fine (script/css/img loads
    // are not CORS-checked). Falling through lets the proxy route reply with the
    // right headers.
    if (req.method === 'OPTIONS' && !hasValidWebviewCapability(req, basePath)) {
      reply.code(204).send();
      done();
      return;
    }

    done();
  });
}
