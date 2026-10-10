/**
 * @fileoverview The Focus flag on owner tab layout refs, server side.
 *
 * A session or web-tab ref may carry `focus: true` (src/tab-layout.ts): the
 * browser then draws a shortcut to it in a pinned "Focus" section at the top of
 * the vertical rail, while the ref itself stays where it is stored. These tests
 * pin that the flag is parsed strictly, and that nothing on the server drops it:
 * normalization, the pure edit helpers, TabLayoutService (PUT, legacy order,
 * deletions, reconciliation), the legacy-order projection, and StateStore's
 * persistence across a reload. Multi-user owner scoping is unchanged.
 *
 * Port: none (Fastify inject, temp state file).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { applyLegacySessionRank } from '../src/tab-layout-legacy-order.js';
import { normalizeOrMigrateOwnerTabLayout } from '../src/tab-layout-persistence.js';
import { TabLayoutService } from '../src/tab-layout-service.js';
import {
  deleteGroup,
  followParent,
  materializeOrphans,
  moveRef,
  normalizeTabLayout,
  setTabFocus,
  TabLayoutValidationError,
  validateTabLayout,
  type TabLayout,
  type TabRefMetadata,
} from '../src/tab-layout.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { registerTabLayoutRoutes } from '../src/web/routes/tab-layout-routes.js';

const at = '2026-10-09T00:00:00.000Z';
const session = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'session' as const, id, ...extra });
const webview = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'webview' as const, id, ...extra });

const meta = (
  id: string,
  order: number,
  extra: Partial<TabRefMetadata> = {},
  kind: 'session' | 'webview' = 'session'
): TabRefMetadata => ({ kind, id, ownerValid: true, visible: true, order, ...extra });

/** Every ref that carries the flag, as `kind:id`, in stored order. */
const focused = (layout: TabLayout): string[] =>
  [...layout.groups.flatMap((group) => group.refs), ...layout.ungrouped]
    .filter((ref) => ref.focus === true)
    .map((ref) => `${ref.kind}:${ref.id}`);

const base = (): TabLayout => ({
  version: 3,
  updatedAt: at,
  groups: [
    { id: 'g1', name: 'Core', refs: [session('a', { focus: true }), webview('w', { focus: true })] },
    { id: 'g2', name: 'Ops', refs: [session('b')] },
  ],
  ungrouped: [session('c', { placement: 'manual', focus: true }), session('d')],
});

const metadata: TabRefMetadata[] = [
  meta('a', 0),
  meta('b', 1),
  meta('c', 2),
  meta('d', 3),
  meta('w', 4, {}, 'webview'),
];

describe('model: parsing the focus flag', () => {
  it('keeps focus: true on session and webview refs, beside placement', () => {
    const parsed = validateTabLayout(base());
    expect(parsed.groups[0].refs).toEqual([session('a', { focus: true }), webview('w', { focus: true })]);
    expect(parsed.ungrouped[0]).toEqual({ kind: 'session', id: 'c', placement: 'manual', focus: true });
    expect(parsed.ungrouped[1]).toEqual({ kind: 'session', id: 'd' });
  });

  it.each([false, 'true', 1, null, {}])('rejects focus: %j (only true or absent is valid)', (value) => {
    const input = { ...base(), ungrouped: [session('d', { focus: value })] };
    expect(() => validateTabLayout(input)).toThrow(TabLayoutValidationError);
    expect(() => validateTabLayout(input)).toThrow(/focus/);
  });

  it('a ref with no focus key gets no focus key back (absent, never false)', () => {
    const parsed = validateTabLayout({ ...base(), groups: [], ungrouped: [session('d')] });
    expect(Object.keys(parsed.ungrouped[0]).sort()).toEqual(['id', 'kind']);
  });
});

