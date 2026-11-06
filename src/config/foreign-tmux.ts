/**
 * @fileoverview Bounds for FOREIGN tmux discovery (sessions a human started
 * outside Codeman).
 *
 * Two facts drive every number here. First, the number of tmux sockets and panes
 * on a machine is NOT under Codeman's control, so a discovery walk with no ceiling
 * is an unbounded loop over data someone else produces. Parsed rows are capped by
 * count and the socket sweep by time: a sweep capped by count would stop in glob
 * order, where `codeman*` sorts before `default` and a machine running many
 * instances would never reach the sessions this feature is for. Second, an ssh
 * handshake is an order of magnitude slower than
 * a local `exec`; reusing the shared 5s `EXEC_TIMEOUT_MS` would classify every
 * remote host as unreachable, so the probe gets its own timeout.
 *
 * @module config/foreign-tmux
 */

/** How often the browser re-polls `/api/mux/foreign` while the home screen is visible. */
export const FOREIGN_POLL_INTERVAL_MS = 8000;

/**
 * Server-side cache TTL for a LOCAL scan. This, not the poll interval, is what
 * bounds the real cost: N open tabs polling at 8s still trigger at most one scan
 * per TTL.
 */
export const FOREIGN_CACHE_TTL_MS = 5000;

/** Timeout for one probe invocation (local exec, `docker exec`, or one ssh). */
export const FOREIGN_PROBE_TIMEOUT_MS = 12000;

/**
 * How long one tmux server may take to answer the probe's ping, in the script's own
 * `sleep`, so whole seconds. A healthy server takes milliseconds. One that misses this
 * costs only its own rows, and the sweep moves on to the next socket.
 */
export const FOREIGN_SOCKET_TIMEOUT_SECONDS = 2;

/** How long a timed-out probe's process group gets on SIGTERM before SIGKILL. */
export const FOREIGN_PROBE_KILL_GRACE_MS = 2000;

/** Max pane rows parsed from one probe. Panes past this are dropped, not errors. */
export const FOREIGN_MAX_PANES = 400;

/** Max process rows parsed from one probe's `ps` snapshot. */
export const FOREIGN_MAX_PROCS = 4000;

/** Max bytes of probe stdout kept. A runaway `ps` must not become a heap problem. */
export const FOREIGN_PROBE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Longest argv or pane command kept from one row. The caps above bound how many rows a
 * probe carries, this bounds what one costs: a row is text from someone else's process,
 * and `ps` prints a 128 KiB argv in full. A launcher that needed more than this to be
 * recognised reads as `shell`, which only changes the label on its row.
 */
export const FOREIGN_MAX_ARGV_CHARS = 4096;
