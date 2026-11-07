/** Full-interface discovery uses fake Discord only; never attaches to or submits work to a session. */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashDiscordPrompt } from '../src/discord-native-execution.js';
import { readDiscordSessionFile } from '../src/discord-file-transfers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discordUiNodes } from '../src/discord-native-ui.js';
import { DISCORD_SUPPRESS_NOTIFICATIONS } from '../src/discord-response-format.js';
import { DiscordHistoryReadError } from '../src/discord-history.js';
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
  onSessionDelete: 'delete' as const,
  token: 'fake-test-token',
  guildId: '111111111111111111',
  parentChannelId: '222222222222222222',
  allowedUserIds: ['333333333333333333'],
};
let dir: string;
let sessions: Array<import('../src/discord-activity.js').DiscordActivitySession & { remote?: boolean }>;
let bridges: DiscordBridge[];
let posts: Array<{ path: string; method: string; body?: any }>;
let sendInput: ReturnType<typeof vi.fn>;
let sequence: number;
let remoteChannels: Map<string, any>;
let remoteMessages: Map<string, any>;
let statusEditRefused: boolean;
let activityRenameRetryAfter: number | undefined;
let uncertainText: string | undefined;
let artifactPostRefused: boolean;

let uploaded: Array<{ name: string; text: string }>;
/** Assert what a reader sees, across plain text and native response cards. */
const visibleText = (body: any): string | undefined =>
  body?.embeds?.map((embed: any) => embed.description).join('\n') ||
  body?.components
    ?.flatMap((c: any) =>
      c.type === 17
        ? (c.components ?? []).filter(
            (n: any, i: number) => i !== 0 || !/^\*\*[^\n*]+\*\*(?:\n-# [^\n]*)?$/.test(n.content ?? '')
          )
        : [c]
    )
    .filter((c: any) => c.type === 10)
    .map((c: any) => c.content?.replace(/^-# /, ''))
    .join('\n') ||
  body?.content;
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
        for (const [key, file] of init.body.entries())
          if (key.startsWith('files[') && file instanceof Blob)
            uploaded.push({ name: String((file as { name?: string }).name), text: await file.text() });
      }
      posts.push({ path, method, body } as any);
      if (artifactPostRefused && method === 'POST' && init.body instanceof FormData)
        return Response.json({}, { status: 403 });
      if (/\/applications\/.*\/commands$/.test(path)) {
        if (method === 'GET') return Response.json([]);
        return Response.json({ ...body, id: body.name === 'codex' ? '777777777777777771' : '777777777777777772' });
      }
      if (method === 'GET' && path.endsWith('/users/@me')) return Response.json({ id: BOT });
      if (method === 'GET' && path.endsWith('/channels'))
        return Response.json([...remoteChannels.values()].filter((c) => c.type === 0));
      const messageMatch = /\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(path);
      if (method === 'PATCH' && messageMatch?.[2]) {
        if (statusEditRefused && (body?.content || (body?.flags & 32768) !== 0))
          return Response.json({}, { status: 403 });
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
        if (uncertainText && visibleText(body)?.includes(uncertainText)) throw new TypeError('lost response');
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
        if (body?.name && activityRenameRetryAfter)
          return Response.json({ retry_after: activityRenameRetryAfter }, { status: 429 });
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
  uncertainText = undefined;
  statusEditRefused = false;
  activityRenameRetryAfter = undefined;
  artifactPostRefused = false;
  activityRenameRetryAfter = undefined;
  uploaded = [];
  sendInput = vi.fn(async () => true);
  await writeDiscordConfig(dir, cfg);
});
afterEach(async () => {
  for (const bridge of bridges) bridge.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('Discord interface mode', () => {
  it('reacts to a native session update even when the thread name did not change', async () => {
    let now = 1_000;
    sessions = [{ id: 's1', name: 'hs-lab', working: false }];
    const b = makeBridge(undefined, { now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    await b.sessionRenamed('s1', 'hs-lab');
    await b.pollActivity();
    sessions[0].working = true;
    now += 100;
    await b.sessionRenamed('s1', 'hs-lab');
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · hs-lab');
    expect(posts.some((p) => p.path.endsWith('/typing'))).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps typing when an existing Idle thread cannot be renamed yet, without inline retries', async () => {
    let now = 1_000;
    sessions = [{ id: 's1', name: 'hs-lab', working: false }];
    const b = makeBridge(undefined, { now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    const titleEdits = () => posts.filter((p) => p.method === 'PATCH' && p.path.endsWith('/' + thread) && p.body?.name);
    const typing = () => posts.filter((p) => p.method === 'POST' && p.path.endsWith('/typing'));
    await b.pollActivity();
    expect(titleEdits()).toHaveLength(0);
    expect(typing()).toHaveLength(0);
    sessions[0].working = true;
    activityRenameRetryAfter = 120;
    now += 4_000;
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('⚫ Idle · hs-lab');
    expect(typing()).toHaveLength(1);
    expect(titleEdits()).toHaveLength(1);
    now += 8_000;
    await b.pollActivity();
    expect(typing()).toHaveLength(2);
    expect(titleEdits()).toHaveLength(1);
    activityRenameRetryAfter = undefined;
    now += 120_000;
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · hs-lab');
    expect(titleEdits()).toHaveLength(2);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('repairs a stale Idle title after a concurrent request overwrites its published Working title', async () => {
    let now = 1_000;
    sessions = [{ id: 's1', name: 'hs-lab', working: true }];
    const b = makeBridge(undefined, { now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    await b.pollActivity();
    remoteChannels.get(thread).name = '⚫ Idle · hs-lab';
    now += 8_000;
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · hs-lab');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps unresolved history warnings through journal pruning/restart and edits them after recovery', async () => {
    let readable = false;
    let now = 100000;
    const history = async (_id: string, options?: { after?: string }) => {
      if (!readable) throw new Error('unbound');
      return {
        conversationId: 'native1',
        partial: false,
        verifiedAfter: options?.after,
        turns: [{ cursor: 'native1:answer', role: 'assistant' as const, text: 'Recovered result', timestamp: '' }],
      };
    };
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    const warnings = () =>
      posts.filter((p) => p.method === 'POST' && p.body?.content?.startsWith('History is unavailable'));
    expect(warnings()).toHaveLength(1);
    b.stop();
    const ledger = JSON.parse(await readFile(join(dir, 'discord-delivery.json'), 'utf8'));
    await writeFile(
      join(dir, 'discord-delivery.json'),
      JSON.stringify(ledger.filter((r: { direction: string }) => r.direction === 'inbound'))
    );
    const again = makeBridge(undefined, { history, now: () => now });
    await again.reload();
    await again.syncSessions();
    expect(warnings()).toHaveLength(1);
    readable = true;
    now += 20000;
    await again.syncSessions();
    await again.pollConversations();
    expect(
      [...remoteMessages.values()].some((m) => m.content === 'History reconnected. Live replies are synchronized.')
    ).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'discord-history-warnings.json'), 'utf8'))).toEqual([]);
    readable = false;
    now += 20000;
    await again.notify({
      sessionId: 's1',
      event: 'hook:idle_prompt',
      title: 'Waiting for Input',
      body: 'idle',
      urgency: 'warning',
      fullText: async () => {
        throw new Error('temporary read failure');
      },
    });
    expect(
      [...remoteMessages.values()].some((m) =>
        JSON.stringify(m.components ?? []).includes('**Reconnecting to this conversation**')
      )
    ).toBe(true);
    readable = true;
    now += 20000;
    await again.syncSessions();
    await again.pollConversations();
    expect(
      [...remoteMessages.values()].some((m) =>
        JSON.stringify(m.components ?? []).includes('**Reconnecting to this conversation**')
      )
    ).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'discord-history-warnings.json'), 'utf8'))).toEqual([]);
  });

  it('recovers a saved boundary outside the tail through a tool-only page, restart and warning cleanup', async () => {
    let now = 100000;
    let appended = false;
    sessions = [{ id: 's1', name: 'one' }];
    const history = vi.fn(async (_id: string, options?: { after?: string }) => {
      if (!options?.after)
        return {
          conversationId: 'native1',
          partial: appended,
          turns: [
            {
              cursor: appended ? 'native1:answer' : 'native1:old',
              role: 'assistant' as const,
              text: appended ? 'Recovered answer' : 'Already delivered',
              timestamp: '',
            },
          ],
        };
      if (options.after === 'native1:old')
        return {
          conversationId: 'native1',
          partial: true,
          turns: [],
          verifiedAfter: options.after,
          scannedCursor: 'native1:tool',
          hasMore: true,
        };
      if (options.after === 'native1:tool')
        return {
          conversationId: 'native1',
          partial: true,
          turns: [{ cursor: 'native1:answer', role: 'assistant' as const, text: 'Recovered answer', timestamp: '' }],
          verifiedAfter: options.after,
          scannedCursor: 'native1:end',
          hasMore: false,
        };
      return {
        conversationId: 'native1',
        partial: true,
        turns: [],
        verifiedAfter: options.after,
        scannedCursor: options.after,
        hasMore: false,
      };
    });
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    const warning =
      'History is unavailable or partial. Use !codeman history to retry; this session channel remains available.';
    const botWarning = '988888888888888881',
      userWarning = '988888888888888882';
    remoteMessages.set(botWarning, { id: botWarning, channel_id: thread, content: warning, author: { id: BOT } });
    remoteMessages.set(userWarning, {
      id: userWarning,
      channel_id: thread,
      content: warning,
      author: { id: cfg.allowedUserIds[0] },
    });
    const reconnect = '988888888888888883';
    remoteMessages.set(reconnect, {
      id: reconnect,
      channel_id: thread,
      author: { id: BOT },
      components: [
        { type: 17, components: [{ type: 10, content: '**Reconnecting to this conversation**' }] },
        {
          type: 10,
          content: 'Your response is available in Codeman. I’m restoring the connection so replies can appear here.',
        },
      ],
    });
    appended = true;
    await b.pollConversations();
    expect(history).toHaveBeenCalledWith('s1', expect.objectContaining({ after: 'native1:old' }));
    const stored = JSON.parse(await readFile(join(dir, 'discord-conversations.json'), 'utf8'));
    expect(stored.some(([, p]: any) => p.cursor === 'native1:tool')).toBe(true);
    expect(remoteMessages.get(botWarning).content).toBe(warning);
    b.stop();
    const again = makeBridge(undefined, { history, now: () => now });
    await again.reload();
    await again.syncSessions();
    await again.pollConversations();
    expect(history).toHaveBeenCalledWith('s1', expect.objectContaining({ after: 'native1:tool' }));
    const responses = () =>
      posts.filter((p) => visibleText(p.body)?.includes('Recovered answer') && p.method === 'POST');
    expect(responses()).toHaveLength(1);
    expect(remoteMessages.get(botWarning).content).toBe('History reconnected. Live replies are synchronized.');
    expect(remoteMessages.get(userWarning).content).toBe(warning);
    expect(remoteMessages.get(reconnect).components[0].components[0].content).toBe('**Conversation reconnected**');
    now += 20000;
    await again.pollConversations();
    expect(responses()).toHaveLength(1);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps background work under Working over sync and restart (remote=%s)', async (remote) => {
    let now = 100000;
    sessions = [
      { id: 's1', name: 'w29-buildmesh', remote, working: false, watching: '1 shell', activityStatus: 'idle' },
    ];
    const b = makeBridge(undefined, { now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · w29-buildmesh');
    await b.pollActivity();
    const typing = () => posts.filter((p) => p.path.endsWith('/typing'));
    expect(typing()).toHaveLength(1);
    await b.syncSessions();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · w29-buildmesh');
    b.stop();
    const restarted = makeBridge(undefined, { now: () => now });
    await restarted.reload();
    await restarted.syncSessions();
    await restarted.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · w29-buildmesh');
    sessions[0].watching = null;
    now += 4000;
    await restarted.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · w29-buildmesh');
    now += 30000;
    await restarted.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('⚫ Idle · w29-buildmesh');
    expect(typing()).toHaveLength(2);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('groups explicit output files beneath a new response and does not repeat uploads after replay/restart', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    sessions = [{ id: 's1', name: 'one' }];
    await writeFile(join(dir, 'mockup.png'), 'image-bytes');
    await writeFile(join(dir, 'report.pdf'), 'pdf-bytes');
    const history = async () => ({ conversationId: 'native1', partial: false, turns });
    const getAttachment = vi.fn(async (_id: string, path: string, relative?: boolean) => {
      expect(relative).toBe(true);
      return readDiscordSessionFile({ workingDir: dir }, resolve(dir, path));
    });
    const b = makeBridge(undefined, { history, getAttachment, now: () => now });
    await b.reload();
    await b.syncSessions();
    turns = [
      { cursor: 'native1:1', role: 'user', text: 'Make the files', timestamp: '' },
      {
        cursor: 'native1:2',
        role: 'assistant',
        text: 'Done.\n![Mockup](./mockup.png)\n[Report](./report.pdf)\n[source](./app.ts)',
        timestamp: '',
      },
    ];
    await b.pollConversations();
    expect(uploaded).toEqual([
      { name: 'mockup.png', text: 'image-bytes' },
      { name: 'report.pdf', text: 'pdf-bytes' },
    ]);
    const attachments = posts.filter((p) => p.body?.content === 'Files from this response');
    expect(attachments).toHaveLength(1);
    expect(attachments[0].body?.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(getAttachment).toHaveBeenCalledTimes(2);
    const before = posts.findIndex((p) => p === attachments[0]);
    expect(posts.slice(0, before).some((p) => visibleText(p.body)?.includes('Done.'))).toBe(true);
    // Simulate a crash after upload but before the cursor checkpoint reached disk.
    const saved = JSON.parse(await readFile(join(dir, 'discord-conversations.json'), 'utf8'));
    saved[0][1].cursor = 'native1:1';
    await writeFile(join(dir, 'discord-conversations.json'), JSON.stringify(saved));
    b.stop();
    now += 60001;
    const restarted = makeBridge(undefined, { history, getAttachment, now: () => now });
    await restarted.reload();
    await restarted.syncSessions();
    await restarted.pollConversations();
    expect(uploaded).toHaveLength(2);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('uses workspace guards for missing, secret and escaped paths without losing this or later text', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    sessions = [{ id: 's1', name: 'one' }];
    await writeFile(join(dir, '.env'), 'NOT-A-REAL-SECRET');
    const history = async () => ({ conversationId: 'native1', partial: false, turns });
    const getAttachment = vi.fn(async (_id: string, path: string) =>
      readDiscordSessionFile({ workingDir: dir }, resolve(dir, path))
    );
    const b = makeBridge(undefined, { history, getAttachment, now: () => now });
    await b.reload();
    await b.syncSessions();
    turns = [
      {
        cursor: 'native1:1',
        role: 'assistant',
        text: 'Here are outputs.\n[artifact: .env]\n[Missing](missing.pdf)\n[artifact: ../outside.txt]',
        timestamp: '',
      },
    ];
    await b.pollConversations();
    expect(uploaded).toEqual([]);
    expect(posts.some((p) => visibleText(p.body)?.includes('Here are outputs.'))).toBe(true);
    expect(posts.filter((p) => p.body?.content?.startsWith('Some linked output files'))).toHaveLength(1);
    expect(posts.some((p) => p.body?.content?.includes('NOT-A-REAL-SECRET'))).toBe(false);
    turns.push({ cursor: 'native1:2', role: 'assistant', text: 'The next response still arrives.', timestamp: '' });
    now += 60001;
    await b.pollConversations();
    expect(posts.some((p) => visibleText(p.body)?.includes('The next response still arrives.'))).toBe(true);
  });

  it('caps automatic file count and combined bytes and includes one concise notice', async () => {
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    sessions = [{ id: 's1', name: 'one' }];
    const getAttachment = vi.fn(async (_id: string, path: string) => ({
      name: path,
      data: Buffer.alloc(5 * 1024 * 1024),
    }));
    const b = makeBridge(undefined, {
      getAttachment,
      history: async () => ({ conversationId: 'native1', partial: false, turns }),
    });
    await b.reload();
    await b.syncSessions();
    turns = [
      {
        cursor: 'native1:1',
        role: 'assistant',
        text: Array.from({ length: 8 }, (_, i) => `[File](output${i}.pdf)`).join('\n'),
        timestamp: '',
      },
    ];
    await b.pollConversations();
    expect(getAttachment).toHaveBeenCalledTimes(4);
    expect(uploaded).toHaveLength(1);
    expect(
      posts.filter((p) => p.body?.content?.startsWith('Files from this response\nSome linked output files'))
    ).toHaveLength(1);
  });

  it('reports a refused artifact upload once while advancing live text delivery', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, {
      getAttachment: async () => ({ name: 'pic.png', data: Buffer.from('image') }),
      history: async () => ({ conversationId: 'native1', partial: false, turns }),
      now: () => now,
    });
    await b.reload();
    await b.syncSessions();
    artifactPostRefused = true;
    turns = [{ cursor: 'native1:1', role: 'assistant', text: 'Here is the picture. ![Image](pic.png)', timestamp: '' }];
    await b.pollConversations();
    expect(posts.filter((p) => p.body?.content === 'Files from this response')).toHaveLength(1);
    expect(
      posts.filter((p) => p.body?.content?.startsWith('Output file delivery could not be confirmed'))
    ).toHaveLength(1);
    now += 60001;
    await b.pollConversations();
    expect(posts.filter((p) => p.body?.content === 'Files from this response')).toHaveLength(1);
    turns.push({ cursor: 'native1:2', role: 'assistant', text: 'Later response.', timestamp: '' });
    now += 60001;
    await b.pollConversations();
    expect(posts.some((p) => visibleText(p.body)?.includes('Later response.'))).toBe(true);
  });

  it('never auto-uploads historical responses, tool results or stream-off output', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [
      { cursor: 'native1:1', role: 'assistant', text: '[Old report](old.pdf)', timestamp: '' },
    ];
    sessions = [{ id: 's1', name: 'one' }];
    const getAttachment = vi.fn(async () => ({ name: 'unused.pdf', data: Buffer.from('unused') }));
    const b = makeBridge(undefined, {
      getAttachment,
      history: async () => ({ conversationId: 'native1', partial: false, turns }),
      now: () => now,
    });
    await b.reload();
    await b.syncSessions();
    await b.pollConversations();
    expect(getAttachment).not.toHaveBeenCalled();
    turns.push({ cursor: 'native1:2', role: 'tool', text: '[Tool file](tool.pdf)', timestamp: '' });
    now += 60001;
    await b.pollConversations();
    expect(getAttachment).not.toHaveBeenCalled();
    const thread = (await readFullMap(dir)).s1;
    await b.onGatewayMessage({
      id: '900000000000000001',
      guild_id: cfg.guildId,
      channel_id: thread,
      author: { id: cfg.allowedUserIds[0] },
      content: '!codeman stream off',
    });
    turns.push({ cursor: 'native1:3', role: 'assistant', text: '[Paused](paused.pdf)', timestamp: '' });
    now += 60001;
    await b.pollConversations();
    expect(getAttachment).not.toHaveBeenCalled();
  });

  it('abandons automatic attachment delivery when routing stops during a file read', async () => {
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    sessions = [{ id: 's1', name: 'one', remote: true }];
    const getAttachment = vi.fn(async () => {
      b.stop();
      return { name: 'picture.png', data: Buffer.from('image') };
    });
    const b = makeBridge(undefined, {
      getAttachment,
      history: async () => ({ conversationId: 'native1', partial: false, turns }),
    });
    await b.reload();
    await b.syncSessions();
    turns = [{ cursor: 'native1:1', role: 'assistant', text: '![Image](/remote/work/picture.png)', timestamp: '' }];
    await b.pollConversations();
    expect(getAttachment).toHaveBeenCalledWith('s1', '/remote/work/picture.png', true);
    expect(uploaded).toHaveLength(0);
  });

  it.each([false, true])(
    'mirrors newly submitted native prompts before answers (remote=%s) without pings or input',
    async (remote) => {
      let now = 100000;
      let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
      sessions = [{ id: 's1', name: 'one', remote }];
      const getAttachment = vi.fn();
      const history = async () => ({ conversationId: 'native1', partial: false, turns });
      const b = makeBridge(undefined, { history, getAttachment, now: () => now });
      await b.reload();
      await b.syncSessions();
      await b.pollConversations();
      expect(posts.some((p) => JSON.stringify(p.body ?? {}).includes('User prompt'))).toBe(false);
      turns = [
        {
          cursor: 'native1:1',
          role: 'user',
          text: 'Explain this.\n```ts\nconst x = 1;\n```\n[My input](input.pdf)',
          timestamp: '',
        },
        { cursor: 'native1:2', role: 'assistant', text: 'Here is the explanation.', timestamp: '' },
      ];
      now += 60001;
      await b.pollConversations();
      const prompt = posts.find((p) => p.method === 'POST' && JSON.stringify(p.body ?? {}).includes('User prompt'))!;
      expect(prompt).toBeDefined();
      expect(visibleText(prompt.body)).toContain('const x = 1;');
      expect(prompt.body.allowed_mentions).toEqual({ parse: [], users: [] });
      const answer = posts.find(
        (p) => p.method === 'POST' && visibleText(p.body)?.includes('Here is the explanation.')
      )!;
      expect(posts.indexOf(prompt)).toBeLessThan(posts.indexOf(answer));
      expect(getAttachment).not.toHaveBeenCalled();
      expect(sendInput).not.toHaveBeenCalled();
      b.stop();
      const restarted = makeBridge(undefined, { history, now: () => now });
      await restarted.reload();
      await restarted.syncSessions();
      now += 60001;
      await restarted.pollConversations();
      expect(
        posts.filter((p) => p.method === 'POST' && JSON.stringify(p.body ?? {}).includes('User prompt'))
      ).toHaveLength(1);
    }
  );

  it('suppresses a Discord prompt after metadata advances the verified live cursor beyond its send boundary', async () => {
    let now = 100000;
    const conv = '12345678-1234-1234-1234-123456789abc';
    const baseline = conv + ':100:aaaaaaaaaaaaaaaa',
      scanned = conv + ':150:bbbbbbbbbbbbbbbb',
      submitted = conv + ':200:cccccccccccccccc',
      external = conv + ':300:dddddddddddddddd';
    const old = { cursor: baseline, role: 'assistant' as const, text: 'Previous response', timestamp: '' };
    let page: import('../src/discord-history.js').DiscordHistory = {
      conversationId: conv,
      partial: true,
      verifiedAfter: baseline,
      scannedCursor: scanned,
      hasMore: false,
      turns: [],
    };
    const history = async (_id: string, options?: { after?: string }) => {
      if (!options?.after) return { conversationId: conv, partial: false, turns: [old] };
      if (options.after === baseline && page.verifiedAfter !== baseline)
        return {
          conversationId: conv,
          partial: true,
          verifiedAfter: baseline,
          turns: [
            {
              cursor: submitted,
              role: 'user' as const,
              text: 'Do a manual refresh now and check again',
              timestamp: '',
            },
          ],
          executions: [
            {
              userCursor: submitted,
              promptHash: hashDiscordPrompt('Do a manual refresh now and check again'),
              state: 'running' as const,
            },
          ],
        };
      return page;
    };
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    await b.pollConversations();
    const thread = (await readFullMap(dir)).s1,
      text = 'Do a manual refresh now and check again';
    await b.onGatewayMessage({
      id: '900000000000000001',
      guild_id: cfg.guildId,
      channel_id: thread,
      author: { id: cfg.allowedUserIds[0] },
      content: text,
    });
    page = {
      conversationId: conv,
      partial: true,
      verifiedAfter: scanned,
      turns: [{ cursor: submitted, role: 'user', text, timestamp: '' }],
      executions: [{ userCursor: submitted, promptHash: hashDiscordPrompt(text), state: 'running' }],
    };
    now += 60001;
    await b.pollConversations();
    const prompts = () =>
      posts.filter((p) => p.method === 'POST' && JSON.stringify(p.body ?? {}).includes('User prompt'));
    expect(prompts()).toHaveLength(0);
    page = {
      conversationId: conv,
      partial: true,
      verifiedAfter: submitted,
      turns: [{ cursor: external, role: 'user', text, timestamp: '' }],
      executions: [{ userCursor: external, promptHash: hashDiscordPrompt(text), state: 'running' }],
    };
    now += 60001;
    await b.pollConversations();
    expect(prompts()).toHaveLength(1);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('does not echo an attributed Discord prompt but mirrors later identical text from outside Discord', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    let executions: import('../src/discord-native-execution.js').DiscordNativeExecution[] = [];
    sessions = [{ id: 's1', name: 'one' }];
    const history = async () => ({ conversationId: 'native1', partial: false, turns, executions });
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    const text = 'Review this change';
    await b.onGatewayMessage({
      id: '900000000000000001',
      guild_id: cfg.guildId,
      channel_id: thread,
      author: { id: cfg.allowedUserIds[0] },
      content: text,
    });
    expect(sendInput).toHaveBeenCalledTimes(1);
    turns = [{ cursor: 'native1:1', role: 'user', text, timestamp: '' }];
    executions = [{ userCursor: 'native1:1', promptHash: hashDiscordPrompt(text), state: 'completed' }];
    await b.pollConversations();
    const prompts = () =>
      posts.filter((p) => p.method === 'POST' && JSON.stringify(p.body ?? {}).includes('User prompt'));
    expect(prompts()).toHaveLength(0);
    turns.push({ cursor: 'native1:2', role: 'user', text, timestamp: '' });
    executions.push({ userCursor: 'native1:2', promptHash: hashDiscordPrompt(text), state: 'running' });
    now += 60001;
    await b.pollConversations();
    expect(prompts()).toHaveLength(1);
    expect(visibleText(prompts()[0].body)).toContain(text);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'does not echo Discord attachment prompts past their saved boundary (inflight=%s)',
    async (inflight) => {
      let now = 100000;
      const text = 'Review this [attached: /tmp/example.png]';
      const baseline = {
        cursor: '12345678-1234-1234-1234-123456789abc:10:aaaaaaaaaaaaaaaa',
        role: 'assistant' as const,
        text: 'Previous response',
        timestamp: '',
      };
      const intermediate = {
        cursor: '12345678-1234-1234-1234-123456789abc:20:aaaaaaaaaaaaaaaa',
        role: 'assistant' as const,
        text: 'An update',
        timestamp: '',
      };
      const input = {
        cursor: '12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa',
        role: 'user' as const,
        text,
        timestamp: '',
      };
      let sent = false,
        advanced = false;
      const history = vi.fn(async (_id: string, options?: { after?: string }) => {
        if (!sent)
          return {
            conversationId: '12345678-1234-1234-1234-123456789abc',
            partial: false,
            turns: advanced ? [baseline, intermediate] : [baseline],
          };
        return {
          conversationId: '12345678-1234-1234-1234-123456789abc',
          partial: true,
          verifiedAfter: options?.after,
          turns: options?.after === intermediate.cursor ? [intermediate, input] : [baseline, intermediate, input],
          executions: [{ userCursor: input.cursor, promptHash: hashDiscordPrompt(text), state: 'running' as const }],
        };
      });
      sessions = [{ id: 's1', name: 'one' }];
      const b = makeBridge(undefined, { history, now: () => now });
      await b.reload();
      await b.syncSessions();
      const thread = (await readFullMap(dir)).s1;
      sendInput.mockImplementationOnce(async () => {
        advanced = true;
        await b.pollConversations();
        sent = true;
        if (inflight) {
          now += 20000;
          await b.pollConversations();
        }
        return true;
      });
      await b.onGatewayMessage({
        id: '900000000000000011',
        guild_id: cfg.guildId,
        channel_id: thread,
        author: { id: cfg.allowedUserIds[0] },
        content: text,
      });
      now += 20000;
      await b.pollConversations();
      expect(history).toHaveBeenCalledWith('s1', { includeTools: false, after: baseline.cursor });
      expect(
        posts.filter((p) => p.method === 'POST' && JSON.stringify(p.body ?? {}).includes('User prompt'))
      ).toHaveLength(0);
      expect(sendInput).toHaveBeenCalledTimes(1);
      b.stop();
      const restarted = makeBridge(undefined, { history, now: () => now });
      await restarted.reload();
      await restarted.syncSessions();
      await restarted.pollConversations();
      expect(
        posts.filter((p) => p.method === 'POST' && JSON.stringify(p.body ?? {}).includes('User prompt'))
      ).toHaveLength(0);
      expect(sendInput).toHaveBeenCalledTimes(1);
    }
  );
  it('preserves historical and stream-off boundaries for user prompt mirroring', async () => {
    let now = 100000;
    const turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [
      { cursor: 'native1:1', role: 'user', text: 'Historical prompt', timestamp: '' },
    ];
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, {
      history: async () => ({ conversationId: 'native1', partial: false, turns }),
      now: () => now,
    });
    await b.reload();
    await b.syncSessions();
    await b.pollConversations();
    expect(posts.some((p) => JSON.stringify(p.body ?? {}).includes('User prompt'))).toBe(false);
    await b.onGatewayMessage({
      id: '900000000000000001',
      guild_id: cfg.guildId,
      channel_id: (await readFullMap(dir)).s1,
      author: { id: cfg.allowedUserIds[0] },
      content: '!codeman stream off',
    });
    turns.push({ cursor: 'native1:2', role: 'user', text: 'Submitted while streaming off', timestamp: '' });
    now += 60001;
    await b.pollConversations();
    expect(posts.some((p) => JSON.stringify(p.body ?? {}).includes('User prompt'))).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('exports a full long prompt once and deduplicates a replay after a lost cursor checkpoint', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    sessions = [{ id: 's1', name: 'one' }];
    const history = async () => ({ conversationId: 'native1', partial: false, turns });
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    const text = 'Long user input. '.repeat(900);
    turns = [{ cursor: 'native1:1', role: 'user', text, timestamp: '' }];
    await b.pollConversations();
    expect(uploaded).toEqual([{ name: 'prompt.txt', text }]);
    const before = posts.length;
    const saved = JSON.parse(await readFile(join(dir, 'discord-conversations.json'), 'utf8'));
    delete saved[0][1].cursor;
    await writeFile(join(dir, 'discord-conversations.json'), JSON.stringify(saved));
    b.stop();
    const restarted = makeBridge(undefined, { history, now: () => now });
    await restarted.reload();
    await restarted.syncSessions();
    now += 60001;
    await restarted.pollConversations();
    expect(uploaded).toHaveLength(1);
    expect(
      posts.slice(before).some((p) => p.method === 'POST' && JSON.stringify(p.body ?? {}).includes('User prompt'))
    ).toBe(false);
  });

  it('reacts to a native session update even when the thread name did not change', async () => {
    let now = 1_000;
    sessions = [{ id: 's1', name: 'hs-lab', working: false }];
    const b = makeBridge(undefined, { now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    await b.sessionRenamed('s1', 'hs-lab');
    await b.pollActivity();
    sessions[0].working = true;
    now += 100;
    await b.sessionRenamed('s1', 'hs-lab');
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · hs-lab');
    expect(posts.some((p) => p.path.endsWith('/typing'))).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps typing when an existing Idle thread cannot be renamed yet, without inline retries', async () => {
    let now = 1_000;
    sessions = [{ id: 's1', name: 'hs-lab', working: false }];
    const b = makeBridge(undefined, { now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    const titleEdits = () => posts.filter((p) => p.method === 'PATCH' && p.path.endsWith('/' + thread) && p.body?.name);
    const typing = () => posts.filter((p) => p.method === 'POST' && p.path.endsWith('/typing'));
    await b.pollActivity();
    expect(titleEdits()).toHaveLength(0);
    expect(typing()).toHaveLength(0);
    sessions[0].working = true;
    activityRenameRetryAfter = 120;
    now += 4_000;
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('⚫ Idle · hs-lab');
    expect(typing()).toHaveLength(1);
    expect(titleEdits()).toHaveLength(1);
    now += 8_000;
    await b.pollActivity();
    expect(typing()).toHaveLength(2);
    expect(titleEdits()).toHaveLength(1);
    activityRenameRetryAfter = undefined;
    now += 120_000;
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · hs-lab');
    expect(titleEdits()).toHaveLength(2);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('repairs a stale Idle title after a concurrent request overwrites its published Working title', async () => {
    let now = 1_000;
    sessions = [{ id: 's1', name: 'hs-lab', working: true }];
    const b = makeBridge(undefined, { now: () => now });
    await b.reload();
    await b.syncSessions();
    const thread = (await readFullMap(dir)).s1;
    await b.pollActivity();
    remoteChannels.get(thread).name = '⚫ Idle · hs-lab';
    now += 8_000;
    await b.pollActivity();
    expect(remoteChannels.get(thread).name).toBe('🟡 Working · hs-lab');
    expect(sendInput).not.toHaveBeenCalled();
  });

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
    const selection = posts.find((p) => visibleText(p.body)?.includes('Nothing was submitted'))!;
    expect(selection.path).toContain(parent.id);
    expect(selection.body.content).toContain('<#' + map.s1 + '>');
    expect(selection.body.content).toContain('<#' + map.s2 + '>');
    await b.onGatewayMessage({ ...m, id: '900000000000000002', content: '!codeman sessions' });
    expect(control).toHaveBeenCalledExactlyOnceWith('__case__:' + caseKey, 'sessions');
    await b.onGatewayMessage({ ...m, id: '900000000000000005', content: '!codeman stream verbose' });
    await b.onGatewayMessage({ ...m, id: '900000000000000006', content: '!codeman file /work/file.txt' });
    expect(control).toHaveBeenCalledTimes(1);
    expect(posts.some((p) => visibleText(p.body)?.includes('Open a session thread for task'))).toBe(true);

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
      const historyPost = posts.find((p) => visibleText(p.body)?.includes('historical-' + id));
      const livePost = posts.find((p) => visibleText(p.body)?.includes('live-' + id));
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
    expect(posts.some((p) => visibleText(p.body)?.includes('dialog appeared while preparing this reply'))).toBe(true);
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
    expect(posts.some((p) => visibleText(p.body) === 'Working')).toBe(true);
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
    const historical = () =>
      posts.filter(
        (p) =>
          visibleText(p.body)?.startsWith('**Historical context**') ||
          p.body?.components?.[0]?.components?.[0]?.content === '**Latest response**'
      );
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
  it('backfills the complete latest reply across multiple cards without duplicating it on restart', async () => {
    const text = 'Full original answer.\n\n' + 'Details preserved.\n'.repeat(300) + '\nLast row preserved.';
    const history = async () => ({
      conversationId: 'native1',
      partial: false,
      turns: [{ cursor: 'native1:1', role: 'assistant' as const, text, timestamp: '' }],
    });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history });
    await b.reload();
    await b.syncSessions();
    const cards = posts.filter(
      (p) => (p.body?.flags & 32768) !== 0 && p.body?.components?.some((c: any) => c.type === 17)
    );
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.map((p) => visibleText(p.body)).join('\n')).toContain('Last row preserved.');
    expect(
      cards
        .map((p) => visibleText(p.body))
        .join('\n')
        .match(/Details preserved\./g)
    ).toHaveLength(300);
    const count = cards.length;
    b.stop();
    const again = makeBridge(undefined, { history });
    await again.reload();
    await again.syncSessions();
    expect(
      posts.filter((p) => (p.body?.flags & 32768) !== 0 && p.body?.components?.some((c: any) => c.type === 17))
    ).toHaveLength(count);
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
    const answers = () => posts.filter((p) => visibleText(p.body)?.includes('fresh answer'));
    expect(answers()).toHaveLength(1);
    expect(posts.some((p) => visibleText(p.body) === '⏳ Working…')).toBe(true);
    now += 60001;
    state = 'completed';
    await b.pollConversations();
    expect(answers()).toHaveLength(1);
    expect(posts.some((p) => p.method === 'PATCH' && visibleText(p.body) === '✅ Done')).toBe(true);
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
    expect(posts.filter((p) => visibleText(p.body)?.includes('**Answer**'))).toHaveLength(1);
    expect(visibleText(posts.find((p) => visibleText(p.body)?.includes('**Answer**'))?.body)).toBe(
      '**Answer**\n- One\n- Two'
    );
    expect(
      posts.some(
        (p) => visibleText(p.body)?.includes('Waiting for Input') || visibleText(p.body)?.includes('2026-11-06T')
      )
    ).toBe(false);
    expect(fullText).not.toHaveBeenCalled();
    b.stop();
    const again = makeBridge(undefined, { history, now: () => now });
    await again.reload();
    await again.syncSessions();
    await again.notify(msg);
    expect(posts.filter((p) => visibleText(p.body)?.includes('**Answer**'))).toHaveLength(1);
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
          (p) =>
            p.body?.components?.[0]?.components?.[0]?.content === '**Response**' &&
            visibleText(p.body)?.includes('fallback answer')
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
      expect(posts.some((p) => visibleText(p.body)?.includes(label))).toBe(true);
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
    const statusPost = posts.find((p) => p.method === 'POST' && visibleText(p.body) === '⏳ Working…')!;
    const message = [...remoteMessages.values()].find((m) => visibleText(m) === '⏳ Working…')!;
    now += 60001;
    state = 'completed';
    await b.pollConversations();
    expect(
      posts.filter((p) => p.method === 'POST' && ['⏳ Working…', '✅ Done'].includes(visibleText(p.body)))
    ).toHaveLength(1);
    expect(
      posts.some((p) => p.method === 'PATCH' && p.path.endsWith('/' + message.id) && visibleText(p.body) === '✅ Done')
    ).toBe(true);
    now += 60001;
    state = 'running';
    turns.push({ cursor: 'native1:2', role: 'user', text: 'second', timestamp: '' });
    await b.pollConversations();
    expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body) === '⏳ Working…')).toHaveLength(1);
    remoteMessages.delete(message.id);
    now += 60001;
    state = 'completed';
    await b.pollConversations();
    expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body) === '✅ Done')).toHaveLength(1);
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
    expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body)?.includes('Delivered once'))).toHaveLength(1);
    expect(posts.some((p) => visibleText(p.body)?.includes('Waiting for Input'))).toBe(false);
    statusEditRefused = false;
    now += 60001;
    await b.pollConversations();
    expect(posts.some((p) => p.method === 'PATCH' && visibleText(p.body) === '✅ Done')).toBe(true);
    expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body)?.includes('Delivered once'))).toHaveLength(1);
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
    expect(posts.filter((p) => visibleText(p.body) === 'Clean answer')).toHaveLength(1);
    expect(
      posts.some((p) => visibleText(p.body)?.includes('MEMORY.md') || visibleText(p.body)?.includes('<oai-mem'))
    ).toBe(false);
    now += 60001;
    turns.push({ cursor: 'native1:3', role: 'assistant', text: 'Next answer', timestamp: '' });
    await b.pollConversations();
    expect(posts.filter((p) => visibleText(p.body) === 'Next answer')).toHaveLength(1);
    expect(posts.filter((p) => visibleText(p.body) === 'Clean answer')).toHaveLength(1);
    b.stop();
    const again = makeBridge(undefined, { history, now: () => now });
    await again.reload();
    await again.syncSessions();
    await again.pollConversations();
    expect(posts.filter((p) => visibleText(p.body) === 'Clean answer')).toHaveLength(1);
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
    const contexts = posts.filter((p) => p.body?.components?.[0]?.components?.[0]?.content === '**Latest response**');
    expect(contexts).toHaveLength(1);
    expect(visibleText(contexts[0].body)).toContain('History answer');
    expect(visibleText(contexts[0].body)).not.toContain('oai-mem');
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
    expect(posts.some((p) => visibleText(p.body)?.includes('Visible fallback answer'))).toBe(true);
    expect(
      posts.some((p) => visibleText(p.body)?.includes('private-footer') || visibleText(p.body)?.includes('<oai-mem'))
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
    const past = posts.find((p) => p.body?.components?.[0]?.components?.[0]?.content === '**Latest response**');
    expect(visibleText(past?.body)).toContain('**Item:** Historical');
    expect(visibleText(past?.body)).toContain('**Status:** Long status');
    expect(visibleText(past?.body)).not.toContain('```');
    turns.push({ cursor: 'native1:2', role: 'assistant', text: table('Live'), timestamp: '' });
    await b.pollConversations();
    const live = posts.find((p) => visibleText(p.body)?.includes('**Item:** Live'));
    expect(visibleText(live?.body)).toContain('[details](https://example.test)');
    expect(visibleText(live?.body)).not.toContain('|---');
    await b.onGatewayMessage({
      id: '900000000000000001',
      guild_id: cfg.guildId,
      channel_id: (await readFullMap(dir)).s1,
      author: { id: cfg.allowedUserIds[0] },
      content: '!codeman history',
    });
    expect(posts.some((p) => visibleText(p.body)?.includes('**Item:** Requested history'))).toBe(true);
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
      const prompt = posts.find((p) => p.body?.components?.length && visibleText(p.body)?.endsWith('Which option?'));
      expect(prompt).toBeDefined();
      expect((prompt!.body!.flags ?? 0) & DISCORD_SUPPRESS_NOTIFICATIONS).toBe(0);
      expect(prompt!.body!.allowed_mentions.users).toEqual(pingMode === 'critical' ? cfg.allowedUserIds : []);
      await b.onGatewayMessage({
        id: '555555555555555555',
        guild_id: cfg.guildId,
        channel_id: map.s1,
        author: { id: cfg.allowedUserIds[0] },
        content: '1',
      });
      expect(sendInput).not.toHaveBeenCalled();
      expect(posts.some((p) => visibleText(p.body)?.includes('prompt-bound answer'))).toBe(true);
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
      await vi.waitFor(() => expect(posts.some((p) => visibleText(p.body)?.includes('local live answer'))).toBe(true));
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
it('renders routine fallback answers as readable cards without repeating alert metadata or unfurling body links', async () => {
  sessions = [{ id: 's1', name: 'w5-demo' }];
  const b = makeBridge();
  await b.reload();
  await b.syncSessions();
  const result = await b.notify({
    sessionId: 's1',
    sessionName: 'w5-demo',
    event: 'hook:idle_prompt',
    title: 'Waiting for Input',
    host: 'codeman:example',
    body: '[w5-demo]',
    urgency: 'warning',
    fullText: async () => ({
      text: 'The revised flow needs:\n1. Spread: details\n2. Shared: details\n\nhttps://example.test/demo',
    }),
  });
  expect(result?.ok).toBe(true);
  const post = posts.find((p) => visibleText(p.body)?.includes('**Spread:**'))!.body;
  expect(post.components[0].components[0].content).toBe('**Response**');
  expect(post.embeds).toBeUndefined();
  expect(post.flags).toBe(32772);
  expect(visibleText(post)).toContain('\n\n2. **Shared:**');
  expect(visibleText(post)).toContain('https://example.test/demo');
  expect(JSON.stringify(post)).not.toContain('Waiting for Input');
  expect(JSON.stringify(post)).not.toContain('codeman:example');
  expect(JSON.stringify(post)).not.toContain('[w5-demo]');
});
it('keeps critical alert context and an allowlisted ping when the attached response is styled', async () => {
  const b = makeBridge();
  await b.reload();
  await b.syncSessions();
  const result = await b.notify({
    sessionId: 's1',
    event: 'session:error',
    title: 'Task failed',
    body: 'The build command failed.',
    urgency: 'critical',
    fullText: async () => ({ text: 'Detailed failure explanation.' }),
  });
  expect(result?.ok).toBe(true);
  const post = posts.find((p) => p.body?.components?.[0]?.components?.[0]?.content === '**Task failed**')!.body;
  expect(post.flags).toBe(32772);
  expect(post.embeds).toBeUndefined();
  expect(post.components[0].accent_color).toBe(0xed6b6b);
  expect(visibleText(post)).toContain('The build command failed.');
  expect(visibleText(post)).toContain('Detailed failure explanation.');
  expect(post.allowed_mentions.parse).toEqual([]);
  expect(post.allowed_mentions.users).toEqual(cfg.allowedUserIds);
});
it('does not add a bare Waiting for Input wrapper after the same fallback answer was already delivered', async () => {
  const b = makeBridge();
  await b.reload();
  await b.syncSessions();
  const msg = {
    sessionId: 's1',
    event: 'hook:idle_prompt',
    title: 'Waiting for Input',
    body: '[s1]',
    urgency: 'warning' as const,
    fullText: async () => ({ text: 'A completed answer.' }),
  };
  expect((await b.notify(msg))?.ok).toBe(true);
  expect((await b.notify({ ...msg, event: 'hook:stop' }))?.deduped).toBe(true);
  expect(posts.filter((p) => visibleText(p.body) === 'A completed answer.')).toHaveLength(1);
  expect(posts.some((p) => p.body?.content?.includes('Waiting for Input'))).toBe(false);
});

it('skips an uncertain native turn with a catch-up notice and delivers later turns', async () => {
  let now = 100000;
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
  sessions = [{ id: 's1', name: 'one' }];
  const b = makeBridge(undefined, {
    history: async () => ({ conversationId: 'native1', partial: false, turns }),
    now: () => now,
  });
  await b.reload();
  await b.syncSessions();
  turns = [{ cursor: 'native1:1:abc', role: 'assistant', text: 'ambiguous response', timestamp: 't' }];
  uncertainText = 'ambiguous response';
  await b.pollConversations();
  const attempts = posts.filter((p) => visibleText(p.body) === 'ambiguous response').length;
  expect(attempts).toBeGreaterThan(0);
  expect(posts.some((p) => p.body?.content?.includes('!codeman history or !codeman transcript'))).toBe(true);
  uncertainText = undefined;
  turns.push({ cursor: 'native1:2:abc', role: 'assistant', text: 'later response', timestamp: 't' });
  now += 60001;
  await b.pollConversations();
  expect(posts.filter((p) => visibleText(p.body) === 'ambiguous response')).toHaveLength(attempts);
  expect(posts.filter((p) => visibleText(p.body) === 'later response')).toHaveLength(1);
});
it('keeps a tool cursor available after switching from verbose to responses', async () => {
  let now = 100000;
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
  sessions = [{ id: 's1', name: 'one' }];
  const history = vi.fn(async (_id: string, options?: { includeTools?: boolean; after?: string }) => ({
    conversationId: 'native1',
    partial: false,
    verifiedAfter: options?.after,
    turns: options?.includeTools ? turns : turns.filter((t) => t.role !== 'tool'),
  }));
  const b = makeBridge(undefined, { history, now: () => now });
  await b.reload();
  await b.syncSessions();
  const channel = (await readFullMap(dir)).s1;
  const command = async (content: string, id: string) =>
    b.onGatewayMessage({
      id,
      guild_id: cfg.guildId,
      channel_id: channel,
      author: { id: cfg.allowedUserIds[0] },
      content,
    });
  await command('!codeman stream verbose', '777777777777777771');
  turns = [{ cursor: 'native1:1:abc', role: 'tool', text: 'tool output', timestamp: 't' }];
  await b.pollConversations();
  await command('!codeman stream responses', '777777777777777772');
  turns.push({ cursor: 'native1:2:abc', role: 'assistant', text: 'answer after tool', timestamp: 't' });
  now += 60001;
  await b.pollConversations();
  expect(posts.filter((p) => visibleText(p.body) === 'answer after tool')).toHaveLength(1);
});
it('reanchors a lost tail cursor once and continues delivering new turns', async () => {
  let now = 100000;
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [
    { cursor: 'native1:1:abc', role: 'assistant', text: 'old', timestamp: 't' },
  ];
  sessions = [{ id: 's1', name: 'one' }];
  const b = makeBridge(undefined, {
    history: async () => ({ conversationId: 'native1', partial: true, turns }),
    now: () => now,
  });
  await b.reload();
  await b.syncSessions();
  turns = [{ cursor: 'native1:9:abc', role: 'assistant', text: 'tail boundary', timestamp: 't' }];
  await b.pollConversations();
  expect(posts.some((p) => p.body?.content?.includes('!codeman history or !codeman transcript'))).toBe(true);
  turns.push({ cursor: 'native1:10:abc', role: 'assistant', text: 'new after gap', timestamp: 't' });
  now += 60001;
  await b.pollConversations();
  expect(posts.filter((p) => visibleText(p.body) === 'new after gap')).toHaveLength(1);
});
it('preserves stream off across conversation reset without posting replacement historical turns', async () => {
  sessions = [{ id: 's1', name: 'one' }];
  let conversationId = 'native1';
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
  const b = makeBridge(undefined, { history: async () => ({ conversationId, partial: false, turns }) });
  await b.reload();
  await b.syncSessions();
  const channel = (await readFullMap(dir)).s1;
  await b.onGatewayMessage({
    id: '777777777777777773',
    guild_id: cfg.guildId,
    channel_id: channel,
    author: { id: cfg.allowedUserIds[0] },
    content: '!codeman stream off',
  });
  conversationId = 'native2';
  turns = [{ cursor: 'native2:1:abc', role: 'assistant', text: 'must stay off', timestamp: 't' }];
  await b.syncSessions();
  await b.pollConversations();
  expect(posts.some((p) => p.body?.content?.includes('must stay off'))).toBe(false);
});
it('treats a fast first response as live even while initial synchronization is awaiting history', async () => {
  sessions = [{ id: 's1', name: 'one' }];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const text = 'full fast response '.repeat(140);
  const history = vi.fn(async () => {
    await gate;
    return {
      conversationId: 'native1',
      partial: false,
      turns: [{ cursor: 'native1:1:abc', role: 'assistant' as const, text, timestamp: 't' }],
    };
  });
  const b = makeBridge(undefined, { history });
  await b.reload();
  await vi.waitFor(() => expect(history).toHaveBeenCalled());
  const alert = b.notify({
    event: 'hook:idle_prompt',
    title: 'done',
    body: 'done',
    urgency: 'warning',
    sessionId: 's1',
    fullText: async () => ({ text }),
  });
  await vi.waitFor(() => expect((b as any).liveSessions.has('s1')).toBe(true));
  release();
  await alert;
  await b.syncSessions();
  expect(posts.some((p) => p.body?.content?.startsWith('**Historical context**'))).toBe(false);
  const response = posts
    .filter((p) => visibleText(p.body)?.includes('full fast response'))
    .map((p) => visibleText(p.body))
    .join('');
  expect(response.length).toBeGreaterThan(2000);
});
it('does not write Full-mode registries when deleting a tab while disabled or in Notifications', async () => {
  await writeDiscordConfig(dir, { ...cfg, enabled: false });
  const b = makeBridge();
  await b.reload();
  await b.sessionDeleted('unrelated');
  await expect(readFile(join(dir, 'discord-case-threads.json'))).rejects.toThrow();
  await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
  await b.reload();
  await b.sessionDeleted('unrelated');
  await expect(readFile(join(dir, 'discord-case-threads.json'))).rejects.toThrow();
});
it('posts a critical permission alert even when renaming its owned destination receives 429', async () => {
  sessions = [{ id: 's1', name: 'case_*<>`name' }];
  const b = makeBridge();
  await b.reload();
  await b.syncSessions();
  const channel = (await readFullMap(dir)).s1;
  remoteChannels.get(channel).name = 'drifted title';
  activityRenameRetryAfter = 600;
  const result = await b.notify({
    sessionId: 's1',
    sessionName: sessions[0].name,
    event: 'hook:permission_prompt',
    title: 'Permission needed',
    body: 'approve this command',
    urgency: 'critical',
  });
  expect(result?.ok).toBe(true);
  expect(posts.some((p) => p.body?.content?.includes('approve this command'))).toBe(true);
});
it('settles a pending history reader before deleting all progress for a removed session', async () => {
  sessions = [{ id: 's1', name: 'one' }];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const history = vi.fn(async () => {
    await gate;
    return {
      conversationId: 'native1',
      partial: false,
      turns: [{ cursor: 'native1:1:abc', role: 'assistant' as const, text: 'old', timestamp: 't' }],
    };
  });
  const b = makeBridge(undefined, { history });
  await b.reload();
  await vi.waitFor(() => expect(history).toHaveBeenCalled());
  sessions = [];
  const deleting = b.sessionDeleted('s1');
  release();
  await deleting;
  await b.syncSessions();
  const raw = JSON.parse(await readFile(join(dir, 'discord-conversations.json'), 'utf8'));
  expect(raw.some(([, value]: any) => value.sessionId === 's1')).toBe(false);
});
it('does not treat intentionally unsupported history adapters as session synchronization failures', async () => {
  sessions = [{ id: 's1', name: 'shell', historyAvailable: false } as any];
  const history = vi.fn(async () => {
    throw new Error('unsupported');
  });
  const b = makeBridge(undefined, { history });
  await b.reload();
  await b.syncSessions();
  await b.pollConversations();
  expect(b.sessionSync.state).toBe('complete');
  expect(b.sessionSync.failed).toBe(0);
  expect(history).not.toHaveBeenCalled();
});
it('streams explicit commentary as conversation cards and delivers the native final once', async () => {
  sessions = [{ id: 's1', name: 'one' }];
  let now = 100000;
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
  let state: 'running' | 'completed' = 'running';
  const history = async () => ({
    conversationId: 'native1',
    partial: false,
    turns,
    executions: [{ userCursor: 'native1:user', promptHash: 'proof', state }],
  });
  const b = makeBridge(undefined, { history, now: () => now });
  await b.reload();
  await b.syncSessions();
  posts = [];
  turns = [
    { role: 'user', cursor: 'native1:user', text: 'Build', timestamp: 't' },
    {
      role: 'assistant',
      cursor: 'native1:p1',
      text: 'Checks passed; still compiling',
      timestamp: 't',
      phase: 'commentary',
    },
  ];
  await b.pollConversations();
  expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body)?.includes('Checks passed'))).toHaveLength(1);
  expect(
    posts
      .find((p) => p.method === 'POST' && visibleText(p.body)?.includes('Checks passed'))!
      .body.components.some((c: any) => c.type === 17)
  ).toBe(true);
  turns.push({
    role: 'assistant',
    cursor: 'native1:p2',
    text: 'Exporting artifact',
    timestamp: 't',
    phase: 'commentary',
  });
  now += 60001;
  await b.pollConversations();
  expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body)?.includes('Exporting artifact'))).toHaveLength(
    1
  );
  expect(posts.filter((p) => p.method === 'PATCH' && visibleText(p.body)?.includes('Exporting artifact'))).toHaveLength(
    0
  );
  turns.push({
    role: 'assistant',
    cursor: 'native1:final',
    text: 'The artifact is ready.',
    timestamp: 't',
    phase: 'final_answer',
  });
  state = 'completed';
  now += 60001;
  await b.pollConversations();
  const final = posts.filter((p) => p.method === 'POST' && visibleText(p.body) === 'The artifact is ready.');
  expect(final).toHaveLength(1);
  expect(final[0].body.components[0].accent_color).toBe(0x59ca92);
  expect(final[0].body.flags & DISCORD_SUPPRESS_NOTIFICATIONS).toBe(0);
  const updates = posts.filter(
    (p) => p.method === 'POST' && /Checks passed|Exporting artifact/.test(visibleText(p.body) ?? '')
  );
  expect(updates).toHaveLength(2);
  expect(updates.every((p) => !!(p.body.flags & DISCORD_SUPPRESS_NOTIFICATIONS))).toBe(true);
  const progress = posts.filter(
    (p) => p.method === 'POST' && /Working|Done/.test(p.body?.components?.[0]?.content ?? '')
  );
  expect(progress.length).toBeGreaterThan(0);
  expect(progress.every((p) => !!(p.body.flags & DISCORD_SUPPRESS_NOTIFICATIONS))).toBe(true);

  expect(final[0].body.content).toBeUndefined();
  expect(final[0].body.embeds).toBeUndefined();
  b.stop();
  const restarted = makeBridge(undefined, { history, now: () => now });
  await restarted.reload();
  await restarted.syncSessions();
  await restarted.pollConversations();
  expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body) === 'The artifact is ready.')).toHaveLength(1);
  expect(sendInput).not.toHaveBeenCalled();
});
it('keeps an attached file visible when an alert also contains a native V2 response', async () => {
  const b = makeBridge();
  await b.reload();
  await b.syncSessions();
  const result = await b.notify(
    {
      sessionId: 's1',
      event: 'explicit',
      title: 'Review output',
      body: 'Results attached.',
      urgency: 'critical',
      file: { name: 'results.txt', data: Buffer.from('test results') },
      fullText: async () => ({ text: 'The answer.' }),
    },
    { deliberate: true }
  );
  expect(result?.ok).toBe(true);
  const post = posts.find((p) => (p.body?.flags & 32768) !== 0 && visibleText(p.body)?.includes('The answer.'))!.body;
  expect(post.components).toHaveLength(1);
  expect(post.components[0].components).toContainEqual({ type: 13, file: { url: 'attachment://results.txt' } });
  expect(uploaded.some((f) => f.name === 'results.txt' && f.text === 'test results')).toBe(true);
});

