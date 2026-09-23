// Port: none (pure policy + the real scheduler from app.js under a fake clock).
//
// `_onSessionTerminal` drops an incoming frame once the app-owned render queues
// hold 128KB. That is the right call — the alternative is an unbounded backlog —
// but a hole in a TUI byte stream is a desynced cursor, and a desynced cursor is
// muffled text (issue #464). The drop is only half of it; the recovery has to
// actually happen.
//
// ⚠️ It used to be a fire-and-forget timer: it nulled its own handle and then
// called `_onSessionNeedsRefresh()`, which opens with four early returns. Two of
// them — a buffer load in flight, a refresh already owning this session — are
// MOST likely to be true during exactly the output burst that caused the drop,
// so the recovery was silently lost precisely when it was needed, and those
// bytes were never replayed.
//
// The test that matters here is `retries when the refresh was skipped`, paired
// with `does not retry once a repaint happened`. Either one alone would pass
// against the old fire-and-forget code; only the contrast pins the fix.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

type RetryState = { repainted: boolean; timedOut?: boolean; attempt: number; stillActive: boolean };

function loadConstants() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(readFileSync(resolve(publicDir, 'constants.js'), 'utf8'), context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanDroppedOutput: {
        shouldRetryDroppedOutputRecovery: (s: RetryState) => boolean;
        DROP_RECOVERY_DELAY_MS: number;
        DROP_RECOVERY_MAX_ATTEMPTS: number;
      };
    }
  ).CodemanDroppedOutput;
}

const { shouldRetryDroppedOutputRecovery, DROP_RECOVERY_MAX_ATTEMPTS, DROP_RECOVERY_DELAY_MS } = loadConstants();

