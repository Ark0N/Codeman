/**
 * @fileoverview Pure state, classification and grouping for the TUI dashboard.
 *
 * Classification speaks the web UI's language on purpose (red blocked, yellow
 * waiting, green working, muted idle), because a user who has both surfaces
 * open must never have to translate between them. The inputs are the ones the
 * server already computes: a unified-list row and, when the session is blocked,
 * the approvals-inbox item that blocks it. Nothing here screen-scrapes.
 *
 * Selection is tracked by session id, never by row index: rows re-sort under
 * the cursor constantly (a session starts working, an approval lands), and an
 * index-tracked cursor would silently move the selection to a different
 * session between two keystrokes.
 *
 * PURE: no IO, no timers, no `process.*`. The store mutates its own state and
 * nothing else.
 *
 * @module tui/tui-model
 */

import type { SearchResultGroup, SearchSourceType } from '../types/search.js';
import type { ApprovalItem } from '../web/approval-inbox.js';
import type {
  TuiConfirmState,
  TuiConnectionStatus,
  TuiDigestState,
  TuiGroup,
  TuiGroupKey,
  TuiHeaderInfo,
  TuiMessage,
  TuiPickerState,
  TuiPreview,
  TuiPromptState,
  TuiRenderModel,
  TuiRow,
  TuiSearchEntry,
  TuiSearchState,
  TuiSessionRow,
  TuiSessionState,
  TuiUiMode,
} from './tui-types.js';

/** How many history rows the RECENT group shows before it stops being a dashboard. */
export const DEFAULT_RECENT_LIMIT = 8;

export const GROUP_ORDER: readonly TuiGroupKey[] = ['needs-you', 'working', 'idle', 'recent'];

export const GROUP_LABELS: Record<TuiGroupKey, string> = {
  'needs-you': 'NEEDS YOU',
  working: 'WORKING',
  idle: 'IDLE',
  recent: 'RECENT',
};

const STATE_GROUP: Record<TuiSessionState, TuiGroupKey> = {
  'blocked-question': 'needs-you',
  'blocked-permission': 'needs-you',
  waiting: 'needs-you',
  working: 'working',
  idle: 'idle',
  recent: 'recent',
};

/** A row is live when the unified merge saw it in the in-memory session map. */
export function isLiveRow(session: TuiSessionRow): boolean {
  return Array.isArray(session.sources) && session.sources.includes('live');
}

/**
 * Classify one row.
 *
 * Order matters and mirrors `_mobileOverviewState()` in the web UI: a pending
 * prompt outranks everything (it is literally blocking the agent), and it
 * outranks a stale `busy` status because the hook is the newer signal. An
 * errored session has no state of its own here and joins the waiting tier,
 * since it is equally something only a human can clear.
 *
 * ⚠️ An ACKNOWLEDGED item no longer decides the row. `acknowledgedAt` means the
 * alert this prompt armed has been spent, either because somebody opened the
 * session on another device or because the inbox opened the item that way for a
 * session watching its own background work. The item itself stays pending and
 * answerable, so the row keeps carrying it and the approval card still renders;
 * it simply stops dragging the session into NEEDS YOU. The web has honoured
 * that since acknowledgement existed (`approvals-ui.js` clears the pending hook
 * that `_mobileOverviewState` reads), and this gate is where the TUI had been
 * reading past it: acknowledging on a phone cleared the alert everywhere except
 * here. Only `idle` can be acknowledged, so a permission or question dialog is
 * unaffected by construction, and both are checked ahead of the flag anyway.
 */
export function classifySession(session: TuiSessionRow, approval?: ApprovalItem): TuiSessionState {
  if (!isLiveRow(session)) return 'recent';
  if (approval) {
    if (approval.kind === 'permission') return 'blocked-permission';
    if (approval.kind === 'question') return 'blocked-question';
    if (!approval.acknowledgedAt) return 'waiting';
  }
  if (session.status === 'error') return 'waiting';
  if (session.isWorking === true || session.status === 'busy') return 'working';
  return 'idle';
}

