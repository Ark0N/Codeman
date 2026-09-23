/**
 * @fileoverview `SessionState.paneExit` — Codeman noticing that a pane's agent
 * has exited (Ark0N/Codeman#446).
 *
 * Codeman creates every tmux pane with `remain-on-exit on`, so `/exit` ends the
 * CLI while tmux keeps the pane and the `tmux attach-session` process Codeman
 * records as the session's pid. No PTY exit handler runs, and the record used to
 * keep both its pid and `status: 'idle'`, so the board showed an exited session
 * as a live idle one.
 *
 * Four properties are pinned here, each because getting it wrong costs something
 * specific:
 *
 *  1. **The field is tri-state, and absence means UNKNOWN.** A direct-PTY
 *     session owns no pane, a remote SSH session's local pane holds the ssh
 *     client, and a docker case's local pane holds a `docker exec`. In all
 *     three, a dead local pane is not the agent exiting.
 *  2. **`status` and `pid` are never touched.** `status: 'error'` belongs to the
 *     PTY-exit circuit breaker and makes the browser offer a restart, and a null
 *     `pid` is what makes the browser re-attach and launch a fresh CLI.
 *  3. **It reaches `toState()`**, which is both the `session:updated` payload
 *     and what `state.json` persists.
 *  4. **It round-trips through the store**, because a reboot takes the tmux
 *     server and the persisted record is the only thing left that can say the
 *     agent was already gone.
 *
 * Port: 3187
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import { StateStore } from '../src/state-store.js';
import type { PaneExit, SessionRemote, SessionDocker, SessionState } from '../src/types.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { hasObservablePaneSession } from '../src/tmux-manager.js';

const PORT = 3187;

const EXIT: PaneExit = { status: 0, at: 1_700_000_000_000 };

/** The two mux members `Session` reads when it decides whether the field applies. */
const stubMux = () => ({ isAvailable: () => true }) as unknown as TerminalMultiplexer;

const stubMuxSession = (muxName = 'codeman-aaaa') => ({ muxName, sessionId: 'aaaa' }) as unknown as MuxSession;

const remote: SessionRemote = { hostId: 'h1', label: 'box', host: 'box', user: 'dev' } as SessionRemote;

const docker: SessionDocker = { hostId: 'd1', label: 'ctr', containerName: 'ctr' } as SessionDocker;

/** A local, mux-backed session: the one shape the field applies to. */
function localMuxSession(extra: Record<string, unknown> = {}) {
  return new Session({
    workingDir: '/tmp',
    mode: 'claude',
    useMux: true,
    mux: stubMux(),
    muxSession: stubMuxSession(),
    ...extra,
  });
}

describe('Session.setPaneExit scoping', () => {
  it('accepts an exit for a local mux-backed session', () => {
    const session = localMuxSession();
    expect(session.setPaneExit(EXIT)).toBe(true);
    expect(session.paneExit).toEqual(EXIT);
  });

  it('stays unknown for a direct-PTY session, which owns no pane at all', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude', useMux: false });
    expect(session.setPaneExit(EXIT)).toBe(false);
    expect(session.paneExit).toBeUndefined();
  });

  it('stays unknown while the session has no mux session yet', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude', useMux: true, mux: stubMux() });
    expect(session.setPaneExit(EXIT)).toBe(false);
    expect(session.paneExit).toBeUndefined();
  });

  it('stays unknown for a remote SSH session, whose pane holds the ssh client', () => {
    // A dead ssh client means a transport drop OR an exit, and telling those two
    // apart is the whole of PR #355. Publishing it as an agent exit would assert
    // the answer Codeman does not have.
    const session = localMuxSession({ remote });
    expect(session.setPaneExit(EXIT)).toBe(false);
    expect(session.paneExit).toBeUndefined();
  });

  it('stays unknown for a docker case, whose pane holds a docker exec', () => {
    const session = localMuxSession({ docker });
    expect(session.setPaneExit(EXIT)).toBe(false);
    expect(session.paneExit).toBeUndefined();
  });

  it('clears a stored exit when a later tick reports nothing', () => {
    const session = localMuxSession();
    session.setPaneExit(EXIT);
    expect(session.setPaneExit(undefined)).toBe(true);
    expect(session.paneExit).toBeUndefined();
  });

  it('reports no change when a tick repeats the same observation', () => {
    // The caller persists and broadcasts on a true, and this tick runs every
    // 2000 ms for every session.
    const session = localMuxSession();
    session.setPaneExit(EXIT);
    expect(session.setPaneExit({ ...EXIT })).toBe(false);
  });

  it('reports a change when the exit status changes', () => {
    const session = localMuxSession();
    session.setPaneExit(EXIT);
    expect(session.setPaneExit({ status: 137, at: EXIT.at })).toBe(true);
    expect(session.paneExit).toEqual({ status: 137, at: EXIT.at });
  });
});

