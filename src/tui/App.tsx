/**
 * @fileoverview Main TUI App component
 *
 * The root component that manages the overall TUI layout and navigation.
 *
 * @description
 * Provides two primary views:
 * - **StartScreen**: Session discovery and selection interface
 * - **Main view**: Active session management with:
 *   - TabBar: Session tabs with switching
 *   - TerminalView: Live terminal output display
 *   - RalphPanel: Inner loop tracking (conditional)
 *   - StatusBar: Session info and keyboard hints
 *
 * Keyboard shortcuts are handled globally via Ink's useInput hook.
 *
 * @example
 * ```tsx
 * import { render } from 'ink';
 * import { App } from './App.js';
 *
 * render(<App />);
 * ```
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { execSync, spawnSync } from 'child_process';
import { StartScreen } from './components/StartScreen.js';
import { TabBar } from './components/TabBar.js';
import { TerminalView } from './components/TerminalView.js';
import { StatusBar } from './components/StatusBar.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { RalphPanel } from './components/RalphPanel.js';
import { useSessionManager } from './hooks/useSessionManager.js';
import type { ScreenSession } from '../types.js';

type ViewMode = 'start' | 'main';

/**
 * Main TUI application component.
 *
 * @description
 * Renders either the StartScreen or Main view based on current state.
 * Handles all global keyboard shortcuts and manages terminal dimensions.
 *
 * **Global Shortcuts:**
 * - `?` or `Ctrl+H`: Show help overlay
 * - `Ctrl+C`: Exit application
 * - `Ctrl+Tab/Shift+Tab`: Navigate sessions
 * - `Ctrl+1-9`: Direct session access
 * - `Ctrl+W`: Close current session
 * - `Ctrl+K`: Kill all sessions
 * - `Ctrl+N`: Create new session
 * - `Escape`: Return to start screen
 *
 * @returns The rendered TUI application
 */
export function App(): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [viewMode, setViewMode] = useState<ViewMode>('start');
  const [showHelp, setShowHelp] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(20);

  const {
    sessions,
    activeSessionId,
    activeSession,
    refreshSessions,
    selectSession,
    createSession,
    killSession,
    killAllSessions,
    nextSession,
    prevSession,
    sendInput,
    terminalOutput,
    innerLoopState,
    innerTodos,
    respawnStatus,
  } = useSessionManager();

  // Calculate terminal height based on stdout dimensions
  useEffect(() => {
    const updateHeight = () => {
      // Reserve: 3 for TabBar, 3 for StatusBar, 2 for borders
      const rows = stdout?.rows || 24;
      setTerminalHeight(Math.max(10, rows - 8));
    };
    updateHeight();

    stdout?.on('resize', updateHeight);
    return () => {
      stdout?.off('resize', updateHeight);
    };
  }, [stdout]);

  // Handle keyboard input
  useInput((input, key) => {
    // Help overlay takes priority
    if (showHelp) {
      if (key.escape || input === 'q' || input === '?') {
        setShowHelp(false);
      }
      return;
    }

    // Global shortcuts
    if (input === '?' || (key.ctrl && input === 'h')) {
      setShowHelp(true);
      return;
    }

    // Exit on Ctrl+C (with confirmation in main view)
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Start screen specific inputs
    if (viewMode === 'start') {
      if (input === 'q') {
        exit();
        return;
      }
      if (input === 'n') {
        handleCreateSession();
        return;
      }
      if (input === 'r') {
        refreshSessions();
        return;
      }
      // Number keys to select session
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= sessions.length) {
        handleSelectSession(sessions[num - 1]);
        return;
      }
      return;
    }

    // Main view shortcuts
    if (key.ctrl && key.tab) {
      if (key.shift) {
        prevSession();
      } else {
        nextSession();
      }
      return;
    }

    // Ctrl+1-9 for direct tab access
    if (key.ctrl) {
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= 9 && num <= sessions.length) {
        selectSession(sessions[num - 1].sessionId);
        return;
      }
    }

    // Ctrl+W to close current session
    if (key.ctrl && input === 'w') {
      if (activeSessionId) {
        killSession(activeSessionId);
        if (sessions.length <= 1) {
          setViewMode('start');
        }
      }
      return;
    }

    // Ctrl+K to kill all sessions
    if (key.ctrl && input === 'k') {
      killAllSessions();
      setViewMode('start');
      return;
    }

    // Ctrl+N for new session
    if (key.ctrl && input === 'n') {
      handleCreateSession();
      return;
    }

    // Escape to go back to start screen
    if (key.escape) {
      setViewMode('start');
      return;
    }

    // Forward other input to the active session
    if (activeSessionId && !key.ctrl && !key.meta) {
      if (key.return) {
        sendInput(activeSessionId, '\r');
      } else if (key.backspace || key.delete) {
        sendInput(activeSessionId, '\x7f');
      } else if (input) {
        sendInput(activeSessionId, input);
      }
    }
  });

  const handleSelectSession = useCallback((session: ScreenSession) => {
    selectSession(session.sessionId);
    setViewMode('main');
  }, [selectSession]);

  const handleCreateSession = useCallback(async () => {
    const sessionId = await createSession();
    if (sessionId) {
      setViewMode('main');
    }
  }, [createSession]);

  /**
   * Attach directly to a screen session
   * This exits the TUI and attaches to GNU screen
   */
  const handleAttachSession = useCallback((session: ScreenSession) => {
    // Clear screen and restore terminal
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(`Attaching to screen: ${session.screenName}`);
    console.log('Press Ctrl+A D to detach and return to terminal\n');

    // Use spawnSync to attach to screen (inherits stdio)
    const result = spawnSync('screen', ['-r', session.screenName], {
      stdio: 'inherit',
    });

    // After detaching, exit the TUI
    if (result.status === 0) {
      console.log('\nDetached from screen. Run "claudeman tui" to return.');
    }
    exit();
  }, [exit]);

  // Render help overlay if shown
  if (showHelp) {
    return <HelpOverlay onClose={() => setShowHelp(false)} />;
  }

  // Handle delete session from start screen
  const handleDeleteSession = useCallback((session: ScreenSession) => {
    killSession(session.sessionId);
  }, [killSession]);

  // Render start screen
  if (viewMode === 'start') {
    return (
      <StartScreen
        sessions={sessions}
        onSelectSession={handleSelectSession}
        onAttachSession={handleAttachSession}
        onDeleteSession={handleDeleteSession}
        onCreateSession={handleCreateSession}
        onRefresh={refreshSessions}
        onExit={exit}
      />
    );
  }

  // Check if Ralph panel should be visible (enabled and has data)
  const showRalphPanel = innerLoopState?.enabled && (innerLoopState.active || innerTodos.length > 0);

  // Adjust terminal height if Ralph panel is shown
  const adjustedTerminalHeight = showRalphPanel ? terminalHeight - 6 : terminalHeight;

  // Render main view with tabs, terminal, ralph panel, and status bar
  return (
    <Box flexDirection="column" height="100%">
      <TabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => selectSession(id)}
      />

      <TerminalView
        output={terminalOutput}
        height={adjustedTerminalHeight}
        session={activeSession}
      />

      {showRalphPanel && (
        <RalphPanel
          loopState={innerLoopState}
          todos={innerTodos}
        />
      )}

      <StatusBar session={activeSession} respawnStatus={respawnStatus} />
    </Box>
  );
}
