/**
 * @fileoverview Token validation constants.
 *
 * Claude's context window is 200k tokens, or 1M with extended context.
 *
 * @module utils/token-validation
 */

/**
 * Maximum tokens allowed per session.
 * The largest context Claude reports today is 1M, the upper bound for validation.
 */
export const MAX_SESSION_TOKENS = 1_000_000;
