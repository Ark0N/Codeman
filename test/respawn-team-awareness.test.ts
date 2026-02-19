/**
 * @fileoverview Tests for RespawnController team-awareness integration
 *
 * Verifies that the respawn controller correctly blocks respawn cycles
 * when TeamWatcher reports active teammates working on tasks.
 *
 * Port: N/A (no server — unit tests only)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RespawnController } from '../src/respawn-controller.js';
import { Session } from '../src/session.js';
import { TeamWatcher } from '../src/team-watcher.js';
import { EventEmitter } from 'node:events';

// ========== Mock Session ==========

class MockSession extends EventEmitter {
  id = 'test-session-123';
  workingDir = '/tmp/test';
  status = 'idle';
  pid = 12345;
  isWorking = false;
  writeBuffer: string[] = [];
  ralphTracker: null = null;

  async writeViaMux(data: string): Promise<boolean> {
    this.writeBuffer.push(data);
    return true;
  }

  write(data: string): void {
    this.writeBuffer.push(data);
  }

  simulateCompletionMessage(): void {
    this.emit('terminal', '✻ Worked for 2m 46s');
  }
}

// ========== Mock TeamWatcher ==========

class MockTeamWatcher extends TeamWatcher {
  private _hasActive = false;
  private _activeCount = 0;

  constructor() {
    // Pass dummy dirs that don't exist — we override the methods anyway
    super('/tmp/nonexistent-teams', '/tmp/nonexistent-tasks');
  }

  setActiveTeammates(sessionId: string, hasActive: boolean, count: number = 1): void {
    this._hasActive = hasActive;
    this._activeCount = count;
  }

  override hasActiveTeammates(_sessionId: string): boolean {
    return this._hasActive;
  }

  override getActiveTeammateCount(_sessionId: string): number {
    return this._activeCount;
  }

  // Prevent actual filesystem polling
  override start(): void { /* noop */ }
  override stop(): void { /* noop */ }
}

// ========== Tests ==========

describe('RespawnController Team Awareness', () => {
  let session: MockSession;
  let controller: RespawnController;
  let teamWatcher: MockTeamWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new MockSession();
    teamWatcher = new MockTeamWatcher();
    controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 100,
      interStepDelayMs: 50,
      completionConfirmMs: 200,
      noOutputTimeoutMs: 500,
      aiIdleCheckEnabled: false,
      sendClear: false,
      sendInit: false,
    });
  });

  afterEach(() => {
    controller.stop();
    vi.useRealTimers();
  });

  describe('without TeamWatcher (backwards compatibility)', () => {
    it('should allow respawn when no TeamWatcher is set', async () => {
      // Don't call setTeamWatcher — should work as before
      const cycleStarted = vi.fn();
      controller.on('respawnCycleStarted', cycleStarted);

      controller.start();
      expect(controller.state).toBe('watching');

      // Trigger idle detection
      session.simulateCompletionMessage();
      await vi.advanceTimersByTimeAsync(300); // Past completionConfirmMs

      expect(cycleStarted).toHaveBeenCalled();
    });
  });

  describe('with TeamWatcher and no active teammates', () => {
    it('should allow respawn when no teammates are active', async () => {
      controller.setTeamWatcher(teamWatcher as unknown as TeamWatcher);
      teamWatcher.setActiveTeammates(session.id, false, 0);

      const cycleStarted = vi.fn();
      controller.on('respawnCycleStarted', cycleStarted);

      controller.start();

      // Trigger idle detection
      session.simulateCompletionMessage();
      await vi.advanceTimersByTimeAsync(300);

      expect(cycleStarted).toHaveBeenCalled();
    });
  });

  describe('with TeamWatcher and active teammates', () => {
    it('should block respawn when teammates are active', async () => {
      controller.setTeamWatcher(teamWatcher as unknown as TeamWatcher);
      teamWatcher.setActiveTeammates(session.id, true, 2);

      const cycleStarted = vi.fn();
      const respawnBlocked = vi.fn();
      controller.on('respawnCycleStarted', cycleStarted);
      controller.on('respawnBlocked', respawnBlocked);

      controller.start();

      // Trigger idle detection
      session.simulateCompletionMessage();
      await vi.advanceTimersByTimeAsync(300);

      expect(cycleStarted).not.toHaveBeenCalled();
      expect(respawnBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'active_teammates',
          details: expect.stringContaining('2'),
        })
      );
    });

    it('should return to watching state after blocking', async () => {
      controller.setTeamWatcher(teamWatcher as unknown as TeamWatcher);
      teamWatcher.setActiveTeammates(session.id, true, 1);

      controller.start();

      // Trigger idle detection
      session.simulateCompletionMessage();
      await vi.advanceTimersByTimeAsync(300);

      expect(controller.state).toBe('watching');
    });

    it('should allow respawn after teammates finish', async () => {
      controller.setTeamWatcher(teamWatcher as unknown as TeamWatcher);

      const cycleStarted = vi.fn();
      const respawnBlocked = vi.fn();
      controller.on('respawnCycleStarted', cycleStarted);
      controller.on('respawnBlocked', respawnBlocked);

      controller.start();

      // First attempt: teammates active → blocked
      teamWatcher.setActiveTeammates(session.id, true, 1);
      session.simulateCompletionMessage();
      await vi.advanceTimersByTimeAsync(300);

      expect(cycleStarted).not.toHaveBeenCalled();
      expect(respawnBlocked).toHaveBeenCalledTimes(1);

      // Teammates finish
      teamWatcher.setActiveTeammates(session.id, false, 0);

      // Second attempt: no teammates → allowed
      session.simulateCompletionMessage();
      await vi.advanceTimersByTimeAsync(300);

      expect(cycleStarted).toHaveBeenCalledTimes(1);
    });
  });

  describe('respawnBlocked event details', () => {
    it('should include teammate count in details', async () => {
      controller.setTeamWatcher(teamWatcher as unknown as TeamWatcher);
      teamWatcher.setActiveTeammates(session.id, true, 3);

      const respawnBlocked = vi.fn();
      controller.on('respawnBlocked', respawnBlocked);

      controller.start();
      session.simulateCompletionMessage();
      await vi.advanceTimersByTimeAsync(300);

      expect(respawnBlocked).toHaveBeenCalledWith({
        reason: 'active_teammates',
        details: '3 teammate(s) still working',
      });
    });
  });
});
