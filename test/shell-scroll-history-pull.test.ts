/**
 * @fileoverview A shell pane's scroll-up must reach the history tmux still holds.
 *
 * tmux repaints a burst of output instead of scrolling it, so after `cat` of a
 * file longer than the screen the browser holds about one screen of scrollback
 * while tmux holds all of it. Other modes recover it by re-pulling `?full=1`
 * when the wheel reaches the top (`_maybeRefetchFullHistory`, issue #205). Shell
 * declined that gesture outright to keep a multi-megabyte capture off xterm's
 * main thread, leaving only the "Load full history" button, and that button
 * renders only once a replay was truncated. A young shell tab therefore had no
 * way to scroll back at all.
 *
 * The gesture now pulls a BOUNDED window (`?full=1&tail=TERMINAL_TAIL_SIZE`),
 * the button stays the unbounded path, and a window the browser already holds
 * in full is not rewritten. Neither is one a browser at xterm's scrollback cap
 * could never hold, and a window cut from a byte-capped capture is still labelled
 * recoverable, since Load full history can reach past it.
 *
 * ORDER MATTERS: that skip must run BEFORE the downgrade guard. The guard reads
 * "smaller than the browser" as "tmux has nothing more to give", which is true of
 * an unbounded capture and false of a window cut at the tail size, so a bounded
 * window that reached it marked the session exhausted and took Load full history
 * off the banner while tmux still held the rest. The second block below drives
 * the real `_setHistoryTruncation` and the real `computeHistoryTruncationNotice`
 * to pin what the user is actually told.
 *
 * The last block pins the pull's own tab-switch guard: a capture that lands
 * after A -> B -> A is dropped by the select generation, since the session id
 * alone matches again while the switch back is still replaying.
 *
 * The method is extracted from app.js and run in a `vm` against stubs (no jsdom
 * on this box; see connection-indicator.test.ts), with the REAL row estimators
 * from terminal-ui.js, which decide both the downgrade and the no-gain skip.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const TERMINAL_TAIL_SIZE = 1024 * 1024;

function methodSource(source: string, method: string): string {
  const start = source.search(new RegExp(`^ {2}(?:async )?${method}\\(`, 'm'));
  expect(start, `${method} not found`).toBeGreaterThan(-1);
  const next = /^ {2}(?:async )?[A-Za-z_$][\w$]*\(/m.exec(source.slice(start + 1));
  return next ? source.slice(start, start + 1 + next.index) : source.slice(start);
}

/** Real terminal-ui.js mixin, for `_estimateReplayRows` / `_replayWouldShrinkBuffer`. */
function loadTerminalMixin(globals: Record<string, unknown> = {}): Record<string, unknown> {
  const source = readFileSync(resolve(PUBLIC, 'terminal-ui.js'), 'utf8');
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
    ...globals,
  });
  vm.runInContext(source, context);
  return FakeCodemanApp.prototype;
}

function loadRefetch(): (this: unknown, opts?: { force?: boolean; anchor?: string }) => Promise<void> {
  const app = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
  const body = methodSource(app, '_maybeRefetchFullHistory');
  const context = vm.createContext({ performance, TERMINAL_TAIL_SIZE, TERMINAL_CHUNK_SIZE: 32 * 1024 });
  return vm.runInContext(`({ ${body} })._maybeRefetchFullHistory`, context);
}

function loadAppMethod(name: string, globals: Record<string, unknown> = {}): Function {
  const source = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
  return vm.runInContext(
    `({ ${methodSource(source, name)} }).${name}`,
    vm.createContext({
      performance,
      TERMINAL_TAIL_SIZE,
      TERMINAL_CHUNK_SIZE: 32 * 1024,
      _crashDiag: { log: vi.fn() },
      ...globals,
    })
  );
}

/** The REAL `_setHistoryTruncation`, so the banner state a pull leaves behind is what production would hold. */
function loadSetHistoryTruncation(): (this: unknown, sessionId: string, payload?: Record<string, unknown>) => void {
  const app = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
  const body = methodSource(app, '_setHistoryTruncation');
  return vm.runInContext(`({ ${body} })._setHistoryTruncation`, vm.createContext({}));
}

/** The REAL banner decision from constants.js: what the user is told, and whether Load full history is offered. */
function loadNotice() {
  const context = vm.createContext({ console, window: {}, document: {}, navigator: { userAgent: 'test' } });
  vm.runInContext(
    `${readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8')}\n;globalThis.__notice = computeHistoryTruncationNotice;`,
    context,
    { filename: 'constants.js' }
  );
  return (context as { __notice: (s: Record<string, unknown>) => { visible: boolean; canLoadMore: boolean } }).__notice;
}

const mixin = loadTerminalMixin();
const refetch = loadRefetch();
const setHistoryTruncation = loadSetHistoryTruncation();
const computeNotice = loadNotice();
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\r\n');

/** A `?full=1&tail=` answer whose window was CUT at the tail size: tmux holds ~3 MiB, the window carries 1 MiB. */
const TAIL_CUT = {
  truncated: true,
  truncationReason: 'tail',
  fullSize: 3 * 1024 * 1024,
  retainedBytes: TERMINAL_TAIL_SIZE,
  source: 'mux-full-history',
};

function makeApp(
  mode: string,
  {
    bufferRows,
    capture,
    payload = {},
    scrollback = 0,
  }: { bufferRows: number; capture: string; payload?: Record<string, unknown>; scrollback?: number }
) {
  const urls: string[] = [];
  const app = {
    activeSessionId: 's1',
    sessions: new Map([['s1', { mode }]]),
    detachedSessions: new Set<string>(),
    _selectGeneration: 7,
    _fullHistoryRepullInFlight: false,
    _isLoadingBuffer: false,
    _loadBufferQueue: null as { at: number; data: string }[] | null,
    _fullHistoryRepullAt: new Map<string, number>(),
    _fullHistoryRepullUseless: new Set<string>(),
    _historyReloadDismissed: new Set<string>(),
    _paneHistoryLines: new Map<string, number>(),
    terminalBufferCache: new Map<string, string>(),
    terminal: {
      cols: 80,
      rows: 30,
      // xterm's scrollback option; 0 leaves the browser-cap check out of a test.
      options: { scrollback },
      scrollToLine: vi.fn(),
      buffer: { active: { length: bufferRows, baseY: 0, viewportY: 0, getLine: (_row: number) => undefined } },
      scrollToTop: vi.fn(),
    },
    _estimateReplayRows: mixin._estimateReplayRows,
    _replayWouldShrinkBuffer: mixin._replayWouldShrinkBuffer,
    _beginBufferLoad: mixin._beginBufferLoad,
    _finishBufferLoad: vi.fn(function (this: unknown, owner: string, opts?: object) {
      return (mixin._finishBufferLoad as Function).call(this, owner, opts);
    }),
    batchTerminalWrite: vi.fn(function (this: unknown, data: string) {
      return (mixin.batchTerminalWrite as Function).call(this, data);
    }),
    _captureViewportAnchor: mixin._captureViewportAnchor,
    _restoreViewportAnchor: mixin._restoreViewportAnchor,
    pendingWrites: [] as string[],
    _scheduleTerminalWriteFlush: vi.fn(),
    isTerminalAtBottom: () => true,
    _scheduleDroppedOutputRecovery: vi.fn(),
    _fetchTerminalCapture: vi.fn(async (url: string) => {
      urls.push(url);
      return {
        headersAt: performance.now(),
        headers: { get: () => '' },
        json: { data: { terminalBuffer: capture, source: 'mux-full-history', ...payload } },
      };
    }),
    _recordTerminalLoadTiming: vi.fn(),
    _logScrollRouting: vi.fn(),
    _notePaneHistory: vi.fn(),
    // The real method behind a spy, so a test sees both what it was called with
    // and the banner state (`_historyTruncation`) it leaves behind.
    _historyTruncation: new Map<string, unknown>(),
    _renderHistoryTruncationBanner: vi.fn(),
    _setHistoryTruncation: vi.fn((sessionId: string, p?: Record<string, unknown>): void => {
      setHistoryTruncation.call(app, sessionId, p);
    }),
    _resetTerminalForReplay: vi.fn(),
    _bufferLoadFinishOpts: loadAppMethod('_bufferLoadFinishOpts'),
    chunkedTerminalWrite: vi.fn(async (_buffer?: string, _size?: number, owner?: string, opts?: object) => {
      (mixin._finishBufferLoad as Function).call(app, owner, opts);
      return { parsedAt: performance.now(), bufferLength: 400, completed: true };
    }),
    _syncStickyScrollBaseline: vi.fn(),
  };
  return { app, urls };
}

