/**
 * @fileoverview The adoption guards that are not reachable over HTTP: the
 * boot-time workspace-hook sweep, the workspace-trust auto-accept, the new-shell
 * clear and the direct-PTY fallback.
 *
 * Each acts on a session's WORKSPACE or its PANE, each runs unattended, and each
 * previously keyed off `session.remote`, the mode or nothing at all, none of which
 * sees an adopted session, whose connection facts live on `adopt.remote` /
 * `adopt.docker`. So a tab wrapping someone's claude read as a plain local
 * claude: Codeman wrote `.claude/settings.local.json` into their repo on every
 * restart, and answered a trust dialog that was theirs to answer.
 *
 * Each one is paired with a session Codeman DID start: without that control,
 * "nothing was written" is equally explained by a disabled setting or a loop
 * that never ran.
 *
 * Port: none (no server is listened on).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const applyWorkspaceHooks = vi.fn(async () => {});
vi.mock('../src/hooks-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks-config.js')>();
  return { ...actual, applyWorkspaceHooks: (...args: unknown[]) => applyWorkspaceHooks(...(args as [])) };
});

// The direct-PTY fallback must never run the real `claude` or a real login shell from a
// test, and the spawn is the one thing that proves whether it happened at all.
const ptySpawn = vi.fn();
vi.mock('node-pty', async (importOriginal) => {
  const real = await importOriginal<typeof import('node-pty')>();
  return {
    ...real,
    spawn: (file: string, args: string[] | string, options: import('node-pty').IPtyForkOptions) => {
      ptySpawn(file, args);
      return real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    },
  };
});

const { WebServer } = await import('../src/web/server.js');
const { Session } = await import('../src/session.js');

type AnySession = Record<string, unknown>;

/** The minimum a session needs to reach the sweep's `workspaces` set. */
function fakeSession(over: AnySession): AnySession {
  return { mode: 'claude', workingDir: '/srv/app', isAdopted: false, ...over };
}

describe('the boot workspace-hook sweep', () => {
  let server: InstanceType<typeof WebServer>;

  beforeEach(() => {
    applyWorkspaceHooks.mockClear();
    server = new WebServer(0);
    (server as unknown as { getWorkspaceHooksEnabled: () => Promise<boolean> }).getWorkspaceHooksEnabled = async () =>
      true;
  });
  afterEach(async () => {
    await server.stop().catch(() => {});
  });

  const sweep = async (sessions: AnySession[]) => {
    const map = new Map<string, AnySession>();
    sessions.forEach((s, i) => map.set(`s${i}`, s));
    (server as unknown as { sessions: Map<string, AnySession> }).sessions = map;
    await (
      server as unknown as { ensureHooksForRecoveredWorkspaces: () => Promise<void> }
    ).ensureHooksForRecoveredWorkspaces();
    return applyWorkspaceHooks.mock.calls.map((c) => c[0]);
  };

  it('installs hooks into a workspace Codeman owns', async () => {
    expect(await sweep([fakeSession({ workingDir: '/srv/ours' })])).toContain('/srv/ours');
  });

  it('skips an adopted session even though its mode is claude and `remote` is unset', async () => {
    // This is the exact shape the bug had: the ssh/docker facts hang off
    // `adopt`, so the pre-existing `session.remote` check sees nothing.
    const adopted = fakeSession({
      workingDir: '/home/them/repo',
      isAdopted: true,
      adopt: { location: 'remote', remote: { host: 'box' } },
    });
    expect(await sweep([adopted])).not.toContain('/home/them/repo');
  });

  it('still skips a plain remote session, the older rule is untouched', async () => {
    expect(await sweep([fakeSession({ workingDir: '/srv/far', remote: { host: 'box' } })])).not.toContain('/srv/far');
  });
});

