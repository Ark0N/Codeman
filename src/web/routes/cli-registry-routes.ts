/**
 * @fileoverview CLI management (docs/cli-enable-disable-plan.md) — "PR C" from the
 * original #343 review, done in phases with the trust-model scope decided up front
 * (see that doc's "Decisions" section) rather than folded into a large diff.
 *
 * Phase 2: `GET /api/clis` — read-only list, ungated (reading is cheap, not the risky part).
 * Phase 3: `PUT /api/clis/:id` — stock enable/disable ONLY; 404 for a non-stock id, so this
 *   endpoint can never become a backdoor for creating an entry (that's Phase 5's job).
 * Phase 4: `POST /api/clis/:id/install` — runs a STOCK entry's already-vetted install command
 *   (never a custom entry's — Decision 3). Never auto-enables; Phase 3's endpoint is still
 *   the only thing that flips `enabled`.
 * Phase 5: `POST /api/clis` (create) / `PUT /api/clis/custom/:id` (update) / `DELETE
 *   /api/clis/:id` (custom only) — a deliberately separate write surface from Phase 3's, so
 *   "stock entries can only have `enabled` toggled here, custom entries can be fully edited"
 *   stays structurally true rather than depending on every caller remembering the rule.
 *
 * Every write endpoint answers the SAME way when `cliManagementEnabled` is off: 403
 * FORBIDDEN with a message naming the setting, via `requireCliManagementGate()`.
 *
 * Mirrors `custom-model-routes.ts`'s shape for the closest existing precedent: same
 * admin-gating pattern, same `readXEnabled()` helper shape reading `settings.json`
 * directly rather than threading the setting through every caller, same tmp+rename+0600
 * write path (`registry-writer.ts` mirrors `custom-model-hosts.ts`).
 */

import { spawn } from 'node:child_process';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { getAuthUser, isAdmin, parseBody, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { listClis, reloadCliRegistry, resolveInstallCommandForPlatform } from '../../config/cli-registry/registry.js';
import { readRegistryFileForWrite, writeRegistryFile } from '../../config/cli-registry/registry-writer.js';
import { CliEntrySchema } from '../../config/cli-registry/schema.js';
import { STOCK_CLIS } from '../../config/cli-registry/stock.js';
import type { CliEntry } from '../../config/cli-registry/types.js';
import { CliCustomEntrySchema, CliEnableSchema } from '../schemas.js';
import { appendAdminAudit } from '../admin-audit.js';
import { invalidateCliExecutableResolvers } from '../../utils/cli-executable-resolver.js';
import { invalidateCliResolverCache, isCliAvailable as isRegistryCliAvailable } from '../../utils/cli-resolver.js';

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
  /**
   * The command `POST /api/clis/:id/install` would run, for a STOCK entry only, so the
   * Settings UI can name it in the confirm dialog before anything executes. The same
   * display text `missingCliMessage()` already prints in "CLI not found. Install with: …";
   * absent for a custom entry, whose install command is never executed (Decision 3).
   */
  installCommand?: string;
}

/**
 * Per-STOCK-id installed probes, the same memoized resolvers `renderIndexHtml`
 * injects into `window.__codemanCliAvailable` (server.ts) — reused rather than
 * re-probed, since every resolver already memoizes its own PATH lookup for the
 * process lifetime. Dynamic imports so this module doesn't pay for all nine
 * resolvers when the CLI-management section is never opened; Node caches the
 * module after the first call, so repeat requests cost nothing extra.
 *
 * STOCK-ONLY by construction; a custom entry goes through the registry's generic
 * resolver instead (`probeInstalled` below).
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

/**
 * A custom entry is probed through the registry's GENERIC resolver (cli-resolver.ts) —
 * the same one a session spawn uses (`missingCliMessage`/`resolveCliBinDir`) and the same
 * one `renderIndexHtml` uses for the Run menu. A private `which` here used to disagree with
 * both, since it ignored the entry's `searchDirs` and the login-shell lookup: the badge
 * could say "Not installed" for a CLI the Run menu happily launched.
 */
async function probeInstalled(entry: CliEntry): Promise<boolean> {
  if (entry.stock) {
    const probe = STOCK_INSTALLED_PROBES[entry.id as string];
    return probe ? probe() : false;
  }
  return isRegistryCliAvailable(entry.id as string);
}

/**
 * Forget every cached binary lookup for this CLI — the generic per-id resolver (which
 * captures the entry's binaries when first built) and every underlying per-binary cache,
 * success and negative-cache backoff alike. Called after anything that changes what is on
 * disk or what the CLI's binary IS; see `invalidateCliExecutableResolvers`.
 */
function forgetResolvedCli(id: string, binaries: readonly string[]): void {
  invalidateCliExecutableResolvers(binaries);
  invalidateCliResolverCache(id);
}

