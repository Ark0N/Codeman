/**
 * @fileoverview Resolve the DeepSeek Harness CLI (`dsh`) binary and its bootable profiles.
 *
 * Mirrors pi-cli-resolver.ts / grok-cli-resolver.ts, but the identity probe here
 * is STRICTER than either, and deliberately so: `dsh` is not merely a short name
 * with npm squatters, it is an EXISTING, widely packaged Unix program. Debian and
 * Ubuntu ship `dsh` = "dancer's shell" / distributed shell (`apt install dsh`),
 * which like nearly every Unix tool prints a version-shaped string of its own.
 * A version-token probe alone (which is all pi and grok need) would
 * therefore ACCEPT dancer's shell as the DeepSeek Harness and hand it to a spawn
 * line, so every candidate must additionally prove its identity by printing the
 * harness's own help banner.
 *
 * Two probes per candidate, both bounded and both cached behind the shared
 * resolver's positive/negative caching:
 *   1. `dsh --help`    must match DEEPSEEK_IDENTITY_REGEX (`DeepSeek Harness`)
 *   2. `dsh --version` must yield a version token (real output: `0.1.1-rc.2`)
 * Order matters: identity is checked FIRST, so a foreign `dsh` is rejected on the
 * cheaper, more discriminating signal and never contributes a version number.
 *
 * `dsh` is a profile LAUNCHER, not an agent: `dsh --profile <name>` boots an
 * ordered stack of plugin-bundle patch layers, and DeepSeek ships only `web`
 * (browser UI), `headless` (one-shot) and `base` (no app). The interactive
 * terminal agent Codeman actually drives is a THIRD-PARTY profile the user
 * installs. That is why this module resolves two independent things — a binary
 * AND a profile inventory — and why "available" for the deepseek run mode means
 * both (`isDeepSeekRunnable`, and `resolveDeepSeekLaunchError` in session-routes.ts
 * for the actionable per-half message).
 *
 * @module utils/deepseek-cli-resolver
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import {
  createCliExecutableResolver,
  formatCliNotFoundMessage,
  type CliResolverHost,
} from './cli-executable-resolver.js';

/**
 * Common directories where the `dsh` binary may be installed.
 *
 * `dsh` is an npm package (`@deepseek-ai/dsh`), so unlike grok there is no
 * vendor-owned install dir to lead with: the global npm bin is wherever the
 * user's prefix points. `~/.local/bin` heads the list because it is the default
 * for a prefix-relocated npm (and is where this box's install landed).
 */
/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 */
const DEEPSEEK_SEARCH_DIRS = (): string[] => (getCli('deepseek')?.discovery.searchDirs ?? []).map(expandHome);

/**
 * A real `dsh --version` prints a bare `0.1.1-rc.2` (measured, 0.1.1-rc.2), so
 * the prerelease suffix is part of the token — truncating it to `0.1.1` would
 * misreport a release-candidate as a release in `codeman doctor`.
 *
 * Exported and SHARED with the `dsh` entry in `config/dependency-registry.ts`,
 * so the doctor and the run mode cannot disagree about what counts as an
 * installed dsh (the same single-source rule as PI_VERSION_REGEX /
 * GROK_VERSION_REGEX). Shape is dictated by the doctor's `extractVersion()`
 * (first capture group, whole-output scan): hence a capturing group and a
 * leading boundary instead of `^`. No `g` flag, so there is no shared
 * `lastIndex` to reset.
 */
export const DEEPSEEK_VERSION_REGEX = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/;

/**
 * The identity marker that separates DeepSeek's `dsh` from Debian's dancer's
 * shell. The real launcher's `--help` banner reads:
 *
 *   dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle …
 *
 * Matched case-insensitively against the help output. This is the check that
 * makes the resolver safe to point a spawn line at; see the module header.
 */
export const DEEPSEEK_IDENTITY_REGEX = /DeepSeek\s+Harness/i;

const DEEPSEEK_NOT_FOUND = 'DeepSeek Harness CLI (dsh) not found. Install with: npm install -g @deepseek-ai/dsh';

/** Where profiles live: `$DSH_HOME/profiles`, defaulting to `~/.dsh/profiles`. */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
}

/**
 * What a profile is FOR, inferred from the bundles it composes.
 *
 * `interactive` is the only kind a tmux pane can drive: `web` serves a browser
 * UI and would occupy the pane with a logging server, `headless` answers one
 * task and exits (which reads as an instantly-dead pane). `unknown` is treated
 * as interactive-capable on purpose — the whole point of the harness is that
 * anyone can publish an app bundle, so an unrecognized third-party profile must
 * not be hidden from the picker just because this list has not heard of it.
 */
