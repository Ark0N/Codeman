/**
 * The senders that run unattended write a prompt as ONE line, whatever the config holds.
 *
 * Respawn's update and kickstart prompts are textareas in the settings, and the
 * auto-compact focus prompt's schema accepts line breaks, so a saved config can hold
 * several lines. `TmuxManager.sendInput()` used to strip every `\n`, which ran the
 * lines together; it now pastes multi-line text as one block. These senders run
 * unattended, and the check that re-presses a stranded Enter cannot reliably
 * recognise a multi-line paste in the composer, so they join the lines with a space
 * before the write (`toSingleLine()`) instead of leaning on the mux to drop them.
 *
 * Strategy: drive the respawn step methods against a MockSession, and feed a real
 * Session a token count over its auto-compact threshold, then read what reached
 * `writeViaMux`. No real tmux.
 *
 * Port: N/A (no server / no real tmux)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn((_cmd: string, cb?: (e: Error | null, o: string) => void) => cb?.(null, '')) };
});

import { RespawnController } from '../src/respawn-controller.js';
import { toSingleLine } from '../src/utils/single-line.js';
import { Session } from '../src/session.js';
import { MockSession } from './mocks/index.js';

describe('toSingleLine', () => {
  it('joins lines with one space, folding the whitespace around each break', () => {
    expect(toSingleLine('update the docs\n\n  then CLAUDE.md\r\nand continue')).toBe(
      'update the docs then CLAUDE.md and continue'
    );
  });

  it('returns a single-line prompt unchanged', () => {
    expect(toSingleLine('  keep "quotes" and $vars  ')).toBe('  keep "quotes" and $vars  ');
  });

  it('drops leading and trailing blank lines instead of leaving a space there', () => {
    expect(toSingleLine('\n  compact the log  \n\n')).toBe('compact the log');
  });

  it('stays linear on a long whitespace run', () => {
    // The run sits inside a line, so the result is the same either way; only the time
    // differs. A regex that folds the whitespace around each break retries the run from
    // every start position: 50,000 spaces took over a second that way. The split takes
    // well under a millisecond, so the bound leaves room either side.
    const run = ' '.repeat(50_000);
    const started = performance.now();
    const joined = toSingleLine(`a${run}b\nc`);
    const elapsed = performance.now() - started;
    expect(joined).toBe(`a${run}b c`);
    expect(elapsed).toBeLessThan(250);
  });
});

describe('respawn steps send a multi-line prompt as one line', () => {
  let controller: RespawnController | null = null;

  afterEach(() => controller?.stop());

  /** Run one step method and return what it wrote through the mux. */
  async function written(
    config: { updatePrompt?: string; kickstartPrompt?: string },
    step: 'sendUpdateDocs' | 'sendKickstart',
    recommendation?: string
  ): Promise<string[]> {
    const session = new MockSession();
    if (recommendation !== undefined) {
      (session as unknown as { ralphTracker: unknown }).ralphTracker = { lastStatusBlock: { recommendation } };
    }
    controller = new RespawnController(session as unknown as Session, {
      interStepDelayMs: 10,
      completionConfirmMs: 10,
      noOutputTimeoutMs: 500,
      aiIdleCheckEnabled: false,
      ...config,
    });
    (controller as never as { _state: string })._state = 'watching';
    (controller as never as Record<typeof step, () => void>)[step]();
    // The step schedules its write on the step-delay timer.
    await new Promise((r) => setTimeout(r, 40));
    return session.writeBuffer;
  }

  it('update prompt', async () => {
    const writes = await written(
      { updatePrompt: 'summarise progress\nin CLAUDE.md\n\nthen continue' },
      'sendUpdateDocs'
    );
    expect(writes).toEqual(['summarise progress in CLAUDE.md then continue\r']);
  });

  it('update prompt with a recommendation appended', async () => {
    const writes = await written({ updatePrompt: 'summarise\nprogress' }, 'sendUpdateDocs', 'fix the\nlogin test');
    expect(writes).toEqual(["summarise progress (Claude's last recommendation: fix the login test)\r"]);
  });

  it('kickstart prompt', async () => {
    const writes = await written(
      { kickstartPrompt: 'read @fix_plan.md\r\ncontinue with the next task' },
      'sendKickstart'
    );
    expect(writes).toEqual(['read @fix_plan.md continue with the next task\r']);
  });

  it('a single-line prompt is sent as before', async () => {
    const writes = await written({ updatePrompt: 'update all the docs and CLAUDE.md' }, 'sendUpdateDocs');
    expect(writes).toEqual(['update all the docs and CLAUDE.md\r']);
  });
});

describe('auto-compact sends a multi-line focus prompt as one line', () => {
  afterEach(() => vi.useRealTimers());

  /**
   * Feed a Session a status line over the threshold and return what its auto-compact
   * wrote through `writeViaMux`: the session's own token parser, the trigger and its
   * timers, and the `writeCommand` wiring all run as in production.
   */
  async function compactWrites(prompt?: string): Promise<string[]> {
    vi.useFakeTimers();
    const session = new Session({ workingDir: '/tmp' });
    const writeViaMux = vi.spyOn(session, 'writeViaMux').mockResolvedValue(true);
    session.setAutoCompact(true, 1_000, prompt);
    (session as never as { parseTokensFromStatusLine(s: string): void }).parseTokensFromStatusLine('5.0k tokens');
    // The trigger waits AUTO_INITIAL_DELAY_MS (1 s) before it writes.
    await vi.advanceTimersByTimeAsync(1_500);
    return writeViaMux.mock.calls.map((call) => call[0]);
  }

  it('focus prompt with line breaks', async () => {
    expect(await compactWrites('keep the open tasks\n\n  and the test results\r\nfrom today')).toEqual([
      '/compact keep the open tasks and the test results from today\r',
    ]);
  });

  it('a single-line focus prompt is sent as before', async () => {
    expect(await compactWrites('keep the open tasks')).toEqual(['/compact keep the open tasks\r']);
  });

  it('no focus prompt sends a bare /compact', async () => {
    expect(await compactWrites()).toEqual(['/compact\r']);
  });
});
