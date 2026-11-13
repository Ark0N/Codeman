/**
 * @fileoverview Resolve the Grok Build CLI (`grok`, xAI) binary across common install paths.
 *
 * Mirrors pi-cli-resolver.ts, version probe included: `grok` is another short
 * name with known squatters (the unrelated `@vibe-kit/grok-cli` npm package also
 * installs a `grok` bin), so a `which grok` hit is not by itself evidence that
 * xAI's coding agent is installed. Every candidate is sanity-probed with
 * `grok --version` and required to print a version-shaped string (the real CLI
 * prints `grok 1.0.5 (5115b46bc9)`); a binary that fails the probe is treated
 * as absent and the rejected path is logged. The probe cannot tell two
 * version-printing `grok`s apart, which is why `GET /api/grok/status` surfaces
 * path AND version: a misresolution is diagnosable rather than presenting as
 * "the mode just doesn't work".
 *
 * The official installer (`curl -fsSL https://x.ai/cli/install.sh | bash`)
 * places the binary in `~/.grok/bin` and symlinks it into `~/.local/bin`, so
 * those two head the search list.
 *
 * @module utils/grok-cli-resolver
 */

import { execFileSync } from 'node:child_process';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import { createCliExecutableResolver, type CliResolverHost } from './cli-executable-resolver.js';

/** Common directories where the Grok CLI binary may be installed */
/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 */
const GROK_SEARCH_DIRS = (): string[] => (getCli('grok')?.discovery.searchDirs ?? []).map(expandHome);

/**
 * A real `grok --version` prints `grok 1.0.5 (5115b46bc9)` (measured, 1.0.5).
 *
 * Exported and SHARED with the `grok` entry in `config/dependency-registry.ts`,
 * so `codeman doctor` and the run mode cannot disagree about what counts as an
 * installed grok (the same single-source rule as PI_VERSION_REGEX). Shape is
 * dictated by the doctor's `extractVersion()` (first capture group, whole-output
 * scan): hence a capturing group and a leading boundary instead of `^`. No `g`
 * flag, so there is no shared `lastIndex` to reset.
 */
export const GROK_VERSION_REGEX = /(?:^|\s)(\d+\.\d+\.\d+)/;

/**
 * Run `grok --version` on a candidate path and return the version token when it
 * looks like the coding agent. Returns null for anything else: a missing
 * binary, a non-zero exit, a hang (timeout), or output with no version-shaped
 * token (which is how an unrelated `grok` on PATH gets rejected).
 *
 * Never runs under vitest: the suites must stay hermetic and must not depend on
 * whether the dev box happens to have grok installed, and since `grok` is a
 * name with known squatters, this probe would EXECUTE whatever binary of that
 * name the machine carries. The shared resolver host is already inert under
 * vitest, so this gate is defense in depth for any opted-in host that still
 * carries the default probe; tests drive resolution via
 * `createGrokResolverForTest`, whose injected probe bypasses it. Pinned by
 * test/grok-cli-resolver.test.ts.
 */
function probeGrokVersion(binPath: string): string | null {
  if (process.env.VITEST) return null;
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A stuck or hostile `grok` that ignores SIGTERM would survive the timeout
      // and block the server (execFileSync keeps waiting after the signal).
      killSignal: 'SIGKILL',
    }).trim();
    const candidate = GROK_VERSION_REGEX.exec(out)?.[1];
    if (candidate) return candidate;
    console.warn(`[GrokResolver] Ignoring ${binPath}: "grok --version" printed ${JSON.stringify(out.slice(0, 80))}`);
  } catch (err) {
    console.warn(`[GrokResolver] Ignoring ${binPath}: "grok --version" failed (${(err as Error).message})`);
  }
  return null;
}

type GrokVersionProbe = (binPath: string) => string | null;

function createGrokResolver(
  host?: CliResolverHost,
  versionProbe: GrokVersionProbe = probeGrokVersion,
  now?: () => number
) {
  return createCliExecutableResolver<string>(
    {
      binary: 'grok',
      searchDirs: GROK_SEARCH_DIRS,
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
 * Creates an isolated Grok wrapper around an injected host, version probe and
 * clock. Omitting `versionProbe` keeps the ambient (VITEST-gated) probe, which
 * is exactly what the hermeticity test exercises.
 */
export function createGrokResolverForTest(host: CliResolverHost, versionProbe?: GrokVersionProbe, now?: () => number) {
  return createGrokResolver(host, versionProbe ?? probeGrokVersion, now);
}

const grokResolver = createGrokResolver();

/**
 * Finds the directory containing a verified `grok` binary.
 * Checks the server PATH first, then the common install locations
 * (`~/.grok/bin` leading, the official installer's target). Every candidate
 * must pass the `grok --version` sanity probe before it is accepted.
 *
 * @returns Directory path, or null if not found
 */
export function resolveGrokDir(): string | null {
  return grokResolver.resolve()?.directory ?? null;
}

/**
 * Check if the Grok CLI is available on the system.
 */
export function isGrokAvailable(): boolean {
  return resolveGrokDir() !== null;
}

/**
 * Version reported by the resolved `grok` binary, or null when grok is
 * unavailable. Surfaced through `GET /api/grok/status` so a misresolution is
 * diagnosable from the UI.
 */
export function getGrokCliVersion(): string | null {
  return grokResolver.resolve()?.metadata ?? null;
}
