/**
 * @fileoverview /api/discord: the bot token is a bearer secret, so it is never returned and the
 * settings routes are admin only in multi-user mode. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { _resetNotifyBuckets, registerDiscordRoutes } from '../../src/web/routes/discord-routes.js';
import { DiscordBridge, discordConfigPath, readDiscordConfig, type DiscordFetch } from '../../src/discord-bridge.js';

const TOKEN = 'MTA1.secret.token-value-1234567890';
const FULL = {
  enabled: true,
  token: TOKEN,
  guildId: '111111111111111111',
  parentChannelId: '222222222222222222',
  allowedUserIds: ['333333333333333333'],
};

let dir: string;
let fetchImpl: ReturnType<typeof vi.fn<DiscordFetch>>;

async function harness(authUser?: { username: string; role: 'admin' | 'user' }) {
  const bridge = new DiscordBridge({
    configDir: dir,
    fetchImpl,
    sendInput: async () => true,
    socketFactory: () => ({ send() {}, close() {}, on() {} }),
  });
  const h = await createRouteTestHarness(
    (app, ctx) => registerDiscordRoutes(app, { bridge, configDir: dir, ctx, hostTitle: () => 'codeman:test' }),
    authUser ? { authUser } : undefined
  );
  return { ...h, bridge };
}

beforeEach(() => {
  _resetNotifyBuckets();
  dir = mkdtempSync(join(tmpdir(), 'discord-routes-'));
  fetchImpl = vi.fn<DiscordFetch>(
    async () => new Response(JSON.stringify({ id: '444444444444444444' }), { status: 200 })
  );
});
afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/discord', () => {
  it('starts disabled with no token', async () => {
    const { app } = await harness();
    const data = (await app.inject({ method: 'GET', url: '/api/discord' })).json().data;
    expect(data).toMatchObject({ enabled: false, hasToken: false, tokenMasked: '', gateway: 'off' });
    expect(data).not.toHaveProperty('token');
  });

  it('saves, masks the token in every response and writes the file 0600', async () => {
    const { app, bridge } = await harness();
    const put = await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('secret');
    expect(put.json().data).toMatchObject({ enabled: true, hasToken: true });
    const get = await app.inject({ method: 'GET', url: '/api/discord' });
    expect(get.body).not.toContain('secret');
    expect(statSync(discordConfigPath(dir)).mode & 0o777).toBe(0o600);
    expect((await readDiscordConfig(dir)).token).toBe(TOKEN);
    bridge.stop();
  });

  it('keeps the token when only an option changes, and clears it on an empty string', async () => {
    const { app, bridge } = await harness();
    await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    await app.inject({ method: 'PUT', url: '/api/discord', payload: { pingMode: 'all', onSessionDelete: 'delete' } });
    const cfg = await readDiscordConfig(dir);
    expect(cfg).toMatchObject({ token: TOKEN, pingMode: 'all', onSessionDelete: 'delete' });
    const cleared = await app.inject({ method: 'PUT', url: '/api/discord', payload: { enabled: false, token: '' } });
    expect(cleared.json().data.hasToken).toBe(false);
    bridge.stop();
  });

  it('stores startupHint (default on) and typedHint (default off) and returns them', async () => {
    const { app, bridge } = await harness();
    const first = (await app.inject({ method: 'GET', url: '/api/discord' })).json().data;
    expect(first).toMatchObject({ startupHint: true, typedHint: false });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/discord',
      payload: { typedHint: true, startupHint: false },
    });
    expect(put.json().data).toMatchObject({ startupHint: false, typedHint: true });
    bridge.stop();
  });

  it('refuses a bad id, an incomplete enable, and unknown fields', async () => {
    const { app } = await harness();
    const bad = await app.inject({ method: 'PUT', url: '/api/discord', payload: { guildId: 'not-a-number' } });
    expect(bad.statusCode).toBe(400);
    const incomplete = await app.inject({ method: 'PUT', url: '/api/discord', payload: { enabled: true } });
    expect(incomplete.statusCode).toBe(400);
    const extra = await app.inject({ method: 'PUT', url: '/api/discord', payload: { nope: 1 } });
    expect(extra.statusCode).toBe(400);
  });

  it('POST /test needs a saved token, then posts to the parent channel', async () => {
    const { app, bridge } = await harness();
    expect((await app.inject({ method: 'POST', url: '/api/discord/test' })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    const res = await app.inject({ method: 'POST', url: '/api/discord/test' });
    expect(res.json().data.ok).toBe(true);
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toContain('/channels/222222222222222222/messages');
    bridge.stop();
  });

  it('is admin only in multi-user mode', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await harness({ username: 'bob', role: 'user' });
    expect((await app.inject({ method: 'GET', url: '/api/discord' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/discord/test' })).statusCode).toBe(403);
  });
});

describe('POST /api/sessions/:id/discord-notify', () => {
  const url = '/api/sessions/test-session-1/discord-notify';
  it('is refused while the bridge is off, and posts into the session thread once on', async () => {
    const { app, bridge } = await harness();
    const url = `/api/sessions/test-session-1/discord-notify`;
    const off = await app.inject({ method: 'POST', url, payload: { message: 'press reset' } });
    expect(off.statusCode).toBe(409);
    await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    const on = await app.inject({ method: 'POST', url, payload: { message: 'press reset', urgent: true } });
    expect(on.json().data.ok).toBe(true);
    const sent = fetchImpl.mock.calls.map((c) => String(c[1].body));
    expect(sent.some((b) => b.includes('press reset') && b.includes('<@333333333333333333>'))).toBe(true);
    bridge.stop();
  });

  it('accepts a unique 8-character session id prefix (Docker exports it cut), not an ambiguous or short one', async () => {
    const { app, bridge, ctx } = await harness();
    await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-ses/discord-notify',
      payload: { message: 'hi' },
    });
    expect(ok.statusCode).toBe(200);
    ctx.sessions.set('test-session-2', ctx.sessions.get('test-session-1')!);
    const ambiguous = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-ses/discord-notify',
      payload: { message: 'hi' },
    });
    expect(ambiguous.statusCode).toBe(404);
    const short = await app.inject({
      method: 'POST',
      url: '/api/sessions/test/discord-notify',
      payload: { message: 'hi' },
    });
    expect(short.statusCode).toBe(404);
    bridge.stop();
  });

  it('lets two different deliberate messages from one tab through within 3 s (neither is lost)', async () => {
    const { app, bridge } = await harness();
    await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    const first = await app.inject({ method: 'POST', url, payload: { message: 'first thing' } });
    const second = await app.inject({ method: 'POST', url, payload: { message: 'second thing' } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.deduped).toBeUndefined();
    const sent = fetchImpl.mock.calls.map((c) => String(c[1].body));
    expect(sent.filter((b) => b.includes('first thing') || b.includes('second thing'))).toHaveLength(2);
    bridge.stop();
  });

  it('answers 200 with data.ok false when Discord refuses the post, which the CLI turns into exit 1', async () => {
    const { app, bridge } = await harness();
    await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ code: 0 }), { status: 401 }));
    const res = await app.inject({ method: 'POST', url, payload: { message: 'help' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ ok: false, status: 401 });
    bridge.stop();
  });

  it('answers 429 RATE_LIMITED once a tab posts more than its share in a minute', async () => {
    const { app, bridge } = await harness();
    await app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push(
        (await app.inject({ method: 'POST', url, payload: { message: `ping ${i}`, urgent: true } })).statusCode
      );
    }
    expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(codes.slice(6)).toEqual([429, 429]);
    const limited = await app.inject({ method: 'POST', url, payload: { message: 'again' } });
    expect(limited.json().errorCode).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('60');
    bridge.stop();
  });

  it('rejects an empty or oversized message', async () => {
    const { app } = await harness();
    const url = `/api/sessions/test-session-1/discord-notify`;
    expect((await app.inject({ method: 'POST', url, payload: { message: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, payload: { message: 'x'.repeat(2000) } })).statusCode).toBe(400);
  });
});

describe('discord-notify with a file', () => {
  let work: string;
  let outside: string;
  const url = '/api/sessions/test-session-1/discord-notify';

  async function ready() {
    const h = await harness();
    (h.ctx.sessions.get('test-session-1') as unknown as { workingDir: string }).workingDir = work;
    await h.app.inject({ method: 'PUT', url: '/api/discord', payload: FULL });
    return h;
  }
  const post = (app: Awaited<ReturnType<typeof harness>>['app'], file: string) =>
    app.inject({ method: 'POST', url, payload: { message: 'log attached', file } });

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'discord-work-'));
    outside = mkdtempSync(join(tmpdir(), 'discord-outside-'));
    writeFileSync(join(work, 'run.log'), 'hello');
    writeFileSync(join(outside, 'secret.txt'), 'nope');
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('uploads a file inside the session folder as multipart', async () => {
    const { app, bridge } = await ready();
    const res = await post(app, join(work, 'run.log'));
    expect(res.json().data.ok).toBe(true);
    const form = fetchImpl.mock.calls.map((c) => c[1].body).find((b) => b instanceof FormData) as FormData;
    expect((form.get('files[0]') as File).name).toBe('run.log');
    bridge.stop();
  });

  it.each([
    ['a relative path', () => 'run.log'],
    ['a file outside the folder', () => join(outside, 'secret.txt')],
    ['the folder itself', () => work],
    ['a missing file', () => join(work, 'nope.log')],
  ])('refuses %s', async (_n, path) => {
    const { app, bridge } = await ready();
    const res = await post(app, path());
    expect(res.statusCode).toBe(400);
    expect(fetchImpl.mock.calls.some((c) => c[1].body instanceof FormData)).toBe(false);
    bridge.stop();
  });

  it('refuses to send when the session folder is not a directory it can probe', async () => {
    const { app, ctx, bridge } = await ready();
    (ctx.sessions.get('test-session-1') as unknown as { workingDir: string }).workingDir = join(work, 'run.log');
    const res = await post(app, join(work, 'run.log'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/session folder/);
    bridge.stop();
  });

  it('probes the file before realpath: a path that is not a regular file is refused', async () => {
    const { app, bridge } = await ready();
    mkdirSync(join(work, 'dir'));
    expect((await post(app, join(work, 'dir'))).json().error).toMatch(/Not a regular file/);
    bridge.stop();
  });

  it('refuses a symlink that points outside the folder', async () => {
    const { app, bridge } = await ready();
    mkdirSync(join(work, 'sub'));
    symlinkSync(join(outside, 'secret.txt'), join(work, 'sub', 'link.txt'));
    expect((await post(app, join(work, 'sub', 'link.txt'))).statusCode).toBe(400);
    bridge.stop();
  });

  it('refuses a file over 8 MB', async () => {
    const { app, bridge } = await ready();
    writeFileSync(join(work, 'big.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    const res = await post(app, join(work, 'big.bin'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/8 MB/);
    bridge.stop();
  });

  it('refuses a file for a remote session', async () => {
    const { app, bridge, ctx } = await ready();
    (ctx.sessions.get('test-session-1') as unknown as { remote: object }).remote = { label: 'box' };
    expect((await post(app, join(work, 'run.log'))).statusCode).toBe(400);
    bridge.stop();
  });
});
