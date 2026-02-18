/**
 * @fileoverview Test Utilities for RespawnController Tests
 *
 * Provides mocks, helpers, and utilities for testing the RespawnController
 * and its related AI checker components without spawning real Claude CLI processes.
 *
 * ## Contents
 *
 * - MockSession: Enhanced mock session for testing
 * - MockAiIdleChecker: Mock for AI idle checker with configurable verdicts
 * - MockAiPlanChecker: Mock for AI plan mode checker with configurable verdicts
 * - State transition helpers
 * - Time manipulation utilities
 * - Factory functions for pre-configured controllers
 *
 * @module test/respawn-test-utils
 */

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { Session } from '../src/session.js';
import type { RespawnConfig, RespawnState, DetectionStatus } from '../src/respawn-controller.js';
import type {
  AiCheckResult,
  AiCheckState,
  AiCheckStatus,
  AiCheckVerdict,
  AiIdleCheckConfig,
} from '../src/ai-idle-checker.js';
import type {
  AiPlanCheckResult,
  AiPlanCheckState,
  AiPlanCheckStatus,
  AiPlanCheckVerdict,
  AiPlanCheckConfig,
} from '../src/ai-plan-checker.js';

// ========== Time Manipulation Utilities ==========

/**
 * Time controller for testing timeout-based behavior.
 * Uses vitest's fake timers for deterministic time control.
 */
export interface TimeController {
  /** Advance time by the specified milliseconds */
  advanceBy(ms: number): Promise<void>;
  /** Advance to the next timer */
  advanceToNextTimer(): Promise<void>;
  /** Run all pending timers */
  runAllTimers(): Promise<void>;
  /** Get the current fake time */
  now(): number;
  /** Reset to real timers */
  useRealTimers(): void;
}

/**
 * Create a time controller for testing timeout-based behavior.
 * Call this in beforeEach and cleanup with controller.useRealTimers() in afterEach.
 */
export function createTimeController(): TimeController {
  vi.useFakeTimers();

  return {
    async advanceBy(ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms);
    },
    async advanceToNextTimer(): Promise<void> {
      await vi.runOnlyPendingTimersAsync();
    },
    async runAllTimers(): Promise<void> {
      await vi.runAllTimersAsync();
    },
    now(): number {
      return Date.now();
    },
    useRealTimers(): void {
      vi.useRealTimers();
    },
  };
}

// ========== MockSession ==========

/**
 * Enhanced mock session for testing RespawnController.
 * Extends the existing MockSession pattern with additional utilities.
 */
export class MockSession extends EventEmitter {
  id: string;
  workingDir: string = '/tmp/test-workdir';
  status: 'idle' | 'working' = 'idle';
  writeBuffer: string[] = [];
  terminalBuffer: string = '';

  private _muxName: string | null = null;

  constructor(id: string = 'mock-session-id') {
    super();
    this.id = id;
    this._muxName = `claudeman-test-${id.slice(0, 8)}`;
  }

  /** Direct PTY write (used by session.write()) */
  write(data: string): void {
    this.writeBuffer.push(data);
  }

  /** Write via mux (used by respawn controller) */
  async writeViaMux(data: string): Promise<boolean> {
    this.writeBuffer.push(data);
    return true;
  }

  /** Get the last written data */
  get lastWrite(): string | undefined {
    return this.writeBuffer[this.writeBuffer.length - 1];
  }

  /** Clear the write buffer */
  clearWriteBuffer(): void {
    this.writeBuffer = [];
  }

  /** Check if a specific command was written */
  hasWritten(pattern: string | RegExp): boolean {
    return this.writeBuffer.some(data =>
      typeof pattern === 'string' ? data.includes(pattern) : pattern.test(data)
    );
  }

  // ========== Terminal Output Simulation ==========

  /** Simulate raw terminal output */
  simulateTerminalOutput(data: string): void {
    this.terminalBuffer += data;
    this.emit('terminal', data);
  }

  /** Simulate prompt appearing (legacy fallback signal) */
  simulatePrompt(): void {
    this.simulateTerminalOutput('\u276f ');
    this.status = 'idle';
    this.emit('idle');
  }

  /** Simulate ready state with definitive indicator (legacy) */
  simulateReady(): void {
    this.simulateTerminalOutput('\u21b5 send');
    this.status = 'idle';
    this.emit('idle');
  }

