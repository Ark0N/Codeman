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
import {
  RalphTrackerState,
  RalphTodoItem,
  RalphTodoStatus,
  RalphStatusBlock,
  RalphStatusValue,
  RalphTestsStatus,
  RalphWorkType,
  CircuitBreakerStatus,
  createInitialRalphTrackerState,
  createInitialCircuitBreakerStatus,
} from './types.js';

// ========== Configuration Constants ==========

/**
 * Maximum number of todo items to track per session.
 * Older items are removed when this limit is reached.
 */
const MAX_TODO_ITEMS = 50;

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
 * Maximum line buffer size to prevent unbounded growth from long lines.
 */
const MAX_LINE_BUFFER_SIZE = 64 * 1024;

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
 */
const PROMISE_PATTERN = /<promise>([^<]+)<\/promise>/;

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
 * Patterns to exclude from todo detection
 * Prevents false positives from tool invocations and Claude commentary
 */
const TODO_EXCLUDE_PATTERNS = [
  /^(?:Bash|Search|Read|Write|Glob|Grep|Edit|Task)\s*\(/i,  // Tool invocations
  /^(?:I'll |Let me |Now I|First,|Task \d+:|Result:|Error:)/i,  // Claude commentary
  /^\S+\([^)]+\)$/,                                          // Generic function call pattern
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
const ALL_COMPLETE_PATTERN = /all\s+(?:\d+\s+)?(?:tasks?|files?|items?)\s+(?:have\s+been\s+|are\s+)?(?:completed?|done|finished|created)|completed?\s+all\s+(?:\d+\s+)?tasks?|all\s+done|everything\s+(?:is\s+)?(?:completed?|done)|finished\s+all\s+tasks?/i;

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
const TASK_DONE_PATTERN = /(?:task|item|todo)\s*(?:#?\d+|"\s*[^"]+\s*")?\s*(?:is\s+)?(?:done|completed?|finished)|(?:completed?|done|finished)\s+(?:task|item)\s*(?:#?\d+)?|marking\s+(?:.*?\s+)?(?:as\s+)?completed?|marked\s+(?:.*?\s+)?(?:as\s+)?completed?/i;

// ---------- Utility Patterns ----------

/**
 * Removes ANSI escape codes from terminal output for cleaner parsing.
 * Matches: color codes (\x1b[...m), cursor movement (\x1b[...H, \x1b[...C), etc.
 */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

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
const RALPH_WORK_TYPE_PATTERN = /^WORK_TYPE:\s*(IMPLEMENTATION|TESTING|DOCUMENTATION|REFACTORING)\s*$/i;

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

  /**
   * Creates a new RalphTracker instance.
   * Starts in disabled state until Ralph patterns are detected.
   */
  constructor() {
    super();
    this._loopState = createInitialRalphTrackerState();
    this._circuitBreaker = createInitialCircuitBreakerStatus();
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
    this._loopState.enabled = wasEnabled;  // Keep enabled status
    this._todos.clear();
    this._completionPhraseCount.clear();
    this._taskNumberToContent.clear();
    this._lineBuffer = '';
    // Reset RALPH_STATUS block state
    this._statusBlockBuffer = [];
    this._inStatusBlock = false;
    this._lastStatusBlock = null;
    this._completionIndicators = 0;
    this._exitGateMet = false;
    this._totalFilesModified = 0;
    this._totalTasksCompleted = 0;
    // Keep circuit breaker state on soft reset (it tracks across iterations)
    // Emit immediately on reset (no debounce)
    this.emit('loopUpdate', this.loopState);
    this.emit('todoUpdate', this.todos);
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
    // Emit immediately on reset (no debounce)
    this.emit('loopUpdate', this.loopState);
    this.emit('todoUpdate', this.todos);
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
  get loopState(): RalphTrackerState {
    return { ...this._loopState };
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
    const cleanData = data.replace(ANSI_ESCAPE_PATTERN, '');

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
      this._lineBuffer = this._lineBuffer.slice(-MAX_LINE_BUFFER_SIZE / 2);
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
    const mentionedCount = countMatch ? parseInt(countMatch[1]) : null;
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
    if (!TASK_DONE_PATTERN.test(line)) return;

    // Only act on explicit task number references like "Task 8 is done"
    const taskNumMatch = line.match(/task\s*#?(\d+)/i);
    if (taskNumMatch) {
      const taskNum = parseInt(taskNumMatch[1]);
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
   * @param data - The full data chunk (may contain multiple lines)
   */
  private checkMultiLinePatterns(data: string): void {
    // Completion phrase can span lines, so check the whole chunk
    const promiseMatch = data.match(PROMISE_PATTERN);
    if (promiseMatch) {
      this.handleCompletionPhrase(promiseMatch[1]);
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
      const isNotExplanation = !line.toLowerCase().includes('completion phrase') &&
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
   * Uses occurrence-based detection to distinguish prompt from actual completion:
   * - 1st occurrence: Store as expected phrase (likely in prompt)
   * - 2nd occurrence: Emit completionDetected (actual completion)
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
      if (this._loopState.completionPhrase && !this._completionPhraseCount.has(this._loopState.completionPhrase)) {
        this._completionPhraseCount.set(this._loopState.completionPhrase, 1);
      }
    }

    // Store phrase on first occurrence
    if (!this._loopState.completionPhrase) {
      this._loopState.completionPhrase = phrase;
      this._loopState.lastActivity = Date.now();
      this.emit('loopUpdate', this.loopState);
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
      const maxIter = parseInt(maxIterMatch[1]);
      if (!isNaN(maxIter) && maxIter > 0) {
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
      const currentIter = parseInt(iterMatch[1] || iterMatch[3]);
      const maxIter = iterMatch[2] || iterMatch[4] ? parseInt(iterMatch[2] || iterMatch[4]) : null;

      if (!isNaN(currentIter)) {
        this.activateLoopIfNeeded();
        this._loopState.cycleCount = currentIter;
        if (maxIter !== null && !isNaN(maxIter)) {
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
      const cycleNum = parseInt(cycleMatch[1] || cycleMatch[2]);
      if (!isNaN(cycleNum) && cycleNum > this._loopState.cycleCount) {
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
    const hasNativeCheckbox = line.includes('☐') || line.includes('☒') || line.includes('◐') || line.includes('✓');
    const hasStatus = line.includes('(pending)') || line.includes('(in_progress)') || line.includes('(completed)');
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
        const shouldExclude = TODO_EXCLUDE_PATTERNS.some(pattern => pattern.test(content));
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
        const status: RalphTodoStatus = statusStr === 'completed' ? 'completed'
          : statusStr === 'in progress' ? 'in_progress'
          : 'pending';
        const content = this._taskNumberToContent.get(taskNum);
        if (content) {
          this.upsertTodo(content, status);
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
      case '☒':  // Claude Code checked checkbox
      case '◉':  // Filled circle (completed)
      case '●':  // Solid circle (completed)
        return 'completed';
      case '◐':  // Half-filled circle (in progress)
      case '⏳':
      case '⌛':
      case '🔄':
        return 'in_progress';
      case '☐':  // Claude Code empty checkbox
      case '○':  // Empty circle
      default:
        return 'pending';
    }
  }

  /**
   * Add a new todo item or update an existing one.
   *
   * Behavior:
   * - Content is cleaned (ANSI removed, whitespace collapsed)
   * - Content under 5 chars is skipped
   * - ID is generated from normalized content (stable hash)
   * - Existing item: Updates status and timestamp
   * - New item: Adds to map, evicts oldest if at MAX_TODO_ITEMS
   *
   * @param content - Raw todo content text
   * @param status - Status to set
   */
  private upsertTodo(content: string, status: RalphTodoStatus): void {
    // Skip empty or whitespace-only content
    if (!content || !content.trim()) return;

    // Clean content: remove ANSI codes, collapse whitespace, trim
    const cleanContent = content
      .replace(ANSI_ESCAPE_PATTERN, '')  // Remove ANSI escape codes
      .replace(/\s+/g, ' ')              // Collapse whitespace
      .trim();
    if (cleanContent.length < 5) return;  // Skip very short content

    // Generate a stable ID from normalized content
    const id = this.generateTodoId(cleanContent);

    const existing = this._todos.get(id);
    if (existing) {
      // Update existing todo
      existing.status = status;
      existing.detectedAt = Date.now();
    } else {
      // Add new todo
      if (this._todos.size >= MAX_TODO_ITEMS) {
        // Remove oldest todo to make room
        const oldest = this.findOldestTodo();
        if (oldest) {
          this._todos.delete(oldest.id);
        }
      }

      this._todos.set(id, {
        id,
        content: cleanContent,
        status,
        detectedAt: Date.now(),
      });
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
      .replace(/\s+/g, ' ')           // Collapse whitespace
      .replace(/[^a-zA-Z0-9\s.,!?'"-]/g, '')  // Remove special chars (keep punctuation)
      .trim()
      .toLowerCase();
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
  private generateTodoId(content: string): string {
    if (!content) return 'todo-empty';

    // Normalize content for consistent hashing
    const normalized = this.normalizeTodoContent(content);
    if (!normalized) return 'todo-empty';

    // djb2 hash algorithm - good distribution for strings
    let hash = 5381;
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) + hash) ^ normalized.charCodeAt(i);
      hash = hash | 0; // Convert to 32-bit integer
    }
    return `todo-${Math.abs(hash).toString(36)}`;
  }

  /**
   * Find the todo item with the oldest detectedAt timestamp.
   * Used for LRU eviction when at MAX_TODO_ITEMS limit.
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
    this._loopState = createInitialRalphTrackerState(); // This sets enabled: false
    this._todos.clear();
    this._taskNumberToContent.clear();
    this._lineBuffer = '';
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
      enabled: loopState.enabled ?? false,  // Override after spread for backwards compat
    };
    this._todos.clear();
    for (const todo of todos) {
      this._todos.set(todo.id, { ...todo });
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
   * @param lines - Array of lines between block markers
   * @fires statusBlockDetected - When parsing succeeds
   */
  private parseStatusBlock(lines: string[]): void {
    const block: Partial<RalphStatusBlock> = {
      parsedAt: Date.now(),
    };

    for (const line of lines) {
      // STATUS field
      const statusMatch = line.match(RALPH_STATUS_FIELD_PATTERN);
      if (statusMatch) {
        block.status = statusMatch[1].toUpperCase() as RalphStatusValue;
        continue;
      }

      // TASKS_COMPLETED_THIS_LOOP field
      const tasksMatch = line.match(RALPH_TASKS_COMPLETED_PATTERN);
      if (tasksMatch) {
        block.tasksCompletedThisLoop = parseInt(tasksMatch[1], 10);
        continue;
      }

      // FILES_MODIFIED field
      const filesMatch = line.match(RALPH_FILES_MODIFIED_PATTERN);
      if (filesMatch) {
        block.filesModified = parseInt(filesMatch[1], 10);
        continue;
      }

      // TESTS_STATUS field
      const testsMatch = line.match(RALPH_TESTS_STATUS_PATTERN);
      if (testsMatch) {
        block.testsStatus = testsMatch[1].toUpperCase() as RalphTestsStatus;
        continue;
      }

      // WORK_TYPE field
      const workMatch = line.match(RALPH_WORK_TYPE_PATTERN);
      if (workMatch) {
        block.workType = workMatch[1].toUpperCase() as RalphWorkType;
        continue;
      }

      // EXIT_SIGNAL field
      const exitMatch = line.match(RALPH_EXIT_SIGNAL_PATTERN);
      if (exitMatch) {
        block.exitSignal = exitMatch[1].toLowerCase() === 'true';
        continue;
      }

      // RECOMMENDATION field
      const recMatch = line.match(RALPH_RECOMMENDATION_PATTERN);
      if (recMatch) {
        block.recommendation = recMatch[1].trim();
        continue;
      }
    }

    // Only process if we have at least the STATUS field
    if (block.status !== undefined) {
      // Fill in defaults for missing fields
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
      if (this._circuitBreaker.consecutiveTestsFailure >= 5 && this._circuitBreaker.state !== 'OPEN') {
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
  get cumulativeStats(): { filesModified: number; tasksCompleted: number; completionIndicators: number } {
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
}
