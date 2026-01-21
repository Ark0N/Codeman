/**
 * @fileoverview Type definitions for Claudeman
 *
 * This module contains all TypeScript interfaces, types, and enums used
 * throughout the Claudeman application. It provides type safety for:
 * - Session management
 * - Task queue operations
 * - Ralph Loop configuration
 * - API requests/responses
 * - Screen session handling
 * - Inner loop tracking (Ralph Wiggum detection)
 */

// ========== Core Status Types ==========

/** Status of a Claude session */
export type SessionStatus = 'idle' | 'busy' | 'stopped' | 'error';

/** Status of a task in the queue */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Status of the Ralph Loop controller */
export type RalphLoopStatus = 'stopped' | 'running' | 'paused';

// ========== Session Types ==========

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
}

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

/**
 * Task assignment record
 */
export interface TaskAssignment {
  /** Session ID that task is assigned to */
  sessionId: string;
  /** Task ID being assigned */
  taskId: string;
  /** Timestamp of assignment */
  assignedAt: number;
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

// ========== API Request Types ==========

/**
 * Request to create a new session
 */
export interface CreateSessionRequest {
  /** Optional working directory path */
  workingDir?: string;
}

/**
 * Request to run a prompt in a session
 */
export interface RunPromptRequest {
  /** Prompt to send to Claude */
  prompt: string;
}

/**
 * Request to send input to a session
 */
export interface SessionInputRequest {
  /** Input string to send */
  input: string;
}

/**
 * Request to resize terminal
 */
export interface ResizeRequest {
  /** Number of columns */
  cols: number;
  /** Number of rows */
  rows: number;
}

/**
 * Request to create a new case
 */
export interface CreateCaseRequest {
  /** Case name (alphanumeric with hyphens/underscores) */
  name: string;
  /** Optional case description */
  description?: string;
}

/**
 * Request for quick start (create case + session)
 */
export interface QuickStartRequest {
  /** Optional case name, defaults to 'testcase' */
  caseName?: string;
  /** Session mode: 'claude' for Claude CLI, 'shell' for bash shell */
  mode?: 'claude' | 'shell';
}

/**
 * Request to create a scheduled run
 */
export interface CreateScheduledRunRequest {
  /** Prompt to run */
  prompt: string;
  /** Optional working directory */
  workingDir?: string;
  /** Duration in minutes */
  durationMinutes: number;
}

/**
 * Request for quick run (one-shot prompt execution)
 */
export interface QuickRunRequest {
  /** Prompt to run */
  prompt: string;
  /** Optional working directory */
  workingDir?: string;
}

// ========== API Response Types ==========

/**
 * Standard API response wrapper
 * @template T Type of the data payload
 */
export interface ApiResponse<T = unknown> {
  /** Whether the request succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: ApiErrorCode;
  /** Response data payload */
  data?: T;
}

/**
 * Creates a standardized error response
 * @param code Error code
 * @param details Optional detailed error message
 * @returns Formatted error response
 */
export function createErrorResponse(code: ApiErrorCode, details?: string): ApiResponse {
  return {
    success: false,
    error: details || ErrorMessages[code],
    errorCode: code,
  };
}

/**
 * Creates a standardized success response
 * @template T Type of the data payload
 * @param data Optional response data
 * @returns Formatted success response
 */
export function createSuccessResponse<T>(data?: T): ApiResponse<T> {
  return {
    success: true,
    data,
  };
}

/**
 * Response for session operations
 */
export interface SessionResponse {
  /** Whether the request succeeded */
  success: boolean;
  /** Session details if successful */
  session?: SessionState & {
    /** Claude session ID from CLI */
    claudeSessionId: string | null;
    /** Total API cost */
    totalCost: number;
    /** Text output buffer */
    textOutput: string;
    /** Terminal buffer */
    terminalBuffer: string;
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

// ========== Screen Session Types ==========

/**
 * GNU screen session wrapper
 *
 * Claudeman uses GNU screen for session persistence across server restarts.
 */
export interface ScreenSession {
  /** Claudeman session ID */
  sessionId: string;
  /** GNU screen session name (claudeman-<id>) */
  screenName: string;
  /** Screen process PID */
  pid: number;
  /** Timestamp when created */
  createdAt: number;
  /** Working directory */
  workingDir: string;
  /** Session mode: claude or shell */
  mode: 'claude' | 'shell';
  /** Whether webserver is attached to this screen */
  attached: boolean;
  /** Session display name (tab name) */
  name?: string;
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

/**
 * Screen session with resource statistics
 */
export interface ScreenSessionWithStats extends ScreenSession {
  /** Optional resource statistics */
  stats?: ProcessStats;
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
export type InnerTodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * State of an inner loop (Ralph Wiggum loop inside Claude Code)
 */
export interface InnerLoopState {
  /** Whether the tracker is actively monitoring (disabled by default) */
  enabled: boolean;
  /** Whether a loop is currently active */
  active: boolean;
  /** Detected completion phrase */
  completionPhrase: string | null;
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
}

/**
 * A detected todo item from Claude Code output
 */
export interface InnerTodoItem {
  /** Unique identifier based on content hash */
  id: string;
  /** Todo item text content */
  content: string;
  /** Current status */
  status: InnerTodoStatus;
  /** Timestamp when detected */
  detectedAt: number;
}

/**
 * Complete inner state for a session
 */
export interface InnerSessionState {
  /** Session this state belongs to */
  sessionId: string;
  /** Loop tracking state */
  loop: InnerLoopState;
  /** Detected todo items */
  todos: InnerTodoItem[];
  /** Timestamp of last update */
  lastUpdated: number;
}

/**
 * Map of session ID to inner state
 */
export interface InnerStateRecord {
  [sessionId: string]: InnerSessionState;
}

/**
 * Creates initial inner loop state
 * @returns Fresh inner loop state with defaults
 */
export function createInitialInnerLoopState(): InnerLoopState {
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
 * Creates initial inner session state
 * @param sessionId Session ID this state belongs to
 * @returns Fresh inner session state
 */
export function createInitialInnerSessionState(sessionId: string): InnerSessionState {
  return {
    sessionId,
    loop: createInitialInnerLoopState(),
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
