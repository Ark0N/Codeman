/**
 * @fileoverview Task queue type definitions.
 *
 * Types for the prompt execution queue: TaskDefinition (input) and
 * TaskState (persisted state with execution details).
 *
 * Key exports:
 * - TaskDefinition — input type for creating a task (prompt, workingDir, priority, dependencies)
 * - TaskState — persisted state with execution details (status, assignedSessionId, output, error)
 * - TaskStatus — 'pending' | 'running' | 'completed' | 'failed'
 *
 * Cross-domain relationships:
 * - TaskState.assignedSessionId links to SessionState.id (session domain)
 * - TaskState is stored in AppState.tasks (app-state domain)
 *
 * Persisted to `~/.codeman/state.json`. No dependencies on other domain modules.
 */

/** Status of a task in the queue */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Definition of a task to be executed
 */
export interface TaskDefinition {
  /** Unique task identifier */
  id: string;
  /** Prompt to send to Claude */
  prompt: string;
  /** Working directory for task execution */
  workingDir: string;
  /** Priority level (higher = processed first) */
  priority: number;
  /** IDs of tasks that must complete first */
  dependencies: string[];
  /** Custom phrase to detect task completion */
  completionPhrase?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Full state of a task including execution details
 */
export interface TaskState {
  /** Unique task identifier */
  id: string;
  /** Prompt sent to Claude */
  prompt: string;
  /** Working directory for task execution */
  workingDir: string;
  /** Priority level (higher = processed first) */
  priority: number;
  /** IDs of tasks that must complete first */
  dependencies: string[];
  /** Custom phrase to detect task completion */
  completionPhrase?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Current task status */
  status: TaskStatus;
  /** ID of session running this task, null if not assigned */
  assignedSessionId: string | null;
  /** Timestamp when task was created */
  createdAt: number;
  /** Timestamp when task started executing */
  startedAt: number | null;
  /** Timestamp when task completed */
  completedAt: number | null;
  /** Captured output from Claude */
  output: string;
  /** Error message if task failed */
  error: string | null;
}
