/**
 * @fileoverview HelpOverlay component
 *
 * Full-screen overlay showing all keyboard shortcuts.
 * Dismissible with Escape, q, or ?.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface HelpOverlayProps {
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Array<{ key: string; description: string }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Start Screen',
    shortcuts: [
      { key: '\u2191/\u2193', description: 'Navigate session list' },
      { key: 'Enter', description: 'View session in TUI' },
      { key: 'a', description: 'Attach to screen (full terminal)' },
      { key: 'n', description: 'Create new session' },
      { key: 'r', description: 'Refresh session list' },
      { key: 'q', description: 'Quit' },
    ],
  },
  {
    title: 'Main View - Navigation',
    shortcuts: [
      { key: 'Ctrl+Tab', description: 'Next session tab' },
      { key: 'Ctrl+Shift+Tab', description: 'Previous session tab' },
      { key: 'Ctrl+1-9', description: 'Go to session N' },
      { key: 'Escape', description: 'Back to start screen' },
    ],
  },
  {
    title: 'Main View - Session Management',
    shortcuts: [
      { key: 'Ctrl+N', description: 'New session' },
      { key: 'Ctrl+W', description: 'Close current session' },
      { key: 'Ctrl+K', description: 'Kill all sessions' },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { key: '?', description: 'Toggle this help' },
      { key: 'Ctrl+C', description: 'Exit TUI' },
    ],
  },
];

/**
 * HelpOverlay component showing keyboard shortcuts
 */
export function HelpOverlay({ onClose }: HelpOverlayProps): React.ReactElement {
  return (
    <Box flexDirection="column" padding={2}>
      {/* Header */}
      <Box
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        marginBottom={1}
        justifyContent="center"
      >
        <Text bold color="cyan">
          Keyboard Shortcuts
        </Text>
      </Box>

      {/* Shortcut groups */}
      {SHORTCUT_GROUPS.map((group, groupIndex) => (
        <Box key={groupIndex} flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">
            {group.title}
          </Text>
          <Box flexDirection="column" marginLeft={2}>
            {group.shortcuts.map((shortcut, index) => (
              <Box key={index}>
                <Text color="green">{shortcut.key.padEnd(20)}</Text>
                <Text>{shortcut.description}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      ))}

      {/* Footer */}
      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>Press Escape, q, or ? to close</Text>
      </Box>
    </Box>
  );
}
