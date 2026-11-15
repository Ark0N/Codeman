/**
 * @fileoverview The header CPU reading's meter: busy time over all cores between readings, the minimum window
 * that keeps several browsers from shrinking it, and the fallback when no usable core times exist.
 */
import { describe, expect, it } from 'vitest';
import { createCpuUsageMeter } from '../src/cpu-usage.js';

const core = (busy: number, idle: number) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

function meterOver(samples: ReturnType<typeof core>[][], fallback = () => 999) {
  let at = 0;
  let index = 0;
  const meter = createCpuUsageMeter(
    () => samples[Math.min(index, samples.length - 1)],
    () => at,
    fallback
  );
  return (ms: number) => {
    at += ms;
    index += 1;
    return meter();
  };
}

describe('createCpuUsageMeter', () => {
  it('reports busy time over all cores between readings', () => {
    const next = meterOver([
      [core(0, 0), core(0, 0)],
      [core(50, 50), core(50, 50)],
      [core(150, 50), core(50, 150)],
    ]);
    expect(next(2000)).toBe(50);
    expect(next(2000)).toBe(50);
  });

  it('counts nice, system and interrupt time as busy', () => {
    const times = (user: number, nice: number, sys: number, irq: number, idle: number) => ({
      times: { user, nice, sys, idle, irq },
    });
    const meter = createCpuUsageMeter(
      (() => {
        let calls = 0;
        return () => [calls++ === 0 ? times(0, 0, 0, 0, 0) : times(10, 20, 30, 15, 25)];
      })(),
      (() => {
        let at = 0;
        return () => (at += 2000);
      })(),
      () => 999
    );
    expect(meter()).toBe(75);
  });

  it('reads idle cores as idle however long the run queue is', () => {
    expect(meterOver([[core(0, 0)], [core(40, 60)]])(5000)).toBe(40);
  });

  it('reuses the last value for readings under a second apart and keeps the baseline', () => {
    const next = meterOver([[core(0, 0)], [core(30, 70)], [core(30, 170)], [core(130, 170)]]);
    expect(next(2000)).toBe(30);
    expect(next(200)).toBe(30);
    expect(next(2000)).toBe(50);
  });

  it('falls back without a bogus reading when there are no core times or the counters go backwards', () => {
    expect(meterOver([[], []], () => 7)(2000)).toBe(7);
    const next = meterOver([[core(100, 100)], [core(10, 10)], [core(60, 60)]], () => 7);
    expect(next(2000)).toBe(7);
    expect(next(2000)).toBe(50);
  });

  it('answers a whole number from 0 to 100', () => {
    expect(meterOver([[core(0, 0)], [core(2, 1)]])(2000)).toBe(67);
    expect(meterOver([[core(0, 0)], [core(0, 9)]])(2000)).toBe(0);
    expect(meterOver([[core(0, 0)], [core(9, 0)]])(2000)).toBe(100);
  });
});
