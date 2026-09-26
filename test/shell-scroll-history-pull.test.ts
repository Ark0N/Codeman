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
 * in full is not rewritten.
 *
 * ORDER MATTERS: that skip must run BEFORE the downgrade guard. The guard reads
 * "smaller than the browser" as "tmux has nothing more to give", which is true of
 * an unbounded capture and false of a window cut at the tail size, so a bounded
 * window that reached it marked the session exhausted and took Load full history
 * off the banner while tmux still held the rest. The second block below drives
 * the real `_setHistoryTruncation` and the real `computeHistoryTruncationNotice`
 * to pin what the user is actually told.
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
function loadTerminalMixin(): Record<string, unknown> {
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
  });
  vm.runInContext(source, context);
  return FakeCodemanApp.prototype;
}

function loadRefetch(): (this: unknown, opts?: { force?: boolean }) => Promise<void> {
  const app = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
  const body = methodSource(app, '_maybeRefetchFullHistory');
  const context = vm.createContext({ performance, TERMINAL_TAIL_SIZE, TERMINAL_CHUNK_SIZE: 32 * 1024 });
  return vm.runInContext(`({ ${body} })._maybeRefetchFullHistory`, context);
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
  { bufferRows, capture, payload = {} }: { bufferRows: number; capture: string; payload?: Record<string, unknown> }
) {
  const urls: string[] = [];
  const app = {
    activeSessionId: 's1',
    sessions: new Map([['s1', { mode }]]),
    detachedSessions: new Set<string>(),
    _fullHistoryRepullInFlight: false,
    _isLoadingBuffer: false,
    _fullHistoryRepullAt: new Map<string, number>(),
    _fullHistoryRepullUseless: new Set<string>(),
    terminalBufferCache: new Map<string, string>(),
    terminal: {
      cols: 80,
      rows: 30,
      buffer: { active: { length: bufferRows } },
      scrollToLine: vi.fn(),
      scrollToTop: vi.fn(),
    },
    _estimateReplayRows: mixin._estimateReplayRows,
    _replayWouldShrinkBuffer: mixin._replayWouldShrinkBuffer,
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
    // The real method behind a spy, so a test sees both what it was called with
    // and the banner state (`_historyTruncation`) it leaves behind.
    _historyTruncation: new Map<string, unknown>(),
    _renderHistoryTruncationBanner: vi.fn(),
    _setHistoryTruncation: vi.fn((sessionId: string, p?: Record<string, unknown>): void => {
      setHistoryTruncation.call(app, sessionId, p);
    }),
    _resetTerminalForReplay: vi.fn(),
    _bufferLoadFinishOpts: vi.fn(() => ({})),
    chunkedTerminalWrite: vi.fn(async () => ({ parsedAt: performance.now(), bufferLength: 400, completed: true })),
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
