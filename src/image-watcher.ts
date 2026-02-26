/**
 * @fileoverview Image Watcher - Detects new image files in session working directories
 *
 * Watches session working directories for new image files (screenshots, generated images)
 * and emits events to trigger automatic popup display in the web UI.
 *
 * Uses chokidar for reliable cross-platform file watching with awaitWriteFinish
 * to ensure files are fully written before emitting detection events.
 */

import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'chokidar';
import { basename, extname, relative } from 'node:path';
import { statSync } from 'node:fs';
import type { ImageDetectedEvent } from './types.js';

// ========== Types ==========

export interface ImageWatcherEvents {
  'image:detected': (event: ImageDetectedEvent) => void;
  'image:error': (error: Error, sessionId?: string) => void;
}

// ========== Constants ==========

/** Supported image file extensions (lowercase) */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
]);

/** Time to wait for file writes to stabilize (ms) */
const STABILITY_THRESHOLD_MS = 500;

/** Poll interval for checking file write stability (ms) */
const POLL_INTERVAL_MS = 100;

/** Debounce delay for rapid image creation (ms) */
const DEBOUNCE_DELAY_MS = 200;

/** Max images emitted per session within the burst window before throttling */
const BURST_LIMIT = 20;

/** Time window for burst detection (ms) — resets after this period of quiet */
const BURST_WINDOW_MS = 10_000;

// ========== ImageWatcher Class ==========

/**
 * Watches session working directories for new image files.
 *
 * Follows the SubagentWatcher pattern: extends EventEmitter, manages
 * file watchers in Maps, emits typed events.
 *
 * @example
 * ```typescript
 * const watcher = new ImageWatcher();
 * watcher.on('image:detected', (event) => {
 *   console.log(`New image in session ${event.sessionId}: ${event.fileName}`);
 * });
 * watcher.watchSession('session-123', '/path/to/working/dir');
 * ```
 */
export class ImageWatcher extends EventEmitter {
  /** Map of sessionId -> FSWatcher for per-session directory watching */
  private sessionWatchers = new Map<string, FSWatcher>();

  /** Map of sessionId -> working directory path */
  private sessionDirs = new Map<string, string>();

  /** Debounce timers for rapid image creation (keyed by filePath) */
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  /** Track which session owns each debounce timer (for cleanup) */
  private timerToSession = new Map<string, string>();

  /** Per-session burst tracking: sessionId -> { count, windowStart } */
  private burstTrackers = new Map<string, { count: number; windowStart: number }>();

  /** Whether the watcher is currently running */
  private _isRunning = false;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // ========== Public API ==========

