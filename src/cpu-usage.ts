/**
 * @fileoverview The header CPU reading: CPU use over all cores since the previous reading, from each core's
 * busy and idle time as `os.cpus()` reports it (the kernel's per-core counters on Linux, macOS and Windows).
 *
 * It replaces the 1-minute load average divided by the core count. Load counts runnable tasks, not busy time,
 * so a host with bursty short-lived processes, or a VM whose vCPU threads count as runnable, read 100% while
 * most of its cores were idle.
 */
import type { CpuInfo } from 'node:os';

/** Readings closer together than this reuse the last value, so several open browsers never shrink the window. */
export const CPU_USAGE_MIN_WINDOW_MS = 1000;

interface CpuTimes {
  busy: number;
  total: number;
  at: number;
}

/**
 * A meter that answers the CPU use, 0 to 100, between this reading and the previous one. Without usable core
 * times (none reported, or counters that went backwards, as when a core goes offline) it answers the last
 * reading, else `fallback()`. The first reading covers the time since the meter was created.
 */
export function createCpuUsageMeter(
  readCores: () => Pick<CpuInfo, 'times'>[],
  clock: () => number,
  fallback: () => number
): () => number {
  const sample = (): CpuTimes => {
    let busy = 0;
    let total = 0;
    for (const { times } of readCores()) {
      const all = times.user + times.nice + times.sys + times.idle + times.irq;
      total += all;
      busy += all - times.idle;
    }
    return { busy, total, at: clock() };
  };
  let base = sample();
  let last: number | undefined;
  return () => {
    const now = sample();
    if (last !== undefined && now.at - base.at < CPU_USAGE_MIN_WINDOW_MS) return last;
    const busy = now.busy - base.busy;
    const total = now.total - base.total;
    base = now;
    if (!(total > 0) || busy < 0) return last ?? fallback();
    last = Math.min(100, Math.max(0, Math.round((busy / total) * 100)));
    return last;
  };
}
