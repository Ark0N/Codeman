/** Private, bounded UI ownership and explicit prompt queue. Never replay ambiguous writes. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DiscordActivityRecordSchema } from './discord-activity-feed.js';
const Card = z
  .object({
    kind: z.enum(['session', 'delivery', 'result', 'dashboard']).optional(),
    channel: z.string().regex(/^\d{15,25}$/),
    message: z
      .string()
      .regex(/^\d{15,25}$/)
      .optional(),
    hash: z.string().max(100),
    phase: z.enum(['posting', 'ready', 'uncertain']),
    updated: z.number(),
  })
  .strict();
const Prompt = z
  .object({
    id: z.string().uuid(),
    session: z.string().max(100),
    conversation: z.string().max(100),
    inputRevision: z.string().max(200).optional(),
    scope: z.string().max(200),
    channel: z.string().regex(/^\d{15,25}$/),
    actor: z.string().regex(/^\d{15,25}$/),
    source: z.string().max(200),
    text: z.string().min(1).max(16000),
    created: z.number(),
    state: z.enum(['queued', 'submitting', 'uncertain']),
  })
  .strict();
const ResponseRef = z
  .object({
    scope: z.string().max(200),
    session: z.string().max(100),
    channel: z.string().regex(/^\d{15,25}$/),
    conversation: z.string().max(100),
    userCursor: z.string().max(200),
    responseCursor: z.string().max(200).optional(),
    updated: z.number(),
  })
  .strict();
const State = z
  .object({
    version: z.literal(1),
    cards: z.record(z.string().max(200), Card),
    queue: z.array(Prompt).max(50),
    activities: z.record(z.string().max(200), DiscordActivityRecordSchema).default({}),
    responses: z.record(z.string().max(200), ResponseRef).default({}),
  })
  .strict();
export type DiscordQueuedPrompt = z.infer<typeof Prompt>;
export type DiscordUiState = z.infer<typeof State>;
export class DiscordUiStore {
  private state: DiscordUiState = { version: 1, cards: {}, queue: [], responses: {}, activities: {} };
  private loaded?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}
  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      const path = join(this.dir, 'discord-native-ui.json');
      try {
        const f = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let raw: z.infer<typeof State>;
        try {
          const st = await f.stat();
          if (!st.isFile() || st.size > 4 * 1024 * 1024) throw new Error('Unsafe UI state');
          const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
          const { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
          if (bytesRead === buffer.length) throw new Error('UI state grew beyond its size bound');
          raw = State.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
        } finally {
          await f.close();
        }
        if (Object.keys(raw.activities).length > 1024) throw new Error('Too many activity records');
        if (Object.keys(raw.responses).length > 1024) throw new Error('Too many response references');
        if (Object.keys(raw.cards).length > 4096) throw new Error('Too many UI cards');
        this.state = raw;
        for (const p of this.state.queue) if (p.state === 'submitting') p.state = 'uncertain';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error('Discord UI state unavailable; queue paused');
      }
    })());
  }
  async snapshot(): Promise<DiscordUiState> {
    await this.load();
    await this.chain;
    return structuredClone(this.state);
  }
  edit<T>(fn: (state: DiscordUiState) => T): Promise<T> {
    const run = this.chain.then(async () => {
      await this.load();
      const next = structuredClone(this.state);
      const result = fn(next);
      for (const [key, card] of Object.entries(next.cards))
        if (card.kind === 'delivery' && card.phase === 'ready' && card.updated < this.now() - 7 * 86400000)
          delete next.cards[key];
      for (const [key, ref] of Object.entries(next.responses))
        if (ref.updated < this.now() - 30 * 86400000) delete next.responses[key];
      const refs = Object.entries(next.responses).sort((a, b) => b[1].updated - a[1].updated);
      for (const [key] of refs.slice(1024)) delete next.responses[key];
      const activities = Object.entries(next.activities).sort((a, b) => b[1].at - a[1].at);
      for (const [key, value] of activities) if (value.at < this.now() - 30 * 86400000) delete next.activities[key];
      for (const [key] of activities.slice(1024)) delete next.activities[key];
      State.parse(next);
      if (Object.keys(next.cards).length > 4096) throw new Error('UI card capacity reached');
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, `discord-ui-${randomUUID()}.tmp`);
      try {
        const file = await fs.open(tmp, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(next));
          await file.sync();
        } finally {
          await file.close();
        }
        await fs.rename(tmp, join(this.dir, 'discord-native-ui.json'));
      } finally {
        await fs.unlink(tmp).catch(() => undefined);
      }
      this.state = next;
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  async enqueue(input: Omit<DiscordQueuedPrompt, 'id' | 'created' | 'state'>): Promise<string> {
    return this.edit((s) => {
      if (s.queue.some((p) => p.source === input.source && p.scope === input.scope))
        throw new Error('Prompt already queued');
      if (s.queue.filter((p) => p.session === input.session).length >= 10 || s.queue.length >= 50)
        throw new Error('Queue full (10 per session, 50 total)');
      const p: DiscordQueuedPrompt = { ...input, id: randomUUID(), created: this.now(), state: 'queued' };
      s.queue.push(p);
      return p.id;
    });
  }
}
