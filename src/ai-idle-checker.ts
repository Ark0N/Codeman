/**
 * @fileoverview AI-Powered Idle Checker for Respawn Controller
 *
 * Spawns a fresh Claude CLI session in a screen to analyze terminal output
 * and provide a definitive IDLE/WORKING verdict. This replaces the "Worked for Xm Xs"
 * pattern as the primary idle detection signal.
 *
 * ## How It Works
 *
 * 1. Generate temp file path for output capture
 * 2. Spawn screen: `screen -dmS claudeman-aicheck-<short> bash -c 'claude -p ...'`
 * 3. Poll the temp file every 500ms for `__AICHECK_DONE__` marker
 * 4. Parse the file content for IDLE/WORKING on the first word
 * 5. Kill screen and delete temp file
 *
 * ## Error Handling
 *
 * - Screen spawn fails: 1-min cooldown, increment error counter
 * - Check times out (90s): Kill screen, 1-min cooldown
 * - Can't parse IDLE/WORKING: Treat as WORKING, 1-min cooldown
 * - 3 consecutive errors: Disable AI check, fall back to noOutputTimeoutMs
 * - Claude CLI not found: Disable permanently
 *
 * @module ai-idle-checker
 */

import { execSync, spawn as childSpawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { getAugmentedPath } from './session.js';

// ========== Types ==========

export interface AiIdleCheckConfig {
  /** Whether AI idle check is enabled */
  enabled: boolean;
  /** Model to use for the check */
  model: string;
  /** Maximum characters of terminal buffer to send */
  maxContextChars: number;
  /** Timeout for the check in ms */
  checkTimeoutMs: number;
  /** Cooldown after WORKING verdict in ms */
  cooldownMs: number;
  /** Cooldown after errors in ms */
  errorCooldownMs: number;
  /** Max consecutive errors before disabling */
  maxConsecutiveErrors: number;
}

export type AiCheckStatus = 'ready' | 'checking' | 'cooldown' | 'disabled' | 'error';
export type AiCheckVerdict = 'IDLE' | 'WORKING' | 'ERROR';

export interface AiCheckResult {
  verdict: AiCheckVerdict;
  reasoning: string;
  durationMs: number;
}

export interface AiCheckState {
  status: AiCheckStatus;
  lastVerdict: AiCheckVerdict | null;
  lastReasoning: string | null;
  lastCheckDurationMs: number | null;
  cooldownEndsAt: number | null;
  consecutiveErrors: number;
  totalChecks: number;
  disabledReason: string | null;
}

/** Events emitted by AiIdleChecker */
export interface AiIdleCheckerEvents {
  checkStarted: () => void;
  checkCompleted: (result: AiCheckResult) => void;
  checkFailed: (error: string) => void;
  cooldownStarted: (endsAt: number) => void;
  cooldownEnded: () => void;
  disabled: (reason: string) => void;
  log: (message: string) => void;
}

// ========== Constants ==========

const DEFAULT_AI_CHECK_CONFIG: AiIdleCheckConfig = {
  enabled: true,
  model: 'claude-opus-4-5-20251101',
  maxContextChars: 16000,
  checkTimeoutMs: 90000,
  cooldownMs: 180000,
  errorCooldownMs: 60000,
  maxConsecutiveErrors: 3,
};

/** ANSI escape code pattern for stripping terminal formatting */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Poll interval for checking temp file completion */
const POLL_INTERVAL_MS = 500;

/** Marker written to temp file when check is complete */
const DONE_MARKER = '__AICHECK_DONE__';

/** Pattern to match IDLE or WORKING as the first word of output */
const VERDICT_PATTERN = /^\s*(IDLE|WORKING)\b/i;

/** The prompt sent to the AI checker */
const AI_CHECK_PROMPT = `Analyze this terminal output from a running Claude Code session. Determine if the session is IDLE (done working, waiting for new input) or WORKING (still actively processing).

IDLE indicators: prompt character at the end, completion summary shown ("Worked for Xm Xs"), clear stopping point, no spinners, cost summary displayed
WORKING indicators: spinner chars, "Thinking"/"Writing"/"Reading"/"Running" text, active tool execution, truncated mid-output, partial lines

Terminal output (most recent at bottom):
---
{TERMINAL_BUFFER}
---

Answer with EXACTLY one word on the first line: IDLE or WORKING
Then optionally explain briefly why.`;

// ========== AiIdleChecker Class ==========

/**
 * Manages AI-powered idle detection by spawning a fresh Claude CLI session
 * to analyze terminal output and provide a definitive IDLE/WORKING verdict.
 */
export class AiIdleChecker extends EventEmitter {
  private config: AiIdleCheckConfig;
  private sessionId: string;

  // State
  private _status: AiCheckStatus = 'ready';
  private lastVerdict: AiCheckVerdict | null = null;
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
  private checkResolve: ((result: AiCheckResult) => void) | null = null;

  constructor(sessionId: string, config: Partial<AiIdleCheckConfig> = {}) {
    super();
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_AI_CHECK_CONFIG, ...config };
  }

  /** Get the current status */
  get status(): AiCheckStatus {
    return this._status;
  }

  /** Get comprehensive state for UI display */
  getState(): AiCheckState {
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
   * Run an AI idle check against the provided terminal buffer.
   * Spawns a fresh Claude CLI in a screen, captures output to temp file.
   *
   * @param terminalBuffer - Raw terminal output to analyze
   * @returns The verdict result
   */
  async check(terminalBuffer: string): Promise<AiCheckResult> {
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
    this.log('Starting AI idle check');

    try {
      const result = await this.runCheck(terminalBuffer);

      if (this.checkCancelled) {
        return { verdict: 'ERROR', reasoning: 'Cancelled', durationMs: Date.now() - this.checkStartTime };
      }

      this.lastVerdict = result.verdict;
      this.lastReasoning = result.reasoning;
      this.lastCheckDurationMs = result.durationMs;

      if (result.verdict === 'IDLE') {
        this.consecutiveErrors = 0;
        this._status = 'ready';
        this.log(`AI check verdict: IDLE (${result.durationMs}ms) - ${result.reasoning}`);
      } else if (result.verdict === 'WORKING') {
        this.consecutiveErrors = 0;
        this.startCooldown(this.config.cooldownMs);
        this.log(`AI check verdict: WORKING (${result.durationMs}ms) - ${result.reasoning}`);
      } else {
        this.handleError('Unexpected verdict');
      }

      this.emit('checkCompleted', result);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.handleError(errorMsg);
      const result: AiCheckResult = {
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

    this.log('Cancelling AI check');
    this.checkCancelled = true;

    // Resolve the pending promise before cleanup
    if (this.checkResolve) {
      this.checkResolve({ verdict: 'ERROR', reasoning: 'Cancelled', durationMs: Date.now() - this.checkStartTime });
      this.checkResolve = null;
    }

    this.cleanupCheck();
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
  updateConfig(config: Partial<AiIdleCheckConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.enabled === false) {
      this.disable('Disabled by config');
    } else if (config.enabled === true && this._status === 'disabled') {
      this.disabledReason = null;
      this._status = 'ready';
    }
  }

  /** Get current config */
  getConfig(): AiIdleCheckConfig {
    return { ...this.config };
  }

  // ========== Private Methods ==========

  private async runCheck(terminalBuffer: string): Promise<AiCheckResult> {
    // Prepare the terminal buffer (strip ANSI, trim to maxContextChars)
    const stripped = terminalBuffer.replace(ANSI_ESCAPE_PATTERN, '');
    const trimmed = stripped.length > this.config.maxContextChars
      ? stripped.slice(-this.config.maxContextChars)
      : stripped;

    // Build the prompt
    const prompt = AI_CHECK_PROMPT.replace('{TERMINAL_BUFFER}', trimmed);

    // Generate temp file and screen name
    const shortId = this.sessionId.slice(0, 8);
    const timestamp = Date.now();
    this.checkTempFile = join(tmpdir(), `claudeman-aicheck-${shortId}-${timestamp}.txt`);
    this.checkScreenName = `claudeman-aicheck-${shortId}`;

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
      throw new Error(`Failed to spawn AI check screen: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Poll the temp file for completion
    return new Promise<AiCheckResult>((resolve, reject) => {
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
          reject(new Error(`AI check timed out after ${this.config.checkTimeoutMs}ms`));
        }
      }, this.config.checkTimeoutMs);
    });
  }

  private parseOutput(content: string, durationMs: number): AiCheckResult {
    // Remove the done marker and trim
    const output = content.replace(DONE_MARKER, '').trim();

    if (!output) {
      return { verdict: 'ERROR', reasoning: 'Empty output from AI check', durationMs };
    }

    // Look for IDLE or WORKING as the first word
    const match = output.match(VERDICT_PATTERN);
    if (!match) {
      return { verdict: 'ERROR', reasoning: `Could not parse verdict from: "${output.substring(0, 100)}"`, durationMs };
    }

    const verdict = match[1].toUpperCase() as 'IDLE' | 'WORKING';
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
    this.log(`AI check error (${this.consecutiveErrors}/${this.config.maxConsecutiveErrors}): ${errorMsg}`);

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
    this.log(`AI check disabled: ${reason}`);
    this.emit('disabled', reason);
  }

  private log(message: string): void {
    this.emit('log', `[AiIdleChecker] ${message}`);
  }
}
