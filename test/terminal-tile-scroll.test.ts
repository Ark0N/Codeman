/**
 * @fileoverview A TerminalTile pages a hollow buffer's CLI transcript, and
 * reports a plain click to a CLI whose mouse DECSETs the server strips, the way
 * the primary pane does (#555), through the primary pane's own gates aimed at
 * the TILE: its terminal, its session, never the active one.
 *
 * opencode draws in place on the alternate screen, so tmux keeps no history
 * for it and the browser's buffer holds one screen. The primary pane turns the
 * wheel into PageUp/PageDown there (`_maybePageCliTranscript`, terminal-ui.js);
 * a tile left the wheel to xterm, which scrolled nothing. #555 also strips
 * opencode's mouse DECSETs on the server, which reaches tile sockets too: a
 * drag selects text again, but xterm's own encoder no longer reports a click,
 * so the tile now hand-encodes it like the primary pane.
 *
 * A tile's buffer is rarely empty above the screen even so: its first capture
 * is taken at the PTY's previous, taller size and written into a shorter
 * xterm, and its own row-shrinking fits push more rows up. Those rows are not
 * history, so the tile discounts them (`_localRows`); the overflow cases below
 * fail without that discount.
 *
 * Real code under test: constants.js + app.js + terminal-ui.js +
 * terminal-tile.js in one `vm` context, as in terminal-tile-input.test.ts.
 * xterm, the fit addon and WebSocket are fakes (test/mocks/terminal-tile-fakes.ts),
 * with the fake xterm's row emulation switched on.
 *
 * Port: none (no server, no browser).
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

type Session = { mode: string; cliVersion?: string; cliMouseTracking?: boolean };
type App = Record<string, unknown> & {
  sessions: Map<string, Session>;
  activeSessionId: string | null;
  _linkHovered?: boolean;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
};

function makeApp(sessions: Record<string, Session>, activeSessionId: string | null = 'other'): App {
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
  app.loadAppSettingsFromStorage = () => ({});
  app._ws = null;
  app._wsSessionId = null;
  app._estimateReplayRows = (text: string) => text.split('\n').length;
  app.sessions = new Map(Object.entries(sessions));
  app.activeSessionId = activeSessionId;
  return app;
}

/** The tile's mount element: records its listeners by type, with their options. */
function makeMount() {
  const listeners: Record<string, Array<{ fn: (ev: unknown) => void; opts: unknown }>> = {};
  return {
    listeners,
    addEventListener: vi.fn((type: string, fn: (ev: unknown) => void, opts?: unknown) => {
      (listeners[type] ||= []).push({ fn, opts });
    }),
    removeEventListener: vi.fn(),
    fire(type: string, ev: unknown) {
      for (const { fn } of listeners[type] || []) fn(ev);
    },
  };
}

type Tile = {
  connect(): Promise<void>;
  destroy(): void;
  fit(opts?: { force?: boolean }): void;
  ws: FakeSocket | null;
  sessionId: string;
  _linkHovered: boolean;
  _scrollFlushTimer: unknown;
  _onPtyGeometryReport(cols: number, rows: number): void;
};
const TerminalTile = windowStub.TerminalTile as new (id: string, mount: unknown, opts?: object) => Tile;

const liveTiles: Tile[] = [];

