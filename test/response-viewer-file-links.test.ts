/**
 * @fileoverview Response-viewer file-path linkifier (`CodemanApp._linkifyFilePaths`).
 *
 * The viewer renders markdown, so a path an agent wrote — "wrote the chart to
 * /tmp/.../chart.png" — arrived as inert text: the terminal's link provider
 * never sees the chat, and the file it just produced was a copy-paste away
 * instead of a click. The linkifier wraps those paths in an anchor the click
 * delegate hands to the file-preview overlay.
 *
 * Two properties matter more than the linking itself and are pinned here:
 *
 *  1. **The text is untouched.** Anchors are built from TEXT NODES with DOM
 *     APIs, never by rebuilding already-sanitized markup as a string, so the
 *     message reads identically and "copy code" still yields exactly what the
 *     agent printed.
 *  2. **Model output cannot become markup.** The source is model text; a
 *     path-shaped string carrying HTML must stay text.
 *
 * Loaded via `vm` with a jsdom document injected (same technique as
 * connection-indicator.test.ts — no per-file jsdom environment, which would
 * externalize node:fs under vite).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const { document, NodeFilter } = dom.window;

function loadCodemanAppClass() {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
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
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: { prototype: { _linkifyFilePaths(root: unknown): void } } }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();
const APP_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

/** Render `html` into a detached .rv-text div and run the linkifier over it. */
function linkify(html: string): HTMLElement {
  const app = Object.create(CodemanApp.prototype) as { _linkifyFilePaths(root: unknown): void };
  const root = document.createElement('div');
  root.className = 'rv-text';
  root.innerHTML = html;
  app._linkifyFilePaths(root);
  return root as unknown as HTMLElement;
}

const paths = (root: HTMLElement) => Array.from(root.querySelectorAll('a.rv-path'));

