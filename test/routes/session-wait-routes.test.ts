/**
 * @fileoverview Route tests for `GET /api/sessions/:id/wait`.
 *
 * The contract this pins is the one an orchestrating agent depends on:
 * - a timeout is a 200 with `wait.timedOut: true`, never a 4xx, because callers loop
 *   over short waits and every poll boundary would otherwise look like a failure;
 * - the result is nested under `data.wait` on ALL THREE wait endpoints, so a single
 *   client helper reads any of them;
 * - the EFFECTIVE timeout is echoed, so a caller that asked for 30 minutes and was
 *   clamped to 10 can tell a poll boundary from a wedged worker;
 * - an unknown `until` token is a 400 rather than a silent fallback to the default,
 *   so a typo can never leave an agent believing it is waiting for something else,
 *   and a schema 400 names the parameter it rejected;
 * - `stop`/`blocked` are rejected for modes that install no hooks when asked for
 *   EXPLICITLY, but silently dropped from the DEFAULT set, so omitting `until` never
 *   400s — and `shell` counts as such a mode, even though it is not an external CLI;
 * - a client that hangs up frees its waiter immediately, or a loop of
 *   `curl --max-time` calls wedges a process-wide cap nobody else can use;
 * - a session with no PTY answers `exit`, never `idle`.
 *
 * Plan: docs/agent-control-plan.md
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import {
  registerSessionRoutes,
  _resetPaneLivenessState,
  _paneDeathWatcherCount,
} from '../../src/web/routes/session-routes.js';
import { createSessionListeners, attachSessionListeners } from '../../src/web/session-listener-wiring.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { approvalInbox } from '../../src/web/approval-inbox.js';
import { MAX_WAIT_MS, MIN_WAIT_MS, MAX_WAITERS_TOTAL, MAX_WAITERS_PER_OWNER } from '../../src/config/agent-wait.js';

// Distinct per file on purpose: the three wait suites share the process-wide
// `sessionWaits` singleton, so a common id let one file's leftover waiter be counted
// by another's assertion. Failed only in a 5-file run, which is how CI runs them.
const SESSION_ID = 'wait-routes-session';

/** Session ids a test parked filler waiters on, so cleanup can release them. */
const fillerIds = new Set<string>();

/** Park a waiter directly on the shared registry (cap tests), tracked for cleanup. */
function fillWaiter(id: string, owner?: string): Promise<unknown> {
  fillerIds.add(id);
  return sessionWaits.waitForSignal(id, { until: ['stop'], timeoutMs: 30_000, owner });
}

afterEach(() => {
  // The routes use the process-wide registry; never leak a waiter into the next test.
  // Deliberately NOT `cancelEverything()`: it latches the registry's stopped flag
  // (one-way by design, so a request landing mid-shutdown cannot register a waiter
  // nothing will ever cancel), which would leave every later test in this file
  // talking to a dead registry and passing vacuously.
  for (const id of [SESSION_ID, ...fillerIds]) sessionWaits.cancelAll(id);
  fillerIds.clear();
  // Pane-liveness state is module-level (one cache, one watcher per pane), so it has
  // to be reset or a cached probe leaks into the next test.
  _resetPaneLivenessState();
  delete process.env.CODEMAN_MULTIUSER;
});

/**
 * The shared route harness returns handler payloads verbatim, so a `{success:false}`
 * body would still be HTTP 200. Production maps errorCode to status in server.ts, so
 * mirror that here or every negative case passes vacuously.
 *
 * `rawReplies` collects each request's `reply.raw` — the RESPONSE, which is what the
 * handler's hang-up detection listens on, and deliberately not `req.raw` (on a POST
 * that one closes as soon as the body has been read, so wiring an abort to it kills
 * every send-and-wait; see the real-HTTP suite in session-input-wait.test.ts).
 * Emitting the event by hand is the only way to simulate a hang-up here at all:
 * `app.inject()` never emits `close` on its own, verified.
 */
