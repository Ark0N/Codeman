/**
 * Working/idle detection for an interactive agent pane, Claude's, Codex's and pi's.
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
 * (`tmux -L codeman capture-pane -p`) on Claude Code 2.1.220, Codex CLI 0.152.1 and pi 1.1.0.
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
function withFakePane(screen: string | (() => string), mode: 'claude' | 'codex' | 'pi' = 'claude'): Session {
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
    // Gemini and OpenCode render their own TUIs, and Codeman knows neither one's glyph,
    // so nothing would arm the idle confirmation and a session marked working here would
    // never recover. A CLI that names no glyph therefore reports no work at all.
    expect(getCli('gemini')?.capabilities.workDetect).toBeUndefined();
    const session = new Session({ workingDir: '/tmp', mode: 'gemini' });
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
    expect(getCli('opencode')?.capabilities.workDetect).toBeUndefined();
    const session = new Session({ workingDir: '/tmp', mode: 'opencode' });
    const events = launch(session);

    feed(session, '\x1b[5;3H⠋ Loading');
    expect(session.isWorking).toBe(true);
    vi.advanceTimersByTime(3000);

    expect(events).toEqual(['working', 'idle', 'needsRefresh']);
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
  });

  it('settles a RESTORED pane of a CLI without work detection, without a refetch', () => {
    vi.useFakeTimers();
    // A Codeman restart re-attaches every surviving pane through startInteractive(),
    // which leaves it busy; opencode and gemini have no glyph that would ever clear that.
    for (const mode of ['opencode', 'gemini', 'shell'] as const) {
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
