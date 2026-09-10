/**
 * Pure helpers behind the web-tab reverse proxy (src/web/webview-proxy.ts).
 *
 * These cover the rewrites that make an un-embeddable dashboard embeddable, and
 * the containment checks that keep the proxy from becoming an open relay.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildDownstreamResponseHeaders,
  buildProxyCorsHeaders,
  buildUpstreamRequestHeaders,
  capabilityFromProxyPath,
  capabilityFromReferer,
  extractFrameAncestors,
  filterCookieHeader,
  isFramableCrossOrigin,
  isHtmlContentType,
  isValidWebviewUrl,
  parseWebviewUrl,
  proxyPrefixFor,
  resolveUpstreamUrl,
  rewriteHtml,
  rewriteLocation,
  rewriteSetCookie,
  runtimeUrlShim,
  stripFrameAncestors,
  upstreamWebSocketUrl,
  isLostWebviewFrameNavigation,
  lostWebviewFramePage,
  LOST_FRAME_PAGE_CSP,
} from '../src/web/webview-proxy.js';

const CAP = 'A'.repeat(32);
const PREFIX = `/webview/${CAP}/`;

describe('parseWebviewUrl', () => {
  it('accepts plain http and https', () => {
    expect(parseWebviewUrl('http://127.0.0.1:4000/')?.origin).toBe('http://127.0.0.1:4000');
    expect(parseWebviewUrl('https://dash.example.com/grafana')?.origin).toBe('https://dash.example.com');
  });

  it('rejects non-http schemes', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://host/x']) {
      expect(parseWebviewUrl(url), url).toBeNull();
    }
  });

  it('rejects embedded credentials, which would be forwarded and logged', () => {
    expect(parseWebviewUrl('http://user:pass@host:4000/')).toBeNull();
    expect(parseWebviewUrl('http://user@host:4000/')).toBeNull();
  });

  it('rejects garbage and empty input', () => {
    expect(parseWebviewUrl('')).toBeNull();
    expect(parseWebviewUrl('not a url')).toBeNull();
    expect(isValidWebviewUrl('http://ok.example')).toBe(true);
  });
});

describe('resolveUpstreamUrl', () => {
  const saved = 'http://127.0.0.1:4000/grafana/d/abc?theme=dark';

  it('serves the saved path+query for the landing page', () => {
    expect(resolveUpstreamUrl(saved, '', '')?.href).toBe('http://127.0.0.1:4000/grafana/d/abc?theme=dark');
  });

  it('is ORIGIN-scoped, not path-scoped, so root-absolute assets resolve', () => {
    // The saved /grafana/d/abc path must NOT be prepended, or /public/x.js 404s.
    expect(resolveUpstreamUrl(saved, 'public/build/app.js', '')?.href).toBe(
      'http://127.0.0.1:4000/public/build/app.js'
    );
  });

  it('carries the query string through', () => {
    expect(resolveUpstreamUrl(saved, 'api/data', '?from=now-6h')?.href).toBe(
      'http://127.0.0.1:4000/api/data?from=now-6h'
    );
  });

  it('refuses to leave the upstream origin', () => {
    // Protocol-relative would jump host; traversal would climb out.
    expect(resolveUpstreamUrl(saved, '/evil.com/x', '')?.origin).toBe('http://127.0.0.1:4000');
    expect(resolveUpstreamUrl(saved, '//evil.com/x', '')).toBeNull();
    const climbed = resolveUpstreamUrl(saved, '../../../../etc/passwd', '');
    expect(climbed?.origin).toBe('http://127.0.0.1:4000');
  });

  it('returns null for an unusable saved url', () => {
    expect(resolveUpstreamUrl('javascript:alert(1)', 'x', '')).toBeNull();
  });
});

describe('capability extraction', () => {
  it('reads the capability out of a proxy path', () => {
    expect(capabilityFromProxyPath(`${PREFIX}static/app.js`)).toBe(CAP);
    expect(capabilityFromProxyPath(PREFIX)).toBe(CAP);
    expect(capabilityFromProxyPath(`/webview/${CAP}`)).toBe(CAP);
  });

  it('does not match a lookalike prefix', () => {
    expect(capabilityFromProxyPath('/webviewfoo/bar')).toBeNull();
    expect(capabilityFromProxyPath('/api/webviews')).toBeNull();
    expect(capabilityFromProxyPath('/')).toBeNull();
  });

  it('rejects capabilities of implausible shape', () => {
    expect(capabilityFromProxyPath('/webview/short/x')).toBeNull();
    expect(capabilityFromProxyPath('/webview/has spaces here and more/x')).toBeNull();
    expect(capabilityFromProxyPath('/webview/../../etc/x')).toBeNull();
  });

  it('reads it from a Referer for the root-absolute asset fallback', () => {
    expect(capabilityFromReferer(`https://box.ts.net${PREFIX}page`)).toBe(CAP);
    expect(capabilityFromReferer('https://box.ts.net/')).toBeNull();
    expect(capabilityFromReferer('not a url')).toBeNull();
    expect(capabilityFromReferer(undefined)).toBeNull();
  });
});

describe('CSP handling', () => {
  it('strips frame-ancestors and keeps every other directive', () => {
    const csp = "default-src 'self'; frame-ancestors 'none'; script-src 'unsafe-inline'";
    expect(stripFrameAncestors(csp)).toBe("default-src 'self'; script-src 'unsafe-inline'");
  });

  it('leaves a policy without frame-ancestors alone', () => {
    expect(stripFrameAncestors("default-src 'self'")).toBe("default-src 'self'");
  });

  it('does not confuse a similarly-named directive', () => {
    expect(stripFrameAncestors("frame-src 'self'; frame-ancestors 'none'")).toBe("frame-src 'self'");
  });

  it('extracts the directive value for the probe', () => {
    expect(extractFrameAncestors("default-src 'self'; frame-ancestors https://a.com")).toBe('https://a.com');
    expect(extractFrameAncestors("default-src 'self'")).toBeUndefined();
    expect(extractFrameAncestors(undefined)).toBeUndefined();
  });
});

describe('isFramableCrossOrigin', () => {
  it('honours X-Frame-Options', () => {
    expect(isFramableCrossOrigin('DENY', undefined)).toBe(false);
    expect(isFramableCrossOrigin('sameorigin', undefined)).toBe(false);
    expect(isFramableCrossOrigin(undefined, undefined)).toBe(true);
  });

  it("treats frame-ancestors 'none' and 'self' as not cross-origin framable", () => {
    expect(isFramableCrossOrigin(undefined, "frame-ancestors 'none'")).toBe(false);
    expect(isFramableCrossOrigin(undefined, "frame-ancestors 'self'")).toBe(false);
  });

  it('allows a wildcard or explicit host', () => {
    expect(isFramableCrossOrigin(undefined, 'frame-ancestors *')).toBe(true);
    expect(isFramableCrossOrigin(undefined, 'frame-ancestors https://codeman.example')).toBe(true);
  });
});

describe('rewriteLocation', () => {
  const requestUrl = new URL('http://127.0.0.1:4000/login');

  it('maps a root-absolute redirect into the proxy prefix', () => {
    expect(rewriteLocation('/dashboard?x=1', requestUrl, CAP)).toBe(`${PREFIX}dashboard?x=1`);
  });

  it('maps a same-origin absolute redirect', () => {
    expect(rewriteLocation('http://127.0.0.1:4000/home', requestUrl, CAP)).toBe(`${PREFIX}home`);
  });

  it('leaves a CROSS-origin redirect alone rather than relaying it', () => {
    // Relaying would make this an open proxy for any host the upstream names.
    expect(rewriteLocation('https://evil.example/x', requestUrl, CAP)).toBe('https://evil.example/x');
  });

  it('preserves the hash', () => {
    expect(rewriteLocation('/panel#row2', requestUrl, CAP)).toBe(`${PREFIX}panel#row2`);
  });
});

describe('rewriteSetCookie', () => {
  it('rebases Path onto the proxy prefix and drops Domain', () => {
    const out = rewriteSetCookie('sid=abc; Path=/; Domain=dash.local; HttpOnly', CAP, true);
    expect(out).toContain('sid=abc');
    expect(out).toContain(`Path=${PREFIX}`);
    expect(out).not.toContain('Domain');
    expect(out).toContain('HttpOnly');
  });

  it('adds a scoped Path when the upstream sent none', () => {
    expect(rewriteSetCookie('sid=abc; HttpOnly', CAP, true)).toContain(`Path=${PREFIX}`);
  });

  it('drops Secure when Codeman itself is serving plain HTTP', () => {
    // A Secure cookie over http is silently discarded by the browser.
    expect(rewriteSetCookie('sid=abc; Path=/; Secure', CAP, false)).not.toMatch(/secure/i);
    expect(rewriteSetCookie('sid=abc; Path=/; Secure', CAP, true)).toMatch(/Secure/);
  });

  it('keeps a nested upstream path under the prefix', () => {
    expect(rewriteSetCookie('sid=abc; Path=/admin', CAP, true)).toContain(`Path=${PREFIX}admin`);
  });
});

describe('filterCookieHeader', () => {
  it("removes Codeman's own session cookie and keeps the dashboard's", () => {
    expect(filterCookieHeader('codeman_session=SECRET; dash=1; other=2', ['codeman_session'])).toBe('dash=1; other=2');
  });

  it('returns undefined when nothing survives', () => {
    expect(filterCookieHeader('codeman_session=SECRET', ['codeman_session'])).toBeUndefined();
    expect(filterCookieHeader(undefined, ['codeman_session'])).toBeUndefined();
  });
});

describe('buildUpstreamRequestHeaders', () => {
  const upstream = new URL('http://127.0.0.1:4000/panel');

  it('NEVER forwards Codeman credentials to the dashboard', () => {
    const headers = buildUpstreamRequestHeaders(
      { authorization: 'Basic CODEMANCREDS', cookie: 'codeman_session=SECRET; dash=1', accept: '*/*' },
      upstream,
      { forwardCookies: false, sessionCookieName: 'codeman_session' }
    );
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.accept).toBe('*/*');
  });

  it('forwards the dashboard cookies but strips the session cookie in trusted mode', () => {
    const headers = buildUpstreamRequestHeaders({ cookie: 'codeman_session=SECRET; dash=1' }, upstream, {
      forwardCookies: true,
      sessionCookieName: 'codeman_session',
    });
    expect(headers.cookie).toBe('dash=1');
    expect(headers.authorization).toBeUndefined();
  });

  it('presents Origin/Referer as if the browser talked to the dashboard directly', () => {
    const headers = buildUpstreamRequestHeaders({ origin: 'https://codeman.local' }, upstream, {
      forwardCookies: false,
      sessionCookieName: 'codeman_session',
    });
    expect(headers.origin).toBe('http://127.0.0.1:4000');
    expect(headers.referer).toBe('http://127.0.0.1:4000/panel');
  });

  it('drops hop-by-hop and recomputed headers', () => {
    const headers = buildUpstreamRequestHeaders(
      { host: 'codeman.local', connection: 'keep-alive', 'transfer-encoding': 'chunked', 'content-length': '5' },
      upstream,
      { forwardCookies: false, sessionCookieName: 'codeman_session' }
    );
    expect(headers.host).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
  });
});

