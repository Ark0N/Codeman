/**
 * @fileoverview Moving tiles (owner request): a tile dragged by its header
 * onto another tile trades places with it.
 *
 * - One path for every move (`_reorderTiles`): the header drag, a tab dragged
 *   onto a tile or a slot, the Move Tile chords. Nothing is remounted,
 *   reconnected or reloaded (no new TerminalTile, no `connect()`, no fetch),
 *   no session joins or leaves, the grid stays open, the order is persisted.
 * - Divider sizes belong to the cells: a tile whose cell size changed fits
 *   once (one PTY resize, #464), every other tile is left alone.
 * - An empty slot refuses a tile (its header drag or its tab): owner, "dont
 *   move the tile" (a slot is always the last cell, so a move there shifted
 *   every tile after it). A session not tiled yet still joins there.
 * - The header focuses its tile on click, never on a press (the body keeps
 *   press-to-focus), so a drag that is cancelled changes nothing, focus and
 *   idle alert included (owner: best practice).
 * - The header drag is native: Escape or a drop anywhere else ends in a
 *   `dragend` with no drop, which moves nothing and clears what the drag
 *   painted. It carries a type of its own (never text) and is not
 *   `draggedTabId`, so neither a text field nor the tab strip takes it. The
 *   drop targets hold it in the capture phase, before xterm.
 * - The handle is the header's free area: a press on a button or the rename
 *   input starts no drag, and a double-click on the name still renames.
 * - Moving is off while a tile is zoomed (the header drag, a tab drag of a
 *   tiled session, the chords) and with a single tile.
 * - Move Tile Left/Right/Up/Down (Ctrl+Shift+Arrows): the focused tile trades
 *   places with the neighbour the Alt+Shift+Arrow focus chords pick, checked
 *   against hand-written tables for every cell and direction of 2x1, 2x2, 3x2
 *   and the partial 2x2 and 3x2; focus stays on the moved tile. The chords
 *   apply (and are swallowed) only while the grid is open, zoomed included as a
 *   no-op, and never in a text field, where Ctrl+Shift+Arrows select by word
 *   (the focus chords skip text fields too: tile-grid-shortcuts.test.ts).
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  documentAddEventListener,
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

    // Owner: an empty cell can be any cell, and a tile dragged onto one moves
    // THERE, leaving its own cell empty; nothing else moves.
    const LAYOUTS = [
      { name: '2x2 with 3 tiles', ids: ['s-a', 's-b', 's-c'], cells: 4 },
      { name: '3x2 with 5 tiles', ids: SIX.slice(0, 5), cells: 6 },
    ];
    for (const layout of LAYOUTS) {
      it(`${layout.name}: from every cell into the hole wherever it is, by header drag`, () => {
        const bad: string[] = [];
        for (let hole = 0; hole < layout.cells; hole++) {
          for (let from = 0; from < layout.cells; from++) {
            if (from === hole) continue;
            resetGridHarness();
            section.getBoundingClientRect = () => ({
              width: 1700,
              height: 1000,
              top: 0,
              left: 0,
              right: 1700,
              bottom: 1000,
            });
            const app = openGrid(layout.ids, layout.ids[0]);
            const cells: Array<string | null> = layout.ids.slice();
            cells.splice(hole, 0, null);
            app._tileGrid.cells = cells.slice(0, layout.cells);
            app._applyTileLayout();
            const moved = app._tileGrid.cells[from];
            const costsNothing = snapshotCost();
            expect(slots()).toHaveLength(1);
            expect(slots()[0].dataset.cell).toBe(String(hole));
            const { over: o } = dragTileOnto(moved, slots()[0]);
            const expected = app._tileGrid.cells.slice();
            const want = cells.slice(0, layout.cells);
            want[hole] = moved;
            want[from] = null;
            const ok =
              JSON.stringify(expected) === JSON.stringify(want) &&
              o.dataTransfer.dropEffect === 'move' &&
              app.activeSessionId === moved &&
              JSON.stringify(stored().ids) === JSON.stringify(want) &&
              slots().length === 1 &&
              slots()[0].dataset.cell === String(from);
            if (!ok) bad.push(`hole ${hole} from ${from}: got ${JSON.stringify(expected)}`);
            costsNothing();
          }
        }
        expect(bad).toEqual([]);
      });
    }

    it('the moved tile sits in the hole (its grid place), and the slot takes its old place', () => {
      const app = openGrid(SIX.slice(0, 5));
      // [a b c / d e _]: c into the hole below it.
      dragTileOnto('s-c', slots()[0]);
      expect(app._tileGrid.cells).toEqual(['s-a', 's-b', null, 's-d', 's-e', 's-c']);
      expect([tileEl('s-c').style.gridColumn, tileEl('s-c').style.gridRow]).toEqual(['5', '3']);
      expect([slots()[0].style.gridColumn, slots()[0].style.gridRow]).toEqual(['5', '1']);
      expect(slots()[0].classList.contains('tile--drop-target')).toBe(false);
    });

    it('a tab of a tiled session moves the same way; a session not tiled yet joins in THAT cell', () => {
      const app = openGrid(SIX.slice(0, 5));
      app._tileGrid.cells = ['s-a', null, 's-b', 's-c', 's-d', 's-e'];
      app._applyTileLayout();
      app.draggedTabId = 's-e';
      drop(slots()[0]);
      expect(app._tileGrid.cells).toEqual(['s-a', 's-e', 's-b', 's-c', 's-d', null]);
      app.draggedTabId = 's-other';
      expect(over(slots()[0]).dataTransfer.dropEffect).toBe('move');
      drop(slots()[0]);
      expect(app._tileGrid.cells).toEqual(['s-a', 's-e', 's-b', 's-c', 's-d', 's-other']);
      expect(app.activeSessionId).toBe('s-other');
    });

    it('while a tile is zoomed there is no slot, and a move into a hole is refused', () => {
      const app = openGrid(SIX.slice(0, 5));
      app.zoomTile('s-a');
      expect(slots()).toHaveLength(0);
      expect(app._moveTileToCell('s-b', 5)).toBe(false);
      expect(app._tileGrid.cells).toEqual([...SIX.slice(0, 5), null]);
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

describe('focus: the header focuses its tile on click, so a cancelled drag changes nothing', () => {
  it('a press on the header does not focus the tile; a click does (a human selection)', () => {
    const app = openGrid(FOUR, 's-a');
    app.markIdleAlertSeen.mockClear();
    tileEl('s-c').dispatch('pointerdown', { target: nameOf('s-c'), button: 0 });
    tileEl('s-c').dispatch('pointerdown', { target: headerOf('s-c'), button: 0 });
    expect(app.activeSessionId).toBe('s-a');
    headerOf('s-c').dispatch('click', {});
    expect(app.activeSessionId).toBe('s-c');
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-c');
  });

  it('a press in the body still focuses at once (before the press reaches xterm)', () => {
    const app = openGrid(FOUR, 's-a');
    tileEl('s-c').dispatch('pointerdown', { target: tileEl('s-c').children[1], button: 0 });
    expect(app.activeSessionId).toBe('s-c');
  });

  it('a drag of an unfocused tile that is cancelled leaves focus and its alert alone', () => {
    const app = openGrid(FOUR, 's-a');
    app.markIdleAlertSeen.mockClear();
    tileEl('s-c').dispatch('pointerdown', { target: headerOf('s-c'), button: 0 });
    startDrag('s-c');
    over(tileEl('s-b'));
    end('s-c');
    expect(app._tileGrid.ids).toEqual(FOUR);
    expect(app.activeSessionId).toBe('s-a');
    expect(app._tileGrid.focusedId).toBe('s-a');
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });

  it('a double-click on the name leaves the keyboard in the rename input, and its clicks stay in it', () => {
    const app = openGrid(FOUR, 's-a');
    app._queueInlineSessionName = vi.fn();
    // The browser's sequence: click, click, dblclick.
    headerOf('s-c').dispatch('click', {});
    headerOf('s-c').dispatch('click', {});
    nameOf('s-c').dispatch('dblclick', { stopPropagation: vi.fn() });
    const input = headerOf('s-c').children[2].children[0];
    expect(input.className).toBe('tile-rename-input');
    const terminalFocus = tile('s-c').terminal.focus.mock.invocationCallOrder;
    expect(input.focus).toHaveBeenCalled();
    expect(input.focus.mock.invocationCallOrder.at(-1)).toBeGreaterThan(terminalFocus.at(-1) ?? 0);
    const click = { stopPropagation: vi.fn() };
    input.dispatch('click', click);
    expect(click.stopPropagation).toHaveBeenCalled();
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

  it('a swap across rows of different heights: the two moved tiles fit, the rest not', () => {
    section.getBoundingClientRect = () => ({ width: 1700, height: 1000, top: 0, left: 0, right: 1700, bottom: 1000 });
    try {
      const five = SIX.slice(0, 5);
      const app = openGrid(five);
      app._tileGrid.rowFr = [3, 1];
      app._applyTileLayout();
      clearFits();
      // [a b c / d e _]: a (row 0) and e (row 1) trade places and heights.
      dragTileOnto('s-a', tileEl('s-e'));
      expect(app._tileGrid.ids).toEqual(['s-e', 's-b', 's-c', 's-d', 's-a']);
      expect(fitCounts(five)).toEqual({ 's-a': 1, 's-b': 0, 's-c': 0, 's-d': 0, 's-e': 1 });
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

describe('Move Tile Left/Right/Up/Down (Ctrl+Shift+Arrows)', () => {
  const ARROW = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' } as const;
  type Dir = keyof typeof ARROW;
  const chord = (dir: Dir, overrides: Record<string, unknown> = {}) => ({
    type: 'keydown',
    key: ARROW[dir],
    code: ARROW[dir],
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    target: { closest: () => null, classList: { contains: (c: string) => c === 'xterm-helper-textarea' } },
    ...overrides,
  });

  function handlerFor(app: GridApp) {
    app.$ = () => null;
    app.setupColorPicker = vi.fn();
    const before = (documentAddEventListener.mock.calls as unknown[]).length;
    app.setupEventListeners();
    const added = (documentAddEventListener.mock.calls as Array<[string, (e: unknown) => void, boolean]>).slice(before);
    const keydown = added.find(([type, , capture]) => type === 'keydown' && capture === true);
    if (!keydown) throw new Error('no capture-phase keydown listener');
    return keydown[1];
  }

  // The cell next to each cell in each direction, written out by hand (null:
  // an edge). A move goes to that cell: a swap when a tile is there, a move
  // into it when it is empty (the partial layouts below).
  const TABLES: Record<
    string,
    { ids: string[]; cols: number; width?: number; next: Array<Record<Dir, number | null>> }
  > = {
    '2x1': {
      cols: 2,
      ids: ['s-a', 's-b'],
      next: [
        { left: null, right: 1, up: null, down: null },
        { left: 0, right: null, up: null, down: null },
      ],
    },
    '2x2': {
      cols: 2,
      ids: FOUR,
      next: [
        { left: null, right: 1, up: null, down: 2 },
        { left: 0, right: null, up: null, down: 3 },
        { left: null, right: 3, up: 0, down: null },
        { left: 2, right: null, up: 1, down: null },
      ],
    },
    '3x2': {
      cols: 3,
      ids: SIX,
      next: [
        { left: null, right: 1, up: null, down: 3 },
        { left: 0, right: 2, up: null, down: 4 },
        { left: 1, right: null, up: null, down: 5 },
        { left: null, right: 4, up: 0, down: null },
        { left: 3, right: 5, up: 1, down: null },
        { left: 4, right: null, up: 2, down: null },
      ],
    },
  };

  afterEach(() => {
    delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
  });

  for (const [layout, table] of Object.entries(TABLES)) {
    it(`${layout}: every cell, every direction, swaps with the right neighbour (or nothing at an edge)`, () => {
      const bad: string[] = [];
      table.next.forEach((next, i) => {
        for (const dir of Object.keys(ARROW) as Dir[]) {
          resetGridHarness();
          if (table.width) {
            const w = table.width;
            section.getBoundingClientRect = () => ({ width: w, height: 1000, top: 0, left: 0, right: w, bottom: 1000 });
          }
          const app = openGrid(table.ids, table.ids[i]);
          expect(app._tileGrid.cols).toBe(table.cols);
          const costsNothing = snapshotCost();
          app.markIdleAlertSeen.mockClear();
          const onKeydown = handlerFor(app);
          const e = chord(dir);
          onKeydown(e);
          const expected = table.ids.slice();
          const j = next[dir];
          if (j !== null) [expected[i], expected[j]] = [expected[j], expected[i]];
          const moved = table.ids[i];
          const ok =
            e.preventDefault.mock.calls.length === 1 &&
            JSON.stringify(app._tileGrid.ids) === JSON.stringify(expected) &&
            app.activeSessionId === moved &&
            app._tileGrid.focusedId === moved &&
            tileEl(moved).classList.contains('focused') &&
            JSON.stringify(stored().ids) === JSON.stringify(expected) &&
            stored().focused === moved;
          if (!ok) bad.push(`cell ${i} ${dir}: got ${app._tileGrid.ids.join(',')} focus ${app.activeSessionId}`);
          costsNothing();
          // Equal cells: nothing changed size, so nothing fits.
          expect(FakeTile.all.every((t) => t.fit.mock.calls.length === 0)).toBe(true);
        }
      });
      expect(bad).toEqual([]);
    });
  }

  // Owner: an empty cell can be any cell. With the hole in every cell in turn,
  // every tile and every direction: into the hole, or a swap, or nothing.
  const HOLED = [
    { name: '2x2 with 3 tiles', ids: ['s-a', 's-b', 's-c'], adjacency: TABLES['2x2'].next },
    { name: '3x2 with 5 tiles', ids: SIX.slice(0, 5), adjacency: TABLES['3x2'].next },
  ];
  for (const layout of HOLED) {
    it(`${layout.name}: with the hole anywhere, every tile, every direction (into the hole, a swap, or nothing)`, () => {
      const bad: string[] = [];
      const size = layout.adjacency.length;
      for (let hole = 0; hole < size; hole++) {
        const cells: Array<string | null> = layout.ids.slice();
        cells.splice(hole, 0, null);
        for (let i = 0; i < size; i++) {
          if (i === hole) continue;
          for (const dir of Object.keys(ARROW) as Dir[]) {
            resetGridHarness();
            section.getBoundingClientRect = () => ({
              width: 1700,
              height: 1000,
              top: 0,
              left: 0,
              right: 1700,
              bottom: 1000,
            });
            const moved = cells[i] as string;
            const app = openGrid(layout.ids, moved);
            app._tileGrid.cells = cells.slice();
            app._applyTileLayout();
            const costsNothing = snapshotCost();
            const e = chord(dir);
            handlerFor(app)(e);
            const want = cells.slice();
            const j = layout.adjacency[i][dir];
            if (j !== null) [want[i], want[j]] = [want[j], want[i]];
            const ok =
              e.preventDefault.mock.calls.length === 1 &&
              JSON.stringify(app._tileGrid.cells) === JSON.stringify(want) &&
              app.activeSessionId === moved &&
              app._tileGrid.focusedId === moved &&
              JSON.stringify(stored().ids) === JSON.stringify(want);
            if (!ok) bad.push(`hole ${hole}, cell ${i} ${dir}: got ${JSON.stringify(app._tileGrid.cells)}`);
            costsNothing();
            expect(FakeTile.all.every((t) => t.fit.mock.calls.length === 0)).toBe(true);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('a move into a hole across columns of different widths: only the moved tile fits, once', () => {
    section.getBoundingClientRect = () => ({ width: 1700, height: 1000, top: 0, left: 0, right: 1700, bottom: 1000 });
    const five = SIX.slice(0, 5);
    const app = openGrid(five, 's-b');
    app._tileGrid.colFr = [1, 1, 2];
    app._applyTileLayout();
    clearFits();
    // [a b c / d e _]: b (column 1) down into... e is there; first move e right into the hole.
    app._selectTiledSession('s-e', { auto: true });
    handlerFor(app)(chord('right'));
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', 's-d', null, 's-e']);
    expect(fitCounts(five)).toEqual({ 's-a': 0, 's-b': 0, 's-c': 0, 's-d': 0, 's-e': 1 });
  });

  it('focus stays on the moved tile through several moves, and the order is stored', () => {
    const app = openGrid(SIX, 's-a');
    const onKeydown = handlerFor(app);
    for (const dir of ['right', 'right', 'down', 'left'] as Dir[]) onKeydown(chord(dir));
    // a: 0 -> 1 -> 2 -> 5 -> 4
    expect(app._tileGrid.ids.indexOf('s-a')).toBe(4);
    expect(app.activeSessionId).toBe('s-a');
    expect(stored().ids).toEqual(app._tileGrid.ids);
    expect(stored().focused).toBe('s-a');
  });

  it('only a tile whose cell size changed fits, once', () => {
    const app = openGrid(SIX, 's-a');
    app._tileGrid.colFr = [2, 1, 1];
    app._applyTileLayout();
    clearFits();
    handlerFor(app)(chord('right'));
    expect(fitCounts(SIX)).toEqual({ 's-a': 1, 's-b': 1, 's-c': 0, 's-d': 0, 's-e': 0, 's-f': 0 });
  });

  describe('swallowed only while they apply', () => {
    it('grid closed: not a tile chord, and the capture handler leaves it alone (it reaches the terminal)', () => {
      const app = makeGridApp(FOUR);
      // Even with the Tiles setting on (where the toggle chord would apply).
      app.loadAppSettingsFromStorage = () => ({ showTileGridButton: true });
      expect(app.tileShortcutFor(chord('right'))).toBeNull();
      const e = chord('right');
      handlerFor(app)(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('grid open, from a terminal: applies and is swallowed', () => {
      const app = openGrid(FOUR);
      expect(app.tileShortcutFor(chord('right'))).toBe('move-tile-right');
      expect(app.tileShortcutFor(chord('down'))).toBe('move-tile-down');
    });

    it('in a text field (the rename input, an editor) it is left to the field: word selection', () => {
      const app = openGrid(FOUR);
      const onKeydown = handlerFor(app);
      for (const tagName of ['INPUT', 'TEXTAREA']) {
        const e = chord('right', { target: { tagName, closest: () => null, classList: { contains: () => false } } });
        expect(app.tileShortcutFor(e)).toBeNull();
        onKeydown(e);
        expect(e.preventDefault).not.toHaveBeenCalled();
      }
      const editable = chord('left', { target: { isContentEditable: true, closest: () => null } });
      expect(app.tileShortcutFor(editable)).toBeNull();
      expect(app._tileGrid.ids).toEqual(FOUR);
    });

    it('while a tile is zoomed it still applies (swallowed, never typed into the CLI) and moves nothing', () => {
      const app = openGrid(FOUR);
      app.zoomTile('s-a');
      const e = chord('right');
      expect(app.tileShortcutFor(e)).toBe('move-tile-right');
      handlerFor(app)(e);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(app._tileGrid.ids).toEqual(FOUR);
      expect(app._tileGrid.zoomedId).toBe('s-a');
    });

    it('honours a disable and a rebind from App Settings', () => {
      const app = openGrid(FOUR);
      app.loadAppSettingsFromStorage = () => ({
        shortcutOverrides: {
          'move-tile-right': { disabled: true },
          'move-tile-left': { bindings: [{ modifiers: ['ctrl', 'alt'], key: 'h', code: 'KeyH' }] },
        },
      });
      expect(app.tileShortcutFor(chord('right'))).toBeNull();
      expect(app.tileShortcutFor(chord('left'))).toBeNull();
      expect(app.tileShortcutFor(chord('left', { key: 'h', code: 'KeyH', shiftKey: false, altKey: true }))).toBe(
        'move-tile-left'
      );
    });
  });
});
