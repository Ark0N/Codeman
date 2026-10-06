/**
 * @fileoverview While the tile grid is open the main terminal is PARKED.
 *
 * Opening the grid (tile-grid.js `openTileGrid`) runs `_cleanupPreviousSession`
 * once, which closes the main terminal's socket, and hides `.terminal-wrap`.
 * With that socket closed `_wsReady` is false, so every SSE terminal handler
 * would start writing the FOCUSED tile's output into the hidden xterm (they all
 * key on `activeSessionId`), refetch captures for it, or reopen its socket onto
 * a session a tile already shows. One predicate, `_tilesOwnTerminal()`, turns
 * each of them into a no-op. This suite enumerates them, and checks each one
 * BOTH ways (grid open: stands aside; grid closed: acts), so none can pass
 * vacuously:
 *
 * - `_onSessionTerminal`, `_onSessionClearTerminal`, `_onSessionNeedsRefresh`
 *   (returns false, never undefined), `_scheduleDroppedOutputRecovery`;
 * - the `terminal.writeln` in `_onSessionCompletion` / `_onSessionError`;
 * - `retryConnection` and `handleInit` (which reconnect the main socket):
 *   they re-arm the TILES instead, and handleInit keeps live tiles;
 * - the backstops `sendResize`, `_maybeRefetchFullHistory`;
 * - the WebGL long-task observer, which watches the WHOLE page: tile renders
 *   must not count toward the main terminal's sticky WebGL disable;
 * - the header connection state, derived from the tile sockets.
 *
 * Plus the park and unpark themselves: one cleanup on enter; on exit every
 * tile destroyed, `_lastResizeDims` reset, the main terminal's cached content
 * for EVERY tiled id invalidated, and the focused session replayed fresh.
 *
 * Real code: constants.js + app.js + terminal-ui.js + tile-grid.js in one `vm`
 * context, with a small fake DOM and a fake TerminalTile. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Just enough DOM for tile-grid.js: elements with classes, children, styles and listeners. */
class FakeEl {
  id = '';
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: unknown) => void>> = {};
  classList = {
    add: (...names: string[]) => names.forEach((n) => this._setClass(n, true)),
    remove: (...names: string[]) => names.forEach((n) => this._setClass(n, false)),
    toggle: (n: string, on?: boolean) => this._setClass(n, on ?? !this.classList.contains(n)),
    contains: (n: string) => this.className.split(/\s+/).includes(n),
  };
  _setClass(name: string, on: boolean) {
    const set = new Set(this.className.split(/\s+/).filter(Boolean));
    if (on) set.add(name);
    else set.delete(name);
    this.className = [...set].join(' ');
    return on;
  }
  appendChild(child: FakeEl) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeEl, ref: FakeEl | null) {
    child.remove();
    child.parentElement = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(child);
    else this.children.splice(i, 0, child);
    return child;
  }
  get nextSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener() {}
  getBoundingClientRect() {
    return { width: 2400, height: 1200 };
  }
  querySelector() {
    return null;
  }
}

const main = new FakeEl();
main.className = 'main';
const wrap = new FakeEl();
wrap.className = 'terminal-wrap';
main.appendChild(wrap);
const section = new FakeEl();
section.id = 'tileGrid';
section.className = 'tile-grid';
main.appendChild(section);

const documentStub = {
  addEventListener: vi.fn(),
  documentElement: { dataset: {} },
  createElement: () => new FakeEl(),
  getElementById: (id: string) => (id === 'tileGrid' ? section : null),
  querySelector: (sel: string) => (sel === '.main' ? main : sel === '.terminal-wrap' ? wrap : null),
  querySelectorAll: () => [],
};

/** A TerminalTile stand-in: records what the grid asks of it. */
class FakeTile {
  static all: FakeTile[] = [];
  _wsReady = false;
  _stoppedCode: number | null = null;
  _destroyed = false;
  fontSize: number | null;
  terminal = { focus: vi.fn(), options: { fontSize: 0 } as Record<string, unknown> };
  connect = vi.fn(async () => {});
  reconnectNow = vi.fn();
  fit = vi.fn();
  destroy = vi.fn(() => {
    this._destroyed = true;
  });
  constructor(
    public sessionId: string,
    public mountEl: FakeEl,
    public opts: Record<string, unknown>
  ) {
    this.fontSize = (opts.fontSize as number) ?? null;
    FakeTile.all.push(this);
  }
}

