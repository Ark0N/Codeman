/**
 * @fileoverview Approvals Inbox: server-side registry of prompts waiting on a human.
 *
 * One cross-session queue of pending Claude prompts (permission dialogs,
 * AskUserQuestion/elicitation questions, idle prompts), fed by `/api/hook-event`
 * and answered via `POST /api/approvals/:id/answer`. Before this store existed,
 * pending prompts lived only in `app.js` memory (SSE-transient, lost on reload)
 * and the push notification Approve/Deny buttons had nothing to act on.
 * Design: `docs/approvals-inbox-plan.md`.
 *
 * Invariants:
 * - At most ONE active item per session: the Claude TUI shows one dialog at a
 *   time, so a new prompt supersedes the session's previous item.
 * - Module-level singleton in the style of `session-wait-registry.ts`: no
 *   `Session` import, no IO; the server injects emit callbacks (`onPending`/
 *   `onUpdated`/`onResolved`), which keeps this unit-testable and cycle-free.
 * - Items are in-memory only. A server restart drops them; the next prompt
 *   re-fires the hook. Claude-mode sessions only (hooks fire for nothing else).
 * - Answer flow is take-then-write: `take()` removes the item BEFORE keystrokes
 *   are sent so a double-tap cannot double-send; `restore()` re-inserts on a
 *   failed write unless a newer prompt arrived meanwhile.
 * - Acknowledgement (`acknowledge()`, idle items only) is NOT resolution: the
 *   item stays pending, it just stops arming the tab alert on every client.
 *
 * @dependencies utils (stripAnsi, CLAUDE_WORKING_LINE_PATTERN)
 * @consumedby web/routes/hook-event-routes (notePrompt/resolve), web/routes/approval-routes,
 *   web/session-listener-wiring (working/exit resolution), web/server (emit callbacks + stop)
 *
 * @module web/approval-inbox
 */

import { stripAnsi, CLAUDE_WORKING_LINE_PATTERN } from '../utils/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ApprovalKind = 'permission' | 'question' | 'idle';

export type ApprovalResolution =
  'answered' | 'resolved_in_terminal' | 'superseded' | 'session_ended' | 'dismissed' | 'expired';

/** A numbered choice parsed from the captured dialog frame. */
export interface ApprovalOption {
  n: number;
  label: string;
}

export interface ApprovalItem {
  /** `${sessionId}:${seq}`, stable across re-captures, unique per prompt. */
  id: string;
  sessionId: string;
  sessionName: string;
  kind: ApprovalKind;
  createdAt: number;
  /** Sanitized hook fields (already bounded by sanitizeHookData). */
  toolName?: string;
  toolSummary?: string;
  message?: string;
  cwd?: string;
  /** ANSI-stripped tail of the visible pane frame at capture time. */
  context?: string;
  /**
   * Set when a human looked at the session (the web UI selecting its tab). The
   * item stays PENDING and answerable, only its tab alert is spent: clients
   * skip re-arming the alert for an acknowledged item when they seed from
   * `GET /api/approvals`, which is what makes "I checked it" survive a reload
   * and reach the user's other devices. See `acknowledge()`.
   */
  acknowledgedAt?: number;
  /**
   * Why the item arrived already acknowledged, for display only: the inbox
   * writes `watching 1 monitor` for a session that went quiet because work it
   * started itself is still running. A human acknowledgement leaves this unset,
   * so a card can say "quiet, watching 1 monitor" rather than implying somebody
   * looked. ⚠️ Pane-derived text, so it is bounded at the source and must not
   * reach the DOM as markup — see `watchingLabel()` in `session-activity.ts`.
   */
  acknowledgedReason?: string;
  /**
   * Present only when the frame parsed confidently. Gates which digits the
   * answer endpoint accepts; absent → only approve('1')/deny(Esc) are allowed.
   */
  options?: ApprovalOption[];
}

export interface ApprovalResolvedInfo {
  id: string;
  sessionId: string;
  kind: ApprovalKind;
  resolution: ApprovalResolution;
}

