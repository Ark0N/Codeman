/**
 * @fileoverview TerminalTile input rides the app's exactly-once queue, and only
 * what a human typed is queued.
 *
 * Before, the split pane's second terminal sent every xterm `onData` chunk as a
 * bare `{t:'i', d}` frame: no seq, no ACK, dropped while the socket was down,
 * never acknowledged an idle alert. It now goes through `app._sendInputAsync`,
 * over the pane's own socket registered in the app's input-socket map. That
 * queue PERSISTS and REDELIVERS, so it must never hold what xterm generates on
 * its own: a query reply (DA/CPR/OSC) is dropped, exactly as the primary pane
 * drops it, and a focus or mouse report goes out once, ephemeral.
 *
 * The socket's lifecycle is pinned here too: a transient drop reconnects on the
 * primary pane's backoff and refreshes the buffer without leaving a stale
 * "disconnected" marker under a healthy pane; codes that cannot get better stop
 * the pane once (`onExit`); a late close from a REPLACED socket is ignored; and
 * destroy() cancels a pending reconnect.
 *
 * Real code under test: constants.js + app.js (the queue) + terminal-ui.js (the
 * shared input predicates) + terminal-tile.js, in one `vm` context. xterm, the
 * fit addon and WebSocket are fakes; `connect()` runs for real.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Frame = { t: string; d?: string; seq?: number; cid?: string; c?: number; r?: number };

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Frame);
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
  inputFrames() {
    return this.sent.filter((f) => f.t === 'i');
  }
}

class FakeTerminal {
  static last: FakeTerminal | null = null;
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  dataCb: ((data: string) => void) | null = null;
  buffer = { active: { type: 'normal', viewportY: 0, length: 24 } };
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    FakeTerminal.last = this;
  }
  loadAddon() {}
  open() {}
  onData(cb: (data: string) => void) {
    this.dataCb = cb;
  }
  attachCustomKeyEventHandler() {}
  registerLinkProvider() {}
  writes: string[] = [];
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
  dispose() {}
  type(data: string) {
    this.dataCb?.(data);
  }
}

const fetchMock = vi.fn();

function loadContext() {
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  const windowStub: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    CodemanBase: { base: '' },
  };
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), debug: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    // Late-bound, so vi.useFakeTimers() (which swaps the globals) reaches code
    // running inside this context.
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: FakeSocket,
    Terminal: FakeTerminal,
    FitAddon: {
      FitAddon: class {
        fit() {}
        proposeDimensions() {
          return { cols: 80, rows: 24 };
        }
      },
    },
    fetch: (...args: unknown[]) => fetchMock(...args),
    location: { protocol: 'http:', host: 'codeman.test' },
    document: { addEventListener: vi.fn(), documentElement: { dataset: {} } },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: windowStub,
    MobileDetection: {
      isTouchDevice: () => false,
      isHandheldDevice: () => false,
      getDeviceType: () => 'desktop',
    },
  });
  vm.runInContext(
    `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\n${read('terminal-tile.js')}\n` +
      'globalThis.__CodemanApp = CodemanApp;',
    context
  );
  return {
    CodemanApp: (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp,
    windowStub,
  };
}

const { CodemanApp, windowStub } = loadContext();

type App = Record<string, unknown> & {
  _pendingDeliveries: Map<string, Array<{ seq: number; data: string }>>;
  markIdleAlertSeen: ReturnType<typeof vi.fn>;
};

function makeApp(): App {
  const app = Object.create(CodemanApp.prototype) as App;
  app._clientId = 'c-test';
  app._wsTabNonce = 'nonce-1';
  app._seqCounters = new Map();
  app._pendingDeliveries = new Map();
  app._postDraining = new Set();
  app._extraInputSockets = new Map();
  app._persistReliableState = vi.fn();
  app._persistReliableNow = vi.fn();
  app._updateConnectionIndicator = vi.fn();
  app.markIdleAlertSeen = vi.fn();
  app.showToast = vi.fn();
  app._ws = null;
  app._wsSessionId = null;
  app._estimateReplayRows = (text: string) => text.split('\n').length;
  return app;
}

type Tile = {
  connect(): Promise<void>;
  destroy(): void;
  reconnectNow(): void;
  ws: FakeSocket | null;
  _reconnectAttempts: number;
};
const TerminalTile = windowStub.TerminalTile as new (id: string, mount: unknown, opts?: object) => Tile;

async function connectTile(app: App, opts: Record<string, unknown> = {}) {
  windowStub.app = app;
  const tile = new TerminalTile(
    's-tile',
    { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    { mode: 'claude', ...opts }
  );
  await tile.connect();
  const ws = FakeSocket.instances.at(-1)!;
  return { tile, ws, term: FakeTerminal.last! };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  FakeSocket.instances = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { terminalBuffer: '' } }),
  }));
});

describe('TerminalTile socket identity', () => {
  it('connects with the tab identity plus a :tile suffix, never the primary pane cid', async () => {
    const { ws } = await connectTile(makeApp());

    const cid = new URL(ws.url).searchParams.get('cid');
    expect(cid).toBe('c-test:nonce-1:tile');
  });
});

describe('TerminalTile input through the exactly-once queue', () => {
  it('sends typed input as seq-tagged frames with the bare clientId once the socket opens', async () => {
    const app = makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();

    term.type('h');
    term.type('i');

    expect(ws.inputFrames().map((f) => [f.d, f.seq, f.cid])).toEqual([
      ['h', 1, 'c-test'],
      ['i', 2, 'c-test'],
    ]);
  });

  it('drops a record on its ACK and acknowledges the session idle alert', async () => {
    const app = makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();
    term.type('x');
    expect(app._pendingDeliveries.get('s-tile')).toHaveLength(1);

    ws.receive({ t: 'ia', seq: 1 });

    expect(app._pendingDeliveries.get('s-tile')).toBeUndefined();
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-tile');
  });

  it('flushes input typed before the socket opened, in order, once it does', async () => {
    const app = makeApp();
    // POSTs fail, as they would while the server restarts, so the input waits.
    const { ws, term } = await connectTile(app);
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    term.type('a');
    term.type('b');
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.inputFrames()).toEqual([]);

    ws.open();

    expect(ws.inputFrames().map((f) => [f.d, f.seq])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('keeps queuing after the socket closes (HTTP fallback), instead of dropping keystrokes', async () => {
    const app = makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();
    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    const posts: Array<{ input: string; seq: number }> = [];
    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      if (init?.body) posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({}) };
    });

    term.type('z');
    await new Promise((r) => setTimeout(r, 0));

    expect(posts.map((p) => [p.input, p.seq])).toEqual([['z', 1]]);
    expect(ws.inputFrames()).toEqual([]);
  });
});

describe('what xterm generates never enters the durable queue', () => {
  it('drops a DA query reply entirely', async () => {
    const app = makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();

    term.type('\x1b[?1;2c');

    expect(ws.inputFrames()).toEqual([]);
    expect(app._pendingDeliveries.get('s-tile')).toBeUndefined();
  });

  it('sends a mouse report once, without a seq, and never persists it', async () => {
    const app = makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();

    term.type('\x1b[<0;10;5M');

    expect(ws.inputFrames()).toEqual([{ t: 'i', d: '\x1b[<0;10;5M' }]);
    expect(app._pendingDeliveries.get('s-tile')).toBeUndefined();
  });

  it('sends a focus report once, without a seq', async () => {
    const app = makeApp();
    const { ws, term } = await connectTile(app);
    ws.open();

    term.type('\x1b[I');

    expect(ws.inputFrames()).toEqual([{ t: 'i', d: '\x1b[I' }]);
    expect(app._pendingDeliveries.get('s-tile')).toBeUndefined();
  });
});

describe('TerminalTile leaves the input-socket map', () => {
  it('on close, so a later keystroke cannot be written into a dead socket', async () => {
    const app = makeApp();
    const { ws } = await connectTile(app);
    ws.open();
    expect((app._extraInputSockets as Map<string, unknown>).has('s-tile')).toBe(true);

    ws.onclose?.({ code: 1006 });

    expect((app._extraInputSockets as Map<string, unknown>).has('s-tile')).toBe(false);
  });

  it('on destroy, while pending input stays queued for the HTTP sweep', async () => {
    const app = makeApp();
    const { tile, ws, term } = await connectTile(app);
    ws.open();
    term.type('q');

    tile.destroy();

    expect((app._extraInputSockets as Map<string, unknown>).has('s-tile')).toBe(false);
    expect(app._pendingDeliveries.get('s-tile')?.map((r) => r.data)).toEqual(['q']);
  });
});

const isMarker = (data: string) => data.includes('[disconnected');

/**
 * Lets the async buffer refresh settle: the fetch, the body read, the chunked
 * write AND the load's finally block, which is where a stale marker would be
 * stamped. Too few turns here and that assertion passes vacuously.
 */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('TerminalTile reconnects after a transient drop', () => {
  it('reopens on the backoff, refreshes the buffer, and leaves no stale marker', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const { tile, ws, term } = await connectTile(app);
    ws.open();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { terminalBuffer: 'fresh screen' } }),
    }));

    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    expect(term.writes.filter(isMarker)).toEqual([expect.stringContaining('[disconnected, reconnecting')]);
    expect(FakeSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.instances).toHaveLength(2);
    const ws2 = FakeSocket.instances[1];
    expect(ws2.url).toBe(ws.url);

    ws2.open();
    await settle();

    // The refresh cleared the pane and replayed the current screen, and nothing
    // after that clear is a marker: the pane is healthy again.
    const lastClear = term.writes.lastIndexOf('<CLEAR>');
    expect(lastClear).toBeGreaterThan(-1);
    expect(term.writes.slice(lastClear)).toContain('fresh screen');
    expect(term.writes.slice(lastClear).some(isMarker)).toBe(false);
    expect(tile._reconnectAttempts).toBe(0);
    expect(tile.ws).toBe(ws2);
  });

  it('counts failed attempts and resets the count only on a successful open', async () => {
    vi.useFakeTimers();
    const { tile, ws } = await connectTile(makeApp());
    ws.open();

    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(300);
    FakeSocket.instances[1].onclose?.({ code: 1006 }); // the retry fails too
    expect(tile._reconnectAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    FakeSocket.instances[2].open();
    expect(tile._reconnectAttempts).toBe(0);
  });

  it('reconnects after the redelivery sweep force-closes a silent socket (1005)', async () => {
    vi.useFakeTimers();
    const { ws } = await connectTile(makeApp());
    ws.open();

    ws.onclose?.({ code: 1005 });
    await vi.advanceTimersByTimeAsync(300);

    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('reconnectNow() skips the backoff, but never replaces an open socket', async () => {
    vi.useFakeTimers();
    const { tile, ws } = await connectTile(makeApp());
    ws.open();

    tile.reconnectNow();
    expect(FakeSocket.instances).toHaveLength(1);

    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    tile.reconnectNow();
    expect(FakeSocket.instances).toHaveLength(2);
    // The backoff timer it pre-empted must not open a third socket later.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('TerminalTile stops for good on codes that cannot get better', () => {
  it.each([
    [4004, 'the session ended'],
    [4009, 'the session ended'],
    [4003, 'the server refused this connection'],
    [4010, 'another connection took over this pane'],
  ])('close %i: no reconnect, onExit once, marker says why', async (code, reason) => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const { tile, ws, term } = await connectTile(makeApp(), { onExit });
    ws.open();

    ws.onclose?.({ code });
    await vi.advanceTimersByTimeAsync(30_000);
    tile.reconnectNow();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(code);
    expect(term.writes.filter(isMarker)).toEqual([expect.stringContaining(reason)]);
  });
});

describe('TerminalTile ignores a socket it already replaced', () => {
  it('a late close (4010) from the old socket neither stops the pane nor unregisters its successor', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const app = makeApp();
    const { ws, term } = await connectTile(app, { onExit });
    ws.open();
    const lateClose = ws.onclose!;

    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.instances[1];
    ws2.open();

    // The server supersedes the old socket by cid; its close arrives late.
    lateClose({ code: 4010 });

    expect(onExit).not.toHaveBeenCalled();
    term.type('still typing');
    expect(ws2.inputFrames().map((f) => f.d)).toEqual(['still typing']);
  });
});

describe('TerminalTile destroy()', () => {
  it('cancels a pending reconnect and never reports an exit afterwards', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const { tile, ws } = await connectTile(makeApp(), { onExit });
    ws.open();

    ws.onclose?.({ code: 1006 });
    tile.destroy();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(onExit).not.toHaveBeenCalled();
  });
});
