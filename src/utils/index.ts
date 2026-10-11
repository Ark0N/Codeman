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
export { isProcessRunning, waitForProcessesExit, PROCESS_EXIT_POLL_MS } from './process-exit-wait.js';
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
export { wrapWithNice } from './nice-wrapper.js';
export { resolveLocalShell, loginShellArgs } from './shell-resolver.js';
export {
  findClaudeDir,
  getAugmentedPath,
  getClaudeCliVersion,
  getClaudeBinaryPath,
  getClaudeNotFoundMessage,
} from './claude-cli-resolver.js';
export { spawnPtyWithHelperRepair } from './node-pty-repair.js';
export { resolveOpenCodeDir, getOpenCodeNotFoundMessage } from './opencode-cli-resolver.js';
export {
  resolveCodexDir,
  resolveCodexBinaryPath,
  isCodexAvailable,
  getCodexNotFoundMessage,
  readCodexPlanUsage,
} from './codex-cli-resolver.js';
export { resolveGeminiDir, isGeminiAvailable, getGeminiNotFoundMessage } from './gemini-cli-resolver.js';
export {
  resolveAntigravityDir,
  isAntigravityAvailable,
  getAntigravityNotFoundMessage,
} from './antigravity-cli-resolver.js';
export { resolvePiDir, isPiAvailable, getPiCliVersion, getPiNotFoundMessage } from './pi-cli-resolver.js';
export { resolveGrokDir, isGrokAvailable, getGrokCliVersion, getGrokNotFoundMessage } from './grok-cli-resolver.js';
export {
  resolveDeepSeekDir,
  isDeepSeekAvailable,
  isDeepSeekRunnable,
  getDeepSeekCliVersion,
  getDeepSeekNotFoundMessage,
  listDeepSeekProfiles,
  resolveDefaultDeepSeekProfile,
  isLaunchableProfile,
  resolveDshHome,
  profileExists,
} from './deepseek-cli-resolver.js';
export type { DeepSeekProfile, DeepSeekProfileKind } from './deepseek-cli-resolver.js';
export { compileFileQuery, matchFileQuery } from './file-query.js';
export type { FileQueryMatcher } from './file-query.js';
export { resolveOmpDir, isOmpAvailable, getOmpNotFoundMessage, getOmpCliVersion } from './omp-cli-resolver.js';
export {
  resolveCopilotDir,
  isCopilotAvailable,
  getCopilotNotFoundMessage,
  getCopilotCliVersion,
} from './copilot-cli-resolver.js';
export { readCopilotPlanUsage, resolveCopilotToken } from './copilot-plan-usage.js';
export {
  boundedPathExists,
  describeUnknownPath,
  probePath,
  probePathKind,
  isNearStalledPath,
  unknownPathReason,
} from './bounded-path-probe.js';
export type { PathProbeState, PathProbeKind, PathProbeOptions } from './bounded-path-probe.js';
