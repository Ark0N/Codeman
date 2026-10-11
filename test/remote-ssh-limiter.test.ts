/**
 * @fileoverview Tests for the remote-file ssh concurrency limiter
 * (`src/remote-ssh-limiter.ts`): the cap holds under interleaved async resumption,
 * waiters are served FIFO, a task that throws still releases its slot, and a
 * bounded (`maxWaitMs`) waiter that times out neither runs nor leaks a slot.
 *
 * Port: N/A (no HTTP server).
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  getActiveRemoteSshCount,
  getQueuedRemoteSshCount,
  getRemoteSshLimit,
  RemoteSshSlotTimeoutError,
  runWithRemoteSshLimit,
} from '../src/remote-ssh-limiter.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('runWithRemoteSshLimit', () => {
  it('never lets more than the cap run at once, and queues the rest FIFO', async () => {
    const cap = getRemoteSshLimit();
    const gates = Array.from({ length: cap + 3 }, () => deferred());
    const started: number[] = [];
    let peak = 0;

    const runs = gates.map((gate, index) =>
      runWithRemoteSshLimit(async () => {
        started.push(index);
        peak = Math.max(peak, getActiveRemoteSshCount());
        await gate.promise;
        return index;
      })
    );
    await Promise.resolve();

    expect(started).toEqual(Array.from({ length: cap }, (_, i) => i));
    expect(getActiveRemoteSshCount()).toBe(cap);
    expect(getQueuedRemoteSshCount()).toBe(3);

    // Releasing one hands the slot to the OLDEST waiter; the count stays at the cap.
    gates[0].resolve();
    await runs[0];
    await Promise.resolve();
    expect(started).toEqual([...Array.from({ length: cap }, (_, i) => i), cap]);
    expect(getActiveRemoteSshCount()).toBe(cap);

    for (const gate of gates) gate.resolve();
    expect(await Promise.all(runs)).toEqual(gates.map((_, i) => i));
    expect(peak).toBe(cap);
    expect(getActiveRemoteSshCount()).toBe(0);
    expect(getQueuedRemoteSshCount()).toBe(0);
  });

  it('releases the slot when the task throws', async () => {
    await expect(runWithRemoteSshLimit(async () => Promise.reject(new Error('ssh exit 255')))).rejects.toThrow(
      'ssh exit 255'
    );
    expect(getActiveRemoteSshCount()).toBe(0);
    expect(await runWithRemoteSshLimit(async () => 'after')).toBe('after');
  });

  describe('maxWaitMs', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a waiter that times out leaves the queue, never runs, and takes no slot', async () => {
      vi.useFakeTimers();
      const cap = getRemoteSshLimit();
      const gates = Array.from({ length: cap }, () => deferred());
      const holders = gates.map((gate) => runWithRemoteSshLimit(() => gate.promise));
      await Promise.resolve();
      expect(getActiveRemoteSshCount()).toBe(cap);

      let ran = false;
      const bounded = runWithRemoteSshLimit(
        async () => {
          ran = true;
        },
        { maxWaitMs: 1500 }
      );
      const outcome = expect(bounded).rejects.toBeInstanceOf(RemoteSshSlotTimeoutError);
      // An unbounded waiter queued BEHIND it still gets the next slot.
      let laterRan = false;
      const later = runWithRemoteSshLimit(async () => {
        laterRan = true;
      });
      expect(getQueuedRemoteSshCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(1500);
      await outcome;
      expect(ran).toBe(false);
      expect(getQueuedRemoteSshCount()).toBe(1);
      expect(getActiveRemoteSshCount()).toBe(cap);

      gates[0].resolve();
      await later;
      expect(laterRan).toBe(true);
      expect(ran).toBe(false);

      for (const gate of gates) gate.resolve();
      await Promise.all(holders);
      expect(getActiveRemoteSshCount()).toBe(0);
      expect(getQueuedRemoteSshCount()).toBe(0);
    });

    it('a waiter handed a slot in time runs and releases normally', async () => {
      vi.useFakeTimers();
      const cap = getRemoteSshLimit();
      const gates = Array.from({ length: cap }, () => deferred());
      const holders = gates.map((gate) => runWithRemoteSshLimit(() => gate.promise));
      await Promise.resolve();

      const bounded = runWithRemoteSshLimit(async () => 'ran', { maxWaitMs: 1500 });
      await vi.advanceTimersByTimeAsync(1000);
      gates[0].resolve();
      expect(await bounded).toBe('ran');
      // The cancelled timer firing later must not disturb anything.
      await vi.advanceTimersByTimeAsync(1000);

      for (const gate of gates) gate.resolve();
      await Promise.all(holders);
      expect(getActiveRemoteSshCount()).toBe(0);
      expect(getQueuedRemoteSshCount()).toBe(0);
    });

    it('takes a free slot at once without starting a timer', async () => {
      expect(await runWithRemoteSshLimit(async () => 'free', { maxWaitMs: 0 })).toBe('free');
      expect(getActiveRemoteSshCount()).toBe(0);
    });
  });
});
