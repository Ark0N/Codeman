/**
 * @fileoverview Folding or unfolding a phone on the home screen swaps the home
 * surface in place, whichever width the page loaded at (#702).
 *
 * Both breakpoint listeners (the phone overview's `(max-width: 599px)` and the
 * desktop rail's `(min-width: 1180px)`) used to be wired from the first show of
 * their own surface. A page that loaded wide never showed the phone overview,
 * so folding it to phone width left the welcome screen up until something
 * called `showWelcome()` again. They are now installed once at startup.
 *
 * Real server, real Chromium, one page per direction, resized across 599/600
 * and 767/768 in both directions with no navigation, plus a height-only resize
 * (the on-screen keyboard) that must not re-decide the surface.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

type Surface = { welcome: boolean; overview: boolean; rail: boolean };

describe('home surface follows a fold or unfold without a reload', () => {
  let server: WebServer;
  let browser: Browser;
  let workDir: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    // One session, so the desktop rail has a row to show (it hides when empty).
    workDir = mkdtempSync(join(tmpdir(), 'home-breakpoint-'));
    const res = await fetch(`http://localhost:${server.boundPort}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workingDir: workDir }),
    });
    expect(res.ok).toBe(true);
    browser = await chromium.launch({ headless: true });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }, 60000);

  async function open(width: number, height: number): Promise<[BrowserContext, Page]> {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    // The load selects the one session; Home is where a fold has to swap surfaces.
    await page.waitForFunction(() => (window as any).app?.sessions?.size > 0, null, { timeout: 30000 });
    await page.evaluate(() => (window as any).app.goHome());
    await page.waitForFunction(
      () =>
        document.getElementById('welcomeOverlay')?.classList.contains('visible') ||
        document.getElementById('mobileOverview')?.classList.contains('visible'),
      null,
      { timeout: 30000 }
    );
    return [context, page];
  }

  const surface = (page: Page): Promise<Surface> =>
    page.evaluate(() => {
      const overview = document.getElementById('mobileOverview')!;
      const rail = document.getElementById('homeSessions')!;
      return {
        welcome: document.getElementById('welcomeOverlay')!.classList.contains('visible'),
        overview: !overview.hidden && overview.classList.contains('visible'),
        rail: !rail.hidden,
      };
    });

  /** Resize, then wait until the surface settles on what that width should show. */
  async function resizeTo(page: Page, width: number, height: number, expected: Surface) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() => surface(page), { timeout: 5000, message: `surface at ${width}x${height}` })
      .toEqual(expected);
  }

  const PHONE: Surface = { welcome: false, overview: true, rail: false };
  const TABLET: Surface = { welcome: true, overview: false, rail: false };
  const DESKTOP: Surface = { welcome: true, overview: false, rail: true };

  it('loaded wide: folding to phone width shows the phone overview, unfolding brings the welcome back', async () => {
    const [context, page] = await open(1440, 900);
    try {
      expect(await surface(page)).toEqual(DESKTOP);
      await resizeTo(page, 768, 900, TABLET);
      await resizeTo(page, 767, 900, TABLET);
      await resizeTo(page, 600, 900, TABLET);
      await resizeTo(page, 599, 900, PHONE);
      await resizeTo(page, 390, 844, PHONE);
      await resizeTo(page, 600, 900, TABLET);
      await resizeTo(page, 767, 900, TABLET);
      await resizeTo(page, 768, 900, TABLET);
      await resizeTo(page, 1440, 900, DESKTOP);
      // A straight fold, the way a real device changes posture, in one step.
      await resizeTo(page, 390, 844, PHONE);
    } finally {
      await context.close();
    }
  }, 60000);

  it('loaded narrow: unfolding to desktop width shows the welcome and the rail, folding brings the overview back', async () => {
    const [context, page] = await open(390, 844);
    try {
      expect(await surface(page)).toEqual(PHONE);
      await resizeTo(page, 599, 844, PHONE);
      await resizeTo(page, 600, 844, TABLET);
      await resizeTo(page, 767, 844, TABLET);
      await resizeTo(page, 768, 844, TABLET);
      await resizeTo(page, 1440, 900, DESKTOP);
      await resizeTo(page, 768, 900, TABLET);
      await resizeTo(page, 767, 900, TABLET);
      await resizeTo(page, 600, 900, TABLET);
      await resizeTo(page, 599, 900, PHONE);
    } finally {
      await context.close();
    }
  }, 60000);

  it('a height-only resize (the on-screen keyboard) does not re-decide the home surface', async () => {
    const [context, page] = await open(1440, 900);
    try {
      await resizeTo(page, 390, 844, PHONE);
      await page.evaluate(() => {
        const app = (window as any).app;
        app.__showWelcomeCalls = 0;
        const original = app.showWelcome;
        app.showWelcome = function (...args: unknown[]) {
          app.__showWelcomeCalls++;
          return original.apply(this, args);
        };
      });
      await page.setViewportSize({ width: 390, height: 480 });
      await page.waitForTimeout(400);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      expect(await surface(page)).toEqual(PHONE);
      expect(await page.evaluate(() => (window as any).app.__showWelcomeCalls)).toBe(0);
    } finally {
      await context.close();
    }
  }, 60000);
});
