/**
 * @fileoverview AI-Powered Plan Mode Checker for Auto-Accept
 *
 * Spawns a fresh Claude CLI session to analyze terminal output and determine
 * if Claude Code is showing a plan mode approval prompt (numbered selection menu).
 * Used as a confirmation gate before auto-accepting prompts.
 *
 * ## How It Works
 *
 * 1. Generate temp file path for output capture
 * 2. Spawn screen: `screen -dmS claudeman-plancheck-<short> bash -c 'claude -p ...'`
 * 3. Poll the temp file every 500ms for `__PLANCHECK_DONE__` marker
 * 4. Parse the file content for PLAN_MODE/NOT_PLAN_MODE on the first line
 * 5. Kill screen and delete temp file
 *
 * ## Error Handling
 *
 * - Screen spawn fails: 30s cooldown, increment error counter
 * - Check times out (60s): Kill screen, 30s cooldown
 * - Can't parse verdict: Treat as NOT_PLAN_MODE, 30s cooldown
 * - 3 consecutive errors: Disable AI plan check
 *
 * @module ai-plan-checker
 */

import { execSync, spawn as childSpawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { getAugmentedPath } from './session.js';

// ========== Types ==========

export interface AiPlanCheckConfig {
  /** Whether AI plan check is enabled */
  enabled: boolean;
  /** Model to use for the check (thinking enabled by default with opus) */
  model: string;
  /** Maximum characters of terminal buffer to send */
  maxContextChars: number;
  /** Timeout for the check in ms */
  checkTimeoutMs: number;
  /** Cooldown after NOT_PLAN_MODE verdict in ms */
  cooldownMs: number;
  /** Cooldown after errors in ms */
  errorCooldownMs: number;
  /** Max consecutive errors before disabling */
  maxConsecutiveErrors: number;
}

export type AiPlanCheckStatus = 'ready' | 'checking' | 'cooldown' | 'disabled' | 'error';
export type AiPlanCheckVerdict = 'PLAN_MODE' | 'NOT_PLAN_MODE' | 'ERROR';

export interface AiPlanCheckResult {
  verdict: AiPlanCheckVerdict;
  reasoning: string;
  durationMs: number;
}

export interface AiPlanCheckState {
  status: AiPlanCheckStatus;
  lastVerdict: AiPlanCheckVerdict | null;
  lastReasoning: string | null;
  lastCheckDurationMs: number | null;
  cooldownEndsAt: number | null;
  consecutiveErrors: number;
  totalChecks: number;
  disabledReason: string | null;
}

/** Events emitted by AiPlanChecker */
export interface AiPlanCheckerEvents {
  checkStarted: () => void;
  checkCompleted: (result: AiPlanCheckResult) => void;
  checkFailed: (error: string) => void;
  cooldownStarted: (endsAt: number) => void;
  cooldownEnded: () => void;
  disabled: (reason: string) => void;
  log: (message: string) => void;
}

// ========== Constants ==========

const DEFAULT_PLAN_CHECK_CONFIG: AiPlanCheckConfig = {
  enabled: true,
  model: 'claude-opus-4-5-20251101',
  maxContextChars: 8000,
  checkTimeoutMs: 60000,
  cooldownMs: 30000,
  errorCooldownMs: 30000,
  maxConsecutiveErrors: 3,
};

/** ANSI escape code pattern for stripping terminal formatting */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Poll interval for checking temp file completion */
const POLL_INTERVAL_MS = 500;

/** Marker written to temp file when check is complete */
const DONE_MARKER = '__PLANCHECK_DONE__';

/** Pattern to match PLAN_MODE or NOT_PLAN_MODE as the first word(s) of output */
const VERDICT_PATTERN = /^\s*(PLAN_MODE|NOT_PLAN_MODE)\b/i;

/** The prompt sent to the AI plan checker */
const AI_PLAN_CHECK_PROMPT = `Analyze this terminal output from a running Claude Code session. Determine if the terminal is currently showing a PLAN MODE APPROVAL PROMPT or not.

A plan mode approval prompt is a numbered selection menu that Claude Code shows when it wants the user to approve a plan before proceeding. It typically has these characteristics:
- A numbered list of options (e.g., "1. Yes", "2. No", "3. Type your own")
- A selection indicator arrow (❯ or >) pointing to one of the options
- Text asking for approval like "Would you like to proceed?" or "Ready to implement?"
- The prompt appears at the BOTTOM of the output (most recent content)

NOT a plan mode prompt:
- Claude actively working (spinners, "Thinking", tool execution)
- A completed response with no selection menu
- An AskUserQuestion/elicitation dialog (different format, free-text input)
- Network lag or mid-output pause
- Any state without a visible numbered selection menu

Terminal output (most recent at bottom):
---
{TERMINAL_BUFFER}
---

Answer with EXACTLY one of these on the first line: PLAN_MODE or NOT_PLAN_MODE
Then optionally explain briefly why.`;

// ========== AiPlanChecker Class ==========

/**
 * Manages AI-powered plan mode detection by spawning a fresh Claude CLI session
 * to analyze terminal output and confirm plan mode approval prompts.
 */
export class AiPlanChecker extends EventEmitter {
  private config: AiPlanCheckConfig;
  private sessionId: string;

  // State
  private _status: AiPlanCheckStatus = 'ready';
  private lastVerdict: AiPlanCheckVerdict | null = null;
  private lastReasoning: string | null = null;
  private lastCheckDurationMs: number | null = null;
  private cooldownEndsAt: number | null = null;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private consecutiveErrors: number = 0;
  private totalChecks: number = 0;
  private disabledReason: string | null = null;

  // Active check state
  private checkScreenName: string | null = null;
  private checkTempFile: string | null = null;
  private checkPollTimer: NodeJS.Timeout | null = null;
  private checkTimeoutTimer: NodeJS.Timeout | null = null;
  private checkStartTime: number = 0;
  private checkCancelled: boolean = false;
  private checkResolve: ((result: AiPlanCheckResult) => void) | null = null;

  constructor(sessionId: string, config: Partial<AiPlanCheckConfig> = {}) {
    super();
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_PLAN_CHECK_CONFIG, ...config };
  }

  /** Get the current status */
  get status(): AiPlanCheckStatus {
    return this._status;
  }

  /** Get comprehensive state for UI display */
  getState(): AiPlanCheckState {
    return {
      status: this._status,
      lastVerdict: this.lastVerdict,
      lastReasoning: this.lastReasoning,
      lastCheckDurationMs: this.lastCheckDurationMs,
      cooldownEndsAt: this.cooldownEndsAt,
      consecutiveErrors: this.consecutiveErrors,
      totalChecks: this.totalChecks,
      disabledReason: this.disabledReason,
    };
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
   * Run an AI plan check against the provided terminal buffer.
   * Spawns a fresh Claude CLI in a screen, captures output to temp file.
   *
   * @param terminalBuffer - Raw terminal output to analyze
   * @returns The verdict result
   */
  async check(terminalBuffer: string): Promise<AiPlanCheckResult> {
    if (this._status === 'disabled') {
      return { verdict: 'ERROR', reasoning: `Disabled: ${this.disabledReason}`, durationMs: 0 };
    }

    if (this.isOnCooldown()) {
      return { verdict: 'ERROR', reasoning: 'On cooldown', durationMs: 0 };
    }

    if (this._status === 'checking') {
      return { verdict: 'ERROR', reasoning: 'Already checking', durationMs: 0 };
    }

    this._status = 'checking';
    this.checkCancelled = false;
    this.checkStartTime = Date.now();
    this.totalChecks++;
    this.emit('checkStarted');
    this.log('Starting AI plan check');

    try {
      const result = await this.runCheck(terminalBuffer);

      if (this.checkCancelled) {
        return { verdict: 'ERROR', reasoning: 'Cancelled', durationMs: Date.now() - this.checkStartTime };
      }

      this.lastVerdict = result.verdict;
      this.lastReasoning = result.reasoning;
      this.lastCheckDurationMs = result.durationMs;

      if (result.verdict === 'PLAN_MODE') {
        this.consecutiveErrors = 0;
        this._status = 'ready';
        this.log(`AI plan check verdict: PLAN_MODE (${result.durationMs}ms) - ${result.reasoning}`);
      } else if (result.verdict === 'NOT_PLAN_MODE') {
        this.consecutiveErrors = 0;
        this.startCooldown(this.config.cooldownMs);
        this.log(`AI plan check verdict: NOT_PLAN_MODE (${result.durationMs}ms) - ${result.reasoning}`);
      } else {
        this.handleError('Unexpected verdict');
      }

      this.emit('checkCompleted', result);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.handleError(errorMsg);
      const result: AiPlanCheckResult = {
        verdict: 'ERROR',
        reasoning: errorMsg,
        durationMs: Date.now() - this.checkStartTime,
      };
      this.emit('checkFailed', errorMsg);
      return result;
    } finally {
      this.cleanupCheck();
    }
  }

  /**
   * Cancel an in-progress check.
   * Kills the screen session and cleans up.
   */
  cancel(): void {
    if (this._status !== 'checking') return;

    this.log('Cancelling AI plan check');
    this.checkCancelled = true;

    // Resolve the pending promise before cleanup
    if (this.checkResolve) {
      this.checkResolve({ verdict: 'ERROR', reasoning: 'Cancelled', durationMs: Date.now() - this.checkStartTime });
      this.checkResolve = null;
    }

    this.cleanupCheck();
    this._status = 'ready';
  }

  /** Reset all state */
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
  updateConfig(config: Partial<AiPlanCheckConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.enabled === false) {
      this.disable('Disabled by config');
    } else if (config.enabled === true && this._status === 'disabled') {
      this.disabledReason = null;
      this._status = 'ready';
    }
  }

  /** Get current config */
  getConfig(): AiPlanCheckConfig {
    return { ...this.config };
  }

  // ========== Private Methods ==========

  private async runCheck(terminalBuffer: string): Promise<AiPlanCheckResult> {
    // Prepare the terminal buffer (strip ANSI, trim to maxContextChars)
    const stripped = terminalBuffer.replace(ANSI_ESCAPE_PATTERN, '');
    const trimmed = stripped.length > this.config.maxContextChars
      ? stripped.slice(-this.config.maxContextChars)
      : stripped;

    // Build the prompt
    const prompt = AI_PLAN_CHECK_PROMPT.replace('{TERMINAL_BUFFER}', trimmed);

    // Generate temp file and screen name
    const shortId = this.sessionId.slice(0, 8);
    const timestamp = Date.now();
    this.checkTempFile = join(tmpdir(), `claudeman-plancheck-${shortId}-${timestamp}.txt`);
    this.checkScreenName = `claudeman-plancheck-${shortId}`;

    // Ensure temp file exists (empty) so we can poll it
    writeFileSync(this.checkTempFile, '');

    // Build the command - escape the prompt for shell
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const modelArg = `--model ${this.config.model}`;
    const augmentedPath = getAugmentedPath();
    const claudeCmd = `claude -p ${modelArg} --output-format text '${escapedPrompt}'`;
    const fullCmd = `export PATH="${augmentedPath}"; ${claudeCmd} > "${this.checkTempFile}" 2>&1; echo "${DONE_MARKER}" >> "${this.checkTempFile}"`;

    // Spawn screen
    try {
      // Kill any leftover screen with this name first
      try {
        execSync(`screen -X -S ${this.checkScreenName} quit 2>/dev/null`, { timeout: 3000 });
      } catch {
        // No existing screen, that's fine
      }

      const screenProcess = childSpawn('screen', [
        '-dmS', this.checkScreenName,
        '-c', '/dev/null',
        'bash', '-c', fullCmd
      ], {
        detached: true,
        stdio: 'ignore',
      });
      screenProcess.unref();
    } catch (err) {
      throw new Error(`Failed to spawn plan check screen: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Poll the temp file for completion
    return new Promise<AiPlanCheckResult>((resolve, reject) => {
      const startTime = this.checkStartTime;
      this.checkResolve = resolve;

      this.checkPollTimer = setInterval(() => {
        if (this.checkCancelled) {
          // Cancel was already handled by cancel() calling resolve
          return;
        }

        try {
          if (!this.checkTempFile || !existsSync(this.checkTempFile)) return;
          const content = readFileSync(this.checkTempFile, 'utf-8');
          if (content.includes(DONE_MARKER)) {
            const durationMs = Date.now() - startTime;
            const result = this.parseOutput(content, durationMs);
            this.checkResolve = null;
            resolve(result);
          }
        } catch {
          // File might not be ready yet, keep polling
        }
      }, POLL_INTERVAL_MS);

      // Set timeout
      this.checkTimeoutTimer = setTimeout(() => {
        if (this._status === 'checking' && !this.checkCancelled) {
          this.checkResolve = null;
          reject(new Error(`AI plan check timed out after ${this.config.checkTimeoutMs}ms`));
        }
      }, this.config.checkTimeoutMs);
    });
  }

  private parseOutput(content: string, durationMs: number): AiPlanCheckResult {
    // Remove the done marker and trim
    const output = content.replace(DONE_MARKER, '').trim();

    if (!output) {
      return { verdict: 'ERROR', reasoning: 'Empty output from AI plan check', durationMs };
    }

    // Look for PLAN_MODE or NOT_PLAN_MODE as the first word(s)
    const match = output.match(VERDICT_PATTERN);
    if (!match) {
      return { verdict: 'ERROR', reasoning: `Could not parse verdict from: "${output.substring(0, 100)}"`, durationMs };
    }

    const verdict = match[1].toUpperCase() as 'PLAN_MODE' | 'NOT_PLAN_MODE';
    // Everything after the first line is the reasoning
    const lines = output.split('\n');
    const reasoning = lines.slice(1).join('\n').trim() || `AI determined: ${verdict}`;

    return { verdict, reasoning, durationMs };
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

    // Kill the screen
    if (this.checkScreenName) {
      try {
        execSync(`screen -X -S ${this.checkScreenName} quit 2>/dev/null`, { timeout: 3000 });
      } catch {
        // Screen may already be dead
      }
      this.checkScreenName = null;
    }

    // Delete temp file
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
  }

  private handleError(errorMsg: string): void {
    this.consecutiveErrors++;
    this.log(`AI plan check error (${this.consecutiveErrors}/${this.config.maxConsecutiveErrors}): ${errorMsg}`);

    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      this.disable(`${this.config.maxConsecutiveErrors} consecutive errors: ${errorMsg}`);
    } else {
      this.startCooldown(this.config.errorCooldownMs);
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
    this.log(`AI plan check disabled: ${reason}`);
    this.emit('disabled', reason);
  }

  private log(message: string): void {
    this.emit('log', `[AiPlanChecker] ${message}`);
  }
}