it('reports a missing canonical response once instead of sending cursor-painted terminal fragments', async () => {
  let now = 10000;
  const b = makeBridge(undefined, {
    now: () => now,
    history: async () => {
      throw new Error('No exact identity');
    },
  });
  await b.reload();
  await b.syncSessions();
  const msg = {
    sessionId: 's1',
    event: 'hook:idle_prompt',
    title: 'Waiting for Input',
    body: 'fallback',
    urgency: 'warning' as const,
    tail: 'happen between these recorded\n\nviews\n8–9 Shared placement\nThe three chat workloads now\nutilization',
    fullText: async () => {
      throw new Error('Original transcript unavailable');
    },
  };
  await b.notify(msg);
  now += 10000;
  await b.notify(msg);
  const notices = [...remoteMessages.values()].filter(
    (m) => m.components?.[0]?.components?.[0]?.content === '**Reconnecting to this conversation**'
  );
  expect(notices).toHaveLength(1);
  expect(posts.some((p) => JSON.stringify(p.body ?? {}).includes('happen between these recorded'))).toBe(false);
  expect(sendInput).not.toHaveBeenCalled();
});

it('does not show a reconnect notice for a connected session with no assistant response yet', async () => {
  const b = makeBridge(undefined, { history: async () => ({ conversationId: 'native1', turns: [], partial: false }) });
  await b.reload();
  await b.syncSessions();
  await b.notify({
    sessionId: 's1',
    event: 'hook:idle_prompt',
    title: 'Waiting for Input',
    body: 'empty',
    urgency: 'warning',
    fullText: async () => undefined,
    tail: 'Ask Codex to do anything',
  });
  expect(
    posts.some((p) => p.body?.components?.[0]?.components?.[0]?.content === '**Reconnecting to this conversation**')
  ).toBe(false);
  expect(posts.some((p) => JSON.stringify(p.body ?? {}).includes('Ask Codex to do anything'))).toBe(false);
});

