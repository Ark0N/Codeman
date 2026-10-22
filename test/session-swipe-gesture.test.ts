// Port: none (pure logic in a vm context: no browser, no server).
//
// The session swipe (SwipeHandler, mobile-handlers.js) shares every gesture with
// the terminal's own touch handler (terminal-ui.js), which runs first. A swipe
// used to switch sessions even when the terminal had taken the same drag as a
// scroll or a pan, and the terminal took a sideways flick as a TAP on the
// session being left. The terminal now publishes the axis it locked
// (`app._terminalGestureAxis`) and the swipe stands aside for 'y' and 'x'.
//
// Lives outside test/mobile/ because that suite is Playwright-driven and not in
// the CI gate (same reasoning as test/viewport-shape-change.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile-handlers.js'), 'utf8');
const TERMINAL_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

type Touch = { clientX: number; clientY: number };
type Swipe = {
  onTouchStart(e: unknown): void;
  onTouchMove(e: unknown): void;
  onTouchEnd(e: unknown): void;
  maxSwipeTime: number;
  maxVerticalDrift: number;
  startTime: number;
};

function load(appOverrides: Record<string, unknown> = {}) {
  const app = {
    nextSession: vi.fn(),
    prevSession: vi.fn(),
    _terminalGestureAxis: null as string | null,
    ...appOverrides,
  };
  const context = vm.createContext({
    console,
    app,
    navigator: { userAgent: 'iPhone', maxTouchPoints: 5 },
    window: { addEventListener: () => {}, matchMedia: () => ({ matches: true }) },
    document: { querySelector: () => null },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(`${SOURCE}\nglobalThis.__swipe = SwipeHandler;`, context);
  const swipe = (context as unknown as { __swipe: Swipe }).__swipe;
  const target = (ignored = false) => ({
    closest: (sel: string) => (ignored && sel !== '.session-sidebar' ? {} : null),
  });
  // `axis` is what the terminal's touchmove publishes mid-gesture (after the
  // touchstart, which resets it); `consumed` a touchend the terminal
  // preventDefault'ed.
  const gesture = (
    from: Touch,
    to: Touch,
    opts: { ms?: number; ignored?: boolean; via?: Touch; axis?: string | null; consumed?: boolean } = {}
  ) => {
    swipe.onTouchStart({ target: target(opts.ignored), touches: [from] });
    if (opts.axis !== undefined) app._terminalGestureAxis = opts.axis;
    if (opts.ms) swipe.startTime -= opts.ms;
    if (opts.via) swipe.onTouchMove({ touches: [opts.via] });
    swipe.onTouchMove({ touches: [to] });
    swipe.onTouchEnd({ changedTouches: [to], defaultPrevented: !!opts.consumed });
  };
  return { app, swipe, gesture };
}

describe('session swipe', () => {
  it('switches on a clean horizontal swipe', () => {
    const { app, gesture } = load();
    gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 405 });
    expect(app.nextSession).toHaveBeenCalledTimes(1);

    gesture({ clientX: 100, clientY: 400 }, { clientX: 260, clientY: 400 });
    expect(app.prevSession).toHaveBeenCalledTimes(1);
  });

  it('accepts an unhurried swipe up to 500ms, not past it', () => {
    const { app, gesture } = load();
    gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 }, { ms: 450 });
    expect(app.nextSession).toHaveBeenCalledTimes(1);
    gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 }, { ms: 600 });
    expect(app.nextSession).toHaveBeenCalledTimes(1);
  });

  it('cancels when the finger drifted vertically mid-gesture, even if it came back', () => {
    const { app, gesture } = load();
    gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 }, { via: { clientX: 220, clientY: 470 } });
    expect(app.nextSession).not.toHaveBeenCalled();
  });

  it('stands aside when the terminal took the drag as a scroll or a pan', () => {
    for (const axis of ['y', 'x']) {
      const { app, gesture } = load();
      gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 }, { axis });
      expect(app.nextSession, axis).not.toHaveBeenCalled();
    }
    const { app, gesture } = load();
    gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 }, { axis: 'swipe' });
    expect(app.nextSession).toHaveBeenCalledTimes(1);
  });

  it('forgets the axis a previous gesture left behind, so a swipe from home works after a terminal scroll', () => {
    // The terminal resets the axis only for a touch that starts on it; a swipe
    // over the home screen starts elsewhere in `.main`.
    const { app, gesture } = load({ _terminalGestureAxis: 'y' });
    gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 });
    expect(app.nextSession).toHaveBeenCalledTimes(1);
  });

  it('stands aside when the terminal consumed the lift (a long-press selection gesture)', () => {
    // A long-press on blank space sets _touchSelecting, finds no word, and the
    // terminal clears the flag synchronously in its own touchend before this
    // handler runs; the preventDefault it leaves behind is the signal.
    const { app, gesture } = load();
    gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 }, { consumed: true });
    expect(app.nextSession).not.toHaveBeenCalled();
  });

  it('never switches during a touch selection or on a surface with its own controls', () => {
    for (const flag of ['_touchSelecting', '_touchSelectionActive']) {
      const { app, gesture } = load({ [flag]: true });
      gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 });
      expect(app.nextSession, flag).not.toHaveBeenCalled();
    }
    const { app, gesture } = load();
    gesture({ clientX: 300, clientY: 400 }, { clientX: 150, clientY: 400 }, { ignored: true });
    expect(app.nextSession).not.toHaveBeenCalled();
  });

  it('ignores every lift after a second finger joined, the first finger lifting first included', () => {
    // Finger A starts the gesture, B joins (a pinch), A lifts, then B lifts
    // 150 px from A's start within the time limit: neither lift is a swipe.
    const { app, swipe } = load();
    const a = { clientX: 300, clientY: 400 };
    const b = { clientX: 100, clientY: 400 };
    swipe.onTouchStart({ target: { closest: () => null }, touches: [a] });
    swipe.onTouchStart({ target: { closest: () => null }, touches: [a, b] });
    swipe.onTouchEnd({ changedTouches: [{ clientX: 200, clientY: 400 }] });
    swipe.onTouchEnd({ changedTouches: [{ clientX: 150, clientY: 400 }] });
    expect(app.nextSession).not.toHaveBeenCalled();
  });
});

