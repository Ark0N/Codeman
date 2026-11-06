/**
 * @fileoverview Short-lived, bounded guarded prompt receipts. No prompt content is
 * retained: only caller/session identity, lifecycle/input revisions and SHA-256.
 * A receipt is consumed synchronously before verification/delivery, including failures.
 */
import { createHash, randomUUID } from 'node:crypto';
import { stripAnsi } from './utils/regex-patterns.js';
import { visibleWidth } from './tui/tui-ansi.js';
import { compileVersionRegex } from './config/cli-registry/patterns.js';
import type { CliEntry } from './config/cli-registry/types.js';

/**
 * The screen chrome a guarded composer read relies on, all from the CLI registry
 * (`capabilities.workDetect`): the composer glyph, the pattern every row below an
 * idle composer must match, and what opens a popup or turns Enter into a command.
 * Nothing here names a CLI; a CLI takes part in guarded input by declaring
 * `composerFooterLine`.
 */
export interface GuardedComposerChrome {
  promptGlyph: string;
  footerLine: RegExp;
  /** A row of a suggestion popup drawn directly above the composer (`composerPopupLine`). */
  popupLine?: RegExp;
  /** First characters of a draft that make Enter run a command (`composerCommandPrefixes`). */
  commandPrefixes?: string;
  /** First characters of the word at the caret that open a completion popup (`composerCompletionSigils`). */
  completionSigils?: string;
}
/** The chrome a registry entry declares, or null (no guarded input for that CLI). */
export function guardedComposerChrome(entry: CliEntry | undefined): GuardedComposerChrome | null {
  const detect = entry?.capabilities.workDetect;
  if (!detect?.promptGlyph || !detect.composerFooterLine) return null;
  // Config-supplied (~/.codeman/clis.json): compiled through the ReDoS guard, null on refusal.
  const footerLine = compileVersionRegex(detect.composerFooterLine);
  if (!footerLine) return null;
  // A declared popup pattern the guard refuses is no chrome at all: dropping it would
  // silently read a popup frame as an idle composer.
  const popupLine = detect.composerPopupLine ? compileVersionRegex(detect.composerPopupLine) : undefined;
  if (popupLine === null) return null;
  return {
    promptGlyph: detect.promptGlyph,
    footerLine,
    ...(popupLine ? { popupLine } : {}),
    ...(detect.composerCommandPrefixes ? { commandPrefixes: detect.composerCommandPrefixes } : {}),
    ...(detect.composerCompletionSigils ? { completionSigils: detect.composerCompletionSigils } : {}),
  };
}
/**
 * Why a message cannot be staged into this composer, or null. Typing it would change
 * what Enter does rather than what it sends: a draft starting with a command prefix
 * (codex: `/` for a slash command, `!` for a shell command) is run, not sent as a
 * prompt, and a last word starting with a completion sigil (codex: `@` file and
 * mention search, `$` skills) opens a popup at the caret whose highlighted entry Enter
 * would accept. Checked before anything is typed. Only the LAST word matters for the
 * sigils because the caret is at the end of the message and the popup follows the
 * caret; a sigil word earlier in the message opens nothing.
 */
export function composerTriggerRefusal(message: string, chrome: GuardedComposerChrome): string | null {
  const first = message.trimStart().charAt(0);
  if (first && chrome.commandPrefixes?.includes(first))
    return `Stage refuses a message starting with "${first}": the CLI runs it as a command instead of sending it as a prompt. Send commands with \`codeman agent send\` (POST /api/v1/sessions/:id/input) instead`;
  const last = message.split(/\s/).at(-1)?.charAt(0);
  if (last && chrome.completionSigils?.includes(last))
    return `Stage refuses a message whose last word starts with "${last}": it opens a completion popup at the caret and Enter would accept the highlighted entry instead of sending the message. End the message with another word, or use \`codeman agent send\``;
  return null;
}
/** How many rows above the composer a popup check reads: the popup cap (8) plus header and hint rows. */
const POPUP_WINDOW_ROWS = 12;
/** Blank rows a popup can leave between itself and the composer row (the composer's own top padding, plus a popup's). */
const POPUP_GAP_ROWS = 3;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const composerRow = (chrome: GuardedComposerChrome) =>
  new RegExp(String.raw`^\s*${escapeRegex(chrome.promptGlyph)}(?:\s|$)`);
