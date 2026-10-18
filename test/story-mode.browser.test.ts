/**
 * @fileoverview Story Mode end to end: a real server (test mode: no tmux, no CLI), real Chromium, a
 * synthetic transcript (test/story-fixtures.ts) handed to the session the way Claude's hooks do it,
 * then grown while the overlay is open so the live redraw runs off real SSE events.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';
import { demoTurn, resetClock } from './story-fixtures.js';

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

describe('Story Mode in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let root: string;
  let transcript: string;
  let sessionId: string;
  let rest: unknown[];

  const kinds = () =>
    page.evaluate(() => [...document.querySelectorAll('.story-panel')].map((p) => (p as HTMLElement).dataset.kind));
  const hook = (event: string) =>
    page.evaluate(
      async ({ sid, path, ev }) => {
        await fetch('/api/hook-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: ev, sessionId: sid, data: { transcript_path: path } }),
        });
      },
      { sid: sessionId, path: transcript, ev: event }
    );

  beforeAll(async () => {
    resetClock();
    root = mkdtempSync(join(homedir(), 'story-ui-'));
    transcript = join(root, 'conversation.jsonl');
    const turn = demoTurn();
    // The turn up to the first edit's result is "running"; the rest arrives during the test.
    writeFileSync(transcript, jsonl(turn.slice(0, 14)));
    rest = turn.slice(14);

    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    sessionId = await page.evaluate(async (workingDir) => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir, mode: 'claude', name: 'story-browser' }),
      });
      return (await res.json()).data.session.id as string;
    }, root);
    await hook('stop');
    await page.evaluate(async (sid) => {
      const app = (window as any).app;
      for (let i = 0; i < 100 && !app.sessions.has(sid); i++) await new Promise((r) => setTimeout(r, 100));
      await app.selectSession(sid);
    }, sessionId);
  }, 120000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  }, 60000);

  it('is off by default: no header button', async () => {
    expect(await page.locator('.btn-story-header').isVisible()).toBe(false);
  });

  it('turning it on shows the button, and the button draws the running turn', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      const s = app.loadAppSettingsFromStorage();
      s.showStoryButton = true;
      app.saveAppSettingsToStorage(s);
      app.applyHeaderVisibilitySettings();
    });
    await page.locator('.btn-story-header').click();
    await page.waitForFunction(() => document.querySelectorAll('.story-panel').length >= 4, null, { timeout: 10000 });
    expect(await kinds()).toEqual(['mission', 'investigate', 'plan', 'backup', 'fix']);
    expect(await page.locator('.story-bar .story-live').isVisible()).toBe(true);
    expect(await page.locator('.story-pencils').count()).toBe(1);
  });

  it('redraws live when the transcript grows and a hook fires', async () => {
    appendFileSync(transcript, jsonl(rest));
    await hook('stop');
    await page.waitForFunction(() => document.querySelector('.story-panel[data-kind="complete"]'), null, {
      timeout: 15000,
    });
    expect(await kinds()).toEqual(['mission', 'investigate', 'plan', 'backup', 'loop', 'save', 'complete']);
    expect(await page.locator('.story-pencils').count()).toBe(0);
    expect(await page.locator('.story-panel.story-fresh').count()).toBeGreaterThan(0);
  });

  it('the code page opens the diff; Escape closes the drawer, then the overlay', async () => {
    await page.locator('.story-panel[data-kind="loop"] .story-hit').first().click();
    await page.waitForSelector('.story-drawer:not([hidden])');
    expect(await page.locator('.story-drawer-kind').textContent()).toBe('Diff');
    expect(await page.locator('.story-ln--add, .story-ln--del').count()).toBe(3);
    await page.keyboard.press('Escape');
    expect(await page.locator('.story-drawer').isHidden()).toBe(true);
    expect(await page.locator('#storyOverlay').isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.locator('#storyOverlay').isHidden()).toBe(true);
  });

  it('Session Options opens the story, and Save image downloads the page as a PNG', async () => {
    await page.evaluate((sid) => (window as any).app.openSessionOptions(sid), sessionId);
    await page.locator('#sessionOptionsStoryBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('.story-panel').length > 0);
    expect(await page.locator('#storyOverlay').isVisible()).toBe(true);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.story-save').click()]);
    expect(download.suggestedFilename()).toMatch(/^story-story-browser-.*\.png$/);
    const path = await download.path();
    const head = readFileSync(path!).subarray(0, 24);
    expect(head.subarray(1, 4).toString()).toBe('PNG');
    expect(head.readUInt32BE(16)).toBeGreaterThan(1000); // width, at 2x
    await page.keyboard.press('Escape');
  });

  it('fits a phone-width viewport without sideways scrolling', async () => {
    await page.setViewportSize({ width: 400, height: 860 });
    await page.evaluate((sid) => (window as any).app.openStoryMode(sid), sessionId);
    await page.waitForFunction(() => document.querySelectorAll('.story-panel').length > 0);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.story-main') as HTMLElement;
      return main.scrollWidth - main.clientWidth;
    });
    expect(overflow).toBe(0);
    // The bar keeps to three rows, and a panel below the fold gets its buttons without a scroll.
    expect(await page.evaluate(() => (document.querySelector('.story-bar') as HTMLElement).offsetHeight)).toBeLessThan(
      190
    );
    await page.waitForFunction(
      () => {
        const p = document.querySelector('.story-panel[data-kind="loop"]') as HTMLElement;
        const main = document.querySelector('.story-main') as HTMLElement;
        return p.getBoundingClientRect().top > main.getBoundingClientRect().bottom && !!p.querySelector('.story-hit');
      },
      null,
      { timeout: 10000 }
    );
    await page.evaluate(() => (window as any).app.closeStoryMode());
    await page.setViewportSize({ width: 1400, height: 950 });
  });
});
