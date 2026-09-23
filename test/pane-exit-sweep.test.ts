/**
 * @fileoverview The clean-exit sweep (Ark0N/Codeman#446, part 2).
 *
 * A session whose agent the user ended with `/exit` is closed the way the X
 * button closes it, so finished sessions stop piling up on the board. A crashed
 * agent keeps its row, marked with the exit code.
 *
 * Each rule pinned here guards against a specific wrong close:
 *
 *  1. **Only an explicit numeric 0 is clean.** On tmux 3.2a a SIGKILLed pane
 *     reports neither a status nor a signal, so an absent status is the
 *     crashed-agent case, not the clean one.
 *  2. **Two agreeing reads, not one.** A single reading can describe a pane
 *     that is about to be revived.
 *  3. **Never while a start or attach is in flight.** The dead-pane respawn in
 *     `_setupOrAttachMuxSession()` revives an exited pane on purpose, and the
 *     pane reads as dead until it finishes.
 *  4. **Only local mux-backed sessions.** A remote session's local pane is its
 *     ssh client, whose death may be a transport drop.
 *
 * Port: 3189
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import type { PaneExit, SessionRemote } from '../src/types.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import {
  CLEAN_EXIT_CLOSE_REASON,
  CLEAN_EXIT_CONFIRMING_READS,
  isCleanPaneExit,
  shouldCloseCleanlyExitedSession,
} from '../src/pane-exit-sweep.js';

const PORT = 3189;
const AT = 1_700_000_000_000;

describe('isCleanPaneExit', () => {
  it('accepts an explicit status of 0 with no signal', () => {
    expect(isCleanPaneExit({ status: 0, at: AT })).toBe(true);
  });

  it('refuses an absent status, which is how a SIGKILL presents on tmux 3.2a', () => {
    expect(isCleanPaneExit({ at: AT })).toBe(false);
  });

  it('refuses a non-zero status', () => {
    expect(isCleanPaneExit({ status: 1, at: AT })).toBe(false);
    expect(isCleanPaneExit({ status: 137, at: AT })).toBe(false);
  });

  it('refuses any reported signal, even beside a 0', () => {
    expect(isCleanPaneExit({ signal: 9, at: AT })).toBe(false);
    expect(isCleanPaneExit({ status: 0, signal: 15, at: AT })).toBe(false);
  });

  it('refuses an unknown exit', () => {
    expect(isCleanPaneExit(undefined)).toBe(false);
  });
});

describe('shouldCloseCleanlyExitedSession', () => {
  const clean = {
    paneExit: { status: 0, at: AT } as PaneExit,
    confirmingReads: CLEAN_EXIT_CONFIRMING_READS,
    paneLifecycleInFlight: false,
    closing: false,
  };

  it('closes a clean exit that enough reads agreed on', () => {
    expect(CLEAN_EXIT_CONFIRMING_READS).toBe(2);
    expect(shouldCloseCleanlyExitedSession(clean)).toBe(true);
    expect(shouldCloseCleanlyExitedSession({ ...clean, confirmingReads: 5 })).toBe(true);
  });

  it('waits for the second read', () => {
    expect(shouldCloseCleanlyExitedSession({ ...clean, confirmingReads: 1 })).toBe(false);
    expect(shouldCloseCleanlyExitedSession({ ...clean, confirmingReads: 0 })).toBe(false);
  });

  it('leaves a session alone while its pane is being started or revived', () => {
    expect(shouldCloseCleanlyExitedSession({ ...clean, paneLifecycleInFlight: true })).toBe(false);
  });

  it('does not queue a second close for a session already closing', () => {
    expect(shouldCloseCleanlyExitedSession({ ...clean, closing: true })).toBe(false);
  });

  it('keeps a crashed agent however many reads saw it', () => {
    expect(shouldCloseCleanlyExitedSession({ ...clean, paneExit: { status: 137, at: AT }, confirmingReads: 9 })).toBe(
      false
    );
    expect(shouldCloseCleanlyExitedSession({ ...clean, paneExit: { at: AT }, confirmingReads: 9 })).toBe(false);
  });
});

describe('the sweep on a real server', () => {
  // Drives the real `paneExitsUpdated` wiring: the mux reports a reading, the
  // event fires, and the test checks whether the server closed the session.
  let server: WebServer | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.stop?.();
    server = null;
  });

  const remote: SessionRemote = { hostId: 'h1', label: 'box', host: 'box', user: 'dev' } as SessionRemote;

  /** The mux members `Session` needs to be a local mux-backed session that can be stopped. */
  const sessionMux = () =>
    ({
      isAvailable: () => true,
      killSession: async () => true,
    }) as unknown as TerminalMultiplexer;

  const addSession = (web: WebServer, extra: Record<string, unknown> = {}) => {
    const muxName = `codeman-${Math.random().toString(16).slice(2, 10)}`;
    const session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      useMux: true,
      mux: sessionMux(),
      muxSession: { muxName, sessionId: 'x' } as unknown as MuxSession,
      ...extra,
    });
    (web as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
    return { session, muxName };
  };

  /** A server whose mux reports `exit` for every pane, seen by `reads` reads. */
  const build = (exit: PaneExit | undefined, reads: number) => {
    const web = new WebServer(PORT, false, true);
    server = web;
    const mux = (web as unknown as { mux: Record<string, unknown> }).mux;
    const state = { exit, reads };
    mux.getPaneExit = () => state.exit;
    mux.getPaneExitReadCount = () => (state.exit ? state.reads : 0);
    const tick = () => (mux as unknown as { emit: (e: string) => void }).emit('paneExitsUpdated');
    const cleanup = vi
      .spyOn(web as unknown as { cleanupSession: (...a: unknown[]) => Promise<void> }, 'cleanupSession')
      .mockResolvedValue(undefined);
    return { web, state, tick, cleanup };
  };

  it('closes a cleanly exited session on the second read, with a reason in the lifecycle log', () => {
    const { web, state, tick, cleanup } = build({ status: 0, at: AT }, 1);
    const { session } = addSession(web);

    tick();
    expect(cleanup).not.toHaveBeenCalled();
    // The exit is on the record already, so the tab says "exited (0)" meanwhile.
    expect(session.paneExit).toEqual({ status: 0, at: AT });

    state.reads = 2;
    tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(session.id, true, CLEAN_EXIT_CLOSE_REASON);
  });

  it('keeps a crashed agent on the board', () => {
    const { web, tick, cleanup } = build({ status: 137, at: AT }, 5);
    addSession(web);
    tick();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('keeps an agent whose exit status tmux did not report', () => {
    const { web, tick, cleanup } = build({ at: AT }, 5);
    addSession(web);
    tick();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('never closes a remote session, whose local pane is only the ssh client', () => {
    const { web, tick, cleanup } = build({ status: 0, at: AT }, 5);
    addSession(web, { remote });
    tick();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('leaves a session alone while its pane is being revived', () => {
    const { web, tick, cleanup } = build({ status: 0, at: AT }, 5);
    const { session } = addSession(web);
    vi.spyOn(session, 'paneLifecycleInFlight', 'get').mockReturnValue(true);
    tick();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('closes nothing when the mux cannot count its reads', () => {
    const { web, tick, cleanup } = build({ status: 0, at: AT }, 5);
    delete (web as unknown as { mux: Record<string, unknown> }).mux.getPaneExitReadCount;
    addSession(web);
    tick();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('removes the session for real through cleanupSession', async () => {
    // No spy on cleanupSession here: the close runs the same path as the X
    // button, and the session leaves the server's map.
    const web = new WebServer(PORT, false, true);
    server = web;
    const mux = (web as unknown as { mux: Record<string, unknown> }).mux;
    mux.getPaneExit = () => ({ status: 0, at: AT });
    mux.getPaneExitReadCount = () => 2;
    const { session } = addSession(web);
    const sessions = (web as unknown as { sessions: Map<string, Session> }).sessions;

    (mux as unknown as { emit: (e: string) => void }).emit('paneExitsUpdated');
    await vi.waitFor(() => expect(sessions.has(session.id)).toBe(false));
  });
});

describe('the pane lifecycle mark on Session', () => {
  it('is raised for the whole of restartCli and lowered afterwards, even on failure', async () => {
    let seenDuring: boolean | null = null;
    let session: Session;
    const mux = {
      isAvailable: () => true,
      muxSessionExists: () => true,
      respawnPane: async () => {
        seenDuring = session.paneLifecycleInFlight;
        throw new Error('respawn failed');
      },
      clearPaneExit: () => {},
    } as unknown as TerminalMultiplexer;
    session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      useMux: true,
      mux,
      muxSession: { muxName: 'codeman-aaaa', sessionId: 'aaaa' } as unknown as MuxSession,
    });

    expect(session.paneLifecycleInFlight).toBe(false);
    await expect(session.restartCli()).rejects.toThrow('respawn failed');
    expect(seenDuring).toBe(true);
    expect(session.paneLifecycleInFlight).toBe(false);
  });
});
