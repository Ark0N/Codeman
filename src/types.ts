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
  /** Whether to send /clear after update prompt */
  sendClear: boolean;
  /** Whether to send /init after /clear */
  sendInit: boolean;
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

// Error codes for consistent error handling
export enum ApiErrorCode {
  NOT_FOUND = 'NOT_FOUND',
  INVALID_INPUT = 'INVALID_INPUT',
  SESSION_BUSY = 'SESSION_BUSY',
  OPERATION_FAILED = 'OPERATION_FAILED',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

// Mapping of error codes to user-friendly messages
export const ErrorMessages: Record<ApiErrorCode, string> = {
  [ApiErrorCode.NOT_FOUND]: 'The requested resource was not found',
  [ApiErrorCode.INVALID_INPUT]: 'Invalid input provided',
  [ApiErrorCode.SESSION_BUSY]: 'Session is currently busy',
  [ApiErrorCode.OPERATION_FAILED]: 'The operation failed',
  [ApiErrorCode.ALREADY_EXISTS]: 'Resource already exists',
  [ApiErrorCode.INTERNAL_ERROR]: 'An internal error occurred',
};

// API Request/Response types for type safety
export interface CreateSessionRequest {
  workingDir?: string;
}

export interface RunPromptRequest {
  prompt: string;
}

export interface SessionInputRequest {
  input: string;
}

export interface ResizeRequest {
  cols: number;
  rows: number;
}

export interface CreateCaseRequest {
  name: string;
  description?: string;
}

export interface QuickStartRequest {
  caseName?: string;
}

export interface CreateScheduledRunRequest {
  prompt: string;
  workingDir?: string;
  durationMinutes: number;
}

export interface QuickRunRequest {
  prompt: string;
  workingDir?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  error?: string;
  errorCode?: ApiErrorCode;
  data?: T;
}

// Helper functions for creating consistent error responses
export function createErrorResponse(code: ApiErrorCode, details?: string): ApiResponse {
  return {
    success: false,
    error: details || ErrorMessages[code],
    errorCode: code,
  };
}

export function createSuccessResponse<T>(data?: T): ApiResponse<T> {
  return {
    success: true,
    data,
  };
}

export interface SessionResponse {
  success: boolean;
  session?: SessionState & {
    claudeSessionId: string | null;
    totalCost: number;
    textOutput: string;
    terminalBuffer: string;
    messageCount: number;
    isWorking: boolean;
    lastPromptTime: number;
  };
  error?: string;
}

export interface QuickStartResponse {
  success: boolean;
  sessionId?: string;
  casePath?: string;
  caseName?: string;
  error?: string;
}

export interface CaseInfo {
  name: string;
  path: string;
  hasClaudeMd?: boolean;
}

// Screen session types for GNU screen wrapping
export interface ScreenSession {
  sessionId: string;        // Claudeman session ID
  screenName: string;       // GNU screen session name
  pid: number;              // Screen process PID
  createdAt: number;
  workingDir: string;
  mode: 'claude' | 'shell';
  attached: boolean;        // Whether webserver is attached
  name?: string;            // Session display name (tab name)
}

export interface ProcessStats {
  memoryMB: number;         // Memory usage in MB
  cpuPercent: number;       // CPU usage percentage
  childCount: number;       // Number of child processes
  updatedAt: number;
}

export interface ScreenSessionWithStats extends ScreenSession {
  stats?: ProcessStats;
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
    enabled: false,                // disabled by default
    sendClear: true,               // send /clear after update prompt
    sendInit: true,                // send /init after /clear
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
