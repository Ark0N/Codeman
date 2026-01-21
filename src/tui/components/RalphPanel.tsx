/**
 * @fileoverview RalphPanel component
 *
 * Displays Ralph Wiggum autonomous loop tracking information.
 *
 * @description
 * The Ralph Wiggum loop is an autonomous work mode where Claude
 * continues iterating on tasks until completion criteria are met.
 * This panel provides visibility into:
 * - Loop status (active/idle) and completion phrase
 * - Progress through todos with visual indicators
 * - Cycle count and elapsed time tracking
 *
 * @see {@link file://./../../inner-loop-tracker.ts} for detection logic
 * @see {@link file://./../../../docs/ralph-wiggum-guide.md} for full documentation
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { InnerLoopState, InnerTodoItem } from '../../types.js';

interface RalphPanelProps {
  loopState: InnerLoopState | null;
  todos: InnerTodoItem[];
  visible?: boolean;
}

/**
 * Returns the visual indicator for a todo item's status.
 *
 * @param status - The todo status: 'completed', 'in_progress', or 'pending'
 * @returns Object with Unicode icon and color name
 */
function getStatusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'completed':
      return { icon: '\u2713', color: 'green' };
    case 'in_progress':
      return { icon: '\u25CF', color: 'yellow' };
    case 'pending':
    default:
      return { icon: '\u25CB', color: 'gray' };
  }
}

/**
 * Formats elapsed hours to a compact human-readable string.
 *
 * @param hours - Elapsed time in hours (can be fractional)
 * @returns Formatted string like "45m" or "2.5h"
 */
function formatElapsed(hours: number | null): string {
  if (hours === null) return '-';
  if (hours < 1) {
    const minutes = Math.round(hours * 60);
    return `${minutes}m`;
  }
  return `${hours.toFixed(1)}h`;
}

/**
 * Panel component displaying Ralph Wiggum loop status and progress.
 *
 * @description
 * Renders a bordered panel with:
 * - Header showing loop status and completion phrase
 * - Stats row with cycle count, elapsed time, and todo progress
 * - Todo list (max 5 visible) with status icons
 *
 * Only renders when loop is enabled and has relevant data to show.
 *
 * @param props - Component props
 * @param props.loopState - Current loop state from InnerLoopTracker
 * @param props.todos - Array of todo items being tracked
 * @param props.visible - Whether the panel should be visible (default: true)
 * @returns The panel element or null if hidden/disabled
 */
export function RalphPanel({
  loopState,
  todos,
  visible = true,
}: RalphPanelProps): React.ReactElement | null {
  // Don't render if not visible or no loop state
  if (!visible || !loopState || !loopState.enabled) {
    return null;
  }

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta" marginBottom={1}>
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text color="magenta" bold>
          Ralph Loop {loopState.active ? '(active)' : '(idle)'}
        </Text>
        {loopState.completionPhrase && (
          <Text dimColor>
            phrase: {loopState.completionPhrase}
          </Text>
        )}
      </Box>

      {/* Stats row */}
      <Box paddingX={1}>
        <Text>
          <Text dimColor>cycles:</Text> {loopState.cycleCount}
          {loopState.maxIterations && <Text>/{loopState.maxIterations}</Text>}
          <Text> | </Text>
          <Text dimColor>elapsed:</Text> {formatElapsed(loopState.elapsedHours)}
          <Text> | </Text>
          <Text dimColor>todos:</Text> {completedCount}/{totalCount} ({progressPercent}%)
        </Text>
      </Box>

      {/* Todo list (max 5 items) */}
      {todos.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          {todos.slice(0, 5).map((todo) => {
            const { icon, color } = getStatusIcon(todo.status);
            const content = todo.content.length > 50
              ? todo.content.slice(0, 47) + '...'
              : todo.content;

            return (
              <Box key={todo.id}>
                <Text color={color}>{icon} </Text>
                <Text color={todo.status === 'completed' ? 'gray' : undefined}>
                  {content}
                </Text>
              </Box>
            );
          })}
          {todos.length > 5 && (
            <Text dimColor>... and {todos.length - 5} more</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
