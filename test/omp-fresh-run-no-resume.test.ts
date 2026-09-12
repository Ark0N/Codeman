/**
 * @fileoverview Pins the "Run OMP always resumes" bug found live 2026-08-27,
 * and its follow-on fix for the sibling-aliasing bug found in upstream PR
 * review (Ark0N/Codeman#353).
 *
 * Session._pinOmpRespawnId() resolves-and-pins the newest on-disk omp
 * conversation as a side effect on `this._ompConfig`. That is correct ONLY
 * immediately before an ACTUAL respawn (a confirmed-dead pane, or a genuine
 * remote reattach) — never while merely building options that might not
 * lead to one. It used to run eagerly inside `_buildRespawnPaneOptions()`,
 * which startInteractive() calls unconditionally (including for a genuinely
 * brand-new session, and for a boot-recovery reattach to a pane that turns
 * out to still be alive): a fresh "Run OMP" click in a working directory
 * with any prior omp history silently launched `--resume <old-id>` instead
 * of a clean `omp` invocation, and — with two omp tabs in the same case dir
 * — a live pane's `_ompConfig`/`claudeSessionId` could get mis-pinned to
 * whichever sibling's file happened to be newest on disk, even though
 * nothing was actually being respawned. Resolution now happens only inside
 * `_pinOmpRespawnId()`, called by a caller that has already confirmed a
 * real respawn is happening.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession, SessionRemote } from '../src/types.js';

describe('OMP: fresh session vs. reattach must not share resumeSessionId resolution', () => {
  const workingDir = join(homedir(), 'codeman-cases', 'resume-test');
  const sessionDir = join(homedir(), '.omp', 'agent', 'sessions', '-codeman-cases-resume-test');
  const sessions: Session[] = [];

  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    rmSync(join(homedir(), '.omp'), { recursive: true, force: true });
  });

  function seedOmpSessionFile(id: string) {
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    // resolveAndClaimOmpSessionId() verifies the file's own header (not just
    // the filename), mirroring the real `omp` session-file shape — the
    // header's `cwd` must match `workingDir` for the candidate to count.
    const header = `${JSON.stringify({ type: 'session', id, cwd: workingDir })}\n`;
    writeFileSync(join(sessionDir, `2026-08-27T17-31-08-001Z_${id}.jsonl`), header);
  }

  it('a brand-new session (no prior mux session) never inherits an on-disk conversation', async () => {
    seedOmpSessionFile('old-conversation-id');

    const session = new Session({
      workingDir,
      mode: 'omp',
      mux: new TmuxManager(),
      useMux: true,
    });
    sessions.push(session);

    await session.startInteractive();
    const state = session.toState();

    expect(state.ompConfig).toBeUndefined();
    expect(session.claudeSessionId).toBe(session.id);
  });

  it('a plain reattach to an existing mux session (pane still alive) does NOT pin', async () => {
    // Regression for the sibling-aliasing bug: pinning must never be a side
    // effect of merely building respawn options for a pane that might still
    // be alive (isPaneDead is unconditionally false under IS_TEST_MODE,
    // which is what a real "just reattaching, nothing died" boot recovery
    // looks like from Session's perspective).
    seedOmpSessionFile('sibling-conversation-id');

    const muxSession: MuxSession = {
      sessionId: 'placeholder',
      muxName: 'codeman-deadbeef',
      pid: 1,
      createdAt: Date.now(),
      workingDir,
      mode: 'omp',
      attached: false,
    };

    const session = new Session({
      workingDir,
      mode: 'omp',
      mux: new TmuxManager(),
      useMux: true,
      muxSession,
    });
    sessions.push(session);

    await session.startInteractive();
    const state = session.toState();

    expect(state.ompConfig?.resumeSessionId).toBeUndefined();
    expect(session.claudeSessionId).toBe(session.id);
  });

  it('_pinOmpRespawnId() resolves and pins the real id once a respawn is confirmed', () => {
    seedOmpSessionFile('real-omp-uuid');

    const muxSession: MuxSession = {
      sessionId: 'placeholder',
      muxName: 'codeman-deadbeef',
      pid: 1,
      createdAt: Date.now(),
      workingDir,
      mode: 'omp',
      attached: false,
    };

    const session = new Session({
      workingDir,
      mode: 'omp',
      mux: new TmuxManager(),
      useMux: true,
      muxSession,
    });
    sessions.push(session);

    (session as unknown as { _pinOmpRespawnId(): void })._pinOmpRespawnId();

    expect(session.toState().ompConfig?.resumeSessionId).toBe('real-omp-uuid');
    expect(session.claudeSessionId).toBe('real-omp-uuid');
  });

  it("a remote session never resolves --resume from this host's local ~/.omp, even when a same-named local session file exists", () => {
    // Seed a LOCAL session file whose directory mangle happens to match this
    // remote session's remotePath. If _pinOmpRespawnId() ever fell through to
    // resolveAndClaimOmpSessionId() for a remote session, it would wrongly
    // claim/pin this unrelated local conversation's id onto the remote respawn.
    seedOmpSessionFile('wrong-local-conversation-id');

    const remote: SessionRemote = {
      hostId: 'remote-box',
      label: 'remote-box',
      host: 'remote-box',
      username: 'someone',
      remotePath: workingDir,
      owned: true,
    };

    const muxSession: MuxSession = {
      sessionId: 'placeholder',
      muxName: 'codeman-deadbeef',
      pid: 1,
      createdAt: Date.now(),
      workingDir,
      mode: 'omp',
      attached: false,
    };

    const session = new Session({
      workingDir,
      mode: 'omp',
      mux: new TmuxManager(),
      useMux: true,
      muxSession,
      remote,
    });
    sessions.push(session);

    (session as unknown as { _pinOmpRespawnId(): void })._pinOmpRespawnId();

    const state = session.toState();
    expect(state.ompConfig?.resumeSessionId).toBeUndefined();
    expect(state.ompConfig?.continueSession).toBe(true);
    expect(session.claudeSessionId).toBe(session.id);
  });
});
