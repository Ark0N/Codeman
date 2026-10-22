/**
 * @fileoverview Per-case default session group over HTTP: the case routes that
 * read and write it, and the create routes that carry the case into the real
 * TabLayoutService so a new session lands in its case's group in the creating
 * write (POST /api/sessions, and POST /api/quick-start for local, remote and
 * Docker cases).
 *
 * Uses app.inject(), so no real HTTP port is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { Session } from '../../src/session.js';
import { TabLayoutService } from '../../src/tab-layout-service.js';
import { ownerLayoutKey } from '../../src/tab-layout-persistence.js';
import type { TabLayout } from '../../src/tab-layout.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';
import { getDataDir } from '../../src/config/instance.js';
import { safeRmHomeTree } from '../mocks/index.js';

vi.mock('../../src/utils/cli-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/cli-launcher.js')>();
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

const CASE = 'cdgcase';
const DATA_FILES = ['docker-hosts.json', 'docker-cases.json', 'remote-hosts.json', 'remote-cases.json'];

interface World {
  layouts: Record<string, TabLayout>;
  order: string[];
  defaults: Record<string, Record<string, string | null>>;
  service: TabLayoutService;
}

/** The real layout service over an in-memory store, wired the way server.ts wires it. */
function attachRealLayout(harness: RouteTestHarness): World {
  const world = { layouts: {}, order: [], defaults: {} } as unknown as World;
  const caseDefaults = {
    getCaseDefaultGroup: (owner: string, name: string) =>
      world.defaults[owner] && name in world.defaults[owner] ? world.defaults[owner][name] : undefined,
    setCaseDefaultGroup: (owner: string, name: string, id: string | null) => {
      world.defaults[owner] = { ...(world.defaults[owner] ?? {}), [name]: id };
    },
    deleteCaseDefaultGroup: (owner: string, name: string) => {
      if (world.defaults[owner]) delete world.defaults[owner][name];
    },
  };
  world.service = new TabLayoutService({
    store: {
      getTabLayout: (owner: string) => world.layouts[owner] ?? null,
      getTabLayouts: () => ({ ...world.layouts }),
      getSessions: () => ({}),
      getSessionOrder: () => [...world.order],
      commitTabLayoutProjection: (
        updates: Readonly<Record<string, TabLayout>>,
        project: (latest: readonly string[]) => readonly string[]
      ) => {
        world.order = [...project(world.order)];
        Object.assign(world.layouts, structuredClone(updates));
        return { layouts: structuredClone(updates), sessionOrder: [...world.order] };
      },
    } as never,
    sessions: harness.ctx.sessions as never,
    readWebviews: async () => [],
    broadcast: () => {},
    broadcastSessionOrder: () => {},
    caseDefaults,
  });
  world.service.markRestorationSkipped();
  (harness.ctx as unknown as { tabLayouts: TabLayoutService }).tabLayouts = world.service;
  harness.ctx.addSession.mockImplementation((session: Session, placement?: object) =>
    world.service.sessionCreated(ownerLayoutKey(session.owner), session.id, placement, () => {
      harness.ctx.sessions.set(session.id, session as never);
      return () => harness.ctx.sessions.delete(session.id);
    })
  );
  return world;
}

const OWNER = ownerLayoutKey(undefined);
const withGroups = (world: World) => {
  world.layouts[OWNER] = {
    version: 3,
    updatedAt: '2026-10-21T00:00:00.000Z',
    groups: [
      { id: 'g-core', name: 'Core', refs: [] },
      { id: 'g-ops', name: 'Ops', refs: [] },
    ],
    ungrouped: [],
  };
};
const groupOf = (layout: TabLayout, sessionId: string): string | null =>
  layout.groups.find((g) => g.refs.some((r) => r.id === sessionId))?.id ?? null;
const unwrap = (raw: string) => {
  const parsed = JSON.parse(raw);
  return parsed.data ?? parsed;
};

