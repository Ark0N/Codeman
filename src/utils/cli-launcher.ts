/**
 * @fileoverview Implementations of the LAUNCHER profiles named by `discovery.launcherProfile`.
 *
 * A launcher CLI's binary is not the agent — it boots some further target — so two questions
 * the registry normally answers from the binary alone have to be asked of that target:
 *
 *   - `isCliRunnable(id)`  — stricter than "is the binary on disk?"
 *   - `launcherDefaultTarget(entry)` — what to launch when the caller names no target
 *
 * The profile NAMES and their validation live in `config/cli-registry/profiles.ts`, which is
 * kept free of imports so `schema.ts` can validate a name at load time. The implementations
 * live here because they reach into resolvers that reach back into the registry, and holding
 * them next to the names would close an import cycle.
 *
 * ⚠️ Everything in this file is keyed by PROFILE NAME, never by CLI id. A new launcher CLI
 * adds a profile here and names it from its entry; it does not add a branch anywhere else.
 *
 * @module utils/cli-launcher
 */

import { isDeepSeekRunnable, resolveDefaultDeepSeekProfile } from './deepseek-cli-resolver.js';
import { getCli } from '../config/cli-registry/registry.js';
import type { CliEntry } from '../config/cli-registry/types.js';
import { missingCliMessage, resolveCliBinDir } from './cli-resolver.js';

interface LauncherProfile {
  /** Is the launcher usable, given that its binary resolved? */
  isRunnable(): boolean;
  /** The target to launch when the caller named none, or null when there is none. */
  defaultTarget(): string | null;
  /**
   * Why a session cannot start, or null when it can — including why a SPECIFICALLY
   * requested target will not work, which "is it runnable" alone cannot say.
   */
  launchError(requestedTarget?: string): Promise<string | null>;
}

const LAUNCHER_PROFILES: Record<string, LauncherProfile> = {
  // `dsh` launches a profile from $DSH_HOME/profiles/<name>. DeepSeek ships only
  // `web`/`headless`/`base`, none of which can drive a terminal pane, so the terminal front
  // door is always third-party: a perfectly-installed dsh with no TUI profile is installed
  // but NOT runnable, and the two questions have genuinely different answers.
  'deepseek-profile': {
    isRunnable: isDeepSeekRunnable,
    defaultTarget: resolveDefaultDeepSeekProfile,
    // Three distinct, actionable messages (binary missing / no pane-capable profile /
    // the named profile is not pane-capable). Worth keeping distinct: a pane that dies
    // instantly is the most confusing failure this mode can produce, and "not installed"
    // would send the user to fix the wrong thing.
    launchError: async (requestedTarget) => {
      const { resolveDeepSeekLaunchError } = await import('./deepseek-cli-resolver.js');
      return resolveDeepSeekLaunchError(requestedTarget);
    },
  },
};

/**
 * Why a session in this mode cannot start, or null when it can.
 *
 * For an ordinary CLI this is just "is the binary there?", answered with the not-found
 * message that names where resolution looked. For a launcher CLI it defers to that CLI's own
 * profile, which can be far more specific.
 *
 * `rawConfig` is the caller's per-CLI config object, read for the target the caller named
 * (declared as `discovery.launcherTargetParam`) so the error can be about THAT target.
 */
export async function resolveCliLaunchError(mode: string, rawConfig?: Record<string, unknown>): Promise<string | null> {
  const entry = getCli(mode);
  if (!entry) return null;

  const profileName = entry.discovery.launcherProfile;
  if (profileName !== undefined) {
    const profile = LAUNCHER_PROFILES[profileName];
    if (!profile) return `${entry.label} is not runnable: its launcher profile is unavailable in this build.`;
    const targetParam = entry.discovery.launcherTargetParam;
    const requested = targetParam ? rawConfig?.[targetParam] : undefined;
    return profile.launchError(typeof requested === 'string' ? requested : undefined);
  }

  // No binary to find (`shell`) is never an error.
  if (entry.discovery.binaries.length === 0) return null;
  return resolveCliBinDir(mode) === null ? missingCliMessage(mode) : null;
}

/**
 * The launcher's default target, for the `launcherDefaultTarget` engine value. Null for
 * every non-launcher CLI, which is what makes the corresponding launch arg drop out.
 */
export function launcherDefaultTarget(entry: CliEntry): string | null {
  const profileName = entry.discovery.launcherProfile;
  if (profileName === undefined) return null;
  return LAUNCHER_PROFILES[profileName]?.defaultTarget() ?? null;
}
