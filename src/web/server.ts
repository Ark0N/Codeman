import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Session, ClaudeMessage } from '../session.js';
import { getStore } from '../state-store.js';
import { v4 as uuidv4 } from 'uuid';

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

export class WebServer extends EventEmitter {
  private app: FastifyInstance;
  private sessions: Map<string, Session> = new Map();
  private scheduledRuns: Map<string, ScheduledRun> = new Map();
  private sseClients: Set<FastifyReply> = new Set();
  private store = getStore();
  private port: number;

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

    this.app.post('/api/sessions', async (req) => {
      const body = req.body as { workingDir?: string };
      const workingDir = body.workingDir || process.cwd();
      const session = new Session({ workingDir });

      this.sessions.set(session.id, session);
      this.setupSessionListeners(session);

      this.broadcast('session:created', session.toDetailedState());
      return { success: true, session: session.toDetailedState() };
    });

    this.app.delete('/api/sessions/:id', async (req) => {
      const { id } = req.params as { id: string };
      const session = this.sessions.get(id);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      await session.stop();
      this.sessions.delete(id);
      this.broadcast('session:deleted', { id });
      return { success: true };
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
    this.app.post('/api/sessions/:id/run', async (req) => {
      const { id } = req.params as { id: string };
      const { prompt } = req.body as { prompt: string };
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

    // Quick run (create session, run prompt, return result)
    this.app.post('/api/run', async (req) => {
      const { prompt, workingDir } = req.body as { prompt: string; workingDir?: string };
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

    this.app.post('/api/scheduled', async (req) => {
      const { prompt, workingDir, durationMinutes } = req.body as {
        prompt: string;
        workingDir?: string;
        durationMinutes: number;
      };

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
  }

  private setupSessionListeners(session: Session): void {
    session.on('output', (data) => {
      this.broadcast('session:output', { id: session.id, data });
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
    return {
      sessions: this.getSessionsState(),
      scheduledRuns: Array.from(this.scheduledRuns.values()),
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

  async start(): Promise<void> {
    await this.setupRoutes();
    await this.app.listen({ port: this.port, host: '0.0.0.0' });
    console.log(`Claudeman web interface running at http://localhost:${this.port}`);
  }

  async stop(): Promise<void> {
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
