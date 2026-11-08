/**
 * @fileoverview The ONE gate in front of every `git` the server starts.
 *
 * macOS ships `/usr/bin/git` as a placeholder. On a Mac without the developer tools (Xcode or the
 * Command Line Tools), running it, even as `git --version`, makes macOS open its "install the command
 * line developer tools" window and exit non-zero. The server used to ask "is git here?" that way on the
 * first page load, so a user who had just installed Codeman without git and without an administrator
 * password got that window one second after the install finished, and again at every login.
 * `install.sh` never runs the placeholder for the same reason.
 *
 * So on macOS, when `git` on the server's PATH resolves to that placeholder, the developer tools are
 * proven first: `xcode-select -p` (a real binary that prints and never opens a window) must name a
 * folder that holds a git of its own. Otherwise git counts as absent and is never started.
 *
 * Every site that starts git calls `gitSpawnAllowed()` first and answers a refusal the way it already
 * answers a machine with no git (`gitMissingError()` carries `code: 'ENOENT'` for that).
 * `test/git-spawn-gate.test.ts` fails on a git spawn in a file that does not go through this gate.
 *
 * The decision is pure (`gitSpawnWouldPrompt`, `findOnPath`); the IO around it is two bounded steps, a
 * PATH scan and one `xcode-select -p` (a few milliseconds, capped at 3 s), and only on macOS. A "yes" is
 * kept for the life of the process; a "no" is asked again after `GIT_GATE_NEGATIVE_TTL_MS`, so
 * installing the developer tools later needs no server restart for the git features (the page's own
 * "git is available" flag stays memoized per process, like every other availability flag there).
 *
 * @module utils/git-availability
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { isExecutableRegularFile } from './cli-executable-resolver.js';

/** Apple's placeholder. A real git (Homebrew, MacPorts, Nix) sits elsewhere on the PATH. */
export const APPLE_GIT_PLACEHOLDER = '/usr/bin/git';

const XCODE_SELECT = '/usr/bin/xcode-select';
const XCODE_SELECT_TIMEOUT_MS = 3_000;

/** How long a refusal is kept before the machine is looked at again. */
export const GIT_GATE_NEGATIVE_TTL_MS = 60_000;

/**
 * The first `name` on a PATH-style list that `isExecutable` accepts, or null. Pure.
 * Empty and relative entries are skipped: they mean "the current directory" of whoever runs the
 * command, which this lookup cannot know.
 */
export function findOnPath(
  name: string,
  pathEnv: string | undefined,
  isExecutable: (path: string) => boolean
): string | null {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface GitGateFacts {
  platform: NodeJS.Platform;
  /** What `git` resolves to on the server's PATH (symlinks followed), or null when there is none. */
  gitPath: string | null;
  /** Asked only when it decides the answer, so other machines never pay for it. */
  developerToolsPresent: () => boolean;
}

/**
 * Would starting `git` open macOS's "install the developer tools" window? Pure.
 * Only Apple's placeholder does that, and only while no developer tools are installed. No git on the
 * PATH at all is not this function's case: the spawn then fails with ENOENT, which every caller handles.
 */
export function gitSpawnWouldPrompt(facts: GitGateFacts): boolean {
  if (facts.platform !== 'darwin') return false;
  if (facts.gitPath !== APPLE_GIT_PLACEHOLDER) return false;
  return !facts.developerToolsPresent();
}

/**
 * The developer folder `xcode-select -p` names must hold a git of its own (`usr/bin/git`, true for both
 * Xcode and the Command Line Tools). A selected folder that has since been deleted would otherwise read
 * as "tools present" and the placeholder would open its window after all.
 */
export function developerDirHoldsGit(developerDir: string, isExecutable: (path: string) => boolean): boolean {
  const dir = developerDir.trim();
  if (!dir || !isAbsolute(dir)) return false;
  return isExecutable(join(dir, 'usr', 'bin', 'git'));
}

function resolveGitOnPath(): string | null {
  const found = findOnPath('git', process.env.PATH, isExecutableRegularFile);
  if (!found) return null;
  try {
    return realpathSync(found);
  } catch {
    return found;
  }
}

function developerToolsPresent(): boolean {
  try {
    const out = execFileSync(XCODE_SELECT, ['-p'], {
      encoding: 'utf8',
      timeout: XCODE_SELECT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return developerDirHoldsGit(out, isExecutableRegularFile);
  } catch {
    return false; // exit 2: no developer folder. Never the placeholder's window.
  }
}

let allowed: boolean | null = null;
let refusedAt = 0;

/**
 * May the server start `git` right now? False only on a Mac whose only git is Apple's placeholder with
 * no developer tools behind it. Callers answer false as "git is not installed".
 */
export function gitSpawnAllowed(): boolean {
  if (allowed === true) return true;
  if (allowed === false && Date.now() - refusedAt < GIT_GATE_NEGATIVE_TTL_MS) return false;
  const platform = process.platform;
  allowed = !gitSpawnWouldPrompt({
    platform,
    gitPath: platform === 'darwin' ? resolveGitOnPath() : null,
    developerToolsPresent,
  });
  if (!allowed) refusedAt = Date.now();
  return allowed;
}

/** The error a refused spawn stands in for: what Node raises when there is no `git` to start. */
export function gitMissingError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('spawn git ENOENT');
  err.code = 'ENOENT';
  err.errno = -2;
  err.syscall = 'spawn git';
  err.path = 'git';
  return err;
}

/** Test seam: forget the remembered answer. */
export function resetGitGateForTests(): void {
  allowed = null;
  refusedAt = 0;
}
