/**
 * @fileoverview Unit tests for tmux session recovery after server restart.
 *
 * Tests verify the test mode safety behavior of TmuxManager:
 * - In test mode (VITEST=1), reconcileSessions never runs real tmux commands
 * - All registered sessions are reported as alive
 * - No real sessions are discovered
 * - No state files are read/written
 *
 * SAFETY: No real tmux sessions are created, killed, or interacted with.
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

// Mock fs to avoid reading/writing real state files
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFile: vi.fn((_path: string, _data: string, cb: (err: Error | null) => void) => cb(null)),
    writeFileSync: vi.fn(),
  };
});

describe('TmuxManager restart recovery (test mode safety)', () => {
  let manager: TmuxManager;
  const mockedExecSync = vi.mocked(execSync);

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TmuxManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it('should report all registered sessions as alive in test mode', async () => {
    manager.registerSession({
      sessionId: 'test-recovery-1',
      muxName: 'codeman-de51ecaf',
      pid: 1,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'claude',
      attached: false,
      name: 'Recovery Test',
      respawnConfig: { enabled: true, idleTimeoutMs: 10000, updatePrompt: 'continue', interStepDelayMs: 2000, sendClear: false, sendInit: true },
    });

    const result = await manager.reconcileSessions();
    expect(result.alive).toContain('test-recovery-1');
    expect(result.dead).toHaveLength(0);
    expect(result.discovered).toHaveLength(0);

    // Session metadata should be preserved
    const recovered = manager.getSession('test-recovery-1');
    expect(recovered).toBeDefined();
    expect(recovered!.name).toBe('Recovery Test');
    expect(recovered!.respawnConfig?.enabled).toBe(true);
  });

  it('should never discover real sessions in test mode', async () => {
    const result = await manager.reconcileSessions();
    expect(result.discovered).toHaveLength(0);
  });

  it('should not execute any tmux commands in test mode', async () => {
    manager.registerSession({
      sessionId: 'alive-session',
      muxName: 'codeman-a11eeaaa',
      pid: 1,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'claude',
      attached: false,
    });

    mockedExecSync.mockClear();
    await manager.reconcileSessions();

    // Verify no tmux commands were executed
    const tmuxCalls = mockedExecSync.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('tmux')
    );
    expect(tmuxCalls).toHaveLength(0);
  });

  it('should handle multiple sessions correctly in test mode', async () => {
    manager.registerSession({
      sessionId: 'session-1',
      muxName: 'codeman-a11eeaaa',
      pid: 1,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'claude',
      attached: false,
      name: 'Session 1',
    });
    manager.registerSession({
      sessionId: 'session-2',
      muxName: 'codeman-b22ffbbb',
      pid: 2,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'shell',
      attached: false,
      name: 'Session 2',
    });

    const result = await manager.reconcileSessions();
    expect(result.alive).toContain('session-1');
    expect(result.alive).toContain('session-2');
    expect(result.alive).toHaveLength(2);
    expect(result.dead).toHaveLength(0);
    expect(result.discovered).toHaveLength(0);
  });

  it('should safely remove sessions via killSession in test mode', async () => {
    manager.registerSession({
      sessionId: 'kill-me',
      muxName: 'codeman-deadbeef',
      pid: 99999,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'claude',
      attached: false,
    });

    mockedExecSync.mockClear();

    const result = await manager.killSession('kill-me');
    expect(result).toBe(true);
    expect(manager.getSession('kill-me')).toBeUndefined();

    // Verify no real kill commands were executed
    const killCalls = mockedExecSync.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('kill')
    );
    expect(killCalls).toHaveLength(0);
  });
});
