/**
 * @fileoverview Route tests for the `wait` field on `POST /api/sessions/:id/input`.
 *
 * This endpoint exists to close a race a caller cannot close from outside: between
 * the write landing and the session flipping to `working`, a SEPARATE wait sees the
 * session still idle and returns instantly, reporting the previous turn as this one.
 * Registering the waiter before the write is the whole point, so that is what the
 * first test pins.
 *
 * It also pins that the historical fire-and-forget path is untouched when `wait` is
 * absent, that a capacity rejection gives the dedup seq back (otherwise the caller's
 * retry is refused as a duplicate and the input is lost by the very mechanism
 * reliable delivery exists for), and that `delivered` reports what actually happened
 * to the write rather than merely "this was not a duplicate".
 *
 * Plan: docs/agent-control-plan.md
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { registerSessionRoutes, _resetPaneLivenessState } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { MAX_WAIT_MS } from '../../src/config/agent-wait.js';

// Distinct per file on purpose: the three wait suites share the process-wide
// `sessionWaits` singleton, so a common id let one file's leftover waiter be counted
// by another's assertion. Failed only in a 5-file run, which is how CI runs them.
const SESSION_ID = 'input-wait-session';
const URL = `/api/sessions/${SESSION_ID}/input`;

afterEach(() => {
  // Deliberately not `cancelEverything()`: it latches the registry's stopped flag,
  // which would leave every later test in this file talking to a dead registry.
  sessionWaits.cancelAll(SESSION_ID);
  _resetPaneLivenessState();
});

async function harness(): Promise<{ app: FastifyInstance; ctx: MockRouteContext; rawRequests: IncomingMessage[] }> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  const rawRequests: IncomingMessage[] = [];
  app.addHook('onRequest', async (req) => {
    rawRequests.push(req.raw);
  });

  registerSessionRoutes(app, ctx as never);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    const p = payload as { success?: unknown; errorCode?: unknown } | null;
    if (p && typeof p === 'object' && p.success === false && reply.statusCode === 200) {
      if (typeof p.errorCode === 'string') reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
    }
    return done(null, payload);
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx, rawRequests };
}

const send = (app: FastifyInstance, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: URL, payload });

describe('POST /api/sessions/:id/input without wait (unchanged behavior)', () => {
  it('returns the historical bare body and registers no waiter', async () => {
    const { app } = await harness();
    const res = await send(app, { input: 'hello', useMux: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(sessionWaits.totalWaiterCount()).toBe(0);
  });

  it('still returns before the mux write settles', async () => {
    // The fire-and-forget property is why the response is fast; send-and-wait must
    // not have turned every input into an awaited tmux round-trip.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    let resolveWrite: (ok: boolean) => void = () => {};
    session.writeViaMux = () => new Promise<boolean>((resolve) => (resolveWrite = resolve));

    const res = await send(app, { input: 'hello', useMux: true });
    expect(res.json()).toEqual({});
    resolveWrite(true);
  });

  it('a tagged duplicate still returns the bare body', async () => {
    const { app } = await harness();
    await send(app, { input: 'first', clientId: 'c1', seq: 1 });
    const replay = await send(app, { input: 'first', clientId: 'c1', seq: 1 });

    expect(replay.json()).toEqual({});
    expect(sessionWaits.totalWaiterCount()).toBe(0);
  });

  it('a failed direct write is still not an error response', async () => {
    // A session can legitimately have no PTY yet, and callers have always been able
    // to write to one without a 4xx. Only the `wait` path reports delivery.
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.failWrites = true;

    const res = await send(app, { input: 'x' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });
});

describe('POST /api/sessions/:id/input with wait', () => {
  it('registers the waiter BEFORE the write, so the pre-existing idle state cannot satisfy it', async () => {
    // The mock session is idle. A naive send-then-wait would answer immediately with
    // that stale idle; this must block until a real transition.
    const { app } = await harness();
    const pending = send(app, { input: 'run the tests', useMux: true, wait: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);

    sessionWaits.notifySignal(SESSION_ID, 'stop');
    const body = (await pending).json();
    expect(body.success).toBe(true);
    expect(body.data.delivered).toBe(true);
    expect(body.data.duplicate).toBe(false);
    expect(body.data.wait.signal).toBe('stop');
    expect(body.data.wait.immediate).toBe(false);
    expect(body.data.wait.timedOut).toBe(false);
  });

  it('uses the same data.wait envelope as the two GET endpoints', async () => {
    const { app } = await harness();
    const pending = send(app, { input: 'x', wait: 'stop' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifySignal(SESSION_ID, 'stop');
    const { data } = (await pending).json();

    expect(Object.keys(data).sort()).toEqual(['delivered', 'duplicate', 'limitPaused', 'status', 'wait']);
    expect(data.status).toBe('idle');
    expect(data.limitPaused).toBe(false);
    expect(data.wait.aborted).toBe(false);
  });

  it('echoes the effective timeout after clamping', async () => {
    // The schema accepts up to 24h; the server caps at MAX_WAIT_MS. Without the echo
    // an agent reads the cap as "my 24h wait elapsed" and kills a healthy worker.
    const { app } = await harness();
    const pending = send(app, { input: 'x', wait: 'stop', waitTimeout: 86_400_000 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifySignal(SESSION_ID, 'stop');

    expect((await pending).json().data.wait.timeoutMs).toBe(MAX_WAIT_MS);
  });

  it('delivers the input before blocking', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    const pending = send(app, { input: 'echo hi', useMux: true, wait: 'stop' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // The write happened while the request is still open.
    expect(session.writeBuffer.join('')).toContain('echo hi');

    sessionWaits.notifySignal(SESSION_ID, 'stop');
    await pending;
  });

  it('wait: true uses the default signal set', async () => {
    const { app } = await harness();
    const pending = send(app, { input: 'x', wait: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifySignal(SESSION_ID, 'idle');

    expect((await pending).json().data.wait.until).toEqual(['stop', 'idle', 'exit']);
  });

  it('accepts an explicit signal list', async () => {
    const { app } = await harness();
    const pending = send(app, { input: 'x', wait: 'exit' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // Not one of the requested signals: the wait must not resolve on it.
    expect(sessionWaits.notifySignal(SESSION_ID, 'idle')).toBe(0);
    sessionWaits.notifySignal(SESSION_ID, 'exit');

    const body = (await pending).json();
    expect(body.data.wait.signal).toBe('exit');
    expect(body.data.wait.until).toEqual(['exit']);
  });

  it('accepts an array, the same grammar the query parameter takes', async () => {
    const { app } = await harness();
    const pending = send(app, { input: 'x', wait: ['stop', 'exit'] });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifySignal(SESSION_ID, 'exit');

    const body = (await pending).json();
    expect(body.data.wait.until).toEqual(['stop', 'exit']);
    expect(body.data.wait.signal).toBe('exit');
  });

  it('rejects an unknown wait signal without writing', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    const before = session.writeBuffer.length;

    const res = await send(app, { input: 'x', wait: 'stpo' });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    expect(session.writeBuffer.length).toBe(before);
  });

  it('rejects a hook-only signal for external CLI modes', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'codex';

    const res = await send(app, { input: 'x', wait: 'stop' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('codex');
  });

  it('rejects a hook-only signal for a shell session too', async () => {
    // Not an external CLI, but a plain bash PTY installs no hooks either, so `stop`
    // could only ever time out.
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'shell';

    const res = await send(app, { input: 'x', wait: 'stop' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('shell');
  });

  it('times out as a 200, like the standalone wait', async () => {
    const { app } = await harness();
    const res = await send(app, { input: 'x', wait: 'blocked', waitTimeout: 1 });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.delivered).toBe(true);
    expect(body.data.wait.timedOut).toBe(true);
    expect(body.data.wait.signal).toBeNull();
  });

  it('resolves with ended when the session goes away mid-wait', async () => {
    const { app } = await harness();
    const pending = send(app, { input: 'x', wait: 'stop' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.cancelAll(SESSION_ID);

    expect((await pending).json().data.wait.ended).toBe(true);
  });

  it('a request-body close does NOT abort the wait', async () => {
    // The regression this pins: on a POST the request stream closes as soon as the
    // body has been read, well before the handler blocks. Treating that as a hang-up
    // aborted every send-and-wait instantly. Hang-up handling itself is proven over
    // real HTTP at the bottom of this file, because inject cannot produce a socket.
    const { app, rawRequests } = await harness();
    const pending = send(app, { input: 'x', wait: 'stop', waitTimeout: 600_000 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);

    rawRequests[rawRequests.length - 1].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);

    sessionWaits.notifySignal(SESSION_ID, 'stop');
    const body = (await pending).json();
    expect(body.data.wait.aborted).toBe(false);
    expect(body.data.wait.signal).toBe('stop');
  });

  it('a duplicate skips the write but answers from current state instead of hanging', async () => {
    // The original turn is long over, so requiring a fresh transition here would
    // block a redelivery until timeout for no reason.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    await send(app, { input: 'first', clientId: 'c1', seq: 1 });
    const before = session.writeBuffer.length;

    const replay = await send(app, { input: 'first', clientId: 'c1', seq: 1, wait: 'idle' });
    const body = replay.json();

    expect(body.data.duplicate).toBe(true);
    expect(body.data.delivered).toBe(false);
    expect(body.data.wait.immediate).toBe(true);
    expect(body.data.wait.signal).toBe('idle');
    expect(session.writeBuffer.length).toBe(before);
  });

  it('a duplicate on a BUSY session answers working, not idle', async () => {
    // Previously unreachable: MockSession's status was 'working', which is not a
    // SessionStatus, so signalForStatus fell through to null and this combination
    // silently proved nothing.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    await send(app, { input: 'first', clientId: 'c2', seq: 1 });
    session.status = 'busy';

    const replay = await send(app, { input: 'first', clientId: 'c2', seq: 1, wait: 'working' });
    const body = replay.json();

    expect(body.data.duplicate).toBe(true);
    expect(body.data.wait.signal).toBe('working');
    expect(body.data.wait.immediate).toBe(true);
    expect(body.data.status).toBe('busy');
  });

  it('gives the dedup seq back when a full waiter pool rejects the request', async () => {
    // Otherwise the caller's retry is refused as a duplicate and the input vanishes.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;

    const pendings = [];
    for (let i = 0; i < 16; i++) {
      pendings.push(app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sessionWaits.waiterCount(SESSION_ID)).toBe(16);

    const rejected = await send(app, { input: 'x', clientId: 'c9', seq: 7, wait: true });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().errorCode).toBe('SESSION_BUSY');
    // Nothing written...
    expect(session.writeBuffer.join('')).not.toContain('x');

    sessionWaits.cancelAll(SESSION_ID);
    await Promise.all(pendings);

    // ...and the same seq is accepted on retry rather than treated as a replay.
    const retry = await send(app, { input: 'x', clientId: 'c9', seq: 7 });
    expect(retry.json()).toEqual({});
    expect(session.writeBuffer.join('')).toContain('x');
  });

  it('a null wait is treated as absent, not as a validation error', async () => {
    // Zod .optional() rejects null, and a third-party caller building the body with
    // JSON.stringify keeps an explicit null on the wire.
    const { app } = await harness();
    const res = await send(app, { input: 'x', wait: null, waitTimeout: null });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it('wait: false is treated as absent', async () => {
    const { app } = await harness();
    const res = await send(app, { input: 'x', wait: false });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(sessionWaits.totalWaiterCount()).toBe(0);
  });

  it('falls back to a direct write when the mux write fails, and still waits', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    session.writeViaMux = async () => false;

    const pending = send(app, { input: 'fallback me', useMux: true, wait: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.writeBuffer.join('')).toContain('fallback me');

    sessionWaits.notifySignal(SESSION_ID, 'stop');
    const body = (await pending).json();
    expect(body.data.wait.signal).toBe('stop');
    // The fallback write succeeded, so the input really was delivered.
    expect(body.data.delivered).toBe(true);
  });
});

describe('POST /api/sessions/:id/input: delivered reports the write, not just the dedup', () => {
  it('reports delivered:false when BOTH write paths fail, instead of claiming delivery', async () => {
    // A worker whose PTY has exited fails writeViaMux AND write. Reporting
    // "delivered, but it timed out" points the agent at waiting longer; the truth is
    // "restart the worker".
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    session.failWrites = true;

    const res = await send(app, { input: 'run the tests', useMux: true, wait: 'stop', waitTimeout: 600_000 });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.data.delivered).toBe(false);
    expect(body.data.duplicate).toBe(false);
  });

  it('does not block for the full timeout on an input it knows never landed', async () => {
    // The waiter has to be registered before the write, so it exists by the time the
    // failure is known; releasing it immediately is what keeps the caller from
    // waiting ten minutes for a turn that cannot start.
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.failWrites = true;

    const started = Date.now();
    const body = (await send(app, { input: 'x', useMux: true, wait: 'stop', waitTimeout: 600_000 })).json();

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(body.data.delivered).toBe(false);
    expect(body.data.wait.timedOut).toBe(false);
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(0);
  });

  it('reports delivered:false for a failed direct (non-mux) write too', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.failWrites = true;

    const body = (await send(app, { input: 'x', wait: 'stop', waitTimeout: 600_000 })).json();
    expect(body.data.delivered).toBe(false);
  });

  it('rolls the dedup seq back when the write failed, so a retry is not a duplicate', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    session.failWrites = true;

    const first = (await send(app, { input: 'x', clientId: 'c3', seq: 4, wait: 'stop', waitTimeout: 600_000 })).json();
    expect(first.data.delivered).toBe(false);

    session.failWrites = false;
    const retry = (await send(app, { input: 'x', clientId: 'c3', seq: 4, wait: 'stop', waitTimeout: 1 })).json();
    expect(retry.data.duplicate).toBe(false);
    expect(retry.data.delivered).toBe(true);
    expect(session.writeBuffer.join('')).toContain('x');
  });
});

/**
 * Client-hang-up handling, over REAL HTTP.
 *
 * `app.inject()` never emits a `close` event at all, so the entire abort path is
 * invisible to every other test in this file — and the failure it hides is not
 * subtle. On a POST, `req.raw` emits `'close'` as soon as the request BODY finishes
 * streaming, which happens before the handler blocks (+1ms, `aborted: false`) and is
 * indistinguishable from a real hang-up at +0ms. A request-side abort listener
 * therefore cancels every send-and-wait instantly: `POST .../input {wait:"exit",
 * waitTimeout:10000}` came back in 23ms with `ended:true, aborted:true, waitedMs:6`,
 * i.e. the feature was dead while all 27 inject-based tests above stayed green.
 *
 * GET survives a request-side listener because it has no body to finish, which is
 * exactly why this regression needs a POST and a real socket to catch.
 */
