/**
 * @fileoverview Respawn Controller for autonomous Claude Code session cycling
 *
 * The RespawnController manages automatic respawning of Claude Code sessions.
 * When Claude finishes working (detected by completion message + output silence),
 * it automatically cycles through update → clear → init steps to keep the session productive.
 *
 * ## State Machine
 *
 * ```
 * WATCHING → CONFIRMING_IDLE → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR
 *    ↑          │                                                                      │
 *    │          │ (new output)                                                         ▼
 *    │          └─────────────► SENDING_INIT → WAITING_INIT → MONITORING_INIT ────────┘
 *    │                                                             │
 *    │                                                             ▼ (if no work triggered)
 *    └──────────────────────── SENDING_KICKSTART → WAITING_KICKSTART ──┘
 * ```
 *
 * ## Idle Detection (Updated for Claude Code 2024+)
 *
 * Primary detection: Completion message pattern "for Xm Xs" (e.g., "✻ Worked for 2m 46s")
 * Confirmation: No new output for configurable duration (default 5s)
 * Fallback: No output at all for extended period (default 30s)
 *
 * ## Configuration
 *
 * - `sendClear`: Whether to send /clear after update (default: true)
 * - `sendInit`: Whether to send /init after clear (default: true)
 * - `kickstartPrompt`: Optional prompt if /init doesn't trigger work
 * - `completionConfirmMs`: Time to wait after completion message (default: 10000)
 * - `noOutputTimeoutMs`: Fallback timeout with no output at all (default: 30000)
 *
 * @module respawn-controller
 */

import { EventEmitter } from 'node:events';
import { Session } from './session.js';
import { AiIdleChecker, type AiCheckResult, type AiCheckState } from './ai-idle-checker.js';

// ========== Configuration Constants ==========

/**
 * Maximum terminal buffer size for respawn controller.
 * Buffer is trimmed when this limit is exceeded to prevent memory issues.
 */
const MAX_RESPAWN_BUFFER_SIZE = 1024 * 1024; // 1MB

/**
 * Size to trim buffer to when MAX_RESPAWN_BUFFER_SIZE is exceeded.
 * Keeps the most recent output for pattern detection.
 */
const RESPAWN_BUFFER_TRIM_SIZE = 512 * 1024; // 512KB

// ========== Constants ==========

/**
 * Pattern to detect completion messages from Claude Code.
 * Requires "Worked for" prefix to avoid false positives from bare time durations
 * in regular text (e.g., "wait for 5s", "run for 2m").
 *
 * Matches: "✻ Worked for 2m 46s", "Worked for 46s", "Worked for 1h 2m 3s"
 * Does NOT match: "wait for 5s", "run for 2m", "for 3s the system..."
 */
const COMPLETION_TIME_PATTERN = /\bWorked\s+for\s+\d+[hms](\s*\d+[hms])*/i;

/**
 * Pattern to extract token count from Claude's status line.
 * Matches: "123.4k tokens", "5234 tokens", "1.2M tokens"
 */
const TOKEN_PATTERN = /(\d+(?:\.\d+)?)\s*([kKmM])?\s*tokens/;

// Note: The old '↵ send' indicator is no longer reliable in Claude Code 2024+
// Detection now uses completion message patterns ("for Xm Xs") instead.

// ========== Detection Layer Types ==========

/**
 * Detection layers for multi-signal idle detection.
 * Each layer provides a confidence signal that Claude has finished working.
 */
export interface DetectionStatus {
  /** Layer 1: Completion message detected ("for Xm Xs") */
  completionMessageDetected: boolean;
  /** Timestamp when completion message was last seen */
  completionMessageTime: number | null;

  /** Layer 2: Output silence - no new output for threshold duration */
  outputSilent: boolean;
  /** Milliseconds since last output */
  msSinceLastOutput: number;

  /** Layer 3: Token count stability - tokens haven't changed */
  tokensStable: boolean;
  /** Last observed token count */
  lastTokenCount: number;
  /** Milliseconds since token count changed */
  msSinceTokenChange: number;

  /** Layer 4: Working patterns absent - no spinners/activity words */
  workingPatternsAbsent: boolean;
  /** Milliseconds since last working pattern */
  msSinceLastWorking: number;

  /** Layer 5: AI idle check status */
  aiCheck: AiCheckState | null;

  /** Overall confidence level (0-100) */
  confidenceLevel: number;

  /** Human-readable status for UI */
  statusText: string;

  /** What the controller is currently waiting for */
  waitingFor: string;
}

// ========== Buffer Accumulator ==========

/**
 * High-performance buffer accumulator using array-based collection.
 * Reduces GC pressure by avoiding repeated string concatenation.
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

  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.totalLength += data.length;
    if (this.totalLength > this.maxSize) {
      this.trim();
    }
  }

  get value(): string {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0];
    const result = this.chunks.join('');
    this.chunks = [result];
    return result;
  }

  get length(): number {
    return this.totalLength;
  }

  clear(): void {
    this.chunks = [];
    this.totalLength = 0;
  }

  private trim(): void {
    const full = this.chunks.join('');
    const trimmed = full.slice(-this.trimSize);
    this.chunks = [trimmed];
    this.totalLength = trimmed.length;
  }
}

// ========== Type Definitions ==========

/**
 * Respawn sequence states.
 *
 * The controller cycles through these states:
 * ```
 * WATCHING → SENDING_UPDATE → WAITING_UPDATE →
 *   SENDING_CLEAR → WAITING_CLEAR →
 *   SENDING_INIT → WAITING_INIT →
 *   MONITORING_INIT → (maybe SENDING_KICKSTART → WAITING_KICKSTART) →
 *   WATCHING (repeat)
 * ```
 *
 * Steps can be skipped via config (`sendClear: false`, `sendInit: false`).
 */
export type RespawnState =
  /** Watching for idle, ready to start respawn sequence */
  | 'watching'
  /** Completion message detected, waiting for output silence to confirm */
  | 'confirming_idle'
  /** AI checker is analyzing terminal output for IDLE/WORKING verdict */
  | 'ai_checking'
  /** About to send the update docs prompt */
  | 'sending_update'
  /** Waiting for update to complete */
  | 'waiting_update'
  /** About to send /clear command */
  | 'sending_clear'
  /** Waiting for clear to complete */
  | 'waiting_clear'
  /** About to send /init command */
  | 'sending_init'
  /** Waiting for init to complete */
  | 'waiting_init'
  /** Monitoring if /init triggered work */
  | 'monitoring_init'
  /** About to send kickstart prompt */
  | 'sending_kickstart'
  /** Waiting for kickstart to complete */
  | 'waiting_kickstart'
  /** Controller stopped (not running) */
  | 'stopped';

/**
 * Configuration options for the RespawnController.
 */
export interface RespawnConfig {
  /**
   * How long to wait after seeing prompt before considering truly idle.
   * Prevents premature cycling when user is about to type.
   * @default 10000 (10 seconds)
   */
  idleTimeoutMs: number;

  /**
   * The prompt to send when updating docs.
   * Sent at the start of each respawn cycle.
   * @default 'update all the docs and CLAUDE.md'
   */
  updatePrompt: string;

