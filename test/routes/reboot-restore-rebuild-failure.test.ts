/**
 * Reboot-restore route: what happens when a rebuild gets part-way and then fails.
 *
 * The other route test file deliberately uses workspaces that do not exist, so it
 * never reaches `new Session()`. This one mocks the `Session` module so the route
 * runs its whole construction path — `addSession`, `setupSessionListeners`,
 * `reapplyPersistedSessionState`, `startInteractive` — and then throws.
 *
 * The mock is the only way in. Driven against a real server, `startInteractive()`
 * does not throw for either obvious cause: the CLI resolver finds its binary by
 * absolute path rather than through PATH, and tmux falls back to another
 * directory rather than failing when it cannot enter the workspace. A mux-layer
 * failure is what is left, and it cannot be provoked from a test. Without the
 * mock this path would go unexercised, which is how the original version of this
 * route shipped a session leak the tests could not see.
 *
 * It also covers the session caps, because those too are only reachable once the
 * route is actually willing to build something.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

/** Set per test: whether the mocked `startInteractive()` rejects. */
let startShouldThrow = false;
/** Ordering log, so a test can assert what ran before the pane spawned. */
const callOrder: string[] = [];

vi.mock('../../src/session.js', () => ({
  Session: class {
    id: string;
    mode: string;
    name?: string;
    workingDir: string;
    owner?: string;
    claudeSessionId: string | null = null;
    constructor(config: { id: string; mode?: string; name?: string; workingDir: string; owner?: string }) {
      this.id = config.id;
      this.mode = config.mode ?? 'claude';
      this.name = config.name;
      this.workingDir = config.workingDir;
      this.owner = config.owner;
    }
    async startInteractive() {
      callOrder.push('startInteractive');
      if (startShouldThrow) throw new Error('spawn claude ENOENT');
    }
    /** The mock route context projects a session through this on broadcast. */
    toState() {
      return { id: this.id, mode: this.mode, name: this.name, workingDir: this.workingDir, owner: this.owner };
    }
  },
}));

const { registerRebootRestoreRoutes } = await import('../../src/web/routes/reboot-restore-routes.js');
const { rebootRestoreRegistry } = await import('../../src/web/reboot-restore-registry.js');
const { installRouteErrorHandler } = await import('../../src/web/route-error-handler.js');
const { httpStatusForErrorCode } = await import('../../src/types.js');
const { createMockRouteContext } = await import('../mocks/index.js');
type ApiErrorCode = import('../../src/types.js').ApiErrorCode;
type RebootRestoreEntry = import('../../src/reboot-restore.js').RebootRestoreEntry;
type SessionState = import('../../src/types.js').SessionState;

/** A real directory, so the route's workspace checks pass and it reaches the build. */
const WORKSPACE = process.cwd();

function offerEntry(sessionId: string, owner?: string): RebootRestoreEntry {
  return {
    sessionId,
    name: `session ${sessionId}`,
    workingDir: WORKSPACE,
    owner,
    mode: 'claude',
    resumeConversationId: `conv-${sessionId}`,
    state: {
      id: sessionId,
      pid: null,
      status: 'idle',
      workingDir: WORKSPACE,
      currentTaskId: null,
      createdAt: 1_760_000_000_000,
      mode: 'claude',
      owner,
    } as SessionState,
  };
}

async function createHarness(ctx: ReturnType<typeof createMockRouteContext>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerRebootRestoreRoutes(app, ctx as never);
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
  return app;
}

beforeEach(() => {
  startShouldThrow = false;
  callOrder.length = 0;
});

afterEach(() => {
  rebootRestoreRegistry.reset();
  vi.clearAllMocks();
});

describe('a rebuild that fails after the session is registered', () => {
  it('reports why it failed rather than blaming the workspace', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored).toEqual([]);
    // Not `workspace-missing`: the directory is there, the agent would not start.
    expect(res.skipped).toEqual([{ sessionId: 'a', reason: 'rebuild-failed' }]);
    await app.close();
  });

  it('does not leave a registered session with no pane behind it', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    // The session reached ctx.sessions via addSession; the route has to take it
    // back out, or the board shows a tab whose pane never existed.
    expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith('a');
    expect(ctx.sessions.has('a')).toBe(false);
    // NOT the user-initiated delete: that would bank this session's historical
    // tokens into the lifetime totals, demote a pinned record to `stopped`, and
    // delete the workspace's .codeman-uploads.
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the entry on offer, so the user can fix the PATH and click again', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['a']);
    await app.close();
  });
});

describe('a rebuild that succeeds', () => {
  it('re-applies the persisted state before the record is written again', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored.map((s: { id: string }) => s.id)).toEqual(['a']);
    // A session built from a record carries none of the pin, token totals or
    // custom-model selection, so persisting it first would replace the fuller
    // record with the reduced one.
    expect(ctx.reapplyPersistedSessionState).toHaveBeenCalled();
    const reapplyOrder = (ctx.reapplyPersistedSessionState as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const persistOrder = (ctx.persistSessionState as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(reapplyOrder).toBeLessThan(persistOrder);
    await app.close();
  });

  it('shapes the pane before it spawns, and restores the history after', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    (ctx.reapplyPersistedSessionState as ReturnType<typeof vi.fn>).mockImplementation(
      async (_s: unknown, _saved: unknown, phase: string) => {
        callOrder.push(`reapply:${phase}`);
      }
    );
    (ctx.setupSessionListeners as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('setupSessionListeners');
    });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    // `setupSessionListeners()` READS the image-watcher flag that `before-spawn`
    // restores, so the phase has to precede it or the session comes back
    // reporting the watcher as on with nothing watching. The custom-model
    // environment has to reach the process, and the token totals must not land
    // on a session whose pane never started.
    expect(callOrder).toEqual([
      'reapply:before-spawn',
      'setupSessionListeners',
      'startInteractive',
      'reapply:after-spawn',
    ]);
    await app.close();
  });

  it('tells every other board about the rebuilt session', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(ctx.broadcast).toHaveBeenCalledWith('session:created', expect.anything());
    await app.close();
  });

  it('spends the entry, so it is no longer on offer', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions).toEqual([]);
    await app.close();
  });
});

