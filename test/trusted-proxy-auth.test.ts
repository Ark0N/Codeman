/**
 * @fileoverview Trusted reverse-proxy identity (multi-user mode): an authenticating
 * proxy on the same host forwards `X-Codeman-Proxy-Secret` + `X-Codeman-User`, and
 * Codeman signs the request in as that account. See src/config/trusted-proxy.ts.
 *
 * Live servers on ephemeral ports. Real fetches arrive from loopback; inject's
 * `remoteAddress` stands in for other sources. The secret is read once per process and
 * then removed from the environment, so tests that change it call `useSecret()`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { createUser, invalidateUsersCache, touchLastLogin, updateUser } from '../src/user-store.js';
import { AUTH_FAILURE_MAX } from '../src/config/auth-config.js';
import {
  getTrustedProxyConfig,
  initTrustedProxySecret,
  resetTrustedProxySecretForTests,
  takeTrustedProxyHeaders,
  trustedProxyConfigError,
  trustedProxySecretFilePath,
} from '../src/config/trusted-proxy.js';
import { capabilityPrefixOf, registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerWsRoutes } from '../src/web/routes/ws-routes.js';
import { buildUpstreamRequestHeaders } from '../src/web/webview-proxy.js';
import { createMockRouteContext } from './mocks/index.js';
import { getLifecycleLog } from '../src/session-lifecycle-log.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

// touchLastLogin is fire-and-forget in the auth hook; wrapped so its calls can be counted.
vi.mock('../src/user-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/user-store.js')>();
  return { ...actual, touchLastLogin: vi.fn(actual.touchLastLogin) };
});

/** Wait for every last-login write started so far, so none races a test that edits users.json. */
async function settleLastLoginWrites(): Promise<void> {
  await Promise.all(vi.mocked(touchLastLogin).mock.results.map((r) => r.value));
}

const SECRET = 'a'.repeat(24) + 'b'.repeat(24); // 48 chars

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function cookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  const m = raw?.match(/codeman_session=([^;]+)/);
  return m ? `codeman_session=${m[1]}` : null;
}

/**
 * Configure the secret the next server will read: the inline env var, the file variant,
 * or none. Resets the once-per-process cache (in production the value is read once).
 */
function useSecret(opts: { inline?: string; file?: string } = {}): void {
  delete process.env.CODEMAN_TRUSTED_PROXY_SECRET;
  delete process.env.CODEMAN_TRUSTED_PROXY_SECRET_FILE;
  if (opts.inline !== undefined) process.env.CODEMAN_TRUSTED_PROXY_SECRET = opts.inline;
  if (opts.file !== undefined) process.env.CODEMAN_TRUSTED_PROXY_SECRET_FILE = opts.file;
  resetTrustedProxySecretForTests();
}

const ENV_KEYS = [
  'CODEMAN_DATA_DIR',
  'CODEMAN_USER_SPACES_DIR',
  'CODEMAN_MULTIUSER',
  'CODEMAN_PASSWORD',
  'CODEMAN_USERNAME',
  'CODEMAN_TRUSTED_PROXY_SECRET',
  'CODEMAN_TRUSTED_PROXY_SECRET_FILE',
  'CODEMAN_TRUSTED_PROXY_USER_HEADER',
] as const;

let server: WebServer;
const extraServers: WebServer[] = [];
let dataDir: string;
let spacesDir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-auth-data-'));
  spacesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-auth-spaces-'));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CODEMAN_DATA_DIR = dataDir;
  process.env.CODEMAN_USER_SPACES_DIR = spacesDir;
  process.env.CODEMAN_MULTIUSER = '1';
  delete process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER;
  delete process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_USERNAME;
  useSecret({ inline: SECRET });
  invalidateUsersCache();

  await createUser({ username: 'alice', role: 'admin', password: 'alicepass1' });
  await createUser({ username: 'bob', role: 'user', password: 'bobpass123' });
  await createUser({ username: 'carol', role: 'user', password: 'carolpass1' });
  await updateUser('carol', { disabled: true });
  await createUser({ username: 'dave', role: 'user', password: 'davepass12', mustChangePassword: true });
  await createUser({ username: 'erin', role: 'user', password: 'erinpass12' });
  await createUser({ username: 'frank', role: 'user', password: 'frankpass1' });

  server = new WebServer(0, false, true);
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  for (const s of extraServers) await s.stop().catch(() => {});
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetTrustedProxySecretForTests();
  invalidateUsersCache();
  // stop() queues a lifecycle-log append; let it land before the data dir goes.
  await (getLifecycleLog() as unknown as { writeQueue: Promise<void> }).writeQueue;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(spacesDir, { recursive: true, force: true }).catch(() => {});
});

const url = (p: string) => `http://localhost:${server.boundPort}${p}`;

function proxied(user: string | null, secret: string | null = SECRET, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (secret !== null) headers['X-Codeman-Proxy-Secret'] = secret;
  if (user !== null) headers['X-Codeman-User'] = user;
  return headers;
}

async function me(headers: Record<string, string>): Promise<Response> {
  return fetch(url('/api/me'), { headers });
}

/** A fresh server (empty failure buckets) with the current env and secret. */
async function freshServer(): Promise<WebServer> {
  const s = new WebServer(0, false, true);
  await s.start();
  extraServers.push(s);
  return s;
}

