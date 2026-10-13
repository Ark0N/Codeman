/**
 * @fileoverview Owner-scoped authoritative tab-layout coordination.
 *
 * This is the single mutation boundary between the pure layout model, persisted
 * state, live sessions, saved webviews, and SSE. Lifecycle callers describe one
 * completed server action; this service performs at most one versioned write.
 */
import type { StateStore } from './state-store.js';
import { mergeSessionOrder, normalizeSessionOrder } from './session-order.js';
import { applyLegacySessionRank, recomposeGlobalSessionOrder } from './tab-layout-legacy-order.js';
import {
  flattenOwnerSessionOrder,
  materializeOrphans,
  moveRef,
  normalizeTabLayout,
  setManualPlacement,
  TabLayoutValidationError,
  validateTabLayout,
  type TabLayout,
  type TabRef,
  type TabRefMetadata,
} from './tab-layout.js';
import {
  normalizeOrMigrateOwnerTabLayout,
  SINGLE_USER_LAYOUT_OWNER,
  type TabLayoutSessionRecord,
  type TabLayoutWebviewRecord,
} from './tab-layout-persistence.js';
import { SseEvent } from './web/sse-events.js';

export interface TabLayoutSessionLike {
  id: string;
  owner?: string;
  createdAt: number;
  parentSessionId?: string;
}

interface TabLayoutServiceDeps {
  store: Pick<
    StateStore,
    'getTabLayout' | 'getTabLayouts' | 'getSessions' | 'getSessionOrder' | 'commitTabLayoutProjection'
  >;
  sessions: ReadonlyMap<string, TabLayoutSessionLike>;
  readWebviews(): Promise<readonly TabLayoutWebviewRecord[]>;
  broadcast(event: string, data: unknown): void;
  broadcastSessionOrder(change: SessionOrderProjectionChange): void;
  /**
   * The synced `spawnedTabsFollowParent` setting, read at every creation. Off (or
   * absent), a spawned session lands after its parent once and is hand-placed
   * from then on; on, it keeps following its parent until moved by hand.
   */
  childrenFollowParent?(): boolean | Promise<boolean>;
  now?: () => string;
}

export type TabLayoutPutResult = { status: 'updated'; layout: TabLayout } | { status: 'conflict'; layout: TabLayout };

export interface LegacyOrderActor {
  owner: string;
  isAdmin: boolean;
}

export interface SessionOrderProjectionChange {
  changedOwnerOrders: Record<string, string[]>;
  globalOrder: string[];
  globalChanged: boolean;
}

export interface LegacyOrderPutResult extends SessionOrderProjectionChange {
  order: string[];
}

export interface RemovedTabLayoutSession {
  id: string;
  owner?: string;
}

/** Where a newly created session asked to be placed. Advisory: an unknown group is ignored. */
export interface SessionPlacementHint {
  tabGroupId?: string;
}

/**
 * Adds the created session to the live map. Runs INSIDE the owner lock, so no
 * other layout mutation can observe (and commit) the session first; the returned
 * function undoes it when the layout write fails.
 */
export type RegisterCreatedSession = () => void | (() => void);

interface PreparedOwnerLayout {
  current: TabLayout | null;
  authoritative: TabLayout;
  metadata: TabRefMetadata[];
  needsReconciliationCommit: boolean;
}

interface OwnerProjectionPublication {
  owner: string;
  previous: TabLayout | null;
  next: TabLayout;
  metadata: readonly TabRefMetadata[];
  excludedSessionIds?: ReadonlySet<string>;
}

interface PreparedOrderProjection {
  owner: string;
  previousOrder: string[];
  authoritativeBeforeIds: string[];
  excludedIds: string[];
  currentIds: string[];
  order: string[];
}

const ownerOf = (record: { owner?: string }): string => record.owner ?? SINGLE_USER_LAYOUT_OWNER;
const refKey = (ref: Pick<TabRef, 'kind' | 'id'>): string => `${ref.kind}\u0000${ref.id}`;
const sameLayout = (a: TabLayout, b: TabLayout): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Hand-place a just-created child where normalization put it (right after its
 * parent), so it stops following. A session that does not follow anything is
 * left alone.
 */
