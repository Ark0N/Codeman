/**
 * @fileoverview Limits for the bounded path probe (`src/utils/bounded-path-probe.ts`).
 *
 * A linked case can live on a network mount, and a hard mount that went away makes
 * `stat()` wait until the mount comes back. The probe gives up on such a path after
 * `PATH_PROBE_TIMEOUT_MS` and answers "unknown", and it stops starting new probes
 * once `MAX_STALLED_PATH_PROBES` timed-out stats are still holding libuv threadpool
 * workers (the pool is shared by every `fs`, `dns.lookup` and `crypto` call in the
 * process, and holds 4 workers unless `UV_THREADPOOL_SIZE` says otherwise).
 *
 * Both are env-overridable, in the same style as the other config modules. A slow
 * but healthy mount (an sshfs that needs a couple of seconds on first touch) may want
 * a longer timeout. The stall limits follow `UV_THREADPOOL_SIZE` on their own, so a
 * server started with a larger pool gets a higher ceiling without further setup.
 *
 * @module config/path-probe
 */

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(min, Math.min(max, raw));
}

/** How long a caller waits for one path probe before the answer is "unknown". */
export const PATH_PROBE_TIMEOUT_MS = envInt('CODEMAN_PATH_PROBE_TIMEOUT_MS', 1_500, 100, 60_000);

/**
 * Hard ceiling on timed-out probes left pending, for every caller, `pastCap` ones
 * included: the threadpool size minus one, so a dead mount can never take the last
 * worker. libuv sizes the pool from `UV_THREADPOOL_SIZE` (4 when unset). A pool of
 * one cannot keep a worker free at all, so the ceiling never drops below one.
 */
export const PATH_PROBE_STALL_CEILING = Math.max(1, (Number(process.env.UV_THREADPOOL_SIZE) || 4) - 1);

/**
 * Timed-out probes allowed to stay pending before new BULK probes are refused
 * (answered "unknown" without a stat). This is a backstop, not the main defence: a
 * stalled path on a network or FUSE mount already takes the rest of that mount out
 * of probing (a stall anywhere else takes out only the stalled path), so the cap
 * only engages once that many UNRELATED places have stopped answering. It defaults
 * to one below {@link PATH_PROBE_STALL_CEILING} (2 with the default pool), leaving a
 * slot a `pastCap` probe may still use, and is never allowed above the ceiling.
 */
export const MAX_STALLED_PATH_PROBES = Math.min(
  PATH_PROBE_STALL_CEILING,
  envInt('CODEMAN_PATH_PROBE_MAX_STALLED', Math.max(1, PATH_PROBE_STALL_CEILING - 1), 1, 64)
);
