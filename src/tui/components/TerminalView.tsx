/**
 * @fileoverview TerminalView component
 *
 * Primary terminal output display for Claude session monitoring.
 *
 * @description
 * Renders the terminal output from a GNU screen session:
 * - Viewport shows last N lines based on available height
 * - Line splitting is memoized for performance
 * - Visual border color indicates session state (green=active, gray=none)
 * - Long lines are truncated to prevent wrapping issues
 *
 * Output is obtained via screen hardcopy polling in useSessionManager.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ScreenSession } from '../../types.js';

interface TerminalViewProps {
  output: string;
  height: number;
  session: ScreenSession | null;
}

/**
 * Terminal view component for displaying session output.
 *
 * @description
 * Shows the last N lines of terminal output that fit within the given height.
 * When no session is selected, displays a placeholder message.
 *
 * @param props - Component props
 * @param props.output - Raw terminal output string from screen hardcopy
 * @param props.height - Available height in terminal rows (includes border)
 * @param props.session - The active session or null
 * @returns The terminal view element
 */
export function TerminalView({
  output,
  height,
  session,
}: TerminalViewProps): React.ReactElement {
  // Split output into lines and get the last N lines that fit
  const displayLines = useMemo(() => {
    if (!output) return [];

    const lines = output.split('\n');
    // Reserve 2 lines for border
    const visibleLines = height - 2;

    if (lines.length <= visibleLines) {
      return lines;
    }

    // Return last N lines
    return lines.slice(-visibleLines);
  }, [output, height]);

  if (!session) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        height={height}
        paddingX={1}
      >
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text dimColor>No session selected</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="green"
      height={height}
      paddingX={1}
      overflow="hidden"
    >
      {/* Terminal content */}
      <Box flexDirection="column" flexGrow={1}>
        {displayLines.length === 0 ? (
          <Text dimColor>Waiting for output...</Text>
        ) : (
          displayLines.map((line, index) => (
            <Text key={index} wrap="truncate">
              {line}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
