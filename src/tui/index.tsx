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
 * - Auto-detection and startup of web server if not running
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

import { render } from 'ink';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
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
 * Checks if the Claudeman web server is running.
 *
 * @param port - Port to check (default 3000)
 * @returns Promise that resolves to true if server is running
 */
async function isWebServerRunning(port: number = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`http://localhost:${port}/api/status`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Prompts the user with a yes/no question.
 *
 * @param question - The question to ask
 * @returns Promise that resolves to true for yes, false for no
 */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} [Y/n] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Starts the Claudeman web server in the background.
 *
 * @param port - Port to run on (default 3000)
 * @returns true if server started successfully
 */
function startWebServerInBackground(port: number = 3000): boolean {
  try {
    // Find the current script's directory to locate the web server entry
    const child = spawn('node', [
      '--import', 'tsx/esm',
      `${process.cwd()}/src/index.ts`,
      'web',
      '-p', String(port),
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    });

    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * TUI startup options.
 */
interface TUIOptions {
  /** Auto-start web server without prompting if not running */
  autoStartWeb?: boolean;
  /** Skip web server check entirely */
  skipWebCheck?: boolean;
  /** Web server port */
  port?: number;
}

/**
 * Starts the TUI application in the current terminal.
 *
 * @description
 * Initializes the Ink renderer and displays the TUI.
 * The terminal is cleared for a full-screen experience.
 * This function blocks until the user exits the TUI.
 *
 * Before starting, checks if the web server is running and offers to start it
 * in the background if not (unless skipWebCheck is true).
 *
 * @param options - TUI startup options
 * @throws Exits with code 1 if TTY/raw mode is not supported
 * @returns Promise that resolves when the TUI exits
 */
export async function startTUI(options: TUIOptions = {}): Promise<void> {
  const { autoStartWeb = false, skipWebCheck = false, port = 3000 } = options;

  // Check if we're in an interactive terminal
  if (!isRawModeSupported()) {
    console.error('Error: TUI requires an interactive terminal with TTY support.');
    console.error('Make sure you are running this command in a real terminal, not piped.');
    process.exit(1);
  }

  // Check if web server is running (unless skipped)
  if (!skipWebCheck) {
    const serverRunning = await isWebServerRunning(port);

    if (!serverRunning) {
      console.log('\x1b[33mClaudeman web server is not running.\x1b[0m');
      console.log('The TUI requires the web server to create and manage sessions.\n');

      let startServer = autoStartWeb;

      if (!autoStartWeb) {
        startServer = await promptYesNo('Would you like to start the web server in the background?');
      }

      if (startServer) {
        console.log(`\x1b[32mStarting web server on port ${port}...\x1b[0m`);
        const success = startWebServerInBackground(port);

        if (success) {
          // Wait a moment for the server to start
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Verify it started
          const nowRunning = await isWebServerRunning(port);
          if (nowRunning) {
            console.log('\x1b[32mWeb server started successfully!\x1b[0m\n');
          } else {
            console.log('\x1b[33mServer may still be starting... continuing with TUI.\x1b[0m');
            console.log('If you have issues, try running "claudeman web" in a separate terminal.\n');
          }
        } else {
          console.log('\x1b[31mFailed to start web server.\x1b[0m');
          console.log('Please run "claudeman web" in a separate terminal first.\n');
        }
      } else {
        console.log('\nYou can start the web server anytime with: claudeman web');
        console.log('Some TUI features may not work without the web server.\n');
      }

      // Brief pause before clearing screen
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Clear the terminal for full-screen experience
  process.stdout.write('\x1b[2J\x1b[H');

  const { waitUntilExit, unmount } = render(<App />);

  // Handle graceful exit on SIGINT/SIGTERM
  const cleanup = () => {
    unmount();
    // Restore terminal state
    process.stdout.write('\x1b[?25h'); // Show cursor
    process.stdout.write('\x1b[2J\x1b[H'); // Clear screen
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await waitUntilExit();
  } finally {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
    cleanup();
  }
}
