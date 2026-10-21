/**
 * @fileoverview Centralized Map size limits for memory management.
 *
 * These constants define maximum sizes for Maps that track ephemeral data.
 * Without limits, long-running sessions can accumulate unbounded entries
 * leading to memory leaks.
 *
 * Memory Budget Rationale:
 * - Assuming average entry size of ~1KB
 * - MAX_TRACKED_AGENTS=500 × 1KB = ~500KB for agent tracking
 * - Activity/results per agent × agents = bounded by these limits
 * - Total Map overhead: <50MB even under heavy load
 *
 * @module config/map-limits
 */

// ============================================================================
// Session Tracking Limits
// ============================================================================

/** Default cap on concurrent sessions when `CODEMAN_MAX_SESSIONS` is not set. */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 50;

/**
 * Resolve the session cap from `CODEMAN_MAX_SESSIONS` (a positive integer).
 * Anything else (unset, empty, 0, negative, fractional, not a number) falls back
 * to {@link DEFAULT_MAX_CONCURRENT_SESSIONS}, so a typo never locks session creation.
 */
function resolveMaxConcurrentSessions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEMAN_MAX_SESSIONS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_CONCURRENT_SESSIONS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_MAX_CONCURRENT_SESSIONS;
}

/**
 * Maximum concurrent sessions allowed.
 * Each session consumes significant resources (PTY, buffers, watchers).
 * 50 unless `CODEMAN_MAX_SESSIONS` says otherwise; read once at startup.
 */
export const MAX_CONCURRENT_SESSIONS = resolveMaxConcurrentSessions();

// ============================================================================
// SSE Client Limits
// ============================================================================

/**
 * Maximum concurrent SSE client connections.
 * Each connection holds an open HTTP response and receives all broadcast events.
 */
export const MAX_SSE_CLIENTS = 100;

// ============================================================================
// Todo Item Limits (Ralph Tracker)
// ============================================================================

/**
 * Maximum todo items to track per session.
 */
export const MAX_TODOS_PER_SESSION = 500;

/**
 * Maximum cron-job run-history records retained across all jobs. Oldest runs
 * (by startedAt) are pruned when exceeded — bounds state.json growth from
 * frequently-firing or perpetually-skipped jobs.
 */
export const MAX_CRON_RUN_HISTORY = 500;

/**
 * Maximum saved cron jobs. Jobs persist to state.json, so an unbounded count
 * would grow it without limit; creation past the cap is rejected with 400.
 */
export const MAX_CRON_JOBS = 100;

// ============================================================================
// Pending Tool Calls Limits
// ============================================================================

// ============================================================================
// Agent Tracking Limits
// ============================================================================

/**
 * Maximum agents to track across all sessions (LRU eviction when exceeded).
 */
export const MAX_TRACKED_AGENTS = 500;

/**
 * Maximum pending tool calls to track per subagent.
 * Entries should be cleaned up on tool_result, but this prevents leaks.
 */
export const MAX_PENDING_TOOL_CALLS = 100;

/**
 * TTL for orphaned pending tool calls (5 minutes).
 * If no tool_result received, entry is cleaned up.
 */
export const PENDING_TOOL_CALL_TTL_MS = 5 * 60 * 1000;
