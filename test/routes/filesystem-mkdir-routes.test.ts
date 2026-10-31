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
    ['an empty name', '   '],
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
});
