/**
 * @fileoverview Alt+1..9 on a `codeman tui` attach must not move any other tmux
 * client. Key tables are server-wide, so the binding exists for every client;
 * the command runs only for the TUI's own tty and pid.
 *
 * Against a real tmux on a private socket (never Codeman's). One client is
 * attached on a pty whose tty is known BEFORE `tmux attach` runs, which is how
 * the TUI arms the hook. A second client is what a browser tab is.
 *
 * Port: N/A (no server)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as pty from 'node-pty';
import { TuiClient } from '../../src/tui/tui-client.js';

const hasTmux = (() => {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    execSync('python3 -c "import pty"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Holds a pty open, prints its tty, and execs `tmux attach` on that slave only
 * after stdin says GO. IXON is off so a byte is never swallowed as flow control.
 */
const PTY_HELPER = `
import os, pty, sys, termios, signal
socket, session = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
attr = termios.tcgetattr(slave)
attr[0] &= ~(termios.IXON | termios.IXOFF)
termios.tcsetattr(slave, termios.TCSANOW, attr)
sys.stdout.write(os.ttyname(slave) + "\\n")
sys.stdout.flush()
if not sys.stdin.readline().startswith("GO"):
    sys.exit(1)
env = os.environ.copy()
env["TERM"] = "xterm-256color"
env.pop("TMUX", None)
pid = os.fork()
if pid == 0:
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(slave)
    os.execvpe("tmux", ["tmux", "-f", "/dev/null", "-L", socket, "attach-session", "-t", session], env)
os.close(slave)
sys.stdout.write("ATTACHED\\n")
sys.stdout.flush()
while True:
    line = sys.stdin.readline()
    if not line or line.startswith("EXIT"):
        break
    if line.startswith("KEY "):
        os.write(master, bytes.fromhex(line[4:].strip()))
os.kill(pid, signal.SIGTERM)
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
os.close(master)
`;

/** Linux `/dev/pts/N` and macOS `/dev/ttysNNN`, the same ttys `isTuiClientTty` accepts. */
const CLIENT_TTY = /^\/dev\/(?:pts\/[0-9]+|ttys[0-9]+)$/;

