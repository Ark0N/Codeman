// @vitest-environment node
/**
 * @fileoverview Discord bridge: pure rules, the 0600 store, the REST client, the gateway state
 * machine (fake socket) and the bridge's gates. No network, no real Discord.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPost,
  DEFAULT_DISCORD_CONFIG,
  DiscordApi,
  DiscordBridge,
  DiscordGateway,
  discordConfigPath,
  discordConfigProblem,
  maskToken,
  readDiscordConfig,
  readThreadMap,
  sanitiseReply,
  shouldPing,
  threadNameFor,
  writeDiscordConfig,
  type DiscordConfig,
  type DiscordFetch,
  type DiscordMessage,
  type GatewaySocket,
} from '../src/discord-bridge.js';

const TOKEN = 'MTA1.secret.token-value-1234567890';
const GUILD = '111111111111111111';
const PARENT = '222222222222222222';
const ME = '333333333333333333';
const THREAD = '444444444444444444';

const CFG: DiscordConfig = {
  ...DEFAULT_DISCORD_CONFIG,
  enabled: true,
  token: TOKEN,
  guildId: GUILD,
  parentChannelId: PARENT,
  allowedUserIds: [ME],
};

const MSG: DiscordMessage = {
  event: 'hook:permission_prompt',
  title: 'Permission Required',
  body: '[w1-app] Tool: Bash',
  urgency: 'critical',
  sessionId: 's1',
  sessionName: 'w1-app',
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'discord-bridge-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pure rules', () => {
  it('sanitiseReply makes one printable line plus Enter', () => {
    expect(sanitiseReply('yes')).toBe('yes\r');
    expect(sanitiseReply('line one\nline two\r\nthree')).toBe('line one line two three\r');
    expect(sanitiseReply('a\u001b[31mb\u0000c')).toBe('a[31mbc\r');
    expect(sanitiseReply('   \n\t ')).toBeNull();
    expect(sanitiseReply('x'.repeat(5000))!.length).toBe(1001);
  });

  it('threadNameFor falls back to the id and clips to 100 characters', () => {
    expect(threadNameFor('w3-app', 'abcdef123456')).toBe('w3-app');
    expect(threadNameFor('', 'abcdef123456')).toBe('abcdef12');
    expect(threadNameFor('n'.repeat(300), 'x')).toHaveLength(100);
  });

  it('shouldPing follows pingMode', () => {
    expect(shouldPing('off', 'critical', true)).toBe(false);
    expect(shouldPing('critical', 'critical')).toBe(true);
    expect(shouldPing('critical', 'warning')).toBe(false);
    expect(shouldPing('critical', 'warning', true)).toBe(true);
    expect(shouldPing('all', 'info')).toBe(true);
  });

  it('buildPost pings only allowlisted ids and never parses mentions', () => {
    const post = buildPost({ ...MSG, body: '@everyone <@999999999999999999>' }, CFG);
    expect(post.content).toContain(`<@${ME}>`);
    expect(post.allowed_mentions).toEqual({ parse: [], users: [ME] });
    const quiet = buildPost(MSG, { ...CFG, pingMode: 'off' });
    expect(quiet.content).not.toContain('<@');
    expect(quiet.allowed_mentions.users).toEqual([]);
  });

  it('buildPost fences the output tail and stays under the Discord limit', () => {
    const post = buildPost({ ...MSG, tail: 'Press the reset button ``` now\n' + 'x'.repeat(5000) }, CFG);
    expect(post.content.length).toBeLessThanOrEqual(1900);
    expect(post.content).toContain('Press the reset button');
    expect(post.content).not.toMatch(/button ``` now/);
  });

  it('discordConfigProblem checks ids and demands a complete config to enable', () => {
    expect(discordConfigProblem(CFG)).toBeNull();
    expect(discordConfigProblem(DEFAULT_DISCORD_CONFIG)).toBeNull();
    expect(discordConfigProblem({ ...CFG, guildId: 'abc' })).toMatch(/Guild ID/);
    expect(discordConfigProblem({ ...CFG, allowedUserIds: ['x'] })).toMatch(/user ID/);
    expect(discordConfigProblem({ ...CFG, allowedUserIds: [] })).toMatch(/at least one/i);
    expect(discordConfigProblem({ ...CFG, token: '' })).toMatch(/token/);
    expect(discordConfigProblem({ ...CFG, token: 'has space' })).toMatch(/token/);
  });

  it('maskToken never reveals the middle', () => {
    expect(maskToken(TOKEN)).not.toContain('secret');
    expect(maskToken('')).toBe('');
  });
});

describe('store', () => {
  it('round-trips the config, writes it 0600 and coerces junk to defaults', async () => {
    await writeDiscordConfig(dir, CFG);
    expect(statSync(discordConfigPath(dir)).mode & 0o777).toBe(0o600);
    expect(await readDiscordConfig(dir)).toEqual(CFG);
    expect(await readDiscordConfig(join(dir, 'missing'))).toEqual(DEFAULT_DISCORD_CONFIG);
  });
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('DiscordApi', () => {
  it('sends the token only in Authorization and retries once on 429', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: DiscordFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1 ? jsonRes({ retry_after: 0.01 }, 429) : jsonRes({ id: THREAD });
    };
    const api = new DiscordApi(
      () => TOKEN,
      fetchImpl,
      async () => undefined
    );
    const out = await api.createThread(PARENT, 'w1-app');
    expect(out).toEqual({ id: THREAD });
    expect(calls).toHaveLength(2);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
    expect(String(calls[0].init.body)).not.toContain(TOKEN);
  });

  it('turns an HTTP failure into an error that does not contain the token', async () => {
    const api = new DiscordApi(
      () => TOKEN,
      async () => jsonRes({ code: 50001 }, 403)
    );
    const err = await api.post(PARENT, { content: 'x', allowed_mentions: { parse: [], users: [] } }).catch((e) => e);
    expect(err.status).toBe(403);
    expect(String(err.message)).not.toContain(TOKEN);
  });
});

class FakeSocket implements GatewaySocket {
  sent: Array<{ op: number; d?: Record<string, unknown> | number | null }> = [];
  closed: number[] = [];
  private h: { message?: (d: { toString(): string }) => void; close?: (c: number) => void } = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    this.closed.push(code);
    this.h.close?.(code);
  }
  on(event: string, cb: (...a: never[]) => void): void {
    (this.h as Record<string, unknown>)[event] = cb;
  }
  recv(frame: unknown): void {
    this.h.message?.({ toString: () => JSON.stringify(frame) });
  }
  drop(code: number): void {
    this.h.close?.(code);
  }
}

describe('DiscordGateway', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const seen: unknown[] = [];
    const gw = new DiscordGateway(
      () => TOKEN,
      (m) => seen.push(m),
      (url) => {
        urls.push(url);
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      () => 10
    );
    return { gw, sockets, urls, seen };
  }

  it('identifies with the three intents, heartbeats, and surfaces MESSAGE_CREATE', () => {
    const { gw, sockets, seen } = setup();
    gw.start();
    sockets[0].recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(sockets[0].sent[0].op).toBe(2);
    expect((sockets[0].sent[0].d as { intents: number }).intents).toBe(1 | 512 | 32768);
    sockets[0].recv({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example' } });
    expect(gw.state).toBe('connected');
    vi.advanceTimersByTime(1000);
    expect(sockets[0].sent.at(-1)).toEqual({ op: 1, d: 1 });
    sockets[0].recv({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: { id: 'm', channel_id: THREAD, content: 'hi', author: { id: ME } },
    });
    expect(seen).toHaveLength(1);
    gw.stop();
  });

  it('resumes on the resume url after a drop', () => {
    const { gw, sockets, urls } = setup();
    gw.start();
    sockets[0].recv({ op: 10, d: { heartbeat_interval: 1000 } });
    sockets[0].recv({ op: 0, s: 5, t: 'READY', d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example' } });
    sockets[0].drop(1006);
    vi.advanceTimersByTime(10);
    expect(urls[1]).toContain('wss://resume.example');
    sockets[1].recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(sockets[1].sent[0]).toMatchObject({ op: 6, d: { session_id: 'sess', seq: 5 } });
    gw.stop();
  });

  it('stops for good on a close code that retrying cannot fix', () => {
    const { gw, sockets } = setup();
    gw.start();
    sockets[0].drop(4014);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(gw.state).toBe('error');
    expect(gw.lastError).toMatch(/Message Content Intent/);
    expect(gw.lastError).not.toContain(TOKEN);
  });

  it('closes a connection that stopped acknowledging heartbeats', () => {
    const { gw, sockets } = setup();
    gw.start();
    sockets[0].recv({ op: 10, d: { heartbeat_interval: 1000 } });
    vi.advanceTimersByTime(1000); // beat 1, no ack
    vi.advanceTimersByTime(1000); // beat 2 sees no ack
    expect(sockets[0].closed).toContain(4000);
    gw.stop();
  });
});

describe('DiscordBridge', () => {
  let posts: Array<{ path: string; method: string; body: Record<string, unknown> | undefined }>;
  let sendInput: ReturnType<typeof vi.fn<(id: string, text: string) => Promise<boolean>>>;
  let t: number;

  function bridge(overrides: Partial<DiscordConfig> = {}, fetchOverride?: DiscordFetch) {
    const fetchImpl: DiscordFetch =
      fetchOverride ??
      (async (url, init) => {
        const path = new URL(String(url)).pathname.replace('/api/v10', '');
        posts.push({ path, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (path.endsWith('/threads')) return jsonRes({ id: THREAD });
        return init.method === 'PUT' ? new Response(null, { status: 204 }) : jsonRes({ id: 'msg' });
      });
    return new DiscordBridge({
      configDir: dir,
      fetchImpl,
      sendInput,
      socketFactory: () => new FakeSocket(),
      now: () => t,
      sleep: async () => undefined,
    });
  }

  beforeEach(async () => {
    posts = [];
    t = 1_000_000;
    sendInput = vi.fn(async () => true);
    await writeDiscordConfig(dir, CFG);
  });

  it('creates the thread lazily on the first alert, reuses it, and persists the map', async () => {
    const b = bridge();
    await b.notify(MSG);
    t += 10_000;
    await b.notify({ ...MSG, event: 'hook:idle_prompt', urgency: 'warning' });
    expect(posts.filter((p) => p.path.endsWith('/threads'))).toHaveLength(1);
    expect(posts.filter((p) => p.path === `/channels/${THREAD}/messages`)).toHaveLength(2);
    expect(await readThreadMap(dir)).toEqual({ s1: THREAD });
    b.stop();
  });

  it('makes one thread when two alerts race', async () => {
    const b = bridge();
    await Promise.all([b.notify(MSG), b.notify({ ...MSG, event: 'hook:elicitation_dialog' })]);
    expect(posts.filter((p) => p.path.endsWith('/threads'))).toHaveLength(1);
    b.stop();
  });

  it('dedupes the same event within 3 s but lets an explicit urgent post through', async () => {
    const b = bridge();
    await b.notify(MSG);
    await b.notify(MSG);
    expect(posts.filter((p) => p.path.endsWith('/messages'))).toHaveLength(1);
    await b.notify(MSG, true);
    expect(posts.filter((p) => p.path.endsWith('/messages'))).toHaveLength(2);
    b.stop();
  });

  it('skips info events under scope attention and everything while disabled', async () => {
    const b = bridge();
    expect(await b.notify({ ...MSG, urgency: 'info' })).toBeNull();
    await writeDiscordConfig(dir, { ...CFG, enabled: false });
    await b.reload();
    expect(await b.notify(MSG)).toBeNull();
    expect(posts).toHaveLength(0);
    b.stop();
  });

  it('recreates a thread that was deleted by hand', async () => {
    let first = true;
    const b = bridge({}, async (url, init) => {
      const path = new URL(String(url)).pathname.replace('/api/v10', '');
      posts.push({ path, method: String(init.method), body: undefined });
      if (path.endsWith('/threads')) return jsonRes({ id: THREAD });
      if (first && path.endsWith('/messages')) {
        first = false;
        return jsonRes({ code: 10003 }, 404);
      }
      return jsonRes({ id: 'msg' });
    });
    const r = await b.notify(MSG);
    expect(r?.ok).toBe(true);
    expect(posts.filter((p) => p.path.endsWith('/threads'))).toHaveLength(2);
    b.stop();
  });

  it('reports a failure without the token and never throws', async () => {
    const b = bridge({}, async () => {
      throw new TypeError('fetch failed');
    });
    const r = await b.notify(MSG);
    expect(r).toMatchObject({ ok: false, error: 'Network error' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    b.stop();
  });

  describe('replies', () => {
    const reply = (over: Record<string, unknown> = {}) => ({
      id: 'm1',
      channel_id: THREAD,
      guild_id: GUILD,
      content: 'press y',
      author: { id: ME },
      ...over,
    });

    async function ready() {
      const b = bridge();
      await b.notify(MSG);
      posts.length = 0;
      t += 10_000;
      return b;
    }

    it('types an allowed reply into the mapped session and ticks it', async () => {
      const b = await ready();
      await b.onGatewayMessage(reply());
      expect(sendInput).toHaveBeenCalledWith('s1', 'press y\r');
      expect(posts[0].method).toBe('PUT');
      expect(posts[0].path).toContain('/reactions/');
      b.stop();
    });

    it.each([
      ['a stranger', { author: { id: '999999999999999999' } }],
      ['a bot', { author: { id: ME, bot: true } }],
      ['another guild', { guild_id: '555555555555555555' }],
      ['an unmapped channel', { channel_id: '666666666666666666' }],
      ['an empty message', { content: '  ' }],
    ])('drops %s without typing anything', async (_n, over) => {
      const b = await ready();
      await b.onGatewayMessage(reply(over));
      expect(sendInput).not.toHaveBeenCalled();
      expect(posts).toHaveLength(0);
      b.stop();
    });

    it('turns a multi-line reply into one line and rate limits a burst', async () => {
      const b = await ready();
      await b.onGatewayMessage(reply({ content: 'a\nb' }));
      await b.onGatewayMessage(reply({ content: 'again' }));
      expect(sendInput).toHaveBeenCalledTimes(1);
      expect(sendInput).toHaveBeenCalledWith('s1', 'a b\r');
      b.stop();
    });

    it('says so in the thread when the tab is gone', async () => {
      sendInput.mockResolvedValueOnce(false);
      const b = await ready();
      await b.onGatewayMessage(reply());
      expect(posts[0].method).toBe('POST');
      expect(String(posts[0].body?.content)).toMatch(/gone/);
      b.stop();
    });
  });

  describe('tab lifecycle', () => {
    it('creates the thread at once under onSessionStart, not under lazy', async () => {
      const lazy = bridge();
      await lazy.sessionCreated('s1', 'w1-app');
      expect(posts).toHaveLength(0);
      lazy.stop();
      await writeDiscordConfig(dir, { ...CFG, threadCreation: 'onSessionStart' });
      const eager = bridge();
      await eager.reload();
      await eager.sessionCreated('s1', 'w1-app');
      expect(posts.filter((p) => p.path.endsWith('/threads'))).toHaveLength(1);
      eager.stop();
    });

    it.each([
      ['archive', 'PATCH', { archived: true }],
      ['delete', 'DELETE', undefined],
    ] as const)('onSessionDelete %s calls the matching API', async (mode, method, body) => {
      await writeDiscordConfig(dir, { ...CFG, onSessionDelete: mode });
      const b = bridge();
      await b.notify(MSG);
      posts.length = 0;
      await b.sessionDeleted('s1');
      expect(posts).toEqual([{ path: `/channels/${THREAD}`, method, body }]);
      expect(await readThreadMap(dir)).toEqual({});
      b.stop();
    });

    it('keep leaves the thread alone but still forgets the mapping', async () => {
      await writeDiscordConfig(dir, { ...CFG, onSessionDelete: 'keep' });
      const b = bridge();
      await b.notify(MSG);
      posts.length = 0;
      await b.sessionDeleted('s1');
      expect(posts).toHaveLength(0);
      expect(await readThreadMap(dir)).toEqual({});
      b.stop();
    });

    it('renames the thread only when the name really changed', async () => {
      const b = bridge();
      await b.notify(MSG);
      await b.sessionRenamed('s1', 'w1-app'); // same name notify() used: first sight records it
      posts.length = 0;
      await b.sessionRenamed('s1', 'w1-app');
      await b.sessionRenamed('s1', 'fix login');
      expect(posts).toEqual([{ path: `/channels/${THREAD}`, method: 'PATCH', body: { name: 'fix login' } }]);
      b.stop();
    });
  });
});
