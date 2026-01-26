/**
 * @fileoverview Spawn Orchestrator - Full lifecycle management for spawned agents.
 *
 * Manages:
 * - Agent creation from task spec files
 * - Directory setup (CLAUDE.md, comms, workspace)
 * - Session spawning via screen
 * - Progress monitoring and timeout enforcement
 * - Resource governance (tokens, cost, depth)
 * - Bidirectional communication
 * - Result collection and cleanup
 * - Queue management with priority ordering
 *
 * @module spawn-orchestrator
 */

import { EventEmitter } from 'node:events';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import {
  type SpawnOrchestratorConfig,
  type SpawnTask,
  type AgentContext,
  type AgentProgress,
  type AgentStatusReport,
  type SpawnResult,
  type SpawnTrackerState,
  type SpawnMessage,
  type SpawnPersistedState,
  createDefaultOrchestratorConfig,
  createEmptyAgentProgress,
  parseTaskSpecFile,
  parseSpawnResult,
  MAX_TASK_FILE_SIZE,
  MAX_CONTEXT_FILE_SIZE,
  MAX_CONTEXT_FILES,
  MAX_QUEUE_LENGTH,
  BUDGET_WARNING_THRESHOLD,
  MESSAGE_MAX_SIZE,
  MAX_MESSAGES_PER_CHANNEL,
  MAX_TRACKED_AGENTS,
} from './spawn-types.js';
import { generateAgentClaudeMd, buildInitialPrompt } from './spawn-claude-md.js';
import { getErrorMessage } from './types.js';

// ========== Types for integration ==========

/**
 * Interface for session creation callback.
 * The orchestrator delegates session creation to the server to avoid circular deps.
 */
export interface SessionCreator {
  createAgentSession(workingDir: string, name: string): Promise<{ sessionId: string }>;
  writeToSession(sessionId: string, data: string): void;
  getSessionTokens(sessionId: string): number;
  getSessionCost(sessionId: string): number;
  stopSession(sessionId: string): Promise<void>;
  onSessionCompletion(sessionId: string, handler: (phrase: string) => void): void;
  removeSessionCompletionHandler(sessionId: string, handler: (phrase: string) => void): void;
}

// ========== Events ==========

export interface SpawnOrchestratorEvents {
  /** Agent added to queue */
  queued: (data: { agentId: string; name: string; parentSessionId: string; position: number }) => void;
  /** Agent directory being set up */
  initializing: (data: { agentId: string; name: string; workingDir: string }) => void;
  /** Agent session started */
  started: (data: { agentId: string; name: string; sessionId: string }) => void;
  /** Agent progress update */
  progress: (data: { agentId: string; progress: AgentProgress }) => void;
  /** New message in channel */
  message: (data: { agentId: string; message: SpawnMessage }) => void;
  /** Agent completed successfully */
  completed: (data: { agentId: string; result: SpawnResult }) => void;
  /** Agent failed */
  failed: (data: { agentId: string; error: string; partialProgress: AgentProgress | null }) => void;
  /** Agent timed out */
  timeout: (data: { agentId: string; elapsed: number; limit: number }) => void;
  /** Agent cancelled */
  cancelled: (data: { agentId: string; reason: string }) => void;
  /** Budget warning */
  budgetWarning: (data: { agentId: string; type: 'tokens' | 'cost'; used: number; limit: number }) => void;
  /** Overall state changed */
  stateUpdate: (state: SpawnTrackerState) => void;
}

/**
 * SpawnOrchestrator - Manages the full lifecycle of spawned agents.
 *
 * Handles agent creation, monitoring, communication, resource governance,
 * and cleanup. Integrates with Session, ScreenManager, and RalphTracker.
 */