describe('terminal touch handler hands sideways drags to the swipe', () => {
  it('locks a dominant sideways drag as a swipe unless the terminal can pan', () => {
    expect(TERMINAL_SOURCE).toContain("panAxis = travelX > travelY ? (canPanHorizontally() ? 'x' : 'swipe') : 'y';");
    expect(TERMINAL_SOURCE).toContain('this._terminalGestureAxis = panAxis;');
    // A 'swipe' is neither a scroll nor (didScroll is set) a tap.
    expect(TERMINAL_SOURCE).toContain("if (panAxis === 'swipe') {");
  });

  it("hands a 'swipe' drag back to the scroll once it passes the swipe's own drift limit", () => {
    // A thumb arc whose first move leans sideways (+9 px across, +5 px down) locks
    // as 'swipe'; SwipeHandler drops it past maxVerticalDrift, so without the
    // handback the 300 px of downward travel that follows would do nothing.
    const start = TERMINAL_SOURCE.indexOf("if (panAxis === 'swipe') {");
    const block = TERMINAL_SOURCE.slice(start, TERMINAL_SOURCE.indexOf("if (panAxis === 'x') {", start));
    expect(block).toContain('SwipeHandler.maxVerticalDrift');
    expect(block).toContain('if (Math.abs(touchY - touchStartY) <= drift) return;');
    expect(block).toContain("panAxis = 'y';");
    expect(block).toContain("this._terminalGestureAxis = 'y';");
    // The terminal reads the swipe's limit by name; its fallback is the same value.
    expect(load().swipe.maxVerticalDrift).toBe(50);
  });
});
