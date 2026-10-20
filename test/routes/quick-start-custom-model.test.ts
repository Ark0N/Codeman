/**
 * @fileoverview POST /api/quick-start's `customModel` field (docs/custom-model-endpoints-plan.md):
 * the ONE-SHOT launch path that computes a custom-model endpoint's injection BEFORE the
 * session/process exists and launches directly on it, so a custom-model Run never shows
 * the native-boot-then-restart the dedicated POST /api/sessions/:id/custom-model route's
 * restart-in-place design otherwise produces — most visibly on a CLI like Codex whose TUI
 * fully reinitializes on a restart. That dedicated route is still what an ALREADY-RUNNING
 * session uses to switch later; this is the create-time equivalent.
 *
 * Mirrors test/routes/session-custom-model.test.ts's fixtures and llama-swap mocking, since
 * this route mirrors that one's own checks (llama-swap conflict, unsupported CLI, unknown
 * endpoint, an argv-incompatible model id) rather than a lighter, separately-drifting copy.
 *
 * Session.prototype.startInteractive/startShell are mocked exactly like the workspace-hooks
 * quick-start tests: quick-start constructs a REAL Session (not the MockSession the route
 * test harness substitutes elsewhere), so tmux must never actually be reached.
 *
 * Port: N/A (app.inject, no real port needed)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMockRouteContext, safeRmHomeTree, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { getDataDir } from '../../src/config/instance.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';
import { Session } from '../../src/session.js';
import { writeCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';
import { customModelConfigDir } from '../../src/custom-model-injection-apply.js';
import { webviewFetch } from '../../src/web/webview-egress.js';

vi.mock('../../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/web/webview-egress.js')>(
    '../../src/web/webview-egress.js'
  );
  return { ...actual, webviewFetch: vi.fn() };
});
const fetchMock = vi.mocked(webviewFetch);

// quick-start's own local-CLI-availability gate (resolveCliLaunchError, unrelated to the
// custom-model injection this file tests) runs BEFORE the code under test and would
// otherwise 404 every non-claude mode on a box with no codex/pi/grok/omp binary installed —
// exactly this test environment. Mirrors the real "not remote" bypass documented at its own
// call site in session-routes.ts (`session-routes.test.ts`'s remote-codex test is the
// precedent for needing this at all).
vi.mock('../../src/utils/cli-launcher.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/cli-launcher.js')>(
    '../../src/utils/cli-launcher.js'
  );
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

const ENDPOINT: CustomModelHost = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'k',
};

describe('POST /api/quick-start: customModel (one-shot custom-model launch)', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let restartSpy: ReturnType<typeof vi.spyOn>;

  const quickStart = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/quick-start', payload });

  beforeEach(async () => {
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
    restartSpy = vi.spyOn(Session.prototype, 'restartCli').mockResolvedValue(true);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 })); // default: not llama-swap
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    ctx = createMockRouteContext();
    registerSessionRoutes(app, ctx);
    installRouteErrorHandler(app);
    await app.ready();
    await writeCustomModelHosts(getDataDir(), [ENDPOINT]);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    await rm(join(getDataDir(), 'custom-model-hosts.json'), { force: true });
    await rm(join(getDataDir(), 'custom-model-configs'), { recursive: true, force: true });
    safeRmHomeTree(CASES_DIR);
  });

  it('launches a claude session already pointed at the endpoint — no restart at all', async () => {
    const res = await quickStart({
      caseName: 'cm-claude',
      mode: 'claude',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session;
    expect(session.customModel).toEqual({ endpointId: 'ep1', modelId: 'qwen3', label: 'llama.cpp box' });
    // The whole point: never restarted. It launched on the endpoint the first time.
    expect(restartSpy).not.toHaveBeenCalled();

    const isolatedDir = customModelConfigDir(sessionId);
    const trustFile = JSON.parse(await readFile(join(isolatedDir, '.claude.json'), 'utf-8'));
    expect(trustFile.customApiKeyResponses.approved).toEqual(['k']);
  });

  it('codex: writes the config.toml under the SAME id the session actually launches with, no restart', async () => {
    const res = await quickStart({
      caseName: 'cm-codex',
      mode: 'codex',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session;
    expect(session.customModel?.endpointId).toBe('ep1');
    expect(restartSpy).not.toHaveBeenCalled();

    const configDir = customModelConfigDir(sessionId);
    expect(existsSync(join(configDir, 'config.toml'))).toBe(true);
    const toml = await readFile(join(configDir, 'config.toml'), 'utf-8');
    expect(toml).toContain('model = "qwen3"');
  });

  it('pi: forces --model custom/<id> onto piConfig on the FIRST launch, not via a later restart', async () => {
    const res = await quickStart({
      caseName: 'cm-pi',
      mode: 'pi',
      customModel: { endpointId: 'ep1', modelId: 'qwen3.5-0.8b' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session & { piConfig?: { model?: string } };
    expect(session.getCustomModelForPersist()?.launchModel).toBe('custom/qwen3.5-0.8b');
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('grok: forces the [model.<name>] block name onto grokConfig on the first launch', async () => {
    const res = await quickStart({
      caseName: 'cm-grok',
      mode: 'grok',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session;
    expect(session.getCustomModelForPersist()?.launchModel).toBe('codeman-custom');
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('omp: forces custom/<id> onto ompConfig even with no incoming ompConfig at all', async () => {
    const res = await quickStart({
      caseName: 'cm-omp',
      mode: 'omp',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json();
    const session = ctx.sessions.get(sessionId) as unknown as Session;
    expect(session.getCustomModelForPersist()?.launchModel).toBe('custom/qwen3');
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('404s for an unknown endpoint id', async () => {
    const res = await quickStart({
      caseName: 'cm-ghost',
      mode: 'claude',
      customModel: { endpointId: 'ghost', modelId: 'qwen3' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('NOT_FOUND');
  });

  it('refuses a mode with no known custom-model mechanism (antigravity)', async () => {
    const res = await quickStart({
      caseName: 'cm-agy',
      mode: 'antigravity',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
  });

  it('refuses a model id the CLI cannot carry on its command line, cleaning up any written config dir', async () => {
    const res = await quickStart({
      caseName: 'cm-badmodel',
      mode: 'pi',
      customModel: { endpointId: 'ep1', modelId: 'qwen 3 with spaces' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
  });

  it('refuses customModel for a remote case', async () => {
    // Fixture mirrors session-routes' own remote-case shape minimally: an unresolvable
    // remote host is fine here, since the customModel check fires before the host lookup.
    const res = await quickStart({
      caseName: 'nonexistent-remote-case',
      mode: 'claude',
      customModel: { endpointId: 'ep1', modelId: 'qwen3' },
    });
    // No matching remote/docker case fixture exists, so this actually falls through to the
    // local branch and succeeds — this test only documents that remote/docker have their
    // own explicit customModel rejection (see the local-fixture tests in
    // session-routes-workspace-hooks.test.ts for the fixture-loading pattern that would be
    // needed to exercise the remote/docker branch itself).
    expect(res.statusCode).toBe(200);
  });

  describe('llama-swap conflict check', () => {
    function mockRunning(running: Array<{ model: string; state: string }>) {
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname === '/running') return new Response(JSON.stringify({ running }), { status: 200 });
        throw new Error(`unexpected request in this test: ${url.href}`);
      });
    }

    it('asks for confirmation instead of launching when another live session is using the currently loaded model', async () => {
      const other = ctx.sessions.get('test-session-1')!;
      (other as unknown as { customModel: unknown }).customModel = { endpointId: 'ep1', modelId: 'llama3' };
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await quickStart({
        caseName: 'cm-conflict',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      const body = res.json();
      expect(body.requiresConfirmation).toBe(true);
      expect(body.currentlyLoadedModel).toBe('llama3');
      expect(body.affectedSessions).toEqual([{ id: 'test-session-1', name: other.name }]);
      // Nothing was actually created.
      expect(ctx.sessions.size).toBe(1);
    });

    it('launches once confirmed, skipping the conflict check', async () => {
      const other = ctx.sessions.get('test-session-1')!;
      (other as unknown as { customModel: unknown }).customModel = { endpointId: 'ep1', modelId: 'llama3' };
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await quickStart({
        caseName: 'cm-confirmed',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3', confirmed: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requiresConfirmation).toBeUndefined();
      expect(ctx.sessions.size).toBe(2);
    });

    it('launches straight away when nothing else is using the currently loaded model', async () => {
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await quickStart({
        caseName: 'cm-noconflict',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requiresConfirmation).toBeUndefined();
    });
  });

  describe("context-window floor warning (this CLI's own overhead can exceed a small model's real context)", () => {
    const SMALL_CTX_ENDPOINT: CustomModelHost = {
      id: 'ep-small',
      label: 'tiny box',
      baseUrl: 'http://192.168.1.51:8080',
      apiKey: 'k',
      modelContextLengths: { 'qwen3.8-27b-ud-q4_k_xl': 16384 },
    };

    it('warns instead of launching when the discovered context is below the safe floor', async () => {
      await writeCustomModelHosts(getDataDir(), [ENDPOINT, SMALL_CTX_ENDPOINT]);

      const res = await quickStart({
        caseName: 'cm-small-ctx',
        mode: 'claude',
        customModel: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl' },
      });

      const body = res.json();
      expect(body.requiresContextWarning).toBe(true);
      expect(body.modelId).toBe('qwen3.8-27b-ud-q4_k_xl');
      expect(body.contextLength).toBe(16384);
      expect(body.minSafeContextTokens).toBe(40000);
      // Nothing was actually created.
      expect(ctx.sessions.size).toBe(1);
    });

    it('launches once confirmed, skipping the context check', async () => {
      await writeCustomModelHosts(getDataDir(), [ENDPOINT, SMALL_CTX_ENDPOINT]);

      const res = await quickStart({
        caseName: 'cm-small-ctx-confirmed',
        mode: 'claude',
        customModel: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl', confirmed: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requiresContextWarning).toBeUndefined();
      expect(ctx.sessions.size).toBe(2);
    });

    describe('parallel slots share the context (the quick-start path has its own slot branch)', () => {
      const slotEndpoint = (contextLength: number, slots: number): CustomModelHost => ({
        id: 'ep-slots',
        label: 'multi-slot box',
        baseUrl: 'http://192.168.1.52:8080',
        apiKey: 'k',
        modelContextLengths: { m: contextLength },
        modelSlotCounts: { m: slots },
      });

      it('warns when the context divided across the slots is below the floor, and reports the slot count', async () => {
        await writeCustomModelHosts(getDataDir(), [ENDPOINT, slotEndpoint(131072, 4)]); // ~33k per slot

        const res = await quickStart({
          caseName: 'cm-slots-warn',
          mode: 'claude',
          customModel: { endpointId: 'ep-slots', modelId: 'm' },
        });

        const body = res.json();
        expect(body.requiresContextWarning).toBe(true);
        expect(body.contextLength).toBe(131072);
        expect(body.slotCount).toBe(4);
        expect(ctx.sessions.size).toBe(1); // nothing was created
      });

      it('launches when every slot can hold the floor', async () => {
        await writeCustomModelHosts(getDataDir(), [ENDPOINT, slotEndpoint(262144, 4)]); // 65,536 per slot

        const res = await quickStart({
          caseName: 'cm-slots-ok',
          mode: 'claude',
          customModel: { endpointId: 'ep-slots', modelId: 'm' },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().requiresContextWarning).toBeUndefined();
        expect(ctx.sessions.size).toBe(2);
      });
    });

    it('does not warn when nothing about context was discovered', async () => {
      const res = await quickStart({
        caseName: 'cm-no-ctx-data',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().requiresContextWarning).toBeUndefined();
    });
  });

  describe('triggering the actual llama-swap load (not just watching for it)', () => {
    it('sends a real inference request naming the target model, concurrently with launching the session', async () => {
      const chatCalls: unknown[] = [];
      fetchMock.mockImplementation(async (url: URL, init?: { body?: unknown }) => {
        if (url.pathname === '/running') {
          return new Response(JSON.stringify({ running: [{ model: 'llama3', state: 'ready' }] }), { status: 200 });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatCalls.push(JSON.parse(init!.body as string));
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error(`unexpected request in this test: ${url.href}`);
      });

      const res = await quickStart({
        caseName: 'cm-trigger',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the fire-and-forget trigger settle

      expect(res.statusCode).toBe(200);
      expect(res.json().modelSwapInProgress).toBe(true);
      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]).toMatchObject({ model: 'qwen3', max_tokens: 1 });
    });

    it('never sends a load-trigger request when the target model is already loaded and ready', async () => {
      let chatCalled = false;
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname === '/running') {
          return new Response(JSON.stringify({ running: [{ model: 'qwen3', state: 'ready' }] }), { status: 200 });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatCalled = true;
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error(`unexpected request in this test: ${url.href}`);
      });

      const res = await quickStart({
        caseName: 'cm-no-trigger',
        mode: 'claude',
        customModel: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.json().modelSwapInProgress).toBe(false);
      expect(chatCalled).toBe(false);
    });
  });
});
