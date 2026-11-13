/**
 * @fileoverview Resolve the Pi CLI (`pi`) binary across common install paths.
 *
 * Mirrors antigravity-cli-resolver.ts, with one addition the other external-CLI
 * resolvers do not need: `pi` is a SHORT, GENERIC name (Raspberry Pi tooling,
 * personal scripts, `$PATH` accidents), so a `which pi` hit is not by itself
 * evidence that the coding agent is installed. Every candidate is therefore
 * sanity-probed with `pi --version` and required to print a semver-shaped
 * string; a binary that fails the probe is treated as absent and the rejected
 * path is logged so a misresolution is diagnosable.
 *
 * Pi ships as the npm package `@earendil-works/pi-coding-agent`, so the search
 * dirs are the usual global-bin locations (npm/bun/manual installs).
 *
 * @module utils/pi-cli-resolver
 */

import { execFileSync } from 'node:child_process';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import { createCliExecutableResolver, type CliResolverHost } from './cli-executable-resolver.js';

/** Common directories where the Pi CLI binary may be installed */
/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 */
const PI_SEARCH_DIRS = (): string[] => (getCli('pi')?.discovery.searchDirs ?? []).map(expandHome);

/**
 * A real `pi --version` prints a semver-shaped string (e.g. `0.84.1`).
 *
 * Exported and SHARED with the `pi` entry in `config/dependency-registry.ts`, so
 * `codeman doctor` and the run mode cannot disagree about what counts as an installed
 * pi: two copies of this rule would let the Dependencies panel report "Pi CLI ✓" on a
 * box where `resolvePiDir()` rejects the same binary and Run Pi stays hidden.
 *
 * Shape is dictated by the doctor's `extractVersion()`, which returns the first CAPTURE
 * GROUP and scans the whole output: hence a capturing group, and a leading boundary
 * instead of `^` so `pi 0.84.1` matches while `v0.84.1` (some other program) does not.
 * No `g` flag, so there is no shared `lastIndex` to reset.
 */
export const PI_VERSION_REGEX = /(?:^|\s)(\d+\.\d+\.\d+)/;

/**
 * Run `pi --version` on a candidate path and return the trimmed version when it
 * looks like the coding agent. Returns null for anything else — a missing
 * binary, a non-zero exit, a hang (timeout), or output that is not semver-shaped
 * (which is how an unrelated `pi` on PATH gets rejected).
 *
 * Never runs under vitest: the suites must stay hermetic and must not depend on
 * whether the dev box happens to have pi installed — and since `pi` is a short
 * GENERIC name, this probe would EXECUTE whatever binary of that name the
 * machine carries. The shared resolver host is already inert under vitest, so
 * this gate is defense in depth for any opted-in host that still carries the
 * default probe; tests drive resolution via `createPiResolverForTest`, whose
 * injected probe bypasses it. Pinned by test/pi-cli-resolver.test.ts.
 */
function probePiVersion(binPath: string): string | null {
  if (process.env.VITEST) return null;
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A stuck or hostile `pi` that ignores SIGTERM would survive the timeout
      // and block the server (execFileSync keeps waiting after the signal).
      killSignal: 'SIGKILL',
    }).trim();
    // Upstream prints a bare version today; tolerate a `pi 0.84.1` style prefix too.
    const candidate = PI_VERSION_REGEX.exec(out)?.[1];
    if (candidate) return candidate;
    console.warn(`[PiResolver] Ignoring ${binPath}: "pi --version" printed ${JSON.stringify(out.slice(0, 80))}`);
  } catch (err) {
    console.warn(`[PiResolver] Ignoring ${binPath}: "pi --version" failed (${(err as Error).message})`);
  }
  return null;
}

type PiVersionProbe = (binPath: string) => string | null;

function createPiResolver(host?: CliResolverHost, versionProbe: PiVersionProbe = probePiVersion, now?: () => number) {
  return createCliExecutableResolver<string>(
    {
      binary: 'pi',
      searchDirs: PI_SEARCH_DIRS,
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
 * Creates an isolated Pi wrapper around an injected host, version probe and
 * clock. Omitting `versionProbe` keeps the ambient (VITEST-gated) probe, which
 * is exactly what the hermeticity test exercises.
 */
export function createPiResolverForTest(host: CliResolverHost, versionProbe?: PiVersionProbe, now?: () => number) {
  return createPiResolver(host, versionProbe ?? probePiVersion, now);
}

const piResolver = createPiResolver();

/**
 * Finds the directory containing a verified `pi` binary.
 * Checks `which pi` first, then falls back to common install locations. Every
 * candidate must pass the `pi --version` sanity probe (§2.6 of the integration
 * plan) before it is accepted.
 *
 * @returns Directory path, or null if not found
 */
export function resolvePiDir(): string | null {
  return piResolver.resolve()?.directory ?? null;
}

/**
 * Check if the Pi CLI is available on the system.
 */
export function isPiAvailable(): boolean {
  return resolvePiDir() !== null;
}

/**
 * Version reported by the resolved `pi` binary, or null when pi is unavailable.
 * Surfaced through `GET /api/pi/status` so a misresolution is diagnosable from the UI.
 */
export function getPiCliVersion(): string | null {
  return piResolver.resolve()?.metadata ?? null;
}
