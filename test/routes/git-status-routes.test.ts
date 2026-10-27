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
import { defaultDockerWorkspaces, registerGitStatusRoutes } from '../../src/web/routes/git-status-routes.js';
import { getDataDir } from '../../src/config/instance.js';
import { clearGitStatusCache, runGit, type GitRunner } from '../../src/git-workspace-status.js';
import { clearGitFetchLane, fetchWorkspaceOnce } from '../../src/git-fetch.js';

const ENV = {
  ...process.env,
  // As the production runner (git-workspace-status.ts): git's not-a-repo message is matched in English.
  LC_ALL: 'C',
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
  opts: {
    git?: GitRunner;
    authUser?: { username: string; role: 'admin' | 'user' };
    /** A fixed list, a reader of the test's own, or `'real'` for the route's default (the data dir's file). */
    dockerWorkspaces?: string[] | (() => Promise<string[]>) | 'real';
  } = {}
) {
  const docker = opts.dockerWorkspaces;
  const reader = docker === 'real' ? undefined : typeof docker === 'function' ? docker : async () => docker ?? [];
  const h = await createRouteTestHarness((app, ctx) => registerGitStatusRoutes(app, ctx, opts.git, reader), {
    authUser: opts.authUser,
  });
  session = h.ctx._session as unknown as Record<string, unknown>;
  session.workingDir = dir;
  return h;
}

beforeEach(() => {
  clearGitStatusCache();
  // The fetch lane is module state: a run left in it by the previous test would be joined by the next one.
  clearGitFetchLane();
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

    // A repeated key reaches the route as an array: it means "default", never a 500.
    clearGitStatusCache();
    const repeated = await app.inject({
      method: 'GET',
      url: '/api/sessions/test-session-1/git-status?timeout=5&timeout=6&fresh=1',
    });
    expect(repeated.statusCode).toBe(200);
    expect(seen.at(-1)).toBe(30_000);
  });
});

