/**
 * @fileoverview Regression tests for the header connection indicator
 * (`CodemanApp._updateConnectionIndicator`) and the invariant that updating it
 * never aborts durable input delivery.
 *
 * Guards two regressions from the upstream v1.1.15 merge (fixed in COD-133):
 *   1. The indicator body referenced an undefined `transport` object, throwing
 *      `ReferenceError: transport is not defined` on every queued state. Because
 *      `_reliableSend()` calls `_updateConnectionIndicator()` *before*
 *      `_drainSession()`, the throw skipped immediate delivery on every keystroke
 *      → input only flushed on the 2s sweep (large typing lag) and the indicator
 *      never rendered (missing "WS" status).
 *   2. The restored body only read the SSE `_connectionStatus`, so it never
 *      surfaced the terminal WebSocket transport ("WS" / "HTTP"), and it flashed
 *      "sending 1B" on every single keystroke.
 *
 * COD-136 (perf, no behavior change) extracts the pure render into
 * `_computeConnectionDescriptor()` and makes `_updateConnectionIndicator()`
 * early-return when that descriptor is byte-identical to the last render — so
 * fast typing stops doing redundant DOM writes on the hot input path. The
 * `_computeConnectionDescriptor` block below pins the exact rendered strings per
 * state (so a future refactor can't silently relabel), and the unchanged-skip
 * block asserts the DOM is written once across two identical calls and re-written
 * when state changes.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — see input-send-order.test.ts).
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

function fakeElement() {
  return { style: { display: '' }, title: '', textContent: '', className: '' };
}

type Indicator = {
  $: (id: string) => unknown;
  _pendingDeliveries: Map<string, Array<{ seq: number; data: string }>>;
  _connectionStatus: string;
  _wsState: string;
  activeSessionId: string | null;
  isOnline: boolean;
  _updateConnectionIndicator: () => void;
};

function makeApp(overrides: Partial<Indicator> & { queuedBytes?: number } = {}) {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as Indicator & {
    queuedBytes?: number;
  };
  const els: Record<string, ReturnType<typeof fakeElement>> = {
    connectionIndicator: fakeElement(),
    connectionDot: fakeElement(),
    connectionText: fakeElement(),
  };
  app.$ = (id: string) => els[id];
  app._pendingDeliveries = new Map();
  app._connectionStatus = 'connected';
  app._wsState = 'disconnected';
  app.activeSessionId = null;
  app.isOnline = true;
  Object.assign(app, overrides);
  const queued = overrides.queuedBytes ?? 0;
  if (queued > 0) {
    app._pendingDeliveries.set('s1', [{ seq: 1, data: 'x'.repeat(queued) }]);
  }
  return { app, els };
}

describe('connection indicator — transport display', () => {
  it('shows "WS" with a connected dot when the terminal WebSocket is open', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected' });
    app._updateConnectionIndicator();
    expect(els.connectionIndicator.style.display).toBe('flex');
    expect(els.connectionText.textContent).toBe('WS');
    expect(els.connectionDot.className).toContain('connected');
  });

  it('shows "HTTP" with a fallback dot when the socket dropped to HTTP POST', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'fallback' });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('HTTP');
    expect(els.connectionDot.className).toContain('fallback');
  });

  it('shows "WS…" while connecting or reconnecting the socket', () => {
    for (const state of ['connecting', 'reconnecting']) {
      const { app, els } = makeApp({ activeSessionId: 's1', _wsState: state });
      app._updateConnectionIndicator();
      expect(els.connectionText.textContent).toBe('WS…');
      expect(els.connectionDot.className).toContain('reconnecting');
    }
  });

  it('shows "Offline" when the browser reports no network', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', isOnline: false });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('Offline');
    expect(els.connectionDot.className).toContain('offline');
  });

  it('hides on an idle dashboard (no active session, healthy stream, no queue)', () => {
    const { app, els } = makeApp({ activeSessionId: null, _connectionStatus: 'connected' });
    app._updateConnectionIndicator();
    expect(els.connectionIndicator.style.display).toBe('none');
  });

  it('surfaces SSE reconnecting on the dashboard when there is no active terminal', () => {
    const { app, els } = makeApp({ activeSessionId: null, _connectionStatus: 'reconnecting' });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toContain('Reconnecting');
    expect(els.connectionDot.className).toContain('reconnecting');
  });
});

describe('connection indicator — keystroke backlog threshold', () => {
  it('does NOT annotate a single-keystroke (1B) queue — no "sending 1B" flicker', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 1 });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('WS');
    expect(els.connectionText.textContent).not.toMatch(/queued/);
  });

  it('does NOT annotate at the 4B threshold boundary', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 4 });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('WS');
  });

  it('annotates a genuine backlog (>4B) with a queued byte count once it has persisted', () => {
    const { app, els } = makeApp({
      activeSessionId: 's1',
      _wsState: 'connected',
      queuedBytes: 40,
      // The backlog has been above the threshold for well over the hold.
      _backlogOverSince: Date.now() - 5000,
    } as never);
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toMatch(/^WS · 40B queued$/);
    app._pendingDeliveries.clear();
    app._updateConnectionIndicator(); // drains: clears the hold timer
  });
});

// A paste, an IME commit or a fast word is a few dozen bytes for a few milliseconds until its ACK
// lands. Showing " · NB queued" for that made the "WS" pill widen and shrink on every burst.
describe('connection indicator — a brief burst does not widen the pill', () => {
  it('keeps the plain "WS" while a >4B burst is still inside the hold window', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 40 });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('WS');
    app._pendingDeliveries.clear();
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('WS');
  });

  it('forgets the burst when it drains, so a later one starts a fresh hold', () => {
    const { app } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 40 });
    app._updateConnectionIndicator();
    expect((app as unknown as { _backlogOverSince: number | null })._backlogOverSince).not.toBeNull();
    app._pendingDeliveries.clear();
    app._updateConnectionIndicator();
    expect((app as unknown as { _backlogOverSince: number | null })._backlogOverSince).toBeNull();
    expect((app as unknown as { _backlogHoldTimer: unknown })._backlogHoldTimer).toBeNull();
  });

  it('schedules the re-render for when the hold elapses, with no keystroke or ACK needed', () => {
    const { app } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 40 });
    app._updateConnectionIndicator();
    expect((app as unknown as { _backlogHoldTimer: unknown })._backlogHoldTimer).not.toBeNull();
    app._pendingDeliveries.clear();
    app._updateConnectionIndicator(); // cancels it
  });

  it('shows the count once the same backlog has stayed up past the hold', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 40 });
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('WS');
    (app as unknown as { _backlogOverSince: number })._backlogOverSince = Date.now() - 1500;
    app._updateConnectionIndicator();
    expect(els.connectionText.textContent).toBe('WS · 40B queued');
    app._pendingDeliveries.clear();
    app._updateConnectionIndicator();
  });
});

describe('connection indicator — never throws (the ReferenceError regression)', () => {
  it('renders every transport × stream × queue combination without throwing', () => {
    const wsStates = ['disconnected', 'connecting', 'connected', 'reconnecting', 'fallback'];
    const sseStates = ['connected', 'connecting', 'reconnecting', 'disconnected', 'offline'];
    for (const ws of wsStates) {
      for (const sse of sseStates) {
        for (const active of ['s1', null] as const) {
          for (const queuedBytes of [0, 1, 4, 200]) {
            for (const isOnline of [true, false]) {
              const { app } = makeApp({
                activeSessionId: active,
                _wsState: ws,
                _connectionStatus: sse,
                isOnline,
                queuedBytes,
              });
              expect(() => app._updateConnectionIndicator()).not.toThrow();
            }
          }
        }
      }
    }
  });
});

describe('durable input delivery is not aborted by the indicator (typing-lag regression)', () => {
  it('_reliableSend reaches _drainSession after updating the indicator', () => {
    const { app } = makeApp({ activeSessionId: 's1', _wsState: 'connected' });
    const a = app as unknown as {
      _seqCounters: Map<string, number>;
      _persistReliableState: () => void;
      _drainSession: (id: string) => void;
      _reliableSend: (id: string, data: string, useMux: boolean) => void;
    };
    a._seqCounters = new Map();
    a._persistReliableState = vi.fn();
    const drain = vi.fn();
    a._drainSession = drain;

    // A single keystroke. The indicator runs first; if it throws, drain is skipped.
    a._reliableSend('s1', 'x', false);

    expect(drain).toHaveBeenCalledWith('s1');
    expect(app._pendingDeliveries.get('s1')).toHaveLength(1);
  });
});

// ---- COD-136: pure descriptor + cache-skip on the hot input path --------------

type Descriptor = { display: string; dotClass: string; text: string; title: string };

type DescriptorApp = Indicator & {
  _computeConnectionDescriptor: () => Descriptor;
  _lastIndicatorDescriptor: Descriptor | null;
};

function computeApp(overrides: Partial<Indicator> & { queuedBytes?: number } = {}) {
  const { app } = makeApp(overrides);
  return app as unknown as DescriptorApp;
}

describe('_computeConnectionDescriptor — pure render per state (COD-136)', () => {
  it('offline dominates everything (even an active connected terminal)', () => {
    const app = computeApp({ activeSessionId: 's1', _wsState: 'connected', isOnline: false });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'flex',
      dotClass: 'connection-dot offline',
      text: 'Offline',
      title: 'No network connection',
    });
  });

  it('active terminal — connected → WS', () => {
    const app = computeApp({ activeSessionId: 's1', _wsState: 'connected' });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'flex',
      dotClass: 'connection-dot connected',
      text: 'WS',
      title: 'Terminal connected over WebSocket',
    });
  });

  it('active terminal — fallback → HTTP', () => {
    const app = computeApp({ activeSessionId: 's1', _wsState: 'fallback' });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'flex',
      dotClass: 'connection-dot fallback',
      text: 'HTTP',
      title: 'WebSocket unavailable — input sent over HTTP',
    });
  });

  it('active terminal — reconnecting → WS…', () => {
    const app = computeApp({ activeSessionId: 's1', _wsState: 'reconnecting' });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'flex',
      dotClass: 'connection-dot reconnecting',
      text: 'WS…',
      title: 'Reconnecting WebSocket',
    });
  });

  it('active terminal — connecting (default branch) → WS…', () => {
    const app = computeApp({ activeSessionId: 's1', _wsState: 'connecting' });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'flex',
      dotClass: 'connection-dot reconnecting',
      text: 'WS…',
      title: 'Connecting WebSocket',
    });
  });

  it('active terminal — a queued backlog (>4B) adds the " · …KB queued" suffix', () => {
    const app = computeApp({ activeSessionId: 's1', _wsState: 'connected', queuedBytes: 2048 });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'flex',
      dotClass: 'connection-dot connected',
      text: 'WS · 2.0KB queued',
      title: 'Terminal connected over WebSocket',
    });
  });

  it('no terminal, SSE reconnecting → Reconnecting...', () => {
    const app = computeApp({ activeSessionId: null, _connectionStatus: 'reconnecting' });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'flex',
      dotClass: 'connection-dot reconnecting',
      text: 'Reconnecting...',
      title: 'Reconnecting to server',
    });
  });

  it('idle dashboard, healthy stream, no queue → hidden (display:none, others normalized to "")', () => {
    const app = computeApp({ activeSessionId: null, _connectionStatus: 'connected' });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'none',
      dotClass: '',
      text: '',
      title: '',
    });
  });

  it('idle dashboard with a small queue (≤4B) → draining "Sending..."', () => {
    const app = computeApp({ activeSessionId: null, _connectionStatus: 'connected', queuedBytes: 2 });
    expect(app._computeConnectionDescriptor()).toEqual({
      display: 'flex',
      dotClass: 'connection-dot draining',
      text: 'Sending...',
      title: 'Delivering queued input',
    });
  });
});

describe('connection-dot CSS — every emitted dot class has a styles.css rule', () => {
  // The descriptor emits these dot variants; each needs a visible rule or the
  // 8px dot renders as an invisible blob (the base .connection-dot rule has no
  // background). 'connected' and 'fallback' were missing when this PR shipped.
  const DOT_CLASSES = ['connected', 'fallback', 'offline', 'reconnecting', 'draining'];
  const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');

  for (const cls of DOT_CLASSES) {
    it(`.connection-dot.${cls} is styled`, () => {
      const rule = new RegExp(`\\.connection-dot\\.${cls}\\s*\\{[^}]*background`, 'm');
      expect(css).toMatch(rule);
    });
  }
});

/** A DOM element fake that COUNTS each property write — used to detect the skip. */
function countingElement() {
  const writes = { display: 0, className: 0, textContent: 0, title: 0 };
  let _display = '';
  let _className = '';
  let _textContent = '';
  let _title = '';
  return {
    writes,
    style: {
      get display() {
        return _display;
      },
      set display(v: string) {
        _display = v;
        writes.display++;
      },
    },
    get className() {
      return _className;
    },
    set className(v: string) {
      _className = v;
      writes.className++;
    },
    get textContent() {
      return _textContent;
    },
    set textContent(v: string) {
      _textContent = v;
      writes.textContent++;
    },
    get title() {
      return _title;
    },
    set title(v: string) {
      _title = v;
      writes.title++;
    },
  };
}

