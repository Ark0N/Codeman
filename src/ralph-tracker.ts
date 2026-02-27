/**
 * @fileoverview Ralph Tracker - Detects Ralph Wiggum loops, todos, and completion phrases
 *
 * This module parses terminal output from Claude Code sessions to detect:
 * - Ralph Wiggum loop state (active, completion phrase, iteration count)
 * - Todo list items from the TodoWrite tool
 * - Completion phrases signaling loop completion
 *
 * The tracker is DISABLED by default and auto-enables when Ralph-related
 * patterns are detected in the output stream, reducing overhead for
 * sessions not using autonomous loops.
 *
 * @module ralph-tracker
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { existsSync, FSWatcher, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import {
  RalphTrackerState,
  RalphTodoItem,
  RalphTodoStatus,
  RalphTodoPriority,
  RalphStatusBlock,
  RalphStatusValue,
  RalphTestsStatus,
  RalphWorkType,
  CircuitBreakerStatus,
  RalphTodoProgress,
  CompletionConfidence,
  createInitialRalphTrackerState,
  createInitialCircuitBreakerStatus,
  PlanTaskStatus,
  TddPhase,
} from './types.js';
import {
  ANSI_ESCAPE_PATTERN_SIMPLE,
  fuzzyPhraseMatch,
  todoContentHash,
  stringSimilarity,
} from './utils/index.js';
import { MAX_LINE_BUFFER_SIZE } from './config/buffer-limits.js';
import { MAX_TODOS_PER_SESSION } from './config/map-limits.js';

// ========== Enhanced Plan Task Interface ==========

// Note: PlanTaskStatus and TddPhase are imported from types.ts

/**
 * Enhanced plan task with verification criteria, dependencies, and execution tracking.
 * Supports TDD workflow, failure tracking, and plan versioning.
 */
export interface EnhancedPlanTask {
  /** Unique identifier (e.g., "P0-001") */
  id: string;
  /** Task description */
  content: string;
  /** Criticality level */
  priority: 'P0' | 'P1' | 'P2' | null;
  /** How to verify completion */
  verificationCriteria?: string;
  /** Command to run for verification */
  testCommand?: string;
  /** IDs of tasks that must complete first */
  dependencies: string[];
  /** Current execution status */
  status: PlanTaskStatus;
  /** How many times attempted */
  attempts: number;
  /** Most recent failure reason */
  lastError?: string;
  /** Timestamp of completion */
  completedAt?: number;
  /** Plan version this belongs to */
  version: number;
  /** TDD phase category */
  tddPhase?: TddPhase;
  /** ID of paired test/impl task */
  pairedWith?: string;
  /** Estimated complexity */
  complexity?: 'low' | 'medium' | 'high';
  /** Checklist items for review tasks (tddPhase: 'review') */
  reviewChecklist?: string[];
}

/** Checkpoint review data */
export interface CheckpointReview {
  iteration: number;
  timestamp: number;
  summary: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
    pending: number;
    inProgress: number;
  };
  stuckTasks: Array<{
    id: string;
    content: string;
    attempts: number;
    lastError?: string;
  }>;
  recommendations: string[];
}

// ========== Configuration Constants ==========
// Note: MAX_TODOS_PER_SESSION and MAX_LINE_BUFFER_SIZE are imported from config modules

/**
 * Todo items older than this duration (in milliseconds) will be auto-expired.
 * Default: 1 hour (60 * 60 * 1000)
 */
const TODO_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Minimum interval between cleanup checks (in milliseconds).
 * Prevents running cleanup on every data chunk.
 * Default: 30 seconds
 */
const CLEANUP_THROTTLE_MS = 30 * 1000;

/**
 * Similarity threshold for todo deduplication.
 * Todos with similarity >= this value are considered duplicates.
 * Range: 0.0 (no similarity) to 1.0 (identical)
 * Default: 0.85 (85% similar)
 */
const TODO_SIMILARITY_THRESHOLD = 0.85;

/**
 * Debounce interval for event emissions (milliseconds).
 * Prevents UI jitter from rapid consecutive updates.
 * Default: 50ms
 */
const EVENT_DEBOUNCE_MS = 50;

/**
 * Maximum number of completion phrase entries to track.
 * Prevents unbounded growth if many unique phrases are seen.
 */
const MAX_COMPLETION_PHRASE_ENTRIES = 50;
const MAX_PLAN_HISTORY = 10;

/**
 * Common/generic completion phrases that may cause false positives.
 * These phrases are likely to appear in Claude's natural output,
 * making them unreliable as completion signals.
 *
 * P1-002: Configurable false positive prevention
 */
const COMMON_COMPLETION_PHRASES = new Set([
  'DONE',
  'COMPLETE',
  'FINISHED',
  'OK',
  'YES',
  'TRUE',
  'SUCCESS',
  'READY',
  'COMPLETED',
  'PASSED',
  'END',
  'STOP',
  'EXIT',
]);

/**
 * Minimum recommended phrase length for completion detection.
 * Shorter phrases are more likely to cause false positives.
 */
const MIN_RECOMMENDED_PHRASE_LENGTH = 6;

// ========== Pre-compiled Regex Patterns ==========
// Pre-compiled for performance (avoid re-compilation on each call)

/**
 * Matches completion phrase tags: `<promise>PHRASE</promise>`
 * Used to detect when Claude signals task completion.
 * Capture group 1: The completion phrase text
 *
 * Supports any characters between tags including:
 * - Uppercase letters: COMPLETE, DONE
 * - Numbers: TASK_123
 * - Underscores: ALL_TASKS_DONE
 * - Hyphens: TESTS-PASS, TIME-COMPLETE
 *
 * Now also tolerates:
 * - Whitespace/newlines inside tags: <promise> COMPLETE </promise>
 * - Case variations in tag names: <Promise>, <PROMISE>
 */
const PROMISE_PATTERN = /<promise>\s*([^<]+?)\s*<\/promise>/i;

/**
 * Pattern for detecting partial/incomplete promise tags at end of buffer.
 * Used for cross-chunk promise detection when tags are split across PTY writes.
 * Captures:
 * - Group 1: Partial opening tag content after <promise> (may be incomplete)
 */
const PROMISE_PARTIAL_PATTERN = /<promise>\s*([^<]*)$/i;

// ---------- Todo Item Patterns ----------
// Claude Code outputs todos in multiple formats; we detect all of them

/**
 * Format 1: Markdown checkbox format
 * Matches: "- [ ] Task" or "- [x] Task" (also with * bullet)
 * Capture group 1: Checkbox state ('x', 'X', or ' ')
 * Capture group 2: Task content
 */
const TODO_CHECKBOX_PATTERN = /^[-*]\s*\[([xX ])\]\s+(.+)$/gm;

/**
 * Format 2: Todo with indicator icons
 * Matches: "Todo: ☐ Task", "Todo: ◐ Task", "Todo: ✓ Task"
 * Capture group 1: Status icon
 * Capture group 2: Task content
 */
const TODO_INDICATOR_PATTERN = /Todo:\s*(☐|◐|✓|⏳|✅|⌛|🔄)\s+(.+)/g;

/**
 * Format 3: Status in parentheses
 * Matches: "- Task (pending)", "- Task (in_progress)", "- Task (completed)"
 * Capture group 1: Task content
 * Capture group 2: Status string
 */
const TODO_STATUS_PATTERN = /[-*]\s*(.+?)\s+\((pending|in_progress|completed)\)/g;

/**
 * Format 4: Claude Code native TodoWrite output
 * Matches: "☐ Task", "☒ Task", "◐ Task", "✓ Task"
 * These appear with optional leading whitespace/brackets like "⎿  ☐ Task"
 * Capture group 1: Checkbox icon (☐=pending, ☒=completed, ◐=in_progress, ✓=completed)
 * Capture group 2: Task content (min 3 chars, excludes checkbox icons)
 */
const TODO_NATIVE_PATTERN = /^[\s⎿]*(☐|☒|◐|✓)\s+([^☐☒◐✓\n]{3,})/gm;

/**
 * Format 5: Claude Code checkmark-based TodoWrite output
 * Matches task creation: "✔ Task #1 created: Fix the bug"
 * Matches task summary: "✔ #1 Fix the bug"
 * Matches status update: "✔ Task #1 updated: status → completed"
 *
 * These are the primary output format of Claude Code's TodoWrite tool.
 */
const TODO_TASK_CREATED_PATTERN = /✔\s*Task\s*#(\d+)\s*created:\s*(.+)/g;
const TODO_TASK_SUMMARY_PATTERN = /✔\s*#(\d+)\s+(.+)/g;
const TODO_TASK_STATUS_PATTERN =
  /✔\s*Task\s*#(\d+)\s*updated:\s*status\s*→\s*(in progress|completed|pending)/g;

/**
 * Matches plain checkmark TodoWrite output without task numbers.
 * Real Claude Code TodoWrite output: "✔ Create hello.txt with Hello World"
 * This is the most common format in actual usage.
 */
const TODO_PLAIN_CHECKMARK_PATTERN = /✔\s+(.+)/g;

/**
 * Patterns to exclude from todo detection
 * Prevents false positives from tool invocations and Claude commentary
 */
