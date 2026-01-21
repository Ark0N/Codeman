/**
 * @fileoverview StartScreen component
 *
 * Session discovery and selection interface for the TUI.
 *
 * @description
 * The initial screen displayed when launching `claudeman tui`:
 * - Shows existing sessions and available cases
 * - Supports two modes: session list and case selection
 * - Arrow key navigation with visual selection highlight
 * - Actions: Enter (view/select), a (attach), d (delete), n (new), c (cases), r (refresh), q (quit)
 *
 * This is the "home screen" users return to with Escape from the main view.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ScreenSession } from '../../types.js';

interface CaseInfo {
  name: string;
  path: string;
  hasClaudeMd: boolean;
}

interface StartScreenProps {
  sessions: ScreenSession[];
  cases: CaseInfo[];
  onSelectSession: (session: ScreenSession) => void;
  onAttachSession: (session: ScreenSession) => void;
  onDeleteSession: (session: ScreenSession) => void;
  onDeleteAll: () => void;
  onCreateSession: (caseName?: string, count?: number, mode?: 'claude' | 'shell') => void;
  onCreateCase: (name: string) => Promise<boolean>;
  onRefresh: () => void;
  onRefreshCases: () => void;
  onExit: () => void;
}

type ScreenMode = 'sessions' | 'cases' | 'new-case' | 'multi-start';

/**
 * Formats a duration from milliseconds to a compact human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "45s", "5m", "2h 15m", or "3d 5h"
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Start screen component for session discovery and selection.
 *
 * @description
 * Renders two views:
 * - Sessions view: List of active sessions
 * - Cases view: List of available cases to start a new session
 *
 * @param props - Component props
 * @returns The start screen element
 */