  /**
   * Delay between sending steps (ms).
   * Gives Claude time to process each command.
   * @default 1000 (1 second)
   */
  interStepDelayMs: number;

  /**
   * Whether the respawn loop is enabled.
   * When false, start() will be a no-op.
   * @default true
   */
  enabled: boolean;

  /**
   * Whether to send /clear after update prompt completes.
   * Resets Claude's context for fresh start.
   * @default true
   */
  sendClear: boolean;

  /**
   * Whether to send /init after /clear completes.
   * Re-initializes Claude with CLAUDE.md context.
   * @default true
   */
  sendInit: boolean;

  /**
   * Optional prompt to send if /init doesn't trigger work.
   * Used as a fallback when /init completes but Claude doesn't start working.
   * @default undefined
   */
  kickstartPrompt?: string;

  /**
   * Time to wait after completion message before confirming idle (ms).
   * After seeing "for Xm Xs" pattern, waits this long with no new output.
   * @default 10000 (10 seconds)
   */
  completionConfirmMs: number;

  /**
   * Fallback timeout when no output received at all (ms).
   * If no terminal output for this duration, assumes idle even without completion message.
   * @default 30000 (30 seconds)
   */
  noOutputTimeoutMs: number;

  /**
   * Whether to auto-accept plan mode prompts by pressing Enter.
   * When Claude enters plan mode and presents a plan for approval, output stops
   * without a completion message. This feature detects that state and sends Enter
   * to accept the plan. Does NOT auto-accept AskUserQuestion prompts (those are
   * blocked via the elicitation_dialog hook signal).
   * @default true
   */
  autoAcceptPrompts: boolean;

  /**
   * Delay before auto-accepting plan mode prompts (ms).
   * After no output for this duration AND no completion message detected
   * AND no elicitation dialog signaled, sends Enter to accept the plan.
   * Must be shorter than noOutputTimeoutMs.
   * @default 8000 (8 seconds)
   */
  autoAcceptDelayMs: number;

  /**
   * Whether AI idle check is enabled.
   * When enabled, spawns a fresh Claude CLI to analyze terminal output
   * and provide a definitive IDLE/WORKING verdict before starting respawn.
   * @default true
   */
  aiIdleCheckEnabled: boolean;

  /**
   * Model to use for AI idle check.
   * @default 'claude-opus-4-5-20251101'
   */
  aiIdleCheckModel: string;

  /**
   * Maximum characters of terminal buffer to send to AI checker.
   * @default 16000
   */
  aiIdleCheckMaxContext: number;

  /**
   * Timeout for the AI check in ms.
   * @default 90000 (90 seconds)
   */
  aiIdleCheckTimeoutMs: number;

  /**
   * Cooldown after WORKING verdict in ms.
   * @default 180000 (3 minutes)
   */
  aiIdleCheckCooldownMs: number;
}

/**
 * Events emitted by RespawnController.
 *
 * @event stateChanged - Fired when state machine transitions
 * @event respawnCycleStarted - Fired when a new cycle begins
 * @event respawnCycleCompleted - Fired when a cycle finishes
 * @event stepSent - Fired when a command is sent to the session
 * @event stepCompleted - Fired when a step finishes (ready indicator detected)
 * @event detectionUpdate - Fired when detection status changes (for UI)
 * @event error - Fired on errors
 * @event log - Fired for debug logging
 */
export interface RespawnEvents {
  /** State machine transition */
  stateChanged: (state: RespawnState, prevState: RespawnState) => void;
  /** New respawn cycle started */
  respawnCycleStarted: (cycleNumber: number) => void;
  /** Respawn cycle finished */
  respawnCycleCompleted: (cycleNumber: number) => void;
  /** Command sent to session */
  stepSent: (step: string, input: string) => void;
  /** Step completed (ready indicator detected) */
  stepCompleted: (step: string) => void;
  /** Detection status update for UI display */
  detectionUpdate: (status: DetectionStatus) => void;
  /** Auto-accept sent for plan mode approval */
  autoAcceptSent: () => void;
  /** AI idle check started */
  aiCheckStarted: () => void;
  /** AI idle check completed with verdict */
  aiCheckCompleted: (result: AiCheckResult) => void;
  /** AI idle check failed */
  aiCheckFailed: (error: string) => void;
  /** AI idle check cooldown state changed */
  aiCheckCooldown: (active: boolean, endsAt: number | null) => void;
  /** Error occurred */
  error: (error: Error) => void;
  /** Debug log message */
  log: (message: string) => void;
}

/** Default configuration values */
const DEFAULT_CONFIG: RespawnConfig = {
  idleTimeoutMs: 10000,          // 10 seconds of no activity after prompt (legacy, still used as fallback)
  updatePrompt: 'update all the docs and CLAUDE.md',
  interStepDelayMs: 1000,        // 1 second between steps
  enabled: true,
  sendClear: true,               // send /clear after update prompt
  sendInit: true,                // send /init after /clear
  completionConfirmMs: 10000,    // 10 seconds of silence after completion message
  noOutputTimeoutMs: 30000,      // 30 seconds fallback if no output at all
  autoAcceptPrompts: true,       // auto-accept plan mode prompts (not questions)
  autoAcceptDelayMs: 8000,       // 8 seconds before auto-accepting
  aiIdleCheckEnabled: true,      // use AI to confirm idle state
  aiIdleCheckModel: 'claude-opus-4-5-20251101',
  aiIdleCheckMaxContext: 16000,  // ~4k tokens
  aiIdleCheckTimeoutMs: 90000,   // 90 seconds (thinking can be slow)
  aiIdleCheckCooldownMs: 180000, // 3 minutes after WORKING verdict
};

/**
 * RespawnController - Automatic session cycling for continuous Claude work.
 *
 * Monitors a Claude Code session for idle state and automatically cycles
 * through update → clear → init steps to keep the session productive.
 *
 * ## How It Works
 *
 * 1. **Idle Detection**: Watches for completion message ("for Xm Xs" pattern)
 * 2. **Confirmation**: Waits for output silence (no new tokens for 5s)
 * 3. **Update**: Sends configured prompt (e.g., "update all docs")
 * 4. **Clear**: Sends `/clear` to reset context (optional)
 * 5. **Init**: Sends `/init` to re-initialize with CLAUDE.md (optional)
 * 6. **Kickstart**: If /init doesn't trigger work, sends fallback prompt (optional)
 * 7. **Repeat**: Returns to watching state for next cycle
 *
 * ## Idle Detection (Updated for Claude Code 2024+)
 *
 * Primary: Completion message with time duration (e.g., "✻ Worked for 2m 46s")
 * The pattern "for Xm Xs" indicates Claude finished work and reports duration.
 *
 * Confirmation: After seeing completion message, waits for output silence.
 * If no new output for `completionConfirmMs` (default 10s), confirms idle.
 *
 * Fallback: If no output at all for `noOutputTimeoutMs` (default 30s), assumes idle.
 *
 * Working indicators: Thinking, Writing, spinner characters, etc. reset detection.
 *
 * ## Events
 *
 * - `stateChanged`: State machine transition
 * - `respawnCycleStarted`: New cycle began
 * - `respawnCycleCompleted`: Cycle finished
 * - `stepSent`: Command sent to session
 * - `stepCompleted`: Step finished
 * - `log`: Debug messages
 *
 * @extends EventEmitter
 * @example
 * ```typescript
 * const respawn = new RespawnController(session, {
 *   updatePrompt: 'continue working on the task',
 *   completionConfirmMs: 10000,  // Wait 10s after completion message
 * });
 *
 * respawn.on('respawnCycleCompleted', (cycle) => {
 *   console.log(`Completed cycle ${cycle}`);
 * });
 *
 * respawn.start();
 * ```
 */
