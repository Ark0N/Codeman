/**
 * @fileoverview Tests for push-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerPushRoutes } from '../../src/web/routes/push-routes.js';

describe('push-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerPushRoutes);
    // Push routes expect ctx.pushStore to be a real object (not null)
    harness.ctx.pushStore = {
      getPublicKey: vi.fn(() => 'test-vapid-public-key-base64'),
      addSubscription: vi.fn((record: Record<string, unknown>) => record),
      updatePreferences: vi.fn(() => true),
      removeSubscription: vi.fn(() => true),
    } as never;
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/push/vapid-key ==========

  describe('GET /api/push/vapid-key', () => {
    it('returns the VAPID public key', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/push/vapid-key',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.publicKey).toBe('test-vapid-public-key-base64');
    });
  });

  // ========== POST /api/push/subscribe ==========

  describe('POST /api/push/subscribe', () => {
    it('creates a push subscription', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: {
          endpoint: 'https://push.example.com/send/abc123',
          keys: {
            p256dh: 'test-p256dh-key',
            auth: 'test-auth-key',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBeDefined();
      expect(harness.ctx.pushStore.addSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://push.example.com/send/abc123',
          keys: { p256dh: 'test-p256dh-key', auth: 'test-auth-key' },
        }),
      );
    });

    it('accepts optional userAgent and pushPreferences', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: {
          endpoint: 'https://push.example.com/send/abc123',
          keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
          userAgent: 'TestBrowser/1.0',
          pushPreferences: { 'session:idle': true, 'session:error': false },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.pushStore.addSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'TestBrowser/1.0',
          pushPreferences: { 'session:idle': true, 'session:error': false },
        }),
      );
    });

    it('rejects invalid subscription (missing endpoint)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: {
          keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects invalid subscription (missing keys)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: {
          endpoint: 'https://push.example.com/send/abc123',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PUT /api/push/subscribe/:id ==========

  describe('PUT /api/push/subscribe/:id', () => {
    it('updates push preferences for a subscription', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/push/subscribe/sub-123',
        payload: {
          pushPreferences: { 'session:idle': true, 'session:error': true },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.pushStore.updatePreferences).toHaveBeenCalledWith('sub-123', {
        'session:idle': true,
        'session:error': true,
      });
    });

    it('returns 404 for unknown subscription', async () => {
      (harness.ctx.pushStore.updatePreferences as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/push/subscribe/nonexistent',
        payload: {
          pushPreferences: { 'session:idle': true },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('rejects invalid body (missing pushPreferences)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/push/subscribe/sub-123',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== DELETE /api/push/subscribe/:id ==========

  describe('DELETE /api/push/subscribe/:id', () => {
    it('removes a push subscription', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/push/subscribe/sub-123',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.pushStore.removeSubscription).toHaveBeenCalledWith('sub-123');
    });

    it('returns 404 for unknown subscription', async () => {
      (harness.ctx.pushStore.removeSubscription as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/push/subscribe/nonexistent',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });
});
