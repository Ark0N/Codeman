/** Offline, local-operator Codex history. No HTTP routes or running session required. */
import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const HISTORY_DEFAULT_SCAN_BYTES = 16 * 1024 * 1024;
export const HISTORY_MAX_SCAN_BYTES = 64 * 1024 * 1024;
export const HISTORY_MAX_OUTPUT_BYTES = 1024 * 1024;
const ID = /^[0-9a-f]{8}(?:[0-9a-f-]{0,28})$/i;
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METADATA_BYTES = 128 * 1024;
type Json = Record<string, unknown>;
export interface LocalHistoryOptions {
  file?: string;
  sessionId?: string;
  rootSessionId?: string;
  sessionsRoot?: string;
  topic?: string;
  after?: string;
  before?: string;
  scanBytes?: number;
  maxEntries?: number;
}
export interface HistoryRecord {
  rootSessionId: string | null;
  sessionId: string;
  timestamp: string;
  role: 'user' | 'assistant';
  phase: string;
  message: string;
}
interface Source {
  path: string;
  sessionId: string;
  parentId?: string;
  rootId?: string;
  timestamp: string;
  fingerprint?: string;
}
export interface LocalHistoryResult {
  source: 'codex-jsonl';
  complete: boolean;
  sessions: Array<{ sessionId: string; rootSessionId: string | null; parentSessionId?: string; path: string }>;
  records: HistoryRecord[];
  scan: {
    bytesRead: number;
    entries: number;
    malformedRecords: number;
    partialRecords: number;
    skippedSymlinks: number;
    unattributedFiles: number;
  };
}
interface Budget {
  remaining: number;
  entriesRemaining: number;
  scan: LocalHistoryResult['scan'];
}
function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function validDate(value: string | undefined): boolean {
  return (
    value === undefined ||
    (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value)
  );
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
    throw new Error('Invalid date or date range (use YYYY-MM-DD)');
  if (options.topic !== undefined && !options.topic.trim()) throw new Error('Invalid empty topic');
  for (const [value, max] of [
    [options.scanBytes ?? HISTORY_DEFAULT_SCAN_BYTES, HISTORY_MAX_SCAN_BYTES],
    [options.maxEntries ?? 8192, 65536],
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid scan budget');
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
async function readChunk(handle: FileHandle, position: number, size: number, budget: Budget): Promise<Buffer> {
  if (size > budget.remaining)
    throw new Error('History scan byte budget exhausted; narrow the store or raise --scan-bytes');
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await handle.read(buffer, 0, size, position);
  budget.remaining -= bytesRead;
  budget.scan.bytesRead += bytesRead;
  return buffer.subarray(0, bytesRead);
}
function metadata(value: unknown, path: string): Source | undefined {
  const entry = object(value);
  if (entry.type !== 'session_meta') return undefined;
  const p = object(entry.payload);
  const sessionId = string(p.id) ?? string(p.session_id);
  if (!sessionId || !FULL_ID.test(sessionId)) return undefined;
  const source = object(p.source);
  const spawn = object(object(source.subagent).thread_spawn);
  const parentId = string(p.parent_thread_id) ?? string(p.parent_session_id) ?? string(spawn.parent_thread_id);
  const declaredRoot = string(p.root_session_id) ?? string(p.session_id);
  return {
    path,
    sessionId: sessionId.toLowerCase(),
    parentId: parentId && FULL_ID.test(parentId) ? parentId.toLowerCase() : undefined,
    rootId:
      declaredRoot && declaredRoot !== sessionId && FULL_ID.test(declaredRoot) ? declaredRoot.toLowerCase() : undefined,
    timestamp: string(p.timestamp) ?? string(entry.timestamp) ?? '',
  };
}
async function readMetadata(path: string, budget: Budget): Promise<Source | undefined> {
  const handle = await regularFile(path);
  try {
    const before = await handle.stat();
    const parts: Buffer[] = [];
    let offset = 0;
    let parsed = 0;
    while (offset < before.size && offset < METADATA_BYTES) {
      const chunk = await readChunk(
        handle,
        offset,
        Math.min(4096, before.size - offset, METADATA_BYTES - offset),
        budget
      );
      if (!chunk.length) break;
      parts.push(chunk);
      offset += chunk.length;
      const buffer = Buffer.concat(parts);
      let end = buffer.indexOf(10, parsed);
      while (end >= 0) {
        const line = buffer.subarray(parsed, end);
        if (!isUtf8(line)) throw new Error('History metadata contains invalid UTF8');
        try {
          const found = metadata(JSON.parse(line.toString('utf8')), path);
          if (found) {
            const after = await handle.stat();
            const fingerprint = (value: typeof before) =>
              `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
            if (fingerprint(before) !== fingerprint(after))
              throw new Error('History source changed during metadata scan');
            return { ...found, fingerprint: fingerprint(before) };
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        parsed = end + 1;
        end = buffer.indexOf(10, parsed);
      }
    }
    if (offset < before.size)
      throw new Error('History metadata scan budget exhausted; cannot prove family completeness');
    return undefined;
  } finally {
    await handle.close();
  }
}
async function findSources(root: string, budget: Budget): Promise<Source[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error('Sessions root must be a real directory, not a symlink');
  const sources: Source[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error('History directory scan depth budget exhausted');
    const entries = await opendir(dir);
    for await (const entry of entries) {
      if (--budget.entriesRemaining < 0) throw new Error('History directory scan entry budget exhausted');
      budget.scan.entries++;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        budget.scan.skippedSymlinks++;
        continue;
      }
      if (entry.isDirectory()) {
        // Recheck immediately before descending; never intentionally follow links.
        if (!(await lstat(path)).isDirectory()) throw new Error('History directory changed during scan');
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const source = await readMetadata(path, budget);
        if (source) sources.push(source);
        else budget.scan.unattributedFiles++;
      }
    }
  };
  await visit(root, 0);
  return sources;
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const item = object(block);
      return typeof item.type === 'string' && ['text', 'input_text', 'output_text'].includes(item.type.toLowerCase())
        ? (string(item.text) ?? '')
        : '';
    })
    .filter(Boolean)
    .join('\n');
}
interface Message {
  representation: 'event' | 'modern' | 'response';
  role: 'user' | 'assistant';
  message: string;
  phase: string;
  timestamp: string;
}
function message(value: unknown): Message | undefined {
  const entry = object(value);
  const p = object(entry.payload);
  if (entry.isSidechain || p.isSidechain) return undefined;
  let role: Message['role'] | undefined;
  let representation: Message['representation'] = 'event';
  let text = '';
  let phase = string(p.phase) ?? 'progress';
  if (entry.type === 'event_msg') {
    if (p.type === 'user_message' || p.type === 'agent_message') {
      role = p.type === 'user_message' ? 'user' : 'assistant';
      text = contentText(p.message);
    } else if (p.type === 'item_completed') {
      representation = 'modern';
      const item = object(p.item);
      if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
        role = item.type === 'UserMessage' ? 'user' : 'assistant';
        text = contentText(item.content);
        phase = string(item.phase) ?? phase;
      }
    }
  } else if (
    entry.type === 'response_item' &&
    (p.type === 'message' || p.type === undefined) &&
    (p.role === 'user' || p.role === 'assistant')
  ) {
    role = p.role;
    representation = 'response';
    text = contentText(p.content);
    // Codex context is not a human turn. Do not omit arbitrary markdown prompts.
    if (
      role === 'user' &&
      /^(?:# AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>|<turn_aborted>)/.test(text)
    )
      return undefined;
  }
  if (!role || !text) return undefined;
  return {
    role,
    message: text,
    phase,
    representation,
    timestamp: string(entry.timestamp) ?? string(p.timestamp) ?? '',
  };
}
async function readMessages(source: Source, budget: Budget): Promise<Message[]> {
  const handle = await regularFile(source.path);
  try {
    const before = await handle.stat();
    if (`${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}` !== source.fingerprint)
      throw new Error('History source changed after attribution; retry explicitly');
    const buffer = await readChunk(handle, 0, before.size, budget);
    const after = await handle.stat();
    if (
      buffer.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('History source changed while reading; retry explicitly');
    if (!isUtf8(buffer)) throw new Error('History source contains invalid UTF8');
    const lines = buffer.toString('utf8').split('\n');
    const partial = lines.pop();
    if (partial) budget.scan.partialRecords++;
    const records: Message[] = [];
    let representations = new Set<Message['representation']>();
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        budget.scan.malformedRecords++;
        continue;
      }
      if (object(parsed).type === 'session_meta') {
        const declared = metadata(parsed, source.path);
        if (
          !declared ||
          declared.sessionId !== source.sessionId ||
          declared.parentId !== source.parentId ||
          declared.rootId !== source.rootId
        )
          throw new Error('History source contains conflicting native metadata; attribution refused');
        continue;
      }
      const item = message(parsed);
      if (!item) continue;
      const previous = records.at(-1);
      // Native events and response_item commonly duplicate one accepted message.
      if (
        previous?.role === item.role &&
        previous.message === item.message &&
        !representations.has(item.representation)
      ) {
        representations.add(item.representation);
        if (!previous.timestamp) previous.timestamp = item.timestamp;
        if (item.phase === 'final_answer') previous.phase = item.phase;
        continue;
      }
      records.push(item);
      representations = new Set([item.representation]);
    }
    return records;
  } finally {
    await handle.close();
  }
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
          const date = item.timestamp.slice(0, 10);
          return (
            validDate(date) && (!options.after || date >= options.after) && (!options.before || date <= options.before)
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

export async function readLocalHistory(options: LocalHistoryOptions): Promise<LocalHistoryResult> {
  validate(options);
  const scan: LocalHistoryResult['scan'] = {
    bytesRead: 0,
    entries: 0,
    malformedRecords: 0,
    partialRecords: 0,
    skippedSymlinks: 0,
    unattributedFiles: 0,
  };
  const budget: Budget = {
    remaining: options.scanBytes ?? HISTORY_DEFAULT_SCAN_BYTES,
    entriesRemaining: options.maxEntries ?? 8192,
    scan,
  };
  let sources: Source[];
  let attributionSources: Source[];
  if (options.file !== undefined) {
    const source = await readMetadata(resolve(options.file), budget);
    if (!source) throw new Error('History source is missing valid native session metadata');
    sources = [source];
    attributionSources = sources;
  } else {
    const root = options.sessionsRoot ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
    const all = await findSources(resolve(root), budget);
    const wanted = (options.sessionId ?? options.rootSessionId)!.toLowerCase();
    const matches = all.filter((source) => source.sessionId.toLowerCase().startsWith(wanted));
    if (!matches.length) throw new Error('Native session missing from history store');
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
  const records: HistoryRecord[] = [];
  for (const source of sources) {
    records.push(
      ...selectedTurns(await readMessages(source, budget), options).map((item) => ({
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
/** Output never splits a JSON document, UTF8 character, record, or selected turn. */
export function formatLocalHistory(
  result: LocalHistoryResult,
  format: 'json' | 'text' = 'json',
  maxBytes = 8192
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HISTORY_MAX_OUTPUT_BYTES)
    throw new Error('Invalid output byte budget');
  const body =
    format === 'json'
      ? JSON.stringify(result)
      : [
          `source=${result.source} complete=${result.complete} scannedBytes=${result.scan.bytesRead}`,
          ...result.records.map(
            (row) =>
              `[root=${row.rootSessionId} session=${row.sessionId} ${row.timestamp} ${row.role} ${row.phase}]\n${row.message}`
          ),
        ].join('\n\n');
  if (Buffer.byteLength(body) + 1 > maxBytes)
    throw new Error('History output byte budget exceeded; narrow filters or raise --max-bytes');
  return body;
}