describe('shell scroll-up pulls a bounded window of tmux history', () => {
  it('a shell scroll gesture requests full history bounded by the tail size', async () => {
    const { app, urls } = makeApp('shell', { bufferRows: 40, capture: lines(300) });
    await refetch.call(app);
    expect(urls).toEqual([`/api/sessions/s1/terminal?full=1&tail=${TERMINAL_TAIL_SIZE}`]);
    // It then actually replays the recovered history.
    expect(app._resetTerminalForReplay).toHaveBeenCalledTimes(1);
    expect(app.chunkedTerminalWrite).toHaveBeenCalledTimes(1);
  });

  it('the Load full history button stays unbounded for a shell', async () => {
    const { app, urls } = makeApp('shell', { bufferRows: 40, capture: lines(300) });
    await refetch.call(app, { force: true });
    expect(urls).toEqual(['/api/sessions/s1/terminal?full=1']);
  });

  it('other modes keep the unbounded scroll pull', async () => {
    const { app, urls } = makeApp('claude', { bufferRows: 40, capture: lines(300) });
    await refetch.call(app);
    expect(urls).toEqual(['/api/sessions/s1/terminal?full=1']);
  });

  it('a bounded window the browser already holds is not rewritten', async () => {
    // Browser already has every row the window carries: resetting to rewrite
    // it would jump the viewport on every scroll that outlasts the cooldown.
    const { app } = makeApp('shell', { bufferRows: 320, capture: lines(300) });
    await refetch.call(app);
    expect(app._resetTerminalForReplay).not.toHaveBeenCalled();
    expect(app.chunkedTerminalWrite).not.toHaveBeenCalled();
    // Not latched as useless: more output can put more history in tmux.
    expect(app._fullHistoryRepullUseless.has('s1')).toBe(false);
    // Nothing was written, so the banner state is left exactly as it was.
    expect(app._setHistoryTruncation).not.toHaveBeenCalled();
    // …but the skip is visible to someone diagnosing "scroll-to-top does nothing".
    expect(app._logScrollRouting).toHaveBeenCalledWith('repull-skipped-bounded');
  });

  it("a browser at xterm's scrollback cap stops replaying a window it can never hold, and backs off", async () => {
    // xterm keeps at most `scrollback + rows` rows while tmux keeps 100k lines, so
    // a 1 MiB window of short lines can carry more rows than the browser ever will.
    // `windowRows <= rows held` then never comes true, and every scroll-to-top
    // past the cooldown reset and re-parsed the window. Untruncated on purpose:
    // the back-off has to come from the full browser, not from `truncated`.
    const { app } = makeApp('shell', { bufferRows: 40, capture: lines(2000), scrollback: 1000 });

    // The first pull has room to grow, so it replays.
    await refetch.call(app);
    expect(app._resetTerminalForReplay).toHaveBeenCalledTimes(1);
    expect(app._fullHistoryRepullUseless.has('s1')).toBe(false);
    // xterm kept only the last `scrollback + rows` of the 2000 rows written.
    app.terminal.buffer.active.length = 1000 + 30;

    // Past the 4 s cooldown: the browser is full, so nothing is replayed and the
    // session backs off for a minute.
    app._fullHistoryRepullAt.set('s1', Date.now() - 5000);
    await refetch.call(app);
    expect(app._fetchTerminalCapture).toHaveBeenCalledTimes(2);
    expect(app._resetTerminalForReplay).toHaveBeenCalledTimes(1);
    expect(app.chunkedTerminalWrite).toHaveBeenCalledTimes(1);
    expect(app._fullHistoryRepullUseless.has('s1')).toBe(true);

    // So a scroll 10 s later does not even ask the server for another capture.
    app._fullHistoryRepullAt.set('s1', Date.now() - 10_000);
    await refetch.call(app);
    expect(app._fetchTerminalCapture).toHaveBeenCalledTimes(2);
    expect(app._resetTerminalForReplay).toHaveBeenCalledTimes(1);
  });

  it('a replayed window cut from a byte-capped capture still offers Load full history', async () => {
    // The route keeps `truncationReason: 'capped'` through the tail cut when the
    // full capture exceeded the byte cap. On a bounded window that is not "gone for
    // good": the unbounded pull behind the button returns up to the cap itself.
    const capped = { ...TAIL_CUT, truncationReason: 'capped', fullSize: 40 * 1024 * 1024 };
    const { app } = makeApp('shell', { bufferRows: 40, capture: lines(300), payload: capped });

    await refetch.call(app);

    expect(app._resetTerminalForReplay).toHaveBeenCalledTimes(1);
    expect(app._setHistoryTruncation).toHaveBeenCalledWith('s1', expect.objectContaining({ truncationReason: 'tail' }));
    const notice = computeNotice(app._historyTruncation.get('s1') as Record<string, unknown>);
    expect(notice.visible).toBe(true);
    expect(notice.canLoadMore).toBe(true);

    // The button's own unbounded pull is the one place 'capped' is the truth.
    const button = makeApp('shell', { bufferRows: 40, capture: lines(300), payload: capped });
    await refetch.call(button.app, { force: true });
    expect(computeNotice(button.app._historyTruncation.get('s1') as Record<string, unknown>).canLoadMore).toBe(false);
  });
});

