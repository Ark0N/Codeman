/**
 * @fileoverview `model` on POST /api/sessions — a Claude model for one session only.
 *
 * Claude's model reaches disk only through `modelOverride`, which writes it into the
 * case's `.claude/settings.local.json` for every later run there. `model` is the
 * per-session counterpart: it goes out as `claude --model <id>`, wins over the app-wide
 * default, and writes nothing. What the tests read is the model the session hands the
 * mux when it starts, which is what becomes the `--model` flag.
 *
 * Uses app.inject(), so no real HTTP port is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

describe('POST /api/sessions model', () => {
  let workingDir: string;
  let harness: Harness;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'codeman-session-model-'));
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
    await rm(workingDir, { recursive: true, force: true });
  });

  /** Creates a session and starts it, then returns the model it handed the mux. */
  async function launchedModel(payload: Record<string, unknown>): Promise<unknown> {
    const res = await harness.app.inject({ method: 'POST', url: '/api/sessions', payload: { workingDir, ...payload } });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    const id = (parsed.data?.session ?? parsed.session).id as string;
    await harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/interactive`, payload: {} });
    const calls = harness.ctx.mux.createSession.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return (calls[calls.length - 1][0] as { model?: string }).model;
  }

  it('launches a Claude session on the model the caller names', async () => {
    expect(await launchedModel({ mode: 'claude', model: 'claude-fable-5-1' })).toBe('claude-fable-5-1');
  });

  it('wins over the app-wide default model', async () => {
    harness.ctx.getModelConfig.mockResolvedValue({ defaultModel: 'sonnet' });
    expect(await launchedModel({ mode: 'claude', model: 'opus' })).toBe('opus');
  });

  it('leaves the app-wide default in charge when the caller names none', async () => {
    harness.ctx.getModelConfig.mockResolvedValue({ defaultModel: 'sonnet' });
    expect(await launchedModel({ mode: 'claude' })).toBe('sonnet');
  });

  it('launches on `model` while `modelOverride` alone reaches the case file', async () => {
    // Sent together, each lands where it belongs: the persistent default in the case's
    // settings.local.json, and this session's model on its launch line. A route that wrote
    // `model` to disk would put 'opus' in the file; one that ignored it would launch 'sonnet'.
    expect(await launchedModel({ mode: 'claude', model: 'opus', modelOverride: 'sonnet' })).toBe('opus');
    const settings = JSON.parse(await readFile(join(workingDir, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.model).toBe('sonnet');
  });

  it('reads an empty model as no model, as modelOverride does', async () => {
    harness.ctx.getModelConfig.mockResolvedValue({ defaultModel: 'sonnet' });
    expect(await launchedModel({ mode: 'claude', model: '' })).toBe('sonnet');
  });

  it('refuses a model for a CLI that takes its model in its own config object', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workingDir, mode: 'codex', model: 'gpt-5' },
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.success).toBe(false);
    expect(parsed.errorCode).toBe('INVALID_INPUT');
    expect(harness.ctx.sessions.size).toBe(1); // only the session the mock context starts with
  });

  it('rejects a model with characters the launch pattern refuses', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workingDir, mode: 'claude', model: 'opus; rm -rf ~' },
    });
    expect(res.statusCode).toBe(400);
  });
});
