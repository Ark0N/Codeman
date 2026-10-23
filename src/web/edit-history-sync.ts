/**
 * @fileoverview Reads a claude session's edit history on request: the new bytes of its
 * transcripts (main + subagents) go into its `EditHistoryStore`, and the Bash image
 * candidates that came with them are confirmed against the files on disk.
 *
 * WHEN. Only when the panel asks (`GET …/edits?sync=1` on open and while it follows the
 * session, `POST …/edits/older`): no timer, no hook, no background read for sessions nobody
 * looks at. One sync per session runs at a time; a request during a run is folded into one
 * more run afterwards.
 *
 * WHICH SESSIONS. Local claude sessions. Remote, Docker and non-claude sessions answer
 * `unsupported` and are never read.
 *
 * IMAGES. A Bash candidate counts only when the file's mtime lies in the call's window
 * (start − 2 s … end + 2 s), so `ls *.png` lists nothing.
 *
 * Tests: `test/edit-history-sync.test.ts`.
 *
 * @module web/edit-history-sync
 */

import type { SessionRemote } from '../types/session.js';
import type { EditSourceRequest, EditSources, PathProbe } from '../edit-history-local-source.js';
import type { ImageCandidate } from '../edit-history-parse.js';
import { EditHistoryStore, READ_BUDGET_BYTES, type ConfirmedImage } from '../edit-history-store.js';
import { getCli } from '../config/cli-registry/registry.js';

/** Slack around a Bash call's window for the image mtime check. */
export const IMAGE_MTIME_SLACK_MS = 2000;
/** Forward passes per sync when a file grew by more than one budget. */
export const MAX_FORWARD_PASSES = 3;
/** `reason` when the session has no transcript yet (no prompt yet, or not found). */
export const NO_TRANSCRIPT = 'no-transcript';

export type EditHistoryState = 'ok' | 'unavailable' | 'unsupported';

export interface EditHistoryStatus {
  state: EditHistoryState;
  reason?: string;
}

/** The slice of a session this needs. */
export interface EditHistorySession {
  id: string;
  mode: string;
  remote: SessionRemote | undefined;
  docker?: unknown;
  claudeSessionId: string | null;
  /** The session's own `CLAUDE_CONFIG_DIR` (Codeman env override), if it has one. */
  claudeConfigDir?: string;
}

export interface EditHistorySyncDeps {
  /** The session's main transcript path, or null when it has none yet. */
  transcriptPath(session: EditHistorySession): Promise<string | null>;
  readSources(mainPath: string, requests: readonly EditSourceRequest[], budget: number): Promise<EditSources | null>;
  probe(paths: readonly string[]): Promise<Array<PathProbe | null>>;
  loadStore(sessionId: string): Promise<EditHistoryStore>;
  budget?: number;
}

export interface SyncOptions {
  older?: boolean;
}

/** Why a session has no edit history, or undefined when it can have one. */
export function unsupportedReason(session: EditHistorySession): string | undefined {
  if (session.remote) return 'remote';
  if (session.docker) return 'docker';
  if (getCli(session.mode)?.capabilities.transcript !== 'claude-jsonl') return 'mode';
  return undefined;
}

/**
 * Bash candidates whose probed file is a regular file with an mtime inside the call's window
 * (files claude sent to the user skip the window: they exist and were shown on purpose).
 * A candidate whose file version is already recorded is skipped: `known(path)` is the newest
 * entry time for that path, and an entry at or after `mtime − slack` saw this version — the
 * `ls *.png` right after the render, or a Write followed by a listing. Candidates are taken
 * in call order so a batch dedupes itself the same way.
 */
export function confirmImages(
  candidates: readonly ImageCandidate[],
  probe: (path: string) => PathProbe | null | undefined,
  known: (path: string) => number | undefined = () => undefined
): ConfirmedImage[] {
  const out: ConfirmedImage[] = [];
  const seen = new Map<string, number>();
  for (const c of [...candidates].sort((a, b) => a.end - b.end)) {
    for (const path of c.paths) {
      const p = probe(path);
      if (!p || p.kind !== 'file' || !p.mtimeMs) continue;
      const inWindow = p.mtimeMs >= c.start - IMAGE_MTIME_SLACK_MS && p.mtimeMs <= c.end + IMAGE_MTIME_SLACK_MS;
      if (!c.sent && !inWindow) continue;
      const entryPath = path.startsWith('~/') ? p.realPath : path;
      const last = Math.max(seen.get(entryPath) ?? -Infinity, known(entryPath) ?? -Infinity);
      if (last >= p.mtimeMs - IMAGE_MTIME_SLACK_MS) continue;
      seen.set(entryPath, c.end);
      const img: ConfirmedImage = {
        toolUseId: c.toolUseId,
        path: entryPath,
        ts: c.end,
        tool: c.sent ? 'sent' : 'bash',
      };
      if (c.agentId) img.agentId = c.agentId;
      out.push(img);
    }
  }
  return out;
}

interface SessionSlot {
  store?: EditHistoryStore;
  status: EditHistoryStatus;
  running?: Promise<void>;
  again?: { older: boolean };
}

export class EditHistorySync {
  private readonly slots = new Map<string, SessionSlot>();
  private readonly budget: number;

  constructor(private readonly deps: EditHistorySyncDeps) {
    this.budget = deps.budget ?? READ_BUDGET_BYTES;
  }

  /** The session's store, loaded from disk on first use. */
  async getStore(sessionId: string): Promise<EditHistoryStore> {
    const slot = this.slot(sessionId);
    if (!slot.store) slot.store = await this.deps.loadStore(sessionId);
    return slot.store;
  }

  getStatus(sessionId: string): EditHistoryStatus {
    return { ...this.slot(sessionId).status };
  }

