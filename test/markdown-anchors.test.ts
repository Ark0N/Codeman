/**
 * In-document links in rendered markdown (`[Install](#installation)`).
 *
 * marked emits no heading ids, and with `<base href="/">` a bare `#installation` href points at the
 * dashboard's root, so the File Viewer's links neither found a target nor stayed on the page. The
 * helpers in constants.js give headings GitHub-style slugs (as `data-md-anchor`, never `id`) and
 * resolve a fragment to a heading inside the rendered document only.
 *
 * Builds a JSDOM window in-test under the default node env (do NOT declare a per-file jsdom
 * environment: it externalizes node:fs under vite and the readFileSync below stops working).
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const CONSTANTS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const APP = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');

interface Anchors {
  slug(text: string): string;
  assign(root: Element): void;
  find(root: Element, href: string): Element | null;
}

function boot(html: string) {
  const dom = new JSDOM(
    `<!doctype html><body><div id="settings">app element</div><div class="doc">${html}</div></body>`,
    {
      url: 'http://localhost/',
      runScripts: 'outside-only',
    }
  );
  const win = dom.window as unknown as Window & { eval(code: string): unknown; CodemanMarkdownAnchors: Anchors };
  win.eval(CONSTANTS);
  const doc = win.document.querySelector('.doc') as Element;
  return { win, doc, anchors: win.CodemanMarkdownAnchors };
}

describe('markdownHeadingSlug (GitHub rules)', () => {
  const { anchors } = boot('');
  it.each([
    ['Installation', 'installation'],
    ['Why `codeman`?', 'why-codeman'],
    ['Über uns', 'über-uns'],
    ['A  B', 'a--b'],
    ['  Trim me  ', 'trim-me'],
    ['Q&A: what, why?', 'qa-what-why'],
    ['snake_case and kebab-case', 'snake_case-and-kebab-case'],
    ['日本語 の 見出し', '日本語-の-見出し'],
    ['🚀 Launch', '-launch'],
    ['', ''],
  ])('%j -> %j', (text, slug) => expect(anchors.slug(text)).toBe(slug));
});

describe('assign + find', () => {
  const html = `
    <h1>Overview</h1><p>x</p>
    <h2>Install</h2><h2>Usage</h2><h3>Install</h3><h3>Install</h3>
    <h2>My Title</h2><a id="custom-spot"></a>`;

  it('slugs every heading, and a repeated title gets -1, -2 like GitHub', () => {
    const { doc, anchors } = boot(html);
    anchors.assign(doc);
    const slugs = [...doc.querySelectorAll('h1, h2, h3')].map((h) => (h as HTMLElement).dataset.mdAnchor);
    expect(slugs).toEqual(['overview', 'install', 'usage', 'install-1', 'install-2', 'my-title']);
    anchors.assign(doc); // idempotent
    expect([...doc.querySelectorAll('h1, h2, h3')].map((h) => (h as HTMLElement).dataset.mdAnchor)).toEqual(slugs);
  });

  it('finds a heading by its slug, case-insensitively, percent-encoded or with a space', () => {
    const { doc, anchors } = boot(html);
    const title = doc.querySelectorAll('h2')[2];
    for (const href of ['#my-title', '#My-Title', '#my%20title', '#My Title']) {
      expect(anchors.find(doc, href), href).toBe(title);
    }
    expect(anchors.find(doc, '#install-2')?.tagName).toBe('H3');
  });

  it('finds an explicit id the author wrote, and treats # as the top of the document', () => {
    const { doc, anchors } = boot(html);
    expect(anchors.find(doc, '#custom-spot')?.id).toBe('custom-spot');
    expect(anchors.find(doc, '#')).toBe(doc);
    expect(anchors.find(doc, '')).toBe(doc);
  });

  it('returns null for a fragment that matches nothing, and a malformed escape is used as written', () => {
    const { doc, anchors } = boot(html);
    expect(anchors.find(doc, '#nope')).toBeNull();
    expect(() => anchors.find(doc, '#%E0%A4%A')).not.toThrow();
  });

  it('never resolves against the app: a heading cannot claim an element id outside the document', () => {
    const { doc, anchors } = boot('<h1>Settings</h1>');
    const found = anchors.find(doc, '#settings');
    expect(found?.tagName).toBe('H1'); // the heading, not <div id="settings"> in the app
    expect(found?.id).toBe(''); // and the heading was not given an id
  });
});

describe('the click delegate', () => {
  it('handles fragment links before anything that would let the browser follow them', () => {
    const delegate = APP.slice(APP.indexOf('_bindResponseViewerInteractions(body) {'));
    const fragment = delegate.indexOf('a[href^="#"]');
    expect(fragment).toBeGreaterThan(-1);
    // After file-path links (their href is '#', they open the preview) and before the loopback/new-tab handling.
    expect(fragment).toBeGreaterThan(delegate.indexOf("closest('a.rv-path')"));
    expect(fragment).toBeLessThan(delegate.indexOf('openLinkThroughWebTabIfLoopback'));
    expect(delegate.slice(fragment, fragment + 400)).toContain('preventDefault');
  });
});
