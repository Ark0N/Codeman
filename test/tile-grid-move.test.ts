/**
 * @fileoverview Moving tiles (owner request): a tile dragged by its header
 * onto another tile trades places with it, onto an empty slot it moves there.
 *
 * - One path for every move (`_reorderTiles`): the header drag, a tab dragged
 *   onto a tile or a slot, the Move Tile chords. Nothing is remounted,
 *   reconnected or reloaded (no new TerminalTile, no `connect()`, no fetch),
 *   no session joins or leaves, the grid stays open, the order is persisted.
 * - Divider sizes belong to the cells: a tile whose cell size changed fits
 *   once (one PTY resize, #464), every other tile is left alone.
 * - The header drag is native: Escape or a drop anywhere else ends in a
 *   `dragend` with no drop, which moves nothing and clears what the drag
 *   painted. It carries a type of its own (never text) and is not
 *   `draggedTabId`, so neither a text field nor the tab strip takes it. The
 *   drop targets hold it in the capture phase, before xterm.
 * - The handle is the header's free area: a press on a button or the rename
 *   input starts no drag, and a double-click on the name still renames.
 * - Moving is off while a tile is zoomed (the header drag, a tab drag of a
 *   tiled session, the chords) and with a single tile.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  fetchSpy,
  localStore,
  makeGridApp,
  resetGridHarness,
  section,
  type GridApp,
  tileEl,
} from './mocks/tile-grid-vm.js';

const FOUR = ['s-a', 's-b', 's-c', 's-d'];
const SIX = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'];
const TILE_TYPE = 'application/x-codeman-tile';

const headerOf = (id: string) => tileEl(id).children[0];
const actionsOf = (id: string) => headerOf(id).children[3];
const nameOf = (id: string) => headerOf(id).children[2].children[0];
const tile = (id: string) => FakeTile.all.find((t) => t.sessionId === id && !t._destroyed) as FakeTile;
const slots = () => section.children.filter((el) => el.className.split(' ').includes('tile-slot'));
const stored = () => JSON.parse(localStore.get('codeman:tile-grid') ?? 'null');

const dragEvent = () => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  dataTransfer: { effectAllowed: '', dropEffect: '', setData: vi.fn() },
});

/** A press on `target` inside the header (the capture-phase listener notes where), then the native dragstart. */
function startDrag(id: string, target: FakeEl = headerOf(id)) {
  headerOf(id).dispatch('pointerdown', { target, button: 0 });
  const start = dragEvent();
  headerOf(id).dispatch('dragstart', start);
  return start;
}
function over(el: FakeEl) {
  const e = dragEvent();
  el.dispatch('dragover', e);
  return e;
}
function drop(el: FakeEl) {
  const e = dragEvent();
  el.dispatch('drop', e);
  return e;
}
const end = (id: string) => headerOf(id).dispatch('dragend', dragEvent());

/** A full header drag: press, start, over and drop on `target`, end. */
function dragTileOnto(id: string, target: FakeEl) {
  const start = startDrag(id);
  const o = over(target);
  const d = drop(target);
  end(id);
  return { start, over: o, drop: d };
}

function openGrid(ids: string[], focusedId = ids[0]): GridApp {
  const app = makeGridApp(ids);
  app.openTileGrid(ids, { focusedId });
  return app;
}

/** What a move must never cost: a new tile, a connect, a destroy, a fetch. */
function snapshotCost() {
  const tiles = FakeTile.all.length;
  const connects = FakeTile.all.map((t) => t.connect.mock.calls.length);
  fetchSpy.mockClear();
  return () => {
    expect(FakeTile.all.length).toBe(tiles);
    expect(FakeTile.all.map((t) => t.connect.mock.calls.length)).toEqual(connects);
    expect(FakeTile.all.every((t) => t.destroy.mock.calls.length === 0)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  };
}
const clearFits = () => {
  for (const t of FakeTile.all) t.fit.mockClear();
};
const fitCounts = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, tile(id).fit.mock.calls.length]));

beforeEach(() => {
  resetGridHarness();
});

