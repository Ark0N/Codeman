/**
 * @fileoverview Shared Claude CLI binary resolution.
 *
 * Finds the `claude` binary across common installation paths and provides
 * an augmented PATH string. Used by session.ts and tmux-manager.ts
 * to locate the Claude CLI.
 *
 * @module utils/claude-cli-resolver
 */

import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { createCliExecutableResolver } from './cli-executable-resolver.js';

/** Common directories where the Claude CLI binary may be installed */
const CLAUDE_SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.claude', 'local'),
  '/usr/local/bin',
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), 'bin'),
];

const claudeResolver = createCliExecutableResolver({ binary: 'claude', searchDirs: CLAUDE_SEARCH_DIRS });

/**
 * Returns true if the Claude CLI binary can be located (via `which` or one of
 * the common install directories). Mirrors `isGeminiAvailable`/`isAntigravityAvailable`/`isOpenCodeAvailable`/
 * `isCodexAvailable` in the sibling resolvers.
 */
export function isClaudeAvailable(): boolean {
  return findClaudeDir() !== null;
}

/**
 * Finds the directory containing the `claude` binary.
 * Checks `which claude` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function findClaudeDir(): string | null {
  return claudeResolver.resolve()?.directory ?? null;
}

/**
 * Returns an absolute path to the `claude` binary, falling back to the bare
 * name `'claude'` when it cannot be located (so PATH resolution still gets a
 * chance).
 *
 * Preferred over passing `'claude'` to `pty.spawn()`: a PTY child resolves the
 * command against the environment it is handed, and an install that lives in
 * `~/.local/bin` or `~/.claude/local` is frequently absent from the PATH the
 * server process inherited (issue #6).
 */
export function getClaudeBinaryPath(): string {
  const dir = findClaudeDir();
  return dir ? join(dir, 'claude') : 'claude';
}

/** Cached augmented PATH string */
let _augmentedPath: string | null = null;

/**
 * Returns a PATH string that includes the directory containing `claude`.
 *
 * Finds the claude binary (via `which` or common install locations), then
 * prepends its directory to the current PATH if not already present.
 * Result is cached for subsequent calls.
 */
export function getAugmentedPath(): string {
  if (_augmentedPath) return _augmentedPath;

  const currentPath = process.env.PATH || '';
  const claudeDir = findClaudeDir();

  if (!claudeDir) return currentPath;

  if (!currentPath.split(delimiter).includes(claudeDir)) {
    _augmentedPath = `${claudeDir}${delimiter}${currentPath}`;
    return _augmentedPath;
  }

  _augmentedPath = currentPath;
  return _augmentedPath;
}

/**
 * Cache state for the `claude --version` probe.
 *
 * `version` is only ever set from a SUCCESSFUL probe and then kept for the
 * process lifetime (the binary can't change under a running server without a
 * restart). Failures are tracked separately so they expire.
 */
export interface ClaudeVersionProbeState {
  /** Successful probe result; `undefined` until one succeeds. */
  version?: string;
  /** Consecutive failed probes (drives the retry backoff). */
  failures: number;
  /** Timestamp of the most recent failed probe. */
  lastFailureAt: number;
}

/** First retry window after a failed probe. */
const VERSION_PROBE_BASE_RETRY_MS = 60_000;
/** Ceiling for the doubling backoff, so a permanently missing binary settles down. */
const VERSION_PROBE_MAX_RETRY_MS = 15 * 60_000;

/**
 * How long to wait before re-probing after `failures` consecutive failures:
 * 1min, 2min, 4min… capped at 15min. Exported for tests.
 */
export function claudeVersionRetryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(VERSION_PROBE_BASE_RETRY_MS * 2 ** (failures - 1), VERSION_PROBE_MAX_RETRY_MS);
}

/**
 * Cache policy for the version probe, pure apart from the `state` it mutates
 * and the injected `probe` (exported so tests can drive it with a fake clock).
 *
 * Success is cached forever; FAILURE is not. That asymmetry is the fix for a
 * real shipped bug: the old cache stored `null` on any exception and guarded on
 * `!== undefined`, so a single failed probe — a 5s `EXEC_TIMEOUT_MS` timeout, a
 * PATH-starved systemd/launchd environment, a transient fs hiccup — at the FIRST
 * Claude session start left `cliVersion` undefined for EVERY Claude session
 * until the server restarted. An undefined `cliVersion` silently disables
 * wheel-forwarding to Claude's own transcript (`_shouldForwardWheelToApp`),
 * which is the only route to history in repaint mode: a dead wheel on every
 * device at once, matching the issue #205 retest reports.
 *
 * Retries back off so a genuinely absent binary still can't spawn a probe per
 * session start.
 */
export function resolveClaudeCliVersion(
  state: ClaudeVersionProbeState,
  now: number,
  probe: () => string | null
): string | null {
  if (state.version !== undefined) return state.version;
  if (state.failures > 0 && now - state.lastFailureAt < claudeVersionRetryDelayMs(state.failures)) return null;

  let version: string | null = null;
  try {
    version = probe();
  } catch {
    version = null;
  }

  if (version) {
    state.version = version;
    state.failures = 0;
    state.lastFailureAt = 0;
    return version;
  }
  state.failures += 1;
  state.lastFailureAt = now;
  return null;
}

const _claudeVersionState: ClaudeVersionProbeState = { failures: 0, lastFailureAt: 0 };

/** One `claude --version` run. Throws on spawn/timeout failure. */
function probeClaudeCliVersion(): string | null {
  const dir = findClaudeDir();
  const bin = dir ? join(dir, 'claude') : 'claude';
  // execFileSync (no shell) — the resolved path may contain spaces, and there
  // is no untrusted input, but avoid a shell either way.
  const out = execFileSync(bin, ['--version'], {
    encoding: 'utf-8',
    timeout: EXEC_TIMEOUT_MS,
    env: { ...process.env, PATH: getAugmentedPath() },
    // execFileSync's timeout only SENDS the signal and then keeps waiting; a
    // child that ignores SIGTERM would block the server thread permanently.
    killSignal: 'SIGKILL',
  });
  const match = out.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Returns the installed Claude CLI version (e.g. `"2.1.210"`), or null if it
 * can't be determined. Runs `claude --version` at most once per successful
 * resolution; failed probes retry with backoff (see `resolveClaudeCliVersion`).
 *
 * This is a deterministic alternative to scraping the interactive startup
 * banner (`parseClaudeCodeInfo` in session.ts): newer Claude Code builds don't
 * reliably print `Claude Code vX.Y.Z` at startup, and resumed sessions never
 * show it, which left `cliVersion` undefined and silently disabled features
 * gated on it (e.g. wheel-forwarding to Claude's transcript — issue #154).
 */
export function getClaudeCliVersion(): string | null {
  // Keep the test suite hermetic — never spawn a real `claude` subprocess under
  // vitest (matches IS_TEST_MODE in tmux-manager). Tests that need a version set
  // it on the session directly. Deliberately does NOT touch the cache state:
  // recording a phantom failure here would be the very poisoning this fixes.
  if (process.env.VITEST) return null;
  return resolveClaudeCliVersion(_claudeVersionState, Date.now(), probeClaudeCliVersion);
}