/**
 * Epoch ms the session entered its current state, which is what the intra-group
 * ordering sorts on. 0 when nothing usable is known.
 *
 * A WORKING pane repaints about once a second, so its `lastActivityAt` is
 * always "now" and would report every running turn as freshly started; the
 * turn's own start is the pane's last Enter.
 */
export function stateSince(state: TuiSessionState, session: TuiSessionRow, approval?: ApprovalItem): number {
  // The prompt's own age measures the state only while the prompt is what put the
  // row in that state. An acknowledged item still rides along on a row that is
  // plainly idle or working, and dating such a row from it would report how long
  // ago the prompt arrived as though it were how long the session has been quiet.
  if (approval && STATE_GROUP[state] === 'needs-you') return approval.createdAt;
  if (state === 'working') return session.lastSubmitAt ?? session.createdAt ?? 0;
  return session.lastActivityAt ?? session.createdAt ?? 0;
}

/** Classify a batch of rows against the pending approvals, keyed by session id. */
export function buildRows(
  sessions: readonly TuiSessionRow[],
  approvals: ReadonlyMap<string, ApprovalItem> = new Map()
): TuiRow[] {
  return sessions.map((session) => {
    const approval = approvals.get(session.sessionId);
    const state = classifySession(session, approval);
    const row: TuiRow = {
      session,
      state,
      group: STATE_GROUP[state],
      since: stateSince(state, session, approval),
    };
    if (approval) row.approval = approval;
    return row;
  });
}

function compareIds(a: TuiRow, b: TuiRow): number {
  if (a.session.sessionId < b.session.sessionId) return -1;
  if (a.session.sessionId > b.session.sessionId) return 1;
  return 0;
}

/** Longest first: the oldest anchor wins, and an unknown anchor sorts last. */
function compareLongestFirst(a: TuiRow, b: TuiRow): number {
  const left = a.since || Number.MAX_SAFE_INTEGER;
  const right = b.since || Number.MAX_SAFE_INTEGER;
  return left !== right ? left - right : compareIds(a, b);
}

/** Newest first: the freshest anchor wins, and an unknown anchor sorts last. */
function compareNewestFirst(a: TuiRow, b: TuiRow): number {
  const left = a.since || 0;
  const right = b.since || 0;
  return left !== right ? right - left : compareIds(a, b);
}

export interface GroupOptions {
  /** RECENT is a tail, not a list: everything past this is dropped. */
  recentLimit?: number;
}

/**
 * Split classified rows into the four display groups.
 *
 * Always returns all four in display order (empty ones included) so callers
 * never have to guess the shape; the renderer skips the empty ones.
 *
 * NEEDS YOU and WORKING are ordered by how long they have been in that state
 * (longest first: the thing that has waited longest for you is the thing to
 * look at). IDLE and RECENT are ordered by recency, newest first.
 */
export function groupSessions(rows: readonly TuiRow[], options: GroupOptions = {}): TuiGroup[] {
  const recentLimit = Math.max(0, Math.floor(options.recentLimit ?? DEFAULT_RECENT_LIMIT));
  const buckets: Record<TuiGroupKey, TuiRow[]> = {
    'needs-you': [],
    working: [],
    idle: [],
    recent: [],
  };
  for (const row of rows) buckets[row.group].push(row);

  buckets['needs-you'].sort(compareLongestFirst);
  buckets.working.sort(compareLongestFirst);
  buckets.idle.sort(compareNewestFirst);
  buckets.recent.sort(compareNewestFirst);
  buckets.recent = buckets.recent.slice(0, recentLimit);

  return GROUP_ORDER.map((key) => ({ key, label: GROUP_LABELS[key], rows: buckets[key] }));
}

/** The cursor's list: group headers are chrome, only sessions are selectable. */
export function flattenRows(groups: readonly TuiGroup[]): TuiRow[] {
  const rows: TuiRow[] = [];
  for (const group of groups) rows.push(...group.rows);
  return rows;
}

/**
 * Fold an incoming row into a known one. Defined fields win, `undefined` never
 * clobbers (a live SSE payload carries no transcript fields, a unified refresh
 * carries no token counters), but a non-empty `sources` list REPLACES rather
 * than unions: a session that ended must be able to lose its `live` source and
 * fall to RECENT.
 */
