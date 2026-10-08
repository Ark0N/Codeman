/**
 * @fileoverview The tile branch of `selectSession`, and focus moving between tiles.
 *
 * With the tile grid open the main terminal is parked, so a selection must
 * never reach the half of selectSession that cleans it up, replays into it or
 * reconnects its socket. A TILED session is focused in its tile
 * (`_selectTiledSession`: an `activeSessionId` change plus `xterm.focus()`, the
 * same panel refresh as a normal switch). Decision 1: a USER-initiated pick of
 * a session that is NOT tiled leaves the grid for the single view (the grid is
 * remembered), and so does an explicit `leaveTiles` (a followed link); an
 * app-driven pick (`auto: true`) never collapses the grid.
 *
 * Focus and alert rules: only a human selection acknowledges an idle alert.
 * Pressing a tile, Ctrl+Tab / Alt+[ ] (which cycle through the tiles) and a tab
 * click are human; the delete fallback and a popped-out tile are the app's.
 *
 * Real code: constants.js + app.js + terminal-ui.js + tile-grid.js (the shared
 * vm harness in test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  bySelector,
  flushFrames,
  idleCallbacks,
  localStore,
  makeGridApp,
  resetGridHarness,
  type GridApp,
  tileEl,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];

/** A grid open on IDS (focus s-a), with selectSession REAL and the main terminal's select path tripwired. */
function openGrid(): GridApp {
  const app = makeGridApp(IDS);
  app.openTileGrid(IDS);
  // The tiles' terminals are built one per frame (_connectTilesPaced).
  flushFrames();
  delete app.selectSession; // the prototype's, for real
  app._cleanupPreviousSession.mockClear();
  app.markIdleAlertSeen.mockClear();
  // Anything past the tile branch: the main terminal's own select path.
  app._shouldFocusTerminalForTabSwitch = vi.fn(() => false);
  app._setTerminalLoadState = vi.fn(() => {
    throw new Error('the main terminal select path ran');
  });
  return app;
}

beforeEach(() => {
  resetGridHarness();
});

