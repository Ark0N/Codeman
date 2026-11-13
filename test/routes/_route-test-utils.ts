/**
 * Shared utilities for route testing.
 *
 * Creates minimal Fastify instances with just the route module under test
 * and a mock context. Uses app.inject() for HTTP testing without real ports.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { assertSandboxedHome, createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { MAX_ROUTE_PARAM_LENGTH } from '../../src/web/route-helpers.js';

export interface RouteTestHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Creates a Fastify instance with a route module registered against a mock context.
 *
 * @param registerFn - The route registration function (e.g., registerSessionRoutes).
 *   Uses `any` for ctx parameter because route functions expect typed port intersections
 *   that MockRouteContext satisfies structurally but not nominally.
 * @param ctxOptions - Optional overrides for the mock context. `authUser` stands
 *   in for what the auth middleware would attach in multi-user mode; without it
 *   `getAuthUser()` falls back to a synthetic admin, which passes every
 *   ownership check and would make a scoping test pass vacuously.
 */
export async function createRouteTestHarness(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFn: (app: FastifyInstance, ctx: any) => void,
  ctxOptions?: { sessionId?: string; authUser?: { username: string; role: 'admin' | 'user' } }
): Promise<RouteTestHarness> {
  // Route tests write the linked-cases, docker and settings files. Refuse to build a harness against
  // a real home (a bare vitest has no setupFiles), instead of finding out from a wiped registry.
  assertSandboxedHome('A route test');

  const app = Fastify({ logger: false, routerOptions: { maxParamLength: MAX_ROUTE_PARAM_LENGTH } });

  // Register cookie plugin — some routes access req.cookies
  await app.register(fastifyCookie);

  if (ctxOptions?.authUser) {
    const authUser = ctxOptions.authUser;
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: typeof authUser }).authUser = authUser;
    });
  }

  const ctx = createMockRouteContext(ctxOptions);

  registerFn(app, ctx);
  // Mirror production: structured errors thrown by route helpers (findSessionOrFail,
  // parseBody) are rendered to {success:false} bodies at the right status.
  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}
