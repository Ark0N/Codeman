/**
 * @fileoverview The grid survives a page reload, per device (`codeman:tile-grid`).
 *
 * - What is stored: ids (the cells), the tile count, focus, a zoom the user
 *   chose and the divider fractions, never content. Closing the grid (Tiles,
 *   a pick outside it, the last tile leaving) keeps it remembered as
 *   `open: false` for one-click return, and the toggle brings it back exactly
 *   (owner request, superseding decision 10's "the count wins over a
 *   remembered grid's size"; the full set of close paths is in
 *   tile-grid-layout-memory.test.ts). Never written or read in a solo window.
 * - The restore runs INSIDE handleInit, in place of its single-view
 *   `selectSession(restoreId, { auto: true })`: with a stored open grid the
 *   main terminal never loads on that page load (no select, no socket, no
 *   capture), a deleted or detached session frees its cell for the ranking
 *   to fill, duplicate ids are dropped, and the stored fractions and zoom
 *   come back. A narrow window keeps the single view.
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
function pageLoad(
  liveIds: string[],
  setup: (app: GridApp) => void = () => {},
  {
    sessions = liveIds.map((id) => ({ id, name: id, mode: 'claude', pid: 1 })),
    sessionOrder,
    realOrder = false,
  }: { sessions?: Array<Record<string, unknown>>; sessionOrder?: string[]; realOrder?: boolean } = {}
) {
  const app = makeGridApp(IDS);
  app._initGeneration = 0;
  app.activeSessionId = null;
  app.selectSession = vi.fn();
  app._fetchTerminalCapture = vi.fn();
  app._resetAllAppState = vi.fn(() => app.sessions.clear());
  for (const name of [
    '_clearTimer',
    '_updateCjkInputState',
    ...(realOrder ? [] : ['syncSessionOrder']),
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
  app.handleInit({ sessions, scheduledRuns: [], ...(sessionOrder ? { sessionOrder } : {}) });
  return app;
}

beforeEach(() => {
  resetGridHarness();
});

describe('what is stored', () => {
  it('opening the grid stores ids, its count, focus and fractions, nothing else', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS, { focusedId: 's-b' });
    expect(stored()).toEqual({
      v: 1,
      open: true,
      ids: IDS,
      count: 4,
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

  it('closing keeps it remembered (open: false); the last tile leaving keeps it too', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.openTileGrid(IDS);
    app.closeTileGrid({ reselect: false });
    expect(stored()).toMatchObject({ open: false, ids: IDS });

    app.openTileGrid(['s-a']);
    app.removeTile('s-a');
    expect(stored()).toMatchObject({ open: false, ids: ['s-a'], count: 1 });
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

  it('a session that no longer exists frees its cell, which the ranking fills; that is stored', () => {
    storeGrid({ ids: ['s-a', 'gone', 's-b'], focused: 'gone' });
    const app = pageLoad(IDS);
    // Every session quiet and unstamped here: the ranking is tab order (s-c first).
    expect(app._tileGrid.cells).toEqual(['s-a', 's-c', 's-b']);
    expect(app.activeSessionId).toBe('s-a');
    expect(stored().ids).toEqual(['s-a', 's-c', 's-b']);
  });

  it('the reload fill ranks with the init payload: its states, stamps and synced tab order', () => {
    // The tab order comes from the server snapshot (synced before the restore
    // runs); the states from the session payload. Pending approvals arrive
    // later (seedApprovals is async), so only status and stamps rank here.
    storeGrid({ ids: ['s-a', 'gone', 's-b'], focused: 's-a' });
    const now = 1_000_000;
    const app = pageLoad(IDS, () => {}, {
      realOrder: true,
      sessionOrder: ['s-c', 's-b', 's-a', 's-d'],
      sessions: [
        { id: 's-a', name: 's-a', mode: 'claude', pid: 1, status: 'idle', lastActivityAt: now },
        { id: 's-b', name: 's-b', mode: 'claude', pid: 1, status: 'idle', lastActivityAt: now },
        { id: 's-c', name: 's-c', mode: 'claude', pid: 1, status: 'idle', lastActivityAt: now - 10 },
        { id: 's-d', name: 's-d', mode: 'claude', pid: 1, status: 'busy', lastSubmitAt: now - 500 },
      ],
    });
    expect(app.sessionOrder).toEqual(['s-c', 's-b', 's-a', 's-d']);
    // s-d is working: it takes the freed cell, though s-c comes first in the tab order.
    expect(app._tileGrid.cells).toEqual(['s-a', 's-d', 's-b']);
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

  it('a stored 3x3 (before the cap of 6) comes back as its first six, focus kept, a dropped zoom cleared', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `n-${i + 1}`);
    storeGrid({ ids: nine, focused: 'n-5', zoomed: 'n-8', colFr: [2, 1, 1], rowFr: [1, 1, 1] });
    const app = pageLoad(nine);
    expect(app._tileGrid.ids).toEqual(nine.slice(0, 6));
    expect(FakeTile.all.filter((t) => !t._destroyed)).toHaveLength(6);
    expect(app.activeSessionId).toBe('n-5');
    expect(app._tileGrid.zoomedId).toBeNull();
    // 3x2 now: the columns still match, the three stored rows do not.
    expect(app._tileGrid.colFr).toEqual([2, 1, 1]);
    expect(app._tileGrid.rowFr).toEqual([1, 1]);
    expect(stored().ids).toEqual(nine.slice(0, 6));
  });

  it('a stored closed grid leaves the single view, and the Tiles toggle brings it back', () => {
    localStore.set(KEY, JSON.stringify({ v: 1, open: false, ids: ['s-b', 's-c'], focused: 's-c' }));
    localStore.set('codeman:tile-count', '2');
    const app = pageLoad(IDS, (a) => localStore.set('codeman-active-session', 's-a'));
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(app.selectSession).toHaveBeenCalledWith('s-a', { auto: true });

    app.activeSessionId = 's-a';
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
  });

  it('the toggle brings a stored grid back exactly, never filled to the remembered count', () => {
    // Owner request ("always keep what the last setting was"), superseding
    // decision 10's answer that the count wins over a remembered grid's size.
    localStore.set(KEY, JSON.stringify({ v: 1, open: false, ids: ['s-b', 's-c'], focused: 's-c' }));
    const app = pageLoad(IDS, (a) => localStore.set('codeman-active-session', 's-a'));
    app.activeSessionId = 's-a';
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(['s-b', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
  });

  it('a stored hole stays a hole on the toggle; a count picked in the menu fills it first', () => {
    // A 3x2 of five with the second cell empty; the remembered count is six.
    const cells = ['s-a', null, 's-b', 's-c', 's-d', 's-e'];
    localStore.set(KEY, JSON.stringify({ v: 1, open: false, ids: cells, focused: 's-b' }));
    const app = pageLoad([...IDS, 's-e', 's-f']);
    // (syncSessionOrder is stubbed here: the tab order the ranking reads.)
    app.sessionOrder = [...IDS, 's-e', 's-f'];
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(cells);
    app.closeTileGrid({ reselect: false });
    app._pickTileCount(6);
    // s-f joins in the hole (packing would have put it last).
    expect(app._tileGrid.cells).toEqual(['s-a', 's-f', 's-b', 's-c', 's-d', 's-e']);
  });

  it('a reload brings back exactly the stored grid, whatever the count', () => {
    localStore.set('codeman:tile-count', '6');
    storeGrid({ ids: ['s-b', 's-c'], focused: 's-c' });
    const app = pageLoad(IDS);
    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
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
