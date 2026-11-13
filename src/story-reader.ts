/**
 * @fileoverview Story Mode transcript reader: the IO half of Story Mode (the pure half is story-mode.ts).
 *
 * Reads the TAIL of a Claude Code transcript, never the whole file: transcripts reach tens of MB
 * (Write/Edit results carry whole files). The first read takes the last `STORY_TAIL_BYTES` and drops
 * the partial first line, and takes a bigger tail (up to 64 MB) only when that window holds no prompt;
 * later reads, while the file only grows, read just the appended bytes. A line that is still being
 * written (no newline yet) is left for the next read.
 *
 * Each transcript's reduced entries are cached (`createStoryReducer()` already dropped file contents,
 * images and long outputs), bounded per transcript by entry count and character budget, and across
 * transcripts by an LRU, so a live view refetching every second costs one small append read.
 * Concurrent reads of one path share a single in-flight promise.
 *
 * All IO is async (`fs/promises`); nothing here runs on a path the browser supplied. The route decides
 * which file is read (story-routes.ts).
 */

import { constants } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { LRUMap } from './utils/lru-map.js';
import { createStoryReducer, type StoryEntry, type StoryReducer } from './story-mode.js';

/** How much of the file's end a first read takes. */
export const STORY_TAIL_BYTES = 8 * 1024 * 1024;
/**
 * Larger tails, tried in order only while the window holds no prompt at all: one long turn can be
 * bigger than 8 MB on its own (tool results carry whole files; measured ~60 KB per result line on
 * large local transcripts), and its page would then lose its first panels.
 */
const TAIL_STEPS = [STORY_TAIL_BYTES, 24 * 1024 * 1024, 64 * 1024 * 1024];
/** Entries kept per transcript (the oldest go first). */
const MAX_ENTRIES = 20_000;
/** Approximate characters kept per transcript across all entries. */
const MAX_CHARS = 6_000_000;
/** Transcripts cached at once, and their characters together (the oldest go first past either). */
const MAX_TRANSCRIPTS = 24;
const MAX_CACHE_CHARS = 30_000_000;

interface CacheEntry {
  sidechain: boolean;
  size: number;
  mtimeMs: number;
  /** Byte offset up to which complete lines were consumed. */
  offset: number;
  entries: StoryEntry[];
  chars: number;
  reducer: StoryReducer;
  /** The read began mid-file, so the oldest turn may be cut. */
  partial: boolean;
  /** A turn started inside what was read (it may have been trimmed away since). */
  sawTurnStart: boolean;
}

export interface StoryEntriesResult {
  entries: StoryEntry[];
  partial: boolean;
  /** Changes whenever the file does (size and mtime); the route builds its ETag from it. */
  version: string;
}

const versionOf = (size: number, mtimeMs: number) => `${size}-${Math.trunc(mtimeMs)}`;
/** A turn starts inside the window: a prompt that was not queued into a running turn. */
const hasTurnStart = (entries: StoryEntry[]) => entries.some((e) => e.k === 'prompt' && !e.queued);

const cache = new LRUMap<string, CacheEntry>({ maxSize: MAX_TRANSCRIPTS });
const inFlight = new Map<string, Promise<StoryEntriesResult>>();

/**
 * The version a read of `path` would report (size and mtime), from a stat only: lets the route answer
 * 304 for an unchanged page without reading or parsing anything, cached or not. Null for anything
 * but a regular file.
 */
export async function storyFileVersion(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? versionOf(info.size, info.mtimeMs) : null;
  } catch {
    return null;
  }
}

/** Evicts the least recently used transcripts while the cache holds more characters than its budget. */
function keepCacheInBudget(keep: string): void {
  let total = 0;
  for (const e of cache.values()) total += e.chars;
  for (const key of cache.keysInOrder()) {
    if (total <= MAX_CACHE_CHARS) break;
    if (key === keep) continue;
    total -= cache.get(key)?.chars ?? 0;
    cache.delete(key);
  }
}

/** For tests: forget every cached transcript. */
export function clearStoryReaderCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Opens `path` for reading only if it is a regular file, and keeps the handle: every later check and
 * read goes through it, never through the path again. Opened non-blocking, so a FIFO (or a symlink
 * to one) swapped in never pins a libuv worker waiting for a writer; a device or a FIFO is refused by
 * the handle's own stat.
 */
