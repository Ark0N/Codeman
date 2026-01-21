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
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { SessionState, SessionStatus, SessionConfig, ScreenSession, InnerLoopState, InnerTodoItem } from './types.js';
import { TaskTracker, type BackgroundTask } from './task-tracker.js';
import { InnerLoopTracker } from './inner-loop-tracker.js';
import { ScreenManager } from './screen-manager.js';

export type { BackgroundTask } from './task-tracker.js';
export type { InnerLoopState, InnerTodoItem } from './types.js';
export { withTimeout };

// ============================================================================
// Buffer Size Constants
// ============================================================================

/** Maximum terminal buffer size in characters (5MB) */
const MAX_TERMINAL_BUFFER_SIZE = 5 * 1024 * 1024;

/** When trimming terminal buffer, keep the most recent portion (4MB) */
const TERMINAL_BUFFER_TRIM_SIZE = 4 * 1024 * 1024;

/** Maximum text output buffer size (2MB) - ANSI-stripped text */
const MAX_TEXT_OUTPUT_SIZE = 2 * 1024 * 1024;

/** When trimming text output, keep the most recent portion (1.5MB) */
const TEXT_OUTPUT_TRIM_SIZE = 1.5 * 1024 * 1024;

/** Maximum number of Claude JSON messages to keep in memory */
const MAX_MESSAGES = 1000;

/** Maximum line buffer size (64KB) - prevents unbounded growth for long lines */
const MAX_LINE_BUFFER_SIZE = 64 * 1024;

/** Line buffer flush interval (100ms) - forces processing of partial lines */
const LINE_BUFFER_FLUSH_INTERVAL = 100;

/** Default timeout for async operations in milliseconds (5 minutes) */
const DEFAULT_ASYNC_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout for interactive session startup in milliseconds (30 seconds) */
const INTERACTIVE_START_TIMEOUT_MS = 30 * 1000;

