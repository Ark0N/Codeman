/**
 * @fileoverview The grid survives a page reload, per device (`codeman:tile-grid`).
 *
 * - What is stored: ids, focus, a zoom the user chose and the divider
 *   fractions, never content. Closing the grid (Tiles, a pick outside it)
 *   keeps it remembered as `open: false` for one-click return; the last tile
 *   leaving forgets it. Never written or read in a solo window.
 * - The restore runs INSIDE handleInit, in place of its single-view
 *   `selectSession(restoreId, { auto: true })`: with a stored open grid the
 *   main terminal never loads on that page load (no select, no socket, no
 *   capture), deleted / detached / duplicate ids are dropped, and the stored
 *   fractions and zoom come back. A narrow window keeps the single view.
 * - A `#session=` link on load wins, and leaves the stored grid remembered
 *   but closed.
 * - Leaving the grid invalidates the main terminal's cached content for every
 *   tiled id (snapshot, its localStorage copy, buffer cache).
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTile, localStore, makeGridApp, resetGridHarness, windowStub, type GridApp } from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c', 's-d'];
const KEY = 'codeman:tile-grid';
const stored = () => JSON.parse(localStore.get(KEY) ?? 'null');

/** A fresh page: the app as handleInit leaves it on its FIRST run (gen 1). */
function pageLoad(liveIds: string[], setup: (app: GridApp) => void = () => {}) {
  const app = makeGridApp(IDS);
  app._initGeneration = 0;
  app.activeSessionId = null;
  app.selectSession = vi.fn();
  app._fetchTerminalCapture = vi.fn();
  app._resetAllAppState = vi.fn(() => app.sessions.clear());
  for (const name of [
    '_clearTimer',
    '_updateCjkInputState',
    'syncSessionOrder',
    '_loadTabLayout',
    'cleanupAllFloatingWindows',
    'startSystemStatsPolling',
    'stopSystemStatsPolling',
    'updateCost',
  ]) {
    app[name] = vi.fn();
  }
  app.$ = () => null;
  setup(app);
  app.handleInit({
    sessions: liveIds.map((id) => ({ id, name: id, mode: 'claude', pid: 1 })),
    scheduledRuns: [],
  });
  return app;
}

beforeEach(() => {
  resetGridHarness();
});

describe('what is stored', () => {
  it('opening the grid stores ids, focus and fractions, nothing else', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS, { focusedId: 's-b' });
    expect(stored()).toEqual({
      v: 1,
      open: true,
      ids: IDS,
      focused: 's-b',
      zoomed: null,
      colFr: [1, 1],
      rowFr: [1, 1],
    });
  });

  it('focus, a zoom by hand and a divider drag are written as they happen', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.selectSession('s-c');
    expect(stored().focused).toBe('s-c');
    app.zoomTile('s-c');
    expect(stored().zoomed).toBe('s-c');
    app.zoomTile('s-c');
    app._tileGrid.colFr = [2, 1];
    app._persistTileGrid();
    expect(stored().colFr).toEqual([2, 1]);
  });

  it('an automatic zoom (window too small) is not stored: it is worked out again', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app._tileGrid.zoomedId = 's-a';
    app._tileGrid.autoZoom = true;
    app._persistTileGrid();
    expect(stored().zoomed).toBeNull();
  });

  it('closing keeps it remembered (open: false); the last tile leaving forgets it', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.openTileGrid(IDS);
    app.closeTileGrid({ reselect: false });
    expect(stored()).toMatchObject({ open: false, ids: IDS });

    app.openTileGrid(['s-a']);
    app.removeTile('s-a');
    expect(localStore.has(KEY)).toBe(false);
  });

  it('a solo window never writes', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    localStore.delete(KEY);
    app.isSoloWindow = true;
    app._persistTileGrid();
    expect(localStore.has(KEY)).toBe(false);
  });
});

