/**
 * @fileoverview A prompt sent through the input route must actually leave the composer.
 *
 * Claude Code 2.1.277 ignores Enter for the first 30 to 50 seconds after the composer
 * paints while still taking typed text, so text+Enter 50 ms apart left every
 * programmatic prompt sitting unsent (measured 2026-09-19). These pin the recovery:
 * the verifier reads the last glyph line, re-sends Enter only while the prompt is
 * verifiably still there, stops the moment it is gone, never acts on a pane with no
 * composer, is capped, and is cancelled by a newer write or teardown.
 *
 * The browser's composers send a paste and a bare Enter as two writes, which used to arm
 * nothing; the second half pins the pairing, through a real Session on both transports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SubmitVerifier,
  promptStillInComposer,
  SUBMIT_VERIFY_DELAYS_MS,
  bracketedPasteText,
  PastedPromptWatch,
  PASTE_ENTER_WINDOW_MS,
} from '../src/session-submit-verifier.js';
import { Session } from '../src/session.js';

const PROMPT =
  'Read /home/arkon/.codeman/pr-bot/jobs/pr-439/brief.md and carry out the review it describes. Do not ask questions.';

/** Measured 2026-09-19: typed, wrapped, a no-break space after the glyph, never sent. */
const STRANDED = [
  ' ▐▛███▛█   Claude Code v2.1.278',
  '──────────────────────────────────────── prbot-439 ─',
  '❯ Read /home/arkon/.codeman/pr-bot/jobs/pr-439/brief.md and carry out the review it describes. Do not ask',
  '  questions.',
  '────────────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:0 out:0',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

/** The same pane once taken: echoed in the transcript, composer empty. */
const TAKEN = [
  '❯ Read /home/arkon/.codeman/pr-bot/jobs/pr-439/brief.md and carry out the review it describes.',
  '● Reading the brief.',
  '✻ Actioning… (48s · ↓ 6.6k tokens)',
  '──────────────────────────────────────── prbot-439 ─',
  '❯',
  '────────────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:192,963 out:371  ctx:19%',
].join('\n');

describe('promptStillInComposer', () => {
  it('sees the prompt sitting in the composer, no-break space and wrapping included', () => {
    expect(promptStillInComposer(STRANDED, PROMPT, '❯')).toBe(true);
  });
  it('is not fooled by the transcript echo once the composer is empty', () => {
    expect(promptStillInComposer(TAKEN, PROMPT, '❯')).toBe(false);
  });
  it('treats other text in the composer as not ours', () => {
    expect(promptStillInComposer(STRANDED, 'Summarise the changelog', '❯')).toBe(false);
  });
  it('answers undefined for a pane with no composer line, or no glyph', () => {
    expect(promptStillInComposer('$ ls\nfoo bar\n$ ', PROMPT, '❯')).toBeUndefined();
    expect(promptStillInComposer(STRANDED, PROMPT, '')).toBeUndefined();
  });
  it('honours the CLI glyph (Codex draws ›)', () => {
    expect(promptStillInComposer('› Reply with PONG\n', 'Reply with PONG', '›')).toBe(true);
    expect(promptStillInComposer('›\n', 'Reply with PONG', '›')).toBe(false);
  });
  it('reads through ANSI colour codes', () => {
    expect(promptStillInComposer('\x1b[1m❯\x1b[0m \x1b[36mReply with PONG\x1b[0m', 'Reply with PONG', '❯')).toBe(true);
  });
});

describe('SubmitVerifier', () => {
  let screen: string;
  let sends: number;
  let logs: string[];
  const make = (delaysMs?: readonly number[]) =>
    new SubmitVerifier({
      capture: () => screen,
      sendEnter: () => {
        sends++;
      },
      glyph: () => '❯',
      log: (m) => logs.push(m),
      delaysMs,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    screen = STRANDED;
    sends = 0;
    logs = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-sends Enter while the prompt is still there and stops once it is taken', async () => {
    const v = make([1_000, 1_000, 1_000, 1_000]);
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(2);
    screen = TAKEN; // Claude Code finally honoured one
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sends).toBe(2);
    expect(logs[0]).toContain('still in the composer after 1s');
    expect(logs[1]).toContain('(2/4)');
  });

  it('costs one capture and no Enter when the prompt was taken on the first try', async () => {
    let captures = 0;
    const v = new SubmitVerifier({
      capture: () => {
        captures++;
        return TAKEN;
      },
      sendEnter: () => {
        sends++;
      },
      glyph: () => '❯',
    });
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(captures).toBe(1);
    expect(sends).toBe(0);
  });

  it('never presses Enter into a pane with no composer line', async () => {
    screen = '$ npm test\n... running ...\n';
    const v = make([1_000, 1_000]);
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toBe(0);
  });

  it('is capped at the schedule length when the prompt never leaves', async () => {
    const v = make();
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sends).toBe(SUBMIT_VERIFY_DELAYS_MS.length);
  });

  it('production schedule reaches past the measured window', () => {
    const total = SUBMIT_VERIFY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(SUBMIT_VERIFY_DELAYS_MS[0]).toBeLessThanOrEqual(2_000);
    expect(total).toBeGreaterThanOrEqual(60_000);
  });

  it('a newer write replaces the schedule, so an old prompt never submits a new one', async () => {
    const v = make([1_000, 1_000, 1_000]);
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(1);
    screen = '❯ Something the user typed next';
    v.arm('Something the user typed next');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(2); // for the NEW prompt, which is what the composer holds
    screen = '❯';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sends).toBe(2);
  });

  it('cancel() stops everything', async () => {
    const v = make([1_000, 1_000]);
    v.arm(PROMPT);
    v.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toBe(0);
  });

  it('keeps checking when sendEnter throws', async () => {
    let calls = 0;
    const v = new SubmitVerifier({
      capture: () => screen,
      sendEnter: () => {
        calls++;
        throw new Error('tmux hiccup');
      },
      glyph: () => '❯',
      delaysMs: [1_000, 1_000],
    });
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(2);
  });
});

