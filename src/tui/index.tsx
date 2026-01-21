/**
 * @fileoverview TUI entry point for Claudeman
 *
 * Entry point for the terminal user interface, providing a full-screen
 * session manager similar to the web interface but entirely in the terminal.
 *
 * @description
 * Built with Ink (React for CLI), the TUI offers:
 * - Session discovery from ~/.claudeman/screens.json
 * - Tab-based session navigation (like browser tabs)
 * - Real-time terminal output via screen hardcopy polling
 * - Ralph Wiggum loop tracking
 * - Respawn status monitoring
 *
 * @example
 * ```bash
 * # Start the TUI
 * claudeman tui
 * # Or via npm
 * npm run tui
 * ```
 *
 * @see {@link ./App.tsx} for main application component
 * @see {@link ./hooks/useSessionManager.ts} for state management
 */

import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

/**
 * Checks if the terminal supports raw mode input.
 *
 * @description
 * Raw mode is required for Ink to capture keyboard input directly.
 * This check fails when stdin is piped or redirected (e.g., `echo | claudeman tui`).
 *
 * @returns true if raw mode is available, false otherwise
 */
function isRawModeSupported(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    typeof process.stdin.setRawMode === 'function'
  );
}

/**
 * Starts the TUI application in the current terminal.
 *
 * @description
 * Initializes the Ink renderer and displays the TUI.
 * The terminal is cleared for a full-screen experience.
 * This function blocks until the user exits the TUI.
 *
 * @throws Exits with code 1 if TTY/raw mode is not supported
 * @returns Promise that resolves when the TUI exits
 */
export async function startTUI(): Promise<void> {
  // Check if we're in an interactive terminal
  if (!isRawModeSupported()) {
    console.error('Error: TUI requires an interactive terminal with TTY support.');
    console.error('Make sure you are running this command in a real terminal, not piped.');
    process.exit(1);
  }

  // Clear the terminal for full-screen experience
  process.stdout.write('\x1b[2J\x1b[H');

  const { waitUntilExit } = render(<App />);

  await waitUntilExit();
}
