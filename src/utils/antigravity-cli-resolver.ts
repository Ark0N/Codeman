/**
 * @fileoverview Resolve the Antigravity CLI (`agy`) binary across common install paths.
 *
 * Mirrors gemini-cli-resolver.ts. Google's installer (antigravity.google/cli/install.sh)
 * places the binary at ~/.local/bin/agy; the other locations cover manual installs.
 *
 * @module utils/antigravity-cli-resolver
 */

import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import { createCliExecutableResolver, type CliResolverHost } from './cli-executable-resolver.js';

/** Common directories where the Antigravity CLI binary may be installed */
/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 */
const ANTIGRAVITY_SEARCH_DIRS = (): string[] => (getCli('antigravity')?.discovery.searchDirs ?? []).map(expandHome);

function createAntigravityResolver(host?: CliResolverHost, now?: () => number) {
  return createCliExecutableResolver({ binary: 'agy', searchDirs: ANTIGRAVITY_SEARCH_DIRS, now }, host);
}

/** Creates an isolated Antigravity wrapper around an injected resolver host and clock. */
export function createAntigravityResolverForTest(host: CliResolverHost, now?: () => number) {
  return createAntigravityResolver(host, now);
}

const antigravityResolver = createAntigravityResolver();

/**
 * Finds the directory containing the `agy` binary.
 * Checks `which agy` first, then falls back to common install locations.
 *
 * @returns Directory path, or null if not found
 */
export function resolveAntigravityDir(): string | null {
  return antigravityResolver.resolve()?.directory ?? null;
}

/**
 * Check if the Antigravity CLI is available on the system.
 */
export function isAntigravityAvailable(): boolean {
  return resolveAntigravityDir() !== null;
}
