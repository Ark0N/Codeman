/**
 * @fileoverview End to end through the real WebServer: a session created with a
 * `tabGroupId` lands in that group in ONE layout version, and a session spawned
 * by another one (the X-Codeman-Parent-Session header) lands after its parent in
 * the parent's group: hand-placed from then on by default, or following its
 * parent until moved by hand with the synced `spawnedTabsFollowParent` setting.
 *
 * The service and route halves have their own unit tests; this pins the wiring
 * in server.ts (the session joins the live map inside the layout owner lock and
 * the placement commits with it) against the real routes and StateStore.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer } from '../src/web/server.js';

type Ref = { kind: string; id: string; placement?: string };
type Layout = {
  version: number;
  updatedAt: string;
  groups: Array<{ id: string; name: string; refs: Ref[] }>;
  ungrouped: Ref[];
};

describe('grouped session creation through the server', () => {
  let server: WebServer;
  let base = '';
  const workingDir = mkdtempSync(join(tmpdir(), 'codeman-grouped-create-'));

  const api = async (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const layout = async (): Promise<Layout> => (await api('/api/tab-layout')).json.data.layout;
  const create = async (body: Record<string, unknown>, headers?: Record<string, string>) => {
    const res = await api('/api/sessions', { method: 'POST', body: { workingDir, mode: 'shell', ...body }, headers });
    expect(res.status).toBe(200);
    return res.json.data as { session: { id: string }; tabLayout?: Layout };
  };
  const ids = (refs: Ref[]) => refs.map((ref) => ref.id);

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    base = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 60000);

  it('places the new session at the end of the group in the same write that records it', async () => {
    const first = await create({ name: 'first' });
    const current = await layout();
    const put = await api('/api/tab-layout', {
      method: 'PUT',
      body: {
        baseVersion: current.version,
        layout: {
          ...current,
          groups: [{ id: 'g1', name: 'Core', refs: [{ kind: 'session', id: first.session.id }] }],
          ungrouped: [],
        },
      },
    });
    expect(put.status).toBe(200);
    const before = put.json.data.layout as Layout;

    const made = await create({ name: 'grouped', tabGroupId: 'g1' });
    const after = await layout();
    expect(after.version).toBe(before.version + 1);
    expect(ids(after.groups[0].refs)).toEqual([first.session.id, made.session.id]);
    expect(made.tabLayout).toEqual(after);

    // An unknown group is a hint that does not apply: the session is still created.
    const loose = await create({ name: 'loose', tabGroupId: 'no-such-group' });
    expect(ids((await layout()).ungrouped)).toContain(loose.session.id);
  });

  it('by default a spawned child lands after its parent once and is hand-placed', async () => {
    const start = await layout();
    const parentId = start.groups[0].refs[0].id;
    const child = await create({ name: 'pinned-child' }, { 'X-Codeman-Parent-Session': parentId });
    const after = await layout();
    expect(after.groups[0].refs.slice(0, 2)).toEqual([
      { kind: 'session', id: parentId },
      { kind: 'session', id: child.session.id, placement: 'manual' },
    ]);
  });

  it('with the follow setting on, a spawned child follows its parent until moved by hand', async () => {
    const saved = await api('/api/settings', { method: 'PUT', body: { spawnedTabsFollowParent: true } });
    expect(saved.status).toBe(200);
    const start = await layout();
    const parentId = start.groups[0].refs[0].id;
    const child = await create({ name: 'child' }, { 'X-Codeman-Parent-Session': parentId });
    const followed = await layout();
    expect(followed.groups[0].refs.slice(0, 2)).toEqual([
      { kind: 'session', id: parentId },
      { kind: 'session', id: child.session.id },
    ]);

    // A legacy order PUT of the current order (what any device may send) keeps it following.
    const order = [...followed.groups.flatMap((group) => group.refs), ...followed.ungrouped]
      .filter((ref) => ref.kind === 'session')
      .map((ref) => ref.id);
    const echoed = await api('/api/session-order', { method: 'PUT', body: { order } });
    expect(echoed.status).toBe(200);
    expect(echoed.json.data.order).toEqual(order);
    expect((await layout()).groups[0].refs.find((ref) => ref.id === child.session.id)).toEqual({
      kind: 'session',
      id: child.session.id,
    });

    // Hand-move the child to Ungrouped (what the browser sends for a moveRef).
    const before = await layout();
    const moved = await api('/api/tab-layout', {
      method: 'PUT',
      body: {
        baseVersion: before.version,
        layout: {
          ...before,
          groups: [{ ...before.groups[0], refs: before.groups[0].refs.filter((ref) => ref.id !== child.session.id) }],
          ungrouped: [...before.ungrouped, { kind: 'session', id: child.session.id, placement: 'manual' }],
        },
      },
    });
    expect(moved.status).toBe(200);
    const after = await layout();
    expect(after.ungrouped.find((ref) => ref.id === child.session.id)).toEqual({
      kind: 'session',
      id: child.session.id,
      placement: 'manual',
    });
    expect(ids(after.groups[0].refs)).not.toContain(child.session.id);
  });
});

describe('server.ts addSession wiring', () => {
  it("keys the placement on the SESSION's owner and registers it only inside the layout call", async () => {
    const sessions = new Map<string, unknown>();
    let registered: (() => void | (() => void)) | undefined;
    const sessionCreated = vi.fn(async (_owner: string, _id: string, _placement: unknown, register: () => unknown) => {
      expect(sessions.has('bob-new')).toBe(false);
      registered = register as never;
      const rollback = register() as () => void;
      expect(sessions.get('bob-new')).toBe(session);
      rollback();
      return { version: 1 };
    });
    const server = Object.create(WebServer.prototype) as any;
    server.sessions = sessions;
    server.tabLayouts = { sessionCreated };
    const session = { id: 'bob-new', owner: 'bob' };

    await server.registerSessionWithLayout(session, { tabGroupId: 'g1' });

    expect(sessionCreated).toHaveBeenCalledWith('bob', 'bob-new', { tabGroupId: 'g1' }, expect.any(Function));
    // The rollback removed it; a rollback never removes a DIFFERENT session under that id.
    expect(sessions.has('bob-new')).toBe(false);
    const rollback = registered!() as () => void;
    const replacement = { id: 'bob-new', owner: 'bob' };
    sessions.set('bob-new', replacement);
    rollback();
    expect(sessions.get('bob-new')).toBe(replacement);
  });
});
