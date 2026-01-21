/**
 * @fileoverview Ralph Loop - Autonomous task execution engine
 *
 * The Ralph Loop orchestrates autonomous Claude sessions by:
 * - Polling for available tasks from the task queue
 * - Assigning tasks to idle sessions
 * - Monitoring completion and handling failures
 * - Auto-generating follow-up tasks when min duration not reached
 *
 * Named after Ralph Wiggum's persistence ("I'm in danger!"),
 * this loop keeps Claude working until all tasks are done.
 *
 * @module ralph-loop
 */

import { EventEmitter } from 'node:events';
import { getSessionManager, SessionManager } from './session-manager.js';
import { getTaskQueue, TaskQueue } from './task-queue.js';
import { getStore, StateStore } from './state-store.js';
import { Session } from './session.js';
import { Task } from './task.js';
import { RalphLoopStatus } from './types.js';

/**
 * Events emitted by RalphLoop
 */
export interface RalphLoopEvents {
  started: () => void;
  stopped: () => void;
  taskAssigned: (taskId: string, sessionId: string) => void;
  taskCompleted: (taskId: string) => void;
  taskFailed: (taskId: string, error: string) => void;
  error: (error: Error) => void;
}

/**
 * Configuration options for RalphLoop
 */
export interface RalphLoopOptions {
  /** How often to check for new tasks (default from config) */
  pollIntervalMs?: number;
  /** Minimum time to run before stopping (null = no minimum) */
  minDurationMs?: number;
  /** Auto-generate follow-up tasks when queue is empty */
  autoGenerateTasks?: boolean;
}

/**
 * Autonomous task execution loop.
 *
 * @description
 * Manages the lifecycle of task execution:
 * 1. Start: Begin polling and task assignment
 * 2. Run: Assign tasks to idle sessions, monitor completion
 * 3. Stop: When all tasks done and min duration reached
 *
 * Supports time-aware loops that continue generating tasks
 * until a minimum duration is reached.
 *
 * @extends EventEmitter
 */
export class RalphLoop extends EventEmitter {
  private sessionManager: SessionManager;
  private taskQueue: TaskQueue;
  private store: StateStore;
  private pollIntervalMs: number;
  private minDurationMs: number | null;
  private autoGenerateTasks: boolean;
  private loopTimer: NodeJS.Timeout | null = null;
  private _status: RalphLoopStatus = 'stopped';
  private startedAt: number | null = null;
  private tasksCompleted: number = 0;
  private tasksGenerated: number = 0;

