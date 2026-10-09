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
 * The last blocks pin the soft-keyboard controller every tile wires
 * (terminal-keycode229-recovery.js, the primary pane's #441/#541 fixes): an
 * Android autocorrect is sent as an edit, not a duplicated line, a character
 * committed in the same task as Enter goes out ahead of the \r, and the
 * controller is bound to THIS tile's textarea, composition helper and session.
 *
 * Real code under test: constants.js + terminal-keycode229-recovery.js +
 * app.js (the queue) + terminal-ui.js (the shared input predicates) +
 * terminal-tile.js, in one `vm` context. xterm, the fit addon and WebSocket are
 * fakes (test/mocks/terminal-tile-fakes.ts); `connect()` runs for real.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFit, FakeSocket, FakeTerminal } from './mocks/terminal-tile-fakes.js';

const fetchMock = vi.fn();

function loadContext() {
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  const windowStub: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    CodemanBase: { base: '' },
    // The keyCode-229 controller defaults its timers to window's. Late-bound,
    // like the context's own, so vi.useFakeTimers() reaches it; without them
    // its create() throws into the tile's catch and every controller test
    // would run against no controller at all.
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
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
    FitAddon: { FitAddon: FakeFit },
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
    `${read('constants.js')}\n${read('terminal-keycode229-recovery.js')}\n${read('app.js')}\n` +
      `${read('terminal-ui.js')}\n${read('terminal-tile.js')}\n` +
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
  // The key handler's chord gates read the shortcut registry, which reads these.
  app.loadAppSettingsFromStorage = () => ({});
  app._ws = null;
  app._wsSessionId = null;
  app._estimateReplayRows = (text: string) => text.split('\n').length;
  return app;
}

type Tile = {
  connect(): Promise<void>;
  destroy(): void;
  reconnectNow(): void;
  fit(opts?: { force?: boolean }): void;
  detachedSessions?: Set<string>;
  ws: FakeSocket | null;
  _reconnectAttempts: number;
};
const TerminalTile = windowStub.TerminalTile as new (id: string, mount: unknown, opts?: object) => Tile;

/**
 * Every tile a test creates, destroyed after it. A tile closed with real timers
 * schedules a real reconnect, and one firing during a LATER test opens a socket
 * there (FakeSocket.instances is shared), which flaked under full-suite load.
 */
const liveTiles: Tile[] = [];

