/**
 * @fileoverview tile-grid.js's side of the tile entrance styles (the entrance
 * module, entrance-animations.js, picks the style and times it):
 *
 * - `settle` (the default, and what the harness gets with no entrance module
 *   loaded) is the grid's own motion, untouched: tile-grid-motion.test.ts.
 * - Any other style hands each mounted tile to `_stageTileEntrance`, which
 *   arms the backstop that ends the entrance if animationend never comes.
 * - `.tile--entering` comes off on the tile's own `tile-enter*` end only,
 *   never on a ::before wash ending first.
 * - `off` mounts tiles with no entrance and no screen beat.
 * - A reload's restore settles whatever the style, and owes no screen beat.
 * - The screen beat (`playTileScreenEntrance`) plays once, when the load queue
 *   reports a tile's first capture done, and only for a tile style (never
 *   with the default `settle`).
 * - The closing grid's still copy hands its copies to `_stageTileExit` and
 *   waits as long as it says before the fallback removes the copy.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  localStore,
  main,
  makeGridApp,
  resetGridHarness,
  section,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c', 's-d'];
const tiles = () => section.children.filter((c) => c.classList.contains('tile'));
const ghosts = () => main.children.filter((c) => c.classList.contains('tile-grid-ghosts'));

/** An app whose entrance module picks `style`, with the module's hooks recorded. */
function styledApp(style: string): GridApp {
  const app = makeGridApp(IDS);
  app.selectSession = vi.fn((id: string) => app._selectTiledSession(id, {}));
  app.tileEntranceStyle = () => style;
  app._stageTileEntrance = vi.fn();
  app.playTileScreenEntrance = vi.fn();
  return app;
}

/** Swaps in a load queue that hands the grid's state callback to the test. */
function captureQueue() {
  const Queue = windowStub.TileLoadQueue;
  const box: { report: (tile: unknown, state: string) => void; restore: () => void } = {
    report: () => {},
    restore: () => {
      windowStub.TileLoadQueue = Queue;
    },
  };
  windowStub.TileLoadQueue = class {
    constructor(opts: { onChange: (tile: unknown, state: string) => void }) {
      box.report = opts.onChange;
    }
    schedule(_t: unknown, _k: string, run: () => Promise<void>) {
      return run();
    }
    drop() {}
  };
  return box;
}

beforeEach(() => {
  resetGridHarness();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a themed entrance', () => {
  it('hands every mounted tile to the entrance module, entering and in reading order', () => {
    const app = styledApp('fly');
    app.openTileGrid(IDS.slice(0, 3), { focusedId: 's-b' });
    expect(app._stageTileEntrance).toHaveBeenCalledTimes(3);
    const calls = (app._stageTileEntrance as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => c[1])).toEqual(['s-a', 's-b', 's-c']);
    for (const [el] of calls) expect((el as FakeEl).classList.contains('tile--entering')).toBe(true);
  });

  it('the backstop the module arms ends the entrance when animationend never comes', () => {
    vi.useFakeTimers();
    const app = styledApp('crt');
    app.openTileGrid(['s-a']);
    const [el, , setBackstop] = (app._stageTileEntrance as ReturnType<typeof vi.fn>).mock.calls[0];
    (el as FakeEl).classList.add('tile--enter-themed', 'tile--enter-hold');
    setBackstop(800);
    vi.advanceTimersByTime(799);
    expect((el as FakeEl).classList.contains('tile--entering')).toBe(true);
    vi.advanceTimersByTime(1);
    expect((el as FakeEl).className.split(' ')).not.toContain('tile--entering');
    expect((el as FakeEl).classList.contains('tile--enter-themed')).toBe(false);
    expect((el as FakeEl).classList.contains('tile--enter-hold')).toBe(false);
  });

  it('ends on its own tile-enter-* animationend, never on a ::before wash or a child', () => {
    const app = styledApp('crt');
    app.openTileGrid(['s-a']);
    const el = tiles()[0];
    el.dispatch('animationend', { target: el, animationName: 'win-enter-crt-flash', pseudoElement: '::before' });
    el.dispatch('animationend', { target: el, animationName: 'tile-enter-crt', pseudoElement: '::before' });
    el.dispatch('animationend', { target: new FakeEl(), animationName: 'tile-enter-crt' });
    expect(el.classList.contains('tile--entering')).toBe(true);
    el.dispatch('animationend', { target: el, animationName: 'tile-enter-crt', pseudoElement: '' });
    expect(el.classList.contains('tile--entering')).toBe(false);
  });

  it('`off` mounts tiles with no entrance and owes them no screen beat', () => {
    const queue = captureQueue();
    try {
      const app = styledApp('off');
      app.openTileGrid(['s-a', 's-b']);
      expect(tiles().some((t) => t.classList.contains('tile--entering'))).toBe(false);
      expect(app._stageTileEntrance).not.toHaveBeenCalled();
      app._tileLoadQueue();
      queue.report(app._tileFor('s-a'), 'idle');
      expect(app.playTileScreenEntrance).not.toHaveBeenCalled();
    } finally {
      queue.restore();
    }
  });

  it('`settle` stays on the grid default: no hand-off to the module', () => {
    const app = styledApp('settle');
    app.openTileGrid(['s-a', 's-b']);
    expect(app._stageTileEntrance).not.toHaveBeenCalled();
    expect(tiles().map((t) => t.style['--tile-enter-index'])).toEqual(['0', '1']);
  });
});

