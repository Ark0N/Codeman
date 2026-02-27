/**
 * @fileoverview Background Task Tracker for Claude Code sessions
 *
 * This module tracks background tasks (subagents) spawned by Claude Code
 * during session execution. It parses both JSON messages and terminal output
 * to detect when tasks are created, updated, and completed.
 *
 * ## Task Hierarchy
 *
 * Tasks can be nested (parent-child relationships) when Claude spawns
 * a subagent from within another subagent. The tracker maintains a stack
 * to track nesting and a tree structure for visualization.
 *
 * ## Detection Methods
 *
 * 1. **JSON Messages**: Parses `tool_use` blocks for Task tool invocations
 *    and `tool_result` blocks for completion
 * 2. **Terminal Output**: Fallback pattern matching for launch/complete messages
 *
 * @module task-tracker
 */

import { EventEmitter } from 'node:events';
import { assertNever } from './utils/index.js';

// ========== Configuration Constants ==========

/**
 * Maximum number of completed tasks to keep in memory.
 * Oldest completed tasks are removed when this limit is exceeded.
 */
const MAX_COMPLETED_TASKS = 100;

/**
 * Maximum age for pending tool uses (in milliseconds).
 * Entries older than this are cleaned up to prevent unbounded growth.
 * Default: 1 hour
 */
const PENDING_TOOL_USE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Maximum number of pending tool uses to allow.
 * Prevents unbounded growth if tool_results never arrive.
 */
const MAX_PENDING_TOOL_USES = 100;

// ========== Pre-compiled Regex Patterns ==========

/**
 * Patterns that indicate a new task/agent is being launched.
 * Used as fallback when JSON parsing doesn't capture the launch.
 * Capture group 1: Agent/task type name
 */
const LAUNCH_PATTERNS = [
  /Launching\s+(\w+)\s+agent/i,
  /Starting\s+(\w+)\s+task/i,
  /Spawning\s+(\w+)\s+agent/i,
];

/**
 * Patterns that indicate a task has completed.
 * Used as fallback when JSON parsing doesn't capture the result.
 */
const COMPLETE_PATTERNS = [/Task\s+completed/i, /Agent\s+finished/i, /Background\s+task\s+done/i];

// ========== Type Definitions ==========

/**
 * Content block for tool_use messages from Claude.
 * Emitted when Claude invokes a tool.
 */
interface ClaudeToolUseBlock {
  type: 'tool_use';
  /** Unique identifier for this tool invocation */
  id: string;
  /** Name of the tool being invoked */
  name: string;
  /** Parameters passed to the tool */
  input?: {
    description?: string;
    prompt?: string;
    subagent_type?: string;
    [key: string]: unknown;
  };
}

/**
 * Content block for tool_result messages from Claude.
 * Emitted when a tool completes execution.
 */
interface ClaudeToolResultBlock {
  type: 'tool_result';
  /** ID of the tool_use this result corresponds to */
  tool_use_id: string;
  /** Whether the tool execution resulted in an error */
  is_error?: boolean;
  /** Result content (string or structured data) */
  content?: string | unknown;
}

/**
 * Union type for content blocks we care about.
 */
type ClaudeContentBlock = ClaudeToolUseBlock | ClaudeToolResultBlock | { type: string };

/**
 * Claude JSON message structure.
 * This is the format Claude Code outputs for streaming events.
 */
interface ClaudeMessage {
  message?: {
    content?: ClaudeContentBlock[];
  };
}

/**
 * Represents a background task spawned by Claude Code.
 *
 * Tasks form a tree structure where a parent task can spawn child tasks.
 * This enables tracking of nested agent invocations.
 */
export interface BackgroundTask {
  /** Unique task identifier (usually the tool_use ID from Claude) */
  id: string;

  /** Parent task ID if this is a nested task, null for root tasks */
  parentId: string | null;

  /** Human-readable description of what the task is doing */
  description: string;

  /** Type of subagent (e.g., 'explore', 'bash', 'general-purpose') */
  subagentType: string;

  /** Current execution status */
  status: 'running' | 'completed' | 'failed';

  /** Timestamp when task was created (milliseconds since epoch) */
  startTime: number;

  /** Timestamp when task finished (milliseconds since epoch) */
  endTime?: number;

  /** Output/result from the task execution */
  output?: string;

  /** IDs of child tasks spawned by this task */
  children: string[];
}

/**
 * Events emitted by TaskTracker.
 *
 * @event taskCreated - New task detected and added
 * @event taskUpdated - Task state changed (rarely used)
 * @event taskCompleted - Task finished successfully
 * @event taskFailed - Task finished with error
 */
