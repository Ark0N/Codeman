/**
 * @fileoverview Tests for scheduled-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerScheduledRoutes } from '../../src/web/routes/scheduled-routes.js';

describe('scheduled-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerScheduledRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/scheduled ==========

  describe('GET /api/scheduled', () => {
    it('returns empty array when no scheduled runs exist', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/scheduled',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual([]);
    });

    it('returns all scheduled runs', async () => {
      const run1 = {
        id: 'run-1',
        prompt: 'test prompt 1',
        workingDir: '/tmp/test',
        durationMinutes: 60,
        startedAt: Date.now(),
        endAt: Date.now() + 3600000,
        status: 'running' as const,
        sessionId: null,
        completedTasks: 0,
        totalCost: 0,
        logs: [],
      };
      const run2 = {
        id: 'run-2',
        prompt: 'test prompt 2',
        workingDir: '/tmp/test2',
        durationMinutes: 120,
        startedAt: Date.now(),
        endAt: Date.now() + 7200000,
        status: 'completed' as const,
        sessionId: 'sess-1',
        completedTasks: 5,
        totalCost: 1.5,
        logs: ['started'],
      };
      harness.ctx.scheduledRuns.set('run-1', run1);
      harness.ctx.scheduledRuns.set('run-2', run2);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/scheduled',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(2);
    });
  });

  // ========== POST /api/scheduled ==========

  describe('POST /api/scheduled', () => {
    it('creates a scheduled run with valid input', async () => {
      const mockRun = {
        id: 'new-run',
        prompt: 'do something',
        workingDir: '/tmp',
        durationMinutes: 60,
        startedAt: Date.now(),
        endAt: Date.now() + 3600000,
        status: 'running' as const,
        sessionId: null,
        completedTasks: 0,
        totalCost: 0,
        logs: [],
      };
      harness.ctx.startScheduledRun = vi.fn(async () => mockRun);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/scheduled',
        payload: {
          prompt: 'do something',
          durationMinutes: 60,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.run.id).toBe('new-run');
    });

    it('rejects empty prompt', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/scheduled',
        payload: {
          prompt: '',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing prompt', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/scheduled',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects invalid workingDir with shell metacharacters', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/scheduled',
        payload: {
          prompt: 'test prompt',
          workingDir: '/tmp/test;rm -rf /',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('accepts optional durationMinutes', async () => {
      const mockRun = {
        id: 'run-default-duration',
        prompt: 'test',
        workingDir: process.cwd(),
        durationMinutes: 60,
        startedAt: Date.now(),
        endAt: Date.now() + 3600000,
        status: 'running' as const,
        sessionId: null,
        completedTasks: 0,
        totalCost: 0,
        logs: [],
      };
      harness.ctx.startScheduledRun = vi.fn(async () => mockRun);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/scheduled',
        payload: {
          prompt: 'test',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      // Should default to 60 minutes
      expect(harness.ctx.startScheduledRun).toHaveBeenCalledWith(
        'test',
        expect.any(String),
        60,
      );
    });
  });

  // ========== DELETE /api/scheduled/:id ==========

  describe('DELETE /api/scheduled/:id', () => {
    it('deletes an existing scheduled run', async () => {
      const run = {
        id: 'run-to-delete',
        prompt: 'test',
        workingDir: '/tmp',
        durationMinutes: 60,
        startedAt: Date.now(),
        endAt: Date.now() + 3600000,
        status: 'running' as const,
        sessionId: null,
        completedTasks: 0,
        totalCost: 0,
        logs: [],
      };
      harness.ctx.scheduledRuns.set('run-to-delete', run);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/scheduled/run-to-delete',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.stopScheduledRun).toHaveBeenCalledWith('run-to-delete');
    });

    it('returns error for nonexistent scheduled run', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/scheduled/nonexistent',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });
  });

  // ========== GET /api/scheduled/:id ==========

  describe('GET /api/scheduled/:id', () => {
    it('returns an existing scheduled run', async () => {
      const run = {
        id: 'run-1',
        prompt: 'test prompt',
        workingDir: '/tmp/test',
        durationMinutes: 60,
        startedAt: Date.now(),
        endAt: Date.now() + 3600000,
        status: 'running' as const,
        sessionId: null,
        completedTasks: 0,
        totalCost: 0,
        logs: [],
      };
      harness.ctx.scheduledRuns.set('run-1', run);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/scheduled/run-1',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('run-1');
      expect(body.prompt).toBe('test prompt');
    });

    it('returns error for nonexistent scheduled run', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/scheduled/nonexistent',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });
  });
});
