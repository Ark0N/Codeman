/**
 * @fileoverview A detached session's pane is sized by its own window, not by
 * the dashboard.
 *
 * One PTY holds one size. When a session is popped out, the dashboard keeps it
 * active and keeps measuring it, but the dashboard's terminal is narrower than
 * the popup because the session rail takes width the popup does not have. Both
 * windows sizing the same pane makes the CLI draw frames that fit neither, and
 * the popup shows the result as a garbled frame.
 *
 * `sendResize` therefore returns early for a session this window has marked
 * detached, and the debounced window-resize handler skips it for the same
 * reason. A solo window is exempt: it IS the owner. `_maybeRefetchFullHistory`
 * already stood aside on the same condition, so this follows a rule the code
 * had already established.
 *
 * ⚠️ It returns early BEFORE the local fit, not after (issue #464). The earlier
 * rule was "withhold the send, never the reflow", which leaves this window's
 * xterm at a shape the PTY was never told about — and a CLI computes its
 * repaints from the shape it was told, so that reflow bought a garbled frame
 * rather than a correct one. Withhold both, or neither.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts), the same way terminal-buffer-flush
 * extracts the real mixin methods from terminal-ui.js.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** The mixin runs inside the vm context, so its `fetch` must live there too. */
let currentFetch: ReturnType<typeof vi.fn> = vi.fn();

function loadTerminalMixin(): Record<string, unknown> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1600 },
    document: { addEventListener: vi.fn() },
    fetch: (...args: unknown[]) => currentFetch(...args),
  });
  vm.runInContext(source, context);
  return FakeCodemanApp.prototype;
}

const mixin = loadTerminalMixin();

const SESSION = 'session-A';

function makeApp(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async () => ({ json: async () => ({ data: { changed: true } }) }));
  currentFetch = fetchMock;
  const app = {
    sendResize: mixin.sendResize,
    // The real chain: sendResize fits, floors and applies through one function
    // now, so the harness must let it (#464).
    syncTerminalGeometry: mixin.syncTerminalGeometry,
    _geometryForResizeRequest: mixin._geometryForResizeRequest,
    _resizeTerminalTo: mixin._resizeTerminalTo,
    // Real, so a geometry change really does re-check whether the terminal now
    // overflows its container (#464 item 4) — the fake DOM has no container, so
    // it measures nothing and settles on "no overflow", which is the truth here.
    _scheduleOverflowAffordanceSync: mixin._scheduleOverflowAffordanceSync,
    _syncTerminalOverflowAffordance: mixin._syncTerminalOverflowAffordance,
    _onPtyGeometryReport: vi.fn(),
    getTerminalDimensions: () => ({ cols: 120, rows: 40 }),
    terminal: { cols: 120, rows: 40, resize: vi.fn() },
    fitAddon: { fit: vi.fn() },
    detachedSessions: new Set<string>(),
    isSoloWindow: false,
    _lastResizeDims: null as { cols: number; rows: number } | null,
    _wsReady: false,
    _wsSessionId: null as string | null,
    ...overrides,
  } as Record<string, unknown> & { sendResize: (id: string, o?: object) => Promise<boolean> };
  return { app, fetchMock };
}

describe('detached sessions own their pane size', () => {
  it('the dashboard does not resize a session showing in its own window', async () => {
    const { app, fetchMock } = makeApp();
    (app.detachedSessions as Set<string>).add(SESSION);
    const changed = await app.sendResize(SESSION);

    expect(changed).toBe(false);
    // No request: the popup's size stands on the server.
    expect(fetchMock).not.toHaveBeenCalled();
    // ⚠️ REVERSED by issue #464, deliberately. This used to assert that the
    // LOCAL fit still ran — "withhold the send, never the reflow" — on the
    // reasoning that it keeps the dashboard's own xterm correct. It does not:
    // it leaves this xterm at a shape the PTY was never told about, and Claude
    // Code computes every repaint from the shape it WAS told, so the frames
    // land on rows nothing erased. The popup that owns the PTY is drawing for
    // its own width either way, so the dashboard's reflow was a reflow nothing
    // was rendering for. Withholding the resize means withholding all of it.
    expect((app.fitAddon as { fit: ReturnType<typeof vi.fn> }).fit).not.toHaveBeenCalled();
    expect((app.terminal as { resize: ReturnType<typeof vi.fn> }).resize).not.toHaveBeenCalled();
  });

  it('the solo window still sizes the session it displays', async () => {
    const { app, fetchMock } = makeApp({ isSoloWindow: true });
    (app.detachedSessions as Set<string>).add(SESSION);
    await app.sendResize(SESSION);

    // The popup is the owner, so being marked detached must not stop it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((app.fitAddon as { fit: ReturnType<typeof vi.fn> }).fit).toHaveBeenCalled();
  });

  it('the dashboard resizes a session that is not detached', async () => {
    const { app, fetchMock } = makeApp();
    await app.sendResize(SESSION);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * `_redock` lives on the CodemanApp class rather than the terminal mixin, so it
 * needs app.js loaded. Same `vm` approach as terminal-flush-budget.test.ts.
 */
function loadAppClass() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance: { now: () => 0 },
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
  });
  const constants = readFileSync(resolve(dir, 'constants.js'), 'utf8');
  const appSource = readFileSync(resolve(dir, 'app.js'), 'utf8');
  vm.runInContext(`${constants}\n${appSource}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: { prototype: Record<string, unknown> } }).__CodemanApp;
}

describe('redock takes the sizing back', () => {
  const CodemanApp = loadAppClass();

  function makeDashboard(activeSessionId: string | null) {
    const app = Object.create(CodemanApp.prototype) as Record<string, any>;
    app.detachedSessions = new Set([SESSION]);
    app.detachedWindows = new Map();
    app._detachWatchTimers = new Map();
    app._redockGrace = new Map();
    app._detachOrphanStrikes = new Map();
    app.sessions = new Map([[SESSION, { id: SESSION }]]);
    app.activeSessionId = activeSessionId;
    app._lastResizeDims = { cols: 120, rows: 40 };
    app.$ = () => null;
    app.sendResize = vi.fn(() => Promise.resolve(true));
    return app;
  }

  it('clears the stale dimensions so the next send reports truthfully', () => {
    // The popup sized the pane while it owned the session, so this window's one
    // global record of "what the PTY holds" is wrong. Left in place, the next
    // sendResize returns "unchanged" and selectSession skips its redraw wait.
    const app = makeDashboard(SESSION);
    app._redock(SESSION);
    expect(app._lastResizeDims).toBeNull();
  });

  it('clears them even when the redocked session is not the active one', () => {
    // Pop out A, switch to B, close the popup: no resize is due, but the stale
    // record still has to go or selecting A later lies about it.
    const app = makeDashboard('some-other-session');
    app._redock(SESSION);
    expect(app._lastResizeDims).toBeNull();
    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('re-asserts this window size for the session it is showing', () => {
    const app = makeDashboard(SESSION);
    app._redock(SESSION);
    expect(app.sendResize).toHaveBeenCalledWith(SESSION, { force: true });
    // Un-marked first, or the yield in sendResize would swallow the re-assert.
    expect(app.detachedSessions.has(SESSION)).toBe(false);
  });

  it('sends nothing for a session that is gone', () => {
    // _onSessionDeleted redocks before cleanup, so the id can already be dead;
    // the resize would be a guaranteed 404.
    const app = makeDashboard(SESSION);
    app.sessions.delete(SESSION);
    app._redock(SESSION);
    expect(app.sendResize).not.toHaveBeenCalled();
  });
});
