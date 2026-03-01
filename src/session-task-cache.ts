/**
 * @fileoverview LRU cache for task descriptions parsed from terminal output.
 *
 * Stores descriptions extracted from Claude Code's Task tool invocations
 * (e.g., "Explore(Check files)") keyed by timestamp. Used to correlate
 * with SubagentWatcher discoveries for better window titles.
 *
 * @module session-task-cache
 */

import { LRUMap } from './utils/lru-map.js';

/** Default maximum number of task descriptions to keep */
const DEFAULT_MAX_SIZE = 100;

/** Default maximum age for task descriptions (30 seconds) */
const DEFAULT_MAX_AGE_MS = 30_000;

/**
 * LRU cache for task descriptions parsed from terminal output.
 *
 * Descriptions are keyed by the timestamp when they were parsed.
 * Old entries are automatically cleaned up based on maxAgeMs.
 * Size is bounded by the underlying LRUMap.
 */
export class SessionTaskCache {
  private readonly cache: LRUMap<number, string>;
  private readonly maxAgeMs: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE, maxAgeMs: number = DEFAULT_MAX_AGE_MS) {
    this.cache = new LRUMap<number, string>({ maxSize });
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Add a task description at the given timestamp.
   */
  add(timestamp: number, description: string): void {
    this.cache.set(timestamp, description);
  }

  /**
   * Remove task descriptions older than maxAgeMs.
   * LRUMap maintains insertion order, so we can break early
   * once we find a non-expired entry.
   */
  private cleanupOld(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const timestamp of this.cache.keysInOrder()) {
      if (timestamp < cutoff) {
        this.cache.delete(timestamp);
      } else {
        break;
      }
    }
  }

  /**
   * Get all recent task descriptions sorted by timestamp (most recent first).
   */
  getAll(): Array<{ timestamp: number; description: string }> {
    this.cleanupOld();
    const results: Array<{ timestamp: number; description: string }> = [];
    for (const [timestamp, description] of this.cache) {
      results.push({ timestamp, description });
    }
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Find a task description that was parsed close to a given timestamp.
   * Used to correlate with SubagentWatcher discoveries.
   *
   * @param subagentStartTime - The timestamp when the subagent was discovered
   * @param maxAgeMs - Maximum age difference to consider (default 10 seconds)
   * @returns The matching description or undefined
   */
  findNear(subagentStartTime: number, maxAgeMs: number = 10000): string | undefined {
    this.cleanupOld();

    let bestMatch: { timestamp: number; description: string } | undefined;
    let bestDiff = Infinity;

    for (const [timestamp, description] of this.cache) {
      const diff = Math.abs(subagentStartTime - timestamp);
      if (diff < maxAgeMs && diff < bestDiff) {
        bestMatch = { timestamp, description };
        bestDiff = diff;
      }
    }

    return bestMatch?.description;
  }

  /**
   * Clear all cached descriptions.
   */
  clear(): void {
    this.cache.clear();
  }
}
