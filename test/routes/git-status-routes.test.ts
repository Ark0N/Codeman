/**
 * @fileoverview GET /api/sessions/:id/git-status: the git snapshot behind the bottom-bar Git
 * indicator. Real git for the happy path; an injected runner for the cases that must not run git at
 * all (remote and Docker sessions). Port: N/A (app.inject()).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerGitStatusRoutes } from '../../src/web/routes/git-status-routes.js';
import { clearGitStatusCache, type GitRunner } from '../../src/git-workspace-status.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, stdio: 'ignore' });

let dir: string;
let session: Record<string, unknown>;

async function setup(opts: { git?: GitRunner; authUser?: { username: string; role: 'admin' | 'user' } } = {}) {
  const h = await createRouteTestHarness((app, ctx) => registerGitStatusRoutes(app, ctx, opts.git), {
    authUser: opts.authUser,
  });
  session = h.ctx._session as unknown as Record<string, unknown>;
  session.workingDir = dir;
  return h;
}

beforeEach(() => {
  clearGitStatusCache();
  dir = mkdtempSync(join(tmpdir(), 'git-status-route-'));
});
afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/sessions/:id/git-status', () => {
  it('returns the snapshot of the session workspace in the success envelope', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), '1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'a.txt'), '2\n');
    writeFileSync(join(dir, 'new.txt'), 'n\n');
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.state).toBe('ok');
    expect(body.data.repos).toHaveLength(1);
    const repo = body.data.repos[0];
    expect(repo).toMatchObject({ path: '.', status: { state: 'ok', branch: 'main' } });
    expect(repo.status.counts).toMatchObject({ unstaged: 1, untracked: 1, uncommitted: 2 });
    expect(repo.status.files.map((f: { path: string }) => f.path).sort()).toEqual(['a.txt', 'new.txt']);
  });

  it('reports each repository found below a folder that holds several projects', async () => {
    for (const name of ['api', 'web']) {
      mkdirSync(join(dir, name));
      git(join(dir, name), 'init', '-q', '-b', 'main');
    }
    writeFileSync(join(dir, 'api', 'dirty.txt'), 'x');
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    const data = res.json().data;
    expect(data.state).toBe('ok');
    expect(data.repos.map((r: { name: string; path: string }) => [r.name, r.path])).toEqual([
      ['api', 'api'],
      ['web', 'web'],
    ]);
    expect(data.repos[0].status.counts.uncommitted).toBe(1);
    expect(data.repos[1].status.counts.uncommitted).toBe(0);
  });

  it('answers not-a-repo for a folder that is not a repository', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    expect(res.json().data.state).toBe('not-a-repo');
  });

  it('404s an unknown session', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope/git-status' });
    expect(res.statusCode).toBe(404);
  });

  it('reuses a recent result for a poll, and recomputes for ?fresh=1', async () => {
    const runner = vi.fn<GitRunner>(async () => '');
    const { app } = await setup({ git: runner });
    const statusCalls = () => runner.mock.calls.filter(([, args]) => args[0] === 'status').length;
    await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    expect(statusCalls()).toBe(1);
    await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status?fresh=1' });
    expect(statusCalls()).toBe(2);
  });

  it('runs git in the session working directory', async () => {
    const runner = vi.fn<GitRunner>(async () => '');
    const { app } = await setup({ git: runner });
    await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    expect(runner).toHaveBeenCalled();
    for (const [cwd] of runner.mock.calls) expect(cwd).toBe(dir);
  });

  it.each([
    ['remote', { host: 'h', user: 'u' }],
    ['docker', { container: 'c' }],
  ])('does not run git for a %s session and says it is unsupported', async (kind, value) => {
    const runner = vi.fn<GitRunner>(async () => '');
    const { app } = await setup({ git: runner });
    session[kind] = value;
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ state: 'unsupported', reason: kind });
    expect(runner).not.toHaveBeenCalled();
  });

  it('multi-user: another user’s session is not found, and git is not run for it', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const runner = vi.fn<GitRunner>(async () => '');
    const { app } = await setup({ git: runner, authUser: { username: 'bob', role: 'user' } });
    session.owner = 'alice';
    const res = await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    expect(res.statusCode).toBe(404);
    expect(runner).not.toHaveBeenCalled();
  });

  it('multi-user: the owner and an admin can read it', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const runner = vi.fn<GitRunner>(async () => '');
    for (const authUser of [
      { username: 'alice', role: 'user' as const },
      { username: 'root', role: 'admin' as const },
    ]) {
      clearGitStatusCache();
      const { app } = await setup({ git: runner, authUser });
      session.owner = 'alice';
      expect((await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' })).statusCode).toBe(
        200
      );
    }
  });
});
