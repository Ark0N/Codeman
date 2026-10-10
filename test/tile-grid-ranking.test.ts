/**
 * @fileoverview Which sessions the tile grid takes when nobody said which
 * (owner request: "prefer to load in tiles that are working and then the most
 * recent, so the oldest don't get opened").
 *
 * - `rankTileSessions` (constants.js, pure): WORKING first, the most recently
 *   started turn first (keyed off `lastSubmitAt` only: a working pane's
 *   last-activity stamp is always "now"); then the ones that NEED INPUT (the
 *   red and yellow tab alerts: `needs` and `waiting`), most recent first; then
 *   every other one, most recently active first. A missing stamp (0) sorts
 *   last in its group, tab order breaks ties, so the order never shuffles.
 * - `tileGridOpenSet` case c opens the ranking's best up to the limit, the
 *   active session always among them and focused, detached ones never.
 * - In the app (`_tileGridRanking`, the home screens' `_mobileOverviewState`
 *   and stamps): the Tiles button with nothing stored, a count picked in its
 *   menu, Ctrl/Cmd+click and an open split's fill all take the ranking; a stale
 *   page without the classifier falls back to tab order.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEl, bySelector, makeGridApp, resetGridHarness, windowStub, type GridApp } from './mocks/tile-grid-vm.js';

type Row = { id: string; state: string; lastActivityAt?: number; lastSubmitAt?: number; orderIndex?: number };
type OpenSet = { source: string; ids: string[]; focusedId: string | null } | null;
type Helpers = {
  rankTileSessions(rows: unknown): string[];
  tileGridOpenSet(p: Record<string, unknown>): OpenSet;
  TILE_GRID_MAX: number;
};

const T = windowStub.CodemanTileGrid as Helpers;
const rank = (rows: Row[]) => T.rankTileSessions(rows.map((r, orderIndex) => ({ orderIndex, ...r })));

describe('rankTileSessions', () => {
  it('working first, then needing input (red and yellow), then everything else', () => {
    expect(
      rank([
        { id: 'idle', state: 'idle', lastActivityAt: 900 },
        { id: 'done', state: 'done', lastActivityAt: 800 },
        { id: 'waiting', state: 'waiting', lastActivityAt: 100 },
        { id: 'error', state: 'error', lastActivityAt: 950 },
        { id: 'working', state: 'working', lastSubmitAt: 10 },
        { id: 'needs', state: 'needs', lastActivityAt: 50 },
      ])
    ).toEqual(['working', 'waiting', 'needs', 'error', 'idle', 'done']);
  });

  it('working: the most recently started turn first', () => {
    expect(
      rank([
        { id: 'old', state: 'working', lastSubmitAt: 1_000, lastActivityAt: 9_000 },
        { id: 'new', state: 'working', lastSubmitAt: 5_000, lastActivityAt: 9_000 },
        { id: 'mid', state: 'working', lastSubmitAt: 3_000, lastActivityAt: 9_000 },
      ])
    ).toEqual(['new', 'mid', 'old']);
  });

  it('working keys off lastSubmitAt only: a pane that never submitted does not take the head on its repaint stamp', () => {
    expect(
      rank([
        { id: 'never-submitted', state: 'working', lastSubmitAt: 0, lastActivityAt: 99_999 },
        { id: 'submitted-long-ago', state: 'working', lastSubmitAt: 1, lastActivityAt: 99_998 },
      ])
    ).toEqual(['submitted-long-ago', 'never-submitted']);
  });

  it('needing input is one group, most recent first, whichever alert it raised', () => {
    expect(
      rank([
        { id: 'red-old', state: 'needs', lastActivityAt: 100 },
        { id: 'yellow-new', state: 'waiting', lastActivityAt: 300 },
        { id: 'red-new', state: 'needs', lastActivityAt: 200 },
      ])
    ).toEqual(['yellow-new', 'red-new', 'red-old']);
  });

  it('the rest: most recently active first, the oldest last', () => {
    expect(
      rank([
        { id: 'yesterday', state: 'idle', lastActivityAt: 1_000 },
        { id: 'just-now', state: 'done', lastActivityAt: 9_000 },
        { id: 'an-hour-ago', state: 'error', lastActivityAt: 5_000 },
      ])
    ).toEqual(['just-now', 'an-hour-ago', 'yesterday']);
  });

  it('no stamp sorts last in its group; equal stamps keep tab order, so it never shuffles', () => {
    const rows: Row[] = [
      { id: 'a', state: 'idle', orderIndex: 0 },
      { id: 'b', state: 'idle', lastActivityAt: 10, orderIndex: 1 },
      { id: 'c', state: 'idle', orderIndex: 2 },
      { id: 'd', state: 'idle', lastActivityAt: 10, orderIndex: 3 },
      { id: 'w', state: 'working', orderIndex: 4 },
      { id: 'v', state: 'working', lastSubmitAt: 5, orderIndex: 5 },
    ];
    const expected = ['v', 'w', 'b', 'd', 'a', 'c'];
    expect(T.rankTileSessions(rows)).toEqual(expected);
    expect(T.rankTileSessions([...rows].reverse())).toEqual(expected);
  });

  it('an unknown state counts as "everything else"', () => {
    expect(
      rank([
        { id: 'odd', state: 'mystery', lastActivityAt: 9 },
        { id: 'idle', state: 'idle', lastActivityAt: 5 },
        { id: 'busy', state: 'working', lastSubmitAt: 1 },
      ])
    ).toEqual(['busy', 'odd', 'idle']);
  });

  it('drops malformed rows and repeats, and never sorts its input in place', () => {
    const rows = [
      { id: 'b', state: 'idle', lastActivityAt: 1, orderIndex: 1 },
      null,
      { id: '', state: 'working' },
      { id: 'a', state: 'working', lastSubmitAt: 1, orderIndex: 0 },
      { id: 'b', state: 'idle', lastActivityAt: 1, orderIndex: 2 },
    ];
    const copy = JSON.stringify(rows);
    expect(T.rankTileSessions(rows)).toEqual(['a', 'b']);
    expect(JSON.stringify(rows)).toBe(copy);
    expect(T.rankTileSessions(null)).toEqual([]);
  });
});

describe('tileGridOpenSet with a ranking (case c)', () => {
  const order = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  const sessions = new Map(order.map((id) => [id, { id }]));
  const ranked = ['t8', 't6', 't1', 't3', 't7', 't2', 't5', 't4'];
  const base = { sessions, sessionOrder: order, ranked, limit: 4 };

  it('opens the best of the ranking, not the first tabs, the active one focused', () => {
    expect(T.tileGridOpenSet({ ...base, activeId: 't6' })).toEqual({
      source: 'ranked',
      ids: ['t8', 't6', 't1', 't3'],
      focusedId: 't6',
    });
  });

  it('an active session the ranking puts past the limit still comes, in the last place', () => {
    expect(T.tileGridOpenSet({ ...base, activeId: 't4' })?.ids).toEqual(['t8', 't6', 't1', 't4']);
  });

  it('never a detached session or one that no longer exists', () => {
    const out = T.tileGridOpenSet({
      ...base,
      ranked: ['gone', ...ranked],
      detachedIds: new Set(['t6']),
      activeId: null,
    });
    expect(out?.ids).toEqual(['t8', 't1', 't3', 't7']);
    expect(out?.focusedId).toBe('t8');
  });

  it('without a ranking it is tab order, as before', () => {
    expect(T.tileGridOpenSet({ sessions, sessionOrder: order, limit: 3, activeId: null })?.ids).toEqual([
      't1',
      't2',
      't3',
    ]);
  });
});

describe('in the app', () => {
  // Eight sessions, tab order s-1 .. s-8 (plus the harness's s-other, first and quiet).
  const IDS = ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6', 's-7', 's-8'];

  /** Statuses, hooks and stamps: two working, one red, one yellow, four quiet. */
  function rankedApp(): GridApp {
    const app = makeGridApp(IDS);
    const set = (id: string, fields: Record<string, unknown>) => Object.assign(app.sessions.get(id), fields);
    set('s-other', { status: 'idle', lastActivityAt: 1_000 });
    set('s-1', { status: 'idle', lastActivityAt: 2_000 }); // the oldest quiet one
    set('s-2', { status: 'busy', lastSubmitAt: 5_000, lastActivityAt: 99_000 }); // working, older turn
    set('s-3', { status: 'idle', lastActivityAt: 8_000 });
    set('s-4', { status: 'idle', lastActivityAt: 7_000 }); // red: a permission dialog
    set('s-5', { status: 'stopped', lastActivityAt: 3_000 });
    set('s-6', { status: 'busy', lastSubmitAt: 9_000, lastActivityAt: 99_000 }); // working, newest turn
    set('s-7', { status: 'idle', lastActivityAt: 6_000 }); // yellow: a finished turn not seen
    set('s-8', { status: 'idle', lastActivityAt: 9_500 });
    app.pendingHooks.set('s-4', new Set(['permission_prompt']));
    app.pendingHooks.set('s-7', new Set(['idle_prompt']));
    app.activeSessionId = null;
    return app;
  }

  beforeEach(() => {
    resetGridHarness();
    bySelector.set('.terminal-wrap', new FakeEl());
  });

  it('ranks with the home screens’ classification and stamps', () => {
    expect(rankedApp()._tileGridRanking()).toEqual(['s-6', 's-2', 's-4', 's-7', 's-8', 's-3', 's-5', 's-1', 's-other']);
  });

  it('the Tiles button with nothing stored opens working, then needing input, then the most recent; the oldest stay out', () => {
    const app = rankedApp();
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-6', 's-2', 's-4', 's-7', 's-8', 's-3']);
    expect(app._tileGrid.ids).not.toContain('s-1');
    expect(app._tileGrid.ids).not.toContain('s-other');
    // No active session: the best ranked takes focus.
    expect(app._tileGrid.focusedId).toBe('s-6');
  });

  it('the active session always comes and takes focus, even ranked last', () => {
    const app = rankedApp();
    app.activeSessionId = 's-1';
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-6', 's-2', 's-4', 's-7', 's-8', 's-1']);
    expect(app._tileGrid.focusedId).toBe('s-1');
  });

  it('the remembered count takes that many from the top; a detached session is never tiled', () => {
    const app = rankedApp();
    app.detachedSessions.add('s-2');
    app._rememberTileGridCount(4);
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-6', 's-4', 's-7', 's-8']);
  });

  it('a count picked in the menu fills an open grid from the ranking', () => {
    const app = rankedApp();
    app.openTileGrid(['s-1', 's-5'], { focusedId: 's-5' });
    app._pickTileCount(4);
    expect(app._tileGrid.cells).toEqual(['s-1', 's-5', 's-6', 's-2']);
    expect(app._tileGrid.focusedId).toBe('s-5');
  });

  it('Ctrl/Cmd+click with nothing stored: the clicked one plus the best of the ranking, the count in total', () => {
    const app = rankedApp();
    app._rememberTileGridCount(4);
    app.addSessionToTiles('s-5');
    expect(app._tileGrid.ids).toEqual(['s-6', 's-2', 's-4', 's-5']);
    expect(app._tileGrid.focusedId).toBe('s-5');
  });

  it('an open split comes first (case b), the rest from the ranking', () => {
    const app = rankedApp();
    app.activeSessionId = 's-1';
    app._splitPane = {};
    app._splitSessionId = 's-5';
    app.closeSplitPane = vi.fn(() => {
      app._splitPane = null;
    });
    app._rememberTileGridCount(4);
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-1', 's-5', 's-6', 's-2']);
    expect(app._tileGrid.focusedId).toBe('s-1');
  });

  it('a page without the classifier (a stale cached mobile-overview.js) falls back to tab order', () => {
    const app = rankedApp();
    app._mobileOverviewState = undefined;
    expect(app._tileGridRanking()).toEqual(['s-other', ...IDS]);
  });
});
