/**
 * @fileoverview Bounded Codex rollout attribution for agent evidence. Never uses
 * newest-mtime, prompt timestamps or cwd alone as proof of session ownership.
 * The first call walks the store under explicit budgets; the attributed file is
 * then remembered per session and only re-verified (plus a scan of the date
 * directories not older than it) on later calls, since codex never prunes
 * `~/.codex/sessions`.
 */
import { open, opendir, realpath } from 'node:fs/promises';
import { probePathKind } from './utils/bounded-path-probe.js';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { LRUMap } from './utils/lru-map.js';

const UUID_AT_END = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const HEAD_BYTES = 131072;
const PREFIX_SCAN_BYTES = 8 * 1024 * 1024;
export interface CodexAttributionOptions {
  codexHome: string;
  sessionId: string;
  workingDir: string;
  resumeSessionId?: string;
}
export interface CodexAttributionBudget {
  maxEntries: number;
  maxBytes: number;
  /** Separate bound for cheap negative prefixes; full candidate metadata has its own budget. */
  maxPrefixBytes?: number;
}
interface Metadata {
  id?: string;
  cwd?: string;
  originator?: string;
}
async function canonical(path: string): Promise<string | undefined> {
  if ((await probePathKind(path, { pastCap: true })) !== 'directory') return undefined;
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}
/** Match the CLI's relative CODEX_HOME interpretation without exposing env credentials. */
export function resolveEffectiveCodexHome(
  sessionHome: string | undefined,
  workingDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const path = resolve(workingDir, sessionHome || env.CODEX_HOME || join(env.HOME || tmpdir(), '.codex'));
  return path;
}
/** Complete metadata only: a prefix or a partially flushed JSONL row proves nothing. */
function strictMetadata(bytes: Buffer): Metadata | undefined {
  const rows = bytes.toString('utf8').split('\n');
  rows.pop();
  let found: Metadata | undefined;
  for (const line of rows) {
    try {
      const row = JSON.parse(line) as { type?: string; payload?: Metadata };
      if (row.type !== 'session_meta') continue;
      if (
        found ||
        typeof row.payload?.id !== 'string' ||
        typeof row.payload.cwd !== 'string' ||
        (row.payload.originator !== undefined && typeof row.payload.originator !== 'string')
      )
        return undefined;
      found = row.payload;
    } catch {
      /* Incomplete or malformed rows are not identity evidence. */
    }
  }
  return found;
}
/**
 * The rollout a previous call attributed, per session. A later call re-verifies only
 * this file's head (same `dev:ino`, same strict metadata) and then scans just the
 * directories not older than its own for a second candidate (codex `/new`, or a new
 * owned rollout beside a configured resume), instead of re-reading the whole store,
 * which codex never prunes. A head that no longer verifies drops the entry and falls
 * back to the full walk; a failed incremental scan drops it and answers unattributed,
 * since the full walk reads a superset of that scan. Bounded: one entry per live
 * session is the expected size.
 */
interface AttributionMemo {
  id: string;
  path: string;
  dev: number;
  ino: number;
  meta: Metadata;
  /** Directory components of `path` below `sessions/`, used to prune older siblings. */
  dirParts: string[];
}
const attributionMemo = new LRUMap<string, AttributionMemo>({ maxSize: 1024 });
/** Test-only: forget every remembered attribution. */
export function __clearCodexAttributionMemo(): void {
  attributionMemo.clear();
}
/** Short first read: `originator` sits right after `id`, `timestamp` and `cwd`. */
const PREFIX_FIRST_BYTES = 1024;
/** Fallback read when the first window holds no complete `originator` field. */
const PREFIX_MAX_BYTES = 4096;
const ORIGINATOR_FIELD = /"originator"\s*:\s*"(?:[^"\\]|\\.)*"/;
/**
 * Is a date-shaped directory name older than the remembered one at the same depth?
 * Only all-digit names compare (codex writes `sessions/YYYY/MM/DD/`); anything else
 * is never pruned, so an unexpected layout costs a wider scan, not a missed rollout.
 */
function olderDatePart(name: string, memo: string | undefined): boolean {
  if (memo === undefined || !/^\d+$/.test(name) || !/^\d+$/.test(memo)) return false;
  return Number(name) < Number(memo);
}
/**
 * A configured resume and a newly owned rollout conflict rather than pinning an
 * old launch forever after /new. TUI resumes of foreign-originator threads cannot
 * be authoritatively tracked from this metadata; this returns attributed evidence.
 */
