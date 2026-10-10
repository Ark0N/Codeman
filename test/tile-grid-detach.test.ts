/**
 * @fileoverview Detach Tiles (per-device `tileDetachEnabled`, default OFF): a
 * tile leaves the grid for a window of its own, and comes back into any
 * Codeman window's grid, by dragging.
 *
 * - OFF (the default) changes nothing: a lone tile's header does not drag, a
 *   header let go outside the window opens nothing, and a tile dragged from
 *   another window is not taken.
 * - A header let go OUTSIDE the window (dragend with no drop, its point off the
 *   viewport, or the page's own record of the pointer leaving when the
 *   browser reports no point) opens the session as a pop-out after a short
 *   settle, the tile's size, its header under the drop point. Let go inside
 *   on nothing, or taken by a drop target (`dropEffect: 'move'`), nothing
 *   opens. A lone or zoomed tile drags too (out only).
 * - Another window docking the tile ('tile-adopted' on the window channel)
 *   takes it out of THIS grid only when this window dragged it (still
 *   settling, or ended a moment ago); the keyboard stays put, and the last
 *   tile leaves for the welcome screen, never for that session.
 * - A tile from another window dropped on a tile or an empty cell docks there
 *   through the target's own drop and says so; a popped-out session is taken
 *   back first and its window asked to close; its stale 'detached' answers
 *   are ignored for a moment. Unknown ids dock nowhere.
 * - The pop-out window: its features carry the placement (the default stays
 *   960x680, unplaced); a released pop-out stops answering roll-calls.
 * - The gesture overlay's helpers ask the same rules: what is under a point,
 *   what a drop there would do, and the pop-out at a hand's point.
 * - A tile's ⋯ menu offers "Open in a new window" with Detach Tiles on (the
 *   keyboard's way to the drag), placed over the tile.
 * - The setting is per-device: a display key, stripped from the settings PUT,
 *   absent from the .strict() schema, OFF unless switched on, its row shown on
 *   desktop only.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  documentAddEventListener,
  documentRemoveEventListener,
  makeGridApp,
  pointHits,
  resetGridHarness,
  section,
  type GridApp,
  tileEl,
  windowStub,
} from './mocks/tile-grid-vm.js';

const TILE_TYPE = 'application/x-codeman-tile';
const FOUR = ['s-a', 's-b', 's-c', 's-d'];
const THREE = ['s-a', 's-b', 's-c'];
// Five tiles lay out 3x2 here: one empty cell, the last.
const FIVE = ['s-a', 's-b', 's-c', 's-d', 's-e'];

const headerOf = (id: string) => tileEl(id).children[0];
const slots = () => section.children.filter((el) => el.className.split(' ').includes('tile-slot'));
const settle = () => new Promise((r) => setTimeout(r, 200));

function dragEvent(extra: Record<string, unknown> = {}, transfer: Record<string, unknown> = {}) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX: 100,
    clientY: 10,
    ...extra,
    dataTransfer: { effectAllowed: '', dropEffect: 'none', setData: vi.fn(), ...transfer },
  };
}

/** A drag from another window: none of this page's own, the tile type carried, its id readable on drop. */
function foreign(id: string) {
  return dragEvent({}, { types: [TILE_TYPE], getData: (t: string) => (t === TILE_TYPE ? id : '') });
}

function openGrid(ids: string[], { detach = true, focusedId = ids[0] } = {}): GridApp {
  const app = makeGridApp(ids);
  app.loadAppSettingsFromStorage = () => ({ tileDetachEnabled: detach });
  app._postWindowMessage = vi.fn();
  app._wsTabNonce = 'c-here';
  app.openTileGrid(ids, { focusedId });
  return app;
}

