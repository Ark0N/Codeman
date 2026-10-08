/**
 * @fileoverview The grid as cells (owner: "the empty tab doesnt always have to
 * be the last one ... it can also be tab nr 4 or 3"). `grid.cells` holds a
 * session id or `null` per cell and is the one source of truth; `grid.ids` is
 * the tiles in reading order, derived. The shape still comes from the tile
 * count (the layout table), and the cap counts tiles, never empty cells.
 *
 * - Removing a tile without a shape change leaves its cell empty where it was.
 * - Adding one without a shape change takes the first empty cell (or the cell a
 *   tab was dropped on: tile-grid-move.test.ts).
 * - A shape change keeps each tile's row and column when all fit (2x2 growing
 *   to 3x2), else the tiles pack in reading order (fitTileCells).
 * - Focus never lands on an empty cell: the Alt+Shift+Arrow chords skip it,
 *   and Ctrl+Tab / Alt+[ ] cycle through the tiles only.
 * - `codeman:tile-grid` stores the cells (ids, `null` for a hole); a reload
 *   brings the holes back when the shape is the same, a session gone by then
 *   leaves its cell empty, a different shape packs, and the old packed format
 *   reads unchanged. A followed `#session=` link keeps the holes.
 * - A divider drag refits only the tiles in its two tracks, holes skipped.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  documentAddEventListener,
  localStore,
  makeGridApp,
  rafCallbacks,
  resetGridHarness,
  section,
  type GridApp,
  tileEl,
} from './mocks/tile-grid-vm.js';

const SIX = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'];
const FIVE = SIX.slice(0, 5);
const KEY = 'codeman:tile-grid';
const slots = () => section.children.filter((el) => el.className.split(' ').includes('tile-slot'));
const stored = () => JSON.parse(localStore.get(KEY) ?? 'null');
const tile = (id: string) => FakeTile.all.find((t) => t.sessionId === id && !t._destroyed) as FakeTile;
const place = (id: string) => [tileEl(id).style.gridColumn, tileEl(id).style.gridRow];

// Under 1800px wide three tiles take a 2x2 (over it, 3x1).
const narrow = () => {
  section.getBoundingClientRect = () => ({ width: 1700, height: 1000, top: 0, left: 0, right: 1700, bottom: 1000 });
};

function openGrid(ids: string[], focusedId = ids[0], all: string[] = SIX): GridApp {
  const app = makeGridApp(all);
  app.openTileGrid(ids, { focusedId });
  return app;
}

function setCells(app: GridApp, cells: Array<string | null>) {
  app._tileGrid.cells = cells.slice();
  app._applyTileLayout();
}

beforeEach(() => {
  resetGridHarness();
  narrow();
});
afterEach(() => {
  delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
});

describe('the cells are the source of truth', () => {
  it('ids are the tiles in reading order, derived from the cells (holes skipped)', () => {
    const app = openGrid(FIVE);
    setCells(app, ['s-a', null, 's-b', 's-c', 's-d', 's-e']);
    expect(app._tileGrid.ids).toEqual(FIVE);
    expect(app._tileGrid.cells).toEqual(['s-a', null, 's-b', 's-c', 's-d', 's-e']);
    // A tile sits in its cell, the slot in the empty one.
    expect(place('s-b')).toEqual(['5', '1']);
    expect([slots()[0].style.gridColumn, slots()[0].style.gridRow]).toEqual(['3', '1']);
  });

  it('opening packs from the first cell and pads the shape with empty cells', () => {
    const app = openGrid(FIVE);
    expect(app._tileGrid.cells).toEqual([...FIVE, null]);
  });
});

describe('removing a tile', () => {
  it('without a shape change (6 to 5 stays 3x2): its cell is left empty where it was', () => {
    const app = openGrid(SIX);
    app.removeTile('s-b');
    expect(app._tileGrid.cells).toEqual(['s-a', null, 's-c', 's-d', 's-e', 's-f']);
    expect(place('s-c')).toEqual(['5', '1']);
    expect(slots()).toHaveLength(1);
    expect(slots()[0].dataset.cell).toBe('1');
    // Nothing else was remounted.
    expect(FakeTile.all.filter((t) => t._destroyed).map((t) => t.sessionId)).toEqual(['s-b']);
    expect(stored().ids).toEqual(['s-a', null, 's-c', 's-d', 's-e', 's-f']);
  });

  it('a shape change (5 to 4 is 3x2 to 2x2) keeps the tiles when all fit, else packs them', () => {
    let app = openGrid(FIVE);
    setCells(app, ['s-a', 's-b', null, 's-d', 's-e', 's-c']);
    // Removing the only tile in the third column: the rest keep their places.
    app.removeTile('s-c');
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-d', 's-e']);
    resetGridHarness();
    narrow();
    app = openGrid(FIVE);
    setCells(app, ['s-a', null, 's-c', 's-d', 's-e', 's-b']);
    // A tile is left in the third column: packed in reading order.
    app.removeTile('s-e');
    expect(app._tileGrid.cells).toEqual(['s-a', 's-c', 's-d', 's-b']);
  });

  it('the focused tile leaving hands focus to the next tile in reading order, past the hole', () => {
    const app = openGrid(SIX, 's-a');
    setCells(app, ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f']);
    app.removeTile('s-b');
    app.removeTile('s-a');
    expect(app.activeSessionId).toBe('s-c');
  });
});

describe('adding a tile', () => {
  it('without a shape change: the first empty cell in reading order', () => {
    const app = openGrid(FIVE);
    setCells(app, ['s-a', 's-b', null, 's-c', 's-d', 's-e']);
    app.addTile('s-f');
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-f', 's-c', 's-d', 's-e']);
    expect(slots()).toHaveLength(0);
  });

  it('Ctrl/Cmd+click on a tab and a session Run from this tab fill the first hole too', () => {
    const app = openGrid(['s-a', 's-b', 's-c', 's-d'], 's-a', [...SIX, 's-g']);
    // 2x2 [a b / c d]; the 5th makes it 3x2 with the four kept in place.
    app.addSessionToTiles('s-e');
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-e', 's-c', 's-d', null]);
    setCells(app, ['s-a', null, 's-b', 's-c', 's-d', 's-e']);
    app._joinTileGridFromRun('s-f');
    expect(app._tileGrid.cells).toEqual(['s-a', 's-f', 's-b', 's-c', 's-d', 's-e']);
  });

  it('a shape change (4 to 5 is 2x2 to 3x2): every tile keeps its row and column', () => {
    const app = openGrid(['s-a', 's-b', 's-c', 's-d']);
    app.addTile('s-e');
    // [a b / c d] -> [a b e / c d _]
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-e', 's-c', 's-d', null]);
    expect(place('s-c')).toEqual(['1', '3']);
    expect(place('s-e')).toEqual(['5', '1']);
  });

  it('into the cell named when it is empty, not just the first one (two holes, a state the cap never reaches)', () => {
    const app = openGrid(['s-a', 's-b']);
    // A 2x2 with two holes, set up by hand: the third tile still keeps the 2x2.
    app._tileGrid.cells = ['s-a', null, 's-b', null];
    app._tileGrid.cols = 2;
    app._tileGrid.rows = 2;
    app.addTile('s-c', { cell: 3 });
    expect(app._tileGrid.cells).toEqual(['s-a', null, 's-b', 's-c']);
    // A cell that is taken is not: the first empty one instead.
    resetGridHarness();
    narrow();
    const other = openGrid(['s-a', 's-b']);
    other._tileGrid.cells = ['s-a', null, 's-b', null];
    other._tileGrid.cols = 2;
    other._tileGrid.rows = 2;
    other.addTile('s-c', { cell: 2 });
    expect(other._tileGrid.cells).toEqual(['s-a', 's-c', 's-b', null]);
  });

  it('the cap counts tiles, never empty cells', () => {
    const app = openGrid(FIVE);
    setCells(app, [null, 's-a', 's-b', 's-c', 's-d', 's-e']);
    expect(app.addTile('s-f')).toBe(true);
    expect(app._tileGrid.cells).toEqual(['s-f', 's-a', 's-b', 's-c', 's-d', 's-e']);
    expect(app.addTile('s-other')).toBe(false);
  });
});

describe('a shape change from the window (three tiles: 2x2 narrow, 3x1 wide)', () => {
  it('positions do not map between shapes: the tiles keep their reading order, packed', () => {
    const app = openGrid(['s-a', 's-b', 's-c']);
    setCells(app, ['s-a', null, 's-b', 's-c']);
    section.getBoundingClientRect = () => ({ width: 2400, height: 1000, top: 0, left: 0, right: 2400, bottom: 1000 });
    app._applyTileLayout();
    expect([app._tileGrid.cols, app._tileGrid.rows]).toEqual([3, 1]);
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c']);
    narrow();
    app._applyTileLayout();
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', null]);
  });
});

describe('focus never lands on an empty cell', () => {
  function handlerFor(app: GridApp) {
    app.$ = () => null;
    app.setupColorPicker = vi.fn();
    const before = (documentAddEventListener.mock.calls as unknown[]).length;
    app.setupEventListeners();
    const added = (documentAddEventListener.mock.calls as Array<[string, (e: unknown) => void, boolean]>).slice(before);
    return added.find(([type, , capture]) => type === 'keydown' && capture === true)![1];
  }
  const chord = (key: string, mods: Record<string, boolean>) => ({
    type: 'keydown',
    key,
    code: key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    target: { closest: () => null },
    ...mods,
  });
  const focusKey = (dir: string) => chord(`Arrow${dir}`, { altKey: true, shiftKey: true });

  it('Alt+Shift+Arrows skip a hole to the next tile, and do nothing when there is none', () => {
    const app = openGrid(FIVE, 's-a');
    // [a _ b / c d e]
    setCells(app, ['s-a', null, 's-b', 's-c', 's-d', 's-e']);
    delete app.selectSession;
    const onKeydown = handlerFor(app);
    onKeydown(focusKey('Right'));
    expect(app.activeSessionId).toBe('s-b');
    onKeydown(focusKey('Right'));
    expect(app.activeSessionId).toBe('s-b');
    app._selectTiledSession('s-d', { auto: true });
    // Up from d (the hole above): the nearest tile in that row, the lower column on a tie.
    onKeydown(focusKey('Up'));
    expect(app.activeSessionId).toBe('s-a');
    expect(app._tileGrid.focusedId).toBe('s-a');
  });

  it('Ctrl+Tab and Alt+[ / ] cycle through the tiles in reading order, never a hole', () => {
    const app = openGrid(FIVE, 's-a');
    setCells(app, ['s-a', null, 's-b', 's-c', 's-d', 's-e']);
    delete app.selectSession;
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      app._cycleTileFocus(1);
      seen.push(app.activeSessionId);
    }
    expect(seen).toEqual(['s-b', 's-c', 's-d', 's-e', 's-a']);
    app._cycleTileFocus(-1);
    expect(app.activeSessionId).toBe('s-e');
  });
});

describe('persistence: the cells, holes included', () => {
  function reload(ids: string[] = SIX): GridApp {
    // The page goes away; a fresh one on the same device restores the grid.
    section.children = [];
    FakeTile.all = [];
    const app = makeGridApp(ids);
    expect(app._restoreTileGrid()).toBe(true);
    return app;
  }

  it('a hole comes back where it was when the shape is the same', () => {
    const app = openGrid(FIVE, 's-c');
    setCells(app, ['s-a', 's-b', null, 's-c', 's-d', 's-e']);
    expect(stored().ids).toEqual(['s-a', 's-b', null, 's-c', 's-d', 's-e']);
    app._tileGrid.open = false;
    const again = reload();
    expect(again._tileGrid.cells).toEqual(['s-a', 's-b', null, 's-c', 's-d', 's-e']);
    expect(again.activeSessionId).toBe('s-c');
    expect(slots()[0].dataset.cell).toBe('2');
  });

  it('a session gone by then leaves its cell empty if the shape still fits', () => {
    const app = openGrid(SIX);
    app._tileGrid.open = false;
    const again = reload(['s-a', 's-b', 's-d', 's-e', 's-f']);
    expect(again._tileGrid.cells).toEqual(['s-a', 's-b', null, 's-d', 's-e', 's-f']);
  });

  it('otherwise (another shape) the grid packs', () => {
    const app = openGrid(FIVE);
    setCells(app, ['s-a', null, 's-b', 's-c', 's-d', 's-e']);
    app._tileGrid.open = false;
    // s-d gone: four tiles take a 2x2.
    const again = reload(['s-a', 's-b', 's-c', 's-e']);
    expect(again._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', 's-e']);
  });

  it('another shape packs even when the stored holes would fit the new one', () => {
    // Stored as 3x2 [a _ b / c d e]; d and e gone: three tiles take a 2x2.
    localStore.set(KEY, JSON.stringify({ v: 1, open: true, ids: ['s-a', null, 's-b', 's-c', 's-d', 's-e'] }));
    const again = reload(['s-a', 's-b', 's-c']);
    expect(again._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', null]);
  });

  it('the old packed format reads unchanged', () => {
    localStore.set(KEY, JSON.stringify({ v: 1, open: true, ids: FIVE, focused: 's-b' }));
    const again = reload();
    expect(again._tileGrid.cells).toEqual([...FIVE, null]);
    expect(again.activeSessionId).toBe('s-b');
  });

  it('a followed #session= link closes the stored grid with its holes kept', () => {
    const app = openGrid(FIVE);
    setCells(app, ['s-a', null, 's-b', 's-c', 's-d', 's-e']);
    const fresh = makeGridApp(SIX);
    fresh._closeStoredTileGrid();
    expect(stored()).toMatchObject({ open: false, ids: ['s-a', null, 's-b', 's-c', 's-d', 's-e'] });
    expect(stored()).not.toHaveProperty('cells');
    void app;
  });
});

describe('a move keeps every tile', () => {
  it('cells that lose or duplicate a tile are refused, and nothing changes', () => {
    const app = openGrid(FIVE);
    const before = app._tileGrid.cells.slice();
    expect(app._reorderTiles(['s-a', 's-b', 's-c', 's-d', null, null])).toBe(false);
    expect(app._reorderTiles(['s-a', 's-a', 's-c', 's-d', 's-e', null])).toBe(false);
    expect(app._reorderTiles(['s-a', 's-b', 's-c', 's-d', 's-e'])).toBe(false);
    expect(app._tileGrid.cells).toEqual(before);
  });
});

describe('a divider drag with a hole', () => {
  it('refits only the tiles in its two columns, the hole skipped', () => {
    const app = openGrid(FIVE);
    // [a _ b / c d e]: column 0 holds a, c; column 1 holds d.
    setCells(app, ['s-a', null, 's-b', 's-c', 's-d', 's-e']);
    for (const t of FakeTile.all) t.fit.mockClear();
    const d = app._tileGrid.dividers.get('col-0') as FakeEl;
    d.dispatch('pointerdown', {
      button: 0,
      clientX: 500,
      clientY: 100,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    d.dispatch('pointermove', { clientX: 560, clientY: 100, pointerId: 1 });
    for (const cb of rafCallbacks.splice(0)) cb();
    d.dispatch('pointerup', { clientX: 560, clientY: 100, pointerId: 1 });
    const fits = Object.fromEntries(FIVE.map((id) => [id, tile(id).fit.mock.calls.length]));
    expect(fits).toEqual({ 's-a': 1, 's-b': 0, 's-c': 1, 's-d': 1, 's-e': 0 });
  });
});