const lines = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`).join('\r\n');

/** The capture a tile's first load receives. `captureRows` absent = the server could not say. */
function serveCapture(terminalBuffer: string, captureRows?: number) {
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { terminalBuffer, ...(captureRows === undefined ? {} : { captureRows }) } }),
  }));
}

async function connectTile(app: App, opts: { sessionId?: string; mode?: string } = {}) {
  windowStub.app = app;
  const mount = makeMount();
  const tile = new TerminalTile(opts.sessionId ?? 's-tile', mount, { mode: opts.mode ?? 'opencode' });
  liveTiles.push(tile);
  await tile.connect();
  const ws = FakeSocket.instances.at(-1)!;
  ws.open();
  return { tile, ws, term: FakeTerminal.last!, mount };
}

function wheel(deltaY: number, extra: Record<string, unknown> = {}) {
  return {
    deltaY,
    deltaX: 0,
    deltaMode: 0,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  };
}

/** One wheel event worth `rowsOfTravel` lines (pixel mode: 25 px a line). */
const wheelLines = (rowsOfTravel: number, extra: Record<string, unknown> = {}) => wheel(rowsOfTravel * 25, extra);

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';

/** Frames the tile's socket sent once the 40 ms coalescer has flushed. */
function flushed(ws: FakeSocket) {
  vi.advanceTimersByTime(40);
  return ws.inputFrames();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeFit.proposed = { cols: 80, rows: 24 };
  FakeSocket.instances = [];
  FakeTerminal.emulateScroll = true;
  fetchMock.mockReset();
  serveCapture(lines(10), 24);
});

afterEach(() => {
  for (const tile of liveTiles.splice(0)) tile.destroy();
  FakeTerminal.emulateScroll = false;
  vi.useRealTimers();
});

describe('a tile pages a hollow buffer through the primary pane gates', () => {
  it('turns half a screen of wheel-up into one ephemeral PageUp on its own socket, and down into PageDown', async () => {
    const { ws, term, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    expect(term.buffer.active.baseY).toBe(0);

    const up = wheelLines(-term.rows / 2);
    mount.fire('wheel', up);

    expect(up.preventDefault).toHaveBeenCalled();
    expect(up.stopPropagation).toHaveBeenCalled();
    expect(ws.inputFrames()).toEqual([]); // coalesced, not sent per event
    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP }]); // no seq: never persisted

    mount.fire('wheel', wheelLines(term.rows / 2));
    expect(flushed(ws).at(-1)).toEqual({ t: 'i', d: PAGE_DOWN });
  });

  it("reads the TILE's session, not the active one", async () => {
    // Active session is a shell; the tile shows opencode: the tile still pages.
    const app = makeApp({ other: { mode: 'shell' }, 's-tile': { mode: 'opencode' } }, 'other');
    const { ws, mount } = await connectTile(app);

    mount.fire('wheel', wheelLines(-12));

    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP }]);
  });

  it.each(['shell', 'codex', 'antigravity'])(
    'leaves a %s tile to xterm even while the active session is opencode',
    async (mode) => {
      const app = makeApp({ other: { mode: 'opencode' }, 's-tile': { mode } }, 'other');
      const { ws, mount } = await connectTile(app, { mode });

      const ev = wheelLines(-12);
      mount.fire('wheel', ev);

      expect(ev.preventDefault).not.toHaveBeenCalled();
      expect(ev.stopPropagation).not.toHaveBeenCalled();
      expect(flushed(ws)).toEqual([]);
    }
  );

  it('still pulls history on a wheel-up at the top of a shell tile', async () => {
    const { mount } = await connectTile(makeApp({ 's-tile': { mode: 'shell' } }), { mode: 'shell' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the initial load

    mount.fire('wheel', wheelLines(-3));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('full=1&tail=');
  });

  it('never pages Shift, a tracking xterm, the alternate buffer, real history or a horizontal swipe', async () => {
    const { ws, term, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    const fireAndCheck = (ev: ReturnType<typeof wheel>) => {
      mount.fire('wheel', ev);
      expect(ev.preventDefault).not.toHaveBeenCalled();
      expect(ev.stopPropagation).not.toHaveBeenCalled();
    };

    fireAndCheck(wheelLines(-12, { shiftKey: true })); // the explicit "local scrollback" gesture

    term.modes.mouseTrackingMode = 'any'; // xterm's own encoder forwards the wheel
    fireAndCheck(wheelLines(-12));
    term.modes.mouseTrackingMode = 'none';

    term.buffer.active.type = 'alternate'; // xterm's alt-scroll owns it
    fireAndCheck(wheelLines(-12));
    term.buffer.active.type = 'normal';

    fireAndCheck(wheel(0, { deltaX: 120 })); // pure horizontal: nothing to page

    term.write(lines(40)); // real output scrolled real lines above the screen
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    fireAndCheck(wheelLines(-12));

    expect(flushed(ws)).toEqual([]);
  });
});

describe("the forwarding gate behaves as in the primary pane, for the tile's session", () => {
  it('leaves a fullscreen Claude tile to xterm (tiles do not forward SGR wheel yet)', async () => {
    const app = makeApp({ 's-tile': { mode: 'claude', cliVersion: '2.1.223', cliMouseTracking: true } });
    const { ws, mount } = await connectTile(app, { mode: 'claude' });

    const ev = wheelLines(-12);
    mount.fire('wheel', ev);

    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(flushed(ws)).toEqual([]);
  });

  it('pages that same tile under the "Wheel scrolls local history" opt-out (the footgun rescue)', async () => {
    const app = makeApp({ 's-tile': { mode: 'claude', cliVersion: '2.1.223', cliMouseTracking: true } });
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: true });
    const { ws, mount } = await connectTile(app, { mode: 'claude' });

    mount.fire('wheel', wheelLines(-12));

    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP }]);
  });

  it('pages a Claude tile whose CLI version is unknown', async () => {
    const { ws, mount } = await connectTile(makeApp({ 's-tile': { mode: 'claude', cliMouseTracking: true } }), {
      mode: 'claude',
    });

    mount.fire('wheel', wheelLines(-12));

    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP }]);
  });
});

describe('page-key travel, cap and coalescing', () => {
  beforeEach(() => {
    FakeFit.proposed = { cols: 80, rows: 36 };
  });

  it('accumulates sub-page travel: two wheels of 10 lines are one PageUp', async () => {
    const { ws, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));

    mount.fire('wheel', wheelLines(-10));
    expect(flushed(ws)).toEqual([]);
    mount.fire('wheel', wheelLines(-10));

    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP }]);
  });

  it('caps one wheel at three PageUps, in one frame', async () => {
    const { ws, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));

    mount.fire('wheel', wheelLines(-1000));

    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP.repeat(3) }]);
  });

  it('sends two pages queued within 40 ms as one frame', async () => {
    const { ws, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));

    mount.fire('wheel', wheelLines(-18));
    vi.advanceTimersByTime(20);
    mount.fire('wheel', wheelLines(-18));

    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP.repeat(2) }]);
  });

  it('sends exactly the bytes the primary pane sends for the same wheel sequence', async () => {
    const sequence = [-10, -10, -4, 30, -1000, 7, -18, 200].map((n) => wheelLines(n));
    const { ws, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    for (const ev of sequence) mount.fire('wheel', ev);
    const tileBytes = flushed(ws)
      .map((f) => f.d)
      .join('');

    const primary = makeApp({ other: { mode: 'opencode' } }, 'other') as App & {
      terminal: unknown;
      _maybePageCliTranscript(ev: unknown, lines: number): boolean;
      _wheelScrollLinesFloat(ev: unknown): number;
      _flushWheelSgrQueue(): void;
    };
    const sent: string[] = [];
    primary._sendInputEphemeral = (_id: string, data: string) => sent.push(data);
    primary.terminal = {
      rows: 36,
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { type: 'normal', baseY: 0, viewportY: 0 } },
    };
    for (const ev of sequence) primary._maybePageCliTranscript(ev, primary._wheelScrollLinesFloat(ev));
    primary._flushWheelSgrQueue();

    expect(tileBytes).not.toBe('');
    expect(tileBytes).toBe(sent.join(''));
  });
});

describe('rows the tile pushed above the screen itself are not history', () => {
  it('pages after a one-screen capture taken at a taller size (the first load)', async () => {
    serveCapture(lines(40), 40); // the PTY was 40 rows when it was captured
    const { ws, term, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    expect(term.buffer.active.baseY).toBe(16); // 40 lines into a 24-row xterm

    mount.fire('wheel', wheelLines(-12));

    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP }]);
  });

  it('does not page a capture that carried real history', async () => {
    serveCapture(lines(60), 24);
    const { ws, term, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    expect(term.buffer.active.baseY).toBeGreaterThan(0);

    const ev = wheelLines(-12);
    mount.fire('wheel', ev);

    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(flushed(ws)).toEqual([]);
  });

  it('falls back to the raw baseY when the server sent no captureRows', async () => {
    serveCapture(lines(40));
    const tall = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    expect(tall.term.buffer.active.baseY).toBe(16);
    tall.mount.fire('wheel', wheelLines(-12));
    expect(flushed(tall.ws)).toEqual([]);

    serveCapture(lines(10));
    const short = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    expect(short.term.buffer.active.baseY).toBe(0);
    short.mount.fire('wheel', wheelLines(-12));
    expect(flushed(short.ws)).toEqual([{ t: 'i', d: PAGE_UP }]);
  });

  it('keeps paging after a row-shrinking fit pushes more rows up', async () => {
    serveCapture(lines(40), 40);
    const { tile, ws, term, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));

    FakeFit.proposed = { cols: 80, rows: 20 }; // a zoom-out or a divider drag
    tile.fit();
    expect(term.buffer.active.baseY).toBe(20);

    mount.fire('wheel', wheelLines(-10));
    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP }]);
  });

  it('stops paging once output scrolls real lines above the screen', async () => {
    serveCapture(lines(40), 40);
    const { ws, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));

    ws.receive({ t: 'o', d: 'a\r\nb\r\nc\r\n' }); // three real lines scrolled off

    const ev = wheelLines(-12);
    mount.fire('wheel', ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(flushed(ws)).toEqual([]);
  });

  it('forgets the overflow on a server clear, so later real history counts', async () => {
    serveCapture(lines(40), 40);
    const { ws, term, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));

    ws.receive({ t: 'c' });
    expect(term.buffer.active.baseY).toBe(0);
    ws.receive({ t: 'o', d: '\r\n'.repeat(term.rows + 1) }); // two real lines above the screen
    expect(term.buffer.active.baseY).toBe(2);

    const ev = wheelLines(-12);
    mount.fire('wheel', ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(flushed(ws)).toEqual([]);
  });

  it('keeps paging when the PTY geometry report reflows the rows above the screen', async () => {
    serveCapture(lines(40), 40);
    const { tile, ws, term, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    // A narrower width wraps the overflow rows onto more rows, as xterm's reflow does.
    term.afterResize = () => {
      term.lineCount += 3;
      term.settleRows();
    };

    tile._onPtyGeometryReport(60, 40);
    expect(term.cols).toBe(60);
    expect(term.buffer.active.baseY).toBe(19);

    mount.fire('wheel', wheelLines(-12));
    expect(flushed(ws)).toEqual([{ t: 'i', d: PAGE_UP }]);
  });
});

describe('a tile reports a plain click to a CLI with mouse tracking on', () => {
  const click = (overrides: Record<string, unknown> = {}) => ({
    isTrusted: true,
    button: 0,
    detail: 1,
    // 10 + 8 * 20 + 1, 20 + 16 * 5 + 1 inside the tile's own screen: column 21, row 6.
    clientX: 171,
    clientY: 101,
    target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
    ...overrides,
  });
  const TAP = '\x1b[<0;21;6M\x1b[<0;21;6m';

  it("sends one seq-tagged SGR press+release on the tile's socket, from the tile's own geometry", async () => {
    const app = makeApp({ other: { mode: 'shell' }, 's-tile': { mode: 'opencode', cliMouseTracking: true } });
    const { ws, mount } = await connectTile(app);

    mount.fire('click', click());

    expect(ws.inputFrames().map((f) => [f.d, typeof f.seq])).toEqual([[TAP, 'number']]);
  });

  it('sends nothing without the flag, over a selection, over its own hovered link, or scrolled up', async () => {
    const app = makeApp({ 's-tile': { mode: 'opencode' } });
    const { tile, ws, term, mount } = await connectTile(app);

    mount.fire('click', click()); // the CLI has no tracking mode on
    app.sessions.set('s-tile', { mode: 'opencode', cliMouseTracking: true });

    term.selection = 'picked';
    mount.fire('click', click()); // a drag-selection just ended
    term.selection = '';

    tile._linkHovered = true;
    mount.fire('click', click()); // the link provider opens this one
    tile._linkHovered = false;

    term.buffer.active.baseY = 10;
    term.buffer.active.viewportY = 0;
    mount.fire('click', click()); // would hit-test a different row
    term.buffer.active.viewportY = 10;

    expect(ws.inputFrames()).toEqual([]);

    mount.fire('click', click()); // nothing in the way any more
    expect(ws.inputFrames().map((f) => f.d)).toEqual([TAP]);
  });

  it("is not blocked by the primary pane's own link hover", async () => {
    const app = makeApp({ 's-tile': { mode: 'opencode', cliMouseTracking: true } });
    app._linkHovered = true;
    const { ws, mount } = await connectTile(app);

    mount.fire('click', click());

    expect(ws.inputFrames().map((f) => f.d)).toEqual([TAP]);
  });

  it("follows the tile session's flag, never the active session's", async () => {
    const reported = await connectTile(
      makeApp({
        other: { mode: 'claude', cliMouseTracking: false },
        's-tile': { mode: 'opencode', cliMouseTracking: true },
      })
    );
    reported.mount.fire('click', click());
    expect(reported.ws.inputFrames().map((f) => f.d)).toEqual([TAP]);

    const silent = await connectTile(
      makeApp({
        other: { mode: 'claude', cliMouseTracking: true },
        's-tile': { mode: 'opencode', cliMouseTracking: false },
      })
    );
    silent.mount.fire('click', click());
    expect(silent.ws.inputFrames()).toEqual([]);
  });
});

describe('destroy()', () => {
  it('drops queued page keys and detaches both listeners it registered', async () => {
    const { tile, ws, mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));
    mount.fire('wheel', wheelLines(-12)); // queued, not yet flushed
    const wheelFn = mount.listeners.wheel[0].fn;
    const clickFn = mount.listeners.click[0].fn;

    tile.destroy();
    vi.advanceTimersByTime(100);

    expect(ws.inputFrames()).toEqual([]);
    expect(tile._scrollFlushTimer).toBeNull();
    expect(mount.removeEventListener).toHaveBeenCalledWith('wheel', wheelFn, { capture: true });
    expect(mount.removeEventListener).toHaveBeenCalledWith('click', clickFn);
  });

  it('registers the wheel listener non-passive in the capture phase and the click one in the bubble phase', async () => {
    const { mount } = await connectTile(makeApp({ 's-tile': { mode: 'opencode' } }));

    expect(mount.listeners.wheel.map((l) => l.opts)).toEqual([{ capture: true, passive: false }]);
    expect(mount.listeners.click.map((l) => l.opts)).toEqual([undefined]);
  });
});
