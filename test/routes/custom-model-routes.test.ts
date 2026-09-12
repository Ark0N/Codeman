/**
 * @fileoverview Route tests for Custom Model Endpoint Profiles CRUD + discovery.
 * Port: N/A (app.inject, no real port needed)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerCustomModelRoutes } from '../../src/web/routes/custom-model-routes.js';
import { createRouteTestHarness } from './_route-test-utils.js';

async function setup() {
  return createRouteTestHarness(registerCustomModelRoutes);
}

describe('custom model endpoint CRUD', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://localhost:8080/v1/models');
      const headers = init?.headers as Record<string, string>;
      // Exactly ONE auth header — never both (a real server hung when sent both).
      expect(headers.Authorization).toBe('Bearer k');
      expect(headers['api-key']).toBeUndefined();
      return new Response(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'llama3' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({ method: 'POST', url: '/api/model-endpoints/ep1/discover-models' });
    expect(res.json().data.models).toEqual(['qwen3', 'llama3']);

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

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['api-key']).toBe('k');
      expect(headers.Authorization).toBeUndefined();
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    );

    const res = await app.inject({ method: 'POST', url: '/api/model-endpoints/ep-err/discover-models' });
    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
    expect(res.json().error).toContain('ECONNREFUSED');
  });
});
