/**
 * @fileoverview The tile grid and the split pane are never open together.
 *
 * Both run on TerminalTile, and the split's wrappers (`selectSession`,
 * `_onSessionDeleted` in terminal-split.js) key on `this._splitPane`, so they
 * would fight the grid over the same terminal area if both were ever up:
 *
 * - opening the grid while a split is open closes the split first and seeds
 *   the grid with both of its sessions, Pane A focused and Pane B beside it;
 * - while the grid is open, `openSplitPicker` and `openSplitPane` refuse, and
 *   the Split button says so (`aria-disabled`, a title);
 * - closing the grid never reopens a split;
 * - the split's wrappers stay inert while the grid is open.
 *
 * Real code: constants.js + app.js + terminal-ui.js + terminal-split.js +
 * tile-grid.js (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  body,
  bySelector,
  localStore,
  main,
  makeGridApp,
  resetGridHarness,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];

function makeSplitButton() {
  const btn = new FakeEl();
  btn.className = 'btn-icon-header btn-split';
  bySelector.set('.btn-split', btn);
  return btn;
}

/** s-a in the main pane, s-b in Pane B (the split's real openSplitPane). */
function openSplit(app: GridApp) {
  app.openSplitPane('s-b');
  expect(app._splitSessionId).toBe('s-b');
  // closeSplitPane finds its container by selector.
  const container = main.querySelector('.terminal-split-container');
  if (container) bySelector.set('.terminal-split-container', container);
  return FakeTile.all.at(-1) as FakeTile;
}

beforeEach(() => {
  resetGridHarness();
});

describe('opening the grid over an open split', () => {
  it('closes the split and seeds the grid with both of its sessions, Pane A focused', () => {
    const app = makeGridApp(IDS);
    const paneB = openSplit(app);

    app.toggleTileGrid();

    expect(paneB.destroy).toHaveBeenCalledTimes(1);
    expect(app._splitPane).toBeNull();
    // The split's two first, then tab order up to the count (default 6).
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b', 's-other', 's-c']);
    expect(app.activeSessionId).toBe('s-a');
    // Pane A is about to park: no closing resize for it.
    expect(app.sendResize).toHaveBeenCalledTimes(1); // the split's own opening resize only
  });

  it("with a count of 2, exactly the split's two", () => {
    const app = makeGridApp(IDS);
    localStore.set('codeman:tile-count', '2');
    openSplit(app);
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b']);
  });

  it('a remembered grid wins over an open split: its tiles first, the split closed and not merged', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.openTileGrid(['s-c']);
    app.closeTileGrid({ reselect: false });
    app.activeSessionId = 's-a';
    localStore.set('codeman:tile-count', '2');
    const paneB = openSplit(app);
    app.sendResize.mockClear();

    app.toggleTileGrid();

    expect(paneB.destroy).toHaveBeenCalledTimes(1);
    expect(app._splitPane).toBeNull();
    // Filled from tab order (s-other first), not seeded with the split's two.
    expect(app._tileGrid.ids).toEqual(['s-c', 's-other']);
    expect(app.activeSessionId).toBe('s-c');
    // Pane A (s-a) is not a tile: the split's closing resize gave it its full width back.
    expect(app.sendResize.mock.calls).toEqual([['s-a', { force: true }]]);
  });

  it('an explicit open over a split keeps both split sessions first', () => {
    const app = makeGridApp(IDS);
    openSplit(app);
    app.openTileGrid(['s-c']);
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b', 's-c']);
    expect(app.activeSessionId).toBe('s-a');
  });

  // The entry points that size their own set never get the split's two
  // prepended on top of it (that went past the group, the count and the
  // window's capacity, and auto-zoomed with a "too small" toast).
  it("'Open group as tiles' over a split opens exactly the group, the split closed", () => {
    const app = makeGridApp([...IDS, 's-d']);
    app.tabLayout = {
      groups: [
        {
          id: 'g',
          name: 'G',
          refs: [
            { kind: 'session', id: 's-c' },
            { kind: 'session', id: 's-d' },
          ],
        },
      ],
    };
    const paneB = openSplit(app);

    app.openGroupAsTiles('g');

    expect(paneB.destroy).toHaveBeenCalledTimes(1);
    expect(app._splitPane).toBeNull();
    expect(app._tileGrid.ids).toEqual(['s-c', 's-d']);
    expect(app.activeSessionId).toBe('s-c');
    // Pane A (s-a) is not in the group, so no tile will ever size its PTY: the
    // split's closing resize gives it its full width back before the main
    // terminal parks, or it stays at the split's half width for as long as
    // the grid is open. The split's opening resize, then the closing one.
    expect(app.sendResize).toHaveBeenCalledTimes(2);
    expect(app.sendResize).toHaveBeenLastCalledWith('s-a', { force: true });
  });

  it('Ctrl/Cmd+click over a split opens the remembered count in total, never one more', () => {
    const app = makeGridApp(IDS);
    localStore.set('codeman:tile-count', '2');
    openSplit(app);

    app.addSessionToTiles('s-c');

    expect(app._splitPane).toBeNull();
    // The split's Pane A seeds the set (tileGridOpenSet), the clicked one joins: 2, not 3.
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
    // Pane A is a tile, which sizes its PTY: no closing resize for it.
    expect(app.sendResize).toHaveBeenCalledTimes(1); // the split's own opening resize only
  });

  it('Ctrl/Cmd+click over a split with a remembered grid: the remembered grid wins, not the split', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.openTileGrid(['s-other', 's-c']);
    app.closeTileGrid({ reselect: false });
    app.activeSessionId = 's-a';
    localStore.set('codeman:tile-count', '2');
    openSplit(app);

    app.addSessionToTiles('s-b');

    expect(app._splitPane).toBeNull();
    expect(app._tileGrid.ids).toEqual(['s-other', 's-b']);
    expect(app.activeSessionId).toBe('s-b');
  });
});

describe('while the grid is open', () => {
  it('the split refuses to open, from the picker or directly', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    const before = FakeTile.all.length;

    app.openSplitPicker({ stopPropagation: vi.fn() });
    app.openSplitPane('s-b');

    expect(app._splitPane ?? null).toBeNull();
    expect(FakeTile.all.length).toBe(before);
    // The picker itself never opened either.
    expect(body.children).toHaveLength(0);
    expect(app._splitPickerDismissHandlers ?? null).toBeNull();
  });

  it('the Split button is marked unavailable, and back to normal once the grid closes', () => {
    const app = makeGridApp(IDS);
    const btn = makeSplitButton();
    app.openTileGrid(IDS);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.classList.contains('btn-split--blocked')).toBe(true);

    app.closeTileGrid({ reselect: false });
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    expect(btn.classList.contains('btn-split--blocked')).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it("the split's wrappers do nothing (no split to close or promote)", () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.closeSplitPane = vi.fn();
    app._onSessionDeleted({ id: 's-c' });
    expect(app.closeSplitPane).not.toHaveBeenCalled();
  });
});

describe('closing the grid', () => {
  it('never reopens the split it replaced', () => {
    const app = makeGridApp(IDS);
    openSplit(app);
    app.toggleTileGrid();
    app.closeTileGrid({ reselect: false });
    expect(app._splitPane).toBeNull();
    expect(app._tilesOwnTerminal()).toBe(false);
  });
});
