/**
 * @fileoverview Per-session edit history: the parsed edits and Bash images of one claude
 * session, plus where in each transcript file reading stopped.
 *
 * Sources are the main transcript (`main`) and each subagent transcript
 * (`subagents/agent-<id>.jsonl`). Each has a cursor:
 *   - `offset` — the next byte to read forward; always a line boundary.
 *   - `floor`  — the lowest byte already parsed; > 0 while older lines are unread
 *                ("ältere laden" reads `[floor − budget, floor)`).
 * The store decides WHICH byte range to read (`nextRange`/`olderRange`); the caller reads
 * it — locally or over ssh — and hands the bytes to `apply`. Cuts happen only at `\n`,
 * which never occurs inside a UTF-8 sequence, so multibyte characters split by a chunk
 * boundary are never decoded half.
 *
 * A first read of a file starts `budget` bytes before its end (transcripts reach 100 MB+),
 * drops the cut first line and leaves `floor` there. A line longer than the budget is
 * skipped instead of blocking the cursor.
 *
 * A new conversation (`/clear`, resume) arrives as a new `transcriptId`: cursors and
 * pending Bash calls start over, entries stay. Entries are capped at {@link MAX_ENTRIES}
 * and {@link MAX_STORE_BYTES} of diff text; the oldest by time are dropped.
 *
 * ⚠️ The file holds secrets: a diff carries whatever the agent wrote, keys and `.env`
 * contents included. So, like `intents.json`, it is written 0600 via tmp+rename (in a 0700
 * dir), bounded, deleted with the session (`remove()`), never fed to `/api/search`, and
 * blocked from the file routes by `isSensitivePath` (`web/sensitive-path.ts`).
 *
 * Persisted as JSON under `dataPath('edit-history', '<sessionId>.json')`, written debounced.
 *
 * Tests: `test/edit-history-store.test.ts`.
 *
 * @module edit-history-store
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from './config/instance.js';
import {
  MAX_HUNK_BYTES,
  parseClaudeEditLines,
  type EditRecord,
  type EditTool,
  type ImageCandidate,
  type PendingBash,
} from './edit-history-parse.js';

export const MAX_ENTRIES = 500;
/** Diff text (and paths) kept per session; see {@link entryBytes}. */
export const MAX_STORE_BYTES = 4 * 1024 * 1024;
/** Longest string kept from a subagent's `meta.json` field. */
export const MAX_AGENT_META_CHARS = 1024;
/** Bytes read per file and pass (first read, forward step, "older" step). */
export const READ_BUDGET_BYTES = 8 * 1024 * 1024;
export const MAIN_SOURCE = 'main';
const SAVE_DEBOUNCE_MS = 1000;
const FILE_VERSION = 1;
const NL = 0x0a;

/** `bash`: an image a Bash call wrote; `sent`: an image claude delivered to the user. */
export type EditHistoryTool = EditTool | 'bash' | 'sent';

export interface EditHistoryEntry extends Omit<EditRecord, 'tool'> {
  tool: EditHistoryTool;
}

export interface SourceCursor {
  offset: number;
  floor: number;
  /** The next forward read starts inside a line longer than the budget; skip to its end. */
  midLine?: boolean;
}

