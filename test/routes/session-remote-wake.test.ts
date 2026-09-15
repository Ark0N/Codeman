/**
 * @fileoverview Route tests for wake-on-LAN on `POST /api/sessions/:id/input`.
 *
 * The behavior that matters and cannot be tested at the registry level: a
 * wake-enabled remote session whose host is asleep must return 200 WITHOUT
 * writing into the stalled pane (the bytes would vanish), while every other
 * session keeps the historical fire-and-forget path untouched.
 *
 * The registry is injected through `registerSessionRoutes`'s test seam so no real
 * TCP connect, ssh, or WoL happens in CI.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSessionRoutes, _resetPaneLivenessState } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { createMockRouteContext } from '../mocks/index.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { RemoteWakeRegistry, type RemoteWakeDeps } from '../../src/remote-wake.js';
import type { SessionRemote } from '../../src/types.js';

const SESSION_ID = 'remote-wake-session';
const URL = `/api/sessions/${SESSION_ID}/input`;

afterEach(() => {
  sessionWaits.cancelAll(SESSION_ID);
  _resetPaneLivenessState();
});

interface Harness {
  app: FastifyInstance;
  ctx: ReturnType<typeof createMockRouteContext>;
  registry: RemoteWakeRegistry;
  probe: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
  events: string[];
  /** Let a held wake finish (see `holdWake`). */
  releaseWake: () => void;
}

const remoteSession: SessionRemote = {
  hostId: 'hufflepuff',
  label: 'Hufflepuff',
  host: '192.168.50.137',
  username: 'j',
  remotePath: '/home/j/codeman-pi-test',
  wakeCommand: '/home/joe/bin/whuff',
};

async function harness(opts: { remote?: SessionRemote; hostUp?: boolean; holdWake?: boolean } = {}): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext({ sessionId: SESSION_ID });
  const session = ctx.sessions.get(SESSION_ID)!;
  session.remote = opts.remote ?? remoteSession;

  const probe = vi.fn(async () => opts.hostUp ?? false);
  const wake = vi.fn(async () => true);
  const events: string[] = [];
  // With instantaneous mocks the whole wake chain (wake -> wait -> reattach ->
  // flush) can finish inside one `await`, so a test that wants to observe the
  // in-flight state has to hold the readiness poll open.
  let release: (() => void) | null = null;
  const deps: RemoteWakeDeps = {
    probe,
    wake,
    waitUntilReady: () =>
      opts.holdWake
        ? new Promise<boolean>((resolve) => {
            release = () => resolve(true);
          })
        : Promise.resolve(true),
    delay: async () => {},
    noteReconnected: () => {},
    broadcast: (event) => events.push(event),
    log: () => {},
  };
  const registry = new RemoteWakeRegistry(deps);

  registerSessionRoutes(app, ctx as never, { remoteWake: registry });
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx, registry, probe, wake, events, releaseWake: () => release?.() };
}

const send = (app: FastifyInstance, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: URL, payload });

describe('POST /api/sessions/:id/input — wake-on-LAN', () => {
  it('buffers input instead of writing into a sleeping host, then flushes after the wake', async () => {
    const h = await harness({ hostUp: false, holdWake: true });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    const res = await send(h.app, { input: 'hallo', useMux: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    // Nothing reached the pane: writing now would be swallowed by the stalled ssh.
    expect(session.writeBuffer).toEqual([]);
    expect(h.wake).toHaveBeenCalledWith({ kind: 'command', command: '/home/joe/bin/whuff' });
    expect(h.registry.isWaking(SESSION_ID)).toBe(true);

    h.releaseWake();
    await h.registry.wake(session);
    expect(session.writeBuffer).toEqual(['hallo']);
    expect(session.reattachRemote).toHaveBeenCalled();
  });

  it('keeps the historical fire-and-forget write when the host is reachable', async () => {
    const h = await harness({ hostUp: true });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    const res = await send(h.app, { input: 'hallo', useMux: true });

    expect(res.json()).toEqual({});
    await vi.waitFor(() => expect(session.writeBuffer).toEqual(['hallo']));
    expect(h.wake).not.toHaveBeenCalled();
    expect(session.reattachRemote).not.toHaveBeenCalled();
  });

  it('never probes or wakes a session without a wake command', async () => {
    const { wakeCommand, ...withoutWake } = remoteSession;
    const h = await harness({ remote: withoutWake as SessionRemote });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    await send(h.app, { input: 'hallo', useMux: true });

    await vi.waitFor(() => expect(session.writeBuffer).toEqual(['hallo']));
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('wakes before writing on the send-and-wait path (no buffering, the response waits anyway)', async () => {
    const h = await harness({ hostUp: false });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    await send(h.app, { input: 'hallo', useMux: true, wait: 'idle', waitTimeout: 60 });

    expect(h.wake).toHaveBeenCalledTimes(1);
    // `ensureAwake` is awaited on this path, so the write happens inline and the
    // waiter is registered against a live pane.
    expect(session.writeBuffer).toEqual(['hallo']);
  });
});

describe('GET /api/sessions/:id/reachability', () => {
  const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url });

  it('reports the probe result and how the host can be woken', async () => {
    const up = await harness({ hostUp: true });
    const upBody = (await get(up.app, `/api/sessions/${SESSION_ID}/reachability`)).json();
    expect(upBody.data.reachable).toBe(true);
    expect(upBody.data.wakeConfigured).toBe('command');
    expect(upBody.data.label).toBe('Hufflepuff');

    const down = await harness({ hostUp: false });
    const downBody = (await get(down.app, `/api/sessions/${SESSION_ID}/reachability`)).json();
    expect(downBody.data.reachable).toBe(false);
    // A reachability check is a QUESTION, never an action: the host stays asleep.
    expect(down.wake).not.toHaveBeenCalled();
  });

  it('says nothing can wake a host without a configured target', async () => {
    const { wakeCommand, ...withoutWake } = remoteSession;
    const h = await harness({ remote: withoutWake as SessionRemote, hostUp: false });
    const body = (await get(h.app, `/api/sessions/${SESSION_ID}/reachability`)).json();
    expect(body.data.reachable).toBe(false);
    expect(body.data.wakeConfigured).toBe('none');
  });
});

describe('POST /api/sessions/:id/wake', () => {
  const wake = (app: FastifyInstance) => app.inject({ method: 'POST', url: `/api/sessions/${SESSION_ID}/wake` });

  it('wakes the host, reattaches the pane and reports both', async () => {
    const h = await harness({ hostUp: false });
    const session = h.ctx.sessions.get(SESSION_ID)!;

    const body = (await wake(h.app)).json();

    expect(body.success).toBe(true);
    expect(body.data.woke).toBe(true);
    expect(body.data.reachable).toBe(true);
    expect(session.reattachRemote).toHaveBeenCalled();
  });

  it('answers with an error the UI can route to the config dialog', async () => {
    const { wakeCommand, ...withoutWake } = remoteSession;
    const h = await harness({ remote: withoutWake as SessionRemote, hostUp: false });

    const res = await wake(h.app);
    const body = res.json();

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/No wake-on-LAN target/);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('does not send a wake when the host answers, but still settles the session', async () => {
    const h = await harness({ hostUp: true });
    const body = (await wake(h.app)).json();
    expect(body.data.woke).toBe(true);
    expect(h.wake).not.toHaveBeenCalled();
  });
});
