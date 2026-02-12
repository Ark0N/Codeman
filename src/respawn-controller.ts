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
import { randomUUID } from 'node:crypto';
import { Session } from './session.js';
import { AiIdleChecker, type AiCheckResult, type AiCheckState } from './ai-idle-checker.js';
import { AiPlanChecker, type AiPlanCheckResult } from './ai-plan-checker.js';
import { BufferAccumulator } from './utils/buffer-accumulator.js';
import {
  ANSI_ESCAPE_PATTERN_SIMPLE,
  TOKEN_PATTERN,
  assertNever,
} from './utils/index.js';
import {
  MAX_RESPAWN_BUFFER_SIZE,
  TRIM_RESPAWN_BUFFER_TO as RESPAWN_BUFFER_TRIM_SIZE,
} from './config/buffer-limits.js';
import type {
  RespawnCycleMetrics,
  RespawnAggregateMetrics,
  RalphLoopHealthScore,
  TimingHistory,
  CycleOutcome,
  HealthStatus,
} from './types.js';

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

/** Pre-filter: numbered option pattern for plan mode detection */
const PLAN_MODE_OPTION_PATTERN = /\d+\.\s+(Yes|No|Type|Cancel|Skip|Proceed|Approve|Reject)/i;

/** Pre-filter: selection indicator arrow for plan mode detection */
const PLAN_MODE_SELECTOR_PATTERN = /[❯>]\s*\d+\./;

// Note: The old '↵ send' indicator is no longer reliable in Claude Code 2024+
// Detection now uses completion message patterns ("for Xm Xs") instead.

// ========== Detection Layer Types ==========

/**
 * Detection layers for multi-signal idle detection.
 * Each layer provides a confidence signal that Claude has finished working.
 */
/** Active timer info for UI display */
export interface ActiveTimerInfo {
  name: string;
  remainingMs: number;
  totalMs: number;
}

export interface DetectionStatus {
  /** Layer 0: Stop hook received (highest priority - definitive signal) */
  stopHookReceived: boolean;
  /** Timestamp when Stop hook was received */
  stopHookTime: number | null;
  /** Layer 0: idle_prompt notification received (definitive signal) */
  idlePromptReceived: boolean;
  /** Timestamp when idle_prompt was received */
  idlePromptTime: number | null;

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

  /** Active countdown timers */
  activeTimers: ActiveTimerInfo[];

  /** Recent action log entries (last 10) */
  recentActions: ActionLogEntry[];

  /** Current phase description */
  currentPhase: string;

  /** Next expected action */
  nextAction: string;

  /** Stuck-state detection metrics */
  stuckState: {
    /** How long the controller has been in the current state (ms) */
    currentStateDurationMs: number;
    /** Warning threshold (ms) */
    warningThresholdMs: number;
    /** Recovery threshold (ms) */
    recoveryThresholdMs: number;
    /** Number of recovery attempts made */
    recoveryAttempts: number;
    /** Maximum allowed recoveries */
    maxRecoveries: number;
    /** Whether a warning has been emitted for current state */
    isWarned: boolean;
  };
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

  /**
   * Whether AI plan mode check is enabled for auto-accept.
   * When enabled, spawns a fresh Claude CLI to confirm the terminal is
   * showing a plan mode approval prompt before auto-accepting.
   * @default true
   */
  aiPlanCheckEnabled: boolean;

  /**
   * Model to use for AI plan mode check.
   * @default 'claude-opus-4-5-20251101' (thinking enabled by default)
   */
  aiPlanCheckModel: string;

  /**
   * Maximum characters of terminal buffer to send to plan checker.
   * @default 8000
   */
  aiPlanCheckMaxContext: number;

  /**
   * Timeout for the AI plan check in ms.
   * @default 60000 (60 seconds, allows time for thinking)
   */
  aiPlanCheckTimeoutMs: number;

  /**
   * Cooldown after NOT_PLAN_MODE verdict in ms.
   * @default 30000 (30 seconds)
   */
  aiPlanCheckCooldownMs: number;

  /**
   * Enable stuck-state detection.
   * Detects when the controller stays in the same state for too long.
   * @default true
   */
  stuckStateDetectionEnabled: boolean;

  /**
   * Threshold for stuck-state warning in ms.
   * If state doesn't change for this duration, emits a warning.
   * @default 300000 (5 minutes)
   */
  stuckStateWarningMs: number;

  /**
   * Threshold for stuck-state recovery in ms.
   * If state doesn't change for this duration, triggers recovery action.
   * @default 600000 (10 minutes)
   */
  stuckStateRecoveryMs: number;

  /**
   * Maximum consecutive stuck-state recoveries before giving up.
   * @default 3
   */
  maxStuckRecoveries: number;

  // ========== P2-001: Adaptive Timing ==========

  /**
   * Enable adaptive timing based on historical patterns.
   * Adjusts completion confirm timeout dynamically.
   * @default true
   */
  adaptiveTimingEnabled?: boolean;

  /**
   * Minimum adaptive completion confirm timeout (ms).
   * @default 5000
   */
  adaptiveMinConfirmMs?: number;

  /**
   * Maximum adaptive completion confirm timeout (ms).
   * @default 30000
   */
  adaptiveMaxConfirmMs?: number;

  // ========== P2-002: Skip-Clear Optimization ==========

  /**
   * Skip /clear when context usage is low.
   * @default true
   */
  skipClearWhenLowContext?: boolean;

  /**
   * Context threshold percentage below which to skip /clear.
   * @default 30
   */
  skipClearThresholdPercent?: number;

  // ========== P2-004: Cycle Metrics ==========

  /**
   * Enable tracking of respawn cycle metrics.
   * @default true
   */
  trackCycleMetrics?: boolean;

  // ========== P2-001: Confidence Scoring ==========

  /**
   * Minimum confidence level required to trigger idle detection.
   * Below this threshold, the controller waits for more signals.
   * @default 65
   */
  minIdleConfidence?: number;

  /**
   * Confidence weight for completion message detection.
   * @default 40
   */
  confidenceWeightCompletion?: number;

  /**
   * Confidence weight for output silence.
   * @default 25
   */
  confidenceWeightSilence?: number;

  /**
   * Confidence weight for token stability.
   * @default 20
   */
  confidenceWeightTokens?: number;

  /**
   * Confidence weight for working pattern absence.
   * @default 15
   */
  confidenceWeightNoWorking?: number;
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
/** Timer info for countdown display */
export interface TimerInfo {
  name: string;
  durationMs: number;
  endsAt: number;
  reason?: string;
}

/** Action log entry for detailed UI feedback */
export interface ActionLogEntry {
  type: string;
  detail: string;
  timestamp: number;
}

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
  /** AI plan check started */
  planCheckStarted: () => void;
  /** AI plan check completed with verdict */
  planCheckCompleted: (result: AiPlanCheckResult) => void;
  /** AI plan check failed */
  planCheckFailed: (error: string) => void;
  /** Timer started for countdown display */
  timerStarted: (timer: TimerInfo) => void;
  /** Timer cancelled */
  timerCancelled: (timerName: string, reason?: string) => void;
  /** Timer completed */
  timerCompleted: (timerName: string) => void;
  /** Verbose action log for detailed UI feedback */
  actionLog: (action: ActionLogEntry) => void;
  /** Error occurred */
  error: (error: Error) => void;
  /** Debug log message */
  log: (message: string) => void;
  /** Stuck state warning emitted */
  stuckStateWarning: (state: RespawnState, durationMs: number) => void;
  /** Stuck state recovery triggered */
  stuckStateRecovery: (state: RespawnState, durationMs: number, attempt: number) => void;
  /** Respawn blocked by external signal */
  respawnBlocked: (data: { reason: string; details: string }) => void;
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
  aiPlanCheckEnabled: true,      // use AI to confirm plan mode before auto-accept
  aiPlanCheckModel: 'claude-opus-4-5-20251101',
  aiPlanCheckMaxContext: 8000,   // ~2k tokens (plan mode UI is compact)
  aiPlanCheckTimeoutMs: 60000,   // 60 seconds (thinking can be slow)
  aiPlanCheckCooldownMs: 30000,  // 30 seconds after NOT_PLAN_MODE
  stuckStateDetectionEnabled: true,  // detect stuck states
  stuckStateWarningMs: 300000,       // 5 minutes warning threshold
  stuckStateRecoveryMs: 600000,      // 10 minutes recovery threshold
  maxStuckRecoveries: 3,             // max recovery attempts
  // P2-001: Adaptive timing
  adaptiveTimingEnabled: true,       // Use adaptive timing based on historical patterns
  adaptiveMinConfirmMs: 5000,        // Minimum 5 seconds
  adaptiveMaxConfirmMs: 30000,       // Maximum 30 seconds
  // P2-002: Skip-clear optimization
  skipClearWhenLowContext: true,     // Skip /clear when token count is low
  skipClearThresholdPercent: 30,     // Skip if below 30% of max context
  // P2-004: Cycle metrics
  trackCycleMetrics: true,           // Track and persist cycle metrics
  // P2-001: Confidence scoring
  minIdleConfidence: 65,             // Minimum confidence to trigger idle (0-100)
  confidenceWeightCompletion: 40,    // Weight for completion message
  confidenceWeightSilence: 25,       // Weight for output silence
  confidenceWeightTokens: 20,        // Weight for token stability
  confidenceWeightNoWorking: 15,     // Weight for working pattern absence
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

  // ========== Hook-Based Detection State (Layer 0 - Highest Priority) ==========

  /** Whether a Stop hook was received (definitive idle signal from Claude Code) */
  private stopHookReceived: boolean = false;

  /** Timestamp when Stop hook was received */
  private stopHookTime: number | null = null;

  /** Whether an idle_prompt notification was received (60s+ idle signal) */
  private idlePromptReceived: boolean = false;

  /** Timestamp when idle_prompt was received */
  private idlePromptTime: number | null = null;

  /** Timer for short confirmation after hook signal (handles race conditions) */
  private hookConfirmTimer: NodeJS.Timeout | null = null;

  /** Confirmation delay after hook signal before confirming idle (ms) */
  private static readonly HOOK_CONFIRM_DELAY_MS = 3000;

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

  /** AI plan mode checker instance */
  private planChecker: AiPlanChecker;

  /** Timestamp when plan check was started (to detect stale results) */
  private planCheckStartTime: number = 0;

