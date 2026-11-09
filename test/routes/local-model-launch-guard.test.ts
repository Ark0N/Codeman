/**
 * @fileoverview The launch guard of the endpoint the local model install manages, at the two
 * routes that put a session onto a custom model endpoint: they ask the install service before
 * anything is written.
 *
 *  - `POST /api/sessions/:id/custom-model` (a running session switches to the endpoint), and
 *  - `POST /api/quick-start` with `customModel` (a session is created on it)
 *
 * call `LocalModelService.launchRefusalMessage(endpointId, modelId)` once the endpoint is
 * found and before anything is written, restarted or created. A sentence back is the answer
 * (`OPERATION_FAILED`); `undefined` lets the launch go on exactly as before. That is how a
 * model whose digest is no longer the one stored at install time is not launched, and how
 * nothing is launched against a port our runtime is not on.
 *
 * Every OTHER way a new agent process comes to be on the endpoint (the attach that finds no
 * pane, the respawn of a dead pane, a restart in place, the rebuild after a reboot) is
 * covered below the routes, by `Session`'s launch guard: test/local-model-session-launch-guard.test.ts.
 *
 * The service is replaced by a fake for most cases, and is the REAL one (over the real state
 * file, with no runtime running) for the cases that pin the default wiring.
 *
 * Port: N/A (app.inject, no real port needed)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockRouteContext, safeRmHomeTree, type MockRouteContext } from '../mocks/index.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { dataPath, getDataDir } from '../../src/config/instance.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';
import { Session } from '../../src/session.js';
import { writeCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';
import { webviewFetch } from '../../src/web/webview-egress.js';
import type { LocalModelService } from '../../src/local-model/install-job.js';

vi.mock('../../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/web/webview-egress.js')>(
    '../../src/web/webview-egress.js'
  );
  return { ...actual, webviewFetch: vi.fn() };
});
const fetchMock = vi.mocked(webviewFetch);

// See test/routes/quick-start-custom-model.test.ts: the CLI availability gate runs before the
// code under test and would refuse every launch on a machine without the binary.
vi.mock('../../src/utils/cli-launcher.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/cli-launcher.js')>(
    '../../src/utils/cli-launcher.js'
  );
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

/** The service the session routes get: a fake by default, the real one where a test says so. */
const guard = vi.hoisted(() => ({
  launchRefusalMessage: vi.fn<(endpointId: string, modelId: string) => Promise<string | undefined>>(),
  real: undefined as LocalModelService | undefined,
}));
vi.mock('../../src/local-model/install-job.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/local-model/install-job.js')>(
    '../../src/local-model/install-job.js'
  );
  return {
    ...actual,
    getLocalModelService: () => guard.real ?? { launchRefusalMessage: guard.launchRefusalMessage },
  };
});

const MANAGED: CustomModelHost = {
  id: 'local-ollama',
  label: 'This Mac',
  baseUrl: 'http://127.0.0.1:11435',
  authStyle: 'bearer',
  models: ['qwen3.6:35b-a3b'],
  defaultModelId: 'qwen3.6:35b-a3b',
  defaultContextLength: 131072,
};

const OTHER: CustomModelHost = { id: 'ep1', label: 'llama.cpp box', baseUrl: 'http://192.168.1.50:8080', apiKey: 'k' };

const CHANGED = 'The model on this Mac changed since it was installed. Remove it and install it again.';
const STATE = () => dataPath('local-model.json');

/** The state file of an installed model whose connection is the managed record. */
function writeInstalledState(): void {
  writeFileSync(
    STATE(),
    JSON.stringify({
      schema: 1,
      state: 'installed',
      model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072, digest: 'abc123' },
      cli: { id: 'opencode', label: 'OpenCode' },
      runtime: { version: '0.40.15', port: 11435, enabled: true },
      connection: { endpointId: 'local-ollama', flagWasEnabled: false },
    })
  );
}

async function realService(): Promise<LocalModelService> {
  const actual = await vi.importActual<typeof import('../../src/local-model/install-job.js')>(
    '../../src/local-model/install-job.js'
  );
  // The real service with its real state file. No runtime was ever started by it.
  return actual.createLocalModelService();
}

beforeEach(async () => {
  guard.launchRefusalMessage.mockReset();
  guard.launchRefusalMessage.mockResolvedValue(undefined);
  guard.real = undefined;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
  await writeCustomModelHosts(getDataDir(), [MANAGED, OTHER]);
});

afterEach(async () => {
  rmSync(STATE(), { force: true });
  await rm(join(getDataDir(), 'custom-model-hosts.json'), { force: true });
  await rm(join(getDataDir(), 'custom-model-configs'), { recursive: true, force: true });
});