  /**
   * Read what is new (or, with `older`, the next older block). Resolves when this
   * request's run is done; never rejects. A call during a run queues one more run.
   */
  async sync(session: EditHistorySession, opts: SyncOptions = {}): Promise<EditHistoryStatus> {
    const why = unsupportedReason(session);
    const slot = this.slot(session.id);
    if (why) {
      slot.status = { state: 'unsupported', reason: why };
      return this.getStatus(session.id);
    }
    if (slot.running) {
      slot.again = { older: (slot.again?.older ?? false) || !!opts.older };
      await slot.running;
      // The queued run starts when the current one ends; wait for it too.
      if (slot.running) await slot.running;
      return this.getStatus(session.id);
    }
    slot.running = this.runLoop(session, !!opts.older);
    try {
      await slot.running;
    } finally {
      slot.running = undefined;
    }
    return this.getStatus(session.id);
  }

  /** Write every loaded store's pending changes (server shutdown). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => slot.store?.flush()));
  }

  /** Drop a deleted session: forget it and delete its stored history. */
  async remove(sessionId: string): Promise<void> {
    const store = await this.getStore(sessionId);
    this.slots.delete(sessionId);
    await store.remove();
  }

  private slot(sessionId: string): SessionSlot {
    let slot = this.slots.get(sessionId);
    if (!slot) {
      slot = { status: { state: 'ok' } };
      this.slots.set(sessionId, slot);
    }
    return slot;
  }

  private async runLoop(session: EditHistorySession, older: boolean): Promise<void> {
    const slot = this.slot(session.id);
    let next: boolean | null = older;
    while (next !== null) {
      await this.runOnce(session, next);
      next = slot.again ? slot.again.older : null;
      slot.again = undefined;
    }
  }

  private async runOnce(session: EditHistorySession, older: boolean): Promise<void> {
    const slot = this.slot(session.id);
    const store = await this.getStore(session.id);
    try {
      const path = await this.deps.transcriptPath(session);
      let found: boolean;
      if (!path) {
        found = false;
      } else if (older) {
        found = await this.readOlder(path, store);
      } else {
        found = true;
        for (let pass = 0; pass < MAX_FORWARD_PASSES && found; pass++) {
          const r = await this.readForward(path, store);
          found = r.found;
          if (!r.more) break;
        }
      }
      slot.status = found ? { state: 'ok' } : { state: 'unavailable', reason: NO_TRANSCRIPT };
    } catch (err) {
      slot.status = { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private forwardRequests(store: EditHistoryStore): EditSourceRequest[] {
    const out: EditSourceRequest[] = [];
    for (const relPath of store.knownSources()) {
      const c = store.getCursor(relPath);
      if (c) out.push({ relPath, offset: c.offset });
    }
    return out;
  }

  /**
   * One forward read of all sources. `more` = some file has unread bytes after it.
   * A transcript other than the stored one (`/clear`, resume) is read like a first read.
   */
  private async readForward(path: string, store: EditHistoryStore): Promise<{ found: boolean; more: boolean }> {
    const known = store.getTranscriptId();
    const requests = known !== null && path.endsWith(`/${known}.jsonl`) ? this.forwardRequests(store) : [];
    const res = await this.deps.readSources(path, requests, this.budget);
    if (!res) return { found: false, more: false };
    for (const [agentId, text] of Object.entries(res.metas)) {
      if (!store.hasAgentMeta(agentId)) store.setAgentMeta(agentId, text);
    }
    let more = false;
    const candidates: ImageCandidate[] = [];
    for (const f of res.files) {
      const r = store.apply({
        transcriptId: res.transcriptId,
        source: f.relPath,
        startOffset: f.startOffset,
        chunk: f.chunk,
        size: f.size,
      });
      candidates.push(...r.candidates);
      if (f.startOffset + f.chunk.length < f.size) more = true;
    }
    await this.addImages(store, candidates);
    return { found: true, more };
  }

  private async readOlder(path: string, store: EditHistoryStore): Promise<boolean> {
    if (!store.backfillTruncated) return true;
    const requests: EditSourceRequest[] = [];
    for (const relPath of store.sourcesWithOlder()) {
      const range = store.olderRange(relPath, this.budget);
      if (range) requests.push({ relPath, offset: range.offset, len: range.len });
    }
    if (requests.length === 0) return true;
    const res = await this.deps.readSources(path, requests, this.budget);
    if (!res) return false;
    if (res.transcriptId !== store.getTranscriptId()) return true;
    const wanted = new Set(requests.map((r) => r.relPath));
    const candidates: ImageCandidate[] = [];
    for (const f of res.files) {
      if (!wanted.has(f.relPath)) continue;
      const r = store.applyOlder({
        transcriptId: res.transcriptId,
        source: f.relPath,
        startOffset: f.startOffset,
        chunk: f.chunk,
        size: f.size,
      });
      candidates.push(...r.candidates);
    }
    await this.addImages(store, candidates);
    return true;
  }

  private async addImages(store: EditHistoryStore, candidates: readonly ImageCandidate[]): Promise<void> {
    const paths = [...new Set(candidates.flatMap((c) => c.paths))];
    if (paths.length === 0) return;
    let probes: Array<PathProbe | null>;
    try {
      probes = await this.deps.probe(paths);
    } catch {
      // The edits of this read are in; only its images are lost. The read itself succeeded.
      return;
    }
    const byPath = new Map(paths.map((p, i) => [p, probes[i]]));
    const newest = new Map<string, number>();
    for (const e of store.list()) newest.set(e.path, Math.max(newest.get(e.path) ?? -Infinity, e.ts));
    store.addImageEntries(
      confirmImages(
        candidates,
        (p) => byPath.get(p),
        (p) => newest.get(p)
      )
    );
  }
}
