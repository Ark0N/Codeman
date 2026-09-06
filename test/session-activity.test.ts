/**
 * Working/idle detection for an interactive agent pane, Claude's and Codex's.
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
 * (`tmux -L codeman capture-pane -p`) on Claude Code 2.1.220 and Codex CLI 0.152.1.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { CLAUDE_WORKING_LINE_PATTERN } from '../src/utils/regex-patterns.js';
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
function withFakePane(screen: string | (() => string), mode: 'claude' | 'codex' = 'claude'): Session {
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

describe("codex's work-detection descriptor", () => {
  const codex = getCli('codex')?.capabilities.workDetect;

  it('matches the footer Codex prints while a turn runs', () => {
    expect(new RegExp(codex!.workingLine).test(CODEX_WORKING)).toBe(true);
  });

  it('does not match the finished line, nor the idle footer', () => {
    expect(new RegExp(codex!.workingLine).test(CODEX_FINISHED)).toBe(false);
  });

  it('names the glyph Codex actually draws on its composer row', () => {
    expect(CODEX_COMPOSER_REPAINT).toContain(codex!.promptGlyph);
    expect(CODEX_WORKING).toContain(codex!.promptGlyph);
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
