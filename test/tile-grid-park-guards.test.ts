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
 * Real code: constants.js + app.js + terminal-ui.js + terminal-split.js +
 * tile-grid.js in one `vm` context, with the shared fake DOM and fake
 * TerminalTile (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeTile,
  advanceClock,
  clockNow,
  flushFrames,
  localStore,
  main,
  makeGridApp,
  perfObserverCallbacks,
  resetGridHarness,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

type App = GridApp;

const IDS = ['s-a', 's-b', 's-c'];

/**
 * The shared app plus what these guards exercise: the REAL sendResize (the
 * harness stubs it), and spies on the main terminal's own paths.
 */
function makeApp(): App {
  const app = makeGridApp(IDS);
  delete app.sendResize;
  app._initGeneration = 1;
  app.isOnline = true;
  app._connectionStatus = 'connected';
  app._wsState = 'disconnected';
  app._lastResizeDims = { cols: 100, rows: 30 };
  for (const name of [
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
  return app;
}

beforeEach(() => {
  resetGridHarness();
});

describe('parking the main terminal', () => {
  it('opening takes no snapshot of a session that becomes a tile, and keeps it for one that does not', () => {
    // Closing the grid drops the snapshot of every tiled id, so one taken of a
    // tiled session at opening was always thrown away.
    const tiled = makeApp();
    tiled.openTileGrid(IDS);
    expect(tiled._cleanupPreviousSession).toHaveBeenCalledWith('s-a', { skipSnapshot: true });

    resetGridHarness();
    const elsewhere = makeApp(); // s-a is active, the grid opens on the others
    elsewhere.openTileGrid(['s-b', 's-c']);
    expect(elsewhere._cleanupPreviousSession).toHaveBeenCalledWith('s-b', { skipSnapshot: false });
  });

  it('_cleanupPreviousSession skips the snapshot only when asked', () => {
    const app = makeApp();
    delete app._cleanupPreviousSession; // the real one
    app._disconnectWs = vi.fn();
    const serialize = vi.fn(() => 'snapshot of s-a\r\n'.repeat(4));
    app._serializeAddon = { serialize };
    app._isUsableXtermSnapshot = () => true;
    app._persistXtermSnapshot = vi.fn();
    app._cleanupPreviousSession('s-b', { skipSnapshot: true });
    expect(serialize).not.toHaveBeenCalled();
    expect(app._xtermSnapshots.has('s-a')).toBe(false);
    app._cleanupPreviousSession('s-b');
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(app._xtermSnapshots.has('s-a')).toBe(true);
  });

  it('opening parks it ONCE and puts a tile per session in its place, focused tile active', () => {
    const app = makeApp();
    expect(app.openTileGrid(IDS, { focusedId: 's-b' })).toBe(true);

    expect(app._cleanupPreviousSession).toHaveBeenCalledTimes(1);
    expect(main.classList.contains('tiles-active')).toBe(true);
    expect(FakeTile.all.map((t) => t.sessionId)).toEqual(IDS);
    // Built one per frame after the click (_connectTilesPaced), each once.
    flushFrames();
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
      advanceClock(60_000); // past the install grace period
      const longTasks = [0, 1, 2].map((i) => ({ duration: 400, startTime: clockNow() - 100 * i }));
      perfObserverCallbacks.at(-1)?.({ getEntries: () => longTasks });
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

  it("the main terminal's window-resize timer leaves grid tiles to the grid's own observer", () => {
    // A window resize fires both: the grid's ResizeObserver refits every tile
    // (tile-grid.js _scheduleTileGridRefit) and the main terminal's trailing
    // timer used to refit them again, twelve fit() calls for six tiles and
    // nothing more sent (measured). The timer lives inside initTerminal(), so
    // this reads its source; the split's Pane B is still refitted there.
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    const start = src.indexOf('const throttledResize = () => {');
    const end = src.indexOf("window.addEventListener('resize', throttledResize)", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const calls = src.slice(start, end).match(/this\._forEachTile\?\.\([^;]*;/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('{ grid: false }');
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
