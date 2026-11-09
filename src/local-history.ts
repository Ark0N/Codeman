/**
 * @fileoverview Offline reader for saved Codex conversations, behind
 * `codeman history read` (`cli-history.ts`). It reads rollout JSONL files from
 * disk directly: no HTTP route, no running server and no managed session.
 *
 * ## Selecting conversations
 *
 * Exactly one selector: `file` (one rollout, no store search), `sessionId` (a
 * native thread id or unique prefix of at least 8 characters) or
 * `rootSessionId` (a full id plus every transitive descendant). Identity always
 * comes from each file's `session_meta`, never from its filename.
 *
 * ## Budgets
 *
 * Three separate bounds, each raisable from the CLI up to a fixed maximum, and
 * each failing closed with an error rather than returning a partial answer:
 *
 *  - `metadataBytes`: the head reads that attribute every rollout in the store.
 *    A `session_meta` line embeds Codex's base instructions (about 20 KiB on
 *    every rollout measured), so this scales with the store, not the query,
 *    and is kept apart from the transcript budget: a lookup on a store of
 *    thousands of rollouts must not spend the budget meant for the transcripts
 *    it returns. Each file's head read is also capped at 128 KiB.
 *  - `scanBytes`: the selected transcripts, read whole.
 *  - `maxEntries`: directory entries visited.
 *
 * ## Forks and sub-agents
 *
 * A thread Codex forks or spawns as a sub-agent can carry a copy of its
 * parent's history in its own file (codex-rs `ForkPersistence::Copied`, written
 * by `record_initial_history` in `core/src/session/mod.rs`; the copy keeps the
 * parent's `session_meta`, see `keep_forked_rollout_item` in
 * `core/src/agent/control/spawn.rs`). Such a file starts with its own
 * `session_meta`, then the parent's, then the copied records, then one
 * `thread_settings_applied` event, then the child's own records. The copy
 * already lives in the parent's own file, so it is dropped here:
 *
 *  - Paginated history (`history_mode: "paginated"`) numbers every record with
 *    an `ordinal` and declares `subagent_history_start_ordinal`; records below
 *    it are inherited, exactly as Codex's own projection treats them
 *    (`thread-store/src/local/thread_history_materialization.rs`). A paginated
 *    thread with a `history_base` references its prefix in another file and has
 *    nothing inherited to drop.
 *  - Legacy history has no ordinals. The prefix runs from the inherited
 *    `session_meta` to the `thread_settings_applied` event Codex appends after
 *    the copy. A legacy copy keeps the parent's own `thread_settings_applied`
 *    events too, so when more than one candidate follows, the boundary is the
 *    last one whose preceding messages are still a prefix of the parent's own
 *    messages, read from the parent's file (once: a family read that selects
 *    the parent reuses that same read, so no file is charged to `scanBytes`
 *    twice). Without a readable parent file that cannot be proven: the cut then
 *    falls at the LAST candidate, so parent text is never attributed to the
 *    child, and the result says so (`unverifiedPrefixes`, `complete: false`).
 *    Any failure of the parent's read other than a budget leads here, rather
 *    than failing the child whose own file is intact.
 *
 * A later `session_meta` must be the file's own id or a declared ancestor
 * (`parent_thread_id`, `forked_from_id`, or the shared root `session_id`, and
 * transitively the ancestors those declare); any other id still refuses the
 * whole file rather than attribute one conversation's answer to another.
 *
 * ## Compressed rollouts
 *
 * Codex's `local_thread_store_compression` feature rewrites cold rollouts to
 * `*.jsonl.zst` in place. This reader does not decompress them: a store scan
 * counts each one in `compressedFiles` (so `complete` is false and a not-found
 * error names them), skipping one whose plain `.jsonl` sibling exists, as
 * Codex's own discovery does. A Zstandard file given to `file` is refused by
 * its magic number, whatever its name.
 *
 * ## Live rollouts
 *
 * A running Codex appends to its rollout. Reads take a snapshot: the file's
 * identity (device and inode) must match the attributed one and its size may
 * only have grown; everything up to the last complete line is read, and an
 * unterminated tail is reported as a partial record.
 *
 * ## Format
 *
 * The line shapes and the injected-context rule are shared with the Past
 * Sessions scanner through `codex-rollout-format.ts`.
 *
 * @module local-history
 */
