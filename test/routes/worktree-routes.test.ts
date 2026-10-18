/**
 * @fileoverview The worktree routes (`/api/cases/:name/worktrees`) and quick-start's `worktree`
 * field, against a REAL temp git repository in the per-file temp HOME's case space
 * (`test/setup.ts`). Covers the happy path end to end (create, list with live sessions, start a
 * session in it, remove, branch delete) and every refusal: Docker and remote cases (git never
 * spawned for Docker), a folder that is not a repository, bad names, a symlinked `.claude`, a
 * dirty tree, a live session inside, and multi-user ownership. Port: N/A (app.inject()).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, safeRmHomeTree, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerWorktreeRoutes } from '../../src/web/routes/worktree-routes.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';
import { getDataDir } from '../../src/config/instance.js';
import { userCasesDir } from '../../src/config/multiuser.js';
import { Session } from '../../src/session.js';
import { applyAgentSkill } from '../../src/hooks-config.js';
import type { WorktreeGitRunner } from '../../src/git-worktrees.js';

const ENV = {
  ...process.env,
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A git repository with one commit at `dir`. */
function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return realpathSync(dir);
}

interface Harness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * The worktree routes plus the session routes (quick-start, POST /api/sessions), with the
 * production envelope hook mirrored from server.ts: quick-start returns a bare object and relies
 * on it for both the `{ success, data }` wrapper and the error-code status, as in
 * case-clone-routes.test.ts.
 */
async function harness(
  opts: { authUser?: { username: string; role: 'admin' | 'user' }; git?: WorktreeGitRunner } = {}
): Promise<Harness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  if (opts.authUser) {
    const authUser = opts.authUser;
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: typeof authUser }).authUser = authUser;
    });
  }
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
  const ctx = createMockRouteContext();
  registerWorktreeRoutes(app, ctx as never, { git: opts.git });
  registerSessionRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

let h: Harness;
let repo: string;

beforeEach(async () => {
  vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
  vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
  repo = makeRepo(join(CASES_DIR, 'wtcase'));
  h = await harness();
});

afterEach(async () => {
  await h.app.close();
  vi.restoreAllMocks();
  delete process.env.CODEMAN_MULTIUSER;
  await rm(join(getDataDir(), 'docker-hosts.json'), { force: true });
  await rm(join(getDataDir(), 'docker-cases.json'), { force: true });
  await rm(join(getDataDir(), 'remote-hosts.json'), { force: true });
  await rm(join(getDataDir(), 'remote-cases.json'), { force: true });
  await rm(join(getDataDir(), 'linked-cases.json'), { force: true });
  safeRmHomeTree(CASES_DIR);
  safeRmHomeTree(join(process.env.HOME ?? '/nonexistent', 'codeman-users'));
});

const list = (name = 'wtcase') => h.app.inject({ method: 'GET', url: `/api/cases/${name}/worktrees` });
const create = (payload: Record<string, unknown>, name = 'wtcase') =>
  h.app.inject({ method: 'POST', url: `/api/cases/${name}/worktrees`, payload });
const remove = (wt: string, query = '', name = 'wtcase') =>
  h.app.inject({ method: 'DELETE', url: `/api/cases/${name}/worktrees/${wt}${query}` });

