/**
 * @fileoverview Tab-layout server coordinator lifecycle, ownership, and version tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { TabLayoutService } from '../src/tab-layout-service.js';
import { SseEvent } from '../src/web/sse-events.js';
import type { TabLayout } from '../src/tab-layout.js';

type SessionFact = { id: string; owner?: string; createdAt: number; parentSessionId?: string; pinned?: boolean };

function createHarness(
  options: {
    layouts?: Record<string, TabLayout>;
    order?: string[];
    persisted?: SessionFact[];
    live?: SessionFact[];
    webviews?: Array<{ id: string; owner?: string }>;
    now?: () => string;
    /** The synced spawnedTabsFollowParent setting (absent = off, the default). */
    follow?: boolean;
  } = {}
) {
  const layouts = { ...(options.layouts ?? {}) };
  const persisted = Object.fromEntries((options.persisted ?? []).map((session) => [session.id, session]));
  const live = new Map((options.live ?? []).map((session) => [session.id, session]));
  const order = [...(options.order ?? [])];
  const readWebviews = vi.fn(async () => options.webviews ?? []);
  const store = {
    getTabLayout: vi.fn((owner: string) => layouts[owner] ?? null),
    getTabLayouts: vi.fn(() => ({ ...layouts })),
    getSessions: vi.fn(() => persisted),
    getSessionOrder: vi.fn(() => [...order]),
    commitTabLayoutProjection: vi.fn(
      (updates: Readonly<Record<string, TabLayout>>, project: (latest: readonly string[]) => readonly string[]) => {
        const projected = [...project([...order])];
        Object.assign(layouts, structuredClone(updates));
        order.splice(0, order.length, ...projected);
        return { layouts: structuredClone(updates), sessionOrder: [...order] };
      }
    ),
  };
  const broadcast = vi.fn();
  const broadcastSessionOrder = vi.fn();
  const service = new TabLayoutService({
    store: store as never,
    sessions: live as never,
    readWebviews,
    broadcast,
    broadcastSessionOrder,
    childrenFollowParent: vi.fn(() => options.follow === true),
    now: options.now ?? (() => '2026-08-16T12:00:00.000Z'),
  });
  return { service, store, broadcast, broadcastSessionOrder, layouts, order, live, persisted, readWebviews };
}

const existing = (refs: TabLayout['ungrouped'], version = 7): TabLayout => ({
  version,
  groups: [],
  ungrouped: refs,
  updatedAt: '2026-08-15T00:00:00.000Z',
});

