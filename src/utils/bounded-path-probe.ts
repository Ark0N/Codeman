/**
 * @fileoverview Bounded existence probe for user-chosen paths.
 *
 * A linked case can live on a network mount (NFS, SMB, sshfs). When that mount
 * goes unreachable, a hard mount makes `stat()` wait forever. A synchronous
 * probe (`existsSync`) on such a path blocks the event loop and freezes the
 * whole web server; even an async `stat()` never settles and permanently holds
 * one of libuv's few threadpool workers, which every other `fs`, `dns.lookup`
 * and `crypto` call in the process shares.
 *
 * `boundedPathExists()` therefore:
 * - probes asynchronously and answers `false` after `PROBE_TIMEOUT_MS`, so a
 *   request never waits on a dead mount for longer than that;
 * - shares one in-flight probe per path, and keeps answering `false` for a path
 *   whose probe timed out until that probe finally settles (so a dead path is
 *   not re-probed on every request, and is re-probed once the mount recovers);
 * - stops starting new probes once `MAX_STALLED_PROBES` timed-out probes are
 *   still pending, so stalled stats cannot drain the threadpool. Probes that are
 *   merely in flight do not count, so concurrent healthy probes never get a
 *   false negative.
 *
 * Like `existsSync`, it follows symlinks and reports any error as "absent". It
 * is meant for READ decisions (is it there, show it or not). A writer that must
 * tell "missing" apart from "unreachable" should not treat its `false` as
 * permission to create or overwrite anything.
 *
 * @module utils/bounded-path-probe
 */

import fs from 'node:fs/promises';

/** How long a caller waits for one probe before treating the path as absent. */
export const PROBE_TIMEOUT_MS = 1_500;
/** Timed-out probes allowed to remain pending before new probes are refused. */
export const MAX_STALLED_PROBES = 2;

const inFlight = new Map<string, Promise<boolean>>();
const stalled = new Set<string>();

async function statExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve whether `path` exists without letting an unresponsive filesystem
 * block the caller for longer than `PROBE_TIMEOUT_MS`.
 */
export async function boundedPathExists(path: string): Promise<boolean> {
  if (stalled.has(path)) return false;

  let probe = inFlight.get(path);
  if (!probe) {
    if (stalled.size >= MAX_STALLED_PROBES) return false;
    probe = statExists(path);
    inFlight.set(path, probe);
    void probe.finally(() => {
      inFlight.delete(path);
      stalled.delete(path);
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          if (inFlight.get(path) === probe) stalled.add(path);
          resolve(false);
        }, PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
