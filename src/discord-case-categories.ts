/** Private Full-mode category provisioning with durable, non-name-based ownership. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DiscordChannelApi, DiscordManagedChannel } from './discord-session-channels.js';
interface Scope {
  guildId: string;
  botId: string;
  users: string[];
}
interface Entry extends Scope {
  intent: string;
  phase: 'intent' | 'creating' | 'active';
  categoryId?: string;
}
export interface DiscordCategoryApi extends DiscordChannelApi {
  botId(): Promise<string>;
}
export class DiscordCategoryProblem extends Error {
  constructor(
    message: string,
    readonly status = 502
  ) {
    super(message);
  }
}
const snow = (id: unknown): id is string => typeof id === 'string' && /^\d{15,25}$/.test(id);
const keyOf = (s: Scope) =>
  createHash('sha256')
    .update(JSON.stringify([s.guildId, s.botId, s.users]))
    .digest('hex');
const marker = (e: Entry) => 'Codeman-setup-' + e.intent;
const VIEW = 1024n;
const USER_PERMS = [6, 10, 11, 14, 15, 16, 35, 38].reduce((v, bit) => v | (1n << BigInt(bit)), 0n);
const BOT_PERMS = USER_PERMS | 16n | (1n << 34n);
function overwrites(e: Scope) {
  return [
    { id: e.guildId, type: 0, allow: '0', deny: String(VIEW) },
    { id: e.botId, type: 1, allow: String(BOT_PERMS), deny: '0' },
    ...e.users.filter((id) => id !== e.botId).map((id) => ({ id, type: 1, allow: String(USER_PERMS), deny: '0' })),
  ];
}
function owned(e: Entry, c: DiscordManagedChannel | null): c is DiscordManagedChannel {
  if (!c || c.type !== 4 || c.guild_id !== e.guildId || (e.categoryId && c.id !== e.categoryId)) return false;
  const expected = overwrites(e),
    actual = c.permission_overwrites;
  return (
    !!actual &&
    actual.length === expected.length &&
    expected.every((w) =>
      actual.some((a) => a.id === w.id && a.type === w.type && a.allow === w.allow && a.deny === w.deny)
    )
  );
}
export class DiscordCaseCategories {
  private entries: Record<string, Entry> = {};
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<string>>();
  constructor(private readonly dir: string) {}
  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      try {
        const path = join(this.dir, 'discord-case-categories.json'),
          info = await fs.lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error();
        const raw = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, Entry>;
        if (!raw || Array.isArray(raw) || typeof raw !== 'object' || Object.keys(raw).length > 128) throw new Error();
        for (const [key, e] of Object.entries(raw)) {
          if (
            !e ||
            !snow(e.guildId) ||
            !snow(e.botId) ||
            !Array.isArray(e.users) ||
            e.users.length > 20 ||
            !e.users.every(snow) ||
            JSON.stringify([...new Set(e.users)].sort()) !== JSON.stringify(e.users) ||
            key !== keyOf(e) ||
            !/^[a-f0-9-]{36}$/.test(e.intent) ||
            !['intent', 'creating', 'active'].includes(e.phase) ||
            (e.categoryId !== undefined && !snow(e.categoryId)) ||
            (e.phase === 'active' && !e.categoryId)
          )
            throw new Error();
        }
        this.entries = raw;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new DiscordCategoryProblem(
            'Category ownership cannot be read. Setup is paused; do not delete the ownership file.'
          );
      }
    })());
  }
  private edit(fn: (entries: Record<string, Entry>) => void): Promise<void> {
    const run = this.writes.then(async () => {
      await this.load();
      const next = structuredClone(this.entries);
      fn(next);
      if (Object.keys(next).length > 128) throw new DiscordCategoryProblem('Category ownership registry is full');
      await fs.mkdir(this.dir, { recursive: true });
      const path = join(this.dir, 'discord-case-categories.json'),
        temp = path + '.' + randomUUID() + '.tmp';
      try {
        const f = await fs.open(temp, 'wx', 0o600);
        try {
          await f.writeFile(JSON.stringify(next));
          await f.sync();
        } finally {
          await f.close();
        }
        await fs.rename(temp, path);
        this.entries = next;
      } finally {
        await fs.unlink(temp).catch(() => undefined);
      }
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
  async forConfig(config: { guildId: string; allowedUserIds: string[] }, api: DiscordCategoryApi): Promise<string> {
    try {
      const botId = await api.botId();
      const scope = { guildId: config.guildId, botId, users: [...new Set(config.allowedUserIds)].sort() };
      if (!snow(scope.guildId) || !snow(botId) || !scope.users.length || !scope.users.every(snow))
        throw new DiscordCategoryProblem('Valid bot, server and allowed users are required');
      const key = keyOf(scope),
        existing = this.pending.get(key);
      if (existing) return await existing;
      const run = this.ensure(scope, api).finally(() => {
        if (this.pending.get(key) === run) this.pending.delete(key);
      });
      this.pending.set(key, run);
      return await run;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403)
        throw new DiscordCategoryProblem(
          'Discord bot needs Manage Channels and Manage Threads. Update its server role permissions, then save again.',
          403
        );
      if (status === 401)
        throw new DiscordCategoryProblem('Discord bot authentication failed. Check its token before saving.', 400);
      if (err instanceof DiscordCategoryProblem) throw err;
      throw new DiscordCategoryProblem(
        'Could not confirm private category setup. Retry Save; an uncertain creation will be reconciled before another is attempted.'
      );
    }
  }
  private async ensure(scope: Scope, api: DiscordCategoryApi): Promise<string> {
    await this.load();
    const key = keyOf(scope);
    if (!this.entries[key])
      await this.edit((s) => {
        s[key] ??= { ...scope, intent: randomUUID(), phase: 'intent' };
      });
    let e = this.entries[key],
      category: DiscordManagedChannel | null = null;
    if (e.categoryId) {
      try {
        category = await api.get(e.categoryId);
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
        await this.edit((s) => {
          s[key] = { ...scope, intent: randomUUID(), phase: 'intent' };
        });
        e = this.entries[key];
      }
      if (e.categoryId && !category) throw new DiscordCategoryProblem('Recorded category could not be confirmed');
      if (category && !owned(e, category))
        throw new DiscordCategoryProblem(
          'Recorded category privacy or ownership changed. Choose a category explicitly or restore its private permissions.'
        );
    }
    if (!category && e.phase === 'creating') {
      const matches = (await api.list(scope.guildId))?.filter((c) => c.name === marker(e) && owned(e, c));
      if (!matches || matches.length !== 1)
        throw new DiscordCategoryProblem(
          'Private category creation is uncertain. Inspect Discord before retrying; no duplicate category was created.'
        );
      category = matches[0];
    }
    if (!category) {
      await this.edit((s) => {
        s[key].phase = 'creating';
      });
      try {
        category = await api.create(scope.guildId, { name: marker(e), type: 4, permission_overwrites: overwrites(e) });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 408)
          await this.edit((s) => {
            s[key].phase = 'intent';
          });
        throw err;
      }
    }
    if (!owned(e, category) || !snow(category.id))
      throw new DiscordCategoryProblem('Discord did not confirm a private category');
    const id = category.id;
    await this.edit((s) => {
      s[key] = { ...s[key], categoryId: id, phase: 'active' };
    });
    if (category.name === marker(e)) await api.edit(id, { name: 'Codeman' });
    return id;
  }
}
