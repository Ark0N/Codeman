/**
 * @fileoverview POST /api/cases/:name/rename: a local case moves with its name, a linked case renames its
 * alias (and, on request, its real folder), live sessions are listed and only stopped on request, and the
 * registries (caseOrder, lastUsedCase, linked-cases.json) and Claude's history follow. Real filesystem under
 * test/setup.ts's temp HOME; every folder is removed through safeRmHomeTree. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { dataPath } from '../../src/config/instance.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { claudeProjectDirName } from '../../src/case-rename.js';
import { safeRmHomeTree } from '../mocks/index.js';

const LINKED = () => dataPath('linked-cases.json');
const CASES_DIR = () => join(homedir(), 'codeman-cases');
const sandboxed = () => basename(homedir()).startsWith('codeman-vitest-');
let work = '';
let claudeCfg = '';
const made: string[] = [];

const linked = (): Record<string, string> => (existsSync(LINKED()) ? JSON.parse(readFileSync(LINKED(), 'utf8')) : {});
const settings = (): Record<string, unknown> => JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
const rename = (app: Awaited<ReturnType<typeof createRouteTestHarness>>['app'], name: string, payload: object) =>
  app.inject({ method: 'POST', url: `/api/cases/${name}/rename`, payload });
const localCase = (name: string) => {
  const dir = join(CASES_DIR(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), name);
  made.push(dir);
  return dir;
};

beforeEach(() => {
  if (!sandboxed()) throw new Error('case-rename-routes.test.ts renames folders: run it via npm test');
  safeRmHomeTree(LINKED());
  work = realpathSync(mkdtempSync(join(homedir(), 'case-rename-')));
  claudeCfg = join(work, 'claude-config');
  process.env.CLAUDE_CONFIG_DIR = claudeCfg;
  mkdirSync(join(homedir(), '.codeman'), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ caseOrder: ['keep', 'alpha', 'tail'], lastUsedCase: 'alpha' }));
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEMAN_MULTIUSER;
  for (const dir of made.splice(0)) safeRmHomeTree(dir);
  if (work) safeRmHomeTree(work);
  work = '';
  if (sandboxed()) safeRmHomeTree(LINKED());
});

describe('POST /api/cases/:name/rename (a case under the cases directory)', () => {
  it('moves the folder, keeps its place in the order, follows lastUsedCase and carries Claude history', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const oldDir = localCase('alpha');
    mkdirSync(join(claudeCfg, 'projects', claudeProjectDirName(oldDir)), { recursive: true });
    writeFileSync(join(claudeCfg, 'projects', claudeProjectDirName(oldDir), 'c.jsonl'), '{}');

    const res = await rename(app, 'alpha', { newName: 'beta' });

    expect(res.statusCode).toBe(200);
    const newDir = join(CASES_DIR(), 'beta');
    made.push(newDir);
    expect(res.json().data).toMatchObject({ oldName: 'alpha', newName: 'beta', newPath: newDir, folderMoved: true });
    expect(existsSync(oldDir)).toBe(false);
    expect(readFileSync(join(newDir, 'CLAUDE.md'), 'utf8')).toBe('alpha');
    expect(settings()).toMatchObject({ caseOrder: ['keep', 'beta', 'tail'], lastUsedCase: 'beta' });
    expect(existsSync(join(claudeCfg, 'projects', claudeProjectDirName(newDir), 'c.jsonl'))).toBe(true);
  });

  it('refuses a name that is taken (local or linked), the same name, or one that is not allowed', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    localCase('alpha');
    localCase('taken');
    const target = join(work, 'elsewhere');
    mkdirSync(target);
    writeFileSync(LINKED(), JSON.stringify({ lk: target }));
    expect((await rename(app, 'alpha', { newName: 'taken' })).statusCode).toBe(409);
    expect((await rename(app, 'alpha', { newName: 'lk' })).statusCode).toBe(409);
    expect((await rename(app, 'alpha', { newName: 'alpha' })).statusCode).toBe(400);
    expect((await rename(app, 'alpha', { newName: '../evil' })).statusCode).toBe(400);
    expect((await rename(app, 'nope', { newName: 'whatever' })).statusCode).toBe(404);
    expect(existsSync(join(CASES_DIR(), 'alpha'))).toBe(true);
  });

  it('lists the live sessions that have the folder open and does not touch it until told to stop them', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    const oldDir = localCase('alpha');
    (ctx.sessions as Map<string, unknown>).set('s-live', {
      id: 's-live',
      name: 'w1-alpha',
      workingDir: join(oldDir, 'sub'),
    });

    const refused = await rename(app, 'alpha', { newName: 'beta' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ requiresStop: true, sessions: [{ id: 's-live', name: 'w1-alpha' }] });
    expect(existsSync(oldDir)).toBe(true);
    expect(ctx.cleanupSession).not.toHaveBeenCalled();

    const done = await rename(app, 'alpha', { newName: 'beta', stopSessions: true });
    made.push(join(CASES_DIR(), 'beta'));
    expect(done.statusCode).toBe(200);
    expect(done.json().data.stoppedSessions).toBe(1);
    expect(ctx.cleanupSession).toHaveBeenCalledWith('s-live', true, 'case_rename');
    expect(existsSync(join(CASES_DIR(), 'beta'))).toBe(true);
  });

  it('does not touch a case whose name merely starts with the same letters', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    localCase('alpha');
    const sibling = localCase('alpha2');
    (ctx.sessions as Map<string, unknown>).set('s-other', { id: 's-other', name: 'x', workingDir: sibling });
    const res = await rename(app, 'alpha', { newName: 'beta' });
    made.push(join(CASES_DIR(), 'beta'));
    expect(res.statusCode).toBe(200);
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/cases/:name/rename (a linked case)', () => {
  it('renames only the alias by default: the real folder and its sessions are left alone', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real, other: join(work, 'o') }));
    (ctx.sessions as Map<string, unknown>).set('s1', { id: 's1', name: 'w1', workingDir: real });

    const res = await rename(app, 'proj', { newName: 'renamed' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ folderMoved: false, newPath: real, stoppedSessions: 0 });
    expect(linked()).toEqual({ other: join(work, 'o'), renamed: real });
    expect(existsSync(real)).toBe(true);
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
  });

  it('renames the real folder too, next to the old one, when asked', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));

    const res = await rename(app, 'proj', { newName: 'renamed', renameFolder: true });

    expect(res.statusCode).toBe(200);
    expect(existsSync(real)).toBe(false);
    expect(existsSync(join(work, 'renamed'))).toBe(true);
    expect(linked()).toEqual({ renamed: join(work, 'renamed') });
  });

  it('puts the folder back when the registry cannot be written', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));
    // the registry reads fine but cannot be written: the rename must undo the folder move
    chmodSync(LINKED(), 0o444);
    const res = await rename(app, 'proj', { newName: 'renamed', renameFolder: true });
    expect(res.statusCode).toBe(500);
    expect(existsSync(real)).toBe(true);
    expect(linked()).toEqual({ proj: real });
    expect(existsSync(join(work, 'renamed'))).toBe(false);
  });

  it('is admin only in multi-user mode', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerCaseRoutes, { authUser: { username: 'bob', role: 'user' } });
    const real = join(work, 'p');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));
    const res = await rename(app, 'proj', { newName: 'renamed' });
    expect(res.statusCode).not.toBe(200);
    expect(linked()).toEqual({ proj: real });
  });
});
