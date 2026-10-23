/** @fileoverview Agent inspection and guarded input HTTP contracts (no live ports). */
import { afterEach, describe, expect, it } from 'vitest';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

let harness: RouteTestHarness;
afterEach(async () => {
  await harness?.app.close();
});
describe('agent session routes', () => {
  it('returns an explicitly bounded pane snapshot when no attributed transcript exists', async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
    const session = [...harness.ctx.sessions.values()][0];
    const result = await harness.app.inject({ url: `/api/sessions/${session.id}/inspect?maxBytes=20` });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.data.source).toBe('pane-snapshot');
    expect(body.data.cursor).toBeNull();
    expect(Buffer.byteLength(body.data.evidence)).toBeLessThanOrEqual(20);
  });
  it('refuses guarded staging for an uncharacterized composer', async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
    const session = [...harness.ctx.sessions.values()][0];
    const result = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/stage`,
      payload: { message: 'hello' },
    });
    expect(result.statusCode).toBe(409);
  });
});

it('checks ownership before inspection, stage and submit', async () => {
  process.env.CODEMAN_MULTIUSER = '1';
  try {
    harness = await createRouteTestHarness(registerSessionRoutes, { authUser: { username: 'alice', role: 'user' } });
    const session = [...harness.ctx.sessions.values()][0];
    session.owner = 'bob';
    for (const request of [
      { method: 'GET' as const, url: `/api/sessions/${session.id}/inspect` },
      { method: 'POST' as const, url: `/api/sessions/${session.id}/stage`, payload: { message: 'hello' } },
      {
        method: 'POST' as const,
        url: `/api/sessions/${session.id}/submit`,
        payload: { stageId: '11111111-1111-4111-8111-111111111111', confirmSha: 'a'.repeat(64) },
      },
    ])
      expect((await harness.app.inject(request)).statusCode).toBe(404);
    expect(session.writeBuffer).toEqual([]);
  } finally {
    delete process.env.CODEMAN_MULTIUSER;
  }
});
it('validates output budgets and refuses to resume a pane fallback', async () => {
  harness = await createRouteTestHarness(registerSessionRoutes);
  const session = [...harness.ctx.sessions.values()][0];
  session.terminalBuffer = '😀é'.repeat(20);
  for (const value of ['0', '-1', '65537', '1.5', 'NaN'])
    expect(
      (await harness.app.inject({ url: `/api/sessions/${session.id}/inspect?maxBytes=${value}` })).statusCode
    ).toBe(400);
  const result = (await harness.app.inject({ url: `/api/sessions/${session.id}/inspect?maxBytes=7` })).json();
  expect(result.data.evidence).not.toContain('�');
  expect(Buffer.byteLength(result.data.evidence)).toBeLessThanOrEqual(7);
  expect(result.data.truncated).toBe(true);
  expect(
    (
      await harness.app.inject({
        url: `/api/sessions/${session.id}/inspect?since=11111111-1111-4111-8111-111111111111`,
      })
    ).statusCode
  ).toBe(409);
});
it('uses real session writes to stage without Enter and refuses intervening API input', async () => {
  const { Session } = await import('../../src/session.js');
  const { formatPaneSnapshot } = await import('../../src/tmux-manager.js');
  harness = await createRouteTestHarness(registerSessionRoutes);
  let composer = '';
  const writes: string[] = [];
  const session = new Session({
    id: 'guarded-session',
    workingDir: '/tmp',
    mode: 'codex',
    mux: {
      isAvailable: () => true,
      capturePaneBuffer: () =>
        formatPaneSnapshot([`› ${composer}`, '  GPT-6-Luna default · ~/case'], {
          cols: 100,
          rows: 20,
          cursorX: 2 + composer.length,
          cursorY: 0,
        }),
      sendInput: async (_id: string, text: string, options?: { beforeDispatch?: () => boolean }) => {
        if (options?.beforeDispatch && !options.beforeDispatch()) return false;
        writes.push(text);
        composer += text;
        return true;
      },
    },
    muxSession: { muxName: 'codeman-test', sessionId: 'guarded-session', createdAt: 1, pid: 1 },
  } as unknown as ConstructorParameters<typeof Session>[0]);
  (harness.ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
  try {
    const stage = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/stage`,
      payload: { message: 'hello' },
    });
    expect(stage.statusCode).toBe(200);
    expect(writes).toEqual(['hello']);
    const { stageId, sha256 } = stage.json().data;
    const submit = () =>
      harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/submit`,
        payload: { stageId, confirmSha: sha256 },
      });
    expect((await submit()).statusCode).toBe(200);
    expect(writes).toEqual(['hello', '\r']);
    expect((await submit()).statusCode).toBe(409);
    composer = '';
    const next = (
      await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/stage`,
        payload: { message: 'again' },
      })
    ).json().data;
    await session.writeViaMux('x');
    composer = 'again'; // Even restoring the visible text cannot erase the input revision.
    const stale = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/submit`,
      payload: { stageId: next.stageId, confirmSha: next.sha256 },
    });
    expect(stale.statusCode).toBe(409);
    expect(writes.filter((s) => s === '\r')).toHaveLength(1);
  } finally {
    await session.stop(false);
  }
});
it('reads only a strictly attributed Codex rollout and binds HTTP cursors to its owner', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Session } = await import('../../src/session.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-inspect-route-'));
  const home = join(root, 'codex');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const session = new Session({
    id: 'inspect-session',
    workingDir: root,
    mode: 'codex',
    envOverrides: { CODEX_HOME: home },
  });
  const id = '11111111-1111-4111-8111-111111111111';
  const row =
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, originator: `codeman_${session.id}` } }) + '\n';
  await writeFile(join(home, 'sessions', `rollout-${id}.jsonl`), row + '{"text":"hello"}\n');
  harness = await createRouteTestHarness(registerSessionRoutes, { authUser: { username: 'alice', role: 'admin' } });
  (harness.ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
  try {
    const first = await harness.app.inject({
      url: `/api/sessions/${session.id}/inspect?maxBytes=${Buffer.byteLength(row)}`,
    });
    expect(first.statusCode).toBe(200);
    const data = first.json().data;
    expect(data.source).toBe('codex-jsonl');
    expect(data.evidence).toBe('{\"text\":\"hello\"}\n');
    expect(data.omittedBeforeBytes).toBe(Buffer.byteLength(row));
    expect(data.identity).toEqual({ sessionId: session.id, mode: 'codex', conversationId: id });
    expect(data.cursor).not.toContain(home);
    const next = await harness.app.inject({ url: `/api/sessions/${session.id}/inspect?since=${data.cursor}` });
    expect(next.json().data.evidence).toBe('');
    session.owner = 'changed-owner';
    expect(
      (await harness.app.inject({ url: `/api/sessions/${session.id}/inspect?since=${data.cursor}` })).statusCode
    ).toBe(409);
  } finally {
    await session.stop(false);
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a stale launch-resume cursor once a new managed rollout conflicts with it', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Session } = await import('../../src/session.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-resume-conflict-'));
  const home = join(root, 'codex');
  const old = '11111111-1111-4111-8111-111111111111',
    fresh = '22222222-2222-4222-8222-222222222222';
  await mkdir(join(home, 'sessions'), { recursive: true });
  const session = new Session({
    id: 'resumed-session',
    workingDir: root,
    mode: 'codex',
    envOverrides: { CODEX_HOME: home },
    codexConfig: { resumeSessionId: old },
  });
  const row = (id: string, originator: string) =>
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, originator } }) + '\n';
  await writeFile(join(home, 'sessions', `rollout-${old}.jsonl`), row(old, 'original-launch'));
  harness = await createRouteTestHarness(registerSessionRoutes);
  (harness.ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
  try {
    const initial = (await harness.app.inject({ url: `/api/sessions/${session.id}/inspect` })).json().data;
    expect(initial.source).toBe('codex-jsonl');
    await writeFile(join(home, 'sessions', `rollout-${fresh}.jsonl`), row(fresh, `codeman_${session.id}`));
    const stale = await harness.app.inject({ url: `/api/sessions/${session.id}/inspect?since=${initial.cursor}` });
    expect(stale.statusCode).toBe(409);
    const fallback = (await harness.app.inject({ url: `/api/sessions/${session.id}/inspect` })).json().data;
    expect(fallback.source).toBe('pane-snapshot');
    expect(fallback.cursor).toBeNull();
  } finally {
    await session.stop(false);
    await rm(root, { recursive: true, force: true });
  }
});