describe('case default group: create routes', () => {
  let harness: RouteTestHarness;
  let world: World;
  const caseDir = join(CASES_DIR, CASE);
  const outside = join(homedir(), 'cdg-not-a-case');

  beforeEach(async () => {
    for (const name of DATA_FILES) await rm(join(getDataDir(), name), { force: true });
    await mkdir(caseDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
    harness = await createRouteTestHarness(registerSessionRoutes);
    harness.ctx.sessions.clear();
    world = attachRealLayout(harness);
    withGroups(world);
    world.defaults[OWNER] = { [CASE]: 'g-ops' };
  });

  afterEach(async () => {
    await harness.app.close();
    for (const name of DATA_FILES) await rm(join(getDataDir(), name), { force: true });
    safeRmHomeTree(CASES_DIR);
    safeRmHomeTree(outside);
    vi.restoreAllMocks();
  });

  it('POST /api/sessions in a case folder lands in the case default group and returns that layout', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w1-cdg', mode: 'shell', workingDir: caseDir },
    });
    expect(res.statusCode).toBe(200);
    const data = unwrap(res.body);
    expect(groupOf(world.layouts[OWNER], data.session.id)).toBe('g-ops');
    // The response carries the committed layout so the browser draws the tab in place.
    expect(data.tabLayout).toEqual(world.layouts[OWNER]);
  });

  it('POST /api/sessions in a Claude worktree of the case lands in the case default group too', async () => {
    // What the Git worktrees modal sends for Claude; every other CLI goes through quick-start with the case name.
    const worktree = join(caseDir, '.claude', 'worktrees', 'feat');
    await mkdir(worktree, { recursive: true });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w1-cdg-wt', mode: 'shell', workingDir: worktree },
    });
    expect(res.statusCode).toBe(200);
    const data = unwrap(res.body);
    expect(groupOf(world.layouts[OWNER], data.session.id)).toBe('g-ops');
    expect(data.tabLayout).toEqual(world.layouts[OWNER]);
  });

  it('POST /api/sessions without a workingDir infers no case from the server cwd', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(caseDir); // the server's own cwd happens to be a case folder
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w1-nowd', mode: 'shell' },
    });
    expect(res.statusCode).toBe(200);
    const data = unwrap(res.body);
    expect(data.session.workingDir).toBe(caseDir);
    expect(Object.keys(data)).toEqual(['session']);
    expect(groupOf(world.layouts[OWNER], data.session.id)).toBeNull();
  });

  it('POST /api/sessions outside any case gets no case default and keeps its response shape', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w1-out', mode: 'shell', workingDir: outside },
    });
    const data = unwrap(res.body);
    expect(Object.keys(data)).toEqual(['session']);
    expect(groupOf(world.layouts[OWNER], data.session.id)).toBeNull();
  });

  it('POST /api/sessions: an explicit tabGroupId still wins', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w1-cdg', mode: 'shell', workingDir: caseDir, tabGroupId: 'g-core' },
    });
    expect(groupOf(world.layouts[OWNER], unwrap(res.body).session.id)).toBe('g-core');
  });

  it('POST /api/quick-start for a local case lands in the case default group', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: CASE, mode: 'shell' },
    });
    expect(res.statusCode).toBe(200);
    const data = unwrap(res.body);
    expect(groupOf(world.layouts[OWNER], data.sessionId)).toBe('g-ops');
    expect(data.tabLayout).toEqual(world.layouts[OWNER]);
  });

  it('POST /api/quick-start: explicit tabGroupId wins over the case default', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: CASE, mode: 'shell', tabGroupId: 'g-core' },
    });
    expect(groupOf(world.layouts[OWNER], unwrap(res.body).sessionId)).toBe('g-core');
  });

  it('POST /api/quick-start for a remote case lands in the case default group', async () => {
    await writeFile(
      join(getDataDir(), 'remote-hosts.json'),
      JSON.stringify([{ id: 'remote1', label: 'Remote', host: '10.0.0.5', username: 'dev' }])
    );
    await writeFile(
      join(getDataDir(), 'remote-cases.json'),
      JSON.stringify([{ name: 'cdgremote', type: 'remote', hostId: 'remote1', remotePath: '/home/dev/work' }])
    );
    world.defaults[OWNER].cdgremote = 'g-core';
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'cdgremote', mode: 'claude' },
    });
    expect(res.statusCode).toBe(200);
    const data = unwrap(res.body);
    expect(data.sessionId, res.body).toBeTruthy();
    expect(groupOf(world.layouts[OWNER], data.sessionId)).toBe('g-core');
  });

  it('POST /api/quick-start for a Docker case lands in the case default group', async () => {
    await writeFile(
      join(getDataDir(), 'docker-hosts.json'),
      JSON.stringify([{ id: 'docker1', label: 'Docker', image: 'codeman/agent:base' }])
    );
    await writeFile(
      join(getDataDir(), 'docker-cases.json'),
      JSON.stringify([
        { name: 'cdgdocker', type: 'docker', hostId: 'docker1', hostWorkspacePath: caseDir, container: 'codeman-cdg' },
      ])
    );
    world.defaults[OWNER].cdgdocker = 'g-core';
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'cdgdocker', mode: 'claude' },
    });
    expect(res.statusCode).toBe(200);
    const data = unwrap(res.body);
    expect(data.sessionId, res.body).toBeTruthy();
    expect(groupOf(world.layouts[OWNER], data.sessionId)).toBe('g-core');
  });

  it('a deleted default group never fails creation: the session lands ungrouped and the value is cleared', async () => {
    world.defaults[OWNER][CASE] = 'g-deleted';
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: CASE, mode: 'shell' },
    });
    expect(res.statusCode).toBe(200);
    const data = unwrap(res.body);
    expect(groupOf(world.layouts[OWNER], data.sessionId)).toBeNull();
    expect(data.tabLayout).toBeUndefined();
    expect(CASE in world.defaults[OWNER]).toBe(false);
  });

  it('a creation that fails after registration leaves no layout reference', async () => {
    vi.mocked(Session.prototype.startShell).mockRejectedValueOnce(new Error('pane failed'));
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: CASE, mode: 'shell' },
    });
    expect(unwrap(res.body).sessionId).toBeUndefined();
    // The route's own error path ran cleanupSession for the registered id.
    expect(harness.ctx.cleanupSession).toHaveBeenCalledTimes(1);
  });
});

