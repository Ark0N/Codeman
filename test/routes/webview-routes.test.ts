/**
 * CRUD + capability behaviour for /api/webviews.
 *
 * Uses app.inject() (no port) against a temp CODEMAN_DATA_DIR, so nothing touches
 * the developer's real ~/.codeman/webviews.json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { registerWebviewRoutes } from '../../src/web/routes/webview-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { webviewCapabilities } from '../../src/webview-capabilities.js';
import { capabilityFromProxyPath } from '../../src/web/webview-proxy.js';
import { writeWebviews } from '../../src/webview-store.js';
import { readUsers } from '../../src/user-store.js';
import { TabLayoutService } from '../../src/tab-layout-service.js';
import type { TabLayout } from '../../src/tab-layout.js';

/**
 * The supervisor is the one process-spawning piece in this path. Its own tests
 * cover the launch-token exchange and the starter binding; here a stub stands in
 * for "this port has a cookie" so the route-level question stays what the proxy
 * actually puts on the upstream request.
 */
const { getDeepSeekWebCookie } = vi.hoisted(() => ({
  getDeepSeekWebCookie: vi.fn((_port: number, _owner?: string): string | null => null),
}));

vi.mock('../../src/deepseek-web-server.js', () => ({ getDeepSeekWebCookie }));

