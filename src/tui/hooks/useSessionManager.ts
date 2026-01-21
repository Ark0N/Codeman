/**
 * @fileoverview useSessionManager hook
 *
 * Core state management hook for the TUI application.
 *
 * @description
 * This hook provides a complete interface for managing Claude sessions:
 * - Session discovery from ~/.claudeman/screens.json
 * - Terminal output polling via GNU screen hardcopy
 * - Inner loop state tracking for Ralph Wiggum loops
 * - Respawn status monitoring via the Claudeman API
 *
 * @example
 * ```tsx
 * const {
 *   sessions,
 *   activeSession,
 *   terminalOutput,
 *   selectSession,
 *   createSession,
 *   sendInput,
 * } = useSessionManager();
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { existsSync, readFileSync, writeFileSync, watchFile, unwatchFile, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import type { ScreenSession, InnerLoopState, InnerTodoItem, InnerSessionState } from '../../types.js';

const SCREENS_FILE = join(homedir(), '.claudeman', 'screens.json');
const INNER_STATE_FILE = join(homedir(), '.claudeman', 'state-inner.json');
const OUTPUT_POLL_INTERVAL = 500; // Poll terminal output every 500ms

interface RespawnStatus {
  enabled: boolean;
  state: string;
  cycleCount: number;
}

interface SessionManagerState {
  sessions: ScreenSession[];
  activeSessionId: string | null;
  activeSession: ScreenSession | null;
  terminalOutput: string;
  innerLoopState: InnerLoopState | null;
  innerTodos: InnerTodoItem[];
  respawnStatus: RespawnStatus | null;
  refreshSessions: () => void;
  selectSession: (sessionId: string) => void;
  createSession: () => Promise<string | null>;
  killSession: (sessionId: string) => void;
  killAllSessions: () => void;
  nextSession: () => void;
  prevSession: () => void;
  sendInput: (sessionId: string, input: string) => void;
}

/**
 * Checks if a GNU screen session is currently running.
 *
 * @param screenName - The name of the screen session to check
 * @returns true if the session exists and is alive, false otherwise
 */
function isScreenAlive(screenName: string): boolean {
  try {
    const output = execSync('screen -ls', { encoding: 'utf-8' });
    return output.includes(screenName);
  } catch {
    return false;
  }
}

/**
 * Loads all sessions from the Claudeman screens registry.
 *
 * @description
 * Reads ~/.claudeman/screens.json and enriches each session with
 * its current alive/dead status by checking GNU screen.
 *
 * @returns Array of screen sessions with updated attached status
 */
function loadSessions(): ScreenSession[] {
  try {
    if (!existsSync(SCREENS_FILE)) {
      return [];
    }
    const data = readFileSync(SCREENS_FILE, 'utf-8');
    const sessions: ScreenSession[] = JSON.parse(data);

    // Check which sessions are alive
    return sessions.map((session) => ({
      ...session,
      attached: isScreenAlive(session.screenName),
    }));
  } catch {
    return [];
  }
}

/**
 * Loads Ralph Wiggum loop state for a specific session.
 *
 * @description
 * Reads ~/.claudeman/state-inner.json which contains per-session
 * tracking of inner loops, todos, and completion phrases.
 *
 * @param sessionId - The UUID of the session to load state for
 * @returns The inner session state or null if not found
 */
function loadInnerState(sessionId: string): InnerSessionState | null {
  try {
    if (!existsSync(INNER_STATE_FILE)) {
      return null;
    }
    const data = readFileSync(INNER_STATE_FILE, 'utf-8');
    const allStates = JSON.parse(data) as Record<string, InnerSessionState>;
    return allStates[sessionId] || null;
  } catch {
    return null;
  }
}

/**
 * React hook for managing Claude sessions in the TUI.
 *
 * @description
 * Provides complete session lifecycle management:
 * - Automatic session discovery and status monitoring
 * - Terminal output polling (500ms interval)
 * - Inner loop state tracking (500ms interval)
 * - Respawn status polling via API (2000ms interval)
 * - Session CRUD operations via Claudeman API
 *
 * @returns SessionManagerState object with session data and control methods
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { sessions, selectSession, sendInput } = useSessionManager();
 *
 *   return (
 *     <Box>
 *       {sessions.map(s => (
 *         <Text key={s.sessionId} onClick={() => selectSession(s.sessionId)}>
 *           {s.name}
 *         </Text>
 *       ))}
 *     </Box>
 *   );
 * }
 * ```
 */