describe('case default group: GET/PUT /api/cases/:name/default-group', () => {
  let harness: RouteTestHarness;
  let world: World;
  const caseDir = join(CASES_DIR, CASE);

  beforeEach(async () => {
    for (const name of DATA_FILES) await rm(join(getDataDir(), name), { force: true });
    await mkdir(caseDir, { recursive: true });
    harness = await createRouteTestHarness(registerCaseRoutes);
    world = attachRealLayout(harness);
    withGroups(world);
  });

  afterEach(async () => {
    await harness.app.close();
    delete process.env.CODEMAN_MULTIUSER;
    for (const name of DATA_FILES) await rm(join(getDataDir(), name), { force: true });
    safeRmHomeTree(CASES_DIR);
    vi.restoreAllMocks();
  });

  const get = (name = CASE) => harness.app.inject({ method: 'GET', url: `/api/cases/${name}/default-group` });
  const put = (groupId: unknown, name = CASE) =>
    harness.app.inject({ method: 'PUT', url: `/api/cases/${name}/default-group`, payload: { groupId } });

  it('lists Ungrouped (null) and every named group of the owner', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        caseName: CASE,
        groupId: null,
        groups: [
          { id: 'g-core', name: 'Core' },
          { id: 'g-ops', name: 'Ops' },
        ],
      },
    });
  });

  it('saves a group and reads it back; null is an intentional Ungrouped', async () => {
    expect((await put('g-ops')).json().data.groupId).toBe('g-ops');
    expect(world.defaults[OWNER][CASE]).toBe('g-ops');
    expect((await get()).json().data.groupId).toBe('g-ops');
    expect((await put(null)).json().data.groupId).toBeNull();
    expect(world.defaults[OWNER][CASE]).toBeNull();
  });

  it('reads the current group names, so a rename shows through (the id is stored)', async () => {
    await put('g-ops');
    world.layouts[OWNER].groups[1].name = 'Operations';
    const data = (await get()).json().data;
    expect(data.groupId).toBe('g-ops');
    expect(data.groups[1]).toEqual({ id: 'g-ops', name: 'Operations' });
  });

  it('a deleted group reads back as Ungrouped, and the read changes nothing', async () => {
    world.defaults[OWNER] = { [CASE]: 'g-gone' };
    expect((await get()).json().data.groupId).toBeNull();
    // GET is read-only; the next session created for the case forgets the stale id.
    expect(world.defaults[OWNER][CASE]).toBe('g-gone');
  });

  it.each([
    ['an unknown group', 'g-nope', 400],
    ['an empty string', '', 400],
    ['a number', 7, 400],
  ])('refuses %s without changing the stored value', async (_label, groupId, status) => {
    await put('g-core');
    const res = await put(groupId);
    expect(res.statusCode).toBe(status);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    expect(world.defaults[OWNER][CASE]).toBe('g-core');
  });

  it('404s a case that does not exist (or is not the caller’s), for both verbs', async () => {
    expect((await get('nosuchcase')).statusCode).toBe(404);
    expect((await put('g-core', 'nosuchcase')).statusCode).toBe(404);
    expect(world.defaults[OWNER]).toBeUndefined();
  });

  it('accepts a remote case and a Docker case by name', async () => {
    await writeFile(
      join(getDataDir(), 'remote-hosts.json'),
      JSON.stringify([{ id: 'remote1', label: 'Remote', host: '10.0.0.5', username: 'dev' }])
    );
    await writeFile(
      join(getDataDir(), 'remote-cases.json'),
      JSON.stringify([{ name: 'cdgremote', type: 'remote', hostId: 'remote1', remotePath: '/home/dev/work' }])
    );
    await writeFile(
      join(getDataDir(), 'docker-cases.json'),
      JSON.stringify([{ name: 'cdgdocker', type: 'docker', hostId: 'docker1', hostWorkspacePath: caseDir }])
    );
    expect((await put('g-core', 'cdgremote')).statusCode).toBe(200);
    expect((await put('g-ops', 'cdgdocker')).statusCode).toBe(200);
    expect(world.defaults[OWNER]).toMatchObject({ cdgremote: 'g-core', cdgdocker: 'g-ops' });
  });

  it('DELETE /api/cases/:name forgets the mapping', async () => {
    await put('g-ops');
    const res = await harness.app.inject({ method: 'DELETE', url: `/api/cases/${CASE}` });
    expect(res.statusCode).toBe(200);
    expect(CASE in world.defaults[OWNER]).toBe(false);
  });
});

