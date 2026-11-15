/** Real xterm + trusted phone gestures recover tmux repaint gaps while reading (#814). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Terminal } from '@xterm/xterm';
import { WebServer } from '../src/web/server.js';

type Anchor = { signature: string[]; offset: number; viewportY: number; rowsFromBottom: number };
type HistoryApp = {
  terminal: Terminal & {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { height: number } } } } };
  };
  fitAddon: { proposeDimensions(): { cols: number; rows: number } | undefined };
  sessions: Map<string, object>;
  activeSessionId: string;
  hideWelcome(): void;
  _onSessionTerminal(event: { id: string; data: string }): void;
  _liveOutputSinceFullPull: Set<string>;
  _fullHistoryRepullInFlight: boolean;
  _isLoadingBuffer: boolean;
  pendingWrites: string[];
  _terminalWriteInFlight: boolean;
  _bufferLoadOwner: unknown;
  _loadBufferQueue: { data: string; at: number }[] | null;
  _selectGeneration: number;
  _initGeneration: number;
  terminalLoadStates: Map<string, unknown>;
  _terminalFontReady: Promise<void>;
  _resizeTimeout: number | null;
  _lastResizeDims: { cols: number; rows: number } | null;
  _syncStickyScrollBaseline(): void;
  _captureViewportAnchor(): Anchor;
  _syncHistoryReloadButton(): void;
};
type RepairWindow = Window & {
  app: HistoryApp;
  repairTest: { pulls: number; anchor: Anchor | null; inject: boolean };
  repairReadiness?: { cols: number; rows: number; frames: number };
};

const SESSION = 'history-repair-browser';
const MARKER = 'AFTER-CAPTURE-DURING-DOWNLOAD';
let server: WebServer;
let browser: Browser;
let baseUrl: string;
const pageEvents = new WeakMap<Page, string[]>();

async function setupState(page: Page) {
  return page.evaluate(() => {
    const app = (window as RepairWindow).app;
    const buffer = app?.terminal?.buffer.active;
    return {
      appLoaded: document.body.classList.contains('app-loaded'),
      baseY: buffer?.baseY,
      length: buffer?.length,
      viewportY: buffer?.viewportY,
      cols: app?.terminal?.cols,
      rows: app?.terminal?.rows,
      resizePending: Boolean(app?._resizeTimeout),
      lastResizeDims: app?._lastResizeDims,
      proposedDims: app?.fitAddon?.proposeDimensions(),
      cellHeight: app?.terminal?._core?._renderService?.dimensions?.css?.cell?.height,
      pendingWrites: app?.pendingWrites?.length,
      terminalWriteInFlight: app?._terminalWriteInFlight,
      isLoadingBuffer: app?._isLoadingBuffer,
      bufferLoadOwner: app?._bufferLoadOwner,
      loadBufferQueue: app?._loadBufferQueue?.length ?? 0,
      activeSessionId: app?.activeSessionId,
      selectGeneration: app?._selectGeneration,
      sessions: app?.sessions ? [...app.sessions.keys()] : [],
      initGeneration: app?._initGeneration,
      terminalLoadStates: app?.terminalLoadStates ? [...app.terminalLoadStates] : [],
    };
  });
}

async function failureDetails(page: Page, error: unknown): Promise<Error> {
  const setup = await setupState(page).catch(String);
  const buffer = await bufferState(page).catch(String);
  return new Error(JSON.stringify({ setup, buffer, events: pageEvents.get(page) }), { cause: error });
}

beforeAll(async () => {
  server = new WebServer(0, false, true);
  await server.start();
  baseUrl = `http://localhost:${server.boundPort}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

async function openTerminal(
  touch: boolean,
  viewport = touch ? { width: 390, height: 640 } : { width: 1280, height: 800 }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    hasTouch: touch,
    isMobile: touch,
    viewport,
  });
  const page = await context.newPage();
  const events: string[] = [];
  pageEvents.set(page, events);
  page.on('console', (message) => {
    events.push(`console.${message.type()}: ${message.text()}`);
    if (events.length > 100) events.shift();
  });
  page.on('pageerror', (error) => events.push(`pageerror: ${error.stack || error.message}`));
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('app-loaded'));
    await page.waitForFunction(() => {
      const app = (window as RepairWindow).app;
      return app?.terminal && app._initGeneration > 0 && !app._isLoadingBuffer && app.terminalLoadStates.size === 0;
    });
    await page.evaluate(async (session) => {
      const app = (window as RepairWindow).app;
      // A client-only OMP session isolates the rendering path from real CLI/PTYS.
      // Opening it changes layout, so finish the real resize path BEFORE seeding.
      app.sessions.set(session, { id: session, mode: 'omp', status: 'idle', name: 'History repair' });
      app.activeSessionId = session;
      app.hideWelcome();
      await app._terminalFontReady;
      await document.fonts.ready;
      // Empty xterm can still carry fallback render metrics. Paint a glyph
      // before fitting, then clear it before the fixture's numbered output.
      const rendered = Promise.withResolvers<void>();
      const listener = app.terminal.onRender(() => {
        listener.dispose();
        rendered.resolve();
      });
      app.terminal.write('W');
      await rendered.promise;
      const { promise, resolve } = Promise.withResolvers<void>();
      app.terminal.write('\x1bc', resolve);
      await promise;
      window.dispatchEvent(new Event('resize'));
    }, SESSION);
    await page.waitForFunction(() => {
      const w = window as RepairWindow;
      const app = w.app;
      const { cols, rows } = app.terminal;
      const proposed = app.fitAddon.proposeDimensions();
      const cellHeight = app.terminal._core?._renderService?.dimensions?.css?.cell?.height || 0;
      if (
        cellHeight <= 0 ||
        proposed?.cols !== cols ||
        proposed?.rows !== rows ||
        app._resizeTimeout ||
        app._isLoadingBuffer ||
        app.terminalLoadStates.size ||
        app.pendingWrites.length ||
        app._terminalWriteInFlight ||
        app._lastResizeDims?.cols !== cols ||
        app._lastResizeDims?.rows !== rows
      ) {
        w.repairReadiness = undefined;
        return false;
      }
      // Synchronous rAF polling: require the initial match plus two more frames.
      // An async predicate returns a truthy Promise, which Playwright won't retry.
      const previous = w.repairReadiness;
      const frames = previous?.cols === cols && previous.rows === rows ? previous.frames + 1 : 1;
      w.repairReadiness = { cols, rows, frames };
      return frames >= 3;
    });
    await page.evaluate(
      async ({ session, marker }) => {
        const w = window as RepairWindow;
        const app = w.app;
        // Startup resets and resize clears have already parsed at fitted geometry.
        w.repairTest = { pulls: 0, anchor: null, inject: false };
        const captureAnchor = app._captureViewportAnchor.bind(app);
        app._captureViewportAnchor = () => {
          const anchor = captureAnchor();
          w.repairTest.anchor = anchor;
          return anchor;
        };
        const realFetch = window.fetch.bind(window);
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(typeof input === 'string' ? input : ((input as Request).url ?? input));
          if (!url.includes(`/api/sessions/${session}/terminal`)) return realFetch(input, init);
          if (!url.includes('full=1')) throw new Error(`Unexpected history request: ${url}`);
          w.repairTest.pulls++;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => {
              // This is after headers and before replay, inside the real load window.
              if (w.repairTest.inject) app._onSessionTerminal({ id: session, data: `\r\n${marker}\r\n` });
              const terminalBuffer =
                Array.from({ length: 144 }, (_, i) => `NUMBER-${String(i).padStart(3, '0')}`).join('\r\n') + '\r\n';
              return {
                success: true,
                data: {
                  terminalBuffer,
                  source: 'mux-full-history',
                  paneHistoryLines: 121,
                  truncated: false,
                  fullSize: terminalBuffer.length,
                  retainedBytes: terminalBuffer.length,
                },
              };
            },
          }) as unknown as Promise<Response>;
        }) as typeof window.fetch;
        // All output still enters through the production terminal event path.
        app._onSessionTerminal({
          id: session,
          data: Array.from({ length: 60 }, (_, i) => `NUMBER-${String(i).padStart(3, '0')}\r\n`).join(''),
        });
        await new Promise<void>((resolve) => app.terminal.write('', resolve));
      },
      { session: SESSION, marker: MARKER }
    );
    await page.waitForFunction(() => {
      const app = (window as RepairWindow).app;
      const buffer = app.terminal.buffer.active;
      return (
        buffer.length === 61 &&
        buffer.baseY === 61 - app.terminal.rows &&
        !app.pendingWrites.length &&
        !app._terminalWriteInFlight &&
        Array.from({ length: 60 }, (_, i) => buffer.getLine(i)?.translateToString(true)).every(
          (row, i) => row === `NUMBER-${String(i).padStart(3, '0')}`
        )
      );
    });
    // The initial 60 lines stand in for the last successful full-history replay.
    await page.evaluate((session) => {
      const app = (window as RepairWindow).app;
      app.terminal.scrollToBottom();
      app._syncStickyScrollBaseline();
      app._liveOutputSinceFullPull.delete(session);
    }, SESSION);
  } catch (error) {
    const state = await setupState(page).catch(String);
    await context.close();
    throw new Error(`Terminal setup failed: ${JSON.stringify({ state, events })}`, { cause: error });
  }
  return { context, page };
}

/** Finger down scrolls history up; cancel at the endpoint to avoid momentum. */
async function scrollHistoryByTouch(page: Page, distance: number): Promise<void> {
  const box = await page.locator('#terminalContainer').boundingBox();
  if (!box) throw new Error('Terminal container is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(80, box.height / 4);
  const cdp = await page.context().newCDPSession(page);
  const before = await page.evaluate(() => (window as RepairWindow).app.terminal.buffer.active.viewportY);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance }] });
    await page.waitForFunction((previous) => {
      const app = (window as RepairWindow).app;
      return app.terminal.buffer.active.viewportY !== previous || app._fullHistoryRepullInFlight;
    }, before);
    // A trusted cancellation ends the drag without xterm/app momentum changing
    // the reading position after the gesture or starting another top pull.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

