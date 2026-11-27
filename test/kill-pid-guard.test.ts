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

/** The kill path's pane read, as killSession() sends it. */
const KILL_READ = "'#{pane_dead}|#{pane_pid}|#{pane_dead_time}'";

/**
 * A machine: init, kthreadd, the user's own programs, one agent (4242) with a child, and a
 * second program (4343) with a child, for a pane whose process is not the recorded one.
 */
const PS =
  ['1 0', '2 0', '900 1', '901 900', '902 900', '4242 901', '4243 4242', '4343 901', '4344 4343'].join('\n') + '\n';

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
  /**
   * The kill path's own read, `#{pane_dead}|#{pane_pid}|#{pane_dead_time}`. Unset, it
   * answers a live pane with `panePid`, which is what tmux prints for one.
   */
  let paneRead: string | undefined;
  let commands: string[];
  let kill: MockInstance<typeof process.kill>;
  let signals: [number, string | number | undefined][];

  beforeEach(() => {
    panePid = '4242\n';
    paneRead = undefined;
    commands = [];
    signals = [];
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd.includes('list-panes -a')) return `codeman-feed1234|${panePid.trim()}|0||\n`;
      return '';
    }) as unknown as typeof execSync);
    vi.mocked(exec).mockImplementation(((cmd: string, options: unknown, maybeCallback?: unknown) => {
      commands.push(cmd);
      const callback = (typeof options === 'function' ? options : maybeCallback) as (e: null, out: object) => void;
      const stdout = !cmd.includes('display-message')
        ? ''
        : cmd.includes(KILL_READ)
          ? (paneRead ?? `0|${panePid.trim()}|\n`)
          : panePid;
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
  /** The close read the pane through the three-field kill read, and not the old pid-only one. */
  const readTheKillFormat = () => commands.some((c) => c.includes(KILL_READ));

  // The control: without it, a guard that refused every kill would pass the rest.
  it('still signals the process tree of a real pane', async () => {
    const m = await manager(4242);
    expect(await m.killSession('feed1234')).toBe(true);
    expect(signals).toContainEqual([4243, 'SIGTERM']);
    expect(signals).toContainEqual([-4242, 'SIGTERM']);
    expect(signals.every(([pid]) => [4242, 4243].includes(Math.abs(pid)))).toBe(true);
    expect(closedByTmux()).toBe(true);
    expect(readTheKillFormat()).toBe(true);
    m.destroy();
  });

  // tmux's own 0, for an empty active pane beside the agent: `1|0|` up to tmux 3.6,
  // `0|0|` on 3.7, and `0||` is tmux 3.8's closing window (pty closed, exit not
  // collected). Each falls back to the recorded agent pid, as master does, and
  // nothing outside that pid's tree is signalled.
  // The counterpart of the dead-pane rule: it must not stop a close from killing a pane
  // whose program still runs. Here, never in tmux-manager.test.ts: that file's mock keeps
  // the real execFile, so the walk would read this machine's process table.
  it('signals the tree of the pid tmux prints for a live pane, not the recorded one', async () => {
    paneRead = '0|4343|\n';
    const m = await manager(4242);
    expect(await m.killSession('feed1234')).toBe(true);
    expect(signals).toContainEqual([4344, 'SIGTERM']);
    expect(signals).toContainEqual([-4343, 'SIGTERM']);
    expect(signals.every(([pid]) => [4343, 4344].includes(Math.abs(pid)))).toBe(true);
    // The whole kill read: dropping `#{pane_dead_time}` would trust a pre-3.7 dead flag again.
    expect(readTheKillFormat()).toBe(true);
    expect(closedByTmux()).toBe(true);
    expect(m.getSession('feed1234')).toBeUndefined();
    m.destroy();
  });

  for (const answer of ['1|0|', '0|0|', '0||']) {
    it(`falls back to the recorded pid when the kill read answers ${answer}`, async () => {
      paneRead = `${answer}\n`;
      const m = await manager(4242);
      expect(await m.killSession('feed1234')).toBe(true);
      expect(readTheKillFormat()).toBe(true);
      expect(signals).toContainEqual([-4242, 'SIGTERM']);
      expect(signals.every(([pid]) => [4242, 4243].includes(Math.abs(pid)))).toBe(true);
      expect(closedByTmux()).toBe(true);
      m.destroy();
    });

    it(`signals nothing for ${answer} when the record holds 0 too`, async () => {
      paneRead = `${answer}\n`;
      const m = await manager(0);
      expect(await m.killSession('feed1234')).toBe(true);
      expect(signals).toEqual([]);
      expect(closedByTmux()).toBe(true);
      m.destroy();
    });
  }

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
