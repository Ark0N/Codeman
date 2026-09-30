/**
 * @fileoverview Tests for POST /api/sessions/:id/custom-model (docs/custom-model-endpoints-plan.md
 * chunk 5 — applying/clearing a session's custom model endpoint + CLI restart).
 * Port: N/A (app.inject, no real port needed)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerSessionRoutes, _clampEnvOverridesForOwner } from '../../src/web/routes/session-routes.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';
import { getDataDir } from '../../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { webviewFetch } from '../../src/web/webview-egress.js';

// Every apply now also checks llama-swap's `GET /running` (session-routes.ts) before
// applying — without this mock every test in this file would make a REAL network request
// to the fake 192.168.1.50 endpoint below and wait out its 5s timeout. Defaults to a plain
// 404 (reads as "not llama-swap", exercising none of the new conflict-check tests below),
// overridden per-test where the llama-swap behavior itself is what's under test.
vi.mock('../../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/web/webview-egress.js')>(
    '../../src/web/webview-egress.js'
  );
  return { ...actual, webviewFetch: vi.fn() };
});
const fetchMock = vi.mocked(webviewFetch);

const CLAUDE_ENDPOINT: CustomModelHost = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'k',
};

async function setup(ctxOptions?: Parameters<typeof createRouteTestHarness>[1]) {
  await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT]);
  return createRouteTestHarness(registerSessionRoutes, ctxOptions);
}

describe('POST /api/sessions/:id/custom-model', () => {
  /** Shared by the conflict-check block and the context-floor block below, which needs
   *  both conditions true at once. Scoped to the outer describe on purpose: while it
   *  lived inside the conflict-check block, a sibling calling it threw a ReferenceError
   *  during setup, so those tests reported as failing rather than as not written. */
  function mockRunning(running: Array<{ model: string; state: string }>) {
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/running') return new Response(JSON.stringify({ running }), { status: 200 });
      throw new Error(`unexpected request in this test: ${url.href}`);
    });
  }

  beforeEach(async () => {
    await writeCustomModelHosts(getDataDir(), []);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
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
      'CLAUDE_CONFIG_DIR',
    ]);
    expect(envOverrides.ANTHROPIC_BASE_URL).toBe('http://192.168.1.50:8080');
    expect(envOverrides.ANTHROPIC_API_KEY).toBe('k');

    // CLAUDE_CONFIG_DIR isolates this session from a stored claude.ai OAuth login, and the
    // trust-dialog file it points at is pre-seeded so the injected key doesn't hit an
    // interactive "Detected a custom API key" prompt with nobody there to answer it.
    const isolatedDir = join(getDataDir(), 'custom-model-configs', 'test-session-1');
    expect(envOverrides.CLAUDE_CONFIG_DIR).toBe(isolatedDir);
    expect(next.configDir).toBe(isolatedDir);
    const trustFile = JSON.parse(readFileSync(join(isolatedDir, '.claude.json'), 'utf8'));
    expect(trustFile.customApiKeyResponses.approved).toEqual(['k']);
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

  it('refuses a remote (SSH) session before touching it: restartCli would only reattach the remote tmux', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';
    session.remote = { hostId: 'h1', remotePath: '/srv/case' };

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    expect(res.json().error).toMatch(/remote/i);
    expect(session.setCustomModel).not.toHaveBeenCalled();
    expect(session.restartCli).not.toHaveBeenCalled();
  });

  it('refuses a Docker session the same way, for clear as well as apply', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';
    session.docker = { containerName: 'codeman-case' };

    for (const payload of [{ endpointId: 'ep1', modelId: 'qwen3' }, { clear: true }]) {
      const res = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/custom-model', payload });
      expect(res.json().success).toBe(false);
      expect(res.json().errorCode).toBe('INVALID_INPUT');
    }
    expect(session.setCustomModel).not.toHaveBeenCalled();
    expect(session.restartCli).not.toHaveBeenCalled();
  });

  it('pi: writes the config dir AND forces --model custom/<id>, since the file alone does not select the model', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'pi';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3.5-0.8b' },
    });

    expect(res.statusCode).toBe(200);
    const [next, envOverrides] = session.setCustomModel.mock.calls[0];
    expect(next.launchModel).toBe('custom/qwen3.5-0.8b');
    expect(next.configDir).toBe(join(getDataDir(), 'custom-model-configs', 'test-session-1'));
    expect(envOverrides.HOME).toBe(next.configDir);
    const written = join(next.configDir, '.pi', 'agent', 'models.json');
    expect(existsSync(written)).toBe(true);
    // pi embeds the key literally, so the file is private to the server account.
    expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(session.restartCli).toHaveBeenCalledTimes(1);
  });

  it('refuses a model id the CLI cannot carry on its command line instead of launching without it', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'pi';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen 3 with spaces' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    expect(session.setCustomModel).not.toHaveBeenCalled();
    expect(session.restartCli).not.toHaveBeenCalled();
    // The config dir written before the check is cleaned up again.
    expect(existsSync(join(getDataDir(), 'custom-model-configs', 'test-session-1'))).toBe(false);
  });

  it('clear removes the previous config dir the session reports', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'pi';
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });
    const dir = join(getDataDir(), 'custom-model-configs', 'test-session-1');
    expect(existsSync(dir)).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { clear: true },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  describe('llama-swap conflict check (llama.cpp runs one model at a time)', () => {
    it('applies straight away when the requested model is already loaded', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
      mockRunning([{ model: 'qwen3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().success).not.toBe(false);
      expect(res.json().modelSwapInProgress).toBe(false);
      expect(ctx.sessions.get('test-session-1')!.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('applies straight away when a swap is needed but nothing else is using the loaded model, flagging modelSwapInProgress', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().success).not.toBe(false);
      expect(res.json().modelSwapInProgress).toBe(true);
      expect(ctx.sessions.get('test-session-1')!.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('asks for confirmation instead of applying when another session is actively using the currently loaded model', async () => {
      const { app, ctx } = await setup();
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';
      const other = createMockSession('other-session');
      other.name = 'w2-otherbox';
      other.customModel = { endpointId: 'ep1', modelId: 'llama3' };
      ctx.sessions.set('other-session', other);
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      const body = res.json();
      expect(body.success).not.toBe(false);
      expect(body.requiresConfirmation).toBe(true);
      expect(body.currentlyLoadedModel).toBe('llama3');
      expect(body.affectedSessions).toEqual([{ id: 'other-session', name: 'w2-otherbox' }]);
      // Nothing actually applied yet — this call only asked, it did not switch.
      expect(session.setCustomModel).not.toHaveBeenCalled();
      expect(session.restartCli).not.toHaveBeenCalled();
    });

    describe('multi-user: the confirm dialog must not name a session the caller cannot access', () => {
      const saved: Record<string, string | undefined> = {};

      beforeEach(() => {
        saved.CODEMAN_MULTIUSER = process.env.CODEMAN_MULTIUSER;
        process.env.CODEMAN_MULTIUSER = '1';
      });

      afterEach(() => {
        if (saved.CODEMAN_MULTIUSER === undefined) delete process.env.CODEMAN_MULTIUSER;
        else process.env.CODEMAN_MULTIUSER = saved.CODEMAN_MULTIUSER;
      });

      it("still blocks the swap pending confirmation, but omits a foreign owner's session from affectedSessions", async () => {
        const { app, ctx } = await setup({ authUser: { username: 'bob', role: 'user' } });
        const session = ctx.sessions.get('test-session-1')!;
        session.mode = 'claude';
        (session as unknown as { owner?: string }).owner = 'bob';
        const other = createMockSession('other-session');
        other.name = 'w2-otherbox';
        other.customModel = { endpointId: 'ep1', modelId: 'llama3' };
        (other as unknown as { owner?: string }).owner = 'alice';
        ctx.sessions.set('other-session', other);
        mockRunning([{ model: 'llama3', state: 'ready' }]);

        const res = await app.inject({
          method: 'POST',
          url: '/api/sessions/test-session-1/custom-model',
          payload: { endpointId: 'ep1', modelId: 'qwen3' },
        });

        const body = res.json();
        // Still asks — a foreign session is just as real a disruption as an owned one.
        expect(body.requiresConfirmation).toBe(true);
        expect(body.currentlyLoadedModel).toBe('llama3');
        // But bob never learns alice's session id or name.
        expect(body.affectedSessions).toEqual([]);
        expect(session.setCustomModel).not.toHaveBeenCalled();
      });

      it('names the affected session when the caller DOES own it', async () => {
        const { app, ctx } = await setup({ authUser: { username: 'bob', role: 'user' } });
        const session = ctx.sessions.get('test-session-1')!;
        session.mode = 'claude';
        (session as unknown as { owner?: string }).owner = 'bob';
        const other = createMockSession('other-session');
        other.name = 'w2-otherbox';
        other.customModel = { endpointId: 'ep1', modelId: 'llama3' };
        (other as unknown as { owner?: string }).owner = 'bob';
        ctx.sessions.set('other-session', other);
        mockRunning([{ model: 'llama3', state: 'ready' }]);

        const res = await app.inject({
          method: 'POST',
          url: '/api/sessions/test-session-1/custom-model',
          payload: { endpointId: 'ep1', modelId: 'qwen3' },
        });

        expect(res.json().affectedSessions).toEqual([{ id: 'other-session', name: 'w2-otherbox' }]);
      });
    });

    it('applies once confirmed, skipping the conflict check the second time', async () => {
      const { app, ctx } = await setup();
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';
      const other = createMockSession('other-session');
      other.customModel = { endpointId: 'ep1', modelId: 'llama3' };
      ctx.sessions.set('other-session', other);
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3', confirmed: true },
      });

      const body = res.json();
      expect(body.requiresConfirmation).toBeUndefined();
      expect(body.modelSwapInProgress).toBe(true);
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
      expect(session.restartCli).toHaveBeenCalledTimes(1);
    });

    it('a session pointed at the SAME endpoint but a DIFFERENT (not-currently-loaded) model is not treated as affected', async () => {
      const { app, ctx } = await setup();
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';
      const other = createMockSession('other-session');
      other.customModel = { endpointId: 'ep1', modelId: 'some-other-model' }; // not the loaded one
      ctx.sessions.set('other-session', other);
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().requiresConfirmation).toBeUndefined();
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('not llama-swap (plain llama.cpp/OpenAI-compatible server, no /running) — never checked, applies straight away', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
      fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().modelSwapInProgress).toBe(false);
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

    it('warns instead of applying when the discovered context is below the safe floor', async () => {
      const { app, ctx } = await setup();
      await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT, SMALL_CTX_ENDPOINT]);
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl' },
      });

      const body = res.json();
      expect(body.success).not.toBe(false);
      expect(body.requiresContextWarning).toBe(true);
      expect(body.modelId).toBe('qwen3.8-27b-ud-q4_k_xl');
      expect(body.contextLength).toBe(16384);
      expect(body.minSafeContextTokens).toBe(40000);
      // Nothing actually applied yet — this call only warned, it did not switch.
      expect(session.setCustomModel).not.toHaveBeenCalled();
      expect(session.restartCli).not.toHaveBeenCalled();
    });

    // llama-server splits its context across --parallel slots, and Claude Code sends several
    // requests at once, so a context that clears the floor as a whole can still fail per slot.
    describe('parallel slots share the context', () => {
      const slotEndpoint = (contextLength: number, slots?: number, serverContext?: number): CustomModelHost => ({
        id: 'ep-slots',
        label: 'multi-slot box',
        baseUrl: 'http://192.168.1.52:8080',
        apiKey: 'k',
        modelContextLengths: { m: contextLength },
        ...(slots === undefined ? {} : { modelSlotCounts: { m: slots } }),
        ...(serverContext === undefined ? {} : { modelServerContexts: { m: serverContext } }),
      });

      async function apply(endpoint: CustomModelHost) {
        const { app, ctx } = await setup();
        await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT, endpoint]);
        const session = ctx.sessions.get('test-session-1')!;
        session.mode = 'claude';
        const res = await app.inject({
          method: 'POST',
          url: '/api/sessions/test-session-1/custom-model',
          payload: { endpointId: endpoint.id, modelId: 'm' },
        });
        return { body: res.json(), session };
      }

      it('warns when the context divided across the slots is below the floor, and reports the slot count', async () => {
        // the measured case: ~131k shared by 4 slots is ~33k each, under the 40k a request needs
        const { body, session } = await apply(slotEndpoint(131072, 4));

        expect(body.requiresContextWarning).toBe(true);
        expect(body.contextLength).toBe(131072);
        expect(body.slotCount).toBe(4);
        expect(body.poolContext).toBe(131072);
        expect(session.setCustomModel).not.toHaveBeenCalled();
      });

      it('divides the server-reported context, not the --fit-ctx floor, across the slots', async () => {
        // a floor of 65,536 over 4 slots would be 16,384, but the server really has 262,144 (65,536 each)
        const roomy = await apply(slotEndpoint(65536, 4, 262144));
        expect(roomy.body.requiresContextWarning).toBeUndefined();
        expect(roomy.session.setCustomModel).toHaveBeenCalledTimes(1);
      });

      it('warns with the server-reported pool when that is still too small per slot', async () => {
        const { body } = await apply(slotEndpoint(65536, 4, 131072));

        expect(body.requiresContextWarning).toBe(true);
        expect(body.contextLength).toBe(65536);
        expect(body.poolContext).toBe(131072);
        expect(body.slotCount).toBe(4);
      });

      it('does not warn once every slot can hold the floor', async () => {
        const { body, session } = await apply(slotEndpoint(262144, 4)); // 65,536 each

        expect(body.requiresContextWarning).toBeUndefined();
        expect(session.setCustomModel).toHaveBeenCalledTimes(1);
      });

      it('does not warn for a single slot with the same context that failed across four', async () => {
        const { body, session } = await apply(slotEndpoint(131072, 1));

        expect(body.requiresContextWarning).toBeUndefined();
        expect(session.setCustomModel).toHaveBeenCalledTimes(1);
      });

      it('an unknown slot count is treated as one slot, never guessed', async () => {
        const { body } = await apply(slotEndpoint(131072));

        expect(body.requiresContextWarning).toBeUndefined();
      });

      it('omits slotCount from the warning when the context is too small on its own with a single slot', async () => {
        const { body } = await apply(slotEndpoint(16384, 1));

        expect(body.requiresContextWarning).toBe(true);
        expect(body.slotCount).toBeUndefined();
      });
    });

    it('applies once confirmed, skipping the context check the second time', async () => {
      const { app, ctx } = await setup();
      await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT, SMALL_CTX_ENDPOINT]);
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl', confirmed: true },
      });

      const body = res.json();
      expect(body.requiresContextWarning).toBeUndefined();
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
      expect(session.restartCli).toHaveBeenCalledTimes(1);
    });

    // The two questions are about DIFFERENT people: a context window below the floor is
    // the caller's own problem, while unloading a model takes it away from someone else's
    // session. They shared one `confirmed` flag until this release, and because the
    // context check runs first, clicking "launch anyway" past the context warning silently
    // answered the swap question too and evicted another session's model unasked.
    describe('answering one question is not consent to the other', () => {
      async function bothConditions() {
        const { app, ctx } = await setup();
        await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT, SMALL_CTX_ENDPOINT]);
        const session = ctx.sessions.get('test-session-1')!;
        session.mode = 'claude';
        // another session is actively on the model this endpoint currently has loaded
        const other = createMockSession('other-session');
        other.name = 'w2-otherbox';
        other.customModel = { endpointId: 'ep-small', modelId: 'llama3' };
        ctx.sessions.set('other-session', other);
        mockRunning([{ model: 'llama3', state: 'ready' }]);
        return { app, session };
      }

      it('still asks about the swap after the context warning was confirmed', async () => {
        const { app, session } = await bothConditions();

        const res = await app.inject({
          method: 'POST',
          url: '/api/sessions/test-session-1/custom-model',
          payload: {
            endpointId: 'ep-small',
            modelId: 'qwen3.8-27b-ud-q4_k_xl',
            confirmedContext: true,
          },
        });

        const body = res.json();
        expect(body.requiresContextWarning).toBeUndefined();
        expect(body.requiresConfirmation).toBe(true);
        expect(body.currentlyLoadedModel).toBe('llama3');
        // and crucially nothing was applied: the other session keeps its model
        expect(session.setCustomModel).not.toHaveBeenCalled();
        expect(session.restartCli).not.toHaveBeenCalled();
      });

      it('applies once BOTH questions are answered', async () => {
        const { app, session } = await bothConditions();

        const res = await app.inject({
          method: 'POST',
          url: '/api/sessions/test-session-1/custom-model',
          payload: {
            endpointId: 'ep-small',
            modelId: 'qwen3.8-27b-ud-q4_k_xl',
            confirmedContext: true,
            confirmedSwap: true,
          },
        });

        const body = res.json();
        expect(body.requiresContextWarning).toBeUndefined();
        expect(body.requiresConfirmation).toBeUndefined();
        expect(session.setCustomModel).toHaveBeenCalledTimes(1);
      });

      it('confirmedSwap alone does not silence the context warning either', async () => {
        const { app, session } = await bothConditions();

        const res = await app.inject({
          method: 'POST',
          url: '/api/sessions/test-session-1/custom-model',
          payload: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl', confirmedSwap: true },
        });

        expect(res.json().requiresContextWarning).toBe(true);
        expect(session.setCustomModel).not.toHaveBeenCalled();
      });

      // `confirmed` shipped in the HTTP-API-only cut of this feature, so a caller written
      // against that must keep working: it means both, exactly as it used to.
      it('keeps the legacy blanket `confirmed` meaning both', async () => {
        const { app, session } = await bothConditions();

        const res = await app.inject({
          method: 'POST',
          url: '/api/sessions/test-session-1/custom-model',
          payload: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl', confirmed: true },
        });

        const body = res.json();
        expect(body.requiresContextWarning).toBeUndefined();
        expect(body.requiresConfirmation).toBeUndefined();
        expect(session.setCustomModel).toHaveBeenCalledTimes(1);
      });
    });

    it('does not warn when the discovered context is comfortably above the floor', async () => {
      const { app, ctx } = await setup();
      const roomyEndpoint: CustomModelHost = {
        id: 'ep-roomy',
        label: 'roomy box',
        baseUrl: 'http://192.168.1.52:8080',
        apiKey: 'k',
        modelContextLengths: { qwen3: 65536 },
      };
      await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT, roomyEndpoint]);
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep-roomy', modelId: 'qwen3' },
      });

      expect(res.json().requiresContextWarning).toBeUndefined();
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('does not warn when the context length was never discovered (nothing to compare)', async () => {
      const { app, ctx } = await setup();
      await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT]);
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().requiresContextWarning).toBeUndefined();
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('does not warn for a CLI whose registry entry declares no contextLengthVar (opencode)', async () => {
      // opencode's customModelInjection kind is configContentEnv, not env+contextLengthVar,
      // so exceedsSafeContextFloor is false by construction regardless of context size.
      const { app, ctx } = await setup();
      await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT, SMALL_CTX_ENDPOINT]);
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'opencode';

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep-small', modelId: 'qwen3.8-27b-ud-q4_k_xl' },
      });

      expect(res.json().requiresContextWarning).toBeUndefined();
    });
  });

  describe('triggering the actual llama-swap load (not just watching for it)', () => {
    it('sends a real inference request naming the target model when it is not already loaded and ready', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
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

      await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the fire-and-forget trigger settle

      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]).toMatchObject({ model: 'qwen3', max_tokens: 1 });
    });

    it('never sends a load-trigger request when the target model is already loaded and ready', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
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

      await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(chatCalled).toBe(false);
    });

    it('never sends a load-trigger request while confirmation is still pending', async () => {
      const { app, ctx } = await setup();
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';
      const other = createMockSession('other-session');
      other.customModel = { endpointId: 'ep1', modelId: 'llama3' };
      ctx.sessions.set('other-session', other);
      let chatCalled = false;
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname === '/running') {
          return new Response(JSON.stringify({ running: [{ model: 'llama3', state: 'ready' }] }), { status: 200 });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatCalled = true;
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error(`unexpected request in this test: ${url.href}`);
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.json().requiresConfirmation).toBe(true);
      expect(chatCalled).toBe(false);
    });
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

