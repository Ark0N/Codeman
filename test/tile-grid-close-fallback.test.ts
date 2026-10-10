/**
 * @fileoverview Closing or deleting a tiled session keeps the grid open and
 * moves focus to the NEIGHBOURING tile.
 *
 * `closeSession()` normally falls back to the first remaining `sessionOrder`
 * entry with `auto: true`, and that entry is often NOT tiled: an app-driven
 * pick that, with the grid open, would be refused (auto never collapses the
 * grid) and leave nothing focused. So the fallback is grid-aware, and it lives
 * IN closeSession: the delete broadcast routinely lands while the request is in
 * flight, and the delete handlers skip ids in `_closingSessions`. The close is
 * optimistic, so the tile goes and the neighbour takes focus before the request
 * is even sent; the broadcast then finds nothing left to do.
 *
 * - closing the focused tile: next tile in grid order, else the previous one;
 *   `s-other` is FIRST in sessionOrder and never tiled, so the old pick would
 *   have collapsed the grid;
 * - the same with the broadcast arriving mid-request and after it;
 * - closing the last tile closes the grid and falls back to the normal pick;
 * - a tiled session deleted ELSEWHERE: its tile goes, a neighbour takes focus
 *   with `auto` (no idle alert spent); the last one leaves the welcome screen.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTile, flushFrames, makeGridApp, resetGridHarness, type GridApp } from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];

/** A grid on `ids` focused on `focus`, with the DELETE request held open until `finish()`. */
function setup(ids = IDS, focus = ids[0]) {
  const app = makeGridApp(ids);
  app.openTileGrid(ids, { focusedId: focus });
  app.selectSession = vi.fn();
  app.markIdleAlertSeen.mockClear();
  let finish: () => void = () => {};
  // Resolves like the real helper's Response once `finish()` is called.
  app._apiDelete = vi.fn(() => new Promise((r) => (finish = () => r({ ok: true, status: 200 }))));
  // The real cleanup touches a lot of panels; what the fallback reads is the session list.
  app._cleanupSessionData = vi.fn((id: string) => {
    app.sessions.delete(id);
    app.sessionOrder = app.sessionOrder.filter((s: string) => s !== id);
  });
  return { app: app as GridApp, finish: () => finish() };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  resetGridHarness();
});

describe('closeSession on the focused tile', () => {
  it('keeps the grid open and focuses the next tile, never the untiled first sessionOrder entry', async () => {
    const { app, finish } = setup(IDS, 's-a');
    const closing = app.closeSession('s-a');
    finish();
    await closing;

    expect(app._tilesOwnTerminal()).toBe(true);
    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.activeSessionId).toBe('s-b');
    expect(app.selectSession).not.toHaveBeenCalled();
    // The app chose the neighbour: no idle alert spent.
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });

  it('the last tile in grid order hands focus back to the previous one', async () => {
    const { app, finish } = setup(IDS, 's-c');
    const closing = app.closeSession('s-c');
    finish();
    await closing;
    expect(app.activeSessionId).toBe('s-b');
  });

  it('the delete broadcast arriving DURING the request changes nothing about the outcome', async () => {
    const { app, finish } = setup(IDS, 's-b');
    const closing = app.closeSession('s-b');
    await settle();
    // The close already moved focus to the neighbour before the request went
    // out; the broadcast for it must not move it again.
    expect(app.activeSessionId).toBe('s-c');
    app._onSessionDeleted({ id: 's-b' });
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
    expect(app.showWelcome).not.toHaveBeenCalled();
    finish();
    await closing;

    expect(app._tilesOwnTerminal()).toBe(true);
    expect(app.activeSessionId).toBe('s-c');
    expect(app.showWelcome).not.toHaveBeenCalled();
  });

  it('the delete broadcast arriving AFTER the request is a no-op for the grid', async () => {
    const { app, finish } = setup(IDS, 's-a');
    const closing = app.closeSession('s-a');
    finish();
    await closing;
    app._onSessionDeleted({ id: 's-a' });
    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.activeSessionId).toBe('s-b');
  });

  it('closing the LAST tile closes the grid and falls back to the normal pick', async () => {
    const { app, finish } = setup(['s-a'], 's-a');
    const closing = app.closeSession('s-a');
    finish();
    await closing;

    expect(app._tilesOwnTerminal()).toBe(false);
    expect(FakeTile.all[0].destroy).toHaveBeenCalledTimes(1);
    expect(app.selectSession).toHaveBeenCalledWith('s-other', { auto: true });
  });

  it('closing a tile that is NOT focused removes it and leaves focus alone', async () => {
    const { app, finish } = setup(IDS, 's-a');
    const closing = app.closeSession('s-c');
    finish();
    await closing;
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b']);
    expect(app.activeSessionId).toBe('s-a');
  });
});