describe('POST /api/sessions/:id/input over real HTTP: hang-up handling', () => {
  let base: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    app = (await harness()).app;
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    // fetch keeps its sockets alive, and `app.close()` waits for idle connections,
    // so without this the teardown hook times out.
    app.server.closeAllConnections();
    await app.close();
  });

  it('a send-and-wait that is NOT aborted blocks for its full timeout', async () => {
    // The regression: this returned in ~20ms with aborted:true.
    const started = Date.now();
    const res = await fetch(`${base}/api/sessions/${SESSION_ID}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'run the tests', wait: 'exit', waitTimeout: 2000 }),
    });
    const elapsed = Date.now() - started;
    const body = await res.json();

    expect(body.data.wait.aborted).toBe(false);
    expect(body.data.wait.timedOut).toBe(true);
    expect(body.data.wait.waitedMs).toBeGreaterThan(1500);
    expect(elapsed).toBeGreaterThan(1500);
    expect(body.data.delivered).toBe(true);
  });

  it('a send-and-wait aborted mid-flight frees its waiter', async () => {
    const controller = new AbortController();
    const pending = fetch(`${base}/api/sessions/${SESSION_ID}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'x', wait: 'exit', waitTimeout: 600_000 }),
      signal: controller.signal,
    }).catch(() => 'aborted');

    await new Promise((resolve) => setTimeout(resolve, 150));
    // Still parked: the body finished streaming long ago, and that must not count.
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);

    controller.abort();
    expect(await pending).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(0);
  });

  it('a GET wait behaves the same way on both counts', async () => {
    const notAborted = await fetch(`${base}/api/sessions/${SESSION_ID}/wait?until=stop&timeout=1500`);
    const body = await notAborted.json();
    expect(body.data.wait.aborted).toBe(false);
    expect(body.data.wait.timedOut).toBe(true);

    const controller = new AbortController();
    const pending = fetch(`${base}/api/sessions/${SESSION_ID}/wait?until=stop&timeout=600000`, {
      signal: controller.signal,
    }).catch(() => 'aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);

    controller.abort();
    expect(await pending).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(0);
  });

  it('wait-output frees its waiter on hang-up too', async () => {
    const controller = new AbortController();
    const pending = fetch(`${base}/api/sessions/${SESSION_ID}/wait-output?match=NEVER&timeout=600000`, {
      signal: controller.signal,
    }).catch(() => 'aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionWaits.outputWaiterCount(SESSION_ID)).toBe(1);

    controller.abort();
    expect(await pending).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionWaits.outputWaiterCount(SESSION_ID)).toBe(0);
  });
});