async function harness(options?: { authUser?: { username: string; role: 'admin' | 'user' } }): Promise<{
  app: FastifyInstance;
  ctx: MockRouteContext;
  rawReplies: ServerResponse[];
}> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  const rawReplies: ServerResponse[] = [];

  const authUser = options?.authUser;
  app.addHook('onRequest', async (req, reply) => {
    // The RESPONSE, because that is what the handler's hang-up detection listens to.
    rawReplies.push(reply.raw);
    if (authUser) (req as unknown as { authUser: typeof authUser }).authUser = authUser;
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
  return { app, ctx, rawReplies };
}

describe('GET /api/sessions/:id/wait', () => {
  it('resolves immediately when the session is already in a requested state', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.wait.signal).toBe('idle');
    expect(body.data.wait.immediate).toBe(true);
    expect(body.data.wait.timedOut).toBe(false);
    expect(body.data.wait.aborted).toBe(false);
    expect(body.data.sessionId).toBe(SESSION_ID);
    expect(body.data.wait.until).toEqual(['idle']);
  });

  it('nests the result under data.wait, so one client helper reads all three endpoints', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });

    const { data } = res.json();
    // Session-level facts stay at the top; everything about the wait is inside it.
    expect(Object.keys(data).sort()).toEqual(['limitPaused', 'sessionId', 'status', 'wait']);
    expect(data.signal).toBeUndefined();
  });

  it('reports the post-wait status and the limit-pause hint', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });

    const body = res.json();
    expect(body.data.status).toBe('idle');
    expect(body.data.limitPaused).toBe(false);
  });

  it('sends Cache-Control: no-store, so a polled long-poll cannot be served from a cache', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('defaults to stop,idle,exit when until is omitted', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait` });

    const body = res.json();
    expect(body.data.wait.until).toEqual(['stop', 'idle', 'exit']);
    // The mock session is idle, so the default set resolves right away.
    expect(body.data.wait.signal).toBe('idle');
  });

  it('rejects an unknown until token instead of falling back to the default', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stpo` });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INVALID_INPUT');
    expect(body.error).toContain('stpo');
  });

  it('rejects a non-numeric timeout', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?timeout=soon` });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
  });

  it('names the parameter it rejected, instead of a bare "invalid parameters"', async () => {
    // An agent driving this with no docs in context can only recover if the error
    // says WHICH parameter was wrong; the old message named none of them.
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?timeout=30s` });

    const body = res.json();
    expect(body.error).toContain('timeout');
    expect(body.error).toContain('wait');
  });

  it('404s an unknown session', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope/wait?until=idle' });

    expect(res.statusCode).toBe(404);
    expect(res.json().success).toBe(false);
  });

  it('resolves an in-flight wait when the signal arrives', async () => {
    const { app } = await harness();
    // `stop` is not the session's current signal, so this blocks.
    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);
    sessionWaits.notifySignal(SESSION_ID, 'stop');

    const body = (await pending).json();
    expect(body.data.wait.signal).toBe('stop');
    expect(body.data.wait.immediate).toBe(false);
    expect(body.data.wait.timedOut).toBe(false);
    expect(body.data.wait.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('fresh=1 waits for the next transition instead of answering from current state', async () => {
    const { app } = await harness();
    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle&fresh=1` });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);
    sessionWaits.notifySignal(SESSION_ID, 'idle');

    const body = (await pending).json();
    expect(body.data.wait.signal).toBe('idle');
    expect(body.data.wait.immediate).toBe(false);
  });

  it('resolves with ended when the session goes away mid-wait', async () => {
    const { app } = await harness();
    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.cancelAll(SESSION_ID);

    const body = (await pending).json();
    expect(body.success).toBe(true);
    expect(body.data.wait.ended).toBe(true);
    expect(body.data.wait.signal).toBeNull();
    expect(body.data.wait.timedOut).toBe(false);
  });

  it('answers 200 with timedOut on timeout, never an error status', async () => {
    const { app } = await harness();
    // Clamped up to the 1s floor, so this is the one deliberately slow case.
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop&timeout=1` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.wait.timedOut).toBe(true);
    expect(body.data.wait.signal).toBeNull();
    expect(body.data.wait.ended).toBe(false);
  });
});

