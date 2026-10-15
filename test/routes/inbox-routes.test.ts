/**
 * @fileoverview Agent inbox routes (src/web/routes/inbox-routes.ts) via app.inject().
 *
 * The caller is whoever `X-Codeman-Parent-Session` resolves to (live session, same
 * owner as the receiver). These tests pin what that decides: who a post is from,
 * whether a read marks seen or is a peek, and who may ack. Plus the wait rule (parks
 * while nothing is UNSEEN), the full-inbox 409 and the owner-scoped summary.
 *
 * The routes use the process-wide `agentInbox` and `sessionWaits`; every test resets
 * the inbox and cancels its waiters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerInboxRoutes } from '../../src/web/routes/inbox-routes.js';
import { agentInbox, MAX_MESSAGES_PER_INBOX } from '../../src/web/agent-inbox.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { httpStatusForErrorCode, type ApiErrorCode, type AuthUser } from '../../src/types.js';
import { createMockRouteContext, createMockSession, type MockRouteContext } from '../mocks/index.js';

const RX = 'aaaaaaaa-1111-4111-8111-111111111111';
const TX = 'bbbbbbbb-2222-4222-8222-222222222222';
const OTHER = 'cccccccc-3333-4333-8333-333333333333';

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

let currentUser: AuthUser | undefined;

async function createHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ sessionId: RX });
  for (const id of [TX, OTHER]) ctx.sessions.set(id, createMockSession(id) as never);
  app.decorateRequest('authUser', undefined);
  app.addHook('onRequest', async (req) => {
    req.authUser = currentUser;
  });
  registerInboxRoutes(app, ctx as never);
  // server.ts's envelope hook: an error envelope carries its 4xx.
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    const p = payload as { success?: unknown; errorCode?: unknown } | null;
    if (p && p.success === false && reply.statusCode === 200 && typeof p.errorCode === 'string') {
      reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
    }
    done(null, payload);
  });
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

const as = (caller?: string) => (caller ? { 'x-codeman-parent-session': caller } : {});

describe('agent inbox routes', () => {
  let h: Harness;

  const post = (to: string, text: string, caller?: string) =>
    h.app.inject({ method: 'POST', url: `/api/sessions/${to}/inbox`, payload: { text }, headers: as(caller) });
  const read = (of: string, caller?: string, query = '') =>
    h.app.inject({ method: 'GET', url: `/api/sessions/${of}/inbox${query}`, headers: as(caller) });
  const ack = (of: string, ids: string[], caller?: string) =>
    h.app.inject({ method: 'POST', url: `/api/sessions/${of}/inbox/ack`, payload: { ids }, headers: as(caller) });
  const data = (res: { body: string }) => JSON.parse(res.body).data;

  beforeEach(async () => {
    agentInbox.resetForTests();
    currentUser = undefined;
    delete process.env.CODEMAN_MULTIUSER;
    h = await createHarness();
  });

  afterEach(async () => {
    for (const id of [RX, TX, OTHER]) sessionWaits.cancelAll(id);
    await h.app.close();
    agentInbox.resetForTests();
    delete process.env.CODEMAN_MULTIUSER;
  });

  describe('from', () => {
    it('is the resolved caller session (exact id or 8-char prefix)', async () => {
      expect(data(await post(RX, 'hi', TX)).message.from).toBe(TX);
      expect(data(await post(RX, 'hi', TX.slice(0, 8))).message.from).toBe(TX);
    });

    it('is null (the user) without a header, for an unknown id, or for a short prefix', async () => {
      expect(data(await post(RX, 'a')).message.from).toBeNull();
      expect(data(await post(RX, 'b', 'dddddddd-0000-4000-8000-000000000000')).message.from).toBeNull();
      expect(data(await post(RX, 'c', TX.slice(0, 7))).message.from).toBeNull();
    });

    it('a body field cannot set it: the schema rejects unknown keys', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/sessions/${RX}/inbox`,
        payload: { text: 'x', from: TX },
      });
      expect(res.statusCode).toBe(400);
    });

    it('multi-user, non-admin: a session the caller cannot see never resolves as the sender', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      currentUser = { username: 'alice', role: 'user' };
      (h.ctx.sessions.get(RX) as unknown as { owner: string }).owner = 'alice';
      (h.ctx.sessions.get(TX) as unknown as { owner: string }).owner = 'bob';
      (h.ctx.sessions.get(OTHER) as unknown as { owner: string }).owner = 'alice';
      expect(data(await post(RX, 'x', TX)).message.from).toBeNull();
      expect(data(await post(RX, 'y', OTHER)).message.from).toBe(OTHER);
      // Nor can alice read as bob's session or ack for it: bob's inbox is a 404 to her.
      expect((await read(TX, TX)).statusCode).toBe(404);
      expect((await ack(TX, ['m'], TX)).statusCode).toBe(404);
    });

    it('multi-user, admin: may act as any session of the receiver’s owner (admins see everything)', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      currentUser = { username: 'root', role: 'admin' };
      (h.ctx.sessions.get(RX) as unknown as { owner: string }).owner = 'bob';
      (h.ctx.sessions.get(TX) as unknown as { owner: string }).owner = 'bob';
      expect(data(await post(RX, 'x', TX)).message.from).toBe(TX);
      expect(data(await read(RX, RX)).receiver).toBe(true);
    });

    it('multi-user: a session of another owner never resolves as the sender', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      currentUser = { username: 'alice', role: 'admin' };
      (h.ctx.sessions.get(RX) as unknown as { owner: string }).owner = 'alice';
      (h.ctx.sessions.get(TX) as unknown as { owner: string }).owner = 'bob';
      (h.ctx.sessions.get(OTHER) as unknown as { owner: string }).owner = 'alice';
      expect(data(await post(RX, 'x', TX)).message.from).toBeNull();
      expect(data(await post(RX, 'y', OTHER)).message.from).toBe(OTHER);
    });
  });

  describe('post', () => {
    it('keeps multi-line text as data', async () => {
      await post(RX, 'one\ntwo\n', TX);
      expect(data(await read(RX, RX)).messages[0].text).toBe('one\ntwo\n');
    });

    it('a full inbox is 409 CONFLICT with a clear message, and the oldest stays', async () => {
      const first = data(await post(RX, 'first')).message.id;
      for (let i = 1; i < MAX_MESSAGES_PER_INBOX; i++) agentInbox.post(RX, null, String(i));
      const res = await post(RX, 'one too many');
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ errorCode: 'CONFLICT' });
      expect(JSON.parse(res.body).error).toMatch(/full .*Nothing was stored/);
      expect(data(await read(RX)).messages[0].id).toBe(first);
    });

    it('a message over the byte cap is 400 with the store’s hint, multi-byte or not', async () => {
      for (const text of ['é'.repeat(8193), 'x'.repeat(16_385)]) {
        const res = await post(RX, text);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toMatch(/Write it to a file in the workspace and post the path/);
      }
    });

    it('404 for an unknown session', async () => {
      expect((await post('nope', 'x')).statusCode).toBe(404);
    });
  });

  describe('read', () => {
    it('only the receiver marks seen; a coordinator read is a peek', async () => {
      await post(RX, 'task', TX);
      const peek = data(await read(RX, TX));
      expect(peek).toMatchObject({ receiver: false, pending: 1, unseen: 1 });
      expect(data(await read(RX)).unseen).toBe(1);
      const own = data(await read(RX, RX));
      expect(own).toMatchObject({ receiver: true, pending: 1, unseen: 0 });
      expect(own.messages[0].seen).toBe(false);
      expect(data(await read(RX, RX)).messages[0].seen).toBe(true);
    });

    it('?wait= parks while nothing is unseen, even with a seen-but-unacked message', async () => {
      await post(RX, 'already seen', TX);
      await read(RX, RX);
      const parked = read(RX, RX, '?wait=5000');
      await new Promise((r) => setTimeout(r, 30));
      expect(sessionWaits.inboxWaiterCount(RX, true)).toBe(1);
      await post(RX, 'new', TX);
      const res = data(await parked);
      expect(res.wait).toMatchObject({ posted: true, timedOut: false });
      expect(res.messages.map((m: { text: string; seen: boolean }) => [m.text, m.seen])).toEqual([
        ['already seen', true],
        ['new', false],
      ]);
    });

    it('?wait= answers at once when something is unseen', async () => {
      await post(RX, 'm', TX);
      const res = data(await read(RX, RX, '?wait=60000'));
      expect(res.wait).toMatchObject({ immediate: true, waitedMs: 0, timeoutMs: 60000 });
    });

    it('?wait= runs out as a 200 with timedOut, clamped to the wait floor', async () => {
      const res = await read(RX, RX, '?wait=1');
      expect(res.statusCode).toBe(200);
      expect(data(res).wait).toMatchObject({ timedOut: true, timeoutMs: 1000 });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('?wait= rejects junk', async () => {
      expect((await read(RX, RX, '?wait=-5')).statusCode).toBe(400);
      expect((await read(RX, RX, '?wait=abc')).statusCode).toBe(400);
    });

    it('a parked read on a session that goes away answers ended, with an empty inbox', async () => {
      await post(RX, 'x');
      await read(RX, RX);
      const parked = read(RX, RX, '?wait=5000');
      await new Promise((r) => setTimeout(r, 30));
      // What server.ts does on delete: drop the inbox, then cancel the waiters.
      agentInbox.drop(RX);
      sessionWaits.cancelAll(RX);
      const res = data(await parked);
      expect(res.wait).toMatchObject({ ended: true });
      expect(res.messages).toEqual([]);
    });
  });

  describe('ack', () => {
    it('removes by id for the receiver, idempotently', async () => {
      const id = data(await post(RX, 'm', TX)).message.id;
      expect(data(await ack(RX, [id], RX))).toMatchObject({ removed: 1, pending: 0 });
      const again = await ack(RX, [id, 'never-existed'], RX);
      expect(again.statusCode).toBe(200);
      expect(data(again)).toMatchObject({ removed: 0, pending: 0 });
    });

    it('is 403 for anyone but the receiver, and removes nothing', async () => {
      const id = data(await post(RX, 'm', TX)).message.id;
      for (const caller of [TX, undefined]) {
        const res = await ack(RX, [id], caller);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).errorCode).toBe('FORBIDDEN');
      }
      expect(agentInbox.pendingCount(RX)).toBe(1);
    });

    it('rejects an empty id list', async () => {
      expect((await ack(RX, [], RX)).statusCode).toBe(400);
    });
  });

  describe('summary', () => {
    it('reports counts and parked per session, never text', async () => {
      await post(RX, 'secret', TX);
      await post(TX, 'other secret', RX);
      await read(TX, TX);
      const parked = read(OTHER, OTHER, '?wait=5000');
      // A coordinator peeking with ?wait= is not the receiver: not "parked".
      const peeking = read(RX, TX, '?wait=5000');
      await new Promise((r) => setTimeout(r, 30));
      const res = await h.app.inject({ method: 'GET', url: '/api/agent-inbox/summary' });
      expect(res.body).not.toContain('secret');
      expect(data(res).sessions).toEqual({
        [RX]: { pending: 1, unseen: 1, oldestUnseenAt: expect.any(Number), parked: false },
        [TX]: { pending: 1, unseen: 0, oldestUnseenAt: null, parked: false },
        [OTHER]: { pending: 0, unseen: 0, oldestUnseenAt: null, parked: true },
      });
      sessionWaits.cancelAll(OTHER);
      sessionWaits.cancelAll(RX);
      await Promise.all([parked, peeking]);
    });

    it('multi-user: lists only sessions the caller can see', async () => {
      process.env.CODEMAN_MULTIUSER = '1';
      currentUser = { username: 'alice', role: 'user' };
      (h.ctx.sessions.get(RX) as unknown as { owner: string }).owner = 'alice';
      (h.ctx.sessions.get(TX) as unknown as { owner: string }).owner = 'bob';
      agentInbox.post(RX, null, 'mine');
      agentInbox.post(TX, null, 'bob’s');
      const res = await h.app.inject({ method: 'GET', url: '/api/agent-inbox/summary' });
      expect(Object.keys(data(res).sessions)).toEqual([RX]);
    });
  });
});
