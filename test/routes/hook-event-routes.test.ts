/**
 * @fileoverview Tests for hook-event-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * These tests assert the UNIFORM response envelope (stable HTTP contract):
 *   success -> 2xx, { success: true, data: <payload> }
 *   error   -> 4xx/5xx, { success: false, error, errorCode }
 * The production server applies this via a preSerialization hook (server.ts).
 * The shared route harness doesn't install it, so we build a local harness here
 * that mirrors production: the same preSerialization envelope hook + the shared
 * route error handler, so assertions match the real wire format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { approvalInbox } from '../../src/web/approval-inbox.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerHookEventRoutes } from '../../src/web/routes/hook-event-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Build a Fastify instance that mirrors production's uniform-envelope behavior
 * (server.ts preSerialization hook) so the test wire format matches the contract:
 * bare payloads become { success: true, data }, and { success:false } error
 * envelopes get the conventional HTTP status from their errorCode.
 */
async function createEnvelopeHarness(
  registerFn: (app: FastifyInstance, ctx: MockRouteContext) => void
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

  // Mirror production uniform response envelope (server.ts).
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}

describe('hook-event-routes', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    harness = await createEnvelopeHarness(registerHookEventRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== POST /api/hook-event ==========

  describe('POST /api/hook-event', () => {
    it('accepts a valid hook event and broadcasts it', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'hook:stop',
        expect.objectContaining({ sessionId: harness.ctx._sessionId })
      );
    });

    /**
     * The prompt-cache keep-warm's own turn (prompt-cache-keepwarm.ts) ends with the same stop
     * hook and idle prompt as a real one. While the session marks the turn as its keep-alive,
     * both open pre-acknowledged: the broadcast says why, and nothing is pushed.
     */
    it('opens the stop and idle prompt of a keep-alive turn pre-acknowledged and pushes nothing', async () => {
      harness.ctx._session.keepAliveTurnActive = true;
      for (const event of ['stop', 'idle_prompt']) {
        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/hook-event',
          payload: { event, sessionId: harness.ctx._sessionId, data: null },
        });
        expect(res.statusCode).toBe(200);
        expect(harness.ctx.broadcast).toHaveBeenCalledWith(
          `hook:${event}`,
          expect.objectContaining({ sessionId: harness.ctx._sessionId, acknowledgedReason: 'cache keep-alive' })
        );
      }
      expect(harness.ctx.sendPushNotifications).not.toHaveBeenCalled();
      // The inbox item is what a reload seeds tab alerts from, so it must open acknowledged too.
      const item = approvalInbox.getForSession(harness.ctx._sessionId);
      approvalInbox.resolveForSession(harness.ctx._sessionId, 'dismissed');
      expect(item?.acknowledgedReason).toBe('cache keep-alive');
      // acknowledgedAt is what approvals-ui.js reads to skip the alert on a reload.
      expect(item?.acknowledgedAt).toBe(item?.createdAt);
    });

    it('sends push notifications for hook events', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'idle_prompt',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.sendPushNotifications).toHaveBeenCalledWith(
        'hook:idle_prompt',
        expect.objectContaining({ sessionId: harness.ctx._sessionId })
      );
    });

    /**
     * The pane's live conversation id, reported by the CLI process itself. This
     * is what lets the response viewer stop guessing from ~/.claude/history.jsonl
     * — a guess that could never run at all for a pane the user drives by
     * attaching to tmux, because `lastSubmitAt` only ever saw Codeman's own
     * write path.
     */
    it('adopts the conversation id first-hand from a prompt_submitted hook', async () => {
      const session = harness.ctx._session;
      const before = session.lastSubmitAt;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'prompt_submitted',
          sessionId: harness.ctx._sessionId,
          data: { hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', source: 'user' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(session.claudeSessionId).toBe('conv-1');
      expect(session.claudeSessionIdIsFirstHand).toBe(true);
      expect(session.claudeSessionChain).toEqual(['conv-1']);
      expect(session.lastSubmitAt).toBeGreaterThan(before);
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
    });

    /**
     * The hook's prompt text is what tells a person typing in an attached tmux client apart
     * from the prompt-cache keep-alive (Session.markPromptSubmitted ends the keep-alive window
     * for anything but the nudge), so the route must hand it over, and nothing else.
     */
    it("hands the prompt_submitted hook's prompt text to the session", async () => {
      const session = harness.ctx._session;
      for (const data of [
        { session_id: 'conv-1', prompt: 'fix the login bug' },
        { session_id: 'conv-1', prompt: 42 },
        { session_id: 'conv-1' },
      ]) {
        await harness.app.inject({
          method: 'POST',
          url: '/api/hook-event',
          payload: { event: 'prompt_submitted', sessionId: harness.ctx._sessionId, data },
        });
      }
      expect(session.submittedPrompts).toEqual(['fix the login bug', undefined, undefined]);
    });

    it('records a /clear successor in the chain and persists it, without duplicating a repeat', async () => {
      const session = harness.ctx._session;
      const submit = async (conversationId: string) =>
        harness.app.inject({
          method: 'POST',
          url: '/api/hook-event',
          payload: {
            event: 'prompt_submitted',
            sessionId: harness.ctx._sessionId,
            data: { hook_event_name: 'UserPromptSubmit', session_id: conversationId },
          },
        });

      await submit('conv-1');
      await submit('conv-1'); // every prompt in a conversation reports the same id
      await submit('conv-2'); // the user ran /clear

      expect(session.claudeSessionChain).toEqual(['conv-1', 'conv-2']);
      expect(session.claudeSessionId).toBe('conv-2');
      // `/clear` emits no completion event, so the successor is lost on restart
      // unless the hook itself persists it.
      expect(harness.ctx.persistSessionState).toHaveBeenCalledTimes(2);
    });

    it('does not leak the prompt text into the broadcast', async () => {
      await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'prompt_submitted',
          sessionId: harness.ctx._sessionId,
          data: { hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', prompt: 'my secret prompt' },
        },
      });

      const broadcast = JSON.stringify(harness.ctx.broadcast.mock.calls);
      expect(broadcast).not.toContain('my secret prompt');
      expect(broadcast).toContain('conv-1');
    });

    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: 'nonexistent-session',
          data: null,
        },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it('rejects invalid event type', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'invalid_event_type',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing sessionId', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('signals respawn controller on stop event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalStopHook).toHaveBeenCalled();
    });

    it('signals respawn controller on elicitation_dialog event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'elicitation_dialog',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalElicitation).toHaveBeenCalled();
    });

    it('signals respawn controller on idle_prompt event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'idle_prompt',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalIdlePrompt).toHaveBeenCalled();
    });

    it('records hook event in run summary tracker', async () => {
      const mockTracker = { recordHookEvent: vi.fn() };
      harness.ctx.runSummaryTrackers.set(harness.ctx._sessionId, mockTracker as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: { tool_name: 'bash' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockTracker.recordHookEvent).toHaveBeenCalledWith('stop', expect.any(Object));
    });

    it('starts transcript watcher when transcript_path is provided', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: { transcript_path: '/home/user/.claude/transcript.jsonl' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.startTranscriptWatcher).toHaveBeenCalledWith(
        harness.ctx._sessionId,
        '/home/user/.claude/transcript.jsonl'
      );
    });

    it('accepts valid data payload with extra fields', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'permission_prompt',
          sessionId: harness.ctx._sessionId,
          data: { tool_name: 'bash', command: 'ls -la' },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });
});