function pinCreatedChild(layout: TabLayout, sessionId: string, metadata: readonly TabRefMetadata[]): TabLayout {
  const item = metadata.find((fact) => fact.kind === 'session' && fact.id === sessionId);
  const parentId = item?.parentSessionId;
  if (!item?.ownerValid || !parentId) return layout;
  const refs = [...layout.groups.flatMap((group) => group.refs), ...layout.ungrouped];
  const ref = refs.find((candidate) => candidate.kind === 'session' && candidate.id === sessionId);
  const parentStored = refs.some((candidate) => candidate.kind === 'session' && candidate.id === parentId);
  const parentValid = metadata.some((fact) => fact.kind === 'session' && fact.id === parentId && fact.ownerValid);
  if (!ref || ref.placement === 'manual' || !parentStored || !parentValid) return layout;
  return setManualPlacement(layout, ref, true);
}

/** Move a just-created session to the end of `groupId`, or leave the layout alone. */
function placeCreatedSession(
  layout: TabLayout,
  sessionId: string,
  groupId: string,
  metadata: readonly TabRefMetadata[]
): TabLayout {
  const group = layout.groups.find((candidate) => candidate.id === groupId);
  if (!group) return layout;
  const index = group.refs.filter((ref) => ref.kind !== 'session' || ref.id !== sessionId).length;
  try {
    return moveRef(layout, { kind: 'session', id: sessionId }, { groupId, index }, metadata);
  } catch (error) {
    // Not an owner-valid ref of this layout: the hint does not apply.
    if (error instanceof TabLayoutValidationError) return layout;
    throw error;
  }
}

export class TabLayoutService {
  private restorationState: 'pending' | 'complete' | 'failed' | 'skipped' = 'pending';
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(private readonly deps: TabLayoutServiceDeps) {}

  private async withOwner<T>(owner: string, task: () => Promise<T>): Promise<T> {
    const previous = this.ownerQueues.get(owner) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.ownerQueues.set(owner, tail);
    try {
      return await run;
    } finally {
      if (this.ownerQueues.get(owner) === tail) this.ownerQueues.delete(owner);
    }
  }

  /** Acquire multiple owner queues in stable order so overlapping bulk cleanups cannot deadlock. */
  private async withOwners<T>(owners: readonly string[], task: () => Promise<T>, index = 0): Promise<T> {
    if (index >= owners.length) return task();
    return this.withOwner(owners[index], () => this.withOwners(owners, task, index + 1));
  }

  markRestorationComplete(): void {
    this.restorationState = 'complete';
  }

  markRestorationFailed(): void {
    this.restorationState = 'failed';
  }

  markRestorationSkipped(): void {
    this.restorationState = 'skipped';
  }

  assertDeletionReady(): void {
    if (this.restorationState === 'complete' || this.restorationState === 'skipped') return;
    throw new Error(`Tab layout restoration is ${this.restorationState}; destructive deletion is unavailable`);
  }

  /** Repair/migrate every owner visible after startup restoration. */
  async reconcileAfterRestoration(): Promise<void> {
    if (this.restorationState !== 'complete') return;
    const { persisted, live } = this.sessionRecords();
    const webviews = await this.deps.readWebviews();
    const owners = new Set<string>();
    for (const record of [...persisted, ...live, ...webviews]) owners.add(ownerOf(record));
    for (const owner of owners) await this.get(owner);
  }

  private sessionRecords(): { persisted: TabLayoutSessionRecord[]; live: TabLayoutSessionRecord[] } {
    const persisted = Object.entries(this.deps.store.getSessions()).map(([id, record]) => ({
      id,
      owner: record.owner,
      createdAt: record.createdAt,
      parentSessionId: record.parentSessionId,
    }));
    const live = [...this.deps.sessions.values()].map((record) => ({
      id: record.id,
      owner: record.owner,
      createdAt: record.createdAt,
      parentSessionId: record.parentSessionId,
    }));
    return { persisted, live };
  }

