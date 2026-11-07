/**
 * @fileoverview The NAMES of code profiles a `CliEntry` field may select, and the helpers
 * that validate them.
 *
 * A profile is the escape hatch for behaviour that is genuinely code-shaped and cannot be
 * expressed as data — codex's predictive write-through echo, deepseek's profile-launcher
 * runnability check, deepseek's status bridge — without letting any of that code branch on
 * a CLI's id. A registry field names a profile; the implementation lives beside whatever it
 * needs, and looks its name up here.
 *
 * ⚠️ This module is PURE and must stay that way: names, types and predicates only, no
 * imports outside this directory. The implementations pull in resolvers and the status
 * shim, which in turn reach back into the registry, so holding them here would close an
 * import cycle (profiles → deepseek-cli-resolver → cli-resolver → registry → schema →
 * profiles). Keeping the names here and the implementations at their call sites is what
 * lets `schema.ts` validate a profile name at LOAD time — a custom entry naming a profile
 * this build does not implement fails loudly instead of silently failing closed later.
 *
 * The rule all of this enforces: `test/cli-registry-no-id-branching.test.ts` fails on any
 * `mode === '<stock id>'` comparison outside `stock.ts`, so a NEW behavioural special case
 * must be added here, named, and referenced from a registry field — never inlined as an id
 * check at the call site.
 *
 * ⚠️ A profile is a LAST resort, not a convenience. Reach for one only when the behaviour
 * needs to run code (a side effect, a computed value, a probe); anything that is a list, a
 * flag, or a string belongs in the entry as data, where a custom CLI can also use it.
 *
 * @module config/cli-registry/profiles
 */

/**
 * Predictive local-echo profiles, selected via `capabilities.echo.predictProfile`.
 *
 * Implementation: packages/xterm-zerolag-input/src/predictive-echo-addon.ts.
 *
 * ⚠️ Unlike the other two registries, an unknown name here degrades to the 'buffer' policy
 * rather than failing. Echo is a comfort feature — a worse-but-working overlay beats a
 * refused session — which is why `predictProfile` alone is not schema-validated below.
 */
export const PREDICT_PROFILES: Record<string, true> = {
  codex: true,
};

/**
 * Launcher profiles, selected via `discovery.launcherProfile`.
 *
 * For a CLI whose binary launches some further target, and so cannot answer two questions
 * from the binary alone: is it RUNNABLE (stricter than "is the binary on disk?"), and what
 * is the DEFAULT target when the caller names none? A CLI naming no profile is runnable
 * exactly when its binary resolves, and has no default target.
 *
 * Implementation: `src/utils/cli-launcher.ts`.
 */
export const LAUNCHER_PROFILE_NAMES = [
  // `dsh` is a launcher over $DSH_HOME/profiles/<name>, and the profiles DeepSeek itself
  // ships (web, headless) cannot drive a terminal pane. Binary AND a pane-capable profile.
  'deepseek-profile',
] as const;

/**
 * Extra `tmux setenv` work, selected via `env.setenvProfile`.
 *
 * Implementation: `src/tmux-manager.ts`, which already owns every setenv call.
 *
 * ⚠️ Anything that is merely "forward this name from the server's own env" belongs in
 * `env.tmuxSetenvKeys` as data and must NOT be given a profile.
 */
export const SETENV_PROFILE_NAMES = [
  // DeepSeek's terminal front door reports idle/working/blocked to a supervisor over the
  // generic env-gated Herdr contract; this makes Codeman that supervisor. It needs a
  // profile rather than key names because it writes an executable shim to disk and then
  // exports that shim's path along with the session's own pane id.
  'deepseek-status-bridge',
] as const;

export type LauncherProfileName = (typeof LAUNCHER_PROFILE_NAMES)[number];
export type SetenvProfileName = (typeof SETENV_PROFILE_NAMES)[number];

/**
 * Transcript readers, selected via `capabilities.transcript`. Unlike the profile registries
 * above this one is closed over the schema enum itself rather than an open string, since
 * transcript format is a small, genuinely fixed set — see CliCapabilities['transcript'].
 */
export const TRANSCRIPT_READER_NAMES = ['claude-jsonl', 'codex-rollout', 'deepseek-zstd', 'none'] as const;

/** Composer-row finders, selected via `capabilities.echo.anchor.kind`. Also schema-closed. */
export const COMPOSER_ANCHOR_KINDS = ['glyph', 'cursor', 'none'] as const;

/** True when `name` is a predictive-echo profile this build actually implements. */
export function isKnownPredictProfile(name: string | undefined): boolean {
  return name !== undefined && Object.prototype.hasOwnProperty.call(PREDICT_PROFILES, name);
}

export function isKnownLauncherProfile(name: string): name is LauncherProfileName {
  return (LAUNCHER_PROFILE_NAMES as readonly string[]).includes(name);
}

export function isKnownSetenvProfile(name: string): name is SetenvProfileName {
  return (SETENV_PROFILE_NAMES as readonly string[]).includes(name);
}

/** Verified native settings/input protocols. Implementations live in discord-model-controls and native-composer-ready. */
export const NATIVE_SETTINGS_PROFILES = ['codex-tui', 'claude-tui'] as const;
export type NativeSettingsProfileName = (typeof NATIVE_SETTINGS_PROFILES)[number];
