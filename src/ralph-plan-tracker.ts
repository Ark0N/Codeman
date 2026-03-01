/**
 * @fileoverview RalphPlanTracker - Enhanced plan task management
 *
 * Manages plan tasks with verification criteria, dependencies,
 * execution tracking, TDD workflow support, and plan versioning.
 *
 * Extracted from ralph-tracker.ts as part of domain splitting.
 *
 * @module ralph-plan-tracker
 */

import { EventEmitter } from 'node:events';
import type { PlanTaskStatus, TddPhase } from './types.js';

// ========== Enhanced Plan Task Interface ==========

/**
 * Enhanced plan task with verification criteria, dependencies, and execution tracking.
 * Supports TDD workflow, failure tracking, and plan versioning.
 */
export interface EnhancedPlanTask {
  /** Unique identifier (e.g., "P0-001") */
  id: string;
  /** Task description */
  content: string;
  /** Criticality level */
  priority: 'P0' | 'P1' | 'P2' | null;
  /** How to verify completion */
  verificationCriteria?: string;
  /** Command to run for verification */
  testCommand?: string;
  /** IDs of tasks that must complete first */
  dependencies: string[];
  /** Current execution status */
  status: PlanTaskStatus;
  /** How many times attempted */
  attempts: number;
  /** Most recent failure reason */
  lastError?: string;
  /** Timestamp of completion */
  completedAt?: number;
  /** Plan version this belongs to */
  version: number;
  /** TDD phase category */
  tddPhase?: TddPhase;
  /** ID of paired test/impl task */
  pairedWith?: string;
  /** Estimated complexity */
  complexity?: 'low' | 'medium' | 'high';
  /** Checklist items for review tasks (tddPhase: 'review') */
  reviewChecklist?: string[];
}

/** Checkpoint review data */
export interface CheckpointReview {
  iteration: number;
  timestamp: number;
  summary: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
    pending: number;
    inProgress: number;
  };
  stuckTasks: Array<{
    id: string;
    content: string;
    attempts: number;
    lastError?: string;
  }>;
  recommendations: string[];
}

const MAX_PLAN_HISTORY = 10;

/**
 * RalphPlanTracker - Manages enhanced plan tasks with versioning and checkpoints.
 *
 * Events emitted:
 * - `planInitialized` - When a new plan is initialized
 * - `planTaskUpdate` - When a plan task is updated
 * - `taskBlocked` - When a task becomes blocked after too many failures
 * - `taskUnblocked` - When a task's dependencies are all met
 * - `planCheckpoint` - When a checkpoint review is triggered
 * - `planTaskAdded` - When a new task is added to the plan
 * - `planRollback` - When the plan is rolled back to a previous version
 */
export class RalphPlanTracker extends EventEmitter {
  /** Current version of the plan (incremented on changes) */
  private _planVersion: number = 1;

  /** History of plan versions for rollback support */
  private _planHistory: Array<{
    version: number;
    timestamp: number;
    tasks: Map<string, EnhancedPlanTask>;
    summary: string;
  }> = [];

  /** Enhanced plan tasks with execution tracking */
  private _planTasks: Map<string, EnhancedPlanTask> = new Map();

  /** Checkpoint intervals (iterations at which to trigger review) */
  private _checkpointIterations: number[] = [5, 10, 20, 30, 50, 75, 100];

  /** Last checkpoint iteration */
  private _lastCheckpointIteration: number = 0;

  /** Current cycle count (fed by parent via notifyCycleCount) */
  private _cycleCount: number = 0;

  constructor() {
    super();
  }

  /**
   * Notify the plan tracker of the current cycle count.
   * Called by parent when iteration changes (for checkpoint detection).
   */
  notifyCycleCount(cycleCount: number): void {
    this._cycleCount = cycleCount;
  }

