/**
 * @fileoverview The grid's open and close animation (owner request: "when
 * clicking on the tile button first make this animation nicer").
 *
 * - Opening: every tile mounts with `.tile--entering` and its place in reading
 *   order (`--tile-enter-index`, the CSS stagger), cleared by its own
 *   `tile-enter` animationend only. Its terminal stays transparent
 *   (`.tile--revealing`) until the load queue reports its first capture done,
 *   with a backstop timer.
 * - The animation adds no fit and no PTY resize: a grid opened with motion
 *   fits and connects its tiles exactly as one opened under reduced motion.
 * - Closing with the Tiles toggle (button, Ctrl+Shift+G; owner answer 4): a
 *   still copy of the tiles (clones, no TerminalTile) dims over the stage and
 *   waits until the single view's selection has settled, at most 700 ms, then
 *   fades and removes itself (animationend, or a fallback timer). Every other
 *   close cuts as before. A reopen drops a copy still showing.
 * - Re-forming to another count: the old grid's copy fades at once, the new
 *   tiles enter staggered, the tiles that stay do not.
 * - Reduced motion: no entrance, no copy, no stagger property.
 * - The CSS: every new keyframe animates opacity and transform only, all of
 *   it stops under prefers-reduced-motion, and a web tab hides the copy.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  body,
  bySelector,
  flushFrames,
  main,
  makeGridApp,
  resetGridHarness,
  section,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'];
const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');

const tiles = () => section.children.filter((c) => c.classList.contains('tile'));
const ghosts = () => main.children.filter((c) => c.classList.contains('tile-grid-ghosts'));
const end = (el: FakeEl, animationName: string, target: FakeEl = el) => el.dispatch('animationend', { target, animationName });
function reducedMotion(on: boolean) {
  windowStub.matchMedia = (q: string) => ({ matches: on && q.includes('reduce'), addEventListener: vi.fn() });
}

beforeEach(() => {
  resetGridHarness();
  const btn = new FakeEl();
  btn.className = 'btn-icon-header btn-tile-grid';
  bySelector.set('.btn-tile-grid', btn);
});
afterEach(() => {
  vi.useRealTimers();
});

function gridApp(ids = IDS): GridApp {
  const app = makeGridApp(ids);
  app.selectSession = vi.fn((id: string) => app._selectTiledSession(id, {}));
  return app;
}

describe('opening', () => {
  it('each tile enters, staggered in reading order', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 4), { focusedId: 's-c' });
    expect(tiles().map((t) => t.classList.contains('tile--entering'))).toEqual([true, true, true, true]);
    expect(tiles().map((t) => t.style['--tile-enter-index'])).toEqual(['0', '1', '2', '3']);
  });

  it('a tile stops entering on its own tile-enter animationend, not on a child or another animation', () => {
    const app = gridApp();
    app.openTileGrid(['s-a', 's-b']);
    const el = tiles()[0];
    end(el, 'tile-needs-pulse');
    end(el, 'tile-enter', new FakeEl());
    expect(el.classList.contains('tile--entering')).toBe(true);
    end(el, 'tile-enter');
    expect(el.classList.contains('tile--entering')).toBe(false);
    expect(tiles()[1].classList.contains('tile--entering')).toBe(true);
  });

  it('a terminal stays transparent until the load queue reports its first capture done', () => {
    // A queue that hands the grid's own state callback to the test.
    const Queue = windowStub.TileLoadQueue;
    let report: (tile: unknown, state: string) => void = () => {};
    windowStub.TileLoadQueue = class {
      constructor(opts: { onChange: (tile: unknown, state: string) => void }) {
        report = opts.onChange;
      }
      schedule(_t: unknown, _k: string, run: () => Promise<void>) {
        return run();
      }
      drop() {}
    };
    try {
      const app = gridApp();
      app.openTileGrid(['s-a', 's-b']);
      app._tileLoadQueue();
      expect(tiles().every((t) => t.classList.contains('tile--revealing'))).toBe(true);
      const tileA = app._tileFor('s-a');
      report(tileA, 'queued');
      report(tileA, 'running');
      expect(tiles()[0].classList.contains('tile--revealing')).toBe(true);
      report(tileA, 'idle');
      expect(tiles()[0].classList.contains('tile--revealing')).toBe(false);
      expect(tiles()[1].classList.contains('tile--revealing')).toBe(true);
      // A later load (a reconnect refresh) never hides it again.
      report(tileA, 'running');
      expect(tiles()[0].classList.contains('tile--revealing')).toBe(false);
    } finally {
      windowStub.TileLoadQueue = Queue;
    }
  });

  it('a backstop timer shows a terminal whose load never reports back', () => {
    vi.useFakeTimers();
    const app = gridApp();
    app.openTileGrid(['s-a']);
    vi.advanceTimersByTime(14_999);
    expect(tiles()[0].classList.contains('tile--revealing')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tiles()[0].classList.contains('tile--revealing')).toBe(false);
  });

  it('adds no fit and no PTY resize: tiles fit and connect exactly as under reduced motion', () => {
    vi.useFakeTimers();
    const counts = (motion: boolean) => {
      resetGridHarness();
      reducedMotion(!motion);
      const app = gridApp();
      app.openTileGrid(IDS);
      flushFrames();
      vi.advanceTimersByTime(1000);
      return FakeTile.all.map((t) => [t.connect.mock.calls.length, t.fit.mock.calls.length, t.localFit.mock.calls.length]);
    };
    const withMotion = counts(true);
    const without = counts(false);
    expect(withMotion).toEqual(without);
    // One connect per tile (its one resize goes out when its socket opens).
    expect(withMotion.every(([connects]) => connects === 1)).toBe(true);
  });

  it('a tile added later enters too; one dropped on a tile enters in its place', () => {
    const app = gridApp();
    app.openTileGrid(['s-a', 's-b']);
    for (const t of tiles()) end(t, 'tile-enter');
    app.addTile('s-c');
    const added = tiles().find((t) => t.dataset.sessionId === 's-c')!;
    expect(added.classList.contains('tile--entering')).toBe(true);
    expect(tiles().filter((t) => t.classList.contains('tile--entering'))).toHaveLength(1);
  });
});

describe('closing with the Tiles toggle', () => {
  it('leaves a still copy of the tiles over the stage: clones, inert, no terminals', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 3));
    const before = FakeTile.all.length;
    app.toggleTileGrid();
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(ghosts()).toHaveLength(1);
    const layer = ghosts()[0];
    expect(layer.inert).toBe(true);
    expect(layer.attrs['aria-hidden']).toBe('true');
    expect(layer.children.map((g) => g.dataset.sessionId)).toEqual(['s-a', 's-b', 's-c']);
    expect(layer.children.every((g) => g.classList.contains('tile--leaving'))).toBe(true);
    expect(layer.children.some((g) => g.classList.contains('tile--entering'))).toBe(false);
    // Copies only: no TerminalTile was made for them, the real ones are gone.
    expect(FakeTile.all).toHaveLength(before);
    expect(FakeTile.all.every((t) => t._destroyed)).toBe(true);
    expect(tiles()).toHaveLength(0);
  });

  it('holds until the single view has its content, then fades and goes', async () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 2));
    let settle: () => void = () => {};
    app.selectSession = vi.fn(() => new Promise<void>((r) => (settle = r)));
    app.toggleTileGrid();
    const layer = ghosts()[0];
    expect(layer.classList.contains('tile-grid-ghosts--release')).toBe(false);
    settle();
    // The selection's promise comes from another realm (the test's), so its
    // settling reaches the grid after a few microtasks: a macrotask covers them.
    await new Promise((r) => setTimeout(r, 0));
    expect(layer.classList.contains('tile-grid-ghosts--release')).toBe(true);
    end(layer, 'tile-leave', layer.children[0]);
    expect(ghosts()).toHaveLength(1);
    end(layer, 'tile-leave', layer.lastElementChild!);
    expect(ghosts()).toHaveLength(0);
  });

  it('a single view that never settles still gets it gone: 700 ms, then the fade fallback', () => {
    vi.useFakeTimers();
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 2));
    app.selectSession = vi.fn(() => new Promise<void>(() => {}));
    app.toggleTileGrid();
    const layer = ghosts()[0];
    vi.advanceTimersByTime(699);
    expect(layer.classList.contains('tile-grid-ghosts--release')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(layer.classList.contains('tile-grid-ghosts--release')).toBe(true);
    vi.advanceTimersByTime(450);
    expect(ghosts()).toHaveLength(0);
  });

  it('a zoomed grid leaves a copy of the zoomed tile only', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 3));
    app.zoomTile('s-b');
    app.toggleTileGrid();
    expect(ghosts()[0].children.map((g) => g.dataset.sessionId)).toEqual(['s-b']);
  });

  it('every other close cuts as before: no copy', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 2));
    app.closeTileGrid({ reselect: false });
    expect(ghosts()).toHaveLength(0);
    app.openTileGrid(IDS.slice(0, 2));
    // A user pick of a tab that is not tiled leaves the grid (decision 1).
    app.closeTileGrid({ keepStored: true });
    expect(ghosts()).toHaveLength(0);
  });

  it('reopening drops a copy still showing', () => {
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 2));
    app.selectSession = vi.fn(() => new Promise<void>(() => {}));
    app.toggleTileGrid();
    expect(ghosts()).toHaveLength(1);
    app.selectSession = vi.fn((id: string) => app._selectTiledSession(id, {}));
    app.toggleTileGrid();
    expect(ghosts()).toHaveLength(0);
    expect(app._tilesOwnTerminal()).toBe(true);
  });
});

describe('re-forming to another count', () => {
  it('the old grid fades at once, the new tiles enter staggered, the ones that stay do not', () => {
    const app = gridApp();
    app.openTileGrid(['s-a', 's-b']);
    for (const t of tiles()) end(t, 'tile-enter');
    app.openTileCountMenu({ preventDefault: vi.fn() });
    const menu = body.children.find((c) => c.id === 'tileCountMenu')!;
    menu.children.find((c) => c.dataset.count === '6')!.dispatch('click', { stopPropagation: vi.fn() });
    const layer = ghosts()[0];
    expect(layer.classList.contains('tile-grid-ghosts--now')).toBe(true);
    expect(layer.classList.contains('tile-grid-ghosts--release')).toBe(true);
    const entering = tiles().filter((t) => t.classList.contains('tile--entering'));
    expect(entering.map((t) => t.style['--tile-enter-index'])).toEqual(['0', '1', '2', '3']);
    expect(entering.map((t) => t.dataset.sessionId)).not.toContain('s-a');
  });
});

describe('reduced motion', () => {
  it('no entrance, no stagger property, no copy on close', () => {
    reducedMotion(true);
    const app = gridApp();
    app.openTileGrid(IDS.slice(0, 3));
    expect(tiles().some((t) => t.classList.contains('tile--entering'))).toBe(false);
    expect(tiles().some((t) => '--tile-enter-index' in t.style)).toBe(false);
    app.toggleTileGrid();
    expect(ghosts()).toHaveLength(0);
  });
});

describe('the CSS', () => {
  const keyframes = (name: string) => {
    const m = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`));
    return m ? m[1] : '';
  };

  it('every new keyframe animates opacity and transform only', () => {
    for (const name of [
      'tile-enter',
      'tile-ghost-dim',
      'tile-leave',
      'tile-leave-now',
      'tile-loading-breathe',
      'tile-count-menu-in',
      'tile-needs-pulse',
    ]) {
      const body = keyframes(name);
      expect(body, name).not.toBe('');
      const props = [...body.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]);
      expect(props.length, name).toBeGreaterThan(0);
      expect(props.filter((p) => p !== 'opacity' && p !== 'transform'), name).toEqual([]);
    }
  });

  it('the terminal reveal is an opacity transition only', () => {
    expect(css).toMatch(/\.tile-body \.xterm \{\s*transition: opacity 160ms ease-out;\s*\}/);
    expect(css).toMatch(/\.tile\.tile--revealing \.tile-body \.xterm \{\s*opacity: 0;\s*\}/);
  });

  it('stays within about 150 to 300 ms: 180 ms per tile, 24 ms apart, the last of six done at 300', () => {
    expect(css).toMatch(/\.tile\.tile--entering \{\s*animation: tile-enter 180ms [^;]+;\s*animation-delay: calc\(var\(--tile-enter-index, 0\) \* 24ms\);/);
  });

  it('nothing moves under prefers-reduced-motion, and a web tab hides the copy', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .tile-count-menu,'));
    const reduced = block.slice(0, block.indexOf('\n}\n'));
    for (const sel of [
      '.tile-count-menu',
      '.tile.tile--entering',
      '.tile.tile--needs::after',
      '.tile.tile--loading .tile-body::after',
      '.tile-grid-ghosts .tile.tile--leaving',
    ]) {
      expect(reduced).toContain(sel);
    }
    expect(reduced).toMatch(/animation: none;/);
    expect(reduced).toMatch(/\.tile-body \.xterm \{\s*transition: none;/);
    expect(css).toMatch(/\.main\.webview-active \.tile-grid-ghosts \{\s*display: none;/);
  });

  it('the needs-you pulse fades a static glow overlay in and out, never repainting the tile itself', () => {
    // A needs tile pulses for as long as its prompt waits, hours at a time. A
    // box-shadow animated on the tile repainted the whole tile (its DOM-rendered
    // terminal rows with it, the whole stage when zoomed) every frame.
    const rules: Array<{ selector: string; media: string; decls: Record<string, string> }> = [];
    postcss.parse(css).walkRules((rule: Rule) => {
      if (!rule.selector.includes('tile--needs')) return;
      const decls: Record<string, string> = {};
      rule.walkDecls((d) => {
        decls[d.prop] = d.value;
      });
      const media = rule.parent?.type === 'atrule' ? (rule.parent as AtRule).params : '';
      for (const selector of rule.selectors) rules.push({ selector, media, decls });
    });
    const find = (selector: string, media = '') => rules.filter((r) => r.selector === selector && r.media === media);

    // The tile keeps its red border and animates nothing.
    const [tile] = find('.tile.tile--needs');
    expect(tile.decls['border-color']).toContain('var(--red');
    expect(tile.decls.animation).toBeUndefined();
    expect(tile.decls['box-shadow']).toBeUndefined();

    // The glow is an overlay: a STATIC inset shadow (.tile is overflow: hidden
    // and clips an outer one), above the Attach overlay, out of the pointer's way.
    const [glow] = find('.tile.tile--needs::after');
    expect(glow.decls.content).toBe("''");
    expect(glow.decls.position).toBe('absolute');
    expect(glow.decls.inset).toBe('0');
    expect(glow.decls['pointer-events']).toBe('none');
    expect(Number(glow.decls['z-index'])).toBeGreaterThan(2);
    expect(glow.decls['box-shadow']).toMatch(/^inset /);
    expect(glow.decls.animation).toMatch(/^tile-needs-pulse /);

    // Only that overlay runs the pulse: no rule restates it on the tile (the old
    // entering-and-needs shorthand would now blink the whole tile's opacity).
    const pulsing = rules.filter((r) => /tile-needs-pulse/.test(r.decls.animation ?? ''));
    expect(pulsing.map((r) => r.selector)).toEqual(['.tile.tile--needs::after']);
    expect(rules.some((r) => r.selector.includes('tile--entering') && r.selector.includes('tile--needs'))).toBe(false);

    // Reduced motion: no pulse, and a static ring on the tile instead.
    const reduce = '(prefers-reduced-motion: reduce)';
    expect(find('.tile.tile--needs::after', reduce).some((r) => r.decls.display === 'none')).toBe(true);
    expect(find('.tile.tile--needs', reduce).some((r) => /^0 0 0 2px /.test(r.decls['box-shadow'] ?? ''))).toBe(true);
  });
});
