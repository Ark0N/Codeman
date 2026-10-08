/**
 * @fileoverview The tile count (owner decision 10): the pure helpers behind the
 * Tiles button's 2 / 4 / 6 right-click menu.
 *
 * - `sanitizeTileCount`: a remembered count is one of TILE_GRID_COUNTS, else
 *   the default (6).
 * - `tileGridSetForCount`: what the grid opens (or an open grid shows) trimmed
 *   or filled to N: trimmed from the end with the session to focus always
 *   kept, filled from the open sessions in tab order; fewer sessions than N
 *   give fewer tiles; never past the cap.
 * - `tileCellCols`: the column count a stored cell list was laid out with.
 * - `reformTileCells`: a count change is a shape change: kept tiles stay in
 *   their cells, the cell model's rule (fitTileCells) reshapes, joining tiles
 *   fill the empty cells in reading order, holes first.
 *
 * The helpers from constants.js as the shared harness loads them.
 * Port: N/A.
 */
import { describe, expect, it } from 'vitest';
import { windowStub } from './mocks/tile-grid-vm.js';

type Cells = (string | null)[];
type Helpers = {
  sanitizeTileCount(raw: unknown): number;
  tileCellCols(length: number): number;
  reformTileCells(cells: Cells, oldCols: number, keep: string[], add: string[], cols: number, rows: number): Cells;
  computeTileLayout(p: { count: number; width?: number }): { cols: number; rows: number };
  tileGridSetForCount(base: string[], all: string[], n: number, keepId?: string | null): string[];
  TILE_GRID_COUNTS: number[];
  TILE_GRID_COUNT_DEFAULT: number;
  TILE_GRID_MAX: number;
};
const T = windowStub.CodemanTileGrid as Helpers;
const all = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];

describe('sanitizeTileCount', () => {
  it('offers 2, 4 and 6, default 6', () => {
    expect(T.TILE_GRID_COUNTS).toEqual([2, 4, 6]);
    expect(T.TILE_GRID_COUNT_DEFAULT).toBe(6);
  });

  it('keeps a valid count, as a number or as stored text', () => {
    expect(T.sanitizeTileCount(2)).toBe(2);
    expect(T.sanitizeTileCount('4')).toBe(4);
    expect(T.sanitizeTileCount('6')).toBe(6);
  });

  it('anything else is the default', () => {
    for (const raw of [null, undefined, '', '3', 5, 9, 0, -2, 'six', '{}', NaN]) {
      expect(T.sanitizeTileCount(raw)).toBe(6);
    }
  });
});

