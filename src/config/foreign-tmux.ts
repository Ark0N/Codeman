/**
 * @fileoverview Bounds for FOREIGN tmux discovery (sessions a human started
 * outside Codeman).
 *
 * Two facts drive every number here. First, the number of tmux sockets and panes
 * on a machine is NOT under Codeman's control — a discovery walk with no ceiling
 * is an unbounded loop over data someone else produces, so sockets and panes are
 * both hard-capped. Second, an ssh handshake is an order of magnitude slower than
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

/** Max tmux sockets inspected per location, oldest-first by directory order. */
export const FOREIGN_MAX_SOCKETS = 16;

/** Max pane rows parsed from one probe. Panes past this are dropped, not errors. */
export const FOREIGN_MAX_PANES = 400;

/** Max process rows parsed from one probe's `ps` snapshot. */
export const FOREIGN_MAX_PROCS = 4000;

/** Max bytes of probe stdout kept. A runaway `ps` must not become a heap problem. */
export const FOREIGN_PROBE_MAX_BYTES = 2 * 1024 * 1024;
