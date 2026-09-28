/**
 * @fileoverview Web tabs: saved dashboard URLs, plus the reverse proxy that makes
 * them embeddable.
 *
 * Two distinct surfaces live here, and the split matters:
 *
 * 1. `/api/webviews/*`, ordinary authenticated CRUD, owner-scoped like every
 *    other resource, returning the `ApiResponse` envelope.
 * 2. `/webview/:cap/*`, the proxy. NOT an API surface. It authenticates on an
 *    unguessable capability in the path instead of Codeman's session cookie, and
 *    is correspondingly exempt from the cookie and Origin checks in
 *    `middleware/auth.ts`. See `src/webview-capabilities.ts` for why a cookie
 *    cannot work here (sandboxed iframes are opaque-origin, so their requests are
 *    cross-site and arrive with `Origin: null`).
 *
 * The proxy is registered inside an ENCAPSULATED plugin scope with its own
 * catch-all content-type parser. Fastify scopes parsers to the plugin that
 * registers them, which is what lets the proxy forward raw request bodies
 * upstream while the rest of the app keeps its JSON parsing (and, critically,
 * keeps `text/plain` raw, auto-parsing that was a real CSRF hole once).
 *
 * Endpoints:
 *   GET    /api/webviews
 *   POST   /api/webviews
 *   PATCH  /api/webviews/:id
 *   DELETE /api/webviews/:id
 *   POST   /api/webviews/probe
 *   POST   /api/webviews/:id/open
 *   ALL    /webview/:cap/*   (+ WebSocket upgrade on GET)
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket as WsClient } from 'ws';
import type { ClientOptions as WsClientOptions, WebSocket } from 'ws';
import type { Response as UndiciResponse } from 'undici';
import { getDataDir } from '../../config/instance.js';
import {
  MAX_LIVE_WEBVIEW_FRAMES,
  MAX_WEBVIEWS,
  MAX_WEBVIEW_HTML_REWRITE_BYTES,
  MAX_WEBVIEW_SOCKETS,
  WEBVIEW_PROBE_TIMEOUT_MS,
  WEBVIEW_PROXY_PREFIX,
  WEBVIEW_UPSTREAM_TIMEOUT_MS,
  WEBVIEW_WS_HANDSHAKE_TIMEOUT_MS,
} from '../../config/webview-limits.js';
import { readWebviews, writeWebviews } from '../../webview-store.js';
import { webviewCapabilities } from '../../webview-capabilities.js';
import { egressBlockedReason, webviewEgressLookup, webviewFetch, type EgressLookup } from '../webview-egress.js';
import { blockedWebviewHostReason } from '../webview-egress-policy.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { Webview, WebviewOpenData, WebviewProbe } from '../../types.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';
import { canAccessOwned, getAuthUser, ownerFor, parseBody } from '../route-helpers.js';
import { WebviewCreateSchema, WebviewProbeSchema, WebviewUpdateSchema } from '../schemas.js';
import { SseEvent } from '../sse-events.js';
import type { EventPort, TabLayoutPort } from '../ports/index.js';
import { ownerLayoutKey } from '../../tab-layout-persistence.js';
import {
  buildDownstreamResponseHeaders,
  buildProxyCorsHeaders,
  buildUpstreamRequestHeaders,
  capabilityFromReferer,
  extractFrameAncestors,
  isFramableCrossOrigin,
  isHtmlContentType,
  parseWebviewUrl,
  proxyPrefixFor,
  resolveUpstreamUrl,
  rewriteHtml,
  upstreamWebSocketUrl,
} from '../webview-proxy.js';

/**
 * Resolved per call rather than captured at module load. `getDataDir()` reads
 * `CODEMAN_DATA_DIR` each time, so a lazy lookup keeps tests writing to a temp dir
 * instead of the developer's real `~/.codeman/webviews.json`.
 */
function configDir(): string {
  return getDataDir();
}

/** Live proxied WebSockets per webview id, so one dashboard cannot exhaust the socket budget. */
const socketCounts = new Map<string, number>();

interface ProxyParams {
  cap: string;
  '*'?: string;
}

