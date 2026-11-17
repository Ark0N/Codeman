/** @fileoverview Best-effort replay protection. A metadata-store failure must never block a person's reply. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LIMIT = 2048;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
export class DiscordReplyDedupe {
  private seen = new Map<string, number>();
  private loaded = false;
  private dirty = false;
  private warned = false;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly warn: () => void = () =>
      console.warn('Discord reply metadata unavailable (discord-reply-dedupe.json); using in-memory deduplication')
  ) {}
  claim(guild: string, channel: string, message: string): Promise<boolean> {
    const run = this.chain.then(() => this.take(guild, channel, message));
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async take(guild: string, channel: string, message: string): Promise<boolean> {
    // Restored legacy configurations and malformed gateway IDs must not poison the store.
    if (![guild, channel, message].every((id) => /^\d{15,25}$/.test(id))) return true;
    const path = join(this.dir, 'discord-reply-dedupe.json');
    const cutoff = this.now() - RETENTION_MS;
    if (!this.loaded) {
      let contentRead = false;
      try {
        const st = await fs.lstat(path);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 512 * 1024)
          throw Object.assign(new Error('Unsafe metadata'), { code: 'EINVAL' });
        const text = await fs.readFile(path, 'utf8');
        contentRead = true;
        const rows: unknown = JSON.parse(text);
        if (!Array.isArray(rows) || rows.length > LIMIT) throw new Error('Invalid metadata');
        const recovered = new Map<string, number>();
        for (const row of rows) {
          if (!Array.isArray(row) || !/^\d{15,25}:\d{15,25}:\d{15,25}$/.test(row[0]) || !Number.isFinite(row[1]))
            throw new Error('Invalid metadata');
          if (row[1] >= cutoff) recovered.set(row[0], row[1]);
        }
        // Older disk rows precede newer claims made while reads were unavailable.
        this.seen = new Map([...recovered, ...this.seen]);
        this.loaded = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.loaded = true;
        else {
          this.report();
          // Invalid content is recoverable ID-only metadata; unreadable/unsafe files stay untouched.
          if (contentRead && !(err as NodeJS.ErrnoException).code) {
            this.loaded = true;
            this.dirty = true;
          }
        }
      }
    }
    for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
    const key = `${guild}:${channel}:${message}`;
    const fresh = !this.seen.has(key);
    if (fresh) {
      this.seen.set(key, this.now());
      this.dirty = true;
    } // Before awaiting IO or typing, including during an outage.
    while (this.seen.size > LIMIT) this.seen.delete(this.seen.keys().next().value!);
    if (!this.loaded || !this.dirty) return fresh; // Do not overwrite a journal we could not read.
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify([...this.seen]), { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, path);
      this.warned = false;
      this.dirty = false;
    } catch {
      this.report();
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
    return fresh;
  }
  private report(): void {
    if (!this.warned) this.warn();
    this.warned = true;
  }
}
