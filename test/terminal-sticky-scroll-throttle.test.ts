/**
 * @fileoverview Sticky-scroll throttle (_stickyScrollToBottom in terminal-ui.js).
 *
 * Some CLIs redraw their status widget many times a second with no real new
 * content — omp's upstream row-duplication bug (can1357/oh-my-pi#9780) is the
 * concrete trigger, confirmed against a real omp session: history_size climbed
 * continuously during a plain `sleep 40` tool call with zero legitimate output.
 * flushPendingWrites() calling scrollToBottom() unthrottled on every one of
 * those flushes is harmless on a tall desktop terminal (the jump is invisible)
 * but reads as continuous scrolling on a phone's short viewport, where each
 * snap is a much bigger fraction of what's on screen.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), mirroring
 * test/local-echo-codex-gating.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface FakeTerminal {
  scrollToBottom: () => void;
}

interface AppInstance {
  terminal: FakeTerminal;
  _lastUserScrollUpAt?: number;
  _lastStickyScrollAt?: number;
  _stickyScrollTrailingTimer?: unknown;
  _hasRecentUserScrollUp(): boolean;
  _stickyScrollToBottom(): void;
}

function loadContext() {
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  // Starts well past 0 so it never collides with _stickyScrollToBottom's own
  // `|| 0` fallback for "never scrolled yet" (real performance.now() is always
  // a large positive number, never 0, so this matches production).
  let now = 10_000;
  let pendingTimer: { fn: () => void; delay: number } | null = null;
  const windowStub: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const context = vm.createContext({
    console,
    performance: { now: () => now },
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout: (fn: () => void, delay: number) => {
      pendingTimer = { fn, delay };
      return 1;
    },
    clearTimeout: () => {
      pendingTimer = null;
    },
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn(), documentElement: { dataset: {} } },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: windowStub,
    MobileDetection: {
      isTouchDevice: () => true,
      isHandheldDevice: () => false,
      getDeviceType: () => 'desktop',
    },
  });
  vm.runInContext(
    `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
  return {
    CodemanApp,
    advance: (ms: number) => {
      now += ms;
    },
    currentNow: () => now,
    fireTrailingTimer: () => {
      if (!pendingTimer) throw new Error('no trailing timer scheduled');
      const { fn } = pendingTimer;
      pendingTimer = null;
      fn();
    },
    hasPendingTimer: () => pendingTimer !== null,
  };
}

function makeApp(CodemanApp: { prototype: object }, calls: string[]): AppInstance {
  const app = Object.create(CodemanApp.prototype) as AppInstance;
  app.terminal = { scrollToBottom: () => calls.push('scrollToBottom') };
  app._lastUserScrollUpAt = undefined;
  return app;
}

describe('_stickyScrollToBottom', () => {
  it('scrolls immediately on the first call', () => {
    const { CodemanApp } = loadContext();
    const calls: string[] = [];
    const app = makeApp(CodemanApp, calls);
    app._stickyScrollToBottom();
    expect(calls).toEqual(['scrollToBottom']);
  });

  it('coalesces a rapid-fire burst into one trailing call instead of one per flush', () => {
    const { CodemanApp, advance, fireTrailingTimer, hasPendingTimer } = loadContext();
    const calls: string[] = [];
    const app = makeApp(CodemanApp, calls);

    app._stickyScrollToBottom(); // immediate
    for (let i = 0; i < 10; i++) {
      advance(10); // 10 calls at 10ms apart — all inside the 180ms gap
      app._stickyScrollToBottom();
    }
    // Only the leading call fired; the rest coalesced into one pending trailing timer.
    expect(calls).toEqual(['scrollToBottom']);
    expect(hasPendingTimer()).toBe(true);

    fireTrailingTimer();
    // Exactly one catch-up jump for the whole burst, not one per flush.
    expect(calls).toEqual(['scrollToBottom', 'scrollToBottom']);
  });

  it('does not coalesce calls spaced further apart than the throttle gap', () => {
    const { CodemanApp, advance } = loadContext();
    const calls: string[] = [];
    const app = makeApp(CodemanApp, calls);

    app._stickyScrollToBottom();
    advance(200); // past STICKY_SCROLL_MIN_GAP_MS (180ms)
    app._stickyScrollToBottom();
    expect(calls).toEqual(['scrollToBottom', 'scrollToBottom']);
  });

  it('skips the trailing catch-up if the user scrolled up before it fires', () => {
    const { CodemanApp, advance, currentNow, fireTrailingTimer } = loadContext();
    const calls: string[] = [];
    const app = makeApp(CodemanApp, calls);

    app._stickyScrollToBottom(); // immediate, arms the throttle window
    advance(10);
    app._stickyScrollToBottom(); // coalesced, schedules the trailing timer
    // User scrolls up before the trailing timer fires — must not snap them back.
    app._lastUserScrollUpAt = currentNow();

    fireTrailingTimer();
    expect(calls).toEqual(['scrollToBottom']);
  });
});
