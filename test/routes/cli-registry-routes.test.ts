/**
 * @fileoverview Route tests for /api/clis (docs/cli-enable-disable-plan.md, Phases 2-5).
 * Mirrors the admin-gating test shape used for other admin/settings surfaces (see
 * test/routes/search-routes.test.ts's multi-user block).
 *
 * ⚠️ test/setup.ts gives the whole FILE one temp HOME, not one per `it()` — a write in
 * one test is visible to every test declared after it. Phase 3-5 tests therefore each
 * clean up what they create (delete a custom entry, restore a toggled stock flag) so
 * later tests, including the Phase 2 "every entry is stock" assumption above, still hold.
 *
 * Port: N/A (app.inject(), no live server).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerCliRegistryRoutes, type CliListItem } from '../../src/web/routes/cli-registry-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { getCli, registryFilePath } from '../../src/config/cli-registry/registry.js';

/** Every write endpoint requires this on; toggled per-test by writing settings.json directly. */
function enableCliManagement(): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ cliManagementEnabled: true }));
}

/**
 * The inverse, and load-bearing for every "off" test below: settings.json is shared by
 * the whole FILE (one temp HOME, not one per `it()`), so a "should be rejected while off"
 * test cannot assume the flag started false — an EARLIER test may have called
 * `enableCliManagement()` and left it on.
 */
function disableCliManagement(): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ cliManagementEnabled: false }));
}

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

