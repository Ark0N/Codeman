/**
 * @fileoverview The kill path's waits end when the processes do, not on a timer.
 *
 * Closing a session used to sleep a fixed 100 + 200 + 100 ms across its signals
 * and then verify in 100 ms steps, so a session whose processes were gone in a
 * few ms still took ~0.45 s to close. `waitForProcessesExit()` keeps each of
 * those deadlines but returns as soon as nothing is left running, and
 * `isProcessRunning()` counts a zombie as exited (it holds nothing but its pid
 * until its reaper gets to it, and `kill(pid, 0)` cannot tell it apart).
 *
 * Port: N/A.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isProcessRunning, waitForProcessesExit } from '../src/utils/process-exit-wait.js';

describe('waitForProcessesExit', () => {
  it('returns as soon as every pid has exited, long before the deadline', async () => {
    let polls = 0;
    const isRunning = (): boolean => ++polls < 4;
    const started = Date.now();

    const survivors = await waitForProcessesExit([101, 102], { timeoutMs: 5000, pollMs: 5, isRunning });

    expect(survivors).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns the survivors at the deadline instead of throwing', async () => {
    const started = Date.now();

    const survivors = await waitForProcessesExit([7, 8], {
      timeoutMs: 60,
      pollMs: 10,
      isRunning: (pid) => pid === 8,
    });

    expect(survivors).toEqual([8]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('does not wait at all when nothing is running', async () => {
    const started = Date.now();
    expect(await waitForProcessesExit([], { timeoutMs: 5000 })).toEqual([]);
    expect(await waitForProcessesExit([9], { timeoutMs: 5000, isRunning: () => false })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('isProcessRunning', () => {
  it('is true for a live process and false for a pid that does not exist', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
    // Above the default pid_max on Linux and macOS alike.
    expect(isProcessRunning(4_194_304 + 12_345)).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('counts a zombie as exited, which kill(pid, 0) cannot', async () => {
    // `sleep 0` exits at once, and its parent then becomes `sleep 5`, which never
    // reaps anything: the child stays a zombie until the parent itself goes.
    const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const zombie = await new Promise<number>((resolve, reject) => {
        parent.stdout.once('data', (chunk: Buffer) => resolve(parseInt(chunk.toString(), 10)));
        parent.once('error', reject);
      });
      const state = (): string => {
        const stat = readFileSync(`/proc/${zombie}/stat`, 'utf8');
        return stat.charAt(stat.lastIndexOf(')') + 2);
      };
      for (let i = 0; i < 100 && state() !== 'Z'; i++) await new Promise((r) => setTimeout(r, 10));
      expect(state()).toBe('Z');

      expect(() => process.kill(zombie, 0)).not.toThrow();
      expect(isProcessRunning(zombie)).toBe(false);
    } finally {
      parent.kill('SIGKILL');
    }
  });
});
