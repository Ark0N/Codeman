/**
 * The image watcher must never watch a REMOTE session's working directory.
 *
 * A remote-SSH session's `workingDir` is a path on the remote host. The watcher
 * (chokidar) watches it on the LOCAL disk: where nothing exists there it watches
 * a missing folder, and where a same-named local folder does exist it reports that
 * folder's images as the remote session's. Three places start a watch, and all
 * three skip a remote session:
 *  - `WebServer.setupSessionListeners()` (create, respawn, restore, recovery);
 *  - `POST /api/sessions/:id/image-watcher` (the per-session toggle), which refuses
 *    to turn it on, the way the Git fetch settings route refuses a remote session;
 *  - `PUT /api/settings` turning the app-wide watcher on, which re-watches every
 *    session that has it enabled.
 *
 * Spies on the real `imageWatcher` singleton, so all three modules see the spy.
 * Port: none (app.inject(), and a WebServer that is never started).
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeRmHomeTree } from './mocks/test-helpers.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

import { imageWatcher } from '../src/image-watcher.js';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { registerSystemRoutes } from '../src/web/routes/system-routes.js';

const WORKSPACE = join(homedir(), '.codeman-test-image-watcher-remote');
// A path on the remote host: nothing exists there locally.
const REMOTE_PATH = '/nonexistent-remote-host-path/homelab-infrastructure';
const REMOTE = {
  hostId: 'proxx',
  label: 'proxx',
  host: 'proxx.example.lan',
  username: 'user',
  remotePath: REMOTE_PATH,
  owned: true,
};

let watchSession: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  watchSession = vi.spyOn(imageWatcher, 'watchSession').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  imageWatcher.stop();
});

describe('setupSessionListeners()', () => {
  interface ServerInternals {
    registerSessionWithLayout(session: Session): Promise<void>;
    setupSessionListeners(session: Session): Promise<void>;
    discardPartiallyBuiltSession(sessionId: string): Promise<void>;
    isImageWatcherEnabled(): Promise<boolean>;
  }
  const SESSION_ID = 'a1b2c3d4e5f60718';
  let server: WebServer;
  let internals: ServerInternals;
  let mux: TmuxManager;

  beforeAll(() => {
    mkdirSync(WORKSPACE, { recursive: true });
    server = new WebServer(0, false, true);
    internals = server as unknown as ServerInternals;
    mux = new TmuxManager();
  });

  afterEach(async () => {
    await internals.discardPartiallyBuiltSession(SESSION_ID).catch(() => {});
  });

  afterAll(async () => {
    await server.stop().catch(() => {});
    safeRmHomeTree(WORKSPACE);
  });

  async function wire(remote: boolean) {
    const session = new Session({
      id: SESSION_ID,
      workingDir: remote ? REMOTE_PATH : WORKSPACE,
      mode: 'claude',
      name: remote ? 'remote session' : 'local session',
      mux,
      useMux: true,
      ...(remote ? { remote: REMOTE } : {}),
    });
    session.imageWatcherEnabled = true;
    vi.spyOn(internals, 'isImageWatcherEnabled').mockResolvedValue(true);
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
  }

  it('does not watch a remote session working directory', async () => {
    await wire(true);
    expect(watchSession).not.toHaveBeenCalled();
  });

  it('still watches a local session working directory', async () => {
    await wire(false);
    expect(watchSession).toHaveBeenCalledWith(SESSION_ID, WORKSPACE);
  });
});

describe('POST /api/sessions/:id/image-watcher', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const post = (enabled: boolean) =>
    harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/image-watcher`,
      payload: { enabled },
    });

  it('refuses to turn it on for a remote session, storing nothing', async () => {
    const session = harness.ctx._session as unknown as Record<string, unknown>;
    session.remote = REMOTE;
    session.workingDir = REMOTE_PATH;
    const res = await post(true);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(watchSession).not.toHaveBeenCalled();
    expect(session.imageWatcherEnabled).not.toBe(true);
    expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
  });

  it('still turns it off for a remote session', async () => {
    (harness.ctx._session as unknown as Record<string, unknown>).remote = REMOTE;
    const unwatchSession = vi.spyOn(imageWatcher, 'unwatchSession');
    const res = await post(false);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, data: { imageWatcherEnabled: false } });
    expect(unwatchSession).toHaveBeenCalledWith(harness.ctx._sessionId);
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();
  });

  it('still turns it on for a local session', async () => {
    const res = await post(true);
    expect(res.statusCode).toBe(200);
    expect(watchSession).toHaveBeenCalledWith(harness.ctx._sessionId, harness.ctx._session.workingDir);
  });
});

describe('PUT /api/settings turning the app-wide watcher on', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('re-watches the local sessions that have it enabled, never a remote one', async () => {
    const local = harness.ctx._session as unknown as Record<string, unknown>;
    local.imageWatcherEnabled = true;
    harness.ctx.sessions.set('remote-session', {
      ...harness.ctx._session,
      id: 'remote-session',
      workingDir: REMOTE_PATH,
      imageWatcherEnabled: true,
      remote: REMOTE,
    } as unknown as typeof harness.ctx._session);
    expect(imageWatcher.isRunning()).toBe(false);

    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { imageWatcherEnabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(imageWatcher.isRunning()).toBe(true);
    expect(watchSession).toHaveBeenCalledTimes(1);
    expect(watchSession).toHaveBeenCalledWith(harness.ctx._sessionId, harness.ctx._session.workingDir);
  });
});