it('reports an unverified profile as actionable history attention instead of promising automatic reconnection', async () => {
  const error = new DiscordHistoryReadError('profile_unverified');
  const b = makeBridge(undefined, {
    history: async () => {
      throw error;
    },
  });
  await b.reload();
  await b.syncSessions();
  await b.notify({
    sessionId: 's1',
    event: 'hook:idle_prompt',
    title: 'Waiting for Input',
    body: 'idle',
    urgency: 'warning',
    fullText: async () => {
      throw error;
    },
  });
  const bodies = [...posts.map((p) => p.body), ...remoteMessages.values()]
    .map((p) => JSON.stringify(p ?? {}))
    .join('\n');
  expect(bodies).toContain('Reply history needs attention');
  expect(bodies).toContain('CODEX_HOME');
  expect(bodies).not.toContain('I’m restoring the connection');
  expect(sendInput).not.toHaveBeenCalled();
});

it('groups adjacent commentary by default, preserves final order and supports Quiet and Tools', async () => {
  sessions = [{ id: 's1', name: 'one' }];
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
  const history = async () => ({ conversationId: 'native1', partial: false, turns });
  let now = 100000;
  const b = makeBridge(undefined, { history, now: () => now });
  await b.reload();
  await b.syncSessions();
  posts = [];
  turns = [
    { cursor: 'native1:u', role: 'user', text: 'Task', timestamp: '' },
    { cursor: 'native1:p1', role: 'assistant', phase: 'commentary', text: 'First progress', timestamp: '' },
    { cursor: 'native1:p2', role: 'assistant', phase: 'commentary', text: 'Second progress', timestamp: '' },
    { cursor: 'native1:r', role: 'assistant', phase: 'final_answer', text: 'Final answer', timestamp: '' },
  ];
  now += 60001;
  await b.pollConversations();
  const cards = posts.filter((p) => p.method === 'POST');
  const update = cards.find((p) => visibleText(p.body)?.includes('First progress'))!;
  expect(visibleText(update.body)).toContain('Second progress');
  expect(update.body.flags & DISCORD_SUPPRESS_NOTIFICATIONS).toBeTruthy();
  expect(cards.indexOf(update)).toBeLessThan(cards.findIndex((p) => visibleText(p.body)?.includes('Final answer')));
  now += 60001;
  await b.pollConversations();
  expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body)?.includes('First progress'))).toHaveLength(1);
  const map = await readFullMap(dir);
  const msg = {
    id: '900000000000000098',
    channel_id: map.s1,
    guild_id: cfg.guildId,
    author: { id: cfg.allowedUserIds[0] },
    content: '!codeman stream quiet',
  };
  await b.onGatewayMessage(msg);
  turns.push({ cursor: 'native1:p3', role: 'assistant', phase: 'commentary', text: 'Quiet hidden', timestamp: '' });
  now += 60001;
  await b.pollConversations();
  expect(posts.some((p) => visibleText(p.body)?.includes('Quiet hidden'))).toBe(false);
  await b.onGatewayMessage({ ...msg, id: '900000000000000099', content: '!codeman stream tools' });
  turns.push({ cursor: 'native1:t', role: 'tool', text: 'Tool visible', timestamp: '' });
  now += 60001;
  await b.pollConversations();
  expect(posts.some((p) => visibleText(p.body)?.includes('Tool visible'))).toBe(true);
  expect(
    posts.find((p) => visibleText(p.body)?.includes('Tool visible'))!.body.flags & DISCORD_SUPPRESS_NOTIFICATIONS
  ).toBeTruthy();
  expect(sendInput).not.toHaveBeenCalled();
});
it('replays a reserved update group without changing its payload when more progress arrives', async () => {
  sessions = [{ id: 's1', name: 'one' }];
  let now = 100000;
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
  const history = async () => ({ conversationId: 'native1', partial: false, turns });
  const b = makeBridge(undefined, { history, now: () => now });
  await b.reload();
  await b.syncSessions();
  posts = [];
  turns = [
    { cursor: 'native1:u', role: 'user', text: 'Task', timestamp: '' },
    { cursor: 'native1:p1', role: 'assistant', phase: 'commentary', text: 'Reserved first', timestamp: '' },
    { cursor: 'native1:p2', role: 'assistant', phase: 'commentary', text: 'Reserved second', timestamp: '' },
  ];
  await b.pollConversations();
  const path = join(dir, 'discord-conversations.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved[0][1].cursor = 'native1:u';
  saved[0][1].pendingUpdates = ['native1:p1', 'native1:p2'];
  await writeFile(path, JSON.stringify(saved));
  b.stop();
  now += 60001;
  turns.push({
    cursor: 'native1:p3',
    role: 'assistant',
    phase: 'commentary',
    text: 'New separate progress',
    timestamp: '',
  });
  const restarted = makeBridge(undefined, { history, now: () => now });
  await restarted.reload();
  await restarted.syncSessions();
  await restarted.pollConversations();
  expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body)?.includes('Reserved first'))).toHaveLength(1);
  expect(
    posts.filter((p) => p.method === 'POST' && visibleText(p.body)?.includes('New separate progress'))
  ).toHaveLength(1);
  expect(sendInput).not.toHaveBeenCalled();
});