describe('TabLayoutService', () => {
  it('guards destructive transactions by restoration state while allowing skipped test mode', async () => {
    const h = createHarness({ layouts: { '@single': existing([{ kind: 'session', id: 'mine' }]) } });
    const action = vi.fn(async () => 'removed');

    await expect(h.service.runSessionDeletion([{ id: 'mine' }], action)).rejects.toThrow(/restoration.*pending/i);
    expect(action).not.toHaveBeenCalled();

    h.service.markRestorationSkipped();
    await expect(h.service.runSessionDeletion([{ id: 'mine' }], action)).resolves.toBe('removed');
    expect(action).toHaveBeenCalledTimes(1);
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();
  });

  it('degrades an explicit deletion to best-effort after a failed restore, while the stale sweep stays blocked', async () => {
    // A tmux hiccup at boot used to lock DELETE /api/sessions/:id (and webview
    // deletes) into opaque 500s for the whole process lifetime. A user's
    // explicit close now runs without layout coordination; only the AUTOMATED
    // stale sweep stays fail-closed, because it picks its own victims from
    // state a failed restore may have left incomplete.
    const h = createHarness({ layouts: { '@single': existing([{ kind: 'session', id: 'mine' }]) } });
    const action = vi.fn(async () => 'removed');
    h.service.markRestorationFailed();

    await expect(h.service.runSessionDeletion([{ id: 'mine' }], action)).resolves.toBe('removed');
    expect(action).toHaveBeenCalledTimes(1);
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();

    await expect(h.service.webviewDeleted('@single', 'w1')).resolves.toBeUndefined();

    const cleanup = vi.fn();
    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).rejects.toThrow(/restoration.*failed/i);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('prepares and commits a complete-state session deletion around the resource action', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    const action = vi.fn(async () => {
      expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
      h.live.delete('mine');
      return 'removed';
    });

    await expect(h.service.runSessionDeletion([{ id: 'mine', owner: 'alice' }], action)).resolves.toBe('removed');

    expect(h.layouts.alice.ungrouped).toEqual([]);
    expect(h.layouts.alice.version).toBe(8);
  });

  it('leaves stale records, layouts, versions, and events intact when bulk preparation fails', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'stale' }]) },
      persisted: [{ id: 'stale', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    const cleanup = vi.fn(() => {
      delete h.persisted.stale;
      return { count: 1, cleaned: [{ id: 'stale', owner: 'alice' }] };
    });
    h.store.getSessions
      .mockImplementationOnce(() => h.persisted)
      .mockImplementationOnce(() => {
        throw new Error('malformed persisted state');
      });

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).rejects.toThrow('malformed persisted state');

    expect(cleanup).not.toHaveBeenCalled();
    expect(h.persisted.stale).toBeDefined();
    expect(h.layouts.alice).toEqual(existing([{ kind: 'session', id: 'stale' }]));
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();
  });

  it('bulk-cleans multiple owners once each while preserving pinned stale records', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'alice-stale' },
          { kind: 'session', id: 'alice-pinned' },
        ]),
        bob: existing([{ kind: 'session', id: 'bob-stale' }]),
      },
      persisted: [
        { id: 'bob-stale', owner: 'bob', createdAt: 1 },
        { id: 'alice-stale', owner: 'alice', createdAt: 2 },
        { id: 'alice-pinned', owner: 'alice', createdAt: 3, pinned: true },
      ],
    });
    h.service.markRestorationComplete();
    const cleanup = vi.fn(() => {
      delete h.persisted['alice-stale'];
      delete h.persisted['bob-stale'];
      return { count: 2 };
    });

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).resolves.toEqual({ count: 2 });

    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'alice-pinned' }]);
    expect(h.layouts.bob.ungrouped).toEqual([]);
    expect(h.layouts.alice.version).toBe(8);
    expect(h.layouts.bob.version).toBe(8);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(Object.keys(h.store.commitTabLayoutProjection.mock.calls[0][0])).toEqual(['alice', 'bob']);
    expect(h.broadcast).toHaveBeenCalledTimes(2);
  });

  it('does not commit a prepared stale layout when asynchronous cleanup rejects', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'alice-stale' }]) },
      persisted: [{ id: 'alice-stale', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    const cleanup = vi.fn(async () => {
      throw new Error('state removal failed');
    });

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).rejects.toThrow('state removal failed');

    expect(h.layouts.alice).toEqual(existing([{ kind: 'session', id: 'alice-stale' }]));
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('binds stale cleanup to revalidated original candidates after an owner queue wait', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([{ kind: 'session', id: 'alice-stale' }]),
        bob: existing([{ kind: 'session', id: 'bob-new-stale' }]),
      },
      order: ['alice-stale'],
      persisted: [{ id: 'alice-stale', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    let releaseFacts!: () => void;
    const factsBlocked = new Promise<void>((resolve) => {
      releaseFacts = resolve;
    });
    h.readWebviews.mockImplementationOnce(async () => {
      await factsBlocked;
      return [];
    });

    const occupiedOwnerQueue = h.service.get('alice');
    await vi.waitFor(() => expect(h.readWebviews).toHaveBeenCalledOnce());
    const cleanup = vi.fn((ids: ReadonlySet<string>) => ({ ids: [...ids] }));
    const pending = h.service.runStaleSessionCleanup(new Set(), cleanup);

    h.persisted['alice-stale'].pinned = true;
    h.persisted['bob-new-stale'] = { id: 'bob-new-stale', owner: 'bob', createdAt: 2 };
    releaseFacts();

    await occupiedOwnerQueue;
    await expect(pending).resolves.toEqual({ ids: [] });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(new Set());
    expect(h.persisted['alice-stale']).toBeDefined();
    expect(h.persisted['bob-new-stale']).toBeDefined();
    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'alice-stale' }]);
    expect(h.layouts.bob.ungrouped).toEqual([{ kind: 'session', id: 'bob-new-stale' }]);
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
  });

  it('allows skipped-mode stale cleanup without pruning or versioning layouts', async () => {
    const h = createHarness({
      layouts: { '@single': existing([{ kind: 'session', id: 'stale' }]) },
      persisted: [{ id: 'stale', createdAt: 1 }],
    });
    h.service.markRestorationSkipped();
    const cleanup = vi.fn(() => ({ count: 1 }));

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).resolves.toEqual({ count: 1 });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('repairs missing owner refs once while preserving unknown refs', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'unknown' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const first = await h.service.get('alice');
    expect(first.ungrouped).toEqual([
      { kind: 'session', id: 'unknown' },
      { kind: 'session', id: 'mine' },
    ]);
    expect(first.version).toBe(8);
    await h.service.get('alice');
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 8 });
  });

  it('repairs only the legacy projection on GET when the stored layout is already canonical', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a' },
          { kind: 'session', id: 'b' },
        ]),
      },
      order: ['b', 'a'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
      ],
    });

    const first = await h.service.get('alice');
    const second = await h.service.get('alice');

    expect(first).toEqual(
      existing([
        { kind: 'session', id: 'a' },
        { kind: 'session', id: 'b' },
      ])
    );
    expect(second).toEqual(first);
    expect(h.order).toEqual(['a', 'b']);
    expect(h.layouts.alice.version).toBe(7);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.store.commitTabLayoutProjection.mock.calls[0][0]).toEqual({});
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: ['a', 'b'] },
      globalOrder: ['a', 'b'],
      globalChanged: true,
    });
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: ['a', 'b'] },
      globalOrder: ['a', 'b'],
      globalChanged: true,
    });
  });

  it('isolates owner metadata and filters saved webviews by exact owner', async () => {
    const h = createHarness({
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'bob', createdAt: 2 },
      ],
      webviews: [
        { id: 'wa', owner: 'alice' },
        { id: 'wb', owner: 'bob' },
      ],
    });
    expect((await h.service.get('alice')).ungrouped.map((ref) => ref.id)).toEqual(['a', 'wa']);
    expect((await h.service.get('bob')).ungrouped.map((ref) => ref.id)).toEqual(['b', 'wb']);
  });

  it('rejects foreign and unknown refs atomically even for an admin-owned layout', async () => {
    const h = createHarness({
      layouts: { admin: existing([{ kind: 'session', id: 'mine' }]) },
      live: [
        { id: 'mine', owner: 'admin', createdAt: 1 },
        { id: 'foreign', owner: 'bob', createdAt: 2 },
      ],
    });
    const desired = existing([{ kind: 'session', id: 'foreign' }]);
    await expect(h.service.put('admin', desired, 7)).rejects.toThrow(/not owned/);
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
  });

  it.each([6, 8])('conflicts on every non-exact base version (%s)', async (baseVersion) => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    expect(await h.service.put('alice', existing([{ kind: 'session', id: 'mine' }]), baseVersion)).toEqual({
      status: 'conflict',
      layout: existing([{ kind: 'session', id: 'mine' }]),
    });
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();
  });

  it('returns an unpersisted prepared layout for a stale first write without broadcasting', async () => {
    const h = createHarness({
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });

    await expect(h.service.put('alice', existing([{ kind: 'session', id: 'mine' }]), 7)).resolves.toEqual({
      status: 'conflict',
      layout: {
        version: 0,
        groups: [],
        ungrouped: [{ kind: 'session', id: 'mine' }],
        updatedAt: '2026-08-16T12:00:00.000Z',
      },
    });
    expect(h.layouts.alice).toBeUndefined();
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();
  });

  it('returns a normalized prepared layout for a stale write without persisting the reconciliation', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'unknown' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });

    await expect(h.service.put('alice', existing([{ kind: 'session', id: 'mine' }]), 6)).resolves.toEqual({
      status: 'conflict',
      layout: existing([
        { kind: 'session', id: 'unknown' },
        { kind: 'session', id: 'mine' },
      ]),
    });
    expect(h.layouts.alice).toEqual(existing([{ kind: 'session', id: 'unknown' }]));
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();
  });

  it('folds first-write initialization and the requested update into one commit', async () => {
    const h = createHarness({
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const desired = {
      ...existing([]),
      groups: [{ id: 'g', name: 'Mine', refs: [{ kind: 'session', id: 'mine' }] }],
    };

    const result = await h.service.put('alice', desired, 0);

    expect(result).toEqual({
      status: 'updated',
      layout: {
        version: 1,
        groups: [{ id: 'g', name: 'Mine', refs: [{ kind: 'session', id: 'mine' }] }],
        ungrouped: [],
        updatedAt: '2026-08-16T12:00:00.000Z',
      },
    });
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.store.commitTabLayoutProjection.mock.calls[0][0]).toEqual({ alice: result.layout });
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 1 });
  });

  it('uses the prepared authoritative ordering for a matching folded first write with tied session timestamps', async () => {
    const h = createHarness({
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'B', owner: 'alice', createdAt: 1 },
      ],
    });

    const result = await h.service.put('alice', existing([]), 0);

    expect(result).toEqual({
      status: 'updated',
      layout: {
        version: 1,
        groups: [],
        ungrouped: [
          { kind: 'session', id: 'B' },
          { kind: 'session', id: 'a' },
        ],
        updatedAt: '2026-08-16T12:00:00.000Z',
      },
    });
  });

  it('folds normalization and a matching requested update into one commit', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'unknown' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const desired = {
      ...existing([]),
      groups: [{ id: 'g', name: 'Mine', refs: [{ kind: 'session', id: 'mine' }] }],
    };

    const result = await h.service.put('alice', desired, 7);

    expect(result).toEqual({
      status: 'updated',
      layout: {
        version: 8,
        groups: [{ id: 'g', name: 'Mine', refs: [{ kind: 'session', id: 'mine' }] }],
        ungrouped: [],
        updatedAt: '2026-08-16T12:00:00.000Z',
      },
    });
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.store.commitTabLayoutProjection.mock.calls[0][0]).toEqual({ alice: result.layout });
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 8 });
  });

  it('stores a matching write with one fresh version and minimal event payload', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const result = await h.service.put(
      'alice',
      { ...existing([{ kind: 'session', id: 'mine' }]), groups: [{ id: 'g', name: ' Group ', refs: [] }] },
      7
    );
    expect(result.status).toBe('updated');
    expect(result.layout).toMatchObject({ version: 8, updatedAt: '2026-08-16T12:00:00.000Z' });
    expect(result.layout.groups[0].name).toBe('Group');
    expect(h.broadcast).toHaveBeenLastCalledWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 8 });
  });

  it('serializes concurrent writes so only one exact base version can win', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const desired = existing([{ kind: 'session', id: 'mine' }]);
    const results = await Promise.all([h.service.put('alice', desired, 7), h.service.put('alice', desired, 7)]);
    expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'updated']);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.layouts.alice.version).toBe(8);
  });

  it('places a root at the end and a child after its parent subtree', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'parent' },
          { kind: 'session', id: 'tail' },
        ]),
      },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'tail', owner: 'alice', createdAt: 2 },
      ],
    });
    h.live.set('root', { id: 'root', owner: 'alice', createdAt: 3 } as never);
    await h.service.sessionCreated('alice');
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['parent', 'tail', 'root']);
    h.live.set('child', { id: 'child', owner: 'alice', createdAt: 4, parentSessionId: 'parent' } as never);
    await h.service.sessionCreated('alice');
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['parent', 'child', 'tail', 'root']);
    expect(h.layouts.alice.version).toBe(9);
  });

  it('appends a newly saved owner webview and rejects over-limit writes atomically', async () => {
    const webviews: Array<{ id: string; owner?: string }> = [];
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
      webviews,
    });
    webviews.push({ id: 'dashboard', owner: 'alice' });
    await h.service.webviewCreated('alice');
    expect(h.layouts.alice.ungrouped.at(-1)).toEqual({ kind: 'webview', id: 'dashboard' });

    const tooMany = Array.from({ length: 513 }, (_, index) => ({ kind: 'session' as const, id: `s-${index}` }));
    await expect(h.service.put('alice', existing(tooMany, 8), 8)).rejects.toThrow(/512/);
    expect(h.layouts.alice.version).toBe(8);
  });

  it('materializes children and removes an explicitly deleted parent in one mutation', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'parent' },
          { kind: 'session', id: 'child' },
        ]),
      },
      live: [{ id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' }],
    });
    h.service.markRestorationComplete();
    await h.service.sessionsRemoved([{ id: 'parent', owner: 'alice' }]);
    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'child', placement: 'manual' }]);
    expect(h.layouts.alice.version).toBe(8);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
  });

  it('publishes multi-owner post-removal repairs in one combined transaction', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([{ kind: 'session', id: 'a-stale' }]),
        bob: existing([{ kind: 'session', id: 'b-stale' }]),
      },
      order: ['a-stale', 'b-stale'],
    });
    h.service.markRestorationComplete();

    await h.service.sessionsRemoved([
      { id: 'a-stale', owner: 'alice' },
      { id: 'b-stale', owner: 'bob' },
    ]);

    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(Object.keys(h.store.commitTabLayoutProjection.mock.calls[0][0])).toEqual(['alice', 'bob']);
    expect(h.layouts.alice.ungrouped).toEqual([]);
    expect(h.layouts.bob.ungrouped).toEqual([]);
    expect(h.order).toEqual([]);
  });

  it('does not publish any owner when later multi-owner post-removal preparation fails', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([{ kind: 'session', id: 'a-stale' }]),
        bob: existing([{ kind: 'session', id: 'b-stale' }]),
      },
      order: ['a-stale', 'b-stale'],
    });
    h.service.markRestorationComplete();
    h.readWebviews.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('bob facts failed'));

    await expect(
      h.service.sessionsRemoved([
        { id: 'a-stale', owner: 'alice' },
        { id: 'b-stale', owner: 'bob' },
      ])
    ).rejects.toThrow('bob facts failed');

    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['a-stale']);
    expect(h.layouts.bob.ungrouped.map((ref) => ref.id)).toEqual(['b-stale']);
  });

  it('prepares deletion version metadata before running the irreversible action', async () => {
    const action = vi.fn(async () => 'removed');
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
      now: () => {
        throw new Error('clock failed');
      },
    });
    h.service.markRestorationComplete();

    await expect(h.service.runSessionDeletion([{ id: 'mine', owner: 'alice' }], action)).rejects.toThrow(
      'clock failed'
    );

    expect(action).not.toHaveBeenCalled();
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
  });

  it('removes a legacy-only ID when deleting before owner layout migration', async () => {
    const h = createHarness({
      order: ['mine'],
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    const action = vi.fn(async () => {
      h.live.delete('mine');
      return 'removed';
    });

    await expect(h.service.runSessionDeletion([{ id: 'mine', owner: 'alice' }], action)).resolves.toBe('removed');

    expect(h.layouts.alice).toBeUndefined();
    expect(h.order).toEqual([]);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledExactlyOnceWith({}, expect.any(Function));
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: [] },
      globalOrder: [],
      globalChanged: true,
    });
  });

  it('removes a deleted legacy ID absent from an existing layout without bumping its version', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'keep' }]) },
      order: ['gone', 'keep'],
      live: [
        { id: 'gone', owner: 'alice', createdAt: 1 },
        { id: 'keep', owner: 'alice', createdAt: 2 },
      ],
    });
    h.service.markRestorationComplete();

    await h.service.runSessionDeletion([{ id: 'gone', owner: 'alice' }], async () => {
      h.live.delete('gone');
    });

    expect(h.layouts.alice).toEqual(existing([{ kind: 'session', id: 'keep' }]));
    expect(h.order).toEqual(['keep']);
    expect(h.store.commitTabLayoutProjection.mock.calls[0][0]).toEqual({});
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: ['keep'] },
      globalOrder: ['keep'],
      globalChanged: true,
    });
  });

  it('removes legacy-only IDs from post-removal repair with no migrated layout or layout delta', async () => {
    const h = createHarness({
      layouts: { bob: existing([{ kind: 'session', id: 'keep' }]) },
      order: ['alice-gone', 'bob-gone', 'keep'],
      live: [{ id: 'keep', owner: 'bob', createdAt: 3 }],
    });
    h.service.markRestorationComplete();

    await h.service.sessionsRemoved([
      { id: 'alice-gone', owner: 'alice' },
      { id: 'bob-gone', owner: 'bob' },
    ]);

    expect(h.layouts.alice).toBeUndefined();
    expect(h.layouts.bob).toEqual(existing([{ kind: 'session', id: 'keep' }]));
    expect(h.order).toEqual(['keep']);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.store.commitTabLayoutProjection.mock.calls[0][0]).toEqual({});
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: [], bob: ['keep'] },
      globalOrder: ['keep'],
      globalChanged: true,
    });
  });

  it('removes a confirmed stale legacy-only ID even before owner layout migration', async () => {
    const h = createHarness({
      order: ['stale'],
      persisted: [{ id: 'stale', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    const cleanup = vi.fn((ids: ReadonlySet<string>) => {
      delete h.persisted.stale;
      return [...ids];
    });

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).resolves.toEqual(['stale']);

    expect(h.layouts.alice).toBeUndefined();
    expect(h.order).toEqual([]);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledExactlyOnceWith({}, expect.any(Function));
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: [] },
      globalOrder: [],
      globalChanged: true,
    });
  });

  it('does not prune or bump when restoration was skipped', async () => {
    const h = createHarness({ layouts: { '@single': existing([{ kind: 'session', id: 'gone' }]) } });
    h.service.markRestorationSkipped();
    await h.service.sessionsRemoved([{ id: 'gone' }]);
    await h.service.webviewDeleted('@single', 'also-gone');
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.layouts['@single'].version).toBe(7);
  });

  it('retains pinned stopped sessions and prunes saved webviews after restoration', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'pinned' },
          { kind: 'webview', id: 'gone-web' },
        ]),
      },
      persisted: [{ id: 'pinned', owner: 'alice', createdAt: 1, pinned: true }],
    });
    h.service.markRestorationComplete();
    await h.service.webviewDeleted('alice', 'gone-web');
    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'pinned' }]);
    expect(h.layouts.alice.version).toBe(8);
  });

  it('bridges a regular legacy reorder into the owner layout and canonical global projection', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a' },
          { kind: 'session', id: 'b' },
        ]),
      },
      order: ['a', 'b'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
      ],
    });

    await expect(h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['b', 'a'])).resolves.toEqual({
      order: ['b', 'a'],
      changedOwnerOrders: { alice: ['b', 'a'] },
      globalOrder: ['b', 'a'],
      globalChanged: true,
    });
    expect((await h.service.get('alice')).ungrouped.map((ref) => ref.id)).toEqual(['b', 'a']);
    expect(h.layouts.alice.version).toBe(8);
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 8 });
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: ['b', 'a'] },
      globalOrder: ['b', 'a'],
      globalChanged: true,
    });
  });

  it('preserves an unmapped global slot while a legacy PUT reorders authoritative owner sessions', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'unknown' },
          { kind: 'session', id: 'a' },
          { kind: 'session', id: 'b' },
        ]),
      },
      order: ['unknown', 'a', 'b'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
      ],
    });

    const result = await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['b', 'a']);

    expect(h.layouts.alice.ungrouped).toEqual([
      { kind: 'session', id: 'unknown' },
      { kind: 'session', id: 'b' },
      { kind: 'session', id: 'a' },
    ]);
    expect(result.globalOrder).toEqual(['unknown', 'b', 'a']);
    expect(h.order).toEqual(['unknown', 'b', 'a']);
    expect(result.order).toEqual(['b', 'a']);
  });

  it('preserves an unmapped global slot during a GET order repair', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'unknown' },
          { kind: 'session', id: 'b' },
          { kind: 'session', id: 'a' },
        ]),
      },
      order: ['unknown', 'a', 'b'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
      ],
    });

    await h.service.get('alice');

    expect(h.order).toEqual(['unknown', 'b', 'a']);
    expect(h.broadcastSessionOrder).toHaveBeenCalledWith({
      changedOwnerOrders: { alice: ['b', 'a'] },
      globalOrder: ['unknown', 'b', 'a'],
      globalChanged: true,
    });
  });

  it('removes an unmapped global id only when a trusted deletion explicitly excludes it', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'unknown' },
          { kind: 'session', id: 'a' },
        ]),
      },
      order: ['unknown', 'a'],
      live: [{ id: 'a', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();

    await h.service.runSessionDeletion([{ id: 'unknown', owner: 'alice' }], async () => undefined);

    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'a' }]);
    expect(h.order).toEqual(['a']);
  });

  it('reports an owner layout-order change even when the legacy global slice already matches', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a' },
          { kind: 'session', id: 'b' },
        ]),
      },
      order: ['b', 'a'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
      ],
    });

    const result = await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['b', 'a']);

    expect(result.changedOwnerOrders).toEqual({ alice: ['b', 'a'] });
    expect(result.globalChanged).toBe(false);
    expect(h.broadcastSessionOrder).toHaveBeenCalledTimes(1);
  });

  it('reports an authoritative owner-order correction when a placement-only PUT repairs stale global order', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a' },
          { kind: 'session', id: 'b' },
        ]),
      },
      order: ['b', 'a'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
      ],
    });
    const desired = {
      ...existing([], 7),
      groups: [
        {
          id: 'g',
          name: 'Same order',
          refs: [
            { kind: 'session' as const, id: 'a' },
            { kind: 'session' as const, id: 'b' },
          ],
        },
      ],
    };

    const result = await h.service.put('alice', desired, 7);

    expect(result.status).toBe('updated');
    expect(h.order).toEqual(['a', 'b']);
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: ['a', 'b'] },
      globalOrder: ['a', 'b'],
      globalChanged: true,
    });
  });

  it.each([
    ['foreign owner', ['b', 'a']],
    ['unknown stored ref', ['unknown', 'a']],
  ])('drops a %s from a regular legacy request instead of rejecting the write', async (_label, requested) => {
    const original = existing([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'unknown' },
    ]);
    const h = createHarness({
      layouts: { alice: original },
      order: ['a', 'b', 'unknown'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'bob', createdAt: 2 },
      ],
    });

    // Unknown/foreign ids are dropped, never a 400: the browser's reorder push
    // is debounced and swallows errors, so a rejection would silently lose the
    // user's whole reorder when a session dies inside the debounce window.
    const result = await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, requested);

    expect(result.order).toEqual(['a']);
    expect(h.layouts.alice).toEqual(original);
    expect(h.order).toEqual(['a', 'b', 'unknown']);
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();
  });

  it('applies the surviving reorder when the request contains a deleted id (owner path)', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a1' },
          { kind: 'session', id: 'a2' },
        ]),
      },
      order: ['a1', 'a2'],
      live: [
        { id: 'a1', owner: 'alice', createdAt: 1 },
        { id: 'a2', owner: 'alice', createdAt: 2 },
      ],
    });

    const result = await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['a2', 'ghost', 'a1']);

    expect(result.order).toEqual(['a2', 'a1']);
    expect(h.order).toEqual(['a2', 'a1']);
  });

  it('applies the surviving reorder when the request contains a deleted id (admin path)', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a1' },
          { kind: 'session', id: 'a2' },
        ]),
      },
      order: ['a1', 'a2'],
      live: [
        { id: 'a1', owner: 'alice', createdAt: 1 },
        { id: 'a2', owner: 'alice', createdAt: 2 },
      ],
    });

    const result = await h.service.putLegacyOrder({ owner: 'root', isAdmin: true }, ['a2', 'ghost', 'a1']);

    expect(result.order).toEqual(['a2', 'a1']);
    expect(h.order).toEqual(['a2', 'a1']);
  });

  it('keeps containers and anchored slots fixed, materializes ranked children, and merges missing known sessions', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([
            { kind: 'session', id: 'parent' },
            { kind: 'session', id: 'child' },
            { kind: 'session', id: 'c' },
          ]),
          groups: [
            {
              id: 'g',
              name: 'Work',
              refs: [
                { kind: 'session', id: 'a' },
                { kind: 'webview', id: 'w' },
                { kind: 'session', id: 'unknown' },
                { kind: 'session', id: 'b' },
              ],
            },
          ],
        },
      },
      order: ['a', 'b', 'parent', 'child', 'c'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
        { id: 'parent', owner: 'alice', createdAt: 3 },
        { id: 'child', owner: 'alice', createdAt: 4, parentSessionId: 'parent' },
        { id: 'c', owner: 'alice', createdAt: 5 },
      ],
      webviews: [{ id: 'w', owner: 'alice' }],
    });

    const result = await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['b', 'a', 'child', 'parent']);

    expect(result.order).toEqual(['b', 'a', 'child', 'parent', 'c']);
    expect(h.layouts.alice.groups).toEqual([
      {
        id: 'g',
        name: 'Work',
        refs: [
          { kind: 'session', id: 'b' },
          { kind: 'webview', id: 'w' },
          { kind: 'session', id: 'unknown' },
          { kind: 'session', id: 'a' },
        ],
      },
    ]);
    expect(h.layouts.alice.ungrouped).toEqual([
      { kind: 'session', id: 'child', placement: 'manual' },
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'c' },
    ]);
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: ['b', 'a', 'child', 'parent', 'c'] },
      globalOrder: ['b', 'a', 'child', 'parent', 'c'],
      globalChanged: true,
    });
    expect(await h.service.get('alice')).toEqual(h.layouts.alice);
  });

  it('does not claim or disturb a known foreign session found in a stale owner layout', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a1' },
          { kind: 'session', id: 'b1' },
          { kind: 'session', id: 'a2' },
        ]),
        bob: existing([
          { kind: 'session', id: 'b1' },
          { kind: 'session', id: 'b2' },
        ]),
      },
      order: ['a1', 'b1', 'a2', 'b2'],
      live: [
        { id: 'a1', owner: 'alice', createdAt: 1 },
        { id: 'b1', owner: 'bob', createdAt: 2 },
        { id: 'a2', owner: 'alice', createdAt: 3 },
        { id: 'b2', owner: 'bob', createdAt: 4 },
      ],
    });

    const result = await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['a2', 'a1']);

    expect(result).toMatchObject({
      order: ['a2', 'a1'],
      changedOwnerOrders: { alice: ['a2', 'a1'] },
      globalOrder: ['a2', 'b1', 'a1', 'b2'],
      globalChanged: true,
    });
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['a2', 'a1']);
    expect(h.layouts.bob.ungrouped.map((ref) => ref.id)).toEqual(['b1', 'b2']);
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: { alice: ['a2', 'a1'] },
      globalOrder: ['a2', 'b1', 'a1', 'b2'],
      globalChanged: true,
    });
  });

  it('publishes layout and order together, suppresses duplicate order events, and rolls back store rejection', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a' },
          { kind: 'session', id: 'b' },
        ]),
      },
      order: ['a', 'b'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
      ],
    });
    const desired = {
      ...existing([], 7),
      groups: [
        {
          id: 'g',
          name: 'Grouped',
          refs: [
            { kind: 'session' as const, id: 'a' },
            { kind: 'session' as const, id: 'b' },
          ],
        },
      ],
    };

    await h.service.put('alice', desired, 7);
    expect(h.order).toEqual(['a', 'b']);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();
    await h.service.get('alice');
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();

    const beforeLayout = structuredClone(h.layouts.alice);
    const beforeOrder = [...h.order];
    h.store.commitTabLayoutProjection.mockImplementationOnce(() => {
      throw new Error('publication failed');
    });
    h.broadcast.mockClear();
    await expect(h.service.put('alice', { ...desired, groups: [] }, 8)).rejects.toThrow('publication failed');
    expect(h.layouts.alice).toEqual(beforeLayout);
    expect(h.order).toEqual(beforeOrder);
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.broadcastSessionOrder).not.toHaveBeenCalled();
  });

  it('uses latest-state synchronous publication for overlapping owner preparations without a lost update', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a1' },
          { kind: 'session', id: 'a2' },
        ]),
        bob: existing([
          { kind: 'session', id: 'b1' },
          { kind: 'session', id: 'b2' },
        ]),
      },
      order: ['a1', 'b1', 'a2', 'b2'],
      live: [
        { id: 'a1', owner: 'alice', createdAt: 1 },
        { id: 'b1', owner: 'bob', createdAt: 2 },
        { id: 'a2', owner: 'alice', createdAt: 3 },
        { id: 'b2', owner: 'bob', createdAt: 4 },
      ],
    });

    await Promise.all([
      h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['a2', 'a1']),
      h.service.putLegacyOrder({ owner: 'bob', isAdmin: false }, ['b2', 'b1']),
    ]);

    expect(h.order).toEqual(['a2', 'b2', 'a1', 'b1']);
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['a2', 'a1']);
    expect(h.layouts.bob.ungrouped.map((ref) => ref.id)).toEqual(['b2', 'b1']);
  });

  it('admin publishes all changed owner ranks atomically and can change only cross-owner interleaving', async () => {
    const makeHarness = () =>
      createHarness({
        layouts: {
          alice: existing([
            { kind: 'session', id: 'a1' },
            { kind: 'session', id: 'a2' },
          ]),
          bob: existing([
            { kind: 'session', id: 'b1' },
            { kind: 'session', id: 'b2' },
          ]),
        },
        order: ['a1', 'b1', 'a2', 'b2'],
        live: [
          { id: 'a1', owner: 'alice', createdAt: 1 },
          { id: 'b1', owner: 'bob', createdAt: 2 },
          { id: 'a2', owner: 'alice', createdAt: 3 },
          { id: 'b2', owner: 'bob', createdAt: 4 },
        ],
      });
    const ranked = makeHarness();

    await expect(
      ranked.service.putLegacyOrder({ owner: 'admin', isAdmin: true }, ['a2', 'b2', 'a1', 'b1'])
    ).resolves.toEqual({
      order: ['a2', 'b2', 'a1', 'b1'],
      changedOwnerOrders: { alice: ['a2', 'a1'], bob: ['b2', 'b1'] },
      globalOrder: ['a2', 'b2', 'a1', 'b1'],
      globalChanged: true,
    });
    expect(Object.keys(ranked.store.commitTabLayoutProjection.mock.calls[0][0])).toEqual(['alice', 'bob']);
    expect(ranked.layouts.alice.version).toBe(8);
    expect(ranked.layouts.bob.version).toBe(8);

    const interleaved = makeHarness();
    await expect(
      interleaved.service.putLegacyOrder({ owner: 'admin', isAdmin: true }, ['b1', 'a1', 'b2', 'a2'])
    ).resolves.toEqual({
      order: ['b1', 'a1', 'b2', 'a2'],
      changedOwnerOrders: {},
      globalOrder: ['b1', 'a1', 'b2', 'a2'],
      globalChanged: true,
    });
    expect(interleaved.store.commitTabLayoutProjection.mock.calls[0][0]).toEqual({});
    expect(interleaved.layouts.alice.version).toBe(7);
    expect(interleaved.layouts.bob.version).toBe(7);
  });

  it('admin preserves requested owner slots while canonical grouped owner order wins', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([{ kind: 'session', id: 'a2' }]),
          groups: [{ id: 'fixed', name: 'Fixed', refs: [{ kind: 'session', id: 'a1' }] }],
        },
        bob: existing([
          { kind: 'session', id: 'b1' },
          { kind: 'session', id: 'b2' },
        ]),
      },
      order: ['a1', 'b1', 'a2', 'b2'],
      live: [
        { id: 'a1', owner: 'alice', createdAt: 1 },
        { id: 'b1', owner: 'bob', createdAt: 2 },
        { id: 'a2', owner: 'alice', createdAt: 3 },
        { id: 'b2', owner: 'bob', createdAt: 4 },
      ],
    });

    const result = await h.service.putLegacyOrder({ owner: 'admin', isAdmin: true }, ['b2', 'a2', 'b1', 'a1']);

    expect(result.globalOrder).toEqual(['b2', 'a1', 'b1', 'a2']);
    expect(result.order).toEqual(result.globalOrder);
    expect(result.changedOwnerOrders).toEqual({ bob: ['b2', 'b1'] });
    expect(h.layouts.alice.version).toBe(7);
    expect(h.layouts.bob.version).toBe(8);
  });

  it('admin publishes prototype-like owner keys as own layout entries', async () => {
    const owner = '__proto__';
    const h = createHarness({
      layouts: {
        [owner]: existing([
          { kind: 'session', id: 'p1' },
          { kind: 'session', id: 'p2' },
        ]),
      },
      order: ['p1', 'p2'],
      live: [
        { id: 'p1', owner, createdAt: 1 },
        { id: 'p2', owner, createdAt: 2 },
      ],
    });

    await h.service.putLegacyOrder({ owner: 'admin', isAdmin: true }, ['p2', 'p1']);

    const updates = h.store.commitTabLayoutProjection.mock.calls[0][0];
    expect(Object.hasOwn(updates, owner)).toBe(true);
    expect(h.layouts[owner].version).toBe(8);
    expect(h.layouts[owner].ungrouped.map((ref) => ref.id)).toEqual(['p2', 'p1']);
  });

  it('admin retries owner discovery when a new trusted owner appears while queues are pending', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'a1' }]) },
      order: ['a1'],
      live: [{ id: 'a1', owner: 'alice', createdAt: 1 }],
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.readWebviews.mockImplementationOnce(async () => {
      await blocked;
      return [];
    });
    const occupied = h.service.get('alice');
    await vi.waitFor(() => expect(h.readWebviews).toHaveBeenCalledOnce());

    const admin = h.service.putLegacyOrder({ owner: 'admin', isAdmin: true }, ['b1', 'a1']);
    h.live.set('b1', { id: 'b1', owner: 'bob', createdAt: 2 } as never);
    release();

    await occupied;
    await expect(admin).resolves.toMatchObject({ globalOrder: ['b1', 'a1'] });
    expect(h.layouts.bob).toMatchObject({ version: 0, ungrouped: [{ kind: 'session', id: 'b1' }] });
    expect(Object.hasOwn(h.store.commitTabLayoutProjection.mock.calls.at(-1)![0], 'bob')).toBe(true);
  });
});

