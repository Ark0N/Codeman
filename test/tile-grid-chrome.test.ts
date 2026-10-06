/**
 * @fileoverview A tile's header: `● name ......... ⋯ ×`, and the tab marker.
 *
 * - The dot uses the six-state classifier the tab rows and both home screens
 *   share (`_sidebarRichRow`), with the existing `.home-sessions-dot--*`
 *   classes; a `needs` tile gets the pulsing red border; hovering shows the
 *   state and how long ("working 3m").
 * - The name is text, never markup, and carries `data-i18n-skip`; a
 *   double-click renames through the tab rename's own write queue.
 * - `⋯` is the tab rail's session menu; `×` removes the tile ONLY (the
 *   session keeps running), and neither button focuses a tile that is not
 *   focused (which would spend its idle alert).
 * - Every tab render refreshes the headers, so they follow session changes.
 * - Tabs of tiled sessions carry `.in-tiles`.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEl, FakeTile, makeGridApp, resetGridHarness, section, type GridApp } from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];

/** A grid on IDS with the shared classifier stand-ins mobile-overview.js would provide. */
function openGrid(): GridApp {
  const app = makeGridApp(IDS);
  app._mobileOverviewState = (session: { status?: string }, hooks?: Set<string>) =>
    hooks?.has('permission_prompt') ? 'needs' : session.status === 'busy' ? 'working' : 'idle';
  app._mobileOverviewSince = (_state: string, session: { lastActivityAt?: number }) => ({
    key: 'x',
    at: session.lastActivityAt || 0,
  });
  app._mobileOverviewExit = () => null;
  app._mobileOverviewStampText = (at: number) => (at ? '3m' : '');
  app.openTileGrid(IDS);
  app.markIdleAlertSeen.mockClear();
  return app;
}

const tileEl = (id: string) => section.children.find((el) => el.dataset.sessionId === id) as FakeEl;
const headerOf = (id: string) => tileEl(id).children[0];
const buttonOf = (id: string, cls: string) =>
  headerOf(id).children[2].children.find((b) => b.className.includes(cls)) as FakeEl;

beforeEach(() => {
  resetGridHarness();
});

describe('the header', () => {
  it('shows the session name as text, skipped by the translator', () => {
    const app = makeGridApp(IDS);
    app.sessions.get('s-b').name = '<b>Sessions</b>';
    app.openTileGrid(IDS);
    const name = headerOf('s-b').children[1];
    expect(name.textContent).toBe('<b>Sessions</b>');
    expect(name.getAttribute('data-i18n-skip')).toBe('');
    expect(name.children).toHaveLength(0);
  });

  it('header and body are siblings, the body holding the terminal', () => {
    openGrid();
    const el = tileEl('s-a');
    expect(el.children.map((c) => c.className)).toEqual(['tile-header', 'tile-body']);
    expect(FakeTile.all.find((t) => t.sessionId === 's-a')?.mountEl).toBe(el.children[1]);
  });

  it('the dot follows the session state, a permission prompt marks the whole tile', () => {
    const app = openGrid();
    app.sessions.get('s-b').status = 'busy';
    app.pendingHooks.set('s-c', new Set(['permission_prompt']));
    app._renderTileChrome();

    expect(headerOf('s-a').children[0].className).toContain('home-sessions-dot--idle');
    expect(headerOf('s-b').children[0].className).toContain('home-sessions-dot--working');
    expect(headerOf('s-c').children[0].className).toContain('home-sessions-dot--needs');
    expect(tileEl('s-c').classList.contains('tile--needs')).toBe(true);
    expect(tileEl('s-b').classList.contains('tile--needs')).toBe(false);
  });

  it('hovering says the state and for how long', () => {
    const app = openGrid();
    app.sessions.get('s-b').status = 'busy';
    app.sessions.get('s-b').lastActivityAt = Date.now() - 180_000;
    app._renderTileChrome();
    expect(headerOf('s-b').title).toBe('working 3m');
  });

  it('every tab render refreshes the headers', () => {
    const app = openGrid();
    app._renderTileChrome = vi.fn();
    // The original returns at once during an inline tab rename; the headers still refresh.
    app._inlineRenameActive = true;
    app._renderSessionTabsImmediate();
    expect(app._renderTileChrome).toHaveBeenCalledTimes(1);
  });
});