export async function openRegularFile(path: string): Promise<{ handle: FileHandle; size: number; mtimeMs: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Transcript is not a regular file');
    return { handle, size: info.size, mtimeMs: info.mtimeMs };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buf, read, length - read, start + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/** A small regular file read whole (a helper's `.meta.json`), or null when it is anything else or too big. */
export async function readSmallRegularFile(path: string, maxBytes: number): Promise<string | null> {
  let opened: Awaited<ReturnType<typeof openRegularFile>>;
  try {
    opened = await openRegularFile(path);
  } catch {
    return null;
  }
  try {
    if (opened.size > maxBytes) return null;
    return (await readRange(opened.handle, 0, opened.size)).toString('utf8');
  } finally {
    await opened.handle.close();
  }
}

const entryChars = (e: StoryEntry): number => JSON.stringify(e).length;

/** Bytes of lines parsed between yields to the event loop: a big first read must not stall the server. */
const YIELD_EVERY_BYTES = 1024 * 1024;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Parses the complete lines in `buf` into the entry. Lines are decoded one at a time (never the whole
 * buffer as one string: a 64 MB tail would be ~128 MB of UTF-16), and the loop yields every
 * `YIELD_EVERY_BYTES`, so even the largest read keeps the event loop moving.
 */
async function ingest(entry: CacheEntry, buf: Buffer, startsMidLine: boolean): Promise<void> {
  let begin = 0;
  if (startsMidLine) {
    const firstNewline = buf.indexOf(0x0a);
    if (firstNewline < 0) return; // one huge partial line: nothing complete yet
    begin = firstNewline + 1;
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < begin) {
    // No complete line in what was read; consume nothing beyond a dropped partial head.
    entry.offset += begin;
    return;
  }
  entry.offset += lastNewline + 1;
  let pos = begin;
  let sinceYield = 0;
  while (pos < lastNewline) {
    let nl = buf.indexOf(0x0a, pos);
    if (nl < 0 || nl > lastNewline) nl = lastNewline;
    if (nl - pos > 1) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(buf.toString('utf8', pos, nl));
      } catch {
        parsed = null; // a malformed line is skipped, never fatal
      }
      for (const reduced of entry.reducer.reduce(parsed)) {
        entry.entries.push(reduced);
        entry.chars += entryChars(reduced);
        if (reduced.k === 'prompt' && !reduced.queued) entry.sawTurnStart = true;
      }
    }
    sinceYield += nl - pos + 1;
    pos = nl + 1;
    if (sinceYield >= YIELD_EVERY_BYTES) {
      sinceYield = 0;
      // Trimmed as it grows, so the peak stays near the caps, not the size of the window.
      trim(entry);
      await yieldToLoop();
    }
  }
  trim(entry);
}

/**
 * Drops the oldest entries over the caps in ONE splice: dropping them one `shift()` at a time is
 * quadratic and never yields (seconds on a long turn's tail).
 */
function trim(entry: CacheEntry): void {
  const all = entry.entries;
  let drop = 0;
  let chars = entry.chars;
  while (all.length - drop > MAX_ENTRIES || (chars > MAX_CHARS && all.length - drop > 1)) {
    chars -= entryChars(all[drop]);
    drop++;
  }
  if (!drop) return;
  all.splice(0, drop);
  entry.chars = chars;
  entry.partial = true;
}

async function load(path: string, sidechain: boolean): Promise<StoryEntriesResult> {
  const { handle, ...info } = await openRegularFile(path);
  try {
    return await loadFrom(handle, info, path, sidechain);
  } finally {
    await handle.close();
  }
}

async function loadFrom(
  handle: FileHandle,
  info: { size: number; mtimeMs: number },
  path: string,
  sidechain: boolean
): Promise<StoryEntriesResult> {
  const key = sidechain ? `${path}#sidechain` : path;
  const cached = cache.get(key);
  const version = versionOf(info.size, info.mtimeMs);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return { entries: cached.entries, partial: cached.partial, version };
  }
  if (
    cached &&
    info.size > cached.offset &&
    info.size - cached.offset <= STORY_TAIL_BYTES &&
    info.size >= cached.size
  ) {
    // The file only grew: read what was appended since the last complete line. (A file rewritten to
    // a larger size would read as an append; transcripts are append-only, so it never is.)
    const buf = await readRange(handle, cached.offset, info.size);
    await ingest(cached, buf, false);
    cached.size = info.size;
    cached.mtimeMs = info.mtimeMs;
    cache.set(key, cached);
    keepCacheInBudget(key);
    return { entries: cached.entries, partial: cached.partial, version };
  }
  // First read, a rewrite, or more appended than a tail holds: start over from the tail, and take a
  // bigger one while the window has no turn start in it. Each step re-reads from scratch with a
  // fresh reducer, because a result can only be read once its tool call has been seen.
  let fresh: CacheEntry | null = null;
  for (const tail of TAIL_STEPS) {
    const start = Math.max(0, info.size - tail);
    fresh = {
      sidechain,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: start,
      entries: [],
      chars: 0,
      reducer: createStoryReducer({ sidechain }),
      partial: start > 0,
      sawTurnStart: false,
    };
    await ingest(fresh, await readRange(handle, start, info.size), start > 0);
    // A turn start seen and then trimmed away would be trimmed from a bigger tail too: stop there.
    if (start === 0 || fresh.sawTurnStart || hasTurnStart(fresh.entries)) break;
  }
  const done = fresh as CacheEntry;
  cache.set(key, done);
  keepCacheInBudget(key);
  return { entries: done.entries, partial: done.partial, version };
}

/**
 * Reduced entries for the transcript at `path`, newest last. `sidechain` reads a helper's own
 * transcript (every line there is a sidechain line). Throws when the file cannot be read; the caller
 * turns that into an error response.
 */
export function readStoryEntries(
  path: string,
  { sidechain = false }: { sidechain?: boolean } = {}
): Promise<StoryEntriesResult> {
  const key = sidechain ? `${path}#sidechain` : path;
  const running = inFlight.get(key);
  if (running) return running;
  const promise = load(path, sidechain).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