  /**
   * Initialize plan tasks from generated plan items.
   * Called when wizard generates a new plan.
   */
  initializePlanTasks(
    items: Array<{
      id?: string;
      content: string;
      priority?: 'P0' | 'P1' | 'P2' | null;
      verificationCriteria?: string;
      testCommand?: string;
      dependencies?: string[];
      tddPhase?: TddPhase;
      pairedWith?: string;
      complexity?: 'low' | 'medium' | 'high';
    }>
  ): void {
    // Save current plan to history before replacing
    if (this._planTasks.size > 0) {
      this._savePlanToHistory('Plan replaced with new generation');
    }

    // Clear and rebuild
    this._planTasks.clear();
    this._planVersion++;

    items.forEach((item, idx) => {
      const id = item.id || `task-${idx}`;
      const task: EnhancedPlanTask = {
        id,
        content: item.content,
        priority: item.priority || null,
        verificationCriteria: item.verificationCriteria,
        testCommand: item.testCommand,
        dependencies: item.dependencies || [],
        status: 'pending',
        attempts: 0,
        version: this._planVersion,
        tddPhase: item.tddPhase,
        pairedWith: item.pairedWith,
        complexity: item.complexity,
      };
      this._planTasks.set(id, task);
    });

    this.emit('planInitialized', { version: this._planVersion, taskCount: this._planTasks.size });
  }

  /**
   * Update a specific plan task's status, attempts, or error.
   */
  updatePlanTask(
    taskId: string,
    update: {
      status?: PlanTaskStatus;
      error?: string;
      incrementAttempts?: boolean;
    }
  ): { success: boolean; task?: EnhancedPlanTask; error?: string } {
    const task = this._planTasks.get(taskId);
    if (!task) {
      return { success: false, error: 'Task not found' };
    }

    if (update.status) {
      task.status = update.status;
      if (update.status === 'completed') {
        task.completedAt = Date.now();
      }
    }

    if (update.error) {
      task.lastError = update.error;
    }

    if (update.incrementAttempts) {
      task.attempts++;

      // After 3 failed attempts, mark as blocked and emit warning
      if (task.attempts >= 3 && task.status === 'failed') {
        task.status = 'blocked';
        this.emit('taskBlocked', {
          taskId,
          content: task.content,
          attempts: task.attempts,
          lastError: task.lastError,
        });
      }
    }

    // Update blocked tasks when a dependency completes
    if (update.status === 'completed') {
      this._unblockDependentTasks(taskId);
    }

    // Check for checkpoint
    this._checkForCheckpoint();

    this.emit('planTaskUpdate', { taskId, task });
    return { success: true, task };
  }

  /**
   * Add a new task to the plan (for runtime adaptation).
   */
  addPlanTask(task: {
    content: string;
    priority?: 'P0' | 'P1' | 'P2';
    verificationCriteria?: string;
    dependencies?: string[];
    insertAfter?: string;
  }): { task: EnhancedPlanTask } {
    // Generate unique ID
    const existingIds = Array.from(this._planTasks.keys());
    const prefix = task.priority || 'P1';
    let counter = existingIds.filter((id) => id.startsWith(prefix)).length + 1;
    let id = `${prefix}-${String(counter).padStart(3, '0')}`;
    while (this._planTasks.has(id)) {
      counter++;
      id = `${prefix}-${String(counter).padStart(3, '0')}`;
    }

    const newTask: EnhancedPlanTask = {
      id,
      content: task.content,
      priority: task.priority || null,
      verificationCriteria: task.verificationCriteria || 'Task completed successfully',
      dependencies: task.dependencies || [],
      status: 'pending',
      attempts: 0,
      version: this._planVersion,
    };

    this._planTasks.set(id, newTask);
    this.emit('planTaskAdded', { task: newTask });

    return { task: newTask };
  }

  /**
   * Get all plan tasks.
   */
  getPlanTasks(): EnhancedPlanTask[] {
    return Array.from(this._planTasks.values());
  }

  /**
   * Generate a checkpoint review summarizing plan progress and stuck tasks.
   */
  generateCheckpointReview(): CheckpointReview {
    const tasks = Array.from(this._planTasks.values());

    const summary = {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    };

    // Find stuck tasks (3+ attempts or blocked)
    const stuckTasks = tasks
      .filter((t) => t.attempts >= 3 || t.status === 'blocked')
      .map((t) => ({
        id: t.id,
        content: t.content,
        attempts: t.attempts,
        lastError: t.lastError,
      }));

    // Generate recommendations
    const recommendations: string[] = [];

    if (stuckTasks.length > 0) {
      recommendations.push(`${stuckTasks.length} task(s) are stuck. Consider breaking them into smaller steps.`);
    }

    if (summary.failed > summary.completed && summary.total > 5) {
      recommendations.push('More tasks have failed than completed. Review approach and consider plan adjustment.');
    }

    const progressPercent = summary.total > 0 ? Math.round((summary.completed / summary.total) * 100) : 0;
    if (progressPercent < 20 && this._cycleCount > 10) {
      recommendations.push('Progress is slow. Consider simplifying tasks or reviewing dependencies.');
    }

    if (summary.total > 0 && summary.blocked > summary.total / 3) {
      recommendations.push('Many tasks are blocked. Review dependency chain for bottlenecks.');
    }

    return {
      iteration: this._cycleCount,
      timestamp: Date.now(),
      summary,
      stuckTasks,
      recommendations,
    };
  }