function appOf(s: WebServer): FastifyInstance {
  return (s as unknown as { app: FastifyInstance }).app;
}

/** inject() a GET /api/me from a chosen source address. */
function injectMe(app: FastifyInstance, remoteAddress: string, headers: Record<string, string | string[]>) {
  return app.inject({ method: 'GET', url: '/api/me', remoteAddress, headers: { host: 'localhost', ...headers } });
}

describe('trusted-proxy config', () => {
  afterAll(() => useSecret({ inline: SECRET }));

  it('is off in single-user mode, without a secret, or with a short / non-ASCII secret', () => {
    useSecret({ inline: SECRET });
    expect(getTrustedProxyConfig(false)).toBeNull();
    expect(trustedProxyConfigError(false)).toMatch(/multi-user mode is off/);
    expect(trustedProxyConfigError(true)).toBeNull();
    useSecret();
    expect(getTrustedProxyConfig(true)).toBeNull();
    expect(trustedProxyConfigError(true)).toBeNull();
    expect(trustedProxyConfigError(false)).toBeNull();
    useSecret({ inline: 'short' });
    expect(getTrustedProxyConfig(true)).toBeNull();
    expect(trustedProxyConfigError(true)).toMatch(/shorter than 32/);
    useSecret({ inline: 'ü'.repeat(40) });
    expect(getTrustedProxyConfig(true)).toBeNull();
    expect(trustedProxyConfigError(true)).toMatch(/printable ASCII/);
  });

  it('removes the inline secret from the environment once read, so sessions do not inherit it', () => {
    useSecret({ inline: SECRET });
    expect(getTrustedProxyConfig(true)?.secret).toBe(SECRET);
    expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET).toBeUndefined();
    // ...and the cached value keeps working.
    expect(getTrustedProxyConfig(true)?.secret).toBe(SECRET);
  });

  it('reads the secret from CODEMAN_TRUSTED_PROXY_SECRET_FILE', async () => {
    const file = path.join(dataDir, 'proxy-secret');
    await fs.writeFile(file, `${SECRET}\n`, { mode: 0o600 });
    useSecret({ file });
    expect(getTrustedProxyConfig(true)?.secret).toBe(SECRET);
    expect(trustedProxyConfigError(true)).toBeNull();
    useSecret({ file: path.join(dataDir, 'missing') });
    expect(getTrustedProxyConfig(true)).toBeNull();
    expect(trustedProxyConfigError(true)).toMatch(/cannot read CODEMAN_TRUSTED_PROXY_SECRET_FILE/);
    useSecret({ inline: SECRET, file });
    expect(getTrustedProxyConfig(true)).toBeNull();
    expect(trustedProxyConfigError(true)).toMatch(/set only one/);
  });

  it.skipIf(process.platform === 'win32')('refuses a secret file readable by group or others', async () => {
    const file = path.join(dataDir, 'proxy-secret-mode');
    await fs.writeFile(file, SECRET, { mode: 0o600 });
    try {
      for (const mode of [0o640, 0o604, 0o644]) {
        await fs.chmod(file, mode);
        useSecret({ file });
        expect(getTrustedProxyConfig(true), mode.toString(8)).toBeNull();
        expect(trustedProxyConfigError(true), mode.toString(8)).toMatch(/readable by other users; chmod 600/);
      }
      await fs.chmod(file, 0o400);
      useSecret({ file });
      expect(getTrustedProxyConfig(true)?.secret).toBe(SECRET);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it('removes both variables from the environment once read, and keeps the file path for the blocklist', async () => {
    const file = path.join(dataDir, 'proxy-secret-env');
    await fs.writeFile(file, SECRET, { mode: 0o600 });
    try {
      useSecret({ file });
      // Before the read, the path comes from the environment.
      expect(trustedProxySecretFilePath()).toBe(file);
      initTrustedProxySecret();
      expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET_FILE).toBeUndefined();
      expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET).toBeUndefined();
      expect(trustedProxySecretFilePath()).toBe(file);
      expect(getTrustedProxyConfig(true)?.secret).toBe(SECRET);
      // Both set (refused): both are still removed.
      useSecret({ inline: SECRET, file });
      initTrustedProxySecret();
      expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET).toBeUndefined();
      expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET_FILE).toBeUndefined();
      // A relative path is kept resolved.
      useSecret({ file: path.relative(process.cwd(), file) });
      initTrustedProxySecret();
      expect(trustedProxySecretFilePath()).toBe(file);
      useSecret();
      initTrustedProxySecret();
      expect(trustedProxySecretFilePath()).toBeNull();
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it('defaults the user header, honours an override, and refuses unusable header names', () => {
    useSecret({ inline: SECRET });
    expect(getTrustedProxyConfig(true)).toEqual({ secret: SECRET, userHeader: 'x-codeman-user' });
    try {
      process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = 'X-Forwarded-User';
      expect(getTrustedProxyConfig(true)?.userHeader).toBe('x-forwarded-user');
      for (const bad of [
        'Authorization',
        'cookie',
        'Content-Type',
        'Origin',
        'Upgrade',
        'Sec-WebSocket-Key',
        'X-Forwarded-For',
        'X-Real-IP',
        'X-Requested-With',
        'X-HTTP-Method-Override',
        'X-CSRF-Token',
        'X-XSRF-Token',
        'x-codeman-proxy-secret',
        'X-Codeman-Hook-Secret',
        'not a header',
      ]) {
        process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = bad;
        expect(getTrustedProxyConfig(true)).toBeNull();
        expect(trustedProxyConfigError(true)).toMatch(/CODEMAN_TRUSTED_PROXY_USER_HEADER/);
      }
      // Refused even without a secret or multi-user mode: the setting itself is unusable.
      useSecret();
      process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = 'Authorization';
      expect(trustedProxyConfigError(false)).toMatch(/CODEMAN_TRUSTED_PROXY_USER_HEADER/);
      useSecret({ inline: SECRET });
      for (const ok of ['X-Forwarded-User', 'Remote-User', 'X-Auth-Request-User', 'X-Remote-User']) {
        process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = ok;
        expect(getTrustedProxyConfig(true)?.userHeader).toBe(ok.toLowerCase());
        expect(trustedProxyConfigError(true)).toBeNull();
      }
    } finally {
      delete process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER;
    }
  });
});

describe('takeTrustedProxyHeaders', () => {
  it('reads and deletes the secret and username headers', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'x-codeman-proxy-secret': SECRET,
      'x-codeman-user': '  Bob ',
      accept: '*/*',
    };
    // The username is returned as sent: the auth hook applies the user store's rule.
    expect(takeTrustedProxyHeaders(headers)).toEqual({ secretPresent: true, secret: SECRET, user: '  Bob ' });
    expect(headers).toEqual({ accept: '*/*' });
  });

  it('marks an empty secret header as present and joins duplicates so they never match', () => {
    expect(takeTrustedProxyHeaders({ 'x-codeman-proxy-secret': '' })).toMatchObject({ secretPresent: true });
    expect(takeTrustedProxyHeaders({ 'x-codeman-proxy-secret': [SECRET, SECRET] }).secret).toBe(`${SECRET}, ${SECRET}`);
    expect(takeTrustedProxyHeaders({ 'x-codeman-user': ['alice', 'bob'] }).user).toBe('alice, bob');
    expect(takeTrustedProxyHeaders({ accept: '*/*' })).toEqual({ secretPresent: false, secret: '', user: '' });
  });
});

