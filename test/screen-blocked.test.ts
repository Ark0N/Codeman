/**
 * What the server raises for a dialog read off a hook-less CLI's screen (codex), and what
 * clears it: `web/screen-blocked.ts`. The session side, and the codex captures it reads,
 * are in `codex-blocked-detection.test.ts`.
 *
 * The contract: exactly what a Claude `permission_prompt` hook raises (the `blocked` wait
 * signal, an Approvals Inbox item, the `hook:permission_prompt` broadcast, push and
 * webhook, a run-summary row), but ALERT-ONLY, since the dialog was read from text the
 * agent writes: the item is `answerInTerminal`, push carries no `approvalId`, and the
 * inbox never resolves or answers it on its own.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { raiseScreenBlocked, clearScreenBlocked, screenBlockedMessage } from '../src/web/screen-blocked.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { sessionWaits } from '../src/web/session-wait-registry.js';
import { SseEvent } from '../src/web/sse-events.js';
import type { SessionMode } from '../src/types.js';

const FIXTURES = new URL('./fixtures/codex-dialogs/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

describe('raiseScreenBlocked / clearScreenBlocked', () => {
  const SESSION = { id: 'screen-blocked-test', name: 'w9-scratch', mode: 'codex' as SessionMode };

  function deps() {
    const recordHookEvent = vi.fn();
    return {
      broadcast: vi.fn(),
      broadcastSessionStateDebounced: vi.fn(),
      sendPushNotifications: vi.fn(),
      getRunSummaryTracker: vi.fn(() => ({ recordHookEvent })),
      recordHookEvent,
    };
  }

  afterEach(() => {
    approvalInbox.resolveForSession(SESSION.id, 'session_ended');
    sessionWaits.cancelAll(SESSION.id);
  });

  it('raises what a permission_prompt hook raises, alert-only', async () => {
    const d = deps();
    const waiting = sessionWaits.waitForSignal(SESSION.id, { until: ['blocked'], timeoutMs: 5000 });
    const itemId = raiseScreenBlocked(SESSION, d, fixture('exec-approval.txt'));

    expect((await waiting).signal).toBe('blocked');

    const item = approvalInbox.getForSession(SESSION.id)!;
    expect(item.id).toBe(itemId);
    expect(item.kind).toBe('permission');
    expect(item.answerInTerminal).toBe(true);
    expect(item.message).toBe('Codex is waiting for your answer in the terminal');
    // The frame is the card's context, and nothing parsed it into answer buttons.
    expect(item.context).toContain('Press enter to confirm or esc to cancel');
    expect(item.options).toBeUndefined();

    expect(d.broadcast).toHaveBeenCalledWith(
      SseEvent.HookPermissionPrompt,
      expect.objectContaining({ sessionId: SESSION.id, source: 'screen', approvalId: itemId })
    );
    expect(d.broadcastSessionStateDebounced).toHaveBeenCalledWith(SESSION.id);
    // Push and webhook get the message and NO approvalId, so no Approve/Deny buttons.
    const [event, push] = d.sendPushNotifications.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe(SseEvent.HookPermissionPrompt);
    expect(push).toMatchObject({ sessionId: SESSION.id, sessionName: 'w9-scratch', source: 'screen' });
    expect(push.message).toBe(screenBlockedMessage('codex'));
    expect(push.approvalId).toBeUndefined();
    expect(d.recordHookEvent).toHaveBeenCalledWith('permission_prompt', expect.objectContaining({ source: 'screen' }));
  });

  it('never steers a keystroke: the inbox item cannot be answered', () => {
    raiseScreenBlocked(SESSION, deps(), fixture('exec-approval.txt'));
    const item = approvalInbox.getForSession(SESSION.id)!;
    // No capture callback, so the inbox's Claude-shaped sweep never resolves it either:
    // the session owns its lifetime.
    expect(approvalInbox.verifyStillAnswerable(item.id)).toBe(true);
    approvalInbox.resolveIfDialogGone(SESSION.id);
    expect(approvalInbox.getForSession(SESSION.id)?.id).toBe(item.id);
  });

  it('clears by resolving the item it opened, and only that one', () => {
    const resolved: string[] = [];
    const prev = approvalInbox.onResolved;
    approvalInbox.onResolved = (info) => resolved.push(`${info.id}:${info.resolution}`);
    try {
      const itemId = raiseScreenBlocked(SESSION, deps(), null);
      clearScreenBlocked(SESSION.id, itemId);
      expect(approvalInbox.getForSession(SESSION.id)).toBeUndefined();
      expect(resolved).toContain(`${itemId}:resolved_in_terminal`);

      // An item it did not open (here a newer one) is left alone.
      const newer = raiseScreenBlocked(SESSION, deps(), null);
      clearScreenBlocked(SESSION.id, itemId);
      expect(approvalInbox.getForSession(SESSION.id)?.id).toBe(newer);
      clearScreenBlocked(SESSION.id, null);
      expect(approvalInbox.getForSession(SESSION.id)?.id).toBe(newer);
    } finally {
      approvalInbox.onResolved = prev;
    }
  });

  it('raises nothing for a session whose CLI reports blocked through hooks', () => {
    const d = deps();
    expect(raiseScreenBlocked({ ...SESSION, mode: 'claude' }, d, null)).toBeNull();
    expect(d.broadcast).not.toHaveBeenCalled();
    expect(d.sendPushNotifications).not.toHaveBeenCalled();
    expect(approvalInbox.getForSession(SESSION.id)).toBeUndefined();
  });
});
