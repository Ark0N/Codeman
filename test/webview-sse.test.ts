/**
 * @fileoverview Owner routing of the `webview:changed` SSE event.
 *
 * Saved web tabs are owner-scoped in multi-user mode (`canAccessOwned` on every
 * CRUD route), but their invalidation event used to carry no owner and fell
 * through `deriveSseHint`'s global branch, so every connected user learned the
 * ids of every other user's web-tab creates, edits and deletes. The event now
 * carries the resource owner and routes to that owner plus admins; single-user
 * mode (no SSE identity) still delivers it to every client.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleanupManager } from '../src/utils/index.js';
import type { AuthUser } from '../src/types.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { registerWebviewRoutes } from '../src/web/routes/webview-routes.js';
import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';
import { SseStreamManager, type SseRoutingHint } from '../src/web/sse-stream-manager.js';
import { deriveWebviewSseHint } from '../src/web/webview-sse.js';

function client() {
  const writes: string[] = [];
  return {
    writes,
    reply: { raw: { write: (chunk: string) => (writes.push(chunk), true) } } as unknown as FastifyReply,
  };
}

/** The server's real event → routing-hint derivation, without starting the server. */
function serverHint(event: string, data: unknown): SseRoutingHint | undefined {
  const server = new WebServer(3999, false, true) as unknown as {
    deriveSseHint(event: string, data: unknown): SseRoutingHint | undefined;
  };
  return server.deriveSseHint(event, data);
}

describe('deriveWebviewSseHint', () => {
  it('routes to the exact owner and fails closed when the owner is missing', () => {
    expect(deriveWebviewSseHint({ action: 'updated', id: 'w1', owner: 'alice' })).toEqual({
      username: 'alice',
      sessionScoped: true,
    });
    expect(deriveWebviewSseHint({ action: 'updated', id: 'w1' })).toEqual({
      username: undefined,
      sessionScoped: true,
    });
  });

  it('is what the server derives for the webview: family (never the global branch)', () => {
    const payload = { action: 'created', id: 'w1', owner: 'alice' };
    expect(serverHint(SseEvent.WebviewChanged, payload)).toEqual({ username: 'alice', sessionScoped: true });
    expect(serverHint(SseEvent.WebviewChanged, { action: 'deleted', id: 'w1' })).not.toBeUndefined();
  });
});

describe('webview:changed delivery', () => {
  it('reaches the owner and admins, never another ordinary user', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const alice = client();
    const bob = client();
    const admin = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });
    const payload = { action: 'deleted', id: 'w1', owner: 'alice' };

    manager.broadcast(SseEvent.WebviewChanged, payload, serverHint(SseEvent.WebviewChanged, payload));

    expect(alice.writes).toEqual(['event: webview:changed\ndata: {"action":"deleted","id":"w1","owner":"alice"}\n\n']);
    expect(admin.writes).toEqual(alice.writes);
    expect(bob.writes).toEqual([]);
    cleanup.dispose();
  });

  it('single-user mode: clients without an identity all still receive it', () => {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const tabA = client();
    const tabB = client();
    manager.addClient(tabA.reply, null, false, undefined, undefined);
    manager.addClient(tabB.reply, null, false, undefined, undefined);
    const payload = { action: 'created', id: 'w1', owner: '@single' };

    manager.broadcast(SseEvent.WebviewChanged, payload, serverHint(SseEvent.WebviewChanged, payload));

    expect(tabA.writes).toHaveLength(1);
    expect(tabB.writes).toEqual(tabA.writes);
    cleanup.dispose();
  });
});

describe('webview routes → SSE, end to end', () => {
  let tmpDir: string;
  let savedDataDir: string | undefined;
  let savedMode: string | undefined;
  let cleanup: CleanupManager;
  let manager: SseStreamManager;
  const apps: FastifyInstance[] = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeman-webview-sse-'));
    savedDataDir = process.env.CODEMAN_DATA_DIR;
    savedMode = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_DATA_DIR = tmpDir;
    cleanup = new CleanupManager();
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    cleanup.dispose();
    if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = savedDataDir;
    if (savedMode === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMode;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /** A route app acting as `authUser`, whose broadcasts go through the server's routing. */
  async function appAs(authUser: AuthUser | undefined): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await app.register(fastifyWebsocket);
    app.decorateRequest('authUser', undefined);
    app.addHook('onRequest', async (req) => {
      req.authUser = authUser;
    });
    registerWebviewRoutes(app, {
      broadcast: (event: string, data: unknown) => manager.broadcast(event, data, serverHint(event, data)),
      tabLayouts: { webviewCreated: async () => {}, webviewDeleted: async () => {} },
    } as never);
    installRouteErrorHandler(app);
    await app.ready();
    apps.push(app);
    return app;
  }

  it("multi-user: another user's SSE stream never sees a web-tab create, edit or delete", async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const aliceApp = await appAs({ username: 'alice', role: 'user' });
    const alice = client();
    const bob = client();
    const admin = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });
    manager.addClient(admin.reply, null, false, undefined, { username: 'root', role: 'admin' });

    const created = await aliceApp.inject({
      method: 'POST',
      url: '/api/webviews',
      payload: { name: 'Grafana', url: 'http://127.0.0.1:4000/' },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as string;
    const patched = await aliceApp.inject({ method: 'PATCH', url: `/api/webviews/${id}`, payload: { name: 'G2' } });
    expect(patched.statusCode).toBe(200);
    expect((await aliceApp.inject({ method: 'DELETE', url: `/api/webviews/${id}` })).statusCode).toBe(200);

    const expected = ['created', 'updated', 'deleted'].map(
      (action) => `event: webview:changed\ndata: ${JSON.stringify({ action, id, owner: 'alice' })}\n\n`
    );
    expect(alice.writes).toEqual(expected);
    expect(admin.writes).toEqual(expected);
    expect(bob.writes).toEqual([]);
  });

  it("multi-user: an admin editing a user's web tab notifies that user, not a bystander", async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const aliceApp = await appAs({ username: 'alice', role: 'user' });
    const adminApp = await appAs({ username: 'root', role: 'admin' });
    const id = (
      await aliceApp.inject({
        method: 'POST',
        url: '/api/webviews',
        payload: { name: 'G', url: 'http://127.0.0.1:4000/' },
      })
    ).json().data.id as string;
    const alice = client();
    const bob = client();
    manager.addClient(alice.reply, null, false, undefined, { username: 'alice', role: 'user' });
    manager.addClient(bob.reply, null, false, undefined, { username: 'bob', role: 'user' });

    expect((await adminApp.inject({ method: 'DELETE', url: `/api/webviews/${id}` })).statusCode).toBe(200);

    expect(alice.writes).toEqual([
      `event: webview:changed\ndata: ${JSON.stringify({ action: 'deleted', id, owner: 'alice' })}\n\n`,
    ]);
    expect(bob.writes).toEqual([]);
  });

  it('single-user: every client still receives the event', async () => {
    const soloApp = await appAs(undefined);
    const tabA = client();
    const tabB = client();
    manager.addClient(tabA.reply, null, false, undefined, undefined);
    manager.addClient(tabB.reply, null, false, undefined, undefined);

    const created = await soloApp.inject({
      method: 'POST',
      url: '/api/webviews',
      payload: { name: 'G', url: 'http://127.0.0.1:4000/' },
    });
    expect(created.statusCode).toBe(200);

    expect(tabA.writes).toEqual([
      `event: webview:changed\ndata: ${JSON.stringify({ action: 'created', id: created.json().data.id, owner: '@single' })}\n\n`,
    ]);
    expect(tabB.writes).toEqual(tabA.writes);
  });
});
