/**
 * Working/idle detection for an interactive agent pane, Claude's, Codex's, pi's, opencode's, omp's
 * and Gemini CLI's.
 *
 * The bug this pins: Claude redraws the composer (`❯`) about once a second all
 * the way through a turn, so the old "saw a ❯, wait 2s, call it idle" rule
 * flipped a busy session to idle two seconds into every turn. Measured on a live
 * worker: `GET /api/sessions` reported `idle` for a session that had been
 * running for 17 minutes and was mid-tool-call.
 *
 * A second bug this pins: work detection read Claude's glyph and Claude's status line
 * for every CLI, so a Codex session reported itself idle through an entire turn. Each CLI
 * now names its own pair in `capabilities.workDetect`, and a CLI that names none reports
 * work exactly as before.
 *
 * The status-line fixtures below are verbatim captures from live panes
 * (`tmux -L codeman capture-pane -p`) on Claude Code 2.1.220, Codex CLI 0.152.1, pi 1.1.0,
 * opencode 1.3.0, omp 18.8.6 / 18.0.11 and Gemini CLI 0.63.0 (its turns driven by a local
 * stand-in for the Gemini API, since the CLI's look does not depend on the backend).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { CLAUDE_WORKING_LINE_PATTERN } from '../src/utils/regex-patterns.js';
import { stripAnsi } from '../src/utils/index.js';
import { promptStillInComposer } from '../src/session-submit-verifier.js';
import {
  trackActivityStreak,
  isSustainedActivity,
  isPaneQuiet,
  ACTIVITY_GAP_MS,
  WORKING_STREAK_MS,
  IDLE_SILENCE_MS,
} from '../src/session-activity.js';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _detectInteractiveActivity(data: string): void;
};

/** One PTY chunk: what the pane emitted, exactly as the interactive handler sees it. */
function feed(session: Session, data: string): void {
  const internals = session as unknown as SessionInternals;
  internals._handleTerminalOutput(data);
  internals._detectInteractiveActivity(data);
}

/**
 * A session whose mux reports a fixed (or scripted) screen, so the pane probe has
 * something to read. Only `capturePaneText` is exercised by these paths.
 */
function withFakePane(
  screen: string | (() => string),
  mode: 'claude' | 'codex' | 'pi' | 'opencode' | 'omp' | 'gemini' = 'claude'
): Session {
  const read = typeof screen === 'function' ? screen : () => screen;
  const mux = {
    isAvailable: () => true,
    capturePaneText: () => read(),
  } as unknown as NonNullable<Parameters<typeof Session.prototype.constructor>[0]>['mux'];
  return new Session({
    workingDir: '/tmp',
    mode,
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
  } as ConstructorParameters<typeof Session>[0]);
}

/**
 * Codex's pane, verbatim, while a turn runs and once it has finished. Codex draws `›` on
 * its composer row through the whole turn, exactly as Claude draws `❯`, and prints
 * `esc to interrupt` only while the turn is live.
 */
const CODEX_WORKING =
  'Working (2m 49s • esc to interrupt)\n› Ask Codex to do anything\n' +
  '  gpt-5.6-sol high · Context 59% left · ~/innovi/irisplus-ent-2 · main\n';
const CODEX_FINISHED =
  '─ Worked for 3m 47s ────────────────────\n› Ask Codex to do anything\n' +
  '  gpt-5.6-sol high · Context 57% left · ~/innovi/irisplus-ent-2 · main\n';
/** Codex's own composer repaint, the frame that arms the idle confirmation. */
const CODEX_COMPOSER_REPAINT = '\x1b[31;1H\x1b[38;5;246m›\xa0\x1b[39m\x1b[0m';

/**
 * pi's pane, verbatim from a live pi 1.1.0 capture (rules shortened): no composer glyph,
 * the composer sits between two `─` rules, and a running turn puts a braille spinner and
 * its status into the TOP rule. At rest both rules are plain.
 */
const PI_RULE = '─'.repeat(48);
const PI_FOOTER = '~/codeman-cases/testcase\n0.8%/253k (auto)            qwen3.8-27b-pi • xhigh\n';
const PI_WORKING = ` say ok\n── ⠏ Working ${PI_RULE}\n\n${PI_RULE}\n${PI_FOOTER}`;
const PI_AT_REST = ` Error: Retry failed after 3 attempts: Connection error.\n${PI_RULE}\n\n${PI_RULE}\n${PI_FOOTER}`;
/** One spinner frame on the wire: pi rewrites the whole top rule each time (~80 ms). */
const PI_SPINNER_FRAME = `\x1b[35;1H\x1b(B\x1b[m\x1b[A\x1b[K\x1b[95m── ⠼\x1b[39m \x1b[95mWorking ${PI_RULE}`;
/** The turn's last repaint: the top rule drawn plain again. */
const PI_RULE_REPAINT = `\x1b[35;1H\x1b(B\x1b[m\x1b[A\x1b[K${PI_RULE}`;

/**
 * opencode's pane, verbatim from live opencode 1.3.0 captures (rows shortened). Every
 * composer row starts with a `┃` bar; a running turn puts an 8-cell spinner at the head
 * of the footer row, which is plain key hints at rest.
 */
const OC_RULE = '▀'.repeat(48);
const OC_COMPOSER = `  ┃\n  ┃\n  ┃\n  ┃  Build  qwen3.8-27b Qwen 5090\n  ╹${OC_RULE}\n`;
const OC_WORKING =
  '  ┃\n  ┃  $ sleep 12; echo done\n  ┃\n     ▣  Build · qwen3.8-27b\n' +
  `${OC_COMPOSER}   ■⬝⬝⬝⬝⬝⬝⬝  esc interrupt                 tab agents  ctrl+p commands\n`;
const OC_AT_REST =
  '     It is commonly used to insert deliberate delays between automated tasks.\n\n' +
  `     ▣  Build · qwen3.8-27b · 16.3s\n${OC_COMPOSER}                           tab agents  ctrl+p commands\n`;