let app: FastifyInstance;
let tmpDir: string;
let savedDataDir: string | undefined;
let savedMultiUser: string | undefined;
/** Stands in for what the auth middleware decorates on the request. */
let currentUser: { username: string; role: 'admin' | 'user' } | undefined;
const broadcasts: Array<{ event: string; data: unknown }> = [];
const webviewCreated = vi.fn(async () => {});
const webviewDeleted = vi.fn(async () => {});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeman-webviews-'));
  savedDataDir = process.env.CODEMAN_DATA_DIR;
  savedMultiUser = process.env.CODEMAN_MULTIUSER;
  process.env.CODEMAN_DATA_DIR = tmpDir;
  delete process.env.CODEMAN_MULTIUSER;
  currentUser = undefined;
  broadcasts.length = 0;
  webviewCreated.mockClear();
  webviewDeleted.mockClear();
  getDeepSeekWebCookie.mockReset();
  getDeepSeekWebCookie.mockReturnValue(null);

  app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  // The proxy route declares a wsHandler, so the plugin must be present.
  await app.register(fastifyWebsocket);
  app.addHook('onRequest', async (req) => {
    if (currentUser) (req as unknown as { authUser: typeof currentUser }).authUser = currentUser;
  });
  registerWebviewRoutes(app, {
    broadcast: (event: string, data: unknown) => broadcasts.push({ event, data }),
    tabLayouts: { webviewCreated, webviewDeleted },
  } as never);
  installRouteErrorHandler(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = savedDataDir;
  if (savedMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
  else process.env.CODEMAN_MULTIUSER = savedMultiUser;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

const create = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/webviews', payload });

/** Wait for something a relayed connection reports asynchronously. */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('GET /api/webviews', () => {
  it('starts empty and reports the frame budget the client must honour', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/webviews' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.webviews).toEqual([]);
    expect(typeof body.data.maxLiveFrames).toBe('number');
  });
});

describe('POST /api/webviews', () => {
  it('creates a dashboard that defaults to proxied and sandboxed', async () => {
    const res = await create({ name: 'Grafana', url: 'http://127.0.0.1:4000/' });
    expect(res.statusCode).toBe(200);
    const w = res.json().data;
    // Proxy + untrusted are the safe defaults and must not drift.
    expect(w.embedMode).toBe('proxy');
    expect(w.trusted).toBe(false);
    expect(w.id).toBeTruthy();
  });

  it('broadcasts the change so other devices re-fetch', async () => {
    await create({ name: 'G', url: 'http://127.0.0.1:4000/' });
    expect(broadcasts.map((b) => b.event)).toContain('webview:changed');
  });

  it('persists across a fresh read of the store', async () => {
    await create({ name: 'G', url: 'http://127.0.0.1:4000/' });
    const list = (await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('G');
  });

  it('rejects URLs that are not plain http(s)', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      const res = await create({ name: 'bad', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().errorCode).toBe('INVALID_INPUT');
    }
  });

  it('rolls back webview persistence and emits nothing when layout capacity rejects insertion', async () => {
    const refs = Array.from({ length: 512 }, (_, index) => ({ kind: 'session' as const, id: `s-${index}` }));
    const original: TabLayout = {
      version: 9,
      groups: [],
      ungrouped: refs,
      updatedAt: '2026-08-16T00:00:00.000Z',
    };
    let stored = original;
    const live = new Map(refs.map((ref, index) => [ref.id, { id: ref.id, createdAt: index }]));
    const atomicBroadcast = vi.fn();
    const service = new TabLayoutService({
      store: {
        getTabLayout: () => stored,
        setTabLayout: (_owner, layout) => {
          stored = layout;
        },
        getSessions: () => ({}),
        getSessionOrder: () => [],
      } as never,
      sessions: live,
      readWebviews: async () =>
        (await import('../../src/webview-store.js')).readWebviews(tmpDir) as Promise<
          Array<{ id: string; owner?: string }>
        >,
      broadcast: atomicBroadcast,
      broadcastSessionOrder: vi.fn(),
    });
    const atomicApp = Fastify({ logger: false });
    await atomicApp.register(fastifyCookie);
    await atomicApp.register(fastifyWebsocket);
    registerWebviewRoutes(atomicApp, {
      broadcast: atomicBroadcast,
      tabLayouts: service,
    } as never);
    installRouteErrorHandler(atomicApp);
    await atomicApp.ready();

    const response = await atomicApp.inject({
      method: 'POST',
      url: '/api/webviews',
      payload: { name: 'overflow', url: 'https://example.test/' },
    });
    const list = (await atomicApp.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;

    expect(response.statusCode).toBe(500);
    expect(list).toEqual([]);
    expect(stored).toEqual(original);
    expect(atomicBroadcast).not.toHaveBeenCalled();
    await atomicApp.close();
  });

  it('rejects URLs carrying embedded credentials', async () => {
    const res = await create({ name: 'bad', url: 'http://user:pass@host:4000/' });
    expect(res.statusCode).toBe(400);
  });

  it('requires a name', async () => {
    expect((await create({ url: 'http://127.0.0.1:4000/' })).statusCode).toBe(400);
    expect((await create({ name: '   ', url: 'http://127.0.0.1:4000/' })).statusCode).toBe(400);
  });
});

describe('PATCH /api/webviews/:id', () => {
  it('updates fields and revokes the outstanding capability', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const opened = await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` });
    const cap = capabilityFromProxyPath(opened.json().data.embedUrl)!;
    expect(webviewCapabilities.resolve(cap)).toBeDefined();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/webviews/${id}`,
      payload: { url: 'http://127.0.0.1:4001/' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.url).toBe('http://127.0.0.1:4001/');
    // A token minted against the OLD url must not survive the repoint.
    expect(webviewCapabilities.resolve(cap)).toBeUndefined();
  });

  it('404s an unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/webviews/nope', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
  });

  it('still validates the URL on update', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/webviews/${id}`, payload: { url: 'file:///etc' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/webviews/:id', () => {
  it('removes it and revokes its capability', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const opened = await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` });
    const cap = capabilityFromProxyPath(opened.json().data.embedUrl)!;

    expect((await app.inject({ method: 'DELETE', url: `/api/webviews/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews).toEqual([]);
    expect(webviewCapabilities.resolve(cap)).toBeUndefined();
  });

  it('keeps the exact saved record and emits nothing when layout deletion fails', async () => {
    const created = (await create({ name: 'Keep me', url: 'https://keep.example/' })).json().data;
    broadcasts.length = 0;
    webviewDeleted.mockRejectedValueOnce(new Error('tab layout restoration failed'));

    const response = await app.inject({ method: 'DELETE', url: `/api/webviews/${created.id}` });
    const list = (await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;

    expect(response.statusCode).toBe(500);
    expect(list).toEqual([created]);
    expect(broadcasts).toEqual([]);
  });

  it('404s an unknown id', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/webviews/nope' })).statusCode).toBe(404);
  });
});

describe('POST /api/webviews/:id/open', () => {
  it('mints a same-origin embed path for a proxied dashboard', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const data = (await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` })).json().data;
    expect(data.embedUrl).toMatch(/^\/webview\/[A-Za-z0-9_-]{16,}\/$/);
    expect(capabilityFromProxyPath(data.embedUrl)).toBeTruthy();
  });

  it('returns no embed path in direct mode, where the iframe uses the real URL', async () => {
    const id = (await create({ name: 'G', url: 'https://ok.example/', embedMode: 'direct' })).json().data.id;
    const data = (await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` })).json().data;
    expect(data.embedUrl).toBeUndefined();
    expect(data.webview.url).toBe('https://ok.example/');
  });

  it('reuses the capability across repeated opens instead of leaking one per click', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    const first = (await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` })).json().data.embedUrl;
    const second = (await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` })).json().data.embedUrl;
    expect(second).toBe(first);
  });

  it('records lastOpenedAt', async () => {
    const id = (await create({ name: 'G', url: 'http://127.0.0.1:4000/' })).json().data.id;
    await app.inject({ method: 'POST', url: `/api/webviews/${id}/open` });
    const list = (await app.inject({ method: 'GET', url: '/api/webviews' })).json().data.webviews;
    expect(typeof list[0].lastOpenedAt).toBe('number');
  });

  it('404s an unknown id', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/webviews/nope/open' })).statusCode).toBe(404);
  });
});

describe('proxy route', () => {
  it('refuses an unknown or expired capability', async () => {
    const res = await app.inject({ method: 'GET', url: `/webview/${'Z'.repeat(32)}/` });
    expect(res.statusCode).toBe(403);
  });

  it('redirects the prefix without a trailing slash, so relative URLs resolve inside it', async () => {
    const cap = 'Y'.repeat(32);
    const res = await app.inject({ method: 'GET', url: `/webview/${cap}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/webview/${cap}/`);
  });
});

describe('managed DeepSeek web cookie', () => {
  const COOKIE = 'dsh-auth-test=v1.payload.sig';
  const upstreams: Array<{ port: number; cookies: Array<string | undefined>; close: () => Promise<void> }> = [];

  /** A real loopback listener, so the assertion is on the bytes dsh would receive. */
  async function startUpstream() {
    const cookies: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      cookies.push(req.headers.cookie);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('upstream has no address');
    const upstream = {
      port: address.port,
      cookies,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
    upstreams.push(upstream);
    return upstream;
  }

  /** The stub answers for one port and one owner, like the supervisor's two checks. */
  function mintCookieOn(port: number, owner: string | undefined): void {
    getDeepSeekWebCookie.mockImplementation((askedPort, askedOwner) =>
      askedPort === port && askedOwner === owner ? COOKIE : null
    );
  }

  async function openManaged(url: string): Promise<string> {
    const created = (await create({ name: 'DeepSeek Harness', url, managed: 'deepseek-web', trusted: true })).json()
      .data;
    const opened = (await app.inject({ method: 'POST', url: `/api/webviews/${created.id}/open` })).json().data;
    return capabilityFromProxyPath(opened.embedUrl)!;
  }

  const getThrough = (cap: string) => app.inject({ method: 'GET', url: `/webview/${cap}/` });

  async function writeUsersFixture(users: Array<{ username: string; role: string; canBypassPermissions: boolean }>) {
    await fs.writeFile(
      path.join(tmpDir, 'users.json'),
      JSON.stringify({
        version: 1,
        users: users.map((user) => ({
          ...user,
          password: { algo: 'scrypt', N: 1, r: 1, p: 1, salt: '00', hash: '00' },
          createdAt: 1,
        })),
      })
    );
    // The store keeps a short cache; write through it instead of waiting for the TTL.
    await readUsers(true);
  }

  afterEach(async () => {
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  });

  it('presents it to a managed tab on 127.0.0.1 at the minted port', async () => {
    const upstream = await startUpstream();
    mintCookieOn(upstream.port, undefined);

    const cap = await openManaged(`http://127.0.0.1:${upstream.port}/`);
    expect((await getThrough(cap)).statusCode).toBe(200);
    expect(upstream.cookies).toEqual([COOKIE]);
    expect(getDeepSeekWebCookie).toHaveBeenCalledWith(upstream.port, undefined);
  });

  it('presents nothing to a managed tab on another port', async () => {
    const minted = await startUpstream();
    const other = await startUpstream();
    mintCookieOn(minted.port, undefined);

    const cap = await openManaged(`http://127.0.0.1:${other.port}/`);
    expect((await getThrough(cap)).statusCode).toBe(200);
    expect(other.cookies).toEqual([undefined]);
  });

  it('presents nothing to an unmanaged tab on the same port', async () => {
    const upstream = await startUpstream();
    mintCookieOn(upstream.port, undefined);

    const created = (await create({ name: 'Not managed', url: `http://127.0.0.1:${upstream.port}/` })).json().data;
    const opened = (await app.inject({ method: 'POST', url: `/api/webviews/${created.id}/open` })).json().data;
    const cap = capabilityFromProxyPath(opened.embedUrl)!;

    expect((await getThrough(cap)).statusCode).toBe(200);
    expect(upstream.cookies).toEqual([undefined]);
    expect(getDeepSeekWebCookie).not.toHaveBeenCalled();
  });

  // `managed` comes from the client and the port is public, so this is the case
  // the gate exists for: a regular user must not receive the starter's cookie.
  it('presents nothing in multi-user mode when the owner has no privileged grant', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    currentUser = { username: 'bob', role: 'user' };
    await writeUsersFixture([{ username: 'bob', role: 'user', canBypassPermissions: false }]);
    const upstream = await startUpstream();
    mintCookieOn(upstream.port, 'bob');

    const cap = await openManaged(`http://127.0.0.1:${upstream.port}/`);
    expect((await getThrough(cap)).statusCode).toBe(200);
    expect(upstream.cookies).toEqual([undefined]);
    expect(getDeepSeekWebCookie).not.toHaveBeenCalled();
  });

  it('presents it in multi-user mode to a granted owner who started the server', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    currentUser = { username: 'carol', role: 'user' };
    await writeUsersFixture([{ username: 'carol', role: 'user', canBypassPermissions: true }]);
    const upstream = await startUpstream();
    mintCookieOn(upstream.port, 'carol');

    const cap = await openManaged(`http://127.0.0.1:${upstream.port}/`);
    expect((await getThrough(cap)).statusCode).toBe(200);
    expect(upstream.cookies).toEqual([COOKIE]);
    expect(getDeepSeekWebCookie).toHaveBeenCalledWith(upstream.port, 'carol');
  });

  /**
   * A loopback listener that completes the upgrade and records the cookie on the
   * handshake. The realtime leg is a separate code path from `proxyRequest`, so
   * the HTTP assertions above say nothing about what it puts on the wire.
   */
  async function startWebSocketUpstream() {
    const cookies: Array<string | undefined> = [];
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      cookies.push(req.headers.cookie);
      wss.handleUpgrade(req, socket, head, (client) => client.close());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('ws upstream has no address');
    const upstream = {
      port: address.port,
      cookies,
      close: () =>
        new Promise<void>((resolve) => {
          wss.close();
          server.close(() => resolve());
        }),
    };
    upstreams.push(upstream);
    return upstream;
  }

  it('presents it on the websocket leg too, ahead of the browser cookies', async () => {
    const upstream = await startWebSocketUpstream();
    mintCookieOn(upstream.port, undefined);
    const cap = await openManaged(`http://127.0.0.1:${upstream.port}/`);

    // Upgrades need a real listener: inject() cannot carry them.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/webview/${cap}/ws`, {
      headers: { cookie: 'codeman_session=SECRET; dsh-ui=dark' },
    });
    await once(client, 'open');
    await waitUntil(() => upstream.cookies.length > 0);

    // The credential leads so a stale browser copy cannot win, other dashboard
    // cookies survive, and Codeman's own session cookie never goes upstream.
    expect(upstream.cookies).toEqual([`${COOKIE}; dsh-ui=dark`]);
    client.close();
  });
});

