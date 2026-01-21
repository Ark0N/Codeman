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
import { Box, useApp, useInput, useStdout } from 'ink';
import { StartScreen } from './components/StartScreen.js';
import { TabBar } from './components/TabBar.js';
import { TerminalView } from './components/TerminalView.js';
import { StatusBar } from './components/StatusBar.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { RalphPanel } from './components/RalphPanel.js';
import { useSessionManager } from './hooks/useSessionManager.js';
import type { ScreenSession } from '../types.js';

/**
 * Pending screen attachment request.
 * Used to communicate between App component and the entry point.
 */
export interface PendingAttach {
  mode: 'tabs' | 'direct';
  sessions: ScreenSession[];
  index: number;
  session?: ScreenSession;
}

// Module-level state for pending attachment (shared between App and entry point)
let pendingAttach: PendingAttach | null = null;

/**
 * Set a pending screen attachment request.
 * Called by App when user wants to attach to a screen.
 */
export function setPendingAttach(attach: PendingAttach): void {
  pendingAttach = attach;
}

/**
 * Get the current pending attachment request.
 * Called by entry point after App exits.
 */
export function getPendingAttach(): PendingAttach | null {
  return pendingAttach;
}

/**
 * Clear the pending attachment request.
 * Called by entry point after handling the attachment.
 */
