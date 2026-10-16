/**
 * A Codex session waiting on one of its own dialogs is BLOCKED, read off the screen.
 *
 * Codex is the one CLI Codeman launches with its approvals on by default, and it has no
 * hook to say it stopped for one (`hooks: 'none'`), so a session parked on "Would you like
 * to run the following command?" used to read as plainly idle, and one parked on a
 * question (whose key hints carry `esc to interrupt`, codex's working line) as WORKING.
 * The registry's `capabilities.workDetect.blockedLine` now names the dialog's chrome, the
 * session reads it at every settle and on a timer while it is up, and the server raises
 * exactly what a Claude `permission_prompt` hook raises, alert-only.
 *
 * The fixtures in `test/fixtures/codex-dialogs/` are live `tmux capture-pane -p` frames
 * (no -J, what `capturePaneText()` reads) of codex-cli 0.162.0 on 2026-10-14, run with
 * `-a on-request -s read-only` at 200, 80, 60, 44 and 36 columns; only trailing
 * whitespace was trimmed and the scratch path replaced by `/tmp/codex-scratch/repo`.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import {
  isBlockedScreen,
  BLOCKED_TAIL_LINES,
  BLOCKED_MAX_TAIL_LINES,
  BLOCKED_RECHECK_MS,
  BLOCKED_CLEAR_READS,
  BLOCKED_QUIET_RECHECK_MS,
  IDLE_SILENCE_MS,
  PANE_PROBE_MIN_INTERVAL_MS,
} from '../src/session-activity.js';
import type { SessionMode } from '../src/types.js';

const DETECT = getCli('codex')!.capabilities.workDetect!;
const CODEX_BLOCKED = compileVersionRegex(DETECT.blockedLine!)!;
const CODEX_WINDOW = DETECT.blockedLines!;
const CODEX_WORKING = compileVersionRegex(DETECT.workingLine)!;

const FIXTURES = new URL('./fixtures/codex-dialogs/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const blocked = (screen: string): boolean => isBlockedScreen(screen, CODEX_BLOCKED, CODEX_WINDOW);

/** Every dialog codex was measured blocking on. */
const DIALOGS = [
  'exec-approval.txt',
  'exec-approval-w36.txt', // the key hint wraps: `Press enter to confirm or esc to` / `cancel`
  'exec-approval-w44.txt',
  'exec-approval-long-command.txt', // a 14-row heredoc preview between the header and the options
  'exec-approval-60x14.txt', // a 14-row pane: codex folds the preview to `[… 21 lines]`
  'edit-approval.txt',
  'network-escalation-approval.txt',
  'question.txt',
  'question-option2-selected.txt',
  'question-1of2.txt', // `| ←/→ to navigate questions |` in the hint
  'question-2of2-submit-all.txt', // `enter to submit all` on the last question
  'question-w36.txt', // the hint one segment per row, the `›` row 16 rows up
  'question-w60.txt',
  'question-notes.txt', // the notes field open: `tab or esc to clear notes | enter to submit answer`
  'question-notes-typed.txt',
  'trust-dialog.txt', // drawn at the TOP of an otherwise blank screen at startup
  'trust-dialog-w40.txt',
  // The same prompt, reached through the update prompt (`2. Skip`) on 0.162.0 with 0.163.0
  // out: `2. Back to Agent Command Center` over `enter continue · esc back`. Captured
  // 2026-10-16 from Codeman's own launch flags in a fresh git repo, at 120 columns.
  'trust-dialog-back.txt',
];

/** Screens with no dialog codex blocks on, several of them quoting the dialogs' words. */
const NOT_DIALOGS = [
  'idle-start.txt',
  'composer-typed.txt',
  'working.txt',
  'after-approve.txt',
  'after-deny.txt',
  'after-question.txt', // the transcript keeps `• Questions 1/1 answered` and the question
  'slash-popup.txt', // `› /plan  switch to Plan mode`: a `›` row with nothing after it
  'transcript-quotes-dialog.txt', // an answer that printed the dialog's lines verbatim
  'composer-typed-dialog-text.txt', // the user TYPED them into the composer
  'composer-typed-dialog-text-w60.txt', // ... and at 60 columns, where the text wraps
  'model-popup.txt', // menus the user opened at the keyboard: `enter select · esc back`
  'permissions-popup.txt', // (with the quoted dialog from the earlier answer still above it)
  'review-popup.txt',
  'implement-plan.txt', // deliberately not blocked: a plan turn that ended, same footer as /model
];

