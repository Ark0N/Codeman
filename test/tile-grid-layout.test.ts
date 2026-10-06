/**
 * @fileoverview The tile grid's pure helpers (constants.js, `window.CodemanTileGrid`).
 *
 * - `computeTileLayout`: columns x rows by tile count (the spec's table), with
 *   the 3-tile special case (3x1 only on a wide grid area) and whether every
 *   cell clears the minimum tile size.
 * - `tileGridCapacity`: how many tiles a grid area can hold.
 * - `sanitizeTileGridState`: the stored `codeman:tile-grid` value made safe to
 *   apply (unknown, deleted, detached and duplicate ids dropped).
 * - `tileNeighbor`, `tileInDirection`, `cycleTile`: which tile takes focus when
 *   one leaves, on a directional chord, and on Ctrl+Tab / Alt+[ ].
 *
 * Loaded via `vm` like split-pane-helpers.test.ts. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Layout = { cols: number; rows: number; fits: boolean };
type TileGrid = {
  computeTileLayout(p: Record<string, number>): Layout;
  tileGridCapacity(p: Record<string, number>): number;
  sanitizeTileGridState(raw: unknown, live: unknown, detached?: Set<string>): Record<string, unknown> | null;
  tileNeighbor(ids: string[], id: string): string | null;
  tileInDirection(ids: string[], focused: string, dir: string, cols: number): string | null;
  cycleTile(ids: string[], focused: string, delta: number): string | null;
  TILE_GRID_MAX: number;
  TILE_LAYOUT_MAX: number;
  TILE_MIN_W: number;
  TILE_MIN_H: number;
  TILE_SCROLLBACK: number;
};

function loadTileGrid(): TileGrid {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanTileGrid: TileGrid }).CodemanTileGrid;
}

const T = loadTileGrid();
// Plenty of room: every layout fits.
const BIG = { width: 3000, height: 2000 };

describe('computeTileLayout', () => {
  it.each([
    [1, 1, 1],
    [2, 2, 1],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [7, 3, 3],
    [8, 3, 3],
    [9, 3, 3],
  ])('%i tiles lay out as %ix%i', (count, cols, rows) => {
    expect(T.computeTileLayout({ count, ...BIG })).toMatchObject({ cols, rows, fits: true });
  });

  it('puts 3 tiles side by side only on a grid area at least 1800px wide', () => {
    expect(T.computeTileLayout({ count: 3, width: 1800, height: 900 })).toMatchObject({ cols: 3, rows: 1 });
    expect(T.computeTileLayout({ count: 3, width: 1799, height: 900 })).toMatchObject({ cols: 2, rows: 2 });
  });

  it('lays out up to 9 (past the cap, unreachable but kept) and treats nothing as an empty grid', () => {
    expect(T.TILE_LAYOUT_MAX).toBe(9);
    expect(T.computeTileLayout({ count: 12, ...BIG })).toMatchObject({ cols: 3, rows: 3 });
    expect(T.computeTileLayout({ count: 0, ...BIG })).toMatchObject({ cols: 0, rows: 0 });
  });

  it('reports whether every cell clears the minimum tile size', () => {
    // 3x2 needs 3 * 480 = 1440 wide and 2 * 240 = 480 high.
    expect(T.computeTileLayout({ count: 6, width: 1440, height: 480 }).fits).toBe(true);
    expect(T.computeTileLayout({ count: 6, width: 1439, height: 480 }).fits).toBe(false);
    expect(T.computeTileLayout({ count: 6, width: 1440, height: 479 }).fits).toBe(false);
  });
});

describe('tileGridCapacity', () => {
  it('never holds more than the cap of 6 (owner decision 7), even where nine would fit', () => {
    expect(T.TILE_GRID_MAX).toBe(6);
    expect(T.computeTileLayout({ count: 9, ...BIG }).fits).toBe(true);
    expect(T.tileGridCapacity(BIG)).toBe(6);
  });

  it('stops at the first count whose layout does not fit', () => {
    // 1440 x 600: 3x2 fits (480 x 300) but 3x3 (480 x 200) does not.
    expect(T.tileGridCapacity({ width: 1440, height: 600 })).toBe(6);
    // 1200 x 900: 2x2 fits (600 x 450), 3x2 does not (400 wide).
    expect(T.tileGridCapacity({ width: 1200, height: 900 })).toBe(4);
    // 1000 x 400: 2x1 fits (500 x 400); three tiles take a 2x2 (200 high), which does not.
    expect(T.tileGridCapacity({ width: 1000, height: 400 })).toBe(2);
  });

  it('is 0 when not even one tile fits', () => {
    expect(T.tileGridCapacity({ width: 400, height: 900 })).toBe(0);
  });
});

describe('sanitizeTileGridState', () => {
  const live = new Map([
    ['a', {}],
    ['b', {}],
    ['c', {}],
    ['d', {}],
  ]);

  it('keeps a valid stored grid as it is', () => {
    const raw = { v: 1, open: true, ids: ['a', 'b'], focused: 'b', zoomed: 'a', colFr: [1, 2], rowFr: [1] };
    expect(T.sanitizeTileGridState(raw, live, new Set())).toEqual({
      v: 1,
      open: true,
      ids: ['a', 'b'],
      focused: 'b',
      zoomed: 'a',
      colFr: [1, 2],
      rowFr: [1],
    });
  });

  it('accepts the stored JSON string', () => {
    const raw = JSON.stringify({ v: 1, open: true, ids: ['c'], focused: 'c' });
    expect(T.sanitizeTileGridState(raw, live)?.ids).toEqual(['c']);
  });

  it('drops unknown (deleted), detached and duplicate ids', () => {
    const raw = { v: 1, open: true, ids: ['a', 'gone', 'b', 'a', 'c', 7, ''], focused: 'a' };
    const out = T.sanitizeTileGridState(raw, live, new Set(['b']));
    expect(out?.ids).toEqual(['a', 'c']);
  });

  it('moves focus to the first kept tile when the focused one was dropped, and drops a dropped zoom', () => {
    const raw = { v: 1, open: true, ids: ['gone', 'b', 'c'], focused: 'gone', zoomed: 'gone' };
    const out = T.sanitizeTileGridState(raw, live);
    expect(out?.focused).toBe('b');
    expect(out?.zoomed).toBeNull();
  });

  it('is closed when no tile survives', () => {
    const out = T.sanitizeTileGridState({ v: 1, open: true, ids: ['gone'] }, live);
    expect(out).toMatchObject({ open: false, ids: [], focused: null });
  });

  it('caps the list at the cap (6): the extras are dropped', () => {
    const many = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const out = T.sanitizeTileGridState({ v: 1, open: true, ids: many }, many);
    expect(out?.ids).toEqual(many.slice(0, 6));
  });

  it('a stored 3x3 keeps its focus if it survives the cap, and loses a zoom that did not', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `s${i}`);
    const kept = T.sanitizeTileGridState({ v: 1, open: true, ids: nine, focused: 's4', zoomed: 's7' }, nine);
    expect(kept).toMatchObject({ ids: nine.slice(0, 6), focused: 's4', zoomed: null });
    const lost = T.sanitizeTileGridState({ v: 1, open: true, ids: nine, focused: 's8', zoomed: 's2' }, nine);
    expect(lost).toMatchObject({ focused: 's0', zoomed: 's2' });
  });

  it('drops malformed track fractions', () => {
    const out = T.sanitizeTileGridState({ v: 1, open: true, ids: ['a'], colFr: [1, -1], rowFr: [1, 1, 1, 1] }, live);
    expect(out?.colFr).toBeNull();
    expect(out?.rowFr).toBeNull();
  });

  it.each([null, 'not json', '[]', 42, { v: 2, ids: ['a'] }, { ids: ['a'] }])('rejects %j', (raw) => {
    expect(T.sanitizeTileGridState(raw, live)).toBeNull();
  });
});

describe('focus helpers', () => {
  it('tileNeighbor prefers the next tile, then the previous one', () => {
    expect(T.tileNeighbor(['a', 'b', 'c'], 'b')).toBe('c');
    expect(T.tileNeighbor(['a', 'b', 'c'], 'c')).toBe('b');
    expect(T.tileNeighbor(['a'], 'a')).toBeNull();
  });

  it('tileInDirection moves within a row-major grid', () => {
    // 3x2:  a b c
    //       d e
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(T.tileInDirection(ids, 'b', 'left', 3)).toBe('a');
    expect(T.tileInDirection(ids, 'a', 'left', 3)).toBeNull();
    expect(T.tileInDirection(ids, 'b', 'right', 3)).toBe('c');
    expect(T.tileInDirection(ids, 'c', 'right', 3)).toBeNull();
    expect(T.tileInDirection(ids, 'e', 'right', 3)).toBeNull();
    expect(T.tileInDirection(ids, 'd', 'up', 3)).toBe('a');
    expect(T.tileInDirection(ids, 'a', 'up', 3)).toBeNull();
    expect(T.tileInDirection(ids, 'b', 'down', 3)).toBe('e');
    // Nothing below c in that column: the short last row's last tile.
    expect(T.tileInDirection(ids, 'c', 'down', 3)).toBe('e');
    expect(T.tileInDirection(ids, 'e', 'down', 3)).toBeNull();
  });

  it('cycleTile wraps in reading order', () => {
    expect(T.cycleTile(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(T.cycleTile(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(T.cycleTile([], 'a', 1)).toBeNull();
  });
});

describe('dragTrackFractions (divider drags)', () => {
  const drag = (fr: number[], i: number, d: number, total = 1200, min = 300) =>
    (T as unknown as { dragTrackFractions: (...a: unknown[]) => number[] }).dragTrackFractions(fr, i, d, total, min);
  const px = (fr: number[], total = 1200) => fr.map((f) => Math.round((f / fr.reduce((a, b) => a + b, 0)) * total));

  it('moves size from one neighbour to the other, the rest untouched', () => {
    // 3 equal tracks of 400px; divider 0 moves 100px right.
    expect(px(drag([1, 1, 1], 0, 100))).toEqual([500, 300, 400]);
    expect(px(drag([1, 1, 1], 1, -50))).toEqual([400, 350, 450]);
  });

  it('clamps both neighbours to the minimum size', () => {
    expect(px(drag([1, 1, 1], 0, 300))).toEqual([500, 300, 400]);
    expect(px(drag([1, 1, 1], 0, -300))).toEqual([300, 500, 400]);
  });

  it('a pair too small for two minimums splits evenly instead of inverting', () => {
    expect(px(drag([1, 1], 0, 200, 500, 300), 500)).toEqual([250, 250]);
  });

  it('works from the fractions the drag started with (no drift)', () => {
    const start = [2, 1];
    expect(px(drag(start, 0, 0))).toEqual([800, 400]);
    expect(start).toEqual([2, 1]);
  });

  it('ignores a divider that is not between two tracks', () => {
    expect(drag([1, 1], 1, 100)).toEqual([1, 1]);
  });
});

describe('tile constants', () => {
  it('a tile keeps 10,000 lines of scrollback, not the primary pane 50,000', () => {
    expect(T.TILE_SCROLLBACK).toBe(10000);
  });
});
