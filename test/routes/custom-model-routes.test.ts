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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerCustomModelRoutes } from '../../src/web/routes/custom-model-routes.js';
import { webviewFetch } from '../../src/web/webview-egress.js';
import { createRouteTestHarness } from './_route-test-utils.js';

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
