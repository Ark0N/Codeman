/**
 * @fileoverview POST /api/cases/clone with a `path`: clone INTO that folder (an empty or not yet existing one,
 * with no subfolder added) and register it as a linked case. Real filesystem under test/setup.ts's temp
 * HOME and a REAL `git` cloning a local bare repo (the path policy itself is in test/case-path.test.ts).
 * Port: N/A (app.inject()).
 *
 * Like case-custom-path-routes.test.ts this suite rewrites the linked-cases registry, so it refuses to
 * start outside the sandboxed HOME (a raw `npx vitest` would reach the real ~/.codeman).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  cloneRepository,
  getActiveGitOperationCount,
  getQueuedGitOperationCount,
  isGitAvailable,
} from '../../src/git-clone.js';
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

  it('two clones into one empty folder at once: exactly one wins and its files survive', async () => {
    const target = join(workDir, 'raced');
    mkdirSync(target);
    const results = await Promise.all([
      cloneRepository({ repository: origin, destination: target, intoEmptyDir: true }),
      cloneRepository({ repository: origin, destination: target, intoEmptyDir: true }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser && !loser.ok && loser.failure.code).toBe('DESTINATION_EXISTS');
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, '.git'))).toBe(true);
  });

  it('a name linked while the clone ran is a 409 that keeps the folder and names it', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const [a, b] = await Promise.all([
      clone(app, { name: 'twin', repository: origin, path: join(workDir, 'twin-a') }),
      clone(app, { name: 'twin', repository: origin, path: join(workDir, 'twin-b') }),
    ]);
    const loserDir = a.json().success ? join(workDir, 'twin-b') : join(workDir, 'twin-a');
    const loser = a.json().success ? b : a;
    expect([a.json().success, b.json().success].filter(Boolean)).toHaveLength(1);
    expect(loser.statusCode).toBe(409);
    expect(loser.json().errorCode).toBe('ALREADY_EXISTS');
    expect(loser.json().error).toContain(loserDir);
    expect(existsSync(join(loserDir, 'README.md'))).toBe(true);
    expect(Object.keys(linked())).toEqual(['twin']);
  });

  it('a direct clone whose git-slot wait times out leaves what was written into the folder meanwhile', async () => {
    const target = join(workDir, 'queued');
    mkdirSync(target);
    // Two slow ssh clones hold both git slots (no network needed: the ssh command just sleeps).
    const prior = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'sleep 4; true';
    try {
      const holders = [0, 1].map((i) =>
        cloneRepository({
          repository: 'ssh://localhost/x.git',
          destination: join(workDir, `hold-${i}`),
          timeoutMs: 10_000,
        })
      );
      await vi.waitFor(() => expect(getActiveGitOperationCount()).toBe(2));
      const queued = cloneRepository({
        repository: origin,
        destination: target,
        intoEmptyDir: true,
        timeoutMs: 1_000,
      });
      await vi.waitFor(() => expect(getQueuedGitOperationCount()).toBe(1));
      // Written during the wait, so not this attempt's: a user copying files in, or another case created there.
      writeFileSync(join(target, 'mine.txt'), 'keep me');
      mkdirSync(join(target, 'src'));
      const result = await queued;
      expect(!result.ok && result.failure.code).toBe('TIMEOUT');
      expect(readFileSync(join(target, 'mine.txt'), 'utf8')).toBe('keep me');
      expect(existsSync(join(target, 'src'))).toBe(true);
      await Promise.all(holders);
    } finally {
      if (prior === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = prior;
    }
  }, 30_000);

  it('refuses a folder at or inside a Docker case workspace, and creates nothing', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    const workspace = join(workDir, 'dockerws');
    mkdirSync(workspace);
    writeFileSync(
      join(dataPath('docker-cases.json')),
      JSON.stringify([{ name: 'box', type: 'docker', hostId: 'h', hostWorkspacePath: workspace, container: 'c' }])
    );
    try {
      for (const path of [workspace, join(workspace, 'repo')]) {
        const res = await clone(app, { name: 'inside', repository: origin, path });
        expect(res.json().errorCode, path).toBe('INVALID_INPUT');
        expect(res.json().error, path).toMatch(/Docker case workspace/);
      }
      expect(readdirSync(workspace)).toEqual([]);
      expect(linked()).toEqual({});
      // A sibling of the workspace is fine.
      const ok = await clone(app, { name: 'beside', repository: origin, path: join(workDir, 'beside') });
      expect(ok.statusCode).toBe(200);
    } finally {
      safeRmHomeTree(dataPath('docker-cases.json'));
    }
  });

  it('fails closed when the Docker case list cannot be read', async () => {
    const { app } = await createRouteTestHarness(registerCaseRoutes);
    writeFileSync(dataPath('docker-cases.json'), '{not json');
    try {
      const res = await clone(app, { name: 'blind', repository: origin, path: join(workDir, 'blind') });
      expect(res.statusCode).toBe(503);
      expect(existsSync(join(workDir, 'blind'))).toBe(false);
    } finally {
      safeRmHomeTree(dataPath('docker-cases.json'));
    }
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
