/**
 * @fileoverview Agent Teams type definitions (experimental).
 *
 * Types for Claude Code's Agent Teams feature: team configuration,
 * member metadata, task tracking, and inbox messaging.
 *
 * Key exports:
 * - TeamConfig — team from `~/.claude/teams/{name}/config.json` (name, leadSessionId, members[])
 * - TeamMember — member entry (agentId, name, agentType, color)
 * - TeamTask — task from `~/.claude/tasks/{name}/{N}.json` (subject, status, blocks/blockedBy, owner)
 * - InboxMessage — message from `~/.claude/teams/{name}/inboxes/{member}.json`
 * - PaneInfo — tmux pane metadata for teammate pane management
 *
 * Cross-domain relationships:
 * - TeamConfig.leadSessionId links to SessionState.id (session domain)
 * - Teammates appear as standard subagents (detected by SubagentWatcher)
 *
 * Served at `GET /api/teams` (list) and `GET /api/teams/:name/tasks`.
 * Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var.
 * No dependencies on other domain modules.
 */

/** Team configuration from ~/.claude/teams/{name}/config.json */
export interface TeamConfig {
  name: string;
  leadSessionId: string;
  members: TeamMember[];
}

/** A single team member (lead or teammate) */
export interface TeamMember {
  agentId: string;
  name: string;
  agentType: 'team-lead' | 'general-purpose' | string;
  color?: string;
  backendType?: string;
  prompt?: string;
  tmuxPaneId?: string;
}

/** A task from ~/.claude/tasks/{team-name}/{N}.json */
export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/** An inbox message from ~/.claude/teams/{name}/inboxes/{member}.json */
export interface InboxMessage {
  from: string;
  text: string;
  timestamp: string;
  read?: boolean;
}

/**
 * Information about a tmux pane within a session.
 * Used for agent team teammate pane management.
 */
export interface PaneInfo {
  /** Pane ID (e.g., "%0", "%1") — immutable within a tmux session */
  paneId: string;
  /** Pane index within the window (0, 1, 2...) */
  paneIndex: number;
  /** PID of the process running in the pane */
  panePid: number;
  /** Pane width in columns */
  width: number;
  /** Pane height in rows */
  height: number;
}
