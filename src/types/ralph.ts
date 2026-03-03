/**
 * @fileoverview Ralph Loop / todo tracking type definitions.
 *
 * Covers the autonomous task execution system: loop state, todo items,
 * completion confidence scoring, RALPH_STATUS block parsing, and the
 * circuit breaker for stuck-loop detection.
 *
 * Key exports:
 * - RalphLoopState / RalphLoopStatus — global loop controller state (embedded in AppState)
 * - RalphTrackerState — per-session loop tracking (cycle count, completion phrase, plan version)
 * - RalphTodoItem / RalphTodoProgress — detected todo items with priority and progress estimation
 * - RalphSessionState — composite per-session state (loop + todos), linked via sessionId
 * - CompletionConfidence — multi-signal scoring for completion detection (0-100)
 * - RalphStatusBlock — parsed RALPH_STATUS block from Claude output (status, tests, exit signal)
 * - CircuitBreakerStatus / CircuitBreakerState — stuck-loop detection state machine (CLOSED → HALF_OPEN → OPEN)
 * - Factory functions: createInitialCircuitBreakerStatus(), createInitialRalphTrackerState(), createInitialRalphSessionState()
 *
 * Cross-domain relationships:
 * - RalphLoopState is embedded in AppState.ralphLoop (app-state domain)
 * - RalphSessionState.sessionId links to SessionState.id (session domain)
 * - CircuitBreakerStatus feeds into RalphLoopHealthScore.components.circuitBreaker (respawn domain)
 *
 * Served at `GET /api/sessions/:id/ralph-state` and `GET /api/sessions/:id/ralph-status`.
 */

/** Status of the Ralph Loop controller */
export type RalphLoopStatus = 'stopped' | 'running' | 'paused';

/**
 * State of the Ralph Loop controller
 */
export interface RalphLoopState {
  /** Current loop status */
  status: RalphLoopStatus;
  /** Timestamp when loop started */
  startedAt: number | null;
  /** Minimum duration to run in milliseconds */
  minDurationMs: number | null;
  /** Number of tasks completed in this run */
  tasksCompleted: number;
  /** Number of tasks auto-generated */
  tasksGenerated: number;
  /** Timestamp of last status check */
  lastCheckAt: number | null;
}

/** Status of a detected todo item */
export type RalphTodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * Confidence scoring for completion detection.
 * Helps distinguish genuine completion signals from false positives.
 */
export interface CompletionConfidence {
  /** Overall confidence level (0-100) */
  score: number;
  /** Whether score is above threshold for triggering completion */
  isConfident: boolean;
  /** Individual signal contributions */
  signals: {
    /** Promise tag detected with proper formatting */
    hasPromiseTag: boolean;
    /** Phrase matches expected completion phrase */
    matchesExpected: boolean;
    /** All todos are marked complete */
    allTodosComplete: boolean;
    /** EXIT_SIGNAL: true in RALPH_STATUS block */
    hasExitSignal: boolean;
    /** Multiple completion indicators present */
    multipleIndicators: boolean;
    /** Output context suggests completion (not in prompt/explanation) */
    contextAppropriate: boolean;
  };
  /** Timestamp of last confidence calculation */
  calculatedAt: number;
}

export interface RalphTrackerState {
  /** Whether the tracker is actively monitoring (disabled by default) */
  enabled: boolean;
  /** Whether a loop is currently active */
  active: boolean;
  /** Detected completion phrase (primary) */
  completionPhrase: string | null;
  /** Additional valid completion phrases (P1-003: multi-phrase support) */
  alternateCompletionPhrases?: string[];
  /** Timestamp when loop started */
  startedAt: number | null;
  /** Number of cycles/iterations detected */
  cycleCount: number;
  /** Maximum iterations if detected */
  maxIterations: number | null;
  /** Timestamp of last activity */
  lastActivity: number;
  /** Elapsed hours if detected */
  elapsedHours: number | null;
  /** Current plan version (for versioning UI) */
  planVersion?: number;
  /** Number of versions in history (for versioning UI) */
  planHistoryLength?: number;
  /** Last completion confidence assessment */
  completionConfidence?: CompletionConfidence;
}

/**
 * Priority levels for todo items.
 * Matches @fix_plan.md format (P0=critical, P1=high, P2=normal).
 */
export type RalphTodoPriority = 'P0' | 'P1' | 'P2' | null;

/**
 * A detected todo item from Claude Code output
 */
export interface RalphTodoItem {
  /** Unique identifier based on content hash */
  id: string;
  /** Todo item text content */
  content: string;
  /** Current status */
  status: RalphTodoStatus;
  /** Timestamp when detected */
  detectedAt: number;
  /** Priority level (P0=critical, P1=high, P2=normal) */
  priority: RalphTodoPriority;
  /** P1-009: Estimated time to complete (ms), based on historical patterns */
  estimatedDurationMs?: number;
  /** P1-009: Complexity category for progress estimation */
  estimatedComplexity?: 'trivial' | 'simple' | 'moderate' | 'complex';
}

/**
 * Progress estimation for the todo list
 */
export interface RalphTodoProgress {
  /** Total number of todos */
  total: number;
  /** Number completed */
  completed: number;
  /** Number in progress */
  inProgress: number;
  /** Number pending */
  pending: number;
  /** Completion percentage (0-100) */
  percentComplete: number;
  /** Estimated remaining time (ms), based on historical completion rate */
  estimatedRemainingMs: number | null;
  /** Average time per todo completion (ms) */
  avgCompletionTimeMs: number | null;
  /** Projected completion timestamp (epoch ms) */
  projectedCompletionAt: number | null;
}

