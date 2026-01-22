/**
 * @fileoverview Claudeman web server and REST API
 *
 * Provides a Fastify-based web server with:
 * - REST API for session management, respawn control, and monitoring
 * - Server-Sent Events (SSE) for real-time updates at /api/events
 * - Static file serving for the web UI
 * - 60fps terminal streaming with batched updates
 *
 * @module web/server
 */

import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, totalmem, freemem, loadavg, cpus } from 'node:os';
import { EventEmitter } from 'node:events';
import { Session, ClaudeMessage, type BackgroundTask, type RalphTrackerState, type RalphTodoItem } from '../session.js';
import { RespawnController, RespawnConfig, RespawnState } from '../respawn-controller.js';
import { ScreenManager } from '../screen-manager.js';
import { getStore } from '../state-store.js';
import { generateClaudeMd } from '../templates/claude-md.js';
import { parseRalphLoopConfig, extractCompletionPhrase } from '../ralph-config.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getErrorMessage,
  ApiErrorCode,
  createErrorResponse,
  type CreateSessionRequest,
  type RunPromptRequest,
  type SessionInputRequest,
  type ResizeRequest,
  type CreateCaseRequest,
  type QuickStartRequest,
  type CreateScheduledRunRequest,
  type QuickRunRequest,
  type ApiResponse,
  type SessionResponse,
  type QuickStartResponse,
  type CaseInfo,
  type PersistedRespawnConfig,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ScheduledRun {
  id: string;
  prompt: string;
  workingDir: string;
  durationMinutes: number;
  startedAt: number;
  endAt: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  sessionId: string | null;
  completedTasks: number;
  totalCost: number;
  logs: string[];
}

// Batch terminal data for performance - collect for 16ms (60fps) before sending
const TERMINAL_BATCH_INTERVAL = 16;
// Batch session:output events for 50ms
const OUTPUT_BATCH_INTERVAL = 50;
// Batch task:updated events for 100ms
const TASK_UPDATE_BATCH_INTERVAL = 100;
// State update debounce interval (batch expensive toDetailedState() calls)
const STATE_UPDATE_DEBOUNCE_INTERVAL = 500;
// Scheduled runs cleanup interval (check every 5 minutes)
const SCHEDULED_CLEANUP_INTERVAL = 5 * 60 * 1000;
// Completed scheduled runs max age (1 hour)
const SCHEDULED_RUN_MAX_AGE = 60 * 60 * 1000;
// Maximum concurrent sessions to prevent resource exhaustion
const MAX_CONCURRENT_SESSIONS = 50;
// SSE client health check interval (every 30 seconds)
const SSE_HEALTH_CHECK_INTERVAL = 30 * 1000;

/**
 * Auto-configure Ralph tracker for a session.
 *
 * Priority order:
 * 1. .claude/ralph-loop.local.md (official Ralph Wiggum plugin state)
 * 2. CLAUDE.md <promise> tags (fallback)
 *
 * The ralph-loop.local.md file has priority because it contains
 * the exact configuration from an active Ralph loop session.
 */
function autoConfigureRalph(session: Session, workingDir: string, broadcast: (event: string, data: unknown) => void): void {
  // First, try to read the official Ralph Wiggum plugin state file
  const ralphConfig = parseRalphLoopConfig(workingDir);

  if (ralphConfig && ralphConfig.completionPromise) {
    session.ralphTracker.enable();
    session.ralphTracker.startLoop(
      ralphConfig.completionPromise,
      ralphConfig.maxIterations ?? undefined
    );

    // Restore iteration count if available
    if (ralphConfig.iteration > 0) {
      // The tracker's cycleCount will be updated when we detect iteration patterns
      // in the terminal output, but we can set maxIterations now
      console.log(`[auto-detect] Ralph loop at iteration ${ralphConfig.iteration}/${ralphConfig.maxIterations ?? '∞'}`);
    }

    console.log(`[auto-detect] Configured Ralph loop for session ${session.id} from ralph-loop.local.md: ${ralphConfig.completionPromise}`);
    broadcast('session:ralphLoopUpdate', {
      sessionId: session.id,
      state: session.ralphTracker.loopState,
    });
    return;
  }

  // Fallback: try CLAUDE.md
  const claudeMdPath = join(workingDir, 'CLAUDE.md');
  const completionPhrase = extractCompletionPhrase(claudeMdPath);

  if (completionPhrase) {
    session.ralphTracker.enable();
    session.ralphTracker.startLoop(completionPhrase);
    console.log(`[auto-detect] Configured Ralph loop for session ${session.id} from CLAUDE.md: ${completionPhrase}`);
    broadcast('session:ralphLoopUpdate', {
      sessionId: session.id,
      state: session.ralphTracker.loopState,
    });
  }
}

export class WebServer extends EventEmitter {
  private app: FastifyInstance;
  private sessions: Map<string, Session> = new Map();
  private respawnControllers: Map<string, RespawnController> = new Map();
  private respawnTimers: Map<string, { timer: NodeJS.Timeout; endAt: number; startedAt: number }> = new Map();
  private scheduledRuns: Map<string, ScheduledRun> = new Map();
  private sseClients: Set<FastifyReply> = new Set();
  private store = getStore();
  private port: number;
  private screenManager: ScreenManager;
  // Terminal batching for performance
  private terminalBatches: Map<string, string> = new Map();
  private terminalBatchTimer: NodeJS.Timeout | null = null;
  // Scheduled runs cleanup timer
  private scheduledCleanupTimer: NodeJS.Timeout | null = null;
  // SSE event batching
  private outputBatches: Map<string, string> = new Map();
  private outputBatchTimer: NodeJS.Timeout | null = null;
  private taskUpdateBatches: Map<string, BackgroundTask> = new Map();
  private taskUpdateBatchTimer: NodeJS.Timeout | null = null;
  // State update batching (reduce expensive toDetailedState() serialization)
  private stateUpdatePending: Set<string> = new Set();
  private stateUpdateTimer: NodeJS.Timeout | null = null;
  // SSE client health check timer
  private sseHealthCheckTimer: NodeJS.Timeout | null = null;
  // Flag to prevent new timers during shutdown
  private _isStopping: boolean = false;

  constructor(port: number = 3000) {
    super();
    this.port = port;
    this.app = Fastify({ logger: false });
    this.screenManager = new ScreenManager();

    // Set up screen manager event listeners
    this.screenManager.on('screenCreated', (screen) => {
      this.broadcast('screen:created', screen);
    });
    this.screenManager.on('screenKilled', (data) => {
      this.broadcast('screen:killed', data);
    });
    this.screenManager.on('screenDied', (data) => {
      this.broadcast('screen:died', data);
    });
    this.screenManager.on('statsUpdated', (screens) => {
      this.broadcast('screen:statsUpdated', screens);
    });
  }

  private async setupRoutes(): Promise<void> {
    // Serve static files
    await this.app.register(fastifyStatic, {
      root: join(__dirname, 'public'),
      prefix: '/',
    });

    // SSE endpoint for real-time updates
    this.app.get('/api/events', (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      this.sseClients.add(reply);

      // Send initial state
      this.sendSSE(reply, 'init', this.getFullState());

      req.raw.on('close', () => {
        this.sseClients.delete(reply);
      });
    });

    // API Routes
    this.app.get('/api/status', async () => this.getFullState());

    // Session management
    this.app.get('/api/sessions', async () => this.getSessionsState());

    this.app.post('/api/sessions', async (req): Promise<SessionResponse> => {
      // Prevent unbounded session creation
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        return { success: false, error: `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached. Delete some sessions first.` };
      }

      const body = req.body as CreateSessionRequest & { mode?: 'claude' | 'shell'; name?: string };
      const workingDir = body.workingDir || process.cwd();
      const session = new Session({
        workingDir,
        mode: body.mode || 'claude',
        name: body.name || '',
        screenManager: this.screenManager,
        useScreen: true
      });

      this.sessions.set(session.id, session);
      this.persistSessionState(session);
      this.setupSessionListeners(session);

      this.broadcast('session:created', session.toDetailedState());
      return { success: true, session: session.toDetailedState() };
    });