export interface TaskTrackerEvents {
  /** New task created */
  taskCreated: (task: BackgroundTask) => void;
  /** Task state updated */
  taskUpdated: (task: BackgroundTask) => void;
  /** Task completed successfully */
  taskCompleted: (task: BackgroundTask) => void;
  /** Task failed with error */
  taskFailed: (task: BackgroundTask, error: string) => void;
}

/**
 * TaskTracker - Detects and tracks background tasks in Claude Code sessions.
 *
 * ## How It Works
 *
 * Claude Code outputs JSON messages when executing. When it spawns a subagent
 * via the Task tool, we see:
 *
 * 1. `tool_use` block with `name: "Task"` and input parameters
 * 2. ... task execution output ...
 * 3. `tool_result` block with the result or error
 *
 * The tracker maintains:
 * - A map of all tasks by ID
 * - A stack of currently running tasks (for nesting)
 * - Parent-child relationships between tasks
 *
 * ## Usage
 *
 * ```typescript
 * const tracker = new TaskTracker();
 *
 * tracker.on('taskCreated', (task) => {
 *   console.log(`New task: ${task.description}`);
 * });
 *
 * tracker.on('taskCompleted', (task) => {
 *   console.log(`Task done: ${task.id}`);
 * });
 *
 * // Feed in Claude messages
 * tracker.processMessage(claudeJsonMessage);
 *
 * // Or terminal output as fallback
 * tracker.processTerminalOutput(ptyData);
 * ```
 *
 * @extends EventEmitter
 */
export class TaskTracker extends EventEmitter {
  /** Map of task ID to task object */
  private tasks: Map<string, BackgroundTask> = new Map();

  /** Stack of active task IDs for tracking nesting depth */
  private taskStack: string[] = [];

  /** Pending tool_use blocks waiting for results (with timestamp for cleanup) */
  private pendingToolUses: Map<
    string,
    { description: string; subagentType: string; parentId: string | null; createdAt: number }
  > = new Map();

  /**
   * Creates a new TaskTracker instance.
   */
  constructor() {
    super();
  }

