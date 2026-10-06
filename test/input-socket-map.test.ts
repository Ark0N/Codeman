/**
 * @fileoverview The durable input layer delivers over ANY registered terminal
 * socket, not only the primary one (`_inputSocketFor`, app.js).
 *
 * The exactly-once queue (`_sendInputAsync` → `_reliableSend` → `_drainSession`,
 * ACKed by `{t:'ia'}`, swept by `_redeliverSweep`) used to read the single
 * primary socket (`this._ws` / `this._wsSessionId`) directly. A second terminal
 * bound to another session (the split pane's Pane B, later a grid tile) had no
 * way in, so its keystrokes went out as seq-less frames with no ACK, no retry
 * and no idle-alert acknowledgement. These tests pin the seam: a registered
 * socket gets seq frames, its ACK lands on ITS session's queue, a stale
 * registration can never evict the socket that replaced it, and the sweep
 * judges a socket's silence by that socket's own last frame.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), like input-send-order.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadCodemanAppClass() {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
    document: { addEventListener: vi.fn() },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();

type Frame = { t: string; d: string; seq?: number; cid?: string };
type FakeSocket = { readyState: number; send: (data: string) => void; close: ReturnType<typeof vi.fn> };
type Handle = { ws: FakeSocket; lastRecvAt: number };
type Rec = { seq: number; data: string; sentAt: number; tries: number };

type App = {
  _sendInputAsync: (sessionId: string, input: string, opts?: { useMux?: boolean }) => void;
  _sendInputEphemeral: (sessionId: string, input: string) => void;
  _inputSocketFor: (sessionId: string) => { ws: FakeSocket; lastRecvAt: number } | null;
  _registerInputSocket: (sessionId: string, handle: Handle) => void;
  _unregisterInputSocket: (sessionId: string, handle: Handle) => void;
  _onWsInputAck: (seq: number, msg: Record<string, unknown>, sessionId?: string) => void;
  _onWsReady: (sessionId: string) => void;
  _redeliverSweep: () => void;
  _pendingDeliveries: Map<string, Rec[]>;
  _seqCounters: Map<string, number>;
  _ws: FakeSocket | null;
  _wsSessionId: string | null;
  _wsLastRecvAt: number;
  _reliableAckTimeoutMs: number;
  markIdleAlertSeen: ReturnType<typeof vi.fn>;
};

function makeApp(): App {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as App & Record<string, unknown>;
  app._clientId = 'c-test';
  app._seqCounters = new Map();
  app._pendingDeliveries = new Map();
  app._postDraining = new Set();
  app._persistReliableState = vi.fn();
  app._persistReliableNow = vi.fn();
  app._updateConnectionIndicator = vi.fn();
  app.markIdleAlertSeen = vi.fn();
  app.activeSessionId = 'primary';
  app._ws = null;
  app._wsSessionId = null;
  app._wsLastRecvAt = 0;
  app._reliableAckTimeoutMs = 4000;
  return app as unknown as App;
}

function fakeSocket(frames: Frame[]): FakeSocket {
  return { readyState: 1, send: (d: string) => frames.push(JSON.parse(d) as Frame), close: vi.fn() };
}

describe('a registered second socket joins the exactly-once queue', () => {
  it('delivers seq-tagged frames over the registered socket for its session', () => {
    const app = makeApp();
    const primaryFrames: Frame[] = [];
    const tileFrames: Frame[] = [];
    app._ws = fakeSocket(primaryFrames);
    app._wsSessionId = 'primary';
    app._registerInputSocket('other', { ws: fakeSocket(tileFrames), lastRecvAt: 0 });

    app._sendInputAsync('other', 'x');
    app._sendInputAsync('other', 'y');

    expect(tileFrames.map((f) => [f.d, f.seq, f.cid])).toEqual([
      ['x', 1, 'c-test'],
      ['y', 2, 'c-test'],
    ]);
    // Nothing for the other session leaks onto the primary socket.
    expect(primaryFrames).toEqual([]);
  });

  it('still prefers the primary socket for the primary session', () => {
    const app = makeApp();
    const primaryFrames: Frame[] = [];
    app._ws = fakeSocket(primaryFrames);
    app._wsSessionId = 'primary';

    app._sendInputAsync('primary', 'a');

    expect(primaryFrames.map((f) => f.d)).toEqual(['a']);
  });

  it('ignores a registered socket that is not OPEN (falls back to POST)', async () => {
    const app = makeApp();
    const posts: Array<{ input: string; seq: number }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    });
    const closing = { ...fakeSocket([]), readyState: 3 };
    app._registerInputSocket('other', { ws: closing, lastRecvAt: 0 });

    expect(app._inputSocketFor('other')).toBeNull();
    app._sendInputAsync('other', 'z');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(posts.map((p) => [p.input, p.seq])).toEqual([['z', 1]]);
  });

  it('routes ephemeral input over the registered socket too', () => {
    const app = makeApp();
    const tileFrames: Frame[] = [];
    app._registerInputSocket('other', { ws: fakeSocket(tileFrames), lastRecvAt: 0 });

    app._sendInputEphemeral('other', '\x1b[<64;1;1M');

    expect(tileFrames).toEqual([{ t: 'i', d: '\x1b[<64;1;1M' }]);
  });
});

describe('ACK routing', () => {
  it('drops the record from the queue of the session the ACK arrived for', () => {
    const app = makeApp();
    app._ws = fakeSocket([]);
    app._wsSessionId = 'primary';
    app._registerInputSocket('other', { ws: fakeSocket([]), lastRecvAt: 0 });
    app._sendInputAsync('primary', 'p');
    app._sendInputAsync('other', 'o');

    // Both sessions issued seq 1. The ACK names no session, so the socket's own
    // session decides which queue it drains; the primary's must be untouched.
    app._onWsInputAck(1, { t: 'ia', seq: 1 }, 'other');

    expect(app._pendingDeliveries.get('other')).toBeUndefined();
    expect(app._pendingDeliveries.get('primary')?.map((r) => r.data)).toEqual(['p']);
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('other');
  });

  it('defaults to the primary socket session when no session is passed', () => {
    const app = makeApp();
    app._ws = fakeSocket([]);
    app._wsSessionId = 'primary';
    app._sendInputAsync('primary', 'p');

    app._onWsInputAck(1, { t: 'ia', seq: 1 });

    expect(app._pendingDeliveries.get('primary')).toBeUndefined();
  });

  it('re-sends everything pending over a freshly registered socket on ready', () => {
    const app = makeApp();
    const first: Frame[] = [];
    const firstHandle = { ws: fakeSocket(first), lastRecvAt: 0 };
    app._registerInputSocket('other', firstHandle);
    app._sendInputAsync('other', 'a');
    expect(first.map((f) => f.d)).toEqual(['a']);

    // The socket dies without an ACK; a replacement opens and asks for a flush.
    firstHandle.ws.readyState = 3;
    const second: Frame[] = [];
    app._registerInputSocket('other', { ws: fakeSocket(second), lastRecvAt: 0 });
    app._onWsReady('other');

    expect(second.map((f) => [f.d, f.seq])).toEqual([['a', 1]]);
  });
});

describe('registration ownership', () => {
  it('a stale handle cannot unregister the socket that replaced it', () => {
    const app = makeApp();
    const oldHandle = { ws: fakeSocket([]), lastRecvAt: 0 };
    const newFrames: Frame[] = [];
    const newHandle = { ws: fakeSocket(newFrames), lastRecvAt: 0 };
    app._registerInputSocket('other', oldHandle);
    app._registerInputSocket('other', newHandle);

    // The old socket's close lands late and tries to clean up after itself.
    app._unregisterInputSocket('other', oldHandle);

    app._sendInputAsync('other', 'still-here');
    expect(newFrames.map((f) => f.d)).toEqual(['still-here']);
  });

  it('the owning handle does unregister', () => {
    const app = makeApp();
    const handle = { ws: fakeSocket([]), lastRecvAt: 0 };
    app._registerInputSocket('other', handle);
    app._unregisterInputSocket('other', handle);

    expect(app._inputSocketFor('other')).toBeNull();
  });

  it('stamps lastRecvAt at registration so a fresh socket never looks silent', () => {
    const app = makeApp();
    const handle = { ws: fakeSocket([]), lastRecvAt: 0 };
    const before = Date.now();
    app._registerInputSocket('other', handle);

    expect(handle.lastRecvAt).toBeGreaterThanOrEqual(before);
  });
});

describe('the redelivery sweep judges each socket by its own last frame', () => {
  function staleRecord(app: App, sessionId: string) {
    const rec = app._pendingDeliveries.get(sessionId)![0];
    rec.sentAt = Date.now() - (app._reliableAckTimeoutMs + 1000);
  }

  it('force-closes a silent registered socket with a stale record', () => {
    const app = makeApp();
    const handle = { ws: fakeSocket([]), lastRecvAt: 0 };
    app._registerInputSocket('other', handle);
    app._sendInputAsync('other', 'a');
    staleRecord(app, 'other');
    handle.lastRecvAt = Date.now() - (app._reliableAckTimeoutMs + 1000);
    // The primary socket is chatty; that must not vouch for the other one.
    app._ws = fakeSocket([]);
    app._wsSessionId = 'primary';
    app._wsLastRecvAt = Date.now();

    app._redeliverSweep();

    expect(handle.ws.close).toHaveBeenCalledTimes(1);
    expect(app._ws.close).not.toHaveBeenCalled();
  });

  it('re-drives (does not close) a registered socket that is still receiving', () => {
    const app = makeApp();
    const frames: Frame[] = [];
    const handle = { ws: fakeSocket(frames), lastRecvAt: 0 };
    app._registerInputSocket('other', handle);
    app._sendInputAsync('other', 'a');
    staleRecord(app, 'other');
    handle.lastRecvAt = Date.now();
    // A SILENT primary must not condemn the live registered socket either.
    app._wsLastRecvAt = 0;

    app._redeliverSweep();

    expect(handle.ws.close).not.toHaveBeenCalled();
    expect(frames.map((f) => f.d)).toEqual(['a', 'a']);
  });
});