describe('GET /api/sessions/:id/wait: the effective timeout is observable', () => {
  it('echoes the clamped-down value when the caller asks for more than the ceiling', async () => {
    // Asked for 30 minutes, got MAX_WAIT_MS. Without the echo the caller reads a
    // 10-minute timeout as "30 minutes elapsed with no stop" and kills a healthy worker.
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle&timeout=1800000` });

    expect(res.json().data.wait.timeoutMs).toBe(MAX_WAIT_MS);
  });

  it('echoes the clamped-up value at the floor too', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle&timeout=1` });

    expect(res.json().data.wait.timeoutMs).toBe(MIN_WAIT_MS);
  });

  it('reports the applied default when timeout is omitted', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });

    expect(res.json().data.wait.timeoutMs).toBeGreaterThanOrEqual(MIN_WAIT_MS);
    expect(res.json().data.wait.timeoutMs).toBeLessThanOrEqual(MAX_WAIT_MS);
  });
});

describe('GET /api/sessions/:id/wait: repeated query parameters', () => {
  it('accepts ?until=stop&until=exit, the way most clients express a list', async () => {
    // Fastify delivers a repeated parameter as an array and parseWaitSignals has
    // always handled one; only the schema was rejecting it.
    const { app } = await harness();
    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop&until=exit` });

    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionWaits.notifySignal(SESSION_ID, 'exit');

    const body = (await pending).json();
    expect(body.data.wait.until).toEqual(['stop', 'exit']);
    expect(body.data.wait.signal).toBe('exit');
  });

  it('still reports an unknown token inside a repeated parameter', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop&until=stpo` });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('stpo');
  });
});

describe('GET /api/sessions/:id/wait: a client that hangs up frees its waiter', () => {
  it('removes the waiter when the RESPONSE socket closes early', async () => {
    // `curl --max-time 30 ".../wait?timeout=600000"` abandons a live waiter every
    // iteration of the documented loop; sixteen of those and an innocent session
    // reports busy.
    //
    // The response body is unreadable afterwards (the injected response really is
    // destroyed, exactly as a hung-up socket would be), so the freed slot is all this
    // can assert. The full behaviour, including `aborted: true` on the wire for the
    // caller that did NOT hang up, is pinned over real HTTP in session-input-wait.test.ts.
    const { app, rawReplies } = await harness();
    const pending = app
      .inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop&timeout=600000` })
      .then(
        () => 'completed',
        () => 'destroyed'
      );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);

    rawReplies[rawReplies.length - 1].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(0);
    expect(await pending).toBe('destroyed');
  });

  it('a close AFTER the wait resolved changes nothing', async () => {
    const { app, rawReplies } = await harness();
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });

    expect(res.json().data.wait.aborted).toBe(false);
    // Node fires `close` on every completed response too, not only on a hang-up;
    // `writableFinished` is what separates them.
    rawReplies[rawReplies.length - 1].emit('close');
    expect(sessionWaits.totalWaiterCount()).toBe(0);
  });
});

describe('GET /api/sessions/:id/wait: capacity errors name the cap that was hit', () => {
  it('maps the per-session cap to SESSION_BUSY / 409', async () => {
    const { app } = await harness();
    const pendings = [];
    for (let i = 0; i < 16; i++) {
      pendings.push(app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(16);

    const overflow = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().errorCode).toBe('SESSION_BUSY');
    expect(overflow.json().error).toContain('session');

    sessionWaits.cancelAll(SESSION_ID);
    await Promise.all(pendings);
  });

  it('maps the process-wide cap to RATE_LIMITED / 429, because this session is not the problem', async () => {
    // Reported as SESSION_BUSY, an agent concludes the session it asked about is
    // busy, switches to another, and gets the identical error.
    const { app } = await harness();
    const others: Promise<unknown>[] = [];
    for (let i = 0; i < MAX_WAITERS_TOTAL; i++) others.push(fillWaiter(`unrelated-${i}`));
    expect(sessionWaits.totalWaiterCount()).toBe(MAX_WAITERS_TOTAL);

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` });
    expect(res.statusCode).toBe(429);
    expect(res.json().errorCode).toBe('RATE_LIMITED');
    expect(res.json().error).toContain('total');

    for (const id of fillerIds) sessionWaits.cancelAll(id);
    await Promise.all(others);
  });

  it('maps the per-owner cap to RATE_LIMITED / 429 and charges the request to its user', async () => {
    // Also proves the route passes ownerFor(req): without it the owner cap can never
    // trip, and one user could hold the whole process-wide pool.
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await harness({ authUser: { username: 'alice', role: 'admin' } });

    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.ownerWaiterCount('alice')).toBe(1);

    const others: Promise<unknown>[] = [];
    while (sessionWaits.ownerWaiterCount('alice') < MAX_WAITERS_PER_OWNER) {
      others.push(fillWaiter(`alice-${others.length}`, 'alice'));
    }

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain('owner');

    sessionWaits.cancelAll(SESSION_ID);
    for (const id of fillerIds) sessionWaits.cancelAll(id);
    await Promise.all([pending, ...others]);
  });
});

