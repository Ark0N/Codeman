/**
 * @fileoverview Core PTY session wrapper for Claude CLI interactions.
 *
 * This module provides the Session class which manages a PTY (pseudo-terminal)
 * process running the Claude CLI. It supports three operation modes:
 *
 * 1. **One-shot mode** (`runPrompt`): Execute a single prompt and get JSON response
 * 2. **Interactive mode** (`startInteractive`): Start an interactive Claude session
 * 3. **Shell mode**: Run a plain bash shell for debugging/testing
 *
 * The session can optionally run inside a GNU Screen session for persistence
 * across disconnects. It tracks tokens, costs, background tasks, and supports
 * auto-clear/auto-compact functionality when token limits are approached.
 *
 * @module session
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import { SessionState, SessionStatus, SessionConfig, ScreenSession, RalphTrackerState, RalphTodoItem, ActiveBashTool, NiceConfig, DEFAULT_NICE_CONFIG } from './types.js';
import { TaskTracker, type BackgroundTask } from './task-tracker.js';
import { RalphTracker } from './ralph-tracker.js';
import { BashToolParser } from './bash-tool-parser.js';
import { ScreenManager } from './screen-manager.js';
import { BufferAccumulator } from './utils/buffer-accumulator.js';
import {
  ANSI_ESCAPE_PATTERN_FULL,
  TOKEN_PATTERN,
  MAX_SESSION_TOKENS,
} from './utils/index.js';
import {
  MAX_TERMINAL_BUFFER_SIZE,
  TRIM_TERMINAL_TO as TERMINAL_BUFFER_TRIM_SIZE,
  MAX_TEXT_OUTPUT_SIZE,
  TRIM_TEXT_TO as TEXT_OUTPUT_TRIM_SIZE,
  MAX_MESSAGES,
  MAX_LINE_BUFFER_SIZE,
} from './config/buffer-limits.js';

export type { BackgroundTask } from './task-tracker.js';
export type { RalphTrackerState, RalphTodoItem, ActiveBashTool } from './types.js';
export { withTimeout };

/** Line buffer flush interval (100ms) - forces processing of partial lines */
const LINE_BUFFER_FLUSH_INTERVAL = 100;

// ============================================================================
// Timing Constants
// ============================================================================

/** Timeout for exec commands like 'which claude' (5 seconds) */
const EXEC_TIMEOUT_MS = 5000;

/** Delay after screen creation before sending commands (300ms) */
const SCREEN_STARTUP_DELAY_MS = 300;

/** Delay before declaring session idle after last output (2 seconds) */
const IDLE_DETECTION_DELAY_MS = 2000;

/** Delay for auto-compact/clear retry attempts (2 seconds) */
const AUTO_RETRY_DELAY_MS = 2000;

/** Delay for auto-compact/clear initial check (1 second) */
const AUTO_INITIAL_DELAY_MS = 1000;

/** Graceful shutdown delay when stopping session (100ms) */
const GRACEFUL_SHUTDOWN_DELAY_MS = 100;

