// @vitest-environment node
/**
 * @fileoverview Discord bridge: pure rules, the 0600 store, the REST client, the gateway state
 * machine (fake socket) and the bridge's gates. No network, no real Discord.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordConfig } from '../src/types/discord.js';
import {
  buildPost,
  DISCORD_STARTUP_HINT,
  ensureReceivedDir,
  isDiscordCdnUrl,
  safeAttachmentName,
  screenTail,
  splitForDiscord,
  tablesToCodeBlocks,
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

  it('ignores a frame that arrives after stop(): no heartbeat timer, nothing sent', () => {
    const { gw, sockets } = setup();
    gw.start();
    gw.stop();
    sockets[0].recv({ op: 10, d: { heartbeat_interval: 1000 } });
    expect(vi.getTimerCount()).toBe(0);
    expect(sockets[0].sent).toHaveLength(0);
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
  let sendInput: ReturnType<typeof vi.fn<(id: string, text: string, fromUser: boolean) => Promise<boolean>>>;
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

  it('dedupes an automatic event within 3 s and says so, which is not the "bridge is off" answer', async () => {
    const b = bridge();
    expect((await b.notify(MSG))?.ok).toBe(true);
    const second = await b.notify(MSG);
    expect(second).toMatchObject({ ok: true, deduped: true });
    expect(posts.filter((p) => p.path.endsWith('/messages'))).toHaveLength(1);
    b.stop();
  });

  it('never dedupes a deliberate post: two different messages from one tab within 3 s both go out', async () => {
    const b = bridge();
    const a = await b.notify({ ...MSG, event: 'session:discord-notify', body: 'first' }, { deliberate: true });
    const c = await b.notify({ ...MSG, event: 'session:discord-notify', body: 'second' }, { deliberate: true });
    expect(a?.deduped).toBeUndefined();
    expect(c?.deduped).toBeUndefined();
    expect(posts.filter((p) => p.path.endsWith('/messages'))).toHaveLength(2);
    b.stop();
  });

  it('builds the alert tail only for a post that goes out (not while off, not when deduped)', async () => {
    const tail = vi.fn(() => 'screen text');
    const b = bridge();
    await b.notify({ ...MSG, tail });
    expect(tail).toHaveBeenCalledTimes(1);
    await b.notify({ ...MSG, tail }); // deduped
    expect(tail).toHaveBeenCalledTimes(1);
    expect(posts.at(-1)?.body?.content).toContain('screen text');
    await writeDiscordConfig(dir, { ...CFG, enabled: false });
    await b.reload();
    await b.notify({ ...MSG, event: 'hook:idle_prompt', tail }); // off
    expect(tail).toHaveBeenCalledTimes(1);
    b.stop();
  });

  it('survives a tail that throws', async () => {
    const b = bridge();
    const r = await b.notify({
      ...MSG,
      tail: () => {
        throw new Error('tmux gone');
      },
    });
    expect(r?.ok).toBe(true);
    b.stop();
  });

  it('writes the thread map one write at a time, so threads made at once all survive a restart', async () => {
    let n = 0;
    const b = bridge({}, async (url, init) => {
      const path = new URL(String(url)).pathname.replace('/api/v10', '');
      if (path.endsWith('/threads')) return jsonRes({ id: String(500000000000000000n + BigInt(++n)) });
      return jsonRes({ id: 'msg' });
    });
    await Promise.all(['a1', 'a2', 'a3', 'a4'].map((id) => b.notify({ ...MSG, sessionId: id, event: `e-${id}` })));
    const map = await readThreadMap(dir);
    expect(Object.keys(map).sort()).toEqual(['a1', 'a2', 'a3', 'a4']);
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
      expect(sendInput).toHaveBeenCalledWith('s1', 'press y\r', true); // a person typed it
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
      expect(sendInput).toHaveBeenCalledWith('s1', 'a b\r', true);
      // The second reply was not typed, and the person is told so instead of it vanishing.
      expect(posts.some((p) => p.method === 'PUT' && p.path.includes(encodeURIComponent('⏳')))).toBe(true);
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

  it('starts afresh when the parent channel changes: tabs get a thread in the new channel', async () => {
    const b = bridge();
    await b.notify(MSG);
    expect(await readThreadMap(dir)).toEqual({ s1: THREAD });
    posts.length = 0;
    await writeDiscordConfig(dir, { ...CFG, parentChannelId: '777777777777777777' });
    await b.reload();
    await b.notify({ ...MSG, event: 'hook:idle_prompt' });
    expect(posts.find((p) => p.path.endsWith('/threads'))?.path).toBe('/channels/777777777777777777/threads');
    b.stop();
  });

  it('keeps the threads across a restart under the same parent channel', async () => {
    const first = bridge();
    await first.notify(MSG);
    first.stop();
    posts.length = 0;
    const second = bridge();
    await second.reload();
    await second.notify({ ...MSG, event: 'hook:idle_prompt' });
    expect(posts.some((p) => p.path.endsWith('/threads'))).toBe(false);
    second.stop();
  });

  it('a failed thread creation reports its own failure even if another post succeeds meanwhile', async () => {
    let n = 0;
    const b = bridge({}, async (url) => {
      if (String(url).endsWith('/threads')) {
        await new Promise((r) => setTimeout(r, 20));
        return new Response('{}', { status: 403 });
      }
      n++;
      return jsonRes({ id: 'msg' });
    });
    const [failed, ok] = await Promise.all([
      b.notify(MSG),
      b.notify({ ...MSG, sessionId: undefined, event: 'session:error' }),
    ]);
    expect(n).toBeGreaterThan(0);
    expect(ok?.ok).toBe(true);
    expect(failed).toMatchObject({ ok: false, status: 403 });
    b.stop();
  });

  it('drops a thread whose creation finished after the parent channel changed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const b = bridge({}, async (url, init) => {
      if (String(url).endsWith(`/channels/${PARENT}/threads`)) {
        await gate;
        return jsonRes({ id: THREAD });
      }
      posts.push({
        path: new URL(String(url)).pathname.replace('/api/v10', ''),
        method: String(init.method),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonRes({ id: 'msg' });
    });
    const first = b.notify(MSG);
    await new Promise((r) => setTimeout(r, 10));
    await writeDiscordConfig(dir, { ...CFG, parentChannelId: '777777777777777777' });
    await b.reload();
    release();
    expect(await first).toMatchObject({ ok: false });
    // The thread made in the old channel is tidied, not left open there.
    expect(posts).toContainEqual({ path: `/channels/${THREAD}`, method: 'PATCH', body: { archived: true } });
    expect(await readThreadMap(dir)).toEqual({});
    b.stop();
  });

  describe('full last message', () => {
    const LONG = Array.from({ length: 60 }, (_, i) => `**Point ${i}**: ${'detail '.repeat(10)}\nIs this right?`).join(
      '\n\n'
    );

    it('posts the whole message as markdown: head and first part together, the rest without a ping', async () => {
      const b = bridge();
      await b.notify({ ...MSG, tail: 'screen chrome', fullText: async () => ({ text: LONG }) });
      const sent = posts.filter((p) => p.path.endsWith('/messages'));
      expect(sent.length).toBeGreaterThan(1);
      const first = String(sent[0].body?.content);
      expect(first).toContain(MSG.title);
      expect(first).toContain('**Point 0**');
      expect(first).not.toContain('screen chrome');
      expect(first).not.toContain('```'); // markdown, not a code box
      expect(sent[1].body?.allowed_mentions).toEqual({ parse: [], users: [] });
      const all = sent.map((p) => String(p.body?.content)).join('\n');
      expect(all.match(/Is this right\?/g)).toHaveLength(60);
      b.stop();
    });

    it('posts a Markdown table as an aligned code block, since Discord does not render tables', async () => {
      const b = bridge();
      const table = [
        '| Variant | Decode (tokens/s) |',
        '|---|---:|',
        '| kv-f16 | 557.0 |',
        '| n-gram mod | 550.2 |',
      ].join('\n');
      await b.notify({ ...MSG, fullText: async () => ({ text: `Results:\n\n${table}` }) });
      const posted = posts
        .filter((p) => p.path.endsWith('/messages'))
        .map((p) => String(p.body?.content))
        .join('\n');
      expect(posted).toContain('```\nVariant     Decode (tokens/s)\n');
      expect(posted).not.toContain('|---');
      b.stop();
    });

    it('does not post the same message twice (idle, then stop), and falls back to the tail without a transcript', async () => {
      const b = bridge();
      await b.notify({ ...MSG, fullText: async () => ({ text: 'Short answer.' }) });
      t += 10_000;
      posts.length = 0;
      await b.notify({ ...MSG, event: 'hook:stop', tail: 'chrome', fullText: async () => ({ text: 'Short answer.' }) });
      const again = posts.filter((p) => p.path.endsWith('/messages')).map((p) => String(p.body?.content));
      expect(again).toHaveLength(1);
      expect(again[0]).not.toContain('Short answer.');
      expect(again[0]).not.toContain('chrome');
      t += 10_000;
      posts.length = 0;
      await b.notify({ ...MSG, event: 'hook:idle_prompt', tail: 'the screen', fullText: async () => undefined });
      expect(String(posts.find((p) => p.path.endsWith('/messages'))?.body?.content)).toContain('the screen');
      b.stop();
    });

    it('leaves a message to be posted again when its first post failed', async () => {
      let fail = true;
      const b = bridge({}, async (url, init) => {
        const path = new URL(String(url)).pathname.replace('/api/v10', '');
        posts.push({ path, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (path.endsWith('/threads')) return jsonRes({ id: THREAD });
        if (fail && path.endsWith('/messages')) return new Response('{}', { status: 500 });
        return jsonRes({ id: 'msg' });
      });
      const first = await b.notify({ ...MSG, event: 'hook:stop', fullText: async () => ({ text: 'The answer.' }) });
      expect(first).toMatchObject({ ok: false });
      fail = false;
      t += 10_000;
      posts.length = 0;
      await b.notify({ ...MSG, event: 'hook:idle_prompt', fullText: async () => ({ text: 'The answer.' }) });
      expect(posts.map((p) => String(p.body?.content)).join('\n')).toContain('The answer.');
      b.stop();
    });

    it('does not post the same message twice when two alerts for one tab overlap', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const b = bridge({}, async (url, init) => {
        const path = new URL(String(url)).pathname.replace('/api/v10', '');
        posts.push({ path, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (path.endsWith('/threads')) return jsonRes({ id: THREAD });
        if (path.endsWith('/messages')) await gate;
        return jsonRes({ id: 'msg' });
      });
      const full = async () => ({ text: 'The one answer.', version: 'turn-1' });
      const first = b.notify({ ...MSG, event: 'hook:idle_prompt', fullText: full });
      await vi.waitFor(() => expect(posts.some((p) => p.path.endsWith('/messages'))).toBe(true));
      const second = b.notify({ ...MSG, event: 'hook:stop', fullText: full });
      await new Promise((r) => setTimeout(r, 20));
      release();
      await Promise.all([first, second]);
      const said = posts.filter((p) => p.path.endsWith('/messages')).map((p) => String(p.body?.content));
      expect(said.filter((c) => c.includes('The one answer.'))).toHaveLength(1);
      b.stop();
    });

    it('posts a later turn that ends on the same words, but not the same turn twice', async () => {
      const b = bridge();
      await b.notify({ ...MSG, fullText: async () => ({ text: 'Done.', version: 'turn-1' }) });
      t += 10_000;
      posts.length = 0;
      await b.notify({ ...MSG, event: 'hook:stop', fullText: async () => ({ text: 'Done.', version: 'turn-1' }) });
      expect(posts.map((p) => String(p.body?.content)).join('\n')).not.toContain('Done.');
      t += 10_000;
      posts.length = 0;
      await b.notify({ ...MSG, fullText: async () => ({ text: 'Done.', version: 'turn-2' }) });
      expect(posts.map((p) => String(p.body?.content)).join('\n')).toContain('Done.');
      b.stop();
    });

    it('falls back to the tail when reading the transcript throws or hangs', async () => {
      const b = bridge();
      await b.notify({
        ...MSG,
        tail: 'the screen',
        fullText: async () => {
          throw new Error('no transcript');
        },
      });
      expect(String(posts.find((p) => p.path.endsWith('/messages'))?.body?.content)).toContain('the screen');
      b.stop();
    });
  });

  describe('sweepStaleThreads', () => {
    const ME = '555555555555555555';
    const OTHER = '666666666666666666';
    const OLD = (n: number) => `30000000000000000${n}`; // a snowflake from 2015, long before `now`
    let young: string;
    let calls: Array<{ method: string; path: string; body?: unknown }>;

    async function swept(staleThreads: 'keep' | 'archive' | 'delete') {
      await writeDiscordConfig(dir, { ...CFG, staleThreads });
      t = Date.now();
      young = String((BigInt(t - 60_000 - 1420070400000) << 22n) + 5n);
      calls = [];
      const th = (id: string, owner = ME, parent = PARENT) => ({ id, owner_id: owner, parent_id: parent });
      const b = bridge({}, async (url, init) => {
        const path = new URL(String(url)).pathname.replace('/api/v10', '');
        const method = String(init.method);
        calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (path === '/users/@me') return jsonRes({ id: ME });
        if (path.endsWith('/threads/active'))
          return jsonRes({
            threads: [
              th(THREAD), // mapped
              th(OLD(1)), // stale
              th(OLD(2), OTHER), // someone else's thread
              th(OLD(3), ME, '999999999999999999'), // another channel
              th(young), // too new to judge
            ],
          });
        if (path.includes('/threads/archived')) return jsonRes({ threads: [th(OLD(4))] });
        if (path.endsWith('/threads')) return jsonRes({ id: THREAD });
        return method === 'PUT' ? new Response(null, { status: 204 }) : jsonRes({ id: 'msg' });
      });
      return b.notify(MSG).then(() => {
        calls.length = 0;
        return b;
      });
    }
    const touched = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.split('/').pop()}`);

    it('does nothing while set to keep', async () => {
      const b = await swept('keep');
      expect(await b.sweepStaleThreads()).toBe(0);
      expect(calls).toHaveLength(0);
      b.stop();
    });

    it("archives only this bot's old, unmapped threads in the parent channel, and skips archived ones", async () => {
      const b = await swept('archive');
      expect(await b.sweepStaleThreads()).toBe(1);
      expect(touched()).toEqual([`PATCH ${OLD(1)}`]);
      expect(calls.some((c) => c.path.includes('/threads/archived'))).toBe(false);
      b.stop();
    });

    it('deletes stale active and archived threads, and still spares the rest', async () => {
      const b = await swept('delete');
      expect(await b.sweepStaleThreads()).toBe(2);
      expect(touched()).toEqual([`DELETE ${OLD(1)}`, `DELETE ${OLD(4)}`]);
      b.stop();
    });

    it('does nothing when the map is empty, since a lost map would make every thread look stale', async () => {
      const b = await swept('delete');
      await b.sessionDeleted('s1'); // empties the map
      calls.length = 0;
      expect(await b.sweepStaleThreads()).toBe(0);
      expect(calls).toHaveLength(0);
      b.stop();
    });
  });

  it('keeps the gateway off while held (boot) and starts it on release', async () => {
    const b = bridge();
    b.hold();
    await b.reload();
    expect(b.gatewayState).toBe('off');
    await b.release();
    expect(b.gatewayState).not.toBe('off');
    b.stop();
  });

  it('prune drops thread entries for tabs that no longer exist, and keeps the live ones', async () => {
    const b = bridge();
    await b.notify(MSG);
    await b.notify({ ...MSG, sessionId: 's2', sessionName: 'w2' });
    await b.prune(['s2']);
    expect(Object.keys(await readThreadMap(dir))).toEqual(['s2']);
    await b.prune([]); // nothing restored: leave the map alone
    expect(Object.keys(await readThreadMap(dir))).toEqual(['s2']);
    b.stop();
  });

  describe('sendTest', () => {
    it('posts with the config it is given and leaves the live config alone', async () => {
      const auth: string[] = [];
      const b = bridge({}, async (_url, init) => {
        auth.push(String((init.headers as Record<string, string>).Authorization));
        return jsonRes({ id: 'msg' });
      });
      await b.reload();
      expect((await b.sendTest({ ...CFG, token: 'test-token' }))?.ok).toBe(true);
      // A save that landed during the test must not be undone: the live token is still the saved one.
      await b.notify(MSG);
      expect(auth[0]).toBe('Bot test-token');
      expect(auth.slice(1).every((a) => a === `Bot ${CFG.token}`)).toBe(true);
      b.stop();
    });
  });

  it('names a thread that Discord answers without an id, instead of reporting an old result', async () => {
    const b = bridge({}, async (url) => (String(url).endsWith('/threads') ? jsonRes({}) : jsonRes({ id: 'msg' })));
    const r = await b.notify(MSG);
    expect(r).toMatchObject({ ok: false, error: 'Discord did not return a thread' });
    b.stop();
  });

  it('replaces a gateway that gave up on a fatal close when the same config is saved again', async () => {
    const sockets: FakeSocket[] = [];
    const b = new DiscordBridge({
      configDir: dir,
      fetchImpl: async () => jsonRes({ id: 'msg' }),
      sendInput,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      now: () => t,
      sleep: async () => undefined,
    });
    await b.reload();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].drop(4014); // Message Content Intent off: fatal, no reconnect
    expect(b.gatewayState).toBe('error');
    await b.reload();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(b.gatewayState).not.toBe('error');
    b.stop();
  });

  it('keeps the gateway session across a save that changes neither the switch nor the token', async () => {
    const b = bridge();
    await b.reload();
    const first = (b as unknown as { gateway: unknown }).gateway;
    expect(first).not.toBeNull();
    await b.reload();
    expect((b as unknown as { gateway: unknown }).gateway).toBe(first);
    await writeDiscordConfig(dir, { ...CFG, token: 'another-token' });
    await b.reload();
    expect((b as unknown as { gateway: unknown }).gateway).not.toBe(first);
    b.stop();
  });

  it('does not rename a thread to the name it already has on first sight', async () => {
    const b = bridge();
    await b.notify(MSG);
    posts.length = 0;
    await b.sessionRenamed('s1', 'w1-app');
    expect(posts).toHaveLength(0);
    b.stop();
  });

  describe('per-tab state', () => {
    const internals = (b: DiscordBridge) =>
      b as unknown as { names: Map<string, string>; lastReply: Map<string, number>; fresh: Set<string> };

    it('a deleted tab that never had a thread still frees its entries', async () => {
      const b = bridge();
      await b.reload();
      await b.sessionCreated('nothread', 'w', t - 1000);
      await b.sessionRenamed('nothread', 'w');
      internals(b).lastReply.set('nothread', 1);
      await b.sessionDeleted('nothread');
      expect(internals(b).names.has('nothread')).toBe(false);
      expect(internals(b).lastReply.has('nothread')).toBe(false);
      expect(internals(b).fresh.has('nothread')).toBe(false);
      b.stop();
    });

    it('stop() clears the maps and the gateway', async () => {
      const b = bridge();
      await b.reload();
      await b.sessionCreated('x', 'w', t - 1000);
      await b.sessionRenamed('x', 'w');
      b.stop();
      expect(internals(b).fresh.size).toBe(0);
      expect(internals(b).names.size).toBe(0);
      expect(b.gatewayState).toBe('off');
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

    it('forgetTab drops the per-tab state but keeps the thread and its map entry', async () => {
      await writeDiscordConfig(dir, { ...CFG, onSessionDelete: 'delete' });
      const b = bridge();
      await b.notify(MSG);
      posts.length = 0;
      b.forgetTab('s1');
      await b.sessionRenamed('s1', 'other'); // first sight again: recorded, no PATCH
      expect(posts).toHaveLength(0);
      expect(await readThreadMap(dir)).toEqual({ s1: THREAD });
      b.stop();
    });

    it('a tab closed while its thread is being created has that thread closed and no entry kept', async () => {
      await writeDiscordConfig(dir, { ...CFG, onSessionDelete: 'archive' });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const b = bridge({}, async (url, init) => {
        const path = new URL(String(url)).pathname.replace('/api/v10', '');
        posts.push({ path, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (path.endsWith('/threads')) {
          await gate;
          return jsonRes({ id: THREAD });
        }
        return jsonRes({ id: 'msg' });
      });
      const first = b.notify(MSG);
      await vi.waitFor(() => expect(posts.some((p) => p.path.endsWith('/threads'))).toBe(true));
      await b.sessionDeleted('s1');
      release();
      const out = await first;
      expect(posts).toContainEqual({ path: `/channels/${THREAD}`, method: 'PATCH', body: { archived: true } });
      expect(out).toMatchObject({ ok: false, error: 'The tab was closed' });
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

describe('files', () => {
  it('safeAttachmentName keeps one safe path segment', () => {
    expect(safeAttachmentName('report final (1).pdf')).toBe('report_final_1_.pdf');
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentName('.env')).toBe('env');
    expect(safeAttachmentName('')).toBe('file');
    expect(safeAttachmentName('x'.repeat(300))).toHaveLength(80);
  });

  it('isDiscordCdnUrl accepts only Discord https hosts', () => {
    expect(isDiscordCdnUrl('https://cdn.discordapp.com/attachments/1/2/a.png')).toBe(true);
    expect(isDiscordCdnUrl('https://media.discordapp.net/attachments/1/2/a.png')).toBe(true);
    expect(isDiscordCdnUrl('http://cdn.discordapp.com/a.png')).toBe(false);
    expect(isDiscordCdnUrl('https://evil.example/a.png')).toBe(false);
    expect(isDiscordCdnUrl('https://discordapp.com.evil.example/a.png')).toBe(false);
    expect(isDiscordCdnUrl('http://169.254.169.254/')).toBe(false);
    expect(isDiscordCdnUrl('nonsense')).toBe(false);
  });

  it('sanitiseReply appends attached paths after the cap, and a file alone is enough', () => {
    expect(sanitiseReply('see this', ['/w/.codeman-discord/1-a.png'])).toBe(
      'see this [attached: /w/.codeman-discord/1-a.png]\r'
    );
    expect(sanitiseReply('', ['/w/a'])).toBe('[attached: /w/a]\r');
    expect(sanitiseReply('x'.repeat(5000), ['/w/a'])!.endsWith('[attached: /w/a]\r')).toBe(true);
  });

  it('postWithFile sends multipart with a safe filename and no JSON content type', async () => {
    let seen: { init: RequestInit } | null = null;
    const api = new DiscordApi(
      () => TOKEN,
      async (_u, init) => {
        seen = { init };
        return jsonRes({ id: 'm' });
      }
    );
    await api.postWithFile(
      PARENT,
      { content: 'hi', allowed_mentions: { parse: [], users: [] } },
      { name: '../x y.log', data: new Uint8Array([1, 2, 3]) }
    );
    const body = seen!.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(body.get('payload_json'))).content).toBe('hi');
    expect((body.get('files[0]') as File).name).toBe('x_y.log');
    expect((seen!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});

describe('DiscordBridge files and startup hint', () => {
  const reply = (over: Record<string, unknown> = {}) => ({
    id: '555555555555555555',
    channel_id: THREAD,
    guild_id: GUILD,
    content: '',
    author: { id: ME },
    attachments: [
      { id: 'a1', filename: 'shot one.png', size: 3, url: 'https://cdn.discordapp.com/attachments/1/2/shot.png' },
    ],
    ...over,
  });
  let work: string;
  let sent: Array<[string, string, boolean]>;
  let posted: Array<{ path: string; body?: Record<string, unknown> }>;
  let downloads: string[];

  function make(
    cfg: Partial<DiscordConfig> = {},
    dirFor: (id: string) => string | undefined = () => work,
    awaitingChoice?: (id: string) => boolean,
    agentExited?: (id: string) => boolean
  ) {
    const b = new DiscordBridge({
      configDir: dir,
      fetchImpl: async (url, init) => {
        const u = new URL(String(url));
        if (u.hostname === 'cdn.discordapp.com') {
          downloads.push(String(url));
          return new Response(new Uint8Array([7, 8, 9]));
        }
        const path = u.pathname.replace('/api/v10', '');
        posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return path.endsWith('/threads') ? jsonRes({ id: THREAD }) : jsonRes({ id: 'msg' });
      },
      sendInput: async (id, text, fromUser) => (sent.push([id, text, fromUser]), true),
      sessionDir: dirFor,
      awaitingChoice,
      agentExited,
      socketFactory: () => new FakeSocket(),
      now: () => t,
      sleep: async () => undefined,
    });
    return writeDiscordConfig(dir, { ...CFG, typedHint: true, ...cfg }).then(async () => {
      await b.reload();
      await b.notify(MSG);
      posted.length = 0;
      return b;
    });
  }
  let t = 5_000_000;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'discord-work-'));
    sent = [];
    posted = [];
    downloads = [];
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('saves an attachment under .codeman-discord and types its path, even with no text', async () => {
    const b = await make();
    await b.onGatewayMessage(reply());
    const dest = join(work, '.codeman-discord', '555555555555555555-shot_one.png');
    expect(readFileSync(dest)).toEqual(Buffer.from([7, 8, 9]));
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(sent).toEqual([['s1', `[attached: ${dest}]\r`, true]]);
    b.stop();
  });

  it('refuses a non-Discord URL, an oversize file and a sixth file, and says so in the thread', async () => {
    const b = await make();
    const many = Array.from({ length: 6 }, (_v, i) => ({
      id: String(i),
      filename: `f${i}.txt`,
      size: 1,
      url: 'https://cdn.discordapp.com/a/' + i,
    }));
    await b.onGatewayMessage(
      reply({
        content: 'look',
        attachments: [
          { id: 'x', filename: 'evil.png', size: 1, url: 'http://169.254.169.254/latest' },
          { id: 'y', filename: 'huge.bin', size: 9 * 1024 * 1024, url: 'https://cdn.discordapp.com/a/huge' },
          ...many,
        ],
      })
    );
    expect(downloads.some((u) => u.includes('169.254'))).toBe(false);
    expect(downloads.some((u) => u.includes('huge'))).toBe(false);
    expect(downloads).toHaveLength(3); // 5 allowed in total, two of which were the refused ones above
    expect(posted.map((p) => String(p.body?.content)).find((c) => c.startsWith('Not saved'))).toMatch(
      /evil\.png.*huge\.bin/
    );
    b.stop();
  });

  it('says there is no folder for a remote tab and types nothing for a file-only reply', async () => {
    const b = await make({}, () => undefined);
    await b.onGatewayMessage(reply());
    expect(sent).toHaveLength(0);
    expect(String(posted.at(-1)?.body?.content)).toMatch(/no local folder/);
    b.stop();
  });

  it('sends the startup hint once, only to a fresh external session, and never to a shell', async () => {
    const b = await make();
    await b.sessionCreated('s2', 'w2', t - 1000);
    await b.sessionIdle('s2', false); // shell or Claude: nothing
    expect(sent).toHaveLength(0);
    await b.sessionCreated('s3', 'w3', t - 1000);
    await b.sessionIdle('s3', true);
    await b.sessionIdle('s3', true); // second idle: nothing
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('s3');
    expect(sent[0][1]).toContain('codeman notify');
    expect(sent[0][1].endsWith('\r')).toBe(true);
    expect(sent[0][2]).toBe(false); // Codeman's own text: not a person's input, so it cannot auto-name the tab
    expect(DISCORD_STARTUP_HINT).toContain('codeman notify');
    b.stop();
  });

  it('holds the startup hint while a choice is pending and sends it at the next idle', async () => {
    let choice = true;
    const b = await make({}, undefined, () => choice);
    await b.sessionCreated('s6', 'w6', t - 1000);
    await b.sessionIdle('s6', true);
    expect(sent).toHaveLength(0);
    choice = false;
    await b.sessionIdle('s6', true);
    expect(sent).toHaveLength(1);
    await b.sessionIdle('s6', true);
    expect(sent).toHaveLength(1);
    b.stop();
  });

  it('does not hint a tab that was already past its first idle while the hint was off', async () => {
    const off = await make({ typedHint: false });
    await off.sessionCreated('s8', 'w8', t - 1000);
    await off.sessionIdle('s8', true); // first idle with the hint off: no longer new
    await writeDiscordConfig(dir, { ...CFG, typedHint: true });
    await off.reload();
    await off.sessionIdle('s8', true);
    expect(sent).toHaveLength(0);
    off.stop();
  });

  it('says the agent has exited and types nothing when the tab reports it', async () => {
    const b = await make({}, undefined, undefined, () => true);
    await b.onGatewayMessage(reply({ content: 'hello', attachments: [] }));
    expect(sent).toHaveLength(0);
    expect(String(posted.at(-1)?.body?.content)).toMatch(/exited/);
    expect(posted.some((p) => p.path.includes('reactions'))).toBe(false);
    b.stop();
  });

  it('types a reply that waits on a download before a later text reply', async () => {
    const b = await make();
    const slow = b.onGatewayMessage(reply({ content: 'first' }));
    await new Promise((r) => setTimeout(r, 0)); // the first reply is under way (gate passed) before the clock moves
    t += 5_000;
    const fast = b.onGatewayMessage(reply({ id: '555555555555555556', content: 'second', attachments: [] }));
    await Promise.all([slow, fast]);
    expect(sent.map((s) => s[1].split(' ')[0])).toEqual(['first', 'second\r']);
    b.stop();
  });

  it('types a lone digit without Enter while a dialog is waiting, and with Enter otherwise', async () => {
    let waiting = true;
    const b = await make({}, undefined, () => waiting);
    await b.onGatewayMessage(reply({ content: '2', attachments: [] }));
    expect(sent.at(-1)?.[1]).toBe('2');
    t += 5_000;
    await b.onGatewayMessage(reply({ content: 'yes', attachments: [] }));
    expect(sent.at(-1)?.[1]).toBe('yes\r');
    t += 5_000;
    waiting = false;
    await b.onGatewayMessage(reply({ content: '2', attachments: [] }));
    expect(sent.at(-1)?.[1]).toBe('2\r');
    b.stop();
  });

  it('does not save a file for a message id that is not a snowflake, and says so', async () => {
    const b = await make();
    await b.onGatewayMessage(reply({ id: '../../x' }));
    expect(downloads).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(String(posted.at(-1)?.body?.content)).toMatch(/could not be saved/);
    b.stop();
  });

  it('sends the typed hint only when typedHint is on (the default is off)', async () => {
    const off = await make({ typedHint: false });
    await off.sessionCreated('s7', 'new', t - 1000);
    await off.sessionIdle('s7', true);
    expect(sent).toHaveLength(0);
    off.stop();
    expect(DEFAULT_DISCORD_CONFIG.typedHint).toBe(false);
  });

  it('does not hint a restored (old) session, or when startupHint is off', async () => {
    const b = await make();
    await b.sessionCreated('s4', 'old', 1); // created long ago: restored at server start
    await b.sessionIdle('s4', true);
    expect(sent).toHaveLength(0);
    b.stop();
    const off = await make({ startupHint: false });
    await off.sessionCreated('s5', 'new', t - 1000);
    await off.sessionIdle('s5', true);
    expect(sent).toHaveLength(0);
    off.stop();
  });
});

describe('tablesToCodeBlocks', () => {
  it('turns a Markdown table into an aligned code block, dropping bold and code marks', () => {
    const md = [
      'Results:',
      '',
      '| Variant | Decode (tokens/s) |',
      '|---|---:|',
      '| `kv-f16` | 557.0 |',
      '| **n-gram simple** | 554.5 |',
      '| n-gram mod | 550.2 |',
      '',
      'Done.',
    ].join('\n');
    expect(tablesToCodeBlocks(md)).toBe(
      [
        'Results:',
        '',
        '```',
        'Variant        Decode (tokens/s)',
        '-------------  -----------------',
        'kv-f16                     557.0',
        'n-gram simple              554.5',
        'n-gram mod                 550.2',
        '```',
        '',
        'Done.',
      ].join('\n')
    );
  });

  it('leaves a table inside a code fence, prose with pipes and a table-less message alone', () => {
    const fenced = ['```', '| a | b |', '|---|---|', '| 1 | 2 |', '```'].join('\n');
    expect(tablesToCodeBlocks(fenced)).toBe(fenced);
    const prose = 'Use a | b to pipe.\nThen c | d.';
    expect(tablesToCodeBlocks(prose)).toBe(prose);
  });

  it('converts a hostile separator row of 100,000 spaces in well under a second', () => {
    const rows = ['| a | b |', `|---${' '.repeat(100_000)}x`, '| 1 | 2 |'].join('\n');
    const t0 = Date.now();
    expect(tablesToCodeBlocks(rows)).toBe(rows);
    expect(Date.now() - t0).toBeLessThan(500);
    const real = ['| a | b |', `| --- ${' '.repeat(50_000)}| --- |`, '| 1 | 2 |'].join('\n');
    const t1 = Date.now();
    expect(tablesToCodeBlocks(real)).toContain('```');
    expect(Date.now() - t1).toBeLessThan(500);
  });

  it('leaves a wide or long table as written, quickly: 3000 columns over 3000 one-pipe rows', () => {
    const wide = [`|${' a |'.repeat(3000)}`, '|---|', ...Array.from({ length: 3000 }, () => '| x |')].join('\n');
    const t0 = Date.now();
    expect(tablesToCodeBlocks(wide)).toBe(wide);
    expect(Date.now() - t0).toBeLessThan(500);
    const tall = ['| a | b |', '|---|---|', ...Array.from({ length: 300 }, (_, i) => `| ${i} | y |`)].join('\n');
    expect(tablesToCodeBlocks(tall)).toBe(tall);
    const big = ['| a |', '|---|', ...Array.from({ length: 200_000 }, () => '| x |')].join('\n');
    const t1 = Date.now();
    expect(() => tablesToCodeBlocks(big)).not.toThrow(); // no spread of 200,000 rows into Math.max
    expect(Date.now() - t1).toBeLessThan(1000);
  });

  it('keeps a sentence with a pipe under a table out of the code block', () => {
    const out = tablesToCodeBlocks(['| a | b |', '|---|---|', '| 1 | 2 |', 'Use x | y to pipe.'].join('\n'));
    expect(out).toBe(['```', 'a  b', '-  -', '1  2', '```', 'Use x | y to pipe.'].join('\n'));
  });

  it('pads a short row and keeps an escaped pipe in a cell', () => {
    const out = tablesToCodeBlocks(['| a | b |', '|---|---|', '| x \\| y |', '| p | q |'].join('\n'));
    expect(out).toContain('x | y');
    expect(out.split('\n').every((l) => !/\s$/.test(l))).toBe(true);
  });
});

describe('splitForDiscord', () => {
  it('keeps a short message whole', () => {
    expect(splitForDiscord('Line one\n\n**Two**\n- a\n- b')).toEqual(['Line one\n\n**Two**\n- a\n- b']);
  });

  it('splits a long message into posts under the limit and loses no line', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `- item ${i} ${'x'.repeat(40)}`);
    const posts = splitForDiscord(lines.join('\n'));
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((p) => p.length <= 1900)).toBe(true);
    expect(
      posts
        .join('\n')
        .split('\n')
        .filter((l) => l.startsWith('- item'))
    ).toEqual(lines);
  });

  it('closes a code fence the cut lands inside and reopens it in the next post', () => {
    const body = ['```', ...Array.from({ length: 100 }, (_, i) => `row ${i} ${'y'.repeat(40)}`), '```'].join('\n');
    const posts = splitForDiscord(body);
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it('cuts one enormous line by length, and caps the number of posts with a note', () => {
    const posts = splitForDiscord('z'.repeat(50_000), 1900, 3);
    expect(posts).toHaveLength(3);
    expect(posts.every((p) => p.length <= 2000)).toBe(true); // Discord's own limit, with the note included
    expect(posts[2]).toMatch(/continues in the tab/);
  });
});

describe('screenTail', () => {
  it("cuts the composer row and the status lines under it, but keeps a dialog's selected option", () => {
    const idle = [
      "  I'll sync the results and update the docs when the run finishes.",
      '✻ Crunched for 7m 55s · done 4:22 PM',
      '✔ Update installed · /restart to apply',
      '❯',
      '  Sonnet 5.5  in:169,629 out:751  ctx:17%  cache:until 17:22',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(screenTail(idle, 14, 900, '❯')).toBe(
      [
        "  I'll sync the results and update the docs when the run finishes.",
        '✻ Crunched for 7m 55s · done 4:22 PM',
        '✔ Update installed · /restart to apply',
      ].join('\n')
    );
    const dialog = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'].join('\n');
    expect(screenTail(dialog, 14, 900, '❯')).toBe(dialog);
    expect(screenTail(idle)).toContain('❯'); // no glyph given: nothing is cut
  });

  it('keeps the last lines of a rendered screen and drops rules, blanks and escape codes', () => {
    const screen = [
      'old line',
      '',
      '\u001b[1mWhich option?\u001b[0m',
      '─────────────────────────',
      '  1. Cap GPUs',
      '  2. Cap CPU',
      '\u001b(B',
      '  4. Type something.',
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      'Enter to select · Esc to cancel\u001b(B',
    ].join('\n');
    expect(screenTail(screen)).toBe(
      [
        'old line',
        'Which option?',
        '  1. Cap GPUs',
        '  2. Cap CPU',
        '  4. Type something.',
        'Enter to select · Esc to cancel',
      ].join('\n')
    );
  });

  it('caps lines and characters, cutting on a line', () => {
    const many = Array.from({ length: 40 }, (_v, i) => `line ${i}`).join('\n');
    expect(screenTail(many).split('\n')).toHaveLength(14);
    expect(screenTail(many).endsWith('line 39')).toBe(true);
    const wide = Array.from({ length: 5 }, () => 'x'.repeat(400)).join('\n');
    expect(screenTail(wide).length).toBeLessThanOrEqual(900);
  });

  it('is empty for nothing', () => {
    expect(screenTail('')).toBe('');
    expect(screenTail('\n\n ───── \n')).toBe('');
  });
});

describe('ensureReceivedDir', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'discord-recv-'));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('makes the folder and ignores it with a .gitignore of *, once', async () => {
    const dir = await ensureReceivedDir(work);
    expect(dir).toBe(join(work, '.codeman-discord'));
    expect(readFileSync(join(dir!, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('leaves a .gitignore that is already there alone', async () => {
    mkdirSync(join(work, '.codeman-discord'));
    writeFileSync(join(work, '.codeman-discord', '.gitignore'), 'mine\n');
    expect(await ensureReceivedDir(work)).toBe(join(work, '.codeman-discord'));
    expect(readFileSync(join(work, '.codeman-discord', '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('refuses a symlink or a plain file at the folder, and a workspace that is not a directory', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'discord-elsewhere-'));
    symlinkSync(elsewhere, join(work, '.codeman-discord'));
    expect(await ensureReceivedDir(work)).toBeNull();
    expect(existsSync(join(elsewhere, '.gitignore'))).toBe(false);
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(join(work, '.codeman-discord'));
    writeFileSync(join(work, '.codeman-discord'), 'x');
    expect(await ensureReceivedDir(work)).toBeNull();
    expect(await ensureReceivedDir(join(work, 'missing'))).toBeNull();
  });
});
