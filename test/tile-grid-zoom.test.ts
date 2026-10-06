/**
 * @fileoverview Zooming a tile (tmux zoom).
 *
 * `⤢` (or Alt+Shift+Enter) makes one tile fill the grid; the others stay
 * connected but hidden, so they measure nothing and send no resize. Pressing it
 * again restores the grid, and every tile is refitted (the hidden ones have a
 * stale size). Moving focus to another tile restores the grid, as selecting a
 * pane does in tmux; removing the zoomed tile does too.
 *
 * When the window cannot fit the tiles' minimum size, the grid zooms the
 * focused tile by itself, with a hint; that automatic zoom follows focus and
 * lifts once the window fits again. A zoom the user chose is left alone.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEl, FakeTile, makeGridApp, resetGridHarness, section, type GridApp } from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c', 's-d'];
const tileEl = (id: string) => section.children.find((el) => el.dataset.sessionId === id) as FakeEl;
const zoomButton = (id: string) =>
  tileEl(id).children[0].children[2].children.find((b) => b.className.includes('tile-zoom')) as FakeEl;

function openGrid(ids = IDS, focus = ids[0]): GridApp {
  const app = makeGridApp(ids);
  app.openTileGrid(ids, { focusedId: focus });
  app.markIdleAlertSeen.mockClear();
  // selectSession is real: a tiled id goes to the tile branch.
  return app;
}

/** Runs the trailing refit (and its layout pass). */
function settleRefit() {
  vi.advanceTimersByTime(200);
}

beforeEach(() => {
  resetGridHarness();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
});

describe('zoom and restore', () => {
  it('⤢ fills the grid with that tile; the others are hidden, not disconnected', () => {
    const app = openGrid();
    zoomButton('s-a').dispatch('click', { stopPropagation: vi.fn() });

    expect(app._tileGrid.zoomedId).toBe('s-a');
    expect(section.classList.contains('tile-grid--zoomed')).toBe(true);
    expect(tileEl('s-a').classList.contains('tile--zoomed')).toBe(true);
    expect(tileEl('s-b').classList.contains('tile--zoomed')).toBe(false);
    expect(section.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(section.style.gridTemplateRows).toBe('minmax(0, 1fr)');
    expect(FakeTile.all.every((t) => t.destroy.mock.calls.length === 0)).toBe(true);
    expect(zoomButton('s-a').getAttribute('aria-pressed')).toBe('true');
  });

  it('pressing it again restores the grid and refits EVERY tile', () => {
    const app = openGrid();
    app.zoomTile('s-a');
    settleRefit();
    for (const t of FakeTile.all) t.fit.mockClear();
    app.zoomTile('s-a');
    settleRefit();

    expect(app._tileGrid.zoomedId).toBeNull();
    expect(section.classList.contains('tile-grid--zoomed')).toBe(false);
    expect(section.style.gridTemplateColumns).toBe('minmax(0, 1fr) 6px minmax(0, 1fr)');
    expect(FakeTile.all.every((t) => t.fit.mock.calls.length === 1)).toBe(true);
    expect(zoomButton('s-a').getAttribute('aria-pressed')).toBe('false');
  });

  it('zooming a tile that is not focused focuses it first, as a human selection', () => {
    const app = openGrid();
    app.zoomTile('s-c');
    expect(app.activeSessionId).toBe('s-c');
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-c');
    expect(app._tileGrid.zoomedId).toBe('s-c');
  });

  it('Alt+Shift+Enter toggles the focused tile, only while the grid is open', () => {
    const app = openGrid();
    const ev = { key: 'Enter', code: 'Enter', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false };
    expect(app.tileShortcutFor(ev)).toBe('zoom-tile');
    app.runTileShortcut('zoom-tile');
    expect(app._tileGrid.zoomedId).toBe('s-a');
    app.runTileShortcut('zoom-tile');
    expect(app._tileGrid.zoomedId).toBeNull();

    const closed = makeGridApp(IDS);
    expect(closed.tileShortcutFor(ev)).toBeNull();
  });

  it('the registry ships Alt+Shift+Enter for it', () => {
    const app = openGrid();
    const zoom = app.getShortcutRegistry().find((s: { id: string }) => s.id === 'zoom-tile');
    expect(zoom.bindings).toEqual([{ modifiers: ['alt', 'shift'], key: 'Enter' }]);
  });
});

describe('what restores the grid', () => {
  it('moving focus to another tile (tmux select-pane)', () => {
    const app = openGrid();
    app.zoomTile('s-a');
    app.selectSession('s-b');
    expect(app._tileGrid.zoomedId).toBeNull();
    expect(section.classList.contains('tile-grid--zoomed')).toBe(false);
  });

  it('removing the zoomed tile; its neighbour takes focus in the grid', () => {
    const app = openGrid();
    app.zoomTile('s-a');
    app.removeTile('s-a');
    expect(app._tileGrid.zoomedId).toBeNull();
    expect(app.activeSessionId).toBe('s-b');
  });

  it('removing the zoomed tile without moving focus (a close from this tab) leaves no zoom behind', () => {
    const app = openGrid();
    app.zoomTile('s-a');
    app.removeTile('s-a', { refocus: false });
    expect(app._tileGrid.zoomedId).toBeNull();
    expect(section.classList.contains('tile-grid--zoomed')).toBe(false);
  });

  it('adding a tile while one is zoomed by hand', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(['s-a', 's-b', 's-c']);
    app.zoomTile('s-a');
    expect(app.addTile('s-d')).toBe(true);
    expect(app._tileGrid.zoomedId).toBeNull();
  });

  it('closing the grid forgets the zoom', () => {
    const app = openGrid();
    app.selectSession = vi.fn();
    app.zoomTile('s-a');
    app.closeTileGrid({ reselect: false });
    expect(app._tileGrid.zoomedId).toBeNull();
    expect(section.classList.contains('tile-grid--zoomed')).toBe(false);
  });
});

