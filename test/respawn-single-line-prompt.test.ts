/**
 * Respawn prompts go out as ONE line, whatever the config holds.
 *
 * The update and kickstart prompts are textareas in the settings, so a saved config
 * can hold several lines. `TmuxManager.sendInput()` used to strip every `\n`, which
 * ran the lines together; it now pastes multi-line text as one block. Respawn runs
 * unattended, and the check that re-presses a stranded Enter cannot recognise a
 * multi-line paste in the composer, so the controller joins the lines with a space
 * before the write instead of leaning on the mux to drop them.
 *
 * Strategy: drive the step methods directly against a MockSession and read what
 * reached `writeViaMux`. No real tmux.
 *
 * Port: N/A (no server / no real tmux)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn((_cmd: string, cb?: (e: Error | null, o: string) => void) => cb?.(null, '')) };
});

import { RespawnController, singleLineRespawnPrompt } from '../src/respawn-controller.js';
import { Session } from '../src/session.js';
import { MockSession } from './mocks/index.js';

describe('singleLineRespawnPrompt', () => {
  it('joins lines with one space, folding the whitespace around each break', () => {
    expect(singleLineRespawnPrompt('update the docs\n\n  then CLAUDE.md\r\nand continue')).toBe(
      'update the docs then CLAUDE.md and continue'
    );
  });

  it('returns a single-line prompt unchanged', () => {
    expect(singleLineRespawnPrompt('  keep "quotes" and $vars  ')).toBe('  keep "quotes" and $vars  ');
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
