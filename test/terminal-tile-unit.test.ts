// test/terminal-tile-unit.test.ts
// Port: N/A (no server/browser; TerminalTile is loaded via `vm`, like
// split-pane-auto-collapse-unit.test.ts loads the CodemanApp patches).
//
// Unit coverage for the two TerminalTile (terminal-tile.js, the split pane's
// Pane B until it moved out of terminal-split.js) fixes from
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
// ask. See _maybeLoadMoreHistory / _pullHistory in terminal-tile.js.
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
  _wsClosed: boolean;
  detachedSessions: Set<string> | undefined;
  destroy(): void;
  _loadBuffer(): Promise<void>;
  _refreshBuffer(): void;
  _maybeLoadMoreHistory(): void;
  _pullHistory(): Promise<void>;
  _onLiveOutput(data: string): void;
  _onLiveClear(): void;
  _installWheelListener(): void;
  _installClickListener(): void;
  _onClick: unknown;
  _writeDisconnectedMarker(): void;
  _onSocketClosed(): void;
};

const fetchMock = vi.fn();
/** Recorded deadline timers (see the context's setTimeout); `fn` aborts the request. */
const deadlines: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-tile.js'), 'utf8');

function loadTerminalTile() {
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // The primary pane's row estimator, reduced to a line count: the pull only
    // compares it with the pane's own row count.
    window: {
      app: { _estimateReplayRows: (text: string) => text.split('\n').length },
      // The primary pane's capture budget (constants.js): the full-capture default.
      CodemanFetchDeadline: { terminalFetchDeadlineMs: () => 45_000 },
      AbortController: class {
        signal = { aborted: false };
        abort() {
          this.signal.aborted = true;
        }
      },
    },
    performance: { now: () => clock },
    // Deadline timers (>= 1 s) are recorded, never run: a test fires one by hand
    // and reads what it aborted. Anything shorter (xterm chunk pacing) is real.
    setTimeout: (fn: () => void, ms?: number) => {
      if ((ms ?? 0) < 1000) return setTimeout(fn, ms);
      deadlines.push({ fn, ms: ms as number, cleared: false });
      return -deadlines.length; // negative: never collides with a real timer id
    },
    clearTimeout: (id: unknown) => {
      if (typeof id === 'number' && id < 0) deadlines[-id - 1].cleared = true;
      else clearTimeout(id as Parameters<typeof clearTimeout>[0]);
    },
    fetch: (...args: unknown[]) => fetchMock(...args),
    // The constants.js globals the module reads at call time.
    TERMINAL_CHUNK_SIZE,
    TERMINAL_TAIL_SIZE,
  });
  // The module's tail patches CodemanApp.prototype; nothing on it runs here.
  vm.runInContext(`class CodemanApp { _onSessionDeleted() {} selectSession() {} }\n${SOURCE}`, context);
  return (context.window as { TerminalTile: new (id: string, mount: unknown, opts?: object) => PaneUnderTest })
    .TerminalTile;
}

const TerminalTile = loadTerminalTile();