describe('POST /api/sessions/:id/git-fetch', () => {
  /** Records what each repository was asked to do, and lets real git answer the rest. */
  function recordingRunner() {
    const calls: Array<[string, string[]]> = [];
    const seenTimeouts: Array<number | undefined> = [];
    const runner: GitRunner = async (cwd, args, opts) => {
      calls.push([cwd, args]);
      seenTimeouts.push(opts?.timeoutMs);
      return execFileSyncGit(cwd, args);
    };
    return { calls, seenTimeouts, runner, fetches: () => calls.filter(([, args]) => args[0] === 'fetch') };
  }

  it('runs one fetch per repository the window would show, in the session working directory', async () => {
    for (const name of ['api', 'web']) {
      mkdirSync(join(dir, name));
      git(join(dir, name), 'init', '-q', '-b', 'main');
    }
    const { calls, fetches, runner } = recordingRunner();
    const { app } = await setup({ git: runner });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.state).toBe('ok');
    expect(data.repos.map((r: { name: string; path: string }) => [r.name, r.path])).toEqual([
      ['api', 'api'],
      ['web', 'web'],
    ]);
    expect(data.repos.every((r: { ok: boolean }) => r.ok)).toBe(true);
    // A bounded run does not promise which repository starts first, so compare the set.
    expect(fetches().sort()).toEqual([
      [join(dir, 'api'), ['fetch', '--quiet']],
      [join(dir, 'web'), ['fetch', '--quiet']],
    ]);
    // Every repository git was asked to touch sits under the session folder, and under nothing else.
    for (const [cwd] of calls) expect(cwd.startsWith(dir)).toBe(true);
  });

  it('keeps a repository it could not fetch, with its reason, and says which ones it fetched', async () => {
    for (const name of ['ok', 'private']) {
      mkdirSync(join(dir, name));
      git(join(dir, name), 'init', '-q', '-b', 'main');
    }
    const { fetches, runner } = recordingRunner();
    const injected: GitRunner = async (cwd, args, opts) => {
      const recorded = runner(cwd, args, opts); // records the call before deciding what git would have said
      if (args[0] === 'fetch' && cwd === join(dir, 'private')) {
        throw Object.assign(new Error('Command failed'), {
          stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        });
      }
      return recorded;
    };
    const { app } = await setup({ git: injected });
    const data = (await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' })).json().data;
    const priv = data.repos.find((r: { name: string }) => r.name === 'private');
    expect(priv?.ok).toBe(false);
    expect(priv?.failure?.code).toBe('AUTH_REQUIRED');
    expect(data.repos.find((r: { name: string }) => r.name === 'ok')?.ok).toBe(true);
    // Both repositories are still in the list, so both were attempted: a failure does not cancel the run.
    expect(fetches()).toHaveLength(2);
  });

  it('redacts credentials git may have echoed back before the failure reaches the client', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    // Only the fetch is faked: the resolver still needs its own `rev-parse` to find the repository at all.
    const runner: GitRunner = async (cwd, args) => {
      if (args[0] === 'fetch') {
        throw Object.assign(new Error('Command failed'), {
          stderr: "fatal: unable to access 'https://bob:ghp_secret@github.com/x.git/'\u001b[31m",
        });
      }
      return execFileSyncGit(cwd, args);
    };
    const { app } = await setup({ git: runner });
    const data = (await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' })).json().data;
    expect(data.state).toBe('ok');
    expect(data.repos[0].failure.stderr).toBe("fatal: unable to access 'https://***:***@github.com/x.git/'[31m");
  });

  it.each([
    ['remote', { host: 'h', user: 'u' }],
    ['docker', { container: 'c' }],
  ])('does not run git for a %s session and says it is unsupported', async (kind, value) => {
    git(dir, 'init', '-q', '-b', 'main');
    const { calls, fetches, runner } = recordingRunner();
    const { app } = await setup({ git: runner });
    session[kind] = value;
    const res = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ state: 'unsupported', reason: kind });
    expect(fetches()).toEqual([]);
    expect(calls).toEqual([]); // the resolver never ran either: the refusal comes before any git
  });

  it('refuses a repository inside a Docker case workspace before any git runs', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    const { calls, fetches, runner } = recordingRunner();
    const { app } = await setup({ git: runner, dockerWorkspaces: [realpathSync(dir)] });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
    expect(res.json().data).toMatchObject({ state: 'unsupported', reason: 'docker' });
    expect(fetches()).toEqual([]);
    expect(calls).toEqual([]);
  });

  /**
   * docker-cases.json is rewritten in place (truncate, then write), so a read can land on an empty or
   * half-written file. Read as "no Docker workspaces", a fetch would run git, and with it the repository's
   * hooks, inside a folder a container can write to.
   */
  it('fetches nothing when the Docker case list cannot be read, and answers a failed run', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    const { calls, runner } = recordingRunner();
    const { app, ctx } = await setup({
      git: runner,
      dockerWorkspaces: async () => {
        throw new Error('docker-cases.json is not a valid JSON array');
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ state: 'error', repos: [] });
    expect(res.json().data.error).toMatch(/Docker case list/);
    expect(calls).toEqual([]); // not even the resolver's rev-parse
    expect(session.gitFetch).toMatchObject({ trigger: 'click', state: 'error', repos: 0, failed: 0 });
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  it('reads the real Docker case list strictly for a fetch, and leaves the status route as it was', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    mkdirSync(getDataDir(), { recursive: true });
    const listPath = join(getDataDir(), 'docker-cases.json');
    try {
      writeFileSync(listPath, '[{"name":"c","hostWorkspacePath":"/x"');
      await expect(defaultDockerWorkspaces()).rejects.toThrow(/not a valid JSON array/);
      const { calls, fetches, runner } = recordingRunner();
      const { app } = await setup({ git: runner, dockerWorkspaces: 'real' });
      const fetched = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
      expect(fetched.json().data.state).toBe('error');
      expect(calls).toEqual([]);
      // The read-only status route still reads an unreadable list as none, as it always has.
      const status = await app.inject({ method: 'GET', url: '/api/sessions/test-session-1/git-status' });
      expect(status.json().data.state).toBe('ok');
      expect(fetches()).toEqual([]);

      // A readable list that names this folder refuses the fetch as a Docker workspace, so the strict
      // reader is the one the route really reads.
      writeFileSync(listPath, JSON.stringify([{ name: 'c', hostWorkspacePath: realpathSync(dir) }]));
      expect(await defaultDockerWorkspaces()).toEqual([realpathSync(dir)]);
      const refused = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
      expect(refused.json().data).toMatchObject({ state: 'unsupported', reason: 'docker' });
      expect(fetches()).toEqual([]);
    } finally {
      rmSync(listPath, { force: true });
    }
  });

  it('answers not-a-repo for a folder that is not a repository, running no fetch', async () => {
    const { fetches, runner } = recordingRunner();
    const { app } = await setup({ git: runner });
    const data = (await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' })).json().data;
    expect(data.state).toBe('not-a-repo');
    // The resolver looked once and found nothing, so nothing was fetched, and it never guessed a repository.
    expect(fetches()).toEqual([]);
  });

  it("publishes what the click got as the session's own fetch state, naming the trigger the user asked for", async () => {
    git(dir, 'init', '-q', '-b', 'main');
    const { runner } = recordingRunner();
    const { app, ctx } = await setup({ git: runner });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
    expect(res.statusCode).toBe(200);
    // The response body is one tab's copy of the run; the state is what every other tab open on the same
    // folder sees, and a number the user did not ask for has to read differently from one they did.
    expect(session.gitFetch).toMatchObject({ trigger: 'click', state: 'ok', repos: 1, failed: 0 });
    expect(ctx.persistSessionState).toHaveBeenCalled();
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  it('joins a run already going for the same folder instead of starting a second git process in the same clone', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    let releaseRun = () => {};
    const held = new Promise<void>((resolve) => (releaseRun = resolve));
    let running = () => {};
    const runStarted = new Promise<void>((resolve) => (running = resolve));
    const fetches: string[] = [];
    const runner: GitRunner = async (cwd, args) => {
      if (args[0] === 'fetch') {
        fetches.push(cwd);
        running();
        await held;
      }
      return execFileSyncGit(cwd, args);
    };
    const { app } = await setup({ git: runner });

    const first = app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
    await runStarted; // the run is going, and still going
    // A click from another tab open on the same clone. Two fetches there would collide on git's ref lock, so
    // this one joins the run already going rather than starting its own.
    const second = app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
    // Assert the join BEFORE releasing the run: the lane entry goes away when the run finishes, so releasing
    // first would let the run complete before this request reached the lane, and it would then be entitled to
    // start its own fetch: a test that passes for the wrong reason. One tick of the loop is enough for both
    // handlers to reach the lane while the run is still held open.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetches).toHaveLength(1); // one run, and the second request is waiting on it, not working

    releaseRun();
    const a = (await first).json().data;
    const b = (await second).json().data;
    expect(b).toEqual(a); // both tabs get the same run's answer, not a partial one
  });

  it('publishes the trigger of the run the click joined, because a click that fetched nothing cannot report itself as the fetch', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    let releaseRun = () => {};
    const held = new Promise<void>((resolve) => (releaseRun = resolve));
    let running = () => {};
    const runStarted = new Promise<void>((resolve) => (running = resolve));
    const fetches: string[] = [];
    const runner: GitRunner = async (cwd, args) => {
      if (args[0] === 'fetch') {
        fetches.push(cwd);
        running();
        await held;
      }
      return execFileSyncGit(cwd, args);
    };
    const { app, ctx } = await setup({ git: runner });

    // The interval tick got to this clone first. The click joins it, so the row the other tabs see has to name
    // the interval: the user clicked, but nothing this click did was a fetch. The request is left open, not
    // awaited: awaiting it here would wait on the run this test is holding, and the test would wait on itself.
    const intervalRun = fetchWorkspaceOnce(dir, { git: runner }, 'interval');
    await runStarted;
    const res = app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' });
    await new Promise((resolve) => setImmediate(resolve));

    releaseRun();
    const run = await intervalRun;
    const body = (await res).json().data;
    expect(body).toEqual(run.report); // the run it joined, not a partial answer of its own
    // Asserted after the run, so this can only pass if the click reached the lane and joined: a click that had
    // started its own fetch would make this two, and would have nothing to call the interval.
    expect(fetches).toHaveLength(1);
    expect(session.gitFetch).toMatchObject({ trigger: 'interval', state: 'ok', repos: 1, failed: 0 });
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  it('404s an unknown session, running no fetch', async () => {
    const { calls, fetches, runner } = recordingRunner();
    const { app } = await setup({ git: runner });
    expect((await app.inject({ method: 'POST', url: '/api/sessions/nope/git-fetch' })).statusCode).toBe(404);
    expect(fetches()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('multi-user: another user’s session is not found, and no fetch runs', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    git(dir, 'init', '-q', '-b', 'main');
    const { fetches, runner } = recordingRunner();
    const { app } = await setup({ git: runner, authUser: { username: 'bob', role: 'user' } });
    session.owner = 'alice';
    expect((await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/git-fetch' })).statusCode).toBe(404);
    expect(fetches()).toEqual([]);
  });

  it('honours maxRepos and timeout (seconds) for a fetch too, clamped, and reports the limit it used', async () => {
    for (const n of ['a', 'b', 'c']) {
      mkdirSync(join(dir, n));
      git(join(dir, n), 'init', '-q', '-b', 'main');
    }
    const { seenTimeouts, fetches, runner } = recordingRunner();
    const { app } = await setup({ git: runner });
    const post = async (query: string) => {
      const res = await app.inject({ method: 'POST', url: `/api/sessions/test-session-1/git-fetch${query}` });
      expect(res.statusCode).toBe(200);
      return res.json().data as { repoLimit: number; repos: Array<{ name: string }> };
    };
    const fetchCount = () => fetches().length;
    const ran = async (query: string, expected: number) => {
      const before = fetchCount();
      const data = await post(query);
      expect(fetchCount() - before).toBe(expected);
      return data;
    };

    const limited = await ran('?maxRepos=2&timeout=7', 2);
    expect(limited.repos.map((r) => r.name)).toEqual(['a', 'b']);
    expect(limited).toMatchObject({ reposTruncated: true, repoLimit: 2 }); // the window has to say three were found
    expect(new Set(seenTimeouts)).toEqual(new Set([7000]));

    const wild = await ran('?maxRepos=9999&timeout=1', 3);
    expect(wild.repoLimit).toBe(50); // clamped to MAX_REPOS_LIMIT, so one request cannot scan the whole disk
    expect(seenTimeouts.at(-1)).toBe(5000);

    const junk = await ran('?maxRepos=abc&timeout=xyz', 3);
    expect(junk.repoLimit).toBe(12);
    expect(seenTimeouts.at(-1)).toBe(30_000);

    // A repeated key reaches the route as an array: it means "default", never a 500.
    await ran('?timeout=5&timeout=6', 3);
    expect(seenTimeouts.at(-1)).toBe(30_000);
  });
});

function execFileSyncGit(cwd: string, args: string[]): Promise<string> {
  return Promise.resolve(execFileSync('git', ['--no-optional-locks', ...args], { cwd, env: ENV, encoding: 'utf8' }));
}
