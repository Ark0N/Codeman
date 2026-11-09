/**
 * @fileoverview A middle click on a placeholder link in rendered markdown
 * (`CodemanApp._bindResponseViewerInteractions`).
 *
 * File-path links (`a.rv-path`) and in-document links carry `href="#"` /
 * `href="#frag"`: placeholders the click delegate resolves itself. A middle
 * click fires `auxclick`, never `click`, so the browser used to follow the
 * placeholder and open the dashboard root (`<base href="/">` + `#`) in a new
 * tab. A middle click on a placeholder now does exactly what a click does; a
 * real URL keeps the browser's own middle-click behaviour.
 *
 * Both surfaces are covered: the Response Viewer's messages
 * (`_buildResponseViewerMessage` + `_linkifyFilePaths`) and the File Viewer's
 * rendered markdown, whose rebased links name their own session.
 *
 * Drives the shipping `constants.js`, `app.js` and `terminal-ui.js` (for
 * `_resolveLinkedFilePath`) in a `vm` with a jsdom window injected (the
 * technique from response-viewer-file-links.test.ts; a per-file jsdom
 * environment would externalize node:fs under vite).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publicFile = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><head><base href="/"></head><body></body></html>', {
  url: 'http://localhost:3000/',
});
const win = dom.window;
const { document } = win;
// app.js instantiates the whole app on DOMContentLoaded; let it pass before app.js is loaded.
if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r));

type App = {
  activeSessionId: string;
  sessions: Map<string, { workingDir: string }>;
  openFilePreview: ReturnType<typeof vi.fn>;
  openFolderGrid: ReturnType<typeof vi.fn>;
  openLinkThroughWebTabIfLoopback: ReturnType<typeof vi.fn>;
  _linkifyFilePaths(root: Element): void;
  _bindResponseViewerInteractions(body: Element): void;
};

function loadCodemanAppClass(): { prototype: App } {
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
    document,
    NodeFilter: win.NodeFilter,
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    // The real window, so constants.js publishes CodemanMarkdownAnchors where the delegate reads it.
    window: win,
    MobileDetection: {},
  });
  vm.runInContext(
    `${publicFile('constants.js')}\n${publicFile('app.js')}\n${publicFile('terminal-ui.js')}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  return (context as unknown as { __CodemanApp: { prototype: App } }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();

let app: App;

beforeEach(() => {
  app = Object.create(CodemanApp.prototype) as App;
  app.activeSessionId = 'sess-1';
  app.sessions = new Map([
    ['sess-1', { workingDir: '/home/me/proj' }],
    ['sess-2', { workingDir: '/srv/other' }],
  ]);
  app.openFilePreview = vi.fn();
  app.openFolderGrid = vi.fn();
  // A loopback URL would be handed to a web tab on a left click; a middle click must not reach it.
  app.openLinkThroughWebTabIfLoopback = vi.fn(() => true);
});

/** A Response Viewer message body: rendered `.rv-text` inside the bound container. */
function responseViewer(html: string): HTMLElement {
  const body = document.createElement('div');
  const text = document.createElement('div');
  text.className = 'rv-text';
  text.innerHTML = html;
  app._linkifyFilePaths(text);
  body.appendChild(text);
  document.body.replaceChildren(body);
  app._bindResponseViewerInteractions(body);
  return body;
}