interface NotePromptArgs {
  sessionId: string;
  sessionName: string;
  kind: ApprovalKind;
  toolName?: string;
  toolSummary?: string;
  message?: string;
  cwd?: string;
  /**
   * What the session's pane says is still running in the background
   * (`Session.watching`, e.g. `1 monitor`). An idle prompt from such a session
   * opens ALREADY acknowledged: see `notePrompt()`.
   */
  watching?: string | null;
  /** Returns the raw (ANSI-bearing) pane frame, or null when unavailable. */
  capture?: () => string | null;
}

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Items older than this are dropped on read: a 12h-old dialog is stale by any measure. */
const ITEM_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * The Notification hook can fire before Ink finishes painting the dialog, so a
 * single delayed re-capture picks up the frame the immediate capture missed.
 */
const RECAPTURE_DELAY_MS = 600;
/**
 * Delayed staleness pass for the late-hook case (see notePrompt). Comfortably
 * clear of RECAPTURE_DELAY_MS so a dialog Ink has not painted yet is never
 * mistaken for one that is gone.
 */
const STALE_CHECK_DELAY_MS = 3000;
/** Context kept per item: enough for a dialog plus a few lines above it. */
const MAX_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_LINES = 30;
const MAX_OPTION_LABEL_CHARS = 120;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The visible-frame tmux capture (`formatPaneSnapshot`) carries NO newlines: it
 * repaints every row at its absolute position via `ESC[<row>;<col>H`. Verified
 * against a live dialog: without this conversion the whole frame collapses to
 * one line and no dialog ever parses. Column 1 (or omitted) means a fresh row →
 * newline; a mid-row jump becomes a space so adjacent words don't merge.
 */
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_PATTERN = /\x1b\[(?:(\d+)(?:;(\d+))?)?[Hf]/g;

/**
 * Normalize a raw pane capture into card context: convert row repaints to
 * lines, strip ANSI, right-trim lines, drop trailing blanks, keep the last
 * MAX_CONTEXT_LINES lines.
 */
export function normalizeCapturedFrame(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const rowed = raw.replace(CURSOR_POSITION_PATTERN, (_m, _row, col) => (!col || col === '1' ? '\n' : ' '));
  const lines = stripAnsi(rowed)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  if (lines.length === 0) return undefined;
  const text = lines.slice(-MAX_CONTEXT_LINES).join('\n');
  return text.length > MAX_CONTEXT_CHARS ? text.slice(-MAX_CONTEXT_CHARS) : text;
}

/**
 * Parse the numbered options of a Claude dialog out of a normalized frame.
 *
 * Matches the shapes Ink renders for permission prompts and AskUserQuestion:
 *
 *     ❯ 1. Yes                                 ❯ 1. Red
 *       2. Yes, allow all edits (shift+tab)        Prefer red
 *       3. No, tell Claude what to do (esc)      2. Blue
 *                                                  Prefer blue
 *
 * Options must be consecutively numbered from 1 (2..6 of them); description /
 * wrap / separator lines between options are tolerated up to a small gap
 * (AskUserQuestion puts a description under every option and a ─ separator
 * before its "Chat about this" entry, measured against the live dialog). The
 * LAST complete block in the frame wins (dialogs render at the bottom).
 * Returns undefined when nothing parses; callers then fall back to
 * approve/deny only, so a mis-parse can never route a digit at a dialog that
 * does not have it.
 */
export function parseDialogOptions(context: string | undefined): ApprovalOption[] | undefined {
  if (!context) return undefined;
  const lines = context.split('\n');
  let lastComplete: ApprovalOption[] | undefined;
  let run: ApprovalOption[] = [];
  let gap = 0;
  const commit = () => {
    if (run.length >= 2 && run.length <= 6) lastComplete = run;
    run = [];
    gap = 0;
  };
  for (const line of lines) {
    const m = line.match(/^\s*(?:❯\s*)?(\d)[.)]\s+(.+)$/);
    const n = m ? Number(m[1]) : NaN;
    if (m && n === run.length + 1) {
      run.push({ n, label: m[2].trim().slice(0, MAX_OPTION_LABEL_CHARS) });
      gap = 0;
    } else if (m && n === 1) {
      commit();
      run = [{ n: 1, label: m[2].trim().slice(0, MAX_OPTION_LABEL_CHARS) }];
    } else if (run.length > 0 && ++gap > 3) {
      // Too far past the last option for this to still be its description:
      // the block is over.
      commit();
    }
  }
  commit();
  return lastComplete;
}

// ─── Registry ────────────────────────────────────────────────────────────────