  constructor(options: RalphLoopOptions = {}) {
    super();
    this.sessionManager = getSessionManager();
    this.taskQueue = getTaskQueue();
    this.store = getStore();

    const config = this.store.getConfig();
    this.pollIntervalMs = options.pollIntervalMs ?? config.pollIntervalMs;
    this.minDurationMs = options.minDurationMs ?? null;
    this.autoGenerateTasks = options.autoGenerateTasks ?? true;

    // Load state from store
    const savedState = this.store.getRalphLoopState();
    if (savedState.status === 'running') {
      // If we crashed while running, reset to stopped
      this._status = 'stopped';
      this.store.setRalphLoopState({ status: 'stopped' });
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.sessionManager.on('sessionCompletion', (sessionId: string, phrase: string) => {
      this.handleSessionCompletion(sessionId, phrase);
    });

    this.sessionManager.on('sessionError', (sessionId: string, error: string) => {
      this.handleSessionError(sessionId, error);
    });

    this.sessionManager.on('sessionStopped', (sessionId: string) => {
      this.handleSessionStopped(sessionId);
    });
  }

  get status(): RalphLoopStatus {
    return this._status;
  }

  isRunning(): boolean {
    return this._status === 'running';
  }

  getElapsedMs(): number {
    if (!this.startedAt) {
      return 0;
    }
    return Date.now() - this.startedAt;
  }

  getElapsedHours(): number {
    return this.getElapsedMs() / (1000 * 60 * 60);
  }

  isMinDurationReached(): boolean {
    if (!this.minDurationMs) {
      return true;
    }
    return this.getElapsedMs() >= this.minDurationMs;
  }

  getStats() {
    const taskCounts = this.taskQueue.getCount();
    return {
      status: this._status,
      elapsedMs: this.getElapsedMs(),
      elapsedHours: this.getElapsedHours(),
      minDurationMs: this.minDurationMs,
      minDurationReached: this.isMinDurationReached(),
      tasksCompleted: this.tasksCompleted,
      tasksGenerated: this.tasksGenerated,
      ...taskCounts,
      activeSessions: this.sessionManager.getSessionCount(),
      idleSessions: this.sessionManager.getIdleSessions().length,
      busySessions: this.sessionManager.getBusySessions().length,
    };
  }

  /** Starts the task execution loop. */
  async start(): Promise<void> {
    if (this._status === 'running') {
      return;
    }

    this._status = 'running';
    this.startedAt = Date.now();
    this.tasksCompleted = 0;
    this.tasksGenerated = 0;

    this.store.setRalphLoopState({
      status: 'running',
      startedAt: this.startedAt,
      minDurationMs: this.minDurationMs,
      tasksCompleted: 0,
      tasksGenerated: 0,
    });

    this.emit('started');
    this.runLoop();
  }

  /** Stops the task execution loop. */
  stop(): void {
    if (this._status === 'stopped') {
      return;
    }

    this._status = 'stopped';

    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    this.store.setRalphLoopState({
      status: 'stopped',
      lastCheckAt: Date.now(),
    });

    this.emit('stopped');
  }

  /** Pauses the loop (can be resumed). */
  pause(): void {
    if (this._status !== 'running') {
      return;
    }

    this._status = 'paused';

    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    this.store.setRalphLoopState({ status: 'paused' });
  }

  /** Resumes a paused loop. */
  resume(): void {
    if (this._status !== 'paused') {
      return;
    }

    this._status = 'running';
    this.store.setRalphLoopState({ status: 'running' });
    this.runLoop();
  }

  private runLoop(): void {
    if (this._status !== 'running') {
      return;
    }

    this.tick()
      .catch((err) => {
        this.emit('error', err);
      })
      .finally(() => {
        if (this._status === 'running') {
          this.loopTimer = setTimeout(() => this.runLoop(), this.pollIntervalMs);
        }
      });
  }

  private async tick(): Promise<void> {
    this.store.setRalphLoopState({ lastCheckAt: Date.now() });

    // Check for timed out tasks
    await this.checkTimeouts();

    // Assign tasks to idle sessions
    await this.assignTasks();

    // Check if we should auto-generate tasks
    if (this.autoGenerateTasks && this.shouldGenerateTasks()) {
      await this.generateFollowUpTasks();
    }

    // Check if we're done
    if (this.shouldStop()) {
      this.stop();
    }
  }

  private async assignTasks(): Promise<void> {
    const idleSessions = this.sessionManager.getIdleSessions();

    for (const session of idleSessions) {
      const task = this.taskQueue.next();
      if (!task) {
        break;
      }

      await this.assignTaskToSession(task, session);
    }
  }

  private async assignTaskToSession(task: Task, session: Session): Promise<void> {
    try {
      task.assign(session.id);
      session.assignTask(task.id);
      this.taskQueue.updateTask(task);

      // Send the prompt to the session
      await session.sendInput(task.prompt);

      this.emit('taskAssigned', task.id, session.id);
    } catch (err) {
      task.fail((err as Error).message);
      session.clearTask();
      this.taskQueue.updateTask(task);
      this.emit('taskFailed', task.id, (err as Error).message);
    }
  }

  private async checkTimeouts(): Promise<void> {
    for (const task of this.taskQueue.getRunningTasks()) {
      if (task.isTimedOut()) {
        task.fail('Task timed out');
        this.taskQueue.updateTask(task);

        const session = this.sessionManager.getSession(task.assignedSessionId!);
        if (session) {
          session.clearTask();
        }

        this.emit('taskFailed', task.id, 'Task timed out');
      }
    }
  }

  private handleSessionCompletion(sessionId: string, phrase: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }

    const taskId = session.currentTaskId;
    if (!taskId) {
      return;
    }

    const task = this.taskQueue.getTask(taskId);
    if (!task) {
      return;
    }

    // Append output and check for completion
    task.appendOutput(session.getOutput());

    if (task.checkCompletion(session.getOutput()) || phrase) {
      task.complete();
      this.taskQueue.updateTask(task);
      session.clearTask();
      this.tasksCompleted++;
      this.store.setRalphLoopState({ tasksCompleted: this.tasksCompleted });
      this.emit('taskCompleted', task.id);
    }
  }

