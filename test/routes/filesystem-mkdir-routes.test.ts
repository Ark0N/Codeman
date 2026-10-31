/**
 * @fileoverview POST /api/filesystem/mkdir: the path picker's "New folder". Real filesystem under
 * test/setup.ts's temp HOME (a root the picker offers), so this proves what is on disk, not a mock.
 * Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { LinkCaseSchema } from '../../src/web/schemas.js';
import { isSandboxedHome, safeRmHomeTree } from '../mocks/index.js';

describe('POST /api/filesystem/mkdir', () => {
  let workDir = '';

  beforeEach(() => {
    if (!isSandboxedHome()) throw new Error('filesystem-mkdir-routes.test.ts creates folders: run it via npm test');
    workDir = realpathSync(mkdtempSync(join(homedir(), 'picker-mkdir-')));
  });
  afterEach(() => {
    if (workDir) safeRmHomeTree(workDir);
    workDir = '';
  });

  const mkdir = async (payload: Record<string, unknown>) => {
    const { app } = await createRouteTestHarness(registerFileRoutes);
    return app.inject({ method: 'POST', url: '/api/filesystem/mkdir', payload });
  };

  it('creates one folder inside the folder being viewed and answers its path', async () => {
    const res = await mkdir({ path: workDir, name: 'fresh' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ path: join(workDir, 'fresh') });
    expect(readdirSync(workDir)).toEqual(['fresh']);
  });

  it.each(['Kay app', 'project_v2', 'v1.2', 'my-folder', 'Café 2026'])(
    'accepts %s, and Link Existing then accepts the folder it made',
    async (name) => {
      const res = await mkdir({ path: workDir, name });
      expect(res.statusCode).toBe(200);
      expect(LinkCaseSchema.safeParse({ name: 'x', path: res.json().data.path }).success).toBe(true);
    }
  );

  it('refuses the cases directory as the parent (400): a folder there is already a case', async () => {
    const casesDir = join(homedir(), 'codeman-cases');
    mkdirSync(casesDir, { recursive: true });
    try {
      const res = await mkdir({ path: casesDir, name: 'myproj' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Add Case > New Case');
      expect(existsSync(join(casesDir, 'myproj'))).toBe(false);
      // A folder inside a case is fine.
      mkdirSync(join(casesDir, 'real-case'));
      expect((await mkdir({ path: join(casesDir, 'real-case'), name: 'sub' })).statusCode).toBe(200);
    } finally {
      safeRmHomeTree(casesDir);
    }
  });

  it('answers 404 for a parent that is gone, the same answer browse gives', async () => {
    const res = await mkdir({ path: join(workDir, 'gone'), name: 'x' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a parent that is a file (400), like browse', async () => {
    writeFileSync(join(workDir, 'afile'), 'x');
    const res = await mkdir({ path: join(workDir, 'afile'), name: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('The folder to create in must be a directory');
  });

  it('creates inside a hidden folder only when the picker is showing hidden entries', async () => {
    mkdirSync(join(workDir, '.hid'));
    const denied = await mkdir({ path: join(workDir, '.hid'), name: 'x' });
    expect(denied.statusCode).toBe(403);
    const ok = await mkdir({ path: join(workDir, '.hid'), name: 'x', showHidden: 'true' });
    expect(ok.statusCode).toBe(200);
    expect(existsSync(join(workDir, '.hid', 'x'))).toBe(true);
    // A dot name is still refused there.
    expect((await mkdir({ path: join(workDir, '.hid'), name: '.y', showHidden: 'true' })).statusCode).toBe(400);
  });

  it('trims the name', async () => {
    const res = await mkdir({ path: workDir, name: '  spaced  ' });
    expect(res.json().data.path).toBe(join(workDir, 'spaced'));
  });

  it('refuses an existing folder (409) without touching it', async () => {
    mkdirSync(join(workDir, 'taken'));
    writeFileSync(join(workDir, 'taken', 'keep.txt'), 'mine');
    const res = await mkdir({ path: workDir, name: 'taken' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('already exists');
    expect(readdirSync(join(workDir, 'taken'))).toEqual(['keep.txt']);
  });

  it.each([
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a traversal', '..'],
    ['a dot name', '.'],
    ['a hidden name', '.secret'],
    ['a lone tilde', '~'],
    ['a leading tilde', '~tilde'],
    ['an empty name', '   '],
    ['an apostrophe', "Kay's app"],
    ['parentheses', 'project (v2)'],
    ['a plus', 'a+b'],
    ['a comma', 'notes, 2026'],
    ['a hash', 'c#'],
    ['brackets', '[draft]'],
    ['a double dot inside', 'v1..2'],
    ['a tab', 'a\tb'],
    ['an escape', 'a\x1b[31mb'],
    ['a bell', 'a\x07b'],
    ['a delete char', 'a\x7fb'],
    ['a name over 255 bytes', 'é'.repeat(200)],
  ])('refuses %s in the name (400) and creates nothing', async (_label, name) => {
    const res = await mkdir({ path: workDir, name });
    expect(res.statusCode).toBe(400);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('refuses a parent that does not exist (404)', async () => {
    const res = await mkdir({ path: join(workDir, 'nope'), name: 'x' });
    expect(res.statusCode).toBe(404);
    expect(existsSync(join(workDir, 'nope'))).toBe(false);
  });

  it('refuses a parent outside the browse roots (403)', async () => {
    const res = await mkdir({ path: '/etc', name: 'x' });
    expect(res.statusCode).toBe(403);
    expect(existsSync('/etc/x')).toBe(false);
  });

  it('refuses a relative or traversing parent (400)', async () => {
    expect((await mkdir({ path: 'relative', name: 'x' })).statusCode).toBe(400);
    expect((await mkdir({ path: `${workDir}/../x`, name: 'x' })).statusCode).toBe(400);
  });

  describe('multi-user scoping', () => {
    let prevMultiUser: string | undefined;
    let prevSpaces: string | undefined;
    let spaces = '';

    beforeEach(() => {
      prevMultiUser = process.env.CODEMAN_MULTIUSER;
      prevSpaces = process.env.CODEMAN_USER_SPACES_DIR;
      spaces = join(workDir, 'spaces');
      mkdirSync(join(spaces, 'alice'), { recursive: true });
      mkdirSync(join(spaces, 'bob'));
      process.env.CODEMAN_MULTIUSER = '1';
      process.env.CODEMAN_USER_SPACES_DIR = spaces;
    });
    afterEach(() => {
      if (prevMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = prevMultiUser;
      if (prevSpaces === undefined) delete process.env.CODEMAN_USER_SPACES_DIR;
      else process.env.CODEMAN_USER_SPACES_DIR = prevSpaces;
    });

    it("refuses a non-admin creating inside another user's space (403) and creates nothing", async () => {
      const { app } = await createRouteTestHarness(registerFileRoutes, { authUser: { username: 'bob', role: 'user' } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/filesystem/mkdir',
        payload: { path: join(spaces, 'alice'), name: 'x' },
      });
      expect(res.statusCode).toBe(403);
      expect(readdirSync(join(spaces, 'alice'))).toEqual([]);
    });

    it("refuses a non-admin's own cases folder (400) but not the top of their space", async () => {
      const { app } = await createRouteTestHarness(registerFileRoutes, { authUser: { username: 'bob', role: 'user' } });
      const own = join(spaces, 'bob', 'cases');
      mkdirSync(own, { recursive: true });
      const res = await app.inject({
        method: 'POST',
        url: '/api/filesystem/mkdir',
        payload: { path: own, name: 'myproj' },
      });
      expect(res.statusCode).toBe(400);
      expect(existsSync(join(own, 'myproj'))).toBe(false);
    });

    it('lets a non-admin create inside their own space', async () => {
      const { app } = await createRouteTestHarness(registerFileRoutes, { authUser: { username: 'bob', role: 'user' } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/filesystem/mkdir',
        payload: { path: join(spaces, 'bob'), name: 'mine' },
      });
      expect(res.statusCode).toBe(200);
      expect(existsSync(join(spaces, 'bob', 'mine'))).toBe(true);
    });

    it('404s a sessionId owned by another user, and adopts none of its folder', async () => {
      const scoped = await createRouteTestHarness(registerFileRoutes, { authUser: { username: 'bob', role: 'user' } });
      scoped.ctx._session.owner = 'alice';
      const res = await scoped.app.inject({
        method: 'POST',
        url: '/api/filesystem/mkdir',
        payload: { path: join(spaces, 'bob'), name: 'x', sessionId: scoped.ctx._sessionId },
      });
      expect(res.statusCode).toBe(404);
      expect(existsSync(join(spaces, 'bob', 'x'))).toBe(false);
    });
  });
});