const STOCK_IDS = new Set(STOCK_CLIS.map((e) => e.id as string));

/**
 * `shell` can never be disabled — enforced here, not just in the UI (a frontend-only guard
 * is bypassable with curl). Revised from Decision 4's original "shell/claude" scope
 * (2026-09-23): `claude` is now a normal toggleable entry like any other CLI. Internal
 * session creation (tmux-manager.ts, session.ts, Ralph, plan-orchestrator) resolves a CLI
 * via `getCli()`, which does NOT check `enabled` at all, so disabling `claude` only affects
 * the Run menu and the HTTP-facing `sessionModeSchema()` (new session requests via the
 * normal API) — identical in kind to disabling any other CLI, never a break to an internal
 * fallback path. `shell` keeps the harder guarantee because it is the one non-agent mode
 * several code paths assume always exists as a raw-terminal fallback.
 */
const UNDISABLEABLE_IDS = new Set(['shell']);

/**
 * Every write endpoint (Phases 3-5) answers the SAME way when the feature is off or the
 * caller is a non-admin in multi-user mode: 403 FORBIDDEN. Decided once here rather than
 * per-route, per docs/cli-enable-disable-plan.md Phase 1's own checklist item ("decide
 * exact behavior... before Phase 3 starts, so all three write endpoints answer the same way").
 */
async function requireCliManagementGate(req: FastifyRequest): Promise<ApiResponse<never> | null> {
  if (isMultiUserMode() && !isAdmin(req)) {
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
  }
  if (!(await readCliManagementEnabled())) {
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'CLI management is disabled. Enable it in Settings first.');
  }
  return null;
}

/**
 * Assembles a full, schema-valid `CliEntry` from Phase 5's deliberately minimal request
 * shape (id/label/shortBadge/binaries/a simple launch variant — nothing else exposed in
 * v1), filling every other required field with conservative, safe defaults: no hooks, no
 * mux-optional fallback, no privileged params, no install command (Decision 3: a custom
 * entry's install text stays display-only, and there IS none here to display), no custom
 * model injection. `CliEntrySchema` re-validates the WHOLE thing below — this function
 * only shapes the object, it is not itself the safety layer.
 */
function buildCustomCliEntry(
  input: { id: string; label: string; shortBadge: string; binaries: string[]; argv: string[]; enabled?: boolean },
  order: number
): unknown {
  return {
    id: input.id,
    label: input.label,
    shortBadge: input.shortBadge,
    accent: '#6b7280',
    enabled: input.enabled ?? true,
    stock: false,
    order,
    kind: 'agent',
    discovery: {
      binaries: input.binaries,
      searchDirs: [],
      install: { command: {} },
    },
    launch: {
      params: {},
      variants: [{ id: 'default', args: input.argv.map((tok) => ({ lit: tok })) }],
    },
    env: {
      exports: [],
      unset: [],
      tmuxSetenvKeys: [],
      dockerExecEnvNames: [],
      allowedPrefixes: [],
      allowedKeys: [],
    },
    capabilities: {
      external: true,
      requiresMux: true,
      hooks: 'none',
      transcript: 'none',
      altScreen: 'strip-mux-only',
      echo: { policy: 'buffer', anchor: { kind: 'none' } },
      wheelForward: { mode: 'never' },
      keyboardAccessory: 'agent',
      privilegedCommandGate: false,
      startMode: 'interactive',
      stripInkBloat: false,
      ralph: false,
      respawn: false,
      effort: false,
      agentSkillInjection: false,
      statusLineTelemetry: false,
      model: { source: 'none' },
      privilegedParams: [],
      privilegedEnvKeys: [],
      gates: {},
      customModelInjection: { kind: 'unsupported' },
    },
    overlays: {},
  };
}

function nextOrder(): number {
  const orders = listClis().map((e) => e.order);
  return (orders.length ? Math.max(...orders) : 0) + 10;
}

/** Bounded execution: `PATH_INSTALL_TIMEOUT_MS`, output capped, process GROUP killed on timeout. */
const CLI_INSTALL_TIMEOUT_MS = 300_000;

interface InstallResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Runs a STOCK entry's already-vetted install command. `shell: true` is unavoidable here —
 * the shipped commands are genuinely `curl | bash` / `npm install -g` one-liners — but this
 * is NOT a reopening of the config-shell-text concern the registry's `shellToken` pattern
 * exists to prevent: the string executed here is NEVER user input, only ever what is
 * already hardcoded and reviewed in `stock.ts` (`resolveInstallCommandForPlatform`), and a
 * CUSTOM entry can never reach this function at all — see the route's own guard below.
 */
