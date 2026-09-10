/**
 * @fileoverview Loopback links open through a proxied web tab (webview-tabs.js).
 *
 * An agent prints `http://localhost:5173/` and the user taps it on a phone. The
 * browser there can never reach the Codeman box's loopback, so the link was a
 * guaranteed connection error — while the web-tab proxy fetches from the server,
 * where it works. Pinned here:
 *
 *  1. The decision: only http(s) on a loopback host, and only when the page
 *     itself is not on that host. A LAN/tailnet address stays a direct open.
 *  2. A saved proxied dashboard on the same origin is reused, with the deep
 *     path appended to the minted proxy prefix; a mounted frame is navigated,
 *     not torn down.
 *  3. An unknown origin is saved under its host:port and opened.
 *  4. The terminal link provider and the response viewer consult the hook
 *     before their own opening path.
 *
 * Same in-test JSDOM boot as webview-menu-rows.test.ts (no per-file env).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const CONSTANTS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const WEBVIEW_TABS = readFileSync(new URL('../src/web/public/webview-tabs.js', import.meta.url), 'utf-8');
const TERMINAL_UI = readFileSync(new URL('../src/web/public/terminal-ui.js', import.meta.url), 'utf-8');
const APP_JS = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');

type Webview = { id: string; name: string; url: string; embedMode?: string; managed?: string };

interface AppLike {
  webviews: Map<string, Webview>;
  webviewOrder: string[];
  activeWebviewId: string | null;
  renderSessionTabs(): void;
  refreshWebviews(): Promise<void>;
  openLinkThroughWebTabIfLoopback(url: string): boolean;
  openUrlInWebTab(url: string): Promise<void>;
  openWebview(id: string, options?: { path?: string }): Promise<void>;
  _apiJson(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown>;
  _updateActiveWebviewTab(): void;
  _installWebviewLostListener(): void;
  showToast?: (msg: string, kind: string) => void;
}

function boot(pageUrl = 'http://192.168.1.135:8095/') {
  const dom = new JSDOM(
    `<!doctype html><body><div class="main"></div><div id="sessionTabs"></div><div id="webviewLayer"></div></body>`,
    { url: pageUrl, runScripts: 'outside-only' }
  );
  const win = dom.window as unknown as Window &
    typeof globalThis & { app: AppLike; CodemanApp: new () => AppLike; CodemanWebviewLinks: WebviewLinks };
  (win as unknown as { eval: (s: string) => void }).eval(
    [
      'window.CodemanApp = class CodemanApp {};',
      'window.CodemanBase = { url: (p) => p };',
      'if (!window.CSS) window.CSS = { escape: (s) => s };',
      'window.requestAnimationFrame = (fn) => { fn(); return 1; };',
      CONSTANTS,
      WEBVIEW_TABS,
    ].join('\n')
  );

  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const app = new win.CodemanApp();
  app.webviews = new Map([
    ['dev', { id: 'dev', name: 'localhost:5173', url: 'http://localhost:5173/' }],
    ['direct', { id: 'direct', name: 'Direct', url: 'https://localhost:9443/', embedMode: 'direct' }],
  ]);
  app.webviewOrder = [];
  app.activeWebviewId = null;
  app.renderSessionTabs = () => {};
  app._updateActiveWebviewTab = () => {};
  app.refreshWebviews = async () => {};
  app._apiJson = async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    if (path === '/api/webviews' && opts.method === 'POST') {
      const body = opts.body as { name: string; url: string };
      const created = { id: 'new-id', name: body.name, url: body.url, embedMode: 'proxy' };
      app.webviews.set(created.id, created);
      return created;
    }
    const open = /^\/api\/webviews\/([^/]+)\/open$/.exec(path);
    if (open) {
      const id = decodeURIComponent(open[1]);
      const webview = app.webviews.get(id);
      if (!webview) return null;
      return webview.embedMode === 'direct' ? { webview } : { webview, embedUrl: `/webview/cap-${id}/` };
    }
    return null;
  };
  win.app = app;
  return { win, app, calls };
}

interface WebviewLinks {
  isLoopbackHostname(host: string): boolean;
  linkNeedsWebTabProxy(url: string, pageHostname: string): boolean;
}

const frameSrc = (win: Window, id: string) =>
  (
    win.document.querySelector(`.webview-frame[data-webview-id="${id}"] iframe`) as HTMLIFrameElement | null
  )?.getAttribute('src');

describe('loopback link decision', () => {
  const { win } = boot();
  const links = win.CodemanWebviewLinks;

  it('recognises every loopback spelling and nothing else', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'app.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '[::1]',
      '::1',
    ]) {
      expect(links.isLoopbackHostname(host), host).toBe(true);
    }
    for (const host of [
      '192.168.1.135',
      '10.9.0.4',
      '172.16.0.2',
      'box.ts.net',
      '128.0.0.1',
      '',
      'localhost.example.com',
    ]) {
      expect(links.isLoopbackHostname(host), host).toBe(false);
    }
  });

  it('proxies a loopback http(s) link only when the page is not on that box', () => {
    expect(links.linkNeedsWebTabProxy('http://localhost:5173/', '192.168.1.135')).toBe(true);
    expect(links.linkNeedsWebTabProxy('https://127.0.0.1:8443/x?y=1', 'box.ts.net')).toBe(true);
    // On the box itself the browser reaches localhost directly.
    expect(links.linkNeedsWebTabProxy('http://localhost:5173/', 'localhost')).toBe(false);
    expect(links.linkNeedsWebTabProxy('http://localhost:5173/', '127.0.0.1')).toBe(false);
    // A LAN address may be reachable from the device; leave it direct.
    expect(links.linkNeedsWebTabProxy('http://192.168.1.135:3000/', '192.168.1.135')).toBe(false);
    expect(links.linkNeedsWebTabProxy('http://10.9.0.4:8095/', '192.168.1.135')).toBe(false);
    // Not a web URL at all.
    expect(links.linkNeedsWebTabProxy('ftp://localhost/', '192.168.1.135')).toBe(false);
    expect(links.linkNeedsWebTabProxy('not a url', '192.168.1.135')).toBe(false);
    expect(links.linkNeedsWebTabProxy('', '192.168.1.135')).toBe(false);
  });
});

describe('openLinkThroughWebTabIfLoopback', () => {
  it('reuses the saved proxied dashboard on that origin and opens the deep path', async () => {
    const { win, app, calls } = boot();
    expect(app.openLinkThroughWebTabIfLoopback('http://localhost:5173/pages/report?tab=2#top')).toBe(true);
    await vi.waitFor(() => expect(frameSrc(win, 'dev')).toBe('/webview/cap-dev/pages/report?tab=2#top'));
    expect(calls.some((c) => c.path === '/api/webviews' && c.method === 'POST')).toBe(false);
    expect(app.activeWebviewId).toBe('dev');
    expect(app.webviewOrder).toEqual(['dev']);
  });

  it('navigates an already-mounted frame instead of remounting it', async () => {
    const { win, app } = boot();
    await app.openWebview('dev');
    const first = win.document.querySelector('.webview-frame[data-webview-id="dev"] iframe');
    expect(frameSrc(win, 'dev')).toBe('/webview/cap-dev/');

    await app.openUrlInWebTab('http://localhost:5173/other');
    expect(win.document.querySelector('.webview-frame[data-webview-id="dev"] iframe')).toBe(first);
    expect(frameSrc(win, 'dev')).toBe('/webview/cap-dev/other');
    expect(win.document.querySelectorAll('.webview-frame').length).toBe(1);
  });

  it('saves an unknown origin under its host:port, then opens it', async () => {
    const { win, app, calls } = boot();
    expect(app.openLinkThroughWebTabIfLoopback('http://127.0.0.1:3000/')).toBe(true);
    await vi.waitFor(() => expect(frameSrc(win, 'new-id')).toBe('/webview/cap-new-id/'));
    const post = calls.find((c) => c.path === '/api/webviews' && c.method === 'POST');
    expect(post?.body).toEqual({
      name: '127.0.0.1:3000',
      url: 'http://127.0.0.1:3000/',
      embedMode: 'proxy',
      trusted: false,
    });
  });

  it('does not reuse a direct-mode dashboard, which cannot show a loopback page from elsewhere', async () => {
    const { win, app, calls } = boot();
    expect(app.openLinkThroughWebTabIfLoopback('https://localhost:9443/admin')).toBe(true);
    await vi.waitFor(() => expect(frameSrc(win, 'new-id')).toBe('/webview/cap-new-id/admin'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/webviews')?.body).toMatchObject({
      url: 'https://localhost:9443/',
    });
  });

  it('leaves a reachable link alone so the caller opens it directly', () => {
    const { app, calls } = boot();
    expect(app.openLinkThroughWebTabIfLoopback('http://192.168.1.135:3000/')).toBe(false);
    expect(app.openLinkThroughWebTabIfLoopback('https://example.com/')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('opens loopback links directly when the page itself is on the box', () => {
    const { app, calls } = boot('http://localhost:8095/');
    expect(app.openLinkThroughWebTabIfLoopback('http://localhost:5173/')).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('callers consult the hook first', () => {
  it('terminal URL links try the web tab before window.open', () => {
    const activate = TERMINAL_UI.indexOf('activate(_event, text) {');
    expect(activate).toBeGreaterThan(-1);
    const body = TERMINAL_UI.slice(activate, TERMINAL_UI.indexOf('},', activate));
    expect(body.indexOf('openLinkThroughWebTabIfLoopback?.(text)')).toBeGreaterThan(-1);
    expect(body.indexOf('openLinkThroughWebTabIfLoopback?.(text)')).toBeLessThan(body.indexOf('window.open('));
  });

  it('response viewer links route through the hook and keep the file-path handler first', () => {
    const bind = APP_JS.indexOf('_bindResponseViewerInteractions(body) {');
    const section = APP_JS.slice(bind, bind + 2500);
    const pathHandler = section.indexOf("closest('a.rv-path')");
    const urlHandler = section.indexOf("closest('a[href]')");
    expect(pathHandler).toBeGreaterThan(-1);
    expect(urlHandler).toBeGreaterThan(pathHandler);
    expect(section.indexOf('openLinkThroughWebTabIfLoopback?.(urlLink.href)')).toBeGreaterThan(urlHandler);
  });
});

/**
 * Lost-frame recovery: the server's recovery page posts `{type, path}` to the
 * parent; the tab that owns the frame remounts it inside the prefix at that path.
 */