describe('buildDownstreamResponseHeaders', () => {
  const requestUrl = new URL('http://127.0.0.1:4000/panel');
  const build = (entries: Array<[string, string]>, cookies: string[] = []) =>
    buildDownstreamResponseHeaders(entries, cookies, CAP, requestUrl, true);

  it('strips the framing refusal, which is the whole point of the proxy', () => {
    const { headers } = build([
      ['x-frame-options', 'DENY'],
      ['content-type', 'text/html'],
    ]);
    expect(headers['x-frame-options']).toBeUndefined();
    expect(headers['content-type']).toBe('text/html');
  });

  it('drops content-encoding/length because undici already decoded the body', () => {
    // Forwarding these makes the browser try to gunzip plaintext.
    const { headers } = build([
      ['content-encoding', 'gzip'],
      ['content-length', '1234'],
    ]);
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
  });

  it('returns the upstream CSP minus frame-ancestors, and null when there was none', () => {
    expect(build([['content-security-policy', "default-src 'self'; frame-ancestors 'none'"]]).csp).toBe(
      "default-src 'self'"
    );
    expect(build([['content-type', 'text/css']]).csp).toBeNull();
  });

  it('rewrites Location and Set-Cookie', () => {
    const { headers, setCookie } = build([['location', '/next']], ['sid=1; Path=/']);
    expect(headers.location).toBe(`${PREFIX}next`);
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain(`Path=${PREFIX}`);
  });
});

