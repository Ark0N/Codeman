/**
 * @fileoverview A lost input must stay retryable.
 *
 * POST /api/sessions/:id/input answers 200 BEFORE the write is attempted — the mux
 * write is fire-and-forget so the HTTP response never waits on a tmux child. The
 * dedup bookkeeping, however, recorded the (clientId, seq) pair as applied at that
 * same moment. A write that then failed left the client with a 200, no message in
 * the pane, and a seq the server would reject as a duplicate on retry: the input was
 * unrecoverable by the very mechanism meant to make delivery reliable.
 *
 * Observed in the wild: a prompt shown as sent in a chat client, a 200 in the proxy
 * log, and an empty prompt line in the pane.
 */

import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../../src/session.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { isPlainPromptInput } from '../../src/web/route-helpers.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';

async function createEnvelopeHarness(): Promise<{ app: FastifyInstance; ctx: MockRouteContext }> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx as never);

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
  return { app, ctx };
}

type Internals = { _appliedInputSeq: Map<string, number> };
const seqOf = (s: Session, client: string) => (s as unknown as Internals)._appliedInputSeq.get(client);

describe('input dedup bookkeeping', () => {
  const make = () => new Session({ workingDir: '/tmp', mode: 'claude' });

  it('accepts an increasing seq once and rejects the replay', () => {
    const s = make();
    expect(s.shouldApplyInput('c1', 1)).toBe(true);
    expect(s.shouldApplyInput('c1', 1)).toBe(false);
    expect(s.shouldApplyInput('c1', 2)).toBe(true);
  });

  it('forgetInputSeq re-opens a failed delivery for retry', () => {
    const s = make();
    expect(s.shouldApplyInput('c1', 7)).toBe(true);

    s.forgetInputSeq('c1', 7); // the write failed after the 200 went out

    expect(s.shouldApplyInput('c1', 7)).toBe(true);
  });

  it('does not re-open a seq that a later input has superseded', () => {
    // Rolling back blindly would let an old, already-superseded message replay.
    const s = make();
    s.shouldApplyInput('c1', 7);
    s.shouldApplyInput('c1', 8);

    s.forgetInputSeq('c1', 7);

    expect(s.shouldApplyInput('c1', 8)).toBe(false);
    expect(seqOf(s, 'c1')).toBe(8);
  });

  it('is scoped per client', () => {
    const s = make();
    s.shouldApplyInput('c1', 5);
    s.forgetInputSeq('c2', 5);
    expect(s.shouldApplyInput('c1', 5)).toBe(false);
  });

  it('tolerates a rollback for a client that was never seen', () => {
    const s = make();
    expect(() => s.forgetInputSeq('ghost', 3)).not.toThrow();
  });
});

describe('Session.write delivery signal', () => {
  it('reports false when there is no PTY instead of swallowing the data', () => {
    // The silent swallow was the third way input could vanish: no PTY, no error,
    // no return value — the caller had no way to know.
    const s = new Session({ workingDir: '/tmp', mode: 'claude' });
    expect(s.write('hello\r')).toBe(false);
  });
});

/**
 * Wiring, not primitives.
 *
 * The first version of this file tested Session directly and nothing else: reverting
 * the route to master — deleting the rollback call, the load-bearing half of the fix —
 * left all six tests green. These drive the actual HTTP route.
 */
