/**
 * @fileoverview Unit + integration tests for TmuxManager
 *
 * Unit tests (mocked): validation, command construction, parsing logic.
 * Integration tests (real tmux): session creation, input, kill, reconciliation.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TmuxManager } from '../src/tmux-manager.js';
import { execSync } from 'node:child_process';

// ============================================================================
// Unit Tests (mocked)
// ============================================================================

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

describe('TmuxManager (unit)', () => {
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
      const args = manager.getAttachArgs('codeman-abc12345');
      expect(args).toEqual(['attach-session', '-t', 'codeman-abc12345']);
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

  // NOTE: In test mode (VITEST=1), sendInput is a no-op that returns true
  // without calling execSync. This prevents tests from sending input to real tmux.
  describe('sendInput (test mode safety)', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'test-id',
        muxName: 'codeman-1e571234',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
    });

    it('should return true for registered session (no-op in test mode)', async () => {
      expect(await manager.sendInput('test-id', '/clear\r')).toBe(true);
    });

    it('should return false for unknown session', async () => {
      expect(await manager.sendInput('nonexistent', 'hello\r')).toBe(false);
    });

    it('should not call any tmux commands in test mode', async () => {
      mockedExecSync.mockClear();
      await manager.sendInput('test-id', 'hello\r');
      const sendKeyCalls = mockedExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('send-keys')
      );
      expect(sendKeyCalls).toHaveLength(0);
    });
  });

  // NOTE: In test mode, reconcileSessions returns all registered sessions as
  // alive without running any real tmux commands. This prevents discovery of
  // or interaction with the user's real tmux sessions.
  describe('reconcileSessions (test mode safety)', () => {
    it('should return all registered sessions as alive', async () => {
      manager.registerSession({
        sessionId: 'alive-1',
        muxName: 'codeman-a11ce111',
        pid: 100,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const result = await manager.reconcileSessions();
      expect(result.alive).toContain('alive-1');
      expect(result.dead).toHaveLength(0);
      expect(result.discovered).toHaveLength(0);
    });

    it('should never discover real tmux sessions', async () => {
      const result = await manager.reconcileSessions();
      expect(result.discovered).toHaveLength(0);
    });

    it('should not call any tmux commands in test mode', async () => {
      mockedExecSync.mockClear();
      await manager.reconcileSessions();
      const tmuxCalls = mockedExecSync.mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && (cmd.includes('has-session') || cmd.includes('list-sessions'))
      );
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  // NOTE: In test mode, killSession removes from memory without running any
  // real kill commands. The self-kill protection is not needed because no real
  // tmux commands are executed — sessions are only removed from the in-memory map.
  describe('killSession (test mode safety)', () => {
    it('should remove session from memory in test mode', async () => {
      manager.registerSession({
        sessionId: 'kill-test',
        muxName: 'codeman-5e1f1111',
        pid: 999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });

      const result = await manager.killSession('kill-test');
      expect(result).toBe(true);
      expect(manager.getSession('kill-test')).toBeUndefined();
    });

    it('should allow kill when session does NOT match CODEMAN_MUX_NAME', async () => {
      const originalEnv = process.env.CODEMAN_MUX_NAME;
      process.env.CODEMAN_MUX_NAME = 'codeman-0ther1111';

      try {
        manager.registerSession({
          sessionId: 'other-kill-test',
          muxName: 'codeman-d1ff1111',
          pid: 888,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        // Mock the kill flow
        mockedExecSync.mockImplementation(() => '');

        const result = await manager.killSession('other-kill-test');
        expect(result).toBe(true);

        // Session should be removed
        expect(manager.getSession('other-kill-test')).toBeUndefined();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CODEMAN_MUX_NAME;
        } else {
          process.env.CODEMAN_MUX_NAME = originalEnv;
        }
      }
    });

    it('should allow kill when CODEMAN_MUX_NAME is not set', async () => {
      const originalEnv = process.env.CODEMAN_MUX_NAME;
      delete process.env.CODEMAN_MUX_NAME;

      try {
        manager.registerSession({
          sessionId: 'no-env-test',
          muxName: 'codeman-aaa11111',
          pid: 777,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode: 'claude',
          attached: false,
        });

        mockedExecSync.mockImplementation(() => '');

        const result = await manager.killSession('no-env-test');
        expect(result).toBe(true);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CODEMAN_MUX_NAME;
        } else {
          process.env.CODEMAN_MUX_NAME = originalEnv;
        }
      }
    });
  });

  describe('metadata operations', () => {
    beforeEach(() => {
      manager.registerSession({
        sessionId: 'meta-test',
        muxName: 'codeman-ae1a1234',
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
        muxName: 'codeman-51111111',
        pid: 1,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude',
        attached: false,
      });
      manager.registerSession({
        sessionId: 's2',
        muxName: 'codeman-52222222',
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

