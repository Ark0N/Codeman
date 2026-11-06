/**
 * @fileoverview Whether this Mac has the developer tools a coding agent calls (git, Python).
 *
 * CONTRACT STAGE: the function below has its final signature and a body that throws; the body
 * is written next.
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
 *    second does not spawn once a second.
 */

import type { LocalModelDeveloperTools } from '../types.js';

/** Marks a body the contract stage left unwritten. */
function notImplemented(what: string, ..._args: unknown[]): never {
  throw new Error(`${what} is not implemented yet`);
}

/** How long `/usr/bin/xcode-select -p` may take. */
export const DEVELOPER_TOOLS_TIMEOUT_MS = 2_000;

/** What the check calls. Each member defaults to the real thing; a test injects its own. */
export interface DeveloperToolsDeps {
  /** Default `process.platform`. */
  platform: string;
  /** Runs `file` with `args` and resolves with its exit code (`null` when it timed out or could not be started). */
  run: (file: string, args: readonly string[], timeoutMs: number) => Promise<number | null>;
}

/** `present` when `/usr/bin/xcode-select -p` exits 0, `missing` when it exits with anything else, `unknown` otherwise. */
export async function checkDeveloperTools(deps: Partial<DeveloperToolsDeps> = {}): Promise<LocalModelDeveloperTools> {
  return notImplemented('checkDeveloperTools', deps);
}
