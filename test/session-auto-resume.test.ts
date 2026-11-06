/**
 * Tests for SessionAutoOps auto-resume on usage limit (token pause control).
 *
 * Uses fake timers; the SessionAutoOps callbacks are plain mocks, so no
 * real session, tmux, or ports are involved. Port: N/A
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionAutoOps } from '../src/session-auto-ops.js';
import { Session } from '../src/session.js';

const BUFFER_MS = 2 * 60_000; // RESUME_BUFFER_MS in session-auto-ops.ts
const ESC_DELAY_MS = 600; // RESUME_ESC_DELAY_MS

function limitLine(resetInMs: number): string {
  // Raw API epoch form gives exact control over the parsed reset time
  const epoch = Math.floor((Date.now() + resetInMs) / 1000);
  return `Claude AI usage limit reached|${epoch}`;
}

describe('SessionAutoOps auto-resume', () => {
  let ops: SessionAutoOps;
  let writeCommand: ReturnType<typeof vi.fn>;
  let working: boolean;
  let stopped: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    // Whole-second clock: limitLine() floors to epoch seconds, and a fractional
    // start time would shift the fire point by up to 999ms (flaky assertions)
    vi.setSystemTime(Math.floor(Date.now() / 1000) * 1000);
    writeCommand = vi.fn(async () => true);
    working = false;
    stopped = false;
    ops = new SessionAutoOps({
      writeCommand,
      isWorking: () => working,
      isStopped: () => stopped,
      getTotalTokens: () => 0,
      getContextReport: () => null,
      getSessionId: () => 'test-session',
    });
  });

  afterEach(() => {
    ops.destroy();
    vi.useRealTimers();
  });

  it('does nothing when disabled', () => {
    ops.processCleanData(limitLine(60 * 60_000));
    expect(ops.isLimitPaused).toBe(false);
    expect(ops.autoResumeAt).toBeNull();
  });

  it('arms a schedule at reset time + buffer when enabled', () => {
    ops.setAutoResume(true);
    const scheduled = vi.fn();
    ops.on('limitPauseScheduled', scheduled);

    ops.processCleanData(limitLine(60 * 60_000)); // resets in 1h

    expect(ops.isLimitPaused).toBe(true);
    expect(ops.autoResumeAt).not.toBeNull();
    const expected = Date.now() + 60 * 60_000 + BUFFER_MS;
    expect(Math.abs(ops.autoResumeAt! - expected)).toBeLessThan(2000);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('dedups repeated footer redraws of the same limit message', () => {
    ops.setAutoResume(true);
    const scheduled = vi.fn();
    ops.on('limitPauseScheduled', scheduled);

    const line = limitLine(30 * 60_000);
    ops.processCleanData(line);
    ops.processCleanData(line);
    ops.processCleanData(line);

    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('reschedules when an EARLIER reset time appears', () => {
    ops.setAutoResume(true);
    const scheduled = vi.fn();
    ops.on('limitPauseScheduled', scheduled);

    ops.processCleanData(limitLine(60 * 60_000));
    const firstAt = ops.autoResumeAt!;
    ops.processCleanData(limitLine(10 * 60_000));

    expect(scheduled).toHaveBeenCalledTimes(2);
    expect(ops.autoResumeAt!).toBeLessThan(firstAt);
  });

  it('keeps the schedule when a LATER/stale time appears', () => {
    ops.setAutoResume(true);
    ops.processCleanData(limitLine(10 * 60_000));
    const firstAt = ops.autoResumeAt!;
    ops.processCleanData(limitLine(60 * 60_000)); // later → ignored
    ops.processCleanData(limitLine(-5 * 60_000)); // overdue → never preempts
    expect(ops.autoResumeAt).toBe(firstAt);
  });

  it('fires Escape then the continue prompt at the scheduled time', async () => {
    ops.setAutoResume(true);
    const resumed = vi.fn();
    ops.on('limitResume', resumed);

    ops.processCleanData(limitLine(10 * 60_000));
    await vi.advanceTimersByTimeAsync(10 * 60_000 + BUFFER_MS + 100);

    expect(writeCommand).toHaveBeenCalledWith('\x1b');
    expect(resumed).not.toHaveBeenCalled(); // continue still pending

    await vi.advanceTimersByTimeAsync(ESC_DELAY_MS + 50);
    expect(writeCommand).toHaveBeenCalledWith('continue\r');
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(ops.isLimitPaused).toBe(false);
    expect(ops.autoResumeAt).toBeNull();
  });

  it('ignores stale-footer re-detections while the resume is in flight', async () => {
    ops.setAutoResume(true);
    ops.processCleanData(limitLine(10 * 60_000));
    await vi.advanceTimersByTimeAsync(10 * 60_000 + BUFFER_MS + 100);

    // Esc sent; before the continue fires, the stale footer redraws
    ops.processCleanData(limitLine(-1000));
    expect(ops.isLimitPaused).toBe(false); // not re-armed mid-resume

    await vi.advanceTimersByTimeAsync(ESC_DELAY_MS + 50);
    expect(writeCommand).toHaveBeenCalledWith('continue\r');
  });

  it('re-arms a retry when still limited after a resume attempt', async () => {
    ops.setAutoResume(true);
    ops.processCleanData(limitLine(10 * 60_000));
    await vi.advanceTimersByTimeAsync(10 * 60_000 + BUFFER_MS + ESC_DELAY_MS + 200);
    expect(writeCommand).toHaveBeenCalledWith('continue\r');

    // The submit echoes a fresh limit line with an already-past reset → retry path
    const scheduled = vi.fn();
    ops.on('limitPauseScheduled', scheduled);
    ops.processCleanData(limitLine(-1000));
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(ops.isLimitPaused).toBe(true);
    // Retry fires within RESUME_RETRY_MS (5 min)
    expect(ops.autoResumeAt! - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });

  it('skips the resume when Claude is already working at fire time', async () => {
    ops.setAutoResume(true);
    const cancelled = vi.fn();
    ops.on('limitResumeCancelled', cancelled);

    ops.processCleanData(limitLine(10 * 60_000));
    working = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + BUFFER_MS + ESC_DELAY_MS + 200);

    expect(writeCommand).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledWith({ reason: 'working' });
    expect(ops.isLimitPaused).toBe(false);
  });

  it('cancels the pending schedule when Claude starts working', () => {
    ops.setAutoResume(true);
    const cancelled = vi.fn();
    ops.on('limitResumeCancelled', cancelled);

    ops.processCleanData(limitLine(10 * 60_000));
    expect(ops.isLimitPaused).toBe(true);

    ops.notifyWorking();
    expect(ops.isLimitPaused).toBe(false);
    expect(ops.autoResumeAt).toBeNull();
    expect(cancelled).toHaveBeenCalledWith({ reason: 'working' });
  });

  it('notifyWorking is a no-op when nothing is armed', () => {
    ops.setAutoResume(true);
    const cancelled = vi.fn();
    ops.on('limitResumeCancelled', cancelled);
    ops.notifyWorking();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('disabling cancels the pending schedule', () => {
    ops.setAutoResume(true);
    ops.processCleanData(limitLine(10 * 60_000));

    ops.setAutoResume(false);
    expect(ops.isLimitPaused).toBe(false);
    expect(ops.autoResumeAt).toBeNull();

    // and detection stays off
    ops.processCleanData(limitLine(10 * 60_000));
    expect(ops.isLimitPaused).toBe(false);
  });

  it('destroy clears timers without emitting', () => {
    ops.setAutoResume(true);
    const cancelled = vi.fn();
    ops.on('limitResumeCancelled', cancelled);
    ops.processCleanData(limitLine(10 * 60_000));

    ops.destroy();
    expect(ops.isLimitPaused).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60 * 60_000);
    expect(writeCommand).not.toHaveBeenCalled();
  });

  it('does not fire after the session stops', async () => {
    ops.setAutoResume(true);
    ops.processCleanData(limitLine(10 * 60_000));
    stopped = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + BUFFER_MS + ESC_DELAY_MS + 200);
    expect(writeCommand).not.toHaveBeenCalled();
  });

  describe('Session wiring (terminal output → detection → events)', () => {
    it('detects a limit message flowing through the expensive-parser path', () => {
      const session = new Session({ workingDir: '/tmp' }); // mode 'claude'
      const scheduled = vi.fn();
      session.on('limitPauseScheduled', scheduled);
      session.setAutoResume(true);

      // Same choke-point the claude-mode PTY handler uses (throttled batch)
      (session as unknown as { _processExpensiveParsers(d: string): void })._processExpensiveParsers(
        '5-hour limit reached ∙ resets 8pm'
      );

      expect(session.isLimitPaused).toBe(true);
      expect(session.autoResumeAt).not.toBeNull();
      expect(scheduled).toHaveBeenCalledTimes(1);
      expect(session.toState().autoResumeEnabled).toBe(true);
      expect(session.toState().autoResumeAt).toBe(session.autoResumeAt!);
      session.setAutoResume(false); // clears the armed timer
    });

    it('catches an already-displayed limit message when enabling mid-pause', () => {
      const session = new Session({ workingDir: '/tmp' });
      // limit footer already on screen before the user finds the checkbox
      (session as unknown as { _terminalBuffer: { append(d: string): void } })._terminalBuffer.append(
        '\x1b[33m5-hour limit reached ∙ resets 8pm\x1b[0m'
      );
      session.setAutoResume(true);
      expect(session.isLimitPaused).toBe(true);
      session.setAutoResume(false);
    });

    it('ignores stale scrollback (past reset time) when enabling', () => {
      const session = new Session({ workingDir: '/tmp' });
      const pastEpoch = Math.floor(Date.now() / 1000) - 3600;
      (session as unknown as { _terminalBuffer: { append(d: string): void } })._terminalBuffer.append(
        `Claude AI usage limit reached|${pastEpoch}`
      );
      session.setAutoResume(true);
      expect(session.isLimitPaused).toBe(false);
      session.setAutoResume(false);
    });

    it('stays inert when the checkbox is disabled (default)', () => {
      const session = new Session({ workingDir: '/tmp' });
      (session as unknown as { _processExpensiveParsers(d: string): void })._processExpensiveParsers(
        '5-hour limit reached ∙ resets 8pm'
      );
      expect(session.isLimitPaused).toBe(false);
      expect(session.toState().autoResumeEnabled).toBe(false);
    });
  });

  describe('restoreAutoResume (recovery after Codeman restart)', () => {
    it('re-arms a future schedule', () => {
      ops.restoreAutoResume(true, Date.now() + 30 * 60_000);
      expect(ops.autoResumeEnabled).toBe(true);
      expect(ops.isLimitPaused).toBe(true);
      expect(ops.autoResumeAt! - Date.now()).toBeGreaterThan(29 * 60_000);
    });

    it('fires an overdue schedule shortly after boot', async () => {
      ops.restoreAutoResume(true, Date.now() - 60_000);
      expect(ops.isLimitPaused).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000 + ESC_DELAY_MS + 200);
      expect(writeCommand).toHaveBeenCalledWith('\x1b');
      expect(writeCommand).toHaveBeenCalledWith('continue\r');
    });

    it('enables without arming when no schedule was persisted', () => {
      ops.restoreAutoResume(true);
      expect(ops.autoResumeEnabled).toBe(true);
      expect(ops.isLimitPaused).toBe(false);
      expect(ops.autoResumeAt).toBeNull();
    });
  });
});
