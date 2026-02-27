/**
 * @fileoverview Centralized resource cleanup manager.
 *
 * Tracks timers, intervals, watchers, and other resources that need explicit
 * cleanup. Provides a unified dispose() method that safely cleans up all
 * registered resources, even on partial failures.
 *
 * @module utils/cleanup-manager
 */

import { v4 as uuidv4 } from 'uuid';
import type { Disposable, CleanupRegistration, CleanupResourceType } from '../types.js';

/**
 * Options for setTimeout/setInterval with automatic cleanup.
 */
export interface TimerOptions {
  /** Human-readable description for debugging */
  description?: string;
}

/**
 * Centralized manager for tracking and disposing resources.
 *
 * Implements the Disposable interface for hierarchical cleanup.
 * All registered resources are cleaned up when dispose() is called.
 *
 * Features:
 * - Tracks timers, intervals, watchers, and custom cleanup functions
 * - isStopped guard to prevent callbacks firing after disposal
 * - Safe disposal that continues even if individual cleanups fail
 * - Debug logging for resource tracking
 *
 * @example
 * ```typescript
 * class MyService implements Disposable {
 *   private cleanup = new CleanupManager();
 *
 *   start() {
 *     // Timer automatically cleared on dispose
 *     this.cleanup.setTimeout(() => {
 *       if (this.cleanup.isStopped) return;  // Guard
 *       this.doWork();
 *     }, 5000, { description: 'work timer' });
 *   }
 *
 *   dispose() {
 *     this.cleanup.dispose();
 *   }
 *
 *   get isDisposed() { return this.cleanup.isDisposed; }
 * }
 * ```
 */
export class CleanupManager implements Disposable {
  private registrations = new Map<string, CleanupRegistration>();
  private _isDisposed = false;
  private readonly debugMode: boolean;

  /**
   * Creates a new CleanupManager.
   *
   * @param debug - Enable debug logging for resource tracking
   */
  constructor(debug = false) {
    this.debugMode = debug;
  }

  /**
   * Whether this manager has been disposed.
   * Check this before executing callbacks to prevent zombie operations.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Alias for isDisposed - check before executing async callbacks.
   */
  get isStopped(): boolean {
    return this._isDisposed;
  }

  /**
   * Number of currently registered resources.
   */
  get resourceCount(): number {
    return this.registrations.size;
  }

  /**
   * Get counts by resource type for metrics/debugging.
   */
  get resourceCounts(): Record<CleanupResourceType, number> {
    const counts: Record<CleanupResourceType, number> = {
      timer: 0,
      interval: 0,
      watcher: 0,
      listener: 0,
      stream: 0,
    };

    for (const reg of this.registrations.values()) {
      counts[reg.type]++;
    }

    return counts;
  }

  /**
   * Schedule a timeout that will be automatically cleared on dispose.
   *
   * @param callback - Function to call when timeout fires
   * @param delay - Delay in milliseconds
   * @param options - Optional configuration
   * @returns Timer ID for manual clearing if needed
   */
  setTimeout(callback: () => void, delay: number, options?: TimerOptions): string {
    const id = uuidv4();
    const timeoutId = setTimeout(() => {
      // Remove registration when timer fires naturally
      this.registrations.delete(id);
      // Don't execute if already stopped
      if (this._isDisposed) return;
      callback();
    }, delay);

    this.register({
      id,
      type: 'timer',
      description: options?.description || `setTimeout(${delay}ms)`,
      cleanup: () => clearTimeout(timeoutId),
      registeredAt: Date.now(),
    });

    return id;
  }

  /**
   * Schedule an interval that will be automatically cleared on dispose.
   *
   * @param callback - Function to call on each interval
   * @param delay - Interval in milliseconds
   * @param options - Optional configuration
   * @returns Interval ID for manual clearing if needed
   */
  setInterval(callback: () => void, delay: number, options?: TimerOptions): string {
    const id = uuidv4();
    const intervalId = setInterval(() => {
      // Don't execute if stopped
      if (this._isDisposed) return;
      callback();
    }, delay);

    this.register({
      id,
      type: 'interval',
      description: options?.description || `setInterval(${delay}ms)`,
      cleanup: () => clearInterval(intervalId),
      registeredAt: Date.now(),
    });

    return id;
  }