describe("the watcher's read gate agrees with the session's scoping", () => {
  // `hasObservablePaneSession()` decides whether a watcher tick execs tmux at
  // all, and `Session.paneExitApplies` decides whether the answer is kept. They
  // are two copies of one rule, and drift between them is silent: too narrow
  // and a session that could report an exit never gets read, too wide and every
  // tick pays for an answer the session throws away.
  const muxSession = (extra: Partial<MuxSession> = {}): MuxSession =>
    ({
      sessionId: 'aaaa',
      muxName: 'codeman-aaaa',
      pid: 100,
      createdAt: 0,
      workingDir: '/tmp',
      mode: 'claude',
      attached: true,
      ...extra,
    }) as MuxSession;

  const cases: { shape: string; mux: MuxSession; session: () => Session }[] = [
    { shape: 'local', mux: muxSession(), session: () => localMuxSession() },
    { shape: 'remote SSH', mux: muxSession({ remote }), session: () => localMuxSession({ remote }) },
    { shape: 'docker', mux: muxSession({ docker }), session: () => localMuxSession({ docker }) },
    {
      shape: 'rebuilt from the socket',
      mux: muxSession({ discovered: true }),
      session: () => localMuxSession({ discoveredMuxSession: true }),
    },
  ];

  for (const { shape, mux, session } of cases) {
    it(`agrees for a ${shape} session`, () => {
      const sessionKeepsIt = session().setPaneExit(EXIT);
      expect(hasObservablePaneSession([mux])).toBe(sessionKeepsIt);
    });
  }
});

describe('Session.toState with an exited agent', () => {
  it('publishes the exit and leaves status and pid alone', () => {
    const session = localMuxSession();
    const before = session.toState();
    session.setPaneExit(EXIT);
    const after = session.toState();

    expect(before.paneExit).toBeUndefined();
    expect(after.paneExit).toEqual(EXIT);
    expect(after.status).toBe(before.status);
    expect(after.pid).toBe(before.pid);
    // `status: 'error'` is the PTY-exit breaker's value; the browser answers it
    // with a "restart it?" confirm.
    expect(after.status).not.toBe('error');
  });

  it('restores a persisted exit so the first persist after boot cannot blank it', () => {
    const session = localMuxSession({ paneExit: EXIT });
    expect(session.toState().paneExit).toEqual(EXIT);
  });

  it('ignores a persisted exit for a session shape the field never applies to', () => {
    // The scoping is not only about live ticks: a record written before a
    // session was reconfigured must not resurrect an answer that cannot hold.
    // The constructor alone has to enforce it, before any tick runs.
    expect(new Session({ workingDir: '/tmp', mode: 'claude', useMux: false, paneExit: EXIT }).paneExit).toBeUndefined();
    expect(localMuxSession({ remote, paneExit: EXIT }).paneExit).toBeUndefined();
    expect(localMuxSession({ docker, paneExit: EXIT }).paneExit).toBeUndefined();
  });
});

describe('a relaunch in the same pane forgetting the old exit', () => {
  /** A mux whose respawn succeeds, so `restartCli()` reaches its success path. */
  const respawningMux = () => {
    const cleared: string[] = [];
    const mux = {
      isAvailable: () => true,
      muxSessionExists: () => true,
      respawnPane: async () => 4242,
      clearPaneExit: (muxName: string) => cleared.push(muxName),
    };
    return { mux: mux as unknown as TerminalMultiplexer, cleared };
  };

  it('clears the exit when restartCli relaunches the CLI', async () => {
    // restartCli() is the custom-model endpoint switch. Its caller persists and
    // broadcasts straight afterwards, so an exit left in place here is written
    // back onto a session that is running again.
    const { mux, cleared } = respawningMux();
    const session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      useMux: true,
      mux,
      muxSession: stubMuxSession(),
      paneExit: EXIT,
    });
    expect(session.paneExit).toEqual(EXIT);

    expect(await session.restartCli()).toBe(true);

    expect(session.paneExit).toBeUndefined();
    expect(session.toState().paneExit).toBeUndefined();
    // Both halves: the record and the mux layer's cache, the latter of which
    // also invalidates a pane read already in flight.
    expect(cleared).toEqual(['codeman-aaaa']);
  });

  it('leaves the exit alone when the relaunch fails', async () => {
    // A failed respawn means the old command is still what the pane last ran.
    const { mux, cleared } = respawningMux();
    (mux as unknown as { respawnPane: () => Promise<null> }).respawnPane = async () => null;
    const session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      useMux: true,
      mux,
      muxSession: stubMuxSession(),
      paneExit: EXIT,
    });

    expect(await session.restartCli()).toBe(false);

    expect(session.paneExit).toEqual(EXIT);
    expect(cleared).toEqual([]);
  });
});

