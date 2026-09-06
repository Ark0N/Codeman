/**
 * @fileoverview Scan `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` for Past
 * Sessions rows, the codex analog of what `scanOmpSessionsHistory()`
 * (omp-transcript.ts) does for omp and `scanProjectDir()` (session-routes.ts)
 * does for Claude's own `~/.claude/projects` transcripts.
 *
 * Without this a codex conversation is invisible to Codeman the moment its
 * session record goes away, even though codex itself never forgot it: the
 * unified list is built from `~/.claude/projects` plus omp's own store, and
 * codex writes to neither. A user who wanted to pick a codex thread back up had
 * to find its id by hand and pass `codexConfig.resumeSessionId` to the API.
 *
 * ## Why this reads windows rather than whole files
 *
 * An omp session file is the conversation only, so its scanner reads each file
 * whole. A codex rollout is not comparable: it carries every reasoning block and
 * every tool call, and its `session_meta` line alone embeds the full base
 * instructions. Measured on a real store of 519 rollouts, the median file is
 * 407 KiB, the 90th percentile 1.3 MiB and the largest 25 MiB, for 381 MiB in
 * total. So this reads a head window for the identity and the opening prompt,
 * and a tail window for the most recent one.
 *
 * The head budget is 128 KiB because `session_meta` runs to roughly 19 KiB and
 * the first real user message lands near 69 KiB behind it, both measured on
 * codex 0.152.1.
 *
 * ## Where the prompt text comes from
 *
 * Codex has emitted user input under three shapes, and this reads all of them,
 * preferring the ones that carry real input only:
 *
 *  - `event_msg` / `item_completed` with an `item.type` of `UserMessage`, which
 *    is what codex 0.152.1 writes.
 *  - `event_msg` / `user_message`, which older versions wrote.
 *  - `response_item` rows with `role: 'user'`, the last resort. These mix real
 *    input with injected context (AGENTS.md, environment context, compaction
 *    summaries), so they are read only when neither shape above appears, and
 *    the obvious injections are dropped.
 *
 * @module codex-transcript
 */

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { LRUMap } from './utils/lru-map.js';

/** Covers `session_meta` (~19 KiB) plus the first user message (~69 KiB behind it). */
const HEAD_BYTES = 131072;

/** Enough to hold the last few turns' worth of lines without re-reading the file. */
const TAIL_BYTES = 65536;

/**
 * Newest rollouts to REPORT. Counted in emitted rows, not files scanned: the
 * store is mostly sub-agent threads this never returns, so capping files first
 * would spend the budget on rows nobody sees.
 */
const MAX_ROLLOUTS = 400;

/**
 * How many emitted rows also get a tail read for `lastPrompt`. The head read is
 * cached (see below) but the tail cannot be, because appending to a rollout is
 * exactly what changes it, so this is the one genuinely per-request cost and it
 * stays bounded. Counted in emitted rows for the same reason as above — against
 * file index a store of sub-agent threads spends the whole budget before the
 * first row that needed it.
 */
const MAX_TAIL_READS = 100;

/** Directory nesting under `sessions/` is year/month/day; stop well past that. */
const MAX_WALK_DEPTH = 5;

/** A rollout shorter than this cannot hold a complete `session_meta` line. */
const MIN_ROLLOUT_BYTES = 100;

export interface CodexHistorySession {
  /** The rollout's own thread id — the token `codex resume <id>` expects. */
  sessionId: string;
  /**
   * `session_meta.originator`, which codex stamps from
   * CODEX_INTERNAL_ORIGINATOR_OVERRIDE — `codeman_<sessionId>` for every pane
   * Codeman spawns. The only link between a FRESH codex pane and the rollout it
   * is writing, since such a pane knows no thread id of its own.
   */
  originator?: string;
  workingDir: string;
  sizeBytes: number;
  /** ISO timestamp, from the file's own mtime. */
  lastModified: string;
  firstPrompt?: string;
  lastPrompt?: string;
}

