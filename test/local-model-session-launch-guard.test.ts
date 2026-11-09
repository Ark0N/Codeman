/**
 * @fileoverview No coding agent is STARTED on the model Codeman runs on this Mac while that
 * model cannot be started on: the launch guard below the routes.
 *
 * The two routes that put a session onto a custom model endpoint ask the install service
 * before they write anything (test/routes/local-model-launch-guard.test.ts). That leaves
 * every other way a new agent process comes to be in a session that already carries the
 * selection: the attach that finds no pane, the respawn of a dead pane (a click on the tab, a
 * respawn start, the recovery at boot), a restart in place, and the rebuild after a reboot.
 * They all end in `Session`, so the guard sits there:
 *
 *  - `Session.setLaunchGuard()` is asked right before a NEW agent process is started (a fresh
 *    pane, the respawn of a dead one, `restartCli()`), and never for an attach to an agent
 *    that runs: a session whose runtime was stopped can still be looked at and closed.
 *  - `WebServer.setupSessionListeners()` sets it for every session, and it asks
 *    `LocalModelService.launchRefusalMessage()` with the session's own selection.
 *  - The reboot-restore route asks the same question before it builds anything, so the entry
 *    is refused with its own reason and stays on offer.
 *
 * The Session cases drive a real `Session` against the in-memory tmux layer vitest
 * substitutes. The wiring cases use the REAL install service over the real state file, with
 * no runtime running, which is exactly the state that must refuse.
 *
 * Port: N/A (WebServer in test mode binds none; the routes go through app.inject).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { dataPath } from '../src/config/instance.js';
import type { RebootRestoreEntry } from '../src/reboot-restore.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { httpStatusForErrorCode, type ApiErrorCode, type MuxSession, type SessionState } from '../src/types.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { registerRebootRestoreRoutes } from '../src/web/routes/reboot-restore-routes.js';
import { WebServer } from '../src/web/server.js';
import { createMockRouteContext, safeRmHomeTree } from './mocks/index.js';

const WORKSPACE = join(homedir(), 'codeman-cases', 'local-model-launch-guard');
const STATE = () => dataPath('local-model.json');
const NOT_RUNNING = 'The model on this Mac is not running. Start it first.';
const CHANGED = 'The model on this Mac changed since it was installed. Remove it and install it again.';
const SELECTION = { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b', envKeys: [] as string[] };

const sessions: Session[] = [];

function paneOf(mode: 'claude' | 'opencode' = 'claude'): MuxSession {
  return {
    sessionId: 'placeholder',
    muxName: 'codeman-cafe0002',
    pid: 1,
    createdAt: Date.now(),
    workingDir: WORKSPACE,
    mode,
    attached: false,
  };
}

/** A session that already has a pane, alive or dead as the test says. */
function sessionWithPane(dead: boolean) {
  mkdirSync(WORKSPACE, { recursive: true });
  const mux = new TmuxManager();
  const session = new Session({ workingDir: WORKSPACE, mode: 'claude', mux, useMux: true, muxSession: paneOf() });
  sessions.push(session);
  vi.spyOn(mux, 'muxSessionExists').mockReturnValue(true);
  vi.spyOn(mux, 'isPaneDead').mockReturnValue(dead);
  const respawn = vi.spyOn(mux, 'respawnPane').mockResolvedValue(4242);
  const create = vi.spyOn(mux, 'createSession');
  return { session, mux, respawn, create };
}

/** The state file of an installed model whose connection is the managed record. No runtime runs. */
function writeInstalledState(): void {
  writeFileSync(
    STATE(),
    JSON.stringify({
      schema: 1,
      state: 'installed',
      model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072, digest: 'abc123' },
      cli: { id: 'opencode', label: 'OpenCode' },
      runtime: { version: '0.40.15', port: 11435, enabled: true },
      connection: { endpointId: 'local-ollama', flagWasEnabled: false },
    })
  );
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.stop();
  rmSync(STATE(), { force: true });
  rebootRestoreRegistry.reset();
  vi.restoreAllMocks();
});

afterAll(() => {
  safeRmHomeTree(WORKSPACE);
});