describe('POST /api/sessions/:id/custom-model on the managed endpoint', () => {
  async function setup() {
    const harness = await createRouteTestHarness(registerSessionRoutes);
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';
    return { ...harness, session };
  }

  const apply = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/sessions/test-session-1/custom-model', payload });

  it('asks the install service with the endpoint and the model, before anything is applied', async () => {
    const { app, session } = await setup();
    const res = await apply(app, { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' });
    expect(res.statusCode).toBe(200);
    expect(guard.launchRefusalMessage).toHaveBeenCalledTimes(1);
    expect(guard.launchRefusalMessage).toHaveBeenCalledWith('local-ollama', 'qwen3.6:35b-a3b');
    // No refusal: the model is applied and the CLI restarted, as for any endpoint.
    expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    expect(session.restartCli).toHaveBeenCalledTimes(1);
  });

  it('a changed model refuses the switch in one plain sentence, and nothing is written or restarted', async () => {
    const { app, session } = await setup();
    guard.launchRefusalMessage.mockResolvedValue(CHANGED);
    const res = await apply(app, { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' });
    expect(res.json()).toEqual({ success: false, error: CHANGED, errorCode: 'OPERATION_FAILED' });
    expect(session.setCustomModel).not.toHaveBeenCalled();
    expect(session.restartCli).not.toHaveBeenCalled();
    // The runtime was not even asked what it has loaded.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('every other endpoint is asked about too, and the service lets it through', async () => {
    const { app, session } = await setup();
    const res = await apply(app, { endpointId: 'ep1', modelId: 'qwen3' });
    expect(res.statusCode).toBe(200);
    expect(guard.launchRefusalMessage).toHaveBeenCalledWith('ep1', 'qwen3');
    expect(session.setCustomModel).toHaveBeenCalledTimes(1);
  });

  it('clearing a selection is never refused: it is the way OFF the endpoint', async () => {
    const { app, session } = await setup();
    guard.launchRefusalMessage.mockResolvedValue(CHANGED);
    session.setCustomModel.mockReturnValue({ previousConfigDir: undefined });
    const res = await apply(app, { clear: true });
    expect(res.statusCode).toBe(200);
    expect(guard.launchRefusalMessage).not.toHaveBeenCalled();
    expect(session.setCustomModel).toHaveBeenCalledWith(undefined);
  });

  it('an endpoint that does not exist is still a 404 of its own, asked about nothing', async () => {
    const { app } = await setup();
    const res = await apply(app, { endpointId: 'nope', modelId: 'x' });
    expect(res.json()).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
    expect(guard.launchRefusalMessage).not.toHaveBeenCalled();
  });

  describe('with the real install service', () => {
    it('an installed model whose runtime is not running is not switched to', async () => {
      writeInstalledState();
      guard.real = await realService();
      const { app, session } = await setup();
      const res = await apply(app, { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' });
      expect(res.json()).toEqual({
        success: false,
        error: 'The model on this Mac is not running. Start it first.',
        errorCode: 'OPERATION_FAILED',
      });
      expect(session.setCustomModel).not.toHaveBeenCalled();
    });

    it('a record with the reserved id that nobody installed is an endpoint like any other', async () => {
      // No state file: this feature wrote nothing, so there is nothing of ours to guard.
      guard.real = await realService();
      const { app, session } = await setup();
      const res = await apply(app, { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' });
      expect(res.statusCode).toBe(200);
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('any other endpoint is untouched by an installed model', async () => {
      writeInstalledState();
      guard.real = await realService();
      const { app, session } = await setup();
      const res = await apply(app, { endpointId: 'ep1', modelId: 'qwen3' });
      expect(res.statusCode).toBe(200);
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    });
  });
});

describe('POST /api/quick-start with customModel on the managed endpoint', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;

  const quickStart = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/quick-start', payload });

  beforeEach(async () => {
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'restartCli').mockResolvedValue(true);
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    ctx = createMockRouteContext();
    registerSessionRoutes(app, ctx);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    safeRmHomeTree(CASES_DIR);
  });

  it('asks the install service, and with no refusal the session starts on the local model', async () => {
    const before = ctx.sessions.size;
    const res = await quickStart({
      caseName: 'lm-ok',
      mode: 'claude',
      customModel: { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionId).toBeTruthy();
    expect(guard.launchRefusalMessage).toHaveBeenCalledWith('local-ollama', 'qwen3.6:35b-a3b');
    expect(ctx.sessions.size).toBe(before + 1);
    const session = ctx.sessions.get(res.json().sessionId) as unknown as Session;
    expect(session.customModel).toMatchObject({ endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' });
  });

  it('a changed model refuses the launch in one plain sentence, and no session is created', async () => {
    guard.launchRefusalMessage.mockResolvedValue(CHANGED);
    const before = ctx.sessions.size;
    const res = await quickStart({
      caseName: 'lm-changed',
      mode: 'claude',
      customModel: { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' },
    });
    expect(res.json()).toEqual({ success: false, error: CHANGED, errorCode: 'OPERATION_FAILED' });
    expect(ctx.sessions.size).toBe(before);
    expect(Session.prototype.startInteractive).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a launch without a custom model never asks', async () => {
    const res = await quickStart({ caseName: 'lm-plain', mode: 'claude' });
    expect(res.statusCode).toBe(200);
    expect(guard.launchRefusalMessage).not.toHaveBeenCalled();
  });

  describe('with the real install service', () => {
    it('an installed model whose runtime is not running is not launched', async () => {
      writeInstalledState();
      guard.real = await realService();
      const before = ctx.sessions.size;
      const res = await quickStart({
        caseName: 'lm-stopped',
        mode: 'claude',
        customModel: { endpointId: 'local-ollama', modelId: 'qwen3.6:35b-a3b' },
      });
      expect(res.json()).toEqual({
        success: false,
        error: 'The model on this Mac is not running. Start it first.',
        errorCode: 'OPERATION_FAILED',
      });
      expect(ctx.sessions.size).toBe(before);
    });

    it('a launch on any other endpoint goes on as before', async () => {
      writeInstalledState();
      guard.real = await realService();
      const res = await quickStart({
        caseName: 'lm-other',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessionId).toBeTruthy();
      expect(res.json().success).not.toBe(false);
    });
  });
});