export const STAGE_MAX_BYTES = 8192;
export const promptSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export interface GuardedInputSnapshot {
  generation: string;
  revision: number;
  composerSha: string;
  /** Actual captured pane width minus the rendered composer prefix (including indentation). */
  availableColumns: number;
}
export interface GuardedInputTarget {
  id: string;
  /** The session's composer chrome, read before typing for what a message would trigger. */
  chrome(): GuardedComposerChrome | null;
  snapshot(): GuardedInputSnapshot | null;
  write(text: string): Promise<boolean>;
  submit(expected: GuardedInputSnapshot): Promise<boolean>;
}
interface Receipt extends GuardedInputSnapshot {
  owner: string;
  sessionId: string;
  expiresAt: number;
  sha256: string;
  /** When the staged keys went out, for `SUBMIT_QUIET_MS`. */
  typedAt: number;
}
export class GuardedInputConflict extends Error {}

/**
 * How long stage keeps reading the pane after typing for a frame that shows the
 * message, and how often. A capture taken right after the keys land is often a
 * frame from before them: codex repaints its composer 30 to 60 ms after input
 * arrives (measured on a live 0.162.0 pane), so the first read can show the old,
 * empty composer, or nothing provable at all. A second of 50 ms reads covers that
 * many times over and still answers the caller quickly.
 */
export const STAGE_SETTLE_TIMEOUT_MS = 1000;
export const STAGE_SETTLE_INTERVAL_MS = 50;
/**
 * The least time between the staged keys and the conditional Enter. Stage types its
 * text as plain keys (`send-keys -l`), which codex's paste-burst detector reads as a
 * paste, and for 120 ms after such a burst codex turns Enter into a NEWLINE rather
 * than a submit (`PASTE_ENTER_SUPPRESS_WINDOW`, codex-rs/tui/src/bottom_pane/
 * paste_burst.rs at rust-v0.162.0). A caller that submits the moment stage answers
 * would land inside it and be told one Enter was delivered while codex only broke
 * the line. Submit waits out the rest of this window first; a keystroke in that
 * time still invalidates the receipt.
 */
export const SUBMIT_QUIET_MS = 250;
/** Settle-window overrides for tests: a fake clock comes from the store's `now`. */
export interface StageSettleOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
/**
 * Every refusal after the keys went out says so: stage cannot tell whether the text
 * landed, so the caller must look before staging again (the recovery steps clear a
 * stranded draft with Ctrl+U).
 */
export const MAY_BE_TYPED =
  'no receipt was issued. The message may already be in the composer: inspect the pane and follow the stranded-draft recovery steps (Ctrl+U) before staging again';

/**
 * Conservatively read a composer: exactly one visible, unwrapped row and a known
 * footer, both as the registry describes them. Never remove internal spaces, infer
 * an unknown shell prompt, or interpret dialog options as authority. An unsupported
 * frame yields no proof.
 */
