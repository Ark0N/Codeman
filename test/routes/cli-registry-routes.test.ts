/**
 * @fileoverview Route tests for GET /api/clis (docs/cli-enable-disable-plan.md,
 * Phase 2). Mirrors the admin-gating test shape used for other admin/settings
 * surfaces (see test/routes/search-routes.test.ts's multi-user block).
 *
 * Port: N/A (app.inject(), no live server).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerCliRegistryRoutes, type CliListItem } from '../../src/web/routes/cli-registry-routes.js';

describe('GET /api/clis', () => {
  afterEach(() => {
    delete process.env.CODEMAN_MULTIUSER;
  });

  it('single-user mode: returns every registry entry, disabled stock CLIs included', async () => {
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/clis' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: true; data: CliListItem[] };
    expect(body.success).toBe(true);
    const ids = body.data.map((c) => c.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('shell');
    expect(ids.length).toBeGreaterThanOrEqual(9);
  });

  it('every item has the expected shape and excludes spawn-time fields', async () => {
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/clis' });
    const body = res.json() as { success: true; data: CliListItem[] };
    for (const cli of body.data) {
      expect(typeof cli.id).toBe('string');
      expect(typeof cli.label).toBe('string');
      expect(typeof cli.shortBadge).toBe('string');
      expect(typeof cli.order).toBe('number');
      expect(['agent', 'shell']).toContain(cli.kind);
      expect(typeof cli.enabled).toBe('boolean');
      expect(typeof cli.stock).toBe('boolean');
      expect(typeof cli.installed).toBe('boolean');
      expect(cli).not.toHaveProperty('launch');
      expect(cli).not.toHaveProperty('env');
      expect(cli).not.toHaveProperty('capabilities');
      expect(cli).not.toHaveProperty('overlays');
      expect(cli).not.toHaveProperty('discovery');
    }
  });

  it('every entry is stock: true (no custom entries exist before Phase 5)', async () => {
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/clis' });
    const body = res.json() as { success: true; data: CliListItem[] };
    expect(body.data.every((c) => c.stock === true)).toBe(true);
  });

  it('multi-user mode: an admin sees the full list', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/clis' });
    const body = res.json() as { success: true; data: CliListItem[] };
    expect(body.data.length).toBeGreaterThanOrEqual(9);
  });

  it('multi-user mode: a non-admin sees an empty list, not a 403', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/clis' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: true; data: CliListItem[] };
    expect(body.data).toEqual([]);
  });
});
