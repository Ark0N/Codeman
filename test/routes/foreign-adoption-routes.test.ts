/**
 * @fileoverview The HTTP surface of foreign-tmux adoption, and the gates that
 * keep Codeman from driving a session it did not start.
 *
 * An adopted session wraps a process SOMEONE ELSE launched. Its `mode` is
 * whatever the probe saw (very often `claude`), so every refusal here has to
 * be its own `isAdopted` check and not a side effect of the external-CLI rule.
 * The two questions are different ("is this CLI one we drive?" vs "did we start
 * this process?"), and folding them into one means the day the first loosens,
 * Codeman silently starts sending `/clear` into someone's live conversation.
 *
 * Every refusal is paired with a session Codeman DID start, or a broken
 * endpoint would satisfy the refusal assertion just as well.
 *
 * Port: none (app.inject()).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The adopt route RE-RESOLVES the candidate rather than trusting the body, and
// real discovery is disabled under VITEST, so the success path is unreachable
// without standing in for it. Everything downstream of the lookup is real.
const discoverForeignSessions = vi.fn();
const invalidateForeignCache = vi.fn();
vi.mock('../../src/foreign-tmux-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foreign-tmux-discovery.js')>();
  return {
    ...actual,
    discoverForeignSessions: (...a: unknown[]) => discoverForeignSessions(...(a as [])),
    invalidateForeignCache: () => invalidateForeignCache(),
    readAllDockerCases: async () => [],
    readAllRemoteHosts: async () => [],
  };
});

import { createRouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerRespawnRoutes } from '../../src/web/routes/respawn-routes.js';
import { registerRalphRoutes } from '../../src/web/routes/ralph-routes.js';
import { registerMuxRoutes } from '../../src/web/routes/mux-routes.js';
import { registerGitStatusRoutes } from '../../src/web/routes/git-status-routes.js';
import { adoptTargetIdentity, foreignTargetKey } from '../../src/foreign-tmux.js';
import type { SessionAdopt } from '../../src/types/session.js';

const SID = 'adopted-1';

// The stand-in defaults to "found nothing", which is what real discovery gives
// under VITEST, so mocking the module does not change the tests that predate it.
beforeEach(() => {
  discoverForeignSessions.mockReset();
  discoverForeignSessions.mockResolvedValue({ sessions: [], notes: [] });
  invalidateForeignCache.mockClear();
});

describe('adopted sessions refuse every auto-op that drives the pane', () => {
  for (const route of ['auto-clear', 'auto-compact', 'auto-resume']) {
    it(`refuses POST /api/sessions/:id/${route}`, async () => {
      const h = await createRouteTestHarness(registerSessionRoutes, { sessionId: SID });
      (h.ctx._session as unknown as { isAdopted: boolean }).isAdopted = true;
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/sessions/${SID}/${route}`,
        payload: { enabled: true },
      });
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/adopted/i);
      await h.app.close();
    });

    it(`still allows ${route} on a session Codeman started`, async () => {
      const h = await createRouteTestHarness(registerSessionRoutes, { sessionId: SID });
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/sessions/${SID}/${route}`,
        payload: { enabled: true },
      });
      expect(res.json().success).toBe(true);
      await h.app.close();
    });
  }

  it('refuses a one-shot prompt, which would start a new local claude in /tmp', async () => {
    const h = await createRouteTestHarness(registerSessionRoutes, { sessionId: SID });
    (h.ctx._session as unknown as { isAdopted: boolean }).isAdopted = true;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/run`,
      payload: { prompt: 'hello' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/adopted/i);
    expect(h.ctx._session.runPrompt).not.toHaveBeenCalled();
    await h.app.close();
  });

  it('still runs a one-shot prompt on a session Codeman started', async () => {
    const h = await createRouteTestHarness(registerSessionRoutes, { sessionId: SID });
    await h.app.inject({ method: 'POST', url: `/api/sessions/${SID}/run`, payload: { prompt: 'hello' } });
    expect(h.ctx._session.runPrompt).toHaveBeenCalledWith('hello');
    await h.app.close();
  });

  it('refuses respawn, for a harder reason: it kills and restarts the pane', async () => {
    const h = await createRouteTestHarness(registerRespawnRoutes, { sessionId: SID });
    (h.ctx._session as unknown as { isAdopted: boolean }).isAdopted = true;
    const res = await h.app.inject({ method: 'POST', url: `/api/sessions/${SID}/respawn/start`, payload: {} });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/adopted/i);
    await h.app.close();
  });

  it('refuses Ralph config', async () => {
    const h = await createRouteTestHarness(registerRalphRoutes, { sessionId: SID });
    (h.ctx._session as unknown as { isAdopted: boolean }).isAdopted = true;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/ralph-config`,
      payload: { maxTodos: 10 },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/adopted/i);
    await h.app.close();
  });

  // ⚠️ Neither of these is a mock-only concern: an adopted session's `workingDir` is the
  // neutral wrapper folder `/tmp`, so a live one wrote `/tmp/@ralph_prompt.md` on the host
  // and answered success, a predictable name in a folder anyone can write to.
  describe.each([
    ['fix-plan/write', {}],
    ['fix-plan/read', {}],
    ['ralph-prompt/write', { content: 'prompt' }],
  ])('POST %s', (route, payload) => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'adopted-ralph-'));
      writeFileSync(join(dir, '@fix_plan.md'), '- [ ] task\n');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const post = async (isAdopted: boolean) => {
      const h = await createRouteTestHarness(registerRalphRoutes, { sessionId: SID });
      const ralphTracker = { todos: [], generateFixPlanMarkdown: () => '', importFixPlanMarkdown: () => 0 };
      Object.assign(h.ctx._session as object, { isAdopted, workingDir: dir, ralphTracker });
      const res = await h.app.inject({ method: 'POST', url: `/api/sessions/${SID}/${route}`, payload });
      await h.app.close();
      return res.json();
    };

    it('refuses an adopted session and touches nothing', async () => {
      const before = readdirSync(dir);
      const body = await post(true);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/adopted/i);
      expect(readdirSync(dir)).toEqual(before);
    });

    it('still answers for a session Codeman started', async () => {
      expect((await post(false)).success).toBe(true);
    });
  });
});

describe('GET /api/mux/foreign', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CODEMAN_MULTIUSER;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = prev;
  });

  it('is admin-only in multi-user mode: it exposes every user’s processes and cwds', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerMuxRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/mux/foreign' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it('answers an admin', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerMuxRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    expect((await app.inject({ method: 'GET', url: '/api/mux/foreign' })).statusCode).toBe(200);
    await app.close();
  });

  it('answers in single-user mode, where the admin gate is a no-op', async () => {
    delete process.env.CODEMAN_MULTIUSER;
    const { app } = await createRouteTestHarness(registerMuxRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/mux/foreign' });
    expect(res.statusCode).toBe(200);
    // Real discovery is disabled under VITEST, so this pins the shape, not the
    // content. The body is bare here: the uniform envelope is applied by the
    // server's own hook, which a single-route harness does not install.
    expect(res.json()).toHaveProperty('sessions');
    expect(res.json()).toHaveProperty('canScanWide');
    await app.close();
  });
});

describe('POST /api/sessions/adopt', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CODEMAN_MULTIUSER;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = prev;
  });

  it('is admin-only in multi-user mode: adopting a shell is arbitrary host execution', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerSessionRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'x' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it('404s when the re-resolve no longer sees the target', async () => {
    // The browser hands back only an opaque id; the socket path and session name
    // are re-derived server-side, so a vanished target is simply absent from the
    // fresh list.
    const { app } = await createRouteTestHarness(registerSessionRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'nope' } });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('NOT_FOUND');
    await app.close();
  });

  it('rejects a body that tries to supply a socket path or session name', async () => {
    // The schema takes the opaque id and nothing else. That is why a path can
    // never reach the launch chain from the browser.
    const { app } = await createRouteTestHarness(registerSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/adopt',
      payload: { id: 'x', socketPath: '/tmp/tmux-0/default', targetSession: 'work' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    await app.close();
  });
});

/** The adoption record of a local wrapper, as the route writes it. */
function localAdopt(socketPath: string, targetSession: string): SessionAdopt {
  return { location: 'local', socketPath, targetSession, viewSession: 'codeman-view-00000000' };
}

