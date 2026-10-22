/**
 * @fileoverview Tests for ralph-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerRalphRoutes } from '../../src/web/routes/ralph-routes.js';

/** Create a mock ralph tracker with all methods used by ralph-routes */
function createMockRalphTracker() {
  return {
    enabled: false,
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    fullReset: vi.fn(),
    enableAutoEnable: vi.fn(),
    disableAutoEnable: vi.fn(),
    startLoop: vi.fn(),
    setMaxIterations: vi.fn(),
    setMaxTodos: vi.fn(),
    setTodoExpirationMinutes: vi.fn(),
    resetCircuitBreaker: vi.fn(),
    generateFixPlanMarkdown: vi.fn(() => '# Fix Plan\n\n- [ ] Task 1\n'),
    importFixPlanMarkdown: vi.fn(() => 3),
    lastStatusBlock: null,
    circuitBreakerStatus: { state: 'CLOSED', consecutiveFailures: 0 },
    cumulativeStats: { totalIterations: 0, totalSuccess: 0 },
    exitGateMet: false,
    todos: [
      { id: '1', content: 'Task 1', done: false },
      { id: '2', content: 'Task 2', done: true },
    ],
  };
}

describe('ralph-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerRalphRoutes);
    // Add updateRalphEnabled to mock mux (used by ralph-config route)
    (harness.ctx.mux as Record<string, unknown>).updateRalphEnabled = vi.fn();
    // Set up mock ralph tracker on the session
    (harness.ctx._session as Record<string, unknown>).ralphTracker = createMockRalphTracker();
    (harness.ctx._session as Record<string, unknown>).ralphLoopState = { enabled: false };
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== POST /api/sessions/:id/ralph-config ==========

  describe('POST /api/sessions/:id/ralph-config', () => {
    it('returns success for valid config', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({});
    });

    it('enables ralph tracker', async () => {
      const tracker = (harness.ctx._session as Record<string, unknown>).ralphTracker as ReturnType<
        typeof createMockRalphTracker
      >;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect(tracker.enable).toHaveBeenCalled();
      expect(tracker.enableAutoEnable).toHaveBeenCalled();
    });

    it('disables ralph tracker', async () => {
      const tracker = (harness.ctx._session as Record<string, unknown>).ralphTracker as ReturnType<
        typeof createMockRalphTracker
      >;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(tracker.disable).toHaveBeenCalled();
      expect(tracker.disableAutoEnable).toHaveBeenCalled();
    });

    it('persists ralph enabled state via mux', async () => {
      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { enabled: true },
      });
      expect((harness.ctx.mux as Record<string, unknown>).updateRalphEnabled).toHaveBeenCalledWith(
        harness.ctx._sessionId,
        true
      );
    });

    it('broadcasts ralph loop update', async () => {
      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { enabled: true },
      });
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:ralphLoopUpdate', {
        sessionId: harness.ctx._sessionId,
        state: expect.anything(),
      });
    });

    it('handles reset option', async () => {
      const tracker = (harness.ctx._session as Record<string, unknown>).ralphTracker as ReturnType<
        typeof createMockRalphTracker
      >;

      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { reset: true },
      });
      expect(tracker.reset).toHaveBeenCalled();
    });

    it('configures completion phrase and max iterations', async () => {
      const tracker = (harness.ctx._session as Record<string, unknown>).ralphTracker as ReturnType<
        typeof createMockRalphTracker
      >;

      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { completionPhrase: 'DONE', maxIterations: 10 },
      });
      expect(tracker.startLoop).toHaveBeenCalledWith('DONE', 10);
    });

    it('sets max iterations independently', async () => {
      const tracker = (harness.ctx._session as Record<string, unknown>).ralphTracker as ReturnType<
        typeof createMockRalphTracker
      >;

      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { maxIterations: 50 },
      });
      expect(tracker.setMaxIterations).toHaveBeenCalledWith(50);
    });

    it('applies maxTodos and todoExpirationMinutes to the tracker (COD-52)', async () => {
      const tracker = (harness.ctx._session as Record<string, unknown>).ralphTracker as ReturnType<
        typeof createMockRalphTracker
      >;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { maxTodos: 25, todoExpirationMinutes: 90 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // The ralph-config success path returns a bare {} envelope (matching its
      // sibling config routes); an error would surface as { success: false }.
      expect(body.success).not.toBe(false);
      expect(tracker.setMaxTodos).toHaveBeenCalledWith(25);
      expect(tracker.setTodoExpirationMinutes).toHaveBeenCalledWith(90);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/ralph-config',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects opencode sessions', async () => {
      harness.ctx._session.mode = 'opencode';

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects invalid request body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { enabled: 'not-boolean' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('handles disableAutoEnable flag', async () => {
      const tracker = (harness.ctx._session as Record<string, unknown>).ralphTracker as ReturnType<
        typeof createMockRalphTracker
      >;

      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { disableAutoEnable: true },
      });
      expect(tracker.disableAutoEnable).toHaveBeenCalled();
    });

    it('persists session state after config change', async () => {
      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-config`,
        payload: { enabled: true },
      });
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
    });
  });

  // ========== POST /api/sessions/:id/ralph-circuit-breaker/reset ==========

  describe('POST /api/sessions/:id/ralph-circuit-breaker/reset', () => {
    it('resets circuit breaker for valid session', async () => {
      const tracker = (harness.ctx._session as Record<string, unknown>).ralphTracker as ReturnType<
        typeof createMockRalphTracker
      >;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-circuit-breaker/reset`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({});
      expect(tracker.resetCircuitBreaker).toHaveBeenCalled();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/ralph-circuit-breaker/reset',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/ralph-status ==========

  describe('GET /api/sessions/:id/ralph-status', () => {
    it('returns ralph status data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-status`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.circuitBreaker).toBeDefined();
      expect(body.data.cumulativeStats).toBeDefined();
      expect(body.data.exitGateMet).toBe(false);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/ralph-status',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/fix-plan ==========

  describe('GET /api/sessions/:id/fix-plan', () => {
    it('returns generated fix plan markdown', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/fix-plan`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toContain('# Fix Plan');
      expect(body.data.todoCount).toBe(2);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/fix-plan',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/fix-plan/import ==========

  describe('POST /api/sessions/:id/fix-plan/import', () => {
    it('imports fix plan content', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/fix-plan/import`,
        payload: { content: '# Plan\n\n- [ ] Task A\n- [ ] Task B\n' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.importedCount).toBe(3);
    });

    it('persists session state after import', async () => {
      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/fix-plan/import`,
        payload: { content: '- [ ] Task' },
      });
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/fix-plan/import',
        payload: { content: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing content field', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/fix-plan/import`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/ralph-prompt/write ==========

  describe('POST /api/sessions/:id/ralph-prompt/write', () => {
    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/ralph-prompt/write',
        payload: { content: 'test prompt' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error when session has no working directory', async () => {
      harness.ctx._session.workingDir = '';

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-prompt/write`,
        payload: { content: 'test prompt' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing content field', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-prompt/write`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/fix-plan/write ==========

  describe('POST /api/sessions/:id/fix-plan/write', () => {
    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/fix-plan/write',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error when session has no working directory', async () => {
      harness.ctx._session.workingDir = '';

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/fix-plan/write`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/fix-plan/read ==========

  describe('POST /api/sessions/:id/fix-plan/read', () => {
    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/fix-plan/read',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error when session has no working directory', async () => {
      harness.ctx._session.workingDir = '';

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/fix-plan/read`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/ralph-loop/start ==========

  describe('POST /api/ralph-loop/start', () => {
    it('awaits layout insertion and stops lifecycle work when registration rejects', async () => {
      let rejectRegistration!: (error: Error) => void;
      harness.ctx.addSession.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRegistration = reject;
          })
      );

      const pending = harness.app.inject({
        method: 'POST',
        url: '/api/ralph-loop/start',
        payload: { taskDescription: 'test task', completionPhrase: 'DONE', caseName: 'registration-order' },
      });
      await vi.waitFor(() => expect(harness.ctx.addSession).toHaveBeenCalledTimes(1));
      // The case rides the registration, so the session lands in the case's default session group.
      expect(harness.ctx.addSession).toHaveBeenCalledWith(expect.anything(), { caseName: 'registration-order' });
      expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
      expect(harness.ctx.setupSessionListeners).not.toHaveBeenCalled();

      rejectRegistration(new Error('layout capacity exceeded'));
      const response = await pending;
      expect(response.statusCode).toBe(500);
      expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
      expect(harness.ctx.setupSessionListeners).not.toHaveBeenCalled();
      expect(harness.ctx.broadcast).not.toHaveBeenCalledWith('session:created', expect.anything());
    });

    it('rejects invalid request body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/ralph-loop/start',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects when max sessions reached', async () => {
      // Fill up sessions to max
      for (let i = 0; i < 50; i++) {
        harness.ctx.sessions.set(`session-${i}`, {} as never);
      }

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/ralph-loop/start',
        payload: {
          taskDescription: 'test task',
          completionPhrase: 'DONE',
          caseName: 'testcase',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects invalid case name format', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/ralph-loop/start',
        payload: {
          taskDescription: 'test task',
          caseName: '../escape-path',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });
});