export function readGuardedComposer(screen: string, chrome: GuardedComposerChrome): string | null {
  const isComposer = composerRow(chrome);
  const lines = stripAnsi(screen)
    .split('\n')
    .map((line) => line.trimEnd());
  const rows = lines.map((line, index) => ({ line, index })).filter((row) => isComposer.test(row.line));
  const last = rows.at(-1);
  if (!last) return null;
  const below = lines.slice(last.index + 1).filter((line) => line.trim());
  if (below.length === 0 || below.length > 3 || below.some((line) => !chrome.footerLine.test(line))) return null;
  if (chrome.popupLine && popupAbove(lines, last.index, chrome.popupLine)) return null;
  // Preserve exact printable content; only SGR-dim placeholder/suggestion text is excluded.
  const raw = screen.split('\n')[last.index];
  let dim = false;
  let visible = '';
  // eslint-disable-next-line no-control-regex
  for (const token of raw.split(/(\x1b\[[0-9;]*m)/)) {
    // eslint-disable-next-line no-control-regex
    if (/^\x1b\[/.test(token)) {
      const codes = token.slice(2, -1).split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        // Extended color payloads may contain 0, 2 or 22; those are not SGR modes.
        if (codes[i] === 38 || codes[i] === 48 || codes[i] === 58) {
          i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
        } else if (codes[i] === 0 || codes[i] === 22) dim = false;
        else if (codes[i] === 2) dim = true;
      }
    } else if (!dim) visible += token;
  }
  // The glyph and the one space after it are the prefix, not input.
  return stripAnsi(visible)
    .trimStart()
    .slice(chrome.promptGlyph.length + 1)
    .trimEnd();
}

/**
 * Does a suggestion popup sit directly above the composer row? A popup draws over
 * the rows above the composer and leaves the footer below it alone, so the footer
 * check alone reads a popup frame as an idle composer. Read the contiguous block of
 * rows just above (past at most `POPUP_GAP_ROWS` blank rows), never the whole pane:
 * the transcript further up is the agent's own and may print anything. A transcript
 * row that happens to match costs a refusal, never a receipt.
 */
function popupAbove(lines: string[], composerIndex: number, popupLine: RegExp): boolean {
  let index = composerIndex - 1;
  for (let gap = 0; gap < POPUP_GAP_ROWS && index >= 0 && !lines[index].trim(); gap++) index--;
  for (let seen = 0; seen < POPUP_WINDOW_ROWS && index >= 0 && lines[index].trim(); seen++, index--) {
    if (popupLine.test(lines[index])) return true;
  }
  return false;
}

/** Require the capture's caret at the exact end of the unwrapped composer. */
export function readGuardedSnapshot(snapshot: string, chrome: GuardedComposerChrome): string | null {
  return readGuardedSnapshotDetails(snapshot, chrome)?.composer ?? null;
}
/** Exact input-row prefix width, shared by proof and preflight wrapping checks. */
export function readGuardedSnapshotDetails(
  snapshot: string,
  chrome: GuardedComposerChrome
): { composer: string; prefixWidth: number } | null {
  // formatPaneSnapshot emits one absolute row address per line, then the caret.
  // Plain captures lack caret evidence and cannot prove invisible trailing edits.
  // eslint-disable-next-line no-control-regex
  const positions = [...snapshot.matchAll(/\x1b\[(\d+);(\d+)H/g)];
  if (positions.length < 2) return null;
  const caret = positions.at(-1)!;
  if (caret.index! + caret[0].length !== snapshot.length) return null;
  const rows: string[] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const position = positions[i];
    if (Number(position[1]) !== i + 1 || position[2] !== '1') return null;
    rows.push(snapshot.slice(position.index! + position[0].length, positions[i + 1].index));
  }
  const composer = readGuardedComposer(rows.join('\n'), chrome);
  if (composer === null) return null;
  const isComposer = composerRow(chrome);
  let row = -1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (isComposer.test(stripAnsi(rows[i]))) {
      row = i;
      break;
    }
  const prefix = stripAnsi(rows[row]).match(new RegExp(String.raw`^(\s*${escapeRegex(chrome.promptGlyph)}[ \u00a0])`));
  if (!prefix || Number(caret[1]) !== row + 1 || Number(caret[2]) !== visibleWidth(prefix[1] + composer) + 1)
    return null;
  return { composer, prefixWidth: visibleWidth(prefix[1]) };
}

export class GuardedStageStore {
  private readonly receipts = new Map<string, Receipt>();
  private readonly busy = new Set<string>();
  private readonly settleTimeoutMs: number;
  private readonly settleIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 1024,
    private readonly ttlMs = 120000,
    settle: StageSettleOptions = {}
  ) {
    this.settleTimeoutMs = settle.timeoutMs ?? STAGE_SETTLE_TIMEOUT_MS;
    this.settleIntervalMs = settle.intervalMs ?? STAGE_SETTLE_INTERVAL_MS;
    this.sleep = settle.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  async stage(target: GuardedInputTarget, owner: string, message: string) {
    // eslint-disable-next-line no-control-regex
    const hasControls = /[\x00-\x1f\x7f-\x9f]/.test(message);
    if (
      !message ||
      message !== message.trimEnd() ||
      Buffer.byteLength(message) > STAGE_MAX_BYTES ||
      Buffer.from(message).toString('utf8') !== message ||
      hasControls
    )
      throw new GuardedInputConflict(
        'Stage requires printable single-line input within 8192 UTF8 bytes, without trailing whitespace'
      );
    const chrome = target.chrome();
    const refusal = chrome && composerTriggerRefusal(message, chrome);
    if (refusal) throw new GuardedInputConflict(refusal);
    const key = target.id;
    if (this.busy.has(key)) throw new GuardedInputConflict('Another guarded input operation is in progress');
    this.busy.add(key);
    try {
      const before = target.snapshot();
      if (!before || before.composerSha !== promptSha256(''))
        throw new GuardedInputConflict('An empty, verifiable composer is required');
      if (!Number.isFinite(before.availableColumns) || visibleWidth(message) >= before.availableColumns)
        throw new GuardedInputConflict('Message would reach the pane edge or wrap; shorten it or widen the pane');
      for (const [id, receipt] of this.receipts)
        if (receipt.expiresAt <= this.now() || receipt.sessionId === target.id) this.receipts.delete(id);
      // Refuse capacity before typing. Do not evict a caller's still-live receipt.
      // Include in-flight stages (this operation already owns one busy slot),
      // so different sessions cannot type concurrently into the same last slot.
      if (this.receipts.size + this.busy.size > this.capacity)
        throw new GuardedInputConflict('Guarded stage receipt capacity reached');
      if (!(await target.write(message)))
        throw new GuardedInputConflict(`Staging delivery failed or ambiguous; ${MAY_BE_TYPED}`);
      const typedAt = this.now();
      const after = await this.settle(target, before, promptSha256(message));
      const stageId = randomUUID();
      const expiresAt = this.now() + this.ttlMs;
      const sha256 = promptSha256(message);
      this.receipts.set(stageId, { ...after, owner, sessionId: target.id, expiresAt, sha256, typedAt });
      return { stageId, sha256, expiresAt, sessionId: target.id, submitted: false as const };
    } finally {
      this.busy.delete(key);
    }
  }
  /**
   * The first frame after the write that shows exactly this message, with the input
   * revision the write itself moved and nothing else changed. A null or stale frame
   * (the old composer, a half-painted one) is read again until the settle window
   * ends; a frame showing another writer's keystroke, a new pane lifecycle or a new
   * geometry is refused at once, since waiting cannot undo that.
   */
  private async settle(
    target: GuardedInputTarget,
    before: GuardedInputSnapshot,
    expectedSha: string
  ): Promise<GuardedInputSnapshot> {
    const deadline = this.now() + this.settleTimeoutMs;
    for (;;) {
      const frame = target.snapshot();
      if (
        frame &&
        (frame.generation !== before.generation ||
          frame.revision !== before.revision + 1 ||
          frame.availableColumns !== before.availableColumns)
      )
        throw new GuardedInputConflict(`Input or pane changed while staging; ${MAY_BE_TYPED}`);
      if (frame?.composerSha === expectedSha) return frame;
      if (this.now() >= deadline)
        throw new GuardedInputConflict(
          `The composer did not show the staged message within ${this.settleTimeoutMs} ms; ${MAY_BE_TYPED}`
        );
      await this.sleep(this.settleIntervalMs);
    }
  }
  async submit(target: GuardedInputTarget, owner: string, stageId: string, confirmSha: string) {
    const receipt = this.receipts.get(stageId);
    if (!receipt || receipt.owner !== owner || receipt.sessionId !== target.id)
      throw new GuardedInputConflict('Unknown, used, or foreign stage receipt');
    // One shot, even a wrong hash or unprovable composer. No retry of ambiguous Enter.
    this.receipts.delete(stageId);
    if (this.busy.has(target.id)) throw new GuardedInputConflict('Another guarded input operation is in progress');
    this.busy.add(target.id);
    try {
      if (receipt.expiresAt <= this.now() || receipt.sha256 !== confirmSha)
        throw new GuardedInputConflict('Expired stage receipt or confirmation hash mismatch');
      const quiet = receipt.typedAt + SUBMIT_QUIET_MS - this.now();
      if (quiet > 0) await this.sleep(quiet);
      const current = target.snapshot();
      if (
        !current ||
        current.generation !== receipt.generation ||
        current.revision !== receipt.revision ||
        current.availableColumns !== receipt.availableColumns ||
        current.composerSha !== receipt.sha256
      )
        throw new GuardedInputConflict('Staged composer, input, or pane identity changed; nothing submitted');
      if (!(await target.submit(current)))
        throw new GuardedInputConflict('Submission delivery failed or ambiguous; receipt consumed, inspect the pane');
      return { stageId, sessionId: target.id, submitted: true as const };
    } finally {
      this.busy.delete(target.id);
    }
  }
  clear(): void {
    this.receipts.clear();
    this.busy.clear();
  }
}