  private async facts(owner: string): Promise<{
    persisted: TabLayoutSessionRecord[];
    live: TabLayoutSessionRecord[];
    webviews: readonly TabLayoutWebviewRecord[];
    metadata: TabRefMetadata[];
  }> {
    const { persisted, live } = this.sessionRecords();
    const webviews = await this.deps.readWebviews();
    const sessions = new Map<string, TabLayoutSessionRecord>();
    for (const record of persisted) sessions.set(record.id, record);
    for (const record of live) sessions.set(record.id, record);
    const ownedSessions = [...sessions.values()]
      .filter((record) => ownerOf(record) === owner)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sessionOrder = new Map(ownedSessions.map((record, index) => [record.id, index]));
    const metadata: TabRefMetadata[] = [...sessions.values()].map((record) => ({
      kind: 'session',
      id: record.id,
      ownerValid: ownerOf(record) === owner,
      visible: true,
      order: sessionOrder.get(record.id) ?? record.createdAt,
      parentSessionId: record.parentSessionId,
    }));
    const offset = ownedSessions.length;
    webviews.forEach((record, index) =>
      metadata.push({
        kind: 'webview',
        id: record.id,
        ownerValid: ownerOf(record) === owner,
        visible: true,
        order: offset + index,
      })
    );
    return { persisted, live, webviews, metadata };
  }

  private prepareCommit(base: TabLayout, next: TabLayout): TabLayout {
    return validateTabLayout({
      ...next,
      version: base.version + 1,
      updatedAt: (this.deps.now ?? (() => new Date().toISOString()))(),
    });
  }

  private prepareOrderProjection(item: OwnerProjectionPublication): PreparedOrderProjection {
    const excluded = item.excludedSessionIds ?? new Set<string>();
    const authoritativeBeforeIds = item.metadata
      .filter((fact) => fact.kind === 'session' && fact.ownerValid && fact.visible)
      .map((fact) => fact.id);
    const facts = authoritativeBeforeIds.filter((id) => !excluded.has(id));
    const visible = new Set(facts);
    const rawPrevious = item.previous ? flattenOwnerSessionOrder(item.previous) : [];
    const rawNext = flattenOwnerSessionOrder(item.next);
    const previousOrder = rawPrevious.filter((id) => visible.has(id) || excluded.has(id));
    const order = rawNext.filter((id) => visible.has(id) && !excluded.has(id));
    const excludedIds = normalizeSessionOrder([...excluded]);
    return {
      owner: item.owner,
      previousOrder,
      authoritativeBeforeIds: normalizeSessionOrder([...authoritativeBeforeIds, ...excluded]),
      excludedIds,
      currentIds: normalizeSessionOrder([...order, ...facts]),
      order,
    };
  }

  private projectOrder(
    latest: readonly string[],
    projections: readonly PreparedOrderProjection[],
    preferred?: readonly string[]
  ): string[] {
    const before = normalizeSessionOrder(latest);
    const removed = new Set(
      projections.flatMap((projection) => projection.excludedIds.filter((id) => !projection.currentIds.includes(id)))
    );
    return recomposeGlobalSessionOrder(
      before.filter((id) => !removed.has(id)),
      projections.map((projection) => ({
        owner: projection.owner,
        ownedIds: projection.currentIds,
        order: projection.order,
      })),
      preferred
    );
  }