describe('manual full-history recovery while reading (#814)', () => {
  function makeScrollApp(mode = 'omp') {
    const { app: base, urls } = makeApp(mode, { bufferRows: 130, capture: lines(400) });
    const app = Object.assign(base, {
      _liveOutputSinceFullPull: new Set<string>(),
      _liveOutputGen: new Map<string, number>(),
      _earlyReplayTravel: null as { sessionId: string; moves: number[] } | null,
      _wasAtBottomBeforeWrite: false,
      _scheduleTerminalWriteFlush: vi.fn(),
      _restoreTerminalViewport: vi.fn(),
      _noteMobileImeAuthoritativeOutput: vi.fn(),
      _hasRecentUserScrollUp: () => false,
      isTerminalAtBottom: () => app.terminal.buffer.active.viewportY >= app.terminal.buffer.active.baseY - 2,
      _setHistoryNoticeRevealed: vi.fn(),
      _maybeRefetchFullHistory: vi.fn((opts?: { anchor?: string }) => refetch.call(app, opts)),
    });
    Object.assign(app.terminal.buffer.active, { baseY: 100, viewportY: 100 });
    const active = app.terminal.buffer.active as typeof app.terminal.buffer.active & { viewportY: number };
    Object.assign(app.terminal, {
      write: vi.fn((_text: string, done: () => void) => done()),
      scrollToBottom: vi.fn(),
      scrollLines: (n: number) => {
        active.viewportY = Math.max(0, Math.min(active.baseY, active.viewportY + n));
      },
    });
    app.terminal.scrollToLine.mockImplementation((row: number) => {
      active.viewportY = row;
    });
    app.chunkedTerminalWrite.mockImplementation(async (_buffer, _size, owner, opts) => {
      active.baseY = 370;
      active.viewportY = 370;
      active.length = 400;
      (mixin._finishBufferLoad as Function).call(app, owner, opts);
      return { parsedAt: performance.now(), bufferLength: 400, completed: true };
    });
    const liveOutput = () => {
      (mixin.batchTerminalWrite as Function).call(app, 'live repaint');
      (mixin.flushPendingWrites as Function).call(app);
    };
    const scroll = async (n: number) => {
      active.viewportY = Math.max(0, Math.min(active.baseY, active.viewportY + n));
      (mixin._maybeLoadMoreHistoryOnScroll as Function).call(app, n);
      const pull = app._maybeRefetchFullHistory.mock.results.at(-1);
      if (pull) await pull.value;
    };
    function pauseReplay(beforeComplete = () => {}) {
      const replay = app.chunkedTerminalWrite.getMockImplementation()!;
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const { promise: ready, resolve: started } = Promise.withResolvers<void>();
      app.chunkedTerminalWrite.mockImplementationOnce(async (...args) => {
        active.baseY = 0;
        active.viewportY = 0;
        started();
        await gate;
        const result = await replay(...args);
        beforeComplete();
        return result;
      });
      return { ready, release };
    }
    const reload = () => app._maybeRefetchFullHistory({ force: true, anchor: 'content' });
    return { app, active, urls, liveOutput, scroll, reload, pauseReplay };
  }

  it('never pulls mid-history after live output, but still pulls at the top', async () => {
    const { app, active, urls, liveOutput, scroll } = makeScrollApp();
    liveOutput();
    await scroll(-5);
    expect(urls).toEqual([]);
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(true);
    await scroll(-active.viewportY);
    expect(urls).toEqual(['/api/sessions/s1/terminal?full=1']);
    expect(app._maybeRefetchFullHistory).toHaveBeenCalledWith();
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(false);
  });

  it.each([
    { moves: [-12], distance: 17 },
    { moves: [20], distance: 0 },
    { moves: [-1000], distance: 370 },
    // Reversal after an edge: each move clamps as it would have live.
    { moves: [20, -12], distance: 12 },
    { moves: [-1000, 30], distance: 340 },
  ])('replays travel $moves made during an unfinished replay, clamped per move', async ({ moves, distance }) => {
    const { app, active, liveOutput, reload, pauseReplay } = makeScrollApp();
    // The replay prepends older rows; give the reader real matching content
    // rather than relying on the old blank-buffer bottom-distance fallback.
    Object.assign(active, {
      getLine: (row: number) => ({ translateToString: () => `history ${row - active.baseY}` }),
    });
    liveOutput();
    active.viewportY -= 5; // Read five rows above live output before the manual action.
    const paused = pauseReplay();
    const pull = reload();
    await paused.ready;
    // The temporary reset buffer cannot scroll, but the gesture still counts.
    for (const move of moves) (mixin._maybeLoadMoreHistoryOnScroll as Function).call(app, move);
    expect(app._maybeRefetchFullHistory).toHaveBeenCalledTimes(1);
    paused.release();
    await pull;
    expect(active.baseY - active.viewportY).toBe(distance);
    expect(app._earlyReplayTravel).toBeNull();
  });

  it('queues download-time output and replays it through batchTerminalWrite after the capture', async () => {
    const { app, urls, liveOutput, reload } = makeScrollApp();
    liveOutput();
    const fetchCapture = app._fetchTerminalCapture.getMockImplementation()!;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    app._fetchTerminalCapture.mockImplementationOnce(async (url: string) => {
      expect(app._isLoadingBuffer).toBe(true);
      const capture = await fetchCapture(url);
      await promise;
      return capture;
    });
    const pull = reload();
    loadAppMethod('_onSessionTerminal').call(app, { id: 's1', data: 'download-time output' });
    expect(app._loadBufferQueue).toEqual([expect.objectContaining({ data: 'download-time output' })]);
    release();
    await pull;
    expect(urls).toHaveLength(1);
    expect(app.batchTerminalWrite).toHaveBeenCalledWith('download-time output');
    expect(app.pendingWrites).toContain('download-time output');
    expect(app._isLoadingBuffer).toBe(false);
    // Flushing the replayed queue marks the session again.
    (mixin.flushPendingWrites as Function).call(app);
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(true);
  });

  it('keeps live output flushed before the final restore dirty for the next manual pull', async () => {
    const { app, active, urls, liveOutput, reload, pauseReplay } = makeScrollApp();
    liveOutput();
    const generation = app._liveOutputGen.get('s1');
    const paused = pauseReplay(liveOutput);
    const pull = reload();
    await paused.ready;
    paused.release();
    await pull;
    expect(app._liveOutputGen.get('s1')).toBe(generation! + 1);
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(true);
    app._fullHistoryRepullAt.clear();
    active.viewportY = active.baseY;
    await reload();
    expect(urls).toEqual(['/api/sessions/s1/terminal?full=1', '/api/sessions/s1/terminal?full=1']);
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(false);
  });

  it('keeps a clean non-shell session local until the existing top path is reached', async () => {
    const { app, active, urls, scroll } = makeScrollApp();
    await scroll(-5);
    expect(urls).toEqual([]);
    await scroll(-active.viewportY);
    expect(urls).toEqual(['/api/sessions/s1/terminal?full=1']);
    expect(app._maybeRefetchFullHistory).toHaveBeenCalledWith();
    expect(app.terminal.scrollToLine).toHaveBeenCalledWith(270);
  });

  it('never pulls early for a shell, even after live output', async () => {
    const { urls, liveOutput, scroll } = makeScrollApp('shell');
    liveOutput();
    await scroll(-5);
    expect(urls).toEqual([]);
    await scroll(-95);
    expect(urls).toEqual([`/api/sessions/s1/terminal?full=1&tail=${TERMINAL_TAIL_SIZE}`]);
  });

  it('does not dirty a session while replay loading queues its output', () => {
    const { app, liveOutput } = makeScrollApp();
    app._isLoadingBuffer = true;
    liveOutput();
    expect(app._liveOutputSinceFullPull.size).toBe(0);
  });

  it('keeps marked mid-history travel local in either direction', async () => {
    const { active, urls, liveOutput, scroll } = makeScrollApp();
    liveOutput();
    active.viewportY = 50;
    await scroll(-5);
    await scroll(3);
    expect(urls).toEqual([]);
  });

  it.each(['_isLoadingBuffer', '_fullHistoryRepullInFlight'] as const)('respects the %s guard', async (guard) => {
    const { app, urls, liveOutput, reload } = makeScrollApp();
    liveOutput();
    app[guard] = true;
    await reload();
    expect(urls).toEqual([]);
  });

  it('bypasses the cooldown for manual reload but keeps the downgrade guard', async () => {
    const { app, active, urls, liveOutput, reload } = makeScrollApp();
    liveOutput();
    app._fullHistoryRepullAt.set('s1', Date.now());
    active.length = 1000;
    active.viewportY -= 5;
    const eligible = loadAppMethod('_historyReloadActionEligible');
    expect(eligible.call(app)).toBe(true);
    await reload();
    expect(urls).toHaveLength(1);
    expect(app._resetTerminalForReplay).not.toHaveBeenCalled();
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(true);
    expect(app._fullHistoryRepullUseless.has('s1')).toBe(true);
    expect(app._historyReloadDismissed.has('s1')).toBe(true);
    expect(eligible.call(app)).toBe(false);
  });

  it.each([
    { kind: 'byte-history fallback', data: { terminalBuffer: lines(400), source: 'history' } },
    { kind: 'empty response', data: { terminalBuffer: '', source: 'history' } },
  ])('retires manual reload after a $kind answer', async ({ data }) => {
    const { app, active, urls, liveOutput, reload } = makeScrollApp();
    app._fetchTerminalCapture.mockImplementation(async (url: string) => {
      urls.push(url);
      return { headersAt: performance.now(), headers: { get: () => '' }, json: { success: true, data } };
    });
    liveOutput();
    active.viewportY -= 5;
    const eligible = loadAppMethod('_historyReloadActionEligible');
    expect(eligible.call(app)).toBe(true);
    await reload();
    expect(urls).toHaveLength(1);
    // Only a mux replay clears the mark, so without retiring the action every
    // tap would repeat the forced, unbounded capture.
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(true);
    active.viewportY = Math.max(0, active.baseY - 5);
    expect(eligible.call(app)).toBe(false);
  });

  it('keeps manual reload available after a transient error envelope', async () => {
    const { app, active, urls, liveOutput, reload } = makeScrollApp();
    app._fetchTerminalCapture.mockImplementation(async (url: string) => {
      urls.push(url);
      return { headersAt: performance.now(), headers: { get: () => '' }, json: { success: false, data: {} } };
    });
    liveOutput();
    active.viewportY -= 5;
    await reload();
    expect(urls).toHaveLength(1);
    expect(loadAppMethod('_historyReloadActionEligible').call(app)).toBe(true);
  });

  it('ignores a fallback answer that arrives after an A -> B -> A switch', async () => {
    const { app, active, urls, liveOutput, reload } = makeScrollApp();
    const { promise: answer, resolve: respond } = Promise.withResolvers<void>();
    app._fetchTerminalCapture.mockImplementation(async (url: string) => {
      urls.push(url);
      await answer;
      return {
        headersAt: performance.now(),
        headers: { get: () => '' },
        json: { success: true, data: { terminalBuffer: lines(400), source: 'history' } },
      };
    });
    liveOutput();
    active.viewportY -= 5;
    const pending = reload();
    // The user switched away and back; that newer select's capture already
    // cleared the dismissal, so the old request's answer is stale.
    app._selectGeneration += 2;
    app._historyReloadDismissed.delete('s1');
    respond();
    await pending;
    expect(urls).toHaveLength(1);
    expect(app._historyReloadDismissed.has('s1')).toBe(false);
    expect(loadAppMethod('_historyReloadActionEligible').call(app)).toBe(true);
  });

  it.each(['empty', 'tab-switch', 'downgrade', 'bounded-shell', 'rejection'])(
    'flushes download-time output on the %s non-replay path',
    async (exit) => {
      const { app } = makeApp(exit === 'bounded-shell' ? 'shell' : 'omp', {
        bufferRows: 200,
        capture: lines(400),
      });
      const { promise, resolve: release } = Promise.withResolvers<void>();
      app._fetchTerminalCapture.mockImplementationOnce(async () => {
        await promise;
        if (exit === 'rejection') throw new Error('offline');
        if (exit === 'tab-switch') app._selectGeneration++;
        return {
          headersAt: performance.now(),
          headers: { get: () => '' },
          json: { data: { terminalBuffer: exit === 'empty' ? '' : lines(10), source: 'mux-full-history' } },
        };
      });
      const pull = refetch.call(app);
      expect(app._isLoadingBuffer).toBe(true);
      loadAppMethod('_onSessionTerminal').call(app, { id: 's1', data: 'queued while fetching' });
      release();
      await pull;
      expect(app.chunkedTerminalWrite).not.toHaveBeenCalled();
      expect(app._finishBufferLoad).toHaveBeenCalledOnce();
      expect(app._finishBufferLoad).toHaveBeenCalledWith(expect.any(String), { flushQueued: true, since: 0 });
      expect(app.pendingWrites).toContain('queued while fetching');
      expect(app._isLoadingBuffer).toBe(false);
    }
  );

  it('counts download-time output toward the 128 KiB dropped-output recovery cap', async () => {
    const { app } = makeApp('omp', { bufferRows: 30, capture: lines(400) });
    const { promise, resolve: release } = Promise.withResolvers<void>();
    app._fetchTerminalCapture.mockImplementationOnce(async () => {
      await promise;
      return {
        headersAt: performance.now(),
        headers: { get: () => '' },
        json: { data: { terminalBuffer: '', source: 'history' } },
      };
    });
    const pull = refetch.call(app);
    const onTerminal = loadAppMethod('_onSessionTerminal');
    onTerminal.call(app, { id: 's1', data: 'x'.repeat(70_000) });
    onTerminal.call(app, { id: 's1', data: 'y'.repeat(70_000) });
    expect(app._scheduleDroppedOutputRecovery).toHaveBeenCalledWith('s1', 0, 70_000);
    expect(app._loadBufferQueue).toHaveLength(1);
    release();
    await pull;
  });

  it.each([false, true])(
    'defers real dropped-output recovery through a slow pull (timer already armed: %s)',
    async (armed) => {
      vi.useFakeTimers();
      const { promise, resolve: release } = Promise.withResolvers<void>();
      try {
        const { app } = makeApp('omp', { bufferRows: 30, capture: lines(400) });
        const retry = vi.fn(({ repainted, stillActive, attempt }) => !repainted && stillActive && attempt < 4);
        const schedule = loadAppMethod('_scheduleDroppedOutputRecovery', {
          setTimeout,
          window: { CodemanDroppedOutput: { DROP_RECOVERY_DELAY_MS: 2000, shouldRetryDroppedOutputRecovery: retry } },
        });
        const refresh = vi.fn(async () => true);
        Object.assign(app, {
          _scheduleDroppedOutputRecovery: (...args: unknown[]) => schedule.apply(app, args),
          _onSessionNeedsRefresh: refresh,
        });
        if (armed) schedule.call(app, 's1');
        const fetchCapture = app._fetchTerminalCapture.getMockImplementation()!;
        app._fetchTerminalCapture.mockImplementationOnce(async (url) => {
          await promise;
          return fetchCapture(url);
        });
        const pull = refetch.call(app);
        const onTerminal = loadAppMethod('_onSessionTerminal');
        onTerminal.call(app, { id: 's1', data: 'x'.repeat(70_000) });
        onTerminal.call(app, { id: 's1', data: 'y'.repeat(70_000) });
        await vi.advanceTimersByTimeAsync(20_000); // Longer than all five normal retry intervals.
        expect(app._isLoadingBuffer).toBe(true);
        expect(refresh).not.toHaveBeenCalled();
        expect(retry).not.toHaveBeenCalled();
        release();
        await pull;
        expect(app._isLoadingBuffer).toBe(false);
        await vi.advanceTimersByTimeAsync(2000);
        expect(refresh).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledWith({ id: 's1' });
        expect(retry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 0, repainted: true }));
      } finally {
        release();
        vi.useRealTimers();
      }
    }
  );

  it.each([false, true])('resumes a deferred recovery at its saved attempt (timer armed: %s)', async (armed) => {
    vi.useFakeTimers();
    try {
      const { app } = makeApp('omp', { bufferRows: 30, capture: lines(400) });
      const retry = vi.fn(() => false);
      const schedule = loadAppMethod('_scheduleDroppedOutputRecovery', {
        setTimeout,
        window: { CodemanDroppedOutput: { DROP_RECOVERY_DELAY_MS: 2000, shouldRetryDroppedOutputRecovery: retry } },
      });
      Object.assign(app, {
        _scheduleDroppedOutputRecovery: (...args: unknown[]) => schedule.apply(app, args),
        _onSessionNeedsRefresh: vi.fn(async () => false),
      });
      if (armed) schedule.call(app, 's1', 3);
      const owner = (app._beginBufferLoad as Function).call(app);
      if (armed) await vi.advanceTimersByTimeAsync(2000);
      else schedule.call(app, 's1', 3);
      expect(Reflect.get(app, '_pendingDroppedOutputRecovery')).toEqual({ sessionId: 's1', attempt: 3 });
      app._finishBufferLoad(owner);
      await vi.advanceTimersByTimeAsync(2000);
      expect(retry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attempt: 3 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resume a deferred recovery for a tab that is no longer active', () => {
    const { app } = makeApp('omp', { bufferRows: 30, capture: lines(400) });
    const owner = (app._beginBufferLoad as Function).call(app);
    Object.assign(app, { _pendingDroppedOutputRecovery: { sessionId: 's1', attempt: 3 }, activeSessionId: 's2' });
    app._finishBufferLoad(owner);
    expect(app._scheduleDroppedOutputRecovery).not.toHaveBeenCalled();
    expect(Reflect.get(app, '_pendingDroppedOutputRecovery')).toBeNull();
  });

  it.each(['mux-full-history', 'history'])('clears the scroll-pull mark only for a mux capture: %s', async (source) => {
    const { app, liveOutput, reload } = makeScrollApp();
    liveOutput();
    const fetchCapture = app._fetchTerminalCapture.getMockImplementation()!;
    app._fetchTerminalCapture.mockImplementationOnce(async (url) => {
      const capture = await fetchCapture(url);
      capture.json.data.source = source;
      return capture;
    });
    await reload();
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(source !== 'mux-full-history');
  });

  it('does not swallow another tab’s travel or clear the old mark when replay is cancelled', async () => {
    const { app, active, liveOutput, reload, pauseReplay } = makeScrollApp();
    liveOutput();
    const paused = pauseReplay();
    const pull = reload();
    await paused.ready;
    app.activeSessionId = 's2';
    app._selectGeneration++;
    active.baseY = 100;
    active.viewportY = 100;
    (mixin._maybeLoadMoreHistoryOnScroll as Function).call(app, 3);
    expect(app._setHistoryNoticeRevealed).toHaveBeenCalledWith(null);
    expect(app._earlyReplayTravel?.moves).toEqual([]);
    paused.release();
    await pull;
    expect(app._liveOutputSinceFullPull.has('s1')).toBe(true);
    expect(app._earlyReplayTravel).toBeNull();
  });
});

