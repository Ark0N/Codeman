/** @fileoverview Real Chromium coverage for split open/close orchestration and the session picker (Task 5). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3176;
const BASE_URL = `http://localhost:${PORT}`;

describe('split-pane orchestration in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  async function createShellSession(): Promise<string> {
    return page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      // POST /api/sessions nests the session under data.session, and mode:'shell'
      // does not spawn a PTY on creation alone (pid: null, no pane) — an explicit
      // POST .../shell is what actually starts it (both found and fixed by Task 4's
      // implementer against this exact pattern; carried forward here so this task
      // does not rediscover the same two bugs).
      const id = (await res.json()).data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id;
    });
  }

  it('opening and closing a split reparents and restores .terminal-wrap', async () => {
    const idA = await createShellSession();
    const idB = await createShellSession();

    await page.evaluate((id) => (window as any).app.selectSession(id), idA);
    await page.waitForFunction((id) => (window as any).app.activeSessionId === id, idA, { timeout: 10000 });

    expect(await page.evaluate(() => document.querySelector('.terminal-split-container') === null)).toBe(true);

    await page.evaluate((id) => (window as any).app.openSplitPane(id), idB);
    await page.waitForSelector('.terminal-pane-b', { timeout: 10000 });

    const duringSplit = await page.evaluate(() => ({
      hasContainer: document.querySelector('.terminal-split-container') !== null,
      wrapIsChildOfContainer: document.querySelector('.terminal-split-container > .terminal-wrap') !== null,
      hasPaneB: document.querySelector('.terminal-pane-b') !== null,
    }));
    expect(duringSplit.hasContainer).toBe(true);
    expect(duringSplit.wrapIsChildOfContainer).toBe(true);
    expect(duringSplit.hasPaneB).toBe(true);

    await page.evaluate(() => (window as any).app.closeSplitPane());
    await page.waitForFunction(() => document.querySelector('.terminal-split-container') === null, null, {
      timeout: 10000,
    });

    const afterClose = await page.evaluate(() => ({
      hasContainer: document.querySelector('.terminal-split-container') === null,
      wrapRestored: document.querySelector('.main .terminal-wrap') !== null,
    }));
    expect(afterClose.hasContainer).toBe(true);
    expect(afterClose.wrapRestored).toBe(true);

    await page.evaluate(
      async (ids) => {
        await fetch(`/api/sessions/${ids.a}`, { method: 'DELETE' });
        await fetch(`/api/sessions/${ids.b}`, { method: 'DELETE' });
      },
      { a: idA, b: idB }
    );
  });

  it('the split picker excludes the active session', async () => {
    const id = await createShellSession();

    await page.evaluate((sid) => (window as any).app.selectSession(sid), id);
    await page.waitForFunction((sid) => (window as any).app.activeSessionId === sid, id, { timeout: 10000 });

    const pickerExcludesActive = await page.evaluate((sid) => {
      (window as any).app.openSplitPicker();
      const items = Array.from(document.querySelectorAll('.split-picker-item'));
      return !items.some((el) => el.getAttribute('data-session-id') === sid);
    }, id);
    expect(pickerExcludesActive).toBe(true);

    await page.evaluate(async (sid) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, id);
  });
});
