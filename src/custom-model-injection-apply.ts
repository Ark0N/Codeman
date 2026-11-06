/**
 * @fileoverview The one IO wrapper around `custom-model-injection.ts`'s pure
 * `ConfigDirInjection` output — deliberately split out so that file, the
 * discovery routes, and `scripts/test-local-llm-harnesses.ts` (via tsx) can
 * all share EXACTLY one "write these files, merge this env" implementation.
 * Before this existed, the route and the standalone script each carried
 * their own copy of this logic, which is exactly the kind of drift the CLI
 * registry's "declare once, consume everywhere" design exists to prevent —
 * see docs/custom-model-endpoints-plan.md and the "dynamic to support
 * cli-registry changes" requirement it was written against.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { dataPath } from './config/instance.js';
import type { CliEntry } from './config/cli-registry/types.js';
import {
  buildCustomModelInjection,
  type ConfigDirInjection,
  type CustomModelEndpoint,
} from './custom-model-injection.js';

/** Where a session's isolated `configDir`-kind files live: never the user's real CLI config path. */
export function customModelConfigDir(sessionId: string): string {
  return join(dataPath('custom-model-configs'), sessionId);
}

/**
 * Writes a `ConfigDirInjection`'s files under `baseDir` and returns the full
 * envOverrides object a caller should merge into the session/process env
 * (the dir-redirect var plus any `extraEnv` the config file references by
 * name). The generated files stay under `baseDir`, but a recipe that declares
 * `linkFromRealHome` additionally links (and, for missing directory targets,
 * creates) entries in the CLI's REAL home: the caller is still responsible
 * for choosing an isolated `baseDir` (never the user's real `~/.codex`,
 * `~/.pi`, etc.), it is just no longer the only directory touched.
 *
 * pi and omp embed the API key literally in the file, so the tree is written
 * 0700/0600 like every other secret-bearing file under `~/.codeman`; the chmod
 * covers a re-apply onto a file that already exists (`mode` only applies at
 * creation).
 */
export function applyConfigDirInjection(
  baseDir: string,
  injection: ConfigDirInjection,
  /**
   * The value this SESSION's own env overrides set for `injection.dirEnvVar`, when it
   * set one: a user who relocated the CLI's real home (an allowlisted key like
   * DSH_HOME) must have their state linked from THAT directory, not the server's.
   */
  sessionHomeOverride?: string
): Record<string, string> {
  for (const file of injection.files) {
    const filePath = join(baseDir, file.relPath);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, file.content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(filePath, 0o600);
  }
  linkRealHomeEntries(baseDir, injection, sessionHomeOverride);
  return { [injection.dirEnvVar]: baseDir, ...injection.extraEnv };
}

/**
 * Symlinks the registry recipe's `linkFromRealHome` entries out of the CLI's real home
 * into the otherwise-isolated `baseDir`, so redirecting `dirEnvVar` moves only the
 * generated config file and not the state that has to survive the session (deepseek:
 * the `sessions` transcript root `removeConfigDir` would otherwise delete, the `profiles`
 * bundles the patch composes over, and `settings.yaml`). Declared per entry in stock.ts:
 * this consumer is recipe-driven and names no CLI itself.
 *
 * Home resolution: the session's own override first (unless it IS `baseDir`, a re-apply
 * onto a session already holding a previous injection's value must not self-link), then
 * the server's environment, then the recipe's `realHomeFallback`. Only ABSOLUTE values
 * are considered: a set-but-relative `DSH_HOME`-style home resolves against the CLI's
 * cwd, and joining it here would mkdir/symlink under the SERVER's working directory and
 * leave relative links that dangle. No home resolvable =
 * no links, same best-effort posture as `linkSharedProjectsDir()`.
 */
function linkRealHomeEntries(baseDir: string, injection: ConfigDirInjection, sessionHomeOverride?: string): void {
  const names = injection.linkFromRealHome;
  if (!names || names.length === 0) return;
  const absoluteOnly = (value: string | undefined): string | undefined =>
    value && isAbsolute(value) ? value : undefined;
  const fromSession = sessionHomeOverride?.trim();
  const realHome =
    absoluteOnly(fromSession && fromSession !== baseDir ? fromSession : undefined) ||
    absoluteOnly(process.env[injection.dirEnvVar]?.trim()) ||
    (injection.realHomeFallback ? join(homedir(), injection.realHomeFallback) : undefined);
  if (!realHome) return;
  const dirs = new Set(injection.linkFromRealHomeDirs ?? []);
  for (const name of names) {
    linkRealHomeEntry(join(realHome, name), join(baseDir, name), dirs.has(name));
  }
}

