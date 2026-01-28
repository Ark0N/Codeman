/**
 * Tests for StaleExpirationMap utility.
 *
 * Port: N/A (unit tests, no server)
 */

import { StaleExpirationMap } from '../../src/utils/stale-expiration-map.js';

describe('StaleExpirationMap', () => {
  describe('basic operations', () => {
    it('should set and get values', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.set('a', 1);
      map.set('b', 2);

      expect(map.get('a')).toBe(1);
      expect(map.get('b')).toBe(2);
      expect(map.get('c')).toBeUndefined();

      map.dispose();
    });

    it('should check has correctly', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.set('a', 1);

      expect(map.has('a')).toBe(true);
      expect(map.has('b')).toBe(false);

      map.dispose();
    });

    it('should delete values', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.set('a', 1);

      expect(map.delete('a')).toBe(true);
      expect(map.delete('a')).toBe(false);
      expect(map.has('a')).toBe(false);

      map.dispose();
    });

    it('should clear all values', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.set('a', 1);
      map.set('b', 2);

      map.clear();

      expect(map.size).toBe(0);
      expect(map.has('a')).toBe(false);

      map.dispose();
    });

    it('should report size correctly', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      expect(map.size).toBe(0);

      map.set('a', 1);
      expect(map.size).toBe(1);

      map.set('b', 2);
      expect(map.size).toBe(2);

      map.dispose();
    });
  });

  describe('expiration', () => {
    it('should expire entries after TTL', async () => {
      const map = new StaleExpirationMap<string, number>({
        ttlMs: 100,
        cleanupIntervalMs: 50,
      });

      map.set('a', 1);
      expect(map.get('a')).toBe(1);

      // Wait for expiration
      await new Promise(r => setTimeout(r, 150));

      expect(map.get('a')).toBeUndefined();
      expect(map.has('a')).toBe(false);

      map.dispose();
    });

    it('should call onExpire callback when entry expires', async () => {
      const expired: Array<[string, number]> = [];
      const map = new StaleExpirationMap<string, number>({
        ttlMs: 100,
        cleanupIntervalMs: 50,
        onExpire: (key, value) => expired.push([key, value]),
      });

      map.set('a', 1);
      map.set('b', 2);

      // Wait for cleanup
      await new Promise(r => setTimeout(r, 200));

      expect(expired).toContainEqual(['a', 1]);
      expect(expired).toContainEqual(['b', 2]);

      map.dispose();
    });

    it('should refresh TTL on get when refreshOnGet is true', async () => {
      const map = new StaleExpirationMap<string, number>({
        ttlMs: 150,
        cleanupIntervalMs: 50,
        refreshOnGet: true,
      });

      map.set('a', 1);

      // Access at 75ms (halfway through TTL)
      await new Promise(r => setTimeout(r, 75));
      expect(map.get('a')).toBe(1);  // This refreshes TTL

      // Wait another 100ms (entry should still be valid because TTL was refreshed)
      await new Promise(r => setTimeout(r, 100));
      expect(map.get('a')).toBe(1);

      map.dispose();
    });

    it('should not refresh TTL on get when refreshOnGet is false', async () => {
      const map = new StaleExpirationMap<string, number>({
        ttlMs: 100,
        cleanupIntervalMs: 50,
        refreshOnGet: false,
      });

      map.set('a', 1);

      // Access at 50ms
      await new Promise(r => setTimeout(r, 50));
      expect(map.get('a')).toBe(1);  // Does NOT refresh TTL

      // Wait another 75ms (entry should be expired)
      await new Promise(r => setTimeout(r, 75));
      expect(map.get('a')).toBeUndefined();

      map.dispose();
    });
  });

  describe('peek and touch', () => {
    it('should peek without refreshing TTL', async () => {
      const map = new StaleExpirationMap<string, number>({
        ttlMs: 100,
        cleanupIntervalMs: 50,
        refreshOnGet: true,
      });

      map.set('a', 1);

      // Peek at 50ms
      await new Promise(r => setTimeout(r, 50));
      expect(map.peek('a')).toBe(1);  // Does NOT refresh TTL

      // Wait another 75ms (entry should be expired)
      await new Promise(r => setTimeout(r, 75));
      expect(map.peek('a')).toBeUndefined();

      map.dispose();
    });

    it('should touch to refresh TTL', async () => {
      const map = new StaleExpirationMap<string, number>({
        ttlMs: 150,
        cleanupIntervalMs: 50,
      });

      map.set('a', 1);

      // Touch at 75ms
      await new Promise(r => setTimeout(r, 75));
      expect(map.touch('a')).toBe(true);

      // Wait another 100ms (entry should still be valid)
      await new Promise(r => setTimeout(r, 100));
      expect(map.has('a')).toBe(true);

      map.dispose();
    });

    it('should return false for touch on non-existent key', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });

      expect(map.touch('nonexistent')).toBe(false);

      map.dispose();
    });
  });

  describe('age and remaining TTL', () => {
    it('should return age of entry', async () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.set('a', 1);

      await new Promise(r => setTimeout(r, 50));

      const age = map.getAge('a');
      expect(age).toBeDefined();
      expect(age!).toBeGreaterThanOrEqual(50);
      expect(age!).toBeLessThan(150);

      map.dispose();
    });

    it('should return undefined age for non-existent key', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });

      expect(map.getAge('nonexistent')).toBeUndefined();

      map.dispose();
    });

    it('should return remaining TTL', async () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 1000 });
      map.set('a', 1);

      await new Promise(r => setTimeout(r, 100));

      const remaining = map.getRemainingTtl('a');
      expect(remaining).toBeDefined();
      // Allow small timing variance (setTimeout isn't exact)
      expect(remaining!).toBeLessThanOrEqual(910);
      expect(remaining!).toBeGreaterThan(800);

      map.dispose();
    });
  });

  describe('iteration', () => {
    it('should iterate over non-expired entries', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);

      const entries = Array.from(map);
      expect(entries).toEqual([['a', 1], ['b', 2], ['c', 3]]);

      map.dispose();
    });

    it('should iterate over keys', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.set('a', 1);
      map.set('b', 2);

      const keys = Array.from(map.keys());
      expect(keys).toEqual(['a', 'b']);

      map.dispose();
    });

    it('should iterate over values', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.set('a', 1);
      map.set('b', 2);

      const values = Array.from(map.values());
      expect(values).toEqual([1, 2]);

      map.dispose();
    });
  });

  describe('manual cleanup', () => {
    it('should remove expired entries on cleanup()', async () => {
      const expired: string[] = [];
      const map = new StaleExpirationMap<string, number>({
        ttlMs: 50,
        cleanupIntervalMs: 10000,  // Long interval so automatic cleanup doesn't run
        onExpire: (key) => expired.push(key),
      });

      map.set('a', 1);
      map.set('b', 2);

      // Wait for expiration
      await new Promise(r => setTimeout(r, 100));

      // Manual cleanup
      const removed = map.cleanup();

      expect(removed).toBe(2);
      expect(expired).toContain('a');
      expect(expired).toContain('b');

      map.dispose();
    });
  });

  describe('dispose', () => {
    it('should stop cleanup timer on dispose', async () => {
      let cleanupCount = 0;
      const originalClearInterval = global.clearInterval;
      let clearedIntervals = 0;
      global.clearInterval = ((id: NodeJS.Timeout) => {
        clearedIntervals++;
        originalClearInterval(id);
      }) as typeof global.clearInterval;

      const map = new StaleExpirationMap<string, number>({
        ttlMs: 100,
        cleanupIntervalMs: 50,
        onExpire: () => cleanupCount++,
      });

      map.dispose();

      // Restore original
      global.clearInterval = originalClearInterval;

      expect(clearedIntervals).toBeGreaterThan(0);
      expect(map.isDisposed).toBe(true);
    });

    it('should be idempotent', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });

      map.dispose();
      map.dispose();
      map.dispose();

      expect(map.isDisposed).toBe(true);
    });

    it('should not allow new entries after dispose', () => {
      const map = new StaleExpirationMap<string, number>({ ttlMs: 10000 });
      map.dispose();

      map.set('a', 1);
      expect(map.size).toBe(0);
    });
  });
});