describe('GET /api/sessions/:id/wait: modes that install no hooks', () => {
  it('rejects an explicit stop, which no external CLI ever emits', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'codex';

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('codex');
  });

  it('rejects an explicit blocked too', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'opencode';

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=blocked` });
    expect(res.statusCode).toBe(400);
  });

  it('rejects stop for a SHELL session, which is not an external CLI but installs no hooks either', async () => {
    // A plain bash PTY never POSTs a Stop hook, so this was a guaranteed ten-minute
    // hang dressed up as a timeout — the exact failure the guard exists to prevent.
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'shell';

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('shell');
  });

  it('silently drops hook-only signals from the DEFAULT set instead of 400ing', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'gemini';

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.wait.until).toEqual(['idle', 'exit']);
  });

  it('drops them from the default set for shell too', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'shell';

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.wait.until).toEqual(['idle', 'exit']);
  });

  it('still accepts idle and exit explicitly', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'antigravity';

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle,exit` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.wait.until).toEqual(['idle', 'exit']);
  });
});

describe('GET /api/sessions/:id/wait: blocked read off a codex screen', () => {
  /** The listener deps the screen-blocked raise reaches; nothing else matters here. */
  function stubDeps() {
    return {
      broadcast: vi.fn(),
      broadcastSessionStateDebounced: vi.fn(),
      sendPushNotifications: vi.fn(),
      getRunSummaryTracker: vi.fn(() => undefined),
    };
  }

  afterEach(() => {
    approvalInbox.resolveForSession(SESSION_ID, 'session_ended');
  });

  it('accepts until=blocked for codex, whose dialogs are read off its screen', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'codex';
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=blocked&timeout=1000` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.wait.until).toEqual(['blocked']);
  });

  it('answers blocked at once for a dialog already on screen, and only to a caller who asked', async () => {
    // A hook-raised blocked is an edge; this one is a level the server is still reading,
    // so a caller who asks after the dialog appeared does not wait out its timeout.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)! as unknown as {
      mode: string;
      status: string;
      screenBlocked?: boolean;
    };
    session.mode = 'codex';
    session.status = 'idle';
    session.screenBlocked = true;

    const asked = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle,blocked` });
    expect(asked.json().data.wait).toMatchObject({ signal: 'blocked', immediate: true });

    // Such a pane is idle too, and a caller that asked for idle alone keeps getting idle.
    const idle = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });
    expect(idle.json().data.wait).toMatchObject({ signal: 'idle', immediate: true });
  });

  it('wakes a parked until=blocked waiter when the session raises a screen-read dialog', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    session.mode = 'codex';
    attachSessionListeners(session as never, createSessionListeners(session as never, stubDeps() as never));

    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=blocked&timeout=600000` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);

    session.emit('blockedChanged', true, '› 1. Yes, proceed (y)\n  Press enter to confirm or esc to cancel');

    const body = (await pending).json();
    expect(body.data.wait).toMatchObject({ signal: 'blocked', immediate: false, timedOut: false });
    expect(approvalInbox.getForSession(SESSION_ID)?.answerInTerminal).toBe(true);

    // ...and the dialog leaving the screen resolves the item it opened.
    session.emit('blockedChanged', false, null);
    expect(approvalInbox.getForSession(SESSION_ID)).toBeUndefined();
  });

  it('still refuses until=stop for codex: nothing on a screen says a turn ended', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.mode = 'codex';
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop,blocked` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Signal(s) stop never fire for codex');
  });
});