export class SpawnOrchestrator extends EventEmitter {
  private _agents: Map<string, AgentContext> = new Map();
  private _completedAgents: Map<string, AgentContext> = new Map();
  private _queue: SpawnTask[] = [];
  private _config: SpawnOrchestratorConfig;
  private _sessionCreator: SessionCreator | null = null;
  private _totalSpawned: number = 0;
  private _totalCompleted: number = 0;
  private _totalFailed: number = 0;
  private _maxDepthReached: number = 0;
  private _completionHandlers: Map<string, (phrase: string) => void> = new Map();

  constructor(config?: Partial<SpawnOrchestratorConfig>) {
    super();
    this._config = { ...createDefaultOrchestratorConfig(), ...config };
  }

  /**
   * Set the session creator callback.
   * Must be called before any spawn requests can be processed.
   */
  setSessionCreator(creator: SessionCreator): void {
    this._sessionCreator = creator;
  }

  /**
   * Get current orchestrator configuration.
   */
  get config(): SpawnOrchestratorConfig {
    return { ...this._config };
  }

  /**
   * Update orchestrator configuration.
   */
  updateConfig(config: Partial<SpawnOrchestratorConfig>): void {
    Object.assign(this._config, config);
  }

  /**
   * Handle a spawn request detected from terminal output.
   *
   * @param filePath - Path to the task spec file (relative to parent's workingDir)
   * @param parentSessionId - ID of the parent session
   * @param parentWorkingDir - Working directory of the parent session
   * @param parentDepth - Depth of the parent in the spawn tree
   */
  async handleSpawnRequest(
    filePath: string,
    parentSessionId: string,
    parentWorkingDir: string,
    parentDepth: number = 0
  ): Promise<void> {
    if (!this._sessionCreator) {
      console.error('[spawn-orchestrator] No session creator set, cannot spawn agent');
      return;
    }

    // Resolve file path relative to parent's working directory
    const resolvedPath = isAbsolute(filePath) ? filePath : join(parentWorkingDir, filePath);

    // Validate file exists and size
    if (!existsSync(resolvedPath)) {
      console.error(`[spawn-orchestrator] Task file not found: ${resolvedPath}`);
      this.emit('failed', { agentId: 'unknown', error: `Task file not found: ${resolvedPath}`, partialProgress: null });
      return;
    }

    const stat = statSync(resolvedPath);
    if (stat.size > MAX_TASK_FILE_SIZE) {
      console.error(`[spawn-orchestrator] Task file too large: ${stat.size} bytes (max ${MAX_TASK_FILE_SIZE})`);
      this.emit('failed', { agentId: 'unknown', error: `Task file too large: ${stat.size} bytes`, partialProgress: null });
      return;
    }

    // Parse task file
    const content = readFileSync(resolvedPath, 'utf-8');
    const fallbackId = `agent-${uuidv4().slice(0, 8)}`;
    const parsed = parseTaskSpecFile(content, fallbackId);

    if (!parsed) {
      console.error(`[spawn-orchestrator] Failed to parse task file: ${resolvedPath}`);
      this.emit('failed', { agentId: fallbackId, error: 'Failed to parse task spec YAML frontmatter', partialProgress: null });
      return;
    }

    const childDepth = parentDepth + 1;

    // Depth check
    if (childDepth > this._config.maxSpawnDepth) {
      console.error(`[spawn-orchestrator] Max spawn depth (${this._config.maxSpawnDepth}) exceeded at depth ${childDepth}`);
      this.emit('failed', { agentId: parsed.spec.agentId, error: `Max spawn depth exceeded (${this._config.maxSpawnDepth})`, partialProgress: null });
      return;
    }

    // Enforce timeout limits
    if (parsed.spec.timeoutMinutes > this._config.maxTimeoutMinutes) {
      parsed.spec.timeoutMinutes = this._config.maxTimeoutMinutes;
    }

    const task: SpawnTask = {
      spec: parsed.spec,
      instructions: parsed.instructions,
      sourceFile: resolvedPath,
      parentSessionId,
      depth: childDepth,
    };

    // Check dependencies
    if (task.spec.dependsOn && task.spec.dependsOn.length > 0) {
      const unmetDeps = task.spec.dependsOn.filter(depId => {
        const dep = this._completedAgents.get(depId);
        return !dep || dep.status !== 'completed';
      });
      if (unmetDeps.length > 0) {
        // Queue with dependency tracking
        this.enqueueTask(task);
        return;
      }
    }

    // Concurrency check
    const activeCount = this.getActiveCount();
    if (activeCount >= this._config.maxConcurrentAgents) {
      this.enqueueTask(task);
      return;
    }

    // Spawn immediately
    await this.spawnAgent(task);
  }

