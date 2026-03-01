/**
 * @fileoverview Codeman web server and REST API
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
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  Session,
  ClaudeMessage,
  type BackgroundTask,
  type RalphTrackerState,
  type RalphTodoItem,
  type ActiveBashTool,
} from '../session.js';
import type { ClaudeMode } from '../types.js';
import { RespawnController, RespawnConfig, RespawnState } from '../respawn-controller.js';
import type { TerminalMultiplexer } from '../mux-interface.js';
import { createMultiplexer } from '../mux-factory.js';
import { getStore } from '../state-store.js';
import { extractCompletionPhrase } from '../ralph-config.js';
import { fileStreamManager } from '../file-stream-manager.js';
import {
  subagentWatcher,
  type SubagentInfo,
  type SubagentToolCall,
  type SubagentProgress,
  type SubagentMessage,
  type SubagentToolResult,
} from '../subagent-watcher.js';
import { imageWatcher } from '../image-watcher.js';
import { TranscriptWatcher } from '../transcript-watcher.js';
import { TeamWatcher } from '../team-watcher.js';
import { TunnelManager } from '../tunnel-manager.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'node:module';
import { RunSummaryTracker } from '../run-summary.js';
import { PlanOrchestrator } from '../plan-orchestrator.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { PushSubscriptionStore } from '../push-store.js';
import webpush from 'web-push';

// Load version from package.json
const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json');
import {
  getErrorMessage,
  ApiErrorCode,
  createErrorResponse,
  type PersistedRespawnConfig,
  type NiceConfig,
  type ImageDetectedEvent,
  DEFAULT_NICE_CONFIG,
} from '../types.js';
import { CleanupManager, KeyedDebouncer, StaleExpirationMap } from '../utils/index.js';
import { MAX_CONCURRENT_SESSIONS, MAX_SSE_CLIENTS } from '../config/map-limits.js';
import type { ScheduledRun } from './ports/index.js';
import { registerAuthMiddleware, registerSecurityHeaders } from './middleware/auth.js';
import {
  registerPushRoutes,
  registerTeamRoutes,
  registerMuxRoutes,
  registerFileRoutes,
  registerScheduledRoutes,
  registerHookEventRoutes,
  registerSystemRoutes,
  registerCaseRoutes,
  registerSessionRoutes,
  registerRespawnRoutes,
  registerRalphRoutes,
  registerPlanRoutes,
} from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  TERMINAL_BATCH_INTERVAL,
  TASK_UPDATE_BATCH_INTERVAL,
  STATE_UPDATE_DEBOUNCE_INTERVAL,
  SESSIONS_LIST_CACHE_TTL,
  SCHEDULED_CLEANUP_INTERVAL,
  SCHEDULED_RUN_MAX_AGE,
  SSE_HEARTBEAT_INTERVAL,
  SSE_PADDING_SIZE,
  SESSION_LIMIT_WAIT_MS,
  ITERATION_PAUSE_MS,
  BATCH_FLUSH_THRESHOLD,
  STATS_COLLECTION_INTERVAL_MS,
} from '../config/server-timing.js';

// DEC mode 2026 - Synchronized Output
// When terminal supports this, it buffers all output between start/end markers
// and renders atomically, eliminating partial-frame flicker from Ink redraws.
// Supported by: WezTerm, Kitty, Ghostty, iTerm2 3.5+, Windows Terminal, VSCode terminal
const DEC_SYNC_START = '\x1b[?2026h'; // Begin synchronized update
const DEC_SYNC_END = '\x1b[?2026l'; // End synchronized update (flush to screen)

// SSE padding for Cloudflare tunnel buffer flushing.
// Cloudflare quick tunnels buffer small SSE responses, causing lag for real-time events.
// Appending SSE comment padding (ignored by EventSource) forces the proxy to flush.
// Pre-computed once at startup to avoid repeated string allocation.
const SSE_PADDING = ':' + 'p'.repeat(SSE_PADDING_SIZE) + '\n';

/**
 * Get or generate a self-signed TLS certificate for HTTPS.
 * Certs are stored in ~/.codeman/certs/ and reused across restarts.
 */
function getOrCreateSelfSignedCert(): { key: string; cert: string } {
  const certsDir = join(homedir(), '.codeman', 'certs');
  const keyPath = join(certsDir, 'server.key');
  const certPath = join(certsDir, 'server.crt');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, 'utf-8'),
      cert: readFileSync(certPath, 'utf-8'),
    };
  }

  mkdirSync(certsDir, { recursive: true, mode: 0o700 });

  // Generate self-signed cert valid for 365 days, covering localhost and common LAN access patterns
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes ` +
      `-keyout "${keyPath}" -out "${certPath}" ` +
      `-days 365 -subj "/CN=codeman" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0"`,
    { stdio: 'pipe' }
  );

  // Restrict private key to owner-only (prevent other local users from reading it)
  chmodSync(keyPath, 0o600);

  return {
    key: readFileSync(keyPath, 'utf-8'),
    cert: readFileSync(certPath, 'utf-8'),
  };
}

/** Stored listener references for session cleanup (prevents memory leaks) */
interface SessionListenerRefs {
  terminal: (data: string) => void;
  clearTerminal: () => void;
  needsRefresh: () => void;
  message: (msg: ClaudeMessage) => void;
  error: (error: string) => void;
  completion: (result: string, cost: number) => void;
  exit: (code: number | null) => void;
  working: () => void;
  idle: () => void;
  taskCreated: (task: BackgroundTask) => void;
  taskUpdated: (task: BackgroundTask) => void;
  taskCompleted: (task: BackgroundTask) => void;
  taskFailed: (task: BackgroundTask, error: string) => void;
  autoClear: (data: { tokens: number; threshold: number }) => void;
  autoCompact: (data: { tokens: number; threshold: number; prompt?: string }) => void;
  cliInfoUpdated: (data: { version?: string; model?: string; accountType?: string; latestVersion?: string }) => void;
  ralphLoopUpdate: (state: RalphTrackerState) => void;
  ralphTodoUpdate: (todos: RalphTodoItem[]) => void;
  ralphCompletionDetected: (phrase: string) => void;
  ralphStatusBlockDetected: (block: import('../types.js').RalphStatusBlock) => void;
  ralphCircuitBreakerUpdate: (status: import('../types.js').CircuitBreakerStatus) => void;
  ralphExitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  bashToolStart: (tool: ActiveBashTool) => void;
  bashToolEnd: (tool: ActiveBashTool) => void;
  bashToolsUpdate: (tools: ActiveBashTool[]) => void;
}

export class WebServer extends EventEmitter {
  private app: FastifyInstance;
  private sessions: Map<string, Session> = new Map();
  private respawnControllers: Map<string, RespawnController> = new Map();
  private respawnTimers: Map<string, { timer: NodeJS.Timeout; endAt: number; startedAt: number }> = new Map();
  private runSummaryTrackers: Map<string, RunSummaryTracker> = new Map();
  private transcriptWatchers: Map<string, TranscriptWatcher> = new Map();
  // Store session listener references for explicit cleanup (prevents memory leaks)
  private sessionListenerRefs: Map<string, SessionListenerRefs> = new Map();
  private scheduledRuns: Map<string, ScheduledRun> = new Map();
  private sseClients: Set<FastifyReply> = new Set();
  /** Clients with backpressure — skip writes until 'drain' fires */
  private backpressuredClients: Set<FastifyReply> = new Set();
  private store = getStore();
  private port: number;
  private https: boolean;
  private testMode: boolean;
  private mux: TerminalMultiplexer;
  // Terminal batching for performance
  private terminalBatches: Map<string, string[]> = new Map();
  private terminalBatchSizes: Map<string, number> = new Map(); // Running total avoids O(n) reduce per push
  private terminalBatchTimers: Map<string, NodeJS.Timeout> = new Map(); // Per-session timers (staggered flushes)
  // Adaptive batching: track rapid events to extend batch window (per-session)
  // StaleExpirationMap auto-cleans entries for sessions that stop generating output
  private lastTerminalEventTime: StaleExpirationMap<string, number> = new StaleExpirationMap({
    ttlMs: 5 * 60 * 1000, // 5 minutes - auto-expire stale session timing data
    refreshOnGet: false, // Don't refresh on reads, only on explicit sets
  });
  // Centralized cleanup for standalone timers (intervals + resettable timeouts)
  private cleanup = new CleanupManager();
  // SSE event batching
  private taskUpdateBatches: Map<string, { sessionId: string; task: BackgroundTask }> = new Map();
  private taskUpdateBatchTimerId: string | null = null;
  // State update batching (reduce expensive toDetailedState() serialization)
  private stateUpdatePending: Set<string> = new Set();
  private stateUpdateTimerId: string | null = null;
  // Flag to prevent new timers during shutdown
  private _isStopping: boolean = false;
  // Cached light state for SSE init (avoids rebuilding on every reconnect)
  private cachedLightState: { data: Record<string, unknown>; timestamp: number } | null = null;
  private static readonly LIGHT_STATE_CACHE_TTL_MS = 1000;
  // Cached sessions list for getLightSessionsState() (avoids re-serializing all sessions on every call)
  private cachedSessionsList: { data: unknown[]; timestamp: number } | null = null;
  // Token recording for daily stats (track what's been recorded to avoid double-counting)
  private lastRecordedTokens: Map<string, { input: number; output: number }> = new Map();
  // Server startup time for respawn grace period calculation
  private readonly serverStartTime: number = Date.now();
  // Pending respawn start timers (for cleanup on shutdown)
  private pendingRespawnStarts: Map<string, NodeJS.Timeout> = new Map();
  // Active plan orchestrators (for cancellation via API)
  private activePlanOrchestrators: Map<string, PlanOrchestrator> = new Map();
  private persistDeb = new KeyedDebouncer(100);
  // Grace period before starting restored respawn controllers (2 minutes)
  private static readonly RESPAWN_RESTORE_GRACE_PERIOD_MS = 2 * 60 * 1000;
  // Stored listener handlers for cleanup
  private subagentWatcherHandlers: {
    discovered: (info: SubagentInfo) => void;
    updated: (info: SubagentInfo) => void;
    toolCall: (data: SubagentToolCall) => void;
    toolResult: (data: SubagentToolResult) => void;
    progress: (data: SubagentProgress) => void;
    message: (data: SubagentMessage) => void;
    completed: (info: SubagentInfo) => void;
    error: (error: Error, agentId?: string) => void;
  } | null = null;
  private imageWatcherHandlers: {
    detected: (event: ImageDetectedEvent) => void;
    error: (error: Error, sessionId?: string) => void;
  } | null = null;
  private tunnelManager: TunnelManager = new TunnelManager();
  private authSessions: StaleExpirationMap<string, import('./ports/auth-port.js').AuthSessionRecord> | null = null;
  private authFailures: StaleExpirationMap<string, number> | null = null;
  private qrAuthFailures: StaleExpirationMap<string, number> | null = null;
  private pushStore: PushSubscriptionStore = new PushSubscriptionStore();
  private teamWatcher: TeamWatcher = new TeamWatcher();
  private teamWatcherHandlers: {
    teamCreated: (config: unknown) => void;
    teamUpdated: (config: unknown) => void;
    teamRemoved: (config: unknown) => void;
    taskUpdated: (data: unknown) => void;
  } | null = null;
  constructor(port: number = 3000, https: boolean = false, testMode: boolean = false) {
    super();
    this.setMaxListeners(0);
    this.port = port;
    this.https = https;
    this.testMode = testMode;

    if (https) {
      const { key, cert } = getOrCreateSelfSignedCert();
      this.app = Fastify({ logger: false, https: { key, cert } });
    } else {
      this.app = Fastify({ logger: false });
    }
    this.mux = createMultiplexer();

    // Set up mux event listeners
    this.mux.on('sessionCreated', (session) => {
      this.broadcast('mux:created', session);
    });
    this.mux.on('sessionKilled', (data) => {
      this.broadcast('mux:killed', data);
    });
    this.mux.on('sessionDied', (data) => {
      getLifecycleLog().log({
        event: 'mux_died',
        sessionId: (data as { sessionId?: string }).sessionId || 'unknown',
        extra: data as Record<string, unknown>,
      });
      this.broadcast('mux:died', data);
    });
    this.mux.on('statsUpdated', (sessions) => {
      this.broadcast('mux:statsUpdated', sessions);
    });

    // Set up subagent watcher listeners
    this.setupSubagentWatcherListeners();

    // Set up image watcher listeners
    this.setupImageWatcherListeners();

    // Set up team watcher listeners
    this.setupTeamWatcherListeners();

    // Set up tunnel manager listeners
    this.tunnelManager.on('started', (data: { url: string }) => {
      this.broadcast('tunnel:started', data);
    });
    this.tunnelManager.on('stopped', () => {
      this.broadcast('tunnel:stopped', {});
    });
    this.tunnelManager.on('error', (message: string) => {
      this.broadcast('tunnel:error', { message });
    });
    this.tunnelManager.on('progress', (data: { message: string }) => {
      this.broadcast('tunnel:progress', data);
    });

    // QR token rotation — broadcast inline SVG for instant desktop refresh
    this.tunnelManager.on('qrTokenRotated', async () => {
      const url = this.tunnelManager.getUrl();
      if (url && process.env.CODEMAN_PASSWORD) {
        try {
          const svg = await this.tunnelManager.getQrSvg(url);
          this.broadcast('tunnel:qrRotated', { svg });
        } catch {
          // QR generation failed — skip this rotation
        }
      }
    });

    this.tunnelManager.on('qrTokenRegenerated', async () => {
      const url = this.tunnelManager.getUrl();
      if (url && process.env.CODEMAN_PASSWORD) {
        try {
          const svg = await this.tunnelManager.getQrSvg(url);
          this.broadcast('tunnel:qrRegenerated', { svg });
        } catch {
          // QR generation failed — skip
        }
      }
    });
  }