describe.skipIf(!hasTmux)('TUI M-1..M-9 switch only the attaching client', () => {
  const socket = `codeman-tui-switch-${process.pid}`;
  const alpha = 'codeman-aaaa1111';
  const beta = 'codeman-bbbb2222';
  const run = (args: readonly string[]): string =>
    execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const client = new TuiClient({ socket });
  let helper: ChildProcess | null = null;
  let other: pty.IPty | null = null;
  const lines: string[] = [];
  let waiters: Array<(line: string) => void> = [];

  function pushLine(line: string): void {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  }

  function nextLine(): Promise<string> {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  }

  function sessions(): Map<string, { session: string; pid: string }> {
    let out = '';
    try {
      out = run(['list-clients', '-F', '#{client_tty}\t#{client_session}\t#{client_pid}']);
    } catch {
      return new Map();
    }
    const map = new Map<string, { session: string; pid: string }>();
    for (const line of out.split('\n')) {
      const [tty, session, pid] = line.trim().split('\t');
      if (tty && session) map.set(tty, { session, pid: pid ?? '' });
    }
    return map;
  }

  async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return check();
  }

  afterAll(() => {
    try {
      helper?.stdin?.write('EXIT\n');
    } catch {
      /* helper already gone */
    }
    helper?.kill();
    other?.kill();
    let socketPath = '';
    try {
      socketPath = run(['display-message', '-p', '#{socket_path}']).trim();
      run(['kill-server']);
    } catch {
      /* already gone */
    }
    if (socketPath.endsWith(`/${socket}`)) rmSync(socketPath, { force: true });
  });

  /** How many Esc-then-2 presses alpha's pane has echoed (the tty's ECHOCTL shows ESC as `^[`). */
  function escTwosInAlpha(): number {
    return run(['capture-pane', '-p', '-t', alpha]).split('^[2').length - 1;
  }

  it('switches the armed client only, including after that client has died', async () => {
    // alpha echoes what reaches its pane, so a key another client presses can
    // be seen arriving there instead of being eaten by the root binding.
    run(['new-session', '-d', '-s', alpha, '-x', '80', '-y', '24', 'stty -ixon; cat -v']);
    run(['new-session', '-d', '-s', beta, '-x', '80', '-y', '24', 'sleep 300']);

    helper = spawn('python3', ['-c', PTY_HELPER, socket, alpha], { stdio: ['pipe', 'pipe', 'inherit'] });
    createInterface({ input: helper.stdout! }).on('line', pushLine);
    const tty = (await nextLine()).trim();
    expect(tty).toMatch(CLIENT_TTY);

    expect(await client.armTuiSwitchGuard(tty)).toBe(true);
    const hooks = run(['show-hooks', '-g']);
    expect(hooks).toContain('client-attached[90]');
    // The closed form, as stored: disarmTuiSwitchGuard matches on it, so a
    // hook for /dev/pts/41 is not taken for /dev/pts/4's.
    expect(hooks).toContain(`#{client_tty},${tty}}`);
    // The stored hook still names the format. Expanding it while the hook is
    // stored would save an empty pid (no client yet) and the guard would never match.
    expect(hooks).toContain('#{client_pid}');

    helper.stdin!.write('GO\n');
    expect(await nextLine()).toBe('ATTACHED');
    expect(await waitFor(() => sessions().get(tty)?.session === alpha)).toBe(true);

    const pid = sessions().get(tty)?.pid ?? '';
    expect(pid).toMatch(/^[0-9]+$/);
    expect(await waitFor(() => run(['show-options', '-gv', '@codeman-tui-pid']).trim() === pid)).toBe(true);
    // One-shot: a later client on a reused pty is not recorded.
    expect(run(['show-hooks', '-g'])).not.toContain('client-attached[90]');

    expect(await client.bindSwitchKey('M-2', 'not-a-codeman-session', tty)).toBe(false);
    expect(await client.bindSwitchKey('M-2', beta, '/tmp/not-a-tty')).toBe(false);
    expect(await client.bindSwitchKey('M-2', beta, tty)).toBe(true);
    const listed = run(['list-keys', '-T', 'root']);
    expect(listed).toContain('if-shell -F');
    expect(listed).toContain(tty);
    expect(listed).toContain(`switch-client -t ${beta}`);

    // Esc then 2, one write, inside escape-time: tmux reads it as M-2.
    helper.stdin!.write('KEY 1b32\n');
    expect(await waitFor(() => sessions().get(tty)?.session === beta)).toBe(true);

    const env = { ...process.env } as Record<string, string>;
    delete env.TMUX;
    other = pty.spawn('tmux', ['-L', socket, '-f', '/dev/null', 'attach-session', '-t', alpha], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env,
    });
    // list-clients is the portable tty: /proc/<pid>/fd/0 does not exist on macOS.
    let otherTty = '';
    expect(
      await waitFor(() => {
        for (const [candidate, info] of sessions()) {
          if (candidate !== tty && info.session === alpha) {
            otherTty = candidate;
            return true;
          }
        }
        return false;
      })
    ).toBe(true);
    expect(otherTty).toMatch(CLIENT_TTY);
    expect(otherTty).not.toBe(tty);

    expect(escTwosInAlpha()).toBe(0);
    other.write('\x1b2');
    // Not moved, and not swallowed: the else branch hands the key to its pane.
    expect(await waitFor(() => escTwosInAlpha() === 1)).toBe(true);
    expect(sessions().get(otherTty)?.session).toBe(alpha);
    expect(sessions().get(tty)?.session).toBe(beta);

    // Killed before restore(): the binding remains, the pid is the dead client.
    helper.stdin!.write('EXIT\n');
    helper = null;
    expect(await waitFor(() => !sessions().has(tty))).toBe(true);
    expect(run(['list-keys', '-T', 'root'])).toContain(`#{client_tty},${tty}`);
    expect(run(['show-options', '-gv', '@codeman-tui-pid']).trim()).toBe(pid);

    other.write('\x1b2');
    expect(await waitFor(() => escTwosInAlpha() === 2)).toBe(true);
    expect(sessions().get(otherTty)?.session).toBe(alpha);

    // restore() drops the key because it still names this tty, and the dead pid.
    await client.unbindSwitchKey('M-2', tty);
    await client.disarmTuiSwitchGuard(tty);
    expect(run(['list-keys', '-T', 'root'])).not.toContain(`switch-client -t ${beta}`);
    expect(() => run(['show-options', '-gv', '@codeman-tui-pid'])).toThrow();

    // A hook armed for a tty this one is a prefix of (pts/4 vs pts/41) is
    // another TUI's, and this tty's disarm must leave it.
    const longer = `${tty}1`;
    expect(await client.armTuiSwitchGuard(longer)).toBe(true);
    await client.disarmTuiSwitchGuard(tty);
    expect(run(['show-hooks', '-g'])).toContain('client-attached[90]');
    await client.disarmTuiSwitchGuard(longer);
    expect(run(['show-hooks', '-g'])).not.toContain('client-attached[90]');
  });
});
