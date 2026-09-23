/**
 * @fileoverview Shared CLI executable resolution for the per-CLI resolvers.
 *
 * One lookup chain behind all seven *-cli-resolver modules (claude, opencode,
 * codex, gemini, antigravity, pi, grok): the server process PATH first, then the
 * CLI's common install directories in order, then — last, because it is the
 * only step that spawns anything — an interactive login shell, which is what
 * finds nvm/Homebrew/user-npm installs when Codeman runs as a systemd/launchd
 * service with a minimal PATH (launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin`).
 *
 * Caching is asymmetric, same shape as `resolveClaudeCliVersion` in
 * claude-cli-resolver.ts: a successful resolution is cached for the process
 * lifetime, a MISS is negative-cached and retried only after a doubling backoff
 * (`cliResolveRetryDelayMs`). The callers are request-facing (the per-CLI
 * status endpoints in system-routes.ts, the availability gates in
 * session-routes.ts, and tmux-manager's spawn path), and the login-shell probe
 * is a SYNCHRONOUS spawn bounded by `EXEC_TIMEOUT_MS` — without the negative
 * cache, a missing CLI re-ran the whole chain and stalled the event loop for up
 * to 5s on every request, forever.
 *
 * Test hermeticity: under vitest (`process.env.VITEST`) the production host
 * short-circuits — IO primitives that were not injected become inert stubs, so
 * a suite can never scan the machine's PATH or spawn login shells (the same
 * rule as `IS_TEST_MODE` in tmux-manager and the VITEST gate in
 * `getClaudeCliVersion`). Tests opt back in through the injection hooks
 * (`runCommand`/`isExecutableFile` fakes do no real IO by construction) or, for
 * fixtures that need the real filesystem predicate against their own temp
 * files, via `allowRealIoUnderVitest`.
 *
 * @module utils/cli-executable-resolver
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { loginShellArgs, resolveLocalShell } from './shell-resolver.js';

const SAFE_BINARY_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const LOGIN_SHELL_BEGIN_MARKER = '__CODEMAN_CLI_RESOLVE_BEGIN__';
const LOGIN_SHELL_END_MARKER = '__CODEMAN_CLI_RESOLVE_END__';
/** Maximum rendered length of each bounded diagnostic field, excluding its label. */
const DIAGNOSTIC_FIELD_MAX_LENGTH = 1024;

/** First retry window after a full-chain resolution miss. */
const RESOLVE_RETRY_BASE_MS = 60_000;
/**
 * Ceiling for the doubling backoff. Deliberately shorter than the 15min cap on
 * the claude version probe: that one is cosmetic, while this gates the Run
 * flow, and "installing a CLI while the server is running is picked up without
 * a restart" should stay true within minutes.
 */
const RESOLVE_RETRY_MAX_MS = 5 * 60_000;

/**
 * How long to wait before re-running the resolution chain after `failures`
 * consecutive misses: 1min, 2min, 4min… capped at 5min. Mirrors
 * `claudeVersionRetryDelayMs` in claude-cli-resolver.ts. Exported for tests.
 */
export function cliResolveRetryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(RESOLVE_RETRY_BASE_MS * 2 ** (failures - 1), RESOLVE_RETRY_MAX_MS);
}

export type CliResolutionSource = 'process-path' | 'common-directory' | 'login-shell';

export interface CliResolutionDiagnostics {
  binary: string;
  processPath: string;
  shellPath: string;
  shellArgs: string[];
  searchDirs: string[];
}

export interface CliResolverHost {
  processPath: string;
  shellPath: string;
  shellArgs: string[];
  findOnProcessPath(binary: string): string | null;
  findInLoginShell(binary: string): string | null;
  exists(path: string): boolean;
}

export interface CandidateValidation<T> {
  accepted: boolean;
  metadata?: T;
}

export interface CliResolution<T = undefined> {
  binaryPath: string;
  directory: string;
  source: CliResolutionSource;
  metadata?: T;
}

export interface CliExecutableResolver<T = undefined> {
  resolve(): CliResolution<T> | null;
  diagnostics(): CliResolutionDiagnostics;
}

export interface CliResolverCommandOptions {
  encoding: 'utf8';
  timeout: number;
  stdio: ['ignore', 'pipe', 'ignore'];
  killSignal: 'SIGKILL';
}

export type CliResolverCommandRunner = (file: string, args: string[], options: CliResolverCommandOptions) => string;

