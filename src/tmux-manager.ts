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
 * Key features:
 * - `send-keys 'text' Enter` sends literal text in a single command
 * - `list-sessions -F` provides structured queries
 * - `display-message -p '#{pane_pid}'` for reliable PID discovery
 * - Single server architecture
 *
 * @module tmux-manager
 */

import { EventEmitter } from 'node:events';
import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ProcessStats, PersistedRespawnConfig, getErrorMessage, NiceConfig, DEFAULT_NICE_CONFIG, type PaneInfo, type ClaudeMode } from './types.js';
import { wrapWithNice } from './utils/nice-wrapper.js';
import { SAFE_PATH_PATTERN } from './utils/regex-patterns.js';
import type { TerminalMultiplexer, MuxSession, MuxSessionWithStats } from './mux-interface.js';

// Claude CLI PATH resolution — shared utility
import { findClaudeDir } from './utils/claude-cli-resolver.js';

// ============================================================================
// Timing Constants
// ============================================================================

/** Timeout for exec commands (5 seconds) */
const EXEC_TIMEOUT_MS = 5000;

/** Delay after tmux session creation — enough for detached tmux to be queryable */
const TMUX_CREATION_WAIT_MS = 100;

/** Max retries for getPanePid — tmux server cold-start (e.g. macOS) may need extra time */
const GET_PID_MAX_RETRIES = 5;
const GET_PID_RETRY_MS = 200;

/** Delay after tmux kill command (200ms) */
const TMUX_KILL_WAIT_MS = 200;

/** Delay for graceful shutdown (100ms) */
const GRACEFUL_SHUTDOWN_WAIT_MS = 100;

/** Default stats collection interval (2 seconds) */
const DEFAULT_STATS_INTERVAL_MS = 2000;

/**
 * SAFETY: Test mode detection.
 * When running under vitest (VITEST env var is set automatically),
 * ALL tmux shell commands are disabled. TmuxManager becomes a pure
 * in-memory mock that cannot interact with real tmux sessions.
 *
 * This makes it PHYSICALLY IMPOSSIBLE for any test to:
 * - Kill a tmux session
 * - Create a tmux session
 * - Send input to a tmux session
 * - Discover/reconcile real tmux sessions
 * - Read/write ~/.claudeman/mux-sessions.json
 */
const IS_TEST_MODE = !!process.env.VITEST;

/** Path to persisted mux session metadata */
const MUX_SESSIONS_FILE = join(homedir(), '.claudeman', 'mux-sessions.json');

/** Regex to validate tmux session names (only allow safe characters) */
const SAFE_MUX_NAME_PATTERN = /^claudeman-[a-f0-9-]+$/;

/** Regex to validate tmux pane targets (e.g., "%0", "%1", "0", "1") */
const SAFE_PANE_TARGET_PATTERN = /^(%\d+|\d+)$/;

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
 * Build Claude CLI permission flags for the tmux command string.
 * Validates allowedTools to prevent command injection.
 */
