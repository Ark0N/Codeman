/** Owned session channels. Names never authorize adoption or deletion; persisted identity and topic do. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type DiscordChannelDelete = 'keep' | 'retain' | 'delete';
export interface DiscordManagedChannel {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
  topic?: string | null;
  name?: string;
  owner_id?: string;
  thread_metadata?: { archived: boolean; locked?: boolean };
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
}
export interface DiscordChannelApi {
  get(id: string): Promise<DiscordManagedChannel | null>;
  list(guild: string): Promise<DiscordManagedChannel[] | null>;
  create(guild: string, body: Record<string, unknown>): Promise<DiscordManagedChannel | null>;
  edit(id: string, body: Record<string, unknown>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}
export interface DiscordChannelScope {
  guildId: string;
  categoryId: string;
}
interface Entry extends DiscordChannelScope {
  sessionId: string;
  intentId: string;
  channelId?: string;
  state: 'creating' | 'active' | 'failed' | 'retiring' | 'kept' | 'retained' | 'deleted';
  policy?: DiscordChannelDelete;
}
interface State {
  instanceId: string;
  entries: Record<string, Entry>;
  deleted: Record<string, DiscordChannelDelete>;
}
export class DiscordChannelProblem extends Error {}
const snowflake = (s: unknown): s is string => typeof s === 'string' && /^\d{15,25}$/.test(s);
const keyOf = (s: DiscordChannelScope, id: string) => JSON.stringify([s.guildId, s.categoryId, id]);
export function discordSessionChannelName(name: string | undefined, id: string): string {
  const base =
    (name ?? 'session')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'session';
  return base.slice(0, 90) + '-' + id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

export class DiscordSessionChannels {
  private state: State = { instanceId: randomUUID(), entries: {}, deleted: {} };
  private loadRun?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private pending = new Map<string, Promise<string>>();
  private retireRun?: Promise<void>;
  constructor(
    private readonly dir: string,
    private readonly api: DiscordChannelApi,
    private readonly options: {
      fileName?: string;
      kind?: 'case';
      name?: (name: string | undefined, id: string) => string;
    } = {}
  ) {}
  private marker(e: Entry): string {
    return (
      'Codeman ' +
      this.state.instanceId +
      ' ' +
      (this.options.kind ?? 'session') +
      ' ' +
      e.sessionId +
      ' intent ' +
      e.intentId
    );
  }
  load(): Promise<void> {
    this.loadRun ??= (async () => {
      try {
        const path = join(this.dir, this.options.fileName ?? 'discord-channels.json');
        const info = await fs.lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error();
        const raw = JSON.parse(await fs.readFile(path, 'utf8')) as State;
        if (
          !raw ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.instanceId) ||
          !raw.entries ||
          !raw.deleted ||
          Object.keys(raw.entries).length > 4096 ||
          Object.keys(raw.deleted).length > 4096
        )
          throw new Error();
        for (const [key, e] of Object.entries(raw.entries)) {
          if (
            !e ||
            !snowflake(e.guildId) ||
            !snowflake(e.categoryId) ||
            typeof e.sessionId !== 'string' ||
            e.sessionId.length > 100 ||
            typeof e.intentId !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(e.intentId) ||
            key !== keyOf(e, e.sessionId) ||
            (e.channelId !== undefined && !snowflake(e.channelId)) ||
            !['creating', 'active', 'failed', 'retiring', 'kept', 'retained', 'deleted'].includes(e.state) ||
            (e.policy !== undefined && !['keep', 'retain', 'delete'].includes(e.policy))
          )
            throw new Error();
        }
        for (const [id, policy] of Object.entries(raw.deleted))
          if (id.length > 100 || !['keep', 'retain', 'delete'].includes(policy)) throw new Error();
        this.state = raw;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new DiscordChannelProblem('Session channel ownership file cannot be read; channel sync is paused');
      }
    })();
    return this.loadRun;
  }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    const run = this.writes
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(this.dir, { recursive: true });
        const path = join(this.dir, this.options.fileName ?? 'discord-channels.json'),
          tmp = path + '.' + randomUUID() + '.tmp';
        try {
          const file = await fs.open(tmp, 'wx', 0o600);
          try {
            await file.writeFile(snapshot);
            await file.sync();
          } finally {
            await file.close();
          }
          await fs.rename(tmp, path);
        } finally {
          await fs.unlink(tmp).catch(() => undefined);
        }
      });
    this.writes = run;
    return run;
  }
  sessionForChannel(scope: DiscordChannelScope, channel: string): string | undefined {
    return Object.values(this.state.entries).find(
      (e) =>
        e.guildId === scope.guildId &&
        e.categoryId === scope.categoryId &&
        e.channelId === channel &&
        e.state === 'active' &&
        !this.state.deleted[e.sessionId]
    )?.sessionId;
  }
  channelForSession(scope: DiscordChannelScope, id: string): string | undefined {
    const e = this.state.entries[keyOf(scope, id)];
    return e?.state === 'active' && !this.state.deleted[id] ? e.channelId : undefined;
  }
  async assertOwned(scope: DiscordChannelScope, id: string): Promise<string> {
    await this.load();
    const entry = this.state.entries[keyOf(scope, id)];
    if (
      !entry?.channelId ||
      entry.state !== 'active' ||
      this.state.deleted[id] ||
      !this.owned(entry, await this.api.get(entry.channelId))
    )
      throw new DiscordChannelProblem('Case channel ownership changed; routing is paused');
    return entry.channelId;
  }
  private owned(e: Entry, c: DiscordManagedChannel | null): c is DiscordManagedChannel {
    return (
      !!c && c.type === 0 && c.guild_id === e.guildId && c.parent_id === e.categoryId && c.topic === this.marker(e)
    );
  }
  forSession(scope: DiscordChannelScope, id: string, name?: string): Promise<string> {
    const key = keyOf(scope, id);
    const current = this.pending.get(key);
    if (current) return current;
    const run = this.ensure(scope, id, name).finally(() => {
      if (this.pending.get(key) === run) this.pending.delete(key);
    });
    this.pending.set(key, run);
    return run;
  }
  private async ensure(scope: DiscordChannelScope, id: string, name?: string): Promise<string> {
    await this.load();
    if (this.state.deleted[id]) throw new DiscordChannelProblem('The session was deleted');
    if (!snowflake(scope.guildId) || !snowflake(scope.categoryId))
      throw new DiscordChannelProblem('Choose a Discord session category for Full interface mode');
    const key = keyOf(scope, id);
    let e = this.state.entries[key];
    if (e?.channelId && e.state === 'active') {
      try {
        const channel = await this.api.get(e.channelId);
        if (!this.owned(e, channel))
          throw new DiscordChannelProblem('Session channel ownership changed; refusing to reuse it');
        const desired = (this.options.name ?? discordSessionChannelName)(name, id);
        if (channel.name !== desired) await this.api.edit(e.channelId, { name: desired });
        return e.channelId;
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
        e = { ...e, channelId: undefined, state: 'failed' };
        this.state.entries[key] = e;
        await this.save();
      }
    }
    // Only an outstanding, durable create intent may adopt an unknown channel id.
    if (e?.state === 'creating') {
      const list = await this.api.list(scope.guildId);
      if (!Array.isArray(list)) throw new DiscordChannelProblem('Discord did not return the server channel list');
      const candidates = list.filter((c) => this.owned(e, c));
      if (candidates.length !== 1)
        throw new DiscordChannelProblem('Channel creation is uncertain; check Discord and sync again');
      e.channelId = candidates[0].id;
      e.state = 'active';
      await this.save();
      if (this.state.deleted[id]) {
        e.policy = this.state.deleted[id];
        await this.retireEntry(e);
        throw new DiscordChannelProblem('The session was deleted');
      }
      return e.channelId;
    }
    const category = await this.api.get(scope.categoryId);
    if (!category || category.type !== 4 || category.guild_id !== scope.guildId)
      throw new DiscordChannelProblem('Session category must belong to the configured Discord server');
    if (Object.keys(this.state.entries).length >= 4096)
      throw new DiscordChannelProblem('Session channel ownership file is full');
    e = { ...scope, sessionId: id, intentId: randomUUID(), state: 'creating' };
    this.state.entries[key] = e;
    try {
      await this.save();
    } catch (err) {
      e.state = 'failed';
      throw err;
    } // No HTTP before durable intent.
    let channel: DiscordManagedChannel | null;
    try {
      channel = await this.api.create(scope.guildId, {
        type: 0,
        parent_id: scope.categoryId,
        name: (this.options.name ?? discordSessionChannelName)(name, id),
        topic: this.marker(e),
        permission_overwrites: category.permission_overwrites ?? [],
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status && status < 500) {
        e.state = 'failed';
        await this.save();
      }
      throw err;
    }
    if (!channel || !snowflake(channel.id) || !this.owned(e, channel))
      throw new DiscordChannelProblem('Discord did not confirm owned channel creation');
    e.channelId = channel.id;
    e.state = 'active';
    await this.save();
    if (this.state.deleted[id]) {
      e.policy = this.state.deleted[id];
      e.state = 'retiring';
      await this.save();
      await this.retireEntry(e);
      throw new DiscordChannelProblem('The session was deleted');
    }
    return channel.id;
  }
  async rename(scope: DiscordChannelScope, id: string, name?: string): Promise<void> {
    await this.load();
    const e = this.state.entries[keyOf(scope, id)];
    if (!e?.channelId || e.state !== 'active' || this.state.deleted[id]) return;
    if (!this.owned(e, await this.api.get(e.channelId)))
      throw new DiscordChannelProblem('Session channel ownership changed; refusing to rename it');
    await this.api.edit(e.channelId, { name: (this.options.name ?? discordSessionChannelName)(name, id) });
  }
  async deleted(id: string, policy: DiscordChannelDelete, activeGuild?: string): Promise<void> {
    await this.load();
    if (Object.keys(this.state.deleted).length >= 4096 && !this.state.deleted[id])
      throw new DiscordChannelProblem('Deleted session registry is full');
    this.state.deleted[id] = policy;
    for (const e of Object.values(this.state.entries))
      if (e.sessionId === id && ['active', 'creating', 'failed'].includes(e.state)) {
        e.policy = policy;
        e.state = policy === 'keep' ? 'kept' : 'retiring';
      }
    await this.save(); // Routing is disabled before any network operation.
    if (activeGuild) await this.flushRetirements(activeGuild);
  }
  flushRetirements(guild: string): Promise<void> {
    if (this.retireRun) return this.retireRun;
    const run = (async () => {
      await this.load();
      let failure: unknown;
      for (const e of Object.values(this.state.entries)
        .filter((e) => e.guildId === guild && e.state === 'retiring')
        .slice(0, 25)) {
        try {
          await this.retireEntry(e);
        } catch (err) {
          failure = err;
        }
      }
      if (failure) throw failure;
    })().finally(() => {
      this.retireRun = undefined;
    });
    this.retireRun = run;
    return run;
  }
  private async retireEntry(e: Entry): Promise<void> {
    if (!e.channelId) return; // A concurrent create will finish retirement once its id is known.
    let channel: DiscordManagedChannel | null;
    try {
      channel = await this.api.get(e.channelId);
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        e.state = 'deleted';
        await this.save();
        return;
      }
      throw err;
    }
    if (!this.owned(e, channel)) throw new DiscordChannelProblem('Session channel ownership changed; refusing cleanup');
    const policy = e.policy ?? this.state.deleted[e.sessionId];
    if (policy === 'delete') {
      await this.api.remove(e.channelId);
      e.state = 'deleted';
    } else if (policy === 'retain') {
      // @everyone and every explicit allow are locked; Discord administrators can still bypass permissions.
      const mask = (1n << 11n) | (1n << 35n) | (1n << 36n) | (1n << 38n);
      const overwrites = (channel.permission_overwrites ?? []).map((o) => ({
        ...o,
        allow: (BigInt(o.allow) & ~mask).toString(),
        deny: (BigInt(o.deny) | mask).toString(),
      }));
      if (!overwrites.some((o) => o.id === e.guildId))
        overwrites.push({ id: e.guildId, type: 0, allow: '0', deny: mask.toString() });
      await this.api.edit(e.channelId, {
        name: ('archived-' + (channel.name ?? 'session')).slice(0, 100),
        permission_overwrites: overwrites,
      });
      e.state = 'retained';
    } else e.state = 'kept';
    await this.save();
  }
}