/** Serialize webview mutations: read-modify-write on a shared JSON file otherwise races. */
let writeChain: Promise<unknown> = Promise.resolve();
function withWebviews<T>(fn: (list: Webview[]) => Promise<T> | T): Promise<T> {
  const next = writeChain.then(async () => {
    const list = await readWebviews(configDir());
    return fn(list);
  });
  // Keep the chain alive even if this link rejects, or every later write deadlocks.
  writeChain = next.catch(() => undefined);
  return next;
}

export function registerWebviewRoutes(app: FastifyInstance, ctx: EventPort & TabLayoutPort, basePath = ''): void {
  registerCrudRoutes(app, ctx, basePath);
  registerProxyRoutes(app, basePath);
}

// ───────────────────────────── CRUD ─────────────────────────────

function registerCrudRoutes(app: FastifyInstance, ctx: EventPort & TabLayoutPort, basePath: string): void {
  app.get('/api/webviews', async (req) => {
    const user = getAuthUser(req);
    const all = await readWebviews(configDir());
    const webviews = all.filter((w) => canAccessOwned(user, w.owner));
    return { success: true, data: { webviews, maxLiveFrames: MAX_LIVE_WEBVIEW_FRAMES } };
  });

  app.post('/api/webviews', async (req, reply) => {
    const input = parseBody(WebviewCreateSchema, req.body);
    const owner = ownerFor(req);
    const user = getAuthUser(req);

    const created = await withWebviews(async (list) => {
      const mine = list.filter((w) => canAccessOwned(user, w.owner));
      if (mine.length >= MAX_WEBVIEWS) return null;

      const webview: Webview = {
        id: randomUUID(),
        name: input.name,
        url: input.url,
        icon: input.icon,
        // Proxy is the safe default: it is the only mode that works for a plain-HTTP
        // dashboard on an HTTPS Codeman, which is the common case.
        embedMode: input.embedMode ?? 'proxy',
        trusted: input.trusted ?? false,
        managed: input.managed,
        owner,
        createdAt: Date.now(),
      };
      list.push(webview);
      await writeWebviews(configDir(), list);
      return webview;
    });

    if (!created) {
      return reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, `Webview limit reached (max ${MAX_WEBVIEWS})`));
    }

    try {
      await ctx.tabLayouts.webviewCreated(ownerLayoutKey(created.owner));
    } catch (error) {
      // The saved webview and its layout ref are one logical creation. If the
      // layout rejects the new ref (for example at MAX_TAB_REFS), roll back the
      // already-written JSON record and publish neither creation event.
      await withWebviews(async (list) => {
        const index = list.findIndex((webview) => webview.id === created.id);
        if (index >= 0) {
          list.splice(index, 1);
          await writeWebviews(configDir(), list);
        }
      });
      throw error;
    }
    ctx.broadcast(SseEvent.WebviewChanged, {
      action: 'created',
      id: created.id,
      owner: ownerLayoutKey(created.owner),
    });
    return { success: true, data: created };
  });

  app.patch<{ Params: { id: string } }>('/api/webviews/:id', async (req, reply) => {
    const input = parseBody(WebviewUpdateSchema, req.body);
    const user = getAuthUser(req);
    const { id } = req.params;

    const updated = await withWebviews(async (list) => {
      const index = list.findIndex((w) => w.id === id);
      if (index === -1) return 'not-found' as const;
      if (!canAccessOwned(user, list[index].owner)) return 'forbidden' as const;

      const next: Webview = { ...list[index], ...input };
      list[index] = next;
      await writeWebviews(configDir(), list);
      return next;
    });

    if (updated === 'not-found') {
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Webview not found'));
    }
    if (updated === 'forbidden') {
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Not your webview'));
    }

    // Any edit invalidates the outstanding capability. Otherwise a token minted
    // against the OLD url keeps proxying to it after the user repointed the tab.
    webviewCapabilities.revokeWebview(id);
    ctx.broadcast(SseEvent.WebviewChanged, {
      action: 'updated',
      id,
      owner: ownerLayoutKey(updated.owner),
    });
    return { success: true, data: updated };
  });

  app.delete<{ Params: { id: string } }>('/api/webviews/:id', async (req, reply) => {
    const user = getAuthUser(req);
    const { id } = req.params;

    const result = await withWebviews(async (list) => {
      const index = list.findIndex((w) => w.id === id);
      if (index === -1) return 'not-found' as const;
      if (!canAccessOwned(user, list[index].owner)) return 'forbidden' as const;
      const removed = list[index];
      list.splice(index, 1);
      await writeWebviews(configDir(), list);
      try {
        await ctx.tabLayouts.webviewDeleted(ownerLayoutKey(removed.owner), id);
      } catch (error) {
        // Still inside withWebviews' mutex: restore the exact record at its
        // original position without overwriting any concurrent mutation.
        list.splice(index, 0, removed);
        await writeWebviews(configDir(), list);
        throw error;
      }
      return { status: 'deleted' as const, owner: removed.owner };
    });

    if (result === 'not-found') {
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Webview not found'));
    }
    if (result === 'forbidden') {
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Not your webview'));
    }

    webviewCapabilities.revokeWebview(id);
    socketCounts.delete(id);
    ctx.broadcast(SseEvent.WebviewChanged, {
      action: 'deleted',
      id,
      owner: ownerLayoutKey(result.owner),
    });
    return { success: true, data: { id } };
  });

  /**
   * Reachability + framing probe for the editor's "Test" button.
   *
   * Runs from the SERVER, which is the network position the proxy will use, so a
   * green result here means the proxy will actually work. Never throws upstream
   * failures at the caller: an unreachable dashboard is a normal answer, not a 500.
   */
  app.post('/api/webviews/probe', async (req) => {
    const { url } = parseBody(WebviewProbeSchema, req.body);
    return { success: true, data: await probeUrl(url) };
  });

  /**
   * Mint the capability the iframe will load. Separate from GET /api/webviews so a
   * capability exists only for dashboards actually opened, and so the TTL clock
   * starts on open rather than on page load.
   */
  app.post<{ Params: { id: string } }>('/api/webviews/:id/open', async (req, reply) => {
    const user = getAuthUser(req);
    const { id } = req.params;

    const webview = await withWebviews(async (list) => {
      const index = list.findIndex((w) => w.id === id);
      if (index === -1) return 'not-found' as const;
      if (!canAccessOwned(user, list[index].owner)) return 'forbidden' as const;
      list[index] = { ...list[index], lastOpenedAt: Date.now() };
      await writeWebviews(configDir(), list);
      return list[index];
    });

    if (webview === 'not-found') {
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Webview not found'));
    }
    if (webview === 'forbidden') {
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Not your webview'));
    }

    // Direct mode has no capability to mint: the iframe loads the real URL.
    if (webview.embedMode === 'direct') {
      const data: WebviewOpenData = { webview };
      return { success: true, data };
    }

    const capability = webviewCapabilities.mint(webview.id, webview.owner);
    const data: WebviewOpenData = { webview, embedUrl: proxyPrefixFor(capability, basePath) };
    return { success: true, data };
  });
}

