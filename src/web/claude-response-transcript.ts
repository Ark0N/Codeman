/**
 * @fileoverview A Claude transcript read into the Response Viewer's messages, incrementally.
 *
 * `GET /api/sessions/:id/last-response` answers the Response Viewer, the Discord bridge and the
 * chat view from a Claude session's transcript, an append-only JSONL file that grows past 200 MB
 * on long sessions. The chat view asks again on every `transcript:update`, up to once per 750 ms
 * per session while a turn runs. A read that parsed the whole file each time held the event loop
 * for 375 ms on a 66 MB transcript and 1.5 s on a 219 MB one, which froze every terminal and SSE
 * stream on the server.
 *
 * {@link ClaudeTranscriptReader} keeps the parser's state and the byte offset it reached for each
 * transcript path, in a small LRU. A read parses only the bytes appended since the last one, in
 * chunks with an await between them, so even the first read of a large file never holds the event
 * loop for long. It starts again from byte 0 when the file shrank, was replaced by another file,
 * or no longer holds the bytes it ended on. Reads of one path that overlap share one pass.
 *
 * The parser consumes whole lines only. A last line without its newline is parsed on a copy of
 * the state for that one answer, and parsed for good once its newline arrives, so the answer
 * always equals a parse of the whole file.
 *
 * @dependency prompt-cache-keepwarm.ts (KEEP_WARM_NUDGE), utils/lru-map.ts
 */

import fs from 'node:fs/promises';
import { KEEP_WARM_NUDGE } from '../prompt-cache-keepwarm.js';
import { LRUMap } from '../utils/lru-map.js';

export interface ClaudeResponseMessage {
  kind: 'prompt' | 'response';
  label: 'Prompt' | 'Response';
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
  turn: number;
  queued?: boolean;
  /**
   * Part of a keep-warm turn (prompt-cache-keepwarm.ts): Codeman sent the prompt, not the user,
   * and the reply is its "ok". The chat view leaves such turns out, as Read My Mind does.
   */
  keepAlive?: boolean;
}

/** The last assistant text of a transcript and every message, as the route answers them. */
export interface ClaudeResponseTranscript {
  text: string;
  timestamp: string;
  messages: ClaudeResponseMessage[];
}

interface ClaudeTranscriptEntry {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
  // A prompt typed while Claude is working is absorbed mid-turn and recorded
  // ONLY here — the CLI never re-emits it as a `user` row. Every field stays
  // optional and unvalidated: `queued_command` is not a documented CLI
  // contract, so a missing/renamed field must mean "skip", which is also what
  // the CLI's own non-human queue entries (commandMode 'task-notification',
  // no `origin` key) require. Shape observed on Claude Code 2.1.220-2.1.251.
  attachment?: {
    type?: string;
    prompt?: string;
    commandMode?: string;
    timestamp?: string;
    origin?: { kind?: string };
  };
}

function extractClaudeText(content: unknown, separator: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: string }).text === 'string'
    )
    .map((block) => block.text)
    .join(separator);
}

function isClaudeSyntheticUserMessage(entry: ClaudeTranscriptEntry, text: string): boolean {
  if (entry.isMeta || entry.isCompactSummary) return true;
  return /^(?:<local-command|<command-name>|<task-notification>|<system-reminder>|<teammate-message\b|Another Claude session sent a message:|Base directory for this skill:)/i.test(
    text
  );
}

/**
 * Claude writes an append-only event log: tool results arrive as user rows,
 * thinking/tool_use rows carry no text, and a prompt typed while the agent is
 * working is only ever recorded as an `attachment/queued_command` row. But one
 * assistant row IS one whole model message: measured across ~/.claude/projects
 * (CLI 2.1.220-2.1.251) no assistant row carries more than one content block
 * and no message id carries more than one text block, so there is nothing to
 * reassemble. Emit one card per row and group them with `turn` instead of
 * concatenating a human turn's replies into a single card (#169), which fused
 * up to 74 distinct model messages into one card. Splitting is safe for
 * markdown: no adjacent pair of assistant text rows in the corpus continues a
 * table, a list, or an open code fence.
 *
 * The state is the parse so far, fed one line at a time, so a reader can stop at the end of the
 * file and go on from there when it grows.
 */
export class ClaudeResponseParser {
  private lastText = '';
  private lastTimestamp = '';
  private messages: ClaudeResponseMessage[] = [];
  // #169's replay guards, kept: they now SKIP a duplicated row instead of
  // concatenating it into the previous card.
  private currentUserFragments = new Set<string>();
  private currentAssistantFragments = new Set<string>();
  // Turn 0 is reserved for anything emitted before the first human prompt.
  private turn = 0;
  // Whether the current turn opened with Codeman's keep-warm nudge.
  private keepAliveTurn = false;