describe('dragging a tile by its header', () => {
  it('onto another tile: the two trade places, the dragged one takes focus, nothing remounts or reloads', () => {
    const app = openGrid(FOUR, 's-b');
    app.markIdleAlertSeen.mockClear();
    const costsNothing = snapshotCost();

    const start = startDrag('s-a');
    expect(start.preventDefault).not.toHaveBeenCalled();
    expect(tileEl('s-a').classList.contains('tile--dragging')).toBe(true);
    const o = over(tileEl('s-d'));
    expect(o.preventDefault).toHaveBeenCalled();
    expect(o.dataTransfer.dropEffect).toBe('move');
    expect(tileEl('s-d').classList.contains('tile--drop-target')).toBe(true);
    drop(tileEl('s-d'));
    end('s-a');

    expect(app._tileGrid.ids).toEqual(['s-d', 's-b', 's-c', 's-a']);
    expect([tileEl('s-a').style.gridColumn, tileEl('s-a').style.gridRow]).toEqual(['3', '3']);
    expect([tileEl('s-d').style.gridColumn, tileEl('s-d').style.gridRow]).toEqual(['1', '1']);
    costsNothing();
    expect(app._tilesOwnTerminal()).toBe(true);
    expect([...app._tileGrid.tiles.keys()].sort()).toEqual(FOUR);
    // A drag is a human action: the dropped tile takes focus, as a tab drop does.
    expect(app.activeSessionId).toBe('s-a');
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-a');
    // What the drag painted is gone.
    for (const id of FOUR) {
      expect(tileEl(id).classList.contains('tile--dragging')).toBe(false);
      expect(tileEl(id).classList.contains('tile--drop-target')).toBe(false);
    }
    expect(app._draggedTileId).toBeNull();
  });

  it('the new order is stored (ids only) and comes back on a reload', () => {
    const app = openGrid(FOUR);
    dragTileOnto('s-a', tileEl('s-c'));
    expect(stored().ids).toEqual(['s-c', 's-b', 's-a', 's-d']);
    expect(stored().focused).toBe('s-a');
    expect(stored().open).toBe(true);

    // A reload: a fresh page on the same device restores the stored grid.
    app._tileGrid.open = false;
    section.children = [];
    const reloaded = makeGridApp(FOUR);
    expect(reloaded._restoreTileGrid()).toBe(true);
    expect(reloaded._tileGrid.ids).toEqual(['s-c', 's-b', 's-a', 's-d']);
    expect(reloaded.activeSessionId).toBe('s-a');
  });

  describe('onto an empty slot', () => {
    // Under 1800px wide three tiles take a 2x2 with one empty slot, five a 3x2.
    beforeEach(() => {
      section.getBoundingClientRect = () => ({ width: 1700, height: 1000, top: 0, left: 0, right: 1700, bottom: 1000 });
    });
    afterEach(() => {
      delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
    });

    it('it moves there, the last cell (the tiles after it close up); the slot count stays', () => {
      const app = openGrid(['s-a', 's-b', 's-c']);
      const costsNothing = snapshotCost();
      expect(slots()).toHaveLength(1);
      dragTileOnto('s-a', slots()[0]);
      expect(app._tileGrid.ids).toEqual(['s-b', 's-c', 's-a']);
      expect([tileEl('s-a').style.gridColumn, tileEl('s-a').style.gridRow]).toEqual(['1', '3']);
      expect(slots()).toHaveLength(1);
      expect(slots()[0].classList.contains('tile--drop-target')).toBe(false);
      expect(app.activeSessionId).toBe('s-a');
      costsNothing();
      expect(stored().ids).toEqual(['s-b', 's-c', 's-a']);
    });
  });

  it('Escape, or a drop anywhere else, cancels: dragend with no drop moves nothing and clears what was painted', () => {
    const app = openGrid(FOUR);
    localStore.delete('codeman:tile-grid');
    const costsNothing = snapshotCost();
    clearFits();
    startDrag('s-a');
    over(tileEl('s-c'));
    // The browser cancels (Escape) or the pointer is released outside every
    // target: no drop, and not always a dragleave either.
    end('s-a');
    expect(app._tileGrid.ids).toEqual(FOUR);
    expect(tileEl('s-c').classList.contains('tile--drop-target')).toBe(false);
    expect(tileEl('s-a').classList.contains('tile--dragging')).toBe(false);
    expect(app._draggedTileId).toBeNull();
    expect(localStore.has('codeman:tile-grid')).toBe(false);
    expect(FakeTile.all.every((t) => t.fit.mock.calls.length === 0)).toBe(true);
    costsNothing();
    // The drag is over: a later drag that is neither a tab nor a tile (a file) is left alone.
    expect(over(tileEl('s-c')).preventDefault).not.toHaveBeenCalled();
  });

  it('carries a type of its own, never text, and is not a tab drag (the strip ignores it)', () => {
    const app = openGrid(FOUR);
    const start = startDrag('s-b');
    expect(start.dataTransfer.setData).toHaveBeenCalledWith(TILE_TYPE, 's-b');
    expect(start.dataTransfer.setData.mock.calls.every(([type]) => type === TILE_TYPE)).toBe(true);
    expect(start.dataTransfer.effectAllowed).toBe('move');
    expect(app.draggedTabId).toBeFalsy();
    end('s-b');
  });

  it('never reaches xterm: tiles and slots hold the drag in the capture phase and stop it', () => {
    openGrid(FOUR);
    for (const id of FOUR) {
      expect(tileEl(id).captureFlags.dragover).toEqual([true]);
      expect(tileEl(id).captureFlags.drop).toEqual([true]);
    }
    startDrag('s-a');
    const o = over(tileEl('s-b'));
    const d = drop(tileEl('s-b'));
    for (const e of [o, d]) {
      expect(e.preventDefault).toHaveBeenCalled();
      expect(e.stopPropagation).toHaveBeenCalled();
    }
    end('s-a');
  });

  it('over its own tile the drag is held there too (never reaching its xterm) but refused', () => {
    const app = openGrid(FOUR);
    startDrag('s-a');
    const o = over(tileEl('s-a'));
    expect(o.preventDefault).toHaveBeenCalled();
    expect(o.stopPropagation).toHaveBeenCalled();
    expect(o.dataTransfer.dropEffect).toBe('none');
    expect(tileEl('s-a').classList.contains('tile--drop-target')).toBe(false);
    drop(tileEl('s-a'));
    end('s-a');
    expect(app._tileGrid.ids).toEqual(FOUR);
  });

  it('a tile removed mid-drag, or the grid closed, ends the drag', () => {
    const app = openGrid(FOUR);
    startDrag('s-a');
    app.removeTile('s-a');
    expect(app._draggedTileId).toBeNull();
    expect(over(tileEl('s-b')).preventDefault).not.toHaveBeenCalled();

    startDrag('s-b');
    over(tileEl('s-c'));
    app.selectSession = vi.fn();
    app.closeTileGrid();
    expect(app._draggedTileId).toBeNull();
  });
});

