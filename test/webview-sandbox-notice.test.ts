/**
 * A dashboard that cannot boot inside the web-tab sandbox gets a named choice.
 *
 * A proxied frame runs without `allow-same-origin` by default, so its origin is
 * opaque and the Web Storage API throws on first touch. SvelteKit/React apps that
 * keep a token or theme there die mid-boot and paint their loading screen forever.
 * The proxy's injected script wraps the storage getters and reports the first
 * time page code touches one; these pin that the report exists, that a plain page
 * produces none, that the tab identifies the frame by `event.source` (a sandboxed
 * frame's origin is `null`, so the payload proves nothing), and that the offered
 * action actually flips the setting and remounts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runtimeUrlShim } from '../src/web/webview-proxy.js';

const PUBLIC = join(__dirname, '..', 'src', 'web', 'public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

describe('runtime shim reports the sandbox', () => {
  it('posts the marker the parent tab listens for', () => {
    expect(runtimeUrlShim('/webview/AAAA/')).toContain('codeman:webview-needs-origin');
  });

  const body = runtimeUrlShim('/webview/AAAA/')
    .replace(/^<script>/, '')
    .replace(/<\/script>$/, '');

  /**
   * A parent document with one embedded frame. jsdom has no sandbox that creates
   * an opaque origin, so `blocked` replaces the storage getters with the shape a
   * sandboxed window has: reading either one throws a SecurityError.
   */
  function frame(blocked: boolean) {
    const dom = new JSDOM('<!DOCTYPE html><html><body><iframe></iframe></body></html>', {
      url: 'https://codeman.test/',
      runScripts: 'outside-only',
    });
    const frameWindow = dom.window.document.querySelector('iframe')!.contentWindow!;
    const messages: unknown[] = [];
    dom.window.addEventListener('message', (event) => messages.push((event as MessageEvent).data));
    if (blocked) {
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(frameWindow, name, {
          configurable: true,
          get() {
            throw new dom.window.DOMException(`Access to ${name} is denied`, 'SecurityError');
          },
        });
      }
    }
    frameWindow.eval(body);
    return { dom, frameWindow, messages };
  }

  /** postMessage is queued, so let the parent's listener run before asserting. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('does not report on load, even when storage is blocked', async () => {
    const { dom, messages } = frame(true);
    await settle();
    expect(messages).toEqual([]);
    dom.window.close();
  });

  it('reports once the page touches storage, and rethrows the original SecurityError', async () => {
    const { dom, frameWindow, messages } = frame(true);

    let caught: DOMException | null = null;
    try {
      void frameWindow.localStorage;
    } catch (error) {
      caught = error as DOMException;
    }
    expect(caught?.name).toBe('SecurityError');
    await settle();
    expect(messages).toEqual([{ type: 'codeman:webview-needs-origin' }]);

    // The other accessor still fails exactly as it would have, without a second report.
    expect(() => void frameWindow.sessionStorage).toThrow();
    await settle();
    expect(messages).toHaveLength(1);
    dom.window.close();
  });

  it('is invisible when storage works: the real object, and no report', async () => {
    const { dom, frameWindow, messages } = frame(false);
    // A cross-realm Storage, so compare shape and behaviour rather than the class.
    expect(typeof frameWindow.localStorage.getItem).toBe('function');
    expect(typeof frameWindow.sessionStorage.getItem).toBe('function');
    frameWindow.localStorage.setItem('theme', 'dark');
    expect(frameWindow.localStorage.getItem('theme')).toBe('dark');
    await settle();
    expect(messages).toEqual([]);
    dom.window.close();
  });
});

describe('webview sandbox notice (webview-tabs.js)', () => {
  let window: any;
  let document: Document;
  let CodemanApp: any;

  beforeAll(async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="webviewLayer"></div></body></html>', {
      url: 'https://localhost/',
      runScripts: 'outside-only',
    });
    window = dom.window;
    document = window.document;
    window.CSS = { escape: (value: string) => value };
    window.eval(
      'var CodemanApp = function CodemanApp(){};\n' +
        `${read('constants.js')}\n${read('webview-tabs.js')}\n` +
        ';window.__App = CodemanApp;'
    );
    CodemanApp = window.__App;
  });

  // Each `app` installs its own window listener, and these tests share one DOM.
  // Without this the previous test's listener still answers for the SAME frame,
  // which is exactly the cross-instance leak the guard prevents in production.
  const installed: Array<(event: any) => void> = [];
  beforeEach(() => {
    document.getElementById('webviewLayer')!.innerHTML = '';
  });
  afterEach(() => {
    for (const listener of installed.splice(0)) window.removeEventListener('message', listener);
  });

  function makeApp(trusted = false) {
    const app = Object.create(CodemanApp.prototype);
    app.webviews = new Map([['w1', { id: 'w1', name: 'Halo', url: 'http://127.0.0.1:3000', trusted }]]);
    app.showToast = () => {};
    document.getElementById('webviewLayer')!.innerHTML =
      '<div class="webview-frame" data-webview-id="w1"><iframe></iframe>' +
      '<div class="webview-failure"><div class="webview-failure-inner"></div></div></div>';
    return app;
  }

  function postFromFrame(app: any, type = 'codeman:webview-needs-origin') {
    const frame = document.querySelector('#webviewLayer iframe') as HTMLIFrameElement;
    app._installWebviewSandboxListener();
    installed.push(app._webviewSandboxListener);
    window.dispatchEvent(new window.MessageEvent('message', { data: { type }, source: frame.contentWindow }));
  }

  it('offers unsandboxed mode when a sandboxed frame reports blocked storage', () => {
    const app = makeApp(false);
    postFromFrame(app);
    const wrap = document.querySelector('.webview-frame')!;
    expect(wrap.classList.contains('webview-frame--failed')).toBe(true);
    const html = wrap.querySelector('.webview-failure')!.innerHTML;
    expect(html).toContain('Reload unsandboxed');
    expect(html).toContain('enableWebviewTrusted');
    // Reload first, Dismiss second.
    expect(html.indexOf('Reload unsandboxed')).toBeLessThan(html.indexOf('>Dismiss<'));
  });

  it('stays quiet for a frame that is already unsandboxed', () => {
    const app = makeApp(true);
    postFromFrame(app);
    expect(document.querySelector('.webview-frame')!.classList.contains('webview-frame--failed')).toBe(false);
  });

  it('ignores any other message shape, and a frame it did not mount', () => {
    const app = makeApp(false);
    postFromFrame(app, 'codeman:something-else');
    expect(document.querySelector('.webview-frame')!.classList.contains('webview-frame--failed')).toBe(false);

    app._installWebviewSandboxListener();
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'codeman:webview-needs-origin' }, source: window })
    );
    expect(document.querySelector('.webview-frame')!.classList.contains('webview-frame--failed')).toBe(false);
  });

  it('turning it on PATCHes trusted and remounts the frame', async () => {
    const app = makeApp(false);
    const calls: Array<{ path: string; opts: any }> = [];
    let opened: string | null = null;
    app._apiJson = async (path: string, opts: any) => {
      calls.push({ path, opts });
      return { id: 'w1' };
    };
    app.refreshWebviews = async () => {};
    app.openWebview = async (id: string) => {
      opened = id;
    };

    await app.enableWebviewTrusted('w1');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/webviews/w1');
    expect(calls[0].opts).toMatchObject({ method: 'PATCH', body: { trusted: true } });
    // Remount, not reload: the mounted frame keeps the sandbox attribute.
    expect(document.querySelector('.webview-frame')).toBeNull();
    expect(opened).toBe('w1');
  });

  it('dismiss puts the frame back without changing the setting', () => {
    const app = makeApp(false);
    postFromFrame(app);
    const wrap = document.querySelector('.webview-frame')!;
    app.dismissWebviewSandboxNotice('w1');
    expect(wrap.classList.contains('webview-frame--failed')).toBe(false);
  });
});

describe('webview failure panel styling', () => {
  const styles = read('styles.css');

  // `btn-secondary` is not defined by any stylesheet: the actions used to fall
  // through to the browser's default button, which ignores the skin.
  it('paints the actions from skin tokens instead of the browser default', () => {
    const rule = styles.match(/\.webview-failure-actions button \{[^}]*\}/);
    expect(rule).toBeTruthy();
    expect(rule![0]).toContain('background: var(--bg-input)');
    expect(rule![0]).toContain('border: 1px solid var(--border)');
    expect(rule![0]).toContain('color: var(--text)');
  });

  it('gives the action worth taking the accent, so the two are not equal weight', () => {
    const rule = styles.match(/\.webview-failure-actions button:first-child \{[^}]*\}/);
    expect(rule).toBeTruthy();
    expect(rule![0]).toContain('background: var(--accent)');
  });
});