describe('rewriteHtml', () => {
  it('injects <base> immediately after <head>', () => {
    const out = rewriteHtml('<html><head><title>x</title></head><body></body></html>', CAP);
    expect(out).toContain(`<head><base href="${PREFIX}">`);
  });

  it('falls back to <html>, then to the very start, for malformed documents', () => {
    expect(rewriteHtml('<html><body>hi</body></html>', CAP)).toContain(`<html><base href="${PREFIX}">`);
    const bare = rewriteHtml('just text', CAP);
    expect(bare.startsWith(`<base href="${PREFIX}">`)).toBe(true);
    expect(bare.endsWith('just text')).toBe(true);
  });

  it('does not add a second <base> when the page already has one', () => {
    const out = rewriteHtml('<html><head><base href="/x/"></head></html>', CAP);
    expect(out.match(/<base/g)).toHaveLength(1);
  });

  it('still injects the runtime shim when the page ships its own <base>', () => {
    // The shim is the only layer that catches runtime-built URLs, so an early
    // return on an existing <base> would silently break those pages.
    const out = rewriteHtml('<html><head><base href="/x/"></head></html>', CAP);
    expect(out).toContain('<script>');
    expect(out).toContain(PREFIX);
  });

  it('injects the shim into every rewritten document', () => {
    expect(rewriteHtml('<html><head></head></html>', CAP)).toContain('<script>');
    expect(rewriteHtml('just text', CAP)).toContain('<script>');
  });

  it('rebases root-absolute src/href/action, which <base> cannot fix', () => {
    const out = rewriteHtml(
      `<head></head><body><script src="/static/app.js"></script><link href='/s.css'><form action="/login"></form></body>`,
      CAP
    );
    expect(out).toContain(`src="${PREFIX}static/app.js"`);
    expect(out).toContain(`href='${PREFIX}s.css'`);
    expect(out).toContain(`action="${PREFIX}login"`);
  });

  it('leaves protocol-relative and absolute URLs alone', () => {
    const out = rewriteHtml('<head></head><script src="//cdn.example/x.js"></script><img src="https://a/b.png">', CAP);
    expect(out).toContain('src="//cdn.example/x.js"');
    expect(out).toContain('src="https://a/b.png"');
  });

  it('is stable across repeated calls (no shared regex lastIndex)', () => {
    const html = '<head></head><script src="/a.js"></script>';
    expect(rewriteHtml(html, CAP)).toBe(rewriteHtml(html, CAP));
  });
});