describe('GET /api/sessions/:id/wait: liveness beats the reported status', () => {
  it('answers exit for a session whose PTY is gone, not the idle its status claims', async () => {
    // Session parks a dead PTY at status 'idle' and the object survives in the map,
    // so the DEFAULT wait used to answer {signal:"idle", immediate:true} for a
    // crashed worker — 200, success, no error, and the agent prompts a corpse.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    session.pid = null;
    session.status = 'idle';

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait` });
    const body = res.json();
    expect(body.data.wait.signal).toBe('exit');
    expect(body.data.wait.immediate).toBe(true);
    // The raw status is still reported, so nothing is hidden from the caller.
    expect(body.data.status).toBe('idle');
  });

  it('resolves until=exit immediately for an already-exited session instead of blocking', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.pid = null;

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=exit&timeout=1` });
    expect(res.json().data.wait.signal).toBe('exit');
    expect(res.json().data.wait.timedOut).toBe(false);
  });

  it('does not report idle for a dead session even when idle was asked for explicitly', async () => {
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.pid = null;

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle&timeout=1` });
    expect(res.json().data.wait.signal).toBeNull();
    expect(res.json().data.wait.timedOut).toBe(true);
  });

  it('a live busy session resolves until=working immediately', async () => {
    // Unreachable before: MockSession used 'working', which is not a SessionStatus,
    // so signalForStatus fell through to null and this branch had no coverage.
    const { app, ctx } = await harness();
    ctx.sessions.get(SESSION_ID)!.status = 'busy';

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=working` });
    expect(res.json().data.wait.signal).toBe('working');
    expect(res.json().data.wait.immediate).toBe(true);
  });

  it('a live stopped/error session maps to exit', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;

    session.status = 'stopped';
    const stopped = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=exit` });
    expect(stopped.json().data.wait.signal).toBe('exit');

    session.status = 'error';
    const errored = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=exit` });
    expect(errored.json().data.wait.signal).toBe('exit');
  });
});

/**
 * The other half of the wait contract, exercised through the real listener wiring
 * rather than a route: a PTY that dies must RELEASE every waiter, not only the ones
 * that asked for `exit`.
 *
 * It lives in this file because it pins the same promise the routes above make
 * ("never hang"), and because the failure is only visible from the caller's side:
 * the exit handler detaches the `terminal`, `idle` and `working` listeners moments
 * later, so anything still registered afterwards is waiting on feeds that no longer
 * exist and can only time out.
 */
