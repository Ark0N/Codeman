/**
 * @fileoverview tmux session manager for persistent Claude sessions.
 *
 * This module provides the TmuxManager class which creates and manages
 * tmux sessions that wrap Claude CLI processes. tmux provides:
 *
 * - **Persistence**: Sessions survive server restarts and disconnects
 * - **Ghost recovery**: Orphaned sessions are discovered and reattached on startup
 * - **Resource tracking**: Memory, CPU, and child process stats per session
 * - **Reliable input**: `send-keys -l` sends literal text in a single command
 * - **Teammate support**: Immutable pane IDs enable targeting individual teammates
 *
 * tmux sessions are named `claudeman-{sessionId}` and stored in ~/.claudeman/mux-sessions.json.
 *
 * Key advantages over GNU Screen:
 * - `send-keys 'text' Enter` eliminates the text+CR split hack (no 100ms delay, no retries)
 * - `list-sessions -F` provides structured queries (no regex parsing)
 * - `display-message -p '#{pane_pid}'` for reliable PID discovery
 * - Single server architecture vs per-session processes
 *
 * @module tmux-manager
 */

import { EventEmitter } from 'node:events';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ProcessStats, PersistedRespawnConfig, getErrorMessage, NiceConfig, DEFAULT_NICE_CONFIG } from './types.js';
import { wrapWithNice } from './screen-manager.js';
import type { TerminalMultiplexer, MuxSession, MuxSessionWithStats } from './mux-interface.js';

// ============================================================================
// Claude CLI PATH Resolution
// ============================================================================

/** Common directories where the Claude CLI binary may be installed */
const CLAUDE_SEARCH_DIRS = [
  `${homedir()}/.local/bin`,
  `${homedir()}/.claude/local`,
  '/usr/local/bin',
  `${homedir()}/.npm-global/bin`,
  `${homedir()}/bin`,
];

// ============================================================================
// Timing Constants
// ============================================================================

/** Timeout for exec commands (5 seconds) */
const EXEC_TIMEOUT_MS = 5000;

/** Delay after tmux session creation (300ms — faster than screen's 500ms) */
const TMUX_CREATION_WAIT_MS = 300;

/** Delay after tmux kill command (200ms) */
const TMUX_KILL_WAIT_MS = 200;

/** Delay for graceful shutdown (100ms) */
const GRACEFUL_SHUTDOWN_WAIT_MS = 100;

/** Default stats collection interval (2 seconds) */
const DEFAULT_STATS_INTERVAL_MS = 2000;

/** Cached directory containing the claude binary */
let _claudeDir: string | null = null;

/**
 * Finds the directory containing the `claude` binary.
 * Returns null if not found (will rely on PATH as-is).
 */
function findClaudeDir(): string | null {
  if (_claudeDir !== null) return _claudeDir;

  try {
    const result = execSync('which claude', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
    if (result && existsSync(result)) {
      _claudeDir = dirname(result);
      return _claudeDir;
    }
  } catch {
    // not in PATH
  }

  for (const dir of CLAUDE_SEARCH_DIRS) {
    if (existsSync(`${dir}/claude`)) {
      _claudeDir = dir;
      return _claudeDir;
    }
  }

  _claudeDir = '';  // mark as searched, not found
  return null;
}

/** Path to persisted mux session metadata */
const MUX_SESSIONS_FILE = join(homedir(), '.claudeman', 'mux-sessions.json');

/** Path to legacy screen sessions (for migration) */
const LEGACY_SCREENS_FILE = join(homedir(), '.claudeman', 'screens.json');

/** Regex to validate tmux session names (only allow safe characters) */
const SAFE_MUX_NAME_PATTERN = /^claudeman-[a-f0-9-]+$/;

/** Regex to validate working directory paths (no shell metacharacters) */
const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_\/\-. ~]+$/;