describe('the session caps', () => {
  it('counts the sessions it is itself creating, not just the ones it started with', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    // One seat short of the documented maximum of 50, counting the session the
    // mock context seeds. A check that ran once before the loop would restore
    // BOTH entries; only a per-iteration check refuses the second.
    for (let i = 0; i < 48; i += 1) {
      ctx.sessions.set(`filler-${i}`, { id: `filler-${i}`, owner: undefined } as never);
    }
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored.map((s: { id: string }) => s.id)).toEqual(['a']);
    expect(res.skipped).toEqual([{ sessionId: 'b', reason: 'capacity-reached' }]);

    // Refused rather than lost: closing a session and clicking again works.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['b']);
    await app.close();
  });

  it('refuses every entry when the board is already at the cap', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    for (let i = 0; i < 50; i += 1) {
      ctx.sessions.set(`filler-${i}`, { id: `filler-${i}`, owner: undefined } as never);
    }
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored).toEqual([]);
    expect(res.skipped.map((s: { reason: string }) => s.reason)).toEqual(['capacity-reached', 'capacity-reached']);
    await app.close();
  });
});

describe('a failure before any entry is considered', () => {
  it('returns the whole plan rather than spending it', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    (ctx.getWorkspaceHooksEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('settings unreadable'));
    const app = await createHarness(ctx);

    const res = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);

    // The plan cannot be rebuilt once boot has pruned the records, so a throw
    // anywhere in the route has to hand the entries back.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id).sort()).toEqual(['a', 'b']);
    await app.close();
  });

  it('releases the single flight, so the next click is not refused', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    (ctx.getWorkspaceHooksEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('settings unreadable'));
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(rebootRestoreRegistry.beginSpending(undefined)).toBe(true);
    rebootRestoreRegistry.endSpending(undefined);
    await app.close();
  });
});

describe('a dismiss that lands while a restore is running', () => {
  it('wins when an admin is restoring the entries and their owner dismisses', async () => {
    const theirs = offerEntry('theirs', 'bob');
    rebootRestoreRegistry.set([theirs]);
    // An admin may spend another user's entries, so the caller doing the restore
    // and the owner of what is being restored are different people.
    const taken = rebootRestoreRegistry.take(() => true, undefined, 'admin');
    expect(taken.map((e) => e.sessionId)).toEqual(['theirs']);

    // Bob dismisses his own banner. Nothing of his is in the plan any more, and
    // the restore is running under a different name than his.
    rebootRestoreRegistry.clear((owner) => owner === 'bob');
    rebootRestoreRegistry.releaseFlight('admin', taken);

    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  });

  it('wins when an admin dismisses everything mid-restore', async () => {
    rebootRestoreRegistry.set([offerEntry('theirs', 'bob')]);
    const taken = rebootRestoreRegistry.take(() => true, undefined, 'admin');

    rebootRestoreRegistry.clear(() => true);
    rebootRestoreRegistry.releaseFlight('admin', taken);

    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  });

  it('wins, rather than being undone when the route hands its entries back', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    // The user clicks Dismiss while the restore is between its take and its
    // return. Driven through the ROUTE, so removing the generation argument from
    // the route would make this fail.
    (ctx.getWorkspaceHooksEnabled as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      rebootRestoreRegistry.clear(() => true);
      throw new Error('settings unreadable');
    });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });

    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions).toEqual([]);
    await app.close();
  });

  it('reaches an in-flight restore the dismisser can see, even once its entries are taken', async () => {
    const mine = offerEntry('mine', 'alice');
    rebootRestoreRegistry.set([mine]);
    const taken = rebootRestoreRegistry.take((owner) => owner === 'alice', undefined, 'alice');
    expect(taken).toHaveLength(1);

    // The plan is empty now, so the dismiss has nothing of Alice's left in the
    // plan; it has to reach the entry the restore is holding.
    rebootRestoreRegistry.clear((owner) => owner === 'alice');
    rebootRestoreRegistry.releaseFlight('alice', taken);

    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  });

  it('does not reach another owner, whose unspent entries still come back', async () => {
    const mine = offerEntry('mine', 'alice');
    const theirs = offerEntry('theirs', 'bob');
    rebootRestoreRegistry.set([mine, theirs]);

    // Bob is mid-restore, holding his own entry.
    const bobsTaken = rebootRestoreRegistry.take((owner) => owner === 'bob', undefined, 'bob');
    expect(bobsTaken.map((e) => e.sessionId)).toEqual(['theirs']);

    // Alice dismisses her own banner meanwhile.
    rebootRestoreRegistry.clear((owner) => owner === 'alice');

    // Bob's restore finishes and hands his entry back. Alice's dismiss covered
    // her entries, not his, so his offer survives.
    rebootRestoreRegistry.releaseFlight('bob', bobsTaken);
    expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual(['theirs']);
  });
});