/** The 200-column layout at rest: a right-hand sidebar with the todo list and version. */
const OC_AT_REST_WIDE =
  '  ┃  [✓] check disk                                  ▼ Todo\n' +
  '  ┃  [✓] check memory                                [✓] check disk\n' +
  '  ┃  [•] summarize                                   [✓] check memory\n' +
  `     ▣  Build · qwen3.8-27b · 11.9s                   [•] summarize\n${OC_COMPOSER}` +
  '                           tab agents  ctrl+p commands    • OpenCode 1.3.0\n';
/** At 40 columns the footer wraps its own label; the spinner run stays whole. */
const OC_WORKING_PHONE =
  `  ┃  Build  qwen3.8-27b Qwen 5090\n  ╹${'▀'.repeat(35)}\n` +
  '   ⬝⬝⬝⬝⬝⬝⬝⬝  esc   tab     ctrl+p\n             interragents  commands\n             upt\n';
/** A permission prompt replaces the composer, with its own bars, and stops the spinner. */
const OC_PERMISSION =
  '     ▣  Build · qwen3.8-27b\n  ┃\n  ┃  △ Permission required\n' +
  '  ┃    # Echo permission-check to test bash tool\n  ┃\n  ┃  $ echo permission-check\n  ┃\n  ┃\n' +
  '  ┃   Allow once   Allow always   Reject            ctrl+f fullscreen  ⇆ select  enter confirm\n  ┃\n';
/** One spinner frame on the wire (~40 ms apart through a turn), verbatim. */
const OC_SPINNER_FRAME =
  '\x1b[?2026h\x1b[39;4H\x1b[38;2;103;175;249m\x1b[48;2;10;10;10m■\x1b[38;2;92;156;245m■' +
  '\x1b[38;2;33;50;75m⬝⬝⬝⬝⬝⬝\x1b[35;6H\x1b(B\x1b[m\x1b[?2026l';
/** A running tool row: its braille spinner is what used to latch the session busy. */
const OC_TOOL_ROW =
  '\x1b[18;3H\x1b[38;2;10;10;10m┃\x1b[38;2;255;255;255m  \x1b[38;2;128;128;128m⠋\x1b[38;2;255;255;255m ' +
  '\x1b[38;2;128;128;128mSleep for 12 seconds then print done';
/** The composer's agent/model row repainted, verbatim. */
const OC_COMPOSER_REPAINT =
  '\x1b[37;3H\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m┃\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  ' +
  '\x1b[38;2;92;156;245mBuild \x1b[38;2;255;255;255m \x1b[38;2;238;238;238mqwen3.8-27b\x1b[38;2;255;255;255m ' +
  '\x1b[38;2;128;128;128mQwen 5090';
/** The turn's last chunk, verbatim: it blanks the spinner and carries no `┃`. */
const OC_TURN_END =
  '\x1b[?2026h\x1b[32;28H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m · 16.3s\x1b[39;4H\x1b[38;2;255;255;255m        ' +
  '\x1b[2C             \x1b[35;6H\x1b(B\x1b[m\x1b[?2026l';

/**
 * omp's pane, verbatim from live omp 18.8.6 and 18.0.11 captures (rules shortened): the
 * input row is `╰─`, and a running turn swaps the status bar's leading `π` for a braille
 * spinner plus the elapsed time, with a `⎋ Working…` row above it.
 */
const OMP_BAR_TAIL = '⬢ hang > 📁 ~/work ▶─────────5%' + '─'.repeat(40);
const OMP_WORKING = ` say ok\n\n  ⎋ Working…\n ⠼ 14s > ${OMP_BAR_TAIL}\n╰─\n`;
/** 18.0.11 pads the elapsed time with two spaces; past a minute it reads `1m`. */
const OMP_WORKING_OLD = ` say ok\n\n  ⎋ Working…\n ⠼ 2s  > ${OMP_BAR_TAIL}\n╰─\n`;
const OMP_WORKING_LONG = ` ⠧ 1m > ${OMP_BAR_TAIL}\n╰─\n`;
const OMP_AT_REST = ` say ok\n\n π > ${OMP_BAR_TAIL}\n╰─\n`;
/** One spinner frame on the wire: the Working row and the bar, never the input row. */
const OMP_SPINNER_FRAME =
  '\x1b[19;1H\x1b[0m\x1b[K \x1b[38;5;248m ⎋\x1b[39m \x1b[38;5;243mWorki\x1b[39;38;5;248mng\x1b[39;1;38;5;39m…\x1b[22;39m\n' +
  `\x1b[20;1H\x1b[0m\x1b[K\x1b[48;5;233;39m \x1b[38;5;39m⠼ 5s\x1b[39m \x1b[38;5;236m>\x1b[39m ${OMP_BAR_TAIL}`;
/** The input row omp redraws when a turn is submitted and when it ends. */
const OMP_INPUT_REPAINT = '\x1b[20;1H\x1b[0m\x1b[K\x1b[38;5;239m╰─ \x1b[39;38;5;254;39m      \x1b[0m';

/**
 * Gemini CLI's pane, verbatim from live 0.63.0 captures (bars shortened). The composer
 * sits between a `▄` bar and a `▀` bar, and a running turn draws a spinner line above it.
 */
const GEM_COMPOSER =
  `${'─'.repeat(40)}\n YOLO Ctrl+Y\n${'▄'.repeat(40)}\n *   Type your message or @path/to/file\n` +
  `${'▀'.repeat(40)}\n workspace               sandbox\n /tmp/.../gem-turn       no sandbox   …\n`;
const GEM_WORKING =
  '╭──────────────────────────────────╮\n│ ⊶  Shell sleep 8; echo done      │\n' +
  `╰──────────────────────────────────╯\n ⠦ Thinking... (esc to cancel, 6s)\n${GEM_COMPOSER}`;
const GEM_AT_REST =
  '✦ The sleep command pauses the shell for\n  the number of seconds it is given,\n' +
  `  before printing done.\n${GEM_COMPOSER}`;
