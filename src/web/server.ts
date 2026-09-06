/**
 * @fileoverview Codeman web server — central hub coordinating all subsystems.
 *
 * Fastify-based web server providing:
 * - ~111 REST API routes (delegated to `src/web/routes/` domain modules)
 * - SSE streaming at `/api/events` with backpressure handling
 * - Static file serving for the web UI (1-year cache in production)
 * - 60fps terminal streaming via batched PTY output (16-50ms adaptive)
 *
 * Coordinates: SessionManager, RespawnController, SubagentWatcher, TeamWatcher,
 * TranscriptWatcher, ImageWatcher, TunnelManager, PushSubscriptionStore,
 * PlanOrchestrator, RunSummaryTracker, FileStreamManager.
 *
 * Key exports:
 * - `WebServer` class — implements all port interfaces, extends EventEmitter
 * - `startWebServer(options)` — factory function to create and start the server
 *
 * Implements port interfaces: `SessionPort`, `EventPort`, `ConfigPort`,
 * `RespawnPort`, `MuxPort`, `FilePort`, `ScheduledPort`, `PushPort`, `TeamPort`
 * (see `src/web/ports/` for definitions)
 *
 * @dependencies All major subsystems (session, respawn-controller, subagent-watcher,
 *   team-watcher, tunnel-manager, state-store, etc.)
 * @consumedby src/index.ts (entry point), src/cli.ts
 * @emits SSE events via broadcast() — see sse-events.ts for full registry
 *
 * @module web/server
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import { startPasteImageGc } from './paste-image-gc.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { hostname as getHostname } from 'node:os';
import { dataPath, getDataDir, CODEMAN_INSTANCE } from '../config/instance.js';
import { GLYPH, palette } from '../cli-style.js';
import { getHookSecret } from '../config/hook-secret.js';
import { EventEmitter } from 'node:events';
import { Session, isExternalCliMode, type BackgroundTask } from '../session.js';
import type { ClaudeMode, SessionAttachmentHistoryItem, SessionState, WorkflowRunInfo } from '../types.js';
import { RespawnController, RespawnConfig } from '../respawn-controller.js';
import type { TerminalMultiplexer } from '../mux-interface.js';
import { createMultiplexer } from '../mux-factory.js';
import { getStore } from '../state-store.js';
import { TabLayoutService } from '../tab-layout-service.js';
import { ownerLayoutKey } from '../tab-layout-persistence.js';
import { readWebviews } from '../webview-store.js';
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
import { workflowRunWatcher, summarizeRun } from '../workflow-run-watcher.js';
import { attachmentRegistry, buildFileThumbnailRoute, registerExternalAttachment } from '../attachment-registry.js';
import { registerGeneratedArtifactAttachment } from '../generated-artifact-attachments.js';
import {
  buildDetectedAttachmentHistoryItem,
  buildExternalAttachmentHistoryItem,
} from '../session-attachment-history.js';
import { TranscriptWatcher } from '../transcript-watcher.js';
import { TeamWatcher } from '../team-watcher.js';
import { TunnelManager } from '../tunnel-manager.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'node:module';
import { RunSummaryTracker } from '../run-summary.js';
import { PlanOrchestrator } from '../plan-orchestrator.js';
import { OrchestratorLoop } from '../orchestrator-loop.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { applyWorkspaceHooks } from '../hooks-config.js';
import { PushSubscriptionStore } from '../push-store.js';
import webpush from 'web-push';
import { SseStreamManager } from './sse-stream-manager.js';
import { deriveTabLayoutSseHint } from './tab-layout-sse.js';
import {
  type SessionListenerRefs,
  createSessionListeners,
  attachSessionListeners,
  detachSessionListeners,
} from './session-listener-wiring.js';
import { sessionWaits } from './session-wait-registry.js';
import { intentStore } from '../intent-store.js';
import { AI_CHECK_MODEL } from '../config/ai-defaults.js';
import { approvalInbox } from './approval-inbox.js';
import { stopDeepSeekWeb } from '../deepseek-web-server.js';
import {
  wireRespawnListeners,
  setupTimedRespawn,
  restoreRespawnController,
  saveRespawnConfig,
  type RespawnWiringDeps,
} from './respawn-event-wiring.js';

import { reconcileUpdateOnBoot } from './self-update.js';

// Load version from package.json
const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json');

/**
 * `/api/v1/*` is the versioned public alias of the (unversioned) `/api/*` routes.
 * Rewriting at the server level lets external clients pin to a stable surface while
 * the bundled frontend keeps using `/api/*`. See docs/api-reference.md.
 */
function rewriteApiV1Url(url: string): string {
  if (url === '/api/v1') return '/api';
  if (url.startsWith('/api/v1/')) return '/api/' + url.slice('/api/v1/'.length);
  return url;
}
import {
  getErrorMessage,
  httpStatusForErrorCode,
  createErrorResponse,
  ApiErrorCode,
  type PersistedRespawnConfig,
  type NiceConfig,
  type ImageDetectedEvent,
  type AttachmentDetectedEvent,
  DEFAULT_NICE_CONFIG,
} from '../types.js';
import {
  CleanupManager,
  KeyedDebouncer,
  StaleExpirationMap,
  startEventLoopMonitor,
  isSafePushEndpoint,
} from '../utils/index.js';
import type { EventLoopMonitorHandle } from '../utils/index.js';
import { MAX_CONCURRENT_SESSIONS, MAX_SSE_CLIENTS } from '../config/map-limits.js';
import { MAX_PASTE_IMAGE_BYTES } from '../config/buffer-limits.js';
import { resolveTerminalHistoryConfig } from '../config/terminal-history.js';
import { SseEvent } from './sse-events.js';
import { getLatestPlanUsage, setLatestCodexPlanUsage } from './plan-usage-latest.js';
import { telemetrySignature } from '../usage-telemetry.js';
import { readCodexPlanUsage, resolveCodexBinaryPath } from '../utils/codex-cli-resolver.js';
import type { ScheduledRun } from './ports/index.js';
import { registerAuthMiddleware, registerSecurityHeaders, registerHostGuard } from './middleware/auth.js';
import { isMultiUserMode } from '../config/multiuser.js';
import { bootstrapInitialAdmin, hasUsers, resolveClaudeModeForUsername } from '../user-store.js';
import { installRouteErrorHandler } from './route-error-handler.js';
import { isExplicitlyEnabled, isLoopbackBindHost, buildHostPolicy, type HostPolicy } from './network-auth-policy.js';
import {
  registerPushRoutes,
  registerTeamRoutes,
  registerMuxRoutes,
  registerFileRoutes,
  registerScheduledRoutes,
  registerHookEventRoutes,
  registerApprovalRoutes,
  registerReadMyMindRoutes,
  registerStatusTelemetryRoutes,
  registerSystemRoutes,
  registerCaseRoutes,
  registerSessionRoutes,
  registerRespawnRoutes,
  registerRalphRoutes,
  registerPlanRoutes,
  registerClipboardRoutes,
  registerSearchRoutes,
  registerOrchestratorRoutes,
  registerCronRoutes,
  registerMeRoutes,
  registerAdminRoutes,
  registerWsRoutes,
  registerVoiceRoutes,
  registerWebviewRoutes,
  registerTabLayoutRoutes,
  tryWebviewRefererFallback,
} from './routes/index.js';
import { CronService } from '../cron/cron-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bounded, predictable shape for SSE client identifiers: alphanumerics, `_`, `-`.
// Length range covers crypto.randomUUID() (36 chars) plus any short stable IDs,
// while capping growth of `sseClientsById` and blocking pathological inputs.
const SSE_CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CODEX_USAGE_POLL_INTERVAL_MS = 5 * 60_000;

function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

import {
  SESSIONS_LIST_CACHE_TTL,
  SCHEDULED_CLEANUP_INTERVAL,
  SCHEDULED_RUN_MAX_AGE,
  SSE_HEARTBEAT_INTERVAL,
  SESSION_LIMIT_WAIT_MS,
  ITERATION_PAUSE_MS,
  STATS_COLLECTION_INTERVAL_MS,
  INACTIVITY_TIMEOUT_MS,
  CRON_TICK_INTERVAL,
} from '../config/server-timing.js';

/**
 * Get or generate a self-signed TLS certificate for HTTPS.
 * Certs are stored in ~/.codeman/certs/ and reused across restarts.
 */
