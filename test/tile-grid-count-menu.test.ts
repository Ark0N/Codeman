/**
 * @fileoverview The header Tiles button and its right-click count menu (owner
 * decision 10, which replaced the session picker).
 *
 * - The button is opt-in (`showTileGridButton`, hidden by its `--hidden` marker
 *   class) and hard-gated to desktop widths like Split: a JS width check plus a
 *   CSS `@media (max-width: 1179px)` backstop, and never in a solo window.
 *   With the grid open it closes it (`aria-pressed`).
 * - Right-click (contextmenu, which Shift+F10 and the Menu key fire too) opens
 *   a menu of three counts, 2, 4 and 6, each with its shape, the remembered
 *   count checked (default 6). No session names in it, so no user text.
 * - A count the window cannot fit is greyed out with the reason, and the
 *   keyboard starts on the largest that fits.
 * - Arrows move over the counts that fit (wrapping), Home/End, Enter or Space
 *   picks, Escape closes and gives the keyboard back to the Tiles button (the
 *   menu owns its Escape in the global handler, like the tab-group menu), Tab
 *   and a click elsewhere close it.
 * - A pick is remembered per device (`codeman:tile-count`; `codeman:tile-grid`
 *   stays ids only) and opens that many tiles: the session to focus included,
 *   the rest from tab order. The click and Ctrl+Shift+G then open with it.
 * - With the grid open a pick re-forms it: a shape change under the cell
 *   model's rule, the focused tile always kept, tiles dropped from the end,
 *   new ones filling the empty cells first, all mounted and laid out before
 *   any connects. Fewer open sessions than the count give fewer tiles.
 * - The session picker is gone (no method, no CSS, no markup hook).
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  activeElement,
  body,
  bySelector,
  localStore,
  makeGridApp,
  resetGridHarness,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f', 's-g'];
const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const css = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');
const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const appSrc = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
const gridSrc = readFileSync(resolve(PUBLIC, 'tile-grid.js'), 'utf8');

function makeButton() {
  const btn = new FakeEl();
  btn.className = 'btn-icon-header btn-tile-grid btn-tile-grid--hidden';
  bySelector.set('.btn-tile-grid', btn);
  return btn;
}

const menu = () => body.children.find((c) => c.id === 'tileCountMenu') ?? null;
const items = () => menu()!.children.filter((c) => c.attrs.role === 'menuitemradio');
const item = (n: number) => items().find((i) => i.dataset.count === String(n))!;
const hint = () => menu()!.children.find((c) => c.className === 'tile-count-hint') ?? null;
const focused = () => (activeElement() as FakeEl | null)?.dataset?.count ?? null;
const key = (app: GridApp, k: string) => {
  const ev = { key: k, preventDefault: vi.fn() };
  app._tileCountMenu.onKey(ev);
  return ev;
};
const open = (app: GridApp) => app.openTileCountMenu({ preventDefault: vi.fn() });

let wrapRect = { width: 2400, height: 1200 };
beforeEach(() => {
  resetGridHarness();
  wrapRect = { width: 2400, height: 1200 };
  const wrap = new FakeEl();
  wrap.getBoundingClientRect = () => ({ ...wrapRect, top: 0, left: 0, right: wrapRect.width, bottom: wrapRect.height });
  bySelector.set('.terminal-wrap', wrap);
  makeButton();
});
afterEach(() => {
  vi.useRealTimers();
});

function gridApp(ids = IDS): GridApp {
  const app = makeGridApp(ids);
  app.selectSession = vi.fn((id: string) => app._selectTiledSession(id, {}));
  return app;
}

describe('the Tiles button', () => {
  it('shows only when its setting is on and the window is desktop-wide', () => {
    const app = makeGridApp(IDS);
    const btn = makeButton();
    app._applyTileGridButtonVisibility(false);
    expect(btn.classList.contains('btn-tile-grid--hidden')).toBe(true);
    app._applyTileGridButtonVisibility(true);
    expect(btn.classList.contains('btn-tile-grid--hidden')).toBe(false);
    windowStub.innerWidth = 1100;
    app._applyTileGridButtonVisibility(true);
    expect(btn.classList.contains('btn-tile-grid--hidden')).toBe(true);
  });

  it('never in a solo window', () => {
    const app = makeGridApp(IDS);
    app.isSoloWindow = true;
    const btn = makeButton();
    app._applyTileGridButtonVisibility(true);
    expect(btn.classList.contains('btn-tile-grid--hidden')).toBe(true);
  });

  it('has the CSS backstops: the hidden marker, the 1179px media query, solo mode', () => {
    expect(css).toMatch(/\.btn-tile-grid--hidden\s*\{\s*display: none !important;/);
    expect(css).toMatch(
      /@media \(max-width: 1179px\)\s*\{[^}]*\.btn-icon-header\.btn-tile-grid[^{]*\{\s*display: none !important;/
    );
    expect(css).toMatch(/body\.solo-mode \.btn-tile-grid,/);
  });

  it('with the grid open, a click closes it, and the button says so meanwhile', () => {
    const app = gridApp(IDS.slice(0, 3));
    const btn = bySelector.get('.btn-tile-grid')!;
    app.openTileGrid(IDS.slice(0, 3));
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('tiles-open')).toBe(true);
    expect(btn.title).toBe('Tiles: back to a single session (right-click for how many tiles)');
    app.toggleTileGrid();
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Tiles: show several sessions side by side (right-click for how many)');
    expect(menu()).toBeNull();
  });

  it('right-click opens the count menu, the click still toggles (one function with Ctrl+Shift+G)', () => {
    expect(html).toContain('onclick="app.toggleTileGrid()" oncontextmenu="app.openTileCountMenu(event)"');
    expect(html).toContain('title="Tiles: show several sessions side by side (right-click for how many)"');
  });
});

describe('the count menu', () => {
  it('offers 2, 4 and 6 with their shapes, the default 6 checked and focused; no user text', () => {
    const app = gridApp();
    const ev = { preventDefault: vi.fn() };
    app.openTileCountMenu(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(menu()!.attrs.role).toBe('menu');
    expect(menu()!.attrs['aria-label']).toBe('How many tiles');
    expect(items().map((i) => i.dataset.count)).toEqual(['2', '4', '6']);
    expect(items().map((i) => i.attrs['aria-checked'])).toEqual(['false', 'false', 'true']);
    expect(items().map((i) => i.children[1].textContent)).toEqual(['2 tiles', '4 tiles', '6 tiles']);
    // Each shape is the grid's own layout for that count: 2x1, 2x2, 3x2 cells.
    expect(items().map((i) => i.children[0].children.length)).toEqual([2, 4, 6]);
    expect(items().every((i) => !i.disabled)).toBe(true);
    expect(hint()).toBeNull();
    expect(focused()).toBe('6');
    expect(app._tilesOwnTerminal()).toBe(false);
    // No session name anywhere in it.
    expect(JSON.stringify(menu()!.children.map((c) => c.textContent))).not.toMatch(/s-[a-g]/);
  });

  it('checks the remembered count; a bad stored value reads as the default', () => {
    const app = gridApp();
    localStore.set('codeman:tile-count', '4');
    open(app);
    expect(items().map((i) => i.attrs['aria-checked'])).toEqual(['false', 'true', 'false']);
    expect(focused()).toBe('4');
    app.closeTileCountMenu();
    localStore.set('codeman:tile-count', '5');
    open(app);
    expect(item(6).attrs['aria-checked']).toBe('true');
  });

  it('greys out a count the window cannot fit, says why, and starts on the largest that fits', () => {
    const app = gridApp();
    wrapRect = { width: 1200, height: 900 }; // fits 4 (2x2 of 600x450), not 3x2
    open(app);
    expect(item(6).disabled).toBe(true);
    expect(item(6).attrs['aria-disabled']).toBe('true');
    expect(item(6).title).toBe('This window fits 4 tiles');
    expect(item(4).disabled).toBe(false);
    expect(hint()!.textContent).toBe('This window fits 4 tiles');
    // The remembered 6 stays checked (owner answer), the keyboard starts on 4.
    expect(item(6).attrs['aria-checked']).toBe('true');
    expect(focused()).toBe('4');
    app.closeTileCountMenu();
    wrapRect = { width: 1000, height: 400 }; // fits 2
    open(app);
    expect(items().map((i) => i.disabled)).toEqual([false, true, true]);
    expect(hint()!.textContent).toBe('This window fits 2 tiles');
  });

  it('a greyed count is never picked, by click or by Enter', () => {
    const app = gridApp();
    wrapRect = { width: 1200, height: 900 };
    open(app);
    item(6).dispatch('click', { stopPropagation: vi.fn() });
    expect(menu()).not.toBeNull();
    item(6).focus();
    key(app, 'Enter');
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(localStore.has('codeman:tile-count')).toBe(false);
  });

  it('arrows move over the counts that fit and wrap; Home and End', () => {
    const app = gridApp();
    open(app);
    expect(key(app, 'ArrowDown').preventDefault).toHaveBeenCalled();
    expect(focused()).toBe('2');
    key(app, 'ArrowRight');
    expect(focused()).toBe('4');
    key(app, 'ArrowUp');
    key(app, 'ArrowLeft');
    expect(focused()).toBe('6');
    key(app, 'Home');
    expect(focused()).toBe('2');
    key(app, 'End');
    expect(focused()).toBe('6');
    app.closeTileCountMenu();
    wrapRect = { width: 1200, height: 900 };
    open(app);
    key(app, 'ArrowDown');
    expect(focused()).toBe('2');
    key(app, 'ArrowUp');
    expect(focused()).toBe('4');
    // The greyed 6 is skipped both ways.
    key(app, 'ArrowDown');
    expect(focused()).toBe('2');
  });

  it('Escape closes it and gives the keyboard back to the Tiles button; closing twice is harmless', () => {
    const app = gridApp();
    open(app);
    const btn = bySelector.get('.btn-tile-grid')!;
    const ev = key(app, 'Escape');
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(menu()).toBeNull();
    expect(activeElement()).toBe(btn);
    expect(() => app.closeTileCountMenu()).not.toThrow();
  });

  it('the menu owns its Escape in the global handler: it closes alone, with the keyboard back on Tiles', () => {
    const escape = appSrc.slice(appSrc.indexOf("if (e.key === 'Escape') {"), appSrc.indexOf('this.closeAllPanels();'));
    expect(escape).toMatch(/if \(this\._tileCountMenu\) \{\s*this\.closeTileCountMenu\(\{ refocus: true \}\);\s*return;/);
    const app = gridApp();
    open(app);
    app.closeTileCountMenu({ refocus: true });
    expect(activeElement()).toBe(bySelector.get('.btn-tile-grid'));
  });

  it('Tab closes it; a click elsewhere closes it, a click inside does not', () => {
    const app = gridApp();
    open(app);
    key(app, 'Tab');
    expect(menu()).toBeNull();
    open(app);
    app._tileCountMenu.onOutside({ target: item(4) });
    expect(menu()).not.toBeNull();
    app._tileCountMenu.onOutside({ target: new FakeEl() });
    expect(menu()).toBeNull();
  });

  it('a second right-click closes it; a click on Tiles closes it and toggles', () => {
    const app = gridApp();
    open(app);
    open(app);
    expect(menu()).toBeNull();
    open(app);
    app.toggleTileGrid();
    expect(menu()).toBeNull();
    expect(app._tilesOwnTerminal()).toBe(true);
  });

  it('refuses in a narrow window', () => {
    const app = gridApp();
    windowStub.innerWidth = 1100;
    open(app);
    expect(menu()).toBeNull();
  });
});

describe('picking a count', () => {
  it('Enter on 2 opens two tiles, the active session included and focused, and remembers 2', () => {
    const app = gridApp();
    app.activeSessionId = 's-c';
    open(app);
    key(app, 'ArrowDown'); // 6 -> 2
    key(app, 'Enter');
    expect(menu()).toBeNull();
    expect(app._tileGrid.ids).toEqual(['s-other', 's-c']);
    expect(app._tileGrid.focusedId).toBe('s-c');
    expect(localStore.get('codeman:tile-count')).toBe('2');
    // The grid's own key stays ids only.
    const stored = JSON.parse(localStore.get('codeman:tile-grid')!);
    expect(Object.keys(stored).sort()).toEqual(['colFr', 'focused', 'ids', 'open', 'rowFr', 'v', 'zoomed']);
  });

  it('a click on 4 opens four, Space works too', () => {
    const app = gridApp();
    open(app);
    item(4).dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.ids).toHaveLength(4);
    app.closeTileGrid({ reselect: false });
    open(app);
    item(2).focus();
    key(app, ' ');
    expect(app._tileGrid.ids).toHaveLength(2);
  });

  it('then the click and Ctrl+Shift+G open with the remembered count', () => {
    const app = gridApp();
    localStore.set('codeman:tile-count', '4');
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-other', 's-a', 's-b', 's-c']);
    app.toggleTileGrid();
    localStore.delete('codeman:tile-grid');
    localStore.set('codeman:tile-count', '2');
    app.runTileShortcut('toggle-tile-grid');
    expect(app._tileGrid.ids).toHaveLength(2);
  });

  it('the default is 6, and the click never opens more than the window fits', () => {
    const app = gridApp();
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toHaveLength(6);
    app.closeTileGrid({ keepStored: false, reselect: false });
    wrapRect = { width: 1200, height: 900 };
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toHaveLength(4);
  });

  it('fewer open sessions than the count: fewer tiles', () => {
    const app = gridApp(['s-a', 's-b']);
    open(app);
    item(6).dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.ids).toEqual(['s-other', 's-a', 's-b']);
  });
});

describe('Ctrl/Cmd+click on a tab with the grid closed', () => {
  it('opens the remembered count in total, the clicked session among them and focused (owner answer 2)', () => {
    const app = gridApp();
    localStore.set('codeman:tile-count', '4');
    app.addSessionToTiles('s-f');
    expect(app._tileGrid.ids).toEqual(['s-other', 's-a', 's-b', 's-f']);
    expect(app._tileGrid.focusedId).toBe('s-f');
  });

  it('with the default 6, six in total, never seven', () => {
    const app = gridApp();
    app.addSessionToTiles('s-g');
    expect(app._tileGrid.ids).toHaveLength(6);
    expect(app._tileGrid.ids.at(-1)).toBe('s-g');
  });
});

describe('re-forming an open grid', () => {
  it('6 to 2 keeps the tiles it has first, drops from the end, never the focused one', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 6), { focusedId: 's-e' });
    open(app);
    item(2).dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.ids).toEqual(['s-a', 's-e']);
    expect(app._tileGrid.focusedId).toBe('s-e');
    expect(app.activeSessionId).toBe('s-e');
    // The dropped ones were destroyed, not reloaded or kept connected.
    const destroyed = FakeTile.all.filter((t) => t.destroy.mock.calls.length).map((t) => t.sessionId);
    expect(destroyed.sort()).toEqual(['s-b', 's-c', 's-d', 's-f']);
    expect(localStore.get('codeman:tile-count')).toBe('2');
  });

  it('2 to 6 keeps both in their cells and fills from tab order; nothing remounts', () => {
    const app = gridApp();
    app.openTileGrid(['s-c', 's-a']);
    const before = new Map(FakeTile.all.map((t) => [t.sessionId, t]));
    open(app);
    item(6).dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.cells).toEqual(['s-c', 's-a', 's-other', 's-b', 's-d', 's-e']);
    expect(app._tileFor('s-c')).toBe(before.get('s-c'));
    expect(app._tileFor('s-a')).toBe(before.get('s-a'));
    expect(before.get('s-c')!.connect).toHaveBeenCalledTimes(1);
  });

  it('every joining tile connects only once the grid has its final cells (one fit, one PTY resize)', () => {
    const app = gridApp();
    app.openTileGrid(['s-a', 's-b']);
    const seen: string[] = [];
    const realMount = app._mountTile.bind(app);
    app._mountTile = (id: string, opts?: unknown) => {
      const ok = realMount(id, opts);
      const tile = app._tileGrid.tiles.get(id)?.tile as FakeTile | undefined;
      tile?.connect.mockImplementation(async () => {
        seen.push(`${id}:${app._tileGrid.cells.length}:${app._tileGrid.cells.indexOf(id)}`);
      });
      return ok;
    };
    open(app);
    item(6).dispatch('click', { stopPropagation: vi.fn() });
    // Each one connected into the 3x2 grid, already in its final cell.
    expect(seen).toEqual(['s-other:6:2', 's-c:6:3', 's-d:6:4', 's-e:6:5']);
  });

  it('holes fill first: a 3x2 of five with an empty middle cell grows to six there', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 5));
    app._tileGrid.cells = ['s-a', null, 's-b', 's-c', 's-d', 's-e'];
    app._applyTileLayout();
    open(app);
    item(6).dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.cells).toEqual(['s-a', 's-other', 's-b', 's-c', 's-d', 's-e']);
  });

  it('6 to 4: the cell model rule (a tile left in the third column packs the rest)', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 6), { focusedId: 's-a' });
    open(app);
    item(4).dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.cols).toBe(2);
    expect(app._tileGrid.cells).toEqual(['s-a', 's-b', 's-c', 's-d']);
  });

  it('the same count changes nothing; a zoom the user chose ends with a re-form', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 4));
    const cells = app._tileGrid.cells.slice();
    open(app);
    item(4).dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.cells).toEqual(cells);
    app.zoomTile('s-b');
    open(app);
    item(2).dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tileGrid.zoomedId).toBeNull();
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b']);
  });
});

describe('the session picker is gone', () => {
  it('no picker method, element, style or markup hook is left', () => {
    const app = makeGridApp(IDS);
    expect(app.openTilePicker).toBeUndefined();
    expect(app.closeTilePicker).toBeUndefined();
    expect(gridSrc).not.toMatch(/tilePickerMenu|tile-picker|openTilePicker|closeTilePicker/);
    expect(css).not.toMatch(/tile-picker/);
    expect(html).not.toMatch(/openTilePicker/);
    expect(appSrc).not.toMatch(/closeTilePicker/);
  });

  it('a tile has no + (owner decision 9): tiles come from the Tiles button, its menu, Ctrl/Cmd+click, a tab, a group or Run', () => {
    const app = gridApp();
    app.openTileGrid(['s-a', 's-b']);
    const header = app._tileGrid.tiles.get('s-a').header as FakeEl;
    const actions = header.children.find((c) => c.className === 'tile-actions')!;
    expect(actions.children.map((b) => b.className)).toEqual(['tile-btn tile-menu', 'tile-btn tile-zoom', 'tile-btn tile-remove']);
  });
});
