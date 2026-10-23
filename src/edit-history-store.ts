/**
 * @fileoverview Per-session edit history: the parsed edits and Bash images of one claude
 * session, plus where in each transcript file reading stopped.
 *
 * Sources are the main transcript (`main`) and each subagent transcript
 * (`subagents/agent-<id>.jsonl`). Each has a cursor:
 *   - `offset` — the next byte to read forward; always a line boundary.
 *   - `floor`  — the lowest byte already parsed; > 0 while older lines are unread
 *                ("ältere laden" reads `[floor − budget, floor)`, see `olderRange`).
 * The reader (`edit-history-local-source.ts`) reads forward from each `offset` of the
 * current conversation, a file without one from `budget` bytes before its end, and hands the
 * bytes to `apply`. Cuts happen only at `\n`, which never occurs inside a UTF-8 sequence, so
 * multibyte characters split by a chunk boundary are never decoded half.
 *
 * A first read of a file starts `budget` bytes before its end (transcripts reach 100 MB+),
 * drops the cut first line and leaves `floor` there. A line longer than the budget is
 * skipped instead of blocking the cursor, reading forward (`midLine`) and backward
 * (`floorMidLine`); the line after it (forward) or before it (backward) is read whole.
 * That needs every chunk to be a full budget unless it reaches the file's end (forward) or
 * start (older): a chunk with no line end then means one line longer than the budget. The
 * caller does not hand over a chunk that a budget shared by several files cut short.
 *
 * A new conversation (`/clear`, resume) arrives as a new `transcriptId`: cursors and
 * pending Bash calls start over, entries stay. Entries are capped at {@link MAX_ENTRIES}
 * and {@link MAX_STORE_BYTES} of diff text; the oldest by time are dropped. Besides them
 * the file holds one cursor per transcript file of the current conversation, at most
 * {@link MAX_PENDING_BASH} unanswered Bash calls and at most {@link MAX_AGENTS} subagent labels.
 *
 * ⚠️ The file holds secrets: a diff carries whatever the agent wrote, keys and `.env`
 * contents included. So, like `intents.json`, it is written 0600 via tmp+rename, bounded,
 * deleted with the session (`remove()`; `sweep()` at startup removes files no session owns),
 * never fed to `/api/search`, and blocked from the file routes by `isSensitivePath`
 * (`web/sensitive-path.ts`). `load()` takes the file as untrusted: past
 * {@link MAX_FILE_BYTES} it is not parsed, and every part is rebuilt under the same bounds.
 *
 * Persisted as JSON under `dataPath('edit-history', '<sessionId>.json')`, written debounced.
 *
 * Tests: `test/edit-history-store.test.ts`.
 *
 * @module edit-history-store
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from './config/instance.js';
import {
  capHunks,
  MAX_HUNK_BYTES,
  MAX_PENDING_BASH,
  MAX_PENDING_COMMAND_CHARS,
  MAX_PENDING_FIELD_CHARS,
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
/**
 * Subagent labels kept; past it the oldest one no entry uses is dropped. One more than
 * {@link MAX_ENTRIES}, so besides the newest label there always is one.
 */
export const MAX_AGENTS = MAX_ENTRIES + 1;
/** Bytes read per file and pass (first read, forward step, "older" step). */
export const READ_BUDGET_BYTES = 8 * 1024 * 1024;
/**
 * A store file larger than this is not parsed (starts empty). One written within the caps
 * above stays far below it; JSON escaping at most doubles ordinary text.
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAIN_SOURCE = 'main';
const SAVE_DEBOUNCE_MS = 1000;
const FILE_VERSION = 1;
const NL = 0x0a;
/** A transcript id as the reader takes it (`<id>.jsonl`): no path separators. */
const TRANSCRIPT_ID = /^[A-Za-z0-9._-]+$/;
/**
 * Names this process's tmp files (`<id>.json.<tag>.tmp`); any other tmp file is left over from
 * an earlier run (`sweep`), even one whose pid this process has again (a container's pid 1).
 */
export const TMP_TAG = `${process.pid}-${randomBytes(4).toString('hex')}`;

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
  /** `floor` lies inside a line longer than the budget; the next older read drops its tail. */
  floorMidLine?: boolean;
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

