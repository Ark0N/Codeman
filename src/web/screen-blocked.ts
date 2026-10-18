/**
 * @fileoverview Screen-detected blocked dialogs: what the server does with them.
 *
 * A CLI that has no hook to say "I stopped to ask you something" (codex: `hooks: 'none'`,
 * and the one CLI Codeman launches with its approvals on by default) declares
 * `capabilities.workDetect.blockedLine`, and `Session` reads its dialogs off the pane and
 * emits `blockedChanged` (see `_noteBlockedReading()` in session.ts). This module turns
 * that edge into exactly what a Claude `permission_prompt` hook produces in
 * `hook-event-routes.ts`, so every surface that already knows that event (the red tab
 * alert and desktop notification, web push, webhooks, the phone overview's NEEDS YOU, the
 * Approvals Inbox, `codeman tui`, the run summary and the `blocked` wait signal) needs no
 * second code path:
 *
 * - `raiseScreenBlocked()`: the `blocked` wait signal, an Approvals Inbox item, the
 *   `hook:permission_prompt` broadcast and the push/webhook.
 * - `clearScreenBlocked()`: resolve that item, which broadcasts `approval:resolved`, and
 *   every client clears the alert from it (`_onApprovalResolved`, approvals-ui.js).
 *
 * Rules it keeps:
 * - ⚠️ ALERT ONLY. The item is `answerInTerminal` (the #610 shape the DeepSeek Harness
 *   items use): the answer route refuses it, push carries no Approve/Deny, and the inbox
 *   card and the overview strip say "answer in the terminal". The dialog is read
 *   off a screen the agent writes most of, so a forged match must cost a false alert and
 *   never a keystroke. Codeman does not answer these dialogs.
 * - The item gets no `capture` callback, only the frame it was raised from as context:
 *   the inbox's option parser and staleness sweep are shaped for Claude's dialogs, and the
 *   SESSION owns this item's lifetime (it re-reads the screen while the dialog is up).
 * - Hooks win. A session whose CLI reports blocked itself (`hooksAvailableForMode()`)
 *   gets nothing here, so a CLI that declared both could never alert twice for one dialog.
 * - Only the item this module opened is resolved on clear, never a hook-raised one.
 *
 * @dependencies approval-inbox, session-wait-registry, sse-events, cli-registry
 * @consumedby web/session-listener-wiring (blockedChanged)
 * @module web/screen-blocked
 */

import { getCli } from '../config/cli-registry/registry.js';
import type { SessionMode } from '../types.js';
import { approvalInbox } from './approval-inbox.js';
import { sessionWaits, hooksAvailableForMode, sessionHookOptions } from './session-wait-registry.js';
import { SseEvent } from './sse-events.js';

/** Marks a screen-read event, so a consumer can tell it from a hook-raised one. */
export const SCREEN_BLOCKED_SOURCE = 'screen';

/** The facts about a session this module reads (structural, so tests need no `Session`). */
export interface ScreenBlockedSession {
  id: string;
  name: string;
  mode: SessionMode;
  deepSeekStatusReporting?: boolean;
  docker?: unknown;
  remote?: unknown;
}

/** What the server lends it: the same channels the hook route uses. */
export interface ScreenBlockedDeps {
  broadcast(event: string, data: unknown): void;
  broadcastSessionStateDebounced(sessionId: string): void;
  sendPushNotifications(event: string, data: Record<string, unknown>): void;
  getRunSummaryTracker?(
    sessionId: string
  ): { recordHookEvent(event: string, data?: Record<string, unknown>): void } | undefined;
}

/**
 * The line every surface shows for such a dialog. Built from the CLI's own label (data,
 * never an id branch), and from nothing on the screen: the dialog's wording is the
 * agent's to choose (a question's text, a command preview), so none of it reaches a push
 * or a webhook. The approval card shows the frame itself, escaped.
 */
export function screenBlockedMessage(mode: SessionMode): string {
  return `${getCli(mode)?.label ?? mode} is waiting for your answer in the terminal`;
}

/**
 * The pane now shows a dialog its CLI is blocked on: raise everything a Claude
 * `permission_prompt` hook would.
 *
 * @param frame the capture the dialog was read from, kept as the card's context
 * @returns the id of the Approvals Inbox item opened, or null when nothing was raised
 */
export function raiseScreenBlocked(
  session: ScreenBlockedSession,
  deps: ScreenBlockedDeps,
  frame?: string | null
): string | null {
  if (hooksAvailableForMode(session.mode, sessionHookOptions(session))) return null;
  const message = screenBlockedMessage(session.mode);

  // Before anything that can throw, like the hook route: a caller parked on `blocked`
  // is the reason this exists for agents.
  sessionWaits.notifySignal(session.id, 'blocked');

  const item = approvalInbox.notePrompt({
    sessionId: session.id,
    sessionName: session.name,
    kind: 'permission',
    message,
    answerInTerminal: true,
    context: frame ?? undefined,
  });

  const data = { source: SCREEN_BLOCKED_SOURCE, message };
  deps.broadcast(SseEvent.HookPermissionPrompt, {
    sessionId: session.id,
    timestamp: Date.now(),
    ...data,
    approvalId: item.id,
  });
  // Same ride-along as the hook route: the home screens rank the blocked group on the
  // session's stamps, so the row moves without waiting for some unrelated event.
  deps.broadcastSessionStateDebounced(session.id);
  // No approvalId: push would offer Approve/Deny for a dialog nobody here may answer.
  deps.sendPushNotifications(SseEvent.HookPermissionPrompt, {
    sessionId: session.id,
    sessionName: session.name,
    ...data,
  });
  deps.getRunSummaryTracker?.(session.id)?.recordHookEvent('permission_prompt', data);
  return item.id;
}

/**
 * The dialog left the screen (answered, cancelled, or the pane went away): resolve the
 * item `raiseScreenBlocked()` opened, which clears the alert on every client. An item
 * that is no longer that one (dismissed, expired, or superseded by a hook) is left alone.
 *
 * @param itemId what `raiseScreenBlocked()` returned
 */
export function clearScreenBlocked(sessionId: string, itemId: string | null): void {
  if (!itemId) return;
  if (approvalInbox.getForSession(sessionId)?.id !== itemId) return;
  approvalInbox.resolveForSession(sessionId, 'resolved_in_terminal');
}