describe('capabilityPrefixOf judges a path the way a proxy matcher does', () => {
  it.each([
    ['/webview/x', '', 'webview'],
    ['/webview/', '', 'webview'],
    ['/webview/x?q=1', '', 'webview'],
    [`/webview/${'a'.repeat(200)}/y`, '', 'webview'],
    ['/webview/bad*token!/z', '', 'webview'],
    ['/WEBVIEW/x', '', 'webview'],
    ['/%77ebview/x', '', 'webview'],
    ['//webview/x', '', 'webview'],
    ['/a/../webview/x', '', 'webview'],
    ['/html-view/x', '', 'html-view'],
    ['/HTML-View/a/b', '', 'html-view'],
    ['/html-view%2Fx', '', 'html-view'],
    ['/WEBV%C4%B0EW/x', '', 'webview'], // U+0130 İ: Caddy's matcher folds it to "i"
    ['/HTML-V%C4%B0EW/a', '', 'html-view'],
    ['/webv%C4%B1ew/x', '', null], // U+0131 dotless ı: folded to "i" by neither side
    ['/webview', '', null],
    ['/webviewfoo', '', null],
    ['/webviewfoo/x', '', null],
    ['/html-view', '', null],
    ['/html-viewer/x', '', null],
    ['/', '', null],
    ['/api/me', '', null],
    ['/api/webviews', '', null],
    ['/x/webview/y', '', null],
    ['/webview/../api/me', '', null],
    // Under a base path: the server strips only the literal prefix, so every other
    // spelling of it still reaches the hook in front of the capability prefix.
    ['/webview/x', '/codeman', 'webview'], // literal prefix, already stripped
    ['/CODEMAN/webview/x', '/codeman', 'webview'],
    ['/%63odeman/webview/x', '/codeman', 'webview'],
    ['//codeman/webview/x', '/codeman', 'webview'],
    ['/x/../codeman/webview/x', '/codeman', 'webview'],
    ['/CODEMAN/html-view/x', '/codeman', 'html-view'],
    ['/codeman/webview/x', '/CodeMan', 'webview'],
    ['/codemanx/webview/x', '/codeman', null],
    ['/other/webview/x', '/codeman', null],
    ['/codeman', '/codeman', null],
    ['/CODEMAN/webview/x', '', null], // root mount: no prefix to remove
    // A mount named like a capability prefix: the server has already stripped the literal
    // mount, so what arrives must also be judged as it is.
    ['/webview/x', '/webview', 'webview'], // from /webview/webview/x
    ['/html-view/x', '/html-view', 'html-view'], // from /html-view/html-view/x
    ['/webview/nested/x', '/webview/nested', 'webview'], // from /webview/nested/webview/nested/x
    ['/WEBVIEW/webview/x', '/webview', 'webview'],
    ['/api/me', '/webview', null],
  ] as const)('%s under "%s" -> %s', (url, basePath, expected) => {
    expect(capabilityPrefixOf(url, basePath)).toBe(expected);
  });
});