let observerCallback: ((list: { getEntries(): unknown[] }) => void) | null = null;
let clock = 100_000;
const localStore = new Map<string, string>();

const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
const windowStub: Record<string, unknown> = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  CodemanBase: { base: '' },
  innerWidth: 2400,
  innerHeight: 1200,
};
const context = vm.createContext({
  console: { ...console, log: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  performance: { now: () => clock },
  setInterval: vi.fn(),
  clearInterval: vi.fn(),
  setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
  requestAnimationFrame: vi.fn(),
  requestIdleCallback: vi.fn(),
  HTMLCanvasElement: class HTMLCanvasElement {},
  WebSocket: { OPEN: 1 },
  PerformanceObserver: class {
    constructor(cb: (list: { getEntries(): unknown[] }) => void) {
      observerCallback = cb;
    }
    observe() {}
    disconnect() {}
  },
  fetch: vi.fn(),
  navigator: { onLine: true },
  location: { protocol: 'http:', host: 'codeman.test', pathname: '/', search: '', hash: '' },
  document: documentStub,
  localStorage: {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => localStore.set(k, String(v)),
    removeItem: (k: string) => localStore.delete(k),
  },
  window: windowStub,
  VoiceInput: { cleanup: vi.fn() },
  MobileDetection: { isTouchDevice: () => false, isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
});
vm.runInContext(
  `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\n${read('tile-grid.js')}\n` +
    'globalThis.__CodemanApp = CodemanApp;',
  context
);
windowStub.TerminalTile = FakeTile;
windowStub.TileLoadQueue = class {
  schedule(_t: unknown, _k: string, run: () => Promise<void>) {
    return run();
  }
  drop() {}
};
const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;

type App = Record<string, any>;

const IDS = ['s-a', 's-b', 's-c'];

function makeApp(): App {
  const app = Object.create(CodemanApp.prototype) as App;
  app.sessions = new Map(
    [...IDS, 's-other'].map((id) => [id, { id, name: id, mode: 'claude', pid: 1, workingDir: '/w' }])
  );
  app.sessionOrder = ['s-other', ...IDS];
  app.detachedSessions = new Set();
  app.isSoloWindow = false;
  app.activeSessionId = 's-a';
  app._selectGeneration = 0;
  app._initGeneration = 1;
  app._xtermSnapshots = new Map();
  app.terminalBufferCache = new Map();
  app._pendingDeliveries = new Map();
  app._closingSessions = new Set();
  app.pendingHooks = new Map();
  app.isOnline = true;
  app._connectionStatus = 'connected';
  app._wsState = 'disconnected';
  app._lastResizeDims = { cols: 100, rows: 30 };
  app.terminal = { writeln: vi.fn(), clear: vi.fn(), focus: vi.fn(), options: { fontSize: 14 } };
  // Everything around the grid that is not under test here.
  for (const name of [
    '_cleanupPreviousSession',
    'hideWelcome',
    'showWelcome',
    'markIdleAlertSeen',
    'renderSessionTabs',
    '_updateActiveTabImmediate',
    '_refreshSessionPanels',
    '_updateSseSubscription',
    '_updateConnectionIndicator',
    '_activateFileBrowserSession',
    '_hideWebviewLayer',
    'closeSessionSidebarOnHandheld',
    'updateAttachmentHistoryBadge',
    'refreshHostWakeBanner',
    'selectSession',
    'batchTerminalWrite',
    '_connectWs',
    '_geometryForResizeRequest',
    'updateCost',
    '_notifySession',
    'connectSSE',
    '_updateConnectionLossUi',
  ]) {
    app[name] = vi.fn();
  }
  app._fetchTerminalCapture = vi.fn(async () => ({ json: { data: {} }, headersAt: 0 }));
  app.loadAppSettingsFromStorage = () => ({});
  return app;
}

beforeEach(() => {
  FakeTile.all = [];
  localStore.clear();
  windowStub.innerWidth = 2400;
  section.children = [];
  main.className = 'main';
});

describe('parking the main terminal', () => {
  it('opening parks it ONCE and puts a tile per session in its place, focused tile active', () => {
    const app = makeApp();
    expect(app.openTileGrid(IDS, { focusedId: 's-b' })).toBe(true);

    expect(app._cleanupPreviousSession).toHaveBeenCalledTimes(1);
    expect(main.classList.contains('tiles-active')).toBe(true);
    expect(FakeTile.all.map((t) => t.sessionId)).toEqual(IDS);
    expect(FakeTile.all.every((t) => t.connect.mock.calls.length === 1)).toBe(true);
    expect(app.activeSessionId).toBe('s-b');
    expect(app._tilesOwnTerminal()).toBe(true);
    // Grid tiles: the one load queue, the smaller scrollback, a bounded load.
    expect(FakeTile.all[0].opts).toMatchObject({ scrollback: 10000, boundedLoad: true });
    expect(typeof FakeTile.all[0].opts.scheduleLoad).toBe('function');
  });

  it('the focused tile connects first, so its capture leads the queue', () => {
    const app = makeApp();
    const order: string[] = [];
    app.openTileGrid(IDS, { focusedId: 's-c' });
    for (const t of FakeTile.all) order.push(`${t.sessionId}:${t.connect.mock.invocationCallOrder[0]}`);
    const first = FakeTile.all.reduce((a, b) =>
      a.connect.mock.invocationCallOrder[0] < b.connect.mock.invocationCallOrder[0] ? a : b
    );
    expect(first.sessionId).toBe('s-c');
  });

  it('refuses below the desktop width, in a solo window, and with no live session', () => {
    const narrow = makeApp();
    windowStub.innerWidth = 1179;
    expect(narrow.openTileGrid(IDS)).toBe(false);
    windowStub.innerWidth = 2400;

    const solo = makeApp();
    solo.isSoloWindow = true;
    expect(solo.openTileGrid(IDS)).toBe(false);

    const none = makeApp();
    expect(none.openTileGrid(['gone'])).toBe(false);
    expect(none._cleanupPreviousSession).not.toHaveBeenCalled();
  });

  it('never tiles a detached session', () => {
    const app = makeApp();
    app.detachedSessions.add('s-b');
    app.openTileGrid(IDS);
    expect(FakeTile.all.map((t) => t.sessionId)).toEqual(['s-a', 's-c']);
  });

  it('closing destroys every tile and replays the focused session fresh in the single view', () => {
    const app = makeApp();
    app.openTileGrid(IDS, { focusedId: 's-b' });
    app.closeTileGrid();

    expect(FakeTile.all.every((t) => t.destroy.mock.calls.length === 1)).toBe(true);
    expect(main.classList.contains('tiles-active')).toBe(false);
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(app._lastResizeDims).toBeNull();
    expect(app.selectSession).toHaveBeenCalledWith('s-b', { forceReload: true, auto: true });
  });

  it("closing invalidates the main terminal's cached content for EVERY tiled id, and only those", () => {
    const app = makeApp();
    for (const id of [...IDS, 's-other']) {
      app._xtermSnapshots.set(id, 'old');
      app.terminalBufferCache.set(id, 'old');
      localStore.set(`codeman-xs-${id}`, 'old');
    }
    app.openTileGrid(IDS);
    app.closeTileGrid();

    for (const id of IDS) {
      expect(app._xtermSnapshots.has(id)).toBe(false);
      expect(app.terminalBufferCache.has(id)).toBe(false);
      expect(localStore.has(`codeman-xs-${id}`)).toBe(false);
    }
    expect(app._xtermSnapshots.get('s-other')).toBe('old');
    expect(localStore.get('codeman-xs-s-other')).toBe('old');
  });

  it('closing with reselect: false leaves the next selection to the caller', () => {
    const app = makeApp();
    app.openTileGrid(IDS);
    app.closeTileGrid({ reselect: false });
    expect(app.selectSession).not.toHaveBeenCalled();
  });
});

/** An app with the grid open on IDS (focus s-a), or closed, for the paired guard checks. */
function appWithGrid(open: boolean) {
  const app = makeApp();
  if (open) app.openTileGrid(IDS);
  return app;
}

describe('guards: each stands aside while tiles own the terminal, and acts otherwise', () => {
  it.each([true, false])('_onSessionTerminal (grid open: %s)', (open) => {
    const app = appWithGrid(open);
    app.pendingWrites = [];
    app._onSessionTerminal({ id: 's-a', data: 'output' });
    expect(app.batchTerminalWrite).toHaveBeenCalledTimes(open ? 0 : 1);
  });

  it.each([true, false])('_onSessionNeedsRefresh (grid open: %s)', async (open) => {
    const app = appWithGrid(open);
    const result = await app._onSessionNeedsRefresh({ id: 's-a' });
    if (open) expect(result).toBe(false);
    expect(app._fetchTerminalCapture).toHaveBeenCalledTimes(open ? 0 : 1);
  });

  it.each([true, false])('_onSessionClearTerminal (grid open: %s)', async (open) => {
    const app = appWithGrid(open);
    app._resetTerminalForReplay = vi.fn();
    app.sendResize = vi.fn();
    await app._onSessionClearTerminal({ id: 's-a' });
    expect(app._fetchTerminalCapture).toHaveBeenCalledTimes(open ? 0 : 1);
  });

  it.each([true, false])('_scheduleDroppedOutputRecovery (grid open: %s)', (open) => {
    const app = appWithGrid(open);
    app._scheduleDroppedOutputRecovery('s-a', 0, 1024);
    expect(!!app._clientDropRecoveryTimer).toBe(!open);
    clearTimeout(app._clientDropRecoveryTimer);
  });

  it.each([true, false])(
    '_onSessionCompletion writes into the main terminal only when it is not parked (open: %s)',
    (open) => {
      const app = appWithGrid(open);
      app.totalCost = 0;
      app._onSessionCompletion({ id: 's-a', cost: 0.5 });
      expect(app.terminal.writeln).toHaveBeenCalledTimes(open ? 0 : 2);
      expect(app.totalCost).toBe(0.5);
    }
  );

  it.each([true, false])(
    '_onSessionError writes into the main terminal only when it is not parked (open: %s)',
    (open) => {
      const app = appWithGrid(open);
      app._onSessionError({ id: 's-a', error: 'boom' });
      expect(app.terminal.writeln).toHaveBeenCalledTimes(open ? 0 : 1);
      // The notification is not the terminal's: it fires either way.
      expect(app._notifySession).toHaveBeenCalledTimes(1);
    }
  );

  it.each([true, false])('retryConnection re-arms the tiles, never the parked main socket (open: %s)', (open) => {
    const app = appWithGrid(open);
    app.retryConnection();
    clearTimeout(app._offlineRetryTimer);
    expect(app._connectWs).toHaveBeenCalledTimes(open ? 0 : 1);
    if (open) expect(FakeTile.all.every((t) => t.reconnectNow.mock.calls.length === 1)).toBe(true);
  });

  it.each([true, false])('sendResize backstop (grid open: %s)', async (open) => {
    const app = appWithGrid(open);
    expect(await app.sendResize('s-a')).toBe(false);
    expect(app._geometryForResizeRequest).toHaveBeenCalledTimes(open ? 0 : 1);
  });

  it.each([true, false])('_maybeRefetchFullHistory backstop (grid open: %s)', async (open) => {
    const app = appWithGrid(open);
    app._fullHistoryRepullAt = new Map();
    app._fullHistoryRepullUseless = new Set();
    app._fetchTerminalCapture = vi.fn(async () => {
      throw new Error('stop here');
    });
    await app._maybeRefetchFullHistory().catch(() => {});
    expect(app._fetchTerminalCapture).toHaveBeenCalledTimes(open ? 0 : 1);
  });

  it.each([true, false])(
    'the WebGL long-task observer counts nothing while tiles own the terminal (open: %s)',
    (open) => {
      const app = appWithGrid(open);
      app._webglAddon = { dispose: vi.fn() };
      app._webglLongTaskObserver = null;
      app._disableWebGLSticky = vi.fn();
      app._scheduleTerminalRepaint = vi.fn();
      app._installWebGLLongTaskGuard();
      clock += 60_000; // past the install grace period
      const longTasks = [0, 1, 2].map((i) => ({ duration: 400, startTime: clock - 100 * i }));
      observerCallback?.({ getEntries: () => longTasks });
      expect(app._disableWebGLSticky).toHaveBeenCalledTimes(open ? 0 : 1);
    }
  );
});

describe('handleInit with the grid open (SSE back after a server restart)', () => {
  function init(app: App, liveIds: string[]) {
    app._initGeneration = 1; // gen > 1 on this call: a reconnect, not a page load
    app._resetAllAppState = vi.fn(() => app.sessions.clear());
    for (const name of [
      '_clearTimer',
      '_updateCjkInputState',
      'syncSessionOrder',
      '_loadTabLayout',
      'cleanupAllFloatingWindows',
      'startSystemStatsPolling',
      'stopSystemStatsPolling',
    ]) {
      app[name] = vi.fn();
    }
    app.$ = () => null;
    app._onSessionNeedsRefresh = vi.fn(async () => false);
    app.handleInit({
      sessions: liveIds.map((id) => ({ id, name: id, mode: 'claude', pid: 1 })),
      scheduledRuns: [],
    });
  }

  it('keeps live tiles (never rebuilt), reconnects them now, and never touches the main socket', () => {
    const app = appWithGrid(true);
    const before = [...FakeTile.all];
    init(app, [...IDS, 's-other']);

    expect(FakeTile.all).toEqual(before);
    expect(before.every((t) => t.destroy.mock.calls.length === 0)).toBe(true);
    expect(before.every((t) => t.reconnectNow.mock.calls.length === 1)).toBe(true);
    expect(app._connectWs).not.toHaveBeenCalled();
    expect(app._onSessionNeedsRefresh).not.toHaveBeenCalled();
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.activeSessionId).toBe('s-a');
  });

  it('removes the tile of a session that did not come back and focuses a live one', () => {
    const app = appWithGrid(true);
    init(app, ['s-b', 's-c', 's-other']);

    const tileA = FakeTile.all.find((t) => t.sessionId === 's-a');
    expect(tileA?.destroy).toHaveBeenCalledTimes(1);
    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.activeSessionId).toBe('s-b');
    expect(app._connectWs).not.toHaveBeenCalled();
  });

  it('leaves an active web tab alone when the focused tile is still live (no re-select on every SSE blip)', () => {
    const app = appWithGrid(true);
    app.activeWebviewId = 'w1';
    app._hideWebviewLayer.mockClear();
    init(app, [...IDS, 's-other']);
    expect(app._hideWebviewLayer).not.toHaveBeenCalled();
    expect(app.activeSessionId).toBe('s-a');
  });

  it('without the grid, the same reconnect resyncs the main terminal (the guard is what differs)', () => {
    const app = appWithGrid(false);
    init(app, [...IDS, 's-other']);
    expect(app._connectWs).toHaveBeenCalledWith('s-a');
  });
});