function makePane(
  mode = 'claude',
  mount: unknown = {},
  opts: { detachedSessions?: Set<string> } = {}
): PaneUnderTest & { terminal: FakeTerminal } {
  const pane = new TerminalTile('s1', mount, { mode, ...opts });
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

/**
 * A response whose headers have landed but whose body has not: the window in
 * which the pull's live queue is open and nothing else has happened yet.
 * `release(buffer)` delivers the body; `fail()` errors the body read.
 */
function headersOnly() {
  let release!: (body: ReturnType<typeof jsonResponse> | Error) => void;
  const body = new Promise<{ data: Record<string, unknown> }>((resolve, reject) => {
    release = (value) => {
      if (value instanceof Error) reject(value);
      else void value.json().then(resolve);
    };
  });
  return {
    response: { json: () => body },
    release: (terminalBuffer: string, extra: Record<string, unknown> = {}) =>
      release(jsonResponse(terminalBuffer, extra)),
    fail: () => release(new Error('body read failed')),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Every marker variant (reconnecting, session ended, refused, taken over) starts the same way.
const isMarker = (data: unknown) => typeof data === 'string' && data.includes('[disconnected');

/**
 * What reached the pane's screen. A replay also queues an empty write, only to
 * hear through its callback that everything before it has been parsed
 * (writeChunked); it puts nothing on screen, so it is left out.
 */
const screenWrites = (pane: { terminal: FakeTerminal }) =>
  pane.terminal.write.mock.calls.map((call) => call[0]).filter((data) => data !== '');

/**
 * Holds xterm's write callbacks, as a real xterm still parsing a replay does:
 * the replay stays in progress until `parse()` runs the ones held so far.
 */
function holdParses(pane: { terminal: FakeTerminal }) {
  const held: Array<() => void> = [];
  pane.terminal.write = vi.fn((_data: string, done?: () => void) => {
    if (done) held.push(done);
  });
  return {
    held,
    parse: () => {
      for (const done of held.splice(0)) done();
    },
  };
}

/** Lets every microtask the vm-side promise chain queued run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockReset();
  deadlines.length = 0;
  clock = 0;
});

describe('TerminalTile.destroy()', () => {
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

describe('TerminalTile server-refresh single-flight', () => {
  it('a refresh with nothing in flight clears and fetches straight away', async () => {
    const pane = makePane();
    fetchMock.mockResolvedValueOnce(jsonResponse('one'));

    pane._refreshBuffer();
    await settle();

    expect(pane.terminal.clear).toHaveBeenCalledTimes(1);
    // The second argument carries the load's deadline (an AbortSignal).
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/terminal?full=1', expect.anything());
    expect(pane.terminal.write).toHaveBeenCalledWith('one');
    expect(pane._bufferLoading).toBe(false);
  });

  it('a shell pane asks for the bounded tail, matching connect()', async () => {
    const pane = makePane('shell');
    fetchMock.mockResolvedValueOnce(jsonResponse('tail'));

    pane._refreshBuffer();
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/s1/terminal?tail=${1024 * 1024}`, expect.anything());
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

    expect(screenWrites(pane).at(-1)).toBe('replay-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pane._bufferLoading).toBe(false);
    expect(pane._bufferRefreshPending).toBe(false);
  });

  it('queues the whole replay at once and holds the flag until xterm has parsed it', async () => {
    const pane = makePane();
    const xterm = holdParses(pane);
    // Three slices: two full ones plus a tail.
    const big = 'x'.repeat(TERMINAL_CHUNK_SIZE * 2 + 5);
    fetchMock.mockResolvedValueOnce(jsonResponse(big));

    pane._refreshBuffer();
    await settle();
    // Every slice queued at once, then the empty write whose callback ends the
    // replay: nothing waits for an animation frame.
    expect(pane.terminal.write.mock.calls.map((call) => call[0].length)).toEqual([
      TERMINAL_CHUNK_SIZE,
      TERMINAL_CHUNK_SIZE,
      5,
      0,
    ]);
    // xterm is still parsing: the replay, and with it the flag, is not done.
    expect(pane._bufferLoading).toBe(true);

    // A refresh mid-parse must not clear the terminal under the replay, nor
    // start a second fetch.
    pane._refreshBuffer();
    expect(pane.terminal.clear).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse('after'));
    xterm.parse();
    await settle();
    // Parsed: the coalesced refresh runs now, once.
    expect(pane.terminal.clear).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pane._bufferLoading).toBe(true);

    xterm.parse();
    await settle();
    expect(screenWrites(pane).at(-1)).toBe('after');
    expect(pane._bufferLoading).toBe(false);
  });

  it('queues a replay larger than the window one window at a time', async () => {
    // xterm's write queue throws past 50 MB, and an unbounded `full=1` capture
    // can reach the server's 32 MB: at most 1 MiB is queued before xterm has
    // parsed what came before it.
    const pane = makePane();
    const xterm = holdParses(pane);
    fetchMock.mockResolvedValueOnce(jsonResponse('z'.repeat(TERMINAL_TAIL_SIZE + 5)));

    pane._refreshBuffer();
    await settle();
    const queued = () => pane.terminal.write.mock.calls.reduce((n, call) => n + call[0].length, 0);
    expect(queued()).toBe(TERMINAL_TAIL_SIZE);

    xterm.parse();
    await settle();
    expect(queued()).toBe(TERMINAL_TAIL_SIZE + 5);
    expect(pane._bufferLoading).toBe(true);

    xterm.parse();
    await settle();
    expect(pane._bufferLoading).toBe(false);
  });

  it('a replay still parsing when the pane is destroyed settles at once', async () => {
    // A disposed xterm never runs a write callback: without destroy() settling
    // the replay, the flag (and in the grid the one load queue) would wait forever.
    const pane = makePane();
    holdParses(pane);
    fetchMock.mockResolvedValueOnce(jsonResponse('replay'));

    pane._refreshBuffer();
    await settle();
    expect(pane._bufferLoading).toBe(true);

    pane.destroy();
    await settle();
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

describe('TerminalTile scroll-to-top history pull', () => {
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

    // With a deadline, so a request that never answers cannot pin the pane.
    expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/s1/terminal?full=1&tail=${TERMINAL_TAIL_SIZE}`, {
      signal: expect.objectContaining({ aborted: false }),
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

  it('stands aside for a detached session, mirroring _sendResize()', async () => {
    // A detached session's own window already owns its PTY size and
    // scrollback (buildSplitPickerSessions() already refuses to open one).
    const pane = makePane('shell', {}, { detachedSessions: new Set(['s1']) });

    pane._maybeLoadMoreHistory();
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
    const xterm = holdParses(pane);
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    pane._maybeLoadMoreHistory();
    // The queue opens with the response, not the request.
    expect(pane._liveQueue).toBeNull();

    // Arrives before the response does: written straight through (the pane
    // keeps painting during the round trip), and the replay then replaces it.
    clock = 1;
    pane._onLiveOutput('early');
    expect(term.write).toHaveBeenCalledWith('early');
    await settle();

    // 200 rows (more than the pane holds, so it replays) of 400 columns each:
    // three chunks, still being parsed once the fetch lands.
    const bigReplay = Array.from({ length: 200 }, () => 'y'.repeat(400)).join('\n');
    expect(bigReplay.length).toBeGreaterThan(TERMINAL_CHUNK_SIZE * 2);
    clock = 2; // the response arrives: this is the cutoff
    response.resolve(jsonResponse(bigReplay));
    await settle();
    expect(xterm.held).toHaveLength(1);

    // Arrives while the snapshot is still being parsed: must not land under it.
    clock = 3;
    pane._onLiveOutput('late');
    expect(term.write).not.toHaveBeenCalledWith('late');

    // The replay parsed, then the pull's own settle write before it scrolls.
    xterm.parse();
    await settle();
    xterm.parse();
    await settle();

    const written = screenWrites(pane);
    // 'early' went out before the reset, so the replay wiped it and it is not repeated.
    expect(written.indexOf('early')).toBeLessThan(written.indexOf('\x1bc'));
    expect(written.filter((w) => w === 'early')).toHaveLength(1);
    expect(written.at(-1)).toBe('late');
    expect(pane._liveQueue).toBeNull();
    expect(pane._bufferLoading).toBe(false);
  });

  it('writes every held frame when the pull ends without replaying', async () => {
    const pane = makePane('shell');
    const held = headersOnly();
    fetchMock.mockResolvedValueOnce(held.response);

    pane._maybeLoadMoreHistory();
    await settle();
    pane._onLiveOutput('held');
    expect(pane.terminal.write).not.toHaveBeenCalledWith('held');
    held.release(rowsOf(30)); // nothing to gain: no replay
    await settle();

    // Nothing replaced the terminal, so the held frame is news.
    expect(pane.terminal.write).toHaveBeenCalledWith('held');
  });

  it('a failed fetch releases the flag and the queue, so live output flows again', async () => {
    const pane = makePane('shell');
    const held = headersOnly();
    fetchMock.mockResolvedValueOnce(held.response);

    pane._maybeLoadMoreHistory();
    await settle();
    pane._onLiveOutput('held');
    held.fail(); // the body read dies with the queue open
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

  // The server's `{t:'c'}` means "refresh after startup" (its one emitter is a
  // fresh Claude pane's first prompt, session.ts), and the primary pane answers
  // it with a refetch and replay (_onSessionClearTerminal). The three below
  // replace two tests that pinned it as a bare xterm clear(), which kept only
  // the cursor's row: a Claude session Run into the grid came up a near-empty
  // tile.
  it('a clear frame during the pull is coalesced into one refresh behind it, never applied under the replay', async () => {
    const pane = makePane('shell');
    const term = pane.terminal;
    const order: string[] = [];
    term.write.mockImplementation((data: string, done?: () => void) => {
      if (data) order.push(`write:${data}`);
      done?.();
    });
    term.clear.mockImplementation(() => order.push('clear'));
    const held = headersOnly();
    fetchMock.mockResolvedValueOnce(held.response).mockResolvedValueOnce(jsonResponse('after startup'));

    pane._maybeLoadMoreHistory();
    await settle();
    pane._onLiveOutput('before');
    pane._onLiveClear();
    pane._onLiveClear(); // a second one joins the same trailing refresh
    pane._onLiveOutput('after');
    // Held: nothing touches the screen under the pull, and nothing fetches yet.
    expect(order).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pane._bufferRefreshPending).toBe(true);

    held.release(rowsOf(30)); // nothing to gain: no replay
    await settle();

    // The held frames land in order, then ONE refresh fetches the pane's
    // current screen and replays it last.
    expect(order.slice(0, 2)).toEqual(['write:before', 'write:after']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/sessions/s1/terminal?tail=${TERMINAL_TAIL_SIZE}`,
      expect.anything()
    );
    expect(order.at(-1)).toBe('write:after startup');
    expect(pane._liveQueue).toBeNull();
    expect(pane._bufferLoading).toBe(false);
    expect(pane._bufferRefreshPending).toBe(false);
  });

  it('a clear frame with nothing in flight refetches the capture and replays it, like a refresh frame', async () => {
    const pane = makePane();
    fetchMock.mockResolvedValueOnce(jsonResponse('banner\r\n❯ '));

    pane._onLiveClear();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/terminal?full=1', expect.anything());
    expect(screenWrites(pane).at(-1)).toBe('banner\r\n❯ ');
    expect(pane._bufferLoading).toBe(false);
  });

  it('a clear frame while a pull waits for its response does not touch the screen, and refreshes behind the pull', async () => {
    const pane = makePane('shell');
    const term = pane.terminal;
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise).mockResolvedValueOnce(jsonResponse('refreshed'));

    pane._maybeLoadMoreHistory();
    clock = 1;
    pane._onLiveClear(); // before the response
    expect(term.clear).not.toHaveBeenCalled();
    expect(pane._bufferRefreshPending).toBe(true);
    clock = 2;
    response.resolve(jsonResponse(rowsOf(100)));
    await settle();

    const writes = screenWrites(pane);
    expect(writes).toContain(rowsOf(100)); // the pull still replayed
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(writes.at(-1)).toBe('refreshed');
    expect(pane._bufferLoading).toBe(false);
  });

  it('destroy() mid-pull leaves nothing running and nothing written to the dead terminal', async () => {
    const pane = makePane('shell');
    const term = pane.terminal;
    const held = headersOnly();
    fetchMock.mockResolvedValueOnce(held.response);

    pane._maybeLoadMoreHistory();
    await settle();
    pane._onLiveOutput('held');
    pane.destroy();
    held.release(rowsOf(100));
    await settle();

    expect(pane._bufferLoading).toBe(false);
    expect(pane._liveQueue).toBeNull();
    expect(pane.terminal).toBeNull();
    expect(term.write).not.toHaveBeenCalledWith('\x1bc');
    expect(term.write).not.toHaveBeenCalledWith('held');
  });

  it('a pull whose request is aborted (the deadline) frees the pane', async () => {
    const pane = makePane('shell');
    const held = headersOnly();
    fetchMock.mockResolvedValueOnce(held.response);

    pane._maybeLoadMoreHistory();
    await settle();
    pane._onLiveOutput('held');
    held.fail(); // the deadline aborts the body read
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
    // Not passive: the hollow-buffer paging route consumes its wheel right here
    // (test/terminal-tile-scroll.test.ts). This stub window has neither the
    // shared paging helpers nor the app's gates, so that route stays inert and
    // every wheel below falls through to the pull, as before.
    const [type, listener, options] = mount.addEventListener.mock.calls[0];
    expect(type).toBe('wheel');
    expect(options).toEqual({ capture: true, passive: false });

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

  it('destroy() detaches exactly the click listener it registered', () => {
    const mount = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const pane = makePane('opencode', mount);
    pane._installWheelListener();
    pane._installClickListener();
    const [type, registered, options] = mount.addEventListener.mock.calls[1];
    // Bubble phase, like the primary pane's click reporter (terminal-ui.js).
    expect(type).toBe('click');
    expect(options).toBeUndefined();

    pane.destroy();

    expect(mount.removeEventListener).toHaveBeenCalledWith('click', registered);
    expect(pane._onClick).toBeNull();
  });

  it('connect() installs the wheel listener (static guard)', () => {
    // connect() needs a whole xterm to run, so its wiring is pinned by source
    // rather than executed; the listener's behaviour is exercised above.
    const start = SOURCE.indexOf('async connect()');
    const end = SOURCE.indexOf('async _loadBuffer(');
    // Both anchors must resolve, or the slice runs to the end of the file and
    // every check below passes against code outside connect().
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const connect = SOURCE.slice(start, end);
    expect(connect).toContain('this._installWheelListener();');
    expect(connect).toContain('this._installClickListener();');
    expect(connect).toContain('this._onLiveClear();');
    expect(connect).not.toContain('this.terminal.clear();');
    // The tests below drive the close through _onSocketClosed() directly; the
    // socket's own handler forwards the close event (and its code) there, and
    // only for the current socket (_openSocket).
    expect(connect).toContain('this._onSocketClosed(event);');
    expect(connect).toMatch(/ws\.onclose = \(event\) => \{\s*if \(ws !== this\.ws\) return;/);
  });

  it('a close with no pull running writes the marker straight away', () => {
    const pane = makePane('shell');

    pane._onSocketClosed();

    expect(pane._wsClosed).toBe(true);
    expect(pane.terminal.write).toHaveBeenCalledTimes(1);
    expect(isMarker(pane.terminal.write.mock.calls[0][0])).toBe(true);
  });

  it('re-stamps the disconnected marker after a replay if the socket closed before the pull started', async () => {
    // onclose already wrote the marker once; a replay's own `\x1bc` would wipe
    // it and paint a fresh, current-looking history while onData keeps
    // silently dropping every keystroke on the dead socket.
    const pane = makePane('shell');
    pane._wsClosed = true;
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(100)));

    void pane._pullHistory();
    await settle();

    const marker = expect.stringContaining('[disconnected');
    const writes = pane.terminal.write.mock.calls.map((c) => c[0]);
    expect(writes.at(-1)).toEqual(expect.stringMatching(/\[disconnected/));
    expect(pane.terminal.write).toHaveBeenCalledWith(marker);
  });

  it('ends on the disconnected marker if the socket closes mid-fetch, before the queue opens', async () => {
    // The close lands while the request is in flight, so the HTTP pull still
    // succeeds (a Codeman restart drops the WS while the tmux session, and so
    // the pull, survives). The marker waits for the load to finish, then goes
    // below the replay.
    const pane = makePane('shell');
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    const pull = pane._pullHistory();
    pane._onSocketClosed();
    expect(pane.terminal.write.mock.calls.map((c) => c[0]).filter(isMarker)).toHaveLength(0);
    response.resolve(jsonResponse(rowsOf(100)));
    await pull;

    const writes = pane.terminal.write.mock.calls.map((c) => c[0]);
    expect(writes.filter(isMarker)).toHaveLength(1);
    expect(isMarker(writes.at(-1))).toBe(true);
  });

  it('a close mid-fetch that ends without a replay still writes exactly one marker', async () => {
    const pane = makePane('shell');
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    const pull = pane._pullHistory();
    pane._onSocketClosed();
    response.resolve(jsonResponse(rowsOf(30))); // already held in full: no replay
    await pull;

    const writes = pane.terminal.write.mock.calls.map((c) => c[0]);
    expect(writes.filter(isMarker)).toHaveLength(1);
  });

  it('a close during a refresh load lands the marker below the replay, not above it', async () => {
    // A {t:'r'} refresh clears and refetches; a close mid-fetch used to write
    // the marker at once, and the replay then landed underneath it.
    const pane = makePane('shell');
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    pane._refreshBuffer();
    pane._onSocketClosed();
    response.resolve(jsonResponse('refreshed'));
    await settle();

    const writes = pane.terminal.write.mock.calls.map((c) => c[0]);
    expect(writes.indexOf('refreshed')).toBeLessThan(writes.findIndex(isMarker));
    expect(isMarker(writes.at(-1))).toBe(true);
    expect(writes.filter(isMarker)).toHaveLength(1);
  });

  it('back-to-back refreshes on a closed socket leave exactly one marker, at the end', async () => {
    // R1's finally runs the trailing refresh R2, so R1 leaves the owed marker to
    // R2 instead of stamping it: in real xterm R1's write would still be queued
    // when R2's synchronous clear() runs, and would land above R2's replay. The
    // write mock records every stamp whatever clear() does, so counting marker
    // writes pins that R1 never stamps (the async-parse test below shows why).
    const pane = makePane('shell');
    pane._wsClosed = true;
    const first = deferred<ReturnType<typeof jsonResponse>>();
    const second = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    pane._refreshBuffer(); // R1
    pane._refreshBuffer(); // coalesced into the trailing R2
    first.resolve(jsonResponse('first'));
    await settle();
    // R1 settled its marker, then R2 cleared and is still fetching.
    expect(pane.terminal.clear).toHaveBeenCalledTimes(2);
    second.resolve(jsonResponse('second'));
    await settle();

    const writes = screenWrites(pane);
    expect(writes.at(-1)).toSatisfy(isMarker);
    expect(writes.lastIndexOf('second')).toBe(writes.length - 2);
    expect(writes.filter(isMarker)).toHaveLength(1);
  });

  it('the pull gives the request the long budget and the body read the short one', async () => {
    const pane = makePane('shell');
    const held = headersOnly();
    fetchMock.mockResolvedValueOnce(held.response);

    const pull = pane._pullHistory();
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0].ms).toBe(45_000);
    await settle(); // headers landed
    expect(deadlines).toHaveLength(2);
    expect(deadlines[0].cleared).toBe(true);
    expect(deadlines[1].ms).toBe(10_000);

    held.release(rowsOf(30));
    await pull;
    expect(deadlines[1].cleared).toBe(true); // nothing left to abort a settled pull
  });

  it.each([
    ['a skip', 40, (h: ReturnType<typeof headersOnly>) => h.release(rowsOf(30))],
    ['a downgrade', 500, (h: ReturnType<typeof headersOnly>) => h.release(rowsOf(5))],
    ['a failed body read', 40, (h: ReturnType<typeof headersOnly>) => h.fail()],
  ])(
    'a close with the queue open that ends in %s writes the marker last, after the held frames',
    async (_label, rowsHeld, finish) => {
      // No replay ever runs here, so nothing would wipe a marker written at the
      // close; written straight away it sat ABOVE the output the pull was still
      // holding, which the finally block then flushed underneath it.
      const pane = makePane('shell');
      pane.terminal.buffer.active.length = rowsHeld;
      const held = headersOnly();
      fetchMock.mockResolvedValueOnce(held.response);

      const pull = pane._pullHistory();
      await settle(); // the response landed: the queue is open
      pane._onLiveOutput('frame-A');
      pane._onLiveOutput('frame-B');
      pane._onSocketClosed();
      expect(pane.terminal.write).not.toHaveBeenCalled();
      finish(held);
      await pull;

      const writes = pane.terminal.write.mock.calls.map((c) => c[0]);
      expect(writes.slice(0, 2)).toEqual(['frame-A', 'frame-B']);
      expect(writes).toHaveLength(3);
      expect(isMarker(writes[2])).toBe(true);
      expect(pane._liveQueue).toBeNull();
    }
  );

  it('a close during the replay writes exactly one marker, at the end', async () => {
    const pane = makePane('shell');
    const xterm = holdParses(pane);
    const response = deferred<ReturnType<typeof jsonResponse>>();
    fetchMock.mockReturnValueOnce(response.promise);

    const pull = pane._pullHistory();
    // Three chunks, still being parsed once the fetch lands.
    const bigReplay = Array.from({ length: 200 }, () => 'y'.repeat(400)).join('\n');
    response.resolve(jsonResponse(bigReplay));
    await settle();
    expect(xterm.held).toHaveLength(1);

    // Written now, the marker would land above the recovered history's end.
    pane._onSocketClosed();
    xterm.parse();
    await settle();
    xterm.parse();
    await pull;

    const writes = screenWrites(pane);
    expect(writes[0]).toBe('\x1bc');
    expect(writes.filter(isMarker)).toHaveLength(1);
    expect(isMarker(writes.at(-1))).toBe(true);
  });

  it('a refresh queued behind a pull on a closed socket does not wipe the marker', async () => {
    // The refresh's clear() runs after the pull's finally block has written the
    // marker, so without a re-stamp the dead pane would look current again.
    const pane = makePane('shell');
    const held = headersOnly();
    fetchMock.mockResolvedValueOnce(held.response).mockResolvedValueOnce(jsonResponse('refreshed'));

    const pull = pane._pullHistory();
    await settle();
    pane._refreshBuffer(); // coalesced into one trailing re-run
    pane._onSocketClosed(); // deferred: the queue is open
    held.release(rowsOf(30)); // no replay
    await pull;
    await settle();

    const writes = pane.terminal.write.mock.calls.map((c) => c[0]);
    expect(pane.terminal.clear).toHaveBeenCalledTimes(1);
    expect(writes).toContain('refreshed');
    expect(isMarker(writes.at(-1))).toBe(true);
    expect(writes.lastIndexOf('refreshed')).toBeLessThan(writes.length - 1);
    // The pull left the owed marker to the refresh rather than stamping it too.
    expect(writes.filter(isMarker)).toHaveLength(1);
  });

  it.each([
    [
      'back-to-back refreshes',
      async (pane: PaneUnderTest) => {
        pane._wsClosed = true;
        fetchMock.mockResolvedValueOnce(jsonResponse('first')).mockResolvedValueOnce(jsonResponse('second'));
        pane._refreshBuffer();
        pane._refreshBuffer(); // coalesced into the trailing re-run
      },
    ],
    [
      'a pull with a queued refresh and a close mid-pull',
      async (pane: PaneUnderTest) => {
        const held = headersOnly();
        fetchMock.mockResolvedValueOnce(held.response).mockResolvedValueOnce(jsonResponse('second'));
        void pane._pullHistory();
        await settle(); // the response landed: the queue is open
        pane._refreshBuffer(); // coalesced into the trailing re-run
        pane._onSocketClosed();
        held.release(rowsOf(30)); // no replay
      },
    ],
  ])('with xterm parsing writes on a later tick, %s leave one marker on screen, last', async (_label, drive) => {
    // Real xterm queues write() and parses it on a later tick (WriteBuffer's
    // setTimeout), while clear() rewrites the buffer at once. The default fake
    // applies writes synchronously and so cannot show a marker overtaken by a
    // trailing refresh's clear(): parsed after it, that marker sat above the
    // refresh's replay as a second, stale copy.
    const pane = makePane('shell');
    const screen: string[] = [];
    const pending: Array<{ data: string; done?: () => void }> = [];
    pane.terminal.write = vi.fn((data: string, done?: () => void) => {
      if (pending.length === 0) {
        setTimeout(() => {
          for (const entry of pending.splice(0)) {
            if (entry.data === '\x1bc') screen.length = 0;
            else if (entry.data) screen.push(entry.data);
            entry.done?.();
          }
        }, 0);
      }
      pending.push({ data, done });
    });
    pane.terminal.clear = vi.fn(() => {
      screen.length = 0;
    });

    await drive(pane);
    for (let i = 0; i < 5; i++) await settle();

    expect(pane._bufferLoading).toBe(false);
    expect(screen.filter(isMarker)).toHaveLength(1);
    expect(screen.at(-1)).toSatisfy(isMarker);
    expect(screen.indexOf('second')).toBe(screen.length - 2);
  });

  it('a refresh on an open socket does not stamp a marker', async () => {
    const pane = makePane('shell');
    fetchMock.mockResolvedValueOnce(jsonResponse('refreshed'));

    pane._refreshBuffer();
    await settle();

    expect(pane.terminal.write.mock.calls.map((c) => c[0]).filter(isMarker)).toHaveLength(0);
  });

  it('does not re-stamp the marker when the socket is still open', async () => {
    const pane = makePane('shell');
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(100)));

    void pane._pullHistory();
    await settle();

    for (const call of pane.terminal.write.mock.calls) {
      expect(call[0]).toEqual(expect.not.stringMatching(/\[disconnected/));
    }
  });

  it('does not re-stamp the marker when the pull never replayed (skip/downgrade path)', async () => {
    // Nothing erased the marker in this path, so re-stamping it would be a
    // second, redundant write.
    const pane = makePane('shell');
    pane._wsClosed = true;
    fetchMock.mockResolvedValueOnce(jsonResponse(rowsOf(30))); // held in full already: no replay

    void pane._pullHistory();
    await settle();

    expect(pane.terminal.write).not.toHaveBeenCalled();
  });
});
