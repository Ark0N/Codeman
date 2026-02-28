/**
 * @fileoverview Hook event route.
 * Receives Claude Code hook events and broadcasts to SSE clients.
 * This endpoint bypasses auth (Claude Code hooks curl from localhost).
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { HookEventSchema, isValidWorkingDir } from '../schemas.js';
import { sanitizeHookData } from '../route-helpers.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';

export function registerHookEventRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort
): void {
  app.post('/api/hook-event', async (req) => {
    const result = HookEventSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { event, sessionId, data } = result.data;
    if (!ctx.sessions.has(sessionId)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // Signal the respawn controller based on hook event type
    const controller = ctx.respawnControllers.get(sessionId);
    if (controller) {
      if (event === 'elicitation_dialog') {
        // Block auto-accept for question prompts
        controller.signalElicitation();
      } else if (event === 'stop') {
        // DEFINITIVE idle signal - Claude finished responding
        controller.signalStopHook();
      } else if (event === 'idle_prompt') {
        // DEFINITIVE idle signal - Claude has been idle for 60+ seconds
        controller.signalIdlePrompt();
      }
    }

    // Start transcript watching if transcript_path is provided and safe
    if (data && 'transcript_path' in data) {
      const transcriptPath = String(data.transcript_path);
      if (transcriptPath && isValidWorkingDir(transcriptPath)) {
        ctx.startTranscriptWatcher(sessionId, transcriptPath);
      }
    }

    // Sanitize forwarded data: only include known safe fields, limit size
    const safeData = sanitizeHookData(data);
    ctx.broadcast(`hook:${event}`, { sessionId, timestamp: Date.now(), ...safeData });

    // Send push notifications for hook events
    const session = ctx.sessions.get(sessionId);
    const sessionName = session?.name ?? sessionId.slice(0, 8);
    ctx.sendPushNotifications(`hook:${event}`, { sessionId, sessionName, ...safeData });

    // Track in run summary
    const summaryTracker = ctx.runSummaryTrackers.get(sessionId);
    if (summaryTracker) {
      summaryTracker.recordHookEvent(event, safeData);
    }

    return { success: true };
  });
}
