/**
 * @fileoverview COD-108 — remote-session auto-reconnect watcher tests.
 *
 * Three layers, all tmux-safe (under VITEST TmuxManager no-ops real tmux and
 * `isPaneDead` returns false, so live behavior is driven via injected stubs):
 *
 *  (a) PURE backoff schedule — attempt→delay, cap, reset-on-success.
 *  (b) PURE eligibility decision — dead remote pane + due → emit; guarded →
 *      never; non-remote / pane-alive / not-due → skip; over-cap → exhaust.
 *  (c) MANAGER integration — drive ticks with a stubbed pane-death signal +
 *      controllable clock and assert the emit → backoff → exhausted progression,
 *      and that a guarded (intentionally-killed) session emits nothing.
 *
 * Port: N/A (no server).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BACKOFF_SCHEDULE_MS,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayForAttempt,
  isExhausted,
  freshReconnectState,
  advanceBackoff,
  resetReconnectState,
  decideReconnect,
} from '../src/remote-reconnect.js';
import type { ReconnectSessionView } from '../src/remote-reconnect.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types.js';

const REMOTE: SessionRemote = {
  hostId: 'aa-desktop',
  label: 'aa-desktop',
  host: 'aa-desktop',
  username: 'aakhter',
  remotePath: '/home/aakhter',
  owned: true,
};

// ────────────────────────────────────────────────────────────────────────────
// (a) PURE backoff schedule
// ────────────────────────────────────────────────────────────────────────────

describe('reconnect backoff schedule (pure)', () => {
  it('returns the documented bounded exponential delays per attempt', () => {
    expect(reconnectDelayForAttempt(1)).toBe(5_000);
    expect(reconnectDelayForAttempt(2)).toBe(15_000);
    expect(reconnectDelayForAttempt(3)).toBe(45_000);
    expect(reconnectDelayForAttempt(4)).toBe(120_000);
    expect(reconnectDelayForAttempt(5)).toBe(300_000);
    expect(reconnectDelayForAttempt(6)).toBe(300_000);
  });

  it('clamps below-range and above-range attempts to the schedule bounds', () => {
    expect(reconnectDelayForAttempt(0)).toBe(BACKOFF_SCHEDULE_MS[0]);
    expect(reconnectDelayForAttempt(-3)).toBe(BACKOFF_SCHEDULE_MS[0]);
    expect(reconnectDelayForAttempt(99)).toBe(BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]);
  });

  it('flags exhaustion only at/after the cap', () => {
    expect(isExhausted(0)).toBe(false);
    expect(isExhausted(MAX_RECONNECT_ATTEMPTS - 1)).toBe(false);
    expect(isExhausted(MAX_RECONNECT_ATTEMPTS)).toBe(true);
    expect(isExhausted(MAX_RECONNECT_ATTEMPTS + 1)).toBe(true);
  });

  it('advanceBackoff increments attempts and schedules next-eligible from now (immutable)', () => {
    const s0 = freshReconnectState();
    const s1 = advanceBackoff(s0, 1_000);
    expect(s0.attempts).toBe(0); // input untouched
    expect(s1.attempts).toBe(1);
    expect(s1.nextEligibleAt).toBe(1_000 + 5_000);
    expect(s1.exhausted).toBe(false);

    const s2 = advanceBackoff(s1, 10_000);
    expect(s2.attempts).toBe(2);
    expect(s2.nextEligibleAt).toBe(10_000 + 15_000);
  });

  it('reaches the attempt cap after the scheduled number of advances', () => {
    let s = freshReconnectState();
    let now = 0;
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      s = advanceBackoff(s, now);
      now += reconnectDelayForAttempt(s.attempts);
    }
    expect(s.attempts).toBe(MAX_RECONNECT_ATTEMPTS);
    // advanceBackoff does not itself set `exhausted`; the watcher decides that
    // on the following tick via isExhausted(attempts).
    expect(isExhausted(s.attempts)).toBe(true);
  });

  it('reset-on-success returns to a fresh, immediately-eligible state', () => {
    const advanced = advanceBackoff(advanceBackoff(freshReconnectState(), 0), 100);
    expect(advanced.attempts).toBe(2);
    const reset = resetReconnectState();
    expect(reset.attempts).toBe(0);
    expect(reset.nextEligibleAt).toBe(0);
    expect(reset.exhausted).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (b) PURE eligibility decision
// ────────────────────────────────────────────────────────────────────────────

describe('decideReconnect (pure eligibility)', () => {
  const deadRemote: ReconnectSessionView = { sessionId: 's1', isRemote: true, paneDead: true, remoteAlive: true };

  it('emits for a dead remote pane that is not guarded and is due', () => {
    const action = decideReconnect({
      session: deadRemote,
      state: freshReconnectState(),
      guarded: false,
      enabled: true,
      now: 0,
    });
    expect(action).toEqual({ kind: 'emit', attempt: 1 });
  });

  it('NEVER reconnects a guarded (intentionally killed/detached) session', () => {
    const action = decideReconnect({
      session: deadRemote,
      state: freshReconnectState(),
      guarded: true,
      enabled: true,
      now: 0,
    });
    expect(action).toEqual({ kind: 'skip', reason: 'guarded' });
  });

  it('skips non-remote sessions', () => {
    const action = decideReconnect({
      session: { sessionId: 's1', isRemote: false, paneDead: true, remoteAlive: true },
      state: freshReconnectState(),
      guarded: false,
      enabled: true,
      now: 0,
    });
    expect(action).toEqual({ kind: 'skip', reason: 'not-remote' });
  });

  it('skips when the pane is alive', () => {
    const action = decideReconnect({
      session: { sessionId: 's1', isRemote: true, paneDead: false, remoteAlive: true },
      state: freshReconnectState(),
      guarded: false,
      enabled: true,
      now: 0,
    });
    expect(action).toEqual({ kind: 'skip', reason: 'pane-alive' });
  });

  it('NEVER revives when the durable remote tmux is GONE (clean exit — the 2026-08-29 fix)', () => {
    const action = decideReconnect({
      session: { sessionId: 's1', isRemote: true, paneDead: true, remoteAlive: false },
      state: freshReconnectState(),
      guarded: false,
      enabled: true,
      now: 0,
    });
    expect(action).toEqual({ kind: 'skip', reason: 'remote-gone' });
  });

  it('NEVER revives when remote liveness is unknown (probe failed — fail closed)', () => {
    const action = decideReconnect({
      session: { sessionId: 's1', isRemote: true, paneDead: true, remoteAlive: undefined },
      state: freshReconnectState(),
      guarded: false,
      enabled: true,
      now: 0,
    });
    expect(action).toEqual({ kind: 'skip', reason: 'remote-gone' });
  });

  it('skips when the kill-switch is off', () => {
    const action = decideReconnect({
      session: deadRemote,
      state: freshReconnectState(),
      guarded: false,
      enabled: false,
      now: 0,
    });
    expect(action).toEqual({ kind: 'skip', reason: 'disabled' });
  });

  it('skips when not yet due (within backoff window)', () => {
    const state = advanceBackoff(freshReconnectState(), 0); // nextEligibleAt = 5000
    const action = decideReconnect({ session: deadRemote, state, guarded: false, enabled: true, now: 4_999 });
    expect(action).toEqual({ kind: 'skip', reason: 'not-due' });
  });

  it('emits again once the backoff window elapses', () => {
    const state = advanceBackoff(freshReconnectState(), 0); // nextEligibleAt = 5000
    const action = decideReconnect({ session: deadRemote, state, guarded: false, enabled: true, now: 5_000 });
    expect(action).toEqual({ kind: 'emit', attempt: 2 });
  });

  it('skips while a reconnect is already in flight (no stacked respawns)', () => {
    const state = { ...freshReconnectState(), inFlight: true };
    const action = decideReconnect({ session: deadRemote, state, guarded: false, enabled: true, now: 10_000 });
    expect(action).toEqual({ kind: 'skip', reason: 'in-flight' });
  });

  it('exhausts once the attempt cap is reached', () => {
    const state = { ...freshReconnectState(), attempts: MAX_RECONNECT_ATTEMPTS, nextEligibleAt: 0 };
    const action = decideReconnect({ session: deadRemote, state, guarded: false, enabled: true, now: 1_000_000 });
    expect(action).toEqual({ kind: 'exhaust' });
  });

  it('stays quiet after exhaustion has been recorded', () => {
    const state = { ...freshReconnectState(), attempts: MAX_RECONNECT_ATTEMPTS, exhausted: true };
    const action = decideReconnect({ session: deadRemote, state, guarded: false, enabled: true, now: 1_000_000 });
    expect(action).toEqual({ kind: 'skip', reason: 'exhausted' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (c) MANAGER integration — drive ticks with a stubbed pane-death + clock
// ────────────────────────────────────────────────────────────────────────────

describe('TmuxManager remote reconnect watcher (integration)', () => {
  let manager: TmuxManager;

  beforeEach(() => {
    manager = new TmuxManager();
  });

  function registerRemote(sessionId: string): void {
    manager.registerSession({
      sessionId,
      muxName: `codeman-${sessionId}`,
      pid: 4242,
      createdAt: Date.now(),
      workingDir: '/home/aakhter',
      mode: 'shell',
      attached: true,
      remote: REMOTE,
    });
  }

  it('emits remoteSessionDropped when a dead remote pane is observed, then backs off and exhausts', () => {
    registerRemote('aaaa1111');
    // Force the watcher to see a dead pane regardless of test-mode isPaneDead.
    vi.spyOn(manager, 'isPaneDead').mockReturnValue(true);
    // The durable remote tmux is still alive (transport drop) → reconnect allowed.
    (manager as unknown as { remoteAliveCache: Map<string, boolean | undefined> }).remoteAliveCache.set(
      'aaaa1111',
      true
    );

    const dropped: Array<{ sessionId: string; attempt: number }> = [];
    const exhausted: Array<{ sessionId: string }> = [];
    manager.on('remoteSessionDropped', (d) => dropped.push(d));
    manager.on('remoteReconnectExhausted', (d) => exhausted.push(d));

    // Drive ticks with a controllable clock. Each emit marks the session
    // in-flight; a failed reattach (host still down) releases it via
    // noteRemoteReconnect(false), mirroring the real server loop.
    let now = 0;
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS + 3; i++) {
      manager.runRemoteReconnectTick(now, /* enabled */ true);
      manager.noteRemoteReconnect('aaaa1111', false); // reattach failed → clear in-flight
      // jump the clock past the just-scheduled backoff window
      now += BACKOFF_SCHEDULE_MS[Math.min(i, BACKOFF_SCHEDULE_MS.length - 1)] + 1;
    }

    expect(dropped.map((d) => d.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(dropped.every((d) => d.sessionId === 'aaaa1111')).toBe(true);
    expect(exhausted).toEqual([{ sessionId: 'aaaa1111' }]); // fired exactly once
  });

  it('emits nothing for a guarded (intentionally killed) session', () => {
    registerRemote('bbbb2222');
    vi.spyOn(manager, 'isPaneDead').mockReturnValue(true);
    manager.guardRemoteReconnect('bbbb2222'); // simulate killSession/detach guard

    const dropped: unknown[] = [];
    manager.on('remoteSessionDropped', (d) => dropped.push(d));

    let now = 0;
    for (let i = 0; i < 5; i++) {
      manager.runRemoteReconnectTick(now, true);
      now += 600_000;
    }
    expect(dropped).toEqual([]);
  });

  it('resets backoff on a successful reattach (noteRemoteReconnect)', () => {
    registerRemote('cccc3333');
    vi.spyOn(manager, 'isPaneDead').mockReturnValue(true);
    (manager as unknown as { remoteAliveCache: Map<string, boolean | undefined> }).remoteAliveCache.set(
      'cccc3333',
      true
    );

    const dropped: Array<{ attempt: number }> = [];
    manager.on('remoteSessionDropped', (d) => dropped.push(d));

    manager.runRemoteReconnectTick(0, true); // emit attempt 1
    manager.noteRemoteReconnect('cccc3333', true); // reattach succeeded → reset
    manager.runRemoteReconnectTick(1, true); // immediately eligible again → attempt 1

    expect(dropped.map((d) => d.attempt)).toEqual([1, 1]);
  });

  it('does nothing when the kill-switch (enabled=false) is off', () => {
    registerRemote('dddd4444');
    vi.spyOn(manager, 'isPaneDead').mockReturnValue(true);
    const dropped: unknown[] = [];
    manager.on('remoteSessionDropped', (d) => dropped.push(d));

    manager.runRemoteReconnectTick(0, false);
    expect(dropped).toEqual([]);
  });

  it('clears per-session reconnect/guard state when the session is removed', () => {
    registerRemote('eeee5555');
    manager.guardRemoteReconnect('eeee5555');
    manager.clearRemoteReconnectState('eeee5555');
    // After clearing the guard, a fresh dead-pane observation should emit again.
    vi.spyOn(manager, 'isPaneDead').mockReturnValue(true);
    (manager as unknown as { remoteAliveCache: Map<string, boolean | undefined> }).remoteAliveCache.set(
      'eeee5555',
      true
    );
    const dropped: unknown[] = [];
    manager.on('remoteSessionDropped', (d) => dropped.push(d));
    manager.runRemoteReconnectTick(0, true);
    expect(dropped).toEqual([{ sessionId: 'eeee5555', attempt: 1 }]);
  });
});
