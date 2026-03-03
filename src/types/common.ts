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
