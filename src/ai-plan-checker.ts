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
 * 2. Spawn tmux: `tmux new-session -d -s codeman-plancheck-<short> bash -c 'claude -p ...'`
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
} from './ai-checker-base.js';
import {
  AI_CHECK_MODEL,
  AI_PLAN_CHECK_MAX_CONTEXT,
  AI_PLAN_CHECK_TIMEOUT_MS,
  AI_PLAN_CHECK_COOLDOWN_MS,
  AI_PLAN_CHECK_ERROR_COOLDOWN_MS,
  AI_CHECK_MAX_CONSECUTIVE_ERRORS,
} from './config/ai-defaults.js';

// ========== Types ==========

type AiPlanCheckConfig = AiCheckerConfigBase;

export type AiPlanCheckVerdict = 'PLAN_MODE' | 'NOT_PLAN_MODE' | 'ERROR';

export type AiPlanCheckResult = AiCheckerResultBase<AiPlanCheckVerdict>;

type AiPlanCheckState = AiCheckerStateBase<AiPlanCheckVerdict>;

// ========== Constants ==========

const DEFAULT_PLAN_CHECK_CONFIG: AiPlanCheckConfig = {
  enabled: true,
  model: AI_CHECK_MODEL,
  maxContextChars: AI_PLAN_CHECK_MAX_CONTEXT,
  checkTimeoutMs: AI_PLAN_CHECK_TIMEOUT_MS,
  cooldownMs: AI_PLAN_CHECK_COOLDOWN_MS,
  errorCooldownMs: AI_PLAN_CHECK_ERROR_COOLDOWN_MS,
  maxConsecutiveErrors: AI_CHECK_MAX_CONSECUTIVE_ERRORS,
};

/** Pattern to match PLAN_MODE or NOT_PLAN_MODE as the first word(s) of output */
const VERDICT_PATTERN = /^\s*(PLAN_MODE|NOT_PLAN_MODE)\b/i;

/** The prompt sent to the AI plan checker */
const AI_PLAN_CHECK_PROMPT = `Analyze this terminal output from a running Claude Code session. Determine if the terminal is currently showing a NUMBERED SELECTION MENU that is waiting for the user to press Enter on the highlighted default option.

A qualifying menu has all of these characteristics:
- A numbered list of options (e.g., "1. Yes", "2. No", "3. Type your own")
- A selection indicator arrow (❯ or >) pointing to one of the options (the default)
- The menu appears at the BOTTOM of the output (most recent content)
- It is asking the user to choose, not just displaying numbered information

This includes BOTH:
- Plan-mode approval prompts ("Would you like to proceed?" / "Ready to implement?")
- AskUserQuestion / elicitation dialogs (Claude Code's numbered question menus)

NOT a qualifying menu:
- Claude actively working (spinners, "Thinking", tool execution)
- A completed response with no selection menu visible
- A free-text input field with no numbered options
- A numbered LIST in the assistant's prose with no selection arrow
- Network lag or mid-output pause
- Any state without a visible selector arrow on a numbered option

The verdict name PLAN_MODE is historical — it now means "auto-accept this selection menu by pressing Enter on the default".

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
  protected readonly muxNamePrefix = 'codeman-plancheck-';
  protected readonly doneMarker = '__PLANCHECK_DONE__';
  protected readonly tempFilePrefix = 'codeman-plancheck';
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

  protected createErrorResult(reasoning: string, durationMs: number): AiPlanCheckResult {
    return { verdict: 'ERROR', reasoning, durationMs };
  }

  protected createResult(verdict: AiPlanCheckVerdict, reasoning: string, durationMs: number): AiPlanCheckResult {
    return { verdict, reasoning, durationMs };
  }
}