  private publish(
    layouts: Readonly<Record<string, TabLayout>>,
    publications: readonly OwnerProjectionPublication[],
    preferred?: readonly string[]
  ): SessionOrderProjectionChange {
    const projections = publications.map((item) => this.prepareOrderProjection(item));
    let beforeOrder: string[] = [];
    const accepted = this.deps.store.commitTabLayoutProjection(layouts, (latest) => {
      beforeOrder = normalizeSessionOrder(latest);
      return this.projectOrder(beforeOrder, projections, preferred);
    });
    const changedEntries: Array<[string, string[]]> = [];
    for (const projection of projections) {
      const beforeIds = new Set(projection.authoritativeBeforeIds);
      const currentIds = new Set(projection.currentIds);
      const persistedBefore = beforeOrder.filter((id) => beforeIds.has(id));
      const persistedAfter = accepted.sessionOrder.filter((id) => currentIds.has(id));
      const layoutOrderChanged = !sameOrder(projection.previousOrder, projection.order);
      const persistedOwnerSliceChanged = !sameOrder(persistedBefore, persistedAfter);
      if (layoutOrderChanged || persistedOwnerSliceChanged) {
        changedEntries.push([projection.owner, persistedAfter]);
      }
    }
    const change: SessionOrderProjectionChange = {
      changedOwnerOrders: Object.fromEntries(changedEntries),
      globalOrder: [...accepted.sessionOrder],
      globalChanged: !sameOrder(beforeOrder, accepted.sessionOrder),
    };
    for (const [owner, layout] of Object.entries(accepted.layouts)) {
      this.deps.broadcast(SseEvent.TabLayoutChanged, { owner, version: layout.version });
    }
    if (changedEntries.length > 0 || change.globalChanged) this.deps.broadcastSessionOrder(change);
    return change;
  }

  private commit(
    owner: string,
    base: TabLayout,
    next: TabLayout,
    metadata: readonly TabRefMetadata[],
    previous: TabLayout | null = base.version < 0 ? null : base
  ): TabLayout {
    const stored = this.prepareCommit(base, next);
    this.publish({ [owner]: stored }, [{ owner, previous, next: stored, metadata }]);
    return stored;
  }

  private async prepareUnlocked(owner: string): Promise<PreparedOwnerLayout> {
    const facts = await this.facts(owner);
    const current = this.deps.store.getTabLayout(owner);
    const authoritative = normalizeOrMigrateOwnerTabLayout({
      owner,
      layouts: current ? { [owner]: current } : undefined,
      sessionOrder: this.deps.store.getSessionOrder(),
      persistedSessions: facts.persisted,
      liveSessions: facts.live,
      webviews: facts.webviews,
      updatedAt: (this.deps.now ?? (() => new Date().toISOString()))(),
    }).layout;
    return {
      current,
      authoritative,
      metadata: facts.metadata,
      needsReconciliationCommit: !current || !sameLayout(current, authoritative),
    };
  }

  private async getUnlocked(
    owner: string,
    adjust?: (layout: TabLayout, metadata: readonly TabRefMetadata[]) => TabLayout
  ): Promise<TabLayout> {
    const prepared = await this.prepareUnlocked(owner);
    const next = adjust ? adjust(prepared.authoritative, prepared.metadata) : prepared.authoritative;
    if (!prepared.needsReconciliationCommit && sameLayout(next, prepared.authoritative)) {
      const publication = {
        owner,
        previous: prepared.current,
        next: prepared.authoritative,
        metadata: prepared.metadata,
      };
      const latest = this.deps.store.getSessionOrder();
      const projected = this.projectOrder(latest, [this.prepareOrderProjection(publication)]);
      if (!sameOrder(normalizeSessionOrder(latest), projected)) this.publish({}, [publication]);
      return prepared.authoritative;
    }
    const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
    return this.commit(owner, base, next, prepared.metadata, prepared.current);
  }

  async get(owner: string): Promise<TabLayout> {
    return this.withOwner(owner, () => this.getUnlocked(owner));
  }

