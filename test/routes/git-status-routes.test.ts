/**
 * @fileoverview GET /api/sessions/:id/git-status: the git snapshot behind the bottom-bar Git
 * indicator. Real git for the happy path; an injected runner for the cases that must not run git at
 * all (remote and Docker sessions). Port: N/A (app.inject()).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerGitStatusRoutes } from '../../src/web/routes/git-status-routes.js';
import { clearGitStatusCache, runGit, type GitRunner } from '../../src/git-workspace-status.js';

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

async function setup(
  opts: { git?: GitRunner; authUser?: { username: string; role: 'admin' | 'user' }; dockerWorkspaces?: string[] } = {}
) {
  const h = await createRouteTestHarness(
    (app, ctx) => registerGitStatusRoutes(app, ctx, opts.git, async () => opts.dockerWorkspaces ?? []),
    {
      authUser: opts.authUser,
    }
  );
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
    // The workspace is the root of its repository, as real git would say.
    const runner = vi.fn<GitRunner>(async (cwd, args) => (args[0] === 'rev-parse' ? `${cwd}\n` : ''));
    const { app } = await setup({ git: runner });
    const calls = (verb: string) => runner.mock.calls.filter(([, args]) => args[0] === verb).length;
    await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    const revParses = calls('rev-parse');
    await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
    expect(calls('status')).toBe(1);
    expect(calls('rev-parse')).toBe(revParses); // the enclosing repository is reused too
    await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status?fresh=1' });
    expect(calls('status')).toBe(2);
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

describe('GET /api/sessions/:id/git-diff', () => {
  const url = (q: Record<string, string>) => `/api/sessions/test-session-1/git-diff?${new URLSearchParams(q)}`;
  let root: string;

  beforeEach(() => {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    writeFileSync(join(dir, 'b.txt'), 'bee\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'b.txt'), 'staged\n');
    git(dir, 'add', 'b.txt');
    writeFileSync(join(dir, 'new.txt'), 'fresh\n');
    root = realpathSync(dir);
  });

  it.each([
    ['unstaged', 'a.txt', ['-one', '+two']],
    ['staged', 'b.txt', ['-bee', '+staged']],
    ['untracked', 'new.txt', ['+fresh']],
  ])('returns the %s diff of %s', async (kind, path, lines) => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: url({ repo: root, path, kind }) });
    expect(res.statusCode).toBe(200);
    const { diff, truncated, binary } = res.json().data;
    for (const l of lines) expect(diff).toContain(l);
    expect(truncated).toBe(false);
    expect(binary).toBe(false);
  });

  it('answers 404 for a path or repo the status does not list, running no diff', async () => {
    const runner = vi.fn<GitRunner>(async () => '');
    const { app } = await setup({ git: runner });
    for (const q of [
      { repo: root, path: '../../etc/passwd', kind: 'unstaged' },
      { repo: '/etc', path: 'a.txt', kind: 'unstaged' },
      { repo: root, path: 'a.txt', kind: 'staged' },
    ]) {
      const res = await app.inject({ method: 'GET', url: url(q) });
      expect(res.statusCode).toBe(404);
    }
    expect(runner.mock.calls.some(([, args]) => args[0] === 'diff')).toBe(false);
  });

  it('does not run git for remote and Docker sessions', async () => {
    const runner = vi.fn<GitRunner>(async () => '');
    const { app } = await setup({ git: runner });
    session.remote = { host: 'h' };
    const res = await app.inject({ method: 'GET', url: url({ repo: root, path: 'a.txt', kind: 'unstaged' }) });
    expect(res.statusCode).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it('multi-user: another user’s session is not found', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await setup({ authUser: { username: 'bob', role: 'user' } });
    session.owner = 'alice';
    const res = await app.inject({ method: 'GET', url: url({ repo: root, path: 'a.txt', kind: 'unstaged' }) });
    expect(res.statusCode).toBe(404);
  });

  it('diffs a staged rename against its old name, and a merge conflict as git’s combined diff (real git)', async () => {
    // beforeEach left a.txt/b.txt modified; start this case from a clean tree.
    git(dir, 'checkout', '-q', '--', '.');
    git(dir, 'reset', '-q', '--hard');
    git(dir, 'clean', '-fdq');
    writeFileSync(join(dir, 'old.txt'), 'a\nb\nc\nd\ne\nf\ng\n');
    git(dir, 'add', 'old.txt');
    git(dir, 'commit', '-q', '-m', 'old');
    // A real conflict on c.txt.
    writeFileSync(join(dir, 'c.txt'), 'base\n');
    git(dir, 'add', 'c.txt');
    git(dir, 'commit', '-q', '-m', 'c');
    git(dir, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(dir, 'c.txt'), 'theirs\n');
    git(dir, 'commit', '-q', '-am', 'theirs');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'c.txt'), 'ours\n');
    git(dir, 'commit', '-q', '-am', 'ours');
    try {
      git(dir, 'merge', 'other');
    } catch {
      /* the conflict is the point */
    }
    // A staged rename, made once the merge has stopped on the conflict.
    git(dir, 'mv', 'old.txt', 'new-name.txt');
    writeFileSync(join(dir, 'new-name.txt'), 'a\nb\nc\nd\ne\nf\nCHANGED\n');
    git(dir, 'add', 'new-name.txt');
    const { app } = await setup();
    const root = realpathSync(dir);
    const rename = await app.inject({ method: 'GET', url: url({ repo: root, path: 'new-name.txt', kind: 'staged' }) });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().data.diff).toContain('rename from old.txt');
    expect(rename.json().data.diff).toContain('+CHANGED');
    const conflict = await app.inject({ method: 'GET', url: url({ repo: root, path: 'c.txt', kind: 'conflicted' }) });
    expect(conflict.statusCode).toBe(200);
    expect(conflict.json().data.diff).toMatch(/<<<<<<<|\+\+<<<<<<</);
  });

  it('404s a repository inside a Docker case workspace without running git in it', async () => {
    const runner = vi.fn<GitRunner>(async () => '');
    const { app } = await setup({ git: runner, dockerWorkspaces: [realpathSync(dir)] });
    const res = await app.inject({
      method: 'GET',
      url: url({ repo: realpathSync(dir), path: 'a.txt', kind: 'unstaged' }),
    });
    expect(res.statusCode).toBe(404);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:id/git-diff in a folder of several repositories', () => {
  it('checks the repository against the listed ones and re-reads only that one', async () => {
    for (const name of ['api', 'web']) {
      const r = join(dir, name);
      mkdirSync(r);
      git(r, 'init', '-q', '-b', 'main');
      writeFileSync(join(r, 'f.txt'), `${name}\n`);
    }
    const calls: Array<[string, string]> = [];
    const runner: GitRunner = async (cwd, args) => {
      calls.push([cwd, args[0]]);
      return runGit(cwd, args);
    };
    const { app } = await setup({ git: runner });
    const overview = (await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' })).json().data;
    const api = overview.repos.find((r: { name: string }) => r.name === 'api').status.repoRoot;
    calls.length = 0;
    const q = new URLSearchParams({ repo: api, path: 'f.txt', kind: 'untracked' });
    const res = await app.inject({ method: 'GET', url: `/api/sessions/test-session-1/git-diff?${q}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.diff).toContain('+api');
    expect(calls.filter(([, verb]) => verb === 'status').map(([cwd]) => cwd)).toEqual([api]);
  });
});

describe('GET /api/sessions/:id/git-status limits', () => {
  it('honours maxRepos and timeout (seconds), clamped, and reports the limit it used', async () => {
    for (const n of ['a', 'b', 'c']) {
      mkdirSync(join(dir, n));
      git(join(dir, n), 'init', '-q', '-b', 'main');
    }
    const seen: Array<number | undefined> = [];
    const spy: GitRunner = (cwd, args, opts) => {
      seen.push(opts?.timeoutMs);
      return execFileSyncGit(cwd, args);
    };
    const { app } = await setup({ git: spy });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/test-session-1/git-status?maxRepos=2&timeout=7',
    });
    const data = res.json().data;
    expect(data.repos.map((r: { name: string }) => r.name)).toEqual(['a', 'b']);
    expect(data).toMatchObject({ reposTruncated: true, repoLimit: 2 });
    expect(new Set(seen)).toEqual(new Set([7000]));

    clearGitStatusCache();
    const wild = await app.inject({
      method: 'GET',
      url: '/api/sessions/test-session-1/git-status?maxRepos=9999&timeout=1&fresh=1',
    });
    expect(wild.json().data.repoLimit).toBe(50);
    expect(seen.at(-1)).toBe(5000);

    clearGitStatusCache();
    const junk = await app.inject({
      method: 'GET',
      url: '/api/sessions/test-session-1/git-status?maxRepos=abc&timeout=xyz&fresh=1',
    });
    expect(junk.json().data.repoLimit).toBe(12);
    expect(seen.at(-1)).toBe(30_000);

    clearGitStatusCache();
    await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status?maxRepos=&timeout=&fresh=1' });
    expect(seen.at(-1)).toBe(30_000); // empty means "not given", not 0
  });
});

function execFileSyncGit(cwd: string, args: string[]): Promise<string> {
  return Promise.resolve(execFileSync('git', ['--no-optional-locks', ...args], { cwd, env: ENV, encoding: 'utf8' }));
}