describe('a window too small for the tiles', () => {
  const small = () => ({ width: 900, height: 400, top: 0, left: 0, right: 900, bottom: 400 });
  const large = () => ({ width: 2400, height: 1200, top: 0, left: 0, right: 2400, bottom: 1200 });

  it('zooms the focused tile with a hint, and the grid comes back once it fits', () => {
    const app = openGrid();
    (section as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = small;
    app._scheduleTileGridRefit();
    settleRefit();
    expect(app._tileGrid.zoomedId).toBe('s-a');
    expect(app._tileGrid.autoZoom).toBe(true);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('too small'), 'info');

    (section as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = large;
    app._scheduleTileGridRefit();
    settleRefit();
    expect(app._tileGrid.zoomedId).toBeNull();
    expect(app._tileGrid.autoZoom).toBe(false);
  });

  it('the automatic zoom follows focus instead of restoring a grid that does not fit', () => {
    const app = openGrid();
    (section as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = small;
    app._scheduleTileGridRefit();
    settleRefit();
    app.selectSession('s-c');
    expect(app._tileGrid.zoomedId).toBe('s-c');
    expect(tileEl('s-c').classList.contains('tile--zoomed')).toBe(true);
    // Moved, not lifted and re-applied: the hint is not repeated.
    expect(app.showToast).toHaveBeenCalledTimes(1);
  });

  it('a zoom the user chose is not lifted when the window fits', () => {
    const app = openGrid();
    app.zoomTile('s-b');
    app._scheduleTileGridRefit();
    settleRefit();
    expect(app._tileGrid.zoomedId).toBe('s-b');
  });
});

describe('styles', () => {
  it('hides every tile but the zoomed one', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    expect(css).toMatch(/\.tile-grid\.tile-grid--zoomed \.tile:not\(\.tile--zoomed\)\s*\{\s*display: none;/);
  });
});