  async put(owner: string, desired: unknown, baseVersion: number): Promise<TabLayoutPutResult> {
    return this.withOwner(owner, async () => {
      const prepared = await this.prepareUnlocked(owner);
      if (baseVersion !== prepared.authoritative.version) return { status: 'conflict', layout: prepared.authoritative };
      const validated = validateTabLayout(desired);
      const owned = new Set(prepared.metadata.filter((item) => item.ownerValid && item.visible).map(refKey));
      const refs = [...validated.groups.flatMap((group) => group.refs), ...validated.ungrouped];
      const invalid = refs.find((ref) => !owned.has(refKey(ref)));
      if (invalid)
        throw new TabLayoutValidationError(`ref is not owned by layout owner: ${invalid.kind}:${invalid.id}`);
      const normalized = normalizeTabLayout(
        { ...validated, version: prepared.authoritative.version },
        prepared.metadata
      );
      return {
        status: 'updated',
        layout: this.commit(owner, prepared.authoritative, normalized, prepared.metadata, prepared.current),
      };
    });
  }

  async putLegacyOrder(actor: LegacyOrderActor, requested: readonly string[]): Promise<LegacyOrderPutResult> {
    return actor.isAdmin ? this.putAdminLegacyOrder(requested) : this.putOwnerLegacyOrder(actor.owner, requested);
  }

  private async putOwnerLegacyOrder(owner: string, requested: readonly string[]): Promise<LegacyOrderPutResult> {
    return this.withOwner(owner, async () => {
      const prepared = await this.prepareUnlocked(owner);
      const normalized = normalizeSessionOrder(requested);
      const visible = new Set(
        prepared.metadata
          .filter((item) => item.kind === 'session' && item.ownerValid && item.visible)
          .map((item) => item.id)
      );
      // Unknown or foreign ids are DROPPED, never a 400: the browser debounces
      // its reorder push (and swallows errors), so a session deleted inside
      // that window would otherwise cost the user the whole reorder — and the
      // endpoint sits on the stable /api/v1 surface, where the pre-layout
      // server merged leniently. Same philosophy as resolveParentSessionId.
      const requestedVisible = normalized.filter((id) => visible.has(id));
      const currentKnown = flattenOwnerSessionOrder(prepared.authoritative).filter((id) => visible.has(id));
      const effective = mergeSessionOrder(requestedVisible, currentKnown);
      const ranked = applyLegacySessionRank(prepared.authoritative, effective, prepared.metadata);
      const needsLayout = prepared.needsReconciliationCommit || !sameLayout(prepared.authoritative, ranked);
      const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
      const next = needsLayout ? this.prepareCommit(base, ranked) : prepared.authoritative;
      const change = this.publish(needsLayout ? { [owner]: next } : {}, [
        { owner, previous: prepared.current, next, metadata: prepared.metadata },
      ]);
      return { order: flattenOwnerSessionOrder(next).filter((id) => visible.has(id)), ...change };
    });
  }

  private async putAdminLegacyOrder(requested: readonly string[]): Promise<LegacyOrderPutResult> {
    const discoverOwners = (): string[] => {
      const owners = new Set(Object.keys(this.deps.store.getTabLayouts()));
      const { persisted, live } = this.sessionRecords();
      for (const record of [...persisted, ...live]) owners.add(ownerOf(record));
      return [...owners].sort();
    };
    for (;;) {
      const owners = discoverOwners();
      const result = await this.withOwners(owners, async (): Promise<LegacyOrderPutResult | null> => {
        if (!sameOrder(owners, discoverOwners())) return null;
        const normalized = normalizeSessionOrder(requested);
        const knownOwners = new Map<string, string>();
        const { persisted, live } = this.sessionRecords();
        for (const record of persisted) knownOwners.set(record.id, ownerOf(record));
        for (const record of live) knownOwners.set(record.id, ownerOf(record));
        // Unknown ids are DROPPED, never a 400 — see putOwnerLegacyOrder. In
        // single-user mode every request is the synthetic admin, so this path
        // IS the one the browser's debounced (error-swallowing) push hits.
        const known = normalized.filter((id) => knownOwners.has(id));

        const publications: OwnerProjectionPublication[] = [];
        const updates: Record<string, TabLayout> = Object.create(null) as Record<string, TabLayout>;
        for (const owner of owners) {
          const prepared = await this.prepareUnlocked(owner);
          const visible = new Set(
            prepared.metadata
              .filter((item) => item.kind === 'session' && item.ownerValid && item.visible)
              .map((item) => item.id)
          );
          const requestedOwner = known.filter((id) => visible.has(id));
          const currentKnown = flattenOwnerSessionOrder(prepared.authoritative).filter((id) => visible.has(id));
          const effective = mergeSessionOrder(requestedOwner, currentKnown);
          const ranked = applyLegacySessionRank(prepared.authoritative, effective, prepared.metadata);
          const needsLayout = prepared.needsReconciliationCommit || !sameLayout(prepared.authoritative, ranked);
          const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
          const next = needsLayout ? this.prepareCommit(base, ranked) : prepared.authoritative;
          if (needsLayout) updates[owner] = next;
          publications.push({ owner, previous: prepared.current, next, metadata: prepared.metadata });
        }
        const change = this.publish(updates, publications, known);
        return { order: [...change.globalOrder], ...change };
      });
      if (result) return result;
    }
  }