describe('buildProxyCorsHeaders', () => {
  it('echoes the opaque origin a sandboxed frame sends', () => {
    // Without this the browser rejects every dashboard fetch with an opaque
    // net::ERR_FAILED, while the page itself renders fine.
    const h = buildProxyCorsHeaders('null');
    expect(h['access-control-allow-origin']).toBe('null');
    expect(h.vary).toBe('Origin');
  });

  it('omits allow-credentials for a null origin, which browsers reject together', () => {
    expect(buildProxyCorsHeaders('null')['access-control-allow-credentials']).toBeUndefined();
  });

  it('allows credentials for a real origin (trusted mode)', () => {
    const h = buildProxyCorsHeaders('https://codeman.local');
    expect(h['access-control-allow-origin']).toBe('https://codeman.local');
    expect(h['access-control-allow-credentials']).toBe('true');
  });

  it('echoes requested headers on a preflight', () => {
    expect(buildProxyCorsHeaders('null', 'content-type, x-token')['access-control-allow-headers']).toBe(
      'content-type, x-token'
    );
    expect(buildProxyCorsHeaders('null')['access-control-allow-headers']).toBe('*');
  });

  it('emits nothing when the request carries no Origin', () => {
    expect(buildProxyCorsHeaders(undefined)).toEqual({});
  });
});

