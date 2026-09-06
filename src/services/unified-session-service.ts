/**
 * @fileoverview Pure merge/filter logic for the unified session list (COD-121).
 *
 * Combines four read-only views of a session — live (in-memory `Session`),
 * persisted (`state.json`), transcript history, and the lifecycle audit log —
 * plus mux process stats, into one de-duplicated list keyed by sessionId.
 *
 * Transcript history is not one source but three, because the CLIs keep their
 * conversations in their own stores: Claude's `~/.claude/projects`, omp's
 * `~/.omp/agent/sessions` and codex's `~/.codex/sessions`. Each row is keyed by
 * whatever id that CLI names the conversation with, which diverges from the
 * Codeman id for a resumed session and for every non-Claude one — an alias map
 * (claudeSessionId → Codeman id, built from the live/persisted views) folds them
 * into the owning session item.
 * Higher-precedence sources overwrite scalar fields when present
 * (history < lifecycle < persisted < live), while the `sources` array
 * always accumulates every contributing view. A "meaningfulness floor" drops
 * noise (bare lifecycle/mux-only rows with no name and no first prompt).
 *
 * PURE: no fs/IO and no node imports. All IO happens in the route that feeds
 * this module its inputs, which keeps the merge/sort/filter behavior unit-testable.
 */

export type UnifiedSessionItem = {
  sessionId: string;
  name?: string;
  mode?: string;
  status?: string;
  isWorking?: boolean;
  workingDir?: string;
  createdAt?: number;
  lastActivityAt?: number;
  claudeSessionId?: string;
  firstPrompt?: string;
  /** Most recent user prompt from the transcript (COD-145), parallel to firstPrompt. */
  lastPrompt?: string;
  sizeBytes?: number;
  projectKey?: string;
  /** Git branch recorded in the transcript (#266). */
  gitBranch?: string;
  /** Linked-worktree name, when the session ran in one (#266). */
  worktreeName?: string;
  /** Main repo root a worktree belongs to (#266). */
  worktreeRepo?: string;
  remote?: boolean;
  /**
   * Token this row's CLI resumes by, when that is not `sessionId`. Set only from
   * a transcript scanner — see the field of the same name on `HistoryInput`.
   */
  resumeId?: string;
  /** Pinned to the top of the session manager list (COD-139). */
  pinned?: boolean;
  /** When the session was pinned (epoch ms) — orders the pinned group desc. */
  pinnedAt?: number;
  sources: string[];
  stats?: { memoryMB: number; cpuPercent: number };
};

/** Live in-memory session view (subset of `Session.toState()`). */
export type LiveSessionInput = {
  id: string;
  name?: string;
  mode?: string;
  status?: string;
  isWorking?: boolean;
  workingDir?: string;
  createdAt?: number;
  lastActivityAt?: number;
  claudeSessionId?: string;
  pinned?: boolean;
  pinnedAt?: number;
};

/** Persisted session view (subset of `SessionState`). */
export type PersistedSessionInput = {
  id: string;
  name?: string;
  mode?: string;
  status?: string;
  workingDir?: string;
  createdAt?: number;
  lastActivityAt?: number;
  /** Claude conversation ID this session resumes (`SessionState.resumeSessionId`). */
  claudeSessionId?: string;
  pinned?: boolean;
  pinnedAt?: number;
};

/** Lifecycle audit-log view. Entries are expected NEWEST-first (the order `SessionLifecycleLog.query()` returns). */
export type LifecycleInput = {
  sessionId: string;
  name?: string;
  mode?: string;
  ts: number;
  event?: string;
};

/** Transcript-history view (one `.jsonl` per session). */
export type HistoryInput = {
  sessionId: string;
  workingDir: string;
  sizeBytes: number;
  lastModified: string;
  firstPrompt?: string;
  /** Most recent user prompt from the transcript (COD-145). */
  lastPrompt?: string;
  projectKey?: string;
  gitBranch?: string;
  worktreeName?: string;
  worktreeRepo?: string;
  /**
   * Set only by a non-claude transcript source (currently omp and codex); the
   * Claude scanner never stamps this; the meaningfulness floor below still
   * counts a row with a `mode` as real, since that also signals "not claude" —
   * see where it's read below for the isReal check this touches.
   */
  mode?: string;
  /**
   * The token this CLI's own resume command expects, when it is NOT the row's
   * `sessionId`. Codex names a thread by an id of its own that lives in the
   * rollout, and a live codex session's `sessionId` is Codeman's uuid instead —
   * so a resume that reused `sessionId` would ask codex for a thread that does
   * not exist. Only a transcript scanner sets this, which is what keeps the two
   * kinds of row apart.
   */
  resumeId?: string;
};

