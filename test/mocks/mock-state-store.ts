/**
 * Shared MockStateStore for tests.
 *
 * Includes methods for both session management and Ralph loop testing.
 * All methods are vi.fn() spies — tests can override return values as needed.
 *
 * NOTE: This is for direct instantiation in new tests. Existing tests that
 * use vi.mock('../src/state-store.js') keep their inline definitions.
 */
import { vi } from 'vitest';

export class MockStateStore {
  state: Record<string, unknown> = {
    sessions: {} as Record<string, unknown>,
    config: { maxConcurrentSessions: 5 },
    ralphLoop: { status: 'stopped' },
    tasks: {} as Record<string, unknown>,
  };

  // Session methods
  getConfig = vi.fn(() => this.state.config);
  getSessions = vi.fn(() => this.state.sessions as Record<string, unknown>);
  getSession = vi.fn((id: string) => (this.state.sessions as Record<string, unknown>)[id]);
  setSession = vi.fn((id: string, state: unknown) => {
    (this.state.sessions as Record<string, unknown>)[id] = state;
  });
  removeSession = vi.fn((id: string) => {
    delete (this.state.sessions as Record<string, unknown>)[id];
  });

  // Ralph state methods
  getRalphLoopState = vi.fn(() => this.state.ralphLoop);
  setRalphLoopState = vi.fn((update: Record<string, unknown>) => {
    this.state.ralphLoop = { ...(this.state.ralphLoop as Record<string, unknown>), ...update };
  });

  // Task methods
  getTasks = vi.fn(() => this.state.tasks);
  setTask = vi.fn();
  removeTask = vi.fn();

  // Settings methods
  getSettings = vi.fn(() => ({}));
  setSettings = vi.fn();

  // Generic persistence
  save = vi.fn();
  load = vi.fn();

  /** Reset all state and mocks for clean test isolation */
  reset(): void {
    this.state = {
      sessions: {},
      config: { maxConcurrentSessions: 5 },
      ralphLoop: { status: 'stopped' },
      tasks: {},
    };
    vi.clearAllMocks();
  }
}
