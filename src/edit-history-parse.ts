/**
 * @fileoverview Edit history parser: claude JSONL transcript lines → the files the agent
 * edited (with their diff) and the images its Bash calls may have produced.
 *
 * Every `Edit`/`Write` result line carries `toolUseResult.filePath` and a
 * `structuredPatch` (hunks with ` `/`+`/`-` prefixed lines), so a per-edit diff needs no
 * git. The whole-file fields next to it (`originalFile`, `content`) are never kept.
 *
 * Images rarely come from `Write`; they come from scripts run through Bash. A Bash call
 * yields a CANDIDATE: the image-looking paths in its command and output, with the call's
 * start and end time. Whether a candidate file was actually produced by the call (its
 * mtime falls inside that window) is decided later by whoever can stat it, locally or on
 * the remote host — this module does no IO.
 *
 * Chunked input: a transcript is read in byte ranges, so a Bash `tool_use` and its result
 * can land in different chunks. Unanswered calls are handed back as `pending` and passed
 * into the next call.
 *
 * Tests: `test/edit-history-parse.test.ts`.
 *
 * @module edit-history-parse
 */

import { posix } from 'node:path';

/** Per-record budget for kept hunk lines; a larger patch is cut and marked `truncated`. */
export const MAX_HUNK_BYTES = 64 * 1024;
/** Image paths kept per Bash call. */
export const MAX_IMAGE_CANDIDATES = 20;
/** Unanswered Bash calls carried between chunks (an interrupted call never gets a result). */
export const MAX_PENDING_BASH = 200;
/**
 * Command text kept per unanswered Bash call. Pending calls are persisted with the store, so
 * this bounds it; an image path past this point of a command is still found in the output.
 */
export const MAX_PENDING_COMMAND_CHARS = 8192;
/** Longest id, cwd or agent id of an unanswered Bash call; a call with a longer one is not kept. */
export const MAX_PENDING_FIELD_CHARS = 4096;

export type EditKind = 'code' | 'image';
/** `edit` = a result with a path and a patch from a tool other than Edit/Write. */
export type EditTool = 'Edit' | 'Write' | 'edit';

export interface EditHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface EditRecord {
  /** The `tool_use_id` of the edit — unique per edit, used to deduplicate. */
  id: string;
  /** ms since epoch, from the result line's `timestamp` (0 when missing). */
  ts: number;
  path: string;
  kind: EditKind;
  tool: EditTool;
  /** A `Write` that created the file. */
  created: boolean;
  /** Counted over the whole patch, also when `hunks` was cut. */
  added: number;
  removed: number;
  hunks: EditHunk[];
  truncated: boolean;
  /** Set for lines of a subagent transcript. */
  agentId?: string;
}

export interface PendingBash {
  id: string;
  ts: number;
  command: string;
  cwd: string;
  agentId?: string;
}

export interface ImageCandidate {
  toolUseId: string;
  start: number;
  end: number;
  paths: string[];
  agentId?: string;
  /**
   * Files claude handed to the user (`SendUserFile`): shown on purpose, so no mtime window
   * applies; the file must still exist, and a version already listed is not listed again.
   */
  sent?: boolean;
}

export interface EditParseResult {
  records: EditRecord[];
  candidates: ImageCandidate[];
  pending: PendingBash[];
}

const IMAGE_EXT = '(?:png|jpe?g|gif|webp|avif|svg)';
const IMAGE_PATH_RE = new RegExp(`\\.${IMAGE_EXT}$`, 'i');
// After the extension: no further name character, and no `.ext` (a.png.bak).
const EXT_END = '(?![\\w-])(?!\\.\\w)';
// Characters that end an unquoted path token.
const TOKEN_CHAR = '[^\\s\'"`<>|;&()=,:*?]';
const PATH_TOKEN_RE = new RegExp(
  [
    // 1. file:// URL (Codex: `Saved to: file:///…`) — may contain spaces up to the extension.
    `file://(/[^\\n]*?\\.${IMAGE_EXT})${EXT_END}`,
    // 2./3. Quoted paths, spaces allowed.
    `"([^"\\n]*\\.${IMAGE_EXT})"`,
    `'([^'\\n]*\\.${IMAGE_EXT})'`,
    // 4. Unquoted token. The lookbehind keeps a match from starting inside a URL, a glob
    //    or a longer name; the name before the extension must not be empty.
    `(?<![\\w:/.~*?$-])((?:${TOKEN_CHAR}*/)?[^\\s'"\`<>|;&()=,:*?/]+\\.${IMAGE_EXT})${EXT_END}`,
  ].join('|'),
  'gi'
);

