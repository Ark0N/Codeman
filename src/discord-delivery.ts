/**
 * Private, bounded Discord delivery metadata. No prompt, file bytes, token or message body is stored.
 * A durable claim precedes input; interrupted input is uncertain and is never replayed automatically.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';

export const DISCORD_DELIVERY_LIMIT = 2048;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
export class DiscordDeliveryError extends Error {}
const STATES = [
  'received',
  'files_transferred',
  'submitting',
  'input_accepted',
  'running',
  'completed',
  'interrupted',
  'execution_error',
  'delivered',
  'failed',
  'uncertain',
] as const;
export type DiscordDeliveryState = (typeof STATES)[number];
export interface DiscordDelivery {
  id: string;
  direction: 'inbound' | 'outbound';
  sessionId?: string;
  channelId: string;
  guildId: string;
  state: DiscordDeliveryState;
  /** Outbound formatting fingerprint; guards multipart retries after a formatter upgrade. */
  payloadHash?: string;
  messageId?: string;
  native?: { conversationId: string; promptHash: string; afterCursor?: string; userCursor?: string };
  createdAt: number;
  updatedAt: number;
  /** Fixed codes only. Never store external exception messages or prompt text here. */
  reason?:
    | 'restart_before_submit'
    | 'restart_during_submit'
    | 'session_unavailable'
    | 'input_uncertain'
    | 'empty'
    | 'transfer_failed'
    | 'scope_changed'
    | 'discord_refused'
    | 'delivery_uncertain'
    | 'rate_limited'
    | 'input_too_large'
    | 'invalid_command';
}

export class DiscordDeliveryJournal {
  private records = new Map<string, DiscordDelivery>();
  private loadRun?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  load(): Promise<void> {
    this.loadRun ??= this.read();
    return this.loadRun;
  }

