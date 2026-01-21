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
import { existsSync, readFileSync, watchFile, unwatchFile, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import type { ScreenSession, InnerLoopState, InnerTodoItem, InnerSessionState } from '../../types.js';

const SCREENS_FILE = join(homedir(), '.claudeman', 'screens.json');
const INNER_STATE_FILE = join(homedir(), '.claudeman', 'state-inner.json');
const OUTPUT_POLL_INTERVAL = 500; // Poll terminal output every 500ms

/**
 * Emoji to ASCII replacement map for screen hardcopy output.
 * GNU screen's hardcopy doesn't handle UTF-8 multi-byte characters well,
 * so we replace common Claude Code emoji with ASCII equivalents.
 */
const EMOJI_REPLACEMENTS: [RegExp, string][] = [
  // Claude Code logo/branding
  [/\u{1F9E0}/gu, '*'],           // 🧠 brain -> *
  [/\u{2728}/gu, '*'],             // ✨ sparkles -> *
  [/\u{1F4AC}/gu, '>'],            // 💬 speech bubble -> >
  [/\u{1F916}/gu, '[bot]'],        // 🤖 robot -> [bot]

  // Status indicators
  [/\u{2714}/gu, '[ok]'],          // ✔ check mark -> [ok]
  [/\u{2705}/gu, '[ok]'],          // ✅ check mark button -> [ok]
  [/\u{274C}/gu, '[x]'],           // ❌ cross mark -> [x]
  [/\u{26A0}/gu, '[!]'],           // ⚠ warning -> [!]
  [/\u{2139}/gu, '[i]'],           // ℹ info -> [i]
  [/\u{1F6A8}/gu, '[!]'],          // 🚨 rotating light -> [!]

  // Progress/activity
  [/\u{23F3}/gu, '...'],           // ⏳ hourglass -> ...
  [/\u{231B}/gu, '...'],           // ⌛ hourglass done -> ...
  [/\u{1F504}/gu, '(...)'],        // 🔄 refresh -> (...)
  [/\u{25B6}/gu, '>'],             // ▶ play -> >
  [/\u{23F8}/gu, '||'],            // ⏸ pause -> ||
  [/\u{23F9}/gu, '[]'],            // ⏹ stop -> []

  // File/folder icons
  [/\u{1F4C1}/gu, '[dir]'],        // 📁 folder -> [dir]
  [/\u{1F4C2}/gu, '[dir]'],        // 📂 open folder -> [dir]
  [/\u{1F4C4}/gu, '[file]'],       // 📄 file -> [file]
  [/\u{1F4DD}/gu, '[edit]'],       // 📝 memo -> [edit]

  // Arrows and navigation
  [/\u{2190}/gu, '<-'],            // ← left arrow
  [/\u{2192}/gu, '->'],            // → right arrow
  [/\u{2191}/gu, '^'],             // ↑ up arrow
  [/\u{2193}/gu, 'v'],             // ↓ down arrow
  [/\u{21B5}/gu, '<CR>'],          // ↵ return symbol -> <CR>
  [/\u{23CE}/gu, '<CR>'],          // ⏎ return symbol -> <CR>

  // Special Unicode box-drawing and symbols that may corrupt
  [/\u{25B8}/gu, '>'],             // ▸ small right triangle
  [/\u{25B9}/gu, '>'],             // ▹ white small right triangle
  [/\u{2022}/gu, '-'],             // • bullet -> -
  [/\u{25CF}/gu, 'o'],             // ● black circle -> o
  [/\u{25CB}/gu, 'o'],             // ○ white circle -> o
  [/\u{25A0}/gu, '#'],             // ■ black square -> #
  [/\u{25A1}/gu, '[]'],            // □ white square -> []
  [/\u{2261}/gu, '='],             // ≡ hamburger menu -> =

  // Misc
  [/\u{1F512}/gu, '[lock]'],       // 🔒 lock
  [/\u{1F513}/gu, '[unlock]'],     // 🔓 unlock
  [/\u{1F527}/gu, '[tool]'],       // 🔧 wrench
  [/\u{2699}/gu, '[gear]'],        // ⚙ gear
  [/\u{1F50D}/gu, '[search]'],     // 🔍 magnifying glass
  [/\u{1F4E6}/gu, '[pkg]'],        // 📦 package
  [/\u{1F680}/gu, '[>]'],          // 🚀 rocket
  [/\u{1F3AF}/gu, '[*]'],          // 🎯 target

  // Catch-all for any remaining emoji in common ranges
  // These will appear as replacement characters otherwise
  [/[\u{1F300}-\u{1F9FF}]/gu, ''], // Misc symbols and pictographs
  [/[\u{2600}-\u{26FF}]/gu, ''],   // Misc symbols
  [/[\u{FE00}-\u{FE0F}]/gu, ''],   // Variation selectors
];

/**
 * Sanitizes screen hardcopy output by replacing emoji with ASCII equivalents.
 *
 * @param content - Raw hardcopy output that may contain corrupted UTF-8
 * @returns Sanitized string with emoji replaced by ASCII
 */
function sanitizeHardcopyOutput(content: string): string {
  let result = content;

  // Apply all emoji replacements
  for (const [pattern, replacement] of EMOJI_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  // Remove any remaining replacement characters (U+FFFD) that indicate
  // encoding issues with multi-byte sequences
  result = result.replace(/\uFFFD+/g, '');

  // Remove any other non-printable characters except common whitespace
  // This catches any remaining problematic bytes
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  return result;
}

interface RespawnStatus {
  enabled: boolean;
  state: string;
  cycleCount: number;
}

interface CaseInfo {
  name: string;
  path: string;
  hasClaudeMd: boolean;
}

interface SessionManagerState {
  sessions: ScreenSession[];
  activeSessionId: string | null;
  activeSession: ScreenSession | null;
  terminalOutput: string;
  innerLoopState: InnerLoopState | null;
  innerTodos: InnerTodoItem[];
  respawnStatus: RespawnStatus | null;
  cases: CaseInfo[];
  refreshSessions: () => void;
  refreshCases: () => Promise<void>;
  selectSession: (sessionId: string) => void;
  createSession: (caseName?: string, mode?: 'claude' | 'shell') => Promise<string | null>;
  createCase: (name: string) => Promise<boolean>;
  killSession: (sessionId: string) => void;
  killAllSessions: () => void;
  nextSession: () => void;
  prevSession: () => void;
  sendInput: (sessionId: string, input: string) => void;
  toggleRespawn: () => Promise<boolean>;
  renameSession: (sessionId: string, name: string) => Promise<boolean>;
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
  const [cases, setCases] = useState<CaseInfo[]>([]);
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
        // Use screen with UTF-8 mode (-U) for proper character handling
        execSync(`screen -U -S ${activeSession.screenName} -X hardcopy ${hardcopyFile}`, {
          encoding: 'utf-8',
          timeout: 1000,
          env: {
            ...process.env,
            LANG: process.env.LANG || 'en_US.UTF-8',
            LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
          }
        });
        if (existsSync(hardcopyFile)) {
          const rawContent = readFileSync(hardcopyFile, 'utf-8');
          // Sanitize emoji/unicode that screen hardcopy corrupts
          const content = sanitizeHardcopyOutput(rawContent);
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

  // Refresh cases from API
  const refreshCases = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:3000/api/cases');
      if (response.ok) {
        const data = await response.json() as CaseInfo[];
        setCases(data);
      }
    } catch {
      // Server not running, clear cases
      setCases([]);
    }
  }, []);

  // Load cases on mount
  useEffect(() => {
    refreshCases();
  }, [refreshCases]);

  // Select a session
  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setTerminalOutput('');
    outputBufferRef.current = '';
    // Polling effect will handle fetching output
  }, []);

  // Create a new case
  const createCase = useCallback(async (name: string): Promise<boolean> => {
    try {
      const response = await fetch('http://localhost:3000/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (response.ok) {
        const data = await response.json() as { success?: boolean };
        if (data.success) {
          await refreshCases();
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }, [refreshCases]);

  // Create new session (optionally with case name and mode)
  const createSession = useCallback(async (caseName?: string, mode: 'claude' | 'shell' = 'claude'): Promise<string | null> => {
    try {
      // Use the web API to create a session if server is running
      const response = await fetch('http://localhost:3000/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: caseName || `case-${Date.now()}`, mode }),
      });

      if (response.ok) {
        const data = await response.json() as { success?: boolean; sessionId?: string; caseName?: string };
        if (data.success && data.sessionId) {
          // Refresh and select new session
          const sessionId = data.sessionId;
          setTimeout(() => {
            refreshSessions();
            refreshCases();
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
  }, [refreshSessions, refreshCases]);

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

  // Toggle respawn for active session
  const toggleRespawn = useCallback(async (): Promise<boolean> => {
    if (!activeSessionId) return false;

    try {
      const isEnabled = respawnStatus?.enabled || false;
      const endpoint = isEnabled
        ? `http://localhost:3000/api/sessions/${activeSessionId}/respawn/stop`
        : `http://localhost:3000/api/sessions/${activeSessionId}/respawn/enable`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isEnabled ? {} : { config: {} }),
      });

      if (response.ok) {
        const data = await response.json() as { success?: boolean };
        return data.success || false;
      }
      return false;
    } catch {
      return false;
    }
  }, [activeSessionId, respawnStatus]);

  // Rename a session
  const renameSession = useCallback(async (sessionId: string, name: string): Promise<boolean> => {
    try {
      const response = await fetch(`http://localhost:3000/api/sessions/${sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (response.ok) {
        const data = await response.json() as { success?: boolean };
        if (data.success) {
          // Refresh sessions to get updated name
          setTimeout(refreshSessions, 100);
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }, [refreshSessions]);

  return {
    sessions,
    activeSessionId,
    activeSession,
    terminalOutput,
    innerLoopState,
    innerTodos,
    respawnStatus,
    cases,
    refreshSessions,
    refreshCases,
    selectSession,
    createSession,
    createCase,
    killSession,
    killAllSessions,
    nextSession,
    prevSession,
    sendInput,
    toggleRespawn,
    renameSession,
  };
}