describe('a PTY exit releases waiters that did not ask for exit', () => {
  /** Everything the exit handler touches; the wait release must not depend on any of it. */
  function stubDeps(overrides: Record<string, unknown> = {}) {
    return {
      broadcast: vi.fn(),
      batchTerminalData: vi.fn(),
      batchTaskUpdate: vi.fn(),
      broadcastSessionStateDebounced: vi.fn(),
      sendPushNotifications: vi.fn(),
      persistSessionState: vi.fn(),
      getSessionStateWithRespawn: vi.fn(() => ({})),
      getRunSummaryTracker: vi.fn(() => undefined),
      stopTranscriptWatcher: vi.fn(),
      cleanupSessionBatches: vi.fn(),
      cancelPersistDebounce: vi.fn(),
      removeRunSummaryTracker: vi.fn(),
      removeSessionListenerRefs: vi.fn(),
      cleanupRespawnOnExit: vi.fn(),
      getStore: vi.fn(() => ({ updateRalphState: vi.fn() })),
      registerAttachment: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('answers an until=working waiter with ended instead of leaving it to time out', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    attachSessionListeners(session as never, createSessionListeners(session as never, stubDeps() as never));

    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=working&timeout=600000` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);

    session.emit('exit', 1);

    const body = (await pending).json();
    expect(body.data.wait.ended).toBe(true);
    expect(body.data.wait.timedOut).toBe(false);
    expect(body.data.wait.signal).toBeNull();
  });

  it('still gives an until=exit waiter its signal, not a bare ended', async () => {
    // Ordering matters: notifySignal('exit') must run BEFORE cancelAll, or a caller
    // that asked the right question gets the generic answer.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    attachSessionListeners(session as never, createSessionListeners(session as never, stubDeps() as never));

    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=exit&fresh=1` });
    await new Promise((resolve) => setTimeout(resolve, 20));

    session.emit('exit', 0);

    const body = (await pending).json();
    expect(body.data.wait.signal).toBe('exit');
    expect(body.data.wait.ended).toBe(false);
  });

  it('releases output waiters too, whose only feed the exit handler is about to detach', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    attachSessionListeners(session as never, createSessionListeners(session as never, stubDeps() as never));

    const pending = app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION_ID}/wait-output?match=DONE&timeout=600000`,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionWaits.outputWaiterCount(SESSION_ID)).toBe(1);

    session.emit('exit', 1);

    const body = (await pending).json();
    expect(body.data.wait.ended).toBe(true);
    expect(body.data.wait.matched).toBe(false);
    expect(sessionWaits.waiterCount(SESSION_ID)).toBe(0);
  });

  it('releases them even when a later step of the exit handler throws', async () => {
    // Which is why the release is the first thing in the handler.
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    const deps = stubDeps({
      broadcast: vi.fn(() => {
        throw new Error('SSE is down');
      }),
    });
    attachSessionListeners(session as never, createSessionListeners(session as never, deps as never));

    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop&timeout=600000` });
    await new Promise((resolve) => setTimeout(resolve, 20));

    session.emit('exit', 1);

    expect((await pending).json().data.wait.ended).toBe(true);
  });
});

/**
 * Worker liveness for a tmux-backed session.
 *
 * `session.pid` is the local `tmux attach` CLIENT, not the worker. Codeman sets
 * `remain-on-exit on`, so when the command inside the pane exits tmux keeps the pane
 * (`pane_dead=1`), the tmux session survives, the attach client keeps running, `pid`
 * never goes null and NO exit event fires. Reproduced live on a shell worker killed
 * with `exit 42`: tmux said `pane_dead=1 status=42` while Codeman said
 * `pid=309406 status=idle` and the default wait answered
 * `{signal:"idle", immediate:true, waitedMs:0}` for a corpse.
 *
 * These cases could not exist before, because `MockSession.pid` is set by hand: the
 * `pid === null` branch is the one production never reaches.
 */
