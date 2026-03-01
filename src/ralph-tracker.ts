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
 * Composed of four sub-modules:
 * - RalphPlanTracker: Plan task management, checkpoints, versioning
 * - RalphFixPlanWatcher: @fix_plan.md file watching and parsing
 * - RalphStallDetector: Iteration stall detection
 * - RalphStatusParser: RALPH_STATUS block parsing, circuit breaker
 *
 * @module ralph-tracker
 */

import { EventEmitter } from 'node:events';
import {
  RalphTrackerState,
  RalphTodoItem,
  RalphTodoStatus,
  RalphTodoPriority,
  RalphStatusBlock,
  CircuitBreakerStatus,
  RalphTodoProgress,
  CompletionConfidence,
  createInitialRalphTrackerState,
  PlanTaskStatus,
  TddPhase,
} from './types.js';
import { ANSI_ESCAPE_PATTERN_SIMPLE, fuzzyPhraseMatch, todoContentHash, stringSimilarity, Debouncer } from './utils/index.js';
import { MAX_LINE_BUFFER_SIZE } from './config/buffer-limits.js';
import { MAX_TODOS_PER_SESSION } from './config/map-limits.js';
import { RalphPlanTracker } from './ralph-plan-tracker.js';
import type { EnhancedPlanTask, CheckpointReview } from './ralph-plan-tracker.js';
import { RalphFixPlanWatcher, generateFixPlanMarkdown, importFixPlanMarkdown } from './ralph-fix-plan-watcher.js';
import { RalphStallDetector } from './ralph-stall-detector.js';
import { RalphStatusParser } from './ralph-status-parser.js';

// Re-export sub-module types for backward compatibility
export type { EnhancedPlanTask, CheckpointReview } from './ralph-plan-tracker.js';

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
const TODO_TASK_STATUS_PATTERN = /✔\s*Task\s*#(\d+)\s*updated:\s*status\s*→\s*(in progress|completed|pending)/g;

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
const ITERATION_PATTERN = /(?:iteration|iter\.?)\s*#?(\d+)(?:\s*(?:\/|of)\s*(\d+))?|\[(\d+)\/(\d+)\]/i;

/**
 * Matches Ralph loop start command or announcement
 * Examples: "/ralph-loop:ralph-loop", "Starting Ralph Wiggum loop", "ralph loop beginning"
 */