function makeCountingApp(overrides: Partial<Indicator> & { queuedBytes?: number } = {}) {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as DescriptorApp & {
    queuedBytes?: number;
  };
  const els = {
    connectionIndicator: countingElement(),
    connectionDot: countingElement(),
    connectionText: countingElement(),
  };
  app.$ = (id: string) => (els as Record<string, ReturnType<typeof countingElement>>)[id];
  app._pendingDeliveries = new Map();
  app._connectionStatus = 'connected';
  app._wsState = 'disconnected';
  app.activeSessionId = null;
  app.isOnline = true;
  app._lastIndicatorDescriptor = null;
  Object.assign(app, overrides);
  const queued = overrides.queuedBytes ?? 0;
  if (queued > 0) {
    app._pendingDeliveries.set('s1', [{ seq: 1, data: 'x'.repeat(queued) }]);
  }
  return { app, els };
}

describe('_updateConnectionIndicator — COD-136 unchanged-skip', () => {
  it('writes the DOM on the first call (cache starts null → renders)', () => {
    const { app, els } = makeCountingApp({ activeSessionId: 's1', _wsState: 'connected' });
    app._updateConnectionIndicator();
    expect(els.connectionIndicator.style.display).toBe('flex');
    expect(els.connectionDot.className).toBe('connection-dot connected');
    expect(els.connectionText.textContent).toBe('WS');
    expect(els.connectionText.writes.textContent).toBe(1);
  });

  it('skips redundant DOM writes when the descriptor is unchanged across two calls', () => {
    const { app, els } = makeCountingApp({ activeSessionId: 's1', _wsState: 'connected' });

    app._updateConnectionIndicator(); // first render
    const before = {
      display: els.connectionIndicator.writes.display,
      className: els.connectionDot.writes.className,
      textContent: els.connectionText.writes.textContent,
      title: els.connectionIndicator.writes.title,
    };

    app._updateConnectionIndicator(); // identical state → must early-return, no writes

    expect(els.connectionIndicator.writes.display).toBe(before.display);
    expect(els.connectionDot.writes.className).toBe(before.className);
    expect(els.connectionText.writes.textContent).toBe(before.textContent);
    expect(els.connectionIndicator.writes.title).toBe(before.title);
  });

  it('re-renders when state changes between calls (WS → HTTP)', () => {
    const { app, els } = makeCountingApp({ activeSessionId: 's1', _wsState: 'connected' });

    app._updateConnectionIndicator(); // WS
    const writesAfterFirst = els.connectionText.writes.textContent;

    app._wsState = 'fallback';
    app._updateConnectionIndicator(); // HTTP — must write again

    expect(els.connectionText.writes.textContent).toBe(writesAfterFirst + 1);
    expect(els.connectionText.textContent).toBe('HTTP');
    expect(els.connectionDot.className).toBe('connection-dot fallback');
  });

  it('re-renders display when the hidden→shown transition occurs (none → flex)', () => {
    const { app, els } = makeCountingApp({ activeSessionId: null, _connectionStatus: 'connected' });

    app._updateConnectionIndicator(); // hidden (display:none)
    expect(els.connectionIndicator.style.display).toBe('none');
    const displayWrites = els.connectionIndicator.writes.display;

    app.activeSessionId = 's1';
    app._wsState = 'connected';
    app._updateConnectionIndicator(); // now shown

    expect(els.connectionIndicator.writes.display).toBe(displayWrites + 1);
    expect(els.connectionIndicator.style.display).toBe('flex');
    expect(els.connectionText.textContent).toBe('WS');
  });
});

describe('connection indicator — the backlog tracking never throws on the input path', () => {
  it('still renders when the queue cannot be read', () => {
    const { app, els } = makeApp({ activeSessionId: 's1', _wsState: 'connected' });
    (app as unknown as { _pendingBytes: () => never })._pendingBytes = () => {
      throw new Error('no queue');
    };
    // The compute reads the queue too, so stub it as the real hot path would see a healthy one.
    (app as unknown as { _computeConnectionDescriptor: () => unknown })._computeConnectionDescriptor = () => ({
      display: 'flex',
      dotClass: 'connection-dot connected',
      text: 'WS',
      title: 'Terminal connected over WebSocket',
    });
    expect(() => app._updateConnectionIndicator()).not.toThrow();
    expect(els.connectionText.textContent).toBe('WS');
  });
});
