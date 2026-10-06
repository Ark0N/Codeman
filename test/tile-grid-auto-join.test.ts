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
 * A tile's + also offers "New session in this case": the normal Run for the
 * case the tile's session belongs to, the toolbar's case put back afterwards.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts); the Run
 * hook in session-ui.js is pinned at the source. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  body,
  bySelector,
  makeGridApp,
  resetGridHarness,
  section,
  type GridApp,
} from './mocks/tile-grid-vm.js';

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
    const tile = section.children.find((el) => el.dataset.sessionId === 's-new') as FakeEl;
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

describe('+ / New session in this case', () => {
  function openMenu(app: GridApp, fromId: string) {
    app.openTileAddMenu({ stopPropagation: vi.fn(), preventDefault: vi.fn(), currentTarget: null }, fromId);
    const menu = body.children.find((c) => c.className.includes('tile-add-menu'))!;
    return menu.children.find((c) => c.className === 'tile-add-new')!;
  }

  it('runs the normal Run in the tile session case, then puts the toolbar case back', async () => {
    const app = makeGridApp(IDS);
    app.cases = [{ name: 'proj', path: '/w' }];
    app._mobileOverviewCaseFor = (dir: string, cases: Array<{ name: string; path: string }>) =>
      cases.find((c) => dir.startsWith(c.path)) ?? null;
    const select = new FakeEl();
    select.value = 'other-case';
    bySelector.set('#quickStartCase', select);
    const calls: string[] = [];
    app.selectQuickStartCase = vi.fn((name: string) => {
      calls.push(`case:${name}`);
      select.value = name;
    });
    app.run = vi.fn(async () => calls.push(`run in ${select.value}`));
    app.openTileGrid(IDS);
    const item = openMenu(app, 's-a');
    expect(item.disabled).toBe(false);
    item.dispatch('click');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual(['case:proj', 'run in proj', 'case:other-case']);
    expect(app.selectQuickStartCase).toHaveBeenCalledWith('proj', { save: false });
  });

  it('is disabled for a session that is not in a case', () => {
    const app = makeGridApp(IDS);
    app.cases = [];
    app._mobileOverviewCaseFor = () => null;
    app.openTileGrid(IDS);
    expect(openMenu(app, 's-a').disabled).toBe(true);
  });
});