describe('GET /api/sessions/:id/wait: a dead tmux worker', () => {
  /** Mock ctx doubles carry no `isPaneDead`; the route treats that as "cannot tell". */
  function setPaneDead(ctx: MockRouteContext, dead: boolean): ReturnType<typeof vi.fn> {
    const probe = vi.fn(() => dead);
    (ctx.mux as unknown as { isPaneDead: (name: string) => boolean }).isPaneDead = probe as never;
    return probe;
  }

  it('answers exit, not the idle the session still reports', async () => {
    const { app, ctx } = await harness();
    const session = ctx.sessions.get(SESSION_ID)!;
    setPaneDead(ctx, true);
    // Exactly the live state: attach client alive, status idle, worker gone.
    expect(session.pid).not.toBeNull();
    expect(session.status).toBe('idle');

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait` });
    const body = res.json();
    expect(body.data.wait.signal).toBe('exit');
    expect(body.data.wait.immediate).toBe(true);
    // The raw status is still reported, so nothing is hidden from the caller.
    expect(body.data.status).toBe('idle');
  });

  it('resolves until=exit immediately instead of burning the whole timeout', async () => {
    const { app, ctx } = await harness();
    setPaneDead(ctx, true);

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=exit&timeout=1` });
    expect(res.json().data.wait.signal).toBe('exit');
    expect(res.json().data.wait.timedOut).toBe(false);
  });

  it('does not answer idle for a dead worker even when idle was asked for explicitly', async () => {
    const { app, ctx } = await harness();
    setPaneDead(ctx, true);

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle&timeout=1` });
    expect(res.json().data.wait.signal).toBeNull();
    expect(res.json().data.wait.timedOut).toBe(true);
  });

  it('a live pane is unaffected', async () => {
    const { app, ctx } = await harness();
    setPaneDead(ctx, false);

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });
    expect(res.json().data.wait.signal).toBe('idle');
  });

  it('caches the probe, so a poll loop cannot exec tmux once per request', async () => {
    const { app, ctx } = await harness();
    const probe = setPaneDead(ctx, false);

    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });
    }
    expect(probe.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('never probes a session that is not tmux-backed', async () => {
    const { app, ctx } = await harness();
    const probe = setPaneDead(ctx, true);
    ctx.sessions.get(SESSION_ID)!.usesMux = false;

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=idle` });
    expect(probe).not.toHaveBeenCalled();
    // Falls back to the pid rule, which is the right one for a direct PTY.
    expect(res.json().data.wait.signal).toBe('idle');
  });

  it('releases a wait when the worker dies WHILE it is parked', async () => {
    // The common orchestration case, and the one a request-time probe cannot see: no
    // exit event, no output, nothing — the caller would block for its full timeout.
    const { app, ctx } = await harness();
    let dead = false;
    (ctx.mux as unknown as { isPaneDead: () => boolean }).isPaneDead = () => dead;

    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop&timeout=600000` });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(1);
    expect(_paneDeathWatcherCount()).toBe(1);

    dead = true;
    const body = (await pending).json();
    expect(body.data.wait.ended).toBe(true);
    expect(body.data.wait.timedOut).toBe(false);
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(0);
    // ...and the watcher is torn down with the last waiter that needed it.
    expect(_paneDeathWatcherCount()).toBe(0);
  }, 10_000);

  it('an until=exit caller parked when the worker dies gets its signal, not a bare ended', async () => {
    const { app, ctx } = await harness();
    let dead = false;
    (ctx.mux as unknown as { isPaneDead: () => boolean }).isPaneDead = () => dead;

    const pending = app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION_ID}/wait?until=exit&fresh=1&timeout=600000`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    dead = true;

    const body = (await pending).json();
    expect(body.data.wait.signal).toBe('exit');
    expect(body.data.wait.ended).toBe(false);
  }, 10_000);

  it('starts no watcher at all when the session is not tmux-backed', async () => {
    const { app, ctx } = await harness();
    setPaneDead(ctx, false);
    ctx.sessions.get(SESSION_ID)!.usesMux = false;

    const pending = app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop&timeout=600000` });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(_paneDeathWatcherCount()).toBe(0);

    sessionWaits.cancelAll(SESSION_ID);
    await pending;
  });

  it('shares ONE watcher across every wait parked on the same session', async () => {
    const { app, ctx } = await harness();
    setPaneDead(ctx, false);

    const pendings = [];
    for (let i = 0; i < 5; i++) {
      pendings.push(app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?until=stop&timeout=600000` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sessionWaits.signalWaiterCount(SESSION_ID)).toBe(5);
    expect(_paneDeathWatcherCount()).toBe(1);

    sessionWaits.cancelAll(SESSION_ID);
    await Promise.all(pendings);
    expect(_paneDeathWatcherCount()).toBe(0);
  });
});

describe('GET /api/sessions/:id/wait: an oversized timeout clamps, it does not 400', () => {
  it('accepts a value above the old schema ceiling and reports the clamp', async () => {
    // "Clamped to [1000, 600000]" has to mean it: `timeout=600001` clamping while
    // `timeout=99999999` 400s is the same documented rule producing two outcomes.
    const { app } = await harness();
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${SESSION_ID}/wait?until=idle&timeout=99999999`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.wait.timeoutMs).toBe(MAX_WAIT_MS);
  });

  it('still rejects a non-finite or non-integer timeout', async () => {
    const { app } = await harness();
    for (const value of ['1e999', 'soon', '-1', '1.5']) {
      const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/wait?timeout=${value}` });
      expect(res.statusCode, `timeout=${value}`).toBe(400);
    }
  });
});