/**
 * Default approval mode: the confirmation replaces the composer and the spinner stops.
 * The submitted prompt above it is echoed between the composer's own bars.
 */
const GEM_CONFIRM =
  `${'▄'.repeat(40)}\n > Run sleep 8 in the shell, then explain what sleep does.\n${'▀'.repeat(40)}\n` +
  '╭──────────────────────────────────╮\n│ ? Shell  sleep 8; echo done      │\n' +
  '│ Allow execution of [Shell]?      │\n│                                  │\n' +
  '│ ● 1. Allow once                  │\n│   2. Allow for this session      │\n' +
  '│   3. No, suggest changes (esc)   │\n╰──────────────────────────────────╯\n';
/** One spinner frame on the wire (every ~80 ms), verbatim: the line starts with a cursor move. */
const GEM_SPINNER_FRAME =
  '\x1b[9;1H\x1b(B\x1b[m \x1b[38;5;111m⠧\x1b[39m \x1b[38;5;231m\x1b[3mThinking...\x1b(B\x1b[m ' +
  `\x1b[38;5;145m(esc to cancel, 8s)\r\n\x1b[15;1H\x1b[49m\x1b[38;5;59m${'▀'.repeat(40)}`;
/** The turn's last repaint, verbatim (shortened): no spinner line, the composer bars redrawn. */
const GEM_TURN_END =
  `\x1b[?2026h\x1b[11;1H\x1b(B\x1b[m \x1b[38;5;211mYOLO\x1b[38;5;145m Ctrl+Y\x1b[13;1H\x1b[38;5;59m${'▄'.repeat(40)}` +
  '\x1b[14;1H\x1b[39m\x1b[48;5;59m \x1b[38;5;211m* \x1b[39m\x1b[7m \x1b(B\x1b[m\x1b[38;5;145m\x1b[48;5;59m Type your message' +
  ` or @path/to/file\x1b[39m \x1b[15;1H\x1b[49m\x1b[38;5;59m${'▀'.repeat(40)}\x1b[?2026l`;

/** A composer repaint: the frame Claude ships roughly once a second while working. */
const COMPOSER_REPAINT =
  '\x1b[31;1H\x1b[38;5;246m❯\xa0\x1b[39m\x1b[0m\x1b[33;1H  \x1b[38;5;246mOpus 5  in:143,699 out:669  ctx:14%\x1b[39m';

describe('CLAUDE_WORKING_LINE_PATTERN', () => {
  it('matches the live status line, whatever the glyph and gerund are', () => {
    // Captured from three different live panes: the glyph animates through
    // `· ✢ ✳ ∗ ✻ ✽` and the gerund is randomized per turn, so neither is matchable.
    expect(CLAUDE_WORKING_LINE_PATTERN.test('✻ Actualizing… (15m 17s · ↓ 47.5k tokens)')).toBe(true);
    expect(CLAUDE_WORKING_LINE_PATTERN.test('* Implementing the backend… (18m 59s · ↓ 69.9k tokens)')).toBe(true);
    expect(CLAUDE_WORKING_LINE_PATTERN.test('· Finagling… (4m 45s · ↓ 13.3k tokens)')).toBe(true);
    expect(CLAUDE_WORKING_LINE_PATTERN.test('✽ Herding… (3s · esc to interrupt)')).toBe(true);
  });

  it('does not match the FINISHED line, which carries the same glyph', () => {
    // `✻ Cooked for 2m 49s` sits on screen for the whole idle period afterwards.
    // Matching the glyph alone would pin such a session at "working" forever.
    expect(CLAUDE_WORKING_LINE_PATTERN.test('✻ Cooked for 2m 49s')).toBe(false);
    expect(CLAUDE_WORKING_LINE_PATTERN.test('✻ Brewed for 18m 41s')).toBe(false);
    expect(CLAUDE_WORKING_LINE_PATTERN.test('✻ Worked for 2m 46s')).toBe(false);
  });

  it('ignores ordinary prose and the idle footer', () => {
    expect(CLAUDE_WORKING_LINE_PATTERN.test(COMPOSER_REPAINT)).toBe(false);
    expect(CLAUDE_WORKING_LINE_PATTERN.test('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')).toBe(
      false
    );
    expect(CLAUDE_WORKING_LINE_PATTERN.test('the build took 45s to finish')).toBe(false);
  });
});

describe('activity streak helpers', () => {
  it('extends a streak while chunks keep arriving', () => {
    let streak = trackActivityStreak(null, 1000);
    streak = trackActivityStreak(streak, 2000);
    streak = trackActivityStreak(streak, 3000);
    expect(streak).toEqual({ startedAt: 1000, lastAt: 3000 });
  });

  it('restarts the streak after a gap', () => {
    const first = trackActivityStreak(null, 1000);
    const after = trackActivityStreak(first, 1000 + ACTIVITY_GAP_MS + 1);
    expect(after.startedAt).toBe(1000 + ACTIVITY_GAP_MS + 1);
  });

  it('calls it working only once the streak spans the threshold', () => {
    expect(isSustainedActivity(null)).toBe(false);
    expect(isSustainedActivity({ startedAt: 0, lastAt: WORKING_STREAK_MS - 1 })).toBe(false);
    expect(isSustainedActivity({ startedAt: 0, lastAt: WORKING_STREAK_MS })).toBe(true);
  });

  it('measures the streak on its own span, so a stale streak cannot age into working', () => {
    // A single old chunk stays a single chunk no matter how much later we ask.
    const oneChunk = { startedAt: 0, lastAt: 0 };
    expect(isSustainedActivity(oneChunk)).toBe(false);
  });

  it('calls the pane quiet only after the silence window', () => {
    expect(isPaneQuiet(1000, 1000 + IDLE_SILENCE_MS - 1)).toBe(false);
    expect(isPaneQuiet(1000, 1000 + IDLE_SILENCE_MS)).toBe(true);
  });
});

