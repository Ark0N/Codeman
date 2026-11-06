/**
 * @fileoverview File Viewer: an `.html` file renders as a sandboxed page.
 *
 * The server half (`/html-view/<cap>/...`, html-view-routes.ts) is pinned by
 * test/routes/html-view-routes.test.ts. This file pins the frontend half:
 *
 *  1. `rendersAsPage()` (constants.js) and the server's HTML_VIEW_EXTENSIONS
 *     name the same extensions, so the terminal, the preview and the route
 *     agree on what a page is.
 *  2. A successful mint renders an iframe whose `sandbox` carries scripts but
 *     never `allow-same-origin` (with it, the page could drive Codeman), with
 *     the Page pill shown and pressed.
 *  3. A refused mint (remote case, broad folder, hidden directory) falls
 *     through to the source view with its Edit button, and hides the pill,
 *     which would only retry a page the server just refused.
 *  4. The pill flips between page and source and persists
 *     `codeman:filePreviewHtmlRendered` per device; with it off the preview
 *     opens as source without asking the server for a page at all.
 *
 * Loaded via `vm` with a jsdom document injected, like
 * file-preview-markdown.test.ts: constants.js + panels-ui.js only.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { HTML_VIEW_EXTENSIONS } from '../src/web/routes/html-view-routes.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const constantsJs = readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8');
const panelsJs = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');

// A real origin: jsdom's localStorage getter throws on an opaque one.
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
const { document } = dom.window;

const PAGE_PATH = '/home/u/cases/demo/report/index.html';
const PAGE_URL = '/html-view/AAAAAAAAAAAAAAAAAAAAAAAA/index.html';
const HTML_SOURCE = '<!doctype html>\n<h1>Report</h1>\n';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/**
 * The two routes the preview talks to for an HTML file: the mint (answered or
 * refused per `mint`) and file-content, which serves the source view.
 */
function makeFetch(mint: 'ok' | 'refuse') {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.endsWith('/html-view')) {
      return mint === 'ok'
        ? jsonResponse({ success: true, data: { url: PAGE_URL } })
        : jsonResponse({ success: false, error: 'This folder is too broad to render a page from' }, 403);
    }
    if (url.includes('/file-content')) {
      return jsonResponse({
        success: true,
        data: { content: HTML_SOURCE, totalLines: 3, size: HTML_SOURCE.length, truncated: false, editable: true },
      });
    }
    throw new Error(`unexpected fetch ${init?.method || 'GET'} ${url}`);
  });
}

function loadApp(mint: 'ok' | 'refuse', prefs: Record<string, string> = {}) {
  const store = new Map(Object.entries(prefs));
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, any>;
  const fetchMock = makeFetch(mint);
  const context = vm.createContext({
    CodemanApp,
    console: { ...console, warn: vi.fn(), error: vi.fn() },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k) : null),
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    document,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn(), open: vi.fn() },
    MobileDetection: {},
    setTimeout,
    clearTimeout,
    confirm: () => true,
    fetch: fetchMock,
  });
  vm.runInContext(`${constantsJs}\n${panelsJs}`, context, { filename: 'panels-ui.js' });

  // The overlay's elements, as index.html ships them.
  document.body.innerHTML = `
    <div id="filePreviewOverlay"></div><span id="filePreviewTitle"></span>
    <button id="filePreviewMdBtn" hidden></button>
    <button id="filePreviewPageBtn" hidden></button>
    <button id="filePreviewLinesBtn" hidden></button>
    <button id="filePreviewWrapBtn" hidden></button>
    <button id="filePreviewEditBtn" hidden></button>
    <button id="filePreviewDetachBtn" hidden></button>
    <div id="filePreviewBody"></div><div id="filePreviewFooter"></div>`;

  const app = new CodemanApp();
  app.$ = (id: string) => document.getElementById(id);
  app._resetFilePreviewEdit = () => {
    const edit = document.getElementById('filePreviewEditBtn');
    if (edit) edit.hidden = true;
  };
  app._isExternalPreviewPath = () => false;
  app.formatFileSize = (n: number) => `${n} B`;
  app.filePreviewContent = '';

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  return {
    app,
    fetchMock,
    store,
    body: byId('filePreviewBody'),
    footer: byId('filePreviewFooter'),
    page: byId('filePreviewPageBtn'),
    edit: byId('filePreviewEditBtn'),
  };
}