describe('the web-tab relay never forwards the trusted-proxy headers', () => {
  it('drops them in buildUpstreamRequestHeaders, trusted or not', () => {
    for (const forwardCookies of [false, true]) {
      const headers = buildUpstreamRequestHeaders(
        { 'x-codeman-proxy-secret': SECRET, 'x-codeman-user': 'alice', accept: '*/*' },
        new URL('http://127.0.0.1:4000/panel'),
        { forwardCookies, sessionCookieName: 'codeman_session' }
      );
      expect(headers['x-codeman-proxy-secret']).toBeUndefined();
      expect(headers['x-codeman-user']).toBeUndefined();
      expect(headers.accept).toBe('*/*');
    }
  });

  it('drops a custom username header too, and only the configured one', () => {
    const incoming = { 'x-auth-request-user': 'alice', 'x-codeman-user': 'alice', 'x-other': 'keep' };
    const build = () =>
      buildUpstreamRequestHeaders(incoming, new URL('http://127.0.0.1:4000/panel'), {
        forwardCookies: true,
        sessionCookieName: 'codeman_session',
      });
    try {
      process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = 'X-Auth-Request-User';
      const headers = build();
      expect(headers['x-auth-request-user']).toBeUndefined();
      expect(headers['x-codeman-user']).toBeUndefined();
      expect(headers['x-other']).toBe('keep');
      // A rejected name is never used, so the header it names is not dropped.
      process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = 'Accept';
      expect(
        buildUpstreamRequestHeaders({ accept: '*/*' }, new URL('http://127.0.0.1:4000/'), {
          forwardCookies: false,
          sessionCookieName: 'codeman_session',
        }).accept
      ).toBe('*/*');
    } finally {
      delete process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER;
    }
    // Not configured: an ordinary header of that name is relayed.
    expect(build()['x-auth-request-user']).toBe('alice');
  });
});

describe('the auth middleware strips the headers before any route sees them', () => {
  /** A bare app with the real auth middleware and a route that echoes what it received. */
  async function echoApp(): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(fastifyCookie);
    registerAuthMiddleware(app, false);
    app.get('/echo', async (req) => ({ headers: req.headers, user: req.authUser?.username ?? null }));
    app.post('/echo', async (req) => ({ headers: req.headers, body: req.body }));
    await app.ready();
    return app;
  }

  it('in multi-user mode, for a signed-in proxy request', async () => {
    useSecret({ inline: SECRET });
    const app = await echoApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/echo',
        remoteAddress: '127.0.0.1',
        headers: proxied('bob'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user).toBe('bob');
      expect(body.headers['x-codeman-proxy-secret']).toBeUndefined();
      expect(body.headers['x-codeman-user']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('strips a custom username header as well', async () => {
    useSecret({ inline: SECRET });
    process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = 'X-Forwarded-User';
    const app = await echoApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/echo',
        remoteAddress: '127.0.0.1',
        headers: { 'x-codeman-proxy-secret': SECRET, 'x-forwarded-user': 'bob', 'x-codeman-user': 'alice' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toBe('bob');
      expect(res.json().headers['x-forwarded-user']).toBeUndefined();
      // The default header is removed too, though it is no longer read.
      expect(res.json().headers['x-codeman-user']).toBeUndefined();
    } finally {
      delete process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER;
      await app.close();
    }
  });

  it('never strips a header named by a rejected CODEMAN_TRUSTED_PROXY_USER_HEADER', async () => {
    const prev = process.env.CODEMAN_MULTIUSER;
    delete process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = 'Content-Type';
    useSecret();
    const app = await echoApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/echo', payload: { a: 1 } });
      expect(res.statusCode).toBe(200);
      expect(res.json().body).toEqual({ a: 1 });
      expect(res.json().headers['content-type']).toMatch(/application\/json/);
    } finally {
      process.env.CODEMAN_MULTIUSER = prev;
      delete process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER;
      await app.close();
      useSecret({ inline: SECRET });
    }
  });

  it('in single-user mode without a password (no auth at all)', async () => {
    const prev = process.env.CODEMAN_MULTIUSER;
    delete process.env.CODEMAN_MULTIUSER;
    useSecret({ inline: SECRET });
    const app = await echoApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/echo',
        remoteAddress: '127.0.0.1',
        headers: proxied('bob'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().headers['x-codeman-proxy-secret']).toBeUndefined();
      expect(res.json().headers['x-codeman-user']).toBeUndefined();
      expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET).toBeUndefined();
    } finally {
      process.env.CODEMAN_MULTIUSER = prev;
      await app.close();
      useSecret({ inline: SECRET });
    }
  });
});

