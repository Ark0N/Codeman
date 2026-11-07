/** Durable unresolved warning ownership, independent of bounded delivery receipts. No message bodies. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const snow = (x: unknown): x is string => typeof x === 'string' && /^\d{15,25}$/.test(x);
export class DiscordHistoryWarnings {
  private entries = new Map<string, string | null>();
  private loaded?: Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly dir: string) {}
  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      try {
        const f = await fs.open(
          join(this.dir, 'discord-history-warnings.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
          const st = await f.stat();
          if (!st.isFile() || st.size > 256 * 1024) throw new Error('Unsafe history warning state');
          const buffer = Buffer.alloc(256 * 1024 + 1);
          const { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
          if (bytesRead === buffer.length) throw new Error('History warning state too large');
          const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
          if (!Array.isArray(value) || value.length > 1024) throw new Error('Invalid history warning state');
          for (const e of value) {
            if (
              !Array.isArray(e) ||
              e.length !== 2 ||
              typeof e[0] !== 'string' ||
              !/^[a-f0-9]{64}$/.test(e[0]) ||
              (e[1] !== null && !snow(e[1]))
            )
              throw new Error('Invalid history warning entry');
            this.entries.set(e[0], e[1]);
          }
        } finally {
          await f.close();
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    })());
  }
  async get(key: string): Promise<{ pending: true; message: string | null } | undefined> {
    await this.load();
    await this.chain;
    return this.entries.has(key) ? { pending: true, message: this.entries.get(key)! } : undefined;
  }
  set(key: string, message: string | null | undefined): Promise<void> {
    return this.edit(key, message, false).then(() => undefined);
  }
  claim(key: string): Promise<boolean> {
    return this.edit(key, null, true);
  }
  private edit(key: string, message: string | null | undefined, onlyAbsent: boolean): Promise<boolean> {
    const run = this.chain.then(async () => {
      await this.load();
      if (!/^[a-f0-9]{64}$/.test(key) || (message !== undefined && message !== null && !snow(message)))
        throw new Error('Invalid history warning identity');
      if (onlyAbsent && this.entries.has(key)) return false;
      const next = new Map(this.entries);
      if (message === undefined) next.delete(key);
      else next.set(key, message);
      if (next.size > 1024) throw new Error('History warning state full');
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, 'discord-history-warning-' + randomUUID() + '.tmp');
      try {
        const f = await fs.open(tmp, 'wx', 0o600);
        try {
          await f.writeFile(JSON.stringify([...next]));
          await f.sync();
        } finally {
          await f.close();
        }
        await fs.rename(tmp, join(this.dir, 'discord-history-warnings.json'));
        this.entries = next;
        return true;
      } finally {
        await fs.unlink(tmp).catch(() => undefined);
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