  /**
   * Simulate completion message (primary idle detection in Claude Code 2024+).
   * This triggers the multi-layer detection flow.
   */
  simulateCompletionMessage(duration: string = '2m 46s'): void {
    this.simulateTerminalOutput(`\u273b Worked for ${duration}`);
    this.status = 'idle';
  }

  /** Simulate working state with spinner */
  simulateWorking(text: string = 'Thinking'): void {
    this.simulateTerminalOutput(`${text}... \u280b`);
    this.status = 'working';
    this.emit('working');
  }

  /** Simulate /clear completion */
  simulateClearComplete(): void {
    this.simulateTerminalOutput('conversation cleared');
    setTimeout(() => this.simulateCompletionMessage(), 50);
  }

  /** Simulate /init completion */
  simulateInitComplete(): void {
    this.simulateTerminalOutput('Analyzing CLAUDE.md...');
    setTimeout(() => this.simulateCompletionMessage(), 100);
  }

  /**
   * Simulate plan mode approval prompt.
   * This triggers auto-accept detection.
   */
  simulatePlanModePrompt(): void {
    this.simulateTerminalOutput(
      'Would you like to proceed with this plan?\n' +
      '\u276f 1. Yes\n' +
      '  2. No\n' +
      '  3. Type your own\n'
    );
  }

  /**
   * Simulate elicitation dialog (AskUserQuestion).
   * This should block auto-accept.
   */
  simulateElicitationDialog(): void {
    this.simulateTerminalOutput(
      'What would you like to name the new file?\n' +
      '> '
    );
  }

  /** Simulate token count display */
  simulateTokenCount(tokens: number | string): void {
    const formatted = typeof tokens === 'number'
      ? tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
      : tokens;
    this.simulateTerminalOutput(`${formatted} tokens used`);
  }

  /** Simulate ANSI escape codes */
  simulateAnsiOutput(text: string, color: 'green' | 'red' | 'blue' = 'green'): void {
    const codes: Record<string, string> = {
      green: '\x1b[32m',
      red: '\x1b[31m',
      blue: '\x1b[34m',
    };
    this.simulateTerminalOutput(`${codes[color]}${text}\x1b[0m`);
  }

  /** Clear terminal buffer */
  clearTerminalBuffer(): void {
    this.terminalBuffer = '';
  }

  // ========== Session Lifecycle ==========

  /** Simulate session closing */
  close(): void {
    this.emit('exit', 0);
    this.removeAllListeners();
  }

  /** Get mux name (for mux-based operations) */
  get muxName(): string | null {
    return this._muxName;
  }
}

// ========== MockAiIdleChecker ==========

/**
 * Configuration for MockAiIdleChecker behavior.
 */
export interface MockAiIdleCheckerOptions {
  /** Default verdict to return */
  defaultVerdict?: AiCheckVerdict;
  /** Default reasoning to include */
  defaultReasoning?: string;
  /** Simulated check duration in ms */
  checkDurationMs?: number;
  /** Whether to start in disabled state */
  startDisabled?: boolean;
  /** Reason if starting disabled */
  disabledReason?: string;
}

/**
 * Mock AI idle checker for testing without spawning real Claude CLI.
 * Allows configuring verdicts and simulating various states.
 */
export class MockAiIdleChecker extends EventEmitter {
  private config: AiIdleCheckConfig;
  private _status: AiCheckStatus = 'ready';
  private _lastVerdict: AiCheckVerdict | null = null;
  private _lastReasoning: string | null = null;
  private _lastCheckDurationMs: number | null = null;
  private _cooldownEndsAt: number | null = null;
  private _consecutiveErrors: number = 0;
  private _totalChecks: number = 0;
  private _disabledReason: string | null = null;

  // Queued results for sequential calls
  private queuedResults: AiCheckResult[] = [];
  private defaultOptions: MockAiIdleCheckerOptions;
  private cooldownTimer: NodeJS.Timeout | null = null;