describe('paneExit round trip through state.json', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('survives a write and a reload, which is what a reboot restore reads', () => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-pane-exit-'));
    const file = join(dir, 'state.json');
    const stored: SessionState = {
      ...localMuxSession().toState(),
      paneExit: { status: 0, signal: undefined, at: 1_700_000_000_000 },
    };

    const writer = new StateStore(file);
    writer.setSession(stored.id, stored);
    writer.saveNow();

    const reader = new StateStore(file);
    expect(reader.getSession(stored.id)?.paneExit).toEqual({ at: 1_700_000_000_000, status: 0 });
  });

  it('reads a record written before the field existed as unknown, needing no migration', () => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-pane-exit-'));
    const file = join(dir, 'state.json');
    const legacy = localMuxSession().toState();
    delete legacy.paneExit;

    const writer = new StateStore(file);
    writer.setSession(legacy.id, legacy);
    writer.saveNow();

    expect(new StateStore(file).getSession(legacy.id)?.paneExit).toBeUndefined();
  });
});

describe('a pane read reaching the session record', () => {
  // Drives the real `paneExitsUpdated` wiring rather than asserting on source
  // text: a fake reading goes into the mux, the event fires, and the session
  // record is checked. This is the path findings about the watcher turn on.
  let server: WebServer | null = null;

  afterEach(async () => {
    await server?.stop?.();
    server = null;
  });

  const build = () => {
    const web = new WebServer(PORT, false, true);
    const mux = (web as unknown as { mux: Record<string, unknown> }).mux;
    const session = localMuxSession();
    (web as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
    return { web, mux, session };
  };

  it('publishes an exit the mux reports for a local pane', () => {
    const { web, mux, session } = build();
    server = web;
    mux.getPaneExit = () => EXIT;
    (mux as unknown as { emit: (e: string) => void }).emit('paneExitsUpdated');

    expect(session.paneExit).toEqual(EXIT);
    expect(session.toState().paneExit).toEqual(EXIT);
  });

  it('leaves status and pid alone while doing it', () => {
    const { web, mux, session } = build();
    server = web;
    const before = session.toState();
    mux.getPaneExit = () => EXIT;
    (mux as unknown as { emit: (e: string) => void }).emit('paneExitsUpdated');

    const after = session.toState();
    expect(after.status).toBe(before.status);
    expect(after.pid).toBe(before.pid);
    // `status: 'error'` is the PTY-exit breaker's value; it makes the browser
    // offer a restart. A null pid makes it launch a fresh CLI.
    expect(after.status).not.toBe('error');
  });

  it('retracts the exit once the mux reports the pane is back', () => {
    const { web, mux, session } = build();
    server = web;
    mux.getPaneExit = () => EXIT;
    (mux as unknown as { emit: (e: string) => void }).emit('paneExitsUpdated');
    mux.getPaneExit = () => undefined;
    (mux as unknown as { emit: (e: string) => void }).emit('paneExitsUpdated');

    expect(session.paneExit).toBeUndefined();
  });

  it('publishes nothing for a session the field does not apply to', () => {
    const { web, mux } = build();
    server = web;
    const remoteSession = localMuxSession({ remote });
    (web as unknown as { sessions: Map<string, Session> }).sessions.set(remoteSession.id, remoteSession);
    mux.getPaneExit = () => EXIT;
    (mux as unknown as { emit: (e: string) => void }).emit('paneExitsUpdated');

    expect(remoteSession.paneExit).toBeUndefined();
  });
});