describe('Session interactive idle detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays busy through a long turn of composer repaints', () => {
    vi.useFakeTimers();
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));
    session.on('working', () => events.push('working'));

    // 30 seconds of the once-a-second repaint a working pane emits. Every one of
    // these carries a ❯; the old rule went idle after the first two seconds.
    for (let i = 0; i < 30; i++) {
      feed(session, COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }

    expect(events).toEqual(['working']);
    expect(session.status).toBe('busy');
  });

  it('goes idle once the pane falls silent', () => {
    vi.useFakeTimers();
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));

    for (let i = 0; i < 5; i++) {
      feed(session, COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }
    expect(events).toEqual([]);

    // Turn over: nothing more is emitted.
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 1000);

    expect(events).toEqual(['idle']);
    expect(session.status).toBe('idle');
  });

  it('emits idle once, not once per re-check', () => {
    vi.useFakeTimers();
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));

    for (let i = 0; i < 4; i++) {
      feed(session, COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(60_000);

    expect(events).toEqual(['idle']);
  });

  it('refuses to go idle while the screen still shows the working line', () => {
    vi.useFakeTimers();
    // A turn can go completely silent inside one tool call (measured at 20+
    // seconds on a live worker) while `✻ Elucidating… (39s · ↓ 2.0k tokens)`
    // sits on screen the whole time. Silence alone must not end the turn.
    const session = withFakePane('✻ Elucidating… (39s · ↓ 2.0k tokens)\n❯ \n');
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));

    for (let i = 0; i < 3; i++) {
      feed(session, COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(60_000); // silent for a minute

    expect(events).toEqual([]);
    expect(session.status).toBe('busy');
  });

  it('goes idle once the working line leaves the screen', () => {
    vi.useFakeTimers();
    const pane = { text: '✻ Elucidating… (39s · ↓ 2.0k tokens)\n❯ \n' };
    const session = withFakePane(() => pane.text);
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));

    for (let i = 0; i < 3; i++) {
      feed(session, COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(20_000);
    expect(events).toEqual([]);

    // Turn over: the same glyph remains, on the FINISHED line this time.
    pane.text = '✻ Cooked for 2m 49s\n❯ \n';
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['idle']);
    expect(session.status).toBe('idle');
  });

  it('does not call typing into the composer "working"', () => {
    vi.useFakeTimers();
    // Keystroke echo is a steady stream of repaints too, so the streak alone
    // would call it work. The screen has no working line, which vetoes it.
    const session = withFakePane('❯ some prompt being typed\n');
    const events: string[] = [];
    session.on('working', () => events.push('working'));

    for (let i = 0; i < 10; i++) {
      feed(session, '\x1b[31;3Hx');
      vi.advanceTimersByTime(300);
    }

    expect(events).toEqual([]);
    expect(session.status).toBe('idle');
  });

  it('does not mark an uncharacterised CLI working off raw activity', () => {
    vi.useFakeTimers();
    // Grok renders its own TUI, and Codeman knows no glyph for it, so nothing would arm
    // the idle confirmation and a session marked working here would never recover. A CLI
    // that names no glyph therefore reports no work at all.
    expect(getCli('grok')?.capabilities.workDetect).toBeUndefined();
    const session = new Session({ workingDir: '/tmp', mode: 'grok' });
    const events: string[] = [];
    session.on('working', () => events.push('working'));

    for (let i = 0; i < 10; i++) {
      feed(session, '\x1b[2K▌ Working (12s)');
      vi.advanceTimersByTime(1000);
    }

    expect(events).toEqual([]);
  });

  it('marks a Codex pane working, and lets the turn end', () => {
    vi.useFakeTimers();
    let screen = CODEX_WORKING;
    const session = withFakePane(() => screen, 'codex');
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    for (let i = 0; i < 3; i++) {
      feed(session, CODEX_COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(20_000);

    // The old code reported this session idle for the whole turn.
    expect(events).toEqual(['working']);
    expect(session.status).toBe('busy');

    // Turn over: the working footer gives way to the finished line, which must NOT
    // read as work — it sits on screen for the whole idle period afterwards.
    screen = CODEX_FINISHED;
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['working', 'idle']);
    expect(session.status).toBe('idle');
  });
});

/**
 * The launch settle (`_armPaneSettle` / `_settlePaneStartup`, 3 s after `startInteractive()`
 * started a pane). The bug this pins: it set the status to idle WITHOUT an event, and when
 * the launch paint never marked the pane working, the later idle confirmation found the
 * status already idle and announced nothing either. The browser kept the `busy` the spawn
 * broadcast, so a fresh codex, pi or opencode tile spun "working" for as long as it sat at
 * its composer (measured on the 1.36.0 beta: `lastPromptTime: 0`, never an idle edge).
 * A RESTORED pane of a CLI without work detection never got the settle at all.
 */
