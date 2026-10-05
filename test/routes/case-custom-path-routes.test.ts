/**
 * @fileoverview POST /api/cases with a `path`: create a new case in a custom folder. Real
 * filesystem under test/setup.ts's temp HOME (the path policy itself is in test/case-path.test.ts).
 * Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { dataPath } from '../../src/config/instance.js';

const LINKED = () => dataPath('linked-cases.json');
const work = () => join(homedir(), 'projects');
const linked = (): Record<string, string> => (existsSync(LINKED()) ? JSON.parse(readFileSync(LINKED(), 'utf8')) : {});
const create = (app: Awaited<ReturnType<typeof createRouteTestHarness>>['app'], payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/cases', payload });

beforeEach(() => {
  rmSync(work(), { recursive: true, force: true });
  rmSync(LINKED(), { recursive: true, force: true });
  mkdirSync(work(), { recursive: true });
});
afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  rmSync(work(), { recursive: true, force: true });
  rmSync(LINKED(), { recursive: true, force: true });
});

describe('POST /api/cases with a custom path', () => {
  it('creates the folder, scaffolds it like a normal case, and registers it as a linked case', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const target = join(work(), 'my-app');
    const res = await create(app, { name: 'my-app', description: 'A thing', path: target });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.case).toEqual({ name: 'my-app', path: target });
    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf8')).toContain('my-app');
    expect(existsSync(join(target, 'src'))).toBe(true);
    expect(existsSync(join(target, '.claude', 'settings.local.json'))).toBe(true);
    expect(linked()).toEqual({ 'my-app': target });
  });

  it('appears in GET /api/cases at its custom path', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const target = join(work(), 'listed');
    await create(app, { name: 'listed', path: target });
    const list = (await app.inject({ method: 'GET', url: '/api/cases' })).json();
    const cases = Array.isArray(list) ? list : list.data;
    expect(cases.find((c: { name: string }) => c.name === 'listed')).toMatchObject({ path: target });
  });

  it('expands ~ and fills an existing EMPTY folder', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    mkdirSync(join(work(), 'empty-one'));
    const res = await create(app, { name: 'empty-one', path: '~/projects/empty-one' });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(work(), 'empty-one', 'CLAUDE.md'))).toBe(true);
  });

  it('leaves the cases directory alone: nothing is created under codeman-cases', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    await create(app, { name: 'elsewhere', path: join(work(), 'elsewhere') });
    expect(existsSync(join(homedir(), 'codeman-cases', 'elsewhere'))).toBe(false);
  });

  it('refuses a folder that already has files (409) and touches nothing', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    mkdirSync(join(work(), 'existing'));
    writeFileSync(join(work(), 'existing', 'keep.txt'), 'mine');
    const res = await create(app, { name: 'existing', path: join(work(), 'existing') });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Link Existing/);
    expect(readdirSync(join(work(), 'existing'))).toEqual(['keep.txt']);
    expect(linked()).toEqual({});
  });

  it.each([
    ['a system folder', () => '/etc/my-case', 400],
    ['a credential folder', () => join(homedir(), '.ssh', 'x'), 400],
    ['the home folder itself', () => homedir(), 400],
    ['a relative path', () => 'projects/x', 400],
    ['a path with traversal', () => `${work()}/../x`, 400],
    ['a missing parent', () => join(work(), 'nope', 'deep', 'app'), 404],
  ] as const)('refuses %s', async (_label, path, status) => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const res = await create(app, { name: 'x', path: path() });
    expect(res.statusCode).toBe(status);
    expect(linked()).toEqual({});
  });

  it('refuses a duplicate case name, and a folder that is already a case, without creating anything', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    await create(app, { name: 'one', path: join(work(), 'one') });
    const dupName = await create(app, { name: 'one', path: join(work(), 'two') });
    expect(dupName.statusCode).toBe(409);
    expect(existsSync(join(work(), 'two'))).toBe(false);
    // Same folder under another name: the first case's folder now has files, which is refused earlier.
    const dupPath = await create(app, { name: 'other', path: join(work(), 'one') });
    expect(dupPath.statusCode).toBe(409);
    expect(linked()).toEqual({ one: join(work(), 'one') });
  });

  it('validates the case name like a normal create', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const res = await create(app, { name: '../evil', path: join(work(), 'x') });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(work(), 'x'))).toBe(false);
  });

  it('undoes what it created when registering fails (a new folder is removed entirely)', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    mkdirSync(LINKED(), { recursive: true }); // writeFile onto a directory fails
    const res = await create(app, { name: 'doomed', path: join(work(), 'doomed') });
    expect(res.statusCode).toBe(500);
    expect(existsSync(join(work(), 'doomed'))).toBe(false);
  });

  it('undoes only the scaffold inside an empty folder the user picked, leaving the folder', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    mkdirSync(join(work(), 'picked'));
    mkdirSync(LINKED(), { recursive: true });
    const res = await create(app, { name: 'picked', path: join(work(), 'picked') });
    expect(res.statusCode).toBe(500);
    expect(existsSync(join(work(), 'picked'))).toBe(true);
    expect(readdirSync(join(work(), 'picked'))).toEqual([]);
  });

  it('a request without a path still creates under the cases directory, as before', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const res = await create(app, { name: 'plain-case' });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(homedir(), 'codeman-cases', 'plain-case', 'CLAUDE.md'))).toBe(true);
    expect(linked()).toEqual({});
    rmSync(join(homedir(), 'codeman-cases', 'plain-case'), { recursive: true, force: true });
  });

  it('multi-user: a non-admin is refused (403) and nothing is created; an admin is allowed', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const user = await createRouteTestHarness(registerCaseRoutes, { authUser: { username: 'bob', role: 'user' } });
    const denied = await create(user.app, { name: 'bobs', path: join(work(), 'bobs') });
    expect(denied.statusCode).toBe(403);
    expect(existsSync(join(work(), 'bobs'))).toBe(false);
    expect(linked()).toEqual({});
    const admin = await createRouteTestHarness(registerCaseRoutes, { authUser: { username: 'root', role: 'admin' } });
    expect((await create(admin.app, { name: 'roots', path: join(work(), 'roots') })).statusCode).toBe(200);
  });
});
