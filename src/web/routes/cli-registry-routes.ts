/**
 * @fileoverview CLI management (docs/cli-enable-disable-plan.md) — "PR C" from the
 * original #343 review, done in phases with the trust-model scope decided up front
 * (see that doc's "Decisions" section) rather than folded into a large diff.
 *
 * This file currently holds Phase 2 only: `GET /api/clis`, a read-only list of
 * every registry entry (stock + custom, enabled or not) for the Settings UI.
 * Phase 3 (write: enable/disable), Phase 4 (auto-install) and Phase 5 (custom
 * entry CRUD) land as their own additions here, each behind `cliManagementEnabled`.
 *
 * Mirrors `custom-model-routes.ts`'s shape for the closest existing precedent:
 * same admin-gating pattern, same `readXEnabled()` helper shape reading
 * `settings.json` directly rather than threading the setting through every
 * caller.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isAdmin, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { listClis } from '../../config/cli-registry/registry.js';
import type { CliEntry } from '../../config/cli-registry/types.js';

/**
 * `cliManagementEnabled` defaults OFF, same reasoning as
 * `readCustomModelEndpointsEnabled` in custom-model-routes.ts: this gate gets
 * checked by every WRITE endpoint (Phases 3-5), so it needs its own reader
 * rather than threading the setting value through every route handler.
 */
export async function readCliManagementEnabled(): Promise<boolean> {
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  return settings.cliManagementEnabled === true;
}

export interface CliListItem {
  id: string;
  label: string;
  shortBadge: string;
  order: number;
  kind: CliEntry['kind'];
  enabled: boolean;
  stock: boolean;
  installed: boolean;
}

/**
 * Per-STOCK-id installed probes, the same memoized resolvers `renderIndexHtml`
 * injects into `window.__codemanCliAvailable` (server.ts) — reused rather than
 * re-probed, since every resolver already memoizes its own PATH lookup for the
 * process lifetime. Dynamic imports so this module doesn't pay for all nine
 * resolvers when the CLI-management section is never opened; Node caches the
 * module after the first call, so repeat requests cost nothing extra.
 *
 * ⚠️ STOCK-ONLY. There is no per-id resolver for a CUSTOM entry — Phase 5
 * (custom CLI creation) needs a GENERIC installed check built from the
 * entry's own `discovery.binaries`/`searchDirs` directly, not this map. Until
 * then a custom entry (none can exist before Phase 5 ships) reports `installed:
 * false` rather than guessing.
 */
const STOCK_INSTALLED_PROBES: Record<string, () => Promise<boolean>> = {
  claude: async () => (await import('../../utils/claude-cli-resolver.js')).isClaudeAvailable(),
  shell: async () => true, // no binary to probe — the server's own login shell
  opencode: async () => (await import('../../utils/opencode-cli-resolver.js')).isOpenCodeAvailable(),
  codex: async () => (await import('../../utils/codex-cli-resolver.js')).isCodexAvailable(),
  gemini: async () => (await import('../../utils/gemini-cli-resolver.js')).isGeminiAvailable(),
  antigravity: async () => (await import('../../utils/antigravity-cli-resolver.js')).isAntigravityAvailable(),
  pi: async () => (await import('../../utils/pi-cli-resolver.js')).isPiAvailable(),
  grok: async () => (await import('../../utils/grok-cli-resolver.js')).isGrokAvailable(),
  // RUNNABLE (binary + a pane-capable profile), same choice server.ts's
  // __codemanCliAvailable makes for the identical reason — see its comment.
  deepseek: async () => (await import('../../utils/deepseek-cli-resolver.js')).isDeepSeekRunnable(),
  omp: async () => (await import('../../utils/omp-cli-resolver.js')).isOmpAvailable(),
};

async function probeInstalled(entry: CliEntry): Promise<boolean> {
  const probe = STOCK_INSTALLED_PROBES[entry.id as string];
  return probe ? probe() : false;
}

export function registerCliRegistryRoutes(app: FastifyInstance): void {
  // GET /api/clis — every registry entry, disabled ones included (this is an
  // admin/settings surface; every SPAWN-time caller elsewhere uses
  // enabledClis() instead). Deliberately excludes launch/env/capabilities/
  // overlays/discovery — the same rule every other catalogue-export surface in
  // this codebase follows (scripts/generate-cli-catalog.mts, the reverted PR
  // B2 window.__codemanCliCatalog before it).
  //
  // NOT gated on cliManagementEnabled: reading the list is cheap and is not
  // the risky part (docs/cli-enable-disable-plan.md, Phase 1). The Settings UI
  // section simply never fetches this while the flag is off (Phase 6).
  app.get('/api/clis', async (req: FastifyRequest): Promise<{ success: true; data: CliListItem[] }> => {
    if (isMultiUserMode() && !isAdmin(req)) {
      return { success: true, data: [] };
    }
    const entries = listClis();
    const data = await Promise.all(
      entries.map(async (entry) => ({
        id: entry.id as string,
        label: entry.label,
        shortBadge: entry.shortBadge,
        order: entry.order,
        kind: entry.kind,
        enabled: entry.enabled,
        stock: entry.stock,
        installed: await probeInstalled(entry),
      }))
    );
    return { success: true, data };
  });
}
