/**
 * @fileoverview StartScreen component
 *
 * Session discovery and selection interface for the TUI.
 *
 * @description
 * The initial screen displayed when launching `claudeman tui`:
 * - Reads session list from ~/.claudeman/screens.json
 * - Shows session name, runtime, status (alive/dead), and mode
 * - Arrow key navigation with visual selection highlight
 * - Actions: Enter (view), a (attach), d (delete), n (new), r (refresh), q (quit)
 *
 * This is the "home screen" users return to with Escape from the main view.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScreenSession } from '../../types.js';

interface StartScreenProps {
  sessions: ScreenSession[];
  onSelectSession: (session: ScreenSession) => void;
  onAttachSession: (session: ScreenSession) => void;
  onDeleteSession: (session: ScreenSession) => void;
  onCreateSession: () => void;
  onRefresh: () => void;
  onExit: () => void;
}

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
 * Renders a table of available sessions with:
 * - Arrow key navigation (wraps at boundaries)
 * - Visual selection highlight (blue background)
 * - Status indicators (green=alive, red=dead)
 * - Runtime and mode information
 *
 * **Keyboard Shortcuts:**
 * - `↑/↓`: Navigate selection
 * - `Enter`: View session in TUI
 * - `a`: Attach directly to screen (exits TUI)
 * - `d/x`: Delete/kill selected session
 *
 * @param props - Component props
 * @param props.sessions - Array of sessions to display
 * @param props.onSelectSession - Callback to view session in TUI
 * @param props.onAttachSession - Callback to attach directly to screen
 * @param props.onDeleteSession - Callback to delete/kill session
 * @param props.onCreateSession - Callback to create new session
 * @param props.onRefresh - Callback to refresh session list
 * @param props.onExit - Callback to exit TUI
 * @returns The start screen element
 */
export function StartScreen({
  sessions,
  onSelectSession,
  onAttachSession,
  onDeleteSession,
  onCreateSession,
  onRefresh,
  onExit,
}: StartScreenProps): React.ReactElement {
  const now = Date.now();
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Ensure selectedIndex is valid when sessions change
  React.useEffect(() => {
    if (selectedIndex >= sessions.length && sessions.length > 0) {
      setSelectedIndex(sessions.length - 1);
    }
  }, [sessions.length, selectedIndex]);

  // Handle keyboard input for navigation
  useInput((input, key) => {
    // Arrow key navigation
    if (key.upArrow && sessions.length > 0) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : sessions.length - 1));
      return;
    }
    if (key.downArrow && sessions.length > 0) {
      setSelectedIndex((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
      return;
    }

    // Enter to view session in TUI
    if (key.return && sessions.length > 0) {
      onSelectSession(sessions[selectedIndex]);
      return;
    }

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
  });

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

      <Box marginY={1}>
        <Text dimColor>Session Manager - Press ? for help</Text>
      </Box>

      {/* Session list */}
      {sessions.length === 0 ? (
        <Box flexDirection="column" marginY={1}>
          <Text color="yellow">No sessions found</Text>
          <Text dimColor>Press [n] to create a new session</Text>
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

      {/* Footer with controls */}
      <Box marginTop={2} flexDirection="column">
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text>
            <Text color="green">[n]</Text>
            <Text> New  </Text>
            <Text color="green">[{'\u2191\u2193'}]</Text>
            <Text> Navigate  </Text>
            <Text color="green">[Enter]</Text>
            <Text> View  </Text>
            <Text color="green">[a]</Text>
            <Text> Attach  </Text>
            <Text color="red">[d]</Text>
            <Text> Delete  </Text>
            <Text color="green">[r]</Text>
            <Text> Refresh  </Text>
            <Text color="yellow">[q]</Text>
            <Text> Quit</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