export type DeepSeekProfileKind = 'interactive' | 'web' | 'headless' | 'unknown';

export interface DeepSeekProfile {
  /** Directory name under `$DSH_HOME/profiles`, i.e. the `--profile` argument. */
  name: string;
  /** Bundle package names composed by the profile, in order. */
  bundles: string[];
  kind: DeepSeekProfileKind;
}

/** Bundles that positively identify a non-interactive profile. */
const WEB_BUNDLE_PATTERN = /dsh-web-app|dsh-web-frontend/i;
const HEADLESS_BUNDLE_PATTERN = /dsh-headless/i;
/**
 * Bundles that positively identify a terminal app. Intentionally a loose
 * community-wide pattern rather than one blessed package: the terminal front
 * door is third-party by construction (DeepSeek ships none), and a dozen
 * scoped `dsh-tui` packages from a dozen different authors compete. Anything
 * matching is a TUI; anything unmatched is `unknown`, which still counts as
 * launchable.
 *
 * `tui` carries word boundaries so the loose arm stays a TOKEN match: `-` and
 * `/` are non-word characters, so `@someone/tui-app` and `dsh-tui` both match
 * while `intuition` and `gratuitous` do not. Being wrong here is cheap (an
 * unmatched profile is `unknown`, which is launchable too) but it decides which
 * profile a session boots by DEFAULT, and "the one whose name happens to contain
 * t-u-i" is not a rule anyone could predict.
 */
const TUI_BUNDLE_PATTERN = /dsh-tui|dsh-terminal-app|\btui\b/i;

/**
 * The profile names DeepSeek itself ships for its non-interactive surfaces.
 *
 * Consulted only AFTER the bundle patterns have found nothing, and only against
 * the directory name. `readProfile()` yields an empty bundle list for any
 * `package.json` without a `dsh.profile.bundles` array — a hand-edited file, an
 * older layout, a profile mid-install — and with no bundles to read, the stock
 * `web` and `headless` profiles look exactly like an unrecognized third-party
 * one and inherit its launchable-by-default treatment. That is the single
 * "unknown" that is knowably wrong, and it produces precisely the
 * pane-dies-on-arrival failure the two-part availability gate exists to prevent.
 *
 * Deliberately a fallback rather than a first check: a third-party profile that
 * legitimately composes a terminal app is identified by its BUNDLES, and its
 * directory name (which the user chose) must never override that evidence.
 */
const STOCK_NON_INTERACTIVE_PROFILES = new Map<string, DeepSeekProfileKind>([
  ['web', 'web'],
  ['headless', 'headless'],
]);

/** Profile directory names that are not profiles. */
const NON_PROFILE_DIRS = new Set(['node_modules', '.bin', '.pnpm']);

/** Whether a directory under `$DSH_HOME/profiles` can be a profile at all (not `node_modules`, not hidden). */
export function isProfileDirName(name: string): boolean {
  return !NON_PROFILE_DIRS.has(name) && !name.startsWith('.');
}

function classifyProfile(name: string, bundles: string[]): DeepSeekProfileKind {
  const haystack = [name, ...bundles].join(' ');
  // Order matters: a profile that composes BOTH a web app and a tui bundle is a
  // web profile as far as a tmux pane is concerned, because the web app owns the
  // process and blocks.
  if (WEB_BUNDLE_PATTERN.test(haystack)) return 'web';
  if (HEADLESS_BUNDLE_PATTERN.test(haystack)) return 'headless';
  if (TUI_BUNDLE_PATTERN.test(haystack)) return 'interactive';
  return STOCK_NON_INTERACTIVE_PROFILES.get(name.toLowerCase()) ?? 'unknown';
}

/**
 * Read a single profile directory's `package.json` and return its bundle list.
 * Returns null for anything that is not a readable dsh profile, so a stray
 * directory under `profiles/` cannot break the inventory.
 */