export function mergeSessionRow(existing: TuiSessionRow, incoming: TuiSessionRow): TuiSessionRow {
  const merged: TuiSessionRow = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.sources = incoming.sources?.length ? [...incoming.sources] : [...(existing.sources ?? [])];
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search results (pure)
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_GROUP_LABELS: Record<SearchSourceType, string> = {
  session: 'SESSIONS',
  event: 'EVENTS',
  file: 'FILES',
};

/**
 * A session snippet opens with the session's own name, which the row already
 * shows in its first column (`search-service.ts` builds it as
 * `w1-alpha <em dash> /tmp/alpha`, hence the separator in the pattern).
 * Dropping the repeat is what keeps a result row from reading as a stutter.
 */
function withoutLabelPrefix(snippet: string, label: string): string {
  const rest = snippet.startsWith(label) ? snippet.slice(label.length) : snippet;
  return rest === snippet ? snippet : rest.replace(/^\s*(?:[—:-]\s*)?/, '');
}

/**
 * Flatten `GET /api/search`'s typed groups into the overlay's lines: a header
 * per group, then its results. Only a result row carries a session id, which is
 * what the cursor uses to skip headers.
 *
 * `isLive` decides which rows can hand the dashboard a session: a history hit
 * has a session id too, but selecting it would move the cursor to a row that is
 * not on the list.
 */
export function buildSearchEntries(
  groups: readonly SearchResultGroup[],
  isLive: (sessionId: string) => boolean
): TuiSearchEntry[] {
  const entries: TuiSearchEntry[] = [];
  for (const group of groups) {
    if (group.results.length === 0) continue;
    entries.push({ kind: 'header', text: SEARCH_GROUP_LABELS[group.type] ?? group.type.toUpperCase() });
    for (const result of group.results) {
      const live = result.jumpTo.kind === 'session' && isLive(result.sessionId);
      const label = result.jumpTo.relativePath ?? result.sessionName ?? result.sessionId.slice(0, 8);
      entries.push({
        kind: 'result',
        text: label,
        detail: withoutLabelPrefix(result.snippet, label),
        sessionId: result.sessionId,
        live,
      });
    }
  }
  return entries;
}

/** First selectable row, or -1 when the list is all headers (or empty). */
export function firstSearchIndex(entries: readonly TuiSearchEntry[]): number {
  return entries.findIndex((entry) => entry.kind === 'result');
}

/**
 * Move the search cursor by `delta` result rows, skipping headers and stopping
 * at both ends (wrapping a search result list scrolls past the answer the user
 * was reading).
 */
export function moveSearchIndex(entries: readonly TuiSearchEntry[], index: number, delta: number): number {
  const step = Math.trunc(delta);
  if (step === 0) return index;
  const direction = step > 0 ? 1 : -1;
  let current = index;
  for (let remaining = Math.abs(step); remaining > 0; remaining--) {
    let next = current + direction;
    while (next >= 0 && next < entries.length && entries[next].kind !== 'result') next += direction;
    if (next < 0 || next >= entries.length) break;
    current = next;
  }
  return current;
}

/**
 * The dashboard's state. Update methods mutate in place (one store per TUI
 * process, no subscribers) and every derived view is recomputed from scratch,
 * which keeps "what is on screen" a pure function of the stored facts.
 */
export class TuiModelStore implements TuiRenderModel {
  private sessionsById = new Map<string, TuiSessionRow>();
  private approvalsBySession = new Map<string, ApprovalItem>();
  private _revision = 0;

  selectedId: string | null = null;
  connection: TuiConnectionStatus = 'connected';
  mode: TuiUiMode = 'list';
  header: TuiHeaderInfo = {};
  preview: TuiPreview | null = null;
  message: TuiMessage | null = null;
  confirm: TuiConfirmState | null = null;
  picker: TuiPickerState | null = null;
  prompt: TuiPromptState | null = null;
  search: TuiSearchState | null = null;
  digest: TuiDigestState | null = null;
  recentLimit: number;

  constructor(options: GroupOptions = {}) {
    this.recentLimit = Math.max(0, Math.floor(options.recentLimit ?? DEFAULT_RECENT_LIMIT));
  }

  /**
   * Bumped by every mutating method. The app layer repaints when this changed
   * (plus on resize and on the animation tick), which is what keeps an idle
   * dashboard from redrawing itself. Writing a public field directly bypasses
   * it, so state changes go through the methods below.
   */
  get revision(): number {
    return this._revision;
  }

  private touch(): void {
    this._revision++;
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  upsertSession(session: TuiSessionRow): void {
    this.mutate(() => {
      const existing = this.sessionsById.get(session.sessionId);
      this.sessionsById.set(session.sessionId, existing ? mergeSessionRow(existing, session) : { ...session });
    });
  }

  removeSession(sessionId: string): void {
    this.mutate(() => {
      this.sessionsById.delete(sessionId);
      this.approvalsBySession.delete(sessionId);
    });
  }

  /** Full refresh (a `GET /api/sessions/unified` poll): the server is authoritative. */
  replaceSessions(sessions: readonly TuiSessionRow[]): void {
    this.mutate(() => {
      this.sessionsById.clear();
      for (const session of sessions) this.sessionsById.set(session.sessionId, { ...session });
    });
  }

  setApprovals(items: readonly ApprovalItem[]): void {
    this.mutate(() => {
      this.approvalsBySession.clear();
      // One active item per session is an inbox invariant; the newest wins if
      // that ever stops being true.
      for (const item of items) this.approvalsBySession.set(item.sessionId, item);
    });
  }

  sessions(): TuiSessionRow[] {
    return [...this.sessionsById.values()];
  }

  // ── Chrome ─────────────────────────────────────────────────────────────────

  setConnection(status: TuiConnectionStatus): void {
    if (this.connection === status) return;
    this.connection = status;
    this.touch();
  }

  setHeader(header: TuiHeaderInfo): void {
    this.header = { ...this.header, ...header };
    this.touch();
  }

  setPreview(preview: TuiPreview | null): void {
    this.preview = preview;
    this.touch();
  }

  setMode(mode: TuiUiMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.touch();
  }

  setMessage(message: TuiMessage | null): void {
    this.message = message;
    this.mode = message ? 'message' : 'list';
    this.touch();
  }

  /** Show (or clear) the overlay chooser. Setting one takes the keyboard. */
  setPicker(picker: TuiPickerState | null): void {
    this.picker = picker;
    this.mode = picker ? 'new-session' : 'list';
    this.touch();
  }

  /** Open (or close) the one-line prompt composer. Setting one takes the keyboard. */
  setPrompt(prompt: TuiPromptState | null): void {
    this.prompt = prompt;
    this.mode = prompt ? 'prompt' : 'list';
    this.touch();
  }

  /** Replace the composer's editor state, keeping the target session. */
  updatePrompt(composer: TuiPromptState['composer']): void {
    if (!this.prompt || this.prompt.composer === composer) return;
    this.prompt = { ...this.prompt, composer };
    this.touch();
  }

  setSearch(search: TuiSearchState | null): void {
    this.search = search;
    this.mode = search ? 'search' : 'list';
    this.touch();
  }

  /** Fold a partial update into the open search overlay. No-op when it is closed. */
  updateSearch(patch: Partial<TuiSearchState>): void {
    if (!this.search) return;
    this.search = { ...this.search, ...patch };
    this.touch();
  }

  setDigest(digest: TuiDigestState | null): void {
    this.digest = digest;
    this.mode = digest ? 'digest' : 'list';
    this.touch();
  }

  /**
   * Scroll the digest by `delta` lines. `capacity` is how many lines the box
   * shows, so the last page cannot scroll into empty space.
   */
  scrollDigest(delta: number, capacity: number): void {
    if (!this.digest) return;
    const room = Math.max(0, this.digest.lines.length - Math.max(1, Math.trunc(capacity)));
    const offset = Math.min(Math.max(0, this.digest.offset + Math.trunc(delta)), room);
    if (offset === this.digest.offset) return;
    this.digest = { ...this.digest, offset };
    this.touch();
  }

  /**
   * Arm the typed-name confirmation for `x` (kill). Whether what the user typed
   * AUTHORIZES the kill is `confirmAccepts()` in tui-app, which owns that rule
   * for every caller: a second copy here answered the same question differently
   * (it refused the id prefix a mux name carries) and nothing consulted it.
   */
  beginConfirmKill(row: TuiRow, label: string): void {
    this.confirm = {
      sessionId: row.session.sessionId,
      // ⚠️ Passed in, not derived here. `row.session.name ?? id.slice(0,8)`
      // used to compute it, and `??` falls back only on null/undefined: a
      // session whose name is the EMPTY STRING (every session the server did
      // not name) sailed through it and the dialog read "Kill ?". A destructive
      // prompt that cannot say what it is about to destroy is worse than no
      // prompt, and it is now one keystroke. The caller passes the same label
      // the LIST shows, so the dialog names the row the user is looking at.
      name: label,
    };
    this.mode = 'confirm-kill';
    this.touch();
  }

  /** Drop whatever overlay owns the keyboard and go back to the list. */
  closeOverlay(): void {
    this.confirm = null;
    this.message = null;
    this.picker = null;
    this.prompt = null;
    this.search = null;
    this.digest = null;
    this.mode = 'list';
    this.touch();
  }

  // ── Derived views ──────────────────────────────────────────────────────────

  groups(): TuiGroup[] {
    return groupSessions(buildRows(this.sessions(), this.approvalsBySession), { recentLimit: this.recentLimit });
  }

  rows(): TuiRow[] {
    return flattenRows(this.groups());
  }

  get sessionCount(): number {
    let count = 0;
    for (const session of this.sessionsById.values()) if (isLiveRow(session)) count++;
    return count;
  }

  // ── Cursor ─────────────────────────────────────────────────────────────────

  selectedSession(): TuiRow | null {
    if (!this.selectedId) return null;
    return this.rows().find((row) => row.session.sessionId === this.selectedId) ?? null;
  }

  /** Select a session by id. Returns false when it is not on screen. */
  select(sessionId: string): boolean {
    if (!this.rows().some((row) => row.session.sessionId === sessionId)) return false;
    this.moveTo(sessionId);
    return true;
  }

  /** Move by `delta` rows, skipping group headers and wrapping at both ends. */
  moveCursor(delta: number): void {
    const rows = this.rows();
    if (rows.length === 0) {
      this.moveTo(null);
      return;
    }
    const current = this.indexOfSelected(rows);
    if (current < 0) {
      this.moveTo(rows[delta >= 0 ? 0 : rows.length - 1].session.sessionId);
      return;
    }
    const step = Math.trunc(delta);
    const next = (((current + step) % rows.length) + rows.length) % rows.length;
    this.moveTo(rows[next].session.sessionId);
  }

  /** The 1-9 jump: `n` is the 1-based position in the flattened list. */
  cursorToIndex(n: number): boolean {
    const rows = this.rows();
    const index = Math.trunc(n) - 1;
    if (index < 0 || index >= rows.length) return false;
    this.moveTo(rows[index].session.sessionId);
    return true;
  }

  private moveTo(sessionId: string | null): void {
    if (this.selectedId === sessionId) return;
    this.selectedId = sessionId;
    this.touch();
  }

  private indexOfSelected(rows: readonly TuiRow[] = this.rows()): number {
    if (!this.selectedId) return -1;
    return rows.findIndex((row) => row.session.sessionId === this.selectedId);
  }

  /**
   * Run a data mutation and keep the cursor sane afterwards: the selected
   * session stays selected wherever it moved to, and a session that vanished
   * hands the cursor to whatever now occupies its place.
   */
  private mutate(apply: () => void): void {
    const previousIndex = this.indexOfSelected();
    apply();
    this.touch();
    const rows = this.rows();
    if (rows.length === 0) {
      this.moveTo(null);
      return;
    }
    if (this.selectedId !== null && rows.some((row) => row.session.sessionId === this.selectedId)) return;
    const index = Math.min(Math.max(previousIndex, 0), rows.length - 1);
    this.moveTo(rows[index].session.sessionId);
  }
}

export function createTuiModel(options: GroupOptions = {}): TuiModelStore {
  return new TuiModelStore(options);
}