  /**
   * Set up event listeners for subagent watcher.
   * Broadcasts real-time subagent activity to SSE clients.
   *
   * The SubagentWatcher now extracts descriptions directly from the parent session's
   * transcript, which contains the exact Task tool call with the description parameter.
   * This is more reliable than the previous timing-based correlation approach.
   */
  private setupSubagentWatcherListeners(): void {
    // Store handlers for cleanup on shutdown
    this.subagentWatcherHandlers = {
      discovered: (info: SubagentInfo) => this.broadcast('subagent:discovered', info),
      updated: (info: SubagentInfo) => this.broadcast('subagent:updated', info),
      toolCall: (data: SubagentToolCall) => this.broadcast('subagent:tool_call', data),
      toolResult: (data: SubagentToolResult) => this.broadcast('subagent:tool_result', data),
      progress: (data: SubagentProgress) => this.broadcast('subagent:progress', data),
      message: (data: SubagentMessage) => this.broadcast('subagent:message', data),
      completed: (info: SubagentInfo) => this.broadcast('subagent:completed', info),
      error: (error: Error, agentId?: string) => {
        console.error(`[SubagentWatcher] Error${agentId ? ` for ${agentId}` : ''}:`, error.message);
      },
    };

    subagentWatcher.on('subagent:discovered', this.subagentWatcherHandlers.discovered);
    subagentWatcher.on('subagent:updated', this.subagentWatcherHandlers.updated);
    subagentWatcher.on('subagent:tool_call', this.subagentWatcherHandlers.toolCall);
    subagentWatcher.on('subagent:tool_result', this.subagentWatcherHandlers.toolResult);
    subagentWatcher.on('subagent:progress', this.subagentWatcherHandlers.progress);
    subagentWatcher.on('subagent:message', this.subagentWatcherHandlers.message);
    subagentWatcher.on('subagent:completed', this.subagentWatcherHandlers.completed);
    subagentWatcher.on('subagent:error', this.subagentWatcherHandlers.error);
  }

  /**
   * Clean up subagent watcher listeners to prevent memory leaks.
   */
  private cleanupSubagentWatcherListeners(): void {
    if (this.subagentWatcherHandlers) {
      subagentWatcher.off('subagent:discovered', this.subagentWatcherHandlers.discovered);
      subagentWatcher.off('subagent:updated', this.subagentWatcherHandlers.updated);
      subagentWatcher.off('subagent:tool_call', this.subagentWatcherHandlers.toolCall);
      subagentWatcher.off('subagent:tool_result', this.subagentWatcherHandlers.toolResult);
      subagentWatcher.off('subagent:progress', this.subagentWatcherHandlers.progress);
      subagentWatcher.off('subagent:message', this.subagentWatcherHandlers.message);
      subagentWatcher.off('subagent:completed', this.subagentWatcherHandlers.completed);
      subagentWatcher.off('subagent:error', this.subagentWatcherHandlers.error);
      this.subagentWatcherHandlers = null;
    }
  }

  /**
   * Set up event listeners for image watcher.
   * Broadcasts image detection events to SSE clients for auto-popup.
   */
  private setupImageWatcherListeners(): void {
    // Store handlers for cleanup on shutdown
    this.imageWatcherHandlers = {
      detected: (event: ImageDetectedEvent) => this.broadcast('image:detected', event),
      error: (error: Error, sessionId?: string) => {
        console.error(`[ImageWatcher] Error${sessionId ? ` for ${sessionId}` : ''}:`, error.message);
      },
    };

    imageWatcher.on('image:detected', this.imageWatcherHandlers.detected);
    imageWatcher.on('image:error', this.imageWatcherHandlers.error);
  }

  /**
   * Clean up image watcher listeners to prevent memory leaks.
   */
  private cleanupImageWatcherListeners(): void {
    if (this.imageWatcherHandlers) {
      imageWatcher.off('image:detected', this.imageWatcherHandlers.detected);
      imageWatcher.off('image:error', this.imageWatcherHandlers.error);
      this.imageWatcherHandlers = null;
    }
  }

  /**
   * Set up event listeners for team watcher.
   * Broadcasts team activity events to SSE clients.
   */
  private setupTeamWatcherListeners(): void {
    this.teamWatcherHandlers = {
      teamCreated: (config: unknown) => this.broadcast('team:created', config),
      teamUpdated: (config: unknown) => this.broadcast('team:updated', config),
      teamRemoved: (config: unknown) => this.broadcast('team:removed', config),
      taskUpdated: (data: unknown) => this.broadcast('team:taskUpdated', data),
    };

    this.teamWatcher.on('teamCreated', this.teamWatcherHandlers.teamCreated);
    this.teamWatcher.on('teamUpdated', this.teamWatcherHandlers.teamUpdated);
    this.teamWatcher.on('teamRemoved', this.teamWatcherHandlers.teamRemoved);
    this.teamWatcher.on('taskUpdated', this.teamWatcherHandlers.taskUpdated);
  }

  /**
   * Clean up team watcher listeners to prevent memory leaks.
   */
  private cleanupTeamWatcherListeners(): void {
    if (this.teamWatcherHandlers) {
      this.teamWatcher.off('teamCreated', this.teamWatcherHandlers.teamCreated);
      this.teamWatcher.off('teamUpdated', this.teamWatcherHandlers.teamUpdated);
      this.teamWatcher.off('teamRemoved', this.teamWatcherHandlers.teamRemoved);
      this.teamWatcher.off('taskUpdated', this.teamWatcherHandlers.taskUpdated);
      this.teamWatcherHandlers = null;
    }
  }

  /**
   * Build a route context object satisfying all 5 port interfaces.
   * Single object with zero runtime cost — ISP enforced at the type level.
   */
  private createRouteContext() {
    return {
      // SessionPort
      sessions: this.sessions as ReadonlyMap<string, Session>,
      addSession: (session: Session) => {
        this.sessions.set(session.id, session);
      },
      cleanupSession: this.cleanupSession.bind(this),
      setupSessionListeners: this.setupSessionListeners.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      persistSessionStateNow: this._persistSessionStateNow.bind(this),
      getSessionStateWithRespawn: this.getSessionStateWithRespawn.bind(this),
      // EventPort
      broadcast: this.broadcast.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      batchTerminalData: this.batchTerminalData.bind(this),
      broadcastSessionStateDebounced: this.broadcastSessionStateDebounced.bind(this),
      batchTaskUpdate: this.batchTaskUpdate.bind(this),
      // RespawnPort
      respawnControllers: this.respawnControllers,
      respawnTimers: this.respawnTimers,
      setupRespawnListeners: this.setupRespawnListeners.bind(this),
      setupTimedRespawn: this.setupTimedRespawn.bind(this),
      restoreRespawnController: this.restoreRespawnController.bind(this),
      saveRespawnConfig: this.saveRespawnConfig.bind(this),
      // ConfigPort
      store: this.store,
      port: this.port,
      https: this.https,
      testMode: this.testMode,
      serverStartTime: this.serverStartTime,
      getGlobalNiceConfig: this.getGlobalNiceConfig.bind(this),
      getModelConfig: this.getModelConfig.bind(this),
      getClaudeModeConfig: this.getClaudeModeConfig.bind(this),
      getDefaultClaudeMdPath: this.getDefaultClaudeMdPath.bind(this),
      getLightState: this.getLightState.bind(this),
      getLightSessionsState: this.getLightSessionsState.bind(this),
      startTranscriptWatcher: this.startTranscriptWatcher.bind(this),
      stopTranscriptWatcher: this.stopTranscriptWatcher.bind(this),
      // InfraPort
      mux: this.mux,
      runSummaryTrackers: this.runSummaryTrackers,
      activePlanOrchestrators: this.activePlanOrchestrators,
      scheduledRuns: this.scheduledRuns,
      teamWatcher: this.teamWatcher,
      tunnelManager: this.tunnelManager,
      pushStore: this.pushStore,
      startScheduledRun: this.startScheduledRun.bind(this),
      stopScheduledRun: this.stopScheduledRun.bind(this),
      // AuthPort
      authSessions: this.authSessions,
      qrAuthFailures: this.qrAuthFailures,
    };
  }

  private async setupRoutes(): Promise<void> {
    // Allow multipart/form-data for screenshot uploads — skip Fastify's body parser
    // so the route handler can read the raw stream directly.
    this.app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => {
      done(null);
    });

    // Enable gzip/brotli compression for all responses.
    // Massive win: 793KB uncompressed → ~120KB compressed for static assets.
    // Threshold 1024 = don't compress tiny responses (headers > savings).
    await this.app.register(fastifyCompress, {
      threshold: 1024,
    });

    // Cookie plugin (needed for auth session tokens)
    await this.app.register(fastifyCookie);

    // Auth middleware (Basic Auth + session cookies + rate limiting)
    const authState = registerAuthMiddleware(this.app, this.https);
    if (authState) {
      this.authSessions = authState.authSessions;
      this.authFailures = authState.authFailures;
      this.qrAuthFailures = authState.qrAuthFailures;
    }

    // Security headers + CORS
    registerSecurityHeaders(this.app, this.https);
    // Service worker must never be cached — browsers check for SW updates on navigation
    this.app.get('/sw.js', async (_req, reply) => {
      return reply
        .header('Cache-Control', 'no-cache, no-store')
        .header('Service-Worker-Allowed', '/')
        .type('application/javascript')
        .sendFile('sw.js', join(__dirname, 'public'));
    });

    // Serve static files — versioned assets (?v=X) are immutable, cache aggressively
    // preCompressed: serve pre-built .br/.gz files (from build step) to avoid per-request CPU compression
    await this.app.register(fastifyStatic, {
      root: join(__dirname, 'public'),
      prefix: '/',
      maxAge: '1y',
      immutable: true,
      preCompressed: true,
    });

