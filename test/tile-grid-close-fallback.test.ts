/**
 * @fileoverview Closing or deleting a tiled session keeps the grid open and
 * moves focus to the NEIGHBOURING tile.
 *
 * `closeSession()` normally falls back to the first remaining `sessionOrder`
 * entry with `auto: true`, and that entry is often NOT tiled: an app-driven
 * pick that, with the grid open, would be refused (auto never collapses the
 * grid) and leave nothing focused. So the fallback is grid-aware, and it lives
 * IN closeSession: the delete broadcast routinely lands while the request is in
 * flight, and the delete handlers skip ids in `_closingSessions`. The neighbour
 * is captured BEFORE the await, like `wasActive`, because that broadcast may
 * already have removed the tile.
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
import { FakeTile, makeGridApp, resetGridHarness, type GridApp } from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];

/** A grid on `ids` focused on `focus`, with the DELETE request held open until `finish()`. */
function setup(ids = IDS, focus = ids[0]) {
  const app = makeGridApp(ids);
  app.openTileGrid(ids, { focusedId: focus });
  app.selectSession = vi.fn();
  app.markIdleAlertSeen.mockClear();
  let finish: () => void = () => {};
  app._apiDelete = vi.fn(() => new Promise<void>((r) => (finish = r)));
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
    app._onSessionDeleted({ id: 's-b' });
    // Only the tile went; closeSession owns the follow-up (as the split's
    // wrapper does for ids in _closingSessions), so focus has not moved yet.
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c']);
    expect(app.activeSessionId).toBe('s-b');
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
