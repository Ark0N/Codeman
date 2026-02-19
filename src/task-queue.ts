/**
 * @fileoverview Task queue for managing Claude prompts and operations
 *
 * Provides a priority queue for tasks with:
 * - Priority-based ordering (higher priority first)
 * - Dependency tracking between tasks
 * - State persistence via StateStore
 * - Session assignment for task execution
 *
 * @module task-queue
 */

import { EventEmitter } from 'node:events';
import { Task, CreateTaskOptions } from './task.js';
import { getStore } from './state-store.js';

/**
 * Events emitted by TaskQueue
 */
export interface TaskQueueEvents {
  /** Fired when a task is added to the queue */
  taskAdded: (task: Task) => void;
  /** Fired when a task is removed from the queue */
  taskRemoved: (taskId: string) => void;
  /** Fired when a task's state changes */
  taskUpdated: (task: Task) => void;
}

/**
 * Priority queue for managing tasks with dependency support.
 *
 * @description
 * Tasks are ordered by priority (descending) then creation time (ascending).
 * Dependencies can be specified to ensure tasks run in correct order.
 *
 * @extends EventEmitter
 */
export class TaskQueue extends EventEmitter {
  private tasks: Map<string, Task> = new Map();
  private store = getStore();

  /** Creates a new TaskQueue and loads persisted tasks. */
  constructor() {
    super();
    this.loadFromStore();
  }

  private loadFromStore(): void {
    const storedTasks = this.store.getTasks();
    for (const [id, state] of Object.entries(storedTasks)) {
      const task = Task.fromState(state);
      this.tasks.set(id, task);
    }
  }

  /**
   * Adds a new task to the queue.
   * @throws Error if the task's dependencies would create a circular dependency
   */
  addTask(options: CreateTaskOptions): Task {
    const task = new Task(options);
    // Validate dependencies before adding to prevent circular dependency deadlocks
    if (options.dependencies && options.dependencies.length > 0) {
      this.validateDependencies(task.id, options.dependencies);
    }
    this.tasks.set(task.id, task);
    this.store.setTask(task.id, task.toState());
    this.emit('taskAdded', task);
    return task;
  }

  /** Gets a task by ID. */
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** Removes a task by ID. Returns true if removed. */
  removeTask(id: string): boolean {
    const removed = this.tasks.delete(id);
    if (removed) {
      this.store.removeTask(id);
      this.emit('taskRemoved', id);
    }
    return removed;
  }

  /** Updates a task and persists the change. */
  updateTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.store.setTask(task.id, task.toState());
    this.emit('taskUpdated', task);
  }

  /** Gets all tasks in the queue. */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /** Gets pending tasks sorted by priority then creation time. */
  getPendingTasks(): Task[] {
    return this.getAllTasks()
      .filter((t) => t.isPending())
      .sort((a, b) => {
        // Sort by priority (higher first), then by creation time (older first)
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt - b.createdAt;
      });
  }

  /** Gets tasks currently being executed. */
  getRunningTasks(): Task[] {
    return this.getAllTasks().filter((t) => t.isRunning());
  }

  /** Gets successfully completed tasks. */
  getCompletedTasks(): Task[] {
    return this.getAllTasks().filter((t) => t.isCompleted());
  }

  /** Gets tasks that failed execution. */
  getFailedTasks(): Task[] {
    return this.getAllTasks().filter((t) => t.isFailed());
  }

  /** Returns true if there's a task ready for execution. */
  hasNext(): boolean {
    return this.getNextAvailable() !== null;
  }

  /** Gets the next task ready for execution (with satisfied dependencies). */
  getNextAvailable(): Task | null {
    const pending = this.getPendingTasks();

    for (const task of pending) {
      if (this.areDependenciesSatisfied(task)) {
        return task;
      }
    }

    return null;
  }

  /** Alias for getNextAvailable(). */
  next(): Task | null {
    return this.getNextAvailable();
  }

  private areDependenciesSatisfied(task: Task): boolean {
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || !dep.isCompleted()) {
        return false;
      }
    }
    return true;
  }

  /**
   * Detect if adding a dependency would create a cycle.
   * Uses DFS to check if there's a path from depId back to taskId.
   *
   * @param taskId - The task that would have the new dependency
   * @param depId - The dependency being added
   * @param visited - Set of already visited nodes (for DFS)
   * @returns true if adding this dependency would create a cycle
   */
  private wouldCreateCycle(taskId: string, depId: string, visited: Set<string> = new Set()): boolean {
    // Direct self-reference
    if (depId === taskId) return true;
    // Already visited this node in current path
    if (visited.has(depId)) return false;

    visited.add(depId);
    const depTask = this.tasks.get(depId);
    if (!depTask) return false;

    // Recursively check all dependencies of the dependency
    for (const nextDep of depTask.dependencies) {
      if (this.wouldCreateCycle(taskId, nextDep, visited)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Validates that a set of dependencies won't create cycles for a given task.
   * Throws an error if a circular dependency is detected.
   *
   * @param taskId - The task ID that will have these dependencies
   * @param dependencies - Array of dependency task IDs to validate
   * @throws Error if a circular dependency would be created
   */
  private validateDependencies(taskId: string, dependencies: string[]): void {
    for (const depId of dependencies) {
      if (this.wouldCreateCycle(taskId, depId)) {
        throw new Error(`Circular dependency detected: adding dependency ${depId} to task ${taskId} would create a cycle`);
      }
    }
  }

  /** Gets all tasks assigned to a specific session. */
  getTasksBySession(sessionId: string): Task[] {
    return this.getAllTasks().filter((t) => t.assignedSessionId === sessionId);
  }

  /** Gets the currently running task for a session, if any. */
  getRunningTaskForSession(sessionId: string): Task | null {
    return this.getAllTasks().find(
      (t) => t.isRunning() && t.assignedSessionId === sessionId
    ) || null;
  }

  /** Gets counts of tasks by status (single-pass). */
  getCount(): { total: number; pending: number; running: number; completed: number; failed: number } {
    let pending = 0, running = 0, completed = 0, failed = 0;
    for (const task of this.tasks.values()) {
      if (task.isPending()) pending++;
      else if (task.isRunning()) running++;
      else if (task.isCompleted()) completed++;
      else if (task.isFailed()) failed++;
    }
    return { total: this.tasks.size, pending, running, completed, failed };
  }

  /** Removes all completed tasks. Returns count removed. */
  clearCompleted(): number {
    let count = 0;
    for (const task of this.getAllTasks()) {
      if (task.isCompleted()) {
        this.removeTask(task.id);
        count++;
      }
    }
    return count;
  }

  /** Removes all failed tasks. Returns count removed. */
  clearFailed(): number {
    let count = 0;
    for (const task of this.getAllTasks()) {
      if (task.isFailed()) {
        this.removeTask(task.id);
        count++;
      }
    }
    return count;
  }

  /** Removes all tasks from the queue. Returns count removed. */
  clearAll(): number {
    const count = this.tasks.size;
    for (const id of this.tasks.keys()) {
      this.store.removeTask(id);
    }
    this.tasks.clear();
    return count;
  }

}

// Singleton instance
let queueInstance: TaskQueue | null = null;

/** Gets or creates the singleton TaskQueue instance. */
export function getTaskQueue(): TaskQueue {
  if (!queueInstance) {
    queueInstance = new TaskQueue();
  }
  return queueInstance;
}