describe('proxy HTML rewrite', () => {
  // The request path is what the page's relative URLs are relative to. Proving
  // it here (rather than only on rewriteHtml) pins that proxyRequest passes it.
  it("resolves the document's relative base against its own directory", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><base href="./"></head><body>app</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('upstream has no address');

    try {
      const created = (await create({ name: 'App', url: `http://127.0.0.1:${address.port}/app/page.html` })).json()
        .data;
      const opened = (await app.inject({ method: 'POST', url: `/api/webviews/${created.id}/open` })).json().data;
      const cap = capabilityFromProxyPath(opened.embedUrl)!;

      const res = await app.inject({ method: 'GET', url: `/webview/${cap}/app/page.html` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`<base href="/webview/${cap}/app/">`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('POST /api/webviews/probe', () => {
  it('reports an unreachable target as a normal answer, not a 500', async () => {
    // Port 1 is reserved and refuses instantly.
    const res = await app.inject({
      method: 'POST',
      url: '/api/webviews/probe',
      payload: { url: 'http://127.0.0.1:1/' },
    });
    expect(res.statusCode).toBe(200);
    const probe = res.json().data;
    expect(probe.reachable).toBe(false);
    expect(probe.recommendedMode).toBe('proxy');
  });

  it('rejects an invalid URL up front', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webviews/probe', payload: { url: 'file:///etc' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('egress policy: link-local and cloud-metadata targets', () => {
  it('refuses to SAVE a metadata address, in every spelling, with a message that says why', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://2852039166/', // decimal form of 169.254.169.254
      'http://[fd00:ec2::254]/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      const res = await create({ name: 'IMDS', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.body, url).toMatch(/Blocked URL/);
    }
  });

  it('still saves the loopback dashboards the feature exists for', async () => {
    expect((await create({ name: 'Grafana', url: 'http://127.0.0.1:4000/' })).statusCode).toBe(200);
    expect((await create({ name: 'Local', url: 'http://localhost:3080/' })).statusCode).toBe(200);
  });

  it('the probe refuses the same targets up front, before any connection is attempted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webviews/probe',
      payload: { url: 'http://169.254.169.254/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Blocked URL/);
  });

  it('the proxy refuses a record saved before the rule existed with a 403, never a relay', async () => {
    // Written straight to the store: the schema would refuse it today, which is
    // exactly why the proxy must judge the target again at connect time.
    await writeWebviews(tmpDir, [
      {
        id: 'legacy-imds',
        name: 'legacy',
        url: 'http://169.254.169.254/',
        embedMode: 'proxy',
        trusted: false,
        createdAt: Date.now(),
      },
    ]);
    const cap = webviewCapabilities.mint('legacy-imds', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await app.inject({ method: 'GET', url: `/webview/${cap}/latest/meta-data/` });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/link-local or cloud-metadata/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused by egress policy'));
    } finally {
      warn.mockRestore();
      webviewCapabilities.revokeWebview('legacy-imds');
    }
  });
});
