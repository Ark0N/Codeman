/**
 * @fileoverview A resumed codex session must keep its thread-id alias across
 * `start()`, not just at construction.
 *
 * `claudeSessionId` doubles as the generic "external transcript id" the unified
 * list folds a Past-Sessions row into its owning session by. For codex that id
 * is the rollout's thread id, and losing it is not cosmetic: the stale row stays
 * in PAST and still resumes, so clicking it starts a SECOND `codex resume` on a
 * thread already open in the live pane.
 *
 * The bug this pins: the alias was wired into the constructor only. `start()`
 * recomputes `claudeSessionId` at two further points — the mux branch and the
 * unconditional "third reset point" that runs after both the mux and direct-PTY
 * paths — and both listed only Claude's `resumeSessionId` and omp's. For codex
 * both are undefined, so every mux reattach and every boot recovery reset the
 * alias back to the Codeman id and the duplicate came back. The existing comment
 * at the third reset point already warned that omitting omp's fallback there
 * "stomps the mux branch's correctly-resolved OMP alias"; codex needed the same.
 *
 * Mirrors `test/omp-fresh-run-no-resume.test.ts`, which drives a real `Session`
 * against the in-memory tmux layer that vitest substitutes.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';

describe('codex: a resumed thread id survives start()', () => {
  const workingDir = join(homedir(), 'codeman-cases', 'codex-resume-alias');
  const THREAD_ID = '01a060f0-0361-7f91-abde-b283020db0d7';
  const sessions: Session[] = [];

  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    rmSync(workingDir, { recursive: true, force: true });
  });

  function makeSession(useMux: boolean): Session {
    mkdirSync(workingDir, { recursive: true });
    const session = new Session({
      workingDir,
      mode: 'codex',
      codexConfig: { resumeSessionId: THREAD_ID },
      mux: new TmuxManager(),
      useMux,
    });
    sessions.push(session);
    return session;
  }

  it('carries the thread id from construction', () => {
    expect(makeSession(true).claudeSessionId).toBe(THREAD_ID);
  });

  it('still carries it after starting under mux', async () => {
    const session = makeSession(true);
    await session.startInteractive();
    expect(session.claudeSessionId).toBe(THREAD_ID);
  });

  it('refuses to start without mux at all, so the mux path is the only one to cover', async () => {
    // codex declares `requiresMux`, so there is no direct-PTY codex session for
    // the third reset point to run against on its own — the assertion above is
    // the whole surface.
    await expect(makeSession(false).startInteractive()).rejects.toThrow(/require tmux/i);
  });

  it('a fresh codex session keeps the Codeman id, having no thread of its own', async () => {
    mkdirSync(workingDir, { recursive: true });
    const session = new Session({ workingDir, mode: 'codex', mux: new TmuxManager(), useMux: true });
    sessions.push(session);

    await session.startInteractive();

    // Nothing to alias to yet — codex has not written the rollout. Such a
    // session is folded from the other side, by originator (codexThreadBySessionId).
    expect(session.claudeSessionId).toBe(session.id);
  });
});