async function runInstallCommand(command: string): Promise<InstallResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group; the timeout below kills the whole tree by hand, mirroring
        // the DeepSeek profile-install endpoint's own reasoning: an install command fans
        // out into package-manager children, and spawn's own `timeout` option signals
        // only the direct child, leaving survivors holding the pipes open forever.
        detached: true,
        env: process.env,
      });
    } catch (err) {
      resolve({ code: null, output: `spawn failed: ${getErrorMessage(err)}`, timedOut: false });
      return;
    }

    let output = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;

    const capture = (chunk: Buffer) => {
      if (output.length < 16_384) output += chunk.toString('utf-8');
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      resolve({ code, output, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 3_000);
      reapTimer = setTimeout(() => finish(null), 8_000);
    }, CLI_INSTALL_TIMEOUT_MS);

    child.on('error', (err) => {
      output = `${output}\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

export function registerCliRegistryRoutes(app: FastifyInstance): void {
  // ---- Phase 2: read ----------------------------------------------------
  // GET /api/clis — every registry entry, disabled ones included (this is an
  // admin/settings surface; every SPAWN-time caller elsewhere uses
  // enabledClis() instead). Deliberately excludes launch/env/capabilities/
  // overlays/discovery — the same rule every other catalogue-export surface in
  // this codebase follows.
  //
  // NOT gated on cliManagementEnabled: reading the list is cheap and is not
  // the risky part. The Settings UI section simply never fetches this while
  // the flag is off (Phase 6).
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
        ...(entry.stock ? { installCommand: resolveInstallCommandForPlatform(entry) } : {}),
      }))
    );
    return { success: true, data };
  });

  // ---- Phase 3: enable/disable (stock OR custom) -------------------------
  // PUT /api/clis/:id — body { enabled }. Toggles an EXISTING entry's
  // `enabled` flag, stock or custom alike; a not-yet-existing id is 404,
  // never a backdoor into CREATING one (Phase 5 owns creation via its own
  // endpoint, POST /api/clis). This is deliberately the one simple toggle
  // both kinds of entry share — full custom-entry editing is a SEPARATE path
  // (PUT /api/clis/custom/:id) precisely so a caller can flip `enabled`
  // without first knowing the rest of a custom entry's shape (its binaries,
  // its argv), which the Settings UI list row never carries.
  app.put('/api/clis/:id', async (req, reply): Promise<ApiResponse<{ id: string; enabled: boolean }>> => {
    const denied = await requireCliManagementGate(req);
    if (denied) {
      reply.code(403);
      return denied;
    }
    const { id } = req.params as { id: string };
    const body = parseBody(CliEnableSchema, req.body);

    if (UNDISABLEABLE_IDS.has(id) && !body.enabled) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `"${id}" cannot be disabled`);
    }
    if (!listClis().some((e) => (e.id as string) === id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `"${id}" does not exist`);
    }

    const file = await readRegistryFileForWrite();
    const existingOverride = (file.clis[id] as Record<string, unknown> | undefined) ?? {};
    file.clis = { ...file.clis, [id]: { ...existingOverride, enabled: body.enabled } };
    await writeRegistryFile(file);
    reloadCliRegistry();
    return { success: true, data: { id, enabled: body.enabled } };
  });

  // ---- Phase 4: auto-install (stock only) --------------------------------
  // POST /api/clis/:id/install — runs the entry's already-vetted install
  // command. Separate endpoint from Phase 3's toggle: installing is a bigger
  // action than a boolean flip and gets its own audit entry. Never auto-
  // enables — Phase 3's endpoint is still the only thing that flips `enabled`.
  app.post(
    '/api/clis/:id/install',
    async (req, reply): Promise<ApiResponse<{ id: string; code: number | null; output: string }>> => {
      const denied = await requireCliManagementGate(req);
      if (denied) {
        reply.code(403);
        return denied;
      }
      const { id } = req.params as { id: string };
      if (!STOCK_IDS.has(id)) {
        // Decision 3: a custom entry's install command is NEVER executed, full
        // stop — this guard is what makes that true independent of anything
        // Phase 5 does, even if a caller invents an id that happens to match
        // a custom entry's.
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Auto-install is only available for stock CLIs');
      }
      const entry = listClis().find((e) => (e.id as string) === id);
      if (!entry) return createErrorResponse(ApiErrorCode.NOT_FOUND, `"${id}" is not a stock CLI`);
      const command = resolveInstallCommandForPlatform(entry);
      if (!command) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `"${id}" has no install command for this platform`);
      }

      const result = await runInstallCommand(command);
      // Even a failed or timed-out install may have left a binary behind, so forget the
      // cached lookups either way: the next Run click or badge read probes afresh
      // instead of replaying a pre-install miss for up to the 5-minute backoff.
      forgetResolvedCli(id, entry.discovery.binaries);
      const admin = getAuthUser(req).username;
      void appendAdminAudit({
        admin,
        action: 'cli_install',
        target: id,
        ip: req.ip,
        detail: { command, exitCode: result.code, timedOut: result.timedOut },
      });

      if (result.code !== 0) {
        const detail = result.timedOut
          ? `timed out after ${Math.round(CLI_INSTALL_TIMEOUT_MS / 1000)}s`
          : result.output.slice(-1000).trim() || 'no output';
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Installing "${id}" failed: ${detail}`);
      }
      return { success: true, data: { id, code: result.code, output: result.output.slice(-4000) } };
    }
  );

  // ---- Phase 5: custom CLI entries ----------------------------------------
  // POST /api/clis — create a custom entry. Deliberately separate from Phase
  // 3's PUT: that endpoint can only ever toggle an EXISTING stock entry, this
  // one can only ever create a NEW custom one, so the two write surfaces
  // cannot be confused for each other by a caller.
  app.post('/api/clis', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = await requireCliManagementGate(req);
    if (denied) {
      reply.code(403);
      return denied;
    }
    const body = parseBody(CliCustomEntrySchema, req.body);
    if (STOCK_IDS.has(body.id)) {
      return createErrorResponse(
        ApiErrorCode.ALREADY_EXISTS,
        `"${body.id}" is a stock CLI id and cannot be used for a custom entry`
      );
    }
    const file = await readRegistryFileForWrite();
    if (Object.prototype.hasOwnProperty.call(file.clis, body.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, `A custom CLI "${body.id}" already exists`);
    }

    const candidate = buildCustomCliEntry(body, nextOrder());
    const parsed = CliEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.message);
    }

    // Stored WITHOUT id/stock — those are forced back in by resolveRegistry() on every
    // read, so the override file never duplicates what the key and provenance already say.
    const { id: _id, stock: _stock, ...toStore } = parsed.data;
    file.clis = { ...file.clis, [body.id]: toStore };
    await writeRegistryFile(file);
    reloadCliRegistry();
    // A resolver may already exist for this id (a same-named entry deleted earlier in
    // this process) and would keep probing that entry's binaries.
    forgetResolvedCli(body.id, body.binaries);
    return { success: true, data: { id: body.id } };
  });

  // PUT /api/clis/custom/:id — full update of an EXISTING custom entry. A
  // separate path from Phase 3's PUT /api/clis/:id on purpose: that one is
  // structurally stock-only (404s any id it doesn't recognise as stock), so
  // there is no shared route where "which fields this id may change" depends
  // on a runtime check a caller could get wrong.
  app.put('/api/clis/custom/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = await requireCliManagementGate(req);
    if (denied) {
      reply.code(403);
      return denied;
    }
    const { id } = req.params as { id: string };
    if (STOCK_IDS.has(id)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `"${id}" is a stock CLI; use PUT /api/clis/${id} instead`);
    }
    const body = parseBody(CliCustomEntrySchema, { ...(req.body as object), id });
    const file = await readRegistryFileForWrite();
    if (!Object.prototype.hasOwnProperty.call(file.clis, id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `No custom CLI "${id}"`);
    }

    const existing = listClis().find((e) => (e.id as string) === id);
    const existingOrder = existing?.order ?? nextOrder();
    const previousBinaries = existing?.discovery.binaries ?? [];
    const candidate = buildCustomCliEntry(body, existingOrder);
    const parsed = CliEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.message);
    }

    const { id: _id, stock: _stock, ...toStore } = parsed.data;
    file.clis = { ...file.clis, [id]: toStore };
    await writeRegistryFile(file);
    reloadCliRegistry();
    // The generic resolver captured the OLD binaries when first built; without this a
    // session spawn kept launching the previous binary until a restart.
    forgetResolvedCli(id, [...previousBinaries, ...body.binaries]);
    return { success: true, data: { id } };
  });

  // DELETE /api/clis/:id — refuses any STOCK id outright; deleting only ever
  // removes a CUSTOM entry's override.
  app.delete('/api/clis/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = await requireCliManagementGate(req);
    if (denied) {
      reply.code(403);
      return denied;
    }
    const { id } = req.params as { id: string };
    if (STOCK_IDS.has(id)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `"${id}" is a stock CLI and cannot be deleted`);
    }
    const file = await readRegistryFileForWrite();
    if (!Object.prototype.hasOwnProperty.call(file.clis, id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `No custom CLI "${id}"`);
    }
    const previousBinaries = listClis().find((e) => (e.id as string) === id)?.discovery.binaries ?? [];
    const { [id]: _removed, ...rest } = file.clis;
    file.clis = rest;
    await writeRegistryFile(file);
    reloadCliRegistry();
    forgetResolvedCli(id, previousBinaries);
    return { success: true, data: { id } };
  });
}
