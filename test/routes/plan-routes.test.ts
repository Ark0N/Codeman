/**
 * @fileoverview Tests for plan-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerPlanRoutes } from '../../src/web/routes/plan-routes.js';

describe('plan-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerPlanRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== POST /api/cancel-plan-generation ==========

  describe('POST /api/cancel-plan-generation', () => {
    it('returns not found when orchestratorId does not exist', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cancel-plan-generation',
        payload: { orchestratorId: 'plan-nonexistent' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('cancels a specific orchestrator', async () => {
      const mockOrchestrator = { cancel: vi.fn(async () => {}) };
      harness.ctx.activePlanOrchestrators.set('plan-123', mockOrchestrator as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cancel-plan-generation',
        payload: { orchestratorId: 'plan-123' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.cancelled).toBe('plan-123');
      expect(mockOrchestrator.cancel).toHaveBeenCalled();
      expect(harness.ctx.activePlanOrchestrators.has('plan-123')).toBe(false);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('plan:cancelled', { orchestratorId: 'plan-123' });
    });

    it('cancels all active orchestrators when no id provided', async () => {
      const mock1 = { cancel: vi.fn(async () => {}) };
      const mock2 = { cancel: vi.fn(async () => {}) };
      harness.ctx.activePlanOrchestrators.set('plan-a', mock1 as never);
      harness.ctx.activePlanOrchestrators.set('plan-b', mock2 as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cancel-plan-generation',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.cancelled).toContain('plan-a');
      expect(body.data.cancelled).toContain('plan-b');
      expect(mock1.cancel).toHaveBeenCalled();
      expect(mock2.cancel).toHaveBeenCalled();
      expect(harness.ctx.activePlanOrchestrators.size).toBe(0);
    });

    it('rejects invalid body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cancel-plan-generation',
        payload: { orchestratorId: 12345 }, // should be string
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PATCH /api/sessions/:id/plan/task/:taskId ==========

  describe('PATCH /api/sessions/:id/plan/task/:taskId', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/sessions/nonexistent/plan/task/task-1',
        payload: { status: 'completed' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error when ralph tracker not available', async () => {
      // Default mock session has ralphTracker = null
      const res = await harness.app.inject({
        method: 'PATCH',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/task/task-1`,
        payload: { status: 'completed' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Ralph tracker');
    });

    it('updates a plan task successfully', async () => {
      const mockTask = { id: 'task-1', content: 'Do something', status: 'completed', attempts: 1 };
      harness.ctx._session.ralphTracker = {
        updatePlanTask: vi.fn(() => ({ success: true, task: mockTask })),
      } as never;

      const res = await harness.app.inject({
        method: 'PATCH',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/task/task-1`,
        payload: { status: 'completed' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('task-1');
      expect(body.data.status).toBe('completed');
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'session:planTaskUpdate',
        expect.objectContaining({ sessionId: harness.ctx._sessionId, taskId: 'task-1' }),
      );
    });

    it('returns not found for unknown task id', async () => {
      harness.ctx._session.ralphTracker = {
        updatePlanTask: vi.fn(() => ({ success: false, error: 'Task not found' })),
      } as never;

      const res = await harness.app.inject({
        method: 'PATCH',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/task/nonexistent`,
        payload: { status: 'failed', error: 'Something broke' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('rejects invalid body', async () => {
      harness.ctx._session.ralphTracker = {
        updatePlanTask: vi.fn(),
      } as never;

      const res = await harness.app.inject({
        method: 'PATCH',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/task/task-1`,
        payload: { status: 'invalid_status' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/plan/checkpoint ==========

  describe('POST /api/sessions/:id/plan/checkpoint', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/plan/checkpoint',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error when ralph tracker not available', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/checkpoint`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Ralph tracker');
    });

    it('generates a checkpoint review', async () => {
      const mockCheckpoint = {
        completedCount: 5,
        totalCount: 10,
        failedTasks: [],
        recommendations: ['Continue with P1 tasks'],
      };
      harness.ctx._session.ralphTracker = {
        generateCheckpointReview: vi.fn(() => mockCheckpoint),
      } as never;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/checkpoint`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.completedCount).toBe(5);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'session:planCheckpoint',
        expect.objectContaining({ sessionId: harness.ctx._sessionId }),
      );
    });
  });

  // ========== GET /api/sessions/:id/plan/history ==========

  describe('GET /api/sessions/:id/plan/history', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/plan/history',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error when ralph tracker not available', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/history`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Ralph tracker');
    });

    it('returns plan version history', async () => {
      const mockHistory = [
        { version: 1, timestamp: Date.now() - 60000, itemCount: 10 },
        { version: 2, timestamp: Date.now(), itemCount: 12 },
      ];
      harness.ctx._session.ralphTracker = {
        getPlanHistory: vi.fn(() => mockHistory),
      } as never;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/history`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[1].version).toBe(2);
    });
  });

  // ========== POST /api/sessions/:id/plan/rollback/:version ==========

  describe('POST /api/sessions/:id/plan/rollback/:version', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/plan/rollback/1',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error when ralph tracker not available', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/rollback/1`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Ralph tracker');
    });

    it('rolls back to a previous version', async () => {
      const mockPlan = [
        { id: 'task-1', content: 'Step 1', status: 'pending' },
      ];
      harness.ctx._session.ralphTracker = {
        rollbackToVersion: vi.fn(() => ({ success: true, plan: mockPlan })),
      } as never;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/rollback/1`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'session:planRollback',
        expect.objectContaining({ sessionId: harness.ctx._sessionId, version: 1 }),
      );
    });

    it('returns error for nonexistent version', async () => {
      harness.ctx._session.ralphTracker = {
        rollbackToVersion: vi.fn(() => ({ success: false, error: 'Version not found' })),
      } as never;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/rollback/999`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ========== POST /api/sessions/:id/plan/task ==========

  describe('POST /api/sessions/:id/plan/task', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/plan/task',
        payload: { content: 'New task' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error when ralph tracker not available', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/task`,
        payload: { content: 'New task' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Ralph tracker');
    });

    it('adds a new task to the plan', async () => {
      const addedTask = { id: 'new-1', content: 'New task', status: 'pending', priority: 'P1' };
      harness.ctx._session.ralphTracker = {
        addPlanTask: vi.fn(() => ({ task: addedTask })),
      } as never;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/task`,
        payload: { content: 'New task', priority: 'P1' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('new-1');
      expect(body.data.content).toBe('New task');
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'session:planTaskAdded',
        expect.objectContaining({ sessionId: harness.ctx._sessionId }),
      );
    });

    it('rejects invalid body (missing content)', async () => {
      harness.ctx._session.ralphTracker = {
        addPlanTask: vi.fn(),
      } as never;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/task`,
        payload: { priority: 'P1' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('accepts optional fields', async () => {
      const addedTask = {
        id: 'new-2',
        content: 'Task with deps',
        status: 'pending',
        priority: 'P0',
        dependencies: ['task-1'],
        verificationCriteria: 'Tests pass',
      };
      harness.ctx._session.ralphTracker = {
        addPlanTask: vi.fn(() => ({ task: addedTask })),
      } as never;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/plan/task`,
        payload: {
          content: 'Task with deps',
          priority: 'P0',
          verificationCriteria: 'Tests pass',
          dependencies: ['task-1'],
          insertAfter: 'task-0',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.dependencies).toEqual(['task-1']);
    });
  });
});
