/**
 * @fileoverview Utility module exports.
 *
 * This module re-exports all utility classes and functions for easy import.
 *
 * @module utils
 */

export { BufferAccumulator } from './buffer-accumulator.js';
export { CleanupManager } from './cleanup-manager.js';
export { Debouncer, KeyedDebouncer } from './debouncer.js';
export { startEventLoopMonitor } from './event-loop-monitor.js';
export type { EventLoopMonitorHandle } from './event-loop-monitor.js';
export { StaleExpirationMap } from './stale-expiration-map.js';
export { waitForProcessesExit } from './process-exit-wait.js';
export {
  ANSI_ESCAPE_PATTERN_FULL,
  ANSI_ESCAPE_PATTERN_SIMPLE,
  TOKEN_PATTERN,
  SPINNER_PATTERN,
  CLAUDE_WORKING_LINE_PATTERN,
  stripAnsi,
  SAFE_PATH_PATTERN,
  execPattern,
} from './regex-patterns.js';
export { MAX_SESSION_TOKENS } from './token-validation.js';
export { isSafePushEndpoint } from './push-endpoint-validation.js';
export { stringSimilarity, fuzzyPhraseMatch, todoContentHash } from './string-similarity.js';
export { assertNever } from './type-safety.js';
export { toSingleLine } from './single-line.js';
export { wrapWithNice } from './nice-wrapper.js';
export { resolveLocalShell, loginShellArgs } from './shell-resolver.js';
export { getAugmentedPath, getClaudeCliVersion, getClaudeBinaryPath } from './claude-cli-resolver.js';
export { spawnPtyWithHelperRepair } from './node-pty-repair.js';
export {
  boundedPathExists,
  describeUnknownPath,
  probePath,
  probePathKind,
  isNearStalledPath,
} from './bounded-path-probe.js';
export type { PathProbeOptions } from './bounded-path-probe.js';