describe('shouldRetryDroppedOutputRecovery', () => {
  it('retries a recovery that did not repaint', () => {
    expect(shouldRetryDroppedOutputRecovery({ repainted: false, attempt: 0, stillActive: true })).toBe(true);
  });

  it('stops as soon as something repainted', () => {
    expect(shouldRetryDroppedOutputRecovery({ repainted: true, attempt: 0, stillActive: true })).toBe(false);
  });

  it('stops when the reader has moved to another session', () => {
    // selectSession repaints from the server on its own, so a retry here would
    // be a second replay of a buffer that is about to be written anyway.
    expect(shouldRetryDroppedOutputRecovery({ repainted: false, attempt: 0, stillActive: false })).toBe(false);
  });

  it('does not retry a refresh that died at the fetch deadline', () => {
    // A stalled link, not contention: each retry would be another full capture
    // waiting out a deadline of up to two minutes.
    expect(shouldRetryDroppedOutputRecovery({ repainted: false, timedOut: true, attempt: 0, stillActive: true })).toBe(
      false
    );
  });

  it('gives up at the cap rather than looping against the API forever', () => {
    const last = DROP_RECOVERY_MAX_ATTEMPTS - 1;
    expect(shouldRetryDroppedOutputRecovery({ repainted: false, attempt: last - 1, stillActive: true })).toBe(true);
    expect(shouldRetryDroppedOutputRecovery({ repainted: false, attempt: last, stillActive: true })).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The real scheduler, from app.js, under a fake clock.
// ───────────────────────────────────────────────────────────────────────────

function loadAppPrototype(): Record<string, unknown> {
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance: { now: () => 0 },
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    // ⚠️ Delegated, not captured. Baking the real `setTimeout` into the context
    // puts the scheduler on a clock `vi.useFakeTimers()` cannot reach, and the
    // retry behaviour under test is entirely a matter of timers firing. These
    // arrows resolve the identifier from the global at CALL time, so the fake
    // clock installed later still owns them.
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
  });
  vm.runInContext(
    `${readFileSync(resolve(publicDir, 'constants.js'), 'utf8')}\n` +
      `${readFileSync(resolve(publicDir, 'app.js'), 'utf8')}\n` +
      `globalThis.__CodemanApp = CodemanApp;\nglobalThis.__crashDiag = _crashDiag;`,
    context
  );
  crashTrail = (context as { __crashDiag: { _entries: string[] } }).__crashDiag._entries;
  return (context as { __CodemanApp: { prototype: Record<string, unknown> } }).__CodemanApp.prototype;
}

let crashTrail: string[] = [];
const proto = loadAppPrototype();
const SESSION = 'session-A';

/** A minimal app carrying only what the scheduler touches. */
function makeApp(refresh: () => unknown) {
  const calls: string[] = [];
  return {
    calls,
    app: {
      _scheduleDroppedOutputRecovery: proto._scheduleDroppedOutputRecovery,
      activeSessionId: SESSION,
      _clientDropRecoveryTimer: null as ReturnType<typeof setTimeout> | null,
      _onSessionNeedsRefresh: (arg: { id: string }) => {
        calls.push(arg.id);
        return refresh();
      },
    } as unknown as {
      _scheduleDroppedOutputRecovery: (id: string, attempt?: number) => void;
      activeSessionId: string | null;
      _clientDropRecoveryTimer: unknown;
    },
  };
}

/** Run every pending timer the scheduler laid down, up to `rounds` deep. */
async function drain(rounds = DROP_RECOVERY_MAX_ATTEMPTS + 2) {
  for (let i = 0; i < rounds; i++) {
    await vi.advanceTimersByTimeAsync(DROP_RECOVERY_DELAY_MS + 1);
  }
}

describe('_scheduleDroppedOutputRecovery', () => {
  it('retries when the refresh was SKIPPED, which is what a burst makes likely', async () => {
    vi.useFakeTimers();
    try {
      // `_onSessionNeedsRefresh` returns false from all four of its early
      // returns — a buffer load in flight, a refresh already owning the session.
      const { app, calls } = makeApp(() => Promise.resolve(false));
      app._scheduleDroppedOutputRecovery(SESSION);
      await drain();
      expect(calls.length, 'a skipped refresh must be tried again — the old fire-and-forget timer stopped at one').toBe(
        DROP_RECOVERY_MAX_ATTEMPTS
      );
      expect(new Set(calls)).toEqual(new Set([SESSION]));
    } finally {
      vi.useRealTimers();
    }
  });

  // The contrast. Without this the case above is satisfied by retrying forever.
  it('does not retry once a repaint actually happened', async () => {
    vi.useFakeTimers();
    try {
      const { app, calls } = makeApp(() => Promise.resolve(true));
      app._scheduleDroppedOutputRecovery(SESSION);
      await drain();
      expect(calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when the reader switches away mid-recovery', async () => {
    vi.useFakeTimers();
    try {
      const { app, calls } = makeApp(() => {
        app.activeSessionId = 'session-B';
        return Promise.resolve(false);
      });
      app._scheduleDroppedOutputRecovery(SESSION);
      await drain();
      expect(calls.length, 'selectSession repaints session-B on its own').toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a refresh that THREW as not repainted, and tries again', async () => {
    vi.useFakeTimers();
    try {
      const { app, calls } = makeApp(() => Promise.reject(new Error('network')));
      app._scheduleDroppedOutputRecovery(SESSION);
      await drain();
      expect(calls.length).toBe(DROP_RECOVERY_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a refresh that hit the fetch deadline', async () => {
    vi.useFakeTimers();
    try {
      const { app, calls } = makeApp(() => Promise.resolve('deadline'));
      app._scheduleDroppedOutputRecovery(SESSION);
      await drain();
      expect(calls.length, 'a stalled link is not contention; one full capture is the old cost').toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes one crash-trail line per debounce window, not one per dropped frame', async () => {
    vi.useFakeTimers();
    try {
      const { app } = makeApp(() => Promise.resolve(true));
      const before = crashTrail.filter((e) => e.includes('TERMINAL DROP')).length;
      const schedule = app._scheduleDroppedOutputRecovery as (id: string, attempt?: number, queued?: number) => void;
      for (let i = 0; i < 125; i++) schedule.call(app, SESSION, 0, 200 * 1024);
      const drops = crashTrail.filter((e) => e.includes('TERMINAL DROP')).length - before;
      expect(drops, 'one second of 8ms frames used to evict the whole 50-entry trail').toBe(1);
      await drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of drops into one attempt, as the debounce always did', async () => {
    vi.useFakeTimers();
    try {
      const { app, calls } = makeApp(() => Promise.resolve(true));
      for (let i = 0; i < 20; i++) app._scheduleDroppedOutputRecovery(SESSION);
      await drain();
      expect(calls.length, 'twenty dropped frames must not become twenty fetches').toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the drop path and the refresh agree on what counts as recovered', () => {
  const app = read('src/web/public/app.js');

  it('the 128KB drop goes through the scheduler, not a bare timer', () => {
    const at = app.indexOf('131072');
    expect(at, 'the cap is gone — renamed?').toBeGreaterThan(-1);
    const branch = app.slice(at, at + 600);
    expect(branch).toContain('this._scheduleDroppedOutputRecovery(data.id, 0, queued)');
    // The crash-trail line belongs behind the scheduler's debounce guard.
    expect(branch).not.toContain('_crashDiag.log');
    expect(branch, 'a bare setTimeout here is the bug this fixes').not.toContain('setTimeout');
  });

  it('_onSessionNeedsRefresh reports false from every early return', () => {
    const start = app.indexOf('async _onSessionNeedsRefresh(event = {})');
    expect(start).toBeGreaterThan(-1);
    const head = app.slice(start, app.indexOf('const refreshOwner', start));
    const bareReturns = head.match(/\breturn;/g) ?? [];
    expect(bareReturns, 'a bare `return` reads as undefined, which the caller cannot tell from false').toHaveLength(0);
    expect((head.match(/return false;/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('and reports true only where it settles the reconcile marker', () => {
    const start = app.indexOf('async _onSessionNeedsRefresh(event = {})');
    const body = app.slice(start, app.indexOf('\n  }\n', app.indexOf('needsRefresh reload failed', start)));
    const markerAt = body.indexOf('this._markTerminalBufferReconciled(sessionId);');
    const trueAt = body.indexOf('return true;');
    expect(markerAt).toBeGreaterThan(-1);
    expect(trueAt, 'the success return must sit with the marker it settles').toBeGreaterThan(markerAt);
    expect(trueAt - markerAt).toBeLessThan(80);
  });
});
