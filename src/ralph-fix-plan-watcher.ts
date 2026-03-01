/**
 * @fileoverview RalphFixPlanWatcher - Watches @fix_plan.md for changes
 *
 * Monitors the @fix_plan.md file in the session's working directory
 * for changes, parsing todo items from the markdown format.
 *
 * Extracted from ralph-tracker.ts as part of domain splitting.
 *
 * @module ralph-fix-plan-watcher
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { existsSync, FSWatcher, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import type { RalphTodoStatus, RalphTodoPriority, RalphTodoItem } from './types.js';

// ========== @fix_plan.md Generation & Import Utility Functions ==========

/**
 * Generate @fix_plan.md content from todo items.
 * Groups todos by priority and status.
 *
 * @param todos - Array of todo items
 * @returns Markdown content for @fix_plan.md
 */
export function generateFixPlanMarkdown(todos: RalphTodoItem[]): string {
  const lines: string[] = ['# Fix Plan', ''];

  // Group by priority
  const p0: RalphTodoItem[] = [];
  const p1: RalphTodoItem[] = [];
  const p2: RalphTodoItem[] = [];
  const noPriority: RalphTodoItem[] = [];
  const completed: RalphTodoItem[] = [];

  for (const todo of todos) {
    if (todo.status === 'completed') {
      completed.push(todo);
    } else if (todo.priority === 'P0') {
      p0.push(todo);
    } else if (todo.priority === 'P1') {
      p1.push(todo);
    } else if (todo.priority === 'P2') {
      p2.push(todo);
    } else {
      noPriority.push(todo);
    }
  }

  // High Priority (P0)
  if (p0.length > 0) {
    lines.push('## High Priority (P0)');
    for (const todo of p0) {
      const checkbox = todo.status === 'in_progress' ? '[-]' : '[ ]';
      lines.push(`- ${checkbox} ${todo.content}`);
    }
    lines.push('');
  }

  // Standard (P1)
  if (p1.length > 0) {
    lines.push('## Standard (P1)');
    for (const todo of p1) {
      const checkbox = todo.status === 'in_progress' ? '[-]' : '[ ]';
      lines.push(`- ${checkbox} ${todo.content}`);
    }
    lines.push('');
  }

  // Nice to Have (P2)
  if (p2.length > 0) {
    lines.push('## Nice to Have (P2)');
    for (const todo of p2) {
      const checkbox = todo.status === 'in_progress' ? '[-]' : '[ ]';
      lines.push(`- ${checkbox} ${todo.content}`);
    }
    lines.push('');
  }

  // Tasks (no priority)
  if (noPriority.length > 0) {
    lines.push('## Tasks');
    for (const todo of noPriority) {
      const checkbox = todo.status === 'in_progress' ? '[-]' : '[ ]';
      lines.push(`- ${checkbox} ${todo.content}`);
    }
    lines.push('');
  }

  // Completed
  if (completed.length > 0) {
    lines.push('## Completed');
    for (const todo of completed) {
      lines.push(`- [x] ${todo.content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parse @fix_plan.md content and return parsed todo items.
 *
 * @param content - Markdown content from @fix_plan.md
 * @param parsePriority - Function to parse priority from content text
 * @param generateTodoId - Function to generate stable todo ID from content
 * @returns Array of parsed todo items
 */
export function importFixPlanMarkdown(
  content: string,
  parsePriority: (content: string) => RalphTodoPriority,
  generateTodoId: (content: string) => string
): RalphTodoItem[] {
  const lines = content.split('\n');
  const newTodos: RalphTodoItem[] = [];
  let currentPriority: RalphTodoPriority = null;

  // Patterns for section headers
  const p0HeaderPattern = /^##\s*(High Priority|Critical|P0)/i;
  const p1HeaderPattern = /^##\s*(Standard|P1|Medium Priority)/i;
  const p2HeaderPattern = /^##\s*(Nice to Have|P2|Low Priority)/i;
  const completedHeaderPattern = /^##\s*Completed/i;
  const tasksHeaderPattern = /^##\s*Tasks/i;

  // Pattern for todo items
  const todoPattern = /^-\s*\[([ x-])\]\s*(.+)$/;

  let inCompletedSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for section headers
    if (p0HeaderPattern.test(trimmed)) {
      currentPriority = 'P0';
      inCompletedSection = false;
      continue;
    }
    if (p1HeaderPattern.test(trimmed)) {
      currentPriority = 'P1';
      inCompletedSection = false;
      continue;
    }
    if (p2HeaderPattern.test(trimmed)) {
      currentPriority = 'P2';
      inCompletedSection = false;
      continue;
    }
    if (completedHeaderPattern.test(trimmed)) {
      inCompletedSection = true;
      continue;
    }
    if (tasksHeaderPattern.test(trimmed)) {
      currentPriority = null;
      inCompletedSection = false;
      continue;
    }

    // Parse todo item
    const match = trimmed.match(todoPattern);
    if (match) {
      const [, checkboxState, todoContent] = match;
      let status: RalphTodoStatus;

      if (inCompletedSection || checkboxState === 'x' || checkboxState === 'X') {
        status = 'completed';
      } else if (checkboxState === '-') {
        status = 'in_progress';
      } else {
        status = 'pending';
      }

      // Parse priority from content if not in a priority section
      const parsedPriority = inCompletedSection ? null : currentPriority || parsePriority(todoContent);

      const id = generateTodoId(todoContent);
      newTodos.push({
        id,
        content: todoContent.trim(),
        status,
        detectedAt: Date.now(),
        priority: parsedPriority,
      });
    }
  }

  return newTodos;
}

/**
 * RalphFixPlanWatcher - Watches @fix_plan.md for changes.
 *
 * Events emitted:
 * - `todosLoaded` - Emits parsed todo items when @fix_plan.md is loaded/changed
 * - `enabled` - Emits when tracker should be auto-enabled (todos loaded from file)
 */
export class RalphFixPlanWatcher extends EventEmitter {
  /** Working directory for @fix_plan.md watching */
  private _workingDir: string | null = null;

  /** Path to the @fix_plan.md file being watched */
  private _fixPlanPath: string | null = null;

  /** File watcher for @fix_plan.md */
  private _fixPlanWatcher: FSWatcher | null = null;

  /** Error handler for FSWatcher (stored for cleanup to prevent memory leak) */
  private _fixPlanWatcherErrorHandler: ((err: Error) => void) | null = null;

  /** Debounce timer for file change events */
  private _fixPlanReloadTimer: NodeJS.Timeout | null = null;

  /** Priority parser injected from parent (for importFixPlanMarkdown) */
  private _parsePriority: (content: string) => RalphTodoPriority;

  /** Todo ID generator injected from parent */
  private _generateTodoId: (content: string) => string;

  constructor(parsePriority: (content: string) => RalphTodoPriority, generateTodoId: (content: string) => string) {
    super();
    this._parsePriority = parsePriority;
    this._generateTodoId = generateTodoId;
  }

  /**
   * When @fix_plan.md is active, treat it as the source of truth for todo status.
   * This prevents output-based detection from overriding file-based status.
   */
  get isFileAuthoritative(): boolean {
    return this._fixPlanPath !== null;
  }

  /**
   * Set the working directory and start watching @fix_plan.md.
   * Automatically loads existing @fix_plan.md if present.
   * @param workingDir - The session's working directory
   */
  setWorkingDir(workingDir: string): void {
    this._workingDir = workingDir;
    this._fixPlanPath = join(workingDir, '@fix_plan.md');

    // Try to load existing @fix_plan.md
    this.loadFixPlanFromDisk();

    // Start watching for changes
    this.startWatchingFixPlan();
  }

  /**
   * Load @fix_plan.md from disk if it exists.
   * Called on initialization and when file changes are detected.
   */
  async loadFixPlanFromDisk(): Promise<number> {
    if (!this._fixPlanPath) return 0;

    try {
      if (!existsSync(this._fixPlanPath)) {
        return 0;
      }

      const content = await readFile(this._fixPlanPath, 'utf-8');
      const todos = importFixPlanMarkdown(content, this._parsePriority, this._generateTodoId);

      if (todos.length > 0) {
        this.emit('todosLoaded', todos);
        console.log(`[RalphFixPlanWatcher] Loaded ${todos.length} todos from @fix_plan.md`);
      }

      return todos.length;
    } catch (err) {
      // File doesn't exist or can't be read - that's OK
      console.log(`[RalphFixPlanWatcher] Could not load @fix_plan.md: ${err}`);
      return 0;
    }
  }

  /**
   * Start watching @fix_plan.md for changes.
   * Reloads todos when the file is modified.
   */
  private startWatchingFixPlan(): void {
    if (!this._fixPlanPath || !this._workingDir) return;

    // Stop existing watcher if any
    this.stopWatchingFixPlan();

    try {
      // Only watch if the file exists
      if (!existsSync(this._fixPlanPath)) {
        // Watch the directory instead for file creation
        this._fixPlanWatcher = fsWatch(this._workingDir, (_eventType, filename) => {
          if (filename === '@fix_plan.md') {
            this.handleFixPlanChange();
          }
        });
      } else {
        // Watch the file directly
        this._fixPlanWatcher = fsWatch(this._fixPlanPath, () => {
          this.handleFixPlanChange();
        });
      }
      // Add error handler to prevent unhandled errors and clean up on failure
      // Store handler reference for proper cleanup in stopWatchingFixPlan()
      if (this._fixPlanWatcher) {
        this._fixPlanWatcherErrorHandler = (err: Error) => {
          console.log(`[RalphFixPlanWatcher] FSWatcher error for @fix_plan.md: ${err.message}`);
          this.stopWatchingFixPlan();
        };
        this._fixPlanWatcher.on('error', this._fixPlanWatcherErrorHandler);
      }
    } catch (err) {
      console.log(`[RalphFixPlanWatcher] Could not watch @fix_plan.md: ${err}`);
    }
  }

  /**
   * Handle @fix_plan.md file change with debouncing.
   */
  private handleFixPlanChange(): void {
    // Debounce rapid changes (e.g., multiple writes)
    if (this._fixPlanReloadTimer) {
      clearTimeout(this._fixPlanReloadTimer);
    }

    this._fixPlanReloadTimer = setTimeout(() => {
      this._fixPlanReloadTimer = null;
      this.loadFixPlanFromDisk();
    }, 500); // 500ms debounce
  }

  /**
   * Stop watching @fix_plan.md.
   */
  stopWatchingFixPlan(): void {
    if (this._fixPlanWatcher) {
      // Remove error handler before closing to prevent memory leak
      if (this._fixPlanWatcherErrorHandler) {
        this._fixPlanWatcher.off('error', this._fixPlanWatcherErrorHandler);
        this._fixPlanWatcherErrorHandler = null;
      }
      this._fixPlanWatcher.close();
      this._fixPlanWatcher = null;
    }
    if (this._fixPlanReloadTimer) {
      clearTimeout(this._fixPlanReloadTimer);
      this._fixPlanReloadTimer = null;
    }
  }

  /**
   * Stop watching and clean up all resources.
   */
  stop(): void {
    this.stopWatchingFixPlan();
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }
}