describe('runtimeUrlShim', () => {
  const shim = runtimeUrlShim(PREFIX);
  const body = shim.replace(/^<script>/, '').replace(/<\/script>$/, '');

  it('emits a parseable script', () => {
    expect(shim.startsWith('<script>')).toBe(true);
    expect(shim.endsWith('</script>')).toBe(true);
    expect(() => new Function(body)).not.toThrow();
  });

  it('contains no bare </script> that would close the tag early', () => {
    expect(/<\/script>/i.test(body)).toBe(false);
  });

  /**
   * Execute the shim against a fake window and return the patched globals, so the
   * rewrite logic is tested for real rather than by reading the source.
   */
  function runShim(host = 'codeman.local') {
    const calls: string[] = [];
    const win: Record<string, unknown> = {
      fetch: (input: unknown) => {
        calls.push(String(typeof input === 'object' && input ? (input as { url: string }).url : input));
        return Promise.resolve();
      },
      XMLHttpRequest: function () {} as unknown as { prototype: Record<string, unknown> },
      WebSocket: class {
        url: string;
        constructor(u: string) {
          this.url = u;
          calls.push(u);
        }
      },
      EventSource: class {
        url: string;
        constructor(u: string) {
          this.url = u;
          calls.push(u);
        }
      },
    };
    (win.XMLHttpRequest as { prototype: Record<string, unknown> }).prototype = {
      open(_m: string, u: string) {
        calls.push(u);
      },
    };
    const location = { href: `https://${host}${PREFIX}page`, host };
    new Function('window', 'location', 'URL', 'Request', `with (window) { ${body} }`)(win, location, URL, undefined);
    return { win, calls };
  }

  it('rewrites a ROOT-ABSOLUTE fetch, the case <base> cannot reach', () => {
    const { win, calls } = runShim();
    (win.fetch as (u: string) => void)('/api/carousel/job?id=1');
    expect(calls[0]).toBe(`${PREFIX}api/carousel/job?id=1`);
  });

  it('leaves relative URLs alone (<base> already handles them)', () => {
    const { win, calls } = runShim();
    (win.fetch as (u: string) => void)('api/data');
    expect(calls[0]).toBe('api/data');
  });

  it('does not double-prefix an already-proxied URL', () => {
    const { win, calls } = runShim();
    (win.fetch as (u: string) => void)(`${PREFIX}api/data`);
    expect(calls[0]).toBe(`${PREFIX}api/data`);
  });

  it('leaves cross-origin URLs alone', () => {
    const { win, calls } = runShim();
    (win.fetch as (u: string) => void)('https://cdn.example/lib.js');
    expect(calls[0]).toBe('https://cdn.example/lib.js');
  });

  it('rewrites a same-origin ABSOLUTE URL built from location', () => {
    const { win, calls } = runShim();
    (win.fetch as (u: string) => void)('https://codeman.local/api/data');
    expect(calls[0]).toBe(`https://codeman.local${PREFIX}api/data`);
  });

  it('patches XMLHttpRequest.open', () => {
    const { win, calls } = runShim();
    const xhr = win.XMLHttpRequest as { prototype: { open: (m: string, u: string) => void } };
    xhr.prototype.open.call({}, 'GET', '/api/data');
    expect(calls[0]).toBe(`${PREFIX}api/data`);
  });

  it('patches WebSocket and EventSource', () => {
    const { win, calls } = runShim();
    new (win.WebSocket as new (u: string) => unknown)('/live');
    new (win.EventSource as new (u: string) => unknown)('/events');
    expect(calls).toEqual([`${PREFIX}live`, `${PREFIX}events`]);
  });
});

/**
 * The DOM half of the shim, run in a real jsdom document rather than the fake
 * window above, because these patches ARE DOM behavior: what matters is the URL the
 * browser would end up requesting after `innerHTML = ...`, not whether some
 * function got wrapped.
 *
 * The bug being pinned: a dashboard rendering `<img src="/api/hero?slug=x">` from
 * page script escapes `<base>` (which never applies to root-absolute URLs) and
 * escapes `rewriteHtml()` (which only sees the initial document), so every image
 * 404s on Codeman's own root while the dashboard's fetch-driven data loads fine.
 *
 * Node environment on purpose, like test/markdown-sanitizer.test.ts: a per-file
 * jsdom environment directive would externalize node builtins under vite. The
 * directive is deliberately not written out here, even in prose: vitest scans
 * comments for it, and naming it flipped this whole file to the jsdom
 * environment while this comment claimed the opposite.
 */