describe('codex blockedLine on live captures', () => {
  it('is a pattern the registry guard accepts, with a window inside the cap', () => {
    expect(DETECT.blockedLine!.length).toBeLessThanOrEqual(200);
    expect(CODEX_BLOCKED).not.toBeNull();
    expect(CODEX_WINDOW).toBeGreaterThan(BLOCKED_TAIL_LINES);
    expect(CODEX_WINDOW).toBeLessThanOrEqual(BLOCKED_MAX_TAIL_LINES);
  });

  it.each(DIALOGS)('reads %s as blocked', (name) => {
    expect(blocked(fixture(name))).toBe(true);
  });

  it.each(NOT_DIALOGS)('does not read %s as blocked', (name) => {
    expect(blocked(fixture(name))).toBe(false);
  });

  it('needs the whole window for the narrowest question, and no more than it declares', () => {
    // At 36 columns the selected option sits 16 non-blank rows above the end; a window
    // that stops short of it reads nothing, which is the pre-field behaviour, never a
    // false alert.
    const narrow = fixture('question-w36.txt');
    expect(isBlockedScreen(narrow, CODEX_BLOCKED, 16)).toBe(true);
    expect(isBlockedScreen(narrow, CODEX_BLOCKED, 15)).toBe(false);
  });

  it('sees the question dialogs that the working line used to claim', () => {
    // Why a blocked screen has to WIN over the working line in the probe: the question's
    // own key hints end in `esc to interrupt`.
    for (const name of ['question.txt', 'question-w36.txt', 'question-1of2.txt']) {
      expect(CODEX_WORKING.test(fixture(name)), name).toBe(true);
      expect(blocked(fixture(name)), name).toBe(true);
    }
  });
});

describe('codex blockedLine against a screen the agent writes', () => {
  // The foot of codex's screen while no dialog is up: composer, footer (whose model and
  // path vary), hint row.
  const composer = (typed = 'Ask Codex to do anything', footer = '  GPT-6-Luna default · ~/cases/x'): string[] => [
    `› ${typed}`,
    '',
    footer,
    '  ? for shortcuts',
  ];
  const forgedDialog = [
    '• Here is what the dialog looks like:',
    '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ];

  it('refuses a forged dialog in the transcript, whatever follows it', () => {
    expect(blocked([...forgedDialog, '', ...composer()].join('\n'))).toBe(false);
    // While a prompt is typed the hint row goes away, so the forged hint sits only two
    // rows above the end: the composer row (column 0, `›`) still breaks the run.
    expect(blocked([...forgedDialog, ...composer('next thing').slice(0, 3)].join('\n'))).toBe(false);
    // Even with a lowercase model and a short path, the footer row would have to end in
    // one of the hint's own closing words.
    expect(blocked([...forgedDialog, ...composer('x', '  gpt-5.6 default · ~/x').slice(0, 3)].join('\n'))).toBe(false);
  });

  it('refuses the working view with the dialog quoted right above the status line', () => {
    const screen = [...forgedDialog, '', '• Working (3s • esc to interrupt)', '', ...composer()].join('\n');
    expect(blocked(screen)).toBe(false);
  });

  it('refuses a hint row without the option row above it, and an option row without the hint', () => {
    expect(
      blocked(
        ['  Would you like to run the following command?', '  Press enter to confirm or esc to cancel'].join('\n')
      )
    ).toBe(false);
    expect(blocked(['› 1. Yes, proceed (y)', '  2. No (esc)'].join('\n'))).toBe(false);
  });

  it('stays linear on a hostile window', () => {
    // Many option rows and long rows, ending in something that is almost the hint: the
    // pattern must give up quickly, since it runs on a timer while a dialog is up.
    const row = `› 1. ${'x'.repeat(300)}`;
    const screen = [
      ...Array(BLOCKED_MAX_TAIL_LINES - 1).fill(row),
      `  Press enter to confirm ${'or '.repeat(60)}`,
    ].join('\n');
    const started = performance.now();
    for (let i = 0; i < 50; i++) blocked(screen);
    expect(performance.now() - started).toBeLessThan(250);
    expect(blocked(screen)).toBe(false);
  });

  it('caps the window at BLOCKED_MAX_TAIL_LINES whatever the caller asks', () => {
    const dialog = fixture('exec-approval.txt');
    const padded = `${dialog}\n${Array(BLOCKED_MAX_TAIL_LINES).fill('  filler').join('\n')}`;
    expect(isBlockedScreen(padded, CODEX_BLOCKED, 10_000)).toBe(false);
  });

  it('answers false for an empty or unreadable capture', () => {
    expect(isBlockedScreen('', CODEX_BLOCKED, CODEX_WINDOW)).toBe(false);
    expect(isBlockedScreen(null, CODEX_BLOCKED, CODEX_WINDOW)).toBe(false);
  });
});

// ─── The session's blocked state ────────────────────────────────────────────

/** Codex's own composer repaint: carries the glyph that arms the idle confirmation. */
const CODEX_REPAINT = '\x1b[31;1H\x1b[38;5;246m›\xa0\x1b[39m\x1b[0m';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _detectInteractiveActivity(data: string): void;
};