describe('worktree routes: happy path', () => {
  it('creates, lists, starts a session in, and removes a worktree', async () => {
    const before = await list();
    expect(before.statusCode).toBe(200);
    expect(before.json().data).toMatchObject({ caseName: 'wtcase', repoRoot: repo, truncated: false });
    expect(before.json().data.worktrees).toHaveLength(1);

    const res = await create({ name: 'fix-login' });
    expect(res.statusCode).toBe(201);
    const wtPath = join(repo, '.claude', 'worktrees', 'fix-login');
    expect(res.json().data.worktree).toMatchObject({ name: 'fix-login', path: wtPath, branch: 'worktree-fix-login' });
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // Start a session in it through the EXISTING quick-start path.
    const qs = await h.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'wtcase', mode: 'claude', worktree: 'fix-login', sessionName: 'w1-fix-login' },
    });
    expect(qs.statusCode).toBe(200);
    const qsData = qs.json().data;
    expect(qsData).toMatchObject({ casePath: repo, worktree: 'fix-login', workingDir: wtPath });
    const session = h.ctx.sessions.get(qsData.sessionId) as unknown as { workingDir: string };
    expect(session.workingDir).toBe(wtPath);
    // The session's hooks land in the worktree it runs in, not the case folder.
    expect(readFileSync(join(wtPath, '.claude', 'settings.local.json'), 'utf-8')).toContain('/api/hook-event');
    // ...and that file does not make the worktree dirty (it is excluded).
    expect(git(wtPath, 'status', '--porcelain')).toBe('');

    const listed = (await list()).json().data.worktrees;
    const row = listed.find((w: { name?: string }) => w.name === 'fix-login');
    expect(row).toMatchObject({ managed: true, branch: 'worktree-fix-login', sessionCount: 1 });
    expect(row.sessions).toEqual([{ id: qsData.sessionId, name: 'w1-fix-login' }]);
    // The main checkout does not count a session that runs in a worktree below it.
    expect(listed[0]).toMatchObject({ main: true, isCase: true, managed: false });

    // Refused while that session lives.
    const busy = await remove('fix-login');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toContain('live session');

    h.ctx.sessions.delete(qsData.sessionId);
    const gone = await remove('fix-login', '?deleteBranch=true');
    expect(gone.statusCode).toBe(200);
    expect(gone.json().data.removed).toMatchObject({
      name: 'fix-login',
      branch: 'worktree-fix-login',
      branchDeleted: true,
    });
    expect(existsSync(wtPath)).toBe(false);
    expect(git(repo, 'branch', '--list', 'worktree-fix-login')).toBe('');
  });

  it('surfaces git’s refusal for a dirty tree and keeps the files', async () => {
    await create({ name: 'dirty', branch: 'feat/dirty' });
    const wtPath = join(repo, '.claude', 'worktrees', 'dirty');
    writeFileSync(join(wtPath, 'wip.txt'), 'work');
    const res = await remove('dirty');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('contains modified or untracked files');
    expect(readFileSync(join(wtPath, 'wip.txt'), 'utf-8')).toBe('work');
  });

  it('removes a worktree its sessions got the agent skill in (agentSkillEnabled on)', async () => {
    // The agent skill is injected into the folder a session runs in, so a worktree session gets
    // an untracked `<skills dir>/codeman/`, which used to make `git worktree remove` refuse forever.
    (h.ctx.getAgentSkillEnabled as unknown as { mockResolvedValue(v: boolean): void }).mockResolvedValue(true);
    expect((await create({ name: 'skilled' })).statusCode).toBe(201);
    const wtPath = join(repo, '.claude', 'worktrees', 'skilled');
    const qs = await h.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'wtcase', mode: 'claude', worktree: 'skilled' },
    });
    expect(qs.statusCode).toBe(200);
    h.ctx.sessions.delete(qs.json().data.sessionId);
    expect(existsSync(join(wtPath, '.claude', 'skills', 'codeman', 'SKILL.md'))).toBe(true);
    // The other skills directory (codex, gemini and the rest scan `.agents/skills`), written by
    // the same function quick-start calls; those CLIs are not installed here.
    await applyAgentSkill(wtPath, true, '.agents/skills');
    expect(existsSync(join(wtPath, '.agents', 'skills', 'codeman', 'SKILL.md'))).toBe(true);
    expect(git(wtPath, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const res = await remove('skilled');
    expect(res.statusCode).toBe(200);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('removes a worktree whose folder was deleted by hand and frees its name', async () => {
    await create({ name: 'gone' });
    const wtPath = join(repo, '.claude', 'worktrees', 'gone');
    await rm(wtPath, { recursive: true, force: true });
    const row = (await list()).json().data.worktrees.find((w: { name?: string }) => w.name === 'gone');
    expect(row).toMatchObject({ managed: true, prunable: true });
    // A session cannot start in it.
    const qs = await h.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'wtcase', mode: 'shell', worktree: 'gone' },
    });
    expect(qs.statusCode).toBe(404);
    const res = await remove('gone', '?deleteBranch=true');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.removed).toMatchObject({ name: 'gone', branchDeleted: true });
    expect(git(repo, 'worktree', 'list')).not.toContain('gone');
    expect((await create({ name: 'gone' })).statusCode).toBe(201);
  });

  it('lets a POST /api/sessions create path use the worktree as workingDir', async () => {
    await create({ name: 'viasessions' });
    const wtPath = join(repo, '.claude', 'worktrees', 'viasessions');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workingDir: wtPath, mode: 'shell', name: 's1-viasessions' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.session.workingDir).toBe(wtPath);
  });
});