describe('a skipped bounded window never damages the Load full history banner', () => {
  it('a tail-cut window smaller than the browser is not replayed and never marks the session exhausted', async () => {
    // The browser holds far more rows than a 1 MiB window carries, and tmux holds
    // ~3 MiB. The downgrade guard reads that as "tmux has nothing more to give",
    // which is true of an unbounded capture and false of a window cut at the tail.
    const { app } = makeApp('shell', { bufferRows: 5000, capture: lines(300), payload: TAIL_CUT });
    // The tab load that put this session on screen left it truncated and recoverable.
    app._setHistoryTruncation('s1', TAIL_CUT);
    app._setHistoryTruncation.mockClear();

    await refetch.call(app);

    expect(app._resetTerminalForReplay).not.toHaveBeenCalled();
    expect(app.chunkedTerminalWrite).not.toHaveBeenCalled();
    // Not even a relabel: a skipped window writes nothing, banner state included.
    expect(app._setHistoryTruncation).not.toHaveBeenCalled();
    const notice = computeNotice(app._historyTruncation.get('s1') as Record<string, unknown>);
    expect(notice.visible).toBe(true);
    // "Earlier output is no longer kept" would be a lie: tmux still holds ~2 MiB more.
    expect(notice.canLoadMore).toBe(true);
  });

  it('a skip right after Load full history leaves the banner as that load set it', async () => {
    // Load full history replayed everything, so nothing is truncated any more.
    const afterLoadFullHistory = {
      truncated: false,
      fullSize: 3 * 1024 * 1024,
      retainedBytes: 3 * 1024 * 1024,
      source: 'mux-full-history',
    };
    const { app } = makeApp('shell', { bufferRows: 5000, capture: lines(300), payload: TAIL_CUT });
    app._setHistoryTruncation('s1', afterLoadFullHistory);
    const before = structuredClone(app._historyTruncation.get('s1'));
    app._setHistoryTruncation.mockClear();

    await refetch.call(app);

    // Relabelling it from the bounded payload would call a terminal that holds ALL
    // of the history "the most recent 1.0 MB".
    expect(app._setHistoryTruncation).not.toHaveBeenCalled();
    expect(app._historyTruncation.get('s1')).toEqual(before);
    expect(computeNotice(app._historyTruncation.get('s1') as Record<string, unknown>).visible).toBe(false);
  });

  it('backs off for a minute after a truncated skip, and keeps the 4 s cooldown after an untruncated one', async () => {
    // Truncated: the gesture cannot reach anything older than the browser shows, and
    // every ask costs the server a synchronous capture of the whole history.
    // Only just larger than the window, so the downgrade guard does not fire here:
    // the back-off has to come from the skip itself.
    const cut = makeApp('shell', { bufferRows: 320, capture: lines(300), payload: TAIL_CUT });
    await refetch.call(cut.app);
    expect(cut.app._fullHistoryRepullUseless.has('s1')).toBe(true);
    expect(cut.app._fetchTerminalCapture).toHaveBeenCalledTimes(1);

    // Well past 4 s, still inside the minute: no second capture.
    cut.app._fullHistoryRepullAt.set('s1', Date.now() - 10_000);
    await refetch.call(cut.app);
    expect(cut.app._fetchTerminalCapture).toHaveBeenCalledTimes(1);

    cut.app._fullHistoryRepullAt.set('s1', Date.now() - 61_000);
    await refetch.call(cut.app);
    expect(cut.app._fetchTerminalCapture).toHaveBeenCalledTimes(2);

    // Untruncated: it IS all of tmux's history, and the next burst can add to it.
    const whole = makeApp('shell', { bufferRows: 320, capture: lines(300) });
    await refetch.call(whole.app);
    expect(whole.app._fullHistoryRepullUseless.has('s1')).toBe(false);
    whole.app._fullHistoryRepullAt.set('s1', Date.now() - 5000);
    await refetch.call(whole.app);
    expect(whole.app._fetchTerminalCapture).toHaveBeenCalledTimes(2);
  });

  it('the downgrade guard still refuses an unbounded capture smaller than the browser, and still marks it exhausted', async () => {
    // Reordering must not weaken the guard it moved above: a repaint-mode pane's
    // capture really is one frame, and rewriting with it would destroy history.
    const oneFrame = makeApp('claude', { bufferRows: 300, capture: lines(36) });
    await refetch.call(oneFrame.app);
    expect(oneFrame.app._resetTerminalForReplay).not.toHaveBeenCalled();
    expect(oneFrame.app._setHistoryTruncation).toHaveBeenCalledWith('s1', expect.objectContaining({ exhausted: true }));
    expect(oneFrame.app._fullHistoryRepullUseless.has('s1')).toBe(true);

    // The button is unbounded too, so the same guard governs it for a shell.
    const button = makeApp('shell', { bufferRows: 5000, capture: lines(300) });
    await refetch.call(button.app, { force: true });
    expect(button.app._resetTerminalForReplay).not.toHaveBeenCalled();
    expect(button.app._setHistoryTruncation).toHaveBeenCalledWith('s1', expect.objectContaining({ exhausted: true }));
  });
});

