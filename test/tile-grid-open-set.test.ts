/**
 * @fileoverview The Tiles button opens the grid at once (owner decision 8).
 *
 * - `tileGridOpenSet` (constants.js, pure): what opens, in order: (a) the grid
 *   this tab last had, if any of its sessions survive; (b) else an open
 *   split's two sessions; (c) else the open sessions in tab order up to the
 *   limit (never past the cap of 6), the active one always among them and
 *   focused. Detached sessions and ones that no longer exist are left out, as
 *   in the picker.
 * - The button's click and Ctrl+Shift+G are the same function
 *   (`toggleTileGrid`); right-click (contextmenu) opens the picker. With the
 *   grid open the picker shows the current tiles, and Open replaces them.
 *
 * Pure helper via `vm`, the app via the shared harness (test/mocks/tile-grid-vm.ts).
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  body,
  bySelector,
  documentAddEventListener,
  makeGridApp,
  resetGridHarness,
} from './mocks/tile-grid-vm.js';

type OpenSet = { source: string; ids: string[]; focusedId: string | null } | null;
type Helpers = { tileGridOpenSet(p: Record<string, unknown>): OpenSet; TILE_GRID_MAX: number };

function loadHelpers(): Helpers {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8'), context);
  return (context.window as { CodemanTileGrid: Helpers }).CodemanTileGrid;
}
const T = loadHelpers();
const INDEX_HTML = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

const order = Array.from({ length: 9 }, (_, i) => `t${i + 1}`);
const sessions = new Map(order.map((id) => [id, { id, name: id }]));
const base = { sessions, sessionOrder: order, limit: 6 };

describe('tileGridOpenSet (what the Tiles button opens)', () => {
  it('a: the grid this tab last had, its focus (or its zoom) included', () => {
    const stored = { ids: ['t4', 't2'], focused: 't2', zoomed: null };
    expect(T.tileGridOpenSet({ ...base, stored, split: ['t1', 't9'], activeId: 't1' })).toEqual({
      source: 'stored',
      ids: ['t4', 't2'],
      focusedId: 't2',
    });
    expect(T.tileGridOpenSet({ ...base, stored: { ids: ['t4', 't2'], focused: 't4', zoomed: 't2' } })?.focusedId).toBe(
      't2'
    );
  });

  it('b: else an open split, Pane A focused', () => {
    expect(T.tileGridOpenSet({ ...base, stored: { ids: [] }, split: ['t5', 't7'], activeId: 't5' })).toEqual({
      source: 'split',
      ids: ['t5', 't7'],
      focusedId: 't5',
    });
  });

  it('c: else the open sessions in tab order up to the limit, the active one focused', () => {
    expect(T.tileGridOpenSet({ ...base, activeId: 't3' })).toEqual({
      source: 'tabs',
      ids: order.slice(0, 6),
      focusedId: 't3',
    });
  });

  it('c: an active session past the limit still comes, with the first ones before it', () => {
    expect(T.tileGridOpenSet({ ...base, activeId: 't9' })).toEqual({
      source: 'tabs',
      ids: ['t1', 't2', 't3', 't4', 't5', 't9'],
      focusedId: 't9',
    });
  });

  it('c: a window that takes fewer gets fewer; nothing ever passes the cap', () => {
    expect(T.tileGridOpenSet({ ...base, limit: 4, activeId: 't1' })?.ids).toEqual(['t1', 't2', 't3', 't4']);
    expect(T.tileGridOpenSet({ ...base, limit: 99, activeId: 't1' })?.ids).toHaveLength(T.TILE_GRID_MAX);
  });

  it('leaves out detached sessions and ones that no longer exist, as the picker does', () => {
    const detachedIds = new Set(['t2']);
    const out = T.tileGridOpenSet({ ...base, sessionOrder: ['gone', ...order], detachedIds, activeId: 't1' });
    expect(out?.ids).toEqual(['t1', 't3', 't4', 't5', 't6', 't7']);
    // A split whose Pane B was popped out: Pane A alone.
    expect(T.tileGridOpenSet({ ...base, split: ['t1', 't2'], detachedIds, activeId: 't1' })?.ids).toEqual(['t1']);
  });

  it('is null when there is nothing to open', () => {
    expect(T.tileGridOpenSet({ sessions: new Map(), sessionOrder: [], limit: 6, activeId: null })).toBeNull();
  });
});

describe('the Tiles button and Ctrl+Shift+G', () => {
  const button = () => {
    const html = INDEX_HTML.match(/<button class="btn-icon-header btn-tile-grid[^>]*>/)?.[0] ?? '';
    return html;
  };

  it('a click opens the grid at once (the toggle), a right-click opens the picker', () => {
    expect(button()).toContain('onclick="app.toggleTileGrid()"');
    expect(button()).toContain('oncontextmenu="app.openTilePicker(event)"');
    expect(button()).toContain('right-click to choose which');
    expect(button()).not.toContain('onclick="app.openTilePicker');
  });

  it('Ctrl+Shift+G runs the same toggle', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/tile-grid.js'), 'utf8');
    expect(src).toContain("if (id === 'toggle-tile-grid') this.toggleTileGrid();");
  });
});

describe('opening at once, in the app', () => {
  const IDS = ['s-a', 's-b', 's-c'];
  const picker = () => body.children.find((c) => c.id === 'tilePickerMenu') ?? null;
  beforeEach(() => {
    resetGridHarness();
    const wrap = new FakeEl();
    bySelector.set('.terminal-wrap', wrap);
  });

  it('a click with the grid closed shows the tiles, no picker', () => {
    const app = makeGridApp(IDS);
    app.activeSessionId = 's-b';
    app.toggleTileGrid();
    expect(picker()).toBeNull();
    expect(app._tilesOwnTerminal()).toBe(true);
    expect(app._tileGrid.ids).toEqual(['s-other', ...IDS]);
    expect(app.activeSessionId).toBe('s-b');
  });

  it('a click closes a picker that a right-click left open', () => {
    const app = makeGridApp(IDS);
    app.openTilePicker({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(picker()).not.toBeNull();
    app.toggleTileGrid();
    expect(picker()).toBeNull();
    expect(app._tilesOwnTerminal()).toBe(true);
  });

  it('a click elsewhere closes the picker; a click inside it does not', () => {
    const app = makeGridApp(IDS);
    const before = documentAddEventListener.mock.calls.length;
    app.openTilePicker({ preventDefault: vi.fn() });
    const calls = documentAddEventListener.mock.calls.slice(before) as Array<[string, (e: unknown) => void]>;
    const onClick = calls.find(([type]) => type === 'click')![1];
    onClick({ target: picker()!.children[0] });
    expect(picker()).not.toBeNull();
    onClick({ target: new FakeEl() });
    expect(picker()).toBeNull();
  });

  it('a right-click opens the picker and keeps the browser menu away', () => {
    const app = makeGridApp(IDS);
    const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    app.openTilePicker(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(picker()).not.toBeNull();
    expect(app._tilesOwnTerminal()).toBe(false);
  });

  it('a right-click with the grid open shows its tiles; Open replaces them', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(['s-a', 's-b'], { focusedId: 's-b' });
    app.openTilePicker({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(app._tilesOwnTerminal()).toBe(true);
    const menu = picker()!;
    const boxes = menu.children[0].children.map((row) => row.children[0]);
    expect(boxes.filter((b) => b.checked).map((b) => b.value)).toEqual(['s-a', 's-b']);
    const boxA = boxes.find((b) => b.value === 's-a')!;
    boxA.checked = false;
    boxA.dispatch('change');
    const boxC = boxes.find((b) => b.value === 's-c')!;
    boxC.checked = true;
    boxC.dispatch('change');
    menu.children[1].children[1].dispatch('click');
    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.activeSessionId).toBe('s-b');
  });
});
