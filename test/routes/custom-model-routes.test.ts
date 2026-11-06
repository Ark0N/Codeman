/**
 * @fileoverview Route tests for Custom Model Endpoint Profiles CRUD + discovery.
 *
 * Discovery is mocked at `webviewFetch()` (webview-egress.ts), NOT at the global
 * `fetch`: the route deliberately goes through the guarded undici dispatcher whose
 * lookup hook refuses a name that resolves into a link-local / cloud-metadata range,
 * so a global-fetch stub that still satisfied these tests would mean the guard had
 * been bypassed.
 * Port: N/A (app.inject, no real port needed)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dataPath, getDataDir } from '../../src/config/instance.js';
import { customModelHostsPath, readCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';
import { registerCustomModelRoutes } from '../../src/web/routes/custom-model-routes.js';
import { webviewFetch } from '../../src/web/webview-egress.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

vi.mock('../../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/web/webview-egress.js')>(
    '../../src/web/webview-egress.js'
  );
  return { ...actual, webviewFetch: vi.fn() };
});

const fetchMock = vi.mocked(webviewFetch);

async function setup() {
  return createRouteTestHarness(registerCustomModelRoutes);
}

describe('custom model endpoint CRUD', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('starts empty', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/model-endpoints' });
    expect(res.json()).toEqual([]);
  });

  it('creates, lists, updates, and deletes an endpoint', async () => {
    const { app } = await setup();

    const create = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep1', label: 'llama.cpp box', baseUrl: 'http://192.168.1.50:8080' },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().data.host.id).toBe('ep1');

    const list = await app.inject({ method: 'GET', url: '/api/model-endpoints' });
    expect(list.json()).toHaveLength(1);

    const update = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/ep1',
      payload: { label: 'Renamed', baseUrl: 'http://192.168.1.50:8080' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.host.label).toBe('Renamed');

    const del = await app.inject({ method: 'DELETE', url: '/api/model-endpoints/ep1' });
    expect(del.statusCode).toBe(200);

    const listAfter = await app.inject({ method: 'GET', url: '/api/model-endpoints' });
    expect(listAfter.json()).toEqual([]);
  });

  it('rejects a duplicate id on create', async () => {
    const { app } = await setup();
    const payload = { id: 'dup', label: 'A', baseUrl: 'http://localhost:8080' };
    await app.inject({ method: 'POST', url: '/api/model-endpoints', payload });
    const second = await app.inject({ method: 'POST', url: '/api/model-endpoints', payload });
    expect(second.json().success).toBe(false);
    expect(second.json().errorCode).toBe('ALREADY_EXISTS');
  });

  it('404s updating/deleting an id that does not exist', async () => {
    const { app } = await setup();
    const update = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/ghost',
      payload: { label: 'A', baseUrl: 'http://localhost:8080' },
    });
    expect(update.json().errorCode).toBe('NOT_FOUND');
  });

  it('rejects a link-local/cloud-metadata base URL', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'meta', label: 'A', baseUrl: 'http://169.254.169.254/' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
  });

  it('discovers models via GET /v1/models and stores the result', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep1', label: 'A', baseUrl: 'http://localhost:8080', apiKey: 'k' },
    });

    fetchMock.mockImplementation(async (url: URL, init?: RequestInit) => {
      expect(url.href).toBe('http://localhost:8080/v1/models');
      const headers = init?.headers as Record<string, string>;
      // Exactly ONE auth header — never both (a real server hung when sent both).
      expect(headers.Authorization).toBe('Bearer k');
      expect(headers['api-key']).toBeUndefined();
      return new Response(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'llama3' }] }), { status: 200 });
    });

    const res = await app.inject({ method: 'POST', url: '/api/model-endpoints/ep1/discover-models' });
    expect(res.json().data.models).toEqual(['qwen3', 'llama3']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Data dir is shared across this WHOLE test file (one temp HOME per file, not per
    // test — test/setup.ts), so find by id rather than assuming index 0.
    const list = await app.inject({ method: 'GET', url: '/api/model-endpoints' });
    const stored = (list.json() as Array<{ id: string }>).find((h) => h.id === 'ep1');
    expect(stored?.models).toEqual(['qwen3', 'llama3']);
    expect(stored?.lastDiscoveredAt).toBeTruthy();
  });

  it('discovers models with authStyle "api-key" using only that header, never Authorization', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-azure', label: 'A', baseUrl: 'http://localhost:8080', apiKey: 'k', authStyle: 'api-key' },
    });

    fetchMock.mockImplementation(async (_url: URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['api-key']).toBe('k');
      expect(headers.Authorization).toBeUndefined();
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-azure/discover-models' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a clear error when the endpoint is unreachable', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-err', label: 'A', baseUrl: 'http://localhost:8080' },
    });
    // undici's shape: a bare `fetch failed` with the real reason one level down.
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8080') })
    );

    const res = await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-err/discover-models' });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
    expect(res.json().error).toContain('ECONNREFUSED');
  });

  it('names the egress refusal when the endpoint resolves into a blocked range', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-meta', label: 'A', baseUrl: 'http://models.example:8080' },
    });
    const { WebviewEgressBlockedError } = await vi.importActual<typeof import('../../src/web/webview-egress.js')>(
      '../../src/web/webview-egress.js'
    );
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new WebviewEgressBlockedError('resolves to 169.254.169.254') })
    );

    const res = await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-meta/discover-models' });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/refused.*169\.254\.169\.254/);
  });

  it('running-status never hands the browser the raw llama-swap launch command (cmd)', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-running', label: 'A', baseUrl: 'http://localhost:8080', apiKey: 'k' },
    });
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/running') {
        return new Response(
          JSON.stringify({
            running: [
              { model: 'qwen3', state: 'ready', cmd: 'llama-server -m /models/qwen3.gguf --api-key sk-secret' },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected request in this test: ${url.href}`);
    });

    const res = await app.inject({ method: 'GET', url: '/api/model-endpoints/ep-running/running-status' });
    const body = res.json();
    expect(body.data.running).toEqual([{ model: 'qwen3', state: 'ready' }]);
    expect(JSON.stringify(body)).not.toContain('sk-secret');
    expect(JSON.stringify(body)).not.toContain('cmd');
  });

  it('refuses a baseUrl with embedded credentials or a non-http scheme at save time', async () => {
    const { app } = await setup();
    for (const baseUrl of ['http://user:pw@host:8080', 'ftp://host/models', 'http://169.254.169.254']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/model-endpoints',
        payload: { id: 'bad', label: 'A', baseUrl },
      });
      expect(res.json().success, baseUrl).toBe(false);
      expect(res.json().errorCode, baseUrl).toBe('INVALID_INPUT');
    }
  });
});

describe('defaultModelId — the Run-menu picker’s per-endpoint default', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('rejects a defaultModelId that is not one of the endpoint’s discovered models, on both create and update', async () => {
    const { app } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: {
        id: 'ep-default-reject',
        label: 'A',
        baseUrl: 'http://localhost:8080',
        models: ['qwen3'],
        defaultModelId: 'ghost',
      },
    });
    expect(create.json().success).toBe(false);
    expect(create.json().errorCode).toBe('INVALID_INPUT');

    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-default-reject', label: 'A', baseUrl: 'http://localhost:8080', models: ['qwen3'] },
    });
    const update = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/ep-default-reject',
      payload: { label: 'A', baseUrl: 'http://localhost:8080', models: ['qwen3'], defaultModelId: 'ghost' },
    });
    expect(update.json().success).toBe(false);
    expect(update.json().errorCode).toBe('INVALID_INPUT');
  });

  it('accepts a defaultModelId that IS one of the discovered models', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: {
        id: 'ep-default-accept',
        label: 'A',
        baseUrl: 'http://localhost:8080',
        models: ['qwen3', 'llama3'],
        defaultModelId: 'llama3',
      },
    });
    expect(res.json().success).toBe(true);
    expect(res.json().data.host.defaultModelId).toBe('llama3');
  });

  it('drops a stale default that no longer appears in a fresh discovery, rather than carrying it forward invalid', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: {
        id: 'ep-default-drop',
        label: 'A',
        baseUrl: 'http://localhost:8080',
        models: ['qwen3'],
        defaultModelId: 'qwen3',
      },
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'llama3' }] }), { status: 200 }));
    await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-default-drop/discover-models' });

    const list = await app.inject({ method: 'GET', url: '/api/model-endpoints' });
    const stored = (list.json() as Array<{ id: string; defaultModelId?: string }>).find(
      (h) => h.id === 'ep-default-drop'
    );
    expect(stored?.defaultModelId).toBeUndefined();
  });

  it('keeps a default that IS still present after a fresh discovery', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: {
        id: 'ep-default-keep',
        label: 'A',
        baseUrl: 'http://localhost:8080',
        models: ['qwen3'],
        defaultModelId: 'qwen3',
      },
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'llama3' }] }), { status: 200 })
    );
    await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-default-keep/discover-models' });

    const list = await app.inject({ method: 'GET', url: '/api/model-endpoints' });
    const stored = (list.json() as Array<{ id: string; defaultModelId?: string }>).find(
      (h) => h.id === 'ep-default-keep'
    );
    expect(stored?.defaultModelId).toBe('qwen3');
  });
});

describe('apiKey is never handed back to the browser', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('POST, GET and PUT responses all carry apiKeySet instead of the real key', async () => {
    const { app } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-secret', label: 'A', baseUrl: 'http://localhost:8080', apiKey: 'super-secret' },
    });
    expect(create.json().data.host.apiKey).toBeUndefined();
    expect(create.json().data.host.apiKeySet).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/model-endpoints' });
    const listed = (list.json() as Array<{ id: string; apiKey?: string; apiKeySet?: boolean }>).find(
      (h) => h.id === 'ep-secret'
    );
    expect(listed?.apiKey).toBeUndefined();
    expect(listed?.apiKeySet).toBe(true);
    expect(JSON.stringify(list.json())).not.toContain('super-secret');

    const update = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/ep-secret',
      payload: { label: 'Renamed', baseUrl: 'http://localhost:8080' },
    });
    expect(update.json().data.host.apiKey).toBeUndefined();
    expect(update.json().data.host.apiKeySet).toBe(true);
    expect(JSON.stringify(update.json())).not.toContain('super-secret');
  });

  it('a host with no key set at all reports apiKeySet: false', async () => {
    const { app } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-nokey', label: 'A', baseUrl: 'http://localhost:8080' },
    });
    expect(create.json().data.host.apiKeySet).toBe(false);
  });

  it('PUT with no apiKey keeps the stored one, rather than clearing it', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-keep-key', label: 'A', baseUrl: 'http://localhost:8080', apiKey: 'original-key' },
    });
    // Edit without touching the API key field — the real bug this guards: a
    // browser round-trip that only ever sees apiKeySet, never the real value,
    // must not accidentally send an empty string and wipe a working credential.
    const update = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/ep-keep-key',
      payload: { label: 'Renamed', baseUrl: 'http://localhost:8080' },
    });
    expect(update.json().data.host.apiKeySet).toBe(true);

    // Prove it by observing the auth header discovery actually sends.
    fetchMock.mockImplementation(async (_url: URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer original-key');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const discover = await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-keep-key/discover-models' });
    expect(discover.json().success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('PUT with a new apiKey replaces the stored one', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-replace-key', label: 'A', baseUrl: 'http://localhost:8080', apiKey: 'old-key' },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/ep-replace-key',
      payload: { label: 'A', baseUrl: 'http://localhost:8080', apiKey: 'new-key' },
    });

    fetchMock.mockImplementation(async (_url: URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer new-key');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-replace-key/discover-models' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('context-length discovery from the /v1/models listing', () => {
  // The gateway path (a Bifrost in front of llama-swap, an OpenRouter-style server):
  // no /running, no /props, just a per-model `context_length` or `context_window` in the
  // model listing. Distinct ports per test keep the file's shared data dir unambiguous.
  afterEach(() => {
    fetchMock.mockReset();
  });

  type StoredHost = { id: string; modelContextLengths?: Record<string, number>; defaultContextLength?: number };

  type HarnessApp = RouteTestHarness['app'];

  async function endpointWith(id: string, port: number, extra: Record<string, unknown> = {}): Promise<HarnessApp> {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id, label: 'A', baseUrl: `http://localhost:${port}`, ...extra },
    });
    expect(res.statusCode).toBe(200);
    return app;
  }

  async function storedHost(app: HarnessApp, id: string): Promise<StoredHost | undefined> {
    const list = await app.inject({ method: 'GET', url: '/api/model-endpoints' });
    return (list.json() as StoredHost[]).find((h) => h.id === id);
  }

  it('reads context_length (preferred) then context_window from each entry into modelContextLengths', async () => {
    const app = await endpointWith('ep-ctx-listed', 8101);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'both', context_length: 131072, context_window: 32768 },
            { id: 'window-only', context_window: 8192 },
            { id: 'no-figure' },
          ],
        }),
        { status: 200 }
      )
    );

    const discover = await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-ctx-listed/discover-models' });
    expect(discover.json().success).toBe(true);

    const stored = await storedHost(app, 'ep-ctx-listed');
    expect(stored?.modelContextLengths).toEqual({ both: 131072, 'window-only': 8192 });
  });

  it('ignores non-numeric, zero, negative and absurd listed values; the schema bound itself is still accepted', async () => {
    const app = await endpointWith('ep-ctx-bad', 8102);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'string', context_length: '131072' },
            { id: 'zero', context_window: 0 },
            { id: 'negative', context_length: -10 },
            { id: 'over-bound', context_length: 100_000_001 },
            { id: 'fractional', context_window: 16384.5 },
            { id: 'at-bound', context_length: 100_000_000 },
          ],
        }),
        { status: 200 }
      )
    );

    await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-ctx-bad/discover-models' });

    const stored = await storedHost(app, 'ep-ctx-bad');
    expect(stored?.modelContextLengths).toEqual({ 'at-bound': 100_000_000 });
  });

  it('prefers the /running launch command over the listed figure for a loaded model', async () => {
    const app = await endpointWith('ep-ctx-cmd', 8103);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(
          JSON.stringify({ data: [{ id: 'cmd-wins', status: { value: 'loaded' }, context_length: 131072 }] }),
          { status: 200 }
        );
      }
      if (url.pathname === '/running') {
        return new Response(
          JSON.stringify({ running: [{ model: 'cmd-wins', state: 'ready', cmd: 'llama-server --ctx-size 16384' }] }),
          { status: 200 }
        );
      }
      if (url.pathname === '/props') return new Response('nope', { status: 404 });
      throw new Error(`unexpected request in this test: ${url.href}`);
    });

    await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-ctx-cmd/discover-models' });

    const stored = await storedHost(app, 'ep-ctx-cmd');
    expect(stored?.modelContextLengths).toEqual({ 'cmd-wins': 16384 });
  });

  it('keeps a previously learned value the fresh listing says nothing about, and discovery never touches defaultContextLength', async () => {
    const app = await endpointWith('ep-ctx-keep', 8104, {
      models: ['re-listed', 'untouched'],
      modelContextLengths: { 're-listed': 16384, untouched: 4096 },
      defaultContextLength: 65536,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 're-listed', context_length: 32768 }, { id: 'untouched' }] }), {
        status: 200,
      })
    );

    await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-ctx-keep/discover-models' });

    const stored = await storedHost(app, 'ep-ctx-keep');
    expect(stored?.modelContextLengths).toEqual({ 're-listed': 32768, untouched: 4096 });
    expect(stored?.defaultContextLength).toBe(65536);
  });
});

describe('defaultContextLength (the user-set fallback discovery never overwrites)', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('stores it on create, updates it on PUT, and a PUT without it clears it', async () => {
    const { app } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'ep-defctx', label: 'A', baseUrl: 'http://localhost:8105', defaultContextLength: 131072 },
    });
    expect(create.json().data.host.defaultContextLength).toBe(131072);

    const update = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/ep-defctx',
      payload: { label: 'A', baseUrl: 'http://localhost:8105', defaultContextLength: 32768 },
    });
    expect(update.json().data.host.defaultContextLength).toBe(32768);

    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/ep-defctx',
      payload: { label: 'A', baseUrl: 'http://localhost:8105' },
    });
    expect(cleared.json().data.host.defaultContextLength).toBeUndefined();
  });

  it('rejects zero, negative, fractional, over-the-bound and non-numeric values', async () => {
    const { app } = await setup();
    for (const defaultContextLength of [0, -1, 1.5, 100_000_001, '131072']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/model-endpoints',
        payload: { id: 'ep-defctx-bad', label: 'A', baseUrl: 'http://localhost:8106', defaultContextLength },
      });
      expect(res.json().success, String(defaultContextLength)).toBe(false);
      expect(res.json().errorCode, String(defaultContextLength)).toBe('INVALID_INPUT');
    }
  });
});

describe('every write goes through the serialized writer', () => {
  const HOSTS = () => customModelHostsPath(getDataDir());

  beforeEach(() => {
    rmSync(HOSTS(), { force: true });
  });

  afterEach(() => {
    fetchMock.mockReset();
    rmSync(HOSTS(), { force: true });
    vi.restoreAllMocks();
  });

  it('ten creates sent at once all land (each used to read, change and write on its own)', async () => {
    const { app } = await setup();
    const ids = Array.from({ length: 10 }, (_, i) => `burst${i}`);
    const responses = await Promise.all(
      ids.map((id) =>
        app.inject({
          method: 'POST',
          url: '/api/model-endpoints',
          payload: { id, label: id, baseUrl: 'http://localhost:8200', apiKey: `sk-${id}` },
        })
      )
    );
    for (const res of responses) expect(res.json().success).toBe(true);
    const stored = await readCustomModelHosts(getDataDir());
    expect(stored.map((host) => host.id).sort()).toEqual([...ids].sort());
    // Every key survived: none of the writes replaced the list with its own record.
    for (const host of stored) expect(host.apiKey).toBe(`sk-${host.id}`);
  });

  it('two creates of one id sent at once: one is stored, the other is told it exists', async () => {
    const { app } = await setup();
    const create = (label: string) =>
      app.inject({
        method: 'POST',
        url: '/api/model-endpoints',
        payload: { id: 'race', label, baseUrl: 'http://localhost:8201' },
      });
    const [first, second] = await Promise.all([create('one'), create('two')]);
    expect([first.json().success, second.json().success].sort()).toEqual([false, true]);
    expect([first.json().errorCode, second.json().errorCode]).toContain('ALREADY_EXISTS');
    const stored = await readCustomModelHosts(getDataDir());
    expect(stored).toHaveLength(1);
  });

  it('a discovery that takes a moment does not undo an edit made while it ran', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'slow', label: 'Before', baseUrl: 'http://localhost:8202' },
    });
    let answer: (response: Response) => void = () => {};
    fetchMock.mockImplementation(
      (async () => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof webviewFetch
    );
    const discovering = app.inject({ method: 'POST', url: '/api/model-endpoints/slow/discover-models' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // The endpoint is renamed while the probe is still out.
    const renamed = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/slow',
      payload: { label: 'After', baseUrl: 'http://localhost:8202' },
    });
    expect(renamed.json().success).toBe(true);

    answer(new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), { status: 200 }));
    expect((await discovering).json()).toEqual({ success: true, data: { models: ['qwen3'] } });

    const [stored] = await readCustomModelHosts(getDataDir());
    // Both changes are there: the new name and the discovered list.
    expect(stored.label).toBe('After');
    expect(stored.models).toEqual(['qwen3']);
  });

  it('an endpoint deleted while its discovery ran stays deleted', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'gone', label: 'Gone', baseUrl: 'http://localhost:8203' },
    });
    let answer: (response: Response) => void = () => {};
    fetchMock.mockImplementation(
      (async () => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof webviewFetch
    );
    const discovering = app.inject({ method: 'POST', url: '/api/model-endpoints/gone/discover-models' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await app.inject({ method: 'DELETE', url: '/api/model-endpoints/gone' });
    answer(new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), { status: 200 }));
    expect((await discovering).json()).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
    expect(await readCustomModelHosts(getDataDir())).toEqual([]);
  });

  it('deleting an id that is not saved leaves the file as it is', async () => {
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'keep', label: 'Keep', baseUrl: 'http://localhost:8204' },
    });
    const before = { text: readFileSync(HOSTS(), 'utf8'), mtime: statSync(HOSTS()).mtimeMs };
    const res = await app.inject({ method: 'DELETE', url: '/api/model-endpoints/never-saved' });
    expect(res.json()).toEqual({ success: true, data: { id: 'never-saved' } });
    expect(readFileSync(HOSTS(), 'utf8')).toBe(before.text);
    expect(statSync(HOSTS()).mtimeMs).toBe(before.mtime);
  });

  describe('a store that does not parse', () => {
    const BROKEN = '[{"id":"mine","label":"Mine","baseUrl":"http://localhost:9","apiKey":"sk-keep-me"},';

    beforeEach(() => {
      writeFileSync(HOSTS(), BROKEN);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it.each([
      ['create', 'POST', '/api/model-endpoints', { id: 'new', label: 'New', baseUrl: 'http://localhost:8205' }],
      ['update', 'PUT', '/api/model-endpoints/mine', { label: 'Renamed', baseUrl: 'http://localhost:8205' }],
      ['delete', 'DELETE', '/api/model-endpoints/mine', undefined],
    ] as const)(
      '%s is refused with 409 and the file is left byte for byte (it used to be replaced by one record)',
      async (_label, method, url, payload) => {
        const { app } = await setup();
        const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ success: false, errorCode: 'CONFLICT' });
        expect(res.json().error).toContain('custom-model-hosts.json');
        // The refusal never repeats the file, which holds a key.
        expect(res.body).not.toContain('sk-keep-me');
        expect(readFileSync(HOSTS(), 'utf8')).toBe(BROKEN);
      }
    );

    it('reading still answers an empty list, as before', async () => {
      const { app } = await setup();
      expect((await app.inject({ method: 'GET', url: '/api/model-endpoints' })).json()).toEqual([]);
    });
  });
});

describe('the endpoint the local model install manages', () => {
  const HOSTS = () => customModelHostsPath(getDataDir());
  const STATE = () => dataPath('local-model.json');

  const RECORD: CustomModelHost = {
    id: 'local-ollama',
    label: 'This Mac',
    baseUrl: 'http://127.0.0.1:11435',
    authStyle: 'bearer',
    models: ['qwen3.6:35b-a3b'],
    defaultModelId: 'qwen3.6:35b-a3b',
    defaultContextLength: 131072,
  };

  /** The state file of an installed model whose connection is the record above. */
  function markManaged(): void {
    writeFileSync(
      STATE(),
      JSON.stringify({
        schema: 1,
        state: 'installed',
        model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B', context: 131072 },
        cli: { id: 'opencode', label: 'OpenCode' },
        runtime: { version: '0.40.15', port: 11435, enabled: true },
        connection: { endpointId: 'local-ollama', flagWasEnabled: false },
      })
    );
  }

  beforeEach(() => {
    rmSync(STATE(), { force: true });
    writeFileSync(HOSTS(), JSON.stringify([RECORD]));
  });

  afterEach(() => {
    fetchMock.mockReset();
    rmSync(STATE(), { force: true });
    rmSync(HOSTS(), { force: true });
  });

  it('a new endpoint may not take the reserved id, whether or not a model is installed', async () => {
    rmSync(HOSTS(), { force: true });
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'local-ollama', label: 'Mine', baseUrl: 'http://127.0.0.1:11434' },
    });
    expect(res.json()).toEqual({
      success: false,
      error: 'This endpoint id is reserved for the model Codeman runs on this Mac. Pick another id.',
      errorCode: 'INVALID_INPUT',
    });
    expect(await readCustomModelHosts(getDataDir())).toEqual([]);
  });

  it('while it is managed it is not edited: its port stays the runtime Codeman supervises', async () => {
    markManaged();
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/local-ollama',
      payload: { label: 'This Mac', baseUrl: 'http://192.168.1.99:11434' },
    });
    expect(res.json()).toEqual({
      success: false,
      error:
        'This endpoint belongs to the model Codeman runs on this Mac. Change or remove it in the local model window.',
      errorCode: 'INVALID_INPUT',
    });
    expect(await readCustomModelHosts(getDataDir())).toEqual([RECORD]);
  });

  it('while it is managed it is not deleted from here: the runtime would keep running without it', async () => {
    markManaged();
    const { app } = await setup();
    const res = await app.inject({ method: 'DELETE', url: '/api/model-endpoints/local-ollama' });
    expect(res.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(await readCustomModelHosts(getDataDir())).toEqual([RECORD]);
  });

  it('while it is managed a discovery answers the one model the install checked and asks the runtime nothing', async () => {
    markManaged();
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/model-endpoints/local-ollama/discover-models' });
    expect(res.json()).toEqual({ success: true, data: { models: ['qwen3.6:35b-a3b'] } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readCustomModelHosts(getDataDir())).toEqual([RECORD]);
  });

  it('it is listed like any other endpoint', async () => {
    markManaged();
    const { app } = await setup();
    const list = (await app.inject({ method: 'GET', url: '/api/model-endpoints' })).json();
    expect(list).toEqual([{ ...RECORD, apiKeySet: false }]);
  });

  it('a record with that id that nobody installed (made by hand) can still be edited and deleted by its owner', async () => {
    // No state file: this feature wrote nothing, so the record is the person's own.
    const { app } = await setup();
    const update = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/local-ollama',
      payload: { label: 'My own Ollama', baseUrl: 'http://127.0.0.1:11434' },
    });
    expect(update.json().success).toBe(true);
    expect((await readCustomModelHosts(getDataDir()))[0].label).toBe('My own Ollama');
    const del = await app.inject({ method: 'DELETE', url: '/api/model-endpoints/local-ollama' });
    expect(del.json()).toEqual({ success: true, data: { id: 'local-ollama' } });
    expect(await readCustomModelHosts(getDataDir())).toEqual([]);
  });

  it('any other endpoint is edited and deleted as before while a model is installed', async () => {
    markManaged();
    const { app } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/model-endpoints',
      payload: { id: 'office', label: 'Office', baseUrl: 'http://localhost:8210' },
    });
    const update = await app.inject({
      method: 'PUT',
      url: '/api/model-endpoints/office',
      payload: { label: 'Office GPU', baseUrl: 'http://localhost:8210' },
    });
    expect(update.json().data.host.label).toBe('Office GPU');
    await app.inject({ method: 'DELETE', url: '/api/model-endpoints/office' });
    expect(await readCustomModelHosts(getDataDir())).toEqual([RECORD]);
  });
});
