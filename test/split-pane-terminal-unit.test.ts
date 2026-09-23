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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TERMINAL_CHUNK_SIZE = 32 * 1024;

type FakeTerminal = {
  write: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
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
  destroy(): void;
  _loadBuffer(): Promise<void>;
  _refreshBuffer(): void;
};

const fetchMock = vi.fn();
/** requestAnimationFrame stand-in: chunked writes queue here and are drained by hand. */
const rafQueue: Array<() => void> = [];

function loadSplitTerminalPane() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const src = readFileSync(resolve(dir, 'terminal-split.js'), 'utf8');
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    window: {},
    fetch: (...args: unknown[]) => fetchMock(...args),
    requestAnimationFrame: (fn: () => void) => rafQueue.push(fn),
    // The constants.js globals the module reads at call time.
    TERMINAL_CHUNK_SIZE,
    TERMINAL_TAIL_SIZE: 1024 * 1024,
  });
  // The module's tail patches CodemanApp.prototype; nothing on it runs here.
  vm.runInContext(`class CodemanApp { _onSessionDeleted() {} selectSession() {} }\n${src}`, context);
  return (context.window as { SplitTerminalPane: new (id: string, mount: unknown, opts?: object) => PaneUnderTest })
    .SplitTerminalPane;
}

const SplitTerminalPane = loadSplitTerminalPane();

function makePane(mode = 'claude'): PaneUnderTest & { terminal: FakeTerminal } {
  const pane = new SplitTerminalPane('s1', {}, { mode });
  pane.terminal = { write: vi.fn(), clear: vi.fn(), dispose: vi.fn() };
  return pane as PaneUnderTest & { terminal: FakeTerminal };
}

function jsonResponse(terminalBuffer: string) {
  return { json: async () => ({ data: { terminalBuffer } }) };
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
