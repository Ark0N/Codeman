/**
 * @fileoverview Whether this Mac has the developer tools a coding agent calls (git, Python).
 *
 * Why it exists: on a Mac without Xcode or the Command Line Tools, `git` and `python3` are
 * stubs that open macOS's "install the command line developer tools" window. A coding agent
 * runs both, so the install window says one honest sentence when the tools are missing
 * (`LOCAL_MODEL_INSTALL_LABELS.developerToolsMissing`).
 *
 * Rules:
 *  - The ONLY command ever run is `/usr/bin/xcode-select -p`, bounded by a timeout. Never
 *    `git`, `python3`, `xcrun` or anything else that would open that window itself.
 *  - macOS only. Anywhere else, and when the command does not answer in time, the answer is
 *    `unknown`, and nothing is said.
 *  - Never throws. The answer is cached for a short while, so a window that polls once a
 *    second does not spawn once a second. Only `present` and `missing` are cached: an
 *    `unknown` is asked again, because it says the check itself did not work.
 *  - Under vitest the default `run` spawns nothing and answers "did not start", so a test
 *    that wants an answer injects its own.
 */

import { execFile } from 'node:child_process';
import type { LocalModelDeveloperTools } from '../types.js';

/** How long `/usr/bin/xcode-select -p` may take. */
export const DEVELOPER_TOOLS_TIMEOUT_MS = 2_000;

/** How long an answer is reused. Installing the tools takes minutes, so a minute of staleness is not seen. */
const DEVELOPER_TOOLS_CACHE_MS = 60_000;

/** The one command this module runs. It prints the active developer directory and exits 0, or exits with an error when there is none. */
const XCODE_SELECT = '/usr/bin/xcode-select';

/** What the check calls. Each member defaults to the real thing; a test injects its own. */
export interface DeveloperToolsDeps {
  /** Default `process.platform`. */
  platform: string;
  /** Runs `file` with `args` and resolves with its exit code (`null` when it timed out or could not be started). */
  run: (file: string, args: readonly string[], timeoutMs: number) => Promise<number | null>;
}

/** The default `run`: one bounded `execFile`, no shell. Spawns nothing under vitest. */
function runBounded(file: string, args: readonly string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.env.VITEST) return resolve(null);
    try {
      execFile(file, [...args], { timeout: timeoutMs }, (err) => {
        if (!err) return resolve(0);
        // A number is the exit code of a command that ran. Anything else (ENOENT, a timeout
        // that killed it) is "it did not answer".
        const code = (err as { code?: unknown }).code;
        resolve(typeof code === 'number' && !(err as { killed?: boolean }).killed ? code : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function check(deps: DeveloperToolsDeps): Promise<LocalModelDeveloperTools> {
  if (deps.platform !== 'darwin') return 'unknown';
  let code: number | null;
  try {
    code = await deps.run(XCODE_SELECT, ['-p'], DEVELOPER_TOOLS_TIMEOUT_MS);
  } catch {
    code = null;
  }
  if (code === null || !Number.isInteger(code)) return 'unknown';
  return code === 0 ? 'present' : 'missing';
}

/**
 * A check that remembers its answer for a minute and shares one run among callers that ask at
 * the same time. `now` is the clock of the cache; a test injects its own.
 */
export function createDeveloperToolsCheck(
  deps: Partial<DeveloperToolsDeps> & { now?: () => number } = {}
): () => Promise<LocalModelDeveloperTools> {
  const resolved: DeveloperToolsDeps = {
    platform: deps.platform ?? process.platform,
    run: deps.run ?? runBounded,
  };
  const now = deps.now ?? Date.now;
  let cached: { answer: LocalModelDeveloperTools; at: number } | undefined;
  let inFlight: Promise<LocalModelDeveloperTools> | undefined;
  return () => {
    if (cached && now() - cached.at < DEVELOPER_TOOLS_CACHE_MS) return Promise.resolve(cached.answer);
    inFlight ??= check(resolved)
      .then((answer) => {
        if (answer !== 'unknown') cached = { answer, at: now() };
        return answer;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/** The check of this server's own Mac. */
let shared = createDeveloperToolsCheck();

/** Forgets the cached answer of this server's own Mac. For tests. */
export function resetDeveloperToolsCache(): void {
  shared = createDeveloperToolsCheck();
}

/**
 * `present` when `/usr/bin/xcode-select -p` exits 0, `missing` when it exits with anything
 * else, `unknown` otherwise. Without `deps` it is the cached check of this server's Mac; with
 * a platform or a runner of the caller's it asks once and remembers nothing.
 */
export async function checkDeveloperTools(deps: Partial<DeveloperToolsDeps> = {}): Promise<LocalModelDeveloperTools> {
  if (deps.platform !== undefined || deps.run !== undefined) {
    return check({ platform: deps.platform ?? process.platform, run: deps.run ?? runBounded });
  }
  return shared();
}