  /**
   * Reconcile one completed session creation into one versioned mutation.
   *
   * `placement.tabGroupId` puts the new session at the end of that group in the
   * same write. The group is looked up in THIS owner's layout only, so a group id
   * from another owner (or one deleted meanwhile) is simply not found and the
   * session keeps its normal placement: after its parent when it has one,
   * otherwise at the end of Ungrouped. An explicit group is a hand placement, so
   * a child session placed this way is marked `manual` and stops following.
   *
   * Whether a child placed by its lineage KEEPS following is the synced
   * `spawnedTabsFollowParent` setting, read here at creation: off (the default),
   * the child lands after its parent once and is marked `manual` in the same
   * write; on, it follows its parent until moved by hand. Flipping the setting
   * later leaves existing tabs as they are.
   */
  async sessionCreated(
    owner: string,
    sessionId?: string,
    placement: SessionPlacementHint = {},
    register?: RegisterCreatedSession
  ): Promise<TabLayout> {
    return this.withOwner(owner, async () => {
      const follow = sessionId ? (await this.deps.childrenFollowParent?.()) === true : true;
      const rollback = register?.();
      try {
        const groupId = placement.tabGroupId;
        const adjust =
          sessionId && (groupId || !follow)
            ? (layout: TabLayout, metadata: readonly TabRefMetadata[]) => {
                const placed = groupId ? placeCreatedSession(layout, sessionId, groupId, metadata) : layout;
                return follow ? placed : pinCreatedChild(placed, sessionId, metadata);
              }
            : undefined;
        return await this.getUnlocked(owner, adjust);
      } catch (error) {
        if (typeof rollback === 'function') rollback();
        throw error;
      }
    });
  }

  /** Reconcile one completed saved-webview creation into one versioned mutation. */
  async webviewCreated(owner: string): Promise<TabLayout> {
    return this.get(owner);
  }

  async sessionsRemoved(removed: readonly RemovedTabLayoutSession[]): Promise<void> {
    if (this.restorationState !== 'complete' || removed.length === 0) return;
    const byOwner = new Map<string, string[]>();
    for (const item of removed) {
      const owner = ownerOf(item);
      const ids = byOwner.get(owner) ?? [];
      ids.push(item.id);
      byOwner.set(owner, ids);
    }
    const owners = [...byOwner.keys()].sort();
    await this.withOwners(owners, async () => {
      const publications: OwnerProjectionPublication[] = [];
      const updates: Record<string, TabLayout> = Object.create(null) as Record<string, TabLayout>;
      for (const owner of owners) {
        const ids = byOwner.get(owner) ?? [];
        const prepared = await this.prepareUnlocked(owner);
        const current = prepared.current;
        // Normalize and prune together so stale cleanup, orphan materialization,
        // and missing-ref repair remain one versioned server mutation.
        const next = normalizeTabLayout(
          materializeOrphans(prepared.authoritative, ids, prepared.metadata),
          prepared.metadata
        );
        const stored = current && !sameLayout(current, next) ? this.prepareCommit(current, next) : null;
        if (stored) updates[owner] = stored;
        publications.push({
          owner,
          previous: current,
          next: stored ?? next,
          metadata: prepared.metadata,
          excludedSessionIds: new Set(ids),
        });
      }
      if (publications.length > 0) this.publish(updates, publications);
    });
  }