describe('header buttons', () => {
  it('× removes the tile only: the session keeps running, a neighbour takes focus unacknowledged', () => {
    const app = openGrid();
    app._apiDelete = vi.fn();
    buttonOf('s-a', 'tile-remove').dispatch('click', { stopPropagation: vi.fn() });

    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.sessions.has('s-a')).toBe(true);
    expect(app._apiDelete).not.toHaveBeenCalled();
    expect(app.activeSessionId).toBe('s-b');
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });

  it('× on the last tile shows that session in the single view', () => {
    const app = makeGridApp(['s-a']);
    app.openTileGrid(['s-a']);
    app.selectSession = vi.fn();
    buttonOf('s-a', 'tile-remove').dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(app.selectSession).toHaveBeenCalledWith('s-a', { forceReload: true, auto: true });
  });

  it('⋯ opens the tab rail session menu for that session', () => {
    const app = openGrid();
    app.openTabRailActionMenu = vi.fn();
    const ev = { stopPropagation: vi.fn() };
    buttonOf('s-c', 'tile-menu').dispatch('click', ev);
    expect(app.openTabRailActionMenu).toHaveBeenCalledWith(ev, 's-c');
  });

  it('pressing a header button never focuses the tile (no selection, no acknowledgement)', () => {
    const app = openGrid();
    app.selectSession = vi.fn();
    const stop = vi.fn();
    buttonOf('s-c', 'tile-remove').dispatch('pointerdown', { stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    // The tile's own pointerdown (a focus) only runs if the event reaches it.
    tileEl('s-c').dispatch('pointerdown', {});
    expect(app.selectSession).toHaveBeenCalledWith('s-c');
  });
});

describe('rename', () => {
  function startRename(app: GridApp, id: string) {
    headerOf(id).children[1].dispatch('dblclick', { stopPropagation: vi.fn() });
    return headerOf(id).children[1];
  }

  it('double-click puts an input in place of the name; Enter renames through the write queue', () => {
    const app = openGrid();
    // The real queue records the name in flight before its PUT lands.
    app._inlineRenamePending = new Map();
    app._queueInlineSessionName = vi.fn(async (id: string, name: string) => {
      app._inlineRenamePending.set(id, name);
      return { status: 'confirmed' };
    });
    const input = startRename(app, 's-b');
    expect(input.className).toBe('tile-rename-input');
    expect(input.value).toBe('s-b');

    input.value = 'renamed';
    input.dispatch('keydown', { key: 'Enter', preventDefault: vi.fn() });
    expect(app._queueInlineSessionName).toHaveBeenCalledWith('s-b', 'renamed');
    expect(headerOf('s-b').children[1].className).toBe('tile-name');
    expect(headerOf('s-b').children[1].textContent).toBe('renamed');
  });

  it('Escape cancels without a write', () => {
    const app = openGrid();
    app._queueInlineSessionName = vi.fn();
    const input = startRename(app, 's-b');
    input.value = 'nope';
    input.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() });
    expect(app._queueInlineSessionName).not.toHaveBeenCalled();
    expect(headerOf('s-b').children[1].textContent).toBe('s-b');
  });

  it('a header refresh while renaming leaves the input alone', () => {
    const app = openGrid();
    const input = startRename(app, 's-b');
    input.value = 'half-typed';
    app._renderTileChrome();
    expect(headerOf('s-b').children[1]).toBe(input);
    expect(input.value).toBe('half-typed');
  });

  it('an IME composition owns Enter', () => {
    const app = openGrid();
    app._queueInlineSessionName = vi.fn();
    const input = startRename(app, 's-b');
    input.value = 'x';
    input.dispatch('keydown', { key: 'Enter', isComposing: true, preventDefault: vi.fn() });
    expect(app._queueInlineSessionName).not.toHaveBeenCalled();
    expect(headerOf('s-b').children[1]).toBe(input);
  });
});

describe('the tab marker', () => {
  // Tab rendering needs the whole strip; the class is pinned at both render paths.
  const app = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

  it('the full render puts .in-tiles on a tiled session tab', () => {
    expect(app).toContain("${this._tileGrid?.has(id) ? ' in-tiles' : ''}");
  });

  it('the incremental render toggles it', () => {
    expect(app).toContain("tab.classList.toggle('in-tiles', !!this._tileGrid?.has(id));");
  });

  it('it has a style', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    expect(css).toMatch(/\.session-tab\.in-tiles/);
  });
});
