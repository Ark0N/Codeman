/**
 * @fileoverview Keep-awake wiring in system-routes: PUT /api/settings reconciles the sleep
 * lock from the MERGED settings (a partial body never reads as "turn it off"), a
 * non-admin's value is dropped in multi-user mode (it is machine state), and
 * GET /api/system/keep-awake returns the manager's status in the standard envelope.
 *
 * Uses app.inject(); the manager is mocked, so no real lock is taken. Port: N/A.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

const { store, keepAwake } = vi.hoisted(() => ({
  store: { settings: {} as Record<string, unknown>, written: [] as Record<string, unknown>[] },
  keepAwake: {
    apply: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({
      enabled: true,
      acOnly: true,
      platform: 'linux',
      state: 'active',
      onAc: true,
      lidHelper: null,
      detail: null,
    })),
    stop: vi.fn(async () => {}),
  },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify(store.settings)),
    writeFile: vi.fn(async (_path: string, data: string) => {
      store.written.push(JSON.parse(data));
    }),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

vi.mock('../../src/keep-awake-manager.js', () => ({ keepAwake }));

describe('keep-awake in system routes', () => {
  let harness: RouteTestHarness;

  beforeEach(() => {
    store.settings = {};
    store.written = [];
    keepAwake.apply.mockClear();
    delete process.env.CODEMAN_MULTIUSER;
  });

  afterEach(async () => {
    delete process.env.CODEMAN_MULTIUSER;
    await harness?.app.close();
  });

  it('a partial PUT keeps the persisted keep-awake on', async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    store.settings = { keepAwakeEnabled: true, keepAwakeAcOnly: false };
    const res = await harness.app.inject({ method: 'PUT', url: '/api/settings', payload: { showMonitor: true } });
    expect(res.statusCode).toBe(200);
    expect(keepAwake.apply).toHaveBeenCalledWith({ enabled: true, acOnly: false });
  });

  it('an explicit PUT turns it on and persists it', async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { keepAwakeEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(store.written.at(-1)).toMatchObject({ keepAwakeEnabled: true });
    expect(keepAwake.apply).toHaveBeenCalledWith({ enabled: true, acOnly: true });
  });

  it('rejects a non-boolean value', async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { keepAwakeEnabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(keepAwake.apply).not.toHaveBeenCalled();
  });

  it("drops a non-admin's value in multi-user mode, without failing the rest of the save", async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    harness = await createRouteTestHarness(registerSystemRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    store.settings = { keepAwakeEnabled: false };
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { keepAwakeEnabled: true, keepAwakeAcOnly: false, showMonitor: true },
    });
    expect(res.statusCode).toBe(200);
    const written = store.written.at(-1)!;
    expect(written.keepAwakeEnabled).toBe(false);
    expect('keepAwakeAcOnly' in written).toBe(false);
    expect(written.showMonitor).toBe(true);
    expect(keepAwake.apply).toHaveBeenCalledWith({ enabled: false, acOnly: true });
  });

  it('an admin can change it in multi-user mode', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    harness = await createRouteTestHarness(registerSystemRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { keepAwakeEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(keepAwake.apply).toHaveBeenCalledWith({ enabled: true, acOnly: true });
  });

  it('GET /api/system/keep-awake returns the status envelope', async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    const res = await harness.app.inject({ method: 'GET', url: '/api/system/keep-awake' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: keepAwake.getStatus() });
  });
});