/**
 * Send-and-wait against a tmux worker that has already died.
 *
 * `tmux send-keys` SUCCEEDS against a dead pane, so `writeViaMux` returns true and the
 * old `delivered` was true for bytes written into a corpse — with `timedOut: true`
 * alongside it, which tells an agent to wait longer when the truth is "restart the
 * worker". Live: `pane_dead=1 status=42`, Codeman `pid=309406 status=idle`,
 * `delivered: true`.
 */
describe('POST /api/sessions/:id/input: the pane is dead', () => {
  function setPaneDead(ctx: MockRouteContext, dead: boolean) {
    (ctx.mux as unknown as { isPaneDead: (n: string) => boolean }).isPaneDead = () => dead;
  }

  it('reports delivered:false even though the mux write "succeeded"', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    setPaneDead(ctx, true);

    const res = await send(app, { input: 'run the tests', useMux: true, wait: 'stop', waitTimeout: 600_000 });
    const body = res.json();

    // The write itself did not fail — that is the whole trap.
    expect(session.writeBuffer.join('')).toContain('run the tests');
    expect(body.data.delivered).toBe(false);
    expect(body.data.duplicate).toBe(false);
  });

  it('returns at once instead of blocking on a turn that cannot start', async () => {
    const { app, ctx } = await harness();
    setPaneDead(ctx, true);

    const started = Date.now();
    const body = (await send(app, { input: 'x', useMux: true, wait: 'stop', waitTimeout: 600_000 })).json();

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(body.data.wait.timedOut).toBe(false);
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(0);
  });

  it('rolls the dedup seq back, so a retry against a restarted worker is not a duplicate', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    setPaneDead(ctx, true);

    const dead = (await send(app, { input: 'x', useMux: true, clientId: 'c7', seq: 3, wait: 'stop' })).json();
    expect(dead.data.delivered).toBe(false);

    // Worker restarted.
    setPaneDead(ctx, false);
    _resetPaneLivenessState();
    const retry = (
      await send(app, { input: 'x', useMux: true, clientId: 'c7', seq: 3, wait: 'stop', waitTimeout: 1 })
    ).json();
    expect(retry.data.duplicate).toBe(false);
    expect(retry.data.delivered).toBe(true);
    expect(session.writeBuffer.join('')).toContain('x');
  });

  it('a live pane still reports delivered:true', async () => {
    const { app, ctx } = await harness();
    setPaneDead(ctx, false);

    const pending = send(app, { input: 'x', useMux: true, wait: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifySignal(SESSION_ID, 'stop');

    expect((await pending).json().data.delivered).toBe(true);
  });

  it('never probes tmux on the plain (non-wait) input path', async () => {
    // The browser sends thousands of these per session; they must not exec tmux.
    const { app, ctx } = await harness();
    const probe = vi.fn(() => false);
    (ctx.mux as unknown as { isPaneDead: (n: string) => boolean }).isPaneDead = probe as never;

    await send(app, { input: 'hello', useMux: true });
    await send(app, { input: 'hello again', useMux: true, clientId: 'c1', seq: 1 });

    expect(probe).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/input: `aborted` stays a client-side fact', () => {
  it('reports aborted:false when the SERVER released the waiter after a failed delivery', async () => {
    // api-reference guarantees a client never sees `aborted: true`, because it means
    // "you hung up, nobody is reading this". The release below is the server giving up
    // on a write that failed — and the client IS reading the response, so reporting
    // `aborted: true` would both break that guarantee and hand an agent a second,
    // contradictory reason for an outcome `delivered: false` already explains.
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.failWrites = true;

    const body = (await send(app, { input: 'x', useMux: true, wait: 'stop', waitTimeout: 600_000 })).json();

    expect(body.data.delivered).toBe(false);
    expect(body.data.wait.aborted).toBe(false);
    expect(body.data.wait.ended).toBe(true);
    expect(body.data.wait.timedOut).toBe(false);
  });

  it('the same holds for a dead pane', async () => {
    const { app, ctx } = await harness();
    (ctx.mux as unknown as { isPaneDead: () => boolean }).isPaneDead = () => true;

    const body = (await send(app, { input: 'x', useMux: true, wait: 'stop', waitTimeout: 600_000 })).json();
    expect(body.data.wait.aborted).toBe(false);
  });
});

describe('POST /api/sessions/:id/input: an oversized waitTimeout clamps', () => {
  it('accepts a value above the old schema ceiling and reports the clamp', async () => {
    const { app } = await harness();
    const pending = send(app, { input: 'x', wait: 'stop', waitTimeout: 99_999_999_999 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifySignal(SESSION_ID, 'stop');

    const body = (await pending).json();
    expect(body.data.wait.timeoutMs).toBe(MAX_WAIT_MS);
  });

  it('still rejects a non-integer or negative waitTimeout', async () => {
    const { app } = await harness();
    for (const value of [-1, 0, 1.5]) {
      const res = await send(app, { input: 'x', wait: 'stop', waitTimeout: value });
      expect(res.statusCode, `waitTimeout=${value}`).toBe(400);
    }
  });
});
