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
import path, { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir, totalmem, freemem, loadavg, cpus } from 'node:os';
import { EventEmitter } from 'node:events';
import { Session, ClaudeMessage, type BackgroundTask, type RalphTrackerState, type RalphTodoItem, type ActiveBashTool } from '../session.js';
import { fileStreamManager } from '../file-stream-manager.js';
import { RespawnController, RespawnConfig, RespawnState } from '../respawn-controller.js';
import type { TerminalMultiplexer } from '../mux-interface.js';
import { createMultiplexer } from '../mux-factory.js';
import { getStore } from '../state-store.js';
import { generateClaudeMd } from '../templates/claude-md.js';
import { parseRalphLoopConfig, extractCompletionPhrase } from '../ralph-config.js';
import { writeHooksConfig, updateCaseEnvVars } from '../hooks-config.js';
import { subagentWatcher, type SubagentInfo, type SubagentToolCall, type SubagentProgress, type SubagentMessage, type SubagentToolResult } from '../subagent-watcher.js';
import { imageWatcher } from '../image-watcher.js';
import { TranscriptWatcher } from '../transcript-watcher.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'node:module';
import { RunSummaryTracker } from '../run-summary.js';
import { PlanOrchestrator, type DetailedPlanResult } from '../plan-orchestrator.js';

// Load version from package.json
const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json');
import {
  getErrorMessage,
  ApiErrorCode,
  createErrorResponse,
  type CreateScheduledRunRequest,
  type QuickRunRequest,
  type ApiResponse,
  type SessionResponse,
  type QuickStartResponse,
  type CaseInfo,
  type PersistedRespawnConfig,
  type NiceConfig,
  type ImageDetectedEvent,
  DEFAULT_NICE_CONFIG,
} from '../types.js';
import {
  CreateSessionSchema,
  RunPromptSchema,
  SessionInputSchema,
  ResizeSchema,
  CreateCaseSchema,
  QuickStartSchema,
  HookEventSchema,
  ConfigUpdateSchema,
  RespawnConfigSchema,
} from './schemas.js';
import { StaleExpirationMap } from '../utils/index.js';

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

// DEC mode 2026 - Synchronized Output
// When terminal supports this, it buffers all output between start/end markers
// and renders atomically, eliminating partial-frame flicker from Ink redraws.
// Supported by: WezTerm, Kitty, Ghostty, iTerm2 3.5+, Windows Terminal, VSCode terminal
const DEC_SYNC_START = '\x1b[?2026h';  // Begin synchronized update
const DEC_SYNC_END = '\x1b[?2026l';    // End synchronized update (flush to screen)
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
// Maximum allowed input length for session write (64KB)
const MAX_INPUT_LENGTH = 64 * 1024;
// Maximum terminal resize dimensions
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 200;
// Maximum session name length
const MAX_SESSION_NAME_LENGTH = 128;
// Maximum hook data size (prevents oversized SSE broadcasts)
const MAX_HOOK_DATA_SIZE = 8 * 1024;
// Stats collection interval (2 seconds)
const STATS_COLLECTION_INTERVAL_MS = 2000;
// Session limit wait time before retrying (5 seconds)
const SESSION_LIMIT_WAIT_MS = 5000;
// Pause between scheduled run iterations (2 seconds)
const ITERATION_PAUSE_MS = 2000;
// Terminal batch flush threshold - flush immediately if batch exceeds this size
// Set high (32KB) to allow effective batching; avg Ink events are ~14KB
const BATCH_FLUSH_THRESHOLD = 32 * 1024;
// Pre-compiled regex for terminal buffer cleaning (avoids per-request compilation)
const CLAUDE_BANNER_PATTERN = /\x1b\[1mClaud/;
const CTRL_L_PATTERN = /\x0c/g;
const LEADING_WHITESPACE_PATTERN = /^[\s\r\n]+/;

/**
 * Formats uptime in seconds to a human-readable string.
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Sanitizes hook event data before broadcasting via SSE.
 * Extracts only relevant fields and limits total size to prevent
 * oversized payloads from being broadcast to all connected clients.
 */
function sanitizeHookData(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};

  // Only forward known safe fields from Claude Code hook stdin
  const safeFields: Record<string, unknown> = {};
  const allowedKeys = [
    'hook_event_name', 'tool_name', 'tool_input', 'session_id',
    'cwd', 'permission_mode', 'stop_hook_active', 'transcript_path',
  ];

  for (const key of allowedKeys) {
    if (key in data && data[key] !== undefined) {
      safeFields[key] = data[key];
    }
  }

  // For tool_input, extract only summary fields (not full file content)
  if (safeFields.tool_input && typeof safeFields.tool_input === 'object') {
    const input = safeFields.tool_input as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    if (input.command) summary.command = String(input.command).slice(0, 500);
    if (input.file_path) summary.file_path = String(input.file_path).slice(0, 500);
    if (input.description) summary.description = String(input.description).slice(0, 200);
    if (input.query) summary.query = String(input.query).slice(0, 200);
    if (input.url) summary.url = String(input.url).slice(0, 500);
    if (input.pattern) summary.pattern = String(input.pattern).slice(0, 200);
    if (input.prompt) summary.prompt = String(input.prompt).slice(0, 200);
    safeFields.tool_input = summary;
  }

  // Final size check - drop if serialized data exceeds limit
  const serialized = JSON.stringify(safeFields);
  if (serialized.length > MAX_HOOK_DATA_SIZE) {
    return { tool_name: safeFields.tool_name, _truncated: true };
  }

  return safeFields;
}

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

/**
 * Get or generate a self-signed TLS certificate for HTTPS.
 * Certs are stored in ~/.claudeman/certs/ and reused across restarts.
 */
function getOrCreateSelfSignedCert(): { key: string; cert: string } {
  const certsDir = join(homedir(), '.claudeman', 'certs');
  const keyPath = join(certsDir, 'server.key');
  const certPath = join(certsDir, 'server.crt');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, 'utf-8'),
      cert: readFileSync(certPath, 'utf-8'),
    };
  }

  mkdirSync(certsDir, { recursive: true });

  // Generate self-signed cert valid for 365 days, covering localhost and common LAN access patterns
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes ` +
    `-keyout "${keyPath}" -out "${certPath}" ` +
    `-days 365 -subj "/CN=claudeman" ` +
    `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0"`,
    { stdio: 'pipe' }
  );

  return {
    key: readFileSync(keyPath, 'utf-8'),
    cert: readFileSync(certPath, 'utf-8'),
  };
}

