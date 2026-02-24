/**
 * @fileoverview Type definitions for Claudeman
 *
 * This module contains all TypeScript interfaces, types, and enums used
 * throughout the Claudeman application. It provides type safety for:
 * - Session management
 * - Task queue operations
 * - Ralph Loop configuration
 * - API requests/responses
 * - Mux session handling
 * - Inner loop tracking (Ralph Wiggum detection)
 */

// ========== Resource Management Types ==========

/**
 * Interface for objects that hold resources requiring explicit cleanup.
 * Implementing classes should release timers, watchers, and other resources in dispose().
 */
export interface Disposable {
  /** Release all held resources. Safe to call multiple times. */
  dispose(): void;
  /** Whether this object has been disposed */
  readonly isDisposed: boolean;
}

/**
 * Configuration for buffer accumulator instances.
 * Used for terminal buffers, text output, and other size-limited string storage.
 */
export interface BufferConfig {
  /** Maximum buffer size in bytes before trimming */
  maxSize: number;
  /** Size to trim to when maxSize is exceeded */
  trimSize: number;
  /** Optional callback invoked when buffer is trimmed */
  onTrim?: (trimmedBytes: number) => void;
}

/**
 * Resource types that can be registered for cleanup.
 */
export type CleanupResourceType = 'timer' | 'interval' | 'watcher' | 'listener' | 'stream';

/**
 * Registration entry for a cleanup resource.
 * Used by CleanupManager to track and dispose resources.
 */
export interface CleanupRegistration {
  /** Unique identifier for this registration */
  id: string;
  /** Type of resource */
  type: CleanupResourceType;
  /** Human-readable description for debugging */
  description: string;
  /** Cleanup function to call on dispose */
  cleanup: () => void;
  /** Timestamp when registered */
  registeredAt: number;
}

// ========== Core Status Types ==========

/** Status of a Claude session */
export type SessionStatus = 'idle' | 'busy' | 'stopped' | 'error';

/** Status of a task in the queue */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Status of the Ralph Loop controller */
export type RalphLoopStatus = 'stopped' | 'running' | 'paused';

/** Task execution status for plan tracking */
export type PlanTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

/** TDD phase categories */
export type TddPhase = 'setup' | 'test' | 'impl' | 'verify' | 'review';

// ========== Session Lifecycle Audit Types ==========

/** Types of session lifecycle events recorded to the audit log */
export type LifecycleEventType =
  | 'created'           // Session object created
  | 'started'           // PTY process launched (interactive/shell/prompt)
  | 'exit'              // PTY process exited (with exit code)
  | 'deleted'           // cleanupSession() called — session removed
  | 'detached'          // Server shutdown — PTY left alive in tmux for recovery
  | 'recovered'         // Session restored from tmux on server restart
  | 'stale_cleaned'     // Removed from state.json by cleanupStaleSessions()
  | 'mux_died'          // tmux session died (detected by reconciliation)
  | 'server_started'    // Server started (marker for restart detection)
  | 'server_stopped';   // Server shutting down

/** A single entry in the session lifecycle audit log */
export interface LifecycleEntry {
  ts: number;
  event: LifecycleEventType;
  sessionId: string;
  name?: string;
  mode?: string;
  reason?: string;
  exitCode?: number | null;
  extra?: Record<string, unknown>;
}

// ========== Session Types ==========

/**
 * Claude CLI startup permission mode.
 * - `'dangerously-skip-permissions'`: Bypass all permission prompts (default)
 * - `'normal'`: Standard mode with permission prompts
 * - `'allowedTools'`: Only allow specific tools (requires allowedTools list)
 */
export type ClaudeMode = 'dangerously-skip-permissions' | 'normal' | 'allowedTools';

/**
 * Configuration for creating a new session
 */
export interface SessionConfig {
  /** Unique session identifier */
  id: string;
  /** Working directory for the session */
  workingDir: string;
  /** Timestamp when session was created */
  createdAt: number;
}

/**
 * Available session colors for visual differentiation
 */
export type SessionColor =
  | 'default'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink';

/**
 * Current state of a session
 */
