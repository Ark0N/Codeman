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
// Agent Tracking Limits
// ============================================================================

/**
 * Maximum number of agents to track across all sessions.
 * Oldest agents are evicted when limit is exceeded (LRU policy).
 */
export const MAX_TRACKED_AGENTS = 500;

/**
 * Maximum activity entries to keep per agent.
 * Includes tool calls, status updates, progress reports.
 */
export const MAX_SUBAGENT_ACTIVITY_PER_AGENT = 100;

/**
 * Maximum tool results to keep per agent.
 * Prevents memory growth from long-running agents with many tool calls.
 */
export const MAX_TOOL_RESULTS_PER_AGENT = 200;

// ============================================================================
// Session Tracking Limits
// ============================================================================

/**
 * Maximum concurrent sessions allowed.
 * Each session consumes significant resources (PTY, buffers, watchers).
 */
export const MAX_CONCURRENT_SESSIONS = 50;

// ============================================================================
// Todo Item Limits (Ralph Tracker)
// ============================================================================

/**
 * Maximum todo items to track per session.
 */
export const MAX_TODOS_PER_SESSION = 500;

/**
 * TTL for completed todo items before cleanup (1 hour).
 */
export const COMPLETED_TODO_TTL_MS = 60 * 60 * 1000;

// ============================================================================
// Pending Tool Calls Limits
// ============================================================================

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