/** The mint requests the stub saw, as parsed bodies. */
function mintCalls(fetchMock: ReturnType<typeof makeFetch>) {
  return fetchMock.mock.calls
    .filter(([url]) => url.endsWith('/html-view'))
    .map(([url, init]) => ({ url, method: init?.method, body: JSON.parse(init?.body || '{}') }));
}

describe('rendersAsPage', () => {
  it('names exactly the extensions the html-view route renders', () => {
    const context = vm.createContext({});
    vm.runInContext(`${constantsJs}\nglobalThis.__page = { rendersAsPage, HTML_PAGE_EXTENSIONS };`, context, {
      filename: 'constants.js',
    });
    const { rendersAsPage, HTML_PAGE_EXTENSIONS } = (
      context as { __page: { rendersAsPage: (p: string) => boolean; HTML_PAGE_EXTENSIONS: Set<string> } }
    ).__page;

    expect([...HTML_PAGE_EXTENSIONS].sort()).toEqual([...HTML_VIEW_EXTENSIONS].sort());
    expect(rendersAsPage('/tmp/out/report.html')).toBe(true);
    expect(rendersAsPage('docs/INDEX.HTM')).toBe(true);
    expect(rendersAsPage('notes.md')).toBe(false);
    expect(rendersAsPage('page.html.txt')).toBe(false);
    expect(rendersAsPage(undefined as unknown as string)).toBe(false);
  });
});

describe('file viewer HTML page', () => {
  it('renders a minted page in a sandboxed iframe that never gets allow-same-origin', async () => {
    const { app, fetchMock, body, footer, page, edit } = loadApp('ok');

    await app.openFilePreview(PAGE_PATH, 's1');

    expect(mintCalls(fetchMock)).toEqual([
      { url: '/api/sessions/s1/html-view', method: 'POST', body: { path: PAGE_PATH } },
    ]);
    const frame = body.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe(PAGE_URL);
    const sandbox = (frame.getAttribute('sandbox') || '').split(/\s+/);
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(footer.textContent).toBe('HTML');
    expect(app.filePreviewDetachUrl).toBe(PAGE_URL);
    expect(page.hidden).toBe(false);
    expect(page.getAttribute('aria-pressed')).toBe('true');
    // A page has no text for Edit to act on.
    expect(edit.hidden).toBe(true);
  });

  it('falls back to the source view with Edit and no Page pill when the mint is refused', async () => {
    const { app, fetchMock, body, page, edit } = loadApp('refuse');

    await app.openFilePreview(PAGE_PATH, 's1');

    expect(mintCalls(fetchMock)).toHaveLength(1);
    expect(body.querySelector('iframe')).toBeNull();
    const pre = body.querySelector('pre.file-preview-text')!;
    expect(pre.textContent).toBe(HTML_SOURCE);
    expect(page.hidden).toBe(true);
    expect(edit.hidden).toBe(false);
  });

  it('flips between page and source with the pill and persists the choice per device', async () => {
    const { app, fetchMock, body, page, edit, store } = loadApp('ok');

    await app.openFilePreview(PAGE_PATH, 's1');
    expect(body.querySelector('iframe')).not.toBeNull();

    await app.toggleFilePreviewPage();
    expect(store.get('codeman:filePreviewHtmlRendered')).toBe('0');
    expect(body.querySelector('iframe')).toBeNull();
    expect(body.querySelector('pre.file-preview-text')!.textContent).toBe(HTML_SOURCE);
    expect(page.hidden).toBe(false);
    expect(page.getAttribute('aria-pressed')).toBe('false');
    expect(edit.hidden).toBe(false);
    // Source never asks the server for a page.
    expect(mintCalls(fetchMock)).toHaveLength(1);

    await app.toggleFilePreviewPage();
    expect(store.get('codeman:filePreviewHtmlRendered')).toBe('1');
    expect(body.querySelector('iframe')!.getAttribute('src')).toBe(PAGE_URL);
    expect(page.getAttribute('aria-pressed')).toBe('true');
    expect(mintCalls(fetchMock)).toHaveLength(2);
  });

  it('opens as source, pill offered, when the device pref says so', async () => {
    const { app, fetchMock, body, page } = loadApp('ok', { 'codeman:filePreviewHtmlRendered': '0' });

    await app.openFilePreview(PAGE_PATH, 's1');

    expect(mintCalls(fetchMock)).toHaveLength(0);
    expect(body.querySelector('pre.file-preview-text')!.textContent).toBe(HTML_SOURCE);
    expect(page.hidden).toBe(false);
    expect(page.getAttribute('aria-pressed')).toBe('false');
  });
});
