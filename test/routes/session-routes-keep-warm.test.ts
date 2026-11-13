/**
 * `POST /api/sessions/:id/keep-warm` (session-routes.ts): the per-session opt-in for the
 * prompt-cache keep-warm. Stores the choice, persists and broadcasts the session, asks the
 * scheduler to re-evaluate, clears the choice on `null`, and refuses a CLI with no cache
 * telemetry. app.inject(), no port.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

describe('POST /api/sessions/:id/keep-warm', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const post = (payload: unknown) =>
    harness.app.inject({ method: 'POST', url: `/api/sessions/${harness.ctx._sessionId}/keep-warm`, payload });

  it('stores the choice, persists, broadcasts and re-evaluates', async () => {
    const res = await post({ enabled: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.keepWarm).toMatchObject({ enabled: true });
    expect(harness.ctx._session.keepWarmEnabled).toBe(true);
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();
    expect(harness.ctx.keepWarm.schedule).toHaveBeenCalledWith(harness.ctx._sessionId);
    // The re-evaluation runs first, so the broadcast state and the response carry the new status.
    expect(harness.ctx.keepWarm.schedule.mock.invocationCallOrder[0]).toBeLessThan(
      harness.ctx.persistSessionState.mock.invocationCallOrder[0]
    );
  });

  it('clears the choice on null so the app-wide default applies again', async () => {
    await post({ enabled: false });
    const res = await post({ enabled: null });
    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.keepWarmEnabled).toBeUndefined();
    expect(JSON.parse(res.body).data.keepWarm.enabled).toBeNull();
  });

  it('rejects a body without enabled', async () => {
    expect((await post({})).statusCode).toBe(400);
  });

  it('refuses a CLI that reports no cache telemetry', async () => {
    harness.ctx._session.mode = 'shell';
    const res = await post({ enabled: true });
    // This harness has no envelope hook, so the refusal shows in the body, not the status.
    expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(harness.ctx._session.keepWarmEnabled).toBeUndefined();
    expect(harness.ctx.keepWarm.schedule).not.toHaveBeenCalled();
  });
});
