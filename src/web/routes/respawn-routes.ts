/**
 * @fileoverview Respawn management routes.
 * Provides respawn status, config CRUD, start/stop, interactive-respawn, and enable/disable.
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type PersistedRespawnConfig } from '../../types.js';
import { RespawnController, type RespawnConfig } from '../../respawn-controller.js';
import { RespawnConfigSchema, InteractiveRespawnSchema, RespawnEnableSchema } from '../schemas.js';
import { findSessionOrFail, autoConfigureRalph } from '../route-helpers.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';

/** No-op EventPort used to suppress broadcasts during pre-start ralph configuration. */
const noopEventPort: EventPort = {
  broadcast: () => {},
  sendPushNotifications: () => {},
  batchTerminalData: () => {},
  broadcastSessionStateDebounced: () => {},
  batchTaskUpdate: () => {},
};

export function registerRespawnRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort
): void {
  // Get respawn status for a session
  app.get('/api/sessions/:id/respawn', async (req) => {
    const { id } = req.params as { id: string };
    const controller = ctx.respawnControllers.get(id);

    if (!controller) {
      return { enabled: false, status: null };
    }

    return {
      enabled: true,
      ...controller.getStatus(),
    };
  });

  // Get respawn config (from running controller or pre-saved)
  app.get('/api/sessions/:id/respawn/config', async (req) => {
    const { id } = req.params as { id: string };
    const controller = ctx.respawnControllers.get(id);

    if (controller) {
      return { success: true, config: controller.getConfig(), active: true };
    }

    // Return pre-saved config from mux-sessions.json
    const preConfig = ctx.mux.getSession(id)?.respawnConfig;
    if (preConfig) {
      return { success: true, config: preConfig, active: false };
    }

    return { success: true, config: null, active: false };
  });

  // Start respawn controller for a session
  app.post('/api/sessions/:id/respawn/start', async (req) => {
    const { id } = req.params as { id: string };
    let body: Partial<RespawnConfig> | undefined;
    if (req.body) {
      const result = RespawnConfigSchema.safeParse(req.body);
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid respawn config');
      }
      body = result.data as Partial<RespawnConfig>;
    }
    const session = findSessionOrFail(ctx, id);

    // Respawn is not supported for opencode sessions
    if (session.mode === 'opencode') {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Respawn is not supported for opencode sessions');
    }

    // Create or get existing controller
    let controller = ctx.respawnControllers.get(id);
    if (!controller) {
      // Merge request body with pre-saved config from mux-sessions.json
      const preConfig = ctx.mux.getSession(id)?.respawnConfig;
      const config = body || preConfig ? { ...preConfig, ...body } : undefined;
      controller = new RespawnController(session, config);
      ctx.respawnControllers.set(id, controller);
      ctx.setupRespawnListeners(id, controller);
    } else if (body) {
      controller.updateConfig(body);
    }

    controller.start();

    // Persist respawn config to mux session and state.json
    ctx.saveRespawnConfig(id, controller.getConfig());
    ctx.persistSessionState(session);

    ctx.broadcast('respawn:started', { sessionId: id, status: controller.getStatus() });

    return { success: true, status: controller.getStatus() };
  });

  // Stop respawn controller for a session
  app.post('/api/sessions/:id/respawn/stop', async (req) => {
    const { id } = req.params as { id: string };
    const controller = ctx.respawnControllers.get(id);

    if (!controller) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Respawn controller not found');
    }

    controller.stop();

    // Remove controller from map so persistSessionState doesn't save respawnEnabled: true
    ctx.respawnControllers.delete(id);

    // Clear any timed respawn
    const timerInfo = ctx.respawnTimers.get(id);
    if (timerInfo) {
      clearTimeout(timerInfo.timer);
      ctx.respawnTimers.delete(id);
    }

    // Clear persisted respawn config
    ctx.mux.clearRespawnConfig(id);

    // Update state.json (respawnConfig removed)
    const session = ctx.sessions.get(id);
    if (session) {
      ctx.persistSessionState(session);
    }

    ctx.broadcast('respawn:stopped', { sessionId: id });

    return { success: true };
  });

  // Update respawn configuration (works with or without running controller)
  app.put('/api/sessions/:id/respawn/config', async (req) => {
    const { id } = req.params as { id: string };
    // Validate respawn config to prevent arbitrary field injection
    const parseResult = RespawnConfigSchema.safeParse(req.body);
    if (!parseResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Invalid respawn config: ${parseResult.error.message}`);
    }
    const config = parseResult.data as Partial<RespawnConfig>;
    const session = findSessionOrFail(ctx, id);

    const controller = ctx.respawnControllers.get(id);

    if (controller) {
      // Update running controller
      controller.updateConfig(config);
      ctx.saveRespawnConfig(id, controller.getConfig());
      ctx.persistSessionState(session);
      ctx.broadcast('respawn:configUpdated', { sessionId: id, config: controller.getConfig() });
      return { success: true, config: controller.getConfig() };
    }

    // No controller running - save as pre-config for when respawn starts
    const existing = ctx.mux.getSession(id);
    const currentConfig = existing?.respawnConfig;
    const merged: PersistedRespawnConfig = {
      enabled: config.enabled ?? currentConfig?.enabled ?? false,
      idleTimeoutMs: config.idleTimeoutMs ?? currentConfig?.idleTimeoutMs ?? 10000,
      updatePrompt: config.updatePrompt ?? currentConfig?.updatePrompt ?? 'update all the docs and CLAUDE.md',
      interStepDelayMs: config.interStepDelayMs ?? currentConfig?.interStepDelayMs ?? 1000,
      sendClear: config.sendClear ?? currentConfig?.sendClear ?? true,
      sendInit: config.sendInit ?? currentConfig?.sendInit ?? true,
      kickstartPrompt: config.kickstartPrompt ?? currentConfig?.kickstartPrompt,
      autoAcceptPrompts: config.autoAcceptPrompts ?? currentConfig?.autoAcceptPrompts ?? true,
      autoAcceptDelayMs: config.autoAcceptDelayMs ?? currentConfig?.autoAcceptDelayMs ?? 8000,
      aiIdleCheckEnabled: config.aiIdleCheckEnabled ?? currentConfig?.aiIdleCheckEnabled ?? true,
      aiIdleCheckModel: config.aiIdleCheckModel ?? currentConfig?.aiIdleCheckModel ?? 'claude-opus-4-5-20251101',
      aiIdleCheckMaxContext: config.aiIdleCheckMaxContext ?? currentConfig?.aiIdleCheckMaxContext ?? 16000,
      aiIdleCheckTimeoutMs: config.aiIdleCheckTimeoutMs ?? currentConfig?.aiIdleCheckTimeoutMs ?? 90000,
      aiIdleCheckCooldownMs: config.aiIdleCheckCooldownMs ?? currentConfig?.aiIdleCheckCooldownMs ?? 180000,
      aiPlanCheckEnabled: config.aiPlanCheckEnabled ?? currentConfig?.aiPlanCheckEnabled ?? true,
      aiPlanCheckModel: config.aiPlanCheckModel ?? currentConfig?.aiPlanCheckModel ?? 'claude-opus-4-5-20251101',
      aiPlanCheckMaxContext: config.aiPlanCheckMaxContext ?? currentConfig?.aiPlanCheckMaxContext ?? 8000,
      aiPlanCheckTimeoutMs: config.aiPlanCheckTimeoutMs ?? currentConfig?.aiPlanCheckTimeoutMs ?? 60000,
      aiPlanCheckCooldownMs: config.aiPlanCheckCooldownMs ?? currentConfig?.aiPlanCheckCooldownMs ?? 30000,
      durationMinutes: currentConfig?.durationMinutes,
    };
    ctx.mux.updateRespawnConfig(id, merged);
    ctx.persistSessionState(session);
    ctx.broadcast('respawn:configUpdated', { sessionId: id, config: merged });
    return { success: true, config: merged };
  });

  // Start interactive session WITH respawn enabled
  app.post('/api/sessions/:id/interactive-respawn', async (req) => {
    const { id } = req.params as { id: string };
    const irResult = req.body ? InteractiveRespawnSchema.safeParse(req.body) : { success: true as const, data: {} };
    if (!irResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = irResult.data as {
      respawnConfig?: Partial<RespawnConfig>;
      durationMinutes?: number;
    };
    const session = findSessionOrFail(ctx, id);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    // Respawn is not supported for opencode sessions
    if (session.mode === 'opencode') {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Respawn is not supported for opencode sessions');
    }

    try {
      // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
      if (ctx.store.getConfig().ralphEnabled && !session.ralphTracker.autoEnableDisabled) {
        autoConfigureRalph(session, session.workingDir, noopEventPort);
        if (!session.ralphTracker.enabled) {
          session.ralphTracker.enable();
        }
      }

      // Start interactive session
      await session.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: session.mode,
        reason: 'interactive_respawn',
      });
      ctx.broadcast('session:interactive', { id });
      ctx.broadcast('session:updated', { session: ctx.getSessionStateWithRespawn(session) });

      // Create and start respawn controller
      const controller = new RespawnController(session, body?.respawnConfig);
      ctx.respawnControllers.set(id, controller);
      ctx.setupRespawnListeners(id, controller);
      controller.start();

      // Set up timed stop if duration specified
      if (body?.durationMinutes && body.durationMinutes > 0) {
        ctx.setupTimedRespawn(id, body.durationMinutes);
      }

      // Persist full session state with respawn config
      ctx.persistSessionState(session);

      ctx.broadcast('respawn:started', { sessionId: id, status: controller.getStatus() });

      return {
        success: true,
        data: {
          message: 'Interactive session with respawn started',
          respawnStatus: controller.getStatus(),
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // Enable respawn on an EXISTING interactive session
  app.post('/api/sessions/:id/respawn/enable', async (req) => {
    const { id } = req.params as { id: string };
    const reResult = req.body ? RespawnEnableSchema.safeParse(req.body) : { success: true as const, data: {} };
    if (!reResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = reResult.data as { config?: Partial<RespawnConfig>; durationMinutes?: number };
    const session = findSessionOrFail(ctx, id);

    // Respawn is not supported for opencode sessions
    if (session.mode === 'opencode') {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Respawn is not supported for opencode sessions');
    }

    // Check if session is running (has a PID)
    if (!session.pid) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Session is not running. Start it first.');
    }

    // Stop existing controller if any
    const existingController = ctx.respawnControllers.get(id);
    if (existingController) {
      existingController.stop();
    }

    // Create and start new respawn controller (merge with pre-saved config)
    const preConfig = ctx.mux.getSession(id)?.respawnConfig;
    const config = body?.config || preConfig ? { ...preConfig, ...body?.config } : undefined;
    const controller = new RespawnController(session, config);
    ctx.respawnControllers.set(id, controller);
    ctx.setupRespawnListeners(id, controller);
    controller.start();

    // Set up timed stop if duration specified
    if (body?.durationMinutes && body.durationMinutes > 0) {
      ctx.setupTimedRespawn(id, body.durationMinutes);
    }

    // Persist respawn config to mux session and state.json
    ctx.saveRespawnConfig(id, controller.getConfig(), body?.durationMinutes);
    ctx.persistSessionState(session);

    ctx.broadcast('respawn:started', { sessionId: id, status: controller.getStatus() });

    return {
      success: true,
      message: 'Respawn enabled on existing session',
      respawnStatus: controller.getStatus(),
    };
  });
}
