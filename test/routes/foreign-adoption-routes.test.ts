/**
 * @fileoverview The HTTP surface of foreign-tmux adoption, and the gates that
 * keep Codeman from driving a session it did not start.
 *
 * An adopted session wraps a process SOMEONE ELSE launched. Its `mode` is
 * whatever the probe saw — very often `claude` — so every refusal here has to
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

const SID = 'adopted-1';

// The stand-in defaults to "found nothing", which is what real discovery gives
// under VITEST — so mocking the module does not change the tests that predate it.
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

  it('is admin-only in multi-user mode — it exposes every user’s processes and cwds', async () => {
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

  it('is admin-only in multi-user mode — adopting a shell is arbitrary host execution', async () => {
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
    // Keyed on (socket, session) and not on our opaque candidate id: a wrapper
    // restored after a server restart does not carry that id.
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    ctx.sessions.set('wrapper-1', ctx._session);
    ctx.mux.getSessions = vi.fn(() => [
      { sessionId: 'wrapper-1', adopt: { socketPath: CANDIDATE.socketPath, targetSession: CANDIDATE.sessionName } },
    ]) as unknown as typeof ctx.mux.getSessions;
    const res = await app.inject({ method: 'POST', url: '/api/sessions/adopt', payload: { id: 'cand-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyAdopted).toBe(true);
    expect(ctx.addSession).not.toHaveBeenCalled();
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
