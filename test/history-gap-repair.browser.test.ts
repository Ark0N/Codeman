/** Real xterm + manual banner actions recover tmux repaint gaps while reading (#814). */
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
  selectSession(sessionId: string): Promise<void>;
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
  _syncHistoryReloadAction(): void;
  loadAppSettingsFromStorage(): Record<string, unknown>;
  saveAppSettingsToStorage(settings: Record<string, unknown>): void;
  _setHistoryTruncation(sessionId: string, payload: Record<string, unknown>): void;
  _setHistoryNoticeRevealed(sessionId: string): void;
};
type RepairWindow = Window & {
  app: HistoryApp;
  repairTest: { pulls: number; anchor: Anchor | null; inject: boolean };
  repairReadiness?: { cols: number; rows: number; frames: number };
  tabLoadTest?: { requested: boolean; release(): void; selection: Promise<void> };
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

describe.each([true, false])('manual history gap repair (touch: %s)', (touch) => {
  async function readHistory(page: Page) {
    if (touch) await scrollHistoryByTouch(page, 100);
    else await page.evaluate(() => (window as RepairWindow).app.terminal.scrollToLine(10));
    const position = await page.evaluate(() => {
      const b = (window as RepairWindow).app.terminal.buffer.active;
      return { viewportY: b.viewportY, baseY: b.baseY };
    });
    expect(position.viewportY).toBeGreaterThan(0);
    expect(position.baseY - position.viewportY).toBeGreaterThan(5);
  }

  it('repairs mid-history only on a banner tap/click and holds the reading line offset', async () => {
    const { context, page } = await openTerminal(touch);
    try {
      await readHistory(page);
      await burst(page);
      expect((await bufferState(page)).numbers).not.toContain('NUMBER-090');
      expect((await bufferState(page)).pulls).toBe(0);
      const button = page.locator('#historyTruncationBar').getByRole('button', { name: 'Reload history' });
      await button.waitFor({ state: 'visible' });
      if (touch) await button.tap();
      else await button.click();
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
    const { context, page } = await openTerminal(touch);
    try {
      await readHistory(page);
      await burst(page);
      await page.evaluate(() => {
        (window as RepairWindow).repairTest.inject = true;
      });
      const button = page.locator('#historyTruncationBar').getByRole('button', { name: 'Reload history' });
      if (touch) await button.tap();
      else await button.click();
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

  it.each([false, true])(
    'keeps the revealed notice and one unobstructed load control (exhausted: %s)',
    async (exhausted) => {
      const { context, page } = await openTerminal(touch);
      try {
        await readHistory(page);
        await burst(page);
        await page.evaluate(
          ({ session, exhausted }) => {
            const app = (window as RepairWindow).app;
            app._setHistoryTruncation(session, {
              truncated: true,
              truncationReason: 'tail',
              source: 'mux-full-history',
              fullSize: 2 * 1024 * 1024,
              retainedBytes: 1024 * 1024,
              paneHistoryLines: 121,
              exhausted,
            });
            app._setHistoryNoticeRevealed(session);
          },
          { session: SESSION, exhausted }
        );
        const bar = page.locator('#historyTruncationBar');
        await bar.waitFor({ state: 'visible' });
        expect(await bar.locator('.history-trunc-text').textContent()).not.toBe(
          'Recent output may be missing from this view.'
        );
        const button = bar.locator('.history-trunc-load');
        expect(await button.count()).toBe(1);
        expect(await button.textContent()).toBe(exhausted ? 'Reload history' : 'Load full history');
        for (const control of await bar.getByRole('button').all()) {
          expect(
            await control.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
            })
          ).toBe(true);
        }
      } catch (error) {
        throw await failureDetails(page, error);
      } finally {
        await context.close();
      }
    },
    60_000
  );

  it('does not offer a reload action when disabled on this device', async () => {
    const { context, page } = await openTerminal(touch);
    try {
      await page.evaluate(() => {
        const app = (window as RepairWindow).app;
        app.saveAppSettingsToStorage({ ...app.loadAppSettingsFromStorage(), historyReloadAction: false });
        app._syncHistoryReloadAction();
      });
      await readHistory(page);
      await burst(page);
      // Wait for the same coalesced scroll synchronization used in production.
      await page.evaluate(() => {
        const { promise, resolve } = Promise.withResolvers<void>();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        return promise;
      });
      expect(await page.getByRole('button', { name: 'Reload history' }).isVisible()).toBe(false);
      expect((await bufferState(page)).pulls).toBe(0);
    } catch (error) {
      throw await failureDetails(page, error);
    } finally {
      await context.close();
    }
  }, 60_000);
});

it('hides Reload history while a marked incoming tab capture is pending', async () => {
  const { context, page } = await openTerminal(false);
  const incoming = `${SESSION}-incoming`;
  try {
    await page.evaluate((session) => {
      const w = window as RepairWindow;
      const app = w.app;
      app.terminal.scrollToLine(10);
      app.sessions.set(session, { id: session, mode: 'omp', status: 'idle', name: 'Incoming history' });
      app._liveOutputSinceFullPull.add(session);
      const response = Promise.withResolvers<Response>();
      const realFetch = window.fetch.bind(window);
      const terminalBuffer = 'INCOMING-HISTORY\r\n';
      w.tabLoadTest = {
        requested: false,
        release: () =>
          response.resolve(
            new Response(
              JSON.stringify({
                success: true,
                data: { terminalBuffer, source: 'mux-full-history', paneHistoryLines: 1, truncated: false },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          ),
        selection: Promise.resolve(),
      };
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === 'string' ? input : ((input as Request).url ?? input));
        if (!url.includes(`/api/sessions/${session}/terminal`)) return realFetch(input, init);
        w.tabLoadTest!.requested = true;
        return response.promise;
      }) as typeof window.fetch;
    }, incoming);
    expect((await bufferState(page)).baseY - (await bufferState(page)).viewportY).toBeGreaterThan(5);
    await page.evaluate((session) => {
      const w = window as RepairWindow;
      w.tabLoadTest!.selection = w.app.selectSession(session);
    }, incoming);
    await page.waitForFunction((session) => {
      const w = window as RepairWindow;
      return (
        w.tabLoadTest?.requested &&
        w.app.activeSessionId === session &&
        w.app.terminalLoadStates.has(session) &&
        w.app._isLoadingBuffer
      );
    }, incoming);
    const bar = page.locator('#historyTruncationBar');
    expect(await bar.getByRole('button', { name: 'Reload history' }).count()).toBe(0);
    expect(await bar.isHidden()).toBe(true);
    await page.evaluate(async () => {
      const test = (window as RepairWindow).tabLoadTest!;
      test.release();
      await test.selection;
    });
    await page.waitForFunction((session) => {
      const app = (window as RepairWindow).app;
      return (
        app.activeSessionId === session &&
        !app.terminalLoadStates.has(session) &&
        !app._isLoadingBuffer &&
        !app.pendingWrites.length &&
        !app._terminalWriteInFlight
      );
    }, incoming);
    expect(
      await page.evaluate(() => {
        const buffer = (window as RepairWindow).app.terminal.buffer.active;
        return buffer.getLine(0)?.translateToString(true);
      })
    ).toBe('INCOMING-HISTORY');
  } catch (error) {
    throw await failureDetails(page, error);
  } finally {
    await context.close();
  }
}, 60_000);

it('holds an OMP reading row through repeated repaint history and capped live flushes', async () => {
  const { context, page } = await openTerminal(true);
  const readingRow = 'Reading tool result: src/engine.ts — preserve this row';
  try {
    const before = await page.evaluate(
      async ({ session, readingRow }) => {
        const w = window as RepairWindow;
        const app = w.app;
        const terminal = app.terminal;
        const write = async (data: string) => {
          const { promise, resolve } = Promise.withResolvers<void>();
          terminal.write(data, resolve);
          await promise;
        };
        terminal.reset();
        terminal.options.scrollback = 50_000;
        const repeated = [
          '╭──────────────────╮',
          '',
          '│ Working…         │',
          '╰──────────────────╯',
          '',
          '⠋ OMP · processing',
        ];
        const rows = Array.from({ length: 50_100 }, (_, i) =>
          i % 1000 === 999 ? `tool output ${'wrapped context '.repeat(18)}` : repeated[i % repeated.length]
        );
        await write(rows.join('\r\n') + '\r\n');
        terminal.scrollToLine(25_000);
        app._syncStickyScrollBaseline();
        // Cursor-addressed redraws and CSI S leave repeated TUI furniture in history.
        const repaint = repeated.map((text, row) => `\x1b[${row + 1};1H\x1b[2K${text}`).join('');
        app._onSessionTerminal({ id: session, data: `\x1b[6S${repaint}\x1b[6S${repaint}` });
        await write('');
        while (app.pendingWrites.length || app._terminalWriteInFlight) {
          const { promise, resolve } = Promise.withResolvers<void>();
          requestAnimationFrame(() => resolve());
          await promise;
        }
        // Put the distinctive tool result BELOW the three repeated anchor rows.
        const buffer = terminal.buffer.active;
        const top = buffer.viewportY;
        const snapshot = Array.from(
          { length: buffer.length },
          (_, i) => buffer.getLine(i)?.translateToString(true) || ''
        );
        snapshot[top + 5] = readingRow;
        await write('\x1bc' + snapshot.join('\r\n'));
        terminal.scrollToLine(top);
        app._syncStickyScrollBaseline();
        const seeded = terminal.buffer.active;
        const captured = Array.from(
          { length: seeded.length },
          (_, i) => seeded.getLine(i)?.translateToString(true) || ''
        );
        captured.splice(top + 500, 0, ...Array.from({ length: 120 }, (_, i) => `Recovered tool detail ${i}`));
        const terminalBuffer = captured.join('\r\n');
        const realFetch = window.fetch.bind(window);
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(typeof input === 'string' ? input : ((input as Request).url ?? input));
          if (!url.includes(`/api/sessions/${session}/terminal`)) return realFetch(input, init);
          w.repairTest.pulls++;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => {
              app._onSessionTerminal({ id: session, data: '\r\nDownload-time output\r\n' });
              return {
                success: true,
                data: { terminalBuffer, source: 'mux-full-history', paneHistoryLines: 100_000, truncated: false },
              };
            },
          }) as unknown as Promise<Response>;
        }) as typeof window.fetch;
        app._liveOutputSinceFullPull.add(session);
        app._syncHistoryReloadAction();
        return {
          offset: captured.indexOf(readingRow) - seeded.viewportY,
          viewportY: seeded.viewportY,
          baseY: seeded.baseY,
        };
      },
      { session: SESSION, readingRow }
    );
    const button = page.locator('#historyTruncationBar').getByRole('button', { name: 'Reload history' });
    await button.tap();
    await waitForRepair(page);
    const measure = () =>
      page.evaluate((readingRow) => {
        const app = (window as RepairWindow).app;
        const buffer = app.terminal.buffer.active;
        let row = -1;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer.getLine(i)?.translateToString(true) === readingRow) {
            row = i;
            break;
          }
        }
        return { offset: row - buffer.viewportY, viewportY: buffer.viewportY, baseY: buffer.baseY };
      }, readingRow);
    const afterReplay = await measure();
    await page.evaluate((session) => {
      (window as RepairWindow).app._onSessionTerminal({ id: session, data: '\r\nPost-replay output\r\n' });
    }, SESSION);
    await waitForRepair(page);
    const afterFlush = await measure();
    expect({ before, afterReplay, afterFlush }).toEqual({
      before,
      afterReplay: { ...afterReplay, offset: before.offset },
      afterFlush: { ...afterFlush, offset: before.offset },
    });
  } finally {
    await context.close();
  }
}, 120_000);
