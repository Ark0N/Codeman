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

import { open, stat } from 'node:fs/promises';
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
/** Transcripts cached at once. */
const MAX_TRANSCRIPTS = 6;

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

/** For tests: forget every cached transcript. */
export function clearStoryReaderCache(): void {
  cache.clear();
  inFlight.clear();
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  const buf = Buffer.alloc(length);
  const handle = await open(path, 'r');
  try {
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buf, read, length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    await handle.close();
  }
}

const entryChars = (e: StoryEntry): number => JSON.stringify(e).length;

function ingest(entry: CacheEntry, buf: Buffer, startsMidLine: boolean): void {
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
  const text = buf.subarray(begin, lastNewline).toString('utf8');
  entry.offset += lastNewline + 1;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a malformed line is skipped, never fatal
    }
    for (const reduced of entry.reducer.reduce(parsed)) {
      entry.entries.push(reduced);
      entry.chars += entryChars(reduced);
    }
  }
  while (entry.entries.length > MAX_ENTRIES || (entry.chars > MAX_CHARS && entry.entries.length > 1)) {
    const dropped = entry.entries.shift();
    if (dropped) entry.chars -= entryChars(dropped);
    entry.partial = true;
  }
}

async function load(path: string, sidechain: boolean): Promise<StoryEntriesResult> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Transcript is not a regular file');
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
    // The file only grew: read what was appended since the last complete line.
    const buf = await readRange(path, cached.offset, info.size);
    ingest(cached, buf, false);
    cached.size = info.size;
    cached.mtimeMs = info.mtimeMs;
    cache.set(key, cached);
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
    };
    ingest(fresh, await readRange(path, start, info.size), start > 0);
    if (start === 0 || hasTurnStart(fresh.entries)) break;
  }
  const done = fresh as CacheEntry;
  cache.set(key, done);
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
