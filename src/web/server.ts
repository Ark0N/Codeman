import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Session, ClaudeMessage } from '../session.js';
import { RespawnController, RespawnConfig, RespawnState } from '../respawn-controller.js';
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

export class WebServer extends EventEmitter {
  private app: FastifyInstance;
  private sessions: Map<string, Session> = new Map();
  private respawnControllers: Map<string, RespawnController> = new Map();
  private scheduledRuns: Map<string, ScheduledRun> = new Map();
  private sseClients: Set<FastifyReply> = new Set();
  private store = getStore();
  private port: number;
  // Terminal batching for performance
  private terminalBatches: Map<string, string> = new Map();
  private terminalBatchTimer: NodeJS.Timeout | null = null;

  constructor(port: number = 3000) {
    super();
    this.port = port;
    this.app = Fastify({ logger: false });
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
      const body = req.body as CreateSessionRequest;
      const workingDir = body.workingDir || process.cwd();
      const session = new Session({ workingDir });

      this.sessions.set(session.id, session);
      this.setupSessionListeners(session);

      this.broadcast('session:created', session.toDetailedState());
      return { success: true, session: session.toDetailedState() };
    });

    this.app.delete('/api/sessions/:id', async (req): Promise<ApiResponse> => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Stop respawn controller first
      const controller = this.respawnControllers.get(id);
      if (controller) {
        controller.stop();
        this.respawnControllers.delete(id);
      }

      await session.stop();
      this.sessions.delete(id);
      this.terminalBatches.delete(id);
      this.broadcast('session:deleted', { id });
      return { success: true };
    });

    // Kill all sessions at once
    this.app.delete('/api/sessions', async (): Promise<ApiResponse<{ killed: number }>> => {
      const sessionIds = Array.from(this.sessions.keys());
      let killed = 0;

      for (const id of sessionIds) {
        const session = this.sessions.get(id);
        if (session) {
          // Stop respawn controller first
          const controller = this.respawnControllers.get(id);
          if (controller) {
            controller.stop();
            this.respawnControllers.delete(id);
          }

          await session.stop();
          this.sessions.delete(id);
          this.terminalBatches.delete(id);
          this.broadcast('session:deleted', { id });
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
        return { success: true, message: 'Interactive session started' };
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
      const body = req.body as { respawnConfig?: Partial<RespawnConfig> } | undefined;
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

        // Create and start respawn controller
        const controller = new RespawnController(session, body?.respawnConfig);
        this.respawnControllers.set(id, controller);
        this.setupRespawnListeners(id, controller);
        controller.start();

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

    // Quick run (create session, run prompt, return result)
    this.app.post('/api/run', async (req) => {
      const { prompt, workingDir } = req.body as QuickRunRequest;
      const dir = workingDir || process.cwd();

      const session = new Session({ workingDir: dir });
      this.sessions.set(session.id, session);
      this.setupSessionListeners(session);

      this.broadcast('session:created', session.toDetailedState());

      try {
        const result = await session.runPrompt(prompt);
        return { success: true, sessionId: session.id, ...result };
      } catch (err) {
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

        const claudeMd = generateClaudeMd(name, description || '');
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

          const claudeMd = generateClaudeMd(caseName, '');
          writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

          this.broadcast('case:created', { name: caseName, path: casePath });
        } catch (err) {
          return { success: false, error: `Failed to create case: ${(err as Error).message}` };
        }
      }

      // Create a new session with the case as working directory
      const session = new Session({ workingDir: casePath });
      this.sessions.set(session.id, session);
      this.setupSessionListeners(session);
      this.broadcast('session:created', session.toDetailedState());

      // Start interactive mode
      try {
        await session.startInteractive();
        this.broadcast('session:interactive', { id: session.id });

        return {
          success: true,
          sessionId: session.id,
          casePath,
          caseName,
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });
  }

  private setupSessionListeners(session: Session): void {
    session.on('output', (data) => {
      this.broadcast('session:output', { id: session.id, data });
    });

    session.on('terminal', (data) => {
      // Use batching for better performance at high throughput
      this.batchTerminalData(session.id, data);
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
      try {
        // Create a session for this iteration
        const session = new Session({ workingDir: run.workingDir });
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

        // Small pause between iterations
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        addLog(`Error: ${(err as Error).message}`);
        this.broadcast('scheduled:updated', run);
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

  async start(): Promise<void> {
    await this.setupRoutes();
    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    console.log(`Claudeman web interface running at http://localhost:${this.port}`);
  }

  async stop(): Promise<void> {
    // Clear batch timer
    if (this.terminalBatchTimer) {
      clearTimeout(this.terminalBatchTimer);
      this.terminalBatchTimer = null;
    }
    this.terminalBatches.clear();

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
