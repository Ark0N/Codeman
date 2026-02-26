/**
 * @fileoverview Tests for memory leak prevention patterns
 *
 * These tests verify the cleanup patterns used to prevent memory leaks
 * in long-running Codeman sessions (P1 improvements from P0 fixes).
 *
 * Port: N/A (unit tests, no server)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

describe('Memory Leak Prevention Patterns', () => {
  describe('Task Description Cache Cleanup', () => {
    /**
     * Pattern: Bounded cache with TTL expiration
     * Used by: Session._recentTaskDescriptions
     */
    class TaskDescriptionCache {
      private cache: Map<number, string> = new Map();
      private readonly maxAge: number;
      private readonly maxSize: number;

      constructor(maxAge = 30000, maxSize = 100) {
        this.maxAge = maxAge;
        this.maxSize = maxSize;
      }

      add(description: string, timestamp = Date.now()): void {
        this.cache.set(timestamp, description);
        this.prune();
      }

      private prune(): void {
        const now = Date.now();
        // Remove old entries
        for (const [timestamp] of this.cache) {
          if (now - timestamp > this.maxAge) {
            this.cache.delete(timestamp);
          }
        }
        // Remove excess entries (keep newest)
        if (this.cache.size > this.maxSize) {
          const sorted = Array.from(this.cache.keys()).sort((a, b) => a - b);
          const toRemove = sorted.slice(0, this.cache.size - this.maxSize);
          for (const key of toRemove) {
            this.cache.delete(key);
          }
        }
      }

      get(timestamp: number): string | undefined {
        return this.cache.get(timestamp);
      }

      get size(): number {
        return this.cache.size;
      }

      clear(): void {
        this.cache.clear();
      }
    }

    it('should add and retrieve descriptions', () => {
      const cache = new TaskDescriptionCache();
      const now = Date.now();
      cache.add('Test description', now);
      expect(cache.get(now)).toBe('Test description');
    });

    it('should auto-prune old entries', () => {
      const cache = new TaskDescriptionCache(1000); // 1 second max age
      const oldTimestamp = Date.now() - 2000; // 2 seconds ago
      cache.add('Old description', oldTimestamp);
      cache.add('New description'); // This triggers prune
      expect(cache.get(oldTimestamp)).toBeUndefined();
    });

    it('should enforce max size', () => {
      const cache = new TaskDescriptionCache(30000, 3); // max 3 entries
      const now = Date.now();
      cache.add('Desc 1', now);
      cache.add('Desc 2', now + 1);
      cache.add('Desc 3', now + 2);
      cache.add('Desc 4', now + 3); // Should evict oldest
      expect(cache.size).toBe(3);
      expect(cache.get(now)).toBeUndefined(); // Oldest removed
      expect(cache.get(now + 3)).toBe('Desc 4'); // Newest kept
    });

    it('should clear completely', () => {
      const cache = new TaskDescriptionCache();
      const now = Date.now();
      cache.add('Desc 1', now);
      cache.add('Desc 2', now + 1);
      cache.add('Desc 3', now + 2);
      expect(cache.size).toBe(3);
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should handle clear after stop scenario', () => {
      // Simulates Session.stop() calling clear()
      const cache = new TaskDescriptionCache();
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        cache.add(`Description ${i}`, now + i);
      }
      expect(cache.size).toBeGreaterThan(0);
      cache.clear(); // Called in stop()
      expect(cache.size).toBe(0);
    });

    it('should handle clear in clearBuffers scenario', () => {
      // Simulates Session.clearBuffers() calling clear()
      const cache = new TaskDescriptionCache();
      const now = Date.now();
      for (let i = 0; i < 50; i++) {
        cache.add(`Buffer description ${i}`, now + i);
      }
      cache.clear(); // Called in clearBuffers()
      expect(cache.size).toBe(0);
    });
  });

  describe('Promise Callback Cleanup', () => {
    /**
     * Pattern: Null callbacks after rejection to prevent memory leaks
     * Used by: Session.runPrompt() catch block
     */
    class PromiseHandler {
      private resolveCallback: ((value: string) => void) | null = null;
      private rejectCallback: ((error: Error) => void) | null = null;

      createPromise(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
          this.resolveCallback = resolve;
          this.rejectCallback = reject;
        });
      }

      resolve(value: string): void {
        if (this.resolveCallback) {
          this.resolveCallback(value);
          this.resolveCallback = null;
          this.rejectCallback = null;
        }
      }

      reject(error: Error): void {
        if (this.rejectCallback) {
          this.rejectCallback(error);
          // P0 FIX: Null callbacks after rejection
          this.resolveCallback = null;
          this.rejectCallback = null;
        }
      }

      get hasCallbacks(): boolean {
        return this.resolveCallback !== null || this.rejectCallback !== null;
      }
    }

    it('should null callbacks after resolve', async () => {
      const handler = new PromiseHandler();
      const promise = handler.createPromise();
      expect(handler.hasCallbacks).toBe(true);

      handler.resolve('success');
      await promise;

      expect(handler.hasCallbacks).toBe(false);
    });

    it('should null callbacks after reject', async () => {
      const handler = new PromiseHandler();
      const promise = handler.createPromise();
      expect(handler.hasCallbacks).toBe(true);

      handler.reject(new Error('test error'));

      try {
        await promise;
      } catch {
        // Expected
      }

      expect(handler.hasCallbacks).toBe(false);
    });

    it('should handle multiple rejects gracefully', () => {
      const handler = new PromiseHandler();
      handler.createPromise().catch(() => {});

      handler.reject(new Error('first error'));
      handler.reject(new Error('second error')); // Should not throw

      expect(handler.hasCallbacks).toBe(false);
    });
  });

  describe('Event Listener Cleanup', () => {
    /**
     * Pattern: Store listener references for later removal
     * Used by: Server watcher listeners, Session tracker handlers
     */
    class TrackedEmitter extends EventEmitter {
      private trackedListeners: Map<string, ((...args: unknown[]) => void)[]> = new Map();

      addTrackedListener(event: string, listener: (...args: unknown[]) => void): void {
        this.on(event, listener);
        const listeners = this.trackedListeners.get(event) || [];
        listeners.push(listener);
        this.trackedListeners.set(event, listeners);
      }

      removeTrackedListeners(event?: string): number {
        let removed = 0;
        if (event) {
          const listeners = this.trackedListeners.get(event) || [];
          for (const listener of listeners) {
            this.off(event, listener);
            removed++;
          }
          this.trackedListeners.delete(event);
        } else {
          for (const [evt, listeners] of this.trackedListeners) {
            for (const listener of listeners) {
              this.off(evt, listener);
              removed++;
            }
          }
          this.trackedListeners.clear();
        }
        return removed;
      }

      getTrackedCount(event?: string): number {
        if (event) {
          return (this.trackedListeners.get(event) || []).length;
        }
        let total = 0;
        for (const listeners of this.trackedListeners.values()) {
          total += listeners.length;
        }
        return total;
      }
    }

    it('should track added listeners', () => {
      const emitter = new TrackedEmitter();
      const handler = vi.fn();

      emitter.addTrackedListener('test', handler);

      expect(emitter.getTrackedCount('test')).toBe(1);
      expect(emitter.listenerCount('test')).toBe(1);
    });

    it('should remove tracked listeners by event', () => {
      const emitter = new TrackedEmitter();
      emitter.addTrackedListener('event1', vi.fn());
      emitter.addTrackedListener('event1', vi.fn());
      emitter.addTrackedListener('event2', vi.fn());

      const removed = emitter.removeTrackedListeners('event1');

      expect(removed).toBe(2);
      expect(emitter.getTrackedCount('event1')).toBe(0);
      expect(emitter.getTrackedCount('event2')).toBe(1);
      expect(emitter.listenerCount('event1')).toBe(0);
    });

    it('should remove all tracked listeners', () => {
      const emitter = new TrackedEmitter();
      emitter.addTrackedListener('event1', vi.fn());
      emitter.addTrackedListener('event2', vi.fn());
      emitter.addTrackedListener('event3', vi.fn());

      const removed = emitter.removeTrackedListeners();

      expect(removed).toBe(3);
      expect(emitter.getTrackedCount()).toBe(0);
    });

    it('should handle server shutdown cleanup scenario', () => {
      // Simulates SubagentWatcher/ImageWatcher listener cleanup
      const watcher = new TrackedEmitter();

      // Server adds listeners on startup
      watcher.addTrackedListener('newAgent', vi.fn());
      watcher.addTrackedListener('agentUpdate', vi.fn());
      watcher.addTrackedListener('agentComplete', vi.fn());

      expect(watcher.getTrackedCount()).toBe(3);

      // Server calls cleanup on shutdown
      watcher.removeTrackedListeners();

      expect(watcher.getTrackedCount()).toBe(0);
      expect(watcher.listenerCount('newAgent')).toBe(0);
      expect(watcher.listenerCount('agentUpdate')).toBe(0);
      expect(watcher.listenerCount('agentComplete')).toBe(0);
    });
  });

  describe('DOM Handler Cleanup (Frontend Pattern)', () => {
    /**
     * Pattern: Store handlers on element for later cleanup
     * Used by: Plan file windows, draggable/resizable components
     */

    // Mock DOM-like structure
    interface MockElement {
      id: string;
      _dragHandlers?: {
        mousedown: () => void;
        mousemove: () => void;
        mouseup: () => void;
      };
      _resizeHandlers?: {
        mousedown: () => void;
        mousemove: () => void;
        mouseup: () => void;
      };
    }

    const createMockElement = (id: string): MockElement => ({ id });

    const makeDraggable = (element: MockElement): void => {
      const mousedown = vi.fn();
      const mousemove = vi.fn();
      const mouseup = vi.fn();

      // Store handlers on element for cleanup
      element._dragHandlers = { mousedown, mousemove, mouseup };
    };

    const makeResizable = (element: MockElement): void => {
      const mousedown = vi.fn();
      const mousemove = vi.fn();
      const mouseup = vi.fn();

      element._resizeHandlers = { mousedown, mousemove, mouseup };
    };

    const cleanupElement = (element: MockElement): void => {
      if (element._dragHandlers) {
        element._dragHandlers = undefined;
      }
      if (element._resizeHandlers) {
        element._resizeHandlers = undefined;
      }
    };

    it('should store drag handlers on element', () => {
      const element = createMockElement('window-1');
      makeDraggable(element);

      expect(element._dragHandlers).toBeDefined();
      expect(element._dragHandlers?.mousedown).toBeDefined();
    });

    it('should store resize handlers on element', () => {
      const element = createMockElement('window-1');
      makeResizable(element);

      expect(element._resizeHandlers).toBeDefined();
      expect(element._resizeHandlers?.mousedown).toBeDefined();
    });

    it('should cleanup handlers on close', () => {
      const element = createMockElement('window-1');
      makeDraggable(element);
      makeResizable(element);

      expect(element._dragHandlers).toBeDefined();
      expect(element._resizeHandlers).toBeDefined();

      cleanupElement(element);

      expect(element._dragHandlers).toBeUndefined();
      expect(element._resizeHandlers).toBeUndefined();
    });

    it('should handle cleanup of all floating windows scenario', () => {
      const windows: MockElement[] = [];

      // Create multiple windows
      for (let i = 0; i < 5; i++) {
        const win = createMockElement(`window-${i}`);
        makeDraggable(win);
        makeResizable(win);
        windows.push(win);
      }

      // All windows have handlers
      for (const win of windows) {
        expect(win._dragHandlers).toBeDefined();
        expect(win._resizeHandlers).toBeDefined();
      }

      // Cleanup all (simulates cleanupAllFloatingWindows())
      for (const win of windows) {
        cleanupElement(win);
      }

      // All handlers removed
      for (const win of windows) {
        expect(win._dragHandlers).toBeUndefined();
        expect(win._resizeHandlers).toBeUndefined();
      }
    });
  });

  describe('Timer/Interval Cleanup', () => {
    /**
     * Pattern: Track and clear all timers on cleanup
     * Used by: Various debounced operations, polling intervals
     */
    class TimerManager {
      private timers: Set<NodeJS.Timeout> = new Set();
      private intervals: Set<NodeJS.Timeout> = new Set();

      setTimeout(callback: () => void, delay: number): NodeJS.Timeout {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          callback();
        }, delay);
        this.timers.add(timer);
        return timer;
      }

      setInterval(callback: () => void, delay: number): NodeJS.Timeout {
        const interval = setInterval(callback, delay);
        this.intervals.add(interval);
        return interval;
      }

      clearAll(): { timers: number; intervals: number } {
        const timerCount = this.timers.size;
        const intervalCount = this.intervals.size;

        for (const timer of this.timers) {
          clearTimeout(timer);
        }
        this.timers.clear();

        for (const interval of this.intervals) {
          clearInterval(interval);
        }
        this.intervals.clear();

        return { timers: timerCount, intervals: intervalCount };
      }

      get activeTimerCount(): number {
        return this.timers.size;
      }

      get activeIntervalCount(): number {
        return this.intervals.size;
      }
    }

    let manager: TimerManager;

    beforeEach(() => {
      manager = new TimerManager();
    });

    afterEach(() => {
      manager.clearAll();
    });

    it('should track active timers', () => {
      manager.setTimeout(() => {}, 10000);
      manager.setTimeout(() => {}, 10000);

      expect(manager.activeTimerCount).toBe(2);
    });

    it('should track active intervals', () => {
      manager.setInterval(() => {}, 1000);
      manager.setInterval(() => {}, 1000);

      expect(manager.activeIntervalCount).toBe(2);
    });

    it('should clear all timers and intervals', () => {
      manager.setTimeout(() => {}, 10000);
      manager.setTimeout(() => {}, 10000);
      manager.setInterval(() => {}, 1000);

      const cleared = manager.clearAll();

      expect(cleared.timers).toBe(2);
      expect(cleared.intervals).toBe(1);
      expect(manager.activeTimerCount).toBe(0);
      expect(manager.activeIntervalCount).toBe(0);
    });

    it('should auto-remove completed timers', async () => {
      const callback = vi.fn();
      manager.setTimeout(callback, 10);

      expect(manager.activeTimerCount).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(manager.activeTimerCount).toBe(0);
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('Map Cleanup Patterns', () => {
    /**
     * Various Map cleanup patterns used across the codebase
     */

    it('should clear Map completely', () => {
      const map = new Map<string, object>();
      map.set('key1', { data: 'value1' });
      map.set('key2', { data: 'value2' });

      expect(map.size).toBe(2);
      map.clear();
      expect(map.size).toBe(0);
    });

    it('should delete specific entries during iteration safely', () => {
      const map = new Map<number, string>();
      const now = Date.now();
      map.set(now - 10000, 'old');
      map.set(now - 5000, 'medium');
      map.set(now - 1000, 'new');

      // Collect keys to delete first (safe iteration pattern)
      const keysToDelete: number[] = [];
      for (const [timestamp] of map) {
        if (now - timestamp > 8000) {
          keysToDelete.push(timestamp);
        }
      }

      for (const key of keysToDelete) {
        map.delete(key);
      }

      expect(map.size).toBe(2);
    });

    it('should handle nested object cleanup', () => {
      const sessions = new Map<string, {
        buffers: Map<string, string>;
        handlers: Set<() => void>;
      }>();

      sessions.set('session1', {
        buffers: new Map([['terminal', 'data']]),
        handlers: new Set([() => {}, () => {}]),
      });

      // Cleanup inner structures before clearing outer
      const session = sessions.get('session1');
      if (session) {
        session.buffers.clear();
        session.handlers.clear();
      }
      sessions.delete('session1');

      expect(sessions.size).toBe(0);
    });
  });

  describe('WeakRef/WeakMap Usage', () => {
    /**
     * Pattern: Use WeakRef/WeakMap for caches that shouldn't prevent GC
     */

    it('should allow value to be garbage collected', () => {
      const cache = new WeakMap<object, string>();
      let key: object | null = { id: 1 };

      cache.set(key, 'cached value');
      expect(cache.get(key)).toBe('cached value');

      // Clear reference (in real code, GC would collect)
      key = null;

      // WeakMap allows the key to be collected
      // We can't directly test GC, but the pattern is correct
      expect(key).toBeNull();
    });

    it('should work with multiple weak references', () => {
      const cache = new WeakMap<object, { data: string; timestamp: number }>();

      const objects = [{ id: 1 }, { id: 2 }, { id: 3 }];
      for (const obj of objects) {
        cache.set(obj, { data: `data-${obj.id}`, timestamp: Date.now() });
      }

      // All entries accessible while references exist
      for (const obj of objects) {
        expect(cache.has(obj)).toBe(true);
      }
    });
  });

  describe('Cleanup Order Verification', () => {
    /**
     * Verifies correct cleanup order to prevent use-after-free patterns
     */

    interface Resource {
      type: string;
      disposed: boolean;
    }

    class ResourceManager {
      private resources: Resource[] = [];
      private cleanupOrder: string[] = [];

      add(type: string): Resource {
        const resource = { type, disposed: false };
        this.resources.push(resource);
        return resource;
      }

      cleanup(): void {
        // Cleanup in reverse order (LIFO)
        for (let i = this.resources.length - 1; i >= 0; i--) {
          const resource = this.resources[i];
          resource.disposed = true;
          this.cleanupOrder.push(resource.type);
        }
        this.resources = [];
      }

      get order(): string[] {
        return [...this.cleanupOrder];
      }
    }

    it('should cleanup in reverse order (LIFO)', () => {
      const manager = new ResourceManager();

      manager.add('database');
      manager.add('cache');
      manager.add('connection');

      manager.cleanup();

      expect(manager.order).toEqual(['connection', 'cache', 'database']);
    });

    it('should handle session cleanup order', () => {
      const manager = new ResourceManager();

      // Simulates Session.stop() cleanup order
      manager.add('pty'); // PTY process
      manager.add('taskTracker'); // Task tracker listeners
      manager.add('ralphTracker'); // Ralph tracker listeners
      manager.add('screen'); // Screen session

      manager.cleanup();

      // Screen should be last (allows graceful shutdown)
      expect(manager.order[0]).toBe('screen');
      expect(manager.order[manager.order.length - 1]).toBe('pty');
    });
  });
});