describe('page load with a stored open grid', () => {
  const storeGrid = (state: Record<string, unknown>) =>
    localStore.set(KEY, JSON.stringify({ v: 1, open: true, zoomed: null, ...state }));

  it('restores the grid IN PLACE of the single view: the main terminal never loads', () => {
    storeGrid({ ids: IDS, focused: 's-c' });
    const app = pageLoad([...IDS, 's-other']);

    expect(app._tilesOwnTerminal()).toBe(true);
    expect(app._tileGrid.ids).toEqual(IDS);
    expect(app.activeSessionId).toBe('s-c');
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app._connectWs).not.toHaveBeenCalled();
    expect(app._fetchTerminalCapture).not.toHaveBeenCalled();
    // Restoring is the app's choice of focus: no idle alert spent.
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });

  it('drops a session that no longer exists, and stores the cleaned list', () => {
    storeGrid({ ids: ['s-a', 'gone', 's-b'], focused: 'gone' });
    const app = pageLoad(IDS);
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b']);
    expect(app.activeSessionId).toBe('s-a');
    expect(stored().ids).toEqual(['s-a', 's-b']);
  });

  it('brings back the fractions (same layout only) and a zoom the user chose', () => {
    storeGrid({ ids: IDS, focused: 's-a', zoomed: 's-b', colFr: [2, 1], rowFr: [1, 1, 1] });
    const app = pageLoad(IDS);
    expect(app._tileGrid.colFr).toEqual([2, 1]);
    // Three row fractions do not fit a 2x2: equal rows.
    expect(app._tileGrid.rowFr).toEqual([1, 1]);
    expect(app._tileGrid.zoomedId).toBe('s-b');
    expect(app.activeSessionId).toBe('s-b');
  });

  it('a stored closed grid leaves the single view, and the Tiles toggle brings it back', () => {
    localStore.set(KEY, JSON.stringify({ v: 1, open: false, ids: ['s-b', 's-c'], focused: 's-c' }));
    const app = pageLoad(IDS, (a) => localStore.set('codeman-active-session', 's-a'));
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(app.selectSession).toHaveBeenCalledWith('s-a', { auto: true });

    app.activeSessionId = 's-a';
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
  });

  it('a window too narrow for the grid keeps the single view (the stored grid waits)', () => {
    storeGrid({ ids: IDS, focused: 's-a' });
    windowStub.innerWidth = 1100;
    const app = pageLoad(IDS);
    expect(app._tileGrid?.open ?? false).toBe(false);
    expect(app.selectSession).toHaveBeenCalled();
    expect(stored().open).toBe(true);
  });

  it('a solo window never restores it', () => {
    storeGrid({ ids: IDS, focused: 's-a' });
    const app = pageLoad(IDS, (a) => {
      a.isSoloWindow = true;
      a._applySoloMode = vi.fn();
    });
    expect(app._tileGrid?.open ?? false).toBe(false);
    expect(FakeTile.all).toHaveLength(0);
  });

  it.each([
    ['another version', JSON.stringify({ v: 2, open: true, ids: IDS })],
    ['not JSON', '{oops'],
    ['not an object', '[1,2]'],
  ])('ignores a stored value that is %s', (_label, raw) => {
    localStore.set(KEY, raw);
    const app = pageLoad(IDS);
    expect(app._tileGrid?.open ?? false).toBe(false);
    expect(app.selectSession).toHaveBeenCalled();
  });

  it('a #session= link on load wins, and the grid stays remembered, closed', () => {
    storeGrid({ ids: IDS, focused: 's-a' });
    const app = pageLoad(IDS, (a) => {
      a._urlSessionId = 's-d';
    });
    expect(app._tileGrid?.open ?? false).toBe(false);
    expect(app.selectSession).toHaveBeenCalledWith('s-d', { auto: true, leaveTiles: true });
    expect(stored()).toMatchObject({ open: false, ids: IDS });
  });
});

describe('leaving the grid', () => {
  it("invalidates the main terminal's cached content for every tiled id", () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    for (const id of [...IDS, 's-other']) {
      app._xtermSnapshots.set(id, 'old');
      app.terminalBufferCache.set(id, 'old');
      localStore.set(`codeman-xs-${id}`, 'old');
    }
    app.openTileGrid(['s-a', 's-b']);
    app.closeTileGrid();
    for (const id of ['s-a', 's-b']) {
      expect(app._xtermSnapshots.has(id)).toBe(false);
      expect(app.terminalBufferCache.has(id)).toBe(false);
      expect(localStore.has(`codeman-xs-${id}`)).toBe(false);
    }
    expect(app._xtermSnapshots.get('s-c')).toBe('old');
  });
});