/**
 * Validates that a session name contains only safe characters.
 * Prevents command injection via malformed session IDs.
 */
function isValidMuxName(name: string): boolean {
  return SAFE_MUX_NAME_PATTERN.test(name);
}

/**
 * Validates that a path contains only safe characters.
 * Prevents command injection via malformed paths.
 */
function isValidPath(path: string): boolean {
  if (path.includes(';') || path.includes('&') || path.includes('|') ||
      path.includes('$') || path.includes('`') || path.includes('(') ||
      path.includes(')') || path.includes('{') || path.includes('}') ||
      path.includes('<') || path.includes('>') || path.includes("'") ||
      path.includes('"') || path.includes('\n') || path.includes('\r')) {
    return false;
  }
  if (path.includes('..')) {
    return false;
  }
  return SAFE_PATH_PATTERN.test(path);
}

/**
 * Manages tmux sessions that wrap Claude CLI or shell processes.
 *
 * Implements the TerminalMultiplexer interface for use as a drop-in
 * replacement for ScreenManager.
 *
 * @example
 * ```typescript
 * const manager = new TmuxManager();
 *
 * // Create a tmux session for Claude
 * const session = await manager.createSession(sessionId, '/project', 'claude');
 *
 * // Send input (single command, no delay!)
 * manager.sendInput(sessionId, '/clear\r');
 *
 * // Kill when done
 * await manager.killSession(sessionId);
 * ```
 */
