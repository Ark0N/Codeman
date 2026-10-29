/**
 * @fileoverview /api/discord: the bot token is a bearer secret, so it is never returned and the
 * settings routes are admin only in multi-user mode. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerDiscordRoutes } from '../../src/web/routes/discord-routes.js';
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

  it('rejects an empty or oversized message', async () => {
    const { app } = await harness();
    const url = `/api/sessions/test-session-1/discord-notify`;
    expect((await app.inject({ method: 'POST', url, payload: { message: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, payload: { message: 'x'.repeat(2000) } })).statusCode).toBe(400);
  });
});