function press(el: Element, type: 'auxclick' | 'click', init: MouseEventInit = {}): MouseEvent {
  const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

function noneCalled(): void {
  expect(app.openFilePreview).not.toHaveBeenCalled();
  expect(app.openFolderGrid).not.toHaveBeenCalled();
  expect(app.openLinkThroughWebTabIfLoopback).not.toHaveBeenCalled();
}

describe('middle click on a Response Viewer path link', () => {
  it('opens a relative file path in the preview, resolved against the active session', () => {
    const body = responseViewer('<p>wrote src/app.ts</p>');
    const link = body.querySelector('a.rv-path')!;
    expect(link.getAttribute('href')).toBe('#');

    const ev = press(link, 'auxclick', { button: 1 });

    expect(ev.defaultPrevented).toBe(true);
    expect(app.openFilePreview.mock.calls).toEqual([['/home/me/proj/src/app.ts', 'sess-1']]);
    expect(app.openFolderGrid).not.toHaveBeenCalled();
    expect(app.openLinkThroughWebTabIfLoopback).not.toHaveBeenCalled();
  });

  it('opens a markdown link whose destination is a path, like a click does', () => {
    const body = responseViewer('<p><a href="/home/me/run/summary.json" target="_blank">record</a></p>');

    const ev = press(body.querySelector('a.rv-path')!, 'auxclick', { button: 1 });

    expect(ev.defaultPrevented).toBe(true);
    expect(app.openFilePreview.mock.calls).toEqual([['/home/me/run/summary.json', 'sess-1']]);
  });

  it('opens a folder path in the folder grid', () => {
    const body = responseViewer('<p><a href="/tmp/renders/">renders</a></p>');

    const ev = press(body.querySelector('a.rv-path')!, 'auxclick', { button: 1 });

    expect(ev.defaultPrevented).toBe(true);
    expect(app.openFolderGrid.mock.calls).toEqual([['/tmp/renders/', 'sess-1']]);
    expect(app.openFilePreview).not.toHaveBeenCalled();
  });

  it('does the same with Ctrl held, as Ctrl+click does', () => {
    const body = responseViewer('<p>wrote src/app.ts</p>');

    const ev = press(body.querySelector('a.rv-path')!, 'auxclick', { button: 1, ctrlKey: true });

    expect(ev.defaultPrevented).toBe(true);
    expect(app.openFilePreview.mock.calls).toEqual([['/home/me/proj/src/app.ts', 'sess-1']]);
  });

  it.each([
    ['right', 2],
    ['back', 3],
    ['forward', 4],
  ])('ignores the %s button', (_name, button) => {
    const body = responseViewer('<p>wrote src/app.ts</p>');

    const ev = press(body.querySelector('a.rv-path')!, 'auxclick', { button });

    expect(ev.defaultPrevented).toBe(false);
    noneCalled();
  });

  it('opens once per gesture: a left click still goes through click alone', () => {
    const body = responseViewer('<p>wrote src/app.ts</p>');
    // Binding is idempotent: a second bind must not add a second auxclick listener.
    app._bindResponseViewerInteractions(body);
    const link = body.querySelector('a.rv-path')!;

    press(link, 'auxclick', { button: 1 });
    expect(app.openFilePreview).toHaveBeenCalledTimes(1);

    app.openFilePreview.mockClear();
    const click = press(link, 'click', { button: 0 });
    expect(click.defaultPrevented).toBe(true);
    expect(app.openFilePreview.mock.calls).toEqual([['/home/me/proj/src/app.ts', 'sess-1']]);
  });
});

describe('middle click on an in-document link', () => {
  it('scrolls to the heading in place instead of following the fragment', () => {
    const body = responseViewer('<h2>Install</h2><p>see <a href="#install">install</a></p>');
    const heading = body.querySelector('h2')! as HTMLElement & { scrollIntoView: ReturnType<typeof vi.fn> };
    heading.scrollIntoView = vi.fn();

    const ev = press(body.querySelector('a[href="#install"]')!, 'auxclick', { button: 1 });

    expect(ev.defaultPrevented).toBe(true);
    // jsdom has no matchMedia, so reduced motion reads as off.
    expect(heading.scrollIntoView.mock.calls).toEqual([[{ block: 'start', behavior: 'smooth' }]]);
    noneCalled();
  });

  it('ignores a right click on it', () => {
    const body = responseViewer('<h2>Install</h2><p>see <a href="#install">install</a></p>');
    const heading = body.querySelector('h2')! as HTMLElement & { scrollIntoView: ReturnType<typeof vi.fn> };
    heading.scrollIntoView = vi.fn();

    const ev = press(body.querySelector('a[href="#install"]')!, 'auxclick', { button: 2 });

    expect(ev.defaultPrevented).toBe(false);
    expect(heading.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('middle click on a real URL', () => {
  it.each(['https://example.com/a.json', 'http://localhost:5173/'])('leaves %s to the browser', (href) => {
    const body = responseViewer(`<p><a href="${href}" target="_blank" rel="noopener noreferrer">x</a></p>`);
    expect(body.querySelector('a.rv-path')).toBeNull();

    const ev = press(body.querySelector('a')!, 'auxclick', { button: 1 });

    expect(ev.defaultPrevented).toBe(false);
    noneCalled();
  });
});

describe('middle click in the File Viewer rendered markdown', () => {
  it('opens a rebased link in the session the preview was opened for, not the active one', () => {
    // The shape _rebaseFilePreviewMarkdownRefs gives a workspace link (panels-ui.js).
    const bodyEl = document.createElement('div');
    bodyEl.innerHTML =
      '<div class="rv-text file-preview-md"><a class="rv-path" href="#" data-path="/srv/other/notes.md" data-session-id="sess-2">notes</a></div>';
    document.body.replaceChildren(bodyEl);
    app._bindResponseViewerInteractions(bodyEl);

    const ev = press(bodyEl.querySelector('a.rv-path')!, 'auxclick', { button: 1 });

    expect(ev.defaultPrevented).toBe(true);
    expect(app.openFilePreview.mock.calls).toEqual([['/srv/other/notes.md', 'sess-2']]);
  });
});

describe('a left click keeps its behaviour', () => {
  it('opens a path link in the preview', () => {
    const body = responseViewer('<p>wrote src/app.ts</p>');

    const ev = press(body.querySelector('a.rv-path')!, 'click', { button: 0 });

    expect(ev.defaultPrevented).toBe(true);
    expect(app.openFilePreview.mock.calls).toEqual([['/home/me/proj/src/app.ts', 'sess-1']]);
    expect(app.openLinkThroughWebTabIfLoopback).not.toHaveBeenCalled();
  });

  it('hands a loopback URL to the web-tab hook', () => {
    const body = responseViewer(
      '<p><a href="http://localhost:5173/" target="_blank" rel="noopener noreferrer">dev server</a></p>'
    );

    const ev = press(body.querySelector('a')!, 'click', { button: 0 });

    expect(ev.defaultPrevented).toBe(true);
    expect(app.openLinkThroughWebTabIfLoopback.mock.calls).toEqual([['http://localhost:5173/']]);
    expect(app.openFilePreview).not.toHaveBeenCalled();
  });
});
