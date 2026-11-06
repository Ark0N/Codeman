/**
 * @fileoverview POST /api/cases/:name/rename: a local case moves with its name, a linked case renames its
 * alias (and, on request, its real folder), live sessions are listed and only stopped on request, and the
 * registries (caseOrder, lastUsedCase, linked-cases.json) and Claude's history follow. Real filesystem under
 * test/setup.ts's temp HOME; every folder is removed through safeRmHomeTree. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { dataPath } from '../../src/config/instance.js';
import { SETTINGS_PATH, resolveCasesDir } from '../../src/web/route-helpers.js';
import { caseSessionSettled, claudeProjectDirName } from '../../src/case-rename.js';
import { Session } from '../../src/session.js';
import { safeRmHomeTree } from '../mocks/index.js';
import { mutateSettingsFile } from '../../src/web/settings-writer.js';

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

  it('carries Claude history into the project directory a deleted case of the new name left behind', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const oldDir = localCase('alpha');
    const newDir = join(CASES_DIR(), 'beta');
    const oldKey = join(claudeCfg, 'projects', claudeProjectDirName(oldDir));
    const newKey = join(claudeCfg, 'projects', claudeProjectDirName(newDir));
    mkdirSync(oldKey, { recursive: true });
    writeFileSync(join(oldKey, 'conv-alpha.jsonl'), '{}');
    // case delete never removes Claude Code's history, so an earlier "beta" left its project directory
    mkdirSync(newKey, { recursive: true });
    writeFileSync(join(newKey, 'conv-old-beta.jsonl'), '{}');

    const res = await rename(app, 'alpha', { newName: 'beta' });
    made.push(newDir);

    expect(res.statusCode).toBe(200);
    expect(existsSync(join(newKey, 'conv-alpha.jsonl'))).toBe(true);
    expect(existsSync(join(newKey, 'conv-old-beta.jsonl'))).toBe(true);
    expect(existsSync(oldKey)).toBe(false);
  });

  it('refuses a dangling symlink at the new folder before it stops any session', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    const oldDir = localCase('alpha');
    const target = join(CASES_DIR(), 'beta');
    symlinkSync(join(work, 'nowhere'), target);
    made.push(target);
    (ctx.sessions as Map<string, unknown>).set('s1', { id: 's1', name: 'w1', workingDir: oldDir });

    const res = await rename(app, 'alpha', { newName: 'beta', stopSessions: true });

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('ALREADY_EXISTS');
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(existsSync(oldDir)).toBe(true);
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

  it('refuses to move a folder a session is still being created in, since it can neither list nor stop it', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    const oldDir = localCase('alpha');
    // Constructed but not in ctx.sessions yet: the gap a create spends awaiting the layout lock and settings.
    const session = new Session({ workingDir: join(oldDir, 'sub') });
    try {
      const busy = await rename(app, 'alpha', { newName: 'beta', stopSessions: true });
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ errorCode: 'CONFLICT', renameCode: 'BUSY' });
      expect(existsSync(oldDir)).toBe(true);
      expect(ctx.cleanupSession).not.toHaveBeenCalled();
      // once registered it is an open session like any other: listed, and stopped only on request
      (ctx.sessions as Map<string, unknown>).set(session.id, session);
      caseSessionSettled(session);
      const listed = await rename(app, 'alpha', { newName: 'beta' });
      expect(listed.statusCode).toBe(409);
      expect(listed.json()).toMatchObject({ requiresStop: true, sessions: [{ id: session.id }] });
    } finally {
      caseSessionSettled(session);
    }
  });

  it('does not stop a remote session whose remote path equals the local folder', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    const dir = localCase('alpha');
    (ctx.sessions as Map<string, unknown>).set('s-remote', { id: 's-remote', name: 'r', workingDir: dir, remote: {} });
    const res = await rename(app, 'alpha', { newName: 'beta' });
    made.push(join(CASES_DIR(), 'beta'));
    expect(res.statusCode).toBe(200);
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
  });

  it("carries the owner's default session group to the new name", async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    localCase('alpha');
    vi.mocked(ctx.tabLayouts.caseDefaultGroup).mockResolvedValueOnce({ groupId: 'g1', groups: [] });
    const res = await rename(app, 'alpha', { newName: 'beta' });
    made.push(join(CASES_DIR(), 'beta'));
    expect(res.statusCode).toBe(200);
    expect(ctx.tabLayouts.setCaseDefaultGroup).toHaveBeenCalledWith(expect.any(String), 'beta', 'g1');
    expect(ctx.tabLayouts.forgetCaseDefaultGroup).toHaveBeenCalledWith(expect.any(String), 'alpha');
  });

  it('answers a folder that appears at the target with ALREADY_EXISTS and keeps renameCode', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    localCase('alpha');
    localCase('beta');
    const res = await rename(app, 'alpha', { newName: 'beta' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('ALREADY_EXISTS');
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

  it('renames only the alias while a session is being created in the folder, which an alias rename leaves alone', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));
    const session = new Session({ workingDir: real });
    try {
      expect((await rename(app, 'proj', { newName: 'renamed' })).statusCode).toBe(200);
      expect((await rename(app, 'renamed', { newName: 'moved', renameFolder: true })).json()).toMatchObject({
        renameCode: 'BUSY',
      });
      expect(existsSync(real)).toBe(true);
    } finally {
      caseSessionSettled(session);
    }
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

  it('puts the folder and settings.json back when the registry cannot be written', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));
    writeFileSync(SETTINGS_PATH, JSON.stringify({ caseOrder: ['a', 'proj', 'b'], lastUsedCase: 'proj' }));
    // the registry reads fine but cannot be written: the rename must undo the folder move
    chmodSync(LINKED(), 0o444);
    const res = await rename(app, 'proj', { newName: 'renamed', renameFolder: true });
    expect(res.statusCode).toBe(500);
    expect(existsSync(real)).toBe(true);
    expect(linked()).toEqual({ proj: real });
    expect(existsSync(join(work, 'renamed'))).toBe(false);
    // settings.json is written first, so it must be put back too
    expect(settings()).toEqual({ caseOrder: ['a', 'proj', 'b'], lastUsedCase: 'proj' });
  });

  it('puts back only the keys it wrote, keeping a settings write made in between', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));
    writeFileSync(SETTINGS_PATH, JSON.stringify({ caseOrder: ['a', 'proj', 'b'], lastUsedCase: 'proj' }));
    chmodSync(LINKED(), 0o444);
    // Another writer (a settings save) lands after the rename wrote settings.json and before the
    // registry write fails.
    const realWriteFile = fs.writeFile;
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (file === LINKED()) await mutateSettingsFile((current) => ({ ...current, agentSkillEnabled: true }));
      return realWriteFile(file, data, options);
    });
    try {
      const res = await rename(app, 'proj', { newName: 'renamed', renameFolder: true });
      expect(res.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(settings()).toEqual({ caseOrder: ['a', 'proj', 'b'], lastUsedCase: 'proj', agentSkillEnabled: true });
  });

  it('refuses to rename while settings.json is not a JSON object, leaving the folder and the file alone', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const oldDir = localCase('alpha');
    const torn = '{\n  "agentSkillEnabled": true\n}tail"\n}';
    writeFileSync(SETTINGS_PATH, torn);
    const res = await rename(app, 'alpha', { newName: 'beta' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      success: false,
      errorCode: 'CONFLICT',
      error: `${SETTINGS_PATH} is not a valid JSON object, so this change was not saved (saving would have replaced every other setting in it). Fix or delete the file, or restore it from a config backup, then try again.`,
    });
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(join(CASES_DIR(), 'beta'))).toBe(false);
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe(torn);
  });

  it('checks settings.json before it stops any session, so none is ended for a rename that cannot complete', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    const oldDir = localCase('alpha');
    const torn = '{\n  "agentSkillEnabled": true\n}tail"\n}';
    writeFileSync(SETTINGS_PATH, torn);
    (ctx.sessions as Map<string, unknown>).set('s1', { id: 's1', name: 'w1', workingDir: oldDir });

    const res = await rename(app, 'alpha', { newName: 'beta', stopSessions: true });

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('CONFLICT');
    expect(res.json().error).toContain('is not a valid JSON object');
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(join(CASES_DIR(), 'beta'))).toBe(false);
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe(torn);
  });

  it('says where the folder is when it cannot be moved back', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));
    chmodSync(LINKED(), 0o444);
    const moved = join(work, 'renamed');
    const realRename = fs.rename;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (from === moved) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      return realRename(from, to);
    });
    try {
      const res = await rename(app, 'proj', { newName: 'renamed', renameFolder: true });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain(`is now at ${moved}`);
      expect(existsSync(moved)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the sessions it stopped when the rename fails after stopping them', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));
    chmodSync(LINKED(), 0o444);
    (ctx.sessions as Map<string, unknown>).set('s1', { id: 's1', name: 'w1', workingDir: real });
    const res = await rename(app, 'proj', { newName: 'renamed', renameFolder: true, stopSessions: true });
    expect(res.statusCode).toBe(500);
    expect(res.json().stoppedSessions).toBe(1);
    expect(ctx.cleanupSession).toHaveBeenCalledWith('s1', true, 'case_rename');
    expect(existsSync(real)).toBe(true);
  });

  it('puts the folder and the registry back when settings.json cannot be written', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const real = join(work, 'my-project');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real, other: join(work, 'x') }));
    writeFileSync(SETTINGS_PATH, JSON.stringify({ caseOrder: ['proj'] }));
    // settings.json is replaced by renaming a temp file over it, which a read-only file does not stop,
    // so the failure is injected at that rename.
    const realRename = fs.rename;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === SETTINGS_PATH) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return realRename(from, to);
    });
    let res;
    try {
      res = await rename(app, 'proj', { newName: 'renamed', renameFolder: true });
    } finally {
      spy.mockRestore();
    }
    expect(res.statusCode).toBe(500);
    expect(existsSync(real)).toBe(true);
    expect(linked()).toEqual({ proj: real, other: join(work, 'x') });
    // The failed write leaves no temp file behind.
    expect(readdirSync(dirname(SETTINGS_PATH)).filter((n) => n.startsWith('settings.json.'))).toEqual([]);
  });

  it('answers 404 for a linked case a non-admin cannot see in multi-user mode', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerCaseRoutes, { authUser: { username: 'bob', role: 'user' } });
    const real = join(work, 'p');
    mkdirSync(real);
    writeFileSync(LINKED(), JSON.stringify({ proj: real }));
    const res = await rename(app, 'proj', { newName: 'renamed' });
    expect(res.statusCode).toBe(404);
    expect(linked()).toEqual({ proj: real });
  });

  it('leaves the server-wide settings.json alone when a non-admin renames their own case', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerCaseRoutes, { authUser: { username: 'bob', role: 'user' } });
    const bobsDir = join(resolveCasesDir({ username: 'bob', role: 'user' } as never), 'alpha');
    mkdirSync(bobsDir, { recursive: true });
    made.push(dirname(bobsDir));
    const before = readFileSync(SETTINGS_PATH, 'utf8');
    const res = await rename(app, 'alpha', { newName: 'bobs' });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(dirname(bobsDir), 'bobs'))).toBe(true);
    expect(readFileSync(SETTINGS_PATH, 'utf8')).toBe(before);
  });
});
