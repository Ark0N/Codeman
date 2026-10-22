/**
 * @fileoverview Per-case default session group: the state.json store and the
 * TabLayoutService placement precedence (explicit group > parent > case default > none).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/state-store.js';
import { TabLayoutService } from '../src/tab-layout-service.js';
import { TabLayoutValidationError, type TabLayout } from '../src/tab-layout.js';

type SessionFact = { id: string; owner?: string; createdAt: number; parentSessionId?: string };

describe('StateStore case default groups', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-case-default-'));
    file = join(dir, 'state.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('distinguishes unset from an intentional Ungrouped choice, per owner', () => {
    const store = new StateStore(file);
    expect(store.getCaseDefaultGroup('@single', 'app')).toBeUndefined();
    store.setCaseDefaultGroup('@single', 'app', 'g1');
    store.setCaseDefaultGroup('@single', 'other', null);
    store.setCaseDefaultGroup('bob', 'app', 'g9');
    expect(store.getCaseDefaultGroup('@single', 'app')).toBe('g1');
    expect(store.getCaseDefaultGroup('@single', 'other')).toBeNull();
    expect(store.getCaseDefaultGroup('bob', 'app')).toBe('g9');
    expect(store.getCaseDefaultGroup('alice', 'app')).toBeUndefined();
  });

  it('survives a save and reload (persistence round-trip)', () => {
    const store = new StateStore(file);
    store.setCaseDefaultGroup('@single', 'app', 'g1');
    store.setCaseDefaultGroup('@single', 'none', null);
    store.saveNow();
    const disk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(disk.caseDefaultGroups).toEqual({ '@single': { app: 'g1', none: null } });
    const reloaded = new StateStore(file);
    expect(reloaded.getCaseDefaultGroup('@single', 'app')).toBe('g1');
    expect(reloaded.getCaseDefaultGroup('@single', 'none')).toBeNull();
  });

  it('forgets one owner mapping without touching another owner', () => {
    const store = new StateStore(file);
    store.setCaseDefaultGroup('alice', 'app', 'g1');
    store.setCaseDefaultGroup('bob', 'app', 'g2');
    store.deleteCaseDefaultGroup('alice', 'app');
    expect(store.getCaseDefaultGroup('alice', 'app')).toBeUndefined();
    expect(store.getCaseDefaultGroup('bob', 'app')).toBe('g2');
  });

  it('reads a malformed on-disk value as unset instead of throwing', () => {
    writeFileSync(
      file,
      JSON.stringify({ sessions: {}, caseDefaultGroups: { '@single': { app: 42, ok: 'g1' }, bad: 'x' } })
    );
    const store = new StateStore(file);
    expect(store.getCaseDefaultGroup('@single', 'app')).toBeUndefined();
    expect(store.getCaseDefaultGroup('@single', 'ok')).toBe('g1');
    expect(store.getCaseDefaultGroup('bad', 'app')).toBeUndefined();
    expect(store.getCaseDefaultGroup('@single', '__proto__')).toBeUndefined();
  });
});

function createHarness(options: { layouts?: Record<string, TabLayout>; live?: SessionFact[]; follow?: boolean } = {}) {
  const layouts = { ...(options.layouts ?? {}) };
  const live = new Map((options.live ?? []).map((session) => [session.id, session]));
  const order: string[] = [];
  const defaults: Record<string, Record<string, string | null>> = {};
  const caseDefaults = {
    getCaseDefaultGroup: vi.fn((owner: string, caseName: string) =>
      defaults[owner] && caseName in defaults[owner] ? defaults[owner][caseName] : undefined
    ),
    setCaseDefaultGroup: vi.fn((owner: string, caseName: string, groupId: string | null) => {
      defaults[owner] = { ...(defaults[owner] ?? {}), [caseName]: groupId };
    }),
    deleteCaseDefaultGroup: vi.fn((owner: string, caseName: string) => {
      if (defaults[owner]) delete defaults[owner][caseName];
    }),
  };
  const store = {
    getTabLayout: vi.fn((owner: string) => layouts[owner] ?? null),
    getTabLayouts: vi.fn(() => ({ ...layouts })),
    getSessions: vi.fn(() => ({})),
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
  const service = new TabLayoutService({
    store: store as never,
    sessions: live as never,
    readWebviews: vi.fn(async () => []),
    broadcast: vi.fn(),
    broadcastSessionOrder: vi.fn(),
    childrenFollowParent: vi.fn(() => options.follow === true),
    caseDefaults,
    now: () => '2026-10-22T12:00:00.000Z',
  });
  const register = (fact: SessionFact) =>
    vi.fn(() => {
      live.set(fact.id, fact);
      return () => live.delete(fact.id);
    });
  return { service, store, layouts, live, defaults, caseDefaults, register };
}

const grouped = (version = 7): TabLayout => ({
  version,
  groups: [
    { id: 'g1', name: 'Core', refs: [{ kind: 'session', id: 'a' }] },
    { id: 'g2', name: 'Ops', refs: [] },
  ],
  ungrouped: [{ kind: 'session', id: 'b' }],
  updatedAt: '2026-10-21T00:00:00.000Z',
});
const facts = (owner = 'alice'): SessionFact[] => [
  { id: 'a', owner, createdAt: 1 },
  { id: 'b', owner, createdAt: 2 },
];
const idsIn = (layout: TabLayout, groupId: string | null): string[] =>
  (groupId === null ? layout.ungrouped : (layout.groups.find((g) => g.id === groupId)?.refs ?? [])).map((r) => r.id);

describe('TabLayoutService case default placement', () => {
  it('places a session for the case into its default group in the creating write', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: 'g2' };
    const layout = await h.service.sessionCreated(
      'alice',
      'new',
      { caseName: 'app' },
      h.register({ id: 'new', owner: 'alice', createdAt: 3 })
    );
    expect(idsIn(layout, 'g2')).toEqual(['new']);
    expect(idsIn(layout, null)).toEqual(['b']);
    expect(layout.version).toBe(8);
    // One versioned write: no transient Ungrouped layout was ever committed.
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
  });

  it('an explicit tabGroupId wins over the case default', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: 'g2' };
    const layout = await h.service.sessionCreated(
      'alice',
      'new',
      { caseName: 'app', tabGroupId: 'g1' },
      h.register({ id: 'new', owner: 'alice', createdAt: 3 })
    );
    expect(idsIn(layout, 'g1')).toEqual(['a', 'new']);
    expect(idsIn(layout, 'g2')).toEqual([]);
  });

  it('an unknown explicit group falls through to the case default', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: 'g2' };
    const layout = await h.service.sessionCreated(
      'alice',
      'new',
      { caseName: 'app', tabGroupId: 'gone' },
      h.register({ id: 'new', owner: 'alice', createdAt: 3 })
    );
    expect(idsIn(layout, 'g2')).toEqual(['new']);
  });

  it.each([true, false])('the parent placement wins over the case default (follow=%s)', async (follow) => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts(), follow });
    h.defaults.alice = { app: 'g2' };
    const layout = await h.service.sessionCreated(
      'alice',
      'child',
      { caseName: 'app' },
      h.register({ id: 'child', owner: 'alice', createdAt: 3, parentSessionId: 'a' })
    );
    expect(idsIn(layout, 'g1')).toEqual(['a', 'child']);
    expect(idsIn(layout, 'g2')).toEqual([]);
  });

  it('a parent that is not in the layout does not block the case default', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: 'g2' };
    const layout = await h.service.sessionCreated(
      'alice',
      'orphan',
      { caseName: 'app' },
      h.register({ id: 'orphan', owner: 'alice', createdAt: 3, parentSessionId: 'nobody' })
    );
    expect(idsIn(layout, 'g2')).toEqual(['orphan']);
  });

  it('an intentional Ungrouped default (null) or no default leaves the session ungrouped', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: null };
    const first = await h.service.sessionCreated(
      'alice',
      'n1',
      { caseName: 'app' },
      h.register({ id: 'n1', owner: 'alice', createdAt: 3 })
    );
    expect(idsIn(first, null)).toEqual(['b', 'n1']);
    const second = await h.service.sessionCreated(
      'alice',
      'n2',
      { caseName: 'unset' },
      h.register({ id: 'n2', owner: 'alice', createdAt: 4 })
    );
    expect(idsIn(second, null)).toEqual(['b', 'n1', 'n2']);
  });

  it('a deleted default group never fails creation: Ungrouped, and the stale value is cleared', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: 'deleted-group' };
    const layout = await h.service.sessionCreated(
      'alice',
      'new',
      { caseName: 'app' },
      h.register({ id: 'new', owner: 'alice', createdAt: 3 })
    );
    expect(idsIn(layout, null)).toEqual(['b', 'new']);
    expect(h.caseDefaults.getCaseDefaultGroup('alice', 'app')).toBeUndefined();
  });

  it("never applies another owner's group id", async () => {
    const h = createHarness({
      layouts: { alice: grouped(), bob: { ...grouped(3), groups: [], ungrouped: [] } },
      live: [...facts()],
    });
    // A value naming alice's group, stored under bob, is not found in bob's layout.
    h.defaults.bob = { app: 'g1' };
    const layout = await h.service.sessionCreated(
      'bob',
      'bob-new',
      { caseName: 'app' },
      h.register({ id: 'bob-new', owner: 'bob', createdAt: 5 })
    );
    expect(layout.groups).toEqual([]);
    expect(idsIn(layout, null)).toEqual(['bob-new']);
    expect(idsIn(h.layouts.alice, 'g1')).toEqual(['a']);
  });

  it('a renamed group keeps receiving sessions (the default is the stable id)', async () => {
    const renamed = grouped();
    renamed.groups[1] = { ...renamed.groups[1], name: 'Operations' };
    const h = createHarness({ layouts: { alice: renamed }, live: facts() });
    h.defaults.alice = { app: 'g2' };
    const layout = await h.service.sessionCreated(
      'alice',
      'new',
      { caseName: 'app' },
      h.register({ id: 'new', owner: 'alice', createdAt: 3 })
    );
    expect(layout.groups[1]).toMatchObject({ id: 'g2', name: 'Operations' });
    expect(idsIn(layout, 'g2')).toEqual(['new']);
  });

  it('changing the default never moves an existing session', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: 'g2' };
    await h.service.sessionCreated(
      'alice',
      's1',
      { caseName: 'app' },
      h.register({ id: 's1', owner: 'alice', createdAt: 3 })
    );
    await h.service.setCaseDefaultGroup('alice', 'app', 'g1');
    const layout = await h.service.sessionCreated(
      'alice',
      's2',
      { caseName: 'app' },
      h.register({ id: 's2', owner: 'alice', createdAt: 4 })
    );
    expect(idsIn(layout, 'g2')).toEqual(['s1']);
    expect(idsIn(layout, 'g1')).toEqual(['a', 's2']);
  });

  it('a failed layout write rolls the registration back and writes no case default change', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: 'deleted-group' };
    h.store.commitTabLayoutProjection.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const added = h.register({ id: 'new', owner: 'alice', createdAt: 3 });
    await expect(h.service.sessionCreated('alice', 'new', { caseName: 'app' }, added)).rejects.toThrow('disk full');
    expect(h.live.has('new')).toBe(false);
    expect(h.layouts.alice).toEqual(grouped());
    expect(h.caseDefaults.setCaseDefaultGroup).not.toHaveBeenCalled();
    expect(h.caseDefaults.deleteCaseDefaultGroup).not.toHaveBeenCalled();
  });
});

describe('TabLayoutService case default reads and writes', () => {
  it('reports the selection with the owner group options, and a stale id as Ungrouped without writing', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    expect(await h.service.caseDefaultGroup('alice', 'app')).toEqual({
      groupId: null,
      groups: [
        { id: 'g1', name: 'Core' },
        { id: 'g2', name: 'Ops' },
      ],
    });
    h.defaults.alice = { app: 'gone' };
    expect((await h.service.caseDefaultGroup('alice', 'app')).groupId).toBeNull();
    // A read never writes: the next creation for the case is what forgets the stale id.
    expect(h.caseDefaults.deleteCaseDefaultGroup).not.toHaveBeenCalled();
    expect(h.caseDefaults.getCaseDefaultGroup('alice', 'app')).toBe('gone');
  });

  it('saves a known group or null, and refuses an id that is not in the owner layout', async () => {
    const h = createHarness({ layouts: { alice: grouped(), bob: { ...grouped(1), groups: [] } }, live: facts() });
    await h.service.setCaseDefaultGroup('alice', 'app', 'g2');
    expect(h.defaults.alice.app).toBe('g2');
    await h.service.setCaseDefaultGroup('alice', 'app', null);
    expect(h.defaults.alice.app).toBeNull();
    await expect(h.service.setCaseDefaultGroup('bob', 'app', 'g1')).rejects.toBeInstanceOf(TabLayoutValidationError);
    expect(h.defaults.bob).toBeUndefined();
  });

  it('forgets a mapping when its case goes away', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.defaults.alice = { app: 'g1' };
    await h.service.forgetCaseDefaultGroup('alice', 'app');
    expect(h.caseDefaults.getCaseDefaultGroup('alice', 'app')).toBeUndefined();
  });
});
