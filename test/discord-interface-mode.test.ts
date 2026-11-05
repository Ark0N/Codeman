/** Full-interface discovery uses fake Discord only; never attaches to or submits work to a session. */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISCORD_CONFIG,
  DiscordBridge,
  discordConfigPath,
  readDiscordConfig,
  writeDiscordConfig,
  type DiscordFetch,
} from '../src/discord-bridge.js';

const cfg = {
  ...DEFAULT_DISCORD_CONFIG,
  enabled: true,
  mode: 'full' as const,
  categoryId: '666666666666666666',
  onChannelDelete: 'delete' as const,
  onSessionDelete: 'delete' as const,
  token: 'fake-test-token',
  guildId: '111111111111111111',
  parentChannelId: '222222222222222222',
  allowedUserIds: ['333333333333333333'],
};
let dir: string;
let sessions: Array<{ id: string; name?: string; remote?: boolean; working?: boolean }>;
let bridges: DiscordBridge[];
let posts: Array<{ path: string; method: string; body?: any }>;
let sendInput: ReturnType<typeof vi.fn>;
let sequence: number;
let remoteChannels: Map<string, any>;
let remoteMessages: Map<string, any>;
let statusEditRefused: boolean;
let uploaded: Array<{ name: string; text: string }>;
const BOT = '888888888888888888';

