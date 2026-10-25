/**
 * @fileoverview Right-to-left text in rendered markdown (`CodemanApp._renderMarkdown`, issue #715).
 *
 * The Response Viewer and the File Viewer's markdown view rendered every block left to
 * right, so a Persian, Arabic or Hebrew answer was left-aligned, its punctuation landed on
 * the wrong end and its list markers sat on the left. `_renderMarkdown` now gives each
 * OUTERMOST prose block `dir="auto"` (the browser picks the direction from the block's own
 * first letter) and pins code to `dir="ltr"`, which also keeps a code span from deciding a
 * sentence's direction, since `dir="auto"` skips descendants that carry a `dir`.
 *
 * jsdom does not resolve `dir="auto"`, so this pins the attributes the browser acts on;
 * what Chromium makes of them was checked by eye when the change was made.
 *
 * Drives the SHIPPING artifacts (vendored `marked`, vendored DOMPurify + `sanitize-html.js`,
 * `constants.js` and `app.js`) in a `vm` with a jsdom document, the technique from
 * response-viewer-external-links.test.ts. No port / server needed.
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

function loadShippingMarked(): { parse: (src: string, opts?: unknown) => string } {
  const module: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function('module', 'exports', publicFile('vendor/marked.min.js'))(module, module.exports);
  return module.exports as { parse: (src: string, opts?: unknown) => string };
}

type RenderApp = {
  _renderMarkdown(text: string, opts?: { breaks?: boolean }): string;
  _linkifyFilePaths(root: unknown): void;
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
    document,
    NodeFilter,
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    // _sanitizeHtml fails closed without the sanitizer, which would make every
    // assertion below vacuous.
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
const app = Object.create(CodemanApp.prototype) as RenderApp;

/** Render markdown the way the response viewer does and return the resulting element. */
function render(markdown: string, opts?: { breaks?: boolean }): HTMLElement {
  const root = document.createElement('div');
  root.className = 'rv-text';
  root.innerHTML = app._renderMarkdown(markdown, opts);
  return root as unknown as HTMLElement;
}

const dirOf = (el: Element | null) => el?.getAttribute('dir') ?? null;

describe('response viewer right-to-left text (#715)', () => {
  it('lets every top-level prose block pick its own direction', () => {
    const root = render(
      [
        '# عنوان',
        '',
        'سلام، این یک تست است.',
        '',
        'An English paragraph.',
        '',
        '- مورد اول',
        '- مورد دوم',
        '',
        '1. one',
        '',
        '> نقل قول',
      ].join('\n')
    );

    expect(dirOf(root.querySelector('h1'))).toBe('auto');
    const paragraphs = Array.from(root.querySelectorAll(':scope > p'));
    expect(paragraphs).toHaveLength(2);
    for (const p of paragraphs) expect(dirOf(p)).toBe('auto');
    expect(dirOf(root.querySelector('ul'))).toBe('auto');
    expect(dirOf(root.querySelector('ol'))).toBe('auto');
    expect(dirOf(root.querySelector('blockquote'))).toBe('auto');
  });

  it('leaves nested blocks to inherit, so a list keeps its markers and indent on one side', () => {
    // A `dir="auto"` per item would resolve each item on its own while the list's
    // padding stays on the list's side, which hung RTL markers outside the box.
    const root = render(['- مورد اول', '  - تو در تو', '', '> پاراگراف اول', '>', '> پاراگراف دوم'].join('\n'));

    for (const li of Array.from(root.querySelectorAll('li'))) expect(li.hasAttribute('dir')).toBe(false);
    expect(root.querySelector('ul ul')?.hasAttribute('dir')).toBe(false);
    for (const p of Array.from(root.querySelectorAll('blockquote p'))) expect(p.hasAttribute('dir')).toBe(false);
  });

  it('gives a table its direction on the scroll wrapper, so an RTL table scrolls from its first column', () => {
    const root = render('| ستون | مقدار |\n| --- | --- |\n| الف | ۱ |');

    const wrap = root.querySelector('.rv-table-wrap');
    expect(wrap, 'tables are still wrapped').not.toBeNull();
    expect(dirOf(wrap)).toBe('auto');
    expect(root.querySelector('table')?.hasAttribute('dir')).toBe(false);
    for (const cell of Array.from(root.querySelectorAll('th, td'))) expect(cell.hasAttribute('dir')).toBe(false);
  });

  it('pins code blocks and inline code left to right', () => {
    const root = render('`npm install` را اجرا کن.\n\n```\nconst a = 1;\n```');

    expect(dirOf(root.querySelector('p > code'))).toBe('ltr');
    expect(dirOf(root.querySelector('pre'))).toBe('ltr');
    // The code-block toolbar shares the template walk; it must survive the new pass.
    expect(root.querySelector('.rv-code-wrap .rv-copy-btn')).not.toBeNull();
    expect(root.querySelector('.rv-code-wrap')?.hasAttribute('dir')).toBe(false);
  });

  it('keeps a dir the agent wrote, and what it covers', () => {
    // The sanitizer allows `dir`; an explicit choice must not be replaced by a guess.
    const root = render('<div dir="rtl"><p>inherits</p></div>\n\n<p dir="ltr">explicit</p>');

    expect(dirOf(root.querySelector('div[dir]'))).toBe('rtl');
    expect(root.querySelector('div[dir] > p')?.hasAttribute('dir')).toBe(false);
    expect(dirOf(Array.from(root.querySelectorAll('p')).find((p) => p.textContent === 'explicit') ?? null)).toBe('ltr');
  });

  it('does the same for the File Viewer markdown view (breaks: false)', () => {
    const root = render('پاراگراف اول\nادامه همان پاراگراف', { breaks: false });

    expect(dirOf(root.querySelector('p'))).toBe('auto');
  });

  it('pins a linkified file path left to right, so it does not decide the sentence direction', () => {
    const root = render('فایل /home/user/project/config.json را باز کن.');
    app._linkifyFilePaths(root);

    const link = root.querySelector('a.rv-path');
    expect(link?.textContent).toBe('/home/user/project/config.json');
    expect(dirOf(link)).toBe('ltr');
  });

  it('does not pin a markdown link label, which is prose in the sentence language', () => {
    const root = render('[گزارش حادثه](/tmp/report.json)');
    app._linkifyFilePaths(root);

    const link = root.querySelector('a.rv-path-link');
    expect(link, 'a path-target link takes the rv-path shape').not.toBeNull();
    expect(link?.hasAttribute('dir')).toBe(false);
  });
});