it('keeps long streamed updates and files silent with just one notification-eligible final chunk', async () => {
  sessions = [{ id: 's1', name: 'one' }];
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
  const history = async () => ({
    conversationId: 'native1',
    partial: false,
    turns,
    executions: [{ userCursor: 'native1:u', promptHash: 'proof', state: 'completed' as const }],
  });
  const b = makeBridge(undefined, {
    history,
    getAttachment: async () => ({ name: 'report.txt', data: Buffer.from('report') }),
  });
  await b.reload();
  await b.syncSessions();
  posts = [];
  turns = [
    { cursor: 'native1:u', role: 'user', text: 'Build report', timestamp: '' },
    {
      cursor: 'native1:p',
      role: 'assistant',
      phase: 'commentary',
      text: 'Progress detail.\n'.repeat(900) + '\n[Download report](/tmp/report.txt)',
      timestamp: '',
    },
    {
      cursor: 'native1:r',
      role: 'assistant',
      phase: 'final_answer',
      text: 'Final detail.\n'.repeat(1100),
      timestamp: '',
    },
  ];
  await b.pollConversations();
  const messages = posts.filter((p) => p.method === 'POST' && /\/messages$/.test(p.path));
  const audible = messages.filter((p) => !(p.body.flags & DISCORD_SUPPRESS_NOTIFICATIONS));
  expect(audible).toHaveLength(1);
  expect(audible[0].body.components[0].components[0].content).toBe('**✓ Turn finished**\n-# one');
  expect(uploaded.map((f) => f.name)).toEqual(expect.arrayContaining(['updates.txt', 'response.txt', 'report.txt']));
  expect(messages.filter((p) => visibleText(p.body)?.includes('Progress detail')).length).toBeGreaterThan(1);
  expect(messages.filter((p) => visibleText(p.body)?.includes('Final detail')).length).toBeGreaterThan(1);
  expect(sendInput).not.toHaveBeenCalled();
});

