/**
 * @fileoverview AI-Powered Plan Mode Checker for Auto-Accept
 *
 * Spawns a fresh Claude CLI session in a tmux session to analyze terminal output
 * and determine if Claude Code is showing a plan mode approval prompt.
 * Used as a confirmation gate before auto-accepting prompts.
 *
 * ## How It Works
 *
 * 1. Generate temp file path for output capture
 * 2. Spawn tmux: `tmux new-session -d -s claudeman-plancheck-<short> bash -c 'claude -p ...'`
 * 3. Poll the temp file every 500ms for `__PLANCHECK_DONE__` marker
 * 4. Parse the file content for PLAN_MODE/NOT_PLAN_MODE on the first line
 * 5. Kill tmux session and delete temp file
 *
 * ## Error Handling
 *
 * - Tmux spawn fails: 30s cooldown, increment error counter
 * - Check times out (60s): Kill session, 30s cooldown
 * - Can't parse verdict: Treat as NOT_PLAN_MODE, 30s cooldown
 * - 3 consecutive errors: Disable AI plan check
 *
 * @module ai-plan-checker
 */

import {
  AiCheckerBase,
  type AiCheckerConfigBase,
  type AiCheckerResultBase,
  type AiCheckerStateBase,
  type AiCheckerStatus,
} from './ai-checker-base.js';

// ========== Types ==========

export interface AiPlanCheckConfig extends AiCheckerConfigBase {}

// Re-export the status type for backwards compatibility
export type AiPlanCheckStatus = AiCheckerStatus;
export type AiPlanCheckVerdict = 'PLAN_MODE' | 'NOT_PLAN_MODE' | 'ERROR';

export interface AiPlanCheckResult extends AiCheckerResultBase<AiPlanCheckVerdict> {}

export interface AiPlanCheckState extends AiCheckerStateBase<AiPlanCheckVerdict> {}

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
export class AiPlanChecker extends AiCheckerBase<
  AiPlanCheckVerdict,
  AiPlanCheckConfig,
  AiPlanCheckResult,
  AiPlanCheckState
> {
  protected readonly muxNamePrefix = 'claudeman-plancheck-';
  protected readonly doneMarker = '__PLANCHECK_DONE__';
  protected readonly tempFilePrefix = 'claudeman-plancheck';
  protected readonly logPrefix = '[AiPlanChecker]';
  protected readonly checkDescription = 'AI plan check';

  constructor(sessionId: string, config: Partial<AiPlanCheckConfig> = {}) {
    super(sessionId, DEFAULT_PLAN_CHECK_CONFIG, config);
  }

  protected buildPrompt(terminalBuffer: string): string {
    return AI_PLAN_CHECK_PROMPT.replace('{TERMINAL_BUFFER}', terminalBuffer);
  }

  protected parseVerdict(output: string): { verdict: AiPlanCheckVerdict; reasoning: string } | null {
    const match = output.match(VERDICT_PATTERN);
    if (!match) return null;

    const verdict = match[1].toUpperCase() as 'PLAN_MODE' | 'NOT_PLAN_MODE';
    const lines = output.split('\n');
    const reasoning = lines.slice(1).join('\n').trim() || `AI determined: ${verdict}`;

    return { verdict, reasoning };
  }

  protected getPositiveVerdict(): AiPlanCheckVerdict {
    return 'PLAN_MODE';
  }

  protected getNegativeVerdict(): AiPlanCheckVerdict {
    return 'NOT_PLAN_MODE';
  }

  protected getErrorVerdict(): AiPlanCheckVerdict {
    return 'ERROR';
  }

  protected createErrorResult(reasoning: string, durationMs: number): AiPlanCheckResult {
    return { verdict: 'ERROR', reasoning, durationMs };
  }

  protected createResult(verdict: AiPlanCheckVerdict, reasoning: string, durationMs: number): AiPlanCheckResult {
    return { verdict, reasoning, durationMs };
  }
}