/** Mux process-stat view. */
export type MuxStatInput = {
  sessionId: string;
  muxName?: string;
  mode?: string;
  stats?: { memoryMB: number; cpuPercent: number };
  remote?: boolean;
};

export type UnifiedSources = {
  live?: LiveSessionInput[];
  persisted?: PersistedSessionInput[];
  lifecycle?: LifecycleInput[];
  history?: HistoryInput[];
  mux?: MuxStatInput[];
};

/** Push a source tag onto an item exactly once. */
function addSource(item: UnifiedSessionItem, source: string): void {
  if (!item.sources.includes(source)) item.sources.push(source);
}

/** Get-or-create the accumulator item for a sessionId. */
function ensureItem(map: Map<string, UnifiedSessionItem>, sessionId: string): UnifiedSessionItem {
  let item = map.get(sessionId);
  if (!item) {
    item = { sessionId, sources: [] };
    map.set(sessionId, item);
  }
  return item;
}

/** Overwrite a scalar field only when the incoming value is defined. */
function overwrite<K extends keyof UnifiedSessionItem>(
  item: UnifiedSessionItem,
  key: K,
  value: UnifiedSessionItem[K] | undefined
): void {
  if (value !== undefined) item[key] = value;
}

/**
 * Merge all source views into one list, applying precedence
 * (history → lifecycle → persisted → live) and the meaningfulness floor.
 */