export interface AgentMeta {
  description: string;
  agentType: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface ByteRange {
  offset: number;
  len: number;
}

export interface ApplyInput {
  transcriptId: string;
  /** `main` or `subagents/agent-<id>.jsonl`. */
  source: string;
  startOffset: number;
  chunk: Buffer;
  /** Size of the file when the chunk was read. */
  size: number;
}

export interface ApplyResult {
  added: number;
  candidates: ImageCandidate[];
}

export interface ConfirmedImage {
  toolUseId: string;
  path: string;
  ts: number;
  agentId?: string;
  tool?: 'bash' | 'sent';
}

export interface EditHistoryStoreOptions {
  /** Directory holding `<sessionId>.json`; default `dataPath('edit-history')`. */
  dir?: string;
  debounceMs?: number;
}

interface StoreFile {
  version: number;
  sessionId: string;
  transcriptId: string | null;
  cursors: Record<string, SourceCursor>;
  pendingBash: PendingBash[];
  agents: Record<string, AgentMeta>;
  entries: EditHistoryEntry[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What an entry costs against {@link MAX_STORE_BYTES}: its path and diff lines, plus a fixed overhead. */
export function entryBytes(e: EditHistoryEntry): number {
  let n = 128 + Buffer.byteLength(e.path);
  for (const h of e.hunks) if (Array.isArray(h?.lines)) for (const l of h.lines) n += Buffer.byteLength(String(l)) + 3;
  return n;
}

function metaString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, MAX_AGENT_META_CHARS) : undefined;
}

/** Parse an `agent-<id>.meta.json` text; null when it is not an object. */
export function parseAgentMeta(text: string): AgentMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const meta: AgentMeta = {
    description: metaString(raw.description) ?? '',
    agentType: metaString(raw.agentType) ?? '',
  };
  const worktreePath = metaString(raw.worktreePath);
  const worktreeBranch = metaString(raw.worktreeBranch);
  if (worktreePath) meta.worktreePath = worktreePath;
  if (worktreeBranch) meta.worktreeBranch = worktreeBranch;
  return meta;
}

export class EditHistoryStore {
  readonly sessionId: string;
  private readonly file: string;
  private readonly debounceMs: number;
  private transcriptId: string | null = null;
  private cursors = new Map<string, SourceCursor>();
  private pendingBash: PendingBash[] = [];
  private agents = new Map<string, AgentMeta>();
  private entries = new Map<string, EditHistoryEntry>();
  /** Sum of {@link entryBytes} over `entries`. */
  private bytes = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private removed = false;

  constructor(sessionId: string, opts: EditHistoryStoreOptions = {}) {
    this.sessionId = sessionId;
    this.file = join(opts.dir ?? dataPath('edit-history'), `${sessionId}.json`);
    this.debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
  }

  /** A store with the persisted state of `sessionId`; empty when the file is missing or unreadable. */
  static async load(sessionId: string, opts: EditHistoryStoreOptions = {}): Promise<EditHistoryStore> {
    const store = new EditHistoryStore(sessionId, opts);
    let data: unknown;
    try {
      data = JSON.parse(await readFile(store.file, 'utf-8'));
    } catch {
      return store;
    }
    if (!isObj(data)) return store;
    if (data.version !== FILE_VERSION) return store;
    const f = data as unknown as StoreFile;
    store.transcriptId = typeof f.transcriptId === 'string' ? f.transcriptId : null;
    for (const [k, c] of Object.entries(isObj(f.cursors) ? f.cursors : {})) {
      if (isObj(c) && typeof c.offset === 'number' && typeof c.floor === 'number') store.cursors.set(k, c);
    }
    if (Array.isArray(f.pendingBash)) store.pendingBash = f.pendingBash;
    for (const [k, a] of Object.entries(isObj(f.agents) ? f.agents : {})) store.agents.set(k, a);
    if (Array.isArray(f.entries)) {
      const loaded = f.entries.filter(
        (e): e is EditHistoryEntry =>
          isObj(e) && typeof e.id === 'string' && typeof e.path === 'string' && Array.isArray(e.hunks)
      );
      store.addRecords(loaded);
    }
    return store;
  }

  getTranscriptId(): string | null {
    return this.transcriptId;
  }

  getCursor(source: string): SourceCursor | undefined {
    const c = this.cursors.get(source);
    return c ? { ...c } : undefined;
  }

  /**
   * True while any source has unread older lines that could still be shown. At a cap (no
   * room left for another entry) an older edit would be dropped the moment it is read, so
   * there is nothing more to load.
   */
  get backfillTruncated(): boolean {
    if (this.entries.size >= MAX_ENTRIES || this.bytes > MAX_STORE_BYTES - MAX_HUNK_BYTES) return false;
    for (const c of this.cursors.values()) if (c.floor > 0) return true;
    return false;
  }