describe('case default group: multi-user scoping', () => {
  afterEach(() => {
    delete process.env.CODEMAN_MULTIUSER;
    vi.restoreAllMocks();
  });

  it("stores a non-admin's choice under their own owner key and validates against their own groups", async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const harness = await createRouteTestHarness(registerCaseRoutes, { authUser: { username: 'bob', role: 'user' } });
    try {
      harness.ctx.sessions.clear();
      const world = attachRealLayout(harness);
      world.layouts.alice = {
        version: 1,
        updatedAt: '2026-10-21T00:00:00.000Z',
        groups: [{ id: 'g-alice', name: 'Alice', refs: [] }],
        ungrouped: [],
      };
      world.layouts.bob = {
        version: 1,
        updatedAt: '2026-10-21T00:00:00.000Z',
        groups: [{ id: 'g-bob', name: 'Bob', refs: [] }],
        ungrouped: [],
      };
      const { resolveCasesDir } = await import('../../src/web/route-helpers.js');
      const bobCases = resolveCasesDir({ username: 'bob', role: 'user' } as never);
      await mkdir(join(bobCases, 'bobcase'), { recursive: true });

      const read = await harness.app.inject({ method: 'GET', url: '/api/cases/bobcase/default-group' });
      expect(read.json().data.groups).toEqual([{ id: 'g-bob', name: 'Bob' }]);
      const foreign = await harness.app.inject({
        method: 'PUT',
        url: '/api/cases/bobcase/default-group',
        payload: { groupId: 'g-alice' },
      });
      expect(foreign.statusCode).toBe(400);
      const own = await harness.app.inject({
        method: 'PUT',
        url: '/api/cases/bobcase/default-group',
        payload: { groupId: 'g-bob' },
      });
      expect(own.statusCode).toBe(200);
      expect(world.defaults).toEqual({ bob: { bobcase: 'g-bob' } });
      safeRmHomeTree(join(bobCases, '..'));
    } finally {
      await harness.app.close();
    }
  });
});
