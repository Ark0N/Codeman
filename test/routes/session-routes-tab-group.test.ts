/**
 * @fileoverview `tabGroupId` on the create routes: a session created from a
 * group's "New session" action asks to be placed in that group.
 *
 * The routes only validate the field and hand it to `ctx.addSession()`; the
 * placement itself (and the rule that an unknown or foreign group is ignored)
 * lives in TabLayoutService, covered by test/tab-layout-service.test.ts. What is
 * pinned here is the wire contract: the field is validated (a null or an empty
 * string is a 400, never a silent drop), it reaches addSession with the new
 * session, and the committed layout comes back on the response so the browser
 * can draw the tab in its group without waiting for a re-read. Requests without
 * the field keep their exact response shape.
 *
 * Uses app.inject(), so no real HTTP port is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { Session } from '../../src/session.js';
import { TabLayoutService } from '../../src/tab-layout-service.js';
import { ownerLayoutKey } from '../../src/tab-layout-persistence.js';
import type { TabLayout } from '../../src/tab-layout.js';

const LAYOUT = {
  version: 4,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [{ id: 'g1', name: 'Core', refs: [] as Array<{ kind: 'session'; id: string }> }],
  ungrouped: [] as Array<{ kind: 'session'; id: string }>,
};

describe('create routes: tabGroupId', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let workingDir: string;

  beforeEach(async () => {
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
    workingDir = await mkdtemp(join(tmpdir(), 'codeman-tab-group-'));
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    ctx = createMockRouteContext();
    ctx.addSession.mockImplementation(async (session: { id: string }, placement?: { tabGroupId?: string }) => {
      ctx.sessions.set(session.id, session as never);
      const refs = [{ kind: 'session' as const, id: session.id }];
      return placement?.tabGroupId === 'g1'
        ? { ...LAYOUT, version: 5, groups: [{ ...LAYOUT.groups[0], refs }] }
        : { ...LAYOUT, version: 5, ungrouped: refs };
    });
    registerSessionRoutes(app, ctx);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(workingDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const body = (raw: string) => {
    const parsed = JSON.parse(raw);
    return parsed.data ?? parsed;
  };

  it('POST /api/sessions hands the group to addSession and returns the committed layout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w1-x', mode: 'shell', workingDir, tabGroupId: 'g1' },
    });
    expect(res.statusCode).toBe(200);
    const data = body(res.body);
    expect(ctx.addSession).toHaveBeenCalledTimes(1);
    expect(ctx.addSession.mock.calls[0][0].id).toBe(data.session.id);
    expect(ctx.addSession.mock.calls[0][1]).toEqual({ tabGroupId: 'g1' });
    expect(data.tabLayout.version).toBe(5);
    expect(data.tabLayout.groups[0].refs).toEqual([{ kind: 'session', id: data.session.id }]);
  });

  it('POST /api/sessions without a group keeps its response shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w1-x', mode: 'shell', workingDir },
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(body(res.body))).toEqual(['session']);
    expect(ctx.addSession.mock.calls[0][1]).toBeUndefined();
  });

  it('POST /api/quick-start carries the group the same way', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'tabgroupcase', mode: 'shell', tabGroupId: 'g1' },
    });
    expect(res.statusCode).toBe(200);
    const data = body(res.body);
    expect(ctx.addSession.mock.calls[0][1]).toEqual({ tabGroupId: 'g1' });
    expect(data.tabLayout.groups[0].refs).toEqual([{ kind: 'session', id: data.sessionId }]);

    const plain = await app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'tabgroupcase', mode: 'shell' },
    });
    expect(body(plain.body).tabLayout).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a number', 7],
    ['an over-long id', 'g'.repeat(101)],
  ])('rejects %s as a tabGroupId with a 400 and creates nothing', async (_label, tabGroupId) => {
    for (const [url, payload] of [
      ['/api/sessions', { name: 'w1-x', mode: 'shell', workingDir, tabGroupId }],
      ['/api/quick-start', { caseName: 'tabgroupcase', mode: 'shell', tabGroupId }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).errorCode).toBe('INVALID_INPUT');
    }
    expect(ctx.addSession).not.toHaveBeenCalled();
  });
});

describe('create routes: tabGroupId through the real layout service', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let workingDir: string;
  const layouts: Record<string, TabLayout> = {};
  let order: string[] = [];

  beforeEach(async () => {
    vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
    workingDir = await mkdtemp(join(tmpdir(), 'codeman-tab-group-real-'));
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    ctx = createMockRouteContext();
    ctx.sessions.clear(); // only the sessions these requests create
    for (const key of Object.keys(layouts)) delete layouts[key];
    order = [];
    // The real service over an in-memory store, wired the way server.ts wires it.
    const service = new TabLayoutService({
      store: {
        getTabLayout: (owner: string) => layouts[owner] ?? null,
        getTabLayouts: () => ({ ...layouts }),
        getSessions: () => ({}),
        getSessionOrder: () => [...order],
        commitTabLayoutProjection: (
          updates: Readonly<Record<string, TabLayout>>,
          project: (latest: readonly string[]) => readonly string[]
        ) => {
          order = [...project(order)];
          Object.assign(layouts, structuredClone(updates));
          return { layouts: structuredClone(updates), sessionOrder: [...order] };
        },
      } as never,
      sessions: ctx.sessions as never,
      readWebviews: async () => [],
      broadcast: () => {},
      broadcastSessionOrder: () => {},
    });
    service.markRestorationSkipped();
    ctx.addSession.mockImplementation((session: Session, placement?: { tabGroupId?: string }) =>
      service.sessionCreated(ownerLayoutKey(session.owner), session.id, placement, () => {
        ctx.sessions.set(session.id, session as never);
        return () => ctx.sessions.delete(session.id);
      })
    );
    registerSessionRoutes(app, ctx);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(workingDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const unwrap = (raw: string) => {
    const parsed = JSON.parse(raw);
    return parsed.data ?? parsed;
  };

  it('places the created session at the end of an existing group and returns the stored layout', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w1-x', mode: 'shell', workingDir },
    });
    const firstId = unwrap(first.body).session.id as string;
    const owner = Object.keys(layouts)[0];
    layouts[owner] = {
      ...layouts[owner],
      groups: [{ id: 'g1', name: 'Core', refs: [{ kind: 'session', id: firstId }] }],
      ungrouped: [],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'w2-x', mode: 'shell', workingDir, tabGroupId: 'g1' },
    });
    expect(res.statusCode).toBe(200);
    const data = unwrap(res.body);
    expect(data.tabLayout).toEqual(layouts[owner]);
    expect(data.tabLayout.version).toBe(layouts[owner].version);
    expect(data.tabLayout.groups[0].refs).toEqual([
      { kind: 'session', id: firstId },
      { kind: 'session', id: data.session.id },
    ]);
    expect(data.tabLayout.ungrouped).toEqual([]);
    expect(order).toEqual([firstId, data.session.id]);
  });
});