describe('runtimeUrlShim DOM sinks', () => {
  const body = runtimeUrlShim(PREFIX)
    .replace(/^<script>/, '')
    .replace(/<\/script>$/, '');

  function newDom() {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="box"></div></body></html>', {
      url: `https://codeman.local${PREFIX}page`,
      runScripts: 'outside-only',
    });
    dom.window.eval(body);
    return dom;
  }

  /** src of the first <img> in #box, as the attribute the browser would fetch. */
  function imgSrc(dom: JSDOM): string | null {
    return dom.window.document.querySelector('#box img')!.getAttribute('src');
  }

  it('rewrites a root-absolute img src injected via innerHTML', () => {
    const dom = newDom();
    dom.window.document.getElementById('box')!.innerHTML =
      '<img class="thumb" loading="lazy" src="/api/hero?slug=x" alt="">';
    expect(imgSrc(dom)).toBe(`${PREFIX}api/hero?slug=x`);
  });

  it('rewrites single-quoted markup and insertAdjacentHTML too', () => {
    const dom = newDom();
    dom.window.document.getElementById('box')!.insertAdjacentHTML('beforeend', "<img src='/api/logo'>");
    expect(imgSrc(dom)).toBe(`${PREFIX}api/logo`);
  });

  it('rewrites the img.src property setter', () => {
    const dom = newDom();
    const img = new dom.window.Image();
    img.src = '/api/slide?owner=o&n=01';
    expect(img.getAttribute('src')).toBe(`${PREFIX}api/slide?owner=o&n=01`);
  });

  it('rewrites setAttribute and media src/poster', () => {
    const dom = newDom();
    const video = dom.window.document.createElement('video');
    video.setAttribute('src', '/api/video?owner=o');
    video.poster = '/thumb.png';
    expect(video.getAttribute('src')).toBe(`${PREFIX}api/video?owner=o`);
    expect(video.getAttribute('poster')).toBe(`${PREFIX}thumb.png`);
  });

  it('rewrites every candidate in a srcset, leaving cross-origin ones alone', () => {
    const dom = newDom();
    const img = dom.window.document.createElement('img');
    img.setAttribute('srcset', '/a.png 1x, /b.png 2x, https://cdn.example/c.png 3x');
    expect(img.getAttribute('srcset')).toBe(`${PREFIX}a.png 1x, ${PREFIX}b.png 2x, https://cdn.example/c.png 3x`);
  });

  it('leaves relative, cross-origin, hash, data: and already-proxied URLs untouched', () => {
    const dom = newDom();
    const box = dom.window.document.getElementById('box')!;
    box.innerHTML = [
      '<img id="rel" src="api/rel.png">',
      '<img id="cross" src="https://cdn.example/z.png">',
      '<img id="data" src="data:image/gif;base64,AAAA">',
      `<img id="done" src="${PREFIX}api/hero">`,
      '<a id="hash" href="#top">t</a>',
    ].join('');
    const at = (id: string, attr: string) => dom.window.document.getElementById(id)!.getAttribute(attr);
    expect(at('rel', 'src')).toBe('api/rel.png');
    expect(at('cross', 'src')).toBe('https://cdn.example/z.png');
    expect(at('data', 'src')).toBe('data:image/gif;base64,AAAA');
    expect(at('done', 'src')).toBe(`${PREFIX}api/hero`);
    expect(at('hash', 'href')).toBe('#top');
  });

  it('catches a node built through an UNPATCHED sink via the MutationObserver net', async () => {
    const dom = newDom();
    const { document } = dom.window;
    // createContextualFragment parses markup without going through innerHTML or
    // setAttribute, so only the observer can fix this one.
    const frag = document.createRange().createContextualFragment('<img id="net" src="/api/net.png">');
    expect(frag.querySelector('img')!.getAttribute('src')).toBe('/api/net.png');
    document.getElementById('box')!.appendChild(frag);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.getElementById('net')!.getAttribute('src')).toBe(`${PREFIX}api/net.png`);
  });

  it('does not double-prefix when a page re-injects its own markup', () => {
    const dom = newDom();
    const box = dom.window.document.getElementById('box')!;
    box.innerHTML = '<img src="/api/hero">';
    const roundTrip = box.innerHTML;
    box.innerHTML = roundTrip;
    expect(imgSrc(dom)).toBe(`${PREFIX}api/hero`);
  });

  it('leaves an empty src empty, the "no image for this row" case', () => {
    const dom = newDom();
    dom.window.document.getElementById('box')!.innerHTML = '<img class="thumb" src="" alt="">';
    expect(imgSrc(dom)).toBe('');
  });

  /**
   * CSS is the sink no relay can rescue: a <style> element has no URL of its own,
   * so an opaque-origin document sends an EMPTY Referer with the image request it
   * triggers, and the 404 fallback has nothing to key on. Verified in Chromium.
   */
  it('rewrites root-absolute url() inside a <style> injected as markup', () => {
    const dom = newDom();
    dom.window.document.getElementById('box')!.innerHTML = '<style>#hero{background-image:url(/api/hero.png)}</style>';
    expect(dom.window.document.querySelector('#box style')!.textContent).toBe(
      `#hero{background-image:url(${PREFIX}api/hero.png)}`
    );
  });

  it('rewrites url() in a <style> built with textContent, via the observer', async () => {
    const dom = newDom();
    const { document } = dom.window;
    const style = document.createElement('style');
    style.textContent = "#late{background-image:url('/api/late.png')}";
    document.head.appendChild(style);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(style.textContent).toBe(`#late{background-image:url('${PREFIX}api/late.png')}`);
  });

  it('leaves relative, cross-origin and data: url() alone', () => {
    const dom = newDom();
    const css = [
      'a{background:url(img/rel.png)}',
      'b{background:url(https://cdn.example/z.png)}',
      'c{background:url(data:image/gif;base64,AAAA)}',
      `d{background:url(${PREFIX}api/done.png)}`,
    ].join('');
    dom.window.document.getElementById('box')!.innerHTML = `<style>${css}</style>`;
    expect(dom.window.document.querySelector('#box style')!.textContent).toBe(css);
  });

  it('is idempotent when a value passes through two layers', () => {
    const dom = newDom();
    const img = dom.window.document.createElement('img');
    img.src = '/api/hero';
    img.setAttribute('src', img.getAttribute('src')!);
    expect(img.getAttribute('src')).toBe(`${PREFIX}api/hero`);
  });
});