describe('worktree routes: refusals', () => {
  it('rejects bad names before git (schema and the finer rules)', async () => {
    for (const name of ['-x', 'a/b', '.hidden', 'x'.repeat(65), 'a..b', 'n.lock']) {
      const res = await create({ name });
      expect(res.statusCode, name).toBe(400);
    }
    expect((await remove('a..b')).statusCode).toBe(400);
    expect((await create({ name: 'ok', branch: '-D' })).statusCode).toBe(400);
    expect((await create({ name: 'ok', base: '--upload-pack=sh' })).statusCode).toBe(400);
    expect(git(repo, 'worktree', 'list')).not.toContain('ok');
  });

  it('answers 404 for a missing case and 400 for a folder that is not a repository', async () => {
    expect((await list('nosuchcase')).statusCode).toBe(404);
    mkdirSync(join(CASES_DIR, 'plain'), { recursive: true });
    const res = await list('plain');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not a git repository');
  });

  it('refuses a Docker case with a 400 and never spawns git', async () => {
    let spawned = 0;
    const spy: WorktreeGitRunner = async () => {
      spawned++;
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    await h.app.close();
    h = await harness({ git: spy });
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(
      join(getDataDir(), 'docker-hosts.json'),
      JSON.stringify([{ id: 'd1', label: 'box', image: 'codeman/agent:base' }])
    );
    await writeFile(
      join(getDataDir(), 'docker-cases.json'),
      JSON.stringify([{ name: 'dockcase', type: 'docker', hostId: 'd1', hostWorkspacePath: repo }])
    );
    for (const res of [
      await list('dockcase'),
      await create({ name: 'x' }, 'dockcase'),
      await remove('x', '', 'dockcase'),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Docker');
    }
    // The local case whose folder IS that Docker workspace is refused too (git would run there).
    const viaLocal = await list('wtcase');
    expect(viaLocal.statusCode).toBe(400);
    expect(viaLocal.json().error).toContain('Docker');
    expect(spawned).toBe(0);

    const qs = await h.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'dockcase', mode: 'shell', worktree: 'x' },
    });
    expect(qs.statusCode).toBe(400);
    expect(qs.json().error).toContain('Docker');
  });

  it('refuses to remove a worktree a Docker case uses as its workspace', async () => {
    expect((await create({ name: 'boxed' })).statusCode).toBe(201);
    const wtPath = join(repo, '.claude', 'worktrees', 'boxed');
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(
      join(getDataDir(), 'docker-cases.json'),
      JSON.stringify([{ name: 'boxcase', type: 'docker', hostId: 'd1', hostWorkspacePath: wtPath }])
    );
    // The local case itself is fine (listing and creating still work)...
    expect((await list()).statusCode).toBe(200);
    // ...but removing the folder the container mounts is refused, and nothing is deleted.
    const res = await remove('boxed');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Docker case workspace');
    expect(existsSync(join(wtPath, 'README.md'))).toBe(true);
    expect(git(repo, 'worktree', 'list')).toContain('boxed');
  });

  it('refuses a remote case with a 400', async () => {
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(
      join(getDataDir(), 'remote-hosts.json'),
      JSON.stringify([{ id: 'r1', label: 'far', host: 'far.example', username: 'u' }])
    );
    await writeFile(
      join(getDataDir(), 'remote-cases.json'),
      JSON.stringify([{ name: 'farcase', type: 'remote', hostId: 'r1', remotePath: '/srv/repo' }])
    );
    const res = await list('farcase');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('remote');
    const qs = await h.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'farcase', mode: 'shell', worktree: 'x' },
    });
    expect(qs.statusCode).toBe(400);
    expect(qs.json().error).toContain('remote');
  });

  it('refuses to create through a symlinked .claude directory', async () => {
    const outside = join(CASES_DIR, 'outside');
    mkdirSync(join(outside, 'worktrees'), { recursive: true });
    symlinkSync(outside, join(repo, '.claude'));
    const res = await create({ name: 'evil' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('symlink');
    expect(existsSync(join(outside, 'worktrees', 'evil'))).toBe(false);
  });

  it('quick-start refuses an unregistered worktree and never scaffolds a missing case', async () => {
    mkdirSync(join(repo, '.claude', 'worktrees', 'stray'), { recursive: true });
    const stray = await h.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'wtcase', mode: 'shell', worktree: 'stray' },
    });
    expect(stray.statusCode).toBe(404);
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'brandnew', mode: 'shell', worktree: 'x' },
    });
    expect(missing.statusCode).toBe(404);
    expect(existsSync(join(CASES_DIR, 'brandnew'))).toBe(false);
    const badName = await h.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'wtcase', mode: 'shell', worktree: '../x' },
    });
    expect(badName.statusCode).toBe(400);
  });
});

