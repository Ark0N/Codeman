/**
 * @fileoverview Draggable column and row dividers.
 *
 * Every tile is placed explicitly (`grid-column` / `grid-row`, reading order),
 * with a divider track between columns and between rows. Dragging a divider
 * trades size between the two tracks either side, each kept at the minimum tile
 * size. The affected tiles reflow LOCALLY at most once per animation frame
 * (`localFit`, no PTY resize), and each hears exactly ONE `fit()` (one PTY
 * resize) at pointer-up; tiles in other tracks hear nothing. A drag in progress
 * is torn down when the grid closes or a tile is removed (the split's mid-drag
 * lesson). Fractions reset when the column or row count changes.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  body,
  makeGridApp,
  rafCallbacks,
  resetGridHarness,
  section,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const SIX = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'];
const tileEl = (id: string) => section.children.find((el) => el.dataset.sessionId === id) as FakeEl;
const divider = (app: GridApp, key: string) => app._tileGrid.dividers.get(key) as FakeEl;
const tile = (id: string) => FakeTile.all.find((t) => t.sessionId === id) as FakeTile;

function grid(ids: string[]): GridApp {
  const app = makeGridApp(ids);
  app.openTileGrid(ids);
  for (const t of FakeTile.all) {
    t.fit.mockClear();
    t.localFit.mockClear();
  }
  return app;
}

const runFrames = () => {
  for (const cb of rafCallbacks.splice(0)) cb();
};

beforeEach(() => {
  resetGridHarness();
});

describe('placement', () => {
  it('2x2: one column divider, one row divider, tiles placed in reading order', () => {
    const app = grid(['s-a', 's-b', 's-c', 's-d']);
    expect([...app._tileGrid.dividers.keys()].sort()).toEqual(['col-0', 'row-0']);
    expect(section.style.gridTemplateColumns).toBe('minmax(0, 1fr) 6px minmax(0, 1fr)');
    expect(section.style.gridTemplateRows).toBe('minmax(0, 1fr) 6px minmax(0, 1fr)');
    expect([tileEl('s-d').style.gridColumn, tileEl('s-d').style.gridRow]).toEqual(['3', '3']);
    expect([tileEl('s-b').style.gridColumn, tileEl('s-b').style.gridRow]).toEqual(['3', '1']);
    expect([divider(app, 'col-0').style.gridColumn, divider(app, 'col-0').style.gridRow]).toEqual(['2', '1 / -1']);
    expect([divider(app, 'row-0').style.gridColumn, divider(app, 'row-0').style.gridRow]).toEqual(['1 / -1', '2']);
  });

  it('3x2 has two column dividers; a single tile has none', () => {
    expect([...grid(SIX)._tileGrid.dividers.keys()].sort()).toEqual(['col-0', 'col-1', 'row-0']);
    resetGridHarness();
    expect(grid(['s-a'])._tileGrid.dividers.size).toBe(0);
  });

  it('dividers are separators a screen reader can name', () => {
    const app = grid(['s-a', 's-b']);
    const d = divider(app, 'col-0');
    expect(d.getAttribute('role')).toBe('separator');
    expect(d.getAttribute('aria-orientation')).toBe('vertical');
  });
});

describe('dragging', () => {
  function drag(app: GridApp, key: string, from: number, to: number[]) {
    const d = divider(app, key);
    const axisCol = key.startsWith('col');
    const at = (v: number) => (axisCol ? { clientX: v, clientY: 0 } : { clientX: 0, clientY: v });
    d.dispatch('pointerdown', {
      button: 0,
      pointerId: 7,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...at(from),
    });
    for (const v of to) d.dispatch('pointermove', at(v));
    return d;
  }

  it('reflows locally once per frame and resizes each affected PTY exactly once, at pointer-up', () => {
    const app = grid(SIX);
    const d = drag(app, 'col-1', 1600, [1620, 1640, 1660, 1680]);
    // Four moves, one frame.
    expect(rafCallbacks).toHaveLength(1);
    runFrames();
    // Column 1 and 2 tiles: b, c (row 0) and e, f (row 1).
    for (const id of ['s-b', 's-c', 's-e', 's-f']) expect(tile(id).localFit).toHaveBeenCalledTimes(1);
    expect(tile('s-a').localFit).not.toHaveBeenCalled();
    expect(FakeTile.all.every((t) => t.fit.mock.calls.length === 0)).toBe(true);

    d.dispatch('pointerup', {});
    for (const id of ['s-b', 's-c', 's-e', 's-f']) expect(tile(id).fit).toHaveBeenCalledTimes(1);
    expect(tile('s-a').fit).not.toHaveBeenCalled();
    expect(tile('s-d').fit).not.toHaveBeenCalled();
  });

  it('the frame still queued at pointer-up is applied, so the tracks end where the pointer did', () => {
    const app = grid(['s-a', 's-b']);
    const d = drag(app, 'col-0', 1200, [1300]);
    d.dispatch('pointerup', {});
    // 2400 wide, 8px padding, one 6px divider: 2386px shared; the left track gained 100px.
    const [a, b] = app._tileGrid.colFr;
    expect(Math.round((a / (a + b)) * 2386)).toBe(1293);
    expect(section.style.gridTemplateColumns).toMatch(/^minmax\(0, [\d.]+fr\) 6px minmax\(0, [\d.]+fr\)$/);
  });

  it('keeps both neighbours at the minimum tile size', () => {
    const app = grid(['s-a', 's-b']);
    const d = drag(app, 'col-0', 1200, [100]);
    d.dispatch('pointerup', {});
    const [a, b] = app._tileGrid.colFr;
    expect(Math.round((a / (a + b)) * 2386)).toBe(480);
  });

  it('a row divider moves rows and resizes the tiles in them', () => {
    const app = grid(['s-a', 's-b', 's-c', 's-d']);
    const d = drag(app, 'row-0', 600, [650]);
    d.dispatch('pointerup', {});
    for (const id of ['s-a', 's-b', 's-c', 's-d']) expect(tile(id).fit).toHaveBeenCalledTimes(1);
    expect(app._tileGrid.rowFr[0]).toBeGreaterThan(app._tileGrid.rowFr[1]);
  });

  it('locks the cursor and text selection for the drag, released at the end', () => {
    const app = grid(['s-a', 's-b']);
    const d = drag(app, 'col-0', 1200, []);
    expect(body.classList.contains('tile-grid-resizing')).toBe(true);
    expect(d.classList.contains('dragging')).toBe(true);
    d.dispatch('pointerup', {});
    expect(body.classList.contains('tile-grid-resizing')).toBe(false);
    expect(d.setPointerCapture).toHaveBeenCalledWith(7);
    expect(d.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});

describe('a drag torn down mid-way', () => {
  function startDrag(app: GridApp) {
    const d = divider(app, 'col-0');
    d.dispatch('pointerdown', {
      button: 0,
      pointerId: 1,
      clientX: 800,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    d.dispatch('pointermove', { clientX: 900 });
    return d;
  }

  it('closing the grid ends it: no body lock left behind, no late resize', () => {
    const app = grid(['s-a', 's-b']);
    app.selectSession = vi.fn();
    const d = startDrag(app);
    app.closeTileGrid({ reselect: false });
    expect(body.classList.contains('tile-grid-resizing')).toBe(false);
    expect(d.listeners.pointermove ?? []).toHaveLength(0);
    runFrames();
    d.dispatch('pointerup', {});
    expect(FakeTile.all.every((t) => t.fit.mock.calls.length === 0)).toBe(true);
  });

  it('removing a tile ends it', () => {
    const app = grid(['s-a', 's-b', 's-c']);
    startDrag(app);
    app.removeTile('s-c');
    expect(body.classList.contains('tile-grid-resizing')).toBe(false);
    expect(app._tileDividerDragTeardown ?? null).toBeNull();
  });
});

describe('fractions', () => {
  it('reset to equal when the column count changes', () => {
    const app = grid(['s-a', 's-b', 's-c', 's-d']);
    app._tileGrid.colFr = [3, 1];
    app._applyTileLayout();
    expect(app._tileGrid.colFr).toEqual([3, 1]);
    app.sessions.set('s-e', { id: 's-e', name: 's-e', mode: 'claude', pid: 1 });
    app.addTile('s-e');
    expect(app._tileGrid.colFr).toEqual([1, 1, 1]);
  });
});

describe('fractions on fewer columns', () => {
  it('reset to equal when the column count drops (no stale track left over)', () => {
    const app = grid(['s-a', 's-b', 's-c', 's-d', 's-e']);
    app._tileGrid.colFr = [3, 1, 1];
    app.removeTile('s-e');
    expect(app._tileGrid.colFr).toEqual([1, 1]);
    expect(section.style.gridTemplateColumns).toBe('minmax(0, 1fr) 6px minmax(0, 1fr)');
  });
});

describe('zoomed', () => {
  it('shows no dividers', () => {
    const app = grid(['s-a', 's-b', 's-c', 's-d']);
    app.zoomTile('s-a');
    expect(app._tileGrid.dividers.size).toBe(0);
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    expect(css).toMatch(/\.tile-grid\.tile-grid--zoomed \.tile-divider\s*\{\s*display: none;/);
  });
});
