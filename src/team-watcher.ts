/**
 * @fileoverview Agent Teams Watcher
 *
 * Polls ~/.claude/teams/ and ~/.claude/tasks/ for agent team activity.
 * Matches teams to Codeman sessions via leadSessionId and emits
 * events for UI updates and team-aware idle detection.
 *
 * @module team-watcher
 */

import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TeamConfig, TeamMember, TeamTask, InboxMessage } from './types.js';
import { LRUMap } from './utils/lru-map.js';

// ========== Constants ==========

const POLL_INTERVAL_MS = 5000;
const MAX_CACHED_TEAMS = 50;
const MAX_CACHED_TASKS = 200;

// ========== TeamWatcher Class ==========

export class TeamWatcher extends EventEmitter {
  private teamsDir: string;
  private tasksDir: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private teams: LRUMap<string, TeamConfig> = new LRUMap({ maxSize: MAX_CACHED_TEAMS });
  private teamTasks: LRUMap<string, TeamTask[]> = new LRUMap({ maxSize: MAX_CACHED_TASKS });
  private inboxCache: LRUMap<string, InboxMessage[]> = new LRUMap({ maxSize: MAX_CACHED_TASKS });
  // Track config mtimes to avoid re-reading unchanged files
  private configMtimes: Map<string, number> = new Map();
  private taskMtimes: Map<string, string> = new Map();
  private inboxMtimes: Map<string, number> = new Map();
  // Reverse index: sessionId → teamName for O(1) lookup
  private sessionToTeam: Map<string, string> = new Map();

  constructor(teamsDir?: string, tasksDir?: string) {
    super();
    const claudeHome = join(homedir(), '.claude');
    this.teamsDir = teamsDir || join(claudeHome, 'teams');
    this.tasksDir = tasksDir || join(claudeHome, 'tasks');
  }

  start(): void {
    if (this.pollTimer) return;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.teams.clear();
    this.teamTasks.clear();
    this.inboxCache.clear();
    this.configMtimes.clear();
    this.taskMtimes.clear();
    this.inboxMtimes.clear();
    this.sessionToTeam.clear();
  }

  /** Get all discovered teams */
  getTeams(): TeamConfig[] {
    return Array.from(this.teams.values());
  }

  /** Get team associated with a Codeman session (matched by leadSessionId) */
  getTeamForSession(sessionId: string): TeamConfig | undefined {
    const teamName = this.sessionToTeam.get(sessionId);
    if (teamName) {
      const team = this.teams.peek(teamName);
      if (team) return team;
      // Stale reverse index entry — clean up
      this.sessionToTeam.delete(sessionId);
    }
    return undefined;
  }

  /** Get tasks for a team (excluding internal tasks) */
  getTeamTasks(teamName: string): TeamTask[] {
    const tasks = this.teamTasks.get(teamName);
    if (!tasks) return [];
    return tasks.filter((t) => !t.metadata?._internal);
  }

  /** Count active (non-completed) tasks for a team */
  getActiveTaskCount(teamName: string): number {
    const tasks = this.getTeamTasks(teamName);
    return tasks.filter((t) => t.status !== 'completed').length;
  }

  /** Get inbox messages for a team member (or all members) */
  getInboxMessages(teamName: string, member?: string): InboxMessage[] {
    if (member) {
      const key = `${teamName}/${member}`;
      return this.inboxCache.get(key) || [];
    }
    // Return all messages for team
    const messages: InboxMessage[] = [];
    for (const [key, msgs] of this.inboxCache.entries()) {
      if (key.startsWith(`${teamName}/`)) {
        messages.push(...msgs);
      }
    }
    return messages.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  /** Check if a session has active teammates (for idle detection) */
  hasActiveTeammates(sessionId: string): boolean {
    const team = this.getTeamForSession(sessionId);
    if (!team) return false;

    // Check if any non-lead members exist (they are active by definition while present)
    const teammates = team.members.filter((m) => m.agentType !== 'team-lead');
    if (teammates.length === 0) return false;

    // Check if team has active (non-completed) tasks
    const activeTasks = this.getActiveTaskCount(team.name);
    return activeTasks > 0;
  }

  /** Get teammates that have real tmux panes (not in-process) */
  getTmuxPaneTeammates(teamName: string): Array<TeamMember & { tmuxPaneId: string }> {
    const team = this.teams.get(teamName);
    if (!team) return [];

    return team.members.filter(
      (m): m is TeamMember & { tmuxPaneId: string } =>
        m.agentType !== 'team-lead' && !!m.tmuxPaneId && m.tmuxPaneId !== 'in-process'
    );
  }

  /** Get count of active teammates for a session */
  getActiveTeammateCount(sessionId: string): number {
    const team = this.getTeamForSession(sessionId);
    if (!team) return 0;
    return team.members.filter((m) => m.agentType !== 'team-lead').length;
  }

  // ========== Private Methods ==========

  private poll(): void {
    // Run async poll — errors are caught internally per method
    this.pollAsync().catch(() => {
      // Don't crash on polling errors — filesystem may be temporarily unavailable
    });
  }

  private async pollAsync(): Promise<void> {
    await this.pollTeams();
    await this.pollTasks();
    await this.pollInboxes();
  }

  private async pollTeams(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.teamsDir);
    } catch {
      return;
    }