describe('external CLI launch settle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type LaunchInternals = { _resetBuffers(): void; _armPaneSettle(isRestored: boolean): void };

  /** Codex at its composer after launch, verbatim from the beta pane that showed the bug. */
  const CODEX_READY =
    '  >_ OpenAI Codex (v0.162.0)\n     ~/codeman-cases/testcase\n› Ask Codex to do anything\n' +
    '  GPT-6-Luna default · ~/codeman-cases/testcase\n  ? for shortcuts\n';

  /** A session as `startInteractive()` leaves it: spawn-time `busy`, settle armed if it applies. */
  function launch(session: Session, isRestored = false): string[] {
    const internals = session as unknown as LaunchInternals;
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));
    session.on('working', () => events.push('working'));
    session.on('needsRefresh', () => events.push('needsRefresh'));
    internals._resetBuffers();
    internals._armPaneSettle(isRestored);
    return events;
  }

  it('announces a codex pane that paints its composer and goes quiet after the timer', () => {
    vi.useFakeTimers();
    const session = withFakePane(CODEX_READY, 'codex');
    const events = launch(session);

    // The composer arms the confirmation, but a second paint keeps the pane
    // from going quiet until after the 3 s timer has fired.
    feed(session, CODEX_COMPOSER_REPAINT);
    vi.advanceTimersByTime(600);
    feed(session, '\x1b[33;3H\x1b[2m? for shortcuts\x1b[0m');
    vi.advanceTimersByTime(60_000);

    expect(events).toEqual(['idle', 'needsRefresh']);
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
  });

  it('announces a codex pane whose launch paint never arms the confirmation', () => {
    vi.useFakeTimers();
    const session = withFakePane(CODEX_READY, 'codex');
    const events = launch(session);

    feed(session, '\x1b[1;3H>_ OpenAI Codex (v0.162.0)');
    vi.advanceTimersByTime(3000);

    expect(events).toEqual(['idle', 'needsRefresh']);
    expect(session.status).toBe('idle');

    // A composer repaint later on (a tile resize) must not announce it twice.
    feed(session, CODEX_COMPOSER_REPAINT);
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual(['idle', 'needsRefresh']);
  });

  it('does not announce twice when the confirmation already concluded before the timer', () => {
    vi.useFakeTimers();
    const session = withFakePane(CODEX_READY, 'codex');
    const events = launch(session);

    feed(session, CODEX_COMPOSER_REPAINT);
    vi.advanceTimersByTime(60_000);

    expect(events).toEqual(['idle', 'needsRefresh']);
    expect(session.status).toBe('idle');
  });

  it('leaves a codex pane that is already working to its own confirmation', () => {
    vi.useFakeTimers();
    let screen = CODEX_WORKING;
    const session = withFakePane(() => screen, 'codex');
    const events = launch(session);

    for (let i = 0; i < 4; i++) {
      feed(session, CODEX_COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(10_000);

    // The timer fired mid-turn and did not call the turn over.
    expect(events).toEqual(['working', 'needsRefresh']);
    expect(session.status).toBe('busy');

    screen = CODEX_FINISHED;
    vi.advanceTimersByTime(20_000);
    expect(events).toEqual(['working', 'needsRefresh', 'idle']);
    expect(session.status).toBe('idle');
  });

  it('settles a CLI without work detection even when a launch spinner latched it working', () => {
    vi.useFakeTimers();
    // Nothing arms an idle confirmation for a CLI that names no composer glyph, so
    // the launch timer is the only thing that can ever settle this pane.
    expect(getCli('grok')?.capabilities.workDetect).toBeUndefined();
    const session = new Session({ workingDir: '/tmp', mode: 'grok' });
    const events = launch(session);

    feed(session, '\x1b[5;3H⠋ Loading');
    expect(session.isWorking).toBe(true);
    vi.advanceTimersByTime(3000);

    expect(events).toEqual(['working', 'idle', 'needsRefresh']);
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
  });

  it('never announces idle for a codex pane prompted before the timer, so a send-and-wait is not ended early', () => {
    vi.useFakeTimers();
    let screen = CODEX_READY;
    const session = withFakePane(() => screen, 'codex');
    const events = launch(session);

    // A prompt 2 s in: its turn has not been marked working when the timer fires.
    vi.advanceTimersByTime(2000);
    session.markPromptSubmitted();
    screen = CODEX_WORKING;
    vi.advanceTimersByTime(1000);

    expect(events).toEqual(['needsRefresh']);
    expect(session.status).toBe('busy');

    for (let i = 0; i < 4; i++) {
      feed(session, CODEX_COMPOSER_REPAINT);
      vi.advanceTimersByTime(1000);
    }
    screen = CODEX_FINISHED;
    vi.advanceTimersByTime(30_000);

    // The turn's own end is the one idle edge.
    expect(events.filter((e) => e === 'idle')).toEqual(['idle']);
    expect(events[events.length - 1]).toBe('idle');
    expect(session.status).toBe('idle');
  });

  it('still settles a prompted CLI without work detection, which has nothing else to settle it', () => {
    vi.useFakeTimers();
    const session = new Session({ workingDir: '/tmp', mode: 'grok' });
    const events = launch(session);

    vi.advanceTimersByTime(2000);
    session.markPromptSubmitted();
    vi.advanceTimersByTime(1000);

    expect(events).toEqual(['idle', 'needsRefresh']);
  });

  it('settles a RESTORED pane of a CLI without work detection, without a refetch', () => {
    vi.useFakeTimers();
    // A Codeman restart re-attaches every surviving pane through startInteractive(),
    // which leaves it busy; grok and deepseek have no glyph that would ever clear that.
    for (const mode of ['grok', 'deepseek', 'shell'] as const) {
      expect(getCli(mode)?.capabilities.workDetect).toBeUndefined();
      const session = new Session({ workingDir: '/tmp', mode });
      const events = launch(session, true);
      expect(session.status).toBe('busy');

      vi.advanceTimersByTime(3000);

      expect(events).toEqual(['idle']);
      expect(session.status).toBe('idle');
    }
  });

  it('leaves a RESTORED claude or codex pane to its own glyph, so a restart mid-turn is not called idle', () => {
    vi.useFakeTimers();
    for (const mode of ['claude', 'codex'] as const) {
      const session = new Session({ workingDir: '/tmp', mode });
      const events = launch(session, true);

      vi.advanceTimersByTime(3000);

      expect(events).toEqual([]);
      expect(session.status).toBe('busy');
    }
  });

  it('arms nothing for a NEW claude pane, which waits for its ❯ instead', () => {
    vi.useFakeTimers();
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const events = launch(session);

    vi.advanceTimersByTime(3000);

    expect(events).toEqual([]);
  });

  it('does nothing for a session stopped before the timer', () => {
    vi.useFakeTimers();
    const session = withFakePane(CODEX_READY, 'codex');
    const events = launch(session);
    (session as unknown as { _isStopped: boolean })._isStopped = true;

    vi.advanceTimersByTime(3000);

    expect(events).toEqual([]);
  });
});