  /** A parser in the same state, for parsing a line that may not be finished yet. */
  clone(): ClaudeResponseParser {
    const copy = new ClaudeResponseParser();
    copy.lastText = this.lastText;
    copy.lastTimestamp = this.lastTimestamp;
    copy.messages = this.messages.slice();
    copy.currentUserFragments = new Set(this.currentUserFragments);
    copy.currentAssistantFragments = new Set(this.currentAssistantFragments);
    copy.turn = this.turn;
    copy.keepAliveTurn = this.keepAliveTurn;
    return copy;
  }

  /** The parse so far. The messages array is a copy, so a later line never changes an answer. */
  result(): ClaudeResponseTranscript {
    return { text: this.lastText, timestamp: this.lastTimestamp, messages: this.messages.slice() };
  }

  /** Feed text holding whole lines separated by `\n`. */
  feedLines(text: string): void {
    for (const line of text.split('\n')) this.feedLine(line);
  }

  private pushUserMessage(text: string, timestamp: string | undefined, queued: boolean): void {
    // A run of consecutive human inputs (a mid-turn queued burst) is ONE turn,
    // so the viewer renders it under one badge instead of one badge per line.
    // The keep-warm nudge never joins an earlier user run: the turn before it
    // may have ended without assistant text (an interrupt before Claude wrote
    // anything, or a turn of tool calls only), and its reply belongs to the
    // keep-alive turn, not to the user's prompt.
    const isNudge = text === KEEP_WARM_NUDGE;
    if (isNudge || this.messages.at(-1)?.role !== 'user') {
      this.turn += 1;
      this.keepAliveTurn = isNudge;
    } else if (!isNudge) {
      // A prompt the user queued during the keep-warm turn makes the turn theirs.
      this.keepAliveTurn = false;
    }
    const message: ClaudeResponseMessage = {
      kind: 'prompt',
      label: 'Prompt',
      role: 'user',
      text,
      timestamp,
      turn: this.turn,
    };
    if (queued) message.queued = true;
    if (isNudge) message.keepAlive = true;
    this.messages.push(message);
    this.currentUserFragments.add(text);
    this.currentAssistantFragments.clear();
  }

  feedLine(line: string): void {
    if (!line) return;
    let entry: ClaudeTranscriptEntry;
    try {
      entry = JSON.parse(line) as ClaudeTranscriptEntry;
    } catch {
      return;
    }
    // Sidechains belong to agents/forks, not the main conversation. Meta user
    // rows include repeated image dimensions and other UI-generated context.
    if (entry.isSidechain) return;

    // A prompt typed while Claude is working is absorbed mid-turn and lives
    // ONLY in an attachment row, so it was lost outright. `origin.kind` and
    // `commandMode` separate the human's queue entries from the CLI's own:
    // measured over 57 real transcripts on 2026-09-01, 322 queued_command rows
    // split 163 `prompt`/`human` and 159 `task-notification`, and not one of
    // those 159 carries an `origin` key. The 163 human rows become 162 user
    // cards here — one is a verbatim repeat inside a still-unanswered user run
    // and is collapsed by the dedup guard below — out of 353 user cards total.
    if (entry.type === 'attachment') {
      const queued = entry.attachment;
      if (!queued || queued.type !== 'queued_command') return;
      if (queued.origin?.kind !== 'human' || queued.commandMode !== 'prompt') return;
      const text = typeof queued.prompt === 'string' ? queued.prompt.trim() : '';
      if (!text || isClaudeSyntheticUserMessage(entry, text)) return;
      if (this.currentUserFragments.has(text)) return;
      this.pushUserMessage(text, queued.timestamp || entry.timestamp, true);
      return;
    }

    if (entry.type === 'user') {
      const text = extractClaudeText(entry.message?.content, '\n').trim();
      // A tool_result block has no text block and naturally drops out here.
      if (!text || isClaudeSyntheticUserMessage(entry, text)) return;
      // Claude replays the initial user row while restoring a transcript, and
      // a CLI that also wrote an absorbed prompt as a user row would double it.
      // Both collapse here. The same prompt sent again AFTER a reply is a
      // legitimate second turn, because that reply cleared the set.
      if (this.currentUserFragments.has(text)) return;
      this.pushUserMessage(text, entry.timestamp, false);
      return;
    }

    if (entry.type !== 'assistant') return;
    const text = extractClaudeText(entry.message?.content, '\n\n').trim();
    if (!text) return;
    this.lastText = text;
    this.lastTimestamp = entry.timestamp || '';

    // Replayed snapshots repeat an identical text block inside one turn.
    if (this.currentAssistantFragments.has(text)) return;
    const response: ClaudeResponseMessage = {
      kind: 'response',
      label: 'Response',
      role: 'assistant',
      text,
      timestamp: entry.timestamp,
      turn: this.turn,
    };
    if (this.keepAliveTurn) response.keepAlive = true;
    this.messages.push(response);
    this.currentAssistantFragments.add(text);
    this.currentUserFragments.clear();
  }
}

