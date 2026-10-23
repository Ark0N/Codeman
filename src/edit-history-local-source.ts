/**
 * @fileoverview Reads a local claude session's transcripts for its edit history: the main
 * transcript and its subagent transcripts, each from a byte offset.
 *
 * WHICH FILE (`resolveClaudeTranscript`). The transcript watcher's path, which the session's
 * hooks report, so a session is read from wherever its claude really writes. Before the first
 * hook after a server restart the watcher has none, and `findClaudeTranscript` looks for
 * `<id>.jsonl` under the session's own `CLAUDE_CONFIG_DIR` override, else the server's
 * (`claudeProjectsDir()`, as the relaunch pin does). A config dir set outside Codeman is not
 * guessed; it is found with the next hook. Subagents live in
 * `<main path without .jsonl>/subagents/agent-<id>.jsonl`.
 *
 * HOW MUCH. A requested file is read from its `offset` (clamped to its size), an unrequested
 * (new) one from `budget` bytes before its end, and a new subagent's `.meta.json` (≤ 8 KB)
 * comes along. `budgetBytes` is shared by all files, main first; once spent, files still
 * report their size with an empty chunk. A request with `len` is a block that must end at
 * `offset + len` (an "older" block ends at the floor): short of budget, its end is read.
 * With `onlyRequested` ("older" reads) unrequested files are left out.
 *
 * Tests: `test/edit-history-local-source.test.ts`.
 *
 * @module edit-history-local-source
 */

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { claudeProjectsDir } from './utils/claude-transcript.js';

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const REL_PATH_PATTERN = /^(main|subagents\/agent-[A-Za-z0-9_-]+\.jsonl)$/;
const AGENT_FILE_PATTERN = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const META_MAX_BYTES = 8192;

/** One file to read from where the last read stopped (`len` only for an "older" block). */
export interface EditSourceRequest {
  /** `main` or `subagents/agent-<id>.jsonl`. */
  relPath: string;
  offset: number;
  len?: number;
}

export interface EditSourceFile {
  relPath: string;
  /** The file's size when it was read. */
  size: number;
  startOffset: number;
  chunk: Buffer;
}

export interface EditSources {
  /** The conversation id: the main transcript's file name without `.jsonl`. */
  transcriptId: string;
  files: EditSourceFile[];
  /** `agent-<id>.meta.json` text of each subagent read for the first time, by agent id. */
  metas: Record<string, string>;
}

export interface EditSourceReadOptions {
  /** Read only the requested files; the others are not listed. */
  onlyRequested?: boolean;
}

/** What a path turned out to be (for Bash image candidates). */
export interface PathProbe {
  /** The path with symlinks resolved. */
  realPath: string;
  kind: 'file' | 'directory' | 'other';
  /** Size in bytes (0 for anything that is not a regular file). */
  size: number;
  mtimeMs: number;
}

async function readRange(path: string, offset: number, len: number): Promise<Buffer> {
  if (len <= 0) return Buffer.alloc(0);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await fh.close();
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** The newest `<id>.jsonl` under any project dir, for the first id that has one; null when none does. */
export async function findClaudeTranscript(
  ids: readonly string[],
  projectsDir: string = claudeProjectsDir()
): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const id of new Set(ids)) {
    if (!ID_PATTERN.test(id)) continue;
    let best: { path: string; mtime: number } | null = null;
    for (const dir of dirs) {
      const path = join(projectsDir, dir, `${id}.jsonl`);
      try {
        const s = await stat(path);
        if (s.isFile() && (!best || s.mtimeMs > best.mtime)) best = { path, mtime: s.mtimeMs };
      } catch {
        // not in this project dir
      }
    }
    if (best) return best.path;
  }
  return null;
}

/**
 * The session's main transcript: the transcript watcher's (hook-reported) path when there is
 * one, else the newest `<id>.jsonl` under `configDir` (the session's `CLAUDE_CONFIG_DIR`
 * override; the server's config dir when unset). Null when neither finds one.
 */
