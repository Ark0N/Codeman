/**
 * @fileoverview Pure working/idle heuristics for a Claude interactive pane.
 *
 * Split out of `session.ts` so the thresholds and the state math are unit
 * testable without a PTY (same reasoning as `session-order.ts` /
 * `usage-limit-patterns.ts`).
 *
 * **Why activity and not the status line.** Claude Code's working indicator is
 * `✻ Actualizing… (13m 23s · ↓ 47.5k tokens)`, where the glyph animates through
 * `· ✢ ✳ ∗ ✻ ✽` and the gerund is randomized per turn. Neither the braille
 * spinner (`SPINNER_PATTERN`) nor the old keyword list (`Thinking|Writing|
 * Reading|Running`) matches any of that, so the pane looked idle for a whole
 * turn. Matching the new line does not rescue the stream either: tmux ships
 * PARTIAL repaints, so measured on a live worker the complete line reached the
 * PTY roughly once every 20 seconds, while the composer's `❯` (which is what
 * ARMS idle detection) arrived every single second.
 *
 * What is left is the one thing measured to separate the two states cleanly: a
 * working pane repaints, an idle pane emits nothing at all. Sampled once per
 * second for 12s across six live sessions, the two working ones produced output
 * in 12/12 windows and the four idle ones in 0/12.
 */

import { stripAnsi } from './utils/regex-patterns.js';

/**
 * A gap longer than this ends a run of continuous output. Claude repaints at
 * least once a second while working, so this leaves generous headroom.
 */
export const ACTIVITY_GAP_MS = 2000;

/**
 * Continuous output for this long means the pane is working. Long enough that a
 * one-off repaint (an update-check line, a rotating tip) cannot reach it.
 */
export const WORKING_STREAK_MS = 2000;

/**
 * Silence for this long is what confirms the pane really went idle. Must stay
 * above ACTIVITY_GAP_MS, or a pause between two repaints of one turn would
 * read as the end of the turn.
 */
export const IDLE_SILENCE_MS = 2500;

/** How often a pending idle confirmation re-checks a pane that is still noisy. */
export const IDLE_RECHECK_MS = 500;

/**
 * Floor between two pane probes for one session. The probe shells out to tmux,
 * so this is what keeps a screenful of busy sessions from turning idle detection
 * into a subprocess storm.
 */
export const PANE_PROBE_MIN_INTERVAL_MS = 1500;

/**
 * How long to wait before looking again at a pane the probe just called working.
 * Claude can sit silent for tens of seconds inside one tool call, so this is the
 * cadence that carries a long quiet turn, so it is deliberately slow.
 */
export const PANE_PROBE_RECHECK_MS = 5000;

/** An unbroken run of PTY output. */
export interface ActivityStreak {
  /** When this run began. */
  startedAt: number;
  /** The most recent chunk in it. */
  lastAt: number;
}

/**
 * Fold one output chunk into the current streak, starting a new one when the
 * pane has been quiet longer than `gapMs`.
 */
export function trackActivityStreak(
  streak: ActivityStreak | null,
  now: number,
  gapMs: number = ACTIVITY_GAP_MS
): ActivityStreak {
  if (!streak || now - streak.lastAt > gapMs) return { startedAt: now, lastAt: now };
  return { startedAt: streak.startedAt, lastAt: now };
}

/**
 * True once a streak has been running long enough to mean work rather than a
 * single repaint. Measured on the streak's own span (`lastAt - startedAt`), not
 * against the caller's clock, so a stale streak cannot age into a true.
 */
export function isSustainedActivity(streak: ActivityStreak | null, streakMs: number = WORKING_STREAK_MS): boolean {
  return !!streak && streak.lastAt - streak.startedAt >= streakMs;
}

/** True when the pane has produced nothing for long enough to call it idle. */
export function isPaneQuiet(lastActivityAt: number, now: number, silenceMs: number = IDLE_SILENCE_MS): boolean {
  return now - lastActivityAt >= silenceMs;
}

/**
 * How many rows at the foot of a pane capture may hold the background-work row, for a
 * CLI that declares no number of its own (`capabilities.workDetect.watchingLines`).
 *
 * One, because the tightest window is the right default and Claude Code needs no more:
 * it draws its chip on the LAST row of the screen. Blank rows are dropped before the
 * window is taken, so a trailing blank costs nothing, and a CLI that ever prints a row
 * BELOW its chip loses the badge rather than gaining a hole.
 *
 * ⚠️ The size of this window is a trust boundary, not a tidiness measure, and the row
 * it excludes first is the one that taught us so: Claude's status line sits directly
 * above the footer, its content comes from a `statusLine` command, and a session running
 * with permissions bypassed can write that command into `.claude/settings.json` in its
 * own workspace. A window of two therefore let an agent print `· 1 monitor ·` onto a row
 * of its own and silence its own idle alert. Every row added here is another row
 * somebody may be able to write, so widen this only for a CLI whose layout forces it,
 * and never to a whole-pane search.
 */