describe('the handle', () => {
  it('is the header: draggable, with a tooltip that says so under the state', () => {
    const app = openGrid(FOUR);
    app._sidebarRichRow = () => ({ state: 'idle', pill: 'idle', since: { at: 1 } });
    app._mobileOverviewStampText = () => '3m';
    app._renderTileChrome();
    expect(headerOf('s-a').getAttribute('draggable')).toBe('true');
    expect(headerOf('s-a').title).toBe('idle 3m\nDrag to move the tile');
  });

  it('a press on a header button starts no drag (and a press on the free area after it does)', () => {
    const app = openGrid(FOUR);
    for (const button of actionsOf('s-a').children) {
      const start = startDrag('s-a', button);
      expect(start.preventDefault).toHaveBeenCalled();
      expect(app._draggedTileId).toBeFalsy();
      expect(tileEl('s-a').classList.contains('tile--dragging')).toBe(false);
    }
    const start = startDrag('s-a', nameOf('s-a'));
    expect(start.preventDefault).not.toHaveBeenCalled();
    expect(app._draggedTileId).toBe('s-a');
    end('s-a');
  });

  it('a double-click on the name still renames, and no drag starts while the input is there', () => {
    const app = openGrid(FOUR);
    app._queueInlineSessionName = vi.fn();
    nameOf('s-a').dispatch('dblclick', { stopPropagation: vi.fn() });
    const entry = app._tileGrid.tiles.get('s-a');
    expect(entry.renaming).toBe(true);
    expect(headerOf('s-a').getAttribute('draggable')).toBe('false');
    const input = headerOf('s-a').children[2].children[0];
    expect(input.className).toBe('tile-rename-input');
    // A press in the input, then a would-be drag.
    expect(startDrag('s-a', input).preventDefault).toHaveBeenCalled();
    expect(app._draggedTileId).toBeFalsy();
    input.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() });
    expect(entry.renaming).toBe(false);
    expect(headerOf('s-a').getAttribute('draggable')).toBe('true');
  });

  it('a single tile has nowhere to go: not draggable, no drag hint', () => {
    const app = openGrid(['s-a']);
    app._sidebarRichRow = () => ({ state: 'idle', pill: 'idle', since: { at: 1 } });
    app._mobileOverviewStampText = () => '3m';
    app._renderTileChrome();
    expect(headerOf('s-a').getAttribute('draggable')).toBe('false');
    expect(headerOf('s-a').title).toBe('idle 3m');
    expect(startDrag('s-a').preventDefault).toHaveBeenCalled();
  });
});