  private handleSessionError(sessionId: string, error: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }

    const taskId = session.currentTaskId;
    if (!taskId) {
      return;
    }

    const task = this.taskQueue.getTask(taskId);
    if (!task) {
      return;
    }

    task.setError(error);
    // Don't fail the task immediately on stderr - some tools write to stderr normally
  }

  private handleSessionStopped(sessionId: string): void {
    const task = this.taskQueue.getRunningTaskForSession(sessionId);
    if (task) {
      task.fail('Session stopped unexpectedly');
      this.taskQueue.updateTask(task);
      this.emit('taskFailed', task.id, 'Session stopped unexpectedly');
    }
  }

  private shouldGenerateTasks(): boolean {
    // Generate tasks if:
    // 1. No pending tasks
    // 2. Min duration not reached
    // 3. We have idle sessions
    const counts = this.taskQueue.getCount();
    return (
      counts.pending === 0 &&
      !this.isMinDurationReached() &&
      this.sessionManager.getIdleSessions().length > 0
    );
  }

  private async generateFollowUpTasks(): Promise<void> {
    // This is a placeholder for auto-generating follow-up tasks
    // In a real implementation, this could:
    // - Analyze completed tasks to find optimization opportunities
    // - Generate tasks for code cleanup, tests, documentation
    // - Use Claude to suggest improvements

    const suggestions = [
      'Review and optimize recently changed code',
      'Add tests for uncovered code paths',
      'Update documentation for changed APIs',
      'Check for security vulnerabilities',
      'Run linting and fix any issues',
    ];

    // Only generate one task at a time
    const suggestion = suggestions[this.tasksGenerated % suggestions.length];
    const defaultDir = process.cwd();

    this.taskQueue.addTask({
      prompt: suggestion,
      workingDir: defaultDir,
      priority: -1, // Lower priority than user-added tasks
    });

    this.tasksGenerated++;
    this.store.setRalphLoopState({ tasksGenerated: this.tasksGenerated });
  }

  private shouldStop(): boolean {
    const counts = this.taskQueue.getCount();

    // Don't stop if there are pending or running tasks
    if (counts.pending > 0 || counts.running > 0) {
      return false;
    }

    // Don't stop if min duration not reached and auto-generate is on
    if (!this.isMinDurationReached() && this.autoGenerateTasks) {
      return false;
    }

    // All tasks done and conditions met
    return true;
  }

  /** Sets the minimum duration in hours before the loop can stop. */
  setMinDuration(hours: number): void {
    this.minDurationMs = hours * 60 * 60 * 1000;
    this.store.setRalphLoopState({ minDurationMs: this.minDurationMs });
  }
}

// Singleton instance
let loopInstance: RalphLoop | null = null;

/** Gets or creates the singleton RalphLoop instance. */
export function getRalphLoop(options?: RalphLoopOptions): RalphLoop {
  if (!loopInstance) {
    loopInstance = new RalphLoop(options);
  }
  return loopInstance;
}