function feed(session: Session, data: string): void {
  const internals = session as unknown as SessionInternals;
  internals._handleTerminalOutput(data);
  internals._detectInteractiveActivity(data);
}

/**
 * What the pane shows, and how often the session has read it: every read is a synchronous
 * `tmux capture-pane` on the live server.
 */
type FakeScreen = { text: string | null; captures?: number };

/** A session whose mux answers captures from `screen.text` (null = unreadable). */
function withFakePane(screen: FakeScreen, mode: SessionMode = 'codex'): Session {
  const mux = {
    isAvailable: () => true,
    capturePaneText: () => {
      screen.captures = (screen.captures ?? 0) + 1;
      return screen.text;
    },
  } as unknown as NonNullable<ConstructorParameters<typeof Session>[0]>['mux'];
  return new Session({
    workingDir: '/tmp',
    mode,
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
  } as ConstructorParameters<typeof Session>[0]);
}

/**
 * The pane changes the only way a real one can: tmux redraws it to the attached client,
 * which reaches the session as output. A cursor move and an erase, with no composer glyph
 * in it, so it marks activity without arming the idle confirmation.
 */
function redraw(session: Session, screen: FakeScreen, text: string | null): void {
  screen.text = text;
  feed(session, '\x1b[2;1H\x1b[K');
}

/** Output, then quiet: the moment the idle confirmation reads the screen. */
function settle(session: Session): void {
  for (let i = 0; i < 3; i++) {
    feed(session, CODEX_REPAINT);
    vi.advanceTimersByTime(1000);
  }
  vi.advanceTimersByTime(IDLE_SILENCE_MS + 2000);
}

function recordChanges(session: Session): Array<{ blocked: boolean; frame: string | null }> {
  const changes: Array<{ blocked: boolean; frame: string | null }> = [];
  session.on('blockedChanged', (b: boolean, frame: string | null) => changes.push({ blocked: b, frame }));
  return changes;
}

