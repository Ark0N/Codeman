/**
 * @fileoverview Unit tests for the blocking-wait registry that backs the agent
 * wait primitives (`GET /api/sessions/:id/wait`, `.../wait-output`, and the
 * `wait` field on `POST .../input`). Plan: `docs/agent-control-plan.md`.
 *
 * The registry holds no IO and no Session reference, so everything here runs
 * against real (short) timers with no mocks beyond one clearTimeout spy.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SessionWaitRegistry,
  WaitCapacityError,
  hooksAvailableForMode,
  blockedSignalAvailable,
  parseWaitSignals,
  resolveWaitSignals,
  signalForStatus,
  DEFAULT_WAIT_SIGNALS,
  WAIT_SIGNALS,
} from '../src/web/session-wait-registry.js';
import type { SessionMode } from '../src/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('parseWaitSignals', () => {
  it('parses a comma-separated string', () => {
    expect(parseWaitSignals('stop,idle')).toEqual({ signals: ['stop', 'idle'], invalid: [] });
  });

  it('parses an array, including comma-joined entries', () => {
    expect(parseWaitSignals(['stop', 'idle,exit'])).toEqual({
      signals: ['stop', 'idle', 'exit'],
      invalid: [],
    });
  });

  it('trims and lowercases', () => {
    expect(parseWaitSignals('  STOP , Idle ')).toEqual({ signals: ['stop', 'idle'], invalid: [] });
  });

  it('dedups, first occurrence wins', () => {
    expect(parseWaitSignals('idle,stop,idle')).toEqual({ signals: ['idle', 'stop'], invalid: [] });
  });

  it('reports invalid tokens instead of silently dropping them', () => {
    // The whole point: a typo must surface as a 400, never as "waiting for the default".
    const parsed = parseWaitSignals('stop,stpo,done');
    expect(parsed.signals).toEqual(['stop']);
    expect(parsed.invalid).toEqual(['stpo', 'done']);
  });

  it('dedups invalid tokens too', () => {
    expect(parseWaitSignals('nope,nope').invalid).toEqual(['nope']);
  });

  it('returns empty for absent / non-string input', () => {
    expect(parseWaitSignals(undefined)).toEqual({ signals: [], invalid: [] });
    expect(parseWaitSignals(null)).toEqual({ signals: [], invalid: [] });
    expect(parseWaitSignals(42)).toEqual({ signals: [], invalid: [] });
    expect(parseWaitSignals('')).toEqual({ signals: [], invalid: [] });
    expect(parseWaitSignals(',, ,')).toEqual({ signals: [], invalid: [] });
  });

  it('accepts every documented signal', () => {
    expect(parseWaitSignals(WAIT_SIGNALS.join(','))).toEqual({
      signals: [...WAIT_SIGNALS],
      invalid: [],
    });
  });

  it('the default set is itself valid', () => {
    expect(parseWaitSignals(DEFAULT_WAIT_SIGNALS.join(','))).toEqual({
      signals: [...DEFAULT_WAIT_SIGNALS],
      invalid: [],
    });
  });

  it('the default set includes exit, so a crashed worker never burns the full timeout', () => {
    expect(DEFAULT_WAIT_SIGNALS).toContain('exit');
  });
});

describe('signalForStatus', () => {
  it('maps live statuses', () => {
    expect(signalForStatus('idle')).toBe('idle');
    expect(signalForStatus('busy')).toBe('working');
  });

  it('maps both dead statuses to exit, so a caller that sees one does not hang', () => {
    // Narrower than it looks, and the JSDoc says so: a PTY that merely exits parks the
    // session at 'idle', so 'stopped' is reached only on a spawn failure or an explicit
    // stop(killMux:true). This mapping is right; it is not a liveness check.
    expect(signalForStatus('stopped')).toBe('exit');
    expect(signalForStatus('error')).toBe('exit');
  });

  it('cannot distinguish a finished session from a dead one', () => {
    // Pinning the documented limitation: both PTY onExit handlers set 'idle', so this
    // is what a caller sees for a crashed worker. Liveness must come from elsewhere.
    expect(signalForStatus('idle')).toBe('idle');
  });
});

describe('blockedSignalAvailable', () => {
  it('is true where hooks report it, and for a CLI that declares a blockedLine (codex)', () => {
    expect(blockedSignalAvailable('claude')).toBe(true);
    expect(blockedSignalAvailable('codex')).toBe(true);
    // Not keyed on hooks: codex has none, and its screen-read dialogs are still a source.
    expect(hooksAvailableForMode('codex')).toBe(false);
  });

  it('is false for a CLI with neither (shell, gemini, opencode)', () => {
    for (const mode of ['shell', 'gemini', 'opencode'] as const) {
      expect(blockedSignalAvailable(mode)).toBe(false);
    }
  });

  it('follows the per-session deepseek bridge, which is its only source', () => {
    expect(blockedSignalAvailable('deepseek')).toBe(true);
    expect(blockedSignalAvailable('deepseek', { deepSeekStatusReporting: false })).toBe(false);
  });
});

describe('hooksAvailableForMode', () => {
  it('is true only for claude', () => {
    expect(hooksAvailableForMode('claude')).toBe(true);
  });

  it('is false for shell, which installs no hooks despite not being an external CLI', () => {
    // The bug this replaced keyed off isExternalCliMode(), which excludes shell, so
    // until=stop on a bash PTY was accepted and then blocked for the full timeout.
    expect(hooksAvailableForMode('shell')).toBe(false);
  });

  it('is false for every external CLI mode', () => {
    for (const mode of ['opencode', 'codex', 'gemini', 'antigravity'] as const) {
      expect(hooksAvailableForMode(mode)).toBe(false);
    }
  });
});

describe('resolveWaitSignals', () => {
  const claude = { mode: 'claude' as SessionMode };
  const codex = { mode: 'codex' as SessionMode };
  const shell = { mode: 'shell' as SessionMode };

  it('returns the explicit set for a normal request', () => {
    expect(resolveWaitSignals('stop,exit', claude)).toEqual({ until: ['stop', 'exit'], error: null });
  });

  it('falls back to the default set when nothing is asked for', () => {
    expect(resolveWaitSignals(undefined, claude)).toEqual({ until: ['stop', 'idle', 'exit'], error: null });
    // `wait: true` on the input route arrives here as undefined, same path.
    expect(resolveWaitSignals('', claude).until).toEqual(['stop', 'idle', 'exit']);
  });

  it('errors on an unknown token rather than silently defaulting', () => {
    const result = resolveWaitSignals('stop,stpo', claude);
    expect(result.until).toEqual([]);
    expect(result.error).toContain('stpo');
    expect(result.error).toContain('idle, working, stop, blocked, exit');
  });

  it('errors when a hook-only signal is asked for EXPLICITLY on an external CLI', () => {
    const result = resolveWaitSignals('stop', codex);
    expect(result.until).toEqual([]);
    expect(result.error).toContain('codex');
    expect(resolveWaitSignals('idle,stop', codex).error).toBeTruthy();
    // gemini declares no blockedLine, so nothing can ever raise `blocked` for it.
    expect(resolveWaitSignals('blocked', { mode: 'gemini' as SessionMode }).error).toBeTruthy();
  });

  it('accepts `blocked` on codex, whose dialogs are read off the screen, but still not `stop`', () => {
    // capabilities.workDetect.blockedLine gives codex a source for `blocked`; nothing on a
    // screen says a turn ended, so `stop` keeps its 400.
    expect(resolveWaitSignals('blocked', codex)).toEqual({ until: ['blocked'], error: null });
    expect(resolveWaitSignals('idle,blocked,exit', codex)).toEqual({ until: ['idle', 'blocked', 'exit'], error: null });
    const stop = resolveWaitSignals('stop,blocked', codex);
    expect(stop.until).toEqual([]);
    expect(stop.error).toContain('stop');
    expect(stop.error).not.toContain('Signal(s) stop, blocked');
    // The suggestion names what does fire for codex.
    expect(stop.error).toContain('idle, blocked or exit');
  });

  it('drops hook-only signals from the DEFAULT set instead of erroring', () => {
    // Omitting the parameter must never 400, whatever the mode.
    expect(resolveWaitSignals(undefined, codex)).toEqual({ until: ['idle', 'exit'], error: null });
  });

  it('still allows the supported signals explicitly on an external CLI', () => {
    expect(resolveWaitSignals('idle,exit', codex)).toEqual({ until: ['idle', 'exit'], error: null });
  });

  it('reports an unknown token even when the mode would also reject', () => {
    // Validity is checked before mode support, so the message names the typo.
    expect(resolveWaitSignals('stpo,stop', codex).error).toContain('stpo');
  });

  it('rejects hook-only signals on a SHELL session too', () => {
    // A shell session is a plain bash PTY with no Claude Code hooks, so `stop` can
    // never arrive; accepting it was a guaranteed ten-minute hold by construction.
    const result = resolveWaitSignals('stop', shell);
    expect(result.until).toEqual([]);
    expect(result.error).toContain('shell');
    expect(resolveWaitSignals('blocked', shell).error).toBeTruthy();
  });

  it('drops hook-only signals from the DEFAULT set for shell, without erroring', () => {
    expect(resolveWaitSignals(undefined, shell)).toEqual({ until: ['idle', 'exit'], error: null });
  });

  it('names the mode in the rejection so the caller can see why', () => {
    expect(resolveWaitSignals('stop', codex).error).toContain('codex');
    expect(resolveWaitSignals('stop', { mode: 'gemini' as SessionMode }).error).toContain('gemini');
  });
});

describe('SessionWaitRegistry: signal waits', () => {
  it('resolves immediately when the session is already in a requested state', async () => {
    const reg = new SessionWaitRegistry();
    const result = await reg.waitForSignal('s1', {
      until: ['idle'],
      timeoutMs: 5000,
      currentSignal: 'idle',
    });
    expect(result).toEqual({
      signal: 'idle',
      timedOut: false,
      immediate: true,
      ended: false,
      aborted: false,
      waitedMs: 0,
      timeoutMs: 5000,
    });
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('does not resolve immediately when the current signal was not requested', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', {
      until: ['stop'],
      timeoutMs: 5000,
      currentSignal: 'idle',
    });
    expect(reg.signalWaiterCount('s1')).toBe(1);
    reg.notifySignal('s1', 'stop');
    expect((await promise).signal).toBe('stop');
  });

  it('requireTransition ignores the current state and waits for the next one', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', {
      until: ['idle'],
      timeoutMs: 5000,
      currentSignal: 'idle',
      requireTransition: true,
    });
    expect(reg.signalWaiterCount('s1')).toBe(1);

    const result = await Promise.resolve().then(() => {
      reg.notifySignal('s1', 'idle');
      return promise;
    });
    expect(result.signal).toBe('idle');
    expect(result.immediate).toBe(false);
  });

  it('resolves on the first of several requested signals', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', { until: ['stop', 'blocked'], timeoutMs: 5000 });
    reg.notifySignal('s1', 'blocked');
    const result = await promise;
    expect(result.signal).toBe('blocked');
    expect(result.timedOut).toBe(false);
    expect(result.ended).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('ignores signals that were not requested', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    expect(reg.notifySignal('s1', 'working')).toBe(0);
    expect(reg.notifySignal('s1', 'idle')).toBe(0);
    expect(reg.signalWaiterCount('s1')).toBe(1);
    reg.notifySignal('s1', 'stop');
    expect((await promise).signal).toBe('stop');
  });

  it('ignores signals for other sessions', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    expect(reg.notifySignal('s2', 'stop')).toBe(0);
    expect(reg.signalWaiterCount('s1')).toBe(1);
    reg.notifySignal('s1', 'stop');
    await promise;
  });

  it('wakes every waiter that asked for the signal, and only those', async () => {
    const reg = new SessionWaitRegistry();
    const a = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    const b = reg.waitForSignal('s1', { until: ['stop', 'idle'], timeoutMs: 5000 });
    const c = reg.waitForSignal('s1', { until: ['exit'], timeoutMs: 5000 });
    expect(reg.signalWaiterCount('s1')).toBe(3);

    expect(reg.notifySignal('s1', 'stop')).toBe(2);
    expect((await a).signal).toBe('stop');
    expect((await b).signal).toBe('stop');
    expect(reg.signalWaiterCount('s1')).toBe(1);

    reg.notifySignal('s1', 'exit');
    expect((await c).signal).toBe('exit');
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('times out without erroring, and reports it as a normal outcome', async () => {
    const reg = new SessionWaitRegistry();
    const result = await reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.ended).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('an empty until set can only time out', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', { until: [], timeoutMs: 20 });
    expect(reg.notifySignal('s1', 'stop')).toBe(0);
    expect((await promise).timedOut).toBe(true);
  });

  it('cancelAll resolves pending waiters with ended, never leaving them hanging', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    expect(reg.cancelAll('s1')).toBe(1);
    const result = await promise;
    expect(result.ended).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('honors the exit-before-cancel ordering contract', async () => {
    // The wiring must notify 'exit' BEFORE cancelAll, so an until=exit caller sees
    // the signal rather than a bare ended.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', { until: ['exit'], timeoutMs: 5000 });
    reg.notifySignal('s1', 'exit');
    expect(reg.cancelAll('s1')).toBe(0);
    const result = await promise;
    expect(result.signal).toBe('exit');
    expect(result.ended).toBe(false);
  });

  it('clears the timer when a signal resolves the wait', async () => {
    const reg = new SessionWaitRegistry();
    const spy = vi.spyOn(globalThis, 'clearTimeout');
    const before = spy.mock.calls.length;
    const promise = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    reg.notifySignal('s1', 'stop');
    await promise;
    expect(spy.mock.calls.length).toBeGreaterThan(before);
    spy.mockRestore();
  });

  it('echoes the effective timeout on every outcome', async () => {
    // A caller that asked for 30 minutes and got 600s must be able to SEE that, or it
    // reads the timeout as a stalled worker and kills a session that was fine.
    const reg = new SessionWaitRegistry();
    expect((await reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 20 })).timeoutMs).toBe(20);

    const signalled = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 4321 });
    reg.notifySignal('s1', 'stop');
    expect((await signalled).timeoutMs).toBe(4321);

    const cancelled = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 777 });
    reg.cancelAll('s1');
    expect((await cancelled).timeoutMs).toBe(777);
  });
});

describe('SessionWaitRegistry: cancellation', () => {
  it('frees the slot as soon as the caller hangs up', async () => {
    // The whole point: the response can no longer be sent, so holding the waiter for
    // the rest of its timeout only denies the pool to somebody else.
    const reg = new SessionWaitRegistry();
    const controller = new AbortController();
    const promise = reg.waitForSignal('s1', {
      until: ['stop'],
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    expect(reg.signalWaiterCount('s1')).toBe(1);

    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.ended).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('frees an output waiter the same way', async () => {
    const reg = new SessionWaitRegistry();
    const controller = new AbortController();
    const promise = reg.waitForOutput('s1', {
      match: 'never',
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    expect(reg.outputWaiterCount('s1')).toBe(1);

    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.ended).toBe(true);
    expect(result.matched).toBe(false);
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('registers nothing at all when the signal is already aborted', () => {
    const reg = new SessionWaitRegistry();
    const controller = new AbortController();
    controller.abort();
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 60_000, abortSignal: controller.signal });
    void reg.waitForOutput('s1', { match: 'x', timeoutMs: 60_000, abortSignal: controller.signal });
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('an already-aborted caller is never rejected for capacity', async () => {
    // It takes no slot, so refusing it would be a lie AND would cost the caller a
    // retry it cannot act on.
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 1, maxWaitersTotal: 1 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 60_000 });
    const controller = new AbortController();
    controller.abort();
    const result = await reg.waitForSignal('s1', {
      until: ['stop'],
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    reg.cancelEverything();
  });

  it('aborting an already-resolved waiter is a no-op', async () => {
    const reg = new SessionWaitRegistry();
    const controller = new AbortController();
    const promise = reg.waitForSignal('s1', {
      until: ['stop'],
      timeoutMs: 5000,
      abortSignal: controller.signal,
    });
    reg.notifySignal('s1', 'stop');
    const result = await promise;
    expect(result.signal).toBe('stop');

    controller.abort();
    await sleep(5);
    // The settled result is unchanged and no bookkeeping went negative.
    expect(result.aborted).toBe(false);
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('detaches its abort listener when the wait resolves another way', async () => {
    // A caller reusing one controller across a loop of waits must not accumulate
    // listeners on it for the life of the request.
    const reg = new SessionWaitRegistry();
    const controller = new AbortController();
    for (let i = 0; i < 5; i++) {
      const promise = reg.waitForSignal('s1', {
        until: ['stop'],
        timeoutMs: 5000,
        abortSignal: controller.signal,
      });
      reg.notifySignal('s1', 'stop');
      await promise;
    }
    // Node exposes the count only through the internal getter, so assert the effect:
    // nothing is registered and a late abort still changes nothing.
    controller.abort();
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('aborted is false on every non-abort outcome', async () => {
    const reg = new SessionWaitRegistry();
    expect((await reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 20 })).aborted).toBe(false);
    expect((await reg.waitForOutput('s1', { match: 'x', timeoutMs: 20 })).aborted).toBe(false);
    const immediate = await reg.waitForSignal('s1', { until: ['idle'], timeoutMs: 20, currentSignal: 'idle' });
    expect(immediate.aborted).toBe(false);
  });
});

describe('SessionWaitRegistry: shutdown latch', () => {
  it('refuses to register a new waiter once stopped, resolving ended instead', async () => {
    // server.stop() cancels waiters well before app.close(), with several awaits in
    // between while the listener still accepts requests. A wait landing in that window
    // used to register a timer nothing would ever cancel and stall shutdown for the
    // full MAX_WAIT_MS.
    const reg = new SessionWaitRegistry();
    reg.stop();
    expect(reg.isStopped).toBe(true);

    const signal = await reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 600_000 });
    expect(signal.ended).toBe(true);
    expect(signal.timedOut).toBe(false);
    expect(signal.aborted).toBe(false);

    const output = await reg.waitForOutput('s1', { match: 'never', timeoutMs: 600_000 });
    expect(output.ended).toBe(true);
    expect(output.matched).toBe(false);

    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('stop() resolves the waiters that were already pending', async () => {
    const reg = new SessionWaitRegistry();
    const pending = [
      reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 600_000 }),
      reg.waitForOutput('s2', { match: 'never', timeoutMs: 600_000 }),
    ];
    expect(reg.stop()).toBe(2);
    for (const result of await Promise.all(pending)) expect(result.ended).toBe(true);
  });

  it('cancelEverything latches too, so the existing shutdown call site is covered', async () => {
    const reg = new SessionWaitRegistry();
    reg.cancelEverything();
    expect(reg.isStopped).toBe(true);
    expect((await reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 600_000 })).ended).toBe(true);
  });

  it('a fresh registry is not stopped', () => {
    expect(new SessionWaitRegistry().isStopped).toBe(false);
  });
});

describe('SessionWaitRegistry: capacity', () => {
  it('rejects past the per-session cap with scope "session"', () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 2, maxWaitersTotal: 100 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });

    try {
      reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
      expect.unreachable('third wait should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(WaitCapacityError);
      expect((err as WaitCapacityError).scope).toBe('session');
    }

    // A different session is unaffected by another session's cap.
    expect(() => reg.waitForSignal('s2', { until: ['stop'], timeoutMs: 5000 })).not.toThrow();
    reg.cancelEverything();
  });

  it('rejects past the global cap with scope "total"', () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 10, maxWaitersTotal: 2 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    void reg.waitForSignal('s2', { until: ['stop'], timeoutMs: 5000 });

    try {
      reg.waitForSignal('s3', { until: ['stop'], timeoutMs: 5000 });
      expect.unreachable('third wait should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(WaitCapacityError);
      expect((err as WaitCapacityError).scope).toBe('total');
    }
    reg.cancelEverything();
  });

  it('counts both waiter kinds against the caps', () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 2, maxWaitersTotal: 100 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    void reg.waitForOutput('s1', { match: 'done', timeoutMs: 5000 });
    expect(reg.waiterCount('s1')).toBe(2);
    expect(() => reg.waitForOutput('s1', { match: 'x', timeoutMs: 5000 })).toThrow(WaitCapacityError);
    reg.cancelEverything();
  });

  it('frees capacity as waiters resolve', async () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 1, maxWaitersTotal: 100 });
    const first = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    expect(() => reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 })).toThrow(WaitCapacityError);
    reg.notifySignal('s1', 'stop');
    await first;
    expect(() => reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 })).not.toThrow();
    reg.cancelEverything();
  });

  it('an immediate resolve is never rejected by a full pool', async () => {
    // An already-satisfied wait holds no resource, so it must not be capacity-checked.
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 1, maxWaitersTotal: 1 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    const result = await reg.waitForSignal('s1', {
      until: ['idle'],
      timeoutMs: 5000,
      currentSignal: 'idle',
    });
    expect(result.immediate).toBe(true);
    reg.cancelEverything();
  });

  it('rejects past the per-owner cap with scope "owner", across sessions', () => {
    // One user must not be able to occupy the whole process-wide pool and deny the
    // primitive to everyone else, admin included.
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 10, maxWaitersPerOwner: 2, maxWaitersTotal: 100 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000, owner: 'alice' });
    void reg.waitForOutput('s2', { match: 'x', timeoutMs: 5000, owner: 'alice' });
    expect(reg.ownerWaiterCount('alice')).toBe(2);

    try {
      reg.waitForSignal('s3', { until: ['stop'], timeoutMs: 5000, owner: 'alice' });
      expect.unreachable('third wait should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(WaitCapacityError);
      expect((err as WaitCapacityError).scope).toBe('owner');
      expect((err as Error).message).toContain('owner');
    }

    // Another user is unaffected, which is the entire point.
    expect(() => reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000, owner: 'bob' })).not.toThrow();
    reg.cancelEverything();
  });

  it('ignores the owner cap when no owner is given (single-user mode)', () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 10, maxWaitersPerOwner: 1, maxWaitersTotal: 100 });
    for (let i = 0; i < 5; i++) {
      expect(() => reg.waitForSignal(`s${i}`, { until: ['stop'], timeoutMs: 5000 })).not.toThrow();
    }
    reg.cancelEverything();
  });

  it('frees owner capacity as waiters resolve, time out and abort', async () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 10, maxWaitersPerOwner: 3, maxWaitersTotal: 100 });
    const resolved = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000, owner: 'alice' });
    const timedOut = reg.waitForSignal('s2', { until: ['stop'], timeoutMs: 20, owner: 'alice' });
    const controller = new AbortController();
    const aborted = reg.waitForOutput('s3', {
      match: 'x',
      timeoutMs: 5000,
      owner: 'alice',
      abortSignal: controller.signal,
    });
    expect(reg.ownerWaiterCount('alice')).toBe(3);

    reg.notifySignal('s1', 'stop');
    controller.abort();
    await Promise.all([resolved, timedOut, aborted]);
    expect(reg.ownerWaiterCount('alice')).toBe(0);
    expect(() => reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000, owner: 'alice' })).not.toThrow();
    reg.cancelEverything();
  });

  it('does not double-release an owner slot when an abort races a resolve', async () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 10, maxWaitersPerOwner: 5, maxWaitersTotal: 100 });
    const held = reg.waitForSignal('s1', { until: ['exit'], timeoutMs: 5000, owner: 'alice' });
    const controller = new AbortController();
    const racing = reg.waitForSignal('s1', {
      until: ['stop'],
      timeoutMs: 5000,
      owner: 'alice',
      abortSignal: controller.signal,
    });
    reg.notifySignal('s1', 'stop');
    controller.abort();
    await racing;
    // A second release would have dropped the count to 0 and handed out a slot the
    // still-pending waiter is using.
    expect(reg.ownerWaiterCount('alice')).toBe(1);
    reg.cancelAll('s1');
    await held;
    expect(reg.ownerWaiterCount('alice')).toBe(0);
  });

  it('assertCapacity is public, so a route can refuse BEFORE doing expensive work', () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 1, maxWaitersTotal: 100 });
    expect(() => reg.assertCapacity('s1')).not.toThrow();
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    expect(() => reg.assertCapacity('s1')).toThrow(WaitCapacityError);
    reg.cancelEverything();
  });

  it('checks capacity BEFORE scanning initialText', async () => {
    // from=buffer hands us up to MAX_BUFFER_SCAN_BYTES that the route produced by
    // joining the whole 32MB accumulator. Paying that for a request about to be
    // refused turns the cap into an amplifier instead of a protection.
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 1, maxWaitersTotal: 100 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    expect(() =>
      reg.waitForOutput('s1', { match: 'PRESENT', timeoutMs: 5000, initialText: 'already PRESENT here' })
    ).toThrow(WaitCapacityError);
    reg.cancelEverything();
  });

  it('reports the scope in the message for every cap', () => {
    const reg = new SessionWaitRegistry({ maxWaitersPerSession: 1, maxWaitersPerOwner: 1, maxWaitersTotal: 2 });
    void reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000, owner: 'alice' });
    expect(() => reg.assertCapacity('s1', 'alice')).toThrow(/scope: owner/);
    expect(() => reg.assertCapacity('s1')).toThrow(/scope: session/);
    void reg.waitForSignal('s2', { until: ['stop'], timeoutMs: 5000 });
    expect(() => reg.assertCapacity('s3')).toThrow(/scope: total/);
    reg.cancelEverything();
  });
});

describe('SessionWaitRegistry: output waits', () => {
  it('matches a literal string in a chunk', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'BUILD OK', timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', 'running tests...\nBUILD OK\n')).toBe(1);
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.immediate).toBe(false);
    expect(result.snippet).toContain('BUILD OK');
  });

  it('strips ANSI before matching', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'BUILD OK', timeoutMs: 5000 });
    reg.notifyOutput('s1', '\x1b[32mBUILD\x1b[0m OK\n');
    expect((await promise).matched).toBe(true);
  });

  it('matches across a chunk boundary', async () => {
    // The carry buffer exists for exactly this: PTY chunking is arbitrary.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'BUILD OK', timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', 'tail of a line ... BUIL')).toBe(0);
    expect(reg.notifyOutput('s1', 'D OK and more')).toBe(1);
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.snippet).toContain('BUILD OK');
  });

  it('matches when an ANSI escape is SPLIT across two chunks', async () => {
    // A PTY read boundary lands inside an escape all the time under tmux. stripAnsi
    // needs a complete sequence, so the fragment used to survive the strip, land in
    // the carry and split the needle: the same output matched or not depending on
    // where the kernel cut the read.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'OK', timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', 'O\x1b[')).toBe(0);
    expect(reg.notifyOutput('s1', '0mK\n')).toBe(1);
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.snippet).toContain('OK');
  });

  it('matches when the escape is split at every offset inside the sequence', async () => {
    const sequence = '\x1b[1;32m';
    for (let cut = 1; cut < sequence.length; cut++) {
      const reg = new SessionWaitRegistry();
      const promise = reg.waitForOutput('s1', { match: 'DONE', timeoutMs: 5000 });
      reg.notifyOutput('s1', `DO${sequence.slice(0, cut)}`);
      reg.notifyOutput('s1', `${sequence.slice(cut)}NE`);
      expect((await promise).matched, `split after ${cut} chars`).toBe(true);
    }
  });

  it('matches when an OSC sequence is split across chunks', async () => {
    // tmux emits ESC ] 0 ; <title> ESC \ on every pane-title change, and the ST
    // terminator is itself an ESC, which a naive "last ESC is pending" rule mishandles.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'READY', timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', 'REA\x1b]0;some pane title')).toBe(0);
    expect(reg.notifyOutput('s1', '\x1b\\DY')).toBe(1);
    expect((await promise).matched).toBe(true);
  });

  it('matches when a charset-select escape is split across chunks', async () => {
    // ESC ( B is only removed once its FINAL byte arrives, so a cut between the '(' and
    // the 'B' smuggles an escape into the haystack: neither half is a complete sequence
    // on its own, and holding back only a lone trailing ESC does not cover it. This cut
    // point is the one the widened pending rule exists for.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'MARKER', timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', 'MAR\x1b(')).toBe(0);
    expect(reg.notifyOutput('s1', 'BKER')).toBe(1);
    expect((await promise).matched).toBe(true);
  });

  it('matches when a DCS string is split across chunks', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'ABCD', timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', 'AB\x1bPsome')).toBe(0);
    expect(reg.notifyOutput('s1', '-dcs\x1b\\CD')).toBe(1);
    expect((await promise).matched).toBe(true);
  });

  it('releases a held-back fragment that turns out not to be an escape', async () => {
    // A lone trailing ESC is withheld; if the next chunk shows it was never the start of
    // a sequence we remove, the text after it must still reach the haystack rather than
    // being withheld behind it.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'HELLO', timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', 'X\x1b')).toBe(0);
    expect(reg.notifyOutput('s1', '\nHELLO')).toBe(1);
    expect((await promise).matched).toBe(true);
  });

  it('does not withhold an unterminated escape forever', async () => {
    // An OSC that never terminates would otherwise stall every match on the session.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'MARKER', timeoutMs: 5000 });
    reg.notifyOutput('s1', `\x1b]0;${'x'.repeat(600)}`);
    reg.notifyOutput('s1', 'MARKER');
    expect((await promise).matched).toBe(true);
  });

  it('drops the held-back fragment when the last waiter goes away', async () => {
    const reg = new SessionWaitRegistry();
    const first = reg.waitForOutput('s1', { match: 'never', timeoutMs: 20 });
    reg.notifyOutput('s1', 'text\x1b[');
    await first;
    // Nothing per-session may outlive the waiter set. A leaked '\x1b[' would prefix
    // the next chunk and be stripped away together with the '0m' the needle wants.
    const next = reg.waitForOutput('s1', { match: '0mFOUND', timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', '0mFOUND')).toBe(1);
    expect((await next).matched).toBe(true);
  });

  it('does not re-match text already scanned in a previous chunk', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'zzz', timeoutMs: 30 });
    reg.notifyOutput('s1', 'aaa bbb ccc');
    reg.notifyOutput('s1', 'ddd eee fff');
    expect((await promise).timedOut).toBe(true);
  });

  it('honors nocase but reports the original-case text', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'build ok', nocase: true, timeoutMs: 5000 });
    reg.notifyOutput('s1', '>>> BUILD OK <<<');
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.snippet).toContain('BUILD OK');
  });

  it('is case-sensitive by default', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'build ok', timeoutMs: 30 });
    reg.notifyOutput('s1', 'BUILD OK');
    expect((await promise).timedOut).toBe(true);
  });

  it('keeps the nocase snippet on the match when lowercasing changes length', async () => {
    // 'İ' (U+0130) lowercases to TWO code units, so the index found in the lowercased
    // haystack is not an index into the original. With enough of them ahead of the
    // match the window slid clean off it and the snippet came back empty.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'done', nocase: true, timeoutMs: 5000 });
    reg.notifyOutput('s1', `${'\u0130'.repeat(200)}${'x'.repeat(300)} DONE marker`);
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.snippet).toContain('DONE marker');
  });

  it('reports original-case context around a length-shifted match', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'result', nocase: true, timeoutMs: 5000 });
    reg.notifyOutput('s1', `${'\u0130'.repeat(40)}before RESULT after`);
    const snippet = (await promise).snippet ?? '';
    expect(snippet).toContain('before RESULT after');
  });

  it('carries enough text for a nocase needle that lowercases longer than it is', async () => {
    // needleCmp, not needle, sizes the carry: a needle of 'İ' compares as two code
    // units, so two code units of pane output satisfy one needle character and a carry
    // measured from the original needle drops the straddle.
    const reg = new SessionWaitRegistry();
    const needle = '\u0130'.repeat(120);
    const printed = 'i\u0307'.repeat(120);
    const promise = reg.waitForOutput('s1', { match: needle, nocase: true, timeoutMs: 5000 });
    expect(reg.notifyOutput('s1', printed.slice(0, printed.length - 1))).toBe(0);
    expect(reg.notifyOutput('s1', printed.slice(printed.length - 1))).toBe(1);
    expect((await promise).matched).toBe(true);
  });

  it('scans initialText first and resolves immediately (from=buffer)', async () => {
    const reg = new SessionWaitRegistry();
    const result = await reg.waitForOutput('s1', {
      match: 'BUILD OK',
      timeoutMs: 5000,
      initialText: 'earlier output\n\x1b[32mBUILD OK\x1b[0m\n',
    });
    expect(result.matched).toBe(true);
    expect(result.immediate).toBe(true);
    expect(result.waitedMs).toBe(0);
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('carries the tail of initialText so a match can straddle buffer and stream', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', {
      match: 'BUILD OK',
      timeoutMs: 5000,
      initialText: 'stuff that ends with BUIL',
    });
    expect(reg.notifyOutput('s1', 'D OK')).toBe(1);
    expect((await promise).matched).toBe(true);
  });

  it('collapses blank runs in the snippet so pane padding does not eat the context', async () => {
    // A real pane pads with dozens of \r\n between the prompt and the output; without
    // collapsing, the whole 80-char context window is newlines.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'MARKER', timeoutMs: 5000 });
    reg.notifyOutput('s1', `prompt$${'\n\r'.repeat(30)}echo MARKER`);
    const snippet = (await promise).snippet ?? '';
    expect(snippet).toContain('echo MARKER');
    expect(snippet).not.toMatch(/[\r\n]{2}/);
    // Context on the far side of the padding survives the collapse.
    expect(snippet).toContain('prompt$');
  });

  it('matches across the charset-select escape a real bash prompt emits', async () => {
    // The E2E transcript: a stock prompt renders `arkon@tnode:~/dir$` and emits
    // `arkon@tnode\x1b(B\x1b[m:`. stripAnsi removes the CSI and leaves ESC ( B, so
    // `match=tnode:` failed on a prompt that plainly reads `tnode:` while `match=(B`
    // succeeded. Silent: a full-length timeout, no error anywhere.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'tnode:~/codeman-cases', timeoutMs: 5000 });
    reg.notifyOutput('s1', 'clear\narkon@tnode\x1b(B\x1b[m:~/codeman-cases/e2edocs-shell$ ');
    expect((await promise).matched).toBe(true);
  });

  it('leaves no charset residue in the snippet either', async () => {
    // The same defect seen from the other side: the ESC was removed but the literal
    // "(B" stayed as visible text in the snippet handed to the agent.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'MARKER', timeoutMs: 5000 });
    reg.notifyOutput('s1', 'arkon@tnode\x1b(B:/tmp/e2e\x1b(B$ MARKER done');
    const snippet = (await promise).snippet ?? '';
    expect(snippet).toContain('arkon@tnode:/tmp/e2e$ MARKER done');
    expect(snippet).not.toContain('(B');
  });

  it('matches across the other escape families stripAnsi does not know', async () => {
    const cases: Array<[string, string]> = [
      ['ESC c full reset', 'AB\x1bcCD'],
      ['ESC 7 / ESC 8 cursor save', 'AB\x1b7CD\x1b8'],
      ['ESC ( 0 line drawing', 'AB\x1b(0CD'],
      ['ESC # 8 DEC alignment', 'AB\x1b#8CD'],
      ['DCS string', 'AB\x1bPsome-dcs\x1b\\CD'],
      ['APC string', 'AB\x1b_Gfile=1\x1b\\CD'],
      ['PM string', 'AB\x1b^private\x1b\\CD'],
    ];
    for (const [label, printed] of cases) {
      const reg = new SessionWaitRegistry();
      const promise = reg.waitForOutput('s1', { match: 'ABCD', timeoutMs: 5000 });
      reg.notifyOutput('s1', printed);
      expect((await promise).matched, label).toBe(true);
    }
  });

  it('does not delete real output after an UNTERMINATED string sequence', async () => {
    // The terminator is required on purpose: a greedy match would swallow every byte to
    // the end of the window, which is the output an agent is waiting for.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'IMPORTANT', timeoutMs: 5000 });
    reg.notifyOutput('s1', `\x1bP${'x'.repeat(600)} IMPORTANT\n`);
    expect((await promise).matched).toBe(true);
  });

  it('leaves ordinary text alone', async () => {
    // The residue pass is anchored on ESC, so nothing without one can be eaten.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'a(B)c [0m ]0; #8 P^_', timeoutMs: 5000 });
    reg.notifyOutput('s1', 'literal a(B)c [0m ]0; #8 P^_ text');
    expect((await promise).matched).toBe(true);
  });

  it('never ships raw control bytes in the snippet', async () => {
    // stripAnsi handles three escape families and nothing else, so ESC ( B (real, seen
    // in a live bash pane) and ESC c (a full terminal reset) used to reach the calling
    // agent's own terminal through `jq -r .data.snippet`.
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'MARKER', timeoutMs: 5000 });
    reg.notifyOutput('s1', 'user@host\x1b(B:/tmp\x1bc \x07\x00MARKER\x1b(0qq done\n');
    const snippet = (await promise).snippet ?? '';
    expect(snippet).toContain('MARKER');
    expect(snippet).toContain('user@host');
    // eslint-disable-next-line no-control-regex
    expect(snippet).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
  });

  it('keeps ordinary whitespace in the snippet', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'MARKER', timeoutMs: 5000 });
    reg.notifyOutput('s1', 'col1\tcol2\nMARKER here');
    const snippet = (await promise).snippet ?? '';
    expect(snippet).toContain('col1\tcol2');
    expect(snippet).toContain('\n');
  });

  it('bounds the snippet around the match', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'NEEDLE', timeoutMs: 5000 });
    reg.notifyOutput('s1', `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}`);
    const snippet = (await promise).snippet ?? '';
    expect(snippet).toContain('NEEDLE');
    expect(snippet.length).toBeLessThan(300);
  });

  it('times out without erroring', async () => {
    const reg = new SessionWaitRegistry();
    const result = await reg.waitForOutput('s1', { match: 'never', timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(result.matched).toBe(false);
    expect(result.snippet).toBeNull();
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('cancelAll resolves output waiters with ended', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForOutput('s1', { match: 'never', timeoutMs: 5000 });
    expect(reg.cancelAll('s1')).toBe(1);
    const result = await promise;
    expect(result.ended).toBe(true);
    expect(result.matched).toBe(false);
  });

  it('notifyOutput is a no-op with no waiters', () => {
    const reg = new SessionWaitRegistry();
    expect(reg.notifyOutput('s1', 'anything at all')).toBe(0);
  });

  it('resolves only the waiters whose needle matched', async () => {
    const reg = new SessionWaitRegistry();
    const a = reg.waitForOutput('s1', { match: 'one', timeoutMs: 5000 });
    const b = reg.waitForOutput('s1', { match: 'two', timeoutMs: 5000 });
    expect(reg.outputWaiterCount('s1')).toBe(2);

    expect(reg.notifyOutput('s1', 'one')).toBe(1);
    expect((await a).matched).toBe(true);
    expect(reg.outputWaiterCount('s1')).toBe(1);

    expect(reg.notifyOutput('s1', 'two')).toBe(1);
    expect((await b).matched).toBe(true);
    expect(reg.totalWaiterCount()).toBe(0);
  });
});

describe('SessionWaitRegistry: teardown and leak prevention', () => {
  it('drops the per-session bookkeeping once the last waiter resolves', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 5000 });
    expect(reg.totalWaiterCount()).toBe(1);
    reg.notifySignal('s1', 'stop');
    await promise;
    expect(reg.signalWaiterCount('s1')).toBe(0);
    expect(reg.waiterCount('s1')).toBe(0);
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('a timed-out waiter is removed, not left in the map', async () => {
    const reg = new SessionWaitRegistry();
    await reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 20 });
    await reg.waitForOutput('s1', { match: 'x', timeoutMs: 20 });
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('cancelEverything resolves every waiter across every session', async () => {
    const reg = new SessionWaitRegistry();
    const promises = [
      reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 60_000 }),
      reg.waitForSignal('s2', { until: ['idle'], timeoutMs: 60_000 }),
      reg.waitForOutput('s2', { match: 'nope', timeoutMs: 60_000 }),
    ];
    expect(reg.totalWaiterCount()).toBe(3);
    expect(reg.cancelEverything()).toBe(3);

    const results = await Promise.all(promises);
    for (const result of results) expect(result.ended).toBe(true);
    expect(reg.totalWaiterCount()).toBe(0);
  });

  it('a resolved waiter is not re-settled when its timeout would have fired', async () => {
    const reg = new SessionWaitRegistry();
    const promise = reg.waitForSignal('s1', { until: ['stop'], timeoutMs: 25 });
    reg.notifySignal('s1', 'stop');
    const result = await promise;
    await sleep(60);
    expect(result.signal).toBe('stop');
    expect(result.timedOut).toBe(false);
    expect(reg.totalWaiterCount()).toBe(0);
  });
});