export class ApprovalInbox {
  /** Keyed by sessionId; the one-active-item-per-session invariant lives here. */
  private items = new Map<string, ApprovalItem>();
  /** Post-capture timers per item id (re-capture + the delayed staleness check). */
  private itemTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** Capture callbacks kept for answer-time re-verification; dropped on remove. */
  private captures = new Map<string, () => string | null>();
  private seq = 0;
  private stopped = false;

  /** Emit callbacks, injected by the server (SSE broadcast + push). */
  onPending?: (item: ApprovalItem) => void;
  onUpdated?: (item: ApprovalItem) => void;
  onResolved?: (info: ApprovalResolvedInfo) => void;

  /**
   * Record a prompt for a session, superseding any previous item, and return
   * the new item. Captures context immediately and once more after a short
   * delay (see RECAPTURE_DELAY_MS).
   *
   * ⚠️ An idle prompt from a session that is WATCHING its own background work
   * opens already acknowledged (`args.watching`). Claude Code ends the turn
   * after arming a monitor or backgrounding a shell and then reports the pane
   * idle a minute later, so the alert that follows asks a human to look at a
   * session that wants nothing from them. Acknowledging is deliberately what
   * happens here rather than skipping the item: the prompt is real and stays
   * pending, answerable and available as Read My Mind context, and only the
   * alert it would have armed is spent. A wrong label therefore costs a card
   * that does not blink, never an alert that was never created.
   *
   * It re-arms by itself. The next idle prompt supersedes this item and builds
   * a fresh one, so once the background work ends and the session goes quiet
   * for an ordinary reason, that item carries no acknowledgement and alerts
   * normally. Only `idle` is eligible: a permission or question dialog blocks
   * the agent whatever else it started, so its alert must survive.
   */
  notePrompt(args: NotePromptArgs): ApprovalItem {
    this.resolveForSession(args.sessionId, 'superseded');
    const item: ApprovalItem = {
      id: `${args.sessionId}:${++this.seq}`,
      sessionId: args.sessionId,
      sessionName: args.sessionName,
      kind: args.kind,
      createdAt: Date.now(),
      toolName: args.toolName,
      toolSummary: args.toolSummary,
      message: args.message,
      cwd: args.cwd,
    };
    if (args.kind === 'idle' && args.watching) {
      item.acknowledgedAt = item.createdAt;
      item.acknowledgedReason = `watching ${args.watching}`;
    }
    this.applyCapture(item, args.capture);
    this.items.set(args.sessionId, item);
    if (args.capture) this.captures.set(args.sessionId, args.capture);
    this.onPending?.(item);
    if (args.capture && !this.stopped) {
      // Pass 1 (600ms): enrich the card with the painted frame.
      this.scheduleForItem(item, RECAPTURE_DELAY_MS, () => {
        this.applyCapture(item, args.capture);
        this.onUpdated?.(item);
      });
      // Pass 2: the late-hook staleness check. Claude Code fires the
      // Notification behind the dialog, so a prompt answered before the hook
      // lands creates an item for a dialog that is ALREADY gone: nothing ever
      // parsed, so the "options vanished" test can never fire, `stop` may have
      // gone by already, and the red alert then outlived reloads until the 12h
      // TTL. This pass re-reads the pane and resolves when the frame proves no
      // dialog is up. Deliberately LATER than the re-capture, whose whole
      // reason for existing is that Ink may not have painted the dialog yet:
      // resolving inside that window could clear the alert for a dialog that
      // was about to appear.
      this.scheduleForItem(item, STALE_CHECK_DELAY_MS, () => {
        this.verifyStillAnswerable(item.id);
      });
    }
    return item;
  }