// Filter out terminal focus escape sequences (focus in/out reports)
// ^[[I (focus in), ^[[O (focus out), and the enable/disable sequences
const FOCUS_ESCAPE_FILTER = /\x1b\[\?1004[hl]|\x1b\[[IO]/g;

// Pattern to match Task tool invocations in terminal output
// Matches: "Explore(Description)", "Task(Description)", "Bash(Description)", etc.
// The prefix characters vary (●, ·, ✶, etc.) so we don't require them
// We look for the tool name followed by (description)
const TASK_TOOL_PATTERN = /\b(Explore|Task|Bash|Plan|general-purpose)\(([^)]+)\)/g;

// ============================================================================
// Claude CLI PATH Resolution
// ============================================================================

/** Common directories where the Claude CLI binary may be installed */
const CLAUDE_SEARCH_DIRS = [
  `${process.env.HOME}/.local/bin`,
  `${process.env.HOME}/.claude/local`,
  '/usr/local/bin',
  `${process.env.HOME}/.npm-global/bin`,
  `${process.env.HOME}/bin`,
];

/** Cached PATH string with claude's directory prepended */
let _augmentedPath: string | null = null;

/**
 * Returns a PATH string that includes the directory containing `claude`.
 *
 * Finds the claude binary (via `which` or common install locations), then
 * prepends its directory to the current PATH if not already present.
 * Result is cached for subsequent calls.
 */
export function getAugmentedPath(): string {
  if (_augmentedPath) return _augmentedPath;

  const currentPath = process.env.PATH || '';
  let claudeDir: string | null = null;

  // Try `which` first (respects current PATH)
  try {
    const result = execSync('which claude', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
    if (result && existsSync(result)) {
      claudeDir = dirname(result);
    }
  } catch {
    // not in PATH, check common locations
  }

  // Fallback: check common installation directories
  if (!claudeDir) {
    for (const dir of CLAUDE_SEARCH_DIRS) {
      if (existsSync(`${dir}/claude`)) {
        claudeDir = dir;
        break;
      }
    }
  }

  if (claudeDir && !currentPath.split(':').includes(claudeDir)) {
    _augmentedPath = `${claudeDir}:${currentPath}`;
    console.log('[Session] Augmented PATH with claude directory:', claudeDir);
  } else {
    _augmentedPath = currentPath;
  }

  return _augmentedPath;
}

/**
 * Wraps a promise with a timeout to prevent indefinite hangs.
 * If the promise doesn't resolve within the timeout, rejects with TimeoutError.
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Description of the operation for error messages
 * @returns Promise that resolves/rejects with the original result or timeout error
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Represents a JSON message from Claude CLI's stream-json output format.
 * Messages are newline-delimited JSON objects parsed from PTY output.
 */
export interface ClaudeMessage {
  /** Message type indicating the role or purpose */
  type: 'system' | 'assistant' | 'user' | 'result';
  /** Optional subtype for further classification */
  subtype?: string;
  /** Claude's internal session identifier */
  session_id?: string;
  /** Message content with optional token usage */
  message?: {
    content: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  /** Final result text (on result messages) */
  result?: string;
  /** Whether this message represents an error */
  is_error?: boolean;
  /** Total cost in USD (on result messages) */
  total_cost_usd?: number;
  /** Total duration in milliseconds (on result messages) */
  duration_ms?: number;
}

/**
 * Event signatures emitted by the Session class.
 * Subscribe using `session.on('eventName', handler)`.
 */
export interface SessionEvents {
  /** Processed text output (ANSI stripped) */
  output: (data: string) => void;
  /** Parsed JSON message from Claude CLI */
  message: (msg: ClaudeMessage) => void;
  /** Error output from the session */
  error: (data: string) => void;
  /** Session process exited */
  exit: (code: number | null) => void;
  /** One-shot prompt completed with result and cost */
  completion: (result: string, cost: number) => void;
  /** Raw terminal data (includes ANSI codes) */
  terminal: (data: string) => void;
  /** Signal to clear terminal display (after screen attach) */
  clearTerminal: () => void;
  /** New background task started */
  taskCreated: (task: BackgroundTask) => void;
  /** Background task status changed */
  taskUpdated: (task: BackgroundTask) => void;
  /** Background task finished successfully */
  taskCompleted: (task: BackgroundTask) => void;
  /** Background task failed with error */
  taskFailed: (task: BackgroundTask, error: string) => void;
  /** Auto-clear triggered due to token threshold */
  autoClear: (data: { tokens: number; threshold: number }) => void;
  /** Auto-compact triggered due to token threshold */
  autoCompact: (data: { tokens: number; threshold: number; prompt?: string }) => void;
  /** Ralph loop state changed */
  ralphLoopUpdate: (state: RalphTrackerState) => void;
  /** Ralph todo list updated */
  ralphTodoUpdate: (todos: RalphTodoItem[]) => void;
  /** Ralph completion phrase detected */
  ralphCompletionDetected: (phrase: string) => void;
  /** RALPH_STATUS block detected */
  ralphStatusBlockDetected: (block: import('./types.js').RalphStatusBlock) => void;
  /** Circuit breaker state changed */
  ralphCircuitBreakerUpdate: (status: import('./types.js').CircuitBreakerStatus) => void;
  /** Dual-condition exit gate met */
  ralphExitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  /** Bash tool with file paths started */
  bashToolStart: (tool: ActiveBashTool) => void;
  /** Bash tool completed */
  bashToolEnd: (tool: ActiveBashTool) => void;
  /** Active Bash tools list updated */
  bashToolsUpdate: (tools: ActiveBashTool[]) => void;
}

/**
 * Session operation mode.
 * - `'claude'`: Runs Claude CLI for AI interactions (default)
 * - `'shell'`: Runs a plain bash shell for debugging/testing
 */
export type SessionMode = 'claude' | 'shell';

/**
 * Core session class that wraps a PTY process running Claude CLI or a shell.
 *
 * @example
 * ```typescript
 * // Create and start an interactive Claude session
 * const session = new Session({
 *   workingDir: '/path/to/project',
 *   screenManager: screenManager,
 *   useScreen: true
 * });
 * await session.startInteractive();
 *
 * // Listen for events
 * session.on('terminal', (data) => console.log(data));
 * session.on('message', (msg) => console.log('Claude:', msg));
 *
 * // Send input
 * session.write('Hello Claude!\r');
 *
 * // Stop when done
 * await session.stop();
 * ```
 *
 * @fires Session#terminal - Raw terminal output
 * @fires Session#message - Parsed Claude JSON message
 * @fires Session#completion - One-shot prompt completed
 * @fires Session#exit - Process exited
 * @fires Session#autoClear - Token threshold reached, clearing context
 * @fires Session#autoCompact - Token threshold reached, compacting context
 */
export class Session extends EventEmitter {
  readonly id: string;
  readonly workingDir: string;
  readonly createdAt: number;
  readonly mode: SessionMode;

  private _name: string;
  private ptyProcess: pty.IPty | null = null;
  private _pid: number | null = null;
  private _status: SessionStatus = 'idle';
  private _currentTaskId: string | null = null;
  // Use BufferAccumulator for hot-path buffers to reduce GC pressure
  private _terminalBuffer = new BufferAccumulator(MAX_TERMINAL_BUFFER_SIZE, TERMINAL_BUFFER_TRIM_SIZE);
  private _outputBuffer: string = '';
  private _textOutput = new BufferAccumulator(MAX_TEXT_OUTPUT_SIZE, TEXT_OUTPUT_TRIM_SIZE);
  private _errorBuffer: string = '';
  private _lastActivityAt: number;
  private _claudeSessionId: string | null = null;
  private _totalCost: number = 0;
  private _messages: ClaudeMessage[] = [];
  private _lineBuffer: string = '';
  private _lineBufferFlushTimer: NodeJS.Timeout | null = null;
  private resolvePromise: ((value: { result: string; cost: number }) => void) | null = null;
  private rejectPromise: ((reason: Error) => void) | null = null;
  private _promptResolved: boolean = false;  // Guard against race conditions in runPrompt
  private _isWorking: boolean = false;
  private _lastPromptTime: number = 0;
  private activityTimeout: NodeJS.Timeout | null = null;
  private _awaitingIdleConfirmation: boolean = false; // Prevents timeout reset during idle detection
  private _taskTracker: TaskTracker;

  // Token tracking for auto-clear
  private _totalInputTokens: number = 0;
  private _totalOutputTokens: number = 0;
  private _autoClearThreshold: number = 140000; // Default 140k tokens
  private _autoClearEnabled: boolean = false;
  private _isClearing: boolean = false; // Prevent recursive clearing

  // Auto-compact settings
  private _autoCompactThreshold: number = 110000; // Default 110k tokens (lower than clear)
  private _autoCompactEnabled: boolean = false;
  private _autoCompactPrompt: string = ''; // Optional prompt for compact
  private _isCompacting: boolean = false; // Prevent recursive compacting

  // Image watcher setting (per-session toggle)
  private _imageWatcherEnabled: boolean = true;

  // Timer tracking for cleanup (prevents memory leaks)
  private _autoCompactTimer: NodeJS.Timeout | null = null;
  private _autoClearTimer: NodeJS.Timeout | null = null;
  private _promptCheckInterval: NodeJS.Timeout | null = null;
  private _promptCheckTimeout: NodeJS.Timeout | null = null;
  private _shellIdleTimer: NodeJS.Timeout | null = null;

  // Screen session support
  private _screenManager: ScreenManager | null = null;
  private _screenSession: ScreenSession | null = null;
  private _useScreen: boolean = false;
  // Flag to prevent new timers after session is stopped
  private _isStopped: boolean = false;

  // Ralph tracking (Ralph Wiggum loops and todo lists inside Claude Code)
  private _ralphTracker: RalphTracker;

  // Agent tree tracking
  private _parentAgentId: string | null = null;
  private _childAgentIds: string[] = [];

  // Nice prioritying configuration
  private _niceConfig: NiceConfig = { ...DEFAULT_NICE_CONFIG };

  // Store handler references for cleanup (prevents memory leaks)
  private _taskTrackerHandlers: {
    taskCreated: (task: BackgroundTask) => void;
    taskUpdated: (task: BackgroundTask) => void;
    taskCompleted: (task: BackgroundTask) => void;
    taskFailed: (task: BackgroundTask, error: string) => void;
  } | null = null;

  private _ralphHandlers: {
    loopUpdate: (state: RalphTrackerState) => void;
    todoUpdate: (todos: RalphTodoItem[]) => void;
    completionDetected: (phrase: string) => void;
    statusBlockDetected: (block: import('./types.js').RalphStatusBlock) => void;
    circuitBreakerUpdate: (status: import('./types.js').CircuitBreakerStatus) => void;
    exitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  } | null = null;

  // Bash tool tracking (file paths for live log viewing)
  private _bashToolParser: BashToolParser;
  private _bashToolHandlers: {
    toolStart: (tool: ActiveBashTool) => void;
    toolEnd: (tool: ActiveBashTool) => void;
    toolsUpdate: (tools: ActiveBashTool[]) => void;
  } | null = null;

  // Task descriptions parsed from terminal output (e.g., "Explore(Description)")
  // Used to correlate with SubagentWatcher discoveries for better window titles
  private _recentTaskDescriptions: Map<number, string> = new Map(); // timestamp -> description
  private static readonly TASK_DESCRIPTION_MAX_AGE_MS = 30000; // Keep descriptions for 30 seconds

  constructor(config: Partial<SessionConfig> & {
    workingDir: string;
    mode?: SessionMode;
    name?: string;
    screenManager?: ScreenManager;
    useScreen?: boolean;
    screenSession?: ScreenSession;  // For restored sessions - pass the existing screen
    niceConfig?: NiceConfig;  // Nice prioritying configuration
  }) {
    super();
    this.id = config.id || uuidv4();
    this.workingDir = config.workingDir;
    this.createdAt = config.createdAt || Date.now();
    this.mode = config.mode || 'claude';
    this._name = config.name || '';
    this._lastActivityAt = this.createdAt;
    this._screenManager = config.screenManager || null;
    this._useScreen = config.useScreen ?? (this._screenManager !== null && ScreenManager.isScreenAvailable());
    this._screenSession = config.screenSession || null;  // Use existing screen if provided

    // Apply Nice priority configuration if provided
    if (config.niceConfig) {
      this._niceConfig = { ...config.niceConfig };
    }

    // Initialize task tracker and forward events (store handlers for cleanup)
    this._taskTracker = new TaskTracker();
    this._taskTrackerHandlers = {
      taskCreated: (task) => this.emit('taskCreated', task),
      taskUpdated: (task) => this.emit('taskUpdated', task),
      taskCompleted: (task) => this.emit('taskCompleted', task),
      taskFailed: (task, error) => this.emit('taskFailed', task, error),
    };
    this._taskTracker.on('taskCreated', this._taskTrackerHandlers.taskCreated);
    this._taskTracker.on('taskUpdated', this._taskTrackerHandlers.taskUpdated);
    this._taskTracker.on('taskCompleted', this._taskTrackerHandlers.taskCompleted);
    this._taskTracker.on('taskFailed', this._taskTrackerHandlers.taskFailed);

    // Initialize Ralph tracker and forward events (store handlers for cleanup)
    this._ralphTracker = new RalphTracker();
    this._ralphHandlers = {
      loopUpdate: (state) => this.emit('ralphLoopUpdate', state),
      todoUpdate: (todos) => this.emit('ralphTodoUpdate', todos),
      completionDetected: (phrase) => this.emit('ralphCompletionDetected', phrase),
      statusBlockDetected: (block) => this.emit('ralphStatusBlockDetected', block),
      circuitBreakerUpdate: (status) => this.emit('ralphCircuitBreakerUpdate', status),
      exitGateMet: (data) => this.emit('ralphExitGateMet', data),
    };
    this._ralphTracker.on('loopUpdate', this._ralphHandlers.loopUpdate);
    this._ralphTracker.on('todoUpdate', this._ralphHandlers.todoUpdate);
    this._ralphTracker.on('completionDetected', this._ralphHandlers.completionDetected);
    this._ralphTracker.on('statusBlockDetected', this._ralphHandlers.statusBlockDetected);
    this._ralphTracker.on('circuitBreakerUpdate', this._ralphHandlers.circuitBreakerUpdate);
    this._ralphTracker.on('exitGateMet', this._ralphHandlers.exitGateMet);

    // Initialize Bash tool parser and forward events (store handlers for cleanup)
    this._bashToolParser = new BashToolParser({ sessionId: this.id, workingDir: this.workingDir });
    this._bashToolHandlers = {
      toolStart: (tool) => this.emit('bashToolStart', tool),
      toolEnd: (tool) => this.emit('bashToolEnd', tool),
      toolsUpdate: (tools) => this.emit('bashToolsUpdate', tools),
    };
    this._bashToolParser.on('toolStart', this._bashToolHandlers.toolStart);
    this._bashToolParser.on('toolEnd', this._bashToolHandlers.toolEnd);
    this._bashToolParser.on('toolsUpdate', this._bashToolHandlers.toolsUpdate);

  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentTaskId(): string | null {
    return this._currentTaskId;
  }

  get pid(): number | null {
    return this._pid;
  }

  get terminalBuffer(): string {
    return this._terminalBuffer.value;
  }

  get outputBuffer(): string {
    return this._outputBuffer;
  }

  get textOutput(): string {
    return this._textOutput.value;
  }

  get errorBuffer(): string {
    return this._errorBuffer;
  }

  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  get claudeSessionId(): string | null {
    return this._claudeSessionId;
  }

  get totalCost(): number {
    return this._totalCost;
  }

  get messages(): ClaudeMessage[] {
    return this._messages;
  }

  get isWorking(): boolean {
    return this._isWorking;
  }

  get lastPromptTime(): number {
    return this._lastPromptTime;
  }

  get taskTracker(): TaskTracker {
    return this._taskTracker;
  }

  get runningTaskCount(): number {
    return this._taskTracker.getRunningCount();
  }

  get taskTree(): BackgroundTask[] {
    return this._taskTracker.getTaskTree();
  }

  get taskStats(): { total: number; running: number; completed: number; failed: number } {
    return this._taskTracker.getStats();
  }

  // Ralph tracking getters
  get ralphTracker(): RalphTracker {
    return this._ralphTracker;
  }

  get ralphLoopState(): RalphTrackerState {
    return this._ralphTracker.loopState;
  }

  get ralphTodos(): RalphTodoItem[] {
    return this._ralphTracker.todos;
  }

  get ralphTodoStats(): { total: number; pending: number; inProgress: number; completed: number } {
    return this._ralphTracker.getTodoStats();
  }

  // Bash tool tracking getters
  get bashToolParser(): BashToolParser {
    return this._bashToolParser;
  }

  get activeTools(): ActiveBashTool[] {
    return this._bashToolParser.activeTools;
  }

  get parentAgentId(): string | null {
    return this._parentAgentId;
  }

  set parentAgentId(value: string | null) {
    this._parentAgentId = value;
  }

  get childAgentIds(): string[] {
    return [...this._childAgentIds];
  }

  addChildAgentId(agentId: string): void {
    if (!this._childAgentIds.includes(agentId)) {
      this._childAgentIds.push(agentId);
    }
  }

  removeChildAgentId(agentId: string): void {
    const idx = this._childAgentIds.indexOf(agentId);
    if (idx >= 0) this._childAgentIds.splice(idx, 1);
  }

  // Nice priority config getters and setters
  get niceConfig(): NiceConfig {
    return { ...this._niceConfig };
  }

  /**
   * Set CPU priority configuration.
   * Note: This only affects new sessions; existing running processes won't be changed.
   */
  setNice(config: Partial<NiceConfig>): void {
    if (config.enabled !== undefined) {
      this._niceConfig.enabled = config.enabled;
    }
    if (config.niceValue !== undefined) {
      // Clamp to valid range
      this._niceConfig.niceValue = Math.max(-20, Math.min(19, config.niceValue));
    }
  }

  // Token tracking getters and setters
  get totalTokens(): number {
    return this._totalInputTokens + this._totalOutputTokens;
  }

  get inputTokens(): number {
    return this._totalInputTokens;
  }

  get outputTokens(): number {
    return this._totalOutputTokens;
  }

  /**
   * Restore token and cost values from saved state.
   * Called when recovering sessions after server restart.
   */
  restoreTokens(inputTokens: number, outputTokens: number, totalCost: number): void {
    // Sanity check: reject absurdly large values
    if (inputTokens > MAX_SESSION_TOKENS || outputTokens > MAX_SESSION_TOKENS) {
      console.warn(`[Session ${this.id}] Rejected absurd restored tokens: input=${inputTokens}, output=${outputTokens}`);
      return;
    }
    // Reject negative values
    if (inputTokens < 0 || outputTokens < 0 || totalCost < 0) {
      console.warn(`[Session ${this.id}] Rejected negative restored tokens: input=${inputTokens}, output=${outputTokens}, cost=${totalCost}`);
      return;
    }

    this._totalInputTokens = inputTokens;
    this._totalOutputTokens = outputTokens;
    this._totalCost = totalCost;
  }

  get autoClearThreshold(): number {
    return this._autoClearThreshold;
  }

  get autoClearEnabled(): boolean {
    return this._autoClearEnabled;
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  setAutoClear(enabled: boolean, threshold?: number): void {
    this._autoClearEnabled = enabled;
    if (threshold !== undefined) {
      this._autoClearThreshold = threshold;
    }
  }

  get autoCompactThreshold(): number {
    return this._autoCompactThreshold;
  }

  get autoCompactEnabled(): boolean {
    return this._autoCompactEnabled;
  }

  get autoCompactPrompt(): string {
    return this._autoCompactPrompt;
  }

  setAutoCompact(enabled: boolean, threshold?: number, prompt?: string): void {
    this._autoCompactEnabled = enabled;
    if (threshold !== undefined) {
      this._autoCompactThreshold = threshold;
    }
    if (prompt !== undefined) {
      this._autoCompactPrompt = prompt;
    }
  }

  get imageWatcherEnabled(): boolean {
    return this._imageWatcherEnabled;
  }

  set imageWatcherEnabled(enabled: boolean) {
    this._imageWatcherEnabled = enabled;
  }

  isIdle(): boolean {
    return this._status === 'idle';
  }

  isBusy(): boolean {
    return this._status === 'busy';
  }

  isRunning(): boolean {
    return this._status === 'idle' || this._status === 'busy';
  }

  toState(): SessionState {
    return {
      id: this.id,
      pid: this.pid,
      status: this._status,
      workingDir: this.workingDir,
      currentTaskId: this._currentTaskId,
      createdAt: this.createdAt,
      lastActivityAt: this._lastActivityAt,
      name: this._name,
      mode: this.mode,
      autoClearEnabled: this._autoClearEnabled,
      autoClearThreshold: this._autoClearThreshold,
      autoCompactEnabled: this._autoCompactEnabled,
      autoCompactThreshold: this._autoCompactThreshold,
      autoCompactPrompt: this._autoCompactPrompt,
      imageWatcherEnabled: this._imageWatcherEnabled,
      totalCost: this._totalCost,
      inputTokens: this._totalInputTokens,
      outputTokens: this._totalOutputTokens,
      ralphEnabled: this._ralphTracker.enabled,
      ralphCompletionPhrase: this._ralphTracker.loopState.completionPhrase || undefined,
      parentAgentId: this._parentAgentId || undefined,
      childAgentIds: this._childAgentIds.length > 0 ? this._childAgentIds : undefined,
      niceEnabled: this._niceConfig.enabled,
      niceValue: this._niceConfig.niceValue,
    };
  }

  toDetailedState() {
    return {
      ...this.toState(),
      name: this._name,
      mode: this.mode,
      claudeSessionId: this._claudeSessionId,
      totalCost: this._totalCost,
      textOutput: this._textOutput.value,
      terminalBuffer: this._terminalBuffer.value,
      messageCount: this._messages.length,
      isWorking: this._isWorking,
      lastPromptTime: this._lastPromptTime,
      // Buffer statistics for monitoring long-running sessions
      bufferStats: {
        terminalBufferSize: this._terminalBuffer.length,
        textOutputSize: this._textOutput.length,
        messageCount: this._messages.length,
        maxTerminalBuffer: MAX_TERMINAL_BUFFER_SIZE,
        maxTextOutput: MAX_TEXT_OUTPUT_SIZE,
        maxMessages: MAX_MESSAGES,
      },
      // Background task tracking
      taskStats: this._taskTracker.getStats(),
      taskTree: this._taskTracker.getTaskTree(),
      // Token tracking
      tokens: {
        input: this._totalInputTokens,
        output: this._totalOutputTokens,
        total: this._totalInputTokens + this._totalOutputTokens,
      },
      autoClear: {
        enabled: this._autoClearEnabled,
        threshold: this._autoClearThreshold,
      },
      // CPU priority configuration
      nice: {
        enabled: this._niceConfig.enabled,
        niceValue: this._niceConfig.niceValue,
      },
      // Ralph tracking state
      ralphLoop: this._ralphTracker.loopState,
      ralphTodos: this._ralphTracker.todos,
      ralphTodoStats: this._ralphTracker.getTodoStats(),
    };
  }

  /**
   * Starts an interactive Claude CLI session with full terminal support.
   *
   * This spawns Claude CLI with `--dangerously-skip-permissions` flag in
   * interactive mode. If screen wrapping is enabled, the session runs inside
   * a GNU Screen session for persistence across disconnects.
   *
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project', useScreen: true });
   * await session.startInteractive();
   * session.on('terminal', (data) => process.stdout.write(data));
   * session.write('help me with this code\r');
   * ```
   */
  async startInteractive(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._status = 'busy';
    this._terminalBuffer.clear();
    this._outputBuffer = '';
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._lastActivityAt = Date.now();

    console.log('[Session] Starting interactive Claude session' + (this._useScreen ? ' (with screen)' : ''));

    // If screen wrapping is enabled, create or attach to a screen session
    if (this._useScreen && this._screenManager) {
      try {
        // Check if we already have a screen session (restored session)
        const isRestoredSession = this._screenSession !== null;
        if (isRestoredSession) {
          console.log('[Session] Attaching to existing screen session:', this._screenSession!.screenName);
        } else {
          // Create a new screen session
          this._screenSession = await this._screenManager.createScreen(this.id, this.workingDir, 'claude', this._name, this._niceConfig);
          console.log('[Session] Created screen session:', this._screenSession.screenName);

          // Wait a moment for screen to fully start
          await new Promise(resolve => setTimeout(resolve, SCREEN_STARTUP_DELAY_MS));
        }

        // Attach to the screen session via PTY
        try {
          this.ptyProcess = pty.spawn('screen', [
            '-x', this._screenSession!.screenName
          ], {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: this.workingDir,
            env: { ...process.env, TERM: 'xterm-256color' },
          });

          // Set claudeSessionId immediately since we passed --session-id to Claude
          // The screen-manager passes --session-id ${sessionId} to Claude
          this._claudeSessionId = this.id;
        } catch (spawnErr) {
          console.error('[Session] Failed to spawn PTY for screen attachment:', spawnErr);
          this.emit('error', `Failed to attach to screen: ${spawnErr}`);
          throw spawnErr;
        }

        // For NEW screens: wait for prompt to appear then clean buffer
        // For RESTORED screens: don't do anything - client will fetch buffer on tab switch
        if (!isRestoredSession) {
          this._promptCheckInterval = setInterval(() => {
            // Wait for the prompt character (❯) which means Claude is fully initialized
            const bufferValue = this._terminalBuffer.value;
            if (bufferValue.includes('❯') || bufferValue.includes('\u276f')) {
              if (this._promptCheckInterval) {
                clearInterval(this._promptCheckInterval);
                this._promptCheckInterval = null;
              }
              if (this._promptCheckTimeout) {
                clearTimeout(this._promptCheckTimeout);
                this._promptCheckTimeout = null;
              }
              // Clean the buffer - remove screen init junk before actual content
              // Strip: cursor movement (\x1b[nA/B/C/D), positioning (\x1b[n;nH),
              // clear screen (\x1b[2J), scroll region (\x1b[n;nr), and whitespace
              this._terminalBuffer.set(
                bufferValue.replace(/^(\x1b\[\??[\d;]*[A-Za-z]|[\s\r\n])+/, '')
              );
              // Signal client to refresh
              this.emit('clearTerminal');
            }
          }, 50);
          // Timeout after 5 seconds if prompt not found
          this._promptCheckTimeout = setTimeout(() => {
            if (this._promptCheckInterval) {
              clearInterval(this._promptCheckInterval);
              this._promptCheckInterval = null;
            }
            this._promptCheckTimeout = null;
          }, 5000);
        }
      } catch (err) {
        console.error('[Session] Failed to create screen session, falling back to direct PTY:', err);
        this._useScreen = false;
        this._screenSession = null;
      }
    }

    // Fallback to direct PTY if screen is not used
    if (!this.ptyProcess) {
      try {
        // Pass --session-id to use the SAME ID as the Claudeman session
        // This ensures subagents can be directly matched to the correct tab
        this.ptyProcess = pty.spawn('claude', [
          '--dangerously-skip-permissions',
          '--session-id', this.id
        ], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: {
            ...process.env,
            PATH: getAugmentedPath(),
            TERM: 'xterm-256color',
            // Inform Claude it's running within Claudeman (helps prevent self-termination)
            CLAUDEMAN_SCREEN: '1',
            CLAUDEMAN_SESSION_ID: this.id,
            CLAUDEMAN_API_URL: process.env.CLAUDEMAN_API_URL || 'http://localhost:3000',
          },
        });
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn Claude PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start Claude: ${spawnErr}`);
        throw new Error(`Failed to spawn Claude process: ${spawnErr}`);
      }
    }

    // Set the claudeSessionId immediately since we passed --session-id
    // This ensures subagent matching works without waiting for JSON messages
    this._claudeSessionId = this.id;

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Interactive PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences and Ctrl+L (form feed)
      const data = rawData
        .replace(FOCUS_ESCAPE_FILTER, '')
        .replace(/\x0c/g, '');  // Remove Ctrl+L
      if (!data) return; // Skip if only filtered sequences

      // BufferAccumulator handles auto-trimming when max size exceeded
      this._terminalBuffer.append(data);
      this._lastActivityAt = Date.now();

      this.emit('terminal', data);
      this.emit('output', data);

      // Forward to Ralph tracker to detect Ralph loops and todos
      this._ralphTracker.processTerminalData(data);

      // Forward to Bash tool parser to detect file-viewing commands
      this._bashToolParser.processTerminalData(data);

      // Parse token count from status line (e.g., "123.4k tokens" or "5234 tokens")
      this.parseTokensFromStatusLine(data);

      // Parse task descriptions from terminal output (e.g., "Explore(Check files)")
      // This enables correlating subagent windows with their short descriptions
      this.parseTaskDescriptionsFromTerminalData(data);

      // Detect if Claude is working or at prompt
      // The prompt line contains "❯" when waiting for input
      if (data.includes('❯') || data.includes('\u276f')) {
        // Only start a new timeout if we're not already awaiting idle confirmation
        // This prevents status bar redraws (which include ❯) from resetting the timer
        if (!this._awaitingIdleConfirmation) {
          if (this.activityTimeout) clearTimeout(this.activityTimeout);
          this._awaitingIdleConfirmation = true;
          this.activityTimeout = setTimeout(() => {
            this._awaitingIdleConfirmation = false;
            // Emit idle if either:
            // 1. Claude was working and is now at prompt (normal case)
            // 2. Session just started and is ready (status is 'busy' but _isWorking is false)
            const wasWorking = this._isWorking;
            const isInitialReady = this._status === 'busy' && !this._isWorking;
            if (wasWorking || isInitialReady) {
              this._isWorking = false;
              this._status = 'idle';
              this._lastPromptTime = Date.now();
              this.emit('idle');
            }
          }, IDLE_DETECTION_DELAY_MS);
        }
      }

      // Detect when Claude starts working (thinking, writing, etc)
      // Strip ANSI/OSC sequences to avoid false positives from window titles like "3 File Reading Task"
      const cleanDataForWorkingCheck = data.replace(ANSI_ESCAPE_PATTERN_FULL, '');
      if (cleanDataForWorkingCheck.includes('Thinking') || cleanDataForWorkingCheck.includes('Writing') ||
          cleanDataForWorkingCheck.includes('Reading') || cleanDataForWorkingCheck.includes('Running') ||
          cleanDataForWorkingCheck.includes('⠋') || cleanDataForWorkingCheck.includes('⠙') ||
          cleanDataForWorkingCheck.includes('⠹') || cleanDataForWorkingCheck.includes('⠸') ||
          cleanDataForWorkingCheck.includes('⠼') || cleanDataForWorkingCheck.includes('⠴') ||
          cleanDataForWorkingCheck.includes('⠦') || cleanDataForWorkingCheck.includes('⠧')) {
        if (!this._isWorking) {
          this._isWorking = true;
          this._status = 'busy';
          this.emit('working');
        }
        // Reset timeout and idle confirmation flag since Claude is active
        this._awaitingIdleConfirmation = false;
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
      }
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Interactive PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      this._awaitingIdleConfirmation = false;
      // Clear all timers to prevent memory leaks
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      if (this._promptCheckInterval) {
        clearInterval(this._promptCheckInterval);
        this._promptCheckInterval = null;
      }
      if (this._promptCheckTimeout) {
        clearTimeout(this._promptCheckTimeout);
        this._promptCheckTimeout = null;
      }
      // If using screen, mark the screen as detached but don't kill it
      if (this._screenSession && this._screenManager) {
        this._screenManager.setAttached(this.id, false);
      }
      this.emit('exit', exitCode);
    });
  }

  /**
   * Starts a plain shell session (bash/zsh) without Claude CLI.
   *
   * Useful for debugging, testing, or when you just need a terminal.
   * Uses the user's default shell from $SHELL or falls back to /bin/bash.
   *
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project', mode: 'shell' });
   * await session.startShell();
   * session.write('ls -la\r');
   * ```
   */
  async startShell(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._status = 'busy';
    this._terminalBuffer.clear();
    this._outputBuffer = '';
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._lastActivityAt = Date.now();

    // Use user's default shell or bash
    const shell = process.env.SHELL || '/bin/bash';
    console.log('[Session] Starting shell session with:', shell + (this._useScreen ? ' (with screen)' : ''));

    // If screen wrapping is enabled, create or attach to a screen session
    if (this._useScreen && this._screenManager) {
      try {
        // Check if we already have a screen session (restored session)
        const isRestoredSession = this._screenSession !== null;
        if (isRestoredSession) {
          console.log('[Session] Attaching to existing screen session:', this._screenSession!.screenName);
        } else {
          // Create a new screen session
          this._screenSession = await this._screenManager.createScreen(this.id, this.workingDir, 'shell', this._name, this._niceConfig);
          console.log('[Session] Created screen session:', this._screenSession.screenName);

          // Wait a moment for screen to fully start
          await new Promise(resolve => setTimeout(resolve, SCREEN_STARTUP_DELAY_MS));
        }

        // Attach to the screen session via PTY
        try {
          this.ptyProcess = pty.spawn('screen', [
            '-x', this._screenSession!.screenName
          ], {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: this.workingDir,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
        } catch (spawnErr) {
          console.error('[Session] Failed to spawn PTY for shell screen attachment:', spawnErr);
          this.emit('error', `Failed to attach to screen: ${spawnErr}`);
          throw spawnErr;
        }

        // For NEW screens: clear by sending 'clear' command to the shell
        // For RESTORED screens: don't clear - we want to see the existing output
        if (!isRestoredSession) {
          setTimeout(() => {
            if (this.ptyProcess) {
              this._terminalBuffer.clear();
              this.ptyProcess.write('clear\n');
            }
          }, 100);
        }
      } catch (err) {
        console.error('[Session] Failed to create screen session, falling back to direct PTY:', err);
        this._useScreen = false;
        this._screenSession = null;
      }
    }

    // Fallback to direct PTY if screen is not used
    if (!this.ptyProcess) {
      try {
        this.ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            CLAUDEMAN_SCREEN: '1',
            CLAUDEMAN_SESSION_ID: this.id,
            CLAUDEMAN_API_URL: process.env.CLAUDEMAN_API_URL || 'http://localhost:3000',
          },
        });
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn shell PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start shell: ${spawnErr}`);
        throw new Error(`Failed to spawn shell process: ${spawnErr}`);
      }
    }

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Shell PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
      if (!data) return; // Skip if only focus sequences

      // BufferAccumulator handles auto-trimming when max size exceeded
      this._terminalBuffer.append(data);
      this._lastActivityAt = Date.now();

      this.emit('terminal', data);
      this.emit('output', data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Shell PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      // Clear timers to prevent memory leaks
      if (this._shellIdleTimer) {
        clearTimeout(this._shellIdleTimer);
        this._shellIdleTimer = null;
      }
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      // If using screen, mark the screen as detached but don't kill it
      if (this._screenSession && this._screenManager) {
        this._screenManager.setAttached(this.id, false);
      }
      this.emit('exit', exitCode);
    });

    // Mark as idle after a short delay (shell is ready)
    this._shellIdleTimer = setTimeout(() => {
      this._shellIdleTimer = null;
      this._status = 'idle';
      this._isWorking = false;
      this.emit('idle');
    }, 500);
  }

  /**
   * Runs a one-shot prompt and returns the result.
   *
   * This spawns Claude CLI with `--output-format stream-json` to get
   * structured JSON output. The promise resolves when Claude completes
   * the response.
   *
   * @param prompt - The prompt text to send to Claude
   * @param options - Optional configuration
   * @param options.model - Model to use ('opus', 'sonnet', or full model name). Defaults to default model.
   * @param options.onProgress - Callback for progress updates (token count, status)
   * @returns Promise resolving to the result text and total cost in USD
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project' });
   * const { result, cost } = await session.runPrompt('Explain this code', { model: 'opus' });
   * console.log(`Response: ${result}`);
   * console.log(`Cost: $${cost.toFixed(4)}`);
   * ```
   */
  async runPrompt(
    prompt: string,
    options?: { model?: string; onProgress?: (info: { tokens?: number; status?: string }) => void }
  ): Promise<{ result: string; cost: number }> {
    return new Promise((resolve, reject) => {
      if (this.ptyProcess) {
        reject(new Error('Session already has a running process'));
        return;
      }

      this._status = 'busy';
      this._terminalBuffer.clear();
      this._outputBuffer = '';
      this._textOutput.clear();
      this._errorBuffer = '';
      this._messages = [];
      this._lineBuffer = '';
      this._lastActivityAt = Date.now();
      this._promptResolved = false;  // Reset race condition guard

      this.resolvePromise = resolve;
      this.rejectPromise = reject;

      try {
        // Spawn claude in a real PTY
        const model = options?.model;
        console.log('[Session] Spawning PTY for claude with prompt:', prompt.substring(0, 50), model ? `(model: ${model})` : '');

        const args = [
          '-p',
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
        ];
        if (model) {
          args.push('--model', model);
        }
        args.push(prompt);

        try {
          this.ptyProcess = pty.spawn('claude', args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: this.workingDir,
            env: {
              ...process.env,
              PATH: getAugmentedPath(),
              TERM: 'xterm-256color',
              // Inform Claude it's running within Claudeman
              CLAUDEMAN_SCREEN: '1',
              CLAUDEMAN_SESSION_ID: this.id,
              CLAUDEMAN_API_URL: process.env.CLAUDEMAN_API_URL || 'http://localhost:3000',
            },
          });
        } catch (spawnErr) {
          console.error('[Session] Failed to spawn Claude PTY for runPrompt:', spawnErr);
          this.emit('error', `Failed to spawn Claude: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`);
          throw spawnErr;
        }

        this._pid = this.ptyProcess.pid;
        console.log('[Session] PTY spawned with PID:', this._pid);

        // Handle terminal data
        this.ptyProcess.onData((rawData: string) => {
          // Filter out focus escape sequences
          const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
          if (!data) return; // Skip if only focus sequences

          // BufferAccumulator handles auto-trimming when max size exceeded
          this._terminalBuffer.append(data);
          this._lastActivityAt = Date.now();

          this.emit('terminal', data);
          this.emit('output', data);

          // Also try to parse JSON lines for structured data
          this.processOutput(data);
        });

        // Handle exit
        this.ptyProcess.onExit(({ exitCode }) => {
          console.log('[Session] PTY exited with code:', exitCode);
          this.ptyProcess = null;
          this._pid = null;

          // Guard against race conditions: only process once per runPrompt call
          if (this._promptResolved) {
            this.emit('exit', exitCode);
            return;
          }
          this._promptResolved = true;

          // Capture callbacks atomically before processing
          const resolve = this.resolvePromise;
          const reject = this.rejectPromise;
          this.resolvePromise = null;
          this.rejectPromise = null;

          // Find result from parsed messages or use text output
          const resultMsg = this._messages.find(m => m.type === 'result');

          if (resultMsg && !resultMsg.is_error) {
            this._status = 'idle';
            const cost = resultMsg.total_cost_usd || 0;
            this._totalCost += cost;
            this.emit('completion', resultMsg.result || '', cost);
            if (resolve) {
              resolve({ result: resultMsg.result || '', cost });
            }
          } else if (exitCode !== 0 || (resultMsg && resultMsg.is_error)) {
            this._status = 'error';
            if (reject) {
              reject(new Error(this._errorBuffer || this._textOutput.value || 'Process exited with error'));
            }
          } else {
            this._status = 'idle';
            if (resolve) {
              resolve({ result: this._textOutput.value || this._terminalBuffer.value, cost: this._totalCost });
            }
          }

          this.emit('exit', exitCode);
        });

      } catch (err) {
        this._status = 'error';
        reject(err);
      }
    });
  }

  private processOutput(data: string): void {
    // Early return if session is stopped to prevent any processing or timer creation
    if (this._isStopped) return;

    // Try to extract JSON from output (Claude may output JSON in stream mode)
    this._lineBuffer += data;

    // Prevent unbounded line buffer growth for very long lines
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      // Force flush the oversized buffer as text output
      this._textOutput.append(this._lineBuffer + '\n');
      this._lineBuffer = '';
    }

    // Start flush timer if not running (handles partial lines after 100ms)
    if (!this._lineBufferFlushTimer && this._lineBuffer.length > 0 && !this._isStopped) {
      this._lineBufferFlushTimer = setTimeout(() => {
        this._lineBufferFlushTimer = null;
        if (this._lineBuffer.length > 0 && !this._isStopped) {
          // Flush partial line as text output
          this._textOutput.append(this._lineBuffer);
          this._lineBuffer = '';
        }
      }, LINE_BUFFER_FLUSH_INTERVAL);
    }

    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || '';

    // Clear flush timer if buffer is now empty
    if (this._lineBuffer.length === 0 && this._lineBufferFlushTimer) {
      clearTimeout(this._lineBufferFlushTimer);
      this._lineBufferFlushTimer = null;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      // Remove ANSI escape codes for JSON parsing (use pre-compiled pattern)
      const cleanLine = trimmed.replace(ANSI_ESCAPE_PATTERN_FULL, '');

      if (cleanLine.startsWith('{') && cleanLine.endsWith('}')) {
        try {
          const msg = JSON.parse(cleanLine) as ClaudeMessage;
          this._messages.push(msg);
          this.emit('message', msg);

          // Trim messages array for long-running sessions
          if (this._messages.length > MAX_MESSAGES) {
            this._messages = this._messages.slice(-Math.floor(MAX_MESSAGES * 0.8));
          }

          // Extract Claude session ID from messages (can be in any message type)
          // Support both sessionId (camelCase) and session_id (snake_case)
          const msgSessionId = (msg as unknown as Record<string, unknown>).sessionId as string | undefined
            ?? msg.session_id;
          if (msgSessionId && !this._claudeSessionId) {
            this._claudeSessionId = msgSessionId;
          }

          // Process message for task tracking
          this._taskTracker.processMessage(msg);

          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                this._textOutput.append(block.text);
              }
            }
            // Track tokens from usage (with validation)
            if (msg.message.usage) {
              const inputDelta = msg.message.usage.input_tokens || 0;
              const outputDelta = msg.message.usage.output_tokens || 0;

              // Sanity check: max 100k tokens per message (generous limit)
              const MAX_TOKENS_PER_MESSAGE = 100_000;
              if (inputDelta > 0 && inputDelta <= MAX_TOKENS_PER_MESSAGE) {
                this._totalInputTokens += inputDelta;
              }
              if (outputDelta > 0 && outputDelta <= MAX_TOKENS_PER_MESSAGE) {
                this._totalOutputTokens += outputDelta;
              }

              // Check if we should auto-compact or auto-clear
              this.checkAutoCompact();
              this.checkAutoClear();
            }
          }

          if (msg.type === 'result' && msg.total_cost_usd) {
            this._totalCost = msg.total_cost_usd;
          }
        } catch {
          // Not JSON, just regular output
          this._textOutput.append(line + '\n');
        }
      } else if (trimmed) {
        this._textOutput.append(line + '\n');
      }

      // Parse task descriptions from terminal output (e.g., "Explore(Description)")
      // This captures the short description from Claude Code's Task tool output
      this.parseTaskDescriptionsFromLine(cleanLine);
    }
    // Note: BufferAccumulator auto-trims when max size exceeded
  }

  /**
   * Parse task descriptions from raw terminal data (may contain multiple lines).
   * Called from interactive mode's onData handler.
   */
  private parseTaskDescriptionsFromTerminalData(data: string): void {
    // Quick pre-check: skip if no parentheses present
    if (!data.includes('(') || !data.includes(')')) return;

    // Split by newlines and process each line
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
      this.parseTaskDescriptionsFromLine(line);
    }
  }

  /**
   * Parse task descriptions from terminal output.
   * Claude Code outputs Task tool calls as "ToolName(Description)" in the terminal.
   * We capture these descriptions to use as window titles for subagents.
   */
  private parseTaskDescriptionsFromLine(line: string): void {
    // Quick pre-check: skip expensive regex if no common tool patterns present
    if (!line.includes('(') || !line.includes(')')) return;

    // Strip ANSI codes before matching - terminal output has embedded codes like [1mExplore[0m
    const cleanLine = line.replace(ANSI_ESCAPE_PATTERN_FULL, '');

    // Reset regex lastIndex for global pattern
    TASK_TOOL_PATTERN.lastIndex = 0;

    let match;
    while ((match = TASK_TOOL_PATTERN.exec(cleanLine)) !== null) {
      const description = match[2].trim();
      if (description && description.length > 0) {
        const now = Date.now();
        this._recentTaskDescriptions.set(now, description);

        // Cleanup old entries
        this.cleanupOldTaskDescriptions();
      }
    }
  }

  /** Maximum number of task descriptions to keep */
  private static readonly MAX_TASK_DESCRIPTIONS = 100;

  /**
   * Remove task descriptions older than TASK_DESCRIPTION_MAX_AGE_MS.
   * Also enforces MAX_TASK_DESCRIPTIONS size limit.
   */
  private cleanupOldTaskDescriptions(): void {
    const cutoff = Date.now() - Session.TASK_DESCRIPTION_MAX_AGE_MS;
    // Collect keys to delete first, then delete (avoids modifying Map during iteration)
    const keysToDelete: number[] = [];
    for (const [timestamp] of this._recentTaskDescriptions) {
      if (timestamp < cutoff) {
        keysToDelete.push(timestamp);
      }
    }
    for (const key of keysToDelete) {
      this._recentTaskDescriptions.delete(key);
    }

    // Enforce size limit by removing oldest entries
    if (this._recentTaskDescriptions.size > Session.MAX_TASK_DESCRIPTIONS) {
      const sortedKeys = Array.from(this._recentTaskDescriptions.keys()).sort((a, b) => a - b);
      const keysToRemove = sortedKeys.slice(0, this._recentTaskDescriptions.size - Session.MAX_TASK_DESCRIPTIONS);
      for (const key of keysToRemove) {
        this._recentTaskDescriptions.delete(key);
      }
    }
  }

  /**
   * Get recent task descriptions parsed from terminal output.
   * Returns descriptions sorted by timestamp (most recent first).
   */
  getRecentTaskDescriptions(): Array<{ timestamp: number; description: string }> {
    this.cleanupOldTaskDescriptions();
    const results: Array<{ timestamp: number; description: string }> = [];
    for (const [timestamp, description] of this._recentTaskDescriptions) {
      results.push({ timestamp, description });
    }
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Find a task description that was parsed close to a given timestamp.
   * Used to correlate with SubagentWatcher discoveries.
   *
   * @param subagentStartTime - The timestamp when the subagent was discovered
   * @param maxAgeMs - Maximum age difference to consider (default 10 seconds)
   * @returns The matching description or undefined
   */
  findTaskDescriptionNear(subagentStartTime: number, maxAgeMs: number = 10000): string | undefined {
    this.cleanupOldTaskDescriptions();

    // Find the most recent description that was parsed before or around the subagent start time
    let bestMatch: { timestamp: number; description: string } | undefined;
    let bestDiff = Infinity;

    for (const [timestamp, description] of this._recentTaskDescriptions) {
      const diff = Math.abs(subagentStartTime - timestamp);
      if (diff < maxAgeMs && diff < bestDiff) {
        bestMatch = { timestamp, description };
        bestDiff = diff;
      }
    }

    return bestMatch?.description;
  }

  // Parse token count from Claude's status line in interactive mode
  // Matches patterns like "123.4k tokens", "5234 tokens", "1.2M tokens"
  //
  // SAFETY LIMITS:
  // - Max tokens per session: 500k (Claude's context is ~200k)
  // - Max delta per update: 100k (prevents sudden jumps from parsing errors)
  // - Rejects "M" suffix values > 0.5 (500k) to prevent false matches
  private parseTokensFromStatusLine(data: string): void {
    // Quick pre-check: skip expensive regex if "token" not present (performance optimization)
    if (!data.includes('token')) return;

    // Remove ANSI escape codes for cleaner parsing (use pre-compiled pattern)
    const cleanData = data.replace(ANSI_ESCAPE_PATTERN_FULL, '');

    // Match patterns: "123.4k tokens", "5234 tokens", "1.2M tokens"
    // The status line typically shows total tokens like "1.2k tokens" near the prompt
    const tokenMatch = cleanData.match(TOKEN_PATTERN);

    if (tokenMatch) {
      let tokenCount = parseFloat(tokenMatch[1]);
      const suffix = tokenMatch[2]?.toLowerCase();

      // Convert k/M suffix to actual number
      if (suffix === 'k') {
        tokenCount *= 1000;
      } else if (suffix === 'm') {
        // Safety: Reject M values that would result in > 500k tokens
        // Claude's context window is ~200k, so anything claiming millions is likely a false match
        if (tokenCount > 0.5) {
          console.warn(`[Session ${this.id}] Rejected suspicious M token value: ${tokenMatch[0]} (would be ${tokenCount * 1000000} tokens)`);
          return;
        }
        tokenCount *= 1000000;
      }

      // Safety: Absolute maximum tokens per session
      if (tokenCount > MAX_SESSION_TOKENS) {
        console.warn(`[Session ${this.id}] Rejected token count exceeding max: ${tokenCount} > ${MAX_SESSION_TOKENS}`);
        return;
      }

      // Only update if the new count is higher (tokens only increase within a session)
      // We use total tokens as an estimate - Claude shows combined input+output
      const currentTotal = this._totalInputTokens + this._totalOutputTokens;
      if (tokenCount > currentTotal) {
        const delta = tokenCount - currentTotal;

        // Safety: Reject suspiciously large jumps (max 100k per update)
        const MAX_DELTA_PER_UPDATE = 100_000;
        if (delta > MAX_DELTA_PER_UPDATE) {
          console.warn(`[Session ${this.id}] Rejected suspicious token jump: ${currentTotal} -> ${tokenCount} (delta: ${delta})`);
          return;
        }

        // Estimate: split roughly 60% input, 40% output (common ratio)
        // This is an approximation since interactive mode doesn't give us the breakdown
        this._totalInputTokens += Math.round(delta * 0.6);
        this._totalOutputTokens += Math.round(delta * 0.4);

        // Check if we should auto-compact or auto-clear
        this.checkAutoCompact();
        this.checkAutoClear();
      }
    }
  }

  // Check if we should auto-compact based on token threshold
  private checkAutoCompact(): void {
    if (!this._autoCompactEnabled || this._isCompacting || this._isClearing || this._isStopped) return;

    const totalTokens = this._totalInputTokens + this._totalOutputTokens;
    if (totalTokens >= this._autoCompactThreshold) {
      this._isCompacting = true;
      console.log(`[Session] Auto-compact triggered: ${totalTokens} tokens >= ${this._autoCompactThreshold} threshold`);

      // Wait for Claude to be idle before compacting
      const checkAndCompact = () => {
        // Check if session is still valid (not stopped)
        if (!this._isCompacting || this._isStopped) return;

        if (!this._isWorking) {
          // Send /compact command with optional prompt
          const compactCmd = this._autoCompactPrompt
            ? `/compact ${this._autoCompactPrompt}\r`
            : '/compact\r';
          this.writeViaScreen(compactCmd);
          this.emit('autoCompact', {
            tokens: totalTokens,
            threshold: this._autoCompactThreshold,
            prompt: this._autoCompactPrompt || undefined
          });

          // Wait a moment then re-enable (longer than clear since compact takes time)
          if (!this._isStopped) {
            this._autoCompactTimer = setTimeout(() => {
              this._autoCompactTimer = null;
              this._isCompacting = false;
            }, 10000);
          }
        } else {
          // Check again after delay
          if (!this._isStopped) {
            this._autoCompactTimer = setTimeout(checkAndCompact, AUTO_RETRY_DELAY_MS);
          }
        }
      };

      // Start checking after a short delay
      if (!this._isStopped) {
        this._autoCompactTimer = setTimeout(checkAndCompact, AUTO_INITIAL_DELAY_MS);
      }
    }
  }

  // Check if we should auto-clear based on token threshold
  private checkAutoClear(): void {
    if (!this._autoClearEnabled || this._isClearing || this._isCompacting || this._isStopped) return;

    const totalTokens = this._totalInputTokens + this._totalOutputTokens;
    if (totalTokens >= this._autoClearThreshold) {
      this._isClearing = true;
      console.log(`[Session] Auto-clear triggered: ${totalTokens} tokens >= ${this._autoClearThreshold} threshold`);

      // Wait for Claude to be idle before clearing
      const checkAndClear = () => {
        // Check if session is still valid (not stopped)
        if (!this._isClearing || this._isStopped) return;

        if (!this._isWorking) {
          // Send /clear command
          this.writeViaScreen('/clear\r');
          // Reset token counts
          this._totalInputTokens = 0;
          this._totalOutputTokens = 0;
          this.emit('autoClear', { tokens: totalTokens, threshold: this._autoClearThreshold });

          // Wait a moment then re-enable
          if (!this._isStopped) {
            this._autoClearTimer = setTimeout(() => {
              this._autoClearTimer = null;
              this._isClearing = false;
            }, 5000);
          }
        } else {
          // Check again after delay
          if (!this._isStopped) {
            this._autoClearTimer = setTimeout(checkAndClear, AUTO_RETRY_DELAY_MS);
          }
        }
      };

      // Start checking after a short delay
      if (!this._isStopped) {
        this._autoClearTimer = setTimeout(checkAndClear, AUTO_INITIAL_DELAY_MS);
      }
    }
  }

  /**
   * Sends input directly to the PTY process.
   *
   * For interactive sessions, this is how you send user input to Claude.
   * Remember to include `\r` (carriage return) to simulate pressing Enter.
   *
   * @param data - The input data to send (text, escape sequences, etc.)
   *
   * @example
   * ```typescript
   * session.write('hello world');  // Text only, no Enter
   * session.write('\r');           // Enter key
   * session.write('ls -la\r');     // Command with Enter
   * ```
   */
  write(data: string): void {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  /**
   * Sends input via GNU Screen's `screen -X stuff` command.
   *
   * More reliable than direct PTY write for programmatic input, especially
   * with Claude CLI which uses Ink (React for terminals). Text and Enter
   * are sent as separate commands internally.
   *
   * @param data - Input data with optional `\r` for Enter
   * @returns true if input was sent, false if no screen session or PTY
   *
   * @example
   * ```typescript
   * session.writeViaScreen('/clear\r');  // Send /clear command
   * session.writeViaScreen('/init\r');   // Send /init command
   * ```
   */
  writeViaScreen(data: string): boolean {
    if (this._screenManager && this._screenSession) {
      return this._screenManager.sendInput(this.id, data);
    }
    // Fallback to PTY write
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
      return true;
    }
    return false;
  }

  /**
   * Resizes the PTY terminal dimensions.
   *
   * Call this when the frontend terminal is resized to keep PTY in sync.
   *
   * @param cols - Number of columns (width in characters)
   * @param rows - Number of rows (height in lines)
   */
  resize(cols: number, rows: number): void {
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows);
    }
  }

  // Legacy method for compatibility with session-manager
  async start(): Promise<void> {
    this._status = 'idle';
  }

  // Legacy method for sending input - wraps runPrompt
  async sendInput(input: string): Promise<void> {
    this._status = 'busy';
    this._lastActivityAt = Date.now();
    this.runPrompt(input).catch(err => {
      this.emit('error', err.message);
    });
  }

  /**
   * Remove event listeners from TaskTracker and RalphTracker.
   * Prevents memory leaks by ensuring handlers don't persist after session stop.
   */
  private cleanupTrackerListeners(): void {
    // Remove TaskTracker handlers
    if (this._taskTrackerHandlers) {
      this._taskTracker.off('taskCreated', this._taskTrackerHandlers.taskCreated);
      this._taskTracker.off('taskUpdated', this._taskTrackerHandlers.taskUpdated);
      this._taskTracker.off('taskCompleted', this._taskTrackerHandlers.taskCompleted);
      this._taskTracker.off('taskFailed', this._taskTrackerHandlers.taskFailed);
      this._taskTrackerHandlers = null;
    }

    // Remove RalphTracker handlers
    if (this._ralphHandlers) {
      this._ralphTracker.off('loopUpdate', this._ralphHandlers.loopUpdate);
      this._ralphTracker.off('todoUpdate', this._ralphHandlers.todoUpdate);
      this._ralphTracker.off('completionDetected', this._ralphHandlers.completionDetected);
      this._ralphTracker.off('statusBlockDetected', this._ralphHandlers.statusBlockDetected);
      this._ralphTracker.off('circuitBreakerUpdate', this._ralphHandlers.circuitBreakerUpdate);
      this._ralphTracker.off('exitGateMet', this._ralphHandlers.exitGateMet);
      this._ralphHandlers = null;
    }

    // Remove BashToolParser handlers
    if (this._bashToolHandlers) {
      this._bashToolParser.off('toolStart', this._bashToolHandlers.toolStart);
      this._bashToolParser.off('toolEnd', this._bashToolHandlers.toolEnd);
      this._bashToolParser.off('toolsUpdate', this._bashToolHandlers.toolsUpdate);
      this._bashToolHandlers = null;
    }
    this._bashToolParser.destroy();

  }

  /**
   * Stops the session and cleans up resources.
   *
   * This kills the PTY process and optionally the associated GNU Screen
   * session. All buffers are cleared and the session is marked as stopped.
   *
   * @param killScreen - Whether to also kill the screen session (default: true)
   *
   * @example
   * ```typescript
   * // Stop and kill everything
   * await session.stop();
   *
   * // Stop but keep screen running for later reattachment
   * await session.stop(false);
   * ```
   */
  async stop(killScreen: boolean = true): Promise<void> {
    // Set stopped flag first to prevent new timers from being created
    this._isStopped = true;

    // Clear activity timeout to prevent memory leak
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }

    // Clear line buffer flush timer
    if (this._lineBufferFlushTimer) {
      clearTimeout(this._lineBufferFlushTimer);
      this._lineBufferFlushTimer = null;
    }

    // Clear auto-compact/auto-clear timers to prevent memory leaks
    if (this._autoCompactTimer) {
      clearTimeout(this._autoCompactTimer);
      this._autoCompactTimer = null;
    }
    this._isCompacting = false;

    if (this._autoClearTimer) {
      clearTimeout(this._autoClearTimer);
      this._autoClearTimer = null;
    }
    this._isClearing = false;

    // Clear prompt check timers
    if (this._promptCheckInterval) {
      clearInterval(this._promptCheckInterval);
      this._promptCheckInterval = null;
    }
    if (this._promptCheckTimeout) {
      clearTimeout(this._promptCheckTimeout);
      this._promptCheckTimeout = null;
    }

    // Clear shell idle timer
    if (this._shellIdleTimer) {
      clearTimeout(this._shellIdleTimer);
      this._shellIdleTimer = null;
    }

    // Immediately cleanup Promise callbacks to prevent orphaned references
    // during the rest of stop() processing (e.g., if screen kill times out)
    if (this.rejectPromise) {
      this.rejectPromise(new Error('Session stopped'));
    }
    this.resolvePromise = null;
    this.rejectPromise = null;

    // Remove event listeners from trackers to prevent memory leaks
    this.cleanupTrackerListeners();

    if (this.ptyProcess) {
      const pid = this.ptyProcess.pid;

      // First try graceful SIGTERM
      try {
        this.ptyProcess.kill();
      } catch {
        // Process may already be dead
      }

      // Give it a moment to terminate gracefully
      await new Promise(resolve => setTimeout(resolve, GRACEFUL_SHUTDOWN_DELAY_MS));

      // Force kill with SIGKILL if still alive
      try {
        if (pid) {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        // Process already terminated
      }

      // Also try to kill any child processes in the process group
      try {
        if (pid) {
          process.kill(-pid, 'SIGKILL');
        }
      } catch {
        // Process group may not exist or already terminated
      }

      this.ptyProcess = null;
    }
    this._pid = null;
    this._status = 'stopped';
    this._currentTaskId = null;

    // Kill the associated screen session if requested
    if (killScreen && this._screenManager) {
      // Try to kill screen even if _screenSession is not set (e.g., restored sessions)
      try {
        const killed = await this._screenManager.killScreen(this.id);
        if (killed) {
          console.log('[Session] Killed screen session for:', this.id);
        }
      } catch (err) {
        console.error('[Session] Failed to kill screen session:', err);
      }
      this._screenSession = null;
    } else if (this._screenSession && !killScreen) {
      console.log('[Session] Keeping screen session alive:', this._screenSession.screenName);
      this._screenSession = null; // Detach but don't kill
    }
  }

  assignTask(taskId: string): void {
    this._currentTaskId = taskId;
    this._status = 'busy';
    this._terminalBuffer.clear();
    this._outputBuffer = '';
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lastActivityAt = Date.now();
  }

  clearTask(): void {
    this._currentTaskId = null;
    this._status = 'idle';
    this._lastActivityAt = Date.now();
  }

  getOutput(): string {
    return this._textOutput.value;
  }

  getError(): string {
    return this._errorBuffer;
  }

  getTerminalBuffer(): string {
    return this._terminalBuffer.value;
  }

  clearBuffers(): void {
    this._terminalBuffer.clear();
    this._outputBuffer = '';
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._taskTracker.clear();
    this._ralphTracker.clear();
  }
}
