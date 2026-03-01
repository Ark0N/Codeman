/**
 * @fileoverview Tests for hook-event-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerHookEventRoutes } from '../../src/web/routes/hook-event-routes.js';

describe('hook-event-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerHookEventRoutes);
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
        expect.objectContaining({ sessionId: harness.ctx._sessionId }),
      );
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
        expect.objectContaining({ sessionId: harness.ctx._sessionId }),
      );
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
      expect(res.statusCode).toBe(200);
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
      expect(res.statusCode).toBe(200);
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
      expect(res.statusCode).toBe(200);
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
      expect(mockTracker.recordHookEvent).toHaveBeenCalledWith(
        'stop',
        expect.any(Object),
      );
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
        '/home/user/.claude/transcript.jsonl',
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
