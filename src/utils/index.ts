/**
 * @fileoverview Utility module exports.
 *
 * This module re-exports all utility classes and functions for easy import.
 *
 * @module utils
 */

export { BufferAccumulator } from './buffer-accumulator.js';
export { LRUMap, type LRUMapOptions } from './lru-map.js';
export { CleanupManager, type TimerOptions } from './cleanup-manager.js';
export { StaleExpirationMap, type StaleExpirationMapOptions } from './stale-expiration-map.js';
export {
  ANSI_ESCAPE_PATTERN_FULL,
  ANSI_ESCAPE_PATTERN_SIMPLE,
  TOKEN_PATTERN,
  SPINNER_PATTERN,
  createAnsiPatternFull,
  createAnsiPatternSimple,
  stripAnsi,
} from './regex-patterns.js';
export {
  MAX_SESSION_TOKENS,
  validateTokenCounts,
  validateTokensAndCost,
} from './token-validation.js';
export {
  stringSimilarity,
  normalizePhrase,
  fuzzyPhraseMatch,
  todoContentHash,
} from './string-similarity.js';
export { assertNever } from './type-safety.js';
export { wrapWithNice } from './nice-wrapper.js';
export { findClaudeDir, getAugmentedPath } from './claude-cli-resolver.js';
export { resolveOpenCodeDir, isOpenCodeAvailable, getOpenCodeAugmentedPath } from './opencode-cli-resolver.js';
