/** @fileoverview Durable metadata-only native history boundaries shared by backfill and live observation. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export interface DiscordConversationProgress {
  conversationId: string;
  sessionId?: string;
  updatedAt?: number;
  finishedAt?: number;
  seed: string[];
  seedIndex: number;
  seeded: boolean;
  cursor?: string;
  statusMessageId?: string;
  statusHash?: string;
  verbose?: boolean;
  streamOff?: boolean;
}
const validCursor = (v: unknown) => typeof v === 'string' && v.length <= 200 && /^[A-Za-z0-9:-]+$/.test(v);
export class DiscordConversationProgressStore {
  private entries = new Map<string, DiscordConversationProgress>();
  private loaded?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}
  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      const path = join(this.dir, 'discord-conversations.json');
      try {
        const info = await fs.lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
          throw new Error('Unsafe conversation boundary file');
        const raw: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
        if (!Array.isArray(raw) || raw.length > 1024) throw new Error('Invalid conversation boundaries');
        for (const item of raw) {
          if (!Array.isArray(item) || item.length !== 2) throw new Error('Invalid conversation boundary');
          const [key, p] = item;
          if (
            typeof key !== 'string' ||
            key.length !== 64 ||
            !p ||
            typeof p !== 'object' ||
            !validCursor(p.conversationId) ||
            !Array.isArray(p.seed) ||
            p.seed.length > 6 ||
            !p.seed.every(validCursor) ||
            !Number.isInteger(p.seedIndex) ||
            p.seedIndex < 0 ||
            p.seedIndex > p.seed.length ||
            typeof p.seeded !== 'boolean' ||
            (p.sessionId !== undefined && (typeof p.sessionId !== 'string' || p.sessionId.length > 100)) ||
            (p.finishedAt !== undefined && (!Number.isFinite(p.finishedAt) || p.finishedAt < 0)) ||
            (p.updatedAt !== undefined && (!Number.isFinite(p.updatedAt) || p.updatedAt < 0)) ||
            (p.cursor !== undefined && !validCursor(p.cursor)) ||
            (p.statusMessageId !== undefined &&
              (typeof p.statusMessageId !== 'string' || !/^\d{15,25}$/.test(p.statusMessageId))) ||
            (p.statusHash !== undefined &&
              (typeof p.statusHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.statusHash))) ||
            (p.verbose !== undefined && typeof p.verbose !== 'boolean') ||
            (p.streamOff !== undefined && typeof p.streamOff !== 'boolean')
          )
            throw new Error('Invalid conversation boundary');
          this.entries.set(key, {
            conversationId: p.conversationId,
            sessionId: p.sessionId,
            finishedAt: p.finishedAt,
            updatedAt: p.updatedAt ?? this.now(),
            seed: p.seed,
            seedIndex: p.seedIndex,
            seeded: p.seeded,
            cursor: p.cursor,
            statusMessageId: p.statusMessageId,
            statusHash: p.statusHash,
            verbose: p.verbose,
            streamOff: p.streamOff,
          });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error('Conversation boundaries unavailable; output paused');
      }
    })());
  }
  async get(key: string): Promise<DiscordConversationProgress | undefined> {
    await this.load();
    await this.chain;
    const p = this.entries.get(key);
    return p ? structuredClone(p) : undefined;
  }
  reconcile(activeKeys: Set<string>): Promise<void> {
    return this.mutate((next) => {
      for (const [key, value] of next) {
        if (activeKeys.has(key)) {
          if (value.finishedAt !== undefined) next.set(key, { ...value, finishedAt: undefined });
        } else if (value.finishedAt === undefined) next.set(key, { ...value, finishedAt: this.now() });
      }
    }, activeKeys);
  }
  delete(key: string): Promise<void> {
    return this.mutate((next) => {
      next.delete(key);
    });
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.mutate((next) => {
      for (const [key, value] of next) if (value.sessionId === sessionId) next.delete(key);
    });
  }
  set(key: string, value: DiscordConversationProgress): Promise<void> {
    return this.mutate((next) => {
      if (!next.has(key) && next.size >= 1024) {
        const oldestFinished = [...next]
          .filter(([, value]) => value.finishedAt !== undefined)
          .sort((a, b) => a[1].finishedAt! - b[1].finishedAt!)[0];
        if (oldestFinished) next.delete(oldestFinished[0]);
      }
      if (!next.has(key) && next.size >= 1024) throw new Error('Conversation boundary limit reached');
      next.set(key, { ...structuredClone(value), updatedAt: this.now() });
    });
  }
  private mutate(
    edit: (next: Map<string, DiscordConversationProgress>) => void,
    protectedKeys?: Set<string>
  ): Promise<void> {
    const run = this.chain.then(async () => {
      await this.load();
      const next = new Map(this.entries);
      for (const [key, value] of next)
        if (!protectedKeys?.has(key) && value.finishedAt !== undefined && value.finishedAt < this.now() - 7 * 86400000)
          next.delete(key);
      edit(next);
      await fs.mkdir(this.dir, { recursive: true });
      const path = join(this.dir, 'discord-conversations.json');
      const temp = path + '.' + randomUUID() + '.tmp';
      let file;
      try {
        file = await fs.open(temp, 'wx', 0o600);
        await file.writeFile(JSON.stringify([...next]));
        await file.sync();
        await file.close();
        file = undefined;
        await fs.rename(temp, path);
        this.entries = next;
      } finally {
        await file?.close().catch(() => undefined);
        await fs.unlink(temp).catch(() => undefined);
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
