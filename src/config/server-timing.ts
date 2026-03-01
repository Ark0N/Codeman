/**
 * @fileoverview Web server performance and scheduling constants.
 *
 * Controls terminal batching throughput, SSE health checking,
 * state persistence debouncing, and scheduled run timing.
 *
 * @module config/server-timing
 */

// ============================================================================
// Terminal & SSE Performance
// ============================================================================

/** Terminal data batching interval — targets 60fps (ms) */
export const TERMINAL_BATCH_INTERVAL = 16;

/** Immediate flush threshold for terminal batches (bytes).
 * Set high (32KB) to allow effective batching; avg Ink events are ~14KB. */
export const BATCH_FLUSH_THRESHOLD = 32 * 1024;

/** Task event batching interval (ms) */
export const TASK_UPDATE_BATCH_INTERVAL = 100;

/** SSE heartbeat interval — sends padded keepalive to flush proxy buffers (ms).
 * 15s is fast enough to keep Cloudflare tunnel buffers flushed while avoiding
 * excessive bandwidth. Also serves as dead-client detection. */
export const SSE_HEARTBEAT_INTERVAL = 15 * 1000;

/** SSE padding size (bytes). Cloudflare quick tunnels buffer small SSE events;
 * appending ~8KB of SSE comment padding forces the proxy to flush immediately.
 * SSE comments (lines starting with ':') are silently ignored by EventSource. */
export const SSE_PADDING_SIZE = 8 * 1024;

// ============================================================================
// State Persistence
// ============================================================================

/** State update debounce — batches expensive toDetailedState() calls (ms) */
export const STATE_UPDATE_DEBOUNCE_INTERVAL = 500;

/** Sessions list cache TTL — avoids re-serializing on every SSE init (ms) */
export const SESSIONS_LIST_CACHE_TTL = 1000;

// ============================================================================
// Scheduled Runs
// ============================================================================

/** Scheduled runs cleanup check interval (ms) */
export const SCHEDULED_CLEANUP_INTERVAL = 5 * 60 * 1000;

/** Completed scheduled run max age before cleanup (ms) */
export const SCHEDULED_RUN_MAX_AGE = 60 * 60 * 1000;

/** Session limit retry wait before retrying (ms) */
export const SESSION_LIMIT_WAIT_MS = 5000;

/** Pause between scheduled run iterations (ms) */
export const ITERATION_PAUSE_MS = 2000;

// ============================================================================
// Mux Stats
// ============================================================================

/** Mux stats collection interval (ms) */
export const STATS_COLLECTION_INTERVAL_MS = 2000;

// ============================================================================
// Process Error Recovery
// ============================================================================

/** Max consecutive unhandled errors before auto-restart */
export const MAX_CONSECUTIVE_ERRORS = 5;

/** Error counter reset interval — forgives errors after quiet period (ms) */
export const ERROR_RESET_MS = 60_000;
