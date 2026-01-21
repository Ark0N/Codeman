/**
 * @fileoverview Tests for SessionManager
 *
 * Tests session lifecycle management including creation,
 * event forwarding, and state persistence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock state that can be accessed by both mocks and tests
const mockState = vi.hoisted(() => ({
  store: null as any,
  sessions: new Map<string, any>(),
}));

// Mock the state-store
vi.mock('../src/state-store.js', () => {
  class MockStateStore {
    state: any = {
      sessions: {},
      config: { maxConcurrentSessions: 5 },
    };
    getConfig = vi.fn(() => this.state.config);
    getSessions = vi.fn(() => this.state.sessions);
    getSession = vi.fn((id: string) => this.state.sessions[id]);
    setSession = vi.fn((id: string, state: any) => {
      this.state.sessions[id] = state;
    });
    removeSession = vi.fn((id: string) => {
      delete this.state.sessions[id];
    });
  }

  const instance = new MockStateStore();
  mockState.store = instance;

  return {
    getStore: vi.fn(() => instance),
    StateStore: MockStateStore,
  };
});

// Mock the Session class
vi.mock('../src/session.js', () => {
  const { EventEmitter } = require('node:events');

  class MockSession extends EventEmitter {
    id: string;
    workingDir: string;
    _started = false;
    _stopped = false;

    constructor(options: { workingDir: string }) {
      super();
      this.id = `session-${Math.random().toString(36).substr(2, 9)}`;
      this.workingDir = options.workingDir;
      mockState.sessions.set(this.id, this);
    }

    async start() {
      this._started = true;
      return this;
    }

    async stop() {
      this._stopped = true;
      this.emit('exit');
    }

    toState() {
      return {
        id: this.id,
        workingDir: this.workingDir,
        status: this._stopped ? 'stopped' : this._started ? 'running' : 'pending',
        pid: this._started && !this._stopped ? 12345 : null,
      };
    }

    getOutput() {
      return 'mock output';
    }

    getError() {
      return null;
    }

    isIdle() {
      return true;
    }

    isBusy() {
      return false;
    }

    async sendInput(input: string) {
      // Mock implementation
    }
  }

  return {
    Session: MockSession,
  };
});

// Import after mocking
import { SessionManager, getSessionManager } from '../src/session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    // Reset mock state
    mockState.sessions.clear();
    if (mockState.store) {
      mockState.store.state = {
        sessions: {},
        config: { maxConcurrentSessions: 5 },
      };
    }

    // Reset mock functions
    vi.clearAllMocks();

    // Create fresh manager
    manager = new SessionManager();
  });

  describe('createSession', () => {
    it('should create and start a new session', async () => {
      const session = await manager.createSession('/tmp/test');

      expect(session).toBeDefined();
      expect(session.workingDir).toBe('/tmp/test');
      expect(manager.hasSession(session.id)).toBe(true);
    });

    it('should emit sessionStarted event', async () => {
      const handler = vi.fn();
      manager.on('sessionStarted', handler);

      const session = await manager.createSession('/tmp/test');

      expect(handler).toHaveBeenCalledWith(session);
    });

    it('should persist session to store', async () => {
      const session = await manager.createSession('/tmp/test');

      expect(mockState.store.setSession).toHaveBeenCalledWith(
        session.id,
        expect.any(Object)
      );
    });

    it('should throw when max sessions reached', async () => {
      mockState.store.state.config.maxConcurrentSessions = 1;
      await manager.createSession('/tmp/test1');

      await expect(manager.createSession('/tmp/test2')).rejects.toThrow(
        /Maximum concurrent sessions/
      );
    });

    it('should forward session output events', async () => {
      const handler = vi.fn();
      manager.on('sessionOutput', handler);

      const session = await manager.createSession('/tmp/test');
      session.emit('output', 'test output');

      expect(handler).toHaveBeenCalledWith(session.id, 'test output');
    });

    it('should forward session error events', async () => {
      const handler = vi.fn();
      manager.on('sessionError', handler);

      const session = await manager.createSession('/tmp/test');
      session.emit('error', 'test error');

      expect(handler).toHaveBeenCalledWith(session.id, 'test error');
    });

    it('should forward session completion events', async () => {
      const handler = vi.fn();
      manager.on('sessionCompletion', handler);

      const session = await manager.createSession('/tmp/test');
      session.emit('completion', 'DONE');

      expect(handler).toHaveBeenCalledWith(session.id, 'DONE');
    });

    it('should forward session exit events', async () => {
      const handler = vi.fn();
      manager.on('sessionStopped', handler);

      const session = await manager.createSession('/tmp/test');
      session.emit('exit');

      expect(handler).toHaveBeenCalledWith(session.id);
    });
  });

  describe('stopSession', () => {
    it('should stop a session by ID', async () => {
      const session = await manager.createSession('/tmp/test');

      await manager.stopSession(session.id);

      expect((session as any)._stopped).toBe(true);
    });

    it('should handle non-existent session gracefully', async () => {
      await expect(manager.stopSession('non-existent')).resolves.not.toThrow();
    });

    it('should update stored session to stopped', async () => {
      // Set up a session in store
      mockState.store.state.sessions['stored-session'] = {
        id: 'stored-session',
        status: 'running',
        pid: 12345,
      };

      await manager.stopSession('stored-session');

      expect(mockState.store.setSession).toHaveBeenCalledWith(
        'stored-session',
        expect.objectContaining({
          status: 'stopped',
          pid: null,
        })
      );
    });
  });

  describe('stopAllSessions', () => {
    it('should stop all active sessions', async () => {
      const session1 = await manager.createSession('/tmp/test1');
      const session2 = await manager.createSession('/tmp/test2');

      await manager.stopAllSessions();

      expect((session1 as any)._stopped).toBe(true);
      expect((session2 as any)._stopped).toBe(true);
    });
  });

  describe('getSession', () => {
    it('should return undefined for non-existent session', () => {
      expect(manager.getSession('non-existent')).toBeUndefined();
    });

    it('should return the correct session', async () => {
      const session = await manager.createSession('/tmp/test');

      expect(manager.getSession(session.id)).toBe(session);
    });
  });

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', () => {
      expect(manager.getAllSessions()).toEqual([]);
    });

    it('should return all sessions', async () => {
      const session1 = await manager.createSession('/tmp/test1');
      const session2 = await manager.createSession('/tmp/test2');

      const sessions = manager.getAllSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions).toContain(session1);
      expect(sessions).toContain(session2);
    });
  });

  describe('getIdleSessions', () => {
    it('should return sessions that are idle', async () => {
      const session = await manager.createSession('/tmp/test');

      const idle = manager.getIdleSessions();

      expect(idle).toContain(session);
    });
  });

  describe('getBusySessions', () => {
    it('should return empty when all sessions are idle', async () => {
      await manager.createSession('/tmp/test');

      const busy = manager.getBusySessions();

      expect(busy).toHaveLength(0);
    });
  });

  describe('getSessionCount', () => {
    it('should return 0 when no sessions', () => {
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should return correct count', async () => {
      await manager.createSession('/tmp/test1');
      await manager.createSession('/tmp/test2');

      expect(manager.getSessionCount()).toBe(2);
    });
  });

  describe('hasSession', () => {
    it('should return false for non-existent session', () => {
      expect(manager.hasSession('non-existent')).toBe(false);
    });

    it('should return true for existing session', async () => {
      const session = await manager.createSession('/tmp/test');

      expect(manager.hasSession(session.id)).toBe(true);
    });
  });

  describe('sendToSession', () => {
    it('should throw for non-existent session', async () => {
      await expect(manager.sendToSession('non-existent', 'test')).rejects.toThrow(
        /Session non-existent not found/
      );
    });

    it('should send input to session', async () => {
      const session = await manager.createSession('/tmp/test');
      const sendSpy = vi.spyOn(session as any, 'sendInput');

      await manager.sendToSession(session.id, 'test input');

      expect(sendSpy).toHaveBeenCalledWith('test input');
    });
  });

  describe('getSessionOutput', () => {
    it('should return null for non-existent session', () => {
      expect(manager.getSessionOutput('non-existent')).toBeNull();
    });

    it('should return session output', async () => {
      const session = await manager.createSession('/tmp/test');

      expect(manager.getSessionOutput(session.id)).toBe('mock output');
    });
  });

  describe('getSessionError', () => {
    it('should return null for non-existent session', () => {
      expect(manager.getSessionError('non-existent')).toBeNull();
    });

    it('should return session error', async () => {
      const session = await manager.createSession('/tmp/test');

      expect(manager.getSessionError(session.id)).toBeNull();
    });
  });
});

describe('getSessionManager singleton', () => {
  it('should return a SessionManager instance', () => {
    const manager = getSessionManager();
    expect(manager).toBeInstanceOf(SessionManager);
  });
});
