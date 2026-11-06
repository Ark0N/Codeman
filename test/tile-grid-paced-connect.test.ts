/**
 * @fileoverview Opening the grid paints the tiles first and builds their
 * terminals one per frame (owner answer: "paced connect: in").
 *
 * - `openTileGrid` connects no tile inside the click: every tile is mounted
 *   and the grid laid out first, then one tile connects per animation frame,
 *   the focused one first, then reading order. Each still connects once, into
 *   its final cell (one fit, one PTY resize).
 * - The keyboard goes to the focused tile's terminal as soon as it exists
 *   (`focusOnConnect`): not before, never for a `focus: false` selection, and
 *   to the newly focused tile when focus moved while they were being built.
 * - A grid closed (or opened again) meanwhile stops the old run; a tile
 *   removed before its turn is skipped; a tile already connected (one a
 *   re-form added) is never connected twice; a remount after Attach connects
 *   its new terminal.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  bySelector,
  flushFrames,
  makeGridApp,
  rafCallbacks,
  resetGridHarness,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c', 's-d'];
const connected = () => FakeTile.all.filter((t) => t.connect.mock.calls.length > 0).map((t) => t.sessionId);
const tileOf = (id: string) => FakeTile.all.find((t) => t.sessionId === id && !t._destroyed)!;
/** Runs the frames queued so far, once (one step of the paced connect). */
const oneFrame = () => {
  for (const cb of rafCallbacks.splice(0)) cb();
};

beforeEach(() => {
  resetGridHarness();
  const btn = new FakeEl();
  btn.className = 'btn-icon-header btn-tile-grid';
  bySelector.set('.btn-tile-grid', btn);
});

function gridApp(ids = IDS): GridApp {
  const app = makeGridApp(ids);
  app.selectSession = vi.fn((id: string) => app._selectTiledSession(id, {}));
  return app;
}

describe('opening paints first, then one terminal per frame', () => {
  it('nothing connects inside the click; then the focused tile first, then reading order, one per frame', () => {
    const app = gridApp();
    app.openTileGrid(IDS, { focusedId: 's-c' });
    expect(app._tilesOwnTerminal()).toBe(true);
    expect(FakeTile.all).toHaveLength(4);
    expect(connected()).toEqual([]);
    oneFrame();
    expect(connected()).toEqual(['s-c']);
    oneFrame();
    expect(connected()).toEqual(['s-a', 's-c']);
    oneFrame();
    oneFrame();
    expect(connected().sort()).toEqual(IDS);
    oneFrame();
    expect(rafCallbacks).toHaveLength(0);
    expect(FakeTile.all.every((t) => t.connect.mock.calls.length === 1)).toBe(true);
  });

  it('every tile connects into its final cell: the grid was laid out before the first', () => {
    const app = gridApp();
    app.openTileGrid(IDS);
    const seen: string[] = [];
    for (const t of FakeTile.all) {
      t.connect.mockImplementation(async () => {
        seen.push(`${t.sessionId}:${app._tileGrid.cells.length}:${app._tileGrid.cells.indexOf(t.sessionId)}`);
      });
    }
    flushFrames();
    expect(seen).toEqual(['s-a:4:0', 's-b:4:1', 's-c:4:2', 's-d:4:3']);
  });
});

