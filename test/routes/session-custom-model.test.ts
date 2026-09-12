/**
 * @fileoverview Tests for POST /api/sessions/:id/custom-model (deployment_plan.md
 * chunk 5 — applying/clearing a session's custom model endpoint + CLI restart).
 * Port: N/A (app.inject, no real port needed)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { getDataDir } from '../../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';

const CLAUDE_ENDPOINT: CustomModelHost = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'k',
};

async function setup() {
  await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT]);
  return createRouteTestHarness(registerSessionRoutes);
}

describe('POST /api/sessions/:id/custom-model', () => {
  beforeEach(async () => {
    await writeCustomModelHosts(getDataDir(), []);
  });

  it('applies an endpoint/model to a claude-mode session and restarts the CLI', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.customModel).toEqual({ endpointId: 'ep1', modelId: 'qwen3', label: 'llama.cpp box' });
    expect(body.restarted).toBe(true);
    expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    expect(session.restartCli).toHaveBeenCalledTimes(1);

    // Verify the actual injected env vars via setCustomModel's captured call args.
    const [next, envOverrides] = session.setCustomModel.mock.calls[0];
    expect(next.envKeys).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ]);
    expect(envOverrides.ANTHROPIC_BASE_URL).toBe('http://192.168.1.50:8080');
    expect(envOverrides.ANTHROPIC_API_KEY).toBe('k');
  });

  it('clears back to the native default', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { clear: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().customModel).toBeUndefined();
    expect(session.setCustomModel).toHaveBeenCalledWith(undefined);
    expect(session.restartCli).toHaveBeenCalledTimes(1);
  });

  it('404s for an unknown endpoint id', async () => {
    const { app, ctx } = await setup();
    ctx.sessions.get('test-session-1')!.mode = 'claude';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ghost', modelId: 'qwen3' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('NOT_FOUND');
  });

  it('refuses a mode with no known custom-model mechanism (antigravity)', async () => {
    const { app, ctx } = await setup();
    ctx.sessions.get('test-session-1')!.mode = 'antigravity';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
  });

  it('refuses to touch a busy session', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';
    session.isBusy = () => true;

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('SESSION_BUSY');
    expect(session.setCustomModel).not.toHaveBeenCalled();
  });
});