  /**
   * Answer-time guard: re-capture the pane and check the dialog is still on
   * screen before keystrokes are sent at it. If the dialog is gone (answered in
   * the terminal moments ago) the item resolves and the answer is refused,
   * because the digit would land in whatever now has focus.
   *
   * A fresh frame that parses NO options is conclusive in two cases, and only
   * those; anything else stays answerable, so an unreadable capture keeps the
   * alert rather than losing a live dialog:
   *
   * 1. The item HAD parsed options. They cannot vanish while the dialog is up.
   * 2. The frame shows Claude actively running a turn. A modal dialog BLOCKS
   *    the turn, so a working line and a dialog cannot coexist — measured on
   *    v2.1.237: a live-dialog frame carries neither the `… (13s` timer nor
   *    even the `esc to interrupt` footer, which the dialog replaces with
   *    `Enter to select · ↑/↓ to navigate · Esc to cancel`.
   *
   * Case 2 is what closes the late-hook hole. Claude Code fires the
   * Notification behind the dialog, so a prompt answered before the hook lands
   * produces an item whose FIRST capture already has no dialog in it — never
   * parsed, so case 1 can never fire, and the red alert then outlived even
   * `stop` (which had already fired) and survived reloads until the 12h TTL.
   */
  verifyStillAnswerable(id: string): boolean {
    const item = this.getById(id);
    if (!item) return false;
    if (item.kind === 'idle') return true;
    const capture = this.captures.get(item.sessionId);
    if (!capture) return true;
    let raw: string | null = null;
    try {
      raw = capture();
    } catch {
      return true; // capture hiccup: inconclusive, keep the item answerable
    }
    const context = normalizeCapturedFrame(raw);
    if (!context) return true;
    const options = parseDialogOptions(context);
    if (!options) {
      if (item.options || CLAUDE_WORKING_LINE_PATTERN.test(context)) {
        this.remove(item, 'resolved_in_terminal');
        return false;
      }
      return true; // never parsed and the pane is not visibly working: unreadable, not gone
    }
    item.context = context;
    item.options = options;
    return true;
  }

  /**
   * "This session's pane started moving again": re-verify its pending DIALOG
   * item against the screen and resolve it if the dialog is gone.
   *
   * The staleness check itself lived only in `GET /api/approvals`, which
   * nothing calls while a page is open (`seedApprovals()` runs on init and
   * reconnect), so a dialog answered in the terminal kept its red tab alert for
   * the whole rest of the turn. The `working` signal is exactly the moment an
   * answer lands, and routing it through `verifyStillAnswerable` is what makes
   * it safe to act on for a permission/question item: `working` is heuristic
   * and can flap, but it only decides WHEN to look — the pane decides the
   * outcome, and an unreadable capture keeps the alert.
   *
   * Cheap by construction: a Map miss unless a dialog item is actually pending,
   * and the item is gone after the first successful resolve.
   */
  resolveIfDialogGone(sessionId: string): void {
    const item = this.getForSession(sessionId);
    if (!item || item.kind === 'idle') return;
    this.verifyStillAnswerable(item.id);
  }

  /** Pending item for a session, TTL-checked. */
  getForSession(sessionId: string): ApprovalItem | undefined {
    const item = this.items.get(sessionId);
    if (!item) return undefined;
    if (this.isExpired(item)) {
      this.resolveForSession(sessionId, 'expired');
      return undefined;
    }
    return item;
  }

  /** Pending item by id, TTL-checked. */
  getById(id: string): ApprovalItem | undefined {
    const item = this.getForSession(sessionIdOf(id));
    return item?.id === id ? item : undefined;
  }

