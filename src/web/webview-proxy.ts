/**
 * @fileoverview Pure helpers for the web-tab reverse proxy. No I/O, no Fastify.
 *
 * The proxy exists because an iframe pointing straight at a dashboard cannot work
 * in the deployment that matters: prod serves HTTPS (behind `tailscale serve`), so
 * a plain-HTTP dashboard is hard-blocked as mixed content; many dashboards also
 * refuse framing outright via `X-Frame-Options` / `frame-ancestors`; and Codeman's
 * own CSP (`default-src 'self'`) blocks cross-origin frames anyway. Serving the
 * dashboard through Codeman's own origin dissolves all three at once, and keeps
 * the production CSP byte-for-byte unchanged because `/webview/...` is `'self'`.
 *
 * ## Origin-scoped, not path-scoped
 *
 * `/webview/<cap>/x/y` always maps to `<upstream origin>/x/y`, never to
 * `<upstream origin><saved path>/x/y`. Dashboards reference assets with
 * root-absolute paths (`/public/build/app.js`), so origin-scoping is the only
 * mapping under which those resolve. The saved URL's own path+query is used for
 * exactly one thing: what `/webview/<cap>/` itself serves (the landing page).
 *
 * ## What gets rewritten, and why each one is load-bearing
 *
 * - `x-frame-options` / CSP `frame-ancestors`: dropped, else the browser refuses
 *   to render the frame. This is the whole point of the proxy.
 * - `content-encoding` / `content-length`: dropped, because undici's `fetch`
 *   already decoded the body. Forwarding them makes the browser try to gunzip
 *   plaintext.
 * - `authorization` + the `codeman_session` cookie: stripped on the way OUT. In
 *   trusted mode the iframe is same-origin, so the browser attaches Codeman's own
 *   Basic-auth header and session cookie to every proxied request. Forwarding
 *   those would hand CODEMAN_PASSWORD to the dashboard.
 * - `Location` and `Set-Cookie`: remapped into the proxy path, else a redirect or
 *   a login cookie escapes the prefix and lands on Codeman's root.
 * - `<base href>` + root-absolute attribute rewriting: relative and `/`-rooted
 *   URLs in the HTML resolve back through the proxy instead of hitting Codeman.
 *
 * No `X-Forwarded-*` is sent deliberately: apps that honor it generate absolute
 * URLs against Codeman's root, which would bypass the `/webview/<cap>/` prefix
 * that everything else here works to preserve.
 */

import { createHash } from 'node:crypto';
import { WEBVIEW_PROXY_PREFIX } from '../config/webview-limits.js';
import { stripBasePath } from '../config/base-path.js';

/** Headers that are per-connection and must never be relayed in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers dropped on the way to the upstream. `authorization` and `cookie`
 * carry Codeman's own credentials on a same-origin (trusted) frame; `host`,
 * `content-length` and `accept-encoding` are recomputed by undici.
 */
const DROP_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  'accept-encoding',
  'authorization',
  'cookie',
  'origin',
  'referer',
  'x-codeman-hook-secret',
]);

/** Response headers dropped on the way back to the browser. */
const DROP_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  'content-encoding',
  'content-length',
  'x-frame-options',
  'content-security-policy-report-only',
  // Cross-origin isolation headers describe the UPSTREAM's origin policy; applied
  // to a frame on Codeman's origin they only produce blocked-resource surprises.
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'set-cookie',
  'location',
  'content-security-policy',
  // The upstream's CORS answer describes ITS origin; the frame asking is
  // opaque-origin on ours, so ours must replace it (see buildProxyCorsHeaders).
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  // The capability rides in every proxied URL, so the upstream's own referrer
  // policy must not decide whether third parties receive it. Ours is stamped in
  // buildDownstreamResponseHeaders.
  'referrer-policy',
]);

