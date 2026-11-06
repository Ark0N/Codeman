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

describe('a tab switch whose tail replays no scrollback while the pane holds some', () => {
  it('scrolls by pulling the full history instead of paging the CLI', async () => {
    // After a server restart the byte recording is only the tmux client's attach
    // repaint (home + clear + absolute redraws), so the tail a second select
    // replays leaves baseY 0 while the response still reports tmux scrollback.
    // The scroll used to page the CLI (PageUp into an inline Claude's composer);
    // it now falls through to the local path, whose top-of-buffer pull fetches
    // `full=1` and the gesture then scrolls real history.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await openApp(page);
    const inline = await createSession(page, 'inline-claude-after-restart');
    const other = await createSession(page, 'other');
    const log: string[] = [];
    const history = Array.from({ length: 200 }, (_, i) => `history line ${i}\r\n`).join('');
    await page.route('**/api/sessions/*/terminal*', async (route) => {
      const url = new URL(route.request().url());
      const id = url.pathname.split('/')[3];
      const full = url.searchParams.get('full') === '1';
      log.push(`${id}:${full ? 'full' : 'tail'}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            terminalBuffer: full ? `${history}frame of ${id}\r\n` : `\x1b[H\x1b[2Jframe of ${id}\r\n`,
            status: 'idle',
            fullSize: 4096,
            retainedBytes: 4096,
            truncated: false,
            truncationReason: null,
            source: full ? 'mux-full-history' : 'mux-visible',
            paneHistoryLines: 200,
          },
        }),
      });
    });

    await select(page, inline);
    await select(page, other);
    await select(page, inline);
    expect(log).toEqual([`${inline}:full`, `${other}:full`, `${inline}:tail`]);
    const baseYAfterTail = await page.evaluate(
      () => (window as unknown as { app: { terminal: any } }).app.terminal.buffer.active.baseY
    );
    expect(baseYAfterTail).toBe(0);
    // The prerequisite the guard answers: by the old rule this pane IS hollow.
    expect(await page.evaluate(() => (window as unknown as { app: any }).app._localScrollbackIsHollow())).toBe(true);

    // Record what the scroll sends to the CLI, then wheel up over the terminal.
    await page.evaluate(() => {
      const app = (window as unknown as { app: any }).app;
      app.__sentToCli = [];
      app._sendInputEphemeral = (_id: string, data: string) => app.__sentToCli.push(data);
    });
    log.length = 0;
    const box = await page.locator('#terminalContainer').boundingBox();
    if (!box) throw new Error('terminal container not laid out');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(
      () => (window as unknown as { app: { terminal: any } }).app.terminal.buffer.active.baseY > 0,
      null,
      { timeout: 10_000 }
    );
    expect(log).toEqual([`${inline}:full`]);

    // The next gesture scrolls the recovered history itself: older text comes
    // into view, nothing further is fetched, and the CLI still receives nothing
    // (the page-key queue flushes 40 ms after a gesture, so settle first).
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(
      () => {
        const b = (window as unknown as { app: { terminal: any } }).app.terminal.buffer.active;
        return b.viewportY < b.baseY;
      },
      null,
      { timeout: 10_000 }
    );
    await page.waitForTimeout(200);
    const view = await page.evaluate(() => {
      const t = (window as unknown as { app: { terminal: any } }).app.terminal;
      const b = t.buffer.active;
      const lines: string[] = [];
      for (let i = b.viewportY; i < b.viewportY + t.rows; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
      return lines.join('\n');
    });
    expect(view).toContain('history line ');
    expect(log).toEqual([`${inline}:full`]);
    expect(await page.evaluate(() => (window as unknown as { app: any }).app.__sentToCli)).toEqual([]);

    await deleteSession(page, inline);
    await deleteSession(page, other);
    await context.close();
  }, 90_000);
});
