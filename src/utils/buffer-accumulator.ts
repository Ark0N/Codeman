/**
 * @fileoverview High-performance buffer accumulator for string data.
 *
 * This utility reduces GC pressure by avoiding repeated string concatenation (`+=`).
 * Instead, chunks are pushed to an array and joined only when needed.
 * Automatically trims when size limits are exceeded.
 *
 * @module utils/buffer-accumulator
 */

import type { BufferConfig } from '../types.js';

/**
 * High-performance buffer accumulator using array-based collection.
 *
 * Features:
 * - Efficient append via array push (avoids O(n) string concat)
 * - Lazy join on read (consolidates only when accessed)
 * - Automatic trimming when max size exceeded
 * - Optional callback on trim for logging/metrics
 *
 * @example
 * ```typescript
 * const buffer = new BufferAccumulator({
 *   maxSize: 2 * 1024 * 1024,  // 2MB
 *   trimSize: 1.5 * 1024 * 1024,  // Trim to 1.5MB
 *   onTrim: (bytes) => console.log(`Trimmed ${bytes} bytes`)
 * });
 *
 * buffer.append('chunk1');
 * buffer.append('chunk2');
 * console.log(buffer.value);  // Joins and returns full content
 * ```
 */
export class BufferAccumulator {
  private chunks: string[] = [];
  private totalLength: number = 0;
  private readonly maxSize: number;
  private readonly trimSize: number;
  private readonly onTrim?: (trimmedBytes: number) => void;

  /**
   * Creates a new BufferAccumulator.
   *
   * @param config - Buffer configuration with max/trim sizes
   */
  constructor(config: BufferConfig);
  /**
   * Creates a new BufferAccumulator with simple size parameters.
   *
   * @param maxSize - Maximum buffer size before trimming
   * @param trimSize - Size to trim to when max is exceeded
   */
  constructor(maxSize: number, trimSize: number);
  constructor(configOrMaxSize: BufferConfig | number, trimSize?: number) {
    if (typeof configOrMaxSize === 'number') {
      this.maxSize = configOrMaxSize;
      this.trimSize = trimSize!;
      this.onTrim = undefined;
    } else {
      this.maxSize = configOrMaxSize.maxSize;
      this.trimSize = configOrMaxSize.trimSize;
      this.onTrim = configOrMaxSize.onTrim;
    }
  }

  /**
   * Append data to the buffer.
   * Automatically trims if maxSize is exceeded.
   *
   * @param data - String data to append
   */
  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.totalLength += data.length;

    // Trim if exceeded max size
    if (this.totalLength > this.maxSize) {
      this.trim();
    }
  }

  /**
   * Get the full buffer content.
   * Consolidates chunks on access for efficient subsequent reads.
   */
  get value(): string {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0];

    // Consolidate chunks on access
    const result = this.chunks.join('');
    this.chunks = [result];
    return result;
  }

  /**
   * Get current buffer length without joining chunks.
   */
  get length(): number {
    return this.totalLength;
  }

  /**
   * Check if buffer is empty.
   */
  get isEmpty(): boolean {
    return this.totalLength === 0;
  }

  /**
   * Clear the buffer completely.
   */
  clear(): void {
    this.chunks = [];
    this.totalLength = 0;
  }

  /**
   * Set buffer to a specific value, replacing all content.
   *
   * @param value - New buffer content
   */
  set(value: string): void {
    this.chunks = value ? [value] : [];
    this.totalLength = value?.length || 0;
  }

  /**
   * Get the last N characters from the buffer.
   * Useful for checking recent content without reading the entire buffer.
   *
   * @param n - Number of characters to get from the end
   * @returns The last N characters (or entire buffer if smaller)
   */
  tail(n: number): string {
    if (n >= this.totalLength) {
      return this.value;
    }
    const full = this.value;
    return full.slice(-n);
  }

  /**
   * Check if buffer ends with a specific string.
   *
   * @param suffix - String to check for
   * @returns True if buffer ends with the suffix
   */
  endsWith(suffix: string): boolean {
    if (!suffix) return true;  // All strings end with empty string
    if (suffix.length > this.totalLength) return false;
    return this.tail(suffix.length) === suffix;
  }

  /**
   * Search for a pattern in the buffer (from the end).
   *
   * @param pattern - String or RegExp to search for
   * @param fromEnd - Number of characters from end to search within (default: entire buffer)
   * @returns True if pattern is found
   */
  contains(pattern: string | RegExp, fromEnd?: number): boolean {
    const searchIn = fromEnd ? this.tail(fromEnd) : this.value;
    if (typeof pattern === 'string') {
      return searchIn.includes(pattern);
    }
    return pattern.test(searchIn);
  }

  /**
   * Trim buffer to keep only the most recent data.
   * Called automatically when maxSize is exceeded.
   */
  private trim(): void {
    const full = this.chunks.join('');
    const trimmedBytes = full.length - this.trimSize;
    let trimmed = full.slice(-this.trimSize);
    // Avoid starting mid-ANSI-escape: advance to first newline within 4KB.
    // A partial escape at the buffer start causes xterm.js to misparse
    // subsequent cursor movements, corrupting Ink's redraw rendering.
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 4096) {
      trimmed = trimmed.slice(firstNewline + 1);
    }
    this.chunks = [trimmed];
    this.totalLength = trimmed.length;

    // Notify callback if configured
    if (this.onTrim && trimmedBytes > 0) {
      this.onTrim(trimmedBytes);
    }
  }
}

export default BufferAccumulator;
