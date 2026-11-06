/**
 * Clicking a link to another heading of the SAME markdown file in the File Viewer must scroll to
 * that heading. It did nothing: marked emits no heading ids, and with `<base href="/">` a bare
 * `#section` href is not an in-page link anyway. Real xterm-free browser, real preview overlay,
 * real click.
 *
 * Browser-driven, so excluded from `npm run test:ci` (config/test-suites.ts). Run locally:
 *   npm run test:browser -- test/markdown-anchor-links.browser.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i} of filler text so the document is taller than the viewer.`).join(
    '\n\n'
  );

describe('in-document links in the markdown File Viewer', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(homedir(), 'md-anchors-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'README.md'),
      [
        '# Title',
        '',
        '[Usage](#usage) · [Second install](#install-1) · [Mixed case](#My-Title) · [Encoded](#my%20title) · [Nowhere](#nope) · [Top](#)',
        '',
        '## Install',
        filler(30),
        '## Usage',
        filler(30),
        '## Install',
        filler(30),
        '## My Title',
        filler(30),
        '## Settings',
        filler(10),
      ].join('\n')
    );
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
    // Reduced motion makes the scroll instant (the code uses behavior 'auto' for it), so the
    // position can be read right after the click instead of racing a smooth-scroll animation.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    const sessionId = await page.evaluate(async (workingDir) => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir, mode: 'shell' }),
      });
      const id = (await res.json()).data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id as string;
    }, root);
    await page.evaluate(async (sid) => {
      const app = (window as any).app;
      for (let i = 0; i < 100 && !app.sessions.has(sid); i++) await new Promise((r) => setTimeout(r, 100));
      await app.selectSession(sid);
    }, sessionId);
    await page.evaluate(({ sid, path }) => (window as any).app.openFilePreview(path, sid), {
      sid: sessionId,
      path: join(root, 'README.md'),
    });
    await page.waitForSelector('#filePreviewBody .file-preview-md h2');
    // A marker that a full navigation would wipe.
    await page.evaluate(() => ((window as any).__stillHere = true));
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  }, 60000);

  const state = () =>
    page.evaluate(() => {
      const body = document.getElementById('filePreviewBody')!;
      return {
        scrollTop: body.scrollTop,
        stillHere: (window as any).__stillHere === true,
        url: location.href,
        bodyTop: body.getBoundingClientRect().top,
      };
    });
  /** How far the nth heading's top is from the top of the scrolling viewer, in px. */
  const headingOffset = (text: string, nth = 0) =>
    page.evaluate(
      ({ text, nth }) => {
        const body = document.getElementById('filePreviewBody')!;
        const hs = [...body.querySelectorAll('.file-preview-md h1, .file-preview-md h2')].filter(
          (h) => h.textContent === text
        );
        return Math.round(hs[nth].getBoundingClientRect().top - body.getBoundingClientRect().top);
      },
      { text, nth }
    );
  const click = async (name: string) => {
    // A DOM click: Playwright's own click scrolls the link into view first, which would move the
    // very scroll position these tests measure.
    await page.locator(`#filePreviewBody a:text-is("${name}")`).evaluate((a) => (a as HTMLElement).click());
    await page.waitForTimeout(100);
  };

  it('scrolls to the heading a link names, and stays on the page', async () => {
    const before = await state();
    expect(before.scrollTop).toBe(0);
    await click('Usage');
    const after = await state();
    expect(after.scrollTop).toBeGreaterThan(500);
    expect(Math.abs(await headingOffset('Usage'))).toBeLessThan(60); // the heading is at the top of the viewer
    expect(after.stillHere).toBe(true); // no navigation
    expect(after.url).toBe(before.url);
  });

  it('a repeated heading is reachable as slug-1, as on GitHub', async () => {
    await page.evaluate(() => (document.getElementById('filePreviewBody')!.scrollTop = 0));
    await click('Second install');
    expect(Math.abs(await headingOffset('Install', 1))).toBeLessThan(60);
  });

  it('matches case-insensitively and with an encoded space', async () => {
    for (const name of ['Mixed case', 'Encoded']) {
      await page.evaluate(() => (document.getElementById('filePreviewBody')!.scrollTop = 0));
      await click(name);
      expect(Math.abs(await headingOffset('My Title')), name).toBeLessThan(60);
    }
  });

  it('a link to nowhere does nothing (no scroll, no navigation), and # goes back to the top', async () => {
    await page.evaluate(() => (document.getElementById('filePreviewBody')!.scrollTop = 0));
    await click('Nowhere');
    const stay = await state();
    expect(stay.scrollTop).toBe(0);
    expect(stay.stillHere).toBe(true);

    await click('Usage');
    expect((await state()).scrollTop).toBeGreaterThan(500);
    await page.evaluate(() => (document.getElementById('filePreviewBody')!.scrollTop = 99999));
    await page.evaluate(() => document.querySelector('#filePreviewBody a:not([data-path])')!.scrollIntoView());
    await click('Top');
    expect((await state()).scrollTop).toBeLessThan(5);
  });

  it('a heading cannot capture an element of the app by id (Settings heading, no id given)', async () => {
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('#filePreviewBody h1, #filePreviewBody h2')].map((h) => h.id)
    );
    expect(ids.every((id) => id === '')).toBe(true);
  });
});
