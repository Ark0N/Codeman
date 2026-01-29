/**
 * @fileoverview GNU Screen session manager for persistent Claude sessions.
 *
 * This module provides the ScreenManager class which creates and manages
 * GNU Screen sessions that wrap Claude CLI processes. Screen provides:
 *
 * - **Persistence**: Sessions survive server restarts and disconnects
 * - **Ghost recovery**: Orphaned screens are discovered and reattached on startup
 * - **Resource tracking**: Memory, CPU, and child process stats per session
 * - **Reliable input**: `screen -X stuff` bypasses PTY for programmatic commands
 *
 * Screen sessions are named `claudeman-{sessionId}` and stored in ~/.claudeman/screens.json.
 *
 * @module screen-manager
 */

import { EventEmitter } from 'node:events';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ScreenSession, ProcessStats, ScreenSessionWithStats, PersistedRespawnConfig, getErrorMessage, NiceConfig, DEFAULT_NICE_CONFIG } from './types.js';

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

/** Delay after screen creation (500ms) */
const SCREEN_CREATION_WAIT_MS = 500;

/** Delay after screen kill command (200ms) */
const SCREEN_KILL_WAIT_MS = 200;

/** Delay for graceful shutdown (100ms) */
const GRACEFUL_SHUTDOWN_WAIT_MS = 100;

/** Default stats collection interval (2 seconds) */
const DEFAULT_STATS_INTERVAL_MS = 2000;

/** Maximum retry attempts for carriage return (3) */
const CR_MAX_ATTEMPTS = 3;

/**
 * Wraps a command with `nice` for priority adjustment.
 */
export function wrapWithNice(cmd: string, config: NiceConfig): string {
  if (!config.enabled) return cmd;
  const niceValue = Math.max(-20, Math.min(19, config.niceValue));
  return `nice -n ${niceValue} ${cmd}`;
}


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

/** Path to persisted screen session metadata */
const SCREENS_FILE = join(homedir(), '.claudeman', 'screens.json');

/** Pre-compiled regex for parsing `screen -ls` output */
const SCREEN_PATTERN = /(\d+)\.(claudeman-([a-f0-9-]+))/g;

/** Regex to validate screen names (only allow safe characters) */
const SAFE_SCREEN_NAME_PATTERN = /^claudeman-[a-f0-9-]+$/;

/** Regex to validate working directory paths (no shell metacharacters) */
const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_\/\-. ~]+$/;

/**
 * Validates that a screen name contains only safe characters.
 * Prevents command injection via malformed session IDs.
 *
 * @param name - The screen name to validate
 * @returns true if the name is safe for use in shell commands
 */
function isValidScreenName(name: string): boolean {
  return SAFE_SCREEN_NAME_PATTERN.test(name);
}

/**
 * Validates that a path contains only safe characters.
 * Prevents command injection via malformed paths.
 *
 * @param path - The path to validate
 * @returns true if the path is safe for use in shell commands
 */
function isValidPath(path: string): boolean {
  // Check for shell metacharacters that could lead to injection
  if (path.includes(';') || path.includes('&') || path.includes('|') ||
      path.includes('$') || path.includes('`') || path.includes('(') ||
      path.includes(')') || path.includes('{') || path.includes('}') ||
      path.includes('<') || path.includes('>') || path.includes("'") ||
      path.includes('"') || path.includes('\n') || path.includes('\r')) {
    return false;
  }
  return SAFE_PATH_PATTERN.test(path);
}

/**
 * Escapes a string for safe use in shell double quotes.
 *
 * @param str - The string to escape
 * @returns The escaped string
 */