describe('the keyboard', () => {
  it('lands in the focused tile once its terminal exists, not before', () => {
    const app = gridApp();
    app.openTileGrid(IDS, { focusedId: 's-b' });
    expect(tileOf('s-b').terminal.focus).not.toHaveBeenCalled();
    oneFrame();
    expect(tileOf('s-b').terminal.focus).toHaveBeenCalledTimes(1);
    flushFrames();
    expect(tileOf('s-b').terminal.focus).toHaveBeenCalledTimes(1);
    expect(tileOf('s-a').terminal.focus).not.toHaveBeenCalled();
  });

  it('follows a focus moved while the terminals are being built', () => {
    const app = gridApp();
    app.openTileGrid(IDS, { focusedId: 's-a' });
    app._selectTiledSession('s-d', {});
    flushFrames();
    expect(tileOf('s-d').terminal.focus).toHaveBeenCalled();
    expect(tileOf('s-a').terminal.focus).not.toHaveBeenCalled();
  });

  it('never for a selection that asked for no focus', () => {
    const app = gridApp();
    app.openTileGrid(IDS, { focusedId: 's-a' });
    app._selectTiledSession('s-a', { focus: false });
    flushFrames();
    expect(FakeTile.all.some((t) => t.terminal.focus.mock.calls.length > 0)).toBe(false);
  });

  it('a tile already built takes the keyboard at once', () => {
    const app = gridApp();
    app.openTileGrid(IDS, { focusedId: 's-a' });
    flushFrames();
    app._selectTiledSession('s-c', {});
    expect(tileOf('s-c').terminal.focus).toHaveBeenCalledTimes(1);
  });
});

describe('a grid that changes meanwhile', () => {
  it('closed: nothing connects any more, and no frame is asked for after it', () => {
    const app = gridApp();
    app.openTileGrid(IDS);
    oneFrame();
    app.closeTileGrid({ reselect: false });
    oneFrame();
    expect(rafCallbacks).toHaveLength(0);
    flushFrames();
    expect(connected()).toEqual(['s-a']);
  });

  it('opened again: the old run stops at once, the new one starts with its own focused tile', () => {
    const app = gridApp();
    app.openTileGrid(IDS, { focusedId: 's-a' });
    oneFrame();
    app.closeTileGrid({ reselect: false });
    app.activeSessionId = null;
    app.openTileGrid(IDS, { focusedId: 's-d' });
    oneFrame();
    const live = () => FakeTile.all.filter((t) => !t._destroyed && t.connect.mock.calls.length).map((t) => t.sessionId);
    expect(live()).toEqual(['s-d']);
  });

  it('closed and opened again: the old run stops, the new one connects each tile once', () => {
    const app = gridApp();
    app.openTileGrid(IDS);
    oneFrame();
    app.closeTileGrid({ reselect: false });
    app.activeSessionId = null;
    app.openTileGrid(IDS);
    flushFrames();
    const live = FakeTile.all.filter((t) => !t._destroyed);
    expect(live).toHaveLength(4);
    expect(live.every((t) => t.connect.mock.calls.length === 1)).toBe(true);
  });

  it('a tile removed before its turn is skipped; one a re-form connected is not connected again', () => {
    const app = gridApp(['s-a', 's-b', 's-c', 's-d', 's-e']);
    app.openTileGrid(['s-a', 's-b', 's-c']);
    app.removeTile('s-b');
    app.addTile('s-e');
    expect(tileOf('s-e').connect).toHaveBeenCalledTimes(1);
    flushFrames();
    expect(FakeTile.all.find((t) => t.sessionId === 's-b')!.connect).not.toHaveBeenCalled();
    expect(tileOf('s-e').connect).toHaveBeenCalledTimes(1);
    expect(tileOf('s-a').connect).toHaveBeenCalledTimes(1);
    expect(tileOf('s-c').connect).toHaveBeenCalledTimes(1);
  });

  it('a tile remounted before its turn (Attach) is connected once, not again by the paced run', () => {
    const app = gridApp();
    app.openTileGrid(IDS);
    app._remountTile('s-c');
    flushFrames();
    expect(tileOf('s-c').connect).toHaveBeenCalledTimes(1);
  });

  it('a remount after Attach connects its new terminal', () => {
    const app = gridApp();
    app.openTileGrid(IDS);
    flushFrames();
    const old = tileOf('s-b');
    app._remountTile('s-b');
    const fresh = tileOf('s-b');
    expect(fresh).not.toBe(old);
    expect(fresh.connect).toHaveBeenCalledTimes(1);
  });
});