  /** Entries newest first. */
  list(): EditHistoryEntry[] {
    return [...this.entries.values()].sort((a, b) => b.ts - a.ts);
  }

  get(id: string): EditHistoryEntry | undefined {
    return this.entries.get(id);
  }

  getAgents(): Record<string, AgentMeta> {
    return Object.fromEntries(this.agents);
  }

  hasAgentMeta(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** Record a subagent's `meta.json`; ignored when it does not parse. */
  setAgentMeta(agentId: string, metaText: string): void {
    const meta = parseAgentMeta(metaText);
    if (!meta) return;
    this.agents.set(agentId, meta);
    this.scheduleSave();
  }

  /**
   * The next forward range to read from `source`, or null when nothing is new.
   * A conversation other than the stored one starts from scratch (see `apply`).
   */
  nextRange(source: string, size: number, transcriptId: string, budget = READ_BUDGET_BYTES): ByteRange | null {
    const cursor = transcriptId === this.transcriptId ? this.cursors.get(source) : undefined;
    if (cursor && size >= cursor.offset) {
      if (size === cursor.offset) return null;
      return { offset: cursor.offset, len: Math.min(budget, size - cursor.offset) };
    }
    // Unknown file, new conversation, or a file that shrank (replaced): read its end.
    const offset = Math.max(0, size - budget);
    return size > offset ? { offset, len: size - offset } : null;
  }

  /** The next older range of `source` ("ältere laden"), or null when it is read to its start. */
  olderRange(source: string, budget = READ_BUDGET_BYTES): ByteRange | null {
    const cursor = this.cursors.get(source);
    if (!cursor || cursor.floor <= 0) return null;
    const offset = Math.max(0, cursor.floor - budget);
    return { offset, len: cursor.floor - offset };
  }

  /** Every source with a cursor in the current conversation. */
  knownSources(): string[] {
    return [...this.cursors.keys()];
  }

  /** Sources with older lines left. */
  sourcesWithOlder(): string[] {
    return [...this.cursors.entries()].filter(([, c]) => c.floor > 0).map(([s]) => s);
  }

  /** Apply a forward chunk read at `nextRange`. Returns new entries and Bash image candidates. */
  apply(input: ApplyInput): ApplyResult {
    const { transcriptId, source, startOffset, chunk, size } = input;
    if (transcriptId !== this.transcriptId) {
      this.transcriptId = transcriptId;
      this.cursors.clear();
      this.pendingBash = [];
    }
    let cursor = this.cursors.get(source);
    if (cursor && size < cursor.offset) {
      this.cursors.delete(source);
      cursor = undefined;
    }
    if (cursor && startOffset !== cursor.offset) return { added: 0, candidates: [] };

    const atEof = startOffset + chunk.length >= size;
    // Bytes before `from` belong to a line that started before this chunk.
    let from = 0;
    if (cursor ? cursor.midLine : startOffset > 0) {
      const nl = chunk.indexOf(NL);
      if (nl === -1) {
        // Still inside that line: move past it unless it is the line being written.
        if (!atEof) this.setCursor(source, cursor, startOffset + chunk.length, startOffset, true);
        return { added: 0, candidates: [] };
      }
      from = nl + 1;
    }
    const lastNl = chunk.lastIndexOf(NL);
    if (lastNl < from) {
      if (!atEof && chunk.length > 0) {
        // One line longer than the budget: skip it instead of re-reading it forever.
        this.setCursor(source, cursor, startOffset + chunk.length, startOffset + from, true);
      } else if (!cursor) {
        this.setCursor(source, undefined, startOffset + from, startOffset + from, false);
      }
      return { added: 0, candidates: [] };
    }
    const end = lastNl + 1;
    this.setCursor(source, cursor, startOffset + end, startOffset + from, false);
    const parsed = parseClaudeEditLines(chunk.subarray(from, end).toString('utf8'), this.pendingBash);
    this.pendingBash = parsed.pending;
    const added = this.addRecords(parsed.records);
    this.scheduleSave();
    return { added, candidates: parsed.candidates };
  }

  /** Apply a chunk read at `olderRange`: it ends at the floor, a line boundary. */
  applyOlder(input: ApplyInput): ApplyResult {
    const { transcriptId, source, startOffset, chunk } = input;
    const cursor = this.cursors.get(source);
    if (transcriptId !== this.transcriptId || !cursor || startOffset + chunk.length !== cursor.floor) {
      return { added: 0, candidates: [] };
    }
    let from = 0;
    if (startOffset > 0) {
      const nl = chunk.indexOf(NL);
      // No line start in the whole block: one oversized line, skip it.
      from = nl === -1 ? chunk.length : nl + 1;
    }
    cursor.floor = startOffset + from;
    // Calls whose results lie in already-read newer lines cannot be paired here.
    const parsed = parseClaudeEditLines(chunk.subarray(from).toString('utf8'));
    const added = this.addRecords(parsed.records);
    this.scheduleSave();
    return { added, candidates: parsed.candidates };
  }

  /** Add Bash images whose mtime was confirmed inside their call's window. */
  addImageEntries(images: readonly ConfirmedImage[]): number {
    const records: EditHistoryEntry[] = images.map((img) => {
      const entry: EditHistoryEntry = {
        id: `${img.toolUseId}:${img.path}`,
        ts: img.ts,
        path: img.path,
        kind: 'image',
        tool: img.tool ?? 'bash',
        created: false,
        added: 0,
        removed: 0,
        hunks: [],
        truncated: false,
      };
      if (img.agentId) entry.agentId = img.agentId;
      return entry;
    });
    const added = this.addRecords(records);
    if (added) this.scheduleSave();
    return added;
  }

  /** Write now (cancels a pending debounced write). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.removed) return;
    const data: StoreFile = {
      version: FILE_VERSION,
      sessionId: this.sessionId,
      transcriptId: this.transcriptId,
      cursors: Object.fromEntries(this.cursors),
      pendingBash: this.pendingBash,
      agents: Object.fromEntries(this.agents),
      entries: this.list(),
    };
    const dir = join(this.file, '..');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // `mode` applies only to a file being created: the fresh tmp file is 0600, and the rename
    // makes it the store, so an existing store never keeps wider bits.
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Delete the persisted file (session deleted); later changes are no longer written. */
  async remove(): Promise<void> {
    this.removed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await unlink(this.file).catch(() => undefined);
  }

  private setCursor(
    source: string,
    cursor: SourceCursor | undefined,
    offset: number,
    firstFloor: number,
    midLine: boolean
  ): void {
    const next: SourceCursor = { offset, floor: cursor ? cursor.floor : firstFloor };
    if (midLine) next.midLine = true;
    this.cursors.set(source, next);
  }

  private addRecords(records: readonly EditHistoryEntry[]): number {
    const fresh: string[] = [];
    for (const r of records) {
      if (this.entries.has(r.id)) continue;
      this.entries.set(r.id, r);
      this.bytes += entryBytes(r);
      fresh.push(r.id);
    }
    if (this.entries.size > MAX_ENTRIES || this.bytes > MAX_STORE_BYTES) {
      for (const e of [...this.entries.values()].sort((a, b) => a.ts - b.ts)) {
        if (this.entries.size <= MAX_ENTRIES && this.bytes <= MAX_STORE_BYTES) break;
        this.entries.delete(e.id);
        this.bytes -= entryBytes(e);
      }
    }
    // Only what is still there counts: an "older" block past the cap adds nothing.
    return fresh.filter((id) => this.entries.has(id)).length;
  }

  private scheduleSave(): void {
    if (this.removed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch((err) => {
        console.warn(`[EditHistory] Save failed for session ${this.sessionId}:`, err);
      });
    }, this.debounceMs);
    this.saveTimer.unref?.();
  }
}
