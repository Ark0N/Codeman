/**
 * @fileoverview A capture drawn for a bigger pane makes the client replay once.
 *
 * A visible-frame capture repaints each row at an absolute position, counting
 * up to the PANE's height and out to the PANE's width. A terminal shorter than
 * that clamps every address past its own height onto its last line, so the
 * overflow rows overwrite one another and the rows underneath are lost. A
 * narrower terminal wraps every painted row, and the wrap on the last one
 * scrolls the whole frame up by one. The client cannot see either from the
 * escape sequence, so the terminal response reports the geometry the capture
 * was taken at (`captureCols`/`captureRows`) and `selectSession` replays once
 * at the size that stuck.
 *
 * The comparison runs on a `mux-visible` response ONLY. The other two sources
 * position no rows absolutely, so a size mismatch damages neither and a replay
 * repairs neither, and the last case here pins that the expensive one is left
 * alone.
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
 *
 * `source` is DERIVED from the request the way the real route derives it: a
 * `full=1` request whose capture came back is `mux-full-history`, and every
 * other one is `mux-visible`. The route cannot answer `full=1` with
 * `mux-visible`, so a stub that did would stage a combination production never
 * produces, and a test resting on it would prove nothing about production. A
 * test that needs some other source passes it explicitly and says why.
 */
async function stubTerminal(
  page: Page,
  captureRows: number,
  counter: { n: number; urls: string[] },
  options: { source?: string; captureCols?: number } = {}
) {
  const captureCols = options.captureCols ?? 200;
  await page.route('**/api/sessions/*/terminal*', async (route) => {
    const url = route.request().url();
    counter.n += 1;
    counter.urls.push(url);
    const source = options.source ?? (url.includes('full=1') ? 'mux-full-history' : 'mux-visible');
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
          source,
          captureCols,
          captureRows,
        },
      }),
    });
  });
}

/**
 * As `stubTerminal`, but reading its geometry from a holder the test can change
 * between selects. That is what lets one case watch a pane stop fitting and
 * start fitting again, which a stub fixed at construction cannot show.
 */
async function stubTerminalDynamic(
  page: Page,
  counter: { n: number; urls: string[] },
  state: { captureRows: number; captureCols: number }
) {
  await page.route('**/api/sessions/*/terminal*', async (route) => {
    const url = route.request().url();
    counter.n += 1;
    counter.urls.push(url);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          terminalBuffer: paneSnapshot(state.captureRows),
          status: 'idle',
          fullSize: 1024,
          retainedBytes: 1024,
          truncated: false,
          truncationReason: null,
          source: url.includes('full=1') ? 'mux-full-history' : 'mux-visible',
          captureCols: state.captureCols,
          captureRows: state.captureRows,
        },
      }),
    });
  });
}

/**
 * Answer every fetch with the geometry the client itself is asking for, read
 * live from the page. That is the clamp signature: `getTerminalDimensions()`
 * floors at 40x10, and since #464 `syncTerminalGeometry()` applies that floor
 * to xterm too — so at a small enough viewport the pane, the report and the
 * terminal all agree on the floored size, which is the case the equality guard
 * is left covering.
 */
async function stubTerminalAtRequestedSize(page: Page, counter: { n: number; urls: string[] }) {
  await page.route('**/api/sessions/*/terminal*', async (route) => {
    counter.n += 1;
    counter.urls.push(route.request().url());
    const dims = await page.evaluate(
      () =>
        (
          window as unknown as { app: { getTerminalDimensions?: () => { cols: number; rows: number } | null } }
        ).app.getTerminalDimensions?.() ?? null
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          terminalBuffer: paneSnapshot(dims?.rows ?? 10),
          status: 'idle',
          fullSize: 1024,
          retainedBytes: 1024,
          truncated: false,
          truncationReason: null,
          source: 'mux-visible',
          captureCols: dims?.cols,
          captureRows: dims?.rows,
        },
      }),
    });
  });
}

/** The widest terminal this suite's 1280px viewport can produce, with margin. */
const WIDER_THAN_ANY_TERMINAL_COLS = 500;

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

