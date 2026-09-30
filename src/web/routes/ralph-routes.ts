/**
 * @fileoverview Ralph/todo-related routes.
 * Ralph tracker config, circuit breaker, fix plan CRUD, ralph prompt writing,
 * and the Ralph Loop start endpoint (autonomous task execution).
 */

import { FastifyInstance } from 'fastify';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { Session, isExternalCliMode } from '../../session.js';
import { RespawnController } from '../../respawn-controller.js';
import { RalphConfigSchema, FixPlanImportSchema, RalphPromptWriteSchema, RalphLoopStartSchema } from '../schemas.js';
import { SseEvent } from '../sse-events.js';
import {
  autoConfigureRalph,
  getAuthUser,
  ownerFor,
  resolveCasesDir,
  sessionCapacityMessage,
  SETTINGS_PATH,
  findSessionOrFail,
  parseBody,
} from '../route-helpers.js';
import { resolveClaudeModeForUsername } from '../../user-store.js';
import { writeHooksConfig, stripCaseEnvKeys } from '../../hooks-config.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { buildRalphLoopPrompt } from '../../prompts/index.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';

export function registerRalphRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort
): void {
  // ═══════════════════════════════════════════════════════════════
  // Ralph Tracker Configuration & Status
  // ═══════════════════════════════════════════════════════════════

  // Configure Ralph tracker for a session
  app.post('/api/sessions/:id/ralph-config', async (req) => {
    const { id } = req.params as { id: string };
    const { enabled, completionPhrase, maxIterations, maxTodos, todoExpirationMinutes, reset, disableAutoEnable } =
      parseBody(RalphConfigSchema, req.body, 'Invalid request body') as {
        enabled?: boolean;
        completionPhrase?: string;
        maxIterations?: number;
        maxTodos?: number;
        todoExpirationMinutes?: number;
        reset?: boolean | 'full';
        disableAutoEnable?: boolean;
      };
    const session = findSessionOrFail(ctx, id, req);

    // ⚠️ Adoption gate, kept SEPARATE from the external-CLI gate above: an adopted
    // session can be `mode: 'claude'` and still be a process we never launched.
    // Everything below drives the pane on the assumption Codeman owns what runs
    // in it — sending `/clear`, killing and relaunching the agent — which against
    // someone else's live session is destructive, not merely unsupported.
    if (session.isAdopted) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        'The Ralph tracker is not available for adopted sessions: Codeman did not start this agent and must not drive its lifecycle'
      );
    }
    // Ralph tracker is not supported for external-CLI sessions (opencode/codex)
    if (isExternalCliMode(session.mode)) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Ralph tracker is not supported for ${session.mode} sessions`
      );
    }

    // Handle reset first (before other config)
    if (reset) {
      if (reset === 'full') {
        session.ralphTracker.fullReset();
      } else {
        session.ralphTracker.reset();
      }
    }

    // Configure auto-enable behavior
    if (disableAutoEnable !== undefined) {
      if (disableAutoEnable) {
        session.ralphTracker.disableAutoEnable();
      } else {
        session.ralphTracker.enableAutoEnable();
      }
    }

    // Enable/disable the tracker
    if (enabled !== undefined) {
      if (enabled) {
        session.ralphTracker.enable();
        // Allow re-enabling on restart if user explicitly enabled
        session.ralphTracker.enableAutoEnable();
      } else {
        session.ralphTracker.disable();
        // Prevent re-enabling on restart when user explicitly disabled
        session.ralphTracker.disableAutoEnable();
      }
      // Persist Ralph enabled state
      ctx.mux.updateRalphEnabled(id, enabled);
    }

    // Configure the Ralph tracker
    if (completionPhrase !== undefined) {
      // Start loop with completion phrase to set it up for watching
      if (completionPhrase) {
        session.ralphTracker.startLoop(completionPhrase, maxIterations || undefined);
      }
    }

    if (maxIterations !== undefined) {
      session.ralphTracker.setMaxIterations(maxIterations || null);
    }

    if (maxTodos !== undefined) {
      session.ralphTracker.setMaxTodos(maxTodos);
    }

    if (todoExpirationMinutes !== undefined) {
      session.ralphTracker.setTodoExpirationMinutes(todoExpirationMinutes);
    }

    // Persist and broadcast the update
    ctx.persistSessionState(session);
    ctx.broadcast(SseEvent.SessionRalphLoopUpdate, {
      sessionId: id,
      state: session.ralphLoopState,
    });

    return {};
  });

  // Reset circuit breaker for Ralph tracker
  app.post('/api/sessions/:id/ralph-circuit-breaker/reset', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    session.ralphTracker.resetCircuitBreaker();
    return {};
  });

  // Get Ralph status block and circuit breaker state
  app.get('/api/sessions/:id/ralph-status', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    return {
      success: true,
      data: {
        lastStatusBlock: session.ralphTracker.lastStatusBlock,
        circuitBreaker: session.ralphTracker.circuitBreakerStatus,
        cumulativeStats: session.ralphTracker.cumulativeStats,
        exitGateMet: session.ralphTracker.exitGateMet,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Fix Plan CRUD (@fix_plan.md generation, import, read/write)
  // ═══════════════════════════════════════════════════════════════

  // Generate @fix_plan.md content from todos
  app.get('/api/sessions/:id/fix-plan', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    const content = session.ralphTracker.generateFixPlanMarkdown();
    return {
      success: true,
      data: {
        content,
        todoCount: session.ralphTracker.todos.length,
      },
    };
  });

  // Import todos from @fix_plan.md content
  app.post('/api/sessions/:id/fix-plan/import', async (req) => {
    const { id } = req.params as { id: string };
    const { content } = parseBody(FixPlanImportSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    const importedCount = session.ralphTracker.importFixPlanMarkdown(content);
    ctx.persistSessionState(session);

    return {
      success: true,
      data: {
        importedCount,
        todos: session.ralphTracker.todos,
      },
    };
  });

  // Write @fix_plan.md to session's working directory
  app.post('/api/sessions/:id/fix-plan/write', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    const workingDir = session.workingDir;
    if (!workingDir) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session has no working directory');
    }

    const content = session.ralphTracker.generateFixPlanMarkdown();
    const filePath = join(workingDir, '@fix_plan.md');

    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return {
        success: true,
        data: {
          filePath,
          todoCount: session.ralphTracker.todos.length,
        },
      };
    } catch (error) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to write file: ${error}`);
    }
  });

  // Read @fix_plan.md from session's working directory and import
  app.post('/api/sessions/:id/fix-plan/read', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);

    const workingDir = session.workingDir;
    if (!workingDir) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session has no working directory');
    }

    const filePath = join(workingDir, '@fix_plan.md');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const importedCount = session.ralphTracker.importFixPlanMarkdown(content);
      ctx.persistSessionState(session);

      return {
        success: true,
        data: {
          filePath,
          importedCount,
          todos: session.ralphTracker.todos,
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, '@fix_plan.md not found in working directory');
      }
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${error}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Ralph Prompt & Loop (prompt write, loop start)
  // ═══════════════════════════════════════════════════════════════

  // Write Ralph prompt to file in session's working directory
  // This avoids mux input escaping issues with long multi-line prompts
  app.post('/api/sessions/:id/ralph-prompt/write', async (req) => {
    const { id } = req.params as { id: string };
    const { content } = parseBody(RalphPromptWriteSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id, req);

    const workingDir = session.workingDir;
    if (!workingDir) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session has no working directory');
    }

    const filePath = join(workingDir, '@ralph_prompt.md');

    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return {
        success: true,
        data: {
          filePath,
          contentLength: content.length,
        },
      };
    } catch (error) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to write file: ${error}`);
    }
  });

  // Start a Ralph Loop — creates a new session with autonomous cycling
  app.post('/api/ralph-loop/start', async (req): Promise<ApiResponse> => {
    const rlOwner = ownerFor(req);
    const capMsg = sessionCapacityMessage(ctx.sessions, rlOwner);
    if (capMsg) return createErrorResponse(ApiErrorCode.SESSION_BUSY, capMsg);

    const {
      caseName,
      taskDescription,
      completionPhrase,
      maxIterations,
      enableRespawn,
      planItems,
      envOverrides,
      effort,
    } = parseBody(RalphLoopStartSchema, req.body);

    // Multi-user: cases live in the requesting user's space.
    const rlCasesBase = resolveCasesDir(getAuthUser(req));
    const casePath = join(rlCasesBase, caseName);

    // Security: Path traversal protection
    const rlResolvedPath = resolve(casePath);
    const rlResolvedBase = resolve(rlCasesBase);
    const rlRelPath = relative(rlResolvedBase, rlResolvedPath);
    if (rlRelPath.startsWith('..') || isAbsolute(rlRelPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    // Create case folder if it doesn't exist (reuse quick-start logic)
    if (!existsSync(casePath)) {
      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });
        const templatePath = await ctx.getDefaultClaudeMdPath();
        const claudeMd = generateClaudeMd(caseName, '', templatePath);
        writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);
        await writeHooksConfig(casePath);
        ctx.broadcast(SseEvent.CaseCreated, { name: caseName, path: casePath });
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }
    }

    // Strip stale disk entries for keys this request is actively setting.
    if (envOverrides && Object.keys(envOverrides).length > 0) {
      await stripCaseEnvKeys(casePath, Object.keys(envOverrides));
    }

    // Create session
    const niceConfig = await ctx.getGlobalNiceConfig();
    const rlModelConfig = await ctx.getModelConfig();
    const rlClaudeModeConfig = await ctx.getClaudeModeConfig();
    const rlClaudeMode = await resolveClaudeModeForUsername(rlClaudeModeConfig.claudeMode, rlOwner);
    const session = new Session({
      workingDir: casePath,
      mux: ctx.mux,
      useMux: true,
      mode: 'claude',
      niceConfig,
      model: rlModelConfig?.defaultModel || undefined,
      claudeMode: rlClaudeMode,
      allowedTools: rlClaudeModeConfig.allowedTools,
      envOverrides,
      effort,
      owner: rlOwner,
    });

    // Configure Ralph tracker
    autoConfigureRalph(session, casePath, ctx);
    if (!session.ralphTracker.enabled) {
      session.ralphTracker.enable();
      session.ralphTracker.enableAutoEnable();
    }
    session.ralphTracker.startLoop(completionPhrase, maxIterations ?? undefined);

    // Build fix_plan markdown from plan items if provided
    const enabledItems = planItems?.filter((i) => i.enabled) ?? [];
    let planContent = '';
    if (enabledItems.length > 0) {
      const p0 = enabledItems.filter((i) => i.priority === 'P0');
      const p1 = enabledItems.filter((i) => i.priority === 'P1');
      const p2 = enabledItems.filter((i) => i.priority === 'P2');
      const noPri = enabledItems.filter((i) => !i.priority);
      planContent = '# Implementation Plan\n\n';
      planContent += `Generated: ${new Date().toISOString().slice(0, 10)}\n\n`;
      if (p0.length > 0) {
        planContent += '## Critical Path (P0)\n\n';
        p0.forEach((i) => {
          planContent += `- [ ] ${i.content}\n`;
        });
        planContent += '\n';
      }
      if (p1.length > 0) {
        planContent += '## Standard (P1)\n\n';
        p1.forEach((i) => {
          planContent += `- [ ] ${i.content}\n`;
        });
        planContent += '\n';
      }
      if (p2.length > 0) {
        planContent += '## Nice-to-Have (P2)\n\n';
        p2.forEach((i) => {
          planContent += `- [ ] ${i.content}\n`;
        });
        planContent += '\n';
      }
      if (noPri.length > 0) {
        planContent += '## Tasks\n\n';
        noPri.forEach((i) => {
          planContent += `- [ ] ${i.content}\n`;
        });
        planContent += '\n';
      }

      // Import into tracker and write to disk
      session.ralphTracker.importFixPlanMarkdown(planContent);
      const fixPlanPath = join(casePath, '@fix_plan.md');
      writeFileSync(fixPlanPath, planContent, 'utf-8');
    }

    // Build full prompt (includes the RALPH_STATUS contract)
    const fullPrompt = buildRalphLoopPrompt({
      taskDescription,
      completionPhrase,
      hasPlan: enabledItems.length > 0,
    });

    // Write prompt to file
    const promptPath = join(casePath, '@ralph_prompt.md');
    writeFileSync(promptPath, fullPrompt, 'utf-8');

    // Register session
    await ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'ralph_loop_start',
    });
    ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));

    // Start interactive mode
    try {
      await session.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: session.id,
        name: session.name,
        mode: 'claude',
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id: session.id, mode: 'claude' });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });
    } catch (err) {
      await ctx.cleanupSession(session.id, true, 'ralph_loop_start_error');
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }

    // Enable respawn if requested
    if (enableRespawn) {
      const ralphUpdatePrompt =
        'Before /clear: Update CLAUDE.md with discoveries and notes, mark completed tasks in @fix_plan.md, write a brief progress summary to a file so the next iteration can continue seamlessly.';
      const ralphKickstartPrompt = `You are in a Ralph Wiggum loop. Read @fix_plan.md for task status, continue on the next uncompleted task, output <promise>${completionPhrase}</promise> when ALL tasks are complete.`;
      const controller = new RespawnController(session, {
        updatePrompt: ralphUpdatePrompt,
        sendClear: true,
        sendInit: true,
        kickstartPrompt: ralphKickstartPrompt,
      });
      ctx.respawnControllers.set(session.id, controller);
      ctx.setupRespawnListeners(session.id, controller);
      controller.start();
      ctx.saveRespawnConfig(session.id, controller.getConfig());
      ctx.persistSessionState(session);
      ctx.broadcast(SseEvent.RespawnStarted, {
        sessionId: session.id,
        status: controller.getStatus(),
      });
    }

    // Save lastUsedCase
    try {
      let settings: Record<string, unknown> = {};
      try {
        settings = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'));
      } catch {
        /* ignore */
      }
      settings.lastUsedCase = caseName;
      const dir = dirname(SETTINGS_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2)).catch(() => {}); // Ignore - persisting lastUsedCase is non-critical
    } catch {
      /* non-critical */
    }

    const sessionId = session.id;

    // Async: poll for CLI readiness, then send prompt
    setImmediate(() => {
      const pollReady = async () => {
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((r) => setTimeout(r, 500));
          const s = ctx.sessions.get(sessionId);
          if (!s) return; // session was deleted
          // Check terminal output for prompt indicator
          const termBuf = s.getTerminalBuffer().slice(-2048);
          if (termBuf.includes('\u276F') || termBuf.includes('tokens')) {
            break;
          }
        }
        // Small extra delay for CLI to settle
        await new Promise((r) => setTimeout(r, 2000));
        const s = ctx.sessions.get(sessionId);
        if (!s) return;
        try {
          await s.writeViaMux('Read @ralph_prompt.md and follow the instructions. Start working immediately.\r');
        } catch (err) {
          console.warn(`[RalphLoop] Failed to send prompt to session ${sessionId}:`, getErrorMessage(err));
        }
      };
      pollReady().catch((err) => console.error('[RalphLoop] pollReady error:', err));
    });

    return {
      success: true,
      data: { sessionId, caseName },
    };
  });
}
