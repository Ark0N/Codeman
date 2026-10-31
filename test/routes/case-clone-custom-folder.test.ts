/**
 * @fileoverview POST /api/cases/clone with a `path`: clone INTO that folder (an empty or not yet existing one,
 * with no subfolder added) and register it as a linked case. Real filesystem under test/setup.ts's temp
 * HOME and a REAL `git` cloning a local bare repo (the path policy itself is in test/case-path.test.ts).
 * Port: N/A (app.inject()).
 *
 * Like case-custom-path-routes.test.ts this suite rewrites the linked-cases registry, so it refuses to
 * start outside the sandboxed HOME (a raw `npx vitest` would reach the real ~/.codeman).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { dataPath } from '../../src/config/instance.js';
import { isGitAvailable } from '../../src/git-clone.js';
import { isSandboxedHome, safeRmHomeTree } from '../mocks/index.js';

const LINKED = () => dataPath('linked-cases.json');
const linked = (): Record<string, string> => (existsSync(LINKED()) ? JSON.parse(readFileSync(LINKED(), 'utf8')) : {});
const clone = (app: Awaited<ReturnType<typeof createRouteTestHarness>>['app'], payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/cases/clone', payload });

describe.skipIf(!isGitAvailable())('POST /api/cases/clone with a custom folder', () => {
  let root: string;
  let origin: string;
  let workDir = '';

  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-clone-custom-'));
    origin = join(root, 'origin.git');
    mkdirSync(origin);
    git(['init', '--bare', '--quiet'], origin);
    const work = join(root, 'work');
    mkdirSync(work);
    git(['init', '--quiet'], work);
    git(['config', 'user.email', 'test@example.com'], work);
    git(['config', 'user.name', 'Codeman Test'], work);
    writeFileSync(join(work, 'README.md'), '# fixture\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'initial'], work);
    git(['branch', '-M', 'main'], work);
    git(['remote', 'add', 'origin', origin], work);
    git(['push', '--quiet', 'origin', 'main'], work);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    if (!isSandboxedHome()) {
      throw new Error('case-clone-custom-folder.test.ts rewrites the linked-cases registry: run it via npm test');
    }
    safeRmHomeTree(LINKED());
    // Resolved, because the server answers with the symlink-resolved folder.
    workDir = realpathSync(mkdtempSync(join(homedir(), 'clone-custom-')));
  });
  afterEach(() => {
    delete process.env.CODEMAN_MULTIUSER;
    if (workDir) safeRmHomeTree(workDir);
    workDir = '';
    if (isSandboxedHome()) safeRmHomeTree(LINKED());
  });

  it('clones into the chosen folder, scaffolds it and registers it as a linked case', async () => {
    const { app, ctx } = await createRouteTestHarness(registerCaseRoutes);
    const target = join(workDir, 'my-clone');
    const res = await clone(app, { name: 'my-clone', repository: origin, path: target });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.case).toEqual({ name: 'my-clone', path: target });
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, '.claude', 'settings.local.json'))).toBe(true);
    expect(linked()).toEqual({ 'my-clone': target });
    expect(ctx.broadcast).toHaveBeenCalledWith('case:created', { name: 'my-clone', path: target });
    // Nothing lands under the cases directory.
    expect(existsSync(join(homedir(), 'codeman-cases', 'my-clone'))).toBe(false);
  });

  it('expands ~ in the folder', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const folder = workDir.slice(homedir().length + 1);
    const res = await clone(app, { name: 'tilde', repository: origin, path: `~/${folder}/tilde` });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(workDir, 'tilde', 'README.md'))).toBe(true);
  });

  it('refuses a parent folder that does not exist, and creates nothing', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const res = await clone(app, { name: 'orphan', repository: origin, path: join(workDir, 'nope', 'orphan') });
    expect(res.statusCode).toBe(404);
    expect(existsSync(join(workDir, 'nope'))).toBe(false);
    expect(linked()).toEqual({});
  });

  it('refuses a target folder that already has files, and leaves them alone', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const target = join(workDir, 'busy');
    mkdirSync(target);
    writeFileSync(join(target, 'mine.txt'), 'keep me');
    const res = await clone(app, { name: 'busy', repository: origin, path: target });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already has files/);
    expect(readFileSync(join(target, 'mine.txt'), 'utf8')).toBe('keep me');
    expect(linked()).toEqual({});
  });

  it('clones straight INTO the chosen empty folder, with no subfolder named after the case', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const target = join(workDir, 'picked');
    mkdirSync(target);
    const res = await clone(app, { name: 'a-different-name', repository: origin, path: target });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.case).toEqual({ name: 'a-different-name', path: target });
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'a-different-name'))).toBe(false);
    expect(linked()).toEqual({ 'a-different-name': target });
  });

  it('leaves the empty folder in place, and empty, when the clone fails', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const target = join(workDir, 'stays');
    mkdirSync(target);
    const res = await clone(app, { name: 'stays', repository: join(root, 'no-such-repo.git'), path: target });
    expect(res.json().success).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(target)).toEqual([]);
    expect(linked()).toEqual({});
  });

  it('refuses a blocked tree such as ~/.ssh', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    mkdirSync(join(homedir(), '.ssh'), { recursive: true });
    const res = await clone(app, { name: 'sneaky', repository: origin, path: join(homedir(), '.ssh', 'sneaky') });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(homedir(), '.ssh', 'sneaky'))).toBe(false);
  });

  it('refuses a name already linked, before running git', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    writeFileSync(LINKED(), JSON.stringify({ taken: join(workDir, 'elsewhere') }));
    const res = await clone(app, { name: 'taken', repository: origin, path: join(workDir, 'taken') });
    // The harness has no preSerialization status mapping, so read the envelope's code.
    expect(res.json().errorCode).toBe('ALREADY_EXISTS');
    expect(existsSync(join(workDir, 'taken'))).toBe(false);
  });

  it('leaves no folder behind when the clone fails', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const target = join(workDir, 'ghost');
    const res = await clone(app, { name: 'ghost', repository: join(root, 'no-such-repo.git'), path: target });
    expect(res.json().errorCode).toBe('NOT_FOUND');
    expect(existsSync(target)).toBe(false);
    expect(linked()).toEqual({});
  });

  it('without a path the clone still goes under the cases directory and is not linked', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const res = await clone(app, { name: 'custom-folder-default', repository: origin });
    try {
      expect(res.statusCode).toBe(200);
      expect(res.json().data.case.path).toBe(join(homedir(), 'codeman-cases', 'custom-folder-default'));
      expect(linked()).toEqual({});
    } finally {
      safeRmHomeTree(join(homedir(), 'codeman-cases', 'custom-folder-default'));
    }
  });

  it('multi-user: a non-admin is refused (403) and nothing is cloned; an admin is allowed', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const user = await createRouteTestHarness(registerCaseRoutes, { authUser: { username: 'bob', role: 'user' } });
    const denied = await clone(user.app, { name: 'bobs', repository: origin, path: join(workDir, 'bobs') });
    expect(denied.statusCode).toBe(403);
    expect(existsSync(join(workDir, 'bobs'))).toBe(false);
    expect(linked()).toEqual({});
    const admin = await createRouteTestHarness(registerCaseRoutes, { authUser: { username: 'root', role: 'admin' } });
    const ok = await clone(admin.app, { name: 'roots', repository: origin, path: join(workDir, 'roots') });
    expect(ok.statusCode).toBe(200);
  });
});