describe('trusted-proxy sign-in', () => {
  it('signs a loopback request with the secret in as the named account, without a cookie', async () => {
    const res = await me(proxied('bob'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ username: 'bob', role: 'user', viaTrustedProxy: true });
    expect(cookieFrom(res)).toBeNull();
  });

  it('removes the inline secret from the process environment when the server starts', async () => {
    useSecret({ inline: SECRET });
    expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET).toBe(SECRET);
    const app = appOf(await freshServer());
    expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET).toBeUndefined();
    expect((await injectMe(app, '127.0.0.1', proxied('bob'))).statusCode).toBe(200);
  });

  it('normalizes the username case and keeps the account role', async () => {
    const res = await me(proxied('  ALICE '));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ username: 'alice', role: 'admin' });
  });

  it('ignores a username header that comes without the secret (normal auth applies)', async () => {
    const res = await me(proxied('alice', null));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Basic/);
  });

  it('refuses a wrong secret outright, even alongside valid Basic credentials', async () => {
    const res = await me(proxied('alice', 'x'.repeat(48), { Authorization: basic('bob', 'bobpass123') }));
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/proxy secret rejected/);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('refuses an EMPTY secret header instead of falling back to a cookie or Basic', async () => {
    const login = await me({ Authorization: basic('bob', 'bobpass123') });
    const cookie = cookieFrom(login)!;
    for (const extra of [{ Cookie: cookie }, { Authorization: basic('bob', 'bobpass123') }]) {
      const res = await me(proxied('alice', '', extra));
      expect(res.status).toBe(401);
      expect(await res.text()).toMatch(/proxy secret rejected/);
    }
  });

  it('refuses a duplicated secret header', async () => {
    const s = await freshServer();
    const res = await injectMe(appOf(s), '127.0.0.1', {
      'x-codeman-proxy-secret': [SECRET, SECRET],
      'x-codeman-user': 'bob',
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatch(/proxy secret rejected/);
  });

  it('refuses a correct secret with no username with 403 and no challenge', async () => {
    for (const user of [null, '', '   ']) {
      const res = await me(proxied(user));
      expect(res.status, JSON.stringify(user)).toBe(403);
      expect(await res.text()).toMatch(/no username/);
      expect(res.headers.get('www-authenticate')).toBeNull();
    }
  });

  it('matches the username exactly by the user store rule: no trimming at @, no replacement', async () => {
    for (const user of ['bob@example.com', 'bob.smith', 'b ob', 'bob\\x', 'DOMAIN\\bob', 'b']) {
      const res = await me(proxied(user));
      expect(res.status, user).toBe(403);
      expect(await res.text()).toMatch(/no enabled Codeman account/);
      expect(res.headers.get('www-authenticate')).toBeNull();
    }
  });

  it('refuses a name the store rule rejects even when users.json holds it (hand-edited)', async () => {
    const file = path.join(dataDir, 'users.json');
    const original = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(original) as { users: Array<{ username: string }> };
    const bob = parsed.users.find((u) => u.username === 'bob')!;
    parsed.users.push({ ...bob, username: 'bob.smith' });
    await fs.writeFile(file, JSON.stringify(parsed), { mode: 0o600 });
    invalidateUsersCache();
    try {
      const res = await me(proxied('bob.smith'));
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/no enabled Codeman account/);
    } finally {
      await fs.writeFile(file, original, { mode: 0o600 });
      invalidateUsersCache();
    }
  });

  it('refuses a username header sent twice, even when both names exist', async () => {
    // Two real header lines over a socket: Node joins them into "alice, bob".
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.boundPort,
          path: '/api/me',
          headers: { host: 'localhost', 'x-codeman-proxy-secret': SECRET, 'x-codeman-user': ['alice', 'bob'] },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(body).toMatch(/no enabled Codeman account/);
  });

  it('refuses unknown and disabled accounts with 403 (no auto-provisioning)', async () => {
    const unknown = await me(proxied('mallory'));
    expect(unknown.status).toBe(403);
    expect(await unknown.text()).toMatch(/no enabled Codeman account/);
    expect((await me(proxied('carol'))).status).toBe(403);
  });

  it('refuses an account disabled between two requests', async () => {
    expect((await me(proxied('frank'))).status).toBe(200);
    await updateUser('frank', { disabled: true });
    invalidateUsersCache();
    expect((await me(proxied('frank'))).status).toBe(403);
  });

  it('records the last login on a proxy sign-in at most every 15 minutes per user', async () => {
    const app = appOf(await freshServer());
    const calls = () => vi.mocked(touchLastLogin).mock.calls.filter(([u]) => u === 'erin').length;
    const before = calls();
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      for (const [minutes, expected] of [
        [0, 1],
        [14, 1],
        [15, 2],
      ] as const) {
        nowSpy.mockReturnValue(realNow + minutes * 60_000);
        expect((await injectMe(app, '127.0.0.1', proxied('erin'))).statusCode).toBe(200);
        expect(calls(), `after ${minutes} min`).toBe(before + expected);
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('answers 503 when the user store is unreadable, without falling back to a cookie or Basic', async () => {
    const app = appOf(await freshServer());
    const login = await injectMe(app, '127.0.0.1', { authorization: basic('bob', 'bobpass123') });
    const token = /codeman_session=([^;]+)/.exec(String(login.headers['set-cookie']))![1];
    await settleLastLoginWrites();
    const usersFile = path.join(dataDir, 'users.json');
    const original = await fs.readFile(usersFile, 'utf-8');
    try {
      await fs.writeFile(usersFile, '{ not json');
      invalidateUsersCache();
      const withCredentials: Record<string, string>[] = [
        { cookie: `codeman_session=${token}` },
        { authorization: basic('bob', 'bobpass123') },
      ];
      for (const extra of withCredentials) {
        const res = await injectMe(app, '127.0.0.1', proxied('alice', SECRET, extra));
        expect(res.statusCode, Object.keys(extra)[0]).toBe(503);
        expect(res.body).toMatch(/user store unreadable/);
      }
    } finally {
      await fs.writeFile(usersFile, original);
      invalidateUsersCache();
    }
  });

  it('does not apply the mustChangePassword lockbox to a proxy sign-in', async () => {
    const res = await fetch(url('/api/sessions'), { headers: proxied('dave') });
    expect(res.status).toBe(200);
    // /api/me must not tell the browser to force a password change it never used.
    const meProxy = (await (await me(proxied('dave'))).json()).data;
    expect(meProxy).toMatchObject({ username: 'dave', mustChangePassword: false, viaTrustedProxy: true });
    const meBasic = (await (await me({ Authorization: basic('dave', 'davepass12') })).json()).data;
    expect(meBasic).toMatchObject({ username: 'dave', mustChangePassword: true, viaTrustedProxy: false });
    // ...while the same account over Basic is still locked into changing its password.
    const viaBasic = await fetch(url('/api/sessions'), { headers: { Authorization: basic('dave', 'davepass12') } });
    expect(viaBasic.status).toBe(403);
  });

  it('ignores and does not refresh a live cookie under a proxy identity', async () => {
    const s = await freshServer();
    const app = appOf(s);
    const login = await injectMe(app, '127.0.0.1', { authorization: basic('alice', 'alicepass1') });
    expect(login.statusCode).toBe(200);
    const token = /codeman_session=([^;]+)/.exec(String(login.headers['set-cookie']))![1];
    const sessions = (s as unknown as { authSessions: { getRemainingTtl(k: string): number | undefined } })
      .authSessions;
    const realNow = Date.now();
    const ttlAtLogin = sessions.getRemainingTtl(token)!;
    // A minute later, a proxy request for bob carries alice's cookie.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
    try {
      const res = await injectMe(app, '127.0.0.1', proxied('bob', SECRET, { cookie: `codeman_session=${token}` }));
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ username: 'bob', viaTrustedProxy: true });
      expect(res.headers['set-cookie']).toBeUndefined();
      // Alice's session was not touched: its remaining lifetime shrank by the minute.
      expect(sessions.getRemainingTtl(token)!).toBeLessThanOrEqual(ttlAtLogin - 60_000 + 1000);
    } finally {
      nowSpy.mockRestore();
    }
    // ...and the cookie itself is still alice's, alive.
    const again = await injectMe(app, '127.0.0.1', { cookie: `codeman_session=${token}` });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.username).toBe('alice');
  });

  it('takes precedence over an existing cookie from another account', async () => {
    const login = await me({ Authorization: basic('bob', 'bobpass123') });
    const cookie = cookieFrom(login);
    expect(cookie).toBeTruthy();
    const res = await me(proxied('alice', SECRET, { Cookie: cookie! }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.username).toBe('alice');
  });

  it('does not open the hook endpoint: it still needs the hook secret', async () => {
    const res = await fetch(url('/api/hook-event'), {
      method: 'POST',
      headers: { ...proxied('alice'), 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'stop', sessionId: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/hook secret required/);
  });

  it('authenticates a terminal WebSocket upgrade through the full server', async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.boundPort}/ws/sessions/nonexistent/terminal`, {
        headers: proxied('bob'),
      });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS did not close within timeout'));
      }, 8000);
      ws.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      ws.on('error', () => {
        /* the close handler resolves */
      });
    });
    // 4004 = the upgrade passed auth and reached the session lookup. Refusals are covered
    // through inject() above; this file drives only accepted upgrades over a real socket.
    expect(code).toBe(4004);
  });

  it('leaves Basic and cookie sign-in working for requests without the secret', async () => {
    const login = await me({ Authorization: basic('bob', 'bobpass123') });
    expect(login.status).toBe(200);
    const again = await me({ Cookie: cookieFrom(login)! });
    expect(again.status).toBe(200);
  });

  it('accepts IPv6 and IPv4-mapped loopback, refuses any other source', async () => {
    const app = appOf(await freshServer());
    for (const ip of ['::1', '::ffff:127.0.0.1']) {
      expect((await injectMe(app, ip, proxied('bob'))).statusCode).toBe(200);
    }
    for (const ip of ['10.1.2.3', '127.0.0.2']) {
      const res = await injectMe(app, ip, proxied('alice'));
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatch(/proxy secret rejected/);
      expect(res.headers['www-authenticate']).toBeUndefined();
    }
  });

  it('throttles wrong secrets per IP but never refuses the correct one, and leaves Basic usable', async () => {
    const app = appOf(await freshServer());
    const wrong = proxied('alice', 'y'.repeat(48));
    for (let i = 0; i < AUTH_FAILURE_MAX; i++) {
      expect((await injectMe(app, '127.0.0.1', wrong)).statusCode).toBe(401);
    }
    expect((await injectMe(app, '127.0.0.1', wrong)).statusCode).toBe(429);
    // Local junk requests share 127.0.0.1 with the proxy: they must not lock sign-in out.
    const ok = await injectMe(app, '127.0.0.1', proxied('alice'));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.username).toBe('alice');
    // ...and the Basic path from the same IP is untouched.
    expect((await injectMe(app, '127.0.0.1', { authorization: basic('bob', 'bobpass123') })).statusCode).toBe(200);
  });

  it('refuses any path without a live capability under the capability prefixes, with no password check, prompt or failure count', async () => {
    const app = appOf(await freshServer());
    const webviewPaths = [
      `/webview/${'Z'.repeat(32)}/x`, // well-formed, unknown
      '/webview/x', // malformed token (too short)
      '/webview/',
      `/webview/${'a'.repeat(200)}/y`, // overlong token
      '/webview/bad*token!/z', // invalid characters
      '/WEBVIEW/x', // re-spelled the way a proxy's matcher still forwards it
      '/%77ebview/x',
      '/WEBV%C4%B0EW/x',
      '/webview/x?q=1',
    ];
    const htmlPaths = [`/html-view/${'A'.repeat(24)}/index.html`, '/html-view/x'];
    // Negative case, sent once before the loop so its single count doesn't blur the result:
    // a lookalike prefix is NOT a capability path and keeps the ordinary challenge.
    const lookalike = await app.inject({
      method: 'GET',
      url: '/webviewfoo',
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost' },
    });
    expect(lookalike.statusCode).toBe(401);
    expect(lookalike.headers['www-authenticate']).toMatch(/Basic/);

    const all = [...webviewPaths.map((u) => [u, 403] as const), ...htmlPaths.map((u) => [u, 404] as const)];
    for (let i = 0; i < 60; i++) {
      const [url, status] = all[i % all.length];
      // Alternate wrong Basic credentials (not even checked) and no credentials at all,
      // which is what arrives through the documented Caddy route.
      const headers: Record<string, string> = { host: 'localhost' };
      if (i % 2) headers.authorization = basic('bob', 'wrong-password');
      const res = await app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1', headers });
      expect(res.statusCode, url).toBe(status);
      expect(res.headers['www-authenticate'], url).toBeUndefined();
    }
    // 60 such requests did not fill the per-IP bucket: Basic from loopback still works.
    expect((await injectMe(app, '127.0.0.1', { authorization: basic('bob', 'bobpass123') })).statusCode).toBe(200);
  });

  it('honours a custom user header and no longer reads the default one', async () => {
    process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = 'X-Forwarded-User';
    try {
      const app = appOf(await freshServer());
      const ok = await injectMe(app, '127.0.0.1', { 'x-codeman-proxy-secret': SECRET, 'x-forwarded-user': 'bob' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data.username).toBe('bob');
      const old = await injectMe(app, '127.0.0.1', proxied('bob'));
      expect(old.statusCode).toBe(403);
      expect(old.body).toMatch(/no username/);
    } finally {
      delete process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER;
    }
  });
});

describe('terminal WebSocket through a proxy sign-in is owner-scoped', () => {
  let app: FastifyInstance;
  let port = 0;

  beforeAll(async () => {
    useSecret({ inline: SECRET });
    app = Fastify();
    await app.register(fastifyCookie);
    registerAuthMiddleware(app, false);
    await app.register(fastifyWebsocket);
    const ctx = createMockRouteContext({ sessionId: 'bobs-session' });
    (ctx.sessions.get('bobs-session') as unknown as { owner?: string }).owner = 'bob';
    registerWsRoutes(app, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Open the terminal WebSocket for bob's session as `user`. */
  function open(user: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/bobs-session/terminal`, { headers: proxied(user) });
  }

  /** Resolves with the close code; never decided by a timer racing the server. */
  function closeCode(ws: WebSocket): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS did not close within timeout'));
      }, 5000);
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.on('error', () => {
        /* the close handler resolves */
      });
    });
  }

  /** True when the socket opened and the SERVER did not close it within `ms`. */
  function staysOpen(ws: WebSocket, ms = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      let closedByServer = false;
      ws.on('close', () => {
        closedByServer = true;
      });
      ws.on('error', () => {
        /* reported through close */
      });
      ws.on('open', () => {
        setTimeout(() => {
          resolve(!closedByServer);
          ws.close();
        }, ms);
      });
    });
  }

  /** Accepted upgrades only, like the full-server WebSocket test above. */
  it('lets the owner and an admin attach, and closes it for another user with 4003', async () => {
    expect(await staysOpen(open('bob'))).toBe(true);
    expect(await staysOpen(open('alice'))).toBe(true);
    expect(await closeCode(open('erin'))).toBe(4003);
  });
});

