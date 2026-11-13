/**
 * @fileoverview The env-var half of the multi-user privilege clamp.
 *
 * A session's `envOverrides` can hand back privilege that the per-CLI config
 * clamp removed, so a non-granted owner's overrides get the privileged keys
 * stripped before the session is built. The create and resume routes are what
 * this bites on: they clamp what a request asked for.
 *
 * The reboot-restore route calls it as defence in depth, and it CAN strip
 * something today: `Session.getEnvOverridesForPersist()` keeps only
 * `CLAUDE_CODE_*` and `CLAUDE_CONFIG_DIR` out of a session's overrides, and
 * claude's `privilegedEnvKeys` now includes both `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
 * and `CLAUDE_CONFIG_DIR` (Custom Model Endpoint Profiles, since both can
 * redirect a claude session's traffic — see stock.ts's own comment on why they
 * are listed despite not needing the clamp for that feature). So a non-granted
 * owner's persisted `CLAUDE_CONFIG_DIR` (the per-client-account override, #255)
 * is now stripped on reboot-restore, silently returning that session to the
 * default Claude account rather than the account it was pointed at. The grant
 * re-resolution that ALSO bites on that path is `resolveClaudeModeForUsername`,
 * which recomputes the permission mode.
 *
 * This lives outside `web/routes` on purpose. The question it answers is about
 * session privilege rather than about HTTP, and `cron/cron-service.ts` sets the
 * precedent by importing `canUsernameRunPrivilegedCommands` from `user-store.ts`
 * directly and re-resolving the owner's grant when a job fires. Every caller here
 * re-resolves the grant at the moment it builds a session, for the same reason.
 *
 * @dependencies user-store (canUsernameRunPrivilegedCommands), config/cli-registry
 * @consumedby web/routes/session-routes, web/routes/reboot-restore-routes, web/server
 *
 * @module session-env-clamp
 */

import { canUsernameRunPrivilegedCommands } from './user-store.js';
import { listClis } from './config/cli-registry/registry.js';

/**
 * Env-var keys a non-granted owner must not be able to set, because each one
 * hands back privilege `clampExternalCliBypassForOwner()` just removed, or redirects a
 * credential-resolution endpoint.
 *
 * The DeepSeek three are reachable because `DSH_*` and `DEEPSEEK_*` are
 * allowlisted `envOverrides` prefixes (schemas.ts) — which they have to be, since
 * that is also how a user configures the harness's non-privileged knobs.
 *
 * - `DSH_PERMISSION_MODE` IS the harness's permission switch. Every other CLI's
 *   bypass is a command-line FLAG, reachable only through the per-CLI config the
 *   clamp already owns; this one is an env var, so the config clamp alone is
 *   half a gate.
 * - `DSH_HOME` points the launcher at a profile tree, and a profile's plugin code
 *   executes at BOOT, before any approval row can apply. A user who can write a
 *   workspace can put a profile in it, so this is the wider of the two.
 * - `DEEPSEEK_BASE_URL` aims the provider endpoint, and `_configureCliEnv()`
 *   forwards the SERVER's own `DEEPSEEK_API_KEY` into every dsh pane before
 *   `applyEnvOverrides()` runs — so a non-granted owner who could set the base
 *   URL would have the operator's API key sent as a bearer credential to a host
 *   of their choosing. (`DEEPSEEK_API_KEY` itself stays overridable: supplying
 *   your OWN key removes privilege rather than granting it.)
 * - `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` are where omp resolves
 *   credentials from — the same shape as `DEEPSEEK_BASE_URL` above, reachable
 *   because `OMP_*` is an allowlisted prefix. Unlike DeepSeek, Codeman does not
 *   forward any operator-held key into an omp pane today (omp's provider
 *   credentials live in `~/.omp` config files, not env vars), so there is no
 *   known concrete exfiltration path yet — clamped defensively anyway, since a
 *   non-granted owner redirecting where a shared multi-tenant deployment
 *   resolves auth from is not something to allow silently (found in
 *   Ark0N/Codeman#353 review; omp's own knobs are otherwise mostly `PI_*`,
 *   already allowlisted for pi and not addressed here — see resolveOmpHome()).
 */
export function ownerClampedEnvKeys(): string[] {
  // Every CLI, enabled or not: a session can outlive the switch that disabled its CLI.
  return listClis().flatMap((entry) => entry.capabilities.privilegedEnvKeys);
}

/**
 * Env-var half of the multi-user bypass clamp.
 *
 * `clampExternalCliBypassForOwner()` in `web/routes/session-routes.ts` clamps the
 * per-CLI CONFIG, and for every CLI
 * but DeepSeek that is the whole story. Here it is not: `applyEnvOverrides()` runs
 * AFTER `_configureCliEnv()` in tmux-manager, so an override sent on the SAME
 * request lands last and wins, and a non-granted owner could restore
 * `danger-full-access` on the very request the config clamp downgraded.
 *
 * Keys are DROPPED rather than rewritten: dropping falls through to what
 * `_configureCliEnv()` exports, which is the clamped config and the server's own
 * `DSH_HOME`, i.e. exactly the intended state. No-op in single-user mode and for a
 * granted owner, like every other clamp here
 * (`canUsernameRunPrivilegedCommands()` returns true when `!isMultiUserMode()`),
 * and it returns the caller's own object untouched when there is nothing to strip.
 */
export async function clampEnvOverridesForOwner(
  owner: string | undefined,
  envOverrides: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  if (!envOverrides) return envOverrides;
  const keys = ownerClampedEnvKeys();
  if (!keys.some((key) => key in envOverrides)) return envOverrides;
  if (await canUsernameRunPrivilegedCommands(owner)) return envOverrides;
  const clamped = { ...envOverrides };
  for (const key of keys) delete clamped[key];
  return clamped;
}
