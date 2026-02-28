/**
 * @fileoverview Push notification routes.
 * Manages VAPID keys, push subscriptions, and preference updates.
 */

import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { PushSubscribeSchema, PushPreferencesUpdateSchema } from '../schemas.js';
import type { InfraPort } from '../ports/index.js';

export function registerPushRoutes(app: FastifyInstance, ctx: InfraPort): void {
  app.get('/api/push/vapid-key', async () => {
    return { success: true, data: { publicKey: ctx.pushStore.getPublicKey() } };
  });

  app.post('/api/push/subscribe', async (req) => {
    const result = PushSubscribeSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { endpoint, keys, userAgent, pushPreferences } = result.data;
    const record = ctx.pushStore.addSubscription({
      id: uuidv4(),
      endpoint,
      keys,
      userAgent: userAgent ?? req.headers['user-agent'] ?? '',
      createdAt: Date.now(),
      pushPreferences: pushPreferences ?? {},
    });
    return { success: true, data: { id: record.id } };
  });

  app.put('/api/push/subscribe/:id', async (req) => {
    const { id } = req.params as { id: string };
    const result = PushPreferencesUpdateSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const updated = ctx.pushStore.updatePreferences(id, result.data.pushPreferences);
    if (!updated) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found');
    }
    return { success: true };
  });

  app.delete('/api/push/subscribe/:id', async (req) => {
    const { id } = req.params as { id: string };
    const removed = ctx.pushStore.removeSubscription(id);
    if (!removed) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found');
    }
    return { success: true };
  });
}