export async function resolveClaudeTranscript(
  watcherPath: string | null | undefined,
  ids: readonly string[],
  configDir?: string
): Promise<string | null> {
  return watcherPath || findClaudeTranscript(ids, claudeProjectsDir(configDir));
}

/**
 * Read the main transcript at `mainPath` and its subagent transcripts. Null when `mainPath`
 * is not an absolute `<id>.jsonl` path or the file does not exist.
 */
export async function readClaudeEditSources(
  mainPath: string,
  requests: readonly EditSourceRequest[],
  budgetBytes: number,
  opts: EditSourceReadOptions = {}
): Promise<EditSources | null> {
  if (!isAbsolute(mainPath) || !mainPath.endsWith('.jsonl')) return null;
  const transcriptId = basename(mainPath, '.jsonl');
  if (!ID_PATTERN.test(transcriptId)) return null;

  const byPath = new Map<string, EditSourceRequest>();
  for (const r of requests) {
    if (!REL_PATH_PATTERN.test(r.relPath) || byPath.has(r.relPath)) continue;
    if (!Number.isSafeInteger(r.offset) || r.offset < 0) continue;
    if (r.len !== undefined && (!Number.isSafeInteger(r.len) || r.len < 0)) continue;
    byPath.set(r.relPath, r);
  }

  const subDir = join(mainPath.slice(0, -'.jsonl'.length), 'subagents');
  const sources: Array<{ relPath: string; path: string; agentId?: string }> = [{ relPath: 'main', path: mainPath }];
  try {
    for (const name of (await readdir(subDir)).sort()) {
      const m = AGENT_FILE_PATTERN.exec(name);
      if (m) sources.push({ relPath: `subagents/${name}`, path: join(subDir, name), agentId: m[1] });
    }
  } catch {
    // no subagents yet
  }

  let remaining = Math.max(0, Math.floor(budgetBytes));
  const files: EditSourceFile[] = [];
  const metas: Record<string, string> = {};
  for (const src of sources) {
    const size = await fileSize(src.path);
    if (size === null) {
      if (src.relPath === 'main') return null;
      continue;
    }
    const req = byPath.get(src.relPath);
    if (!req && opts.onlyRequested) continue;
    let start: number;
    let len: number;
    if (req?.len !== undefined) {
      const blockStart = Math.min(req.offset, size);
      const blockEnd = Math.min(req.offset + req.len, size);
      len = Math.min(blockEnd - blockStart, remaining);
      start = blockEnd - len;
    } else if (req) {
      start = Math.min(req.offset, size);
      len = Math.min(remaining, size - start);
    } else {
      len = Math.min(size, remaining);
      start = size - len;
    }
    const chunk = await readRange(src.path, start, len);
    remaining -= chunk.length;
    files.push({ relPath: src.relPath, size, startOffset: start, chunk });
    if (!req && src.agentId) {
      const metaPath = join(subDir, `agent-${src.agentId}.meta.json`);
      const metaSize = await fileSize(metaPath);
      if (metaSize !== null) {
        metas[src.agentId] = (await readRange(metaPath, 0, Math.min(metaSize, META_MAX_BYTES))).toString('utf8');
      }
    }
  }
  return { transcriptId, files, metas };
}

/** Per path its resolved path, kind, size and mtime, or null when it does not exist. `~/` means this user's home. */
export async function probeLocalPaths(
  paths: readonly string[],
  home: string = homedir()
): Promise<Array<PathProbe | null>> {
  return Promise.all(
    paths.map(async (p) => {
      const path = p.startsWith('~/') ? join(home, p.slice(2)) : p;
      try {
        const real = await realpath(path);
        const s = await stat(real);
        return {
          realPath: real,
          kind: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other',
          size: s.isFile() ? s.size : 0,
          mtimeMs: Math.floor(s.mtimeMs),
        } satisfies PathProbe;
      } catch {
        return null;
      }
    })
  );
}