export class TmuxManager extends EventEmitter implements TerminalMultiplexer {
  readonly backend = 'tmux' as const;
  private sessions: Map<string, MuxSession> = new Map();
  private statsInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.loadSessions();
  }

  // Load saved sessions from disk
  private loadSessions(): void {
    try {
      if (existsSync(MUX_SESSIONS_FILE)) {
        const content = readFileSync(MUX_SESSIONS_FILE, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          for (const session of data) {
            this.sessions.set(session.sessionId, session);
          }
        }
      } else if (existsSync(LEGACY_SCREENS_FILE)) {
        // Migration: load from legacy screens.json
        console.log('[TmuxManager] Migrating sessions from legacy screens.json');
        const content = readFileSync(LEGACY_SCREENS_FILE, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          for (const screen of data) {
            const session: MuxSession = {
              sessionId: screen.sessionId,
              muxName: screen.screenName,
              pid: screen.pid,
              createdAt: screen.createdAt,
              workingDir: screen.workingDir,
              mode: screen.mode,
              attached: screen.attached,
              name: screen.name,
              respawnConfig: screen.respawnConfig,
              ralphEnabled: screen.ralphEnabled,
            };
            this.sessions.set(session.sessionId, session);
          }
          this.saveSessions();
          console.log(`[TmuxManager] Migrated ${data.length} sessions from screens.json`);
        }
      }
    } catch (err) {
      console.error('[TmuxManager] Failed to load sessions:', err);
    }
  }

  /**
   * Save sessions to disk asynchronously.
   */
  private saveSessions(): void {
    try {
      const dir = dirname(MUX_SESSIONS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.sessions.values());
      const json = JSON.stringify(data, null, 2);

      writeFile(MUX_SESSIONS_FILE, json, (err) => {
        if (err) {
          console.error('[TmuxManager] Failed to save sessions:', err);
        }
      });
    } catch (err) {
      console.error('[TmuxManager] Failed to save sessions:', err);
    }
  }

  /**
   * Creates a new tmux session wrapping Claude CLI or a shell.
   */
  async createSession(
    sessionId: string,
    workingDir: string,
    mode: 'claude' | 'shell',
    name?: string,
    niceConfig?: NiceConfig,
  ): Promise<MuxSession> {
    const muxName = `claudeman-${sessionId.slice(0, 8)}`;

    if (!isValidMuxName(muxName)) {
      throw new Error('Invalid session name: contains unsafe characters');
    }
    if (!isValidPath(workingDir)) {
      throw new Error('Invalid working directory path: contains unsafe characters');
    }

    const claudeDir = findClaudeDir();
    const pathExport = claudeDir ? `export PATH="${claudeDir}:$PATH" && ` : '';

    const envExports = [
      'export CLAUDEMAN_SCREEN=1',
      `export CLAUDEMAN_SESSION_ID=${sessionId}`,
      `export CLAUDEMAN_SCREEN_NAME=${muxName}`,
      `export CLAUDEMAN_API_URL=${process.env.CLAUDEMAN_API_URL || 'http://localhost:3000'}`,
    ].join(' && ');

    const baseCmd = mode === 'claude'
      ? `claude --dangerously-skip-permissions --session-id "${sessionId}"`
      : '$SHELL';

    const config = niceConfig || DEFAULT_NICE_CONFIG;
    const cmd = wrapWithNice(baseCmd, config);

    try {
      // Build the full command to run inside tmux
      const fullCmd = `${pathExport}${envExports} && ${cmd}`;

      // Create tmux session in detached mode
      // -d: don't attach, -s: session name, -c: starting directory
      // -x/-y: initial window size
      const tmuxProcess = spawn('tmux', [
        'new-session',
        '-ds', muxName,
        '-c', workingDir,
        '-x', '120',
        '-y', '40',
        'bash', '-c', fullCmd,
      ], {
        cwd: workingDir,
        detached: true,
        stdio: 'ignore',
      });

      tmuxProcess.unref();

      // Wait for tmux session to start
      await new Promise(resolve => setTimeout(resolve, TMUX_CREATION_WAIT_MS));

      // Disable tmux status bar — Claudeman's web UI provides session info,
      // and the status bar can't be copied and wastes a terminal row
      try {
        execSync(
          `tmux set-option -t "${muxName}" status off`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
      } catch {
        // Non-critical — session still works with status bar
      }

      // Get the PID of the pane process
      const pid = this.getPanePid(muxName);
      if (!pid) {
        throw new Error('Failed to get tmux pane PID');
      }

      const session: MuxSession = {
        sessionId,
        muxName,
        pid,
        createdAt: Date.now(),
        workingDir,
        mode,
        attached: false,
        name,
      };

      this.sessions.set(sessionId, session);
      this.saveSessions();
      this.emit('sessionCreated', session);

      return session;
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Get the PID of the process running in the tmux pane.
   */
  private getPanePid(muxName: string): number | null {
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in getPanePid:', muxName);
      return null;
    }

    try {
      const output = execSync(
        `tmux display-message -t "${muxName}" -p '#{pane_pid}'`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      ).trim();
      const pid = parseInt(output, 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Check if a tmux session exists.
   */
  private sessionExists(muxName: string): boolean {
    try {
      execSync(`tmux has-session -t "${muxName}" 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  // Get all child process PIDs recursively
  private getChildPids(pid: number): number[] {
    const pids: number[] = [];
    try {
      const output = execSync(`pgrep -P ${pid}`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      if (output) {
        for (const childPid of output.split('\n').map(p => parseInt(p, 10)).filter(p => !Number.isNaN(p))) {
          pids.push(childPid);
          pids.push(...this.getChildPids(childPid));
        }
      }
    } catch {
      // No children or command failed
    }
    return pids;
  }

  // Check if a process is still alive
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Verify all PIDs are dead, with retry
  private async verifyProcessesDead(pids: number[], maxWaitMs: number = 1000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 100;

    while (Date.now() - startTime < maxWaitMs) {
      const aliveCount = pids.filter(pid => this.isProcessAlive(pid)).length;
      if (aliveCount === 0) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    const stillAlive = pids.filter(pid => this.isProcessAlive(pid));
    if (stillAlive.length > 0) {
      console.warn(`[TmuxManager] ${stillAlive.length} processes still alive after kill: ${stillAlive.join(', ')}`);
    }
    return stillAlive.length === 0;
  }

  /**
   * Kill a tmux session and all its child processes.
   * Uses the same 4-strategy approach as ScreenManager.
   */
  async killSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // Get current PID (may have changed)
    const currentPid = this.getPanePid(session.muxName) || session.pid;

    console.log(`[TmuxManager] Killing session ${session.muxName} (PID ${currentPid})`);

    const allPids: number[] = [currentPid];

    // Strategy 1: Kill all child processes recursively
    let childPids = this.getChildPids(currentPid);
    if (childPids.length > 0) {
      console.log(`[TmuxManager] Found ${childPids.length} child processes to kill`);
      allPids.push(...childPids);

      for (const childPid of [...childPids].reverse()) {
        if (this.isProcessAlive(childPid)) {
          try {
            process.kill(childPid, 'SIGTERM');
          } catch {
            // Process may already be dead
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, TMUX_KILL_WAIT_MS));

      childPids = this.getChildPids(currentPid);
      for (const childPid of childPids) {
        if (this.isProcessAlive(childPid)) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // Process already terminated
          }
        }
      }
    }

    // Strategy 2: Kill the entire process group
    if (this.isProcessAlive(currentPid)) {
      try {
        process.kill(-currentPid, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, GRACEFUL_SHUTDOWN_WAIT_MS));
        if (this.isProcessAlive(currentPid)) {
          process.kill(-currentPid, 'SIGKILL');
        }
      } catch {
        // Process group may not exist or already terminated
      }
    }

    // Strategy 3: Kill tmux session by name
    try {
      execSync(`tmux kill-session -t "${session.muxName}" 2>/dev/null`, {
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch {
      // Session may already be dead
    }

    // Strategy 4: Direct kill by PID as final fallback
    if (this.isProcessAlive(currentPid)) {
      try {
        process.kill(currentPid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }

    // Verify all processes are dead
    const allDead = await this.verifyProcessesDead(allPids, 2000);
    if (!allDead) {
      console.error(`[TmuxManager] Warning: Some processes may still be alive for session ${session.muxName}`);
    }

    this.sessions.delete(sessionId);
    this.saveSessions();
    this.emit('sessionKilled', { sessionId });

    return true;
  }

  getSessions(): MuxSession[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): MuxSession | undefined {
    return this.sessions.get(sessionId);
  }

  updateSessionName(sessionId: string, name: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.name = name;
    this.saveSessions();
    return true;
  }

  /**
   * Reconcile tracked sessions with actual running tmux sessions.
   */
  async reconcileSessions(): Promise<{ alive: string[]; dead: string[]; discovered: string[] }> {
    const alive: string[] = [];
    const dead: string[] = [];
    const discovered: string[] = [];

    // Check known sessions
    for (const [sessionId, session] of this.sessions) {
      if (this.sessionExists(session.muxName)) {
        alive.push(sessionId);
        // Update PID if it changed
        const pid = this.getPanePid(session.muxName);
        if (pid && pid !== session.pid) {
          session.pid = pid;
        }
      } else {
        dead.push(sessionId);
        this.sessions.delete(sessionId);
        this.emit('sessionDied', { sessionId });
      }
    }

    // Discover unknown claudeman sessions
    try {
      const output = execSync(
        "tmux list-sessions -F '#{session_name}' 2>/dev/null || true",
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      ).trim();

      for (const line of output.split('\n')) {
        const sessionName = line.trim();
        if (!sessionName || !sessionName.startsWith('claudeman-')) continue;

        // Check if this session is already known
        let isKnown = false;
        for (const session of this.sessions.values()) {
          if (session.muxName === sessionName) {
            isKnown = true;
            break;
          }
        }

        if (!isKnown) {
          // Extract session ID fragment from name
          const fragment = sessionName.replace('claudeman-', '');
          const sessionId = `restored-${fragment}`;
          const pid = this.getPanePid(sessionName);

          if (pid) {
            const session: MuxSession = {
              sessionId,
              muxName: sessionName,
              pid,
              createdAt: Date.now(),
              workingDir: process.cwd(),
              mode: 'claude',
              attached: false,
              name: `Restored: ${sessionName}`,
            };
            this.sessions.set(sessionId, session);
            discovered.push(sessionId);
            console.log(`[TmuxManager] Discovered unknown tmux session: ${sessionName} (PID ${pid})`);
          }
        }
      }
    } catch (err) {
      console.error('[TmuxManager] Failed to discover sessions:', err);
    }

    if (dead.length > 0 || discovered.length > 0) {
      this.saveSessions();
    }

    return { alive, dead, discovered };
  }

  async getProcessStats(sessionId: string): Promise<ProcessStats | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    try {
      const psOutput = execSync(
        `ps -o rss=,pcpu= -p ${session.pid} 2>/dev/null || echo "0 0"`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      ).trim();

      const [rss, cpu] = psOutput.split(/\s+/).map(x => parseFloat(x) || 0);

      let childCount = 0;
      try {
        const childOutput = execSync(
          `pgrep -P ${session.pid} | wc -l`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        ).trim();
        childCount = parseInt(childOutput, 10) || 0;
      } catch {
        // No children or command failed
      }

      return {
        memoryMB: Math.round(rss / 1024 * 10) / 10,
        cpuPercent: Math.round(cpu * 10) / 10,
        childCount,
        updatedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getSessionsWithStats(): Promise<MuxSessionWithStats[]> {
    const sessions = Array.from(this.sessions.values());
    if (sessions.length === 0) {
      return [];
    }

    const sessionPids = sessions.map(s => s.pid);
    const statsMap = new Map<number, ProcessStats>();

    try {
      // Step 1: Get descendant PIDs
      const descendantMap = new Map<number, number[]>();

      const pgrepOutput = execSync(
        `for p in ${sessionPids.join(' ')}; do children=$(pgrep -P $p 2>/dev/null | tr '\\n' ','); echo "$p:$children"; done`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      ).trim();

      for (const line of pgrepOutput.split('\n')) {
        const [pidStr, childrenStr] = line.split(':');
        const sessionPid = parseInt(pidStr, 10);
        if (!Number.isNaN(sessionPid)) {
          const children = (childrenStr || '')
            .split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !Number.isNaN(n) && n > 0);
          descendantMap.set(sessionPid, children);
        }
      }

      // Step 2: Collect all PIDs
      const allPids = new Set<number>(sessionPids);
      for (const children of descendantMap.values()) {
        for (const child of children) {
          allPids.add(child);
        }
      }

      // Step 3: Single ps call
      const pidArray = Array.from(allPids);
      if (pidArray.length > 0) {
        const psOutput = execSync(
          `ps -o pid=,rss=,pcpu= -p ${pidArray.join(',')} 2>/dev/null || true`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        ).trim();

        const processStats = new Map<number, { rss: number; cpu: number }>();
        for (const line of psOutput.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const pid = parseInt(parts[0], 10);
            const rss = parseFloat(parts[1]) || 0;
            const cpu = parseFloat(parts[2]) || 0;
            if (!Number.isNaN(pid)) {
              processStats.set(pid, { rss, cpu });
            }
          }
        }

        // Step 4: Aggregate stats
        for (const sessionPid of sessionPids) {
          const children = descendantMap.get(sessionPid) || [];
          const sessionStats = processStats.get(sessionPid) || { rss: 0, cpu: 0 };

          let totalRss = sessionStats.rss;
          let totalCpu = sessionStats.cpu;

          for (const childPid of children) {
            const childStats = processStats.get(childPid);
            if (childStats) {
              totalRss += childStats.rss;
              totalCpu += childStats.cpu;
            }
          }

          statsMap.set(sessionPid, {
            memoryMB: Math.round(totalRss / 1024 * 10) / 10,
            cpuPercent: Math.round(totalCpu * 10) / 10,
            childCount: children.length,
            updatedAt: Date.now(),
          });
        }
      }
    } catch {
      // Fall back to individual queries
      const statsPromises = sessions.map(session => this.getProcessStats(session.sessionId));
      const results = await Promise.allSettled(statsPromises);
      return sessions.map((session, i) => ({
        ...session,
        stats: results[i].status === 'fulfilled' ? (results[i].value ?? undefined) : undefined,
      }));
    }

    return sessions.map(session => ({
      ...session,
      stats: statsMap.get(session.pid) || undefined,
    }));
  }

  startStatsCollection(intervalMs: number = DEFAULT_STATS_INTERVAL_MS): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    this.statsInterval = setInterval(async () => {
      try {
        const sessionsWithStats = await this.getSessionsWithStats();
        this.emit('statsUpdated', sessionsWithStats);
      } catch (err) {
        console.error('[TmuxManager] Stats collection error:', err);
      }
    }, intervalMs);
  }

  stopStatsCollection(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  destroy(): void {
    this.stopStatsCollection();
  }

  registerSession(session: MuxSession): void {
    this.sessions.set(session.sessionId, session);
    this.saveSessions();
  }

  setAttached(sessionId: string, attached: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.attached = attached;
      this.saveSessions();
    }
  }

  updateRespawnConfig(sessionId: string, config: PersistedRespawnConfig | undefined): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.respawnConfig = config;
      this.saveSessions();
    }
  }

  clearRespawnConfig(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.respawnConfig) {
      delete session.respawnConfig;
      this.saveSessions();
    }
  }

  updateRalphEnabled(sessionId: string, enabled: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ralphEnabled = enabled;
      this.saveSessions();
    }
  }

  /**
   * Send input directly to a tmux session using `send-keys`.
   *
   * This is significantly simpler than Screen's approach:
   * - `-l` flag sends literal text (no key interpretation)
   * - `Enter` key is sent as a separate argument (not a shell escape)
   * - Single command, no delay, no retry loop needed
   */
  sendInput(sessionId: string, input: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[TmuxManager] sendInput failed: no session found for ${sessionId}. Known: ${Array.from(this.sessions.keys()).join(', ')}`);
      return false;
    }

    console.log(`[TmuxManager] sendInput to ${session.muxName}, input length: ${input.length}, hasCarriageReturn: ${input.includes('\r')}`);

    if (!isValidMuxName(session.muxName)) {
      console.error('[TmuxManager] Invalid session name in sendInput:', session.muxName);
      return false;
    }

    try {
      const hasCarriageReturn = input.includes('\r');
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '').trimEnd();

      if (textPart && hasCarriageReturn) {
        // Send text + Enter in a single command
        // -l flag = literal text (no special key interpretation)
        // 'Enter' after -l text = Enter key
        execSync(
          `tmux send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
        execSync(
          `tmux send-keys -t "${session.muxName}" Enter`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
      } else if (textPart) {
        // Text only, no Enter
        execSync(
          `tmux send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
      } else if (hasCarriageReturn) {
        // Enter only
        execSync(
          `tmux send-keys -t "${session.muxName}" Enter`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
      }

      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to send input:', err);
      return false;
    }
  }

  getAttachCommand(): string {
    return 'tmux';
  }

  getAttachArgs(muxName: string): string[] {
    return ['attach-session', '-t', muxName];
  }

  isAvailable(): boolean {
    return TmuxManager.isTmuxAvailable();
  }

  /**
   * Check if tmux is available on the system.
   */
  static isTmuxAvailable(): boolean {
    try {
      execSync('which tmux', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Shell-escape a string for use as a single argument.
 * Wraps in single quotes, escaping any embedded single quotes.
 */
function shellescape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, restart quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