describe("codex's work-detection descriptor", () => {
  const codex = getCli('codex')?.capabilities.workDetect;

  it('matches the footer Codex prints while a turn runs', () => {
    expect(new RegExp(codex!.workingLine).test(CODEX_WORKING)).toBe(true);
  });

  it('does not match the finished line, nor the idle footer', () => {
    expect(new RegExp(codex!.workingLine).test(CODEX_FINISHED)).toBe(false);
  });

  it('matches the footer case-insensitively on the E', () => {
    // Characterised on codex-cli 0.152.1, which prints a lowercase `esc`. A future
    // version capitalising it would otherwise make the whole fix silently inert:
    // the pane would simply never look like it was working.
    expect(new RegExp(codex!.workingLine).test(CODEX_WORKING.replace('esc to interrupt', 'Esc to interrupt'))).toBe(
      true
    );
  });

  it('names the glyph Codex actually draws on its composer row', () => {
    expect(CODEX_COMPOSER_REPAINT).toContain(codex!.promptGlyph);
    expect(CODEX_WORKING).toContain(codex!.promptGlyph);
  });
});

describe("pi's work-detection descriptor", () => {
  const pi = getCli('pi')?.capabilities.workDetect;

  it('matches the spinner pi embeds in its composer rule while a turn runs', () => {
    expect(new RegExp(pi!.workingLine).test(PI_WORKING)).toBe(true);
    // The stream detector reads the ANSI-stripped chunk.
    expect(new RegExp(pi!.workingLine).test(stripAnsi(PI_SPINNER_FRAME))).toBe(true);
  });

  it('does not match the plain rules of a pane at rest', () => {
    expect(new RegExp(pi!.workingLine).test(PI_AT_REST)).toBe(false);
  });

  it('names a glyph every pi repaint carries, so the idle check can arm', () => {
    expect(PI_SPINNER_FRAME).toContain(pi!.promptGlyph);
    expect(PI_RULE_REPAINT).toContain(pi!.promptGlyph);
  });

  it('leaves the submit verifier unable to press Enter on a pi pane', () => {
    // The verifier reads the last row starting with the glyph, which for pi is a bare
    // rule with no prompt text in it: it must stand down, never report "unsubmitted".
    expect(promptStillInComposer(PI_AT_REST, 'say ok', pi!.promptGlyph)).toBe(false);
    expect(promptStillInComposer(PI_WORKING, 'say ok', pi!.promptGlyph)).toBe(false);
  });
});

describe('pi interactive idle detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks a pi turn working, and lets it end', () => {
    vi.useFakeTimers();
    let screen = PI_WORKING;
    const session = withFakePane(() => screen, 'pi');
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    // Eight seconds of spinner frames: every one carries the rule glyph, which must
    // not end the turn while the pane is still animating.
    for (let i = 0; i < 80; i++) {
      feed(session, PI_SPINNER_FRAME);
      vi.advanceTimersByTime(100);
    }
    expect(events).toEqual(['working']);
    expect(session.status).toBe('busy');

    // Turn over. Before pi declared its rule and spinner, nothing ever armed the idle
    // check (pi never draws `❯`), so the session stayed busy for good.
    screen = PI_AT_REST;
    feed(session, PI_RULE_REPAINT);
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['working', 'idle']);
    expect(session.status).toBe('idle');
  });

  it('settles a reattached pi pane that is at rest', () => {
    vi.useFakeTimers();
    // A restored pane starts in the `busy` that startInteractive() sets and gets no
    // launch timer; the reattach repaint is what has to bring it to idle.
    const session = withFakePane(PI_AT_REST, 'pi');
    (session as unknown as { _status: string })._status = 'busy';
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));

    feed(session, PI_RULE_REPAINT);
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['idle']);
    expect(session.status).toBe('idle');
  });
});

describe("opencode's work-detection descriptor", () => {
  const oc = getCli('opencode')?.capabilities.workDetect;

  it('matches the spinner at the head of the footer while a turn runs, at any width', () => {
    expect(new RegExp(oc!.workingLine).test(OC_WORKING)).toBe(true);
    // Below ~45 columns the footer wraps `esc interrupt`, which is why the label is not the anchor.
    expect(new RegExp(oc!.workingLine).test(OC_WORKING_PHONE)).toBe(true);
    // The stream detector reads the ANSI-stripped chunk.
    expect(new RegExp(oc!.workingLine).test(stripAnsi(OC_SPINNER_FRAME))).toBe(true);
  });

  it('does not match a pane at rest, the wide sidebar layout or a pending permission prompt', () => {
    expect(new RegExp(oc!.workingLine).test(OC_AT_REST)).toBe(false);
    expect(new RegExp(oc!.workingLine).test(OC_AT_REST_WIDE)).toBe(false);
    expect(new RegExp(oc!.workingLine).test(OC_PERMISSION)).toBe(false);
  });

  it('names the bar the composer, the transcript and a running tool row are drawn with', () => {
    expect(OC_COMPOSER_REPAINT).toContain(oc!.promptGlyph);
    expect(OC_TOOL_ROW).toContain(oc!.promptGlyph);
    expect(OC_AT_REST).toContain(oc!.promptGlyph);
  });

  it('leaves the submit verifier unable to press Enter on an opencode pane', () => {
    // The last `┃` row is the composer's agent/model row, or the permission box's closing
    // bar: never the prompt text, so the verifier stands down rather than re-pressing Enter.
    const typed = OC_COMPOSER.replace('  ┃\n  ┃\n', '  ┃\n  ┃  say ok\n');
    expect(promptStillInComposer(typed, 'say ok', oc!.promptGlyph)).toBe(false);
    expect(promptStillInComposer(OC_AT_REST, 'say ok', oc!.promptGlyph)).toBe(false);
    expect(promptStillInComposer(OC_WORKING, 'sleep 12', oc!.promptGlyph)).toBe(false);
    expect(promptStillInComposer(OC_PERMISSION, 'Echo permission-check', oc!.promptGlyph)).toBe(false);
  });
});

