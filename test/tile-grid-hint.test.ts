/**
 * @fileoverview The Tiles button's hover card (owner feedback 1: "give me the
 * hover info to right click over the tile button to adjust it").
 *
 * - Installed once with the button's visibility, never in a solo window: a
 *   hidden `role=tooltip` card in body, the button's `aria-describedby`, and
 *   the button's native title removed (two tooltips never stack); the
 *   aria-label stays.
 * - Shows 300 ms after a pointer that hovers rests on the button, or after a
 *   keyboard focus (`:focus-visible`), under the button. Never for a touch
 *   pointer, a device that cannot hover, a hidden button, or while the count
 *   menu is open.
 * - Content: "Tiles · N" (the remembered count, live), what a click does
 *   (open or close the grid), "Right-click: choose 2, 4 or 6 tiles", what
 *   opens when the count does not fit the window, and Shift+F10 when shown
 *   from the keyboard; hidden, it holds all of it (the button's description).
 * - Hides on pointer leave, blur, a click, a right-click or a press on the
 *   button (and stays hidden while the pointer rests there), Escape, a scroll
 *   and a resize; the count menu never opens beside it, and the Escape out of
 *   the menu brings no card back.
 * - Only `.tile-hint` styles: the panel of the count menu, a fade on opacity
 *   and transform only, nothing under reduced motion or without hover.
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
  localStore,
  makeGridApp,
  resetGridHarness,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'];
const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const css = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');
const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');

let btn: FakeEl;
let wrapRect = { width: 2400, height: 1200 };
const card = () => body.children.find((c) => c.id === 'tileGridHint') ?? null;
const lines = () => card()!.children.filter((c) => c.className.includes('tile-hint-line'));
const textOf = (row: FakeEl) => row.children.at(-1)!.textContent;
const visibleText = () => [
  card()!.children[0].textContent,
  ...lines()
    .filter((l) => !l.hidden)
    .map(textOf),
];
const pointer = (type: string, pointerType = 'mouse') => btn.dispatch(type, { pointerType });

beforeEach(() => {
  resetGridHarness();
  vi.useFakeTimers();
  wrapRect = { width: 2400, height: 1200 };
  const wrap = new FakeEl();
  wrap.getBoundingClientRect = () => ({ ...wrapRect, top: 0, left: 0, right: wrapRect.width, bottom: wrapRect.height });
  bySelector.set('.terminal-wrap', wrap);
  btn = new FakeEl();
  btn.className = 'btn-icon-header btn-tile-grid btn-tile-grid--hidden';
  btn.title = 'Tiles: show several sessions side by side (right-click for how many)';
  btn.getBoundingClientRect = () => ({ width: 26, height: 26, top: 8, left: 2000, right: 2026, bottom: 34 });
  bySelector.set('.btn-tile-grid', btn);
});
afterEach(() => {
  vi.useRealTimers();
});

function hintApp(): GridApp {
  const app = makeGridApp(IDS);
  app.selectSession = vi.fn((id: string) => app._selectTiledSession(id, {}));
  app._applyTileGridButtonVisibility(true);
  return app;
}

describe('installed with the button', () => {
  it('a hidden tooltip card in body, the button described by it, its native title gone, its label kept', () => {
    const app = hintApp();
    expect(card()).not.toBeNull();
    expect(card()!.attrs.role).toBe('tooltip');
    expect(card()!.hidden).toBe(true);
    expect(btn.getAttribute('aria-describedby')).toBe('tileGridHint');
    expect(btn.title).toBe('');
    expect(btn.getAttribute('title')).toBeNull();
    app._updateTileGridButtonState();
    expect(btn.getAttribute('aria-label')).toBe('Tiles: show several sessions side by side (right-click for how many)');
    expect(btn.title).toBe('');
    // Once: a second call adds no second card.
    app._applyTileGridButtonVisibility(true);
    expect(body.children.filter((c) => c.id === 'tileGridHint')).toHaveLength(1);
    // The markup: no title on the button, described by the card.
    const tag = html.match(/<button class="btn-icon-header btn-tile-grid[^>]*>/)![0];
    expect(tag).not.toMatch(/\stitle=/);
    expect(tag).toContain('aria-describedby="tileGridHint"');
  });

  it('never in a solo window', () => {
    const app = makeGridApp(IDS);
    app.isSoloWindow = true;
    app._applyTileGridButtonVisibility(true);
    expect(card()).toBeNull();
  });

  it('hidden, it holds everything a screen reader should hear, the keyboard line included', () => {
    hintApp();
    expect(lines().map((l) => l.hidden)).toEqual([false, false, true, false]);
    expect(card()!.children[0].textContent).toBe('Tiles · 6');
    expect(textOf(lines()[3])).toBe('Shift+F10: the same menu from the keyboard');
  });
});

describe('showing', () => {
  it('300 ms after a mouse rests on the button, under it and right-aligned', () => {
    hintApp();
    btn.classList.remove('btn-tile-grid--hidden');
    pointer('pointerenter');
    vi.advanceTimersByTime(299);
    expect(card()!.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(card()!.hidden).toBe(false);
    expect(card()!.style.top).toBe('40px');
    expect(card()!.style.right).toBe(`${2400 - 2026}px`);
  });

  it('from a pointer: no keyboard line; from a keyboard focus: with it', () => {
    hintApp();
    btn.classList.remove('btn-tile-grid--hidden');
    pointer('pointerenter');
    vi.advanceTimersByTime(300);
    expect(visibleText()).toEqual(['Tiles · 6', 'Click: open the grid', 'Right-click: choose 2, 4 or 6 tiles']);
    pointer('pointerleave');
    (btn as unknown as { matches: (s: string) => boolean }).matches = (s) => s === ':focus-visible';
    btn.dispatch('focus', {});
    vi.advanceTimersByTime(300);
    expect(visibleText()).toContain('Shift+F10: the same menu from the keyboard');
  });

  it('a mouse focus (not :focus-visible) shows nothing', () => {
    hintApp();
    btn.classList.remove('btn-tile-grid--hidden');
    (btn as unknown as { matches: (s: string) => boolean }).matches = () => false;
    btn.dispatch('focus', {});
    vi.advanceTimersByTime(1000);
    expect(card()!.hidden).toBe(true);
  });

  it('never for a touch pointer, a device that cannot hover, or a hidden button', () => {
    hintApp();
    // The setting off, or a narrow window: the button carries its hidden marker.
    btn.classList.add('btn-tile-grid--hidden');
    pointer('pointerenter');
    vi.advanceTimersByTime(1000);
    expect(card()!.hidden).toBe(true); // still --hidden
    btn.classList.remove('btn-tile-grid--hidden');
    pointer('pointerenter', 'touch');
    vi.advanceTimersByTime(1000);
    expect(card()!.hidden).toBe(true);
    windowStub.matchMedia = (q: string) => ({ matches: !q.includes('hover'), addEventListener: vi.fn() });
    pointer('pointerenter');
    vi.advanceTimersByTime(1000);
    expect(card()!.hidden).toBe(true);
  });

  it('never while the count menu is open', () => {
    const app = hintApp();
    btn.classList.remove('btn-tile-grid--hidden');
    app.openTileCountMenu({ preventDefault: vi.fn() });
    pointer('pointerenter');
    vi.advanceTimersByTime(1000);
    expect(card()!.hidden).toBe(true);
  });
});

describe('what it says', () => {
  const show = () => {
    pointer('pointerenter');
    vi.advanceTimersByTime(300);
  };

  it('the remembered count, live, and open or close by the grid', () => {
    const app = hintApp();
    btn.classList.remove('btn-tile-grid--hidden');
    localStore.set('codeman:tile-count', '2');
    app._renderTileHint();
    show();
    expect(visibleText()[0]).toBe('Tiles · 2');
    // A pick in the menu changes it at once, the card still up.
    app._rememberTileGridCount(4);
    expect(visibleText()[0]).toBe('Tiles · 4');
    app.openTileGrid(IDS.slice(0, 4));
    expect(visibleText()).toContain('Click: close the grid');
    app.closeTileGrid({ reselect: false });
    expect(visibleText()).toContain('Click: open the grid');
  });

  it('a refresh with nothing changed leaves the translated text alone (it compares with the last English)', () => {
    const app = hintApp();
    // What the zh-CN translator leaves in the DOM.
    card()!.children[0].textContent = '平铺 · 6';
    expect(textOf(lines()[0])).toBe('Click: open the grid');
    lines()[0].children.at(-1)!.textContent = '单击：打开平铺网格';
    app._renderTileHint();
    app._updateTileGridButtonState();
    expect(card()!.children[0].textContent).toBe('平铺 · 6');
    expect(textOf(lines()[0])).toBe('单击：打开平铺网格');
    // A real change writes the new English for the translator.
    app._rememberTileGridCount(2);
    expect(card()!.children[0].textContent).toBe('Tiles \u00B7 2');
  });

  it('a count the window cannot fit says what opens instead (closed) and what fits (open)', () => {
    const app = hintApp();
    btn.classList.remove('btn-tile-grid--hidden');
    wrapRect = { width: 1200, height: 900 }; // fits 4
    app._renderTileHint();
    show();
    expect(visibleText()).toEqual([
      'Tiles · 6',
      'Click: open the grid',
      'Right-click: choose 2, 4 or 6 tiles',
      'This window fits 4 tiles: a click opens 4',
    ]);
    localStore.set('codeman:tile-count', '4');
    app._renderTileHint();
    expect(visibleText()).toHaveLength(3);
  });
});

describe('hiding', () => {
  const shown = () => {
    const app = hintApp();
    btn.classList.remove('btn-tile-grid--hidden');
    pointer('pointerenter');
    vi.advanceTimersByTime(300);
    expect(card()!.hidden).toBe(false);
    return app;
  };

  it('on pointer leave, and a pending show is cancelled', () => {
    shown();
    pointer('pointerleave');
    expect(card()!.hidden).toBe(true);
    pointer('pointerenter');
    vi.advanceTimersByTime(200);
    pointer('pointerleave');
    vi.advanceTimersByTime(500);
    expect(card()!.hidden).toBe(true);
  });

  it('on blur', () => {
    shown();
    btn.dispatch('blur', {});
    expect(card()!.hidden).toBe(true);
  });

  it('on a press, a click or a right-click on the button, in the capture phase, and stays hidden there', () => {
    for (const type of ['pointerdown', 'click', 'contextmenu']) {
      resetGridHarness();
      bySelector.set('.btn-tile-grid', btn);
      btn.listeners = {};
      btn.captureFlags = {};
      shown();
      btn.dispatch(type, {});
      expect(card()!.hidden, type).toBe(true);
      expect(btn.captureFlags[type].some(Boolean), type).toBe(true);
      // Still resting on it: no card back.
      pointer('pointerenter');
      vi.advanceTimersByTime(1000);
      expect(card()!.hidden, type).toBe(true);
      // Once the pointer has left, a new rest shows it again.
      pointer('pointerleave');
      pointer('pointerenter');
      vi.advanceTimersByTime(300);
      expect(card()!.hidden, type).toBe(false);
    }
  });

  it('a keyboard focus coming back after a click shows it, the pointer still resting there', () => {
    shown();
    btn.dispatch('click', {});
    expect(card()!.hidden).toBe(true);
    // Tab away and back, the mouse never moved.
    btn.dispatch('blur', {});
    (btn as unknown as { matches: (s: string) => boolean }).matches = (s) => s === ':focus-visible';
    btn.dispatch('focus', {});
    vi.advanceTimersByTime(300);
    expect(card()!.hidden).toBe(false);
  });

  it('the count menu never opens beside it: openTileCountMenu hides it first', () => {
    const app = shown();
    app.openTileCountMenu({ preventDefault: vi.fn() });
    expect(body.children.some((c) => c.id === 'tileCountMenu')).toBe(true);
    expect(card()!.hidden).toBe(true);
  });

  it('the Escape out of the menu brings no card back with the keyboard focus', () => {
    const app = hintApp();
    btn.classList.remove('btn-tile-grid--hidden');
    (btn as unknown as { matches: (s: string) => boolean }).matches = (s) => s === ':focus-visible';
    btn.focus = vi.fn(() => btn.dispatch('focus', {}));
    app.openTileCountMenu({ preventDefault: vi.fn() });
    app.closeTileCountMenu({ refocus: true });
    expect(btn.focus).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(card()!.hidden).toBe(true);
  });

  it('on Escape, a scroll and a resize, listened to only while shown', () => {
    const docAdd = (windowStub.addEventListener as ReturnType<typeof vi.fn>).mock;
    const before = docAdd.calls.length;
    const app = shown();
    const added = docAdd.calls.slice(before) as Array<[string, () => void, unknown]>;
    const scroll = added.find(([t]) => t === 'scroll')!;
    const resize = added.find(([t]) => t === 'resize')!;
    expect(scroll[2]).toBe(true);
    scroll[1]();
    expect(card()!.hidden).toBe(true);
    expect((windowStub.removeEventListener as ReturnType<typeof vi.fn>).mock.calls.some(([t]) => t === 'scroll')).toBe(true);
    pointer('pointerleave');
    pointer('pointerenter');
    vi.advanceTimersByTime(300);
    resize[1]();
    expect(card()!.hidden).toBe(true);
    pointer('pointerleave');
    pointer('pointerenter');
    vi.advanceTimersByTime(300);
    app._tileHint.onKey({ key: 'Enter' });
    expect(card()!.hidden).toBe(false);
    app._tileHint.onKey({ key: 'Escape' });
    expect(card()!.hidden).toBe(true);
  });

  it('hidden after a keyboard show, the keyboard line is back in the description', () => {
    shown(); // a pointer show: the keyboard line hidden
    expect(lines()[3].hidden).toBe(true);
    pointer('pointerleave');
    expect(lines()[3].hidden).toBe(false);
  });
});

describe('the CSS', () => {
  it('the count menu panel, no pointer, a fade on opacity and transform only, none without hover or with reduced motion', () => {
    const block = css.slice(css.indexOf('.tile-hint {'), css.indexOf('.tile-hint {') + 900);
    expect(block).toContain('background: var(--floating-bg');
    expect(block).toContain('border: 1px solid var(--control-border');
    expect(block).toContain('pointer-events: none;');
    const keyframes = css.match(/@keyframes tile-hint-in \{([\s\S]*?)\n\}/)![1];
    expect([...keyframes.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]).sort()).toEqual(['opacity', 'transform']);
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.tile-hint \{\s*display: none !important;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.tile-hint \{\s*animation: none;/);
    expect(css).toMatch(/\.tile-hint\[hidden\],\s*\.tile-hint \[hidden\] \{\s*display: none;/);
  });

  it('no other header button changes: its rules are .tile-hint only', () => {
    const start = css.indexOf('*/', css.indexOf("/* The Tiles button's hover card")) + 2;
    const end = css.indexOf('/* ── Tile grid motion');
    const rules = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...rules.matchAll(/^([^\s@}][^{]*)\{/gm)].map((m) => m[1].trim());
    expect(selectors.length).toBeGreaterThan(5);
    for (const sel of selectors) expect(sel, sel).toMatch(/^(\.tile-hint|from|to)/);
  });
});
