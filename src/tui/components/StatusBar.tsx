/**
 * @fileoverview StatusBar component
 *
 * Bottom status bar providing session information and navigation hints.
 *
 * @description
 * Displays real-time session metrics:
 * - Session name and connection status (alive/dead)
 * - Runtime duration since session creation
 * - Session mode (claude/shell)
 * - Respawn controller status when enabled
 * - Keyboard shortcut hints for quick reference
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ScreenSession } from '../../types.js';

interface RespawnStatus {
  enabled: boolean;
  state: string;
  cycleCount: number;
}

interface StatusBarProps {
  session: ScreenSession | null;
  inputMode?: boolean;
  respawnStatus?: RespawnStatus | null;
}

/**
 * Formats a duration from milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "45s", "5m 30s", or "2h 15m"
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Status bar component displaying session information and keyboard hints.
 *
 * @description
 * Renders a bordered bar at the bottom of the TUI with:
 * - Left side: Session name, status indicator, runtime, mode, respawn state
 * - Right side: Quick keyboard shortcut reference
 *
 * When no session is selected, displays a minimal bar with navigation hints.
 *
 * @param props - Component props
 * @param props.session - The currently active session or null
 * @param props.inputMode - Whether input mode is active (shows yellow indicator)
 * @param props.respawnStatus - Respawn controller status if enabled
 * @returns The status bar element
 */
export function StatusBar({ session, inputMode = false, respawnStatus }: StatusBarProps): React.ReactElement {
  if (!session) {
    return (
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text dimColor>No session selected</Text>
        <Text dimColor>Press ? for help | Esc to go back</Text>
      </Box>
    );
  }

  const runtime = formatDuration(Date.now() - session.createdAt);
  const statusColor = session.attached ? 'green' : 'red';
  const statusText = session.attached ? 'alive' : 'dead';
  const sessionName = session.name || 'unnamed';

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      {/* Left side: Session info */}
      <Box>
        <Text color="cyan" bold>
          {sessionName}
        </Text>
        <Text> | </Text>
        <Text color={statusColor} bold>
          {'\u25CF'} {statusText}
        </Text>
        <Text> | </Text>
        <Text>
          <Text dimColor>runtime:</Text> {runtime}
        </Text>
        <Text> | </Text>
        <Text>
          <Text dimColor>mode:</Text> {session.mode}
        </Text>
        {inputMode && (
          <>
            <Text> | </Text>
            <Text color="yellow" bold>INPUT MODE</Text>
          </>
        )}
        {respawnStatus?.enabled && (
          <>
            <Text> | </Text>
            <Text color="magenta">
              respawn: {respawnStatus.state.replace(/_/g, ' ')}
              {respawnStatus.cycleCount > 0 && ` (${respawnStatus.cycleCount})`}
            </Text>
          </>
        )}
      </Box>

      {/* Right side: Keyboard hints */}
      <Box>
        <Text dimColor>? help | Esc back | type to send input</Text>
      </Box>
    </Box>
  );
}
