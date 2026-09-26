// test/split-pane-terminal-unit.test.ts
// Port: N/A (no server/browser; SplitTerminalPane is loaded via `vm`, like
// split-pane-auto-collapse-unit.test.ts loads the CodemanApp patches).
//
// Unit coverage for the two SplitTerminalPane (terminal-split.js) fixes from
// the final review of #453 that need no browser: destroy() nulling EVERY socket
// handler (onclose used to survive it and fire its "disconnected" write into a
// pane already torn down), and the `{t:'r'}` server-refresh path being
// single-flight. Two refresh frames in a row used to start two concurrent
// replays, each clearing the terminal under the other's chunked write; a
// refresh arriving mid-replay is now coalesced into ONE trailing re-run rather
// than dropped, because the in-flight fetch may predate the drop the new frame
// reports and no further frame comes to correct stale content.
//
// The last block covers the scroll-to-top history pull: a burst of output leaves
// a shell pane's xterm with about one screen of scrollback while tmux holds every
// line, and Pane B (a separate xterm from the primary pane) never went back to
// ask. See _maybeLoadMoreHistory / _pullHistory in terminal-split.js.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TERMINAL_CHUNK_SIZE = 32 * 1024;
const TERMINAL_TAIL_SIZE = 1024 * 1024;
/** The pane's `performance.now()`, so frame arrival vs. capture time is set by hand, not raced. */
let clock = 0;

type FakeTerminal = {
  write: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
  scrollToTop: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
  options: { scrollback: number };
  buffer: { active: { type: string; viewportY: number; length: number } };
};
type FakeSocket = {
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
  close: ReturnType<typeof vi.fn>;
};
type PaneUnderTest = {
  ws: FakeSocket | null;
  terminal: FakeTerminal | null;
  _destroyed: boolean;
  _bufferLoading: boolean;
  _bufferRefreshPending: boolean;
  _historyPullAt: number;
  _historyPullUseless: boolean;
  _liveQueue: unknown[] | null;
  _onWheel: unknown;
  destroy(): void;
  _loadBuffer(): Promise<void>;
  _refreshBuffer(): void;
  _maybeLoadMoreHistory(): void;
  _pullHistory(): Promise<void>;
  _onLiveOutput(data: string): void;
  _onLiveClear(): void;
  _installWheelListener(): void;
};

const fetchMock = vi.fn();
/** requestAnimationFrame stand-in: chunked writes queue here and are drained by hand. */
const rafQueue: Array<() => void> = [];
const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-split.js'), 'utf8');

function loadSplitTerminalPane() {
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // The primary pane's row estimator, reduced to a line count: the pull only
    // compares it with the pane's own row count.
    window: {
      app: { _estimateReplayRows: (text: string) => text.split('\n').length },
      AbortSignal: { timeout: (ms: number) => ({ timeoutMs: ms }) },
    },
    performance: { now: () => clock },
    fetch: (...args: unknown[]) => fetchMock(...args),
    requestAnimationFrame: (fn: () => void) => rafQueue.push(fn),
    // The constants.js globals the module reads at call time.
    TERMINAL_CHUNK_SIZE,
    TERMINAL_TAIL_SIZE,
  });
  // The module's tail patches CodemanApp.prototype; nothing on it runs here.
  vm.runInContext(`class CodemanApp { _onSessionDeleted() {} selectSession() {} }\n${SOURCE}`, context);
  return (context.window as { SplitTerminalPane: new (id: string, mount: unknown, opts?: object) => PaneUnderTest })
    .SplitTerminalPane;
}

const SplitTerminalPane = loadSplitTerminalPane();

function makePane(mode = 'claude', mount: unknown = {}): PaneUnderTest & { terminal: FakeTerminal } {
  const pane = new SplitTerminalPane('s1', mount, { mode });
  pane.terminal = {
    // xterm invokes a write's callback once everything before it is parsed.
    write: vi.fn((_data: string, done?: () => void) => done?.()),
    clear: vi.fn(),
    dispose: vi.fn(),
    scrollToLine: vi.fn(),
    scrollToTop: vi.fn(),
    cols: 80,
    rows: 30,
    // xterm keeps at most `scrollback + rows` rows; small here so a test can fill it.
    options: { scrollback: 1000 },
    // A pane sitting at the top of a 40-row buffer on the normal screen.
    buffer: { active: { type: 'normal', viewportY: 0, length: 40 } },
  };
  return pane as PaneUnderTest & { terminal: FakeTerminal };
}

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