  /**
   * Register a custom cleanup function.
   *
   * @param type - Type of resource for categorization
   * @param cleanup - Function to call on dispose
   * @param description - Human-readable description
   * @returns Registration ID for manual removal if needed
   */
  registerCleanup(type: CleanupResourceType, cleanup: () => void, description: string): string {
    const id = uuidv4();
    this.register({
      id,
      type,
      description,
      cleanup,
      registeredAt: Date.now(),
    });
    return id;
  }

  /**
   * Register a file system watcher for cleanup.
   *
   * @param watcher - Object with close() method (FSWatcher, chokidar, etc.)
   * @param description - Human-readable description
   * @returns Registration ID
   */
  registerWatcher(watcher: { close: () => void }, description: string): string {
    return this.registerCleanup('watcher', () => watcher.close(), description);
  }

  /**
   * Register an event listener for cleanup.
   *
   * @param emitter - Object with removeListener/off method
   * @param event - Event name
   * @param listener - Listener function
   * @param description - Human-readable description
   * @returns Registration ID
   */
  registerListener<
    T extends {
      removeListener?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    },
  >(emitter: T, event: string, listener: () => void, description: string): string {
    return this.registerCleanup(
      'listener',
      () => {
        if (emitter.removeListener) {
          emitter.removeListener(event, listener);
        } else if (emitter.off) {
          emitter.off(event, listener);
        }
      },
      description
    );
  }

  /**
   * Register a stream for cleanup.
   *
   * @param stream - Object with destroy() or close() method
   * @param description - Human-readable description
   * @returns Registration ID
   */
  registerStream(
    stream: { destroy?: () => void; close?: () => void },
    description: string
  ): string {
    return this.registerCleanup(
      'stream',
      () => {
        if (stream.destroy) {
          stream.destroy();
        } else if (stream.close) {
          stream.close();
        }
      },
      description
    );
  }

  /**
   * Manually remove a registered resource.
   *
   * @param id - Registration ID returned from register methods
   * @returns True if resource was found and removed
   */
  unregister(id: string): boolean {
    const reg = this.registrations.get(id);
    if (!reg) return false;

    try {
      reg.cleanup();
    } catch (err) {
      this.debug(`Error cleaning up ${reg.type} "${reg.description}": ${err}`);
    }

    this.registrations.delete(id);
    return true;
  }

  /**
   * Dispose all registered resources.
   * Safe to call multiple times (idempotent).
   * Continues cleanup even if individual resources fail.
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    const errors: Array<{ description: string; error: unknown }> = [];

    for (const reg of this.registrations.values()) {
      try {
        reg.cleanup();
        this.debug(`Cleaned up ${reg.type}: ${reg.description}`);
      } catch (err) {
        errors.push({ description: reg.description, error: err });
        this.debug(`Error cleaning up ${reg.type} "${reg.description}": ${err}`);
      }
    }

    this.registrations.clear();

    if (errors.length > 0) {
      console.error(
        `[CleanupManager] ${errors.length} errors during disposal:`,
        errors.map((e) => e.description).join(', ')
      );
    }
  }

  /**
   * Get all current registrations for debugging.
   */
  getRegistrations(): CleanupRegistration[] {
    return Array.from(this.registrations.values());
  }

  /**
   * Internal: Register a cleanup entry.
   */
  private register(reg: CleanupRegistration): void {
    this.registrations.set(reg.id, reg);
    this.debug(`Registered ${reg.type}: ${reg.description}`);
  }

  /**
   * Internal: Debug logging.
   */
  private debug(message: string): void {
    if (this.debugMode) {
      console.log(`[CleanupManager] ${message}`);
    }
  }
}
