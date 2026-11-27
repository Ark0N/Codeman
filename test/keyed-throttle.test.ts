/**
 * @fileoverview KeyedThrottle (src/utils/keyed-throttle.ts), the per-key throttle behind the
 * server's `transcript:update` broadcast.
 *
 * Pinned: the first call sends at once, a burst inside the interval collapses into one trailing
 * send at the interval's end, the trailing send runs the newest send it was given, a call after
 * the interval sends at once, keys are independent, and cancelKey()/dispose() drop a pending
 * trailing send.
 *
 * Port: N/A
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyedThrottle } from '../src/utils/index.js';

describe('KeyedThrottle', () => {
  let throttle: KeyedThrottle;
  let sends: Array<{ key: string; at: number }>;
  const fire = (key: string) => throttle.fire(key, () => sends.push({ key, at: Date.now() }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    throttle = new KeyedThrottle(750);
    sends = [];
  });

  afterEach(() => {
    throttle.dispose();
    vi.useRealTimers();
  });

  it('sends the first call at once', () => {
    fire('a');
    expect(sends).toEqual([{ key: 'a', at: 10_000 }]);
  });

  it('collapses a burst into one trailing send at the end of the interval', () => {
    fire('a');
    vi.advanceTimersByTime(100);
    fire('a');
    fire('a');
    vi.advanceTimersByTime(300);
    fire('a');
    expect(sends).toHaveLength(1);
    vi.advanceTimersByTime(349);
    expect(sends).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sends).toEqual([
      { key: 'a', at: 10_000 },
      { key: 'a', at: 10_750 },
    ]);
    vi.advanceTimersByTime(5000);
    expect(sends).toHaveLength(2);
  });

  it('runs the newest send it was given when the trailing send fires', () => {
    const labels: string[] = [];
    throttle.fire('a', () => labels.push('first'));
    throttle.fire('a', () => labels.push('second'));
    throttle.fire('a', () => labels.push('third'));
    vi.advanceTimersByTime(750);
    expect(labels).toEqual(['first', 'third']);
  });

  it('sends at once again once the interval has passed', () => {
    fire('a');
    vi.advanceTimersByTime(800);
    fire('a');
    expect(sends.map((s) => s.at)).toEqual([10_000, 10_800]);
  });

  it('throttles each key on its own', () => {
    fire('a');
    fire('b');
    expect(sends.map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('drops a pending trailing send on cancelKey() and dispose()', () => {
    fire('a');
    fire('a');
    fire('b');
    fire('b');
    throttle.cancelKey('a');
    vi.advanceTimersByTime(1000);
    expect(sends.map((s) => s.key)).toEqual(['a', 'b', 'b']);

    fire('c');
    fire('c');
    throttle.dispose();
    vi.advanceTimersByTime(1000);
    expect(sends.map((s) => s.key)).toEqual(['a', 'b', 'b', 'c']);
  });
});