/** The half of a rollout that never changes once codex has written it. */
interface RolloutIdentity {
  threadId?: string;
  cwd?: string;
  /** `'subagent'` marks a thread codex spawned for itself. */
  threadSource?: string;
  /** `codeman_<sessionId>` for a pane Codeman spawned; codex's own default otherwise. */
  originator?: string;
  firstPrompt?: string;
}

/**
 * `session_meta` is written once and never rewritten — the same fact
 * `readCodexRolloutMetaCached()` in session-routes.ts relies on — so a path's
 * identity is cached, and a rescan costs a `stat` per file plus head reads for
 * rollouts this process has not seen before.
 *
 * ⚠️ The first user message is NOT written up front: codex writes it when the
 * user submits. Caching before then pins `firstPrompt: undefined` for the life
 * of the process, and every scan of the home screen, the command palette and the
 * search-index refresh can land in that window — so the row reads as having no
 * prompt until a restart. `shouldCacheIdentity()` is the guard.
 *
 * Bounded, unlike a plain Map: this process runs for days and every sub-agent
 * rollout adds an entry. Same reason and same size as `codexRolloutMetaCache`.
 */
const identityCache = new LRUMap<string, RolloutIdentity>({ maxSize: 4096 });

/**
 * Is this identity settled enough to keep?
 *
 * A known `firstPrompt` settles it. So does a head read that FILLED its window,
 * which means the prompt is genuinely not in the first `HEAD_BYTES` rather than
 * not written yet. A short file with no prompt is the ambiguous case — codex is
 * still to write one — so that one is re-read next scan.
 */
function shouldCacheIdentity(identity: RolloutIdentity, fileSize: number): boolean {
  if (!identity.threadId) return false;
  return identity.firstPrompt !== undefined || fileSize >= HEAD_BYTES;
}

function codexSessionsRoot(): string {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(home, 'sessions');
}

/** Read at most `bytes` from the front of a file. Returns '' when unreadable. */
async function readHead(path: string, bytes: number): Promise<string> {
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return '';
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Read at most `bytes` from the end of a file, dropping the leading partial
 * line so every line handed back parses.
 */
async function readTail(path: string, size: number, bytes: number): Promise<string> {
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const want = Math.min(bytes, size);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, size - want);
    const text = buf.subarray(0, bytesRead).toString('utf-8');
    if (want >= size) return text; // whole file, nothing was cut
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } catch {
    return '';
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Flatten codex's message content, which is a string or an array of text blocks. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { text: string } => !!b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
    )
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** One line's user-prompt text, whichever of the three shapes it is. */
function userPromptFromLine(entry: {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
    message?: unknown;
    item?: { type?: string; content?: unknown };
  };
}): { text: string; injectionProne: boolean } | null {
  const p = entry.payload;
  if (!p) return null;

  if (entry.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') {
    const text = contentText(p.item.content);
    return text ? { text, injectionProne: false } : null;
  }
  if (entry.type === 'event_msg' && p.type === 'user_message') {
    const text = typeof p.message === 'string' ? p.message.trim() : contentText(p.message);
    return text ? { text, injectionProne: false } : null;
  }
  if (entry.type === 'response_item' && p.role === 'user') {
    const text = contentText(p.content);
    return text ? { text, injectionProne: true } : null;
  }
  return null;
}

/**
 * Injected context rather than something the user typed. Codex prepends the
 * repository's AGENTS.md and wraps environment context in a tag, and both arrive
 * as `response_item` user rows.
 */
function isInjectedContext(text: string): boolean {
  return text.startsWith('#') || text.startsWith('<');
}

/** Collapse to one line and cap, so a row carries a title rather than an essay. */
function asPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** Parse a head window into the facts about a rollout that never change. */
function parseIdentity(head: string): RolloutIdentity {
  const out: RolloutIdentity = {};
  let fallback: string | undefined;
  for (const line of head.split('\n')) {
    if (!line) continue;
    let entry: {
      type?: string;
      payload?: {
        id?: string;
        session_id?: string;
        cwd?: string;
        thread_source?: string;
        originator?: string;
        type?: string;
        role?: string;
        content?: unknown;
        message?: unknown;
        item?: { type?: string; content?: unknown };
      };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // truncated tail of the window, or a malformed line
    }
    const p = entry.payload;
    if (entry.type === 'session_meta' && p) {
      out.threadId ??= p.id || p.session_id;
      out.cwd ??= p.cwd;
      out.threadSource ??= p.thread_source;
      out.originator ??= p.originator;
    } else if (entry.type === 'turn_context' && p) {
      out.cwd ??= p.cwd;
    }
    if (out.firstPrompt) continue;
    const prompt = userPromptFromLine(entry);
    if (!prompt) continue;
    if (!prompt.injectionProne) {
      out.firstPrompt = asPreview(prompt.text);
    } else if (!fallback && !isInjectedContext(prompt.text)) {
      fallback = asPreview(prompt.text);
    }
  }
  out.firstPrompt ??= fallback;
  return out;
}