describe('response viewer file-path linkifier', () => {
  it('links an absolute path written as prose', () => {
    const path = '/tmp/claude-1000/-home-arkon-default-claudeman/7b3fefd2/scratchpad/probe-run-native.png';
    const root = linkify(`<p>Saved the capture to ${path} — have a look.</p>`);

    const links = paths(root);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('data-path')).toBe(path);
    expect(links[0].textContent).toBe(path);
    expect(root.textContent).toBe(`Saved the capture to ${path} — have a look.`);
  });

  it('links a path inside inline code, which is how agents usually write one', () => {
    const root = linkify('<p>See <code>/home/a/out/report.pdf</code> for the numbers.</p>');

    const links = paths(root);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('data-path')).toBe('/home/a/out/report.pdf');
    // Still inside the <code> span — the code styling is not lost.
    expect(links[0].closest('code')).not.toBeNull();
  });

  it('links every path in one text node and preserves the text between them', () => {
    const root = linkify('<p>Compare /tmp/before.png with /tmp/after.png please</p>');

    expect(paths(root).map((a) => a.getAttribute('data-path'))).toEqual(['/tmp/before.png', '/tmp/after.png']);
    expect(root.textContent).toBe('Compare /tmp/before.png with /tmp/after.png please');
  });

  it('never re-cuts text already inside an anchor', () => {
    // marked autolinks URLs; a path-looking tail inside one must stay whole, and
    // a nested <a> is invalid markup that would swallow the outer link's click.
    // ⚠️ The URL's tail MUST be a string the pattern matches on its own
    // (`/tmp/...` here): with an unmatchable tail this test passes with the
    // inside-anchor guard deleted, i.e. it pins nothing.
    const root = linkify('<p><a href="https://example.com/tmp/shot.png">https://example.com/tmp/shot.png</a></p>');

    expect(paths(root)).toHaveLength(0);
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(root.querySelector('a')!.getAttribute('href')).toBe('https://example.com/tmp/shot.png');
  });

  it('turns a markdown link to a path into a preview link, not a same-origin navigation', () => {
    // Codex cites files as `[label](/abs/path)`: left alone, the href resolved
    // against Codeman's origin and opened a 404 JSON page in a new tab.
    const path = '/home/me/llm-bench/runs/crash-20261017/incident-summary.json';
    const root = linkify(
      `<p><a href="${path}" target="_blank" rel="noopener noreferrer">Our incident record</a> and ` +
        `<a href="src/a%20b.ts:42:7">a b</a>, <a href="docs/#L3">docs</a>, <a href="/tmp/renders">renders</a>, ` +
        `<a href="/tmp/release%3A12">release</a>, <a href="/tmp/a.json?raw=true">raw</a>, <a href="/tmp/">tmp</a></p>`
    );

    const links = paths(root);
    expect(links.map((a) => a.getAttribute('data-path'))).toEqual([
      path,
      'src/a b.ts',
      'docs/',
      '/tmp/renders',
      // An encoded colon is part of the name, never a line suffix.
      '/tmp/release:12',
      // A query names a view of the file, not the file.
      '/tmp/a.json',
      '/tmp/',
    ]);
    for (const a of links) {
      expect(a.getAttribute('href')).toBe('#');
      expect(a.hasAttribute('target')).toBe(false);
      expect(a.hasAttribute('rel')).toBe(false);
      expect(a.getAttribute('data-linkified')).toBe('1');
    }
    expect(links[0].textContent).toBe('Our incident record');
    // A label, not a path: the second class keeps it in the prose font (styles.css).
    expect(links.every((a) => a.classList.contains('rv-path-link'))).toBe(true);
    // A trailing slash and a rooted folder path without one both open the folder grid
    // (`:` ends a folder match in findFilePathLinks, so `release:12` previews instead).
    // findFilePathLinks finds no folder in a bare `/tmp/`, so only the trailing-slash
    // check marks that one.
    expect(links.map((a) => a.hasAttribute('data-folder'))).toEqual([false, false, true, true, false, false, true]);
  });

  it('opens a clicked markdown path link in the file preview through the click delegate', () => {
    const app = Object.create(CodemanApp.prototype) as {
      activeSessionId: string;
      openFilePreview: ReturnType<typeof vi.fn>;
      openFolderGrid: ReturnType<typeof vi.fn>;
      _linkifyFilePaths(root: unknown): void;
      _bindResponseViewerInteractions(body: unknown): void;
    };
    app.activeSessionId = 'sess-1';
    app.openFilePreview = vi.fn();
    app.openFolderGrid = vi.fn();
    const body = document.createElement('div');
    body.innerHTML = '<p><a href="/home/me/run/summary.json" target="_blank">Our incident record</a></p>';
    app._linkifyFilePaths(body);
    app._bindResponseViewerInteractions(body);

    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    body.querySelector('a')!.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(app.openFilePreview).toHaveBeenCalledWith('/home/me/run/summary.json', 'sess-1');
    expect(app.openFolderGrid).not.toHaveBeenCalled();
  });

  it('keeps web, mail, protocol-relative and fragment links as they are', () => {
    const hrefs = ['https://example.com/a.json', 'mailto:me@example.com', '//cdn.example.com/x.js', '#section'];
    const root = linkify(`<p>${hrefs.map((h) => `<a href="${h}">x</a>`).join(' ')}</p>`);

    expect(paths(root)).toHaveLength(0);
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(hrefs);
  });

  it('reads a scheme split by a tab as the URL the browser would open', () => {
    // The URL parser drops tabs, so this is http://localhost:5173/a, never a relative file.
    const root = linkify('<p><a href="http&#9;://localhost:5173/a">local</a></p>');

    expect(paths(root)).toHaveLength(0);
    expect(root.querySelector('a')!.getAttribute('href')).toBe('http\t://localhost:5173/a');
  });

  it('leaves text with no path untouched', () => {
    const root = linkify('<p>Ratio 3/4 on 2026/08/16, see the app</p>');

    expect(paths(root)).toHaveLength(0);
    expect(root.textContent).toBe('Ratio 3/4 on 2026/08/16, see the app');
  });

  it('links ~/ and relative paths too, the same forms the terminal links', () => {
    const root = linkify(
      '<p>Attached <code>~/repos/x/garage.png</code>, wrote builds/captures/a.png (see src/app.ts)</p>'
    );

    expect(paths(root).map((a) => a.getAttribute('data-path'))).toEqual([
      '~/repos/x/garage.png',
      'builds/captures/a.png',
      'src/app.ts',
    ]);
    expect(root.textContent).toBe('Attached ~/repos/x/garage.png, wrote builds/captures/a.png (see src/app.ts)');
    expect(paths(root).every((a) => a.getAttribute('data-linkified') === '1')).toBe(true);
  });

  it('never linkifies /etc paths — the server blocks the whole tree, so the link could only 403', () => {
    // /etc sits in DEFAULT_BLOCKED_TREES (config/attachment-guard.ts); it used
    // to be a root in the shared pattern, which made every /etc link a
    // guaranteed-dead click on both surfaces.
    const root = linkify('<p>Check /etc/hosts and /etc/app/config.json for the mapping.</p>');

    expect(paths(root)).toHaveLength(0);
    expect(root.textContent).toBe('Check /etc/hosts and /etc/app/config.json for the mapping.');
  });

  it('cannot turn model text into markup', () => {
    // The anchor is built with createElement + textContent, so even a
    // path-shaped payload stays text. (`<` also ends a match, so the linkifier
    // never spans into it in the first place.)
    const root = linkify('<p>/tmp/x.png&lt;img src=x onerror=alert(1)&gt;.png</p>');

    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>.png');
    for (const link of paths(root)) {
      expect(link.innerHTML).toBe(link.textContent);
    }
  });

  it('is wired into message rendering and the click delegate', () => {
    // The linkifier is only reachable through these two call sites; losing
    // either leaves inert paths (no linkify) or dead links (no handler).
    expect(APP_SOURCE).toContain('this._linkifyFilePaths(renderedText)');
    expect(APP_SOURCE).toMatch(/closest\('a\.rv-path'\)/);
    expect(APP_SOURCE).toMatch(/const sessionId = pathLink\.dataset\.sessionId \|\| this\.activeSessionId;/);
    // Only the linkifier's own links are resolved; a markdown document's rebased
    // links keep the path the rebase computed.
    expect(APP_SOURCE).toMatch(
      /pathLink\.dataset\.linkified \? this\._resolveLinkedFilePath\?\.\(filePath, sessionId\) : filePath/
    );
    expect(APP_SOURCE).toMatch(/openFilePreview\(target \|\| filePath, sessionId\)/);
  });
});
