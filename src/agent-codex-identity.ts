/**
 * @fileoverview Bounded Codex rollout attribution for agent evidence. Never uses
 * newest-mtime, prompt timestamps or cwd alone as proof of session ownership.
 */
import { realpathSync } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const UUID_AT_END = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const HEAD_BYTES = 131072;
export interface CodexAttributionOptions {
  codexHome: string;
  sessionId: string;
  workingDir: string;
  resumeSessionId?: string;
}
export interface CodexAttributionBudget {
  maxEntries: number;
  maxBytes: number;
}
interface Metadata {
  id?: string;
  cwd?: string;
  originator?: string;
}
function canonical(path: string): string | undefined {
  try {
    return realpathSync.native(path);
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
  return canonical(path) ?? path;
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
 * A configured resume and a newly owned rollout conflict rather than pinning an
 * old launch forever after /new. TUI resumes of foreign-originator threads cannot
 * be authoritatively tracked from this metadata; this returns attributed evidence.
 */
export async function findExactCodexConversation(
  options: CodexAttributionOptions,
  budget: CodexAttributionBudget = { maxEntries: 8192, maxBytes: 1048576 }
): Promise<{ id: string; path: string } | undefined> {
  const directories = [{ path: join(options.codexHome, 'sessions'), depth: 0 }];
  const candidates: Array<{ id: string; path: string; meta: Metadata }> = [];
  const originator = `codeman_${options.sessionId}`;
  const explicit = options.resumeSessionId;
  let entries = 0;
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
        directories.push({ path, depth: dir.depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const file = await open(path, 'r').catch(() => undefined);
        if (!file) return undefined;
        try {
          const info = await file.stat();
          if (!info.isFile()) return undefined;
          const id = entry.name.match(UUID_AT_END)?.[1];
          const prefixBytes = Math.min(info.size, 4096);
          if (scanned + prefixBytes > budget.maxBytes) return undefined;
          scanned += prefixBytes;
          const prefix = Buffer.alloc(prefixBytes);
          const first = await file.read(prefix, 0, prefixBytes, 0);
          // Cheap negative filter only; a match still needs full parsed metadata.
          if (
            id !== explicit &&
            !prefix.subarray(0, first.bytesRead).toString('utf8').includes(JSON.stringify(originator))
          )
            continue;
          const size = Math.min(info.size, HEAD_BYTES);
          if (scanned + size > budget.maxBytes) return undefined;
          scanned += size;
          const bytes = Buffer.alloc(size);
          const read = await file.read(bytes, 0, size, 0);
          const meta = strictMetadata(bytes.subarray(0, read.bytesRead));
          if (!meta || !id || meta.id !== id) continue;
          if (id === explicit || meta.originator === originator) candidates.push({ id, path, meta });
        } finally {
          await file.close();
        }
      }
    }
  }
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (
    !candidate.meta.cwd ||
    canonical(candidate.meta.cwd) !== canonical(options.workingDir) ||
    !canonical(options.workingDir)
  )
    return undefined;
  const handle = await open(candidate.path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
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
    return { id: candidate.id, path: candidate.path };
  } finally {
    await handle.close();
  }
}
