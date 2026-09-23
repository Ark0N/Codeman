/**
 * @fileoverview Pure reading of an approvals-inbox item: what the card says,
 * which keys are live for it, and which of them just appeared.
 *
 * This is the half of "answer the dialog from the dashboard" that can be stated
 * as a function of the item. The IO half (`POST /api/approvals/:id/answer`)
 * lives in `tui-client.ts`, and the server re-captures the pane before it aims
 * any keystroke, so a card that went stale is refused rather than mis-answered.
 *
 * The key matrix is deliberately narrow, because the alternative is typing a
 * digit into whatever now has focus:
 *
 * | kind       | y            | n                      | 1-9                       |
 * | ---------- | ------------ | ---------------------- | ------------------------- |
 * | permission | approve      | the parsed "No" option, | only digits the server     |
 * | question   | approve      | else Esc               | actually parsed off screen |
 * | idle       | not a dialog: `p` (the composer) is the reply path      |
 *
 * A digit that is not among the parsed options returns null, which is what lets
 * the caller fall back to the list's own 1-9 jump instead of sending a keystroke
 * the dialog has no answer for.
 *
 * PURE: no IO, no timers, no `process.*`.
 *
 * @module tui/tui-approvals
 */

import type { ApprovalItem, ApprovalOption } from '../web/approval-inbox.js';
import type { TuiApprovalAnswer } from './tui-client.js';

/**
 * Card severity, in the same red/yellow vocabulary the web inbox uses, plus the quiet
 * third case: an item that opened acknowledged asks for nothing and reads grey.
 */
export type TuiApprovalTone = 'err' | 'warn' | 'info';

export interface TuiApprovalCard {
  tone: TuiApprovalTone;
  /** One line: what is being asked. */
  title: string;
  /** Extra context, one entry per line, already trimmed. May be empty. */
  detail: string[];
  /** Numbered choices parsed off the pane, empty when the frame did not parse. */
  options: ApprovalOption[];
  /** What the user can press right now, in words. */
  hint: string;
}

/** Longest single line the card contributes before the renderer clips it. */
const MAX_CARD_TEXT = 400;

function clean(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CARD_TEXT);
}

/**
 * How loud the card is. An idle prompt the inbox opened ALREADY acknowledged is not
 * asking for anything — the session is watching work it started itself — so it drops to
 * `info` and out of the warning vocabulary the other two share with the web inbox.
 */
export function approvalTone(item: ApprovalItem): TuiApprovalTone {
  if (item.kind !== 'idle') return 'err';
  return item.acknowledgedReason ? 'info' : 'warn';
}

/**
 * What the card says. Permission prompts lead with the tool (that is the whole
 * question), questions lead with their message, and an idle prompt says what it
 * is, since there is nothing to approve.
 */
export function approvalCard(item: ApprovalItem): TuiApprovalCard {
  const options = item.options ?? [];
  const message = clean(item.message);
  const summary = clean(item.toolSummary) || clean(item.toolName);

  if (item.kind === 'idle') {
    // Say what it is waiting for rather than asking for a reply, in the same words the
    // web drawer uses for the same item. The prompt is still answerable, so the hint
    // stays either way.
    const quiet = clean(item.acknowledgedReason);
    return {
      tone: approvalTone(item),
      title: quiet ? `quiet, ${quiet}` : message || 'waiting for your reply',
      detail: [],
      options: [],
      hint: 'p to reply',
    };
  }

  const title =
    item.kind === 'permission'
      ? `requests: ${summary || 'permission'}`
      : message || `question: ${summary || 'Claude is asking'}`;
  const detail: string[] = [];
  if (item.kind === 'permission' && message && message !== summary) detail.push(message);

  return {
    tone: 'err',
    title,
    detail,
    options,
    hint: options.length > 0 ? 'y approve · n deny · digit chooses' : 'y approve · n deny',
  };
}

/**
 * The parsed option that means "no". Claude renders it as `3. No, tell Claude
 * what to do (esc)`, and answering with its digit is the same keystroke the
 * dialog itself is waiting for; without a parsed one the answer route's `deny`
 * sends Esc, which every dialog understands.
 */
export function approvalDenyOption(item: ApprovalItem): number | null {
  const match = (item.options ?? []).find((option) => /^no\b/i.test(option.label));
  return match ? match.n : null;
}

/**
 * The answer one key produces, or null when that key means nothing here (so the
 * caller can let its normal binding through).
 */
export function approvalAnswerForKey(item: ApprovalItem, key: string): TuiApprovalAnswer | null {
  // An idle prompt has no dialog on screen: a digit or a `1` would land in the
  // composer as text. The card points at `p` instead.
  if (item.kind === 'idle') return null;
  if (key === 'y') return { action: 'approve' };
  if (key === 'n') {
    const deny = approvalDenyOption(item);
    return deny === null ? { action: 'deny' } : { action: 'option', option: deny };
  }
  if (key >= '1' && key <= '9') {
    const option = Number.parseInt(key, 10);
    return (item.options ?? []).some((entry) => entry.n === option) ? { action: 'option', option } : null;
  }
  return null;
}

/**
 * Ids in `items` that `seen` has not recorded. The bell rings for these and for
 * nothing else, which is what keeps a repaint (or a refetch that returns the
 * same pending item) silent.
 *
 * Answered ids stay in `seen` on purpose: the inbox restores an item under its
 * ORIGINAL id when a write fails, and re-ringing for a prompt the user already
 * heard about is worse than missing one.
 */
export function newApprovalIds(seen: ReadonlySet<string>, items: readonly ApprovalItem[]): string[] {
  const fresh: string[] = [];
  for (const item of items) if (!seen.has(item.id) && !fresh.includes(item.id)) fresh.push(item.id);
  return fresh;
}
