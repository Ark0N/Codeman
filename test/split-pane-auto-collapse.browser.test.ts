// test/split-pane-auto-collapse.browser.test.ts
/** @fileoverview Real Chromium coverage for split auto-collapse when either session ends (Task 6). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3177;
const BASE_URL = `http://localhost:${PORT}`;

describe('split-pane auto-collapse in a real browser', () => {
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

  it('deleting the Pane B session auto-collapses the split', async () => {
    const idA = await createShellSession();
    const idB = await createShellSession();

    await page.evaluate((id) => (window as any).app.selectSession(id), idA);
    await page.waitForFunction((id) => (window as any).app.activeSessionId === id, idA, { timeout: 10000 });
    await page.evaluate((id) => (window as any).app.openSplitPane(id), idB);
    await page.waitForSelector('.terminal-pane-b', { timeout: 10000 });

    // Delete Pane B's session from "outside" (simulating the SSE event another
    // client's delete would produce, by hitting the DELETE route directly).
    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, idB);
    await page.waitForFunction(() => document.querySelector('.terminal-split-container') === null, null, {
      timeout: 10000,
    });

    const collapsed = await page.evaluate(() => ({
      hasContainer: document.querySelector('.terminal-split-container') === null,
      splitPaneNulled: (window as any).app._splitPane === null,
    }));
    expect(collapsed.hasContainer).toBe(true);
    expect(collapsed.splitPaneNulled).toBe(true);

    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, idA);
  });
});