describe('_replayWouldShrinkBuffer takes rows the caller already estimated', () => {
  const shrink = mixin._replayWouldShrinkBuffer as (this: unknown, capture: string, rows?: number) => boolean;
  const make = () => ({
    terminal: { cols: 80, rows: 30, buffer: { active: { length: 200 } } },
    _estimateReplayRows: vi.fn(mixin._estimateReplayRows as (t: string, c: number) => number),
  });

  it('does not scan the capture again when handed the estimate', () => {
    const ctx = make();
    expect(shrink.call(ctx, lines(300), 300)).toBe(false);
    expect(shrink.call(ctx, lines(300), 5)).toBe(true);
    expect(ctx._estimateReplayRows).not.toHaveBeenCalled();
  });

  it('still estimates for itself when called the old way', () => {
    const ctx = make();
    expect(shrink.call(ctx, lines(300))).toBe(false);
    expect(ctx._estimateReplayRows).toHaveBeenCalledTimes(1);
  });
});

describe('a pull that outlives a tab switch never rewrites the terminal', () => {
  it('drops the capture when the select generation moved during the fetch, even back to the same session', async () => {
    // A -> B -> A while the request was out: the active id matches again, but
    // selectSession is replaying its own capture, and a reset here would land
    // in the middle of that write.
    const { app } = makeApp('claude', { bufferRows: 40, capture: lines(300) });
    app._fetchTerminalCapture.mockImplementationOnce(async () => {
      app._selectGeneration = 9;
      return {
        headersAt: performance.now(),
        headers: { get: () => '' },
        json: { data: { terminalBuffer: lines(300), source: 'mux-full-history' } },
      };
    });
    await refetch.call(app);
    expect(app._resetTerminalForReplay).not.toHaveBeenCalled();
    expect(app.chunkedTerminalWrite).not.toHaveBeenCalled();
    expect(app._fullHistoryRepullInFlight).toBe(false);
    // Nor does the stale response overwrite what the switch back recorded about the pane.
    expect(app._notePaneHistory).not.toHaveBeenCalled();
  });

  it('replays when no switch happened, and records the pane', async () => {
    const { app } = makeApp('claude', { bufferRows: 40, capture: lines(300) });
    await refetch.call(app);
    expect(app._resetTerminalForReplay).toHaveBeenCalledTimes(1);
    expect(app.chunkedTerminalWrite).toHaveBeenCalledTimes(1);
    expect(app._notePaneHistory).toHaveBeenCalledWith('s1', expect.objectContaining({ source: 'mux-full-history' }));
  });
});

