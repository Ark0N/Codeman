// Port: none (handlers sliced out of the shipped frontend files and run against stubs).
//
// The prompt-cache keep-alive turn (prompt-cache-keepwarm.ts) is Codeman's, not the user's, so
// on the page it must spend nothing: an idle alert still pending stays (only a human spends
// one), no "Response Complete" is raised, and the stuck-detection timer neither restarts nor
// re-arms ("Session Idle 10+ minutes" would otherwise follow every nudge). The server marks the
// turn's `hook:stop` with `acknowledgedReason` and its `session:working`/`session:idle` with
// `keepAlive`; these tests run the real handlers on those payloads.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const SESSION = 'keep-alive-session';
const THRESHOLD = 600_000;

/** The body of a method as shipped, compiled with `data` as its one parameter. */
function method(file: string, signature: string): (this: unknown, data: Record<string, unknown>) => void {
  const source = readFileSync(resolve(PUBLIC, file), 'utf8');
  const start = source.indexOf(`  ${signature} {`);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = source.indexOf('{', start) + 1;
  const end = source.indexOf('\n  }', bodyStart);
  return new Function('data', source.slice(bodyStart, end)) as (data: Record<string, unknown>) => void;
}

function makeApp() {
  const notifications: string[] = [];
  const app = {
    sessions: new Map([[SESSION, { status: 'idle' }]]),
    activeSessionId: 'another-session',
    respawnStatus: {},
    notificationManager: { preferences: { stuckThresholdMs: THRESHOLD } },
    idleTimers: new Map<string, unknown>(),
    pendingHooks: new Map<string, Set<string>>(),
    tabAlerts: new Map<string, string>(),
    notifications,
    renderSessionTabs() {},
    sendPendingCtrlL() {},
    _updateLocalEchoState() {},
    _notifySession: (_id: string, _level: string, kind: string) => notifications.push(kind),
    clearPendingHooks(sessionId: string) {
      app.pendingHooks.delete(sessionId);
      app.tabAlerts.delete(sessionId);
    },
    onIdle: method('app.js', '_onSessionIdle(data)'),
    onWorking: method('app.js', '_onSessionWorking(data)'),
    onStop: method('settings-ui.js', '_onHookStop(data)'),
  };
  return app;
}

describe('the keep-alive turn spends nothing on the page', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the stuck timer of the last real turn: not cleared, not re-armed', () => {
    const app = makeApp();
    app.onIdle({ id: SESSION });
    const realTimer = app.idleTimers.get(SESSION);
    expect(realTimer).toBeDefined();
    vi.advanceTimersByTime(THRESHOLD / 2);

    app.onWorking({ id: SESSION, keepAlive: true });
    expect(app.idleTimers.get(SESSION)).toBe(realTimer);
    app.onIdle({ id: SESSION, keepAlive: true });
    expect(app.idleTimers.get(SESSION)).toBe(realTimer);

    // Fires once, on the real turn's schedule, and nothing follows the keep-alive.
    vi.advanceTimersByTime(THRESHOLD / 2);
    expect(app.notifications).toEqual(['session-stuck']);
    vi.advanceTimersByTime(THRESHOLD * 2);
    expect(app.notifications).toEqual(['session-stuck']);
  });

  it('a real turn still restarts the stuck timer', () => {
    const app = makeApp();
    app.onIdle({ id: SESSION });
    app.onWorking({ id: SESSION });
    expect(app.idleTimers.has(SESSION)).toBe(false);
    app.onIdle({ id: SESSION });
    expect(app.idleTimers.has(SESSION)).toBe(true);
  });

  it("its stop leaves a pending idle alert and raises no 'Response Complete'", () => {
    const app = makeApp();
    app.pendingHooks.set(SESSION, new Set(['idle_prompt']));
    app.tabAlerts.set(SESSION, 'idle');
    app.onStop({ sessionId: SESSION, acknowledgedReason: 'cache keep-alive' });
    expect([...(app.pendingHooks.get(SESSION) ?? [])]).toEqual(['idle_prompt']);
    expect(app.tabAlerts.get(SESSION)).toBe('idle');
    // _onSessionWorking deletes the tab alert only with no pending hook, so it stays too.
    app.onWorking({ id: SESSION, keepAlive: true });
    expect(app.tabAlerts.get(SESSION)).toBe('idle');
    expect(app.notifications).toEqual([]);
  });

  it('a real stop still clears and notifies', () => {
    const app = makeApp();
    app.pendingHooks.set(SESSION, new Set(['idle_prompt']));
    app.onStop({ sessionId: SESSION });
    expect(app.pendingHooks.has(SESSION)).toBe(false);
    expect(app.notifications).toEqual(['hook-stop']);
  });
});

/**
 * `promptCacheKeepWarmMaxHours` is clamped to the settings schema's range (0.5 to 24) before the
 * save: the schema is strict, so one value outside it would reject every other change in the body.
 */
describe('the keep-warm cap is clamped before the save', () => {
  it.each([
    ['0.25', 0.5],
    ['30', 24],
    ['', 2],
    ['abc', 2],
    ['3.5', 3.5],
  ])('%j saves as %d', (input, expected) => {
    const source = readFileSync(resolve(PUBLIC, 'settings-ui.js'), 'utf8');
    const match = source.match(/promptCacheKeepWarmMaxHours:\s*\n?((?:\s*\/\/.*\n)*)\s*([^\n]+),\n/);
    expect(match).not.toBeNull();
    const document = { getElementById: () => ({ value: input }) };
    const value = new Function('document', `return ${match![2]};`)(document);
    expect(value).toBe(expected);
  });
});