/** Composer chrome measured on Claude Code 2.1.303 (2026-10-19); the prompts are invented. */
const RULE = '────────────────────────────────────────────────────────────────';
const pane = (...composer: string[]) =>
  [
    ' ▐▛███▛█   Claude Code v2.1.303',
    RULE,
    ...composer,
    RULE,
    '  Opus 5.5  in:0 out:0',
    '  paste again to expand',
  ].join('\n');

describe('promptStillInComposer: what a pasted prompt looks like', () => {
  it('reads a short multi-line paste, shown inline, as the prompt', () => {
    const prompt = 'Fix it\rThen run the tests\rand commit';
    expect(promptStillInComposer(pane('❯\xa0Fix it', '  Then run the tests', '  and commit'), prompt, '❯')).toBe(true);
    expect(promptStillInComposer(pane('❯\xa0'), prompt, '❯')).toBe(false);
  });

  it('reads a long word wrapped off the first line', () => {
    const prompt = `Line 1 ${'x'.repeat(200)}`;
    expect(promptStillInComposer(pane('❯\xa0Line 1', `  ${'x'.repeat(118)}`, `  ${'x'.repeat(82)}`), prompt, '❯')).toBe(
      true
    );
  });

  it('counts the stand-in for a long paste only when its line count is the prompt’s', () => {
    const fourLines = 'a\rb\rc\rd';
    expect(promptStillInComposer(pane('❯\xa0[Pasted text #1 +3 lines]'), fourLines, '❯')).toBe(true);
    // `#n` counts pastes, so a later one is still ours.
    expect(promptStillInComposer(pane('❯\xa0[Pasted text #4 +3 lines]'), fourLines, '❯')).toBe(true);
    expect(promptStillInComposer(pane('❯\xa0[Pasted text #1 +1 lines]'), fourLines, '❯')).toBe(false);
    expect(promptStillInComposer(pane('❯\xa0[Pasted text #1]'), fourLines, '❯')).toBe(false);
    const oneLong = 'y'.repeat(900);
    expect(promptStillInComposer(pane('❯\xa0[Pasted text #1]'), oneLong, '❯')).toBe(true);
    expect(promptStillInComposer(pane('❯\xa0[Pasted text #1 +3 lines]'), oneLong, '❯')).toBe(false);
  });

  it('never takes the stand-in plus typed text, or a dialog row, for the prompt', () => {
    expect(promptStillInComposer(pane('❯\xa0[Pasted text #1] and more'), 'y'.repeat(900), '❯')).toBe(false);
    // A short answer has to match whole: `1` is not the highlighted `1. Yes`.
    expect(promptStillInComposer(pane('❯ 1. Yes', '  2. No'), '1', '❯')).toBe(false);
    expect(promptStillInComposer(pane('❯ yes please'), 'yes', '❯')).toBe(false);
    expect(promptStillInComposer(pane('❯ yes'), 'yes', '❯')).toBe(true);
  });
});

