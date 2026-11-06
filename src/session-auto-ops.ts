/**
 * @fileoverview Auto-compact, auto-clear, and auto-resume automation for Session.
 *
 * Monitors the context size and triggers /compact or /clear commands when
 * configurable thresholds are reached. The size comes from the statusline report
 * when the session has one and from the session's token counter otherwise (see
 * decideAutoThreshold). Waits for Claude to be idle before sending commands, with
 * retry logic and mutual exclusion (compact and clear never run simultaneously).
 *
 * Also implements auto-resume on usage limit ("token pause" control):
 * when enabled and Claude stops on a usage-limit message ("5-hour limit
 * reached ∙ resets 8pm" and friends — see usage-limit-patterns.ts), a timer
 * is armed for the parsed reset time plus a safety buffer, then Escape
 * (dismisses the rate-limit options dialog if open) and a "continue" prompt
 * are sent so work resumes automatically. If the session is still limited,
 * the fresh limit message re-arms the scheduler — that retry loop is the
 * safety net for clock skew and parse imprecision.
 *
 * @module session-auto-ops
 */

import { EventEmitter } from 'node:events';
import { detectUsageLimitPause } from './usage-limit-patterns.js';
import { toSingleLine } from './utils/index.js';

// ============================================================================
// Timing Constants
// ============================================================================

/** Delay for auto-compact/clear retry attempts (2 seconds) */
const AUTO_RETRY_DELAY_MS = 2000;

/** Delay for auto-compact/clear initial check (1 second) */
const AUTO_INITIAL_DELAY_MS = 1000;

/** Cooldown after compact completes before re-enabling (10 seconds) */
const COMPACT_COOLDOWN_MS = 10000;

/** Cooldown after clear completes before re-enabling (5 seconds) */
const CLEAR_COOLDOWN_MS = 5000;

/**
 * Executes an action when the session becomes idle, retrying if currently working.
 *
 * @param action - The async action to execute once idle
 * @param isActive - Returns whether this operation is still active (not cancelled)
 * @param isWorking - Returns whether the session is currently working
 * @param isStopped - Returns whether the session has been stopped
 * @param retryMs - Delay between retry attempts when working
 * @param cooldownMs - Delay after action completes before calling onCooldownDone
 * @param setTimer - Stores the timer reference for cleanup
 * @param onCooldownDone - Called after cooldown to reset state
 */
async function executeWhenIdle(
  action: () => Promise<void>,
  isActive: () => boolean,
  isWorking: () => boolean,
  isStopped: () => boolean,
  retryMs: number,
  cooldownMs: number,
  setTimer: (timer: NodeJS.Timeout | null) => void,
  onCooldownDone: () => void
): Promise<void> {
  if (isStopped()) return;
  if (!isActive()) return;

  if (!isWorking()) {
    if (isStopped()) return;

    await action();

    if (!isStopped()) {
      setTimer(
        setTimeout(() => {
          if (isStopped()) return;
          setTimer(null);
          onCooldownDone();
        }, cooldownMs)
      );
    }
  } else {
    if (!isStopped()) {
      setTimer(
        setTimeout(
          () => executeWhenIdle(action, isActive, isWorking, isStopped, retryMs, cooldownMs, setTimer, onCooldownDone),
          retryMs
        )
      );
    }
  }
}

// ============================================================================
// Auto-resume (usage-limit pause) constants
// ============================================================================

/** Safety buffer after the stated reset time before resuming (2 minutes) */
const RESUME_BUFFER_MS = 2 * 60_000;

/** Minimum delay before an overdue resume fires (lets output settle) */
const RESUME_MIN_DELAY_MS = 5_000;

/** Retry interval when the reset time is stale/past (5 minutes) */
const RESUME_RETRY_MS = 5 * 60_000;

/** Re-detections scheduling within this window of the current schedule are ignored */
const RESUME_DEDUP_TOLERANCE_MS = 90_000;

/** Delay between Escape (dialog dismiss) and the resume prompt */
const RESUME_ESC_DELAY_MS = 600;

/** Prompt sent to resume work after the limit resets */
const RESUME_PROMPT = 'continue';

/** Minimum valid threshold for auto-clear/compact (1000 tokens) */
const MIN_AUTO_THRESHOLD = 1000;

/** Maximum valid threshold for auto-clear/compact when the model's window is not reported (1M tokens) */
const MAX_AUTO_THRESHOLD = 1_000_000;