    const currentTeamNames = new Set<string>();

    for (const entry of entries) {
      const configPath = join(this.teamsDir, entry, 'config.json');

      currentTeamNames.add(entry);

      // Check mtime to skip unchanged configs
      let mtime: number;
      try {
        mtime = (await stat(configPath)).mtimeMs;
      } catch {
        // File doesn't exist or was removed between readdir and stat
        continue;
      }
      if (this.configMtimes.get(entry) === mtime) continue;
      this.configMtimes.set(entry, mtime);

      // Skip if locked
      if (await this.isLocked(join(this.teamsDir, entry, 'config.json'))) continue;

      const config = await this.readJson<TeamConfig>(configPath);
      if (!config || !config.name || !config.leadSessionId || !Array.isArray(config.members))
        continue;

      const existing = this.teams.get(entry);
      this.teams.set(entry, config);
      // Maintain reverse index
      if (existing && existing.leadSessionId !== config.leadSessionId) {
        this.sessionToTeam.delete(existing.leadSessionId);
      }
      this.sessionToTeam.set(config.leadSessionId, entry);

      if (existing) {
        this.emit('teamUpdated', config);
      } else {
        this.emit('teamCreated', config);
      }
    }

    // Detect removed teams
    for (const name of this.teams.keys()) {
      if (!currentTeamNames.has(name)) {
        const removed = this.teams.get(name);
        this.teams.delete(name);
        this.configMtimes.delete(name);
        // Clean up reverse index
        if (removed) {
          this.sessionToTeam.delete(removed.leadSessionId);
        }
        // Prune stale mtime entries for removed teams
        this.taskMtimes.delete(name);
        for (const key of this.inboxMtimes.keys()) {
          if (key.startsWith(`${name}/`)) {
            this.inboxMtimes.delete(key);
          }
        }
        if (removed) {
          this.emit('teamRemoved', removed);
        }
      }
    }
  }

  private async pollTasks(): Promise<void> {
    let teamDirs: string[];
    try {
      teamDirs = await readdir(this.tasksDir);
    } catch {
      return;
    }

    for (const teamName of teamDirs) {
      const teamTaskDir = join(this.tasksDir, teamName);

      // Use directory mtime as a cheap change indicator (single stat instead of N)
      const mtimeKey = teamName;
      try {
        const dirStat = await stat(teamTaskDir);
        const dirMtime = `${dirStat.mtimeMs}`;
        if (this.taskMtimes.get(mtimeKey) === dirMtime) continue;
        this.taskMtimes.set(mtimeKey, dirMtime);
      } catch {
        continue;
      }

      let taskFiles: string[];
      try {
        taskFiles = (await readdir(teamTaskDir)).filter(
          (f) => f.endsWith('.json') && f !== '.lock'
        );
      } catch {
        continue;
      }

      // Skip if locked
      if (await this.isLocked(join(teamTaskDir, '.lock'))) continue;

      const tasks: TeamTask[] = [];
      for (const f of taskFiles) {
        const task = await this.readJson<TeamTask>(join(teamTaskDir, f));
        if (task && task.id) {
          tasks.push(task);
        }
      }

      this.teamTasks.set(teamName, tasks);
      this.emit('taskUpdated', { teamName, tasks });
    }
  }

  private async pollInboxes(): Promise<void> {
    // Inbox files live under ~/.claude/teams/{name}/inboxes/
    for (const [teamName] of this.teams.entries()) {
      const inboxDir = join(this.teamsDir, teamName, 'inboxes');

      let inboxFiles: string[];
      try {
        inboxFiles = (await readdir(inboxDir)).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const f of inboxFiles) {
        const filePath = join(inboxDir, f);
        const memberName = f.replace('.json', '');
        const cacheKey = `${teamName}/${memberName}`;

        // Check mtime
        try {
          const mtime = (await stat(filePath)).mtimeMs;
          if (this.inboxMtimes.get(cacheKey) === mtime) continue;
          this.inboxMtimes.set(cacheKey, mtime);
        } catch {
          continue;
        }

        // Skip if locked
        if (await this.isLocked(filePath)) continue;

        const messages = await this.readJson<InboxMessage[]>(filePath);
        if (!Array.isArray(messages)) continue;

        const previous = this.inboxCache.get(cacheKey);
        this.inboxCache.set(cacheKey, messages);

        // Emit new messages — compare by timestamp to handle deletions/reordering
        const prevTimestamps = new Set(previous?.map((m) => m.timestamp) || []);
        for (const msg of messages) {
          if (!prevTimestamps.has(msg.timestamp)) {
            this.emit('inboxMessage', { teamName, member: memberName, message: msg });
          }
        }
      }
    }
  }

  /** Check for directory-based lock (mkdir atomic locking) */
  private async isLocked(path: string): Promise<boolean> {
    const lockDir = `${path}.lock`;
    try {
      return (await stat(lockDir)).isDirectory();
    } catch {
      return false;
    }
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
}
