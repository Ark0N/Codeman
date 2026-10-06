/**
 * @fileoverview The ways into the grid besides the Tiles button.
 *
 * - Drag a tab from the strip onto a tile: a session not yet tiled replaces it
 *   (same place, the replaced session keeps running); one already tiled swaps
 *   places. Onto an empty slot (3 tiles in a 2x2): it joins there. The tile
 *   handles the drag in the CAPTURE phase and stops it, because the payload is
 *   the session id as text and xterm's helper textarea would type it into the
 *   PTY; a drag that is not a tab (a file) is left alone.
 * - Ctrl/Cmd+click on a tab: the session joins the grid (opening it on what
 *   Tiles would bring back) and takes focus, as a human selection; on a window
 *   too narrow for the grid it is an ordinary click.
 * - "Open group as tiles" in the grouped rail's group menu: the group's live
 *   sessions become the grid.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  makeGridApp,
  resetGridHarness,
  section,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];
const tileEl = (id: string) => section.children.find((el) => el.dataset.sessionId === id) as FakeEl;
const slots = () => section.children.filter((el) => el.className === 'tile-slot');
const dragEvent = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { dropEffect: '' } });

function dropOn(el: FakeEl) {
  const over = dragEvent();
  el.dispatch('dragover', over);
  const drop = dragEvent();
  el.dispatch('drop', drop);
  return { over, drop };
}

beforeEach(() => {
  resetGridHarness();
});

describe('dragging a tab onto a tile', () => {
  it('a session not yet tiled replaces the tile in place; the replaced one keeps running', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.markIdleAlertSeen.mockClear();
    const replaced = FakeTile.all.find((t) => t.sessionId === 's-b')!;
    app.draggedTabId = 's-other';
    const { over, drop } = dropOn(tileEl('s-b'));

    expect(over.preventDefault).toHaveBeenCalled();
    expect(drop.stopPropagation).toHaveBeenCalled();
    expect(app._tileGrid.ids).toEqual(['s-a', 's-other', 's-c']);
    expect(replaced.destroy).toHaveBeenCalledTimes(1);
    expect(app.sessions.has('s-b')).toBe(true);
    expect(tileEl('s-other').style.gridColumn).toBe('3');
    expect(app.activeSessionId).toBe('s-other');
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-other');
  });

  it('a session already tiled swaps places with the target', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.draggedTabId = 's-c';
    dropOn(tileEl('s-a'));
    expect(app._tileGrid.ids).toEqual(['s-c', 's-b', 's-a']);
    expect(FakeTile.all.every((t) => t.destroy.mock.calls.length === 0)).toBe(true);
    expect(tileEl('s-c').style.gridColumn).toBe('1');
    expect(app.activeSessionId).toBe('s-c');
  });

  it('a drag that is not a tab (a file) is left alone', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.draggedTabId = null;
    const { over, drop } = dropOn(tileEl('s-b'));
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(drop.stopPropagation).not.toHaveBeenCalled();
    expect(app._tileGrid.ids).toEqual(IDS);
  });

  it('is handled in the capture phase, before xterm sees the drop', () => {
    makeGridApp(IDS).openTileGrid(IDS);
    expect(tileEl('s-a').captureFlags.dragover).toEqual([true]);
    expect(tileEl('s-a').captureFlags.drop).toEqual([true]);
  });
});

describe('dragging a tab onto an empty slot', () => {
  // Under 1800px wide three tiles take a 2x2 (over it, they sit side by side).
  beforeEach(() => {
    section.getBoundingClientRect = () => ({ width: 1700, height: 1000, top: 0, left: 0, right: 1700, bottom: 1000 });
  });
  afterEach(() => {
    delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
  });

  it('3 tiles in a 2x2 leave one slot, placed after the tiles', () => {
    makeGridApp(IDS).openTileGrid(IDS);
    expect(slots()).toHaveLength(1);
    expect([slots()[0].style.gridColumn, slots()[0].style.gridRow]).toEqual(['3', '3']);
  });

  it('a session dropped there joins the grid and takes focus', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.draggedTabId = 's-other';
    dropOn(slots()[0]);
    expect(app._tileGrid.ids).toEqual([...IDS, 's-other']);
    expect(slots()).toHaveLength(0);
    expect(app.activeSessionId).toBe('s-other');
  });

  it('a full layout has no slot', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(['s-a', 's-b']);
    expect(slots()).toHaveLength(0);
  });
});

describe('Ctrl/Cmd+click on a tab', () => {
  const click = (mods: Record<string, boolean>) => ({ preventDefault: vi.fn(), ...mods });

  it('with the grid closed: opens what the Tiles toggle would, plus the clicked one, focusing it', () => {
    const app = makeGridApp(IDS);
    app.activeSessionId = 's-a';
    // Nothing remembered, no split: the open sessions in tab order (the clicked one last).
    app.handleSessionTabClick(click({ ctrlKey: true }), 's-c');
    expect(app._tileGrid.ids).toEqual(['s-other', 's-a', 's-b', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-c');
  });

  it('with the grid open: adds it and focuses it (Cmd works the same)', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(['s-a', 's-b']);
    app.markIdleAlertSeen.mockClear();
    app.handleSessionTabClick(click({ metaKey: true }), 's-c');
    expect(app._tileGrid.ids).toEqual(IDS);
    expect(app.activeSessionId).toBe('s-c');
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-c');
  });

  it('on a tiled one: just focuses its tile', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.handleSessionTabClick(click({ ctrlKey: true }), 's-b');
    expect(app._tileGrid.ids).toEqual(IDS);
    expect(app.activeSessionId).toBe('s-b');
  });

  it('a plain click is still a plain selection', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.handleSessionTabClick(click({}), 's-b');
    expect(app.selectSession).toHaveBeenCalledWith('s-b', { forceReload: true });
    expect(app._tileGrid?.open ?? false).toBe(false);
  });

  it('on a window too narrow for the grid it is an ordinary click', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    windowStub.innerWidth = 1100;
    app.handleSessionTabClick(click({ ctrlKey: true }), 's-b');
    expect(app.selectSession).toHaveBeenCalledWith('s-b', { forceReload: true });
    expect(app._tileGrid?.open ?? false).toBe(false);
  });
});

describe('"Open group as tiles"', () => {
  function withGroups(app: GridApp) {
    app.tabLayout = {
      groups: [
        {
          id: 'g1',
          refs: [
            { kind: 'session', id: 's-c' },
            // A web tab is never a tile, even one whose id a session also has.
            { kind: 'webview', id: 's-b' },
            { kind: 'session', id: 'gone' },
            { kind: 'session', id: 's-a' },
          ],
        },
      ],
    };
    let actions: Array<{ label: string; run: () => void }> = [];
    app._openTabLayoutMenu = vi.fn((_e: unknown, _k: string, _l: string, a: typeof actions) => {
      actions = a;
      return true;
    });
    return () => actions;
  }

  it('is in the group menu, and opens the group live sessions as tiles', () => {
    const app = makeGridApp(IDS);
    const actions = withGroups(app);
    app.openTabGroupMenu({}, 'g1');
    const open = actions().find((a) => a.label === 'Open group as tiles');
    expect(open).toBeTruthy();
    open!.run();
    expect(app._tileGrid.ids).toEqual(['s-c', 's-a']);
  });

  it('replaces an open grid', () => {
    const app = makeGridApp(IDS);
    withGroups(app);
    app.openTileGrid(['s-b']);
    app.openGroupAsTiles('g1');
    expect(app._tileGrid.ids).toEqual(['s-c', 's-a']);
  });

  it('is not offered where the grid cannot open', () => {
    const app = makeGridApp(IDS);
    const actions = withGroups(app);
    windowStub.innerWidth = 1100;
    app.openTabGroupMenu({}, 'g1');
    expect(actions().some((a) => a.label === 'Open group as tiles')).toBe(false);
  });
});