/** As above, for the width half of the comparison. */
async function terminalCols(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { app: { terminal?: { cols: number } } }).app.terminal?.cols ?? 0);
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

/**
 * Spend the per-page full-history allowance and forget what it cost. Every
 * geometry comparison below runs on a `mux-visible` response, and the route
 * only produces one for a request sent WITHOUT `full=1`, so reaching that shape
 * means not being the first select of the page — which is what a tab switch is.
 */
async function consumeFullHistory(
  page: Page,
  sessionId: string,
  counter: { n: number; urls: string[] }
): Promise<void> {
  await select(page, sessionId);
  counter.n = 0;
  counter.urls.length = 0;
}

async function closeSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(
    (sid: string) => fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).then(() => undefined),
    sessionId
  );
}

describe('a capture bigger than the terminal', () => {
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
    // A tab switch is where a visible-frame response arrives, so that is what
    // this measures. The first select of the page takes the full-history path
    // and is covered by its own case below.
    await consumeFullHistory(page, sessionId, fetches);
    await select(page, sessionId, { forceReload: true });

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

    // First select: a fresh session, so this one pulls full history. It does
    // NOT retry, because the geometry comparison runs on a visible-frame
    // response and a `full=1` request cannot produce one.
    await select(page, sessionId);
    expect(fetches.n).toBe(1);
    expect(fetches.urls.filter((u) => u.includes('full=1'))).toHaveLength(1);

    // Re-select the SAME session. `selectSession` early-returns on an already
    // active session unless forceReload is set, and forceReload is the shape a
    // tab switch back to this session takes: `_fullHistoryLoaded` still holds
    // it, so neither this pass nor its retry asks for full history again.
    await select(page, sessionId, { forceReload: true });
    const tabSwitchUrls = fetches.urls.slice(1);
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
    await stubTerminal(page, 5, fetches, { captureCols: 40 });
    await consumeFullHistory(page, sessionId, fetches);
    await select(page, sessionId, { forceReload: true });

    expect(await terminalRows(page)).toBeGreaterThan(5);
    expect(fetches.n).toBe(1);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);

  it('replays once when the captured pane is wider', async () => {
    // A pane wider than the terminal damages the same frame a second way.
    // `formatPaneSnapshot` paints every row out to the PANE's width, so a
    // narrower browser wraps each painted row, and the wrap on the last row
    // scrolls the whole frame up by one. The height here fits deliberately, so
    // the width is the only thing that can trigger the replay.
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);

    const fetches = { n: 0, urls: [] as string[] };
    await stubTerminal(page, 5, fetches, { captureCols: WIDER_THAN_ANY_TERMINAL_COLS });
    await consumeFullHistory(page, sessionId, fetches);
    await select(page, sessionId, { forceReload: true });

    expect(await terminalRows(page)).toBeGreaterThan(5);
    expect(await terminalCols(page)).toBeLessThan(WIDER_THAN_ANY_TERMINAL_COLS);
    expect(fetches.n).toBe(2);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);

  it('does not replay a full-history response, whatever geometry it reports', async () => {
    // A `full=1` body is linear scrollback closed by a RELATIVE cursor move,
    // which is relative precisely so the browser's row count need not match the
    // pane's. A mismatch there is not damage and a replay cannot repair it, so
    // the geometry comparison must not fire on it. This is the path that makes
    // the gate worth having: `_fullHistoryLoaded` is empty on the first select
    // of every non-shell session per page, so an ungated comparison would pull
    // the entire tmux scrollback a second time on every page load and every
    // first tab switch, for a session whose pane a desktop tab is holding too
    // tall to ever fit.
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);

    const fetches = { n: 0, urls: [] as string[] };
    await stubTerminal(page, 200, fetches, { captureCols: WIDER_THAN_ANY_TERMINAL_COLS });
    await select(page, sessionId);

    // Both dimensions are mismatched, so height alone is not what spares it.
    expect(await terminalRows(page)).toBeLessThan(200);
    expect(await terminalCols(page)).toBeLessThan(WIDER_THAN_ANY_TERMINAL_COLS);
    expect(fetches.n).toBe(1);
    expect(fetches.urls.filter((u) => u.includes('full=1'))).toHaveLength(1);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);

  it('replays once per session, not once per tab switch, when it cannot converge', async () => {
    // `resizeRetry` caps the recursion inside ONE select and says nothing about
    // the next one, so a pane this browser cannot size reported the same
    // mismatch on every select and bought the same failed repair every time:
    // two fetches per tab switch for the life of the page. That is the case the
    // description calls "every time rather than occasionally", a phone whose
    // resize is declined while a desktop claim is live, and it is not the only
    // one — any pane Codeman cannot size lands there, a second tmux client
    // attached to it included. Each wasted pass costs another `capture-pane`,
    // which is `execSync` on the server's event loop, plus a reset and rewrite,
    // a discarded snapshot, and a dropped and reopened WebSocket.
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);

    const fetches = { n: 0, urls: [] as string[] };
    const pane = { captureRows: 200, captureCols: 200 };
    await stubTerminalDynamic(page, fetches, pane);
    await consumeFullHistory(page, sessionId, fetches);

    // First tab switch: one load, one replay, and the replay does not fit
    // either, which is the proof that this pane ignores the size it is given.
    await select(page, sessionId, { forceReload: true });
    expect(fetches.n).toBe(2);

    // Every switch after it pays once. Unlatched this reads 4 then 6.
    await select(page, sessionId, { forceReload: true });
    expect(fetches.n).toBe(3);
    await select(page, sessionId, { forceReload: true });
    expect(fetches.n).toBe(4);

    // The memo has to lift when the pane becomes sizeable again, or closing the
    // desktop tab that was holding it would leave this session permanently
    // unrepaired. A frame that fits clears it...
    pane.captureRows = 5;
    pane.captureCols = 40;
    await select(page, sessionId, { forceReload: true });
    expect(fetches.n).toBe(5);

    // ...so the next genuine mismatch is diagnosed again.
    pane.captureRows = 200;
    pane.captureCols = 200;
    await select(page, sessionId, { forceReload: true });
    expect(fetches.n).toBe(7);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);

  it('hands over text typed but not yet submitted before it replays', async () => {
    // On a touch device the characters the user has typed live ONLY in the
    // local-echo overlay until Enter; they have never reached the PTY. The
    // replay re-enters `selectSession` with `forceReload` on the session that
    // is still active, and that branch used to null `activeSessionId` before
    // `_cleanupPreviousSession` ran, so the flush there saw no session and the
    // unconditional `clear()` afterwards took the characters with it. Nothing
    // the user did triggered that: the replay fires on its own the moment a
    // tab switch finishes, which is exactly when someone typing into a
    // still-loading terminal has text in the overlay.
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);

    const fetches = { n: 0, urls: [] as string[] };
    await stubTerminal(page, 200, fetches);
    await consumeFullHistory(page, sessionId, fetches);

    // Headless chromium reports `isTouchDevice()` false even with `hasTouch`,
    // so the overlay would stay off and the whole case would pass vacuously.
    // The setting is what `_updateLocalEchoState()` reads, so it survives the
    // recompute that every select runs; the flag is forced too, for the window
    // before the next recompute. Record what crosses into the delivery layer,
    // which is the seam the text failed to cross.
    await page.evaluate(() => {
      const w = window as unknown as {
        app: {
          _localEchoEnabled: boolean;
          _sendInputAsync: (id: string, text: string, opts?: unknown) => void;
          terminal?: { focus: () => void };
          loadAppSettingsFromStorage: () => Record<string, unknown>;
        };
        __sentInputs: { id: string; text: string }[];
      };
      const settings = w.app.loadAppSettingsFromStorage();
      settings.localEchoEnabled = true;
      localStorage.setItem('codeman-app-settings', JSON.stringify(settings));
      w.app._localEchoEnabled = true;
      w.__sentInputs = [];
      const original = w.app._sendInputAsync.bind(w.app);
      w.app._sendInputAsync = (id: string, text: string, opts?: unknown) => {
        w.__sentInputs.push({ id, text });
        return original(id, text, opts);
      };
      w.app.terminal?.focus();
    });

    await page.keyboard.type('hello-unsent');
    // The premise: the characters really are sitting in the overlay, unsent.
    // Without this the case would pass on a build where typing goes straight
    // to the PTY and there is nothing to lose.
    const pendingBefore = await page.evaluate(
      () =>
        (window as unknown as { app: { _localEchoOverlay?: { pendingText: string } } }).app._localEchoOverlay
          ?.pendingText ?? ''
    );
    expect(pendingBefore).toBe('hello-unsent');

    // The captured pane is taller than the terminal, so this select replays.
    await select(page, sessionId, { forceReload: true });
    expect(fetches.n).toBe(2);

    const sent = await page.evaluate(
      () => (window as unknown as { __sentInputs: { id: string; text: string }[] }).__sentInputs
    );
    expect(sent.map((s) => s.text)).toContain('hello-unsent');
    expect(sent.find((s) => s.text === 'hello-unsent')?.id).toBe(sessionId);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);

  it('does not replay a pane already at the size the client asked for', async () => {
    // ⚠️ The premise of this case CHANGED with issue #464, and the old one can
    // never hold again. It used to be the clamp: `getTerminalDimensions()`
    // floors at 40x10 while `fitAddon.fit()` did not, so a viewport this small
    // left the terminal shorter than the size the client itself requested, the
    // pane drew at the floored size, and the captured height exceeded the
    // terminal's forever — a replay that re-requested the same floored size and
    // captured the same frame, on every tab switch, for the life of the page.
    //
    // `syncTerminalGeometry()` now applies the floor to xterm as well, so the
    // browser terminal IS the size it reports and that divergence is gone at
    // the source. The case survives on its own terms — a pane already drawing
    // at the requested size must not be replayed, because the retry would
    // capture the identical frame — and its premise is now the #464 invariant
    // itself, asserted below: the floored report and the terminal agree. That
    // is a stronger guard than the old one, since the clamp coming back would
    // fail it here rather than silently restoring the replay loop.
    context = await browser.newContext({ viewport: { width: 320, height: 200 } });
    page = await context.newPage();
    const sessionId = await openSession(page);

    const fetches = { n: 0, urls: [] as string[] };
    await stubTerminalAtRequestedSize(page, fetches);
    await consumeFullHistory(page, sessionId, fetches);
    await select(page, sessionId, { forceReload: true });

    // The premise: the floor really does bind at this viewport — otherwise the
    // case would pass on any viewport, proving nothing — AND the terminal holds
    // exactly what it reports, which is what stops the old replay loop.
    const requested = await page.evaluate(
      () =>
        (
          window as unknown as { app: { getTerminalDimensions?: () => { cols: number; rows: number } | null } }
        ).app.getTerminalDimensions?.() ?? null
    );
    expect(requested).not.toBeNull();
    const proposed = await page.evaluate(
      () =>
        (
          window as unknown as { app: { fitAddon?: { proposeDimensions?: () => { cols: number; rows: number } } } }
        ).app.fitAddon?.proposeDimensions?.() ?? null
    );
    expect(proposed, 'the terminal could not be measured').not.toBeNull();
    expect(
      proposed!.rows < requested!.rows || proposed!.cols < requested!.cols,
      `the floor must bind at this viewport, or the case proves nothing (proposed ${proposed!.cols}x${proposed!.rows}, reported ${requested!.cols}x${requested!.rows})`
    ).toBe(true);
    // The #464 invariant: what the client reports is what the terminal holds.
    expect(requested!.rows).toBe(await terminalRows(page));
    expect(requested!.cols).toBe(await terminalCols(page));

    expect(fetches.n).toBe(1);

    await closeSession(page, sessionId);
    await context.close();
  }, 60_000);
});
