/**
 * @fileoverview Resolve the GitHub Copilot CLI binary across common install paths.
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
 * @module utils/copilot-cli-resolver
 */

import { execFileSync } from 'node:child_process';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { getCli } from '../config/cli-registry/registry.js';
import { expandHome } from './cli-resolver.js';
import {
  createCliExecutableResolver,
  formatCliNotFoundMessage,
  type CliResolverHost,
} from './cli-executable-resolver.js';

/**
 * Directories probed after `which`, read from this CLI's registry entry so the spawn
 * path, `codeman doctor` and this resolver cannot disagree about where to look.
 * `~` is expanded by `expandHome`; nothing else is interpreted.
 */
const COPILOT_SEARCH_DIRS = (): string[] => (getCli('copilot')?.discovery.searchDirs ?? []).map(expandHome);

/**
 * A real `copilot --version` prints `GitHub Copilot CLI 1.0.94.`. Anchoring on the product
 * name keeps an unrelated `copilot` binary on PATH from being accepted.
 */
export const COPILOT_VERSION_REGEX = /GitHub Copilot CLI (\d+\.\d+\.\d+)/;

const COPILOT_NOT_FOUND = 'GitHub Copilot CLI not found. Install with: npm install -g @github/copilot';

/**
 * Run `copilot --version` on a candidate path and return the trimmed version when
 * it is the GitHub Copilot CLI. Returns null for anything else — a missing
 * binary, a non-zero exit, a hang (timeout), or output that is not
 * `GitHub Copilot CLI <semver>`-shaped (which is how an unrelated `copilot` on PATH gets rejected).
 *
 * Never runs under vitest: the suites must stay hermetic and must not depend on
 * whether the dev box happens to have copilot installed. The shared resolver host
 * is already inert under vitest, so this gate is defense in depth for any
 * opted-in host that still carries the default probe.
 */
function probeCopilotVersion(binPath: string): string | null {
  if (process.env.VITEST) return null;
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A stuck or hostile `copilot` that ignores SIGTERM would survive the timeout
      // and block the server (execFileSync keeps waiting after the signal).
      killSignal: 'SIGKILL',
    }).trim();
    const candidate = COPILOT_VERSION_REGEX.exec(out)?.[1];
    if (candidate) return candidate;
    console.warn(
      `[CopilotResolver] Ignoring ${binPath}: "copilot --version" printed ${JSON.stringify(out.slice(0, 80))}`
    );
  } catch (err) {
    console.warn(`[CopilotResolver] Ignoring ${binPath}: "copilot --version" failed (${(err as Error).message})`);
  }
  return null;
}

type CopilotVersionProbe = (binPath: string) => string | null;

function createCopilotResolver(
  host?: CliResolverHost,
  versionProbe: CopilotVersionProbe = probeCopilotVersion,
  now?: () => number
) {
  return createCliExecutableResolver<string>(
    {
      binary: 'copilot',
      searchDirs: COPILOT_SEARCH_DIRS,
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
 * Creates an isolated Copilot wrapper around an injected host, version probe and
 * clock. Omitting `versionProbe` keeps the ambient (VITEST-gated) probe, which
 * is exactly what the hermeticity test exercises.
 */
export function createCopilotResolverForTest(
  host: CliResolverHost,
  versionProbe?: CopilotVersionProbe,
  now?: () => number
) {
  return createCopilotResolver(host, versionProbe ?? probeCopilotVersion, now);
}

const copilotResolver = createCopilotResolver();

/**
 * Finds the directory containing a verified `copilot` binary.
 * Checks `which copilot` first, then falls back to common install locations. Every
 * candidate must pass the `copilot --version` sanity probe before it is accepted.
 *
 * @returns Directory path, or null if not found
 */
export function resolveCopilotDir(): string | null {
  return copilotResolver.resolve()?.directory ?? null;
}

/**
 * Check if the GitHub Copilot CLI is available on the system.
 */
export function isCopilotAvailable(): boolean {
  return resolveCopilotDir() !== null;
}

export function getCopilotNotFoundMessage(): string {
  return formatCliNotFoundMessage(COPILOT_NOT_FOUND, copilotResolver.diagnostics());
}

/**
 * Version reported by the resolved `copilot` binary, or null when copilot is
 * unavailable. Surfaced through `GET /api/copilot/status` so a misresolution is
 * diagnosable from the UI.
 */
export function getCopilotCliVersion(): string | null {
  return copilotResolver.resolve()?.metadata ?? null;
}
