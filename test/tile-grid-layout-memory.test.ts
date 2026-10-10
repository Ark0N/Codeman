/**
 * @fileoverview The grid keeps the layout the user arranged, per browser
 * (owner request: "when I moved around and modified it, save it per browser
 * the layout, so when I turn tiles off and on, always keep what the last
 * setting was").
 *
 * - Saved on every change (`codeman:tile-grid` in localStorage, never the
 *   server): which session sits in which cell, holes included, the tile count,
 *   the divider sizes, the focused tile and a zoom the user chose.
 * - The Tiles toggle and a page reload bring back exactly that, however the
 *   grid was closed: the toggle, a tab that is not tiled, a followed link
 *   (`leaveTiles`, or `#session=` on load), Home, the window narrowing past the
 *   desktop gate, the last tile removed, "Open group as tiles", closing a
 *   session, killing them all. It is never filled to the remembered count and
 *   never trimmed to the window (a too-small window shows the focused tile
 *   until it fits, the arrangement kept).
 * - A session that no longer exists frees its cell, and the ranking fills it
 *   (the hole a user left stays a hole); with none of the stored sessions left
 *   the grid opens from the ranking, as with nothing stored.
 * - The stored format stays `v: 1`: a value written before `count` (or before
 *   cells) loads, and a malformed one is ignored safely.
 *
 * Pure helpers (sanitizeTileGridState, restoreTileGridCells) and the app via
 * the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  body,
  bySelector,
  fetchSpy,
  flushFrames,
  localStore,
  makeGridApp,
  resetGridHarness,
  section,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

type Restored = { ids: string[]; cells: Array<string | null>; focusedId: string } | null;
type Sanitized = {
  ids: string[];
  cells: Array<string | null>;
  freed: number[];
  count: number;
  open: boolean;
  focused: string | null;
  zoomed: string | null;
  colFr: number[] | null;
} | null;
type Helpers = {
  sanitizeTileGridState(raw: unknown, live: Iterable<string>, detached?: Set<string>): Sanitized;
  restoreTileGridCells(stored: unknown, ranked: string[]): Restored;
};

const T = windowStub.CodemanTileGrid as Helpers;
const KEY = 'codeman:tile-grid';
const SIX = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'];
const stored = () => JSON.parse(localStore.get(KEY) ?? 'null');

describe('sanitizeTileGridState: freed cells and the count', () => {
  const live = ['a', 'b', 'c', 'd'];

  it('marks the cells whose session went away (deleted or popped out), never a hole the user left', () => {
    const out = T.sanitizeTileGridState(
      { v: 1, open: true, ids: ['a', null, 'gone', 'b', 'c', 'x'] },
      live,
      new Set(['c'])
    );
    expect(out?.cells).toEqual(['a', null, null, 'b', null, null]);
    expect(out?.freed).toEqual([2, 4, 5]);
  });

  it('a repeat or a malformed entry is a plain hole, not freed', () => {
    const out = T.sanitizeTileGridState({ v: 1, ids: ['a', 'a', 7, '', 'gone', 'gone'] }, live);
    expect(out?.cells).toEqual(['a', null, null, null, null, null]);
    expect(out?.freed).toEqual([4]);
  });

  it('reads a stored count; one written before it existed is the number of sessions the cells name', () => {
    expect(T.sanitizeTileGridState({ v: 1, ids: ['a', null, 'b'], count: 4 }, live)?.count).toBe(4);
    expect(T.sanitizeTileGridState({ v: 1, ids: ['a', null, 'gone', 'b'] }, live)?.count).toBe(3);
    // The old packed format of nine (before the cap) reads as the cap.
    const nine = Array.from({ length: 9 }, (_, i) => `n${i}`);
    expect(T.sanitizeTileGridState({ v: 1, ids: nine }, nine)?.count).toBe(6);
  });

  it.each([[0], [7], [2.5], ['4'], [null], [-1]])('a malformed count (%j) is ignored', (count) => {
    expect(T.sanitizeTileGridState({ v: 1, ids: ['a', 'b'], count }, live)?.count).toBe(2);
  });
});

describe('restoreTileGridCells', () => {
  const sanitize = (value: Record<string, unknown>, live: string[]) =>
    T.sanitizeTileGridState({ v: 1, open: false, ...value }, live);

  it('gives back the cells exactly, holes included, focused on the zoomed tile, else the focused one', () => {
    const s = sanitize({ ids: ['a', null, 'b', 'c', 'd', 'e'], focused: 'c', zoomed: 'd' }, [
      'a',
      'b',
      'c',
      'd',
      'e',
      'z',
    ]);
    expect(T.restoreTileGridCells(s, ['z'])).toEqual({
      ids: ['a', 'b', 'c', 'd', 'e'],
      cells: ['a', null, 'b', 'c', 'd', 'e'],
      focusedId: 'd',
    });
    const t = sanitize({ ids: ['a', 'b'], focused: 'b' }, ['a', 'b']);
    expect(T.restoreTileGridCells(t, [])?.focusedId).toBe('b');
  });

  it('fills a freed cell from the ranking, best first, never one already in the grid; the user hole stays', () => {
    const s = sanitize({ ids: ['a', null, 'gone', 'b', 'c', 'd'], count: 5 }, ['a', 'b', 'c', 'd', 'x', 'y']);
    expect(T.restoreTileGridCells(s, ['b', 'y', 'x'])?.cells).toEqual(['a', null, 'y', 'b', 'c', 'd']);
  });

  it('fills freed cells first, then other empty cells only up to the count', () => {
    // A hand-made value: cell 3 freed (its session gone), cell 1 a plain hole, a count of six.
    const s = sanitize({ ids: ['a', null, 'b', 'gone', 'c', 'd'], count: 6 }, ['a', 'b', 'c', 'd', 'x', 'y', 'z']);
    expect(T.restoreTileGridCells(s, ['x', 'y', 'z'])?.cells).toEqual(['a', 'y', 'b', 'x', 'c', 'd']);
  });

  it('a freed cell stays empty only when no session is left to place', () => {
    const s = sanitize({ ids: ['a', 'gone', 'b'] }, ['a', 'b']);
    expect(T.restoreTileGridCells(s, [])).toEqual({ ids: ['a', 'b'], cells: ['a', null, 'b'], focusedId: 'a' });
  });

  it('more to place than the stored cells hold: they join after them (the shape grows when laid out)', () => {
    // Four stored cells (2x2), the count says six: two sessions closed while the grid was open packed it.
    const s = sanitize({ ids: ['a', 'b', 'c', 'd'], count: 6 }, ['a', 'b', 'c', 'd', 'x', 'y', 'z']);
    expect(T.restoreTileGridCells(s, ['x', 'y', 'z'])?.ids).toEqual(['a', 'b', 'c', 'd', 'x', 'y']);
  });

  it('is null when none of its sessions survive', () => {
    expect(T.restoreTileGridCells(sanitize({ ids: ['gone', null] }, ['x']), ['x'])).toBeNull();
    expect(T.restoreTileGridCells(null, ['x'])).toBeNull();
  });
});

// ── In the app ──────────────────────────────────────────────────────────────

/** The real selectSession (tile branch, leaving the grid); the main terminal's select path bails at once. */
function layoutApp(ids: string[] = SIX): GridApp {
  const app = makeGridApp(ids);
  app._setTerminalLoadState = vi.fn();
  app._clearTerminalLoadState = vi.fn();
  app._renderHistoryTruncationBanner = vi.fn();
  app._isStaleSelect = vi.fn(() => true);
  app._retireUrlSession = vi.fn();
  return app;
}