  constructor(
    public sessionId: string,
    config: Partial<AiIdleCheckConfig> = {},
    options: MockAiIdleCheckerOptions = {}
  ) {
    super();
    this.config = {
      enabled: true,
      model: 'claude-opus-4-5-20251101',
      maxContextChars: 16000,
      checkTimeoutMs: 90000,
      cooldownMs: 180000,
      errorCooldownMs: 60000,
      maxConsecutiveErrors: 3,
      ...config,
    };
    this.defaultOptions = {
      defaultVerdict: 'IDLE',
      defaultReasoning: 'Mock verdict',
      checkDurationMs: 100,
      startDisabled: false,
      ...options,
    };

    if (this.defaultOptions.startDisabled) {
      this._status = 'disabled';
      this._disabledReason = this.defaultOptions.disabledReason || 'Disabled for testing';
    }
  }

  get status(): AiCheckStatus {
    return this._status;
  }

  getState(): AiCheckState {
    return {
      status: this._status,
      lastVerdict: this._lastVerdict,
      lastReasoning: this._lastReasoning,
      lastCheckDurationMs: this._lastCheckDurationMs,
      cooldownEndsAt: this._cooldownEndsAt,
      consecutiveErrors: this._consecutiveErrors,
      totalChecks: this._totalChecks,
      disabledReason: this._disabledReason,
    };
  }

  isOnCooldown(): boolean {
    return this._cooldownEndsAt !== null && Date.now() < this._cooldownEndsAt;
  }

  getCooldownRemainingMs(): number {
    if (this._cooldownEndsAt === null) return 0;
    return Math.max(0, this._cooldownEndsAt - Date.now());
  }

  /**
   * Queue a result to be returned on the next check() call.
   * Results are consumed in FIFO order.
   */
  queueResult(result: AiCheckResult): void {
    this.queuedResults.push(result);
  }

  /**
   * Queue multiple results for sequential check() calls.
   */
  queueResults(...results: AiCheckResult[]): void {
    this.queuedResults.push(...results);
  }

  /**
   * Set the next check to return IDLE verdict.
   */
  setNextIdle(reasoning: string = 'Mock: IDLE'): void {
    this.queueResult({
      verdict: 'IDLE',
      reasoning,
      durationMs: this.defaultOptions.checkDurationMs || 100,
    });
  }

  /**
   * Set the next check to return WORKING verdict.
   */
  setNextWorking(reasoning: string = 'Mock: WORKING'): void {
    this.queueResult({
      verdict: 'WORKING',
      reasoning,
      durationMs: this.defaultOptions.checkDurationMs || 100,
    });
  }

  /**
   * Set the next check to return ERROR verdict.
   */
  setNextError(reasoning: string = 'Mock: ERROR'): void {
    this.queueResult({
      verdict: 'ERROR',
      reasoning,
      durationMs: this.defaultOptions.checkDurationMs || 100,
    });
  }

  async check(_terminalBuffer: string): Promise<AiCheckResult> {
    if (this._status === 'disabled') {
      return { verdict: 'ERROR', reasoning: `Disabled: ${this._disabledReason}`, durationMs: 0 };
    }

    if (this.isOnCooldown()) {
      return { verdict: 'ERROR', reasoning: 'On cooldown', durationMs: 0 };
    }

    if (this._status === 'checking') {
      return { verdict: 'ERROR', reasoning: 'Already checking', durationMs: 0 };
    }

    this._status = 'checking';
    this._totalChecks++;
    this.emit('checkStarted');

    // Simulate async check
    await new Promise(resolve => setTimeout(resolve, 10));

    // Get result from queue or use default
    const result = this.queuedResults.shift() || {
      verdict: this.defaultOptions.defaultVerdict!,
      reasoning: this.defaultOptions.defaultReasoning!,
      durationMs: this.defaultOptions.checkDurationMs!,
    };

    this._lastVerdict = result.verdict;
    this._lastReasoning = result.reasoning;
    this._lastCheckDurationMs = result.durationMs;

    if (result.verdict === 'IDLE') {
      this._consecutiveErrors = 0;
      this._status = 'ready';
    } else if (result.verdict === 'WORKING') {
      this._consecutiveErrors = 0;
      this.startCooldown(this.config.cooldownMs);
    } else {
      this._consecutiveErrors++;
      if (this._consecutiveErrors >= this.config.maxConsecutiveErrors) {
        this._status = 'disabled';
        this._disabledReason = `${this.config.maxConsecutiveErrors} consecutive errors`;
        this.emit('disabled', this._disabledReason);
      } else {
        this.startCooldown(this.config.errorCooldownMs);
      }
    }

    this.emit('checkCompleted', result);
    return result;
  }