  /**
   * Hold the owner mutation lock across an irreversible session deletion.
   * All failure-prone normalization happens before `action`; the prepared layout
   * commits only after the resource cleanup finishes.
   */
  async runSessionDeletion<T>(removed: readonly RemovedTabLayoutSession[], action: () => Promise<T>): Promise<T> {
    // A failed restoration must not lock the user out of explicitly closing a
    // tab for the rest of the process lifetime: degrade to best-effort deletion
    // without layout coordination. Only the AUTOMATED stale sweep stays
    // fail-closed on 'failed' (runStaleSessionCleanup), because that one picks
    // its victims itself from state a failed restore may have left incomplete.
    if (this.restorationState === 'failed') return action();
    this.assertDeletionReady();
    if (this.restorationState === 'skipped' || removed.length === 0) return action();
    const owners = new Set(removed.map(ownerOf));
    if (owners.size !== 1) throw new Error('A session deletion transaction must contain exactly one owner');
    const owner = owners.values().next().value as string;
    const ids = removed.map((item) => item.id);
    return this.withOwner(owner, async () => {
      const prepared = await this.prepareUnlocked(owner);
      const current = prepared.current;
      // Prepare while the soon-to-be-deleted sessions are still known, so
      // direct children can be materialized before their parent ref is removed.
      const next = materializeOrphans(prepared.authoritative, ids, prepared.metadata);
      const stored = current && !sameLayout(current, next) ? this.prepareCommit(current, next) : null;
      const result = await action();
      this.publish(stored ? { [owner]: stored } : {}, [
        {
          owner,
          previous: current,
          next: stored ?? next,
          metadata: prepared.metadata,
          excludedSessionIds: new Set(ids),
        },
      ]);
      return result;
    });
  }

