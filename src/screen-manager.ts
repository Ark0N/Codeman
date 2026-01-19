import { EventEmitter } from 'node:events';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ScreenSession, ProcessStats, ScreenSessionWithStats } from './types.js';

const SCREENS_FILE = join(homedir(), '.claudeman', 'screens.json');

// Pre-compiled regex for screen list parsing
const SCREEN_PATTERN = /(\d+)\.(claudeman-([a-f0-9-]+))/g;

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

  // Save screens to disk
  private saveScreens(): void {
    try {
      const dir = dirname(SCREENS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.screens.values());
      writeFileSync(SCREENS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[ScreenManager] Failed to save screens:', err);
    }
  }

  // Create a new GNU screen session
  async createScreen(sessionId: string, workingDir: string, mode: 'claude' | 'shell', name?: string): Promise<ScreenSession> {
    const screenName = `claudeman-${sessionId.slice(0, 8)}`;

    // Create screen in detached mode with the appropriate command
    const cmd = mode === 'claude'
      ? 'claude --dangerously-skip-permissions'
      : '$SHELL';

    try {
      // Start screen in detached mode
      const screenProcess = spawn('screen', [
        '-dmS', screenName,
        '-c', '/dev/null', // Use empty config
        'bash', '-c', `cd "${workingDir}" && ${cmd}`
      ], {
        cwd: workingDir,
        detached: true,
        stdio: 'ignore'
      });

      screenProcess.unref();

      // Wait a moment for screen to start
      await new Promise(resolve => setTimeout(resolve, 500));

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
      throw new Error(`Failed to create screen: ${(err as Error).message}`);
    }
  }

  // Get screen session PID
  private getScreenPid(screenName: string): number | null {
    try {
      const output = execSync(`screen -ls | grep "${screenName}"`, {
        encoding: 'utf-8',
        timeout: 5000
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
        timeout: 5000
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

  // Kill a screen session and all its child processes
  async killScreen(sessionId: string): Promise<boolean> {
    const screen = this.screens.get(sessionId);
    if (!screen) {
      return false;
    }

    // Get current PID from screen -ls in case it changed
    const currentPid = this.getScreenPid(screen.screenName) || screen.pid;

    console.log(`[ScreenManager] Killing screen ${screen.screenName} (PID ${currentPid})`);

    // Strategy 1: Find and kill all child processes recursively
    const childPids = this.getChildPids(currentPid);
    if (childPids.length > 0) {
      console.log(`[ScreenManager] Found ${childPids.length} child processes to kill`);

      // Kill children in reverse order (deepest first) with SIGTERM
      for (const childPid of childPids.reverse()) {
        try {
          process.kill(childPid, 'SIGTERM');
        } catch {
          // Process may already be dead
        }
      }

      // Give processes a moment to terminate gracefully
      await new Promise(resolve => setTimeout(resolve, 200));

      // Force kill any remaining children
      for (const childPid of childPids) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Process already terminated
        }
      }
    }

    // Strategy 2: Kill the entire process group (catches any orphans we missed)
    try {
      process.kill(-currentPid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 100));
      process.kill(-currentPid, 'SIGKILL');
    } catch {
      // Process group may not exist or already terminated
    }

    // Strategy 3: Kill screen session by name
    try {
      execSync(`screen -S ${screen.screenName} -X quit`, {
        timeout: 5000
      });
    } catch {
      // Screen may already be dead
    }

    // Strategy 4: Direct kill by PID as final fallback
    try {
      process.kill(currentPid, 'SIGKILL');
    } catch {
      // Already dead
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
        timeout: 5000
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
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      const [rss, cpu] = psOutput.split(/\s+/).map(x => parseFloat(x) || 0);

      // Count child processes
      let childCount = 0;
      try {
        const childOutput = execSync(
          `pgrep -P ${screen.pid} | wc -l`,
          { encoding: 'utf-8', timeout: 5000 }
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
  async getScreensWithStats(): Promise<ScreenSessionWithStats[]> {
    const screens = Array.from(this.screens.values());
    if (screens.length === 0) {
      return [];
    }

    // Batch all PIDs into a single ps call for better performance
    const pids = screens.map(s => s.pid);
    const statsMap = new Map<number, ProcessStats>();

    try {
      // Single ps call for all PIDs
      const psOutput = execSync(
        `ps -o pid=,rss=,pcpu= -p ${pids.join(',')} 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      // Parse output - each line: "PID RSS CPU"
      for (const line of psOutput.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10);
          const rss = parseFloat(parts[1]) || 0;
          const cpu = parseFloat(parts[2]) || 0;
          if (!isNaN(pid)) {
            statsMap.set(pid, {
              memoryMB: Math.round(rss / 1024 * 10) / 10,
              cpuPercent: Math.round(cpu * 10) / 10,
              childCount: 0,
              updatedAt: Date.now()
            });
          }
        }
      }

      // Batch child count query - single pgrep call
      const pgrepOutput = execSync(
        `for p in ${pids.join(' ')}; do echo "$p $(pgrep -P $p 2>/dev/null | wc -l)"; done`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      for (const line of pgrepOutput.split('\n')) {
        const [pidStr, countStr] = line.trim().split(/\s+/);
        const pid = parseInt(pidStr, 10);
        const count = parseInt(countStr, 10) || 0;
        const stats = statsMap.get(pid);
        if (stats) {
          stats.childCount = count;
        }
      }
    } catch {
      // Fall back to individual queries if batch fails
      const statsPromises = screens.map(screen => this.getProcessStats(screen.sessionId));
      const allStats = await Promise.all(statsPromises);
      return screens.map((screen, i) => ({
        ...screen,
        stats: allStats[i] || undefined
      }));
    }

    // Combine screens with their stats
    return screens.map(screen => ({
      ...screen,
      stats: statsMap.get(screen.pid) || undefined
    }));
  }

  // Start periodic stats collection
  startStatsCollection(intervalMs: number = 2000): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    this.statsInterval = setInterval(async () => {
      const screensWithStats = await this.getScreensWithStats();
      this.emit('statsUpdated', screensWithStats);
    }, intervalMs);
  }

  // Stop stats collection
  stopStatsCollection(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
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

  // Check if screen is available on the system
  static isScreenAvailable(): boolean {
    try {
      execSync('which screen', { encoding: 'utf-8', timeout: 5000 });
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
      return false;
    }

    try {
      // Split input into text and control characters
      // IMPORTANT: Must send text and carriage return as SEPARATE commands
      // Sending them together doesn't work with Ink/Claude CLI
      const hasCarriageReturn = input.includes('\r');
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '');

      // Escape the text part for shell (double quotes)
      const escapedText = textPart.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');

      // Send text first (if any)
      if (escapedText) {
        const textCmd = `screen -S ${screen.screenName} -p 0 -X stuff "${escapedText}"`;
        execSync(textCmd, { encoding: 'utf-8', timeout: 5000 });
      }

      // Send carriage return separately (Enter key for Ink)
      if (hasCarriageReturn) {
        const crCmd = `screen -S ${screen.screenName} -p 0 -X stuff "$(printf '\\015')"`;
        execSync(crCmd, { encoding: 'utf-8', timeout: 5000 });
      }

      return true;
    } catch (err) {
      console.error('[ScreenManager] Failed to send input:', err);
      return false;
    }
  }
}