function getOrCreateSelfSignedCert(): { key: string; cert: string } {
  const certsDir = dataPath('certs');
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
  /** Cron service (assigned in setupRoutes). */
  private cronService!: CronService;
  private sse: SseStreamManager;
  private store = getStore();
  private tabLayouts!: TabLayoutService;
  private port: number;
  private host: string;
  private https: boolean;
  private testMode: boolean;
  private mux: TerminalMultiplexer;
  // Centralized cleanup for standalone timers (intervals + resettable timeouts)
  private cleanup = new CleanupManager();
  // Cached light state for SSE init (avoids rebuilding on every reconnect)
  private cachedLightState: { data: Record<string, unknown>; timestamp: number } | null = null;
  private static readonly LIGHT_STATE_CACHE_TTL_MS = 1000;
  // Cached sessions list for getLightSessionsState() (avoids re-serializing all sessions on every call)
  private cachedSessionsList: { data: unknown[]; timestamp: number } | null = null;
  // Token recording for daily stats (track what's been recorded to avoid double-counting)
  private lastRecordedTokens: Map<string, { input: number; output: number }> = new Map();
  private codexUsageRefreshInFlight = false;
  private lastCodexUsageSignature: string | null = null;
  // Server startup time for respawn grace period calculation
  private readonly serverStartTime: number = Date.now();
  // Pending respawn start timers (for cleanup on shutdown)
  private pendingRespawnStarts: Map<string, NodeJS.Timeout> = new Map();
  // Active plan orchestrators (for cancellation via API)
  private activePlanOrchestrators: Map<string, PlanOrchestrator> = new Map();
  private persistDeb = new KeyedDebouncer(100);
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
    attachmentDetected: (event: AttachmentDetectedEvent) => void;
    error: (error: Error, sessionId?: string) => void;
  } | null = null;
  private workflowRunWatcherHandlers: {
    discovered: (info: WorkflowRunInfo) => void;
    updated: (info: WorkflowRunInfo) => void;
    removed: (data: { runId: string }) => void;
  } | null = null;
  private tunnelManager: TunnelManager = new TunnelManager();
  private authSessions: StaleExpirationMap<string, import('./ports/auth-port.js').AuthSessionRecord> | null = null;
  private authFailures: StaleExpirationMap<string, number> | null = null;
  private qrAuthFailures: StaleExpirationMap<string, number> | null = null;
  private hookSecretFailures: StaleExpirationMap<string, number> | null = null;
  private userFailures: StaleExpirationMap<string, number> | null = null;
  private pushStore: PushSubscriptionStore = new PushSubscriptionStore();
  private teamWatcher: TeamWatcher = new TeamWatcher();
  private _orchestratorLoop: import('../orchestrator-loop.js').OrchestratorLoop | null = null;
  private readonly titleHostname: string;
  private windowTitle: string;
  private readonly indexHtmlTemplate: string;
  private readonly allowUnauthenticatedNetwork: boolean;
  private _pasteImageGcStop: (() => void) | null = null;
  private _eventLoopMonitor: EventLoopMonitorHandle | null = null;
  /** Opt-in hooks-only listener on the docker bridge gateway (CODEMAN_DOCKER_BRIDGE_HOOKS). */
  private _dockerBridgeServer: import('node:http').Server | import('node:https').Server | null = null;
  private teamWatcherHandlers: {
    teamCreated: (config: unknown) => void;
    teamUpdated: (config: unknown) => void;
    teamRemoved: (config: unknown) => void;
    taskUpdated: (data: unknown) => void;
  } | null = null;
  constructor(
    port: number = 3000,
    https: boolean = false,
    testMode: boolean = false,
    host: string = '127.0.0.1',
    titleHostname?: string,
    allowUnauthenticatedNetwork: boolean = false
  ) {
    super();
    this.setMaxListeners(0);
    this.host = host;
    this.port = port;
    this.https = https;
    this.testMode = testMode;
    this.allowUnauthenticatedNetwork =
      allowUnauthenticatedNetwork || isExplicitlyEnabled(process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK);
    this.titleHostname = titleHostname || getHostname();
    this.windowTitle = `codeman:${this.titleHostname}`;
    this.indexHtmlTemplate = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');

    const rewriteUrl = (req: { url?: string }): string => rewriteApiV1Url(req.url || '');
    if (https) {
      const { key, cert } = getOrCreateSelfSignedCert();
      this.app = Fastify({ logger: false, https: { key, cert }, rewriteUrl });
    } else {
      this.app = Fastify({ logger: false, rewriteUrl });
    }
    this.mux = createMultiplexer();
    this.sse = new SseStreamManager(
      {
        getSessionStateWithRespawn: (sessionId) => {
          const session = this.sessions.get(sessionId);
          return session ? this.getSessionStateWithRespawn(session) : null;
        },
        resolveSessionOwner: (sessionId) => this.sessions.get(sessionId)?.owner,
      },
      this.cleanup
    );
    this.tabLayouts = new TabLayoutService({
      store: this.store,
      sessions: this.sessions,
      readWebviews: () => readWebviews(getDataDir()),
      broadcast: this.broadcast.bind(this),
      broadcastSessionOrder: (change) => {
        this.cachedLightState = null;
        this.sse.broadcastSessionOrder(change);
      },
    });
    if (this.testMode) this.tabLayouts.markRestorationSkipped();

    // Approvals Inbox → SSE. The singleton has no server reference; these
    // callbacks are its only way out. Broadcasts carry sessionId, so the
    // multi-user SSE scoping applies to them like any session event.
    approvalInbox.onPending = (item) => this.broadcast(SseEvent.ApprovalPending, { ...item });
    approvalInbox.onUpdated = (item) => this.broadcast(SseEvent.ApprovalUpdated, { ...item });
    approvalInbox.onResolved = (info) => this.broadcast(SseEvent.ApprovalResolved, { ...info });

    // Set up mux event listeners
    this.mux.on('sessionCreated', (session) => {
      this.broadcast(SseEvent.MuxCreated, session);
    });
    this.mux.on('sessionKilled', (data) => {
      this.broadcast(SseEvent.MuxKilled, data);
    });
    this.mux.on('sessionDied', (data) => {
      getLifecycleLog().log({
        event: 'mux_died',
        sessionId: (data as { sessionId?: string }).sessionId || 'unknown',
        extra: data as Record<string, unknown>,
      });
      this.broadcast(SseEvent.MuxDied, data);
    });
    this.mux.on('statsUpdated', (sessions) => {
      this.broadcast(SseEvent.MuxStatsUpdated, sessions);
    });

    // COD-108 — remote-session auto-reconnect. The TmuxManager watcher detects a
    // dead remote pane and emits `remoteSessionDropped`; the session owner (here)
    // reassembles the respawn options and reattaches via Session.reattachRemote()
    // (D1: the watcher does NOT reassemble options itself). On success we reset
    // the watcher's backoff; on failure the backoff schedules the next attempt.
    this.mux.on('remoteSessionDropped', (data) => {
      const { sessionId, attempt } = data as { sessionId: string; attempt: number };
      this.broadcast(SseEvent.RemoteSessionDropped, { sessionId, attempt });
      void this.handleRemoteSessionDropped(sessionId);
    });
    this.mux.on('remoteReconnectExhausted', (data) => {
      const { sessionId } = data as { sessionId: string };
      console.warn(`[Server] Remote auto-reconnect exhausted for session ${sessionId}`);
      this.broadcast(SseEvent.RemoteReconnectExhausted, { sessionId });
    });

    // Set up subagent watcher listeners
    this.setupSubagentWatcherListeners();
    this.setupWorkflowRunWatcherListeners();

    // Set up image watcher listeners
    this.setupImageWatcherListeners();

    // Set up team watcher listeners
    this.setupTeamWatcherListeners();

    // Set up tunnel manager listeners
    this.tunnelManager.on('started', (data: { url: string }) => {
      this.sse.setTunnelActive(true);
      this.broadcast(SseEvent.TunnelStarted, data);
    });
    this.tunnelManager.on('stopped', () => {
      this.sse.setTunnelActive(false);
      this.broadcast(SseEvent.TunnelStopped, {});
    });
    this.tunnelManager.on('error', (message: string) => {
      this.broadcast(SseEvent.TunnelError, { message });
    });
    this.tunnelManager.on('progress', (data: { message: string }) => {
      this.broadcast(SseEvent.TunnelProgress, data);
    });

    // QR token rotation — broadcast inline SVG for instant desktop refresh
    this.tunnelManager.on('qrTokenRotated', async () => {
      const url = this.tunnelManager.getUrl();
      if (url && process.env.CODEMAN_PASSWORD) {
        try {
          const svg = await this.tunnelManager.getQrSvg(url);
          this.broadcast(SseEvent.TunnelQrRotated, { svg });
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
          this.broadcast(SseEvent.TunnelQrRegenerated, { svg });
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
      discovered: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentDiscovered, info),
      updated: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentUpdated, info),
      toolCall: (data: SubagentToolCall) => this.broadcast(SseEvent.SubagentToolCall, data),
      toolResult: (data: SubagentToolResult) => this.broadcast(SseEvent.SubagentToolResult, data),
      progress: (data: SubagentProgress) => this.broadcast(SseEvent.SubagentProgress, data),
      message: (data: SubagentMessage) => this.broadcast(SseEvent.SubagentMessage, data),
      completed: (info: SubagentInfo) => this.broadcast(SseEvent.SubagentCompleted, info),
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
   * Bridge WorkflowRunWatcher events → SSE. Broadcasts run SUMMARIES (no agents[])
   * to keep payloads small; the full agents[] is fetched per-run via
   * GET /api/workflows/:runId when the user selects a run.
   */
  private setupWorkflowRunWatcherListeners(): void {
    this.workflowRunWatcherHandlers = {
      discovered: (info: WorkflowRunInfo) => this.broadcast(SseEvent.WorkflowRunDiscovered, summarizeRun(info)),
      updated: (info: WorkflowRunInfo) => this.broadcast(SseEvent.WorkflowRunUpdated, summarizeRun(info)),
      removed: (data: { runId: string }) => this.broadcast(SseEvent.WorkflowRunRemoved, data),
    };
    workflowRunWatcher.on('run_discovered', this.workflowRunWatcherHandlers.discovered);
    workflowRunWatcher.on('run_updated', this.workflowRunWatcherHandlers.updated);
    workflowRunWatcher.on('run_removed', this.workflowRunWatcherHandlers.removed);
  }

  private cleanupWorkflowRunWatcherListeners(): void {
    if (this.workflowRunWatcherHandlers) {
      workflowRunWatcher.off('run_discovered', this.workflowRunWatcherHandlers.discovered);
      workflowRunWatcher.off('run_updated', this.workflowRunWatcherHandlers.updated);
      workflowRunWatcher.off('run_removed', this.workflowRunWatcherHandlers.removed);
      this.workflowRunWatcherHandlers = null;
    }
  }

  /**
   * Set up event listeners for image watcher.
   * Broadcasts image detection events to SSE clients for auto-popup.
   */
  private setupImageWatcherListeners(): void {
    // Store handlers for cleanup on shutdown
    this.imageWatcherHandlers = {
      detected: (event: ImageDetectedEvent) => this.broadcast(SseEvent.ImageDetected, event),
      attachmentDetected: (event: AttachmentDetectedEvent) => {
        const attachmentEvent = {
          ...event,
          source: event.source || 'detected',
          thumbnailUrl:
            event.thumbnailUrl || buildFileThumbnailRoute(event.sessionId, event.relativePath || event.fileName),
        };
        const session = this.sessions.get(event.sessionId);
        if (session) {
          session.upsertAttachmentHistory(buildDetectedAttachmentHistoryItem(attachmentEvent));
          this.persistSessionState(session);
        }
        this.broadcast(SseEvent.AttachmentDetected, attachmentEvent);
      },
      error: (error: Error, sessionId?: string) => {
        console.error(`[ImageWatcher] Error${sessionId ? ` for ${sessionId}` : ''}:`, error.message);
      },
    };

    imageWatcher.on('image:detected', this.imageWatcherHandlers.detected);
    imageWatcher.on('attachment:detected', this.imageWatcherHandlers.attachmentDetected);
    imageWatcher.on('image:error', this.imageWatcherHandlers.error);
  }

  /**
   * Clean up image watcher listeners to prevent memory leaks.
   */
  private cleanupImageWatcherListeners(): void {
    if (this.imageWatcherHandlers) {
      imageWatcher.off('image:detected', this.imageWatcherHandlers.detected);
      imageWatcher.off('attachment:detected', this.imageWatcherHandlers.attachmentDetected);
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
      teamCreated: (config: unknown) => this.broadcast(SseEvent.TeamCreated, config),
      teamUpdated: (config: unknown) => this.broadcast(SseEvent.TeamUpdated, config),
      teamRemoved: (config: unknown) => this.broadcast(SseEvent.TeamRemoved, config),
      taskUpdated: (data: unknown) => this.broadcast(SseEvent.TeamTaskUpdated, data),
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

  /** Add a tentative session only after its owner layout accepts the creation. */
  private async registerSessionWithLayout(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
    try {
      await this.tabLayouts.sessionCreated(ownerLayoutKey(session.owner));
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
  }

  /**
   * Build a route context object satisfying all 5 port interfaces.
   * Single object with zero runtime cost — ISP enforced at the type level.
   */
  private createRouteContext() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      // SessionPort
      sessions: this.sessions as ReadonlyMap<string, Session>,
      addSession: this.registerSessionWithLayout.bind(this),
      tabLayouts: this.tabLayouts,
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
      getSseClientCount: () => this.sse.remoteClientCount,
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
      getTerminalHistoryConfig: this.getTerminalHistoryConfig.bind(this),
      getAgentSkillEnabled: this.getAgentSkillEnabled.bind(this),
      getWorkspaceHooksEnabled: this.getWorkspaceHooksEnabled.bind(this),
      getClaudeVoiceEnabled: this.getClaudeVoiceEnabled.bind(this),
      getDefaultClaudeMdPath: this.getDefaultClaudeMdPath.bind(this),
      getLightState: this.getLightState.bind(this),
      getLightSessionsState: this.getLightSessionsState.bind(this),
      startTranscriptWatcher: this.startTranscriptWatcher.bind(this),
      stopTranscriptWatcher: this.stopTranscriptWatcher.bind(this),
      getTranscriptPath: (sessionId: string) => this.transcriptWatchers.get(sessionId)?.getPath() ?? null,
      getReadMyMindModel: this.getReadMyMindModel.bind(this),
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
      // OrchestratorPort — use getter so routes always see current value (not a null snapshot)
      get orchestratorLoop() {
        return self._orchestratorLoop;
      },
      initOrchestratorLoop: () => this.initOrchestratorLoop(),
    };
  }

  /**
   * Current Host/Origin allowlist policy. Read per request so a tunnel started at
   * runtime (PUT /api/settings) is reflected without a restart.
   */
  private getHostPolicy(): HostPolicy {
    return buildHostPolicy(this.host, this.tunnelManager.getUrl());
  }

  private async setupRoutes(): Promise<void> {
    // multipart/form-data: parser is provided by @fastify/multipart (registered
    // below). Its parser is a no-op marker that leaves the body on req.raw, so
    // legacy routes that read the raw stream directly (e.g. /api/screenshots)
    // continue to work alongside routes that use req.file() (e.g. paste-image).

    // Enable gzip/brotli compression for all responses.
    // Massive win: 793KB uncompressed → ~120KB compressed for static assets.
    // Threshold 1024 = don't compress tiny responses (headers > savings).
    await this.app.register(fastifyCompress, {
      threshold: 1024,
    });

    // Cookie plugin (needed for auth session tokens)
    await this.app.register(fastifyCookie);

    // Uniform response envelope (stable HTTP contract — docs/api-reference.md):
    // wrap bare JSON payloads as { success:true, data } and map { success:false }
    // error envelopes to a conventional HTTP status (instead of 200). Skips
    // non-JSON responses (buffers/streams) and non-/api routes.
    this.app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
      if (!req.url.startsWith('/api')) return done(null, payload);
      if (payload === null || typeof payload !== 'object') return done(null, payload);
      if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
        return done(null, payload);
      }
      const p = payload as { success?: unknown; errorCode?: unknown };
      if (p.success === false) {
        if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
          reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
        }
        return done(null, payload);
      }
      if (p.success === true) return done(null, payload);
      return done(null, { success: true, data: payload });
    });

    // Anti-DNS-rebinding Host allowlist + cross-site (CSRF) Origin guard. Registered
    // before auth so forged cross-site / rebound requests are rejected up front, even
    // on the default no-password install. See docs/reports/security-review-2026-06-09.md.
    registerHostGuard(this.app, () => this.getHostPolicy());

    // Auth middleware (Basic Auth + session cookies + rate limiting)
    const authState = registerAuthMiddleware(this.app, this.https);
    if (authState) {
      this.authSessions = authState.authSessions;
      this.authFailures = authState.authFailures;
      this.qrAuthFailures = authState.qrAuthFailures;
      this.hookSecretFailures = authState.hookSecretFailures;
      this.userFailures = authState.userFailures;
    }

    // WebSocket support (terminal I/O — low-latency bidirectional channel)
    await this.app.register(fastifyWebsocket);

    // Multipart parsing (used by paste-image). Replaces a hand-rolled
    // boundary scanner that had several edge-case bugs: literal boundary
    // anywhere in body was a match, LF-only clients silently corrupted the
    // last byte (hard-coded \r\n offsets), and there was no part-count cap.
    await this.app.register(fastifyMultipart, {
      limits: {
        fileSize: MAX_PASTE_IMAGE_BYTES, // per file (default 50MB) — large phone photos / screenshots
        files: 1, // paste-image sends one file per request (clients batch up to 20 requests)
        fields: 4, // small headroom for accompanying form fields
      },
    });

    // Security headers + CORS
    registerSecurityHeaders(this.app, this.https);
    this.app.get('/', async (_req, reply) => {
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(await this.renderIndexHtml());
    });
    this.app.get('/index.html', async (_req, reply) => {
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(await this.renderIndexHtml());
    });
    // Detached single-session window (undock). Serves the same SPA shell but
    // flags the client into "solo mode" for one session. Auth applies normally
    // (the popup carries the dashboard's cookie on navigation). We serve 200
    // even for an unknown id — the client renders a friendly "session
    // unavailable" state, which also covers a session that ends while its
    // detached window is still open. Registered before the static plugin so the
    // explicit route wins over the '/' static prefix.
    this.app.get('/session/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(await this.renderIndexHtml(id));
    });
    // Service worker must never be cached — browsers check for SW updates on navigation
    this.app.get('/sw.js', async (_req, reply) => {
      return reply
        .header('Cache-Control', 'no-cache, no-store')
        .header('Service-Worker-Allowed', '/')
        .type('application/javascript')
        .sendFile('sw.js', join(__dirname, 'public'));
    });

    // Serve static files — content-hashed assets (e.g. app.a3f8c2e1.js) are immutable, cache aggressively.
    // HTML must revalidate every time so browsers pick up new hashed filenames after deploys.
    // cacheControl disabled so setHeaders owns Cache-Control for plain static assets.
    // preCompressed: serve pre-built .br/.gz files (from build step) to avoid per-request CPU compression
    await this.app.register(fastifyStatic, {
      root: join(__dirname, 'public'),
      prefix: '/',
      cacheControl: false,
      preCompressed: true,
      // ⚠️ @fastify/static v10 changed this callback's first argument from a Node
      // `ServerResponse` to a `FastifyReply`, so it is `reply.header()` here and
      // NOT `res.setHeader()`. A v9-style body throws TypeError on every static
      // request, which is every page load. See the v10.0.0 release notes.
      setHeaders: (reply, path) => {
        // ⚠️ That same change ALSO flipped precedence, and silently. Under v9 this
        // callback wrote to the raw response and Fastify's staged reply headers then
        // overwrote it, so a route that set its own Cache-Control before .sendFile()
        // won. Under v10 the callback writes to the reply itself and now wins instead,
        // which handed `/sw.js` a year of `immutable` in place of the `no-cache,
        // no-store` its route asks for — a service worker that can never update.
        // So: a route that already decided keeps its answer.
        if (reply.getHeader('Cache-Control') !== undefined) return;
        // Use .includes() not .endsWith() — preCompressed serves .html.br/.html.gz
        if (path.includes('.html')) {
          reply.header('Cache-Control', 'no-cache');
        } else {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    // SSE endpoint for real-time updates
    this.app.get('/api/events', (req, reply) => {
      // Enforce SSE client limit to prevent memory exhaustion from too many connections
      if (this.sse.clientCount >= MAX_SSE_CLIENTS) {
        reply.code(503).send('Too many SSE connections');
        return;
      }

      // Parse optional session subscription filter from query parameter.
      // /api/events?sessions=id1,id2 — client only receives session:terminal
      //   events for those sessions (other events broadcast to all clients).
      // /api/events?clientId=<uuid> — enables live filter updates via
      //   POST /api/events/subscribe without reconnecting.
      const query = req.query as { sessions?: string; clientId?: string };
      let sessionFilter: Set<string> | null = null;
      if (query.sessions) {
        const ids = query.sessions
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length > 0) {
          sessionFilter = new Set(ids);
        }
      }
      const clientId =
        typeof query.clientId === 'string' && SSE_CLIENT_ID_RE.test(query.clientId) ? query.clientId : undefined;

      // Carry over the headers the security hook already set on this reply.
      //
      // writeHead goes straight to the Node response and bypasses Fastify's header
      // store, so everything the onRequest hook granted is silently dropped —
      // including the Access-Control-Allow-Origin it emits for localhost origins.
      // The result is an internal contradiction: a localhost page may call every
      // /api endpoint cross-origin, but its EventSource fails CORS. The security
      // headers (nosniff, frame-options, CSP) were lost the same way.
      //
      // The other raw-writeHead routes live in file-routes.ts and share a helper;
      // this one keeps its own copy so the server does not import from a route
      // module it registers.
      const inherited: Record<string, number | string | string[]> = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) inherited[name] = value;
      }
      reply.raw.writeHead(200, {
        ...inherited,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });

      // Track tunnel clients — cloudflared proxies locally so req.ip is always
      // 127.0.0.1; detect tunnel traffic via Cf-Connecting-Ip header instead.
      const isRemote = !!req.headers['cf-connecting-ip'];
      this.sse.addClient(reply, sessionFilter, isRemote, clientId, req.authUser);

      // Send initial state
      // Use light state for SSE init to avoid sending 2MB+ terminal buffers
      // Buffers are fetched on-demand when switching tabs
      this.sse.sendSSE(reply, SseEvent.Init, this.getLightState(req.authUser));
      // Flush Cloudflare tunnel buffer with padding — ensures the init event
      // (and any immediately following events) are delivered without proxy delay.
      this.sse.sendPadding(reply);

      req.raw.on('close', () => {
        this.sse.removeClient(reply);
      });
    });

    // Live subscription update — change a connected client's session filter
    // without forcing an SSE reconnect. Body: { clientId, sessions: string[] | null }
    // Empty/null sessions array = remove filter (receive all session:terminal events).
    this.app.post('/api/events/subscribe', (req, reply) => {
      const body = (req.body || {}) as { clientId?: string; sessions?: string[] | null };
      if (typeof body.clientId !== 'string' || !SSE_CLIENT_ID_RE.test(body.clientId)) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'clientId required'));
        return;
      }
      const sessions = Array.isArray(body.sessions)
        ? body.sessions.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 128).slice(0, 64)
        : null;
      const updated = this.sse.updateClientFilter(body.clientId, sessions);
      reply.code(updated ? 204 : 404).send();
    });

    // Global error handler for structured errors thrown by findSessionOrFail /
    // parseBody. Shared with the route test harness so test behavior matches prod.
    installRouteErrorHandler(this.app);

    // Stable-contract 404 for unknown /api routes — without this, Fastify's
    // default not-found payload {message,error,statusCode} would be wrapped by
    // the envelope hook into a contradictory HTTP 404 {success:true,...}.
    this.app.setNotFoundHandler(async (req, reply) => {
      const notFound = `Route ${req.method}:${req.url} not found`;
      // A web-tab dashboard asking for a root-absolute asset (`fetch('/api/data')`,
      // `import('/chunk.js')`, `url(/img.png)` inside a stylesheet) lands here,
      // because `<base href>` cannot rewrite a URL built at runtime. Its Referer says
      // which dashboard to relay to. Deliberately placed on the 404 path so every
      // real Codeman route still wins.
      //
      // Tried BEFORE the API-shaped 404, because a dashboard's own assets commonly
      // live under its `/api/...` namespace and were the one class this could never
      // rescue. Reaching this handler at all already proves no Codeman route matched,
      // and the relay declines unless the Referer carries a live capability, so
      // genuinely unknown `/api` paths still get the envelope below.
      if (await tryWebviewRefererFallback(req, reply)) return reply;
      if (req.url.startsWith('/api')) {
        return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, notFound));
      }
      return reply.code(404).send({ message: notFound, error: 'Not Found', statusCode: 404 });
    });

    // Crash diagnostics beacon — frontend POSTs breadcrumbs, GET to read them.
    // text/plain is used ONLY by this beacon (navigator.sendBeacon sends text/plain).
    // Keep the body as a RAW STRING and parse it inside the handler — a global
    // text/plain -> JSON parser would let a cross-site "simple request" (no CORS
    // preflight) submit JSON to any route. See security review C2.
    // Keyed by the client's per-page-load id so (a) a page reload (fresh id)
    // ARCHIVES the previous page's breadcrumbs instead of overwriting them —
    // iOS PWA reloads used to wipe the trace of the very bug being chased —
    // and (b) concurrent clients (desktop + phone) don't clobber each other.
    // Same id replaces in place (each beacon carries the full ring buffer).
    const MAX_CRASH_PAGES = 10;
    const _crashPages = new Map<string, { at: number; data: string }>();
    this.app.addContentTypeParser('text/plain;charset=UTF-8', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });
    this.app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });
    this.app.post('/api/crash-diag', (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      let data = raw;
      let pageId = 'legacy';
      try {
        const parsed = JSON.parse(raw) as { data?: unknown; id?: unknown };
        if (parsed && typeof parsed.data === 'string') data = parsed.data;
        if (parsed && typeof parsed.id === 'string' && parsed.id) pageId = parsed.id.slice(0, 64);
      } catch {
        /* not JSON — treat the raw beacon text as the breadcrumbs */
      }
      _crashPages.delete(pageId); // re-insert = move to MRU end
      _crashPages.set(pageId, { at: Date.now(), data: String(data || '') });
      if (_crashPages.size > MAX_CRASH_PAGES) {
        const oldest = _crashPages.keys().next().value;
        if (oldest !== undefined) _crashPages.delete(oldest);
      }
      reply.code(204).send();
    });
    this.app.get('/api/crash-diag', (_req, reply) => {
      const pages = [..._crashPages.entries()].map(([id, p]) => ({ id, at: p.at, data: p.data }));
      const breadcrumbs = pages
        .map((p) => `═══ page ${p.id} (last beacon ${new Date(p.at).toISOString()}) ═══\n${p.data}`)
        .join('\n\n');
      reply.code(200).send({ breadcrumbs, pages, timestamp: Date.now() });
    });

    // Register all route modules
    const ctx = this.createRouteContext();
    registerPushRoutes(this.app, ctx);
    registerTeamRoutes(this.app, ctx);
    registerMuxRoutes(this.app, ctx);
    registerFileRoutes(this.app, ctx);
    registerScheduledRoutes(this.app, ctx);
    registerHookEventRoutes(this.app, ctx);
    registerApprovalRoutes(this.app, ctx);
    registerReadMyMindRoutes(this.app, ctx);
    registerStatusTelemetryRoutes(this.app, ctx);
    registerSystemRoutes(this.app, ctx);
    registerCaseRoutes(this.app, ctx);
    registerSessionRoutes(this.app, ctx);
    registerRespawnRoutes(this.app, ctx);
    registerRalphRoutes(this.app, ctx);
    registerPlanRoutes(this.app, ctx);
    registerClipboardRoutes(this.app, ctx);
    registerSearchRoutes(this.app, ctx);
    registerMeRoutes(this.app, ctx);
    registerAdminRoutes(this.app, ctx);
    registerOrchestratorRoutes(this.app, ctx);
    registerWebviewRoutes(this.app, ctx);
    registerTabLayoutRoutes(this.app, ctx);

    // Cron: build the service from the same context, recompute
    // due times for any persisted jobs, then expose it to its routes.
    this.cronService = new CronService(ctx);
    this.cronService.init();
    registerCronRoutes(this.app, { ...ctx, cron: this.cronService });

    registerWsRoutes(this.app, ctx, () => this.getHostPolicy());
    registerVoiceRoutes(this.app, ctx, () => this.getHostPolicy());
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
        this.broadcast(SseEvent.TranscriptComplete, { sessionId, timestamp: Date.now() });
      });

      watcher.on('transcript:plan_mode', () => {
        const controller = this.respawnControllers.get(sessionId);
        if (controller) {
          controller.signalTranscriptPlanMode();
        }
        this.broadcast(SseEvent.TranscriptPlanMode, { sessionId, timestamp: Date.now() });
      });

      watcher.on('transcript:tool_start', (toolName: string) => {
        this.broadcast(SseEvent.TranscriptToolStart, { sessionId, toolName, timestamp: Date.now() });
      });

      watcher.on('transcript:tool_end', (toolName: string, isError: boolean) => {
        this.broadcast(SseEvent.TranscriptToolEnd, {
          sessionId,
          toolName,
          isError,
          timestamp: Date.now(),
        });
      });

      watcher.on('transcript:error', (error: Error) => {
        console.error(`[Transcript] Error for session ${sessionId}:`, error.message);
      });

      watcher.on('transcript:user_prompt', (text: string) => {
        void this.captureIntentPrompt(sessionId, text);
      });

      this.transcriptWatchers.set(sessionId, watcher);
    }

    // Start or update the watcher with the transcript path
    watcher.updatePath(transcriptPath);
  }

  /**
   * Read My Mind intent capture: fold one transcript user prompt into the
   * case's intent profile (docs/readmymind-plan.md). Opt-in via
   * `readMyMindEnabled` (default OFF) and claude-only; the mode gate is
   * belt-and-braces since only hook-fed sessions have a transcript watcher.
   */
  private async captureIntentPrompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    // `mode === 'claude'` directly: the intent profile is fed from Claude's own
    // transcript, so this is a claude question, not a hooks-available one (which
    // `deepseek` now answers yes to).
    if (!session || session.mode !== 'claude') return;
    try {
      const settings = await this.readSettings();
      if (settings.readMyMindEnabled !== true) return;
      intentStore.recordPrompt(session.owner, session.workingDir, sessionId, text);
    } catch (err) {
      console.warn(`[IntentStore] Capture failed for session ${sessionId}:`, err);
    }
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
    // See session-manager.updateSessionState: __envOverrides is an internal disk-only
    // field kept off SessionState to avoid leaking via API broadcasts.
    const base = session.toState();
    const envOverrides = session.getEnvOverridesForPersist();
    // __attachmentHistory keeps the private (externalPath-bearing) history on disk,
    // separate from the sanitized public attachmentHistory in toState().
    const attachmentHistory = session.getAttachmentHistoryForPersist();
    const state = {
      ...base,
      ...(envOverrides ? { __envOverrides: envOverrides } : {}),
      ...(attachmentHistory ? { __attachmentHistory: attachmentHistory } : {}),
    } as SessionState;
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

  private saveRespawnConfig(sessionId: string, config: RespawnConfig, durationMinutes?: number): void {
    saveRespawnConfig(sessionId, config, this.mux, durationMinutes);
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

  private async _doCleanupSession(
    sessionId: string,
    killMux: boolean,
    reason?: string,
    coordinateLayout = true
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    const pinned = session?.pinned === true || this.store.getSession(sessionId)?.pinned === true;
    if (coordinateLayout && session && killMux && !pinned) {
      return this.tabLayouts.runSessionDeletion([{ id: sessionId, owner: session.owner }], () =>
        this._doCleanupSession(sessionId, killMux, reason, false)
      );
    }
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
      this.broadcast(SseEvent.RespawnStopped, { sessionId, reason: 'session_cleanup' });
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
    this.sse.cleanupSessionBatches(sessionId);

    // Reset Ralph tracker on the session before cleanup
    if (session) {
      session.ralphTracker.fullReset();
    }

    // Clear Ralph state from store
    this.store.removeRalphState(sessionId);

    // Broadcast Ralph cleared to update UI
    this.broadcast(SseEvent.SessionRalphLoopUpdate, {
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
    this.broadcast(SseEvent.SessionRalphTodoUpdate, {
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
        detachSessionListeners(session, listeners);
        this.sessionListenerRefs.delete(sessionId);
      }

      session.removeAllListeners();
      // Close any active file streams for this session
      fileStreamManager.closeSessionStreams(sessionId);
      // Drop live external attachment registrations for this session
      attachmentRegistry.clearSession(sessionId);
      // Stop watching for images in this session's directory
      imageWatcher.unwatchSession(sessionId);
      // Clean up pasted images directory for this session
      if (killMux && session.workingDir) {
        const pasteImageDir = join(session.workingDir, '.claude-images');
        try {
          rmSync(pasteImageDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup
        }
      }
      await session.stop(killMux);
      this.sessions.delete(sessionId);
      // Only remove from state.json if we're also killing the mux session.
      // When killMux=false (server shutdown), preserve state for recovery.
      if (killMux) {
        this.store.demoteOrRemoveSession(sessionId);
      }
    }

    // Release anything blocked on this session, in the documented order: 'exit'
    // first so an until=exit caller gets its signal, then cancelAll so everyone
    // else resolves with ended:true instead of timing out.
    //
    // The 'exit' here is NOT redundant with the PTY-exit listener: listeners are
    // detached a few lines above, before `session.stop()`, so on a delete the
    // session's own exit event never reaches the registry.
    sessionWaits.notifySignal(sessionId, 'exit');
    sessionWaits.cancelAll(sessionId);
    approvalInbox.resolveForSession(sessionId, 'session_ended');

    this.broadcast(SseEvent.SessionDeleted, { id: sessionId });
  }

  private async renderIndexHtml(soloSessionId?: string): Promise<string> {
    // Detached-session windows intentionally skip App Settings during server
    // rendering (their client bootstrap loads the synced name moments later).
    const persistedSettings: Record<string, unknown> = soloSessionId ? {} : await this.readSettings(true);
    const configuredDisplayName =
      typeof persistedSettings.displayName === 'string' ? persistedSettings.displayName.trim() : '';
    const displayName = configuredDisplayName || 'Codeman';
    // Solo renders read no settings; recomputing here would reset the shared
    // push-notification prefix (hostTitle) to the default name.
    if (!soloSessionId) {
      this.windowTitle = `${displayName === 'Codeman' ? 'codeman' : displayName}:${this.titleHostname}`;
    }
    let html = this.indexHtmlTemplate.replace(
      '<title>Codeman</title>',
      `<title>${escapeHtmlText(this.windowTitle)}</title>`
    );
    // Cache-bust same-origin module scripts + stylesheets so a normal reload
    // always serves the latest (static assets carry a 1-year immutable cache).
    html = this.cacheBustAssets(html);
    // Per-user App-Settings flags, read server-side so the page renders in the
    // right initial state on every normal reload (the client apply* functions
    // only run on save). Read FRESH (bypass the 2s cache): a setting toggled
    // moments ago triggers a reload here, and the cached value would render the
    // pre-toggle state (e.g. the gesture bundle wouldn't inject until a 2nd
    // reload). Skipped for solo popups (their header differs).
    const settings: Record<string, unknown> = soloSessionId ? {} : persistedSettings;
    // Multi-monitor header button: carries the `btn-multimonitor--hidden` class
    // in the template by default (App Settings → Display → "Header Displays");
    // reveal by stripping that class when the user enabled it. Matching a unique
    // class token (not user-facing copy) keeps this robust against template edits.
    if (settings.showMultiMonitorButton === true) {
      html = html.replace(' btn-multimonitor--hidden', '');
    }
    // Plan-usage chip: ships hidden (`header-plan-usage--hidden`) and is revealed
    // PER-DEVICE by the client (settings-ui.js applyHeaderVisibilitySettings). It
    // used to be server-revealed from a synced setting, but that leaked the desktop
    // choice onto mobile — display is now per-device only (like the response viewer).
    // Telemetry collection stays server-side via the statusLineTelemetry action.
    // Detached single-session ("solo") window: inject the target session id so
    // the client can enter solo mode even if a (network-first) service worker
    // later serves a cached shell. The client primarily detects solo mode from
    // the /session/:id URL path; this global is a belt-and-suspenders fallback.
    // The id is gated to JSON + <-escaped so it can't break out of the inline
    // <script> (ids are UUIDs in practice, but defense-in-depth is cheap).
    if (soloSessionId) {
      const safeId = JSON.stringify(soloSessionId).replace(/</g, '\\u003c');
      html = html.replace('</head>', `<script>window.__CODEMAN_SOLO__=${safeId};</script>\n</head>`);
    }
    // Gesture-control overlay (Phase 5): dashboard only (not solo popups, which
    // have no tab strip). `CODEMAN_GESTURE=1` makes the feature *available* on
    // this instance (it also widens CSP + serves the assets); the per-user
    // `gestureControlEnabled` setting (App Settings → Input, default OFF) is the
    // actual on/off. We expose `__codemanGestureAvailable` so the settings UI can
    // show the toggle only when the feature is available, and inject the bundle
    // (served same-origin from /gesture/, so 'self' covers it) only when enabled.
    // Tool availability (#200/#201): the welcome-screen run buttons, the run-mode
    // dropdown entries and the App Settings "Codex CLI" tab are all offers that a
    // box without the binary cannot keep — picking one spawns a session that
    // errors out immediately. One object answers all three.
    //
    // INJECTED, not fetched per surface. The `/api/<cli>/status` routes exist and
    // stay (they mirror each other and are a fine API surface), but as the source
    // for UI gating they buy nothing: every resolver memoizes its PATH probe on
    // the server, so a fetch is exactly as stale as an injected value, while
    // costing a round trip each time the dropdown opens and leaving the welcome
    // buttons to flicker in after paint. Installing a CLI later needs a server
    // restart either way. Memoized probes also make this cheap per render.
    //
    // Solo popups skip it: no settings modal, no welcome screen, no run menu.
    if (!soloSessionId) {
      const [
        { isClaudeAvailable },
        { isOpenCodeAvailable },
        { isCodexAvailable },
        { isGeminiAvailable },
        { isAntigravityAvailable },
        { isPiAvailable },
        { isGrokAvailable },
        { isDeepSeekRunnable, isDeepSeekAvailable },
        { isOmpAvailable },
        { isCloudflaredAvailable },
        { isGitAvailable },
      ] = await Promise.all([
        import('../utils/claude-cli-resolver.js'),
        import('../utils/opencode-cli-resolver.js'),
        import('../utils/codex-cli-resolver.js'),
        import('../utils/gemini-cli-resolver.js'),
        import('../utils/antigravity-cli-resolver.js'),
        import('../utils/pi-cli-resolver.js'),
        import('../utils/grok-cli-resolver.js'),
        import('../utils/deepseek-cli-resolver.js'),
        import('../utils/omp-cli-resolver.js'),
        import('../utils/cloudflared-resolver.js'),
        import('../git-clone.js'),
      ]);
      const available = {
        claude: isClaudeAvailable(),
        opencode: isOpenCodeAvailable(),
        codex: isCodexAvailable(),
        gemini: isGeminiAvailable(),
        antigravity: isAntigravityAvailable(),
        pi: isPiAvailable(),
        grok: isGrokAvailable(),
        // RUNNABLE, not merely installed: `dsh` is a profile launcher, and a dsh
        // with no pane-capable profile would offer a Run button that spawns a
        // pane which dies on arrival. The Add-Profile affordance in the run menu
        // keys off `deepseekBinary` instead, so a user who has the binary but no
        // profile is offered the fix rather than a greyed-out entry.
        deepseek: isDeepSeekRunnable(),
        deepseekBinary: isDeepSeekAvailable(),
        omp: isOmpAvailable(),
        cloudflared: isCloudflaredAvailable(),
        // Not a run mode: the Add Case → Clone tab is an offer this box cannot
        // keep without git (issue #236), same reasoning as cloudflared above.
        git: isGitAvailable(),
      };
      html = html.replace(
        '</head>',
        `<script>window.__codemanCliAvailable=${JSON.stringify(available)};</script>\n</head>`
      );
    }
    if (!soloSessionId && process.env.CODEMAN_GESTURE === '1') {
      html = html.replace('</head>', `<script>window.__codemanGestureAvailable=true;</script>\n</head>`);
      if (settings.gestureControlEnabled === true) {
        const v = this.gestureBundleVersion();
        html = html.replace(
          '</head>',
          `<script type="module" src="/gesture/gesture-codeman.js${v}"></script>\n</head>`
        );
      }
    }
    return html;
  }

  /** mtime memo for asset cache-busting (keyed by absolute path). A full index
   *  render does one stat per script/link tag (~25-30); without this each `/`,
   *  `/index.html` and `/session/:id` hit would re-stat them all. A 1s TTL keeps
   *  a burst of renders cheap while still picking up an edited/redeployed file
   *  within a second (no server restart needed). */
  private _assetVersionMemo = new Map<string, { v: number; ts: number }>();
  private assetVersion(absPath: string): number | null {
    const now = Date.now();
    const hit = this._assetVersionMemo.get(absPath);
    if (hit && now - hit.ts < 1000) return hit.v;
    try {
      const v = Math.floor(statSync(absPath).mtimeMs);
      this._assetVersionMemo.set(absPath, { v, ts: now });
      return v;
    } catch {
      return null;
    }
  }

  /** Cache-busting query for the gesture bundle: its mtime (memoized, see
   *  assetVersion). The bundle is served from /gesture/ with a 1-year cache, so
   *  without a version that changes on redeploy the browser would keep running a
   *  stale bundle forever. Empty string if the file is missing. */
  private gestureBundleVersion(): string {
    const v = this.assetVersion(join(__dirname, 'public', 'gesture', 'gesture-codeman.js'));
    return v === null ? '' : `?v=${v}`;
  }

  /** Append ?v=<mtime> to every same-origin .js/.css reference in the page so a
   *  normal reload always serves the latest. Codeman's static assets are sent
   *  with `Cache-Control: max-age=1y, immutable` and the script/link tags carry
   *  no version, so without this an edited module (panels-ui.js, styles.css, …)
   *  stays cached until a manual hard refresh. mtime is memoized (1s TTL) so a
   *  changed file is picked up with no server restart. External URLs (have a
   *  `:` scheme), already-versioned refs (have a `?`), and refs with no matching
   *  file on disk are left untouched. */
  private cacheBustAssets(html: string): string {
    const publicDir = join(__dirname, 'public');
    return html.replace(/(\s(?:src|href)=")([^"?:]+\.(?:js|css))(")/g, (full, pre, ref, post) => {
      const v = this.assetVersion(join(publicDir, ref));
      return v === null ? full : `${pre}${ref}?v=${v}${post}`;
    });
  }

  private async setupSessionListeners(session: Session): Promise<void> {
    // Idempotent: the wiring exit handler detaches ALL listeners on every PTY exit
    // (removeSessionListenerRefs), so the re-attach routes (/interactive,
    // /interactive-respawn, /shell) call this again to restore observability
    // (terminal SSE, error/exit broadcasts, the COD-118 respawnBreakerTripped
    // handler). Skip when the refs are still attached to avoid double-wiring.
    if (this.sessionListenerRefs.has(session.id)) return;

    // Create run summary tracker for this session
    const summaryTracker = new RunSummaryTracker(session.id, session.name);
    this.runSummaryTrackers.set(session.id, summaryTracker);
    summaryTracker.recordSessionStarted(session.mode, session.workingDir);

    // Set working directory for Ralph tracker to auto-load @fix_plan.md (not supported for external CLIs)
    if (!isExternalCliMode(session.mode)) {
      session.ralphTracker.setWorkingDir(session.workingDir);
    }

    // Start watching for new images in this session's working directory (if enabled globally and per-session)
    if ((await this.isImageWatcherEnabled()) && session.imageWatcherEnabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    }

    // Create and attach all listener handlers via dependency injection
    const listeners = createSessionListeners(session, this.buildSessionListenerDeps());
    this.sessionListenerRefs.set(session.id, listeners);
    attachSessionListeners(session, listeners);
  }

  /** Build the deps object for session listener wiring. */
  private buildSessionListenerDeps() {
    return {
      broadcast: this.broadcast.bind(this),
      batchTerminalData: this.batchTerminalData.bind(this),
      batchTaskUpdate: this.batchTaskUpdate.bind(this),
      broadcastSessionStateDebounced: this.broadcastSessionStateDebounced.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      getSessionStateWithRespawn: this.getSessionStateWithRespawn.bind(this),
      getRunSummaryTracker: (id: string) => this.runSummaryTrackers.get(id),
      stopTranscriptWatcher: this.stopTranscriptWatcher.bind(this),
      cleanupSessionBatches: (id: string) => this.sse.cleanupSessionBatches(id),
      cancelPersistDebounce: (id: string) => this.persistDeb.cancelKey(id),
      removeRunSummaryTracker: (id: string) => {
        const tracker = this.runSummaryTrackers.get(id);
        if (tracker) {
          tracker.recordSessionStopped();
          tracker.stop();
          this.runSummaryTrackers.delete(id);
        }
      },
      removeSessionListenerRefs: (id: string) => {
        const refs = this.sessionListenerRefs.get(id);
        const sess = this.sessions.get(id);
        if (refs && sess) {
          detachSessionListeners(sess, refs);
        }
        this.sessionListenerRefs.delete(id);
      },
      cleanupRespawnOnExit: (id: string) => {
        const controller = this.respawnControllers.get(id);
        if (controller) {
          controller.stop();
          controller.removeAllListeners();
          this.respawnControllers.delete(id);
        }
        const timerInfo = this.respawnTimers.get(id);
        if (timerInfo) {
          clearTimeout(timerInfo.timer);
          this.respawnTimers.delete(id);
        }
      },
      getStore: () => this.store,
      registerAttachment: (id: string, filePath: string, source: 'external' | 'codex-generated') =>
        this.registerAttachment(id, filePath, source),
      updateSessionName: (id: string, name: string) => this.mux.updateSessionName(id, name),
    };
  }

  /**
   * Register a terminal-requested external file as a live attachment and
   * broadcast it. Triggered by the session's `attachmentRequested` event
   * (codeman://attach magic links). Because terminal output is
   * attacker-influenceable (a prompt-injected session can print an arbitrary
   * `codeman://attach?path=` link), the scanned path is FORCE-confined to the
   * session workspace — passive magic links can't expose arbitrary host files.
   * Deliberate cross-workspace attachment goes through the explicit,
   * Origin-guarded `POST /attachments` route (and `codeman attach`, which POSTs
   * directly inside a managed session). Codex-mode `Saved to:` requests
   * (`source: 'codex-generated'`) instead go through
   * registerGeneratedArtifactAttachment, which stays force-confined unless the
   * realpath-resolved target is inside the workspace or a home-anchored
   * `~/.codex*` generated-artifact directory. Registration also enforces the
   * COD-53 blocklist as defense-in-depth.
   */
  private async registerAttachment(
    sessionId: string,
    filePath: string,
    source: 'external' | 'codex-generated'
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const event =
      source === 'codex-generated'
        ? await registerGeneratedArtifactAttachment({
            sessionId,
            filePath,
            sessionWorkingDir: session.workingDir,
          })
        : await registerExternalAttachment(sessionId, filePath, {
            sessionWorkingDir: session.workingDir,
            forceWorkspaceConfinement: true,
          });
    const record = attachmentRegistry.get(sessionId, event.attachmentId);
    if (record) {
      session.upsertAttachmentHistory(
        buildExternalAttachmentHistoryItem({
          sessionId,
          externalPath: record.filePath,
          fileName: record.fileName,
          extension: record.extension,
          size: record.size,
          mtimeMs: record.mtimeMs,
          timestamp: event.timestamp,
        })
      );
      this.persistSessionState(session);
    }
    this.broadcast(SseEvent.AttachmentDetected, event);
  }

  private setupRespawnListeners(sessionId: string, controller: RespawnController): void {
    wireRespawnListeners(sessionId, controller, this.buildRespawnWiringDeps());
  }

  private setupTimedRespawn(sessionId: string, durationMinutes: number): void {
    setupTimedRespawn(sessionId, durationMinutes, this.buildRespawnWiringDeps());
  }

  private restoreRespawnController(session: Session, config: PersistedRespawnConfig, source: string): void {
    restoreRespawnController(session, config, source, this.buildRespawnWiringDeps());
  }

  private buildRespawnWiringDeps(): RespawnWiringDeps {
    return {
      broadcast: this.broadcast.bind(this),
      sendPushNotifications: this.sendPushNotifications.bind(this),
      persistSessionState: this.persistSessionState.bind(this),
      getSession: (id) => this.sessions.get(id),
      sessionExists: (id) => this.sessions.has(id),
      getRunSummaryTracker: (id) => this.runSummaryTrackers.get(id),
      getRespawnControllers: () => this.respawnControllers,
      getRespawnTimers: () => this.respawnTimers,
      getPendingRespawnStarts: () => this.pendingRespawnStarts,
      teamWatcher: this.teamWatcher,
      serverStartTime: this.serverStartTime,
      respawnRestoreGracePeriodMs: 2 * 60 * 1000,
      mux: this.mux,
    };
  }

  // Helper to get custom CLAUDE.md template path from settings
  private async getDefaultClaudeMdPath(): Promise<string | undefined> {
    const settingsPath = dataPath('settings.json');

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
  // The settings PUT route writes the file without invalidating this cache, so
  // callers that must observe a just-saved value (e.g. renderIndexHtml on a
  // post-save reload) pass forceFresh=true to bypass the cache.
  private _settingsCache: { data: Record<string, unknown>; ts: number } | null = null;
  private async readSettings(forceFresh = false): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (!forceFresh && this._settingsCache && now - this._settingsCache.ts < 2000) {
      return this._settingsCache.data;
    }
    const settingsPath = dataPath('settings.json');
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
    if (
      claudeMode === 'dangerously-skip-permissions' ||
      claudeMode === 'auto' ||
      claudeMode === 'normal' ||
      claudeMode === 'allowedTools'
    ) {
      return { claudeMode, allowedTools };
    }
    return {};
  }

  // Resolve the bounds-clamped terminal-history config from settings.json.
  private async getTerminalHistoryConfig() {
    const settings = await this.readSettings();
    return resolveTerminalHistoryConfig(settings);
  }

  // Whether the Codeman agent skill is injected into cases on Claude session create
  // (synced `agentSkillEnabled` setting, default OFF; docs/agent-control-plan.md §2).
  private async getAgentSkillEnabled(): Promise<boolean> {
    const settings = await this.readSettings();
    return settings.agentSkillEnabled === true;
  }

  // Whether a Claude session installs Codeman's hooks block into its workspace
  // (synced `workspaceHooksEnabled` setting). Default ON — an absent key means a
  // user who has never seen this setting, and OFF for them would mean no tab
  // alerts, no Approvals Inbox and no respawn idle signals in every workspace
  // Codeman did not scaffold itself.
  private async getWorkspaceHooksEnabled(): Promise<boolean> {
    const settings = await this.readSettings();
    return settings.workspaceHooksEnabled !== false;
  }

  // Whether browser dictation may use this machine's Claude Code credentials
  // (synced `claudeVoiceEnabled` setting, default OFF; docs/claude-voice-plan.md).
  // OFF by default because turning it on spends the operator's Claude subscription
  // on transcription for anyone who can reach the UI.
  private async getClaudeVoiceEnabled(): Promise<boolean> {
    const settings = await this.readSettings();
    return settings.claudeVoiceEnabled === true;
  }

  /**
   * Read My Mind predictor model (docs/readmymind-plan.md): `readMyMindModel`
   * setting, defaulting to the AI-checker opus model. Prediction quality is
   * the product and runs only on an explicit press, so the cost profile is
   * nothing like the idle checker's.
   */
  private async getReadMyMindModel(): Promise<string> {
    const settings = await this.readSettings();
    const model = typeof settings.readMyMindModel === 'string' ? settings.readMyMindModel.trim() : '';
    return model || AI_CHECK_MODEL;
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

  private async startScheduledRun(
    prompt: string,
    workingDir: string,
    durationMinutes: number,
    owner?: string
  ): Promise<ScheduledRun> {
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
      // Multi-user: stamp the requesting user so the spawned Session is owned +
      // permission-downgraded, and list/delete stay owner-scoped.
      owner,
    };

    this.scheduledRuns.set(id, run);
    this.broadcast(SseEvent.ScheduledCreated, run);

    // Start the run loop (fire-and-forget with error handling)
    this.runScheduledLoop(id).catch((err) => {
      console.error(`[WebServer] Scheduled run ${id} failed:`, err);
      const failedRun = this.scheduledRuns.get(id);
      if (failedRun && failedRun.status === 'running') {
        failedRun.status = 'stopped';
        failedRun.logs.push(`[${new Date().toISOString()}] Error: ${getErrorMessage(err)}`);
        this.broadcast(SseEvent.ScheduledStopped, { id, reason: 'error' });
      }
    });

    return run;
  }

  private async runScheduledLoop(runId: string): Promise<void> {
    const run = this.scheduledRuns.get(runId);
    if (!run || run.status !== 'running') return;

    const addLog = (msg: string) => {
      run.logs.push(`[${new Date().toISOString()}] ${msg}`);
      this.broadcast(SseEvent.ScheduledLog, { id: runId, log: run.logs[run.logs.length - 1] });
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
        // Workspace hooks for this iteration's session — legacy scheduled runs are
        // always claude-mode and always local, and used to bypass the shared decision
        // entirely: a scheduled run firing in a linked case that never had an
        // interactive session ran hook-blind (see applyWorkspaceHooks in hooks-config;
        // it reads the `workspaceHooksEnabled` setting itself, skips a vanished
        // workingDir, and swallows failures — a run must never fail on hooks).
        await applyWorkspaceHooks(run.workingDir);

        // Create a session for this iteration.
        if (isMultiUserMode()) {
          // §6.3: resolve the permission mode with the RUN OWNER (a non-granted user
          // must not regain --dangerously-skip-permissions here) and stamp the owner so
          // list/delete stay scoped. owner + mode + allowedTools mirror quick-start.
          const scheduledClaudeCfg = await this.getClaudeModeConfig();
          session = new Session({
            workingDir: run.workingDir,
            owner: run.owner,
            claudeMode: await resolveClaudeModeForUsername(scheduledClaudeCfg.claudeMode, run.owner),
            allowedTools: scheduledClaudeCfg.allowedTools,
          });
        } else {
          // Single-user: build EXACTLY as master (bare workingDir → Session's default
          // mode) so the flag-off path stays byte-identical.
          session = new Session({ workingDir: run.workingDir });
        }
        await this.registerSessionWithLayout(session);
        this.store.incrementSessionsCreated();
        this.persistSessionState(session);
        await this.setupSessionListeners(session);
        run.sessionId = session.id;

        addLog(`Starting task iteration with session ${session.id.slice(0, 8)}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

        // Run the prompt
        const timeRemaining = Math.round((run.endAt - Date.now()) / 60000);
        const enhancedPrompt = `${run.prompt}\n\nNote: You have approximately ${timeRemaining} minutes remaining in this scheduled run. Work efficiently.`;

        const result = await session.runPrompt(enhancedPrompt);
        run.completedTasks++;
        run.totalCost += result.cost;

        addLog(`Task completed. Cost: $${result.cost.toFixed(4)}. Total tasks: ${run.completedTasks}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

        // Clean up the session after iteration to prevent memory leaks
        await this.cleanupSession(session.id, true, 'scheduled_run');
        run.sessionId = null;

        // Small pause between iterations
        await new Promise((r) => setTimeout(r, ITERATION_PAUSE_MS));
      } catch (err) {
        addLog(`Error: ${getErrorMessage(err)}`);
        this.broadcast(SseEvent.ScheduledUpdated, run);

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

    this.broadcast(SseEvent.ScheduledCompleted, run);
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

    this.broadcast(SseEvent.ScheduledStopped, run);
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
      this.broadcast(SseEvent.ScheduledDeleted, { id });
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
  private async cleanupStaleSessions(): Promise<number> {
    const activeSessionIds = new Set(this.sessions.keys());
    const result = await this.tabLayouts.runStaleSessionCleanup(activeSessionIds, (ids) =>
      this.store.cleanupSessionsByIds(ids)
    );
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
  private getLightState(identity?: import('../types/user.js').AuthUser) {
    const base = this.computeLightState();
    // Multi-user: filter the shared cached blob per connection identity (the plan's
    // "filter AFTER the cache" approach). No-op for admins / single-user.
    if (isMultiUserMode() && identity && identity.role !== 'admin') {
      return this.filterLightStateForUser(base, identity.username);
    }
    return base;
  }

  /** Shallow-filter the light-state blob to what a non-admin user may see. */
  private filterLightStateForUser(base: Record<string, unknown>, username: string): Record<string, unknown> {
    const authoritativeOwners = new Map<string, string | undefined>();
    for (const [id, session] of Object.entries(this.store.getSessions())) authoritativeOwners.set(id, session.owner);
    for (const [id, session] of this.sessions) authoritativeOwners.set(id, session.owner);
    const ownedIds = new Set([...authoritativeOwners].filter(([, owner]) => owner === username).map(([id]) => id));
    const ownedClaudeIds = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.owner === username) {
        if (s.claudeSessionId) ownedClaudeIds.add(s.claudeSessionId);
      }
    }
    const sessions = Array.isArray(base.sessions)
      ? (base.sessions as Array<{ owner?: string }>).filter((s) => s.owner === username)
      : base.sessions;
    const respawnStatus: Record<string, unknown> = {};
    for (const [id, v] of Object.entries((base.respawnStatus as Record<string, unknown>) ?? {})) {
      if (ownedIds.has(id)) respawnStatus[id] = v;
    }
    const bySession = (arr: unknown, key: 'sessionId' | 'sessionUuid') =>
      Array.isArray(arr)
        ? (arr as Array<Record<string, unknown>>).filter((x) => ownedClaudeIds.has(String(x[key])))
        : arr;
    const filtered: Record<string, unknown> = {
      ...base,
      sessions,
      sessionOrder: Array.isArray(base.sessionOrder)
        ? (base.sessionOrder as string[]).filter((id) => ownedIds.has(id))
        : [],
      respawnStatus,
      scheduledRuns: [], // legacy ScheduledRun has no owner yet → admin-only
      subagents: bySession(base.subagents, 'sessionId'),
      workflowRuns: bySession(base.workflowRuns, 'sessionUuid'),
      planUsage: null, // host-plan telemetry is admin-only
    };
    // #29: globalStats is a machine-wide aggregate (all users' tokens/cost + active
    // count) with no per-user attribution — never expose it to a non-admin. The
    // header falls back to per-active-session totals when it is absent.
    delete filtered.globalStats;
    return filtered;
  }

  private computeLightState() {
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
      sessionOrder: this.store.getSessionOrder(),
      scheduledRuns: Array.from(this.scheduledRuns.values()),
      respawnStatus,
      globalStats: this.store.getAggregateStats(activeSessionTokens),
      subagents: subagentWatcher.getRecentSubagents(15), // 15 min to avoid stale agents
      workflowRuns: workflowRunWatcher.getAllRunSummaries(), // ultracode run summaries (no agents[]) for the LEFT list
      timestamp: now,
      inputCjkForm: process.env.INPUT_CJK_FORM?.toUpperCase() === 'ON',
      planUsage: getLatestPlanUsage(), // last-known plan-usage telemetry, for the header chip on fresh load
    };

    this.cachedLightState = { data: result, timestamp: now };
    return result;
  }

  // ========== SSE Delegates (SseStreamManager) ==========

  private broadcast(event: string, data: unknown): void {
    // Invalidate caches on structural changes (creation/deletion)
    if (event === SseEvent.SessionCreated || event === SseEvent.SessionDeleted) {
      this.cachedLightState = null;
      this.cachedSessionsList = null;
    }
    // Multi-user: derive an ownership routing hint so an event only reaches the
    // clients entitled to it (no-op in single-user — hint stays undefined).
    this.sse.broadcast(event, data, isMultiUserMode() ? this.deriveSseHint(event, data) : undefined);
  }

  /**
   * Map an SSE event + payload to a routing hint (multi-user). Session-scoped
   * families resolve the owner from a sessionId in the payload (fail closed if it
   * can't be resolved); machine-level families are admin-only; host-plan telemetry
   * is admin-only; everything else stays global. Default is fail-closed for the
   * session-scoped prefixes so a missed field starves rather than leaks.
   */
  private deriveSseHint(event: string, data: unknown): import('./sse-stream-manager.js').SseRoutingHint | undefined {
    // Machine-level / host-wide: admins only.
    if (
      event.startsWith('docker:') ||
      event.startsWith('tunnel:') ||
      event.startsWith('update:') ||
      event.startsWith('system:') ||
      event.startsWith('cron:') ||
      event === SseEvent.SessionStatusTelemetry
    ) {
      return { adminOnly: true };
    }
    // Layout payloads contain only trusted routing metadata. Route them to that
    // exact owner plus admins, never by resolving a client-supplied ref.
    if (event.startsWith('tab:')) {
      return deriveTabLayoutSseHint(data);
    }
    // Session-scoped families: resolve the owner from the payload's session id.
    const SESSION_PREFIXES = [
      'session:',
      'ralph:',
      'respawn:',
      'subagent:',
      'workflow:',
      'attachment:',
      'task:',
      'mux:',
      'transcript:',
      'plan:',
      'orchestrator:',
      'hook:',
      'approval:',
      'image:',
      'scheduled:',
      'team:',
      'case:',
    ];
    if (SESSION_PREFIXES.some((p) => event.startsWith(p))) {
      const d = (data ?? {}) as { sessionId?: string; id?: string; session?: { id?: string } };
      const sessionId = d.sessionId ?? d.id ?? d.session?.id;
      const owner = sessionId ? this.sessions.get(sessionId)?.owner : undefined;
      return { owner, sessionScoped: true };
    }
    // #20/#38: clipboard:write writes into the receiver's OS clipboard — route it to
    // the POSTING user's own tabs only (never other users). The route stamps the
    // trusted caller identity as `callerUsername`. sessionScoped:true fails closed
    // (withhold from non-admins) if the caller identity is somehow unresolved, rather
    // than falling through to global delivery.
    if (event.startsWith('clipboard:')) {
      return { username: (data as { callerUsername?: string }).callerUsername, sessionScoped: true };
    }
    // Unrecognized / genuinely global events (connection status, needsRefresh): all.
    return undefined;
  }

  private batchTerminalData(sessionId: string, data: string): void {
    this.sse.batchTerminalData(sessionId, data);
  }

  private batchTaskUpdate(sessionId: string, task: BackgroundTask): void {
    this.sse.batchTaskUpdate(sessionId, task);
  }

  private broadcastSessionStateDebounced(sessionId: string): void {
    this.sse.broadcastSessionStateDebounced(sessionId);
  }

  // ========== Web Push ==========

  /** Map SSE event names to push notification payloads */
  private static readonly PUSH_EVENT_MAP: Record<
    string,
    { title: string; urgency: string; actions?: Array<{ action: string; title: string }> }
  > = {
    [SseEvent.HookPermissionPrompt]: {
      title: 'Permission Required',
      urgency: 'critical',
      actions: [
        { action: 'approve', title: 'Approve' },
        { action: 'deny', title: 'Deny' },
      ],
    },
    [SseEvent.HookElicitationDialog]: { title: 'Question Asked', urgency: 'critical' },
    [SseEvent.HookIdlePrompt]: { title: 'Waiting for Input', urgency: 'warning' },
    [SseEvent.HookStop]: { title: 'Response Complete', urgency: 'info' },
    [SseEvent.SessionError]: { title: 'Session Error', urgency: 'critical' },
    [SseEvent.RespawnBlocked]: { title: 'Respawn Blocked', urgency: 'critical' },
    [SseEvent.SessionRespawnBreakerTripped]: { title: 'Session crash loop stopped', urgency: 'critical' },
    [SseEvent.SessionRalphCompletionDetected]: { title: 'Task Complete', urgency: 'warning' },
  };

  /**
   * Send push notifications for a given event to all subscribed devices.
   * Only events in PUSH_EVENT_MAP trigger push. Per-subscription preferences are checked.
   * Expired subscriptions (410/404) are auto-removed.
   */
  // Async only for the Approvals Inbox settings read below; every call site is
  // fire-and-forget (the EventPort signature stays `void`).
  private async sendPushNotifications(event: string, data: Record<string, unknown>): Promise<void> {
    const template = WebServer.PUSH_EVENT_MAP[event];
    if (!template) return;

    const subscriptions = this.pushStore.getAll();
    if (subscriptions.length === 0) return;

    // Approvals Inbox gating: the Approve/Deny action buttons answer through
    // the inbox, so both the buttons and the approvalId they act on ship only
    // when the OPT-IN `approvalsInboxEnabled` setting is on (default OFF).
    // Pre-inbox these buttons rendered and did nothing; stripping them when
    // the feature is off is the honest shape. Cheap: the settings read is
    // cached (~2s TTL) and only taken for events that carry approval parts.
    let approvalsEnabled = false;
    if (template.actions || typeof data.approvalId === 'string') {
      const settings = await this.readSettings();
      approvalsEnabled = settings.approvalsInboxEnabled === true;
    }

    const vapidKeys = this.pushStore.getVapidKeys();
    webpush.setVapidDetails('mailto:codeman@localhost', vapidKeys.publicKey, vapidKeys.privateKey);

    const sessionName = (data.sessionName as string) || '';
    const sessionId = (data.sessionId as string) || '';

    // Multi-user: a session-scoped push (all PUSH_EVENT_MAP events carry a sessionId)
    // must reach only the owner's devices (+ admins) — the body embeds the session
    // name + activity, so cross-user delivery would leak it. Resolved once here; the
    // per-subscription gate below is a no-op in single-user (send to all).
    const multiUserPush = isMultiUserMode();
    const pushSessionOwner = sessionId ? this.sessions.get(sessionId)?.owner : undefined;

    // Build body text from event data
    let body = sessionName ? `[${sessionName}]` : '';
    if (event === SseEvent.SessionError && data.error) {
      body += body ? ' ' : '';
      body += String(data.error).slice(0, 200);
    } else if (event === SseEvent.RespawnBlocked && data.reason) {
      body += body ? ' ' : '';
      body += String(data.reason);
    } else if (event === SseEvent.SessionRalphCompletionDetected && data.phrase) {
      body += body ? ' ' : '';
      body += String(data.phrase);
    } else if (event === SseEvent.SessionRespawnBreakerTripped && data.count) {
      body += body ? ' ' : '';
      body += `Stopped after ${Number(data.count)} rapid crashes — restart the session to retry`;
    } else if (event === SseEvent.HookPermissionPrompt && data.tool_name) {
      body += body ? ' ' : '';
      body += `Tool: ${String(data.tool_name)}`;
    }

    const payload = JSON.stringify({
      title: template.title,
      // Hostname-aware prefix so OS-level notifications from multiple Codeman
      // instances (laptop / dev box / NAS) are unambiguous in the system tray.
      // Mirrors the in-page Notification format in notification-manager.js.
      hostTitle: this.windowTitle,
      body,
      tag: `codeman-${event}-${sessionId}`,
      sessionId,
      // Approvals Inbox item id: lets sw.js answer an Approve/Deny action
      // click directly (POST /api/approvals/:id/answer) with no tab open.
      // Gated on the opt-in setting together with the action buttons.
      approvalId: approvalsEnabled && typeof data.approvalId === 'string' ? data.approvalId : undefined,
      urgency: template.urgency,
      actions: approvalsEnabled ? template.actions : undefined,
    });

    for (const sub of subscriptions) {
      // Check per-subscription preferences
      if (sub.pushPreferences[event] === false) continue;

      // Multi-user recipient scoping: admins receive all; a session-scoped event
      // reaches only subscriptions owned by the session owner (fail closed if the
      // owner is unresolved — legacy subs with no stamped username are excluded);
      // a genuinely session-less event reaches everyone.
      if (multiUserPush && sub.role !== 'admin') {
        if (sessionId) {
          if (sub.username === undefined || sub.username !== pushSessionOwner) continue;
        }
      }

      // Re-validate the stored endpoint before fetching it server-side (SSRF, M7).
      // Defense-in-depth: subscribe-time validation already rejects unsafe URLs.
      if (!isSafePushEndpoint(sub.endpoint)) {
        console.warn('[push] skipping notification to unsafe endpoint:', sub.endpoint);
        this.pushStore.removeByEndpoint(sub.endpoint);
        continue;
      }

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

  private cleanupDeadSSEClients(): void {
    this.sse.cleanupDeadClients();
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

  private async refreshCodexPlanUsage(): Promise<void> {
    if (this.codexUsageRefreshInFlight) return;
    this.codexUsageRefreshInFlight = true;
    try {
      const binaryPath = resolveCodexBinaryPath();
      const usage = binaryPath ? await readCodexPlanUsage(binaryPath, APP_VERSION) : null;
      const signature = usage ? telemetrySignature(usage) : '';
      if (signature === this.lastCodexUsageSignature) return;
      this.lastCodexUsageSignature = signature;
      const snapshot = setLatestCodexPlanUsage(usage);
      this.cachedLightState = null;
      this.broadcast(SseEvent.SessionStatusTelemetry, snapshot);
    } finally {
      this.codexUsageRefreshInFlight = false;
    }
  }

  async start(): Promise<void> {
    // Multi-user first boot: create the initial admin from CODEMAN_USERNAME/PASSWORD
    // if there are no users yet, else refuse to start (there would be no way in).
    if (isMultiUserMode() && !this.testMode) {
      const boot = await bootstrapInitialAdmin();
      if (boot.status === 'missing-env') {
        throw new Error(
          'Multi-user mode is enabled but users.json has no users. Create the first admin with ' +
            '`codeman users add <name> --admin` (or set CODEMAN_USERNAME/CODEMAN_PASSWORD for one-time bootstrap).'
        );
      }
      if (boot.status === 'created') {
        console.log(
          `✓ Multi-user: bootstrapped initial admin "${boot.username}" from CODEMAN_USERNAME/CODEMAN_PASSWORD`
        );
      }
      console.log('✓ Multi-user mode active (per-user accounts in users.json; CODEMAN_PASSWORD is ignored for login)');
    }

    await this.setupRoutes();

    const lifecycleLog = getLifecycleLog();
    lifecycleLog.log({ event: 'server_started', sessionId: '*' });
    await lifecycleLog.trimIfNeeded();

    // If a self-update restarted us into this process, finalize its status file
    // (flip the persisted "restarting" marker → completed/failed based on the
    // version we actually booted). No-op on a normal boot. See web/self-update.ts.
    if (!this.testMode) {
      reconcileUpdateOnBoot();
    }

    // Restore mux sessions BEFORE accepting connections
    // This prevents race conditions where clients connect before state is ready
    // CRITICAL: Skip in test mode to prevent tests from picking up user sessions
    if (!this.testMode) {
      const restored = await this.restoreMuxSessions();
      await this.finalizeRestoredState(restored);

      // Instance-scoped reaper: after restore, `docker rm -f` managed containers of
      // THIS instance whose case is gone from docker-cases.json (best-effort, never
      // touches another instance's containers). Runs after restore so containers
      // still referenced by a restored session are preserved.
      if (restored) {
        void import('../docker-hosts.js')
          .then(({ reapOrphanedDockerContainers }) => reapOrphanedDockerContainers(getDataDir(), CODEMAN_INSTANCE))
          .then((reaped) => {
            if (reaped.length > 0)
              console.log(`[Docker] reaped ${reaped.length} orphaned container(s): ${reaped.join(', ')}`);
          })
          .catch(() => {
            /* best-effort — daemon may be absent */
          });
      }
    }

    // Bound disk use under heavy paste-image traffic: delete `paste-*` files
    // older than 7 days from each live session's .claude-images/ hourly.
    if (!this.testMode) {
      this._pasteImageGcStop = startPasteImageGc({ sessions: this.sessions });
      // Surface event-loop stalls (e.g. a slow synchronous tmux/ps call) so the
      // intermittent ":3000 briefly unreachable, process never restarts" class of
      // incident leaves a quantified log line instead of vanishing silently.
      this._eventLoopMonitor = startEventLoopMonitor();
    }

    await this.app.listen({ port: this.port, host: this.host });
    const protocol = this.https ? 'https' : 'http';
    const displayHost = this.host === '0.0.0.0' ? 'localhost' : this.host;
    // The only startup banner: `codeman web` used to print its own copy of this
    // line, but the daemon and service launch paths never go through the CLI.
    console.log(palette.ok(`${GLYPH.ok} Codeman web interface running at ${protocol}://${displayHost}:${this.port}`));

    // Opt-in: also serve the HOOK endpoints on the docker bridge gateway so
    // in-container hooks (permission/idle/stop callbacks) can reach a loopback-bound
    // server. Hooks-only + secret-gated, and the bridge is host-internal (not the LAN).
    if (!this.testMode) {
      await this._startDockerBridgeHooksListener().catch((err) =>
        console.error(`[Docker] bridge-hooks listener error: ${err?.message || err}`)
      );
    }

    // Anti-DNS-rebinding Host allowlist is always on. Localhost, any bare IP, the
    // bind host, *.ts.net / *.trycloudflare.com / *.cfargotunnel.com, and the active
    // managed tunnel are accepted automatically; add any other domain you front this
    // with (e.g. a custom reverse-proxy host) via CODEMAN_ALLOWED_HOSTS=host1,.suffix.
    const extraAllowed = (process.env.CODEMAN_ALLOWED_HOSTS || '').trim();
    if (extraAllowed) {
      console.log(`   Host allowlist also accepts: ${extraAllowed}`);
    }

    // Codeman binds loopback (127.0.0.1) by default, which is safe out of the box.
    // If the user opts into a non-loopback bind (e.g. --host 0.0.0.0) WITHOUT a
    // password we no longer refuse to start — that surprised people whose setups
    // "just worked" before. Instead we start and warn loudly, pointing at the ways
    // to secure it. --allow-unauthenticated-network just acknowledges the risk (a
    // terser note). See docs/security-architecture.md.
    // Multi-user mode with >= 1 enabled user satisfies the auth requirement even
    // without CODEMAN_PASSWORD (every person has their own credential).
    const authActive = !!process.env.CODEMAN_PASSWORD || (isMultiUserMode() && (await hasUsers()));
    if (!isLoopbackBindHost(this.host) && !authActive) {
      // Painted like the CLI's copy of the same warning. chalk degrades to plain
      // text off a TTY, so journald and web.log stay free of escape codes.
      if (this.allowUnauthenticatedNetwork) {
        console.warn(
          palette.warn(
            `\n${GLYPH.warn}  Codeman is reachable WITHOUT a password on ${displayHost}:${this.port} ` +
              '(explicitly allowed). Anyone who can reach it can control your Claude sessions.\n'
          )
        );
      } else {
        console.warn(
          palette.err(
            `\n${GLYPH.warn}  WARNING: Codeman is bound to a non-loopback host (${this.host}) with NO password.`
          )
        );
        console.warn(
          palette.err(`   Anyone who can reach ${displayHost}:${this.port} can control your Claude sessions.`)
        );
        console.warn(palette.warn('   Secure it with ONE of:'));
        console.warn(palette.warn('     • set CODEMAN_PASSWORD=<password>   (HTTP Basic auth), or'));
        console.warn(palette.warn('     • bind loopback only: --host 127.0.0.1, then front it with an'));
        console.warn(palette.warn('       authenticated tunnel (cloudflared) or `tailscale serve`, or'));
        console.warn(palette.warn('     • keep this bind and accept the risk: --allow-unauthenticated-network'));
        console.warn(palette.muted('   See docs/security-architecture.md for details.\n'));
      }
    }

    // Set API URL for child processes (MCP server, spawned sessions)
    const apiHost =
      this.host === '0.0.0.0' || this.host === 'localhost' || this.host === '::1' ? '127.0.0.1' : this.host;
    process.env.CODEMAN_API_URL = `${protocol}://${apiHost}:${this.port}`;

    // Ensure the COD-54 hook secret exists on disk before any session exports
    // $CODEMAN_HOOK_SECRET_FILE — hook curls cat that path at execution time.
    getHookSecret();

    // Main Codex subscription limits come from the signed-in local CLI. Keep
    // this read-only and host-scoped; multi-user SSE routing makes it admin-only.
    if (!this.testMode) {
      void this.refreshCodexPlanUsage();
      this.cleanup.setInterval(() => void this.refreshCodexPlanUsage(), CODEX_USAGE_POLL_INTERVAL_MS, {
        description: 'Codex plan-usage refresh',
      });
    }

    // Start scheduled runs cleanup timer
    this.cleanup.setInterval(
      () => {
        this.cleanupScheduledRuns();
      },
      SCHEDULED_CLEANUP_INTERVAL,
      { description: 'scheduled runs cleanup' }
    );

    // Start the cron loop (fires due CronJobs).
    this.cleanup.setInterval(
      () => {
        this.cronService.tickDueJobs().catch((err) => {
          console.error('[cron] tick failed:', getErrorMessage(err));
        });
      },
      CRON_TICK_INTERVAL,
      { description: 'scheduled jobs due-checker' }
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
      INACTIVITY_TIMEOUT_MS,
      { description: 'periodic token recording' }
    );

    // Start subagent watcher for Claude Code background agent visibility (if enabled)
    if (await this.isSubagentTrackingEnabled()) {
      subagentWatcher.start();
      console.log('Subagent watcher started - monitoring ~/.claude/projects for background agent activity');
    } else {
      console.log('Subagent watcher disabled by user settings');
    }

    // Start workflow run watcher for ultracode / Workflow run visualization (if enabled)
    if (await this.isWorkflowAgentTrackingEnabled()) {
      workflowRunWatcher.start();
      console.log('Workflow run watcher started - monitoring ~/.claude/projects for ultracode run activity');
    } else {
      console.log('Workflow run watcher disabled by user settings (showUltracodeAgents off)');
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
      const settingsPath = dataPath('settings.json');
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
    const settingsPath = dataPath('settings.json');
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
   * Check if ultracode/workflow run tracking is enabled in settings (default: FALSE — opt-in).
   * The watcher feeds BOTH the docked Ultracode Agents panel (`showUltracodeAgents`) and the
   * floating run windows (`ultracodeFloatingWindows`), so either toggle starts it.
   */
  private async isWorkflowAgentTrackingEnabled(): Promise<boolean> {
    const settingsPath = dataPath('settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      return (settings.showUltracodeAgents ?? false) || (settings.ultracodeFloatingWindows ?? false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to read showUltracodeAgents setting:', err);
      }
    }
    return false; // Default disabled (opt-in)
  }

  /**
   * Check if image watcher is enabled in settings (default: false)
   */
  private async isImageWatcherEnabled(): Promise<boolean> {
    const settingsPath = dataPath('settings.json');
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
    const settingsPath = dataPath('settings.json');
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

  private async restoreMuxSessions(): Promise<boolean> {
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
            // Owner round-trips like remote/docker: mux-sessions.json carries
            // MuxSession.owner, state.json carries SessionState.owner. Recovery must
            // re-resolve the permission mode with the RECOVERED owner or a reboot
            // would silently un-downgrade a non-granted user's restored session.
            const recoveredOwner = muxSession.owner ?? savedState?.owner;
            const recoveryClaudeModeConfig = await this.getClaudeModeConfig();
            const recoveryClaudeMode = {
              claudeMode: await resolveClaudeModeForUsername(recoveryClaudeModeConfig.claudeMode, recoveredOwner),
              allowedTools: recoveryClaudeModeConfig.allowedTools,
            };
            // Recover envOverrides from the internal __envOverrides field written by
            // session-manager (see updateSessionState). Cast to read the non-public field.
            // Note: a legacy CLAUDE_CODE_EFFORT_LEVEL entry is auto-migrated to `effort`
            // by the Session constructor (env var would hard-lock /effort switching).
            const savedEnvOverrides = (savedState as { __envOverrides?: Record<string, string> })?.__envOverrides;
            // Prefer the private (externalPath-bearing) history; fall back to the
            // sanitized public copy for sessions persisted before that split.
            const savedAttachmentHistory =
              (savedState as { __attachmentHistory?: SessionAttachmentHistoryItem[] })?.__attachmentHistory ??
              savedState?.attachmentHistory;
            const session = new Session({
              id: muxSession.sessionId, // Preserve the original session ID
              workingDir: muxSession.workingDir,
              mode: muxSession.mode,
              name: sessionName,
              nameSource: savedState?.nameSource,
              // When the session FIRST started, not when this server booted.
              // Without it every recovered session was restamped `Date.now()` on
              // each restart, so a week-old pane read as "created 2m ago" on the
              // home screens (and sorted as the newest thing in the unified list).
              // mux-sessions.json carries the tmux session's own birth time.
              createdAt: muxSession.createdAt || savedState?.createdAt,
              mux: this.mux,
              useMux: true,
              muxSession: muxSession, // Pass the existing session so startInteractive() can attach to it
              claudeMode: recoveryClaudeMode.claudeMode,
              allowedTools: recoveryClaudeMode.allowedTools,
              openCodeConfig: muxSession.mode === 'opencode' ? savedState?.openCodeConfig : undefined,
              codexConfig: muxSession.mode === 'codex' ? savedState?.codexConfig : undefined,
              geminiConfig: muxSession.mode === 'gemini' ? savedState?.geminiConfig : undefined,
              antigravityConfig: muxSession.mode === 'antigravity' ? savedState?.antigravityConfig : undefined,
              piConfig: muxSession.mode === 'pi' ? savedState?.piConfig : undefined,
              grokConfig: muxSession.mode === 'grok' ? savedState?.grokConfig : undefined,
              deepSeekConfig: muxSession.mode === 'deepseek' ? savedState?.deepSeekConfig : undefined,
              ompConfig: muxSession.mode === 'omp' ? savedState?.ompConfig : undefined,
              envOverrides: savedEnvOverrides,
              effort: savedState?.effort,
              attachmentHistory: savedAttachmentHistory,
              // The pane's last Enter. Without it the response viewer would show
              // the launch conversation until the user types again, even though
              // the re-attached CLI is on a post-`/clear` one.
              lastSubmitAt: savedState?.lastSubmitAt,
              // The pane's last output, previous run's value. Without it every
              // restart restamped all sessions "now" (constructor + the attach
              // repaint within the same second), flattening the home screens'
              // most-recently-quiet ordering to tab order after each deploy.
              lastActivityAt: savedState?.lastActivityAt,
              // Remote SSH metadata must round-trip on recovery: without it the
              // attach cwd falls back to the (nonexistent-locally) remote path and
              // respawn rebuilds a LOCAL command, breaking the pane and silently
              // erasing `remote` from state.json on the next persist. mux-sessions.json
              // round-trips MuxSession.remote; state.json carries SessionState.remote.
              remote: muxSession.remote ?? savedState?.remote,
              // Docker metadata round-trips the same way (mux-sessions.json carries
              // MuxSession.docker; state.json carries SessionState.docker), so recovery
              // rebuilds the `docker exec` launch instead of a broken local command.
              docker: muxSession.docker ?? savedState?.docker,
              owner: recoveredOwner,
              // Tab lineage survives a restart. It is only decoration, so a parent
              // that did NOT come back is harmless: the frontend draws an edge only
              // when both tabs are on screen.
              parentSessionId: savedState?.parentSessionId,
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
              // Auto-resume on usage limit (re-arms a pending schedule; an
              // overdue one fires shortly after boot — the limit footer won't
              // reprint on its own, so the pause would otherwise stall)
              if (savedState.autoResumeEnabled) {
                session.restoreAutoResume(true, savedState.autoResumeAt);
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
              // Ralph / Todo tracker (not supported for external-CLI sessions)
              if (!isExternalCliMode(session.mode)) {
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
              // Respawn controller (not supported for external-CLI sessions)
              if (!isExternalCliMode(session.mode) && savedState.respawnEnabled && savedState.respawnConfig) {
                try {
                  this.restoreRespawnController(session, savedState.respawnConfig, 'state.json');
                } catch (err) {
                  console.error(`[Server] Failed to restore respawn for session ${session.id}:`, err);
                }
              }
            }

            // Fallback: restore respawn from mux-sessions.json if state.json didn't have it (not supported for external CLIs)
            if (
              !isExternalCliMode(session.mode) &&
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
            // Ralph tracker is not supported for external-CLI sessions
            if (
              !isExternalCliMode(session.mode) &&
              !session.ralphTracker.enabled &&
              !session.ralphTracker.autoEnableDisabled
            ) {
              const ralphState = this.store.getRalphState(muxSession.sessionId);
              if (ralphState?.loop?.enabled) {
                session.ralphTracker.restoreState(ralphState.loop, ralphState.todos);
                console.log(`[Server] Restored Ralph state from inner store for session ${session.id}`);
              }
            }

            // Fallback: auto-detect completion phrase from CLAUDE.md (not supported for external CLIs)
            if (
              !isExternalCliMode(session.mode) &&
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

            // Auto-attach PTY to the surviving tmux session immediately.
            // This ensures ALL sessions resume capturing output right away,
            // not just the one the client happens to select first.
            try {
              await session.startInteractive();
              getLifecycleLog().log({
                event: 'recovered',
                sessionId: session.id,
                name: session.name,
              });
              console.log(`[Server] Restored and attached session ${session.id} from mux ${muxSession.muxName}`);
            } catch (attachErr) {
              console.error(`[Server] Failed to attach session ${session.id}, keeping as detached:`, attachErr);
              getLifecycleLog().log({
                event: 'recovered',
                sessionId: session.id,
                name: session.name,
              });
            }

            this.persistSessionState(session);
          }
        }

        // Sessions recovered from a previous run predate the create-path hook
        // install, and these are long-lived: by the time a server restart comes
        // round a session may be days old and has been running hook-blind the
        // whole time. Claude Code re-reads settings.local.json, so writing the
        // block now arms the RUNNING CLI, no session restart needed.
        await this.ensureHooksForRecoveredWorkspaces();

        // Start stats collection for mux sessions
        this.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      }

      // Start mouse mode sync (tmux only) — toggles mouse on/off based on pane count.
      // Mouse off = native xterm.js selection; mouse on = tmux pane clicking (split layouts).
      // Always start, even with no sessions — new sessions may be created later.
      if ('startMouseModeSync' in this.mux) {
        (this.mux as { startMouseModeSync: (ms?: number) => void }).startMouseModeSync();
      }

      // COD-108 — start the remote-session auto-reconnect watcher (tmux only).
      // Always-on (D3) with a `remoteAutoReconnect` kill-switch the watcher reads
      // each tick. Start even with no sessions — remote sessions may arrive later.
      if ('startRemoteReconnectWatcher' in this.mux) {
        (this.mux as { startRemoteReconnectWatcher: (ms?: number) => void }).startRemoteReconnectWatcher();
      }

      if (dead.length > 0) {
        console.log(`[Server] Cleaned up ${dead.length} dead mux session(s)`);
      }
      return true;
    } catch (err) {
      console.error('[Server] Failed to restore mux sessions:', err);
      return false;
    }
  }

  /** Unlock destructive reconciliation only after mux restoration fully succeeds. */
  private async finalizeRestoredState(restored: boolean): Promise<void> {
    if (!restored) {
      this.tabLayouts.markRestorationFailed();
      return;
    }
    this.tabLayouts.markRestorationComplete();
    await this.cleanupStaleSessions();
    await this.tabLayouts.reconcileAfterRestoration();
  }

  /**
   * Install Codeman's hooks into the workspaces of the sessions just recovered.
   *
   * Deduped by workspace, because sessions in one repo share a single
   * `.claude/settings.local.json` and the write is otherwise repeated per tab.
   * Claude mode only (nothing else reads `.claude` hooks), never for remote
   * sessions (their `workingDir` is a path on ANOTHER host, so writing it here
   * would scaffold a stray directory locally), and never for a docker case that
   * opted out of hooks.
   *
   * Failures are swallowed per workspace: `ensureCodemanHooks` already refuses
   * unsafe targets with a warning, and a workspace we cannot write to must not
   * stop the rest of recovery.
   *
   * Skipped entirely when `workspaceHooksEnabled` is OFF: that setting exists so a
   * user can keep Codeman out of their repos, and a boot-time sweep is the last
   * place that should ignore it.
   *
   * A workspace that no longer EXISTS is skipped by applyWorkspaceHooks: a tmux
   * session can outlive its deleted repo, and `ensureCodemanHooks` mkdir -p's, so
   * the sweep used to resurrect the directory as an empty tree holding only
   * `.claude/settings.local.json`.
   */
  private async ensureHooksForRecoveredWorkspaces(): Promise<void> {
    if (!(await this.getWorkspaceHooksEnabled())) return;
    const workspaces = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.mode !== 'claude' || session.remote) continue;
      if (session.docker && !session.docker.hooksEnabled) continue;
      if (session.workingDir) workspaces.add(session.workingDir);
    }
    for (const workspace of workspaces) {
      // install=true: the setting was already resolved ON above for the whole batch
      // (OFF skips the sweep wholesale, keeping its documented semantics).
      await applyWorkspaceHooks(workspace, true);
    }
  }

  /**
   * COD-108 — handle a `remoteSessionDropped` emit from the watcher: reattach
   * the dropped remote session and report the outcome back to the watcher so it
   * can reset/advance its backoff. Re-running the idempotent remote command
   * REATTACHES the durable remote tmux session (does NOT recreate it).
   */
  private async handleRemoteSessionDropped(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    // No live Session object (e.g. detached/restored-but-not-attached) — nothing
    // to drive the reattach; report failure so the watcher backs off and retries.
    if (!session) {
      this.noteRemoteReconnect(sessionId, false);
      return;
    }
    let ok = false;
    try {
      ok = await session.reattachRemote();
    } catch (err) {
      console.error(`[Server] Remote reattach failed for ${sessionId}:`, err);
      ok = false;
    }
    this.noteRemoteReconnect(sessionId, ok);
    if (ok) {
      this.persistSessionState(session);
      this.broadcast(SseEvent.RemoteSessionReconnected, { sessionId });
    }
  }

  /** Forward a reattach outcome to the TmuxManager watcher (resets/clears backoff). */
  private noteRemoteReconnect(sessionId: string, success: boolean): void {
    if ('noteRemoteReconnect' in this.mux) {
      (this.mux as { noteRemoteReconnect: (id: string, ok: boolean) => void }).noteRemoteReconnect(sessionId, success);
    }
  }

  private initOrchestratorLoop(): import('../orchestrator-loop.js').OrchestratorLoop {
    if (this._orchestratorLoop) return this._orchestratorLoop;

    this._orchestratorLoop = new OrchestratorLoop(this.mux, process.cwd());
    return this._orchestratorLoop;
  }

  /**
   * Opt-in (CODEMAN_DOCKER_BRIDGE_HOOKS=1): start a SECOND listener on the docker
   * bridge gateway IP that serves ONLY the hook endpoints and delegates them into
   * the main Fastify pipeline. This lets in-container hooks reach a loopback-bound
   * server (they call back via host.docker.internal = the bridge gateway) without
   * exposing the full API or the LAN. Bind IP is auto-detected (default bridge
   * gateway) or set via CODEMAN_DOCKER_BRIDGE_HOST.
   */
  private async _startDockerBridgeHooksListener(): Promise<void> {
    if (!isExplicitlyEnabled(process.env.CODEMAN_DOCKER_BRIDGE_HOOKS)) return;
    const { detectDockerBridgeGateway } = await import('../docker-hosts.js');
    const bridgeHost = (process.env.CODEMAN_DOCKER_BRIDGE_HOST || '').trim() || (await detectDockerBridgeGateway());
    if (!bridgeHost) {
      console.log('[Docker] CODEMAN_DOCKER_BRIDGE_HOOKS set but no docker bridge gateway found — skipping');
      return;
    }
    // Only the hook endpoints are served on the bridge — never the full API.
    const HOOK_PATHS = new Set([
      '/api/hook-event',
      '/api/status-telemetry',
      '/api/v1/hook-event',
      '/api/v1/status-telemetry',
    ]);
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      const path = (req.url || '').split('?')[0];
      if (!HOOK_PATHS.has(path)) {
        res.statusCode = 403;
        res.end('forbidden: the docker bridge listener serves hook endpoints only');
        return;
      }
      // Delegate into Fastify (host-guard, Origin/CSRF, and hook-secret gate all apply).
      (this.app as unknown as { routing: (r: unknown, s: unknown) => void }).routing(req, res);
    };
    let server: import('node:http').Server | import('node:https').Server;
    if (this.https) {
      const https = await import('node:https');
      const { key, cert } = getOrCreateSelfSignedCert();
      server = https.createServer({ key, cert }, handler);
    } else {
      const http = await import('node:http');
      server = http.createServer(handler);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, bridgeHost, () => resolve());
    });
    this._dockerBridgeServer = server;
    console.log(
      `[Docker] in-container hooks reachable at ${this.https ? 'https' : 'http'}://${bridgeHost}:${this.port} (hook endpoints only)`
    );
  }

  async stop(): Promise<void> {
    getLifecycleLog().log({ event: 'server_stopped', sessionId: '*' });
    // Set stopping flag to prevent new timer creation during shutdown
    this.sse.setStopping();

    if (this._pasteImageGcStop) {
      this._pasteImageGcStop();
      this._pasteImageGcStop = null;
    }

    if (this._eventLoopMonitor) {
      this._eventLoopMonitor.stop();
      this._eventLoopMonitor = null;
    }

    if (this._dockerBridgeServer) {
      this._dockerBridgeServer.close();
      this._dockerBridgeServer = null;
    }

    // The background `dsh web` is detached so its whole plugin tree can be
    // signalled at once, which also means it would OUTLIVE Codeman and hold its
    // port against the next start — the exact EADDRINUSE this feature already
    // got wrong once.
    void stopDeepSeekWeb();

    // Dispose all managed timers (intervals + resettable timeouts)
    this.cleanup.dispose();

    // Gracefully close all SSE connections and clear batching state
    this.sse.stop();

    // Release every pending long-poll waiter. Their timers are deliberately not
    // unref'd (an unref'd timer can let the process exit mid-wait and strand the
    // response), so without this a 10-minute wait holds shutdown open.
    sessionWaits.cancelEverything();
    approvalInbox.stop();

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

    // Stop orchestrator loop if running
    if (this._orchestratorLoop) {
      await this._orchestratorLoop.stop();
      this._orchestratorLoop.destroy();
      this._orchestratorLoop = null;
    }

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
        detachSessionListeners(session, listeners);
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
    this.cleanupWorkflowRunWatcherListeners();
    this.cleanupImageWatcherListeners();
    this.cleanupTeamWatcherListeners();

    // Stop subagent watcher
    subagentWatcher.stop();

    // Stop workflow run watcher
    workflowRunWatcher.stop();

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
    if (this.hookSecretFailures) {
      this.hookSecretFailures.dispose();
      this.hookSecretFailures = null;
    }
    if (this.userFailures) {
      this.userFailures.dispose();
      this.userFailures = null;
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
  testMode: boolean = false,
  host: string = '127.0.0.1',
  titleHostname?: string,
  allowUnauthenticatedNetwork: boolean = false
): Promise<WebServer> {
  const server = new WebServer(port, https, testMode, host, titleHostname, allowUnauthenticatedNetwork);
  await server.start();
  return server;
}
