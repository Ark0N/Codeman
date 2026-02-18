/**
 * @fileoverview Shared Claude CLI binary resolution.
 *
 * Finds the `claude` binary across common installation paths and provides
 * an augmented PATH string. Used by session.ts and tmux-manager.ts
 * to locate the Claude CLI.
 *
 * @module utils/claude-cli-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Timeout for exec commands (5 seconds) */
const EXEC_TIMEOUT_MS = 5000;

/** Common directories where the Claude CLI binary may be installed */
const CLAUDE_SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.claude', 'local'),
  '/usr/local/bin',
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), 'bin'),
];

/** Cached directory containing the claude binary (empty string = searched but not found) */
let _claudeDir: string | null = null;

/**
 * Finds the directory containing the `claude` binary.
 * Checks `which claude` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function findClaudeDir(): string | null {
  if (_claudeDir !== null) return _claudeDir || null;

  // Try `which` first (respects current PATH)
  try {
    const result = execSync('which claude', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
    if (result && existsSync(result)) {
      _claudeDir = dirname(result);
      return _claudeDir;
    }
  } catch {
    // Claude not in PATH, will check common locations
  }

  // Fallback: check common installation directories
  for (const dir of CLAUDE_SEARCH_DIRS) {
    if (existsSync(join(dir, 'claude'))) {
      _claudeDir = dir;
      return _claudeDir;
    }
  }

  _claudeDir = '';  // mark as searched, not found
  return null;
}

/** Cached augmented PATH string */
let _augmentedPath: string | null = null;

/**
 * Returns a PATH string that includes the directory containing `claude`.
 *
 * Finds the claude binary (via `which` or common install locations), then
 * prepends its directory to the current PATH if not already present.
 * Result is cached for subsequent calls.
 */
export function getAugmentedPath(): string {
  if (_augmentedPath) return _augmentedPath;

  const currentPath = process.env.PATH || '';
  const claudeDir = findClaudeDir();

  if (claudeDir && !currentPath.split(delimiter).includes(claudeDir)) {
    _augmentedPath = `${claudeDir}${delimiter}${currentPath}`;
    return _augmentedPath;
  }

  _augmentedPath = currentPath;
  return _augmentedPath;
}