const RALPH_START_PATTERN = /\/ralph-loop|starting ralph(?:\s+wiggum)?\s+loop|ralph loop (?:started|beginning)/i;

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
const TODOWRITE_PATTERN = /TodoWrite|todo(?:s)?\s*(?:updated|written|saved)|Todos have been modified/i;

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
 * ## Sub-modules
 *
 * - `planTracker` - Plan task management, checkpoints, versioning
 * - `fixPlanWatcher` - @fix_plan.md file watching and parsing
 * - `stallDetector` - Iteration stall detection
 * - `statusParser` - RALPH_STATUS block parsing, circuit breaker
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
  // ========== Sub-modules ==========

  /** Plan task management sub-module */
  readonly planTracker = new RalphPlanTracker();

  /** @fix_plan.md file watcher sub-module */
  readonly fixPlanWatcher: RalphFixPlanWatcher;

  /** Iteration stall detector sub-module */
  readonly stallDetector = new RalphStallDetector();

  /** RALPH_STATUS block parser and circuit breaker sub-module */
  readonly statusParser = new RalphStatusParser();

  // ========== Core State ==========

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

  /** Debouncer for todoUpdate events */
  private _todoDeb = new Debouncer(EVENT_DEBOUNCE_MS);

  /** Debouncer for loopUpdate events */
  private _loopDeb = new Debouncer(EVENT_DEBOUNCE_MS);

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

  /** Last calculated completion confidence */
  private _lastCompletionConfidence: CompletionConfidence | undefined;

  /** Confidence threshold for triggering completion (0-100) */
  private static readonly COMPLETION_CONFIDENCE_THRESHOLD = 70;

  /**
   * Creates a new RalphTracker instance.
   * Starts in disabled state until Ralph patterns are detected.
   */
  constructor() {
    super();
    this._loopState = createInitialRalphTrackerState();

    // Initialize fix plan watcher with callbacks to parent methods
    this.fixPlanWatcher = new RalphFixPlanWatcher(
      (content: string) => this.parsePriority(content),
      (content: string) => this.generateTodoId(content)
    );

    // Wire sub-module events
    this._wireSubModuleEvents();
  }

  /**
   * Forward all sub-module events through RalphTracker
   * so external consumers don't need to know about the split.
   */
  private _wireSubModuleEvents(): void {
    // Forward plan tracker events
    for (const event of [
      'planInitialized',
      'planTaskUpdate',
      'taskBlocked',
      'taskUnblocked',
      'planCheckpoint',
      'planTaskAdded',
      'planRollback',
    ] as const) {
      this.planTracker.on(event, (...args: unknown[]) => this.emit(event, ...args));
    }

    // Forward status parser events
    this.statusParser.on('statusBlockDetected', (block: RalphStatusBlock) => {
      // Auto-enable tracker when we see a status block
      if (!this._loopState.enabled && !this._autoEnableDisabled) {
        this.enable();
      }
      this._loopState.lastActivity = Date.now();
      this.emit('statusBlockDetected', block);
      this.emitLoopUpdateDebounced();
    });

    this.statusParser.on('circuitBreakerUpdate', (status: CircuitBreakerStatus) => {
      this.emit('circuitBreakerUpdate', status);
    });

    this.statusParser.on('exitGateMet', (data: { completionIndicators: number; exitSignal: boolean }) => {
      this.emit('exitGateMet', data);
    });

    // Forward stall detector events
    this.stallDetector.on('iterationStallWarning', (data: { iteration: number; stallDurationMs: number }) => {
      this.emit('iterationStallWarning', data);
    });

    this.stallDetector.on('iterationStallCritical', (data: { iteration: number; stallDurationMs: number }) => {
      this.emit('iterationStallCritical', data);
    });

    // Forward fix plan watcher events
    this.fixPlanWatcher.on('todosLoaded', (items: RalphTodoItem[]) => {
      // Replace _todos with file-based items
      this._todos.clear();
      for (const item of items) {
        this._todos.set(item.id, item);
      }

      // Auto-enable tracker when we have todos from @fix_plan.md
      if (!this._loopState.enabled) {
        this.enable();
      }

      this.emit('todoUpdate', this.todos);
    });
  }

  // ========== Delegated Plan Tracker Methods ==========

  /**
   * Initialize plan tasks from generated plan items.
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
    this.planTracker.initializePlanTasks(items);
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
    return this.planTracker.updatePlanTask(taskId, update);
  }

  /**
   * Add a new task to the plan.
   */
  addPlanTask(task: {
    content: string;
    priority?: 'P0' | 'P1' | 'P2';
    verificationCriteria?: string;
    dependencies?: string[];
    insertAfter?: string;
  }): { task: EnhancedPlanTask } {
    return this.planTracker.addPlanTask(task);
  }

  /**
   * Get all plan tasks.
   */
  getPlanTasks(): EnhancedPlanTask[] {
    return this.planTracker.getPlanTasks();
  }

  /**
   * Generate a checkpoint review.
   */
  generateCheckpointReview(): CheckpointReview {
    return this.planTracker.generateCheckpointReview();
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
    return this.planTracker.getPlanHistory();
  }

  /**
   * Rollback to a previous plan version.
   */
  rollbackToVersion(version: number): {
    success: boolean;
    plan?: EnhancedPlanTask[];
    error?: string;
  } {
    return this.planTracker.rollbackToVersion(version);
  }

  /**
   * Check if checkpoint review is due.
   */
  isCheckpointDue(): boolean {
    return this.planTracker.isCheckpointDue();
  }

  /**
   * Get current plan version.
   */
  get planVersion(): number {
    return this.planTracker.planVersion;
  }

  // ========== Delegated Fix Plan Watcher Methods ==========

  /**
   * Set the working directory and start watching @fix_plan.md.
   * @param workingDir - The session's working directory
   */
  setWorkingDir(workingDir: string): void {
    this.fixPlanWatcher.setWorkingDir(workingDir);
  }

  /**
   * Load @fix_plan.md from disk if it exists.
   */
  async loadFixPlanFromDisk(): Promise<number> {
    return this.fixPlanWatcher.loadFixPlanFromDisk();
  }

  /**
   * Stop watching @fix_plan.md.
   */
  stopWatchingFixPlan(): void {
    this.fixPlanWatcher.stopWatchingFixPlan();
  }

  /**
   * When @fix_plan.md is active, treat it as the source of truth for todo status.
   */
  get isFileAuthoritative(): boolean {
    return this.fixPlanWatcher.isFileAuthoritative;
  }

  /**
   * Generate @fix_plan.md content from current todos.
   */
  generateFixPlanMarkdown(): string {
    return generateFixPlanMarkdown(this.todos);
  }

  /**
   * Parse @fix_plan.md content and import todos.
   * Replaces current todos with imported ones.
   *
   * @param content - Markdown content from @fix_plan.md
   * @returns Number of todos imported
   */
  importFixPlanMarkdown(content: string): number {
    const newTodos = importFixPlanMarkdown(
      content,
      (c: string) => this.parsePriority(c),
      (c: string) => this.generateTodoId(c)
    );

    // Replace current todos with imported ones
    this._todos.clear();
    for (const todo of newTodos) {
      this._todos.set(todo.id, todo);
    }

    // Emit update
    this.emit('todoUpdate', this.todos);

    return newTodos.length;
  }

  // ========== Delegated Stall Detector Methods ==========

  /**
   * Start iteration stall detection timer.
   */
  startIterationStallDetection(): void {
    this.stallDetector.startIterationStallDetection();
  }

  /**
   * Stop iteration stall detection timer.
   */
  stopIterationStallDetection(): void {
    this.stallDetector.stopIterationStallDetection();
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
    return this.stallDetector.getIterationStallMetrics();
  }

  /**
   * Configure iteration stall thresholds.
   */
  configureIterationStallThresholds(warningMs: number, criticalMs: number): void {
    this.stallDetector.configureIterationStallThresholds(warningMs, criticalMs);
  }

  // ========== Delegated Status Parser Methods ==========

  /**
   * Manually reset circuit breaker to CLOSED state.
   * @fires circuitBreakerUpdate
   */
  resetCircuitBreaker(): void {
    this.statusParser.resetCircuitBreaker();
  }

  /**
   * Get current circuit breaker status.
   */
  get circuitBreakerStatus(): CircuitBreakerStatus {
    return this.statusParser.circuitBreakerStatus;
  }

  /**
   * Get last parsed RALPH_STATUS block.
   */
  get lastStatusBlock(): RalphStatusBlock | null {
    return this.statusParser.lastStatusBlock;
  }

  /**
   * Get cumulative stats from status blocks.
   */
  get cumulativeStats(): {
    filesModified: number;
    tasksCompleted: number;
    completionIndicators: number;
  } {
    return this.statusParser.cumulativeStats;
  }

  /**
   * Whether dual-condition exit gate has been met.
   */
  get exitGateMet(): boolean {
    return this.statusParser.exitGateMet;
  }

  // ========== Core Methods ==========

  /**
   * Add an alternate completion phrase (P1-003: multi-phrase support).
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
   */
  removeAlternateCompletionPhrase(phrase: string): void {
    if (this._alternateCompletionPhrases.delete(phrase)) {
      this._loopState.alternateCompletionPhrases = Array.from(this._alternateCompletionPhrases);
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Check if a phrase matches any valid completion phrase (primary or alternate).
   */
  isValidCompletionPhrase(phrase: string): boolean {
    return this.findMatchingCompletionPhrase(phrase) !== null;
  }

  /**
   * Find which completion phrase (primary or alternate) matches the given phrase.
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
   * Whether the tracker is enabled and actively monitoring output.
   */
  get enabled(): boolean {
    return this._loopState.enabled;
  }

  /**
   * Enable the tracker to start monitoring terminal output.
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

    // Reset sub-modules
    this.statusParser.reset();
    this.planTracker.reset();
    this.stallDetector.reset();

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
    this._partialPromiseBuffer = '';

    // Full reset sub-modules
    this.statusParser.fullReset();
    this.planTracker.fullReset();
    this.stallDetector.reset();

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
   */
  private clearDebounceTimers(): void {
    this._todoDeb.cancel();
    this._loopDeb.cancel();
  }

  /**
   * Emit todoUpdate event with debouncing.
   */
  private emitTodoUpdateDebounced(): void {
    this._todoDeb.schedule(() => this.emit('todoUpdate', this.todos));
  }

  /**
   * Emit loopUpdate event with debouncing.
   */
  private emitLoopUpdateDebounced(): void {
    this._loopDeb.schedule(() => this.emit('loopUpdate', this.loopState));
  }

  /**
   * Flush all pending debounced events immediately.
   */
  flushPendingEvents(): void {
    if (this._todoDeb.isPending) {
      this._todoDeb.cancel();
      this.emit('todoUpdate', this.todos);
    }
    if (this._loopDeb.isPending) {
      this._loopDeb.cancel();
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Get a copy of the current loop state.
   */
  get loopState(): RalphTrackerState {
    return {
      ...this._loopState,
      planVersion: this.planTracker.planVersion,
      planHistoryLength: this.planTracker.getPlanHistory().length,
      completionConfidence: this._lastCompletionConfidence,
    };
  }

  /**
   * Calculate confidence score for a potential completion signal.
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
    const lastBlock = this.statusParser.lastStatusBlock;
    if (lastBlock?.exitSignal === true) {
      signals.hasExitSignal = true;
      score += 15;
    }

    // Check for multiple completion indicators (adds 10 points)
    if (this.statusParser.cumulativeStats.completionIndicators >= 2) {
      signals.multipleIndicators = true;
      score += 10;
    }

    // Check context appropriateness (deduct if inappropriate)
    if (context) {
      const lowerContext = context.toLowerCase();
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
   */
  get todos(): RalphTodoItem[] {
    return Array.from(this._todos.values());
  }

  /**
   * Process raw terminal data to detect inner loop patterns.
   */
  processTerminalData(data: string): void {
    // Remove ANSI escape codes for cleaner parsing
    const cleanData = data.replace(ANSI_ESCAPE_PATTERN_SIMPLE, '');
    this.processCleanData(cleanData);
  }

  /**
   * Process pre-stripped terminal data (ANSI codes already removed).
   */
  processCleanData(cleanData: string): void {
    // If tracker is disabled, only check for patterns that should auto-enable it
    if (!this._loopState.enabled) {
      if (this._autoEnableDisabled) {
        return;
      }
      if (this.shouldAutoEnable(cleanData)) {
        this.enable();
      } else {
        return;
      }
    }

    // Buffer data for line-based processing
    this._lineBuffer += cleanData;

    // Prevent unbounded line buffer growth from very long lines
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      this._lineBuffer = this._lineBuffer.slice(-Math.floor(MAX_LINE_BUFFER_SIZE / 2));
    }

    // Process complete lines
    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || '';

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
   */
  private shouldAutoEnable(data: string): boolean {
    // Cheap pre-filter: skip the full regex battery if none of the key
    // substrings that any pattern could match are present in the data.
    if (
      !data.includes('<') &&
      !data.includes('ralph') &&
      !data.includes('Ralph') &&
      !data.includes('Todo') &&
      !data.includes('todo') &&
      !data.includes('Iteration') &&
      !data.includes('[') &&
      !data.includes('\u2610') &&
      !data.includes('\u2612') &&
      !data.includes('\u2714') &&
      !data.includes('Loop') &&
      !data.includes('complete') &&
      !data.includes('COMPLETE') &&
      !data.includes('Done') &&
      !data.includes('DONE')
    ) {
      return false;
    }

    if (RALPH_START_PATTERN.test(data)) return true;
    if (PROMISE_PATTERN.test(data)) return true;
    if (TODOWRITE_PATTERN.test(data)) return true;
    if (ITERATION_PATTERN.test(data)) return true;

    TODO_CHECKBOX_PATTERN.lastIndex = 0;
    if (TODO_CHECKBOX_PATTERN.test(data)) return true;

    TODO_INDICATOR_PATTERN.lastIndex = 0;
    if (TODO_INDICATOR_PATTERN.test(data)) return true;

    TODO_NATIVE_PATTERN.lastIndex = 0;
    if (TODO_NATIVE_PATTERN.test(data)) return true;

    TODO_TASK_CREATED_PATTERN.lastIndex = 0;
    if (TODO_TASK_CREATED_PATTERN.test(data)) return true;

    TODO_TASK_STATUS_PATTERN.lastIndex = 0;
    if (TODO_TASK_STATUS_PATTERN.test(data)) return true;

    if (LOOP_START_PATTERN.test(data)) return true;
    if (ALL_COMPLETE_PATTERN.test(data)) return true;
    if (TASK_DONE_PATTERN.test(data)) return true;

    return false;
  }

  /**
   * Process a single line of terminal output.
   */
  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Delegate RALPH_STATUS block and completion indicator detection to sub-module
    this.statusParser.processLine(trimmed);

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
   */
  private detectAllTasksComplete(line: string): void {
    if (this.isFileAuthoritative) return;
    if (!ALL_COMPLETE_PATTERN.test(line)) return;
    if (line.length > 100) return;
    if (line.toLowerCase().includes('output:') || line.includes('<promise>')) return;
    if (this._todos.size === 0) return;

    const countMatch = line.match(ALL_COUNT_PATTERN);
    const parsedCount = countMatch ? parseInt(countMatch[1], 10) : NaN;
    const mentionedCount = Number.isNaN(parsedCount) ? null : parsedCount;
    const todoCount = this._todos.size;

    if (mentionedCount !== null && Math.abs(mentionedCount - todoCount) > 2) {
      return;
    }

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

    if (this._loopState.completionPhrase) {
      this._loopState.active = false;
      this._loopState.lastActivity = Date.now();
      this.emit('completionDetected', this._loopState.completionPhrase);
      this.emit('loopUpdate', this.loopState);
    }
  }

  /**
   * Detect individual task completion signals.
   */
  private detectTaskCompletion(line: string): void {
    if (this.isFileAuthoritative) return;
    if (!TASK_DONE_PATTERN.test(line)) return;

    const taskNumMatch = line.match(/task\s*#?(\d+)/i);
    if (taskNumMatch) {
      const taskNum = parseInt(taskNumMatch[1], 10);
      if (Number.isNaN(taskNum)) return;
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
  }

  /**
   * Check for multi-line patterns that might span line boundaries.
   */
  private checkMultiLinePatterns(data: string): void {
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
   */
  private detectCompletionPhrase(line: string): void {
    const match = line.match(PROMISE_PATTERN);
    if (match) {
      this.handleCompletionPhrase(match[1]);
      return;
    }

    const expectedPhrase = this._loopState.completionPhrase;
    if (expectedPhrase && line.toUpperCase().includes(expectedPhrase.toUpperCase())) {
      const isNotInPromptContext = !line.includes('<promise>') && !line.includes('output:');
      const isNotExplanation =
        !line.toLowerCase().includes('completion phrase') && !line.toLowerCase().includes('output exactly');

      if (isNotInPromptContext && isNotExplanation) {
        this.handleBareCompletionPhrase(expectedPhrase);
      }
    }
  }

  /**
   * Handle a bare completion phrase (without XML tags).
   */
  private handleBareCompletionPhrase(phrase: string): void {
    const taggedCount = this._completionPhraseCount.get(phrase) || 0;
    const loopExplicitlyActive = this._loopState.active;

    if (taggedCount === 0 && !loopExplicitlyActive) return;

    const bareKey = `bare:${phrase}`;
    const bareCount = (this._completionPhraseCount.get(bareKey) || 0) + 1;
    this._completionPhraseCount.set(bareKey, bareCount);

    if (bareCount > 1) return;

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

  /**
   * Handle a detected completion phrase.
   */
  private handleCompletionPhrase(phrase: string): void {
    const count = (this._completionPhraseCount.get(phrase) || 0) + 1;
    this._completionPhraseCount.set(phrase, count);

    // Trim completion phrase map if it exceeds the limit
    if (this._completionPhraseCount.size > MAX_COMPLETION_PHRASE_ENTRIES) {
      const entries = Array.from(this._completionPhraseCount.entries());
      entries.sort((a, b) => b[1] - a[1]);
      this._completionPhraseCount.clear();
      const keepCount = Math.floor(MAX_COMPLETION_PHRASE_ENTRIES / 2);
      for (let i = 0; i < Math.min(keepCount, entries.length); i++) {
        this._completionPhraseCount.set(entries[i][0], entries[i][1]);
      }
      if (this._loopState.completionPhrase && !this._completionPhraseCount.has(this._loopState.completionPhrase)) {
        this._completionPhraseCount.set(this._loopState.completionPhrase, 1);
      }
    }

    // Store phrase on first occurrence
    if (!this._loopState.completionPhrase) {
      this._loopState.completionPhrase = phrase;
      this._loopState.lastActivity = Date.now();

      this.validateCompletionPhrase(phrase);
      this.emit('loopUpdate', this.loopState);
    }

    // Check for fuzzy match with primary phrase or any alternate phrase
    const matchedPhrase = this.findMatchingCompletionPhrase(phrase);

    if (matchedPhrase) {
      const canonicalCount = this._completionPhraseCount.get(matchedPhrase) || 0;
      if (canonicalCount >= 2 || this._loopState.active) {
        this._loopState.active = false;
        this._loopState.lastActivity = Date.now();
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

    if (this._loopState.active || count >= 2) {
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
   */
  private isFuzzyPhraseMatch(phrase1: string, phrase2: string, maxDistance = 2): boolean {
    return fuzzyPhraseMatch(phrase1, phrase2, maxDistance);
  }

  /**
   * Validate a completion phrase and emit warnings if it's risky.
   */
  private validateCompletionPhrase(phrase: string): void {
    const normalized = phrase.toUpperCase().replace(/[\s_\-.]+/g, '');

    const uniqueSuffix = Date.now().toString(36).slice(-4).toUpperCase();
    const suggestedPhrase = `${phrase}_${uniqueSuffix}`;

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
   */
  private detectLoopStatus(line: string): void {
    if (RALPH_START_PATTERN.test(line) || LOOP_START_PATTERN.test(line)) {
      this.activateLoopIfNeeded();
    }

    const maxIterMatch = line.match(MAX_ITERATIONS_PATTERN);
    if (maxIterMatch) {
      const maxIter = parseInt(maxIterMatch[1], 10);
      if (!Number.isNaN(maxIter) && maxIter > 0) {
        this._loopState.maxIterations = maxIter;
        this._loopState.lastActivity = Date.now();
        this.emitLoopUpdateDebounced();
      }
    }

    const iterMatch = line.match(ITERATION_PATTERN);
    if (iterMatch) {
      const currentIter = parseInt(iterMatch[1] || iterMatch[3], 10);
      const maxIterStr = iterMatch[2] || iterMatch[4];
      const maxIter = maxIterStr ? parseInt(maxIterStr, 10) : null;

      if (!Number.isNaN(currentIter)) {
        this.activateLoopIfNeeded();
        // Track iteration changes for stall detection and circuit breaker
        if (currentIter !== this.stallDetector.getIterationStallMetrics().currentIteration) {
          this.stallDetector.notifyIterationChanged(currentIter);
          this.statusParser.notifyIterationProgress(currentIter);
        }
        this._loopState.cycleCount = currentIter;
        // Notify sub-modules of cycle count
        this.planTracker.notifyCycleCount(currentIter);
        this.statusParser.setCycleCount(currentIter);
        this.stallDetector.setLoopActive(true);

        if (maxIter !== null && !Number.isNaN(maxIter)) {
          this._loopState.maxIterations = maxIter;
        }
        this._loopState.lastActivity = Date.now();
        this.emitLoopUpdateDebounced();
      }
    }

    const elapsedMatch = line.match(ELAPSED_TIME_PATTERN);
    if (elapsedMatch) {
      this._loopState.elapsedHours = parseFloat(elapsedMatch[1]);
      this._loopState.lastActivity = Date.now();
      this.emitLoopUpdateDebounced();
    }

    const cycleMatch = line.match(CYCLE_PATTERN);
    if (cycleMatch) {
      const cycleNum = parseInt(cycleMatch[1] || cycleMatch[2], 10);
      if (!Number.isNaN(cycleNum) && cycleNum > this._loopState.cycleCount) {
        this._loopState.cycleCount = cycleNum;
        this._loopState.lastActivity = Date.now();
        this.emitLoopUpdateDebounced();
      }
    }

    if (TODOWRITE_PATTERN.test(line)) {
      this._loopState.lastActivity = Date.now();
    }
  }

  /**
   * Detect todo items in various formats from Claude Code output.
   */
  private detectTodoItems(line: string): void {
    const hasCheckbox = line.includes('[');
    const hasTodoIndicator = line.includes('Todo:');
    const hasNativeCheckbox = line.includes('☐') || line.includes('☒') || line.includes('◐') || line.includes('✓');
    const hasStatus = line.includes('(pending)') || line.includes('(in_progress)') || line.includes('(completed)');
    const hasCheckmark = line.includes('✔');

    if (!hasCheckbox && !hasTodoIndicator && !hasNativeCheckbox && !hasStatus && !hasCheckmark) {
      return;
    }

    let updated = false;
    let match: RegExpExecArray | null;

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

    if (hasStatus) {
      TODO_STATUS_PATTERN.lastIndex = 0;
      while ((match = TODO_STATUS_PATTERN.exec(line)) !== null) {
        const content = match[1].trim();
        const status = match[2] as RalphTodoStatus;
        this.upsertTodo(content, status);
        updated = true;
      }
    }

    if (hasNativeCheckbox) {
      TODO_NATIVE_PATTERN.lastIndex = 0;
      while ((match = TODO_NATIVE_PATTERN.exec(line)) !== null) {
        const icon = match[1];
        const content = match[2].trim();

        const shouldExclude = TODO_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content));
        if (shouldExclude) continue;

        if (content.length < 5) continue;

        const status = this.iconToStatus(icon);
        this.upsertTodo(content, status);
        updated = true;
      }
    }

    if (hasCheckmark) {
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

      TODO_TASK_SUMMARY_PATTERN.lastIndex = 0;
      while ((match = TODO_TASK_SUMMARY_PATTERN.exec(line)) !== null) {
        const taskNum = parseInt(match[1], 10);
        const content = match[2].trim();
        if (content.length >= 5) {
          if (!this._taskNumberToContent.has(taskNum)) {
            this._taskNumberToContent.set(taskNum, content);
            this.enforceTaskMappingLimit();
          }
          this.upsertTodo(this._taskNumberToContent.get(taskNum) || content, 'pending');
          updated = true;
        }
      }

      TODO_TASK_STATUS_PATTERN.lastIndex = 0;
      while ((match = TODO_TASK_STATUS_PATTERN.exec(line)) !== null) {
        const taskNum = parseInt(match[1], 10);
        const statusStr = match[2].trim();
        const status: RalphTodoStatus =
          statusStr === 'completed' ? 'completed' : statusStr === 'in progress' ? 'in_progress' : 'pending';
        const content = this._taskNumberToContent.get(taskNum);
        if (content) {
          this.upsertTodo(content, status);
          updated = true;
        }
      }

      if (!updated) {
        TODO_PLAIN_CHECKMARK_PATTERN.lastIndex = 0;
        while ((match = TODO_PLAIN_CHECKMARK_PATTERN.exec(line)) !== null) {
          const content = match[1].trim();
          const shouldExclude = TODO_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content));
          if (shouldExclude) continue;
          if (content.length < 5) continue;
          if (/^(Task\s*#\d+|#\d+)\s/.test(content)) continue;
          this.upsertTodo(content, 'completed');
          updated = true;
        }
      }
    }

    if (updated) {
      this.emitTodoUpdateDebounced();
    }
  }

  /**
   * Convert a todo icon character to its corresponding status.
   */
  private iconToStatus(icon: string): RalphTodoStatus {
    switch (icon) {
      case '✓':
      case '✅':
      case '☒':
      case '◉':
      case '●':
        return 'completed';
      case '◐':
      case '⏳':
      case '⌛':
      case '🔄':
        return 'in_progress';
      case '☐':
      case '○':
      default:
        return 'pending';
    }
  }

  /**
   * Parse priority from todo content.
   */
  private parsePriority(content: string): RalphTodoPriority {
    const upper = content.toUpperCase();

    for (const pattern of P0_PRIORITY_PATTERNS) {
      if (pattern.test(upper)) {
        return 'P0';
      }
    }

    for (const pattern of P1_PRIORITY_PATTERNS) {
      if (pattern.test(upper)) {
        return 'P1';
      }
    }

    for (const pattern of P2_PRIORITY_PATTERNS) {
      if (pattern.test(upper)) {
        return 'P2';
      }
    }

    return null;
  }

  /**
   * Add a new todo item or update an existing one.
   */
  private upsertTodo(content: string, status: RalphTodoStatus): void {
    if (!content || !content.trim()) return;

    const cleanContent = content.replace(ANSI_ESCAPE_PATTERN_SIMPLE, '').replace(/\s+/g, ' ').trim();
    if (cleanContent.length < 5) return;

    const priority = this.parsePriority(cleanContent);
    const estimatedComplexity = this.estimateComplexity(cleanContent);
    const id = this.generateTodoId(cleanContent);

    const existing = this._todos.get(id);
    if (existing) {
      const wasCompleted = existing.status === 'completed';
      const isNowCompleted = status === 'completed';
      const wasInProgress = existing.status === 'in_progress';
      const isNowInProgress = status === 'in_progress';

      existing.status = status;
      existing.detectedAt = Date.now();
      if (priority) existing.priority = priority;
      if (!existing.estimatedComplexity) {
        existing.estimatedComplexity = estimatedComplexity;
      }

      if (!wasCompleted && isNowCompleted) {
        this.recordTodoCompletion(id);
      }
      if (!wasInProgress && isNowInProgress) {
        this.startTrackingTodo(id);
      }
    } else {
      const similar = this.findSimilarTodo(cleanContent);
      if (similar) {
        const wasCompleted = similar.status === 'completed';
        const isNowCompleted = status === 'completed';
        const wasInProgress = similar.status === 'in_progress';
        const isNowInProgress = status === 'in_progress';

        similar.status = status;
        similar.detectedAt = Date.now();
        if (priority && !similar.priority) {
          similar.priority = priority;
        }
        if (cleanContent.length > similar.content.length) {
          similar.content = cleanContent;
        }

        if (!wasCompleted && isNowCompleted) {
          this.recordTodoCompletion(similar.id);
        }
        if (!wasInProgress && isNowInProgress) {
          this.startTrackingTodo(similar.id);
        }
        return;
      }

      while (this._todos.size >= MAX_TODOS_PER_SESSION) {
        const oldest = this.findOldestTodo();
        if (oldest) {
          this._todos.delete(oldest.id);
        } else {
          const firstKey = this._todos.keys().next().value;
          if (firstKey) this._todos.delete(firstKey);
          else break;
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

      if (status === 'in_progress') {
        this.startTrackingTodo(id);
      }
    }
  }

  /**
   * Normalize todo content for consistent matching.
   */
  private normalizeTodoContent(content: string): string {
    if (!content) return '';
    return content
      .replace(/\s+/g, ' ')
      .replace(/[^a-zA-Z0-9\s.,!?'"-]/g, '')
      .trim()
      .toLowerCase();
  }

  /**
   * Calculate similarity between two strings.
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const norm1 = this.normalizeTodoContent(str1);
    const norm2 = this.normalizeTodoContent(str2);

    if (norm1 === norm2) return 1.0;
    if (!norm1 || !norm2) return 0.0;

    const levenshteinSim = stringSimilarity(norm1, norm2);
    const bigramSim = this.calculateBigramSimilarity(norm1, norm2);

    return Math.max(levenshteinSim, bigramSim);
  }

  /**
   * Calculate bigram (Dice coefficient) similarity.
   */
  private calculateBigramSimilarity(norm1: string, norm2: string): number {
    if (norm1.length < 3 || norm2.length < 3) {
      const shorter = norm1.length <= norm2.length ? norm1 : norm2;
      const longer = norm1.length > norm2.length ? norm1 : norm2;
      return longer.includes(shorter) ? 0.9 : 0.0;
    }

    const getBigrams = (s: string): Set<string> => {
      const bigrams = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) {
        bigrams.add(s.substring(i, i + 2));
      }
      return bigrams;
    };

    const bigrams1 = getBigrams(norm1);
    const bigrams2 = getBigrams(norm2);

    let intersection = 0;
    for (const bigram of bigrams1) {
      if (bigrams2.has(bigram)) {
        intersection++;
      }
    }

    const totalBigrams = bigrams1.size + bigrams2.size;
    if (totalBigrams === 0) return 0.0;

    return (2 * intersection) / totalBigrams;
  }

  /**
   * Find an existing todo that is similar to the given content.
   */
  private findSimilarTodo(content: string): RalphTodoItem | undefined {
    const normalized = this.normalizeTodoContent(content);

    let threshold: number;
    if (normalized.length < 30) {
      threshold = 0.95;
    } else if (normalized.length < 60) {
      threshold = 0.9;
    } else {
      threshold = TODO_SIMILARITY_THRESHOLD;
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
   */
  private estimateComplexity(content: string): 'trivial' | 'simple' | 'moderate' | 'complex' {
    const lower = content.toLowerCase();

    const trivialPatterns = [
      /\btypo\b/,
      /\bspelling\b/,
      /\bcomment\b/,
      /\bupdate\s+(?:version|readme)\b/,
      /\brename\b/,
      /\bformat(?:ting)?\b/,
    ];

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

    const moderatePatterns = [/\bbug\b/, /\bfeature\b/, /\benhance(?:ment)?\b/, /\bimplement\b/, /\badd\b/, /\bfix\b/];

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
   */
  private getEstimatedDuration(complexity: 'trivial' | 'simple' | 'moderate' | 'complex'): number {
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

    const defaults = {
      trivial: 1 * 60 * 1000,
      simple: 3 * 60 * 1000,
      moderate: 10 * 60 * 1000,
      complex: 30 * 60 * 1000,
    };
    return defaults[complexity];
  }

  /**
   * Get average completion time from historical data.
   */
  private getAverageCompletionTime(): number | null {
    if (this._completionTimes.length === 0) return null;
    const sum = this._completionTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this._completionTimes.length);
  }

  /**
   * Record a todo completion for progress tracking.
   */
  private recordTodoCompletion(todoId: string): void {
    const startTime = this._todoStartTimes.get(todoId);
    if (startTime) {
      const duration = Date.now() - startTime;
      this._completionTimes.push(duration);

      while (this._completionTimes.length > RalphTracker.MAX_COMPLETION_TIMES) {
        this._completionTimes.shift();
      }

      this._todoStartTimes.delete(todoId);
    }
  }

  /**
   * Start tracking a todo for duration estimation.
   */
  private startTrackingTodo(todoId: string): void {
    if (!this._todoStartTimes.has(todoId)) {
      this._todoStartTimes.set(todoId, Date.now());
    }

    if (this._todosStartedAt === 0) {
      this._todosStartedAt = Date.now();
    }
  }

  /**
   * Get progress estimation for the todo list.
   */
  public getTodoProgress(): RalphTodoProgress {
    const todos = Array.from(this._todos.values());
    const total = todos.length;
    const completed = todos.filter((t) => t.status === 'completed').length;
    const inProgress = todos.filter((t) => t.status === 'in_progress').length;
    const pending = todos.filter((t) => t.status === 'pending').length;

    const percentComplete = total > 0 ? Math.round((completed / total) * 100) : 0;

    let estimatedRemainingMs: number | null = null;
    let avgCompletionTimeMs: number | null = null;
    let projectedCompletionAt: number | null = null;

    avgCompletionTimeMs = this.getAverageCompletionTime();

    if (total > 0 && completed > 0) {
      if (avgCompletionTimeMs !== null) {
        const remaining = total - completed;
        estimatedRemainingMs = remaining * avgCompletionTimeMs;
      } else {
        const elapsed = Date.now() - this._todosStartedAt;
        if (elapsed > 0 && completed > 0) {
          const timePerTodo = elapsed / completed;
          avgCompletionTimeMs = Math.round(timePerTodo);
          const remaining = total - completed;
          estimatedRemainingMs = Math.round(remaining * timePerTodo);
        }
      }

      if (estimatedRemainingMs !== null) {
        projectedCompletionAt = Date.now() + estimatedRemainingMs;
      }
    } else if (total > 0 && completed === 0) {
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
   * Generate a stable ID from todo content using content hashing.
   */
  private generateTodoId(content: string): string {
    if (!content) return 'todo-empty';
    const hash = todoContentHash(content);
    return `todo-${hash}`;
  }

  /**
   * Find the todo item with the oldest detectedAt timestamp.
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
   */
  startLoop(completionPhrase?: string, maxIterations?: number): void {
    this.enable();
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
   */
  setMaxIterations(maxIterations: number | null): void {
    this._loopState.maxIterations = maxIterations;
    this._loopState.lastActivity = Date.now();
    this.emit('loopUpdate', this.loopState);
  }

  /**
   * Configure the tracker from external state.
   */
  configure(config: { enabled?: boolean; completionPhrase?: string; maxIterations?: number }): void {
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
   */
  stopLoop(): void {
    this._loopState.active = false;
    this._loopState.lastActivity = Date.now();
    this.emit('loopUpdate', this.loopState);
  }

  /**
   * Enforce size limit on _taskNumberToContent map.
   */
  private enforceTaskMappingLimit(): void {
    if (this._taskNumberToContent.size <= MAX_TASK_MAPPINGS) return;

    const sortedKeys = Array.from(this._taskNumberToContent.keys()).sort((a, b) => a - b);
    const keysToRemove = sortedKeys.slice(0, this._taskNumberToContent.size - MAX_TASK_MAPPINGS);
    for (const key of keysToRemove) {
      this._taskNumberToContent.delete(key);
    }
  }

  /**
   * Clear all state and disable the tracker.
   */
  clear(): void {
    this.clearDebounceTimers();
    this.fixPlanWatcher.stop();
    this.stallDetector.stopIterationStallDetection();
    this._loopState = createInitialRalphTrackerState();
    this._todos.clear();
    this._taskNumberToContent.clear();
    this._todoStartTimes.clear();
    this._alternateCompletionPhrases.clear();
    this._lineBuffer = '';
    this._partialPromiseBuffer = '';
    this._completionPhraseCount.clear();
    // Clear sub-module state
    this.statusParser.fullReset();
    this.planTracker.fullReset();
    this.stallDetector.reset();
    this.emit('loopUpdate', this.loopState);
    this.emit('todoUpdate', this.todos);
  }

  /**
   * Get aggregated statistics about tracked todos.
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
   */
  restoreState(loopState: RalphTrackerState, todos: RalphTodoItem[]): void {
    this._loopState = {
      ...loopState,
      enabled: loopState.enabled ?? false,
    };
    this._todos.clear();
    for (const todo of todos) {
      this._todos.set(todo.id, {
        ...todo,
        priority: todo.priority ?? null,
      });
    }
  }

  /**
   * Clean up all resources and release memory.
   */
  destroy(): void {
    this._todoDeb.dispose();
    this._loopDeb.dispose();
    this.fixPlanWatcher.destroy();
    this.stallDetector.destroy();
    this.statusParser.destroy();
    this.planTracker.destroy();
    this._todos.clear();
    this._taskNumberToContent.clear();
    this._todoStartTimes.clear();
    this._alternateCompletionPhrases.clear();
    this._completionPhraseCount.clear();
    this._completionTimes.length = 0;
    this._lineBuffer = '';
    this._partialPromiseBuffer = '';
    this.removeAllListeners();
  }
}