/** Press the header and start its native drag (a press at (40, 10) inside the tile). */
function startDrag(id: string) {
  headerOf(id).dispatch('pointerdown', { target: headerOf(id), button: 0 });
  const start = dragEvent({ clientX: 40, clientY: 10 });
  headerOf(id).dispatch('dragstart', start);
  return start;
}
const endDrag = (id: string, extra: Record<string, unknown>, effect = 'none') =>
  headerOf(id).dispatch('dragend', dragEvent(extra, { dropEffect: effect }));

/** The page-level drag listeners the tear-off installed (capture phase). */
const docListener = (type: string) =>
  documentAddEventListener.mock.calls.filter((c) => c[0] === type).at(-1)?.[1] as (e: unknown) => void;

beforeEach(() => {
  resetGridHarness();
  documentAddEventListener.mockClear();
});
afterEach(() => {
  delete windowStub.screenX;
  delete windowStub.screenY;
  delete windowStub.outerHeight;
  delete windowStub.screen;
  delete windowStub.open;
});

describe('Detach Tiles OFF (the default) changes nothing', () => {
  it('a lone tile does not drag, and a header let go outside the window opens nothing', async () => {
    const app = openGrid(['s-a'], { detach: false });
    app.detachSession = vi.fn();
    expect(headerOf('s-a').getAttribute('draggable')).toBe('false');
    expect(startDrag('s-a').preventDefault).toHaveBeenCalled();

    const four = openGrid(FOUR, { detach: false });
    four.detachSession = vi.fn();
    startDrag('s-b');
    endDrag('s-b', { clientX: -50, clientY: 300, screenX: 20, screenY: 400 });
    await settle();
    expect(four.detachSession).not.toHaveBeenCalled();
    expect(four._tileGrid.ids).toEqual(FOUR);
  });

  it('a tile dragged from another window is not taken', () => {
    const app = openGrid(THREE, { detach: false });
    const over = foreign('s-other');
    tileEl('s-b').dispatch('dragover', over);
    expect(over.preventDefault).not.toHaveBeenCalled();
    tileEl('s-b').dispatch('drop', foreign('s-other'));
    expect(app._tileGrid.ids).toEqual(THREE);
    expect(app._postWindowMessage).not.toHaveBeenCalled();
  });

  it('the header tooltip keeps its old wording', () => {
    openGrid(THREE, { detach: false });
    expect(headerOf('s-a').title).toContain('Drag to move the tile');
    expect(headerOf('s-a').title).not.toContain('window');
  });
});