  private async read(): Promise<void> {
    const path = join(this.dir, 'discord-delivery.json');
    let raw: unknown;
    try {
      const info = await fs.lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
        throw new DiscordDeliveryError('Unsafe Discord delivery journal');
      raw = JSON.parse(await fs.readFile(path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Losing a deduplication journal cannot silently turn a replay into another terminal write.
      throw new DiscordDeliveryError('Discord delivery journal cannot be read; input is paused');
    }
    if (!Array.isArray(raw) || raw.length > DISCORD_DELIVERY_LIMIT)
      throw new DiscordDeliveryError('Invalid Discord delivery journal');
    const cutoff = this.now() - RETENTION_MS;
    for (const r of raw) {
      if (
        !r ||
        typeof r.id !== 'string' ||
        r.id.length > 200 ||
        !['inbound', 'outbound'].includes(r.direction) ||
        typeof r.channelId !== 'string' ||
        !/^\d{15,25}$/.test(r.channelId) ||
        typeof r.guildId !== 'string' ||
        !/^\d{15,25}$/.test(r.guildId) ||
        !STATES.includes(r.state) ||
        !Number.isFinite(r.createdAt) ||
        !Number.isFinite(r.updatedAt) ||
        (r.sessionId !== undefined && (typeof r.sessionId !== 'string' || r.sessionId.length > 100))
      )
        throw new DiscordDeliveryError('Invalid Discord delivery journal');
      if (r.createdAt < cutoff) continue;
      // Copy only recognized metadata. Extra data from disk must never leak through the status API.
      const record: DiscordDelivery = {
        id: r.id,
        direction: r.direction,
        sessionId: r.sessionId,
        channelId: r.channelId,
        guildId: r.guildId,
        state: r.state,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
      if (r.payloadHash !== undefined) {
        if (typeof r.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.payloadHash))
          throw new DiscordDeliveryError('Invalid Discord delivery fingerprint');
        record.payloadHash = r.payloadHash;
      }
      if (r.messageId !== undefined) {
        if (typeof r.messageId !== 'string' || r.messageId.length > 100)
          throw new DiscordDeliveryError('Invalid Discord message id');
        record.messageId = r.messageId;
      }
      if (r.native !== undefined) {
        if (
          !r.native ||
          typeof r.native.conversationId !== 'string' ||
          r.native.conversationId.length > 100 ||
          typeof r.native.promptHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(r.native.promptHash) ||
          [r.native.afterCursor, r.native.userCursor].some(
            (c) => c !== undefined && (typeof c !== 'string' || c.length > 200)
          )
        )
          throw new DiscordDeliveryError('Invalid native execution metadata');
        record.native = {
          conversationId: r.native.conversationId,
          promptHash: r.native.promptHash,
          afterCursor: r.native.afterCursor,
          userCursor: r.native.userCursor,
        };
      }
      if (['received', 'files_transferred', 'submitting'].includes(record.state)) {
        record.reason = record.state === 'submitting' ? 'restart_during_submit' : 'restart_before_submit';
        record.state = record.reason === 'restart_during_submit' ? 'uncertain' : 'failed';
        record.updatedAt = this.now();
      }
      this.records.set(record.id, record);
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const destination = join(this.dir, 'discord-delivery.json');
    const tmp = `${destination}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await fs.open(tmp, 'wx', 0o600);
      await file.writeFile(JSON.stringify([...this.records.values()]));
      await file.sync();
      await file.close();
      file = undefined;
      await fs.rename(tmp, destination);
    } finally {
      await file?.close().catch(() => undefined);
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  claim(
    record: Omit<DiscordDelivery, 'state' | 'createdAt' | 'updatedAt'>
  ): Promise<{ fresh: boolean; record: DiscordDelivery }> {
    return this.serial(async () => {
      await this.load();
      const existing = this.records.get(record.id);
      if (existing) return { fresh: false, record: { ...existing } };
      const before = new Map(this.records);
      const now = this.now();
      for (const [id, r] of this.records) if (r.createdAt < now - RETENTION_MS) this.records.delete(id);
      const completedPosts = [...this.records.values()].filter(
        (r) => r.direction === 'outbound' && ['delivered', 'failed'].includes(r.state)
      );
      // Routine notifications must not crowd out inbound deduplication records.
      for (const r of completedPosts.slice(0, Math.max(0, completedPosts.length - 255))) this.records.delete(r.id);
      // Do not evict recent inbound IDs to make room: saturation pauses input instead of weakening dedupe.
      if (this.records.size >= DISCORD_DELIVERY_LIMIT)
        throw new DiscordDeliveryError('Discord delivery journal is full');
      const next: DiscordDelivery = { ...record, state: 'received', createdAt: now, updatedAt: now };
      this.records.set(next.id, next);
      try {
        await this.persist();
      } catch (err) {
        this.records = before;
        throw err;
      }
      return { fresh: true, record: { ...next } };
    });
  }

  update(id: string, state: DiscordDeliveryState, reason?: DiscordDelivery['reason']): Promise<void> {
    return this.serial(async () => {
      await this.load();
      const before = this.records.get(id);
      if (!before) throw new DiscordDeliveryError('Unknown Discord delivery');
      this.records.set(id, { ...before, state, reason, updatedAt: this.now() });
      try {
        await this.persist();
      } catch (err) {
        this.records.set(id, before);
        throw err;
      }
    });
  }

  annotate(id: string, metadata: Pick<DiscordDelivery, 'native' | 'messageId'>): Promise<void> {
    return this.serial(async () => {
      await this.load();
      const before = this.records.get(id);
      if (!before) throw new DiscordDeliveryError('Unknown delivery');
      this.records.set(id, { ...before, ...metadata, updatedAt: this.now() });
      try {
        await this.persist();
      } catch (err) {
        this.records.set(id, before);
        throw err;
      }
    });
  }
  async reconcileNative(sessionId: string, history: import('./discord-history.js').DiscordHistory): Promise<void> {
    await this.load();
    const records = [...this.records.values()]
      .filter(
        (r) =>
          r.direction === 'inbound' &&
          r.sessionId === sessionId &&
          r.native?.conversationId === history.conversationId &&
          ['input_accepted', 'uncertain', 'running'].includes(r.state)
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const claimed = new Set(
      [...this.records.values()].flatMap((r) => (r.native?.userCursor ? [r.native.userCursor] : []))
    );
    for (const record of records) {
      const meta = record.native!;
      const baseline = meta.afterCursor ? history.turns.findIndex((t) => t.cursor === meta.afterCursor) : -1;
      if (meta.afterCursor && baseline < 0) continue;
      const execution = history.executions?.find((e) =>
        meta.userCursor
          ? e.userCursor === meta.userCursor
          : e.promptHash === meta.promptHash &&
            !claimed.has(e.userCursor) &&
            history.turns.findIndex((t) => t.cursor === e.userCursor) > baseline
      );
      if (!execution) continue;
      claimed.add(execution.userCursor);
      await this.annotate(record.id, { native: { ...meta, userCursor: execution.userCursor } });
      if (execution.state !== 'submitted') await this.update(record.id, execution.state);
    }
  }
  async recent(): Promise<DiscordDelivery[]> {
    await this.load();
    await this.chain;
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50)
      .map((r) => ({ ...r }));
  }
}