describe('Session: the guard is asked before a new agent process, and only then', () => {
  it('a restart in place that is refused rejects with the sentence, and the pane keeps what runs in it', async () => {
    const { session, respawn } = sessionWithPane(false);
    const guard = vi.fn(async () => CHANGED);
    session.setLaunchGuard(guard);
    await expect(session.restartCli()).rejects.toThrow(CHANGED);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled();
  });

  it('a guard that has nothing to say lets the restart through', async () => {
    const { session, respawn } = sessionWithPane(false);
    session.setLaunchGuard(async () => undefined);
    expect(await session.restartCli()).toBe(true);
    expect(respawn).toHaveBeenCalledTimes(1);
  });

  it('without a guard nothing changes', async () => {
    const { session, respawn } = sessionWithPane(false);
    expect(await session.restartCli()).toBe(true);
    expect(respawn).toHaveBeenCalledTimes(1);
  });

  it('an attach to a pane whose agent runs is never asked: the session can still be looked at', async () => {
    const { session, respawn, create } = sessionWithPane(false);
    const guard = vi.fn(async () => NOT_RUNNING);
    session.setLaunchGuard(guard);
    await session.startInteractive();
    expect(guard).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('the respawn of a dead pane is asked first, and a refusal starts nothing', async () => {
    const { session, respawn, create } = sessionWithPane(true);
    const guard = vi.fn(async () => NOT_RUNNING);
    session.setLaunchGuard(guard);
    await expect(session.startInteractive()).rejects.toThrow(NOT_RUNNING);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled();
    // And no new pane is made in its place either.
    expect(create).not.toHaveBeenCalled();
  });

  it('a session without a pane is asked before one is created', async () => {
    mkdirSync(WORKSPACE, { recursive: true });
    const mux = new TmuxManager();
    const session = new Session({ workingDir: WORKSPACE, mode: 'claude', mux, useMux: true });
    sessions.push(session);
    const create = vi.spyOn(mux, 'createSession');
    session.setLaunchGuard(async () => NOT_RUNNING);
    await expect(session.startInteractive()).rejects.toThrow(NOT_RUNNING);
    expect(create).not.toHaveBeenCalled();

    // The guard taken away again: the pane is created.
    session.setLaunchGuard(null);
    create.mockResolvedValue(paneOf());
    await session.startInteractive();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('WebServer: every session asks the install service about its own selection', () => {
  interface ServerInternals {
    setupSessionListeners(session: Session): Promise<void>;
    discardPartiallyBuiltSession(sessionId: string): Promise<void>;
  }
  let server: WebServer;
  let internals: ServerInternals;

  beforeAll(() => {
    // Test mode: no port is opened and no CLI is launched.
    server = new WebServer(0, false, true);
    internals = server as unknown as ServerInternals;
  });

  afterAll(async () => {
    await server.stop().catch(() => {});
  });

  async function wired(selection?: typeof SELECTION) {
    const made = sessionWithPane(false);
    if (selection) made.session.setCustomModel(selection, {});
    await internals.setupSessionListeners(made.session);
    return made;
  }

  it('a session on the managed endpoint is not restarted while the runtime is down', async () => {
    writeInstalledState();
    const { session, respawn } = await wired(SELECTION);
    await expect(session.restartCli()).rejects.toThrow(NOT_RUNNING);
    expect(respawn).not.toHaveBeenCalled();
    await internals.discardPartiallyBuiltSession(session.id).catch(() => {});
  });

  it('nor is its dead pane respawned, which is what a click on the tab and the boot recovery do', async () => {
    writeInstalledState();
    const { session, mux, respawn } = await wired(SELECTION);
    vi.spyOn(mux, 'isPaneDead').mockReturnValue(true);
    await expect(session.startInteractive()).rejects.toThrow(NOT_RUNNING);
    expect(respawn).not.toHaveBeenCalled();
    await internals.discardPartiallyBuiltSession(session.id).catch(() => {});
  });

  it('only the model that was installed may be started on it', async () => {
    writeInstalledState();
    const { session } = await wired({ ...SELECTION, modelId: 'something-pulled-by-hand' });
    await expect(session.restartCli()).rejects.toThrow(/Only Qwen3\.6 35B-A3B is installed on this Mac|not running/);
    await internals.discardPartiallyBuiltSession(session.id).catch(() => {});
  });

  it('a session on another endpoint, and one without a selection, start as before', async () => {
    writeInstalledState();
    const other = await wired({ ...SELECTION, endpointId: 'office-gpu' });
    expect(await other.session.restartCli()).toBe(true);
    await internals.discardPartiallyBuiltSession(other.session.id).catch(() => {});
    const plain = await wired();
    expect(await plain.session.restartCli()).toBe(true);
    await internals.discardPartiallyBuiltSession(plain.session.id).catch(() => {});
  });

  it('a selection made AFTER the listeners were wired is asked about too', async () => {
    writeInstalledState();
    const { session, respawn } = await wired();
    session.setCustomModel(SELECTION, {});
    await expect(session.restartCli()).rejects.toThrow(NOT_RUNNING);
    expect(respawn).not.toHaveBeenCalled();
    await internals.discardPartiallyBuiltSession(session.id).catch(() => {});
  });
});

describe('POST /api/reboot-restore/restore: a session that ran on the managed endpoint', () => {
  async function harness(ctx: ReturnType<typeof createMockRouteContext>): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerRebootRestoreRoutes(app, ctx as never);
    app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
      if (payload === null || typeof payload !== 'object') return done(null, payload);
      const p = payload as { success?: unknown; errorCode?: unknown };
      if (p.success === false) {
        if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
          reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
        }
        return done(null, payload);
      }
      if (p.success === true) return done(null, payload);
      return done(null, { success: true, data: payload });
    });
    installRouteErrorHandler(app);
    await app.ready();
    return app;
  }

  /** An entry whose workspace exists, so only the model question can stop it. */
  function entryOn(endpointId: string): RebootRestoreEntry {
    mkdirSync(WORKSPACE, { recursive: true });
    return {
      sessionId: 'feedbeef00000001',
      name: 'w1-app',
      workingDir: WORKSPACE,
      mode: 'claude',
      resumeConversationId: 'conv-1',
      state: {
        id: 'feedbeef00000001',
        pid: null,
        status: 'idle',
        workingDir: WORKSPACE,
        currentTaskId: null,
        createdAt: 1_760_000_000_000,
        mode: 'claude',
        __customModel: { endpointId, modelId: 'qwen3.6:35b-a3b', envKeys: [] },
      } as unknown as SessionState,
    };
  }

  it('is not rebuilt while the model cannot be started on, says why, and stays on offer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeInstalledState();
    rebootRestoreRegistry.set([entryOn('local-ollama')]);
    const ctx = createMockRouteContext();
    const app = await harness(ctx);
    const body = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(body.restored).toEqual([]);
    expect(body.skipped).toEqual([{ sessionId: 'feedbeef00000001', reason: 'local-model-not-ready' }]);
    // Nothing was built: no session was added, so there is nothing to discard.
    expect(ctx.addSession).not.toHaveBeenCalled();
    // The model can be started and the click repeated.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['feedbeef00000001']);
    await app.close();
  });
});
