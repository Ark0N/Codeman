/**
 * @fileoverview Unit tests for TmuxManager
 *
 * Tests validation functions, command construction, and parsing logic
 * using mocked exec calls. Does NOT create or kill real tmux sessions.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TmuxManager } from '../src/tmux-manager.js';
import { execSync } from 'node:child_process';

// Mock child_process
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    spawn: vi.fn(() => ({
      unref: vi.fn(),
      on: vi.fn(),
      pid: 12345,
    })),
  };
});

// Mock fs to avoid file I/O
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFile: vi.fn((_path: string, _data: string, cb: (err: Error | null) => void) => cb(null)),
  };
});

describe('TmuxManager', () => {
  let manager: TmuxManager;
  const mockedExecSync = vi.mocked(execSync);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: which claude returns /usr/local/bin/claude
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('which claude')) {
        return '/usr/local/bin/claude\n';
      }
      if (typeof cmd === 'string' && cmd.includes('which tmux')) {
        return '/usr/bin/tmux\n';
      }
      return '';
    });
    manager = new TmuxManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('backend', () => {
    it('should report tmux as backend', () => {
      expect(manager.backend).toBe('tmux');
    });
  });

  describe('getAttachCommand', () => {
    it('should return tmux', () => {
      expect(manager.getAttachCommand()).toBe('tmux');
    });
  });

  describe('getAttachArgs', () => {
    it('should return attach-session args', () => {
      const args = manager.getAttachArgs('claudeman-abc12345');
      expect(args).toEqual(['attach-session', '-t', 'claudeman-abc12345']);
    });
  });

  describe('isAvailable', () => {
    it('should return true when tmux is found', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          return '/usr/bin/tmux\n';
        }
        return '';
      });
      expect(TmuxManager.isTmuxAvailable()).toBe(true);
    });

    it('should return false when tmux is not found', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('which tmux')) {
          throw new Error('not found');
        }
        return '';
      });
      expect(TmuxManager.isTmuxAvailable()).toBe(false);
    });
  });

  describe('sendInput', () => {
    beforeEach(() => {
      // Register a session for sendInput tests
      manager.registerSession({
        sessionId: 'test-id',
        muxName: 'claudeman-1e571234',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should send text + Enter as two separate tmux commands', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      manager.sendInput('test-id', '/clear\r');

      // Should have 2 calls: send-keys -l text, then send-keys Enter
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('send-keys');
      expect(calls[0]).toContain('-l');
      expect(calls[0]).toContain('/clear');
      expect(calls[1]).toContain('send-keys');
      expect(calls[1]).toContain('Enter');
    });

    it('should send text only (no Enter) when no \\r present', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      manager.sendInput('test-id', 'hello world');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('send-keys');
      expect(calls[0]).toContain('-l');
      expect(calls[0]).not.toContain('Enter');
    });

    it('should send Enter only when input is just \\r', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      manager.sendInput('test-id', '\r');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('send-keys');
      expect(calls[0]).toContain('Enter');
      expect(calls[0]).not.toContain('-l');
    });

    it('should return false for unknown session', () => {
      const result = manager.sendInput('nonexistent', 'hello\r');
      expect(result).toBe(false);
    });

    it('should use -l flag for literal text (no key interpretation)', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      // Text that could be interpreted as tmux keys without -l
      manager.sendInput('test-id', 'C-c');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('-l');
    });

    it('should target the correct session name', () => {
      const calls: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('send-keys')) {
          calls.push(cmdStr);
        }
        return '';
      });

      manager.sendInput('test-id', 'test\r');

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toContain('claudeman-1e571234');
      }
    });
  });

  describe('reconcileSessions', () => {
    it('should detect alive sessions', async () => {
      manager.registerSession({
        sessionId: 'alive-1',
        muxName: 'claudeman-a11ce111',
        pid: 100,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('has-session')) {
          return ''; // exit 0 = exists
        }
        if (typeof cmd === 'string' && cmd.includes('display-message')) {
          return '100\n';
        }
        if (typeof cmd === 'string' && cmd.includes('list-sessions')) {
          return 'claudeman-a11ce111\n';
        }
        return '';
      });

      const result = await manager.reconcileSessions();
      expect(result.alive).toContain('alive-1');
      expect(result.dead).toHaveLength(0);
    });

    it('should detect dead sessions', async () => {
      manager.registerSession({
        sessionId: 'dead-1',
        muxName: 'claudeman-dead1111',
        pid: 200,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('has-session')) {
          throw new Error('session not found');
        }
        if (typeof cmd === 'string' && cmd.includes('list-sessions')) {
          return ''; // no sessions
        }
        return '';
      });

      const result = await manager.reconcileSessions();
      expect(result.dead).toContain('dead-1');
      expect(result.alive).toHaveLength(0);
    });

    it('should discover unknown claudeman sessions', async () => {
      // Use hex-only name to pass SAFE_MUX_NAME_PATTERN validation
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('list-sessions')) {
          return 'claudeman-abc12345\nmy-other-session\n';
        }
        if (typeof cmd === 'string' && cmd.includes('display-message') && cmd.includes('abc12345')) {
          return '999\n';
        }
        return '';
      });

      const result = await manager.reconcileSessions();
      expect(result.discovered).toHaveLength(1);
      expect(result.discovered[0]).toBe('restored-abc12345');
    });

    it('should not discover non-claudeman sessions', async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('list-sessions')) {
          return 'my-tmux-session\n';
        }
        return '';
      });

      const result = await manager.reconcileSessions();
      expect(result.discovered).toHaveLength(0);
    });
  });

  describe('metadata operations', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'meta-test',
        muxName: 'claudeman-ae1a1234',
        pid: 300,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should update session name', () => {
      const result = manager.updateSessionName('meta-test', 'My Session');
      expect(result).toBe(true);
      expect(manager.getSession('meta-test')?.name).toBe('My Session');
    });

    it('should return false for unknown session name update', () => {
      const result = manager.updateSessionName('nonexistent', 'Name');
      expect(result).toBe(false);
    });

    it('should set attached status', () => {
      manager.setAttached('meta-test', true);
      expect(manager.getSession('meta-test')?.attached).toBe(true);
      manager.setAttached('meta-test', false);
      expect(manager.getSession('meta-test')?.attached).toBe(false);
    });

    it('should update respawn config', () => {
      const config = { enabled: true, idleTimeoutMs: 5000, updatePrompt: 'test', interStepDelayMs: 1000, sendClear: true, sendInit: true };
      manager.updateRespawnConfig('meta-test', config);
      expect(manager.getSession('meta-test')?.respawnConfig).toEqual(config);
    });

    it('should clear respawn config', () => {
      manager.updateRespawnConfig('meta-test', { enabled: true, idleTimeoutMs: 5000, updatePrompt: 'test', interStepDelayMs: 1000, sendClear: true, sendInit: true });
      manager.clearRespawnConfig('meta-test');
      expect(manager.getSession('meta-test')?.respawnConfig).toBeUndefined();
    });

    it('should update ralph enabled', () => {
      manager.updateRalphEnabled('meta-test', true);
      expect(manager.getSession('meta-test')?.ralphEnabled).toBe(true);
    });
  });

  describe('getSessions', () => {
    it('should return all registered sessions', () => {
      manager.registerSession({
        sessionId: 's1',
        muxName: 'claudeman-51111111',
        pid: 1,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
      manager.registerSession({
        sessionId: 's2',
        muxName: 'claudeman-52222222',
        pid: 2,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell',
        attached: true,
      });

      const sessions = manager.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.sessionId)).toContain('s1');
      expect(sessions.map(s => s.sessionId)).toContain('s2');
    });
  });

  describe('stats collection', () => {
    it('should start and stop stats collection', () => {
      manager.startStatsCollection(60000);
      // No error thrown
      manager.stopStatsCollection();
      // No error thrown
    });
  });
});
