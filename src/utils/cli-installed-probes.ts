/**
 * @fileoverview One answer to "is this CLI installed here?", shared by the page render
 * (`renderIndexHtml` in server.ts, which injects `window.__codemanCliAvailable` and
 * `window.__codemanCliCatalog`) and `GET /api/clis` (the Settings list's badge).
 *
 * The two used to keep their own copies of the per-CLI probe map, so they could drift apart
 * and the badge could disagree with the Run menu.
 *
 * Every probe is a memoized resolver, so this is cheap to call per request. Dynamic imports
 * keep the nine resolvers out of any module that never asks.
 */

import type { CliEntry } from '../config/cli-registry/types.js';
import { isCliAvailable as isRegistryCliAvailable } from './cli-resolver.js';

/**
 * The stock CLIs whose own resolver answers availability. It keeps the resolver's specific
 * semantics (pi/grok/deepseek identity probes). DeepSeek reports RUNNABLE here, not merely
 * installed: `dsh` is a profile launcher, and a dsh with no pane-capable profile would
 * offer a Run button that spawns a pane which dies on arrival.
 */
export async function probeStockCliAvailability(): Promise<Record<string, boolean>> {
  const [
    { isClaudeAvailable },
    { isOpenCodeAvailable },
    { isCodexAvailable },
    { isGeminiAvailable },
    { isAntigravityAvailable },
    { isPiAvailable },
    { isGrokAvailable },
    { isDeepSeekRunnable },
    { isOmpAvailable },
  ] = await Promise.all([
    import('./claude-cli-resolver.js'),
    import('./opencode-cli-resolver.js'),
    import('./codex-cli-resolver.js'),
    import('./gemini-cli-resolver.js'),
    import('./antigravity-cli-resolver.js'),
    import('./pi-cli-resolver.js'),
    import('./grok-cli-resolver.js'),
    import('./deepseek-cli-resolver.js'),
    import('./omp-cli-resolver.js'),
  ]);
  return {
    claude: isClaudeAvailable(),
    opencode: isOpenCodeAvailable(),
    codex: isCodexAvailable(),
    gemini: isGeminiAvailable(),
    antigravity: isAntigravityAvailable(),
    pi: isPiAvailable(),
    grok: isGrokAvailable(),
    deepseek: isDeepSeekRunnable(),
    omp: isOmpAvailable(),
  };
}

/**
 * Is `entry` installed? A shell entry has no binary to probe, since it is the server's own
 * login shell. A stock entry with a dedicated resolver uses `stockAvailability`. Anything
 * else, custom entries included, uses the registry's GENERIC resolver. That is the one a
 * session spawn uses, and it understands the entry's declared binaries and search dirs.
 */
export function isCliEntryInstalled(entry: CliEntry, stockAvailability: Record<string, boolean>): boolean {
  if (entry.kind === 'shell') return true;
  const id = entry.id as string;
  return Object.prototype.hasOwnProperty.call(stockAvailability, id)
    ? stockAvailability[id]
    : isRegistryCliAvailable(id);
}
