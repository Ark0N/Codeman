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

import {
  AiCheckerBase,
  type AiCheckerConfigBase,
  type AiCheckerResultBase,
  type AiCheckerStateBase,
  type AiCheckerStatus,
} from './ai-checker-base.js';

// ========== Types ==========

export interface AiIdleCheckConfig extends AiCheckerConfigBase {}

// Re-export the status type for backwards compatibility
export type AiCheckStatus = AiCheckerStatus;
export type AiCheckVerdict = 'IDLE' | 'WORKING' | 'ERROR';

export interface AiCheckResult extends AiCheckerResultBase<AiCheckVerdict> {}

export interface AiCheckState extends AiCheckerStateBase<AiCheckVerdict> {}

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

/** Pattern to match IDLE or WORKING as the first word of output */
const VERDICT_PATTERN = /^\s*(IDLE|WORKING)\b/i;

/**
 * The prompt sent to the AI idle checker.
 *
 * P1-005: Enhanced with more specific working pattern examples and clearer structure.
 */
const AI_CHECK_PROMPT = `You are analyzing terminal output from a Claude Code CLI session. Determine if Claude has FINISHED working (IDLE) or is STILL WORKING (WORKING).

CRITICAL RULE: When in doubt, ALWAYS answer WORKING. False positives (saying IDLE when Claude is working) cause session interruptions. It's safer to wait longer than to interrupt active work.

## IDLE Indicators (need AT LEAST 2 of these together)

1. **Completion Summary** - The most reliable signal:
   - "✻ Worked for Xm Ys" (e.g., "✻ Worked for 2m 46s")
   - "Worked for Xs" (e.g., "Worked for 5s")
   - Cost summary: "$X.XX spent" or "X tokens used"

2. **Input Prompt Visible**:
   - The ❯ prompt character at the very end
   - Empty line after completion summary
   - Waiting cursor position

3. **Task Completion Language**:
   - "All done", "Finished", "Completed successfully"
   - Explicit "waiting for input" or similar

## WORKING Indicators (ANY ONE of these = answer WORKING)

### Active Processing Indicators:
- **Spinners**: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏ (Braille), ◐ ◓ ◑ ◒ (quarter), ⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷
- **Activity Words**: Thinking, Writing, Reading, Running, Searching, Editing, Creating, Deleting, Analyzing, Executing, Synthesizing, Compiling, Building, Processing, Loading, Generating, Testing, Checking, Validating, Brewing, Formatting, Linting, Installing, Fetching, Downloading

### Tool Execution in Progress:
- Bash commands with no result shown yet
- "Running: npm test", "Executing command..."
- File read/write operations incomplete
- Progress bars or percentage indicators
- Test suite running (dots appearing, "Test Suites: X passed")

### Output Structure Issues:
- Truncated lines without completion
- JSON/code blocks not closed
- Multi-line output clearly incomplete
- "..." indicating more to come
- Output ending mid-sentence or mid-word

### Claude Planning/Thinking:
- "Let me...", "I'll...", "Now I need to..."
- TodoWrite updates without completion
- Plan mode approval prompts (numbered options)

## Terminal Output to Analyze
---
{TERMINAL_BUFFER}
---

## Your Response
First line: EXACTLY "IDLE" or "WORKING" (nothing else)
Second line onwards: Brief explanation of your reasoning.

Remember: When uncertain, answer WORKING.`;

// ========== AiIdleChecker Class ==========

/**
 * Manages AI-powered idle detection by spawning a fresh Claude CLI session
 * to analyze terminal output and provide a definitive IDLE/WORKING verdict.
 */
export class AiIdleChecker extends AiCheckerBase<
  AiCheckVerdict,
  AiIdleCheckConfig,
  AiCheckResult,
  AiCheckState
> {
  protected readonly screenNamePrefix = 'claudeman-aicheck-';
  protected readonly doneMarker = '__AICHECK_DONE__';
  protected readonly tempFilePrefix = 'claudeman-aicheck';
  protected readonly logPrefix = '[AiIdleChecker]';
  protected readonly checkDescription = 'AI idle check';

  constructor(sessionId: string, config: Partial<AiIdleCheckConfig> = {}) {
    super(sessionId, DEFAULT_AI_CHECK_CONFIG, config);
  }

  protected buildPrompt(terminalBuffer: string): string {
    return AI_CHECK_PROMPT.replace('{TERMINAL_BUFFER}', terminalBuffer);
  }

  protected parseVerdict(output: string): { verdict: AiCheckVerdict; reasoning: string } | null {
    const match = output.match(VERDICT_PATTERN);
    if (!match) return null;

    const verdict = match[1].toUpperCase() as 'IDLE' | 'WORKING';
    const lines = output.split('\n');
    const reasoning = lines.slice(1).join('\n').trim() || `AI determined: ${verdict}`;

    return { verdict, reasoning };
  }

  protected getPositiveVerdict(): AiCheckVerdict {
    return 'IDLE';
  }

  protected getNegativeVerdict(): AiCheckVerdict {
    return 'WORKING';
  }

  protected getErrorVerdict(): AiCheckVerdict {
    return 'ERROR';
  }

  protected createErrorResult(reasoning: string, durationMs: number): AiCheckResult {
    return { verdict: 'ERROR', reasoning, durationMs };
  }

  protected createResult(verdict: AiCheckVerdict, reasoning: string, durationMs: number): AiCheckResult {
    return { verdict, reasoning, durationMs };
  }
}
