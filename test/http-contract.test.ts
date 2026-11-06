/**
 * Live-server tests for the stable HTTP contract (docs/api-reference.md):
 * the uniform {success,data} envelope, error envelopes with conventional
 * HTTP statuses, the /api/v1 alias, and the /api not-found handler.
 *
 * These behaviors live in server.ts (preSerialization hook, setNotFoundHandler),
 * which the route-test harness does not install — so they need a real WebServer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { flattenOwnerSessionOrder, type TabLayout } from '../src/tab-layout.js';
import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';

describe('Stable HTTP contract (live server)', () => {
  let server: WebServer;
  let base: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    base = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('wraps bare payloads as { success: true, data }', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.version).toBeDefined();
  });

  it('preserves the legacy global session order in single-user light state without exposing layouts', async () => {
    const res = await fetch(`${base}/api/status`);
    const body = await res.json();
    expect(body.data.sessionOrder).toEqual([]);
    expect(body.data).not.toHaveProperty('tabLayouts');
  });

  it('filters status order for regular users while admins and single-user mode retain the global projection', () => {
    type FakeSession = {
      id: string;
      owner: string;
      inputTokens: number;
      outputTokens: number;
      totalCost: number;
      toLightDetailedState(): { id: string; owner: string };
    };
    type StatusInternals = {
      sessions: Map<string, FakeSession>;
      store: { getSessionOrder(): string[]; setSessionOrder(order: string[]): void };
      cachedLightState: unknown;
      cachedSessionsList: unknown;
      getLightState(identity?: { username: string; role: 'admin' | 'user' }): Record<string, unknown>;
    };
    const internals = server as unknown as StatusInternals;
    const previousOrder = internals.store.getSessionOrder();
    const previousSessions = new Map(internals.sessions);
    const fakeSession = (id: string, owner: string): FakeSession => ({
      id,
      owner,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toLightDetailedState: () => ({ id, owner }),
    });

    try {
      internals.sessions.clear();
      internals.sessions.set('a1', fakeSession('a1', 'alice'));
      internals.sessions.set('b1', fakeSession('b1', 'bob'));
      internals.sessions.set('a2', fakeSession('a2', 'alice'));
      internals.store.setSessionOrder(['b1', 'a1', 'a2']);
      internals.cachedLightState = null;
      internals.cachedSessionsList = null;

      vi.stubEnv('CODEMAN_MULTIUSER', '1');
      expect(internals.getLightState({ username: 'alice', role: 'user' }).sessionOrder).toEqual(['a1', 'a2']);
      expect(internals.getLightState({ username: 'root', role: 'admin' }).sessionOrder).toEqual(['b1', 'a1', 'a2']);

      vi.stubEnv('CODEMAN_MULTIUSER', '0');
      expect(internals.getLightState().sessionOrder).toEqual(['b1', 'a1', 'a2']);
    } finally {
      vi.unstubAllEnvs();
      internals.sessions.clear();
      for (const [id, session] of previousSessions) internals.sessions.set(id, session);
      internals.store.setSessionOrder(previousOrder);
      internals.cachedLightState = null;
      internals.cachedSessionsList = null;
    }
  });

  it('keeps the tab layout foundation smoke contract atomic and writable', async () => {
    type TabLayoutInternals = {
      sessions: Map<string, { id: string; createdAt: number; owner?: string }>;
      store: {
        getState(): { sessionOrder?: string[]; tabLayouts?: Record<string, TabLayout> };
        getSessionOrder(): string[];
        getTabLayout(owner: string): TabLayout | null;
        getTabLayouts(): Record<string, TabLayout>;
        commitTabLayoutProjection: (...args: unknown[]) => unknown;
        save(): void;
      };
      sse: {
        addClient(reply: unknown, sessionFilter: Set<string> | null, isRemote: boolean): void;
        removeClient(reply: unknown): void;
        broadcast: (...args: unknown[]) => void;
        broadcastSessionOrder: (...args: unknown[]) => void;
      };
    };
    const internals = server as unknown as TabLayoutInternals;
    const commit = vi.spyOn(internals.store, 'commitTabLayoutProjection');
    const layoutEvent = vi.spyOn(internals.sse, 'broadcast');
    const orderEvent = vi.spyOn(internals.sse, 'broadcastSessionOrder');
    const previousSessions = new Map(internals.sessions);
    const storeState = internals.store.getState();
    const previousSessionOrder = storeState.sessionOrder ? [...storeState.sessionOrder] : undefined;
    const previousTabLayouts = storeState.tabLayouts ? structuredClone(storeState.tabLayouts) : undefined;
    const recipientWrites: string[] = [];
    const recipient = { raw: { write: (chunk: string) => (recipientWrites.push(chunk), true) } };
    internals.sse.addClient(recipient, null, false);
    const requested = {
      version: 0,
      groups: [],
      ungrouped: [],
      updatedAt: '2026-08-23T00:00:00.000Z',
    };

    try {
      expect(internals.store.getTabLayout('@single')).toBeNull();

      const direct = await fetch(`${base}/api/tab-layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 0, layout: requested }),
      });
      expect(direct.status).toBe(200);
      expect((await direct.json()).data.layout.version).toBe(1);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(layoutEvent).toHaveBeenCalledTimes(1);
      expect(layoutEvent).toHaveBeenCalledWith(SseEvent.TabLayoutChanged, { owner: '@single', version: 1 }, undefined);
      expect(orderEvent).not.toHaveBeenCalled();
      expect(recipientWrites).toEqual(['event: tab:layoutChanged\ndata: {"owner":"@single","version":1}\n\n']);
      recipientWrites.length = 0;

      const layoutBeforeConflict = internals.store.getTabLayout('@single');
      const orderBeforeConflict = internals.store.getSessionOrder();
      const writesBeforeConflict = commit.mock.calls.length;
      const layoutEventsBeforeConflict = layoutEvent.mock.calls.length;
      const orderEventsBeforeConflict = orderEvent.mock.calls.length;
      const stale = await fetch(`${base}/api/tab-layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 0, layout: requested }),
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).errorCode).toBe('CONFLICT');
      expect(internals.store.getTabLayout('@single')).toEqual(layoutBeforeConflict);
      expect(internals.store.getSessionOrder()).toEqual(orderBeforeConflict);
      expect(commit).toHaveBeenCalledTimes(writesBeforeConflict);
      expect(layoutEvent).toHaveBeenCalledTimes(layoutEventsBeforeConflict);
      expect(orderEvent).toHaveBeenCalledTimes(orderEventsBeforeConflict);
      expect(recipientWrites).toEqual([]);

      const ownerGet = await fetch(`${base}/api/tab-layout`);
      expect(ownerGet.status).toBe(200);
      expect((await ownerGet.json()).data.layout.version).toBe(1);

      const firstId = 'tab-layout-smoke-a';
      const secondId = 'tab-layout-smoke-b';
      internals.sessions.set(firstId, { id: firstId, createdAt: 1 });
      internals.sessions.set(secondId, { id: secondId, createdAt: 2 });
      const orderEventsBeforeLegacy = orderEvent.mock.calls.length;
      const legacyPut = await fetch(`${base}/api/session-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: [secondId, firstId] }),
      });
      expect(legacyPut.status).toBe(200);
      expect((await legacyPut.json()).data.order).toEqual([secondId, firstId]);
      expect(internals.store.getSessionOrder()).toEqual([secondId, firstId]);
      expect(flattenOwnerSessionOrder(internals.store.getTabLayout('@single')!)).toEqual([secondId, firstId]);
      expect(orderEvent).toHaveBeenCalledTimes(orderEventsBeforeLegacy + 1);
      expect(orderEvent).toHaveBeenLastCalledWith({
        changedOwnerOrders: { '@single': [secondId, firstId] },
        globalOrder: [secondId, firstId],
        globalChanged: true,
      });
      expect(recipientWrites.at(-1)).toBe(
        `event: session:orderChanged\ndata: {"order":["${secondId}","${firstId}"]}\n\n`
      );
    } finally {
      internals.sse.removeClient(recipient);
      internals.sessions.clear();
      for (const [id, session] of previousSessions) internals.sessions.set(id, session);
      if (previousSessionOrder) storeState.sessionOrder = [...previousSessionOrder];
      else delete storeState.sessionOrder;
      if (previousTabLayouts) storeState.tabLayouts = structuredClone(previousTabLayouts);
      else delete storeState.tabLayouts;
      internals.store.save();
      commit.mockRestore();
      layoutEvent.mockRestore();
      orderEvent.mockRestore();
    }

    expect(internals.store.getSessionOrder()).toEqual(previousSessionOrder ?? []);
    expect(internals.store.getTabLayouts()).toEqual(previousTabLayouts ?? {});
  });

  it('serves the same envelope on the /api/v1 alias', async () => {
    const res = await fetch(`${base}/api/v1/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.version).toBeDefined();
  });

  it('maps error envelopes to conventional HTTP statuses', async () => {
    const res = await fetch(`${base}/api/sessions/nonexistent/terminal`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('returns a contract-shaped 404 for unknown /api routes', async () => {
    const res = await fetch(`${base}/api/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('returns a contract-shaped 404 for unknown /api/v1 routes', async () => {
    const res = await fetch(`${base}/api/v1/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('rejects a bad /api/events/subscribe body with an error envelope', async () => {
    const res = await fetch(`${base}/api/events/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INVALID_INPUT');
  });

  it('keeps validation errors on the envelope with HTTP 400', async () => {
    const res = await fetch(`${base}/api/clipboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INVALID_INPUT');
  });

  /**
   * The agent wait primitives, through the REAL pipeline.
   *
   * Their own route tests hand-roll a partial copy of the preSerialization hook that
   * maps errorCode to status but does NOT wrap bare payloads — so nothing there
   * proves these routes emit a correct envelope, a correct status, or work through
   * the /api/v1 alias, and one assertion in them pins `{}` for a response no client
   * will ever receive. This is the file whose docstring already claims that scope.
   */
  describe('agent wait primitives', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      sessionId = (await res.json()).data.session.id;
      expect(sessionId).toBeDefined();
    });

    afterAll(async () => {
      await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' });
    });

    it('answers a wait timeout as a 200 inside the envelope, on the /api/v1 alias', async () => {
      // A timeout is the long-poll SUCCEEDING at "did this happen within N ms?"; a
      // 4xx/5xx here would make every poll boundary indistinguishable from a failure.
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/wait?until=working&timeout=1000`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.sessionId).toBe(sessionId);
      // The one shape all three wait endpoints share.
      expect(body.data.wait.timedOut).toBe(true);
      expect(body.data.wait.signal).toBeNull();
      expect(body.data.wait.timeoutMs).toBe(1000);
      expect(body.data.wait.until).toEqual(['working']);
    });

    it('returns a contract-shaped 400 for an unknown until token', async () => {
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/wait?until=stpo`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INVALID_INPUT');
      expect(body.error).toContain('stpo');
    });

    it('returns a contract-shaped 400 naming the bad query parameter', async () => {
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/wait?timeout=30s`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorCode).toBe('INVALID_INPUT');
      expect(body.error).toContain('timeout');
    });

    it('wraps the non-wait input response as { success: true, data: {} }', async () => {
      // What a client actually receives on the fire-and-forget path — NOT the bare
      // `{}` the handler returns and the route tests assert.
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hello' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: {} });
    });

    it('serves wait-output through the same envelope', async () => {
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/wait-output?match=NEVER_APPEARS&timeout=1000`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.wait.matched).toBe(false);
      expect(body.data.wait.timedOut).toBe(true);
      expect(body.data.wait.match).toBe('NEVER_APPEARS');
    });

    it('404s an unknown session on both new routes, with the error envelope', async () => {
      for (const path of ['wait?until=idle', 'wait-output?match=x']) {
        const res = await fetch(`${base}/api/v1/sessions/nonexistent/${path}`);
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.errorCode).toBe('NOT_FOUND');
      }
    });
  });
});