describe('an unloaded buffer is not held to an older downgrade refusal', () => {
  it('pulls on the normal cooldown when the buffer is one screen and the pane holds scrollback', async () => {
    // A refused pull latches a 60 s cooldown because the browser then held MORE
    // than tmux. A tab switch that replays a hollow tail voids that premise, and
    // with paging suppressed for such a buffer the latch would leave the gesture
    // dead for up to a minute.
    const { app, urls } = makeApp('claude', { bufferRows: 30, capture: lines(300) });
    app._fullHistoryRepullUseless.add('s1');
    app._fullHistoryRepullAt.set('s1', Date.now() - 10_000);
    app.terminal.buffer.active.baseY = 0;
    app._paneHistoryLines.set('s1', 11_344);
    await refetch.call(app);
    expect(urls).toEqual(['/api/sessions/s1/terminal?full=1']);
    expect(app._resetTerminalForReplay).toHaveBeenCalledTimes(1);
  });

  it('keeps the latch while the buffer still holds the history the refusal was about', async () => {
    const { app, urls } = makeApp('claude', { bufferRows: 300, capture: lines(300) });
    app._fullHistoryRepullUseless.add('s1');
    app._fullHistoryRepullAt.set('s1', Date.now() - 10_000);
    app.terminal.buffer.active.baseY = 270;
    app._paneHistoryLines.set('s1', 11_344);
    await refetch.call(app);
    expect(urls).toEqual([]);
  });

  it('records nothing from an error envelope, so the remembered count survives for the retry', async () => {
    // A JSON 5xx parses like any response. Recording its empty data would
    // forget the count and hand the next gesture back to the paging fallback.
    const { app } = makeApp('claude', { bufferRows: 30, capture: lines(300) });
    app._paneHistoryLines.set('s1', 11_344);
    app._fetchTerminalCapture.mockImplementationOnce(async () => ({
      headersAt: performance.now(),
      headers: { get: () => '' },
      json: { success: false, error: 'tmux capture failed' },
    }));
    await refetch.call(app);
    expect(app._notePaneHistory).not.toHaveBeenCalled();
    expect(app._resetTerminalForReplay).not.toHaveBeenCalled();
    expect(app._fullHistoryRepullInFlight).toBe(false);
  });
});

describe('content anchors hold the reader through a history repair', () => {
  function fixture(rows: string[], viewportY = 5) {
    let content = rows;
    const active = {
      viewportY,
      baseY: rows.length - 3,
      length: rows.length,
      getLine: vi.fn((row: number) =>
        content[row] === undefined
          ? undefined
          : {
              translateToString: () => content[row],
            }
      ),
    };
    const app = { terminal: { buffer: { active }, scrollToLine: vi.fn() } };
    const capture = () => (mixin._captureViewportAnchor as Function).call(app);
    const restore = (anchor: unknown, next: string[]) => {
      content = next;
      active.baseY = next.length - 3;
      active.length = next.length;
      return (mixin._restoreViewportAnchor as Function).call(app, anchor);
    };
    return { app, active, capture, restore };
  }

  it('keeps a three-row signature at its viewport offset when rows are inserted below the reader', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `row ${i}`);
    rows[5] = '';
    const { app, capture, restore } = fixture(rows);
    const anchor = capture();
    const target = restore(anchor, [...rows.slice(0, 12), ...Array(20).fill('recovered'), ...rows.slice(12)]);
    expect(target).toBe(5);
    expect(app.terminal.scrollToLine).toHaveBeenCalledWith(5);
    expect(anchor.viewportY).toBe(5);
    expect(anchor.offset).toBe(1);
  });

  it('keeps the old viewport when two complete contexts match equally well', () => {
    const { capture, restore } = fixture(['head', 'A', 'B', 'C', ...Array(20).fill('tail')], 1);
    const anchor = capture();
    const next = Array(34).fill('other');
    next.splice(3, 3, 'A', 'B', 'C');
    next.splice(10, 3, 'A', 'wrong', 'wrong');
    next.splice(17, 3, 'A', 'B', 'C');
    expect(restore(anchor, next)).toBe(1);
  });

  it('keeps the old viewport rather than trusting an isolated or absent row', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `row ${i}`);
    const { capture, restore } = fixture(rows);
    const anchor = capture();
    const next = Array(40).fill('other');
    next[8] = 'row 5';
    next[17] = 'row 5';
    expect(restore(anchor, next)).toBe(5);
    expect(restore(anchor, Array(40).fill('no match'))).toBe(5);
  });

  it('keeps bottom distance within the bottom tolerance even if matching text exists', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `row ${i}`);
    const { capture, restore } = fixture(rows, 26);
    expect(restore(capture(), [...rows, ...Array(10).fill('new')])).toBe(36);
  });

  it('follows a lone distinctive row among blanks when history is inserted above the reader', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `row ${i}`);
    for (let i = 20; i < 30; i++) rows[i] = '';
    rows[25] = 'tool result: src/engine.ts';
    const { app, capture, restore } = fixture(rows, 20);
    Object.assign(app.terminal, { rows: 10 });
    const anchor = capture();
    const next = [...Array.from({ length: 40 }, (_, i) => `recovered ${i}`), ...rows];
    expect(restore(anchor, next)).toBe(60);
  });

  it('uses the visible tool result rather than a nearer copy of repeated TUI borders', () => {
    const repeated = ['╭────────╮', '', '│ Working │', '╰────────╯', '', 'OMP · processing'];
    const rows = Array.from({ length: 300 }, (_, i) => repeated[i % repeated.length]);
    rows[125] = 'tool result: src/engine.ts';
    const { app, capture, restore } = fixture(rows, 120);
    Object.assign(app.terminal, { rows: 18 });
    const anchor = capture();
    const next = [...rows.slice(0, 200), ...Array(60).fill('recovered below reader'), ...rows.slice(200)];
    expect(restore(anchor, next)).toBe(120);
  });

  it.each([false, true])('keeps the old viewport for ambiguous furniture (distinctive row lost: %s)', (lost) => {
    const repeated = ['╭────────╮', '', '│ Working │', '╰────────╯', '', 'OMP · processing'];
    const rows = Array.from({ length: 300 }, (_, i) => repeated[i % repeated.length]);
    if (lost) rows[125] = 'tool result absent from the capture';
    const { app, capture, restore } = fixture(rows, 120);
    Object.assign(app.terminal, { rows: 18 });
    const anchor = capture();
    const retained = rows.map((text, i) => (lost && i === 125 ? repeated[i % repeated.length] : text));
    const next = [...retained.slice(0, 200), ...Array(60).fill('recovered below reader'), ...retained.slice(200)];
    expect(restore(anchor, next)).toBe(120);
  });

  it.each(['first-row-only', 'absent'])('bounds a 50k-row search with an %s signature', (kind) => {
    const rows = Array.from({ length: 50_000 }, (_, i) => `original ${i}`);
    const { app, active, capture, restore } = fixture(rows, 25_000);
    Object.assign(app.terminal, { rows: 64 });
    const anchor = capture();
    const next = Array(50_000).fill('other');
    if (kind === 'first-row-only') {
      next[25_100] = anchor.signature[0];
      next[24_800] = anchor.signature[0];
    }
    // Even a whole matching viewport outside the budget cannot extend the scan.
    next.splice(30_000, anchor.context.length, ...anchor.context);
    active.getLine.mockClear();
    expect(restore(anchor, next)).toBe(25_000);
    // 4001 possible starts plus the other 63 rows in the full viewport context.
    expect(active.getLine.mock.calls.length).toBeLessThanOrEqual(4064);
  });
});