    // SSE endpoint for real-time updates
    this.app.get('/api/events', (req, reply) => {
      // Enforce SSE client limit to prevent memory exhaustion from too many connections
      if (this.sseClients.size >= MAX_SSE_CLIENTS) {
        reply.code(503).send('Too many SSE connections');
        return;
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });

      this.sseClients.add(reply);

      // Send initial state
      // Use light state for SSE init to avoid sending 2MB+ terminal buffers
      // Buffers are fetched on-demand when switching tabs
      this.sendSSE(reply, 'init', this.getLightState());
      // Flush Cloudflare tunnel buffer with padding — ensures the init event
      // (and any immediately following events) are delivered without proxy delay.
      try { reply.raw.write(SSE_PADDING); } catch { /* client gone */ }

      req.raw.on('close', () => {
        this.sseClients.delete(reply);
        this.backpressuredClients.delete(reply);
      });
    });

    // Global error handler for structured errors thrown by findSessionOrFail
    this.app.setErrorHandler((error, _req, reply) => {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      const body = (error as { body?: unknown }).body;
      if (body) {
        reply.code(statusCode).send(body);
      } else {
        reply.code(statusCode).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(error)));
      }
    });

    // Register all route modules
    const ctx = this.createRouteContext();
    registerPushRoutes(this.app, ctx);
    registerTeamRoutes(this.app, ctx);
    registerMuxRoutes(this.app, ctx);
    registerFileRoutes(this.app, ctx);
    registerScheduledRoutes(this.app, ctx);
    registerHookEventRoutes(this.app, ctx);
    registerSystemRoutes(this.app, ctx);
    registerCaseRoutes(this.app, ctx);
    registerSessionRoutes(this.app, ctx);
    registerRespawnRoutes(this.app, ctx);
    registerRalphRoutes(this.app, ctx);
    registerPlanRoutes(this.app, ctx);
  }

  /**
   * Start a transcript watcher for a session.
   * Creates a new watcher or updates an existing one with the new transcript path.
   */
  private startTranscriptWatcher(sessionId: string, transcriptPath: string): void {
    let watcher = this.transcriptWatchers.get(sessionId);

    if (!watcher) {
      watcher = new TranscriptWatcher();

      // Wire up transcript events to the respawn controller
      watcher.on('transcript:complete', () => {
        const controller = this.respawnControllers.get(sessionId);
        if (controller) {
          controller.signalTranscriptComplete();
        }
        this.broadcast('transcript:complete', { sessionId, timestamp: Date.now() });
      });

      watcher.on('transcript:plan_mode', () => {
        const controller = this.respawnControllers.get(sessionId);
        if (controller) {
          controller.signalTranscriptPlanMode();
        }
        this.broadcast('transcript:plan_mode', { sessionId, timestamp: Date.now() });
      });

      watcher.on('transcript:tool_start', (toolName: string) => {
        this.broadcast('transcript:tool_start', { sessionId, toolName, timestamp: Date.now() });
      });

      watcher.on('transcript:tool_end', (toolName: string, isError: boolean) => {
        this.broadcast('transcript:tool_end', {
          sessionId,
          toolName,
          isError,
          timestamp: Date.now(),
        });
      });

      watcher.on('transcript:error', (error: Error) => {
        console.error(`[Transcript] Error for session ${sessionId}:`, error.message);
      });

      this.transcriptWatchers.set(sessionId, watcher);
    }

    // Start or update the watcher with the transcript path
    watcher.updatePath(transcriptPath);
  }

  /**
   * Stop the transcript watcher for a session.
   */
  private stopTranscriptWatcher(sessionId: string): void {
    const watcher = this.transcriptWatchers.get(sessionId);
    if (watcher) {
      watcher.removeAllListeners(); // Prevent memory leaks from attached listeners
      watcher.stop();
      this.transcriptWatchers.delete(sessionId);
    }
  }

  /** Debounced wrapper — coalesces rapid persistSessionState calls per session */
  private persistSessionState(session: Session): void {
    this.persistDeb.schedule(session.id, () => {
      // Session may have been removed during debounce
      if (this.sessions.has(session.id)) {
        this._persistSessionStateNow(session);
      }
    });
  }

  /** Persists full session state including respawn config to state.json */
  private _persistSessionStateNow(session: Session): void {
    const state = session.toState();
    const controller = this.respawnControllers.get(session.id);
    if (controller) {
      const config = controller.getConfig();
      const timerInfo = this.respawnTimers.get(session.id);
      const durationMinutes = timerInfo ? Math.round((timerInfo.endAt - timerInfo.startedAt) / 60000) : undefined;
      state.respawnConfig = { ...config, durationMinutes };
      // Use config.enabled instead of controller.state - this way the respawn
      // will be restored on server restart even if it was temporarily stopped
      // due to errors. Intentional stops via /respawn/stop call clearRespawnConfig().
      state.respawnEnabled = config.enabled;
    } else {
      // Don't overwrite respawnConfig if it exists in state - preserve it for restart
      const existingState = this.store.getSession(session.id);
      if (existingState?.respawnConfig) {
        state.respawnConfig = existingState.respawnConfig;
        state.respawnEnabled = existingState.respawnConfig.enabled ?? false;
      } else {
        state.respawnEnabled = false;
      }
    }
    this.store.setSession(session.id, state);
  }

  // Helper to save respawn config to mux session for persistence
  private saveRespawnConfig(sessionId: string, config: RespawnConfig, durationMinutes?: number): void {
    const persistedConfig: PersistedRespawnConfig = {
      enabled: config.enabled,
      idleTimeoutMs: config.idleTimeoutMs,
      updatePrompt: config.updatePrompt,
      interStepDelayMs: config.interStepDelayMs,
      sendClear: config.sendClear,
      sendInit: config.sendInit,
      kickstartPrompt: config.kickstartPrompt,
      autoAcceptPrompts: config.autoAcceptPrompts,
      autoAcceptDelayMs: config.autoAcceptDelayMs,
      completionConfirmMs: config.completionConfirmMs,
      noOutputTimeoutMs: config.noOutputTimeoutMs,
      aiIdleCheckEnabled: config.aiIdleCheckEnabled,
      aiIdleCheckModel: config.aiIdleCheckModel,
      aiIdleCheckMaxContext: config.aiIdleCheckMaxContext,
      aiIdleCheckTimeoutMs: config.aiIdleCheckTimeoutMs,
      aiIdleCheckCooldownMs: config.aiIdleCheckCooldownMs,
      aiPlanCheckEnabled: config.aiPlanCheckEnabled,
      aiPlanCheckModel: config.aiPlanCheckModel,
      aiPlanCheckMaxContext: config.aiPlanCheckMaxContext,
      aiPlanCheckTimeoutMs: config.aiPlanCheckTimeoutMs,
      aiPlanCheckCooldownMs: config.aiPlanCheckCooldownMs,
      durationMinutes,
    };
    this.mux.updateRespawnConfig(sessionId, persistedConfig);
  }

  // Clean up all resources associated with a session
  // Track sessions currently being cleaned up to prevent concurrent cleanup races
  private cleaningUp: Set<string> = new Set();

  private async cleanupSession(sessionId: string, killMux: boolean = true, reason?: string): Promise<void> {
    // Guard against concurrent cleanup of the same session
    if (this.cleaningUp.has(sessionId)) return;
    this.cleaningUp.add(sessionId);

    try {
      await this._doCleanupSession(sessionId, killMux, reason);
    } finally {
      this.cleaningUp.delete(sessionId);
    }
  }

  private async _doCleanupSession(sessionId: string, killMux: boolean, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const lifecycleLog = getLifecycleLog();
    lifecycleLog.log({
      event: killMux ? 'deleted' : 'detached',
      sessionId,
      name: session?.name,
      mode: session?.mode,
      reason: reason || 'unknown',
    });

    // Stop watching @fix_plan.md for this session
    if (session) {
      session.ralphTracker.stopWatchingFixPlan();
    }

    // Kill all subagents spawned by this session (scoped to sessionId to avoid cross-session kills)
    if (session && killMux) {
      try {
        await subagentWatcher.killSubagentsForSession(session.workingDir, sessionId);
      } catch (err) {
        console.error(`[Server] Failed to kill subagents for session ${sessionId}:`, err);
      }
    }

    // Stop and remove respawn controller - but save config first for restart recovery
    const controller = this.respawnControllers.get(sessionId);
    if (controller) {
      // Save the config BEFORE removing controller, so it can be restored on restart
      const config = controller.getConfig();
      const timerInfo = this.respawnTimers.get(sessionId);
      const durationMinutes = timerInfo ? Math.round((timerInfo.endAt - timerInfo.startedAt) / 60000) : undefined;
      this.saveRespawnConfig(sessionId, config, durationMinutes);

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

    // Clear pending respawn start timer (from restoration grace period)
    const pendingStart = this.pendingRespawnStarts.get(sessionId);
    if (pendingStart) {
      clearTimeout(pendingStart);
      this.pendingRespawnStarts.delete(sessionId);
    }

    // Stop transcript watcher
    this.stopTranscriptWatcher(sessionId);

    // Stop and remove run summary tracker
    const summaryTracker = this.runSummaryTrackers.get(sessionId);
    if (summaryTracker) {
      summaryTracker.recordSessionStopped();
      summaryTracker.stop();
      this.runSummaryTrackers.delete(sessionId);
    }

    // Clear pending persist-debounce timer (prevents stale closure holding session ref)
    this.persistDeb.cancelKey(sessionId);

    // Clear batches, per-session timers, and pending state updates
    this.terminalBatches.delete(sessionId);
    this.terminalBatchSizes.delete(sessionId);
    const batchTimer = this.terminalBatchTimers.get(sessionId);
    if (batchTimer) {
      clearTimeout(batchTimer);
      this.terminalBatchTimers.delete(sessionId);
    }
    this.taskUpdateBatches.delete(sessionId);
    this.stateUpdatePending.delete(sessionId);
    this.lastTerminalEventTime.delete(sessionId);

    // Reset Ralph tracker on the session before cleanup
    if (session) {
      session.ralphTracker.fullReset();
    }

    // Clear Ralph state from store
    this.store.removeRalphState(sessionId);

    // Broadcast Ralph cleared to update UI
    this.broadcast('session:ralphLoopUpdate', {
      sessionId,
      state: {
        enabled: false,
        active: false,
        completionPhrase: null,
        startedAt: null,
        cycleCount: 0,
        maxIterations: null,
        lastActivity: Date.now(),
        elapsedHours: null,
      },
    });
    this.broadcast('session:ralphTodoUpdate', {
      sessionId,
      todos: [],
      stats: { total: 0, pending: 0, inProgress: 0, completed: 0 },
    });

    // Stop session and remove listeners
    if (session) {
      // Accumulate tokens to global stats before removing session
      // This preserves lifetime usage even after sessions are deleted
      if (killMux && (session.inputTokens > 0 || session.outputTokens > 0 || session.totalCost > 0)) {
        this.store.addToGlobalStats(session.inputTokens, session.outputTokens, session.totalCost);
        // Record to daily stats (for what hasn't been recorded yet via periodic recording)
        const lastRecorded = this.lastRecordedTokens.get(sessionId) || { input: 0, output: 0 };
        const deltaInput = session.inputTokens - lastRecorded.input;
        const deltaOutput = session.outputTokens - lastRecorded.output;
        if (deltaInput > 0 || deltaOutput > 0) {
          this.store.recordDailyUsage(deltaInput, deltaOutput, sessionId);
        }
        this.lastRecordedTokens.delete(sessionId);
        console.log(
          `[Server] Added to global stats: ${session.inputTokens + session.outputTokens} tokens, $${session.totalCost.toFixed(4)} from session ${sessionId}`
        );
      }

      // Explicitly remove stored listeners to break closure references (prevents memory leak)
      const listeners = this.sessionListenerRefs.get(sessionId);
      if (listeners) {
        session.off('terminal', listeners.terminal);
        session.off('clearTerminal', listeners.clearTerminal);
        session.off('needsRefresh', listeners.needsRefresh);
        session.off('message', listeners.message);
        session.off('error', listeners.error);
        session.off('completion', listeners.completion);
        session.off('exit', listeners.exit);
        session.off('working', listeners.working);
        session.off('idle', listeners.idle);
        session.off('taskCreated', listeners.taskCreated);
        session.off('taskUpdated', listeners.taskUpdated);
        session.off('taskCompleted', listeners.taskCompleted);
        session.off('taskFailed', listeners.taskFailed);
        session.off('autoClear', listeners.autoClear);
        session.off('autoCompact', listeners.autoCompact);
        session.off('cliInfoUpdated', listeners.cliInfoUpdated);
        session.off('ralphLoopUpdate', listeners.ralphLoopUpdate);
        session.off('ralphTodoUpdate', listeners.ralphTodoUpdate);
        session.off('ralphCompletionDetected', listeners.ralphCompletionDetected);
        session.off('ralphStatusBlockDetected', listeners.ralphStatusBlockDetected);
        session.off('ralphCircuitBreakerUpdate', listeners.ralphCircuitBreakerUpdate);
        session.off('ralphExitGateMet', listeners.ralphExitGateMet);
        session.off('bashToolStart', listeners.bashToolStart);
        session.off('bashToolEnd', listeners.bashToolEnd);
        session.off('bashToolsUpdate', listeners.bashToolsUpdate);
        this.sessionListenerRefs.delete(sessionId);
      }

      session.removeAllListeners();
      // Close any active file streams for this session
      fileStreamManager.closeSessionStreams(sessionId);
      // Stop watching for images in this session's directory
      imageWatcher.unwatchSession(sessionId);
      await session.stop(killMux);
      this.sessions.delete(sessionId);
      // Only remove from state.json if we're also killing the mux session.
      // When killMux=false (server shutdown), preserve state for recovery.
      if (killMux) {
        this.store.removeSession(sessionId);
      }
    }

    this.broadcast('session:deleted', { id: sessionId });
  }

  private async setupSessionListeners(session: Session): Promise<void> {
    // Create run summary tracker for this session
    const summaryTracker = new RunSummaryTracker(session.id, session.name);
    this.runSummaryTrackers.set(session.id, summaryTracker);
    summaryTracker.recordSessionStarted(session.mode, session.workingDir);

    // Set working directory for Ralph tracker to auto-load @fix_plan.md (not supported for opencode sessions)
    if (session.mode !== 'opencode') {
      session.ralphTracker.setWorkingDir(session.workingDir);
    }

    // Start watching for new images in this session's working directory (if enabled globally and per-session)
    if ((await this.isImageWatcherEnabled()) && session.imageWatcherEnabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    }

    // Store all listener references for explicit cleanup on session delete
    // This prevents memory leaks from closure references keeping objects alive
    const listeners: SessionListenerRefs = {
      terminal: (data) => {
        // Use batching for better performance at high throughput
        this.batchTerminalData(session.id, data);
      },

      clearTerminal: () => {
        // Tell clients to clear their terminal (after mux attach)
        this.broadcast('session:clearTerminal', { id: session.id });
      },

      needsRefresh: () => {
        // Tell clients to reload the terminal buffer (e.g., after OpenCode TUI stabilizes)
        this.broadcast('session:needsRefresh', { id: session.id });
      },

      message: (msg: ClaudeMessage) => {
        this.broadcast('session:message', { id: session.id, message: msg });
      },

      error: (error) => {
        this.broadcast('session:error', { id: session.id, error });
        this.sendPushNotifications('session:error', {
          sessionId: session.id,
          sessionName: session.name,
          error: String(error),
        });
        // Track in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) tracker.recordError('Session error', String(error));
      },

      completion: (result, cost) => {
        this.broadcast('session:completion', { id: session.id, result, cost });
        this.broadcast('session:updated', this.getSessionStateWithRespawn(session));
        this.persistSessionState(session);
        // Track tokens in run summary (completion event has updated token values)
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) tracker.recordTokens(session.inputTokens, session.outputTokens);
      },

      exit: (code) => {
        getLifecycleLog().log({
          event: 'exit',
          sessionId: session.id,
          name: session.name,
          exitCode: code,
        });
        // Wrap in try/catch to ensure cleanup always happens
        try {
          this.broadcast('session:exit', { id: session.id, code });
          this.broadcast('session:updated', this.getSessionStateWithRespawn(session));
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
          // Also clean up the respawn timer to prevent orphaned timers
          const timerInfo = this.respawnTimers.get(session.id);
          if (timerInfo) {
            clearTimeout(timerInfo.timer);
            this.respawnTimers.delete(session.id);
          }
        } catch (err) {
          console.error(`[Server] Error cleaning up respawn controller for ${session.id}:`, err);
        }

        // Clean up per-session resources that are stale after PTY exit.
        // These are only cleaned by cleanupSession() on explicit delete,
        // so without this they leak when a session exits without deletion.
        try {
          // Transcript watcher is tied to the specific PTY run
          this.stopTranscriptWatcher(session.id);

          // Finalize run summary tracker
          const summaryTracker = this.runSummaryTrackers.get(session.id);
          if (summaryTracker) {
            summaryTracker.recordSessionStopped();
            summaryTracker.stop();
            this.runSummaryTrackers.delete(session.id);
          }

          // Flush/clear terminal batching state (no more output coming)
          this.terminalBatches.delete(session.id);
          this.terminalBatchSizes.delete(session.id);
          const batchTimer = this.terminalBatchTimers.get(session.id);
          if (batchTimer) {
            clearTimeout(batchTimer);
            this.terminalBatchTimers.delete(session.id);
          }
          this.taskUpdateBatches.delete(session.id);
          this.stateUpdatePending.delete(session.id);
          this.lastTerminalEventTime.delete(session.id);

          // Clear pending persist-debounce timer
          this.persistDeb.cancelKey(session.id);

          // Close any active file streams
          fileStreamManager.closeSessionStreams(session.id);

          // Remove stored listener refs to break closure references (prevents memory leak).
          // Without this, the closures capture the Session object (including up to 2MB terminal buffer)
          // and keep it alive even after the PTY exits.
          const listenerRefs = this.sessionListenerRefs.get(session.id);
          if (listenerRefs) {
            session.off('terminal', listenerRefs.terminal);
            session.off('clearTerminal', listenerRefs.clearTerminal);
            session.off('needsRefresh', listenerRefs.needsRefresh);
            session.off('message', listenerRefs.message);
            session.off('error', listenerRefs.error);
            session.off('completion', listenerRefs.completion);
            session.off('exit', listenerRefs.exit);
            session.off('working', listenerRefs.working);
            session.off('idle', listenerRefs.idle);
            session.off('taskCreated', listenerRefs.taskCreated);
            session.off('taskUpdated', listenerRefs.taskUpdated);
            session.off('taskCompleted', listenerRefs.taskCompleted);
            session.off('taskFailed', listenerRefs.taskFailed);
            session.off('autoClear', listenerRefs.autoClear);
            session.off('autoCompact', listenerRefs.autoCompact);
            session.off('cliInfoUpdated', listenerRefs.cliInfoUpdated);
            session.off('ralphLoopUpdate', listenerRefs.ralphLoopUpdate);
            session.off('ralphTodoUpdate', listenerRefs.ralphTodoUpdate);
            session.off('ralphCompletionDetected', listenerRefs.ralphCompletionDetected);
            session.off('ralphStatusBlockDetected', listenerRefs.ralphStatusBlockDetected);
            session.off('ralphCircuitBreakerUpdate', listenerRefs.ralphCircuitBreakerUpdate);
            session.off('ralphExitGateMet', listenerRefs.ralphExitGateMet);
            session.off('bashToolStart', listenerRefs.bashToolStart);
            session.off('bashToolEnd', listenerRefs.bashToolEnd);
            session.off('bashToolsUpdate', listenerRefs.bashToolsUpdate);
            this.sessionListenerRefs.delete(session.id);
          }
        } catch (err) {
          console.error(`[Server] Error cleaning up session resources on exit for ${session.id}:`, err);
        }
      },

      working: () => {
        this.broadcast('session:working', { id: session.id });
        // Track in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) {
          tracker.recordWorking();
          tracker.recordTokens(session.inputTokens, session.outputTokens);
        }
      },

      idle: () => {
        this.broadcast('session:idle', { id: session.id });
        // Use debounced state update (idle can fire frequently)
        this.broadcastSessionStateDebounced(session.id);
        // Track in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) {
          tracker.recordIdle();
          tracker.recordTokens(session.inputTokens, session.outputTokens);
        }
      },

      // Background task events - use debounced state updates to reduce serialization overhead
      taskCreated: (task: BackgroundTask) => {
        this.broadcast('task:created', { sessionId: session.id, task });
        this.broadcastSessionStateDebounced(session.id);
      },

      taskUpdated: (task: BackgroundTask) => {
        // Use batching for better performance at high update rates
        this.batchTaskUpdate(session.id, task);
      },

      taskCompleted: (task: BackgroundTask) => {
        this.broadcast('task:completed', { sessionId: session.id, task });
        this.broadcastSessionStateDebounced(session.id);
      },

      taskFailed: (task: BackgroundTask, error: string) => {
        this.broadcast('task:failed', { sessionId: session.id, task, error });
        this.broadcastSessionStateDebounced(session.id);
      },

      autoClear: (data: { tokens: number; threshold: number }) => {
        this.broadcast('session:autoClear', { sessionId: session.id, ...data });
        this.broadcastSessionStateDebounced(session.id);
        // Track in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) tracker.recordAutoClear(data.tokens, data.threshold);
      },

      autoCompact: (data: { tokens: number; threshold: number; prompt?: string }) => {
        this.broadcast('session:autoCompact', { sessionId: session.id, ...data });
        this.broadcastSessionStateDebounced(session.id);
        // Track in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) tracker.recordAutoCompact(data.tokens, data.threshold);
      },

      // Claude Code CLI info parsed from terminal (version, model, account)
      cliInfoUpdated: (data: { version?: string; model?: string; accountType?: string; latestVersion?: string }) => {
        this.broadcast('session:cliInfo', { sessionId: session.id, ...data });
        this.broadcastSessionStateDebounced(session.id);
      },

      // Ralph tracking events
      ralphLoopUpdate: (state: RalphTrackerState) => {
        this.broadcast('session:ralphLoopUpdate', { sessionId: session.id, state });
        // Persist Ralph state
        this.store.updateRalphState(session.id, { loop: state });
      },

      ralphTodoUpdate: (todos: RalphTodoItem[]) => {
        this.broadcast('session:ralphTodoUpdate', { sessionId: session.id, todos });
        // Persist Ralph state
        this.store.updateRalphState(session.id, { todos });
      },

      ralphCompletionDetected: (phrase: string) => {
        this.broadcast('session:ralphCompletionDetected', { sessionId: session.id, phrase });
        this.sendPushNotifications('session:ralphCompletionDetected', {
          sessionId: session.id,
          sessionName: session.name,
          phrase,
        });
        // Track in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) tracker.recordRalphCompletion(phrase);
      },

      // RALPH_STATUS block events
      ralphStatusBlockDetected: (block: import('../types.js').RalphStatusBlock) => {
        this.broadcast('session:ralphStatusUpdate', { sessionId: session.id, block });
        // Track in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) {
          tracker.addEvent(
            block.status === 'BLOCKED' ? 'warning' : 'idle_detected',
            block.status === 'BLOCKED' ? 'warning' : 'info',
            `Ralph Status: ${block.status}`,
            `Tasks: ${block.tasksCompletedThisLoop}, Files: ${block.filesModified}, Tests: ${block.testsStatus}`
          );
        }
      },

      ralphCircuitBreakerUpdate: (status: import('../types.js').CircuitBreakerStatus) => {
        this.broadcast('session:circuitBreakerUpdate', { sessionId: session.id, status });
        // Track state changes in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker && status.state === 'OPEN') {
          tracker.addEvent('warning', 'warning', 'Circuit Breaker Opened', status.reason);
        }
      },

      ralphExitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => {
        this.broadcast('session:exitGateMet', { sessionId: session.id, ...data });
        // Track in run summary
        const tracker = this.runSummaryTrackers.get(session.id);
        if (tracker) {
          tracker.addEvent(
            'ralph_completion',
            'success',
            'Exit Gate Met',
            `Indicators: ${data.completionIndicators}, EXIT_SIGNAL: ${data.exitSignal}`
          );
        }
      },

      // Bash tool tracking events (for clickable file paths)
      bashToolStart: (tool: ActiveBashTool) => {
        this.broadcast('session:bashToolStart', { sessionId: session.id, tool });
      },

      bashToolEnd: (tool: ActiveBashTool) => {
        this.broadcast('session:bashToolEnd', { sessionId: session.id, tool });
      },

      bashToolsUpdate: (tools: ActiveBashTool[]) => {
        this.broadcast('session:bashToolsUpdate', { sessionId: session.id, tools });
      },
    };

    // Store listener refs for cleanup
    this.sessionListenerRefs.set(session.id, listeners);

    // Attach all listeners to the session
    session.on('terminal', listeners.terminal);
    session.on('clearTerminal', listeners.clearTerminal);
    session.on('needsRefresh', listeners.needsRefresh);
    session.on('message', listeners.message);
    session.on('error', listeners.error);
    session.on('completion', listeners.completion);
    session.on('exit', listeners.exit);
    session.on('working', listeners.working);
    session.on('idle', listeners.idle);
    session.on('taskCreated', listeners.taskCreated);
    session.on('taskUpdated', listeners.taskUpdated);
    session.on('taskCompleted', listeners.taskCompleted);
    session.on('taskFailed', listeners.taskFailed);
    session.on('autoClear', listeners.autoClear);
    session.on('autoCompact', listeners.autoCompact);
    session.on('cliInfoUpdated', listeners.cliInfoUpdated);
    session.on('ralphLoopUpdate', listeners.ralphLoopUpdate);
    session.on('ralphTodoUpdate', listeners.ralphTodoUpdate);
    session.on('ralphCompletionDetected', listeners.ralphCompletionDetected);
    session.on('ralphStatusBlockDetected', listeners.ralphStatusBlockDetected);
    session.on('ralphCircuitBreakerUpdate', listeners.ralphCircuitBreakerUpdate);
    session.on('ralphExitGateMet', listeners.ralphExitGateMet);
    session.on('bashToolStart', listeners.bashToolStart);
    session.on('bashToolEnd', listeners.bashToolEnd);
    session.on('bashToolsUpdate', listeners.bashToolsUpdate);
  }

  private setupRespawnListeners(sessionId: string, controller: RespawnController): void {
    // Wire team watcher for team-aware idle detection
    controller.setTeamWatcher(this.teamWatcher);

    // Helper to get tracker lazily (may not exist at setup time for restored sessions)
    const getTracker = () => this.runSummaryTrackers.get(sessionId);

    controller.on('stateChanged', (state: RespawnState, prevState: RespawnState) => {
      this.broadcast('respawn:stateChanged', { sessionId, state, prevState });
      // Track in run summary (lazy lookup since tracker may be created after controller)
      const tracker = getTracker();
      if (tracker) tracker.recordStateChange(state, `${prevState} → ${state}`);
    });

    controller.on('respawnCycleStarted', (cycleNumber: number) => {
      this.broadcast('respawn:cycleStarted', { sessionId, cycleNumber });
    });

    controller.on('respawnCycleCompleted', (cycleNumber: number) => {
      this.broadcast('respawn:cycleCompleted', { sessionId, cycleNumber });
    });

    controller.on('respawnBlocked', (data: { reason: string; details: string }) => {
      this.broadcast('respawn:blocked', { sessionId, reason: data.reason, details: data.details });
      const sessionForPush = this.sessions.get(sessionId);
      this.sendPushNotifications('respawn:blocked', {
        sessionId,
        sessionName: sessionForPush?.name ?? sessionId.slice(0, 8),
        reason: data.reason,
      });
      // Track in run summary (lazy lookup)
      const tracker = getTracker();
      if (tracker) tracker.recordWarning(`Respawn blocked: ${data.reason}`, data.details);
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

    controller.on('autoAcceptSent', () => {
      this.broadcast('respawn:autoAcceptSent', { sessionId });
    });

    controller.on('aiCheckStarted', () => {
      this.broadcast('respawn:aiCheckStarted', { sessionId });
    });

    controller.on('aiCheckCompleted', (result: { verdict: string; reasoning: string; durationMs: number }) => {
      this.broadcast('respawn:aiCheckCompleted', {
        sessionId,
        verdict: result.verdict,
        reasoning: result.reasoning,
        durationMs: result.durationMs,
      });
      // Track in run summary (lazy lookup)
      const tracker = getTracker();
      if (tracker) tracker.recordAiCheckResult(result.verdict);
    });

    controller.on('aiCheckFailed', (error: string) => {
      this.broadcast('respawn:aiCheckFailed', { sessionId, error });
      // Track in run summary (lazy lookup)
      const tracker = getTracker();
      if (tracker) tracker.recordError('AI check failed', error);
    });

    controller.on('aiCheckCooldown', (active: boolean, endsAt: number | null) => {
      this.broadcast('respawn:aiCheckCooldown', { sessionId, active, endsAt });
    });

    controller.on('planCheckStarted', () => {
      this.broadcast('respawn:planCheckStarted', { sessionId });
    });

    controller.on('planCheckCompleted', (result: { verdict: string; reasoning: string; durationMs: number }) => {
      this.broadcast('respawn:planCheckCompleted', {
        sessionId,
        verdict: result.verdict,
        reasoning: result.reasoning,
        durationMs: result.durationMs,
      });
    });

    controller.on('planCheckFailed', (error: string) => {
      this.broadcast('respawn:planCheckFailed', { sessionId, error });
    });

    // Timer tracking events for UI countdown display
    controller.on('timerStarted', (timer) => {
      this.broadcast('respawn:timerStarted', { sessionId, timer });
    });

    controller.on('timerCancelled', (timerName, reason) => {
      this.broadcast('respawn:timerCancelled', { sessionId, timerName, reason });
    });

    controller.on('timerCompleted', (timerName) => {
      this.broadcast('respawn:timerCompleted', { sessionId, timerName });
    });

    controller.on('actionLog', (action) => {
      this.broadcast('respawn:actionLog', { sessionId, action });
    });

    controller.on('log', (message: string) => {
      this.broadcast('respawn:log', { sessionId, message });
    });

    controller.on('error', (error: Error) => {
      this.broadcast('respawn:error', { sessionId, error: error.message });
      // Track in run summary (lazy lookup)
      const tracker = getTracker();
      if (tracker) tracker.recordError('Respawn error', error.message);
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

    const timer = setTimeout(
      () => {
        // Stop respawn when time is up
        const controller = this.respawnControllers.get(sessionId);
        if (controller) {
          controller.stop();
          controller.removeAllListeners();
          this.respawnControllers.delete(sessionId);
          this.broadcast('respawn:stopped', { sessionId, reason: 'duration_expired' });
        }
        this.respawnTimers.delete(sessionId);
        // Update persisted state (respawn no longer active)
        const session = this.sessions.get(sessionId);
        if (session) {
          this.persistSessionState(session);
        }
      },
      durationMinutes * 60 * 1000
    );

    this.respawnTimers.set(sessionId, { timer, endAt, startedAt: now });
    this.broadcast('respawn:timerStarted', { sessionId, durationMinutes, endAt, startedAt: now });
  }

  /**
   * Restore a RespawnController from persisted configuration.
   * Creates the controller, sets up listeners, but does NOT start it.
   *
   * @param session - The session to attach the controller to
   * @param config - The persisted respawn configuration
   * @param source - Source of the config for logging (e.g., 'state.json' or 'mux-sessions.json')
   */
  private restoreRespawnController(session: Session, config: PersistedRespawnConfig, source: string): void {
    const controller = new RespawnController(session, {
      idleTimeoutMs: config.idleTimeoutMs,
      updatePrompt: config.updatePrompt,
      interStepDelayMs: config.interStepDelayMs,
      enabled: true,
      sendClear: config.sendClear,
      sendInit: config.sendInit,
      kickstartPrompt: config.kickstartPrompt,
      completionConfirmMs: config.completionConfirmMs,
      noOutputTimeoutMs: config.noOutputTimeoutMs,
      autoAcceptPrompts: config.autoAcceptPrompts,
      autoAcceptDelayMs: config.autoAcceptDelayMs,
      aiIdleCheckEnabled: config.aiIdleCheckEnabled,
      aiIdleCheckModel: config.aiIdleCheckModel,
      aiIdleCheckMaxContext: config.aiIdleCheckMaxContext,
      aiIdleCheckTimeoutMs: config.aiIdleCheckTimeoutMs,
      aiIdleCheckCooldownMs: config.aiIdleCheckCooldownMs,
      aiPlanCheckEnabled: config.aiPlanCheckEnabled,
      aiPlanCheckModel: config.aiPlanCheckModel,
      aiPlanCheckMaxContext: config.aiPlanCheckMaxContext,
      aiPlanCheckTimeoutMs: config.aiPlanCheckTimeoutMs,
      aiPlanCheckCooldownMs: config.aiPlanCheckCooldownMs,
    });

    this.respawnControllers.set(session.id, controller);
    this.setupRespawnListeners(session.id, controller);

    // Calculate delay: wait until 2 minutes after server start before starting respawn
    // This prevents false idle detection immediately after a server restart/rebuild
    const timeSinceStart = Date.now() - this.serverStartTime;
    const delayMs = Math.max(0, WebServer.RESPAWN_RESTORE_GRACE_PERIOD_MS - timeSinceStart);

    if (delayMs > 0) {
      console.log(
        `[Server] Restored respawn controller for session ${session.id} from ${source} (will start in ${Math.ceil(delayMs / 1000)}s)`
      );
      const timer = setTimeout(() => {
        this.pendingRespawnStarts.delete(session.id);
        // Verify session still exists (may have been deleted during grace period)
        if (!this.sessions.has(session.id)) {
          console.log(`[Server] Skipping restored respawn start - session ${session.id} no longer exists`);
          return;
        }
        // Double-check controller still exists and is stopped
        const ctrl = this.respawnControllers.get(session.id);
        if (ctrl && ctrl.state === 'stopped') {
          ctrl.start();
          this.broadcast('respawn:started', { sessionId: session.id });
          console.log(`[Server] Restored respawn controller started for session ${session.id}`);
        }
      }, delayMs);
      this.pendingRespawnStarts.set(session.id, timer);
    } else {
      // Grace period has passed, start immediately
      controller.start();
      console.log(
        `[Server] Restored respawn controller for session ${session.id} from ${source} (started immediately)`
      );
    }

    if (config.durationMinutes && config.durationMinutes > 0) {
      this.setupTimedRespawn(session.id, config.durationMinutes);
    }
  }

  // Helper to get custom CLAUDE.md template path from settings
  private async getDefaultClaudeMdPath(): Promise<string | undefined> {
    const settingsPath = join(homedir(), '.codeman', 'settings.json');

    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      if (settings.defaultClaudeMdPath) {
        return settings.defaultClaudeMdPath;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read settings:', err);
      }
    }
    return undefined;
  }

  // Read ~/.codeman/settings.json once and return the parsed object.
  // Cached for 2s to avoid redundant reads during session creation bursts.
  private _settingsCache: { data: Record<string, unknown>; ts: number } | null = null;
  private async readSettings(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this._settingsCache && now - this._settingsCache.ts < 2000) {
      return this._settingsCache.data;
    }
    const settingsPath = join(homedir(), '.codeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      this._settingsCache = { data, ts: now };
      return data;
    } catch {
      return {};
    }
  }

  // Helper to get global Nice priority config from settings
  private async getGlobalNiceConfig(): Promise<NiceConfig | undefined> {
    const settings = await this.readSettings();
    const nice = settings.nice as { enabled?: boolean; niceValue?: number } | undefined;
    if (nice && nice.enabled) {
      return {
        enabled: nice.enabled ?? false,
        niceValue: nice.niceValue ?? DEFAULT_NICE_CONFIG.niceValue,
      };
    }
    return undefined;
  }

  // Helper to get Claude CLI startup mode from settings
  private async getClaudeModeConfig(): Promise<{ claudeMode?: ClaudeMode; allowedTools?: string }> {
    const settings = await this.readSettings();
    const claudeMode = settings.claudeMode as string | undefined;
    const allowedTools = settings.allowedTools as string | undefined;
    // Only return valid modes
    if (claudeMode === 'dangerously-skip-permissions' || claudeMode === 'normal' || claudeMode === 'allowedTools') {
      return { claudeMode, allowedTools };
    }
    return {};
  }

  // Helper to get model configuration from settings
  private async getModelConfig(): Promise<{
    defaultModel?: string;
    agentTypeOverrides?: Record<string, string>;
  } | null> {
    const settings = await this.readSettings();
    return (
      (settings.modelConfig as {
        defaultModel?: string;
        agentTypeOverrides?: Record<string, string>;
      }) || null
    );
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

    // Start the run loop (fire-and-forget with error handling)
    this.runScheduledLoop(id).catch((err) => {
      console.error(`[WebServer] Scheduled run ${id} failed:`, err);
      const failedRun = this.scheduledRuns.get(id);
      if (failedRun && failedRun.status === 'running') {
        failedRun.status = 'stopped';
        failedRun.logs.push(`[${new Date().toISOString()}] Error: ${err instanceof Error ? err.message : String(err)}`);
        this.broadcast('scheduled:stopped', { id, reason: 'error' });
      }
    });

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
        await new Promise((r) => setTimeout(r, SESSION_LIMIT_WAIT_MS));
        continue;
      }

      let session: Session | null = null;
      try {
        // Create a session for this iteration
        session = new Session({ workingDir: run.workingDir });
        this.sessions.set(session.id, session);
        this.store.incrementSessionsCreated();
        this.persistSessionState(session);
        await this.setupSessionListeners(session);
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
        await this.cleanupSession(session.id, true, 'scheduled_run');
        run.sessionId = null;

        // Small pause between iterations
        await new Promise((r) => setTimeout(r, ITERATION_PAUSE_MS));
      } catch (err) {
        addLog(`Error: ${getErrorMessage(err)}`);
        this.broadcast('scheduled:updated', run);

        // Clean up the session on error too
        if (session) {
          try {
            await this.cleanupSession(session.id, true, 'scheduled_run_error');
          } catch {
            // Ignore cleanup errors
          }
          run.sessionId = null;
        }

        // Continue despite errors
        await new Promise((r) => setTimeout(r, SESSION_LIMIT_WAIT_MS));
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
      await this.cleanupSession(run.sessionId, true, 'scheduled_run_stopped');
      run.sessionId = null;
    }

    this.broadcast('scheduled:stopped', run);
  }

  /**
   * Get session state with respawn controller info included.
   * Use this for session:updated broadcasts to preserve respawn state on the frontend.
   */
  private getSessionStateWithRespawn(session: Session) {
    const controller = this.respawnControllers.get(session.id);
    return {
      ...session.toLightDetailedState(),
      respawnEnabled: controller?.getConfig()?.enabled ?? false,
      respawnConfig: controller?.getConfig() ?? null,
      respawn: controller?.getStatus() ?? null,
    };
  }

  /**
   * Get lightweight session state for SSE init - excludes full terminal buffers
   * to prevent browser freezes on SSE reconnect. Full buffers are fetched
   * on-demand when switching tabs via /api/sessions/:id/buffer
   */
  private getLightSessionsState() {
    const now = Date.now();
    if (this.cachedSessionsList && now - this.cachedSessionsList.timestamp < SESSIONS_LIST_CACHE_TTL) {
      return this.cachedSessionsList.data;
    }
    // getSessionStateWithRespawn already uses toLightDetailedState() which
    // excludes terminalBuffer and textOutput — no extra stripping needed
    const data = Array.from(this.sessions.values()).map((s) => this.getSessionStateWithRespawn(s));
    this.cachedSessionsList = { data, timestamp: now };
    return data;
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

  /**
   * Cleans up stale sessions from state file that don't have active sessions.
   * Called on startup and can be called via API endpoint.
   * @returns Number of sessions cleaned up
   */
  private cleanupStaleSessions(): number {
    const activeSessionIds = new Set(this.sessions.keys());
    const result = this.store.cleanupStaleSessions(activeSessionIds);
    const lifecycleLog = getLifecycleLog();
    for (const s of result.cleaned) {
      lifecycleLog.log({ event: 'stale_cleaned', sessionId: s.id, name: s.name });
    }
    return result.count;
  }

  /**
   * Get lightweight state for SSE init - excludes full terminal buffers
   * to prevent browser freezes. Terminal buffers are fetched on-demand.
   */
  private getLightState() {
    const now = Date.now();
    if (this.cachedLightState && now - this.cachedLightState.timestamp < WebServer.LIGHT_STATE_CACHE_TTL_MS) {
      return this.cachedLightState.data;
    }

    const respawnStatus: Record<string, ReturnType<RespawnController['getStatus']>> = {};
    for (const [sessionId, controller] of this.respawnControllers) {
      respawnStatus[sessionId] = controller.getStatus();
    }

    const activeSessionTokens: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> = {};
    for (const [sessionId, session] of this.sessions) {
      activeSessionTokens[sessionId] = {
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalCost: session.totalCost,
      };
    }

    const result = {
      version: APP_VERSION,
      sessions: this.getLightSessionsState(),
      scheduledRuns: Array.from(this.scheduledRuns.values()),
      respawnStatus,
      globalStats: this.store.getAggregateStats(activeSessionTokens),
      subagents: subagentWatcher.getRecentSubagents(15), // 15 min to avoid stale agents
      timestamp: now,
    };

    this.cachedLightState = { data: result, timestamp: now };
    return result;
  }

  private sendSSE(reply: FastifyReply, event: string, data: unknown): void {
    try {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.sseClients.delete(reply);
    }
  }

  // Optimized: send pre-formatted SSE message to a client
  // Returns false if client is backpressured or dead
  private sendSSEPreformatted(reply: FastifyReply, message: string): void {
    // Skip backpressured clients to prevent unbounded memory growth.
    // Terminal data dropped here is recovered via session:needsRefresh on drain.
    if (this.backpressuredClients.has(reply)) return;

    try {
      const ok = reply.raw.write(message);
      if (!ok) {
        // Buffer is full — mark as backpressured, resume on drain
        this.backpressuredClients.add(reply);
        reply.raw.once('drain', () => {
          this.backpressuredClients.delete(reply);
          // Client may have missed terminal data during backpressure.
          // Tell it to reload the active session's buffer to recover.
          try {
            reply.raw.write(`event: session:needsRefresh\ndata: {}\n\n`);
          } catch {
            /* client gone */
          }
        });
      }
    } catch {
      this.sseClients.delete(reply);
      this.backpressuredClients.delete(reply);
    }
  }

  private broadcast(event: string, data: unknown): void {
    // Invalidate caches only on structurally significant events — ones that
    // change session list content (creation, deletion, or full state refresh).
    // High-frequency non-structural events (working/idle transitions, completion,
    // error, respawn state changes) are NOT worth invalidating for because:
    //   1. The debounced session:updated follows within 500ms with the new state
    //   2. These caches serve /api/sessions and SSE init — neither is polled rapidly
    //   3. Invalidating on every working/idle transition makes the 1s TTL useless
    if (event === 'session:created' || event === 'session:deleted' || event === 'session:updated') {
      this.cachedLightState = null;
      this.cachedSessionsList = null;
    }
    // Performance optimization: serialize JSON once for all clients.
    // Append padding to flush Cloudflare tunnel buffers for all non-terminal events.
    // Terminal data is high-volume and already exceeds buffer thresholds naturally.
    let message: string;
    try {
      message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` + SSE_PADDING;
    } catch (err) {
      // Handle circular references or non-serializable values
      console.error(`[Server] Failed to serialize SSE event "${event}":`, err);
      return;
    }
    for (const client of this.sseClients) {
      this.sendSSEPreformatted(client, message);
    }
  }

  // Batch terminal data for better performance (60fps)
  // Uses per-session timers with adaptive intervals to prevent thundering herd:
  // each session flushes independently rather than all sessions flushing in one burst.
  private batchTerminalData(sessionId: string, data: string): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    let chunks = this.terminalBatches.get(sessionId);
    if (!chunks) {
      chunks = [];
      this.terminalBatches.set(sessionId, chunks);
    }
    chunks.push(data);
    const prevSize = this.terminalBatchSizes.get(sessionId) ?? 0;
    const totalLength = prevSize + data.length;
    this.terminalBatchSizes.set(sessionId, totalLength);

    // Adaptive batching: detect rapid events and extend batch window (per-session)
    const now = Date.now();
    const lastEvent = this.lastTerminalEventTime.get(sessionId) ?? 0;
    const eventGap = now - lastEvent;
    this.lastTerminalEventTime.set(sessionId, now);

    // Adjust batch interval based on event frequency (per-session)
    // Rapid events (<10ms gap) = 50ms batch, moderate (<20ms) = 32ms, else 16ms
    let sessionInterval: number;
    if (eventGap > 0 && eventGap < 10) {
      sessionInterval = 50;
    } else if (eventGap > 0 && eventGap < 20) {
      sessionInterval = 32;
    } else {
      sessionInterval = TERMINAL_BATCH_INTERVAL;
    }

    // Flush immediately if batch is large for responsiveness
    if (totalLength > BATCH_FLUSH_THRESHOLD) {
      const existingTimer = this.terminalBatchTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.terminalBatchTimers.delete(sessionId);
      }
      this.flushSessionTerminalBatch(sessionId);
      return;
    }

    // Start per-session batch timer if not already running
    // Each session flushes independently — prevents one busy session from
    // forcing all sessions to flush at its rate (thundering herd)
    if (!this.terminalBatchTimers.has(sessionId)) {
      this.terminalBatchTimers.set(
        sessionId,
        setTimeout(() => {
          this.terminalBatchTimers.delete(sessionId);
          this.flushSessionTerminalBatch(sessionId);
        }, sessionInterval)
      );
    }
  }

  /** Flush a single session's batched terminal data */
  private flushSessionTerminalBatch(sessionId: string): void {
    if (this._isStopping) {
      this.terminalBatches.delete(sessionId);
      this.terminalBatchSizes.delete(sessionId);
      return;
    }
    const chunks = this.terminalBatches.get(sessionId);
    if (chunks && chunks.length > 0) {
      // Join chunks only at flush time (avoids O(n^2) string concatenation in batchTerminalData)
      const data = chunks.join('');
      // Wrap with DEC mode 2026 synchronized output markers
      // Terminal buffers all output between markers and renders atomically,
      // eliminating partial-frame flicker from Ink's full-screen redraws.
      // Unsupported terminals ignore these sequences harmlessly.
      const syncData = DEC_SYNC_START + data + DEC_SYNC_END;
      // Fast path: build SSE message directly without JSON.stringify on wrapper object.
      // Only the terminal data string needs escaping; sessionId is a UUID (safe to template).
      const escapedData = JSON.stringify(syncData);
      const message = `event: session:terminal\ndata: {"id":"${sessionId}","data":${escapedData}}\n\n`;
      for (const client of this.sseClients) {
        this.sendSSEPreformatted(client, message);
      }
    }
    this.terminalBatches.delete(sessionId);
    this.terminalBatchSizes.delete(sessionId);
  }

  // Batch task:updated events at 100ms - only send latest update per task
  // Key is sessionId:taskId to avoid collisions when multiple tasks update concurrently
  private batchTaskUpdate(sessionId: string, task: BackgroundTask): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    // Use composite key to avoid losing updates when multiple tasks update in same batch window
    const key = `${sessionId}:${task.id}`;
    this.taskUpdateBatches.set(key, { sessionId, task });

    if (!this.taskUpdateBatchTimerId) {
      this.taskUpdateBatchTimerId = this.cleanup.setTimeout(
        () => {
          this.taskUpdateBatchTimerId = null;
          this.flushTaskUpdateBatches();
        },
        TASK_UPDATE_BATCH_INTERVAL,
        { description: 'task update batch flush' }
      );
    }
  }

  private flushTaskUpdateBatches(): void {
    // Skip if server is stopping (timer may have been queued before stop() was called)
    if (this._isStopping) {
      this.taskUpdateBatches.clear();
      return;
    }
    for (const [, { sessionId, task }] of this.taskUpdateBatches) {
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

    if (!this.stateUpdateTimerId) {
      this.stateUpdateTimerId = this.cleanup.setTimeout(
        () => {
          this.stateUpdateTimerId = null;
          this.flushStateUpdates();
        },
        STATE_UPDATE_DEBOUNCE_INTERVAL,
        { description: 'state update debounce flush' }
      );
    }
  }

  private flushStateUpdates(): void {
    // Skip if server is stopping (timer may have been queued before stop() was called)
    if (this._isStopping) {
      this.stateUpdatePending.clear();
      return;
    }
    for (const sessionId of this.stateUpdatePending) {
      const session = this.sessions.get(sessionId);
      if (session) {
        // Single expensive serialization per batch interval
        this.broadcast('session:updated', this.getSessionStateWithRespawn(session));
      }
    }
    this.stateUpdatePending.clear();
  }

  // ========== Web Push ==========

  /** Map SSE event names to push notification payloads */
  private static readonly PUSH_EVENT_MAP: Record<
    string,
    { title: string; urgency: string; actions?: Array<{ action: string; title: string }> }
  > = {
    'hook:permission_prompt': {
      title: 'Permission Required',
      urgency: 'critical',
      actions: [
        { action: 'approve', title: 'Approve' },
        { action: 'deny', title: 'Deny' },
      ],
    },
    'hook:elicitation_dialog': { title: 'Question Asked', urgency: 'critical' },
    'hook:idle_prompt': { title: 'Waiting for Input', urgency: 'warning' },
    'hook:stop': { title: 'Response Complete', urgency: 'info' },
    'session:error': { title: 'Session Error', urgency: 'critical' },
    'respawn:blocked': { title: 'Respawn Blocked', urgency: 'critical' },
    'session:ralphCompletionDetected': { title: 'Task Complete', urgency: 'warning' },
  };

  /**
   * Send push notifications for a given event to all subscribed devices.
   * Only events in PUSH_EVENT_MAP trigger push. Per-subscription preferences are checked.
   * Expired subscriptions (410/404) are auto-removed.
   */
  private sendPushNotifications(event: string, data: Record<string, unknown>): void {
    const template = WebServer.PUSH_EVENT_MAP[event];
    if (!template) return;

    const subscriptions = this.pushStore.getAll();
    if (subscriptions.length === 0) return;

    const vapidKeys = this.pushStore.getVapidKeys();
    webpush.setVapidDetails('mailto:codeman@localhost', vapidKeys.publicKey, vapidKeys.privateKey);

    const sessionName = (data.sessionName as string) || '';
    const sessionId = (data.sessionId as string) || '';

    // Build body text from event data
    let body = sessionName ? `[${sessionName}]` : '';
    if (event === 'session:error' && data.error) {
      body += body ? ' ' : '';
      body += String(data.error).slice(0, 200);
    } else if (event === 'respawn:blocked' && data.reason) {
      body += body ? ' ' : '';
      body += String(data.reason);
    } else if (event === 'session:ralphCompletionDetected' && data.phrase) {
      body += body ? ' ' : '';
      body += String(data.phrase);
    } else if (event === 'hook:permission_prompt' && data.tool_name) {
      body += body ? ' ' : '';
      body += `Tool: ${String(data.tool_name)}`;
    }

    const payload = JSON.stringify({
      title: template.title,
      body,
      tag: `codeman-${event}-${sessionId}`,
      sessionId,
      urgency: template.urgency,
      actions: template.actions,
    });

    for (const sub of subscriptions) {
      // Check per-subscription preferences
      if (sub.pushPreferences[event] === false) continue;

      const pushSub = {
        endpoint: sub.endpoint,
        keys: sub.keys,
      };

      webpush.sendNotification(pushSub, payload).catch((err: { statusCode?: number }) => {
        // Auto-remove expired/invalid subscriptions
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.pushStore.removeByEndpoint(sub.endpoint);
        }
      });
    }
  }

  /**
   * Clean up dead SSE clients and send keep-alive comments.
   * Keep-alive prevents proxy/load-balancer timeouts on idle connections.
   * Dead client cleanup prevents memory leaks from abruptly terminated connections.
   */
  private cleanupDeadSSEClients(): void {
    const deadClients: FastifyReply[] = [];

    for (const client of this.sseClients) {
      try {
        // Check if the underlying socket is still writable
        const socket = client.raw.socket;
        if (!socket || socket.destroyed || !socket.writable) {
          deadClients.push(client);
        } else {
          // Send padded SSE comment as keep-alive — the padding flushes
          // Cloudflare tunnel buffers so subsequent events arrive promptly.
          client.raw.write(':keepalive\n' + SSE_PADDING);
        }
      } catch {
        // Error accessing socket means client is dead
        deadClients.push(client);
      }
    }

    // Remove dead clients
    for (const client of deadClients) {
      this.sseClients.delete(client);
      this.backpressuredClients.delete(client);
    }

    if (deadClients.length > 0) {
      console.log(`[Server] Cleaned up ${deadClients.length} dead SSE client(s)`);
    }
  }

  /**
   * Records token usage for long-running sessions periodically.
   * Called every 5 minutes to capture usage in daily stats without waiting for session deletion.
   */
  private recordPeriodicTokenUsage(): void {
    for (const [sessionId, session] of this.sessions) {
      const last = this.lastRecordedTokens.get(sessionId) || { input: 0, output: 0 };
      const deltaInput = session.inputTokens - last.input;
      const deltaOutput = session.outputTokens - last.output;

      if (deltaInput > 0 || deltaOutput > 0) {
        this.store.recordDailyUsage(deltaInput, deltaOutput, sessionId);
        this.lastRecordedTokens.set(sessionId, {
          input: session.inputTokens,
          output: session.outputTokens,
        });
      }
    }
  }

  async start(): Promise<void> {
    await this.setupRoutes();

    const lifecycleLog = getLifecycleLog();
    lifecycleLog.log({ event: 'server_started', sessionId: '*' });
    await lifecycleLog.trimIfNeeded();

    // Restore mux sessions BEFORE accepting connections
    // This prevents race conditions where clients connect before state is ready
    // CRITICAL: Skip in test mode to prevent tests from picking up user sessions
    if (!this.testMode) {
      await this.restoreMuxSessions();
    }

    // Clean up stale sessions from state file that don't have active mux sessions
    this.cleanupStaleSessions();

    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    const protocol = this.https ? 'https' : 'http';
    console.log(`Codeman web interface running at ${protocol}://localhost:${this.port}`);

    // Security warning: server binds to 0.0.0.0 (all interfaces) — warn if no auth configured
    if (!process.env.CODEMAN_PASSWORD) {
      console.warn('\n⚠  WARNING: No CODEMAN_PASSWORD set — server is accessible without authentication.');
      console.warn('   Anyone on your network can access and control Claude sessions.');
      console.warn('   Set CODEMAN_PASSWORD environment variable to enable auth.\n');
    }

    // Set API URL for child processes (MCP server, spawned sessions)
    process.env.CODEMAN_API_URL = `${protocol}://localhost:${this.port}`;

    // Start scheduled runs cleanup timer
    this.cleanup.setInterval(
      () => {
        this.cleanupScheduledRuns();
      },
      SCHEDULED_CLEANUP_INTERVAL,
      { description: 'scheduled runs cleanup' }
    );

    // Start SSE client health check timer (prevents memory leaks from dead connections)
    this.cleanup.setInterval(
      () => {
        this.cleanupDeadSSEClients();
      },
      SSE_HEARTBEAT_INTERVAL,
      { description: 'SSE heartbeat + dead client cleanup' }
    );

    // Start token recording timer (every 5 minutes for long-running sessions)
    this.cleanup.setInterval(
      () => {
        this.recordPeriodicTokenUsage();
      },
      5 * 60 * 1000,
      { description: 'periodic token recording' }
    );

    // Start subagent watcher for Claude Code background agent visibility (if enabled)
    if (await this.isSubagentTrackingEnabled()) {
      subagentWatcher.start();
      console.log('Subagent watcher started - monitoring ~/.claude/projects for background agent activity');
    } else {
      console.log('Subagent watcher disabled by user settings');
    }

    // Start image watcher for auto-popup of screenshots (if enabled)
    if (await this.isImageWatcherEnabled()) {
      imageWatcher.start();
      console.log('Image watcher started - monitoring session directories for new images');
    } else {
      console.log('Image watcher disabled by user settings');
    }

    // Tunnel only starts when user clicks the toggle in the UI — never on boot.
    // Reset persisted tunnelEnabled so the UI toggle reflects actual state.
    if (await this.isTunnelEnabled()) {
      const settingsPath = join(homedir(), '.codeman', 'settings.json');
      try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        settings.tunnelEnabled = false;
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      } catch {
        /* ignore */
      }
      console.log('Cloudflare tunnel setting reset (tunnel only starts on explicit UI toggle)');
    }

    // Start team watcher for agent team awareness (always on — lightweight polling)
    this.teamWatcher.start();
    console.log('Team watcher started - monitoring ~/.claude/teams/ for agent team activity');
  }

  /**
   * Check if subagent tracking is enabled in settings (default: true)
   */
  private async isSubagentTrackingEnabled(): Promise<boolean> {
    const settingsPath = join(homedir(), '.codeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      // Default to true if not explicitly set
      return settings.subagentTrackingEnabled ?? true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read subagent tracking setting:', err);
      }
    }
    return true; // Default enabled
  }

  /**
   * Check if image watcher is enabled in settings (default: false)
   */
  private async isImageWatcherEnabled(): Promise<boolean> {
    const settingsPath = join(homedir(), '.codeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      // Default to false if not explicitly set (matches UI default)
      return settings.imageWatcherEnabled ?? false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read image watcher setting:', err);
      }
    }
    return false; // Default disabled (matches UI default)
  }

  /**
   * Check if Cloudflare tunnel is enabled in settings (default: false)
   */
  private async isTunnelEnabled(): Promise<boolean> {
    const settingsPath = join(homedir(), '.codeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      return settings.tunnelEnabled ?? false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read tunnel setting:', err);
      }
    }
    return false;
  }

  private async restoreMuxSessions(): Promise<void> {
    try {
      // Reconcile mux sessions to find which ones are still alive (also discovers unknown ones)
      const { alive, dead, discovered } = await this.mux.reconcileSessions();

      if (discovered.length > 0) {
        console.log(`[Server] Discovered ${discovered.length} unknown mux session(s)`);
      }

      if (alive.length > 0 || discovered.length > 0) {
        console.log(`[Server] Found ${alive.length + discovered.length} alive mux session(s) from previous run`);

        // For each alive mux session, create a Session object if it doesn't exist
        const muxSessions = this.mux.getSessions();
        for (const muxSession of muxSessions) {
          if (!this.sessions.has(muxSession.sessionId)) {
            // Restore session settings from state.json (single source of truth)
            const savedState = this.store.getSession(muxSession.sessionId);

            // Determine the correct session name (priority: savedState > muxSession > muxName)
            // This ensures renamed sessions keep their name after server restart
            const sessionName = savedState?.name || muxSession.name || muxSession.muxName;

            // Create a session object for this mux session
            const recoveryClaudeMode = await this.getClaudeModeConfig();
            const session = new Session({
              id: muxSession.sessionId, // Preserve the original session ID
              workingDir: muxSession.workingDir,
              mode: muxSession.mode,
              name: sessionName,
              mux: this.mux,
              useMux: true,
              muxSession: muxSession, // Pass the existing session so startInteractive() can attach to it
              claudeMode: recoveryClaudeMode.claudeMode,
              allowedTools: recoveryClaudeMode.allowedTools,
            });

            // Update session name if it was a "Restored:" placeholder or doesn't match saved name
            if (savedState?.name && muxSession.name !== savedState.name) {
              this.mux.updateSessionName(muxSession.sessionId, savedState.name);
            }
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
                session.setAutoClear(savedState.autoClearEnabled ?? false, savedState.autoClearThreshold);
              }
              // Token tracking
              if (
                savedState.inputTokens !== undefined ||
                savedState.outputTokens !== undefined ||
                savedState.totalCost !== undefined
              ) {
                session.restoreTokens(
                  savedState.inputTokens ?? 0,
                  savedState.outputTokens ?? 0,
                  savedState.totalCost ?? 0
                );
                // Initialize lastRecordedTokens to prevent re-counting restored tokens as new daily usage
                this.lastRecordedTokens.set(session.id, {
                  input: savedState.inputTokens ?? 0,
                  output: savedState.outputTokens ?? 0,
                });
                const totalTokens = (savedState.inputTokens ?? 0) + (savedState.outputTokens ?? 0);
                if (totalTokens > 0) {
                  console.log(
                    `[Server] Restored tokens for session ${session.id}: ${totalTokens} tokens, $${(savedState.totalCost ?? 0).toFixed(4)}`
                  );
                }
              }
              // Ralph / Todo tracker (not supported for opencode sessions)
              if (session.mode !== 'opencode') {
                if (savedState.ralphAutoEnableDisabled) {
                  session.ralphTracker.disableAutoEnable();
                  console.log(`[Server] Restored Ralph auto-enable disabled for session ${session.id}`);
                } else if (savedState.ralphEnabled) {
                  // If Ralph was enabled and not explicitly disabled, allow re-enabling on restart
                  session.ralphTracker.enableAutoEnable();
                }
                if (savedState.ralphEnabled) {
                  session.ralphTracker.enable();
                  if (savedState.ralphCompletionPhrase) {
                    session.ralphTracker.startLoop(savedState.ralphCompletionPhrase);
                  }
                  console.log(
                    `[Server] Restored Ralph tracker for session ${session.id} (phrase: ${savedState.ralphCompletionPhrase || 'none'})`
                  );
                }
              }
              // Nice priority config
              if (savedState.niceEnabled !== undefined) {
                session.setNice({
                  enabled: savedState.niceEnabled,
                  niceValue: savedState.niceValue,
                });
              }
              // Flicker filter (frontend-applied but persisted)
              if (savedState.flickerFilterEnabled !== undefined) {
                session.flickerFilterEnabled = savedState.flickerFilterEnabled;
              }
              // Respawn controller (not supported for opencode sessions)
              if (session.mode !== 'opencode' && savedState.respawnEnabled && savedState.respawnConfig) {
                try {
                  this.restoreRespawnController(session, savedState.respawnConfig, 'state.json');
                } catch (err) {
                  console.error(`[Server] Failed to restore respawn for session ${session.id}:`, err);
                }
              }
            }

            // Fallback: restore respawn from mux-sessions.json if state.json didn't have it (not supported for opencode)
            if (
              session.mode !== 'opencode' &&
              !this.respawnControllers.has(session.id) &&
              muxSession.respawnConfig?.enabled
            ) {
              try {
                this.restoreRespawnController(session, muxSession.respawnConfig, 'mux-sessions.json');
              } catch (err) {
                console.error(
                  `[Server] Failed to restore respawn from mux-sessions.json for session ${session.id}:`,
                  err
                );
              }
            }

            // Fallback: restore Ralph state from state-inner.json if not already set and not explicitly disabled
            // Ralph tracker is not supported for opencode sessions
            if (
              session.mode !== 'opencode' &&
              !session.ralphTracker.enabled &&
              !session.ralphTracker.autoEnableDisabled
            ) {
              const ralphState = this.store.getRalphState(muxSession.sessionId);
              if (ralphState?.loop?.enabled) {
                session.ralphTracker.restoreState(ralphState.loop, ralphState.todos);
                console.log(`[Server] Restored Ralph state from inner store for session ${session.id}`);
              }
            }

            // Fallback: auto-detect completion phrase from CLAUDE.md (not supported for opencode)
            if (
              session.mode !== 'opencode' &&
              session.ralphTracker.enabled &&
              !session.ralphTracker.loopState.completionPhrase
            ) {
              const claudeMdPath = join(session.workingDir, 'CLAUDE.md');
              const completionPhrase = extractCompletionPhrase(claudeMdPath);
              if (completionPhrase) {
                session.ralphTracker.startLoop(completionPhrase);
                console.log(`[Server] Auto-detected completion phrase for session ${session.id}: ${completionPhrase}`);
              }
            }

            this.sessions.set(session.id, session);
            await this.setupSessionListeners(session);
            this.persistSessionState(session);

            // Mark it as restored (not started yet - user needs to attach)
            getLifecycleLog().log({
              event: 'recovered',
              sessionId: session.id,
              name: session.name,
            });
            console.log(`[Server] Restored session ${session.id} from mux ${muxSession.muxName}`);
          }
        }

        // Start stats collection for mux sessions
        this.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      }

      // Start mouse mode sync (tmux only) — toggles mouse on/off based on pane count.
      // Mouse off = native xterm.js selection; mouse on = tmux pane clicking (split layouts).
      // Always start, even with no sessions — new sessions may be created later.
      if ('startMouseModeSync' in this.mux) {
        (this.mux as { startMouseModeSync: (ms?: number) => void }).startMouseModeSync();
      }

      if (dead.length > 0) {
        console.log(`[Server] Cleaned up ${dead.length} dead mux session(s)`);
      }
    } catch (err) {
      console.error('[Server] Failed to restore mux sessions:', err);
    }
  }

  async stop(): Promise<void> {
    getLifecycleLog().log({ event: 'server_stopped', sessionId: '*' });
    // Set stopping flag to prevent new timer creation during shutdown
    this._isStopping = true;

    // Dispose all managed timers (intervals + resettable timeouts)
    this.cleanup.dispose();

    // Gracefully close all SSE connections before clearing
    for (const client of this.sseClients) {
      try {
        // Send a final event to notify clients of shutdown
        this.sendSSE(client, 'server:shutdown', { reason: 'Server stopping' });
        client.raw.end();
      } catch {
        // Client may already be disconnected
      }
    }
    this.sseClients.clear();
    this.backpressuredClients.clear();

    // Clear per-session batch timers
    for (const timer of this.terminalBatchTimers.values()) {
      clearTimeout(timer);
    }
    this.terminalBatchTimers.clear();
    this.terminalBatches.clear();
    this.terminalBatchSizes.clear();

    this.taskUpdateBatches.clear();
    this.stateUpdatePending.clear();
    this.lastRecordedTokens.clear();

    // Stop multiplexer and flush pending saves
    this.mux.destroy();

    // Flush any pending persist-debounce timers and persist dirty sessions
    this.persistDeb.flushAll((sessionId) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        this._persistSessionStateNow(session);
      }
    });

    // Clear cached state
    this.cachedLightState = null;
    this.cachedSessionsList = null;

    // Clear all pending respawn start timers (from restoration grace period)
    for (const timer of this.pendingRespawnStarts.values()) {
      clearTimeout(timer);
    }
    this.pendingRespawnStarts.clear();

    // Stop all respawn controllers and remove listeners
    for (const controller of this.respawnControllers.values()) {
      controller.stop();
      controller.removeAllListeners();
    }
    this.respawnControllers.clear();

    // Stop all scheduled runs first (they have their own session cleanup)
    await Promise.allSettled(Array.from(this.scheduledRuns.keys()).map((id) => this.stopScheduledRun(id)));

    // On server shutdown, DO NOT call cleanupSession — it tears down session state,
    // removes listeners, kills PTY processes, and broadcasts session:deleted.
    // Instead, just persist current state and let the PTY die naturally when process exits.
    // The tmux sessions survive independently, and restoreMuxSessions() will find them on restart.
    for (const [sessionId, session] of this.sessions) {
      // Persist final state so recovery has up-to-date tokens, ralph state, etc.
      this._persistSessionStateNow(session);
      // Remove listeners to avoid spurious events during teardown
      const listeners = this.sessionListenerRefs.get(sessionId);
      if (listeners) {
        session.off('terminal', listeners.terminal);
        session.off('clearTerminal', listeners.clearTerminal);
        session.off('needsRefresh', listeners.needsRefresh);
        session.off('message', listeners.message);
        session.off('error', listeners.error);
        session.off('completion', listeners.completion);
        session.off('exit', listeners.exit);
        session.off('working', listeners.working);
        session.off('idle', listeners.idle);
        session.off('taskCreated', listeners.taskCreated);
        session.off('taskUpdated', listeners.taskUpdated);
        session.off('taskCompleted', listeners.taskCompleted);
        session.off('taskFailed', listeners.taskFailed);
        session.off('autoClear', listeners.autoClear);
        session.off('autoCompact', listeners.autoCompact);
        session.off('cliInfoUpdated', listeners.cliInfoUpdated);
        session.off('ralphLoopUpdate', listeners.ralphLoopUpdate);
        session.off('ralphTodoUpdate', listeners.ralphTodoUpdate);
        session.off('ralphCompletionDetected', listeners.ralphCompletionDetected);
        session.off('ralphStatusBlockDetected', listeners.ralphStatusBlockDetected);
        session.off('ralphCircuitBreakerUpdate', listeners.ralphCircuitBreakerUpdate);
        session.off('ralphExitGateMet', listeners.ralphExitGateMet);
        session.off('bashToolStart', listeners.bashToolStart);
        session.off('bashToolEnd', listeners.bashToolEnd);
        session.off('bashToolsUpdate', listeners.bashToolsUpdate);
        this.sessionListenerRefs.delete(sessionId);
      }
      session.removeAllListeners();
      // Close file streams and image watchers (these are server-side resources)
      fileStreamManager.closeSessionStreams(sessionId);
      imageWatcher.unwatchSession(sessionId);
    }
    // Don't delete sessions from the map or state.json — recovery needs them

    // Flush state store to prevent data loss from debounced saves
    this.store.flushAll();

    // Clean up watcher listeners to prevent memory leaks
    this.cleanupSubagentWatcherListeners();
    this.cleanupImageWatcherListeners();
    this.cleanupTeamWatcherListeners();

    // Stop subagent watcher
    subagentWatcher.stop();

    // Stop image watcher
    imageWatcher.stop();

    // Stop team watcher
    this.teamWatcher.stop();

    // Stop tunnel
    this.tunnelManager.stop();
    this.tunnelManager.removeAllListeners();

    // Destroy file stream manager (clears cleanup timer and kills remaining tail processes)
    fileStreamManager.destroy();

    // Stop all remaining tracked resources before clearing their Maps
    for (const tracker of this.runSummaryTrackers.values()) {
      tracker.stop();
    }
    for (const watcher of this.transcriptWatchers.values()) {
      watcher.removeAllListeners();
      watcher.stop();
    }
    for (const orchestrator of this.activePlanOrchestrators.values()) {
      orchestrator.cancel();
    }

    // Clear remaining Maps that accumulate session references
    for (const { timer } of this.respawnTimers.values()) {
      clearTimeout(timer);
    }
    this.respawnTimers.clear();
    this.runSummaryTrackers.clear();
    this.transcriptWatchers.clear();
    this.sessionListenerRefs.clear();
    this.scheduledRuns.clear();
    // Dispose StaleExpirationMaps (stops internal cleanup timers)
    this.lastTerminalEventTime.dispose();
    if (this.authSessions) {
      this.authSessions.dispose();
      this.authSessions = null;
    }
    if (this.authFailures) {
      this.authFailures.dispose();
      this.authFailures = null;
    }
    if (this.qrAuthFailures) {
      this.qrAuthFailures.dispose();
      this.qrAuthFailures = null;
    }
    this.activePlanOrchestrators.clear();
    this.cleaningUp.clear();

    // Dispose push store (flush pending saves)
    this.pushStore.dispose();

    await this.app.close();
  }
}

export async function startWebServer(
  port: number = 3000,
  https: boolean = false,
  testMode: boolean = false
): Promise<WebServer> {
  const server = new WebServer(port, https, testMode);
  await server.start();
  return server;
}