export class RespawnController extends EventEmitter {
  /** The session being controlled */
  private session: Session;

  /** Current configuration */
  private config: RespawnConfig;

  /** Current state machine state */
  private _state: RespawnState = 'stopped';

  /** Timer for idle detection timeout */
  private idleTimer: NodeJS.Timeout | null = null;

  /** Timer for step delays */
  private stepTimer: NodeJS.Timeout | null = null;

  /** Timer for completion confirmation (Layer 2) */
  private completionConfirmTimer: NodeJS.Timeout | null = null;

  /** Timer for no-output fallback (Layer 5) */
  private noOutputTimer: NodeJS.Timeout | null = null;

  /** Timer for periodic detection status updates */
  private detectionUpdateTimer: NodeJS.Timeout | null = null;

  /** Timer for auto-accepting plan mode prompts */
  private autoAcceptTimer: NodeJS.Timeout | null = null;

  /** Timer for pre-filter silence detection (triggers AI check) */
  private preFilterTimer: NodeJS.Timeout | null = null;

  /** Whether any terminal output has been received since start/last-auto-accept */
  private hasReceivedOutput: boolean = false;

  /** Whether an elicitation dialog (AskUserQuestion) was detected via hook signal */
  private elicitationDetected: boolean = false;

  /** Number of completed respawn cycles */
  private cycleCount: number = 0;

  /** Timestamp of last terminal activity */
  private lastActivityTime: number = 0;

  /** Buffer for recent terminal output (uses BufferAccumulator to reduce GC pressure) */
  private terminalBuffer = new BufferAccumulator(MAX_RESPAWN_BUFFER_SIZE, RESPAWN_BUFFER_TRIM_SIZE);

  /** Whether a prompt indicator was detected */
  private promptDetected: boolean = false;

  /** Whether a working indicator was detected */
  private workingDetected: boolean = false;

  /** Reference to terminal event handler (for cleanup) */
  private terminalHandler: ((data: string) => void) | null = null;

  /** AI idle checker instance */
  private aiChecker: AiIdleChecker;

  /** Timer for /clear step fallback (sends /init if no prompt detected) */
  private clearFallbackTimer: NodeJS.Timeout | null = null;

  /** Timer for step completion confirmation (waits for silence after completion) */
  private stepConfirmTimer: NodeJS.Timeout | null = null;

  /** Fallback timeout for /clear step (ms) - sends /init without waiting for prompt */
  private static readonly CLEAR_FALLBACK_TIMEOUT_MS = 10000;

  // ========== Multi-Layer Detection State ==========

  /** Layer 1: Timestamp when completion message was detected */
  private completionMessageTime: number | null = null;

  /** Layer 2: Timestamp of last terminal output received */
  private lastOutputTime: number = 0;

  /** Layer 3: Last observed token count */
  private lastTokenCount: number = 0;

  /** Layer 3: Timestamp when token count last changed */
  private lastTokenChangeTime: number = 0;

  /** Layer 4: Timestamp when last working pattern was seen */
  private lastWorkingPatternTime: number = 0;

  /**
   * Patterns indicating Claude is ready for input (legacy fallback).
   * Used as secondary signals, not primary detection.
   */
  private readonly PROMPT_PATTERNS = [
    '❯',        // Standard prompt
    '\u276f',   // Unicode variant
    '⏵',        // Claude Code prompt variant
  ];

  /**
   * Patterns indicating Claude is actively working.
   * When detected, resets all idle detection timers.
   * Note: ✻ and ✽ removed - they appear in completion messages too.
   */
  private readonly WORKING_PATTERNS = [
    'Thinking', 'Writing', 'Reading', 'Running', 'Searching',
    'Editing', 'Creating', 'Deleting', 'Analyzing', 'Executing',
    'Synthesizing', 'Brewing',  // Claude's processing indicators
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',  // Spinner chars
  ];

  /**
   * Creates a new RespawnController.
   *
   * @param session - The Session instance to control
   * @param config - Partial configuration (merged with defaults)
   */
  constructor(session: Session, config: Partial<RespawnConfig> = {}) {
    super();
    this.session = session;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.aiChecker = new AiIdleChecker(session.id, {
      enabled: this.config.aiIdleCheckEnabled,
      model: this.config.aiIdleCheckModel,
      maxContextChars: this.config.aiIdleCheckMaxContext,
      checkTimeoutMs: this.config.aiIdleCheckTimeoutMs,
      cooldownMs: this.config.aiIdleCheckCooldownMs,
    });
    this.setupAiCheckerListeners();
  }

  /** Wire up AI checker events to controller events */
  private setupAiCheckerListeners(): void {
    this.aiChecker.on('log', (message: string) => {
      this.log(message);
    });

    this.aiChecker.on('cooldownStarted', (endsAt: number) => {
      this.emit('aiCheckCooldown', true, endsAt);
    });

    this.aiChecker.on('cooldownEnded', () => {
      this.emit('aiCheckCooldown', false, null);
      // Restart pre-filter timer when cooldown expires so a new check can be triggered
      if (this._state === 'watching') {
        this.startPreFilterTimer();
      }
    });

    this.aiChecker.on('disabled', (reason: string) => {
      this.log(`AI checker disabled: ${reason}. Falling back to noOutputTimeoutMs.`);
    });
  }

  /**
   * Get the current state machine state.
   * @returns Current RespawnState
   */
  get state(): RespawnState {
    return this._state;
  }

  /**
   * Get the current respawn cycle count.
   * Increments each time a new cycle starts.
   * @returns Number of cycles started
   */
  get currentCycle(): number {
    return this.cycleCount;
  }

  /**
   * Check if the controller is currently running.
   * @returns True if state is not 'stopped'
   */
  get isRunning(): boolean {
    return this._state !== 'stopped';
  }

