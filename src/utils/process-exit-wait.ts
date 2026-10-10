/**
 * @fileoverview Wait for processes to exit, and return as soon as they have.
 *
 * The session kill path used to sleep a FIXED interval after each signal (100 ms
 * for the PTY client, 200 ms for the pane's children, 100 ms for the process
 * group) and then verified in 100 ms steps. A process that was gone after 3 ms
 * still cost the whole interval, so closing a tab spent most of its ~0.5 s in
 * timers. This keeps every deadline the kill path had; it only stops waiting
 * once there is nothing left to wait for.
 *
 * A zombie counts as exited. It holds nothing but its pid until the parent reaps
 * it, and on the kill path that parent is the tmux server or the service
 * manager, which is no reason to hold up a close. `kill(pid, 0)` cannot tell a
 * zombie from a running process, so on Linux the state letter in
 * `/proc/<pid>/stat` decides; without procfs `kill(pid, 0)` is the answer.
 *
 * @module utils/process-exit-wait
 */

import { readFileSync } from 'node:fs';

/** Poll step while waiting: an exit is noticed within about one frame. */
export const PROCESS_EXIT_POLL_MS = 10;

/**
 * True while `pid` names a process that has not exited. A pid we may not signal
 * reads as not running, which is what the kill path's own check always did:
 * there is nothing it could do about such a process anyway.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    // Gone between the two reads. Any other failure: trust kill(pid, 0).
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  // "<pid> (<comm>) <state> …": comm may hold spaces and parentheses itself,
  // so the state is the field after the LAST ')'.
  const close = stat.lastIndexOf(')');
  const state = close === -1 ? '' : stat.charAt(close + 2);
  return state !== 'Z' && state !== 'X';
}

export interface WaitForExitOptions {
  /** Give up after this long; the survivors are returned, never thrown. */
  timeoutMs: number;
  /** Poll step, {@link PROCESS_EXIT_POLL_MS} by default. */
  pollMs?: number;
  /** Liveness probe, {@link isProcessRunning} by default (injectable for tests). */
  isRunning?: (pid: number) => boolean;
}

/**
 * Resolve once every pid in `pids` has exited, or at the deadline with the ones
 * that have not. Never rejects.
 */
export async function waitForProcessesExit(pids: readonly number[], options: WaitForExitOptions): Promise<number[]> {
  const isRunning = options.isRunning ?? isProcessRunning;
  const pollMs = Math.max(1, options.pollMs ?? PROCESS_EXIT_POLL_MS);
  const deadline = Date.now() + options.timeoutMs;
  let running = pids.filter((pid) => isRunning(pid));
  while (running.length > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    running = running.filter((pid) => isRunning(pid));
  }
  return running;
}