  /** All pending items, TTL-swept, oldest first. */
  listPending(): ApprovalItem[] {
    for (const sessionId of [...this.items.keys()]) this.getForSession(sessionId);
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Remove the item as `answered` and return it, or undefined if it is no
   * longer pending. Callers send keystrokes AFTER a successful take, and
   * `restore()` on a failed write.
   */
  take(id: string): ApprovalItem | undefined {
    const item = this.getById(id);
    if (!item) return undefined;
    this.remove(item, 'answered');
    return item;
  }

  /** Re-insert a taken item after a failed write, unless superseded meanwhile. */
  restore(item: ApprovalItem): void {
    if (this.stopped || this.items.has(item.sessionId)) return;
    this.items.set(item.sessionId, item);
    this.onPending?.(item);
  }

  /**
   * Mark a session's pending item as SEEN by a human, and return it (undefined
   * when there is nothing to acknowledge or it is already acknowledged). The
   * item is NOT resolved: an idle prompt a human glanced at is still unanswered,
   * so it stays in the inbox, stays answerable, and stays available as Read My
   * Mind context. Only the tab alert it armed is spent.
   *
   * ⚠️ `kinds` defaults to `['idle']` and callers must keep it that narrow:
   * looking at a permission/question dialog does not answer it, so the red
   * "needs you" alert has to survive being viewed.
   */
  acknowledge(sessionId: string, kinds: ApprovalKind[] = ['idle']): ApprovalItem | undefined {
    const item = this.getForSession(sessionId);
    if (!item || !kinds.includes(item.kind) || item.acknowledgedAt) return undefined;
    item.acknowledgedAt = Date.now();
    if (!this.stopped) this.onUpdated?.(item);
    return item;
  }

  /** Remove an item without keystrokes (user chose Dismiss). */
  dismiss(id: string): boolean {
    const item = this.getById(id);
    if (!item) return false;
    this.remove(item, 'dismissed');
    return true;
  }

  /**
   * Resolve a session's pending item, if any (stop hook, exit, ...). `kinds`
   * restricts which item kinds the signal may clear: the heuristic `working`
   * transition passes `['idle']` so a mid-turn flap cannot false-clear a
   * pending permission/question dialog.
   */
  resolveForSession(sessionId: string, resolution: ApprovalResolution, kinds?: ApprovalKind[]): void {
    const item = this.items.get(sessionId);
    if (!item) return;
    if (kinds && !kinds.includes(item.kind)) return;
    this.remove(item, resolution);
  }

  /** Clear all timers (shutdown/tests). Items become inert; no events fire after this. */
  stop(): void {
    this.stopped = true;
    for (const timers of this.itemTimers.values()) for (const timer of timers) clearTimeout(timer);
    this.itemTimers.clear();
    this.items.clear();
    this.captures.clear();
  }

  /**
   * Run `fn` after `delayMs` if the item is still the live one for its session,
   * tracking the timer so `remove()`/`stop()` can cancel it.
   */
  private scheduleForItem(item: ApprovalItem, delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      const timers = this.itemTimers.get(item.id)?.filter((t) => t !== timer) ?? [];
      if (timers.length > 0) this.itemTimers.set(item.id, timers);
      else this.itemTimers.delete(item.id);
      if (this.items.get(item.sessionId)?.id !== item.id) return;
      fn();
    }, delayMs);
    this.itemTimers.set(item.id, [...(this.itemTimers.get(item.id) ?? []), timer]);
  }

  private applyCapture(item: ApprovalItem, capture?: () => string | null): void {
    if (!capture) return;
    let raw: string | null = null;
    try {
      raw = capture();
    } catch {
      // Capture is best-effort; the card still renders from hook fields.
    }
    const context = normalizeCapturedFrame(raw);
    if (!context) return;
    item.context = context;
    // Idle prompts are not dialogs; never offer digit answers for them.
    if (item.kind === 'idle') return;
    const options = parseDialogOptions(context);
    // ⚠️ ADD-ONLY: a re-capture that parses NOTHING must never erase options a
    // previous capture found. Claude Code delays the Notification hook behind
    // the dialog (measured 6s here, up to ~30s), so the 600ms re-capture very
    // often lands AFTER the user has already answered in the terminal, on a
    // frame with no dialog in it. Clearing the field there was the whole bug:
    // `verifyStillAnswerable` reads a MISSING `options` as "never parsed" and
    // keeps such an item answerable by design, so a cleared field made the item
    // permanently unsweepable — the red "needs you" alert then survived every
    // `GET /api/approvals` and every page reload and only went away on `stop`
    // (owner report 2026-08-20: a confirmed question left a tab flowing red for
    // ~8 minutes while the turn ran on), and the stale card still accepted an
    // answer, typing a bare `1` into a composer with no dialog under it.
    // Keeping the parse means a later capture is CONCLUSIVE: options present +
    // fresh frame without them == answered in the terminal.
    if (options) item.options = options;
  }

  private remove(item: ApprovalItem, resolution: ApprovalResolution): void {
    this.items.delete(item.sessionId);
    this.captures.delete(item.sessionId);
    for (const timer of this.itemTimers.get(item.id) ?? []) clearTimeout(timer);
    this.itemTimers.delete(item.id);
    if (!this.stopped) {
      this.onResolved?.({ id: item.id, sessionId: item.sessionId, kind: item.kind, resolution });
    }
  }

  private isExpired(item: ApprovalItem): boolean {
    return Date.now() - item.createdAt > ITEM_TTL_MS;
  }
}

function sessionIdOf(itemId: string): string {
  return itemId.slice(0, itemId.lastIndexOf(':'));
}

/** Process-wide singleton, mirroring `sessionWaits`. */
export const approvalInbox = new ApprovalInbox();
