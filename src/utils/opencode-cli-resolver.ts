/**
 * @fileoverview Resolve the OpenCode CLI binary across common install paths.
 *
 * Mirrors claude-cli-resolver.ts pattern. Finds the `opencode` binary
 * and provides an augmented PATH string for tmux sessions.
 *
 * @module utils/opencode-cli-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Timeout for exec commands (5 seconds) */
const EXEC_TIMEOUT_MS = 5000;

/** Common directories where the OpenCode CLI binary may be installed */
const OPENCODE_SEARCH_DIRS = [
  join(homedir(), '.opencode', 'bin'), // Default install location
  join(homedir(), '.local', 'bin'), // Alternative install location
  '/usr/local/bin', // Homebrew / system
  join(homedir(), 'go', 'bin'), // Go install
  join(homedir(), '.bun', 'bin'), // Bun global
  join(homedir(), '.npm-global', 'bin'), // npm global
  join(homedir(), 'bin'), // User bin
];

/** Cached directory containing the opencode binary (empty string = searched but not found) */
let _openCodeDir: string | null = null;

/**
 * Finds the directory containing the `opencode` binary.
 * Checks `which opencode` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function resolveOpenCodeDir(): string | null {
  if (_openCodeDir !== null) return _openCodeDir || null;

  // Try `which` first (respects current PATH)
  try {
    const result = execSync('which opencode', {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (result && existsSync(result)) {
      _openCodeDir = dirname(result);
      return _openCodeDir;
    }
  } catch {
    // OpenCode not in PATH, will check common locations
  }

  // Fallback: check common installation directories
  for (const dir of OPENCODE_SEARCH_DIRS) {
    if (existsSync(join(dir, 'opencode'))) {
      _openCodeDir = dir;
      return _openCodeDir;
    }
  }

  _openCodeDir = ''; // mark as searched, not found
  return null;
}

/**
 * Check if OpenCode CLI is available on the system.
 */
export function isOpenCodeAvailable(): boolean {
  return resolveOpenCodeDir() !== null;
}

/**
 * Returns a PATH string that includes the directory containing `opencode`.
 *
 * Finds the opencode binary (via `which` or common install locations), then
 * prepends its directory to the current PATH if not already present.
 * Result is cached for subsequent calls.
 */
export function getOpenCodeAugmentedPath(): string {
  const currentPath = process.env.PATH || '';
  const dir = resolveOpenCodeDir();

  if (dir && !currentPath.split(delimiter).includes(dir)) {
    return `${dir}${delimiter}${currentPath}`;
  }

  return currentPath;
}

/**
 * Reset cached resolution (for testing).
 */
export function resetOpenCodeCache(): void {
  _openCodeDir = null;
}
