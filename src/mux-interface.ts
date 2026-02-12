/**
 * @fileoverview Terminal multiplexer abstraction layer.
 *
 * Defines the TerminalMultiplexer interface that both ScreenManager (GNU Screen)
 * and TmuxManager (tmux) implement. This allows the rest of the codebase to work
 * with either backend transparently.
 *
 * The MuxSession type is the backend-agnostic equivalent of ScreenSession.
 *
 * @module mux-interface
 */

import type { EventEmitter } from 'node:events';
import type { ProcessStats, PersistedRespawnConfig, NiceConfig } from './types.js';

/**
 * Backend-agnostic multiplexer session.
 * Equivalent to ScreenSession but uses `muxName` instead of `screenName`.
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
  /** Session mode: claude or shell */
  mode: 'claude' | 'shell';
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

/**
 * Terminal multiplexer interface.
 *
 * Both ScreenManager and TmuxManager implement this interface,
 * allowing the rest of the codebase to work with either backend.
 *
 * Events emitted:
 * - `sessionCreated` (session: MuxSession) - New session created
 * - `sessionKilled` (data: { sessionId: string }) - Session terminated
 * - `sessionDied` (data: { sessionId: string }) - Session died unexpectedly
 * - `statsUpdated` (sessions: MuxSessionWithStats[]) - Stats refreshed
 */
export interface TerminalMultiplexer extends EventEmitter {
  /** Which backend this instance uses */
  readonly backend: 'tmux' | 'screen';

  // ========== Lifecycle ==========

  /**
   * Create a new multiplexer session.
   * The session runs the appropriate command (claude or shell) in detached mode.
   */
  createSession(
    sessionId: string,
    workingDir: string,
    mode: 'claude' | 'shell',
    name?: string,
    niceConfig?: NiceConfig,
  ): Promise<MuxSession>;

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
   * Send input to a session.
   * tmux: `send-keys -l 'text' Enter` (single command, no delay)
   * screen: `stuff "text"` + 100ms delay + `stuff CR` (with retries)
   */
  sendInput(sessionId: string, input: string): boolean;

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
   * Get the command to spawn for attaching to a session.
   * Returns 'tmux' or 'screen'.
   */
  getAttachCommand(): string;

  /**
   * Get the arguments for attaching to a session by mux name.
   * tmux: ['attach-session', '-t', muxName]
   * screen: ['-x', muxName]
   */
  getAttachArgs(muxName: string): string[];

  // ========== Availability ==========

  /** Check if the multiplexer binary is available on the system */
  isAvailable(): boolean;
}
