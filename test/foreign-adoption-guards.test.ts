/**
 * @fileoverview The two adoption guards that are not reachable over HTTP: the
 * boot-time workspace-hook sweep, and the workspace-trust auto-accept.
 *
 * Both act on a session's WORKSPACE or its PANE, both run unattended, and both
 * previously keyed off `session.remote` or the mode alone — neither of which
 * sees an adopted session, whose connection facts live on `adopt.remote` /
 * `adopt.docker`. So a tab wrapping someone's claude read as a plain local
 * claude: Codeman wrote `.claude/settings.local.json` into their repo on every
 * restart, and answered a trust dialog that was theirs to answer.
 *
 * Each one is paired with a session Codeman DID start — without that control,
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
    server = new WebServer({ port: 3197 });
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

  it('still skips a plain remote session — the older rule is untouched', async () => {
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