describe('bracketedPasteText', () => {
  it('returns the text of exactly one paste and nothing else', () => {
    expect(bracketedPasteText('\x1b[200~hello\rworld\x1b[201~')).toBe('hello\rworld');
    expect(bracketedPasteText('hello\r')).toBeNull();
    expect(bracketedPasteText('\x1b[200~hello\x1b[201~\r')).toBeNull();
    expect(bracketedPasteText('\x1b[200~a\x1b[201~\x1b[200~b\x1b[201~')).toBeNull();
    expect(bracketedPasteText('\x1b[200~')).toBeNull();
  });
});

describe('PastedPromptWatch', () => {
  const paste = (t: string) => `\x1b[200~${t}\x1b[201~`;

  it('pairs a paste with the bare Enter right after it', () => {
    const w = new PastedPromptWatch();
    expect(w.feed(paste('Reply with ready'), 0)).toEqual({ kind: 'paste' });
    expect(w.feed('\r', 120)).toEqual({ kind: 'submit', text: 'Reply with ready' });
    // Spent: a second Enter submits nothing of ours.
    expect(w.feed('\r', 200)).toBeNull();
  });

  it('lets nothing come between the two, and nothing arrive late', () => {
    const w = new PastedPromptWatch();
    w.feed(paste('one'), 0);
    expect(w.feed('x', 50)).toBeNull();
    expect(w.feed('\r', 100)).toBeNull();
    w.feed(paste('two'), 1_000);
    expect(w.feed('\r', 1_000 + PASTE_ENTER_WINDOW_MS + 1)).toBeNull();
  });

  it('ignores an Enter with no paste before it, and an empty paste', () => {
    const w = new PastedPromptWatch();
    expect(w.feed('\r', 0)).toBeNull();
    expect(w.feed(paste('  '), 10)).toEqual({ kind: 'paste' });
    expect(w.feed('\r', 20)).toBeNull();
  });
});

describe('Session: a composer send is checked like any other prompt', () => {
  const STRANDED_PASTE = pane('❯\xa0Reply with only the word ready.');
  const EMPTY = pane('❯\xa0');
  let screen: string;
  let muxEnters: number;

  /** A session with a scripted pane, a recording mux and a PTY that swallows writes. */
  function makeSession(): Session {
    const mux = {
      isAvailable: () => true,
      capturePaneText: () => screen,
      sendInput: async (_id: string, input: string) => {
        if (input === '\r') muxEnters++;
        return true;
      },
    } as unknown as NonNullable<ConstructorParameters<typeof Session>[0]>['mux'];
    const session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      mux,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    } as ConstructorParameters<typeof Session>[0]);
    (session as unknown as { ptyProcess: { write: (d: string) => void } }).ptyProcess = { write: () => {} };
    return session;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    screen = STRANDED_PASTE;
    muxEnters = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('WebSocket: paste then Enter, both raw writes, re-presses Enter until the prompt leaves', async () => {
    const session = makeSession();
    session.write('\x1b[200~Reply with only the word ready.\x1b[201~', { fromUser: true });
    session.write('\r', { fromUser: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(muxEnters).toBe(1);
    screen = EMPTY;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(muxEnters).toBe(1);
  });

  it('POST fallback: the Enter goes through writeViaMux and arms the same check', async () => {
    const session = makeSession();
    session.write('\x1b[200~Reply with only the word ready.\x1b[201~', { fromUser: true });
    await session.writeViaMux('\r', { fromUser: true });
    expect(muxEnters).toBe(1); // the Enter itself
    await vi.advanceTimersByTimeAsync(2_000);
    expect(muxEnters).toBe(2);
  });

  it('a taken prompt costs nothing more', async () => {
    screen = EMPTY;
    const session = makeSession();
    session.write('\x1b[200~Reply with only the word ready.\x1b[201~', { fromUser: true });
    session.write('\r', { fromUser: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(muxEnters).toBe(0);
  });

  it('a newer paste cancels the check, so Enter never sends the user’s own paste', async () => {
    const session = makeSession();
    session.write(`\x1b[200~${'y'.repeat(900)}\x1b[201~`, { fromUser: true });
    session.write('\r', { fromUser: true });
    // Taken; then the user pastes something long of their own into the terminal.
    session.write(`\x1b[200~${'z'.repeat(900)}\x1b[201~`, { fromUser: true });
    screen = pane('❯\xa0[Pasted text #2]');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(muxEnters).toBe(0);
  });

  it('typing in the terminal arms nothing', async () => {
    screen = pane('❯\xa0hi');
    const session = makeSession();
    for (const key of ['h', 'i', '\r']) session.write(key, { fromUser: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(muxEnters).toBe(0);
  });
});