describe('POST /api/sessions/:id/input rollback wiring', () => {
  let harness: { app: FastifyInstance; ctx: MockRouteContext };

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  const post = (body: Record<string, unknown>, id = 'test-session-1') =>
    harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/input`, payload: body });

  it('rolls the seq back when both the mux write and the direct write fail', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.failWrites = true; // writeViaMux false AND write() false

    await post({ input: 'lost\r', useMux: true, clientId: 'c1', seq: 1 });
    await new Promise((r) => setTimeout(r, 20)); // the mux write is fire-and-forget

    // The retry the client would make must be accepted, not swallowed as a duplicate.
    expect(session.shouldApplyInput('c1', 1)).toBe(true);
  });

  it('keeps the seq burnt when delivery succeeded', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;

    await post({ input: 'fine\r', useMux: true, clientId: 'c1', seq: 1 });
    await new Promise((r) => setTimeout(r, 20));

    expect(session.shouldApplyInput('c1', 1)).toBe(false);
  });

  it('rolls the seq back on the non-mux path too', async () => {
    // Still a 200: a session may legitimately have no PTY yet, and turning that
    // into a failure status would be a contract change. Re-opening the seq is not.
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.failWrites = true;

    const res = await post({ input: 'x\r', useMux: false, clientId: 'c2', seq: 5 });

    expect(res.statusCode).toBe(200);
    expect(session.shouldApplyInput('c2', 5)).toBe(true);
  });
});

/**
 * A plain prompt goes through the mux even when the caller did not say `useMux`.
 *
 * Measured on Claude Code 2.1.283: a direct write of `<text>\r` arrives as one burst,
 * a burst of about a hundred characters is taken as a paste, and its `\r` lands as a
 * newline in the composer, so a script's prompt sat there unsent while the route
 * answered 200. The mux path types the text, presses Enter on its own, and arms the
 * submit verifier.
 */
describe('POST /api/sessions/:id/input plain-prompt routing', () => {
  let harness: { app: FastifyInstance; ctx: MockRouteContext };

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  const post = (body: Record<string, unknown>) =>
    harness.app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input', payload: body });
  const spies = () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    return { session, viaMux: vi.spyOn(session, 'writeViaMux'), direct: vi.spyOn(session, 'write') };
  };
  const LONG_PROMPT =
    'Reply with only the word ok and nothing else, this sentence is padding to reach about one hundred chars.\r';

  it('sends a prompt with no useMux through the mux, not as one burst', async () => {
    const { viaMux, direct } = spies();

    const res = await post({ input: LONG_PROMPT });

    expect(res.statusCode).toBe(200);
    expect(viaMux).toHaveBeenCalledWith(LONG_PROMPT, { fromUser: true });
    expect(direct).not.toHaveBeenCalled();
  });

  it('answers only once the mux write is done, so the next frame cannot overtake it', async () => {
    // The browser's POST fallback sends frames one at a time and waits for each 2xx;
    // a fire-and-forget write here would let its next keystroke land before the Enter.
    const { viaMux } = spies();
    let finished = false;
    viaMux.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
      return true;
    });

    await post({ input: 'ok\r', clientId: 'browser-1', seq: 1 });

    expect(finished).toBe(true);
  });

  it('falls back to the direct write when the mux write fails', async () => {
    const { viaMux, direct } = spies();
    viaMux.mockResolvedValue(false);

    await post({ input: 'hello\r' });

    expect(direct).toHaveBeenCalledWith('hello\r', { fromUser: true });
  });

  it('keeps the raw write for an explicit useMux: false', async () => {
    const { viaMux, direct } = spies();

    await post({ input: LONG_PROMPT, useMux: false });

    expect(direct).toHaveBeenCalledWith(LONG_PROMPT, { fromUser: true });
    expect(viaMux).not.toHaveBeenCalled();
  });

  it.each([
    ['a bare Enter', '\r'],
    ['text with no Enter', 'hello'],
    ['an arrow key', '\x1b[A'],
    ['a bracketed paste frame', '\x1b[200~line one\nline two\x1b[201~'],
    ['a line feed inside', 'line one\nline two\r'],
    ['two Enters', 'hello\r\r'],
    ['a tab', 'a\tb\r'],
  ])('leaves %s on the direct write', async (_label, input) => {
    const { viaMux, direct } = spies();

    await post({ input });

    expect(direct).toHaveBeenCalledWith(input, { fromUser: true });
    expect(viaMux).not.toHaveBeenCalled();
  });
});

describe('isPlainPromptInput', () => {
  it('accepts printable text ending in exactly one carriage return', () => {
    expect(isPlainPromptInput('run the tests\r')).toBe(true);
    expect(isPlainPromptInput('ünïcødé and emoji 🚀\r')).toBe(true);
  });

  it('refuses anything carrying another control character', () => {
    for (const input of ['\r', 'x', 'x\n', 'x\r\n', 'x\r\r', '\x1b[Ax\r', 'a\tb\r', 'x\x7f\r', 'x\u009b\r', '\rx']) {
      expect(isPlainPromptInput(input), JSON.stringify(input)).toBe(false);
    }
  });
});
