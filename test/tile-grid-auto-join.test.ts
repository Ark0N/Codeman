/**
 * @fileoverview New sessions started from THIS tab's Run join the open grid.
 *
 * Every Run path calls `_ensureCreatedSessionVisible` for each session it
 * created, then `selectSession(firstId)` (a human selection). With the grid open,
 * `_joinTileGridFromRun` (called from there) adds each new session to the next
 * free slot, so that selection focuses its tile instead of leaving the grid.
 * Sessions created elsewhere (agents, other devices, cron) arrive only by
 * `session:created` and never join. A grid already holding what the window
 * fits does not take it: Run's selection then shows it alone, with a hint.
 *
 * A tile that joined before its pane existed resends its size once the pid
 * appears (the server spawned the pane at its own default size).
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts); the Run
 * hook in session-ui.js is pinned at the source. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTile, makeGridApp, resetGridHarness, section, type GridApp, tileEl } from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b'];
const addSession = (app: GridApp, id: string, workingDir = '/w') =>
  app.sessions.set(id, { id, name: id, mode: 'claude', pid: null, workingDir });

beforeEach(() => {
  resetGridHarness();
});

describe('Run from this tab', () => {
  it('the Run hook is where every Run path makes its new session visible', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    const helper = src.slice(src.indexOf('async _ensureCreatedSessionVisible('), src.indexOf('async run() {'));
    expect(helper).toContain('this._joinTileGridFromRun?.(sessionId);');
  });

  it('with the grid open, the new session joins the next free slot; Run then focuses its tile', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    addSession(app, 's-new');
    expect(app._joinTileGridFromRun('s-new')).toBe(true);
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b', 's-new']);
    // What Run does next: a human selection of the session it created.
    app.selectSession('s-new');
    expect(app._tilesOwnTerminal()).toBe(true);
    expect(app.activeSessionId).toBe('s-new');
  });

  it('no Attach overlay flashes on the new tile while Run starts its pane', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    addSession(app, 's-new');
    app._joinTileGridFromRun('s-new');
    const tile = tileEl('s-new');
    const overlay = tile.children[1].children.find((c) => c.className === 'tile-attach');
    expect(!overlay || overlay.hidden).toBe(true);
  });

  it('with the grid closed, nothing joins', () => {
    const app = makeGridApp(IDS);
    addSession(app, 's-new');
    expect(app._joinTileGridFromRun('s-new')).toBe(false);
    expect(app._tileGrid?.open ?? false).toBe(false);
  });

  it('a grid that already holds what the window fits does not take it, and says so', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    addSession(app, 's-new');
    section.getBoundingClientRect = () => ({ width: 1000, height: 400, top: 0, left: 0, right: 1000, bottom: 400 });
    expect(app._joinTileGridFromRun('s-new')).toBe(false);
    delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
    expect(app._tileGrid.ids).toEqual(IDS);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('opens on its own'), 'info');
  });

  it('a session created ELSEWHERE (session:created) never joins', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.renderSessionTabs = vi.fn();
    app.saveSessionOrder = vi.fn();
    app.updateCost = vi.fn();
    app._onSessionCreated({ id: 's-agent', name: 's-agent', mode: 'claude', pid: 1, workingDir: '/w' });
    expect(app.sessions.has('s-agent')).toBe(true);
    expect(app._tileGrid.ids).toEqual(IDS);
  });
});

describe('a pane that starts after its tile connected (#464)', () => {
  // The tile sent its size before there was a PTY; the server dropped it and
  // spawned the pane at its default size, so the size must go out again.
  const tileOf = (id: string) => FakeTile.all.filter((t) => t.sessionId === id).at(-1)!;
  const setPid = (app: GridApp, id: string, pid: number | null) =>
    app.sessions.set(id, { ...app.sessions.get(id), pid });

  it('resends the size once when the pid appears, and again only for a new PTY', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    addSession(app, 's-new');
    app._joinTileGridFromRun('s-new');
    const tile = tileOf('s-new');
    app._renderTileChrome();
    expect(tile.paneStarted).not.toHaveBeenCalled();

    setPid(app, 's-new', 4242);
    app._renderTileChrome();
    expect(tile.paneStarted).toHaveBeenCalledTimes(1);
    app._renderTileChrome();
    expect(tile.paneStarted).toHaveBeenCalledTimes(1);

    // The pane went away and a new one started (an Attach, a respawned pane).
    setPid(app, 's-new', null);
    app._renderTileChrome();
    setPid(app, 's-new', 4343);
    app._renderTileChrome();
    expect(tile.paneStarted).toHaveBeenCalledTimes(2);
  });

  it('a tile made for a session that already runs never asks', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app._renderTileChrome();
    app._renderTileChrome();
    for (const id of IDS) expect(tileOf(id).paneStarted).not.toHaveBeenCalled();
  });
});
