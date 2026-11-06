/**
 * @fileoverview Respawn management routes.
 * Provides respawn status, config CRUD, start/stop, interactive-respawn, and enable/disable.
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type PersistedRespawnConfig } from '../../types.js';
import { RespawnController, type RespawnConfig } from '../../respawn-controller.js';
import { RespawnConfigSchema, InteractiveRespawnSchema, RespawnEnableSchema } from '../schemas.js';
import { SseEvent } from '../sse-events.js';
import { findSessionOrFail, autoConfigureRalph, parseBody, canAccessOwned, getAuthUser } from '../route-helpers.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import { isExternalCliMode } from '../../session.js';
import {
  AI_CHECK_MODEL,
  AI_IDLE_CHECK_MAX_CONTEXT,
  AI_PLAN_CHECK_MAX_CONTEXT,
  AI_IDLE_CHECK_TIMEOUT_MS,
  AI_IDLE_CHECK_COOLDOWN_MS,
  AI_PLAN_CHECK_TIMEOUT_MS,
  AI_PLAN_CHECK_COOLDOWN_MS,
} from '../../config/ai-defaults.js';

/** No-op EventPort used to suppress broadcasts during pre-start ralph configuration. */
const noopEventPort: EventPort = {
  broadcast: () => {},
  sendPushNotifications: () => {},
  batchTerminalData: () => {},
  broadcastSessionStateDebounced: () => {},
  batchTaskUpdate: () => {},
  getSseClientCount: () => 0,
};

