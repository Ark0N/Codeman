import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, totalmem, freemem, loadavg, cpus } from 'node:os';
import { EventEmitter } from 'node:events';
import { Session, ClaudeMessage, type BackgroundTask } from '../session.js';
import { RespawnController, RespawnConfig, RespawnState } from '../respawn-controller.js';
import { ScreenManager } from '../screen-manager.js';
import { getStore } from '../state-store.js';
import { generateClaudeMd } from '../templates/claude-md.js';
import { v4 as uuidv4 } from 'uuid';
import type {
  CreateSessionRequest,
  RunPromptRequest,
  SessionInputRequest,
  ResizeRequest,
  CreateCaseRequest,
  QuickStartRequest,
  CreateScheduledRunRequest,
  QuickRunRequest,
  ApiResponse,
  SessionResponse,
  QuickStartResponse,
  CaseInfo,
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
// Scheduled runs cleanup interval (check every 5 minutes)
const SCHEDULED_CLEANUP_INTERVAL = 5 * 60 * 1000;
// Completed scheduled runs max age (1 hour)
const SCHEDULED_RUN_MAX_AGE = 60 * 60 * 1000;
// Maximum concurrent sessions to prevent resource exhaustion
const MAX_CONCURRENT_SESSIONS = 50;

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
        return { error: 'Session not found' };
      }

      return session.toDetailedState();
    });

    this.app.get('/api/sessions/:id/output', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      return {
        textOutput: session.textOutput,
        messages: session.messages,
        errorBuffer: session.errorBuffer,
      };
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
        await session.startInteractive();
        this.broadcast('session:interactive', { id });
        this.broadcast('session:updated', { session: session.toDetailedState() });
        return { success: true, message: 'Interactive session started' };
      } catch (err) {
        return { error: (err as Error).message };
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
        return { error: (err as Error).message };
      }
    });

    // Send input to interactive session
    this.app.post('/api/sessions/:id/input', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const { input } = req.body as SessionInputRequest;
      const session = this.sessions.get(id);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      session.write(input);
      return { success: true };
    });

    // Resize session terminal
    this.app.post('/api/sessions/:id/resize', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const { cols, rows } = req.body as ResizeRequest;
      const session = this.sessions.get(id);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      session.resize(cols, rows);
      return { success: true };
    });

    // Get session terminal buffer (for reconnecting)
    this.app.get('/api/sessions/:id/terminal', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      return {
        terminalBuffer: session.terminalBuffer,
        status: session.status,
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

    // Start respawn controller for a session
    this.app.post('/api/sessions/:id/respawn/start', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as Partial<RespawnConfig> | undefined;
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      // Create or get existing controller
      let controller = this.respawnControllers.get(id);
      if (!controller) {
        controller = new RespawnController(session, body);
        this.respawnControllers.set(id, controller);
        this.setupRespawnListeners(id, controller);
      } else if (body) {
        controller.updateConfig(body);
      }

      controller.start();
      this.broadcast('respawn:started', { sessionId: id, status: controller.getStatus() });

      return { success: true, status: controller.getStatus() };
    });

    // Stop respawn controller for a session
    this.app.post('/api/sessions/:id/respawn/stop', async (req) => {
      const { id } = req.params as { id: string };
      const controller = this.respawnControllers.get(id);

      if (!controller) {
        return { error: 'Respawn controller not found' };
      }

      controller.stop();
      this.broadcast('respawn:stopped', { sessionId: id });

      return { success: true };
    });

    // Update respawn configuration
    this.app.put('/api/sessions/:id/respawn/config', async (req) => {
      const { id } = req.params as { id: string };
      const config = req.body as Partial<RespawnConfig>;
      const controller = this.respawnControllers.get(id);

      if (!controller) {
        return { error: 'Respawn controller not found' };
      }

      controller.updateConfig(config);
      this.broadcast('respawn:configUpdated', { sessionId: id, config: controller.getConfig() });

      return { success: true, config: controller.getConfig() };
    });

    // Start interactive session WITH respawn enabled
    this.app.post('/api/sessions/:id/interactive-respawn', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { respawnConfig?: Partial<RespawnConfig>; durationMinutes?: number } | undefined;
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      if (session.isBusy()) {
        return { error: 'Session is busy' };
      }

      try {
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

        this.broadcast('respawn:started', { sessionId: id, status: controller.getStatus() });

        return {
          success: true,
          message: 'Interactive session with respawn started',
          respawnStatus: controller.getStatus(),
        };
      } catch (err) {
        return { error: (err as Error).message };
      }
    });

    // Enable respawn on an EXISTING interactive session
    this.app.post('/api/sessions/:id/respawn/enable', async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as { config?: Partial<RespawnConfig>; durationMinutes?: number } | undefined;
      const session = this.sessions.get(id);

      if (!session) {
        return { error: 'Session not found' };
      }

      // Check if session is running (has a PID)
      if (!session.pid) {
        return { error: 'Session is not running. Start it first.' };
      }

      // Stop existing controller if any
      const existingController = this.respawnControllers.get(id);
      if (existingController) {
        existingController.stop();
      }

      // Create and start new respawn controller
      const controller = new RespawnController(session, body?.config);
      this.respawnControllers.set(id, controller);
      this.setupRespawnListeners(id, controller);
      controller.start();

      // Set up timed stop if duration specified
      if (body?.durationMinutes && body.durationMinutes > 0) {
        this.setupTimedRespawn(id, body.durationMinutes);
      }

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
        return { error: 'Session not found' };
      }

      session.setAutoClear(body.enabled, body.threshold);
      this.broadcast('session:updated', session.toDetailedState());

      return {
        success: true,
        autoClear: {
          enabled: session.autoClearEnabled,
          threshold: session.autoClearThreshold,
        },
      };
    });

    // Quick run (create session, run prompt, return result, then cleanup)
    this.app.post('/api/run', async (req) => {
      // Prevent unbounded session creation
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        return { success: false, error: `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached.` };
      }

      const { prompt, workingDir } = req.body as QuickRunRequest;
      const dir = workingDir || process.cwd();

      const session = new Session({ workingDir: dir });
      this.sessions.set(session.id, session);
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
        return { success: false, sessionId: session.id, error: (err as Error).message };
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
      if (!existsSync(casesDir)) {
        return [];
      }
      const entries = readdirSync(casesDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => ({
          name: e.name,
          path: join(casesDir, e.name),
          hasClaudeMd: existsSync(join(casesDir, e.name, 'CLAUDE.md')),
        }));
    });

    this.app.post('/api/cases', async (req): Promise<{ success: boolean; case?: { name: string; path: string }; error?: string }> => {
      const { name, description } = req.body as CreateCaseRequest;

      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        return { success: false, error: 'Invalid case name. Use only letters, numbers, hyphens, underscores.' };
      }

      const casePath = join(casesDir, name);

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
        return { success: false, error: (err as Error).message };
      }
    });

    this.app.get('/api/cases/:name', async (req) => {
      const { name } = req.params as { name: string };
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

      const { caseName = 'testcase' } = req.body as QuickStartRequest;

      // Validate case name
      if (!/^[a-zA-Z0-9_-]+$/.test(caseName)) {
        return { success: false, error: 'Invalid case name. Use only letters, numbers, hyphens, underscores.' };
      }

      const casePath = join(casesDir, caseName);

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
          return { success: false, error: `Failed to create case: ${(err as Error).message}` };
        }
      }

      // Create a new session with the case as working directory
      const session = new Session({
        workingDir: casePath,
        screenManager: this.screenManager,
        useScreen: true
      });
      this.sessions.set(session.id, session);
      this.setupSessionListeners(session);
      this.broadcast('session:created', session.toDetailedState());

      // Start interactive mode
      try {
        await session.startInteractive();
        this.broadcast('session:interactive', { id: session.id });
        this.broadcast('session:updated', { session: session.toDetailedState() });

        return {
          success: true,
          sessionId: session.id,
          casePath,
          caseName,
        };
      } catch (err) {
        // Clean up session on error to prevent orphaned resources
        await this.cleanupSession(session.id);
        return { success: false, error: (err as Error).message };
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
        return { error: (err as Error).message };
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

    // Stop session and remove listeners
    if (session) {
      session.removeAllListeners();
      await session.stop(killScreen);
      this.sessions.delete(sessionId);
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
    });

    session.on('exit', (code) => {
      this.broadcast('session:exit', { id: session.id, code });
      this.broadcast('session:updated', session.toDetailedState());

      // Clean up respawn controller when session exits
      const controller = this.respawnControllers.get(session.id);
      if (controller) {
        controller.stop();
        this.respawnControllers.delete(session.id);
      }
    });

    session.on('working', () => {
      this.broadcast('session:working', { id: session.id });
    });

    session.on('idle', () => {
      this.broadcast('session:idle', { id: session.id });
      this.broadcast('session:updated', session.toDetailedState());
    });

    // Background task events
    session.on('taskCreated', (task: BackgroundTask) => {
      this.broadcast('task:created', { sessionId: session.id, task });
      this.broadcast('session:updated', session.toDetailedState());
    });

    session.on('taskUpdated', (task: BackgroundTask) => {
      // Use batching for better performance at high update rates
      this.batchTaskUpdate(session.id, task);
    });

    session.on('taskCompleted', (task: BackgroundTask) => {
      this.broadcast('task:completed', { sessionId: session.id, task });
      this.broadcast('session:updated', session.toDetailedState());
    });

    session.on('taskFailed', (task: BackgroundTask, error: string) => {
      this.broadcast('task:failed', { sessionId: session.id, task, error });
      this.broadcast('session:updated', session.toDetailedState());
    });

    session.on('autoClear', (data: { tokens: number; threshold: number }) => {
      this.broadcast('session:autoClear', { sessionId: session.id, ...data });
      this.broadcast('session:updated', session.toDetailedState());
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
        addLog(`Error: ${(err as Error).message}`);
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

    if (run.sessionId) {
      const session = this.sessions.get(run.sessionId);
      if (session) {
        await session.stop();
      }
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

  private broadcast(event: string, data: unknown): void {
    for (const client of this.sseClients) {
      this.sendSSE(client, event, data);
    }
  }

  // Batch terminal data for better performance (60fps)
  private batchTerminalData(sessionId: string, data: string): void {
    const existing = this.terminalBatches.get(sessionId) || '';
    this.terminalBatches.set(sessionId, existing + data);

    // Start batch timer if not already running
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

  async start(): Promise<void> {
    await this.setupRoutes();
    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    console.log(`Claudeman web interface running at http://localhost:${this.port}`);

    // Start scheduled runs cleanup timer
    this.scheduledCleanupTimer = setInterval(() => {
      this.cleanupScheduledRuns();
    }, SCHEDULED_CLEANUP_INTERVAL);

    // Restore screen sessions from previous run
    await this.restoreScreenSessions();
  }

  private async restoreScreenSessions(): Promise<void> {
    try {
      // Reconcile screens to find which ones are still alive
      const { alive, dead } = await this.screenManager.reconcileScreens();

      if (alive.length > 0) {
        console.log(`[Server] Found ${alive.length} alive screen session(s) from previous run`);

        // For each alive screen, create a Session object if it doesn't exist
        const screens = this.screenManager.getScreens();
        for (const screen of screens) {
          if (!this.sessions.has(screen.sessionId)) {
            // Create a session object for this screen
            const session = new Session({
              id: screen.sessionId,  // Preserve the original session ID
              workingDir: screen.workingDir,
              mode: screen.mode,
              name: screen.name || screen.screenName,
              screenManager: this.screenManager,
              useScreen: true
            });

            this.sessions.set(session.id, session);
            this.setupSessionListeners(session);

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

    // Clear scheduled cleanup timer
    if (this.scheduledCleanupTimer) {
      clearInterval(this.scheduledCleanupTimer);
      this.scheduledCleanupTimer = null;
    }

    // Stop screen stats collection
    this.screenManager.stopStatsCollection();

    // Stop all respawn controllers
    for (const controller of this.respawnControllers.values()) {
      controller.stop();
    }
    this.respawnControllers.clear();

    // Stop all sessions
    for (const session of this.sessions.values()) {
      await session.stop();
    }

    // Stop all scheduled runs
    for (const [id] of this.scheduledRuns) {
      await this.stopScheduledRun(id);
    }

    await this.app.close();
  }
}

export async function startWebServer(port: number = 3000): Promise<WebServer> {
  const server = new WebServer(port);
  await server.start();
  return server;
}