export interface ProductionCliResolverHostOptions {
  processPath?: string;
  shellPath?: string;
  shellArgs?: string[];
  runCommand?: CliResolverCommandRunner;
  isExecutableFile?: (path: string) => boolean;
  /**
   * Test-only escape hatch: keep the REAL IO primitives even under vitest.
   * For tests that exercise `isExecutableRegularFile` against their own temp
   * fixtures. Such a test must still inject `runCommand` if it can reach the
   * login-shell step, or it would spawn a real interactive shell.
   */
  allowRealIoUnderVitest?: boolean;
}

function isExecutableRegularFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseLoginShellResult(output: string, binary: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const begin = lines.indexOf(LOGIN_SHELL_BEGIN_MARKER);
  if (begin === -1) return null;
  const end = lines.indexOf(LOGIN_SHELL_END_MARKER, begin + 1);
  if (end === -1) return null;

  for (const candidate of lines.slice(begin + 1, end)) {
    if (isAbsolute(candidate) && basename(candidate) === binary) return candidate;
  }
  return null;
}

function loginShellCommand(binary: string): string {
  return [
    `printf '%s\\n' '${LOGIN_SHELL_BEGIN_MARKER}'`,
    `command -v -- ${binary}`,
    `printf '%s\\n' '${LOGIN_SHELL_END_MARKER}'`,
  ].join('; ');
}

export function createProductionCliResolverHost(options: ProductionCliResolverHostOptions = {}): CliResolverHost {
  const shellPath = options.shellPath ?? resolveLocalShell();
  const shellArgs = options.shellArgs ?? loginShellArgs(shellPath).trim().split(/\s+/).filter(Boolean);
  const processPath = options.processPath ?? process.env.PATH ?? '';
  // Hermeticity gate (see @fileoverview): under vitest, any IO primitive the
  // caller did not inject is replaced by an inert stub. The suites must never
  // depend on — or execute — whatever happens to be installed on the machine
  // running them, and route tests hitting the per-CLI status endpoints would
  // otherwise scan the real PATH and spawn real login shells on CI.
  const inert = Boolean(process.env.VITEST) && options.allowRealIoUnderVitest !== true;
  const isExecutableFile = options.isExecutableFile ?? (inert ? () => false : isExecutableRegularFile);
  const runCommand: CliResolverCommandRunner =
    options.runCommand ?? (inert ? () => '' : (file, args, commandOptions) => execFileSync(file, args, commandOptions));
  const run = (file: string, args: string[]): string => {
    try {
      return runCommand(file, args, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        // SIGKILL is load-bearing: execFileSync's `timeout` only SENDS the kill
        // signal and then keeps waiting for the child to exit. Interactive bash
        // ignores SIGTERM (the default), so a login shell stuck in a blocking
        // .bash_profile would survive the timeout and block the server forever.
        killSignal: 'SIGKILL',
      });
    } catch {
      return '';
    }
  };

  return {
    processPath,
    shellPath,
    shellArgs: [...shellArgs],
    findOnProcessPath: (binary) => {
      if (!SAFE_BINARY_NAME.test(binary)) return null;
      for (const directory of processPath.split(delimiter).filter(Boolean)) {
        const candidate = join(directory, binary);
        if (isAbsolute(candidate) && isExecutableFile(candidate)) return candidate;
      }
      return null;
    },
    findInLoginShell: (binary) => {
      if (!SAFE_BINARY_NAME.test(binary)) return null;
      const candidate = parseLoginShellResult(run(shellPath, [...shellArgs, '-c', loginShellCommand(binary)]), binary);
      return candidate && isExecutableFile(candidate) ? candidate : null;
    },
    exists: isExecutableFile,
  };
}

/**
 * Per-binary invalidation generation, bumped by `invalidateCliExecutableResolvers()`.
 *
 * Every resolver instance (each per-CLI module's private one AND the generic registry
 * resolver in cli-resolver.ts) is built by the factory below and caches in its own
 * closure, so there is no instance to reach from outside. Keying on the BINARY name is
 * what lets one call reach all of them: the CLI-management install/update routes know
 * which binaries just changed, and every resolver knows its own.
 */
const binaryGenerations = new Map<string, number>();

/**
 * Forget every cached result — success and negative-cache backoff alike — for these
 * binaries, so the next `resolve()` re-runs the chain immediately. For an action that
 * just changed what is on disk (an install) or what a CLI's binary IS (editing a custom
 * entry): without it a CLI installed from Settings kept reading as missing for up to the
 * 5-minute backoff, and an edited entry kept launching its old binary until a restart.
 */
export function invalidateCliExecutableResolvers(binaries: readonly string[]): void {
  for (const binary of binaries) binaryGenerations.set(binary, (binaryGenerations.get(binary) ?? 0) + 1);
}

