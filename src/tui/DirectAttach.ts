/**
 * @fileoverview Direct screen attachment with tab switching
 *
 * Provides direct full-screen console access to screen sessions.
 * Tab menu shown between sessions for switching.
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import type { ScreenSession } from '../types.js';

// ANSI escape codes
const ESC = '\x1b';
const CSI = `${ESC}[`;

const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const BG_BLUE = `${CSI}44m`;
const FG_WHITE = `${CSI}37m`;
const FG_CYAN = `${CSI}36m`;
const FG_YELLOW = `${CSI}33m`;

/** Pre-compiled regex for parsing `screen -ls` output */
const SCREEN_PATTERN = /(\d+)\.(claudeman-[a-f0-9-]+)/g;

/**
 * Get full screen identifier (PID.screenName) from screen -ls output.
 * This is needed because `screen -x screenName` can fail when multiple
 * screens exist, but `screen -x PID.screenName` is unambiguous.
 *
 * @param screenName - The screen name without PID (e.g., "claudeman-abc123")
 * @returns The full screen ID (e.g., "12345.claudeman-abc123") or null if not found
 */
export function getFullScreenId(screenName: string): string | null {
  try {
    const output = execSync('screen -ls', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    // Reset lastIndex before using global regex
    SCREEN_PATTERN.lastIndex = 0;

    let match;
    while ((match = SCREEN_PATTERN.exec(output)) !== null) {
      if (match[2] === screenName) {
        return `${match[1]}.${match[2]}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a screen session is alive
 */
function isScreenAlive(screenName: string): boolean {
  return getFullScreenId(screenName) !== null;
}

/**
 * Clear screen and move cursor to top-left
 */
function clearScreen(): void {
  process.stdout.write(`${CSI}2J${CSI}H`);
}

/**
 * Move cursor to position (1-indexed)
 */
function moveTo(row: number, col: number): void {
  process.stdout.write(`${CSI}${row};${col}H`);
}

/**
 * Get terminal dimensions
 */
function getTerminalSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

/**
 * Read a single keypress synchronously
 */
function readKeySync(): string {
  const buffer = Buffer.alloc(3);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  try {
    const bytesRead = fs.readSync(process.stdin.fd, buffer, 0, 3, null);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return '\r';
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }
}

/**
 * Show tab selection menu
 */
function showTabMenu(
  sessions: ScreenSession[],
  currentIndex: number
): number | null {
  const { cols } = getTerminalSize();

  clearScreen();

  // Header
  moveTo(1, 1);
  process.stdout.write(`${BG_BLUE}${FG_WHITE}${BOLD}`);
  process.stdout.write(' Switch Session '.padEnd(cols, ' '));
  process.stdout.write(RESET);

  // Session list
  moveTo(3, 1);
  process.stdout.write(`${FG_YELLOW}Select session (1-${sessions.length}), Enter for current, q to quit:${RESET}\n\n`);

  sessions.forEach((session, i) => {
    const isActive = i === currentIndex;
    const prefix = isActive ? `${FG_CYAN}> ` : '  ';
    const name = session.name || session.screenName.replace('claudeman-', '');
    const mode = session.mode === 'shell' ? ' [shell]' : '';
    const alive = isScreenAlive(session.screenName);
    const status = alive ? `${FG_CYAN}alive${RESET}` : `${DIM}dead${RESET}`;

    process.stdout.write(`${prefix}${i + 1}. ${name}${mode} (${status})${RESET}\n`);
  });

  process.stdout.write(`\n${DIM}Ctrl+A D to detach and return here${RESET}\n`);

  // Read keypress
  const input = readKeySync();

  if (input === 'q' || input === '\x1b') {
    return null;
  }

  if (input === '\r' || input === '\n') {
    return currentIndex;
  }

  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1 && num <= sessions.length) {
    return num - 1;
  }

  return currentIndex;
}

/**
 * Attach to screen sessions with tab switching between detaches.
 *
 * Flow:
 * 1. If single session, attach directly (skip tab menu)
 * 2. Show tab menu to select session (if multiple)
 * 3. Full-screen attach to selected session
 * 4. On detach (Ctrl+A D), show tab menu again
 * 5. Repeat until user presses 'q' to return to TUI
 */
export function attachWithTabs(
  sessions: ScreenSession[],
  initialIndex: number,
  onExit: () => void
): void {
  if (sessions.length === 0) {
    onExit();
    return;
  }

  let currentIndex = Math.min(initialIndex, sessions.length - 1);

  const runAttachLoop = (): void => {
    const session = sessions[currentIndex];

    // Get full screen ID (PID.screenName) for unambiguous attachment
    const fullScreenId = session ? getFullScreenId(session.screenName) : null;

    if (!session || !fullScreenId) {
      // Session dead, show menu to pick another (or exit if only one)
      if (sessions.length === 1) {
        clearScreen();
        onExit();
        return;
      }
      const newIndex = showTabMenu(sessions, currentIndex);
      if (newIndex === null) {
        clearScreen();
        onExit();
        return;
      }
      currentIndex = newIndex;
      runAttachLoop();
      return;
    }

    // Clear and attach directly - full screen
    clearScreen();

    // Spawn screen with full ID (PID.screenName) to avoid ambiguity when multiple screens exist
    const result = spawnSync('screen', ['-x', '-A', fullScreenId], {
      stdio: 'inherit',
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
      },
    });

    // If screen failed to attach, show error briefly
    if (result.status !== 0 && result.status !== null) {
      process.stdout.write(`\n${FG_YELLOW}Screen exited with code ${result.status}${RESET}\n`);
      process.stdout.write(`${DIM}Press any key to continue...${RESET}`);
      readKeySync();
    }

    // After detach, show tab menu (or exit if only one session)
    if (sessions.length === 1) {
      clearScreen();
      onExit();
      return;
    }

    const newIndex = showTabMenu(sessions, currentIndex);
    if (newIndex === null) {
      clearScreen();
      onExit();
      return;
    }

    currentIndex = newIndex;
    runAttachLoop();
  };

  // For single session, skip tab menu and attach directly
  if (sessions.length === 1) {
    runAttachLoop();
    return;
  }

  // Start with tab menu so user sees available sessions
  const initialSelection = showTabMenu(sessions, currentIndex);
  if (initialSelection === null) {
    clearScreen();
    onExit();
    return;
  }

  currentIndex = initialSelection;
  runAttachLoop();
}
