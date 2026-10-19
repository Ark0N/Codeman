/**
 * @fileoverview Verify that a programmatically sent prompt actually LEFT the composer,
 * and press Enter again while it has not.
 *
 * Claude Code 2.1.277 (auto-installed 2026-09-18) takes typed text the moment its
 * composer paints but ignores Enter for the first 30 to 50 seconds after it, so the
 * text + `send-keys Enter` pair `TmuxManager.sendInput()` sends 50 ms
 * apart leaves the prompt sitting on the composer with `0 tokens`, and every caller
 * that then waits for the turn (send-and-wait, the agent skill, the maintainer bot,
 * cron, Ralph) burns its whole timeout on a turn that never started. Measured through
 * the input route on 2026-09-19: an Enter at 28 s stranded, one at 51 s submitted.
 *
 * The rule: after a write that carried a carriage return, read the pane on a short
 * schedule; while the LAST composer line (the CLI's own prompt glyph) still holds the
 * head of what was sent, send Enter again. An empty composer ends it, and so does a
 * composer holding anything else, because that text is the user's or the CLI's, never
 * ours. A pane with no composer line at all (a shell, a CLI whose glyph is not
 * declared, a direct-PTY session with no pane to read) does nothing: this runs for
 * EVERY programmatic sender, so a blind Enter here could confirm a dialog nobody asked
 * about. The composer is the last glyph line on purpose: Claude Code echoes a submitted
 * prompt with the same glyph higher up in the transcript, so only the last one says
 * whether the text was taken.
 *
 * The browser's composers (Story Mode's prompt bar, the phone's Compose sheet) never send
 * a `text\r` pair: they write one bracketed paste and a bare Enter about 120 ms later,
 * because Codex drops a key that shares a read with a paste. `PastedPromptWatch` pairs
 * those two writes back up so the same check covers them. A long paste is not on the
 * composer as text at all (Claude Code draws `[Pasted text #1 +3 lines]`), so that
 * stand-in counts as the prompt only when its line count is the prompt's own.
 *
 * Pure apart from the injected capture, send and log, so the schedule, the cap and
 * every stop condition are unit-tested with fake timers (test/session-submit-verifier.test.ts).
 */
import { stripAnsi } from './utils/index.js';

/**
 * When to look, counted from the write: 2 s catches the common case (taken) with one
 * capture, and the tail reaches 60 s, past twice the longest window measured. Enter is
 * re-sent at every check that still finds the prompt, so a 50 s window costs about
 * seven Enters and one capture each; a taken prompt costs one capture.
 */
export const SUBMIT_VERIFY_DELAYS_MS: readonly number[] = [
  2_000, 3_000, 5_000, 5_000, 5_000, 10_000, 10_000, 10_000, 10_000,
];

/**
 * How many leading characters of the prompt have to match, whitespace removed. A prompt
 * shorter than this has to match whole, so a one-word answer cannot read a selection
 * dialog's highlighted row (`❯ 1. Yes`) as itself.
 */
const PROMPT_HEAD_CHARS = 24;

const compact = (s: string): string => s.replace(/\s+/g, '');

/**
 * Claude Code's stand-in for a long paste, whitespace removed (measured on 2.1.303):
 * `[Pasted text #1]` for one line over 800 characters, `[Pasted text #1 +3 lines]` for
 * four lines or more, the number counting line BREAKS. `#n` counts pastes, so it is never
 * pinned. Codex's `[Pasted Content N chars]` is not matched: not measured here.
 */
const PASTE_PLACEHOLDER = /^\[Pastedtext#\d+(?:\+(\d+)lines?)?\]$/;

/** The box-drawing rule Claude Code draws under its composer, which ends the block. */
const RULE_LINE = /^[\u2500-\u257f]/;

const lineBreaks = (s: string): number => (s.match(/\r\n|\r|\n/g) ?? []).length;

/**
 * Whether `prompt` is still sitting unsubmitted in the composer of `screen`.
 *
 * - `true`: the last `glyph` line holds the prompt's head, or the paste stand-in for a
 *   prompt with that many lines.
 * - `false`: the composer is empty (the prompt was taken) or holds other text.
 * - `undefined`: no composer line at all; nothing can be said, so nothing is sent.
 *
 * Whitespace is removed on both sides before comparing, because the composer wraps a
 * long prompt onto indented continuation lines and Claude Code draws a no-break space
 * after the glyph; `\s` covers that one in JavaScript. Those continuation lines (up to a
 * blank line or the rule) count too, for a prompt whose first line is short.
 */
export function promptStillInComposer(screen: string, prompt: string, glyph: string): boolean | undefined {
  if (!glyph) return undefined;
  const lines = stripAnsi(screen).split('\n');
  let at = lines.length - 1;
  while (at >= 0 && !lines[at].trim().startsWith(glyph)) at--;
  if (at < 0) return undefined;
  const first = compact(lines[at].trim().slice(glyph.length));
  if (!first) return false;
  const placeholder = PASTE_PLACEHOLDER.exec(first);
  if (placeholder) return Number(placeholder[1] ?? 0) === lineBreaks(prompt);
  const wanted = compact(prompt);
  if (!wanted) return false;
  const head = wanted.slice(0, PROMPT_HEAD_CHARS);
  const holds = (composer: string): boolean =>
    wanted.length >= PROMPT_HEAD_CHARS ? composer.startsWith(head) : composer === wanted;
  if (holds(first)) return true;
  let block = first;
  for (let i = at + 1; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text || !/^\s/.test(lines[i]) || RULE_LINE.test(text)) break;
    block += compact(text);
  }
  return block !== first && holds(block);
}