  /**
   * Cancel an agent by ID.
   * Cascades cancellation to all child agents before cleaning up the parent.
   */
  async cancelAgent(agentId: string, reason: string = 'Cancelled by parent'): Promise<void> {
    const agent = this._agents.get(agentId);
    if (!agent) {
      // Check queue
      const queueIdx = this._queue.findIndex(t => t.spec.agentId === agentId);
      if (queueIdx >= 0) {
        this._queue.splice(queueIdx, 1);
        this.emit('cancelled', { agentId, reason: 'Removed from queue' });
        this.emitStateUpdate();
      }
      return;
    }

    // Cancel all child agents first (cascade)
    // Child agents have their parentSessionId set to this agent's sessionId
    if (agent.sessionId) {
      for (const [childId, childAgent] of this._agents) {
        if (childAgent.parentSessionId === agent.sessionId && childAgent.status !== 'cancelled') {
          await this.cancelAgent(childId, `Parent ${agentId} cancelled`);
        }
      }
    }

    // Also remove any queued tasks that depend on this agent's session
    if (agent.sessionId) {
      const queuedChildren = this._queue.filter(t => t.parentSessionId === agent.sessionId);
      for (const task of queuedChildren) {
        const idx = this._queue.indexOf(task);
        if (idx >= 0) {
          this._queue.splice(idx, 1);
          this.emit('cancelled', { agentId: task.spec.agentId, reason: `Parent ${agentId} cancelled` });
        }
      }
    }

    agent.status = 'cancelled';
    this.emit('cancelled', { agentId, reason });

    await this.cleanupAgent(agentId);
  }

  /**
   * Send a message to an agent.
   */
  async sendMessageToAgent(agentId: string, content: string): Promise<void> {
    const agent = this._agents.get(agentId);
    if (!agent) return;

    if (content.length > MESSAGE_MAX_SIZE) {
      content = content.slice(0, MESSAGE_MAX_SIZE);
    }

    const messagesDir = join(agent.commsDir, 'messages');
    if (!existsSync(messagesDir)) {
      mkdirSync(messagesDir, { recursive: true });
    }

    // Count existing messages
    const existingMessages = readdirSync(messagesDir).filter(f => f.endsWith('.md'));
    if (existingMessages.length >= MAX_MESSAGES_PER_CHANNEL) {
      return; // Channel full
    }

    const seq = existingMessages.length + 1;
    const seqStr = String(seq).padStart(3, '0');
    const fileName = `${seqStr}-parent.md`;

    const message: SpawnMessage = {
      sequence: seq,
      sender: 'parent',
      content,
      sentAt: Date.now(),
      read: false,
    };

    writeFileSync(join(messagesDir, fileName), content, 'utf-8');
    this.emit('message', { agentId, message });
  }

  /**
   * Get status of a specific agent.
   */
  getAgentStatus(agentId: string): AgentStatusReport | null {
    const agent = this._agents.get(agentId) || this._completedAgents.get(agentId);
    if (!agent) return null;
    return this.buildStatusReport(agent);
  }

  /**
   * Get status of all agents (active + recently completed).
   */
  getAllAgentStatuses(): AgentStatusReport[] {
    const reports: AgentStatusReport[] = [];
    for (const agent of this._agents.values()) {
      reports.push(this.buildStatusReport(agent));
    }
    for (const agent of this._completedAgents.values()) {
      reports.push(this.buildStatusReport(agent));
    }
    return reports;
  }