  /** Unique ID for current AI check request (to detect stale results) */
  private _currentAiCheckId: string | null = null;

  /** Timer for /clear step fallback (sends /init if no prompt detected) */
  private clearFallbackTimer: NodeJS.Timeout | null = null;

  /** Timer for step completion confirmation (waits for silence after completion) */
  private stepConfirmTimer: NodeJS.Timeout | null = null;

  /** Fallback timeout for /clear step (ms) - sends /init without waiting for prompt */
  private static readonly CLEAR_FALLBACK_TIMEOUT_MS = 10000;

  // ========== Timer Tracking for UI Countdown Display ==========

  /** Active timers being tracked for UI display */
  private activeTimers: Map<string, { name: string; startedAt: number; durationMs: number; endsAt: number }> = new Map();

  /** Recent action log entries (for UI display, max 20) */
  private recentActions: ActionLogEntry[] = [];

  // ========== Stuck-State Detection State ==========

  /** Timestamp when the current state was entered */
  private stateEnteredAt: number = 0;

  /** Timer for stuck-state detection */
  private stuckStateTimer: NodeJS.Timeout | null = null;

  /** Whether a stuck-state warning has been emitted for current state */
  private stuckStateWarned: boolean = false;

  /** Number of stuck-state recovery attempts */
  private stuckRecoveryCount: number = 0;

  // ========== P2-001: Adaptive Timing State ==========

  /** Historical timing data for adaptive adjustments */
  private timingHistory: TimingHistory = {
    recentIdleDetectionMs: [],
    recentCycleDurationMs: [],
    adaptiveCompletionConfirmMs: 10000, // Start with default
    sampleCount: 0,
    maxSamples: 20, // Keep last 20 samples for rolling average
    lastUpdatedAt: Date.now(),
  };

  // ========== P2-004: Cycle Metrics State ==========

  /** Current cycle being tracked */
  private currentCycleMetrics: Partial<RespawnCycleMetrics> | null = null;

  /** Timestamp when idle detection started for current cycle */
  private idleDetectionStartTime: number = 0;

  /** Recent cycle metrics (rolling window for aggregate calculation) */
  private recentCycleMetrics: RespawnCycleMetrics[] = [];

  /** Maximum number of cycle metrics to keep in memory */
  private static readonly MAX_CYCLE_METRICS_IN_MEMORY = 100;

