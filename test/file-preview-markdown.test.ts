/**
 * @fileoverview File Viewer text view: rendered markdown plus Lines/Wrap toggles.
 *
 * Clicking a `.md` in the Files panel showed wrapped source with no way to see
 * it rendered, although the Response Viewer's marked + DOMPurify pipeline
 * (`_renderMarkdown`) was already on the page. The viewer now renders markdown
 * through that same pipeline, with an MD toggle back to source, and the
 * plain-text view gained Lines and Wrap toggles. Pinned here:
 *
 *  1. `.md` renders into `.rv-text.file-preview-md[data-i18n-skip]` while the
 *     pref is on and into a `<pre>` of per-line spans while it is off; the MD
 *     toggle re-renders WITHOUT a second fetch and persists per device.
 *  2. Relative image refs are rebased onto the workspace-confined file-raw
 *     route under the document's directory and a failed load degrades to alt
 *     text; relative links become `a.rv-path` for the Response Viewer delegate
 *     and lose the `target` marked gave them, while fragment and http(s) links
 *     stay untouched.
 *  3. Markdown fetches the route's line ceiling; other text keeps 500.
 *  4. Lines/Wrap flip classes on the <pre> and persist, and the text the <pre>
 *     holds is byte-identical to the file; every toggle is hidden for an image
 *     and while editing.
 *  5. `FILE_PREVIEW_EXTENSIONS` gained avif/ico and still has no `md`
 *     (in-workspace text keeps the tail viewer, see architecture-invariants).
 *  6. A preview opened by attachment id under a bare file name has no
 *     directory to resolve against, so its relative images degrade to alt text
 *     and its relative links to plain text instead of landing on the workspace
 *     root's files; an absolute-path attachment keeps resolving.
 *  7. A file renders without chat line breaks (`breaks: false`): a paragraph
 *     hard-wrapped in the source is one paragraph, while the Response Viewer
 *     keeps a <br> per newline.
 *
 * Loaded via `vm` with a jsdom document injected (the technique from
 * response-viewer-file-links.test.ts): constants.js + panels-ui.js only, with
 * the app.js markdown pipeline stubbed to a fixed fragment, except for rule 7,
 * which runs the shipping app.js + vendored marked + DOMPurify end to end.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const publicFile = (name: string) => readFileSync(resolve(PUBLIC, name), 'utf8');
const constantsJs = publicFile('constants.js');
const panelsJs = publicFile('panels-ui.js');

// A real origin: vitest's equality walker reaches the window through a node's
// ownerDocument, and jsdom's localStorage getter throws on an opaque one.
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
const { document } = dom.window;

/** What the stubbed `_renderMarkdown` hands back: every ref shape the rebase pass must classify. */
const MARKDOWN_HTML =
  '<h1>Title</h1><p>x</p>' +
  '<img src="img/a.png#gh-dark-mode-only" alt="Alt A">' +
  '<img src="https://cdn.example.com/r.png" alt="remote">' +
  '<a href="guide/x.md#sec" target="_blank" rel="noopener noreferrer">x</a>' +
  '<a href="../CHANGELOG.md" target="_blank" rel="noopener noreferrer">up</a>' +
  '<a href="#top">t</a>' +
  '<a href="https://e.com" target="_blank" rel="noopener noreferrer">e</a>' +
  // marked percent-encodes destinations; a query rides along on GitHub-style refs.
  '<img src="my%20image.png" alt="space">' +
  '<img src="raw.png?raw=true" alt="raw">' +
  '<img src="bad%zz.png" alt="bad">' +
  '<img src="/assets/root.png" alt="root">' +
  '<img src="//cdn.example.com/p.png" alt="protorel">' +
  '<a href="%E5%9B%BE%E7%89%87/%E6%88%AA%E5%9B%BE.md" target="_blank" rel="noopener noreferrer">cjk</a>' +
  '<a href="/docs/root.md" target="_blank" rel="noopener noreferrer">rootlink</a>';