describe('selectSession with the grid open', () => {
  it('focuses a tiled session in its tile and never touches the main terminal', async () => {
    const app = openGrid();
    await app.selectSession('s-b');

    expect(app.activeSessionId).toBe('s-b');
    expect(app._tileGrid.focusedId).toBe('s-b');
    expect(app._cleanupPreviousSession).not.toHaveBeenCalled();
    expect(app._connectWs).not.toHaveBeenCalled();
    expect(app.sendResize).not.toHaveBeenCalled();
    expect(FakeTile.all.find((t) => t.sessionId === 's-b')?.terminal.focus).toHaveBeenCalled();
    expect(app._focusedPane().sessionId).toBe('s-b');
  });

  it('focus changes leave at most one glow listener on a tab, and the glow runs again once it ended', async () => {
    // On every skin but OG the glow is `animation: none`: animationend never
    // fires, and every focus used to add one more once-listener to the tab.
    const app = openGrid();
    const tab = new FakeEl();
    tab.className = 'session-tab active';
    bySelector.set('.session-tab.active[data-id="s-b"]', tab);
    for (let i = 0; i < 5; i++) {
      await app.selectSession('s-b');
      await app.selectSession('s-a');
    }
    expect(tab.classList.contains('tab-glow')).toBe(true);
    expect(tab.listeners.animationend).toHaveLength(1);

    // OG: the animation ends, the class goes, and the next focus glows again.
    tab.dispatch('animationend');
    tab.listeners.animationend = [];
    expect(tab.classList.contains('tab-glow')).toBe(false);
    await app.selectSession('s-b');
    expect(tab.classList.contains('tab-glow')).toBe(true);
    expect(tab.listeners.animationend).toHaveLength(1);
  });

  it('a user-initiated focus acknowledges the idle alert; an `auto` one does not', async () => {
    const app = openGrid();
    await app.selectSession('s-b');
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-b');

    app.markIdleAlertSeen.mockClear();
    await app.selectSession('s-c', { auto: true });
    expect(app.activeSessionId).toBe('s-c');
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });

  it('runs the same deferred panel refresh as a normal switch, tagged with its own generation', async () => {
    const app = openGrid();
    idleCallbacks.length = 0;
    await app.selectSession('s-b');
    const genB = app._selectGeneration;
    expect(app._refreshSessionPanels).not.toHaveBeenCalled(); // deferred
    for (const cb of idleCallbacks.splice(0)) cb();
    expect(app._refreshSessionPanels).toHaveBeenCalledWith('s-b', genB);
  });

  it('an `auto` selection of a session that is NOT tiled leaves the grid open and changes nothing', async () => {
    const app = openGrid();
    await app.selectSession('s-other', { auto: true });

    expect(app._tilesOwnTerminal()).toBe(true);
    expect(app.activeSessionId).toBe('s-a');
    expect(FakeTile.all.every((t) => t.destroy.mock.calls.length === 0)).toBe(true);
  });

  it('a user-initiated selection of a session that is NOT tiled leaves the grid, remembered', async () => {
    const app = openGrid();
    let activeAtCleanup: unknown = 'unset';
    app._cleanupPreviousSession = vi.fn(() => {
      activeAtCleanup = app.activeSessionId;
    });
    app._setTerminalLoadState = vi.fn();
    app._clearTerminalLoadState = vi.fn();
    app._renderHistoryTruncationBanner = vi.fn();
    app._isStaleSelect = vi.fn(() => true); // stop right after the switch itself
    await app.selectSession('s-other').catch(() => {});

    expect(app._tilesOwnTerminal()).toBe(false);
    expect(FakeTile.all.every((t) => t.destroy.mock.calls.length === 1)).toBe(true);
    expect(JSON.parse(localStore.get('codeman:tile-grid')!)).toMatchObject({ open: false, ids: IDS, focused: 's-a' });
    // The parked terminal's stale content must not be saved as s-a's snapshot.
    expect(activeAtCleanup).toBeNull();
    expect(app.activeSessionId).toBe('s-other');
  });

  it('`leaveTiles` makes even an `auto` selection leave the grid (a followed link is navigation)', async () => {
    const app = openGrid();
    app._setTerminalLoadState = vi.fn();
    app._clearTerminalLoadState = vi.fn();
    app._renderHistoryTruncationBanner = vi.fn();
    app._isStaleSelect = vi.fn(() => true);
    await app.selectSession('s-other', { auto: true, leaveTiles: true }).catch(() => {});
    expect(app._tilesOwnTerminal()).toBe(false);
  });

  it('a followed `#session=` link passes leaveTiles, and a tiled one just focuses its tile', async () => {
    const app = openGrid();
    app._urlSessionId = 's-c';
    app._selectUrlSession();
    await Promise.resolve();
    expect(app._tilesOwnTerminal()).toBe(true);
    expect(app.activeSessionId).toBe('s-c');
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });
});

describe('moving focus between tiles', () => {
  it('pressing a tile is a human selection of its session', async () => {
    const app = openGrid();
    app.selectSession = vi.fn();
    const tileB = tileEl('s-b');
    tileB?.dispatch('pointerdown');
    expect(app.selectSession).toHaveBeenCalledWith('s-b');
  });

  it('Ctrl+Tab / Alt+] and Alt+[ cycle through the tiles (wrapping), user-initiated, and only the tiles', () => {
    const app = openGrid();
    app.selectSession = vi.fn();
    // From the last tile, the next one wraps to the first tile; the tab order
    // would have wrapped to s-other (first in sessionOrder, not tiled).
    app.activeSessionId = 's-c';
    app.nextSession();
    expect(app.selectSession.mock.calls).toEqual([['s-a']]);
    app.selectSession.mockClear();
    app.activeSessionId = 's-a';
    app.prevSession();
    expect(app.selectSession.mock.calls).toEqual([['s-c']]);
  });

  it('without the grid they walk the tab order as before', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.nextSession();
    expect(app.selectSession).toHaveBeenLastCalledWith('s-b');
  });

  it('a tiled session popped out to its own window leaves the grid; a neighbour takes focus', () => {
    const app = openGrid();
    app.$ = () => null;
    app._markDetached('s-a', true);
    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.activeSessionId).toBe('s-b');
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });

  it('going Home leaves the grid, remembered', () => {
    const app = openGrid();
    app.goHome();
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(JSON.parse(localStore.get('codeman:tile-grid')!)).toMatchObject({ open: false, ids: IDS });
    expect(app.activeSessionId).toBeNull();
    expect(app.showWelcome).toHaveBeenCalled();
  });
});