/** What an entry costs against {@link MAX_STORE_BYTES}: its strings and diff lines, plus a fixed overhead. */
export function entryBytes(e: EditHistoryEntry): number {
  let n = 128 + Buffer.byteLength(e.id) + Buffer.byteLength(e.path) + Buffer.byteLength(e.agentId ?? '');
  for (const h of e.hunks) for (const l of h.lines) n += Buffer.byteLength(l) + 3;
  return n;
}

function metaString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, MAX_AGENT_META_CHARS) : undefined;
}

/** Parse an `agent-<id>.meta.json` text; null when it is not an object. */
export function parseAgentMeta(text: string): AgentMeta | null {
  try {
    return agentMetaFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

function isOffset(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

// The loaders below take the persisted file as untrusted: a hand-edited or damaged store
// loses the broken parts instead of failing every request or stalling a cursor.

function agentMetaFrom(raw: unknown): AgentMeta | null {
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

function cursorFrom(raw: unknown): SourceCursor | null {
  if (!isObj(raw) || !isOffset(raw.offset) || !isOffset(raw.floor) || raw.floor > raw.offset) return null;
  const cursor: SourceCursor = { offset: raw.offset, floor: raw.floor };
  if (raw.midLine === true) cursor.midLine = true;
  if (raw.floorMidLine === true) cursor.floorMidLine = true;
  return cursor;
}

const loadedField = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PENDING_FIELD_CHARS;

function pendingBashFrom(raw: unknown): PendingBash | null {
  if (!isObj(raw)) return null;
  const { id, ts, command, cwd, agentId } = raw;
  if (!loadedField(id) || !Number.isFinite(ts) || typeof command !== 'string' || !loadedField(cwd)) return null;
  if (agentId !== undefined && !loadedField(agentId)) return null;
  const pending: PendingBash = { id, ts: ts as number, command: command.slice(0, MAX_PENDING_COMMAND_CHARS), cwd };
  if (agentId) pending.agentId = agentId;
  return pending;
}

const ENTRY_KINDS = new Set(['code', 'image']);
const ENTRY_TOOLS = new Set(['Edit', 'Write', 'edit', 'bash', 'sent']);
const countFrom = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/**
 * A loaded entry rebuilt from its known fields: unknown fields and non-string diff lines are
 * dropped and the per-edit {@link MAX_HUNK_BYTES} is applied again; null when it is unusable.
 */
function entryFrom(raw: unknown): EditHistoryEntry | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.path !== 'string' || !raw.path) return null;
  if (!Number.isFinite(raw.ts) || !ENTRY_KINDS.has(raw.kind as string) || !ENTRY_TOOLS.has(raw.tool as string)) {
    return null;
  }
  if (!Array.isArray(raw.hunks)) return null;
  const { hunks, truncated } = capHunks(raw.hunks);
  const entry: EditHistoryEntry = {
    id: raw.id,
    ts: raw.ts as number,
    path: raw.path,
    kind: raw.kind as EditHistoryEntry['kind'],
    tool: raw.tool as EditHistoryTool,
    created: raw.created === true,
    added: countFrom(raw.added),
    removed: countFrom(raw.removed),
    hunks,
    truncated: truncated || raw.truncated === true,
  };
  if (typeof raw.agentId === 'string' && raw.agentId) entry.agentId = raw.agentId;
  return entry;
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
  /** The last queued write; `remove()` waits for it. */
  private writing: Promise<void> | null = null;
  private removed = false;

  constructor(sessionId: string, opts: EditHistoryStoreOptions = {}) {
    this.sessionId = sessionId;
    this.file = join(opts.dir ?? dataPath('edit-history'), `${sessionId}.json`);
    this.debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
  }

  /**
   * A store with the persisted state of `sessionId`; empty when the file is missing,
   * unreadable or larger than {@link MAX_FILE_BYTES}.
   */
  static async load(sessionId: string, opts: EditHistoryStoreOptions = {}): Promise<EditHistoryStore> {
    const store = new EditHistoryStore(sessionId, opts);
    let data: unknown;
    try {
      if ((await stat(store.file)).size > MAX_FILE_BYTES) return store;
      data = JSON.parse(await readFile(store.file, 'utf-8'));
    } catch {
      return store;
    }
    if (!isObj(data)) return store;
    if (data.version !== FILE_VERSION) return store;
    const f = data as unknown as StoreFile;
    // The sync builds the previous transcript's path from it (`/clear`), so only a plain id counts.
    store.transcriptId =
      typeof f.transcriptId === 'string' && TRANSCRIPT_ID.test(f.transcriptId) ? f.transcriptId : null;
    // Cursors are offsets into that conversation's files; without it they mean nothing.
    const cursors = store.transcriptId !== null && isObj(f.cursors) ? f.cursors : {};
    for (const [k, raw] of Object.entries(cursors)) {
      const cursor = cursorFrom(raw);
      if (cursor) store.cursors.set(k, cursor);
    }
    if (Array.isArray(f.pendingBash)) {
      store.pendingBash = f.pendingBash
        .map(pendingBashFrom)
        .filter((p): p is PendingBash => p !== null)
        .slice(-MAX_PENDING_BASH);
    }
    if (Array.isArray(f.entries)) {
      store.addRecords(f.entries.map(entryFrom).filter((e): e is EditHistoryEntry => e !== null));
    }
    for (const [k, raw] of Object.entries(isObj(f.agents) ? f.agents : {})) {
      const meta = k.length <= MAX_AGENT_META_CHARS ? agentMetaFrom(raw) : null;
      if (meta) store.putAgent(k, meta);
    }
    return store;
  }

  /**
   * Delete the stored history of every session `keep` rejects, and tmp files other processes
   * left behind (startup: a crash between removing a session's record and deleting its file,
   * or mid-write; an older build).
   * Returns how many sessions' files were deleted.
   */
  static async sweep(
    keep: (sessionId: string) => boolean,
    opts: Pick<EditHistoryStoreOptions, 'dir'> = {}
  ): Promise<number> {
    const dir = opts.dir ?? dataPath('edit-history');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const tmp = /\.json\.[\w-]+\.tmp$/.test(name);
      const stale = tmp
        ? !name.endsWith(`.json.${TMP_TAG}.tmp`)
        : name.endsWith('.json') && !keep(name.slice(0, -'.json'.length));
      if (!stale) continue;
      await unlink(join(dir, name)).catch(() => undefined);
      if (!tmp) removed++;
    }
    return removed;
  }

  /** Delete the stored history of `sessionId` without loading it. */
  static async delete(sessionId: string, opts: Pick<EditHistoryStoreOptions, 'dir'> = {}): Promise<void> {
    await new EditHistoryStore(sessionId, opts).remove();
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
    const meta = this.removed ? null : parseAgentMeta(metaText);
    if (!meta) return;
    this.putAgent(agentId, meta);
    this.scheduleSave();
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

  /**
   * A source whose file is gone (a deleted subagent transcript): its cursor goes, so it no
   * longer offers older lines. Its entries stay.
   */
  dropSource(source: string): void {
    if (this.removed || !this.cursors.delete(source)) return;
    this.scheduleSave();
  }

  /**
   * Apply a forward chunk: read from the source's cursor, or, without one, its last `budget`
   * bytes; a full budget unless it reaches the file's end. A file that shrank below its cursor
   * (replaced) loses the cursor and is read from its end next time. Returns new entries and
   * Bash image candidates.
   */
  apply(input: ApplyInput): ApplyResult {
    if (this.removed) return { added: 0, candidates: [] };
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
        // Still inside that line: move past it unless it is the line being written. A first
        // read began inside it, so the floor does too.
        if (!atEof) this.setCursor(source, cursor, startOffset + chunk.length, startOffset, true, true);
        return { added: 0, candidates: [] };
      }
      from = nl + 1;
    }
    const lastNl = chunk.lastIndexOf(NL);
    if (lastNl < from) {
      if (from > 0) {
        // The skipped (or cut first) line ended here; the next one is read from its start.
        this.setCursor(source, cursor, startOffset + from, startOffset + from, false);
      } else if (!atEof && chunk.length > 0) {
        // One line longer than the budget: skip it instead of re-reading it forever.
        this.setCursor(source, cursor, startOffset + chunk.length, startOffset, true);
      } else if (!cursor) {
        this.setCursor(source, undefined, startOffset, startOffset, false);
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

  /**
   * Apply a chunk read at `olderRange`: a full budget unless it reaches the file's start. It
   * ends at the floor, which is a line start, or with `floorMidLine` lies inside a line longer
   * than the budget (its part in this chunk is dropped).
   */
  applyOlder(input: ApplyInput): ApplyResult {
    const { transcriptId, source, startOffset, chunk } = input;
    const cursor = this.removed ? undefined : this.cursors.get(source);
    if (transcriptId !== this.transcriptId || !cursor || startOffset + chunk.length !== cursor.floor) {
      return { added: 0, candidates: [] };
    }
    const none = { added: 0, candidates: [] };
    let end = chunk.length;
    if (cursor.floorMidLine) {
      const lastNl = chunk.lastIndexOf(NL);
      if (lastNl === -1 && startOffset > 0) {
        // Still inside the long line.
        cursor.floor = startOffset;
        this.scheduleSave();
        return none;
      }
      // The long line starts at `end`: drop its part.
      end = lastNl + 1;
      delete cursor.floorMidLine;
    }
    let from = 0;
    if (startOffset > 0) {
      // The newline at `end - 1` closes a line that may have started before this chunk.
      const nl = chunk.subarray(0, end).indexOf(NL);
      if (nl === -1 || nl === end - 1) {
        if (end < chunk.length) {
          // It ends where the long line starts: the next block, ending there, holds it whole.
          cursor.floor = startOffset + end;
        } else {
          // No line starts in this chunk: it lies inside one line longer than the budget. Skip it.
          cursor.floor = startOffset;
          cursor.floorMidLine = true;
        }
        this.scheduleSave();
        return none;
      }
      from = nl + 1;
    }
    cursor.floor = startOffset + from;
    // Calls whose results lie in already-read newer lines cannot be paired here.
    const parsed = parseClaudeEditLines(chunk.subarray(from, end).toString('utf8'));
    const added = this.addRecords(parsed.records);
    this.scheduleSave();
    return { added, candidates: parsed.candidates };
  }

  /** Add Bash images whose mtime was confirmed inside their call's window. */
  addImageEntries(images: readonly ConfirmedImage[]): number {
    if (this.removed) return 0;
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

  /**
   * Write pending changes, if any, and wait for a write under way (the store is dropped from
   * memory and loaded again later). Unlike `flush()`, a store without changes writes nothing.
   */
  async settle(): Promise<void> {
    if (this.saveTimer) return this.flush();
    await this.writing;
  }

  /** Write now (cancels a pending debounced write). Writes run one after another. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const run = (this.writing ?? Promise.resolve()).then(() => this.write());
    this.writing = run.catch(() => undefined);
    await run;
  }

  /**
   * Delete the persisted file (session deleted) and forget the content. The store takes no
   * changes afterwards, so a read still in flight neither writes nor refills it.
   */
  async remove(): Promise<void> {
    this.removed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.entries.clear();
    this.bytes = 0;
    this.cursors.clear();
    this.pendingBash = [];
    this.agents.clear();
    // A write already under way ends first (or sees `removed`), so it cannot rename its
    // tmp file over the deleted store afterwards.
    await this.writing;
    await unlink(this.file).catch(() => undefined);
  }

  private async write(): Promise<void> {
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
    const tmp = `${this.file}.${TMP_TAG}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    if (this.removed) {
      await unlink(tmp).catch(() => undefined);
      return;
    }
    await rename(tmp, this.file);
  }

  private putAgent(agentId: string, meta: AgentMeta): void {
    this.agents.delete(agentId);
    this.agents.set(agentId, meta);
    if (this.agents.size <= MAX_AGENTS) return;
    const used = new Set<string>();
    for (const e of this.entries.values()) if (e.agentId) used.add(e.agentId);
    for (const id of this.agents.keys()) {
      if (this.agents.size <= MAX_AGENTS) break;
      // The newest label has no entries yet: they come with its transcript.
      if (id !== agentId && !used.has(id)) this.agents.delete(id);
    }
  }

  private setCursor(
    source: string,
    cursor: SourceCursor | undefined,
    offset: number,
    firstFloor: number,
    midLine: boolean,
    firstFloorMidLine = false
  ): void {
    const next: SourceCursor = { offset, floor: cursor ? cursor.floor : firstFloor };
    if (midLine) next.midLine = true;
    if (cursor ? cursor.floorMidLine : firstFloorMidLine) next.floorMidLine = true;
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