describe('a successful adoption', () => {
  /** A candidate whose cwd is BOTH unsafe for SAFE_PATH_PATTERN and not on this host. */
  const CANDIDATE = {
    id: 'cand-1',
    location: 'local' as const,
    socketPath: '/tmp/tmux-0/default',
    sessionName: 'work',
    mode: 'claude' as const,
    workingDir: '/home/them/Program Files (x86)/c++',
    command: 'claude',
    panePid: 4242,
    paneCurrentCommand: 'node',
    createdAt: 1,
    windows: 1,
    attached: false,
  };

  beforeEach(() => {
    discoverForeignSessions.mockResolvedValue({ sessions: [CANDIDATE], notes: [] });
  });

  it('gives the wrapper a neutral LOCAL workingDir, never the foreign pane\u2019s cwd', async () => {
    // That cwd carries `+`, spaces and parentheses, so using it would make
    // createSession throw and the tab would never start; and when the candidate
    // is a container or ssh pane it is not a path on this host at all, which is
    // what sent the boot hook sweep into someone else's repo.
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    expect(res.statusCode).toBe(200);
    expect(ctx.addSession).toHaveBeenCalledTimes(1);
    const created = ctx.addSession.mock.calls[0][0] as unknown as {
      workingDir: string;
      adopt?: { paneCurrentPath?: string; targetSession?: string; viewSession?: string };
    };
    expect(created.workingDir).toBe('/tmp');
    expect(created.workingDir).not.toBe(CANDIDATE.workingDir);
    // The foreign cwd survives for display only.
    expect(created.adopt?.paneCurrentPath).toBe(CANDIDATE.workingDir);
    await app.close();
  });

  it('reuses the existing wrapper rather than making a second one for the same target', async () => {
    // Keyed on the target and not on our opaque candidate id: a wrapper restored
    // after a server restart does not carry that id.
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    ctx.sessions.set('wrapper-1', ctx._session);
    ctx._session.adopt = localAdopt(CANDIDATE.socketPath, CANDIDATE.sessionName);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyAdopted).toBe(true);
    expect(ctx.addSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('sees a wrapper whose tab has not started yet, which has no mux record to find', async () => {
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    const first = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    expect(first.json().adopted).toBe(true);
    expect(ctx.mux.getSessions()).toEqual([]);
    const second = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    expect(second.json().alreadyAdopted).toBe(true);
    expect(ctx.addSession).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuses a second adopt of a target whose wrapper is still being created', async () => {
    // Two devices on one row: both pass the live-session check, because the first
    // is parked on the layout lock and not yet in the map.
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    const add = ctx.addSession.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    ctx.addSession.mockImplementationOnce(async (s: never) => {
      await held;
      return add(s);
    });
    const first = app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    await vi.waitFor(() => expect(ctx.addSession).toHaveBeenCalledTimes(1));
    const second = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    expect(second.json().success).toBe(false);
    expect(second.json().errorCode).toBe('SESSION_BUSY');
    release();
    expect((await first).json().adopted).toBe(true);
    expect(ctx.addSession).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('says "could not reach it" rather than "gone" when discovery left a note', async () => {
    // On a flaky link the session is alive and sitting right there; reporting
    // it as deleted is the wrong answer, not just an unhelpful one.
    discoverForeignSessions.mockResolvedValue({ sessions: [], notes: ['ssh box: connection timed out'] });
    const { app } = await createRouteTestHarness(registerSessionRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/Could not reach it/);
    expect(res.json().error).toContain('connection timed out');
    await app.close();
  });

  it('carries the adopt metadata that a restart needs to rebuild the command', async () => {
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    const created = ctx.addSession.mock.calls[0][0] as unknown as {
      adopt?: { socketPath?: string; targetSession?: string; viewSession?: string };
      isAdopted?: boolean;
    };
    expect(created.isAdopted).toBe(true);
    expect(created.adopt?.socketPath).toBe(CANDIDATE.socketPath);
    expect(created.adopt?.targetSession).toBe(CANDIDATE.sessionName);
    // Derived from the Codeman session id, so it is provably ours to kill.
    expect(created.adopt?.viewSession).toMatch(/^codeman-view-/);
    await app.close();
  });
});

describe('same-named sessions in different locations', () => {
  // Containers commonly run tmux as root with default names, so `0` in two
  // containers is the same (socket, name) pair, and the same goes for this machine
  // and an ssh host with the same uid.
  const SHARED = {
    socketPath: '/tmp/tmux-0/default',
    sessionName: '0',
    mode: 'shell' as const,
    workingDir: '/workspace',
    command: 'bash',
    createdAt: 1,
    windows: 1,
    attached: false,
  };
  const IN_A = { ...SHARED, id: 'in-a', location: 'docker' as const, hostId: 'h1', containerName: 'box-a' };
  const IN_B = { ...SHARED, id: 'in-b', location: 'docker' as const, hostId: 'h1', containerName: 'box-b' };
  const OTHER_ENGINE = { ...SHARED, id: 'in-c', location: 'docker' as const, hostId: 'h2', containerName: 'box-a' };
  const ON_THIS_HOST = { ...SHARED, id: 'here', location: 'local' as const };

  beforeEach(() => {
    discoverForeignSessions.mockResolvedValue({ sessions: [IN_A, IN_B, OTHER_ENGINE, ON_THIS_HOST], notes: [] });
  });

  it('gives each location its own key, and a wrapper the key of its candidate', () => {
    const keys = [IN_A, IN_B, OTHER_ENGINE, ON_THIS_HOST].map(foreignTargetKey);
    expect(new Set(keys).size).toBe(4);
    expect(
      foreignTargetKey(
        adoptTargetIdentity({
          ...localAdopt(SHARED.socketPath, SHARED.sessionName),
          location: 'docker',
          docker: { hostId: 'h1', label: 'one', engine: 'docker', containerName: 'box-b' },
        })
      )
    ).toBe(foreignTargetKey(IN_B));
  });

  it('adopting one never returns the tab of another', async () => {
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    const a = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'in-a', docker: true } });
    const b = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'in-b', docker: true } });
    const local = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'here' } });
    for (const res of [a, b, local]) expect(res.json().adopted).toBe(true);
    expect(ctx.addSession).toHaveBeenCalledTimes(3);
    const ids = [a, b, local].map((res) => res.json().session.id);
    expect(new Set(ids).size).toBe(3);
    await app.close();
  });

  it('marks only the row that is really open as open', async () => {
    const { app, ctx } = await createRouteTestHarness(registerMuxRoutes);
    ctx.sessions.set('wrapper-b', {
      id: 'wrapper-b',
      adopt: {
        ...localAdopt(SHARED.socketPath, SHARED.sessionName),
        location: 'docker',
        docker: { hostId: 'h1', label: 'one', engine: 'docker', containerName: 'box-b' },
      },
    } as never);
    const res = await app.inject({ method: 'GET', url: '/api/mux/foreign' });
    const adoptedBy = Object.fromEntries(
      (res.json().sessions as { id: string; adoptedBy?: string }[]).map((s) => [s.id, s.adoptedBy])
    );
    expect(adoptedBy).toEqual({ 'in-a': undefined, 'in-b': 'wrapper-b', 'in-c': undefined, here: undefined });
    await app.close();
  });
});

