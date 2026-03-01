/**
 * @fileoverview Session management routes.
 * Covers session CRUD, input/output, terminal buffer, quick-start, quick-run,
 * auto-clear, auto-compact, image watcher, flicker filter, and logout.
 */

import { FastifyInstance } from 'fastify';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import {
  ApiErrorCode,
  createErrorResponse,
  getErrorMessage,
  type ApiResponse,
  type QuickStartResponse,
  type SessionColor,
} from '../../types.js';
import { Session } from '../../session.js';
import {
  CreateSessionSchema,
  SessionNameSchema,
  SessionColorSchema,
  RunPromptSchema,
  SessionInputWithLimitSchema,
  ResizeSchema,
  AutoClearSchema,
  AutoCompactSchema,
  ImageWatcherSchema,
  FlickerFilterSchema,
  QuickRunSchema,
  QuickStartSchema,
} from '../schemas.js';
import { autoConfigureRalph, CASES_DIR, SETTINGS_PATH } from '../route-helpers.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';
import { writeHooksConfig, updateCaseEnvVars } from '../../hooks-config.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { imageWatcher } from '../../image-watcher.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort, AuthPort } from '../ports/index.js';
import { MAX_CONCURRENT_SESSIONS } from '../../config/map-limits.js';
import { RunSummaryTracker } from '../../run-summary.js';

import { MAX_INPUT_LENGTH, MAX_SESSION_NAME_LENGTH } from '../../config/terminal-limits.js';