export function clearPendingAttach(): void {
  pendingAttach = null;
}

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
    refreshCases,
    selectSession,
    createSession,
    createCase,
    killSession,
    killAllSessions,
    killAllScreensAndClaude,
    nextSession,
    prevSession,
    sendInput,
    terminalOutput,
    innerLoopState,
    innerTodos,
    respawnStatus,
    cases,
    lastUsedCase,
    toggleRespawn,
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
      if (key.escape || input === 'q') {
        setShowHelp(false);
      }
      return;
    }

    // Global shortcuts - use Ctrl+H for help (? is a normal character)
    if (key.ctrl && input === 'h') {
      setShowHelp(true);
      return;
    }

    // Exit on Ctrl+C
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Start screen specific inputs - handled by StartScreen component
    // Only number keys for quick session selection are handled here
    if (viewMode === 'start') {
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= sessions.length) {
        handleSelectSession(sessions[num - 1]);
        return;
      }
      return;
    }

    // === SESSION SWITCHING SHORTCUTS ===

    // Ctrl+Tab / Ctrl+Shift+Tab for session switching (if terminal supports it)
    // Plain Tab is sent to the session for auto-complete
    if (key.ctrl && key.tab) {
      if (key.shift) {
        prevSession();
      } else {
        nextSession();
      }
      return;
    }

    // Alt+Left/Right arrow keys for session switching
    if (key.meta && key.leftArrow) {
      prevSession();
      return;
    }
    if (key.meta && key.rightArrow) {
      nextSession();
      return;
    }

    // Ctrl+[ and Ctrl+] for previous/next session (vim-style, requires Ctrl)
    // Note: Ctrl+[ is often Escape, so this may not work on all terminals
    if (key.ctrl && input === '[') {
      prevSession();
      return;
    }
    if (key.ctrl && input === ']') {
      nextSession();
      return;
    }

    // Alt+1-9 or Ctrl+1-9 for direct tab access
    if (key.ctrl || key.meta) {
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= 9 && num <= sessions.length) {
        selectSession(sessions[num - 1].sessionId);
        return;
      }
    }

    // === SESSION MANAGEMENT SHORTCUTS ===

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

    // Ctrl+R to toggle respawn on active session
    if (key.ctrl && input === 'r') {
      if (activeSessionId && activeSession?.mode === 'claude') {
        toggleRespawn();
      }
      return;
    }

    // Escape to go back to start screen (doesn't close session)
    if (key.escape) {
      setViewMode('start');
      return;
    }

    // === FORWARD INPUT TO SESSION ===
    // Forward all other input to the active screen session
    if (activeSessionId) {
      // Handle special keys
      if (key.return) {
        sendInput(activeSessionId, '\r');
        return;
      }
      if (key.backspace || key.delete) {
        sendInput(activeSessionId, '\x7f');
        return;
      }
      // Tab key - send to session for auto-complete
      if (key.tab && !key.ctrl) {
        sendInput(activeSessionId, '\t');
        return;
      }
      // Arrow keys - send ANSI escape sequences
      if (key.upArrow) {
        sendInput(activeSessionId, '\x1b[A');
        return;
      }
      if (key.downArrow) {
        sendInput(activeSessionId, '\x1b[B');
        return;
      }
      if (key.rightArrow && !key.meta) {
        sendInput(activeSessionId, '\x1b[C');
        return;
      }
      if (key.leftArrow && !key.meta) {
        sendInput(activeSessionId, '\x1b[D');
        return;
      }
      // Ctrl+key combinations (send as control characters)
      if (key.ctrl && input) {
        // Convert to control character (Ctrl+A = 0x01, Ctrl+B = 0x02, etc.)
        const code = input.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) {
          sendInput(activeSessionId, String.fromCharCode(code));
          return;
        }
      }
      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        sendInput(activeSessionId, input);
        return;
      }
    }
  });

  /**
   * Select a session and enter direct attach mode with tab bar.
   * Sets pending attachment and exits Ink so the entry point can handle it.
   */
  const handleSelectSession = useCallback((session: ScreenSession) => {
    const sessionIndex = sessions.findIndex(s => s.sessionId === session.sessionId);
    if (sessionIndex === -1) return;

    // Set pending attachment and exit Ink
    // The entry point will handle the actual screen attachment
    setPendingAttach({
      mode: 'tabs',
      sessions: [...sessions], // Copy to avoid stale reference
      index: sessionIndex,
    });
    exit();
  }, [sessions, exit]);

  const handleCreateSession = useCallback(async (caseName?: string, count?: number, mode: 'claude' | 'shell' = 'claude') => {
    const sessionsToCreate = Math.min(Math.max(count || 1, 1), 20);
    let lastSessionId: string | null = null;

    // Create sessions sequentially
    for (let i = 0; i < sessionsToCreate; i++) {
      const sessionId = await createSession(caseName || 'default', mode);
      if (sessionId) {
        lastSessionId = sessionId;
        // Wait a moment for screen to be ready
        await new Promise(resolve => setTimeout(resolve, 500));
        refreshSessions();
      }
      if (i < sessionsToCreate - 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    // Refresh to get updated session list
    await new Promise(resolve => setTimeout(resolve, 200));
    refreshSessions();

    // Wait for state to update, then attach to the new session
    await new Promise(resolve => setTimeout(resolve, 300));

    if (lastSessionId) {
      // Re-fetch sessions to get the fresh list with the new session
      // We need to read the screens file directly since state may not have updated yet
      const { existsSync, readFileSync } = await import('fs');
      const { homedir } = await import('os');
      const { join } = await import('path');
      const screensFile = join(homedir(), '.claudeman', 'screens.json');

      let freshSessions: ScreenSession[] = [];
      try {
        if (existsSync(screensFile)) {
          freshSessions = JSON.parse(readFileSync(screensFile, 'utf-8'));
        }
      } catch {
        freshSessions = sessions;
      }

      if (freshSessions.length > 0) {
        const sessionIndex = freshSessions.findIndex(s => s.sessionId === lastSessionId);
        const targetIndex = sessionIndex >= 0 ? sessionIndex : freshSessions.length - 1;

        // Set pending attachment and exit Ink
        setPendingAttach({
          mode: 'tabs',
          sessions: freshSessions,
          index: targetIndex,
        });
        exit();
      }
    }
  }, [createSession, refreshSessions, sessions, exit]);

  /**
   * Attach directly to a screen session (skipping tab menu).
   * Sets pending attachment and exits Ink so the entry point can handle it.
   */
  const handleAttachSession = useCallback((session: ScreenSession) => {
    // Set pending attachment for direct mode and exit Ink
    setPendingAttach({
      mode: 'direct',
      sessions: [...sessions],
      index: sessions.findIndex(s => s.sessionId === session.sessionId),
      session: session,
    });
    exit();
  }, [sessions, exit]);

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
        cases={cases}
        lastUsedCase={lastUsedCase}
        onSelectSession={handleSelectSession}
        onAttachSession={handleAttachSession}
        onDeleteSession={handleDeleteSession}
        onDeleteAll={killAllScreensAndClaude}
        onCreateSession={handleCreateSession}
        onCreateCase={createCase}
        onRefresh={refreshSessions}
        onRefreshCases={refreshCases}
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
