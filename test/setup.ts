/**
 * @fileoverview Global test setup for Claudeman tests
 *
 * SAFETY: TmuxManager has built-in test mode detection
 * (via process.env.VITEST) that makes ALL shell commands no-ops.
 * This means tests CANNOT kill, create, or interact with real tmux
 * sessions regardless of what the test code does.
 *
 * This setup file only handles mock/timer cleanup between tests.
 */

import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