  /**
   * Get current orchestrator state.
   */
  getState(): SpawnTrackerState {
    return {
      enabled: true,
      activeCount: this.getActiveCount(),
      queuedCount: this._queue.length,
      totalSpawned: this._totalSpawned,
      totalCompleted: this._totalCompleted,
      totalFailed: this._totalFailed,
      maxDepthReached: this._maxDepthReached,
      agents: this.getAllAgentStatuses(),
    };
  }

  /**
   * Get state for persistence.
   */
  getPersistedState(): SpawnPersistedState {
    const agents: SpawnPersistedState['agents'] = {};
    for (const [id, agent] of this._agents) {
      agents[id] = {
        agentId: id,
        status: agent.status,
        parentSessionId: agent.parentSessionId,
        childSessionId: agent.sessionId,
        depth: agent.depth,
        startedAt: agent.startedAt,
        commsDir: agent.commsDir,
        workingDir: agent.workingDir,
        completionPhrase: agent.task.spec.completionPhrase,
        timeoutMinutes: agent.task.spec.timeoutMinutes,
      };
    }
    return { config: this._config, agents };
  }

  /**
   * Stop all agents.
   */
  async stopAll(): Promise<void> {
    const agentIds = Array.from(this._agents.keys());
    for (const agentId of agentIds) {
      await this.cancelAgent(agentId, 'Orchestrator shutdown');
    }
    this._queue = [];
  }

  /**
   * Read an agent's result.md file.
   */
  readAgentResult(agentId: string): SpawnResult | null {
    const agent = this._agents.get(agentId) || this._completedAgents.get(agentId);
    if (!agent) return null;

    const resultPath = join(agent.commsDir, 'result.md');
    if (!existsSync(resultPath)) return null;

    const content = readFileSync(resultPath, 'utf-8');
    const durationMs = agent.startedAt ? Date.now() - agent.startedAt : 0;
    return parseSpawnResult(content, agentId, durationMs);
  }

  /**
   * Read an agent's progress.json file.
   */
  readAgentProgress(agentId: string): AgentProgress | null {
    const agent = this._agents.get(agentId) || this._completedAgents.get(agentId);
    if (!agent) return null;

    const progressPath = join(agent.commsDir, 'progress.json');
    if (!existsSync(progressPath)) return null;

    try {
      const content = readFileSync(progressPath, 'utf-8');
      return JSON.parse(content) as AgentProgress;
    } catch {
      return null;
    }
  }

  /**
   * Read messages from an agent's communication channel.
   */
  readAgentMessages(agentId: string): SpawnMessage[] {
    const agent = this._agents.get(agentId) || this._completedAgents.get(agentId);
    if (!agent) return [];

    const messagesDir = join(agent.commsDir, 'messages');
    if (!existsSync(messagesDir)) return [];

    const files = readdirSync(messagesDir)
      .filter(f => f.endsWith('.md'))
      .sort();

    const messages: SpawnMessage[] = [];
    for (const file of files) {
      const match = file.match(/^(\d+)-(parent|agent)\.md$/);
      if (!match) continue;

      const content = readFileSync(join(messagesDir, file), 'utf-8');
      messages.push({
        sequence: parseInt(match[1]),
        sender: match[2] as 'parent' | 'agent',
        content,
        sentAt: statSync(join(messagesDir, file)).mtimeMs,
        read: true,
      });
    }

    return messages;
  }

