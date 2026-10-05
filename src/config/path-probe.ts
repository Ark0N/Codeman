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
 * a longer timeout; a server started with a larger `UV_THREADPOOL_SIZE` can afford a
 * higher stall cap.
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
 * Timed-out probes allowed to stay pending before new probes are refused (answered
 * "unknown" without a stat). This is a backstop, not the main defence: a stalled
 * path already takes its neighbours (same parent directory) out of probing, so the
 * cap only engages once three UNRELATED places have stopped answering. The default
 * leaves one of libuv's default four workers free for the rest of the process.
 */
export const MAX_STALLED_PATH_PROBES = envInt('CODEMAN_PATH_PROBE_MAX_STALLED', 3, 1, 64);
