/**
 * @fileoverview Case sync across two devices, end to end: a real server on an ephemeral port (isolated test
 * HOME) and two separate Chromium contexts (each with its own localStorage, like two devices). Saves of
 * different cases from both contexts both land, the other context takes them on returning to its tab, and
 * once the server says sync is off the selected case stops following.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';
import { getCasesDir } from '../src/config/cases-dir.js';

describe('Sync cases across devices in two browsers', () => {
  let server: WebServer;
  let browser: Browser;
  let a: Page;
  let b: Page;
  const one = `sync-a-${process.pid}`;
  const two = `sync-b-${process.pid}`;
  const base = () => `http://localhost:${server.boundPort}`;
  const put = (body: unknown) =>
    fetch(`${base()}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const serverSettings = async () => ((await (await fetch(`${base()}/api/settings`)).json()) as any).data;
  const open = async () => {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(base(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    return page;
  };
  const opts = (page: Page, name: string) => page.evaluate((n) => (window as any).app.getCaseSettings(n), name);
  const returnToTab = (page: Page) =>
    page.evaluate(async () => {
      const app = (window as any).app;
      await app._syncCaseStateFromServer();
    });

  beforeAll(async () => {
    for (const name of [one, two]) mkdirSync(join(getCasesDir(), name), { recursive: true });
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    await put({ syncCaseState: true });
    a = await open();
    b = await open();
    for (const page of [a, b]) {
      await page.evaluate(async () => {
        const app = (window as any).app;
        await app.loadAppSettingsFromServer();
      });
    }
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  it("keeps both devices' saves and lets the other device take them", async () => {
    await Promise.all([
      a.evaluate((n) => (window as any).app.saveCaseSettings(n, { agentTeams: true, opusContext1m: false }), one),
      b.evaluate((n) => (window as any).app.saveCaseSettings(n, { agentTeams: false, opusContext1m: false }), two),
    ]);
    await expect
      .poll(async () => Object.keys((await serverSettings()).caseSettings ?? {}).sort(), { timeout: 10000 })
      .toEqual([one, two].sort());
    await returnToTab(b);
    await returnToTab(a);
    expect(await opts(b, one)).toEqual({ agentTeams: true, opusContext1m: false });
    expect(await opts(a, two)).toEqual({ agentTeams: false, opusContext1m: false });
  });

  it('follows the selected case while sync is on, and stops once the server says it is off', async () => {
    await put({ lastPickedCase: two });
    await returnToTab(a);
    expect(await a.evaluate(() => (document.getElementById('quickStartCase') as HTMLSelectElement).value)).toBe(two);

    await put({ syncCaseState: false, lastPickedCase: one });
    await returnToTab(a);
    expect(await a.evaluate(() => (document.getElementById('quickStartCase') as HTMLSelectElement).value)).toBe(two);
    expect(await a.evaluate(() => (window as any).app.loadAppSettingsFromStorage().syncCaseState)).toBe(false);
  });
});