export interface SessionState {
  /** Unique session identifier */
  id: string;
  /** Process ID of the PTY process, null if not running */
  pid: number | null;
  /** Current session status */
  status: SessionStatus;
  /** Working directory path */
  workingDir: string;
  /** ID of currently assigned task, null if none */
  currentTaskId: string | null;
  /** Timestamp when session was created */
  createdAt: number;
  /** Timestamp of last activity */
  lastActivityAt: number;
  /** Session display name */
  name?: string;
  /** Session mode: 'claude' or 'shell' */
  mode?: 'claude' | 'shell';
  /** Auto-clear enabled */
  autoClearEnabled?: boolean;
  /** Auto-clear token threshold */
  autoClearThreshold?: number;
  /** Auto-compact enabled */
  autoCompactEnabled?: boolean;
  /** Auto-compact token threshold */
  autoCompactThreshold?: number;
  /** Auto-compact prompt */
  autoCompactPrompt?: string;
  /** Image watcher enabled for this session */
  imageWatcherEnabled?: boolean;
  /** Total cost in USD */
  totalCost?: number;
  /** Input tokens used */
  inputTokens?: number;
  /** Output tokens used */
  outputTokens?: number;
  /** Whether respawn controller is currently enabled/running */
  respawnEnabled?: boolean;
  /** Respawn controller config (if enabled) */
  respawnConfig?: RespawnConfig & { durationMinutes?: number };
  /** Ralph / Todo tracker enabled */
  ralphEnabled?: boolean;
  /** Ralph auto-enable disabled (user explicitly turned off Ralph) */
  ralphAutoEnableDisabled?: boolean;
  /** Ralph completion phrase (if set) */
  ralphCompletionPhrase?: string;
  /** Parent agent ID if this session is a spawned agent */
  parentAgentId?: string;
  /** Child agent IDs spawned by this session */
  childAgentIds?: string[];
  /** Nice priority enabled */
  niceEnabled?: boolean;
  /** Nice value (-20 to 19) */
  niceValue?: number;
  /** User-assigned color for visual differentiation */
  color?: SessionColor;
  /** Flicker filter enabled (buffers output after screen clears) */
  flickerFilterEnabled?: boolean;
  /** Claude Code CLI version (parsed from terminal, e.g., "2.1.27") */
  cliVersion?: string;
  /** Claude model in use (parsed from terminal, e.g., "Opus 4.5") */
  cliModel?: string;
  /** Account type (parsed from terminal, e.g., "Claude Max", "API") */
  cliAccountType?: string;
  /** Latest CLI version available (parsed from version check) */
  cliLatestVersion?: string;
}

// ========== Global Stats Types ==========

/**
 * Global statistics across all sessions (including deleted ones).
 * Persisted to track cumulative usage over time.
 */
export interface GlobalStats {
  /** Total input tokens used across all sessions */
  totalInputTokens: number;
  /** Total output tokens used across all sessions */
  totalOutputTokens: number;
  /** Total cost in USD across all sessions */
  totalCost: number;
  /** Total number of sessions created (lifetime) */
  totalSessionsCreated: number;
  /** Timestamp when stats were first recorded */
  firstRecordedAt: number;
  /** Timestamp of last update */
  lastUpdatedAt: number;
}

// ========== Token Usage History Types ==========

/**
 * Daily token usage entry for historical tracking.
 */
export interface TokenUsageEntry {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Input tokens used on this day */
  inputTokens: number;
  /** Output tokens used on this day */
  outputTokens: number;
  /** Estimated cost in USD */
  estimatedCost: number;
  /** Number of sessions that contributed to this day's usage */
  sessions: number;
}

/**
 * Token usage statistics with daily tracking.
 */
export interface TokenStats {
  /** Daily usage entries (most recent first) */
  daily: TokenUsageEntry[];
  /** Timestamp of last update */
  lastUpdated: number;
}

// ========== Task Types ==========

/**
 * Definition of a task to be executed
 */