export const WATCHING_TAIL_LINES = 1;

/** Longest label a badge will carry. A footer chip is a handful of words. */
export const MAX_WATCHING_LABEL_CHARS = 40;

/**
 * What a pane says is still running in the background, e.g. `1 monitor` or `2 shells`.
 *
 * The CLI writes that chip while a monitor, a backgrounded shell or a cloud session it
 * started is still going, which is exactly the case where the agent has ended its turn
 * without wanting anything from the user. `pattern` comes from the CLI's own registry
 * entry (`capabilities.workDetect.watchingLine`); group 1 is the label when the pattern
 * declares one, and the whole match stands in when it does not.
 *
 * Each candidate row is tested on its own, bottom row first, so a pattern can anchor
 * itself with `^` or `$` against a single row rather than against a joined block. Blank
 * rows are dropped before the window is taken, because a CLI that leaves a blank line
 * between its chrome rows would otherwise spend the window on nothing. The answer is
 * stripped of ANSI and capped, because it ends up on a badge and in an approval card.
 *
 * @param tailLines how many non-blank rows from the bottom to look at, defaulting to
 *   `WATCHING_TAIL_LINES`; a CLI declares its own when its row is not the last one
 * @returns the label, or null when the pane shows no background work
 */
export function watchingLabel(
  paneText: string | null | undefined,
  pattern: RegExp,
  tailLines: number = WATCHING_TAIL_LINES
): string | null {
  if (!paneText) return null;
  const lines = stripAnsi(paneText)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  for (const line of lines.slice(-Math.max(1, tailLines)).reverse()) {
    // A pattern compiled by compileVersionRegex() never carries the `g` flag, but a
    // caller reaching in from a test or a config reload might, and a stale lastIndex
    // would make the same screen match every other call.
    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    if (!match) continue;
    const label = (match[1] ?? match[0]).trim().slice(0, MAX_WATCHING_LABEL_CHARS);
    if (label) return label;
  }
  return null;
}

/**
 * How many rows above the composer the turn's closing row may sit. Between the two Claude
 * draws only its composer border and, sometimes, a right-aligned hint
 * (`new task? /clear to save 169.1k tokens`), so this leaves room for a blank row or two
 * and no more. A bound, not a tuning knob: the walk must never reach far enough up the
 * transcript to find an old turn's row.
 */
export const AWAITING_SEARCH_ROWS = 6;

/** A row that opens with a box-drawing character is the composer's frame, not transcript. */
const COMPOSER_FRAME_ROW = /^[─-╿]/;

/**
 * Whether the pane's newest turn ended by handing off to workers the CLI will wait for,
 * e.g. Claude's `✻ Waiting for 1 dynamic workflow to finish`.
 *
 * Such a pane is quiet and shows its composer, so every other signal calls it idle, yet
 * nothing is being asked of the user: the CLI resumes by itself when the workers report
 * back. That is why a session in this state counts as working.
 *
 * ⚠️ The row is a snapshot. Claude renders it once, at the end of the turn, and never
 * updates it, so after the workers finish the same words are still on screen above the
 * follow-up turn. Matching them anywhere on the pane would pin the session busy for as
 * long as they stay visible. Only the newest transcript row counts: the walk starts at
 * the composer (the LAST row carrying `promptGlyph`), steps up past blank rows, the
 * composer's frame and anything indented (a right-aligned hint, a wrapped continuation),
 * and tests the first row that starts in column 0. A follow-up turn always puts rows of
 * its own there, so the stale copy is never the one tested.
 *
 * @param promptGlyph the CLI's composer glyph (`capabilities.workDetect.promptGlyph`)
 * @returns false when the screen shows no composer, which is no evidence either way
 */
export function isAwaitingWorkers(paneText: string | null | undefined, pattern: RegExp, promptGlyph: string): boolean {
  if (!paneText) return false;
  const rows = stripAnsi(paneText)
    .split('\n')
    .map((row) => row.trimEnd());
  let composer = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    // Claude has drawn its composer both bare (`❯ …` between rules) and boxed (`│ ❯ … │`).
    if (rows[i].replace(/^[\s│]+/, '').startsWith(promptGlyph)) {
      composer = i;
      break;
    }
  }
  if (composer < 0) return false;
  for (let i = composer - 1; i >= Math.max(0, composer - AWAITING_SEARCH_ROWS); i--) {
    const row = rows[i];
    if (row === '' || /^\s/.test(row) || COMPOSER_FRAME_ROW.test(row)) continue;
    // Same reasoning as watchingLabel(): a caller's `g` flag must not make this flap.
    pattern.lastIndex = 0;
    return pattern.test(row);
  }
  return false;
}