describe('TabLayoutService grouped session creation', () => {
  const grouped = (version = 7): TabLayout => ({
    version,
    groups: [
      { id: 'g1', name: 'Core', refs: [{ kind: 'session', id: 'a' }] },
      { id: 'g2', name: 'Ops', refs: [] },
    ],
    ungrouped: [{ kind: 'session', id: 'b' }],
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
  const facts = (owner = 'alice') => [
    { id: 'a', owner, createdAt: 1 },
    { id: 'b', owner, createdAt: 2 },
  ];
  /** Registers `id` the way server.ts does: inside the owner lock, with a rollback. */
  const register = (h: ReturnType<typeof createHarness>, fact: SessionFact) =>
    vi.fn(() => {
      h.live.set(fact.id, fact as never);
      return () => h.live.delete(fact.id);
    });

  it('places a new session at the end of the requested group in ONE versioned write', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const added = register(h, { id: 'new', owner: 'alice', createdAt: 3 });

    const layout = await h.service.sessionCreated('alice', 'new', { tabGroupId: 'g1' }, added);

    expect(added).toHaveBeenCalledOnce();
    expect(layout.version).toBe(8);
    expect(layout.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'new' },
    ]);
    expect(layout.ungrouped).toEqual([{ kind: 'session', id: 'b' }]);
    expect(h.layouts.alice).toEqual(layout);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.broadcast.mock.calls.filter(([event]) => event === SseEvent.TabLayoutChanged)).toEqual([
      [SseEvent.TabLayoutChanged, { owner: 'alice', version: 8 }],
    ]);
  });

  it('registers the session INSIDE the owner lock, so a queued edit cannot commit it first', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts(), order: ['a', 'b'] });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    h.readWebviews.mockImplementationOnce(async () => {
      await blocked;
      return [];
    });
    const occupied = h.service.get('alice');
    await vi.waitFor(() => expect(h.readWebviews).toHaveBeenCalledOnce());
    const added = register(h, { id: 'new', owner: 'alice', createdAt: 3 });

    const created = h.service.sessionCreated('alice', 'new', { tabGroupId: 'g2' }, added);
    await Promise.resolve();
    expect(added).not.toHaveBeenCalled();
    release();
    await occupied;
    const layout = await created;

    expect(layout.groups[1].refs).toEqual([{ kind: 'session', id: 'new' }]);
    // The queued read committed nothing; the creation is the only write.
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(layout.version).toBe(8);
  });

  it('treats an unknown group as a hint, not an error: the session lands where it normally would', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const layout = await h.service.sessionCreated(
      'alice',
      'new',
      { tabGroupId: 'gone' },
      register(h, { id: 'new', owner: 'alice', createdAt: 3 })
    );
    expect(layout.ungrouped.map((ref) => ref.id)).toEqual(['b', 'new']);
    expect(layout.groups.flatMap((group) => group.refs.map((ref) => ref.id))).toEqual(['a']);
  });

  it("never places a session into another owner's group", async () => {
    const h = createHarness({
      layouts: { alice: grouped(), bob: existing([{ kind: 'session', id: 'bob-1' }], 3) },
      live: [...facts(), { id: 'bob-1', owner: 'bob', createdAt: 4 }],
    });
    const layout = await h.service.sessionCreated(
      'bob',
      'bob-new',
      { tabGroupId: 'g1' },
      register(h, { id: 'bob-new', owner: 'bob', createdAt: 5 })
    );
    expect(layout.groups).toEqual([]);
    expect(layout.ungrouped.map((ref) => ref.id)).toEqual(['bob-1', 'bob-new']);
    expect(h.layouts.alice).toEqual(grouped());
  });

  it('with the follow setting on, a child follows its parent; an explicit group pins it manual', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts(), follow: true });
    const followed = await h.service.sessionCreated(
      'alice',
      'child',
      {},
      register(h, { id: 'child', owner: 'alice', createdAt: 3, parentSessionId: 'a' })
    );
    expect(followed.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'child' },
    ]);

    const pinned = await h.service.sessionCreated(
      'alice',
      'child-2',
      { tabGroupId: 'g2' },
      register(h, { id: 'child-2', owner: 'alice', createdAt: 4, parentSessionId: 'a' })
    );
    expect(pinned.groups[1].refs).toEqual([{ kind: 'session', id: 'child-2', placement: 'manual' }]);
    // Move ONLY the parent: the following child goes with it, the hand-placed one stays.
    const moved = await h.service.put(
      'alice',
      {
        ...pinned,
        groups: [{ ...pinned.groups[0], refs: [{ kind: 'session', id: 'child' }] }, pinned.groups[1]],
        ungrouped: [...pinned.ungrouped, { kind: 'session', id: 'a' }],
      },
      pinned.version
    );
    expect(moved.layout.groups[0].refs).toEqual([]);
    expect(moved.layout.groups[1].refs).toEqual([{ kind: 'session', id: 'child-2', placement: 'manual' }]);
    expect(moved.layout.ungrouped).toEqual([
      { kind: 'session', id: 'b' },
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'child' },
    ]);
  });

  it('with the follow setting off (the default), a child lands after its parent once and is hand-placed', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const created = await h.service.sessionCreated(
      'alice',
      'child',
      {},
      register(h, { id: 'child', owner: 'alice', createdAt: 3, parentSessionId: 'a' })
    );
    // Same place as a following child, in ONE write, but pinned there.
    expect(created.version).toBe(8);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(created.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'child', placement: 'manual' },
    ]);
    const moved = await h.service.put(
      'alice',
      {
        ...created,
        groups: [{ ...created.groups[0], refs: [created.groups[0].refs[1]] }, created.groups[1]],
        ungrouped: [...created.ungrouped, { kind: 'session', id: 'a' }],
      },
      created.version
    );
    expect(moved.layout.groups[0].refs).toEqual([{ kind: 'session', id: 'child', placement: 'manual' }]);
    expect(moved.layout.ungrouped.map((ref) => ref.id)).toEqual(['b', 'a']);
  });

  it('reads the follow setting fresh at every creation', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const setting = vi.fn<() => boolean>().mockReturnValueOnce(true).mockReturnValueOnce(false);
    (h.service as unknown as { deps: { childrenFollowParent: typeof setting } }).deps.childrenFollowParent = setting;
    await h.service.sessionCreated(
      'alice',
      'c1',
      {},
      register(h, { id: 'c1', owner: 'alice', createdAt: 3, parentSessionId: 'a' })
    );
    const layout = await h.service.sessionCreated(
      'alice',
      'c2',
      {},
      register(h, { id: 'c2', owner: 'alice', createdAt: 4, parentSessionId: 'a' })
    );
    expect(setting).toHaveBeenCalledTimes(2);
    expect(layout.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'c1' },
      { kind: 'session', id: 'c2', placement: 'manual' },
    ]);
  });

  it('a session without a parent is never pinned, whatever the setting', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const layout = await h.service.sessionCreated(
      'alice',
      'plain',
      {},
      register(h, { id: 'plain', owner: 'alice', createdAt: 3 })
    );
    expect(layout.ungrouped).toEqual([
      { kind: 'session', id: 'b' },
      { kind: 'session', id: 'plain' },
    ]);
  });

  it('rolls the registration back when the layout write fails', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.store.commitTabLayoutProjection.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const added = register(h, { id: 'new', owner: 'alice', createdAt: 3 });
    await expect(h.service.sessionCreated('alice', 'new', { tabGroupId: 'g1' }, added)).rejects.toThrow('disk full');
    expect(added).toHaveBeenCalledOnce();
    expect(h.live.has('new')).toBe(false);
    expect(h.layouts.alice).toEqual(grouped());
  });
});