  /**
   * Programmatically trigger a spawn without terminal detection.
   */
  async triggerSpawn(
    taskContent: string,
    parentSessionId: string,
    parentWorkingDir: string,
    parentDepth: number = 0
  ): Promise<string | null> {
    const fallbackId = `agent-${uuidv4().slice(0, 8)}`;
    const parsed = parseTaskSpecFile(taskContent, fallbackId);
    if (!parsed) return null;

    // If the spec doesn't specify a workingDir, use the parent's
    if (!parsed.spec.workingDir) {
      parsed.spec.workingDir = parentWorkingDir;
    }

    // Write task content to a temp file so setupAgentDirectory can read it
    const tempDir = join(this._config.casesDir, '.spawn-tmp');
    mkdirSync(tempDir, { recursive: true });
    const tempFile = join(tempDir, `${parsed.spec.agentId}.md`);
    writeFileSync(tempFile, taskContent, 'utf-8');

    const task: SpawnTask = {
      spec: parsed.spec,
      instructions: parsed.instructions,
      sourceFile: tempFile,
      parentSessionId,
      depth: parentDepth + 1,
    };

    await this.spawnAgent(task);
    return task.spec.agentId;
  }

  // ========== Internal Methods ==========

  private getActiveCount(): number {
    let count = 0;
    for (const agent of this._agents.values()) {
      if (agent.status === 'initializing' || agent.status === 'running') {
        count++;
      }
    }
    return count;
  }

  private enqueueTask(task: SpawnTask): void {
    if (this._queue.length >= MAX_QUEUE_LENGTH) {
      this.emit('failed', {
        agentId: task.spec.agentId,
        error: `Queue full (max ${MAX_QUEUE_LENGTH})`,
        partialProgress: null,
      });
      return;
    }

    // Insert by priority (higher priority first)
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    const taskPriority = priorityOrder[task.spec.priority];
    let insertIdx = this._queue.length;
    for (let i = 0; i < this._queue.length; i++) {
      if (priorityOrder[this._queue[i].spec.priority] > taskPriority) {
        insertIdx = i;
        break;
      }
    }
    this._queue.splice(insertIdx, 0, task);

    this.emit('queued', {
      agentId: task.spec.agentId,
      name: task.spec.name,
      parentSessionId: task.parentSessionId,
      position: insertIdx + 1,
    });
    this.emitStateUpdate();
  }

  private async spawnAgent(task: SpawnTask): Promise<void> {
    if (!this._sessionCreator) return;

    const agentId = task.spec.agentId;
    this._totalSpawned++;
    if (task.depth > this._maxDepthReached) {
      this._maxDepthReached = task.depth;
    }

    // Create agent context
    const workingDir = join(this._config.casesDir, `spawn-${agentId}`);
    const commsDir = join(workingDir, 'spawn-comms');

    const agent: AgentContext = {
      task,
      sessionId: null,
      workingDir,
      commsDir,
      parentSessionId: task.parentSessionId,
      depth: task.depth,
      timeoutTimer: null,
      warningTimer: null,
      progressTimer: null,
      status: 'initializing',
      startedAt: null,
      tokenBudget: task.spec.maxTokens ?? null,
      costBudget: task.spec.maxCost ?? null,
    };

    this._agents.set(agentId, agent);
    this.emit('initializing', { agentId, name: task.spec.name, workingDir });
    this.emitStateUpdate();

    try {
      // Setup directory structure
      this.setupAgentDirectory(task, workingDir, commsDir);

      // Create session
      const { sessionId } = await this._sessionCreator.createAgentSession(workingDir, agentId);
      agent.sessionId = sessionId;
      agent.status = 'running';
      agent.startedAt = Date.now();

      this.emit('started', { agentId, name: task.spec.name, sessionId });
      this.emitStateUpdate();

      // Setup completion listener
      this.setupCompletionListener(agent);

      // Setup progress monitor
      this.setupProgressMonitor(agent);

      // Setup timeout
      this.setupTimeout(agent);

      // Inject initial prompt (short delay to let session initialize)
      setTimeout(() => {
        if (agent.status === 'running' && this._sessionCreator) {
          const prompt = buildInitialPrompt(task);
          this._sessionCreator.writeToSession(sessionId, prompt + '\r');
        }
      }, 3000);

    } catch (err) {
      agent.status = 'failed';
      this._totalFailed++;
      this.emit('failed', { agentId, error: getErrorMessage(err), partialProgress: null });
      await this.cleanupAgent(agentId);
    }
  }