export function useSessionManager(): SessionManagerState {
  const [sessions, setSessions] = useState<ScreenSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState<string>('');
  const [innerLoopState, setInnerLoopState] = useState<InnerLoopState | null>(null);
  const [innerTodos, setInnerTodos] = useState<InnerTodoItem[]>([]);
  const [respawnStatus, setRespawnStatus] = useState<RespawnStatus | null>(null);
  const outputBufferRef = useRef<string>('');

  // Load sessions on mount and watch for changes
  useEffect(() => {
    // Initial load
    setSessions(loadSessions());

    // Watch for changes
    const handleChange = () => {
      setSessions(loadSessions());
    };

    try {
      watchFile(SCREENS_FILE, { interval: 1000 }, handleChange);
    } catch {
      // File may not exist yet
    }

    return () => {
      try {
        unwatchFile(SCREENS_FILE, handleChange);
      } catch {
        // Ignore
      }
    };
  }, []);

  // Get active session
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) || null;

  // Poll inner state for active session
  useEffect(() => {
    if (!activeSessionId) {
      setInnerLoopState(null);
      setInnerTodos([]);
      return;
    }

    const pollInnerState = () => {
      const state = loadInnerState(activeSessionId);
      if (state) {
        setInnerLoopState(state.loop);
        setInnerTodos(state.todos);
      } else {
        setInnerLoopState(null);
        setInnerTodos([]);
      }
    };

    // Initial poll
    pollInnerState();

    // Set up polling interval (same as output polling)
    const intervalId = setInterval(pollInnerState, OUTPUT_POLL_INTERVAL);

    return () => {
      clearInterval(intervalId);
    };
  }, [activeSessionId]);

  // Poll respawn status via API (when server is running)
  useEffect(() => {
    if (!activeSessionId) {
      setRespawnStatus(null);
      return;
    }

    const pollRespawnStatus = async () => {
      try {
        const response = await fetch(`http://localhost:3000/api/sessions/${activeSessionId}`);
        if (response.ok) {
          const data = await response.json() as {
            success?: boolean;
            session?: {
              respawnEnabled?: boolean;
              respawnState?: string;
              respawnCycleCount?: number;
            };
          };
          if (data.success && data.session) {
            setRespawnStatus({
              enabled: data.session.respawnEnabled || false,
              state: data.session.respawnState || 'stopped',
              cycleCount: data.session.respawnCycleCount || 0,
            });
          }
        }
      } catch {
        // Server not running, that's ok
        setRespawnStatus(null);
      }
    };

    // Poll less frequently than output (every 2 seconds)
    pollRespawnStatus();
    const intervalId = setInterval(pollRespawnStatus, 2000);

    return () => {
      clearInterval(intervalId);
    };
  }, [activeSessionId]);

  // Poll terminal output for active session
  useEffect(() => {
    if (!activeSessionId || !activeSession) return;

    const pollOutput = () => {
      if (!isScreenAlive(activeSession.screenName)) return;

      try {
        const hardcopyFile = `/tmp/claudeman-${activeSessionId}-hardcopy`;
        execSync(`screen -S ${activeSession.screenName} -X hardcopy ${hardcopyFile}`, {
          encoding: 'utf-8',
          timeout: 1000,
        });
        if (existsSync(hardcopyFile)) {
          const content = readFileSync(hardcopyFile, 'utf-8');
          // Only update if content changed
          if (content !== outputBufferRef.current) {
            outputBufferRef.current = content;
            setTerminalOutput(content);
          }
          // Clean up temp file
          try {
            unlinkSync(hardcopyFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch {
        // Hardcopy may fail, that's ok
      }
    };

    // Initial poll
    pollOutput();

    // Set up polling interval
    const intervalId = setInterval(pollOutput, OUTPUT_POLL_INTERVAL);

    return () => {
      clearInterval(intervalId);
    };
  }, [activeSessionId, activeSession]);

  // Refresh sessions manually
  const refreshSessions = useCallback(() => {
    setSessions(loadSessions());
  }, []);

  // Select a session
  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setTerminalOutput('');
    outputBufferRef.current = '';
    // Polling effect will handle fetching output
  }, []);

  // Create new session
  const createSession = useCallback(async (): Promise<string | null> => {
    try {
      // Use the web API to create a session if server is running
      const response = await fetch('http://localhost:3000/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: `tui-${Date.now()}` }),
      });

      if (response.ok) {
        const data = await response.json() as { success?: boolean; sessionId?: string };
        if (data.success && data.sessionId) {
          // Refresh and select new session
          const sessionId = data.sessionId;
          setTimeout(() => {
            refreshSessions();
            setActiveSessionId(sessionId);
          }, 500);
          return sessionId;
        }
      }

      // Fallback: Just report that web server isn't running
      setTerminalOutput(
        'Web server not running. Start it with: claudeman web\n' +
        'Then use this TUI to manage sessions.'
      );
      return null;
    } catch {
      setTerminalOutput(
        'Cannot connect to Claudeman server.\n' +
        'Start the server with: claudeman web\n' +
        'Then use this TUI to manage sessions.'
      );
      return null;
    }
  }, [refreshSessions]);

  // Kill a session
  const killSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;

    try {
      // Kill via screen
      execSync(`screen -S ${session.screenName} -X quit`, { encoding: 'utf-8' });
    } catch {
      // May already be dead
    }

    // If this was the active session, select another
    if (activeSessionId === sessionId) {
      const remaining = sessions.filter((s) => s.sessionId !== sessionId);
      if (remaining.length > 0) {
        setActiveSessionId(remaining[0].sessionId);
      } else {
        setActiveSessionId(null);
      }
    }

    // Refresh to update the list
    setTimeout(refreshSessions, 500);
  }, [sessions, activeSessionId, refreshSessions]);

  // Kill all sessions
  const killAllSessions = useCallback(() => {
    for (const session of sessions) {
      try {
        execSync(`screen -S ${session.screenName} -X quit`, { encoding: 'utf-8' });
      } catch {
        // Ignore
      }
    }
    setActiveSessionId(null);
    setTimeout(refreshSessions, 500);
  }, [sessions, refreshSessions]);

  // Navigate to next session
  const nextSession = useCallback(() => {
    if (sessions.length === 0) return;
    const currentIndex = sessions.findIndex((s) => s.sessionId === activeSessionId);
    const nextIndex = (currentIndex + 1) % sessions.length;
    selectSession(sessions[nextIndex].sessionId);
  }, [sessions, activeSessionId, selectSession]);

  // Navigate to previous session
  const prevSession = useCallback(() => {
    if (sessions.length === 0) return;
    const currentIndex = sessions.findIndex((s) => s.sessionId === activeSessionId);
    const prevIndex = currentIndex <= 0 ? sessions.length - 1 : currentIndex - 1;
    selectSession(sessions[prevIndex].sessionId);
  }, [sessions, activeSessionId, selectSession]);

  // Send input to a session
  const sendInput = useCallback((sessionId: string, input: string) => {
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session || !isScreenAlive(session.screenName)) return;

    try {
      // Send input via screen stuff command
      // Escape special characters for shell
      const escaped = input.replace(/'/g, "'\\''");

      if (input === '\r') {
        // Send Enter key
        execSync(`screen -S ${session.screenName} -p 0 -X stuff $'\\015'`, {
          encoding: 'utf-8',
        });
      } else {
        execSync(`screen -S ${session.screenName} -p 0 -X stuff '${escaped}'`, {
          encoding: 'utf-8',
        });
      }
    } catch {
      // Input may fail if screen is not ready
    }
  }, [sessions]);

  return {
    sessions,
    activeSessionId,
    activeSession,
    terminalOutput,
    innerLoopState,
    innerTodos,
    respawnStatus,
    refreshSessions,
    selectSession,
    createSession,
    killSession,
    killAllSessions,
    nextSession,
    prevSession,
    sendInput,
  };
}
