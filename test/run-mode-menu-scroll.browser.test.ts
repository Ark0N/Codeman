/**
 * Run dropdown on a phone, mixing the stock CLIs with custom-endpoint entries: it must fit the
 * screen and scroll by touch, so the first and the last entry can both be reached.
 *
 * Before the fix the menu (anchored `bottom: 100%`) had no max-height and no overflow, so with
 * enough entries its top ran off the top of the screen and could not be scrolled to.
 *
 * Browser-driven, so excluded from `npm run test:ci` (config/test-suites.ts). Run locally:
 *   npm run test:browser -- test/run-mode-menu-scroll.browser.test.ts
 *
 * Port: ephemeral (`new WebServer(0, …)`, read back through `boundPort`)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

describe('Run dropdown on a phone', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 640 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    page = await context.newPage();
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  /** Open the menu with `extra` generated custom-endpoint entries, as _refreshCustomModelRunOptions builds them. */
  async function openWithEntries(extra: number) {
    await page.evaluate((count) => {
      const menu = document.getElementById('runModeMenu')!;
      const box = document.getElementById('runModeCustomModels')!;
      box.innerHTML = Array.from(
        { length: count },
        (_, i) =>
          `<button class="run-mode-option" data-test-entry="${i}"><span class="run-mode-dot claude"></span>Claude Code (endpoint ${i})</button>`
      ).join('');
      document.getElementById('runModeCustomModelSep')!.style.display = '';
      document.getElementById('runModeCustomModelHeader')!.style.display = '';
      menu.classList.add('active');
    }, extra);
  }

  const geometry = () =>
    page.evaluate(() => {
      const menu = document.getElementById('runModeMenu')!;
      const r = menu.getBoundingClientRect();
      // The menu sits just above the Run button, which is inside the toolbar.
      const anchor = menu.parentElement!.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        anchorTop: anchor.top,
        scrollTop: menu.scrollTop,
        scrollHeight: menu.scrollHeight,
        clientHeight: menu.clientHeight,
        viewport: window.innerHeight,
        overflowY: getComputedStyle(menu).overflowY,
      };
    });

  const visible = (selector: string) =>
    page.evaluate((sel) => {
      const menu = document.getElementById('runModeMenu')!.getBoundingClientRect();
      const el = document.querySelector(sel)!.getBoundingClientRect();
      return el.top >= menu.top - 1 && el.bottom <= menu.bottom + 1 && el.top >= 0;
    }, selector);

  it('stays on screen however many entries there are, and becomes scrollable', async () => {
    await openWithEntries(30);
    const g = await geometry();
    expect(g.overflowY).toBe('auto');
    expect(g.top).toBeGreaterThanOrEqual(0); // the top is not off the top of the screen
    expect(g.bottom).toBeLessThanOrEqual(g.anchorTop); // above the Run button, not over it
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight); // there is something to scroll to
  });

  it('a touch swipe scrolls it, and the last entry can be reached', async () => {
    await openWithEntries(30);
    expect(await visible('[data-test-entry="29"]')).toBe(false); // starts out of reach
    // Real touch input (touchstart / touchmove / touchend), not scrollTo(): this is the path a
    // finger takes, and the one a missing overflow or `touch-action` would block.
    const cdp = await page.context().newCDPSession(page);
    const g = await geometry();
    const y0 = (g.top + g.bottom) / 2 + 100;
    for (let swipe = 0; swipe < 6; swipe += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: y0 }] });
      for (let step = 1; step <= 12; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: 100, y: y0 - step * 20 }], // finger moves up: content scrolls down
        });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(300);
    }
    const after = await geometry();
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(await visible('[data-test-entry="29"]')).toBe(true);
    // Scrolling the menu must not have scrolled the page behind it.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  it('a short menu is not stretched or squashed (no scrollbar when it fits)', async () => {
    await openWithEntries(0);
    await page.evaluate(() => {
      document.getElementById('runModeCustomModelSep')!.style.display = 'none';
      document.getElementById('runModeCustomModelHeader')!.style.display = 'none';
    });
    const g = await geometry();
    expect(g.scrollHeight).toBeLessThanOrEqual(g.clientHeight + 1);
  });
});
