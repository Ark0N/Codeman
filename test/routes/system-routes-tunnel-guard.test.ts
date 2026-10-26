/**
 * @fileoverview COD-55 — tunnel password guard.
 *
 * Enabling the Cloudflare tunnel publishes the whole app (full terminal control =
 * effectively RCE) to a public *.trycloudflare.com URL. When no CODEMAN_PASSWORD
 * is set, requests through that URL are unauthenticated. These tests assert the
 * PUT /api/settings tunnel-enable path REFUSES to start the tunnel unless a
 * password is set OR the unauthenticated-network opt-in is acknowledged.
 *
 * Uses app.inject() — no real HTTP ports needed. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// Settings are written to disk via fs/promises — stub so the guard test never
// touches the real settings.json, and so we can assert "not persisted on refusal".
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
    // settings.json is written to a temp file and renamed over the real one (settings-writer.ts).
    realpath: vi.fn(async (p: string) => p),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

import fs from 'node:fs/promises';
const mockedWriteFile = vi.mocked(fs.writeFile);

/** Build a tunnelManager stub the route's ctx can use. */
function makeTunnelManager(running = false) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => running),
    getUrl: vi.fn(() => null),
    getStatus: vi.fn(() => ({ running })),
  };
}

describe('COD-55 tunnel password guard (PUT /api/settings tunnelEnabled)', () => {
  let harness: RouteTestHarness;
  let tunnel: ReturnType<typeof makeTunnelManager>;
  const savedPassword = process.env.CODEMAN_PASSWORD;
  const savedOptIn = process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    vi.clearAllMocks();
    mockedWriteFile.mockResolvedValue(undefined);
    tunnel = makeTunnelManager(false);
    // tunnelManager is null in the default mock ctx — inject our spy.
    (harness.ctx as unknown as { tunnelManager: unknown }).tunnelManager = tunnel;
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK;
  });

  afterEach(async () => {
    await harness.app.close();
    if (savedPassword === undefined) delete process.env.CODEMAN_PASSWORD;
    else process.env.CODEMAN_PASSWORD = savedPassword;
    if (savedOptIn === undefined) delete process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK;
    else process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK = savedOptIn;
  });

  it('REFUSES tunnel-enable with no password and no opt-in (4xx, start not called)', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { tunnelEnabled: true },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    // Message should tell the user how to fix it.
    expect(body.error).toMatch(/CODEMAN_PASSWORD|CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK/);
    // The tunnel must NOT have been started.
    expect(tunnel.start).not.toHaveBeenCalled();
    // And tunnelEnabled:true must NOT have been persisted.
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('ALLOWS tunnel-enable when CODEMAN_PASSWORD is set (start called, 200)', async () => {
    process.env.CODEMAN_PASSWORD = 'hunter2';

    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { tunnelEnabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(tunnel.start).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS tunnel-enable with the unauthenticated-network opt-in acknowledged (start called, 200)', async () => {
    process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK = '1';

    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { tunnelEnabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(tunnel.start).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS tunnel-enable with per-request acknowledgeUnauthTunnel:true (start called, 200, flag not persisted)', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { tunnelEnabled: true, acknowledgeUnauthTunnel: true },
    });

    expect(res.statusCode).toBe(200);
    expect(tunnel.start).toHaveBeenCalledTimes(1);
    // The action flag must NOT be persisted to settings.json.
    expect(mockedWriteFile).toHaveBeenCalled();
    const persisted = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
    expect(persisted.acknowledgeUnauthTunnel).toBeUndefined();
    expect(persisted.tunnelEnabled).toBe(true);
  });

  it('still REFUSES when acknowledgeUnauthTunnel is false (4xx, start not called)', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { tunnelEnabled: true, acknowledgeUnauthTunnel: false },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(tunnel.start).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('does not guard tunnel-disable (tunnelEnabled:false always allowed)', async () => {
    tunnel = makeTunnelManager(true);
    (harness.ctx as unknown as { tunnelManager: unknown }).tunnelManager = tunnel;

    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { tunnelEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(tunnel.stop).toHaveBeenCalledTimes(1);
  });
});