  /**
   * Process a Claude JSON message to detect task events.
   *
   * Looks for `tool_use` blocks with `name: "Task"` and `tool_result` blocks
   * to track task lifecycle.
   *
   * @param msg - Parsed Claude JSON message object
   * @fires taskCreated - When a new task is detected
   * @fires taskCompleted - When a task finishes successfully
   * @fires taskFailed - When a task finishes with error
   */
  processMessage(msg: ClaudeMessage | null | undefined): void {
    if (!msg || !msg.message?.content) return;

    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && (block as ClaudeToolUseBlock).name === 'Task') {
        this.handleTaskToolUse(block as ClaudeToolUseBlock);
      } else if (block.type === 'tool_result') {
        this.handleToolResult(block as ClaudeToolResultBlock);
      }
    }
  }

  /**
   * Process raw terminal output to detect task patterns.
   *
   * This is a fallback for when JSON parsing doesn't capture everything.
   * Uses pre-compiled patterns to detect launch and completion messages.
   *
   * Note: May create duplicate tasks in some cases; deduplication is
   * handled by checking for existing running tasks of the same type.
   *
   * @param data - Raw terminal output string
   * @fires taskCreated - When a launch pattern is matched
   * @fires taskCompleted - When a complete pattern is matched
   */
  processTerminalOutput(data: string): void {
    // Detect task launch patterns in terminal output
    // Claude Code shows things like "Launching explore agent..." or similar
    for (const pattern of LAUNCH_PATTERNS) {
      const match = data.match(pattern);
      if (match) {
        // This is a heuristic detection - might create duplicate tasks
        // but we dedupe by checking if we already have a running task of this type
        const agentType = match[1].toLowerCase();
        // Optimize: use iterator directly instead of Array.from
        let existingRunning = false;
        for (const task of this.tasks.values()) {
          if (task.subagentType === agentType && task.status === 'running') {
            existingRunning = true;
            break;
          }
        }
        if (!existingRunning) {
          this.createTaskFromTerminal(agentType, data);
        }
      }
    }

    // Detect task completion patterns
    for (const pattern of COMPLETE_PATTERNS) {
      if (pattern.test(data)) {
        // Complete the most recent running task
        const runningTask = this.getMostRecentRunningTask();
        if (runningTask) {
          this.completeTask(runningTask.id);
        }
      }
    }
  }

  /**
   * Handle a tool_use block for the Task tool.
   * Creates a new task and pushes it onto the stack.
   *
   * @param block - The tool_use content block
   * @fires taskCreated
   */
  private handleTaskToolUse(block: ClaudeToolUseBlock): void {
    const toolUseId = block.id;
    const params = block.input || {};

    const description = params.description || params.prompt?.substring(0, 50) || 'Background task';
    const subagentType = params.subagent_type || 'general';

    // Determine parent (current top of stack or null)
    const parentId = this.taskStack.length > 0 ? this.taskStack[this.taskStack.length - 1] : null;

    // Store pending tool use - task starts when we see activity
    this.pendingToolUses.set(toolUseId, {
      description,
      subagentType,
      parentId,
      createdAt: Date.now(),
    });

    // Clean up old pending entries to prevent unbounded growth
    this.cleanupOldPendingToolUses();

    // Create the task immediately
    const task: BackgroundTask = {
      id: toolUseId,
      parentId,
      description,
      subagentType,
      status: 'running',
      startTime: Date.now(),
      children: [],
    };

    this.tasks.set(toolUseId, task);
    this.taskStack.push(toolUseId);

    // Update parent's children list
    if (parentId) {
      const parent = this.tasks.get(parentId);
      if (parent) {
        parent.children.push(toolUseId);
      }
    }

    this.emit('taskCreated', task);
  }

  /**
   * Handle a tool_result block.
   * Marks the corresponding task as completed or failed.
   *
   * @param block - The tool_result content block
   * @fires taskCompleted - If result is success
   * @fires taskFailed - If result is error
   */
  private handleToolResult(block: ClaudeToolResultBlock): void {
    const toolUseId = block.tool_use_id;
    const task = this.tasks.get(toolUseId);

    if (task) {
      task.status = block.is_error ? 'failed' : 'completed';
      task.endTime = Date.now();
      task.output =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);

      // Remove from stack
      const stackIndex = this.taskStack.indexOf(toolUseId);
      if (stackIndex !== -1) {
        this.taskStack.splice(stackIndex, 1);
      }

      if (block.is_error) {
        this.emit('taskFailed', task, task.output || 'Unknown error');
      } else {
        this.emit('taskCompleted', task);
      }

      // Clean up old completed tasks to prevent unbounded growth
      this.cleanupCompletedTasks();
    }

    // Clean up pending
    this.pendingToolUses.delete(toolUseId);
  }

  /**
   * Remove old pending tool uses that never received results.
   * Prevents unbounded growth if tool_results never arrive.
   */
  private cleanupOldPendingToolUses(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    // Remove entries older than PENDING_TOOL_USE_MAX_AGE_MS
    for (const [id, entry] of this.pendingToolUses) {
      if (now - entry.createdAt > PENDING_TOOL_USE_MAX_AGE_MS) {
        toDelete.push(id);
      }
    }

    // If still over limit after age-based cleanup, remove oldest entries
    if (this.pendingToolUses.size - toDelete.length > MAX_PENDING_TOOL_USES) {
      const entries = Array.from(this.pendingToolUses.entries())
        .filter(([id]) => !toDelete.includes(id))
        .sort((a, b) => a[1].createdAt - b[1].createdAt);

      const removeCount = entries.length - MAX_PENDING_TOOL_USES;
      for (let i = 0; i < removeCount; i++) {
        toDelete.push(entries[i][0]);
      }
    }

    for (const id of toDelete) {
      this.pendingToolUses.delete(id);
    }
  }

  /**
   * Remove old completed/failed tasks when exceeding the limit
   * Keeps running tasks and the most recent completed tasks
   */
  private cleanupCompletedTasks(): void {
    const completedTasks: BackgroundTask[] = [];

    // Collect all completed/failed tasks
    for (const task of this.tasks.values()) {
      if (task.status === 'completed' || task.status === 'failed') {
        completedTasks.push(task);
      }
    }

    // If under limit, no cleanup needed
    if (completedTasks.length <= MAX_COMPLETED_TASKS) {
      return;
    }

    // Sort by end time (oldest first)
    completedTasks.sort((a, b) => (a.endTime || 0) - (b.endTime || 0));

    // Remove oldest tasks beyond the limit
    const toRemove = completedTasks.slice(0, completedTasks.length - MAX_COMPLETED_TASKS);
    for (const task of toRemove) {
      // Remove from parent's children list if applicable
      if (task.parentId) {
        const parent = this.tasks.get(task.parentId);
        if (parent) {
          const childIndex = parent.children.indexOf(task.id);
          if (childIndex !== -1) {
            parent.children.splice(childIndex, 1);
          }
        }
      }
      this.tasks.delete(task.id);
    }
  }

  /**
   * Create a task from terminal pattern detection.
   * Used as fallback when JSON messages aren't available.
   *
   * @param agentType - Type of agent detected
   * @param context - Terminal context for debugging
   * @fires taskCreated
   */
  private createTaskFromTerminal(agentType: string, _context: string): void {
    const taskId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const parentId = this.taskStack.length > 0 ? this.taskStack[this.taskStack.length - 1] : null;

    const task: BackgroundTask = {
      id: taskId,
      parentId,
      description: `${agentType} agent`,
      subagentType: agentType,
      status: 'running',
      startTime: Date.now(),
      children: [],
    };

    this.tasks.set(taskId, task);
    this.taskStack.push(taskId);

    if (parentId) {
      const parent = this.tasks.get(parentId);
      if (parent) {
        parent.children.push(taskId);
      }
    }

    this.emit('taskCreated', task);
  }

  /**
   * Mark a task as completed.
   *
   * @param taskId - ID of task to complete
   * @fires taskCompleted - If task was running
   */
  private completeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'running') {
      task.status = 'completed';
      task.endTime = Date.now();

      const stackIndex = this.taskStack.indexOf(taskId);
      if (stackIndex !== -1) {
        this.taskStack.splice(stackIndex, 1);
      }

      this.emit('taskCompleted', task);
    }
  }

  /**
   * Get the most recently started running task.
   * Returns the task at the top of the stack (most nested).
   *
   * @returns Most recent running task, or undefined if none
   */
  private getMostRecentRunningTask(): BackgroundTask | undefined {
    // Return the task at the top of the stack
    if (this.taskStack.length > 0) {
      const taskId = this.taskStack[this.taskStack.length - 1];
      return this.tasks.get(taskId);
    }
    return undefined;
  }

  /**
   * Get root-level tasks as a list.
   *
   * Child tasks can be accessed via the `children` array on each task.
   * Use this for displaying a task tree in the UI.
   *
   * @returns Array of tasks without parents (root level)
   */
  getTaskTree(): BackgroundTask[] {
    const rootTasks: BackgroundTask[] = [];

    for (const task of this.tasks.values()) {
      if (!task.parentId) {
        rootTasks.push(task);
      }
    }

    return rootTasks;
  }

  /**
   * Lightweight task tree for SSE broadcasts — strips large `output` strings
   * to avoid serializing 5-10MB of task results every 500ms.
   * Full task details available via getTaskTree().
   *
   * @returns Array of root tasks with output truncated to 200 chars
   */
  getTaskTreeLight(): Omit<BackgroundTask, 'output'>[] {
    const rootTasks: Omit<BackgroundTask, 'output'>[] = [];

    for (const task of this.tasks.values()) {
      if (!task.parentId) {
        // Strip output to avoid serializing large strings on every broadcast
        const { output: _output, ...lightTask } = task;
        rootTasks.push(lightTask);
      }
    }

    return rootTasks;
  }

  /**
   * Get all tasks as a flat Map.
   *
   * @returns Copy of the internal tasks map (safe to modify)
   */
  getAllTasks(): Map<string, BackgroundTask> {
    return new Map(this.tasks);
  }

  /**
   * Get a specific task by its ID.
   *
   * @param taskId - The task ID to look up
   * @returns The task if found, undefined otherwise
   */
  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get the count of currently running tasks.
   *
   * @returns Number of tasks with status 'running'
   */
  getRunningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') count++;
    }
    return count;
  }

  /**
   * Get aggregated statistics about all tracked tasks.
   *
   * @returns Object with counts:
   *   - total: Total number of tracked tasks
   *   - running: Tasks currently executing
   *   - completed: Successfully finished tasks
   *   - failed: Tasks that ended with errors
   */
  getStats(): { total: number; running: number; completed: number; failed: number } {
    let running = 0,
      completed = 0,
      failed = 0;

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'running':
          running++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
        default:
          assertNever(task.status, `Unhandled BackgroundTask status: ${task.status}`);
      }
    }

    return { total: this.tasks.size, running, completed, failed };
  }

  /**
   * Clear all tracked tasks.
   *
   * Use when the session is cleared or closed.
   * Resets the task map, stack, and pending tool uses.
   */
  clear(): void {
    this.tasks.clear();
    this.taskStack = [];
    this.pendingToolUses.clear();
  }

  /**
   * Clean up resources and release memory.
   *
   * Call this when the session is being destroyed to prevent memory leaks.
   * Clears all data and removes all event listeners.
   */
  destroy(): void {
    this.clear();
    this.removeAllListeners();
  }
}
