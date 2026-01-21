/**
 * @fileoverview TabBar component
 *
 * Horizontal tab bar for session navigation in the TUI.
 *
 * @description
 * Provides browser-like tab navigation for Claude sessions:
 * - Active tab highlighted with blue background
 * - Status indicators: green dot (alive) or red dot (dead)
 * - Session names truncated to 15 characters
 * - Keyboard shortcut hints on the right
 *
 * Tab switching is handled by parent via keyboard shortcuts (Ctrl+Tab).
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ScreenSession } from '../../types.js';

interface TabBarProps {
  sessions: ScreenSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}

/**
 * Tab bar component showing all available sessions.
 *
 * @description
 * Renders a horizontal bar with one tab per session, showing:
 * - Status indicator (filled/hollow circle for alive/dead)
 * - Session name (truncated to 15 chars)
 * - Visual highlighting for the active session
 *
 * @param props - Component props
 * @param props.sessions - Array of all sessions to display as tabs
 * @param props.activeSessionId - ID of currently active session for highlighting
 * @param props.onSelectSession - Callback when a tab is clicked (unused, keyboard nav only)
 * @returns The tab bar element
 */
export function TabBar({
  sessions,
  activeSessionId,
}: TabBarProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>No sessions</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      {sessions.map((session, index) => {
        const isActive = session.sessionId === activeSessionId;
        const name = (session.name || 'unnamed').slice(0, 15);
        // Status indicator: filled circle for alive, hollow for dead
        const statusIcon = session.attached ? '\u25CF' : '\u25CB';
        const statusColor = session.attached ? 'green' : 'red';

        return (
          <Box key={session.sessionId} marginRight={1}>
            {isActive ? (
              <Text backgroundColor="blue" color="white" bold>
                {' '}
                <Text color={statusColor}>{statusIcon}</Text> {name}{' '}
              </Text>
            ) : (
              <Text>
                {' '}
                <Text color={statusColor}>{statusIcon}</Text>{' '}
                <Text dimColor>{name}</Text>{' '}
              </Text>
            )}
            {index < sessions.length - 1 && <Text dimColor>|</Text>}
          </Box>
        );
      })}

      {/* Shortcut hint */}
      <Box flexGrow={1} justifyContent="flex-end">
        <Text dimColor>Ctrl+Tab: switch | Ctrl+W: close</Text>
      </Box>
    </Box>
  );
}