async function connectTile(app: App, opts: Record<string, unknown> = {}) {
  windowStub.app = app;
  const tile = new TerminalTile(
    's-tile',
    { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    { mode: 'claude', ...opts }
  );
  liveTiles.push(tile);
  await tile.connect();
  const ws = FakeSocket.instances.at(-1)!;
  return { tile, ws, term: FakeTerminal.last! };
}

afterEach(() => {
  for (const tile of liveTiles.splice(0)) tile.destroy();
  vi.useRealTimers();
});

beforeEach(() => {
  FakeTerminal.coreFactory = null;
  FakeFit.proposed = { cols: 80, rows: 24 };
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

describe('TerminalTile geometry (#464: the pane and its PTY never disagree)', () => {
  const resizeFrames = (ws: FakeSocket) => ws.sent.filter((f) => f.t === 'z');

  it('announces its size as a desktop viewer when the socket opens', async () => {
    const { ws } = await connectTile(makeApp());
    ws.open();

    expect(resizeFrames(ws)).toEqual([{ t: 'z', c: 80, r: 24, v: 'desktop' }]);
  });

  it('does not resend an unchanged size, sends a changed one, and force resends', async () => {
    const { tile, ws } = await connectTile(makeApp());
    ws.open();

    tile.fit();
    expect(resizeFrames(ws)).toHaveLength(1);

    FakeFit.proposed = { cols: 100, rows: 30 };
    tile.fit();
    expect(resizeFrames(ws).at(-1)).toEqual({ t: 'z', c: 100, r: 30, v: 'desktop' });

    tile.fit({ force: true });
    expect(resizeFrames(ws)).toHaveLength(3);
  });

  it('re-announces an unchanged size on a reconnected socket', async () => {
    vi.useFakeTimers();
    const { ws } = await connectTile(makeApp());
    ws.open();
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.instances[1];

    ws2.open();

    expect(resizeFrames(ws2)).toEqual([{ t: 'z', c: 80, r: 24, v: 'desktop' }]);
  });

  it('applies no 40-column floor: a pane at the divider clamp gets its real width on both sides', async () => {
    const { tile, ws, term } = await connectTile(makeApp());
    ws.open();

    FakeFit.proposed = { cols: 28, rows: 30 };
    tile.fit();

    expect(term.cols).toBe(28);
    expect(resizeFrames(ws).at(-1)).toEqual({ t: 'z', c: 28, r: 30, v: 'desktop' });
  });

  it('paneStarted() resends an unchanged size: the first one went out before there was a PTY', async () => {
    const { tile, ws } = await connectTile(makeApp());
    ws.open();
    tile.paneStarted();
    expect(resizeFrames(ws)).toEqual([
      { t: 'z', c: 80, r: 24, v: 'desktop' },
      { t: 'z', c: 80, r: 24, v: 'desktop' },
    ]);
    // Only once: the size is recorded again, so a plain fit does not repeat it.
    tile.fit();
    expect(resizeFrames(ws)).toHaveLength(2);
  });

  it('paneStarted() on a hidden tile sends nothing, and its next fit sends the size', async () => {
    const { tile, ws } = await connectTile(makeApp());
    ws.open();
    FakeFit.proposed = { cols: NaN, rows: NaN };
    tile.paneStarted();
    expect(resizeFrames(ws)).toHaveLength(1);
    // Shown again (a zoom ends) at the same size it had: still sent.
    FakeFit.proposed = { cols: 80, rows: 24 };
    tile.fit();
    expect(resizeFrames(ws)).toHaveLength(2);
  });

  it('paneStarted() before the socket opens sends nothing; the open sends the size once', async () => {
    const { tile, ws } = await connectTile(makeApp());
    tile.paneStarted();
    expect(resizeFrames(ws)).toHaveLength(0);
    ws.open();
    expect(resizeFrames(ws)).toEqual([{ t: 'z', c: 80, r: 24, v: 'desktop' }]);
  });

  it('reports nothing while hidden (the fit addon measures NaN)', async () => {
    const { tile, ws, term } = await connectTile(makeApp());
    ws.open();

    FakeFit.proposed = { cols: NaN, rows: NaN };
    tile.fit();

    expect(resizeFrames(ws)).toHaveLength(1);
    expect([term.cols, term.rows]).toEqual([80, 24]);
  });

  it('stands aside for a session detached into its own window', async () => {
    const { tile, ws } = await connectTile(makeApp(), { detachedSessions: new Set(['s-tile']) });
    ws.open();
    FakeFit.proposed = { cols: 120, rows: 40 };

    tile.fit();

    expect(resizeFrames(ws)).toEqual([]);
  });

  it('adopts the column count the PTY reports, keeping its own rows', async () => {
    const { ws, term } = await connectTile(makeApp());
    ws.open();

    ws.receive({ t: 'zc', c: 132, r: 50 });

    expect([term.cols, term.rows]).toEqual([132, 24]);
  });

  it('leaves the pane alone when the PTY agrees on width', async () => {
    const { ws, term } = await connectTile(makeApp());
    ws.open();
    const before = term.resizes.length;

    ws.receive({ t: 'zc', c: 80, r: 60 });

    expect(term.resizes.length).toBe(before);
  });
});

describe('TerminalTile links and paste follow THIS pane', () => {
  it('registers the shared link provider on its own terminal, resolving its own session', async () => {
    const app = makeApp();
    const register = vi.fn();
    app.registerFilePathLinkProvider = register;

    const { term } = await connectTile(app);

    expect(register).toHaveBeenCalledTimes(1);
    const target = register.mock.calls[0][0] as { terminal: unknown; getSessionId: () => string };
    expect(target.terminal).toBe(term);
    expect(target.getSessionId()).toBe('s-tile');
  });

  it("routes Ctrl+V into the paste trap with this pane's terminal and session", async () => {
    const app = makeApp();
    const paste = vi.fn();
    app._handleImagePaste = paste;
    const { term } = await connectTile(app);

    const handled = term.keyHandler!({ type: 'keydown', key: 'v', ctrlKey: true, code: 'KeyV' });

    expect(handled).toBe(false);
    expect(paste).toHaveBeenCalledWith({ terminal: term, sessionId: 's-tile' });
  });

  it('leaves Ctrl+Shift+V (voice input) out of the paste trap', async () => {
    const app = makeApp();
    const paste = vi.fn();
    app._handleImagePaste = paste;
    const { term } = await connectTile(app);

    term.keyHandler!({ type: 'keydown', key: 'V', ctrlKey: true, shiftKey: true, code: 'KeyV' });

    expect(paste).not.toHaveBeenCalled();
  });
});

describe("TerminalTile Ctrl+C copies through the primary pane's copy helpers", () => {
  const ctrlC = (extra: Record<string, unknown> = {}) => ({
    type: 'keydown',
    key: 'c',
    code: 'KeyC',
    ctrlKey: true,
    preventDefault: vi.fn(),
    ...extra,
  });

  it("copies THIS pane's selection; a failed write keeps it and focus returns to this pane", async () => {
    const app = makeApp();
    const copyText = vi.fn(async () => false);
    app._copyText = copyText;
    const { term } = await connectTile(app);
    term.selection = 'npm run build';

    const ev = ctrlC();
    expect(term.keyHandler!(ev)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));

    expect(ev.preventDefault).toHaveBeenCalled();
    expect(copyText).toHaveBeenCalledWith('npm run build');
    expect(app.showToast).toHaveBeenCalledWith('Failed to copy', 'error');
    // As in the primary pane: nothing was copied, so the selection stays for a retry.
    expect(term.clearSelection).not.toHaveBeenCalled();
    expect(term.selection).toBe('npm run build');
    // The execCommand fallback focuses a temporary textarea; the keyboard comes back here.
    expect(term.focus).toHaveBeenCalled();
  });

  it('a successful write clears the selection (a second Ctrl+C interrupts) and refocuses this pane', async () => {
    const app = makeApp();
    app._copyText = vi.fn(async () => true);
    const { term } = await connectTile(app);
    term.selection = 'npm run build';

    expect(term.keyHandler!(ctrlC())).toBe(false);
    await new Promise((r) => setTimeout(r, 0));

    expect(app.showToast).toHaveBeenCalledWith('Copied to clipboard', 'success');
    expect(term.clearSelection).toHaveBeenCalled();
    expect(term.focus).toHaveBeenCalled();
  });

  it('with nothing selected, Ctrl+C reaches the PTY and Ctrl+Shift+C does not', async () => {
    const app = makeApp();
    const copyText = vi.fn(async () => true);
    app._copyText = copyText;
    const { term } = await connectTile(app);

    const plain = ctrlC();
    expect(term.keyHandler!(plain)).toBe(true);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    const shifted = ctrlC({ key: 'C', shiftKey: true });
    expect(term.keyHandler!(shifted)).toBe(false);
    expect(shifted.preventDefault).toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe('TerminalTile claims the keyboard for the app-level shortcuts', () => {
  it('focusing its terminal makes it the focused pane; destroy() hands the keyboard back', async () => {
    const app = makeApp();
    const { tile, term } = await connectTile(app);
    expect(app._focusedTile ?? null).toBeNull();

    term.focusTextarea();
    expect(app._focusedTile).toBe(tile);

    tile.destroy();
    expect(app._focusedTile).toBeNull();
    expect(term.focusListeners).toEqual([]);
  });
});

describe('the server coming back kicks Pane B', () => {
  it("handleInit's reconnect branch asks the split pane's tile to reconnect without waiting out its backoff", () => {
    // handleInit needs a whole app to run, so the wiring is pinned by source;
    // reconnectNow() itself is exercised above.
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const start = appSource.indexOf('if (keepTerminal && restoreId === previousActiveId');
    const branch = appSource.slice(start, appSource.indexOf('} else {', start));

    expect(start).toBeGreaterThan(-1);
    expect(branch).toContain('this._splitPane?.reconnectNow?.();');
  });
});

/**
 * xterm's CompositionHelper, reduced to what the keyCode-229 controller touches.
 * Its `_handleAnyTextareaChanges` is xterm's own append-only diff as shipped
 * (node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts), so a
 * control without the controller reproduces the device-log duplicate, and its
 * `triggerDataEvent` feeds the tile's onData, as xterm's core service does.
 */
type Helper = {
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _coreService: { triggerDataEvent: (data: string, wasUserInput?: boolean) => void };
  _handleAnyTextareaChanges: () => void;
};

/**
 * Gives every FakeTerminal created from now on a composition helper. Returns
 * them in creation order, with xterm's own diff each one started with.
 */
function withCompositionHelpers() {
  const helpers: Helper[] = [];
  const originals: Array<Helper['_handleAnyTextareaChanges']> = [];
  FakeTerminal.coreFactory = (term) => {
    const helper: Helper = {
      _isComposing: false,
      _isSendingComposition: false,
      _dataAlreadySent: '',
      _coreService: { triggerDataEvent: (data: string) => term.type(data) },
      _handleAnyTextareaChanges(this: Helper) {
        const oldValue = term.textarea.value;
        setTimeout(() => {
          if (this._isComposing) return;
          const newValue = term.textarea.value;
          const diff = newValue.replace(oldValue, '');
          this._dataAlreadySent = diff;
          if (newValue.length > oldValue.length) this._coreService.triggerDataEvent(diff, true);
          else if (newValue.length < oldValue.length) this._coreService.triggerDataEvent('\x7f', true);
          else if (newValue !== oldValue) this._coreService.triggerDataEvent(newValue, true);
        }, 0);
      },
    };
    helpers.push(helper);
    originals.push(helper._handleAnyTextareaChanges);
    return { _compositionHelper: helper };
  };
  return Object.assign(helpers, { originals });
}

/**
 * Drives a tile the way an Android soft keyboard drives xterm. The fake xterm
 * runs no CompositionHelper.keydown of its own, so `key229()` does what xterm
 * does, in xterm's order: the custom key handler first, then (keyCode 229, no
 * composition) the helper's `_handleAnyTextareaChanges()`, read off the helper
 * at call time so the controller's patch is what runs.
 */
function softKeyboard(term: FakeTerminal, helper: Helper) {
  const textarea = term.textarea;
  const key229 = () => {
    term.keyHandler!({ type: 'keydown', key: 'Unidentified', keyCode: 229 });
    helper._handleAnyTextareaChanges();
  };
  return {
    key229,
    /** One appended character, settled on its own timer before the next key. */
    typeKeys(text: string) {
      for (const ch of text) {
        key229();
        textarea.value += ch;
        vi.advanceTimersByTime(1);
      }
    },
    /** The textarea now reads `value` (what the keyboard's input event left there). */
    edit(value: string) {
      textarea.value = value;
    },
    /** Enter: the custom handler, then xterm's own \r, then xterm clearing its textarea. */
    enter() {
      const passed = term.keyHandler!({ type: 'keydown', key: 'Enter', keyCode: 13 });
      if (passed) term.type('\r');
      textarea.value = '';
    },
  };
}

/** Every byte the tile sent as input, in order. */
const joinFrames = (frames: Array<{ d?: string }>) => frames.map((f) => f.d ?? '').join('');
const wireOf = (ws: FakeSocket) => joinFrames(ws.inputFrames());

/** The line a shell ends up with: every DEL erases the character before it. */
function lineOf(frames: Array<{ d?: string }>) {
  const out: string[] = [];
  for (const ch of joinFrames(frames)) {
    if (ch === '\x7f') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

type ControllerTile = Tile & { _keyCode229Recovery: unknown };

describe("TerminalTile wires the primary pane's soft-keyboard controller (#441, #541)", () => {
  it("installs on THIS tile's composition helper and textarea, and destroy() restores xterm's own", async () => {
    const helpers = withCompositionHelpers();
    const { tile, term } = await connectTile(makeApp());
    const helper = helpers[0];
    expect((tile as ControllerTile)._keyCode229Recovery).not.toBeNull();

    // The controller patched this tile's helper (xterm's diff is no longer the one that runs) and
    // listens on this tile's textarea in the CAPTURE phase (see the module's measured table).
    expect(helper._handleAnyTextareaChanges).not.toBe(helpers.originals[0]);
    const captured = term.textareaListeners.filter((l) => l.capture === true).map((l) => l.type);
    expect(captured.sort()).toEqual(['compositionend', 'compositionstart', 'input']);

    tile.destroy();

    expect((tile as ControllerTile)._keyCode229Recovery).toBeNull();
    expect(helper._handleAnyTextareaChanges).toBe(helpers.originals[0]);
    expect(term.textareaListeners).toEqual([]);
  });

  it('an autocorrect on space is sent as an edit, not a duplicated line', async () => {
    vi.useFakeTimers();
    const helpers = withCompositionHelpers();
    const app = makeApp();
    app.activeSessionId = 'some-other-session';
    const { tile, ws, term } = await connectTile(app);
    expect((tile as ControllerTile)._keyCode229Recovery).not.toBeNull();
    ws.open();
    const kb = softKeyboard(term, helpers[0]);

    kb.typeKeys('testing the peompt');
    // The device log's shape: ONE keydown deleting five characters, a second inserting `rompt `,
    // both before any timer runs.
    kb.key229();
    kb.edit('testing the p');
    kb.key229();
    kb.edit('testing the prompt ');
    vi.advanceTimersByTime(1);

    const frames = ws.inputFrames();
    expect(lineOf(frames)).toBe('testing the prompt ');
    expect(frames.filter((f) => f.d === '\x7f')).toHaveLength(5);
    // Every byte went to THIS tile's session through the exactly-once queue, never the active one.
    expect(frames.every((f) => Number.isInteger(f.seq))).toBe(true);
    expect(app._pendingDeliveries.get('s-tile')?.map((r) => r.data)).toEqual(frames.map((f) => f.d));
    expect(app._pendingDeliveries.has('some-other-session')).toBe(false);
  });

  it('control: without the controller, xterm alone duplicates the line exactly as the device did', async () => {
    vi.useFakeTimers();
    const helpers = withCompositionHelpers();
    const saved = windowStub.CodemanKeyCode229Recovery;
    delete windowStub.CodemanKeyCode229Recovery;
    try {
      const { tile, ws, term } = await connectTile(makeApp());
      expect((tile as ControllerTile)._keyCode229Recovery).toBeNull();
      ws.open();
      const kb = softKeyboard(term, helpers[0]);

      kb.typeKeys('testing the peompt');
      kb.key229();
      kb.edit('testing the p');
      kb.key229();
      kb.edit('testing the prompt ');
      vi.advanceTimersByTime(1);

      expect(lineOf(ws.inputFrames())).toBe('testing the peompttesting the prompt rompt ');
    } finally {
      windowStub.CodemanKeyCode229Recovery = saved;
    }
  });

  it('a 229 last character in the same task as Enter goes out ahead of the \\r (#441 + #541)', async () => {
    vi.useFakeTimers();
    const helpers = withCompositionHelpers();
    const { ws, term } = await connectTile(makeApp());
    ws.open();
    const kb = softKeyboard(term, helpers[0]);

    kb.typeKeys('hell');
    // One task: the last character's keydown and edit, then Enter, no timer in between.
    kb.key229();
    kb.edit('hello');
    kb.enter();
    // Settled synchronously at the Enter keydown, not by its timer.
    expect(wireOf(ws)).toBe('hello\r');

    vi.advanceTimersByTime(1);
    const wire = wireOf(ws);
    expect(wire).toBe('hello\r');
    expect(wire).not.toContain('\x7f');
  });

  it('an autocorrect plus Enter in one task submits the corrected line', async () => {
    vi.useFakeTimers();
    const helpers = withCompositionHelpers();
    const { ws, term } = await connectTile(makeApp());
    ws.open();
    const kb = softKeyboard(term, helpers[0]);

    kb.typeKeys('testing the peompt');
    kb.key229();
    kb.edit('testing the p');
    kb.key229();
    kb.edit('testing the prompt ');
    kb.enter();
    vi.advanceTimersByTime(1);

    const frames = ws.inputFrames();
    expect(lineOf(frames)).toBe('testing the prompt \r');
    expect(frames.filter((f) => f.d === '\x7f')).toHaveLength(5);
  });

  it('a 229 keystroke xterm diffed itself is delivered once, not again by the recovery', async () => {
    vi.useFakeTimers();
    const helpers = withCompositionHelpers();
    const { tile, ws, term } = await connectTile(makeApp());
    expect((tile as ControllerTile)._keyCode229Recovery).not.toBeNull();
    ws.open();
    const kb = softKeyboard(term, helpers[0]);

    kb.key229();
    kb.edit('y');
    term.textarea.fire('input', { inputType: 'insertText', data: 'y', isComposing: false });
    vi.advanceTimersByTime(1);

    expect(ws.inputFrames().map((f) => f.d)).toEqual(['y']);
  });
});

describe("the tile's onData tells the controller only about what a human typed", () => {
  /** A keystroke xterm refused: a keydown, then the committed `insertText` it did not forward. */
  const orphan = (term: FakeTerminal, data: string) => {
    term.keyHandler!({ type: 'keydown', key: 'Unidentified', keyCode: 65 });
    term.textarea.fire('input', { inputType: 'insertText', data, isComposing: false });
  };

  it('recovers a refused insertText through a query reply and a focus report, to this tile', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const { tile, ws, term } = await connectTile(app);
    expect((tile as ControllerTile)._keyCode229Recovery).not.toBeNull();
    ws.open();

    orphan(term, 'x');
    term.type('\x1b[?1;2c'); // a DA reply xterm answers on its own: dropped, and not "xterm spoke"
    term.type('\x1b[I'); // a focus report: sent ephemeral, and not "xterm spoke" either
    vi.advanceTimersByTime(1);

    const frames = ws.inputFrames();
    expect(frames.map((f) => f.d)).toEqual(['\x1b[I', 'x']);
    const recovered = frames.find((f) => f.d === 'x')!;
    expect(Number.isInteger(recovered.seq)).toBe(true);
    expect(app._pendingDeliveries.get('s-tile')?.map((r) => r.data)).toEqual(['x']);
  });

  it("never counts the controller's own recovered bytes as xterm's: two refused inserts after one keydown both arrive", async () => {
    // Pins WHERE the notify lives: in the onData lambda, not in _onTerminalData(), which the
    // recovered bytes also go through. Counted there, the first recovery would read as "xterm
    // spoke" for the second candidate, which shares its keydown snapshot, and drop it.
    vi.useFakeTimers();
    const { ws, term } = await connectTile(makeApp());
    ws.open();

    term.keyHandler!({ type: 'keydown', key: 'Unidentified', keyCode: 65 });
    term.textarea.fire('input', { inputType: 'insertText', data: 'a', isComposing: false });
    term.textarea.fire('input', { inputType: 'insertText', data: 'b', isComposing: false });
    vi.advanceTimersByTime(1);

    expect(ws.inputFrames().map((f) => f.d)).toEqual(['a', 'b']);
  });

  it('stands down when xterm really did deliver the keystroke', async () => {
    vi.useFakeTimers();
    const { ws, term } = await connectTile(makeApp());
    ws.open();

    orphan(term, 'x');
    term.type('x'); // xterm's own canonical emission for this keystroke
    vi.advanceTimersByTime(1);

    expect(ws.inputFrames().map((f) => f.d)).toEqual(['x']);
  });
});

describe('the controller can never break a tile', () => {
  type FakeController = {
    handleKeyEvent: ReturnType<typeof vi.fn>;
    notifyCanonicalData: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  let saved: unknown;
  beforeEach(() => {
    saved = windowStub.CodemanKeyCode229Recovery;
  });
  afterEach(() => {
    windowStub.CodemanKeyCode229Recovery = saved;
  });

  const fakeController = (overrides: Partial<FakeController> = {}): FakeController => ({
    handleKeyEvent: vi.fn(),
    notifyCanonicalData: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  });

  it('a create() that throws leaves the tile connected and typing', async () => {
    windowStub.CodemanKeyCode229Recovery = {
      create: () => {
        throw new Error('broken');
      },
    };
    const { tile, ws, term } = await connectTile(makeApp());
    expect((tile as ControllerTile)._keyCode229Recovery).toBeNull();
    ws.open();

    term.type('a');

    expect(ws.inputFrames().map((f) => f.d)).toEqual(['a']);
  });

  it("a handleKeyEvent that throws leaves every one of the tile's key gates working", async () => {
    const controller = fakeController({
      handleKeyEvent: vi.fn(() => {
        throw new Error('broken');
      }),
    });
    windowStub.CodemanKeyCode229Recovery = { create: () => controller };
    const { term } = await connectTile(makeApp());

    expect(term.keyHandler!({ type: 'keydown', key: '1', code: 'Digit1', altKey: true })).toBe(false);
    expect(term.keyHandler!({ type: 'keydown', key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(false);
    expect(term.keyHandler!({ type: 'keydown', key: 'Unidentified', keyCode: 229 })).toBe(true);
    expect(term.keyHandler!({ type: 'keydown', key: 'a', code: 'KeyA', keyCode: 65 })).toBe(true);
    // It still ran first, for every one of them.
    expect(controller.handleKeyEvent).toHaveBeenCalledTimes(4);
  });

  it('a destroy() that throws still lets the tile dispose its xterm', async () => {
    const controller = fakeController({
      destroy: vi.fn(() => {
        throw new Error('broken');
      }),
    });
    windowStub.CodemanKeyCode229Recovery = { create: () => controller };
    const { tile, term } = await connectTile(makeApp());
    const dispose = vi.spyOn(term, 'dispose');

    tile.destroy();

    expect(controller.destroy).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((tile as ControllerTile)._keyCode229Recovery).toBeNull();
  });

  it('each tile gets its own controller on its own textarea, and destroys only its own', async () => {
    const made: Array<{ options: { textarea: unknown }; controller: FakeController }> = [];
    windowStub.CodemanKeyCode229Recovery = {
      create: (options: { textarea: unknown }) => {
        const controller = fakeController();
        made.push({ options, controller });
        return controller;
      },
    };
    const app = makeApp();
    const a = await connectTile(app);
    const b = await connectTile(app);

    expect(made).toHaveLength(2);
    expect(made[0].options.textarea).toBe(a.term.textarea);
    expect(made[1].options.textarea).toBe(b.term.textarea);

    a.tile.destroy();

    expect(made[0].controller.destroy).toHaveBeenCalledTimes(1);
    expect(made[1].controller.destroy).not.toHaveBeenCalled();
  });
});

describe('terminal-tile.js keeps the controller call where it works (source pin)', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-tile.js'), 'utf8');

  it('calls handleKeyEvent ABOVE the IME early return, so a 229 keydown reaches it', () => {
    const call = source.indexOf('this._keyCode229Recovery?.handleKeyEvent?.(ev)');
    const earlyReturn = source.indexOf("ev.key === 'Process' || ev.keyCode === 229) return true");
    expect(call).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(call).toBeLessThan(earlyReturn);
  });

  it("hands the controller this tile's own composition helper", () => {
    expect(source).toMatch(/getCompositionHelper:\s*\(\)\s*=>\s*this\.terminal\?\._core\?\._compositionHelper/);
  });
});