it('links the live Activity row to the final message actually delivered by the bridge', async () => {
  sessions = [{ id: 's1', name: 'one' }];
  let now = 100000;
  let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
  const history = async () => ({
    conversationId: 'native1',
    partial: false,
    turns,
    executions: [{ userCursor: 'u', promptHash: 'proof', state: 'completed' as const }],
  });
  const b = makeBridge(undefined, {
    history,
    now: () => now,
    nativeUi: {
      enabled: () => true,
      sessions: async () => [
        {
          id: 's1',
          name: 'one',
          host: 'test',
          caseName: 'Test',
          mode: 'codex',
          conversation: 'native1',
          working: false,
          ready: true,
          pending: false,
          exited: false,
        },
      ],
      cases: async () => [],
      defaults: async () => ({ model: '', effort: '', approval: 'ask' }),
      saveDefaults: async () => {},
      question: () => undefined,
      answer: async () => '',
      workspace: async () => ({ summary: '', diff: '' }),
      submitQueued: async () => 'blocked',
    },
  });
  await b.reload();
  await b.syncSessions();
  await b.pollConversations();
  turns = [
    { role: 'user', cursor: 'u', timestamp: new Date(1000).toISOString(), text: 'Task' },
    {
      role: 'assistant',
      cursor: 'answer',
      phase: 'final_answer',
      timestamp: new Date(2000).toISOString(),
      text: 'Exact delivered final.',
    },
  ];
  now += 21000;
  await b.pollConversations();
  const sent = [...remoteMessages.values()].find((m) => visibleText(m) === 'Exact delivered final.');
  expect(sent).toBeDefined();
  now += 21000;
  await b.pollConversations();
  const dashboard = [...remoteMessages.values()].find((m) =>
    discordUiNodes(m.components).some((c) => String(c.content ?? '').includes('## Activity'))
  );
  expect(dashboard).toBeDefined();
  const link = discordUiNodes(dashboard.components).find((c) => c.label === 'View reply');
  expect(link?.url).toBe(`https://discord.com/channels/${cfg.guildId}/${sent.channel_id}/${sent.id}`);
  expect(sendInput).not.toHaveBeenCalled();
});
it('suppresses an acknowledged Claude queued human prompt without inferring execution or hiding a later external prompt', async () => {
  const { parseDiscordHistory } = await import('../src/discord-history.js');
  const conv = '12345678-1234-1234-1234-123456789abc',
    text = 'Queued multiline\n\nhuman prompt';
  const rows: unknown[] = [
    {
      type: 'assistant',
      sessionId: conv,
      uuid: 'old',
      message: { content: [{ type: 'text', text: 'Old answer' }], stop_reason: 'end_turn' },
    },
  ];
  const history = async () =>
    parseDiscordHistory(
      { mode: 'claude', conversationId: conv },
      JSON.stringify({
        offset: 0,
        data: Buffer.from(rows.map((r) => JSON.stringify(r) + '\n').join('')).toString('base64'),
        partial: false,
      })
    );
  let now = 100000;
  sessions = [{ id: 's1', name: 'one' }];
  const b = makeBridge(undefined, { history, now: () => now });
  await b.reload();
  await b.syncSessions();
  posts = [];
  const channel = (await readFullMap(dir)).s1;
  await b.onGatewayMessage({
    id: '900000000000000090',
    guild_id: cfg.guildId,
    channel_id: channel,
    author: { id: cfg.allowedUserIds[0] },
    content: text,
  });
  rows.push({
    type: 'attachment',
    sessionId: conv,
    uuid: 'queued',
    parentUuid: 'old',
    attachment: {
      type: 'queued_command',
      origin: { kind: 'human' },
      commandMode: 'prompt',
      prompt: text,
      humanTurn: true,
    },
  });
  rows.push({
    type: 'assistant',
    sessionId: conv,
    parentUuid: 'queued',
    uuid: 'unrelated-final',
    message: { content: [{ type: 'text', text: 'Other ongoing work finished' }], stop_reason: 'end_turn' },
  });
  expect((await history()).executions).toEqual([]);
  now += 60001;
  await b.pollConversations();
  expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body) === text)).toHaveLength(0);
  const ledger = JSON.parse(await readFile(join(dir, 'discord-delivery.json'), 'utf8'));
  const receipt = ledger.find((r: any) => r.messageId === '900000000000000090' && r.direction === 'inbound');
  expect(receipt.native.userCursor).toBe((await history()).turns.find((t) => t.role === 'user')!.cursor);
  expect(receipt.state).toBe('input_accepted');
  b.stop();
  rows.push({ type: 'user', sessionId: conv, uuid: 'external', message: { content: text } });
  const restarted = makeBridge(undefined, { history, now: () => now });
  await restarted.reload();
  await restarted.syncSessions();
  now += 60001;
  await restarted.pollConversations();
  expect(posts.filter((p) => p.method === 'POST' && visibleText(p.body) === text)).toHaveLength(1);
  expect(sendInput).toHaveBeenCalledTimes(1);
});