describe('tileGridSetForCount', () => {
  it('fills from tab order after the base, skipping ones already in it', () => {
    expect(T.tileGridSetForCount(['t5', 't2'], all, 6)).toEqual(['t5', 't2', 't1', 't3', 't4', 't6']);
  });

  it('trims from the end', () => {
    expect(T.tileGridSetForCount(['t1', 't2', 't3', 't4', 't5', 't6'], all, 4)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('keeps the session to focus when it sat past N, in the last place', () => {
    expect(T.tileGridSetForCount(['t1', 't2', 't3', 't4', 't5', 't6'], all, 2, 't5')).toEqual(['t1', 't5']);
    expect(T.tileGridSetForCount(['t1', 't2', 't3', 't4'], all, 2, 't2')).toEqual(['t1', 't2']);
  });

  it('a base id is never trimmed in favour of a filler', () => {
    expect(T.tileGridSetForCount(['t7', 't8'], all, 2)).toEqual(['t7', 't8']);
  });

  it('fewer open sessions than N: fewer tiles', () => {
    expect(T.tileGridSetForCount(['t1'], ['t1', 't2', 't3'], 6)).toEqual(['t1', 't2', 't3']);
    expect(T.tileGridSetForCount([], [], 4)).toEqual([]);
  });

  it('never past the cap, and at least one', () => {
    expect(T.tileGridSetForCount([], all, 9)).toHaveLength(T.TILE_GRID_MAX);
    expect(T.tileGridSetForCount([], all, 0)).toEqual(['t1']);
  });

  it('drops duplicates and non-ids', () => {
    expect(T.tileGridSetForCount(['t2', 't2', '', null as unknown as string], all, 3)).toEqual(['t2', 't1', 't3']);
  });
});

describe('tileCellCols', () => {
  it('reads the shape back from the cell count, as the layout table lays it out', () => {
    expect([1, 2, 3, 4, 6, 9].map((n) => T.tileCellCols(n))).toEqual([1, 2, 3, 2, 3, 3]);
  });

  it('agrees with computeTileLayout for every count, wide and narrow', () => {
    for (let n = 1; n <= 9; n++) {
      for (const width of [Infinity, 0]) {
        const { cols, rows } = T.computeTileLayout({ count: n, width });
        expect(T.tileCellCols(cols * rows)).toBe(cols);
      }
    }
  });

  it('an unknown length is 0 (the tiles then pack)', () => {
    for (const n of [0, 5, 7, 8, 10, -1, NaN]) expect(T.tileCellCols(n)).toBe(0);
  });
});

describe('reformTileCells', () => {
  it('growing 2 (2x1) to 6 (3x2): both stay in their cells, the four new ones fill in reading order', () => {
    expect(T.reformTileCells(['a', 'b'], 2, ['a', 'b'], ['c', 'd', 'e', 'f'], 3, 2)).toEqual([
      'a', 'b', 'c',
      'd', 'e', 'f',
    ]);
  });

  it('growing fills the holes first, in reading order', () => {
    // 5 of a 3x2 with the hole in the middle of the first row, then 6.
    expect(T.reformTileCells(['a', null, 'b', 'c', 'd', 'e'], 3, ['a', 'b', 'c', 'd', 'e'], ['f'], 3, 2)).toEqual([
      'a', 'f', 'b',
      'c', 'd', 'e',
    ]);
    // 3 of a 2x2 (hole first) growing to 4 keeps the shape: the hole fills.
    expect(T.reformTileCells([null, 'a', 'b', 'c'], 2, ['a', 'b', 'c'], ['d'], 2, 2)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('a 2x2 growing to 3x2 keeps every tile at its row and column', () => {
    expect(T.reformTileCells(['a', 'b', 'c', 'd'], 2, ['a', 'b', 'c', 'd'], ['e', 'f'], 3, 2)).toEqual([
      'a', 'b', 'e',
      'c', 'd', 'f',
    ]);
  });

  it('shrinking 6 (3x2) to 4 (2x2): a tile in the third column does not fit, so the kept ones pack', () => {
    expect(T.reformTileCells(['a', 'b', 'c', 'd', 'e', 'f'], 3, ['a', 'b', 'c', 'd'], [], 2, 2)).toEqual([
      'a', 'b', 'c', 'd',
    ]);
  });

  it('shrinking keeps rows and columns when every kept tile still fits', () => {
    // 3x2 to 2x2 keeping two tiles inside the first two columns: they stay at
    // their row and column, holes and all (packing would move b up).
    expect(T.reformTileCells([null, 'a', 'x', 'b', null, 'y'], 3, ['a', 'b'], [], 2, 2)).toEqual([
      null, 'a',
      'b', null,
    ]);
    // 2x2 to 2x1 keeping the first row.
    expect(T.reformTileCells(['a', 'b', 'c', 'd'], 2, ['a', 'b'], [], 2, 1)).toEqual(['a', 'b']);
  });

  it('a stored grid of unknown shape (oldCols 0) packs', () => {
    expect(T.reformTileCells([null, 'a', 'b'], 0, ['a', 'b'], ['c'], 2, 2)).toEqual(['a', 'b', 'c', null]);
  });

  it('a full grid takes no more, and a tile already there is not added twice', () => {
    expect(T.reformTileCells(['a', 'b'], 2, ['a', 'b'], ['c', 'a'], 2, 1)).toEqual(['a', 'b']);
    expect(T.reformTileCells(['a', null], 2, ['a'], ['a', 'c'], 2, 1)).toEqual(['a', 'c']);
  });
});
