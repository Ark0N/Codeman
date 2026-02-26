/**
 * @fileoverview Terminal multiplexer abstraction layer (tmux).
 *
 * Defines the TerminalMultiplexer interface that TmuxManager implements.
 *
 * @module mux-interface
 */

import type { EventEmitter } from 'node:events';
import type { ProcessStats, PersistedRespawnConfig, NiceConfig, ClaudeMode, SessionMode, OpenCodeConfig } from './types.js';

/**
 * Multiplexer session metadata.
 */
export interface MuxSession {
  /** Claudeman session ID */
  sessionId: string;
  /** Multiplexer session name (e.g., "claudeman-abc12345") */
  muxName: string;
  /** Process PID */
  pid: number;
  /** Timestamp when created */
  createdAt: number;
  /** Working directory */
  workingDir: string;
  /** Session mode */
  mode: SessionMode;
  /** Whether webserver is attached to this session */
  attached: boolean;
  /** Session display name (tab name) */
  name?: string;
  /** Persisted respawn controller configuration (restored on server restart) */
  respawnConfig?: PersistedRespawnConfig;
  /** Whether Ralph / Todo tracking is enabled */
  ralphEnabled?: boolean;
}

/**
 * MuxSession with optional process resource statistics.
 */
export interface MuxSessionWithStats extends MuxSession {
  /** Optional resource statistics */
  stats?: ProcessStats;
}

/** Options for creating a new multiplexer session. */
export interface CreateSessionOptions {
  sessionId: string;
  workingDir: string;
  mode: SessionMode;
  name?: string;
  niceConfig?: NiceConfig;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
}

/** Options for respawning a dead pane. */
export interface RespawnPaneOptions {
  sessionId: string;
  workingDir: string;
  mode: SessionMode;
  niceConfig?: NiceConfig;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
}

/**
 * Terminal multiplexer interface.
 *
 * Implemented by TmuxManager.
 *
 * Events emitted:
 * - `sessionCreated` (session: MuxSession) - New session created
 * - `sessionKilled` (data: { sessionId: string }) - Session terminated
 * - `sessionDied` (data: { sessionId: string }) - Session died unexpectedly
 * - `statsUpdated` (sessions: MuxSessionWithStats[]) - Stats refreshed
 */
export interface TerminalMultiplexer extends EventEmitter {
  /** Which backend this instance uses */
  readonly backend: 'tmux';

  // ========== Lifecycle ==========

  /**
   * Create a new multiplexer session.
   * The session runs the appropriate command (claude, opencode, or shell) in detached mode.
   */
  createSession(options: CreateSessionOptions): Promise<MuxSession>;

  /**
   * Kill a session and all its child processes.
   * Uses a multi-strategy approach (children → process group → mux kill → SIGKILL).
   */
  killSession(sessionId: string): Promise<boolean>;

  /** Clean up resources (stop stats collection, etc.) */
  destroy(): void;

  // ========== Queries ==========

  /** Get all tracked sessions */
  getSessions(): MuxSession[];

  /** Get a session by Claudeman session ID */
  getSession(sessionId: string): MuxSession | undefined;

  /** Get all sessions with process resource statistics */
  getSessionsWithStats(): Promise<MuxSessionWithStats[]>;

  /** Get process stats for a single session */
  getProcessStats(sessionId: string): Promise<ProcessStats | null>;

  // ========== Input ==========

  /**
   * Send input to a session via tmux send-keys.
   */
  sendInput(sessionId: string, input: string): Promise<boolean>;

  // ========== Metadata ==========

  /** Update the display name of a session */
  updateSessionName(sessionId: string, name: string): boolean;

  /** Mark session as attached/detached */
  setAttached(sessionId: string, attached: boolean): void;

  /** Register an externally-created session for tracking */
  registerSession(session: MuxSession): void;

  /** Update persisted respawn config for a session */
  updateRespawnConfig(sessionId: string, config: PersistedRespawnConfig | undefined): void;

  /** Clear respawn config when respawn is stopped */
  clearRespawnConfig(sessionId: string): void;

  /** Update Ralph enabled state for a session */
  updateRalphEnabled(sessionId: string, enabled: boolean): void;

  // ========== Discovery ==========

  /**
   * Reconcile tracked sessions with actual running sessions.
   * Finds dead sessions and discovers unknown ones.
   */
  reconcileSessions(): Promise<{ alive: string[]; dead: string[]; discovered: string[] }>;

  // ========== Stats Collection ==========

  /** Start periodic process stats collection */
  startStatsCollection(intervalMs?: number): void;

  /** Stop periodic process stats collection */
  stopStatsCollection(): void;

  // ========== PTY Attachment ==========

  /**
   * Get the command to spawn for attaching to a session ('tmux').
   */
  getAttachCommand(): string;

  /**
   * Get the arguments for attaching to a session by mux name.
   */
  getAttachArgs(muxName: string): string[];

  // ========== Availability ==========

  /** Check if the multiplexer binary is available on the system */
  isAvailable(): boolean;

  /** Check if a multiplexer session actually exists (process-level check, not just tracked) */
  muxSessionExists(muxName: string): boolean;

  /** Check if the pane in a session is dead (command exited but remain-on-exit keeps it alive) */
  isPaneDead(muxName: string): boolean;

  /** Respawn a dead pane with a fresh command. Returns the new PID or null on failure. */
  respawnPane(options: RespawnPaneOptions): Promise<number | null>;
}
