import { EventEmitter } from 'node:events';

/**
 * Represents a background task spawned by Claude Code
 */
export interface BackgroundTask {
  id: string;
  parentId: string | null;
  description: string;
  subagentType: string;
  status: 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  output?: string;
  children: string[];
}

export interface TaskTrackerEvents {
  taskCreated: (task: BackgroundTask) => void;
  taskUpdated: (task: BackgroundTask) => void;
  taskCompleted: (task: BackgroundTask) => void;
  taskFailed: (task: BackgroundTask, error: string) => void;
}

/**
 * TaskTracker parses Claude Code's output to detect and track background tasks.
 *
 * Claude Code outputs JSON messages. When it spawns a task via the Task tool,
 * we see tool_use blocks with the task parameters. We track these and match
 * them with tool_result blocks to track completion.
 */
export class TaskTracker extends EventEmitter {
  private tasks: Map<string, BackgroundTask> = new Map();
  private taskStack: string[] = []; // Stack of active task IDs for nesting
  private pendingToolUses: Map<string, { description: string; subagentType: string; parentId: string | null }> = new Map();

  constructor() {
    super();
  }

  /**
   * Process a Claude message to detect task events
   */
  processMessage(msg: any): void {
    if (!msg || !msg.message?.content) return;

    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && block.name === 'Task') {
        this.handleTaskToolUse(block);
      } else if (block.type === 'tool_result') {
        this.handleToolResult(block);
      }
    }
  }

  /**
   * Process raw terminal output to detect task patterns
   * This is a fallback for when JSON parsing doesn't capture everything
   */
  processTerminalOutput(data: string): void {
    // Detect task launch patterns in terminal output
    // Claude Code shows things like "Launching explore agent..." or similar
    const launchPatterns = [
      /Launching\s+(\w+)\s+agent/i,
      /Starting\s+(\w+)\s+task/i,
      /Spawning\s+(\w+)\s+agent/i,
    ];

    for (const pattern of launchPatterns) {
      const match = data.match(pattern);
      if (match) {
        // This is a heuristic detection - might create duplicate tasks
        // but we dedupe by checking if we already have a running task of this type
        const agentType = match[1].toLowerCase();
        const existingRunning = Array.from(this.tasks.values()).find(
          t => t.subagentType === agentType && t.status === 'running'
        );
        if (!existingRunning) {
          this.createTaskFromTerminal(agentType, data);
        }
      }
    }

    // Detect task completion patterns
    const completePatterns = [
      /Task\s+completed/i,
      /Agent\s+finished/i,
      /Background\s+task\s+done/i,
    ];

    for (const pattern of completePatterns) {
      if (pattern.test(data)) {
        // Complete the most recent running task
        const runningTask = this.getMostRecentRunningTask();
        if (runningTask) {
          this.completeTask(runningTask.id);
        }
      }
    }
  }

  private handleTaskToolUse(block: any): void {
    const toolUseId = block.id;
    const params = block.input || {};

    const description = params.description || params.prompt?.substring(0, 50) || 'Background task';
    const subagentType = params.subagent_type || 'general';

    // Determine parent (current top of stack or null)
    const parentId = this.taskStack.length > 0 ? this.taskStack[this.taskStack.length - 1] : null;

    // Store pending tool use - task starts when we see activity
    this.pendingToolUses.set(toolUseId, { description, subagentType, parentId });

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

  private handleToolResult(block: any): void {
    const toolUseId = block.tool_use_id;
    const task = this.tasks.get(toolUseId);

    if (task) {
      task.status = block.is_error ? 'failed' : 'completed';
      task.endTime = Date.now();
      task.output = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);

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
    }

    // Clean up pending
    this.pendingToolUses.delete(toolUseId);
  }

  private createTaskFromTerminal(agentType: string, context: string): void {
    const taskId = `terminal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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

  private getMostRecentRunningTask(): BackgroundTask | undefined {
    // Return the task at the top of the stack
    if (this.taskStack.length > 0) {
      const taskId = this.taskStack[this.taskStack.length - 1];
      return this.tasks.get(taskId);
    }
    return undefined;
  }

  /**
   * Get the task tree as a nested structure
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
   * Get all tasks as a flat map
   */
  getAllTasks(): Map<string, BackgroundTask> {
    return new Map(this.tasks);
  }

  /**
   * Get a specific task by ID
   */
  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get count of currently running tasks
   */
  getRunningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') count++;
    }
    return count;
  }

  /**
   * Get summary statistics
   */
  getStats(): { total: number; running: number; completed: number; failed: number } {
    let running = 0, completed = 0, failed = 0;

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'running': running++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
      }
    }

    return { total: this.tasks.size, running, completed, failed };
  }

  /**
   * Clear all tasks (e.g., when session is cleared)
   */
  clear(): void {
    this.tasks.clear();
    this.taskStack = [];
    this.pendingToolUses.clear();
  }
}
