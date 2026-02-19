/**
 * @fileoverview Shared regex patterns for terminal and token parsing.
 *
 * Pre-compiled patterns avoid re-compilation overhead on each use.
 * Import these patterns instead of defining them locally.
 *
 * @module utils/regex-patterns
 */

/**
 * Comprehensive ANSI escape pattern that handles:
 * - SGR (colors/styles): ESC [ params m
 * - CSI sequences (cursor, scroll, etc.): ESC [ params letter
 * - OSC sequences (title, etc.): ESC ] ... BEL or ESC ] ... ST
 * - Single-char escapes: ESC = or ESC >
 *
 * Use this when you need complete ANSI stripping including OSC sequences.
 * Note: Has global flag - reset lastIndex before exec() if reusing.
 */
export const ANSI_ESCAPE_PATTERN_FULL = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[=>])/g;

/**
 * Simple ANSI CSI-only pattern for basic escape code stripping.
 * Matches: ESC [ params letter (e.g., colors, cursor movement)
 *
 * Use this for faster stripping when OSC sequences aren't a concern.
 * Note: Has global flag - reset lastIndex before exec() if reusing.
 */
export const ANSI_ESCAPE_PATTERN_SIMPLE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Pattern to extract token count from Claude's status line.
 * Matches: "123.4k tokens", "5234 tokens", "1.2M tokens"
 *
 * Capture groups:
 * - Group 1: The numeric value (e.g., "123.4", "5234", "1.2")
 * - Group 2: Optional suffix (k, K, m, M) or undefined
 */
export const TOKEN_PATTERN = /(\d+(?:\.\d+)?)\s*([kKmM])?\s*tokens/;

/**
 * Creates a fresh copy of ANSI_ESCAPE_PATTERN_FULL.
 * Use when you need a pattern without shared lastIndex state.
 */
export function createAnsiPatternFull(): RegExp {
  return /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[=>])/g;
}

/**
 * Creates a fresh copy of ANSI_ESCAPE_PATTERN_SIMPLE.
 * Use when you need a pattern without shared lastIndex state.
 */
export function createAnsiPatternSimple(): RegExp {
  return /\x1b\[[0-9;]*[A-Za-z]/g;
}

/**
 * Strips ANSI escape codes from text using the comprehensive pattern.
 * @param text - Text containing ANSI escape codes
 * @returns Text with ANSI codes removed
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN_FULL, '');
}

/**
 * Regex to validate safe file paths (no shell metacharacters).
 * Shared by schemas.ts and tmux-manager.ts for consistent path validation.
 */
export const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_\/\-. ~]+$/;

