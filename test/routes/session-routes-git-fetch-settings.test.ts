/**
 * `POST /api/sessions/:id/git-fetch-settings` (session-routes.ts): the per-case half of the fetch interval
 * (src/git-fetch-scheduler.ts): the case's own switch and its own interval. `null` on either half clears
 * that half so the app-wide setting applies again, and a body that names one row leaves the other as it was,
 * because the Session Options rows save on their own. Refused for remote and Docker cases, the same rule the
 * Git panel and the scheduler use. app.inject(), no port.
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

describe('POST /api/sessions/:id/git-fetch-settings', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const post = (payload: unknown) =>
    harness.app.inject({ method: 'POST', url: `/api/sessions/${harness.ctx._sessionId}/git-fetch-settings`, payload });

  it('stores the case’s own choice, persists and broadcasts it', async () => {
    const res = await post({ enabled: true, intervalSeconds: 120 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.gitFetchSettings).toEqual({ enabled: true, intervalSeconds: 120 });
    expect(harness.ctx._session.gitFetchEnabled).toBe(true);
    expect(harness.ctx._session.gitFetchIntervalSeconds).toBe(120);
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();
  });

  it('answers `null` for a case that follows the app, which is what the Session Options row shows', async () => {
    const data = JSON.parse((await post({})).body).data.gitFetchSettings;
    expect(data).toEqual({ enabled: null, intervalSeconds: null });
  });

  it('clears the override on null so the app-wide setting applies again', async () => {
    await post({ enabled: true, intervalSeconds: 120 });
    const res = await post({ enabled: null, intervalSeconds: null });
    expect(res.statusCode).toBe(200);
    expect(harness.ctx._session.gitFetchEnabled).toBeUndefined();
    expect(harness.ctx._session.gitFetchIntervalSeconds).toBeUndefined();
    expect(JSON.parse(res.body).data.gitFetchSettings).toEqual({ enabled: null, intervalSeconds: null });
  });

  it('leaves the other half as it was when only one row was saved', async () => {
    await post({ enabled: true });
    expect(harness.ctx._session.gitFetchIntervalSeconds).toBeUndefined(); // still following the app on that half
    const res = await post({ intervalSeconds: 90 });
    expect(JSON.parse(res.body).data.gitFetchSettings).toEqual({ enabled: true, intervalSeconds: 90 });
  });

  it('rejects an interval outside the schema bounds, storing nothing, because that is what the scheduler acts on', async () => {
    // `null` is NOT on this list: it is the schema's way of clearing the override, tested above.
    for (const raw of [29, 3601, 12.5, '120', true]) {
      const res = await post({ enabled: true, intervalSeconds: raw });
      expect(res.statusCode, String(raw)).toBe(400);
    }
    expect(harness.ctx._session.gitFetchEnabled).toBeUndefined();
    expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
  });

  it.each([
    ['remote', { host: 'h', user: 'u' }],
    ['docker', { container: 'c' }],
  ])('refuses a %s case, storing nothing', async (kind, value) => {
    (harness.ctx._session as unknown as Record<string, unknown>)[kind] = value;
    const res = await post({ enabled: true, intervalSeconds: 120 });
    expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(harness.ctx._session.gitFetchEnabled).toBeUndefined();
    expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
  });

  it('404s an unknown session, storing nothing', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/nope/git-fetch-settings',
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
  });
});