/** How long after a paste a bare Enter still counts as submitting it. */
export const PASTE_ENTER_WINDOW_MS = 10_000;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** The text of a write that is exactly one bracketed paste, else null. */
export function bracketedPasteText(data: string): string | null {
  if (data.length < PASTE_START.length + PASTE_END.length) return null;
  if (!data.startsWith(PASTE_START) || !data.endsWith(PASTE_END)) return null;
  const text = data.slice(PASTE_START.length, -PASTE_END.length);
  return text.includes(PASTE_START) || text.includes(PASTE_END) ? null : text;
}

/**
 * Pairs a composer's two writes: one bracketed paste, then a bare Enter. Fed every
 * write to the pane; anything between the two breaks the pair, so the Enter is
 * only ever matched with the paste right before it.
 */
export class PastedPromptWatch {
  private pending: { text: string; at: number } | null = null;

  constructor(private readonly windowMs: number = PASTE_ENTER_WINDOW_MS) {}

  /**
   * `paste` when `data` is a paste (a newer one owns the composer now), `submit` with
   * the pasted text when it is the Enter that sends the paste just before it.
   */
  feed(data: string, now: number): { kind: 'paste' } | { kind: 'submit'; text: string } | null {
    const pasted = bracketedPasteText(data);
    if (pasted !== null) {
      this.pending = pasted.trim() ? { text: pasted, at: now } : null;
      return { kind: 'paste' };
    }
    const pending = this.pending;
    this.pending = null;
    if (data !== '\r' || !pending || now - pending.at > this.windowMs) return null;
    return { kind: 'submit', text: pending.text };
  }
}

export interface SubmitVerifierDeps {
  /** The rendered pane, or null when there is none to read. */
  capture: () => string | null | undefined;
  /** Press Enter once. Failures are swallowed; the next check decides again. */
  sendEnter: () => Promise<unknown> | unknown;
  /** The CLI's composer glyph, resolved at check time (the registry can change). */
  glyph: () => string;
  log?: (message: string) => void;
  /** Test seam; production uses SUBMIT_VERIFY_DELAYS_MS. */
  delaysMs?: readonly number[];
}

/**
 * One per session. `arm(text)` starts the schedule for the prompt just sent and
 * cancels any earlier one: a newer write owns the composer now, and re-sending Enter
 * for an older prompt could submit the newer one early. `cancel()` is for teardown.
 */
export class SubmitVerifier {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(private readonly deps: SubmitVerifierDeps) {}

  arm(text: string): void {
    this.cancel();
    const gen = this.generation;
    const delays = this.deps.delaysMs ?? SUBMIT_VERIFY_DELAYS_MS;
    let step = 0;
    let elapsed = 0;
    let resent = 0;

    const schedule = (): void => {
      if (step >= delays.length) return;
      const delay = delays[step++];
      elapsed += delay;
      this.timer = setTimeout(() => void check(), delay);
      this.timer.unref?.();
    };
    const check = async (): Promise<void> => {
      this.timer = null;
      if (gen !== this.generation) return;
      const screen = this.deps.capture();
      if (promptStillInComposer(screen ?? '', text, this.deps.glyph()) !== true) return;
      resent++;
      this.deps.log?.(
        `prompt still in the composer after ${Math.round(elapsed / 1000)}s, re-sending Enter (${resent}/${delays.length})`
      );
      try {
        await this.deps.sendEnter();
      } catch {
        // The next check re-reads the screen and decides again.
      }
      if (gen !== this.generation) return;
      schedule();
    };
    schedule();
  }

  cancel(): void {
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
