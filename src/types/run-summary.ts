/**
 * @fileoverview Run summary type definitions.
 *
 * Types for the "what happened while away" session timeline. RunSummary
 * aggregates events (respawn cycles, errors, token milestones, AI checks)
 * into a per-session historical view.
 *
 * Key exports:
 * - RunSummary — complete per-session summary (events timeline + aggregated stats)
 * - RunSummaryEvent — a single timestamped event (16 event types, 4 severity levels)
 * - RunSummaryStats — aggregated metrics (cycles, tokens, active/idle time, error count)
 * - RunSummaryEventType — union of event types (session_started, respawn_cycle_*, error, etc.)
 * - RunSummaryEventSeverity — 'info' | 'warning' | 'error' | 'success'
 * - createInitialRunSummaryStats() — factory for fresh stats
 *
 * Cross-domain: RunSummary.sessionId links to SessionState.id (session domain).
 * In-memory only (not persisted to disk). Served at `GET /api/sessions/:id/run-summary`.
 */

/**
 * Types of events tracked in the run summary.
 * These provide a historical view of what happened during a session.
 */
export type RunSummaryEventType =
  | 'session_started'
  | 'session_stopped'
  | 'respawn_cycle_started'
  | 'respawn_cycle_completed'
  | 'respawn_state_change'
  | 'error'
  | 'warning'
  | 'token_milestone'
  | 'auto_compact'
  | 'auto_clear'
  | 'idle_detected'
  | 'working_detected'
  | 'ralph_completion'
  | 'ai_check_result'
  | 'hook_event'
  | 'state_stuck';

/**
 * Severity levels for run summary events.
 */
export type RunSummaryEventSeverity = 'info' | 'warning' | 'error' | 'success';

/**
 * A single event in the run summary timeline.
 */
export interface RunSummaryEvent {
  /** Unique event identifier */
  id: string;
  /** Timestamp when event occurred */
  timestamp: number;
  /** Type of event */
  type: RunSummaryEventType;
  /** Severity level for display */
  severity: RunSummaryEventSeverity;
  /** Short title for the event */
  title: string;
  /** Optional detailed description */
  details?: string;
  /** Optional additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Statistics aggregated from run summary events.
 */
export interface RunSummaryStats {
  /** Number of respawn cycles completed */
  totalRespawnCycles: number;
  /** Total tokens used during this run */
  totalTokensUsed: number;
  /** Peak token count observed */
  peakTokens: number;
  /** Total time Claude was actively working (ms) */
  totalTimeActiveMs: number;
  /** Total time Claude was idle (ms) */
  totalTimeIdleMs: number;
  /** Number of errors encountered */
  errorCount: number;
  /** Number of warnings encountered */
  warningCount: number;
  /** Number of AI idle checks performed */
  aiCheckCount: number;
  /** Timestamp when last became idle */
  lastIdleAt: number | null;
  /** Timestamp when last started working */
  lastWorkingAt: number | null;
  /** Total number of state transitions */
  stateTransitions: number;
}

/**
 * Complete run summary for a session.
 * Provides a historical view of session activity for users returning after absence.
 */
export interface RunSummary {
  /** Session ID this summary belongs to */
  sessionId: string;
  /** Session display name */
  sessionName: string;
  /** Timestamp when tracking started */
  startedAt: number;
  /** Timestamp of last update */
  lastUpdatedAt: number;
  /** Timeline of events (most recent last) */
  events: RunSummaryEvent[];
  /** Aggregated statistics */
  stats: RunSummaryStats;
}

/**
 * Creates initial run summary stats.
 */
export function createInitialRunSummaryStats(): RunSummaryStats {
  return {
    totalRespawnCycles: 0,
    totalTokensUsed: 0,
    peakTokens: 0,
    totalTimeActiveMs: 0,
    totalTimeIdleMs: 0,
    errorCount: 0,
    warningCount: 0,
    aiCheckCount: 0,
    lastIdleAt: null,
    lastWorkingAt: null,
    stateTransitions: 0,
  };
}
