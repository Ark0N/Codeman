/**
 * @fileoverview Resolve the Gemini CLI binary across common install paths.
 *
 * Mirrors codex-cli-resolver.ts and opencode-cli-resolver.ts. Finds the
 * `gemini` binary and provides an augmented PATH directory for tmux sessions.
 *
 * @module utils/gemini-cli-resolver
 */

import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import { createCliExecutableResolver } from './cli-executable-resolver.js';

/** Common directories where the Gemini CLI binary may be installed */
/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 */
const GEMINI_SEARCH_DIRS = (): string[] => (getCli('gemini')?.discovery.searchDirs ?? []).map(expandHome);

const geminiResolver = createCliExecutableResolver({ binary: 'gemini', searchDirs: GEMINI_SEARCH_DIRS });

/**
 * Finds the directory containing the `gemini` binary.
 * Checks `which gemini` first, then falls back to common install locations.
 *
 * @returns Directory path, or null if not found
 */
export function resolveGeminiDir(): string | null {
  return geminiResolver.resolve()?.directory ?? null;
}

/**
 * Check if Gemini CLI is available on the system.
 */
export function isGeminiAvailable(): boolean {
  return resolveGeminiDir() !== null;
}