function buildClaudePermissionFlags(claudeMode?: ClaudeMode, allowedTools?: string): string {
  const mode = claudeMode || 'dangerously-skip-permissions';
  switch (mode) {
    case 'dangerously-skip-permissions':
      return ' --dangerously-skip-permissions';
    case 'allowedTools':
      if (allowedTools) {
        // Sanitize: allow tool names with patterns like Bash(git:*), space/comma-separated
        // Block shell metacharacters: ; & | $ ` \ { } < > ' " newlines
        const hasDangerousChars = /[;&|$`\\{}<>'"[\]\n\r]/.test(allowedTools);
        if (!hasDangerousChars) {
          return ` --allowedTools "${allowedTools}"`;
        }
      }
      // Fall back to normal mode if tools are invalid or missing
      return '';
    case 'normal':
      return '';
  }
}

/**
 * Manages tmux sessions that wrap Claude CLI or shell processes.
 *
 * Implements the TerminalMultiplexer interface.
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
  private mouseSyncInterval: NodeJS.Timeout | null = null;
  /** Track last-known pane count per session to avoid unnecessary tmux set-option calls */
  private lastPaneCount: Map<string, number> = new Map();

  private trueColorConfigured = false;

  constructor() {
    super();
    this.setMaxListeners(50);
    if (!IS_TEST_MODE) {
      this.loadSessions();
    }
  }

  // Load saved sessions from disk (NEVER called in test mode)
  private loadSessions(): void {
    if (IS_TEST_MODE) return;

    try {
      if (existsSync(MUX_SESSIONS_FILE)) {
        const content = readFileSync(MUX_SESSIONS_FILE, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          for (const session of data) {
            this.sessions.set(session.sessionId, session);
          }
        }
      }
    } catch (err) {
      console.error('[TmuxManager] Failed to load sessions:', err);
    }
  }

  /**
   * Save sessions to disk asynchronously. (NEVER writes in test mode)
   * Uses atomic temp+rename to prevent corruption on crash.
   */
  private saveSessions(): void {
    if (IS_TEST_MODE) return;

    try {
      const dir = dirname(MUX_SESSIONS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.sessions.values());
      const json = JSON.stringify(data, null, 2);

      const tempPath = MUX_SESSIONS_FILE + '.tmp';
      writeFile(tempPath, json, 'utf-8')
        .then(() => rename(tempPath, MUX_SESSIONS_FILE))
        .catch((err) => {
          console.error('[TmuxManager] Failed to save sessions:', err);
        });
    } catch (err) {
      console.error('[TmuxManager] Failed to save sessions:', err);
    }
  }

  /**
   * Creates a new tmux session wrapping Claude CLI or a shell.
   * In test mode: creates an in-memory session only (no real tmux session).
   */
  async createSession(
    sessionId: string,
    workingDir: string,
    mode: 'claude' | 'shell',
    name?: string,
    niceConfig?: NiceConfig,
    model?: string,
    claudeMode?: ClaudeMode,
    allowedTools?: string,
  ): Promise<MuxSession> {
    const muxName = `claudeman-${sessionId.slice(0, 8)}`;

    if (!isValidMuxName(muxName)) {
      throw new Error('Invalid session name: contains unsafe characters');
    }
    if (!isValidPath(workingDir)) {
      throw new Error('Invalid working directory path: contains unsafe characters');
    }

    // TEST MODE: Create in-memory session only — no real tmux session
    if (IS_TEST_MODE) {
      const session: MuxSession = {
        sessionId,
        muxName,
        pid: 99999,
        createdAt: Date.now(),
        workingDir,
        mode,
        attached: false,
        name,
      };
      this.sessions.set(sessionId, session);
      this.emit('sessionCreated', session);
      return session;
    }

    const claudeDir = findClaudeDir();
    if (!claudeDir && mode === 'claude') {
      throw new Error('Claude CLI not found. Install it with: curl -fsSL https://claude.ai/install.sh | bash');
    }
    const pathExport = claudeDir ? `export PATH="${claudeDir}:$PATH" && ` : '';

    const envExports = [
      'unset CLAUDECODE',
      'unset COLORTERM',
      'export CLAUDEMAN_MUX=1',
      `export CLAUDEMAN_SESSION_ID=${sessionId}`,
      `export CLAUDEMAN_MUX_NAME=${muxName}`,
      `export CLAUDEMAN_API_URL=${process.env.CLAUDEMAN_API_URL || 'http://localhost:3000'}`,
    ].join(' && ');

    // Validate model to prevent command injection (only allow alphanumeric, hyphens, dots)
    const safeModel = (model && /^[a-zA-Z0-9._-]+$/.test(model)) ? model : undefined;
    const modelFlag = (mode === 'claude' && safeModel) ? ` --model ${safeModel}` : '';
    const baseCmd = mode === 'claude'
      ? `claude${buildClaudePermissionFlags(claudeMode, allowedTools)} --session-id "${sessionId}"${modelFlag}`
      : '$SHELL';

    const config = niceConfig || DEFAULT_NICE_CONFIG;
    const cmd = wrapWithNice(baseCmd, config);

    try {
      // Build the full command to run inside tmux
      const fullCmd = `${pathExport}${envExports} && ${cmd}`;

      // Create tmux session in three steps to handle cold-start (no server running)
      // and avoid the race where the command exits before remain-on-exit is set:
      // 1. Create session with default shell (starts tmux server, stays alive)
      // 2. Set remain-on-exit (server now exists, session won't vanish on exit)
      // 3. Replace shell with actual command via respawn-pane (no terminal echo)
      execSync(
        `tmux new-session -ds "${muxName}" -c "${workingDir}" -x 120 -y 40`,
        { cwd: workingDir, timeout: EXEC_TIMEOUT_MS, stdio: 'ignore' }
      );

      // Set remain-on-exit now that the server is running — must be before respawn-pane
      try {
        execSync(`tmux set-option -t "${muxName}" remain-on-exit on`, { timeout: EXEC_TIMEOUT_MS, stdio: 'ignore' });
      } catch { /* Non-critical */ }

      // Replace the shell with the actual command (no echo in terminal)
      execSync(
        `tmux respawn-pane -k -t "${muxName}" bash -c ${JSON.stringify(fullCmd)}`,
        { timeout: EXEC_TIMEOUT_MS, stdio: 'ignore' }
      );

      // Wait for tmux session to be queryable
      await new Promise(resolve => setTimeout(resolve, TMUX_CREATION_WAIT_MS));

      // Non-critical tmux config — run in parallel to avoid blocking event loop.
      // These configure UX niceties (no status bar, true color).
      // Mouse mode is OFF by default so xterm.js handles text selection natively.
      // It gets enabled dynamically when panes are split (agent teams).
      const configPromises: Promise<void>[] = [
        // Disable tmux status bar — Claudeman's web UI provides session info
        execAsync(`tmux set-option -t "${muxName}" status off`, { timeout: EXEC_TIMEOUT_MS })
          .then(() => {}).catch(() => { /* Non-critical — session still works with status bar */ }),
        // Override global remain-on-exit with session-level setting
        execAsync(`tmux set-option -t "${muxName}" remain-on-exit on`, { timeout: EXEC_TIMEOUT_MS })
          .then(() => {}).catch(() => { /* Already set globally as fallback */ }),
      ];

      // Enable 24-bit true color passthrough — server-wide, set once per lifetime
      if (!this.trueColorConfigured) {
        configPromises.push(
          execAsync(`tmux set-option -sa terminal-overrides ",*:Tc"`, { timeout: EXEC_TIMEOUT_MS })
            .then(() => { this.trueColorConfigured = true; })
            .catch(() => { /* Non-critical — colors limited to 256 */ })
        );
      }

      // Fire-and-forget — these are non-critical UX niceties that don't need
      // to complete before the session is usable. Errors are already swallowed.
      void Promise.all(configPromises);

      // Get the PID of the pane process (retry for tmux server cold-start)
      let pid = this.getPanePid(muxName);
      for (let i = 0; !pid && i < GET_PID_MAX_RETRIES; i++) {
        await new Promise(resolve => setTimeout(resolve, GET_PID_RETRY_MS));
        pid = this.getPanePid(muxName);
      }
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
    if (IS_TEST_MODE) return 99999;

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
  muxSessionExists(muxName: string): boolean {
    return this.sessionExists(muxName);
  }

  /**
   * Check if the pane in a tmux session is dead (command exited but remain-on-exit keeps it).
   * Returns true if the session exists but the pane's command has exited.
   */
  isPaneDead(muxName: string): boolean {
    if (IS_TEST_MODE) return false;
    if (!isValidMuxName(muxName)) return false;
    try {
      const output = execSync(
        `tmux display-message -t "${muxName}" -p '#{pane_dead}'`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      ).trim();
      return output === '1';
    } catch {
      return false;
    }
  }

  /**
   * Respawn a dead pane in an existing tmux session.
   * Uses `tmux respawn-pane -k` to restart the command in the same pane,
   * preserving the session and its scrollback buffer.
   */
  async respawnPane(sessionId: string, workingDir: string, mode: 'claude' | 'shell', niceConfig?: NiceConfig, model?: string, claudeMode?: ClaudeMode, allowedTools?: string): Promise<number | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const muxName = session.muxName;

    if (!isValidMuxName(muxName) || !isValidPath(workingDir)) return null;

    const claudeDir = findClaudeDir();
    const pathExport = claudeDir ? `export PATH="${claudeDir}:$PATH" && ` : '';
    const envExports = [
      'unset CLAUDECODE',
      'unset COLORTERM',
      'export CLAUDEMAN_MUX=1',
      `export CLAUDEMAN_SESSION_ID=${sessionId}`,
      `export CLAUDEMAN_MUX_NAME=${muxName}`,
      `export CLAUDEMAN_API_URL=${process.env.CLAUDEMAN_API_URL || 'http://localhost:3000'}`,
    ].join(' && ');

    const safeModel = (model && /^[a-zA-Z0-9._-]+$/.test(model)) ? model : undefined;
    const modelFlag = (mode === 'claude' && safeModel) ? ` --model ${safeModel}` : '';
    const baseCmd = mode === 'claude'
      ? `claude${buildClaudePermissionFlags(claudeMode, allowedTools)} --session-id "${sessionId}"${modelFlag}`
      : '$SHELL';

    const config = niceConfig || DEFAULT_NICE_CONFIG;
    const cmd = wrapWithNice(baseCmd, config);
    const fullCmd = `${pathExport}${envExports} && ${cmd}`;

    try {
      await execAsync(
        `tmux respawn-pane -k -t "${muxName}" bash -c ${JSON.stringify(fullCmd)}`,
        { timeout: EXEC_TIMEOUT_MS }
      );
      // Wait for the respawned process to start
      await new Promise(resolve => setTimeout(resolve, TMUX_CREATION_WAIT_MS));
      const pid = this.getPanePid(muxName);
      if (pid) session.pid = pid;
      return pid;
    } catch (err) {
      console.error('[TmuxManager] Failed to respawn pane:', err);
      return null;
    }
  }

  private sessionExists(muxName: string): boolean {
    if (IS_TEST_MODE) return false;

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
   * Uses a 4-strategy approach (children → process group → tmux kill → SIGKILL).
   * In test mode: removes from memory only (no real kill).
   */
  async killSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // TEST MODE: Remove from memory only — NEVER touch real tmux sessions
    if (IS_TEST_MODE) {
      this.sessions.delete(sessionId);
      this.emit('sessionKilled', { sessionId });
      return true;
    }

    // SAFETY: Never kill the tmux session we're running inside of
    const currentMuxName = process.env.CLAUDEMAN_MUX_NAME;
    if (currentMuxName && session.muxName === currentMuxName) {
      console.error(`[TmuxManager] BLOCKED: Refusing to kill own tmux session: ${session.muxName}`);
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

    this.lastPaneCount.delete(session.muxName);
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
    // TEST MODE: Return all registered sessions as alive, never discover real ones
    if (IS_TEST_MODE) {
      return {
        alive: Array.from(this.sessions.keys()),
        dead: [],
        discovered: [],
      };
    }

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
    if (IS_TEST_MODE) return { memoryMB: 0, cpuPercent: 0, childCount: 0, updatedAt: Date.now() };

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
    if (IS_TEST_MODE) {
      return Array.from(this.sessions.values()).map(s => ({
        ...s,
        stats: { memoryMB: 0, cpuPercent: 0, childCount: 0, updatedAt: Date.now() },
      }));
    }

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

  /**
   * Start periodic mouse mode sync for all tracked sessions.
   * Polls pane counts every 5s and toggles mouse on/off as needed.
   * Polls every 5s. On pane count change, toggles mouse on (>1 pane) or off (1 pane).
   * If enableMouseMode/disableMouseMode fails, lastPaneCount is NOT updated so it retries next poll.
   */
  startMouseModeSync(intervalMs: number = 5000): void {
    if (this.mouseSyncInterval) {
      clearInterval(this.mouseSyncInterval);
    }

    this.mouseSyncInterval = setInterval(() => {
      if (IS_TEST_MODE) return;

      for (const session of this.sessions.values()) {
        const panes = this.listPanes(session.muxName);
        const count = panes.length;
        if (count === 0) continue;

        const prev = this.lastPaneCount.get(session.muxName);
        if (prev === count) continue;

        // Pane count changed — toggle mouse mode
        if (count > 1) {
          if (this.enableMouseMode(session.muxName)) {
            this.lastPaneCount.set(session.muxName, count);
          }
          // If enableMouseMode fails, DON'T update lastPaneCount — retry next poll
        } else {
          if (this.disableMouseMode(session.muxName)) {
            this.lastPaneCount.set(session.muxName, count);
          }
        }
      }
    }, intervalMs);
  }

  stopMouseModeSync(): void {
    if (this.mouseSyncInterval) {
      clearInterval(this.mouseSyncInterval);
      this.mouseSyncInterval = null;
    }
    this.lastPaneCount.clear();
  }

  destroy(): void {
    this.stopStatsCollection();
    this.stopMouseModeSync();
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
   * Uses tmux send-keys for reliable input delivery:
   * - `-l` flag sends literal text (no key interpretation)
   * - `Enter` key is sent as a SEPARATE tmux invocation after a small delay
   * - Ink (Claude CLI) needs text and Enter split to avoid treating Enter as a newline
   */
  async sendInput(sessionId: string, input: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[TmuxManager] sendInput failed: no session found for ${sessionId}. Known: ${Array.from(this.sessions.keys()).join(', ')}`);
      return false;
    }

    // TEST MODE: No-op — don't send input to real tmux sessions
    if (IS_TEST_MODE) {
      return true;
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
        // Send text first, then Enter as a SEPARATE tmux command after a short delay.
        // Ink (Claude CLI's terminal framework) needs them split — sending both in a
        // single tmux invocation (via \;) causes Ink to interpret Enter as a newline
        // character in the input buffer rather than as form submission.
        await execAsync(
          `tmux send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`,
          { timeout: EXEC_TIMEOUT_MS }
        );
        await new Promise(resolve => setTimeout(resolve, 50));
        await execAsync(
          `tmux send-keys -t "${session.muxName}" Enter`,
          { timeout: EXEC_TIMEOUT_MS }
        );
      } else if (textPart) {
        // Text only, no Enter
        await execAsync(
          `tmux send-keys -t "${session.muxName}" -l ${shellescape(textPart)}`,
          { timeout: EXEC_TIMEOUT_MS }
        );
      } else if (hasCarriageReturn) {
        // Enter only
        await execAsync(
          `tmux send-keys -t "${session.muxName}" Enter`,
          { timeout: EXEC_TIMEOUT_MS }
        );
      }

      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to send input:', err);
      return false;
    }
  }

  // ========== Pane Methods (for Agent Team teammate panes) ==========

  /**
   * Enable mouse mode for an existing tmux session.
   * Allows clicking to select panes in agent team split-pane layouts.
   * When mouse mode is on, tmux intercepts mouse events (slow selection, no browser copy).
   */
  enableMouseMode(muxName: string): boolean {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in enableMouseMode:', muxName);
      return false;
    }

    try {
      execSync(
        `tmux set-option -t "${muxName}" mouse on`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      );
      console.log(`[TmuxManager] Mouse mode ON for ${muxName}`);
      return true;
    } catch (err) {
      console.error(`[TmuxManager] Failed to enable mouse mode for ${muxName}:`, err);
      return false;
    }
  }

  /**
   * Disable mouse mode for an existing tmux session.
   * Restores native xterm.js text selection and browser clipboard copy.
   */
  disableMouseMode(muxName: string): boolean {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in disableMouseMode:', muxName);
      return false;
    }

    try {
      execSync(
        `tmux set-option -t "${muxName}" mouse off`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      );
      console.log(`[TmuxManager] Mouse mode OFF for ${muxName}`);
      return true;
    } catch (err) {
      console.error(`[TmuxManager] Failed to disable mouse mode for ${muxName}:`, err);
      return false;
    }
  }

  /**
   * Sync mouse mode based on pane count: enable if split (>1 pane), disable if single.
   * Called by TeamWatcher when teammates spawn/despawn panes.
   * Uses `tmux list-panes` for bulletproof detection — counts actual panes, not config.
   */
  syncMouseMode(muxName: string): boolean {
    if (IS_TEST_MODE) return true;
    const panes = this.listPanes(muxName);
    if (panes.length > 1) {
      return this.enableMouseMode(muxName);
    } else {
      return this.disableMouseMode(muxName);
    }
  }

  /**
   * List all panes in a tmux session.
   * Returns structured info for each pane.
   */
  listPanes(muxName: string): PaneInfo[] {
    if (IS_TEST_MODE) return [];
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in listPanes:', muxName);
      return [];
    }

    try {
      const output = execSync(
        `tmux list-panes -t "${muxName}" -F '#{pane_id}:#{pane_index}:#{pane_pid}:#{pane_width}:#{pane_height}'`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      ).trim();

      return output.split('\n').map(line => {
        const [paneId, indexStr, pidStr, widthStr, heightStr] = line.split(':');
        return {
          paneId,
          paneIndex: parseInt(indexStr, 10),
          panePid: parseInt(pidStr, 10),
          width: parseInt(widthStr, 10),
          height: parseInt(heightStr, 10),
        };
      }).filter(p => !Number.isNaN(p.paneIndex));
    } catch {
      return [];
    }
  }

  /**
   * Send input to a specific pane within a tmux session.
   * Uses the same literal text approach as sendInput() but targets a specific pane.
   */
  sendInputToPane(muxName: string, paneTarget: string, input: string): boolean {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in sendInputToPane:', muxName);
      return false;
    }
    if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
      console.error('[TmuxManager] Invalid pane target:', paneTarget);
      return false;
    }

    // Build target: sessionName.paneId (e.g., "claudeman-abc12345.%1")
    const target = paneTarget.startsWith('%')
      ? `${muxName}.${paneTarget}`
      : `${muxName}.%${paneTarget}`;

    try {
      const hasCarriageReturn = input.includes('\r');
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '').trimEnd();

      if (textPart && hasCarriageReturn) {
        execSync(
          `tmux send-keys -t ${shellescape(target)} -l ${shellescape(textPart)}`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
        execSync(
          `tmux send-keys -t ${shellescape(target)} Enter`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
      } else if (textPart) {
        execSync(
          `tmux send-keys -t ${shellescape(target)} -l ${shellescape(textPart)}`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
      } else if (hasCarriageReturn) {
        execSync(
          `tmux send-keys -t ${shellescape(target)} Enter`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        );
      }

      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to send input to pane:', err);
      return false;
    }
  }

  /**
   * Capture the current buffer of a specific pane.
   * Returns the pane content with ANSI escape codes preserved.
   */
  capturePaneBuffer(muxName: string, paneTarget: string): string | null {
    if (IS_TEST_MODE) return '';
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in capturePaneBuffer:', muxName);
      return null;
    }
    if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
      console.error('[TmuxManager] Invalid pane target:', paneTarget);
      return null;
    }

    const target = paneTarget.startsWith('%')
      ? `${muxName}.${paneTarget}`
      : `${muxName}.%${paneTarget}`;

    try {
      return execSync(
        `tmux capture-pane -p -e -t ${shellescape(target)} -S -5000`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      );
    } catch (err) {
      console.error('[TmuxManager] Failed to capture pane buffer:', err);
      return null;
    }
  }

  /**
   * Start piping pane output to a file using tmux pipe-pane.
   * Only pipes output direction (-O) to avoid echoing input.
   */
  startPipePane(muxName: string, paneTarget: string, outputFile: string): boolean {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in startPipePane:', muxName);
      return false;
    }
    if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
      console.error('[TmuxManager] Invalid pane target:', paneTarget);
      return false;
    }
    if (!isValidPath(outputFile)) {
      console.error('[TmuxManager] Invalid output file path:', outputFile);
      return false;
    }

    const target = paneTarget.startsWith('%')
      ? `${muxName}.${paneTarget}`
      : `${muxName}.%${paneTarget}`;

    try {
      execSync(
        `tmux pipe-pane -O -t ${shellescape(target)} ${shellescape('cat >> ' + outputFile)}`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      );
      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to start pipe-pane:', err);
      return false;
    }
  }

  /**
   * Stop piping pane output (calling pipe-pane with no command stops piping).
   */
  stopPipePane(muxName: string, paneTarget: string): boolean {
    if (IS_TEST_MODE) return true;
    if (!isValidMuxName(muxName)) {
      console.error('[TmuxManager] Invalid session name in stopPipePane:', muxName);
      return false;
    }
    if (!SAFE_PANE_TARGET_PATTERN.test(paneTarget)) {
      console.error('[TmuxManager] Invalid pane target:', paneTarget);
      return false;
    }

    const target = paneTarget.startsWith('%')
      ? `${muxName}.${paneTarget}`
      : `${muxName}.%${paneTarget}`;

    try {
      execSync(
        `tmux pipe-pane -t ${shellescape(target)}`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      );
      return true;
    } catch (err) {
      console.error('[TmuxManager] Failed to stop pipe-pane:', err);
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