async function probeUrl(url: string): Promise<WebviewProbe> {
  const target = parseWebviewUrl(url);
  if (!target) {
    return {
      reachable: false,
      framable: false,
      recommendedMode: 'proxy',
      reason: 'Invalid URL',
    };
  }

  try {
    const response = await webviewFetch(target, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBVIEW_PROBE_TIMEOUT_MS),
    });
    // The body is irrelevant to the probe; release the socket rather than leak it.
    await response.body?.cancel().catch(() => undefined);

    const xFrameOptions = response.headers.get('x-frame-options') ?? undefined;
    const csp = response.headers.get('content-security-policy') ?? undefined;
    const frameAncestors = extractFrameAncestors(csp);
    const framable = isFramableCrossOrigin(xFrameOptions, csp);
    const isHttp = target.protocol === 'http:';

    // Direct embedding is only viable for an HTTPS target that permits framing:
    // an HTTPS Codeman page cannot embed http:// at all (mixed content).
    const recommendedMode = !isHttp && framable ? 'direct' : 'proxy';
    const reason = isHttp
      ? 'Plain HTTP: an HTTPS Codeman page cannot embed it directly, so it is proxied.'
      : framable
        ? 'Reachable and allows framing: can be embedded directly.'
        : 'Reachable but refuses framing, so it is proxied.';

    return {
      reachable: true,
      status: response.status,
      xFrameOptions,
      frameAncestors,
      framable,
      recommendedMode,
      reason,
    };
  } catch (err) {
    const blocked = egressBlockedReason(err);
    if (blocked) {
      // Refused by policy, not unreachable: say so, or the user reads it as a
      // network problem and starts debugging their firewall.
      return { reachable: false, framable: false, recommendedMode: 'proxy', reason: blocked };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      reachable: false,
      framable: false,
      recommendedMode: 'proxy',
      reason: `Server could not reach it: ${message}`,
    };
  }
}