  /** Aggregate metrics across all tracked cycles */
  private aggregateMetrics: RespawnAggregateMetrics = {
    totalCycles: 0,
    successfulCycles: 0,
    stuckRecoveryCycles: 0,
    blockedCycles: 0,
    errorCycles: 0,
    avgCycleDurationMs: 0,
    avgIdleDetectionMs: 0,
    p90CycleDurationMs: 0,
    successRate: 100,
    lastUpdatedAt: Date.now(),
  };

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
    'Compiling', 'Building', 'Installing', 'Fetching', 'Downloading',
    'Processing', 'Generating', 'Loading', 'Starting', 'Updating',
    'Checking', 'Validating', 'Testing', 'Formatting', 'Linting',
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',  // Spinner chars
    '◐', '◓', '◑', '◒',  // Alternative spinners
    '⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷',  // Braille spinners
  ];

  /**
   * Rolling window buffer for working pattern detection.
   * Prevents split-chunk issues where "Thinking" arrives as "Thin" + "king".
   * Size: 300 chars should be enough to catch any split pattern.
   */
  private workingPatternWindow: string = '';
  private static readonly WORKING_PATTERN_WINDOW_SIZE = 300;

  /**
   * Minimum time without working patterns before considering idle (ms).
   * Increased from 3s to 8s to avoid false positives during tool execution gaps.
   */
  private static readonly MIN_WORKING_PATTERN_ABSENCE_MS = 8000;

  /**
   * Creates a new RespawnController.
   *
   * @param session - The Session instance to control
   * @param config - Partial configuration (merged with defaults)
   */
  constructor(session: Session, config: Partial<RespawnConfig> = {}) {
    super();
    this.session = session;
    // Filter out undefined values from config to prevent overwriting defaults
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined)
    ) as Partial<RespawnConfig>;
    this.config = { ...DEFAULT_CONFIG, ...filteredConfig };

    // Validate configuration values
    this.validateConfig();

    this.aiChecker = new AiIdleChecker(session.id, {
      enabled: this.config.aiIdleCheckEnabled,
      model: this.config.aiIdleCheckModel,
      maxContextChars: this.config.aiIdleCheckMaxContext,
      checkTimeoutMs: this.config.aiIdleCheckTimeoutMs,
      cooldownMs: this.config.aiIdleCheckCooldownMs,
    });
    this.planChecker = new AiPlanChecker(session.id, {
      enabled: this.config.aiPlanCheckEnabled,
      model: this.config.aiPlanCheckModel,
      maxContextChars: this.config.aiPlanCheckMaxContext,
      checkTimeoutMs: this.config.aiPlanCheckTimeoutMs,
      cooldownMs: this.config.aiPlanCheckCooldownMs,
    });
    this.setupAiCheckerListeners();
    this.setupPlanCheckerListeners();
  }

  /**
   * Validate configuration values and reset invalid ones to defaults.
   * Ensures timeouts are positive and logically consistent.
   */
  private validateConfig(): void {
    const c = this.config;

    // Ensure timeouts are positive
    if (c.idleTimeoutMs <= 0) c.idleTimeoutMs = DEFAULT_CONFIG.idleTimeoutMs;
    if (c.completionConfirmMs <= 0) c.completionConfirmMs = DEFAULT_CONFIG.completionConfirmMs;
    if (c.noOutputTimeoutMs <= 0) c.noOutputTimeoutMs = DEFAULT_CONFIG.noOutputTimeoutMs;
    if (c.autoAcceptDelayMs < 0) c.autoAcceptDelayMs = DEFAULT_CONFIG.autoAcceptDelayMs;
    if (c.interStepDelayMs <= 0) c.interStepDelayMs = DEFAULT_CONFIG.interStepDelayMs;

    // Ensure completion confirm doesn't exceed no-output timeout
    if (c.completionConfirmMs > c.noOutputTimeoutMs) {
      c.completionConfirmMs = c.noOutputTimeoutMs;
    }

    // Ensure AI check timeouts are positive
    if (c.aiIdleCheckTimeoutMs <= 0) c.aiIdleCheckTimeoutMs = DEFAULT_CONFIG.aiIdleCheckTimeoutMs;
    if (c.aiIdleCheckCooldownMs < 0) c.aiIdleCheckCooldownMs = DEFAULT_CONFIG.aiIdleCheckCooldownMs;
    if (c.aiIdleCheckMaxContext <= 0) c.aiIdleCheckMaxContext = DEFAULT_CONFIG.aiIdleCheckMaxContext;

    // Ensure plan check timeouts are positive
    if (c.aiPlanCheckTimeoutMs <= 0) c.aiPlanCheckTimeoutMs = DEFAULT_CONFIG.aiPlanCheckTimeoutMs;
    if (c.aiPlanCheckCooldownMs < 0) c.aiPlanCheckCooldownMs = DEFAULT_CONFIG.aiPlanCheckCooldownMs;
    if (c.aiPlanCheckMaxContext <= 0) c.aiPlanCheckMaxContext = DEFAULT_CONFIG.aiPlanCheckMaxContext;
  }

  /** Wire up AI checker events to controller events (removes existing listeners first to prevent duplicates) */
  private setupAiCheckerListeners(): void {
    // Remove any existing listeners to prevent duplicates when restarting
    this.aiChecker.removeAllListeners();

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

  /** Wire up plan checker events to controller events (removes existing listeners first to prevent duplicates) */
  private setupPlanCheckerListeners(): void {
    // Remove any existing listeners to prevent duplicates when restarting
    this.planChecker.removeAllListeners();

    this.planChecker.on('log', (message: string) => {
      this.log(message);
    });

    this.planChecker.on('disabled', (reason: string) => {
      this.log(`Plan checker disabled: ${reason}. Falling back to pre-filter only.`);
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
    const workingPatternsAbsent = msSinceLastWorking >= RespawnController.MIN_WORKING_PATTERN_ABSENCE_MS;

    // Calculate confidence level (0-100) using configurable weights
    // P2-001: Configurable confidence scoring
    // Hook signals are definitive (100% confidence)
    let confidence = 0;
    if (this.stopHookReceived || this.idlePromptReceived) {
      confidence = 100;
    } else {
      // Use configured weights (with fallback to defaults)
      const weightCompletion = this.config.confidenceWeightCompletion ?? 40;
      const weightSilence = this.config.confidenceWeightSilence ?? 25;
      const weightTokens = this.config.confidenceWeightTokens ?? 20;
      const weightNoWorking = this.config.confidenceWeightNoWorking ?? 15;

      if (completionMessageDetected) confidence += weightCompletion;
      if (outputSilent) confidence += weightSilence;
      if (tokensStable) confidence += weightTokens;
      if (workingPatternsAbsent) confidence += weightNoWorking;

      // Confidence decay: if no output for extended time, add bonus confidence
      // This helps detect stuck states where Claude is truly idle but no completion message
      const extendedSilenceBonus = Math.min(20, Math.floor(msSinceLastOutput / 30000) * 5);
      if (msSinceLastOutput > 30000) {
        confidence += extendedSilenceBonus;
      }
    }
    // Cap at 100
    confidence = Math.min(100, confidence);

    // Determine status text and what we're waiting for
    let statusText: string;
    let waitingFor: string;

    if (this._state === 'stopped') {
      statusText = 'Controller stopped';
      waitingFor = 'Start to begin monitoring';
    } else if (this.stopHookReceived || this.idlePromptReceived) {
      const hookType = this.idlePromptReceived ? 'idle_prompt' : 'Stop';
      statusText = `${hookType} hook received - confirming idle`;
      waitingFor = 'Short confirmation (race condition check)';
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

    // Determine current phase and next action
    let currentPhase: string;
    let nextAction: string;

    switch (this._state) {
      case 'stopped':
        currentPhase = 'Stopped';
        nextAction = 'Start to begin';
        break;
      case 'watching':
        currentPhase = 'Monitoring for idle';
        nextAction = 'Waiting for silence + no working patterns';
        break;
      case 'confirming_idle':
        currentPhase = 'Confirming idle state';
        nextAction = 'Waiting for output silence';
        break;
      case 'ai_checking':
        currentPhase = 'AI analyzing terminal';
        nextAction = 'Waiting for IDLE/WORKING verdict';
        break;
      case 'sending_update':
        currentPhase = 'Sending update prompt';
        nextAction = 'Will send prompt after delay';
        break;
      case 'waiting_update':
        currentPhase = 'Waiting for update to complete';
        nextAction = 'Will send /clear when done';
        break;
      case 'sending_clear':
        currentPhase = 'Sending /clear';
        nextAction = 'Will clear context';
        break;
      case 'waiting_clear':
        currentPhase = 'Waiting for /clear to complete';
        nextAction = 'Will send /init when done';
        break;
      case 'sending_init':
        currentPhase = 'Sending /init';
        nextAction = 'Will re-initialize';
        break;
      case 'waiting_init':
        currentPhase = 'Waiting for /init to complete';
        nextAction = 'Monitoring for work';
        break;
      case 'monitoring_init':
        currentPhase = 'Monitoring if /init triggered work';
        nextAction = 'Kickstart if no work started';
        break;
      case 'sending_kickstart':
        currentPhase = 'Sending kickstart prompt';
        nextAction = 'Will send prompt after delay';
        break;
      case 'waiting_kickstart':
        currentPhase = 'Waiting for kickstart to complete';
        nextAction = 'Completing cycle';
        break;
      default:
        currentPhase = this._state;
        nextAction = 'Processing...';
    }

    return {
      stopHookReceived: this.stopHookReceived,
      stopHookTime: this.stopHookTime,
      idlePromptReceived: this.idlePromptReceived,
      idlePromptTime: this.idlePromptTime,
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
      activeTimers: this.getActiveTimers(),
      recentActions: this.recentActions.slice(0, 10),
      currentPhase,
      nextAction,
      stuckState: this.getStuckStateMetrics(),
    };
  }

  /**
   * Start periodic detection status updates for UI.
   * Emits 'detectionUpdate' event every 500ms while running.
   */
  private startDetectionUpdates(): void {
    this.stopDetectionUpdates();
    this.detectionUpdateTimer = setInterval(() => {
      try {
        if (this._state !== 'stopped') {
          this.emit('detectionUpdate', this.getDetectionStatus());
        }
      } catch (err) {
        console.error(`[RespawnController] Error in detectionUpdateTimer:`, err);
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
    this.stateEnteredAt = Date.now();
    this.stuckStateWarned = false;  // Reset warning for new state
    this.log(`State: ${prevState} → ${newState}`);
    this.logAction('state', `${prevState} → ${newState}`);
    this.emit('stateChanged', newState, prevState);

    // Reset stuck recovery count on successful state transition to normal states
    if (newState === 'watching' && prevState !== 'stopped') {
      this.stuckRecoveryCount = 0;
    }

    // Start/restart stuck-state detection timer
    this.startStuckStateTimer();
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

    // Re-setup AI checker listeners in case they were removed by a previous stop()
    // This allows the controller to be restarted after being stopped
    this.setupAiCheckerListeners();
    this.setupPlanCheckerListeners();

    // Initialize all timestamps and reset hook state
    const now = Date.now();
    this.lastActivityTime = now;
    this.lastOutputTime = now;
    this.lastTokenChangeTime = now;
    this.lastWorkingPatternTime = now;
    this.completionMessageTime = null;
    this.hasReceivedOutput = false;
    this.resetHookState();

    // Seed the terminal buffer from the session's existing output.
    // This gives the AI checker context even if no new output arrives.
    const existingBuffer = this.session.terminalBuffer;
    if (existingBuffer) {
      this.terminalBuffer.clear();
      this.terminalBuffer.append(existingBuffer);
    }

    this.aiChecker.reset();
    this.planChecker.reset();
    this.setState('watching');
    this.setupTerminalListener();
    this.startDetectionUpdates();
    this.startNoOutputTimer();
    this.startPreFilterTimer();
    if (this.config.autoAcceptPrompts) {
      this.startAutoAcceptTimer();
    }

    // P2-001: Initialize idle detection start time
    this.idleDetectionStartTime = Date.now();
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
    this.planChecker.cancel();
    // Remove event listeners from checkers to prevent memory leaks
    this.aiChecker.removeAllListeners();
    this.planChecker.removeAllListeners();
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
   * Re-setups terminal listener if it was removed (e.g., after stop()).
   */
  resume(): void {
    this.log('Resuming respawn');
    // Re-setup terminal listener if it was removed (robustness for stop->resume case)
    if (!this.terminalHandler) {
      this.setupTerminalListener();
    }
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

    // Cancel plan check if running (new output makes result stale)
    if (this.planChecker.status === 'checking') {
      this.log('New output during plan check, cancelling (stale)');
      this.planChecker.cancel();
    }

    // Track token count (Layer 3)
    const tokenCount = this.extractTokenCount(data);
    if (tokenCount !== null && tokenCount !== this.lastTokenCount) {
      this.lastTokenCount = tokenCount;
      this.lastTokenChangeTime = now;
    }

    // Detect completion message FIRST (Layer 1) - PRIMARY DETECTION
    // Check this before working patterns because completion message indicates
    // the work is done, even if working patterns are still in the rolling window
    if (this.isCompletionMessage(data)) {
      // Clear the rolling window - completion marks a transition point
      this.clearWorkingPatternWindow();
      this.workingDetected = false;
      this.completionMessageTime = now;
      this.cancelAutoAcceptTimer(); // Normal idle flow handles this
      this.log(`Completion message detected: "${data.trim().substring(0, 50)}..."`);

      // In watching state, start completion confirmation timer
      if (this._state === 'watching') {
        this.startCompletionConfirmTimer();
        return;
      }

      // In waiting states, also use confirmation timer (same detection logic)
      // This ensures we wait for Claude to finish before proceeding
      // Note: 'watching' is already handled above and returns early
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
        // Non-waiting states: completion message is ignored
        case 'confirming_idle':
        case 'ai_checking':
        case 'sending_update':
        case 'sending_clear':
        case 'sending_init':
        case 'monitoring_init':
        case 'sending_kickstart':
        case 'stopped':
          // Completion message during these states is ignored
          break;
        default:
          assertNever(this._state, `Unhandled RespawnState in completion detection: ${this._state}`);
      }
      return;
    }

    // Detect working patterns (Layer 4)
    const isWorking = this.hasWorkingPattern(data);
    if (isWorking) {
      this.workingDetected = true;
      this.promptDetected = false;
      this.elicitationDetected = false; // Clear on new work cycle
      this.resetHookState(); // Clear hook signals on new work
      this.lastWorkingPatternTime = now;
      this.clearIdleTimer();

      // Cancel hook confirmation timer if running
      this.cancelTrackedTimer('hook-confirm', this.hookConfirmTimer, 'working patterns detected');
      this.hookConfirmTimer = null;

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

      // Cancel plan check if running (Claude started working)
      if (this.planChecker.status === 'checking') {
        this.log('Working patterns detected during plan check, cancelling');
        this.planChecker.cancel();
      }

      // If we're monitoring init and work started, go to watching (no kickstart needed)
      if (this._state === 'monitoring_init') {
        this.log('/init triggered work, skipping kickstart');
        this.emit('stepCompleted', 'init');
        this.completeCycle();
      }
      return;
    }

    // In confirming_idle or ai_checking state, substantial output cancels the flow.
    // This prevents false triggers when Claude pauses briefly mid-work.
    if (this._state === 'confirming_idle' || this._state === 'ai_checking') {
      // Strip ANSI escape codes to check if there's real content
      ANSI_ESCAPE_PATTERN_SIMPLE.lastIndex = 0;
      const stripped = data.replace(ANSI_ESCAPE_PATTERN_SIMPLE, '').trim();
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
        // Non-waiting states: prompt detection is informational only
        case 'watching':
        case 'confirming_idle':
        case 'ai_checking':
        case 'sending_update':
        case 'sending_clear':
        case 'sending_init':
        case 'sending_kickstart':
        case 'stopped':
          // Prompt detection during these states doesn't trigger action
          break;
        default:
          assertNever(this._state, `Unhandled RespawnState in prompt detection: ${this._state}`);
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

    // P2-004: Record step completion
    this.recordCycleStep('update');

    if (this.config.sendClear) {
      // P2-002: Check if we should skip /clear
      if (this.shouldSkipClear()) {
        if (this.currentCycleMetrics) {
          this.currentCycleMetrics.clearSkipped = true;
        }
        // Skip /clear, go directly to /init or complete
        if (this.config.sendInit) {
          this.sendInit();
        } else {
          this.completeCycle();
        }
      } else {
        this.sendClear();
      }
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
    this.cancelTrackedTimer('clear-fallback', this.clearFallbackTimer, 'prompt detected');
    this.clearFallbackTimer = null;
    this.logAction('step', '/clear completed');
    this.emit('stepCompleted', 'clear');

    // P2-004: Record step completion
    this.recordCycleStep('clear');

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

    // P2-004: Record step completion
    this.recordCycleStep('init');

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
    this.clearWorkingPatternWindow();
    this.workingDetected = false;
    this.logAction('step', 'Monitoring if /init triggered work...');

    // Give Claude a moment to start working before checking for idle
    this.stepTimer = this.startTrackedTimer(
      'init-monitor',
      3000,
      () => {
        this.stepTimer = null;
        // If still in monitoring state and no work detected, consider it idle
        if (this._state === 'monitoring_init' && !this.workingDetected) {
          this.checkMonitoringInitIdle();
        }
      },
      'grace period for /init'
    );
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
    this.clearWorkingPatternWindow();

    this.stepTimer = this.startTrackedTimer(
      'step-delay',
      this.config.interStepDelayMs,
      () => {
        this.stepTimer = null;
        const prompt = this.config.kickstartPrompt!;
        this.logAction('command', `Sending kickstart: "${prompt.substring(0, 40)}..."`);
        this.session.writeViaScreen(prompt + '\r');  // \r triggers key.return in Ink/Claude CLI
        this.emit('stepSent', 'kickstart', prompt);
        this.setState('waiting_kickstart');
        this.promptDetected = false;
        this.workingDetected = false;
      },
      'delay before kickstart'
    );
  }

  /**
   * Handle kickstart step completion.
   * @fires stepCompleted - With step 'kickstart'
   */
  private checkKickstartComplete(): void {
    this.clearIdleTimer();
    this.log('Kickstart completed (ready indicator)');
    this.emit('stepCompleted', 'kickstart');

    // P2-004: Record step completion
    this.recordCycleStep('kickstart');

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

  /** Clear all timers (idle, step, completion confirm, no-output, pre-filter, step confirm, auto-accept, hook confirm, and clear fallback) */
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
    if (this.hookConfirmTimer) {
      clearTimeout(this.hookConfirmTimer);
      this.hookConfirmTimer = null;
    }
    if (this.stuckStateTimer) {
      clearInterval(this.stuckStateTimer);
      this.stuckStateTimer = null;
    }
    // Clear all tracked timers
    this.activeTimers.clear();
  }

  // ========== Stuck-State Detection Methods ==========

  /**
   * Start or restart the stuck-state detection timer.
   * Emits warning after stuckStateWarningMs, triggers recovery after stuckStateRecoveryMs.
   */
  private startStuckStateTimer(): void {
    if (!this.config.stuckStateDetectionEnabled) return;
    if (this._state === 'stopped') return;

    // Clear existing timer
    if (this.stuckStateTimer) {
      clearInterval(this.stuckStateTimer);
      this.stuckStateTimer = null;
    }

    // Check interval for stuck state
    const checkIntervalMs = Math.min(this.config.stuckStateWarningMs, 60000); // Check every minute max

    this.stuckStateTimer = setInterval(() => {
      try {
        this.checkStuckState();
      } catch (err) {
        console.error(`[RespawnController] Error in stuckStateTimer:`, err);
      }
    }, checkIntervalMs);
  }

  /**
   * Check if the controller is stuck in the current state.
   * Emits warnings and triggers recovery actions as appropriate.
   */
  private checkStuckState(): void {
    if (this._state === 'stopped') return;

    const durationMs = Date.now() - this.stateEnteredAt;

    // Check for recovery threshold (more severe)
    if (durationMs >= this.config.stuckStateRecoveryMs) {
      if (this.stuckRecoveryCount < this.config.maxStuckRecoveries) {
        this.stuckRecoveryCount++;
        this.logAction('stuck', `Recovery attempt ${this.stuckRecoveryCount}/${this.config.maxStuckRecoveries}`);
        this.log(`Stuck-state recovery triggered (state: ${this._state}, duration: ${Math.round(durationMs / 1000)}s, attempt: ${this.stuckRecoveryCount})`);
        this.emit('stuckStateRecovery', this._state, durationMs, this.stuckRecoveryCount);
        this.handleStuckStateRecovery();
      } else {
        this.logAction('stuck', `Max recoveries (${this.config.maxStuckRecoveries}) reached - manual intervention needed`);
        this.log(`Stuck-state: max recoveries reached, manual intervention needed`);
      }
      return;
    }

    // Check for warning threshold
    if (durationMs >= this.config.stuckStateWarningMs && !this.stuckStateWarned) {
      this.stuckStateWarned = true;
      this.logAction('stuck', `Warning: in state '${this._state}' for ${Math.round(durationMs / 1000)}s`);
      this.log(`Stuck-state warning: state '${this._state}' for ${Math.round(durationMs / 1000)}s without progress`);
      this.emit('stuckStateWarning', this._state, durationMs);
    }
  }

  /**
   * Handle stuck-state recovery by resetting to a known good state.
   * Uses escalating recovery strategies based on current state.
   */
  private handleStuckStateRecovery(): void {
    const currentState = this._state;

    // P2-004: Complete current cycle metrics with stuck_recovery outcome
    if (this.currentCycleMetrics) {
      this.completeCycleMetrics('stuck_recovery', `Stuck in state: ${currentState}`);
    }

    // Cancel any running AI checks
    if (this.aiChecker.status === 'checking') {
      this.aiChecker.cancel();
    }
    if (this.planChecker.status === 'checking') {
      this.planChecker.cancel();
    }

    // Clear all timers and reset detection state
    this.clearTimers();
    this.completionMessageTime = null;
    this.promptDetected = false;
    this.workingDetected = false;
    this.resetHookState();

    // Escalating recovery strategies
    switch (currentState) {
      case 'watching':
      case 'confirming_idle':
      case 'ai_checking':
        // For detection states, try forcing idle confirmation
        this.log('Recovery: forcing idle confirmation');
        this.onIdleConfirmed(`stuck-state recovery (was ${currentState})`);
        break;

      case 'waiting_update':
      case 'waiting_clear':
      case 'waiting_init':
      case 'waiting_kickstart':
      case 'monitoring_init':
        // For waiting states, skip to next step or complete cycle
        this.log('Recovery: skipping stuck step');
        this.completeCycle();
        break;

      case 'sending_update':
      case 'sending_clear':
      case 'sending_init':
      case 'sending_kickstart':
        // For sending states, retry the send
        this.log('Recovery: returning to watching state');
        this.setState('watching');
        this.startNoOutputTimer();
        this.startPreFilterTimer();
        if (this.config.autoAcceptPrompts) {
          this.startAutoAcceptTimer();
        }
        break;

      default:
        // Fallback: reset to watching
        this.log('Recovery: fallback to watching state');
        this.setState('watching');
        this.startNoOutputTimer();
        this.startPreFilterTimer();
    }
  }

  /**
   * Get stuck-state metrics for UI display.
   */
  getStuckStateMetrics(): {
    currentStateDurationMs: number;
    warningThresholdMs: number;
    recoveryThresholdMs: number;
    recoveryAttempts: number;
    maxRecoveries: number;
    isWarned: boolean;
  } {
    return {
      currentStateDurationMs: this._state !== 'stopped' ? Date.now() - this.stateEnteredAt : 0,
      warningThresholdMs: this.config.stuckStateWarningMs,
      recoveryThresholdMs: this.config.stuckStateRecoveryMs,
      recoveryAttempts: this.stuckRecoveryCount,
      maxRecoveries: this.config.maxStuckRecoveries,
      isWarned: this.stuckStateWarned,
    };
  }

  // ========== Timer Tracking Methods ==========

  /**
   * Start a tracked timer with UI countdown support.
   * Emits timerStarted event and tracks the timer for UI display.
   */
  private startTrackedTimer(
    name: string,
    durationMs: number,
    callback: () => void,
    reason?: string
  ): NodeJS.Timeout {
    const now = Date.now();
    const endsAt = now + durationMs;

    this.activeTimers.set(name, { name, startedAt: now, durationMs, endsAt });
    this.emit('timerStarted', { name, durationMs, endsAt, reason });
    this.logAction('timer', `Started ${name}: ${Math.round(durationMs / 1000)}s${reason ? ` (${reason})` : ''}`);

    return setTimeout(() => {
      this.activeTimers.delete(name);
      this.emit('timerCompleted', name);
      callback();
    }, durationMs);
  }

  /**
   * Cancel a tracked timer and emit cancellation event.
   */
  private cancelTrackedTimer(name: string, timerRef: NodeJS.Timeout | null, reason?: string): void {
    if (timerRef) {
      clearTimeout(timerRef);
      if (this.activeTimers.has(name)) {
        this.activeTimers.delete(name);
        this.emit('timerCancelled', name, reason);
        this.logAction('timer-cancel', `${name}${reason ? `: ${reason}` : ''}`);
      }
    }
  }

  /**
   * Get all active timers with remaining time for UI display.
   */
  getActiveTimers(): ActiveTimerInfo[] {
    const now = Date.now();
    return Array.from(this.activeTimers.values()).map(t => ({
      name: t.name,
      remainingMs: Math.max(0, t.endsAt - now),
      totalMs: t.durationMs,
    }));
  }

  /**
   * Log an action for detailed UI feedback.
   * Keeps the last 20 entries.
   */
  private logAction(type: string, detail: string): void {
    const action: ActionLogEntry = { type, detail, timestamp: Date.now() };
    this.recentActions.unshift(action);
    if (this.recentActions.length > 20) {
      this.recentActions.pop();
    }
    this.emit('actionLog', action);
  }

  /**
   * Get recent action log entries.
   */
  getRecentActions(): ActionLogEntry[] {
    return [...this.recentActions];
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
   * Uses rolling window to catch patterns split across chunks (e.g., "Thin" + "king").
   */
  private hasWorkingPattern(data: string): boolean {
    // Always update the rolling window first to maintain continuity
    this.workingPatternWindow += data;
    if (this.workingPatternWindow.length > RespawnController.WORKING_PATTERN_WINDOW_SIZE) {
      this.workingPatternWindow = this.workingPatternWindow.slice(-RespawnController.WORKING_PATTERN_WINDOW_SIZE);
    }

    // Check the rolling window (includes current data, catches both complete and split patterns)
    return this.WORKING_PATTERNS.some(pattern => this.workingPatternWindow.includes(pattern));
  }

  /**
   * Clear the working pattern rolling window.
   * Called when starting a new detection cycle.
   */
  private clearWorkingPatternWindow(): void {
    this.workingPatternWindow = '';
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
    this.cancelTrackedTimer('no-output-fallback', this.noOutputTimer, 'restarting');
    this.noOutputTimer = null;

    this.noOutputTimer = this.startTrackedTimer(
      'no-output-fallback',
      this.config.noOutputTimeoutMs,
      () => {
        this.noOutputTimer = null;
        if (this._state === 'watching' || this._state === 'confirming_idle') {
          const msSinceOutput = Date.now() - this.lastOutputTime;
          this.logAction('detection', `No-output fallback: ${Math.round(msSinceOutput / 1000)}s silence`);
          // If AI check is disabled or errored out, go directly to idle
          if (!this.config.aiIdleCheckEnabled || this.aiChecker.status === 'disabled') {
            this.onIdleConfirmed('no-output fallback (AI check disabled)');
          } else {
            this.tryStartAiCheck('no-output fallback');
          }
        }
      },
      'fallback if no output at all'
    );
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
    this.cancelTrackedTimer('pre-filter', this.preFilterTimer, 'restarting');
    this.preFilterTimer = null;

    // Only set up pre-filter when AI check is enabled
    if (!this.config.aiIdleCheckEnabled) return;

    this.preFilterTimer = this.startTrackedTimer(
      'pre-filter',
      this.config.completionConfirmMs,
      () => {
        this.preFilterTimer = null;
        if (this._state === 'watching') {
          const now = Date.now();
          const msSinceOutput = now - this.lastOutputTime;
          const msSinceWorking = now - this.lastWorkingPatternTime;
          const msSinceTokenChange = now - this.lastTokenChangeTime;

          // Check pre-filter conditions
          const silenceMet = msSinceOutput >= this.config.completionConfirmMs;
          const noWorkingMet = msSinceWorking >= RespawnController.MIN_WORKING_PATTERN_ABSENCE_MS;
          const tokensStableMet = msSinceTokenChange >= this.config.completionConfirmMs;

          if (silenceMet && noWorkingMet && tokensStableMet) {
            this.logAction('detection', `Pre-filter passed: silence=${Math.round(msSinceOutput / 1000)}s`);
            this.tryStartAiCheck('pre-filter');
          }
        }
      },
      'checking idle conditions'
    );
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
    // P0-006: Check Session.isWorking first to skip expensive AI call if session reports working
    if (this.session.isWorking) {
      this.log(`Skipping AI check - Session reports isWorking=true (reason: ${reason})`);
      this.logAction('detection', 'Skipped AI check: Session is working');
      return;
    }

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
    this.logAction('ai-check', `Spawning AI idle checker (${reason})`);
    this.emit('aiCheckStarted');

    // Generate unique ID for this check to detect stale results
    const checkId = randomUUID();
    this._currentAiCheckId = checkId;

    // Get the terminal buffer for analysis
    const buffer = this.terminalBuffer.value;

    this.aiChecker.check(buffer).then((result) => {
      // If state changed while checking (e.g., cancelled), ignore result
      if (this._state !== 'ai_checking') {
        this.log(`AI check result ignored (state is now ${this._state})`);
        return;
      }

      // Validate this is the result for the current check (not a stale one)
      if (this._currentAiCheckId !== checkId) {
        this.log(`AI check result ignored (stale check ID: ${checkId.substring(0, 8)})`);
        return;
      }

      if (result.verdict === 'IDLE') {
        // Cancel any pending confirmation timers - AI has spoken
        this.cancelTrackedTimer('completion-confirm', this.completionConfirmTimer, 'AI verdict: IDLE');
        this.completionConfirmTimer = null;
        this.cancelTrackedTimer('pre-filter', this.preFilterTimer, 'AI verdict: IDLE');
        this.preFilterTimer = null;

        this.logAction('ai-check', `Verdict: IDLE - ${result.reasoning}`);
        this.emit('aiCheckCompleted', result);
        this.onIdleConfirmed(`ai-check: idle (${result.reasoning})`);
      } else if (result.verdict === 'WORKING') {
        // Cancel timers and go to cooldown
        this.cancelTrackedTimer('completion-confirm', this.completionConfirmTimer, 'AI verdict: WORKING');
        this.completionConfirmTimer = null;

        this.logAction('ai-check', `Verdict: WORKING - ${result.reasoning}`);
        this.emit('aiCheckCompleted', result);
        this.setState('watching');
        this.log(`AI check says WORKING, returning to watching with ${this.config.aiIdleCheckCooldownMs}ms cooldown`);
        // Restart timers so the controller retries after cooldown expires
        this.startNoOutputTimer();
        this.startPreFilterTimer();
      } else {
        // ERROR verdict
        this.logAction('ai-check', `Error: ${result.reasoning}`);
        this.emit('aiCheckFailed', result.reasoning);
        this.setState('watching');
        // Restart timers to allow retry
        this.startNoOutputTimer();
        this.startPreFilterTimer();
      }
    }).catch((err) => {
      // Validate this is the error for the current check
      if (this._currentAiCheckId !== checkId) {
        return; // Stale check, ignore error
      }
      if (this._state === 'ai_checking') {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logAction('ai-check', `Failed: ${errorMsg.substring(0, 50)}`);
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
    this.cancelTrackedTimer('auto-accept', this.autoAcceptTimer, 'restarting');
    this.autoAcceptTimer = null;

    this.autoAcceptTimer = this.startTrackedTimer(
      'auto-accept',
      this.config.autoAcceptDelayMs,
      () => {
        this.autoAcceptTimer = null;
        this.tryAutoAccept();
      },
      'plan mode detection'
    );
  }

  /**
   * Cancel the auto-accept timer.
   * Called when a completion message is detected (normal idle flow handles it).
   */
  private cancelAutoAcceptTimer(): void {
    this.cancelTrackedTimer('auto-accept', this.autoAcceptTimer, 'cancelled');
    this.autoAcceptTimer = null;
  }

  /**
   * Attempt to auto-accept a plan mode prompt by sending Enter.
   * Two-stage gate:
   * 1. Strict regex pre-filter — check if terminal buffer contains plan mode UI elements
   * 2. AI confirmation — spawn Opus to classify buffer as PLAN_MODE or NOT_PLAN_MODE
   *
   * Only sends Enter if both stages confirm (or pre-filter only if AI disabled).
   *
   * @fires autoAcceptSent
   * @fires planCheckStarted
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

    // Stage 1: Pre-filter — check if buffer looks like plan mode
    const buffer = this.terminalBuffer.value;
    if (!this.isPlanModePreFilterMatch(buffer)) {
      this.log('Skipping auto-accept: pre-filter did not match plan mode patterns');
      return;
    }

    // Stage 2: AI confirmation (if enabled and available)
    if (this.config.aiPlanCheckEnabled && this.planChecker.status !== 'disabled') {
      if (this.planChecker.isOnCooldown()) {
        this.log(`Skipping auto-accept: plan checker on cooldown (${Math.ceil(this.planChecker.getCooldownRemainingMs() / 1000)}s remaining)`);
        return;
      }
      if (this.planChecker.status === 'checking') {
        this.log('Skipping auto-accept: plan check already in progress');
        return;
      }
      // Start async AI plan check
      this.startPlanCheck(buffer);
      return;
    }

    // AI plan check disabled — pre-filter passed, send Enter directly
    this.sendAutoAcceptEnter();
  }

  /**
   * Check if the terminal buffer matches plan mode pre-filter patterns.
   * Only checks the last 2000 chars (plan mode UI appears at the bottom).
   *
   * Must find:
   * - Numbered option pattern (e.g., "1. Yes", "2. No")
   * - Selection indicator (❯ or > followed by number)
   * Must NOT find:
   * - Recent working patterns (spinners, "Thinking", etc.) in the tail
   */
  private isPlanModePreFilterMatch(buffer: string): boolean {
    // Only check the last 2000 chars (plan mode UI is at the bottom)
    const tail = buffer.slice(-2000);

    // Strip ANSI codes for pattern matching
    ANSI_ESCAPE_PATTERN_SIMPLE.lastIndex = 0;
    const stripped = tail.replace(ANSI_ESCAPE_PATTERN_SIMPLE, '');

    // Must find numbered option pattern
    if (!PLAN_MODE_OPTION_PATTERN.test(stripped)) return false;

    // Must find selection indicator
    const selectorMatch = stripped.match(PLAN_MODE_SELECTOR_PATTERN);
    if (!selectorMatch) return false;

    // Must NOT have working patterns AFTER the selector position.
    // Working patterns before the selector are from earlier work and don't matter.
    const selectorIndex = stripped.lastIndexOf(selectorMatch[0]);
    const afterSelector = stripped.slice(selectorIndex + selectorMatch[0].length);
    const hasWorking = this.WORKING_PATTERNS.some(pattern => afterSelector.includes(pattern));
    if (hasWorking) return false;

    return true;
  }

  /**
   * Start an AI plan check to confirm plan mode before auto-accepting.
   * Async — result handled by then/catch.
   *
   * @param buffer - Terminal buffer to analyze
   * @fires planCheckStarted
   * @fires planCheckCompleted
   * @fires planCheckFailed
   */
  private startPlanCheck(buffer: string): void {
    this.planCheckStartTime = Date.now();
    this.logAction('plan-check', 'Spawning AI plan checker');
    this.emit('planCheckStarted');

    this.planChecker.check(buffer).then((result) => {
      // Discard stale result if new output arrived during check
      if (this.lastOutputTime > this.planCheckStartTime) {
        this.logAction('plan-check', 'Result discarded (output arrived during check)');
        return;
      }

      if (result.verdict === 'PLAN_MODE') {
        // Don't send Enter if state changed (e.g., AI idle check started or respawn cycle began)
        if (this._state !== 'watching') {
          this.logAction('plan-check', `Verdict: PLAN_MODE but state is ${this._state}, not sending Enter`);
          return;
        }
        this.emit('planCheckCompleted', result);
        this.logAction('plan-check', 'Verdict: PLAN_MODE - sending Enter immediately');
        this.sendAutoAcceptEnter();
        // No cooldown needed - we're taking action
      } else if (result.verdict === 'NOT_PLAN_MODE') {
        this.emit('planCheckCompleted', result);
        this.logAction('plan-check', `Verdict: NOT_PLAN_MODE - ${result.reasoning}`);
      } else {
        // ERROR verdict
        this.emit('planCheckFailed', result.reasoning);
        this.logAction('plan-check', `Error: ${result.reasoning}`);
      }
    }).catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit('planCheckFailed', errorMsg);
      this.logAction('plan-check', `Failed: ${errorMsg.substring(0, 50)}`);
    });
  }

  /**
   * Send the actual Enter keystroke for auto-accept.
   * Factored out so both pre-filter-only and AI-confirmed paths can call it.
   * @fires autoAcceptSent
   */
  private sendAutoAcceptEnter(): void {
    const msSinceOutput = Date.now() - this.lastOutputTime;
    this.log(`Auto-accepting plan mode prompt (${msSinceOutput}ms silence, pre-filter + AI confirmed)`);

    // Cancel any pending AI idle checks - we're about to make Claude work
    if (this.aiChecker.status === 'checking') {
      this.log('Cancelling AI idle check before auto-accept');
      this.aiChecker.cancel();
    }

    // Cancel completion confirmation - auto-accept takes precedence
    this.cancelTrackedTimer('completion-confirm', this.completionConfirmTimer, 'auto-accept');
    this.completionConfirmTimer = null;
    this.completionMessageTime = null;

    // Ensure we're in watching state (not confirming_idle or ai_checking)
    if (this._state !== 'watching') {
      this.setState('watching');
    }

    this.logAction('command', 'Auto-accept: ↵ Enter (plan approved)');
    this.emit('stepSent', 'auto-accept', '↵');
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
   * Signal that a Stop hook was received from Claude Code.
   * This is a DEFINITIVE signal that Claude has finished responding.
   * Skips AI idle check and uses a short confirmation period to handle race conditions.
   *
   * @fires log
   */
  signalStopHook(): void {
    // Only process in states where we're watching for idle
    if (this._state !== 'watching' && this._state !== 'confirming_idle' && this._state !== 'ai_checking') {
      this.log(`Stop hook received but ignoring (state is ${this._state})`);
      return;
    }

    const now = Date.now();
    this.stopHookReceived = true;
    this.stopHookTime = now;
    this.logAction('hook', 'Stop hook received - definitive idle signal');
    this.log('Stop hook received from Claude Code - definitive idle signal');

    // Cancel any running AI check - we have a definitive signal
    if (this._state === 'ai_checking') {
      this.log('Cancelling AI check - Stop hook is definitive');
      this.aiChecker.cancel();
    }

    // Cancel completion confirm timer - hook takes precedence
    this.cancelTrackedTimer('completion-confirm', this.completionConfirmTimer, 'Stop hook received');
    this.completionConfirmTimer = null;

    // Cancel pre-filter timer - hook takes precedence
    this.cancelTrackedTimer('pre-filter', this.preFilterTimer, 'Stop hook received');
    this.preFilterTimer = null;

    // Start short confirmation timer to handle race conditions
    // (e.g., Stop hook arrives but Claude immediately starts new work)
    this.startHookConfirmTimer('stop');
  }

  /**
   * Signal that an idle_prompt notification was received from Claude Code.
   * This fires after 60+ seconds of Claude waiting for user input.
   * This is a DEFINITIVE signal that Claude is idle.
   *
   * @fires log
   */
  signalIdlePrompt(): void {
    // Only process in states where we're watching for idle
    if (this._state !== 'watching' && this._state !== 'confirming_idle' && this._state !== 'ai_checking') {
      this.log(`idle_prompt received but ignoring (state is ${this._state})`);
      return;
    }

    const now = Date.now();
    this.idlePromptReceived = true;
    this.idlePromptTime = now;
    this.logAction('hook', 'idle_prompt received - 60s+ idle confirmed');
    this.log('idle_prompt notification received - Claude has been idle for 60+ seconds');

    // Cancel any running AI check - we have a definitive signal
    if (this._state === 'ai_checking') {
      this.log('Cancelling AI check - idle_prompt is definitive');
      this.aiChecker.cancel();
    }

    // Cancel all other detection timers - this is definitive
    this.cancelTrackedTimer('completion-confirm', this.completionConfirmTimer, 'idle_prompt received');
    this.completionConfirmTimer = null;
    this.cancelTrackedTimer('pre-filter', this.preFilterTimer, 'idle_prompt received');
    this.preFilterTimer = null;
    this.cancelTrackedTimer('no-output-fallback', this.noOutputTimer, 'idle_prompt received');
    this.noOutputTimer = null;

    // idle_prompt is an even stronger signal than Stop hook (60s+ idle)
    // Skip confirmation and go directly to idle
    this.onIdleConfirmed('idle_prompt hook (60s+ idle)');
  }

  /**
   * Start a short confirmation timer after receiving a hook signal.
   * This handles race conditions where a hook arrives but Claude immediately starts new work.
   *
   * @param hookType - Which hook triggered this ('stop' or 'idle_prompt')
   */
  private startHookConfirmTimer(hookType: 'stop' | 'idle_prompt'): void {
    this.cancelTrackedTimer('hook-confirm', this.hookConfirmTimer, 'restarting');
    this.hookConfirmTimer = null;

    this.hookConfirmTimer = this.startTrackedTimer(
      'hook-confirm',
      RespawnController.HOOK_CONFIRM_DELAY_MS,
      () => {
        this.hookConfirmTimer = null;

        // Verify we haven't received new output since the hook arrived
        const hookTime = hookType === 'stop' ? this.stopHookTime : this.idlePromptTime;
        if (hookTime && this.lastOutputTime > hookTime) {
          // Output arrived after hook - Claude started new work
          this.log(`Output received after ${hookType} hook, cancelling idle confirmation`);
          this.logAction('hook', `${hookType} cancelled - new output detected`);
          this.resetHookState();
          this.setState('watching');
          this.startNoOutputTimer();
          this.startPreFilterTimer();
          return;
        }

        // No new output - confirm idle via hook signal
        this.logAction('hook', `${hookType} confirmed after ${RespawnController.HOOK_CONFIRM_DELAY_MS}ms`);
        this.onIdleConfirmed(`${hookType} hook (confirmed)`);
      },
      `confirming ${hookType} hook`
    );
  }

  /**
   * Reset hook-based detection state.
   * Called when hooks are cancelled due to new activity.
   */
  private resetHookState(): void {
    this.stopHookReceived = false;
    this.stopHookTime = null;
    this.idlePromptReceived = false;
    this.idlePromptTime = null;
  }

  /**
   * Signal that the transcript indicates completion.
   * This is a supporting signal from transcript file monitoring.
   * Unlike hooks, this doesn't immediately trigger idle - it boosts confidence.
   */
  signalTranscriptComplete(): void {
    // Transcript completion is a supporting signal, not definitive
    // It can help reduce the confirmation time needed
    if (this._state === 'watching') {
      this.logAction('transcript', 'Transcript shows completion - boosting confidence');
      this.log('Transcript completion detected - may accelerate idle detection');
      // If we have a completion message and transcript confirms, try AI check
      if (this.completionMessageTime !== null) {
        this.tryStartAiCheck('transcript + completion message');
      }
    }
  }

  /**
   * Signal that the transcript indicates plan mode.
   * This helps prevent auto-accept from triggering on AskUserQuestion.
   */
  signalTranscriptPlanMode(): void {
    // Plan mode from transcript = potential AskUserQuestion
    // This is similar to elicitation detection
    if (this._state === 'watching') {
      this.logAction('transcript', 'Plan mode / AskUserQuestion detected');
      this.cancelAutoAcceptTimer();
    }
  }

  /**
   * Start completion confirmation timer.
   * After completion message, waits for output silence then triggers AI check.
   */
  private startCompletionConfirmTimer(): void {
    this.cancelTrackedTimer('completion-confirm', this.completionConfirmTimer, 'restarting');
    this.completionConfirmTimer = null;

    this.setState('confirming_idle');
    this.logAction('detection', 'Completion message found in output');

    this.completionConfirmTimer = this.startTrackedTimer(
      'completion-confirm',
      this.config.completionConfirmMs,
      () => {
        this.completionConfirmTimer = null;
        const msSinceOutput = Date.now() - this.lastOutputTime;
        if (msSinceOutput >= this.config.completionConfirmMs) {
          this.logAction('detection', `Silence confirmed: ${Math.round(msSinceOutput / 1000)}s`);
          this.tryStartAiCheck('completion + silence');
        } else {
          // Output received during wait, stay in confirming state and re-check
          this.logAction('detection', 'Output during confirmation, resetting');
          this.startCompletionConfirmTimer();
        }
      },
      'waiting for silence after completion'
    );
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
    this.cancelTrackedTimer('step-confirm', this.stepConfirmTimer, 'restarting');
    this.stepConfirmTimer = null;

    this.stepConfirmTimer = this.startTrackedTimer(
      'step-confirm',
      this.config.completionConfirmMs,
      () => {
        this.stepConfirmTimer = null;
        const msSinceOutput = Date.now() - this.lastOutputTime;

        if (msSinceOutput >= this.config.completionConfirmMs) {
          this.logAction('step', `${step} confirmed after ${Math.round(msSinceOutput / 1000)}s silence`);

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
          this.logAction('step', `Output during ${step} confirmation, resetting`);
          this.startStepConfirmTimer(step);
        }
      },
      `confirming ${step} completion`
    );
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
    // Safety check: if Session thinks it's still working, don't trigger idle
    // This catches cases where our detection missed working patterns
    if (this.session.isWorking) {
      this.log(`Idle confirmation rejected - Session reports isWorking=true (reason was: ${reason})`);
      this.logAction('detection', 'Rejected: Session still working');
      this.setState('watching');
      this.startNoOutputTimer();
      this.startPreFilterTimer();
      return;
    }

    this.log(`Idle confirmed via: ${reason}`);
    const status = this.getDetectionStatus();
    this.log(`Detection status: confidence=${status.confidenceLevel}%, ` +
      `completion=${status.completionMessageDetected}, ` +
      `silent=${status.outputSilent}, ` +
      `tokensStable=${status.tokensStable}, ` +
      `noWorking=${status.workingPatternsAbsent}`);

    // ========== RALPH_STATUS Integration ==========
    // Check circuit breaker status - if OPEN, pause respawn
    const ralphTracker = this.session.ralphTracker;
    if (ralphTracker) {
      const circuitBreaker = ralphTracker.circuitBreakerStatus;
      if (circuitBreaker.state === 'OPEN') {
        this.log(`Respawn blocked - Circuit breaker OPEN: ${circuitBreaker.reason}`);
        this.logAction('ralph', `Circuit breaker OPEN: ${circuitBreaker.reason}`);
        this.emit('respawnBlocked', { reason: 'circuit_breaker_open', details: circuitBreaker.reason });
        this.setState('watching');
        // Don't restart timers - wait for manual reset or circuit breaker resolution
        return;
      }
    }

    // Check RALPH_STATUS EXIT_SIGNAL - if true, loop is complete
    const statusBlock = ralphTracker?.lastStatusBlock;
    if (statusBlock?.exitSignal) {
      this.log(`Respawn paused - RALPH_STATUS EXIT_SIGNAL=true`);
      this.logAction('ralph', `Exit signal detected: ${statusBlock.recommendation || 'Task complete'}`);
      this.emit('respawnBlocked', { reason: 'exit_signal', details: statusBlock.recommendation || 'Task complete' });
      this.setState('watching');
      // Don't restart timers - loop is complete
      return;
    }

    // Check if STATUS=BLOCKED - trigger circuit breaker
    if (statusBlock?.status === 'BLOCKED') {
      this.log(`Respawn blocked - RALPH_STATUS reports BLOCKED`);
      this.logAction('ralph', `Claude reported BLOCKED: ${statusBlock.recommendation || 'Needs human intervention'}`);
      this.emit('respawnBlocked', { reason: 'status_blocked', details: statusBlock.recommendation || 'Needs human intervention' });
      this.setState('watching');
      return;
    }

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

    // P1-006: Session health check before respawn cycle
    // Skip if session is in error state or not running
    if (this.session.status === 'error') {
      this.log('Skipping respawn cycle - session is in error state');
      this.logAction('health', 'Respawn skipped: Session error state');
      this.emit('respawnBlocked', { reason: 'session_error', details: 'Session is in error state' });
      this.setState('watching');
      return;
    }

    if (this.session.status === 'stopped') {
      this.log('Skipping respawn cycle - session is stopped');
      this.logAction('health', 'Respawn skipped: Session stopped');
      this.emit('respawnBlocked', { reason: 'session_stopped', details: 'Session is stopped' });
      this.setState('watching');
      return;
    }

    // Check if session PTY is still alive (via PID)
    if (!this.session.pid) {
      this.log('Skipping respawn cycle - session PTY not running (no PID)');
      this.logAction('health', 'Respawn skipped: No PTY process');
      this.emit('respawnBlocked', { reason: 'no_pty', details: 'Session PTY process not running' });
      this.setState('watching');
      return;
    }

    // Start the respawn cycle
    this.cycleCount++;
    this.log(`Starting respawn cycle #${this.cycleCount}`);
    this.emit('respawnCycleStarted', this.cycleCount);

    // P2-004: Start tracking cycle metrics
    this.startCycleMetrics('idle_confirmed');

    this.sendUpdateDocs();
  }

  /**
   * Send the update docs prompt (first step of cycle).
   * Uses RALPH_STATUS RECOMMENDATION if available, otherwise falls back to configured prompt.
   * @fires stepSent - With step 'update'
   */
  private sendUpdateDocs(): void {
    this.setState('sending_update');
    this.terminalBuffer.clear(); // Clear buffer for fresh detection
    this.clearWorkingPatternWindow(); // Clear rolling window

    this.stepTimer = this.startTrackedTimer(
      'step-delay',
      this.config.interStepDelayMs,
      () => {
        this.stepTimer = null;

        // Use RALPH_STATUS RECOMMENDATION if available, otherwise fall back to config
        const statusBlock = this.session.ralphTracker?.lastStatusBlock;
        let updatePrompt = this.config.updatePrompt;

        if (statusBlock?.recommendation) {
          // Append RECOMMENDATION to the update prompt for context
          updatePrompt = `${this.config.updatePrompt}\n\nClaude's last recommendation: ${statusBlock.recommendation}`;
          this.logAction('ralph', `Using RECOMMENDATION: ${statusBlock.recommendation.substring(0, 50)}...`);
        }

        const input = updatePrompt + '\r';  // \r triggers Enter in Ink/Claude CLI
        this.logAction('command', `Sending: "${updatePrompt.substring(0, 50)}..."`);
        this.session.writeViaScreen(input);
        this.emit('stepSent', 'update', updatePrompt);
        this.setState('waiting_update');
        this.promptDetected = false;
        this.workingDetected = false;
      },
      'delay before update prompt'
    );
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
    this.clearWorkingPatternWindow();

    this.stepTimer = this.startTrackedTimer(
      'step-delay',
      this.config.interStepDelayMs,
      () => {
        this.stepTimer = null;
        this.logAction('command', 'Sending: /clear');
        this.session.writeViaScreen('/clear\r');  // \r triggers Enter in Ink/Claude CLI
        this.emit('stepSent', 'clear', '/clear');
        this.setState('waiting_clear');
        this.promptDetected = false;

        // Start fallback timer - if no prompt detected after 10s, proceed to /init anyway
        this.clearFallbackTimer = this.startTrackedTimer(
          'clear-fallback',
          RespawnController.CLEAR_FALLBACK_TIMEOUT_MS,
          () => {
            this.clearFallbackTimer = null;
            if (this._state === 'waiting_clear') {
              this.logAction('step', '/clear fallback: proceeding to /init');
              this.emit('stepCompleted', 'clear');
              if (this.config.sendInit) {
                this.sendInit();
              } else {
                this.completeCycle();
              }
            }
          },
          'fallback if no prompt after /clear'
        );
      },
      'delay before /clear'
    );
  }

  /**
   * Send /init command.
   * @fires stepSent - With step 'init'
   */
  private sendInit(): void {
    this.setState('sending_init');
    this.terminalBuffer.clear();
    this.clearWorkingPatternWindow();

    this.stepTimer = this.startTrackedTimer(
      'step-delay',
      this.config.interStepDelayMs,
      () => {
        this.stepTimer = null;
        this.logAction('command', 'Sending: /init');
        this.session.writeViaScreen('/init\r');  // \r triggers Enter in Ink/Claude CLI
        this.emit('stepSent', 'init', '/init');
        this.setState('waiting_init');
        this.promptDetected = false;
        this.workingDetected = false;
      },
      'delay before /init'
    );
  }

  /**
   * Complete the current respawn cycle.
   * Returns to watching state for next cycle.
   * @fires respawnCycleCompleted
   */
  private completeCycle(): void {
    this.log(`Respawn cycle #${this.cycleCount} completed`);
    this.emit('respawnCycleCompleted', this.cycleCount);

    // P2-004: Complete cycle metrics with success outcome
    this.completeCycleMetrics('success');

    // Go back to watching state for next cycle
    this.setState('watching');
    this.terminalBuffer.clear();
    this.clearWorkingPatternWindow(); // Clear rolling window for fresh detection
    this.promptDetected = false;
    this.workingDetected = false;
    this.resetHookState(); // Clear hook signals for next cycle

    // P2-001: Reset idle detection start time for next cycle
    this.idleDetectionStartTime = Date.now();

    // Restart detection timers for next cycle
    this.startNoOutputTimer();
    this.startPreFilterTimer();
    if (this.config.autoAcceptPrompts) {
      this.startAutoAcceptTimer();
    }
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
    // Filter out undefined values to prevent overwriting existing config with undefined
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined)
    ) as Partial<RespawnConfig>;
    this.config = { ...this.config, ...filteredConfig };

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

    // Sync plan checker config if relevant fields changed
    if (config.aiPlanCheckEnabled !== undefined || config.aiPlanCheckModel !== undefined ||
        config.aiPlanCheckMaxContext !== undefined || config.aiPlanCheckTimeoutMs !== undefined ||
        config.aiPlanCheckCooldownMs !== undefined) {
      this.planChecker.updateConfig({
        enabled: this.config.aiPlanCheckEnabled,
        model: this.config.aiPlanCheckModel,
        maxContextChars: this.config.aiPlanCheckMaxContext,
        checkTimeoutMs: this.config.aiPlanCheckTimeoutMs,
        cooldownMs: this.config.aiPlanCheckCooldownMs,
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

  // ========== P2-001: Adaptive Timing Methods ==========

  /**
   * Get the current completion confirm timeout, potentially adjusted by adaptive timing.
   * Uses historical idle detection durations to calculate an optimal timeout.
   *
   * @returns Completion confirm timeout in milliseconds
   */
  getAdaptiveCompletionConfirmMs(): number {
    if (!this.config.adaptiveTimingEnabled) {
      return this.config.completionConfirmMs ?? 10000;
    }

    // Need at least 5 samples before adjusting
    if (this.timingHistory.sampleCount < 5) {
      return this.config.completionConfirmMs ?? 10000;
    }

    return this.timingHistory.adaptiveCompletionConfirmMs;
  }

  /**
   * Record timing data from a completed cycle for adaptive adjustments.
   *
   * @param idleDetectionMs - Time spent detecting idle
   * @param cycleDurationMs - Total cycle duration
   */
  private recordTimingData(idleDetectionMs: number, cycleDurationMs: number): void {
    if (!this.config.adaptiveTimingEnabled) return;

    const history = this.timingHistory;

    // Add to rolling windows
    history.recentIdleDetectionMs.push(idleDetectionMs);
    history.recentCycleDurationMs.push(cycleDurationMs);

    // Trim to max samples
    if (history.recentIdleDetectionMs.length > history.maxSamples) {
      history.recentIdleDetectionMs.shift();
    }
    if (history.recentCycleDurationMs.length > history.maxSamples) {
      history.recentCycleDurationMs.shift();
    }

    history.sampleCount = history.recentIdleDetectionMs.length;
    history.lastUpdatedAt = Date.now();

    // Recalculate adaptive timing
    this.updateAdaptiveTiming();
  }

  /**
   * Recalculate the adaptive completion confirm timeout based on historical data.
   * Uses the 75th percentile of recent idle detection times as the new timeout,
   * with a 20% buffer for safety.
   */
  private updateAdaptiveTiming(): void {
    const history = this.timingHistory;
    const minMs = this.config.adaptiveMinConfirmMs ?? 5000;
    const maxMs = this.config.adaptiveMaxConfirmMs ?? 30000;

    if (history.recentIdleDetectionMs.length < 5) return;

    // Sort for percentile calculation
    const sorted = [...history.recentIdleDetectionMs].sort((a, b) => a - b);

    // Use 75th percentile with 20% buffer
    const p75Index = Math.floor(sorted.length * 0.75);
    const p75Value = sorted[p75Index];
    const withBuffer = Math.round(p75Value * 1.2);

    // Clamp to configured bounds
    const clamped = Math.max(minMs, Math.min(maxMs, withBuffer));

    history.adaptiveCompletionConfirmMs = clamped;
    this.log(`Adaptive timing updated: ${clamped}ms (p75=${p75Value}ms, samples=${sorted.length})`);
  }

  /**
   * Get the current timing history for monitoring.
   * @returns Copy of timing history
   */
  getTimingHistory(): TimingHistory {
    return { ...this.timingHistory };
  }

  // ========== P2-002: Skip-Clear Optimization Methods ==========

  /**
   * Determine whether to skip the /clear step based on current context usage.
   * Skips if token count is below the configured threshold percentage.
   *
   * @returns True if /clear should be skipped
   */
  private shouldSkipClear(): boolean {
    if (!this.config.skipClearWhenLowContext) return false;

    const thresholdPercent = this.config.skipClearThresholdPercent ?? 30;
    const maxContext = 200000; // Approximate max context for Claude

    // Use the session's token count if available
    const currentTokens = this.lastTokenCount;
    if (currentTokens === 0) return false; // Can't determine, don't skip

    const usagePercent = (currentTokens / maxContext) * 100;

    if (usagePercent < thresholdPercent) {
      this.log(`Skip-clear optimization: ${usagePercent.toFixed(1)}% < ${thresholdPercent}% threshold`);
      this.logAction('optimization', `Skipping /clear (${usagePercent.toFixed(1)}% context used)`);
      return true;
    }

    return false;
  }

  // ========== P2-004: Cycle Metrics Methods ==========

  /**
   * Start tracking metrics for a new cycle.
   * Called when a respawn cycle begins.
   */
  private startCycleMetrics(idleReason: string): void {
    if (!this.config.trackCycleMetrics) return;

    const now = Date.now();
    this.currentCycleMetrics = {
      cycleId: `${this.session.id}:${this.cycleCount}`,
      sessionId: this.session.id,
      cycleNumber: this.cycleCount,
      startedAt: now,
      idleReason,
      idleDetectionMs: now - this.idleDetectionStartTime,
      stepsCompleted: [],
      clearSkipped: false,
      tokenCountAtStart: this.lastTokenCount,
      completionConfirmMsUsed: this.getAdaptiveCompletionConfirmMs(),
    };
  }

  /**
   * Record a completed step in the current cycle.
   * @param step - Name of the step (e.g., 'update', 'clear', 'init')
   */
  private recordCycleStep(step: string): void {
    if (!this.config.trackCycleMetrics || !this.currentCycleMetrics) return;
    this.currentCycleMetrics.stepsCompleted?.push(step);
  }

  /**
   * Complete the current cycle metrics with outcome.
   * Adds to recent metrics and updates aggregates.
   *
   * @param outcome - Outcome of the cycle
   * @param errorMessage - Optional error message if outcome is 'error'
   */
  private completeCycleMetrics(outcome: CycleOutcome, errorMessage?: string): void {
    if (!this.config.trackCycleMetrics || !this.currentCycleMetrics) return;

    const now = Date.now();
    const metrics: RespawnCycleMetrics = {
      ...this.currentCycleMetrics as RespawnCycleMetrics,
      completedAt: now,
      durationMs: now - (this.currentCycleMetrics.startedAt ?? now),
      outcome,
      errorMessage,
      tokenCountAtEnd: this.lastTokenCount,
    };

    // Add to recent metrics
    this.recentCycleMetrics.push(metrics);
    if (this.recentCycleMetrics.length > RespawnController.MAX_CYCLE_METRICS_IN_MEMORY) {
      this.recentCycleMetrics.shift();
    }

    // Record timing data for adaptive timing
    this.recordTimingData(metrics.idleDetectionMs, metrics.durationMs);

    // Update aggregate metrics
    this.updateAggregateMetrics(metrics);

    // Clear current cycle
    this.currentCycleMetrics = null;

    this.log(`Cycle #${metrics.cycleNumber} metrics: ${outcome}, duration=${metrics.durationMs}ms, idle_detection=${metrics.idleDetectionMs}ms`);
  }

  /**
   * Update aggregate metrics with a new cycle's data.
   * @param metrics - The completed cycle metrics
   */
  private updateAggregateMetrics(metrics: RespawnCycleMetrics): void {
    const agg = this.aggregateMetrics;

    agg.totalCycles++;

    switch (metrics.outcome) {
      case 'success':
        agg.successfulCycles++;
        break;
      case 'stuck_recovery':
        agg.stuckRecoveryCycles++;
        break;
      case 'blocked':
        agg.blockedCycles++;
        break;
      case 'error':
        agg.errorCycles++;
        break;
      case 'cancelled':
        // Cancelled cycles don't count towards any specific category
        // but are still counted in totalCycles
        break;
      default:
        assertNever(metrics.outcome, `Unhandled CycleOutcome: ${metrics.outcome}`);
    }

    // Recalculate averages using all recent metrics
    const durations = this.recentCycleMetrics.map(m => m.durationMs);
    const idleTimes = this.recentCycleMetrics.map(m => m.idleDetectionMs);

    if (durations.length > 0) {
      agg.avgCycleDurationMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
      agg.avgIdleDetectionMs = Math.round(idleTimes.reduce((a, b) => a + b, 0) / idleTimes.length);

      // Calculate P90
      const sortedDurations = [...durations].sort((a, b) => a - b);
      const p90Index = Math.floor(sortedDurations.length * 0.9);
      agg.p90CycleDurationMs = sortedDurations[p90Index];
    }

    // Calculate success rate
    agg.successRate = agg.totalCycles > 0
      ? Math.round((agg.successfulCycles / agg.totalCycles) * 100)
      : 100;

    agg.lastUpdatedAt = Date.now();
  }

  /**
   * Get aggregate metrics for monitoring.
   * @returns Copy of aggregate metrics
   */
  getAggregateMetrics(): RespawnAggregateMetrics {
    return { ...this.aggregateMetrics };
  }

  /**
   * Get recent cycle metrics for analysis.
   * @param limit - Maximum number of metrics to return (default: 20)
   * @returns Recent cycle metrics, newest first
   */
  getRecentCycleMetrics(limit: number = 20): RespawnCycleMetrics[] {
    return this.recentCycleMetrics.slice(-limit).reverse();
  }

  // ========== P2-005: Health Score Methods ==========

  /**
   * Calculate a comprehensive health score for the Ralph Loop system.
   * Aggregates multiple health signals into a single score (0-100).
   *
   * @returns Health score with component breakdown
   */
  calculateHealthScore(): RalphLoopHealthScore {
    const now = Date.now();
    const components = {
      cycleSuccess: this.calculateCycleSuccessScore(),
      circuitBreaker: this.calculateCircuitBreakerScore(),
      iterationProgress: this.calculateIterationProgressScore(),
      aiChecker: this.calculateAiCheckerScore(),
      stuckRecovery: this.calculateStuckRecoveryScore(),
    };

    // Weighted average (cycle success is most important)
    const weights = {
      cycleSuccess: 0.35,
      circuitBreaker: 0.20,
      iterationProgress: 0.20,
      aiChecker: 0.15,
      stuckRecovery: 0.10,
    };

    const score = Math.round(
      components.cycleSuccess * weights.cycleSuccess +
      components.circuitBreaker * weights.circuitBreaker +
      components.iterationProgress * weights.iterationProgress +
      components.aiChecker * weights.aiChecker +
      components.stuckRecovery * weights.stuckRecovery
    );

    // Determine status
    let status: HealthStatus;
    if (score >= 90) status = 'excellent';
    else if (score >= 70) status = 'good';
    else if (score >= 50) status = 'degraded';
    else status = 'critical';

    // Generate recommendations
    const recommendations = this.generateHealthRecommendations(components);

    // Generate summary
    const summary = this.generateHealthSummary(score, status, components);

    return {
      score,
      status,
      components,
      summary,
      recommendations,
      calculatedAt: now,
    };
  }

  /**
   * Calculate score based on recent cycle success rate.
   */
  private calculateCycleSuccessScore(): number {
    if (this.aggregateMetrics.totalCycles === 0) return 100; // No data = assume healthy
    return this.aggregateMetrics.successRate;
  }

  /**
   * Calculate score based on circuit breaker state.
   */
  private calculateCircuitBreakerScore(): number {
    const tracker = this.session.ralphTracker;
    if (!tracker) return 100;

    const cb = tracker.circuitBreakerStatus;
    switch (cb.state) {
      case 'CLOSED': return 100;
      case 'HALF_OPEN': return 50;
      case 'OPEN': return 0;
      default: return 100;
    }
  }

  /**
   * Calculate score based on iteration progress.
   */
  private calculateIterationProgressScore(): number {
    const tracker = this.session.ralphTracker;
    if (!tracker) return 100;

    const stallMetrics = tracker.getIterationStallMetrics();
    const { stallDurationMs, warningThresholdMs, criticalThresholdMs } = stallMetrics;

    if (stallDurationMs >= criticalThresholdMs) return 0;
    if (stallDurationMs >= warningThresholdMs) return 30;
    if (stallDurationMs >= warningThresholdMs / 2) return 70;
    return 100;
  }

  /**
   * Calculate score based on AI checker health.
   */
  private calculateAiCheckerScore(): number {
    const state = this.aiChecker.getState();
    if (state.status === 'disabled') return 30;
    if (state.status === 'cooldown') return 70;
    if (state.consecutiveErrors > 0) return 50;
    return 100;
  }

  /**
   * Calculate score based on stuck-state recovery count.
   */
  private calculateStuckRecoveryScore(): number {
    const maxRecoveries = this.config.maxStuckRecoveries ?? 3;
    if (this.stuckRecoveryCount === 0) return 100;
    if (this.stuckRecoveryCount >= maxRecoveries) return 0;
    return Math.round(100 - (this.stuckRecoveryCount / maxRecoveries) * 100);
  }

  /**
   * Generate health recommendations based on component scores.
   */
  private generateHealthRecommendations(components: RalphLoopHealthScore['components']): string[] {
    const recommendations: string[] = [];

    if (components.cycleSuccess < 70) {
      recommendations.push('Cycle success rate is low. Check for recurring errors or stuck states.');
    }
    if (components.circuitBreaker < 50) {
      recommendations.push('Circuit breaker is open or half-open. Review recent errors and consider manual reset.');
    }
    if (components.iterationProgress < 50) {
      recommendations.push('Iteration progress has stalled. Check if Claude is stuck on a task.');
    }
    if (components.aiChecker < 50) {
      recommendations.push('AI idle checker has errors. May need to check Claude CLI availability.');
    }
    if (components.stuckRecovery < 50) {
      recommendations.push('Multiple stuck-state recoveries occurred. Consider increasing timeouts.');
    }

    if (recommendations.length === 0) {
      recommendations.push('System is healthy. No action needed.');
    }

    return recommendations;
  }

  /**
   * Generate a human-readable health summary.
   */
  private generateHealthSummary(
    score: number,
    status: HealthStatus,
    components: RalphLoopHealthScore['components']
  ): string {
    const lowest = Object.entries(components).reduce((min, [key, val]) =>
      val < min.val ? { key, val } : min, { key: '', val: 100 });

    if (status === 'excellent') {
      return `Ralph Loop is operating excellently (${score}/100). All systems healthy.`;
    }
    if (status === 'good') {
      return `Ralph Loop is operating well (${score}/100). Minor issues in ${lowest.key}.`;
    }
    if (status === 'degraded') {
      return `Ralph Loop is degraded (${score}/100). Primary issue: ${lowest.key} (${lowest.val}/100).`;
    }
    return `Ralph Loop is in critical state (${score}/100). Immediate attention needed: ${lowest.key}.`;
  }
}