  /**
   * Get current detection status for UI display.
   * Shows all detection layers and their current state.
   * @returns DetectionStatus object
   */
  getDetectionStatus(): DetectionStatus {
    const now = Date.now();
    const msSinceLastOutput = now - this.lastOutputTime;
    const msSinceTokenChange = now - this.lastTokenChangeTime;
    const msSinceLastWorking = now - this.lastWorkingPatternTime;

    const completionMessageDetected = this.completionMessageTime !== null;
    const outputSilent = msSinceLastOutput >= this.config.completionConfirmMs;
    const tokensStable = msSinceTokenChange >= this.config.completionConfirmMs;
    const workingPatternsAbsent = msSinceLastWorking >= 3000; // 3s without working patterns

    // Calculate confidence level (0-100)
    let confidence = 0;
    if (completionMessageDetected) confidence += 40;
    if (outputSilent) confidence += 25;
    if (tokensStable) confidence += 20;
    if (workingPatternsAbsent) confidence += 15;

    // Determine status text and what we're waiting for
    let statusText: string;
    let waitingFor: string;

    if (this._state === 'stopped') {
      statusText = 'Controller stopped';
      waitingFor = 'Start to begin monitoring';
    } else if (this._state === 'ai_checking') {
      statusText = 'AI Check: Analyzing terminal output...';
      waitingFor = 'AI verdict (IDLE or WORKING)';
    } else if (this._state === 'confirming_idle') {
      statusText = `Confirming idle (${confidence}% confidence)`;
      waitingFor = `${Math.max(0, Math.ceil((this.config.completionConfirmMs - msSinceLastOutput) / 1000))}s more silence`;
    } else if (this._state === 'watching') {
      const aiState = this.aiChecker.getState();
      if (aiState.status === 'cooldown') {
        const remaining = Math.ceil(this.aiChecker.getCooldownRemainingMs() / 1000);
        statusText = `AI Check: WORKING (cooldown ${remaining}s)`;
        waitingFor = 'Cooldown to expire';
      } else if (completionMessageDetected) {
        statusText = 'Completion detected, confirming...';
        waitingFor = 'Output silence to confirm';
      } else if (workingPatternsAbsent && msSinceLastOutput > 5000) {
        statusText = 'No activity detected';
        waitingFor = 'Pre-filter conditions for AI check';
      } else {
        statusText = 'Watching for idle signals';
        waitingFor = 'Silence + no working patterns + tokens stable';
      }
    } else if (this._state.startsWith('waiting_') || this._state.startsWith('sending_')) {
      statusText = `Respawn step: ${this._state}`;
      waitingFor = 'Step completion';
    } else {
      statusText = `State: ${this._state}`;
      waitingFor = 'Next event';
    }

    return {
      completionMessageDetected,
      completionMessageTime: this.completionMessageTime,
      outputSilent,
      msSinceLastOutput,
      tokensStable,
      lastTokenCount: this.lastTokenCount,
      msSinceTokenChange,
      workingPatternsAbsent,
      msSinceLastWorking,
      aiCheck: this.config.aiIdleCheckEnabled ? this.aiChecker.getState() : null,
      confidenceLevel: confidence,
      statusText,
      waitingFor,
    };
  }

  /**
   * Start periodic detection status updates for UI.
   * Emits 'detectionUpdate' event every 500ms while running.
   */
  private startDetectionUpdates(): void {
    this.stopDetectionUpdates();
    this.detectionUpdateTimer = setInterval(() => {
      if (this._state !== 'stopped') {
        this.emit('detectionUpdate', this.getDetectionStatus());
      }
    }, 500);
  }

  /**
   * Stop periodic detection status updates.
   */
  private stopDetectionUpdates(): void {
    if (this.detectionUpdateTimer) {
      clearInterval(this.detectionUpdateTimer);
      this.detectionUpdateTimer = null;
    }
  }

  /**
   * Transition to a new state.
   * Emits 'stateChanged' event with old and new states.
   * No-op if already in the target state.
   *
   * @param newState - State to transition to
   * @fires stateChanged
   */
  private setState(newState: RespawnState): void {
    if (newState === this._state) return;

    const prevState = this._state;
    this._state = newState;
    this.log(`State: ${prevState} → ${newState}`);
    this.emit('stateChanged', newState, prevState);
  }

  /**
   * Emit a timestamped log message.
   * @param message - Log message content
   * @fires log
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.emit('log', `[${timestamp}] [Respawn] ${message}`);
  }

  /**
   * Start watching the session for idle state.
   *
   * Begins monitoring terminal output for idle indicators.
   * When idle is detected, starts the respawn cycle.
   *
   * No-op if:
   * - `config.enabled` is false
   * - Already running (state !== 'stopped')
   *
   * @fires stateChanged - Transitions to 'watching'
   */
  start(): void {
    if (!this.config.enabled) {
      this.log('Respawn is disabled');
      return;
    }

    if (this._state !== 'stopped') {
      this.log('Already running');
      return;
    }

    this.log('Starting respawn controller (multi-layer detection)');

    // Initialize all timestamps
    const now = Date.now();
    this.lastActivityTime = now;
    this.lastOutputTime = now;
    this.lastTokenChangeTime = now;
    this.lastWorkingPatternTime = now;
    this.completionMessageTime = null;
    this.hasReceivedOutput = false;

    // Seed the terminal buffer from the session's existing output.
    // This gives the AI checker context even if no new output arrives.
    const existingBuffer = this.session.terminalBuffer;
    if (existingBuffer) {
      this.terminalBuffer.clear();
      this.terminalBuffer.append(existingBuffer);
    }

    this.aiChecker.reset();
    this.setState('watching');
    this.setupTerminalListener();
    this.startDetectionUpdates();
    this.startNoOutputTimer();
    this.startPreFilterTimer();
    if (this.config.autoAcceptPrompts) {
      this.startAutoAcceptTimer();
    }
  }

  /**
   * Stop the respawn controller.
   *
   * Clears all timers, removes terminal listener, and sets state to 'stopped'.
   * Safe to call multiple times.
   *
   * @fires stateChanged - Transitions to 'stopped'
   */
  stop(): void {
    this.log('Stopping respawn controller');
    this.aiChecker.cancel();
    this.clearTimers();
    this.stopDetectionUpdates();
    this.setState('stopped');
    if (this.terminalHandler) {
      this.session.off('terminal', this.terminalHandler);
      this.terminalHandler = null;
    }
  }

  /**
   * Pause respawn without stopping.
   *
   * Clears timers but keeps listening to terminal.
   * State is preserved; won't trigger idle detection while paused.
   * Use resume() to continue.
   */
  pause(): void {
    this.log('Pausing respawn');
    this.clearTimers();
    // Stay in current state but clear timers
  }

  /**
   * Resume respawn after pause.
   *
   * If in 'watching' state, immediately checks for idle condition.
   * Otherwise, continues from current state.
   */
  resume(): void {
    this.log('Resuming respawn');
    if (this._state === 'watching') {
      this.checkIdleAndMaybeStart();
    }
  }

  /**
   * Set up terminal output listener on the session.
   * Removes any previous listener first to avoid duplicates.
   */
  private setupTerminalListener(): void {
    // Remove our previous listener if any (don't remove other listeners!)
    if (this.terminalHandler) {
      this.session.off('terminal', this.terminalHandler);
    }

    this.terminalHandler = (data: string) => {
      this.handleTerminalData(data);
    };
    this.session.on('terminal', this.terminalHandler);
  }