function readProfile(profilesDir: string, name: string): DeepSeekProfile | null {
  try {
    return deepSeekProfileFromManifest(name, readFileSync(join(profilesDir, name, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * A profile from its directory name and the text of its `package.json`, or null when
 * that text is not JSON. Pure, so a caller with its own (bounded, async) reads gets the
 * same classification as the inventory below.
 */
export function deepSeekProfileFromManifest(name: string, raw: string): DeepSeekProfile | null {
  try {
    const parsed = JSON.parse(raw) as { dsh?: { profile?: { bundles?: unknown } } };
    const rawBundles = parsed?.dsh?.profile?.bundles;
    const bundles = Array.isArray(rawBundles) ? rawBundles.filter((b): b is string => typeof b === 'string') : [];
    return { name, bundles, kind: classifyProfile(name, bundles) };
  } catch {
    return null;
  }
}

/**
 * Inventory the profiles installed under `$DSH_HOME/profiles`.
 *
 * Never throws: a missing DSH_HOME (dsh installed but never run) is an empty
 * list, which the callers render as "no profile yet" rather than an error.
 * Deliberately un-cached — a user can create a profile at any moment (including
 * through Codeman's own bootstrap), and the directory scan is cheap next to the
 * two process spawns the binary probe already costs.
 */
export function listDeepSeekProfiles(): DeepSeekProfile[] {
  const profilesDir = join(resolveDshHome(), 'profiles');
  let entries: string[];
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isProfileDirName(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .map((name) => readProfile(profilesDir, name))
    .filter((p): p is DeepSeekProfile => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The profile a session should boot when the user picked none.
 *
 * Prefers a positively-identified terminal profile, then an unrecognized one
 * (third-party by construction — see TUI_BUNDLE_PATTERN), and refuses to fall
 * back to `web`/`headless`, which cannot drive a pane. Returns null when nothing
 * launchable is installed, which is what makes the mode report unavailable
 * instead of spawning a pane that dies on arrival.
 */
export function resolveDefaultDeepSeekProfile(profiles: DeepSeekProfile[] = listDeepSeekProfiles()): string | null {
  return (
    profiles.find((p) => p.kind === 'interactive')?.name ?? profiles.find((p) => p.kind === 'unknown')?.name ?? null
  );
}

/** True when the profile can occupy a tmux pane as an interactive agent. */
export function isLaunchableProfile(profile: DeepSeekProfile): boolean {
  return profile.kind === 'interactive' || profile.kind === 'unknown';
}

/**
 * Run the two-stage identity+version probe on a candidate path.
 *
 * Returns the version token only when the binary proves it is the DeepSeek
 * Harness launcher. Returns null for anything else: a missing binary, a
 * non-zero exit, a hang (timeout), a help banner without the harness marker
 * (this is the dancer's-shell rejection), or output with no version-shaped
 * token.
 *
 * Never runs under vitest: the suites must stay hermetic and must not depend on
 * whether the dev box happens to have dsh installed — and since `dsh` names a
 * real Debian program, this probe would EXECUTE whatever binary of that name the
 * machine carries. The shared resolver host is already inert under vitest, so
 * this gate is defense in depth for any opted-in host that still carries the
 * default probe; tests drive resolution via `createDeepSeekResolverForTest`,
 * whose injected probe bypasses it. Pinned by test/deepseek-cli-resolver.test.ts.
 */
function probeDeepSeekVersion(binPath: string): string | null {
  if (process.env.VITEST) return null;
  const run = (args: string[]): string | null => {
    try {
      return execFileSync(binPath, args, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        // A stuck or hostile `dsh` that ignores SIGTERM would survive the timeout
        // and block the server (execFileSync keeps waiting after the signal).
        killSignal: 'SIGKILL',
      }).trim();
    } catch (err) {
      console.warn(
        `[DeepSeekResolver] Ignoring ${binPath}: "dsh ${args.join(' ')}" failed (${(err as Error).message})`
      );
      return null;
    }
  };

  // Identity first — the discriminating signal, and the one that keeps Debian's
  // dancer's shell out of a spawn line.
  const help = run(['--help']);
  if (help === null) return null;
  if (!DEEPSEEK_IDENTITY_REGEX.test(help)) {
    console.warn(
      `[DeepSeekResolver] Ignoring ${binPath}: "dsh --help" is not the DeepSeek Harness launcher ` +
        `(printed ${JSON.stringify(help.slice(0, 80))}). A different program named "dsh" (e.g. Debian's ` +
        `dancer's shell) is earlier on PATH.`
    );
    return null;
  }

  const out = run(['--version']);
  if (out === null) return null;
  const candidate = DEEPSEEK_VERSION_REGEX.exec(out)?.[1];
  if (candidate) return candidate;
  console.warn(`[DeepSeekResolver] Ignoring ${binPath}: "dsh --version" printed ${JSON.stringify(out.slice(0, 80))}`);
  return null;
}

type DeepSeekVersionProbe = (binPath: string) => string | null;

function createDeepSeekResolver(
  host?: CliResolverHost,
  versionProbe: DeepSeekVersionProbe = probeDeepSeekVersion,
  now?: () => number
) {
  return createCliExecutableResolver<string>(
    {
      binary: 'dsh',
      searchDirs: DEEPSEEK_SEARCH_DIRS,
      validateCandidate: (binPath) => {
        const version = versionProbe(binPath);
        return version ? { accepted: true, metadata: version } : { accepted: false };
      },
      now,
    },
    host
  );
}

/**
 * Creates an isolated DeepSeek wrapper around an injected host, version probe
 * and clock. Omitting `versionProbe` keeps the ambient (VITEST-gated) probe,
 * which is exactly what the hermeticity test exercises.
 */
export function createDeepSeekResolverForTest(
  host: CliResolverHost,
  versionProbe?: DeepSeekVersionProbe,
  now?: () => number
) {
  return createDeepSeekResolver(host, versionProbe ?? probeDeepSeekVersion, now);
}

const deepSeekResolver = createDeepSeekResolver();

/**
 * Finds the directory containing a verified `dsh` binary.
 * Checks the server PATH first, then the common install locations. Every
 * candidate must pass the identity+version probe before it is accepted.
 *
 * @returns Directory path, or null if not found
 */
export function resolveDeepSeekDir(): string | null {
  return deepSeekResolver.resolve()?.directory ?? null;
}

/**
 * Whether the `dsh` BINARY is installed. Note this is deliberately weaker than
 * what the run mode needs: a dsh with no launchable profile cannot start a
 * session. Callers gating the Run button want `isDeepSeekRunnable()`.
 */
export function isDeepSeekAvailable(): boolean {
  return resolveDeepSeekDir() !== null;
}

/** Binary present AND at least one profile that can occupy a pane. */
export function isDeepSeekRunnable(): boolean {
  return isDeepSeekAvailable() && resolveDefaultDeepSeekProfile() !== null;
}

export function getDeepSeekNotFoundMessage(): string {
  return formatCliNotFoundMessage(DEEPSEEK_NOT_FOUND, deepSeekResolver.diagnostics());
}

/**
 * Version reported by the resolved `dsh` binary, or null when dsh is
 * unavailable. Surfaced through `GET /api/deepseek/status` so a misresolution
 * is diagnosable from the UI.
 */
export function getDeepSeekCliVersion(): string | null {
  return deepSeekResolver.resolve()?.metadata ?? null;
}

/** Does the named profile exist and can it drive a pane? */
export function profileExists(name: string): boolean {
  return existsSync(join(resolveDshHome(), 'profiles', name, 'package.json'));
}

/**
 * Why a DeepSeek session cannot start, or null when it can.
 *
 * Availability for this mode is TWO questions, not one, because `dsh` is a
 * profile launcher rather than an agent: the binary must resolve (and prove it
 * is the harness and not Debian's dancer's shell), AND a profile that can occupy
 * a pane must exist. Every create path — both HTTP routes AND cron fires — must
 * ask this before constructing a Session, or the pane boots the box's default
 * profile, which may be a logging web server or a one-shot that exits on
 * arrival, and the prompt is typed into it.
 */
export function resolveDeepSeekLaunchError(requestedProfile?: string): string | null {
  if (!isDeepSeekAvailable()) return getDeepSeekNotFoundMessage();

  const profiles = listDeepSeekProfiles();
  if (requestedProfile) {
    const match = profiles.find((p) => p.name === requestedProfile);
    if (!match) {
      return `DeepSeek Harness profile "${requestedProfile}" does not exist. Create it with: dsh plugin --profile ${requestedProfile} add <package>`;
    }
    if (match.kind === 'web' || match.kind === 'headless') {
      return `DeepSeek Harness profile "${requestedProfile}" is a ${match.kind} profile and cannot run in a terminal session. Pick an interactive profile, or open the web profile as a Codeman web tab.`;
    }
    return null;
  }

  if (!resolveDefaultDeepSeekProfile(profiles)) {
    return (
      'No interactive DeepSeek Harness profile is installed. DeepSeek ships only the web and headless ' +
      'profiles, so the terminal agent comes from a plugin — install one with: ' +
      'dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui'
    );
  }
  return null;
}
