/**
 * @fileoverview A tab switch to a pane with no tmux scrollback takes the small capture.
 *
 * After the first select of a page, a tab switch to a non-shell session used to
 * fetch a 1 MiB tail of the server's byte stream. For a fullscreen claude pane
 * (alternate screen, `#{history_size}` 0) that tail is old repaints of one frame:
 * measured on live panes it cost 250-1070 ms on the server and 70-510 ms to
 * parse, and an idle tab parsed it twice (the cached copy, then the fresh one,
 * which never matched). The `full=1` capture of such a pane is the visible
 * frame, a few KB, so `selectSession` now takes it whenever the session's last
 * capture reported `paneHistoryLines: 0`, and goes back to the tail as soon as a
 * capture reports scrollback again.
 *
 * Drives the real client in chromium against a testMode server, with the
 * terminal route stubbed (the real one needs live tmux to report a hollow pane).
 *
 * Port: ephemeral (`new WebServer(0, …)`, read back through `boundPort`)
 *
 * Run: npm run test:browser -- test/fullscreen-tab-switch-capture.browser.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

let server: WebServer;
let browser: Browser;

beforeAll(async () => {
  server = new WebServer(0, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

/** What each session's pane reports, set by the test as the "pane" changes. */
type PaneHistory = Record<string, number | undefined>;

/**
 * Serve every terminal fetch from a stub and log which shape was asked for.
 * `source` follows the real route: `full=1` answers `mux-full-history`, anything
 * else `mux-visible`. No capture geometry, so the geometry retry stays out of it.
 */
async function stubTerminal(page: Page, history: PaneHistory, log: string[]) {
  await page.route('**/api/sessions/*/terminal*', async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/')[3];
    const full = url.searchParams.get('full') === '1';
    log.push(`${id}:${full ? 'full' : 'tail'}`);
    const frame = `frame of ${id}\r\n`;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          terminalBuffer: full ? frame : `${'old repaint\r\n'.repeat(50)}${frame}`,
          status: 'idle',
          fullSize: full ? frame.length : 5 * 1024 * 1024,
          retainedBytes: full ? frame.length : 1024 * 1024,
          truncated: !full,
          truncationReason: full ? null : 'tail',
          source: full ? 'mux-full-history' : 'mux-visible',
          paneHistoryLines: history[id],
        },
      }),
    });
  });
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 10_000 });
  await page.waitForFunction(() => (window as unknown as { app?: { terminal?: unknown } }).app?.terminal, null, {
    timeout: 30_000,
  });
}

async function createSession(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: n }),
    });
    const body = await res.json();
    return body.data?.session?.id ?? body.data?.id ?? body.id;
  }, name);
}

async function select(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (sid) => {
    const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
    await app.selectSession(sid);
  }, sessionId);
}

async function deleteSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(
    (sid: string) => fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).then(() => undefined),
    sessionId
  );
}

describe('tab switch to a pane that keeps no scrollback', () => {
  it('takes the small full capture on every switch, and the tail again once the pane keeps history', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await openApp(page);
    const hollow = await createSession(page, 'fullscreen-claude');
    const inline = await createSession(page, 'inline-claude');
    const history: PaneHistory = { [hollow]: 0, [inline]: 40_000 };
    const log: string[] = [];
    await stubTerminal(page, history, log);

    // First select of each on this page: the canonical full replay, as before.
    await select(page, hollow);
    await select(page, inline);
    expect(log).toEqual([`${hollow}:full`, `${inline}:full`]);

    // Switching back: the hollow pane takes the frame, the inline one the tail.
    log.length = 0;
    await select(page, hollow);
    await select(page, inline);
    await select(page, hollow);
    expect(log).toEqual([`${hollow}:full`, `${inline}:tail`, `${hollow}:full`]);

    // The pane starts keeping history (claude switched to its inline view). The
    // switch that learns it is still a full capture, which is the canonical
    // load anyway; the one after goes back to the bounded tail.
    history[hollow] = 1200;
    log.length = 0;
    await select(page, inline);
    await select(page, hollow);
    await select(page, inline);
    await select(page, hollow);
    expect(log).toEqual([`${inline}:tail`, `${hollow}:full`, `${inline}:tail`, `${hollow}:tail`]);

    // Unknown is never treated as empty: a response without the field (an
    // older server, a byte-history fallback) keeps the tail.
    history[hollow] = 0;
    log.length = 0;
    await select(page, inline);
    await select(page, hollow); // learns 0 from this tail response
    history[hollow] = undefined;
    await select(page, inline);
    await select(page, hollow); // last report was 0: frame, which reports nothing
    await select(page, inline);
    await select(page, hollow); // forgot it: tail
    expect(log).toEqual([
      `${inline}:tail`,
      `${hollow}:tail`,
      `${inline}:tail`,
      `${hollow}:full`,
      `${inline}:tail`,
      `${hollow}:tail`,
    ]);

    // What the hollow switch actually paints: the frame, without the repaints.
    history[hollow] = 0;
    await select(page, inline);
    await select(page, hollow); // learns 0
    await select(page, inline);
    await select(page, hollow);
    const screen = await page.evaluate(() => {
      const t = (window as unknown as { app: { terminal: any } }).app.terminal;
      const lines: string[] = [];
      for (let i = 0; i < t.buffer.active.length; i++) lines.push(t.buffer.active.getLine(i)?.translateToString(true));
      return lines.join('\n');
    });
    expect(screen).toContain(`frame of ${hollow}`);
    expect(screen).not.toContain('old repaint');

    await deleteSession(page, hollow);
    await deleteSession(page, inline);
    await context.close();
  }, 90_000);
});