// ───────────────────────────── Proxy ─────────────────────────────

function registerProxyRoutes(app: FastifyInstance, basePath: string): void {
  app.register(async (scope) => {
    // Encapsulated to this plugin only. The proxy must relay request bodies
    // BYTE-FOR-BYTE, so every parser is replaced with a pass-through that hands
    // back the raw stream. Doing this on the root instance would break JSON
    // routes and un-fix the text/plain CSRF hardening.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    // A single GET route serving both roles: `handler` for normal requests,
    // `wsHandler` for upgrades. Registering them as two routes on one URL would
    // collide. (The WS leg produces no browser-facing URLs, so it needs no base.)
    scope.route<{ Params: ProxyParams }>({
      method: 'GET',
      url: `${WEBVIEW_PROXY_PREFIX}/:cap/*`,
      handler: (req, reply) => proxyHttp(req, reply, basePath),
      wsHandler: proxyWebSocket,
    });

    // HEAD is deliberately absent: Fastify's `exposeHeadRoutes` already derives a
    // HEAD route from the GET above, and declaring it again is a startup error.
    scope.route<{ Params: ProxyParams }>({
      method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: `${WEBVIEW_PROXY_PREFIX}/:cap/*`,
      handler: (req, reply) => proxyHttp(req, reply, basePath),
    });

    // `/webview/<cap>` with no trailing slash: redirect rather than serve, so the
    // browser's notion of the base path ends in `/` and relative URLs in the
    // dashboard's HTML resolve inside the prefix instead of one level above it.
    scope.get<{ Params: { cap: string } }>(`${WEBVIEW_PROXY_PREFIX}/:cap`, (req, reply) => {
      return reply.redirect(proxyPrefixFor(req.params.cap, basePath), 302);
    });
  });
}

/** Resolve a capability to its live webview record, or null. */
async function lookupCapability(capability: string): Promise<Webview | null> {
  const record = webviewCapabilities.resolve(capability);
  if (!record) return null;
  const list = await readWebviews(configDir());
  const webview = list.find((w) => w.id === record.webviewId);
  if (!webview) return null;
  // The capability is bound to the identity that minted it; an ownership change
  // on the record must not leave a stale token working.
  if (webview.owner !== record.owner) return null;
  return webview;
}

/**
 * ⚠ Every exit path RETURNS `reply.send(...)`.
 *
 * This handler is `async`, and Fastify resolves an async handler's promise as the
 * response. `reply.send(stream)` followed by a bare `return` resolves to
 * `undefined` before the stream has been consumed, and Fastify then answers with
 * an EMPTY body: HTML (a synchronously-set string payload) survives it, every
 * streamed asset comes back zero-length. Returning the reply is what tells Fastify
 * the response is already owned by this handler.
 */
function proxyHttp(
  req: FastifyRequest<{ Params: ProxyParams }>,
  reply: FastifyReply,
  basePath: string
): Promise<FastifyReply> {
  return proxyRequest(req, reply, req.params.cap, req.params['*'] ?? '', basePath);
}

/**
 * Proxy one request to the dashboard behind `cap`, serving `wildcard` as the
 * upstream path. Split out from the route handler so the 404 fallback (which has
 * no route params) can reuse it.
 */