  private setupAgentDirectory(task: SpawnTask, workingDir: string, commsDir: string): void {
    // Create directory structure
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(commsDir, { recursive: true });
    mkdirSync(join(commsDir, 'messages'), { recursive: true });
    mkdirSync(join(commsDir, 'artifacts'), { recursive: true });
    mkdirSync(join(workingDir, 'workspace'), { recursive: true });

    // Copy task.md to comms
    writeFileSync(join(commsDir, 'task.md'), readFileSync(task.sourceFile, 'utf-8'), 'utf-8');

    // Write initial progress.json
    writeFileSync(
      join(commsDir, 'progress.json'),
      JSON.stringify(createEmptyAgentProgress(), null, 2),
      'utf-8'
    );

    // Generate and write CLAUDE.md
    const claudeMd = generateAgentClaudeMd(task, commsDir, workingDir);
    writeFileSync(join(workingDir, 'CLAUDE.md'), claudeMd, 'utf-8');

    // Symlink context files into workspace
    if (task.spec.contextFiles && task.spec.contextFiles.length > 0) {
      const parentWorkingDir = this.resolveParentWorkingDir(task);
      let fileCount = 0;

      for (const contextFile of task.spec.contextFiles) {
        if (fileCount >= MAX_CONTEXT_FILES) break;

        const sourcePath = isAbsolute(contextFile)
          ? contextFile
          : join(parentWorkingDir, contextFile);

        if (!existsSync(sourcePath)) continue;

        const stat = statSync(sourcePath);
        if (stat.size > MAX_CONTEXT_FILE_SIZE) continue;

        const destPath = join(workingDir, 'workspace', contextFile.split('/').pop() || contextFile);
        try {
          symlinkSync(sourcePath, destPath);
          fileCount++;
        } catch {
          // Ignore symlink errors (e.g., dest already exists)
        }
      }
    }
  }

  private resolveParentWorkingDir(task: SpawnTask): string {
    // If the task has a specified workingDir, resolve it
    if (task.spec.workingDir) {
      return isAbsolute(task.spec.workingDir)
        ? task.spec.workingDir
        : resolve(this._config.casesDir, task.spec.workingDir);
    }
    // Default: use casesDir
    return this._config.casesDir;
  }

  private setupCompletionListener(agent: AgentContext): void {
    if (!this._sessionCreator || !agent.sessionId) return;

    const handler = (phrase: string) => {
      if (phrase === agent.task.spec.completionPhrase) {
        this.handleAgentCompletion(agent);
      }
    };

    this._completionHandlers.set(agent.task.spec.agentId, handler);
    this._sessionCreator.onSessionCompletion(agent.sessionId, handler);
  }

  private setupProgressMonitor(agent: AgentContext): void {
    if (this._config.progressPollIntervalMs <= 0) return;

    agent.progressTimer = setInterval(() => {
      if (agent.status !== 'running') return;

      // Read progress
      const progress = this.readAgentProgress(agent.task.spec.agentId);
      if (progress) {
        this.emit('progress', { agentId: agent.task.spec.agentId, progress });
      }

      // Check resource budgets
      this.checkResourceBudgets(agent);
    }, this._config.progressPollIntervalMs);
  }

  private setupTimeout(agent: AgentContext): void {
    const timeoutMs = agent.task.spec.timeoutMinutes * 60 * 1000;

    // Warning at 90% - store timer for cleanup
    const warningMs = timeoutMs * 0.9;
    agent.warningTimer = setTimeout(() => {
      if (agent.status === 'running' && this._sessionCreator && agent.sessionId) {
        this._sessionCreator.writeToSession(
          agent.sessionId,
          'WARNING: You have less than 10% of your timeout remaining. Please wrap up and write your result.md soon.\r'
        );
      }
    }, warningMs);

    // Hard timeout
    agent.timeoutTimer = setTimeout(() => {
      if (agent.status === 'running') {
        this.handleAgentTimeout(agent);
      }
    }, timeoutMs);
  }