function makeBridge(
  fetchOverride?: DiscordFetch,
  extra: Partial<import('../src/discord-bridge.js').DiscordBridgeDeps> = {}
) {
  const bridge = new DiscordBridge({
    configDir: dir,
    ...extra,
    sessions: () => sessions,
    sendInput,
    fetchImpl: async (url, init) => {
      const method = String(init.method);
      const path = url.pathname;
      const body = init.body
        ? JSON.parse(init.body instanceof FormData ? String(init.body.get('payload_json')) : String(init.body))
        : undefined;
      if (init.body instanceof FormData) {
        const file = init.body.get('files[0]');
        if (file instanceof Blob)
          uploaded.push({ name: String((file as { name?: string }).name), text: await file.text() });
      }
      posts.push({ path, method, body } as any);
      if (method === 'GET' && path.endsWith('/users/@me')) return Response.json({ id: BOT });
      if (method === 'GET' && path.endsWith('/channels'))
        return Response.json([...remoteChannels.values()].filter((c) => c.type === 0));
      const messageMatch = /\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(path);
      if (method === 'PATCH' && messageMatch?.[2]) {
        if (statusEditRefused && body?.content) return Response.json({}, { status: 403 });
        const m = remoteMessages.get(messageMatch[2]);
        if (!m) return Response.json({}, { status: 404 });
        Object.assign(m, body);
        return Response.json(m);
      }
      if (method === 'GET' && messageMatch) {
        if (!messageMatch[2])
          return Response.json([...remoteMessages.values()].filter((m) => m.channel_id === messageMatch[1]));
        const m = remoteMessages.get(messageMatch[2]);
        return m ? Response.json(m) : Response.json({}, { status: 404 });
      }
      if (method === 'GET') {
        const id = path.split('/').pop()!;
        const c = remoteChannels.get(id);
        if (c) return Response.json(c);
        if (remoteMessages.has(id)) return Response.json({}, { status: 404 });
        return Response.json({ id, type: 4, guild_id: cfg.guildId });
      }
      if (method === 'POST' && path.endsWith('/channels')) {
        const result = fetchOverride
          ? await fetchOverride(url, init)
          : Response.json({ id: String(444444444444444440n + BigInt(sequence++)) });
        if (!result.ok) return result;
        const got = await result.json();
        const c = { ...body, id: got.id, guild_id: cfg.guildId };
        remoteChannels.set(c.id, c);
        return Response.json(c);
      }
      if (method === 'POST' && messageMatch && !messageMatch[2]) {
        const existing = body.nonce
          ? [...remoteMessages.values()].find((m) => m.nonce === body.nonce && m.channel_id === messageMatch[1])
          : undefined;
        if (existing) return Response.json(existing);
        const m = {
          ...body,
          id: String(555555555555555440n + BigInt(sequence++)),
          channel_id: messageMatch[1],
          author: { id: BOT },
        };
        remoteMessages.set(m.id, m);
        return Response.json(m);
      }
      const thread = /\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(path);
      if (method === 'POST' && thread) {
        const c = {
          ...body,
          id: thread[2],
          parent_id: thread[1],
          guild_id: cfg.guildId,
          type: 11,
          owner_id: BOT,
          thread_metadata: { archived: false, locked: false },
        };
        remoteChannels.set(c.id, c);
        return Response.json(c);
      }
      const id = path.split('/').pop()!;
      if (method === 'PATCH') {
        const c = remoteChannels.get(id);
        if (c) {
          Object.assign(c, body);
          if (c.thread_metadata && typeof body.archived === 'boolean') c.thread_metadata.archived = body.archived;
        }
      }
      if (method === 'DELETE') remoteChannels.delete(id);
      return Response.json({ id: '444444444444444444' });
    },
    socketFactory: () => ({ send() {}, close() {}, on() {} }),
  });
  bridges.push(bridge);
  return bridge;
}
const creations = () => posts.filter((p) => p.method === 'POST' && p.path.endsWith('/channels'));
async function readFullMap(dir: string): Promise<Record<string, string>> {
  const raw = JSON.parse(await readFile(join(dir, 'discord-case-threads.json'), 'utf8').catch(() => '{}'));
  const current = await readDiscordConfig(dir);
  return Object.fromEntries(
    Object.values(raw.entries ?? {})
      .filter((e: any) => e.phase === 'active' && e.categoryId === current.categoryId)
      .map((e: any) => [e.sessionId, e.starterId])
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-mode-'));
  sessions = [
    { id: 's1', name: 'w1-brain' },
    { id: 's2', name: 'w2-remote' },
  ];
  bridges = [];
  posts = [];
  sequence = 0;
  remoteChannels = new Map();
  remoteMessages = new Map();
  statusEditRefused = false;
  uploaded = [];
  sendInput = vi.fn(async () => true);
  await writeDiscordConfig(dir, cfg);
});
afterEach(async () => {
  for (const bridge of bridges) bridge.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('Discord interface mode', () => {
  it('shows activity in the owned thread, types only while working, and stops on disable', async () => {
    let now = 1_000;
    let waiting = false;
    sessions = [{ id: 's1', name: 'hs-lab', working: true }];
    const b = makeBridge(undefined, { now: () => now, awaitingChoice: () => waiting });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · hs-lab');
    const typing = () => posts.filter((p) => p.method === 'POST' && p.path.endsWith('/typing'));
    expect(typing().at(-1)?.path).toBe(`/api/v10/channels/${thread}/typing`);
    const count = typing().length;
    waiting = true;
    now += 30_000;
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🔴 Needs input · hs-lab');
    expect(typing()).toHaveLength(count);
    // Synchronization must not strip the activity label.
    await b.syncSessions();
    expect(remoteChannels.get(thread).name).toBe('🔴 Needs input · hs-lab');
    await writeDiscordConfig(dir, { ...cfg, enabled: false });
    await b.reload();
    waiting = false;
    now += 30_000;
    await b.pollActivity();
    expect(typing()).toHaveLength(count);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('never reopens an archived thread merely to show agent activity', async () => {
    sessions = [{ id: 's1', name: 'hs-lab', working: true }];
    const b = makeBridge();
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    remoteChannels.get(thread).thread_metadata.archived = true;
    const start = posts.length;
    await b.pollActivity();
    expect(posts.slice(start).some((p) => p.method === 'PATCH' || p.path.endsWith('/typing'))).toBe(false);
    expect(remoteChannels.get(thread).thread_metadata.archived).toBe(true);
  });

  it('groups a case into one parent with exact session-thread input and safe parent selection', async () => {
    const caseKey = 'a'.repeat(64);
    const control = vi.fn(async () => ({ text: 'Management ready' }));
    const b = makeBridge(undefined, { caseForSession: async () => ({ key: caseKey, name: 'saif' }), control });
    await b.reload();
    await b.syncSessions();
    const map = await readFullMap(dir);
    const parent = [...remoteChannels.values()].find((c) => c.type === 0)!;
    expect(creations()).toHaveLength(1);
    expect([...remoteChannels.values()].filter((c) => c.type === 11)).toHaveLength(2);
    expect(remoteChannels.get(map.s1).parent_id).toBe(parent.id);
    expect(remoteChannels.get(map.s2).parent_id).toBe(parent.id);
    const m = {
      id: '900000000000000001',
      guild_id: cfg.guildId,
      channel_id: parent.id,
      author: { id: cfg.allowedUserIds[0] },
      content: 'do this',
    };
    await b.onGatewayMessage(m);
    expect(sendInput).not.toHaveBeenCalled();
    const selection = posts.find((p) => p.body?.content?.includes('Nothing was submitted'))!;
    expect(selection.path).toContain(parent.id);
    expect(selection.body.content).toContain('<#' + map.s1 + '>');
    expect(selection.body.content).toContain('<#' + map.s2 + '>');
    await b.onGatewayMessage({ ...m, id: '900000000000000002', content: '!codeman sessions' });
    expect(control).toHaveBeenCalledExactlyOnceWith('__case__:' + caseKey, 'sessions');
    await b.onGatewayMessage({ ...m, id: '900000000000000005', content: '!codeman stream verbose' });
    await b.onGatewayMessage({ ...m, id: '900000000000000006', content: '!codeman file /work/file.txt' });
    expect(control).toHaveBeenCalledTimes(1);
    expect(posts.some((p) => p.body?.content?.includes('Open a session thread for task'))).toBe(true);

    await b.onGatewayMessage({ ...m, id: '900000000000000003', channel_id: map.s1, content: 'first' });
    await b.onGatewayMessage({ ...m, id: '900000000000000004', channel_id: map.s2, content: 'second' });
    expect(sendInput.mock.calls).toEqual([
      ['s1', 'first\r'],
      ['s2', 'second\r'],
    ]);
    sessions = sessions.filter((s) => s.id !== 's1');
    await b.sessionDeleted('s1');
    expect(remoteChannels.has(parent.id)).toBe(true);
    expect(remoteChannels.has(map.s2)).toBe(true);
    expect(remoteChannels.has(map.s1)).toBe(false);
  });
  it('keeps historical and live sibling output in their own threads within one case', async () => {
    let fresh = false;
    const history = async (id: string) => ({
      conversationId: 'native-' + id,
      partial: false,
      turns: [
        { cursor: id + ':1', role: 'assistant' as const, text: 'historical-' + id, timestamp: '' },
        ...(fresh ? [{ cursor: id + ':2', role: 'assistant' as const, text: 'live-' + id, timestamp: '' }] : []),
      ],
    });
    const b = makeBridge(undefined, { caseForSession: async () => ({ key: 'a'.repeat(64), name: 'saif' }), history });
    await b.reload();
    await b.syncSessions();
    const map = await readFullMap(dir);
    fresh = true;
    await b.pollConversations();
    for (const id of ['s1', 's2']) {
      const historyPost = posts.find((p) => p.body?.content?.includes('historical-' + id));
      const livePost = posts.find((p) => p.body?.content?.includes('live-' + id));
      expect(historyPost?.path).toContain('/' + map[id] + '/messages');
      expect(livePost?.path).toContain('/' + map[id] + '/messages');
    }
    expect(creations()).toHaveLength(1);
    expect(sendInput).not.toHaveBeenCalled();
  });
  it('preserves old per-session channels and notification maps without accepting their input or sweeping them', async () => {
    const legacyScope = JSON.stringify([cfg.guildId, cfg.parentChannelId]);
    const legacyThreads = { s1: '777777777777777777' };
    const legacy = JSON.stringify({
      parentChannelId: cfg.parentChannelId,
      threads: legacyThreads,
      scope: legacyScope,
      scopes: { [legacyScope]: legacyThreads },
    });
    await writeFile(join(dir, 'discord-bridge.json'), legacy);
    await writeFile(join(dir, 'discord-channels.json'), '{"legacy":"preserve"}');
    await writeDiscordConfig(dir, { ...cfg, staleThreads: 'delete' });
    const b = makeBridge();
    await b.reload();
    await b.syncSessions();
    await b.onGatewayMessage({
      id: '900000000000000001',
      guild_id: cfg.guildId,
      channel_id: '777777777777777777',
      author: { id: cfg.allowedUserIds[0] },
      content: 'old destination',
    });
    await b.sweepStaleThreads();
    sessions = sessions.filter((s) => s.id !== 's1');
    await b.sessionDeleted('s1');
    expect(sendInput).not.toHaveBeenCalled();
    expect(await readFile(join(dir, 'discord-bridge.json'), 'utf8')).toBe(legacy);
    expect(await readFile(join(dir, 'discord-channels.json'), 'utf8')).toBe('{"legacy":"preserve"}');
    expect(posts.some((p) => p.method === 'DELETE' && p.path.endsWith('/777777777777777777'))).toBe(false);
  });
  it.each([
    ['history', '2'],
    ['history', 'Please continue'],
    ['ownership', '2'],
    ['ownership', 'Please continue'],
  ])('refuses an ordinary reply when a dialog appears during the final %s await (%s)', async (phase, content) => {
    let waiting = false;
    let armed = false;
    let afterHistory = false;
    const history = async () => {
      if (armed) {
        afterHistory = true;
        if (phase === 'history') waiting = true;
      }
      return { conversationId: 'native1', partial: false, turns: [] };
    };
    const b = makeBridge(undefined, { history, awaitingChoice: () => waiting });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    const channels = (b as unknown as { channels: { assertOwned: (...args: unknown[]) => Promise<void> } }).channels;
    const assertOwned = channels.assertOwned.bind(channels);
    vi.spyOn(channels, 'assertOwned').mockImplementation(async (...args) => {
      await assertOwned(...args);
      if (armed && afterHistory && phase === 'ownership') waiting = true;
    });
    armed = true;
    await b.onGatewayMessage({
      id: '555555555555555555',
      guild_id: cfg.guildId,
      channel_id: thread,
      author: { id: cfg.allowedUserIds[0] },
      content,
    });
    expect(afterHistory).toBe(true);
    expect(waiting).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
    expect(posts.some((p) => p.body?.content?.includes('dialog appeared while preparing this reply'))).toBe(true);
    const deliveries = await b.recentDeliveries();
    expect(deliveries.find((d) => d.id === `in:${cfg.guildId}:555555555555555555`)?.state).toBe('failed');
  });
  it('routes a full-mode channel reply to its exact session and preserves it across mode changes', async () => {
    const b = makeBridge();
    await b.reload();
    await b.syncSessions();
    const original = await readFullMap(dir);
    await b.onGatewayMessage({
      id: '555555555555555555',
      guild_id: cfg.guildId,
      channel_id: original.s1,
      author: { id: cfg.allowedUserIds[0] },
      content: 'hello',
    });
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('s1', 'hello\r');
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    await b.reload();
    await b.onGatewayMessage({
      id: '555555555555555556',
      guild_id: cfg.guildId,
      channel_id: original.s1,
      author: { id: cfg.allowedUserIds[0] },
      content: 'old channel',
    });
    expect(sendInput).toHaveBeenCalledTimes(1);
    await writeDiscordConfig(dir, cfg);
    await b.reload();
    await b.syncSessions();
    expect(await readFullMap(dir)).toEqual(original);
    expect(creations()).toHaveLength(2);
    expect(posts.some((p) => p.method === 'DELETE')).toBe(false);
  });
  it('serves a control without typing and deduplicates repeated/unauthorized gateway messages', async () => {
    const control = vi.fn(async () => ({ text: 'Working' }));
    const b = makeBridge(undefined, { control });
    await b.reload();
    await b.syncSessions();
    const map = await readFullMap(dir);
    const message = {
      id: '555555555555555555',
      guild_id: cfg.guildId,
      channel_id: map.s1,
      author: { id: cfg.allowedUserIds[0] },
      content: '!codeman status',
    };
    await b.onGatewayMessage(message);
    await b.onGatewayMessage(message);
    await b.onGatewayMessage({ ...message, id: '555555555555555556', author: { id: '999999999999999999' } });
    expect(control).toHaveBeenCalledExactlyOnceWith('s1', 'status');
    expect(sendInput).not.toHaveBeenCalled();
    expect(posts.some((p) => p.body?.content === 'Working')).toBe(true);
  });
  it('backfills bounded historical turns once across synchronization and process restart', async () => {
    const history = vi.fn(async () => ({
      conversationId: 'native1',
      partial: false,
      turns: Array.from({ length: 20 }, (_, i) => ({
        cursor: `native1:${i}:abc`,
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        text: 'historic ' + i,
        timestamp: '2026-01-01',
      })),
    }));
    const b = makeBridge(undefined, { history });
    await b.reload();
    await b.syncSessions();
    const historical = () => posts.filter((p) => p.body?.content?.startsWith('**Historical context**'));
    expect(historical()).toHaveLength(12);
    expect(historical()[0].body?.content).toContain('historic 14');
    expect(historical().every((p) => p.body?.allowed_mentions?.parse.length === 0)).toBe(true);
    await b.syncSessions();
    expect(historical()).toHaveLength(12);
    b.stop();
    const again = makeBridge(undefined, { history });
    await again.reload();
    await again.syncSessions();
    expect(historical()).toHaveLength(12);
    expect(sendInput).not.toHaveBeenCalled();
  });
  it('keeps other session channels available when one transcript is unavailable and retries without recreating destinations', async () => {
    let offline = true;
    const history = vi.fn(async (id: string) => {
      if (id === 's1' && offline) throw new Error('offline');
      return { conversationId: 'native1', partial: false, turns: [] };
    });
    const b = makeBridge(undefined, { history });
    await b.reload();
    await b.syncSessions();
    expect(creations()).toHaveLength(2);
    expect(b.sessionSync.failed).toBeGreaterThan(0);
    offline = false;
    await b.syncSessions();
    expect(creations()).toHaveLength(2);
    expect(b.sessionSync.state).toBe('complete');
  });
  it('streams new native responses once, edits task status and retains the boundary across restart', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    let state: 'running' | 'completed' = 'running';
    const history = async () => ({
      conversationId: 'native1',
      partial: false,
      turns,
      executions: turns.length ? [{ userCursor: turns[0].cursor, promptHash: 'a'.repeat(64), state }] : [],
    });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    turns = [
      { cursor: 'native1:1:abc', role: 'user', text: 'question', timestamp: 't' },
      { cursor: 'native1:2:abc', role: 'assistant', text: 'fresh answer', timestamp: 't' },
    ];
    await b.pollConversations();
    const answers = () => posts.filter((p) => p.body?.content?.includes('fresh answer'));
    expect(answers()).toHaveLength(1);
    expect(posts.some((p) => p.body?.content === '⏳ Working…')).toBe(true);
    now += 60001;
    state = 'completed';
    await b.pollConversations();
    expect(answers()).toHaveLength(1);
    expect(posts.some((p) => p.method === 'PATCH' && p.body?.content === '✅ Done')).toBe(true);
    b.stop();
    const again = makeBridge(undefined, { history, now: () => now });
    await again.reload();
    await again.syncSessions();
    await again.pollConversations();
    expect(answers()).toHaveLength(1);
    expect(sendInput).not.toHaveBeenCalled();
  });
  it('posts clean live Markdown once across idle/stop events, polling and restart', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    sessions = [{ id: 's1', name: 'one' }];
    const history = async () => ({ conversationId: 'native1', partial: false, turns });
    const fullText = vi.fn(async () => ({ text: '**Answer**\n- One\n- Two' }));
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    turns = [
      { cursor: 'native1:1', role: 'assistant', text: '**Answer**\n- One\n- Two', timestamp: '2026-11-06T00:00:00Z' },
    ];
    const msg = {
      sessionId: 's1',
      sessionName: 'one',
      host: 'codeman:host',
      event: 'hook:idle_prompt',
      title: 'Waiting for Input',
      body: '[one]',
      urgency: 'warning' as const,
      fullText,
    };
    await Promise.all([b.notify(msg), b.pollConversations()]);
    now += 60001;
    await b.notify({ ...msg, event: 'hook:stop', urgency: 'info' });
    expect(posts.filter((p) => p.body?.content?.includes('**Answer**'))).toHaveLength(1);
    expect(posts.find((p) => p.body?.content?.includes('**Answer**'))?.body.content).toBe('**Answer**\n- One\n- Two');
    expect(
      posts.some((p) => p.body?.content?.includes('Waiting for Input') || p.body?.content?.includes('2026-11-06T'))
    ).toBe(false);
    expect(fullText).not.toHaveBeenCalled();
    b.stop();
    const again = makeBridge(undefined, { history, now: () => now });
    await again.reload();
    await again.syncSessions();
    await again.notify(msg);
    expect(posts.filter((p) => p.body?.content?.includes('**Answer**'))).toHaveLength(1);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'off'] as const)(
    'retains automatic alert fallback when the native stream is %s',
    async (state) => {
      let offline = false;
      const history = async () => {
        if (offline) throw new Error('offline');
        return {
          conversationId: 'native1',
          partial: false,
          turns: [{ cursor: 'native1:1', role: 'assistant' as const, text: 'old', timestamp: '' }],
        };
      };
      sessions = [{ id: 's1', name: 'one' }];
      const b = makeBridge(undefined, { history });
      await b.reload();
      await b.syncSessions();
      if (state === 'off')
        await b.onGatewayMessage({
          id: '900000000000000001',
          guild_id: cfg.guildId,
          channel_id: (await readFullMap(dir)).s1,
          author: { id: cfg.allowedUserIds[0] },
          content: '!codeman stream off',
        });
      else offline = true;
      const r = await b.notify({
        sessionId: 's1',
        event: 'hook:idle_prompt',
        title: 'Waiting for Input',
        body: 'fallback',
        urgency: 'warning',
        fullText: async () => ({ text: 'fallback answer' }),
      });
      expect(r?.ok).toBe(true);
      expect(
        posts.some(
          (p) => p.body?.content?.includes('Waiting for Input') && p.body?.content?.includes('fallback answer')
        )
      ).toBe(true);
    }
  );

  it('preserves actual questions, errors and deliberate posts even when their text is in the native stream', async () => {
    sessions = [{ id: 's1', name: 'one' }];
    const history = async () => ({ conversationId: 'native1', partial: false, turns: [] });
    const b = makeBridge(undefined, { history, awaitingChoice: () => true });
    await b.reload();
    await b.syncSessions();
    for (const event of ['hook:elicitation_dialog', 'hook:permission_prompt', 'session:error'])
      await b.notify({ sessionId: 's1', event, title: event, body: 'Needs attention', urgency: 'critical' });
    await b.notify(
      {
        sessionId: 's1',
        event: 'hook:idle_prompt',
        title: 'Explicit message',
        body: 'agent asked to send this',
        urgency: 'warning',
      },
      { deliberate: true }
    );
    for (const label of ['hook:elicitation_dialog', 'hook:permission_prompt', 'session:error', 'Explicit message'])
      expect(posts.some((p) => p.body?.content?.includes(label))).toBe(true);
  });

  it('reuses one editable status across tasks and recreates only a deleted status message', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    let state: 'running' | 'completed' = 'running';
    const history = async () => ({
      conversationId: 'native1',
      partial: false,
      turns,
      executions: turns.length ? [{ userCursor: turns.at(-1)!.cursor, promptHash: 'a'.repeat(64), state }] : [],
    });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    turns = [{ cursor: 'native1:1', role: 'user', text: 'first', timestamp: '' }];
    await b.pollConversations();
    const statusPost = posts.find((p) => p.method === 'POST' && p.body?.content === '⏳ Working…')!;
    const message = [...remoteMessages.values()].find((m) => m.content === '⏳ Working…')!;
    now += 60001;
    state = 'completed';
    await b.pollConversations();
    expect(
      posts.filter((p) => p.method === 'POST' && ['⏳ Working…', '✅ Done'].includes(p.body?.content))
    ).toHaveLength(1);
    expect(
      posts.some((p) => p.method === 'PATCH' && p.path.endsWith('/' + message.id) && p.body?.content === '✅ Done')
    ).toBe(true);
    now += 60001;
    state = 'running';
    turns.push({ cursor: 'native1:2', role: 'user', text: 'second', timestamp: '' });
    await b.pollConversations();
    expect(posts.filter((p) => p.method === 'POST' && p.body?.content === '⏳ Working…')).toHaveLength(1);
    remoteMessages.delete(message.id);
    now += 60001;
    state = 'completed';
    await b.pollConversations();
    expect(posts.filter((p) => p.method === 'POST' && p.body?.content === '✅ Done')).toHaveLength(1);
    expect(statusPost.path).toContain('/messages');
  });

  it('never replays a delivered response because a cosmetic status edit failed', async () => {
    let now = 100000;
    let state: 'running' | 'completed' = 'running';
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    const history = async () => ({
      conversationId: 'native1',
      partial: false,
      turns,
      executions: turns.length ? [{ userCursor: turns[0].cursor, promptHash: 'a'.repeat(64), state }] : [],
    });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    turns = [{ cursor: 'native1:1', role: 'user', text: 'question', timestamp: '' }];
    await b.pollConversations();
    now += 60001;
    state = 'completed';
    statusEditRefused = true;
    turns.push({ cursor: 'native1:2', role: 'assistant', text: 'Delivered once', timestamp: '' });
    await b.notify({
      sessionId: 's1',
      event: 'hook:idle_prompt',
      title: 'Waiting for Input',
      body: 'one',
      urgency: 'warning',
      fullText: async () => ({ text: 'Delivered once' }),
    });
    expect(posts.filter((p) => p.method === 'POST' && p.body?.content?.includes('Delivered once'))).toHaveLength(1);
    expect(posts.some((p) => p.body?.content?.includes('Waiting for Input'))).toBe(false);
    statusEditRefused = false;
    now += 60001;
    await b.pollConversations();
    expect(posts.some((p) => p.method === 'PATCH' && p.body?.content === '✅ Done')).toBe(true);
    expect(posts.filter((p) => p.method === 'POST' && p.body?.content?.includes('Delivered once'))).toHaveLength(1);
  });

  it('filters internal citations before live splitting and consumes metadata-only cursors without empty posts', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    const metadata =
      '<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[private]\n</citation_entries>\n</oai-mem-citation>';
    const history = async () => ({ conversationId: 'native1', partial: false, turns });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    turns = [
      { cursor: 'native1:1', role: 'assistant', text: 'Clean answer\n\n' + metadata, timestamp: '' },
      { cursor: 'native1:2', role: 'assistant', text: metadata, timestamp: '' },
    ];
    await b.pollConversations();
    expect(posts.filter((p) => p.body?.content === 'Clean answer')).toHaveLength(1);
    expect(posts.some((p) => p.body?.content?.includes('MEMORY.md') || p.body?.content?.includes('<oai-mem'))).toBe(
      false
    );
    now += 60001;
    turns.push({ cursor: 'native1:3', role: 'assistant', text: 'Next answer', timestamp: '' });
    await b.pollConversations();
    expect(posts.filter((p) => p.body?.content === 'Next answer')).toHaveLength(1);
    expect(posts.filter((p) => p.body?.content === 'Clean answer')).toHaveLength(1);
    b.stop();
    const again = makeBridge(undefined, { history, now: () => now });
    await again.reload();
    await again.syncSessions();
    await again.pollConversations();
    expect(posts.filter((p) => p.body?.content === 'Clean answer')).toHaveLength(1);
  });

  it('omits metadata-only historical turns while retaining visible historical context', async () => {
    const metadata = '<oai-mem-citation>private</oai-mem-citation>';
    const history = async () => ({
      conversationId: 'native1',
      partial: false,
      turns: [
        { cursor: 'native1:1', role: 'assistant' as const, text: metadata, timestamp: '' },
        { cursor: 'native1:2', role: 'assistant' as const, text: 'History answer\n' + metadata, timestamp: '' },
      ],
    });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history });
    await b.reload();
    await b.syncSessions();
    const contexts = posts.filter((p) => p.body?.content?.includes('**Historical context**'));
    expect(contexts).toHaveLength(1);
    expect(contexts[0].body.content).toContain('History answer');
    expect(contexts[0].body.content).not.toContain('oai-mem');
  });

  it('filters internal metadata from full-text alert fallback when native history is unavailable', async () => {
    const metadata = '<oai-mem-citation>\nprivate-footer\n</oai-mem-citation>';
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, {
      history: async () => {
        throw new Error('unavailable');
      },
    });
    await b.reload();
    await b.syncSessions();
    const result = await b.notify({
      sessionId: 's1',
      event: 'hook:idle_prompt',
      title: 'Waiting for Input',
      body: 'fallback',
      urgency: 'warning',
      fullText: async () => ({ text: 'Visible fallback answer\n' + metadata }),
    });
    expect(result?.ok).toBe(true);
    expect(posts.some((p) => p.body?.content?.includes('Visible fallback answer'))).toBe(true);
    expect(
      posts.some((p) => p.body?.content?.includes('private-footer') || p.body?.content?.includes('<oai-mem'))
    ).toBe(false);
  });

  it('formats tables consistently in historical context, live replies and history controls', async () => {
    const table = (name: string) =>
      '| Item | Status |\n|---|---|\n| ' +
      name +
      ' | Long status with **formatting** and [details](https://example.test). |';
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [
      { cursor: 'native1:1', role: 'assistant', text: table('Historical'), timestamp: '' },
    ];
    const history = async () => ({ conversationId: 'native1', partial: false, turns });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history, control: async () => ({ text: table('Requested history') }) });
    await b.reload();
    await b.syncSessions();
    const past = posts.find((p) => p.body?.content?.includes('**Historical context**'));
    expect(past?.body.content).toContain('**Item:** Historical');
    expect(past?.body.content).toContain('**Status:** Long status');
    expect(past?.body.content).not.toContain('```');
    turns.push({ cursor: 'native1:2', role: 'assistant', text: table('Live'), timestamp: '' });
    await b.pollConversations();
    const live = posts.find((p) => p.body?.content?.includes('**Item:** Live'));
    expect(live?.body.content).toContain('[details](https://example.test)');
    expect(live?.body.content).not.toContain('|---');
    await b.onGatewayMessage({
      id: '900000000000000001',
      guild_id: cfg.guildId,
      channel_id: (await readFullMap(dir)).s1,
      author: { id: cfg.allowedUserIds[0] },
      content: '!codeman history',
    });
    expect(posts.some((p) => p.body?.content?.includes('**Item:** Requested history'))).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('attaches the full response when labeled table expansion exceeds the chat budget', async () => {
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    const history = async () => ({ conversationId: 'native1', partial: false, turns });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history });
    await b.reload();
    await b.syncSessions();
    const table = [
      '| A descriptive first label | A descriptive second label |',
      '|---|---|',
      ...Array.from({ length: 200 }, (_, i) => `| row${i}value | statevalue |`),
    ].join('\n');
    expect(table.length).toBeLessThan(12000);
    turns.push({ cursor: 'native1:1', role: 'assistant', text: table, timestamp: '' });
    await b.pollConversations();
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toEqual({ name: 'response.txt', text: table });
  });

  it('binds component clicks to the prompt, message, channel and allowlisted user and consumes once', async () => {
    const control = vi.fn(async (_id: string, command: string) =>
      command === 'pending'
        ? {
            text: 'Choose one',
            actions: [{ label: 'Allow once', command: 'answer current revision 1', validity: 'current' }],
          }
        : { text: 'Answered' }
    );
    const b = makeBridge(undefined, { control, controlCurrent: () => true });
    await b.reload();
    await b.syncSessions();
    const map = await readFullMap(dir);
    await b.onGatewayMessage({
      id: '555555555555555555',
      guild_id: cfg.guildId,
      channel_id: map.s1,
      author: { id: cfg.allowedUserIds[0] },
      content: '!codeman pending',
    });
    const posted = posts.find((p) => p.body?.components?.length)!;
    const custom_id = posted.body!.components[0].components[0].custom_id;
    const click = {
      id: '777777777777777777',
      application_id: '888888888888888888',
      token: 'opaque+/=test',
      type: 3,
      guild_id: cfg.guildId,
      channel_id: map.s1,
      member: { user: { id: cfg.allowedUserIds[0] } },
      message: { id: [...remoteMessages.values()].findLast((m) => m.components?.length)?.id },
      data: { custom_id },
    };
    await b.onGatewayInteraction({ ...click, member: { user: { id: '999999999999999999' } } });
    expect(control).toHaveBeenCalledTimes(1);
    await b.onGatewayInteraction(click);
    await b.onGatewayInteraction(click);
    expect(control).toHaveBeenCalledTimes(2);
    expect(control).toHaveBeenLastCalledWith('s1', 'answer current revision 1');
    expect(posts.some((p) => p.path.includes('/opaque%2B%2F%3Dtest/callback'))).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });
  it.each(['off', 'critical'] as const)(
    'respects %s ping policy on prompt buttons and refuses an unbound digit',
    async (pingMode) => {
      await writeDiscordConfig(dir, { ...cfg, pingMode });
      const control = async () => ({
        text: 'Which option?',
        actions: [{ label: 'One', command: 'answer prompt revision 1', validity: 'prompt' }],
      });
      const b = makeBridge(undefined, { control, controlCurrent: () => true, awaitingChoice: () => true });
      await b.reload();
      await b.syncSessions();
      const map = await readFullMap(dir);
      await b.notify({
        sessionId: 's1',
        sessionName: 'one',
        event: 'question',
        title: 'Question',
        body: 'Choose',
        urgency: 'critical',
      });
      const prompt = posts.find((p) => p.body?.components?.length && p.body?.content?.endsWith('Which option?'));
      expect(prompt).toBeDefined();
      expect(prompt!.body!.allowed_mentions.users).toEqual(pingMode === 'critical' ? cfg.allowedUserIds : []);
      await b.onGatewayMessage({
        id: '555555555555555555',
        guild_id: cfg.guildId,
        channel_id: map.s1,
        author: { id: cfg.allowedUserIds[0] },
        content: '1',
      });
      expect(sendInput).not.toHaveBeenCalled();
      expect(posts.some((p) => p.body?.content?.includes('prompt-bound answer'))).toBe(true);
    }
  );
  it('accepts management commands only in the configured control channel when no sessions exist', async () => {
    sessions = [];
    const control = vi.fn(async () => ({ text: 'Management ready' }));
    const b = makeBridge(undefined, { control });
    await b.reload();
    await b.syncSessions();
    const m = {
      id: '555555555555555555',
      guild_id: cfg.guildId,
      channel_id: cfg.parentChannelId,
      author: { id: cfg.allowedUserIds[0] },
      content: '!codeman help',
    };
    await b.onGatewayMessage({ ...m, content: 'ordinary chat' });
    await b.onGatewayMessage({ ...m, channel_id: '999999999999999999' });
    expect(control).not.toHaveBeenCalled();
    await b.onGatewayMessage(m);
    expect(control).toHaveBeenCalledExactlyOnceWith('__management__', 'help');
    expect(sendInput).not.toHaveBeenCalled();
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    await b.reload();
    await b.onGatewayMessage({ ...m, id: '555555555555555556' });
    expect(control).toHaveBeenCalledTimes(1);
  });
  it('caps remote history reads without blocking live output from local sessions', async () => {
    let slow = false,
      remoteReads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    sessions = [{ id: 'r1', remote: true }, { id: 'r2', remote: true }, { id: 'r3', remote: true }, { id: 'local' }];
    const history = async (id: string) => {
      if (slow && id.startsWith('r')) {
        remoteReads++;
        await gate;
      }
      return {
        conversationId: 'native1',
        partial: false,
        turns:
          slow && id === 'local'
            ? [{ cursor: 'native1:1:abc', role: 'assistant' as const, text: 'local live answer', timestamp: '' }]
            : [],
      };
    };
    const b = makeBridge(undefined, { history });
    await b.reload();
    await b.syncSessions();
    slow = true;
    const poll = b.pollConversations();
    try {
      await vi.waitFor(() => expect(posts.some((p) => p.body?.content?.includes('local live answer'))).toBe(true));
      expect(remoteReads).toBe(2);
    } finally {
      release();
      await poll;
    }
  });
  it('defaults legacy and unknown config values to notifications', async () => {
    for (const mode of [undefined, 'unknown', null]) {
      await writeFile(discordConfigPath(dir), JSON.stringify({ enabled: false, mode }));
      expect((await readDiscordConfig(dir)).mode).toBe('notifications');
    }
  });

  it('leaves legacy lazy notification discovery unchanged', async () => {
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    const bridge = makeBridge();
    await bridge.reload();
    await bridge.syncSessions();
    await bridge.sessionCreated('s3', 'new');
    expect(creations()).toHaveLength(0);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('discovers existing sessions without a notification and coalesces concurrent sync', async () => {
    const bridge = makeBridge();
    await bridge.reload();
    const first = bridge.syncSessions();
    expect(bridge.syncSessions()).toBe(first);
    expect(await first).toEqual({ state: 'complete', total: 2, ready: 2, failed: 0 });
    expect(creations()).toHaveLength(2);
    expect(Object.keys(await readFullMap(dir))).toEqual(['s1', 's2']);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('creates new session threads immediately even when legacy creation is lazy', async () => {
    const bridge = makeBridge();
    await bridge.reload();
    await bridge.syncSessions();
    sessions.push({ id: 's3', name: 'new' });
    await Promise.all([bridge.sessionCreated('s3', 'new'), bridge.sessionCreated('s3', 'new')]);
    expect(creations()).toHaveLength(3);
  });

  it('does not discover or create restored sessions until boot hold is released', async () => {
    const bridge = makeBridge();
    bridge.hold();
    await bridge.reload();
    await bridge.sessionCreated('s1', 'w1-brain');
    await bridge.syncSessions();
    expect(creations()).toHaveLength(0);
    await bridge.release();
    await bridge.syncSessions();
    expect(creations()).toHaveLength(2);
  });

  it('preserves thread mappings across restart and switching back to notifications', async () => {
    const bridge = makeBridge();
    await bridge.reload();
    await bridge.syncSessions();
    const before = await readFullMap(dir);
    bridge.stop();
    const restarted = makeBridge();
    await restarted.reload();
    await restarted.syncSessions();
    expect(creations()).toHaveLength(2);
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    await restarted.reload();
    expect(await readFullMap(dir)).toEqual(before);
    expect(posts.some((p) => p.method === 'DELETE')).toBe(false);
  });

  it('does nothing while disabled even when full mode is saved', async () => {
    await writeDiscordConfig(dir, { ...cfg, enabled: false });
    const bridge = makeBridge();
    await bridge.reload();
    await bridge.syncSessions();
    await bridge.sessionCreated('s3', 'new');
    expect(posts).toHaveLength(0);
  });

  it('reports failures and retries only missing destinations', async () => {
    let rejectSecond = true;
    const bridge = makeBridge(async (url, init) => {
      if (creations().length === 2 && rejectSecond) return Response.json({}, { status: 403 });
      return Response.json({ id: String(444444444444444440n + BigInt(sequence++)) });
    });
    await bridge.reload();
    expect(await bridge.syncSessions()).toMatchObject({ state: 'error', ready: 1, failed: 1 });
    rejectSecond = false;
    expect(await bridge.syncSessions()).toMatchObject({ state: 'complete', ready: 2, failed: 0 });
    expect(creations()).toHaveLength(3);
  });

  it('skips a tab deleted while the previous destination was being created', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = makeBridge(async (url, init) => {
      await pending;
      return Response.json({ id: '444444444444444444' });
    });
    await bridge.reload();
    const sync = bridge.syncSessions();
    await vi.waitFor(() => expect(creations()).toHaveLength(1));
    sessions = sessions.filter((s) => s.id !== 's2');
    await bridge.sessionDeleted('s2');
    release();
    await sync;
    expect(creations()).toHaveLength(1);
    expect(await readFullMap(dir)).not.toHaveProperty('s2');
  });

  it('does not recreate a tab deleted while its own destination is pending', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessions = sessions.slice(0, 1);
    const bridge = makeBridge(async (url, init) => {
      if (url.pathname.endsWith('/channels')) await pending;
      return Response.json({ id: '444444444444444444' });
    });
    await bridge.reload();
    const sync = bridge.syncSessions();
    await vi.waitFor(() => expect(creations()).toHaveLength(1));
    sessions = [];
    await bridge.sessionDeleted('s1');
    release();
    await sync;
    expect(await readFullMap(dir)).toEqual({});
    expect(posts.some((p) => p.method === 'DELETE')).toBe(false);
    expect([...remoteChannels.values()].filter((c) => c.type === 11)).toHaveLength(0);
  });

  it('stops discovery after switching back to Notifications during a request', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = makeBridge(async (url, init) => {
      await pending;
      return Response.json({ id: '444444444444444444' });
    });
    await bridge.reload();
    const sync = bridge.syncSessions();
    await vi.waitFor(() => expect(creations()).toHaveLength(1));
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    await bridge.reload();
    release();
    expect(await sync).toMatchObject({ state: 'idle' });
    expect(creations()).toHaveLength(1);
    expect(posts.some((p) => p.method === 'DELETE')).toBe(false);
  });

  it('queues a new discovery pass when the parent changes during creation', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = makeBridge(async (url, init) => {
      if (JSON.parse(String(init.body)).parent_id === cfg.categoryId) await pending;
      return Response.json({ id: String(444444444444444440n + BigInt(sequence++)) });
    });
    await bridge.reload();
    const first = bridge.syncSessions();
    await vi.waitFor(() => expect(creations()).toHaveLength(1));
    const newParent = '777777777777777777';
    await writeDiscordConfig(dir, { ...cfg, categoryId: newParent });
    await bridge.reload();
    release();
    await first;
    await vi.waitFor(() => expect(bridge.sessionSync).toMatchObject({ state: 'complete', ready: 2 }));
    expect(creations().filter((p) => p.body?.parent_id === newParent)).toHaveLength(2);
    expect(Object.keys(await readFullMap(dir))).toEqual(['s1', 's2']);
  });
});