describe('misc helpers', () => {
  it('identifies HTML content types, parameters included', () => {
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true);
    expect(isHtmlContentType('application/json')).toBe(false);
    expect(isHtmlContentType(undefined)).toBe(false);
  });

  it('maps http(s) to ws(s) for the socket leg', () => {
    expect(upstreamWebSocketUrl(new URL('http://h:4000/live'))).toBe('ws://h:4000/live');
    expect(upstreamWebSocketUrl(new URL('https://h/live'))).toBe('wss://h/live');
  });

  it('builds the iframe prefix', () => {
    expect(proxyPrefixFor(CAP)).toBe(PREFIX);
  });
});

describe('referrer policy on proxied responses', () => {
  const CAP = 'c'.repeat(32);
  const requestUrl = new URL('http://127.0.0.1:4000/');

  it('stamps same-origin and drops the upstream policy, so the capability in the URL never reaches a third party', () => {
    const { headers } = buildDownstreamResponseHeaders(
      [
        ['referrer-policy', 'unsafe-url'],
        ['content-type', 'text/html'],
      ],
      [],
      CAP,
      requestUrl,
      false
    );
    expect(headers['referrer-policy']).toBe('same-origin');
    expect(headers['content-type']).toBe('text/html');
  });

  it('stamps it even when the upstream sent none (the browser default would still leak on a downgrade-style policy)', () => {
    const { headers } = buildDownstreamResponseHeaders(
      [['content-type', 'application/json']],
      [],
      CAP,
      requestUrl,
      false
    );
    expect(headers['referrer-policy']).toBe('same-origin');
  });
});

describe('reverse-proxy base path', () => {
  const BASE = '/codeman';
  const BASED_PREFIX = `${BASE}/webview/${CAP}/`;

  it('rides the mount into the iframe prefix', () => {
    expect(proxyPrefixFor(CAP, BASE)).toBe(BASED_PREFIX);
    expect(proxyPrefixFor(CAP, '')).toBe(PREFIX); // root unchanged
  });

  it('rewrites HTML (base tag, root-absolute attrs, shim) under the mount', () => {
    const out = rewriteHtml('<html><head></head><body><img src="/logo.png"></body></html>', CAP, BASE);
    expect(out).toContain(`<base href="${BASED_PREFIX}">`);
    expect(out).toContain(`src="${BASED_PREFIX}logo.png"`);
    // The runtime shim's rewrite target is the base-prefixed path.
    expect(out).toContain(JSON.stringify(BASED_PREFIX));
  });

  it('rebases Set-Cookie Path onto the mounted prefix so the browser sends it back', () => {
    expect(rewriteSetCookie('sid=abc; Path=/', CAP, true, BASE)).toContain(`Path=${BASED_PREFIX}`);
    expect(rewriteSetCookie('sid=abc; HttpOnly', CAP, true, BASE)).toContain(`Path=${BASED_PREFIX}`);
  });

  it('rewrites a same-origin Location into the mounted prefix', () => {
    const requestUrl = new URL('http://127.0.0.1:4000/app');
    expect(rewriteLocation('/dashboard?x=1', requestUrl, CAP, BASE)).toBe(`${BASED_PREFIX}dashboard?x=1`);
  });

  it('extracts the capability from a browser Referer that carries the mount prefix', () => {
    expect(capabilityFromReferer(`https://box.ts.net${BASED_PREFIX}page`, BASE)).toBe(CAP);
    // A same-named sibling path must not be mistaken for the mount.
    expect(capabilityFromReferer(`https://box.ts.net/codeman-docs/webview/${CAP}/page`, BASE)).toBeNull();
    // Without the base arg the prefixed Referer no longer matches (documents why the arg exists).
    expect(capabilityFromReferer(`https://box.ts.net${BASED_PREFIX}page`)).toBeNull();
  });
});

