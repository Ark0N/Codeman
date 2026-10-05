/**
 * @fileoverview API types and error handling.
 *
 * Defines the standardized API response envelope (ApiResponse), error codes,
 * hook event types from Claude Code's hooks system, and utility functions
 * for error message extraction. Used by all route modules in `src/web/routes/`.
 *
 * Key exports:
 * - ApiResponse<T> — discriminated union envelope (success with data or error with code)
 * - ApiErrorCode — enum of standard error codes with user-friendly messages
 * - HookEventType — union of Claude Code hook event names (idle_prompt, stop, etc.)
 * - createErrorResponse() — factory for consistent error responses
 * - getErrorMessage() — safe extraction from unknown catch values
 * - CaseInfo, QuickStartResponse — case folder metadata types
 *
 * No dependencies on other domain modules. Consumed by all route modules
 * and validated via Zod schemas in `src/web/schemas.ts`.
 */

/**
 * Standard error codes for API responses
 */
export enum ApiErrorCode {
  /** Resource not found */
  NOT_FOUND = 'NOT_FOUND',
  /** Invalid input provided */
  INVALID_INPUT = 'INVALID_INPUT',
  /** Authentication required or failed */
  UNAUTHORIZED = 'UNAUTHORIZED',
  /** Session is currently busy */
  SESSION_BUSY = 'SESSION_BUSY',
  /** Request conflicts with current state (e.g. already running) */
  CONFLICT = 'CONFLICT',
  /** Resource already exists */
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  /** Too many requests / rate limited */
  RATE_LIMITED = 'RATE_LIMITED',
  /** Operation could not be completed (well-formed but unprocessable) */
  OPERATION_FAILED = 'OPERATION_FAILED',
  /** Authenticated but not permitted (e.g. non-admin hitting an admin route) */
  FORBIDDEN = 'FORBIDDEN',
  /** User must change their password before any other action (multi-user) */
  PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED',
  /** A user with this name already exists (multi-user) */
  USER_EXISTS = 'USER_EXISTS',
  /** No user with this name (multi-user) */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** Refusing to demote/disable/delete the last enabled admin (multi-user) */
  LAST_ADMIN = 'LAST_ADMIN',
  /** Internal server error */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * User-friendly error messages for each error code
 */
const ErrorMessages: Record<ApiErrorCode, string> = {
  [ApiErrorCode.NOT_FOUND]: 'The requested resource was not found',
  [ApiErrorCode.INVALID_INPUT]: 'Invalid input provided',
  [ApiErrorCode.UNAUTHORIZED]: 'Authentication required',
  [ApiErrorCode.SESSION_BUSY]: 'Session is currently busy',
  [ApiErrorCode.CONFLICT]: 'Request conflicts with the current state',
  [ApiErrorCode.ALREADY_EXISTS]: 'Resource already exists',
  [ApiErrorCode.RATE_LIMITED]: 'Too many requests',
  [ApiErrorCode.OPERATION_FAILED]: 'The operation failed',
  [ApiErrorCode.FORBIDDEN]: 'You do not have permission to perform this action',
  [ApiErrorCode.PASSWORD_CHANGE_REQUIRED]: 'You must change your password before continuing',
  [ApiErrorCode.USER_EXISTS]: 'A user with that name already exists',
  [ApiErrorCode.USER_NOT_FOUND]: 'No such user',
  [ApiErrorCode.LAST_ADMIN]: 'Cannot remove the last enabled admin',
  [ApiErrorCode.INTERNAL_ERROR]: 'An internal error occurred',
};

/**
 * Maps each API error code to its HTTP status. Single source of truth for the
 * stable HTTP contract (see docs/api-reference.md). Applied centrally so every
 * error response carries a conventional 4xx/5xx status, not 200.
 */
const ErrorStatus: Record<ApiErrorCode, number> = {
  [ApiErrorCode.INVALID_INPUT]: 400,
  [ApiErrorCode.UNAUTHORIZED]: 401,
  [ApiErrorCode.NOT_FOUND]: 404,
  [ApiErrorCode.SESSION_BUSY]: 409,
  [ApiErrorCode.CONFLICT]: 409,
  [ApiErrorCode.ALREADY_EXISTS]: 409,
  [ApiErrorCode.OPERATION_FAILED]: 422,
  [ApiErrorCode.FORBIDDEN]: 403,
  [ApiErrorCode.PASSWORD_CHANGE_REQUIRED]: 403,
  [ApiErrorCode.USER_EXISTS]: 409,
  [ApiErrorCode.USER_NOT_FOUND]: 404,
  [ApiErrorCode.LAST_ADMIN]: 409,
  [ApiErrorCode.RATE_LIMITED]: 429,
  [ApiErrorCode.INTERNAL_ERROR]: 500,
};

/** HTTP status for an API error code (defaults to 400 for unknown codes). */
export function httpStatusForErrorCode(code: ApiErrorCode): number {
  return ErrorStatus[code] ?? 400;
}

/**
 * Hook event types triggered by Claude Code's hooks system
 */
export type HookEventType =
  | 'idle_prompt'
  | 'permission_prompt'
  | 'elicitation_dialog'
  | 'elicitation_complete'
  | 'elicitation_response'
  | 'stop'
  | 'teammate_idle'
  | 'task_completed'
  // Claude Code's UserPromptSubmit. The payload's `session_id` is the pane's
  // LIVE conversation id, reported by the CLI process itself, so it survives a
  // `/clear` without any cwd/timestamp correlation.
  | 'prompt_submitted'
  // No Claude Code hook behind this one: it is the DeepSeek status bridge's
  // "a turn STARTED" report (see deepseek-status-shim.ts). Keep in step with
  // HookEventSchema in web/schemas.ts.
  | 'agent_working';

// ========== API Response Types ==========

/**
 * Standard API response wrapper (discriminated union for type safety)
 * @template T Type of the data payload
 */
export type ApiResponse<T = unknown> =
  | { success: true; data?: T }
  | { success: false; error: string; errorCode: ApiErrorCode };

/**
 * Creates a standardized error response
 * @param code Error code
 * @param details Optional detailed error message
 * @returns Formatted error response
 */
export function createErrorResponse(code: ApiErrorCode, details?: string): ApiResponse<never> {
  return {
    success: false,
    error: details || ErrorMessages[code],
    errorCode: code,
  };
}

/**
 * Information about a case folder
 */
export interface CaseInfo {
  /** Case name */
  name: string;
  /** Full path to case folder */
  path: string;
  /** Whether CLAUDE.md exists */
  hasClaudeMd?: boolean;
  /** Case storage/execution location */
  location?: 'local' | 'linked-local' | 'remote' | 'docker';
  /** Whether this is a linked local folder */
  linked?: boolean;
  /**
   * The case folder did not answer (an unreachable network mount, or an error other
   * than "no such file"), so whether it still exists is unknown. Absent = it answered.
   */
  unreachable?: boolean;
  /**
   * Present when Codeman scaffolded this case directory for an AGENT-spawned session
   * (the packaged skill's workers, or any spawn naming a parent session), read back
   * from the case's own marker file — see `src/agent-case-marker.ts`. Absent for every
   * case a human created, linked or cloned, which is what makes it usable as the
   * "safe to clean up" signal in the Manage tab.
   */
  agentCreated?: {
    createdAt: string;
    createdBy: string;
    parentSessionId?: string;
    parentSessionName?: string;
    mode?: string;
  };
  /** Remote case metadata for display and session creation */
  remote?: {
    hostId: string;
    host: string;
    username: string;
    path: string;
  };
  /** Docker case metadata for display and session creation */
  docker?: {
    hostId: string;
    container: string;
    image?: string;
    path: string;
    /** Directory INSIDE the container (defaults to `path` when unset). */
    containerWorkdir?: string;
    network?: string;
    /**
     * CLIs available INSIDE the container. A container case runs its agents in
     * the container, so HOST CLI availability says nothing about what it can
     * run. Absent = unknown (an owned container runs our base image, which ships
     * every CLI), which the UI reads as "do not gate".
     */
    availableModes?: string[];
    /**
     * `false` for an ADOPTED container (mirror of `DockerCase.owned`); absent = owned.
     *
     * ⚠️ The UI needs this to read a FAILED container probe correctly. For an adopted
     * case a missing container is a real fault worth reporting, because the user is the
     * only one who can start it. For an owned case it is the NORMAL state before the
     * first session: the container is created on demand by the launch chain, so treating
     * "not found" as a fault there hid every agent mode behind an error telling the user
     * to start a container Codeman was about to create itself.
     *
     * It also gates the Add Case panel's "copy an existing case" picker: only an ADOPTED
     * container may back several cases at once (`classifyAdoptContainerConflict`), since an
     * owned container's lifecycle belongs to its one case.
     */
    owned?: boolean;
  };
}

/**
 * One agent-created case as `GET /api/cases/agent-created` reports it: the cleanup
 * view over `CaseInfo.agentCreated`, with the two facts a human needs before deleting
 * a directory — whether an agent is still working in it, and when it was last touched.
 */
export interface AgentCaseSummary {
  name: string;
  path: string;
  createdAt: string;
  createdBy: string;
  parentSessionId?: string;
  parentSessionName?: string;
  mode?: string;
  /** A live session's working directory is this case — deleting it would pull the rug. */
  inUse: boolean;
  /** Directory mtime, so "nothing has touched this in a week" is answerable. */
  modifiedAt?: string;
}

// ========== Error Handling Utilities ==========

/**
 * Type guard to check if a value is an Error instance
 * @param value The value to check
 * @returns True if the value is an Error instance
 */
function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Safely extracts an error message from an unknown caught value.
 * Handles the TypeScript 4.4+ unknown error type in catch blocks.
 *
 * @param error The caught error (type unknown in strict mode)
 * @returns A string error message
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   console.error('Failed:', getErrorMessage(err));
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'An unknown error occurred';
}
