/**
 * @fileoverview A capture drawn for a taller pane makes the client replay once.
 *
 * A visible-frame capture repaints each row at an absolute position, counting
 * up to the PANE's height. A terminal shorter than that clamps every address
 * past its own height onto its last line, so the overflow rows overwrite one
 * another and the rows underneath are lost. The client cannot see that from
 * the escape sequence, so the terminal response reports the geometry the
 * capture was taken at (`captureCols`/`captureRows`) and `selectSession`
 * replays once at the size that stuck.
 *
 * These drive the REAL client in chromium and stub only the terminal endpoint,
 * because the mismatch itself needs two viewports to stage against live tmux.
 * Without the fix the first assertion below sees one fetch instead of two.
 *
 * Port: 3252 (capture geometry retry)
 *
 * Run: npx vitest run --config config/vitest.browser.config.ts test/capture-geometry-retry.browser.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3252;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

/** A visible-frame capture: one absolutely-addressed paint per row. */
function paneSnapshot(rows: number): string {
  const parts: string[] = [];
  for (let row = 1; row <= rows; row++) parts.push(`\x1b[${row};1Hprobe-row-${row}`);
  parts.push(`\x1b[${rows};6H`);
  return parts.join('');
}

/**
 * Serve every terminal fetch from a stub reporting `captureRows`, counting the
 * fetches. The real route needs live tmux to produce a mismatched frame.
 */
async function stubTerminal(page: Page, captureRows: number, counter: { n: number; urls: string[] }) {
  await page.route('**/api/sessions/*/terminal*', async (route) => {
    counter.n += 1;
    counter.urls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          terminalBuffer: paneSnapshot(captureRows),
          status: 'idle',
          fullSize: 1024,
          retainedBytes: 1024,
          truncated: false,
          truncationReason: null,
          source: 'mux-visible',
          captureCols: 200,
          captureRows,
        },
      }),
    });
  });
}

async function openSession(page: Page): Promise<string> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 10_000 });
  // xterm is loaded from /vendor, so the terminal appears a beat after the app.
  // Without it `app.terminal.rows` reads 0 and every height comparison below
  // would pass vacuously.
  await page.waitForFunction(() => (window as unknown as { app?: { terminal?: unknown } }).app?.terminal, null, {
    timeout: 30_000,
  });
  return page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'capture-geometry-test' }),
    });
    const body = await res.json();
    return body.data?.session?.id ?? body.data?.id ?? body.id;
  });
}

/** The terminal is sized by the first select, so this only reads after one. */
async function terminalRows(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { app: { terminal?: { rows: number } } }).app.terminal?.rows ?? 0);
}

async function select(page: Page, sessionId: string, options: object = {}): Promise<void> {
  await page.evaluate(
    async ({ sid, opts }) => {
      const app = (window as unknown as { app: { selectSession: (id: string, o?: object) => Promise<void> } }).app;
      await app.selectSession(sid, opts);
    },
    { sid: sessionId, opts: options }
  );
  await page.waitForTimeout(1500);
}

async function closeSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(
    (sid: string) => fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).then(() => undefined),
    sessionId
  );
}

describe('a capture taller than the terminal', () => {
  let context: BrowserContext;
  let page: Page;

  afterAll(async () => {
    await context?.close();
  });

  it('replays once when the captured pane is taller, and stops at one retry', async () => {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);
    expect(sessionId).toBeTruthy();

    // 200 rows is taller than any terminal this viewport can produce, so the
    // trigger is the captured height alone and not a size that moved.
    const fetches = { n: 0, urls: [] as string[] };
    await stubTerminal(page, 200, fetches);
    await select(page, sessionId);

    // The terminal is sized by that select, so the premise is checkable now.
    expect(await terminalRows(page)).toBeLessThan(200);
    // One original load plus exactly one retry. `resizeRetry` caps it there:
    // the retry's own response reports the same mismatch, so an uncapped
    // implementation would loop.
    expect(fetches.n).toBe(2);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);

  it('retries at the same scope the first pass used, not a wider one', async () => {
    // The retry re-arms the full-history flag only when the pass that ran had
    // consumed it. A tab switch takes the bounded tail, so its retry must take
    // the tail too; clearing the flag unconditionally would upgrade it into a
    // fresh multi-megabyte scrollback capture the user never asked for.
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);

    const fetches = { n: 0, urls: [] as string[] };
    await stubTerminal(page, 200, fetches);

    // First select: a fresh session, so this one legitimately pulls full history
    // and its retry may do the same.
    await select(page, sessionId);
    const afterFirst = fetches.n;
    expect(afterFirst).toBe(2);

    // Re-select the SAME session. `selectSession` early-returns on an already
    // active session unless forceReload is set, and forceReload is the shape a
    // tab switch back to this session takes: `_fullHistoryLoaded` still holds
    // it, so neither this pass nor its retry should ask for full history again.
    await select(page, sessionId, { forceReload: true });
    const tabSwitchUrls = fetches.urls.slice(afterFirst);
    expect(tabSwitchUrls.length).toBe(2);
    expect(tabSwitchUrls.filter((u) => u.includes('full=1'))).toHaveLength(0);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);

  it('does not replay when the captured pane fits the terminal', async () => {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);

    // Five rows is shorter than any terminal this viewport can produce, so the
    // frame fits, nothing is clamped, and nothing needs repeating. A retry here
    // would double the work of every tab switch.
    const fetches = { n: 0, urls: [] as string[] };
    await stubTerminal(page, 5, fetches);
    await select(page, sessionId);

    expect(await terminalRows(page)).toBeGreaterThan(5);
    expect(fetches.n).toBe(1);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);
});
