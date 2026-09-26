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

const mixin = loadTerminalMixin();
const refetch = loadRefetch();
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\r\n');

function makeApp(mode: string, { bufferRows, capture }: { bufferRows: number; capture: string }) {
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
        json: { data: { terminalBuffer: capture, source: 'mux-full-history' } },
      };
    }),
    _recordTerminalLoadTiming: vi.fn(),
    _logScrollRouting: vi.fn(),
    _setHistoryTruncation: vi.fn(),
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
    // The truncation state is still recorded, so a window capped at the tail
    // size keeps offering the button.
    expect(app._setHistoryTruncation).toHaveBeenCalledTimes(1);
  });
});
