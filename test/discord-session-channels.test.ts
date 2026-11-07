import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  DiscordSessionChannels,
  type DiscordManagedChannel,
  type DiscordChannelApi,
} from '../src/discord-session-channels.js';
const scope = { guildId: '111111111111111111', categoryId: '222222222222222222' };
let dir: string;
let channels: Map<string, DiscordManagedChannel>;
let api: DiscordChannelApi;
let sequence: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-channels-'));
  sequence = 0;
  channels = new Map([
    [scope.categoryId, { id: scope.categoryId, type: 4, guild_id: scope.guildId, permission_overwrites: [] }],
  ]);
  api = {
    get: vi.fn(async (id) => {
      const c = channels.get(id);
      if (!c) throw Object.assign(new Error('missing'), { status: 404 });
      return { ...c };
    }),
    list: vi.fn(async () => [...channels.values()]),
    create: vi.fn(async (guild, body) => {
      const c = {
        ...body,
        id: String(444444444444444440n + BigInt(sequence++)),
        guild_id: guild,
      } as DiscordManagedChannel;
      channels.set(c.id, c);
      return c;
    }),
    edit: vi.fn(async (id, body) => {
      Object.assign(channels.get(id)!, body);
    }),
    remove: vi.fn(async (id) => {
      channels.delete(id);
    }),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
describe('owned session channels', () => {
  it('creates once under concurrent requests and reuses after restart', async () => {
    const m = new DiscordSessionChannels(dir, api);
    const [a, b] = await Promise.all([m.forSession(scope, 's1', 'Brain'), m.forSession(scope, 's1', 'Brain')]);
    expect(a).toBe(b);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect((await stat(join(dir, 'discord-channels.json'))).mode & 0o777).toBe(0o600);
    expect(await new DiscordSessionChannels(dir, api).forSession(scope, 's1', 'Brain')).toBe(a);
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('keeps different categories and servers distinct', async () => {
    const m = new DiscordSessionChannels(dir, api);
    const a = await m.forSession(scope, 's1', 'Brain');
    const other = { ...scope, categoryId: '333333333333333333' };
    channels.set(other.categoryId, { id: other.categoryId, type: 4, guild_id: scope.guildId });
    const b = await m.forSession(other, 's1', 'Brain');
    expect(a).not.toBe(b);
    expect(channels.has(a)).toBe(true);
    expect(await m.forSession(scope, 's1', 'Brain')).toBe(a);
  });
  it('adopts only its outstanding intent after a lost create response', async () => {
    const create = api.create;
    api.create = vi.fn(async (...args) => {
      await create(...args);
      throw new TypeError('lost response');
    });
    const m = new DiscordSessionChannels(dir, api);
    await expect(m.forSession(scope, 's1', 'Brain')).rejects.toThrow();
    const restored = new DiscordSessionChannels(dir, api);
    const id = await restored.forSession(scope, 's1', 'Brain');
    expect(channels.get(id)?.name).toContain('brain');
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('does not blindly retry uncertain creation when nothing can be reconciled', async () => {
    api.create = vi.fn(async () => {
      throw new TypeError('network');
    });
    const m = new DiscordSessionChannels(dir, api);
    await expect(m.forSession(scope, 's1')).rejects.toThrow();
    await expect(m.forSession(scope, 's1')).rejects.toThrow(/uncertain/);
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('allows retry after a definitive permission refusal', async () => {
    const create = api.create;
    api.create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { status: 403 }))
      .mockImplementation(create);
    const m = new DiscordSessionChannels(dir, api);
    await expect(m.forSession(scope, 's1')).rejects.toThrow();
    expect(await m.forSession(scope, 's1')).toBeTruthy();
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it('refuses another guild category', async () => {
    channels.get(scope.categoryId)!.guild_id = '999999999999999999';
    await expect(new DiscordSessionChannels(dir, api).forSession(scope, 's1')).rejects.toThrow(/configured/);
    expect(api.create).not.toHaveBeenCalled();
  });
  it('does not adopt a same-name channel or an old copied marker after known deletion', async () => {
    const m = new DiscordSessionChannels(dir, api);
    const a = await m.forSession(scope, 's1', 'Brain');
    const copy = { ...channels.get(a)!, id: '777777777777777777' };
    channels.delete(a);
    channels.set(copy.id, copy);
    const b = await m.forSession(scope, 's1', 'Brain');
    expect(b).not.toBe(copy.id);
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it('refuses mutation if the positively recorded channel changed ownership', async () => {
    const m = new DiscordSessionChannels(dir, api);
    const a = await m.forSession(scope, 's1');
    channels.get(a)!.topic = 'someone else';
    await expect(m.rename(scope, 's1', 'changed')).rejects.toThrow(/ownership/);
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('does not create or delete anything for a corrupted ownership file', async () => {
    await writeFile(join(dir, 'discord-channels.json'), 'bad JSON');
    const m = new DiscordSessionChannels(dir, api);
    await expect(m.forSession(scope, 's1')).rejects.toThrow(/ownership/);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });
});