export function createCliExecutableResolver<T = undefined>(
  options: {
    binary: string;
    /**
     * Where to look after the process PATH. A THUNK is accepted alongside an array so a
     * caller sourcing its dirs from the CLI registry can defer the lookup: passing
     * `searchDirs: FOO_SEARCH_DIRS()` evaluates at module import, which froze the dirs
     * before a user `clis.json` or a `reloadCliRegistry()` could be seen. Resolved on each
     * probe and each `diagnostics()` call — a handful of string ops, and only when a probe
     * actually runs.
     */
    searchDirs: string[] | (() => string[]);
    validateCandidate?: (path: string) => CandidateValidation<T>;
    /** Clock injection for tests driving the failure backoff. Defaults to `Date.now`. */
    now?: () => number;
  },
  host: CliResolverHost = createProductionCliResolverHost()
): CliExecutableResolver<T> {
  const resolveSearchDirs = (): string[] =>
    typeof options.searchDirs === 'function' ? options.searchDirs() : options.searchDirs;
  if (!SAFE_BINARY_NAME.test(options.binary)) {
    throw new Error(`Unsafe CLI binary name: ${options.binary}`);
  }

  const now = options.now ?? Date.now;
  /** Successful resolution, cached for the process lifetime. */
  let cached: CliResolution<T> | null = null;
  /** Consecutive full-chain misses (drives the retry backoff). */
  let failures = 0;
  /** Timestamp of the most recent miss. */
  let lastFailureAt = 0;
  /** The invalidation generation the cached state above belongs to. */
  let generation = binaryGenerations.get(options.binary) ?? 0;
  const accept = (path: string | null, source: CliResolutionSource): CliResolution<T> | null => {
    if (!path || !isAbsolute(path) || !host.exists(path)) return null;
    const validation = options.validateCandidate?.(path) ?? ({ accepted: true } as CandidateValidation<T>);
    if (!validation.accepted) return null;
    return {
      binaryPath: path,
      directory: dirname(path),
      source,
      metadata: validation.metadata,
    };
  };

  return {
    resolve() {
      const current = binaryGenerations.get(options.binary) ?? 0;
      if (current !== generation) {
        generation = current;
        cached = null;
        failures = 0;
        lastFailureAt = 0;
      }
      if (cached) return cached;
      // Negative cache: a miss is remembered and the chain — whose login-shell
      // tail is a synchronous 5s-bounded spawn — is not re-run until the
      // backoff elapses. Without this, every status poll and Run click against
      // a missing CLI froze the event loop for the full probe, forever.
      if (failures > 0 && now() - lastFailureAt < cliResolveRetryDelayMs(failures)) return null;

      cached = accept(host.findOnProcessPath(options.binary), 'process-path');
      if (!cached) {
        for (const dir of resolveSearchDirs()) {
          cached = accept(join(dir, options.binary), 'common-directory');
          if (cached) break;
        }
      }
      if (!cached) {
        cached = accept(host.findInLoginShell(options.binary), 'login-shell');
      }

      if (cached) {
        failures = 0;
        lastFailureAt = 0;
        return cached;
      }
      failures += 1;
      lastFailureAt = now();
      return null;
    },
    diagnostics: () => ({
      binary: options.binary,
      processPath: host.processPath,
      shellPath: host.shellPath,
      shellArgs: [...host.shellArgs],
      searchDirs: [...resolveSearchDirs()],
    }),
  };
}

function sanitizeDiagnosticField(value: string, emptyMarker: string): string {
  const flattened = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    return isControl || codePoint === 0x2028 || codePoint === 0x2029 ? ' ' : character;
  })
    .join('')
    .replace(/ +/g, ' ')
    .trim();
  if (!flattened) return emptyMarker;
  if (flattened.length <= DIAGNOSTIC_FIELD_MAX_LENGTH) return flattened;
  return `${flattened.slice(0, DIAGNOSTIC_FIELD_MAX_LENGTH - 1)}…`;
}

export function formatCliNotFoundMessage(base: string, diagnostics: CliResolutionDiagnostics): string {
  const processPath = sanitizeDiagnosticField(diagnostics.processPath, '(empty)');
  const shell = sanitizeDiagnosticField(
    [diagnostics.shellPath, ...diagnostics.shellArgs].filter(Boolean).join(' '),
    '(none)'
  );
  const dirs = sanitizeDiagnosticField(diagnostics.searchDirs.join(', '), '(none)');
  return `${base}\nServer PATH: ${processPath}\nLogin shell: ${shell}\nChecked directories: ${dirs}`;
}
