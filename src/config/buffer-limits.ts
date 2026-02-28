/**
 * @fileoverview Centralized buffer size limits for memory management.
 *
 * These constants define the maximum sizes for various buffers throughout
 * Codeman. Consolidating them here ensures consistent limits and makes
 * it easy to tune memory usage.
 *
 * Memory Budget Rationale (for 20 concurrent sessions):
 * - Terminal buffer: 2MB max × 20 = 40MB worst case
 * - Text output: 1MB max × 20 = 20MB worst case
 * - Messages: ~1KB each × 1000 × 20 = 20MB worst case
 * - Total buffer overhead: ~80MB (acceptable for long-running server)
 *
 * @module config/buffer-limits
 */

// ============================================================================
// Terminal Buffer Limits
// ============================================================================

/**
 * Maximum terminal buffer size in characters.
 * Contains raw terminal output with ANSI escape sequences.
 * Reduced from 5MB to 2MB for better render performance.
 */
export const MAX_TERMINAL_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Size to trim terminal buffer to when max is exceeded.
 * Keeps the most recent portion to preserve context.
 */
export const TRIM_TERMINAL_TO = 1.5 * 1024 * 1024; // 1.5MB

// ============================================================================
// Text Output Buffer Limits
// ============================================================================

/**
 * Maximum text output buffer size in characters.
 * Contains ANSI-stripped text for search and analysis.
 */
export const MAX_TEXT_OUTPUT_SIZE = 1 * 1024 * 1024; // 1MB

/**
 * Size to trim text output buffer to when max is exceeded.
 */
export const TRIM_TEXT_TO = 768 * 1024; // 768KB

// ============================================================================
// Message Buffer Limits
// ============================================================================

/**
 * Maximum number of Claude JSON messages to keep in memory per session.
 * Older messages are discarded when limit is exceeded.
 */
export const MAX_MESSAGES = 1000;

/**
 * Number of messages to keep when trimming (80% of max).
 */
export const TRIM_MESSAGES_TO = 800;

// ============================================================================
// Line Buffer Limits
// ============================================================================

/**
 * Maximum line buffer size in characters.
 * Prevents unbounded growth for extremely long lines without newlines.
 */
export const MAX_LINE_BUFFER_SIZE = 64 * 1024; // 64KB

// ============================================================================
// Respawn Controller Buffer Limits
// ============================================================================

/**
 * Maximum respawn controller buffer size.
 * Smaller than session buffer since it's only used for idle detection.
 */
export const MAX_RESPAWN_BUFFER_SIZE = 1 * 1024 * 1024; // 1MB

/**
 * Size to trim respawn buffer to when max is exceeded.
 */
export const TRIM_RESPAWN_BUFFER_TO = 512 * 1024; // 512KB
