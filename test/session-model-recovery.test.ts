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

import { execFileSync } from 'node:child_process';
import { Session } from '../src/session.js';
import { TmuxManager, buildSpawnCommand } from '../src/tmux-manager.js';
import type { MuxSession, RespawnPaneOptions, TerminalMultiplexer } from '../src/mux-interface.js';
import type { EffortLevel } from '../src/types.js';

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

  it('is neither published nor persisted for a CLI that keeps its model in its own config', () => {
    // Cron hands the app-wide default (a Claude id) to every CLI that has a model at all.
    // codex never launches on the top-level field, so publishing it would report a model the
    // session never ran on, and recovery would carry that wrong value forward.
    for (const mode of ['codex', 'opencode', 'shell'] as const) {
      const session = new Session({ workingDir: '/tmp', mode, model: 'claude-fable-5-1' });
      sessions.push(session);
      expect(session.toState().model, mode).toBeUndefined();
    }
  });
});

/**
 * #514 (per-session `model` → `--model`) and #530 (`advisorModel` → the launch's ONE
 * `--settings` JSON) landed together and touch the same launch and recovery code. A claude
 * session carrying both, with or without ultracode (whose blob shares that `--settings`
 * object), must relaunch with both on every recovery path.
 */
describe('a launch model and an advisor survive recovery together', () => {
  const MODEL = 'claude-fable-5-1';
  const ADVISOR = 'opus';
  const sessions: Session[] = [];

  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.stop();
  });

  /** The settings JSON exactly as a shell would hand it to claude. */
  function settingsOf(cmd: string): unknown {
    expect(cmd.match(/--settings /g)).toHaveLength(1);
    const tail = cmd.slice(cmd.indexOf('--settings '));
    return JSON.parse(execFileSync('bash', ['-c', `set -- ${tail}; printf '%s' "$2"`]).toString());
  }

  /** Render what tmux-manager hands buildSpawnCommand for these options. */
  function launchLine(options: Pick<RespawnPaneOptions, 'sessionId' | 'model' | 'effort' | 'advisorModel'>): string {
    return buildSpawnCommand({
      mode: 'claude',
      sessionId: options.sessionId,
      model: options.model,
      effort: options.effort,
      advisorModel: options.advisorModel,
      claudeCliVersion: null,
    });
  }

  function expectBoth(cmd: string, effort: EffortLevel | undefined): void {
    expect(cmd).toContain(`--model "${MODEL}"`);
    expect(cmd).not.toContain('--advisor ');
    expect(settingsOf(cmd)).toEqual(
      effort === 'ultracode' ? { ultracode: true, advisorModel: ADVISOR } : { advisorModel: ADVISOR }
    );
    if (effort && effort !== 'ultracode') expect(cmd).toContain(`--effort '${effort}'`);
  }

  function persistedRecord(effort: EffortLevel | undefined) {
    const original = new Session({ workingDir: '/tmp', mode: 'claude', model: MODEL, advisorModel: ADVISOR, effort });
    sessions.push(original);
    const state = original.toState();
    expect(state.model).toBe(MODEL);
    expect(state.advisorModel).toBe(ADVISOR);
    return state;
  }

  it.each([['ultracode'], ['high'], [undefined]] as const)(
    'reboot restore (fresh pane) relaunches on both, effort %s',
    async (effort) => {
      const state = persistedRecord(effort);
      // The reboot-restore constructor: no muxSession, so startInteractive() creates a pane.
      const mux = new TmuxManager();
      const createSession = vi.spyOn(mux, 'createSession');
      const rebuilt = new Session({
        id: state.id,
        workingDir: '/tmp',
        mode: state.mode,
        mux,
        useMux: true,
        effort: state.effort,
        model: state.model,
        advisorModel: state.advisorModel,
      });
      sessions.push(rebuilt);
      await rebuilt.startInteractive();

      expect(createSession).toHaveBeenCalledTimes(1);
      const options = createSession.mock.calls[0][0];
      expect(options).toEqual(expect.objectContaining({ model: MODEL, advisorModel: ADVISOR, effort }));
      expectBoth(launchLine(options), effort);
    }
  );

  it.each([['ultracode'], ['high'], [undefined]] as const)(
    'restoreMuxSessions onto a dead pane respawns on both, effort %s',
    async (effort) => {
      const state = persistedRecord(effort);
      const respawns: RespawnPaneOptions[] = [];
      const mux = {
        isAvailable: () => true,
        muxSessionExists: () => true,
        isPaneDead: () => true,
        setAttached: () => {},
        respawnPane: async (options: RespawnPaneOptions) => {
          respawns.push(options);
          return 4242;
        },
      } as unknown as TerminalMultiplexer;
      // The restoreMuxSessions() constructor: an existing muxSession, whose pane is dead, so
      // startInteractive() takes the dead-pane respawn.
      const rebuilt = new Session({
        id: state.id,
        workingDir: '/tmp',
        mode: state.mode,
        mux,
        useMux: true,
        muxSession: { muxName: 'codeman-aaaa', sessionId: state.id } as unknown as MuxSession,
        effort: state.effort,
        model: state.model,
        advisorModel: state.advisorModel,
      });
      sessions.push(rebuilt);
      await rebuilt.startInteractive();

      expect(respawns).toHaveLength(1);
      expect(respawns[0]).toEqual(expect.objectContaining({ model: MODEL, advisorModel: ADVISOR, effort }));
      expectBoth(launchLine(respawns[0]), effort);
    }
  );

  it('both recovery constructors hand back model, advisorModel and effort', () => {
    const server = readFileSync(join(SRC, 'web', 'server.ts'), 'utf-8');
    const reboot = readFileSync(join(SRC, 'web', 'routes', 'reboot-restore-routes.ts'), 'utf-8');
    for (const field of ['effort', 'model', 'advisorModel']) {
      expect(server).toMatch(new RegExp(`\\b${field}:\\s*savedState\\?\\.${field},`));
      expect(reboot).toMatch(new RegExp(`\\b${field}:\\s*saved\\.${field},`));
    }
  });

  it('tmux-manager forwards model, effort and advisorModel to both launch builders', () => {
    // createSession() and respawnPane() each build the pane command. The tests above stop at
    // the options a Session hands them, so this pins the last hop to the builder.
    const tmux = readFileSync(join(SRC, 'tmux-manager.ts'), 'utf-8');
    const calls = [...tmux.matchAll(/buildSpawnCommand\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      for (const field of ['model', 'effort', 'advisorModel']) expect(call).toMatch(new RegExp(`\\b${field},`));
    }
  });
});
