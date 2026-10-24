/**
 * @fileoverview Agent inbox routes: post, read (optionally long-polling), ack, and an
 * owner-scoped summary of counts. Store semantics live in `agent-inbox.ts`.
 *
 * Who is calling decides what a read or an ack does, so it is resolved here and never
 * taken from the body. `resolveParentSessionId()` reads the `X-Codeman-Parent-Session`
 * header `codeman agent` sends on every request and accepts it only for a live session
 * the caller can see that has the same owner as the receiver (exact id, or a unique
 * prefix of at least 8). Anything else is "no session": a post is from the user, and a
 * read is a peek. What that buys: in multi-user mode a caller cannot name another
 * owner's session (an admin, who can see every session, can act as any session of
 * the receiver's owner, as admins can everywhere else). In single-user mode every
 * local process holds the same credentials, so the header is a hint the client sets
 * about itself.
 *
 * - `POST /api/sessions/:id/inbox` stores a message. `from` is the resolved caller or
 *   null. A full inbox is 409 CONFLICT; the oldest message is never dropped.
 * - `GET /api/sessions/:id/inbox[?wait=ms]` returns every pending message. Only the
 *   receiver's own read marks them seen. With `wait`, it parks while nothing is
 *   UNSEEN (a seen-but-unacked message does not end the wait, or a receiver holding
 *   one would spin).
 * - `POST /api/sessions/:id/inbox/ack` removes messages by id, idempotently, and only
 *   for the receiver itself (403 otherwise).
 * - `GET /api/agent-inbox/summary` reports `pending`, `unseen`, `oldestUnseenAt` and
 *   `parked` per session the caller can see. Counts only, never text, and kept out of
 *   `toState()` so a post does not fan out a `session:updated` to every browser.
 *
 * Nothing here writes to a pane.
 *
 * @module web/routes/inbox-routes
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { InboxAckSchema, InboxPostSchema, InboxReadQuerySchema } from '../schemas.js';
import {
  abortOnClientHangUp,
  canAccessOwned,
  findSessionOrFail,
  getAuthUser,
  ownerFor,
  parseBody,
  resolveParentSessionId,
  waitCapacityResponse,
} from '../route-helpers.js';
import { agentInbox, MAX_INBOX_BYTES, MAX_MESSAGE_BYTES, MAX_MESSAGES_PER_INBOX } from '../agent-inbox.js';
import { sessionWaits, WaitCapacityError, type InboxWaitResult } from '../session-wait-registry.js';
import { clampWaitMs } from '../../config/agent-wait.js';
import type { SessionPort } from '../ports/index.js';

/** Per-session counts the summary route reports. */
export interface InboxSessionSummary {
  pending: number;
  unseen: number;
  oldestUnseenAt: number | null;
  /** The receiver itself is parked on `GET …/inbox?wait=` right now. */
  parked: boolean;
}

export function registerInboxRoutes(app: FastifyInstance, ctx: SessionPort): void {
  /** The resolved caller is the receiving session itself. */
  const callerIsReceiver = (req: Parameters<typeof resolveParentSessionId>[1], id: string, owner?: string) =>
    resolveParentSessionId(ctx, req, undefined, owner) === id;

  app.post('/api/sessions/:id/inbox', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const { text } = parseBody(InboxPostSchema, req.body, 'Invalid inbox message');
    const from = resolveParentSessionId(ctx, req, undefined, session.owner) ?? null;

    const result = agentInbox.post(id, from, text);
    if (!result.ok) {
      switch (result.reason) {
        case 'empty':
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'text must not be empty');
        case 'message-too-large':
          return createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            `Message is larger than ${MAX_MESSAGE_BYTES} bytes (UTF-8). Write it to a file in the workspace and post the path.`
          );
        case 'inbox-full-count':
          return createErrorResponse(
            ApiErrorCode.CONFLICT,
            `Inbox of ${id} is full (${MAX_MESSAGES_PER_INBOX} messages). Nothing was stored; the receiver has to ack before more can be posted.`
          );
        case 'inbox-full-bytes':
          return createErrorResponse(
            ApiErrorCode.CONFLICT,
            `Inbox of ${id} is full (${MAX_INBOX_BYTES} bytes of pending text). Nothing was stored; the receiver has to ack before more can be posted.`
          );
      }
    }
    // After the store, so a parked reader that wakes finds the message.
    sessionWaits.notifyInbox(id);
    return {
      success: true,
      data: { sessionId: id, message: result.message, pending: result.pending, unseen: result.unseen },
    };
  });

  app.get('/api/sessions/:id/inbox', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const query = parseBody(InboxReadQuerySchema, req.query);
    const receiver = callerIsReceiver(req, id, session.owner);
    // A receiver loops on this URL with identical parameters; a cached 200 would turn
    // the loop into a busy spin (same reason as GET …/wait).
    reply.header('Cache-Control', 'no-store');

    let wait: InboxWaitResult | undefined;
    if (query.wait !== undefined) {
      const timeoutMs = clampWaitMs(query.wait);
      if (agentInbox.unseenCount(id) > 0) {
        wait = {
          posted: false,
          timedOut: false,
          immediate: true,
          ended: false,
          aborted: false,
          waitedMs: 0,
          timeoutMs,
        };
      } else {
        const abort = abortOnClientHangUp(reply);
        try {
          wait = await sessionWaits.waitForInbox(id, {
            timeoutMs,
            owner: ownerFor(req),
            abortSignal: abort.signal,
            receiver,
          });
        } catch (err) {
          if (err instanceof WaitCapacityError) return waitCapacityResponse(err);
          throw err;
        }
      }
    }

    // Read AFTER the wait: this is what the caller gets, so it must be current. A wait
    // that ended because the session was deleted reads an empty inbox. A client that
    // hung up never sees this answer, so its read must not mark anything seen.
    const read = agentInbox.read(id, { receiver: receiver && !wait?.aborted });
    return { success: true, data: { sessionId: id, receiver, ...read, ...(wait ? { wait } : {}) } };
  });

  app.post('/api/sessions/:id/inbox/ack', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const { ids } = parseBody(InboxAckSchema, req.body);
    if (!callerIsReceiver(req, id, session.owner)) {
      // A no-op here would let a coordinator believe it cleared a worker's mail, and
      // would hide a client that forgot the header. Refusing says both out loud.
      return createErrorResponse(
        ApiErrorCode.FORBIDDEN,
        `Only ${id} itself can acknowledge its inbox (X-Codeman-Parent-Session must resolve to it). Reading as anyone else is a peek.`
      );
    }
    const removed = agentInbox.ack(id, ids);
    return {
      success: true,
      data: { sessionId: id, removed, pending: agentInbox.pendingCount(id), unseen: agentInbox.unseenCount(id) },
    };
  });

  app.get('/api/agent-inbox/summary', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = getAuthUser(req);
    const counts = agentInbox.summary();
    const sessions: Record<string, InboxSessionSummary> = {};
    for (const session of ctx.sessions.values()) {
      if (!canAccessOwned(user, session.owner)) continue;
      const c = counts.get(session.id);
      const parked = sessionWaits.inboxWaiterCount(session.id, true) > 0;
      if (!c && !parked) continue;
      sessions[session.id] = {
        pending: c?.pending ?? 0,
        unseen: c?.unseen ?? 0,
        oldestUnseenAt: c?.oldestUnseenAt ?? null,
        parked,
      };
    }
    return { success: true, data: { sessions } };
  });
}