const divider = (app: GridApp, key: string) => app._tileGrid.dividers.get(key) as FakeEl;

/** A column divider dragged from `from` to `to` (px), released. */
function dragColumn(app: GridApp, key: string, from: number, to: number) {
  const d = divider(app, key);
  d.dispatch('pointerdown', {
    button: 0,
    pointerId: 3,
    clientX: from,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  d.dispatch('pointermove', { clientX: to });
  flushFrames();
  d.dispatch('pointerup', {});
}

/**
 * Six tiles opened, then arranged by hand: s-b removed (its cell left empty),
 * s-a and s-f swapped, the first column divider dragged, s-c focused and
 * zoomed. [ f _ c / d e a ].
 */
async function arrange(app: GridApp) {
  app.openTileGrid(SIX, { focusedId: 's-a' });
  flushFrames();
  app.removeTile('s-b');
  app._swapTiles('s-a', 's-f');
  dragColumn(app, 'col-0', 800, 1000);
  await app.selectSession('s-c');
  app.zoomTile('s-c');
}

const layoutOf = (app: GridApp) => ({
  cells: app._tileGrid.cells.slice(),
  count: app._tileGrid.count,
  colFr: app._tileGrid.colFr.slice(),
  rowFr: app._tileGrid.rowFr.slice(),
  focused: app._tileGrid.focusedId,
  zoomed: app._tileGrid.zoomedId,
});

const ARRANGED_CELLS = ['s-f', null, 's-c', 's-d', 's-e', 's-a'];

beforeEach(() => {
  resetGridHarness();
  bySelector.set('.terminal-wrap', new FakeEl());
  fetchSpy.mockClear();
});
afterEach(() => {
  delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
});

describe('saved on every change', () => {
  it('a move, a removal, a divider drag, a focus and a zoom are each written as they happen', async () => {
    const app = layoutApp();
    app.openTileGrid(SIX, { focusedId: 's-a' });
    flushFrames();
    expect(stored()).toMatchObject({ open: true, ids: SIX, count: 6, focused: 's-a', colFr: [1, 1, 1] });

    app.removeTile('s-b');
    expect(stored()).toMatchObject({ ids: ['s-a', null, 's-c', 's-d', 's-e', 's-f'], count: 5 });

    app._swapTiles('s-a', 's-f');
    expect(stored().ids).toEqual(ARRANGED_CELLS);

    dragColumn(app, 'col-0', 800, 1000);
    expect(stored().colFr[0]).toBeGreaterThan(1);
    expect(stored().colFr).toEqual(app._tileGrid.colFr);

    await app.selectSession('s-c');
    expect(stored().focused).toBe('s-c');

    app.zoomTile('s-c');
    expect(stored().zoomed).toBe('s-c');
  });

  it('adding a tile (a tab dropped on the empty cell) and picking a count are written, the count with them', () => {
    const app = layoutApp([...SIX, 's-g']);
    app.openTileGrid(SIX.slice(0, 5));
    flushFrames();
    app._tileGrid.cells = ['s-a', null, 's-b', 's-c', 's-d', 's-e'];
    app._applyTileLayout();
    app.dropSessionOnSlot('s-g', 1);
    expect(stored()).toMatchObject({ ids: ['s-a', 's-g', 's-b', 's-c', 's-d', 's-e'], count: 6 });
    app._pickTileCount(4);
    expect(stored().count).toBe(4);
    expect(stored().ids.filter(Boolean)).toHaveLength(4);
  });

  it('is never sent to the server', async () => {
    const app = layoutApp();
    await arrange(app);
    app.toggleTileGrid();
    app.toggleTileGrid();
    const calls = JSON.stringify(fetchSpy.mock.calls);
    expect(calls).not.toContain('tile');
    expect(calls).not.toContain('colFr');
  });
});

describe('the Tiles toggle and a reload bring back exactly what was arranged', () => {
  it('off and on: the cells and the hole, the count, the divider sizes, the focus and the zoom', async () => {
    const app = layoutApp();
    await arrange(app);
    const before = layoutOf(app);
    expect(before.cells).toEqual(ARRANGED_CELLS);

    app.toggleTileGrid();
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(stored()).toMatchObject({ open: false, ids: ARRANGED_CELLS, count: 5, focused: 's-c', zoomed: 's-c' });
    app.toggleTileGrid();
    expect(layoutOf(app)).toEqual(before);
    expect(app.activeSessionId).toBe('s-c');
  });

  it('never filled to the remembered count, though more sessions are free', async () => {
    const app = layoutApp([...SIX, 's-g', 's-h']);
    await arrange(app);
    app._rememberTileGridCount(6);
    app.toggleTileGrid();
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(ARRANGED_CELLS);
  });

  it('a reload with the grid open: the same layout on the next page', async () => {
    const app = layoutApp();
    await arrange(app);
    const before = layoutOf(app);
    // The page goes away; a fresh one on the same browser.
    section.children = [];
    FakeTile.all = [];
    const next = layoutApp();
    expect(next._restoreTileGrid()).toBe(true);
    expect(layoutOf(next)).toEqual(before);
  });

  it('never trimmed to a smaller window: the focused tile shows alone, and the arrangement is kept for a wider one', async () => {
    const app = layoutApp();
    app.openTileGrid(SIX, { focusedId: 's-c' });
    flushFrames();
    app.toggleTileGrid();
    // A window that fits four (3x2 needs 1440px across).
    const small = { width: 1300, height: 900, top: 0, left: 0, right: 1300, bottom: 900 };
    section.getBoundingClientRect = () => small;
    (bySelector.get('.terminal-wrap') as FakeEl).getBoundingClientRect = () => small;
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(SIX);
    expect(app._tileGrid.zoomedId).toBe('s-c');
    expect(app._tileGrid.autoZoom).toBe(true);
    expect(stored().ids).toEqual(SIX);
    app.toggleTileGrid();
    delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
    (bySelector.get('.terminal-wrap') as FakeEl).getBoundingClientRect = FakeEl.prototype.getBoundingClientRect;
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(SIX);
    expect(app._tileGrid.zoomedId).toBeNull();
  });
});

describe('every way the grid closes keeps it', () => {
  const closers: Array<[string, (app: GridApp) => unknown]> = [
    ['the Tiles toggle', (app) => app.toggleTileGrid()],
    ['picking a tab that is not tiled', (app) => app.selectSession('s-b').catch(() => {})],
    [
      'a followed link (leaveTiles)',
      (app) => app.selectSession('s-other', { auto: true, leaveTiles: true }).catch(() => {}),
    ],
    ['Home', (app) => app.goHome()],
    ['"Open group as tiles" (its grid opens, then that one is kept)', () => {}],
  ];

  it.each(closers.slice(0, 4))('%s', async (_label, close) => {
    const app = layoutApp();
    await arrange(app);
    const before = layoutOf(app);
    await close(app);
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(stored()).toMatchObject({ open: false, ids: ARRANGED_CELLS, count: 5 });
    app.toggleTileGrid();
    expect(layoutOf(app)).toEqual(before);
  });

  it('the window narrowing past the desktop gate', async () => {
    const gates: Array<(e: { matches: boolean }) => void> = [];
    windowStub.matchMedia = (q: string) => ({
      matches: false,
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => {
        if (q.includes('min-width')) gates.push(cb);
      },
    });
    const app = layoutApp();
    await arrange(app);
    const before = layoutOf(app);
    for (const gate of gates) gate({ matches: false });
    expect(app._tilesOwnTerminal()).toBe(false);
    app.toggleTileGrid();
    expect(layoutOf(app)).toEqual(before);
  });

  it('"Open group as tiles" replaces it with the group, and THAT is what comes back', async () => {
    const app = layoutApp();
    await arrange(app);
    app.tabLayout = {
      groups: [
        {
          id: 'g',
          refs: [
            { kind: 'session', id: 's-b' },
            { kind: 'session', id: 's-d' },
          ],
        },
      ],
    };
    app.openGroupAsTiles('g');
    expect(app._tileGrid.ids).toEqual(['s-b', 's-d']);
    app.toggleTileGrid();
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(['s-b', 's-d']);
  });

  it('the last tile removed: that tile comes back', () => {
    const app = layoutApp();
    app.openTileGrid(['s-c', 's-d'], { focusedId: 's-c' });
    app.removeTile('s-d');
    app.removeTile('s-c');
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(stored()).toMatchObject({ open: false, ids: ['s-c'], count: 1 });
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(['s-c']);
  });

  it('a #session= link on load closes it, its value kept as stored (a session gone since still frees its cell)', async () => {
    const app = layoutApp();
    await arrange(app);
    const page = layoutApp();
    page.sessions.delete('s-d');
    page._closeStoredTileGrid();
    expect(stored()).toMatchObject({ open: false, ids: ARRANGED_CELLS, count: 5 });
    page.toggleTileGrid();
    // s-d's cell taken by the ranking's best untiled session (all quiet here: tab order, s-other first).
    expect(page._tileGrid.cells).toEqual(['s-f', null, 's-c', 's-other', 's-e', 's-a']);
  });

  it('closing the last tiled session: kept, and with none of its sessions left the ranking opens from scratch', () => {
    const app = layoutApp();
    app.openTileGrid(['s-c'], { focusedId: 's-c' });
    app._onSessionDeleted({ id: 's-c' });
    app.sessions.delete('s-c');
    app.sessionOrder = app.sessionOrder.filter((id: string) => id !== 's-c');
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(stored()).toMatchObject({ open: false, ids: ['s-c'] });
    Object.assign(app.sessions.get('s-e'), { status: 'busy', lastSubmitAt: 50 });
    app.toggleTileGrid();
    expect(app._tileGrid.ids[0]).toBe('s-e');
    expect(app._tileGrid.ids).toHaveLength(6);
  });

  it('killing every session: kept, naming only gone sessions, so the next click ranks from scratch', async () => {
    const app = layoutApp();
    await arrange(app);
    app._apiDelete = vi.fn(async () => ({ ok: true }));
    app.terminalBuffers = new Map();
    app.terminalLoadStates = new Map();
    // killAllSessions asks with a bare confirm(): the harness context's own global.
    const contextGlobal = (app.toggleTileGrid.constructor as FunctionConstructor)('return globalThis')();
    contextGlobal.confirm = () => true;
    try {
      await app.killAllSessions();
    } finally {
      delete contextGlobal.confirm;
    }
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(stored()).toMatchObject({ open: false, ids: ARRANGED_CELLS });
    // New sessions later: none of the stored ones survive.
    app.sessions = new Map(['n-1', 'n-2'].map((id) => [id, { id, name: id, mode: 'claude', pid: 1 }]));
    app.sessionOrder = ['n-1', 'n-2'];
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(['n-1', 'n-2']);
  });
});

describe('a session that went away by itself while the grid was open', () => {
  // With the cap at 6 a grid has at most one empty cell (5 tiles in a 3x2, or
  // 3 in a narrow 2x2), so the stored count alone says that cell is to be filled.
  function six(extra: string[] = []): GridApp {
    const app = layoutApp([...SIX, ...extra]);
    app.openTileGrid(SIX, { focusedId: 's-a' });
    flushFrames();
    return app;
  }

  it('closed from elsewhere: its cell empties now, and the ranking fills it the next time the grid opens', () => {
    const app = six(['s-g']);
    app._onSessionDeleted({ id: 's-d' });
    app.sessions.delete('s-d');
    app.sessionOrder = app.sessionOrder.filter((id: string) => id !== 's-d');
    // Nothing joins on its own while the grid is open.
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', null, 's-e', 's-f']);
    // The count stays what the user left: six.
    expect(stored()).toMatchObject({ ids: ['s-a', 's-b', 's-c', null, 's-e', 's-f'], count: 6 });
    Object.assign(app.sessions.get('s-g'), { status: 'busy', lastSubmitAt: 10 });
    app.toggleTileGrid();
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', 's-g', 's-e', 's-f']);
  });

  it('popped out (or its socket refused): the same, the place kept for the ranking', () => {
    const app = six();
    app.detachedSessions.add('s-e');
    app._reconcileTileGrid();
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', 's-d', null, 's-f']);
    FakeTile.all.find((t) => t.sessionId === 's-b' && !t._destroyed)!.onExit!(4010);
    expect(stored().count).toBe(6);
    app.toggleTileGrid();
    app.toggleTileGrid();
    // Two places to fill, the two sessions left that are not popped out (all quiet: tab order).
    expect(app._tileGrid.ids).toHaveLength(6);
    expect(app._tileGrid.ids).not.toContain('s-e');
  });

  it('popped out while open (the pop-out button, or another tab announcing it): the count stays, the cell refills after re-dock', () => {
    const app = six();
    // What the real pop-out paths touch: detachSession and the window channel
    // both mark through _markDetached; _redock clears it again.
    app._detachOrphanStrikes = new Map();
    app._detachWatchTimers = new Map();
    app._redockGrace = new Map();
    app.detachedWindows = new Map();
    app._elemCache = {};
    app._onWindowMessage({ type: 'detached', id: 's-e' });
    expect(app.detachedSessions.has('s-e')).toBe(true);
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', 's-d', null, 's-f']);
    // Not the user's hand: the count stays six, the same as a pop-out with the grid closed.
    expect(stored()).toMatchObject({ ids: ['s-a', 's-b', 's-c', 's-d', null, 's-f'], count: 6 });
    app._redock('s-e');
    expect(app.detachedSessions.has('s-e')).toBe(false);
    app.toggleTileGrid();
    app.toggleTileGrid();
    // The freed cell is filled from the ranking (all quiet here: tab order, s-other first).
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', 's-d', 's-other', 's-f']);
    expect(stored().count).toBe(6);
  });

  it('removed by hand instead: the hole stays a hole', () => {
    const app = six(['s-g']);
    app.removeTile('s-d');
    expect(stored()).toMatchObject({ ids: ['s-a', 's-b', 's-c', null, 's-e', 's-f'], count: 5 });
    app.toggleTileGrid();
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', null, 's-e', 's-f']);
  });

  it('a tile added by hand meanwhile sets the count to what is shown', () => {
    const app = six(['s-g']);
    app._onSessionDeleted({ id: 's-d' });
    app.sessions.delete('s-d');
    app._onSessionDeleted({ id: 's-e' });
    app.sessions.delete('s-e');
    // Four tiles now (a 2x2), count still six; then a Ctrl/Cmd+click adds one.
    app.addSessionToTiles('s-g');
    expect(app._tileGrid.ids).toHaveLength(5);
    expect(stored().count).toBe(5);
  });
});

describe('the stored format', () => {
  it('a value written before the count (packed, no holes) loads, its sessions in their cells', () => {
    localStore.set(KEY, JSON.stringify({ v: 1, open: false, ids: ['s-c', 's-a', 's-e', 's-d'], focused: 's-e' }));
    const app = layoutApp();
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(['s-c', 's-a', 's-e', 's-d']);
    expect(app.activeSessionId).toBe('s-e');
    expect(stored().count).toBe(4);
  });

  it.each([
    ['another version', JSON.stringify({ v: 2, open: false, ids: SIX })],
    ['not JSON', '{oops'],
    ['an array', '[1,2]'],
    ['ids that are not a list', JSON.stringify({ v: 1, open: false, ids: 's-a' })],
    ['nothing but junk', JSON.stringify({ v: 1, open: false, ids: [1, {}, null], count: 'x', colFr: 'y' })],
  ])('a malformed value (%s) is ignored: the grid opens from the ranking', (_label, raw) => {
    localStore.set(KEY, raw);
    const app = layoutApp();
    Object.assign(app.sessions.get('s-f'), { status: 'busy', lastSubmitAt: 99 });
    expect(() => app.toggleTileGrid()).not.toThrow();
    expect(app._tileGrid.ids[0]).toBe('s-f');
    expect(app._tileGrid.ids).toHaveLength(6);
  });

  it('a malformed divider size is dropped, the rest of the layout kept', () => {
    localStore.set(KEY, JSON.stringify({ v: 1, open: false, ids: ['s-a', 's-b'], colFr: [1, 'x'], rowFr: [-1] }));
    const app = layoutApp();
    app.toggleTileGrid();
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b']);
    expect(app._tileGrid.colFr).toEqual([1, 1]);
  });
});

describe('Ctrl/Cmd+click with a stored grid', () => {
  it('joins the hole while the grid holds fewer than the count, the rest kept where it was', async () => {
    const app = layoutApp();
    await arrange(app);
    app.toggleTileGrid();
    app._rememberTileGridCount(6);
    app.addSessionToTiles('s-b');
    expect(app._tileGrid.cells).toEqual(['s-f', 's-b', 's-c', 's-d', 's-e', 's-a']);
    expect(app._tileGrid.focusedId).toBe('s-b');
    expect(app._tileGrid.colFr).toEqual(stored().colFr);
  });

  it('at the count, it takes the last tile’s place: the count in total, never one more', async () => {
    const app = layoutApp();
    await arrange(app);
    app.toggleTileGrid();
    app._rememberTileGridCount(4);
    app.addSessionToTiles('s-b');
    expect(app._tileGrid.cells).toEqual(['s-f', null, 's-c', 's-d', 's-e', 's-b']);
    expect(app._tileGrid.focusedId).toBe('s-b');
    expect(stored().count).toBe(5);
  });
});

describe('the hover card', () => {
  it('with a stored grid larger than the window, says what fits, not "a click opens N"', () => {
    const btn = new FakeEl();
    btn.className = 'btn-icon-header btn-tile-grid';
    bySelector.set('.btn-tile-grid', btn);
    const small = { width: 1300, height: 900, top: 0, left: 0, right: 1300, bottom: 900 };
    (bySelector.get('.terminal-wrap') as FakeEl).getBoundingClientRect = () => small;
    const app = layoutApp();
    app._applyTileGridButtonVisibility(true);
    const card = body.children.find((c) => c.id === 'tileGridHint')!;
    const texts = () => card.children.map((c) => c.children.at(-1)?.textContent ?? c.textContent);
    // Nothing stored: the click opens what fits.
    expect(texts()).toContain('This window fits 4 tiles: a click opens 4');
    localStore.set(KEY, JSON.stringify({ v: 1, open: false, ids: SIX, focused: 's-a' }));
    app._renderTileHint();
    expect(texts()).toContain('This window fits 4 tiles');
    expect(texts().join('\n')).not.toContain('a click opens');
  });
});
