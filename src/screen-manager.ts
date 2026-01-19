import { EventEmitter } from 'node:events';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ScreenSession, ProcessStats, ScreenSessionWithStats } from './types.js';

const SCREENS_FILE = join(homedir(), '.claudeman', 'screens.json');

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

    // First, find and kill ALL child processes of the screen session
    // This prevents orphaned claude processes when screen quits
    const childPids = this.getChildPids(screen.pid);
    console.log(`[ScreenManager] Killing screen ${screen.screenName} (PID ${screen.pid}) and ${childPids.length} child processes`);

    // Kill children in reverse order (deepest first) with SIGTERM then SIGKILL
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

    // Now kill the screen session itself
    try {
      // Kill screen session by name
      execSync(`screen -S ${screen.screenName} -X quit`, {
        timeout: 5000
      });
    } catch {
      // Try killing by PID if name-based kill failed
      try {
        process.kill(screen.pid, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 100));
        process.kill(screen.pid, 'SIGKILL');
      } catch {
        // Already dead
      }
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

  // Reconcile screens - find orphaned/dead screens
  async reconcileScreens(): Promise<{ alive: string[]; dead: string[] }> {
    const alive: string[] = [];
    const dead: string[] = [];

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

    if (dead.length > 0) {
      this.saveScreens();
    }

    return { alive, dead };
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

  // Get all screens with stats (parallel for better performance)
  async getScreensWithStats(): Promise<ScreenSessionWithStats[]> {
    const screens = Array.from(this.screens.values());

    // Fetch all stats in parallel
    const statsPromises = screens.map(screen => this.getProcessStats(screen.sessionId));
    const allStats = await Promise.all(statsPromises);

    // Combine screens with their stats
    return screens.map((screen, i) => ({
      ...screen,
      stats: allStats[i] || undefined
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
}
