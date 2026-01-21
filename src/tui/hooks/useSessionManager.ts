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
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import type { ScreenSession, InnerLoopState, InnerTodoItem, InnerSessionState } from '../../types.js';

const execAsync = promisify(exec);

const SCREENS_FILE = join(homedir(), '.claudeman', 'screens.json');
const INNER_STATE_FILE = join(homedir(), '.claudeman', 'state-inner.json');
const SETTINGS_FILE = join(homedir(), '.claudeman', 'settings.json');
const OUTPUT_POLL_INTERVAL = 300; // Poll terminal output every 300ms (faster refresh)

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
  lastUsedCase: string | null;
  refreshSessions: () => void;
  refreshCases: () => Promise<void>;
  selectSession: (sessionId: string) => void;
  createSession: (caseName?: string, mode?: 'claude' | 'shell') => Promise<string | null>;
  createCase: (name: string) => Promise<boolean>;
  killSession: (sessionId: string) => void;
  killAllSessions: () => void;
  killAllScreensAndClaude: () => void;
  nextSession: () => void;
  prevSession: () => void;
  sendInput: (sessionId: string, input: string) => void;
  toggleRespawn: () => Promise<boolean>;
  renameSession: (sessionId: string, name: string) => Promise<boolean>;
}

// Cache for screen -ls output to avoid repeated execSync calls
let screenListCache = '';
let screenListCacheTime = 0;
const SCREEN_CACHE_TTL = 100; // ms

/**
 * Checks if a GNU screen session is currently running.
 * Uses a 100ms cache to avoid repeated execSync calls when checking multiple sessions.
 *
 * @param screenName - The name of the screen session to check
 * @returns true if the session exists and is alive, false otherwise
 */
function isScreenAlive(screenName: string): boolean {
  const now = Date.now();

  // Use cached result if fresh enough
  if (now - screenListCacheTime > SCREEN_CACHE_TTL) {
    try {
      screenListCache = execSync('screen -ls', {
        encoding: 'utf-8',
        timeout: 5000, // 5 second timeout to prevent hang
      });
      screenListCacheTime = now;
    } catch {
      screenListCache = '';
      screenListCacheTime = now;
      return false;
    }
  }

  return screenListCache.includes(screenName);
}

/**
 * Loads all sessions from the Claudeman screens registry.
 *
 * @description
 * Reads ~/.claudeman/screens.json and enriches each session with
 * its current alive/dead status by checking GNU screen.
 * Dead sessions are filtered out - only alive sessions are returned.
 *
 * @returns Array of alive screen sessions
 */