/** `image` for the image extensions the panel can thumbnail, else `code`. */
export function classifyEditPath(path: string): EditKind {
  return IMAGE_PATH_RE.test(path) ? 'image' : 'code';
}

/**
 * Image-looking paths in a Bash call's command and output, in order of appearance,
 * deduplicated and capped at {@link MAX_IMAGE_CANDIDATES}. Absolute paths are normalised,
 * `~/` paths stay literal (the host that stats them expands `~`), relative ones are
 * resolved against `cwd` and dropped when `cwd` is not absolute. URLs and globs are
 * skipped.
 */
export function extractImagePathCandidates(command: string, stdout: string, stderr: string, cwd: string): string[] {
  const text = [command, stdout, stderr].join('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!raw || raw.includes('://') || /[*?]/.test(raw)) continue;
    let resolved: string;
    if (raw.startsWith('/')) resolved = posix.normalize(raw);
    else if (raw.startsWith('~/')) resolved = raw;
    else if (cwd.startsWith('/')) resolved = posix.resolve(cwd, raw);
    else continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
    if (out.length >= MAX_IMAGE_CANDIDATES) break;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The hunks of `patch` with their string lines, cut once the lines reach {@link MAX_HUNK_BYTES}
 * (`truncated`). Also applied to hunks loaded from a store file.
 */
export function capHunks(patch: readonly unknown[]): { hunks: EditHunk[]; truncated: boolean } {
  const hunks: EditHunk[] = [];
  let budget = MAX_HUNK_BYTES;
  let truncated = false;
  for (const h of patch) {
    if (!isRecord(h) || !Array.isArray(h.lines)) continue;
    if (truncated) break;
    const kept: string[] = [];
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      const cost = Buffer.byteLength(l) + 3;
      if (cost > budget) {
        truncated = true;
        break;
      }
      budget -= cost;
      kept.push(l);
    }
    hunks.push({
      oldStart: Number(h.oldStart) || 0,
      oldLines: Number(h.oldLines) || 0,
      newStart: Number(h.newStart) || 0,
      newLines: Number(h.newLines) || 0,
      lines: kept,
    });
  }
  return { hunks, truncated };
}

function toHunks(patch: unknown[]): { hunks: EditHunk[]; added: number; removed: number; truncated: boolean } {
  let added = 0;
  let removed = 0;
  for (const h of patch) {
    if (!isRecord(h) || !Array.isArray(h.lines)) continue;
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { ...capHunks(patch), added, removed };
}

/** A new file's content as one all-added hunk, in `structuredPatch` form. */
function createdFileHunk(content: string): Record<string, unknown> {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) };
}

function toEditRecord(id: string, ts: number, result: unknown, agentId: string | undefined): EditRecord | null {
  if (!isRecord(result)) return null;
  const { filePath, structuredPatch } = result;
  if (typeof filePath !== 'string' || !filePath || !Array.isArray(structuredPatch)) return null;
  const tool: EditTool = typeof result.type === 'string' ? 'Write' : 'oldString' in result ? 'Edit' : 'edit';
  const kind = classifyEditPath(filePath);
  // A Write that created a file reports an empty patch; its diff is the whole content.
  const patch =
    result.type === 'create' && structuredPatch.length === 0 && kind !== 'image' && typeof result.content === 'string'
      ? [createdFileHunk(result.content)]
      : structuredPatch;
  const { hunks, added, removed, truncated } = toHunks(patch);
  const record: EditRecord = {
    id,
    ts,
    path: filePath,
    kind,
    tool,
    created: result.type === 'create',
    added,
    removed,
    hunks,
    truncated,
  };
  if (agentId) record.agentId = agentId;
  return record;
}