  cancel(): void {
    if (this._status === 'checking') {
      this._status = 'ready';
      this.emit('log', '[MockAiIdleChecker] Check cancelled');
    }
  }

  reset(): void {
    this.cancel();
    this.clearCooldown();
    this._lastVerdict = null;
    this._lastReasoning = null;
    this._lastCheckDurationMs = null;
    this._consecutiveErrors = 0;
    this.queuedResults = [];
    this._status = this._disabledReason ? 'disabled' : 'ready';
  }

  updateConfig(config: Partial<AiIdleCheckConfig>): void {
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined)
    ) as Partial<AiIdleCheckConfig>;
    this.config = { ...this.config, ...filteredConfig };
    if (config.enabled === false) {
      this._disabledReason = 'Disabled by config';
      this._status = 'disabled';
    } else if (config.enabled === true && this._status === 'disabled') {
      this._disabledReason = null;
      this._status = 'ready';
    }
  }

  getConfig(): AiIdleCheckConfig {
    return { ...this.config };
  }

  // ========== Test Helpers ==========

  /** Force into cooldown state for testing */
  forceCooldown(durationMs: number): void {
    this.startCooldown(durationMs);
  }

  /** Force into disabled state for testing */
  forceDisabled(reason: string = 'Forced disabled for testing'): void {
    this._status = 'disabled';
    this._disabledReason = reason;
    this.emit('disabled', reason);
  }

  /** Force ready state for testing */
  forceReady(): void {
    this.clearCooldown();
    this._status = 'ready';
    this._disabledReason = null;
  }

  private startCooldown(durationMs: number): void {
    this.clearCooldown();
    this._cooldownEndsAt = Date.now() + durationMs;
    this._status = 'cooldown';
    this.emit('cooldownStarted', this._cooldownEndsAt);

    this.cooldownTimer = setTimeout(() => {
      this._cooldownEndsAt = null;
      this._status = 'ready';
      this.emit('cooldownEnded');
    }, durationMs);
  }

  private clearCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this._cooldownEndsAt = null;
    if (this._status === 'cooldown') {
      this._status = 'ready';
    }
  }
}

// ========== MockAiPlanChecker ==========

/**
 * Configuration for MockAiPlanChecker behavior.
 */
export interface MockAiPlanCheckerOptions {
  /** Default verdict to return */
  defaultVerdict?: AiPlanCheckVerdict;
  /** Default reasoning to include */
  defaultReasoning?: string;
  /** Simulated check duration in ms */
  checkDurationMs?: number;
  /** Whether to start in disabled state */
  startDisabled?: boolean;
  /** Reason if starting disabled */
  disabledReason?: string;
}

/**
 * Mock AI plan checker for testing without spawning real Claude CLI.
 * Allows configuring verdicts and simulating various states.
 */
export class MockAiPlanChecker extends EventEmitter {
  private config: AiPlanCheckConfig;
  private _status: AiPlanCheckStatus = 'ready';
  private _lastVerdict: AiPlanCheckVerdict | null = null;
  private _lastReasoning: string | null = null;
  private _lastCheckDurationMs: number | null = null;
  private _cooldownEndsAt: number | null = null;
  private _consecutiveErrors: number = 0;
  private _totalChecks: number = 0;
  private _disabledReason: string | null = null;

  // Queued results for sequential calls
  private queuedResults: AiPlanCheckResult[] = [];
  private defaultOptions: MockAiPlanCheckerOptions;
  private cooldownTimer: NodeJS.Timeout | null = null;

  constructor(
    public sessionId: string,
    config: Partial<AiPlanCheckConfig> = {},
    options: MockAiPlanCheckerOptions = {}
  ) {
    super();
    this.config = {
      enabled: true,
      model: 'claude-opus-4-5-20251101',
      maxContextChars: 8000,
      checkTimeoutMs: 60000,
      cooldownMs: 30000,
      errorCooldownMs: 30000,
      maxConsecutiveErrors: 3,
      ...config,
    };
    this.defaultOptions = {
      defaultVerdict: 'PLAN_MODE',
      defaultReasoning: 'Mock verdict',
      checkDurationMs: 100,
      startDisabled: false,
      ...options,
    };

    if (this.defaultOptions.startDisabled) {
      this._status = 'disabled';
      this._disabledReason = this.defaultOptions.disabledReason || 'Disabled for testing';
    }
  }

