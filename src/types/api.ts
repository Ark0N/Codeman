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
  /** Session is currently busy */
  SESSION_BUSY = 'SESSION_BUSY',
  /** Operation failed */
  OPERATION_FAILED = 'OPERATION_FAILED',
  /** Resource already exists */
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  /** Internal server error */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * User-friendly error messages for each error code
 */
const ErrorMessages: Record<ApiErrorCode, string> = {
  [ApiErrorCode.NOT_FOUND]: 'The requested resource was not found',
  [ApiErrorCode.INVALID_INPUT]: 'Invalid input provided',
  [ApiErrorCode.SESSION_BUSY]: 'Session is currently busy',
  [ApiErrorCode.OPERATION_FAILED]: 'The operation failed',
  [ApiErrorCode.ALREADY_EXISTS]: 'Resource already exists',
  [ApiErrorCode.INTERNAL_ERROR]: 'An internal error occurred',
};

/**
 * Hook event types triggered by Claude Code's hooks system
 */
export type HookEventType =
  | 'idle_prompt'
  | 'permission_prompt'
  | 'elicitation_dialog'
  | 'stop'
  | 'teammate_idle'
  | 'task_completed';

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
 * Response for quick start operation
 */
export interface QuickStartResponse {
  /** Whether the request succeeded */
  success: boolean;
  /** Created session ID */
  sessionId?: string;
  /** Path to case folder */
  casePath?: string;
  /** Case name */
  caseName?: string;
  /** Error message if failed */
  error?: string;
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
}

// ========== Error Handling Utilities ==========

/**
 * Type guard to check if a value is an Error instance
 * @param value The value to check
 * @returns True if the value is an Error instance
 */
export function isError(value: unknown): value is Error {
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