/**
 * Route masking. A single-page app routes on `location.pathname` at boot; through
 * the proxy that path starts with `/webview/<cap>/`, which no app has a route for,
 * so it rendered its own "page not found" the moment its script ran (measured
 * against a minimal history-routed page: HTML and CSS painted, then the router
 * replaced them). The shim rewrites the history entry to the path the page would
 * see on its own origin, before any page script runs.
 */
describe('runtimeUrlShim route masking', () => {
  const body = runtimeUrlShim(PREFIX)
    .replace(/^<script>/, '')
    .replace(/<\/script>$/, '');

  function boot(url: string) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url,
      runScripts: 'outside-only',
    });
    dom.window.eval(body);
    return dom.window;
  }

  it('masks the proxy prefix off the document URL so the router sees its own path', () => {
    const win = boot(`https://codeman.local${PREFIX}pages/report?tab=2#top`);
    expect(win.location.pathname).toBe('/pages/report');
    expect(win.location.search).toBe('?tab=2');
    expect(win.location.hash).toBe('#top');
  });

  it('maps the landing page to /', () => {
    expect(boot(`https://codeman.local${PREFIX}`).location.pathname).toBe('/');
  });

  it('keeps rewriting root-absolute URLs into the prefix after masking', () => {
    const win = boot(`https://codeman.local${PREFIX}`);
    const calls: string[] = [];
    // Patched fetch is a closure over the ORIGINAL window.fetch; jsdom has none,
    // so exercise the same rewrite through an <a> href, which is a patched sink.
    const a = win.document.createElement('a');
    a.href = '/api/data';
    calls.push(a.getAttribute('href') ?? '');
    expect(calls).toEqual([`${PREFIX}api/data`]);
  });

  it('leaves a document that is not under the prefix alone', () => {
    const win = boot('https://codeman.local/somewhere/else');
    expect(win.location.pathname).toBe('/somewhere/else');
  });

  it('patches window.open so a popup stays inside the prefix', () => {
    const win = boot(`https://codeman.local${PREFIX}`);
    const opened: string[] = [];
    // The shim wrapped the original; swap the original out from under it by
    // re-running against a stub is not possible, so verify the wrapper shape.
    const original = win.open;
    expect(typeof original).toBe('function');
    Object.defineProperty(win, 'open', { value: (u: string) => opened.push(u), configurable: true });
    // A second shim run wraps the stub (the __cmrw guard applies to setters, not
    // to window.open, which has no marker of its own to preserve).
    win.eval(body);
    win.open('/print');
    expect(opened).toEqual([`${PREFIX}print`]);
  });
});

describe('lost-frame recovery', () => {
  const nav = (headers: Record<string, string>, method = 'GET') => isLostWebviewFrameNavigation({ method, headers });

  it('recognises a top-level iframe navigation asking for HTML', () => {
    expect(nav({ 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', accept: 'text/html,*/*' })).toBe(true);
    expect(nav({ 'sec-fetch-dest': 'frame', accept: 'text/html' })).toBe(true);
  });

  it('refuses subresource fetches, non-HTML accepts, and writes', () => {
    expect(nav({ 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors', accept: '*/*' })).toBe(false);
    expect(nav({ 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'cors', accept: 'text/html' })).toBe(false);
    expect(nav({ 'sec-fetch-dest': 'iframe', accept: 'application/json' })).toBe(false);
    expect(nav({ accept: 'text/html' })).toBe(false);
    expect(nav({ 'sec-fetch-dest': 'iframe', accept: 'text/html' }, 'POST')).toBe(false);
  });

  it('serves a page whose only script posts the lost path to the parent, and hashes it in the CSP', async () => {
    const page = lostWebviewFramePage();
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
    expect(script).toContain("postMessage({type:'codeman:webview-lost',path:path},'*')");
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(LOST_FRAME_PAGE_CSP).toContain(`'sha256-${hash}'`);
    expect(LOST_FRAME_PAGE_CSP).toContain("default-src 'none'");
    // The page must never carry a Referer that would leak anything about the tab.
    expect(page).toContain('name="referrer" content="no-referrer"');
  });
});
