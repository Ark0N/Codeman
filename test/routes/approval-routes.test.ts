/**
 * Approvals Inbox route tests (src/web/routes/approval-routes.ts) via app.inject(),
 * no live port. The hook-event route is registered alongside so items are
 * created through the REAL ingestion path (sanitize → notePrompt with the
 * terminal-buffer capture fallback), not by poking the store directly.
 *
 * The routes read the process-wide `approvalInbox` singleton, so every test
 * drains it in afterEach; a leaked pending item would bleed into the next test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerApprovalRoutes } from '../../src/web/routes/approval-routes.js';
import { registerHookEventRoutes } from '../../src/web/routes/hook-event-routes.js';
import { approvalInbox } from '../../src/web/approval-inbox.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { createMockRouteContext, type MockSession } from '../mocks/index.js';

type MockRouteContext = ReturnType<typeof createMockRouteContext>;

interface RouteTestHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Local harness mirroring production's uniform-envelope preSerialization hook
 * (server.ts), so `{success:false}` bodies carry their conventional 4xx status.
 * The shared createRouteTestHarness deliberately omits that hook; these routes
 * signal every guard through returned error envelopes, so the status IS the
 * behavior under test. Pattern copied from hook-event-routes.test.ts.
 */
async function createEnvelopeHarness(authUser?: {
  username: string;
  role: 'admin' | 'user';
}): Promise<RouteTestHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  if (authUser) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: typeof authUser }).authUser = authUser;
    });
  }

  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  registerHookEventRoutes(app, ctx as never);
  registerApprovalRoutes(app, ctx as never);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

const SESSION_ID = 'approval-test-session';

const PERMISSION_DIALOG = [
  ' Claude needs your permission to use Bash',
  ' ❯ 1. Yes',
  '   2. Yes, and don’t ask again for this command',
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');

async function postHook(harness: RouteTestHarness, event: string, data: Record<string, unknown> = {}): Promise<void> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/hook-event',
    payload: { event, sessionId: SESSION_ID, data },
  });
  expect(res.statusCode).toBe(200);
}

async function listApprovals(harness: RouteTestHarness): Promise<Array<Record<string, unknown>>> {
  const res = await harness.app.inject({ method: 'GET', url: '/api/approvals' });
  expect(res.statusCode).toBe(200);
  return res.json().data.approvals;
}

