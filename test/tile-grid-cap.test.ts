/**
 * @fileoverview The grid holds at most TILE_GRID_MAX tiles: 6, owner decision 7
 * (docs/tile-grid-plan.md). Six was tested smooth on a real desktop; nine missed
 * the headless frame bar. The layout table still covers 7 to 9 (unreachable).
 *
 * Every way into the grid stops at the cap even where the window would fit
 * nine (the harness window is 2400x1200): opening, adding, a session Run
 * makes, Ctrl/Cmd+click, the count menu and "Open group as tiles".
 * The texts say which limit binds: "at most 6" for the cap, "what this window
 * fits" for a smaller window.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEl, body, bySelector, makeGridApp, resetGridHarness, type GridApp } from './mocks/tile-grid-vm.js';

const EIGHT = Array.from({ length: 8 }, (_, i) => `s-${i + 1}`);
const SIX = EIGHT.slice(0, 6);
const AT_MOST = 'The grid holds at most 6 tiles';

let wrapRect = { width: 2400, height: 1200 };
beforeEach(() => {
  resetGridHarness();
  wrapRect = { width: 2400, height: 1200 };
  const wrap = new FakeEl();
  wrap.getBoundingClientRect = () => ({ ...wrapRect, top: 0, left: 0, right: wrapRect.width, bottom: wrapRect.height });
  bySelector.set('.terminal-wrap', wrap);
});

function fullGrid(): GridApp {
  const app = makeGridApp(EIGHT);
  app.openTileGrid(EIGHT);
  return app;
}

describe('the cap', () => {
  it('is 6, worded as the cap where the window would fit more', () => {
    const app = makeGridApp(EIGHT);
    expect(app._tileGridLimit()).toEqual({ capacity: 6, full: AT_MOST });
  });

  it('a smaller window is worded by the window', () => {
    const app = makeGridApp(EIGHT);
    wrapRect = { width: 1200, height: 900 };
    expect(app._tileGridLimit()).toEqual({
      capacity: 4,
      full: 'The grid already holds what this window fits (4)',
    });
  });

  it('opening on eight sessions shows the first six', () => {
    const app = fullGrid();
    expect(app._tileGrid.ids).toEqual(SIX);
    expect(app._tileGrid.tiles.size).toBe(6);
  });

  it('a full grid takes no more tiles', () => {
    const app = fullGrid();
    expect(app.addTile('s-7')).toBe(false);
    expect(app._tileGrid.ids).toEqual(SIX);
  });
});

describe('every way in stops at the cap', () => {
  it('a session Run makes opens on its own, with a toast', () => {
    const app = fullGrid();
    expect(app._joinTileGridFromRun('s-7')).toBe(false);
    expect(app._tileGrid.ids).toEqual(SIX);
    expect(app.showToast).toHaveBeenCalledWith(`${AT_MOST}: the new session opens on its own`, 'info');
  });

  it('Ctrl/Cmd+click on another tab says the grid is full', () => {
    const app = fullGrid();
    expect(app.addSessionToTiles('s-7')).toBe(true);
    expect(app._tileGrid.ids).toEqual(SIX);
    expect(app.showToast).toHaveBeenCalledWith(AT_MOST, 'info');
  });

  it('the count menu offers nothing past the cap, and its 6 opens six of eight', () => {
    const app = makeGridApp(EIGHT);
    app.openTileCountMenu({ preventDefault: vi.fn() });
    const menu = body.children.find((c) => c.id === 'tileCountMenu')!;
    const items = menu.children.filter((c) => c.attrs.role === 'menuitemradio');
    expect(items.map((i) => Number(i.dataset.count))).toEqual([2, 4, 6]);
    // The cap binds, not the window: nothing greyed out, no "fits" line.
    expect(items.every((i) => !i.disabled)).toBe(true);
    expect(menu.children.some((c) => c.className === 'tile-count-hint')).toBe(false);
    items.at(-1)!.dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.ids).toHaveLength(6);
    expect(app._tileGrid.ids).toEqual(['s-other', ...EIGHT.slice(0, 5)]);
  });

  it('"Open group as tiles" shows the first six of a larger group', () => {
    const app = makeGridApp(EIGHT);
    app.tabLayout = { groups: [{ id: 'g', name: 'G', refs: EIGHT.map((id) => ({ kind: 'session', id })) }] };
    app.openGroupAsTiles('g');
    expect(app._tileGrid.ids).toEqual(SIX);
  });
});