describe('the header connection state follows the tile sockets', () => {
  it('reads connected only when every live tile socket is open; a stopped tile does not count', () => {
    const app = appWithGrid(true);
    // The main socket is parked on purpose; it must not decide the header.
    app._wsState = 'disconnected';
    for (const t of FakeTile.all) t._wsReady = true;
    expect(app._computeConnectionDescriptor().dotClass).toBe('connection-dot connected');

    FakeTile.all[1]._wsReady = false;
    expect(app._computeConnectionDescriptor().dotClass).toBe('connection-dot reconnecting');

    FakeTile.all[1]._stoppedCode = 4009;
    expect(app._computeConnectionDescriptor().dotClass).toBe('connection-dot connected');
  });
});

describe('panes and fonts while the grid is open', () => {
  it('_focusedPane() is the focused tile even when DOM focus left every terminal', () => {
    const app = appWithGrid(true);
    app._noteFocusedTile(null);
    const pane = app._focusedPane();
    expect(pane.isPrimary).toBe(false);
    expect(pane.sessionId).toBe('s-a');
  });

  it('_forEachTile reaches every grid tile; { grid: false } skips them', () => {
    const app = appWithGrid(true);
    const seen: string[] = [];
    app._forEachTile((t: FakeTile) => seen.push(t.sessionId));
    expect(seen).toEqual(IDS);
    const none: string[] = [];
    app._forEachTile((t: FakeTile) => none.push(t.sessionId), { grid: false });
    expect(none).toEqual([]);
  });

  it('Ctrl +/- sizes the tiles (their own per-device font), refitting each, not the main terminal', () => {
    const app = appWithGrid(true);
    app.setFontSize = vi.fn();
    app.increaseFontSize();
    expect(app.setFontSize).not.toHaveBeenCalled();
    expect(localStore.get('codeman-tile-font-size')).toBe('15');
    expect(FakeTile.all.every((t) => t.terminal.options.fontSize === 15 && t.fit.mock.calls.length > 0)).toBe(true);
  });
});