    // Rename a session
    this.app.put('/api/sessions/:id/name', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { name: string };
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      session.name = body.name || '';
      // Also update the screen name if this session has a screen
      this.screenManager.updateScreenName(id, session.name);
      this.persistSessionState(session);
      this.broadcast('session:updated', session.toDetailedState());
      return { success: true, name: session.name };
    });

    this.app.delete('/api/sessions/:id', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const query = req.query as { killScreen?: string };
      const killScreen = query.killScreen !== 'false'; // Default to true

      if (!this.sessions.has(id)) {
        return { success: false, error: 'Session not found' };
      }

      await this.cleanupSession(id, killScreen);
      return { success: true };
    });

    // Kill all sessions at once
    this.app.delete('/api/sessions', async (): Promise<ApiResponse<{ killed: number }>> => {
      const sessionIds = Array.from(this.sessions.keys());
      let killed = 0;

      for (const id of sessionIds) {
        if (this.sessions.has(id)) {
          await this.cleanupSession(id);
          killed++;
        }
      }

      return { success: true, data: { killed } };
    });

    this.app.get('/api/sessions/:id', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      return session.toDetailedState();
    });

    this.app.get('/api/sessions/:id/output', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      return {
        success: true,
        data: {
          textOutput: session.textOutput,
          messages: session.messages,
          errorBuffer: session.errorBuffer,
        }
      };
    });

    // Get Ralph state (Ralph loop + todos) for a session
    this.app.get('/api/sessions/:id/ralph-state', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      return {
        success: true,
        data: {
          loop: session.ralphLoopState,
          todos: session.ralphTodos,
          todoStats: session.ralphTodoStats,
        }
      };
    });

    // Configure Ralph (Ralph Wiggum) settings
    this.app.post('/api/sessions/:id/ralph-config', async (req) => {
      const { id } = req.params as { id: string };
      const { enabled, completionPhrase, maxIterations, maxTodos, todoExpirationMinutes, reset, disableAutoEnable } = req.body as {
        enabled?: boolean;
        completionPhrase?: string;
        maxIterations?: number;
        maxTodos?: number;
        todoExpirationMinutes?: number;
        reset?: boolean | 'full';  // true = soft reset (keep enabled), 'full' = complete reset
        disableAutoEnable?: boolean;  // Prevent auto-enable on pattern detection
      };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
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
        } else {
          session.ralphTracker.disable();
        }
        // Persist Ralph enabled state
        this.screenManager.updateRalphEnabled(id, enabled);
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

      // Store additional config on session for reference
      (session as any).ralphConfig = {
        enabled: enabled ?? session.ralphTracker.enabled,
        completionPhrase: completionPhrase || '',
        maxIterations: maxIterations || 0,
        maxTodos: maxTodos || 50,
        todoExpirationMinutes: todoExpirationMinutes || 60
      };

      // Persist and broadcast the update
      this.persistSessionState(session);
      this.broadcast('session:ralphLoopUpdate', {
        sessionId: id,
        state: session.ralphLoopState
      });

      return { success: true };
    });

    // Run prompt in session
    this.app.post('/api/sessions/:id/run', async (req): Promise<{ success?: boolean; message?: string; error?: string }> => {
      const { id } = req.params as { id: string };
      const { prompt } = req.body as RunPromptRequest;
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (session.isBusy()) {
        return { error: 'Session is busy' };
      }

      // Run async, don't wait
      session.runPrompt(prompt).catch(err => {
        this.broadcast('session:error', { id, error: err.message });
      });

      this.broadcast('session:running', { id, prompt });
      return { success: true, message: 'Prompt started' };
    });

    // Start interactive Claude session (persists even if browser disconnects)
    this.app.post('/api/sessions/:id/interactive', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (session.isBusy()) {
        return { error: 'Session is busy' };
      }

      try {
        // Auto-detect completion phrase from CLAUDE.md BEFORE starting
        autoConfigureRalph(session, session.workingDir, () => {});

        await session.startInteractive();
        this.broadcast('session:interactive', { id });
        this.broadcast('session:updated', { session: session.toDetailedState() });

        return { success: true, message: 'Interactive session started' };
      } catch (err) {
        return { error: getErrorMessage(err) };
      }
    });

    // Start a plain shell session (no Claude)
    this.app.post('/api/sessions/:id/shell', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (session.isBusy()) {
        return { error: 'Session is busy' };
      }

      try {
        await session.startShell();
        this.broadcast('session:interactive', { id, mode: 'shell' });
        this.broadcast('session:updated', { session: session.toDetailedState() });
        return { success: true, message: 'Shell session started' };
      } catch (err) {
        return { error: getErrorMessage(err) };
      }
    });

    // Send input to interactive session
    this.app.post('/api/sessions/:id/input', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const { input } = req.body as SessionInputRequest;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (input === undefined || input === null) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Input is required');
      }

      session.write(String(input));
      return { success: true };
    });

    // Resize session terminal
    this.app.post('/api/sessions/:id/resize', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const { cols, rows } = req.body as ResizeRequest;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'cols and rows must be positive integers');
      }

      session.resize(cols, rows);
      return { success: true };
    });

    // Get session terminal buffer (for reconnecting)
    // Query params:
    //   tail=<bytes> - Only return last N bytes (faster initial load)
    this.app.get('/api/sessions/:id/terminal', async (req) => {
      const { id } = req.params as { id: string };
      const query = req.query as { tail?: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      // Clean the buffer: remove junk before actual Claude content
      let cleanBuffer = session.terminalBuffer;

      // Find where Claude banner starts (has color codes before "Claude")
      // Look for the bold escape sequence followed by "Claude"
      const claudeMatch = cleanBuffer.match(/\x1b\[1mClaud/);
      if (claudeMatch && claudeMatch.index !== undefined && claudeMatch.index > 0) {
        // Find the start of that line (look for line start or screen positioning before it)
        let lineStart = claudeMatch.index;
        // Go back to find color/positioning sequences that are part of the banner
        while (lineStart > 0 && cleanBuffer[lineStart - 1] !== '\n') {
          lineStart--;
        }
        cleanBuffer = cleanBuffer.slice(lineStart);
      }

      // Also remove any Ctrl+L and leading whitespace
      cleanBuffer = cleanBuffer
        .replace(/\x0c/g, '')
        .replace(/^[\s\r\n]+/, '');

      // Optionally truncate to last N bytes for faster initial load
      const tailBytes = query.tail ? parseInt(query.tail, 10) : 0;
      const fullSize = cleanBuffer.length;
      let truncated = false;

      if (tailBytes > 0 && cleanBuffer.length > tailBytes) {
        cleanBuffer = cleanBuffer.slice(-tailBytes);
        truncated = true;
      }

      return {
        terminalBuffer: cleanBuffer,
        status: session.status,
        fullSize,
        truncated,
      };
    });

    // ============ Respawn Controller Endpoints ============

    // Get respawn status for a session
    this.app.get('/api/sessions/:id/respawn', async (req) => {
      const { id } = req.params as { id: string };
      const controller = this.respawnControllers.get(id);

      if (!controller) {
        return { enabled: false, status: null };
      }

      return {
        enabled: true,
        ...controller.getStatus(),
      };
    });

    // Get respawn config (from running controller or pre-saved)
    this.app.get('/api/sessions/:id/respawn/config', async (req) => {
      const { id } = req.params as { id: string };
      const controller = this.respawnControllers.get(id);

      if (controller) {
        return { success: true, config: controller.getConfig(), active: true };
      }

      // Return pre-saved config from screens.json
      const preConfig = this.screenManager.getScreen(id)?.respawnConfig;
      if (preConfig) {
        return { success: true, config: preConfig, active: false };
      }

      return { success: true, config: null, active: false };
    });

    // Start respawn controller for a session
    this.app.post('/api/sessions/:id/respawn/start', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as Partial<RespawnConfig> | undefined;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      // Create or get existing controller
      let controller = this.respawnControllers.get(id);
      if (!controller) {
        // Merge request body with pre-saved config from screens.json
        const preConfig = this.screenManager.getScreen(id)?.respawnConfig;
        const config = body || preConfig ? { ...preConfig, ...body } : undefined;
        controller = new RespawnController(session, config);
        this.respawnControllers.set(id, controller);
        this.setupRespawnListeners(id, controller);
      } else if (body) {
        controller.updateConfig(body);
      }

      controller.start();

      // Persist respawn config to screen session and state.json
      this.saveRespawnConfig(id, controller.getConfig());
      this.persistSessionState(session);

      this.broadcast('respawn:started', { sessionId: id, status: controller.getStatus() });

      return { success: true, status: controller.getStatus() };
    });

    // Stop respawn controller for a session
    this.app.post('/api/sessions/:id/respawn/stop', async (req) => {
      const { id } = req.params as { id: string };
      const controller = this.respawnControllers.get(id);

      if (!controller) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Respawn controller not found');
      }

      controller.stop();

      // Clear persisted respawn config
      this.screenManager.clearRespawnConfig(id);

      // Update state.json (respawnConfig removed)
      const session = this.sessions.get(id);
      if (session) {
        this.persistSessionState(session);
      }

      this.broadcast('respawn:stopped', { sessionId: id });

      return { success: true };
    });

    // Update respawn configuration (works with or without running controller)
    this.app.put('/api/sessions/:id/respawn/config', async (req) => {
      const { id } = req.params as { id: string };
      const config = req.body as Partial<RespawnConfig>;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const controller = this.respawnControllers.get(id);

      if (controller) {
        // Update running controller
        controller.updateConfig(config);
        this.saveRespawnConfig(id, controller.getConfig());
        this.persistSessionState(session);
        this.broadcast('respawn:configUpdated', { sessionId: id, config: controller.getConfig() });
        return { success: true, config: controller.getConfig() };
      }

      // No controller running - save as pre-config for when respawn starts
      const existing = this.screenManager.getScreen(id);
      const currentConfig = existing?.respawnConfig;
      const merged: PersistedRespawnConfig = {
        enabled: config.enabled ?? currentConfig?.enabled ?? false,
        idleTimeoutMs: config.idleTimeoutMs ?? currentConfig?.idleTimeoutMs ?? 10000,
        updatePrompt: config.updatePrompt ?? currentConfig?.updatePrompt ?? 'update all the docs and CLAUDE.md',
        interStepDelayMs: config.interStepDelayMs ?? currentConfig?.interStepDelayMs ?? 1000,
        sendClear: config.sendClear ?? currentConfig?.sendClear ?? true,
        sendInit: config.sendInit ?? currentConfig?.sendInit ?? true,
        kickstartPrompt: config.kickstartPrompt ?? currentConfig?.kickstartPrompt,
        durationMinutes: currentConfig?.durationMinutes,
      };
      this.screenManager.updateRespawnConfig(id, merged);
      this.persistSessionState(session);
      this.broadcast('respawn:configUpdated', { sessionId: id, config: merged });
      return { success: true, config: merged };
    });

    // Start interactive session WITH respawn enabled
    this.app.post('/api/sessions/:id/interactive-respawn', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { respawnConfig?: Partial<RespawnConfig>; durationMinutes?: number } | undefined;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (session.isBusy()) {
        return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
      }

      try {
        // Auto-detect completion phrase from CLAUDE.md BEFORE starting
        autoConfigureRalph(session, session.workingDir, () => {});

        // Start interactive session
        await session.startInteractive();
        this.broadcast('session:interactive', { id });
        this.broadcast('session:updated', { session: session.toDetailedState() });

        // Create and start respawn controller
        const controller = new RespawnController(session, body?.respawnConfig);
        this.respawnControllers.set(id, controller);
        this.setupRespawnListeners(id, controller);
        controller.start();

        // Set up timed stop if duration specified
        if (body?.durationMinutes && body.durationMinutes > 0) {
          this.setupTimedRespawn(id, body.durationMinutes);
        }

        // Persist full session state with respawn config
        this.persistSessionState(session);

        this.broadcast('respawn:started', { sessionId: id, status: controller.getStatus() });

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
    this.app.post('/api/sessions/:id/respawn/enable', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { config?: Partial<RespawnConfig>; durationMinutes?: number } | undefined;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      // Check if session is running (has a PID)
      if (!session.pid) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Session is not running. Start it first.');
      }

      // Stop existing controller if any
      const existingController = this.respawnControllers.get(id);
      if (existingController) {
        existingController.stop();
      }

      // Create and start new respawn controller (merge with pre-saved config)
      const preConfig = this.screenManager.getScreen(id)?.respawnConfig;
      const config = body?.config || preConfig ? { ...preConfig, ...body?.config } : undefined;
      const controller = new RespawnController(session, config);
      this.respawnControllers.set(id, controller);
      this.setupRespawnListeners(id, controller);
      controller.start();

      // Set up timed stop if duration specified
      if (body?.durationMinutes && body.durationMinutes > 0) {
        this.setupTimedRespawn(id, body.durationMinutes);
      }

      // Persist respawn config to screen session and state.json
      this.saveRespawnConfig(id, controller.getConfig(), body?.durationMinutes);
      this.persistSessionState(session);

      this.broadcast('respawn:started', { sessionId: id, status: controller.getStatus() });

      return {
        success: true,
        message: 'Respawn enabled on existing session',
        respawnStatus: controller.getStatus(),
      };
    });

    // Set auto-clear on a session
    this.app.post('/api/sessions/:id/auto-clear', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { enabled: boolean; threshold?: number };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (body.enabled === undefined) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'enabled field is required');
      }

      if (body.threshold !== undefined && (typeof body.threshold !== 'number' || body.threshold < 0)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'threshold must be a positive number');
      }

      session.setAutoClear(body.enabled, body.threshold);
      this.persistSessionState(session);
      this.broadcast('session:updated', session.toDetailedState());

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

    // Set auto-compact on a session
    this.app.post('/api/sessions/:id/auto-compact', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { enabled: boolean; threshold?: number; prompt?: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (body.enabled === undefined) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'enabled field is required');
      }

      if (body.threshold !== undefined && (typeof body.threshold !== 'number' || body.threshold < 0)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'threshold must be a positive number');
      }

      session.setAutoCompact(body.enabled, body.threshold, body.prompt);
      this.persistSessionState(session);
      this.broadcast('session:updated', session.toDetailedState());

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

    // Quick run (create session, run prompt, return result, then cleanup)
    this.app.post('/api/run', async (req) => {
      // Prevent unbounded session creation
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        return createErrorResponse(ApiErrorCode.SESSION_BUSY, `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
      }

      const { prompt, workingDir } = req.body as QuickRunRequest;

      if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'prompt is required');
      }
      const dir = workingDir || process.cwd();

      const session = new Session({ workingDir: dir });
      this.sessions.set(session.id, session);
      this.persistSessionState(session);
      this.setupSessionListeners(session);

      this.broadcast('session:created', session.toDetailedState());

      try {
        const result = await session.runPrompt(prompt);
        // Clean up session after completion to prevent memory leak
        await this.cleanupSession(session.id);
        return { success: true, sessionId: session.id, ...result };
      } catch (err) {
        // Clean up session on error too
        await this.cleanupSession(session.id);
        return { success: false, sessionId: session.id, error: getErrorMessage(err) };
      }
    });

    // Scheduled runs
    this.app.get('/api/scheduled', async () => {
      return Array.from(this.scheduledRuns.values());
    });

    this.app.post('/api/scheduled', async (req): Promise<{ success: boolean; run: ScheduledRun }> => {
      const { prompt, workingDir, durationMinutes } = req.body as CreateScheduledRunRequest;

      const run = await this.startScheduledRun(prompt, workingDir || process.cwd(), durationMinutes);
      return { success: true, run };
    });

    this.app.delete('/api/scheduled/:id', async (req) => {
      const { id } = req.params as { id: string };
      const run = this.scheduledRuns.get(id);

      if (!run) {
        return { success: false, error: 'Scheduled run not found' };
      }

      await this.stopScheduledRun(id);
      return { success: true };
    });

    this.app.get('/api/scheduled/:id', async (req) => {
      const { id } = req.params as { id: string };
      const run = this.scheduledRuns.get(id);

      if (!run) {
        return { error: 'Scheduled run not found' };
      }

      return run;
    });

    // Case management
    const casesDir = join(homedir(), 'claudeman-cases');

    this.app.get('/api/cases', async (): Promise<CaseInfo[]> => {
      const cases: CaseInfo[] = [];

      // Get cases from casesDir
      if (existsSync(casesDir)) {
        const entries = readdirSync(casesDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            cases.push({
              name: e.name,
              path: join(casesDir, e.name),
              hasClaudeMd: existsSync(join(casesDir, e.name, 'CLAUDE.md')),
            });
          }
        }
      }

      // Get linked cases
      const linkedCasesFile = join(homedir(), '.claudeman', 'linked-cases.json');
      try {
        if (existsSync(linkedCasesFile)) {
          const linkedCases: Record<string, string> = JSON.parse(readFileSync(linkedCasesFile, 'utf-8'));
          for (const [name, path] of Object.entries(linkedCases)) {
            // Only add if not already in cases (avoid duplicates) and path exists
            if (!cases.some(c => c.name === name) && existsSync(path)) {
              cases.push({
                name,
                path,
                hasClaudeMd: existsSync(join(path, 'CLAUDE.md')),
              });
            }
          }
        }
      } catch {
        // Ignore errors reading linked cases
      }

      return cases;
    });

    this.app.post('/api/cases', async (req): Promise<{ success: boolean; case?: { name: string; path: string }; error?: string }> => {
      const { name, description } = req.body as CreateCaseRequest;

      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        return { success: false, error: 'Invalid case name. Use only letters, numbers, hyphens, underscores.' };
      }

      const casePath = join(casesDir, name);

      // Security: Path traversal protection - ensure resolved path is within casesDir
      const resolvedPath = resolve(casePath);
      const resolvedBase = resolve(casesDir);
      if (!resolvedPath.startsWith(resolvedBase + '/') && resolvedPath !== resolvedBase) {
        return { success: false, error: 'Invalid case path' };
      }

      if (existsSync(casePath)) {
        return { success: false, error: 'Case already exists' };
      }

      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });

        // Read settings to get custom template path
        const templatePath = this.getDefaultClaudeMdPath();
        const claudeMd = generateClaudeMd(name, description || '', templatePath);
        writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

        this.broadcast('case:created', { name, path: casePath });

        return { success: true, case: { name, path: casePath } };
      } catch (err) {
        return { success: false, error: getErrorMessage(err) };
      }
    });

    // Link an existing folder as a case
    this.app.post('/api/cases/link', async (req): Promise<{ success: boolean; case?: { name: string; path: string }; error?: string }> => {
      const { name, path: folderPath } = req.body as { name: string; path: string };

      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        return { success: false, error: 'Invalid case name. Use only letters, numbers, hyphens, underscores.' };
      }

      if (!folderPath) {
        return { success: false, error: 'Folder path is required.' };
      }

      // Expand ~ to home directory
      const expandedPath = folderPath.startsWith('~')
        ? join(homedir(), folderPath.slice(1))
        : folderPath;

      // Validate the folder exists
      if (!existsSync(expandedPath)) {
        return { success: false, error: `Folder not found: ${expandedPath}` };
      }

      // Check if case name already exists in casesDir
      const casePath = join(casesDir, name);
      if (existsSync(casePath)) {
        return { success: false, error: 'A case with this name already exists in claudeman-cases.' };
      }

      // Load existing linked cases
      const linkedCasesFile = join(homedir(), '.claudeman', 'linked-cases.json');
      let linkedCases: Record<string, string> = {};
      try {
        if (existsSync(linkedCasesFile)) {
          linkedCases = JSON.parse(readFileSync(linkedCasesFile, 'utf-8'));
        }
      } catch {
        // Ignore parse errors, start fresh
      }

      // Check if name is already linked
      if (linkedCases[name]) {
        return { success: false, error: `Case "${name}" is already linked to ${linkedCases[name]}` };
      }

      // Save the linked case
      linkedCases[name] = expandedPath;
      try {
        const claudemanDir = join(homedir(), '.claudeman');
        if (!existsSync(claudemanDir)) {
          mkdirSync(claudemanDir, { recursive: true });
        }
        writeFileSync(linkedCasesFile, JSON.stringify(linkedCases, null, 2));
        this.broadcast('case:linked', { name, path: expandedPath });
        return { success: true, case: { name, path: expandedPath } };
      } catch (err) {
        return { success: false, error: getErrorMessage(err) };
      }
    });

    this.app.get('/api/cases/:name', async (req) => {
      const { name } = req.params as { name: string };

      // First check linked cases
      const linkedCasesFile = join(homedir(), '.claudeman', 'linked-cases.json');
      try {
        if (existsSync(linkedCasesFile)) {
          const linkedCases: Record<string, string> = JSON.parse(readFileSync(linkedCasesFile, 'utf-8'));
          if (linkedCases[name]) {
            const linkedPath = linkedCases[name];
            return {
              name,
              path: linkedPath,
              hasClaudeMd: existsSync(join(linkedPath, 'CLAUDE.md')),
              linked: true,
            };
          }
        }
      } catch {
        // Ignore errors, fall through to casesDir check
      }

      // Then check casesDir
      const casePath = join(casesDir, name);

      if (!existsSync(casePath)) {
        return { error: 'Case not found' };
      }

      return {
        name,
        path: casePath,
        hasClaudeMd: existsSync(join(casePath, 'CLAUDE.md')),
      };
    });

    // Quick Start: Create case (if needed) and start interactive session in one click
    this.app.post('/api/quick-start', async (req): Promise<QuickStartResponse> => {
      // Prevent unbounded session creation
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        return { success: false, error: `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached.` };
      }

      const { caseName = 'testcase', mode = 'claude' } = req.body as QuickStartRequest;

      // Validate case name
      if (!/^[a-zA-Z0-9_-]+$/.test(caseName)) {
        return { success: false, error: 'Invalid case name. Use only letters, numbers, hyphens, underscores.' };
      }

      const casePath = join(casesDir, caseName);

      // Security: Path traversal protection - ensure resolved path is within casesDir
      const resolvedPath = resolve(casePath);
      const resolvedBase = resolve(casesDir);
      if (!resolvedPath.startsWith(resolvedBase + '/') && resolvedPath !== resolvedBase) {
        return { success: false, error: 'Invalid case path' };
      }

      // Create case folder and CLAUDE.md if it doesn't exist
      if (!existsSync(casePath)) {
        try {
          mkdirSync(casePath, { recursive: true });
          mkdirSync(join(casePath, 'src'), { recursive: true });

          // Read settings to get custom template path
          const templatePath = this.getDefaultClaudeMdPath();
          const claudeMd = generateClaudeMd(caseName, '', templatePath);
          writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

          this.broadcast('case:created', { name: caseName, path: casePath });
        } catch (err) {
          return { success: false, error: `Failed to create case: ${getErrorMessage(err)}` };
        }
      }

      // Create a new session with the case as working directory
      const session = new Session({
        workingDir: casePath,
        screenManager: this.screenManager,
        useScreen: true,
        mode: mode,
      });

      // Auto-detect completion phrase from CLAUDE.md BEFORE broadcasting
      // so the initial state already has the phrase configured
      if (mode === 'claude') {
        autoConfigureRalph(session, casePath, () => {}); // no broadcast yet
      }

      this.sessions.set(session.id, session);
      this.persistSessionState(session);
      this.setupSessionListeners(session);
      this.broadcast('session:created', session.toDetailedState());

      // Start in the appropriate mode
      try {
        if (mode === 'shell') {
          await session.startShell();
          this.broadcast('session:interactive', { id: session.id, mode: 'shell' });
        } else {
          await session.startInteractive();
          this.broadcast('session:interactive', { id: session.id });
        }
        this.broadcast('session:updated', { session: session.toDetailedState() });

        // Save lastUsedCase to settings for TUI/web sync
        try {
          const settingsFilePath = join(homedir(), '.claudeman', 'settings.json');
          let settings: Record<string, unknown> = {};
          if (existsSync(settingsFilePath)) {
            settings = JSON.parse(readFileSync(settingsFilePath, 'utf-8'));
          }
          settings.lastUsedCase = caseName;
          const dir = dirname(settingsFilePath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2));
        } catch {
          // Non-critical, ignore settings save errors
        }

        return {
          success: true,
          sessionId: session.id,
          casePath,
          caseName,
        };
      } catch (err) {
        // Clean up session on error to prevent orphaned resources
        await this.cleanupSession(session.id);
        return { success: false, error: getErrorMessage(err) };
      }
    });

    // ============ App Settings Endpoints ============
    const settingsPath = join(homedir(), '.claudeman', 'settings.json');

    this.app.get('/api/settings', async () => {
      try {
        if (existsSync(settingsPath)) {
          const content = readFileSync(settingsPath, 'utf-8');
          return JSON.parse(content);
        }
      } catch (err) {
        console.error('Failed to read settings:', err);
      }
      return {};
    });

    this.app.put('/api/settings', async (req) => {
      const settings = req.body as { defaultClaudeMdPath?: string; defaultWorkingDir?: string };

      try {
        const dir = dirname(settingsPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        return { success: true };
      } catch (err) {
        return { error: getErrorMessage(err) };
      }
    });

    // ============ Screen Management Endpoints ============

    // Get all tracked screens with stats
    this.app.get('/api/screens', async () => {
      const screens = await this.screenManager.getScreensWithStats();
      return {
        screens,
        screenAvailable: ScreenManager.isScreenAvailable()
      };
    });

    // Kill a screen session
    this.app.delete('/api/screens/:sessionId', async (req) => {
      const { sessionId } = req.params as { sessionId: string };
      const success = await this.screenManager.killScreen(sessionId);
      return { success };
    });

    // Reconcile screens (find dead ones)
    this.app.post('/api/screens/reconcile', async () => {
      const result = await this.screenManager.reconcileScreens();
      return result;
    });

    // Start stats collection
    this.app.post('/api/screens/stats/start', async () => {
      this.screenManager.startStatsCollection(2000);
      return { success: true };
    });

    // Stop stats collection
    this.app.post('/api/screens/stats/stop', async () => {
      this.screenManager.stopStatsCollection();
      return { success: true };
    });

    // System stats endpoint for frontend header display
    this.app.get('/api/system/stats', async () => {
      return this.getSystemStats();
    });
  }

  /** Persists full session state including respawn config to state.json */
  private persistSessionState(session: Session): void {
    const state = session.toState();
    const controller = this.respawnControllers.get(session.id);
    if (controller) {
      const config = controller.getConfig();
      const timerInfo = this.respawnTimers.get(session.id);
      const durationMinutes = timerInfo
        ? Math.round((timerInfo.endAt - timerInfo.startedAt) / 60000)
        : undefined;
      state.respawnConfig = { ...config, durationMinutes };
      state.respawnEnabled = controller.state !== 'stopped';
    } else {
      state.respawnEnabled = false;
    }
    this.store.setSession(session.id, state);
  }

  // Helper to save respawn config to screen session for persistence
  private saveRespawnConfig(sessionId: string, config: RespawnConfig, durationMinutes?: number): void {
    const persistedConfig: PersistedRespawnConfig = {
      enabled: config.enabled,
      idleTimeoutMs: config.idleTimeoutMs,
      updatePrompt: config.updatePrompt,
      interStepDelayMs: config.interStepDelayMs,
      sendClear: config.sendClear,
      sendInit: config.sendInit,
      kickstartPrompt: config.kickstartPrompt,
      durationMinutes,
    };
    this.screenManager.updateRespawnConfig(sessionId, persistedConfig);
  }

  // Get system CPU and memory usage
  private getSystemStats(): { cpu: number; memory: { usedMB: number; totalMB: number; percent: number } } {
    try {
      // Memory stats
      const totalMem = totalmem();
      const freeMem = freemem();
      const usedMem = totalMem - freeMem;

      // CPU load average (1 min) as percentage (rough approximation)
      const load = loadavg()[0];
      const cpuCount = cpus().length;
      const cpuPercent = Math.min(100, Math.round((load / cpuCount) * 100));

      return {
        cpu: cpuPercent,
        memory: {
          usedMB: Math.round(usedMem / (1024 * 1024)),
          totalMB: Math.round(totalMem / (1024 * 1024)),
          percent: Math.round((usedMem / totalMem) * 100)
        }
      };
    } catch {
      return {
        cpu: 0,
        memory: { usedMB: 0, totalMB: 0, percent: 0 }
      };
    }
  }

  // Clean up all resources associated with a session
  private async cleanupSession(sessionId: string, killScreen: boolean = true): Promise<void> {
    const session = this.sessions.get(sessionId);

    // Stop and remove respawn controller
    const controller = this.respawnControllers.get(sessionId);
    if (controller) {
      controller.stop();
      controller.removeAllListeners();
      this.respawnControllers.delete(sessionId);
      // Notify UI that respawn is stopped for this session
      this.broadcast('respawn:stopped', { sessionId, reason: 'session_cleanup' });
    }

    // Clear respawn timer
    const timerInfo = this.respawnTimers.get(sessionId);
    if (timerInfo) {
      clearTimeout(timerInfo.timer);
      this.respawnTimers.delete(sessionId);
    }

    // Clear batches
    this.terminalBatches.delete(sessionId);
    this.outputBatches.delete(sessionId);
    this.taskUpdateBatches.delete(sessionId);

    // Reset Ralph tracker on the session before cleanup
    if (session) {
      session.ralphTracker.fullReset();
    }

    // Clear Ralph state from store
    this.store.removeRalphState(sessionId);

    // Broadcast Ralph cleared to update UI
    this.broadcast('session:ralphLoopUpdate', {
      sessionId,
      state: { enabled: false, active: false, completionPhrase: null, startedAt: null, cycleCount: 0, maxIterations: null, lastActivity: Date.now(), elapsedHours: null }
    });
    this.broadcast('session:ralphTodoUpdate', {
      sessionId,
      todos: [],
      stats: { total: 0, pending: 0, inProgress: 0, completed: 0 }
    });

    // Stop session and remove listeners
    if (session) {
      session.removeAllListeners();
      await session.stop(killScreen);
      this.sessions.delete(sessionId);
      // Only remove from state.json if we're also killing the screen.
      // When killScreen=false (server shutdown), preserve state for recovery.
      if (killScreen) {
        this.store.removeSession(sessionId);
      }
    }

    this.broadcast('session:deleted', { id: sessionId });
  }

  private setupSessionListeners(session: Session): void {
    session.on('output', (data) => {
      // Use batching for better performance at high throughput
      this.batchOutputData(session.id, data);
    });

    session.on('terminal', (data) => {
      // Use batching for better performance at high throughput
      this.batchTerminalData(session.id, data);
    });

    session.on('clearTerminal', () => {
      // Tell clients to clear their terminal (after screen attach)
      this.broadcast('session:clearTerminal', { id: session.id });
    });

    session.on('message', (msg: ClaudeMessage) => {
      this.broadcast('session:message', { id: session.id, message: msg });
    });

    session.on('error', (error) => {
      this.broadcast('session:error', { id: session.id, error });
    });

    session.on('completion', (result, cost) => {
      this.broadcast('session:completion', { id: session.id, result, cost });
      this.broadcast('session:updated', session.toDetailedState());
      this.persistSessionState(session);
    });

    session.on('exit', (code) => {
      // Wrap in try/catch to ensure cleanup always happens
      try {
        this.broadcast('session:exit', { id: session.id, code });
        this.broadcast('session:updated', session.toDetailedState());
        this.persistSessionState(session);
      } catch (err) {
        console.error(`[Server] Error broadcasting session exit for ${session.id}:`, err);
      }

      // Always clean up respawn controller, even if broadcast failed
      try {
        const controller = this.respawnControllers.get(session.id);
        if (controller) {
          controller.stop();
          controller.removeAllListeners();
          this.respawnControllers.delete(session.id);
        }
      } catch (err) {
        console.error(`[Server] Error cleaning up respawn controller for ${session.id}:`, err);
      }
    });

    session.on('working', () => {
      this.broadcast('session:working', { id: session.id });
    });

    session.on('idle', () => {
      this.broadcast('session:idle', { id: session.id });
      // Use debounced state update (idle can fire frequently)
      this.broadcastSessionStateDebounced(session.id);
    });

    // Background task events - use debounced state updates to reduce serialization overhead
    session.on('taskCreated', (task: BackgroundTask) => {
      this.broadcast('task:created', { sessionId: session.id, task });
      this.broadcastSessionStateDebounced(session.id);
    });

    session.on('taskUpdated', (task: BackgroundTask) => {
      // Use batching for better performance at high update rates
      this.batchTaskUpdate(session.id, task);
    });

    session.on('taskCompleted', (task: BackgroundTask) => {
      this.broadcast('task:completed', { sessionId: session.id, task });
      this.broadcastSessionStateDebounced(session.id);
    });

    session.on('taskFailed', (task: BackgroundTask, error: string) => {
      this.broadcast('task:failed', { sessionId: session.id, task, error });
      this.broadcastSessionStateDebounced(session.id);
    });

    session.on('autoClear', (data: { tokens: number; threshold: number }) => {
      this.broadcast('session:autoClear', { sessionId: session.id, ...data });
      this.broadcastSessionStateDebounced(session.id);
    });

    session.on('autoCompact', (data: { tokens: number; threshold: number; prompt?: string }) => {
      this.broadcast('session:autoCompact', { sessionId: session.id, ...data });
      this.broadcastSessionStateDebounced(session.id);
    });

    // Ralph tracking events
    session.on('ralphLoopUpdate', (state: RalphTrackerState) => {
      this.broadcast('session:ralphLoopUpdate', { sessionId: session.id, state });
      // Persist Ralph state
      this.store.updateRalphState(session.id, { loop: state });
    });

    session.on('ralphTodoUpdate', (todos: RalphTodoItem[]) => {
      this.broadcast('session:ralphTodoUpdate', { sessionId: session.id, todos });
      // Persist Ralph state
      this.store.updateRalphState(session.id, { todos });
    });

    session.on('ralphCompletionDetected', (phrase: string) => {
      this.broadcast('session:ralphCompletionDetected', { sessionId: session.id, phrase });
    });
  }

  private setupRespawnListeners(sessionId: string, controller: RespawnController): void {
    controller.on('stateChanged', (state: RespawnState, prevState: RespawnState) => {
      this.broadcast('respawn:stateChanged', { sessionId, state, prevState });
    });

    controller.on('respawnCycleStarted', (cycleNumber: number) => {
      this.broadcast('respawn:cycleStarted', { sessionId, cycleNumber });
    });

    controller.on('respawnCycleCompleted', (cycleNumber: number) => {
      this.broadcast('respawn:cycleCompleted', { sessionId, cycleNumber });
    });

    controller.on('stepSent', (step: string, input: string) => {
      this.broadcast('respawn:stepSent', { sessionId, step, input });
    });

    controller.on('stepCompleted', (step: string) => {
      this.broadcast('respawn:stepCompleted', { sessionId, step });
    });

    controller.on('detectionUpdate', (detection: unknown) => {
      this.broadcast('respawn:detectionUpdate', { sessionId, detection });
    });

    controller.on('log', (message: string) => {
      this.broadcast('respawn:log', { sessionId, message });
    });

    controller.on('error', (error: Error) => {
      this.broadcast('respawn:error', { sessionId, error: error.message });
    });
  }

  private setupTimedRespawn(sessionId: string, durationMinutes: number): void {
    // Clear existing timer if any
    const existing = this.respawnTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const now = Date.now();
    const endAt = now + durationMinutes * 60 * 1000;

    const timer = setTimeout(() => {
      // Stop respawn when time is up
      const controller = this.respawnControllers.get(sessionId);
      if (controller) {
        controller.stop();
        this.broadcast('respawn:stopped', { sessionId, reason: 'duration_expired' });
      }
      this.respawnTimers.delete(sessionId);
      // Update persisted state (respawn no longer active)
      const session = this.sessions.get(sessionId);
      if (session) {
        this.persistSessionState(session);
      }
    }, durationMinutes * 60 * 1000);

    this.respawnTimers.set(sessionId, { timer, endAt, startedAt: now });
    this.broadcast('respawn:timerStarted', { sessionId, durationMinutes, endAt, startedAt: now });
  }

  // Helper to get custom CLAUDE.md template path from settings
  private getDefaultClaudeMdPath(): string | undefined {
    const settingsPath = join(homedir(), '.claudeman', 'settings.json');
    // Default template path (can be overridden in settings)
    const defaultPath = '/home/arkon/default/CLAUDE.md';

    try {
      if (existsSync(settingsPath)) {
        const content = readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        if (settings.defaultClaudeMdPath) {
          return settings.defaultClaudeMdPath;
        }
      }
      // Use default path if it exists
      if (existsSync(defaultPath)) {
        return defaultPath;
      }
    } catch (err) {
      console.error('Failed to read settings:', err);
    }
    return undefined;
  }

  private async startScheduledRun(prompt: string, workingDir: string, durationMinutes: number): Promise<ScheduledRun> {
    const id = uuidv4();
    const now = Date.now();

    const run: ScheduledRun = {
      id,
      prompt,
      workingDir,
      durationMinutes,
      startedAt: now,
      endAt: now + durationMinutes * 60 * 1000,
      status: 'running',
      sessionId: null,
      completedTasks: 0,
      totalCost: 0,
      logs: [`[${new Date().toISOString()}] Scheduled run started`],
    };

    this.scheduledRuns.set(id, run);
    this.broadcast('scheduled:created', run);

    // Start the run loop
    this.runScheduledLoop(id);

    return run;
  }

  private async runScheduledLoop(runId: string): Promise<void> {
    const run = this.scheduledRuns.get(runId);
    if (!run || run.status !== 'running') return;

    const addLog = (msg: string) => {
      run.logs.push(`[${new Date().toISOString()}] ${msg}`);
      this.broadcast('scheduled:log', { id: runId, log: run.logs[run.logs.length - 1] });
    };

    while (Date.now() < run.endAt && run.status === 'running') {
      // Check session limit before creating new session
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        addLog(`Waiting: maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      let session: Session | null = null;
      try {
        // Create a session for this iteration
        session = new Session({ workingDir: run.workingDir });
        this.sessions.set(session.id, session);
        this.persistSessionState(session);
        this.setupSessionListeners(session);
        run.sessionId = session.id;

        addLog(`Starting task iteration with session ${session.id.slice(0, 8)}`);
        this.broadcast('scheduled:updated', run);

        // Run the prompt
        const timeRemaining = Math.round((run.endAt - Date.now()) / 60000);
        const enhancedPrompt = `${run.prompt}\n\nNote: You have approximately ${timeRemaining} minutes remaining in this scheduled run. Work efficiently.`;

        const result = await session.runPrompt(enhancedPrompt);
        run.completedTasks++;
        run.totalCost += result.cost;

        addLog(`Task completed. Cost: $${result.cost.toFixed(4)}. Total tasks: ${run.completedTasks}`);
        this.broadcast('scheduled:updated', run);

        // Clean up the session after iteration to prevent memory leaks
        await this.cleanupSession(session.id);
        run.sessionId = null;

        // Small pause between iterations
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        addLog(`Error: ${getErrorMessage(err)}`);
        this.broadcast('scheduled:updated', run);

        // Clean up the session on error too
        if (session) {
          try {
            await this.cleanupSession(session.id);
          } catch {
            // Ignore cleanup errors
          }
          run.sessionId = null;
        }

        // Continue despite errors
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (run.status === 'running') {
      run.status = 'completed';
      addLog(`Scheduled run completed. Total tasks: ${run.completedTasks}, Total cost: $${run.totalCost.toFixed(4)}`);
    }

    this.broadcast('scheduled:completed', run);
  }

  private async stopScheduledRun(id: string): Promise<void> {
    const run = this.scheduledRuns.get(id);
    if (!run) return;

    run.status = 'stopped';
    run.logs.push(`[${new Date().toISOString()}] Run stopped by user`);

    // Use cleanupSession for proper resource cleanup (listeners, respawn, etc.)
    if (run.sessionId && this.sessions.has(run.sessionId)) {
      await this.cleanupSession(run.sessionId);
      run.sessionId = null;
    }

    this.broadcast('scheduled:stopped', run);
  }

  private getSessionsState() {
    return Array.from(this.sessions.values()).map(s => s.toDetailedState());
  }

  // Clean up old completed scheduled runs
  private cleanupScheduledRuns(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, run] of this.scheduledRuns) {
      // Only clean up completed, failed, or stopped runs
      if (run.status !== 'running') {
        const age = now - (run.endAt || run.startedAt);
        if (age > SCHEDULED_RUN_MAX_AGE) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      this.scheduledRuns.delete(id);
      this.broadcast('scheduled:deleted', { id });
    }

    if (toDelete.length > 0) {
      console.log(`[Server] Cleaned up ${toDelete.length} old scheduled run(s)`);
    }
  }

  private getFullState() {
    // Build respawn status map
    const respawnStatus: Record<string, ReturnType<RespawnController['getStatus']>> = {};
    for (const [sessionId, controller] of this.respawnControllers) {
      respawnStatus[sessionId] = controller.getStatus();
    }

    return {
      sessions: this.getSessionsState(),
      scheduledRuns: Array.from(this.scheduledRuns.values()),
      respawnStatus,
      timestamp: Date.now(),
    };
  }

  private sendSSE(reply: FastifyReply, event: string, data: unknown): void {
    try {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.sseClients.delete(reply);
    }
  }

  // Optimized: send pre-formatted SSE message to a client
  private sendSSEPreformatted(reply: FastifyReply, message: string): void {
    try {
      reply.raw.write(message);
    } catch {
      this.sseClients.delete(reply);
    }
  }

  private broadcast(event: string, data: unknown): void {
    // Performance optimization: serialize JSON once for all clients
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      this.sendSSEPreformatted(client, message);
    }
  }

  // Batch terminal data for better performance (60fps)
  // Flushes immediately if batch > 1KB for snappier response to large outputs
  private batchTerminalData(sessionId: string, data: string): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    const existing = this.terminalBatches.get(sessionId) || '';
    const newBatch = existing + data;
    this.terminalBatches.set(sessionId, newBatch);

    // Flush immediately if batch is large (>1KB) for responsiveness
    if (newBatch.length > 1024) {
      if (this.terminalBatchTimer) {
        clearTimeout(this.terminalBatchTimer);
        this.terminalBatchTimer = null;
      }
      this.flushTerminalBatches();
      return;
    }

    // Start batch timer if not already running (16ms = 60fps)
    if (!this.terminalBatchTimer) {
      this.terminalBatchTimer = setTimeout(() => {
        this.flushTerminalBatches();
        this.terminalBatchTimer = null;
      }, TERMINAL_BATCH_INTERVAL);
    }
  }

  private flushTerminalBatches(): void {
    for (const [sessionId, data] of this.terminalBatches) {
      if (data.length > 0) {
        this.broadcast('session:terminal', { id: sessionId, data });
      }
    }
    this.terminalBatches.clear();
  }

  // Batch session:output events at 50ms for better performance
  private batchOutputData(sessionId: string, data: string): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    const existing = this.outputBatches.get(sessionId) || '';
    this.outputBatches.set(sessionId, existing + data);

    if (!this.outputBatchTimer) {
      this.outputBatchTimer = setTimeout(() => {
        this.flushOutputBatches();
        this.outputBatchTimer = null;
      }, OUTPUT_BATCH_INTERVAL);
    }
  }

  private flushOutputBatches(): void {
    for (const [sessionId, data] of this.outputBatches) {
      if (data.length > 0) {
        this.broadcast('session:output', { id: sessionId, data });
      }
    }
    this.outputBatches.clear();
  }

  // Batch task:updated events at 100ms - only send latest update per session
  private batchTaskUpdate(sessionId: string, task: BackgroundTask): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    this.taskUpdateBatches.set(sessionId, task);

    if (!this.taskUpdateBatchTimer) {
      this.taskUpdateBatchTimer = setTimeout(() => {
        this.flushTaskUpdateBatches();
        this.taskUpdateBatchTimer = null;
      }, TASK_UPDATE_BATCH_INTERVAL);
    }
  }

  private flushTaskUpdateBatches(): void {
    for (const [sessionId, task] of this.taskUpdateBatches) {
      this.broadcast('task:updated', { sessionId, task });
    }
    this.taskUpdateBatches.clear();
  }

  /**
   * Debounce expensive session:updated broadcasts.
   * Instead of calling toDetailedState() on every event, batch requests
   * and only serialize once per STATE_UPDATE_DEBOUNCE_INTERVAL.
   */
  private broadcastSessionStateDebounced(sessionId: string): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    this.stateUpdatePending.add(sessionId);

    if (!this.stateUpdateTimer) {
      this.stateUpdateTimer = setTimeout(() => {
        this.flushStateUpdates();
        this.stateUpdateTimer = null;
      }, STATE_UPDATE_DEBOUNCE_INTERVAL);
    }
  }

  private flushStateUpdates(): void {
    for (const sessionId of this.stateUpdatePending) {
      const session = this.sessions.get(sessionId);
      if (session) {
        // Single expensive serialization per batch interval
        this.broadcast('session:updated', session.toDetailedState());
      }
    }
    this.stateUpdatePending.clear();
  }

  /**
   * Clean up dead SSE clients that may not have properly disconnected.
   * This prevents memory leaks from abruptly terminated connections.
   */
  private cleanupDeadSSEClients(): void {
    const deadClients: FastifyReply[] = [];

    for (const client of this.sseClients) {
      try {
        // Check if the underlying socket is still writable
        const socket = client.raw.socket || (client.raw as any).connection;
        if (!socket || socket.destroyed || !socket.writable) {
          deadClients.push(client);
        }
      } catch {
        // Error accessing socket means client is dead
        deadClients.push(client);
      }
    }

    // Remove dead clients
    for (const client of deadClients) {
      this.sseClients.delete(client);
    }

    if (deadClients.length > 0) {
      console.log(`[Server] Cleaned up ${deadClients.length} dead SSE client(s)`);
    }
  }

  async start(): Promise<void> {
    await this.setupRoutes();
    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    console.log(`Claudeman web interface running at http://localhost:${this.port}`);

    // Start scheduled runs cleanup timer
    this.scheduledCleanupTimer = setInterval(() => {
      this.cleanupScheduledRuns();
    }, SCHEDULED_CLEANUP_INTERVAL);

    // Start SSE client health check timer (prevents memory leaks from dead connections)
    this.sseHealthCheckTimer = setInterval(() => {
      this.cleanupDeadSSEClients();
    }, SSE_HEALTH_CHECK_INTERVAL);

    // Restore screen sessions from previous run
    await this.restoreScreenSessions();
  }

  private async restoreScreenSessions(): Promise<void> {
    try {
      // Reconcile screens to find which ones are still alive (also discovers unknown screens)
      const { alive, dead, discovered } = await this.screenManager.reconcileScreens();

      if (discovered.length > 0) {
        console.log(`[Server] Discovered ${discovered.length} unknown screen session(s)`);
      }

      if (alive.length > 0 || discovered.length > 0) {
        console.log(`[Server] Found ${alive.length + discovered.length} alive screen session(s) from previous run`);

        // For each alive screen, create a Session object if it doesn't exist
        const screens = this.screenManager.getScreens();
        for (const screen of screens) {
          if (!this.sessions.has(screen.sessionId)) {
            // Create a session object for this screen with the existing screenSession
            const session = new Session({
              id: screen.sessionId,  // Preserve the original session ID
              workingDir: screen.workingDir,
              mode: screen.mode,
              name: screen.name || screen.screenName,
              screenManager: this.screenManager,
              useScreen: true,
              screenSession: screen  // Pass the existing screen so startInteractive() can attach to it
            });

            // Restore ALL session settings from state.json (single source of truth)
            const savedState = this.store.getSession(screen.sessionId);
            if (savedState) {
              // Auto-compact
              if (savedState.autoCompactEnabled !== undefined || savedState.autoCompactThreshold !== undefined) {
                session.setAutoCompact(
                  savedState.autoCompactEnabled ?? false,
                  savedState.autoCompactThreshold,
                  savedState.autoCompactPrompt
                );
              }
              // Auto-clear
              if (savedState.autoClearEnabled !== undefined || savedState.autoClearThreshold !== undefined) {
                session.setAutoClear(
                  savedState.autoClearEnabled ?? false,
                  savedState.autoClearThreshold
                );
              }
              // Ralph / Todo tracker
              if (savedState.ralphEnabled) {
                session.ralphTracker.enable();
                if (savedState.ralphCompletionPhrase) {
                  session.ralphTracker.startLoop(savedState.ralphCompletionPhrase);
                }
                console.log(`[Server] Restored Ralph tracker for session ${session.id} (phrase: ${savedState.ralphCompletionPhrase || 'none'})`);
              }
              // Respawn controller
              if (savedState.respawnEnabled && savedState.respawnConfig) {
                try {
                  const controller = new RespawnController(session, {
                    idleTimeoutMs: savedState.respawnConfig.idleTimeoutMs,
                    updatePrompt: savedState.respawnConfig.updatePrompt,
                    interStepDelayMs: savedState.respawnConfig.interStepDelayMs,
                    enabled: true,
                    sendClear: savedState.respawnConfig.sendClear,
                    sendInit: savedState.respawnConfig.sendInit,
                    kickstartPrompt: savedState.respawnConfig.kickstartPrompt,
                    completionConfirmMs: savedState.respawnConfig.completionConfirmMs,
                    noOutputTimeoutMs: savedState.respawnConfig.noOutputTimeoutMs,
                  });
                  this.respawnControllers.set(session.id, controller);
                  this.setupRespawnListeners(session.id, controller);
                  controller.start();

                  if (savedState.respawnConfig.durationMinutes && savedState.respawnConfig.durationMinutes > 0) {
                    this.setupTimedRespawn(session.id, savedState.respawnConfig.durationMinutes);
                  }

                  console.log(`[Server] Restored respawn controller for session ${session.id}`);
                } catch (err) {
                  console.error(`[Server] Failed to restore respawn for session ${session.id}:`, err);
                }
              }
            }

            // Fallback: restore Ralph state from state-inner.json if not already set
            if (!session.ralphTracker.enabled) {
              const ralphState = this.store.getRalphState(screen.sessionId);
              if (ralphState?.loop?.enabled) {
                session.ralphTracker.restoreState(ralphState.loop, ralphState.todos);
                console.log(`[Server] Restored Ralph state from inner store for session ${session.id}`);
              }
            }

            // Fallback: auto-detect completion phrase from CLAUDE.md
            if (session.ralphTracker.enabled && !session.ralphTracker.loopState.completionPhrase) {
              const claudeMdPath = join(session.workingDir, 'CLAUDE.md');
              const completionPhrase = extractCompletionPhrase(claudeMdPath);
              if (completionPhrase) {
                session.ralphTracker.startLoop(completionPhrase);
                console.log(`[Server] Auto-detected completion phrase for session ${session.id}: ${completionPhrase}`);
              }
            }

            this.sessions.set(session.id, session);
            this.setupSessionListeners(session);
            this.persistSessionState(session);

            // Mark it as restored (not started yet - user needs to attach)
            console.log(`[Server] Restored session ${session.id} from screen ${screen.screenName}`);
          }
        }

        // Start stats collection to show screen info
        this.screenManager.startStatsCollection(2000);
      }

      if (dead.length > 0) {
        console.log(`[Server] Cleaned up ${dead.length} dead screen session(s)`);
      }
    } catch (err) {
      console.error('[Server] Failed to restore screen sessions:', err);
    }
  }

  async stop(): Promise<void> {
    // Set stopping flag to prevent new timer creation during shutdown
    this._isStopping = true;

    // Clear SSE health check timer
    if (this.sseHealthCheckTimer) {
      clearInterval(this.sseHealthCheckTimer);
      this.sseHealthCheckTimer = null;
    }

    // Clear all SSE clients
    this.sseClients.clear();

    // Clear batch timers
    if (this.terminalBatchTimer) {
      clearTimeout(this.terminalBatchTimer);
      this.terminalBatchTimer = null;
    }
    this.terminalBatches.clear();

    if (this.outputBatchTimer) {
      clearTimeout(this.outputBatchTimer);
      this.outputBatchTimer = null;
    }
    this.outputBatches.clear();

    if (this.taskUpdateBatchTimer) {
      clearTimeout(this.taskUpdateBatchTimer);
      this.taskUpdateBatchTimer = null;
    }
    this.taskUpdateBatches.clear();

    if (this.stateUpdateTimer) {
      clearTimeout(this.stateUpdateTimer);
      this.stateUpdateTimer = null;
    }
    this.stateUpdatePending.clear();

    // Clear scheduled cleanup timer
    if (this.scheduledCleanupTimer) {
      clearInterval(this.scheduledCleanupTimer);
      this.scheduledCleanupTimer = null;
    }

    // Stop screen stats collection
    this.screenManager.stopStatsCollection();

    // Stop all respawn controllers and remove listeners
    for (const controller of this.respawnControllers.values()) {
      controller.stop();
      controller.removeAllListeners();
    }
    this.respawnControllers.clear();

    // Stop all scheduled runs first (they have their own session cleanup)
    for (const [id] of this.scheduledRuns) {
      await this.stopScheduledRun(id);
    }

    // Properly clean up all remaining sessions (removes listeners, clears state, etc.)
    // Don't kill screens on server stop - they can be reattached on restart
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.cleanupSession(sessionId, false);
    }

    // Flush state store to prevent data loss from debounced saves
    this.store.flushAll();

    await this.app.close();
  }
}

export async function startWebServer(port: number = 3000): Promise<WebServer> {
  const server = new WebServer(port);
  await server.start();
  return server;
}