async function burst(page: Page): Promise<void> {
  await page.evaluate((session) => {
    const app = (window as RepairWindow).app;
    // tmux scrolls a whole screen and repaints the last 24 rows. The numbered
    // rows 60..119 exist only in tmux and are deliberately absent from this stream.
    const repaint = Array.from({ length: 24 }, (_, row) => `\x1b[${row + 1};1H\x1b[2KNUMBER-${120 + row}`).join('');
    app._onSessionTerminal({ id: session, data: `\x1b[24S${repaint}` });
  }, SESSION);
  await page.waitForFunction((session) => (window as RepairWindow).app._liveOutputSinceFullPull.has(session), SESSION);
}

async function bufferState(page: Page) {
  return page.evaluate((marker) => {
    const w = window as RepairWindow;
    const buffer = w.app.terminal.buffer.active;
    const rows = Array.from(
      { length: buffer.length },
      (_, i) => buffer.getLine(i)?.translateToString(true).trim() || ''
    );
    const anchor = w.repairTest.anchor;
    return {
      numbers: rows.filter((row) => /^NUMBER-\d+$/.test(row)),
      markerHits: rows.filter((row) => row.includes(marker)).length,
      anchorOffset: anchor ? rows.indexOf(anchor.signature[0]) - buffer.viewportY : null,
      expectedOffset: anchor?.offset,
      pulls: w.repairTest.pulls,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      session: w.app.activeSessionId,
      length: buffer.length,
      pendingWrites: w.app.pendingWrites.length,
      terminalWriteInFlight: w.app._terminalWriteInFlight,
      bufferLoadOwner: w.app._bufferLoadOwner,
      loadBufferQueue: w.app._loadBufferQueue,
      selectGeneration: w.app._selectGeneration,
      initGeneration: w.app._initGeneration,
      sessions: [...w.app.sessions.keys()],
      marked: w.app._liveOutputSinceFullPull.has(w.app.activeSessionId),
      loading: w.app._isLoadingBuffer,
      inFlight: w.app._fullHistoryRepullInFlight,
    };
  }, MARKER);
}