// Pre-compiled regex for terminal buffer cleaning (avoids per-request compilation)
// eslint-disable-next-line no-control-regex
const CLAUDE_BANNER_PATTERN = /\x1b\[1mClaud/;
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
const LEADING_WHITESPACE_PATTERN = /^[\s\r\n]+/;

export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort & AuthPort
): void {
  // ========== Logout ==========

  app.post('/api/logout', async (req, reply) => {
    // Invalidate server-side session token (not just the browser cookie)
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken) {
      ctx.authSessions?.delete(sessionToken);
    }
    reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    return { success: true };
  });

  // ========== Session Listing ==========

  app.get('/api/sessions', async () => {
    return ctx.getLightSessionsState();
  });

  // ========== Session Creation ==========

  app.post('/api/sessions', async (req) => {
    // Prevent unbounded session creation
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached. Delete some sessions first.`
      );
    }

    const result = CreateSessionSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const body = result.data;
    const workingDir = body.workingDir || process.cwd();

    // Validate workingDir exists and is a directory
    if (body.workingDir) {
      try {
        const stat = statSync(workingDir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    // Write env overrides to .claude/settings.local.json if provided
    if (body.envOverrides && Object.keys(body.envOverrides).length > 0) {
      await updateCaseEnvVars(workingDir, body.envOverrides);
    }

    // Check OpenCode availability if requested
    if (body.mode === 'opencode') {
      const { isOpenCodeAvailable } = await import('../../utils/opencode-cli-resolver.js');
      if (!isOpenCodeAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash'
        );
      }
    }

    const globalNice = await ctx.getGlobalNiceConfig();
    const modelConfig = await ctx.getModelConfig();
    const mode = body.mode || 'claude';
    const model =
      mode === 'opencode' ? body.openCodeConfig?.model : mode !== 'shell' ? modelConfig?.defaultModel : undefined;
    const claudeModeConfig = await ctx.getClaudeModeConfig();
    const session = new Session({
      workingDir,
      mode,
      name: body.name || '',
      mux: ctx.mux,
      useMux: true,
      niceConfig: globalNice,
      model,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      openCodeConfig: mode === 'opencode' ? body.openCodeConfig : undefined,
    });

    ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({ event: 'created', sessionId: session.id, name: session.name });

    // Use light state for broadcast + response — buffers are fetched on-demand via /terminal.
    // Avoids serializing 2-3MB of terminal+text buffers per session creation.
    const lightState = ctx.getSessionStateWithRespawn(session);
    ctx.broadcast('session:created', lightState);
    return { success: true, session: lightState };
  });

  // ========== Rename Session ==========

  app.put('/api/sessions/:id/name', async (req) => {
    const { id } = req.params as { id: string };
    const result = SessionNameSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = result.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    const name = String(body.name || '').slice(0, MAX_SESSION_NAME_LENGTH);
    session.name = name;
    // Also update the mux session name if applicable
    ctx.mux.updateSessionName(id, session.name);
    ctx.persistSessionState(session);
    ctx.broadcast('session:updated', ctx.getSessionStateWithRespawn(session));
    return { success: true, name: session.name };
  });

  // ========== Set Session Color ==========

  app.put('/api/sessions/:id/color', async (req) => {
    const { id } = req.params as { id: string };
    const result = SessionColorSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = result.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (!validColors.includes(body.color)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid color');
    }

    session.setColor(body.color as SessionColor);
    ctx.persistSessionState(session);
    ctx.broadcast('session:updated', ctx.getSessionStateWithRespawn(session));
    return { success: true, color: session.color };
  });

  // ========== Delete Session ==========

  app.delete('/api/sessions/:id', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const query = req.query as { killMux?: string };
    const killMux = query.killMux !== 'false'; // Default to true

    if (!ctx.sessions.has(id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    await ctx.cleanupSession(id, killMux, 'user_delete');
    return { success: true };
  });

  // ========== Delete All Sessions ==========

  app.delete('/api/sessions', async (): Promise<ApiResponse<{ killed: number }>> => {
    const sessionIds = Array.from(ctx.sessions.keys());
    let killed = 0;

    for (const id of sessionIds) {
      if (ctx.sessions.has(id)) {
        await ctx.cleanupSession(id, true, 'user_bulk_delete');
        killed++;
      }
    }

    return { success: true, data: { killed } };
  });

  // ========== Get Session Detail ==========

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // Use light state (no full buffers) — terminal buffer available via /terminal endpoint.
    // Full buffers were 2-3MB and caused slowness when polled frequently (e.g. Ralph wizard).
    return ctx.getSessionStateWithRespawn(session);
  });

  // ========== Get Session Output ==========

  app.get('/api/sessions/:id/output', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    return {
      success: true,
      data: {
        textOutput: session.textOutput,
        messages: session.messages,
        errorBuffer: session.errorBuffer,
      },
    };
  });

  // ========== Get Ralph State ==========

  app.get('/api/sessions/:id/ralph-state', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    return {
      success: true,
      data: {
        loop: session.ralphLoopState,
        todos: session.ralphTodos,
        todoStats: session.ralphTodoStats,
      },
    };
  });

  // ========== Get Run Summary ==========

  app.get('/api/sessions/:id/run-summary', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    const tracker = ctx.runSummaryTrackers.get(id);
    if (!tracker) {
      // Create a fresh tracker if one doesn't exist (shouldn't happen normally)
      const newTracker = new RunSummaryTracker(id, session.name);
      ctx.runSummaryTrackers.set(id, newTracker);
      return { success: true, summary: newTracker.getSummary() };
    }

    // Update session name in case it changed
    tracker.setSessionName(session.name);

    return { success: true, summary: tracker.getSummary() };
  });

  // ========== Get Active Tools ==========

  app.get('/api/sessions/:id/active-tools', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    return {
      success: true,
      data: {
        tools: session.activeTools,
      },
    };
  });

  // ========== Run Prompt ==========

  app.post('/api/sessions/:id/run', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const result = RunPromptSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { prompt } = result.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    // Run async, don't wait
    session.runPrompt(prompt).catch((err) => {
      ctx.broadcast('session:error', { id, error: err.message });
    });

    ctx.broadcast('session:running', { id, prompt });
    return { success: true };
  });

  // ========== Start Interactive Mode ==========

  app.post('/api/sessions/:id/interactive', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
      // Ralph tracker is not supported for opencode sessions
      if (
        session.mode !== 'opencode' &&
        ctx.store.getConfig().ralphEnabled &&
        !session.ralphTracker.autoEnableDisabled
      ) {
        autoConfigureRalph(session, session.workingDir, ctx);
        if (!session.ralphTracker.enabled) {
          session.ralphTracker.enable();
        }
      }

      await session.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: session.mode,
      });
      ctx.broadcast('session:interactive', { id });
      ctx.broadcast('session:updated', { session: ctx.getSessionStateWithRespawn(session) });

      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Start Shell Mode ==========

  app.post('/api/sessions/:id/shell', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      await session.startShell();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: 'shell',
      });
      ctx.broadcast('session:interactive', { id, mode: 'shell' });
      ctx.broadcast('session:updated', { session: ctx.getSessionStateWithRespawn(session) });
      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Send Input ==========

  app.post('/api/sessions/:id/input', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const result = SessionInputWithLimitSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { input, useMux } = result.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    const inputStr = String(input);
    if (inputStr.length > MAX_INPUT_LENGTH) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Input exceeds maximum length (${MAX_INPUT_LENGTH} bytes)`
      );
    }

    // Write input to PTY. Direct write is synchronous; writeViaMux
    // (tmux send-keys) is fire-and-forget to avoid blocking the HTTP response.
    if (useMux) {
      // Fire-and-forget: don't block HTTP response on tmux child process.
      // Fallback to direct write on failure.
      session
        .writeViaMux(inputStr)
        .then((ok) => {
          if (!ok) {
            console.warn(`[Server] writeViaMux failed for session ${id}, falling back to direct write`);
            session.write(inputStr);
          }
        })
        .catch(() => {
          session.write(inputStr);
        });
    } else {
      session.write(inputStr);
    }
    return { success: true };
  });

  // ========== Resize Terminal ==========

  app.post('/api/sessions/:id/resize', async (req): Promise<ApiResponse> => {
    const { id } = req.params as { id: string };
    const result = ResizeSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { cols, rows } = result.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    session.resize(cols, rows);
    return { success: true };
  });

  // ========== Get Terminal Buffer ==========

  // Query params:
  //   tail=<bytes> - Only return last N bytes (faster initial load)
  app.get('/api/sessions/:id/terminal', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { tail?: string };
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    const tailBytes = query.tail ? parseInt(query.tail, 10) : 0;
    const fullSize = session.terminalBufferLength;
    let truncated = false;
    let cleanBuffer: string;

    if (tailBytes > 0 && fullSize > tailBytes) {
      // Fast path: tail from the end, skip expensive banner search on full 2MB buffer.
      // Banner is near the top and gets discarded by tail anyway.
      cleanBuffer = session.terminalBuffer.slice(-tailBytes);
      truncated = true;
      // Avoid starting mid-ANSI-escape: find first newline within the first 4KB
      // and start from there. This prevents xterm.js from parsing a partial escape
      // sequence which corrupts cursor position for all subsequent Ink redraws.
      const firstNewline = cleanBuffer.indexOf('\n');
      if (firstNewline > 0 && firstNewline < 4096) {
        cleanBuffer = cleanBuffer.slice(firstNewline + 1);
      }
    } else {
      // Full buffer: clean junk before actual Claude content
      cleanBuffer = session.terminalBuffer;

      // Find where Claude banner starts (has color codes before "Claude")
      const claudeMatch = cleanBuffer.match(CLAUDE_BANNER_PATTERN);
      if (claudeMatch && claudeMatch.index !== undefined && claudeMatch.index > 0) {
        let lineStart = claudeMatch.index;
        while (lineStart > 0 && cleanBuffer[lineStart - 1] !== '\n') {
          lineStart--;
        }
        cleanBuffer = cleanBuffer.slice(lineStart);
      }
    }

    // Remove Ctrl+L and leading whitespace (cheap on tailed subset)
    cleanBuffer = cleanBuffer.replace(CTRL_L_PATTERN, '').replace(LEADING_WHITESPACE_PATTERN, '');

    return {
      terminalBuffer: cleanBuffer,
      status: session.status,
      fullSize,
      truncated,
    };
  });

  // ========== Auto-Clear ==========

  app.post('/api/sessions/:id/auto-clear', async (req) => {
    const { id } = req.params as { id: string };
    const acResult = AutoClearSchema.safeParse(req.body);
    if (!acResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = acResult.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    session.setAutoClear(body.enabled, body.threshold);
    ctx.persistSessionState(session);
    ctx.broadcast('session:updated', ctx.getSessionStateWithRespawn(session));

    return {
      success: true,
      data: {
        autoClear: {
          enabled: session.autoClearEnabled,
          threshold: session.autoClearThreshold,
        },
      },
    };
  });

  // ========== Auto-Compact ==========

  app.post('/api/sessions/:id/auto-compact', async (req) => {
    const { id } = req.params as { id: string };
    const compactResult = AutoCompactSchema.safeParse(req.body);
    if (!compactResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = compactResult.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    session.setAutoCompact(body.enabled, body.threshold, body.prompt);
    ctx.persistSessionState(session);
    ctx.broadcast('session:updated', ctx.getSessionStateWithRespawn(session));

    return {
      success: true,
      data: {
        autoCompact: {
          enabled: session.autoCompactEnabled,
          threshold: session.autoCompactThreshold,
          prompt: session.autoCompactPrompt,
        },
      },
    };
  });

  // ========== Image Watcher ==========

  app.post('/api/sessions/:id/image-watcher', async (req) => {
    const { id } = req.params as { id: string };
    const iwResult = ImageWatcherSchema.safeParse(req.body);
    if (!iwResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = iwResult.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    if (body.enabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    } else {
      imageWatcher.unwatchSession(session.id);
    }

    // Store state on session for persistence
    session.imageWatcherEnabled = body.enabled;
    ctx.persistSessionState(session);

    return {
      success: true,
      data: {
        imageWatcherEnabled: body.enabled,
      },
    };
  });

  // ========== Flicker Filter ==========

  app.post('/api/sessions/:id/flicker-filter', async (req) => {
    const { id } = req.params as { id: string };
    const ffResult = FlickerFilterSchema.safeParse(req.body);
    if (!ffResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const body = ffResult.data;
    const session = ctx.sessions.get(id);

    if (!session) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    session.flickerFilterEnabled = body.enabled;
    ctx.persistSessionState(session);
    ctx.broadcast('session:updated', ctx.getSessionStateWithRespawn(session));

    return {
      success: true,
      data: {
        flickerFilterEnabled: body.enabled,
      },
    };
  });

  // ========== Quick Run ==========

  app.post('/api/run', async (req) => {
    // Prevent unbounded session creation
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.SESSION_BUSY,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`
      );
    }

    const qrResult = QuickRunSchema.safeParse(req.body);
    if (!qrResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const { prompt, workingDir } = qrResult.data;

    if (!prompt.trim()) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'prompt is required');
    }
    const dir = workingDir || process.cwd();

    // Validate workingDir exists and is a directory
    if (workingDir) {
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    const session = new Session({ workingDir: dir });
    ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'run_prompt',
    });

    ctx.broadcast('session:created', ctx.getSessionStateWithRespawn(session));

    try {
      const result = await session.runPrompt(prompt);
      // Clean up session after completion to prevent memory leak
      await ctx.cleanupSession(session.id, true, 'run_prompt_complete');
      return { success: true, sessionId: session.id, ...result };
    } catch (err) {
      // Clean up session on error too
      await ctx.cleanupSession(session.id, true, 'run_prompt_error');
      return { success: false, sessionId: session.id, error: getErrorMessage(err) };
    }
  });

  // ========== Quick Start ==========

  app.post('/api/quick-start', async (req): Promise<QuickStartResponse> => {
    // Prevent unbounded session creation
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.SESSION_BUSY,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached.`
      );
    }

    const result = QuickStartSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { caseName = 'testcase', mode = 'claude', openCodeConfig } = result.data;

    // Check OpenCode availability if requested
    if (mode === 'opencode') {
      const { isOpenCodeAvailable } = await import('../../utils/opencode-cli-resolver.js');
      if (!isOpenCodeAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash'
        );
      }
    }

    const casePath = join(CASES_DIR, caseName);

    // Security: Path traversal protection - use relative path check
    const resolvedPath = resolve(casePath);
    const resolvedBase = resolve(CASES_DIR);
    const relPath = relative(resolvedBase, resolvedPath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    // Create case folder and CLAUDE.md if it doesn't exist
    if (!existsSync(casePath)) {
      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });

        // Read settings to get custom template path
        const templatePath = await ctx.getDefaultClaudeMdPath();
        const claudeMd = generateClaudeMd(caseName, '', templatePath);
        writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

        // Write .claude/settings.local.json with hooks for desktop notifications
        // (Claude-specific — OpenCode uses its own plugin system)
        if (mode !== 'opencode') {
          await writeHooksConfig(casePath);
        }

        ctx.broadcast('case:created', { name: caseName, path: casePath });
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }
    }

    // Create a new session with the case as working directory
    // Apply global Nice priority config and model config from settings
    const niceConfig = await ctx.getGlobalNiceConfig();
    const qsModelConfig = await ctx.getModelConfig();
    const qsModel =
      mode === 'opencode' ? openCodeConfig?.model : mode !== 'shell' ? qsModelConfig?.defaultModel : undefined;
    const qsClaudeModeConfig = await ctx.getClaudeModeConfig();
    const session = new Session({
      workingDir: casePath,
      mux: ctx.mux,
      useMux: true,
      mode: mode,
      niceConfig: niceConfig,
      model: qsModel,
      claudeMode: qsClaudeModeConfig.claudeMode,
      allowedTools: qsClaudeModeConfig.allowedTools,
      openCodeConfig: mode === 'opencode' ? openCodeConfig : undefined,
    });

    // Auto-detect completion phrase from CLAUDE.md BEFORE broadcasting
    // so the initial state already has the phrase configured (only if globally enabled)
    if (mode === 'claude' && ctx.store.getConfig().ralphEnabled) {
      autoConfigureRalph(session, casePath, ctx);
      if (!session.ralphTracker.enabled) {
        session.ralphTracker.enable();
        session.ralphTracker.enableAutoEnable(); // Allow re-enabling on restart
      }
    }

    ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'quick_start',
    });
    ctx.broadcast('session:created', ctx.getSessionStateWithRespawn(session));

    // Start in the appropriate mode
    try {
      if (mode === 'shell') {
        await session.startShell();
        getLifecycleLog().log({
          event: 'started',
          sessionId: session.id,
          name: session.name,
          mode: 'shell',
        });
        ctx.broadcast('session:interactive', { id: session.id, mode: 'shell' });
      } else {
        // Both 'claude' and 'opencode' modes use startInteractive()
        await session.startInteractive();
        getLifecycleLog().log({
          event: 'started',
          sessionId: session.id,
          name: session.name,
          mode,
        });
        ctx.broadcast('session:interactive', { id: session.id, mode });
      }
      ctx.broadcast('session:updated', { session: ctx.getSessionStateWithRespawn(session) });

      // Save lastUsedCase to settings for TUI/web sync
      try {
        const settingsFilePath = SETTINGS_PATH;
        let settings: Record<string, unknown> = {};
        try {
          settings = JSON.parse(await fs.readFile(settingsFilePath, 'utf-8'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        settings.lastUsedCase = caseName;
        const dir = dirname(settingsFilePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Use async write to avoid blocking event loop
        fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2)).catch((err) => {
          // Non-critical but log for debugging
          console.warn('[Server] Failed to save settings (lastUsedCase):', err);
        });
      } catch (err) {
        // Non-critical but log for debugging
        console.warn('[Server] Failed to prepare settings update:', err);
      }

      return {
        success: true,
        sessionId: session.id,
        casePath,
        caseName,
      };
    } catch (err) {
      // Clean up session on error to prevent orphaned resources
      await ctx.cleanupSession(session.id, true, 'quick_start_error');
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });
}