describe('approval routes', () => {
  let harness: RouteTestHarness;
  let session: MockSession;

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
    session = harness.ctx.sessions.get(SESSION_ID)!;
    session.terminalBuffer = PERMISSION_DIALOG;
  });

  afterEach(async () => {
    for (const item of approvalInbox.listPending()) {
      approvalInbox.resolveForSession(item.sessionId, 'dismissed');
    }
    approvalInbox.onPending = approvalInbox.onUpdated = approvalInbox.onResolved = undefined;
    await harness.app.close();
  });

  it('a permission_prompt hook creates a pending item with parsed options and context', async () => {
    await postHook(harness, 'permission_prompt', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf node_modules' },
      message: 'Claude needs your permission to use Bash',
      cwd: '/tmp/case',
    });
    const approvals = await listApprovals(harness);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      sessionId: SESSION_ID,
      kind: 'permission',
      toolName: 'Bash',
      toolSummary: 'rm -rf node_modules',
      message: 'Claude needs your permission to use Bash',
    });
    expect(approvals[0].options).toHaveLength(3);
    expect(String(approvals[0].context)).toContain('permission to use Bash');
  });

  it('broadcast and push for the prompt carry the approvalId', async () => {
    await postHook(harness, 'permission_prompt', { tool_name: 'Bash' });
    const [item] = await listApprovals(harness);
    const hookBroadcast = harness.ctx.broadcast.mock.calls.find((c) => c[0] === 'hook:permission_prompt');
    expect(hookBroadcast?.[1]).toMatchObject({ approvalId: item.id });
    const push = harness.ctx.sendPushNotifications.mock.calls.find((c) => c[0] === 'hook:permission_prompt');
    expect(push?.[1]).toMatchObject({ approvalId: item.id });
  });

  it('answering with a parsed option sends exactly that digit (no Enter)', async () => {
    await postHook(harness, 'permission_prompt', { tool_name: 'Bash' });
    const [item] = await listApprovals(harness);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'option', option: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(session.writeBuffer).toEqual(['2']);
    expect(await listApprovals(harness)).toHaveLength(0);
  });

  it('approve sends "1", deny sends Esc', async () => {
    await postHook(harness, 'permission_prompt', {});
    let [item] = await listApprovals(harness);
    await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'approve' },
    });
    expect(session.writeBuffer).toEqual(['1']);

    session.writeBuffer.length = 0;
    await postHook(harness, 'permission_prompt', {});
    [item] = await listApprovals(harness);
    await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'deny' },
    });
    expect(session.writeBuffer).toEqual(['\x1b']);
  });

  it('a second answer 404s (answered items leave the inbox)', async () => {
    await postHook(harness, 'permission_prompt', {});
    const [item] = await listApprovals(harness);
    await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'approve' },
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'deny' },
    });
    expect(res.statusCode).toBe(404);
    expect(session.writeBuffer).toEqual(['1']);
  });

  it('rejects option digits outside the parsed options', async () => {
    await postHook(harness, 'permission_prompt', {});
    const [item] = await listApprovals(harness);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'option', option: 7 },
    });
    expect(res.statusCode).toBe(400);
    expect(session.writeBuffer).toEqual([]);
  });

  it('refuses with 409 when the dialog left the screen since capture', async () => {
    await postHook(harness, 'permission_prompt', {});
    const [item] = await listApprovals(harness);
    // The dialog scrolled away, so the re-capture at answer time must refuse.
    session.terminalBuffer = 'claude is off doing something else now';
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(session.writeBuffer).toEqual([]);
    expect(await listApprovals(harness)).toHaveLength(0);
  });

  it('idle prompts take a text answer, submitted with \\r; approve/deny are rejected', async () => {
    session.terminalBuffer = 'claude> waiting at the composer';
    await postHook(harness, 'idle_prompt', { message: 'Claude is waiting for your input' });
    const [item] = await listApprovals(harness);
    expect(item.kind).toBe('idle');

    const bad = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'approve' },
    });
    expect(bad.statusCode).toBe(400);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'text', text: 'continue with the plan\nplease' },
    });
    expect(res.statusCode).toBe(200);
    // Embedded newlines are flattened; the trailing \r submits.
    expect(session.writeBuffer).toEqual(['continue with the plan please\r']);
  });

  it('text answers on dialog items are rejected', async () => {
    await postHook(harness, 'elicitation_dialog', {});
    const [item] = await listApprovals(harness);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'text', text: 'hello' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stop resolves the pending item; elicitation_complete resolves questions', async () => {
    await postHook(harness, 'elicitation_dialog', {});
    expect(await listApprovals(harness)).toHaveLength(1);
    await postHook(harness, 'elicitation_complete', {});
    expect(await listApprovals(harness)).toHaveLength(0);

    await postHook(harness, 'permission_prompt', {});
    expect(await listApprovals(harness)).toHaveLength(1);
    await postHook(harness, 'stop', {});
    expect(await listApprovals(harness)).toHaveLength(0);
  });

  it('a failed write restores the item and reports 422', async () => {
    await postHook(harness, 'permission_prompt', {});
    const [item] = await listApprovals(harness);
    session.failWrites = true;
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(422);
    expect(await listApprovals(harness)).toHaveLength(1);
  });

  it('dismiss removes without keystrokes', async () => {
    await postHook(harness, 'permission_prompt', {});
    const [item] = await listApprovals(harness);
    const res = await harness.app.inject({ method: 'POST', url: `/api/approvals/${item.id}/dismiss`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(session.writeBuffer).toEqual([]);
    expect(await listApprovals(harness)).toHaveLength(0);
  });

  describe('staleness sweep on GET /api/approvals', () => {
    it('resolves an item whose dialog left the pane, and tells the other clients', async () => {
      const resolved: Array<Record<string, unknown>> = [];
      await postHook(harness, 'permission_prompt', { tool_name: 'Bash' });
      expect((await listApprovals(harness))[0].options).toHaveLength(3);

      // Answered in the terminal: Claude Code fires no hook for that, so only
      // the pane knows. The dialog is gone from the frame the next capture sees.
      approvalInbox.onResolved = (info) => resolved.push({ ...info });
      session.terminalBuffer = 'claude> back at the composer';

      expect(await listApprovals(harness)).toHaveLength(0);
      expect(resolved).toEqual([expect.objectContaining({ resolution: 'resolved_in_terminal' })]);
    });

    it('keeps an item whose dialog is still on screen', async () => {
      await postHook(harness, 'permission_prompt', { tool_name: 'Bash' });
      // Pane unchanged (PERMISSION_DIALOG): the human has not answered yet.
      expect(await listApprovals(harness)).toHaveLength(1);
      expect(await listApprovals(harness)).toHaveLength(1);
    });

    it('never drops an item that could not be read in the first place', async () => {
      // No parseable dialog at capture time, so a later "it does not parse" says
      // nothing new. Conservative by design: an unreadable pane keeps the alert.
      session.terminalBuffer = 'some output with no dialog in it';
      await postHook(harness, 'permission_prompt', { tool_name: 'Bash' });
      const [item] = await listApprovals(harness);
      expect(item.options).toBeUndefined();
      session.terminalBuffer = 'still nothing that parses';
      expect(await listApprovals(harness)).toHaveLength(1);
    });

    it('leaves idle prompts alone (they are not dialogs)', async () => {
      session.terminalBuffer = 'claude> waiting at the composer';
      await postHook(harness, 'idle_prompt', {});
      session.terminalBuffer = 'claude> still waiting, different frame';
      const [item] = await listApprovals(harness);
      expect(item.kind).toBe('idle');
    });
  });

  describe('an idle prompt from a session watching its own background work', () => {
    beforeEach(() => {
      session.terminalBuffer = 'claude> waiting at the composer';
      session.watching = '1 monitor';
    });

    it('opens acknowledged, so no surface has an alert to raise', async () => {
      await postHook(harness, 'idle_prompt', { message: 'Claude is waiting for your input' });
      const [item] = await listApprovals(harness);
      expect(item).toMatchObject({ kind: 'idle', acknowledgedReason: 'watching 1 monitor' });
      expect(item.acknowledgedAt).toEqual(expect.any(Number));
    });

    it('tells a live page why, so it declines to arm the alert', async () => {
      await postHook(harness, 'idle_prompt', {});
      const broadcast = harness.ctx.broadcast.mock.calls.find((c) => c[0] === 'hook:idle_prompt');
      expect(broadcast?.[1]).toMatchObject({ acknowledgedReason: 'watching 1 monitor' });
    });

    it('sends no push', async () => {
      // The loudest surface, and the one a false alarm is hardest to ignore on.
      await postHook(harness, 'idle_prompt', {});
      expect(harness.ctx.sendPushNotifications.mock.calls.find((c) => c[0] === 'hook:idle_prompt')).toBeUndefined();
    });

    it('stays answerable from the drawer', async () => {
      await postHook(harness, 'idle_prompt', {});
      const [item] = await listApprovals(harness);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/approvals/${item.id}/answer`,
        payload: { action: 'text', text: 'carry on' },
      });
      expect(res.statusCode).toBe(200);
      expect(session.writeBuffer.join('')).toContain('carry on');
    });

    it('still raises a permission dialog from the same session', async () => {
      // Watching says nothing about a dialog: that one blocks the agent outright.
      session.terminalBuffer = PERMISSION_DIALOG;
      await postHook(harness, 'permission_prompt', { tool_name: 'Bash' });
      const [item] = await listApprovals(harness);
      expect(item.acknowledgedAt).toBeUndefined();
      expect(item.acknowledgedReason).toBeUndefined();
      const broadcast = harness.ctx.broadcast.mock.calls.find((c) => c[0] === 'hook:permission_prompt');
      expect(broadcast?.[1]).not.toMatchObject({ acknowledgedReason: expect.any(String) });
      expect(harness.ctx.sendPushNotifications.mock.calls.find((c) => c[0] === 'hook:permission_prompt')).toBeDefined();
    });

    it('alerts normally again once the background work is over', async () => {
      await postHook(harness, 'idle_prompt', {});
      session.watching = null;
      await postHook(harness, 'idle_prompt', {});
      const [item] = await listApprovals(harness);
      expect(item.acknowledgedAt).toBeUndefined();
      expect(harness.ctx.sendPushNotifications.mock.calls.filter((c) => c[0] === 'hook:idle_prompt')).toHaveLength(1);
    });
  });

  it('viewing a session acknowledges its idle prompt (item stays pending) and broadcasts it', async () => {
    session.terminalBuffer = 'claude> waiting at the composer';
    await postHook(harness, 'idle_prompt', {});
    const [before] = await listApprovals(harness);
    expect(before.acknowledgedAt).toBeUndefined();

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/session/${SESSION_ID}/viewed`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ sessionId: SESSION_ID, acknowledged: before.id });

    // Seen, not answered: still listed (so it stays answerable), no keystrokes,
    // and clients skip re-arming the tab alert because of acknowledgedAt.
    const [after] = await listApprovals(harness);
    expect(after.id).toBe(before.id);
    expect(after.acknowledgedAt).toBeGreaterThan(0);
    expect(session.writeBuffer).toEqual([]);

    // Second view is a no-op (nothing new to tell the other devices).
    const again = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/session/${SESSION_ID}/viewed`,
      payload: {},
    });
    expect(again.json().data.acknowledged).toBeNull();
  });

  it('viewing a session leaves a permission dialog alerting (looking is not answering)', async () => {
    await postHook(harness, 'permission_prompt', {});
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/session/${SESSION_ID}/viewed`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.acknowledged).toBeNull();
    const [item] = await listApprovals(harness);
    expect(item.kind).toBe('permission');
    expect(item.acknowledgedAt).toBeUndefined();
  });

  it('viewing an unknown session 404s', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/approvals/session/not-a-session/viewed',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('non-claude sessions never get inbox items', async () => {
    session.mode = 'codex';
    await postHook(harness, 'permission_prompt', {});
    expect(await listApprovals(harness)).toHaveLength(0);
  });

  it('unknown ids 404 on answer and dismiss', async () => {
    for (const url of ['/api/approvals/nope:1/answer', '/api/approvals/nope:1/dismiss']) {
      const res = await harness.app.inject({
        method: 'POST',
        url,
        payload: url.endsWith('answer') ? { action: 'approve' } : {},
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('approval routes: multi-user scoping', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.CODEMAN_MULTIUSER = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = '1';
  });

  afterEach(() => {
    if (saved.CODEMAN_MULTIUSER === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = saved.CODEMAN_MULTIUSER;
    for (const item of approvalInbox.listPending()) {
      approvalInbox.resolveForSession(item.sessionId, 'dismissed');
    }
  });

  it("a non-admin neither lists nor answers another user's approvals (404, not 403)", async () => {
    const harness = await createEnvelopeHarness({ username: 'bob', role: 'user' });
    const session = harness.ctx.sessions.get(SESSION_ID)!;
    session.terminalBuffer = PERMISSION_DIALOG;
    (session as unknown as { owner?: string }).owner = 'alice';

    await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: { event: 'permission_prompt', sessionId: SESSION_ID, data: {} },
    });
    // The item exists in the store...
    expect(approvalInbox.listPending()).toHaveLength(1);
    const [item] = approvalInbox.listPending();

    // ...but bob sees an empty list and cannot act on the id.
    const list = await harness.app.inject({ method: 'GET', url: '/api/approvals' });
    expect(list.json().data.approvals).toHaveLength(0);
    const answer = await harness.app.inject({
      method: 'POST',
      url: `/api/approvals/${item.id}/answer`,
      payload: { action: 'approve' },
    });
    expect(answer.statusCode).toBe(404);
    expect(session.writeBuffer).toEqual([]);

    await harness.app.close();
  });
});
