/**
 * @fileoverview StartScreen component
 *
 * Initial screen shown when TUI launches. Displays:
 * - List of existing screen sessions from ~/.claudeman/screens.json
 * - Session status (alive/dead), runtime, mode
 * - Arrow key navigation with highlighted selection
 * - Options to select, create, attach, or refresh sessions
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ScreenSession } from '../../types.js';

interface StartScreenProps {
  sessions: ScreenSession[];
  onSelectSession: (session: ScreenSession) => void;
  onAttachSession: (session: ScreenSession) => void;
  onCreateSession: () => void;
  onRefresh: () => void;
  onExit: () => void;
}

/**
 * Formats duration from milliseconds to human-readable string
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
 * Start screen component showing session list with arrow key navigation
 */
export function StartScreen({
  sessions,
  onSelectSession,
  onAttachSession,
  onCreateSession,
  onRefresh,
  onExit,
}: StartScreenProps): React.ReactElement {
  const now = Date.now();
  const [selectedIndex, setSelectedIndex] = useState(0);

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
