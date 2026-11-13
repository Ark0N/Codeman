/**
 * @fileoverview Resolve the OMP CLI binary across common install paths.
 *
 * Uses the shared `createCliExecutableResolver` (cli-executable-resolver.ts),
 * same as the sibling claude/opencode/codex/gemini/antigravity/pi resolvers:
 * server process PATH first, then common install directories, then — last,
 * because it is the only step that spawns anything — an interactive login
 * shell, which is what finds nvm/Homebrew/user-npm installs when Codeman runs
 * as a systemd/launchd service with a minimal PATH.
 *
 * Provides an augmented PATH directory for tmux sessions.
 *
 * @module utils/omp-cli-resolver
 */

import { execFileSync } from 'node:child_process';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import { createCliExecutableResolver, type CliResolverHost } from './cli-executable-resolver.js';

/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 *
 * `~/.local/bin` still leads, for the reason it always did: omp.sh's installer targets it
 * with no `--dir` override (verified against a real `--no-cache` docker build), while
 * `~/.omp/bin` was an unverified guess that turned out wrong and is kept as a fallback.
 */
const OMP_SEARCH_DIRS = (): string[] => (getCli('omp')?.discovery.searchDirs ?? []).map(expandHome);

/**
 * A real `omp --version` prints `omp/<semver>` (e.g. `omp/17.4.0`).
 *
 * Shape mirrors PI_VERSION_REGEX: a capturing group and a leading boundary so
 * `omp/17.4.0` matches while an unrelated `omp` (some other program) does not.
 */
export const OMP_VERSION_REGEX = /(?:^|\s)omp\/(\d+\.\d+\.\d+)/;

/**
 * Run `omp --version` on a candidate path and return the trimmed version when
 * it looks like the coding agent. Returns null for anything else — a missing
 * binary, a non-zero exit, a hang (timeout), or output that is not
 * `omp/<semver>`-shaped (which is how an unrelated `omp` on PATH gets rejected).
 *
 * Never runs under vitest: the suites must stay hermetic and must not depend on
 * whether the dev box happens to have omp installed. The shared resolver host
 * is already inert under vitest, so this gate is defense in depth for any
 * opted-in host that still carries the default probe.
 */
function probeOmpVersion(binPath: string): string | null {
  if (process.env.VITEST) return null;
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A stuck or hostile `omp` that ignores SIGTERM would survive the timeout
      // and block the server (execFileSync keeps waiting after the signal).
      killSignal: 'SIGKILL',
    }).trim();
    const candidate = OMP_VERSION_REGEX.exec(out)?.[1];
    if (candidate) return candidate;
    console.warn(`[OmpResolver] Ignoring ${binPath}: "omp --version" printed ${JSON.stringify(out.slice(0, 80))}`);
  } catch (err) {
    console.warn(`[OmpResolver] Ignoring ${binPath}: "omp --version" failed (${(err as Error).message})`);
  }
  return null;
}

type OmpVersionProbe = (binPath: string) => string | null;

function createOmpResolver(
  host?: CliResolverHost,
  versionProbe: OmpVersionProbe = probeOmpVersion,
  now?: () => number
) {
  return createCliExecutableResolver<string>(
    {
      binary: 'omp',
      searchDirs: OMP_SEARCH_DIRS,
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
 * Creates an isolated OMP wrapper around an injected host, version probe and
 * clock. Omitting `versionProbe` keeps the ambient (VITEST-gated) probe, which
 * is exactly what the hermeticity test exercises.
 */
export function createOmpResolverForTest(host: CliResolverHost, versionProbe?: OmpVersionProbe, now?: () => number) {
  return createOmpResolver(host, versionProbe ?? probeOmpVersion, now);
}

const ompResolver = createOmpResolver();

/**
 * Finds the directory containing a verified `omp` binary.
 * Checks `which omp` first, then falls back to common install locations. Every
 * candidate must pass the `omp --version` sanity probe before it is accepted.
 *
 * @returns Directory path, or null if not found
 */
export function resolveOmpDir(): string | null {
  return ompResolver.resolve()?.directory ?? null;
}

/**
 * Check if the OMP CLI is available on the system.
 */
export function isOmpAvailable(): boolean {
  return resolveOmpDir() !== null;
}

/**
 * Version reported by the resolved `omp` binary, or null when omp is
 * unavailable. Surfaced through `GET /api/omp/status` so a misresolution is
 * diagnosable from the UI.
 */
export function getOmpCliVersion(): string | null {
  return ompResolver.resolve()?.metadata ?? null;
}
