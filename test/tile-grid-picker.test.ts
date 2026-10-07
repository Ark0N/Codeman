/**
 * @fileoverview The header Tiles button and its picker.
 *
 * - The button is opt-in (`showTileGridButton`, hidden by its `--hidden` marker
 *   class) and hard-gated to desktop widths like Split: a JS width check plus a
 *   CSS `@media (max-width: 1179px)` backstop, and never in a solo window.
 *   With the grid open it closes it (`aria-pressed`).
 * - The picker has a checkbox per open session, in tab order, never a session
 *   popped out to its own window; names are text, never markup. It is
 *   preselected with the grid this tab last left, else the active session and
 *   an open split's two. Boxes past what the window can fit are disabled; Open
 *   opens the grid on the checked ones, focusing the active session if checked.
 * - Escape closes it, and its close method is idempotent (the global Escape
 *   handler calls every close method).
 * - A tile has no + (owner decision 9): tiles are added from this picker,
 *   Ctrl/Cmd+click, a dragged tab, a tab group or Run.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  body,
  bySelector,
  makeGridApp,
  resetGridHarness,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];
const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');

function makeButton() {
  const btn = new FakeEl();
  btn.className = 'btn-icon-header btn-tile-grid btn-tile-grid--hidden';
  bySelector.set('.btn-tile-grid', btn);
  return btn;
}

const picker = () => body.children.find((c) => c.id === 'tilePickerMenu') ?? null;
const rows = () => picker()!.children[0].children;
const boxOf = (id: string) => rows().find((r) => r.children[0].value === id)!.children[0];
const openButton = () => picker()!.children[1].children[1];
const check = (id: string, on = true) => {
  const box = boxOf(id);
  box.checked = on;
  box.dispatch('change');
};

let wrapRect = { width: 2400, height: 1200 };
beforeEach(() => {
  resetGridHarness();
  wrapRect = { width: 2400, height: 1200 };
  const wrap = new FakeEl();
  wrap.getBoundingClientRect = () => ({ ...wrapRect, top: 0, left: 0, right: wrapRect.width, bottom: wrapRect.height });
  bySelector.set('.terminal-wrap', wrap);
});
afterEach(() => {
  vi.useRealTimers();
});

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
    const app = makeGridApp(IDS);
    const btn = makeButton();
    app.selectSession = vi.fn();
    app.openTileGrid(IDS);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('tiles-open')).toBe(true);
    app.toggleTileGrid();
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(picker()).toBeNull();
  });
});

describe('the picker', () => {
  it('lists open sessions in tab order, never a detached one, names as text', () => {
    const app = makeGridApp(IDS);
    app.sessions.get('s-b').name = '<i>b</i>';
    app.detachedSessions.add('s-c');
    app.sessions.get('s-a').pid = null; // offered: its tile shows the Attach overlay
    app.openTilePicker({ stopPropagation: vi.fn() });
    const labels = rows().map((r) => r.children[1]);
    expect(rows().map((r) => r.children[0].value)).toEqual(['s-other', 's-a', 's-b']);
    expect(labels[2].textContent).toBe('<i>b</i>');
    expect(labels[2].children).toHaveLength(0);
    expect(labels[2].getAttribute('data-i18n-skip')).toBe('');
  });

  it('preselects the active session', () => {
    const app = makeGridApp(IDS);
    app.activeSessionId = 's-b';
    app.openTilePicker({ stopPropagation: vi.fn() });
    expect(
      rows()
        .filter((r) => r.children[0].checked)
        .map((r) => r.children[0].value)
    ).toEqual(['s-b']);
  });

  it('preselects the grid this tab last left', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.openTileGrid(['s-a', 's-c']);
    app.closeTileGrid({ reselect: false });
    app.openTilePicker({ stopPropagation: vi.fn() });
    expect(
      rows()
        .filter((r) => r.children[0].checked)
        .map((r) => r.children[0].value)
    ).toEqual(['s-a', 's-c']);
  });

  it('disables boxes past what the window fits, and says how many', () => {
    const app = makeGridApp(IDS);
    wrapRect = { width: 1000, height: 400 }; // fits 2 (2x1 of 500x400)
    app.openTilePicker({ stopPropagation: vi.fn() });
    expect(picker()!.children[1].children[0].textContent).toBe('This window fits 2 tiles');
    check('s-b');
    expect(boxOf('s-c').disabled).toBe(true);
    expect(boxOf('s-other').disabled).toBe(true);
    check('s-b', false);
    expect(boxOf('s-c').disabled).toBe(false);
  });

  it('Open opens the grid on the checked sessions, in tab order, focusing the active one', () => {
    const app = makeGridApp(IDS);
    app.activeSessionId = 's-b';
    app.openTilePicker({ stopPropagation: vi.fn() });
    check('s-a');
    check('s-c');
    openButton().dispatch('click');
    expect(app._tileGrid.ids).toEqual(['s-a', 's-b', 's-c']);
    expect(app.activeSessionId).toBe('s-b');
    expect(picker()).toBeNull();
  });

  it('Open is disabled with nothing checked', () => {
    const app = makeGridApp(IDS);
    app.openTilePicker({ stopPropagation: vi.fn() });
    check('s-a', false);
    expect(openButton().disabled).toBe(true);
  });

  it('Escape closes it, and closing twice is harmless (the global Escape calls every close method)', () => {
    const app = makeGridApp(IDS);
    app.openTilePicker({ stopPropagation: vi.fn() });
    const onKey = app._tilePicker.onKey;
    onKey({ key: 'Escape' });
    expect(picker()).toBeNull();
    expect(() => app.closeTilePicker()).not.toThrow();
  });

  it('the global Escape handler closes the picker', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const escape = src.slice(src.indexOf("if (e.key === 'Escape') {"), src.indexOf('Option/Alt session navigation'));
    expect(escape).toContain('this.closeTilePicker?.();');
  });

  it('refuses in a narrow window', () => {
    const app = makeGridApp(IDS);
    windowStub.innerWidth = 1100;
    app.openTilePicker({ stopPropagation: vi.fn() });
    expect(picker()).toBeNull();
  });
});
