/**
 * @fileoverview Pure utility functions for terminal pattern detection in respawn controller.
 *
 * Extracted from respawn-controller.ts for modularity. These are stateless functions
 * and constants used to detect completion messages, working patterns, and token counts
 * in terminal output.
 *
 * @module respawn-patterns
 */

import { TOKEN_PATTERN } from './utils/index.js';

// ========== Constants ==========

/**
 * Pattern to detect completion messages from Claude Code.
 * Requires "Worked for" prefix to avoid false positives from bare time durations
 * in regular text (e.g., "wait for 5s", "run for 2m").
 *
 * Matches: "Worked for 2m 46s", "Worked for 46s", "Worked for 1h 2m 3s"
 * Does NOT match: "wait for 5s", "run for 2m", "for 3s the system..."
 */
const COMPLETION_TIME_PATTERN = /\bWorked\s+for\s+\d+[hms](\s*\d+[hms])*/i;

/**
 * Patterns indicating Claude is ready for input (legacy fallback).
 * Used as secondary signals, not primary detection.
 */
export const PROMPT_PATTERNS = [
  '❯', // Standard prompt
  '\u276f', // Unicode variant
  '⏵', // Claude Code prompt variant
];

/**
 * Patterns indicating Claude is actively working.
 * When detected, resets all idle detection timers.
 * Note: ✻ and ✽ removed - they appear in completion messages too.
 */
export const WORKING_PATTERNS = [
  'Thinking',
  'Writing',
  'Reading',
  'Running',
  'Searching',
  'Editing',
  'Creating',
  'Deleting',
  'Analyzing',
  'Executing',
  'Synthesizing',
  'Brewing', // Claude's processing indicators
  'Compiling',
  'Building',
  'Installing',
  'Fetching',
  'Downloading',
  'Processing',
  'Generating',
  'Loading',
  'Starting',
  'Updating',
  'Checking',
  'Validating',
  'Testing',
  'Formatting',
  'Linting',
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏', // Spinner chars
  '◐',
  '◓',
  '◑',
  '◒', // Alternative spinners
  '⣾',
  '⣽',
  '⣻',
  '⢿',
  '⡿',
  '⣟',
  '⣯',
  '⣷', // Braille spinners
];

/**
 * Check if data contains a completion message pattern.
 * Matches "Worked for Xh Xm Xs" time duration patterns.
 *
 * @param data - Raw terminal output data
 * @returns True if completion message pattern is found
 */
export function isCompletionMessage(data: string): boolean {
  return COMPLETION_TIME_PATTERN.test(data);
}

/**
 * Check if a rolling window of terminal output contains working patterns.
 * The rolling window catches patterns split across chunks (e.g., "Thin" + "king").
 *
 * @param window - Rolling window of recent terminal output (already includes current data)
 * @returns True if any working pattern is found in the window
 */
export function hasWorkingPattern(window: string): boolean {
  return WORKING_PATTERNS.some((pattern) => window.includes(pattern));
}

/**
 * Extract token count from data if present.
 * Parses patterns like "123.4k tokens" or "1.5M tokens".
 *
 * @param data - Raw terminal output data
 * @returns Parsed token count, or null if no token pattern found
 */
export function extractTokenCount(data: string): number | null {
  const match = data.match(TOKEN_PATTERN);
  if (!match) return null;

  let count = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') count *= 1000;
  else if (suffix === 'm') count *= 1000000;

  return Math.round(count);
}