describe('opencode interactive idle detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A turn's worth of spinner frames, 40 ms apart, as opencode ships them. */
  function spin(session: Session, ms: number): void {
    for (let t = 0; t < ms; t += 40) {
      feed(session, OC_SPINNER_FRAME);
      vi.advanceTimersByTime(40);
    }
  }

  it('lets a turn that ran a tool end, instead of latching busy', () => {
    vi.useFakeTimers();
    let screen = OC_WORKING;
    const session = withFakePane(() => screen, 'opencode');
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    // The tool row's braille marks the pane working; its bar arms the idle check, which
    // must not end the turn while the spinner still animates.
    feed(session, OC_TOOL_ROW);
    spin(session, 8000);
    expect(events).toEqual(['working']);
    expect(session.status).toBe('busy');

    // Before opencode declared its bar and spinner, nothing ever armed the idle check
    // (opencode never draws `❯`), so this session stayed busy for good.
    screen = OC_AT_REST;
    feed(session, OC_TURN_END);
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['working', 'idle']);
    expect(session.status).toBe('idle');
  });

  it('marks a text-only turn working off the spinner, with no braille anywhere', () => {
    vi.useFakeTimers();
    let screen = OC_WORKING;
    const session = withFakePane(() => screen, 'opencode');
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    feed(session, OC_COMPOSER_REPAINT);
    spin(session, 4000);
    expect(events).toEqual(['working']);

    screen = OC_AT_REST;
    feed(session, OC_TURN_END);
    vi.advanceTimersByTime(20_000);
    expect(events).toEqual(['working', 'idle']);
  });

  it('reads a pending permission prompt as idle, and ends the resumed turn too', () => {
    vi.useFakeTimers();
    let screen = OC_WORKING;
    const session = withFakePane(() => screen, 'opencode');
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    feed(session, OC_TOOL_ROW);
    spin(session, 3000);

    // The prompt replaces the composer and the pane goes silent: waiting on the user.
    screen = OC_PERMISSION;
    feed(session, '\x1b[30;3H\x1b[38;2;250;178;131m┃\x1b[38;2;255;255;255m  △ Permission required');
    vi.advanceTimersByTime(10_000);
    expect(events).toEqual(['working', 'idle']);
    expect(session.status).toBe('idle');

    // Allowed: the composer comes back (its bar re-arms the check) and the spinner resumes.
    screen = OC_WORKING;
    feed(session, OC_COMPOSER_REPAINT);
    spin(session, 4000);
    expect(events).toEqual(['working', 'idle', 'working']);

    screen = OC_AT_REST;
    feed(session, OC_TURN_END);
    vi.advanceTimersByTime(20_000);
    expect(events).toEqual(['working', 'idle', 'working', 'idle']);
    expect(session.status).toBe('idle');
  });

  it('settles a reattached opencode pane that is at rest', () => {
    vi.useFakeTimers();
    // A restored pane starts in the `busy` that startInteractive() sets and, now that
    // opencode declares work detection, gets no launch timer: tmux's reattach repaint
    // carries the composer's bar, and that is what has to bring it to idle.
    const session = withFakePane(OC_AT_REST, 'opencode');
    (session as unknown as { _status: string })._status = 'busy';
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));

    feed(session, OC_COMPOSER_REPAINT);
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['idle']);
    expect(session.status).toBe('idle');
  });
});

describe("gemini's work-detection descriptor", () => {
  const gem = getCli('gemini')?.capabilities.workDetect;
  const working = () => new RegExp(gem!.workingLine);

  it('matches the spinner line while a turn runs, on screen and on the wire', () => {
    expect(working().test(GEM_WORKING)).toBe(true);
    // The stream detector reads the ANSI-stripped chunk, where a cursor move, not a
    // newline, opens the spinner line: the `(esc to cancel` half is what matches there.
    expect(working().test(stripAnsi(GEM_SPINNER_FRAME))).toBe(true);
    // A long loading phrase can push the suffix onto the next line on a narrow pane
    // (constructed, not captured): the spinner frame opening its line still matches.
    expect(working().test(' ⠦ Reticulating the splines for your\n  request... (esc to cancel,\n')).toBe(true);
  });

  it('does not match a pane at rest, nor a pending tool confirmation', () => {
    expect(working().test(GEM_AT_REST)).toBe(false);
    expect(working().test(GEM_CONFIRM)).toBe(false);
  });

  it('names the composer bar every repaint carries, so the idle check can arm', () => {
    expect(GEM_SPINNER_FRAME).toContain(gem!.promptGlyph);
    expect(GEM_TURN_END).toContain(gem!.promptGlyph);
    expect(GEM_AT_REST).toContain(gem!.promptGlyph);
  });

  it('leaves the submit verifier unable to press Enter on a gemini pane', () => {
    // The last row starting with `▀` is a bar, never prompt text, even when the echoed
    // prompt sits just above it while a confirmation waits.
    const typed = GEM_COMPOSER.replace('Type your message or @path/to/file', 'say ok');
    expect(promptStillInComposer(typed, 'say ok', gem!.promptGlyph)).toBe(false);
    expect(promptStillInComposer(GEM_AT_REST, 'say ok', gem!.promptGlyph)).toBe(false);
    expect(promptStillInComposer(GEM_CONFIRM, 'Run sleep 8 in the shell', gem!.promptGlyph)).toBe(false);
  });
});