/** The most recent user prompt in a tail window, or undefined. */
function parseLastPrompt(tail: string): string | undefined {
  let best: string | undefined;
  let fallback: string | undefined;
  for (const line of tail.split('\n')) {
    if (!line) continue;
    try {
      const prompt = userPromptFromLine(JSON.parse(line));
      if (!prompt) continue;
      if (!prompt.injectionProne) best = asPreview(prompt.text);
      else if (!isInjectedContext(prompt.text)) fallback = asPreview(prompt.text);
    } catch {
      // Malformed line — keep scanning.
    }
  }
  return best ?? fallback;
}

/** Every rollout file under `sessions/`, newest first. */
async function listRollouts(root: string): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const st = await stat(full).catch(() => null);
      if (!st || st.size < MIN_ROLLOUT_BYTES) continue;
      files.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  await walk(root, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

/**
 * Codex conversations on this host, newest first, for the unified session list.
 *
 * Sub-agent threads are left out: codex spawns them for itself, they are not
 * something a person picks back up, and on a real store they outnumber the
 * threads that are.
 */
export async function scanCodexSessionsHistory(): Promise<CodexHistorySession[]> {
  const files = await listRollouts(codexSessionsRoot());
  const out: CodexHistorySession[] = [];

  for (const file of files) {
    if (out.length >= MAX_ROLLOUTS) break;

    let identity = identityCache.get(file.path);
    if (!identity) {
      identity = parseIdentity(await readHead(file.path, HEAD_BYTES));
      if (shouldCacheIdentity(identity, file.size)) identityCache.set(file.path, identity);
    }
    if (!identity.threadId || identity.threadSource === 'subagent') continue;
    // A row with no directory has nowhere to resume INTO, and emitting an empty
    // one makes a click post `workingDir: ''`. omp drops such a row; so does this.
    if (!identity.cwd) continue;

    const lastPrompt =
      out.length < MAX_TAIL_READS ? parseLastPrompt(await readTail(file.path, file.size, TAIL_BYTES)) : undefined;

    out.push({
      sessionId: identity.threadId,
      originator: identity.originator,
      workingDir: identity.cwd,
      sizeBytes: file.size,
      lastModified: new Date(file.mtimeMs).toISOString(),
      firstPrompt: identity.firstPrompt,
      lastPrompt: lastPrompt ?? identity.firstPrompt,
    });
  }

  return out;
}

/**
 * Which codex thread each Codeman-spawned pane is writing, keyed by Codeman
 * session id.
 *
 * Codeman spawns every codex pane with
 * CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codeman_<sessionId>, and codex stamps that
 * into `session_meta.originator`. That is the ONLY link between a fresh codex
 * pane and the rollout it is writing: such a pane knows no thread id of its own,
 * so it cannot be folded into its own Past-Sessions row from its own side.
 *
 * Newest wins. `/new` typed inside the codex TUI leaves several rollouts sharing
 * one originator, and the pane is on the most recent — so this expects `rows`
 * newest-first, as `scanCodexSessionsHistory()` returns them.
 */
export function codexThreadBySessionId(rows: CodexHistorySession[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const owner = /^codeman_(.+)$/.exec(row.originator ?? '')?.[1];
    if (owner && !out.has(owner)) out.set(owner, row.sessionId);
  }
  return out;
}

/** Test seam: drop the per-path identity cache. */
export function __clearCodexIdentityCache(): void {
  identityCache.clear();
}