/** Default auto-clear threshold when invalid value provided */
const DEFAULT_AUTO_CLEAR_THRESHOLD = 140_000;

/** Default auto-compact threshold when invalid value provided */
const DEFAULT_AUTO_COMPACT_THRESHOLD = 110_000;

/** The context size Claude Code last reported on its statusline. */
export interface ContextReport {
  /** Tokens in the context window at the last API response, cache reads and writes included. */
  tokens: number;
  /** The model's window (200k, or 1M with extended context); absent when not reported. */
  windowSize?: number;
}

export interface AutoThresholdInput {
  threshold: number;
  /** The newest statusline report, or null when none has arrived. */
  report: ContextReport | null;
  /** The newest report's size when the last /compact or /clear went out, or null. */
  reportTokensAtCommand: number | null;
  /** The session's token counter. */
  counterTokens: number;
  /** The counter's value at the last /compact: it never drops by itself after one. */
  counterBaseline: number;
}

export interface AutoThresholdDecision {
  trigger: boolean;
  tokens: number;
  source: 'statusline' | 'counter';
}

/**
 * Whether the context has reached a threshold. Pure, so every case is testable without a session.
 *
 * A report wins over the counter: the counter leaves out cache reads, so on a long conversation
 * it is a small fraction of the real context. The counter stays as the fallback, because the
 * exporter only runs for Claude, only while plan-usage collection is on, and never on a remote or
 * Docker launch or in a workspace with its own statusline.
 *
 * A report carries the usage of the last API response, so after a /compact or /clear the number
 * from before the command stays the newest one until the command finishes, and it is re-posted on
 * every render. It is ignored by VALUE rather than for a length of time: the first report that
 * differs came from the finished command (0 on Claude Code 2.1.319) or from a later API response.
 * If the command was swallowed that report is higher and the threshold fires again, so nothing
 * can lock auto-compact off, and no timer has to guess how long a compact takes (601k tokens took
 * 39 s, four times the cooldown).
 *
 * A counter summed from JSON usage never drops after a compact, so it counts from the value at
 * the last one. The pane parser's counter is absolute, see noteAbsoluteCounter().
 */
export function decideAutoThreshold(input: AutoThresholdInput): AutoThresholdDecision {
  const { threshold, report, reportTokensAtCommand, counterTokens, counterBaseline } = input;
  if (report) {
    const stale = report.tokens === reportTokensAtCommand;
    return { trigger: !stale && report.tokens >= threshold, tokens: report.tokens, source: 'statusline' };
  }
  const tokens = Math.max(0, counterTokens - counterBaseline);
  return { trigger: tokens >= threshold, tokens, source: 'counter' };
}

/**
 * Callbacks required by SessionAutoOps to interact with the parent Session.
 */
interface AutoOpsCallbacks {
  /** Send a command via the terminal multiplexer */
  writeCommand: (command: string) => Promise<boolean>;
  /** Check if Claude is currently working */
  isWorking: () => boolean;
  /** Check if the session has been stopped */
  isStopped: () => boolean;
  /** Get current total token count (input + output) */
  getTotalTokens: () => number;
  /** The newest statusline context report, or null when none has arrived */
  getContextReport: () => ContextReport | null;
  /** Get session ID for logging */
  getSessionId: () => string;
}

/**
 * Events emitted by SessionAutoOps.
 */

/**
 * Manages auto-compact and auto-clear automation for a Session.
 *
 * When enabled, monitors token counts after each update and triggers
 * /compact or /clear commands when thresholds are exceeded. Ensures
 * mutual exclusion between compact and clear operations.
 */
export class SessionAutoOps extends EventEmitter {
  // Auto-compact state
  private _autoCompactThreshold: number;
  private _autoCompactEnabled: boolean = false;
  private _autoCompactPrompt: string = '';
  private _isCompacting: boolean = false;
  private _reportTokensAtCommand: number | null = null;
  private _counterBaseline: number = 0;
  private _autoCompactTimer: NodeJS.Timeout | null = null;

  // Auto-clear state
  private _autoClearThreshold: number;
  private _autoClearEnabled: boolean = false;
  private _isClearing: boolean = false;
  private _autoClearTimer: NodeJS.Timeout | null = null;

