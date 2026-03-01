/**
 * @fileoverview Tests for respawn route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerRespawnRoutes } from '../../src/web/routes/respawn-routes.js';

describe('respawn-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerRespawnRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/sessions/:id/respawn ==========

  describe('GET /api/sessions/:id/respawn', () => {
    it('returns disabled status when no controller exists', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(false);
      expect(body.status).toBeNull();
    });

    it('returns status when controller exists', async () => {
      const mockController = {
        getStatus: vi.fn(() => ({
          state: 'watching',
          health: 100,
          cycleCount: 0,
        })),
        getConfig: vi.fn(() => ({})),
        start: vi.fn(),
        stop: vi.fn(),
        updateConfig: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(true);
      expect(body.state).toBe('watching');
    });
  });

  // ========== GET /api/sessions/:id/respawn/config ==========

  describe('GET /api/sessions/:id/respawn/config', () => {
    it('returns null config when no controller and no pre-saved config', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.config).toBeNull();
      expect(body.active).toBe(false);
    });

    it('returns active config when controller exists', async () => {
      const mockConfig = { idleTimeoutMs: 5000, enabled: true };
      const mockController = {
        getConfig: vi.fn(() => mockConfig),
        getStatus: vi.fn(() => ({})),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.active).toBe(true);
      expect(body.config.idleTimeoutMs).toBe(5000);
    });
  });

  // ========== POST /api/sessions/:id/respawn/stop ==========

  describe('POST /api/sessions/:id/respawn/stop', () => {
    it('returns error when no controller exists', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/stop`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('stops existing controller and cleans up', async () => {
      const mockController = {
        stop: vi.fn(),
        getConfig: vi.fn(() => ({})),
        getStatus: vi.fn(() => ({})),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/stop`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockController.stop).toHaveBeenCalled();
      expect(harness.ctx.respawnControllers.has(harness.ctx._sessionId)).toBe(false);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('respawn:stopped', {
        sessionId: harness.ctx._sessionId,
      });
    });
  });

  // ========== POST /api/sessions/:id/respawn/start ==========

  describe('POST /api/sessions/:id/respawn/start', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/respawn/start',
      });
      // findSessionOrFail throws with statusCode 404
      expect(res.statusCode).toBe(404);
    });

    it('rejects opencode sessions', async () => {
      harness.ctx._session.mode = 'opencode';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/start`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PUT /api/sessions/:id/respawn/config ==========

  describe('PUT /api/sessions/:id/respawn/config', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/sessions/nonexistent/respawn/config',
        payload: { idleTimeoutMs: 5000 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects invalid config', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
        payload: { idleTimeoutMs: 'not-a-number' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('updates running controller config', async () => {
      const mockController = {
        updateConfig: vi.fn(),
        getConfig: vi.fn(() => ({ idleTimeoutMs: 5000 })),
        getStatus: vi.fn(() => ({})),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
        payload: { idleTimeoutMs: 5000 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockController.updateConfig).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'respawn:configUpdated',
        expect.objectContaining({ sessionId: harness.ctx._sessionId }),
      );
    });

    it('saves pre-config when no controller running', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/respawn/config`,
        payload: { idleTimeoutMs: 5000 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.mux.updateRespawnConfig).toHaveBeenCalled();
    });
  });

  // ========== POST /api/sessions/:id/respawn/enable ==========

  describe('POST /api/sessions/:id/respawn/enable', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/respawn/enable',
      });
      // findSessionOrFail not used here — let's check the actual response
      expect(res.statusCode).toBe(404);
    });
  });
});