describe('lost-frame recovery', () => {
  const lost = (win: Window, source: unknown, path: unknown) =>
    win.dispatchEvent(
      new (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', {
        data: { type: 'codeman:webview-lost', path },
        source: source as Window,
      })
    );
  const frameOf = (win: Window, id: string) =>
    win.document.querySelector(`.webview-frame[data-webview-id="${id}"] iframe`) as HTMLIFrameElement;

  it('remounts the frame that sent the message at the path it lost, inside the prefix', async () => {
    const { win, app } = boot();
    app._installWebviewLostListener();
    await app.openWebview('dev');
    const frame = frameOf(win, 'dev');
    lost(win, frame.contentWindow, '/about?tab=2#top');
    await vi.waitFor(() => expect(frameSrc(win, 'dev')).toBe('/webview/cap-dev/about?tab=2#top'));
    expect(frameOf(win, 'dev')).toBe(frame);
  });

  it('recovers to the landing page for a bare reload', async () => {
    const { win, app } = boot();
    app._installWebviewLostListener();
    await app.openWebview('dev');
    await app.openUrlInWebTab('http://localhost:5173/deep');
    expect(frameSrc(win, 'dev')).toBe('/webview/cap-dev/deep');
    lost(win, frameOf(win, 'dev').contentWindow, '/');
    await vi.waitFor(() => expect(frameSrc(win, 'dev')).toBe('/webview/cap-dev/'));
  });

  it('ignores a message that did not come from one of its frames, or is malformed', async () => {
    const { win, app, calls } = boot();
    app._installWebviewLostListener();
    await app.openWebview('dev');
    const before = calls.length;
    lost(win, win, '/elsewhere');
    lost(win, frameOf(win, 'dev').contentWindow, 42);
    win.dispatchEvent(
      new (win as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', {
        data: 'codeman:webview-lost',
        source: frameOf(win, 'dev').contentWindow as Window,
      })
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(before);
    expect(frameSrc(win, 'dev')).toBe('/webview/cap-dev/');
  });

  it('never lets the path jump the frame off the proxy, and bounds a reload loop', async () => {
    const { win, app, calls } = boot();
    app._installWebviewLostListener();
    await app.openWebview('dev');
    lost(win, frameOf(win, 'dev').contentWindow, '//evil.example/x');
    await vi.waitFor(() => expect(calls.filter((c) => c.path.endsWith('/open')).length).toBe(2));
    expect(frameSrc(win, 'dev')).toBe('/webview/cap-dev/');

    const opensBefore = calls.filter((c) => c.path.endsWith('/open')).length;
    for (let i = 0; i < 10; i += 1) lost(win, frameOf(win, 'dev').contentWindow, `/spin-${i}`);
    await new Promise((r) => setTimeout(r, 50));
    const opens = calls.filter((c) => c.path.endsWith('/open')).length - opensBefore;
    expect(opens).toBeLessThanOrEqual(5);
    expect(opens).toBeGreaterThan(0);
  });
});
