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

  it('leaves text with no path untouched', () => {
    const root = linkify('<p>Ratio 3/4 on 2026/08/16, see src/app.ts</p>');

    expect(paths(root)).toHaveLength(0);
    expect(root.textContent).toBe('Ratio 3/4 on 2026/08/16, see src/app.ts');
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
    expect(APP_SOURCE).toMatch(/openFilePreview\(filePath, pathLink\.dataset\.sessionId \|\| this\.activeSessionId\)/);
  });
});