export interface TaskDefinition {
  /** Unique task identifier */
  id: string;
  /** Prompt to send to Claude */
  prompt: string;
  /** Working directory for task execution */
  workingDir: string;
  /** Priority level (higher = processed first) */
  priority: number;
  /** IDs of tasks that must complete first */
  dependencies: string[];
  /** Custom phrase to detect task completion */
  completionPhrase?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Full state of a task including execution details
 */
export interface TaskState {
  /** Unique task identifier */
  id: string;
  /** Prompt sent to Claude */
  prompt: string;
  /** Working directory for task execution */
  workingDir: string;
  /** Priority level (higher = processed first) */
  priority: number;
  /** IDs of tasks that must complete first */
  dependencies: string[];
  /** Custom phrase to detect task completion */
  completionPhrase?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Current task status */
  status: TaskStatus;
  /** ID of session running this task, null if not assigned */
  assignedSessionId: string | null;
  /** Timestamp when task was created */
  createdAt: number;
  /** Timestamp when task started executing */
  startedAt: number | null;
  /** Timestamp when task completed */
  completedAt: number | null;
  /** Captured output from Claude */
  output: string;
  /** Error message if task failed */
  error: string | null;
}

// ========== Ralph Loop Types ==========

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

// ========== Application State ==========

/**
 * Complete application state
 */
export interface AppState {
  /** Map of session ID to session state */
  sessions: Record<string, SessionState>;
  /** Map of task ID to task state */
  tasks: Record<string, TaskState>;
  /** Ralph Loop controller state */
  ralphLoop: RalphLoopState;
  /** Application configuration */
  config: AppConfig;
  /** Global statistics (cumulative across all sessions) */
  globalStats?: GlobalStats;
  /** Daily token usage statistics */
  tokenStats?: TokenStats;
}

// ========== Nice Priority Types ==========

/**
 * Configuration for process priority using `nice`.
 * Lower priority reduces CPU contention with other processes.
 */
export interface NiceConfig {
  /** Whether nice priority is enabled */
  enabled: boolean;
  /** Nice value (-20 to 19, default: 10 = lower priority) */
  niceValue: number;
}

export const DEFAULT_NICE_CONFIG: NiceConfig = {
  enabled: false,
  niceValue: 10,
};

// ========== Respawn Controller Types ==========

/**
 * Configuration for the Respawn Controller
 *
 * The respawn controller keeps interactive sessions productive by
 * automatically cycling through update prompts when Claude goes idle.
 */
export interface RespawnConfig {
  /** How long to wait after seeing prompt before considering truly idle (ms) */
  idleTimeoutMs: number;
  /** The prompt to send for updating docs */
  updatePrompt: string;
  /** Delay between sending steps (ms) */
  interStepDelayMs: number;
  /** Whether to enable respawn loop */
  enabled: boolean;
  /** Whether to send /clear after update prompt */
  sendClear: boolean;
  /** Whether to send /init after /clear */
  sendInit: boolean;
  /** Optional prompt to send if /init doesn't trigger work */
  kickstartPrompt?: string;
  /** Time to wait after completion message before confirming idle (ms) */
  completionConfirmMs?: number;
  /** Fallback timeout when no output received at all (ms) */
  noOutputTimeoutMs?: number;
  /** Whether to auto-accept plan mode prompts by pressing Enter (not questions) */
  autoAcceptPrompts?: boolean;
  /** Delay before auto-accepting plan mode prompts when no output and no completion message (ms) */
  autoAcceptDelayMs?: number;
  /** Whether AI idle check is enabled */
  aiIdleCheckEnabled?: boolean;
  /** Model to use for AI idle check */
  aiIdleCheckModel?: string;
  /** Maximum characters of terminal buffer for AI check */
  aiIdleCheckMaxContext?: number;
  /** Timeout for AI check in ms */
  aiIdleCheckTimeoutMs?: number;
  /** Cooldown after WORKING verdict in ms */
  aiIdleCheckCooldownMs?: number;
  /** Whether AI plan mode check is enabled for auto-accept */
  aiPlanCheckEnabled?: boolean;
  /** Model to use for AI plan mode check */
  aiPlanCheckModel?: string;
  /** Maximum characters of terminal buffer for plan check */
  aiPlanCheckMaxContext?: number;
  /** Timeout for AI plan check in ms */
  aiPlanCheckTimeoutMs?: number;
  /** Cooldown after NOT_PLAN_MODE verdict in ms */
  aiPlanCheckCooldownMs?: number;

  // ========== P2-001: Adaptive Timing ==========

  /** Whether to use adaptive timing based on historical patterns */
  adaptiveTimingEnabled?: boolean;
  /** Minimum value for adaptive completion confirm (ms) */
  adaptiveMinConfirmMs?: number;
  /** Maximum value for adaptive completion confirm (ms) */
  adaptiveMaxConfirmMs?: number;

