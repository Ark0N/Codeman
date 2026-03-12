/**
 * @fileoverview Terminal dimension and input validation limits.
 *
 * Used by API routes to validate resize, input, and session
 * creation requests. Separate from buffer-limits.ts which
 * controls memory buffer sizes.
 *
 * @module config/terminal-limits
 */

/** Max input length per API request (bytes) */
export const MAX_INPUT_LENGTH = 64 * 1024;

/** Max session name length (chars) */
export const MAX_SESSION_NAME_LENGTH = 128;