describe('manual history banner action', () => {
  type BannerElement = {
    hidden: boolean;
    disabled: boolean;
    textContent: string;
    className: string;
    type: string;
    children: BannerElement[];
    onclick: (() => Promise<void> | void) | null;
    appendChild(child: BannerElement): void;
    setAttribute: Function;
  };
  function fixture(options: Record<string, unknown> = {}) {
    const state = {
      touch: true,
      mode: 'omp',
      bottom: false,
      marked: true,
      inFlight: false,
      tiles: false,
      active: true,
      detached: false,
      enabled: true,
      loadingBuffer: false,
      loadState: false,
      paneHistoryLines: undefined as number | undefined,
      ...options,
    };
    const element = (): BannerElement => ({
      hidden: true,
      disabled: false,
      textContent: '',
      className: '',
      type: '',
      children: [],
      onclick: null,
      appendChild(child) {
        this.children.push(child);
      },
      setAttribute: vi.fn(),
    });
    const bar = element();
    const frames: FrameRequestCallback[] = [];
    const document = { addEventListener: vi.fn(), getElementById: () => bar, createElement: element };
    const ui = loadTerminalMixin({
      document,
      MobileDetection: { isTouchDevice: () => state.touch },
      requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    });
    const { app: base } = makeApp(String(state.mode), { bufferRows: 130, capture: lines(400) });
    const render = loadAppMethod('_renderHistoryTruncationBanner', {
      document,
      computeHistoryTruncationNotice: computeNotice,
    });
    const app = Object.assign(base, {
      activeSessionId: state.active ? 's1' : '',
      isTerminalAtBottom: () => state.bottom,
      loadAppSettingsFromStorage: () => ({ historyReloadAction: state.enabled }),
      _liveOutputSinceFullPull: new Set(state.marked ? ['s1'] : []),
      _historyReloadDismissed: new Set<string>(),
      _historyNoticeDismissed: new Set<string>(),
      _historyNoticeRevealedFor: null as string | null,
      _fullHistoryRepullInFlight: Boolean(state.inFlight),
      _isLoadingBuffer: Boolean(state.loadingBuffer),
      terminalLoadStates: new Map(state.loadState ? [['s1', { generation: 1, phase: 'resizing' }]] : []),
      _paneHistoryLines: new Map<string, number>(
        state.paneHistoryLines === undefined ? [] : [['s1', Number(state.paneHistoryLines)]]
      ),
      detachedSessions: new Set(state.detached ? ['s1'] : []),
      _tilesOwnTerminal: () => state.tiles,
      _maybeRefetchFullHistory: vi.fn(async (_opts: object) => {}),
      _historyReloadActionEligible: () => loadAppMethod('_historyReloadActionEligible').call(app),
      _syncHistoryReloadAction: () => loadAppMethod('_syncHistoryReloadAction').call(app),
      _scheduleHistoryReloadActionSync: () => (ui._scheduleHistoryReloadActionSync as Function).call(app),
      _renderHistoryTruncationBanner: vi.fn(() => {
        bar.children = [];
        render.call(app);
      }),
    });
    const button = () => bar.children.find((child) => child.className === 'history-trunc-load');
    const dismiss = () => bar.children.find((child) => child.className === 'history-trunc-dismiss');
    return { app, bar, button, dismiss, state, frames };
  }

  it.each([
    { opts: {}, visible: true },
    { opts: { touch: false }, visible: true },
    { opts: { enabled: false }, visible: false },
    { opts: { mode: 'shell' }, visible: false },
    { opts: { bottom: true }, visible: false },
    { opts: { marked: false }, visible: false },
    { opts: { inFlight: true }, visible: false },
    // Recorded at the session's first load: a pane opened empty keeps 0 after the
    // burst that opens the gap, so a stale 0 must not hide the action (#814).
    { opts: { paneHistoryLines: 0 }, visible: true },
    { opts: { paneHistoryLines: 5 }, visible: true },
    { opts: { loadingBuffer: true }, visible: false },
    { opts: { loadState: true }, visible: false },
    { opts: { tiles: true }, visible: false },
    { opts: { active: false }, visible: false },
    { opts: { detached: true }, visible: false },
  ])('visibility is $visible for $opts', ({ opts, visible }) => {
    const { app, bar, button } = fixture(opts);
    app._syncHistoryReloadAction();
    expect(bar.hidden).toBe(!visible);
    if (visible) expect(button()?.textContent).toBe('Reload history');
  });

  it('forces a content-anchored pull on tap and resets loading on settle', async () => {
    const { app, button } = fixture();
    const { promise, resolve: release } = Promise.withResolvers<void>();
    app._maybeRefetchFullHistory.mockReturnValueOnce(promise);
    app._syncHistoryReloadAction();
    const tapped = button()!.onclick!();
    expect(app._maybeRefetchFullHistory).toHaveBeenCalledWith({ force: true, anchor: 'content' });
    expect(button()!.disabled).toBe(true);
    expect(button()!.textContent).toBe('Loading…');
    release();
    await tapped;
    expect(button()!.disabled).toBe(false);
    expect(button()!.textContent).toBe('Reload history');
  });

  it('retires a refused reload and ignores another tap on the same stale button', async () => {
    const { app, bar, button } = fixture();
    app.terminal.buffer.active.length = 1000;
    app._maybeRefetchFullHistory.mockImplementation((opts) => refetch.call(app, opts));
    app._syncHistoryReloadAction();
    const staleButton = button()!;
    await staleButton.onclick!();
    expect(app._resetTerminalForReplay).not.toHaveBeenCalled();
    expect(app._historyReloadDismissed.has('s1')).toBe(true);
    expect(bar.hidden).toBe(true);
    expect(button()).toBeUndefined();
    await staleButton.onclick!();
    expect(app._fetchTerminalCapture).toHaveBeenCalledExactlyOnceWith('/api/sessions/s1/terminal?full=1', {
      full: true,
    });
    expect(app._maybeRefetchFullHistory).toHaveBeenCalledOnce();
    expect(bar.hidden).toBe(true);
  });

  it('shows the action when the matching terminal load state clears', () => {
    const { app, bar, button } = fixture({ loadState: true });
    Object.assign(app, { _updateTerminalLoadTab: vi.fn() });
    app._syncHistoryReloadAction();
    expect(bar.hidden).toBe(true);
    expect(button()).toBeUndefined();
    loadAppMethod('_clearTerminalLoadState').call(app, 's1', 1);
    expect(app.terminalLoadStates.has('s1')).toBe(false);
    expect(bar.hidden).toBe(false);
    expect(button()!.textContent).toBe('Reload history');
  });

  it('syncs the action after a marked session finishes loading', () => {
    const { app, bar, button } = fixture({ marked: false });
    const owner = (mixin._beginBufferLoad as Function).call(app);
    app._liveOutputSinceFullPull.add('s1');
    app._syncHistoryReloadAction();
    expect(app._historyReloadActionEligible()).toBe(false);
    expect(bar.hidden).toBe(true);
    (mixin._finishBufferLoad as Function).call(app, owner);
    expect(app._isLoadingBuffer).toBe(false);
    expect(app._historyReloadActionEligible()).toBe(true);
    expect(bar.hidden).toBe(false);
    expect(button()!.textContent).toBe('Reload history');
  });

  it('hides a dismissed loading action before the pull settles and keeps it hidden', async () => {
    const { app, bar, button, dismiss } = fixture();
    const { promise, resolve: release } = Promise.withResolvers<void>();
    app._maybeRefetchFullHistory.mockReturnValueOnce(promise);
    app._syncHistoryReloadAction();
    const tapped = button()!.onclick!();
    expect(button()!.textContent).toBe('Loading…');
    dismiss()!.onclick!();
    expect(bar.hidden).toBe(true);
    expect(app._historyReloadDismissed.has('s1')).toBe(true);
    app._syncHistoryReloadAction();
    expect(bar.hidden).toBe(true);
    release();
    await tapped;
    expect(bar.hidden).toBe(true);
    expect(button()).toBeUndefined();
  });

  it.each(['recoverable', 'exhausted', 'capped'])('never duplicates the %s notice load control', (kind) => {
    const { app, bar, button } = fixture();
    app._historyNoticeRevealedFor = 's1';
    app._setHistoryTruncation('s1', {
      ...TAIL_CUT,
      exhausted: kind === 'exhausted',
      truncationReason: kind === 'capped' ? 'capped' : 'tail',
    });
    expect(bar.children.filter((child) => child.className === 'history-trunc-load')).toHaveLength(1);
    expect(button()!.textContent).toBe(kind === 'recoverable' ? 'Load full history' : 'Reload history');
  });

  it('does no DOM work without a transition and coalesces all-device onScroll calls per frame', () => {
    const { app, state, frames } = fixture({ touch: false });
    let onScroll!: () => void;
    const source = readFileSync(resolve(PUBLIC, 'terminal-ui.js'), 'utf8');
    const registration = source.match(/^    this\.terminal\.onScroll\(.*$/m)![0];
    vm.runInNewContext(`(function () { ${registration} }).call(app)`, {
      app: {
        terminal: {
          onScroll: (callback: () => void) => {
            onScroll = callback;
          },
        },
        _scheduleHistoryReloadActionSync: app._scheduleHistoryReloadActionSync,
      },
    });
    app._syncHistoryReloadAction();
    for (let i = 0; i < 100; i++) onScroll();
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(app._renderHistoryTruncationBanner).toHaveBeenCalledOnce();
    state.bottom = true;
    onScroll();
    onScroll();
    expect(frames).toHaveLength(1);
    frames.shift()!(1);
    expect(app._renderHistoryTruncationBanner).toHaveBeenCalledTimes(2);
    app._syncHistoryReloadAction();
    expect(app._renderHistoryTruncationBanner).toHaveBeenCalledTimes(2);
    app.activeSessionId = 's2';
    app._syncHistoryReloadAction();
    expect(app._renderHistoryTruncationBanner).toHaveBeenCalledTimes(3);
  });

  it.each(['mux-full-history', 'history'])('dismisses reload until an actual full mux replay: %s', async (source) => {
    const { app, bar, dismiss, state } = fixture();
    app._syncHistoryReloadAction();
    dismiss()!.onclick!();
    expect(bar.hidden).toBe(true);
    expect(app._historyNoticeDismissed.size).toBe(0);
    state.bottom = true;
    app._syncHistoryReloadAction();
    state.bottom = false;
    app._syncHistoryReloadAction();
    expect(bar.hidden).toBe(true);
    const capture = app._fetchTerminalCapture.getMockImplementation()!;
    app._fetchTerminalCapture.mockImplementationOnce(async (url) => {
      const result = await capture(url);
      result.json.data.source = source;
      return result;
    });
    await refetch.call(app, { force: true });
    expect(app._historyReloadDismissed.has('s1')).toBe(source !== 'mux-full-history');
    app._liveOutputSinceFullPull.add('s1');
    app._syncHistoryReloadAction();
    expect(bar.hidden).toBe(source !== 'mux-full-history');
  });

  it('one × on a combined notice dismisses both, and scroll frames keep the bar hidden', () => {
    const { app, bar, button, dismiss, frames } = fixture();
    app._historyNoticeRevealedFor = 's1';
    app._setHistoryTruncation('s1', { ...TAIL_CUT, exhausted: true, truncationReason: 'tail' });
    expect(button()!.textContent).toBe('Reload history');
    dismiss()!.onclick!();
    expect(bar.hidden).toBe(true);
    expect(app._historyNoticeDismissed.has('s1')).toBe(true);
    expect(app._historyReloadDismissed.has('s1')).toBe(true);
    app._scheduleHistoryReloadActionSync();
    frames.shift()!(0);
    expect(bar.hidden).toBe(true);
  });

  it('dismissing a notice that carried no reload action lets a later eligible action show', () => {
    const { app, bar, button, dismiss, state } = fixture({ marked: false });
    app._historyNoticeRevealedFor = 's1';
    app._setHistoryTruncation('s1', { ...TAIL_CUT, exhausted: true, truncationReason: 'tail' });
    expect(button()).toBeUndefined();
    dismiss()!.onclick!();
    expect(bar.hidden).toBe(true);
    expect(app._historyReloadDismissed.has('s1')).toBe(false);
    state.marked = true;
    app._liveOutputSinceFullPull.add('s1');
    app._syncHistoryReloadAction();
    expect(bar.hidden).toBe(false);
    expect(button()!.textContent).toBe('Reload history');
  });
});

describe('selectSession only clears live-output marks for actual full mux captures', () => {
  it.each(['mux-full-history', 'history'])('checks the response source: %s', async (source) => {
    const errors = vi.fn();
    const select = loadAppMethod('selectSession', {
      console: { log: vi.fn(), error: errors },
      document: { querySelector: () => null },
      localStorage: { setItem: vi.fn(), getItem: () => null },
      requestIdleCallback: vi.fn(),
    });
    const { app } = makeApp('omp', { bufferRows: 30, capture: lines(60), payload: { source } });
    const methods = Object.fromEntries(
      [
        '_setTerminalLoadState',
        '_clearTerminalLoadState',
        '_cleanupPreviousSession',
        '_renderHistoryTruncationBanner',
        '_updateSseSubscription',
        'hideWelcome',
        'markIdleAlertSeen',
        '_updateActiveTabImmediate',
        'closeSessionSidebarOnHandheld',
        'renderSessionTabs',
        '_updateLocalEchoState',
        'syncTerminalGeometry',
        '_markTerminalBufferReconciled',
        '_connectWs',
        'scrollToLastNonEmptyLine',
      ].map((name) => [name, vi.fn()])
    );
    Object.assign(app, methods, {
      activeSessionId: 's2',
      _fullHistoryLoaded: new Set(),
      _liveOutputSinceFullPull: new Set(['s1']),
      _liveOutputGen: new Map(),
      _shouldFocusTerminalForTabSwitch: () => false,
      _isStaleSelect: () => false,
      sendResize: async () => false,
    });
    Object.assign(app.terminal, { scrollToBottom: vi.fn() });
    await select.call(app, 's1');
    expect(errors).not.toHaveBeenCalled();
    expect(app.chunkedTerminalWrite).toHaveBeenCalledOnce();
    expect(Reflect.get(app, '_liveOutputSinceFullPull').has('s1')).toBe(source !== 'mux-full-history');
  });
});
