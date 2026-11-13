/**
 * @fileoverview Resolve the OpenCode CLI binary across common install paths.
 *
 * Mirrors claude-cli-resolver.ts pattern. Finds the `opencode` binary
 * and provides an augmented PATH string for tmux sessions.
 *
 * @module utils/opencode-cli-resolver
 */

import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import { createCliExecutableResolver } from './cli-executable-resolver.js';

/** Common directories where the OpenCode CLI binary may be installed */
/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 */
const OPENCODE_SEARCH_DIRS = (): string[] => (getCli('opencode')?.discovery.searchDirs ?? []).map(expandHome);

const openCodeResolver = createCliExecutableResolver({ binary: 'opencode', searchDirs: OPENCODE_SEARCH_DIRS });

/**
 * Finds the directory containing the `opencode` binary.
 * Checks `which opencode` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function resolveOpenCodeDir(): string | null {
  return openCodeResolver.resolve()?.directory ?? null;
}

/**
 * Check if OpenCode CLI is available on the system.
 */
export function isOpenCodeAvailable(): boolean {
  return resolveOpenCodeDir() !== null;
}