function shellEscape(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

/**
 * Manages GNU Screen sessions that wrap Claude CLI or shell processes.
 *
 * The ScreenManager maintains a registry of screen sessions, creates new ones,
 * kills them using a 4-strategy approach, and discovers orphaned "ghost" screens
 * from previous runs.
 *
 * @example
 * ```typescript
 * const manager = new ScreenManager();
 *
 * // Create a screen session for Claude
 * const screen = await manager.createScreen(sessionId, '/project', 'claude');
 *
 * // Send input to the screen
 * manager.sendInput(sessionId, '/clear\r');
 *
 * // Kill when done
 * await manager.killScreen(sessionId);
 * ```
 *
 * @fires ScreenManager#screenCreated - New screen session created
 * @fires ScreenManager#screenKilled - Screen session terminated
 */
export class ScreenManager extends EventEmitter {
  private screens: Map<string, ScreenSession> = new Map();
  private statsInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.loadScreens();
  }

  // Load saved screens from disk
  private loadScreens(): void {
    try {
      if (existsSync(SCREENS_FILE)) {
        const content = readFileSync(SCREENS_FILE, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          for (const screen of data) {
            this.screens.set(screen.sessionId, screen);
          }
        }
      }
    } catch (err) {
      console.error('[ScreenManager] Failed to load screens:', err);
    }
  }

  /**
   * Save screens to disk asynchronously.
   * Uses async write to avoid blocking the event loop.
   */
  private saveScreens(): void {
    try {
      const dir = dirname(SCREENS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.screens.values());
      const json = JSON.stringify(data, null, 2);

      // Async write to avoid blocking event loop
      writeFile(SCREENS_FILE, json, (err) => {
        if (err) {
          console.error('[ScreenManager] Failed to save screens:', err);
        }
      });
    } catch (err) {
      console.error('[ScreenManager] Failed to save screens:', err);
    }
  }

  /**
   * Creates a new GNU Screen session wrapping Claude CLI or a shell.
   *
   * The screen is created in detached mode and automatically starts the
   * appropriate command based on the mode parameter.
   *
   * @param sessionId - Unique session identifier (used in screen name)
   * @param workingDir - Working directory for the screen session
   * @param mode - 'claude' for Claude CLI or 'shell' for bash
   * @param name - Optional display name for the session
   * @param niceConfig - Optional nice priority configuration
   */
  async createScreen(sessionId: string, workingDir: string, mode: 'claude' | 'shell', name?: string, niceConfig?: NiceConfig): Promise<ScreenSession> {
    const screenName = `claudeman-${sessionId.slice(0, 8)}`;

    // Security: Validate screenName and workingDir to prevent command injection
    if (!isValidScreenName(screenName)) {
      throw new Error(`Invalid screen name: contains unsafe characters`);
    }
    if (!isValidPath(workingDir)) {
      throw new Error(`Invalid working directory path: contains unsafe characters`);
    }

    // Create screen in detached mode with the appropriate command
    // Set CLAUDEMAN_SCREEN=1 so Claude sessions know they're running in Claudeman
    // This helps prevent Claude from attempting to kill its own screen session
    const claudeDir = findClaudeDir();
    const pathExport = claudeDir ? `export PATH="${claudeDir}:$PATH" && ` : '';

    // Environment variables must be exported, not passed inline to nice
    // Using inline VAR=value before nice doesn't work correctly
    const envExports = [
      'export CLAUDEMAN_SCREEN=1',
      `export CLAUDEMAN_SESSION_ID=${sessionId}`,
      `export CLAUDEMAN_SCREEN_NAME=${screenName}`,
      `export CLAUDEMAN_API_URL=${process.env.CLAUDEMAN_API_URL || 'http://localhost:3000'}`,
    ].join(' && ');

    // Base command for the mode (just the executable, env vars are exported separately)
    // For Claude sessions: pass --session-id to use the SAME ID as the Claudeman session
    // This ensures subagents (discovered via file path) can be directly matched to the correct tab
    const baseCmd = mode === 'claude'
      ? `claude --dangerously-skip-permissions --session-id ${sessionId}`
      : '$SHELL';

    // Apply nice priority if configured
    const config = niceConfig || DEFAULT_NICE_CONFIG;
    const cmd = wrapWithNice(baseCmd, config);

    try {
      // Start screen in detached mode
      // Order: cd to dir, export PATH, export env vars, then run command
      const fullCmd = `cd "${workingDir}" && ${pathExport}${envExports} && ${cmd}`;

      const screenProcess = spawn('screen', [
        '-dmS', screenName,
        '-c', '/dev/null', // Use empty config
        'bash', '-c', fullCmd
      ], {
        cwd: workingDir,
        detached: true,
        stdio: 'ignore'
      });

      screenProcess.unref();

      // Wait a moment for screen to start
      await new Promise(resolve => setTimeout(resolve, SCREEN_CREATION_WAIT_MS));

      // Get the PID of the screen session
      const pid = this.getScreenPid(screenName);
      if (!pid) {
        throw new Error('Failed to get screen PID');
      }

      const screen: ScreenSession = {
        sessionId,
        screenName,
        pid,
        createdAt: Date.now(),
        workingDir,
        mode,
        attached: false,
        name
      };

      this.screens.set(sessionId, screen);
      this.saveScreens();
      this.emit('screenCreated', screen);

      return screen;
    } catch (err) {
      throw new Error(`Failed to create screen: ${getErrorMessage(err)}`);
    }
  }

  // Get screen session PID
  private getScreenPid(screenName: string): number | null {
    // Security: Validate screenName to prevent command injection
    if (!isValidScreenName(screenName)) {
      console.error('[ScreenManager] Invalid screen name in getScreenPid:', screenName);
      return null;
    }

    try {
      // Use shell-escaped screenName in grep
      const escapedName = shellEscape(screenName);
      const output = execSync(`screen -ls | grep "${escapedName}"`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS
      });
      // Output format: "12345.claudeman-abc12345	(Detached)"
      const match = output.match(/(\d+)\./);
      return match ? parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  // Get all child process PIDs recursively
  private getChildPids(pid: number): number[] {
    const pids: number[] = [];
    try {
      const output = execSync(`pgrep -P ${pid}`, {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS
      }).trim();
      if (output) {
        for (const childPid of output.split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p))) {
          pids.push(childPid);
          // Recursively get grandchildren
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
      // signal 0 doesn't kill, just checks if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Verify all PIDs are dead, with retry
  private async verifyProcessesDead(pids: number[], maxWaitMs: number = 1000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 50;

    while (Date.now() - startTime < maxWaitMs) {
      const aliveCount = pids.filter(pid => this.isProcessAlive(pid)).length;
      if (aliveCount === 0) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Log any processes that are still alive
    const stillAlive = pids.filter(pid => this.isProcessAlive(pid));
    if (stillAlive.length > 0) {
      console.warn(`[ScreenManager] ${stillAlive.length} processes still alive after kill: ${stillAlive.join(', ')}`);
    }
    return stillAlive.length === 0;
  }

  // Kill a screen session and all its child processes
  async killScreen(sessionId: string): Promise<boolean> {
    const screen = this.screens.get(sessionId);
    if (!screen) {
      return false;
    }

    // Get current PID from screen -ls in case it changed
    const currentPid = this.getScreenPid(screen.screenName) || screen.pid;

    console.log(`[ScreenManager] Killing screen ${screen.screenName} (PID ${currentPid})`);

    // Collect all PIDs to track (for verification)
    const allPids: number[] = [currentPid];

    // Strategy 1: Find and kill all child processes recursively
    // Re-check for children before each kill attempt (they may have changed)
    let childPids = this.getChildPids(currentPid);
    if (childPids.length > 0) {
      console.log(`[ScreenManager] Found ${childPids.length} child processes to kill`);
      allPids.push(...childPids);

      // Kill children in reverse order (deepest first) with SIGTERM
      for (const childPid of [...childPids].reverse()) {
        if (this.isProcessAlive(childPid)) {
          try {
            process.kill(childPid, 'SIGTERM');
          } catch {
            // Process may already be dead
          }
        }
      }

      // Give processes a moment to terminate gracefully
      await new Promise(resolve => setTimeout(resolve, SCREEN_KILL_WAIT_MS));

      // Re-check which children are still alive and force kill them
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

    // Strategy 2: Kill the entire process group (catches any orphans we missed)
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

    // Strategy 3: Kill screen session by name
    try {
      execSync(`screen -S ${screen.screenName} -X quit`, {
        timeout: EXEC_TIMEOUT_MS
      });
    } catch {
      // Screen may already be dead
    }

    // Strategy 4: Direct kill by PID as final fallback
    if (this.isProcessAlive(currentPid)) {
      try {
        process.kill(currentPid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }

    // Verify all processes are dead (with timeout)
    const allDead = await this.verifyProcessesDead(allPids, 2000);
    if (!allDead) {
      console.error(`[ScreenManager] Warning: Some processes may still be alive for screen ${screen.screenName}`);
    }

    this.screens.delete(sessionId);
    this.saveScreens();
    this.emit('screenKilled', { sessionId });

    return true;
  }

  // Get all tracked screens
  getScreens(): ScreenSession[] {
    return Array.from(this.screens.values());
  }

  // Get screen by session ID
  getScreen(sessionId: string): ScreenSession | undefined {
    return this.screens.get(sessionId);
  }

  // Update screen display name
  updateScreenName(sessionId: string, name: string): boolean {
    const screen = this.screens.get(sessionId);
    if (!screen) {
      return false;
    }
    screen.name = name;
    this.saveScreens();
    return true;
  }

  // Reconcile screens - find orphaned/dead screens AND discover unknown claudeman screens
  async reconcileScreens(): Promise<{ alive: string[]; dead: string[]; discovered: string[] }> {
    const alive: string[] = [];
    const dead: string[] = [];
    const discovered: string[] = [];

    // First, check known screens
    for (const [sessionId, screen] of this.screens) {
      const pid = this.getScreenPid(screen.screenName);
      if (pid) {
        alive.push(sessionId);
        // Update PID if it changed
        if (pid !== screen.pid) {
          screen.pid = pid;
        }
      } else {
        dead.push(sessionId);
        this.screens.delete(sessionId);
        this.emit('screenDied', { sessionId });
      }
    }

    // Second, discover unknown claudeman screens (prevents ghost screens)
    try {
      const output = execSync('screen -ls 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS
      });
      // Match: "12345.claudeman-abc12345   (Detached)" or similar
      // Reset lastIndex since we're reusing the global regex
      SCREEN_PATTERN.lastIndex = 0;
      let match;
      while ((match = SCREEN_PATTERN.exec(output)) !== null) {
        const pid = parseInt(match[1], 10);
        const screenName = match[2];
        const sessionIdFragment = match[3];

        // Check if this screen is already known
        let isKnown = false;
        for (const screen of this.screens.values()) {
          if (screen.screenName === screenName) {
            isKnown = true;
            break;
          }
        }

        if (!isKnown) {
          // Discovered an unknown claudeman screen - adopt it
          const sessionId = `restored-${sessionIdFragment}`;
          const screen: ScreenSession = {
            sessionId,
            screenName,
            pid,
            createdAt: Date.now(),
            workingDir: process.cwd(), // Unknown, use current dir
            mode: 'claude', // Assume claude mode
            attached: false,
            name: `Restored: ${screenName}`
          };
          this.screens.set(sessionId, screen);
          discovered.push(sessionId);
          console.log(`[ScreenManager] Discovered unknown screen: ${screenName} (PID ${pid})`);
        }
      }
    } catch (err) {
      console.error('[ScreenManager] Failed to discover screens:', err);
    }

    if (dead.length > 0 || discovered.length > 0) {
      this.saveScreens();
    }

    return { alive, dead, discovered };
  }

  // Get process stats for a screen
  async getProcessStats(sessionId: string): Promise<ProcessStats | null> {
    const screen = this.screens.get(sessionId);
    if (!screen) {
      return null;
    }

    try {
      // Get memory and CPU usage using ps
      const psOutput = execSync(
        `ps -o rss=,pcpu= -p ${screen.pid} 2>/dev/null || echo "0 0"`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      ).trim();

      const [rss, cpu] = psOutput.split(/\s+/).map(x => parseFloat(x) || 0);

      // Count child processes
      let childCount = 0;
      try {
        const childOutput = execSync(
          `pgrep -P ${screen.pid} | wc -l`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        ).trim();
        childCount = parseInt(childOutput, 10) || 0;
      } catch {
        // No children or command failed
      }

      return {
        memoryMB: Math.round(rss / 1024 * 10) / 10, // KB to MB
        cpuPercent: Math.round(cpu * 10) / 10,
        childCount,
        updatedAt: Date.now()
      };
    } catch {
      return null;
    }
  }

  // Get all screens with stats (batched for better performance)
  // Now includes child process stats (the actual claude processes inside screens)
  async getScreensWithStats(): Promise<ScreenSessionWithStats[]> {
    const screens = Array.from(this.screens.values());
    if (screens.length === 0) {
      return [];
    }

    const screenPids = screens.map(s => s.pid);
    const statsMap = new Map<number, ProcessStats>();

    try {
      // Step 1: Get all descendant PIDs for each screen process
      // This captures the claude process and any children it spawns
      const descendantMap = new Map<number, number[]>(); // screenPid -> [childPids]

      // Use pgrep to get all descendants recursively for each screen
      const pgrepOutput = execSync(
        `for p in ${screenPids.join(' ')}; do children=$(pgrep -P $p 2>/dev/null | tr '\\n' ','); echo "$p:$children"; done`,
        { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
      ).trim();

      for (const line of pgrepOutput.split('\n')) {
        const [pidStr, childrenStr] = line.split(':');
        const screenPid = parseInt(pidStr, 10);
        if (!isNaN(screenPid)) {
          const children = (childrenStr || '')
            .split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !isNaN(n) && n > 0);
          descendantMap.set(screenPid, children);
        }
      }

      // Step 2: Collect all PIDs we need stats for (screens + all their children)
      const allPids = new Set<number>(screenPids);
      for (const children of descendantMap.values()) {
        for (const child of children) {
          allPids.add(child);
        }
      }

      // Step 3: Single ps call for ALL PIDs (screens + children)
      const pidArray = Array.from(allPids);
      if (pidArray.length > 0) {
        const psOutput = execSync(
          `ps -o pid=,rss=,pcpu= -p ${pidArray.join(',')} 2>/dev/null || true`,
          { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
        ).trim();

        // Parse individual process stats
        const processStats = new Map<number, { rss: number; cpu: number }>();
        for (const line of psOutput.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const pid = parseInt(parts[0], 10);
            const rss = parseFloat(parts[1]) || 0;
            const cpu = parseFloat(parts[2]) || 0;
            if (!isNaN(pid)) {
              processStats.set(pid, { rss, cpu });
            }
          }
        }

        // Step 4: Aggregate stats for each screen (screen + all descendants)
        for (const screenPid of screenPids) {
          const children = descendantMap.get(screenPid) || [];
          const screenStats = processStats.get(screenPid) || { rss: 0, cpu: 0 };

          // Sum up stats from all children
          let totalRss = screenStats.rss;
          let totalCpu = screenStats.cpu;

          for (const childPid of children) {
            const childStats = processStats.get(childPid);
            if (childStats) {
              totalRss += childStats.rss;
              totalCpu += childStats.cpu;
            }
          }

          statsMap.set(screenPid, {
            memoryMB: Math.round(totalRss / 1024 * 10) / 10,
            cpuPercent: Math.round(totalCpu * 10) / 10,
            childCount: children.length,
            updatedAt: Date.now()
          });
        }
      }
    } catch {
      // Fall back to individual queries if batch fails
      const statsPromises = screens.map(screen => this.getProcessStats(screen.sessionId));
      const results = await Promise.allSettled(statsPromises);
      return screens.map((screen, i) => ({
        ...screen,
        stats: results[i].status === 'fulfilled' ? (results[i].value ?? undefined) : undefined
      }));
    }

    // Combine screens with their stats
    return screens.map(screen => ({
      ...screen,
      stats: statsMap.get(screen.pid) || undefined
    }));
  }

  // Start periodic stats collection
  startStatsCollection(intervalMs: number = DEFAULT_STATS_INTERVAL_MS): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    this.statsInterval = setInterval(async () => {
      try {
        const screensWithStats = await this.getScreensWithStats();
        this.emit('statsUpdated', screensWithStats);
      } catch (err) {
        // Log but don't crash - stats collection is non-critical
        console.error('[ScreenManager] Stats collection error:', err);
      }
    }, intervalMs);
  }

  // Stop stats collection
  stopStatsCollection(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /**
   * Clean up resources.
   * Call this on server shutdown.
   */
  destroy(): void {
    this.stopStatsCollection();
  }

  // Register a session as using screen (for when session creates its own screen)
  registerScreen(screen: ScreenSession): void {
    this.screens.set(screen.sessionId, screen);
    this.saveScreens();
  }

  // Mark screen as attached/detached
  setAttached(sessionId: string, attached: boolean): void {
    const screen = this.screens.get(sessionId);
    if (screen) {
      screen.attached = attached;
      this.saveScreens();
    }
  }

  // Update respawn config for a screen session (persisted across restarts)
  updateRespawnConfig(sessionId: string, config: PersistedRespawnConfig | undefined): void {
    const screen = this.screens.get(sessionId);
    if (screen) {
      screen.respawnConfig = config;
      this.saveScreens();
    }
  }

  // Clear respawn config when respawn is stopped
  clearRespawnConfig(sessionId: string): void {
    const screen = this.screens.get(sessionId);
    if (screen && screen.respawnConfig) {
      delete screen.respawnConfig;
      this.saveScreens();
    }
  }

  // Update Ralph enabled state
  updateRalphEnabled(sessionId: string, enabled: boolean): void {
    const screen = this.screens.get(sessionId);
    if (screen) {
      screen.ralphEnabled = enabled;
      this.saveScreens();
    }
  }

  // Check if screen is available on the system
  static isScreenAvailable(): boolean {
    try {
      execSync('which screen', { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  // Send input directly to screen session using screen -X stuff
  // This bypasses the attached PTY and sends input directly to the screen
  sendInput(sessionId: string, input: string): boolean {
    const screen = this.screens.get(sessionId);
    if (!screen) {
      console.error(`[ScreenManager] sendInput failed: no screen found for session ${sessionId}. Known screens: ${Array.from(this.screens.keys()).join(', ')}`);
      return false;
    }

    console.log(`[ScreenManager] sendInput to ${screen.screenName}, input length: ${input.length}, hasCarriageReturn: ${input.includes('\r')}`);

    // Security: Validate screenName to prevent command injection
    if (!isValidScreenName(screen.screenName)) {
      console.error('[ScreenManager] Invalid screen name in sendInput:', screen.screenName);
      return false;
    }

    try {
      // Split input into text and control characters
      // IMPORTANT: Must send text and carriage return as SEPARATE commands
      // Sending them together doesn't work with Ink/Claude CLI
      const hasCarriageReturn = input.includes('\r');
      // Remove control characters and trim trailing whitespace to avoid spurious spaces
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '').trimEnd();

      // Escape the text part for shell using the helper function
      const escapedText = shellEscape(textPart);

      // Send text first (if any)
      if (escapedText) {
        const textCmd = `screen -S ${screen.screenName} -p 0 -X stuff "${escapedText}"`;
        execSync(textCmd, { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
      }

      // Send carriage return separately (Enter key for Ink)
      // Use a synchronous sleep to ensure screen processes the text first
      if (hasCarriageReturn) {
        // Delay to let screen process the text before sending Enter
        // This prevents race conditions where Enter arrives before the text is processed
        // 100ms is needed for reliability - screen's internal buffering can be slow
        if (escapedText) {
          execSync('sleep 0.1', { timeout: 1000 });
        }

        const crCmd = `screen -S ${screen.screenName} -p 0 -X stuff "$(printf '\\015')"`;

        // Try up to CR_MAX_ATTEMPTS times with increasing delays
        let success = false;
        for (let attempt = 1; attempt <= CR_MAX_ATTEMPTS && !success; attempt++) {
          try {
            execSync(crCmd, { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
            success = true;
          } catch (crErr) {
            console.warn(`[ScreenManager] Carriage return attempt ${attempt}/${CR_MAX_ATTEMPTS} failed`);
            if (attempt < CR_MAX_ATTEMPTS) {
              execSync(`sleep 0.${attempt}`, { timeout: 1000 }); // 0.1s, 0.2s delays
            }
          }
        }

        if (!success) {
          console.error('[ScreenManager] All carriage return attempts failed');
          return false;
        }
      }

      return true;
    } catch (err) {
      console.error('[ScreenManager] Failed to send input:', err);
      return false;
    }
  }
}
