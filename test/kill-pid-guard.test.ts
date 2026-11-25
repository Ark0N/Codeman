/**
 * @fileoverview killSession() must never signal the machine.
 *
 * On 2026-11-25 a kill that got pid 0 took down every process of the account: every
 * session, tmux and the systemd user manager. The children of pid 0 are the whole process
 * table, so the descendant walk handed all of it to SIGTERM. tmux answers 0 for a pane
 * with no process (`split-window ''`), the pane list read at server start records it on
 * the session, and the next close of that tab killed everything.
 *
 * These drive the SHIPPED killSession() with the tmux and ps answers mocked and
 * process.kill stubbed: nothing here may reach a real process.
 *
 * Port: N/A (no server needed)
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { exec, execFile, execSync } from 'node:child_process';
import { isSignalablePid } from '../src/proc-tree.js';
import type { MuxSession } from '../src/mux-interface.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, exec: vi.fn(), execFile: vi.fn(), execSync: vi.fn(), spawn: vi.fn() };
});

/** A machine: init, kthreadd, the user's own programs, and one agent (4242) with a child. */
const PS = ['1 0', '2 0', '900 1', '901 900', '902 900', '4242 901', '4243 4242'].join('\n') + '\n';

describe('isSignalablePid', () => {
  it('admits only a process of the user', () => {
    for (const pid of [2, 4242, 2 ** 22]) expect(isSignalablePid(pid)).toBe(true);
    for (const pid of [1, 0, -0, -1, -4242, NaN, Infinity, 1.5, null, undefined]) {
      expect(isSignalablePid(pid as number)).toBe(false);
    }
  });
});

describe('killSession and a pane without a process', () => {
  let panePid: string;
  let commands: string[];
  let kill: MockInstance<typeof process.kill>;
  let signals: [number, string | number | undefined][];

  beforeEach(() => {
    panePid = '4242\n';
    commands = [];
    signals = [];
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd.includes('list-panes -a')) return `codeman-feed1234|${panePid.trim()}|0||\n`;
      return '';
    }) as unknown as typeof execSync);
    vi.mocked(exec).mockImplementation(((cmd: string, options: unknown, maybeCallback?: unknown) => {
      commands.push(cmd);
      const callback = (typeof options === 'function' ? options : maybeCallback) as (e: null, out: object) => void;
      const stdout = cmd.includes('display-message') ? panePid : '';
      setImmediate(() => callback(null, { stdout, stderr: '' }));
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    }) as unknown as typeof exec);
    // The process snapshot the descendant walk reads.
    vi.mocked(execFile).mockImplementation(((file: string, _args: string[], _options: unknown, callback: unknown) => {
      setImmediate(() => (callback as (e: null, out: string) => void)(null, file === 'ps' ? PS : ''));
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    }) as unknown as typeof execFile);
    // Every process dies at its first real signal, so no wait runs its full length.
    const gone = new Set<number>();
    kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (signal !== 0) {
        signals.push([pid, signal]);
        gone.add(Math.abs(pid));
      } else if (gone.has(Math.abs(pid))) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    kill.mockRestore();
    vi.restoreAllMocks();
  });

  async function manager(recordedPid: number) {
    const vitest = process.env.VITEST;
    vi.resetModules();
    delete process.env.VITEST;
    const { TmuxManager } = await import('../src/tmux-manager.js');
    process.env.VITEST = vitest;
    const m = new TmuxManager();
    m.registerSession({
      sessionId: 'feed1234',
      muxName: 'codeman-feed1234',
      pid: recordedPid,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'claude',
      attached: false,
    } as MuxSession);
    return m;
  }
  const closedByTmux = () => commands.some((c) => c.includes('kill-session -t "codeman-feed1234"'));

  // The control: without it, a guard that refused every kill would pass the rest.
  it('still signals the process tree of a real pane', async () => {
    const m = await manager(4242);
    expect(await m.killSession('feed1234')).toBe(true);
    expect(signals).toContainEqual([4243, 'SIGTERM']);
    expect(signals).toContainEqual([-4242, 'SIGTERM']);
    expect(signals.every(([pid]) => [4242, 4243].includes(Math.abs(pid)))).toBe(true);
    expect(closedByTmux()).toBe(true);
    m.destroy();
  });

  for (const pid of [0, 1]) {
    it(`signals nothing for pid ${pid}, and tmux still closes the session`, async () => {
      panePid = `${pid}\n`;
      const m = await manager(pid);
      expect(await m.killSession('feed1234')).toBe(true);
      expect(signals).toEqual([]);
      expect(closedByTmux()).toBe(true);
      expect(m.getSession('feed1234')).toBeUndefined();
      m.destroy();
    });
  }

  it('signals nothing when tmux gives no answer and the record holds 0', async () => {
    panePid = '\n';
    const m = await manager(0);
    expect(await m.killSession('feed1234')).toBe(true);
    expect(signals).toEqual([]);
    expect(closedByTmux()).toBe(true);
    m.destroy();
  });

  it('survives the real route: the pane list at server start records 0, then the tab is closed', async () => {
    panePid = '0\n';
    const m = await manager(4242);
    await m.reconcileSessions();
    expect(m.getSession('feed1234')?.pid).toBe(0); // what master did next was walk it
    expect(await m.killSession('feed1234')).toBe(true);
    expect(signals).toEqual([]);
    expect(closedByTmux()).toBe(true);
    m.destroy();
  });
});