describe('an adopted session has no workspace of ours', () => {
  // Its `workingDir` is the neutral `/tmp`, which local-looking code would take for
  // the session's folder: uploads landed there and the tab's close deleted them, and
  // a Git panel or fetch ran git on whatever sat there. Each refusal is paired with a
  // plain session, or a broken route would pass it too.
  const adopted = (s: { isAdopted: boolean; adopt?: SessionAdopt }) => {
    s.isAdopted = true;
    s.adopt = localAdopt('/tmp/tmux-1000/default', 'work');
  };

  it('refuses a prompt upload before touching disk', async () => {
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    adopted(ctx._session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/paste-image`,
      headers: { 'x-codeman-csrf': '1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/adopted/);
    await app.close();
  });

  it('refuses the image watcher, and leaves it alone being switched off', async () => {
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    adopted(ctx._session);
    const post = (enabled: boolean) =>
      app.inject({ method: 'POST', url: `/api/sessions/${ctx._sessionId}/image-watcher`, payload: { enabled } });
    expect((await post(true)).json().success).toBe(false);
    expect((await post(false)).json().success).toBe(true);
    await app.close();
  });

  it('refuses the per-session git fetch settings', async () => {
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    adopted(ctx._session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/git-fetch-settings`,
      payload: { enabled: true },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/adopted/);
    await app.close();
  });

  it('refuses a custom model, which restarts the CLI in the pane', async () => {
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    adopted(ctx._session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/custom-model`,
      payload: { clear: true },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/adopted/);
    await app.close();
  });

  it('answers unsupported on the git routes, running no git', async () => {
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const { app, ctx } = await createRouteTestHarness((a, c) =>
      registerGitStatusRoutes(a, c, git as never, async () => [])
    );
    adopted(ctx._session);
    const status = await app.inject({ method: 'GET', url: `/api/sessions/${ctx._sessionId}/git-status` });
    expect(status.json()).toMatchObject({ success: true, data: { state: 'unsupported', reason: 'adopted' } });
    const fetch = await app.inject({ method: 'POST', url: `/api/sessions/${ctx._sessionId}/git-fetch` });
    expect(fetch.json()).toMatchObject({ success: true, data: { state: 'unsupported', reason: 'adopted' } });
    const diff = await app.inject({
      method: 'GET',
      url: `/api/sessions/${ctx._sessionId}/git-diff?repo=x&path=y&kind=z`,
    });
    expect(diff.statusCode).toBe(400);
    expect(git).not.toHaveBeenCalled();
    await app.close();
  });

  describe('last-response', () => {
    let project: string;
    beforeEach(() => {
      project = join(process.env.HOME!, '.claude', 'projects', '-tmp');
      mkdirSync(project, { recursive: true });
    });
    afterEach(() => {
      rmSync(project, { recursive: true, force: true });
    });

    it('never pairs a transcript by the wrapper folder or the id we launched nothing with', async () => {
      const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
      (ctx._session as unknown as { mode: string }).mode = 'claude';
      writeFileSync(
        join(project, `${ctx._sessionId}.jsonl`),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-21T00:00:01Z',
          message: { content: [{ type: 'text', text: 'an answer from another conversation' }] },
        })
      );
      const read = async () =>
        (await app.inject({ method: 'GET', url: `/api/sessions/${ctx._sessionId}/last-response` })).json();
      expect((await read()).text).toBe('an answer from another conversation');
      adopted(ctx._session);
      expect((await read()).text).toBe('');
      await app.close();
    });
  });
});
