/**
 * @fileoverview File Stream Manager - Manages tail -f processes for live log viewing
 *
 * This module spawns and manages `tail -f` processes for streaming live file
 * content to the frontend. It handles:
 * - Spawning tail processes with initial history
 * - Streaming output via callbacks
 * - Cleanup when streams are closed
 * - Security validation (path within working directory)
 *
 * @module file-stream-manager
 */

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

// ========== Configuration Constants ==========

/**
 * Default number of historical lines to show when opening a file.
 */
const DEFAULT_TAIL_LINES = 50;

/**
 * Maximum file size to stream (100MB).
 * Skip files larger than this to prevent memory issues.
 */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Maximum concurrent streams per session.
 */
const MAX_STREAMS_PER_SESSION = 5;

/**
 * Inactivity timeout for streams (5 minutes).
 * Streams with no data for this long will be auto-closed.
 */
const STREAM_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

// ========== Types ==========

/**
 * Represents an active file stream.
 */
export interface FileStream {
  /** Unique stream identifier */
  id: string;
  /** Session this stream belongs to */
  sessionId: string;
  /** Absolute path to the file being streamed */
  filePath: string;
  /** Tail process handle */
  process: ChildProcess;
  /** Timestamp when stream was created */
  createdAt: number;
  /** Timestamp of last data received */
  lastDataAt: number;
  /** Whether the stream is still active */
  active: boolean;
  /** Callback for sending data to client */
  onData: (data: string) => void;
  /** Callback for stream end */
  onEnd: () => void;
  /** Callback for errors */
  onError: (error: string) => void;
}

/**
 * Options for creating a file stream.
 */
export interface CreateStreamOptions {
  /** Session ID requesting the stream */
  sessionId: string;
  /** Path to the file to stream */
  filePath: string;
  /** Working directory for path validation */
  workingDir: string;
  /** Number of historical lines to show (default: 50) */
  lines?: number;
  /** Callback for data */
  onData: (data: string) => void;
  /** Callback for stream end */
  onEnd: () => void;
  /** Callback for errors */
  onError: (error: string) => void;
}

/**
 * Result of creating a stream.
 */
export interface CreateStreamResult {
  success: boolean;
  streamId?: string;
  error?: string;
}

// ========== FileStreamManager Class ==========

/**
 * Manages file streaming via tail -f processes.
 * Ensures security by validating paths and limiting concurrent streams.
 *
 * @example
 * ```typescript
 * const manager = new FileStreamManager();
 *
 * const result = await manager.createStream({
 *   sessionId: 'session-123',
 *   filePath: '/var/log/app.log',
 *   workingDir: '/var/log',
 *   onData: (data) => sseClient.write(data),
 *   onEnd: () => sseClient.close(),
 *   onError: (err) => console.error(err),
 * });
 *
 * // Later, to stop:
 * manager.closeStream(result.streamId);
 * ```
 */