describe('under a base path, every spelling of the mount prefix is refused like the literal one', () => {
  /** GET with the path sent exactly as written (fetch would normalise it). */
  function rawGet(port: number, rawPath: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; challenge: string | undefined }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: rawPath, headers: { host: `localhost:${port}`, ...headers } },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, challenge: res.headers['www-authenticate'] as string | undefined })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('answers each with the route refusal, no challenge and no count, so Basic still signs in', async () => {
    useSecret({ inline: SECRET });
    const s = new WebServer(0, false, true, '127.0.0.1', undefined, false, '/codeman');
    await s.start();
    extraServers.push(s);
    const port = s.boundPort;
    const cases = [
      ['/CODEMAN/webview/x', 403],
      ['/%63odeman/webview/x', 403],
      ['//codeman/webview/x', 403],
      ['/x/../codeman/webview/x', 403],
      ['/CODEMAN/html-view/x', 404],
    ] as const;
    for (let i = 0; i < 60; i++) {
      const [rawPath, status] = cases[i % cases.length];
      const res = await rawGet(port, rawPath);
      expect(res.status, rawPath).toBe(status);
      expect(res.challenge, rawPath).toBeUndefined();
    }
    const ok = await rawGet(port, '/codeman/api/me', { authorization: basic('bob', 'bobpass123') });
    expect(ok.status).toBe(200);
  });

  it('keeps the capability prefix on a mount named like it', async () => {
    useSecret({ inline: SECRET });
    const s = new WebServer(0, false, true, '127.0.0.1', undefined, false, '/webview');
    await s.start();
    extraServers.push(s);
    const port = s.boundPort;
    // The server strips the literal mount, so this arrives as /webview/x.
    for (let i = 0; i < 60; i++) {
      const res = await rawGet(port, '/webview/webview/x');
      expect(res.status).toBe(403);
      expect(res.challenge).toBeUndefined();
    }
    const ok = await rawGet(port, '/webview/api/me', { authorization: basic('bob', 'bobpass123') });
    expect(ok.status).toBe(200);
  });
});

