import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordCaseCategories, type DiscordCategoryApi } from '../src/discord-case-categories.js';
import type { DiscordManagedChannel } from '../src/discord-session-channels.js';
const config = { guildId: '111111111111111111', allowedUserIds: ['333333333333333333'] };
const bot = '888888888888888888';
let dir: string, api: DiscordCategoryApi, channels: Map<string, DiscordManagedChannel>, serial: bigint;
const manager = () => new DiscordCaseCategories(dir);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-categories-'));
  channels = new Map();
  serial = 444444444444444440n;
  api = {
    botId: vi.fn(async () => bot),
    get: vi.fn(async (id) => {
      const c = channels.get(id);
      if (!c) throw Object.assign(new Error('missing'), { status: 404 });
      return structuredClone(c);
    }),
    list: vi.fn(async () => [...channels.values()].map((c) => structuredClone(c))),
    create: vi.fn(async (guild, body) => {
      const c = { ...body, id: String(++serial), guild_id: guild } as DiscordManagedChannel;
      channels.set(c.id, c);
      return structuredClone(c);
    }),
    edit: vi.fn(async (id, body) => {
      Object.assign(channels.get(id)!, body);
    }),
    remove: vi.fn(async () => {}),
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe('automatic private case category', () => {
  it('creates one private category under concurrent saves and reuses the recorded ID after restart', async () => {
    const m = manager();
    const [a, b] = await Promise.all([m.forConfig(config, api), m.forConfig(config, api)]);
    expect(a).toBe(b);
    expect(api.create).toHaveBeenCalledTimes(1);
    const c = channels.get(a)!;
    expect(c.name).toBe('Codeman');
    expect(c.type).toBe(4);
    const grants = c.permission_overwrites!;
    expect(grants.find((w) => w.id === config.guildId)).toMatchObject({ type: 0, allow: '0', deny: '1024' });
    expect(
      grants
        .filter((w) => w.type === 1)
        .map((w) => w.id)
        .sort()
    ).toEqual([config.allowedUserIds[0], bot].sort());
    expect(grants.every((w) => (BigInt(w.allow) & 8n) === 0n)).toBe(true);
    expect(await manager().forConfig(config, api)).toBe(a);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect((await stat(join(dir, 'discord-case-categories.json'))).mode & 0o777).toBe(0o600);
  });
  it('reconciles only its unique temporary setup marker after a lost create acknowledgement', async () => {
    const create = api.create;
    api.create = vi.fn(async (...args) => {
      await create(...args);
      throw new Error('lost');
    });
    await expect(manager().forConfig(config, api)).rejects.toThrow();
    const id = await manager().forConfig(config, api);
    expect(channels.get(id)!.name).toBe('Codeman');
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('does not blindly retry or adopt a same-name unowned category after uncertain creation', async () => {
    api.create = vi.fn(async () => {
      throw new Error('lost');
    });
    await expect(manager().forConfig(config, api)).rejects.toThrow();
    channels.set('777777777777777777', {
      id: '777777777777777777',
      type: 4,
      guild_id: config.guildId,
      name: 'Codeman',
    });
    await expect(manager().forConfig(config, api)).rejects.toThrow(/uncertain/);
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('surfaces a permission refusal and allows retry after permissions are granted', async () => {
    const create = api.create;
    api.create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { status: 403 }))
      .mockImplementation(create);
    const m = manager();
    await expect(m.forConfig(config, api)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Manage Channels and Manage Threads'),
    });
    expect(await m.forConfig(config, api)).toBeTruthy();
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it('keeps the owned ID if the final rename is interrupted', async () => {
    const edit = api.edit;
    api.edit = vi.fn().mockRejectedValueOnce(new Error('lost')).mockImplementation(edit);
    await expect(manager().forConfig(config, api)).rejects.toThrow();
    const id = await manager().forConfig(config, api);
    expect(channels.get(id)!.name).toBe('Codeman');
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('refuses a recorded category whose privacy was widened', async () => {
    const m = manager(),
      id = await m.forConfig(config, api);
    channels.get(id)!.permission_overwrites![0].deny = '0';
    await expect(m.forConfig(config, api)).rejects.toThrow(/privacy/);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('creates a new scope for a different allowlist or server without modifying old history', async () => {
    const m = manager(),
      a = await m.forConfig(config, api),
      b = await m.forConfig({ ...config, allowedUserIds: ['777777777777777777'] }, api);
    expect(a).not.toBe(b);
    expect(channels.has(a)).toBe(true);
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('rotates its intent after a confirmed external deletion', async () => {
    const m = manager(),
      a = await m.forConfig(config, api);
    channels.delete(a);
    const b = await m.forConfig(config, api);
    expect(b).not.toBe(a);
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it('fails closed on corrupt ownership metadata before creating any resources', async () => {
    await writeFile(join(dir, 'discord-case-categories.json'), 'broken');
    await expect(manager().forConfig(config, api)).rejects.toThrow(/ownership/);
    expect(api.create).not.toHaveBeenCalled();
  });
});