/** Parse a whole transcript at once. */
export function parseClaudeResponseTranscript(content: string): ClaudeResponseTranscript {
  const parser = new ClaudeResponseParser();
  parser.feedLines(content);
  return parser.result();
}

/** How many bytes before the offset a reader compares, to notice a file rewritten in place. */
const CHECK_BYTES = 64;

interface CachedTranscript {
  parser: ClaudeResponseParser | null;
  dev: number;
  ino: number;
  /** The byte just after the last newline the parser consumed. */
  offset: number;
  /** The bytes that ended at `offset` when the parser reached it. */
  check: Buffer;
  running: Promise<ClaudeResponseTranscript> | null;
  queued: Promise<ClaudeResponseTranscript> | null;
}

export interface ClaudeTranscriptReaderOptions {
  /** How many transcripts keep their parse. */
  maxEntries?: number;
  /** How many bytes one read call takes, and so how much one synchronous parse step covers. */
  chunkBytes?: number;
}

/** Reads Claude transcripts, parsing each file's new bytes only. See the file overview. */
export class ClaudeTranscriptReader {
  private readonly cache: LRUMap<string, CachedTranscript>;
  private readonly chunkBytes: number;

  constructor(options: ClaudeTranscriptReaderOptions = {}) {
    this.cache = new LRUMap({ maxSize: options.maxEntries ?? 16 });
    this.chunkBytes = options.chunkBytes ?? 1024 * 1024;
  }

  /**
   * The transcript at `path`, parsed to its current end. Rejects when the file cannot be read.
   *
   * A read asked for while another runs waits for it and then parses what was appended meanwhile,
   * so it never answers from before its own request. Every read asked for during that wait
   * shares the one pass that follows.
   */
  read(path: string): Promise<ClaudeResponseTranscript> {
    let entry = this.cache.get(path);
    if (!entry) {
      entry = { parser: null, dev: 0, ino: 0, offset: 0, check: Buffer.alloc(0), running: null, queued: null };
      this.cache.set(path, entry);
    }
    const cached = entry;
    if (cached.queued) return cached.queued;
    if (cached.running) {
      cached.queued = cached.running
        .catch(() => undefined)
        .then(() => {
          cached.queued = null;
          return this.start(path, cached);
        });
      return cached.queued;
    }
    return this.start(path, cached);
  }

  private start(path: string, entry: CachedTranscript): Promise<ClaudeResponseTranscript> {
    entry.running = this.update(path, entry).finally(() => {
      entry.running = null;
    });
    return entry.running;
  }

  private async update(path: string, entry: CachedTranscript): Promise<ClaudeResponseTranscript> {
    const handle = await fs.open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`not a file: ${path}`);

      let reset = !entry.parser || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size < entry.offset;
      if (!reset && entry.check.length > 0) {
        const now = Buffer.alloc(entry.check.length);
        const { bytesRead } = await handle.read(now, 0, now.length, entry.offset - now.length);
        reset = bytesRead !== now.length || !now.equals(entry.check);
      }
      if (reset || !entry.parser) {
        entry.parser = new ClaudeResponseParser();
        entry.dev = stat.dev;
        entry.ino = stat.ino;
        entry.offset = 0;
        entry.check = Buffer.alloc(0);
      }
      const parser = entry.parser;

      // Read to the size the stat saw; bytes written after it wait for the next read.
      let position = entry.offset;
      let carry = Buffer.alloc(0);
      while (position < stat.size) {
        const chunk = Buffer.allocUnsafe(Math.min(this.chunkBytes, stat.size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const data =
          carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        // A newline byte never occurs inside a multi-byte UTF-8 character, so cutting there is safe.
        const newline = data.lastIndexOf(0x0a);
        if (newline === -1) {
          carry = data;
          continue;
        }
        parser.feedLines(data.toString('utf8', 0, newline));
        entry.offset = position - (data.length - newline - 1);
        entry.check = Buffer.from(data.subarray(Math.max(0, newline + 1 - CHECK_BYTES), newline + 1));
        carry = Buffer.from(data.subarray(newline + 1));
      }

      if (carry.length === 0) return parser.result();
      const unfinished = parser.clone();
      unfinished.feedLine(carry.toString('utf8'));
      return unfinished.result();
    } catch (err) {
      // A parse left part-way is not trusted: the next read starts from byte 0.
      entry.parser = null;
      throw err;
    } finally {
      await handle.close().catch(() => {});
    }
  }
}
