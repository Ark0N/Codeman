/**
 * @fileoverview Every capture a grid tile fetches goes through ONE queue.
 *
 * `GET /api/sessions/:id/terminal` runs synchronous tmux calls on the server, so
 * N tiles loading at once do not load in parallel: they stall every WebSocket
 * and SSE stream on the server back to back. The grid therefore hands each
 * TerminalTile a `scheduleLoad` (a TileLoadQueue, terminal-tile.js) and the
 * tile routes EVERY capture through it: the initial load, the refresh after a
 * reconnect, a server `{t:'r'}` refresh and the shell history pull.
 *
 * Pinned here, with `connect()` and the socket handlers running for real:
 * - at most one `/terminal` fetch is in flight at a time, for initial loads and
 *   for N tiles reconnecting together;
 * - the focused tile goes first, then reading order, and a history pull (the
 *   user is waiting on it) jumps ahead of background refreshes;
 * - `{t:'r'}` goes through the same queue, and a tile waiting its turn keeps its
 *   last frame (the clear happens at its turn);
 * - a destroyed tile's queued load is dropped, and destroying the tile whose
 *   load is running aborts its fetch so the queue moves on;
 * - a load that never answers is cut off by its deadline;
 * - a close while a load only WAITS writes the disconnected marker at once;
 * - grid tiles load a bounded window and keep TILE_SCROLLBACK lines.
 *
 * Real code under test: constants.js + app.js + terminal-ui.js +
 * terminal-tile.js in one `vm` context; xterm, the fit addon and WebSocket are
 * fakes. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close = vi.fn(() => {
    this.readyState = 3;
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

class FakeFit {
  term: FakeTerminal | null = null;
  fit() {}
  proposeDimensions() {
    return { cols: 80, rows: 24 };
  }
}

class FakeTerminal {
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  buffer = { active: { type: 'normal', viewportY: 0, length: 24 } };
  writes: string[] = [];
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
  }
  loadAddon(addon: FakeFit) {
    addon.term = this;
  }
  open() {}
  onData() {}
  attachCustomKeyEventHandler() {}
  registerLinkProvider() {}
  textarea = { addEventListener() {}, removeEventListener() {} };
  write(data: string, cb?: () => void) {
    this.writes.push(data);
    cb?.();
  }
  clear() {
    this.writes.push('<CLEAR>');
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  scrollToLine() {}
  scrollToTop() {}
  dispose() {}
}

/** One `/terminal` fetch the test answers (or lets hang) by hand. */
type Capture = { url: string; settled: boolean; aborted: boolean; answer(body: string): void };
let captures: Capture[] = [];
const fetchMock = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
  return new Promise((resolveFetch, rejectFetch) => {
    const capture: Capture = {
      url,
      settled: false,
      aborted: false,
      answer(body: string) {
        capture.settled = true;
        resolveFetch({ ok: true, status: 200, json: async () => ({ data: { terminalBuffer: body } }) });
      },
    };
    init?.signal?.addEventListener('abort', () => {
      capture.settled = true;
      capture.aborted = true;
      rejectFetch(new Error('aborted'));
    });
    captures.push(capture);
  });
});
const inFlight = () => captures.filter((c) => !c.settled).length;