/** Stored listener references for session cleanup (prevents memory leaks) */
interface SessionListenerRefs {
  output: (data: string) => void;
  terminal: (data: string) => void;
  clearTerminal: () => void;
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
  /** Cached CPU count — doesn't change at runtime */
  private static readonly CPU_COUNT = cpus().length;

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
  private terminalBatches: Map<string, string> = new Map();
  private terminalBatchTimer: NodeJS.Timeout | null = null;
  // Adaptive batching: track rapid events to extend batch window (per-session)
  // StaleExpirationMap auto-cleans entries for sessions that stop generating output
  private lastTerminalEventTime: StaleExpirationMap<string, number> = new StaleExpirationMap({
    ttlMs: 5 * 60 * 1000, // 5 minutes - auto-expire stale session timing data
    refreshOnGet: false,   // Don't refresh on reads, only on explicit sets
  });
  // Per-session adaptive batch intervals (sessions with rapid output get longer batches)
  private adaptiveBatchIntervals: Map<string, number> = new Map();
  // Tracked minimum across adaptiveBatchIntervals (avoids spreading into Math.min on every batch)
  private _minBatchInterval: number = TERMINAL_BATCH_INTERVAL;
  // Scheduled runs cleanup timer
  private scheduledCleanupTimer: NodeJS.Timeout | null = null;
  // SSE event batching
  private outputBatches: Map<string, string> = new Map();
  private outputBatchTimer: NodeJS.Timeout | null = null;
  private taskUpdateBatches: Map<string, { sessionId: string; task: BackgroundTask }> = new Map();
  private taskUpdateBatchTimer: NodeJS.Timeout | null = null;
  // State update batching (reduce expensive toDetailedState() serialization)
  private stateUpdatePending: Set<string> = new Set();
  private stateUpdateTimer: NodeJS.Timeout | null = null;
  // SSE client health check timer
  private sseHealthCheckTimer: NodeJS.Timeout | null = null;
  // Flag to prevent new timers during shutdown
  private _isStopping: boolean = false;
  // Token recording for daily stats (track what's been recorded to avoid double-counting)
  private lastRecordedTokens: Map<string, { input: number; output: number }> = new Map();
  private tokenRecordingTimer: NodeJS.Timeout | null = null;
  // Server startup time for respawn grace period calculation
  private readonly serverStartTime: number = Date.now();
  // Pending respawn start timers (for cleanup on shutdown)
  private pendingRespawnStarts: Map<string, NodeJS.Timeout> = new Map();
  // Active plan orchestrators (for cancellation via API)
  private activePlanOrchestrators: Map<string, PlanOrchestrator> = new Map();
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
  constructor(port: number = 3000, https: boolean = false, testMode: boolean = false) {
    super();
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

    // Set up mux event listeners (SSE event names kept as screen:* for frontend compat)
    this.mux.on('sessionCreated', (session) => {
      this.broadcast('screen:created', session);
    });
    this.mux.on('sessionKilled', (data) => {
      this.broadcast('screen:killed', data);
    });
    this.mux.on('sessionDied', (data) => {
      this.broadcast('screen:died', data);
    });
    this.mux.on('statsUpdated', (screens) => {
      this.broadcast('screen:statsUpdated', screens);
    });

    // Set up subagent watcher listeners
    this.setupSubagentWatcherListeners();

    // Set up image watcher listeners
    this.setupImageWatcherListeners();
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
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });

      this.sseClients.add(reply);

      // Send initial state
      // Use light state for SSE init to avoid sending 2MB+ terminal buffers
      // Buffers are fetched on-demand when switching tabs
      this.sendSSE(reply, 'init', this.getLightState());

      req.raw.on('close', () => {
        this.sseClients.delete(reply);
        this.backpressuredClients.delete(reply);
      });
    });

    // API Routes
    this.app.get('/api/status', async () => this.getLightState());

    // Cleanup stale sessions from state file
    this.app.post('/api/cleanup-state', async () => {
      const cleaned = this.cleanupStaleSessions();
      return { success: true, cleanedSessions: cleaned };
    });

    // Global stats endpoint
    this.app.get('/api/stats', async () => {
      const activeSessionTokens: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> = {};
      for (const [sessionId, session] of this.sessions) {
        activeSessionTokens[sessionId] = {
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          totalCost: session.totalCost,
        };
      }
      return {
        success: true,
        stats: this.store.getAggregateStats(activeSessionTokens),
        raw: this.store.getGlobalStats(),
      };
    });

    // Token stats with daily history
    this.app.get('/api/token-stats', async () => {
      // Get aggregate totals (global + active sessions)
      const activeSessionTokens: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }> = {};
      for (const [sessionId, session] of this.sessions) {
        activeSessionTokens[sessionId] = {
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          totalCost: session.totalCost,
        };
      }
      return {
        success: true,
        daily: this.store.getDailyStats(30),
        totals: this.store.getAggregateStats(activeSessionTokens),
      };
    });

    this.app.get('/api/config', async () => {
      return { success: true, config: this.store.getConfig() };
    });

    this.app.put('/api/config', async (req) => {
      // Validate request body against schema to prevent arbitrary config injection
      const parseResult = ConfigUpdateSchema.safeParse(req.body);
      if (!parseResult.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Invalid config: ${parseResult.error.message}`);
      }
      this.store.setConfig(parseResult.data as Partial<ReturnType<typeof this.store.getConfig>>);
      return { success: true, config: this.store.getConfig() };
    });

    // Debug/monitoring endpoint - lightweight, only runs when called
    // Returns comprehensive memory metrics for debugging memory leaks
    this.app.get('/api/debug/memory', async () => {
      const mem = process.memoryUsage();
      const subagentStats = subagentWatcher.getStats();

      // Calculate total Map entries for memory estimation
      const serverMapSizes = {
        sessions: this.sessions.size,
        sseClients: this.sseClients.size,
        respawnControllers: this.respawnControllers.size,
        runSummaryTrackers: this.runSummaryTrackers.size,
        transcriptWatchers: this.transcriptWatchers.size,
        scheduledRuns: this.scheduledRuns.size,
        terminalBatches: this.terminalBatches.size,
        outputBatches: this.outputBatches.size,
        taskUpdateBatches: this.taskUpdateBatches.size,
        stateUpdatePending: this.stateUpdatePending.size,
        lastRecordedTokens: this.lastRecordedTokens.size,
        pendingRespawnStarts: this.pendingRespawnStarts.size,
        respawnTimers: this.respawnTimers.size,
        activePlanOrchestrators: this.activePlanOrchestrators.size,
        cleaningUp: this.cleaningUp.size,
      };

      const totalServerMapEntries = Object.values(serverMapSizes).reduce((a, b) => a + b, 0);
      const totalSubagentMapEntries = Object.values(subagentStats).reduce((a, b) => a + b, 0);

      return {
        memory: {
          rss: mem.rss,
          rssMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
          heapUsed: mem.heapUsed,
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
          heapTotal: mem.heapTotal,
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
          external: mem.external,
          externalMB: Math.round(mem.external / 1024 / 1024 * 10) / 10,
          arrayBuffers: mem.arrayBuffers,
          arrayBuffersMB: Math.round(mem.arrayBuffers / 1024 / 1024 * 10) / 10,
        },
        mapSizes: {
          server: serverMapSizes,
          subagentWatcher: subagentStats,
          totals: {
            serverEntries: totalServerMapEntries,
            subagentEntries: totalSubagentMapEntries,
            allEntries: totalServerMapEntries + totalSubagentMapEntries,
          },
        },
        watchers: {
          fileWatchers: subagentStats.fileWatcherCount,
          dirWatchers: subagentStats.dirWatcherCount,
          transcriptWatchers: this.transcriptWatchers.size,
          total: subagentStats.fileWatcherCount + subagentStats.dirWatcherCount + this.transcriptWatchers.size,
        },
        timers: {
          respawnTimers: this.respawnTimers.size,
          pendingRespawnStarts: this.pendingRespawnStarts.size,
          subagentIdleTimers: subagentStats.idleTimerCount,
          total: this.respawnTimers.size + this.pendingRespawnStarts.size + subagentStats.idleTimerCount,
        },
        uptime: {
          seconds: Math.round(process.uptime()),
          formatted: formatUptime(process.uptime()),
        },
        timestamp: Date.now(),
      };
    });

    // Session management
    this.app.get('/api/sessions', async () => this.getLightSessionsState());

    this.app.post('/api/sessions', async (req): Promise<SessionResponse> => {
      // Prevent unbounded session creation
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached. Delete some sessions first.`);
      }

      const result = CreateSessionSchema.safeParse(req.body);
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
      }
      const body = result.data;
      const workingDir = body.workingDir || process.cwd();

      // Write env overrides to .claude/settings.local.json if provided
      if (body.envOverrides && Object.keys(body.envOverrides).length > 0) {
        updateCaseEnvVars(workingDir, body.envOverrides);
      }

      const globalNice = await this.getGlobalNiceConfig();
      const session = new Session({
        workingDir,
        mode: body.mode || 'claude',
        name: body.name || '',
        screenManager: this.mux,
        useScreen: true,
        niceConfig: globalNice,
      });

      this.sessions.set(session.id, session);
      this.store.incrementSessionsCreated();
      this.persistSessionState(session);
      await this.setupSessionListeners(session);

      this.broadcast('session:created', session.toDetailedState());
      return { success: true, session: session.toDetailedState() };
    });

    // Rename a session
    this.app.put('/api/sessions/:id/name', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { name: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const name = String(body.name || '').slice(0, MAX_SESSION_NAME_LENGTH);
      session.name = name;
      // Also update the screen name if this session has a screen
      this.mux.updateSessionName(id, session.name);
      this.persistSessionState(session);
      this.broadcast('session:updated', this.getSessionStateWithRespawn(session));
      return { success: true, name: session.name };
    });

    // Set session color
    this.app.put('/api/sessions/:id/color', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { color: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
      if (!validColors.includes(body.color)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid color');
      }

      session.setColor(body.color as import('../types.js').SessionColor);
      this.persistSessionState(session);
      this.broadcast('session:updated', this.getSessionStateWithRespawn(session));
      return { success: true, color: session.color };
    });

    this.app.delete('/api/sessions/:id', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const query = req.query as { killScreen?: string };
      const killScreen = query.killScreen !== 'false'; // Default to true

      if (!this.sessions.has(id)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
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

      // Include respawn controller state if active
      const controller = this.respawnControllers.get(id);
      return {
        ...session.toDetailedState(),
        respawnEnabled: controller?.getConfig()?.enabled ?? false,
        respawnConfig: controller?.getConfig() ?? null,
        respawn: controller?.getStatus() ?? null,
      };
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
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
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

    // Get run summary for a session (what happened while you were away)
    this.app.get('/api/sessions/:id/run-summary', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const tracker = this.runSummaryTrackers.get(id);
      if (!tracker) {
        // Create a fresh tracker if one doesn't exist (shouldn't happen normally)
        const newTracker = new RunSummaryTracker(id, session.name);
        this.runSummaryTrackers.set(id, newTracker);
        return { success: true, summary: newTracker.getSummary() };
      }

      // Update session name in case it changed
      tracker.setSessionName(session.name);

      return { success: true, summary: tracker.getSummary() };
    });

    // Get active Bash tools for a session (file-viewing commands)
    this.app.get('/api/sessions/:id/active-tools', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      return {
        success: true,
        data: {
          tools: session.activeTools,
        }
      };
    });

    // Get file tree for session's working directory (File Browser)
    this.app.get('/api/sessions/:id/files', async (req) => {
      const { id } = req.params as { id: string };
      const { depth, showHidden } = req.query as { depth?: string; showHidden?: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const maxDepth = Math.min(parseInt(depth || '5', 10), 10);
      const includeHidden = showHidden === 'true';
      const workingDir = session.workingDir;

      // Default excludes - large/generated directories
      const excludeDirs = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__', '.cache', '.next', '.nuxt', 'coverage', '.venv', 'venv', '.tox', 'target', 'vendor']);

      interface FileTreeNode {
        name: string;
        path: string;
        type: 'file' | 'directory';
        size?: number;
        extension?: string;
        children?: FileTreeNode[];
      }

      let totalFiles = 0;
      let totalDirectories = 0;
      let truncated = false;
      const maxFiles = 5000;

      const scanDirectory = async (dirPath: string, currentDepth: number): Promise<FileTreeNode[]> => {
        if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles) {
          truncated = true;
          return [];
        }

        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          const nodes: FileTreeNode[] = [];

          // Sort: directories first, then alphabetically
          entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

          for (const entry of entries) {
            if (totalFiles + totalDirectories > maxFiles) {
              truncated = true;
              break;
            }

            // Skip hidden files unless requested
            if (!includeHidden && entry.name.startsWith('.')) continue;

            // Skip excluded directories
            if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

            const fullPath = join(dirPath, entry.name);
            const relativePath = fullPath.slice(workingDir.length + 1);

            if (entry.isDirectory()) {
              totalDirectories++;
              const children = await scanDirectory(fullPath, currentDepth + 1);
              nodes.push({
                name: entry.name,
                path: relativePath,
                type: 'directory',
                children,
              });
            } else {
              totalFiles++;
              const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined;
              let size: number | undefined;
              try {
                const stat = await fs.stat(fullPath);
                size = stat.size;
              } catch {
                // Skip if can't stat
              }
              nodes.push({
                name: entry.name,
                path: relativePath,
                type: 'file',
                size,
                extension: ext,
              });
            }
          }

          return nodes;
        } catch (err) {
          // Can't read directory (permission denied, etc.)
          return [];
        }
      };

      const tree = await scanDirectory(workingDir, 1);

      return {
        success: true,
        data: {
          root: workingDir,
          tree,
          totalFiles,
          totalDirectories,
          truncated,
        }
      };
    });

    // Get file content for preview (File Browser)
    this.app.get('/api/sessions/:id/file-content', async (req) => {
      const { id } = req.params as { id: string };
      const { path: filePath, lines, raw } = req.query as { path?: string; lines?: string; raw?: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (!filePath) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
      }

      // Validate path is within working directory (security: proper path traversal check)
      const fullPath = resolve(session.workingDir, filePath);
      const relativePath = relative(session.workingDir, fullPath);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path must be within working directory');
      }

      try {
        const stat = await fs.stat(fullPath);

        // Check if it's a binary/media file
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const binaryExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'bmp', 'mp4', 'webm', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'so', 'woff', 'woff2', 'ttf', 'eot']);
        const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
        const videoExts = new Set(['mp4', 'webm', 'mov', 'avi']);

        if (raw === 'true' || binaryExts.has(ext)) {
          // Return metadata for binary files
          return {
            success: true,
            data: {
              path: filePath,
              size: stat.size,
              type: imageExts.has(ext) ? 'image' : videoExts.has(ext) ? 'video' : 'binary',
              extension: ext,
              url: `/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`,
            }
          };
        }

        // Validate file size before reading (DoS protection - prevent memory exhaustion)
        const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
        if (stat.size > MAX_TEXT_FILE_SIZE) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit)`);
        }

        // Read text file with line limit (bounded to prevent DoS)
        const MAX_LINES_LIMIT = 10000;
        const maxLines = Math.min(parseInt(lines || '500', 10) || 500, MAX_LINES_LIMIT);
        const content = await fs.readFile(fullPath, 'utf-8');
        const allLines = content.split('\n');
        const truncatedContent = allLines.length > maxLines;
        const displayContent = truncatedContent ? allLines.slice(0, maxLines).join('\n') : content;

        return {
          success: true,
          data: {
            path: filePath,
            content: displayContent,
            size: stat.size,
            totalLines: allLines.length,
            truncated: truncatedContent,
            extension: ext,
          }
        };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`);
      }
    });

    // Serve raw file content (for images/binary files)
    this.app.get('/api/sessions/:id/file-raw', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { path: filePath } = req.query as { path?: string };
      const session = this.sessions.get(id);

      if (!session) {
        reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found'));
        return;
      }

      if (!filePath) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
        return;
      }

      // Validate path is within working directory (security: proper path traversal check)
      const fullPath = resolve(session.workingDir, filePath);
      const relativePath = relative(session.workingDir, fullPath);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path must be within working directory'));
        return;
      }

      try {
        // Validate file size before reading (DoS protection - prevent memory exhaustion)
        const MAX_RAW_FILE_SIZE = 50 * 1024 * 1024; // 50MB for raw files
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_RAW_FILE_SIZE) {
          reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_RAW_FILE_SIZE / 1024 / 1024}MB limit)`));
          return;
        }

        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const mimeTypes: Record<string, string> = {
          'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif',
          'webp': 'image/webp', 'svg': 'image/svg+xml', 'ico': 'image/x-icon', 'bmp': 'image/bmp',
          'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
          'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
          'pdf': 'application/pdf', 'json': 'application/json',
        };

        const content = await fs.readFile(fullPath);
        reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        reply.send(content);
      } catch (err) {
        reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
      }
    });

    // Stream file content via tail -f (SSE endpoint)
    this.app.get('/api/sessions/:id/tail-file', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { path: filePath, lines } = req.query as { path?: string; lines?: string };
      const session = this.sessions.get(id);

      if (!session) {
        reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found'));
        return;
      }

      if (!filePath) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
        return;
      }

      // Set up SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Track stream for cleanup
      const streamRef: { id?: string } = {};

      // Create the file stream
      const result = await fileStreamManager.createStream({
        sessionId: id,
        filePath,
        workingDir: session.workingDir,
        lines: lines ? parseInt(lines, 10) : undefined,
        onData: (data) => {
          // Send data as SSE event
          reply.raw.write(`data: ${JSON.stringify({ type: 'data', content: data })}\n\n`);
        },
        onEnd: () => {
          reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
          reply.raw.end();
        },
        onError: (error) => {
          reply.raw.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        },
      });

      if (!result.success) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: result.error })}\n\n`);
        reply.raw.end();
        return;
      }

      streamRef.id = result.streamId;

      // Notify client of successful connection
      reply.raw.write(`data: ${JSON.stringify({ type: 'connected', streamId: result.streamId, filePath })}\n\n`);

      // Handle client disconnect
      req.raw.on('close', () => {
        if (streamRef.id) {
          fileStreamManager.closeStream(streamRef.id);
        }
      });
    });

    // Close a file stream
    this.app.delete('/api/sessions/:id/tail-file/:streamId', async (req) => {
      const { id, streamId } = req.params as { id: string; streamId: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const closed = fileStreamManager.closeStream(streamId);
      return { success: closed };
    });

    // Configure Ralph (Ralph Wiggum) settings
    this.app.post('/api/sessions/:id/ralph-config', async (req) => {
      const { id } = req.params as { id: string };
      const { enabled, completionPhrase, maxIterations, reset, disableAutoEnable } = req.body as {
        enabled?: boolean;
        completionPhrase?: string;
        maxIterations?: number;
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
          // Allow re-enabling on restart if user explicitly enabled
          session.ralphTracker.enableAutoEnable();
        } else {
          session.ralphTracker.disable();
          // Prevent re-enabling on restart when user explicitly disabled
          session.ralphTracker.disableAutoEnable();
        }
        // Persist Ralph enabled state
        this.mux.updateRalphEnabled(id, enabled);
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

      // Persist and broadcast the update
      this.persistSessionState(session);
      this.broadcast('session:ralphLoopUpdate', {
        sessionId: id,
        state: session.ralphLoopState
      });

      return { success: true };
    });

    // Reset circuit breaker for Ralph tracker
    this.app.post('/api/sessions/:id/ralph-circuit-breaker/reset', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      session.ralphTracker.resetCircuitBreaker();
      return { success: true };
    });

    // Get Ralph status block and circuit breaker state
    this.app.get('/api/sessions/:id/ralph-status', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      return {
        success: true,
        data: {
          lastStatusBlock: session.ralphTracker.lastStatusBlock,
          circuitBreaker: session.ralphTracker.circuitBreakerStatus,
          cumulativeStats: session.ralphTracker.cumulativeStats,
          exitGateMet: session.ralphTracker.exitGateMet,
        }
      };
    });

    // Generate @fix_plan.md content from todos
    this.app.get('/api/sessions/:id/fix-plan', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const content = session.ralphTracker.generateFixPlanMarkdown();
      return {
        success: true,
        data: {
          content,
          todoCount: session.ralphTracker.todos.length,
        }
      };
    });

    // Import todos from @fix_plan.md content
    this.app.post('/api/sessions/:id/fix-plan/import', async (req) => {
      const { id } = req.params as { id: string };
      const { content } = req.body as { content: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (!content || typeof content !== 'string') {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Content is required');
      }

      const importedCount = session.ralphTracker.importFixPlanMarkdown(content);
      this.persistSessionState(session);

      return {
        success: true,
        data: {
          importedCount,
          todos: session.ralphTracker.todos,
        }
      };
    });

    // Write @fix_plan.md to session's working directory
    this.app.post('/api/sessions/:id/fix-plan/write', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const workingDir = session.workingDir;
      if (!workingDir) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session has no working directory');
      }

      const content = session.ralphTracker.generateFixPlanMarkdown();
      const filePath = path.join(workingDir, '@fix_plan.md');

      try {
        await fs.writeFile(filePath, content, 'utf-8');
        return {
          success: true,
          data: {
            filePath,
            todoCount: session.ralphTracker.todos.length,
          }
        };
      } catch (error) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to write file: ${error}`);
      }
    });

    // Read @fix_plan.md from session's working directory and import
    this.app.post('/api/sessions/:id/fix-plan/read', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const workingDir = session.workingDir;
      if (!workingDir) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session has no working directory');
      }

      const filePath = path.join(workingDir, '@fix_plan.md');

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const importedCount = session.ralphTracker.importFixPlanMarkdown(content);
        this.persistSessionState(session);

        return {
          success: true,
          data: {
            filePath,
            importedCount,
            todos: session.ralphTracker.todos,
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return createErrorResponse(ApiErrorCode.NOT_FOUND, '@fix_plan.md not found in working directory');
        }
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${error}`);
      }
    });

    // Write Ralph prompt to file in session's working directory
    // This avoids screen input escaping issues with long multi-line prompts
    this.app.post('/api/sessions/:id/ralph-prompt/write', async (req) => {
      const { id } = req.params as { id: string };
      const { content } = req.body as { content: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const workingDir = session.workingDir;
      if (!workingDir) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session has no working directory');
      }

      if (!content || typeof content !== 'string') {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Content is required');
      }

      const filePath = path.join(workingDir, '@ralph_prompt.md');

      try {
        await fs.writeFile(filePath, content, 'utf-8');
        return {
          success: true,
          data: {
            filePath,
            contentLength: content.length,
          }
        };
      } catch (error) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to write file: ${error}`);
      }
    });

    // Run prompt in session
    this.app.post('/api/sessions/:id/run', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const result = RunPromptSchema.safeParse(req.body);
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
      }
      const { prompt } = result.data;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (session.isBusy()) {
        return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
      }

      // Run async, don't wait
      session.runPrompt(prompt).catch(err => {
        this.broadcast('session:error', { id, error: err.message });
      });

      this.broadcast('session:running', { id, prompt });
      return { success: true };
    });

    // Start interactive Claude session (persists even if browser disconnects)
    this.app.post('/api/sessions/:id/interactive', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (session.isBusy()) {
        return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
      }

      try {
        // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
        if (this.store.getConfig().ralphEnabled && !session.ralphTracker.autoEnableDisabled) {
          autoConfigureRalph(session, session.workingDir, () => {});
          if (!session.ralphTracker.enabled) {
            session.ralphTracker.enable();
          }
        }

        await session.startInteractive();
        this.broadcast('session:interactive', { id });
        this.broadcast('session:updated', { session: this.getSessionStateWithRespawn(session) });

        return { success: true };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    });

    // Start a plain shell session (no Claude)
    this.app.post('/api/sessions/:id/shell', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (session.isBusy()) {
        return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
      }

      try {
        await session.startShell();
        this.broadcast('session:interactive', { id, mode: 'shell' });
        this.broadcast('session:updated', { session: this.getSessionStateWithRespawn(session) });
        return { success: true };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    });

    // Send input to interactive session
    // useScreen: true uses writeViaScreen which is more reliable for programmatic input
    this.app.post('/api/sessions/:id/input', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const result = SessionInputSchema.safeParse(req.body);
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
      }
      const { input, useScreen } = result.data;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const inputStr = String(input);
      if (inputStr.length > MAX_INPUT_LENGTH) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Input exceeds maximum length (${MAX_INPUT_LENGTH} bytes)`);
      }

      // Use writeViaScreen for programmatic input (more reliable for mux sessions)
      let success = false;
      if (useScreen) {
        success = session.writeViaScreen(inputStr);
        if (!success) {
          console.warn(`[Server] writeViaScreen failed for session ${id}, falling back to direct write`);
          // Fallback to direct write if screen write fails
          session.write(inputStr);
          success = true; // Direct write doesn't return status, assume success
        }
      } else {
        session.write(inputStr);
        success = true;
      }
      return { success };
    });

    // Resize session terminal
    this.app.post('/api/sessions/:id/resize', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const result = ResizeSchema.safeParse(req.body);
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
      }
      const { cols, rows } = result.data;
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      // Note: Zod already validates that cols and rows are positive integers within bounds
      if (cols > MAX_TERMINAL_COLS || rows > MAX_TERMINAL_ROWS) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Terminal dimensions exceed maximum (${MAX_TERMINAL_COLS}x${MAX_TERMINAL_ROWS})`);
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
      const claudeMatch = cleanBuffer.match(CLAUDE_BANNER_PATTERN);
      if (claudeMatch && claudeMatch.index !== undefined && claudeMatch.index > 0) {
        // Find the start of that line
        let lineStart = claudeMatch.index;
        while (lineStart > 0 && cleanBuffer[lineStart - 1] !== '\n') {
          lineStart--;
        }
        cleanBuffer = cleanBuffer.slice(lineStart);
      }

      // Remove Ctrl+L and leading whitespace
      cleanBuffer = cleanBuffer
        .replace(CTRL_L_PATTERN, '')
        .replace(LEADING_WHITESPACE_PATTERN, '');

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
      const preConfig = this.mux.getSession(id)?.respawnConfig;
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
        const preConfig = this.mux.getSession(id)?.respawnConfig;
        const config = body || preConfig ? { ...preConfig, ...body } : undefined;
        controller = new RespawnController(session, config);
        this.respawnControllers.set(id, controller);
        this.setupRespawnListeners(id, controller);
      } else if (body) {
        controller.updateConfig(body);
      }

      controller.start();

      // Persist respawn config to mux session and state.json
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

      // Remove controller from map so persistSessionState doesn't save respawnEnabled: true
      this.respawnControllers.delete(id);

      // Clear any timed respawn
      const timerInfo = this.respawnTimers.get(id);
      if (timerInfo) {
        clearTimeout(timerInfo.timer);
        this.respawnTimers.delete(id);
      }

      // Clear persisted respawn config
      this.mux.clearRespawnConfig(id);

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
      // Validate respawn config to prevent arbitrary field injection
      const parseResult = RespawnConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Invalid respawn config: ${parseResult.error.message}`);
      }
      const config = parseResult.data as Partial<RespawnConfig>;
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
      const existing = this.mux.getSession(id);
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
      this.mux.updateRespawnConfig(id, merged);
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
        // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
        if (this.store.getConfig().ralphEnabled && !session.ralphTracker.autoEnableDisabled) {
          autoConfigureRalph(session, session.workingDir, () => {});
          if (!session.ralphTracker.enabled) {
            session.ralphTracker.enable();
          }
        }

        // Start interactive session
        await session.startInteractive();
        this.broadcast('session:interactive', { id });
        this.broadcast('session:updated', { session: this.getSessionStateWithRespawn(session) });

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
      const preConfig = this.mux.getSession(id)?.respawnConfig;
      const config = body?.config || preConfig ? { ...preConfig, ...body?.config } : undefined;
      const controller = new RespawnController(session, config);
      this.respawnControllers.set(id, controller);
      this.setupRespawnListeners(id, controller);
      controller.start();

      // Set up timed stop if duration specified
      if (body?.durationMinutes && body.durationMinutes > 0) {
        this.setupTimedRespawn(id, body.durationMinutes);
      }

      // Persist respawn config to mux session and state.json
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
      this.broadcast('session:updated', this.getSessionStateWithRespawn(session));

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
      this.broadcast('session:updated', this.getSessionStateWithRespawn(session));

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

    // Toggle image watcher for a session
    this.app.post('/api/sessions/:id/image-watcher', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { enabled: boolean };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (body.enabled === undefined) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'enabled field is required');
      }

      if (body.enabled) {
        imageWatcher.watchSession(session.id, session.workingDir);
      } else {
        imageWatcher.unwatchSession(session.id);
      }

      // Store state on session for persistence
      session.imageWatcherEnabled = body.enabled;
      this.persistSessionState(session);

      return {
        success: true,
        data: {
          imageWatcherEnabled: body.enabled,
        },
      };
    });

    // Toggle flicker filter for a session
    this.app.post('/api/sessions/:id/flicker-filter', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { enabled: boolean };
      const session = this.sessions.get(id);

      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      if (body.enabled === undefined) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'enabled field is required');
      }

      session.flickerFilterEnabled = body.enabled;
      this.persistSessionState(session);
      this.broadcast('session:updated', this.getSessionStateWithRespawn(session));

      return {
        success: true,
        data: {
          flickerFilterEnabled: body.enabled,
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
      this.store.incrementSessionsCreated();
      this.persistSessionState(session);
      await this.setupSessionListeners(session);

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
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled run not found');
      }

      await this.stopScheduledRun(id);
      return { success: true };
    });

    this.app.get('/api/scheduled/:id', async (req) => {
      const { id } = req.params as { id: string };
      const run = this.scheduledRuns.get(id);

      if (!run) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled run not found');
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
        const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
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
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[Server] Failed to read linked cases:', err);
        }
      }

      return cases;
    });

    this.app.post('/api/cases', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
      const result = CreateCaseSchema.safeParse(req.body);
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
      }
      const { name, description } = result.data;

      const casePath = join(casesDir, name);

      // Security: Path traversal protection - use relative path check
      const resolvedPath = resolve(casePath);
      const resolvedBase = resolve(casesDir);
      const relPath = relative(resolvedBase, resolvedPath);
      if (relPath.startsWith('..') || isAbsolute(relPath)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
      }

      if (existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Case already exists');
      }

      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });

        // Read settings to get custom template path
        const templatePath = await this.getDefaultClaudeMdPath();
        const claudeMd = generateClaudeMd(name, description || '', templatePath);
        writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

        // Write .claude/settings.local.json with hooks for desktop notifications
        writeHooksConfig(casePath);

        this.broadcast('case:created', { name, path: casePath });

        return { success: true, data: { case: { name, path: casePath } } };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    });

    // Link an existing folder as a case
    this.app.post('/api/cases/link', async (req): Promise<ApiResponse<{ case: { name: string; path: string } }>> => {
      const { name, path: folderPath } = req.body as { name: string; path: string };

      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name. Use only letters, numbers, hyphens, underscores.');
      }

      if (!folderPath) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Folder path is required.');
      }

      // Expand ~ to home directory
      const expandedPath = folderPath.startsWith('~')
        ? join(homedir(), folderPath.slice(1))
        : folderPath;

      // Validate the folder exists
      if (!existsSync(expandedPath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${expandedPath}`);
      }

      // Check if case name already exists in casesDir
      const casePath = join(casesDir, name);
      if (existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A case with this name already exists in claudeman-cases.');
      }

      // Load existing linked cases
      const linkedCasesFile = join(homedir(), '.claudeman', 'linked-cases.json');
      let linkedCases: Record<string, string> = {};
      try {
        linkedCases = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[Server] Failed to read linked cases:', err);
        }
      }

      // Check if name is already linked
      if (linkedCases[name]) {
        return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, `Case "${name}" is already linked to ${linkedCases[name]}`);
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
        return { success: true, data: { case: { name, path: expandedPath } } };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    });

    this.app.get('/api/cases/:name', async (req) => {
      const { name } = req.params as { name: string };

      // First check linked cases
      const linkedCasesFile = join(homedir(), '.claudeman', 'linked-cases.json');
      try {
        const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
        if (linkedCases[name]) {
          const linkedPath = linkedCases[name];
          return {
            name,
            path: linkedPath,
            hasClaudeMd: existsSync(join(linkedPath, 'CLAUDE.md')),
            linked: true,
          };
        }
      } catch {
        // ENOENT or parse errors - fall through to casesDir check
      }

      // Then check casesDir
      const casePath = join(casesDir, name);

      if (!existsSync(casePath)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
      }

      return {
        name,
        path: casePath,
        hasClaudeMd: existsSync(join(casePath, 'CLAUDE.md')),
      };
    });

    // Read @fix_plan.md from a case directory (for wizard to detect existing plans)
    this.app.get('/api/cases/:name/fix-plan', async (req) => {
      const { name } = req.params as { name: string };

      // Get case path (check linked cases first, then casesDir)
      let casePath: string | null = null;

      const linkedCasesFile = join(homedir(), '.claudeman', 'linked-cases.json');
      try {
        const linkedCases: Record<string, string> = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8'));
        if (linkedCases[name]) {
          casePath = linkedCases[name];
        }
      } catch {
        // ENOENT or parse errors - fall through to casesDir
      }

      if (!casePath) {
        casePath = join(casesDir, name);
      }

      const fixPlanPath = join(casePath, '@fix_plan.md');

      if (!existsSync(fixPlanPath)) {
        return { success: true, exists: false, content: null, todos: [] };
      }

      try {
        const content = await fs.readFile(fixPlanPath, 'utf-8');

        // Parse todos from the content (similar to ralph-tracker's importFixPlanMarkdown)
        const todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; priority: string | null }> = [];
        const todoPattern = /^-\s*\[([ xX\-])\]\s*(.+)$/;
        const p0HeaderPattern = /^##\s*(High Priority|Critical|P0|Critical Path)/i;
        const p1HeaderPattern = /^##\s*(Standard|P1|Medium Priority)/i;
        const p2HeaderPattern = /^##\s*(Nice to Have|P2|Low Priority)/i;
        const completedHeaderPattern = /^##\s*Completed/i;

        let currentPriority: string | null = null;
        let inCompletedSection = false;

        for (const line of content.split('\n')) {
          const trimmed = line.trim();

          if (p0HeaderPattern.test(trimmed)) {
            currentPriority = 'P0';
            inCompletedSection = false;
            continue;
          }
          if (p1HeaderPattern.test(trimmed)) {
            currentPriority = 'P1';
            inCompletedSection = false;
            continue;
          }
          if (p2HeaderPattern.test(trimmed)) {
            currentPriority = 'P2';
            inCompletedSection = false;
            continue;
          }
          if (completedHeaderPattern.test(trimmed)) {
            inCompletedSection = true;
            continue;
          }

          const match = trimmed.match(todoPattern);
          if (match) {
            const [, checkboxState, taskContent] = match;
            let status: 'pending' | 'in_progress' | 'completed';

            if (inCompletedSection || checkboxState === 'x' || checkboxState === 'X') {
              status = 'completed';
            } else if (checkboxState === '-') {
              status = 'in_progress';
            } else {
              status = 'pending';
            }

            todos.push({
              content: taskContent.trim(),
              status,
              priority: inCompletedSection ? null : currentPriority,
            });
          }
        }

        // Calculate stats in a single pass for better performance
        let pending = 0, inProgress = 0, completed = 0;
        for (const t of todos) {
          if (t.status === 'pending') pending++;
          else if (t.status === 'in_progress') inProgress++;
          else if (t.status === 'completed') completed++;
        }
        const stats = { total: todos.length, pending, inProgress, completed };

        return {
          success: true,
          exists: true,
          content,
          todos,
          stats,
        };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read @fix_plan.md: ${err}`);
      }
    });

    // Quick Start: Create case (if needed) and start interactive session in one click
    this.app.post('/api/quick-start', async (req): Promise<QuickStartResponse> => {
      // Prevent unbounded session creation
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        return { success: false, error: `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached.` };
      }

      const result = QuickStartSchema.safeParse(req.body);
      if (!result.success) {
        return { success: false, error: result.error.issues[0]?.message ?? 'Validation failed' };
      }
      const { caseName = 'testcase', mode = 'claude' } = result.data;

      const casePath = join(casesDir, caseName);

      // Security: Path traversal protection - use relative path check
      const resolvedPath = resolve(casePath);
      const resolvedBase = resolve(casesDir);
      const relPath = relative(resolvedBase, resolvedPath);
      if (relPath.startsWith('..') || isAbsolute(relPath)) {
        return { success: false, error: 'Invalid case path' };
      }

      // Create case folder and CLAUDE.md if it doesn't exist
      if (!existsSync(casePath)) {
        try {
          mkdirSync(casePath, { recursive: true });
          mkdirSync(join(casePath, 'src'), { recursive: true });

          // Read settings to get custom template path
          const templatePath = await this.getDefaultClaudeMdPath();
          const claudeMd = generateClaudeMd(caseName, '', templatePath);
          writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

          // Write .claude/settings.local.json with hooks for desktop notifications
          writeHooksConfig(casePath);

          this.broadcast('case:created', { name: caseName, path: casePath });
        } catch (err) {
          return { success: false, error: `Failed to create case: ${getErrorMessage(err)}` };
        }
      }

      // Create a new session with the case as working directory
      // Apply global Nice priority config if enabled in settings
      const niceConfig = await this.getGlobalNiceConfig();
      const session = new Session({
        workingDir: casePath,
        screenManager: this.mux,
        useScreen: true,
        mode: mode,
        niceConfig: niceConfig,
      });

      // Auto-detect completion phrase from CLAUDE.md BEFORE broadcasting
      // so the initial state already has the phrase configured (only if globally enabled)
      if (mode === 'claude' && this.store.getConfig().ralphEnabled) {
        autoConfigureRalph(session, casePath, () => {}); // no broadcast yet
        if (!session.ralphTracker.enabled) {
          session.ralphTracker.enable();
          session.ralphTracker.enableAutoEnable(); // Allow re-enabling on restart
        }
      }

      this.sessions.set(session.id, session);
      this.store.incrementSessionsCreated();
      this.persistSessionState(session);
      await this.setupSessionListeners(session);
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
        this.broadcast('session:updated', { session: this.getSessionStateWithRespawn(session) });

        // Save lastUsedCase to settings for TUI/web sync
        try {
          const settingsFilePath = join(homedir(), '.claudeman', 'settings.json');
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
        await this.cleanupSession(session.id);
        return { success: false, error: getErrorMessage(err) };
      }
    });

    // Generate implementation plan from task description using Claude
    interface GeneratePlanRequest {
      taskDescription: string;
      detailLevel?: 'brief' | 'standard' | 'detailed';
    }

    // Use enhanced PlanItem from orchestrator (has verification, dependencies, tracking)
    type PlanItem = import('../plan-orchestrator.js').PlanItem;

    this.app.post('/api/generate-plan', async (req): Promise<ApiResponse> => {
      const {
        taskDescription,
        detailLevel = 'standard'
      } = req.body as GeneratePlanRequest;

      if (!taskDescription || typeof taskDescription !== 'string') {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Task description is required');
      }

      if (taskDescription.length > 10000) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Task description too long (max 10000 chars)');
      }

      // Build sophisticated prompt based on Ralph Wiggum methodology
      const detailConfig = {
        brief: { style: 'high-level milestones', testDepth: 'basic' },
        standard: { style: 'balanced implementation steps', testDepth: 'thorough' },
        detailed: { style: 'granular sub-tasks with full TDD coverage', testDepth: 'comprehensive' },
      };
      const levelConfig = detailConfig[detailLevel] || detailConfig.standard;

      const prompt = `You are an expert software architect breaking down a task into a thorough implementation plan.

## TASK TO IMPLEMENT
${taskDescription}

## YOUR MISSION
Create a detailed, actionable implementation plan following Test-Driven Development (TDD) methodology.
Think deeply about:
- What are ALL the components, modules, and features needed?
- What could go wrong? Add defensive steps for error handling.
- How will we verify each part works? Tests before implementation.
- What edge cases need handling?
- What's the logical order of dependencies?

## DETAIL LEVEL: ${detailLevel.toUpperCase()}
Style: ${levelConfig.style}
Generate as many steps as needed to properly cover the task - don't artificially limit yourself.
For complex projects, this could be 30, 50, or even 100+ steps. Quality over brevity.

## PLAN STRUCTURE

Your plan MUST include these phases in order:

### Phase 1: Foundation & Setup
- Project structure, dependencies, configuration
- Database schemas, type definitions, interfaces

### Phase 2: Core Implementation (TDD Cycle)
For EACH feature:
1. Write failing tests first (unit tests)
2. Implement the feature
3. Run tests, debug until passing
4. Refactor if needed

### Phase 3: Integration & Edge Cases
- Integration tests for feature interactions
- Edge case handling (errors, boundaries, invalid input)
- Error messages and user feedback

### Phase 4: Verification & Hardening
- Run full test suite
- Fix any failing tests
- Add missing test coverage
- Final verification that ALL requirements are met

## OUTPUT FORMAT
Return ONLY a JSON array. Each item MUST have:
- id: unique identifier (e.g., "P0-001", "P1-002")
- content: specific action (verb phrase, 15-120 chars, be descriptive!)
- priority: "P0" (critical/blocking), "P1" (required), "P2" (enhancement)
- verificationCriteria: HOW to verify this step is complete (required!)
- tddPhase: "setup" | "test" | "impl" | "verify"
- dependencies: array of task IDs this depends on (empty if none)

## EXAMPLE OUTPUT
[
  {"id": "P0-001", "content": "Create project structure with src/, tests/, and config directories", "priority": "P0", "verificationCriteria": "Directories exist, package.json initialized", "tddPhase": "setup", "dependencies": []},
  {"id": "P0-002", "content": "Define TypeScript interfaces for User, Session, and AuthToken types", "priority": "P0", "verificationCriteria": "Types compile without errors, exported from types.ts", "tddPhase": "setup", "dependencies": ["P0-001"]},
  {"id": "P0-003", "content": "Write failing unit tests for password hashing (valid password, empty, too short)", "priority": "P0", "verificationCriteria": "Tests exist, fail with 'not implemented'", "tddPhase": "test", "dependencies": ["P0-002"]},
  {"id": "P0-004", "content": "Implement password hashing with bcrypt, configurable salt rounds", "priority": "P0", "verificationCriteria": "npm test -- --grep='password' passes", "tddPhase": "impl", "dependencies": ["P0-003"]},
  {"id": "P0-005", "content": "Write failing tests for JWT token generation and validation", "priority": "P0", "verificationCriteria": "Tests exist, fail with 'not implemented'", "tddPhase": "test", "dependencies": ["P0-004"]},
  {"id": "P0-006", "content": "Implement JWT service with access/refresh token support", "priority": "P0", "verificationCriteria": "npm test -- --grep='JWT' passes", "tddPhase": "impl", "dependencies": ["P0-005"]},
  {"id": "P1-001", "content": "Write integration tests for login flow (valid creds, invalid, locked account)", "priority": "P1", "verificationCriteria": "Integration tests exist, fail until endpoint implemented", "tddPhase": "test", "dependencies": ["P0-006"]},
  {"id": "P1-002", "content": "Implement login endpoint with rate limiting and audit logging", "priority": "P1", "verificationCriteria": "All login tests pass, endpoint returns 200/401 correctly", "tddPhase": "impl", "dependencies": ["P1-001"]},
  {"id": "P1-003", "content": "Run full test suite and verify all tests pass", "priority": "P1", "verificationCriteria": "npm test exits with code 0, coverage > 80%", "tddPhase": "verify", "dependencies": ["P1-002"]}
]

## CRITICAL RULES
1. EVERY task MUST have verificationCriteria - this is non-negotiable!
2. EVERY implementation step should have a corresponding test step BEFORE it
3. Use tddPhase: "test" for writing tests, "impl" for implementation
4. Dependencies must form a valid DAG - no cycles
5. Be SPECIFIC - not "Add tests" but "Write tests for X covering Y and Z"
6. End with verification that ALL original requirements are met
7. Use P0 for foundation and core features, P1 for required work, P2 for nice-to-have

NOW: Generate the implementation plan for the task above. Think step by step.`;

      // Create temporary session for the AI call using Opus 4.5 for deep reasoning
      const session = new Session({
        workingDir: process.cwd(),
        screenManager: this.mux,
        useScreen: false, // No screen needed for one-shot
        mode: 'claude',
      });

      // Use Opus 4.5 for plan generation (better reasoning)
      const modelToUse = 'opus';

      try {
        const { result, cost } = await session.runPrompt(prompt, { model: modelToUse });

        // Parse JSON from result
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to parse plan - no JSON array found');
        }

        let items: PlanItem[];
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (!Array.isArray(parsed)) {
            return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Invalid response - expected array');
          }

          // Validate and normalize items with enhanced fields
          items = parsed.map((item: unknown, idx: number) => {
            if (typeof item !== 'object' || item === null) {
              return {
                id: `task-${idx}`,
                content: `Step ${idx + 1}`,
                priority: null,
                verificationCriteria: 'Task completed successfully',
                status: 'pending' as const,
                attempts: 0,
                version: 1,
              };
            }
            const obj = item as Record<string, unknown>;
            const content = typeof obj.content === 'string' ? obj.content.slice(0, 200) : `Step ${idx + 1}`;
            let priority: 'P0' | 'P1' | 'P2' | null = null;
            if (obj.priority === 'P0' || obj.priority === 'P1' || obj.priority === 'P2') {
              priority = obj.priority;
            }

            // Parse tddPhase
            let tddPhase: 'setup' | 'test' | 'impl' | 'verify' | undefined;
            if (obj.tddPhase === 'setup' || obj.tddPhase === 'test' || obj.tddPhase === 'impl' || obj.tddPhase === 'verify') {
              tddPhase = obj.tddPhase;
            }

            return {
              id: obj.id ? String(obj.id) : `task-${idx}`,
              content,
              priority,
              verificationCriteria: typeof obj.verificationCriteria === 'string'
                ? obj.verificationCriteria
                : 'Task completed successfully',
              tddPhase,
              dependencies: Array.isArray(obj.dependencies) ? obj.dependencies.map(String) : [],
              status: 'pending' as const,
              attempts: 0,
              version: 1,
            };
          });
          // No artificial limit - let Claude generate what's needed

        } catch (parseErr) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to parse plan JSON: ' + getErrorMessage(parseErr));
        }

        return {
          success: true,
          data: { items, costUsd: cost },
        };

      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Plan generation failed: ' + getErrorMessage(err));
      } finally {
        // Clean up the temporary session
        try {
          await session.stop();
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    // Generate detailed implementation plan using subagent orchestration
    // This spawns multiple specialist subagents in parallel for thorough analysis
    this.app.post('/api/generate-plan-detailed', async (req): Promise<ApiResponse> => {
      const { taskDescription, caseName } = req.body as { taskDescription: string; caseName?: string };

      if (!taskDescription || typeof taskDescription !== 'string') {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Task description is required');
      }

      if (taskDescription.length > 10000) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Task description too long (max 10000 chars)');
      }

      // Determine output directory for saving wizard results
      let outputDir: string | undefined;
      if (caseName) {
        const casesDir = join(homedir(), 'claudeman-cases');
        const casePath = join(casesDir, caseName);
        // Security: Path traversal protection - use relative path check
        const resolvedCase = resolve(casePath);
        const resolvedBase = resolve(casesDir);
        const relPath = relative(resolvedBase, resolvedCase);
        if (!relPath.startsWith('..') && !isAbsolute(relPath) && existsSync(casePath)) {
          outputDir = join(casePath, 'ralph-wizard');

          // Clear old ralph-wizard directory to ensure fresh prompts for each generation
          // This prevents stale prompts from previous runs being shown when clicking on agents
          if (existsSync(outputDir)) {
            try {
              rmSync(outputDir, { recursive: true, force: true });
              console.log(`[API] Cleared old ralph-wizard directory: ${outputDir}`);
            } catch (err) {
              console.warn(`[API] Failed to clear ralph-wizard directory:`, err);
            }
          }
        }
      }

      const orchestrator = new PlanOrchestrator(this.mux, process.cwd(), outputDir);

      // Store orchestrator for potential cancellation via API (not on disconnect)
      // Plan generation continues even if browser disconnects - only explicit cancel stops it
      const orchestratorId = `plan-${Date.now()}`;
      this.activePlanOrchestrators.set(orchestratorId, orchestrator);

      // Broadcast the orchestrator ID so frontend can cancel if needed
      this.broadcast('plan:started', { orchestratorId });

      // Track progress for SSE updates
      const progressUpdates: Array<{ phase: string; detail: string; timestamp: number }> = [];
      const onProgress = (phase: string, detail: string) => {
        const update = { phase, detail, timestamp: Date.now() };
        progressUpdates.push(update);
        // Broadcast progress to connected clients
        this.broadcast('plan:progress', update);
      };

      // Broadcast plan subagent events for UI visibility
      const onSubagent = (event: {
        type: string;
        agentId: string;
        agentType: string;
        model: string;
        status: string;
        detail?: string;
        itemCount?: number;
        durationMs?: number;
        error?: string;
      }) => {
        this.broadcast('plan:subagent', event);
      };

      try {
        const result: DetailedPlanResult = await orchestrator.generateDetailedPlan(
          taskDescription,
          onProgress,
          onSubagent
        );

        // Clean up orchestrator from active map
        this.activePlanOrchestrators.delete(orchestratorId);
        this.broadcast('plan:completed', { orchestratorId, success: result.success });

        if (!result.success) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, result.error || 'Plan generation failed');
        }

        return {
          success: true,
          data: {
            items: result.items,
            costUsd: result.costUsd,
            metadata: result.metadata,
            progressLog: progressUpdates,
            orchestratorId,
          },
        };
      } catch (err) {
        // Clean up on error too
        this.activePlanOrchestrators.delete(orchestratorId);
        this.broadcast('plan:completed', { orchestratorId, success: false, error: getErrorMessage(err) });
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Detailed plan generation failed: ' + getErrorMessage(err));
      }
    });

    // Cancel active plan generation
    this.app.post('/api/cancel-plan-generation', async (req): Promise<ApiResponse> => {
      const { orchestratorId } = req.body as { orchestratorId?: string };

      // If specific orchestrator ID provided, cancel just that one
      if (orchestratorId) {
        const orchestrator = this.activePlanOrchestrators.get(orchestratorId);
        if (!orchestrator) {
          return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Plan generation not found or already completed');
        }
        console.log(`[API] Cancelling plan generation ${orchestratorId}`);
        await orchestrator.cancel();
        this.activePlanOrchestrators.delete(orchestratorId);
        this.broadcast('plan:cancelled', { orchestratorId });
        return { success: true, data: { cancelled: orchestratorId } };
      }

      // Otherwise cancel all active plan generations
      const cancelled: string[] = [];
      for (const [id, orchestrator] of this.activePlanOrchestrators) {
        console.log(`[API] Cancelling plan generation ${id}`);
        await orchestrator.cancel();
        cancelled.push(id);
        this.broadcast('plan:cancelled', { orchestratorId: id });
      }
      this.activePlanOrchestrators.clear();

      return { success: true, data: { cancelled } };
    });

    // Get ralph-wizard files for a case (prompts and results)
    this.app.get('/api/cases/:caseName/ralph-wizard/files', async (req) => {
      const { caseName } = req.params as { caseName: string };
      const casesDir = join(homedir(), 'claudeman-cases');
      const casePath = join(casesDir, caseName);

      // Security: Path traversal protection - use relative path check
      const resolvedCase = resolve(casePath);
      const resolvedBase = resolve(casesDir);
      const relPath = relative(resolvedBase, resolvedCase);
      if (relPath.startsWith('..') || isAbsolute(relPath)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
      }

      const wizardDir = join(casePath, 'ralph-wizard');

      if (!existsSync(wizardDir)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Ralph wizard directory not found');
      }

      // List all subdirectories and their files
      const files: Array<{ agentType: string; promptFile?: string; resultFile?: string }> = [];
      const entries = readdirSync(wizardDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const agentDir = join(wizardDir, entry.name);
          const agentFiles: { agentType: string; promptFile?: string; resultFile?: string } = {
            agentType: entry.name,
          };

          if (existsSync(join(agentDir, 'prompt.md'))) {
            agentFiles.promptFile = `${entry.name}/prompt.md`;
          }
          if (existsSync(join(agentDir, 'result.json'))) {
            agentFiles.resultFile = `${entry.name}/result.json`;
          }

          if (agentFiles.promptFile || agentFiles.resultFile) {
            files.push(agentFiles);
          }
        }
      }

      return { success: true, data: { files, caseName } };
    });

    // Read a specific ralph-wizard file
    // Cache disabled to ensure fresh prompts when starting new plan generations
    this.app.get('/api/cases/:caseName/ralph-wizard/file/:filePath', async (req, reply) => {
      const { caseName, filePath } = req.params as { caseName: string; filePath: string };
      const casesDir = join(homedir(), 'claudeman-cases');
      const casePath = join(casesDir, caseName);

      // Prevent browser caching - prompts change between plan generations
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');

      // Security: Path traversal protection for case name - use relative path check
      const resolvedCase = resolve(casePath);
      const resolvedBase = resolve(casesDir);
      const relPath = relative(resolvedBase, resolvedCase);
      if (relPath.startsWith('..') || isAbsolute(relPath)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case name');
      }

      const wizardDir = join(casePath, 'ralph-wizard');

      // Decode the file path (it may be URL encoded)
      const decodedPath = decodeURIComponent(filePath);
      const fullPath = join(wizardDir, decodedPath);

      // Security: ensure path is within wizard directory
      const resolvedPath = resolve(fullPath);
      const resolvedWizard = resolve(wizardDir);
      if (!resolvedPath.startsWith(resolvedWizard)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid file path');
      }

      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
        }
        throw err;
      }
      const isJson = filePath.endsWith('.json');

      // Parse JSON content safely (may contain invalid JSON)
      let parsed: unknown = null;
      if (isJson) {
        try {
          parsed = JSON.parse(content);
        } catch {
          // Invalid JSON - return null for parsed, content still available as raw string
        }
      }

      return {
        success: true,
        data: {
          content,
          filePath: decodedPath,
          isJson,
          parsed,
        },
      };
    });

    // ============ Plan Management Endpoints ============
    // These endpoints support runtime plan adaptation with checkpoints, failure tracking, and versioning

    // Update a specific plan task (status, attempts, errors)
    this.app.patch('/api/sessions/:id/plan/task/:taskId', async (req) => {
      const { id, taskId } = req.params as { id: string; taskId: string };
      const session = this.sessions.get(id);
      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const tracker = session.ralphTracker;
      if (!tracker) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
      }

      const update = req.body as {
        status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
        error?: string;
        incrementAttempts?: boolean;
      };

      const result = tracker.updatePlanTask(taskId, update);
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, result.error || 'Task not found');
      }

      this.broadcast('session:planTaskUpdate', { sessionId: id, taskId, update: result.task });
      return { success: true, data: result.task };
    });

    // Trigger a checkpoint review (at iterations 5, 10, 20, etc.)
    this.app.post('/api/sessions/:id/plan/checkpoint', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);
      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const tracker = session.ralphTracker;
      if (!tracker) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
      }

      const checkpoint = tracker.generateCheckpointReview();
      this.broadcast('session:planCheckpoint', { sessionId: id, checkpoint });
      return { success: true, data: checkpoint };
    });

    // Get plan version history
    this.app.get('/api/sessions/:id/plan/history', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);
      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const tracker = session.ralphTracker;
      if (!tracker) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
      }

      return { success: true, data: tracker.getPlanHistory() };
    });

    // Rollback to a previous plan version
    this.app.post('/api/sessions/:id/plan/rollback/:version', async (req) => {
      const { id, version } = req.params as { id: string; version: string };
      const session = this.sessions.get(id);
      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const tracker = session.ralphTracker;
      if (!tracker) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
      }

      const result = tracker.rollbackToVersion(parseInt(version, 10));
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, result.error || 'Version not found');
      }

      this.broadcast('session:planRollback', { sessionId: id, version: parseInt(version, 10) });
      return { success: true, data: result.plan };
    });

    // Add a new task to the plan (for runtime adaptation)
    this.app.post('/api/sessions/:id/plan/task', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);
      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const tracker = session.ralphTracker;
      if (!tracker) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
      }

      const task = req.body as {
        content: string;
        priority?: 'P0' | 'P1' | 'P2';
        verificationCriteria?: string;
        dependencies?: string[];
        insertAfter?: string; // Task ID to insert after
      };

      if (!task.content) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Task content is required');
      }

      const result = tracker.addPlanTask(task);
      this.broadcast('session:planTaskAdded', { sessionId: id, task: result.task });
      return { success: true, data: result.task };
    });

    // ============ App Settings Endpoints ============
    const settingsPath = join(homedir(), '.claudeman', 'settings.json');

    this.app.get('/api/settings', async () => {
      try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        return JSON.parse(content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to read settings:', err);
        }
      }
      return {};
    });

    this.app.put('/api/settings', async (req) => {
      const settings = req.body as Record<string, unknown>;

      try {
        const dir = dirname(settingsPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

        // Handle subagent tracking toggle dynamically
        const subagentEnabled = settings.subagentTrackingEnabled ?? true;
        if (subagentEnabled && !subagentWatcher.isRunning()) {
          subagentWatcher.start();
          console.log('Subagent watcher started via settings change');
        } else if (!subagentEnabled && subagentWatcher.isRunning()) {
          subagentWatcher.stop();
          console.log('Subagent watcher stopped via settings change');
        }

        // Handle image watcher toggle dynamically
        const imageWatcherEnabled = settings.imageWatcherEnabled ?? true;
        if (imageWatcherEnabled && !imageWatcher.isRunning()) {
          imageWatcher.start();
          // Re-watch all active sessions that have image watcher enabled
          for (const session of this.sessions.values()) {
            if (session.imageWatcherEnabled) {
              imageWatcher.watchSession(session.id, session.workingDir);
            }
          }
          console.log('Image watcher started via settings change');
        } else if (!imageWatcherEnabled && imageWatcher.isRunning()) {
          imageWatcher.stop();
          console.log('Image watcher stopped via settings change');
        }

        return { success: true };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    });

    // ============ CPU Priority Endpoints ============

    // Get Nice priority config for a session
    this.app.get('/api/sessions/:id/cpu-limit', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);
      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }
      return {
        success: true,
        nice: session.niceConfig,
      };
    });

    // Update Nice priority config for a session
    // Note: Changes only apply to NEW sessions, not running ones
    this.app.post('/api/sessions/:id/cpu-limit', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);
      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      const body = req.body as Partial<NiceConfig>;

      // Validate inputs
      if (body.niceValue !== undefined) {
        if (typeof body.niceValue !== 'number' || body.niceValue < -20 || body.niceValue > 19) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Nice value must be between -20 and 19');
        }
      }

      session.setNice(body);
      this.persistSessionState(session);
      this.broadcast('session:updated', { session: this.getSessionStateWithRespawn(session) });

      return {
        success: true,
        nice: session.niceConfig,
        note: 'Nice priority only affects newly created mux sessions, not currently running ones.',
      };
    });

    // ============ Subagent Window State Endpoints ============
    // Persists minimized/open window states for cross-browser sync
    const windowStatesPath = join(homedir(), '.claudeman', 'subagent-window-states.json');

    this.app.get('/api/subagent-window-states', async () => {
      try {
        const content = await fs.readFile(windowStatesPath, 'utf-8');
        return JSON.parse(content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to read subagent window states:', err);
        }
      }
      return { minimized: {}, open: [] };
    });

    this.app.put('/api/subagent-window-states', async (req) => {
      const states = req.body as Record<string, unknown>;
      try {
        const dir = dirname(windowStatesPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(windowStatesPath, JSON.stringify(states, null, 2));
        return { success: true };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    });

    // ============ Subagent Parent Associations ============
    // Persists which TAB each agent window connects to.
    // This is the PERMANENT record of agent -> tab associations.
    const parentMapPath = join(homedir(), '.claudeman', 'subagent-parents.json');

    this.app.get('/api/subagent-parents', async () => {
      try {
        const content = await fs.readFile(parentMapPath, 'utf-8');
        return JSON.parse(content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to read subagent parent map:', err);
        }
      }
      return {};
    });

    this.app.put('/api/subagent-parents', async (req) => {
      const parentMap = req.body as Record<string, string>;
      try {
        const dir = dirname(parentMapPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(parentMapPath, JSON.stringify(parentMap, null, 2));
        return { success: true };
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
      }
    });

    // ============ Screen Management Endpoints ============

    // Get all tracked screens with stats
    this.app.get('/api/screens', async () => {
      const screens = await this.mux.getSessionsWithStats();
      return {
        screens,
        screenAvailable: this.mux.isAvailable()
      };
    });

    // Kill a mux session
    this.app.delete('/api/screens/:sessionId', async (req) => {
      const { sessionId } = req.params as { sessionId: string };
      const success = await this.mux.killSession(sessionId);
      return { success };
    });

    // Reconcile screens (find dead ones)
    this.app.post('/api/screens/reconcile', async () => {
      const result = await this.mux.reconcileSessions();
      return result;
    });

    // Start stats collection
    this.app.post('/api/screens/stats/start', async () => {
      this.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      return { success: true };
    });

    // Stop stats collection
    this.app.post('/api/screens/stats/stop', async () => {
      this.mux.stopStatsCollection();
      return { success: true };
    });

    // System stats endpoint for frontend header display
    this.app.get('/api/system/stats', async () => {
      return this.getSystemStats();
    });

    // ========== Subagent Monitoring (Claude Code Background Agents) ==========

    // List all known subagents
    this.app.get('/api/subagents', async (req) => {
      const { minutes } = req.query as { minutes?: string };
      const subagents = minutes
        ? subagentWatcher.getRecentSubagents(parseInt(minutes, 10))
        : subagentWatcher.getSubagents();
      return { success: true, data: subagents };
    });

    // Get subagents for a specific session (by working directory)
    this.app.get('/api/sessions/:id/subagents', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);
      if (!session) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`);
      }
      const subagents = subagentWatcher.getSubagentsForSession(session.workingDir);
      return { success: true, data: subagents };
    });

    // Get a specific subagent's info
    this.app.get('/api/subagents/:agentId', async (req) => {
      const { agentId } = req.params as { agentId: string };
      const info = subagentWatcher.getSubagent(agentId);
      if (!info) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, `Subagent ${agentId} not found`);
      }
      return { success: true, data: info };
    });

    // Get a subagent's transcript
    this.app.get('/api/subagents/:agentId/transcript', async (req) => {
      const { agentId } = req.params as { agentId: string };
      const { limit, format } = req.query as { limit?: string; format?: 'raw' | 'formatted' };
      const limitNum = limit ? parseInt(limit, 10) : undefined;
      const transcript = await subagentWatcher.getTranscript(agentId, limitNum);

      if (format === 'formatted') {
        const formatted = subagentWatcher.formatTranscript(transcript);
        return { success: true, data: { formatted, entryCount: transcript.length } };
      }

      return { success: true, data: transcript };
    });

    // Kill a subagent
    this.app.delete('/api/subagents/:agentId', async (req) => {
      const { agentId } = req.params as { agentId: string };
      const info = subagentWatcher.getSubagent(agentId);
      if (!info) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subagent not found');
      }

      const killed = await subagentWatcher.killSubagent(agentId);
      if (killed) {
        return { success: true, data: { agentId, status: 'killed' } };
      }
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Subagent not found or already completed');
    });

    // Trigger cleanup of stale subagents
    this.app.post('/api/subagents/cleanup', async () => {
      const removed = subagentWatcher.cleanupNow();
      return { success: true, data: { removed, remaining: subagentWatcher.getSubagents().length } };
    });

    // Clear all tracked subagents (memory only - does not delete files)
    this.app.delete('/api/subagents', async () => {
      const cleared = subagentWatcher.clearAll();
      return { success: true, data: { cleared } };
    });


    // ========== Hook Events ==========

    this.app.post('/api/hook-event', async (req) => {
      const result = HookEventSchema.safeParse(req.body);
      if (!result.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
      }
      const { event, sessionId, data } = result.data;
      if (!this.sessions.has(sessionId)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
      }

      // Signal the respawn controller based on hook event type
      const controller = this.respawnControllers.get(sessionId);
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

      // Start transcript watching if transcript_path is provided
      if (data && 'transcript_path' in data) {
        const transcriptPath = String(data.transcript_path);
        if (transcriptPath) {
          this.startTranscriptWatcher(sessionId, transcriptPath);
        }
      }

      // Sanitize forwarded data: only include known safe fields, limit size
      const safeData = sanitizeHookData(data);
      this.broadcast(`hook:${event}`, { sessionId, timestamp: Date.now(), ...safeData });

      // Track in run summary
      const summaryTracker = this.runSummaryTrackers.get(sessionId);
      if (summaryTracker) {
        summaryTracker.recordHookEvent(event, safeData);
      }

      return { success: true };
    });
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
        this.broadcast('transcript:tool_end', { sessionId, toolName, isError, timestamp: Date.now() });
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
      watcher.removeAllListeners();  // Prevent memory leaks from attached listeners
      watcher.stop();
      this.transcriptWatchers.delete(sessionId);
    }
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

  // Get system CPU and memory usage
  private getSystemStats(): { cpu: number; memory: { usedMB: number; totalMB: number; percent: number } } {
    try {
      // Memory stats
      const totalMem = totalmem();
      const freeMem = freemem();
      const usedMem = totalMem - freeMem;

      // CPU load average (1 min) as percentage (rough approximation)
      const load = loadavg()[0];
      const cpuCount = WebServer.CPU_COUNT;
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
  // Track sessions currently being cleaned up to prevent concurrent cleanup races
  private cleaningUp: Set<string> = new Set();

  private async cleanupSession(sessionId: string, killScreen: boolean = true): Promise<void> {
    // Guard against concurrent cleanup of the same session
    if (this.cleaningUp.has(sessionId)) return;
    this.cleaningUp.add(sessionId);

    try {
      await this._doCleanupSession(sessionId, killScreen);
    } finally {
      this.cleaningUp.delete(sessionId);
    }
  }

  private async _doCleanupSession(sessionId: string, killScreen: boolean): Promise<void> {
    const session = this.sessions.get(sessionId);

    // Stop watching @fix_plan.md for this session
    if (session) {
      session.ralphTracker.stopWatchingFixPlan();
    }

    // Kill all subagents spawned by this session
    if (session && killScreen) {
      try {
        await subagentWatcher.killSubagentsForSession(session.workingDir);
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
      const durationMinutes = timerInfo
        ? Math.round((timerInfo.endAt - timerInfo.startedAt) / 60000)
        : undefined;
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

    // Clear batches and pending state updates
    this.terminalBatches.delete(sessionId);
    this.outputBatches.delete(sessionId);
    this.taskUpdateBatches.delete(sessionId);
    this.stateUpdatePending.delete(sessionId);
    this.lastTerminalEventTime.delete(sessionId);
    this.adaptiveBatchIntervals.delete(sessionId);

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
      // Accumulate tokens to global stats before removing session
      // This preserves lifetime usage even after sessions are deleted
      if (killScreen && (session.inputTokens > 0 || session.outputTokens > 0 || session.totalCost > 0)) {
        this.store.addToGlobalStats(session.inputTokens, session.outputTokens, session.totalCost);
        // Record to daily stats (for what hasn't been recorded yet via periodic recording)
        const lastRecorded = this.lastRecordedTokens.get(sessionId) || { input: 0, output: 0 };
        const deltaInput = session.inputTokens - lastRecorded.input;
        const deltaOutput = session.outputTokens - lastRecorded.output;
        if (deltaInput > 0 || deltaOutput > 0) {
          this.store.recordDailyUsage(deltaInput, deltaOutput, sessionId);
        }
        this.lastRecordedTokens.delete(sessionId);
        console.log(`[Server] Added to global stats: ${session.inputTokens + session.outputTokens} tokens, $${session.totalCost.toFixed(4)} from session ${sessionId}`);
      }

      // Explicitly remove stored listeners to break closure references (prevents memory leak)
      const listeners = this.sessionListenerRefs.get(sessionId);
      if (listeners) {
        session.off('output', listeners.output);
        session.off('terminal', listeners.terminal);
        session.off('clearTerminal', listeners.clearTerminal);
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

  private async setupSessionListeners(session: Session): Promise<void> {
    // Create run summary tracker for this session
    const summaryTracker = new RunSummaryTracker(session.id, session.name);
    this.runSummaryTrackers.set(session.id, summaryTracker);
    summaryTracker.recordSessionStarted(session.mode, session.workingDir);

    // Set working directory for Ralph tracker to auto-load @fix_plan.md
    session.ralphTracker.setWorkingDir(session.workingDir);

    // Start watching for new images in this session's working directory (if enabled globally and per-session)
    if (await this.isImageWatcherEnabled() && session.imageWatcherEnabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    }

    // Store all listener references for explicit cleanup on session delete
    // This prevents memory leaks from closure references keeping objects alive
    const listeners: SessionListenerRefs = {
      output: (data) => {
        // Use batching for better performance at high throughput
        this.batchOutputData(session.id, data);
      },

      terminal: (data) => {
        // Use batching for better performance at high throughput
        this.batchTerminalData(session.id, data);
      },

      clearTerminal: () => {
        // Tell clients to clear their terminal (after screen attach)
        this.broadcast('session:clearTerminal', { id: session.id });
      },

      message: (msg: ClaudeMessage) => {
        this.broadcast('session:message', { id: session.id, message: msg });
      },

      error: (error) => {
        this.broadcast('session:error', { id: session.id, error });
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
          tracker.addEvent(
            'warning',
            'warning',
            'Circuit Breaker Opened',
            status.reason
          );
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
    session.on('output', listeners.output);
    session.on('terminal', listeners.terminal);
    session.on('clearTerminal', listeners.clearTerminal);
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
      this.broadcast('respawn:aiCheckCompleted', { sessionId, verdict: result.verdict, reasoning: result.reasoning, durationMs: result.durationMs });
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
      this.broadcast('respawn:planCheckCompleted', { sessionId, verdict: result.verdict, reasoning: result.reasoning, durationMs: result.durationMs });
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

    const timer = setTimeout(() => {
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
    }, durationMinutes * 60 * 1000);

    this.respawnTimers.set(sessionId, { timer, endAt, startedAt: now });
    this.broadcast('respawn:timerStarted', { sessionId, durationMinutes, endAt, startedAt: now });
  }


  /**
   * Restore a RespawnController from persisted configuration.
   * Creates the controller, sets up listeners, but does NOT start it.
   *
   * @param session - The session to attach the controller to
   * @param config - The persisted respawn configuration
   * @param source - Source of the config for logging (e.g., 'state.json' or 'screens.json')
   */
  private restoreRespawnController(
    session: Session,
    config: PersistedRespawnConfig,
    source: string
  ): void {
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
      console.log(`[Server] Restored respawn controller for session ${session.id} from ${source} (will start in ${Math.ceil(delayMs / 1000)}s)`);
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
      console.log(`[Server] Restored respawn controller for session ${session.id} from ${source} (started immediately)`);
    }

    if (config.durationMinutes && config.durationMinutes > 0) {
      this.setupTimedRespawn(session.id, config.durationMinutes);
    }
  }

  // Helper to get custom CLAUDE.md template path from settings
  private async getDefaultClaudeMdPath(): Promise<string | undefined> {
    const settingsPath = join(homedir(), '.claudeman', 'settings.json');

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

  // Helper to get global Nice priority config from settings
  private async getGlobalNiceConfig(): Promise<NiceConfig | undefined> {
    const settingsPath = join(homedir(), '.claudeman', 'settings.json');

    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      if (settings.nice && settings.nice.enabled) {
        return {
          enabled: settings.nice.enabled ?? false,
          niceValue: settings.nice.niceValue ?? DEFAULT_NICE_CONFIG.niceValue,
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read Nice priority settings:', err);
      }
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
        await new Promise(r => setTimeout(r, SESSION_LIMIT_WAIT_MS));
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
        await this.cleanupSession(session.id);
        run.sessionId = null;

        // Small pause between iterations
        await new Promise(r => setTimeout(r, ITERATION_PAUSE_MS));
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
        await new Promise(r => setTimeout(r, SESSION_LIMIT_WAIT_MS));
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

  /**
   * Get session state with respawn controller info included.
   * Use this for session:updated broadcasts to preserve respawn state on the frontend.
   */
  private getSessionStateWithRespawn(session: Session) {
    const controller = this.respawnControllers.get(session.id);
    return {
      ...session.toDetailedState(),
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
    return Array.from(this.sessions.values()).map(s => {
      const state = this.getSessionStateWithRespawn(s);
      return {
        ...state,
        // Exclude full buffers - they're fetched on-demand
        terminalBuffer: '',
        textOutput: '',
      };
    });
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
    return this.store.cleanupStaleSessions(activeSessionIds);
  }

  /**
   * Get lightweight state for SSE init - excludes full terminal buffers
   * to prevent browser freezes. Terminal buffers are fetched on-demand.
   */
  private getLightState() {
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

    return {
      version: APP_VERSION,
      sessions: this.getLightSessionsState(),
      scheduledRuns: Array.from(this.scheduledRuns.values()),
      respawnStatus,
      globalStats: this.store.getAggregateStats(activeSessionTokens),
      subagents: subagentWatcher.getRecentSubagents(15), // 15 min to avoid stale agents
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
  // Returns false if client is backpressured or dead
  private sendSSEPreformatted(reply: FastifyReply, message: string): void {
    // Skip backpressured clients to prevent unbounded memory growth
    if (this.backpressuredClients.has(reply)) return;

    try {
      const ok = reply.raw.write(message);
      if (!ok) {
        // Buffer is full — mark as backpressured, resume on drain
        this.backpressuredClients.add(reply);
        reply.raw.once('drain', () => {
          this.backpressuredClients.delete(reply);
        });
      }
    } catch {
      this.sseClients.delete(reply);
      this.backpressuredClients.delete(reply);
    }
  }

  private broadcast(event: string, data: unknown): void {
    // Performance optimization: serialize JSON once for all clients
    let message: string;
    try {
      message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
  // Uses adaptive batching: extends batch window when events are rapid-fire
  private batchTerminalData(sessionId: string, data: string): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    const existing = this.terminalBatches.get(sessionId) || '';
    const newBatch = existing + data;
    this.terminalBatches.set(sessionId, newBatch);

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
    this.adaptiveBatchIntervals.set(sessionId, sessionInterval);
    // Track minimum to avoid O(n) spread on every batch event
    if (sessionInterval < this._minBatchInterval) {
      this._minBatchInterval = sessionInterval;
    }

    // Flush immediately if batch is large for responsiveness
    if (newBatch.length > BATCH_FLUSH_THRESHOLD) {
      if (this.terminalBatchTimer) {
        clearTimeout(this.terminalBatchTimer);
        this.terminalBatchTimer = null;
      }
      this.flushTerminalBatches();
      return;
    }

    // Start batch timer if not already running (uses adaptive interval)
    // Pick the minimum interval across all pending sessions for responsiveness
    if (!this.terminalBatchTimer) {
      this.terminalBatchTimer = setTimeout(() => {
        this.flushTerminalBatches();
        this.terminalBatchTimer = null;
        // Clear per-session intervals after flush (they'll be recalculated on next event)
        this.adaptiveBatchIntervals.clear();
        this._minBatchInterval = TERMINAL_BATCH_INTERVAL;
      }, this._minBatchInterval);
    }
  }

  private flushTerminalBatches(): void {
    // Skip if server is stopping (timer may have been queued before stop() was called)
    if (this._isStopping) {
      this.terminalBatches.clear();
      return;
    }
    for (const [sessionId, data] of this.terminalBatches) {
      if (data.length > 0) {
        // Wrap with DEC mode 2026 synchronized output markers
        // Terminal buffers all output between markers and renders atomically,
        // eliminating partial-frame flicker from Ink's full-screen redraws.
        // Unsupported terminals ignore these sequences harmlessly.
        const syncData = DEC_SYNC_START + data + DEC_SYNC_END;
        this.broadcast('session:terminal', { id: sessionId, data: syncData });
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
    // Skip if server is stopping (timer may have been queued before stop() was called)
    if (this._isStopping) {
      this.outputBatches.clear();
      return;
    }
    for (const [sessionId, data] of this.outputBatches) {
      if (data.length > 0) {
        this.broadcast('session:output', { id: sessionId, data });
      }
    }
    this.outputBatches.clear();
  }

  // Batch task:updated events at 100ms - only send latest update per task
  // Key is sessionId:taskId to avoid collisions when multiple tasks update concurrently
  private batchTaskUpdate(sessionId: string, task: BackgroundTask): void {
    // Skip if server is stopping
    if (this._isStopping) return;

    // Use composite key to avoid losing updates when multiple tasks update in same batch window
    const key = `${sessionId}:${task.id}`;
    this.taskUpdateBatches.set(key, { sessionId, task });

    if (!this.taskUpdateBatchTimer) {
      this.taskUpdateBatchTimer = setTimeout(() => {
        this.flushTaskUpdateBatches();
        this.taskUpdateBatchTimer = null;
      }, TASK_UPDATE_BATCH_INTERVAL);
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

    if (!this.stateUpdateTimer) {
      this.stateUpdateTimer = setTimeout(() => {
        this.flushStateUpdates();
        this.stateUpdateTimer = null;
      }, STATE_UPDATE_DEBOUNCE_INTERVAL);
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
          // Send SSE comment as keep-alive (comments start with ':')
          client.raw.write(':keepalive\n\n');
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

    // Restore mux sessions BEFORE accepting connections
    // This prevents race conditions where clients connect before state is ready
    // CRITICAL: Skip in test mode to prevent tests from picking up user sessions
    if (!this.testMode) {
      await this.restoreScreenSessions();
    }

    // Clean up stale sessions from state file that don't have active screens
    this.cleanupStaleSessions();

    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    const protocol = this.https ? 'https' : 'http';
    console.log(`Claudeman web interface running at ${protocol}://localhost:${this.port}`);

    // Set API URL for child processes (MCP server, spawned sessions)
    process.env.CLAUDEMAN_API_URL = `${protocol}://localhost:${this.port}`;

    // Start scheduled runs cleanup timer
    this.scheduledCleanupTimer = setInterval(() => {
      this.cleanupScheduledRuns();
    }, SCHEDULED_CLEANUP_INTERVAL);

    // Start SSE client health check timer (prevents memory leaks from dead connections)
    this.sseHealthCheckTimer = setInterval(() => {
      this.cleanupDeadSSEClients();
    }, SSE_HEALTH_CHECK_INTERVAL);

    // Start token recording timer (every 5 minutes for long-running sessions)
    this.tokenRecordingTimer = setInterval(() => {
      this.recordPeriodicTokenUsage();
    }, 5 * 60 * 1000);

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

  }

  /**
   * Check if subagent tracking is enabled in settings (default: true)
   */
  private async isSubagentTrackingEnabled(): Promise<boolean> {
    const settingsPath = join(homedir(), '.claudeman', 'settings.json');
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
   * Check if image watcher is enabled in settings (default: true)
   */
  private async isImageWatcherEnabled(): Promise<boolean> {
    const settingsPath = join(homedir(), '.claudeman', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      // Default to true if not explicitly set
      return settings.imageWatcherEnabled ?? true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read image watcher setting:', err);
      }
    }
    return true; // Default enabled
  }

  private async restoreScreenSessions(): Promise<void> {
    try {
      // Reconcile screens to find which ones are still alive (also discovers unknown screens)
      const { alive, dead, discovered } = await this.mux.reconcileSessions();

      if (discovered.length > 0) {
        console.log(`[Server] Discovered ${discovered.length} unknown mux session(s)`);
      }

      if (alive.length > 0 || discovered.length > 0) {
        console.log(`[Server] Found ${alive.length + discovered.length} alive mux session(s) from previous run`);

        // For each alive screen, create a Session object if it doesn't exist
        const screens = this.mux.getSessions();
        for (const screen of screens) {
          if (!this.sessions.has(screen.sessionId)) {
            // Restore session settings from state.json (single source of truth)
            const savedState = this.store.getSession(screen.sessionId);

            // Determine the correct session name (priority: savedState > screen > muxName)
            // This ensures renamed sessions keep their name after server restart
            const sessionName = savedState?.name || screen.name || screen.muxName;

            // Create a session object for this mux session with the existing session
            const session = new Session({
              id: screen.sessionId,  // Preserve the original session ID
              workingDir: screen.workingDir,
              mode: screen.mode,
              name: sessionName,
              mux: this.mux,
              useMux: true,
              muxSession: screen  // Pass the existing session so startInteractive() can attach to it
            });

            // Update screen name if it was a "Restored:" placeholder or doesn't match saved name
            if (savedState?.name && screen.name !== savedState.name) {
              this.mux.updateSessionName(screen.sessionId, savedState.name);
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
                session.setAutoClear(
                  savedState.autoClearEnabled ?? false,
                  savedState.autoClearThreshold
                );
              }
              // Token tracking
              if (savedState.inputTokens !== undefined || savedState.outputTokens !== undefined || savedState.totalCost !== undefined) {
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
                  console.log(`[Server] Restored tokens for session ${session.id}: ${totalTokens} tokens, $${(savedState.totalCost ?? 0).toFixed(4)}`);
                }
              }
              // Ralph / Todo tracker
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
                console.log(`[Server] Restored Ralph tracker for session ${session.id} (phrase: ${savedState.ralphCompletionPhrase || 'none'})`);
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
              // Respawn controller
              if (savedState.respawnEnabled && savedState.respawnConfig) {
                try {
                  this.restoreRespawnController(session, savedState.respawnConfig, 'state.json');
                } catch (err) {
                  console.error(`[Server] Failed to restore respawn for session ${session.id}:`, err);
                }
              }
            }

            // Fallback: restore respawn from screens.json if state.json didn't have it
            if (!this.respawnControllers.has(session.id) && screen.respawnConfig?.enabled) {
              try {
                this.restoreRespawnController(session, screen.respawnConfig, 'screens.json');
              } catch (err) {
                console.error(`[Server] Failed to restore respawn from screens.json for session ${session.id}:`, err);
              }
            }

            // Fallback: restore Ralph state from state-inner.json if not already set and not explicitly disabled
            if (!session.ralphTracker.enabled && !session.ralphTracker.autoEnableDisabled) {
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
            await this.setupSessionListeners(session);
            this.persistSessionState(session);

            // Mark it as restored (not started yet - user needs to attach)
            console.log(`[Server] Restored session ${session.id} from mux ${screen.muxName}`);
          }
        }

        // Start stats collection to show screen info
        this.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      }

      if (dead.length > 0) {
        console.log(`[Server] Cleaned up ${dead.length} dead mux session(s)`);
      }
    } catch (err) {
      console.error('[Server] Failed to restore mux sessions:', err);
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

    // Clear token recording timer
    if (this.tokenRecordingTimer) {
      clearInterval(this.tokenRecordingTimer);
      this.tokenRecordingTimer = null;
    }
    this.lastRecordedTokens.clear();

    // Clear scheduled cleanup timer
    if (this.scheduledCleanupTimer) {
      clearInterval(this.scheduledCleanupTimer);
      this.scheduledCleanupTimer = null;
    }

    // Stop multiplexer and flush pending saves
    this.mux.destroy();

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
    await Promise.allSettled(
      Array.from(this.scheduledRuns.keys()).map(id => this.stopScheduledRun(id))
    );

    // Properly clean up all remaining sessions in parallel (removes listeners, clears state, etc.)
    // Don't kill screens on server stop - they can be reattached on restart
    // Use Promise.race with a 30s timeout to prevent shutdown from hanging indefinitely
    const sessionCleanup = Promise.allSettled(
      Array.from(this.sessions.keys()).map(id => this.cleanupSession(id, false))
    );
    const shutdownTimeout = new Promise<void>(resolve => setTimeout(resolve, 30_000));
    await Promise.race([sessionCleanup, shutdownTimeout]);

    // Flush state store to prevent data loss from debounced saves
    this.store.flushAll();

    // Clean up watcher listeners to prevent memory leaks
    this.cleanupSubagentWatcherListeners();
    this.cleanupImageWatcherListeners();

    // Stop subagent watcher
    subagentWatcher.stop();

    // Stop image watcher
    imageWatcher.stop();

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
    this.respawnTimers.clear();
    this.runSummaryTrackers.clear();
    this.transcriptWatchers.clear();
    this.sessionListenerRefs.clear();
    this.scheduledRuns.clear();
    // Dispose StaleExpirationMap (stops internal cleanup timer)
    this.lastTerminalEventTime.dispose();
    this.adaptiveBatchIntervals.clear();
    this._minBatchInterval = TERMINAL_BATCH_INTERVAL;
    this.activePlanOrchestrators.clear();
    this.cleaningUp.clear();

    await this.app.close();
  }
}

export async function startWebServer(port: number = 3000, https: boolean = false, testMode: boolean = false): Promise<WebServer> {
  const server = new WebServer(port, https, testMode);
  await server.start();
  return server;
}