function jsonResponse(terminalBuffer: string, extra: Record<string, unknown> = {}) {
  return { json: async () => ({ data: { terminalBuffer, ...extra } }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every microtask the vm-side promise chain queued run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockReset();
  rafQueue.length = 0;
  clock = 0;
});

describe('SplitTerminalPane.destroy()', () => {
  it('nulls every WebSocket handler, onclose included, before closing the socket', () => {
    const pane = makePane();
    const terminal = pane.terminal;
    const ws: FakeSocket = { onopen: vi.fn(), onmessage: vi.fn(), onclose: vi.fn(), onerror: vi.fn(), close: vi.fn() };
    pane.ws = ws;

    pane.destroy();

    // close() fires onclose asynchronously, so a handler left attached ran its
    // "disconnected" write against a pane whose terminal was already disposed.
    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(ws.onerror).toBeNull();
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(pane.ws).toBeNull();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(pane.terminal).toBeNull();
    expect(pane._destroyed).toBe(true);
  });
});

describe('SplitTerminalPane server-refresh single-flight', () => {
  it('a refresh with nothing in flight clears and fetches straight away', async () => {
    const pane = makePane();
    fetchMock.mockResolvedValueOnce(jsonResponse('one'));

    pane._refreshBuffer();
    await settle();

    expect(pane.terminal.clear).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/terminal?full=1');
    expect(pane.terminal.write).toHaveBeenCalledWith('one');
    expect(pane._bufferLoading).toBe(false);
  });

  it('a shell pane asks for the bounded tail, matching connect()', async () => {
    const pane = makePane('shell');
    fetchMock.mockResolvedValueOnce(jsonResponse('tail'));

    pane._refreshBuffer();
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/s1/terminal?tail=${1024 * 1024}`);
  });

  it('refreshes arriving mid-fetch neither clear nor fetch again, and run ONCE after the replay lands', async () => {
    const pane = makePane();
    const first = deferred<ReturnType<typeof jsonResponse>>();
    const second = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    pane._refreshBuffer();
    expect(pane.terminal.clear).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Two more frames while the first replay is still in flight.
    pane._refreshBuffer();
    pane._refreshBuffer();
    expect(pane.terminal.clear).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pane._bufferRefreshPending).toBe(true);

    first.resolve(jsonResponse('replay-1'));
    await settle();

    expect(pane.terminal.write).toHaveBeenCalledWith('replay-1');
    // Exactly one trailing re-run for the two coalesced frames, not two.
    expect(pane.terminal.clear).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    second.resolve(jsonResponse('replay-2'));
    await settle();

    expect(pane.terminal.write).toHaveBeenLastCalledWith('replay-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pane._bufferLoading).toBe(false);
    expect(pane._bufferRefreshPending).toBe(false);
  });

  it('holds the flag across the chunked write, not just the fetch', async () => {
    const pane = makePane();
    // Three chunks: two full ones plus a tail, so the last two are queued on
    // requestAnimationFrame and the replay is mid-write after the fetch lands.
    const big = 'x'.repeat(TERMINAL_CHUNK_SIZE * 2 + 5);
    fetchMock.mockResolvedValueOnce(jsonResponse(big));

    pane._refreshBuffer();
    await settle();
    expect(pane.terminal.write).toHaveBeenCalledTimes(1);
    expect(rafQueue).toHaveLength(1);
    expect(pane._bufferLoading).toBe(true);

    // A refresh mid-write must not clear the terminal under the chunks still
    // to come, nor start a second fetch.
    pane._refreshBuffer();
    expect(pane.terminal.clear).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse('after'));
    rafQueue.shift()!();
    rafQueue.shift()!();
    await settle();

    expect(pane.terminal.write).toHaveBeenCalledTimes(4);
    expect(pane.terminal.write).toHaveBeenLastCalledWith('after');
    expect(pane.terminal.clear).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pane._bufferLoading).toBe(false);
  });

  it('a pending refresh is dropped once the pane is destroyed', async () => {
    const pane = makePane();
    const first = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(first.promise);

    pane._refreshBuffer();
    pane._refreshBuffer();
    pane.destroy();
    first.resolve(jsonResponse('late'));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pane._bufferLoading).toBe(false);
  });

  it('a failed fetch releases the flag so the next refresh can run', async () => {
    const pane = makePane();
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    pane._refreshBuffer();
    await settle();
    expect(pane._bufferLoading).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse('back'));
    pane._refreshBuffer();
    await settle();
    expect(pane.terminal.write).toHaveBeenCalledWith('back');
  });
});

describe('SplitTerminalPane scroll-to-top history pull', () => {
  it('a shell pane at the top pulls a bounded window of full history and replays it', async () => {
    const pane = makePane('shell');
    const term = pane.terminal;
    // The replay grows the buffer once xterm has parsed it (the empty write's callback).
    term.write.mockImplementation((data: string, done?: () => void) => {
      if (data === '' && done) term.buffer.active.length = 140;
      done?.();
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(100)));

    pane._maybeLoadMoreHistory();
    await settle();

    // With a deadline: live output is held for as long as the pull runs, so a
    // request that never answers would freeze the pane.
    expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/s1/terminal?full=1&tail=${TERMINAL_TAIL_SIZE}`, {
      signal: { timeoutMs: 10_000 },
    });
    expect(term.write).toHaveBeenCalledWith('\x1bc');
    expect(term.write).toHaveBeenCalledWith(rowsOf(100));
    // What was row 0 is now 100 rows down (140 - 40): the reader keeps their
    // place with the recovered history above it, instead of being dropped at the bottom.
    expect(term.scrollToLine).toHaveBeenCalledWith(100);
    expect(pane._bufferLoading).toBe(false);
    expect(pane._liveQueue).toBeNull();
  });

  it('does nothing away from the top, for other modes, or on the alternate screen', async () => {
    const midScroll = makePane('shell');
    midScroll.terminal.buffer.active.viewportY = 12;
    midScroll._maybeLoadMoreHistory();

    // A repaint-mode agent CLI keeps no tmux history to recover.
    makePane('claude')._maybeLoadMoreHistory();

    // nano/vim/less own the wheel; their screen is not scrollback.
    const fullScreenApp = makePane('shell');
    fullScreenApp.terminal.buffer.active.type = 'alternate';
    fullScreenApp._maybeLoadMoreHistory();

    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a flick fires once: overlapping triggers are dropped, then the cooldown holds', async () => {
    const pane = makePane('shell');
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    pane._maybeLoadMoreHistory();
    const startedAt = pane._historyPullAt;
    // The cooldown is cleared between triggers on purpose, so that only the
    // in-flight guard can be what drops the overlapping ones.
    pane._historyPullAt = 0;
    pane._maybeLoadMoreHistory();
    pane._historyPullAt = 0;
    pane._maybeLoadMoreHistory();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pane._historyPullAt = startedAt;

    response.resolve(jsonResponse(rowsOf(100)));
    await settle();
    expect(pane._bufferLoading).toBe(false);

    // Nothing in flight any more, so now it is the 4s cooldown alone.
    pane._maybeLoadMoreHistory();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Once the cooldown lapses a later scroll-to-top may pull again.
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(100)));
    pane._historyPullAt = Date.now() - 5000;
    pane._maybeLoadMoreHistory();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a window the pane already holds in full is not rewritten, and is not latched as useless', async () => {
    const pane = makePane('shell');
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(30)));

    pane._maybeLoadMoreHistory();
    await settle();

    // A reset+rewrite here would jump the viewport for no new rows.
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1bc');
    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled();
    expect(pane.terminal.scrollToTop).not.toHaveBeenCalled();
    // The next burst can put more history in tmux than the pane has.
    expect(pane._historyPullUseless).toBe(false);
    expect(pane._bufferLoading).toBe(false);
  });

  it('refuses a downgrade, keeping the 4s cooldown when the window is all of tmux history', async () => {
    const pane = makePane('shell');
    pane.terminal.buffer.active.length = 500;
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(5)));

    pane._maybeLoadMoreHistory();
    await settle();

    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1bc');
    // Untruncated: tmux has nothing older, but the next burst can add history.
    expect(pane._historyPullUseless).toBe(false);
  });

  it('a truncated window that fits in the pane backs off for a minute', async () => {
    // Every ask costs the server a capture-pane of the WHOLE history (`tail` is
    // cut after the capture), and a window cut at the tail size can never reach
    // anything older than what the pane already shows.
    const pane = makePane('shell');
    pane.terminal.buffer.active.length = 500;
    // Within a screen of what the pane holds, so the old downgrade guard never
    // latched it: only the truncated-skip rule can back this off.
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(480), { truncated: true, truncationReason: 'tail' }));

    pane._maybeLoadMoreHistory();
    await settle();

    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1bc');
    expect(pane._historyPullUseless).toBe(true);

    // Inside the 60s back-off, well past the normal 4s cooldown.
    pane._historyPullAt = Date.now() - 10_000;
    pane._maybeLoadMoreHistory();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a pane already at its scrollback cap skips the window and backs off for a minute', async () => {
    // A 1 MiB window of short lines can carry more rows than xterm will ever hold
    // (`scrollback + rows`), so `incoming <= rows held` never comes true and every
    // scroll-to-top would reset and re-parse it.
    const pane = makePane('shell');
    pane.terminal.buffer.active.length = 1030;
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(5000)));

    pane._maybeLoadMoreHistory();
    await settle();

    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1bc');
    expect(pane.terminal.write).not.toHaveBeenCalledWith(rowsOf(5000));
    expect(pane._historyPullUseless).toBe(true);
  });

  it('a successful replay clears the one-minute back-off', async () => {
    const pane = makePane('shell');
    pane._historyPullUseless = true;
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(100), { truncated: true, truncationReason: 'tail' }));

    void pane._pullHistory();
    await settle();

    expect(pane.terminal.write).toHaveBeenCalledWith(rowsOf(100));
    expect(pane._historyPullUseless).toBe(false);
  });

  it('holds live output during the replay and replays only what arrived after the capture', async () => {
    const pane = makePane('shell');
    const term = pane.terminal;
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    pane._maybeLoadMoreHistory();
    expect(pane._liveQueue).toEqual([]);

    // Arrives before the response does: it is IN the capture already.
    clock = 1;
    pane._onLiveOutput('early');
    expect(term.write).not.toHaveBeenCalledWith('early');
    await settle();

    // 200 rows (more than the pane holds, so it replays) of 400 columns each:
    // three chunks, which leaves the replay mid-write once the fetch lands.
    const bigReplay = Array.from({ length: 200 }, () => 'y'.repeat(400)).join('\n');
    expect(bigReplay.length).toBeGreaterThan(TERMINAL_CHUNK_SIZE * 2);
    clock = 2; // the response arrives: this is the cutoff
    response.resolve(jsonResponse(bigReplay));
    await settle();
    expect(rafQueue).toHaveLength(1);

    // Arrives while the snapshot is still being written: must not land under it.
    clock = 3;
    pane._onLiveOutput('late');
    expect(term.write).not.toHaveBeenCalledWith('late');

    rafQueue.shift()!();
    rafQueue.shift()!();
    await settle();

    const written = term.write.mock.calls.map((call) => call[0]);
    expect(written).not.toContain('early');
    expect(written.at(-1)).toBe('late');
    expect(pane._liveQueue).toBeNull();
    expect(pane._bufferLoading).toBe(false);
  });

  it('writes every held frame when the pull ends without replaying', async () => {
    const pane = makePane('shell');
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    pane._maybeLoadMoreHistory();
    pane._onLiveOutput('held');
    await settle();
    response.resolve(jsonResponse(rowsOf(30))); // nothing to gain: no replay
    await settle();

    // Nothing replaced the terminal, so the frame is news even though it
    // arrived before the response did.
    expect(pane.terminal.write).toHaveBeenCalledWith('held');
  });

  it('a failed fetch releases the flag and the queue, so live output flows again', async () => {
    const pane = makePane('shell');
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    pane._maybeLoadMoreHistory();
    pane._onLiveOutput('held');
    await settle();

    expect(pane._bufferLoading).toBe(false);
    expect(pane._liveQueue).toBeNull();
    expect(pane.terminal.write).toHaveBeenCalledWith('held');
    pane._onLiveOutput('after');
    expect(pane.terminal.write).toHaveBeenLastCalledWith('after');
  });

  it('a refresh frame during the pull runs once behind it', async () => {
    const pane = makePane('shell');
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise).mockResolvedValueOnce(jsonResponse('refreshed'));

    pane._maybeLoadMoreHistory();
    pane._refreshBuffer();
    expect(pane.terminal.clear).not.toHaveBeenCalled();
    expect(pane._bufferRefreshPending).toBe(true);

    response.resolve(jsonResponse(rowsOf(30)));
    await settle();

    expect(pane.terminal.clear).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pane.terminal.write).toHaveBeenCalledWith('refreshed');
  });

  it('a clear frame during the pull is queued in order, never applied under the replay', async () => {
    const pane = makePane('shell');
    const term = pane.terminal;
    const order: string[] = [];
    term.write.mockImplementation((data: string, done?: () => void) => {
      order.push(`write:${data}`);
      done?.();
    });
    term.clear.mockImplementation(() => order.push('clear'));
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    pane._maybeLoadMoreHistory();
    pane._onLiveOutput('before');
    pane._onLiveClear();
    pane._onLiveOutput('after');
    // Held: clearing now would wipe a half-written snapshot.
    expect(order).toEqual([]);

    response.resolve(jsonResponse(rowsOf(30))); // nothing to gain: no replay
    await settle();

    expect(order).toEqual(['write:before', 'clear', 'write:after']);
    expect(pane._liveQueue).toBeNull();

    // With nothing in flight a clear frame applies straight away.
    pane._onLiveClear();
    expect(order.at(-1)).toBe('clear');
  });

  it('a clear that arrived before the capture is not replayed after it', async () => {
    const pane = makePane('shell');
    const term = pane.terminal;
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    pane._maybeLoadMoreHistory();
    clock = 1;
    pane._onLiveClear(); // already reflected in the capture
    clock = 2;
    response.resolve(jsonResponse(rowsOf(100)));
    await settle();

    expect(term.write).toHaveBeenCalledWith('\x1bc');
    expect(term.clear).not.toHaveBeenCalled();
  });

  it('destroy() mid-pull leaves nothing running and nothing written to the dead terminal', async () => {
    const pane = makePane('shell');
    const term = pane.terminal;
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    pane._maybeLoadMoreHistory();
    pane._onLiveOutput('held');
    pane.destroy();
    response.resolve(jsonResponse(rowsOf(100)));
    await settle();

    expect(pane._bufferLoading).toBe(false);
    expect(pane._liveQueue).toBeNull();
    expect(pane.terminal).toBeNull();
    expect(term.write).not.toHaveBeenCalledWith('\x1bc');
    expect(term.write).not.toHaveBeenCalledWith('held');
  });

  it('a pull whose request is aborted (the deadline) frees the pane', async () => {
    const pane = makePane('shell');
    fetchMock.mockRejectedValueOnce(new Error('The operation timed out'));

    pane._maybeLoadMoreHistory();
    pane._onLiveOutput('held');
    await settle();

    expect(pane._bufferLoading).toBe(false);
    expect(pane._liveQueue).toBeNull();
    expect(pane.terminal.write).toHaveBeenCalledWith('held');
  });

  it('the wheel listener is capture-phase, and only a wheel UP can trigger a pull', async () => {
    const mount = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const pane = makePane('shell', mount);
    fetchMock.mockResolvedValue(jsonResponse(rowsOf(100)));

    pane._installWheelListener();

    // Capture phase: xterm's own wheel handler stopPropagation()s the events it
    // consumes, so a bubbling listener would never fire while the pane still has
    // scrollback to scroll, and the pull would work only from the exact top row.
    const [type, listener, options] = mount.addEventListener.mock.calls[0];
    expect(type).toBe('wheel');
    expect(options).toEqual({ capture: true, passive: true });

    listener({ deltaY: 120 }); // wheel down
    listener({ deltaY: 0 });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    listener({ deltaY: -120 }); // wheel up, at the top
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('destroy() detaches exactly the wheel listener it registered', () => {
    const mount = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const pane = makePane('shell', mount);
    pane._installWheelListener();
    const registered = mount.addEventListener.mock.calls[0][1];

    pane.destroy();

    expect(mount.removeEventListener).toHaveBeenCalledWith('wheel', registered, { capture: true });
    expect(pane._onWheel).toBeNull();
  });

  it('connect() installs the wheel listener (static guard)', () => {
    // connect() needs a whole xterm to run, so its wiring is pinned by source
    // rather than executed; the listener's behaviour is exercised above.
    const connect = SOURCE.slice(SOURCE.indexOf('async connect()'), SOURCE.indexOf('async _loadBuffer()'));
    expect(connect).toContain('this._installWheelListener();');
    expect(connect).toContain('this._onLiveClear();');
    expect(connect).not.toContain('this.terminal.clear();');
  });
});
