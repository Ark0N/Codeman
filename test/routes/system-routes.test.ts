/**
 * @fileoverview Tests for system route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Note: Some system routes access singleton modules (subagentWatcher, imageWatcher)
 * directly. Those routes are tested lightly here since we can't easily mock singletons
 * without vi.mock(). Focus is on routes that use the port context.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

describe('system-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/status ==========

  describe('GET /api/status', () => {
    it('returns server status', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/status' });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.getLightState).toHaveBeenCalled();
    });
  });

  // ========== GET /api/config ==========

  describe('GET /api/config', () => {
    it('returns config', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.config).toBeDefined();
    });
  });

  // ========== PUT /api/config ==========

  describe('PUT /api/config', () => {
    it('updates config with valid payload', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { maxConcurrentSessions: 10 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.store.setConfig).toHaveBeenCalled();
    });

    it('rejects unknown config fields (strict schema)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { unknownField: 'invalid' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/stats ==========

  describe('GET /api/stats', () => {
    it('returns aggregate stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.stats).toBeDefined();
    });
  });

  // ========== GET /api/token-stats ==========

  describe('GET /api/token-stats', () => {
    it('returns daily and aggregate token stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/token-stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.daily).toBeDefined();
      expect(body.totals).toBeDefined();
    });
  });

  // ========== GET /api/debug/memory ==========

  describe('GET /api/debug/memory', () => {
    it('returns memory and map usage info', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/debug/memory' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memory).toBeDefined();
      expect(body.memory.rssMB).toBeGreaterThan(0);
      expect(body.mapSizes).toBeDefined();
      expect(body.uptime).toBeDefined();
    });
  });

  // ========== GET /api/system/stats ==========

  describe('GET /api/system/stats', () => {
    it('returns CPU and memory stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/system/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('cpu');
      expect(body).toHaveProperty('memory');
    });
  });

  // ========== POST /api/cleanup-state ==========

  describe('POST /api/cleanup-state', () => {
    it('cleans up stale session state', async () => {
      const res = await harness.app.inject({ method: 'POST', url: '/api/cleanup-state' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.cleanedSessions).toBe(0);
      expect(harness.ctx.store.cleanupStaleSessions).toHaveBeenCalled();
    });
  });

  // ========== GET /api/subagents ==========

  describe('GET /api/subagents', () => {
    it('returns subagent list', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });
  });

  // ========== POST /api/auth/revoke ==========

  describe('POST /api/auth/revoke', () => {
    it('returns success even without auth sessions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });
});
