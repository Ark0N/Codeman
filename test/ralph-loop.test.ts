/**
 * @fileoverview Tests for RalphLoop autonomous task execution engine
 *
 * Tests the Ralph Loop orchestration including:
 * - Lifecycle management (start, stop, pause, resume)
 * - Task assignment to sessions
 * - Stats tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Use vi.hoisted to create mock state that can be accessed by both mocks and tests
const mockState = vi.hoisted(() => ({
  sessionManager: null as any,
  taskQueue: null as any,
  store: null as any,
}));

// Mock dependencies with factory functions that create fresh instances
vi.mock('../src/session-manager.js', () => {
  const { EventEmitter } = require('node:events');

  class MockSessionManager extends EventEmitter {
    sessions = new Map();
    getSessionCount = vi.fn(() => this.sessions.size);
    getIdleSessions = vi.fn(() => []);
    getBusySessions = vi.fn(() => []);
    getSession = vi.fn((id: string) => this.sessions.get(id));
  }

  const instance = new MockSessionManager();
  mockState.sessionManager = instance;

  return {
    getSessionManager: vi.fn(() => instance),
    SessionManager: MockSessionManager,
  };
});

vi.mock('../src/task-queue.js', () => {
  const { EventEmitter } = require('node:events');

  class MockTaskQueue extends EventEmitter {
    tasks: any[] = [];
    next = vi.fn(() => this.tasks.find((t: any) => t.status === 'pending') || null);
    getCount = vi.fn(() => ({
      total: this.tasks.length,
      pending: this.tasks.filter((t: any) => t.status === 'pending').length,
      running: this.tasks.filter((t: any) => t.status === 'running').length,
      completed: this.tasks.filter((t: any) => t.status === 'completed').length,
      failed: this.tasks.filter((t: any) => t.status === 'failed').length,
    }));
    getTask = vi.fn((id: string) => this.tasks.find((t: any) => t.id === id));
    updateTask = vi.fn();
    addTask = vi.fn((options: any) => {
      const task = { id: `task-${Date.now()}`, status: 'pending', ...options };
      this.tasks.push(task);
      return task;
    });
    getRunningTasks = vi.fn(() => this.tasks.filter((t: any) => t.status === 'running'));
    getRunningTaskForSession = vi.fn();
  }

  const instance = new MockTaskQueue();
  mockState.taskQueue = instance;

  return {
    getTaskQueue: vi.fn(() => instance),
    TaskQueue: MockTaskQueue,
  };
});

vi.mock('../src/state-store.js', () => {
  class MockStateStore {
    state: any = { ralphLoop: { status: 'stopped' }, tasks: {}, config: { pollIntervalMs: 1000 } };
    getConfig = vi.fn(() => this.state.config);
    getRalphLoopState = vi.fn(() => this.state.ralphLoop);
    setRalphLoopState = vi.fn((update: any) => {
      this.state.ralphLoop = { ...this.state.ralphLoop, ...update };
    });
    getTasks = vi.fn(() => this.state.tasks);
    setTask = vi.fn();
    removeTask = vi.fn();
  }

  const instance = new MockStateStore();
  mockState.store = instance;

  return {
    getStore: vi.fn(() => instance),
    StateStore: MockStateStore,
  };
});

// Import after mocking
import { RalphLoop, getRalphLoop } from '../src/ralph-loop.js';

describe('RalphLoop', () => {
  let loop: RalphLoop;

  beforeEach(() => {
    vi.useFakeTimers();

    // Reset mock state
    if (mockState.sessionManager) {
      mockState.sessionManager.sessions.clear();
    }
    if (mockState.taskQueue) {
      mockState.taskQueue.tasks = [];
    }
    if (mockState.store) {
      mockState.store.state = {
        ralphLoop: { status: 'stopped' },
        tasks: {},
        config: { pollIntervalMs: 1000 },
      };
    }

    // Reset mock functions
    vi.clearAllMocks();

    // Create fresh loop
    loop = new RalphLoop({ pollIntervalMs: 100 });
  });

  afterEach(() => {
    // Use destroy() instead of stop() to clean up event listeners
    loop.destroy();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in stopped status', () => {
      expect(loop.status).toBe('stopped');
      expect(loop.isRunning()).toBe(false);
    });

    it('should have zero elapsed time', () => {
      expect(loop.getElapsedMs()).toBe(0);
      expect(loop.getElapsedHours()).toBe(0);
    });

    it('should report min duration reached when no minimum set', () => {
      expect(loop.isMinDurationReached()).toBe(true);
    });
  });

  describe('start', () => {
    it('should change status to running', async () => {
      await loop.start();

      expect(loop.status).toBe('running');
      expect(loop.isRunning()).toBe(true);
    });

    it('should emit started event', async () => {
      const handler = vi.fn();
      loop.on('started', handler);

      await loop.start();

      expect(handler).toHaveBeenCalled();
    });

    it('should persist state to store', async () => {
      await loop.start();

      expect(mockState.store.setRalphLoopState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'running',
          tasksCompleted: 0,
          tasksGenerated: 0,
        })
      );
    });

    it('should not start if already running', async () => {
      await loop.start();
      const handler = vi.fn();
      loop.on('started', handler);

      await loop.start();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should change status to stopped', async () => {
      await loop.start();

      loop.stop();

      expect(loop.status).toBe('stopped');
      expect(loop.isRunning()).toBe(false);
    });

    it('should emit stopped event', async () => {
      await loop.start();
      const handler = vi.fn();
      loop.on('stopped', handler);

      loop.stop();

      expect(handler).toHaveBeenCalled();
    });

    it('should not stop if already stopped', () => {
      const handler = vi.fn();
      loop.on('stopped', handler);

      loop.stop();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('pause and resume', () => {
    it('should pause a running loop', async () => {
      await loop.start();

      loop.pause();

      expect(loop.status).toBe('paused');
    });

    it('should not pause if not running', () => {
      loop.pause();

      expect(loop.status).toBe('stopped');
    });

    it('should resume a paused loop', async () => {
      await loop.start();
      loop.pause();

      loop.resume();

      expect(loop.status).toBe('running');
    });

    it('should not resume if not paused', async () => {
      await loop.start();

      loop.resume(); // Should have no effect since it's running, not paused

      expect(loop.status).toBe('running');
    });
  });

  describe('getElapsedMs and getElapsedHours', () => {
    it('should track elapsed time', async () => {
      await loop.start();

      vi.advanceTimersByTime(3600000); // 1 hour

      expect(loop.getElapsedMs()).toBe(3600000);
      expect(loop.getElapsedHours()).toBe(1);
    });
  });

  describe('isMinDurationReached', () => {
    it('should return true when no minimum set', () => {
      expect(loop.isMinDurationReached()).toBe(true);
    });

    it('should return false before minimum reached', async () => {
      loop.setMinDuration(1); // 1 hour
      await loop.start();

      vi.advanceTimersByTime(1800000); // 30 minutes

      expect(loop.isMinDurationReached()).toBe(false);
    });

    it('should return true after minimum reached', async () => {
      loop.setMinDuration(1); // 1 hour
      await loop.start();

      vi.advanceTimersByTime(3600001); // Just over 1 hour

      expect(loop.isMinDurationReached()).toBe(true);
    });
  });

  describe('setMinDuration', () => {
    it('should set minimum duration in hours', () => {
      loop.setMinDuration(2); // 2 hours

      expect(mockState.store.setRalphLoopState).toHaveBeenCalledWith({
        minDurationMs: 7200000, // 2 hours in ms
      });
    });
  });

  describe('getStats', () => {
    it('should return complete stats object', async () => {
      const mockRunningTask = { id: '2', status: 'running', isTimedOut: () => false };
      mockState.taskQueue.tasks = [
        { id: '1', status: 'pending' },
        mockRunningTask,
        { id: '3', status: 'completed' },
      ];
      mockState.taskQueue.getRunningTasks.mockReturnValue([mockRunningTask]);

      await loop.start();
      vi.advanceTimersByTime(60000); // 1 minute

      const stats = loop.getStats();

      expect(stats.status).toBe('running');
      expect(stats.elapsedMs).toBe(60000);
      expect(stats.minDurationReached).toBe(true);
      expect(stats.tasksCompleted).toBe(0);
      expect(stats.tasksGenerated).toBe(0);
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.completed).toBe(1);
    });
  });

  describe('automatic stopping', () => {
    it('should stop when all tasks are done and min duration reached', async () => {
      mockState.taskQueue.tasks = [];
      mockState.taskQueue.getCount.mockReturnValue({
        total: 0,
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
      });
      mockState.taskQueue.getRunningTasks.mockReturnValue([]);

      await loop.start();
      // Need to advance timers and await for the tick to complete
      await vi.advanceTimersByTimeAsync(100);

      expect(loop.status).toBe('stopped');
    });

    it('should not stop if pending tasks exist', async () => {
      mockState.taskQueue.tasks = [{ id: '1', status: 'pending' }];
      mockState.taskQueue.getCount.mockReturnValue({
        total: 1,
        pending: 1,
        running: 0,
        completed: 0,
        failed: 0,
      });
      mockState.taskQueue.getRunningTasks.mockReturnValue([]);

      await loop.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(loop.status).toBe('running');
    });

    it('should not stop if running tasks exist', async () => {
      const mockTask = { id: '1', status: 'running', isTimedOut: () => false };
      mockState.taskQueue.tasks = [mockTask];
      mockState.taskQueue.getCount.mockReturnValue({
        total: 1,
        pending: 0,
        running: 1,
        completed: 0,
        failed: 0,
      });
      mockState.taskQueue.getRunningTasks.mockReturnValue([mockTask]);

      await loop.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(loop.status).toBe('running');
    });
  });
});

describe('getRalphLoop singleton', () => {
  it('should return a RalphLoop instance', () => {
    const loop = getRalphLoop();
    expect(loop).toBeInstanceOf(RalphLoop);
  });
});
