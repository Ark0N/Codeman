/**
 * @fileoverview Response-viewer links open in a NEW tab (`CodemanApp._renderMarkdown`).
 *
 * `marked` emits a bare `<a href>` and the markdown sanitizer's allowlist carries no
 * `target`, so every link in the chat used to navigate the CURRENT tab. On a phone that
 * unloads the whole dashboard — SSE, terminal buffers, unsent composer text — and the OS
 * back gesture reloads it from scratch, with no middle-click or open-in-new-tab affordance
 * to work around it. That is the "links don't open on mobile" report.
 *
 * `_renderMarkdown` therefore decorates anchors AFTER sanitizing, which makes it the single
 * source of both attributes: whatever an agent wrote is already stripped by then, and `rel`
 * is set on the same element in the same pass, so no page Codeman opens can reach back
 * through `window.opener` (reverse tabnabbing).
 *
 * Drives the SHIPPING artifacts — vendored `marked`, vendored DOMPurify + `sanitize-html.js`,
 * and `app.js` itself — in a `vm` with a jsdom document injected (the technique from
 * markdown-sanitizer.test.ts / response-viewer-file-links.test.ts; a per-file jsdom
 * environment would externalize node:fs under vite).
 *
 * No port / server needed.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const publicFile = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const jsdomWindow = dom.window as unknown as Window & typeof globalThis;
const { document, NodeFilter } = dom.window;

/** The shipping sanitizer: vendored DOMPurify bound to our jsdom window + the real config. */
function loadShippingSanitizer(): (html: string) => string {
  const dpModule: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function('module', 'exports', publicFile('vendor/dompurify.min.js'))(dpModule, dpModule.exports);
  const DOMPurify = (dpModule.exports as (win: unknown) => unknown)(jsdomWindow);

  const sanModule: { exports: { createMarkdownSanitizer?: (dp: unknown) => (html: string) => string } } = {
    exports: {},
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function('module', 'exports', publicFile('sanitize-html.js'))(sanModule, sanModule.exports);
  const create = sanModule.exports.createMarkdownSanitizer;
  if (typeof create !== 'function') throw new Error('createMarkdownSanitizer not exported');
  return create(DOMPurify);
}

/** The vendored `marked` build the page loads, evaluated as CommonJS. */
function loadShippingMarked(): { parse: (src: string, opts?: unknown) => string } {
  const module: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function('module', 'exports', publicFile('vendor/marked.min.js'))(module, module.exports);
  return module.exports as { parse: (src: string, opts?: unknown) => string };
}

type RenderApp = {
  _renderMarkdown(text: string): string;
  _bindResponseViewerInteractions(body: HTMLElement): void;
  _copyText: (text: string) => Promise<boolean>;
  openFilePreview: ReturnType<typeof vi.fn>;
  openLinkThroughWebTabIfLoopback: ReturnType<typeof vi.fn>;
};

function loadCodemanAppClass(): { prototype: RenderApp } {
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    fetch: vi.fn(),
    document: new Proxy(document, {
      get(target, key) {
        // Load the class, not the dashboard's DOMContentLoaded bootstrap.
        if (key === 'addEventListener') return vi.fn();
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    NodeFilter,
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    // The page wires the sanitizer onto window; _sanitizeHtml fails closed without it,
    // and a closed-failing render would make every assertion below vacuous.
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn(), sanitizeMarkdownHtml: loadShippingSanitizer() },
    marked: loadShippingMarked(),
    MobileDetection: {},
  });
  vm.runInContext(
    `${publicFile('constants.js')}\n${publicFile('app.js')}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  return (context as { __CodemanApp: { prototype: RenderApp } }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();

/** Render markdown the way the response viewer does and return the resulting element. */
function render(markdown: string): HTMLElement {
  const app = Object.create(CodemanApp.prototype) as RenderApp;
  const root = document.createElement('div');
  root.className = 'rv-text';
  root.innerHTML = app._renderMarkdown(markdown);
  return root as unknown as HTMLElement;
}

const anchor = (root: HTMLElement, index = 0) => Array.from(root.querySelectorAll('a'))[index];

function interactive(markdown: string) {
  document.body.replaceChildren();
  const app = Object.create(CodemanApp.prototype) as RenderApp;
  app._copyText = vi.fn().mockResolvedValue(true);
  app.openFilePreview = vi.fn();
  app.openLinkThroughWebTabIfLoopback = vi.fn();
  const body = render(markdown);
  body.id = 'responseViewerBody';
  document.body.appendChild(body);
  app._bindResponseViewerInteractions(body);
  return { app, body };
}

describe('response viewer destination inspection', () => {
  it('shows Chinese UTF-8 paths on click without opening a tab or a file', async () => {
    const { app, body } = interactive('[report](/mnt/d/%E4%B8%AD%E6%96%87/report%20one.md)');
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    anchor(body).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(body.querySelector('textarea')?.value).toBe('/mnt/d/中文/report one.md');
    expect(body.querySelectorAll('textarea')[1].value).toBe('/mnt/d/%E4%B8%AD%E6%96%87/report%20one.md');
    expect(app.openFilePreview).not.toHaveBeenCalled();
    expect(app.openLinkThroughWebTabIfLoopback).not.toHaveBeenCalled();
    const buttons = body.querySelectorAll('button');
    buttons[0].click();
    await Promise.resolve();
    expect(app._copyText).toHaveBeenLastCalledWith('/mnt/d/中文/report one.md');
    buttons[1].click();
    await Promise.resolve();
    expect(app._copyText).toHaveBeenLastCalledWith('/mnt/d/%E4%B8%AD%E6%96%87/report%20one.md');
  });

  it.each([
    ['https://localhost:3000/%E4%B8%AD?x=%26%23', 'https://localhost:3000/中?x=%26%23'],
    ['../%E4%B8%AD.md', '../中.md'],
    ['#section', '#section'],
    ['mailto:a@example.com', 'mailto:a@example.com'],
    ['https://example.com/%E4%B8%AD/%ZZ/%E4', 'https://example.com/中/%ZZ/%E4'],
    ['https://example.com/%25E4%25B8%25AD', 'https://example.com/%E4%B8%AD'],
    ['/report/%E4%B8%AD%E4.md', '/report/中%E4.md'],
    ['https://example.com/%F0%9F%93%84%00', 'https://example.com/📄%00'],
  ])('retains the destination %s without resolving it against the dashboard', (href, readable) => {
    const { body } = interactive(`[link](${href})`);
    anchor(body).click();
    expect(body.querySelector('textarea')?.value).toBe(readable);
  });

  it('shows literal file paths, replaces the previous panel and restores focus on close', () => {
    const { app, body } = interactive('[one](https://example.com)');
    const file = document.createElement('a');
    file.className = 'rv-path';
    file.href = '#';
    file.dataset.path = '/tmp/中文%20.txt';
    file.textContent = 'file';
    body.appendChild(file);
    anchor(body).click();
    file.click();
    expect(body.querySelectorAll('.rv-link-address')).toHaveLength(1);
    expect(body.querySelector('textarea')?.value).toBe('/tmp/中文%20.txt');
    expect(app.openFilePreview).not.toHaveBeenCalled();
    Array.from(body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Close')!
      .click();
    expect(body.querySelector('.rv-link-address')).toBeNull();
    expect(document.activeElement).toBe(file);
  });

  it('keeps manual selection available when the clipboard fails', async () => {
    const { app, body } = interactive('[link](https://example.com)');
    app._copyText = vi.fn().mockResolvedValue(false);
    anchor(body).click();
    body.querySelector('button')!.click();
    await vi.waitFor(() => expect(body.querySelector('button')!.textContent).toBe('Select address to copy'));
    const input = body.querySelector('textarea')!;
    expect(input.readOnly).toBe(true);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('also inspects middle clicks instead of opening a new tab', () => {
    const { body } = interactive('[site](https://example.com)');
    const event = new dom.window.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
    anchor(body).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(body.querySelector('textarea')?.value).toBe('https://example.com');
  });

  it('does not turn address text into executable markup', () => {
    const { body } = interactive('[link](https://example.com/%3Cimg%20src=x%20onerror=alert%281%29%3E)');
    anchor(body).click();
    expect(body.querySelector('textarea')?.value).toContain('<img');
    expect(body.querySelector('.rv-link-address img')).toBeNull();
  });

  it('retains File Viewer file navigation in the shared delegate', () => {
    const { app, body } = interactive('document');
    body.id = 'filePreviewBody';
    const file = document.createElement('a');
    file.className = 'rv-path';
    file.href = '#';
    file.dataset.path = '/tmp/other.md';
    file.dataset.sessionId = 'document-session';
    body.appendChild(file);
    file.click();
    expect(app.openFilePreview).toHaveBeenCalledWith('/tmp/other.md', 'document-session');
    expect(body.querySelector('.rv-link-address')).toBeNull();
  });
});

describe('response viewer external links', () => {
  it('opens a markdown link in a new tab, with rel set in the same pass', () => {
    const root = render('See [the docs](https://example.com/docs?a=1&b=2) for details.');

    const a = anchor(root);
    expect(a, 'the link survived sanitizing').toBeDefined();
    expect(a.getAttribute('href')).toBe('https://example.com/docs?a=1&b=2');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('opens an autolinked bare URL in a new tab too', () => {
    // gfm autolinks a bare URL, which is how an agent usually prints one.
    const root = render('Login at https://claude.ai/oauth/authorize?code=true&client_id=abc to continue.');

    const a = anchor(root);
    expect(a.getAttribute('href')).toBe('https://claude.ai/oauth/authorize?code=true&client_id=abc');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('sends a same-origin path to a new tab as well — it is still a navigation away', () => {
    const root = render('Check [status](/api/status).');

    expect(anchor(root).getAttribute('target')).toBe('_blank');
  });

  it('leaves an in-page fragment link alone', () => {
    // A target here would open a second copy of the app to scroll it.
    const root = render('Jump to [the section](#results).');

    const a = anchor(root);
    expect(a.getAttribute('href')).toBe('#results');
    expect(a.hasAttribute('target')).toBe(false);
    expect(a.hasAttribute('rel')).toBe(false);
  });

  it('leaves mailto: and tel: to the OS instead of stranding an empty tab', () => {
    const root = render('Mail [me](mailto:a@example.com) or call [now](tel:+15551234).');

    for (const a of Array.from(root.querySelectorAll('a'))) {
      expect(a.hasAttribute('target'), a.getAttribute('href') || '').toBe(false);
    }
  });

  it('is the ONLY source of target/rel: an agent cannot ask for an opener', () => {
    // The sanitizer's allowlist has neither attribute, so agent-authored ones are gone
    // before this pass runs — and the pass sets both together, so `rel` can never end up
    // weaker than the target it accompanies.
    const root = render('<a href="https://evil.example/" target="_self" rel="opener">click</a>');

    const a = anchor(root);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('still drops a javascript: link rather than decorating it', () => {
    const root = render('[x](javascript:alert(1))');

    const a = anchor(root);
    // DOMPurify strips the unsafe href; whatever is left must not carry a target either,
    // which would turn a hollow anchor into a window-opening one.
    expect(a?.getAttribute('href') ?? null).toBeNull();
    expect(a?.hasAttribute('target') ?? false).toBe(false);
  });

  it('keeps code blocks and their copy affordance intact', () => {
    // The anchor pass shares the one template walk with the code-block wrapper; a mistake
    // there would silently drop the toolbar rather than fail loudly.
    const root = render('```\nconst a = 1;\n```');

    expect(root.querySelector('.rv-code-wrap')).not.toBeNull();
    expect(root.querySelector('.rv-copy-btn')).not.toBeNull();
    expect(root.querySelector('pre code')?.textContent).toContain('const a = 1;');
  });
});