export function StartScreen({
  sessions,
  cases,
  onSelectSession,
  onAttachSession,
  onDeleteSession,
  onDeleteAll,
  onCreateSession,
  onCreateCase,
  onRefresh,
  onRefreshCases,
  onExit,
}: StartScreenProps): React.ReactElement {
  const now = Date.now();
  const [mode, setMode] = useState<ScreenMode>('sessions');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [newCaseName, setNewCaseName] = useState('');
  const [multiStartCount, setMultiStartCount] = useState('1');
  const [error, setError] = useState<string | null>(null);

  // Reset selection when switching modes
  useEffect(() => {
    setSelectedIndex(0);
    setError(null);
    if (mode !== 'multi-start') {
      setMultiStartCount('1');
    }
  }, [mode]);

  // Ensure selectedIndex is valid when list changes
  useEffect(() => {
    const maxIndex = mode === 'sessions' ? sessions.length - 1 : cases.length - 1;
    if (selectedIndex > maxIndex && maxIndex >= 0) {
      setSelectedIndex(maxIndex);
    }
  }, [sessions.length, cases.length, selectedIndex, mode]);

  // Handle keyboard input for navigation
  useInput((input, key) => {
    // New case input mode - only handle escape and return
    if (mode === 'new-case') {
      if (key.escape) {
        setMode('cases');
        setNewCaseName('');
        setError(null);
      }
      return;
    }

    // Multi-start input mode - only handle escape and return
    if (mode === 'multi-start') {
      if (key.escape) {
        setMode('cases');
        setMultiStartCount('1');
        setError(null);
      }
      return;
    }

    // Arrow key navigation
    const listLength = mode === 'sessions' ? sessions.length : cases.length;
    if (key.upArrow && listLength > 0) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : listLength - 1));
      return;
    }
    if (key.downArrow && listLength > 0) {
      setSelectedIndex((prev) => (prev < listLength - 1 ? prev + 1 : 0));
      return;
    }

    // Enter to select
    if (key.return && listLength > 0) {
      if (mode === 'sessions') {
        onSelectSession(sessions[selectedIndex]);
      } else if (mode === 'cases') {
        // Start session with selected case
        onCreateSession(cases[selectedIndex].name);
      }
      return;
    }

    // Mode-specific shortcuts
    if (mode === 'sessions') {
      // 'a' to attach directly to screen
      if (input === 'a' && sessions.length > 0 && sessions[selectedIndex].attached) {
        onAttachSession(sessions[selectedIndex]);
        return;
      }

      // 'd' or 'x' to delete/kill session
      if ((input === 'd' || input === 'x') && sessions.length > 0) {
        onDeleteSession(sessions[selectedIndex]);
        return;
      }

      // 'D' (shift+d) to delete ALL screens and Claude processes
      if (input === 'D') {
        onDeleteAll();
        return;
      }

      // 'c' to switch to cases view
      if (input === 'c') {
        onRefreshCases();
        setMode('cases');
        return;
      }

      // 'n' to create new session (quick start with auto name)
      if (input === 'n') {
        onCreateSession();
        return;
      }
    } else if (mode === 'cases') {
      // 's' to switch back to sessions view
      if (input === 's') {
        setMode('sessions');
        return;
      }

      // 'n' to create new case
      if (input === 'n') {
        setMode('new-case');
        setNewCaseName('');
        return;
      }

      // 'm' to start multiple sessions with selected case
      if (input === 'm' && cases.length > 0) {
        setMode('multi-start');
        setMultiStartCount('1');
        setError(null);
        return;
      }

      // 'h' to start a shell session with selected case
      if (input === 'h' && cases.length > 0) {
        onCreateSession(cases[selectedIndex].name, 1, 'shell');
        return;
      }
    }

    // 'r' to refresh
    if (input === 'r') {
      if (mode === 'sessions') {
        onRefresh();
      } else {
        onRefreshCases();
      }
      return;
    }

    // 'q' to quit
    if (input === 'q') {
      onExit();
      return;
    }
  });

  // Handle new case name submission
  const handleNewCaseSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Case name cannot be empty');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError('Use only letters, numbers, hyphens, underscores');
      return;
    }

    const success = await onCreateCase(trimmed);
    if (success) {
      setMode('cases');
      setNewCaseName('');
      setError(null);
    } else {
      setError('Failed to create case (may already exist)');
    }
  };

  // Handle multi-start submission
  const handleMultiStartSubmit = (value: string) => {
    const count = parseInt(value.trim(), 10);
    if (isNaN(count) || count < 1) {
      setError('Enter a number from 1 to 20');
      return;
    }
    if (count > 20) {
      setError('Maximum 20 sessions at once');
      return;
    }

    // Get the selected case name
    const selectedCase = cases[selectedIndex];
    if (!selectedCase) {
      setError('No case selected');
      return;
    }

    // Start the sessions
    onCreateSession(selectedCase.name, count);
    setMode('cases');
    setMultiStartCount('1');
    setError(null);
  };

  // Get currently selected item for display
  const getSelectedItem = (): { type: 'session' | 'case'; name: string; path?: string } | null => {
    if (mode === 'sessions' && sessions.length > 0 && selectedIndex < sessions.length) {
      const session = sessions[selectedIndex];
      return { type: 'session', name: session.name || 'unnamed', path: session.workingDir };
    }
    if ((mode === 'cases' || mode === 'multi-start') && cases.length > 0 && selectedIndex < cases.length) {
      const caseInfo = cases[selectedIndex];
      return { type: 'case', name: caseInfo.name, path: caseInfo.path };
    }
    return null;
  };

  const selectedItem = getSelectedItem();

  // Render new case input mode
  if (mode === 'new-case') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box
          borderStyle="double"
          borderColor="cyan"
          paddingX={2}
          paddingY={1}
          justifyContent="center"
        >
          <Text bold color="cyan">
            Create New Case
          </Text>
        </Box>

        <Box marginY={1} flexDirection="column">
          <Text>Enter case name (letters, numbers, hyphens, underscores):</Text>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <TextInput
              value={newCaseName}
              onChange={setNewCaseName}
              onSubmit={handleNewCaseSubmit}
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color="red">{error}</Text>
            </Box>
          )}
        </Box>

        <Box marginTop={2} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text>
            <Text color="green">[Enter]</Text>
            <Text> Create  </Text>
            <Text color="yellow">[Esc]</Text>
            <Text> Cancel</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  // Render multi-start input mode
  if (mode === 'multi-start') {
    const selectedCase = cases[selectedIndex];
    return (
      <Box flexDirection="column" padding={1}>
        <Box
          borderStyle="double"
          borderColor="cyan"
          paddingX={2}
          paddingY={1}
          justifyContent="center"
        >
          <Text bold color="cyan">
            Start Multiple Sessions
          </Text>
        </Box>

        {/* Show selected case */}
        <Box marginY={1} borderStyle="single" borderColor="green" paddingX={2}>
          <Text>
            <Text color="green" bold>Selected Case: </Text>
            <Text bold color="white">{selectedCase?.name || 'none'}</Text>
          </Text>
        </Box>

        <Box marginY={1} flexDirection="column">
          <Text>How many sessions to start? (1-20):</Text>
          <Box marginTop={1}>
            <Text color="green">&gt; </Text>
            <TextInput
              value={multiStartCount}
              onChange={setMultiStartCount}
              onSubmit={handleMultiStartSubmit}
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color="red">{error}</Text>
            </Box>
          )}
        </Box>

        <Box marginTop={2} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text>
            <Text color="green">[Enter]</Text>
            <Text> Start Sessions  </Text>
            <Text color="yellow">[Esc]</Text>
            <Text> Cancel</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        justifyContent="center"
      >
        <Text bold color="cyan">
          Claudeman TUI
        </Text>
      </Box>

      {/* Mode tabs */}
      <Box marginY={1}>
        <Text>
          <Text
            backgroundColor={mode === 'sessions' ? 'blue' : undefined}
            color={mode === 'sessions' ? 'white' : 'gray'}
            bold={mode === 'sessions'}
          >
            {' [s] Sessions '}
          </Text>
          <Text> </Text>
          <Text
            backgroundColor={mode === 'cases' ? 'blue' : undefined}
            color={mode === 'cases' ? 'white' : 'gray'}
            bold={mode === 'cases'}
          >
            {' [c] Cases '}
          </Text>
          <Text dimColor> | Press ? for help</Text>
        </Text>
      </Box>

      {/* Selected item display */}
      {selectedItem && (
        <Box marginBottom={1} borderStyle="single" borderColor="green" paddingX={2}>
          <Text>
            <Text color="green" bold>Selected: </Text>
            <Text bold color="white">{selectedItem.name}</Text>
            {selectedItem.path && (
              <Text dimColor> ({selectedItem.path.replace(process.env.HOME || '', '~')})</Text>
            )}
          </Text>
        </Box>
      )}

      {/* Sessions view */}
      {mode === 'sessions' && (
        <>
          {sessions.length === 0 ? (
            <Box flexDirection="column" marginY={1}>
              <Text color="yellow">No sessions found</Text>
              <Text dimColor>Press [n] to create a new session, or [c] to select a case</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {/* Table header */}
              <Box marginBottom={1}>
                <Text bold>
                  <Text color="gray">{'    '}</Text>
                  <Text>{'NAME'.padEnd(22)}</Text>
                  <Text>{'RUNTIME'.padEnd(12)}</Text>
                  <Text>{'STATUS'.padEnd(10)}</Text>
                  <Text>{'MODE'.padEnd(10)}</Text>
                </Text>
              </Box>

              {/* Session rows */}
              {sessions.map((session, index) => {
                const runtime = formatDuration(now - session.createdAt);
                const statusColor = session.attached ? 'green' : 'red';
                const statusIcon = session.attached ? '\u25CF' : '\u25CB';
                const statusText = session.attached ? 'alive' : 'dead';
                const name = (session.name || 'unnamed').slice(0, 20);
                const isSelected = index === selectedIndex;

                return (
                  <Box key={session.sessionId}>
                    {isSelected ? (
                      <Text backgroundColor="blue" color="white">
                        <Text color="cyan" bold>{' \u25B6 '}</Text>
                        <Text bold>{name.padEnd(22)}</Text>
                        <Text>{runtime.padEnd(12)}</Text>
                        <Text color={statusColor}>
                          {statusIcon} {statusText.padEnd(8)}
                        </Text>
                        <Text>{session.mode.padEnd(10)}</Text>
                      </Text>
                    ) : (
                      <Text>
                        <Text color="gray">{'   '}</Text>
                        <Text>{name.padEnd(22)}</Text>
                        <Text dimColor>{runtime.padEnd(12)}</Text>
                        <Text color={statusColor}>
                          {statusIcon} {statusText.padEnd(8)}
                        </Text>
                        <Text>{session.mode.padEnd(10)}</Text>
                      </Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}

          {/* Sessions footer */}
          <Box marginTop={2} flexDirection="column">
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
              <Text>
                <Text color="green">[n]</Text>
                <Text> New  </Text>
                <Text color="green">[c]</Text>
                <Text> Cases  </Text>
                <Text color="green">[{'\u2191\u2193'}]</Text>
                <Text> Navigate  </Text>
                <Text color="green">[Enter]</Text>
                <Text> View  </Text>
                <Text color="green">[a]</Text>
                <Text> Attach  </Text>
                <Text color="red">[d]</Text>
                <Text> Delete  </Text>
                <Text color="red" bold>[D]</Text>
                <Text> Delete ALL  </Text>
                <Text color="yellow">[q]</Text>
                <Text> Quit</Text>
              </Text>
            </Box>
          </Box>
        </>
      )}

      {/* Cases view */}
      {mode === 'cases' && (
        <>
          {cases.length === 0 ? (
            <Box flexDirection="column" marginY={1}>
              <Text color="yellow">No cases found</Text>
              <Text dimColor>Press [n] to create a new case</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {/* Table header */}
              <Box marginBottom={1}>
                <Text bold>
                  <Text color="gray">{'    '}</Text>
                  <Text>{'CASE NAME'.padEnd(30)}</Text>
                  <Text>{'PATH'.padEnd(40)}</Text>
                </Text>
              </Box>

              {/* Case rows */}
              {cases.map((caseInfo, index) => {
                const isSelected = index === selectedIndex;
                const name = caseInfo.name.slice(0, 28);
                const path = caseInfo.path.replace(process.env.HOME || '', '~').slice(0, 38);

                return (
                  <Box key={caseInfo.name}>
                    {isSelected ? (
                      <Text backgroundColor="blue" color="white">
                        <Text color="cyan" bold>{' \u25B6 '}</Text>
                        <Text bold>{name.padEnd(30)}</Text>
                        <Text>{path.padEnd(40)}</Text>
                      </Text>
                    ) : (
                      <Text>
                        <Text color="gray">{'   '}</Text>
                        <Text>{name.padEnd(30)}</Text>
                        <Text dimColor>{path.padEnd(40)}</Text>
                      </Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}

          {/* Cases footer */}
          <Box marginTop={2} flexDirection="column">
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
              <Text>
                <Text color="green">[Enter]</Text>
                <Text> Claude  </Text>
                <Text color="yellow">[h]</Text>
                <Text> Shell  </Text>
                <Text color="cyan">[m]</Text>
                <Text> Multi (1-20)  </Text>
                <Text color="green">[n]</Text>
                <Text> New Case  </Text>
                <Text color="green">[s]</Text>
                <Text> Sessions  </Text>
                <Text color="green">[r]</Text>
                <Text> Refresh  </Text>
                <Text color="yellow">[q]</Text>
                <Text> Quit</Text>
              </Text>
            </Box>
          </Box>
        </>
      )}
    </Box>
  );
}
