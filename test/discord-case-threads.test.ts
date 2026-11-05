import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DiscordCaseThreads, type DiscordCaseThreadApi, type DiscordStarter } from '../src/discord-case-threads.js';
import type { DiscordManagedChannel } from '../src/discord-session-channels.js';
const scope = { guildId: '111111111111111111', categoryId: '222222222222222222' };
const bot = '888888888888888888';
const identity = { key: 'a'.repeat(64), name: 'saif' };
let dir: string, now: number, serial: bigint;
let channels: Map<string, DiscordManagedChannel>, messages: Map<string, DiscordStarter>;
let api: DiscordCaseThreadApi;
const missing = () => Object.assign(new Error('missing'), { status: 404 });
const manager = (resolve = async (_id: string) => identity, live = () => true) =>
  new DiscordCaseThreads(dir, api, resolve, () => now, live);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-case-threads-'));
  now = 1000;
  serial = 444444444444444440n;
  channels = new Map([[scope.categoryId, { id: scope.categoryId, type: 4, guild_id: scope.guildId }]]);
  messages = new Map();
  api = {
    botId: vi.fn(async () => bot),
    get: vi.fn(async (id) => {
      const c = channels.get(id);
      if (!c) throw missing();
      return structuredClone(c);
    }),
    list: vi.fn(async () => [...channels.values()]),
    create: vi.fn(async (guild, body) => {
      const c = { ...body, id: String(++serial), guild_id: guild } as DiscordManagedChannel;
      channels.set(c.id, c);
      return structuredClone(c);
    }),
    edit: vi.fn(async (id, body) => {
      const c = channels.get(id);
      if (!c) throw missing();
      Object.assign(c, body);
      if (c.thread_metadata && typeof body.archived === 'boolean') c.thread_metadata.archived = body.archived;
    }),
    remove: vi.fn(async (id) => {
      channels.delete(id);
    }),
    postStarter: vi.fn(async (parent, body) => {
      const old = [...messages.values()].find((m) => m.channel_id === parent && m.nonce === body.nonce);
      if (old) return old;
      const m = { id: String(++serial), channel_id: parent, author: { id: bot }, nonce: body.nonce };
      messages.set(m.id, m);
      return m;
    }),
    getStarter: vi.fn(async (parent, id) => {
      const m = messages.get(id);
      if (!m || m.channel_id !== parent) throw missing();
      return m;
    }),
    listStarters: vi.fn(async (parent) => [...messages.values()].filter((m) => m.channel_id === parent)),
    createThread: vi.fn(async (parent, starter, name) => {
      const t = {
        id: starter,
        type: 11,
        guild_id: scope.guildId,
        parent_id: parent,
        owner_id: bot,
        name,
        thread_metadata: { archived: false, locked: false },
      };
      channels.set(t.id, t);
      return structuredClone(t);
    }),
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe('owned case channels and session threads', () => {
  it('creates one shared parent and two exact threads concurrently, coalesces and restores mappings', async () => {
    const m = manager();
    const [a, b, again] = await Promise.all([
      m.forSession(scope, 's1', 'w1-saif'),
      m.forSession(scope, 's2', 'w2-saif'),
      m.forSession(scope, 's1', 'w1-saif'),
    ]);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.createThread).toHaveBeenCalledTimes(2);
    const parent = channels.get(a)!.parent_id!;
    expect(channels.get(b)!.parent_id).toBe(parent);
    expect(channels.get(parent)?.name).toBe('saif');
    expect(m.caseForChannel(scope, parent)).toBe(identity.key);
    expect(m.sessionForChannel(scope, a)).toBe('s1');
    expect(m.sessionsForCase(scope, identity.key)).toHaveLength(2);
    expect((await stat(join(dir, 'discord-case-threads.json'))).mode & 0o777).toBe(0o600);
    expect(await manager().forSession(scope, 's1', 'w1-saif')).toBe(a);
    expect(api.createThread).toHaveBeenCalledTimes(2);
  });
  it.each(['recent', 'aged'] as const)(
    'reconciles a lost starter response (%s) without creating a duplicate',
    async (age) => {
      const post = api.postStarter;
      api.postStarter = vi.fn(async (...args) => {
        await post(...args);
        throw new TypeError('lost');
      });
      await expect(manager().forSession(scope, 's1')).rejects.toThrow();
      api.postStarter = post;
      if (age === 'aged') now += 120001;
      const t = await manager().forSession(scope, 's1');
      expect(messages.size).toBe(1);
      expect(channels.get(t)?.type).toBe(11);
      if (age === 'aged') expect(api.listStarters).toHaveBeenCalledTimes(1);
    }
  );
  it('refuses an aged uncertain starter when its exact nonce cannot be reconciled', async () => {
    api.postStarter = vi.fn(async () => {
      throw new TypeError('lost');
    });
    await expect(manager().forSession(scope, 's1')).rejects.toThrow();
    now += 120001;
    await expect(manager().forSession(scope, 's1')).rejects.toThrow(/uncertain/);
    expect(api.postStarter).toHaveBeenCalledTimes(1);
    expect(api.createThread).not.toHaveBeenCalled();
  });
  it('reconciles a lost thread-create response using only its starter ID', async () => {
    const create = api.createThread;
    api.createThread = vi.fn(async (...args) => {
      await create(...args);
      throw new TypeError('lost');
    });
    const t = await manager().forSession(scope, 's1');
    expect(await manager().forSession(scope, 's1')).toBe(t);
    expect(api.createThread).toHaveBeenCalledTimes(1);
  });
  it('keeps an uncertain thread intent across restart and safely retries the same message endpoint', async () => {
    const create = api.createThread;
    api.createThread = vi.fn(async () => {
      throw new TypeError('lost');
    });
    await expect(manager().forSession(scope, 's1')).rejects.toThrow();
    api.createThread = create;
    await manager().forSession(scope, 's1');
    expect(messages.size).toBe(1);
    expect(api.createThread).toHaveBeenCalledTimes(1);
  });
  it.each(['owner_id', 'parent_id', 'guild_id'] as const)(
    'refuses routing and deletion for changed %s',
    async (field) => {
      const m = manager(),
        t = await m.forSession(scope, 's1');
      channels.get(t)![field] = '999999999999999999';
      await expect(m.assertOwned(scope, 's1', t)).rejects.toThrow(/ownership/);
      await expect(m.deleted('s1', 'delete', scope.guildId)).rejects.toThrow(/ownership/);
      expect(api.remove).not.toHaveBeenCalled();
    }
  );
  it('refuses a changed case topic and does not adopt a same-name foreign thread', async () => {
    const m = manager(),
      t = await m.forSession(scope, 's1');
    channels.get(channels.get(t)!.parent_id!)!.topic = 'foreign';
    await expect(m.assertOwned(scope, 's1', t)).rejects.toThrow(/ownership/);
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('reopens archived active threads, refuses locked threads and recreates externally deleted threads', async () => {
    const m = manager(),
      t = await m.forSession(scope, 's1');
    channels.get(t)!.thread_metadata!.archived = true;
    await m.assertOwned(scope, 's1', t);
    expect(channels.get(t)!.thread_metadata!.archived).toBe(false);
    channels.get(t)!.thread_metadata!.locked = true;
    await expect(m.forSession(scope, 's1')).rejects.toThrow(/locked/);
    channels.delete(t);
    const replacement = await m.forSession(scope, 's1');
    expect(replacement).not.toBe(t);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(m.sessionForChannel(scope, t)).toBeUndefined();
  });
  it.each(['keep', 'archive', 'delete'] as const)(
    '%s closes only the deleted session thread and preserves its sibling and shared parent',
    async (policy) => {
      const m = manager(),
        a = await m.forSession(scope, 's1'),
        b = await m.forSession(scope, 's2');
      const parent = channels.get(a)!.parent_id!;
      await m.deleted('s1', policy, scope.guildId);
      expect(m.sessionForChannel(scope, a)).toBeUndefined();
      expect(channels.has(parent)).toBe(true);
      expect(await m.forSession(scope, 's2')).toBe(b);
      expect(channels.has(a)).toBe(policy !== 'delete');
      if (policy === 'archive') expect(channels.get(a)!.thread_metadata!.archived).toBe(true);
      if (policy === 'delete') expect(api.remove).toHaveBeenCalledExactlyOnceWith(a);
      else expect(api.remove).not.toHaveBeenCalled();
      await expect(manager().forSession(scope, 's1')).rejects.toThrow(/deleted/);
    }
  );
  it('preserves a failed retirement for retry across restart', async () => {
    const m = manager(),
      t = await m.forSession(scope, 's1'),
      remove = api.remove;
    api.remove = vi.fn().mockRejectedValueOnce(new Error('denied')).mockImplementation(remove);
    await expect(m.deleted('s1', 'delete', scope.guildId)).rejects.toThrow();
    const restored = manager();
    await restored.load();
    expect(restored.sessionForChannel(scope, t)).toBeUndefined();
    await restored.flushRetirements(scope.guildId);
    expect(channels.has(t)).toBe(false);
  });
  it('retires a thread created while its session was being deleted, without touching the parent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const create = api.createThread;
    api.createThread = vi.fn(async (...args) => {
      const t = await create(...args);
      await gate;
      return t;
    });
    const m = manager(),
      pending = m.forSession(scope, 's1');
    const rejection = expect(pending).rejects.toThrow(/deleted/);
    await vi.waitFor(() => expect(api.createThread).toHaveBeenCalledTimes(1));
    await m.deleted('s1', 'delete', scope.guildId);
    release();
    await rejection;
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect([...channels.values()].filter((c) => c.type === 0)).toHaveLength(1);
  });
  it('preserves old history when case metadata moves and routes only the current mapping', async () => {
    let identityNow = identity;
    const m = manager(async () => identityNow);
    const a = await m.forSession(scope, 's1');
    identityNow = { key: 'b'.repeat(64), name: 'other' };
    const b = await m.forSession(scope, 's1');
    expect(b).not.toBe(a);
    expect(channels.has(a)).toBe(true);
    expect(m.sessionForChannel(scope, a)).toBeUndefined();
    expect(m.sessionForChannel(scope, b)).toBe('s1');
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('stops child creation if configuration changed during parent provisioning', async () => {
    let live = true;
    const create = api.create;
    api.create = vi.fn(async (...args) => {
      const c = await create(...args);
      live = false;
      return c;
    });
    await expect(manager(undefined, () => live).forSession(scope, 's1')).rejects.toThrow(/changed/);
    expect(api.createThread).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('keeps flat legacy channels untouched and refuses corrupt new ownership metadata', async () => {
    const old = '{"legacy":"preserve"}';
    await writeFile(join(dir, 'discord-channels.json'), old);
    await manager().forSession(scope, 's1');
    expect(await readFile(join(dir, 'discord-channels.json'), 'utf8')).toBe(old);
    await writeFile(join(dir, 'discord-case-threads.json'), 'broken');
    await expect(manager().forSession(scope, 's2')).rejects.toThrow(/ownership/);
    expect(api.createThread).toHaveBeenCalledTimes(1);
  });
});
