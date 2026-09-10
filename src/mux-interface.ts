/**
 * @fileoverview Terminal multiplexer abstraction layer (tmux).
 *
 * Defines the TerminalMultiplexer interface that TmuxManager implements.
 *
 * @module mux-interface
 */

import type { EventEmitter } from 'node:events';
import type {
  ProcessStats,
  PersistedRespawnConfig,
  NiceConfig,
  ClaudeMode,
  SessionMode,
  OpenCodeConfig,
  CodexConfig,
  EffortLevel,
  GeminiConfig,
  AntigravityConfig,
  PiConfig,
  GrokConfig,
  DeepSeekConfig,
  OmpConfig,
  SessionRemote,
  SessionDocker,
} from './types.js';

/**
 * Multiplexer session metadata.
 */
export interface MuxSession {
  /** Codeman session ID */
  sessionId: string;
  /** Multiplexer session name (e.g., "codeman-abc12345") */
  muxName: string;
  /** Process PID */
  pid: number;
  /** Timestamp when created */
  createdAt: number;
  /** Working directory */
  workingDir: string;
  /** Remote execution metadata for local tmux sessions wrapping SSH */
  remote?: SessionRemote;
  /** Docker execution metadata for local tmux sessions wrapping `docker exec` */
  docker?: SessionDocker;
  /** Owning username in multi-user mode (round-tripped through recovery like remote/docker) */
  owner?: string;
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
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  piConfig?: PiConfig;
  grokConfig?: GrokConfig;
  deepSeekConfig?: DeepSeekConfig;
  ompConfig?: OmpConfig;
  /** When restoring after reboot, resume a previous Claude conversation by its session ID */
  resumeSessionId?: string;
  /** Extra env vars exported before launching the CLI (e.g., CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS). Ephemeral — not written to disk. */
  envOverrides?: Record<string, string>;
  /** Claude CLI effort level, injected as a `--settings` soft default (overridable via /effort in-session) */
  effort?: EffortLevel;
  /** tmux history-limit (scrollback lines) allocated when this session is created. */
  historyLimit?: number;
  /** Remote execution metadata for local tmux sessions wrapping SSH */
  remote?: SessionRemote;
  /** Docker execution metadata for local tmux sessions wrapping `docker exec` */
  docker?: SessionDocker;
  /** Owning username in multi-user mode; persisted for recovery. */
  owner?: string;
}

/** Options for respawning a dead pane. */
export interface RespawnPaneOptions {
  sessionId: string;
  workingDir: string;
  mode: SessionMode;
  /** Session display name; a respawned claude keeps its `--name` peer name (version-gated, local only). */
  name?: string;
  niceConfig?: NiceConfig;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  piConfig?: PiConfig;
  grokConfig?: GrokConfig;
  deepSeekConfig?: DeepSeekConfig;
  ompConfig?: OmpConfig;
  /** Resume a previous Claude conversation when respawning */
  resumeSessionId?: string;
  /** Extra env vars exported before launching the CLI (preserved across respawns). */
  envOverrides?: Record<string, string>;
  /** Claude CLI effort level (preserved across respawns, injected via `--settings`) */
  effort?: EffortLevel;
  /** Original tmux history-limit retained for config parity; respawn cannot resize the existing pane. */
  historyLimit?: number;
  /** Remote execution metadata for local tmux sessions wrapping SSH */
  remote?: SessionRemote;
  /** Docker execution metadata for local tmux sessions wrapping `docker exec` */
  docker?: SessionDocker;
  /** Owning username (multi-user); redundant on respawn since the Session object survives, kept for shape parity. */
  owner?: string;
}

/** Options for pane buffer capture (COD-47 full-history mode). */
export interface PaneCaptureOptions {
  /**
   * Capture the entire scrollback instead of just the visible frame, as linear
   * text ending with a cursor move back to the pane's caret position. An
   * implementation returns '' when the pane holds nothing visible, which the
   * caller reads as "nothing to replay" and keeps its existing history.
   */
  fullHistory?: boolean;
  /** Bound the full-history capture to this many scrollback lines (`-S -<N>`). */
  historyLimitLines?: number;
  /**
   * Byte cap the consumer will keep from the capture. Sizes the child-process
   * stdout buffer (with slack) so multi-MB scrollback dumps aren't killed by
   * the 1MB execSync default (ENOBUFS).
   */
  maxCaptureBytes?: number;
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

  /** The dedicated tmux socket name all sessions live on (e.g. "codeman"). */
  readonly muxSocket: string;

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

  /** Get a session by Codeman session ID */
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

  /** Apply history-limit to live panes where tmux supports it, otherwise to future panes. */
  setHistoryLimit(limit: number): Promise<void>;

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

  /** Pin a mux window so client attaches do not automatically dictate its size. */
  setManualWindowSize?(muxName: string): boolean;

  /** Explicitly resize a mux window after Codeman accepts a terminal resize. */
  resizeWindow?(muxName: string, cols: number, rows: number): boolean;

  // ========== Availability ==========

  /** Check if the multiplexer binary is available on the system */
  isAvailable(): boolean;

  /** Check if a multiplexer session actually exists (process-level check, not just tracked) */
  muxSessionExists(muxName: string): boolean;

  /** Check if the pane in a session is dead (command exited but remain-on-exit keeps it alive) */
  isPaneDead(muxName: string): boolean;

  /** Respawn a dead pane with a fresh command. Returns the new PID or null on failure. */
  respawnPane(options: RespawnPaneOptions): Promise<number | null>;

  /**
   * Capture a pane's current tmux buffer with ANSI escape codes preserved.
   * Pass `{ fullHistory: true }` to capture the entire scrollback as linear
   * text instead of just the visible single-screen frame (COD-47).
   */
  capturePaneBuffer?(muxName: string, paneTarget?: string, opts?: PaneCaptureOptions): string | null;

  /**
   * Capture the active pane's current tmux buffer with ANSI escape codes preserved.
   * Pass `{ fullHistory: true }` to capture the entire scrollback (COD-47).
   */
  captureActivePaneBuffer?(muxName: string, opts?: PaneCaptureOptions): string | null;

  /**
   * Plain text of the visible frame: no styles, no cursor query, no repaint
   * reconstruction. Deliberately cheaper than `capturePaneBuffer` because idle
   * detection calls it on a timer: it only needs to read what the CLI is
   * currently rendering, never to replay it into an xterm. Returns null when the
   * pane cannot be read.
   */
  capturePaneText?(muxName: string, paneTarget?: string): string | null;
}