/**
 * The same-origin path prefix an iframe loads for a given capability.
 *
 * `basePath` is the reverse-proxy mount prefix (`''` at root, or `/foo`). It is
 * INCLUDED here because this value is browser-facing — the iframe src, the
 * `<base href>`, the runtime shim's rewrite target, Location/Set-Cookie rebasing —
 * and all of those must ride the mount or they escape it. Requests coming the other
 * way are base-stripped before routing, so the parsers (`capabilityFromProxyPath`,
 * `resolveUpstreamUrl`) deliberately do NOT take a base.
 */
export function proxyPrefixFor(capability: string, basePath = ''): string {
  return `${basePath}${WEBVIEW_PROXY_PREFIX}/${capability}/`;
}

/**
 * Parse and validate a user-supplied dashboard URL.
 *
 * Rejects everything that is not plain `http:`/`https:`, anything carrying
 * embedded credentials (they would be silently forwarded and logged), and
 * anything without a hostname. Returns the normalized `URL` or null.
 */
export function parseWebviewUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!url.hostname) return null;
  return url;
}

/** Convenience predicate for Zod refinements. */
export function isValidWebviewUrl(raw: string): boolean {
  return parseWebviewUrl(raw) !== null;
}

/**
 * Map a proxy request path to its upstream URL.
 *
 * `wildcard` is Fastify's `*` param: the path after `/webview/<cap>/`, without a
 * leading slash. An empty wildcard means the landing page, which is the saved
 * URL's own path and query.
 *
 * Returns null when the result would escape the upstream origin (a `..` chain, a
 * protocol-relative `//evil.com` wildcard, or an absolute URL smuggled into the
 * path). That check is what keeps this from being an open proxy.
 */
export function resolveUpstreamUrl(savedUrl: string, wildcard: string, search: string): URL | null {
  const base = parseWebviewUrl(savedUrl);
  if (!base) return null;

  if (wildcard === '' || wildcard === '/') {
    const landing = new URL(base.pathname + (search || base.search), base.origin);
    return landing.origin === base.origin ? landing : null;
  }

  // A wildcard starting with `//` would parse as protocol-relative and jump host.
  const path = wildcard.startsWith('/') ? wildcard : `/${wildcard}`;
  if (path.startsWith('//')) return null;

  let target: URL;
  try {
    target = new URL(path + (search || ''), base.origin);
  } catch {
    return null;
  }
  return target.origin === base.origin ? target : null;
}