describe('worktree routes: a case reached through a symlink', () => {
  // A linked case's folder can be a symlink (a repository on another disk, macOS's /tmp), and
  // POST /api/sessions stores `workingDir` as it was spelled. The worktree list and the removal
  // guard compare paths lexically, so a session spelled through the link has to be mapped onto
  // the repository's real path first, or it is invisible to both.
  it('counts and protects a session whose folder names the worktree through the case link', async () => {
    const link = join(CASES_DIR, 'repo-link');
    symlinkSync(repo, link);
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(join(getDataDir(), 'linked-cases.json'), JSON.stringify({ linkedviasym: link }));
    const made = await create({ name: 'sym' }, 'linkedviasym');
    expect(made.statusCode).toBe(201);
    const real = join(repo, '.claude', 'worktrees', 'sym');
    expect(made.json().data.worktree.path).toBe(real);

    // The same worktree, spelled through the link.
    const spelled = join(link, '.claude', 'worktrees', 'sym');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workingDir: spelled, mode: 'shell', name: 's1-sym' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.session.workingDir).toBe(spelled);

    const busy = await remove('sym', '', 'linkedviasym');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toContain('live session');
    expect(existsSync(real)).toBe(true);

    const row = (await list('linkedviasym')).json().data.worktrees.find((w: { name?: string }) => w.name === 'sym');
    expect(row).toMatchObject({ managed: true, sessionCount: 1 });
    expect(row.sessions).toEqual([{ id: res.json().data.session.id, name: 's1-sym' }]);
  });
});

describe('worktree routes: multi-user ownership', () => {
  it('resolves a non-admin’s own case space only, never a linked case or another user’s case', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    // A linked case is admin-only: a non-admin's lookup falls through to their own space.
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(join(getDataDir(), 'linked-cases.json'), JSON.stringify({ linkedrepo: repo }));
    makeRepo(join(userCasesDir('alice'), 'alicecase'));

    await h.app.close();
    h = await harness({ authUser: { username: 'bob', role: 'user' } });
    expect((await list('linkedrepo')).statusCode).toBe(404);
    expect((await list('alicecase')).statusCode).toBe(404);
    expect((await create({ name: 'x' }, 'alicecase')).statusCode).toBe(404);
    expect(existsSync(join(userCasesDir('alice'), 'alicecase', '.claude'))).toBe(false);

    await h.app.close();
    h = await harness({ authUser: { username: 'alice', role: 'user' } });
    expect((await list('alicecase')).statusCode).toBe(200);
    expect((await create({ name: 'mine' }, 'alicecase')).statusCode).toBe(201);

    await h.app.close();
    h = await harness({ authUser: { username: 'root', role: 'admin' } });
    const linked = await list('linkedrepo');
    expect(linked.statusCode).toBe(200);
    expect(linked.json().data.repoRoot).toBe(repo);
  });
});