  /**
   * Process terminal data for idle/working detection using multi-layer approach.
   *
   * Detection Layers:
   * 1. Completion message ("for Xm Xs") - PRIMARY signal
   * 2. Output silence - confirms completion
   * 3. Token stability - additional confirmation
   * 4. Working pattern absence - supports idle detection
   * 5. No-output fallback - catches edge cases
   *
   * @param data - Raw terminal output data
   */
  private handleTerminalData(data: string): void {
    // Guard against null/undefined/empty data
    if (!data || typeof data !== 'string') {
      return;
    }

    const now = Date.now();

    // BufferAccumulator handles auto-trimming when max size exceeded
    this.terminalBuffer.append(data);

    // Track output time (Layer 2)
    this.lastOutputTime = now;
    this.lastActivityTime = now;
    this.hasReceivedOutput = true;
    this.resetNoOutputTimer();
    this.resetPreFilterTimer();
    this.resetAutoAcceptTimer();

    // Track token count (Layer 3)
    const tokenCount = this.extractTokenCount(data);
    if (tokenCount !== null && tokenCount !== this.lastTokenCount) {
      this.lastTokenCount = tokenCount;
      this.lastTokenChangeTime = now;
    }

    // Detect working patterns (Layer 4)
    const isWorking = this.hasWorkingPattern(data);
    if (isWorking) {
      this.workingDetected = true;
      this.promptDetected = false;
      this.elicitationDetected = false; // Clear on new work cycle
      this.lastWorkingPatternTime = now;
      this.clearIdleTimer();

      // Cancel any pending completion confirmation
      this.cancelCompletionConfirm();

      // Cancel any pending step confirmation (Claude is still working)
      this.cancelStepConfirm();

      // If AI check is running, cancel it (Claude is working)
      if (this._state === 'ai_checking') {
        this.log('Working patterns detected during AI check, cancelling');
        this.aiChecker.cancel();
        this.setState('watching');
      }

      // If we're monitoring init and work started, go to watching (no kickstart needed)
      if (this._state === 'monitoring_init') {
        this.log('/init triggered work, skipping kickstart');
        this.emit('stepCompleted', 'init');
        this.completeCycle();
      }
      return;
    }

    // Detect completion message (Layer 1) - PRIMARY DETECTION
    if (this.isCompletionMessage(data)) {
      this.completionMessageTime = now;
      this.workingDetected = false;
      this.cancelAutoAcceptTimer(); // Normal idle flow handles this
      this.log(`Completion message detected: "${data.trim().substring(0, 50)}..."`);

      // In watching state, start completion confirmation timer
      if (this._state === 'watching') {
        this.startCompletionConfirmTimer();
        return;
      }

      // In waiting states, also use confirmation timer (same detection logic)
      // This ensures we wait for Claude to finish before proceeding
      switch (this._state) {
        case 'waiting_update':
          this.startStepConfirmTimer('update');
          break;
        case 'waiting_clear':
          this.checkClearComplete(); // /clear is quick, no need to wait
          break;
        case 'waiting_init':
          this.startStepConfirmTimer('init');
          break;
        case 'waiting_kickstart':
          this.startStepConfirmTimer('kickstart');
          break;
      }
      return;
    }

    // In confirming_idle or ai_checking state, substantial output cancels the flow.
    // This prevents false triggers when Claude pauses briefly mid-work.
    if (this._state === 'confirming_idle' || this._state === 'ai_checking') {
      // Strip ANSI escape codes to check if there's real content
      const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (stripped.length > 2) {
        if (this._state === 'ai_checking') {
          this.log(`Substantial output during AI check ("${stripped.substring(0, 40)}..."), cancelling`);
          this.aiChecker.cancel();
          this.setState('watching');
        } else {
          // Real content (not just escape codes or single chars) - cancel confirmation
          this.log(`Substantial output during confirmation ("${stripped.substring(0, 40)}..."), cancelling idle detection`);
          this.cancelCompletionConfirm();
        }
        return;
      }
    }

    // Legacy fallback: detect prompt characters (still useful for waiting_* states)
    const hasPrompt = this.PROMPT_PATTERNS.some(pattern => data.includes(pattern));
    if (hasPrompt) {
      this.promptDetected = true;
      this.workingDetected = false;

      // Handle legacy detection in waiting states - also use confirmation timers
      switch (this._state) {
        case 'waiting_update':
          this.startStepConfirmTimer('update');
          break;
        case 'waiting_clear':
          this.checkClearComplete(); // /clear is quick, no need to wait
          break;
        case 'waiting_init':
          this.startStepConfirmTimer('init');
          break;
        case 'monitoring_init':
          this.checkMonitoringInitIdle();
          break;
        case 'waiting_kickstart':
          this.startStepConfirmTimer('kickstart');
          break;
      }
    }
  }

  /**
   * Handle update step completion.
   * Called when ready indicator detected in waiting_update state.
   * Proceeds to clear, init, or completes cycle based on config.
   * @fires stepCompleted - With step 'update'
   */
  private checkUpdateComplete(): void {
    this.clearIdleTimer();
    this.log('Update completed (ready indicator)');
    this.emit('stepCompleted', 'update');

    if (this.config.sendClear) {
      this.sendClear();
    } else if (this.config.sendInit) {
      this.sendInit();
    } else {
      this.completeCycle();
    }
  }

  /**
   * Handle /clear step completion.
   * Proceeds to init or completes cycle based on config.
   * @fires stepCompleted - With step 'clear'
   */
  private checkClearComplete(): void {
    this.clearIdleTimer();
    // Clear the fallback timer since we got prompt detection
    if (this.clearFallbackTimer) {
      clearTimeout(this.clearFallbackTimer);
      this.clearFallbackTimer = null;
    }
    this.log('/clear completed (ready indicator)');
    this.emit('stepCompleted', 'clear');

    if (this.config.sendInit) {
      this.sendInit();
    } else {
      this.completeCycle();
    }
  }

  /**
   * Handle /init step completion.
   * If kickstart is configured, monitors for work.
   * Otherwise completes cycle.
   * @fires stepCompleted - With step 'init' (if no kickstart)
   */
  private checkInitComplete(): void {
    this.clearIdleTimer();
    this.log('/init completed (ready indicator)');

    // If kickstart prompt is configured, monitor to see if /init triggered work
    if (this.config.kickstartPrompt) {
      this.startMonitoringInit();
    } else {
      this.emit('stepCompleted', 'init');
      this.completeCycle();
    }
  }

  /**
   * Start monitoring to see if /init triggered work.
   * Enters 'monitoring_init' state and waits 3s grace period.
   * If no work detected, sends kickstart prompt.
   */
  private startMonitoringInit(): void {
    this.setState('monitoring_init');
    this.terminalBuffer.clear();
    this.workingDetected = false;
    this.log('Monitoring if /init triggered work...');

    // Give Claude a moment to start working before checking for idle
    this.stepTimer = setTimeout(() => {
      // If still in monitoring state and no work detected, consider it idle
      if (this._state === 'monitoring_init' && !this.workingDetected) {
        this.checkMonitoringInitIdle();
      }
    }, 3000); // 3 second grace period for /init to trigger work
  }

  /**
   * Handle monitoring timeout when /init didn't trigger work.
   * Sends kickstart prompt as fallback.
   * @fires stepCompleted - With step 'init'
   */
  private checkMonitoringInitIdle(): void {
    this.clearIdleTimer();
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    this.log('/init did not trigger work, sending kickstart prompt');
    this.emit('stepCompleted', 'init');
    this.sendKickstart();
  }