describe('model: the flag survives every pure edit', () => {
  it('normalizeTabLayout keeps focus, including on lineage-reordered children', () => {
    const layout: TabLayout = {
      version: 1,
      updatedAt: at,
      groups: [],
      ungrouped: [session('child', { focus: true }), session('parent')],
    };
    const normalized = normalizeTabLayout(layout, [meta('parent', 0), meta('child', 1, { parentSessionId: 'parent' })]);
    // The child follows its parent now, and still carries the flag.
    expect(normalized.ungrouped).toEqual([session('parent'), session('child', { focus: true })]);
  });

  it('normalizeTabLayout prunes a focused ref whose session is known to be gone', () => {
    const normalized = normalizeTabLayout(base(), [...metadata, meta('a', 0, { ownerValid: false })].slice(1));
    expect(focused(normalized)).toEqual(['webview:w', 'session:c']);
  });

  it('moveRef across groups keeps the moved ref and its followers focused', () => {
    const withChild: TabLayout = {
      ...base(),
      groups: [
        { id: 'g1', name: 'Core', refs: [session('a', { focus: true }), session('kid', { focus: true })] },
        { id: 'g2', name: 'Ops', refs: [session('b')] },
      ],
      ungrouped: [],
    };
    const facts = [meta('a', 0), meta('kid', 1, { parentSessionId: 'a' }), meta('b', 2)];
    const moved = moveRef(withChild, session('a'), { groupId: 'g2', index: 1 }, facts);
    expect(moved.groups[1].refs).toEqual([
      session('b'),
      session('a', { focus: true }),
      session('kid', { focus: true }),
    ]);
  });

  it('followParent clears manual placement but keeps focus', () => {
    const layout: TabLayout = {
      version: 1,
      updatedAt: at,
      groups: [],
      ungrouped: [session('parent'), session('other'), session('kid', { placement: 'manual', focus: true })],
    };
    const facts = [meta('parent', 0), meta('other', 1), meta('kid', 2, { parentSessionId: 'parent' })];
    const result = followParent(layout, session('kid'), facts);
    expect(result.ungrouped).toEqual([session('parent'), session('kid', { focus: true }), session('other')]);
  });

  it('deleteGroup and materializeOrphans keep focus on the refs they move or pin', () => {
    expect(focused(deleteGroup(base(), 'g1'))).toEqual(['session:c', 'session:a', 'webview:w']);
    const orphaned = materializeOrphans(
      { ...base(), ungrouped: [session('p'), session('kid', { focus: true })] },
      ['p'],
      [...metadata, meta('p', 5), meta('kid', 6, { parentSessionId: 'p' })]
    );
    expect(orphaned.ungrouped).toEqual([session('kid', { placement: 'manual', focus: true })]);
  });

  it('setTabFocus adds and removes the flag on one ref without moving anything', () => {
    const added = setTabFocus(base(), session('b'), true);
    expect(focused(added)).toEqual(['session:a', 'webview:w', 'session:b', 'session:c']);
    const removed = setTabFocus(added, session('c'), false);
    expect(removed.ungrouped[0]).toEqual({ kind: 'session', id: 'c', placement: 'manual' });
    expect(removed.groups.map((group) => group.refs.map((ref) => ref.id))).toEqual([['a', 'w'], ['b']]);
    // Idempotent both ways.
    expect(setTabFocus(added, session('b'), true)).toEqual(added);
    expect(setTabFocus(base(), session('d'), false)).toEqual(validateTabLayout(base()));
    expect(() => setTabFocus(base(), session('nope'), true)).toThrow(/unknown ref/);
  });
});