describe('Claude multi-user clamp: the env-var half', () => {
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS and CLAUDE_CONFIG_DIR were already reachable via
  // plain envOverrides before claude's privilegedEnvKeys existed (the first already
  // matches the CLAUDE_CODE_* allowedPrefix, the second is an allowed exact key), so
  // listing them here is not what makes this route safe — no custom-model route reads
  // privilegedEnvKeys at all. What it DOES do: ownerClampedEnvKeys() feeds the generic
  // envOverrides clamp on create/quick-start/reboot-restore, so a non-granted owner can
  // no longer set CLAUDE_CONFIG_DIR that way (the per-client-account feature, #255), and
  // a PERSISTED one is now stripped on reboot-restore for such an owner too — see
  // session-env-clamp.ts's own fileoverview for why that pass used to be a no-op for
  // claude specifically.
  const ORIGINAL = process.env.CODEMAN_MULTIUSER;
  beforeEach(() => {
    process.env.CODEMAN_MULTIUSER = '1';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = ORIGINAL;
  });

  it('strips CLAUDE_CONFIG_DIR and CLAUDE_CODE_MAX_CONTEXT_TOKENS for a non-granted owner, leaving unrelated CLAUDE_CODE_* keys alone', async () => {
    const out = await _clampEnvOverridesForOwner('nobody', {
      CLAUDE_CONFIG_DIR: '/home/attacker/fake-claude-config',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999999',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });
    expect(out).toEqual({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' });
  });

  it('is a no-op in single-user mode', async () => {
    delete process.env.CODEMAN_MULTIUSER;
    const input = { CLAUDE_CONFIG_DIR: '/home/attacker/fake-claude-config' };
    expect(await _clampEnvOverridesForOwner(undefined, input)).toBe(input);
  });
});