export function registerRespawnRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort
): void {
  // ═══════════════════════════════════════════════════════════════
  // Respawn Status & Config
  // ═══════════════════════════════════════════════════════════════

  // ========== Get Respawn Status ==========

  app.get('/api/sessions/:id/respawn', async (req) => {
    const { id } = req.params as { id: string };
    const controller = ctx.respawnControllers.get(id);

    // Multi-user: gate on the owner from the same source the data comes from, and
    // return the existing neutral shape (not 404) when foreign so existence isn't
    // leaked. canAccessOwned is allow-all in single-user mode → byte-identical.
    const owner = ctx.sessions.get(id)?.owner ?? ctx.mux.getSession(id)?.owner;
    if (!controller || !canAccessOwned(getAuthUser(req), owner)) {
      return { enabled: false, status: null };
    }

    return {
      enabled: true,
      ...controller.getStatus(),
    };
  });

  // ========== Get Respawn Config ==========

  app.get('/api/sessions/:id/respawn/config', async (req) => {
    const { id } = req.params as { id: string };
    // Multi-user: owner-gate each branch against the source of the data, preserving
    // the neutral {config:null,active:false} shape when foreign (no existence leak).
    // canAccessOwned is allow-all in single-user mode → byte-identical, and this keeps
    // the mux-only pre-config path working (findSessionOrFail would break it).
    const user = getAuthUser(req);
    const controller = ctx.respawnControllers.get(id);

    if (controller && canAccessOwned(user, ctx.sessions.get(id)?.owner)) {
      return { config: controller.getConfig(), active: true };
    }

    // Return pre-saved config from mux-sessions.json
    const mux = ctx.mux.getSession(id);
    if (mux?.respawnConfig && canAccessOwned(user, mux.owner)) {
      return { config: mux.respawnConfig, active: false };
    }

    return { config: null, active: false };
  });

  // ═══════════════════════════════════════════════════════════════
  // Respawn Start & Stop
  // ═══════════════════════════════════════════════════════════════

  // ========== Start Respawn ==========

  app.post('/api/sessions/:id/respawn/start', async (req) => {
    const { id } = req.params as { id: string };
    let body: Partial<RespawnConfig> | undefined;
    if (req.body) {
      body = parseBody(RespawnConfigSchema, req.body, 'Invalid respawn config') as Partial<RespawnConfig>;
    }
    const session = findSessionOrFail(ctx, id, req);

    // ⚠️ Adoption gate, kept SEPARATE from the external-CLI gate above: an adopted
    // session can be `mode: 'claude'` and still be a process we never launched.
    // Everything below drives the pane on the assumption Codeman owns what runs
    // in it — sending `/clear`, killing and relaunching the agent — which against
    // someone else's live session is destructive, not merely unsupported.
    if (session.isAdopted) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'Respawn is not available for adopted sessions: Codeman did not start this agent and must not drive its lifecycle'
      );
    }
    // Respawn is not supported for external-CLI sessions (opencode/codex)
    if (isExternalCliMode(session.mode)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Respawn is not supported for ${session.mode} sessions`);
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

    ctx.broadcast(SseEvent.RespawnStarted, { sessionId: id, status: controller.getStatus() });

    return { status: controller.getStatus() };
  });

  // ========== Stop Respawn ==========

  app.post('/api/sessions/:id/respawn/stop', async (req) => {
    const { id } = req.params as { id: string };
    // Owner-gate before any side effects (matches start/config/enable): a non-owner
    // gets NOT_FOUND and never reaches stop/delete/clearRespawnConfig/persist.
    const session = findSessionOrFail(ctx, id, req);
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
    ctx.persistSessionState(session);

    ctx.broadcast(SseEvent.RespawnStopped, { sessionId: id });

    return {};
  });

  // ========== Update Respawn Config ==========

  app.put('/api/sessions/:id/respawn/config', async (req) => {
    const { id } = req.params as { id: string };
    // Validate respawn config to prevent arbitrary field injection
    const config = parseBody(RespawnConfigSchema, req.body, 'Invalid respawn config') as Partial<RespawnConfig>;
    const session = findSessionOrFail(ctx, id, req);

    const controller = ctx.respawnControllers.get(id);

    if (controller) {
      // Update running controller
      controller.updateConfig(config);
      ctx.saveRespawnConfig(id, controller.getConfig());
      ctx.persistSessionState(session);
      ctx.broadcast(SseEvent.RespawnConfigUpdated, { sessionId: id, config: controller.getConfig() });
      return { config: controller.getConfig() };
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
      aiIdleCheckModel: config.aiIdleCheckModel ?? currentConfig?.aiIdleCheckModel ?? AI_CHECK_MODEL,
      aiIdleCheckMaxContext:
        config.aiIdleCheckMaxContext ?? currentConfig?.aiIdleCheckMaxContext ?? AI_IDLE_CHECK_MAX_CONTEXT,
      aiIdleCheckTimeoutMs:
        config.aiIdleCheckTimeoutMs ?? currentConfig?.aiIdleCheckTimeoutMs ?? AI_IDLE_CHECK_TIMEOUT_MS,
      aiIdleCheckCooldownMs:
        config.aiIdleCheckCooldownMs ?? currentConfig?.aiIdleCheckCooldownMs ?? AI_IDLE_CHECK_COOLDOWN_MS,
      aiPlanCheckEnabled: config.aiPlanCheckEnabled ?? currentConfig?.aiPlanCheckEnabled ?? true,
      aiPlanCheckModel: config.aiPlanCheckModel ?? currentConfig?.aiPlanCheckModel ?? AI_CHECK_MODEL,
      aiPlanCheckMaxContext:
        config.aiPlanCheckMaxContext ?? currentConfig?.aiPlanCheckMaxContext ?? AI_PLAN_CHECK_MAX_CONTEXT,
      aiPlanCheckTimeoutMs:
        config.aiPlanCheckTimeoutMs ?? currentConfig?.aiPlanCheckTimeoutMs ?? AI_PLAN_CHECK_TIMEOUT_MS,
      aiPlanCheckCooldownMs:
        config.aiPlanCheckCooldownMs ?? currentConfig?.aiPlanCheckCooldownMs ?? AI_PLAN_CHECK_COOLDOWN_MS,
      durationMinutes: currentConfig?.durationMinutes,
    };
    ctx.mux.updateRespawnConfig(id, merged);
    ctx.persistSessionState(session);
    ctx.broadcast(SseEvent.RespawnConfigUpdated, { sessionId: id, config: merged });
    return { config: merged };
  });

  // ═══════════════════════════════════════════════════════════════
  // Composite Actions (interactive-respawn, enable on existing)
  // ═══════════════════════════════════════════════════════════════

  // ========== Interactive Respawn (start session + respawn in one call) ==========

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
    const session = findSessionOrFail(ctx, id, req);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    // ⚠️ Adoption gate, kept SEPARATE from the external-CLI gate above: an adopted
    // session can be `mode: 'claude'` and still be a process we never launched.
    // Everything below drives the pane on the assumption Codeman owns what runs
    // in it — sending `/clear`, killing and relaunching the agent — which against
    // someone else's live session is destructive, not merely unsupported.
    if (session.isAdopted) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'Respawn is not available for adopted sessions: Codeman did not start this agent and must not drive its lifecycle'
      );
    }
    // Respawn is not supported for external-CLI sessions (opencode/codex)
    if (isExternalCliMode(session.mode)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Respawn is not supported for ${session.mode} sessions`);
    }

    try {
      // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
      if (ctx.store.getConfig().ralphEnabled && !session.ralphTracker.autoEnableDisabled) {
        autoConfigureRalph(session, session.workingDir, noopEventPort);
        if (!session.ralphTracker.enabled) {
          session.ralphTracker.enable();
        }
      }

      // Re-attach listener wiring if a prior PTY exit detached it (the wiring exit
      // handler removes ALL session listeners; idempotent — no-op while still attached).
      await ctx.setupSessionListeners(session);

      // Start interactive session
      await session.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: session.mode,
        reason: 'interactive_respawn',
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

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

      ctx.broadcast(SseEvent.RespawnStarted, { sessionId: id, status: controller.getStatus() });

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

  // ========== Enable Respawn on Existing Session ==========

  app.post('/api/sessions/:id/respawn/enable', async (req) => {
    const { id } = req.params as { id: string };
    const reResult = req.body ? RespawnEnableSchema.safeParse(req.body) : { success: true as const, data: {} };
    if (!reResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = reResult.data as { config?: Partial<RespawnConfig>; durationMinutes?: number };
    const session = findSessionOrFail(ctx, id, req);

    // ⚠️ Adoption gate, kept SEPARATE from the external-CLI gate above: an adopted
    // session can be `mode: 'claude'` and still be a process we never launched.
    // Everything below drives the pane on the assumption Codeman owns what runs
    // in it — sending `/clear`, killing and relaunching the agent — which against
    // someone else's live session is destructive, not merely unsupported.
    if (session.isAdopted) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'Respawn is not available for adopted sessions: Codeman did not start this agent and must not drive its lifecycle'
      );
    }
    // Respawn is not supported for external-CLI sessions (opencode/codex)
    if (isExternalCliMode(session.mode)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Respawn is not supported for ${session.mode} sessions`);
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

    ctx.broadcast(SseEvent.RespawnStarted, { sessionId: id, status: controller.getStatus() });

    return {
      message: 'Respawn enabled on existing session',
      respawnStatus: controller.getStatus(),
    };
  });
}