  // Auto-resume (usage-limit pause) state
  private _autoResumeEnabled: boolean = false;
  private _autoResumeTimer: NodeJS.Timeout | null = null;
  /** Esc→continue gap timer; detections must NOT cancel a resume in flight */
  private _resumeFollowupTimer: NodeJS.Timeout | null = null;
  /** When the scheduled resume fires (epoch ms), null when not armed */
  private _autoResumeAt: number | null = null;
  private _limitPaused: boolean = false;
  private _resumeAttempts: number = 0;

  private readonly callbacks: AutoOpsCallbacks;

  constructor(callbacks: AutoOpsCallbacks, config?: { compactThreshold?: number; clearThreshold?: number }) {
    super();
    this.callbacks = callbacks;
    this._autoCompactThreshold = config?.compactThreshold ?? DEFAULT_AUTO_COMPACT_THRESHOLD;
    this._autoClearThreshold = config?.clearThreshold ?? DEFAULT_AUTO_CLEAR_THRESHOLD;
  }

  // ============================================================================
  // Auto-compact getters/setters
  // ============================================================================

  get autoCompactThreshold(): number {
    return this._autoCompactThreshold;
  }

  get autoCompactEnabled(): boolean {
    return this._autoCompactEnabled;
  }

  get autoCompactPrompt(): string {
    return this._autoCompactPrompt;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  setAutoCompact(enabled: boolean, threshold?: number, prompt?: string): void {
    this._autoCompactEnabled = enabled;
    if (threshold !== undefined) {
      this._autoCompactThreshold = this._resolveThreshold('autoCompact', threshold, DEFAULT_AUTO_COMPACT_THRESHOLD);
    }
    if (prompt !== undefined) {
      this._autoCompactPrompt = prompt;
    }
  }

  // ============================================================================
  // Auto-clear getters/setters
  // ============================================================================

  get autoClearThreshold(): number {
    return this._autoClearThreshold;
  }

  get autoClearEnabled(): boolean {
    return this._autoClearEnabled;
  }

  get isClearing(): boolean {
    return this._isClearing;
  }

  setAutoClear(enabled: boolean, threshold?: number): void {
    this._autoClearEnabled = enabled;
    if (threshold !== undefined) {
      this._autoClearThreshold = this._resolveThreshold('autoClear', threshold, DEFAULT_AUTO_CLEAR_THRESHOLD);
    }
  }

  // ============================================================================
  // Auto-resume (usage-limit pause) — getters/setters
  // ============================================================================

  get autoResumeEnabled(): boolean {
    return this._autoResumeEnabled;
  }

  /** When the scheduled resume fires (epoch ms), or null when not armed. */
  get autoResumeAt(): number | null {
    return this._autoResumeAt;
  }

  /** True while the session is believed to be paused on a usage limit. */
  get isLimitPaused(): boolean {
    return this._limitPaused;
  }

  setAutoResume(enabled: boolean): void {
    this._autoResumeEnabled = enabled;
    if (!enabled) {
      this._cancelAutoResume('disabled');
    }
  }

  /**
   * Restore auto-resume state after a Codeman restart. A persisted pending
   * schedule is re-armed; an overdue one fires shortly after boot (the limit
   * footer won't reprint on its own, so without this the pause would stall).
   */
  restoreAutoResume(enabled: boolean, resumeAt?: number): void {
    this._autoResumeEnabled = enabled;
    if (!enabled || !resumeAt) return;
    const now = Date.now();
    this._scheduleResume(Math.max(resumeAt, now + RESUME_MIN_DELAY_MS), resumeAt, 'restored');
  }

  // ============================================================================
  // Auto-resume — detection and scheduling
  // ============================================================================

  /**
   * Scan cleaned terminal output for a usage-limit pause message and (re)arm
   * the resume schedule. Called from the session's throttled parser path.
   */
  processCleanData(cleanData: string): void {
    if (!this._autoResumeEnabled || this.callbacks.isStopped()) return;
    // A resume is in flight (Esc sent, continue pending): output from our own
    // Escape can redraw the stale limit footer — don't let it re-arm and
    // cancel the continue. Fresh evidence arrives after the prompt is sent.
    if (this._resumeFollowupTimer) return;

    const detection = detectUsageLimitPause(cleanData);
    if (!detection) return;

    const now = Date.now();
    const overdue = detection.resetAt <= now;
    const fireAt = overdue
      ? now + RESUME_RETRY_MS // stale reset time → gentle retry loop
      : Math.max(detection.resetAt + RESUME_BUFFER_MS, now + RESUME_MIN_DELAY_MS);

    if (this._autoResumeTimer && this._autoResumeAt !== null) {
      // Already armed: the footer redraws constantly, so ignore re-detections
      // that land on (or later than) the current schedule. Only an EARLIER
      // parsed time replaces it — an overdue retry never preempts a real one.
      if (overdue || fireAt >= this._autoResumeAt - RESUME_DEDUP_TOLERANCE_MS) return;
    }

    this._scheduleResume(fireAt, detection.resetAt, detection.matched);
  }

  /**
   * Claude started working — the limit is lifted (or the user resumed
   * manually), so any pending auto-resume is obsolete.
   */
  notifyWorking(): void {
    this._resumeAttempts = 0;
    if (!this._limitPaused && !this._autoResumeTimer && !this._resumeFollowupTimer) return;
    this._cancelAutoResume('working');
  }

  private _scheduleResume(fireAt: number, resetAt: number, matched: string): void {
    if (this._autoResumeTimer) {
      clearTimeout(this._autoResumeTimer);
      this._autoResumeTimer = null;
    }
    this._limitPaused = true;
    this._autoResumeAt = fireAt;
    const delay = Math.max(fireAt - Date.now(), 0);
    console.log(
      `[SessionAutoOps ${this.callbacks.getSessionId()}] Usage-limit pause detected ("${matched.slice(0, 60)}"), auto-resume in ${Math.round(delay / 60000)}min`
    );
    this._autoResumeTimer = setTimeout(() => void this._fireResume(), delay);
    this.emit('limitPauseScheduled', { resetAt, resumeAt: fireAt, matched });
  }

  private async _fireResume(): Promise<void> {
    this._autoResumeTimer = null;
    if (!this._autoResumeEnabled || this.callbacks.isStopped()) return;

    if (this.callbacks.isWorking()) {
      // Session resumed on its own (or via the user) — nothing to do.
      this._cancelAutoResume('working');
      return;
    }

    this._resumeAttempts++;
    const attempt = this._resumeAttempts;
    this._limitPaused = false; // optimistic: a fresh limit message re-arms us
    this._autoResumeAt = null;

    // Escape first: dismisses the rate-limit options dialog if Claude opened
    // one (harmless at an idle prompt), then the resume prompt after a beat.
    await this.callbacks.writeCommand('\x1b');
    this._resumeFollowupTimer = setTimeout(() => {
      this._resumeFollowupTimer = null;
      if (this.callbacks.isStopped()) return;
      void this.callbacks.writeCommand(`${RESUME_PROMPT}\r`);
      this.emit('limitResume', { attempt });
    }, RESUME_ESC_DELAY_MS);
  }

  private _cancelAutoResume(reason: 'disabled' | 'working' | 'stopped'): void {
    const wasArmed = this._autoResumeTimer !== null || this._resumeFollowupTimer !== null || this._limitPaused;
    if (this._autoResumeTimer) {
      clearTimeout(this._autoResumeTimer);
      this._autoResumeTimer = null;
    }
    if (this._resumeFollowupTimer) {
      clearTimeout(this._resumeFollowupTimer);
      this._resumeFollowupTimer = null;
    }
    this._limitPaused = false;
    this._autoResumeAt = null;
    if (wasArmed && reason !== 'stopped') {
      this.emit('limitResumeCancelled', { reason });
    }
  }

  // ============================================================================
  // Threshold checks
  // ============================================================================

  /** The highest threshold that can ever fire: the reported window, or 1M when it is unknown. */
  /**
   * A value above the window stops at the window rather than falling to the default: a threshold
   * saved under a larger window comes back on every save of the options, and the default would
   * compact far earlier than anyone asked for.
   */
  private _resolveThreshold(name: string, threshold: number, fallback: number): number {
    const id = this.callbacks.getSessionId();
    if (threshold < MIN_AUTO_THRESHOLD) {
      console.warn(
        `[SessionAutoOps ${id}] Invalid ${name} threshold ${threshold}, minimum is ${MIN_AUTO_THRESHOLD}. Using default ${fallback}.`
      );
      return fallback;
    }
    const max = this._maxThreshold();
    if (threshold > max) {
      console.warn(`[SessionAutoOps ${id}] ${name} threshold ${threshold} is above the window, using ${max}.`);
      return max;
    }
    return threshold;
  }

  /**
   * The pane parser's counter holds the absolute number on screen and only moves past its highest
   * value so far, so a move means the context grew back past the last compact. Counting that from
   * the baseline would ask for twice the threshold, which a 200k window never reaches.
   */
  noteAbsoluteCounter(): void {
    this._counterBaseline = 0;
  }

  private _maxThreshold(): number {
    return this.callbacks.getContextReport()?.windowSize ?? MAX_AUTO_THRESHOLD;
  }

  private _decide(threshold: number): AutoThresholdDecision {
    return decideAutoThreshold({
      threshold,
      report: this.callbacks.getContextReport(),
      reportTokensAtCommand: this._reportTokensAtCommand,
      counterTokens: this.callbacks.getTotalTokens(),
      counterBaseline: this._counterBaseline,
    });
  }

  /**
   * Check if auto-compact should be triggered based on the current context size.
   * Called after token count updates and after each statusline report.
   */
  checkAutoCompact(): void {
    if (this.callbacks.isStopped()) return;
    if (!this._autoCompactEnabled || this._isCompacting || this._isClearing) return;

    const decision = this._decide(this._autoCompactThreshold);
    if (decision.trigger) {
      const totalTokens = decision.tokens;
      this._isCompacting = true;
      console.log(
        `[SessionAutoOps] Auto-compact triggered: ${totalTokens} tokens (${decision.source}) >= ${this._autoCompactThreshold} threshold`
      );

      const action = async () => {
        // One line: this fires unattended, and a multi-line focus prompt would go out
        // as a multi-line paste (see toSingleLine).
        const compactCmd = this._autoCompactPrompt
          ? `/compact ${toSingleLine(this._autoCompactPrompt)}\r`
          : '/compact\r';
        // Read here, not at the trigger: the idle wait can outlast several reports.
        this._reportTokensAtCommand = this.callbacks.getContextReport()?.tokens ?? null;
        this._counterBaseline = this.callbacks.getTotalTokens();
        await this.callbacks.writeCommand(compactCmd);
        this.emit('autoCompact', {
          tokens: totalTokens,
          threshold: this._autoCompactThreshold,
          prompt: this._autoCompactPrompt || undefined,
        });
      };

      if (!this.callbacks.isStopped()) {
        this._autoCompactTimer = setTimeout(
          () =>
            executeWhenIdle(
              action,
              () => this._isCompacting,
              () => this.callbacks.isWorking(),
              () => this.callbacks.isStopped(),
              AUTO_RETRY_DELAY_MS,
              COMPACT_COOLDOWN_MS,
              (timer) => {
                this._autoCompactTimer = timer;
              },
              () => {
                this._isCompacting = false;
              }
            ),
          AUTO_INITIAL_DELAY_MS
        );
      }
    }
  }

  /**
   * Check if auto-clear should be triggered based on the current context size.
   * Called after token count updates and after each statusline report.
   */
  checkAutoClear(): void {
    if (this.callbacks.isStopped()) return;
    if (!this._autoClearEnabled || this._isClearing || this._isCompacting) return;

    const decision = this._decide(this._autoClearThreshold);
    if (decision.trigger) {
      const totalTokens = decision.tokens;
      this._isClearing = true;
      console.log(
        `[SessionAutoOps] Auto-clear triggered: ${totalTokens} tokens (${decision.source}) >= ${this._autoClearThreshold} threshold`
      );

      const action = async () => {
        this._reportTokensAtCommand = this.callbacks.getContextReport()?.tokens ?? null;
        // The session zeroes its counter on 'autoClear', so the counter restarts from 0.
        this._counterBaseline = 0;
        await this.callbacks.writeCommand('/clear\r');
        this.emit('autoClear', { tokens: totalTokens, threshold: this._autoClearThreshold });
      };

      if (!this.callbacks.isStopped()) {
        this._autoClearTimer = setTimeout(
          () =>
            executeWhenIdle(
              action,
              () => this._isClearing,
              () => this.callbacks.isWorking(),
              () => this.callbacks.isStopped(),
              AUTO_RETRY_DELAY_MS,
              CLEAR_COOLDOWN_MS,
              (timer) => {
                this._autoClearTimer = timer;
              },
              () => {
                this._isClearing = false;
              }
            ),
          AUTO_INITIAL_DELAY_MS
        );
      }
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clear all timers and reset state. Called when the session stops.
   */
  destroy(): void {
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

    this._cancelAutoResume('stopped');
  }
}
