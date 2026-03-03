/**
 * @fileoverview Application state type definitions.
 *
 * Defines the top-level persisted state structure (AppState) which composes
 * types from multiple domains: SessionState (session), TaskState (task),
 * RalphLoopState (ralph), and RespawnConfig (respawn).
 *
 * Key exports:
 * - AppState — root state object (sessions, tasks, ralphLoop, config, globalStats, tokenStats)
 * - AppConfig — app configuration including default RespawnConfig
 * - GlobalStats — cumulative usage stats across all sessions (lifetime)
 * - TokenStats / TokenUsageEntry — daily token usage history
 * - DEFAULT_CONFIG — default AppConfig values
 * - createInitialState() — factory for fresh AppState
 *
 * Persisted to `~/.codeman/state.json` via StateStore (debounced 500ms writes).
 * Served at `GET /api/status` (full state) and `GET /api/config` (config subset).
 *
 * Cross-domain imports: SessionState, TaskState, RalphLoopState, RespawnConfig.
 */

import type { SessionState } from './session.js';
import type { TaskState } from './task.js';
import type { RalphLoopState } from './ralph.js';
import type { RespawnConfig } from './respawn.js';

// ========== Global Stats Types ==========

/**
 * Global statistics across all sessions (including deleted ones).
 * Persisted to track cumulative usage over time.
 */
export interface GlobalStats {
  /** Total input tokens used across all sessions */
  totalInputTokens: number;
  /** Total output tokens used across all sessions */
  totalOutputTokens: number;
  /** Total cost in USD across all sessions */
  totalCost: number;
  /** Total number of sessions created (lifetime) */
  totalSessionsCreated: number;
  /** Timestamp when stats were first recorded */
  firstRecordedAt: number;
  /** Timestamp of last update */
  lastUpdatedAt: number;
}

// ========== Token Usage History Types ==========

/**
 * Daily token usage entry for historical tracking.
 */
export interface TokenUsageEntry {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Input tokens used on this day */
  inputTokens: number;
  /** Output tokens used on this day */
  outputTokens: number;
  /** Estimated cost in USD */
  estimatedCost: number;
  /** Number of sessions that contributed to this day's usage */
  sessions: number;
}

/**
 * Token usage statistics with daily tracking.
 */
export interface TokenStats {
  /** Daily usage entries (most recent first) */
  daily: TokenUsageEntry[];
  /** Timestamp of last update */
  lastUpdated: number;
}

/**
 * Application configuration
 */
export interface AppConfig {
  /** Interval for polling session status (ms) */
  pollIntervalMs: number;
  /** Default timeout for tasks (ms) */
  defaultTimeoutMs: number;
  /** Maximum concurrent sessions allowed */
  maxConcurrentSessions: number;
  /** Path to state file */
  stateFilePath: string;
  /** Respawn controller configuration */
  respawn: RespawnConfig;
  /** Last used case name (for default selection) */
  lastUsedCase: string | null;
  /** Whether Ralph/Todo tracker is globally enabled for all new sessions */
  ralphEnabled: boolean;
}

/**
 * Complete application state
 */
export interface AppState {
  /** Map of session ID to session state */
  sessions: Record<string, SessionState>;
  /** Map of task ID to task state */
  tasks: Record<string, TaskState>;
  /** Ralph Loop controller state */
  ralphLoop: RalphLoopState;
  /** Application configuration */
  config: AppConfig;
  /** Global statistics (cumulative across all sessions) */
  globalStats?: GlobalStats;
  /** Daily token usage statistics */
  tokenStats?: TokenStats;
}

// ========== Default Configuration ==========

/**
 * Default application configuration values
 */
export const DEFAULT_CONFIG: AppConfig = {
  pollIntervalMs: 1000,
  defaultTimeoutMs: 300000, // 5 minutes
  maxConcurrentSessions: 5,
  stateFilePath: '',
  respawn: {
    idleTimeoutMs: 5000, // 5 seconds of no activity after prompt
    updatePrompt: 'update all the docs and CLAUDE.md',
    interStepDelayMs: 1000, // 1 second between steps
    enabled: false, // disabled by default
    sendClear: true, // send /clear after update prompt
    sendInit: true, // send /init after /clear
  },
  lastUsedCase: null,
  ralphEnabled: false,
};

/**
 * Creates initial application state
 * @returns Fresh application state with defaults
 */
export function createInitialState(): AppState {
  return {
    sessions: {},
    tasks: {},
    ralphLoop: {
      status: 'stopped',
      startedAt: null,
      minDurationMs: null,
      tasksCompleted: 0,
      tasksGenerated: 0,
      lastCheckAt: null,
    },
    config: { ...DEFAULT_CONFIG },
    globalStats: createInitialGlobalStats(),
  };
}

/**
 * Creates initial global stats object
 * @returns Fresh global stats with zero values
 */
export function createInitialGlobalStats(): GlobalStats {
  const now = Date.now();
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    totalSessionsCreated: 0,
    firstRecordedAt: now,
    lastUpdatedAt: now,
  };
}
