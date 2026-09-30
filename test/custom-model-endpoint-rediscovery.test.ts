/**
 * @fileoverview Tests for `refreshAllCustomModelHosts()`, the periodic
 * background sweep behind server.ts's "custom model endpoint re-discovery"
 * timer (docs/custom-model-endpoints-plan.md). Kept in its own file rather
 * than folded into test/routes/custom-model-routes.test.ts: that file's data
 * dir is shared across every test in it (one temp HOME per FILE, not per
 * test — test/setup.ts), and a sweep that walks every saved host would pick
 * up every host any other test in that file happened to create, making an
 * exact call-count or exact-host assertion meaningless. A dedicated file
 * gets its own clean temp HOME.
 *
 * Port: N/A (no server; drives readCustomModelHosts/writeCustomModelHosts
 * directly plus the mocked webviewFetch dispatcher).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { readCustomModelHosts, writeCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import { refreshAllCustomModelHosts } from '../src/web/routes/custom-model-routes.js';
import { webviewFetch } from '../src/web/webview-egress.js';

vi.mock('../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../src/web/webview-egress.js')>('../src/web/webview-egress.js');
  return { ...actual, webviewFetch: vi.fn() };
});

const fetchMock = vi.mocked(webviewFetch);

function host(overrides: Partial<CustomModelHost> & Pick<CustomModelHost, 'id' | 'baseUrl'>): CustomModelHost {
  return { label: overrides.id, ...overrides };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('refreshAllCustomModelHosts (the periodic re-discovery sweep)', () => {
  it('refreshes every saved endpoint, best-effort — one unreachable host does not stop the others', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({ id: 'ok', baseUrl: 'http://localhost:8080' }),
      host({ id: 'down', baseUrl: 'http://localhost:8081' }),
    ]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.href.includes('8081')) throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      return new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), { status: 200 });
    });

    await refreshAllCustomModelHosts();

    const hosts = await readCustomModelHosts(dir);
    const ok = hosts.find((h) => h.id === 'ok');
    const down = hosts.find((h) => h.id === 'down');
    expect(ok?.models).toEqual(['qwen3']);
    expect(ok?.lastDiscoveredAt).toBeTruthy();
    expect(down?.models ?? []).toEqual([]);
    expect(down?.lastDiscoveredAt).toBeFalsy();
  });

  it('skips a host whose baseUrl is blocked, without making a request', async () => {
    const dir = getDataDir();
    // Written directly rather than through the POST route, which already
    // refuses this at save time — this simulates a record that pre-dates the
    // guard, or was hand-edited on disk. The sweep must not trust it either.
    await writeCustomModelHosts(dir, [host({ id: 'meta', baseUrl: 'http://169.254.169.254/' })]);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }));
    await refreshAllCustomModelHosts();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a stale default and preserves lastDiscoveredAt semantics, same as manual discovery', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({ id: 'ep', baseUrl: 'http://localhost:8080', models: ['qwen3'], defaultModelId: 'qwen3' }),
    ]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'llama3' }] }), { status: 200 }));

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.models).toEqual(['llama3']);
    expect(updated.defaultModelId).toBeUndefined();
    expect(updated.lastDiscoveredAt).toBeTruthy();
  });

  it('keeps a default that is still present after the sweep', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({ id: 'ep', baseUrl: 'http://localhost:8080', models: ['qwen3'], defaultModelId: 'qwen3' }),
    ]);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'llama3' }] }), { status: 200 })
    );

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.defaultModelId).toBe('qwen3');
  });

  it('does not resurrect an endpoint deleted while the sweep was in flight', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'deleted', baseUrl: 'http://localhost:8080' })]);

    fetchMock.mockImplementation(async () => {
      // Simulate an admin deleting the endpoint between the sweep's fetch and
      // its read-modify-write — the delete must win, not be overwritten by a
      // refresh that started before it.
      const current = await readCustomModelHosts(dir);
      await writeCustomModelHosts(
        dir,
        current.filter((h) => h.id !== 'deleted')
      );
      return new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), { status: 200 });
    });

    await expect(refreshAllCustomModelHosts()).resolves.toBeUndefined();
    const hosts = await readCustomModelHosts(dir);
    expect(hosts.find((h) => h.id === 'deleted')).toBeUndefined();
  });

  it('leaves the store untouched when there are no saved endpoints at all', async () => {
    await expect(refreshAllCustomModelHosts()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('refreshAllCustomModelHosts: context-length enrichment (llama.cpp/llama-swap /props)', () => {
  it('probes /props?model= only for a model reported loaded, and stores its n_ctx', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'loaded-model', status: { value: 'loaded' } },
              { id: 'unloaded-model', status: { value: 'unloaded' } },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.pathname === '/props') {
        // Must never be reached for the unloaded model — asserted below by call count.
        expect(url.searchParams.get('model')).toBe('loaded-model');
        return new Response(JSON.stringify({ n_ctx: 16384 }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url.href}`);
    });

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelContextLengths).toEqual({ 'loaded-model': 16384 });
    const propsCalls = fetchMock.mock.calls.filter(([url]) => (url as URL).pathname === '/props');
    expect(propsCalls).toHaveLength(1);
  });

  it('never probes /props at all when no entry mentions status — feature-detected, not assumed unloaded', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), { status: 200 }));

    await refreshAllCustomModelHosts();

    expect(fetchMock).toHaveBeenCalledTimes(1); // /v1/models only
    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelContextLengths).toBeUndefined();
  });

  it('keeps a previously-learned context length for a model no longer loaded, drops it once the model disappears entirely', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({
        id: 'ep',
        baseUrl: 'http://localhost:8080',
        models: ['a', 'b'],
        modelContextLengths: { a: 8192, b: 4096 },
      }),
    ]);
    // This round: 'a' is loaded (re-confirmed), 'b' is gone from the list entirely.
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'a', status: { value: 'loaded' } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ n_ctx: 8192 }), { status: 200 });
    });

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelContextLengths).toEqual({ a: 8192 });
  });

  it('a failed /props probe for the loaded model is swallowed, leaving no context length rather than failing the sweep', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'a', status: { value: 'loaded' } }] }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    });

    await expect(refreshAllCustomModelHosts()).resolves.toBeUndefined();
    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelContextLengths).toBeUndefined();
  });

  it('prefers the REAL configured context size parsed from /running’s launch command over /props’s unreliable n_ctx', async () => {
    // Confirmed live: llama-swap launched a model with --fit-ctx 16384 (the real, working
    // limit — the actual server then refused a request over it), but /props reported
    // n_ctx: 154112 for the same model, well over what it would really accept. The context
    // must therefore keep coming from the /running command; /props is now also probed, but
    // only for `total_slots`, which the command does not state.
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b', status: { value: 'loaded' } }] }), {
          status: 200,
        });
      }
      if (url.pathname === '/running') {
        return new Response(
          JSON.stringify({
            running: [
              {
                model: 'qwen3.8-27b',
                state: 'ready',
                cmd: 'llama-server -m /models/Qwen3.8-27B.gguf --flash-attn on --jinja --fit-ctx 16384 --host 0.0.0.0 --port 5840',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.pathname === '/props') {
        return new Response(JSON.stringify({ n_ctx: 154112, total_slots: 4 }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url.href}`);
    });

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelContextLengths).toEqual({ 'qwen3.8-27b': 16384 });
    expect(updated.modelSlotCounts).toEqual({ 'qwen3.8-27b': 4 });
    // the server's own figure is kept apart, only for dividing the context across the slots
    expect(updated.modelServerContexts).toEqual({ 'qwen3.8-27b': 154112 });
  });

  it('falls back to /props when /running has no cmd, or the cmd states no recognizable context flag', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'a', status: { value: 'loaded' } }] }), { status: 200 });
      }
      if (url.pathname === '/running') {
        return new Response(
          JSON.stringify({ running: [{ model: 'a', state: 'ready', cmd: 'llama-server -m /models/a.gguf' }] }),
          { status: 200 }
        );
      }
      if (url.pathname === '/props') return new Response(JSON.stringify({ n_ctx: 8192 }), { status: 200 });
      throw new Error(`unexpected request: ${url.href}`);
    });

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelContextLengths).toEqual({ a: 8192 });
  });

  it('also recognizes a plain -c/--ctx-size flag, not just llama-swap’s own --fit-ctx', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'a', status: { value: 'loaded' } }] }), { status: 200 });
      }
      if (url.pathname === '/running') {
        return new Response(
          JSON.stringify({
            running: [{ model: 'a', state: 'ready', cmd: 'llama-server -m /models/a.gguf --ctx-size 8192' }],
          }),
          { status: 200 }
        );
      }
      if (url.pathname === '/props') return new Response('not found', { status: 404 }); // slot probe only
      throw new Error(`unexpected request: ${url.href}`);
    });

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelContextLengths).toEqual({ a: 8192 });
    expect(updated.modelSlotCounts).toBeUndefined();
  });
});

describe('refreshAllCustomModelHosts: parallel-slot enrichment (llama.cpp splits its context across --parallel slots)', () => {
  /** One loaded model whose launch command is `cmd`; `/props` behaviour is supplied by the test. */
  function serve(cmd: string, props: () => Response) {
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'm', status: { value: 'loaded' } }] }), { status: 200 });
      }
      if (url.pathname === '/running') {
        return new Response(JSON.stringify({ running: [{ model: 'm', state: 'ready', cmd }] }), { status: 200 });
      }
      if (url.pathname === '/props') return props();
      throw new Error(`unexpected request: ${url.href}`);
    });
  }
  const propsMustNotBeReached = () => {
    throw new Error('/props must not be probed: the launch command already answered both questions');
  };

  it.each([
    ['--parallel 1', 1],
    ['-np 2', 2],
    ['--parallel=3', 3],
    ['--fit-ctx 65536 --parallel 1 --host 0.0.0.0', 1],
  ])('reads an explicit %s from the launch command without probing /props', async (flags, slots) => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    serve(`llama-server -m /models/m.gguf --ctx-size 65536 ${flags}`, propsMustNotBeReached);

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSlotCounts).toEqual({ m: slots });
    expect(updated.modelServerContexts).toBeUndefined(); // /props was never probed
    expect(updated.modelContextLengths).toEqual({ m: 65536 });
  });

  it('asks /props for total_slots when the command states no --parallel (llama-server picks the count itself)', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    serve(
      'llama-server -m /models/m.gguf --fit-ctx 65536',
      () => new Response(JSON.stringify({ n_ctx: 133888, total_slots: 4 }), { status: 200 })
    );

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSlotCounts).toEqual({ m: 4 });
    expect(updated.modelServerContexts).toEqual({ m: 133888 });
    // the context still comes from the command's floor, never from /props's n_ctx
    expect(updated.modelContextLengths).toEqual({ m: 65536 });
  });

  it('treats -np -1 (llama.cpp auto) as unstated and falls back to /props', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    serve(
      'llama-server -m /models/m.gguf --fit-ctx 65536 -np -1',
      () => new Response(JSON.stringify({ total_slots: 4 }), { status: 200 })
    );

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSlotCounts).toEqual({ m: 4 });
  });

  it('a failed or slot-less /props leaves no slot count rather than failing the sweep or guessing one', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    serve(
      'llama-server -m /models/m.gguf --fit-ctx 65536',
      () => new Response(JSON.stringify({ n_ctx: 8192 }), { status: 200 })
    );

    await expect(refreshAllCustomModelHosts()).resolves.toBeUndefined();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSlotCounts).toBeUndefined();
    expect(updated.modelContextLengths).toEqual({ m: 65536 });
  });

  it('keeps a previously-learned slot count for a model that is no longer loaded, and drops it once the model disappears', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({
        id: 'ep',
        baseUrl: 'http://localhost:8080',
        models: ['a', 'b'],
        modelContextLengths: { a: 65536, b: 65536 },
        modelSlotCounts: { a: 4, b: 2 },
      }),
    ]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 }));

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSlotCounts).toEqual({ a: 4 });
  });
});

