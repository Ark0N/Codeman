/**
 * @fileoverview Tests for boundedPathExists (src/utils/bounded-path-probe.ts):
 * a stat() that never settles (an unreachable hard network mount) must not hold
 * the caller past the timeout, must not be re-issued while it is still pending,
 * and must not let stalled probes pile up in libuv's shared threadpool.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  default: { stat: vi.fn() },
}));

import fs from 'node:fs/promises';
import { boundedPathExists, PROBE_TIMEOUT_MS } from '../src/utils/bounded-path-probe.js';

const stat = vi.mocked(fs.stat);

/**
 * Make the first stat() of each given path hang until released (the mount is
 * down); every later stat, and every other path, answers "exists".
 */
function hangOn(paths: string[]): Map<string, () => void> {
  const releases = new Map<string, () => void>();
  stat.mockImplementation((path) => {
    if (!paths.includes(String(path)) || releases.has(String(path))) return Promise.resolve({} as never);
    return new Promise((resolve) => {
      releases.set(String(path), () => resolve({} as never));
    });
  });
  return releases;
}

afterEach(() => {
  vi.useRealTimers();
  stat.mockReset();
});

describe('boundedPathExists', () => {
  it('reports an existing path as present and a missing one as absent', async () => {
    stat.mockImplementation(async (path) => {
      if (String(path) === '/present') return {} as never;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(await boundedPathExists('/present')).toBe(true);
    expect(await boundedPathExists('/missing')).toBe(false);
  });

  it('answers false after the timeout when stat never settles, and does not re-probe until it does', async () => {
    vi.useFakeTimers();
    const releases = hangOn(['/mnt/stalled/case']);

    const result = boundedPathExists('/mnt/stalled/case');
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(await result).toBe(false);

    // A second caller gets the cached verdict immediately, without another stat.
    expect(await boundedPathExists('/mnt/stalled/case')).toBe(false);
    expect(stat).toHaveBeenCalledTimes(1);

    // Once the mount answers, the path is probed afresh.
    releases.get('/mnt/stalled/case')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(await boundedPathExists('/mnt/stalled/case')).toBe(true);
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight stat between concurrent callers of the same path', async () => {
    const releases = hangOn(['/slow']);
    const a = boundedPathExists('/slow');
    const b = boundedPathExists('/slow');
    expect(stat).toHaveBeenCalledTimes(1);
    releases.get('/slow')!();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
  });

  it('does not give concurrent healthy probes a false negative', async () => {
    stat.mockImplementation(async () => ({}) as never);
    const results = await Promise.all(['/a', '/b', '/c', '/d', '/e'].map((p) => boundedPathExists(p)));
    expect(results).toEqual([true, true, true, true, true]);
  });

  it('stops issuing new stats once stalled probes would tie up the threadpool', async () => {
    vi.useFakeTimers();
    const releases = hangOn(['/mnt/stalled/one', '/mnt/stalled/two']);

    const first = boundedPathExists('/mnt/stalled/one');
    const second = boundedPathExists('/mnt/stalled/two');
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(await first).toBe(false);
    expect(await second).toBe(false);

    // Both slots are held by stats that never returned: refuse a third.
    expect(await boundedPathExists('/healthy/three')).toBe(false);
    expect(stat).toHaveBeenCalledTimes(2);

    // Once the stalled stats settle, probing resumes normally.
    releases.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
    expect(await boundedPathExists('/healthy/three')).toBe(true);
    expect(stat).toHaveBeenCalledTimes(3);
  });
});