  /**
   * Check if the watcher is currently running
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Start the image watcher.
   * After calling start(), use watchSession() to add directories to monitor.
   */
  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
  }

  /**
   * Stop the image watcher and clean up all resources.
   */
  stop(): void {
    this._isRunning = false;

    // Close all session watchers
    for (const [sessionId, watcher] of this.sessionWatchers) {
      try {
        watcher.close();
      } catch (error) {
        this.emit('image:error', error instanceof Error ? error : new Error(String(error)), sessionId);
      }
    }
    this.sessionWatchers.clear();
    this.sessionDirs.clear();

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.timerToSession.clear();
    this.burstTrackers.clear();
  }

  /**
   * Start watching a session's working directory for new images.
   *
   * @param sessionId - Codeman session ID
   * @param workingDir - Path to the session's working directory
   */
  watchSession(sessionId: string, workingDir: string): void {
    if (!this._isRunning) {
      this.start();
    }

    // Don't double-watch the same session
    if (this.sessionWatchers.has(sessionId)) {
      // If working directory changed, unwatch old and watch new
      if (this.sessionDirs.get(sessionId) !== workingDir) {
        this.unwatchSession(sessionId);
      } else {
        return;
      }
    }

    this.sessionDirs.set(sessionId, workingDir);

    try {
      // Create chokidar watcher for the directory
      const watcher = watch(workingDir, {
        // Only detect NEW files, not existing ones
        ignoreInitial: true,
        // Wait for file writes to stabilize before emitting
        awaitWriteFinish: {
          stabilityThreshold: STABILITY_THRESHOLD_MS,
          pollInterval: POLL_INTERVAL_MS,
        },
        // Watch all subdirectories (images may be saved in src/, assets/, etc.)
        // Ignore common heavy directories for performance
        ignored: (path: string) => {
          // Skip node_modules, .git, and other heavy directories
          if (path.includes('/node_modules/') || path.includes('/.git/') || path.includes('/dist/') || path.includes('/.next/')) {
            return true;
          }
          const ext = extname(path).toLowerCase();
          // Don't ignore directories (needed for watching to work)
          // Ignore files that aren't images
          return ext !== '' && !IMAGE_EXTENSIONS.has(ext);
        },
      });

      // Handle new file detection
      watcher.on('add', (filePath: string) => {
        this.handleNewFile(sessionId, filePath);
      });

      // Handle watcher errors
      watcher.on('error', (error: Error) => {
        this.emit('image:error', error, sessionId);
      });

      this.sessionWatchers.set(sessionId, watcher);
    } catch (error) {
      this.emit('image:error', error instanceof Error ? error : new Error(String(error)), sessionId);
    }
  }

  /**
   * Stop watching a session's working directory.
   *
   * @param sessionId - Codeman session ID to stop watching
   */
  unwatchSession(sessionId: string): void {
    const watcher = this.sessionWatchers.get(sessionId);
    if (watcher) {
      try {
        watcher.close();
      } catch (error) {
        this.emit('image:error', error instanceof Error ? error : new Error(String(error)), sessionId);
      }
      this.sessionWatchers.delete(sessionId);
    }
    this.sessionDirs.delete(sessionId);

    // Clear any pending debounce timers for this session
    // Collect keys first to avoid iterator invalidation during deletion
    const toDelete: string[] = [];
    for (const [filePath, ownerId] of this.timerToSession) {
      if (ownerId === sessionId) {
        toDelete.push(filePath);
      }
    }
    for (const filePath of toDelete) {
      const timer = this.debounceTimers.get(filePath);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(filePath);
      }
      this.timerToSession.delete(filePath);
    }
    this.burstTrackers.delete(sessionId);
  }

  /**
   * Get list of currently watched session IDs.
   */
  getWatchedSessions(): string[] {
    return Array.from(this.sessionWatchers.keys());
  }

  // ========== Private Methods ==========

  /**
   * Handle a new file being detected.
   * Verifies it's an image and emits the detection event.
   */
  private handleNewFile(sessionId: string, filePath: string): void {
    const ext = extname(filePath).toLowerCase();

    // Double-check it's an image extension
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return;
    }

    // Burst limit: skip if too many images detected for this session in a short window
    const now = Date.now();
    let burst = this.burstTrackers.get(sessionId);
    if (burst) {
      if (now - burst.windowStart > BURST_WINDOW_MS) {
        // Window expired, reset
        burst = { count: 0, windowStart: now };
        this.burstTrackers.set(sessionId, burst);
      }
      if (burst.count >= BURST_LIMIT) {
        return; // Throttled — too many images in this window
      }
    } else {
      burst = { count: 0, windowStart: now };
      this.burstTrackers.set(sessionId, burst);
    }

    // Debounce rapid file creation (e.g., multiple screenshots quickly)
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.timerToSession.delete(filePath);
      this.emitImageDetected(sessionId, filePath);
      // Increment burst count on actual emission (not on detection)
      const b = this.burstTrackers.get(sessionId);
      if (b) b.count++;
    }, DEBOUNCE_DELAY_MS);

    this.debounceTimers.set(filePath, timer);
    this.timerToSession.set(filePath, sessionId);
  }

  /**
   * Emit the image:detected event with file metadata.
   */
  private emitImageDetected(sessionId: string, filePath: string): void {
    try {
      const stat = statSync(filePath);
      const fileName = basename(filePath);
      const workingDir = this.sessionDirs.get(sessionId);
      // Compute relative path from working directory (for file-raw endpoint)
      const relativePath = workingDir ? relative(workingDir, filePath) : fileName;

      const event: ImageDetectedEvent = {
        sessionId,
        filePath,
        relativePath,
        fileName,
        timestamp: Date.now(),
        size: stat.size,
      };

      this.emit('image:detected', event);
    } catch (error) {
      // File may have been deleted between detection and stat
      this.emit('image:error', error instanceof Error ? error : new Error(String(error)), sessionId);
    }
  }
}

// Export singleton instance for convenience
export const imageWatcher = new ImageWatcher();