describe('refreshAllCustomModelHosts: model-size enrichment (parsed from /v1/models description)', () => {
  it('parses a GB figure out of an auto-discovered model’s description', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'qwen3.8-27b', description: 'Auto-discovered 16.35 GB - parameters auto-fitted by llama.cpp' }],
        }),
        { status: 200 }
      )
    );

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSizesGB).toEqual({ 'qwen3.8-27b': 16.35 });
  });

  it('gets no size at all for a hand-configured profile whose own description states none', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'big', description: 'General-purpose reasoning model, MoE CPU-offloaded. Default profile.' }],
        }),
        { status: 200 }
      )
    );

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSizesGB).toBeUndefined();
  });

  it('populated regardless of loaded state — unlike context length, no /props probe is needed', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [host({ id: 'ep', baseUrl: 'http://localhost:8080' })]);
    fetchMock.mockImplementation(async (url: URL) => {
      if (url.pathname === '/v1/models') {
        return new Response(
          JSON.stringify({
            data: [{ id: 'unloaded-model', description: 'Auto-discovered 4.91 GB - parameters auto-fitted' }],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected request: ${url.href}`); // /props must never be reached for this
    });

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSizesGB).toEqual({ 'unloaded-model': 4.91 });
  });

  it('keeps a previously-learned size for a model still present, drops it once the model disappears entirely', async () => {
    const dir = getDataDir();
    await writeCustomModelHosts(dir, [
      host({ id: 'ep', baseUrl: 'http://localhost:8080', models: ['a', 'b'], modelSizesGB: { a: 8, b: 16 } }),
    ]);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'a', description: 'no GB figure here' }] }), { status: 200 })
    );

    await refreshAllCustomModelHosts();

    const [updated] = await readCustomModelHosts(dir);
    expect(updated.modelSizesGB).toEqual({ a: 8 }); // 'a' kept from before, 'b' dropped (gone from the list)
  });
});