  get status(): AiPlanCheckStatus {
    return this._status;
  }

  getState(): AiPlanCheckState {
    return {
      status: this._status,
      lastVerdict: this._lastVerdict,
      lastReasoning: this._lastReasoning,
      lastCheckDurationMs: this._lastCheckDurationMs,
      cooldownEndsAt: this._cooldownEndsAt,
      consecutiveErrors: this._consecutiveErrors,
      totalChecks: this._totalChecks,
      disabledReason: this._disabledReason,
    };
  }

  isOnCooldown(): boolean {
    return this._cooldownEndsAt !== null && Date.now() < this._cooldownEndsAt;
  }

  getCooldownRemainingMs(): number {
    if (this._cooldownEndsAt === null) return 0;
    return Math.max(0, this._cooldownEndsAt - Date.now());
  }

  /**
   * Queue a result to be returned on the next check() call.
   */
  queueResult(result: AiPlanCheckResult): void {
    this.queuedResults.push(result);
  }

  /**
   * Queue multiple results for sequential check() calls.
   */
  queueResults(...results: AiPlanCheckResult[]): void {
    this.queuedResults.push(...results);
  }

  /**
   * Set the next check to return PLAN_MODE verdict.
   */
  setNextPlanMode(reasoning: string = 'Mock: PLAN_MODE'): void {
    this.queueResult({
      verdict: 'PLAN_MODE',
      reasoning,
      durationMs: this.defaultOptions.checkDurationMs || 100,
    });
  }

  /**
   * Set the next check to return NOT_PLAN_MODE verdict.
   */
  setNextNotPlanMode(reasoning: string = 'Mock: NOT_PLAN_MODE'): void {
    this.queueResult({
      verdict: 'NOT_PLAN_MODE',
      reasoning,
      durationMs: this.defaultOptions.checkDurationMs || 100,
    });
  }

  /**
   * Set the next check to return ERROR verdict.
   */
  setNextError(reasoning: string = 'Mock: ERROR'): void {
    this.queueResult({
      verdict: 'ERROR',
      reasoning,
      durationMs: this.defaultOptions.checkDurationMs || 100,
    });
  }

  async check(_terminalBuffer: string): Promise<AiPlanCheckResult> {
    if (this._status === 'disabled') {
      return { verdict: 'ERROR', reasoning: `Disabled: ${this._disabledReason}`, durationMs: 0 };
    }

    if (this.isOnCooldown()) {
      return { verdict: 'ERROR', reasoning: 'On cooldown', durationMs: 0 };
    }

    if (this._status === 'checking') {
      return { verdict: 'ERROR', reasoning: 'Already checking', durationMs: 0 };
    }

    this._status = 'checking';
    this._totalChecks++;
    this.emit('checkStarted');

    // Simulate async check
    await new Promise(resolve => setTimeout(resolve, 10));

    // Get result from queue or use default
    const result = this.queuedResults.shift() || {
      verdict: this.defaultOptions.defaultVerdict!,
      reasoning: this.defaultOptions.defaultReasoning!,
      durationMs: this.defaultOptions.checkDurationMs!,
    };

    this._lastVerdict = result.verdict;
    this._lastReasoning = result.reasoning;
    this._lastCheckDurationMs = result.durationMs;

    if (result.verdict === 'PLAN_MODE') {
      this._consecutiveErrors = 0;
      this._status = 'ready';
    } else if (result.verdict === 'NOT_PLAN_MODE') {
      this._consecutiveErrors = 0;
      this.startCooldown(this.config.cooldownMs);
    } else {
      this._consecutiveErrors++;
      if (this._consecutiveErrors >= this.config.maxConsecutiveErrors) {
        this._status = 'disabled';
        this._disabledReason = `${this.config.maxConsecutiveErrors} consecutive errors`;
        this.emit('disabled', this._disabledReason);
      } else {
        this.startCooldown(this.config.errorCooldownMs);
      }
    }

    this.emit('checkCompleted', result);
    return result;
  }