describe('gemini interactive idle detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function spin(session: Session, ms: number): void {
    for (let t = 0; t < ms; t += 80) {
      feed(session, GEM_SPINNER_FRAME);
      vi.advanceTimersByTime(80);
    }
  }

  it('lets a turn end, instead of latching busy', () => {
    vi.useFakeTimers();
    let screen = GEM_WORKING;
    const session = withFakePane(() => screen, 'gemini');
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    spin(session, 8000);
    expect(events).toEqual(['working']);
    expect(session.status).toBe('busy');

    // Before gemini declared its bar and spinner line, nothing ever armed the idle check
    // (gemini never draws `❯`), so this session stayed busy for good.
    screen = GEM_AT_REST;
    feed(session, GEM_TURN_END);
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['working', 'idle']);
    expect(session.status).toBe('idle');
  });

  it('reads a pending tool confirmation as idle, and ends the resumed turn too', () => {
    vi.useFakeTimers();
    let screen = GEM_WORKING;
    const session = withFakePane(() => screen, 'gemini');
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    spin(session, 3000);

    // The confirmation replaces the composer and the pane goes silent: waiting on the user.
    screen = GEM_CONFIRM;
    feed(session, `\x1b[5;1H${'▀'.repeat(40)}\x1b[7;1H│ Allow execution of [Shell]?`);
    vi.advanceTimersByTime(10_000);
    expect(events).toEqual(['working', 'idle']);

    // Allowed: the spinner line returns with every repaint carrying the bar.
    screen = GEM_WORKING;
    spin(session, 4000);
    expect(events).toEqual(['working', 'idle', 'working']);

    screen = GEM_AT_REST;
    feed(session, GEM_TURN_END);
    vi.advanceTimersByTime(20_000);
    expect(events).toEqual(['working', 'idle', 'working', 'idle']);
    expect(session.status).toBe('idle');
  });

  it('settles a reattached gemini pane that is at rest', () => {
    vi.useFakeTimers();
    const session = withFakePane(GEM_AT_REST, 'gemini');
    (session as unknown as { _status: string })._status = 'busy';
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));

    feed(session, GEM_TURN_END);
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['idle']);
    expect(session.status).toBe('idle');
  });
});

describe('wire activity stamp across recovery', () => {
  // The stamp both home screens sort the quiet group on. Recovery restores the
  // previous run's value, and the settle window keeps the boot attach repaint
  // (ordinary PTY output, arriving within seconds of construction) from
  // restamping every session "now": measured live, a restart left 17 of 17
  // sessions with an identical lastActivityAt, which flattens the ordering to
  // tab order after every deploy.
  const OLD = 1_700_000_000_000;
  const restored = () =>
    new Session({ workingDir: '/tmp', mode: 'claude', lastActivityAt: OLD } as ConstructorParameters<
      typeof Session
    >[0]);

  it('restores the previous-run stamp and holds it through attach-repaint output', () => {
    const session = restored();
    expect(session.lastActivityAt).toBe(OLD);
    (session as unknown as SessionInternals)._handleTerminalOutput('attach repaint bytes');
    expect(session.lastActivityAt).toBe(OLD);
    expect(session.toState().lastActivityAt).toBe(OLD);
  });

  it('a real action writes through the settle window', () => {
    const session = restored();
    session.assignTask('t1');
    expect(session.lastActivityAt).toBeGreaterThan(OLD);
  });

  it('output after the window moves the stamp normally', () => {
    const session = restored();
    (session as unknown as { _wireActivitySettleUntil: number })._wireActivitySettleUntil = Date.now() - 1;
    (session as unknown as SessionInternals)._handleTerminalOutput('real output');
    expect(session.lastActivityAt).toBeGreaterThan(OLD);
  });

  it('a fresh session has no window: first output stamps immediately', () => {
    const before = Date.now();
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    (session as unknown as SessionInternals)._handleTerminalOutput('x');
    expect(session.lastActivityAt).toBeGreaterThanOrEqual(before);
  });
});

describe("omp's work-detection descriptor", () => {
  const omp = getCli('omp')?.capabilities.workDetect;

  it('matches the status bar and Working row omp draws while a turn runs', () => {
    const re = new RegExp(omp!.workingLine);
    expect(re.test(OMP_WORKING)).toBe(true);
    expect(re.test(OMP_WORKING_OLD)).toBe(true);
    expect(re.test(OMP_WORKING_LONG)).toBe(true);
    // The stream detector reads the ANSI-stripped chunk.
    expect(re.test(stripAnsi(OMP_SPINNER_FRAME))).toBe(true);
  });

  it('does not match a pane at rest', () => {
    expect(new RegExp(omp!.workingLine).test(OMP_AT_REST)).toBe(false);
  });

  it('names the input row omp redraws, so the idle check can arm', () => {
    expect(OMP_INPUT_REPAINT).toContain(omp!.promptGlyph);
  });

  it('lets the submit verifier tell a submitted prompt from a stranded one', () => {
    // Submitted (or queued for steering mid-turn): the input row is empty again.
    expect(promptStillInComposer(OMP_AT_REST, 'say ok', omp!.promptGlyph)).toBe(false);
    // Still sitting in the input row: the one case where pressing Enter again is right.
    expect(promptStillInComposer(OMP_AT_REST.replace('╰─\n', '╰─ say ok\n'), 'say ok', omp!.promptGlyph)).toBe(true);
  });
});

describe('omp interactive idle detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks an omp turn working, and lets it end', () => {
    vi.useFakeTimers();
    let screen = OMP_WORKING;
    const session = withFakePane(() => screen, 'omp');
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    // The submit redraws the input row, then eight seconds of spinner frames.
    feed(session, OMP_INPUT_REPAINT);
    for (let i = 0; i < 80; i++) {
      feed(session, OMP_SPINNER_FRAME);
      vi.advanceTimersByTime(100);
    }
    expect(events).toEqual(['working']);
    expect(session.status).toBe('busy');

    // Turn over: omp redraws the input row with the bar back to `π`.
    screen = OMP_AT_REST;
    feed(session, OMP_INPUT_REPAINT);
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['working', 'idle']);
    expect(session.status).toBe('idle');
  });

  it('settles a reattached omp pane that is at rest', () => {
    vi.useFakeTimers();
    const session = withFakePane(OMP_AT_REST, 'omp');
    (session as unknown as { _status: string })._status = 'busy';
    const events: string[] = [];
    session.on('idle', () => events.push('idle'));

    feed(session, OMP_INPUT_REPAINT);
    vi.advanceTimersByTime(20_000);

    expect(events).toEqual(['idle']);
    expect(session.status).toBe('idle');
  });
});