function linkRealHomeEntry(target: string, link: string, isDir: boolean): void {
  // lstat, never existsSync: existsSync is false for a DANGLING link, and recovery
  // re-applies on every restart, so the second pass would try to recreate the link and
  // throw EEXIST. lstat answers for real entries, good links and dangling links alike.
  try {
    if (lstatSync(link)) return; // already linked (idempotent re-apply) or a real dir wrote one
  } catch {
    // ENOENT: nothing is here yet, the only state in which a link gets created
  }
  if (!existsSync(target)) {
    if (!isDir) return; // missing FILE target: skip, never plant a dangling file link
    // Missing DIRECTORY target: a dangling directory link is not inert, since the CLI's own
    // recursive mkdir THROUGH it fails ENOENT on every turn (dsh writing under
    // `$DSH_HOME/sessions` on a fresh/relocated home). Create it first, 0700, exactly
    // what dsh itself does on a first turn.
    try {
      mkdirSync(target, { recursive: true, mode: 0o700 });
    } catch {
      return; // e.g. the target's parent refuses writes: no link rather than a dangling one
    }
  }
  try {
    symlinkSync(target, link, platform() === 'win32' ? 'junction' : 'dir');
  } catch {
    // best-effort only: a platform that refuses symlinks keeps the documented
    // side effect for this session rather than failing the whole apply over it
  }
}

/**
 * Real, shared Claude config directory Codeman's own host process runs under — honors
 * `CLAUDE_CONFIG_DIR` the same way `claude-credentials.ts`'s `claudeCredentialsPath()`
 * does, so the symlink below points at wherever `~/.claude/projects` actually lives
 * rather than assuming the plain default.
 */
function realClaudeConfigDir(): string {
  const configured = typeof process.env.CLAUDE_CONFIG_DIR === 'string' && process.env.CLAUDE_CONFIG_DIR.trim();
  return configured || join(homedir(), '.claude');
}

/**
 * Symlinks `<isolatedDir>/projects` back to the real, shared `~/.claude/projects`, so an
 * isolated `CLAUDE_CONFIG_DIR` (used to keep an injected API key away from a stored OAuth
 * session — see `configDirVar` on customModelInjection) doesn't also blind the response
 * viewer, subagent windows, and Read My Mind for that session (docs/wiki/Agent-CLIs.md).
 * Best-effort: a platform that refuses symlinks (unprivileged Windows without a junction
 * fallback working, e.g.) just keeps the pre-existing documented side effect instead of
 * failing the whole custom-model apply over a nice-to-have.
 */
function linkSharedProjectsDir(isolatedDir: string): void {
  const link = join(isolatedDir, 'projects');
  if (existsSync(link)) return; // already linked (idempotent re-apply) or real dir wrote one
  try {
    symlinkSync(join(realClaudeConfigDir(), 'projects'), link, platform() === 'win32' ? 'junction' : 'dir');
  } catch {
    // best-effort only — response viewer/subagent windows go blind for this session instead
  }
}

/**
 * Pre-approves the injected API key in an isolated config directory's trust-dialog state
 * (`customModelInjection.apiKeyTrustFile`), so an otherwise-empty directory doesn't make the
 * CLI stop at an interactive "Detected a custom API key — use it?" prompt on every single
 * launch. Confirmed live: with nobody at the TTY to answer, that prompt's own default
 * ("No") silently refuses the very key this feature just injected — this isn't bypassing
 * the check, it's answering it the same field a real answered prompt itself writes to
 * (verified against a real `~/.claude.json` after answering by hand once).
 *
 * Merges rather than overwrites: the file may already carry fields the CLI itself wrote on
 * an earlier launch in this same isolated directory (machineID, userID, other approved
 * keys), and a corrupt or partially-written file (a crash mid-write) is treated as absent
 * rather than failing the whole apply over a nice-to-have.
 */