export class FileStreamManager extends EventEmitter {
  private streams: Map<string, FileStream> = new Map();
  private sessionStreamCounts: Map<string, number> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    // Start cleanup timer for inactive streams
    this.cleanupTimer = setInterval(() => this.cleanupInactiveStreams(), 60 * 1000);
  }

  // ========== Public Methods ==========

  /**
   * Create a new file stream.
   *
   * @param options - Stream configuration
   * @returns Result with stream ID on success, error on failure
   */
  async createStream(options: CreateStreamOptions): Promise<CreateStreamResult> {
    const { sessionId, filePath, workingDir, lines = DEFAULT_TAIL_LINES, onData, onEnd, onError } = options;

    // Check concurrent stream limit for this session
    const currentCount = this.sessionStreamCounts.get(sessionId) || 0;
    if (currentCount >= MAX_STREAMS_PER_SESSION) {
      return {
        success: false,
        error: `Maximum ${MAX_STREAMS_PER_SESSION} concurrent streams per session`,
      };
    }

    // Resolve and validate path
    const validationResult = this.validatePath(filePath, workingDir);
    if (!validationResult.valid) {
      return { success: false, error: validationResult.error };
    }

    let absolutePath = validationResult.absolutePath!;

    // Check file exists and size
    try {
      const stats = statSync(absolutePath);
      if (stats.size > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `File too large (${Math.round(stats.size / 1024 / 1024)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB limit)`,
        };
      }
    } catch (err) {
      const errorCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : 'UNKNOWN';
      console.warn(`[FileStreamManager] Failed to stat file "${absolutePath}" (${errorCode}):`, err instanceof Error ? err.message : String(err));
      return { success: false, error: 'File not found or not accessible' };
    }

    // Re-resolve symlinks right before spawn to minimize TOCTOU window.
    // A symlink could have been swapped between validatePath() and here.
    try {
      const resolvedPath = realpathSync(absolutePath);
      if (resolvedPath !== absolutePath) {
        // Symlink target changed — re-validate against allowed paths
        const recheck = this.validatePath(resolvedPath, workingDir);
        if (!recheck.valid) {
          return { success: false, error: recheck.error };
        }
        absolutePath = resolvedPath;
      }
    } catch {
      return { success: false, error: 'File not found or not accessible' };
    }

    // Generate stream ID
    const streamId = `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Spawn tail process
    const tailProcess = spawn('tail', ['-f', '-n', String(lines), absolutePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!tailProcess.pid) {
      return { success: false, error: 'Failed to spawn tail process' };
    }

    const stream: FileStream = {
      id: streamId,
      sessionId,
      filePath: absolutePath,
      process: tailProcess,
      createdAt: Date.now(),
      lastDataAt: Date.now(),
      active: true,
      onData,
      onEnd,
      onError,
    };

    // Handle stdout
    tailProcess.stdout?.on('data', (data: Buffer) => {
      if (stream.active) {
        stream.lastDataAt = Date.now();
        onData(data.toString());
      }
    });

    // Handle stderr
    tailProcess.stderr?.on('data', (data: Buffer) => {
      if (stream.active) {
        onError(data.toString());
      }
    });

    // Handle process exit
    tailProcess.on('exit', (_code) => {
      if (stream.active) {
        stream.active = false;
        onEnd();
        this.removeStream(streamId);
      }
    });

    // Handle errors
    tailProcess.on('error', (err) => {
      if (stream.active) {
        stream.active = false;
        onError(err.message);
        this.removeStream(streamId);
      }
    });

    // Store stream
    this.streams.set(streamId, stream);
    this.sessionStreamCounts.set(sessionId, currentCount + 1);

    return { success: true, streamId };
  }

  /**
   * Close a file stream.
   *
   * @param streamId - ID of the stream to close
   * @returns true if stream was closed, false if not found
   */
  closeStream(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) return false;

    stream.active = false;

    // Remove all event listeners to prevent memory leaks (closures hold references)
    stream.process.stdout?.removeAllListeners();
    stream.process.stderr?.removeAllListeners();
    stream.process.removeAllListeners();

    // Kill the tail process
    try {
      stream.process.kill('SIGTERM');
      // Force kill after 1 second if still running
      const forceKillTimer = setTimeout(() => {
        try {
          stream.process.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }, 1000);
      // Clear the force kill timer if process exits naturally
      stream.process.once('exit', () => {
        clearTimeout(forceKillTimer);
      });
    } catch {
      // Process may have already exited
    }

    stream.onEnd();
    this.removeStream(streamId);

    return true;
  }

  /**
   * Close all streams for a session.
   *
   * @param sessionId - Session ID whose streams to close
   * @returns Number of streams closed
   */
  closeSessionStreams(sessionId: string): number {
    let closed = 0;
    for (const [streamId, stream] of this.streams) {
      if (stream.sessionId === sessionId) {
        this.closeStream(streamId);
        closed++;
      }
    }
    return closed;
  }

  /**
   * Get all active streams for a session.
   *
   * @param sessionId - Session ID to query
   * @returns Array of stream info
   */
  getSessionStreams(sessionId: string): Array<{ id: string; filePath: string; createdAt: number }> {
    const result: Array<{ id: string; filePath: string; createdAt: number }> = [];
    for (const [, stream] of this.streams) {
      if (stream.sessionId === sessionId && stream.active) {
        result.push({
          id: stream.id,
          filePath: stream.filePath,
          createdAt: stream.createdAt,
        });
      }
    }
    return result;
  }

  /**
   * Get count of active streams.
   */
  get activeStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Clean up and destroy the manager.
   */
  destroy(): void {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Close all streams
    for (const streamId of this.streams.keys()) {
      this.closeStream(streamId);
    }

    // Clear Maps to release references
    this.streams.clear();
    this.sessionStreamCounts.clear();
  }

  // ========== Private Methods ==========

  /**
   * Validate that a file path is safe to access.
   * Must be within the working directory (no path traversal).
   */
  private validatePath(
    filePath: string,
    workingDir: string
  ): { valid: boolean; absolutePath?: string; error?: string } {
    // Expand ~ to home directory
    let expandedPath = filePath;
    if (expandedPath.startsWith('~')) {
      expandedPath = expandedPath.replace(/^~/, homedir());
    }

    // Resolve to absolute path
    let absolutePath = isAbsolute(expandedPath)
      ? resolve(expandedPath)
      : resolve(workingDir, expandedPath);

    // Resolve symlinks to prevent symlink attacks — validate the real target,
    // not the symlink itself. Fall back to resolved path if file doesn't exist yet.
    try {
      absolutePath = realpathSync(absolutePath);
    } catch {
      // File may not exist yet (tail -f can wait); keep the resolved path
      // which will be caught by the existsSync check below
    }

    // Normalize the working directory
    const normalizedWorkingDir = resolve(workingDir);

    // Check if the resolved path is within the working directory
    // or common log directories (/tmp intentionally excluded — world-writable)
    const allowedPaths = [
      normalizedWorkingDir,
      '/var/log',
      resolve(homedir(), '.local/share'),
      resolve(homedir(), '.cache'),
      resolve(homedir(), 'logs'),
    ];

    const isAllowed = allowedPaths.some((allowed) => {
      const rel = relative(allowed, absolutePath);
      return rel && !rel.startsWith('..') && !isAbsolute(rel);
    });

    if (!isAllowed) {
      return {
        valid: false,
        error: `Path must be within working directory or allowed log directories`,
      };
    }

    // Note: No need to check for '..' — resolve() already normalizes the path,
    // and realpathSync() resolves symlinks. Both eliminate traversal sequences.

    // Check file exists
    if (!existsSync(absolutePath)) {
      return { valid: false, error: 'File does not exist' };
    }

    return { valid: true, absolutePath };
  }

  /**
   * Remove a stream from tracking.
   */
  private removeStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      // Decrement session count
      const count = this.sessionStreamCounts.get(stream.sessionId) || 0;
      if (count <= 1) {
        this.sessionStreamCounts.delete(stream.sessionId);
      } else {
        this.sessionStreamCounts.set(stream.sessionId, count - 1);
      }
    }
    this.streams.delete(streamId);
  }

  /**
   * Clean up streams that have been inactive for too long.
   */
  private cleanupInactiveStreams(): void {
    const now = Date.now();
    for (const [streamId, stream] of this.streams) {
      if (now - stream.lastDataAt > STREAM_INACTIVITY_TIMEOUT_MS) {
        console.log(`[FileStreamManager] Closing inactive stream: ${streamId}`);
        this.closeStream(streamId);
      }
    }
  }
}

// Export singleton instance
export const fileStreamManager = new FileStreamManager();