describe('the workspace-trust auto-accept', () => {
  const makeSession = (adopt?: Record<string, unknown>) =>
    new Session({
      id: adopt ? 'adopt-trust' : 'own-trust',
      name: 't',
      workingDir: '/tmp',
      mode: 'claude',
      ...(adopt ? { adopt } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

  const scan = (s: InstanceType<typeof Session>) => {
    const priv = s as unknown as {
      _interactiveStartedAt: number;
      _trustDialogAccepted: boolean;
      _maybeAcceptTrustDialog: () => void;
      _trustDialogTimer: unknown;
    };
    priv._interactiveStartedAt = Date.now(); // inside the 90s startup window
    priv._trustDialogAccepted = false;
    priv._maybeAcceptTrustDialog();
    return priv;
  };

  it('arms the scan for a session Codeman started', async () => {
    const s = makeSession();
    const priv = scan(s);
    expect(priv._trustDialogAccepted).toBe(false);
    await s.stop(true).catch(() => {});
  });

  it('never answers a dialog in an adopted pane', async () => {
    // That pane holds SOMEONE ELSE'S claude. And boot recovery re-opens the 90s
    // window on every restart, so this is not a one-shot at adoption time.
    const s = makeSession({
      location: 'local',
      socketPath: '/tmp/tmux-0/default',
      targetSession: 'work',
      viewSession: '',
    });
    const priv = scan(s);
    expect(priv._trustDialogAccepted).toBe(true); // short-circuited, never scans again
    expect(priv._trustDialogTimer).toBeFalsy();
    await s.stop(true).catch(() => {});
  });
});

describe('the new-shell clear', () => {
  /** What a shell session writes to its pane once the mux attach is up. */
  const bytesWrittenAfterStart = async (adopt?: Record<string, unknown>) => {
    const s = new Session({
      id: adopt ? 'adopt-shell' : 'own-shell',
      name: 't',
      workingDir: '/tmp',
      mode: 'shell',
      useMux: true,
      mux: {},
      ...(adopt ? { adopt } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const write = vi.fn();
    const disposable = () => ({ dispose() {} });
    const priv = s as unknown as Record<string, unknown>;
    priv._setupOrAttachMuxSession = async () => {
      priv.ptyProcess = { write, onData: disposable, onExit: disposable, kill() {}, pid: 1 };
      return { isRestored: false, respawnedDeadPane: false };
    };
    await s.startShell();
    await new Promise((resolve) => setTimeout(resolve, 200));
    priv.ptyProcess = null;
    await s.stop(true).catch(() => {});
    return write.mock.calls.map((c) => c[0]);
  };

  it('clears a shell Codeman started', async () => {
    expect(await bytesWrittenAfterStart()).toEqual(['clear\n']);
  });

  it('types nothing into an adopted pane', async () => {
    // ⚠️ That pane is someone else's, and `shell` is also the answer for anything the
    // classifier cannot name (vim, psql, a `read` prompt). `clear` plus a newline landed
    // on a half-typed command or in whatever was reading stdin, on every adoption.
    const adopt = { location: 'local', socketPath: '/tmp/tmux-0/default', targetSession: 'work', viewSession: '' };
    expect(await bytesWrittenAfterStart(adopt)).toEqual([]);
  });
});

describe('the direct-PTY fallback', () => {
  const adopt = { location: 'remote', socketPath: '/tmp/tmux-0/default', targetSession: 'work', viewSession: '' };

  /** A wrapper that cannot start: `createSession` threw (a loaded tmux server timing out, say). */
  const session = (mode: 'claude' | 'shell', opts: { adopt?: typeof adopt; useMux?: boolean } = {}) => {
    const s = new Session({
      name: 'work',
      workingDir: '/tmp',
      mode,
      useMux: opts.useMux ?? true,
      mux: {},
      ...(opts.adopt ? { adopt: opts.adopt } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const errors: string[] = [];
    s.on('error', (message: string) => errors.push(message));
    const priv = s as unknown as Record<string, unknown>;
    priv._setupOrAttachMuxSession = async () => {
      throw new Error('tmux new-session timed out');
    };
    return { s, priv, errors };
  };

  beforeEach(() => ptySpawn.mockClear());

  it('still catches a session Codeman started, whose fallback is a real PTY', async () => {
    // The control: without it, "nothing spawned" below is equally explained by a mock
    // that never sees a spawn. A shell, because a claude fallback also probes the real binary.
    const { s } = session('shell');
    await s.startShell();
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    await s.stop(true).catch(() => {});
  });

  it.each([
    ['claude', 'startInteractive'],
    ['shell', 'startShell'],
  ] as const)('never starts a local %s for an adopted session (%s)', async (mode, start) => {
    // ⚠️ The tab still says it is someone else's session. A fallback here runs
    // `claude --dangerously-skip-permissions` or a server-account shell in `/tmp` on THIS
    // host, so whoever opened an ssh or container session ends up typing into this one.
    const { s, errors } = session(mode, { adopt });
    await expect(s[start]()).rejects.toThrow(/tmux new-session timed out/);
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(s.pid).toBeNull();
    expect(s.status).toBe('stopped');
    // The browser's re-attach does not read the POST's answer, so this is what the tab shows.
    expect(errors.join()).toMatch(/work/);
  });

  it('leaves the wrapper to be tried again', async () => {
    const { s, priv } = session('shell', { adopt });
    await expect(s.startShell()).rejects.toThrow();
    const disposable = () => ({ dispose() {} });
    priv._setupOrAttachMuxSession = async () => {
      priv.ptyProcess = { write: vi.fn(), onData: disposable, onExit: disposable, kill() {}, pid: 1 };
      return { isRestored: true, respawnedDeadPane: false };
    };
    await s.startShell();
    expect(s.pid).toBe(1);
    expect(ptySpawn).not.toHaveBeenCalled();
    priv.ptyProcess = null;
    await s.stop(true).catch(() => {});
  });

  it.each([
    ['claude', 'startInteractive'],
    ['shell', 'startShell'],
  ] as const)('never starts a local %s for an adopted session with no mux at all (%s)', async (mode, start) => {
    const { s } = session(mode, { adopt, useMux: false });
    await expect(s[start]()).rejects.toThrow(/tmux/);
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  it('refuses a one-shot prompt, a new local claude rather than the agent in that pane', async () => {
    const { s } = session('claude', { adopt });
    await expect(s.runPrompt('hello')).rejects.toThrow(/adopted/i);
    expect(ptySpawn).not.toHaveBeenCalled();
  });
});