  private checkResourceBudgets(agent: AgentContext): void {
    if (!this._sessionCreator || !agent.sessionId) return;

    // Token budget
    if (agent.tokenBudget !== null) {
      const tokensUsed = this._sessionCreator.getSessionTokens(agent.sessionId);
      const ratio = tokensUsed / agent.tokenBudget;

      if (ratio >= 1.1) {
        // Force kill at 110%
        this.handleAgentTimeout(agent);
        return;
      } else if (ratio >= 1.0) {
        // Graceful shutdown
        this._sessionCreator.writeToSession(
          agent.sessionId,
          'You have exceeded your token budget. Write your result.md NOW and output your completion phrase.\r'
        );
      } else if (ratio >= BUDGET_WARNING_THRESHOLD) {
        this.emit('budgetWarning', {
          agentId: agent.task.spec.agentId,
          type: 'tokens',
          used: tokensUsed,
          limit: agent.tokenBudget,
        });
      }
    }

    // Cost budget
    if (agent.costBudget !== null) {
      const costUsed = this._sessionCreator.getSessionCost(agent.sessionId);
      const ratio = costUsed / agent.costBudget;

      if (ratio >= 1.1) {
        this.handleAgentTimeout(agent);
        return;
      } else if (ratio >= 1.0) {
        this._sessionCreator.writeToSession(
          agent.sessionId,
          'You have exceeded your cost budget. Write your result.md NOW and output your completion phrase.\r'
        );
      } else if (ratio >= BUDGET_WARNING_THRESHOLD) {
        this.emit('budgetWarning', {
          agentId: agent.task.spec.agentId,
          type: 'cost',
          used: costUsed,
          limit: agent.costBudget,
        });
      }
    }
  }

  private async handleAgentCompletion(agent: AgentContext): Promise<void> {
    if (agent.status !== 'running') return;

    agent.status = 'completing';
    this._totalCompleted++;

    // Read result
    const result = this.readAgentResult(agent.task.spec.agentId);
    if (result) {
      // Update token/cost from session
      if (this._sessionCreator && agent.sessionId) {
        result.tokens.total = this._sessionCreator.getSessionTokens(agent.sessionId);
        result.cost = this._sessionCreator.getSessionCost(agent.sessionId);
      }
      this.emit('completed', { agentId: agent.task.spec.agentId, result });
    } else {
      // No result file found, create a minimal one
      const minimalResult: SpawnResult = {
        status: 'completed',
        durationMs: agent.startedAt ? Date.now() - agent.startedAt : 0,
        tokens: { input: 0, output: 0, total: 0 },
        cost: 0,
        summary: 'Agent completed but no result.md was found',
        output: '',
        filesChanged: [],
        agentId: agent.task.spec.agentId,
        completedAt: Date.now(),
      };
      this.emit('completed', { agentId: agent.task.spec.agentId, result: minimalResult });
    }

    agent.status = 'completed';
    await this.cleanupAgent(agent.task.spec.agentId);
    this.processQueue();
  }

  private async handleAgentTimeout(agent: AgentContext): Promise<void> {
    if (agent.status !== 'running') return;

    agent.status = 'timeout';
    this._totalFailed++;

    const elapsed = agent.startedAt ? Date.now() - agent.startedAt : 0;
    const limit = agent.task.spec.timeoutMinutes * 60 * 1000;

    this.emit('timeout', { agentId: agent.task.spec.agentId, elapsed, limit });
    await this.cleanupAgent(agent.task.spec.agentId);
    this.processQueue();
  }

