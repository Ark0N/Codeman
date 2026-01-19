import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { SessionState, SessionStatus, SessionConfig, ScreenSession } from './types.js';
import { TaskTracker, type BackgroundTask } from './task-tracker.js';
import { ScreenManager } from './screen-manager.js';

export type { BackgroundTask } from './task-tracker.js';

// Maximum terminal buffer size in characters (default 5MB of text)
const MAX_TERMINAL_BUFFER_SIZE = 5 * 1024 * 1024;
// When trimming, keep the most recent portion (4MB)
const TERMINAL_BUFFER_TRIM_SIZE = 4 * 1024 * 1024;
// Maximum text output buffer size (2MB)
const MAX_TEXT_OUTPUT_SIZE = 2 * 1024 * 1024;
const TEXT_OUTPUT_TRIM_SIZE = 1.5 * 1024 * 1024;
// Maximum number of Claude messages to keep in memory
const MAX_MESSAGES = 1000;

// Filter out terminal focus escape sequences (focus in/out reports)
// ^[[I (focus in), ^[[O (focus out), and the enable/disable sequences
const FOCUS_ESCAPE_FILTER = /\x1b\[\?1004[hl]|\x1b\[[IO]/g;

export interface ClaudeMessage {
  type: 'system' | 'assistant' | 'user' | 'result';
  subtype?: string;
  session_id?: string;
  message?: {
    content: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
}

export interface SessionEvents {
  output: (data: string) => void;
  message: (msg: ClaudeMessage) => void;
  error: (data: string) => void;
  exit: (code: number | null) => void;
  completion: (result: string, cost: number) => void;
  terminal: (data: string) => void;  // Raw terminal data
  // Background task events
  taskCreated: (task: BackgroundTask) => void;
  taskUpdated: (task: BackgroundTask) => void;
  taskCompleted: (task: BackgroundTask) => void;
  taskFailed: (task: BackgroundTask, error: string) => void;
  // Auto-clear event
  autoClear: (data: { tokens: number; threshold: number }) => void;
}

export type SessionMode = 'claude' | 'shell';

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
  private _terminalBuffer: string = '';  // Raw terminal output
  private _outputBuffer: string = '';
  private _textOutput: string = '';
  private _errorBuffer: string = '';
  private _lastActivityAt: number;
  private _claudeSessionId: string | null = null;
  private _totalCost: number = 0;
  private _messages: ClaudeMessage[] = [];
  private _lineBuffer: string = '';
  private resolvePromise: ((value: { result: string; cost: number }) => void) | null = null;
  private rejectPromise: ((reason: Error) => void) | null = null;
  private _isWorking: boolean = false;
  private _lastPromptTime: number = 0;
  private activityTimeout: NodeJS.Timeout | null = null;
  private _taskTracker: TaskTracker;

  // Token tracking for auto-clear
  private _totalInputTokens: number = 0;
  private _totalOutputTokens: number = 0;
  private _autoClearThreshold: number = 100000; // Default 100k tokens
  private _autoClearEnabled: boolean = false;
  private _isClearing: boolean = false; // Prevent recursive clearing

  // Screen session support
  private _screenManager: ScreenManager | null = null;
  private _screenSession: ScreenSession | null = null;
  private _useScreen: boolean = false;

  constructor(config: Partial<SessionConfig> & {
    workingDir: string;
    mode?: SessionMode;
    name?: string;
    screenManager?: ScreenManager;
    useScreen?: boolean;
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

    // Initialize task tracker and forward events
    this._taskTracker = new TaskTracker();
    this._taskTracker.on('taskCreated', (task) => this.emit('taskCreated', task));
    this._taskTracker.on('taskUpdated', (task) => this.emit('taskUpdated', task));
    this._taskTracker.on('taskCompleted', (task) => this.emit('taskCompleted', task));
    this._taskTracker.on('taskFailed', (task, error) => this.emit('taskFailed', task, error));
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
    return this._terminalBuffer;
  }

  get outputBuffer(): string {
    return this._outputBuffer;
  }

  get textOutput(): string {
    return this._textOutput;
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
      textOutput: this._textOutput,
      terminalBuffer: this._terminalBuffer,
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
    };
  }

  // Start an interactive Claude Code session (full terminal)
  async startInteractive(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._status = 'busy';
    this._terminalBuffer = '';
    this._outputBuffer = '';
    this._textOutput = '';
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._lastActivityAt = Date.now();

    console.log('[Session] Starting interactive Claude session' + (this._useScreen ? ' (with screen)' : ''));

    // If screen wrapping is enabled, create a screen session first
    if (this._useScreen && this._screenManager) {
      try {
        this._screenSession = await this._screenManager.createScreen(this.id, this.workingDir, 'claude', this._name);
        console.log('[Session] Created screen session:', this._screenSession.screenName);

        // Wait a moment for screen to fully start
        await new Promise(resolve => setTimeout(resolve, 300));

        // Attach to the screen session via PTY
        this.ptyProcess = pty.spawn('screen', [
          '-x', this._screenSession.screenName
        ], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
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
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    }

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Interactive PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
      if (!data) return; // Skip if only focus sequences

      this._terminalBuffer += data;
      this._lastActivityAt = Date.now();

      // Trim buffer if it exceeds max size to prevent memory issues
      if (this._terminalBuffer.length > MAX_TERMINAL_BUFFER_SIZE) {
        this._terminalBuffer = this._terminalBuffer.slice(-TERMINAL_BUFFER_TRIM_SIZE);
      }

      this.emit('terminal', data);
      this.emit('output', data);

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

  // Start a plain shell session (bash/zsh without Claude)
  async startShell(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._status = 'busy';
    this._terminalBuffer = '';
    this._outputBuffer = '';
    this._textOutput = '';
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._lastActivityAt = Date.now();

    // Use user's default shell or bash
    const shell = process.env.SHELL || '/bin/bash';
    console.log('[Session] Starting shell session with:', shell + (this._useScreen ? ' (with screen)' : ''));

    // If screen wrapping is enabled, create a screen session first
    if (this._useScreen && this._screenManager) {
      try {
        this._screenSession = await this._screenManager.createScreen(this.id, this.workingDir, 'shell', this._name);
        console.log('[Session] Created screen session:', this._screenSession.screenName);

        // Wait a moment for screen to fully start
        await new Promise(resolve => setTimeout(resolve, 300));

        // Attach to the screen session via PTY
        this.ptyProcess = pty.spawn('screen', [
          '-x', this._screenSession.screenName
        ], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
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
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    }

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Shell PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
      if (!data) return; // Skip if only focus sequences

      this._terminalBuffer += data;
      this._lastActivityAt = Date.now();

      // Trim buffer if it exceeds max size
      if (this._terminalBuffer.length > MAX_TERMINAL_BUFFER_SIZE) {
        this._terminalBuffer = this._terminalBuffer.slice(-TERMINAL_BUFFER_TRIM_SIZE);
      }

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

  async runPrompt(prompt: string): Promise<{ result: string; cost: number }> {
    return new Promise((resolve, reject) => {
      if (this.ptyProcess) {
        reject(new Error('Session already has a running process'));
        return;
      }

      this._status = 'busy';
      this._terminalBuffer = '';
      this._outputBuffer = '';
      this._textOutput = '';
      this._errorBuffer = '';
      this._messages = [];
      this._lineBuffer = '';
      this._lastActivityAt = Date.now();

      this.resolvePromise = resolve;
      this.rejectPromise = reject;

      try {
        // Spawn claude in a real PTY
        console.log('[Session] Spawning PTY for claude with prompt:', prompt.substring(0, 50));

        this.ptyProcess = pty.spawn('claude', [
          '-p',
          '--dangerously-skip-permissions',
          prompt
        ], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: { ...process.env, TERM: 'xterm-256color' },
        });

        this._pid = this.ptyProcess.pid;
        console.log('[Session] PTY spawned with PID:', this._pid);

        // Handle terminal data
        this.ptyProcess.onData((rawData: string) => {
          // Filter out focus escape sequences
          const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
          if (!data) return; // Skip if only focus sequences

          this._terminalBuffer += data;
          this._lastActivityAt = Date.now();

          // Trim buffer if it exceeds max size to prevent memory issues
          if (this._terminalBuffer.length > MAX_TERMINAL_BUFFER_SIZE) {
            this._terminalBuffer = this._terminalBuffer.slice(-TERMINAL_BUFFER_TRIM_SIZE);
          }

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

          // Find result from parsed messages or use text output
          const resultMsg = this._messages.find(m => m.type === 'result');

          if (resultMsg && !resultMsg.is_error) {
            this._status = 'idle';
            const cost = resultMsg.total_cost_usd || 0;
            this._totalCost += cost;
            this.emit('completion', resultMsg.result || '', cost);
            if (this.resolvePromise) {
              this.resolvePromise({ result: resultMsg.result || '', cost });
            }
          } else if (exitCode !== 0 || (resultMsg && resultMsg.is_error)) {
            this._status = 'error';
            if (this.rejectPromise) {
              this.rejectPromise(new Error(this._errorBuffer || this._textOutput || 'Process exited with error'));
            }
          } else {
            this._status = 'idle';
            if (this.resolvePromise) {
              this.resolvePromise({ result: this._textOutput || this._terminalBuffer, cost: this._totalCost });
            }
          }

          this.resolvePromise = null;
          this.rejectPromise = null;
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
    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      // Remove ANSI escape codes for JSON parsing
      const cleanLine = trimmed.replace(/\x1b\[[0-9;]*m/g, '');

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
                this._textOutput += block.text;
              }
            }
            // Track tokens from usage
            if (msg.message.usage) {
              this._totalInputTokens += msg.message.usage.input_tokens || 0;
              this._totalOutputTokens += msg.message.usage.output_tokens || 0;

              // Check if we should auto-clear
              this.checkAutoClear();
            }
          }

          if (msg.type === 'result' && msg.total_cost_usd) {
            this._totalCost = msg.total_cost_usd;
          }
        } catch {
          // Not JSON, just regular output
          this._textOutput += line + '\n';
        }
      } else if (trimmed) {
        this._textOutput += line + '\n';
      }
    }

    // Trim text output buffer for long-running sessions
    if (this._textOutput.length > MAX_TEXT_OUTPUT_SIZE) {
      this._textOutput = this._textOutput.slice(-TEXT_OUTPUT_TRIM_SIZE);
    }
  }

  // Check if we should auto-clear based on token threshold
  private checkAutoClear(): void {
    if (!this._autoClearEnabled || this._isClearing) return;

    const totalTokens = this._totalInputTokens + this._totalOutputTokens;
    if (totalTokens >= this._autoClearThreshold) {
      this._isClearing = true;
      console.log(`[Session] Auto-clear triggered: ${totalTokens} tokens >= ${this._autoClearThreshold} threshold`);

      // Wait for Claude to be idle before clearing
      const checkAndClear = () => {
        if (!this._isWorking) {
          // Send /clear command
          this.write('/clear\n');
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

  // Send input to the PTY (for interactive sessions)
  write(data: string): void {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  // Resize the PTY
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

  async stop(): Promise<void> {
    // Clear activity timeout to prevent memory leak
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }

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

    // Kill the associated screen session if any
    if (this._screenSession && this._screenManager) {
      try {
        await this._screenManager.killScreen(this.id);
        console.log('[Session] Killed screen session:', this._screenSession.screenName);
      } catch (err) {
        console.error('[Session] Failed to kill screen session:', err);
      }
      this._screenSession = null;
    }

    if (this.rejectPromise) {
      this.rejectPromise(new Error('Session stopped'));
      this.resolvePromise = null;
      this.rejectPromise = null;
    }
  }

  assignTask(taskId: string): void {
    this._currentTaskId = taskId;
    this._status = 'busy';
    this._terminalBuffer = '';
    this._outputBuffer = '';
    this._textOutput = '';
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
    return this._textOutput;
  }

  getError(): string {
    return this._errorBuffer;
  }

  getTerminalBuffer(): string {
    return this._terminalBuffer;
  }

  clearBuffers(): void {
    this._terminalBuffer = '';
    this._outputBuffer = '';
    this._textOutput = '';
    this._errorBuffer = '';
    this._messages = [];
    this._taskTracker.clear();
  }
}