const MD_CONTENT = '# Title\n\nx\n';
const TXT_CONTENT = 'one\n\n  three\tfour\n';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Answer file-content like the route does: text as JSON, an image as metadata. */
function fetchStub(url: string) {
  // An attachment's by-id raw route answers the bytes themselves.
  if (url.includes('/attachments/')) return { ok: true, status: 200, text: async () => MD_CONTENT };
  const path = decodeURIComponent(new URL(url, 'http://x').searchParams.get('path') || '');
  const ext = path.split('.').pop() || '';
  if (ext === 'png') {
    return jsonResponse({
      success: true,
      data: { type: 'image', url: `/file-raw?path=${path}`, size: 5, extension: ext },
    });
  }
  const content = ext === 'md' ? MD_CONTENT : TXT_CONTENT;
  if (url.includes('edit=1')) {
    return jsonResponse({
      success: true,
      data: { content, hash: 'h', eol: 'lf', totalLines: 3, size: content.length },
    });
  }
  return jsonResponse({
    success: true,
    data: { path, content, totalLines: 3, size: content.length, truncated: false, extension: ext, editable: true },
  });
}

/** The file-preview overlay's elements, as index.html ships them. */
function mountPreviewDom() {
  document.body.innerHTML = `
    <div id="filePreviewOverlay"></div><span id="filePreviewTitle"></span>
    <button id="filePreviewMdBtn" hidden></button>
    <button id="filePreviewLinesBtn" hidden></button>
    <button id="filePreviewWrapBtn" hidden></button>
    <button id="filePreviewEditBtn" hidden></button>
    <button id="filePreviewDetachBtn" hidden></button>
    <div id="filePreviewBody"></div><div id="filePreviewFooter"></div>`;
}

function loadApp(prefs: Record<string, string> = {}) {
  const store = new Map(Object.entries(prefs));
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, any>;
  const fetchMock = vi.fn(async (url: string) => fetchStub(url));
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
  vm.runInContext(`${constantsJs}\n${panelsJs}\nglobalThis.__exts = FILE_PREVIEW_EXTENSIONS;`, context, {
    filename: 'panels-ui.js',
  });

  mountPreviewDom();

  const app = new CodemanApp();
  app.$ = (id: string) => document.getElementById(id);
  app._resetFilePreviewEdit = () => {};
  app._isExternalPreviewPath = () => false;
  app.formatFileSize = (n: number) => `${n} B`;
  app.showToast = vi.fn();
  app.filePreviewContent = '';
  app._renderMarkdown = vi.fn(() => MARKDOWN_HTML);
  app._linkifyFilePaths = vi.fn();
  app._bindResponseViewerInteractions = vi.fn();

  const byId = (id: string) => document.getElementById(id) as HTMLButtonElement;
  return {
    app,
    fetchMock,
    store,
    body: byId('filePreviewBody'),
    exts: (context as { __exts: Set<string> }).__exts,
    btn: { md: byId('filePreviewMdBtn'), lines: byId('filePreviewLinesBtn'), wrap: byId('filePreviewWrapBtn') },
  };
}