/** Extract the capability from a `/webview/<cap>/...` pathname, or null. */
export function capabilityFromProxyPath(pathname: string): string | null {
  if (typeof pathname !== 'string') return null;
  const prefix = `${WEBVIEW_PROXY_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  const cap = slash === -1 ? rest : rest.slice(0, slash);
  return /^[A-Za-z0-9_-]{16,128}$/.test(cap) ? cap : null;
}

/**
 * Extract the capability a `Referer` belongs to. Backs the 404 fallback that
 * catches root-absolute asset requests (`/static/app.js`) which `<base>` cannot fix.
 */
export function capabilityFromReferer(referer: string | undefined, basePath = ''): string | null {
  if (!referer) return null;
  try {
    // The Referer is browser-supplied, so under a sub-path mount it carries the
    // prefix (`/foo/webview/<cap>/...`); strip it back to the internal path the
    // capability parser expects.
    return capabilityFromProxyPath(stripBasePath(basePath, new URL(referer).pathname));
  } catch {
    return null;
  }
}

/** Remove the `frame-ancestors` directive from a CSP, preserving the rest. */
export function stripFrameAncestors(csp: string): string {
  return csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !/^frame-ancestors\b/i.test(d))
    .join('; ');
}

/** The `frame-ancestors` directive value from a CSP, or undefined. */
export function extractFrameAncestors(csp: string | undefined): string | undefined {
  if (!csp) return undefined;
  for (const directive of csp.split(';')) {
    const trimmed = directive.trim();
    if (/^frame-ancestors\b/i.test(trimmed)) {
      return trimmed.slice('frame-ancestors'.length).trim();
    }
  }
  return undefined;
}

/**
 * Whether a target permits being framed by a different origin, judged from its
 * `X-Frame-Options` and CSP. Used only to recommend proxy vs direct mode in the
 * editor; the proxy path works either way.
 */
export function isFramableCrossOrigin(xFrameOptions: string | undefined, csp: string | undefined): boolean {
  const xfo = xFrameOptions?.trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return false;
  const ancestors = extractFrameAncestors(csp)?.toLowerCase();
  if (ancestors === undefined) return true;
  if (ancestors.includes("'none'")) return false;
  // 'self' alone means same-origin only, which a cross-origin embed is not.
  if (ancestors === "'self'") return false;
  return ancestors.includes('*') || ancestors.includes('http');
}

/**
 * Rewrite an upstream `Location` into the proxy path.
 *
 * Same-origin redirects (relative or absolute) are remapped so the browser stays
 * inside the frame. Cross-origin redirects are returned unchanged rather than
 * proxied: relaying them would turn this into an open proxy for any host the
 * upstream chooses to name.
 */
export function rewriteLocation(location: string, requestUrl: URL, capability: string, basePath = ''): string {
  let resolved: URL;
  try {
    resolved = new URL(location, requestUrl);
  } catch {
    return location;
  }
  if (resolved.origin !== requestUrl.origin) return location;
  const suffix = resolved.pathname.replace(/^\//, '');
  return `${proxyPrefixFor(capability, basePath)}${suffix}${resolved.search}${resolved.hash}`;
}

/**
 * Rewrite an upstream `Set-Cookie` so it applies to the proxy path only.
 *
 * `Domain` is dropped (the cookie now belongs to Codeman's host), `Path` is
 * rebased onto the proxy prefix so two dashboards cannot collide on a shared
 * cookie name, and `Secure` is dropped when Codeman itself is serving plain HTTP
 * in dev, where a Secure cookie would simply be discarded.
 */
export function rewriteSetCookie(cookie: string, capability: string, secureContext: boolean, basePath = ''): string {
  const parts = cookie.split(';');
  const out: string[] = [parts[0]];
  let sawPath = false;

  for (const raw of parts.slice(1)) {
    const attr = raw.trim();
    const lower = attr.toLowerCase();
    if (lower.startsWith('domain=')) continue;
    if (lower === 'secure' && !secureContext) continue;
    if (lower.startsWith('path=')) {
      sawPath = true;
      const value = attr.slice('path='.length);
      const suffix = value.replace(/^\//, '');
      out.push(`Path=${proxyPrefixFor(capability, basePath)}${suffix}`);
      continue;
    }
    out.push(attr);
  }

  if (!sawPath) out.push(`Path=${proxyPrefixFor(capability, basePath)}`);
  return out.join('; ');
}

/** Drop named cookies from a `Cookie` request header, returning undefined if none remain. */
export function filterCookieHeader(cookie: string | undefined, drop: string[]): string | undefined {
  if (!cookie) return undefined;
  const dropSet = new Set(drop.map((n) => n.toLowerCase()));
  const kept = cookie
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c !== '' && !dropSet.has(c.slice(0, c.indexOf('=')).trim().toLowerCase()));
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/** Build the header set sent upstream, from the browser's request headers. */
export function buildUpstreamRequestHeaders(
  incoming: Record<string, string | string[] | undefined>,
  upstream: URL,
  opts: { forwardCookies: boolean; sessionCookieName: string; refererPath?: string }
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lower)) continue;
    if (value === undefined) continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }

  if (opts.forwardCookies) {
    const raw = incoming['cookie'];
    const cookie = filterCookieHeader(Array.isArray(raw) ? raw.join('; ') : raw, [opts.sessionCookieName]);
    if (cookie) headers['cookie'] = cookie;
  }

  // Present as if the browser were talking to the dashboard directly. Apps that
  // check Origin on writes (CSRF defenses) need this to match their own origin.
  headers['origin'] = upstream.origin;
  headers['referer'] = opts.refererPath ? new URL(opts.refererPath, upstream.origin).href : upstream.href;

  return headers;
}

/**
 * Build the response headers sent to the browser.
 *
 * Also returns the CSP to apply: the upstream's, minus `frame-ancestors`. Callers
 * MUST set (or explicitly clear) this, because `registerSecurityHeaders` has
 * already stamped Codeman's own `default-src 'self'` policy onto the reply, and
 * that policy would break virtually every dashboard.
 */
export function buildDownstreamResponseHeaders(
  upstreamHeaders: Iterable<[string, string]>,
  /**
   * Upstream `Set-Cookie` values, already separated. Passed in rather than read
   * from `upstreamHeaders` because iterating a `Headers` object JOINS duplicate
   * set-cookie values into one comma-separated string, which cannot be split back
   * apart reliably (Expires dates contain commas). Callers use
   * `response.headers.getSetCookie()`.
   */
  setCookies: string[],
  capability: string,
  requestUrl: URL,
  secureContext: boolean,
  basePath = ''
): { headers: Record<string, string>; setCookie: string[]; csp: string | null } {
  const headers: Record<string, string> = {};
  let csp: string | null = null;

  for (const [key, value] of upstreamHeaders) {
    const lower = key.toLowerCase();
    if (lower === 'content-security-policy') {
      const stripped = stripFrameAncestors(value);
      csp = stripped === '' ? null : stripped;
      continue;
    }
    if (lower === 'location') {
      headers['location'] = rewriteLocation(value, requestUrl, capability, basePath);
      continue;
    }
    if (DROP_RESPONSE_HEADERS.has(lower)) continue;
    headers[lower] = value;
  }

  // Every URL inside the frame carries the capability, and a dashboard that sets
  // `no-referrer-when-downgrade` or `unsafe-url` would hand it to any third-party
  // host it links or embeds. `same-origin` keeps the Referer on requests back to
  // Codeman (the 404 fallback and `refererPath` rely on it; both compare URL
  // origins, which an opaque-origin frame still satisfies) and strips it for
  // everyone else. A `<meta name="referrer">` inside the document can still
  // override this; that is the dashboard author's own decision about their page.
  headers['referrer-policy'] = 'same-origin';

  const setCookie = setCookies.map((cookie) => rewriteSetCookie(cookie, capability, secureContext, basePath));

  return { headers, setCookie, csp };
}

/**
 * A tiny script injected at the top of every proxied document, rewriting
 * ROOT-ABSOLUTE URLs built at runtime so they stay inside the proxy prefix.
 *
 * `<base href>` only governs URLs the HTML parser resolves. A dashboard that calls
 * `fetch('/api/data')` bypasses it entirely and the request lands on Codeman's own
 * root, where it 404s. That is not a rare shape: it is how most dashboards talk to
 * their own backend, and it presents as the dashboard's own "Failed to fetch".
 *
 * The `Referer`-keyed 404 fallback catches some of these, but it is a rescue rather
 * than a fix (it only fires for a request that already missed every Codeman route,
 * and only when the browser sends a usable `Referer`). Rewriting inside the iframe
 * removes the whole class instead: the page never emits a root-absolute request in
 * the first place.
 *
 * ## Why the DOM sinks are patched too, not just fetch/XHR
 *
 * A dashboard that renders `container.innerHTML = '<img src="/api/hero?slug=x">'`
 * or `img.src = '/api/slide?n=01'` produces exactly the same root-absolute request,
 * and NONE of the other layers can reach it: `<base>` does not apply to
 * root-absolute URLs at all, and `rewriteHtml()` only ever sees the initial
 * document, not markup built later by page script. The visible symptom is very
 * specific and easy to misread: the dashboard's DATA loads (reads go through
 * `fetch`, which was already patched) while every IMAGE stays broken. So the same
 * `rw()` is applied to `innerHTML`/`outerHTML`/`insertAdjacentHTML`, to
 * `setAttribute`, and to the `src`/`href`/`srcset`/... property setters, with a
 * `MutationObserver` as a last net for any sink not patched above (that one costs a
 * wasted 404 per node, since the browser starts fetching on insert, so it is a net
 * and not the mechanism).
 *
 * Runs before any page script because it is injected immediately after `<base>`.
 * Only same-origin, non-prefixed, root-absolute URLs are touched; relative URLs
 * (already handled by `<base>`) and cross-origin URLs are passed through. Every
 * rewrite is idempotent, so a value that passes through two layers is unchanged by
 * the second.
 */
export function runtimeUrlShim(prefix: string): string {
  // Kept dependency-free and defensive: it runs inside a page we do not control,
  // and a throw here would break the dashboard rather than fix it.
  return `<script>(function(){try{
var P=${JSON.stringify(prefix)};
// Route masking. A single-page app reads location.pathname on boot and routes
// on it; through the proxy that path starts with /webview/<cap>/, which no app
// has a route for, so it rendered its own "page not found" the moment its
// script ran — after the HTML and CSS had already painted. Replace the entry
// with the path the page would see on its own origin. The base element still resolves
// relative URLs inside the prefix, and every root-absolute sink below is
// rewritten back into it, so only what the page READS changes. The parent
// tab remounts the frame if the page ever navigates itself off the prefix
// (see lostWebviewFramePage), which is what makes a masked reload survivable.
try{
  var L=location.pathname;
  if(L.indexOf(P)===0&&window.history&&typeof history.replaceState==='function'){
    history.replaceState(history.state,'',L.slice(P.length-1)+location.search+location.hash);
  }
}catch(e){}
function rw(u){
  try{
    if(u==null)return u;
    if(typeof u!=='string'){
      if(typeof URL!=='undefined'&&u instanceof URL)return rw(u.href);
      return u;
    }
    if(u.indexOf(P)===0)return u;
    if(u.charAt(0)==='/'&&u.charAt(1)!=='/')return P+u.slice(1);
    if(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)||u.indexOf('//')===0){
      var a=new URL(u,location.href);
      if(a.host===location.host&&a.pathname.indexOf(P)!==0){
        a.pathname=P+a.pathname.replace(/^\\//,'');
        return a.href;
      }
    }
    return u;
  }catch(e){return u;}
}
var of=window.fetch;
if(of)window.fetch=function(i,o){
  try{
    if(typeof Request!=='undefined'&&i instanceof Request)return of.call(this,new Request(rw(i.url),i),o);
    return of.call(this,rw(i),o);
  }catch(e){return of.call(this,i,o);}
};
if(window.XMLHttpRequest&&XMLHttpRequest.prototype.open){
  var oo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    var a=[].slice.call(arguments);a[1]=rw(u);return oo.apply(this,a);
  };
}
['WebSocket','EventSource','Worker','SharedWorker'].forEach(function(k){
  var C=window[k];if(!C)return;
  function W(u,p){return p===undefined?new C(rw(u)):new C(rw(u),p);}
  W.prototype=C.prototype;
  ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(s){if(s in C)W[s]=C[s];});
  window[k]=W;
});
// With the document URL masked, a request the shim misses can no longer be
// rescued by its Referer (that carried the prefix), so the remaining
// URL-taking entry points are covered here rather than left to the fallback.
if(window.navigator&&typeof navigator.sendBeacon==='function'){
  var ob=navigator.sendBeacon;
  navigator.sendBeacon=function(u,d){return ob.call(navigator,rw(u),d);};
}
if(typeof window.open==='function'){
  var ow=window.open;
  window.open=function(u){var a=[].slice.call(arguments);a[0]=rw(u);return ow.apply(this,a);};
}
var A=['src','href','action','poster','data','formaction','srcset'];
function rwSet(v){
  try{
    return String(v).split(',').map(function(p){
      var t=p.trim();if(!t)return t;
      var i=t.search(/\\s/);
      return i===-1?rw(t):rw(t.slice(0,i))+t.slice(i);
    }).join(', ');
  }catch(e){return v;}
}
function rwAttr(n,v){
  try{
    if(v==null)return v;
    var k=String(n).toLowerCase();
    if(k==='srcset')return rwSet(v);
    return A.indexOf(k)===-1?v:rw(v);
  }catch(e){return v;}
}
// CSS built at runtime is the one sink NO relay can rescue: a <style> element has
// no URL of its own, so an opaque-origin document sends an EMPTY Referer with the
// resulting image request, and the 404 fallback has nothing to key on.
function rwCss(s){
  try{
    return String(s).replace(/url\\(\\s*(['"]?)(\\/(?!\\/)[^'")]*)\\1\\s*\\)/gi,function(m,q,u){return 'url('+q+rw(u)+q+')';});
  }catch(e){return s;}
}
// Each value goes through rw() rather than a blind prefix concat, because unlike
// the server-side rewriteHtml() this runs on markup that may ALREADY be proxied
// (a page re-injecting its own outerHTML), and rw() is the idempotent one.
function rwHtml(s){
  try{
    if(typeof s!=='string')return s;
    return s
      .replace(/(\\s(?:src|href|action|poster|formaction|data)\\s*=\\s*")([^"]*)(")/gi,function(m,a,v,q){return a+rw(v)+q;})
      .replace(/(\\s(?:src|href|action|poster|formaction|data)\\s*=\\s*')([^']*)(')/gi,function(m,a,v,q){return a+rw(v)+q;})
      .replace(/(\\ssrcset\\s*=\\s*")([^"]*)(")/gi,function(m,a,v,q){return a+rwSet(v)+q;})
      .replace(/(\\ssrcset\\s*=\\s*')([^']*)(')/gi,function(m,a,v,q){return a+rwSet(v)+q;})
      .replace(/(<style\\b[^>]*>)([^]*?)(<\\/style>)/gi,function(m,a,b,c){return a+rwCss(b)+c;});
  }catch(e){return s;}
}
// Marked with __cmrw so a double injection (a page that re-runs the shim) cannot
// wrap an already-wrapped setter and rewrite twice.
function patchProp(C,prop,conv){
  try{
    if(!C||!C.prototype)return;
    var d=Object.getOwnPropertyDescriptor(C.prototype,prop);
    if(!d||!d.set||d.set.__cmrw)return;
    var s=d.set;
    var ns=function(v){var w=v;try{w=conv(v);}catch(e){}return s.call(this,w);};
    ns.__cmrw=1;
    Object.defineProperty(C.prototype,prop,{get:d.get,set:ns,configurable:true,enumerable:d.enumerable});
  }catch(e){}
}
function patchHtmlProp(O,prop){
  try{
    if(!O)return;
    var d=Object.getOwnPropertyDescriptor(O,prop);
    if(!d||!d.set||d.set.__cmrw)return;
    var s=d.set;
    var ns=function(v){return s.call(this,rwHtml(v));};
    ns.__cmrw=1;
    Object.defineProperty(O,prop,{get:d.get,set:ns,configurable:true,enumerable:d.enumerable});
  }catch(e){}
}
function patchFn(O,name,wrap){
  try{
    var f=O&&O[name];
    if(typeof f!=='function'||f.__cmrw)return;
    var nf=wrap(f);nf.__cmrw=1;O[name]=nf;
  }catch(e){}
}
[['HTMLImageElement','src'],['HTMLImageElement','srcset'],['HTMLSourceElement','src'],
 ['HTMLSourceElement','srcset'],['HTMLMediaElement','src'],['HTMLVideoElement','poster'],
 ['HTMLScriptElement','src'],['HTMLIFrameElement','src'],['HTMLEmbedElement','src'],
 ['HTMLTrackElement','src'],['HTMLLinkElement','href'],['HTMLAnchorElement','href'],
 ['HTMLAreaElement','href'],['HTMLObjectElement','data'],['HTMLFormElement','action']
].forEach(function(p){patchProp(window[p[0]],p[1],p[1]==='srcset'?rwSet:rw);});
var EP=window.Element&&window.Element.prototype;
patchHtmlProp(EP,'innerHTML');
patchHtmlProp(EP,'outerHTML');
patchHtmlProp(window.ShadowRoot&&window.ShadowRoot.prototype,'innerHTML');
patchFn(EP,'insertAdjacentHTML',function(f){return function(p,h){return f.call(this,p,rwHtml(h));};});
patchFn(EP,'setAttribute',function(f){return function(n,v){return f.call(this,n,rwAttr(n,v));};});
patchFn(EP,'setAttributeNS',function(f){return function(ns,n,v){
  var k=String(n==null?'':n),i=k.indexOf(':');
  return f.call(this,ns,n,rwAttr(i===-1?k:k.slice(i+1),v));
};});
// Last net: anything inserted by a sink not patched above still gets corrected.
// setAttribute below is the patched one, so this stays idempotent and terminates.
try{
  var doc=window.document,MO=window.MutationObserver;
  if(MO&&doc&&doc.documentElement){
    var fix=function(el){
      try{
        if(!el||el.nodeType!==1||!el.hasAttribute)return;
        for(var i=0;i<A.length;i++){
          var n=A[i];if(!el.hasAttribute(n))continue;
          var c=el.getAttribute(n),x=rwAttr(n,c);
          if(x!=null&&x!==c)el.setAttribute(n,x);
        }
      }catch(e){}
    };
    var fixStyle=function(el){
      try{
        if(!el||el.tagName!=='STYLE')return;
        var t=el.textContent;
        if(!t||t.indexOf('url(')===-1)return;
        var n=rwCss(t);
        if(n!==t)el.textContent=n;
      }catch(e){}
    };
    var scan=function(node){
      try{
        fix(node);fixStyle(node);
        if(node&&node.querySelectorAll){
          var l=node.querySelectorAll('[src],[href],[action],[poster],[data],[srcset],[formaction]');
          for(var i=0;i<l.length;i++)fix(l[i]);
          var st=node.querySelectorAll('style');
          for(var j=0;j<st.length;j++)fixStyle(st[j]);
        }
      }catch(e){}
    };
    new MO(function(ms){
      for(var i=0;i<ms.length;i++){
        var m=ms[i];
        if(m.type==='attributes')fix(m.target);
        else for(var j=0;j<m.addedNodes.length;j++)scan(m.addedNodes[j]);
      }
    }).observe(doc.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:A});
  }
}catch(e){}
}catch(e){}})();</script>`;
}

/**
 * Inject `<base href="/webview/<cap>/">` plus the runtime URL shim, and rebase
 * root-absolute `src`/`href`/`action` attributes, which `<base>` alone does not
 * affect.
 *
 * Three layers, because no single one is sufficient: `<base>` for parser-resolved
 * relative URLs, attribute rewriting for root-absolute markup, and the shim for
 * URLs built at runtime.
 */
export function rewriteHtml(html: string, capability: string, basePath = ''): string {
  const prefix = proxyPrefixFor(capability, basePath);

  // Fresh regexes per call: module-level /g patterns carry `lastIndex` between calls.
  const rebased = html
    .replace(/(\s(?:src|href|action)\s*=\s*")\/(?!\/)/gi, `$1${prefix}`)
    .replace(/(\s(?:src|href|action)\s*=\s*')\/(?!\/)/gi, `$1${prefix}`);

  // A page that ships its own <base> keeps it (overriding it would break the
  // author's intent), but it STILL needs the shim, which is the layer that
  // catches runtime-built URLs. So only the base tag is conditional.
  const injected = (/<base\b/i.test(rebased) ? '' : `<base href="${prefix}">`) + runtimeUrlShim(prefix);

  const headMatch = /<head\b[^>]*>/i.exec(rebased);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return rebased.slice(0, at) + injected + rebased.slice(at);
  }
  const htmlMatch = /<html\b[^>]*>/i.exec(rebased);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return rebased.slice(0, at) + injected + rebased.slice(at);
  }
  return injected + rebased;
}

/**
 * CORS headers for a proxied response.
 *
 * Non-obvious but load-bearing: a SANDBOXED iframe (no `allow-same-origin`) runs
 * in an OPAQUE origin, so every `fetch`/XHR it makes is a cross-origin request even
 * though the URL is on this very host, and the browser requires CORS headers to
 * hand back the response. Without this, a dashboard renders fine (script/css/img
 * loads are not CORS-checked) while every one of its API calls fails with an opaque
 * `net::ERR_FAILED` and the page shows its own "failed to load" state. `curl`
 * cannot reproduce it, because curl does not enforce CORS.
 *
 * The origin is echoed rather than `*` so credentialed requests still work in
 * trusted mode. `null` (the opaque-origin case) is echoed as-is, but WITHOUT
 * `allow-credentials`, which browsers reject in combination.
 *
 * This grants nothing extra: the URL is already gated by the capability, and only
 * a document that was handed the capability can construct these requests.
 */
export function buildProxyCorsHeaders(origin: string | undefined, requestedHeaders?: string): Record<string, string> {
  if (!origin) return {};
  const headers: Record<string, string> = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'access-control-allow-headers': requestedHeaders && requestedHeaders.trim() !== '' ? requestedHeaders : '*',
    'access-control-expose-headers': '*',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
  // `Access-Control-Allow-Credentials: true` alongside a `null` origin is rejected
  // by browsers; a sandboxed frame sends no credentials anyway.
  if (origin !== 'null' && origin !== '*') headers['access-control-allow-credentials'] = 'true';
  return headers;
}

/** Whether a content-type identifies HTML worth rewriting. */
export function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/** Map an upstream http(s) URL to its ws(s) equivalent for the WebSocket leg. */
export function upstreamWebSocketUrl(target: URL): string {
  const ws = new URL(target.href);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  return ws.href;
}

// ───────────────────────── Lost-frame recovery ─────────────────────────

/**
 * The script the recovery page runs. Kept as a constant so its CSP hash below
 * is computed from the exact bytes that are served.
 */
const LOST_FRAME_SCRIPT = `(function(){try{
var path=location.pathname+location.search+location.hash;
if(window.parent&&window.parent!==window){window.parent.postMessage({type:'codeman:webview-lost',path:path},'*');}
}catch(e){}})();`;

const LOST_FRAME_SCRIPT_HASH = createHash('sha256').update(LOST_FRAME_SCRIPT, 'utf8').digest('base64');

/** CSP for the recovery page: nothing but its own hashed inline script. */
export const LOST_FRAME_PAGE_CSP = `default-src 'none'; script-src 'sha256-${LOST_FRAME_SCRIPT_HASH}'; style-src 'unsafe-inline'`;

/**
 * Whether this request is a web-tab frame that has navigated off its proxy prefix.
 *
 * The runtime shim masks `/webview/<cap>/` off the document URL so a single-page
 * app routes on the path it expects. The price is that a navigation the page
 * starts ITSELF — `location.reload()` (a dev server's full-reload HMR), a
 * root-absolute `location.href = '/login'` — now targets Codeman's own root with
 * no capability anywhere on it: no prefix in the path, no cookie in an
 * opaque-origin frame, and a Referer that names the masked page. Such a request
 * is recognisable by shape alone: a top-level navigation of an `<iframe>`
 * (`Sec-Fetch-Dest`), asking for HTML, for a path Codeman does not serve.
 *
 * The answer is `lostWebviewFramePage()`, a static page whose only content is a
 * `postMessage` to the parent naming the path; the Codeman tab that owns the
 * frame remounts it inside the prefix at that path. Nothing is exempted from
 * auth by this except that static page, which carries no data.
 */
export function isLostWebviewFrameNavigation(req: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const dest = req.headers['sec-fetch-dest'];
  if (dest !== 'iframe' && dest !== 'frame') return false;
  const mode = req.headers['sec-fetch-mode'];
  if (mode !== undefined && mode !== 'navigate') return false;
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/** The static page that hands a lost frame back to its owning tab. */
export function lostWebviewFramePage(): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Reconnecting</title>' +
    '<meta name="referrer" content="no-referrer"></head>' +
    '<body style="margin:0;font:14px system-ui,sans-serif;color:#888;padding:16px">' +
    'Reconnecting this web tab…' +
    `<script>${LOST_FRAME_SCRIPT}</script></body></html>`
  );
}
