/**
 * @fileoverview A session's launch model survives recovery.
 *
 * `Session._model` is what becomes `claude --model <id>`: the caller's per-session `model`
 * from POST /api/sessions, or the app-wide default. It lives in memory, so it reaches a
 * relaunch after a Codeman restart or a reboot restore only if `toState()` persists it and
 * both recovery constructors hand it back. Without that, a recovered session silently
 * relaunches on the account default.
 *
 * `restoreMuxSessions()` (server.ts) cannot be reached under vitest, where
 * `reconcileSessions()` reports every pane alive, and the reboot-restore route rejects every
 * workspace before building a Session in its route tests. The two constructors are therefore
 * pinned by a source check, the same way `test/remote-wake.test.ts` pins its wiring, and the
 * round trip itself is driven through a real `Session` against the in-memory tmux layer.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

describe('the launch model survives recovery', () => {
  const workingDir = join(homedir(), 'codeman-cases', 'session-model-recovery');
  const sessions: Session[] = [];

  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('persists the model in the session state', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude', model: 'claude-fable-5-1' });
    sessions.push(session);
    expect(session.toState().model).toBe('claude-fable-5-1');
  });

  it('relaunches a session rebuilt from that state on the same model', async () => {
    mkdirSync(workingDir, { recursive: true });
    const original = new Session({ workingDir, mode: 'claude', model: 'claude-fable-5-1' });
    sessions.push(original);
    const state = original.toState();

    // Rebuilt the way both recovery paths build one, from the persisted record.
    const mux = new TmuxManager();
    const createSession = vi.spyOn(mux, 'createSession');
    const rebuilt = new Session({
      id: state.id,
      workingDir,
      mode: state.mode,
      mux,
      useMux: true,
      model: state.model,
    });
    sessions.push(rebuilt);
    await rebuilt.startInteractive();

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-fable-5-1' }));
  });

  it('is handed back by both recovery constructors', () => {
    const server = readFileSync(join(SRC, 'web', 'server.ts'), 'utf-8');
    const reboot = readFileSync(join(SRC, 'web', 'routes', 'reboot-restore-routes.ts'), 'utf-8');
    expect(server).toMatch(/model:\s*savedState\?\.model,/);
    expect(reboot).toMatch(/model:\s*saved\.model,/);
  });
});