const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
const windowStub: Record<string, unknown> = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  CodemanBase: { base: '' },
  AbortController,
};
const context = vm.createContext({
  console: { ...console, log: vi.fn(), debug: vi.fn() },
  performance,
  setInterval: vi.fn(),
  clearInterval: vi.fn(),
  // Late-bound so vi.useFakeTimers() reaches code running in this context.
  setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
  requestAnimationFrame: vi.fn(),
  HTMLCanvasElement: class HTMLCanvasElement {},
  WebSocket: FakeSocket,
  Terminal: FakeTerminal,
  FitAddon: { FitAddon: FakeFit },
  fetch: (...args: Parameters<typeof fetchMock>) => fetchMock(...args),
  location: { protocol: 'http:', host: 'codeman.test' },
  document: { addEventListener: vi.fn(), documentElement: { dataset: {} } },
  localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
  window: windowStub,
  MobileDetection: { isTouchDevice: () => false, isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
});
vm.runInContext(
  `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\n${read('terminal-tile.js')}\n` +
    'globalThis.__CodemanApp = CodemanApp;',
  context
);
const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
const TileGrid = windowStub.CodemanTileGrid as { TILE_SCROLLBACK: number };
const TAIL = 1024 * 1024;

type Tile = {
  sessionId: string;
  connect(): Promise<void>;
  destroy(): void;
  reconnectNow(): void;
  _maybeLoadMoreHistory(): void;
  _destroyed: boolean;
  terminal: FakeTerminal | null;
  ws: FakeSocket | null;
};
type Queue = {
  schedule(tile: object, kind: string, run: () => Promise<void>): Promise<void>;
  size: number;
  activeTile: object | null;
};
const TerminalTile = windowStub.TerminalTile as new (id: string, mount: unknown, opts?: object) => Tile;
const TileLoadQueue = windowStub.TileLoadQueue as new (opts?: object) => Queue;

function makeApp() {
  const app = Object.create(CodemanApp.prototype) as Record<string, unknown>;
  app._clientId = 'c-test';
  app._wsTabNonce = 'nonce-1';
  app._seqCounters = new Map();
  app._pendingDeliveries = new Map();
  app._postDraining = new Set();
  app._extraInputSockets = new Map();
  app._persistReliableState = vi.fn();
  app._persistReliableNow = vi.fn();
  app._updateConnectionIndicator = vi.fn();
  app.loadAppSettingsFromStorage = () => ({});
  app._estimateReplayRows = (text: string) => text.split('\n').length;
  return app;
}

const liveTiles: Tile[] = [];
/** Grid-style tiles sharing one queue: the focused id ranks first, then the order given. */
function makeGrid(ids: string[], { focused = ids[0], modes = {} as Record<string, string> } = {}) {
  windowStub.app = makeApp();
  const order = [...ids];
  const states: Array<[string, string]> = [];
  const queue = new TileLoadQueue({
    rank: (tile: Tile) => (tile.sessionId === focused ? -1 : order.indexOf(tile.sessionId)),
    onChange: (tile: Tile, state: string) => states.push([tile.sessionId, state]),
  });
  const tiles = ids.map((id) => {
    const tile = new TerminalTile(
      id,
      { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      {
        mode: modes[id] ?? 'claude',
        scheduleLoad: (t: object, kind: string, run: () => Promise<void>) => queue.schedule(t, kind, run),
        scrollback: TileGrid.TILE_SCROLLBACK,
        fontSize: 13,
        boundedLoad: true,
      }
    );
    liveTiles.push(tile);
    return tile;
  });
  return { tiles, queue, states };
}

/** Let promise chains (fetch, json, chunked write, queue pump) run. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Answer every capture as it arrives, one at a time, asserting the queue never overlaps two. */
async function drain(body = 'frame') {
  let max = 0;
  for (let guard = 0; guard < 50; guard++) {
    await settle();
    max = Math.max(max, inFlight());
    const open = captures.find((c) => !c.settled);
    if (!open) break;
    open.answer(body);
  }
  return max;
}

beforeEach(() => {
  captures = [];
  fetchMock.mockClear();
  FakeSocket.instances = [];
});

afterEach(() => {
  for (const tile of liveTiles.splice(0)) tile.destroy();
  vi.useRealTimers();
});

describe('initial loads', () => {
  it('N tiles connecting together fetch one capture at a time', async () => {
    const { tiles } = makeGrid(['a', 'b', 'c', 'd']);
    const connecting = tiles.map((t) => t.connect());

    await settle();
    expect(inFlight()).toBe(1);
    expect(await drain()).toBe(1);
    await Promise.all(connecting);
    expect(captures).toHaveLength(4);
  });

  it('runs the focused tile first, then reading order', async () => {
    const { tiles } = makeGrid(['a', 'b', 'c', 'd'], { focused: 'c' });
    const connecting = tiles.map((t) => t.connect());
    await drain();
    await Promise.all(connecting);
    // `a` was already running when the others arrived; then focus, then order.
    expect(captures.map((c) => c.url.split('/')[3])).toEqual(['a', 'c', 'b', 'd']);
  });

  it('reports each tile queued, then running, then idle (the quiet loading state)', async () => {
    const { tiles, states } = makeGrid(['a', 'b']);
    const connecting = tiles.map((t) => t.connect());
    await drain();
    await Promise.all(connecting);
    expect(states.filter(([id]) => id === 'b').map(([, s]) => s)).toEqual(['queued', 'running', 'idle']);
  });

  it('loads a bounded window: full=1&tail= for a TUI, tail= for a shell', async () => {
    const { tiles } = makeGrid(['tui', 'sh'], { modes: { sh: 'shell' } });
    const connecting = tiles.map((t) => t.connect());
    await drain();
    await Promise.all(connecting);
    expect(captures.map((c) => c.url)).toEqual([
      `/api/sessions/tui/terminal?full=1&tail=${TAIL}`,
      `/api/sessions/sh/terminal?tail=${TAIL}`,
    ]);
  });

  it('keeps TILE_SCROLLBACK lines and the tile font size', async () => {
    const { tiles } = makeGrid(['a']);
    const connecting = tiles[0].connect();
    await drain();
    await connecting;
    expect(tiles[0].terminal?.options.scrollback).toBe(10000);
    expect(tiles[0].terminal?.options.fontSize).toBe(13);
  });
});

/** Connects every tile and opens its socket, with the queue drained. */
async function connectAll(tiles: Tile[]) {
  const connecting = tiles.map((t) => t.connect());
  await drain('first');
  await Promise.all(connecting);
  for (const tile of tiles) tile.ws?.open();
  captures = [];
}

describe('refreshes', () => {
  it('N tiles reconnecting together (a deploy restart) refresh one at a time', async () => {
    const { tiles } = makeGrid(['a', 'b', 'c', 'd', 'e', 'f']);
    await connectAll(tiles);
    for (const tile of tiles) tile.ws?.drop(1006);
    for (const tile of tiles) {
      tile.reconnectNow();
      tile.ws?.open();
    }

    await settle();
    expect(inFlight()).toBe(1);
    expect(await drain('after')).toBe(1);
    expect(captures).toHaveLength(6);
  });

  it('a server {t:"r"} refresh waits its turn behind another tile, keeping its last frame meanwhile', async () => {
    const { tiles } = makeGrid(['a', 'b']);
    await connectAll(tiles);
    const [a, b] = tiles;
    a.ws?.receive({ t: 'r' });
    b.ws?.receive({ t: 'r' });
    await settle();

    expect(captures.map((c) => c.url.split('/')[3])).toEqual(['a']);
    // b has not been cleared: it shows its last frame until its load runs.
    expect(b.terminal?.writes).not.toContain('<CLEAR>');

    await drain('fresh');
    expect(captures.map((c) => c.url.split('/')[3])).toEqual(['a', 'b']);
    expect(b.terminal?.writes.slice(-2)).toEqual(['<CLEAR>', 'fresh']);
  });

  it('a history pull jumps ahead of background refreshes', async () => {
    const { tiles } = makeGrid(['a', 'b', 'sh'], { modes: { sh: 'shell' } });
    await connectAll(tiles);
    const [a, b, sh] = tiles;
    a.ws?.receive({ t: 'r' });
    b.ws?.receive({ t: 'r' });
    sh._maybeLoadMoreHistory();
    await settle();

    expect(inFlight()).toBe(1);
    await drain();
    expect(captures.map((c) => c.url)).toEqual([
      `/api/sessions/a/terminal?full=1&tail=${TAIL}`,
      `/api/sessions/sh/terminal?full=1&tail=${TAIL}`,
      `/api/sessions/b/terminal?full=1&tail=${TAIL}`,
    ]);
  });

  it('a close while the refresh only WAITS writes the marker at once, and once', async () => {
    const { tiles } = makeGrid(['a', 'b']);
    await connectAll(tiles);
    const [a, b] = tiles;
    a.ws?.receive({ t: 'r' });
    b.ws?.receive({ t: 'r' });
    await settle();
    b.ws?.drop(1006);

    const markers = () => (b.terminal?.writes ?? []).filter((w) => w.includes('[disconnected')).length;
    expect(markers()).toBe(1);
    await drain('fresh');
    // Its turn cleared the screen, so the marker is written again below the replay: one on screen.
    const writes = b.terminal?.writes ?? [];
    expect(writes.slice(writes.lastIndexOf('<CLEAR>'))).toEqual([
      '<CLEAR>',
      'fresh',
      expect.stringContaining('[disconnected'),
    ]);
  });
});

describe('teardown', () => {
  it("drops a destroyed tile's queued load: it never fetches", async () => {
    const { tiles, queue } = makeGrid(['a', 'b', 'c']);
    const connecting = tiles.map((t) => t.connect());
    await settle();
    tiles[1].destroy();
    await drain();
    await Promise.all(connecting);

    expect(captures.map((c) => c.url.split('/')[3])).toEqual(['a', 'c']);
    expect(queue.size).toBe(0);
    expect(tiles[1].ws).toBeNull();
  });

  it('destroying the tile whose load is running aborts its fetch and the queue moves on', async () => {
    const { tiles } = makeGrid(['a', 'b']);
    const connecting = tiles.map((t) => t.connect());
    await settle();
    tiles[0].destroy();
    await settle();

    expect(captures[0].aborted).toBe(true);
    expect(captures.map((c) => c.url.split('/')[3])).toEqual(['a', 'b']);
    await drain();
    await Promise.all(connecting);
  });

  it('a capture that never answers is cut off by its deadline, and the next tile loads', async () => {
    vi.useFakeTimers();
    const { tiles } = makeGrid(['a', 'b']);
    const connecting = tiles.map((t) => t.connect());
    await settle();
    expect(captures).toHaveLength(1);

    // The full-capture budget (CodemanFetchDeadline, 45 s for a TUI).
    await vi.advanceTimersByTimeAsync(45_000);
    await settle();
    expect(captures[0].aborted).toBe(true);
    expect(captures.map((c) => c.url.split('/')[3])).toEqual(['a', 'b']);
    captures[1].answer('b');
    await settle();
    await Promise.all(connecting);
  });
});

describe('TileLoadQueue on its own', () => {
  it('never rejects, and moves on when a load throws', async () => {
    const queue = new TileLoadQueue();
    const order: string[] = [];
    const first = queue.schedule({}, 'initial', async () => {
      order.push('first');
      throw new Error('boom');
    });
    const second = queue.schedule({}, 'initial', async () => {
      order.push('second');
    });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(order).toEqual(['first', 'second']);
    expect(queue.activeTile).toBeNull();
  });

  it('resolves, but never runs, a load whose tile was destroyed while it waited', async () => {
    const queue = new TileLoadQueue();
    let release: () => void = () => {};
    const busy = queue.schedule({}, 'initial', () => new Promise<void>((r) => (release = r)));
    const gone = { _destroyed: false };
    const run = vi.fn(async () => {});
    const waiting = queue.schedule(gone, 'refresh', run);
    gone._destroyed = true;
    release();
    await busy;
    await expect(waiting).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it('drop() resolves every load still waiting for a tile', async () => {
    const queue = new TileLoadQueue();
    let release: () => void = () => {};
    const busy = queue.schedule({}, 'initial', () => new Promise<void>((r) => (release = r)));
    const tile = {};
    const run = vi.fn(async () => {});
    const waiting = queue.schedule(tile, 'refresh', run);
    (queue as unknown as { drop(t: object): void }).drop(tile);
    await expect(waiting).resolves.toBeUndefined();
    release();
    await busy;
    expect(run).not.toHaveBeenCalled();
  });
});
