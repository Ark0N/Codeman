/**
 * @fileoverview Common/shared type definitions.
 *
 * Base types used across multiple domains. No dependencies on other domain modules.
 *
 * Key exports:
 * - Disposable — interface for objects requiring explicit cleanup (timers, watchers)
 * - BufferConfig — size-limited storage config (terminal: 2MB, text: 1MB)
 * - CleanupRegistration / CleanupResourceType — entries for the centralized CleanupManager
 * - NiceConfig / DEFAULT_NICE_CONFIG — process priority settings for `nice`/`ionice`
 * - ProcessStats — memory/CPU/child-count snapshot for resource monitoring
 * - FilesystemBrowseData — bounded path-picker directory listing returned to the web UI
 */

/**
 * Interface for objects that hold resources requiring explicit cleanup.
 * Implementing classes should release timers, watchers, and other resources in dispose().
 */
export interface Disposable {
  /** Release all held resources. Safe to call multiple times. */
  dispose(): void;
  /** Whether this object has been disposed */
  readonly isDisposed: boolean;
}

/**
 * Configuration for buffer accumulator instances.
 * Used for terminal buffers, text output, and other size-limited string storage.
 */
export interface BufferConfig {
  /** Maximum buffer size in bytes before trimming */
  maxSize: number;
  /** Size to trim to when maxSize is exceeded */
  trimSize: number;
  /** Optional callback invoked when buffer is trimmed */
  onTrim?: (trimmedBytes: number) => void;
}

/**
 * Resource types that can be registered for cleanup.
 */
/**
 * Configuration for process priority using `nice`.
 * Lower priority reduces CPU contention with other processes.
 */
export interface NiceConfig {
  /** Whether nice priority is enabled */
  enabled: boolean;
  /** Nice value (-20 to 19, default: 10 = lower priority) */
  niceValue: number;
}

export const DEFAULT_NICE_CONFIG: NiceConfig = {
  enabled: false,
  niceValue: 10,
};

/**
 * Process resource statistics
 */
export interface ProcessStats {
  /** Memory usage in megabytes */
  memoryMB: number;
  /** CPU usage percentage */
  cpuPercent: number;
  /** Number of child processes */
  childCount: number;
  /** Timestamp of stats collection */
  updatedAt: number;
}

/** A selectable entry returned by the filesystem path-picker API. */
export type FilesystemPreviewKind = 'image' | 'text' | 'document';

export interface FilesystemBrowseEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  /** Last-modified time (ms since epoch) of the entry's target; lets the picker sort by date. */
  mtimeMs?: number;
  symlink?: boolean;
  previewKind?: FilesystemPreviewKind;
}

/** A named root the path picker may browse without escaping its allowlist. */
export interface FilesystemBrowseRoot {
  label: string;
  path: string;
}

/** Response payload for `GET /api/filesystem/browse`. */
export interface FilesystemBrowseData {
  path: string;
  parent: string | null;
  root: string;
  roots: FilesystemBrowseRoot[];
  entries: FilesystemBrowseEntry[];
  truncated: boolean;
}

/** Response payload for `PUT /api/sessions/:id/file-content` (File Viewer edit mode). */
export interface FileWriteData {
  /** Workspace-relative path as submitted */
  path: string;
  /** Size of the written content in bytes */
  size: number;
  /** mtime of the file after the write */
  mtimeMs: number;
  /** sha256 hex of the written bytes — the client's next baseHash */
  hash: string;
  /** Line count of the written content */
  totalLines: number;
  /** Line-ending style that was applied */
  eol: 'lf' | 'crlf';
}

export type CleanupResourceType = 'timer' | 'interval' | 'watcher' | 'listener' | 'stream';

/**
 * Registration entry for a cleanup resource.
 * Used by CleanupManager to track and dispose resources.
 */
export interface CleanupRegistration {
  /** Unique identifier for this registration */
  id: string;
  /** Type of resource */
  type: CleanupResourceType;
  /** Human-readable description for debugging */
  description: string;
  /** Cleanup function to call on dispose */
  cleanup: () => void;
  /** Timestamp when registered */
  registeredAt: number;
}