  /**
   * Prepare every affected owner layout before bulk stale-state deletion.
   * The StateStore action remains synchronous in production, so the candidate
   * snapshot cannot change between successful preparation and resource removal.
   */
  async runStaleSessionCleanup<T>(
    activeSessionIds: ReadonlySet<string>,
    action: (ids: ReadonlySet<string>) => T | Promise<T>
  ): Promise<T> {
    this.assertDeletionReady();
    const candidates = Object.entries(this.deps.store.getSessions())
      .filter(([id, record]) => !activeSessionIds.has(id) && record.pinned !== true)
      .map(([id, record]) => ({ id, owner: record.owner }));
    if (this.restorationState === 'skipped') return action(new Set(candidates.map((item) => item.id)));
    if (candidates.length === 0) return action(new Set());

    const byOwner = new Map<string, string[]>();
    for (const item of candidates) {
      const owner = ownerOf(item);
      const ids = byOwner.get(owner) ?? [];
      ids.push(item.id);
      byOwner.set(owner, ids);
    }
    const owners = [...byOwner.keys()].sort();
    return this.withOwners(owners, async () => {
      const webviews = await this.deps.readWebviews();
      const persistedState = this.deps.store.getSessions();
      const persisted = Object.entries(persistedState).map(([id, record]) => ({
        id,
        owner: record.owner,
        createdAt: record.createdAt,
        parentSessionId: record.parentSessionId,
      }));
      const liveIds = new Set(this.deps.sessions.keys());
      const confirmed = candidates.filter((candidate) => {
        const record = persistedState[candidate.id];
        return (
          record !== undefined &&
          ownerOf(record) === ownerOf(candidate) &&
          record.pinned !== true &&
          !activeSessionIds.has(candidate.id) &&
          !liveIds.has(candidate.id)
        );
      });
      const confirmedByOwner = new Map<string, string[]>();
      for (const item of confirmed) {
        const owner = ownerOf(item);
        const ids = confirmedByOwner.get(owner) ?? [];
        ids.push(item.id);
        confirmedByOwner.set(owner, ids);
      }

      const prepared: Array<{
        owner: string;
        current: TabLayout | null;
        next: TabLayout;
        stored: TabLayout | null;
        metadata: TabRefMetadata[];
        excludedSessionIds: ReadonlySet<string>;
      }> = [];
      for (const owner of owners) {
        const ids = confirmedByOwner.get(owner) ?? [];
        if (ids.length === 0) continue;
        const current = this.deps.store.getTabLayout(owner);
        const sessions = new Map<string, TabLayoutSessionRecord>();
        for (const record of persisted) sessions.set(record.id, record);
        for (const record of this.deps.sessions.values()) sessions.set(record.id, record);
        const ownedSessions = [...sessions.values()]
          .filter((record) => ownerOf(record) === owner)
          .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const sessionOrder = new Map(ownedSessions.map((record, index) => [record.id, index]));
        const metadata: TabRefMetadata[] = [...sessions.values()].map((record) => ({
          kind: 'session',
          id: record.id,
          ownerValid: ownerOf(record) === owner,
          visible: true,
          order: sessionOrder.get(record.id) ?? record.createdAt,
          parentSessionId: record.parentSessionId,
        }));
        const offset = ownedSessions.length;
        webviews.forEach((record, index) =>
          metadata.push({
            kind: 'webview',
            id: record.id,
            ownerValid: ownerOf(record) === owner,
            visible: true,
            order: offset + index,
          })
        );
        const authoritative = normalizeOrMigrateOwnerTabLayout({
          owner,
          layouts: current ? { [owner]: current } : undefined,
          sessionOrder: this.deps.store.getSessionOrder(),
          persistedSessions: persisted,
          liveSessions: [...this.deps.sessions.values()],
          webviews,
          updatedAt: (this.deps.now ?? (() => new Date().toISOString()))(),
        }).layout;
        const next = materializeOrphans(authoritative, ids, metadata);
        prepared.push({
          owner,
          current,
          next,
          stored: current && !sameLayout(current, next) ? this.prepareCommit(current, next) : null,
          metadata,
          excludedSessionIds: new Set(ids),
        });
      }

      const result = await action(new Set(confirmed.map((item) => item.id)));
      if (prepared.length > 0) {
        this.publish(
          Object.fromEntries(prepared.filter((item) => item.stored).map((item) => [item.owner, item.stored!])),
          prepared.map((item) => ({
            owner: item.owner,
            previous: item.current,
            next: item.stored ?? item.next,
            metadata: item.metadata,
            excludedSessionIds: item.excludedSessionIds,
          }))
        );
      }
      return result;
    });
  }

  async webviewDeleted(owner: string, id: string): Promise<void> {
    // Same explicit-user-action escape hatch as runSessionDeletion: a failed
    // restore skips layout coordination instead of failing the delete.
    if (this.restorationState === 'failed') return;
    this.assertDeletionReady();
    if (this.restorationState === 'skipped') return;
    await this.withOwner(owner, async () => {
      const current = this.deps.store.getTabLayout(owner);
      if (!current) return;
      const strip = (refs: readonly TabRef[]): TabRef[] =>
        refs.filter((ref) => ref.kind !== 'webview' || ref.id !== id).map((ref) => ({ ...ref }));
      const stripped: TabLayout = {
        ...current,
        groups: current.groups.map((group) => ({ ...group, refs: strip(group.refs) })),
        ungrouped: strip(current.ungrouped),
      };
      const { metadata } = await this.facts(owner);
      const next = normalizeTabLayout(stripped, metadata);
      if (!sameLayout(current, next)) this.commit(owner, current, next, metadata);
    });
  }
}