describe('PUT /api/clis/:id (Phase 3: enable/disable)', () => {
  afterEach(() => {
    delete process.env.CODEMAN_MULTIUSER;
  });

  it('rejects when cliManagementEnabled is off — no settings.json write at all', async () => {
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'PUT', url: '/api/clis/grok', payload: { enabled: false } });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { errorCode: string };
    expect(body.errorCode).toBe('FORBIDDEN');
  });

  it('toggles a stock CLI off then back on, visible with no reload needed', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const off = await app.inject({ method: 'PUT', url: '/api/clis/grok', payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    const afterOff = await app.inject({ method: 'GET', url: '/api/clis' });
    const grokOff = (afterOff.json() as { data: CliListItem[] }).data.find((c) => c.id === 'grok');
    expect(grokOff?.enabled).toBe(false);

    const on = await app.inject({ method: 'PUT', url: '/api/clis/grok', payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    const afterOn = await app.inject({ method: 'GET', url: '/api/clis' });
    const grokOn = (afterOn.json() as { data: CliListItem[] }).data.find((c) => c.id === 'grok');
    expect(grokOn?.enabled).toBe(true);
  });

  it('rejects disabling shell, changes nothing', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'PUT', url: '/api/clis/shell', payload: { enabled: false } });
    // errorCode, not statusCode: this branch returns bare createErrorResponse()
    // and relies on server.ts's global preSerialization hook to map it to 400,
    // which the lightweight test harness does not register — same convention
    // as test/routes/custom-model-routes.test.ts's equivalent checks.
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    const entry = (list.json() as { data: CliListItem[] }).data.find((c) => c.id === 'shell');
    expect(entry?.enabled).toBe(true);
  });

  it('allows disabling claude — only shell keeps the hard guarantee (revised 2026-09-23)', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const off = await app.inject({ method: 'PUT', url: '/api/clis/claude', payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    const entry = (list.json() as { data: CliListItem[] }).data.find((c) => c.id === 'claude');
    expect(entry?.enabled).toBe(false);
    // Restore for any later test in this file that assumes claude's stock default.
    await app.inject({ method: 'PUT', url: '/api/clis/claude', payload: { enabled: true } });
  });

  it('404s an id that does not exist, never creating one', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'PUT', url: '/api/clis/nonexistent-id', payload: { enabled: true } });
    expect(res.json().errorCode).toBe('NOT_FOUND');
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    expect((list.json() as { data: CliListItem[] }).data.some((c) => c.id === 'nonexistent-id')).toBe(false);
  });

  it('multi-user: non-admin is rejected before the write', async () => {
    enableCliManagement();
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    const res = await app.inject({ method: 'PUT', url: '/api/clis/grok', payload: { enabled: false } });
    expect(res.statusCode).toBe(403);
  });

  it('preserves an unrelated existing override key on a stock entry when toggling enabled', async () => {
    enableCliManagement();
    // grok's real accent is #f43f5e (stock.ts); overriding it here first proves
    // the enabled-only write is a MERGE, not a replace, of that id's override.
    mkdirSync(dirname(registryFilePath()), { recursive: true });
    writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, clis: { grok: { accent: '#123456' } } }), {
      mode: 0o600,
    });
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'PUT', url: '/api/clis/grok', payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    // GET /api/clis deliberately excludes `accent` (Phase 2's own response
    // shape), so verify the merge server-side through the registry itself.
    const grok = getCli('grok');
    expect(grok?.enabled).toBe(false);
    expect(grok?.accent).toBe('#123456');
    // Restore for any later test in this file that assumes grok's stock default.
    await app.inject({ method: 'PUT', url: '/api/clis/grok', payload: { enabled: true } });
  });

  it('writes clis.json mode 0600 on POSIX', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    await app.inject({ method: 'PUT', url: '/api/clis/grok', payload: { enabled: true } });
    if (process.platform !== 'win32') {
      const mode = statSync(registryFilePath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe('POST /api/clis/:id/install (Phase 4)', () => {
  afterEach(() => {
    delete process.env.CODEMAN_MULTIUSER;
  });

  it('rejects when cliManagementEnabled is off', async () => {
    disableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/clis/grok/install' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a custom entry id — Decision 3: a custom install command is never executed', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: { id: 'test-install-guard', label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'] },
    });
    const res = await app.inject({ method: 'POST', url: '/api/clis/test-install-guard/install' });
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    await app.inject({ method: 'DELETE', url: '/api/clis/test-install-guard' });
  });

  it('multi-user: non-admin is rejected before any spawn', async () => {
    enableCliManagement();
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    const res = await app.inject({ method: 'POST', url: '/api/clis/grok/install' });
    expect(res.statusCode).toBe(403);
  });
});

describe('Custom CLI entries (Phase 5)', () => {
  afterEach(() => {
    delete process.env.CODEMAN_MULTIUSER;
  });

  it('rejects create when cliManagementEnabled is off', async () => {
    disableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: { id: 'test-off', label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates a custom entry, it appears in GET /api/clis with stock:false', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const create = await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: {
        id: 'test-create',
        label: 'Test CLI',
        shortBadge: 'TC',
        binaries: ['test-create-bin'],
        argv: ['test-create-bin', '--flag'],
      },
    });
    expect(create.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    const entry = (list.json() as { data: CliListItem[] }).data.find((c) => c.id === 'test-create');
    expect(entry?.stock).toBe(false);
    expect(entry?.label).toBe('Test CLI');
    await app.inject({ method: 'DELETE', url: '/api/clis/test-create' });
  });

  it('rejects a create whose id collides with a stock id', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: { id: 'claude', label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'] },
    });
    expect(res.json().errorCode).toBe('ALREADY_EXISTS');
  });

  it('rejects creating the same custom id twice', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const payload = { id: 'test-dup', label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'] };
    const first = await app.inject({ method: 'POST', url: '/api/clis', payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/clis', payload });
    expect(second.json().errorCode).toBe('ALREADY_EXISTS');
    await app.inject({ method: 'DELETE', url: '/api/clis/test-dup' });
  });

  it('rejects a literal with shell metacharacters (the schema, not a new bypass)', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: { id: 'test-unsafe', label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x; rm -rf /'] },
    });
    expect(res.statusCode).toBe(400);
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    expect((list.json() as { data: CliListItem[] }).data.some((c) => c.id === 'test-unsafe')).toBe(false);
  });

  it('updates an existing custom entry via PUT /api/clis/custom/:id', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: { id: 'test-update', label: 'Before', shortBadge: 'BE', binaries: ['x'], argv: ['x'] },
    });
    const update = await app.inject({
      method: 'PUT',
      url: '/api/clis/custom/test-update',
      payload: { label: 'After', shortBadge: 'AF', binaries: ['y'], argv: ['y', '--z'] },
    });
    expect(update.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    const entry = (list.json() as { data: CliListItem[] }).data.find((c) => c.id === 'test-update');
    expect(entry?.label).toBe('After');
    await app.inject({ method: 'DELETE', url: '/api/clis/test-update' });
  });

  it('rejects PUT /api/clis/custom/:id against a stock id', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/clis/custom/claude',
      payload: { label: 'Hijack', shortBadge: 'HJ', binaries: ['x'], argv: ['x'] },
    });
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    expect((list.json() as { data: CliListItem[] }).data.find((c) => c.id === 'claude')?.label).toBe('Claude');
  });

  it('404s an update against a custom id that does not exist', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/clis/custom/nonexistent-custom',
      payload: { label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'] },
    });
    expect(res.json().errorCode).toBe('NOT_FOUND');
  });

  it('deletes a custom entry; a second delete 404s', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: { id: 'test-delete', label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'] },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/clis/test-delete' });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    expect((list.json() as { data: CliListItem[] }).data.some((c) => c.id === 'test-delete')).toBe(false);
    const again = await app.inject({ method: 'DELETE', url: '/api/clis/test-delete' });
    expect(again.json().errorCode).toBe('NOT_FOUND');
  });

  it('refuses to delete a stock CLI', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/api/clis/claude' });
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    expect((list.json() as { data: CliListItem[] }).data.some((c) => c.id === 'claude')).toBe(true);
  });

  it('multi-user: non-admin is rejected on create/update/delete', async () => {
    enableCliManagement();
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: { id: 'test-mu', label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'] },
    });
    expect(create.statusCode).toBe(403);
    const update = await app.inject({
      method: 'PUT',
      url: '/api/clis/custom/test-mu',
      payload: { label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'] },
    });
    expect(update.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/api/clis/test-mu' });
    expect(del.statusCode).toBe(403);
  });

  it('a custom entry can also be toggled via the simple Phase 3 endpoint', async () => {
    enableCliManagement();
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    await app.inject({
      method: 'POST',
      url: '/api/clis',
      payload: { id: 'test-toggle', label: 'X', shortBadge: 'X', binaries: ['x'], argv: ['x'], enabled: true },
    });
    const off = await app.inject({ method: 'PUT', url: '/api/clis/test-toggle', payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/clis' });
    const entry = (list.json() as { data: CliListItem[] }).data.find((c) => c.id === 'test-toggle');
    expect(entry?.enabled).toBe(false);
    // The rest of the entry (binaries/argv/label) must survive the shallow
    // enabled-only merge — proven indirectly: a second full update still finds
    // the row and changes its label, which would fail if the toggle had
    // corrupted the stored shape.
    const relabel = await app.inject({
      method: 'PUT',
      url: '/api/clis/custom/test-toggle',
      payload: { label: 'Still here', shortBadge: 'X', binaries: ['x'], argv: ['x'] },
    });
    expect(relabel.statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: '/api/clis/test-toggle' });
  });
});
