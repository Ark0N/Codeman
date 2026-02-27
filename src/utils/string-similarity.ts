/**
 * @fileoverview String similarity utilities for fuzzy matching.
 *
 * Provides Levenshtein distance and similarity scoring for:
 * - Completion phrase fuzzy matching
 * - Todo content deduplication
 *
 * @module utils/string-similarity
 */

/**
 * Calculate the Levenshtein (edit) distance between two strings.
 * This is the minimum number of single-character edits (insertions,
 * deletions, or substitutions) required to change one string into the other.
 *
 * Uses Wagner-Fischer algorithm with O(min(m,n)) space optimization.
 *
 * @param a - First string
 * @param b - Second string
 * @returns The edit distance (0 = identical)
 *
 * @example
 * levenshteinDistance('hello', 'hello') // 0
 * levenshteinDistance('hello', 'helo')  // 1 (one deletion)
 * levenshteinDistance('COMPLETE', 'COMPLET') // 1 (one deletion)
 */
export function levenshteinDistance(a: string, b: string): number {
  // Ensure a is the shorter string for space efficiency
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Early exit for identical strings
  if (a === b) return 0;

  // Early exit for empty strings
  if (m === 0) return n;

  // Use single array (space optimization)
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);

  // Initialize first row
  for (let i = 0; i <= m; i++) {
    prev[i] = i;
  }

  // Fill the matrix row by row
  for (let j = 1; j <= n; j++) {
    curr[0] = j;

    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1, // deletion
        curr[i - 1] + 1, // insertion
        prev[i - 1] + cost // substitution
      );
    }

    // Swap rows
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

/**
 * Calculate similarity ratio between two strings (0 to 1).
 * Uses Levenshtein distance normalized by the longer string's length.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity ratio (1.0 = identical, 0.0 = completely different)
 *
 * @example
 * stringSimilarity('hello', 'hello') // 1.0
 * stringSimilarity('hello', 'helo')  // 0.8 (4/5 similar)
 * stringSimilarity('abc', 'xyz')     // 0.0 (3 edits, length 3)
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);
  return 1 - distance / maxLength;
}

/**
 * Check if two strings are similar within a given threshold.
 *
 * @param a - First string
 * @param b - Second string
 * @param threshold - Minimum similarity ratio (default: 0.85 = 85% similar)
 * @returns True if similarity >= threshold
 *
 * @example
 * isSimilar('COMPLETE', 'COMPLET', 0.85)  // true (87.5% similar)
 * isSimilar('COMPLETE', 'DONE', 0.85)     // false (0% similar)
 */
export function isSimilar(a: string, b: string, threshold = 0.85): boolean {
  return stringSimilarity(a, b) >= threshold;
}

/**
 * Check if two strings are similar with edit distance tolerance.
 * More intuitive for short strings than percentage-based threshold.
 *
 * @param a - First string
 * @param b - Second string
 * @param maxDistance - Maximum allowed edit distance (default: 2)
 * @returns True if edit distance <= maxDistance
 *
 * @example
 * isSimilarByDistance('COMPLETE', 'COMPLET', 2)   // true (distance 1)
 * isSimilarByDistance('COMPLETE', 'COMP', 2)     // false (distance 4)
 */
export function isSimilarByDistance(a: string, b: string, maxDistance = 2): boolean {
  return levenshteinDistance(a, b) <= maxDistance;
}

/**
 * Normalize a completion phrase for comparison.
 * Handles variations in case, whitespace, and separators.
 *
 * @param phrase - Raw completion phrase
 * @returns Normalized phrase (uppercase, no separators)
 *
 * @example
 * normalizePhrase('task_done')   // 'TASKDONE'
 * normalizePhrase('TASK-DONE')   // 'TASKDONE'
 * normalizePhrase('Task Done')   // 'TASKDONE'
 */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toUpperCase()
    .replace(/[\s_\-.]+/g, '') // Remove whitespace, underscores, hyphens, dots
    .trim();
}

/**
 * Check if two completion phrases match with fuzzy tolerance.
 *
 * First normalizes both phrases, then checks:
 * 1. Exact match after normalization
 * 2. Edit distance <= maxDistance for typo tolerance
 *
 * @param phrase1 - First phrase to compare
 * @param phrase2 - Second phrase to compare
 * @param maxDistance - Maximum edit distance for fuzzy match (default: 2)
 * @returns True if phrases match (exact or fuzzy)
 *
 * @example
 * fuzzyPhraseMatch('COMPLETE', 'COMPLETE')        // true (exact)
 * fuzzyPhraseMatch('COMPLETE', 'COMPLET')         // true (typo)
 * fuzzyPhraseMatch('TASK_DONE', 'TASKDONE')       // true (separator)
 * fuzzyPhraseMatch('COMPLETE', 'FINISHED')        // false (different word)
 */
export function fuzzyPhraseMatch(phrase1: string, phrase2: string, maxDistance = 2): boolean {
  const norm1 = normalizePhrase(phrase1);
  const norm2 = normalizePhrase(phrase2);

  // Exact match after normalization
  if (norm1 === norm2) return true;

  // For short phrases (< 6 chars), require exact match to avoid false positives
  // e.g., "DONE" shouldn't match "DENY"
  if (norm1.length < 6 || norm2.length < 6) {
    return false;
  }

  // Fuzzy match with edit distance
  return isSimilarByDistance(norm1, norm2, maxDistance);
}

/**
 * Generate a content hash for todo deduplication.
 * Normalizes content and generates a simple hash.
 *
 * @param content - Todo item content
 * @returns Normalized hash string for comparison
 */
export function todoContentHash(content: string): string {
  // Normalize: lowercase, collapse whitespace, remove punctuation
  const normalized = content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();

  // Simple hash using reduce (fast, good enough for deduplication)
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
