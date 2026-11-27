/**
 * @fileoverview Opt-in, searchable plain-text history of each session, kept on disk.
 *
 * Off by default: an install that never turns on `transcriptSearchEnabled` writes nothing.
 * The rules, the same as the agent inbox snapshot (`web/agent-inbox-persistence.ts`):
 * - Off means no files. Switching it off deletes every transcript.
 * - One file per session under `dataPath('transcripts', '<sessionId>.txt')`, written 0600
 *   through tmp + rename. A terminal shows whatever the agent printed, secrets included.
 * - The file is a snapshot of the rendered scrollback (ANSI-free), replaced as a whole, so a
 *   full-screen redraw never leaves duplicates behind. Capped at {@link MAX_TRANSCRIPT_BYTES}
 *   (the newest part is kept).
 * - It goes with the session: the server calls `remove()` where it forgets the session's edit
 *   history, `sweep()` removes files no session owns, and `removeAll()` is the "clear" button.
 * - Never read by `/api/search`; `sensitive-path.ts` keeps the file viewer off the folder.
 *
 * Tests: `test/transcript-store.test.ts`.
 *
 * @module transcript-store
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from './config/instance.js';

/** Newest bytes kept per session. */
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
export const MAX_QUERY_CHARS = 200;
export const MAX_MATCHES = 200;
export const CONTEXT_LINES = 2;
const MAX_LINE_CHARS = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface TranscriptMatch {
  /** 1-based line number in the stored text. */
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface TranscriptSearchResult {
  matches: TranscriptMatch[];
  /** Lines that matched, which can be more than `matches.length`. */
  total: number;
  bytes: number;
  updatedAt: number;
}

export interface TranscriptWindow {
  /** 1-based number of the first returned line. */
  start: number;
  lines: string[];
}

export const MAX_WINDOW_RADIUS = 40;

const clip = (s: string): string => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s);

export class TranscriptStore {
  private enabled = false;
  private deletions = 0;

  constructor(
    /** Resolved per call: test HOMEs change between files. */
    private readonly dir: () => string = () => dataPath('transcripts')
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Counts deletions, so a caller that caches what it wrote knows the file may be gone. */
  get generation(): number {
    return this.deletions;
  }

  /** Boot: apply the setting. Off removes files left from an earlier "on". */
  async load(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) await this.removeAll();
  }

  /** The setting changed. Off deletes every transcript. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) await this.removeAll();
  }

  private file(sessionId: string): string | null {
    return ID_PATTERN.test(sessionId) ? join(this.dir(), `${sessionId}.txt`) : null;
  }

  /** Replace the stored transcript of `sessionId`. No-op while disabled. */
  async save(sessionId: string, text: string): Promise<void> {
    const path = this.file(sessionId);
    if (!this.enabled || !path) return;
    let body = text;
    if (Buffer.byteLength(body) > MAX_TRANSCRIPT_BYTES) {
      // Keep the newest part and start on a line boundary.
      body = Buffer.from(body).subarray(-MAX_TRANSCRIPT_BYTES).toString('utf-8');
      body = body.slice(body.indexOf('\n') + 1);
    }
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    // `mode` applies at creation and the rename makes every write a fresh file, so it is always 0600.
    await writeFile(tmp, body, { mode: 0o600 });
    // The setting can flip while the write was in flight: do not leave a file behind.
    if (!this.enabled) return void (await rm(tmp, { force: true }));
    await rename(tmp, path);
  }

  /** Case-insensitive substring search. Null when there is no transcript. */
  async search(sessionId: string, query: string, limit = MAX_MATCHES): Promise<TranscriptSearchResult | null> {
    const path = this.file(sessionId);
    const needle = query.trim().slice(0, MAX_QUERY_CHARS).toLowerCase();
    if (!this.enabled || !path || !needle) return null;
    let text: string;
    let info;
    try {
      [text, info] = await Promise.all([readFile(path, 'utf-8'), stat(path)]);
    } catch {
      return null;
    }
    const lines = text.split('\n');
    const matches: TranscriptMatch[] = [];
    let total = 0;
    const cap = Math.max(1, Math.min(limit, MAX_MATCHES));
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      total++;
      if (matches.length >= cap) continue;
      matches.push({
        line: i + 1,
        text: clip(lines[i]),
        before: lines.slice(Math.max(0, i - CONTEXT_LINES), i).map(clip),
        after: lines.slice(i + 1, i + 1 + CONTEXT_LINES).map(clip),
      });
    }
    return { matches, total, bytes: info.size, updatedAt: info.mtimeMs };
  }

  /** The lines around 1-based `line` (`radius` each side), for reading a hit in place. Null when there is no transcript. */
  async window(sessionId: string, line: number, radius = 20): Promise<TranscriptWindow | null> {
    const path = this.file(sessionId);
    if (!this.enabled || !path || !Number.isInteger(line) || line < 1) return null;
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch {
      return null;
    }
    const r = Math.max(0, Math.min(Math.floor(radius), MAX_WINDOW_RADIUS));
    const lines = text.split('\n');
    if (line > lines.length) return null;
    const start = Math.max(1, line - r);
    return { start, lines: lines.slice(start - 1, line + r).map(clip) };
  }

  /** Delete one session's transcript. Works while disabled, so a stale file can always go. */
  async remove(sessionId: string): Promise<void> {
    const path = this.file(sessionId);
    this.deletions++;
    if (path) await rm(path, { force: true });
  }

  /** Delete every transcript. Returns how many were removed. */
  async removeAll(): Promise<number> {
    return this.sweep(() => false);
  }

  /** Delete transcripts (and stray temp files) of sessions `keep` does not know. */
  async sweep(keep: (sessionId: string) => boolean): Promise<number> {
    this.deletions++;
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const isTxt = name.endsWith('.txt');
      if (isTxt && keep(name.slice(0, -'.txt'.length))) continue;
      await rm(join(this.dir(), name), { force: true }).catch(() => undefined);
      if (isTxt) removed++;
    }
    return removed;
  }
}

/** Process-wide instance; the server and the routes share it. */
export const transcriptStore = new TranscriptStore();