// Filter out terminal focus escape sequences (focus in/out reports)
// ^[[I (focus in), ^[[O (focus out), and the enable/disable sequences
const FOCUS_ESCAPE_FILTER = /\x1b\[\?1004[hl]|\x1b\[[IO]/g;

// Pre-compiled regex patterns for performance (avoid re-compilation on each call)
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;
const TOKEN_PATTERN = /(\d+(?:\.\d+)?)\s*([kKmM])?\s*tokens/;

// ============================================================================
// Buffer Accumulator (reduces GC pressure from string concatenation)
// ============================================================================

/**
 * High-performance buffer accumulator using array-based collection.
 *
 * Reduces GC pressure by avoiding repeated string concatenation (`+=`).
 * Instead, chunks are pushed to an array and joined only when needed.
 * Automatically trims when size limits are exceeded.
 */
class BufferAccumulator {
  private chunks: string[] = [];
  private totalLength: number = 0;
  private readonly maxSize: number;
  private readonly trimSize: number;

  constructor(maxSize: number, trimSize: number) {
    this.maxSize = maxSize;
    this.trimSize = trimSize;
  }

  /** Append data to the buffer */
  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.totalLength += data.length;

    // Trim if exceeded max size
    if (this.totalLength > this.maxSize) {
      this.trim();
    }
  }

  /** Get the full buffer content (joins all chunks) */
  get value(): string {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0];

    // Consolidate chunks on access
    const result = this.chunks.join('');
    this.chunks = [result];
    return result;
  }

  /** Get current buffer length without joining */
  get length(): number {
    return this.totalLength;
  }

  /** Clear the buffer */
  clear(): void {
    this.chunks = [];
    this.totalLength = 0;
  }

  /** Set buffer to a specific value */
  set(value: string): void {
    this.chunks = value ? [value] : [];
    this.totalLength = value?.length || 0;
  }

  /** Trim buffer to keep only the most recent data */
  private trim(): void {
    const full = this.chunks.join('');
    const trimmed = full.slice(-this.trimSize);
    this.chunks = [trimmed];
    this.totalLength = trimmed.length;
  }
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
  /** Inner loop (Ralph Wiggum) state changed */
  innerLoopUpdate: (state: InnerLoopState) => void;
  /** Inner loop todo list updated */
  innerTodoUpdate: (todos: InnerTodoItem[]) => void;
  /** Inner loop completion phrase detected */
  innerCompletionDetected: (phrase: string) => void;
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

  // Screen session support
  private _screenManager: ScreenManager | null = null;
  private _screenSession: ScreenSession | null = null;
  private _useScreen: boolean = false;

  // Inner loop tracking (Ralph Wiggum loops and todo lists inside Claude Code)
  private _innerLoopTracker: InnerLoopTracker;

  // Store handler references for cleanup (prevents memory leaks)
  private _taskTrackerHandlers: {
    taskCreated: (task: BackgroundTask) => void;
    taskUpdated: (task: BackgroundTask) => void;
    taskCompleted: (task: BackgroundTask) => void;
    taskFailed: (task: BackgroundTask, error: string) => void;
  } | null = null;

  private _innerLoopHandlers: {
    loopUpdate: (state: InnerLoopState) => void;
    todoUpdate: (todos: InnerTodoItem[]) => void;
    completionDetected: (phrase: string) => void;
  } | null = null;

  constructor(config: Partial<SessionConfig> & {
    workingDir: string;
    mode?: SessionMode;
    name?: string;
    screenManager?: ScreenManager;
    useScreen?: boolean;
    screenSession?: ScreenSession;  // For restored sessions - pass the existing screen
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

    // Initialize inner loop tracker and forward events (store handlers for cleanup)
    this._innerLoopTracker = new InnerLoopTracker();
    this._innerLoopHandlers = {
      loopUpdate: (state) => this.emit('innerLoopUpdate', state),
      todoUpdate: (todos) => this.emit('innerTodoUpdate', todos),
      completionDetected: (phrase) => this.emit('innerCompletionDetected', phrase),
    };
    this._innerLoopTracker.on('loopUpdate', this._innerLoopHandlers.loopUpdate);
    this._innerLoopTracker.on('todoUpdate', this._innerLoopHandlers.todoUpdate);
    this._innerLoopTracker.on('completionDetected', this._innerLoopHandlers.completionDetected);
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

  // Inner loop tracking getters
  get innerLoopTracker(): InnerLoopTracker {
    return this._innerLoopTracker;
  }

  get innerLoopState(): InnerLoopState {
    return this._innerLoopTracker.loopState;
  }

  get innerTodos(): InnerTodoItem[] {
    return this._innerLoopTracker.todos;
  }

  get innerTodoStats(): { total: number; pending: number; inProgress: number; completed: number } {
    return this._innerLoopTracker.getTodoStats();
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
      // Inner loop tracking state
      innerLoop: this._innerLoopTracker.loopState,
      innerTodos: this._innerLoopTracker.todos,
      innerTodoStats: this._innerLoopTracker.getTodoStats(),
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
          this._screenSession = await this._screenManager.createScreen(this.id, this.workingDir, 'claude', this._name);
          console.log('[Session] Created screen session:', this._screenSession.screenName);

          // Wait a moment for screen to fully start
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        // Attach to the screen session via PTY
        this.ptyProcess = pty.spawn('screen', [
          '-x', this._screenSession!.screenName
        ], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: { ...process.env, TERM: 'xterm-256color' },
        });

        // For NEW screens: wait for prompt to appear then clean buffer
        // For RESTORED screens: don't do anything - client will fetch buffer on tab switch
        if (!isRestoredSession) {
          const checkForPrompt = setInterval(() => {
            // Wait for the prompt character (❯) which means Claude is fully initialized
            const bufferValue = this._terminalBuffer.value;
            if (bufferValue.includes('❯') || bufferValue.includes('\u276f')) {
              clearInterval(checkForPrompt);
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
          setTimeout(() => clearInterval(checkForPrompt), 5000);
        }
      } catch (err) {
        console.error('[Session] Failed to create screen session, falling back to direct PTY:', err);
        this._useScreen = false;
        this._screenSession = null;
      }
    }

    // Fallback to direct PTY if screen is not used
    if (!this.ptyProcess) {
      this.ptyProcess = pty.spawn('claude', [
        '--dangerously-skip-permissions'
      ], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.workingDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          // Inform Claude it's running within Claudeman (helps prevent self-termination)
          CLAUDEMAN_SCREEN: '1',
          CLAUDEMAN_SESSION_ID: this.id,
        },
      });
    }

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

      // Forward to inner loop tracker to detect Ralph loops and todos
      this._innerLoopTracker.processTerminalData(data);

      // Parse token count from status line (e.g., "123.4k tokens" or "5234 tokens")
      this.parseTokensFromStatusLine(data);

      // Detect if Claude is working or at prompt
      // The prompt line contains "❯" when waiting for input
      if (data.includes('❯') || data.includes('\u276f')) {
        // Reset activity timeout - if no activity for 2 seconds after prompt, Claude is idle
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
        this.activityTimeout = setTimeout(() => {
          if (this._isWorking) {
            this._isWorking = false;
            this._lastPromptTime = Date.now();
            this.emit('idle');
          }
        }, 2000);
      }

      // Detect when Claude starts working (thinking, writing, etc)
      if (data.includes('Thinking') || data.includes('Writing') || data.includes('Reading') ||
          data.includes('Running') || data.includes('⠋') || data.includes('⠙') ||
          data.includes('⠹') || data.includes('⠸') || data.includes('⠼') ||
          data.includes('⠴') || data.includes('⠦') || data.includes('⠧')) {
        if (!this._isWorking) {
          this._isWorking = true;
          this.emit('working');
        }
        // Reset timeout since Claude is active
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
      }
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Interactive PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
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
          this._screenSession = await this._screenManager.createScreen(this.id, this.workingDir, 'shell', this._name);
          console.log('[Session] Created screen session:', this._screenSession.screenName);

          // Wait a moment for screen to fully start
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        // Attach to the screen session via PTY
        this.ptyProcess = pty.spawn('screen', [
          '-x', this._screenSession!.screenName
        ], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: { ...process.env, TERM: 'xterm-256color' },
        });

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
        },
      });
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
      // If using screen, mark the screen as detached but don't kill it
      if (this._screenSession && this._screenManager) {
        this._screenManager.setAttached(this.id, false);
      }
      this.emit('exit', exitCode);
    });

    // Mark as idle after a short delay (shell is ready)
    setTimeout(() => {
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
   * @returns Promise resolving to the result text and total cost in USD
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project' });
   * const { result, cost } = await session.runPrompt('Explain this code');
   * console.log(`Response: ${result}`);
   * console.log(`Cost: $${cost.toFixed(4)}`);
   * ```
   */
  async runPrompt(prompt: string): Promise<{ result: string; cost: number }> {
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
        console.log('[Session] Spawning PTY for claude with prompt:', prompt.substring(0, 50));

        this.ptyProcess = pty.spawn('claude', [
          '-p',
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          prompt
        ], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            // Inform Claude it's running within Claudeman
            CLAUDEMAN_SCREEN: '1',
            CLAUDEMAN_SESSION_ID: this.id,
          },
        });

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
    // Try to extract JSON from output (Claude may output JSON in stream mode)
    this._lineBuffer += data;

    // Prevent unbounded line buffer growth for very long lines
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      // Force flush the oversized buffer as text output
      this._textOutput.append(this._lineBuffer + '\n');
      this._lineBuffer = '';
    }

    // Start flush timer if not running (handles partial lines after 100ms)
    if (!this._lineBufferFlushTimer && this._lineBuffer.length > 0) {
      this._lineBufferFlushTimer = setTimeout(() => {
        this._lineBufferFlushTimer = null;
        if (this._lineBuffer.length > 0) {
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
      const cleanLine = trimmed.replace(ANSI_ESCAPE_PATTERN, '');

      if (cleanLine.startsWith('{') && cleanLine.endsWith('}')) {
        try {
          const msg = JSON.parse(cleanLine) as ClaudeMessage;
          this._messages.push(msg);
          this.emit('message', msg);

          // Trim messages array for long-running sessions
          if (this._messages.length > MAX_MESSAGES) {
            this._messages = this._messages.slice(-Math.floor(MAX_MESSAGES * 0.8));
          }

          if (msg.type === 'system' && msg.session_id) {
            this._claudeSessionId = msg.session_id;
          }

          // Process message for task tracking
          this._taskTracker.processMessage(msg);

          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                this._textOutput.append(block.text);
              }
            }
            // Track tokens from usage
            if (msg.message.usage) {
              this._totalInputTokens += msg.message.usage.input_tokens || 0;
              this._totalOutputTokens += msg.message.usage.output_tokens || 0;

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
    }
    // Note: BufferAccumulator auto-trims when max size exceeded
  }

  // Parse token count from Claude's status line in interactive mode
  // Matches patterns like "123.4k tokens", "5234 tokens", "1.2M tokens"
  private parseTokensFromStatusLine(data: string): void {
    // Remove ANSI escape codes for cleaner parsing (use pre-compiled pattern)
    const cleanData = data.replace(ANSI_ESCAPE_PATTERN, '');

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
        tokenCount *= 1000000;
      }

      // Only update if the new count is higher (tokens only increase within a session)
      // We use total tokens as an estimate - Claude shows combined input+output
      const currentTotal = this._totalInputTokens + this._totalOutputTokens;
      if (tokenCount > currentTotal) {
        // Estimate: split roughly 60% input, 40% output (common ratio)
        // This is an approximation since interactive mode doesn't give us the breakdown
        const delta = tokenCount - currentTotal;
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
    if (!this._autoCompactEnabled || this._isCompacting || this._isClearing) return;

    const totalTokens = this._totalInputTokens + this._totalOutputTokens;
    if (totalTokens >= this._autoCompactThreshold) {
      this._isCompacting = true;
      console.log(`[Session] Auto-compact triggered: ${totalTokens} tokens >= ${this._autoCompactThreshold} threshold`);

      // Wait for Claude to be idle before compacting
      const checkAndCompact = () => {
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
          setTimeout(() => {
            this._isCompacting = false;
          }, 10000);
        } else {
          // Check again in 2 seconds
          setTimeout(checkAndCompact, 2000);
        }
      };

      // Start checking after a short delay
      setTimeout(checkAndCompact, 1000);
    }
  }

  // Check if we should auto-clear based on token threshold
  private checkAutoClear(): void {
    if (!this._autoClearEnabled || this._isClearing || this._isCompacting) return;

    const totalTokens = this._totalInputTokens + this._totalOutputTokens;
    if (totalTokens >= this._autoClearThreshold) {
      this._isClearing = true;
      console.log(`[Session] Auto-clear triggered: ${totalTokens} tokens >= ${this._autoClearThreshold} threshold`);

      // Wait for Claude to be idle before clearing
      const checkAndClear = () => {
        if (!this._isWorking) {
          // Send /clear command
          this.writeViaScreen('/clear\r');
          // Reset token counts
          this._totalInputTokens = 0;
          this._totalOutputTokens = 0;
          this.emit('autoClear', { tokens: totalTokens, threshold: this._autoClearThreshold });

          // Wait a moment then re-enable
          setTimeout(() => {
            this._isClearing = false;
          }, 5000);
        } else {
          // Check again in 2 seconds
          setTimeout(checkAndClear, 2000);
        }
      };

      // Start checking after a short delay
      setTimeout(checkAndClear, 1000);
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
   * Remove event listeners from TaskTracker and InnerLoopTracker.
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

    // Remove InnerLoopTracker handlers
    if (this._innerLoopHandlers) {
      this._innerLoopTracker.off('loopUpdate', this._innerLoopHandlers.loopUpdate);
      this._innerLoopTracker.off('todoUpdate', this._innerLoopHandlers.todoUpdate);
      this._innerLoopTracker.off('completionDetected', this._innerLoopHandlers.completionDetected);
      this._innerLoopHandlers = null;
    }
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
      await new Promise(resolve => setTimeout(resolve, 100));

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
    this._innerLoopTracker.clear();
  }
}
