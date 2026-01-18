export type SessionStatus = 'idle' | 'busy' | 'stopped' | 'error';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export type RalphLoopStatus = 'stopped' | 'running' | 'paused';

export interface SessionConfig {
  id: string;
  workingDir: string;
  createdAt: number;
}

export interface SessionState {
  id: string;
  pid: number | null;
  status: SessionStatus;
  workingDir: string;
  currentTaskId: string | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface TaskDefinition {
  id: string;
  prompt: string;
  workingDir: string;
  priority: number;
  dependencies: string[];
  completionPhrase?: string;
  timeoutMs?: number;
}

export interface TaskState {
  id: string;
  prompt: string;
  workingDir: string;
  priority: number;
  dependencies: string[];
  completionPhrase?: string;
  timeoutMs?: number;
  status: TaskStatus;
  assignedSessionId: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  output: string;
  error: string | null;
}

export interface RalphLoopState {
  status: RalphLoopStatus;
  startedAt: number | null;
  minDurationMs: number | null;
  tasksCompleted: number;
  tasksGenerated: number;
  lastCheckAt: number | null;
}

export interface AppState {
  sessions: Record<string, SessionState>;
  tasks: Record<string, TaskState>;
  ralphLoop: RalphLoopState;
  config: AppConfig;
}

export interface RespawnConfig {
  /** How long to wait after seeing prompt before considering truly idle (ms) */
  idleTimeoutMs: number;
  /** The prompt to send for updating docs */
  updatePrompt: string;
  /** Delay between sending steps (ms) */
  interStepDelayMs: number;
  /** Whether to enable respawn loop */
  enabled: boolean;
}

export interface AppConfig {
  pollIntervalMs: number;
  defaultTimeoutMs: number;
  maxConcurrentSessions: number;
  stateFilePath: string;
  respawn: RespawnConfig;
}

export interface SessionOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface TaskAssignment {
  sessionId: string;
  taskId: string;
  assignedAt: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  pollIntervalMs: 1000,
  defaultTimeoutMs: 300000, // 5 minutes
  maxConcurrentSessions: 5,
  stateFilePath: '',
  respawn: {
    idleTimeoutMs: 5000,           // 5 seconds of no activity after prompt
    updatePrompt: 'update all the docs and CLAUDE.md',
    interStepDelayMs: 1000,        // 1 second between steps
    enabled: true,
  },
};

export function createInitialState(): AppState {
  return {
    sessions: {},
    tasks: {},
    ralphLoop: {
      status: 'stopped',
      startedAt: null,
      minDurationMs: null,
      tasksCompleted: 0,
      tasksGenerated: 0,
      lastCheckAt: null,
    },
    config: { ...DEFAULT_CONFIG },
  };
}