async function proxyRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  cap: string,
  wildcard: string,
  basePath = ''
): Promise<FastifyReply> {
  const webview = await lookupCapability(cap);
  if (!webview) {
    return reply.code(403).type('text/plain').send('Forbidden: unknown or expired webview capability');
  }

  // CORS is required even though the URL is on this host: a sandboxed dashboard is
  // opaque-origin, so its fetch/XHR are cross-origin requests. See
  // buildProxyCorsHeaders.
  const cors = buildProxyCorsHeaders(
    typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    typeof req.headers['access-control-request-headers'] === 'string'
      ? req.headers['access-control-request-headers']
      : undefined
  );

  // Answer the preflight here rather than relaying it: the dashboard has no reason
  // to know it is being framed, and most would reject an unexpected `Origin: null`.
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    for (const [key, value] of Object.entries(cors)) reply.header(key, value);
    return reply.code(204).send();
  }

  const queryStart = req.url.indexOf('?');
  const search = queryStart === -1 ? '' : req.url.slice(queryStart);
  const upstream = resolveUpstreamUrl(webview.url, wildcard, search);
  if (!upstream) {
    return reply.code(400).type('text/plain').send('Bad Request: path escapes the dashboard origin');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const headers = buildUpstreamRequestHeaders(req.headers, upstream, {
    forwardCookies: webview.trusted,
    sessionCookieName: AUTH_COOKIE_NAME,
    refererPath:
      typeof req.headers.referer === 'string' ? stripProxyPrefix(req.headers.referer, cap, basePath) : undefined,
  });

  // #237: the timeout bounds TIME-TO-HEADERS only. A plain AbortSignal.timeout on
  // the fetch bounded the entire exchange, so a legitimately slow endpoint (AI
  // inference behind the dashboard) and an actively streaming response both died at
  // 30s as an unlogged generic 502. The timer is cleared the moment headers arrive;
  // what reclaims an abandoned upstream afterwards is the client hangup below.
  const startedAt = Date.now();
  const abort = new AbortController();
  let headerTimedOut = false;
  let clientGone = false;
  const headerTimer = setTimeout(() => {
    headerTimedOut = true;
    abort.abort();
  }, WEBVIEW_UPSTREAM_TIMEOUT_MS);
  // A browser that navigates away mid-request (or mid-stream) must abort the
  // upstream fetch, or slow endpoints accumulate as orphaned upstream sockets.
  // Guarded by writableFinished, same as abortOnClientHangUp in session-routes:
  // `close` also fires after a completed response, which must not abort anything.
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) {
      clientGone = true;
      abort.abort();
    }
  });

  // Sanitized request identity for logs: method + origin + path, never the query
  // string (it can carry the dashboard's tokens).
  const logTarget = `${req.method} ${upstream.origin}${upstream.pathname}`;

  let response: UndiciResponse;
  try {
    response = await webviewFetch(upstream, {
      method: req.method,
      headers,
      body: hasBody ? (req.body as Readable) : undefined,
      // Required by undici whenever the body is a stream.
      ...(hasBody ? { duplex: 'half' as const } : {}),
      // Redirects are rewritten into the proxy prefix instead of followed, so the
      // browser's URL stays inside the frame and relative assets keep resolving.
      redirect: 'manual',
      signal: abort.signal,
    });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    if (clientGone) {
      // Nobody is listening; the abort was ours and intentional. Not an upstream
      // failure, so no warn (it would read as the dashboard being broken).
      return reply;
    }
    const blocked = egressBlockedReason(err);
    if (blocked) {
      // Policy refusal, distinct from "unreachable": a record saved before the
      // egress rule existed, or a name that now resolves into a blocked range.
      console.warn(`[Webview] refused by egress policy: ${logTarget} (webview "${webview.name}"): ${blocked}`);
      return reply.code(403).type('text/plain').send(`Forbidden: ${blocked}`);
    }
    if (headerTimedOut) {
      console.warn(
        `[Webview] upstream sent no response headers within ${WEBVIEW_UPSTREAM_TIMEOUT_MS}ms: ` +
          `${logTarget} (webview "${webview.name}")`
      );
      return reply
        .code(502)
        .type('text/plain')
        .send(
          `Dashboard unreachable: upstream sent no response headers within ${WEBVIEW_UPSTREAM_TIMEOUT_MS}ms ` +
            `(CODEMAN_WEBVIEW_TIMEOUT_MS raises this limit)`
        );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Webview] upstream fetch failed after ${elapsed}ms: ${logTarget} (webview "${webview.name}"): ${message}`
    );
    return reply.code(502).type('text/plain').send(`Dashboard unreachable: ${message}`);
  } finally {
    // Headers arrived (or the fetch failed): from here on the timeout must never
    // fire, a streaming body is allowed to take as long as it takes.
    clearTimeout(headerTimer);
  }

  const secureContext = req.protocol === 'https';
  const {
    headers: outHeaders,
    setCookie,
    csp,
  } = buildDownstreamResponseHeaders(
    response.headers as unknown as Iterable<[string, string]>,
    response.headers.getSetCookie(),
    cap,
    upstream,
    secureContext,
    basePath
  );

  reply.code(response.status);
  for (const [key, value] of Object.entries(outHeaders)) reply.header(key, value);
  // After the upstream headers, so ours win: an upstream ACAO would name the
  // dashboard's own origin, not the opaque origin this frame actually has.
  for (const [key, value] of Object.entries(cors)) reply.header(key, value);
  for (const cookie of setCookie) reply.header('set-cookie', cookie);

  // registerSecurityHeaders already stamped Codeman's own `default-src 'self'`
  // policy on this reply during onRequest. Left in place it breaks essentially
  // every dashboard (inline scripts, CDN assets), so it is replaced by the
  // upstream's own policy, or removed when the upstream had none.
  if (csp) reply.header('content-security-policy', csp);
  else reply.removeHeader('content-security-policy');

  if (!response.body || req.method === 'HEAD') {
    return reply.send();
  }

  const contentType = response.headers.get('content-type') ?? undefined;
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  const rewritable = isHtmlContentType(contentType) && declaredLength <= MAX_WEBVIEW_HTML_REWRITE_BYTES;

  if (rewritable) {
    // Buffer only HTML, only under the cap: `<base>` injection needs the whole
    // document, and buffering an unbounded upstream body is a memory hazard.
    const html = await response.text();
    return reply.send(html.length <= MAX_WEBVIEW_HTML_REWRITE_BYTES ? rewriteHtml(html, cap, basePath) : html);
  }

  return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
}

/**
 * Last-resort handler for a dashboard asset requested with a ROOT-ABSOLUTE URL.
 *
 * `<base href>` fixes relative URLs and the HTML rewrite fixes `src`/`href`/`action`
 * attributes, but neither can reach a URL built at runtime: `fetch('/api/data')`,
 * `import('/chunk.js')`, `url(/img.png)` inside a stylesheet. Those arrive at
 * Codeman's root and 404.
 *
 * The `Referer` identifies which dashboard asked, so the request can be routed to
 * the right upstream. Wiring it into the 404 handler rather than a catch-all route
 * is what keeps it contained: every real Codeman route matches first, and this only
 * ever sees requests that were going to fail anyway.
 *
 * @returns true when the request was handled (caller must not also reply).
 */
export async function tryWebviewRefererFallback(
  req: FastifyRequest,
  reply: FastifyReply,
  basePath = ''
): Promise<boolean> {
  // Safe methods only. A write arriving here has already lost its raw body to the
  // root instance's JSON parser, so it could not be relayed faithfully anyway.
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const capability = capabilityFromReferer(
    typeof req.headers.referer === 'string' ? req.headers.referer : undefined,
    basePath
  );
  if (!capability) return false;
  if (!webviewCapabilities.resolve(capability)) return false;

  // req.url is already base-stripped by the server's rewriteUrl, so this is the
  // internal path the upstream resolver expects.
  const path = req.url.split('?')[0].replace(/^\//, '');
  await proxyRequest(req, reply, capability, path, basePath);
  return true;
}

/** Turn a proxy-side Referer back into the upstream path it corresponds to. */
function stripProxyPrefix(referer: string, capability: string, basePath = ''): string | undefined {
  try {
    const url = new URL(referer);
    const prefix = proxyPrefixFor(capability, basePath);
    if (!url.pathname.startsWith(prefix)) return undefined;
    return `/${url.pathname.slice(prefix.length)}${url.search}`;
  } catch {
    return undefined;
  }
}

// ─────────────────────────── WebSocket ───────────────────────────

/**
 * Relay a WebSocket through to the dashboard.
 *
 * Live dashboards (Grafana, Home Assistant, Uptime Kuma) push over WebSocket, so
 * without this leg they load but their realtime panels stay permanently empty.
 *
 * The upgrade is guarded on the capability, NOT on `Origin`: a sandboxed iframe is
 * opaque-origin, so its upgrade arrives with `Origin: null`. The host allowlist
 * still applies (it runs in the global onRequest hook), so DNS-rebinding
 * protection is unaffected.
 */
function proxyWebSocket(socket: WebSocket, req: FastifyRequest<{ Params: ProxyParams }>): void {
  const { cap } = req.params;

  void (async () => {
    const webview = await lookupCapability(cap);
    if (!webview) {
      socket.close(4003, 'Forbidden');
      return;
    }

    const live = socketCounts.get(webview.id) ?? 0;
    if (live >= MAX_WEBVIEW_SOCKETS) {
      socket.close(4008, 'Too many connections');
      return;
    }

    const wildcard = req.params['*'] ?? '';
    const queryStart = req.url.indexOf('?');
    const search = queryStart === -1 ? '' : req.url.slice(queryStart);
    const upstream = resolveUpstreamUrl(webview.url, wildcard, search);
    if (!upstream) {
      socket.close(4003, 'Forbidden');
      return;
    }

    // An IP literal never reaches the lookup hook (net.connect skips DNS for it),
    // so the literal form is judged here and the resolved form in the lookup.
    if (blockedWebviewHostReason(upstream.hostname)) {
      socket.close(4003, 'Forbidden');
      return;
    }

    socketCounts.set(webview.id, live + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = socketCounts.get(webview.id) ?? 1;
      if (count <= 1) socketCounts.delete(webview.id);
      else socketCounts.set(webview.id, count - 1);
    };

    const protocols = req.headers['sec-websocket-protocol'];
    // `lookup` is absent from ws's ClientOptions typings but flows through
    // http.request to net.connect untouched, which is where the resolved
    // address is judged (see webview-egress.ts).
    const upstreamOptions: WsClientOptions & { lookup: EgressLookup } = {
      headers: {
        origin: upstream.origin,
        ...(webview.trusted && req.headers.cookie ? { cookie: String(req.headers.cookie) } : {}),
      },
      handshakeTimeout: WEBVIEW_WS_HANDSHAKE_TIMEOUT_MS,
      lookup: webviewEgressLookup,
    };
    const upstreamSocket = new WsClient(
      upstreamWebSocketUrl(upstream),
      protocols ? String(protocols).split(/,\s*/) : [],
      upstreamOptions
    );

    // Buffer anything the browser sends before the upstream handshake completes,
    // rather than dropping it: a client that sends a subscribe frame immediately
    // would otherwise sit connected and silent forever.
    const pending: Array<Buffer | string> = [];
    let upstreamOpen = false;

    upstreamSocket.on('open', () => {
      upstreamOpen = true;
      for (const message of pending) upstreamSocket.send(message);
      pending.length = 0;
    });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      const payload = isBinary ? data : data.toString();
      if (upstreamOpen) upstreamSocket.send(payload);
      else if (pending.length < 64) pending.push(payload);
    });

    upstreamSocket.on('message', (data: Buffer, isBinary: boolean) => {
      if (socket.readyState === socket.OPEN) socket.send(isBinary ? data : data.toString());
    });

    // Paired close in both directions, so neither side is left half-open.
    const closeBoth = (code?: number, reason?: string) => {
      release();
      // Codes outside 3000-4999 (and 1000/1001) are not valid to send onward.
      const safeCode = code && code >= 3000 && code <= 4999 ? code : 1000;
      if (socket.readyState === socket.OPEN) socket.close(safeCode, reason);
      if (upstreamSocket.readyState === WsClient.OPEN || upstreamSocket.readyState === WsClient.CONNECTING) {
        upstreamSocket.close(safeCode, reason);
      }
    };

    socket.on('close', (code: number, reason: Buffer) => closeBoth(code, reason?.toString()));
    upstreamSocket.on('close', (code: number, reason: Buffer) => closeBoth(code, reason?.toString()));
    socket.on('error', () => closeBoth());
    upstreamSocket.on('error', (err: Error) => {
      release();
      if (socket.readyState !== socket.OPEN) return;
      // A name that resolved into a blocked range fails inside the connect, so it
      // surfaces here rather than at the sync check above; report it as the same
      // policy refusal, not as the dashboard being broken.
      if (egressBlockedReason(err)) socket.close(4003, 'Forbidden');
      else socket.close(1011, 'Upstream error');
    });
  })();
}