describe('legacy order projection', () => {
  it('applyLegacySessionRank re-ranks focused sessions without dropping the flag', () => {
    const ranked = applyLegacySessionRank(base(), ['d', 'c', 'b', 'a'], metadata);
    expect(ranked.ungrouped).toEqual([session('d'), session('c', { placement: 'manual', focus: true })]);
    expect(focused(ranked)).toEqual(['session:a', 'webview:w', 'session:c']);
  });

  it('migration of an existing layout keeps focus', () => {
    const result = normalizeOrMigrateOwnerTabLayout({
      owner: '@single',
      layouts: { '@single': base() },
      sessionOrder: [],
      persistedSessions: [],
      liveSessions: ['a', 'b', 'c', 'd'].map((id, index) => ({ id, createdAt: index })),
      webviews: [{ id: 'w' }],
      updatedAt: at,
    });
    expect(focused(result.layout)).toEqual(['session:a', 'webview:w', 'session:c']);
  });
});

type SessionFact = { id: string; owner?: string; createdAt: number; parentSessionId?: string };

function createService(
  options: {
    layouts?: Record<string, TabLayout>;
    live?: SessionFact[];
    webviews?: Array<{ id: string; owner?: string }>;
  } = {}
) {
  const layouts = structuredClone(options.layouts ?? {});
  const order: string[] = [];
  const webviews = [...(options.webviews ?? [])];
  const live = new Map((options.live ?? []).map((record) => [record.id, record]));
  const store = {
    getTabLayout: (owner: string) => structuredClone(layouts[owner] ?? null),
    getTabLayouts: () => structuredClone(layouts),
    getSessions: () => ({}),
    getSessionOrder: () => [...order],
    commitTabLayoutProjection: (
      updates: Readonly<Record<string, TabLayout>>,
      project: (latest: readonly string[]) => readonly string[]
    ) => {
      const projected = [...project([...order])];
      Object.assign(layouts, structuredClone(updates));
      order.splice(0, order.length, ...projected);
      return { layouts: structuredClone(updates), sessionOrder: [...order] };
    },
  };
  const service = new TabLayoutService({
    store: store as never,
    sessions: live as never,
    readWebviews: async () => webviews,
    broadcast: vi.fn(),
    broadcastSessionOrder: vi.fn(),
    now: () => at,
  });
  service.markRestorationComplete();
  return { service, layouts, live, webviews };
}

const liveFacts = (owner?: string): SessionFact[] =>
  ['a', 'b', 'c', 'd'].map((id, index) => ({ id, owner, createdAt: index }));