describe('trusted-proxy sign-in is off without its preconditions', () => {
  it('keeps the normal challenge for capability paths', async () => {
    useSecret();
    try {
      const app = appOf(await freshServer());
      for (const url of ['/webview/x', `/html-view/${'A'.repeat(24)}/index.html`]) {
        const res = await app.inject({
          method: 'GET',
          url,
          remoteAddress: '127.0.0.1',
          headers: { host: 'localhost' },
        });
        expect(res.statusCode, url).toBe(401);
        expect(res.headers['www-authenticate'], url).toMatch(/Basic/);
      }
    } finally {
      useSecret({ inline: SECRET });
    }
  });

  it('ignores the headers when no secret is configured', async () => {
    useSecret();
    try {
      const res = await injectMe(appOf(await freshServer()), '127.0.0.1', proxied('alice'));
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/Basic/);
    } finally {
      useSecret({ inline: SECRET });
    }
  });
});

describe('a configured setup that cannot be used stops the start', () => {
  afterAll(() => useSecret({ inline: SECRET }));

  /** start() a new server with the current env; resolves with the refusal message, or null. */
  async function startError(): Promise<string | null> {
    const s = new WebServer(0, false, true);
    try {
      await s.start();
      extraServers.push(s);
      return null;
    } catch (err) {
      await s.stop().catch(() => {});
      return (err as Error).message;
    }
  }

  /** Assert the refusal, that it names the reason, and that it never carries the secret. */
  async function expectRefusal(reason: RegExp): Promise<void> {
    const message = await startError();
    expect(message).toMatch(/^Trusted-proxy sign-in is misconfigured: /);
    expect(message).toMatch(reason);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('short-secret');
  }

  it('starts with a valid setup', async () => {
    useSecret({ inline: SECRET });
    expect(await startError()).toBeNull();
  });

  it('refuses both secret variables at once', async () => {
    const file = path.join(dataDir, 'refuse-both');
    await fs.writeFile(file, SECRET, { mode: 0o600 });
    useSecret({ inline: SECRET, file });
    await expectRefusal(/set only one/);
    await fs.rm(file, { force: true });
  });

  it('refuses an unreadable or empty secret file', async () => {
    useSecret({ file: path.join(dataDir, 'no-such-secret') });
    await expectRefusal(/cannot read CODEMAN_TRUSTED_PROXY_SECRET_FILE .*ENOENT/);
    const empty = path.join(dataDir, 'empty-secret');
    await fs.writeFile(empty, '  \n', { mode: 0o600 });
    useSecret({ file: empty });
    await expectRefusal(/is empty/);
    await fs.rm(empty, { force: true });
  });

  it.skipIf(process.platform === 'win32')('refuses a secret file readable by group or others', async () => {
    const file = path.join(dataDir, 'refuse-mode');
    await fs.writeFile(file, SECRET, { mode: 0o640 });
    await fs.chmod(file, 0o640);
    useSecret({ file });
    await expectRefusal(/readable by other users; chmod 600/);
    await fs.rm(file, { force: true });
  });

  it('refuses a short or non-ASCII secret', async () => {
    useSecret({ inline: 'short-secret' });
    await expectRefusal(/shorter than 32/);
    useSecret({ inline: `${SECRET} ${SECRET}` });
    await expectRefusal(/printable ASCII/);
  });

  it('refuses a secret with multi-user mode off', async () => {
    const prevMulti = process.env.CODEMAN_MULTIUSER;
    delete process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_PASSWORD = 'singlepass1';
    try {
      useSecret({ inline: SECRET });
      await expectRefusal(/multi-user mode is off/);
      // Read and removed even so: nothing is left for a later spawn to inherit.
      expect(process.env.CODEMAN_TRUSTED_PROXY_SECRET).toBeUndefined();
    } finally {
      process.env.CODEMAN_MULTIUSER = prevMulti;
      delete process.env.CODEMAN_PASSWORD;
    }
  });

  it('refuses a username header name the validation rejects', async () => {
    useSecret({ inline: SECRET });
    process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER = 'Authorization';
    try {
      await expectRefusal(/CODEMAN_TRUSTED_PROXY_USER_HEADER/);
    } finally {
      delete process.env.CODEMAN_TRUSTED_PROXY_USER_HEADER;
    }
  });
});