/**
 * Image paths of a `SendUserFile` result (`{ caption, attachments: [{ path }] }`): the
 * files claude delivered to the user, which is how a session shows generated images.
 */
function sentImagePaths(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.attachments)) return [];
  const out: string[] = [];
  for (const a of result.attachments) {
    if (!isRecord(a) || typeof a.path !== 'string' || !a.path.startsWith('/')) continue;
    if (IMAGE_PATH_RE.test(a.path) && !out.includes(a.path)) out.push(a.path);
  }
  return out;
}

/** The text of a `tool_result` block's content (a string or a list of text blocks). */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Parse transcript lines into edit records and Bash image candidates.
 *
 * @param text complete JSONL lines; a first line cut mid-record (a byte range starting
 *   inside it) and anything else that does not parse is skipped.
 * @param pending unanswered Bash calls from the previous chunk.
 */
export function parseClaudeEditLines(text: string, pending: readonly PendingBash[] = []): EditParseResult {
  const open = new Map<string, PendingBash>(pending.map((p) => [p.id, p]));
  const records: EditRecord[] = [];
  const candidates: ImageCandidate[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(rec)) continue;
    const message = rec.message;
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    const parsedTs = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : 0;
    const agentId = typeof rec.agentId === 'string' && rec.agentId ? rec.agentId : undefined;
    const cwd = typeof rec.cwd === 'string' ? rec.cwd : '';

    if (rec.type === 'assistant') {
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use' || block.name !== 'Bash') continue;
        if (typeof block.id !== 'string' || !isRecord(block.input)) continue;
        const command = block.input.command;
        if (typeof command !== 'string') continue;
        if ([block.id, cwd, agentId ?? ''].some((f) => f.length > MAX_PENDING_FIELD_CHARS)) continue;
        const entry: PendingBash = { id: block.id, ts, command: command.slice(0, MAX_PENDING_COMMAND_CHARS), cwd };
        if (agentId) entry.agentId = agentId;
        open.delete(block.id);
        open.set(block.id, entry);
        while (open.size > MAX_PENDING_BASH) open.delete(open.keys().next().value as string);
      }
      continue;
    }

    if (rec.type !== 'user') continue;
    const results = content.filter(
      (b): b is Record<string, unknown> => isRecord(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string'
    );
    // `toolUseResult` describes the line's result; it is unambiguous only for one block.
    const single = results.length === 1;
    for (const block of results) {
      const id = block.tool_use_id as string;
      if (single) {
        const edit = toEditRecord(id, ts, rec.toolUseResult, agentId);
        if (edit) records.push(edit);
      }
      const sent = single ? sentImagePaths(rec.toolUseResult) : [];
      if (sent.length > 0) {
        const candidate: ImageCandidate = { toolUseId: id, start: ts, end: ts, paths: sent, sent: true };
        if (agentId) candidate.agentId = agentId;
        candidates.push(candidate);
      }
      const call = open.get(id);
      if (!call) continue;
      open.delete(id);
      const r = single ? rec.toolUseResult : undefined;
      let stdout: string;
      let stderr = '';
      if (isRecord(r) && (typeof r.stdout === 'string' || typeof r.stderr === 'string')) {
        stdout = typeof r.stdout === 'string' ? r.stdout : '';
        stderr = typeof r.stderr === 'string' ? r.stderr : '';
      } else {
        stdout = blockText(block.content);
      }
      const paths = extractImagePathCandidates(call.command, stdout, stderr, call.cwd);
      if (paths.length === 0) continue;
      const candidate: ImageCandidate = { toolUseId: id, start: call.ts, end: ts, paths };
      if (call.agentId) candidate.agentId = call.agentId;
      candidates.push(candidate);
    }
  }

  return { records, candidates, pending: [...open.values()] };
}