function loadSessions(): ScreenSession[] {
  try {
    if (!existsSync(SCREENS_FILE)) {
      return [];
    }
    const data = readFileSync(SCREENS_FILE, 'utf-8');
    const sessions: ScreenSession[] = JSON.parse(data);

    // Check which sessions are alive and filter out dead ones
    return sessions
      .map((session) => ({
        ...session,
        attached: isScreenAlive(session.screenName),
      }))
      .filter((session) => session.attached);
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
 * Loads the last used case name from settings.
 *
 * @description
 * Reads ~/.claudeman/settings.json and returns the lastUsedCase field.
 * This is used to default the case selection in the TUI to match the web GUI.
 *
 * @returns The last used case name or null if not found
 */
function loadLastUsedCase(): string | null {
  try {
    if (!existsSync(SETTINGS_FILE)) {
      return null;
    }
    const data = readFileSync(SETTINGS_FILE, 'utf-8');
    const settings = JSON.parse(data) as { lastUsedCase?: string };
    return settings.lastUsedCase || null;
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
  const [lastUsedCase, setLastUsedCase] = useState<string | null>(loadLastUsedCase);
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

  // Poll terminal output for active session (async for non-blocking)
  useEffect(() => {
    if (!activeSessionId || !activeSession) return;

    let isMounted = true;
    let pollTimeoutId: NodeJS.Timeout | null = null;

    const pollOutput = async () => {
      if (!isMounted || !isScreenAlive(activeSession.screenName)) return;

      try {
        const hardcopyFile = `/tmp/claudeman-${activeSessionId}-hardcopy`;
        // Use screen with UTF-8 mode (-U) for proper character handling (async)
        await execAsync(`screen -U -S ${activeSession.screenName} -X hardcopy ${hardcopyFile}`, {
          timeout: 1000,
          env: {
            ...process.env,
            LANG: process.env.LANG || 'en_US.UTF-8',
            LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
          }
        });
        if (isMounted && existsSync(hardcopyFile)) {
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

      // Schedule next poll (using timeout instead of interval for async)
      if (isMounted) {
        pollTimeoutId = setTimeout(pollOutput, OUTPUT_POLL_INTERVAL);
      }
    };

    // Initial poll
    pollOutput();

    return () => {
      isMounted = false;
      if (pollTimeoutId) {
        clearTimeout(pollTimeoutId);
      }
    };
  }, [activeSessionId, activeSession]);

  // Refresh sessions manually
  const refreshSessions = useCallback(() => {
    setSessions(loadSessions());
  }, []);

  // Refresh cases from API and reload lastUsedCase from settings
  const refreshCases = useCallback(async () => {
    // Always reload lastUsedCase from settings
    setLastUsedCase(loadLastUsedCase());

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

  // Create new session with proper naming (w1-casename, w2-casename, etc.)
  const createSession = useCallback(async (caseName?: string, mode: 'claude' | 'shell' = 'claude'): Promise<string | null> => {
    const actualCaseName = caseName || 'testcase';

    try {
      // Get or create the case
      let caseRes = await fetch(`http://localhost:3000/api/cases/${actualCaseName}`);
      let caseData = await caseRes.json() as { path?: string };

      // Create case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('http://localhost:3000/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: actualCaseName, description: '' }),
        });
        const createResult = await createCaseRes.json() as { success?: boolean; case?: { path: string } };
        if (!createResult.success || !createResult.case) {
          throw new Error('Failed to create case');
        }
        caseData = createResult.case;
      }

      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');

      // Find highest existing w-number across all sessions
      let startNumber = 1;
      for (const session of sessions) {
        const match = session.name?.match(/^w(\d+)-/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Generate session name matching web UI convention
      const sessionName = `w${startNumber}-${actualCaseName}`;

      // Create session with custom name
      const createRes = await fetch('http://localhost:3000/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir, name: sessionName, mode }),
      });
      const createData = await createRes.json() as { success?: boolean; session?: { id: string } };

      if (!createData.success || !createData.session) {
        throw new Error('Failed to create session');
      }

      const sessionId = createData.session.id;

      // Start in the appropriate mode
      if (mode === 'shell') {
        await fetch(`http://localhost:3000/api/sessions/${sessionId}/shell`, { method: 'POST' });
      } else {
        await fetch(`http://localhost:3000/api/sessions/${sessionId}/interactive`, { method: 'POST' });
      }

      // Refresh sessions
      setTimeout(() => {
        refreshSessions();
        refreshCases();
      }, 500);

      return sessionId;
    } catch (err) {
      setTerminalOutput(
        `Failed to create session: ${err instanceof Error ? err.message : 'Unknown error'}\n` +
        'Make sure the web server is running: claudeman web'
      );
      return null;
    }
  }, [sessions, refreshSessions, refreshCases]);

  // Kill a session
  const killSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;

    try {
      // Kill via screen with timeout to prevent hang
      execSync(`screen -S ${session.screenName} -X quit`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch {
      // May already be dead or timeout
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
        execSync(`screen -S ${session.screenName} -X quit`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch {
        // Ignore - may already be dead or timeout
      }
    }
    setActiveSessionId(null);
    setTimeout(refreshSessions, 500);
  }, [sessions, refreshSessions]);

  // Kill ALL claudeman screens and Claude processes (nuclear option)
  const killAllScreensAndClaude = useCallback(() => {
    // 1. Kill all tracked sessions first
    for (const session of sessions) {
      try {
        execSync(`screen -S ${session.screenName} -X quit`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch {
        // Ignore
      }
    }

    // 2. Kill any remaining claudeman screen sessions
    try {
      execSync('pkill -f "SCREEN.*claudeman"', {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch {
      // May not find any, that's ok
    }

    // 3. Kill all Claude CLI processes
    try {
      execSync('pkill -f "claude"', {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch {
      // May not find any, that's ok
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

  // Send input to a session directly via screen command (simple, reliable)
  const sendInput = useCallback((sessionId: string, input: string) => {
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session || !isScreenAlive(session.screenName)) return;

    const screenName = session.screenName;

    try {
      if (input === '\r') {
        // Send Enter key
        execSync(`screen -S ${screenName} -p 0 -X stuff $'\\015'`, {
          encoding: 'utf-8',
          timeout: 1000,
        });
      } else if (input === '\t') {
        // Send Tab key
        execSync(`screen -S ${screenName} -p 0 -X stuff $'\\011'`, {
          encoding: 'utf-8',
          timeout: 1000,
        });
      } else if (input === '\x7f') {
        // Send Backspace
        execSync(`screen -S ${screenName} -p 0 -X stuff $'\\177'`, {
          encoding: 'utf-8',
          timeout: 1000,
        });
      } else if (input.startsWith('\x1b')) {
        // Send escape sequences (arrows, etc) - use $'...' syntax
        const escaped = input.replace(/'/g, "'\\''");
        execSync(`screen -S ${screenName} -p 0 -X stuff $'${escaped.replace(/\x1b/g, '\\033')}'`, {
          encoding: 'utf-8',
          timeout: 1000,
        });
      } else {
        // Regular character - escape single quotes
        const escaped = input.replace(/'/g, "'\\''");
        execSync(`screen -S ${screenName} -p 0 -X stuff '${escaped}'`, {
          encoding: 'utf-8',
          timeout: 1000,
        });
      }
    } catch {
      // Input may fail if screen is not ready - ignore
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
    lastUsedCase,
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
    toggleRespawn,
    renameSession,
  };
}