  private async cleanupAgent(agentId: string): Promise<void> {
    const agent = this._agents.get(agentId);
    if (!agent) return;

    // Clear timers
    if (agent.timeoutTimer) {
      clearTimeout(agent.timeoutTimer);
      agent.timeoutTimer = null;
    }
    if (agent.warningTimer) {
      clearTimeout(agent.warningTimer);
      agent.warningTimer = null;
    }
    if (agent.progressTimer) {
      clearInterval(agent.progressTimer);
      agent.progressTimer = null;
    }

    // Remove completion handler
    const handler = this._completionHandlers.get(agentId);
    if (handler && this._sessionCreator && agent.sessionId) {
      this._sessionCreator.removeSessionCompletionHandler(agent.sessionId, handler);
      this._completionHandlers.delete(agentId);
    }

    // Stop session
    if (agent.sessionId && this._sessionCreator) {
      try {
        await this._sessionCreator.stopSession(agent.sessionId);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Move to completed (LRU)
    this._agents.delete(agentId);
    this._completedAgents.set(agentId, agent);

    // LRU eviction for completed agents
    if (this._completedAgents.size > MAX_TRACKED_AGENTS) {
      const firstKey = this._completedAgents.keys().next().value;
      if (firstKey) this._completedAgents.delete(firstKey);
    }

    this.emitStateUpdate();
  }

  private processQueue(): void {
    while (this._queue.length > 0 && this.getActiveCount() < this._config.maxConcurrentAgents) {
      const task = this._queue.shift();
      if (!task) break;

      // Re-check dependencies
      if (task.spec.dependsOn && task.spec.dependsOn.length > 0) {
        const unmetDeps = task.spec.dependsOn.filter(depId => {
          const dep = this._completedAgents.get(depId);
          return !dep || dep.status !== 'completed';
        });
        if (unmetDeps.length > 0) {
          // Put back in queue
          this._queue.unshift(task);
          break;
        }
      }

      // Spawn (async, don't await to allow multiple spawns)
      this.spawnAgent(task).catch(err => {
        console.error(`[spawn-orchestrator] Failed to spawn queued agent: ${getErrorMessage(err)}`);
      });
    }
  }

  private buildStatusReport(agent: AgentContext): AgentStatusReport {
    const now = Date.now();
    const elapsed = agent.startedAt ? now - agent.startedAt : 0;
    const timeoutMs = agent.task.spec.timeoutMinutes * 60 * 1000;
    const timeRemaining = agent.startedAt ? Math.max(0, timeoutMs - elapsed) : timeoutMs;

    let tokensUsed = 0;
    let costSoFar = 0;
    if (agent.sessionId && this._sessionCreator) {
      tokensUsed = this._sessionCreator.getSessionTokens(agent.sessionId);
      costSoFar = this._sessionCreator.getSessionCost(agent.sessionId);
    }

    // Check dependency status
    let dependencyStatus: 'waiting' | 'ready' | 'n/a' = 'n/a';
    if (agent.task.spec.dependsOn && agent.task.spec.dependsOn.length > 0) {
      const allMet = agent.task.spec.dependsOn.every(depId => {
        const dep = this._completedAgents.get(depId);
        return dep && dep.status === 'completed';
      });
      dependencyStatus = allMet ? 'ready' : 'waiting';
    }

    return {
      agentId: agent.task.spec.agentId,
      name: agent.task.spec.name,
      type: agent.task.spec.type,
      status: agent.status,
      priority: agent.task.spec.priority,
      parentSessionId: agent.parentSessionId,
      childSessionId: agent.sessionId,
      depth: agent.depth,
      startedAt: agent.startedAt,
      elapsedMs: elapsed,
      progress: this.readAgentProgress(agent.task.spec.agentId),
      tokensUsed,
      costSoFar,
      tokenBudget: agent.tokenBudget,
      costBudget: agent.costBudget,
      timeoutMinutes: agent.task.spec.timeoutMinutes,
      timeRemainingMs: timeRemaining,
      completionPhrase: agent.task.spec.completionPhrase,
      dependsOn: agent.task.spec.dependsOn || [],
      dependencyStatus,
    };
  }

  private emitStateUpdate(): void {
    this.emit('stateUpdate', this.getState());
  }
}