  cancel(): void {
    if (this._status === 'checking') {
      this._status = 'ready';
      this.emit('log', '[MockAiPlanChecker] Check cancelled');
    }
  }

  reset(): void {
    this.cancel();
    this.clearCooldown();
    this._lastVerdict = null;
    this._lastReasoning = null;
    this._lastCheckDurationMs = null;
    this._consecutiveErrors = 0;
    this.queuedResults = [];
    this._status = this._disabledReason ? 'disabled' : 'ready';
  }

  updateConfig(config: Partial<AiPlanCheckConfig>): void {
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined)
    ) as Partial<AiPlanCheckConfig>;
    this.config = { ...this.config, ...filteredConfig };
    if (config.enabled === false) {
      this._disabledReason = 'Disabled by config';
      this._status = 'disabled';
    } else if (config.enabled === true && this._status === 'disabled') {
      this._disabledReason = null;
      this._status = 'ready';
    }
  }

  getConfig(): AiPlanCheckConfig {
    return { ...this.config };
  }

  // ========== Test Helpers ==========

  /** Force into cooldown state for testing */
  forceCooldown(durationMs: number): void {
    this.startCooldown(durationMs);
  }

  /** Force into disabled state for testing */
  forceDisabled(reason: string = 'Forced disabled for testing'): void {
    this._status = 'disabled';
    this._disabledReason = reason;
    this.emit('disabled', reason);
  }

  /** Force ready state for testing */
  forceReady(): void {
    this.clearCooldown();
    this._status = 'ready';
    this._disabledReason = null;
  }

  private startCooldown(durationMs: number): void {
    this.clearCooldown();
    this._cooldownEndsAt = Date.now() + durationMs;
    this._status = 'cooldown';
    this.emit('cooldownStarted', this._cooldownEndsAt);

    this.cooldownTimer = setTimeout(() => {
      this._cooldownEndsAt = null;
      this._status = 'ready';
      this.emit('cooldownEnded');
    }, durationMs);
  }

  private clearCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this._cooldownEndsAt = null;
    if (this._status === 'cooldown') {
      this._status = 'ready';
    }
  }
}

// ========== State Transition Helpers ==========

/**
 * State transition event for tracking.
 */
export interface StateTransition {
  from: RespawnState;
  to: RespawnState;
  timestamp: number;
}

/**
 * Create a state tracker that records all state transitions.
 * Attach to a RespawnController via controller.on('stateChanged', tracker.record).
 */
export function createStateTracker() {
  const transitions: StateTransition[] = [];

  return {
    /** Record a state transition (use as event handler) */
    record(to: RespawnState, from: RespawnState): void {
      transitions.push({ from, to, timestamp: Date.now() });
    },

    /** Get all recorded transitions */
    getTransitions(): StateTransition[] {
      return [...transitions];
    },

    /** Get only the state values (not timestamps) */
    getStates(): RespawnState[] {
      return transitions.map(t => t.to);
    },

    /** Check if a specific state was visited */
    hasVisited(state: RespawnState): boolean {
      return transitions.some(t => t.to === state);
    },

    /** Check if a specific transition occurred */
    hasTransition(from: RespawnState, to: RespawnState): boolean {
      return transitions.some(t => t.from === from && t.to === to);
    },

    /** Get the most recent state */
    getCurrentState(): RespawnState | undefined {
      return transitions.length > 0 ? transitions[transitions.length - 1].to : undefined;
    },

    /** Clear all recorded transitions */
    clear(): void {
      transitions.length = 0;
    },
  };
}

/**
 * Create an event recorder for tracking all events from a RespawnController.
 */
export function createEventRecorder() {
  const events: Array<{ type: string; args: unknown[]; timestamp: number }> = [];

  return {
    /** Create a handler for a specific event type */
    handler(type: string): (...args: unknown[]) => void {
      return (...args: unknown[]) => {
        events.push({ type, args, timestamp: Date.now() });
      };
    },

    /** Get all recorded events */
    getEvents(): Array<{ type: string; args: unknown[]; timestamp: number }> {
      return [...events];
    },

    /** Get events of a specific type */
    getEventsOfType(type: string): Array<{ type: string; args: unknown[]; timestamp: number }> {
      return events.filter(e => e.type === type);
    },

    /** Check if an event type was emitted */
    hasEvent(type: string): boolean {
      return events.some(e => e.type === type);
    },

    /** Count events of a specific type */
    countEvents(type: string): number {
      return events.filter(e => e.type === type).length;
    },

    /** Clear all recorded events */
    clear(): void {
      events.length = 0;
    },
  };
}

