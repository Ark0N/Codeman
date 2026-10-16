/**
 * @fileoverview Tests for the external-CLI branch of GET /api/sessions/:id/last-response.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * OpenCode / Gemini / Antigravity / Pi render their own TUIs and never write a
 * Claude transcript under ~/.claude/projects, so before this branch existed the
 * handler fell through to the Claude scan, found nothing, and the response viewer
 * was permanently empty for those modes. These tests pin:
 *   - the pane buffer is segmented and the LAST response is returned
 *   - ?context=full carries the parsed blocks, and the short form omits them
 *   - ?context=full blocks carry role — the frontend renders via msg.role, so a
 *     block without it lost the "You" badge on prompts
 *   - a pane that has produced no output reports hasContext: false rather than 404ing
 *   - Claude mode still takes the Claude path (regression guard)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, createMockSession, type MockRouteContext } from '../mocks/index.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/** Mirror of the production uniform-envelope hook (server.ts), as in the sibling suites. */
async function createEnvelopeHarness(
  registerFn: (app: FastifyInstance, ctx: MockRouteContext) => void
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
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

  await app.ready();
  return { app, ctx };
}

// A pane as one of these CLIs actually leaves it: banner, a `›` prompt line, a
// status divider, a tool-activity marker, then the assistant's prose.
const PANE = `
╭──────────────────────────────────────────────────────╮
│ >_ OpenCode                                          │
│ directory: /workspace/project                        │
╰──────────────────────────────────────────────────────╯

› summarise the retry logic

model · project · main · Ready · Context 100% left

• Explored
  └ Read src/retry.ts

The retry helper backs off exponentially and gives up after five attempts.

› now document it

model · project · main · Ready · Context 92% left

• Called write_file

Documented the helper in docs/retry.md, including the five-attempt ceiling.
`.trim();

describe('GET /api/sessions/:id/last-response — external CLI panes', () => {
  let harness: LocalHarness;
  let session: ReturnType<typeof createMockSession>;

  beforeEach(async () => {
    harness = await createEnvelopeHarness(registerSessionRoutes);
    session = harness.ctx._session;
  });

  async function lastResponse(full = false) {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/last-response${full ? '?context=full' : ''}`,
    });
    return { res, body: JSON.parse(res.body) };
  }

  for (const mode of ['opencode', 'gemini', 'antigravity', 'pi'] as const) {
    it(`returns the last assistant response from the ${mode} pane buffer`, async () => {
      session.mode = mode;
      session.terminalBuffer = PANE;

      const { res, body } = await lastResponse();

      expect(res.statusCode).toBe(200);
      // The LAST response, not the first — the viewer shows the current turn.
      expect(body.data.text).toContain('Documented the helper in docs/retry.md');
      expect(body.data.text).not.toContain('backs off exponentially');
      expect(body.data.hasContext).toBe(true);
      // Short form stays short: blocks only travel under ?context=full.
      expect(body.data.messages).toBeUndefined();
    });
  }

  it('carries the parsed blocks under ?context=full', async () => {
    session.mode = 'opencode';
    session.terminalBuffer = PANE;

    const { body } = await lastResponse(true);

    const kinds = body.data.messages.map((block: { kind: string }) => block.kind);
    expect(kinds).toContain('prompt');
    expect(kinds).toContain('response');
    expect(kinds).toContain('tool');
    // Both user turns survive segmentation, so the viewer can show the exchange.
    const prompts = body.data.messages.filter((b: { kind: string }) => b.kind === 'prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1].text).toContain('now document it');

    // loadFullContext() renders via msg.role — without it every block got the
    // agent badge and the user's own prompts lost their "You" attribution.
    for (const block of body.data.messages as Array<{ kind: string; role: string }>) {
      expect(block.role).toBe(block.kind === 'prompt' ? 'user' : 'assistant');
    }
  });

  it('reports hasContext false for a pane that has produced no output', async () => {
    session.mode = 'gemini';
    // Session created but nothing rendered yet. Any non-prompt line counts as
    // prose to the parser, so the empty pane is the honest no-context case.
    session.terminalBuffer = '';

    const { res, body } = await lastResponse();

    expect(res.statusCode).toBe(200);
    expect(body.data.text).toBe('');
    expect(body.data.hasContext).toBe(false);
  });

  it('answers jcode with an honest empty, never a segmented pane', async () => {
    // jcode is a repainting alternate-screen TUI: segmenting its stream served the
    // welcome banner as "the answer" (measured on a live pane), and the Claude scan
    // below the external branch could adopt a Claude conversation from the same folder.
    // It has no transcript reader yet, so "nothing said yet" is the only honest reply.
    session.mode = 'jcode';
    session.terminalBuffer = PANE;

    const { res, body } = await lastResponse();
    expect(res.statusCode).toBe(200);
    expect(body.data.text).toBe('');
    expect(body.data.messages).toBeUndefined();

    const full = await lastResponse(true);
    expect(full.body.data.text).toBe('');
    expect(full.body.data.messages).toEqual([]);
  });

  it('leaves Claude mode on the Claude transcript path', async () => {
    // Regression guard: a claude pane must NOT be segmented off its terminal
    // buffer, or a real transcript would be shadowed by scraped pane text.
    session.mode = 'claude';
    session.terminalBuffer = PANE;

    const { res, body } = await lastResponse();

    expect(res.statusCode).toBe(200);
    expect(body.data.text).not.toContain('Documented the helper');
  });
});