describe('the screen beat', () => {
  it('never plays with the default settle: the grid behaves exactly as before', () => {
    const queue = captureQueue();
    try {
      const app = styledApp('settle');
      app.openTileGrid(['s-a']);
      app._tileLoadQueue();
      queue.report(app._tileFor('s-a'), 'idle');
      expect(app.playTileScreenEntrance).not.toHaveBeenCalled();
    } finally {
      queue.restore();
    }
  });

  it('plays once, on the first capture landing, on that tile body', () => {
    const queue = captureQueue();
    try {
      const app = styledApp('fly');
      app.openTileGrid(['s-a', 's-b']);
      app._tileLoadQueue();
      const tileA = app._tileFor('s-a');
      queue.report(tileA, 'running');
      expect(app.playTileScreenEntrance).not.toHaveBeenCalled();
      queue.report(tileA, 'idle');
      expect(app.playTileScreenEntrance).toHaveBeenCalledTimes(1);
      expect(app.playTileScreenEntrance).toHaveBeenCalledWith(app._tileGrid.tiles.get('s-a').body);
      // A later load (a reconnect refresh) plays nothing again.
      queue.report(tileA, 'running');
      queue.report(tileA, 'idle');
      expect(app.playTileScreenEntrance).toHaveBeenCalledTimes(1);
    } finally {
      queue.restore();
    }
  });
});

describe('a reload restoring the grid', () => {
  it('settles whatever the style, and owes no screen beat (nothing animates on page load)', () => {
    const queue = captureQueue();
    try {
      localStore.set(
        'codeman:tile-grid',
        JSON.stringify({
          v: 1,
          open: true,
          ids: ['s-a', 's-b'],
          focused: 's-a',
          zoomed: null,
          colFr: [1, 1],
          rowFr: [1],
        })
      );
      const app = styledApp('deal');
      expect(app._restoreTileGrid()).toBe(true);
      expect(app._stageTileEntrance).not.toHaveBeenCalled();
      expect(tiles().every((t) => t.classList.contains('tile--entering'))).toBe(true);
      app._tileLoadQueue();
      queue.report(app._tileFor('s-a'), 'idle');
      expect(app.playTileScreenEntrance).not.toHaveBeenCalled();
      // The quiet flag is gone after the restore: the next open is themed.
      app.closeTileGrid({ reselect: false });
      app.openTileGrid(['s-c']);
      expect(app._stageTileEntrance).toHaveBeenCalledTimes(1);
    } finally {
      queue.restore();
    }
  });
});

describe('closing with the Tiles toggle', () => {
  it('hands the copies to the exit, stripped of entrance state, and waits as long as it says', () => {
    vi.useFakeTimers();
    const app = styledApp('crt');
    app._stageTileExit = vi.fn(() => 1200);
    app.openTileGrid(IDS.slice(0, 2));
    for (const t of tiles()) t.classList.add('tile--enter-themed', 'tile--enter-hold');
    app.selectSession = vi.fn(() => new Promise<void>(() => {}));
    app.toggleTileGrid();
    const [copies, opts] = (app._stageTileExit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts).toEqual({ now: false });
    expect((copies as Array<{ sessionId: string }>).map((c) => c.sessionId)).toEqual(['s-a', 's-b']);
    const layer = ghosts()[0];
    for (const g of layer.children) {
      expect(g.classList.contains('tile--enter-themed')).toBe(false);
      expect(g.classList.contains('tile--enter-hold')).toBe(false);
    }
    // Held 700 ms (the single view never settles here), then released: the
    // fallback is the exit's 1200 ms, not the default fade's 450.
    vi.advanceTimersByTime(700);
    expect(layer.classList.contains('tile-grid-ghosts--release')).toBe(true);
    vi.advanceTimersByTime(1199);
    expect(ghosts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ghosts()).toHaveLength(0);
  });

  it('the copy goes on its last tile’s tile-leave-* end, not on a ::before wash', () => {
    const app = styledApp('crt');
    app._stageTileExit = vi.fn(() => 900);
    app.openTileGrid(IDS.slice(0, 2));
    app.toggleTileGrid();
    const layer = ghosts()[0];
    const last = layer.lastElementChild!;
    layer.dispatch('animationend', { target: last, animationName: 'tile-leave-crt', pseudoElement: '::before' });
    expect(ghosts()).toHaveLength(1);
    layer.dispatch('animationend', { target: last, animationName: 'tile-leave-crt', pseudoElement: '' });
    expect(ghosts()).toHaveLength(0);
  });
});
