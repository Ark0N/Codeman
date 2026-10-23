/**
 * @fileoverview Authentication, rate limiting, and hook security constants.
 *
 * Controls auth session lifecycle, brute-force protection,
 * and Claude Code hook timeouts.
 *
 * @module config/auth-config
 */

// ============================================================================
// Session Cookies
// ============================================================================

/** Auth session cookie TTL — matches autonomous run length (ms) */
export const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Max concurrent auth sessions per server */
export const MAX_AUTH_SESSIONS = 100;

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Max failed auth attempts per bucket before 429 rejection. Applies to the
 * single-user per-IP bucket, the multi-user per-username lockout and the
 * hook-secret bucket.
 */
export const AUTH_FAILURE_MAX = 10;

/**
 * Max failed login attempts per client IP for the multi-user pre-gate, which
 * runs before the scrypt verify and so refuses even a correct password once
 * reached. Wider than AUTH_FAILURE_MAX because one egress IP (NAT, a tunnel) can
 * carry many users' failures; the per-username bucket still caps guesses against
 * each account at AUTH_FAILURE_MAX. Single-user mode does not use this.
 */
export const AUTH_IP_FAILURE_MAX = 50;

/** Failed auth attempt tracking window (ms) */
export const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;

// ============================================================================
// Hooks
// ============================================================================

/**
 * Timeout for Claude Code hook curl commands, in SECONDS: the hook `timeout`
 * field is seconds (the CLI multiplies by 1000). The predecessor constant
 * `HOOK_TIMEOUT_MS = 10000` fed the same field, so those hooks effectively had a
 * ~2.8-hour timeout; 10 seconds is the originally intended budget.
 */
export const HOOK_TIMEOUT_SECONDS = 10;
