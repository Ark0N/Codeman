/** One owned channel per case, one exact, durable starter-message thread per live session. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  DiscordSessionChannels,
  DiscordChannelProblem,
  type DiscordChannelScope,
  type DiscordChannelApi,
  type DiscordManagedChannel,
} from './discord-session-channels.js';
import type { DiscordCaseIdentity } from './discord-case-identity.js';
export interface DiscordStarter {
  id: string;
  nonce?: string | number;
  author?: { id: string };
  channel_id?: string;
}
interface StarterPost {
  content: string;
  nonce: string;
  enforce_nonce: true;
  allowed_mentions: { parse: string[]; users: string[] };
}
export interface DiscordCaseThreadApi extends DiscordChannelApi {
  botId(): Promise<string>;
  postStarter(parent: string, body: StarterPost): Promise<DiscordStarter | null>;
  getStarter(parent: string, id: string): Promise<DiscordStarter | null>;
  listStarters(parent: string): Promise<DiscordStarter[] | null>;
  createThread(parent: string, starter: string, name: string): Promise<DiscordManagedChannel | null>;
}
type Policy = 'keep' | 'archive' | 'delete';
interface Entry extends DiscordChannelScope {
  caseKey: string;
  caseName: string;
  sessionId: string;
  name: string;
  parentId: string;
  intent: string;
  createdAt: number;
  starterId?: string;
  phase: 'intent' | 'posting' | 'thread' | 'active' | 'retiring' | 'kept' | 'archived' | 'deleted';
  policy?: Policy;
}
interface State {
  instance: string;
  entries: Record<string, Entry>;
  current: Record<string, string>;
  deleted: Record<string, Policy>;
}
const snow = (v: unknown): v is string => typeof v === 'string' && /^\d{15,25}$/.test(v);
const scopeKey = (s: DiscordChannelScope, id: string) => JSON.stringify([s.guildId, s.categoryId, id]);
const entryKey = (s: DiscordChannelScope, caseKey: string, id: string) =>
  JSON.stringify([s.guildId, s.categoryId, caseKey, id]);
const safeName = (name: string) =>
  name
    .replace(/[\r\n<>`*_]/g, ' ')
    .trim()
    .slice(0, 100) || 'session';
const slug = (name: string | undefined) =>
  (name ?? 'case')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'case';
export class DiscordCaseThreads {
  private state: State = { instance: randomUUID(), entries: {}, current: {}, deleted: {} };
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<string>>();
  private retirement?: Promise<void>;
  private me?: Promise<string>;
  private readonly parents: DiscordSessionChannels;
  constructor(
    private readonly dir: string,
    private readonly api: DiscordCaseThreadApi,
    private readonly resolveCase: (id: string) => Promise<DiscordCaseIdentity | undefined>,
    private readonly now: () => number = Date.now,
    private readonly live: (scope: DiscordChannelScope, id: string) => boolean = () => true
  ) {
    this.parents = new DiscordSessionChannels(dir, api, {
      fileName: 'discord-case-channels.json',
      kind: 'case',
      name: slug,
    });
  }
  resetBotIdentity(): void {
    this.me = undefined;
  }
  private bot(): Promise<string> {
    return (this.me ??= this.api
      .botId()
      .then((id) => {
        if (!snow(id)) throw new DiscordChannelProblem('Discord bot identity unavailable');
        return id;
      })
      .catch((err) => {
        this.me = undefined;
        throw err;
      }));
  }
  load(): Promise<void> {
    return (this.loaded ??= (async () => {
      await this.parents.load();
      try {
        const path = join(this.dir, 'discord-case-threads.json');
        const info = await fs.lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error();
        const raw = JSON.parse(await fs.readFile(path, 'utf8')) as State;
        if (
          !raw ||
          !/^[a-f0-9-]{36}$/.test(raw.instance) ||
          !raw.entries ||
          !raw.current ||
          !raw.deleted ||
          typeof raw.entries !== 'object' ||
          Array.isArray(raw.entries) ||
          typeof raw.current !== 'object' ||
          Array.isArray(raw.current) ||
          typeof raw.deleted !== 'object' ||
          Array.isArray(raw.deleted) ||
          Object.keys(raw.entries).length > 4096 ||
          Object.keys(raw.current).length > 4096 ||
          Object.keys(raw.deleted).length > 4096
        )
          throw new Error();
        for (const [key, e] of Object.entries(raw.entries))
          if (
            !e ||
            !snow(e.guildId) ||
            !snow(e.categoryId) ||
            !snow(e.parentId) ||
            !/^[a-f0-9]{64}$/.test(e.caseKey) ||
            typeof e.sessionId !== 'string' ||
            e.sessionId.length > 100 ||
            key !== entryKey(e, e.caseKey, e.sessionId) ||
            typeof e.name !== 'string' ||
            e.name.length > 100 ||
            typeof e.caseName !== 'string' ||
            e.caseName.length > 100 ||
            !/^[a-f0-9-]{36}$/.test(e.intent) ||
            !Number.isFinite(e.createdAt) ||
            (e.starterId !== undefined && !snow(e.starterId)) ||
            !['intent', 'posting', 'thread', 'active', 'retiring', 'kept', 'archived', 'deleted'].includes(e.phase) ||
            (e.phase === 'active' && !e.starterId) ||
            (e.policy !== undefined && !['keep', 'archive', 'delete'].includes(e.policy))
          )
            throw new Error();
        for (const [key, value] of Object.entries(raw.current)) {
          const e = raw.entries[value];
          if (typeof value !== 'string' || !e || key !== scopeKey(e, e.sessionId)) throw new Error();
        }
        for (const [id, policy] of Object.entries(raw.deleted))
          if (!id || id.length > 100 || !['keep', 'archive', 'delete'].includes(policy)) throw new Error();
        this.state = raw;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new DiscordChannelProblem('Case/thread ownership is unavailable; routing is paused');
      }
    })());
  }
  private edit(fn: (state: State) => void): Promise<void> {
    const run = this.writes.then(async () => {
      await this.load();
      const next = structuredClone(this.state);
      fn(next);
      if (
        Object.keys(next.entries).length > 4096 ||
        Object.keys(next.current).length > 4096 ||
        Object.keys(next.deleted).length > 4096
      )
        throw new DiscordChannelProblem('Case/thread ownership registry is full');
      await fs.mkdir(this.dir, { recursive: true });
      const path = join(this.dir, 'discord-case-threads.json'),
        temp = path + '.' + randomUUID() + '.tmp';
      let file;
      try {
        file = await fs.open(temp, 'wx', 0o600);
        await file.writeFile(JSON.stringify(next));
        await file.sync();
        await file.close();
        file = undefined;
        await fs.rename(temp, path);
        this.state = next;
      } finally {
        await file?.close().catch(() => undefined);
        await fs.unlink(temp).catch(() => undefined);
      }
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
  private deletedSession(id: string): boolean {
    return Object.hasOwn(this.state.deleted, id);
  }
  private active(e: Entry, key: string): boolean {
    return (
      e.phase === 'active' && !this.deletedSession(e.sessionId) && this.state.current[scopeKey(e, e.sessionId)] === key
    );
  }
  channelForSession(scope: DiscordChannelScope, id: string): string | undefined {
    const key = this.state.current[scopeKey(scope, id)],
      e = this.state.entries[key];
    return e && this.active(e, key) ? e.starterId : undefined;
  }
  sessionForChannel(scope: DiscordChannelScope, id: string): string | undefined {
    return Object.entries(this.state.entries).find(
      ([key, e]) =>
        e.guildId === scope.guildId && e.categoryId === scope.categoryId && e.starterId === id && this.active(e, key)
    )?.[1].sessionId;
  }
  caseForChannel(scope: DiscordChannelScope, id: string): string | undefined {
    return this.parents.sessionForChannel(scope, id);
  }
  sessionsForCase(scope: DiscordChannelScope, caseKey: string): Array<{ sessionId: string; threadId: string }> {
    return Object.entries(this.state.entries)
      .filter(
        ([key, e]) =>
          e.guildId === scope.guildId &&
          e.categoryId === scope.categoryId &&
          e.caseKey === caseKey &&
          this.active(e, key)
      )
      .map(([, e]) => ({ sessionId: e.sessionId, threadId: e.starterId! }));
  }
  private nonce(e: Entry): string {
    return createHash('sha256')
      .update(this.state.instance + e.intent)
      .digest('hex')
      .slice(0, 24);
  }
  private post(e: Entry): StarterPost {
    return {
      content: `**${safeName(e.name)}**\nOpen this thread to continue this session. Case: **${safeName(e.caseName)}**.`,
      nonce: this.nonce(e),
      enforce_nonce: true,
      allowed_mentions: { parse: [], users: [] },
    };
  }
  private owned(e: Entry, t: DiscordManagedChannel | null, bot: string): t is DiscordManagedChannel {
    return (
      !!t &&
      t.id === e.starterId &&
      t.type === 11 &&
      t.guild_id === e.guildId &&
      t.parent_id === e.parentId &&
      t.owner_id === bot
    );
  }
  private async verify(e: Entry, reopen: boolean): Promise<DiscordManagedChannel> {
    if ((await this.parents.assertOwned(e, e.caseKey)) !== e.parentId)
      throw new DiscordChannelProblem('Case channel changed; synchronize sessions again');
    const t = await this.api.get(e.starterId!);
    if (!this.owned(e, t, await this.bot()))
      throw new DiscordChannelProblem('Session thread ownership changed; refusing routing');
    if (t.thread_metadata?.locked && reopen)
      throw new DiscordChannelProblem('Session thread is locked; unlock it in Discord to resume');
    if (t.thread_metadata?.archived && reopen) await this.api.edit(t.id, { archived: false });
    return t;
  }
  async assertCaseOwned(scope: DiscordChannelScope, key: string, channel: string): Promise<void> {
    if ((await this.parents.assertOwned(scope, key)) !== channel)
      throw new DiscordChannelProblem('Case channel changed');
  }
  async assertOwned(scope: DiscordChannelScope, id: string, thread: string): Promise<void> {
    await this.load();
    const key = this.state.current[scopeKey(scope, id)],
      e = this.state.entries[key];
    if (!e || !this.active(e, key) || e.starterId !== thread)
      throw new DiscordChannelProblem('Session thread is no longer active');
    await this.verify(e, true);
    if (!this.active(this.state.entries[key], key)) throw new DiscordChannelProblem('Session was closed');
  }
  forSession(scope: DiscordChannelScope, id: string, name?: string): Promise<string> {
    const key = scopeKey(scope, id),
      pending = this.pending.get(key);
    if (pending) return pending;
    const run = this.ensure(scope, id, name).finally(() => {
      if (this.pending.get(key) === run) this.pending.delete(key);
    });
    this.pending.set(key, run);
    return run;
  }
  private async ensure(scope: DiscordChannelScope, id: string, name?: string): Promise<string> {
    await this.load();
    if (this.deletedSession(id)) throw new DiscordChannelProblem('Session was deleted');
    const identity = await this.resolveCase(id);
    if (!identity || !/^[a-f0-9]{64}$/.test(identity.key))
      throw new DiscordChannelProblem('Session case metadata is unavailable');
    const parent = await this.parents.forSession(scope, identity.key, safeName(identity.name));
    if (!this.live(scope, id)) throw new DiscordChannelProblem('Session or Discord configuration changed');
    if (this.deletedSession(id)) throw new DiscordChannelProblem('Session was deleted');
    const key = entryKey(scope, identity.key, id);
    let e = this.state.entries[key];
    await this.edit((s) => {
      s.current[scopeKey(scope, id)] = key;
      if (!s.entries[key] || s.entries[key].parentId !== parent || s.entries[key].phase === 'deleted')
        s.entries[key] = {
          ...scope,
          caseKey: identity.key,
          caseName: safeName(identity.name),
          sessionId: id,
          name: safeName(name ?? id.slice(0, 8)),
          parentId: parent,
          intent: randomUUID(),
          createdAt: this.now(),
          phase: 'intent',
          policy: Object.hasOwn(s.deleted, id) ? s.deleted[id] : undefined,
        };
    });
    e = this.state.entries[key];
    if (e.phase === 'active') {
      try {
        const thread = await this.verify(e, true);
        const desired = safeName(name ?? id.slice(0, 8));
        if (thread.name !== desired) await this.api.edit(thread.id, { name: desired });
        if (!this.active(this.state.entries[key], key)) throw new DiscordChannelProblem('Session was closed');
        return thread.id;
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
        await this.edit((s) => {
          s.entries[key] = {
            ...s.entries[key],
            starterId: undefined,
            intent: randomUUID(),
            createdAt: this.now(),
            phase: 'intent',
            policy: Object.hasOwn(s.deleted, id) ? s.deleted[id] : undefined,
          };
        });
        e = this.state.entries[key];
      }
    }
    if (!e.starterId) {
      if (e.phase === 'posting' && this.now() - e.createdAt > 120000) {
        const bot = await this.bot();
        const list = await this.api.listStarters(parent);
        const matches = list?.filter(
          (m) => String(m.nonce) === this.nonce(e) && m.author?.id === bot && m.channel_id === parent
        );
        if (!matches || matches.length !== 1)
          throw new DiscordChannelProblem(
            'Thread starter delivery is uncertain; inspect the case channel before retrying'
          );
        const starterId = matches[0].id;
        await this.edit((s) => {
          s.entries[key] = { ...s.entries[key], starterId, phase: 'thread' };
        });
      } else {
        await this.edit((s) => {
          if (s.entries[key].phase === 'intent') s.entries[key].createdAt = this.now();
          s.entries[key].phase = 'posting';
        });
        e = this.state.entries[key];
        let message: DiscordStarter | null;
        try {
          message = await this.api.postStarter(parent, this.post(e));
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status && status >= 400 && status < 500 && status !== 408)
            await this.edit((s) => {
              s.entries[key].phase = 'intent';
            });
          throw err;
        }
        if (!message || !snow(message.id))
          throw new DiscordChannelProblem('Discord did not confirm the session thread starter');
        await this.edit((s) => {
          s.entries[key] = { ...s.entries[key], starterId: message.id, phase: 'thread' };
        });
      }
    }
    e = this.state.entries[key];
    const bot = await this.bot();
    const starter = await this.api.getStarter(parent, e.starterId!);
    if (!starter || starter.id !== e.starterId || starter.channel_id !== parent || starter.author?.id !== bot)
      throw new DiscordChannelProblem('Session thread starter ownership changed');
    let thread: DiscordManagedChannel | null;
    try {
      thread = await this.api.get(e.starterId!);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      thread = null;
    }
    if (!thread) {
      try {
        thread = await this.api.createThread(parent, e.starterId!, safeName(name ?? e.name));
      } catch (err) {
        try {
          thread = await this.api.get(e.starterId!);
        } catch {
          throw err;
        }
      }
    }
    if (!this.owned(e, thread, bot))
      throw new DiscordChannelProblem('Discord did not confirm the owned session thread');
    await this.edit((s) => {
      s.entries[key].phase = Object.hasOwn(s.deleted, id) ? 'retiring' : 'active';
      s.entries[key].policy = Object.hasOwn(s.deleted, id) ? s.deleted[id] : undefined;
    });
    if (this.deletedSession(id)) {
      await this.retire(key);
      throw new DiscordChannelProblem('Session was deleted');
    }
    await this.verify(this.state.entries[key], true);
    return thread.id;
  }
  async rename(scope: DiscordChannelScope, id: string, name?: string): Promise<void> {
    await this.forSession(scope, id, name);
  }
  async deleted(id: string, policy: Policy, guild?: string): Promise<void> {
    await this.load();
    await this.edit((s) => {
      Object.defineProperty(s.deleted, id, { value: policy, enumerable: true, configurable: true, writable: true });
      for (const e of Object.values(s.entries))
        if (e.sessionId === id && ['active', 'intent', 'posting', 'thread'].includes(e.phase)) {
          e.policy = policy;
          e.phase = policy === 'keep' ? 'kept' : 'retiring';
        }
    });
    if (guild) await this.flushRetirements(guild);
  }
  flushRetirements(guild: string): Promise<void> {
    if (this.retirement) return this.retirement;
    const run = (async () => {
      await this.load();
      let failure: unknown;
      for (const [key] of Object.entries(this.state.entries)
        .filter(([, e]) => e.guildId === guild && e.phase === 'retiring')
        .slice(0, 25)) {
        try {
          await this.retire(key);
        } catch (err) {
          failure = err;
        }
      }
      if (failure) throw failure;
    })().finally(() => {
      this.retirement = undefined;
    });
    this.retirement = run;
    return run;
  }
  private async retire(key: string): Promise<void> {
    const e = this.state.entries[key];
    if (!e?.starterId) return;
    try {
      await this.verify(e, false);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      await this.edit((s) => {
        s.entries[key].phase = 'deleted';
      });
      return;
    }
    if (e.policy === 'delete') await this.api.remove(e.starterId);
    else if (e.policy === 'archive') await this.api.edit(e.starterId, { archived: true });
    await this.edit((s) => {
      s.entries[key].phase = e.policy === 'delete' ? 'deleted' : e.policy === 'archive' ? 'archived' : 'kept';
    });
  }
}