describe('TabLayoutService legacy order PUTs keep a following child following', () => {
  const family = (): TabLayout => ({
    version: 4,
    groups: [
      {
        id: 'g1',
        name: 'Core',
        refs: [
          { kind: 'session', id: 'x' },
          { kind: 'session', id: 'p' },
          { kind: 'session', id: 'kid' },
        ],
      },
    ],
    ungrouped: [{ kind: 'session', id: 'y' }],
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
  const live = [
    { id: 'x', owner: 'alice', createdAt: 1 },
    { id: 'p', owner: 'alice', createdAt: 2 },
    { id: 'kid', owner: 'alice', createdAt: 3, parentSessionId: 'p' },
    { id: 'y', owner: 'alice', createdAt: 4 },
  ];

  for (const actor of [
    { owner: 'alice', isAdmin: false },
    { owner: 'admin', isAdmin: true },
  ]) {
    it(`a PUT of the current order leaves placement alone (${actor.isAdmin ? 'admin' : 'owner'})`, async () => {
      const h = createHarness({ layouts: { alice: family() }, live, order: ['x', 'p', 'kid', 'y'] });
      await h.service.putLegacyOrder(actor, ['x', 'p', 'kid', 'y']);
      expect(h.layouts.alice).toEqual(family());
      expect(h.store.commitTabLayoutProjection.mock.calls.every(([updates]) => !Object.hasOwn(updates, 'alice'))).toBe(
        true
      );
    });
  }

  it('a reorder that keeps the child after its parent keeps it following, so it moves with its parent', async () => {
    const h = createHarness({ layouts: { alice: family() }, live, order: ['x', 'p', 'kid', 'y'] });
    await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['p', 'kid', 'x', 'y']);
    expect(h.layouts.alice.groups[0].refs).toEqual([
      { kind: 'session', id: 'p' },
      { kind: 'session', id: 'kid' },
      { kind: 'session', id: 'x' },
    ]);
    // Still following: moving only the parent takes the child along.
    const current = h.layouts.alice;
    const moved = await h.service.put(
      'alice',
      {
        ...current,
        groups: [{ ...current.groups[0], refs: [current.groups[0].refs[1], current.groups[0].refs[2]] }],
        ungrouped: [...current.ungrouped, { kind: 'session', id: 'p' }],
      },
      current.version
    );
    expect(moved.layout.ungrouped.map((ref) => ref.id)).toEqual(['y', 'p', 'kid']);
    expect(moved.layout.groups[0].refs).toEqual([{ kind: 'session', id: 'x' }]);
  });

  it('a reorder that splits the child from its parent pins it', async () => {
    const h = createHarness({ layouts: { alice: family() }, live, order: ['x', 'p', 'kid', 'y'] });
    await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['kid', 'x', 'p', 'y']);
    expect(h.layouts.alice.groups[0].refs).toEqual([
      { kind: 'session', id: 'kid', placement: 'manual' },
      { kind: 'session', id: 'x' },
      { kind: 'session', id: 'p' },
    ]);
  });
});