/**
 * Complete Ralph/todo state for a session
 */
export interface RalphSessionState {
  /** Session this state belongs to */
  sessionId: string;
  /** Loop tracking state */
  loop: RalphTrackerState;
  /** Detected todo items */
  todos: RalphTodoItem[];
  /** Timestamp of last update */
  lastUpdated: number;
}

// ========== RALPH_STATUS Block Types ==========

/**
 * Status values from RALPH_STATUS block.
 * - IN_PROGRESS: Work is ongoing
 * - COMPLETE: All tasks finished
 * - BLOCKED: Needs human intervention
 */
export type RalphStatusValue = 'IN_PROGRESS' | 'COMPLETE' | 'BLOCKED';

/**
 * Test status from RALPH_STATUS block.
 */
export type RalphTestsStatus = 'PASSING' | 'FAILING' | 'NOT_RUN';

/**
 * Work type classification for current iteration.
 */
export type RalphWorkType = 'IMPLEMENTATION' | 'TESTING' | 'DOCUMENTATION' | 'REFACTORING';

/**
 * Parsed RALPH_STATUS block from Claude output.
 *
 * Claude outputs this at the end of every response:
 * ```
 * ---RALPH_STATUS---
 * STATUS: IN_PROGRESS
 * TASKS_COMPLETED_THIS_LOOP: 3
 * FILES_MODIFIED: 5
 * TESTS_STATUS: PASSING
 * WORK_TYPE: IMPLEMENTATION
 * EXIT_SIGNAL: false
 * RECOMMENDATION: Continue with database migration
 * ---END_RALPH_STATUS---
 * ```
 */
export interface RalphStatusBlock {
  /** Overall loop status */
  status: RalphStatusValue;
  /** Number of tasks completed in current iteration */
  tasksCompletedThisLoop: number;
  /** Number of files modified in current iteration */
  filesModified: number;
  /** Current state of tests */
  testsStatus: RalphTestsStatus;
  /** Type of work being performed */
  workType: RalphWorkType;
  /** Whether Claude is signaling completion */
  exitSignal: boolean;
  /** Claude's recommendation for next steps */
  recommendation: string;
  /** Timestamp when this block was parsed */
  parsedAt: number;
}

// ========== Circuit Breaker Types ==========

/**
 * Circuit breaker states for detecting stuck loops.
 * - CLOSED: Normal operation, all checks passing
 * - HALF_OPEN: Warning state, some checks failing
 * - OPEN: Loop is stuck, requires intervention
 */
export type CircuitBreakerState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

/**
 * Reason codes for circuit breaker state transitions.
 */
export type CircuitBreakerReason =
  | 'normal_operation'
  | 'no_progress_warning'
  | 'no_progress_open'
  | 'same_error_repeated'
  | 'tests_failing_too_long'
  | 'progress_detected'
  | 'manual_reset';

/**
 * Circuit breaker status for tracking loop health.
 *
 * Transitions:
 * - CLOSED -> HALF_OPEN: consecutive_no_progress >= 2
 * - CLOSED -> OPEN: consecutive_no_progress >= 3 OR consecutive_same_error >= 5
 * - HALF_OPEN -> CLOSED: progress detected
 * - HALF_OPEN -> OPEN: consecutive_no_progress >= 3
 * - OPEN -> CLOSED: manual reset only
 */
export interface CircuitBreakerStatus {
  /** Current state of the circuit breaker */
  state: CircuitBreakerState;
  /** Number of consecutive iterations with no progress */
  consecutiveNoProgress: number;
  /** Number of consecutive iterations with the same error */
  consecutiveSameError: number;
  /** Number of consecutive iterations with failing tests */
  consecutiveTestsFailure: number;
  /** Last iteration number that showed progress */
  lastProgressIteration: number;
  /** Human-readable reason for current state */
  reason: string;
  /** Reason code for programmatic handling */
  reasonCode: CircuitBreakerReason;
  /** Timestamp of last state transition */
  lastTransitionAt: number;
  /** Last error message seen (for same-error tracking) */
  lastErrorMessage: string | null;
}

/**
 * Creates initial circuit breaker status.
 */
export function createInitialCircuitBreakerStatus(): CircuitBreakerStatus {
  return {
    state: 'CLOSED',
    consecutiveNoProgress: 0,
    consecutiveSameError: 0,
    consecutiveTestsFailure: 0,
    lastProgressIteration: 0,
    reason: 'Initial state',
    reasonCode: 'normal_operation',
    lastTransitionAt: Date.now(),
    lastErrorMessage: null,
  };
}

/**
 * Creates initial Ralph tracker state
 * @returns Fresh Ralph tracker state with defaults
 */
export function createInitialRalphTrackerState(): RalphTrackerState {
  return {
    enabled: false, // Disabled by default, auto-enables when Ralph patterns detected
    active: false,
    completionPhrase: null,
    startedAt: null,
    cycleCount: 0,
    maxIterations: null,
    lastActivity: Date.now(),
    elapsedHours: null,
  };
}

/**
 * Creates initial Ralph session state
 * @param sessionId Session ID this state belongs to
 * @returns Fresh Ralph session state
 */
export function createInitialRalphSessionState(sessionId: string): RalphSessionState {
  return {
    sessionId,
    loop: createInitialRalphTrackerState(),
    todos: [],
    lastUpdated: Date.now(),
  };
}