/**
 * The form Claude Code actually stores an approved key in: the trimmed last 20
 * characters. Mirrors the CLI's own `e.trim().slice(-20)`, which is applied on BOTH
 * the write and the lookup, so anything else never matches.
 */
export function truncateApiKeyForTrustFile(apiKey: string): string {
  return apiKey.trim().slice(-20);
}

function seedApiKeyTrustFile(
  configDir: string,
  trustFile: { relPath: string; shape: 'claude-api-key-responses' },
  apiKey: string
): void {
  const filePath = join(configDir, trustFile.relPath);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const responses = (existing.customApiKeyResponses ?? {}) as { approved?: unknown; rejected?: unknown };
  const approved = new Set(Array.isArray(responses.approved) ? (responses.approved as string[]) : []);
  // ⚠ Claude Code stores and compares only the LAST 20 CHARACTERS of a key, never the
  // whole thing: its lookup is `approved.includes(key.trim().slice(-20))` (decompiled
  // from the 2.1.278 bundle, and corroborated by real `~/.claude.json` files, whose
  // customApiKeyResponses entries are all exactly 20 characters). Seeding the full key
  // therefore never matches for a REAL key, and claude stops at the interactive
  // "Detected a custom API key in your environment" prompt, whose default is
  // "No (recommended)" — so the launch hangs or silently refuses the key this feature
  // just injected. It went unnoticed because a keyless llama.cpp/llama-swap endpoint
  // uses DEFAULT_API_KEY ('local-dummy-key', 15 chars), where slice(-20) is the whole
  // string and the seed matches by accident. Truncating here also keeps a full
  // third-party credential from being written into a second file on disk.
  approved.add(truncateApiKeyForTrustFile(apiKey));
  const rejected = Array.isArray(responses.rejected) ? responses.rejected : [];
  existing.customApiKeyResponses = { approved: [...approved], rejected };
  try {
    writeFileSync(filePath, JSON.stringify(existing, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch {
    // best-effort only — the interactive prompt returns instead of a hard failure here
  }
}

/**
 * Pre-seeds the two remaining pieces of "already been onboarded" state a fresh
 * `CLAUDE_CONFIG_DIR` has none of (`customModelInjection.skipFirstRunPrompts`, alongside
 * apiKeyTrustFile): claude replays its whole first-run sequence — the theme picker, the
 * security-notes screen, and (per-project) the "trust this folder?" dialog — against ANY
 * config directory that has never completed it, confirmed live against a genuinely fresh
 * isolated directory. `hasCompletedOnboarding` skips the theme/security-notes screens
 * outright; `projects[workingDir].hasTrustDialogAccepted` answers the trust dialog for
 * THIS session's own working directory the same way a real profile's own prior approval
 * would — other projects in the file are left alone, and `workingDir` is used verbatim
 * (never realpath'd or slash-normalized) since that's the literal string claude itself
 * uses as the project key, being whatever string the session was actually launched with
 * as its cwd.
 *
 * Same merge-not-overwrite and corrupt-file-tolerant behavior as `seedApiKeyTrustFile`
 * (same file, so a second sequential read-modify-write here is deliberate rather than
 * folding both into one pass — keeps each seed independently testable and optional).
 */
function seedFirstRunOnboardingState(
  configDir: string,
  trustFile: { relPath: string; shape: 'claude-api-key-responses' },
  workingDir: string
): void {
  const filePath = join(configDir, trustFile.relPath);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  existing.hasCompletedOnboarding = true;
  const projects =
    existing.projects && typeof existing.projects === 'object' && !Array.isArray(existing.projects)
      ? (existing.projects as Record<string, Record<string, unknown>>)
      : {};
  const existingProject = projects[workingDir] && typeof projects[workingDir] === 'object' ? projects[workingDir] : {};
  projects[workingDir] = { ...existingProject, hasTrustDialogAccepted: true };
  existing.projects = projects;
  try {
    writeFileSync(filePath, JSON.stringify(existing, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch {
    // best-effort only — the interactive dialogs return instead of a hard failure here
  }
}

/**
 * Pre-seeds the "skip the bypass-permissions warning" setting (`customModelInjection.
 * skipFirstRunPrompts`, alongside apiKeyTrustFile) into an isolated config directory's
 * `settings.json` — a real, already-onboarded profile answers claude's one-time warning
 * about running with a bypass-permissions flag once and never sees it again, but every
 * custom-model session launches with a fresh, otherwise-empty CLAUDE_CONFIG_DIR that
 * carries none of that (confirmed live). A different file from apiKeyTrustFile's
 * `.claude.json` — this is claude's own global `settings.json`, not project-keyed —
 * so it gets its own merge-not-overwrite read-modify-write.
 */
function seedSkipBypassPermissionsPrompt(configDir: string): void {
  const filePath = join(configDir, 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  existing.skipDangerousModePermissionPrompt = true;
  try {
    writeFileSync(filePath, JSON.stringify(existing, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch {
    // best-effort only — the interactive warning returns instead of a hard failure here
  }
}

/** Best-effort recursive removal of a previously-written configDir. Never throws. */
export function removeConfigDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

/** What applying an endpoint to a session yields, ready for `Session.setCustomModel()`. */
export interface AppliedCustomModel {
  envOverrides: Record<string, string>;
  envKeys: string[];
  configDir?: string;
  launchModel?: string;
}

/**
 * Compute (and for the `configDir` kind, write) everything a session needs to run
 * against `endpoint`/`modelId`. Returns undefined for a CLI with no mechanism.
 *
 * Idempotent on purpose: the boot-recovery path calls it again for a session that
 * was already pointed at an endpoint, so the config files are rewritten in place
 * (same content) and the env values, which are never persisted because they carry
 * the API key, are re-derived from the endpoint store instead.
 */
export function applyCustomModelInjection(
  entry: Pick<CliEntry, 'capabilities'>,
  endpoint: CustomModelEndpoint,
  modelId: string,
  sessionId: string,
  /** Discovered context-window size for `modelId`, if known — see `contextLengthVar`. */
  contextLength?: number,
  /**
   * The session's own working directory — only used for `skipFirstRunPrompts`'s per-project
   * trust-dialog seed, and only when provided (boot recovery, which has no reason to
   * re-answer a dialog that already fired once, omits it rather than re-deriving it).
   */
  workingDir?: string,
  /**
   * Reads one env var from the SESSION's own env overrides (single-key on purpose: the
   * map carries credentials). Only the `configDir` kind uses it, to resolve the CLI's real
   * home for `linkFromRealHome` from the session's value before the server's.
   */
  sessionEnvLookup?: (envVar: string) => string | undefined
): AppliedCustomModel | undefined {
  const injection = buildCustomModelInjection(entry, endpoint, modelId, contextLength);
  if (injection.kind === 'unsupported') return undefined;
  if (injection.kind === 'env') {
    // `configDirVar` (claude's CLAUDE_CONFIG_DIR): point it at the same isolated,
    // per-session directory the `configDir` kind uses, but write no files into it — an
    // empty directory has no stored OAuth credential to conflict with the injected API
    // key, which is the whole point. Reusing the same path keyed by sessionId keeps this
    // idempotent across a boot-recovery re-apply, same as the configDir kind below.
    let envOverrides = injection.envOverrides;
    let configDir: string | undefined;
    if (injection.configDirVar) {
      configDir = customModelConfigDir(sessionId);
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      linkSharedProjectsDir(configDir);
      if (injection.apiKeyTrustFile && injection.apiKey) {
        seedApiKeyTrustFile(configDir, injection.apiKeyTrustFile, injection.apiKey);
      }
      if (injection.skipFirstRunPrompts && injection.apiKeyTrustFile) {
        if (workingDir) seedFirstRunOnboardingState(configDir, injection.apiKeyTrustFile, workingDir);
        seedSkipBypassPermissionsPrompt(configDir);
      }
      envOverrides = { ...envOverrides, [injection.configDirVar]: configDir };
    }
    return {
      envOverrides,
      envKeys: Object.keys(envOverrides),
      configDir,
      launchModel: injection.launchModel,
    };
  }
  const configDir = customModelConfigDir(sessionId);
  const envOverrides = applyConfigDirInjection(configDir, injection, sessionEnvLookup?.(injection.dirEnvVar));
  return { envOverrides, envKeys: Object.keys(envOverrides), configDir, launchModel: injection.launchModel };
}
