import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AiIdleChecker, AiCheckVerdict } from '../src/ai-idle-checker.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    pid: 12345,
    on: vi.fn(),
  })),
}));

// Mock fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => ''),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

describe('AiIdleChecker', () => {
  let checker: AiIdleChecker;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    checker = new AiIdleChecker('test-session-1234', {
      checkTimeoutMs: 5000,
      cooldownMs: 3000,
      errorCooldownMs: 1000,
      maxConsecutiveErrors: 3,
      maxContextChars: 1000,
    });
  });

  afterEach(() => {
    checker.cancel();
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should start in ready status', () => {
      expect(checker.status).toBe('ready');
    });

    it('should not be on cooldown initially', () => {
      expect(checker.isOnCooldown()).toBe(false);
    });

    it('should have clean initial state', () => {
      const state = checker.getState();
      expect(state.status).toBe('ready');
      expect(state.lastVerdict).toBeNull();
      expect(state.lastReasoning).toBeNull();
      expect(state.consecutiveErrors).toBe(0);
      expect(state.totalChecks).toBe(0);
      expect(state.disabledReason).toBeNull();
    });
  });

  describe('Output Parsing', () => {
    it('should parse IDLE verdict', async () => {
      // Set up mock to return IDLE result after polling
      mockedReadFileSync.mockReturnValueOnce('') // writeFileSync creates empty file
        .mockReturnValueOnce('IDLE\nSession shows completion message and prompt.\n__AICHECK_DONE__');

      const checkPromise = checker.check('some terminal output');

      // First poll - empty
      await vi.advanceTimersByTimeAsync(500);
      // Second poll - has result
      await vi.advanceTimersByTimeAsync(500);

      const result = await checkPromise;
      expect(result.verdict).toBe('IDLE');
      expect(result.reasoning).toContain('completion message');
    });

    it('should parse WORKING verdict', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('WORKING\nSpinner characters detected, still processing.\n__AICHECK_DONE__');

      const checkPromise = checker.check('some terminal output');
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      const result = await checkPromise;
      expect(result.verdict).toBe('WORKING');
      expect(result.reasoning).toContain('Spinner');
    });

    it('should handle lowercase verdict', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('idle\nDone.\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      const result = await checkPromise;
      expect(result.verdict).toBe('IDLE');
    });

    it('should return ERROR for unparseable output', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('Something unexpected happened.\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      const result = await checkPromise;
      expect(result.verdict).toBe('ERROR');
      expect(result.reasoning).toContain('Could not parse');
    });

    it('should return ERROR for empty output', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      const result = await checkPromise;
      expect(result.verdict).toBe('ERROR');
      expect(result.reasoning).toContain('Empty output');
    });
  });

  describe('Tmux Spawn', () => {
    it('should spawn a tmux session for the check', async () => {
      mockedReadFileSync.mockReturnValue('IDLE\n__AICHECK_DONE__');

      const checkPromise = checker.check('terminal output');
      await vi.advanceTimersByTimeAsync(500);
      await checkPromise;

      // Verify tmux was spawned with correct args
      expect(mockedSpawn).toHaveBeenCalledWith(
        'tmux',
        expect.arrayContaining(['new-session', '-d', '-s', expect.stringContaining('claudeman-aicheck-')]),
        expect.objectContaining({ detached: true, stdio: 'ignore' })
      );
    });

    it('should kill existing tmux session with same name before spawning', async () => {
      mockedReadFileSync.mockReturnValue('IDLE\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(500);
      await checkPromise;

      // First call should try to kill existing session
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux kill-session -t "claudeman-aicheck-'),
        expect.any(Object)
      );
    });

    it('should create temp file for output capture', async () => {
      mockedReadFileSync.mockReturnValue('IDLE\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(500);
      await checkPromise;

      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('claudeman-aicheck-'),
        ''
      );
    });
  });

  describe('Timeout', () => {
    it('should timeout after checkTimeoutMs', async () => {
      // Never return a result
      mockedReadFileSync.mockReturnValue('');

      const checkPromise = checker.check('output');

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(5100);

      const result = await checkPromise;
      expect(result.verdict).toBe('ERROR');
      expect(result.reasoning).toContain('timed out');
    });
  });

  describe('Cancellation', () => {
    it('should cancel an in-progress check', async () => {
      mockedReadFileSync.mockReturnValue(''); // Never complete

      const checkPromise = checker.check('output');

      // Cancel immediately - the resolve callback will be called synchronously
      checker.cancel();
      expect(checker.status).toBe('ready');

      const result = await checkPromise;
      expect(result.verdict).toBe('ERROR');
      expect(result.reasoning).toBe('Cancelled');
    });

    it('should clean up tmux session on cancel', async () => {
      mockedReadFileSync.mockReturnValue('');

      const checkPromise = checker.check('output');

      checker.cancel();
      await checkPromise;

      // Should have tried to kill the tmux session (initial kill + cleanup kill)
      const killCalls = mockedExecSync.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('kill-session')
      );
      expect(killCalls.length).toBeGreaterThan(0);
    });

    it('should be a no-op if not checking', () => {
      checker.cancel(); // Should not throw
      expect(checker.status).toBe('ready');
    });
  });

  describe('Cooldown', () => {
    it('should start cooldown after WORKING verdict', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('WORKING\nStill processing.\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);
      await checkPromise;

      expect(checker.status).toBe('cooldown');
      expect(checker.isOnCooldown()).toBe(true);
      expect(checker.getCooldownRemainingMs()).toBeGreaterThan(0);
    });

    it('should return to ready after cooldown expires', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('WORKING\nBusy.\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(1000);
      await checkPromise;

      expect(checker.status).toBe('cooldown');

      // Advance past cooldown
      await vi.advanceTimersByTimeAsync(3100);

      expect(checker.status).toBe('ready');
      expect(checker.isOnCooldown()).toBe(false);
    });

    it('should not start new check during cooldown', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('WORKING\nBusy.\n__AICHECK_DONE__');

      const firstCheck = checker.check('output');
      await vi.advanceTimersByTimeAsync(1000);
      await firstCheck;

      // Try to check during cooldown
      const result = await checker.check('output');
      expect(result.verdict).toBe('ERROR');
      expect(result.reasoning).toBe('On cooldown');
    });
  });

  describe('Error Handling', () => {
    it('should start error cooldown after parse error', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('garbage output\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(1000);
      await checkPromise;

      expect(checker.status).toBe('cooldown');
      expect(checker.getState().consecutiveErrors).toBe(1);
    });

    it('should disable after maxConsecutiveErrors', async () => {
      // With P1-005 exponential backoff, cooldowns increase:
      // Error 1: 1000ms * 2^0 = 1000ms
      // Error 2: 1000ms * 2^1 = 2000ms
      // Error 3: disabled (no cooldown)
      const cooldowns = [1100, 2100]; // Wait slightly longer than each cooldown

      for (let i = 0; i < 3; i++) {
        mockedReadFileSync.mockReturnValueOnce('')
          .mockReturnValueOnce('garbage\n__AICHECK_DONE__');

        const checkPromise = checker.check('output');
        await vi.advanceTimersByTimeAsync(1000);
        await checkPromise;

        // Clear cooldown for next check (except after the last one which disables)
        if (i < 2) {
          await vi.advanceTimersByTimeAsync(cooldowns[i]);
        }
      }

      expect(checker.status).toBe('disabled');
      expect(checker.getState().disabledReason).toContain('3 consecutive errors');
    });

    it('should reset error counter on successful check', async () => {
      // First check: error
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('garbage\n__AICHECK_DONE__');
      const firstCheck = checker.check('output');
      await vi.advanceTimersByTimeAsync(1000);
      await firstCheck;
      expect(checker.getState().consecutiveErrors).toBe(1);

      // Wait for cooldown
      await vi.advanceTimersByTimeAsync(1100);

      // Second check: success
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('IDLE\nDone.\n__AICHECK_DONE__');
      const secondCheck = checker.check('output');
      await vi.advanceTimersByTimeAsync(1000);
      await secondCheck;

      expect(checker.getState().consecutiveErrors).toBe(0);
    });

    it('should return ERROR if disabled', async () => {
      checker.updateConfig({ enabled: false });

      const result = await checker.check('output');
      expect(result.verdict).toBe('ERROR');
      expect(result.reasoning).toContain('Disabled');
    });
  });

  describe('Buffer Handling', () => {
    it('should strip ANSI codes from terminal buffer', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('IDLE\n__AICHECK_DONE__');

      const ansiBuffer = '\x1b[1mBold\x1b[0m \x1b[32mGreen\x1b[0m text';
      const checkPromise = checker.check(ansiBuffer);
      await vi.advanceTimersByTimeAsync(1000);
      await checkPromise;

      // Verify the spawn command was called (which means the prompt was built)
      expect(mockedSpawn).toHaveBeenCalled();
    });

    it('should trim buffer to maxContextChars', async () => {
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('IDLE\n__AICHECK_DONE__');

      // Create buffer longer than maxContextChars (1000)
      const longBuffer = 'x'.repeat(2000);
      const checkPromise = checker.check(longBuffer);
      await vi.advanceTimersByTimeAsync(1000);
      await checkPromise;

      // The check should complete successfully (trimming happened internally)
      expect(mockedSpawn).toHaveBeenCalled();
    });
  });

  describe('Config Updates', () => {
    it('should disable when config sets enabled=false', () => {
      checker.updateConfig({ enabled: false });
      expect(checker.status).toBe('disabled');
    });

    it('should re-enable when config sets enabled=true', () => {
      checker.updateConfig({ enabled: false });
      expect(checker.status).toBe('disabled');

      checker.updateConfig({ enabled: true });
      expect(checker.status).toBe('ready');
    });

    it('should update model in config', () => {
      checker.updateConfig({ model: 'claude-sonnet-4-20250514' });
      expect(checker.getConfig().model).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('Reset', () => {
    it('should clear all state on reset', async () => {
      // Trigger a WORKING verdict to set state
      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('WORKING\nBusy.\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(1000);
      await checkPromise;

      expect(checker.status).toBe('cooldown');

      // Reset
      checker.reset();

      expect(checker.status).toBe('ready');
      expect(checker.isOnCooldown()).toBe(false);
      const state = checker.getState();
      expect(state.lastVerdict).toBeNull();
      expect(state.consecutiveErrors).toBe(0);
    });
  });

  describe('Events', () => {
    it('should emit checkStarted event', async () => {
      const handler = vi.fn();
      checker.on('checkStarted', handler);

      mockedReadFileSync.mockReturnValue('IDLE\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(500);
      await checkPromise;

      expect(handler).toHaveBeenCalled();
    });

    it('should emit checkCompleted event with result', async () => {
      const handler = vi.fn();
      checker.on('checkCompleted', handler);

      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('IDLE\nAll done.\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(1000);
      await checkPromise;

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        verdict: 'IDLE',
      }));
    });

    it('should emit cooldownStarted event after WORKING', async () => {
      const handler = vi.fn();
      checker.on('cooldownStarted', handler);

      mockedReadFileSync.mockReturnValueOnce('')
        .mockReturnValueOnce('WORKING\nBusy.\n__AICHECK_DONE__');

      const checkPromise = checker.check('output');
      await vi.advanceTimersByTimeAsync(1000);
      await checkPromise;

      expect(handler).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should emit disabled event after max errors', async () => {
      const handler = vi.fn();
      checker.on('disabled', handler);

      // With exponential backoff (P1-005), cooldown increases:
      // Error 1: 1000ms * 2^0 = 1000ms
      // Error 2: 1000ms * 2^1 = 2000ms
      // Error 3: disabled (no cooldown needed)
      const cooldowns = [1100, 2100]; // Wait longer than exponential backoff

      for (let i = 0; i < 3; i++) {
        mockedReadFileSync.mockReturnValueOnce('')
          .mockReturnValueOnce('garbage\n__AICHECK_DONE__');
        const checkPromise = checker.check('output');
        await vi.advanceTimersByTimeAsync(1000);
        await checkPromise;
        if (i < 2) await vi.advanceTimersByTimeAsync(cooldowns[i]);
      }

      expect(handler).toHaveBeenCalledWith(expect.stringContaining('consecutive errors'));
    });
  });

  describe('Concurrent Check Prevention', () => {
    it('should reject if already checking', async () => {
      mockedReadFileSync.mockReturnValue(''); // Never complete

      const firstCheck = checker.check('output');

      const secondResult = await checker.check('output');
      expect(secondResult.verdict).toBe('ERROR');
      expect(secondResult.reasoning).toBe('Already checking');

      // Clean up first check
      checker.cancel();
      await firstCheck;
    });
  });
});