describe('Session.screenBlocked', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('raises once when the pane settles on an approval, and reads the session idle', () => {
    vi.useFakeTimers();
    const screen = { text: fixture('exec-approval.txt') };
    const session = withFakePane(screen);
    const changes = recordChanges(session);

    settle(session);
    expect(session.screenBlocked).toBe(true);
    expect(session.status).toBe('idle');
    expect(changes).toHaveLength(1);
    expect(changes[0].blocked).toBe(true);
    // The frame it was read from rides along, as the approval card's context.
    expect(changes[0].frame).toContain('Would you like to run the following command?');

    // The dialog staying up is one dialog: no second raise from the timer or a repaint.
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS * 5);
    settle(session);
    expect(changes).toHaveLength(1);
  });

  it('calls a question dialog blocked and idle, not working', () => {
    // Its key hints carry `esc to interrupt`, which is codex's working line: before the
    // field the probe called this pane busy for as long as the question stayed up.
    vi.useFakeTimers();
    const session = withFakePane({ text: fixture('question.txt') });
    settle(session);
    expect(session.screenBlocked).toBe(true);
    expect(session.status).toBe('idle');
  });

  it('clears after the dialog has been gone for BLOCKED_CLEAR_READS reads, without waiting for the turn', () => {
    vi.useFakeTimers();
    const screen = { text: fixture('exec-approval.txt') as string | null };
    const session = withFakePane(screen);
    const changes = recordChanges(session);
    settle(session);
    expect(session.screenBlocked).toBe(true);

    // Answered: codex resumes the turn, and nothing settles while it runs. The timer is
    // what notices, and one read alone is not enough.
    redraw(session, screen, fixture('working.txt'));
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS);
    expect(session.screenBlocked).toBe(true);
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS * (BLOCKED_CLEAR_READS - 1));
    expect(session.screenBlocked).toBe(false);
    expect(changes.map((c) => c.blocked)).toEqual([true, false]);

    // Nothing keeps reading a screen with no dialog on it.
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS * 10);
    expect(changes).toHaveLength(2);
  });

  it('does not flap on one read that misses a dialog still on screen', () => {
    // A capture inside a full-frame repaint can come back without the footer. Clearing on
    // it would raise again a moment later: a second alert, push and webhook for one dialog.
    vi.useFakeTimers();
    const dialog = fixture('exec-approval.txt');
    const screen = { text: dialog as string | null };
    const session = withFakePane(screen);
    const changes = recordChanges(session);
    settle(session);

    redraw(session, screen, fixture('working.txt'));
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS);
    redraw(session, screen, dialog);
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS * 3);
    expect(session.screenBlocked).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it('keeps its state through an unreadable capture, in either direction', () => {
    vi.useFakeTimers();
    const screen = { text: fixture('exec-approval.txt') as string | null };
    const session = withFakePane(screen);
    settle(session);
    // The pane moved, so the session looks, and tmux answers nothing it can read.
    redraw(session, screen, null);
    const before = screen.captures!;
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS * 5);
    expect(screen.captures! - before).toBeGreaterThanOrEqual(5);
    expect(session.screenBlocked).toBe(true);

    // ...and it is still watching: once the screen reads again without the dialog, it clears.
    redraw(session, screen, fixture('after-approve.txt'));
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS * BLOCKED_CLEAR_READS);
    expect(session.screenBlocked).toBe(false);
  });

  it('does not re-read a quiet pane every interval while a dialog sits unanswered', () => {
    // Each read is a synchronous `tmux capture-pane` (about 8 ms of blocked event loop,
    // measured 2026-10-14), and a dialog can sit unanswered overnight. It leaves the
    // screen only through a repaint, which reaches the session as output, so a pane that
    // drew nothing since the last reading that saw the dialog is still showing it.
    vi.useFakeTimers();
    const screen: FakeScreen = { text: fixture('exec-approval.txt') };
    const session = withFakePane(screen);
    settle(session);
    expect(session.screenBlocked).toBe(true);

    const quietMs = 10 * 60_000;
    const before = screen.captures!;
    vi.advanceTimersByTime(quietMs);
    // The safety-net read only, never one per BLOCKED_RECHECK_MS (that would be 300 here).
    expect(screen.captures! - before).toBeLessThanOrEqual(quietMs / BLOCKED_QUIET_RECHECK_MS);
    expect(session.screenBlocked).toBe(true);

    // The answer repaints the pane, and the clear comes as fast as before.
    redraw(session, screen, fixture('after-approve.txt'));
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS * BLOCKED_CLEAR_READS);
    expect(session.screenBlocked).toBe(false);
  });

  it('takes the confirming read even when no output follows the reading that missed the dialog', () => {
    // tmux updates the pane before it sends this client the repaint, so a capture can see
    // the dialog gone while the session has been sent nothing yet. Skipping a quiet pane
    // is right only while the last reading SAW the dialog: once one reading missed it,
    // waiting for output could leave the alert up for the whole safety-net interval.
    vi.useFakeTimers();
    const screen: FakeScreen = { text: fixture('exec-approval.txt') };
    const session = withFakePane(screen);
    settle(session);
    vi.advanceTimersByTime(PANE_PROBE_MIN_INTERVAL_MS);
    screen.text = fixture('after-approve.txt'); // and not one byte of output, from here on
    (session as unknown as { _probePaneWorking(): boolean | null })._probePaneWorking();
    expect(session.screenBlocked).toBe(true);
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS);
    expect(session.screenBlocked).toBe(false);
  });

  it('raises again for the next dialog after a clear', () => {
    vi.useFakeTimers();
    const screen = { text: fixture('exec-approval.txt') as string | null };
    const session = withFakePane(screen);
    const changes = recordChanges(session);
    settle(session);
    redraw(session, screen, fixture('after-approve.txt'));
    vi.advanceTimersByTime(BLOCKED_RECHECK_MS * BLOCKED_CLEAR_READS);
    screen.text = fixture('edit-approval.txt');
    settle(session);
    expect(changes.map((c) => c.blocked)).toEqual([true, false, true]);
  });

  it('never reads a dialog off the screen of a CLI that declares no blockedLine', () => {
    // Claude's dialogs arrive as hooks; gemini declares nothing. Same screen, no state.
    vi.useFakeTimers();
    for (const mode of ['claude', 'gemini'] as const) {
      const session = withFakePane({ text: fixture('exec-approval.txt') }, mode);
      const changes = recordChanges(session);
      settle(session);
      expect(session.screenBlocked, mode).toBe(false);
      expect(changes, mode).toHaveLength(0);
    }
  });

  it('drops the state when a new pane starts, announcing it', () => {
    vi.useFakeTimers();
    const session = withFakePane({ text: fixture('trust-dialog.txt') });
    const changes = recordChanges(session);
    settle(session);
    expect(session.screenBlocked).toBe(true);
    (session as unknown as { _resetBuffers(): void })._resetBuffers();
    expect(session.screenBlocked).toBe(false);
    expect(changes.map((c) => c.blocked)).toEqual([true, false]);
  });
});