export function mergeUnifiedSessions(sources: UnifiedSources): UnifiedSessionItem[] {
  const map = new Map<string, UnifiedSessionItem>();

  // Alias map: Claude conversation UUID → owning Codeman session id. Resumed
  // (claudeSessionId = resumeSessionId != id) and /clear-respawned sessions
  // would otherwise surface twice — once as a live/persisted row and once as a
  // separate history-only row keyed by the conversation UUID. Live wins over
  // persisted on conflicting entries (registered last).
  const aliasToOwner = new Map<string, string>();
  for (const p of sources.persisted ?? []) {
    if (p.claudeSessionId !== undefined && p.claudeSessionId !== p.id) aliasToOwner.set(p.claudeSessionId, p.id);
  }
  for (const v of sources.live ?? []) {
    if (v.claudeSessionId !== undefined && v.claudeSessionId !== v.id) aliasToOwner.set(v.claudeSessionId, v.id);
  }
  const resolveId = (sessionId: string): string => aliasToOwner.get(sessionId) ?? sessionId;

  // 1) history (lowest precedence; keys resolve through the alias map)
  for (const h of sources.history ?? []) {
    const item = ensureItem(map, resolveId(h.sessionId));
    addSource(item, 'history');
    overwrite(item, 'workingDir', h.workingDir);
    overwrite(item, 'sizeBytes', h.sizeBytes);
    overwrite(item, 'firstPrompt', h.firstPrompt);
    overwrite(item, 'lastPrompt', h.lastPrompt);
    overwrite(item, 'projectKey', h.projectKey);
    overwrite(item, 'gitBranch', h.gitBranch);
    overwrite(item, 'worktreeName', h.worktreeName);
    overwrite(item, 'worktreeRepo', h.worktreeRepo);
    // Claude rows never set this (they're implicitly claude); a non-claude
    // transcript source (currently only omp) does, so a history-only row
    // still gets a mode badge instead of reading as claude by default.
    overwrite(item, 'mode', h.mode);
    overwrite(item, 'resumeId', h.resumeId);
    const ms = Date.parse(h.lastModified);
    if (!Number.isNaN(ms) && item.lastActivityAt === undefined) item.lastActivityAt = ms;
  }

  // 2) lifecycle — entries arrive NEWEST-first, so first-seen wins for
  //    name/mode (mirrors the lastActivityAt guard); unconditional overwrites
  //    would leave the OLDEST entry in the window (stale name/mode) standing.
  for (const l of sources.lifecycle ?? []) {
    const item = ensureItem(map, resolveId(l.sessionId));
    addSource(item, 'lifecycle');
    if (item.name === undefined) overwrite(item, 'name', l.name);
    if (item.mode === undefined) overwrite(item, 'mode', l.mode);
    if (item.lastActivityAt === undefined && typeof l.ts === 'number') item.lastActivityAt = l.ts;
  }

  // 3) persisted
  for (const p of sources.persisted ?? []) {
    const item = ensureItem(map, p.id);
    addSource(item, 'persisted');
    overwrite(item, 'name', p.name);
    overwrite(item, 'mode', p.mode);
    overwrite(item, 'status', p.status);
    overwrite(item, 'workingDir', p.workingDir);
    overwrite(item, 'createdAt', p.createdAt);
    overwrite(item, 'lastActivityAt', p.lastActivityAt);
    overwrite(item, 'pinned', p.pinned);
    overwrite(item, 'pinnedAt', p.pinnedAt);
  }

  // 4) live (highest precedence)
  for (const v of sources.live ?? []) {
    const item = ensureItem(map, v.id);
    addSource(item, 'live');
    overwrite(item, 'name', v.name);
    overwrite(item, 'mode', v.mode);
    overwrite(item, 'status', v.status);
    overwrite(item, 'isWorking', v.isWorking);
    overwrite(item, 'workingDir', v.workingDir);
    overwrite(item, 'createdAt', v.createdAt);
    overwrite(item, 'lastActivityAt', v.lastActivityAt);
    overwrite(item, 'claudeSessionId', v.claudeSessionId);
    overwrite(item, 'pinned', v.pinned);
    overwrite(item, 'pinnedAt', v.pinnedAt);
  }

  // 5) mux stats + remote flag (create item if mux-only)
  for (const m of sources.mux ?? []) {
    const item = ensureItem(map, m.sessionId);
    addSource(item, 'mux');
    overwrite(item, 'mode', m.mode);
    if (m.stats) item.stats = m.stats;
    if (m.remote !== undefined) item.remote = m.remote;
  }

  // firstPrompt backfill (COD-140): the only source that sets firstPrompt is the
  // transcript-history view, keyed by the Claude transcript file's UUID. A live/persisted
  // row keyed by its Codeman id only inherits firstPrompt when that id happens to equal an
  // on-disk transcript UUID. When it doesn't (stale/wrong claudeSessionId, post-/clear new
  // uuid, resumed/attached/worktree session, transcript not yet flushed), the row shows
  // "(no prompt captured)" even though a real transcript for that working dir exists under a
  // different UUID. Backfill from the already-passed history: first try the claudeSessionId
  // join, then the newest transcript in the same workingDir. Never overwrite a non-empty
  // firstPrompt (so rows keyed to their own transcript are untouched).
  //
  // The workingDir guess is a last resort and MUST be skipped for any item that
  // already has its own 'history' entry (step 1 above already gave it a real,
  // direct scan of its own transcript). Without this guard, a history row whose
  // OWN extraction genuinely failed (oversized first message, etc.) silently
  // inherited the newest OTHER session's opening line from the same directory —
  // not a blank, but actively wrong: old sessions displayed today's conversation
  // as if it were their own. A row with no 'history' source at all (its
  // transcript hasn't been linked/scanned under its own id yet) has no such
  // direct attempt to prefer, so the guess remains a reasonable stand-in there.
  const firstPromptByUuid = new Map<string, string>();
  const firstPromptByWorkingDir = new Map<string, { prompt: string; ms: number }>();
  // COD-145: lastPrompt rides the same backfill (build parallel indexes; never overwrite).
  const lastPromptByUuid = new Map<string, string>();
  const lastPromptByWorkingDir = new Map<string, { prompt: string; ms: number }>();
  for (const h of sources.history ?? []) {
    const ms = Date.parse(h.lastModified);
    const ts = Number.isNaN(ms) ? -Infinity : ms;
    if (h.firstPrompt) {
      firstPromptByUuid.set(h.sessionId, h.firstPrompt);
      if (h.workingDir) {
        const existing = firstPromptByWorkingDir.get(h.workingDir);
        if (!existing || ts > existing.ms) {
          firstPromptByWorkingDir.set(h.workingDir, { prompt: h.firstPrompt, ms: ts });
        }
      }
    }
    if (h.lastPrompt) {
      lastPromptByUuid.set(h.sessionId, h.lastPrompt);
      if (h.workingDir) {
        const existing = lastPromptByWorkingDir.get(h.workingDir);
        if (!existing || ts > existing.ms) {
          lastPromptByWorkingDir.set(h.workingDir, { prompt: h.lastPrompt, ms: ts });
        }
      }
    }
  }
  for (const item of map.values()) {
    const hasOwnHistoryEntry = item.sources.includes('history');
    if (!item.firstPrompt) {
      // never overwrite an existing non-empty prompt
      const byUuid = item.claudeSessionId ? firstPromptByUuid.get(item.claudeSessionId) : undefined;
      if (byUuid) {
        item.firstPrompt = byUuid;
      } else if (item.workingDir && !hasOwnHistoryEntry) {
        const byDir = firstPromptByWorkingDir.get(item.workingDir);
        if (byDir) item.firstPrompt = byDir.prompt;
      }
    }
    if (!item.lastPrompt) {
      const byUuid = item.claudeSessionId ? lastPromptByUuid.get(item.claudeSessionId) : undefined;
      if (byUuid) {
        item.lastPrompt = byUuid;
      } else if (item.workingDir && !hasOwnHistoryEntry) {
        const byDir = lastPromptByWorkingDir.get(item.workingDir);
        if (byDir) item.lastPrompt = byDir.prompt;
      }
    }
  }

  // Meaningfulness floor: keep real rows, drop bare lifecycle/mux-only noise.
  const kept: UnifiedSessionItem[] = [];
  for (const item of map.values()) {
    const isReal =
      item.sources.includes('live') ||
      item.sources.includes('persisted') ||
      item.sources.includes('history') ||
      (item.firstPrompt !== undefined && item.firstPrompt !== '');
    if (isReal) kept.push(item);
  }

  // Stable sort (COD-139): pinned group first (pinnedAt desc, most-recently-pinned
  // first), then unpinned by lastActivityAt desc (undefined last), createdAt desc,
  // sessionId asc.
  kept.sort((a, b) => {
    const pa = a.pinned === true;
    const pb = b.pinned === true;
    if (pa !== pb) return pa ? -1 : 1; // pinned floats above unpinned
    if (pa && pb) {
      // Both pinned: most-recently-pinned first (undefined pinnedAt sorts last).
      const ta = a.pinnedAt;
      const tb = b.pinnedAt;
      if (ta !== tb) {
        if (ta === undefined) return 1;
        if (tb === undefined) return -1;
        return tb - ta;
      }
      // tie-break falls through to the activity/createdAt/id rules below.
    }
    const la = a.lastActivityAt;
    const lb = b.lastActivityAt;
    if (la !== lb) {
      if (la === undefined) return 1;
      if (lb === undefined) return -1;
      return lb - la;
    }
    const ca = a.createdAt;
    const cb = b.createdAt;
    if (ca !== cb) {
      if (ca === undefined) return 1;
      if (cb === undefined) return -1;
      return cb - ca;
    }
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  return kept;
}

/**
 * Case-insensitive substring filter (name + firstPrompt + lastPrompt + workingDir + sessionId)
 * with offset/limit paging. `total` is the filtered count BEFORE paging.
 */
export function filterAndPaginate(
  items: UnifiedSessionItem[],
  opts: { q?: string; offset?: number; limit?: number }
): { sessions: UnifiedSessionItem[]; total: number } {
  const q = (opts.q ?? '').trim().toLowerCase();
  const filtered = q
    ? items.filter((it) => {
        const hay = [it.name, it.firstPrompt, it.lastPrompt, it.workingDir, it.sessionId, it.worktreeName, it.gitBranch]
          .filter((v): v is string => typeof v === 'string')
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
    : items;

  const total = filtered.length;
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)));
  const sessions = filtered.slice(offset, offset + limit);
  return { sessions, total };
}
