# Respawn Controller State Machine

The respawn controller (`src/respawn-controller.ts`) manages autonomous session cycling. It detects idle sessions and restarts them through a configurable sequence of steps.

## State Diagram

```
WATCHING → CONFIRMING_IDLE → AI_CHECKING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR
    ↑         │ (new output)      │ (WORKING)                                              │
    │         ↓                   ↓                                                        ▼
    │       (reset)           (cooldown)              SENDING_INIT → WAITING_INIT → MONITORING_INIT
    │                                                                                    │
    │                                                           (if no work triggered)   ▼
    └──────────────────────────────────────── SENDING_KICKSTART ← WAITING_KICKSTART ◄────┘
```

## States

| State | Description |
|-------|-------------|
| `watching` | Monitoring session output for idle signals |
| `confirming_idle` | Waiting to confirm session is truly idle (cancels if new output arrives) |
| `ai_checking` | Running AI idle check to verify IDLE/WORKING status |
| `sending_update` | About to send `/update` command |
| `waiting_update` | Waiting for `/update` to complete (output silence) |
| `sending_clear` | About to send `/clear` command |
| `waiting_clear` | Waiting for `/clear` to complete |
| `sending_init` | About to send `/init` command |
| `waiting_init` | Waiting for `/init` to complete |
| `monitoring_init` | Watching if `/init` triggered actual work |
| `sending_kickstart` | About to send kickstart prompt |
| `waiting_kickstart` | Waiting for kickstart to complete |
| `stopped` | Controller is disabled |

## Configuration

Steps can be skipped via config:
- `sendClear: false` - Skip the clear step
- `sendInit: false` - Skip the init step
- `kickstartPrompt` - Optional prompt if `/init` doesn't trigger work

## Step Confirmation

After sending each step (update, clear, init, kickstart), the controller waits for `completionConfirmMs` (10s) of output silence before proceeding. This prevents sending commands while Claude is still processing.

## Idle Detection (Multi-Layer)

1. **Completion message**: Primary signal - detects "Worked for Xm Xs" time patterns (requires "Worked" prefix to avoid false positives)
2. **AI Idle Check** (enabled by default): Spawns a fresh Claude session in a tmux session to analyze terminal output and provide IDLE/WORKING verdict. Uses `claude-opus-4-5-20251101` by default, sends last 16k chars of terminal buffer. Timeout 90s, cooldown 3min after WORKING. Auto-disables after 3 consecutive errors. The AI prompt is conservative: when in doubt, it answers WORKING.
3. **Output silence**: Confirms idle after `completionConfirmMs` (10s) of no new output
4. **Token stability**: Tokens haven't changed
5. **Working patterns absent**: No `Thinking`, `Writing`, spinner chars, etc. for at least 8 seconds
6. **Session.isWorking check**: Final safety - if the Session class reports `isWorking=true`, idle confirmation is rejected

**Working Pattern Detection**:
- Uses a rolling 300-character window to catch patterns split across PTY chunks
- Patterns include: Thinking, Writing, Reading, Running, Searching, Editing, Creating, Deleting, Analyzing, Executing, Synthesizing, Compiling, Building, Processing, Loading, Generating, Testing, Checking, Validating, and spinner characters

Uses `confirming_idle` state to prevent false positives. Cancels idle confirmation if substantial output (>2 chars after ANSI stripping) arrives during the wait. Fallback: `noOutputTimeoutMs` (30s) if no output at all. AI check is triggered after the no-output fallback; if AI check is disabled/errored, falls back to direct idle confirmation.

## Auto-Accept Plan Mode

Enabled by default. After `autoAcceptDelayMs` (8s) of silence with no completion message and no `elicitation_dialog` hook signal detected, sends Enter to accept the plan. Does NOT auto-accept AskUserQuestion prompts - those are blocked via the `elicitation_dialog` notification hook which signals the respawn controller to skip auto-accept.

## AI Plan Checker

When auto-accept is about to trigger, the AI Plan Checker (`src/ai-plan-checker.ts`) can optionally verify the terminal is showing a plan mode approval prompt before sending Enter. This prevents false auto-accepts.

- **Model**: `claude-opus-4-5-20251101` (same as idle checker)
- **Max context**: 8k chars (less than idle checker since plan prompts are visible at bottom)
- **Timeout**: 60s
- **Verdicts**: `PLAN_MODE` (safe to auto-accept) or `NOT_PLAN_MODE` (skip auto-accept)
- **Cooldown**: 30s after NOT_PLAN_MODE verdict
- **Error handling**: 3 consecutive errors disables the checker

Uses temp file for prompt to avoid E2BIG errors with large terminal buffers.

## Test Documentation

- `test/respawn-scenarios.md` - Comprehensive test scenarios for edge cases
- `test/respawn-test-plan.md` - Test environment architecture and strategies
- `test/respawn-test-utils.ts` - Mock utilities (MockSession, MockAiIdleChecker, MockAiPlanChecker)
- `test/respawn-analysis.md` - Code coverage analysis and identified issues