  /**
   * Send the kickstart prompt to get Claude working.
   * @fires stepSent - With step 'kickstart'
   */
  private sendKickstart(): void {
    this.setState('sending_kickstart');
    this.terminalBuffer.clear();

    this.stepTimer = setTimeout(() => {
      const prompt = this.config.kickstartPrompt!;
      this.log(`Sending kickstart prompt: "${prompt}"`);
      this.session.writeViaScreen(prompt + '\r');  // \r triggers key.return in Ink/Claude CLI
      this.emit('stepSent', 'kickstart', prompt);
      this.setState('waiting_kickstart');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  /**
   * Handle kickstart step completion.
   * @fires stepCompleted - With step 'kickstart'
   */
  private checkKickstartComplete(): void {
    this.clearIdleTimer();
    this.log('Kickstart completed (ready indicator)');
    this.emit('stepCompleted', 'kickstart');
    this.completeCycle();
  }

  // Note: Legacy startIdleTimer removed - now using completion-based detection
  // with startCompletionConfirmTimer() and startNoOutputTimer() instead.

  /** Clear the idle detection timer if running (legacy cleanup) */
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Clear all timers (idle, step, completion confirm, no-output, pre-filter, step confirm, auto-accept, and clear fallback) */
  private clearTimers(): void {
    this.clearIdleTimer();
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
    if (this.clearFallbackTimer) {
      clearTimeout(this.clearFallbackTimer);
      this.clearFallbackTimer = null;
    }
    if (this.completionConfirmTimer) {
      clearTimeout(this.completionConfirmTimer);
      this.completionConfirmTimer = null;
    }
    if (this.stepConfirmTimer) {
      clearTimeout(this.stepConfirmTimer);
      this.stepConfirmTimer = null;
    }
    if (this.autoAcceptTimer) {
      clearTimeout(this.autoAcceptTimer);
      this.autoAcceptTimer = null;
    }
    if (this.preFilterTimer) {
      clearTimeout(this.preFilterTimer);
      this.preFilterTimer = null;
    }
    if (this.noOutputTimer) {
      clearTimeout(this.noOutputTimer);
      this.noOutputTimer = null;
    }
  }

  // ========== Multi-Layer Detection Methods ==========

  /**
   * Check if data contains a completion message pattern.
   * Matches "for Xh Xm Xs" time duration patterns.
   */
  private isCompletionMessage(data: string): boolean {
    return COMPLETION_TIME_PATTERN.test(data);
  }

  /**
   * Check if data contains working patterns.
   */
  private hasWorkingPattern(data: string): boolean {
    return this.WORKING_PATTERNS.some(pattern => data.includes(pattern));
  }

  /**
   * Extract token count from data if present.
   * Returns null if no token pattern found.
   */
  private extractTokenCount(data: string): number | null {
    const match = data.match(TOKEN_PATTERN);
    if (!match) return null;

    let count = parseFloat(match[1]);
    const suffix = match[2]?.toLowerCase();
    if (suffix === 'k') count *= 1000;
    else if (suffix === 'm') count *= 1000000;

    return Math.round(count);
  }

  /**
   * Start the no-output fallback timer.
   * If no output for noOutputTimeoutMs, triggers idle detection as safety net
   * (used when AI check is disabled or has too many errors).
   */
  private startNoOutputTimer(): void {
    if (this.noOutputTimer) {
      clearTimeout(this.noOutputTimer);
    }
    this.noOutputTimer = setTimeout(() => {
      if (this._state === 'watching' || this._state === 'confirming_idle') {
        const msSinceOutput = Date.now() - this.lastOutputTime;
        this.log(`No-output fallback triggered (${msSinceOutput}ms since last output)`);
        // If AI check is disabled or errored out, go directly to idle
        if (!this.config.aiIdleCheckEnabled || this.aiChecker.status === 'disabled') {
          this.onIdleConfirmed('no-output fallback (AI check disabled)');
        } else {
          this.tryStartAiCheck('no-output fallback');
        }
      }
    }, this.config.noOutputTimeoutMs);
  }

  /**
   * Reset the no-output fallback timer.
   * Called whenever output is received.
   */
  private resetNoOutputTimer(): void {
    this.startNoOutputTimer();
  }

  // ========== Pre-Filter & AI Check Methods ==========

  /**
   * Start the pre-filter timer.
   * Fires after completionConfirmMs of silence. When it fires, checks if
   * all pre-filter conditions are met and starts the AI check if so.
   * This provides an additional path to AI check even without a completion message.
   */
  private startPreFilterTimer(): void {
    if (this.preFilterTimer) {
      clearTimeout(this.preFilterTimer);
    }
    // Only set up pre-filter when AI check is enabled
    if (!this.config.aiIdleCheckEnabled) return;

    this.preFilterTimer = setTimeout(() => {
      if (this._state === 'watching') {
        const now = Date.now();
        const msSinceOutput = now - this.lastOutputTime;
        const msSinceWorking = now - this.lastWorkingPatternTime;
        const msSinceTokenChange = now - this.lastTokenChangeTime;

        // Check pre-filter conditions
        const silenceMet = msSinceOutput >= this.config.completionConfirmMs;
        const noWorkingMet = msSinceWorking >= 3000;
        const tokensStableMet = msSinceTokenChange >= this.config.completionConfirmMs;

        if (silenceMet && noWorkingMet && tokensStableMet) {
          this.log(`Pre-filter conditions met: silence=${msSinceOutput}ms, noWorking=${msSinceWorking}ms, tokensStable=${msSinceTokenChange}ms`);
          this.tryStartAiCheck('pre-filter');
        }
      }
    }, this.config.completionConfirmMs);
  }

  /**
   * Reset the pre-filter timer.
   * Called whenever output is received.
   */
  private resetPreFilterTimer(): void {
    this.startPreFilterTimer();
  }

  /**
   * Attempt to start an AI idle check.
   * Checks if AI check is enabled, not on cooldown, and not already checking.
   * Falls back to direct idle confirmation if AI check is unavailable.
   *
   * @param reason - What triggered this attempt (for logging)
   */
  private tryStartAiCheck(reason: string): void {
    // If AI check is disabled or errored out, fall back to direct idle confirmation
    if (!this.config.aiIdleCheckEnabled || this.aiChecker.status === 'disabled') {
      this.log(`AI check unavailable (${this.aiChecker.status}), confirming idle directly via: ${reason}`);
      this.onIdleConfirmed(reason);
      return;
    }

    // If on cooldown, don't start check - wait for cooldown to expire
    if (this.aiChecker.isOnCooldown()) {
      this.log(`AI check on cooldown (${Math.ceil(this.aiChecker.getCooldownRemainingMs() / 1000)}s remaining), waiting...`);
      return;
    }

    // If already checking, don't start another
    if (this.aiChecker.status === 'checking') {
      this.log('AI check already in progress');
      return;
    }

    // Start the AI check
    this.startAiCheck(reason);
  }

  /**
   * Start the AI idle check.
   * Transitions to 'ai_checking' state and runs the check asynchronously.
   *
   * @param reason - What triggered this check (for logging)
   */
  private startAiCheck(reason: string): void {
    this.setState('ai_checking');
    this.log(`Starting AI idle check (triggered by: ${reason})`);
    this.emit('aiCheckStarted');

    // Get the terminal buffer for analysis
    const buffer = this.terminalBuffer.value;

    this.aiChecker.check(buffer).then((result) => {
      // If state changed while checking (e.g., cancelled), ignore result
      if (this._state !== 'ai_checking') {
        this.log(`AI check result ignored (state is now ${this._state})`);
        return;
      }

      if (result.verdict === 'IDLE') {
        this.emit('aiCheckCompleted', result);
        this.onIdleConfirmed(`ai-check: idle (${result.reasoning})`);
      } else if (result.verdict === 'WORKING') {
        this.emit('aiCheckCompleted', result);
        this.setState('watching');
        this.log(`AI check says WORKING, returning to watching with ${this.config.aiIdleCheckCooldownMs}ms cooldown`);
        // Restart timers so the controller retries after cooldown expires
        this.startNoOutputTimer();
        this.startPreFilterTimer();
      } else {
        // ERROR verdict
        this.emit('aiCheckFailed', result.reasoning);
        this.setState('watching');
        // Restart timers to allow retry
        this.startNoOutputTimer();
        this.startPreFilterTimer();
      }
    }).catch((err) => {
      if (this._state === 'ai_checking') {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.emit('aiCheckFailed', errorMsg);
        this.setState('watching');
        this.log(`AI check error: ${errorMsg}`);
        // Restart timers to allow retry
        this.startNoOutputTimer();
        this.startPreFilterTimer();
      }
    });
  }

  // ========== Auto-Accept Prompt Methods ==========

  /**
   * Reset the auto-accept timer.
   * Called whenever output is received. After autoAcceptDelayMs of silence
   * (without a completion message), sends Enter to accept prompts.
   */
  private resetAutoAcceptTimer(): void {
    if (!this.config.autoAcceptPrompts) return;
    this.startAutoAcceptTimer();
  }

  /**
   * Start the auto-accept timer.
   * Fires after autoAcceptDelayMs of no output when no completion message
   * and no elicitation dialog was detected. Only handles plan mode approvals.
   */
  private startAutoAcceptTimer(): void {
    if (this.autoAcceptTimer) {
      clearTimeout(this.autoAcceptTimer);
    }
    this.autoAcceptTimer = setTimeout(() => {
      this.autoAcceptTimer = null;
      this.tryAutoAccept();
    }, this.config.autoAcceptDelayMs);
  }

  /**
   * Cancel the auto-accept timer.
   * Called when a completion message is detected (normal idle flow handles it).
   */
  private cancelAutoAcceptTimer(): void {
    if (this.autoAcceptTimer) {
      clearTimeout(this.autoAcceptTimer);
      this.autoAcceptTimer = null;
    }
  }

  /**
   * Attempt to auto-accept a plan mode prompt by sending Enter.
   * Only fires when:
   * - In 'watching' state (not mid-cycle)
   * - No completion message was detected (Claude is waiting for input, not truly idle)
   * - No elicitation dialog was detected (not an AskUserQuestion prompt)
   * - autoAcceptPrompts is enabled
   *
   * This handles Claude's plan mode (waiting for approval) by pressing Enter
   * to accept the plan. It does NOT auto-accept AskUserQuestion prompts -
   * those require explicit user interaction.
   *
   * @fires autoAcceptSent
   */
  private tryAutoAccept(): void {
    // Only auto-accept in watching state (not during a respawn cycle)
    if (this._state !== 'watching') return;

    // Don't auto-accept if a completion message was detected (normal idle handles it)
    if (this.completionMessageTime !== null) return;

    // Don't auto-accept if disabled
    if (!this.config.autoAcceptPrompts) return;

    // Don't auto-accept if we haven't received any output yet (prevents spurious Enter on fresh start)
    if (!this.hasReceivedOutput) return;

    // Don't auto-accept if an elicitation dialog (AskUserQuestion) was detected
    if (this.elicitationDetected) {
      this.log('Skipping auto-accept: elicitation dialog detected (AskUserQuestion)');
      return;
    }

    const msSinceOutput = Date.now() - this.lastOutputTime;
    this.log(`Auto-accepting plan mode prompt (${msSinceOutput}ms silence, no completion message, no elicitation)`);

    // Send Enter to accept the plan
    this.session.writeViaScreen('\r');
    this.emit('autoAcceptSent');

    // Reset so we don't keep spamming Enter if Claude doesn't respond
    this.hasReceivedOutput = false;
  }

  /**
   * Signal that an elicitation dialog (AskUserQuestion) was detected via hook.
   * This prevents auto-accept from firing, since the user needs to make a selection.
   * The flag is cleared when working patterns are detected (new turn starts).
   */
  signalElicitation(): void {
    this.elicitationDetected = true;
    this.cancelAutoAcceptTimer();
    this.log('Elicitation dialog signaled - auto-accept blocked until next work cycle');
  }

  /**
   * Start completion confirmation timer.
   * After completion message, waits for output silence then triggers AI check.
   */
  private startCompletionConfirmTimer(): void {
    if (this.completionConfirmTimer) {
      clearTimeout(this.completionConfirmTimer);
    }

    this.setState('confirming_idle');
    this.log(`Completion message detected, waiting ${this.config.completionConfirmMs}ms for silence...`);

    this.completionConfirmTimer = setTimeout(() => {
      const msSinceOutput = Date.now() - this.lastOutputTime;
      if (msSinceOutput >= this.config.completionConfirmMs) {
        this.log(`Silence confirmed after completion message (${msSinceOutput}ms)`);
        this.tryStartAiCheck('completion + silence');
      } else {
        // Output received during wait, stay in confirming state and re-check
        this.log(`Output received during confirmation, resetting timer`);
        this.startCompletionConfirmTimer();
      }
    }, this.config.completionConfirmMs);
  }

  /**
   * Cancel completion confirmation if new activity detected.
   */
  private cancelCompletionConfirm(): void {
    if (this.completionConfirmTimer) {
      clearTimeout(this.completionConfirmTimer);
      this.completionConfirmTimer = null;
    }
    if (this._state === 'confirming_idle') {
      this.setState('watching');
      this.completionMessageTime = null;
    }
  }

  /**
   * Start step confirmation timer for waiting states.
   * Waits for output silence before proceeding to next step.
   * This ensures Claude has finished processing before we send the next command.
   */
  private startStepConfirmTimer(step: 'update' | 'init' | 'kickstart'): void {
    // Clear any existing step confirm timer
    if (this.stepConfirmTimer) {
      clearTimeout(this.stepConfirmTimer);
    }

    this.log(`Step '${step}' completion detected, waiting ${this.config.completionConfirmMs}ms for silence...`);

    this.stepConfirmTimer = setTimeout(() => {
      const msSinceOutput = Date.now() - this.lastOutputTime;

      if (msSinceOutput >= this.config.completionConfirmMs) {
        this.log(`Step '${step}' confirmed: ${msSinceOutput}ms silence`);
        this.stepConfirmTimer = null;
  

        // Proceed with the step completion
        switch (step) {
          case 'update':
            this.checkUpdateComplete();
            break;
          case 'init':
            this.checkInitComplete();
            break;
          case 'kickstart':
            this.checkKickstartComplete();
            break;
        }
      } else {
        // Output received during wait, restart timer
        this.log(`Output during step confirmation, resetting timer`);
        this.startStepConfirmTimer(step);
      }
    }, this.config.completionConfirmMs);
  }

  /**
   * Cancel step confirmation if working patterns detected.
   */
  private cancelStepConfirm(): void {
    if (this.stepConfirmTimer) {
      clearTimeout(this.stepConfirmTimer);
      this.stepConfirmTimer = null;
      this.log(`Step confirmation cancelled (working detected)`);
    }
  }

  /**
   * Called when idle is confirmed through any detection layer.
   * @param reason - What triggered the confirmation
   */
  private onIdleConfirmed(reason: string): void {
    this.log(`Idle confirmed via: ${reason}`);
    const status = this.getDetectionStatus();
    this.log(`Detection status: confidence=${status.confidenceLevel}%, ` +
      `completion=${status.completionMessageDetected}, ` +
      `silent=${status.outputSilent}, ` +
      `tokensStable=${status.tokensStable}, ` +
      `noWorking=${status.workingPatternsAbsent}`);

    // Reset detection state
    this.completionMessageTime = null;
    this.cancelCompletionConfirm();

    // Trigger the respawn cycle
    this.onIdleDetected();
  }

  /**
   * Handle confirmed idle detection.
   * Starts a new respawn cycle.
   * @fires respawnCycleStarted
   */
  private onIdleDetected(): void {
    // Accept watching, confirming_idle, and ai_checking states
    if (this._state !== 'watching' && this._state !== 'confirming_idle' && this._state !== 'ai_checking') {
      return;
    }

    // Start the respawn cycle
    this.cycleCount++;
    this.log(`Starting respawn cycle #${this.cycleCount}`);
    this.emit('respawnCycleStarted', this.cycleCount);

    this.sendUpdateDocs();
  }

  /**
   * Send the update docs prompt (first step of cycle).
   * @fires stepSent - With step 'update'
   */
  private sendUpdateDocs(): void {
    this.setState('sending_update');
    this.terminalBuffer.clear(); // Clear buffer for fresh detection

    this.stepTimer = setTimeout(() => {
      const input = this.config.updatePrompt + '\r';  // \r triggers Enter in Ink/Claude CLI
      this.log(`Sending update prompt: "${this.config.updatePrompt}"`);
      this.session.writeViaScreen(input);
      this.emit('stepSent', 'update', this.config.updatePrompt);
      this.setState('waiting_update');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  /**
   * Send /clear command.
   * Starts a 10-second fallback timer - if no prompt is detected after /clear,
   * proceeds to /init anyway (workaround for when Claude doesn't show prompt after /clear).
   * @fires stepSent - With step 'clear'
   */
  private sendClear(): void {
    this.setState('sending_clear');
    this.terminalBuffer.clear();

    this.stepTimer = setTimeout(() => {
      this.log('Sending /clear');
      this.session.writeViaScreen('/clear\r');  // \r triggers Enter in Ink/Claude CLI
      this.emit('stepSent', 'clear', '/clear');
      this.setState('waiting_clear');
      this.promptDetected = false;

      // Start fallback timer - if no prompt detected after 10s, proceed to /init anyway
      this.clearFallbackTimer = setTimeout(() => {
        if (this._state === 'waiting_clear') {
          this.log('/clear fallback: no prompt detected after 10s, proceeding to /init');
          this.emit('stepCompleted', 'clear');
          if (this.config.sendInit) {
            this.sendInit();
          } else {
            this.completeCycle();
          }
        }
      }, RespawnController.CLEAR_FALLBACK_TIMEOUT_MS);
    }, this.config.interStepDelayMs);
  }

  /**
   * Send /init command.
   * @fires stepSent - With step 'init'
   */
  private sendInit(): void {
    this.setState('sending_init');
    this.terminalBuffer.clear();

    this.stepTimer = setTimeout(() => {
      this.log('Sending /init');
      this.session.writeViaScreen('/init\r');  // \r triggers Enter in Ink/Claude CLI
      this.emit('stepSent', 'init', '/init');
      this.setState('waiting_init');
      this.promptDetected = false;
      this.workingDetected = false;
    }, this.config.interStepDelayMs);
  }

  /**
   * Complete the current respawn cycle.
   * Returns to watching state for next cycle.
   * @fires respawnCycleCompleted
   */
  private completeCycle(): void {
    this.log(`Respawn cycle #${this.cycleCount} completed`);
    this.emit('respawnCycleCompleted', this.cycleCount);

    // Go back to watching state for next cycle
    this.setState('watching');
    this.terminalBuffer.clear();
    this.promptDetected = false;
    this.workingDetected = false;
  }

  /**
   * Check if already idle and start cycle if so.
   * Used when resuming from pause.
   */
  private checkIdleAndMaybeStart(): void {
    // Check if already idle
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > this.config.idleTimeoutMs && this.promptDetected) {
      this.onIdleDetected();
    }
  }

  /**
   * Update configuration at runtime.
   *
   * Merges provided config with existing config.
   * Takes effect immediately for new operations.
   *
   * @param config - Partial configuration to merge
   * @fires log - With updated config details
   */
  updateConfig(config: Partial<RespawnConfig>): void {
    this.config = { ...this.config, ...config };

    // Sync AI checker config if relevant fields changed
    if (config.aiIdleCheckEnabled !== undefined || config.aiIdleCheckModel !== undefined ||
        config.aiIdleCheckMaxContext !== undefined || config.aiIdleCheckTimeoutMs !== undefined ||
        config.aiIdleCheckCooldownMs !== undefined) {
      this.aiChecker.updateConfig({
        enabled: this.config.aiIdleCheckEnabled,
        model: this.config.aiIdleCheckModel,
        maxContextChars: this.config.aiIdleCheckMaxContext,
        checkTimeoutMs: this.config.aiIdleCheckTimeoutMs,
        cooldownMs: this.config.aiIdleCheckCooldownMs,
      });
    }

    this.log(`Config updated: ${JSON.stringify(config)}`);
  }

  /**
   * Get current configuration.
   * @returns Copy of current config (safe to modify)
   */
  getConfig(): RespawnConfig {
    return { ...this.config };
  }

  /**
   * Get comprehensive status information.
   *
   * Useful for debugging and monitoring.
   *
   * @returns Status object with:
   *   - state: Current state machine state
   *   - cycleCount: Number of cycles started
   *   - lastActivityTime: Timestamp of last activity
   *   - timeSinceActivity: Milliseconds since last activity
   *   - promptDetected: Whether prompt indicator seen
   *   - workingDetected: Whether working indicator seen
   *   - detection: Multi-layer detection status
   *   - config: Current configuration
   */
  getStatus() {
    return {
      state: this._state,
      cycleCount: this.cycleCount,
      lastActivityTime: this.lastActivityTime,
      timeSinceActivity: Date.now() - this.lastActivityTime,
      promptDetected: this.promptDetected,
      workingDetected: this.workingDetected,
      detection: this.getDetectionStatus(),
      config: this.config,
    };
  }
}
