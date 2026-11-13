/**
 * @fileoverview SSE connect timeout: an EventSource whose first request never
 * gets response headers sits in CONNECTING forever without firing `open` or
 * `error` (a resumed phone on a VPN, a proxy that accepted the TCP connection
 * and went silent). The staleness watchdog (test/sse-staleness.test.ts) cannot
 * see it, because it only judges a stream that is already 'connected'. So
 * `connectSSE()` bounds every attempt: if `open` has not fired within
 * `_sseConnectTimeoutMs`, the attempt is closed and retried through the same
 * backoff path `onerror` uses.
 *
 * Real code: constants.js + app.js in a `vm` context with a fake EventSource
 * and vitest fake timers. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
  }
}

const navigatorStub = { onLine: true };
const windowStub: Record<string, unknown> = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
const context = vm.createContext({
  console: { ...console, log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  performance: { now: () => 0 },
  setInterval: () => 0,
  clearInterval: () => {},
  // Resolved at call time so vitest's fake timers (installed per test) apply.
  setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
  HTMLCanvasElement: class {},
  EventSource: FakeEventSource,
  URLSearchParams,
  navigator: navigatorStub,
  location: { protocol: 'http:', host: 'codeman.test', pathname: '/', search: '', hash: '' },
  document: {
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { dataset: {} },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  window: windowStub,
  MobileDetection: { isTouchDevice: () => false, isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
});
vm.runInContext(`${read('constants.js')}\n${read('app.js')}\nglobalThis.__CodemanApp = CodemanApp;`, context);
const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type App = Record<string, any>;

function makeApp(): App {
  const app = Object.create(CodemanApp.prototype) as App;
  app._clientId = 'client-1';
  app.activeSessionId = null;
  app.reconnectAttempts = 0;
  app.maxReconnectAttempts = 10;
  app.sseReconnectTimeout = null;
  app._sseListenerCleanup = null;
  app._sseStaleWatchdog = null;
  app._sseLastMessageAt = 0;
  app._nextSseRetryAt = null;
  app.eventSource = null;
  // What the constructor seeds (the policy constant lives in constants.js).
  app._sseConnectTimeout = null;
  app._sseConnectTimeoutMs = (windowStub.CodemanSseStale as { CONNECT_TIMEOUT_MS?: number }).CONNECT_TIMEOUT_MS;
  app.statuses = [] as string[];
  app.setConnectionStatus = vi.fn((s: string) => app.statuses.push(s));
  app._updateConnectionLossUi = vi.fn();
  return app;
}

const TIMEOUT = 15000;

describe('SSE connect timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.all = [];
    navigatorStub.onLine = true;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('defaults to 15s', () => {
    expect((windowStub.CodemanSseStale as { CONNECT_TIMEOUT_MS?: number }).CONNECT_TIMEOUT_MS).toBe(TIMEOUT);
    const app = makeApp();
    app.connectSSE();
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(FakeEventSource.all[0].closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all[0].closed).toBe(true);
  });

  it('closes an attempt that never opens and retries it through the normal backoff', () => {
    const app = makeApp();
    app.connectSSE();
    const first = FakeEventSource.all[0];
    vi.advanceTimersByTime(TIMEOUT);

    expect(first.closed).toBe(true);
    expect(app.eventSource).toBe(null);
    expect(app.reconnectAttempts).toBe(1);
    expect(app.statuses.at(-1)).toBe('reconnecting');
    // Feeds the connection-loss UI countdown, same as onerror.
    expect(app._nextSseRetryAt).toBeGreaterThan(0);
    expect(app._updateConnectionLossUi).toHaveBeenCalled();

    // First retry uses the fast 200ms backoff step.
    vi.advanceTimersByTime(199);
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(app.eventSource).toBe(FakeEventSource.all[1]);
  });

  it('keeps retrying each hung attempt, with backoff growing', () => {
    const app = makeApp();
    app.connectSSE();
    vi.advanceTimersByTime(TIMEOUT + 200); // attempt 1 times out, attempt 2 starts
    vi.advanceTimersByTime(TIMEOUT + 500); // attempt 2 times out, attempt 3 starts
    expect(FakeEventSource.all).toHaveLength(3);
    expect(app.reconnectAttempts).toBe(2);
    expect(FakeEventSource.all.slice(0, 2).every((es) => es.closed)).toBe(true);
  });

  it('an attempt that opens is never timed out', () => {
    const app = makeApp();
    app.connectSSE();
    vi.advanceTimersByTime(1000);
    FakeEventSource.all[0].open();
    vi.advanceTimersByTime(TIMEOUT * 4);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(FakeEventSource.all[0].closed).toBe(false);
    expect(app.reconnectAttempts).toBe(0);
  });

  it('an attempt that errors is retried once, not again by its timeout', () => {
    const app = makeApp();
    app.connectSSE();
    FakeEventSource.all[0].fail();
    expect(app.reconnectAttempts).toBe(1);
    vi.advanceTimersByTime(200);
    expect(FakeEventSource.all).toHaveLength(2);
    FakeEventSource.all[1].open();
    vi.advanceTimersByTime(TIMEOUT * 4);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.all[1].closed).toBe(false);
    expect(app.reconnectAttempts).toBe(0);
  });

  it('a reconnect replaces the pending timer instead of stacking a second one', () => {
    const app = makeApp();
    app.connectSSE();
    vi.advanceTimersByTime(10000);
    app.connectSSE(); // e.g. the user pressed Retry
    expect(FakeEventSource.all).toHaveLength(2);
    // The first attempt's deadline passes: nothing may happen to the second.
    vi.advanceTimersByTime(TIMEOUT - 10000);
    expect(FakeEventSource.all[1].closed).toBe(false);
    expect(app.reconnectAttempts).toBe(0);
    // The second attempt's own deadline still applies.
    vi.advanceTimersByTime(10000);
    expect(FakeEventSource.all[1].closed).toBe(true);
    expect(app.reconnectAttempts).toBe(1);
  });

  it('a late error from a replaced EventSource leaves the connection that replaced it alone', () => {
    const app = makeApp();
    app.connectSSE();
    const first = FakeEventSource.all[0];
    app.connectSSE(); // e.g. the user pressed Retry
    const second = FakeEventSource.all[1];
    // A browser that still fires onerror on the closed first attempt.
    first.fail();
    expect(app.eventSource).toBe(second);
    expect(second.closed).toBe(false);
    expect(app.reconnectAttempts).toBe(0);
    // No retry was scheduled, and the second attempt keeps its own deadline.
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(second.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(second.closed).toBe(true);
    expect(app.reconnectAttempts).toBe(1);
  });

  it('connectSSE() while offline cancels the pending timer (the online event reconnects)', () => {
    const app = makeApp();
    app.connectSSE();
    navigatorStub.onLine = false;
    app.connectSSE();
    expect(app.statuses.at(-1)).toBe('offline');
    vi.advanceTimersByTime(TIMEOUT * 4);
    expect(app.reconnectAttempts).toBe(0);
    expect(app.statuses.at(-1)).toBe('offline');
  });

  it('does not retry a connection that opened but whose open callback has not run yet', () => {
    const app = makeApp();
    app.connectSSE();
    FakeEventSource.all[0].readyState = FakeEventSource.OPEN;
    vi.advanceTimersByTime(TIMEOUT);
    expect(FakeEventSource.all[0].closed).toBe(false);
    expect(app.reconnectAttempts).toBe(0);
  });

  it('honours a shrunk _sseConnectTimeoutMs (what a browser test sets)', () => {
    const app = makeApp();
    app._sseConnectTimeoutMs = 500;
    app.connectSSE();
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.all[0].closed).toBe(true);
  });
});
