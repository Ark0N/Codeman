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
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b']);
    expect(app.activeSessionId).toBe('s-a');
    // Pane A is about to park: no closing resize for it.
    expect(app.sendResize).toHaveBeenCalledTimes(1); // the split's own opening resize only
  });

  it('a remembered grid wins over an open split: exactly its tiles, the split closed and not merged', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.openTileGrid(['s-c']);
    app.closeTileGrid({ reselect: false });
    app.activeSessionId = 's-a';
    const paneB = openSplit(app);

    app.toggleTileGrid();

    expect(paneB.destroy).toHaveBeenCalledTimes(1);
    expect(app._splitPane).toBeNull();
    expect(app._tileGrid.ids).toEqual(['s-c']);
    expect(app.activeSessionId).toBe('s-c');
  });

  it('an explicit open over a split keeps both split sessions first', () => {
    const app = makeGridApp(IDS);
    openSplit(app);
    app.openTileGrid(['s-c']);
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b', 's-c']);
    expect(app.activeSessionId).toBe('s-a');
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