const TODO_EXCLUDE_PATTERNS = [
  /^(?:Bash|Search|Read|Write|Glob|Grep|Edit|Task)\s*\(/i, // Tool invocations
  /^(?:I'll |Let me |Now I|First,|Task \d+:|Result:|Error:)/i, // Claude commentary
  /^\S+\([^)]+\)$/, // Generic function call pattern
];

// ---------- Loop Status Patterns ----------
// Note: <promise> tags are handled separately by PROMISE_PATTERN

/**
 * Matches generic loop start messages
 * Examples: "Loop started at", "Starting main loop", "Ralph loop started"
 */
const LOOP_START_PATTERN = /Loop started at|Starting.*loop|Ralph loop started/i;

/**
 * Matches elapsed time output
 * Example: "Elapsed: 2.5 hours"
 * Capture group 1: Hours as decimal number
 */
const ELAPSED_TIME_PATTERN = /Elapsed:\s*(\d+(?:\.\d+)?)\s*hours?/i;

/**
 * Matches cycle count indicators (legacy format)
 * Examples: "cycle #5", "respawn cycle #3"
 * Capture groups 1 or 2: Cycle number
 */
const CYCLE_PATTERN = /cycle\s*#?(\d+)|respawn cycle #(\d+)/i;

// ---------- Ralph Wiggum Plugin Patterns ----------
// Based on the official Ralph Wiggum plugin output format

/**
 * Matches iteration progress indicators
 * Examples: "Iteration 5/50", "[5/50]", "iteration #5", "iter. 3 of 10"
 * Capture groups: (1,2) for "Iteration X/Y" format, (3,4) for "[X/Y]" format
 */
const ITERATION_PATTERN =
  /(?:iteration|iter\.?)\s*#?(\d+)(?:\s*(?:\/|of)\s*(\d+))?|\[(\d+)\/(\d+)\]/i;

/**
 * Matches Ralph loop start command or announcement
 * Examples: "/ralph-loop:ralph-loop", "Starting Ralph Wiggum loop", "ralph loop beginning"
 */
const RALPH_START_PATTERN =
  /\/ralph-loop|starting ralph(?:\s+wiggum)?\s+loop|ralph loop (?:started|beginning)/i;

/**
 * Matches max iterations configuration
 * Examples: "max-iterations 50", "maxIterations: 50", "max_iterations=50"
 * Capture group 1: Maximum iteration count
 */
const MAX_ITERATIONS_PATTERN = /max[_-]?iterations?\s*[=:]\s*(\d+)/i;

/**
 * Matches TodoWrite tool usage indicators
 * Examples: "TodoWrite", "todos updated", "Todos have been modified"
 */
const TODOWRITE_PATTERN =
  /TodoWrite|todo(?:s)?\s*(?:updated|written|saved)|Todos have been modified/i;

// ---------- Task Completion Detection Patterns ----------

/**
 * Matches "all tasks complete" announcements
 * Examples: "All 8 files have been created", "All tasks completed", "Everything is done"
 * Used to mark all tracked todos as complete at once
 */
const ALL_COMPLETE_PATTERN =
  /all\s+(?:\d+\s+)?(?:tasks?|files?|items?)\s+(?:have\s+been\s+|are\s+)?(?:completed?|done|finished|created)|completed?\s+all\s+(?:\d+\s+)?tasks?|all\s+done|everything\s+(?:is\s+)?(?:completed?|done)|finished\s+all\s+tasks?/i;

/**
 * Extracts count from "all N items" messages
 * Example: "All 8 files created" → captures "8"
 * Capture group 1: The count
 */
const ALL_COUNT_PATTERN = /all\s+(\d+)\s+(?:tasks?|files?|items?)/i;

/**
 * Matches individual task completion messages
 * Examples: "Task #5 is done", "marked as completed", "todo 3 finished"
 * Used to update specific todo items by number
 */
const TASK_DONE_PATTERN =
  /(?:task|item|todo)\s*(?:#?\d+|"\s*[^"]+\s*")?\s*(?:is\s+)?(?:done|completed?|finished)|(?:completed?|done|finished)\s+(?:task|item)\s*(?:#?\d+)?|marking\s+(?:.*?\s+)?(?:as\s+)?completed?|marked\s+(?:.*?\s+)?(?:as\s+)?completed?/i;

// ---------- Utility Patterns ----------

/** Maximum number of task number to content mappings to track */
const MAX_TASK_MAPPINGS = 100;

// ---------- RALPH_STATUS Block Patterns ----------
// Based on Ralph Claude Code structured status reporting

/**
 * Matches the start of a RALPH_STATUS block
 * Pattern: ---RALPH_STATUS---
 */
const RALPH_STATUS_START_PATTERN = /^---RALPH_STATUS---\s*$/;

/**
 * Matches the end of a RALPH_STATUS block
 * Pattern: ---END_RALPH_STATUS---
 */
const RALPH_STATUS_END_PATTERN = /^---END_RALPH_STATUS---\s*$/;

/**
 * Matches STATUS field in RALPH_STATUS block
 * Captures: IN_PROGRESS | COMPLETE | BLOCKED
 */
const RALPH_STATUS_FIELD_PATTERN = /^STATUS:\s*(IN_PROGRESS|COMPLETE|BLOCKED)\s*$/i;

/**
 * Matches TASKS_COMPLETED_THIS_LOOP field
 * Captures: number
 */
const RALPH_TASKS_COMPLETED_PATTERN = /^TASKS_COMPLETED_THIS_LOOP:\s*(\d+)\s*$/i;

/**
 * Matches FILES_MODIFIED field
 * Captures: number
 */
const RALPH_FILES_MODIFIED_PATTERN = /^FILES_MODIFIED:\s*(\d+)\s*$/i;

/**
 * Matches TESTS_STATUS field
 * Captures: PASSING | FAILING | NOT_RUN
 */
const RALPH_TESTS_STATUS_PATTERN = /^TESTS_STATUS:\s*(PASSING|FAILING|NOT_RUN)\s*$/i;

/**
 * Matches WORK_TYPE field
 * Captures: IMPLEMENTATION | TESTING | DOCUMENTATION | REFACTORING
 */
const RALPH_WORK_TYPE_PATTERN =
  /^WORK_TYPE:\s*(IMPLEMENTATION|TESTING|DOCUMENTATION|REFACTORING)\s*$/i;

/**
 * Matches EXIT_SIGNAL field
 * Captures: true | false
 */
const RALPH_EXIT_SIGNAL_PATTERN = /^EXIT_SIGNAL:\s*(true|false)\s*$/i;

/**
 * Matches RECOMMENDATION field
 * Captures: any text
 */
const RALPH_RECOMMENDATION_PATTERN = /^RECOMMENDATION:\s*(.+)$/i;

// ---------- Completion Indicator Patterns (for dual-condition exit) ----------

/**
 * Patterns that indicate potential completion (natural language)
 * Count >= 2 along with EXIT_SIGNAL: true triggers exit
 */
const COMPLETION_INDICATOR_PATTERNS = [
  /all\s+(?:tasks?|items?|work)\s+(?:are\s+)?(?:completed?|done|finished)/i,
  /(?:completed?|finished)\s+all\s+(?:tasks?|items?|work)/i,
  /nothing\s+(?:left|remaining)\s+to\s+do/i,
  /no\s+more\s+(?:tasks?|items?|work)/i,
  /everything\s+(?:is\s+)?(?:completed?|done)/i,
  /project\s+(?:is\s+)?(?:completed?|done|finished)/i,
];

// ---------- Priority Detection Patterns ----------
// Pre-compiled for performance; avoids repeated allocation in parsePriority()

/** P0 (Critical) priority patterns - highest severity issues */
const P0_PRIORITY_PATTERNS = [
  /\bP0\b|\(P0\)|:?\s*P0\s*:/, // Explicit P0
  /\bCRITICAL\b/, // Critical keyword
  /\bBLOCKER\b/, // Blocker
  /\bURGENT\b/, // Urgent
  /\bSECURITY\b/, // Security issues
  /\bCRASH(?:ES|ING)?\b/, // Crash, crashes, crashing
  /\bBROKEN\b/, // Broken
  /\bDATA\s*LOSS\b/, // Data loss
  /\bPRODUCTION\s*(?:DOWN|ISSUE|BUG)\b/, // Production issues
  /\bHOTFIX\b/, // Hotfix
  /\bSEVERITY\s*1\b/, // Severity 1
];

/** P1 (High) priority patterns - important issues requiring attention */
const P1_PRIORITY_PATTERNS = [
  /\bP1\b|\(P1\)|:?\s*P1\s*:/, // Explicit P1
  /\bHIGH\s*PRIORITY\b/, // High priority
  /\bIMPORTANT\b/, // Important
  /\bBUG\b/, // Bug
  /\bFIX\b/, // Fix (as task type)
  /\bERROR\b/, // Error
  /\bFAIL(?:S|ED|ING|URE)?\b/, // Fail variants
  /\bREGRESSION\b/, // Regression
  /\bMUST\s*(?:HAVE|FIX|DO)\b/, // Must have/fix/do
  /\bSEVERITY\s*2\b/, // Severity 2
  /\bREQUIRED\b/, // Required
];

/** P2 (Medium) priority patterns - lower priority improvements */
const P2_PRIORITY_PATTERNS = [
  /\bP2\b|\(P2\)|:?\s*P2\s*:/, // Explicit P2
  /\bNICE\s*TO\s*HAVE\b/, // Nice to have
  /\bLOW\s*PRIORITY\b/, // Low priority
  /\bREFACTOR\b/, // Refactor
  /\bCLEANUP\b/, // Cleanup
  /\bIMPROVE(?:MENT)?\b/, // Improve/Improvement
  /\bOPTIMIZ(?:E|ATION)\b/, // Optimize/Optimization
  /\bCONSIDER\b/, // Consider
  /\bWOULD\s*BE\s*NICE\b/, // Would be nice
  /\bENHANCE(?:MENT)?\b/, // Enhance/Enhancement
  /\bTECH(?:NICAL)?\s*DEBT\b/, // Tech debt
  /\bDOCUMENT(?:ATION)?\b/, // Documentation
];

// ========== Event Types ==========

/**
 * Events emitted by RalphTracker
 * @event loopUpdate - Fired when loop state changes (active, iteration, completion phrase)
 * @event todoUpdate - Fired when todo list changes (items added, status changed)
 * @event completionDetected - Fired when completion phrase is detected (task complete)
 * @event enabled - Fired when tracker auto-enables due to Ralph pattern detection
 * @event statusBlockDetected - Fired when a RALPH_STATUS block is parsed
 * @event circuitBreakerUpdate - Fired when circuit breaker state changes
 * @event exitGateMet - Fired when dual-condition exit gate is met
 */
export interface RalphTrackerEvents {
  /** Emitted when loop state changes */
  loopUpdate: (state: RalphTrackerState) => void;
  /** Emitted when todo list is modified */
  todoUpdate: (todos: RalphTodoItem[]) => void;
  /** Emitted when completion phrase detected (loop finished) */
  completionDetected: (phrase: string) => void;
  /** Emitted when tracker auto-enables from disabled state */
  enabled: () => void;
  /** Emitted when a RALPH_STATUS block is parsed */
  statusBlockDetected: (block: RalphStatusBlock) => void;
  /** Emitted when circuit breaker state changes */
  circuitBreakerUpdate: (status: CircuitBreakerStatus) => void;
  /** Emitted when dual-condition exit gate is met (completion indicators >= 2 AND EXIT_SIGNAL: true) */
  exitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  /** Emitted when iteration count hasn't changed for an extended period (stall warning) */
  iterationStallWarning: (data: { iteration: number; stallDurationMs: number }) => void;
  /** Emitted when iteration count hasn't changed for critical period (stall critical) */
  iterationStallCritical: (data: { iteration: number; stallDurationMs: number }) => void;
  /** Emitted when a common/risky completion phrase is detected (P1-002) */
  phraseValidationWarning: (data: {
    phrase: string;
    reason: 'common' | 'short' | 'numeric';
    suggestedPhrase: string;
  }) => void;
}

/**
 * RalphTracker - Parses terminal output to detect Ralph Wiggum loops and todos
 *
 * This class monitors Claude Code session output to detect:
 * 1. **Ralph Wiggum loop state** - Active loops, completion phrases, iteration counts
 * 2. **Todo list items** - From TodoWrite tool in various formats
 * 3. **Completion signals** - `<promise>PHRASE</promise>` tags
 *
 * ## Lifecycle
 *
 * The tracker is **DISABLED by default** and auto-enables when Ralph-related
 * patterns are detected (e.g., /ralph-loop:ralph-loop, <promise>, todos).
 * This reduces overhead for sessions not using autonomous loops.
 *
 * ## Completion Detection
 *
 * Uses occurrence-based detection to distinguish prompt from actual completion:
 * - 1st occurrence of `<promise>X</promise>`: Stored as expected phrase (likely in prompt)
 * - 2nd occurrence: Emits `completionDetected` event (actual completion)
 * - If loop already active: Emits immediately on first occurrence
 *
 * ## Events
 *
 * - `loopUpdate` - Loop state changed (status, iteration, phrase)
 * - `todoUpdate` - Todo list modified (add, status change)
 * - `completionDetected` - Loop completion phrase detected
 * - `enabled` - Tracker auto-enabled from disabled state
 *
 * @extends EventEmitter
 * @example
 * ```typescript
 * const tracker = new RalphTracker();
 * tracker.on('completionDetected', (phrase) => {
 *   console.log('Loop completed with phrase:', phrase);
 * });
 * tracker.processTerminalData(ptyOutput);
 * ```
 */
export class RalphTracker extends EventEmitter {
  /** Current state of the detected loop */
  private _loopState: RalphTrackerState;

  /** Map of todo items by ID for O(1) lookup */
  private _todos: Map<string, RalphTodoItem> = new Map();

  /** Buffer for incomplete lines from terminal data */
  private _lineBuffer: string = '';

  /**
   * Tracks occurrences of completion phrases.
   * Used to distinguish prompt echo (1st) from actual completion (2nd+).
   */
  private _completionPhraseCount: Map<string, number> = new Map();

  /** Timestamp of last cleanup check for throttling */
  private _lastCleanupTime: number = 0;

  /** Debounce timer for todoUpdate events */
  private _todoUpdateTimer: NodeJS.Timeout | null = null;

  /** Debounce timer for loopUpdate events */
  private _loopUpdateTimer: NodeJS.Timeout | null = null;

  /** Flag indicating pending todoUpdate emission */
  private _todoUpdatePending: boolean = false;

  /** Flag indicating pending loopUpdate emission */
  private _loopUpdatePending: boolean = false;

  /** When true, prevents auto-enable on pattern detection */
  private _autoEnableDisabled: boolean = true;

  /** Maps task numbers from "✔ Task #N" format to their content for status updates */
  private _taskNumberToContent: Map<number, string> = new Map();

  /**
   * Buffer for partial promise tags split across PTY chunks.
   * Holds content after '<promise>' when closing tag hasn't arrived yet.
   * Max 256 chars to prevent unbounded growth from malformed tags.
   */
  private _partialPromiseBuffer: string = '';

  /** Maximum size of partial promise buffer */
  private static readonly MAX_PARTIAL_PROMISE_SIZE = 256;

  // ========== RALPH_STATUS Block State ==========

  /** Circuit breaker state tracking */
  private _circuitBreaker: CircuitBreakerStatus;

  /** Buffer for RALPH_STATUS block lines */
  private _statusBlockBuffer: string[] = [];

  /** Flag indicating we're inside a RALPH_STATUS block */
  private _inStatusBlock: boolean = false;

  /** Last parsed RALPH_STATUS block */
  private _lastStatusBlock: RalphStatusBlock | null = null;

  /** Count of completion indicators detected (for dual-condition exit) */
  private _completionIndicators: number = 0;

  /** Whether dual-condition exit gate has been met */
  private _exitGateMet: boolean = false;

  /** Cumulative files modified across all iterations */
  private _totalFilesModified: number = 0;

  /** Cumulative tasks completed across all iterations */
  private _totalTasksCompleted: number = 0;

  /** Working directory for @fix_plan.md watching */
  private _workingDir: string | null = null;

  /** File watcher for @fix_plan.md */
  private _fixPlanWatcher: FSWatcher | null = null;
  /** Error handler for FSWatcher (stored for cleanup to prevent memory leak) */
  private _fixPlanWatcherErrorHandler: ((err: Error) => void) | null = null;

  /** Debounce timer for file change events */
  private _fixPlanReloadTimer: NodeJS.Timeout | null = null;

  /** Path to the @fix_plan.md file being watched */
  private _fixPlanPath: string | null = null;

  /**
   * When @fix_plan.md is active, treat it as the source of truth for todo status.
   * This prevents output-based detection from overriding file-based status.
   */
  private get isFileAuthoritative(): boolean {
    return this._fixPlanPath !== null;
  }

  // ========== Enhanced Plan Management ==========

  /** Current version of the plan (incremented on changes) */
  private _planVersion: number = 1;

  /** History of plan versions for rollback support */
  private _planHistory: Array<{
    version: number;
    timestamp: number;
    tasks: Map<string, EnhancedPlanTask>;
    summary: string;
  }> = [];

  /** Enhanced plan tasks with execution tracking */
  private _planTasks: Map<string, EnhancedPlanTask> = new Map();

  /** Checkpoint intervals (iterations at which to trigger review) */
  private _checkpointIterations: number[] = [5, 10, 20, 30, 50, 75, 100];

  /** Last checkpoint iteration */
  private _lastCheckpointIteration: number = 0;

  // ========== Iteration Stall Detection ==========

  /** Timestamp when iteration count last changed */
  private _lastIterationChangeTime: number = 0;

  /** Last observed iteration count for stall detection */
  private _lastObservedIteration: number = 0;

  /** Timer for iteration stall detection */
  private _iterationStallTimer: NodeJS.Timeout | null = null;

  /** Iteration stall warning threshold (ms) - default 10 minutes */
  private _iterationStallWarningMs: number = 10 * 60 * 1000;

  /** Iteration stall critical threshold (ms) - default 20 minutes */
  private _iterationStallCriticalMs: number = 20 * 60 * 1000;

  /** Whether stall warning has been emitted */
  private _iterationStallWarned: boolean = false;

  /** Alternate completion phrases (P1-003: multi-phrase support) - Set for O(1) lookup */
  private _alternateCompletionPhrases: Set<string> = new Set();

  // ========== P1-009: Progress Estimation ==========

  /** History of todo completion times (ms) for averaging */
  private _completionTimes: number[] = [];

  /** Maximum number of completion times to track */
  private static readonly MAX_COMPLETION_TIMES = 50;

  /** Timestamp when todos started being tracked for this session */
  private _todosStartedAt: number = 0;

  /** Map of todo ID to timestamp when it started (for duration tracking) */
  private _todoStartTimes: Map<string, number> = new Map();

  /**
   * Creates a new RalphTracker instance.
   * Starts in disabled state until Ralph patterns are detected.
   */
  constructor() {
    super();
    this._loopState = createInitialRalphTrackerState();
    this._circuitBreaker = createInitialCircuitBreakerStatus();
    this._lastIterationChangeTime = Date.now();
  }

  /**
   * Add an alternate completion phrase (P1-003: multi-phrase support).
   * Multiple phrases can trigger completion (useful for complex workflows).
   * @param phrase - Additional phrase that can trigger completion
   */
  addAlternateCompletionPhrase(phrase: string): void {
    if (!this._alternateCompletionPhrases.has(phrase)) {
      this._alternateCompletionPhrases.add(phrase);
      this._loopState.alternateCompletionPhrases = Array.from(this._alternateCompletionPhrases);
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Remove an alternate completion phrase.
   * @param phrase - Phrase to remove
   */
  removeAlternateCompletionPhrase(phrase: string): void {
    if (this._alternateCompletionPhrases.delete(phrase)) {
      this._loopState.alternateCompletionPhrases = Array.from(this._alternateCompletionPhrases);
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Check if a phrase matches any valid completion phrase (primary or alternate).
   * @param phrase - Phrase to check
   * @returns True if phrase matches any valid completion phrase
   */
  isValidCompletionPhrase(phrase: string): boolean {
    return this.findMatchingCompletionPhrase(phrase) !== null;
  }

  /**
   * Find which completion phrase (primary or alternate) matches the given phrase.
   * @param phrase - Phrase to check
   * @returns The matched canonical phrase, or null if no match
   */
  private findMatchingCompletionPhrase(phrase: string): string | null {
    const primary = this._loopState.completionPhrase;
    if (primary && this.isFuzzyPhraseMatch(phrase, primary)) {
      return primary;
    }
    for (const alt of this._alternateCompletionPhrases) {
      if (this.isFuzzyPhraseMatch(phrase, alt)) {
        return alt;
      }
    }
    return null;
  }

  /**
   * Prevent auto-enable from pattern detection.
   * Use this when the user has explicitly disabled the Ralph tracker.
   */
  disableAutoEnable(): void {
    this._autoEnableDisabled = true;
  }

  /**
   * Allow auto-enable from pattern detection.
   */
  enableAutoEnable(): void {
    this._autoEnableDisabled = false;
  }

  /**
   * Whether auto-enable is disabled.
   */
  get autoEnableDisabled(): boolean {
    return this._autoEnableDisabled;
  }

  /**
   * Set the working directory and start watching @fix_plan.md.
   * Automatically loads existing @fix_plan.md if present.
   * @param workingDir - The session's working directory
   */
  setWorkingDir(workingDir: string): void {
    this._workingDir = workingDir;
    this._fixPlanPath = join(workingDir, '@fix_plan.md');

    // Try to load existing @fix_plan.md
    this.loadFixPlanFromDisk();

    // Start watching for changes
    this.startWatchingFixPlan();
  }

  /**
   * Load @fix_plan.md from disk if it exists.
   * Called on initialization and when file changes are detected.
   */
  async loadFixPlanFromDisk(): Promise<number> {
    if (!this._fixPlanPath) return 0;

    try {
      if (!existsSync(this._fixPlanPath)) {
        return 0;
      }

      const content = await readFile(this._fixPlanPath, 'utf-8');
      const count = this.importFixPlanMarkdown(content);

      if (count > 0) {
        // Auto-enable tracker when we have todos from @fix_plan.md
        if (!this._loopState.enabled) {
          this.enable();
        }
        console.log(`[RalphTracker] Loaded ${count} todos from @fix_plan.md`);
      }

      return count;
    } catch (err) {
      // File doesn't exist or can't be read - that's OK
      console.log(`[RalphTracker] Could not load @fix_plan.md: ${err}`);
      return 0;
    }
  }

  /**
   * Start watching @fix_plan.md for changes.
   * Reloads todos when the file is modified.
   */
  private startWatchingFixPlan(): void {
    if (!this._fixPlanPath || !this._workingDir) return;

    // Stop existing watcher if any
    this.stopWatchingFixPlan();

    try {
      // Only watch if the file exists
      if (!existsSync(this._fixPlanPath)) {
        // Watch the directory instead for file creation
        this._fixPlanWatcher = fsWatch(this._workingDir, (_eventType, filename) => {
          if (filename === '@fix_plan.md') {
            this.handleFixPlanChange();
          }
        });
      } else {
        // Watch the file directly
        this._fixPlanWatcher = fsWatch(this._fixPlanPath, () => {
          this.handleFixPlanChange();
        });
      }
      // Add error handler to prevent unhandled errors and clean up on failure
      // Store handler reference for proper cleanup in stopWatchingFixPlan()
      if (this._fixPlanWatcher) {
        this._fixPlanWatcherErrorHandler = (err: Error) => {
          console.log(`[RalphTracker] FSWatcher error for @fix_plan.md: ${err.message}`);
          this.stopWatchingFixPlan();
        };
        this._fixPlanWatcher.on('error', this._fixPlanWatcherErrorHandler);
      }
    } catch (err) {
      console.log(`[RalphTracker] Could not watch @fix_plan.md: ${err}`);
    }
  }

  /**
   * Handle @fix_plan.md file change with debouncing.
   */
  private handleFixPlanChange(): void {
    // Debounce rapid changes (e.g., multiple writes)
    if (this._fixPlanReloadTimer) {
      clearTimeout(this._fixPlanReloadTimer);
    }

    this._fixPlanReloadTimer = setTimeout(() => {
      this._fixPlanReloadTimer = null;
      this.loadFixPlanFromDisk();
    }, 500); // 500ms debounce
  }

  /**
   * Stop watching @fix_plan.md.
   */
  stopWatchingFixPlan(): void {
    if (this._fixPlanWatcher) {
      // Remove error handler before closing to prevent memory leak
      if (this._fixPlanWatcherErrorHandler) {
        this._fixPlanWatcher.off('error', this._fixPlanWatcherErrorHandler);
        this._fixPlanWatcherErrorHandler = null;
      }
      this._fixPlanWatcher.close();
      this._fixPlanWatcher = null;
    }
    if (this._fixPlanReloadTimer) {
      clearTimeout(this._fixPlanReloadTimer);
      this._fixPlanReloadTimer = null;
    }
  }

  /**
   * Whether the tracker is enabled and actively monitoring output.
   * Disabled by default; auto-enables when Ralph patterns detected.
   * @returns True if tracker is processing terminal data
   */
  get enabled(): boolean {
    return this._loopState.enabled;
  }

  /**
   * Enable the tracker to start monitoring terminal output.
   * Called automatically when Ralph patterns are detected.
   * Emits 'enabled' event when transitioning from disabled state.
   * @fires enabled
   * @fires loopUpdate
   */
  enable(): void {
    if (!this._loopState.enabled) {
      this._loopState.enabled = true;
      this._loopState.lastActivity = Date.now();
      this.emit('enabled');
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Disable the tracker to stop monitoring terminal output.
   * Terminal data will be ignored until re-enabled.
   * @fires loopUpdate
   */
  disable(): void {
    if (this._loopState.enabled) {
      this._loopState.enabled = false;
      this._loopState.lastActivity = Date.now();
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Soft reset - clears state but keeps enabled status.
   * Use when a new task/loop starts within the same session.
   *
   * Clears:
   * - All todo items
   * - Completion phrase tracking
   * - Loop state (active, iterations)
   * - Line buffer
   *
   * Preserves:
   * - Enabled status
   *
   * @fires loopUpdate
   * @fires todoUpdate
   */
  reset(): void {
    // Clear debounce timers
    this.clearDebounceTimers();

    const wasEnabled = this._loopState.enabled;
    this._loopState = createInitialRalphTrackerState();
    this._loopState.enabled = wasEnabled; // Keep enabled status
    this._todos.clear();
    this._completionPhraseCount.clear();
    this._taskNumberToContent.clear();
    this._lineBuffer = '';
    this._partialPromiseBuffer = '';
    // Reset RALPH_STATUS block state
    this._statusBlockBuffer = [];
    this._inStatusBlock = false;
    this._lastStatusBlock = null;
    this._completionIndicators = 0;
    this._exitGateMet = false;
    this._totalFilesModified = 0;
    this._totalTasksCompleted = 0;
    // Keep circuit breaker state on soft reset (it tracks across iterations)
    // Emit on next tick to prevent listeners from modifying state during reset (non-reentrant)
    const loopState = this.loopState;
    const todos = this.todos;
    process.nextTick(() => {
      this.emit('loopUpdate', loopState);
      this.emit('todoUpdate', todos);
    });
  }

  /**
   * Full reset - clears all state including enabled status.
   * Use when session is closed or completely cleared.
   * Returns tracker to initial disabled state.
   * @fires loopUpdate
   * @fires todoUpdate
   */
  fullReset(): void {
    // Clear debounce timers
    this.clearDebounceTimers();

    this._loopState = createInitialRalphTrackerState();
    this._todos.clear();
    this._completionPhraseCount.clear();
    this._taskNumberToContent.clear();
    this._todoStartTimes.clear();
    this._alternateCompletionPhrases.clear();
    this._lineBuffer = '';
    // Reset all RALPH_STATUS block and circuit breaker state
    this._statusBlockBuffer = [];
    this._inStatusBlock = false;
    this._lastStatusBlock = null;
    this._completionIndicators = 0;
    this._exitGateMet = false;
    this._totalFilesModified = 0;
    this._totalTasksCompleted = 0;
    this._circuitBreaker = createInitialCircuitBreakerStatus();
    // Emit on next tick to prevent listeners from modifying state during reset (non-reentrant)
    const loopState = this.loopState;
    const todos = this.todos;
    process.nextTick(() => {
      this.emit('loopUpdate', loopState);
      this.emit('todoUpdate', todos);
    });
  }

  /**
   * Clear all debounce timers.
   * Called during reset/fullReset to prevent stale emissions.
   */
  private clearDebounceTimers(): void {
    if (this._todoUpdateTimer) {
      clearTimeout(this._todoUpdateTimer);
      this._todoUpdateTimer = null;
    }
    if (this._loopUpdateTimer) {
      clearTimeout(this._loopUpdateTimer);
      this._loopUpdateTimer = null;
    }
    this._todoUpdatePending = false;
    this._loopUpdatePending = false;
  }

  /**
   * Emit todoUpdate event with debouncing.
   * Batches rapid consecutive calls to reduce UI jitter.
   * The event fires after EVENT_DEBOUNCE_MS of inactivity.
   */
  private emitTodoUpdateDebounced(): void {
    this._todoUpdatePending = true;

    if (this._todoUpdateTimer) {
      clearTimeout(this._todoUpdateTimer);
    }

    this._todoUpdateTimer = setTimeout(() => {
      if (this._todoUpdatePending) {
        this._todoUpdatePending = false;
        this._todoUpdateTimer = null;
        this.emit('todoUpdate', this.todos);
      }
    }, EVENT_DEBOUNCE_MS);
  }

  /**
   * Emit loopUpdate event with debouncing.
   * Batches rapid consecutive calls to reduce UI jitter.
   * The event fires after EVENT_DEBOUNCE_MS of inactivity.
   */
  private emitLoopUpdateDebounced(): void {
    this._loopUpdatePending = true;

    if (this._loopUpdateTimer) {
      clearTimeout(this._loopUpdateTimer);
    }

    this._loopUpdateTimer = setTimeout(() => {
      if (this._loopUpdatePending) {
        this._loopUpdatePending = false;
        this._loopUpdateTimer = null;
        this.emit('loopUpdate', this.loopState);
      }
    }, EVENT_DEBOUNCE_MS);
  }

  /**
   * Flush all pending debounced events immediately.
   * Useful for testing or when immediate state sync is needed.
   */
  flushPendingEvents(): void {
    if (this._todoUpdatePending) {
      this._todoUpdatePending = false;
      if (this._todoUpdateTimer) {
        clearTimeout(this._todoUpdateTimer);
        this._todoUpdateTimer = null;
      }
      this.emit('todoUpdate', this.todos);
    }
    if (this._loopUpdatePending) {
      this._loopUpdatePending = false;
      if (this._loopUpdateTimer) {
        clearTimeout(this._loopUpdateTimer);
        this._loopUpdateTimer = null;
      }
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Get a copy of the current loop state.
   * @returns Shallow copy of loop state (safe to modify)
   */
  // ========== Iteration Stall Detection Methods ==========

  /**
   * Start iteration stall detection timer.
   * Should be called when the loop becomes active.
   */
  startIterationStallDetection(): void {
    this.stopIterationStallDetection();
    this._lastIterationChangeTime = Date.now();
    this._iterationStallWarned = false;

    // Check every minute
    this._iterationStallTimer = setInterval(() => {
      this.checkIterationStall();
    }, 60 * 1000);
  }

  /**
   * Stop iteration stall detection timer.
   */
  stopIterationStallDetection(): void {
    if (this._iterationStallTimer) {
      clearInterval(this._iterationStallTimer);
      this._iterationStallTimer = null;
    }
  }

  /**
   * Check for iteration stall and emit appropriate events.
   */
  private checkIterationStall(): void {
    if (!this._loopState.active) return;

    const stallDurationMs = Date.now() - this._lastIterationChangeTime;

    // Critical stall (longer duration)
    if (stallDurationMs >= this._iterationStallCriticalMs) {
      this.emit('iterationStallCritical', {
        iteration: this._loopState.cycleCount,
        stallDurationMs,
      });
      return;
    }

    // Warning stall
    if (stallDurationMs >= this._iterationStallWarningMs && !this._iterationStallWarned) {
      this._iterationStallWarned = true;
      this.emit('iterationStallWarning', {
        iteration: this._loopState.cycleCount,
        stallDurationMs,
      });
    }
  }

  /**
   * Get iteration stall metrics for monitoring.
   */
  getIterationStallMetrics(): {
    lastIterationChangeTime: number;
    stallDurationMs: number;
    warningThresholdMs: number;
    criticalThresholdMs: number;
    isWarned: boolean;
    currentIteration: number;
  } {
    return {
      lastIterationChangeTime: this._lastIterationChangeTime,
      stallDurationMs: Date.now() - this._lastIterationChangeTime,
      warningThresholdMs: this._iterationStallWarningMs,
      criticalThresholdMs: this._iterationStallCriticalMs,
      isWarned: this._iterationStallWarned,
      currentIteration: this._loopState.cycleCount,
    };
  }

  /**
   * Configure iteration stall thresholds.
   * @param warningMs - Warning threshold in milliseconds
   * @param criticalMs - Critical threshold in milliseconds
   */
  configureIterationStallThresholds(warningMs: number, criticalMs: number): void {
    this._iterationStallWarningMs = warningMs;
    this._iterationStallCriticalMs = criticalMs;
  }

  get loopState(): RalphTrackerState {
    return {
      ...this._loopState,
      planVersion: this._planVersion,
      planHistoryLength: this._planHistory.length,
      completionConfidence: this._lastCompletionConfidence,
    };
  }

  /** Last calculated completion confidence */
  private _lastCompletionConfidence: CompletionConfidence | undefined;

  /** Confidence threshold for triggering completion (0-100) */
  private static readonly COMPLETION_CONFIDENCE_THRESHOLD = 70;

  /**
   * Calculate confidence score for a potential completion signal.
   *
   * Scoring weights:
   * - Promise tag with proper format: +30
   * - Matches expected phrase: +25
   * - All todos complete: +20
   * - EXIT_SIGNAL: true: +15
   * - Multiple completion indicators (>=2): +10
   * - Context appropriate (not in prompt/explanation): +10
   * - Loop was explicitly active: +10
   *
   * @param phrase - The detected phrase to evaluate
   * @param context - Optional surrounding context for the phrase
   * @returns CompletionConfidence assessment
   */
  calculateCompletionConfidence(phrase: string, context?: string): CompletionConfidence {
    let score = 0;
    const signals = {
      hasPromiseTag: false,
      matchesExpected: false,
      allTodosComplete: false,
      hasExitSignal: false,
      multipleIndicators: false,
      contextAppropriate: true, // Default to true, deduct if inappropriate
    };

    // Check for promise tag format (adds 30 points)
    if (context && PROMISE_PATTERN.test(context)) {
      signals.hasPromiseTag = true;
      score += 30;
    }

    // Check if phrase matches expected completion phrase (adds 25 points)
    const expectedPhrase = this._loopState.completionPhrase;
    if (expectedPhrase) {
      const matchedPhrase = this.findMatchingCompletionPhrase(phrase);
      if (matchedPhrase) {
        signals.matchesExpected = true;
        score += 25;
      }
    }

    // Check if all todos are complete (adds 20 points)
    const todoArray = Array.from(this._todos.values());
    if (todoArray.length > 0 && todoArray.every((t) => t.status === 'completed')) {
      signals.allTodosComplete = true;
      score += 20;
    }

    // Check for EXIT_SIGNAL from RALPH_STATUS block (adds 15 points)
    if (this._lastStatusBlock?.exitSignal === true) {
      signals.hasExitSignal = true;
      score += 15;
    }

    // Check for multiple completion indicators (adds 10 points)
    if (this._completionIndicators >= 2) {
      signals.multipleIndicators = true;
      score += 10;
    }

    // Check context appropriateness (deduct if inappropriate)
    if (context) {
      const lowerContext = context.toLowerCase();
      // Deduct points if phrase appears in prompt-like context
      if (
        lowerContext.includes('output:') ||
        lowerContext.includes('completion phrase') ||
        lowerContext.includes('output exactly') ||
        lowerContext.includes('when done')
      ) {
        signals.contextAppropriate = false;
        score -= 20;
      } else {
        score += 10;
      }
    }

    // Bonus for active loop state (adds 10 points)
    if (this._loopState.active) {
      score += 10;
    }

    // Bonus for 2nd+ occurrence (adds 15 points)
    const count = this._completionPhraseCount.get(phrase) || 0;
    if (count >= 2) {
      score += 15;
    }

    // Clamp score to 0-100
    score = Math.max(0, Math.min(100, score));

    const confidence: CompletionConfidence = {
      score,
      isConfident: score >= RalphTracker.COMPLETION_CONFIDENCE_THRESHOLD,
      signals,
      calculatedAt: Date.now(),
    };

    this._lastCompletionConfidence = confidence;
    return confidence;
  }

  /**
   * Get all tracked todo items as an array.
   * @returns Array of todo items (copy, safe to modify)
   */
  get todos(): RalphTodoItem[] {
    return Array.from(this._todos.values());
  }

  /**
   * Process raw terminal data to detect inner loop patterns.
   *
   * This is the main entry point for parsing output. Call this with each
   * chunk of data from the PTY. The tracker will:
   *
   * 1. Strip ANSI escape codes
   * 2. Auto-enable if disabled and Ralph patterns detected
   * 3. Buffer data and process complete lines
   * 4. Detect loop status, todos, and completion phrases
   * 5. Periodically clean up expired todos
   *
   * @param data - Raw terminal data (may include ANSI codes)
   * @fires loopUpdate - When loop state changes
   * @fires todoUpdate - When todos are detected or updated
   * @fires completionDetected - When completion phrase found
   * @fires enabled - When tracker auto-enables
   */
  processTerminalData(data: string): void {
    // Remove ANSI escape codes for cleaner parsing
    const cleanData = data.replace(ANSI_ESCAPE_PATTERN_SIMPLE, '');
    this.processCleanData(cleanData);
  }

  /**
   * Process pre-stripped terminal data (ANSI codes already removed).
   * Use this when the caller has already stripped ANSI to avoid redundant regex work.
   */
  processCleanData(cleanData: string): void {
    // If tracker is disabled, only check for patterns that should auto-enable it
    if (!this._loopState.enabled) {
      // Don't auto-enable if explicitly disabled by user setting
      if (this._autoEnableDisabled) {
        return;
      }
      if (this.shouldAutoEnable(cleanData)) {
        this.enable();
        // Continue processing now that we're enabled
      } else {
        return; // Don't process further when disabled
      }
    }

    // Buffer data for line-based processing
    this._lineBuffer += cleanData;

    // Prevent unbounded line buffer growth from very long lines
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      // Truncate to last portion to preserve recent data
      this._lineBuffer = this._lineBuffer.slice(-Math.floor(MAX_LINE_BUFFER_SIZE / 2));
    }

    // Process complete lines
    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      this.processLine(line);
    }

    // Also check the current buffer for multi-line patterns
    this.checkMultiLinePatterns(cleanData);

    // Cleanup expired todos (throttled to avoid running on every chunk)
    this.maybeCleanupExpiredTodos();
  }

  /**
   * Check if data contains patterns that should auto-enable the tracker.
   *
   * The tracker auto-enables when any of these patterns are detected:
   * - `/ralph-loop:ralph-loop` command
   * - `<promise>PHRASE</promise>` completion tags
   * - TodoWrite tool usage indicators
   * - Iteration patterns (`Iteration 5/50`, `[5/50]`)
   * - Todo checkboxes (`- [ ]`, `- [x]`)
   * - Todo indicator icons (`☐`, `◐`, `☒`)
   * - Loop start messages (`Loop started at`)
   * - All tasks complete announcements
   * - Task completion signals
   *
   * @param data - ANSI-cleaned terminal data
   * @returns True if any Ralph-related pattern is detected
   */
  private shouldAutoEnable(data: string): boolean {
    // Cheap pre-filter: skip the full regex battery if none of the key
    // substrings that any pattern could match are present in the data.
    // This avoids 12 regex tests on every PTY chunk (the common case).
    if (
      !data.includes('<') && // <promise>, TodoWrite
      !data.includes('ralph') &&
      !data.includes('Ralph') &&
      !data.includes('Todo') &&
      !data.includes('todo') &&
      !data.includes('Iteration') &&
      !data.includes('[') &&
      !data.includes('\u2610') &&
      !data.includes('\u2612') && // ☐ ☒
      !data.includes('\u2714') && // ✔
      !data.includes('Loop') &&
      !data.includes('complete') &&
      !data.includes('COMPLETE') &&
      !data.includes('Done') &&
      !data.includes('DONE')
    ) {
      return false;
    }

    // Ralph loop command: /ralph-loop:ralph-loop
    if (RALPH_START_PATTERN.test(data)) {
      return true;
    }

    // Completion phrase: <promise>...</promise>
    if (PROMISE_PATTERN.test(data)) {
      return true;
    }

    // TodoWrite tool usage
    if (TODOWRITE_PATTERN.test(data)) {
      return true;
    }

    // Iteration patterns from Ralph loop: "Iteration 5/50", "[5/50]"
    if (ITERATION_PATTERN.test(data)) {
      return true;
    }

    // Todo checkboxes: "- [ ] Task" or "- [x] Task"
    // Reset lastIndex BEFORE test to ensure consistent matching with /g flag patterns
    TODO_CHECKBOX_PATTERN.lastIndex = 0;
    if (TODO_CHECKBOX_PATTERN.test(data)) {
      return true;
    }

    // Todo indicator icons: "Todo: ☐", "Todo: ◐", etc.
    TODO_INDICATOR_PATTERN.lastIndex = 0;
    if (TODO_INDICATOR_PATTERN.test(data)) {
      return true;
    }

    // Claude Code native todo format: "☐ Task", "☒ Task"
    TODO_NATIVE_PATTERN.lastIndex = 0;
    if (TODO_NATIVE_PATTERN.test(data)) {
      return true;
    }

    // Claude Code checkmark-based TodoWrite: "✔ Task #N created:", "✔ Task #N updated:"
    TODO_TASK_CREATED_PATTERN.lastIndex = 0;
    if (TODO_TASK_CREATED_PATTERN.test(data)) {
      return true;
    }
    TODO_TASK_STATUS_PATTERN.lastIndex = 0;
    if (TODO_TASK_STATUS_PATTERN.test(data)) {
      return true;
    }

    // Loop start patterns (e.g., "Loop started at", "Starting Ralph loop")
    if (LOOP_START_PATTERN.test(data)) {
      return true;
    }

    // All tasks complete signals
    if (ALL_COMPLETE_PATTERN.test(data)) {
      return true;
    }

    // Task completion signals
    if (TASK_DONE_PATTERN.test(data)) {
      return true;
    }

    return false;
  }

  /**
   * Process a single line of terminal output.
   * Runs all detection methods in sequence.
   * @param line - Single line of ANSI-cleaned terminal output
   */
  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Check for RALPH_STATUS block (structured status reporting)
    this.processStatusBlockLine(trimmed);

    // Check for completion indicators (for dual-condition exit gate)
    this.detectCompletionIndicators(trimmed);

    // Check for completion phrase
    this.detectCompletionPhrase(trimmed);

    // Check for "all tasks complete" signals
    this.detectAllTasksComplete(trimmed);

    // Check for individual task completion signals
    this.detectTaskCompletion(trimmed);

    // Check for loop start/status
    this.detectLoopStatus(trimmed);

    // Check for todo items
    this.detectTodoItems(trimmed);
  }

  /**
   * Detect "all tasks complete" messages.
   *
   * When a valid "all complete" message is detected:
   * 1. Marks all tracked todos as completed
   * 2. Emits completion event if a completion phrase is set
   *
   * Validation criteria:
   * - Line must match ALL_COMPLETE_PATTERN
   * - Line must be reasonably short (<100 chars) to avoid matching commentary
   * - Must not look like prompt text (no "output:" or `<promise>`)
   * - Must have at least one tracked todo
   * - If count is mentioned, should roughly match tracked todo count
   *
   * @param line - Single line to check
   * @fires todoUpdate - If any todos marked complete
   * @fires completionDetected - If completion phrase was set
   * @fires loopUpdate - If loop state changes
   */
  private detectAllTasksComplete(line: string): void {
    // When @fix_plan.md is active, only trust the file for todo status
    // This prevents false positives from Claude saying "all done" in conversation
    if (this.isFileAuthoritative) return;

    // Only trigger if line is a clear standalone completion message
    // Avoid matching commentary like "once all tasks are complete..."
    if (!ALL_COMPLETE_PATTERN.test(line)) return;

    // Must be a reasonably short line (< 100 chars) to be a completion signal, not commentary
    if (line.length > 100) return;

    // Skip if this looks like it's part of the original prompt (contains "output:")
    if (line.toLowerCase().includes('output:') || line.includes('<promise>')) return;

    // Don't trigger if we haven't seen any todos yet
    if (this._todos.size === 0) return;

    // Check if the count matches our todo count (e.g., "All 8 files created")
    const countMatch = line.match(ALL_COUNT_PATTERN);
    const parsedCount = countMatch ? parseInt(countMatch[1], 10) : NaN;
    const mentionedCount = Number.isNaN(parsedCount) ? null : parsedCount;
    const todoCount = this._todos.size;

    // If a count is mentioned, it should match our todo count (within reason)
    if (mentionedCount !== null && Math.abs(mentionedCount - todoCount) > 2) {
      // Count doesn't match our todos, might be unrelated
      return;
    }

    // Mark all todos as complete
    let updated = false;
    for (const todo of this._todos.values()) {
      if (todo.status !== 'completed') {
        todo.status = 'completed';
        updated = true;
      }
    }
    if (updated) {
      this.emit('todoUpdate', this.todos);
    }

    // Emit completion if we have an expected phrase
    if (this._loopState.completionPhrase) {
      this._loopState.active = false;
      this._loopState.lastActivity = Date.now();
      this.emit('completionDetected', this._loopState.completionPhrase);
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Detect individual task completion signals
   * e.g., "Task 8 is done", "marked as completed"
   *
   * NOTE: This is intentionally conservative to avoid jitter.
   * Only marks a todo complete if we can match it by task number.
   */
  private detectTaskCompletion(line: string): void {
    // When @fix_plan.md is active, only trust the file for todo status
    if (this.isFileAuthoritative) return;

    if (!TASK_DONE_PATTERN.test(line)) return;

    // Only act on explicit task number references like "Task 8 is done"
    const taskNumMatch = line.match(/task\s*#?(\d+)/i);
    if (taskNumMatch) {
      const taskNum = parseInt(taskNumMatch[1], 10);
      if (Number.isNaN(taskNum)) return;
      // Find the nth todo (by order) and mark it complete
      let count = 0;
      for (const [_id, todo] of this._todos) {
        count++;
        if (count === taskNum && todo.status !== 'completed') {
          todo.status = 'completed';
          this.emit('todoUpdate', this.todos);
          break;
        }
      }
    }
    // Don't guess which todo to mark - let the checkbox detection handle it
  }

  /**
   * Check for multi-line patterns that might span line boundaries.
   * Completion phrases can be split across PTY chunks.
   *
   * Handles cross-chunk promise tags by:
   * 1. Checking combined buffer + new data for complete tags
   * 2. Detecting partial tags at end of chunk and buffering
   * 3. Clearing buffer when complete tag found or buffer gets stale
   *
   * @param data - The full data chunk (may contain multiple lines)
   */
  private checkMultiLinePatterns(data: string): void {
    // Only try to complete a cross-chunk promise if we have a partial buffer.
    // Without a partial buffer, complete tags are already handled by processLine
    // via detectCompletionPhrase — re-detecting here would double-count.
    if (this._partialPromiseBuffer) {
      const combinedData = this._partialPromiseBuffer + data;
      const promiseMatch = combinedData.match(PROMISE_PATTERN);
      if (promiseMatch) {
        const phrase = promiseMatch[1].trim();
        this._partialPromiseBuffer = '';
        this.handleCompletionPhrase(phrase);
        return;
      }
    }

    // Check for partial promise tag at end of data (for next chunk)
    const partialMatch = data.match(PROMISE_PARTIAL_PATTERN);
    if (partialMatch) {
      const partialContent = partialMatch[0];
      if (partialContent.length <= RalphTracker.MAX_PARTIAL_PROMISE_SIZE) {
        this._partialPromiseBuffer = partialContent;
      } else {
        this._partialPromiseBuffer = '';
      }
    } else {
      this._partialPromiseBuffer = '';
    }
  }

  /**
   * Detect completion phrases in a line.
   *
   * Handles two formats:
   * 1. Tagged: `<promise>PHRASE</promise>` - Processed via handleCompletionPhrase
   * 2. Bare: Just `PHRASE` - Only if we already know the expected phrase
   *
   * Bare phrase detection avoids false positives by requiring:
   * - The phrase was previously seen in tagged form
   * - Line is standalone or ends with the phrase
   * - Line doesn't look like prompt context
   *
   * @param line - Single line to check
   */
  private detectCompletionPhrase(line: string): void {
    // First check for tagged phrase: <promise>PHRASE</promise>
    const match = line.match(PROMISE_PATTERN);
    if (match) {
      this.handleCompletionPhrase(match[1]);
      return;
    }

    // If we have an expected completion phrase, also check for bare phrase
    // This handles cases where Claude outputs "ALL_TASKS_DONE" without the tags
    const expectedPhrase = this._loopState.completionPhrase;
    if (expectedPhrase && line.toUpperCase().includes(expectedPhrase.toUpperCase())) {
      // Avoid false positives: don't trigger on prompt context
      const isNotInPromptContext = !line.includes('<promise>') && !line.includes('output:');
      // Also avoid triggering on "completion phrase is X" explanatory text
      const isNotExplanation =
        !line.toLowerCase().includes('completion phrase') &&
        !line.toLowerCase().includes('output exactly');

      if (isNotInPromptContext && isNotExplanation) {
        this.handleBareCompletionPhrase(expectedPhrase);
      }
    }
  }

  /**
   * Handle a bare completion phrase (without XML tags).
   *
   * Only fires completion if:
   * 1. The phrase was previously seen in tagged form (from prompt)
   * 2. This is the first bare occurrence (prevents double-firing)
   *
   * When triggered:
   * - Marks all todos as complete
   * - Emits completionDetected event
   * - Sets loop to inactive
   *
   * @param phrase - The completion phrase text
   * @fires todoUpdate - If any todos marked complete
   * @fires completionDetected - When completion triggered
   * @fires loopUpdate - When loop state changes
   */
  private handleBareCompletionPhrase(phrase: string): void {
    // Allow bare phrase detection if:
    // 1. Loop is explicitly active (via startLoop()) - phrase was set programmatically
    // 2. OR phrase was seen in tagged form (from terminal output)
    const taggedCount = this._completionPhraseCount.get(phrase) || 0;
    const loopExplicitlyActive = this._loopState.active;

    if (taggedCount === 0 && !loopExplicitlyActive) return;

    // Track bare occurrences to avoid double-firing
    const bareKey = `bare:${phrase}`;
    const bareCount = (this._completionPhraseCount.get(bareKey) || 0) + 1;
    this._completionPhraseCount.set(bareKey, bareCount);

    // Only fire once for bare phrase
    if (bareCount > 1) return;

    // Mark all todos as complete (since we've reached the completion phrase)
    let updated = false;
    for (const todo of this._todos.values()) {
      if (todo.status !== 'completed') {
        todo.status = 'completed';
        updated = true;
      }
    }
    if (updated) {
      this.emit('todoUpdate', this.todos);
    }

    // Emit completion event
    this._loopState.active = false;
    this._loopState.lastActivity = Date.now();
    this.emit('completionDetected', phrase);
    this.emit('loopUpdate', this.loopState);
  }

  /**
   * Handle a detected completion phrase
   *
   * Uses occurrence-based detection combined with confidence scoring
   * to distinguish prompt from actual completion:
   * - 1st occurrence: Store as expected phrase (likely in prompt)
   * - 2nd occurrence OR high confidence: Emit completionDetected (actual completion)
   * - If loop already active: Emit immediately (explicit loop start)
   */
  private handleCompletionPhrase(phrase: string): void {
    const count = (this._completionPhraseCount.get(phrase) || 0) + 1;
    this._completionPhraseCount.set(phrase, count);

    // Trim completion phrase map if it exceeds the limit
    if (this._completionPhraseCount.size > MAX_COMPLETION_PHRASE_ENTRIES) {
      // Keep only the most important entries (current expected phrase and highest counts)
      const entries = Array.from(this._completionPhraseCount.entries());
      entries.sort((a, b) => b[1] - a[1]); // Sort by count descending
      this._completionPhraseCount.clear();
      // Keep top half of entries
      const keepCount = Math.floor(MAX_COMPLETION_PHRASE_ENTRIES / 2);
      for (let i = 0; i < Math.min(keepCount, entries.length); i++) {
        this._completionPhraseCount.set(entries[i][0], entries[i][1]);
      }
      // Always keep the expected phrase if set
      if (
        this._loopState.completionPhrase &&
        !this._completionPhraseCount.has(this._loopState.completionPhrase)
      ) {
        this._completionPhraseCount.set(this._loopState.completionPhrase, 1);
      }
    }

    // Store phrase on first occurrence
    if (!this._loopState.completionPhrase) {
      this._loopState.completionPhrase = phrase;
      this._loopState.lastActivity = Date.now();

      // P1-002: Validate phrase and emit warning if risky
      this.validateCompletionPhrase(phrase);

      this.emit('loopUpdate', this.loopState);
    }

    // Check for fuzzy match with primary phrase or any alternate phrase (P1-003)
    // This handles minor variations like whitespace, case, underscores vs hyphens
    const matchedPhrase = this.findMatchingCompletionPhrase(phrase);

    if (matchedPhrase) {
      // Use the matched phrase (canonical) for tracking
      const canonicalCount = this._completionPhraseCount.get(matchedPhrase) || 0;
      // Require 2nd+ occurrence of canonical phrase OR explicitly active loop.
      // First occurrence (count=1) is the prompt echo — not actual completion.
      if (canonicalCount >= 2 || this._loopState.active) {
        // Mark as completion
        this._loopState.active = false;
        this._loopState.lastActivity = Date.now();
        // Mark all todos as complete
        let updated = false;
        for (const todo of this._todos.values()) {
          if (todo.status !== 'completed') {
            todo.status = 'completed';
            updated = true;
          }
        }
        if (updated) {
          this.emit('todoUpdate', this.todos);
        }
        this.emit('completionDetected', matchedPhrase);
        this.emit('loopUpdate', this.loopState);
        return;
      }
    }

    // Emit completion if loop is active OR this is 2nd+ occurrence
    if (this._loopState.active || count >= 2) {
      // Mark all todos as complete when completion phrase is detected
      let updated = false;
      for (const todo of this._todos.values()) {
        if (todo.status !== 'completed') {
          todo.status = 'completed';
          updated = true;
        }
      }
      if (updated) {
        this.emit('todoUpdate', this.todos);
      }

      this._loopState.active = false;
      this._loopState.lastActivity = Date.now();
      this.emit('completionDetected', phrase);
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Check if two phrases match with fuzzy tolerance.
   * Handles variations in:
   * - Case (COMPLETE vs Complete)
   * - Whitespace (TASK_DONE vs TASK DONE)
   * - Separators (TASK_DONE vs TASK-DONE)
   * - Minor typos with Levenshtein distance (COMPLET vs COMPLETE)
   *
   * @param phrase1 - First phrase to compare
   * @param phrase2 - Second phrase to compare
   * @param maxDistance - Maximum edit distance for fuzzy match (default: 2)
   * @returns True if phrases are fuzzy-equal
   */
  private isFuzzyPhraseMatch(phrase1: string, phrase2: string, maxDistance = 2): boolean {
    return fuzzyPhraseMatch(phrase1, phrase2, maxDistance);
  }

  /**
   * Validate a completion phrase and emit warnings if it's risky.
   *
   * P1-002: Configurable false positive prevention
   *
   * Checks for:
   * - Common/generic phrases (DONE, COMPLETE, etc.)
   * - Short phrases (< MIN_RECOMMENDED_PHRASE_LENGTH)
   * - Numeric-only phrases
   *
   * @param phrase - The completion phrase to validate
   * @fires phraseValidationWarning - When a risky phrase is detected
   */
  private validateCompletionPhrase(phrase: string): void {
    const normalized = phrase.toUpperCase().replace(/[\s_\-.]+/g, '');

    // Generate a suggested unique phrase
    const uniqueSuffix = Date.now().toString(36).slice(-4).toUpperCase();
    const suggestedPhrase = `${phrase}_${uniqueSuffix}`;

    // Check for common phrases
    if (COMMON_COMPLETION_PHRASES.has(normalized)) {
      console.warn(
        `[RalphTracker] Warning: Completion phrase "${phrase}" is very common and may cause false positives. Consider using: "${suggestedPhrase}"`
      );
      this.emit('phraseValidationWarning', {
        phrase,
        reason: 'common',
        suggestedPhrase,
      });
      return;
    }

    // Check for short phrases
    if (normalized.length < MIN_RECOMMENDED_PHRASE_LENGTH) {
      console.warn(
        `[RalphTracker] Warning: Completion phrase "${phrase}" is too short (${normalized.length} chars). Consider using: "${suggestedPhrase}"`
      );
      this.emit('phraseValidationWarning', {
        phrase,
        reason: 'short',
        suggestedPhrase,
      });
      return;
    }

    // Check for numeric-only phrases
    if (/^\d+$/.test(normalized)) {
      console.warn(
        `[RalphTracker] Warning: Completion phrase "${phrase}" is numeric-only and may cause false positives. Consider using: "${suggestedPhrase}"`
      );
      this.emit('phraseValidationWarning', {
        phrase,
        reason: 'numeric',
        suggestedPhrase,
      });
    }
  }

  /**
   * Activate the loop if not already active.
   *
   * Sets loop state to active and initializes counters.
   * No-op if loop is already active.
   *
   * @returns True if loop was activated, false if already active
   * @fires loopUpdate - When loop state changes
   */
  private activateLoopIfNeeded(): boolean {
    if (this._loopState.active) return false;

    this._loopState.active = true;
    this._loopState.startedAt = Date.now();
    this._loopState.cycleCount = 0;
    this._loopState.maxIterations = null;
    this._loopState.elapsedHours = null;
    this._loopState.lastActivity = Date.now();
    this.emit('loopUpdate', this.loopState);
    return true;
  }

  /**
   * Detect loop start and status indicators.
   *
   * Patterns detected:
   * - Ralph loop start commands (`/ralph-loop:ralph-loop`)
   * - Loop start messages (`Loop started at`, `Starting Ralph loop`)
   * - Max iterations setting (`max-iterations 50`)
   * - Iteration progress (`Iteration 5/50`, `[5/50]`)
   * - Elapsed time (`Elapsed: 2.5 hours`)
   * - Cycle count (`cycle #5`, `respawn cycle #3`)
   * - TodoWrite tool usage
   *
   * @param line - Single line to check
   * @fires loopUpdate - When any loop state changes
   */
  private detectLoopStatus(line: string): void {
    // Check for Ralph loop start command (/ralph-loop:ralph-loop)
    // or generic loop start patterns ("Loop started at", "Starting Ralph loop")
    if (RALPH_START_PATTERN.test(line) || LOOP_START_PATTERN.test(line)) {
      this.activateLoopIfNeeded();
    }

    // Check for max iterations setting
    const maxIterMatch = line.match(MAX_ITERATIONS_PATTERN);
    if (maxIterMatch) {
      const maxIter = parseInt(maxIterMatch[1], 10);
      if (!Number.isNaN(maxIter) && maxIter > 0) {
        this._loopState.maxIterations = maxIter;
        this._loopState.lastActivity = Date.now();
        // Use debounced emit for settings changes
        this.emitLoopUpdateDebounced();
      }
    }

    // Check for iteration patterns: "Iteration 5/50", "[5/50]"
    const iterMatch = line.match(ITERATION_PATTERN);
    if (iterMatch) {
      // Pattern captures: group 1&2 for "Iteration X/Y", group 3&4 for "[X/Y]"
      const currentIter = parseInt(iterMatch[1] || iterMatch[3], 10);
      const maxIterStr = iterMatch[2] || iterMatch[4];
      const maxIter = maxIterStr ? parseInt(maxIterStr, 10) : null;

      if (!Number.isNaN(currentIter)) {
        this.activateLoopIfNeeded();
        // Track iteration changes for stall detection
        if (currentIter !== this._lastObservedIteration) {
          this._lastIterationChangeTime = Date.now();
          this._lastObservedIteration = currentIter;
          this._iterationStallWarned = false; // Reset warning on iteration change

          // P1-004: Reset circuit breaker on successful iteration progress
          // If we're making progress, the loop is healthy
          if (
            this._circuitBreaker.state === 'HALF_OPEN' ||
            this._circuitBreaker.consecutiveNoProgress > 0 ||
            this._circuitBreaker.consecutiveSameError > 0 ||
            this._circuitBreaker.consecutiveTestsFailure > 0
          ) {
            this._circuitBreaker.consecutiveNoProgress = 0;
            this._circuitBreaker.consecutiveSameError = 0;
            this._circuitBreaker.lastProgressIteration = currentIter;
            if (this._circuitBreaker.state === 'HALF_OPEN') {
              this._circuitBreaker.state = 'CLOSED';
              this._circuitBreaker.reason = 'Iteration progress detected';
              this._circuitBreaker.reasonCode = 'progress_detected';
              this.emit('circuitBreakerUpdate', { ...this._circuitBreaker });
            }
          }
        }
        this._loopState.cycleCount = currentIter;
        if (maxIter !== null && !Number.isNaN(maxIter)) {
          this._loopState.maxIterations = maxIter;
        }
        this._loopState.lastActivity = Date.now();
        // Use debounced emit for rapid iteration updates
        this.emitLoopUpdateDebounced();
      }
    }

    // Check for elapsed time
    const elapsedMatch = line.match(ELAPSED_TIME_PATTERN);
    if (elapsedMatch) {
      this._loopState.elapsedHours = parseFloat(elapsedMatch[1]);
      this._loopState.lastActivity = Date.now();
      // Use debounced emit for elapsed time updates
      this.emitLoopUpdateDebounced();
    }

    // Check for cycle count (legacy pattern)
    const cycleMatch = line.match(CYCLE_PATTERN);
    if (cycleMatch) {
      const cycleNum = parseInt(cycleMatch[1] || cycleMatch[2], 10);
      if (!Number.isNaN(cycleNum) && cycleNum > this._loopState.cycleCount) {
        this._loopState.cycleCount = cycleNum;
        this._loopState.lastActivity = Date.now();
        // Use debounced emit for cycle updates
        this.emitLoopUpdateDebounced();
      }
    }

    // Check for TodoWrite tool usage - indicates active task tracking
    if (TODOWRITE_PATTERN.test(line)) {
      this._loopState.lastActivity = Date.now();
      // Don't emit update just for activity, let todo detection handle it
    }
  }

  /**
   * Detect todo items in various formats from Claude Code output.
   *
   * Supported formats:
   * - Format 1: Checkbox markdown (`- [ ] Task`, `- [x] Task`)
   * - Format 2: Indicator icons (`Todo: ☐ Task`, `Todo: ✓ Task`)
   * - Format 3: Status in parentheses (`- Task (pending)`)
   * - Format 4: Native TodoWrite (`☐ Task`, `☒ Task`, `◐ Task`)
   *
   * Uses quick pre-check to skip lines that can't contain todos.
   * Excludes tool invocations and Claude commentary patterns.
   *
   * @param line - Single line to check
   * @fires todoUpdate - When any todos are detected or updated
   */
  private detectTodoItems(line: string): void {
    // Pre-compute which pattern categories might match (60-75% faster)
    const hasCheckbox = line.includes('[');
    const hasTodoIndicator = line.includes('Todo:');
    const hasNativeCheckbox =
      line.includes('☐') || line.includes('☒') || line.includes('◐') || line.includes('✓');
    const hasStatus =
      line.includes('(pending)') || line.includes('(in_progress)') || line.includes('(completed)');
    const hasCheckmark = line.includes('✔');

    // Quick check: skip lines that can't possibly contain todos
    if (!hasCheckbox && !hasTodoIndicator && !hasNativeCheckbox && !hasStatus && !hasCheckmark) {
      return;
    }

    let updated = false;
    let match: RegExpExecArray | null;

    // Format 1: Checkbox format "- [ ] Task" or "- [x] Task"
    // Only scan if line contains '[' character
    if (hasCheckbox) {
      TODO_CHECKBOX_PATTERN.lastIndex = 0;
      while ((match = TODO_CHECKBOX_PATTERN.exec(line)) !== null) {
        const checked = match[1].toLowerCase() === 'x';
        const content = match[2].trim();
        const status: RalphTodoStatus = checked ? 'completed' : 'pending';
        this.upsertTodo(content, status);
        updated = true;
      }
    }

    // Format 2: Todo with indicator icons
    // Only scan if line contains 'Todo:' prefix
    if (hasTodoIndicator) {
      TODO_INDICATOR_PATTERN.lastIndex = 0;
      while ((match = TODO_INDICATOR_PATTERN.exec(line)) !== null) {
        const icon = match[1];
        const content = match[2].trim();
        const status = this.iconToStatus(icon);
        this.upsertTodo(content, status);
        updated = true;
      }
    }

    // Format 3: Status in parentheses
    // Only scan if line contains status in parentheses
    if (hasStatus) {
      TODO_STATUS_PATTERN.lastIndex = 0;
      while ((match = TODO_STATUS_PATTERN.exec(line)) !== null) {
        const content = match[1].trim();
        const status = match[2] as RalphTodoStatus;
        this.upsertTodo(content, status);
        updated = true;
      }
    }

    // Format 4: Claude Code native TodoWrite output (☐, ☒, ◐)
    // Only scan if line contains native checkbox icons
    if (hasNativeCheckbox) {
      TODO_NATIVE_PATTERN.lastIndex = 0;
      while ((match = TODO_NATIVE_PATTERN.exec(line)) !== null) {
        const icon = match[1];
        const content = match[2].trim();

        // Skip if content matches exclude patterns (tool invocations, commentary)
        const shouldExclude = TODO_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content));
        if (shouldExclude) continue;

        // Skip if content is too short or looks like partial garbage
        if (content.length < 5) continue;

        const status = this.iconToStatus(icon);
        this.upsertTodo(content, status);
        updated = true;
      }
    }

    // Format 5: Claude Code checkmark-based TodoWrite output (✔ Task #N)
    // Handles: "✔ Task #N created: content", "✔ #N content", "✔ Task #N updated: status → X"
    if (hasCheckmark) {
      // Task creation: "✔ Task #1 created: Fix the bug"
      TODO_TASK_CREATED_PATTERN.lastIndex = 0;
      while ((match = TODO_TASK_CREATED_PATTERN.exec(line)) !== null) {
        const taskNum = parseInt(match[1], 10);
        const content = match[2].trim();
        if (content.length >= 5) {
          this._taskNumberToContent.set(taskNum, content);
          this.enforceTaskMappingLimit();
          this.upsertTodo(content, 'pending');
          updated = true;
        }
      }

      // Task summary: "✔ #1 Fix the bug"
      TODO_TASK_SUMMARY_PATTERN.lastIndex = 0;
      while ((match = TODO_TASK_SUMMARY_PATTERN.exec(line)) !== null) {
        const taskNum = parseInt(match[1], 10);
        const content = match[2].trim();
        if (content.length >= 5) {
          // Only register if not already known from a "created" line
          if (!this._taskNumberToContent.has(taskNum)) {
            this._taskNumberToContent.set(taskNum, content);
            this.enforceTaskMappingLimit();
          }
          this.upsertTodo(this._taskNumberToContent.get(taskNum) || content, 'pending');
          updated = true;
        }
      }

      // Status update: "✔ Task #1 updated: status → completed"
      TODO_TASK_STATUS_PATTERN.lastIndex = 0;
      while ((match = TODO_TASK_STATUS_PATTERN.exec(line)) !== null) {
        const taskNum = parseInt(match[1], 10);
        const statusStr = match[2].trim();
        const status: RalphTodoStatus =
          statusStr === 'completed'
            ? 'completed'
            : statusStr === 'in progress'
              ? 'in_progress'
              : 'pending';
        const content = this._taskNumberToContent.get(taskNum);
        if (content) {
          this.upsertTodo(content, status);
          updated = true;
        }
      }

      // Plain checkmark: "✔ Create hello.txt" (no task number)
      // Only match if numbered patterns didn't already match on this line
      if (!updated) {
        TODO_PLAIN_CHECKMARK_PATTERN.lastIndex = 0;
        while ((match = TODO_PLAIN_CHECKMARK_PATTERN.exec(line)) !== null) {
          const content = match[1].trim();
          // Skip if content matches exclude patterns
          const shouldExclude = TODO_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content));
          if (shouldExclude) continue;
          if (content.length < 5) continue;
          // Skip status/created/updated prefixed content (already handled above)
          if (/^(Task\s*#\d+|#\d+)\s/.test(content)) continue;
          this.upsertTodo(content, 'completed');
          updated = true;
        }
      }
    }

    if (updated) {
      // Use debounced emit to batch rapid todo updates and reduce UI jitter
      this.emitTodoUpdateDebounced();
    }
  }

  /**
   * Convert a todo icon character to its corresponding status.
   *
   * Icon mappings:
   * - Completed: `✓`, `✅`, `☒`, `◉`, `●`
   * - In Progress: `◐`, `⏳`, `⌛`, `🔄`
   * - Pending: `☐`, `○`, and anything else (default)
   *
   * @param icon - Single character icon
   * @returns Corresponding RalphTodoStatus
   */
  private iconToStatus(icon: string): RalphTodoStatus {
    switch (icon) {
      case '✓':
      case '✅':
      case '☒': // Claude Code checked checkbox
      case '◉': // Filled circle (completed)
      case '●': // Solid circle (completed)
        return 'completed';
      case '◐': // Half-filled circle (in progress)
      case '⏳':
      case '⌛':
      case '🔄':
        return 'in_progress';
      case '☐': // Claude Code empty checkbox
      case '○': // Empty circle
      default:
        return 'pending';
    }
  }

  /**
   * Parse priority from todo content.
   * P1-008: Enhanced keyword-based priority inference.
   *
   * Priority levels:
   * - P0 (Critical): Explicit P0, "critical", "blocker", "urgent", "security", "crash", "broken"
   * - P1 (High): Explicit P1, "important", "high priority", "bug", "fix", "error", "fail"
   * - P2 (Medium): Explicit P2, "nice to have", "low priority", "refactor", "cleanup", "improve"
   *
   * @param content - Todo content text
   * @returns Parsed priority level or null
   */
  private parsePriority(content: string): RalphTodoPriority {
    const upper = content.toUpperCase();

    // Check P0 first (highest priority wins)
    // Uses pre-compiled module-level patterns for performance
    for (const pattern of P0_PRIORITY_PATTERNS) {
      if (pattern.test(upper)) {
        return 'P0';
      }
    }

    // Check P1
    for (const pattern of P1_PRIORITY_PATTERNS) {
      if (pattern.test(upper)) {
        return 'P1';
      }
    }

    // Check P2
    for (const pattern of P2_PRIORITY_PATTERNS) {
      if (pattern.test(upper)) {
        return 'P2';
      }
    }

    return null;
  }

  /**
   * Add a new todo item or update an existing one.
   *
   * Behavior:
   * - Content is cleaned (ANSI removed, whitespace collapsed)
   * - Content under 5 chars is skipped
   * - ID is generated from normalized content (stable hash)
   * - Priority is parsed from content (P0/P1/P2, Critical, High Priority, etc.)
   * - Existing item: Updates status and timestamp
   * - New item: Adds to map, evicts oldest if at MAX_TODOS_PER_SESSION
   *
   * @param content - Raw todo content text
   * @param status - Status to set
   */
  private upsertTodo(content: string, status: RalphTodoStatus): void {
    // Skip empty or whitespace-only content
    if (!content || !content.trim()) return;

    // Clean content: remove ANSI codes, collapse whitespace, trim
    const cleanContent = content
      .replace(ANSI_ESCAPE_PATTERN_SIMPLE, '') // Remove ANSI escape codes
      .replace(/\s+/g, ' ') // Collapse whitespace
      .trim();
    if (cleanContent.length < 5) return; // Skip very short content

    // Parse priority from content
    const priority = this.parsePriority(cleanContent);

    // P1-009: Estimate complexity for duration tracking
    const estimatedComplexity = this.estimateComplexity(cleanContent);

    // Generate a stable ID from normalized content
    const id = this.generateTodoId(cleanContent);

    const existing = this._todos.get(id);
    if (existing) {
      // P1-009: Track status transitions for progress estimation
      const wasCompleted = existing.status === 'completed';
      const isNowCompleted = status === 'completed';
      const wasInProgress = existing.status === 'in_progress';
      const isNowInProgress = status === 'in_progress';

      // Update existing todo (exact match by ID)
      existing.status = status;
      existing.detectedAt = Date.now();
      // Update priority if parsed (don't overwrite with null)
      if (priority) existing.priority = priority;
      // Update complexity estimate if not already set
      if (!existing.estimatedComplexity) {
        existing.estimatedComplexity = estimatedComplexity;
      }

      // P1-009: Track completion time
      if (!wasCompleted && isNowCompleted) {
        this.recordTodoCompletion(id);
      }
      // P1-009: Start tracking when status changes to in_progress
      if (!wasInProgress && isNowInProgress) {
        this.startTrackingTodo(id);
      }
    } else {
      // P1-007: Check for similar existing todo (deduplication)
      const similar = this.findSimilarTodo(cleanContent);
      if (similar) {
        // P1-009: Track status transitions on similar todo
        const wasCompleted = similar.status === 'completed';
        const isNowCompleted = status === 'completed';
        const wasInProgress = similar.status === 'in_progress';
        const isNowInProgress = status === 'in_progress';

        // Update similar todo instead of creating duplicate
        similar.status = status;
        similar.detectedAt = Date.now();
        // Update priority if new content has priority and existing doesn't
        if (priority && !similar.priority) {
          similar.priority = priority;
        }
        // Keep the longer/more descriptive content
        if (cleanContent.length > similar.content.length) {
          similar.content = cleanContent;
        }

        // P1-009: Track completion time
        if (!wasCompleted && isNowCompleted) {
          this.recordTodoCompletion(similar.id);
        }
        if (!wasInProgress && isNowInProgress) {
          this.startTrackingTodo(similar.id);
        }
        return;
      }

      // Add new todo with guaranteed eviction if at capacity
      // Use while loop to ensure we always have room (handles edge case where findOldestTodo returns undefined)
      while (this._todos.size >= MAX_TODOS_PER_SESSION) {
        const oldest = this.findOldestTodo();
        if (oldest) {
          this._todos.delete(oldest.id);
        } else {
          // Safety valve: if somehow no oldest found, clear a random entry
          const firstKey = this._todos.keys().next().value;
          if (firstKey) this._todos.delete(firstKey);
          else break; // Map is empty somehow, exit loop
        }
      }

      const estimatedDurationMs = this.getEstimatedDuration(estimatedComplexity);

      this._todos.set(id, {
        id,
        content: cleanContent,
        status,
        detectedAt: Date.now(),
        priority,
        estimatedComplexity,
        estimatedDurationMs,
      });

      // P1-009: Start tracking if already in_progress
      if (status === 'in_progress') {
        this.startTrackingTodo(id);
      }
    }
  }

  /**
   * Normalize todo content for consistent matching.
   *
   * Normalization steps:
   * 1. Collapse multiple whitespace to single space
   * 2. Remove special characters (keep alphanumeric + basic punctuation)
   * 3. Trim whitespace
   * 4. Convert to lowercase
   *
   * This prevents duplicate todos from terminal rendering artifacts.
   *
   * @param content - Raw todo content
   * @returns Normalized lowercase string
   */
  private normalizeTodoContent(content: string): string {
    if (!content) return '';
    return content
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/[^a-zA-Z0-9\s.,!?'"-]/g, '') // Remove special chars (keep punctuation)
      .trim()
      .toLowerCase();
  }

  /**
   * Calculate similarity between two strings.
   *
   * P1-007: Uses a hybrid approach combining:
   * 1. Levenshtein-based similarity for edit-distance tolerance
   * 2. Bigram (Dice coefficient) for reordering tolerance
   * Returns the maximum of both methods.
   *
   * @param str1 - First string (will be normalized)
   * @param str2 - Second string (will be normalized)
   * @returns Similarity score from 0.0 (no similarity) to 1.0 (identical)
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const norm1 = this.normalizeTodoContent(str1);
    const norm2 = this.normalizeTodoContent(str2);

    // Identical after normalization
    if (norm1 === norm2) return 1.0;

    // If either is empty, no similarity
    if (!norm1 || !norm2) return 0.0;

    // Method 1: Levenshtein-based similarity (good for typos/minor edits)
    const levenshteinSim = stringSimilarity(norm1, norm2);

    // Method 2: Bigram/Dice similarity (good for word reordering)
    const bigramSim = this.calculateBigramSimilarity(norm1, norm2);

    // Return the higher of the two scores
    return Math.max(levenshteinSim, bigramSim);
  }

  /**
   * Calculate bigram (Dice coefficient) similarity.
   * Good for detecting near-duplicates with word reordering.
   *
   * @param norm1 - First normalized string
   * @param norm2 - Second normalized string
   * @returns Similarity score from 0.0 to 1.0
   */
  private calculateBigramSimilarity(norm1: string, norm2: string): number {
    // Short strings: use simple character overlap
    if (norm1.length < 3 || norm2.length < 3) {
      const shorter = norm1.length <= norm2.length ? norm1 : norm2;
      const longer = norm1.length > norm2.length ? norm1 : norm2;
      return longer.includes(shorter) ? 0.9 : 0.0;
    }

    // Extract bigrams (pairs of consecutive characters)
    const getBigrams = (s: string): Set<string> => {
      const bigrams = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) {
        bigrams.add(s.substring(i, i + 2));
      }
      return bigrams;
    };

    const bigrams1 = getBigrams(norm1);
    const bigrams2 = getBigrams(norm2);

    // Count intersection
    let intersection = 0;
    for (const bigram of bigrams1) {
      if (bigrams2.has(bigram)) {
        intersection++;
      }
    }

    // Dice coefficient: 2 * intersection / (total bigrams)
    const totalBigrams = bigrams1.size + bigrams2.size;
    if (totalBigrams === 0) return 0.0;

    return (2 * intersection) / totalBigrams;
  }

  /**
   * Find an existing todo that is similar to the given content.
   * Returns the most similar todo if similarity >= threshold.
   *
   * Deduplication is intentionally conservative:
   * - Short strings (< 30 chars): require 95% similarity (nearly identical)
   * - Medium strings (30-60 chars): require 90% similarity
   * - Longer strings: use default 85% threshold
   *
   * This prevents over-aggressive deduplication of brief, numbered items
   * like "Task 1", "Task 2" while still catching true duplicates.
   *
   * @param content - New todo content to check against existing todos
   * @returns Similar todo item if found, undefined otherwise
   */
  private findSimilarTodo(content: string): RalphTodoItem | undefined {
    const normalized = this.normalizeTodoContent(content);

    // Determine appropriate threshold based on string length
    // Shorter strings need higher threshold to avoid false positives
    let threshold: number;
    if (normalized.length < 30) {
      threshold = 0.95; // Very strict for short strings
    } else if (normalized.length < 60) {
      threshold = 0.9; // Strict for medium strings
    } else {
      threshold = TODO_SIMILARITY_THRESHOLD; // 0.85 for longer strings
    }

    let bestMatch: RalphTodoItem | undefined;
    let bestSimilarity = 0;

    for (const todo of this._todos.values()) {
      const similarity = this.calculateSimilarity(content, todo.content);
      if (similarity >= threshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = todo;
      }
    }

    return bestMatch;
  }

  // ========== P1-009: Progress Estimation Methods ==========

  /**
   * Estimate complexity of a todo based on content keywords.
   * Used for duration estimation.
   *
   * @param content - Todo content text
   * @returns Complexity category
   */
  private estimateComplexity(content: string): 'trivial' | 'simple' | 'moderate' | 'complex' {
    const lower = content.toLowerCase();

    // Trivial: Simple fixes, typos, documentation
    const trivialPatterns = [
      /\btypo\b/,
      /\bspelling\b/,
      /\bcomment\b/,
      /\bupdate\s+(?:version|readme)\b/,
      /\brename\b/,
      /\bformat(?:ting)?\b/,
    ];

    // Complex: Architecture, refactoring, security, testing
    const complexPatterns = [
      /\barchitect(?:ure)?\b/,
      /\brefactor\b/,
      /\brewrite\b/,
      /\bsecurity\b/,
      /\bmigrat(?:e|ion)\b/,
      /\btest(?:s|ing)?\b/,
      /\bintegrat(?:e|ion)\b/,
      /\bperformance\b/,
      /\boptimiz(?:e|ation)\b/,
      /\bmultiple\s+files?\b/,
    ];

    // Moderate: Bugs, features, enhancements
    const moderatePatterns = [
      /\bbug\b/,
      /\bfeature\b/,
      /\benhance(?:ment)?\b/,
      /\bimplement\b/,
      /\badd\b/,
      /\bfix\b/,
    ];

    for (const pattern of complexPatterns) {
      if (pattern.test(lower)) return 'complex';
    }

    for (const trivialPattern of trivialPatterns) {
      if (trivialPattern.test(lower)) return 'trivial';
    }

    for (const moderatePattern of moderatePatterns) {
      if (moderatePattern.test(lower)) return 'moderate';
    }

    return 'simple';
  }

  /**
   * Get estimated duration for a complexity level (ms).
   * Based on historical patterns from similar tasks.
   *
   * @param complexity - Complexity category
   * @returns Estimated duration in milliseconds
   */
  private getEstimatedDuration(complexity: 'trivial' | 'simple' | 'moderate' | 'complex'): number {
    // If we have historical data, use average adjusted by complexity
    const avgTime = this.getAverageCompletionTime();
    if (avgTime !== null) {
      const multipliers = {
        trivial: 0.25,
        simple: 0.5,
        moderate: 1.0,
        complex: 2.0,
      };
      return Math.round(avgTime * multipliers[complexity]);
    }

    // Default estimates (in ms) based on typical task durations
    const defaults = {
      trivial: 1 * 60 * 1000, // 1 minute
      simple: 3 * 60 * 1000, // 3 minutes
      moderate: 10 * 60 * 1000, // 10 minutes
      complex: 30 * 60 * 1000, // 30 minutes
    };
    return defaults[complexity];
  }

  /**
   * Get average completion time from historical data.
   * @returns Average time in ms, or null if no data
   */
  private getAverageCompletionTime(): number | null {
    if (this._completionTimes.length === 0) return null;
    const sum = this._completionTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this._completionTimes.length);
  }

  /**
   * Record a todo completion for progress tracking.
   * @param todoId - ID of the completed todo
   */
  private recordTodoCompletion(todoId: string): void {
    const startTime = this._todoStartTimes.get(todoId);
    if (startTime) {
      const duration = Date.now() - startTime;
      this._completionTimes.push(duration);

      // Keep only recent completion times
      while (this._completionTimes.length > RalphTracker.MAX_COMPLETION_TIMES) {
        this._completionTimes.shift();
      }

      this._todoStartTimes.delete(todoId);
    }
  }

  /**
   * Start tracking a todo for duration estimation.
   * @param todoId - ID of the todo being started
   */
  private startTrackingTodo(todoId: string): void {
    if (!this._todoStartTimes.has(todoId)) {
      this._todoStartTimes.set(todoId, Date.now());
    }

    // Initialize session tracking if needed
    if (this._todosStartedAt === 0) {
      this._todosStartedAt = Date.now();
    }
  }

  /**
   * Get progress estimation for the todo list.
   * P1-009: Provides completion percentage, estimated remaining time,
   * and projected completion timestamp.
   *
   * @returns Progress estimation object
   */
  public getTodoProgress(): RalphTodoProgress {
    const todos = Array.from(this._todos.values());
    const total = todos.length;
    const completed = todos.filter((t) => t.status === 'completed').length;
    const inProgress = todos.filter((t) => t.status === 'in_progress').length;
    const pending = todos.filter((t) => t.status === 'pending').length;

    const percentComplete = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Calculate estimated remaining time
    let estimatedRemainingMs: number | null = null;
    let avgCompletionTimeMs: number | null = null;
    let projectedCompletionAt: number | null = null;

    avgCompletionTimeMs = this.getAverageCompletionTime();

    if (total > 0 && completed > 0) {
      // Method 1: Use historical average if available
      if (avgCompletionTimeMs !== null) {
        const remaining = total - completed;
        estimatedRemainingMs = remaining * avgCompletionTimeMs;
      } else {
        // Method 2: Calculate based on elapsed time and progress
        const elapsed = Date.now() - this._todosStartedAt;
        if (elapsed > 0 && completed > 0) {
          const timePerTodo = elapsed / completed;
          avgCompletionTimeMs = Math.round(timePerTodo);
          const remaining = total - completed;
          estimatedRemainingMs = Math.round(remaining * timePerTodo);
        }
      }

      // Calculate projected completion timestamp
      if (estimatedRemainingMs !== null) {
        projectedCompletionAt = Date.now() + estimatedRemainingMs;
      }
    } else if (total > 0 && completed === 0) {
      // No completions yet - use complexity-based estimates
      let totalEstimate = 0;
      for (const todo of todos) {
        if (todo.status !== 'completed') {
          const complexity = todo.estimatedComplexity || this.estimateComplexity(todo.content);
          totalEstimate += this.getEstimatedDuration(complexity);
        }
      }
      estimatedRemainingMs = totalEstimate;
      projectedCompletionAt = Date.now() + totalEstimate;
    }

    return {
      total,
      completed,
      inProgress,
      pending,
      percentComplete,
      estimatedRemainingMs,
      avgCompletionTimeMs,
      projectedCompletionAt,
    };
  }

  /**
   * Generate a stable ID from todo content using djb2 hash.
   *
   * Uses the djb2 hash algorithm for good distribution across strings.
   * Content is normalized first to prevent duplicates from terminal artifacts.
   *
   * @param content - Todo content text
   * @returns Stable ID in format `todo-{hash}` (base36 encoded)
   */
  /**
   * Generate a stable ID from todo content using content hashing.
   *
   * P1-007: Uses centralized todoContentHash utility for consistency
   * with deduplication logic.
   *
   * @param content - Todo content text
   * @returns Unique ID string prefixed with "todo-"
   */
  private generateTodoId(content: string): string {
    if (!content) return 'todo-empty';

    // Use centralized hashing utility
    const hash = todoContentHash(content);
    return `todo-${hash}`;
  }

  /**
   * Find the todo item with the oldest detectedAt timestamp.
   * Used for LRU eviction when at MAX_TODOS_PER_SESSION limit.
   * @returns Oldest todo item, or undefined if map is empty
   */
  private findOldestTodo(): RalphTodoItem | undefined {
    let oldest: RalphTodoItem | undefined;
    for (const todo of this._todos.values()) {
      if (!oldest || todo.detectedAt < oldest.detectedAt) {
        oldest = todo;
      }
    }
    return oldest;
  }

  /**
   * Conditionally run cleanup, throttled to CLEANUP_THROTTLE_MS.
   * Prevents cleanup from running on every data chunk (performance).
   */
  private maybeCleanupExpiredTodos(): void {
    const now = Date.now();
    if (now - this._lastCleanupTime < CLEANUP_THROTTLE_MS) {
      return;
    }
    this._lastCleanupTime = now;
    this.cleanupExpiredTodos();
  }

  /**
   * Remove todo items older than TODO_EXPIRY_MS.
   * Emits todoUpdate if any items were removed.
   * @fires todoUpdate - When expired items are removed
   */
  private cleanupExpiredTodos(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, todo] of this._todos) {
      if (now - todo.detectedAt > TODO_EXPIRY_MS) {
        toDelete.push(id);
      }
    }

    if (toDelete.length > 0) {
      for (const id of toDelete) {
        this._todos.delete(id);
      }
      this.emit('todoUpdate', this.todos);
    }
  }

  /**
   * Programmatically start a loop (external API).
   *
   * Use when starting a loop from outside terminal detection,
   * such as from a user action or API call.
   *
   * Automatically enables the tracker if not already enabled.
   *
   * @param completionPhrase - Optional phrase that signals completion
   * @param maxIterations - Optional maximum iteration count
   * @fires enabled - If tracker was disabled
   * @fires loopUpdate - When loop state changes
   */
  startLoop(completionPhrase?: string, maxIterations?: number): void {
    this.enable(); // Ensure tracker is enabled
    this._loopState.active = true;
    this._loopState.startedAt = Date.now();
    this._loopState.cycleCount = 0;
    this._loopState.maxIterations = maxIterations ?? null;
    this._loopState.elapsedHours = null;
    this._loopState.lastActivity = Date.now();
    if (completionPhrase) {
      this._loopState.completionPhrase = completionPhrase;
    }
    this.emit('loopUpdate', this.loopState);
  }

  /**
   * Update the maximum iteration count (external API).
   *
   * @param maxIterations - New max iterations, or null to remove limit
   * @fires loopUpdate - When loop state changes
   */
  setMaxIterations(maxIterations: number | null): void {
    this._loopState.maxIterations = maxIterations;
    this._loopState.lastActivity = Date.now();
    this.emit('loopUpdate', this.loopState);
  }

  /**
   * Configure the tracker from external state (e.g. ralph plugin config).
   * Only updates fields that are provided, leaving others unchanged.
   *
   * @param config - Partial configuration to apply
   * @fires loopUpdate - When loop state changes
   */
  configure(config: {
    enabled?: boolean;
    completionPhrase?: string;
    maxIterations?: number;
  }): void {
    if (config.enabled !== undefined) {
      this._loopState.enabled = config.enabled;
    }
    if (config.completionPhrase !== undefined) {
      this._loopState.completionPhrase = config.completionPhrase;
    }
    if (config.maxIterations !== undefined) {
      this._loopState.maxIterations = config.maxIterations;
    }
    this._loopState.lastActivity = Date.now();
    this.emit('loopUpdate', this.loopState);
  }

  /**
   * Programmatically stop the loop (external API).
   *
   * Sets loop to inactive. Does not disable the tracker
   * or clear todos - use reset() or clear() for that.
   *
   * @fires loopUpdate - When loop state changes
   */
  stopLoop(): void {
    this._loopState.active = false;
    this._loopState.lastActivity = Date.now();
    this.emit('loopUpdate', this.loopState);
  }

  /**
   * Enforce size limit on _taskNumberToContent map.
   * Removes lowest task numbers (oldest tasks) when limit exceeded.
   */
  private enforceTaskMappingLimit(): void {
    if (this._taskNumberToContent.size <= MAX_TASK_MAPPINGS) return;

    // Sort keys and remove lowest (oldest) task numbers
    const sortedKeys = Array.from(this._taskNumberToContent.keys()).sort((a, b) => a - b);
    const keysToRemove = sortedKeys.slice(0, this._taskNumberToContent.size - MAX_TASK_MAPPINGS);
    for (const key of keysToRemove) {
      this._taskNumberToContent.delete(key);
    }
  }

  /**
   * Clear all state and disable the tracker.
   *
   * Use when the session is cleared or closed.
   * Resets everything to initial disabled state.
   *
   * @fires loopUpdate - With initial state
   * @fires todoUpdate - With empty array
   */
  clear(): void {
    // Clear debounce timers to prevent stale emissions after clear
    this.clearDebounceTimers();
    // Stop fix plan file watcher to prevent memory leak
    this.stopWatchingFixPlan();
    // Stop iteration stall detection timer to prevent leak
    this.stopIterationStallDetection();
    this._loopState = createInitialRalphTrackerState(); // This sets enabled: false
    this._todos.clear();
    this._taskNumberToContent.clear();
    this._todoStartTimes.clear();
    this._alternateCompletionPhrases.clear();
    this._lineBuffer = '';
    this._partialPromiseBuffer = '';
    this._completionPhraseCount.clear();
    // Clear RALPH_STATUS block and circuit breaker state
    this._statusBlockBuffer = [];
    this._inStatusBlock = false;
    this._lastStatusBlock = null;
    this._completionIndicators = 0;
    this._exitGateMet = false;
    this._totalFilesModified = 0;
    this._totalTasksCompleted = 0;
    this._circuitBreaker = createInitialCircuitBreakerStatus();
    this.emit('loopUpdate', this.loopState);
    this.emit('todoUpdate', this.todos);
  }

  /**
   * Get aggregated statistics about tracked todos.
   *
   * @returns Object with counts by status:
   *   - total: Total number of tracked todos
   *   - pending: Todos not yet started
   *   - inProgress: Todos currently in progress
   *   - completed: Finished todos
   */
  getTodoStats(): { total: number; pending: number; inProgress: number; completed: number } {
    let pending = 0;
    let inProgress = 0;
    let completed = 0;

    for (const todo of this._todos.values()) {
      switch (todo.status) {
        case 'pending':
          pending++;
          break;
        case 'in_progress':
          inProgress++;
          break;
        case 'completed':
          completed++;
          break;
      }
    }

    return {
      total: this._todos.size,
      pending,
      inProgress,
      completed,
    };
  }

  /**
   * Restore tracker state from persisted data.
   *
   * Use after loading state from StateStore. Handles backwards
   * compatibility by defaulting missing `enabled` flag to false.
   *
   * Note: Does not emit events (caller should handle if needed).
   *
   * @param loopState - Persisted loop state object
   * @param todos - Persisted todo items array
   */
  restoreState(loopState: RalphTrackerState, todos: RalphTodoItem[]): void {
    // Ensure enabled flag exists (backwards compatibility)
    this._loopState = {
      ...loopState,
      enabled: loopState.enabled ?? false, // Override after spread for backwards compat
    };
    this._todos.clear();
    for (const todo of todos) {
      // Backwards compatibility: ensure priority field exists
      this._todos.set(todo.id, {
        ...todo,
        priority: todo.priority ?? null,
      });
    }
  }

  // ========== RALPH_STATUS Block Detection ==========

  /**
   * Process a line for RALPH_STATUS block detection.
   * Buffers lines between ---RALPH_STATUS--- and ---END_RALPH_STATUS---
   * then parses the complete block.
   *
   * @param line - Single line to process (already trimmed)
   * @fires statusBlockDetected - When a complete block is parsed
   */
  private processStatusBlockLine(line: string): void {
    // Check for block start
    if (RALPH_STATUS_START_PATTERN.test(line)) {
      this._inStatusBlock = true;
      this._statusBlockBuffer = [];
      return;
    }

    // Check for block end
    if (this._inStatusBlock && RALPH_STATUS_END_PATTERN.test(line)) {
      this._inStatusBlock = false;
      this.parseStatusBlock(this._statusBlockBuffer);
      this._statusBlockBuffer = [];
      return;
    }

    // Buffer lines while in block
    if (this._inStatusBlock) {
      this._statusBlockBuffer.push(line);
    }
  }

  /**
   * Parse buffered RALPH_STATUS block lines into structured data.
   *
   * P1-004: Enhanced with schema validation and error recovery
   *
   * @param lines - Array of lines between block markers
   * @fires statusBlockDetected - When parsing succeeds
   */
  private parseStatusBlock(lines: string[]): void {
    const block: Partial<RalphStatusBlock> = {
      parsedAt: Date.now(),
    };
    const parseErrors: string[] = [];
    const unknownFields: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Track whether this line matched any known field
      let matched = false;

      // STATUS field (required)
      const statusMatch = trimmedLine.match(RALPH_STATUS_FIELD_PATTERN);
      if (statusMatch) {
        const value = statusMatch[1].toUpperCase();
        if (['IN_PROGRESS', 'COMPLETE', 'BLOCKED'].includes(value)) {
          block.status = value as RalphStatusValue;
        } else {
          parseErrors.push(
            `Invalid STATUS value: "${value}". Expected: IN_PROGRESS, COMPLETE, or BLOCKED`
          );
        }
        matched = true;
      }

      // TASKS_COMPLETED_THIS_LOOP field
      const tasksMatch = trimmedLine.match(RALPH_TASKS_COMPLETED_PATTERN);
      if (tasksMatch) {
        const value = parseInt(tasksMatch[1], 10);
        if (!Number.isNaN(value) && value >= 0) {
          block.tasksCompletedThisLoop = value;
        } else {
          parseErrors.push(
            `Invalid TASKS_COMPLETED_THIS_LOOP value: "${tasksMatch[1]}". Expected: non-negative integer`
          );
        }
        matched = true;
      }

      // FILES_MODIFIED field
      const filesMatch = trimmedLine.match(RALPH_FILES_MODIFIED_PATTERN);
      if (filesMatch) {
        const value = parseInt(filesMatch[1], 10);
        if (!Number.isNaN(value) && value >= 0) {
          block.filesModified = value;
        } else {
          parseErrors.push(
            `Invalid FILES_MODIFIED value: "${filesMatch[1]}". Expected: non-negative integer`
          );
        }
        matched = true;
      }

      // TESTS_STATUS field
      const testsMatch = trimmedLine.match(RALPH_TESTS_STATUS_PATTERN);
      if (testsMatch) {
        const value = testsMatch[1].toUpperCase();
        if (['PASSING', 'FAILING', 'NOT_RUN'].includes(value)) {
          block.testsStatus = value as RalphTestsStatus;
        } else {
          parseErrors.push(
            `Invalid TESTS_STATUS value: "${value}". Expected: PASSING, FAILING, or NOT_RUN`
          );
        }
        matched = true;
      }

      // WORK_TYPE field
      const workMatch = trimmedLine.match(RALPH_WORK_TYPE_PATTERN);
      if (workMatch) {
        const value = workMatch[1].toUpperCase();
        if (['IMPLEMENTATION', 'TESTING', 'DOCUMENTATION', 'REFACTORING'].includes(value)) {
          block.workType = value as RalphWorkType;
        } else {
          parseErrors.push(
            `Invalid WORK_TYPE value: "${value}". Expected: IMPLEMENTATION, TESTING, DOCUMENTATION, or REFACTORING`
          );
        }
        matched = true;
      }

      // EXIT_SIGNAL field
      const exitMatch = trimmedLine.match(RALPH_EXIT_SIGNAL_PATTERN);
      if (exitMatch) {
        block.exitSignal = exitMatch[1].toLowerCase() === 'true';
        matched = true;
      }

      // RECOMMENDATION field
      const recMatch = trimmedLine.match(RALPH_RECOMMENDATION_PATTERN);
      if (recMatch) {
        block.recommendation = recMatch[1].trim();
        matched = true;
      }

      // Track unknown fields for debugging (only if looks like a field)
      if (!matched && trimmedLine.includes(':')) {
        const fieldName = trimmedLine.split(':')[0].trim().toUpperCase();
        if (fieldName && !['#', '//'].some((c) => fieldName.startsWith(c))) {
          unknownFields.push(fieldName);
        }
      }
    }

    // Log parse errors if any
    if (parseErrors.length > 0) {
      console.warn(`[RalphTracker] RALPH_STATUS parse errors:\n  - ${parseErrors.join('\n  - ')}`);
    }

    // Log unknown fields if any
    if (unknownFields.length > 0) {
      console.warn(`[RalphTracker] RALPH_STATUS unknown fields: ${unknownFields.join(', ')}`);
    }

    // Validate required field: STATUS
    if (block.status === undefined) {
      console.warn('[RalphTracker] RALPH_STATUS block missing required STATUS field, skipping');
      return;
    }

    // Fill in defaults for missing optional fields
    const fullBlock: RalphStatusBlock = {
      status: block.status,
      tasksCompletedThisLoop: block.tasksCompletedThisLoop ?? 0,
      filesModified: block.filesModified ?? 0,
      testsStatus: block.testsStatus ?? 'NOT_RUN',
      workType: block.workType ?? 'IMPLEMENTATION',
      exitSignal: block.exitSignal ?? false,
      recommendation: block.recommendation ?? '',
      parsedAt: block.parsedAt!,
    };

    this._lastStatusBlock = fullBlock;
    this.handleStatusBlock(fullBlock);
  }

  /**
   * Handle a parsed RALPH_STATUS block.
   * Updates circuit breaker, checks exit conditions.
   *
   * @param block - Parsed status block
   * @fires statusBlockDetected - With the block data
   * @fires circuitBreakerUpdate - If state changes
   * @fires exitGateMet - If dual-condition exit triggered
   */
  private handleStatusBlock(block: RalphStatusBlock): void {
    // Auto-enable tracker when we see a status block
    if (!this._loopState.enabled && !this._autoEnableDisabled) {
      this.enable();
    }

    // Update cumulative counts
    this._totalFilesModified += block.filesModified;
    this._totalTasksCompleted += block.tasksCompletedThisLoop;

    // Check for progress (for circuit breaker)
    const hasProgress = block.filesModified > 0 || block.tasksCompletedThisLoop > 0;

    // Update circuit breaker
    this.updateCircuitBreaker(hasProgress, block.testsStatus, block.status);

    // Check completion indicators
    if (block.status === 'COMPLETE') {
      this._completionIndicators++;
    }

    // Check dual-condition exit gate
    if (block.exitSignal && this._completionIndicators >= 2 && !this._exitGateMet) {
      this._exitGateMet = true;
      this.emit('exitGateMet', {
        completionIndicators: this._completionIndicators,
        exitSignal: true,
      });
    }

    // Update loop state
    this._loopState.lastActivity = Date.now();

    // Emit the status block
    this.emit('statusBlockDetected', block);
    this.emitLoopUpdateDebounced();
  }

  // ========== Circuit Breaker ==========

  /**
   * Update circuit breaker state based on iteration results.
   *
   * @param hasProgress - Whether this iteration made progress
   * @param testsStatus - Current test status
   * @param status - Overall status from RALPH_STATUS
   * @fires circuitBreakerUpdate - If state changes
   */
  private updateCircuitBreaker(
    hasProgress: boolean,
    testsStatus: RalphTestsStatus,
    status: RalphStatusValue
  ): void {
    const prevState = this._circuitBreaker.state;

    if (hasProgress) {
      // Progress detected - reset counters, possibly close circuit
      this._circuitBreaker.consecutiveNoProgress = 0;
      this._circuitBreaker.consecutiveSameError = 0;
      this._circuitBreaker.lastProgressIteration = this._loopState.cycleCount;

      if (this._circuitBreaker.state === 'HALF_OPEN') {
        this._circuitBreaker.state = 'CLOSED';
        this._circuitBreaker.reason = 'Progress detected, circuit closed';
        this._circuitBreaker.reasonCode = 'progress_detected';
      }
    } else {
      // No progress
      this._circuitBreaker.consecutiveNoProgress++;

      // State transitions based on consecutive no-progress
      if (this._circuitBreaker.state === 'CLOSED') {
        if (this._circuitBreaker.consecutiveNoProgress >= 3) {
          this._circuitBreaker.state = 'OPEN';
          this._circuitBreaker.reason = `No progress for ${this._circuitBreaker.consecutiveNoProgress} iterations`;
          this._circuitBreaker.reasonCode = 'no_progress_open';
        } else if (this._circuitBreaker.consecutiveNoProgress >= 2) {
          this._circuitBreaker.state = 'HALF_OPEN';
          this._circuitBreaker.reason = 'Warning: no progress detected';
          this._circuitBreaker.reasonCode = 'no_progress_warning';
        }
      } else if (this._circuitBreaker.state === 'HALF_OPEN') {
        if (this._circuitBreaker.consecutiveNoProgress >= 3) {
          this._circuitBreaker.state = 'OPEN';
          this._circuitBreaker.reason = `No progress for ${this._circuitBreaker.consecutiveNoProgress} iterations`;
          this._circuitBreaker.reasonCode = 'no_progress_open';
        }
      }
    }

    // Track tests failure
    if (testsStatus === 'FAILING') {
      this._circuitBreaker.consecutiveTestsFailure++;
      if (
        this._circuitBreaker.consecutiveTestsFailure >= 5 &&
        this._circuitBreaker.state !== 'OPEN'
      ) {
        this._circuitBreaker.state = 'OPEN';
        this._circuitBreaker.reason = `Tests failing for ${this._circuitBreaker.consecutiveTestsFailure} iterations`;
        this._circuitBreaker.reasonCode = 'tests_failing_too_long';
      }
    } else {
      this._circuitBreaker.consecutiveTestsFailure = 0;
    }

    // Track blocked status
    if (status === 'BLOCKED' && this._circuitBreaker.state !== 'OPEN') {
      this._circuitBreaker.state = 'OPEN';
      this._circuitBreaker.reason = 'Claude reported BLOCKED status';
      this._circuitBreaker.reasonCode = 'same_error_repeated';
    }

    // Emit if state changed
    if (prevState !== this._circuitBreaker.state) {
      this._circuitBreaker.lastTransitionAt = Date.now();
      this.emit('circuitBreakerUpdate', { ...this._circuitBreaker });
    }
  }

  /**
   * Manually reset circuit breaker to CLOSED state.
   * Use when user acknowledges the issue is resolved.
   *
   * @fires circuitBreakerUpdate
   */
  resetCircuitBreaker(): void {
    this._circuitBreaker = createInitialCircuitBreakerStatus();
    this._circuitBreaker.reason = 'Manual reset';
    this._circuitBreaker.reasonCode = 'manual_reset';
    this.emit('circuitBreakerUpdate', { ...this._circuitBreaker });
  }

  /**
   * Get current circuit breaker status.
   */
  get circuitBreakerStatus(): CircuitBreakerStatus {
    return { ...this._circuitBreaker };
  }

  /**
   * Get last parsed RALPH_STATUS block.
   */
  get lastStatusBlock(): RalphStatusBlock | null {
    return this._lastStatusBlock ? { ...this._lastStatusBlock } : null;
  }

  /**
   * Get cumulative stats from status blocks.
   */
  get cumulativeStats(): {
    filesModified: number;
    tasksCompleted: number;
    completionIndicators: number;
  } {
    return {
      filesModified: this._totalFilesModified,
      tasksCompleted: this._totalTasksCompleted,
      completionIndicators: this._completionIndicators,
    };
  }

  /**
   * Whether dual-condition exit gate has been met.
   */
  get exitGateMet(): boolean {
    return this._exitGateMet;
  }

  // ========== Completion Indicator Detection ==========

  /**
   * Check line for completion indicators (natural language patterns).
   * Used for dual-condition exit gate.
   *
   * @param line - Line to check
   */
  private detectCompletionIndicators(line: string): void {
    for (const pattern of COMPLETION_INDICATOR_PATTERNS) {
      if (pattern.test(line)) {
        this._completionIndicators++;
        break; // Only count once per line
      }
    }
  }

  // ========== @fix_plan.md Generation & Import ==========

  /**
   * Generate @fix_plan.md content from current todos.
   * Groups todos by priority and status.
   *
   * @returns Markdown content for @fix_plan.md
   */
  generateFixPlanMarkdown(): string {
    const todos = this.todos;
    const lines: string[] = ['# Fix Plan', ''];

    // Group by priority
    const p0: RalphTodoItem[] = [];
    const p1: RalphTodoItem[] = [];
    const p2: RalphTodoItem[] = [];
    const noPriority: RalphTodoItem[] = [];
    const completed: RalphTodoItem[] = [];

    for (const todo of todos) {
      if (todo.status === 'completed') {
        completed.push(todo);
      } else if (todo.priority === 'P0') {
        p0.push(todo);
      } else if (todo.priority === 'P1') {
        p1.push(todo);
      } else if (todo.priority === 'P2') {
        p2.push(todo);
      } else {
        noPriority.push(todo);
      }
    }

    // High Priority (P0)
    if (p0.length > 0) {
      lines.push('## High Priority (P0)');
      for (const todo of p0) {
        const checkbox = todo.status === 'in_progress' ? '[-]' : '[ ]';
        lines.push(`- ${checkbox} ${todo.content}`);
      }
      lines.push('');
    }

    // Standard (P1)
    if (p1.length > 0) {
      lines.push('## Standard (P1)');
      for (const todo of p1) {
        const checkbox = todo.status === 'in_progress' ? '[-]' : '[ ]';
        lines.push(`- ${checkbox} ${todo.content}`);
      }
      lines.push('');
    }

    // Nice to Have (P2)
    if (p2.length > 0) {
      lines.push('## Nice to Have (P2)');
      for (const todo of p2) {
        const checkbox = todo.status === 'in_progress' ? '[-]' : '[ ]';
        lines.push(`- ${checkbox} ${todo.content}`);
      }
      lines.push('');
    }

    // Tasks (no priority)
    if (noPriority.length > 0) {
      lines.push('## Tasks');
      for (const todo of noPriority) {
        const checkbox = todo.status === 'in_progress' ? '[-]' : '[ ]';
        lines.push(`- ${checkbox} ${todo.content}`);
      }
      lines.push('');
    }

    // Completed
    if (completed.length > 0) {
      lines.push('## Completed');
      for (const todo of completed) {
        lines.push(`- [x] ${todo.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Parse @fix_plan.md content and import todos.
   * Replaces current todos with imported ones.
   *
   * @param content - Markdown content from @fix_plan.md
   * @returns Number of todos imported
   */
  importFixPlanMarkdown(content: string): number {
    const lines = content.split('\n');
    const newTodos: RalphTodoItem[] = [];
    let currentPriority: RalphTodoPriority = null;

    // Patterns for section headers
    const p0HeaderPattern = /^##\s*(High Priority|Critical|P0)/i;
    const p1HeaderPattern = /^##\s*(Standard|P1|Medium Priority)/i;
    const p2HeaderPattern = /^##\s*(Nice to Have|P2|Low Priority)/i;
    const completedHeaderPattern = /^##\s*Completed/i;
    const tasksHeaderPattern = /^##\s*Tasks/i;

    // Pattern for todo items
    const todoPattern = /^-\s*\[([ x-])\]\s*(.+)$/;

    let inCompletedSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for section headers
      if (p0HeaderPattern.test(trimmed)) {
        currentPriority = 'P0';
        inCompletedSection = false;
        continue;
      }
      if (p1HeaderPattern.test(trimmed)) {
        currentPriority = 'P1';
        inCompletedSection = false;
        continue;
      }
      if (p2HeaderPattern.test(trimmed)) {
        currentPriority = 'P2';
        inCompletedSection = false;
        continue;
      }
      if (completedHeaderPattern.test(trimmed)) {
        inCompletedSection = true;
        continue;
      }
      if (tasksHeaderPattern.test(trimmed)) {
        currentPriority = null;
        inCompletedSection = false;
        continue;
      }

      // Parse todo item
      const match = trimmed.match(todoPattern);
      if (match) {
        const [, checkboxState, content] = match;
        let status: RalphTodoStatus;

        if (inCompletedSection || checkboxState === 'x' || checkboxState === 'X') {
          status = 'completed';
        } else if (checkboxState === '-') {
          status = 'in_progress';
        } else {
          status = 'pending';
        }

        // Parse priority from content if not in a priority section
        const parsedPriority = inCompletedSection
          ? null
          : currentPriority || this.parsePriority(content);

        const id = this.generateTodoId(content);
        newTodos.push({
          id,
          content: content.trim(),
          status,
          detectedAt: Date.now(),
          priority: parsedPriority,
        });
      }
    }

    // Replace current todos with imported ones
    this._todos.clear();
    for (const todo of newTodos) {
      this._todos.set(todo.id, todo);
    }

    // Emit update
    this.emit('todoUpdate', this.todos);

    return newTodos.length;
  }

  // ========== Enhanced Plan Management Methods ==========

  /**
   * Initialize plan tasks from generated plan items.
   * Called when wizard generates a new plan.
   */
  initializePlanTasks(
    items: Array<{
      id?: string;
      content: string;
      priority?: 'P0' | 'P1' | 'P2' | null;
      verificationCriteria?: string;
      testCommand?: string;
      dependencies?: string[];
      tddPhase?: TddPhase;
      pairedWith?: string;
      complexity?: 'low' | 'medium' | 'high';
    }>
  ): void {
    // Save current plan to history before replacing
    if (this._planTasks.size > 0) {
      this._savePlanToHistory('Plan replaced with new generation');
    }

    // Clear and rebuild
    this._planTasks.clear();
    this._planVersion++;

    items.forEach((item, idx) => {
      const id = item.id || `task-${idx}`;
      const task: EnhancedPlanTask = {
        id,
        content: item.content,
        priority: item.priority || null,
        verificationCriteria: item.verificationCriteria,
        testCommand: item.testCommand,
        dependencies: item.dependencies || [],
        status: 'pending',
        attempts: 0,
        version: this._planVersion,
        tddPhase: item.tddPhase,
        pairedWith: item.pairedWith,
        complexity: item.complexity,
      };
      this._planTasks.set(id, task);
    });

    this.emit('planInitialized', { version: this._planVersion, taskCount: this._planTasks.size });
  }

  /**
   * Update a specific plan task's status, attempts, or error.
   */
  updatePlanTask(
    taskId: string,
    update: {
      status?: PlanTaskStatus;
      error?: string;
      incrementAttempts?: boolean;
    }
  ): { success: boolean; task?: EnhancedPlanTask; error?: string } {
    const task = this._planTasks.get(taskId);
    if (!task) {
      return { success: false, error: 'Task not found' };
    }

    if (update.status) {
      task.status = update.status;
      if (update.status === 'completed') {
        task.completedAt = Date.now();
      }
    }

    if (update.error) {
      task.lastError = update.error;
    }

    if (update.incrementAttempts) {
      task.attempts++;

      // After 3 failed attempts, mark as blocked and emit warning
      if (task.attempts >= 3 && task.status === 'failed') {
        task.status = 'blocked';
        this.emit('taskBlocked', {
          taskId,
          content: task.content,
          attempts: task.attempts,
          lastError: task.lastError,
        });
      }
    }

    // Update blocked tasks when a dependency completes
    if (update.status === 'completed') {
      this._unblockDependentTasks(taskId);
    }

    // Check for checkpoint
    this._checkForCheckpoint();

    this.emit('planTaskUpdate', { taskId, task });
    return { success: true, task };
  }

  /**
   * Unblock tasks that were waiting on a completed dependency.
   */
  private _unblockDependentTasks(completedTaskId: string): void {
    for (const [_, task] of this._planTasks) {
      if (task.dependencies.includes(completedTaskId)) {
        // Check if all dependencies are now complete
        const allDepsComplete = task.dependencies.every((depId) => {
          const dep = this._planTasks.get(depId);
          return dep && dep.status === 'completed';
        });

        if (allDepsComplete && task.status === 'blocked') {
          task.status = 'pending';
          this.emit('taskUnblocked', { taskId: task.id });
        }
      }
    }
  }

  /**
   * Check if current iteration is a checkpoint and emit review if so.
   */
  private _checkForCheckpoint(): void {
    const currentIteration = this._loopState.cycleCount;
    if (
      this._checkpointIterations.includes(currentIteration) &&
      currentIteration > this._lastCheckpointIteration
    ) {
      this._lastCheckpointIteration = currentIteration;
      const checkpoint = this.generateCheckpointReview();
      this.emit('planCheckpoint', checkpoint);
    }
  }

  /**
   * Generate a checkpoint review summarizing plan progress and stuck tasks.
   */
  generateCheckpointReview(): CheckpointReview {
    const tasks = Array.from(this._planTasks.values());

    const summary = {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    };

    // Find stuck tasks (3+ attempts or blocked)
    const stuckTasks = tasks
      .filter((t) => t.attempts >= 3 || t.status === 'blocked')
      .map((t) => ({
        id: t.id,
        content: t.content,
        attempts: t.attempts,
        lastError: t.lastError,
      }));

    // Generate recommendations
    const recommendations: string[] = [];

    if (stuckTasks.length > 0) {
      recommendations.push(
        `${stuckTasks.length} task(s) are stuck. Consider breaking them into smaller steps.`
      );
    }

    if (summary.failed > summary.completed && summary.total > 5) {
      recommendations.push(
        'More tasks have failed than completed. Review approach and consider plan adjustment.'
      );
    }

    const progressPercent =
      summary.total > 0 ? Math.round((summary.completed / summary.total) * 100) : 0;
    if (progressPercent < 20 && this._loopState.cycleCount > 10) {
      recommendations.push(
        'Progress is slow. Consider simplifying tasks or reviewing dependencies.'
      );
    }

    if (summary.total > 0 && summary.blocked > summary.total / 3) {
      recommendations.push('Many tasks are blocked. Review dependency chain for bottlenecks.');
    }

    return {
      iteration: this._loopState.cycleCount,
      timestamp: Date.now(),
      summary,
      stuckTasks,
      recommendations,
    };
  }

  /**
   * Save current plan state to history.
   */
  private _savePlanToHistory(summary: string): void {
    // Clone current tasks
    const tasksCopy = new Map<string, EnhancedPlanTask>();
    for (const [id, task] of this._planTasks) {
      tasksCopy.set(id, { ...task });
    }

    this._planHistory.push({
      version: this._planVersion,
      timestamp: Date.now(),
      tasks: tasksCopy,
      summary,
    });

    // Limit history size
    if (this._planHistory.length > MAX_PLAN_HISTORY) {
      this._planHistory.shift();
    }
  }

  /**
   * Get plan version history.
   */
  getPlanHistory(): Array<{
    version: number;
    timestamp: number;
    summary: string;
    stats: { total: number; completed: number; failed: number };
  }> {
    return this._planHistory.map((h) => {
      const tasks = Array.from(h.tasks.values());
      return {
        version: h.version,
        timestamp: h.timestamp,
        summary: h.summary,
        stats: {
          total: tasks.length,
          completed: tasks.filter((t) => t.status === 'completed').length,
          failed: tasks.filter((t) => t.status === 'failed').length,
        },
      };
    });
  }

  /**
   * Rollback to a previous plan version.
   */
  rollbackToVersion(version: number): {
    success: boolean;
    plan?: EnhancedPlanTask[];
    error?: string;
  } {
    const historyEntry = this._planHistory.find((h) => h.version === version);
    if (!historyEntry) {
      return { success: false, error: `Version ${version} not found in history` };
    }

    // Save current state first
    this._savePlanToHistory(`Rolled back from v${this._planVersion} to v${version}`);

    // Restore the historical version
    this._planTasks.clear();
    for (const [id, task] of historyEntry.tasks) {
      // Reset execution state for retry
      this._planTasks.set(id, {
        ...task,
        status: task.status === 'completed' ? 'completed' : 'pending',
        attempts: task.status === 'completed' ? task.attempts : 0,
        lastError: undefined,
      });
    }

    this._planVersion++;
    this.emit('planRollback', { version, newVersion: this._planVersion });

    return { success: true, plan: Array.from(this._planTasks.values()) };
  }

  /**
   * Add a new task to the plan (for runtime adaptation).
   */
  addPlanTask(task: {
    content: string;
    priority?: 'P0' | 'P1' | 'P2';
    verificationCriteria?: string;
    dependencies?: string[];
    insertAfter?: string;
  }): { task: EnhancedPlanTask } {
    // Generate unique ID
    const existingIds = Array.from(this._planTasks.keys());
    const prefix = task.priority || 'P1';
    let counter = existingIds.filter((id) => id.startsWith(prefix)).length + 1;
    let id = `${prefix}-${String(counter).padStart(3, '0')}`;
    while (this._planTasks.has(id)) {
      counter++;
      id = `${prefix}-${String(counter).padStart(3, '0')}`;
    }

    const newTask: EnhancedPlanTask = {
      id,
      content: task.content,
      priority: task.priority || null,
      verificationCriteria: task.verificationCriteria || 'Task completed successfully',
      dependencies: task.dependencies || [],
      status: 'pending',
      attempts: 0,
      version: this._planVersion,
    };

    this._planTasks.set(id, newTask);
    this.emit('planTaskAdded', { task: newTask });

    return { task: newTask };
  }

  /**
   * Get all plan tasks.
   */
  getPlanTasks(): EnhancedPlanTask[] {
    return Array.from(this._planTasks.values());
  }

  /**
   * Get current plan version.
   */
  get planVersion(): number {
    return this._planVersion;
  }

  /**
   * Check if checkpoint review is due for current iteration.
   */
  isCheckpointDue(): boolean {
    const currentIteration = this._loopState.cycleCount;
    return (
      this._checkpointIterations.includes(currentIteration) &&
      currentIteration > this._lastCheckpointIteration
    );
  }

  /**
   * Clean up all resources and release memory.
   *
   * Call this when the session is being destroyed to prevent memory leaks.
   * Stops file watchers, clears all timers, data, and removes event listeners.
   */
  destroy(): void {
    this.clearDebounceTimers();
    this.stopWatchingFixPlan();
    this.stopIterationStallDetection();
    this._todos.clear();
    this._taskNumberToContent.clear();
    this._todoStartTimes.clear();
    this._alternateCompletionPhrases.clear();
    this._completionPhraseCount.clear();
    this._planTasks.clear();
    this._completionTimes.length = 0;
    this._lineBuffer = '';
    this._partialPromiseBuffer = '';
    this._statusBlockBuffer.length = 0;
    this._planHistory.length = 0;
    this.removeAllListeners();
  }
}