  // ========== P2-002: Skip-Clear Optimization ==========

  /** Whether to skip /clear when context is below threshold */
  skipClearWhenLowContext?: boolean;
  /** Token percentage threshold below which /clear is skipped (0-100) */
  skipClearThresholdPercent?: number;

  // ========== P2-004: Cycle Metrics ==========

  /** Whether to track and persist cycle metrics */
  trackCycleMetrics?: boolean;
}

// ========== P2-004: Respawn Cycle Metrics ==========

/**
 * Outcome of a respawn cycle
 */
export type CycleOutcome =
  | 'success'           // Cycle completed normally
  | 'stuck_recovery'    // Stuck-state recovery triggered
  | 'blocked'           // Blocked by circuit breaker or exit signal
  | 'error'             // Error during cycle
  | 'cancelled';        // Cancelled (e.g., controller stopped)

/**
 * Metrics for a single respawn cycle.
 * Persisted for post-mortem analysis of long-running loops.
 */
export interface RespawnCycleMetrics {
  /** Unique cycle ID (session-id:cycle-number) */
  cycleId: string;
  /** Session ID this cycle belongs to */
  sessionId: string;
  /** Cycle number within the session */
  cycleNumber: number;
  /** Timestamp when cycle started */
  startedAt: number;
  /** Timestamp when cycle completed */
  completedAt: number;
  /** Total duration of cycle (ms) */
  durationMs: number;
  /** What triggered idle detection */
  idleReason: string;
  /** Time spent detecting idle (from start of watching to idle confirmed) */
  idleDetectionMs: number;
  /** Steps completed in this cycle */
  stepsCompleted: string[];
  /** Whether /clear was skipped (P2-002) */
  clearSkipped: boolean;
  /** Outcome of the cycle */
  outcome: CycleOutcome;
  /** Error message if outcome is 'error' */
  errorMessage?: string;
  /** Token count at start of cycle */
  tokenCountAtStart?: number;
  /** Token count at end of cycle */
  tokenCountAtEnd?: number;
  /** Completion confirm time used (may be adaptive) */
  completionConfirmMsUsed: number;
}

/**
 * Aggregate metrics across multiple cycles for health scoring.
 */
export interface RespawnAggregateMetrics {
  /** Total cycles tracked */
  totalCycles: number;
  /** Successful cycles */
  successfulCycles: number;
  /** Cycles that required stuck-state recovery */
  stuckRecoveryCycles: number;
  /** Blocked cycles */
  blockedCycles: number;
  /** Error cycles */
  errorCycles: number;
  /** Average cycle duration (ms) */
  avgCycleDurationMs: number;
  /** Average idle detection time (ms) */
  avgIdleDetectionMs: number;
  /** 90th percentile cycle duration (ms) */
  p90CycleDurationMs: number;
  /** Success rate (0-100) */
  successRate: number;
  /** Last updated timestamp */
  lastUpdatedAt: number;
}

// ========== P2-005: Ralph Loop Health Score ==========

/**
 * Health status levels for the Ralph Loop system.
 */
export type HealthStatus = 'excellent' | 'good' | 'degraded' | 'critical';

/**
 * Comprehensive health score for a Ralph Loop session.
 * Aggregates multiple health signals into a single score.
 */
export interface RalphLoopHealthScore {
  /** Overall health score (0-100) */
  score: number;
  /** Health status based on score thresholds */
  status: HealthStatus;
  /** Individual component scores (0-100 each) */
  components: {
    /** Based on recent cycle success rate */
    cycleSuccess: number;
    /** Based on circuit breaker state */
    circuitBreaker: number;
    /** Based on iteration stall metrics */
    iterationProgress: number;
    /** Based on AI checker error rate */
    aiChecker: number;
    /** Based on stuck-state recovery count */
    stuckRecovery: number;
  };
  /** Human-readable summary of health */
  summary: string;
  /** Recommendations for improvement */
  recommendations: string[];
  /** Timestamp when score was calculated */
  calculatedAt: number;
}

// ========== Timing History for Adaptive Timing ==========

/**
 * Historical timing data for adaptive adjustments.
 */
export interface TimingHistory {
  /** Rolling window of recent idle detection durations (ms) */
  recentIdleDetectionMs: number[];
  /** Rolling window of recent cycle durations (ms) */
  recentCycleDurationMs: number[];
  /** Calculated adaptive completion confirm value (ms) */
  adaptiveCompletionConfirmMs: number;
  /** Number of samples in rolling windows */
  sampleCount: number;
  /** Maximum samples to keep */
  maxSamples: number;
  /** Last updated timestamp */
  lastUpdatedAt: number;
}

/**
 * Named respawn configuration preset for quick setup
 */
export interface RespawnPreset {
  /** Unique preset identifier */
  id: string;
  /** User-friendly preset name */
  name: string;
  /** Description of when to use this preset */
  description?: string;
  /** The respawn configuration (without enabled flag) */
  config: Omit<RespawnConfig, 'enabled'>;
  /** Duration in minutes (optional default) */
  durationMinutes?: number;
  /** Whether this is a built-in preset */
  builtIn?: boolean;
  /** Timestamp when created */
  createdAt: number;
}

/**
 * Application configuration
 */
export interface AppConfig {
  /** Interval for polling session status (ms) */
  pollIntervalMs: number;
  /** Default timeout for tasks (ms) */
  defaultTimeoutMs: number;
  /** Maximum concurrent sessions allowed */
  maxConcurrentSessions: number;
  /** Path to state file */
  stateFilePath: string;
  /** Respawn controller configuration */
  respawn: RespawnConfig;
  /** Last used case name (for default selection) */
  lastUsedCase: string | null;
  /** Whether Ralph/Todo tracker is globally enabled for all new sessions */
  ralphEnabled: boolean;
}

// ========== Output Types ==========

/**
 * Output captured from a session
 */
export interface SessionOutput {
  /** Standard output content */
  stdout: string;
  /** Standard error content */
  stderr: string;
  /** Exit code of the process, null if still running */
  exitCode: number | null;
}

// ========== API Error Handling ==========

/**
 * Standard error codes for API responses
 */
export enum ApiErrorCode {
  /** Resource not found */
  NOT_FOUND = 'NOT_FOUND',
  /** Invalid input provided */
  INVALID_INPUT = 'INVALID_INPUT',
  /** Session is currently busy */
  SESSION_BUSY = 'SESSION_BUSY',
  /** Operation failed */
  OPERATION_FAILED = 'OPERATION_FAILED',
  /** Resource already exists */
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  /** Internal server error */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * User-friendly error messages for each error code
 */
export const ErrorMessages: Record<ApiErrorCode, string> = {
  [ApiErrorCode.NOT_FOUND]: 'The requested resource was not found',
  [ApiErrorCode.INVALID_INPUT]: 'Invalid input provided',
  [ApiErrorCode.SESSION_BUSY]: 'Session is currently busy',
  [ApiErrorCode.OPERATION_FAILED]: 'The operation failed',
  [ApiErrorCode.ALREADY_EXISTS]: 'Resource already exists',
  [ApiErrorCode.INTERNAL_ERROR]: 'An internal error occurred',
};

/**
 * Hook event types triggered by Claude Code's hooks system
 */
export type HookEventType = 'idle_prompt' | 'permission_prompt' | 'elicitation_dialog' | 'stop' | 'teammate_idle' | 'task_completed';

// ========== API Response Types ==========

/**
 * Standard API response wrapper (discriminated union for type safety)
 * @template T Type of the data payload
 */
export type ApiResponse<T = unknown> =
  | { success: true; data?: T }
  | { success: false; error: string; errorCode: ApiErrorCode };

/**
 * Creates a standardized error response
 * @param code Error code
 * @param details Optional detailed error message
 * @returns Formatted error response
 */
export function createErrorResponse(code: ApiErrorCode, details?: string): ApiResponse<never> {
  return {
    success: false,
    error: details || ErrorMessages[code],
    errorCode: code,
  };
}

/**
 * Response for session operations
 */
export interface SessionResponse {
  /** Whether the request succeeded */
  success: boolean;
  /** Session details if successful (light state — no full buffers) */
  session?: SessionState & {
    /** Claude session ID from CLI */
    claudeSessionId: string | null;
    /** Total API cost */
    totalCost: number;
    /** Number of messages */
    messageCount: number;
    /** Whether Claude is working */
    isWorking: boolean;
    /** Timestamp of last prompt */
    lastPromptTime: number;
  };
  /** Error message if failed */
  error?: string;
}

/**
 * Response for quick start operation
 */
export interface QuickStartResponse {
  /** Whether the request succeeded */
  success: boolean;
  /** Created session ID */
  sessionId?: string;
  /** Path to case folder */
  casePath?: string;
  /** Case name */
  caseName?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Information about a case folder
 */
export interface CaseInfo {
  /** Case name */
  name: string;
  /** Full path to case folder */
  path: string;
  /** Whether CLAUDE.md exists */
  hasClaudeMd?: boolean;
}

// ========== Mux Session Types ==========

/**
 * Persisted respawn configuration for mux sessions.
 * Subset of RespawnConfig that gets saved to disk.
 */
export interface PersistedRespawnConfig {
  /** Whether respawn was enabled */
  enabled: boolean;
  /** How long to wait after seeing prompt before considering truly idle (ms) */
  idleTimeoutMs: number;
  /** The prompt to send for updating docs */
  updatePrompt: string;
  /** Delay between sending steps (ms) */
  interStepDelayMs: number;
  /** Whether to send /clear after update prompt */
  sendClear: boolean;
  /** Whether to send /init after /clear */
  sendInit: boolean;
  /** Optional prompt to send if /init doesn't trigger work */
  kickstartPrompt?: string;
  /** Whether to auto-accept plan mode prompts by pressing Enter (not questions) */
  autoAcceptPrompts?: boolean;
  /** Delay before auto-accepting prompts (ms) */
  autoAcceptDelayMs?: number;
  /** Time to wait after completion message before confirming idle (ms) */
  completionConfirmMs?: number;
  /** Fallback timeout when no output received at all (ms) */
  noOutputTimeoutMs?: number;
  /** Whether AI idle check is enabled */
  aiIdleCheckEnabled?: boolean;
  /** Model to use for AI idle check */
  aiIdleCheckModel?: string;
  /** Maximum characters of terminal buffer for AI check */
  aiIdleCheckMaxContext?: number;
  /** Timeout for AI check in ms */
  aiIdleCheckTimeoutMs?: number;
  /** Cooldown after WORKING verdict in ms */
  aiIdleCheckCooldownMs?: number;
  /** Whether AI plan mode check is enabled for auto-accept */
  aiPlanCheckEnabled?: boolean;
  /** Model to use for AI plan mode check */
  aiPlanCheckModel?: string;
  /** Maximum characters of terminal buffer for plan check */
  aiPlanCheckMaxContext?: number;
  /** Timeout for AI plan check in ms */
  aiPlanCheckTimeoutMs?: number;
  /** Cooldown after NOT_PLAN_MODE verdict in ms */
  aiPlanCheckCooldownMs?: number;
  /** Duration in minutes if timed respawn was set */
  durationMinutes?: number;
}

/**
 * Process resource statistics
 */
export interface ProcessStats {
  /** Memory usage in megabytes */
  memoryMB: number;
  /** CPU usage percentage */
  cpuPercent: number;
  /** Number of child processes */
  childCount: number;
  /** Timestamp of stats collection */
  updatedAt: number;
}

// ========== Default Configuration ==========

/**
 * Default application configuration values
 */
export const DEFAULT_CONFIG: AppConfig = {
  pollIntervalMs: 1000,
  defaultTimeoutMs: 300000, // 5 minutes
  maxConcurrentSessions: 5,
  stateFilePath: '',
  respawn: {
    idleTimeoutMs: 5000,           // 5 seconds of no activity after prompt
    updatePrompt: 'update all the docs and CLAUDE.md',
    interStepDelayMs: 1000,        // 1 second between steps
    enabled: false,                // disabled by default
    sendClear: true,               // send /clear after update prompt
    sendInit: true,                // send /init after /clear
  },
  lastUsedCase: null,
  ralphEnabled: false,
};

// ========== Inner Loop Tracking Types ==========

/**
 * Types for tracking Ralph Wiggum loops and todo lists
 * running inside Claude Code sessions.
 *
 * This allows Claudeman to detect and display when Claude Code
 * is running its own autonomous loops internally.
 */

/** Status of a detected todo item */
export type RalphTodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * State of per-session Ralph / Todo tracking (detected from Claude output)
 */
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
    enabled: false,  // Disabled by default, auto-enables when Ralph patterns detected
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

/**
 * Creates initial application state
 * @returns Fresh application state with defaults
 */
export function createInitialState(): AppState {
  return {
    sessions: {},
    tasks: {},
    ralphLoop: {
      status: 'stopped',
      startedAt: null,
      minDurationMs: null,
      tasksCompleted: 0,
      tasksGenerated: 0,
      lastCheckAt: null,
    },
    config: { ...DEFAULT_CONFIG },
    globalStats: createInitialGlobalStats(),
  };
}

/**
 * Creates initial global stats object
 * @returns Fresh global stats with zero values
 */
export function createInitialGlobalStats(): GlobalStats {
  const now = Date.now();
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    totalSessionsCreated: 0,
    firstRecordedAt: now,
    lastUpdatedAt: now,
  };
}

// ========== Error Handling Utilities ==========

/**
 * Type guard to check if a value is an Error instance
 * @param value The value to check
 * @returns True if the value is an Error instance
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Safely extracts an error message from an unknown caught value.
 * Handles the TypeScript 4.4+ unknown error type in catch blocks.
 *
 * @param error The caught error (type unknown in strict mode)
 * @returns A string error message
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   console.error('Failed:', getErrorMessage(err));
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'An unknown error occurred';
}

// ========== Run Summary Types ==========

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

// ========== Active Bash Tool Types ==========

/**
 * Status of an active Bash tool command.
 */
export type ActiveBashToolStatus = 'running' | 'completed';

/**
 * Represents an active Bash tool command detected in Claude's output.
 * Used to display clickable file paths for file-viewing commands.
 */
export interface ActiveBashTool {
  /** Unique identifier for this tool invocation */
  id: string;
  /** The full command being executed */
  command: string;
  /** Extracted file paths from the command (clickable) */
  filePaths: string[];
  /** Timeout string if specified (e.g., "16m 0s") */
  timeout?: string;
  /** Timestamp when the tool started */
  startedAt: number;
  /** Current status */
  status: ActiveBashToolStatus;
  /** Session ID this tool belongs to */
  sessionId: string;
}

// ========== Image Watcher Types ==========

/**
 * Event emitted when a new image file is detected in a session's working directory.
 * Used to trigger automatic image popup display in the web UI.
 */
export interface ImageDetectedEvent {
  /** Claudeman session ID where the image was detected */
  sessionId: string;
  /** Full path to the detected image file */
  filePath: string;
  /** Path relative to the session's working directory (for file-raw endpoint) */
  relativePath: string;
  /** Image file name (basename) */
  fileName: string;
  /** Timestamp when the image was detected */
  timestamp: number;
  /** File size in bytes */
  size: number;
}

// ========== Pane Types ==========

/**
 * Information about a tmux pane within a session.
 * Used for agent team teammate pane management.
 */
export interface PaneInfo {
  /** Pane ID (e.g., "%0", "%1") — immutable within a tmux session */
  paneId: string;
  /** Pane index within the window (0, 1, 2...) */
  paneIndex: number;
  /** PID of the process running in the pane */
  panePid: number;
  /** Pane width in columns */
  width: number;
  /** Pane height in rows */
  height: number;
}

// ========== Plan Orchestrator Re-exports ==========

export type { PlanItem } from './plan-orchestrator.js';

// ========== Agent Teams Types ==========

/** Team configuration from ~/.claude/teams/{name}/config.json */
export interface TeamConfig {
  name: string;
  leadSessionId: string;
  members: TeamMember[];
}

/** A single team member (lead or teammate) */
export interface TeamMember {
  agentId: string;
  name: string;
  agentType: 'team-lead' | 'general-purpose' | string;
  color?: string;
  backendType?: string;
  prompt?: string;
  tmuxPaneId?: string;
}

/** A task from ~/.claude/tasks/{team-name}/{N}.json */
export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/** An inbox message from ~/.claude/teams/{name}/inboxes/{member}.json */
export interface InboxMessage {
  from: string;
  text: string;
  timestamp: string;
  read?: boolean;
}