async function directBusyBridge(mode: string, pending = false) {
  sessions = [{ id: 's1', name: 'one', working: true }];
  const nativeUi: NonNullable<import('../src/discord-bridge.js').DiscordBridgeDeps['nativeUi']> = {
    enabled: () => true,
    sessions: async () => [
      {
        id: 's1',
        name: 'one',
        host: 'test',
        caseName: 'Test',
        mode,
        conversation: 'native1',
        working: true,
        ready: false,
        pending,
        exited: false,
      },
    ],
    cases: async () => [],
    defaults: async () => ({ model: '', effort: '', approval: 'ask' }),
    saveDefaults: async () => {},
    question: () => undefined,
    answer: async () => '',
    workspace: async () => ({ summary: '', diff: '' }),
    submitQueued: async () => 'blocked',
  };
  const b = makeBridge(undefined, {
    nativeUi,
    awaitingChoice: () => pending,
    history: async () => ({ conversationId: 'native1', turns: [], partial: false }),
  });
  await b.reload();
  await b.syncSessions();
  const thread = (await readFullMap(dir)).s1;
  const message = {
    id: '900000000000000001',
    guild_id: cfg.guildId,
    channel_id: thread,
    author: { id: cfg.allowedUserIds[0] },
    content: "What's the status of the 5 agent runs?\nKeep the current work running.",
  };
  return { b, message };
}
it.each(['claude', 'codex'])(
  'sends an ordinary busy %s reply directly once, without a timing chooser',
  async (mode) => {
    const { b, message } = await directBusyBridge(mode);
    await b.onGatewayMessage(message);
    await b.onGatewayMessage(message);
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('s1', message.content + '\r');
    const record = JSON.parse(await readFile(join(dir, 'discord-delivery.json'), 'utf8')).find(
      (r: any) => r.id === 'in:' + cfg.guildId + ':' + message.id
    );
    expect(record.state).toBe('input_accepted');
    expect(record.native.conversationId).toBe('native1');
    expect(posts.some((p) => (p.body?.content ?? '').includes('When should this follow-up run?'))).toBe(false);
  }
);
it('still blocks busy replies when a native question or permission dialog is pending', async () => {
  const { b, message } = await directBusyBridge('claude', true);
  await b.onGatewayMessage(message);
  expect(sendInput).not.toHaveBeenCalled();
  expect(posts.some((p) => (p.body?.content ?? '').includes('A question or permission dialog is pending'))).toBe(true);
});
it.each(['false', 'throw'])(
  'keeps an unconfirmed busy send uncertain and never automatically replays it (%s)',
  async (outcome) => {
    const { b, message } = await directBusyBridge('claude');
    if (outcome === 'throw') sendInput.mockRejectedValueOnce(Error('Unconfirmed transport'));
    else sendInput.mockResolvedValueOnce(false);
    await b.onGatewayMessage(message);
    await b.onGatewayMessage(message);
    expect(sendInput).toHaveBeenCalledOnce();
    const record = JSON.parse(await readFile(join(dir, 'discord-delivery.json'), 'utf8')).find(
      (r: any) => r.id === 'in:' + cfg.guildId + ':' + message.id
    );
    expect(record.state).toBe('uncertain');
  }
);