describe('file viewer rendered markdown', () => {
  it('renders .md through the shared markdown pipeline, inert to i18n, with the viewer delegate bound', async () => {
    const { app, body, btn } = loadApp();

    await app.openFilePreview('docs/README.md', 's1');

    const doc = body.firstElementChild as HTMLElement;
    expect(doc.matches('.rv-text.file-preview-md[data-i18n-skip]')).toBe(true);
    expect(doc.querySelector('h1')?.textContent).toBe('Title');
    // A file, not a chat message: source newlines inside a paragraph are not breaks.
    expect(app._renderMarkdown).toHaveBeenCalledWith(MD_CONTENT, { breaks: false });
    // Identity, not deep equality: DOM nodes are compared by reference here.
    expect(app._linkifyFilePaths.mock.calls[0][0]).toBe(doc);
    expect(app._bindResponseViewerInteractions.mock.calls[0][0]).toBe(body);
    // The source stays what Copy copies.
    expect(app.filePreviewContent).toBe(MD_CONTENT);
    // MD is the only toggle that applies to a rendered document; Edit still offered.
    expect(btn.md.hidden).toBe(false);
    expect(btn.md.getAttribute('aria-pressed')).toBe('true');
    expect(btn.lines.hidden).toBe(true);
    expect(btn.wrap.hidden).toBe(true);
    expect(document.getElementById('filePreviewEditBtn')!.hidden).toBe(false);
  });

  it('fetches the route ceiling for markdown and the 500-line cap for other text', async () => {
    const { app, fetchMock } = loadApp();

    await app.openFilePreview('docs/README.md', 's1');
    await app.openFilePreview('notes.txt', 's1');

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toContain('lines=10000');
    expect(urls[1]).toContain('lines=500');
  });

  it('rebases relative images and links onto the document directory and leaves the rest alone', async () => {
    const { app, body } = loadApp();

    await app.openFilePreview('docs/README.md', 's1');

    const local = body.querySelector('img[alt="Alt A"]')!;
    expect(local.getAttribute('src')).toBe(`/api/sessions/s1/file-raw?path=${encodeURIComponent('docs/img/a.png')}`);
    expect(body.querySelector('img[alt="remote"]')!.getAttribute('src')).toBe('https://cdn.example.com/r.png');

    const rel = body.querySelector('a.rv-path')!;
    expect(rel.getAttribute('data-path')).toBe('docs/guide/x.md');
    expect(rel.getAttribute('href')).toBe('#');
    expect(rel.hasAttribute('target')).toBe(false);
    expect(rel.hasAttribute('rel')).toBe(false);

    const anchors = Array.from(body.querySelectorAll('a'));
    // `..` is collapsed against the document directory, so the title reads
    // CHANGELOG.md rather than docs/../CHANGELOG.md.
    const up = anchors.find((a) => a.textContent === 'up')!;
    expect(up.classList.contains('rv-path')).toBe(true);
    expect(up.getAttribute('data-path')).toBe('CHANGELOG.md');
    const fragment = anchors.find((a) => a.textContent === 't')!;
    expect(fragment.getAttribute('href')).toBe('#top');
    expect(fragment.classList.contains('rv-path')).toBe(false);
    const external = anchors.find((a) => a.textContent === 'e')!;
    expect(external.getAttribute('href')).toBe('https://e.com');
    expect(external.getAttribute('target')).toBe('_blank');
  });

  it('decodes percent-encoded refs, drops the query, and resolves root-relative refs against the workspace', async () => {
    const { app, body } = loadApp();
    // An absolute path in the document's prose, linked by the Response
    // Viewer's linkifier, which knows nothing of the preview's session.
    app._linkifyFilePaths.mockImplementation((root: HTMLElement) => {
      const a = root.ownerDocument.createElement('a');
      a.className = 'rv-path';
      a.dataset.path = '/tmp/out/run.log';
      root.appendChild(a);
    });

    await app.openFilePreview('docs/README.md', 's1');
    const src = (alt: string) => body.querySelector(`img[alt="${alt}"]`)!.getAttribute('src');
    const raw = (path: string) => `/api/sessions/s1/file-raw?path=${encodeURIComponent(path)}`;

    // Decoded once here, encoded once for the route: never `my%2520image.png`.
    expect(src('space')).toBe(raw('docs/my image.png'));
    expect(src('raw')).toBe(raw('docs/raw.png'));
    // A malformed escape keeps the ref as written.
    expect(src('bad')).toBe(raw('docs/bad%zz.png'));
    // Root-relative is the workspace root, as on GitHub; protocol-relative is remote.
    expect(src('root')).toBe(raw('assets/root.png'));
    expect(src('protorel')).toBe('//cdn.example.com/p.png');

    const anchors = Array.from(body.querySelectorAll('a'));
    expect(anchors.find((a) => a.textContent === 'cjk')!.getAttribute('data-path')).toBe('docs/图片/截图.md');
    expect(anchors.find((a) => a.textContent === 'rootlink')!.getAttribute('data-path')).toBe('docs/root.md');
    // Every rebased link, and every path the linkifier found in the prose,
    // names the preview's session, so the delegate opens it in that workspace
    // even when another tab is active.
    const rebased = body.querySelectorAll('a.rv-path');
    expect(rebased.length).toBe(5);
    for (const a of rebased) expect(a.getAttribute('data-session-id')).toBe('s1');
  });

  it('degrades relative refs of an attachment opened by bare file name instead of resolving them in the workspace', async () => {
    const { app, body, fetchMock } = loadApp();

    // An attachment card passes the registry's bare file name: the document's
    // directory is unknown, so `img/a.png` must not become the workspace root's.
    await app.openFilePreview('report.md', 's1', 'att-1');

    expect(fetchMock.mock.calls[0][0]).toContain('/attachments/att-1/raw');
    expect(body.innerHTML).not.toContain('file-raw');
    // Relative and root-relative images are their alt text, as a text node.
    for (const alt of ['Alt A', 'space', 'raw', 'bad', 'root']) {
      expect(body.querySelector(`img[alt="${alt}"]`)).toBeNull();
      expect(body.textContent).toContain(alt);
    }
    // Remote images and links keep today's handling.
    expect(body.querySelector('img[alt="remote"]')!.getAttribute('src')).toBe('https://cdn.example.com/r.png');
    expect(body.querySelector('img[alt="protorel"]')!.getAttribute('src')).toBe('//cdn.example.com/p.png');
    // Relative links are unwrapped to their text; fragment and http(s) links stay.
    expect(body.querySelectorAll('a.rv-path')).toHaveLength(0);
    const anchors = Array.from(body.querySelectorAll('a')).map((a) => a.textContent);
    expect(anchors).toEqual(['t', 'e']);
    for (const text of ['x', 'up', 'cjk', 'rootlink']) expect(body.textContent).toContain(text);
  });

  it('keeps resolving refs of an absolute-path attachment against its own directory', async () => {
    const { app, body } = loadApp();

    await app.openFilePreview('/tmp/out/report.md', 's1', 'att-2');

    const raw = (path: string) => `/api/sessions/s1/file-raw?path=${encodeURIComponent(path)}`;
    expect(body.querySelector('img[alt="Alt A"]')!.getAttribute('src')).toBe(raw('/tmp/out/img/a.png'));
    const rel = Array.from(body.querySelectorAll('a.rv-path')).find((a) => a.textContent === 'x')!;
    expect(rel.getAttribute('data-path')).toBe('/tmp/out/guide/x.md');
    expect(rel.getAttribute('data-session-id')).toBe('s1');
  });

  it('degrades an image that fails to load to its alt text', async () => {
    const { app, body } = loadApp();

    await app.openFilePreview('docs/README.md', 's1');
    const remote = body.querySelector('img[alt="remote"]')!;
    remote.dispatchEvent(new dom.window.Event('error'));

    expect(body.querySelector('img[alt="remote"]')).toBeNull();
    expect(body.textContent).toContain('remote');
  });

  it('MD toggle flips to per-line source and back without refetching, and persists', async () => {
    const { app, body, btn, fetchMock, store } = loadApp();

    await app.openFilePreview('docs/README.md', 's1');
    app.toggleFilePreviewMd();

    const pre = body.firstElementChild as HTMLElement;
    expect(pre.matches('pre.file-preview-text')).toBe(true);
    expect(pre.querySelectorAll('.fp-line')).toHaveLength(MD_CONTENT.split('\n').length);
    expect(pre.textContent).toBe(MD_CONTENT);
    expect(store.get('codeman:filePreviewMdRendered')).toBe('0');
    expect(btn.md.getAttribute('aria-pressed')).toBe('false');
    expect(btn.lines.hidden).toBe(false);
    expect(btn.wrap.hidden).toBe(false);

    app.toggleFilePreviewMd();
    expect((body.firstElementChild as HTMLElement).matches('.file-preview-md')).toBe(true);
    expect(store.get('codeman:filePreviewMdRendered')).toBe('1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens as source when the device pref says so', async () => {
    const { app, body, btn } = loadApp({ 'codeman:filePreviewMdRendered': '0' });

    await app.openFilePreview('docs/README.md', 's1');

    expect((body.firstElementChild as HTMLElement).matches('pre.file-preview-text')).toBe(true);
    expect(btn.md.hidden).toBe(false);
    expect(btn.md.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('file viewer Lines and Wrap toggles', () => {
  it('flip classes on the <pre>, persist, and never alter the text', async () => {
    const { app, body, btn, store } = loadApp();

    await app.openFilePreview('notes.txt', 's1');

    const pre = body.firstElementChild as HTMLElement;
    expect(pre.matches('pre.file-preview-text.wrap:not(.show-lines)')).toBe(true);
    expect(pre.textContent).toBe(TXT_CONTENT);
    expect(btn.md.hidden).toBe(true);

    app.toggleFilePreviewLines();
    expect(pre.classList.contains('show-lines')).toBe(true);
    expect(store.get('codeman:filePreviewLineNumbers')).toBe('1');
    expect(btn.lines.getAttribute('aria-pressed')).toBe('true');

    app.toggleFilePreviewWrap();
    expect(pre.classList.contains('wrap')).toBe(false);
    expect(store.get('codeman:filePreviewWrap')).toBe('0');
    expect(btn.wrap.getAttribute('aria-pressed')).toBe('false');
    // Same element, no re-render: the counter gutter is CSS, not text.
    expect(body.firstElementChild).toBe(pre);
    expect(pre.textContent).toBe(TXT_CONTENT);
  });

  it('are hidden for an image and while editing', async () => {
    const { app, btn, body } = loadApp();

    await app.openFilePreview('shot.png', 's1');
    expect(btn.md.hidden && btn.lines.hidden && btn.wrap.hidden).toBe(true);

    await app.openFilePreview('notes.txt', 's1');
    expect(btn.lines.hidden).toBe(false);
    await app.enterFilePreviewEdit();
    expect(body.querySelector('textarea.file-preview-editor')).not.toBeNull();
    expect(btn.md.hidden && btn.lines.hidden && btn.wrap.hidden).toBe(true);
  });
});

/** A vendored UMD build (or sanitize-html.js), evaluated as CommonJS the way the other suites do. */
function loadCommonJs<T>(name: string): T {
  const module: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function('module', 'exports', publicFile(name))(module, module.exports);
  return module.exports as T;
}

/**
 * The SHIPPING pipeline end to end: app.js (`_renderMarkdown` and the Response
 * Viewer's message builder) with panels-ui.js mixed in, the vendored marked,
 * and DOMPurify behind the real sanitize-html.js config. `content` is what the
 * file-content route answers for every path.
 */
function loadShippingApp(content: string) {
  const createDOMPurify = loadCommonJs<(win: unknown) => unknown>('vendor/dompurify.min.js');
  const { createMarkdownSanitizer } = loadCommonJs<{ createMarkdownSanitizer: (dp: unknown) => unknown }>(
    'sanitize-html.js'
  );
  const context = vm.createContext({
    console: { ...console, warn: vi.fn(), error: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    document,
    NodeFilter: dom.window.NodeFilter,
    localStorage: { length: 0, key: vi.fn(), getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    // _sanitizeHtml fails closed without the page's sanitizer, which would make
    // every assertion below vacuous.
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      sanitizeMarkdownHtml: createMarkdownSanitizer(createDOMPurify(dom.window)),
    },
    marked: loadCommonJs('vendor/marked.min.js'),
    MobileDetection: {},
    confirm: () => true,
    fetch: vi.fn(async () =>
      jsonResponse({
        success: true,
        data: { content, totalLines: 2, size: content.length, truncated: false, extension: 'md' },
      })
    ),
  });
  vm.runInContext(
    `${constantsJs}\n${publicFile('app.js')}\n${panelsJs}\nglobalThis.__CodemanApp = CodemanApp;`,
    context,
    { filename: 'app.js' }
  );
  const CodemanApp = (context as { __CodemanApp: { prototype: object } }).__CodemanApp;

  mountPreviewDom();
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map();
  app.filePreviewContent = '';
  return app;
}

describe('file viewer markdown line breaks', () => {
  // A README hard-wrapped at the column limit: one paragraph in the source.
  const WRAPPED = 'A paragraph hard-wrapped\nat the column limit.';

  it('renders a hard-wrapped paragraph as one paragraph in the file view, while chat keeps a break per newline', async () => {
    const app = loadShippingApp(`${WRAPPED}\n`);

    await app.openFilePreview('docs/README.md', 's1');
    const para = document.querySelector('#filePreviewBody .file-preview-md p')!;
    expect(para, 'the document rendered through marked').not.toBeNull();
    expect(para.querySelector('br')).toBeNull();
    expect(para.textContent).toBe(WRAPPED);

    // The Response Viewer renders the same text the chat way, a <br> per newline.
    const message = app._buildResponseViewerMessage(WRAPPED, 'assistant', 'Claude') as HTMLElement;
    const chatPara = message.querySelector('.rv-text p')!;
    expect(chatPara.querySelectorAll('br')).toHaveLength(1);
    expect(chatPara.textContent).toBe(WRAPPED.replace('\n', ''));
  });
});

describe('FILE_PREVIEW_EXTENSIONS', () => {
  it('routes avif and ico paths to the viewer and leaves .md with the tail viewer', () => {
    const { exts } = loadApp();
    expect(exts.has('avif')).toBe(true);
    expect(exts.has('ico')).toBe(true);
    expect(exts.has('md')).toBe(false);
  });
});