  /**
   * Get plan version history.
   */
  getPlanHistory(): Array<{
    version: number;
    timestamp: number;
    summary: string;
    stats: { total: number; completed: number; failed: number };
  }> {
    return this._planHistory.map((h) => {
      const tasks = Array.from(h.tasks.values());
      return {
        version: h.version,
        timestamp: h.timestamp,
        summary: h.summary,
        stats: {
          total: tasks.length,
          completed: tasks.filter((t) => t.status === 'completed').length,
          failed: tasks.filter((t) => t.status === 'failed').length,
        },
      };
    });
  }

  /**
   * Rollback to a previous plan version.
   */
  rollbackToVersion(version: number): {
    success: boolean;
    plan?: EnhancedPlanTask[];
    error?: string;
  } {
    const historyEntry = this._planHistory.find((h) => h.version === version);
    if (!historyEntry) {
      return { success: false, error: `Version ${version} not found in history` };
    }

    // Save current state first
    this._savePlanToHistory(`Rolled back from v${this._planVersion} to v${version}`);

    // Restore the historical version
    this._planTasks.clear();
    for (const [id, task] of historyEntry.tasks) {
      // Reset execution state for retry
      this._planTasks.set(id, {
        ...task,
        status: task.status === 'completed' ? 'completed' : 'pending',
        attempts: task.status === 'completed' ? task.attempts : 0,
        lastError: undefined,
      });
    }

    this._planVersion++;
    this.emit('planRollback', { version, newVersion: this._planVersion });

    return { success: true, plan: Array.from(this._planTasks.values()) };
  }

  /**
   * Check if checkpoint review is due for current iteration.
   */
  isCheckpointDue(): boolean {
    return this._checkpointIterations.includes(this._cycleCount) && this._cycleCount > this._lastCheckpointIteration;
  }

  /**
   * Get current plan version.
   */
  get planVersion(): number {
    return this._planVersion;
  }

  /**
   * Reset plan state (soft reset - keeps version history).
   */
  reset(): void {
    // Don't clear history or version on soft reset
  }

  /**
   * Full reset - clears all plan state.
   */
  fullReset(): void {
    this._planTasks.clear();
    this._planHistory.length = 0;
    this._planVersion = 1;
    this._lastCheckpointIteration = 0;
    this._cycleCount = 0;
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this._planTasks.clear();
    this._planHistory.length = 0;
    this.removeAllListeners();
  }

  /**
   * Unblock tasks that were waiting on a completed dependency.
   */
  private _unblockDependentTasks(completedTaskId: string): void {
    for (const [_, task] of this._planTasks) {
      if (task.dependencies.includes(completedTaskId)) {
        // Check if all dependencies are now complete
        const allDepsComplete = task.dependencies.every((depId) => {
          const dep = this._planTasks.get(depId);
          return dep && dep.status === 'completed';
        });

        if (allDepsComplete && task.status === 'blocked') {
          task.status = 'pending';
          this.emit('taskUnblocked', { taskId: task.id });
        }
      }
    }
  }

  /**
   * Check if current iteration is a checkpoint and emit review if so.
   */
  private _checkForCheckpoint(): void {
    if (this._checkpointIterations.includes(this._cycleCount) && this._cycleCount > this._lastCheckpointIteration) {
      this._lastCheckpointIteration = this._cycleCount;
      const checkpoint = this.generateCheckpointReview();
      this.emit('planCheckpoint', checkpoint);
    }
  }

  /**
   * Save current plan state to history.
   */
  private _savePlanToHistory(summary: string): void {
    // Clone current tasks
    const tasksCopy = new Map<string, EnhancedPlanTask>();
    for (const [id, task] of this._planTasks) {
      tasksCopy.set(id, { ...task });
    }

    this._planHistory.push({
      version: this._planVersion,
      timestamp: Date.now(),
      tasks: tasksCopy,
      summary,
    });

    // Limit history size
    if (this._planHistory.length > MAX_PLAN_HISTORY) {
      this._planHistory.shift();
    }
  }
}