describe('while a tile is zoomed, moving is off', () => {
  it('no header drags (draggable off, no hint), and a drag that starts anyway is refused', () => {
    const app = openGrid(FOUR);
    app._sidebarRichRow = () => ({ state: 'idle', pill: 'idle', since: { at: 1 } });
    app._mobileOverviewStampText = () => '3m';
    app._renderTileChrome();
    app.zoomTile('s-a');
    for (const id of FOUR) {
      expect(headerOf(id).getAttribute('draggable')).toBe('false');
      expect(headerOf(id).title).toBe('idle 3m');
    }
    expect(startDrag('s-a').preventDefault).toHaveBeenCalled();
    expect(app._draggedTileId).toBeFalsy();

    app.zoomTile('s-a');
    expect(headerOf('s-a').getAttribute('draggable')).toBe('true');
  });

  it('a tab of a tiled session dropped on the zoomed tile moves nothing either', () => {
    const app = openGrid(FOUR);
    app.zoomTile('s-a');
    app.draggedTabId = 's-c';
    over(tileEl('s-a'));
    drop(tileEl('s-a'));
    expect(app._tileGrid.ids).toEqual(FOUR);
    expect(app._tileGrid.zoomedId).toBe('s-a');
  });

  it('an automatic zoom (the window too small for the tiles) counts too', () => {
    const app = openGrid(FOUR);
    section.getBoundingClientRect = () => ({ width: 700, height: 400, top: 0, left: 0, right: 700, bottom: 400 });
    app._applyTileLayout();
    delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
    expect(app._tileGrid.autoZoom).toBe(true);
    expect(headerOf('s-b').getAttribute('draggable')).toBe('false');
    expect(app._swapTiles('s-a', 's-b')).toBe(false);
    expect(app._tileGrid.ids).toEqual(FOUR);
  });
});

describe('sizes belong to the cells: only a tile whose size changed fits, once', () => {
  it('equal cells: a swap fits nothing (no PTY resize anywhere)', () => {
    const app = openGrid(SIX);
    clearFits();
    dragTileOnto('s-a', tileEl('s-f'));
    expect(app._tileGrid.ids).toEqual(['s-f', 's-b', 's-c', 's-d', 's-e', 's-a']);
    expect(FakeTile.all.every((t) => t.fit.mock.calls.length === 0)).toBe(true);
  });

  it('a wider first column: the two swapped tiles fit once each, the other four not at all', () => {
    const app = openGrid(SIX);
    app._tileGrid.colFr = [2, 1, 1];
    app._applyTileLayout();
    clearFits();
    dragTileOnto('s-a', tileEl('s-b'));
    expect(fitCounts(SIX)).toEqual({ 's-a': 1, 's-b': 1, 's-c': 0, 's-d': 0, 's-e': 0, 's-f': 0 });
    // The fractions stay with the columns.
    expect(app._tileGrid.colFr).toEqual([2, 1, 1]);
  });

  it('a swap between two cells of the same size fits nothing, whatever the other sizes', () => {
    const app = openGrid(SIX);
    app._tileGrid.colFr = [2, 1, 1];
    app._tileGrid.rowFr = [1, 3];
    app._applyTileLayout();
    clearFits();
    // s-c (column 2, row 0) and s-b (column 1, row 0): both 1 x 1.
    dragTileOnto('s-c', tileEl('s-b'));
    expect(FakeTile.all.every((t) => t.fit.mock.calls.length === 0)).toBe(true);
  });

  it('a move to the slot: every tile whose cell size changed fits once, the others not', () => {
    section.getBoundingClientRect = () => ({ width: 1700, height: 1000, top: 0, left: 0, right: 1700, bottom: 1000 });
    try {
      const five = SIX.slice(0, 5);
      const app = openGrid(five);
      app._tileGrid.colFr = [2, 1, 1];
      app._applyTileLayout();
      clearFits();
      dragTileOnto('s-a', slots()[0]);
      // [a b c / d e _] -> [b c d / e a _]: b (2 -> 1 wide), d (row 1 col 0 -> row 0 col 2: 2 -> 1),
      // e (1 -> 2) and a (2 -> 1) changed size; c (1 -> 1) did not.
      expect(app._tileGrid.ids).toEqual(['s-b', 's-c', 's-d', 's-e', 's-a']);
      expect(fitCounts(five)).toEqual({ 's-a': 1, 's-b': 1, 's-c': 0, 's-d': 1, 's-e': 1 });
    } finally {
      delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
    }
  });

  it('no debounced refit of every tile follows a move', async () => {
    const app = openGrid(SIX);
    app._tileGrid.colFr = [2, 1, 1];
    app._applyTileLayout();
    clearFits();
    dragTileOnto('s-a', tileEl('s-b'));
    // Past TILE_GRID_REFIT_MS (150ms): still only the two moved tiles.
    await new Promise((r) => setTimeout(r, 200));
    expect(fitCounts(SIX)).toEqual({ 's-a': 1, 's-b': 1, 's-c': 0, 's-d': 0, 's-e': 0, 's-f': 0 });
  });
});