async function waitForRepair(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as RepairWindow;
    return (
      w.repairTest.pulls === 1 &&
      !w.app._fullHistoryRepullInFlight &&
      !w.app._isLoadingBuffer &&
      !w.app.pendingWrites.length &&
      !w.app._terminalWriteInFlight
    );
  });
  // xterm's parse marker is the completion signal for the production flush.
  await page.evaluate(async () => {
    const app = (window as RepairWindow).app;
    await new Promise<void>((resolve) => app.terminal.write('', resolve));
  });
}

const allNumbers = Array.from({ length: 144 }, (_, i) => `NUMBER-${String(i).padStart(3, '0')}`);

describe('history gap repair on phones', () => {
  it('repairs from mid-history after a real upward scroll and holds the content anchor', async () => {
    const { context, page } = await openTerminal(true);
    try {
      await scrollHistoryByTouch(page, 100);
      const position = await page.evaluate(() => {
        const b = (window as RepairWindow).app.terminal.buffer.active;
        return { viewportY: b.viewportY, baseY: b.baseY };
      });
      expect(position.viewportY).toBeGreaterThan(0);
      expect(position.baseY - position.viewportY).toBeGreaterThan(5);
      await burst(page);
      expect((await bufferState(page)).numbers).not.toContain('NUMBER-090');
      await scrollHistoryByTouch(page, 40);
      await waitForRepair(page);
      const state = await bufferState(page);
      expect(state.numbers).toEqual(allNumbers);
      expect(state.anchorOffset).toBe(state.expectedOffset);
      expect(state.pulls).toBe(1);
    } catch (error) {
      throw await failureDetails(page, error);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps output arriving during the capture download exactly once', async () => {
    const { context, page } = await openTerminal(true);
    try {
      await scrollHistoryByTouch(page, 100);
      await burst(page);
      await page.evaluate(() => {
        (window as RepairWindow).repairTest.inject = true;
      });
      await scrollHistoryByTouch(page, 40);
      await waitForRepair(page);
      const state = await bufferState(page);
      const detail = JSON.stringify({ state, events: pageEvents.get(page) });
      expect(state.markerHits, detail).toBe(1);
      expect(state.numbers, detail).toEqual(allNumbers);
    } catch (error) {
      throw await failureDetails(page, error);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('offers a touch reload while reading and tapping it recovers the missing rows', async () => {
    const { context, page } = await openTerminal(true);
    try {
      await scrollHistoryByTouch(page, 100);
      await burst(page);
      const button = page.getByRole('button', { name: 'Reload history' });
      await button.waitFor({ state: 'visible' });
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      await button.tap();
      await waitForRepair(page);
      const state = await bufferState(page);
      expect(state.numbers).toEqual(allNumbers);
      expect(state.anchorOffset).toBe(state.expectedOffset);
      expect(await button.isVisible()).toBe(false);
    } catch (error) {
      throw await failureDetails(page, error);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('floats a 44px reload control on wide touch viewports without resizing the terminal', async () => {
    const { context, page } = await openTerminal(true, { width: 1280, height: 800 });
    try {
      await page.evaluate(() => {
        (window as RepairWindow).app.terminal.scrollToLine(10);
      });
      const dimensions = () =>
        page.evaluate(() => {
          const terminal = (window as RepairWindow).app.terminal;
          const box = document.getElementById('terminalContainer')!.getBoundingClientRect();
          return { width: box.width, height: box.height, cols: terminal.cols, rows: terminal.rows };
        });
      const before = await dimensions();
      expect(await page.locator('#historyReloadBtn').isVisible()).toBe(false);
      await burst(page);
      const button = page.getByRole('button', { name: 'Reload history' });
      await button.waitFor({ state: 'visible' });
      expect(await button.evaluate((element) => getComputedStyle(element).position)).toBe('absolute');
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(await dimensions()).toEqual(before);
    } catch (error) {
      throw await failureDetails(page, error);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('never shows the reload control in a non-touch context', async () => {
    const { context, page } = await openTerminal(false);
    try {
      await page.evaluate(() => {
        (window as RepairWindow).app.terminal.scrollToLine(10);
      });
      await burst(page);
      await page.evaluate(() => {
        (window as RepairWindow).app._syncHistoryReloadButton();
      });
      expect(await page.locator('#historyReloadBtn').isVisible()).toBe(false);
      expect((await bufferState(page)).pulls).toBe(0);
    } catch (error) {
      throw await failureDetails(page, error);
    } finally {
      await context.close();
    }
  }, 60_000);
});