// ========== Factory Functions ==========

/**
 * Default fast test configuration.
 * Uses short timeouts for faster test execution.
 */
export const FAST_TEST_CONFIG: Partial<RespawnConfig> = {
  idleTimeoutMs: 50,
  interStepDelayMs: 20,
  completionConfirmMs: 50,
  noOutputTimeoutMs: 300,
  autoAcceptDelayMs: 100,
  aiIdleCheckEnabled: false,
  aiPlanCheckEnabled: false,
};

/**
 * Configuration with AI checks enabled but short timeouts.
 */
export const AI_ENABLED_TEST_CONFIG: Partial<RespawnConfig> = {
  ...FAST_TEST_CONFIG,
  aiIdleCheckEnabled: true,
  aiIdleCheckTimeoutMs: 500,
  aiIdleCheckCooldownMs: 200,
  aiPlanCheckEnabled: true,
  aiPlanCheckTimeoutMs: 500,
  aiPlanCheckCooldownMs: 200,
};

/**
 * Create a mock session typed as Session for use with RespawnController.
 */
export function createMockSession(id?: string): MockSession & Session {
  return new MockSession(id) as MockSession & Session;
}

// ========== Test Assertion Helpers ==========

/**
 * Wait for a specific state to be reached.
 * Useful for async state transition testing.
 */
export async function waitForState(
  controller: { state: RespawnState; on: (event: string, handler: (state: RespawnState) => void) => void },
  targetState: RespawnState,
  timeoutMs: number = 1000
): Promise<void> {
  if (controller.state === targetState) return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for state ${targetState}, current: ${controller.state}`));
    }, timeoutMs);

    const handler = (state: RespawnState) => {
      if (state === targetState) {
        clearTimeout(timeout);
        resolve();
      }
    };

    controller.on('stateChanged', handler);
  });
}

/**
 * Wait for a specific event to be emitted.
 */
export async function waitForEvent<T = unknown>(
  emitter: EventEmitter,
  eventName: string,
  timeoutMs: number = 1000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for event ${eventName}`));
    }, timeoutMs);

    emitter.once(eventName, (...args: unknown[]) => {
      clearTimeout(timeout);
      resolve(args[0] as T);
    });
  });
}

/**
 * Create a deferred promise for controlled async testing.
 */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ========== Terminal Output Generators ==========

/**
 * Generate realistic terminal output for testing.
 */
export const terminalOutputs = {
  /** Standard completion message */
  completion(duration: string = '2m 46s'): string {
    return `\n\u273b Worked for ${duration}\n  123.4k tokens used\n`;
  },

  /** Working spinner output */
  working(activity: string = 'Thinking'): string {
    return `${activity}... \u280b`;
  },

  /** Plan mode prompt */
  planMode(question: string = 'Would you like to proceed?'): string {
    return [
      `\n${question}\n`,
      '\u276f 1. Yes\n',
      '  2. No\n',
      '  3. Type your own\n',
    ].join('');
  },

  /** Prompt character */
  prompt(): string {
    return '\n\u276f ';
  },

  /** Token count display */
  tokens(count: number): string {
    const formatted = count >= 1000000
      ? `${(count / 1000000).toFixed(1)}M`
      : count >= 1000
        ? `${(count / 1000).toFixed(1)}k`
        : String(count);
    return `  ${formatted} tokens\n`;
  },

  /** Large output for buffer testing */
  largeOutput(sizeKb: number = 100): string {
    const baseText = 'Lorem ipsum dolor sit amet. '.repeat(100);
    const repetitions = Math.ceil((sizeKb * 1024) / baseText.length);
    return baseText.repeat(repetitions).slice(0, sizeKb * 1024);
  },

  /** ANSI colored output */
  ansiColored(text: string): string {
    return `\x1b[32m${text}\x1b[0m`;
  },
};