export async function findExactCodexConversation(
  options: CodexAttributionOptions,
  budget: CodexAttributionBudget = { maxEntries: 8192, maxBytes: 1048576 }
): Promise<{ id: string; path: string } | undefined> {
  const workspace = await canonical(options.workingDir);
  const home = await canonical(options.codexHome);
  if (!workspace || !home) return undefined;
  const sessions = join(home, 'sessions');
  if ((await probePathKind(sessions, { pastCap: true })) !== 'directory') return undefined;
  const key = [home, options.sessionId, options.resumeSessionId ?? '', workspace].join('\0');
  const remembered = attributionMemo.get(key);
  if (remembered) {
    const verified = await verifyRemembered(remembered, workspace, budget);
    if (verified) {
      const others = await scanCandidates(sessions, options, budget, remembered.dirParts);
      if (others && others.length === 1 && others[0].path === remembered.path) {
        return { id: remembered.id, path: remembered.path };
      }
    }
    attributionMemo.delete(key);
    // A file that no longer verifies (replaced, rewritten, gone) gets one full walk
    // now. A verified file whose incremental scan failed does not: that scan reads a
    // subset of what a full walk reads under the same budget, so a second candidate,
    // an exhausted budget or an unreadable entry it hit is one the full walk would hit
    // too, and walking the whole never-pruned store could only end the same way.
    if (verified) return undefined;
  }
  const candidates = await scanCandidates(sessions, options, budget);
  if (!candidates || candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (!candidate.meta.cwd || (await canonical(candidate.meta.cwd)) !== workspace) return undefined;
  const handle = await open(candidate.path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    const bytes = Buffer.alloc(HEAD_BYTES);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const meta = strictMetadata(bytes.subarray(0, read.bytesRead));
    if (
      !meta ||
      meta.id !== candidate.id ||
      meta.cwd !== candidate.meta.cwd ||
      meta.originator !== candidate.meta.originator
    )
      return undefined;
    attributionMemo.set(key, {
      id: candidate.id,
      path: candidate.path,
      dev: info.dev,
      ino: info.ino,
      meta,
      dirParts: relative(sessions, dirname(candidate.path)).split(sep).filter(Boolean),
    });
    return { id: candidate.id, path: candidate.path };
  } finally {
    await handle.close();
  }
}
/** Same file (`dev:ino`), same strict metadata, same canonical workspace: nothing else. */
async function verifyRemembered(
  memo: AttributionMemo,
  workspace: string,
  budget: CodexAttributionBudget
): Promise<boolean> {
  if (HEAD_BYTES > budget.maxBytes) return false;
  if (!memo.meta.cwd || (await canonical(memo.meta.cwd)) !== workspace) return false;
  const handle = await open(memo.path, 'r').catch(() => undefined);
  if (!handle) return false;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== memo.dev || info.ino !== memo.ino) return false;
    const bytes = Buffer.alloc(HEAD_BYTES);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const meta = strictMetadata(bytes.subarray(0, read.bytesRead));
    return !!meta && meta.id === memo.id && meta.cwd === memo.meta.cwd && meta.originator === memo.meta.originator;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}
/**
 * Every rollout under `sessions` whose strict metadata names this session (or the
 * configured resume id), or undefined when the walk hit a bound or an unreadable
 * entry (an incomplete inventory proves nothing). With `notOlderThan`, date-shaped
 * directories older than those components are skipped.
 */
async function scanCandidates(
  sessions: string,
  options: CodexAttributionOptions,
  budget: CodexAttributionBudget,
  notOlderThan?: string[]
): Promise<Array<{ id: string; path: string; meta: Metadata }> | undefined> {
  // `onBoundary`: every ancestor so far equals the remembered path, so pruning applies.
  const directories = [{ path: sessions, depth: 0, onBoundary: notOlderThan !== undefined }];
  const candidates: Array<{ id: string; path: string; meta: Metadata }> = [];
  const originator = `codeman_${options.sessionId}`;
  const originatorJson = JSON.stringify(originator);
  const explicit = options.resumeSessionId;
  let entries = 0;
  let prefixes = 0;
  const prefixLimit = Math.min(budget.maxPrefixBytes ?? PREFIX_SCAN_BYTES, PREFIX_SCAN_BYTES);
  let scanned = HEAD_BYTES; // Reserve an independent final verification.
  while (directories.length) {
    const dir = directories.pop()!;
    const handle = await opendir(dir.path).catch(() => undefined);
    if (!handle) return undefined;
    for await (const entry of handle) {
      if (++entries > budget.maxEntries) return undefined;
      const path = join(dir.path, entry.name);
      if (entry.isDirectory()) {
        if (dir.depth >= 8) return undefined;
        const part = notOlderThan?.[dir.depth];
        if (dir.onBoundary && olderDatePart(entry.name, part)) continue;
        directories.push({ path, depth: dir.depth + 1, onBoundary: dir.onBoundary && entry.name === part });
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const id = entry.name.match(UUID_AT_END)?.[1];
        if (!id) continue; // no rollout id in the name: never a candidate, read nothing
        const file = await open(path, 'r').catch(() => undefined);
        if (!file) return undefined;
        try {
          const info = await file.stat();
          if (!info.isFile()) return undefined;
          if (id !== explicit) {
            // Cheap negative filter only; a match still needs full parsed metadata.
            // A short first window decides when it already holds the whole
            // `originator` field; only otherwise is the wider window read.
            let window = Math.min(info.size, PREFIX_FIRST_BYTES);
            let prefix = '';
            for (;;) {
              if (prefixes + window > prefixLimit) return undefined;
              prefixes += window;
              const buffer = Buffer.alloc(window);
              const first = await file.read(buffer, 0, window, 0);
              prefix = buffer.subarray(0, first.bytesRead).toString('utf8');
              if (prefix.includes(originatorJson) || ORIGINATOR_FIELD.test(prefix)) break;
              const wider = Math.min(info.size, PREFIX_MAX_BYTES);
              if (wider <= window) break;
              window = wider;
            }
            if (!prefix.includes(originatorJson)) continue;
          }
          const size = Math.min(info.size, HEAD_BYTES);
          if (scanned + size > budget.maxBytes) return undefined;
          scanned += size;
          const bytes = Buffer.alloc(size);
          const read = await file.read(bytes, 0, size, 0);
          const meta = strictMetadata(bytes.subarray(0, read.bytesRead));
          if (!meta || meta.id !== id) continue;
          if (id === explicit || meta.originator === originator) candidates.push({ id, path, meta });
        } finally {
          await file.close();
        }
      }
    }
  }
  return candidates;
}
