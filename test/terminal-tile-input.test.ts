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
 * Real code under test: constants.js + app.js (the queue) + terminal-ui.js (the
 * shared input predicates) + terminal-tile.js, in one `vm` context. xterm, the
 * fit addon and WebSocket are fakes; `connect()` runs for real.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  write(_data: string, cb?: () => void) {
    cb?.();
  }
  clear() {}
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
    setTimeout,
    clearTimeout,
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
  ws: FakeSocket | null;
};
const TerminalTile = windowStub.TerminalTile as new (id: string, mount: unknown, opts?: object) => Tile;

async function connectTile(app: App) {
  windowStub.app = app;
  const tile = new TerminalTile('s-tile', { addEventListener: vi.fn(), removeEventListener: vi.fn() }, { mode: 'claude' });
  await tile.connect();
  const ws = FakeSocket.instances.at(-1)!;
  return { tile, ws, term: FakeTerminal.last! };
}

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