describe('dragging a header out of the window', () => {
  it('opens the session as a pop-out after a short settle, the tile size, its header under the drop point', async () => {
    const app = openGrid(FOUR);
    app.detachSession = vi.fn();
    startDrag('s-b');
    endDrag('s-b', { clientX: -50, clientY: 300, screenX: 900, screenY: 500 });
    expect(app.detachSession).not.toHaveBeenCalled();
    await settle();
    expect(app.detachSession).toHaveBeenCalledTimes(1);
    const [id, placement] = app.detachSession.mock.calls[0];
    expect(id).toBe('s-b');
    // The harness's tiles measure 2400x1200; the press was at (40, 10).
    expect(placement).toEqual({ width: 2400, height: 1200, left: 860, top: 430 });
  });

  it('a lone tile, or a zoomed one, drags out too (no target inside takes it)', async () => {
    const app = openGrid(['s-a']);
    app.detachSession = vi.fn();
    expect(headerOf('s-a').getAttribute('draggable')).toBe('true');
    expect(headerOf('s-a').title).toContain('Drag out of the window to open the tile on its own');
    expect(startDrag('s-a').preventDefault).not.toHaveBeenCalled();
    endDrag('s-a', { clientX: 5000, clientY: 300, screenX: 5000, screenY: 300 });
    await settle();
    expect(app.detachSession).toHaveBeenCalledWith('s-a', expect.any(Object));

    const zoomed = openGrid(FOUR);
    zoomed.zoomTile('s-c');
    expect(headerOf('s-c').getAttribute('draggable')).toBe('true');
  });

  it('let go inside the window on nothing, or taken by a drop target: nothing opens', async () => {
    const app = openGrid(FOUR);
    app.detachSession = vi.fn();
    startDrag('s-b');
    endDrag('s-b', { clientX: 300, clientY: 300, screenX: 300, screenY: 400 });
    startDrag('s-c');
    endDrag('s-c', { clientX: -50, clientY: 300, screenX: 20, screenY: 400 }, 'move');
    await settle();
    expect(app.detachSession).not.toHaveBeenCalled();
    expect(app._tileGrid.ids).toEqual(FOUR);
  });

  it('no point reported: the page record of the pointer leaving at the edge decides, a dragover inside undoes it', async () => {
    const app = openGrid(FOUR);
    app.detachSession = vi.fn();
    startDrag('s-b');
    docListener('dragleave')({ relatedTarget: null, clientX: 0, clientY: 500 });
    endDrag('s-b', { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    await settle();
    expect(app.detachSession).toHaveBeenCalledTimes(1);
    // No screen point: placed over the tile instead (no window position known here: size only).
    expect(app.detachSession.mock.calls[0][1]).toEqual({ width: 2400, height: 1200 });

    app.detachSession.mockClear();
    startDrag('s-c');
    docListener('dragleave')({ relatedTarget: null, clientX: 0, clientY: 500 });
    docListener('dragover')({});
    endDrag('s-c', { clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
    await settle();
    expect(app.detachSession).not.toHaveBeenCalled();
  });

  it('the page drag listeners go when the drag ends, and when the grid closes mid-drag', () => {
    const app = openGrid(FOUR);
    startDrag('s-b');
    const over = docListener('dragover');
    const leave = docListener('dragleave');
    documentRemoveEventListener.mockClear();
    endDrag('s-b', { clientX: 300, clientY: 300 });
    expect(documentRemoveEventListener).toHaveBeenCalledWith('dragover', over, true);
    expect(documentRemoveEventListener).toHaveBeenCalledWith('dragleave', leave, true);

    startDrag('s-c');
    const over2 = docListener('dragover');
    documentRemoveEventListener.mockClear();
    app.closeTileGrid({ reselect: false });
    expect(documentRemoveEventListener).toHaveBeenCalledWith('dragover', over2, true);
    expect(app._tileTearOff).toBeNull();
  });

  it('the real pop-out takes the tile out of the grid (as the tab pop-out does)', async () => {
    const app = openGrid(FOUR);
    const win = { closed: false, focus: vi.fn() };
    windowStub.open = vi.fn(() => win);
    app.detachedWindows = new Map();
    app._detachWatchTimers = new Map();
    app.hasHostWindows = () => false;
    // No tab strip in this harness.
    app.$ = () => null;
    startDrag('s-b');
    endDrag('s-b', { clientX: -50, clientY: 300, screenX: 900, screenY: 500 });
    await settle();
    expect(windowStub.open).toHaveBeenCalledWith(
      '/session/s-b',
      'codeman-session-s-b',
      'width=2400,height=1200,left=860,top=430,menubar=no,toolbar=no,location=no,status=no'
    );
    expect(app.detachedSessions.has('s-b')).toBe(true);
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c', 's-d']);
  });
});

describe('another window docking the tile this one dragged', () => {
  it('a drop target in another window took it: the tile goes, the keyboard stays put', () => {
    const app = openGrid(FOUR, { focusedId: 's-b' });
    startDrag('s-b');
    endDrag('s-b', { clientX: -50, clientY: 300 }, 'move');
    const focusBefore = FakeTile.all.map((t) => t.terminal.focus.mock.calls.length);
    app._onWindowMessage({ type: 'tile-adopted', id: 's-b', by: 'c-there' });
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c', 's-d']);
    expect(app._tileGrid.focusedId).not.toBe('s-b');
    expect(FakeTile.all.map((t) => t.terminal.focus.mock.calls.length)).toEqual(focusBefore);
  });

  it('a claim that arrives while the pop-out is settling cancels the pop-out', async () => {
    const app = openGrid(FOUR);
    app.detachSession = vi.fn();
    startDrag('s-c');
    endDrag('s-c', { clientX: -50, clientY: 300, screenX: 20, screenY: 400 });
    app._onWindowMessage({ type: 'tile-adopted', id: 's-c', by: 'c-there' });
    await settle();
    expect(app.detachSession).not.toHaveBeenCalled();
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b', 's-d']);
  });

  it('the last tile leaves for the welcome screen, never for that session', () => {
    const app = openGrid(['s-a']);
    startDrag('s-a');
    endDrag('s-a', { clientX: -50, clientY: 300 }, 'move');
    app._onWindowMessage({ type: 'tile-adopted', id: 's-a', by: 'c-there' });
    expect(app._tileGrid.open).toBe(false);
    expect(app.activeSessionId).toBeNull();
    expect(app.showWelcome).toHaveBeenCalled();
    expect(app.terminal.clear).toHaveBeenCalled();
  });

  it('a claim for a tile this window did not drag, or one it dragged long ago, is ignored', () => {
    const app = openGrid(FOUR);
    app._onWindowMessage({ type: 'tile-adopted', id: 's-b', by: 'c-there' });
    expect(app._tileGrid.ids).toEqual(FOUR);
    startDrag('s-b');
    endDrag('s-b', { clientX: 300, clientY: 300 }, 'move');
    app._lastTileDrag.at -= 60_000;
    app._onWindowMessage({ type: 'tile-adopted', id: 's-b', by: 'c-there' });
    expect(app._tileGrid.ids).toEqual(FOUR);
  });

  it("this window's own claim (same nonce) is never acted on", () => {
    const app = openGrid(FOUR);
    startDrag('s-b');
    endDrag('s-b', { clientX: 300, clientY: 300 }, 'move');
    app._onWindowMessage({ type: 'tile-adopted', id: 's-b', by: 'c-here' });
    expect(app._tileGrid.ids).toEqual(FOUR);
  });
});

describe('a tile from another window dropped here', () => {
  it('on a tile: it takes that tile’s place, focused, and every window hears it was docked', () => {
    const app = openGrid(THREE);
    const over = foreign('s-other');
    tileEl('s-b').dispatch('dragover', over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.stopPropagation).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('move');
    expect(tileEl('s-b').classList.contains('tile--drop-target')).toBe(true);

    tileEl('s-b').dispatch('drop', foreign('s-other'));
    expect(app._tileGrid.ids).toEqual(['s-a', 's-other', 's-c']);
    expect(app._tileGrid.focusedId).toBe('s-other');
    expect(app._postWindowMessage).toHaveBeenCalledWith({ type: 'tile-adopted', id: 's-other', by: 'c-here' });
    expect(tileEl('s-other').classList.contains('tile--drop-target')).toBe(false);
  });

  it('on an empty cell: it joins there', () => {
    const app = openGrid(FIVE);
    expect(slots()).toHaveLength(1);
    slots()[0].dispatch('drop', foreign('s-other'));
    expect(app._tileGrid.cells).toEqual([...FIVE, 's-other']);
    expect(app._postWindowMessage).toHaveBeenCalledWith({ type: 'tile-adopted', id: 's-other', by: 'c-here' });
  });

  it('a popped-out session is taken back first and its window asked to close; its stale answers are ignored', () => {
    const app = openGrid(THREE);
    app.detachedSessions.add('s-other');
    app._redock = vi.fn((id: string) => app.detachedSessions.delete(id));
    app._markDetached = vi.fn();
    tileEl('s-c').dispatch('drop', foreign('s-other'));
    expect(app._redock).toHaveBeenCalledWith('s-other');
    expect(app._tileGrid.ids).toContain('s-other');
    expect(app._postWindowMessage).toHaveBeenCalledWith({ type: 'close-request', id: 's-other' });
    expect(app._postWindowMessage).toHaveBeenCalledWith({ type: 'tile-adopted', id: 's-other', by: 'c-here' });
    // The closing pop-out answering a roll-call on its way out.
    app._onWindowMessage({ type: 'detached', id: 's-other' });
    expect(app._markDetached).not.toHaveBeenCalled();
    expect(app._tileGrid.ids).toContain('s-other');
  });

  it('an id this page does not know docks nowhere', () => {
    const app = openGrid(THREE);
    tileEl('s-b').dispatch('drop', foreign('s-gone'));
    tileEl('s-b').dispatch('drop', foreign(''));
    expect(app._tileGrid.ids).toEqual(THREE);
    expect(app._postWindowMessage).not.toHaveBeenCalled();
  });

  it("a drag of this page's own is never read as a foreign one", () => {
    const app = openGrid(FOUR);
    startDrag('s-a');
    const over = foreign('s-other');
    over.dataTransfer.types = [TILE_TYPE];
    tileEl('s-d').dispatch('drop', over);
    // The own drag wins: s-a and s-d trade places, nothing docks.
    expect(app._tileGrid.ids).toEqual(['s-d', 's-b', 's-c', 's-a']);
    expect(app._postWindowMessage).not.toHaveBeenCalled();
  });
});

describe('the pop-out window', () => {
  it('features: the placement when given, the old default otherwise', () => {
    const app = makeGridApp();
    expect(app._detachWindowFeatures(null)).toBe('width=960,height=680,menubar=no,toolbar=no,location=no,status=no');
    expect(app._detachWindowFeatures({ width: 700.4, height: 500, left: -1200, top: 40 })).toBe(
      'width=700,height=500,left=-1200,top=40,menubar=no,toolbar=no,location=no,status=no'
    );
    // A position needs both coordinates; non-numbers never reach the string.
    expect(app._detachWindowFeatures({ left: 10, top: Number.NaN, width: 'x' })).toBe(
      'width=960,height=680,menubar=no,toolbar=no,location=no,status=no'
    );
  });

  it('from the ⋯ menu (no point): over the tile, at least the minimum size, within the screen', () => {
    const app = openGrid(FOUR);
    app.detachSession = vi.fn();
    windowStub.screenX = 100;
    windowStub.screenY = 50;
    windowStub.outerHeight = 1300;
    windowStub.screen = { availWidth: 1920, availHeight: 1080 };
    app.detachTile('s-b');
    expect(app.detachSession).toHaveBeenCalledWith('s-b', { width: 1920, height: 1080, left: 100, top: 90 });
  });

  it('never with Detach Tiles off, nor for a session that is not a tile', () => {
    const off = openGrid(FOUR, { detach: false });
    off.detachSession = vi.fn();
    expect(off.detachTile('s-b')).toBe(false);
    const on = openGrid(FOUR);
    on.detachSession = vi.fn();
    expect(on.detachTile('s-other')).toBe(false);
    expect(off.detachSession).not.toHaveBeenCalled();
    expect(on.detachSession).not.toHaveBeenCalled();
  });

  it('a released pop-out says so, then stops answering roll-calls', () => {
    const app = makeGridApp();
    app.isSoloWindow = true;
    app.soloSessionId = 's-a';
    app._postWindowMessage = vi.fn();
    app._closeSoloWindow = vi.fn();
    app._onWindowMessage({ type: 'roll-call' });
    expect(app._postWindowMessage).toHaveBeenLastCalledWith({ type: 'detached', id: 's-a' });
    app._onWindowMessage({ type: 'close-request', id: 's-a' });
    expect(app._postWindowMessage).toHaveBeenLastCalledWith({ type: 'redocked', id: 's-a' });
    expect(app._closeSoloWindow).toHaveBeenCalled();
    app._postWindowMessage.mockClear();
    app._onWindowMessage({ type: 'roll-call' });
    expect(app._postWindowMessage).not.toHaveBeenCalled();
  });
});

describe('the gesture overlay helpers', () => {
  it('what is under a point: the tile, and whether a hand may pick it up', () => {
    const app = openGrid(FOUR);
    const inner = new FakeEl();
    tileEl('s-c').children[1].appendChild(inner);
    pointHits.at = () => inner;
    expect(app.tileAtPoint(10, 10)).toBe('s-c');
    expect(app.canGrabTile('s-c')).toBe(true);
    pointHits.at = () => null;
    expect(app.tileAtPoint(10, 10)).toBeNull();

    // Alone with Detach Tiles off it can neither move nor leave.
    const lone = openGrid(['s-a'], { detach: false });
    expect(lone.canGrabTile('s-a')).toBe(false);
    const loneOn = openGrid(['s-a']);
    expect(loneOn.canGrabTile('s-a')).toBe(true);
  });

  it("what a drop there would do, by the mouse drag's rules, and doing it", () => {
    const app = openGrid(FIVE);
    pointHits.at = () => tileEl('s-c');
    expect(app.tileDropTargetAt(1, 1, 's-a')).toEqual({ kind: 'tile', id: 's-c', el: tileEl('s-c') });
    // Its own tile is no target; a popped-out or unknown session has none.
    expect(app.tileDropTargetAt(1, 1, 's-c')).toBeNull();
    app.detachedSessions.add('s-other');
    expect(app.tileDropTargetAt(1, 1, 's-other')).toBeNull();
    app.detachedSessions.delete('s-other');
    expect(app.tileDropTargetAt(1, 1, 's-nope')).toBeNull();

    expect(app.dropOnTileTarget('s-a', app.tileDropTargetAt(1, 1, 's-a'))).toBe(true);
    expect(app._tileGrid.ids).toEqual(['s-c', 's-b', 's-a', 's-d', 's-e']);

    pointHits.at = () => slots()[0];
    const cell = app.tileDropTargetAt(1, 1, 's-other');
    expect(cell).toEqual({ kind: 'cell', cell: 5, el: slots()[0] });
    expect(app.dropOnTileTarget('s-other', cell)).toBe(true);
    expect(app._tileGrid.cells).toEqual(['s-c', 's-b', 's-a', 's-d', 's-e', 's-other']);
  });

  it('a tiled session has no target while a tile is zoomed (moving is off)', () => {
    const app = openGrid(FOUR);
    app.zoomTile('s-a');
    pointHits.at = () => tileEl('s-a');
    expect(app.tileDropTargetAt(1, 1, 's-b')).toBeNull();
  });

  it('a hand let go outside the grid: the pop-out at that point, the page chrome counted', () => {
    const app = openGrid(FOUR);
    app.detachSession = vi.fn();
    windowStub.screenX = 0;
    windowStub.screenY = 0;
    windowStub.outerHeight = 1300;
    app.detachTileAtPoint('s-d', 500, 20, { offsetX: 100, offsetY: 10 });
    expect(app.detachSession).toHaveBeenCalledWith('s-d', { width: 2400, height: 1200, left: 400, top: 50 });
  });

  it('whether a point is over the grid', () => {
    const app = openGrid(FOUR);
    expect(app.isOverTileGrid(10, 10)).toBe(true);
    expect(app.isOverTileGrid(10, 5000)).toBe(false);
    app.closeTileGrid({ reselect: false });
    expect(app.isOverTileGrid(10, 10)).toBe(false);
  });
});

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');

describe("a tile's ⋯ menu", () => {
  function menuFor(sessionId: string, { tiled = true, detach = true, tabPopOut = false } = {}) {
    const dom = new JSDOM('<!doctype html><html><body><button id="t">⋯</button></body></html>', {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    const ctx = dom.getInternalVMContext();
    vm.runInContext('globalThis.CodemanApp = class CodemanApp {};', ctx);
    vm.runInContext(read('tab-rail-resize.js'), ctx, { filename: 'tab-rail-resize.js' });
    const App = (dom.window as unknown as { CodemanApp: { prototype: object } }).CodemanApp;
    const app = Object.assign(Object.create(App.prototype), {
      loadAppSettingsFromStorage: () => ({ showTabDetachButton: tabPopOut }),
      tabDetachButtonEnabled: (s: { showTabDetachButton?: boolean }) => s.showTabDetachButton === true,
      detachedSessions: new Set(),
      _tileGrid: { has: () => tiled },
      _tileDetachAllowed: () => detach,
      detachTile: vi.fn(),
      detachSession: vi.fn(),
      openSessionOptions: vi.fn(),
      requestCloseSession: vi.fn(),
    }) as Record<string, ReturnType<typeof vi.fn> & ((...a: unknown[]) => unknown)>;
    const doc = dom.window.document;
    app.openTabRailActionMenu(
      { preventDefault() {}, stopPropagation() {}, currentTarget: doc.getElementById('t') },
      sessionId
    );
    const items = [...doc.querySelectorAll('.tab-rail-action-menu [role="menuitem"]')] as HTMLButtonElement[];
    return {
      app,
      labels: items.map((b) => b.textContent),
      click: (label: string) => items.find((b) => b.textContent === label)!.click(),
    };
  }

  it('with Detach Tiles on: "Open in a new window" pops the tile out, placed over it', () => {
    const { app, labels, click } = menuFor('s-b');
    expect(labels).toEqual(['Session options', 'Open in a new window', 'Close session']);
    click('Open in a new window');
    expect(app.detachTile).toHaveBeenCalledWith('s-b');
    expect(app.detachSession).not.toHaveBeenCalled();
  });

  it('with it off: the menu is what it was (the tab pop-out setting still adds its own entry)', () => {
    expect(menuFor('s-b', { detach: false }).labels).toEqual(['Session options', 'Close session']);
    const tabbed = menuFor('s-b', { detach: false, tabPopOut: true });
    expect(tabbed.labels).toEqual(['Session options', 'Open in a new window', 'Close session']);
    tabbed.click('Open in a new window');
    expect(tabbed.app.detachSession).toHaveBeenCalledWith('s-b');
    // A tab (not a tile) with Detach Tiles on: only the tab setting decides.
    expect(menuFor('s-x', { tiled: false }).labels).toEqual(['Session options', 'Close session']);
  });
});

describe('tileDetachEnabled stays per-device and OFF by default', () => {
  const settingsUi = read('settings-ui.js');
  const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');
  const index = read('index.html');

  it('is a display key, stripped from the settings PUT, and absent from the .strict() schema', () => {
    const start = settingsUi.indexOf('const displayKeys = new Set([');
    expect(settingsUi.slice(start, settingsUi.indexOf('])', start))).toContain("'tileDetachEnabled'");
    expect(settingsUi).toContain('tileDetachEnabled: _tde,');
    expect(schemas).not.toContain('tileDetachEnabled');
  });

  it('loads OFF unless switched on, saves from its switch, and its row shows on desktop only', () => {
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsTileDetach').checked = settings.tileDetachEnabled === true;"
    );
    expect(settingsUi).toContain("tileDetachEnabled: document.getElementById('appSettingsTileDetach').checked,");
    expect(settingsUi).toMatch(/tileDetachItem\.style\.display = MobileDetection\.getDeviceType\(\) === 'desktop'/);
    expect(index).toMatch(/id="appSettingsTileDetachItem"[\s\S]*?<input type="checkbox" id="appSettingsTileDetach">/);
    // Not `checked` in the markup: OFF is the default.
    expect(index).not.toMatch(/id="appSettingsTileDetach" checked/);
  });

  it('a saved change repaints the tile handles (draggable, tooltip)', () => {
    expect(settingsUi).toContain('this._renderTileChrome?.();');
  });
});