import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { lstat, open, opendir, stat, type FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { codexMessageFromLine, codexSessionsRoot, isCodexInjectedContext } from './codex-rollout-format.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export const HISTORY_DEFAULT_SCAN_BYTES = 16 * MIB;
export const HISTORY_MAX_SCAN_BYTES = 256 * MIB;
export const HISTORY_DEFAULT_METADATA_BYTES = 1 * GIB;
export const HISTORY_MAX_METADATA_BYTES = 16 * GIB;
export const HISTORY_DEFAULT_MAX_ENTRIES = 65536;
export const HISTORY_MAX_ENTRIES = 1048576;
export const HISTORY_DEFAULT_OUTPUT_BYTES = 8192;
export const HISTORY_MAX_OUTPUT_BYTES = 1 * MIB;
/** Per-file head window for `session_meta`. The line itself runs to about 20 KiB. */
const METADATA_HEAD_BYTES = 128 * KIB;
/** Read the head in steps, so a typical rollout costs one step past its session_meta line. */
const METADATA_CHUNK_BYTES = 32 * KIB;
/**
 * Codex's compressed rollout suffix (codex-rs `rollout/src/compression.rs`:
 * `is_compressed_rollout_path` matches a name ending in `.jsonl.zst`).
 */
const COMPRESSED_ROLLOUT_SUFFIX = '.jsonl.zst';
/** The Zstandard frame magic number, little-endian on disk. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Codex writes `sessions/YYYY/MM/DD`; this leaves five levels of headroom. */
const MAX_DIRECTORY_DEPTH = 8;

const ID = /^[0-9a-f]{8}(?:[0-9a-f-]{0,28})$/i;
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Json = Record<string, unknown>;

export interface LocalHistoryOptions {
  file?: string;
  sessionId?: string;
  rootSessionId?: string;
  sessionsRoot?: string;
  topic?: string;
  /** Inclusive UTC date, `YYYY-MM-DD`. */
  after?: string;
  /** Inclusive UTC date, `YYYY-MM-DD`. */
  before?: string;
  scanBytes?: number;
  metadataBytes?: number;
  maxEntries?: number;
}
export interface HistoryRecord {
  rootSessionId: string | null;
  sessionId: string;
  timestamp: string;
  role: 'user' | 'assistant';
  /** Codex's own phase for assistant messages (`commentary`, `final_answer`); null when none was recorded. */
  phase: string | null;
  message: string;
}
interface Source {
  path: string;
  sessionId: string;
  parentId?: string;
  forkedFromId?: string;
  rootId?: string;
  /** `subagent_history_start_ordinal`: records below it are inherited. */
  historyStart?: number;
  timestamp: string;
  /** `dev:ino` of the attributed file. */
  identity: string;
  /** Size when attributed; a later read may only see it grow. */
  size: number;
}
export interface LocalHistoryResult {
  source: 'codex-jsonl';
  complete: boolean;
  sessions: Array<{ sessionId: string; rootSessionId: string | null; parentSessionId?: string; path: string }>;
  records: HistoryRecord[];
  scan: {
    /** Transcript bytes read (`--scan-bytes`). */
    bytesRead: number;
    /** Head bytes read to attribute rollouts (`--metadata-bytes`). */
    metadataBytesRead: number;
    entries: number;
    malformedRecords: number;
    partialRecords: number;
    skippedSymlinks: number;
    unattributedFiles: number;
    /**
     * Zstandard-compressed rollouts (`*.jsonl.zst`, Codex's `local_thread_store_compression`)
     * this reader cannot open. Their threads are missing from the result.
     */
    compressedFiles: number;
    unreadableDirectories: number;
    /** Inherited fork or sub-agent prefixes dropped (informational). */
    inheritedPrefixes: number;
    /** Inherited prefixes that never reached their end marker. */
    incompletePrefixes: number;
    /** Legacy prefixes whose end could not be checked against the parent's own file. */
    unverifiedPrefixes: number;
  };
}
interface Budget {
  transcriptRemaining: number;
  metadataRemaining: number;
  entriesRemaining: number;
  scan: LocalHistoryResult['scan'];
  /** Paths behind `scan.compressedFiles`, for the not-found error. */
  compressedPaths: string[];
}

/** A budget ran out: always fatal, never counted. */
class HistoryBudgetError extends Error {}
/** One store file could not be attributed: fatal for `--file`, counted for a store scan. */
class UnattributableFileError extends Error {}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function fullId(value: unknown): string | undefined {
  const id = string(value);
  return id && FULL_ID.test(id) ? id.toLowerCase() : undefined;
}
function fileIdentity(value: { dev: number; ino: number }): string {
  return `${value.dev}:${value.ino}`;
}
function validDate(value: string | undefined): boolean {
  return (
    value === undefined ||
    (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value)
  );
}
/** The UTC calendar date of a native timestamp, or undefined when it does not parse. */
function utcDate(timestamp: string): string | undefined {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}
function checkBudget(value: number, max: number, flag: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${flag} (1-${max})`);
}
function validate(options: LocalHistoryOptions): void {
  if ([options.file, options.sessionId, options.rootSessionId].filter((v) => v !== undefined).length !== 1)
    throw new Error('Select exactly one of --file, --session-id, or --root-session-id');
  if (options.file !== undefined && !options.file) throw new Error('A nonempty file is required');
  if (options.sessionId !== undefined && !ID.test(options.sessionId)) throw new Error('Invalid native session id');
  if (options.rootSessionId !== undefined && !FULL_ID.test(options.rootSessionId))
    throw new Error('Invalid root session id');
  if (
    !validDate(options.after) ||
    !validDate(options.before) ||
    (options.after && options.before && options.after > options.before)
  )
    throw new Error('Invalid date or date range (use YYYY-MM-DD, UTC)');
  if (options.topic !== undefined && !options.topic.trim()) throw new Error('Invalid empty topic');
  checkBudget(options.scanBytes ?? HISTORY_DEFAULT_SCAN_BYTES, HISTORY_MAX_SCAN_BYTES, '--scan-bytes');
  checkBudget(options.metadataBytes ?? HISTORY_DEFAULT_METADATA_BYTES, HISTORY_MAX_METADATA_BYTES, '--metadata-bytes');
  checkBudget(options.maxEntries ?? HISTORY_DEFAULT_MAX_ENTRIES, HISTORY_MAX_ENTRIES, '--max-entries');
}
async function regularFile(path: string): Promise<FileHandle> {
  // O_NOFOLLOW prevents a final-component link swap between lstat and open. fstat
  // validates the opened descriptor, not a previously inspected pathname.
  if (!(await lstat(path)).isFile()) throw new Error('History source must be a regular file, not a symlink');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new Error('History source must be a regular file');
  }
  return handle;
}
async function readAt(handle: FileHandle, position: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let filled = 0;
  while (filled < size) {
    const { bytesRead } = await handle.read(buffer, filled, size - filled, position + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}
async function readMetadataChunk(handle: FileHandle, position: number, size: number, budget: Budget) {
  if (size > budget.metadataRemaining)
    throw new HistoryBudgetError('History metadata byte budget exhausted; raise --metadata-bytes');
  const chunk = await readAt(handle, position, size);
  budget.metadataRemaining -= chunk.length;
  budget.scan.metadataBytesRead += chunk.length;
  return chunk;
}
async function readTranscript(handle: FileHandle, size: number, budget: Budget): Promise<Buffer> {
  if (size > budget.transcriptRemaining)
    throw new HistoryBudgetError('History scan byte budget exhausted; narrow the selection or raise --scan-bytes');
  const buffer = await readAt(handle, 0, size);
  budget.transcriptRemaining -= buffer.length;
  budget.scan.bytesRead += buffer.length;
  return buffer;
}

type Identity = Omit<Source, 'identity' | 'size'>;
function metadata(value: unknown, path: string): Identity | undefined {
  const entry = object(value);
  if (entry.type !== 'session_meta') return undefined;
  const p = object(entry.payload);
  const sessionId = fullId(p.id) ?? fullId(p.session_id);
  if (!sessionId) return undefined;
  const spawn = object(object(object(p.source).subagent).thread_spawn);
  const forkedFromId = fullId(p.forked_from_id);
  // A fork with no spawn parent (a `/fork` in the TUI) still descends from its source thread.
  const parentId =
    fullId(p.parent_thread_id) ?? fullId(p.parent_session_id) ?? fullId(spawn.parent_thread_id) ?? forkedFromId;
  // Codex: "session_id is equal to the root thread's ID".
  const declaredRoot = fullId(p.root_session_id) ?? fullId(p.session_id);
  const start = p.subagent_history_start_ordinal;
  return {
    path,
    sessionId,
    parentId,
    forkedFromId,
    rootId: declaredRoot && declaredRoot !== sessionId ? declaredRoot : undefined,
    historyStart: Number.isSafeInteger(start) && (start as number) >= 0 ? (start as number) : undefined,
    timestamp: string(p.timestamp) ?? string(entry.timestamp) ?? '',
  };
}
function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.parentId === b.parentId &&
    a.forkedFromId === b.forkedFromId &&
    a.rootId === b.rootId &&
    a.historyStart === b.historyStart
  );
}

/**
 * The first `session_meta` within the file's head. Problems with the file
 * itself throw {@link UnattributableFileError}; a budget throws
 * {@link HistoryBudgetError}; a short file with no metadata yet returns undefined.
 */
async function readMetadata(path: string, budget: Budget): Promise<Source | undefined> {
  let handle: FileHandle;
  try {
    handle = await regularFile(path);
  } catch (error) {
    throw new UnattributableFileError(error instanceof Error ? error.message : String(error));
  }
  try {
    const before = await handle.stat();
    const limit = Math.min(before.size, METADATA_HEAD_BYTES);
    let buffer = Buffer.alloc(0);
    let parsed = 0;
    while (buffer.length < limit) {
      const chunk = await readMetadataChunk(
        handle,
        buffer.length,
        Math.min(METADATA_CHUNK_BYTES, limit - buffer.length),
        budget
      );
      if (!chunk.length) break;
      if (!buffer.length && chunk.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC))
        throw new UnattributableFileError(
          'History source is Zstandard-compressed (a Codex .jsonl.zst rollout); only plain .jsonl is read'
        );
      buffer = Buffer.concat([buffer, chunk]);
      let end = buffer.indexOf(10, parsed);
      while (end >= 0) {
        const line = buffer.subarray(parsed, end);
        parsed = end + 1;
        end = buffer.indexOf(10, parsed);
        if (!isUtf8(line)) throw new UnattributableFileError('History metadata contains invalid UTF8');
        let value: unknown;
        try {
          value = JSON.parse(line.toString('utf8'));
        } catch {
          continue;
        }
        const found = metadata(value, path);
        if (!found) continue;
        // session_meta is written once; a growing file is a live rollout, not a change.
        const after = await handle.stat();
        if (fileIdentity(after) !== fileIdentity(before) || after.size < before.size)
          throw new UnattributableFileError('History source changed during metadata scan');
        return { ...found, identity: fileIdentity(before), size: before.size };
      }
    }
    if (buffer.length < limit) throw new UnattributableFileError('History source changed during metadata scan');
    if (before.size > METADATA_HEAD_BYTES)
      throw new UnattributableFileError('No session metadata within the first 128 KiB');
    return undefined;
  } finally {
    await handle.close();
  }
}

async function findSources(root: string, budget: Budget): Promise<Source[]> {
  // The root may itself be a symlink, as the Past Sessions scanner allows
  // (`codex-transcript.ts` reads it with readdir, which follows it); links
  // BELOW the root are never followed by either reader.
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    throw new Error(`Sessions root not found: ${root}`);
  }
  if (!rootStat.isDirectory()) throw new Error('Sessions root must be a directory');
  const sources: Source[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH) throw new HistoryBudgetError('History directory scan depth budget exhausted');
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      budget.scan.unreadableDirectories++;
      return;
    }
    for await (const entry of entries) {
      if (--budget.entriesRemaining < 0)
        throw new HistoryBudgetError('History directory scan entry budget exhausted; raise --max-entries');
      budget.scan.entries++;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        budget.scan.skippedSymlinks++;
        continue;
      }
      if (entry.isDirectory()) {
        // Recheck immediately before descending; never intentionally follow links.
        const now = await lstat(path).catch(() => undefined);
        if (!now?.isDirectory()) {
          budget.scan.unreadableDirectories++;
          continue;
        }
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let source: Source | undefined;
        try {
          source = await readMetadata(path, budget);
        } catch (error) {
          if (!(error instanceof UnattributableFileError)) throw error;
        }
        if (source) sources.push(source);
        else budget.scan.unattributedFiles++;
      } else if (entry.isFile() && entry.name.endsWith(COMPRESSED_ROLLOUT_SUFFIX)) {
        // Codex reads the plain sibling instead when both exist (`should_skip_compressed_sibling`),
        // and that sibling is visited (or counted) on its own.
        const plain = await lstat(path.slice(0, -'.zst'.length)).catch(() => undefined);
        if (plain) continue;
        budget.scan.compressedFiles++;
        budget.compressedPaths.push(path);
      }
    }
  };
  await visit(root, 0);
  return sources;
}

interface Message {
  representation: 'event' | 'modern' | 'response';
  role: 'user' | 'assistant';
  message: string;
  phase: string | null;
  timestamp: string;
}
function message(value: unknown): Message | undefined {
  const entry = object(value);
  const p = object(entry.payload);
  if (entry.isSidechain || p.isSidechain) return undefined;
  const found = codexMessageFromLine(value);
  if (!found) return undefined;
  // Codex context is not a human turn. Real prompts also arrive as events, which are never filtered.
  if (found.injectionProne && isCodexInjectedContext(found.text)) return undefined;
  return {
    role: found.role,
    message: found.text,
    // Codex records a phase on assistant messages only; a user turn has none.
    phase: found.role === 'assistant' ? (found.phase ?? null) : null,
    representation: found.shape === 'item' ? 'modern' : found.shape,
    timestamp: string(entry.timestamp) ?? string(p.timestamp) ?? '',
  };
}
/** Native events and response_item commonly duplicate one accepted message. */
function collapse(items: Message[]): Message[] {
  const records: Message[] = [];
  let representations = new Set<Message['representation']>();
  for (const raw of items) {
    const item = { ...raw };
    const previous = records.at(-1);
    if (
      previous?.role === item.role &&
      previous.message === item.message &&
      !representations.has(item.representation)
    ) {
      representations.add(item.representation);
      if (!previous.timestamp) previous.timestamp = item.timestamp;
      if (item.phase === 'final_answer' || previous.phase === null) previous.phase = item.phase ?? previous.phase;
      continue;
    }
    records.push(item);
    representations = new Set([item.representation]);
  }
  return records;
}
function isPrefixOf(prefix: Message[], whole: Message[]): boolean {
  return (
    prefix.length <= whole.length &&
    prefix.every((item, i) => item.role === whole[i].role && item.message === whole[i].message)
  );
}

interface ReadContext {
  /**
   * The ancestor's own messages, uncut, or undefined when its file is not in the
   * store or could not be read for any reason other than a budget.
   */
  ancestorMessages(id: string): Promise<Message[] | undefined>;
}
type Piece = Message | { boundary: true };
interface LegacyPrefix {
  ancestorId: string;
  /** Messages and `thread_settings_applied` boundaries after the inherited session_meta. */
  pieces: Piece[];
}
/** One read of one rollout: every view later needed of it, so no file is read (or charged) twice. */
interface ParsedSource {
  /** Every message in file order, inherited copies included: what a child's copy of this thread holds. */
  raw: Message[];
  /** Messages before any legacy inherited prefix, paginated inherited records already dropped. */
  own: Message[];
  legacy?: LegacyPrefix;
}

async function parseSource(source: Source, budget: Budget): Promise<ParsedSource> {
  const handle = await regularFile(source.path);
  let buffer: Buffer;
  try {
    const now = await handle.stat();
    // A live rollout only grows. A different file or a shorter one is a rewrite.
    if (fileIdentity(now) !== source.identity || now.size < source.size)
      throw new Error('History source changed after attribution; retry explicitly');
    buffer = await readTranscript(handle, now.size, budget);
    if (buffer.length !== now.size) throw new Error('History source shrank while reading; retry explicitly');
  } finally {
    await handle.close();
  }
  // Snapshot up to the last complete line: a running Codex may be mid-append.
  const end = buffer.lastIndexOf(10) + 1;
  const complete = buffer.subarray(0, end);
  if (buffer.subarray(end).toString('latin1').trim()) budget.scan.partialRecords++;
  if (!isUtf8(complete)) throw new Error('History source contains invalid UTF8');

  const ancestors = new Set([source.parentId, source.forkedFromId, source.rootId].filter((id): id is string => !!id));
  const raw: Message[] = [];
  const own: Message[] = [];
  let legacy: LegacyPrefix | undefined;
  let lastOrdinal = -1;
  for (const line of complete.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      budget.scan.malformedRecords++;
      continue;
    }
    const entry = object(parsed);
    const ordinal = typeof entry.ordinal === 'number' ? entry.ordinal : undefined;
    if (ordinal !== undefined) lastOrdinal = Math.max(lastOrdinal, ordinal);
    if (source.historyStart !== undefined && ordinal === undefined) {
      // Codex's projection skips a paginated record without an ordinal; so does this, visibly.
      budget.scan.malformedRecords++;
      continue;
    }
    const inherited = source.historyStart !== undefined && ordinal! < source.historyStart;
    if (entry.type === 'session_meta') {
      const declared = metadata(parsed, source.path);
      if (declared && declared.sessionId === source.sessionId && sameIdentity(declared, source)) continue;
      if (!declared || declared.sessionId === source.sessionId || !ancestors.has(declared.sessionId))
        throw new Error('History source contains conflicting native metadata; attribution refused');
      // An ancestor that was itself a fork carries its own ancestors' metadata in the copy.
      for (const id of [declared.parentId, declared.forkedFromId, declared.rootId]) if (id) ancestors.add(id);
      if (inherited || legacy) continue;
      budget.scan.inheritedPrefixes++;
      legacy = { ancestorId: declared.sessionId, pieces: [] };
      continue;
    }
    if (legacy && entry.type === 'event_msg' && object(entry.payload).type === 'thread_settings_applied') {
      if (!inherited) legacy.pieces.push({ boundary: true });
      continue;
    }
    const item = message(parsed);
    if (!item) continue;
    raw.push(item);
    if (inherited) continue;
    if (legacy) legacy.pieces.push(item);
    else own.push(item);
  }
  if (source.historyStart !== undefined && source.historyStart > 0) {
    budget.scan.inheritedPrefixes++;
    // Initialization died while copying the prefix: Codex refuses to resume such a file.
    if (lastOrdinal < source.historyStart - 1) budget.scan.incompletePrefixes++;
  }
  return { raw: collapse(raw), own, legacy };
}

/** The thread's own messages: its inherited prefix dropped, proven against the parent where one is needed. */
async function readMessages(parsed: ParsedSource, budget: Budget, context: ReadContext): Promise<Message[]> {
  const own = [...parsed.own];
  if (parsed.legacy) own.push(...(await afterLegacyPrefix(parsed.legacy, budget, context)));
  return collapse(own);
}

/** The child's own messages after a legacy inherited prefix. */
async function afterLegacyPrefix(prefix: LegacyPrefix, budget: Budget, context: ReadContext): Promise<Message[]> {
  const boundaries = prefix.pieces.flatMap((piece, i) => ('boundary' in piece ? [i] : []));
  if (!boundaries.length) {
    budget.scan.incompletePrefixes++;
    return [];
  }
  const messagesBefore = (index: number) =>
    collapse(prefix.pieces.slice(0, index).filter((piece): piece is Message => !('boundary' in piece)));
  let cut = boundaries[0];
  if (boundaries.length > 1) {
    // The last candidate whose preceding messages the parent's own file also holds.
    const parent = await context.ancestorMessages(prefix.ancestorId);
    const proven = parent ? boundaries.filter((candidate) => isPrefixOf(messagesBefore(candidate), parent)) : [];
    if (proven.length) cut = proven.at(-1)!;
    else {
      // Unprovable: drop up to the last candidate, so parent text is never attributed to the child.
      budget.scan.unverifiedPrefixes++;
      cut = boundaries.at(-1)!;
    }
  }
  return prefix.pieces.slice(cut + 1).filter((piece): piece is Message => !('boundary' in piece));
}

function selectedTurns(messages: Message[], options: LocalHistoryOptions): Message[] {
  const turns: Message[][] = [];
  for (const item of messages) {
    if (item.role === 'user' || !turns.length) turns.push([]);
    turns.at(-1)!.push(item);
  }
  const needle = options.topic?.trim().toLocaleLowerCase();
  return turns
    .filter((turn) => {
      const dateMatches =
        (!options.after && !options.before) ||
        turn.some((item) => {
          const date = utcDate(item.timestamp);
          return (
            date !== undefined &&
            (!options.after || date >= options.after) &&
            (!options.before || date <= options.before)
          );
        });
      return dateMatches && (!needle || turn.some((item) => item.message.toLocaleLowerCase().includes(needle)));
    })
    .flat();
}

/** Native ancestry is metadata evidence, not the conversation selected by a query. */
function nativeRoot(source: Source, sources: Source[]): string | null {
  const seen = new Set<string>();
  let current = source;
  while (true) {
    if (seen.has(current.sessionId)) throw new Error('Native history contains cyclic ancestry');
    seen.add(current.sessionId);
    if (current.rootId) return current.rootId;
    if (!current.parentId) return current.sessionId;
    const parents = sources.filter((candidate) => candidate.sessionId === current.parentId);
    if (parents.length === 0) return null;
    if (parents.length > 1) throw new Error('Native ancestor id is ambiguous');
    current = parents[0];
  }
}

/**
 * The not-found error, naming what the store held but could not attribute.
 * Codex names a rollout `rollout-<timestamp>-<thread id>.jsonl[.zst]`, so a
 * compressed file whose name carries the wanted id is named outright; the name
 * is only a hint here, never identity.
 */
function missingSessionMessage(wanted: string, budget: Budget): string {
  const { scan } = budget;
  const notes: string[] = [];
  if (scan.compressedFiles) {
    // `rollout-` (8) + `YYYY-MM-DDTHH-MM-SS` (19) + `-` (1), then the thread id.
    const named = budget.compressedPaths.filter((path) => {
      const name = basename(path).toLowerCase();
      return name.startsWith('rollout-') && name.slice(28).startsWith(wanted);
    });
    const shown = named.slice(0, 3).join(', ') + (named.length > 3 ? ` and ${named.length - 3} more` : '');
    notes.push(
      named.length
        ? `it may be in compressed rollout ${shown}, which this reader cannot open; read a decompressed copy with --file (zstd -dc <path> > copy.jsonl)`
        : `${scan.compressedFiles} compressed .jsonl.zst rollout(s) could not be read`
    );
  }
  if (scan.unattributedFiles) notes.push(`${scan.unattributedFiles} file(s) could not be attributed`);
  return `Native session missing from history store${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

export async function readLocalHistory(options: LocalHistoryOptions): Promise<LocalHistoryResult> {
  validate(options);
  const scan: LocalHistoryResult['scan'] = {
    bytesRead: 0,
    metadataBytesRead: 0,
    entries: 0,
    malformedRecords: 0,
    partialRecords: 0,
    skippedSymlinks: 0,
    unattributedFiles: 0,
    compressedFiles: 0,
    unreadableDirectories: 0,
    inheritedPrefixes: 0,
    incompletePrefixes: 0,
    unverifiedPrefixes: 0,
  };
  const budget: Budget = {
    transcriptRemaining: options.scanBytes ?? HISTORY_DEFAULT_SCAN_BYTES,
    metadataRemaining: options.metadataBytes ?? HISTORY_DEFAULT_METADATA_BYTES,
    entriesRemaining: options.maxEntries ?? HISTORY_DEFAULT_MAX_ENTRIES,
    scan,
    compressedPaths: [],
  };
  let sources: Source[];
  let attributionSources: Source[];
  if (options.file !== undefined) {
    let source: Source | undefined;
    try {
      source = await readMetadata(resolve(options.file), budget);
    } catch (error) {
      throw error instanceof UnattributableFileError ? new Error(error.message) : error;
    }
    if (!source) throw new Error('History source is missing valid native session metadata');
    sources = [source];
    attributionSources = sources;
  } else {
    const root = options.sessionsRoot ?? codexSessionsRoot();
    const all = await findSources(resolve(root), budget);
    const wanted = (options.sessionId ?? options.rootSessionId)!.toLowerCase();
    const matches = all.filter((source) => source.sessionId.startsWith(wanted));
    if (!matches.length) throw new Error(missingSessionMessage(wanted, budget));
    if (matches.length !== 1) throw new Error('Native session id is ambiguous');
    const target = matches[0];
    attributionSources = all;
    const queryRootId = target.sessionId;
    sources = [target];
    if (options.rootSessionId) {
      const selected = new Set([target.sessionId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const source of all) {
          if (
            !selected.has(source.sessionId) &&
            (source.rootId === queryRootId || (source.parentId && selected.has(source.parentId)))
          ) {
            selected.add(source.sessionId);
            sources.push(source);
            changed = true;
          }
        }
      }
      for (const source of sources) {
        if (all.filter((other) => other.sessionId === source.sessionId).length !== 1)
          throw new Error('Native family contains ambiguous duplicated session ids');
      }
    }
  }
  sources.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sessionId.localeCompare(b.sessionId));
  const roots = new Map(sources.map((source) => [source.sessionId, nativeRoot(source, attributionSources)]));
  // Each selected file is read once, whether the main loop or a child's boundary proof asks first.
  const parsedCache = new Map<Source, Promise<ParsedSource>>();
  const parse = (source: Source) => {
    let parsed = parsedCache.get(source);
    if (!parsed) {
      parsed = parseSource(source, budget);
      parsedCache.set(source, parsed);
    }
    return parsed;
  };
  const context: ReadContext = {
    // Raw messages need no boundary proof of their own, so this never recurses.
    async ancestorMessages(id) {
      const candidates = attributionSources.filter((source) => source.sessionId === id);
      if (candidates.length !== 1) return undefined;
      try {
        return (await parse(candidates[0])).raw;
      } catch (error) {
        // A budget always fails the read; any other failure only leaves the boundary unproven.
        if (error instanceof HistoryBudgetError) throw error;
        return undefined;
      }
    },
  };
  const records: HistoryRecord[] = [];
  for (const source of sources) {
    records.push(
      ...selectedTurns(await readMessages(await parse(source), budget, context), options).map((item) => ({
        rootSessionId: roots.get(source.sessionId) ?? null,
        sessionId: source.sessionId,
        role: item.role,
        message: item.message,
        phase: item.phase,
        timestamp: item.timestamp,
      }))
    );
  }
  if (!records.length) throw new Error('No matching user/assistant evidence found');
  return {
    source: 'codex-jsonl',
    complete:
      scan.malformedRecords === 0 &&
      scan.partialRecords === 0 &&
      scan.skippedSymlinks === 0 &&
      scan.unattributedFiles === 0 &&
      scan.compressedFiles === 0 &&
      scan.unreadableDirectories === 0 &&
      scan.incompletePrefixes === 0 &&
      scan.unverifiedPrefixes === 0 &&
      [...roots.values()].every((root) => root !== null),
    sessions: sources.map((source) => ({
      sessionId: source.sessionId,
      rootSessionId: roots.get(source.sessionId) ?? null,
      ...(source.parentId ? { parentSessionId: source.parentId } : {}),
      path: source.path,
    })),
    records,
    scan,
  };
}
/** The `--max-bytes` check, exported so the CLI can make it before any file is read. */
export function validateOutputBytes(maxBytes: number): void {
  checkBudget(maxBytes, HISTORY_MAX_OUTPUT_BYTES, '--max-bytes');
}
/** Output never splits a JSON document, UTF8 character, record, or selected turn. */
export function formatLocalHistory(
  result: LocalHistoryResult,
  format: 'json' | 'text' = 'json',
  maxBytes = HISTORY_DEFAULT_OUTPUT_BYTES
): string {
  validateOutputBytes(maxBytes);
  const body =
    format === 'json'
      ? JSON.stringify(result)
      : [
          `source=${result.source} complete=${result.complete} scannedBytes=${result.scan.bytesRead} metadataBytes=${result.scan.metadataBytesRead}`,
          ...result.records.map(
            (row) =>
              `[root=${row.rootSessionId} session=${row.sessionId} ${row.timestamp} ${row.role}${row.phase ? ` ${row.phase}` : ''}]\n${row.message}`
          ),
        ].join('\n\n');
  if (Buffer.byteLength(body) + 1 > maxBytes)
    throw new Error('History output byte budget exceeded; narrow filters or raise --max-bytes');
  return body;
}