describe('TabLayoutService keeps focus', () => {
  it('stores focus from a PUT and returns it from GET', async () => {
    const h = createService({ layouts: { '@single': base() }, live: liveFacts(), webviews: [{ id: 'w' }] });
    const current = await h.service.get('@single');
    expect(focused(current)).toEqual(['session:a', 'webview:w', 'session:c']);
    const result = await h.service.put('@single', setTabFocus(current, session('d'), true), current.version);
    expect(result.status).toBe('updated');
    expect(focused(await h.service.get('@single'))).toEqual(['session:a', 'webview:w', 'session:c', 'session:d']);
  });

  it('keeps focus on a ref a PUT moves into another group', async () => {
    const h = createService({ layouts: { '@single': base() }, live: liveFacts(), webviews: [{ id: 'w' }] });
    const current = await h.service.get('@single');
    // The browser's moveRef: `a` (focused) leaves g1 for the end of g2.
    const desired: TabLayout = {
      ...current,
      groups: [
        { ...current.groups[0], refs: [webview('w', { focus: true })] },
        { ...current.groups[1], refs: [session('b'), session('a', { focus: true })] },
      ],
    };
    const result = await h.service.put('@single', desired, current.version);
    expect(result.layout.groups[1].refs).toEqual([session('b'), session('a', { focus: true })]);
    expect(focused(h.layouts['@single'])).toEqual(['webview:w', 'session:a', 'session:c']);
  });

  it('keeps focus through a legacy session-order PUT (reordering)', async () => {
    const h = createService({ layouts: { '@single': base() }, live: liveFacts(), webviews: [{ id: 'w' }] });
    await h.service.putLegacyOrder({ owner: '@single', isAdmin: true }, ['d', 'c', 'b', 'a']);
    expect(focused(h.layouts['@single'])).toEqual(['session:a', 'webview:w', 'session:c']);
    expect(h.layouts['@single'].ungrouped.map((ref) => ref.id)).toEqual(['d', 'c']);
  });

  it('a deleted session takes its focus flag with it and leaves the others alone', async () => {
    const h = createService({ layouts: { '@single': base() }, live: liveFacts(), webviews: [{ id: 'w' }] });
    await h.service.get('@single');
    await h.service.runSessionDeletion([{ id: 'a' }], async () => {
      h.live.delete('a');
    });
    expect(focused(h.layouts['@single'])).toEqual(['webview:w', 'session:c']);
  });

  it('a deleted web tab takes its focus flag with it', async () => {
    const h = createService({ layouts: { '@single': base() }, live: liveFacts(), webviews: [{ id: 'w' }] });
    await h.service.get('@single');
    h.webviews.splice(0);
    await h.service.webviewDeleted('@single', 'w');
    expect(focused(h.layouts['@single'])).toEqual(['session:a', 'session:c']);
  });

  it('multi-user: focus is per owner, and a PUT naming a foreign ref is still refused', async () => {
    const aliceLayout: TabLayout = {
      version: 1,
      updatedAt: at,
      groups: [],
      ungrouped: [session('a', { focus: true })],
    };
    const h = createService({
      layouts: { alice: aliceLayout },
      live: [
        { id: 'a', owner: 'alice', createdAt: 0 },
        { id: 'b', owner: 'bob', createdAt: 1 },
      ],
    });
    const bob = await h.service.get('bob');
    expect(focused(bob)).toEqual([]);
    expect(focused(await h.service.get('alice'))).toEqual(['session:a']);
    await expect(
      h.service.put('bob', { ...bob, ungrouped: [session('b'), session('a', { focus: true })] }, bob.version)
    ).rejects.toThrow(/not owned/);
    await h.service.put('bob', setTabFocus(bob, session('b'), true), bob.version);
    expect(focused(h.layouts.bob)).toEqual(['session:b']);
    expect(focused(h.layouts.alice)).toEqual(['session:a']);
  });
});

describe('persistence and the HTTP route', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('PUT /api/tab-layout with focus round-trips through GET and a StateStore reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeman-tab-focus-'));
    dirs.push(dir);
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({}));
    const store = new StateStore(file);
    const live = new Map(liveFacts().map((record) => [record.id, record]));
    const service = new TabLayoutService({
      store,
      sessions: live,
      readWebviews: async () => [],
      broadcast: () => undefined,
      broadcastSessionOrder: () => undefined,
      now: () => at,
    });
    service.markRestorationComplete();
    const app = Fastify({ logger: false });
    registerTabLayoutRoutes(app, { tabLayouts: service } as never);
    installRouteErrorHandler(app);
    await app.ready();
    vi.stubEnv('CODEMAN_MULTIUSER', '0');
    try {
      const read = await app.inject({ method: 'GET', url: '/api/tab-layout' });
      const layout = read.json().data.layout as TabLayout;
      const put = await app.inject({
        method: 'PUT',
        url: '/api/tab-layout',
        payload: { baseVersion: layout.version, layout: setTabFocus(layout, session('b'), true) },
      });
      expect(put.statusCode).toBe(200);
      expect(focused(put.json().data.layout)).toEqual(['session:b']);
      const refused = await app.inject({
        method: 'PUT',
        url: '/api/tab-layout',
        payload: {
          baseVersion: put.json().data.layout.version,
          layout: { ...put.json().data.layout, ungrouped: [session('a', { focus: false })] },
        },
      });
      expect(refused.statusCode).toBe(400);
      store.saveNow();
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
    // A fresh store over the same file: what a restart would read.
    expect(focused(new StateStore(file).getTabLayout('@single')!)).toEqual(['session:b']);
  });
});
