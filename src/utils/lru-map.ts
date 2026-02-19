/**
 * @fileoverview LRU (Least Recently Used) Map implementation.
 *
 * Extends the built-in Map with automatic eviction when a maximum size is
 * exceeded. Uses Map's insertion-order iteration for O(1) LRU eviction.
 *
 * @module utils/lru-map
 */

/**
 * Configuration options for LRUMap.
 */
export interface LRUMapOptions<K, V> {
  /** Maximum number of entries before eviction */
  maxSize: number;
  /** Optional callback when an entry is evicted */
  onEvict?: (key: K, value: V) => void;
}

/**
 * A Map with automatic LRU (Least Recently Used) eviction.
 *
 * When the map exceeds maxSize, the oldest entries are evicted.
 * Access via get() refreshes an entry's position (moves to most recent).
 *
 * Uses JavaScript Map's insertion-order guarantee for efficient LRU behavior.
 * All operations are O(1) amortized.
 *
 * @example
 * ```typescript
 * const cache = new LRUMap<string, number>({
 *   maxSize: 100,
 *   onEvict: (key, value) => console.log(`Evicted ${key}`)
 * });
 *
 * cache.set('a', 1);
 * cache.set('b', 2);
 * cache.get('a');  // Refreshes 'a', making 'b' the oldest
 * // When full, 'b' would be evicted first
 * ```
 */
export class LRUMap<K, V> extends Map<K, V> {
  private readonly maxSize: number;
  private readonly onEvict?: (key: K, value: V) => void;
  /** Tracks the newest key for O(1) newest() access */
  private _newestKey: K | undefined = undefined;

  /**
   * Creates a new LRUMap.
   *
   * @param options - Configuration options
   */
  constructor(options: LRUMapOptions<K, V>) {
    super();
    this.maxSize = options.maxSize;
    this.onEvict = options.onEvict;
  }

  /**
   * Set a key-value pair.
   * If key exists, updates value and refreshes position.
   * If adding new entry would exceed maxSize, evicts oldest entries.
   *
   * @param key - Key to set
   * @param value - Value to associate
   * @returns this (for chaining)
   */
  override set(key: K, value: V): this {
    // If key exists, delete first to refresh position
    if (super.has(key)) {
      super.delete(key);
    }

    // Add the entry (will be at end = most recent)
    super.set(key, value);
    // Track newest key for O(1) newest() access
    this._newestKey = key;

    // Evict oldest entries if over capacity
    while (super.size > this.maxSize) {
      const oldestKey = super.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestValue = super.get(oldestKey)!;
        super.delete(oldestKey);
        this.onEvict?.(oldestKey, oldestValue);
      }
    }

    return this;
  }

  /**
   * Get a value and refresh its position (mark as most recently used).
   *
   * @param key - Key to look up
   * @returns Value if found, undefined otherwise
   */
  override get(key: K): V | undefined {
    if (!super.has(key)) {
      return undefined;
    }

    // Delete and re-insert to move to end (most recent)
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    // Track newest key for O(1) newest() access
    this._newestKey = key;
    return value;
  }

  /**
   * Check if a key exists WITHOUT refreshing its position.
   * Use this when you want to check existence without affecting LRU order.
   *
   * @param key - Key to check
   * @returns True if key exists
   */
  override has(key: K): boolean {
    return super.has(key);
  }

  /**
   * Delete a key-value pair.
   * Updates _newestKey if the deleted key was the newest.
   *
   * @param key - Key to delete
   * @returns True if the key existed and was deleted
   */
  override delete(key: K): boolean {
    const existed = super.delete(key);
    // If we deleted the newest key, we need to find the new newest
    // This is O(n) but delete is rare; set/get are the hot paths
    if (existed && this._newestKey === key) {
      this._newestKey = undefined;
      // Find the new newest by iterating (last entry)
      for (const k of super.keys()) {
        this._newestKey = k;
      }
    }
    return existed;
  }

  /**
   * Clear all entries.
   * Resets _newestKey to undefined.
   */
  override clear(): void {
    super.clear();
    this._newestKey = undefined;
  }

  /**
   * Peek at a value WITHOUT refreshing its position.
   * Use this when you want to read without affecting LRU order.
   *
   * @param key - Key to peek
   * @returns Value if found, undefined otherwise
   */
  peek(key: K): V | undefined {
    return super.get(key);
  }

  /**
   * Get the oldest entry (next to be evicted) without removing it.
   *
   * @returns [key, value] of oldest entry, or undefined if empty
   */
  oldest(): [K, V] | undefined {
    const first = super.entries().next();
    if (first.done) return undefined;
    return first.value;
  }

  /**
   * Get the newest entry (most recently accessed).
   * O(1) operation using tracked newest key.
   *
   * @returns [key, value] of newest entry, or undefined if empty
   */
  newest(): [K, V] | undefined {
    if (this._newestKey === undefined || !super.has(this._newestKey)) {
      return undefined;
    }
    // Use super.get to avoid refreshing the position
    const value = super.get(this._newestKey)!;
    return [this._newestKey, value];
  }

  /**
   * Evict entries older than a specific timestamp.
   * Assumes values have a timestamp property or are numbers representing time.
   *
   * @param maxAge - Maximum age in milliseconds
   * @param getTimestamp - Function to extract timestamp from value
   * @returns Number of entries evicted
   */
  expireOlderThan(maxAge: number, getTimestamp: (value: V) => number): number {
    const now = Date.now();
    const cutoff = now - maxAge;
    let evicted = 0;
    let deletedNewest = false;

    // Iterate from oldest to newest
    for (const [key, value] of super.entries()) {
      if (getTimestamp(value) < cutoff) {
        // Track if we're deleting the newest key
        if (key === this._newestKey) {
          deletedNewest = true;
        }
        super.delete(key);
        this.onEvict?.(key, value);
        evicted++;
      } else {
        // Since entries are ordered, once we find a non-expired one,
        // all subsequent entries are also non-expired
        break;
      }
    }

    // Update _newestKey if we deleted it (find new newest from remaining entries)
    if (deletedNewest) {
      this._newestKey = undefined;
      for (const k of super.keys()) {
        this._newestKey = k; // Last one becomes newest
      }
    }

    return evicted;
  }

  /**
   * Get all keys in order from oldest to newest.
   *
   * @returns Array of keys
   */
  keysInOrder(): K[] {
    return Array.from(super.keys());
  }

  /**
   * Get all values in order from oldest to newest.
   *
   * @returns Array of values
   */
  valuesInOrder(): V[] {
    return Array.from(super.values());
  }

  /**
   * Get the maximum size limit.
   */
  get maxEntries(): number {
    return this.maxSize;
  }

  /**
   * Get the number of free slots before eviction would occur.
   */
  get freeSlots(): number {
    return Math.max(0, this.maxSize - super.size);
  }
}