describe('a tiled session deleted elsewhere', () => {
  it('removes its tile and moves focus to the neighbour with `auto`', () => {
    const { app } = setup(IDS, 's-b');
    app._onSessionDeleted({ id: 's-b' });

    expect(app._tileGrid.ids).toEqual(['s-a', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
    expect(app.showWelcome).not.toHaveBeenCalled();
  });

  it('a deleted tile that was not focused just goes', () => {
    const { app } = setup(IDS, 's-a');
    app._onSessionDeleted({ id: 's-c' });
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b']);
    expect(app.activeSessionId).toBe('s-a');
  });

  it('the last tile deleted closes the grid and lands on the welcome screen, as in the single view', () => {
    const { app } = setup(['s-a'], 's-a');
    app._onSessionDeleted({ id: 's-a' });
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(app.activeSessionId).toBeNull();
    expect(app.showWelcome).toHaveBeenCalled();
  });
});

// The handoffs above are the APP's choice: focus moves (activeSessionId, the
// focus paint) but the keyboard does not. Moving DOM focus into the
// neighbour's xterm sent whatever the user was still typing, Enter included,
// into another session's agent; the single view sends it nowhere. Only a
// removal the user made (the x button, Remove Focused Tile) carries the
// keyboard along.
describe('an app-driven refocus never moves the keyboard into another session', () => {
  const live = (id: string) => FakeTile.all.find((t) => t.sessionId === id && !t._destroyed)!;
  const focusCalls = () => FakeTile.all.reduce((n, t) => n + t.terminal.focus.mock.calls.length, 0);
  /** A grid on IDS focused on s-b, every terminal built, no focus recorded yet. */
  function built() {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS, { focusedId: 's-b' });
    flushFrames();
    for (const t of FakeTile.all) t.terminal.focus.mockClear();
    return app;
  }

  it('a remote delete of the focused tile hands focus to the neighbour, DOM focus untouched', () => {
    const app = built();
    app._onSessionDeleted({ id: 's-b' });
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
    expect(app._tileGrid.focusedId).toBe('s-c');
    expect(focusCalls()).toBe(0);
    // No deferred focus left to land later either.
    expect(app._tileGrid.focusOnConnect ?? null).toBeNull();
  });

  it.each([4003, 4004, 4010])('a socket the server closed (%i) removes the tile, DOM focus untouched', (code) => {
    const app = built();
    app._onTileExit('s-b', live('s-b'), code);
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
    expect(focusCalls()).toBe(0);
  });

  it('a reconcile that finds the focused session gone moves focus, DOM focus untouched', () => {
    const app = built();
    app.sessions.delete('s-b');
    app._reconcileTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c']);
    expect(app.activeSessionId).toBe('s-a');
    expect(focusCalls()).toBe(0);
  });

  it('a removal the user made still carries the keyboard to the neighbour', () => {
    const app = built();
    app.removeFocusedTile();
    expect(app.activeSessionId).toBe('s-c');
    expect(live('s-c').terminal.focus).toHaveBeenCalledTimes(1);
  });
});
