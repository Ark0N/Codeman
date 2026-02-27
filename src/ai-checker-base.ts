/**
 * @fileoverview Base Class for AI Checker Components
 *
 * Provides shared functionality for AI-powered checkers that spawn fresh Claude CLI
 * sessions to analyze terminal output. This base class handles:
 * - Mux session spawning and cleanup
 * - Temp file management for output capture
 * - Polling for completion markers
 * - Cooldown management
 * - Error handling and consecutive error tracking
 * - Event emission for state changes
 *
 * Subclasses implement:
 * - `muxNamePrefix`: Prefix for mux session names (e.g., 'codeman-aicheck-')
 * - `doneMarker`: Completion marker in output file (e.g., '__AICHECK_DONE__')
 * - `tempFilePrefix`: Prefix for temp files (e.g., 'codeman-aicheck')
 * - `logPrefix`: Prefix for log messages (e.g., '[AiIdleChecker]')
 * - `buildPrompt()`: Build the prompt from terminal buffer
 * - `parseVerdict()`: Parse the verdict from AI output
 * - `getPositiveVerdict()`: Return the "positive" verdict that doesn't trigger cooldown
 * - `defaultConfig`: Default configuration values
 *
 * @module ai-checker-base
 */

import { execSync, spawn as childSpawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { getAugmentedPath } from './utils/claude-cli-resolver.js';
import { ANSI_ESCAPE_PATTERN_SIMPLE } from './utils/index.js';

// ========== Security Validation ==========

/**
 * Validates that a model name is safe for shell use.
 * Model names should only contain alphanumeric characters, hyphens, underscores, and dots.
 */
function isValidModelName(model: string): boolean {
  if (!model || typeof model !== 'string') return false;
  // Allow: alphanumeric, hyphens, underscores, dots, slashes (for model paths like claude/opus-4.5)
  // Max length 100 to prevent abuse
  return /^[a-zA-Z0-9._/-]+$/.test(model) && model.length <= 100;
}

/**
 * Validates that a mux session name is safe for shell use.
 * Names should only contain alphanumeric characters, hyphens, and underscores.
 */
function isValidMuxName(muxName: string): boolean {
  if (!muxName || typeof muxName !== 'string') return false;
  return /^[a-zA-Z0-9_-]+$/.test(muxName) && muxName.length <= 100;
}

// ========== Types ==========

/** Base configuration shared by all AI checkers */
export interface AiCheckerConfigBase {
  /** Whether the checker is enabled */
  enabled: boolean;
  /** Model to use for the check */
  model: string;
  /** Maximum characters of terminal buffer to send */
  maxContextChars: number;
  /** Timeout for the check in ms */
  checkTimeoutMs: number;
  /** Cooldown after negative verdict in ms */
  cooldownMs: number;
  /** Cooldown after errors in ms */
  errorCooldownMs: number;
  /** Max consecutive errors before disabling */
  maxConsecutiveErrors: number;
}

/** Status values shared by all AI checkers */
export type AiCheckerStatus = 'ready' | 'checking' | 'cooldown' | 'disabled' | 'error';

/** Base result structure for all AI checkers */
export interface AiCheckerResultBase<V extends string> {
  verdict: V;
  reasoning: string;
  durationMs: number;
}

/** Base state structure for all AI checkers */
export interface AiCheckerStateBase<V extends string> {
  status: AiCheckerStatus;
  lastVerdict: V | null;
  lastReasoning: string | null;
  lastCheckDurationMs: number | null;
  cooldownEndsAt: number | null;
  consecutiveErrors: number;
  totalChecks: number;
  disabledReason: string | null;
}

// ========== Constants ==========

/** Poll interval for checking temp file completion */
const POLL_INTERVAL_MS = 500;

// ========== AiCheckerBase Class ==========

/**
 * Abstract base class for AI-powered checkers.
 * Handles spawning Claude CLI in a mux session to analyze terminal output.
 *
 * @template V - The verdict type (e.g., 'IDLE' | 'WORKING' | 'ERROR')
 * @template C - The configuration type
 * @template R - The result type
 * @template S - The state type
 */
export abstract class AiCheckerBase<
  V extends string,
  C extends AiCheckerConfigBase,
  R extends AiCheckerResultBase<V>,
  S extends AiCheckerStateBase<V>,
> extends EventEmitter {
  protected config: C;
  protected sessionId: string;

  // State
  protected _status: AiCheckerStatus = 'ready';
  protected lastVerdict: V | null = null;
  protected lastReasoning: string | null = null;
  protected lastCheckDurationMs: number | null = null;
  protected cooldownEndsAt: number | null = null;
  protected cooldownTimer: NodeJS.Timeout | null = null;
  protected consecutiveErrors: number = 0;
  protected totalChecks: number = 0;
  protected disabledReason: string | null = null;

  // Active check state
  protected checkMuxName: string | null = null;
  protected checkTempFile: string | null = null;
  protected checkPromptFile: string | null = null;
  protected checkPollTimer: NodeJS.Timeout | null = null;
  protected checkTimeoutTimer: NodeJS.Timeout | null = null;
  protected checkStartTime: number = 0;
  protected checkCancelled: boolean = false;
  protected checkResolve: ((result: R) => void) | null = null;

  // ========== Abstract Properties ==========

  /** Prefix for mux session names (e.g., 'codeman-aicheck-') */
  protected abstract readonly muxNamePrefix: string;

  /** Marker written to temp file when check is complete */
  protected abstract readonly doneMarker: string;

  /** Prefix for temp files (e.g., 'codeman-aicheck') */
  protected abstract readonly tempFilePrefix: string;

  /** Prefix for log messages (e.g., '[AiIdleChecker]') */
  protected abstract readonly logPrefix: string;

  /** Description for log messages (e.g., 'AI idle check', 'AI plan check') */
  protected abstract readonly checkDescription: string;

  // ========== Abstract Methods ==========

  /**
   * Build the prompt to send to Claude.
   * @param terminalBuffer - The trimmed and stripped terminal buffer
   * @returns The complete prompt string
   */
  protected abstract buildPrompt(terminalBuffer: string): string;

  /**
   * Parse the verdict from Claude's output.
   * @param output - The raw output from Claude (without done marker)
   * @returns The parsed verdict and reasoning, or null if unparseable
   */
  protected abstract parseVerdict(output: string): { verdict: V; reasoning: string } | null;

  /**
   * Get the "positive" verdict that indicates success and doesn't trigger cooldown.
   * For idle checker this is 'IDLE', for plan checker this is 'PLAN_MODE'.
   */
  protected abstract getPositiveVerdict(): V;

  /**
   * Get the "negative" verdict that triggers cooldown.
   * For idle checker this is 'WORKING', for plan checker this is 'NOT_PLAN_MODE'.
   */
  protected abstract getNegativeVerdict(): V;

  /**
   * Get the error verdict value.
   */
  protected abstract getErrorVerdict(): V;

  /**
   * Create an error result.
   */
  protected abstract createErrorResult(reasoning: string, durationMs: number): R;

  /**
   * Create a success result.
   */
  protected abstract createResult(verdict: V, reasoning: string, durationMs: number): R;

  constructor(sessionId: string, defaultConfig: C, config: Partial<C> = {}) {
    super();
    this.sessionId = sessionId;
    // Filter out undefined values to prevent overwriting defaults
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined)
    ) as Partial<C>;
    this.config = { ...defaultConfig, ...filteredConfig };
  }

  /** Get the current status */
  get status(): AiCheckerStatus {
    return this._status;
  }

  /** Get comprehensive state for UI display */
  getState(): S {
    return {
      status: this._status,
      lastVerdict: this.lastVerdict,
      lastReasoning: this.lastReasoning,
      lastCheckDurationMs: this.lastCheckDurationMs,
      cooldownEndsAt: this.cooldownEndsAt,
      consecutiveErrors: this.consecutiveErrors,
      totalChecks: this.totalChecks,
      disabledReason: this.disabledReason,
    } as S;
  }

  /** Check if the checker is on cooldown */
  isOnCooldown(): boolean {
    if (this.cooldownEndsAt === null) return false;
    return Date.now() < this.cooldownEndsAt;
  }

  /** Get remaining cooldown time in ms */
  getCooldownRemainingMs(): number {
    if (this.cooldownEndsAt === null) return 0;
    return Math.max(0, this.cooldownEndsAt - Date.now());
  }

  /**
   * Run an AI check against the provided terminal buffer.
   * Spawns a fresh Claude CLI in a tmux session, captures output to temp file.
   *
   * @param terminalBuffer - Raw terminal output to analyze
   * @returns The verdict result
   */
  async check(terminalBuffer: string): Promise<R> {
    if (this._status === 'disabled') {
      return this.createErrorResult(`Disabled: ${this.disabledReason}`, 0);
    }

    if (this.isOnCooldown()) {
      return this.createErrorResult('On cooldown', 0);
    }

    if (this._status === 'checking') {
      return this.createErrorResult('Already checking', 0);
    }

    this._status = 'checking';
    this.checkCancelled = false;
    this.checkStartTime = Date.now();
    this.totalChecks++;
    this.emit('checkStarted');
    this.log(`Starting ${this.checkDescription}`);

    try {
      const result = await this.runCheck(terminalBuffer);

      if (this.checkCancelled) {
        return this.createErrorResult('Cancelled', Date.now() - this.checkStartTime);
      }

      this.lastVerdict = result.verdict;
      this.lastReasoning = result.reasoning;
      this.lastCheckDurationMs = result.durationMs;

      if (result.verdict === this.getPositiveVerdict()) {
        this.consecutiveErrors = 0;
        this._status = 'ready';
        this.log(
          `${this.checkDescription} verdict: ${result.verdict} (${result.durationMs}ms) - ${result.reasoning}`
        );
      } else if (result.verdict === this.getNegativeVerdict()) {
        this.consecutiveErrors = 0;
        this.startCooldown(this.config.cooldownMs);
        this.log(
          `${this.checkDescription} verdict: ${result.verdict} (${result.durationMs}ms) - ${result.reasoning}`
        );
      } else {
        this.handleError('Unexpected verdict');
      }

      this.emit('checkCompleted', result);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.handleError(errorMsg);
      const result = this.createErrorResult(errorMsg, Date.now() - this.checkStartTime);
      this.emit('checkFailed', errorMsg);
      return result;
    } finally {
      this.cleanupCheck();
    }
  }

  /**
   * Cancel an in-progress check.
   * Kills the mux session and cleans up.
   */
  cancel(): void {
    if (this._status !== 'checking') return;

    this.log(`Cancelling ${this.checkDescription}`);
    this.checkCancelled = true;

    // Clear poll/timeout timers first to prevent race condition where
    // the poll timer fires between setting checkCancelled and cleanup
    this.cleanupCheck();

    // Resolve the pending promise after cleanup
    if (this.checkResolve) {
      this.checkResolve(this.createErrorResult('Cancelled', Date.now() - this.checkStartTime));
      this.checkResolve = null;
    }

    this._status = 'ready';
  }

  /** Reset all state for a new cycle */
  reset(): void {
    this.cancel();
    this.clearCooldown();
    this.lastVerdict = null;
    this.lastReasoning = null;
    this.lastCheckDurationMs = null;
    this.consecutiveErrors = 0;
    this._status = this.disabledReason ? 'disabled' : 'ready';
  }

  /** Update configuration at runtime */
  updateConfig(config: Partial<C>): void {
    // Filter out undefined values to prevent overwriting existing config
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined)
    ) as Partial<C>;
    this.config = { ...this.config, ...filteredConfig };
    if (config.enabled === false) {
      this.disable('Disabled by config');
    } else if (config.enabled === true && this._status === 'disabled') {
      this.disabledReason = null;
      this._status = 'ready';
    }
  }

  /** Get current config */
  getConfig(): C {
    return { ...this.config };
  }

  // ========== Private Methods ==========

  private async runCheck(terminalBuffer: string): Promise<R> {
    // Security: Validate model name before use in shell commands
    if (!isValidModelName(this.config.model)) {
      throw new Error(`Invalid model name: ${this.config.model.substring(0, 50)}`);
    }

    // Prepare the terminal buffer (strip ANSI, trim to maxContextChars)
    const stripped = terminalBuffer.replace(ANSI_ESCAPE_PATTERN_SIMPLE, '');
    const trimmed =
      stripped.length > this.config.maxContextChars
        ? stripped.slice(-this.config.maxContextChars)
        : stripped;

    // Build the prompt
    const prompt = this.buildPrompt(trimmed);

    // Generate temp files and mux session name
    const shortId = this.sessionId.slice(0, 8);
    const timestamp = Date.now();
    this.checkTempFile = join(tmpdir(), `${this.tempFilePrefix}-${shortId}-${timestamp}.txt`);
    this.checkPromptFile = join(
      tmpdir(),
      `${this.tempFilePrefix}-prompt-${shortId}-${timestamp}.txt`
    );
    this.checkMuxName = `${this.muxNamePrefix}${shortId}`;

    // Security: Validate mux name before use in shell commands
    if (!isValidMuxName(this.checkMuxName)) {
      throw new Error(`Invalid mux name generated: ${this.checkMuxName.substring(0, 50)}`);
    }

    // Ensure output temp file exists (empty) so we can poll it
    writeFileSync(this.checkTempFile, '');

    // Write prompt to file to avoid E2BIG error (argument list too long)
    // The prompt can be 16KB+ which exceeds shell argument limits
    writeFileSync(this.checkPromptFile, prompt);

    // Build the command - read prompt from file via stdin to avoid argument size limits
    // Quote model name to prevent command injection (model names should be simple alphanumeric but be safe)
    const modelArg = `--model "${this.config.model.replace(/"/g, '\\"')}"`;
    const augmentedPath = getAugmentedPath();
    const claudeCmd = `cat "${this.checkPromptFile}" | claude -p ${modelArg} --output-format text`;
    const fullCmd = `export PATH="${augmentedPath}"; ${claudeCmd} > "${this.checkTempFile}" 2>&1; echo "${this.doneMarker}" >> "${this.checkTempFile}"; rm -f "${this.checkPromptFile}"`;

    // Spawn tmux session
    try {
      // Kill any leftover session with this name first (mux name already validated above)
      try {
        execSync(`tmux kill-session -t "${this.checkMuxName}" 2>/dev/null`, { timeout: 3000 });
      } catch {
        // No existing session, that's fine
      }

      const muxProcess = childSpawn(
        'tmux',
        ['new-session', '-d', '-s', this.checkMuxName, 'bash', '-c', fullCmd],
        {
          detached: true,
          stdio: 'ignore',
        }
      );
      muxProcess.unref();
    } catch (err) {
      throw new Error(
        `Failed to spawn ${this.checkDescription} tmux session: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Poll the temp file for completion
    return new Promise<R>((resolve, reject) => {
      const startTime = this.checkStartTime;
      this.checkResolve = resolve;

      // Guard flag to prevent both poll and timeout from resolving (race condition)
      let resolved = false;

      this.checkPollTimer = setInterval(() => {
        if (this.checkCancelled || resolved) {
          // Cancel or already resolved - stop polling
          return;
        }

        try {
          if (!this.checkTempFile || !existsSync(this.checkTempFile)) return;
          const content = readFileSync(this.checkTempFile, 'utf-8');
          if (content.includes(this.doneMarker)) {
            resolved = true; // Mark as resolved first to prevent timeout race
            const durationMs = Date.now() - startTime;
            const result = this.parseOutput(content, durationMs);
            this.checkResolve = null;
            resolve(result);
          }
        } catch {
          // File might not be ready yet or was deleted during cleanup, keep polling
        }
      }, POLL_INTERVAL_MS);

      // Set timeout
      this.checkTimeoutTimer = setTimeout(() => {
        if (this._status === 'checking' && !this.checkCancelled && !resolved) {
          resolved = true; // Mark as resolved first to prevent poll race
          this.checkResolve = null;
          reject(
            new Error(`${this.checkDescription} timed out after ${this.config.checkTimeoutMs}ms`)
          );
        }
      }, this.config.checkTimeoutMs);
    });
  }

  private parseOutput(content: string, durationMs: number): R {
    // Remove the done marker and trim
    const output = content.replace(this.doneMarker, '').trim();

    if (!output) {
      return this.createErrorResult(`Empty output from ${this.checkDescription}`, durationMs);
    }

    // Delegate to subclass for verdict parsing
    const parsed = this.parseVerdict(output);
    if (!parsed) {
      return this.createErrorResult(
        `Could not parse verdict from: "${output.substring(0, 100)}"`,
        durationMs
      );
    }

    return this.createResult(parsed.verdict, parsed.reasoning, durationMs);
  }

  private cleanupCheck(): void {
    // Clear poll timer
    if (this.checkPollTimer) {
      clearInterval(this.checkPollTimer);
      this.checkPollTimer = null;
    }

    // Clear timeout timer
    if (this.checkTimeoutTimer) {
      clearTimeout(this.checkTimeoutTimer);
      this.checkTimeoutTimer = null;
    }

    // Kill the tmux session
    if (this.checkMuxName) {
      const muxName = this.checkMuxName;
      try {
        execSync(`tmux kill-session -t "${muxName}" 2>/dev/null`, { timeout: 2000 });
      } catch {
        // Session may already be dead
      }
      this.checkMuxName = null;
    }

    // Delete temp files
    if (this.checkTempFile) {
      try {
        if (existsSync(this.checkTempFile)) {
          unlinkSync(this.checkTempFile);
        }
      } catch {
        // Best effort cleanup
      }
      this.checkTempFile = null;
    }

    if (this.checkPromptFile) {
      try {
        if (existsSync(this.checkPromptFile)) {
          unlinkSync(this.checkPromptFile);
        }
      } catch {
        // Best effort cleanup
      }
      this.checkPromptFile = null;
    }
  }

  private handleError(errorMsg: string): void {
    this.consecutiveErrors++;
    this.log(
      `${this.checkDescription} error (${this.consecutiveErrors}/${this.config.maxConsecutiveErrors}): ${errorMsg}`
    );

    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      this.disable(`${this.config.maxConsecutiveErrors} consecutive errors: ${errorMsg}`);
    } else {
      // P1-005: Exponential backoff for errors
      // Base cooldown * 2^(consecutiveErrors-1), capped at 5 minutes
      const backoffMultiplier = Math.pow(2, this.consecutiveErrors - 1);
      const backoffCooldownMs = Math.min(
        this.config.errorCooldownMs * backoffMultiplier,
        5 * 60 * 1000 // Max 5 minutes
      );
      this.log(
        `Exponential backoff: ${Math.round(backoffCooldownMs / 1000)}s (error #${this.consecutiveErrors})`
      );
      this.startCooldown(backoffCooldownMs);
    }
  }

  private startCooldown(durationMs: number): void {
    this.clearCooldown();
    this.cooldownEndsAt = Date.now() + durationMs;
    this._status = 'cooldown';
    this.emit('cooldownStarted', this.cooldownEndsAt);
    this.log(`Cooldown started: ${Math.round(durationMs / 1000)}s`);

    this.cooldownTimer = setTimeout(() => {
      this.cooldownEndsAt = null;
      this._status = 'ready';
      this.emit('cooldownEnded');
      this.log('Cooldown ended');
    }, durationMs);
  }

  private clearCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.cooldownEndsAt = null;
    if (this._status === 'cooldown') {
      this._status = 'ready';
    }
  }

  private disable(reason: string): void {
    this.disabledReason = reason;
    this._status = 'disabled';
    this.clearCooldown();
    this.log(`${this.checkDescription} disabled: ${reason}`);
    this.emit('disabled', reason);
  }

  private log(message: string): void {
    this.emit('log', `${this.logPrefix} ${message}`);
  }
}
