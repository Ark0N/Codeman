// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGitStatusCache,
  getGitWorkspaceStatus,
  MAX_FILES,
  parseCommitLog,
  parsePorcelainV2,
  type GitRunner,
} from '../src/git-workspace-status.js';

const NUL = '\0';

describe('parsePorcelainV2', () => {
  const header = (extra: string[] = []) =>
    ['# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', ...extra].join(
      NUL
    ) + NUL;

  it('reads the branch, upstream and ahead/behind', () => {
    const p = parsePorcelainV2(header());
    expect(p).toMatchObject({
      branch: 'main',
      detached: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      files: [],
    });
  });

  it('flags an upstream whose remote branch is gone: branch.upstream without branch.ab', () => {
    expect(
      parsePorcelainV2(['# branch.oid x', '# branch.head feature', '# branch.upstream origin/feature'].join(NUL) + NUL)
    ).toMatchObject({ upstream: 'origin/feature', upstreamGone: true });
    expect(
      parsePorcelainV2(
        ['# branch.oid x', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0'].join(NUL) + NUL
      )
    ).toMatchObject({ upstreamGone: false });
    expect(parsePorcelainV2(['# branch.oid x', '# branch.head feature'].join(NUL) + NUL).upstreamGone).toBe(false);
  });

  it('reads a detached HEAD and a branch with no upstream (no branch.ab line either)', () => {
    expect(parsePorcelainV2(['# branch.oid x', '# branch.head (detached)'].join(NUL) + NUL)).toMatchObject({
      branch: null,
      detached: true,
      upstream: null,
      ahead: 0,
    });
    expect(parsePorcelainV2(['# branch.oid x', '# branch.head feature'].join(NUL) + NUL)).toMatchObject({
      branch: 'feature',
      upstream: null,
    });
  });

  it('turns an entry that is staged AND modified in the tree into one row per kind', () => {
    const line = '1 MM N... 100644 100644 100644 aaa bbb src/a.ts';
    const files = parsePorcelainV2(header([line])).files;
    expect(files.map((f) => [f.kind, f.index, f.worktree, f.path])).toEqual([
      ['staged', 'M', 'M', 'src/a.ts'],
      ['unstaged', 'M', 'M', 'src/a.ts'],
    ]);
  });

  it('classifies staged-only, unstaged-only, added and deleted', () => {
    const lines = [
      '1 M. N... 100644 100644 100644 a b staged.ts',
      '1 .M N... 100644 100644 100644 a b unstaged.ts',
      '1 A. N... 000000 100644 100644 0 b added.ts',
      '1 .D N... 100644 100644 000000 a b gone.ts',
    ];
    const files = parsePorcelainV2(header(lines)).files;
    expect(files.map((f) => `${f.kind}:${f.index}${f.worktree}:${f.path}`)).toEqual([
      'staged:M.:staged.ts',
      'unstaged:.M:unstaged.ts',
      'staged:A.:added.ts',
      'unstaged:.D:gone.ts',
    ]);
  });

  it('reads a rename with its original path from the following token', () => {
    const text = header(['2 R. N... 100644 100644 100644 a b R100 new name.ts' + NUL + 'old name.ts']);
    expect(parsePorcelainV2(text).files).toEqual([
      { path: 'new name.ts', origPath: 'old name.ts', index: 'R', worktree: '.', kind: 'staged' },
    ]);
  });

  it('reads unmerged and untracked entries, and keeps odd names intact', () => {
    const text = header([
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? with space.txt',
      '? quote"and\'tick.txt',
      '? new\nline.txt',
      '? dir/',
    ]);
    const files = parsePorcelainV2(text).files;
    expect(files.map((f) => [f.kind, f.path])).toEqual([
      ['conflicted', 'conflict.ts'],
      ['untracked', 'with space.txt'],
      ['untracked', 'quote"and\'tick.txt'],
      ['untracked', 'new\nline.txt'],
      ['untracked', 'dir/'],
    ]);
  });

  it('skips unknown lines and survives empty input', () => {
    expect(parsePorcelainV2('')).toMatchObject({ files: [], branch: null });
    expect(parsePorcelainV2('! ignored.log' + NUL + 'weird line' + NUL).files).toEqual([]);
  });
});

describe('parseCommitLog', () => {
  it('reads hash, author, time and subject, including unicode and empty input', () => {
    const text = 'abc1234\x1fAda\x1f1700000000\x1ffix: café\x1e\ndef5678\x1fBob\x1f1700000100\x1fsecond\x1e';
    expect(parseCommitLog(text)).toEqual([
      { hash: 'abc1234', author: 'Ada', time: 1700000000, subject: 'fix: café' },
      { hash: 'def5678', author: 'Bob', time: 1700000100, subject: 'second' },
    ]);
    expect(parseCommitLog('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real git
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

let root: string;
let repo: string;
const write = (rel: string, text = 'x\n', dir = repo) => {
  const f = join(dir, rel);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, text);
};
const commit = (msg: string, dir = repo) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
};

beforeEach(() => {
  clearGitStatusCache();
  root = mkdtempSync(join(tmpdir(), 'git-status-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('getGitWorkspaceStatus against a real repository', () => {
  it('is not-a-repo outside a repository', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect((await getGitWorkspaceStatus(plain)).state).toBe('not-a-repo');
  });

  it('reports a folder that no longer exists as not-a-repo or an error, never a crash', async () => {
    const s = await getGitWorkspaceStatus(join(root, 'gone'));
    expect(['not-a-repo', 'error']).toContain(s.state);
  });

  it('a fresh repo: on its branch, untracked files, no remote, nothing "unpushed"', async () => {
    write('a.txt');
    const s = await getGitWorkspaceStatus(repo);
    expect(s).toMatchObject({ state: 'ok', branch: 'main', upstream: null, hasRemote: false, unpushedCount: 0 });
    expect(s.counts).toMatchObject({ untracked: 1, uncommitted: 1, staged: 0, unstaged: 0 });
  });

  it('a clean repo with commits but no remote has nothing to push (not "every commit")', async () => {
    write('a.txt');
    commit('one');
    write('b.txt');
    commit('two');
    const s = await getGitWorkspaceStatus(repo);
    expect(s.counts.uncommitted).toBe(0);
    expect(s).toMatchObject({ hasRemote: false, unpushedCount: 0, unpushed: [] });
  });

  it('separates staged, unstaged and untracked, and counts a staged+modified file once as uncommitted', async () => {
    write('tracked.txt', '1\n');
    write('both.txt', '1\n');
    write('removed.txt', '1\n');
    commit('base');
    write('both.txt', '2\n');
    git(repo, 'add', 'both.txt');
    write('both.txt', '3\n'); // staged AND modified again
    write('tracked.txt', '2\n'); // unstaged only
    git(repo, 'rm', '-q', 'removed.txt'); // staged delete
    write('new.txt'); // untracked
    const s = await getGitWorkspaceStatus(repo);
    expect(s.counts).toMatchObject({ staged: 2, unstaged: 2, untracked: 1, conflicted: 0, uncommitted: 4 });
    const row = (kind: string, path: string) => s.files.find((f) => f.kind === kind && f.path === path);
    expect(row('staged', 'both.txt')).toBeTruthy();
    expect(row('unstaged', 'both.txt')).toBeTruthy();
    expect(row('staged', 'removed.txt')?.index).toBe('D');
    expect(row('untracked', 'new.txt')).toBeTruthy();
  });

  it('reports a staged rename with its original path', async () => {
    write('old.txt', 'content that is long enough to be detected as a rename\n'.repeat(5));
    commit('base');
    git(repo, 'mv', 'old.txt', 'new.txt');
    const s = await getGitWorkspaceStatus(repo);
    expect(s.files).toContainEqual(
      expect.objectContaining({ path: 'new.txt', origPath: 'old.txt', index: 'R', kind: 'staged' })
    );
  });

  it('reports merge conflicts', async () => {
    write('c.txt', 'base\n');
    commit('base');
    git(repo, 'checkout', '-q', '-b', 'other');
    write('c.txt', 'other\n');
    commit('other');
    git(repo, 'checkout', '-q', 'main');
    write('c.txt', 'main\n');
    commit('main');
    expect(() => git(repo, 'merge', 'other')).toThrow();
    const s = await getGitWorkspaceStatus(repo);
    expect(s.counts.conflicted).toBe(1);
    expect(s.files.find((f) => f.kind === 'conflicted')?.path).toBe('c.txt');
  });

  it('handles file names with spaces, quotes and unicode', async () => {
    write('with space.txt');
    write('quote"d.txt');
    write('café ☕.txt');
    const s = await getGitWorkspaceStatus(repo);
    expect(s.files.map((f) => f.path).sort()).toEqual(['café ☕.txt', 'quote"d.txt', 'with space.txt']);
  });

  it('caps the file list but keeps the counts exact', async () => {
    for (let i = 0; i < MAX_FILES + 20; i++) write(`f${i}.txt`);
    const s = await getGitWorkspaceStatus(repo);
    expect(s.files).toHaveLength(MAX_FILES);
    expect(s.filesTruncated).toBe(true);
    expect(s.counts.untracked).toBe(MAX_FILES + 20);
    expect(s.counts.uncommitted).toBe(MAX_FILES + 20);
  });

  it('counts stashes', async () => {
    write('a.txt', '1\n');
    commit('base');
    write('a.txt', '2\n');
    git(repo, 'stash', '-q');
    expect((await getGitWorkspaceStatus(repo)).counts.stashes).toBe(1);
  });

  it('reports a detached HEAD', async () => {
    write('a.txt');
    commit('one');
    git(repo, 'checkout', '-q', '--detach');
    const s = await getGitWorkspaceStatus(repo);
    expect(s).toMatchObject({ detached: true, branch: null });
  });

  describe('with a remote', () => {
    let bare: string;
    beforeEach(() => {
      bare = join(root, 'origin.git');
      git(root, 'init', '-q', '--bare', '-b', 'main', bare);
      git(repo, 'remote', 'add', 'origin', bare);
      write('a.txt', '1\n');
      commit('first');
      git(repo, 'push', '-q', '-u', 'origin', 'main');
    });

    it('in sync: nothing ahead, nothing unpushed', async () => {
      const s = await getGitWorkspaceStatus(repo);
      expect(s).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0, hasRemote: true, unpushedCount: 0 });
    });

    it('lists commits that are ahead of the upstream, newest first, with the subject and author', async () => {
      write('b.txt');
      commit('second: add b');
      write('c.txt');
      commit('third: add c');
      const s = await getGitWorkspaceStatus(repo);
      expect(s).toMatchObject({ ahead: 2, unpushedCount: 2 });
      expect(s.unpushed.map((c) => c.subject)).toEqual(['third: add c', 'second: add b']);
      expect(s.unpushed[0]).toMatchObject({ author: 'T' });
      expect(s.unpushed[0].hash).toMatch(/^[0-9a-f]{7,}$/);
      expect(s.unpushed[0].time).toBeGreaterThan(1_600_000_000);
    });

    it('behind reflects the last fetch only: it never fetches on its own', async () => {
      const other = join(root, 'other');
      git(root, 'clone', '-q', bare, other);
      write('theirs.txt', 'x\n', other);
      commit('theirs', other);
      git(other, 'push', '-q', 'origin', 'main');
      expect((await getGitWorkspaceStatus(repo)).behind).toBe(0); // not fetched yet
      clearGitStatusCache();
      git(repo, 'fetch', '-q');
      expect((await getGitWorkspaceStatus(repo)).behind).toBe(1);
    });

    it('a branch with no upstream lists what no remote has', async () => {
      git(repo, 'checkout', '-q', '-b', 'feature');
      write('f1.txt');
      commit('f1');
      write('f2.txt');
      commit('f2');
      const s = await getGitWorkspaceStatus(repo);
      expect(s).toMatchObject({ branch: 'feature', upstream: null, hasRemote: true, unpushedCount: 2 });
      expect(s.unpushed.map((c) => c.subject)).toEqual(['f2', 'f1']);
    });

    it('a branch whose upstream was deleted and pruned is NOT reported as everything pushed', async () => {
      git(repo, 'checkout', '-q', '-b', 'feature');
      write('f1.txt');
      commit('f1');
      git(repo, 'push', '-q', '-u', 'origin', 'feature');
      git(repo, 'push', '-q', 'origin', '--delete', 'feature');
      git(repo, 'fetch', '-q', '--prune');
      write('f2.txt');
      commit('f2');
      const s = await getGitWorkspaceStatus(repo);
      expect(s).toMatchObject({ branch: 'feature', upstream: 'origin/feature', upstreamGone: true });
      expect(s.unpushedCount).toBe(2);
      expect(s.unpushed.map((c) => c.subject)).toEqual(['f2', 'f1']);
    });

    it('a pushed branch is not reported as unpushed once it has an upstream', async () => {
      git(repo, 'checkout', '-q', '-b', 'feature');
      write('f1.txt');
      commit('f1');
      git(repo, 'push', '-q', '-u', 'origin', 'feature');
      expect((await getGitWorkspaceStatus(repo)).unpushedCount).toBe(0);
    });
  });

  describe('it only reads', () => {
    it('does not rewrite the index or leave a lock, even when stat data is stale', async () => {
      write('a.txt', '1\n');
      commit('base');
      const before = readFileSync(join(repo, '.git', 'index'));
      // Touching a tracked file makes a plain `git status` want to refresh the index.
      const now = new Date();
      const { utimesSync } = await import('node:fs');
      utimesSync(join(repo, 'a.txt'), now, new Date(now.getTime() + 5000));
      await getGitWorkspaceStatus(repo);
      expect(readFileSync(join(repo, '.git', 'index')).equals(before)).toBe(true);
      expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
    });

    it('does not run a repository-configured fsmonitor hook (and a plain git status would have)', async () => {
      write('a.txt', '1\n');
      commit('base');
      const hook = join(root, 'fsmonitor.sh');
      const marker = join(root, 'fsmonitor-ran');
      writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nprintf ''\n`);
      chmodSync(hook, 0o755);
      git(repo, 'config', 'core.fsmonitor', hook);
      // Control: git itself runs it for a plain status, so the assertion below is not vacuous.
      git(repo, 'status', '--short');
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      await getGitWorkspaceStatus(repo);
      expect(existsSync(marker)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Cache and error mapping (fake runner)
// ---------------------------------------------------------------------------

describe('caching and failures', () => {
  const okRunner = (calls: string[][] = []): GitRunner =>
    vi.fn(async (_cwd, args) => {
      calls.push(args);
      if (args[0] === 'status') return ['# branch.oid x', '# branch.head main'].join(NUL) + NUL;
      return '';
    });

  it('never runs a git command that writes or touches the network', async () => {
    const calls: string[][] = [];
    await getGitWorkspaceStatus('/w/never-network', { git: okRunner(calls) });
    const verbs = new Set(calls.map((a) => a[0]));
    for (const forbidden of ['fetch', 'pull', 'push', 'commit', 'add', 'checkout', 'reset', 'clean', 'gc']) {
      expect(verbs.has(forbidden), forbidden).toBe(false);
    }
    expect([...verbs].sort()).toEqual(['log', 'remote', 'rev-list', 'rev-parse', 'stash', 'status']);
  });

  it('shares one in-flight computation between concurrent callers', async () => {
    const calls: string[][] = [];
    const git = okRunner(calls);
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => getGitWorkspaceStatus('/w/shared', { git })));
    expect(calls.filter((x) => x[0] === 'status')).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('reuses a fresh result, recomputes after the TTL, and keeps folders apart', async () => {
    let t = 1_000_000;
    const calls: string[][] = [];
    const git = okRunner(calls);
    const get = (cwd: string) => getGitWorkspaceStatus(cwd, { git, now: () => t });
    await get('/w/a');
    t += 1000;
    await get('/w/a');
    expect(calls.filter((x) => x[0] === 'status')).toHaveLength(1);
    await get('/w/b');
    expect(calls.filter((x) => x[0] === 'status')).toHaveLength(2);
    t += 10_000;
    await get('/w/a');
    expect(calls.filter((x) => x[0] === 'status')).toHaveLength(3);
  });

  it('`fresh` skips the reuse of a recent result, but still joins a computation already running', async () => {
    let t = 1_000_000;
    const calls: string[][] = [];
    const git = okRunner(calls);
    const get = (fresh: boolean) => getGitWorkspaceStatus('/w/fresh', { git, now: () => t, fresh });
    await get(false);
    t += 500;
    await get(false); // reused
    expect(calls.filter((x) => x[0] === 'status')).toHaveLength(1);
    await get(true); // a person pressed Refresh
    expect(calls.filter((x) => x[0] === 'status')).toHaveLength(2);
    clearGitStatusCache();
    calls.length = 0;
    await Promise.all([get(true), get(true), get(true)]);
    expect(calls.filter((x) => x[0] === 'status')).toHaveLength(1);
  });

  it('maps "not a git repository" to not-a-repo', async () => {
    const git: GitRunner = async () => {
      throw Object.assign(new Error('x'), {
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      });
    };
    expect((await getGitWorkspaceStatus('/w/none', { git })).state).toBe('not-a-repo');
  });

  it('reports a missing git binary and a timeout as short errors', async () => {
    const enoent: GitRunner = async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    };
    expect(await getGitWorkspaceStatus('/w/e1', { git: enoent })).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/not installed/),
    });
    const slow: GitRunner = async () => {
      throw Object.assign(new Error('timed out'), { killed: true });
    };
    expect(await getGitWorkspaceStatus('/w/e2', { git: slow })).toMatchObject({
      state: 'error',
      error: 'git timed out',
    });
  });

  it('redacts credentials embedded in a remote URL from an error message', async () => {
    const git: GitRunner = async () => {
      throw Object.assign(new Error('x'), {
        stderr: "fatal: unable to access 'https://user:ghp_SECRET@github.com/o/r.git/'",
      });
    };
    const s = await getGitWorkspaceStatus('/w/redact', { git });
    expect(s.state).toBe('error');
    expect(s.error).not.toContain('ghp_SECRET');
    expect(s.error).toContain('***:***@');
  });

  it('survives the secondary calls failing: status still comes back', async () => {
    const git: GitRunner = async (_cwd, args) => {
      if (args[0] === 'status')
        return (
          ['# branch.oid x', '# branch.head main', '# branch.upstream o/main', '# branch.ab +3 -0'].join(NUL) + NUL
        );
      throw new Error('boom');
    };
    const s = await getGitWorkspaceStatus('/w/partial', { git });
    expect(s).toMatchObject({ state: 'ok', branch: 'main', ahead: 3, unpushedCount: 0, unpushed: [] });
  });
});

// ---------------------------------------------------------------------------
// Which repositories: getGitWorkspaceOverview
// ---------------------------------------------------------------------------

import { mkdirSync as mkdir, symlinkSync as symlink } from 'node:fs';
import {
  discoverChildRepos,
  getGitWorkspaceOverview,
  isUnrelatedAncestor,
  MAX_REPOS,
} from '../src/git-workspace-status.js';

describe('getGitWorkspaceOverview', () => {
  let top: string;
  let home: string;
  const repoAt = (p: string): string => {
    mkdir(p, { recursive: true });
    git(p, 'init', '-q', '-b', 'main');
    writeFileSync(join(p, 'f.txt'), '1\n');
    git(p, 'add', '-A');
    git(p, 'commit', '-q', '-m', 'c');
    return p;
  };
  const names = (o: { repos: { path: string }[] }) => o.repos.map((r) => r.path);

  beforeEach(() => {
    top = mkdtempSync(join(tmpdir(), 'git-overview-'));
    home = join(top, 'home');
    mkdir(home, { recursive: true });
    clearGitStatusCache();
  });
  afterEach(() => rmSync(top, { recursive: true, force: true }));

  it('a folder that holds several repositories reports each, alphabetically, with its own status', async () => {
    const ws = join(home, 'case');
    repoAt(join(ws, 'web'));
    repoAt(join(ws, 'api'));
    writeFileSync(join(ws, 'api', 'dirty.txt'), 'x');
    const o = await getGitWorkspaceOverview(ws, { home });
    expect(o.state).toBe('ok');
    expect(names(o)).toEqual(['api', 'web']);
    expect(o.repos.map((r) => r.name)).toEqual(['api', 'web']);
    expect(o.repos[0].status.counts.uncommitted).toBe(1);
    expect(o.repos[1].status.counts.uncommitted).toBe(0);
    expect(o.reposTruncated).toBe(false);
  });

  it('finds repositories two levels down but not three', async () => {
    const ws = join(home, 'case');
    repoAt(join(ws, 'apps', 'web'));
    repoAt(join(ws, 'a', 'b', 'too-deep'));
    const o = await getGitWorkspaceOverview(ws, { home });
    expect(names(o)).toEqual([join('apps', 'web')]);
  });

  it('a subfolder of a repository reports the whole enclosing repository, naming where it is', async () => {
    const r = repoAt(join(home, 'proj'));
    mkdir(join(r, 'src', 'deep'), { recursive: true });
    writeFileSync(join(r, 'top.txt'), 'x');
    const o = await getGitWorkspaceOverview(join(r, 'src', 'deep'), { home });
    expect(o.repos).toHaveLength(1);
    expect(o.repos[0]).toMatchObject({ name: 'proj', path: join('..', '..') });
    expect(o.repos[0].status.files.map((f) => f.path)).toContain('top.txt');
  });

  it('inside a repository it does not go looking for nested ones (they are just an untracked folder to the outer repo)', async () => {
    const r = repoAt(join(home, 'outer'));
    repoAt(join(r, 'vendor-ish', 'inner'));
    const o = await getGitWorkspaceOverview(r, { home });
    expect(names(o)).toEqual(['.']);
    expect(o.repos[0].status.files.map((f) => f.path)).toEqual(['vendor-ish/']);
  });

  it('a session started inside the nested repository reports that one', async () => {
    const r = repoAt(join(home, 'outer'));
    const inner = repoAt(join(r, 'vendor-ish', 'inner'));
    const o = await getGitWorkspaceOverview(inner, { home });
    expect(o.repos[0].name).toBe('inner');
  });

  it('ignores a repository that merely sits above the workspace and is the home folder (a dotfiles repo)', async () => {
    repoAt(home);
    writeFileSync(join(home, 'zshrc'), 'x'); // dirty, and nothing to do with this session
    const ws = join(home, 'codeman-cases', 'my-case');
    mkdir(ws, { recursive: true });
    const none = await getGitWorkspaceOverview(ws, { home });
    expect(none.state).toBe('not-a-repo');
    // ...but a project below the workspace is still found.
    repoAt(join(ws, 'real-project'));
    clearGitStatusCache();
    const some = await getGitWorkspaceOverview(ws, { home, fresh: true });
    expect(names(some)).toEqual(['real-project']);
  });

  it('ignores a repository above the home folder (including a repo at the very top)', async () => {
    repoAt(top); // contains `home`, so it is above it
    const ws = join(home, 'case');
    mkdir(ws, { recursive: true });
    expect((await getGitWorkspaceOverview(ws, { home })).state).toBe('not-a-repo');
  });

  it('but a workspace that IS the repository root is the session’s repository, even when that is the home folder', async () => {
    repoAt(home);
    const o = await getGitWorkspaceOverview(home, { home });
    expect(o.state).toBe('ok');
    expect(o.repos[0].path).toBe('.');
  });

  it('accepts an enclosing repository that is below the home folder, and one outside the home folder entirely', async () => {
    const r = repoAt(join(home, 'proj'));
    mkdir(join(r, 'sub'), { recursive: true });
    expect((await getGitWorkspaceOverview(join(r, 'sub'), { home })).state).toBe('ok');
    const elsewhere = repoAt(join(top, 'elsewhere', 'proj'));
    clearGitStatusCache();
    expect((await getGitWorkspaceOverview(elsewhere, { home })).state).toBe('ok');
  });

  it('skips node_modules, dot-folders and symbolic links when looking for repositories', async () => {
    const ws = join(home, 'case');
    repoAt(join(ws, 'node_modules', 'pkg'));
    repoAt(join(ws, '.hidden', 'secret'));
    const outside = repoAt(join(top, 'outside'));
    mkdir(ws, { recursive: true });
    symlink(outside, join(ws, 'linked'));
    repoAt(join(ws, 'real'));
    const o = await getGitWorkspaceOverview(ws, { home });
    expect(names(o)).toEqual(['real']);
  });

  it('counts a worktree (its .git is a file) as a repository', async () => {
    const main = repoAt(join(top, 'main-repo'));
    const ws = join(home, 'case');
    mkdir(ws, { recursive: true });
    git(main, 'worktree', 'add', '-q', '-b', 'feature', join(ws, 'wt'));
    const o = await getGitWorkspaceOverview(ws, { home });
    expect(names(o)).toEqual(['wt']);
    expect(o.repos[0].status.branch).toBe('feature');
  });

  it('caps how many repositories it reports and says so', async () => {
    const ws = join(home, 'case');
    for (let i = 0; i < MAX_REPOS + 3; i++) repoAt(join(ws, `p${String(i).padStart(2, '0')}`));
    const o = await getGitWorkspaceOverview(ws, { home });
    expect(o.repos).toHaveLength(MAX_REPOS);
    expect(o.reposTruncated).toBe(true);
    expect(names(o)[0]).toBe('p00');
  });

  it('is not-a-repo when there is no repository here or below, and reports a git failure as an error', async () => {
    const ws = join(home, 'empty');
    mkdir(join(ws, 'a'), { recursive: true });
    expect((await getGitWorkspaceOverview(ws, { home })).state).toBe('not-a-repo');
    clearGitStatusCache(); // the answer above is cached for this folder
    const broken: GitRunner = async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    };
    expect(await getGitWorkspaceOverview(ws, { home, git: broken })).toMatchObject({ state: 'error', repos: [] });
  });

  it('re-scans for repositories only every so often, unless a person asked for fresh', async () => {
    let t = 1_000_000;
    const ws = join(home, 'case');
    mkdir(ws, { recursive: true });
    repoAt(join(ws, 'one'));
    const get = (fresh = false) => getGitWorkspaceOverview(ws, { home, now: () => t, fresh });
    expect(names(await get())).toEqual(['one']);
    repoAt(join(ws, 'two'));
    t += 5000;
    expect(names(await get())).toEqual(['one']); // list reused
    expect(names(await get(true))).toEqual(['one', 'two']); // Refresh sees it
    t += 60_000;
    expect(names(await get())).toEqual(['one', 'two']); // and so does the next scan
  });

  it('discoverChildRepos never reads below a repository it found', async () => {
    const ws = join(home, 'case');
    repoAt(join(ws, 'outer'));
    repoAt(join(ws, 'outer', 'inner'));
    expect((await discoverChildRepos(ws)).dirs.map((d) => d.slice(ws.length + 1))).toEqual(['outer']);
  });

  it('isUnrelatedAncestor: home or above, but never the workspace root itself', async () => {
    mkdir(join(home, 'proj'), { recursive: true });
    expect(await isUnrelatedAncestor(home, join(home, 'proj'), home)).toBe(true);
    expect(await isUnrelatedAncestor(top, join(home, 'proj'), home)).toBe(true);
    expect(await isUnrelatedAncestor('/', join(home, 'proj'), home)).toBe(true);
    expect(await isUnrelatedAncestor(join(home, 'proj'), join(home, 'proj', 'x'), home)).toBe(false);
    expect(await isUnrelatedAncestor(home, home, home)).toBe(false);
  });
});

import { MAX_DIFF_BYTES, getGitFileDiff, isSafeRepoRelativePath } from '../src/git-workspace-status.js';

describe('isSafeRepoRelativePath', () => {
  it.each([
    ['a.txt', true],
    ['src/deep/x.ts', true],
    ['', false],
    ['-rf', true], // every operand follows `--`, so a leading dash is just a name
    ['-', true],
    ['/etc/passwd', false],
    ['../x', false],
    ['a/../../x', false],
    ['a\0b', false],
  ])('%j -> %s', (p, ok) => expect(isSafeRepoRelativePath(p)).toBe(ok));
});

describe('getGitFileDiff', () => {
  it('refuses an unsafe path without running git', async () => {
    const git = vi.fn(async () => '');
    await expect(getGitFileDiff('/r', { path: '../x', kind: 'unstaged' }, { git })).rejects.toThrow('Invalid path');
    expect(git).not.toHaveBeenCalled();
  });

  it('builds read-only, option-injection-safe commands per kind', async () => {
    const git = vi.fn(async (_cwd: string, _args: string[]) => '');
    await getGitFileDiff('/r', { path: 'a.txt', kind: 'unstaged' }, { git });
    await getGitFileDiff('/r', { path: 'b.txt', origPath: 'old.txt', kind: 'staged' }, { git });
    const [unstaged, staged] = git.mock.calls.map((c) => c[1]);
    for (const args of [unstaged, staged]) {
      expect(args).toContain('--no-ext-diff');
      expect(args).toContain('--no-textconv');
      expect(args.indexOf('--')).toBeGreaterThan(0);
    }
    expect(unstaged.slice(-2)).toEqual(['--', 'a.txt']);
    expect(staged).toContain('--cached');
    expect(staged.slice(-3)).toEqual(['--', 'old.txt', 'b.txt']);
  });

  it('treats --no-index exit 1 as the normal untracked result', async () => {
    const git = vi.fn(async () => {
      throw Object.assign(new Error('exit 1'), { code: 1, stdout: '+hello\n' });
    });
    await expect(getGitFileDiff('/r', { path: 'n.txt', kind: 'untracked' }, { git })).resolves.toMatchObject({
      diff: '+hello\n',
    });
    const boom = vi.fn(async () => {
      throw Object.assign(new Error('exit 128'), { code: 128, stdout: '' });
    });
    await expect(getGitFileDiff('/r', { path: 'n.txt', kind: 'untracked' }, { git: boom })).rejects.toThrow();
  });

  it('flags binary output and cuts an oversized diff at a line boundary', async () => {
    const bin = await getGitFileDiff(
      '/r',
      { path: 'x.png', kind: 'unstaged' },
      { git: async () => 'Binary files a/x.png and b/x.png differ\n' }
    );
    expect(bin.binary).toBe(true);
    const big = ('+' + 'x'.repeat(99) + '\n').repeat(Math.ceil(MAX_DIFF_BYTES / 100) + 50);
    const cut = await getGitFileDiff('/r', { path: 'big', kind: 'unstaged' }, { git: async () => big });
    expect(cut.truncated).toBe(true);
    expect(cut.diff.length).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(cut.diff.endsWith('x')).toBe(true);
  });
});

describe('Docker case workspaces are never inspected', () => {
  let top: string;
  let home: string;
  const repoAt = (p: string): string => {
    mkdir(p, { recursive: true });
    git(p, 'init', '-q', '-b', 'main');
    writeFileSync(join(p, 'f.txt'), '1\n');
    git(p, 'add', '-A');
    git(p, 'commit', '-q', '-m', 'c');
    return p;
  };
  /** A repository whose clean filter drops a marker file: proof that git ran on it. */
  const booby = (p: string): string => {
    repoAt(p);
    git(p, 'config', 'filter.mark.clean', 'touch RAN; cat');
    writeFileSync(join(p, '.gitattributes'), 'f.txt filter=mark\n');
    // Same size as the committed '1\n', so git must read the content (running the filter) to see the change.
    writeFileSync(join(p, 'f.txt'), 'x\n');
    return p;
  };

  beforeEach(() => {
    top = mkdtempSync(join(tmpdir(), 'git-docker-'));
    home = join(top, 'home');
    mkdir(home, { recursive: true });
    clearGitStatusCache();
  });
  afterEach(() => rmSync(top, { recursive: true, force: true }));

  it('control: without the exclusion git does run the repository’s clean filter', async () => {
    const ws = join(home, 'case');
    booby(join(ws, 'proj'));
    await getGitWorkspaceOverview(ws, { home, git: undefined });
    expect(existsSync(join(ws, 'proj', 'RAN'))).toBe(true);
  });

  it('drops a Docker workspace found below the folder, and runs nothing in it', async () => {
    const ws = join(home, 'case');
    booby(join(ws, 'sandbox'));
    repoAt(join(ws, 'plain'));
    const o = await getGitWorkspaceOverview(ws, { home, dockerWorkspaces: [join(ws, 'sandbox')] });
    expect(o.repos.map((r) => r.path)).toEqual(['plain']);
    expect(existsSync(join(ws, 'sandbox', 'RAN'))).toBe(false);
  });

  it('answers unsupported/docker for a folder at or inside a Docker workspace, before any git runs', async () => {
    const dock = booby(join(home, 'dock'));
    mkdir(join(dock, 'sub'));
    for (const cwd of [dock, join(dock, 'sub')]) {
      clearGitStatusCache();
      const git = vi.fn(async () => '');
      const o = await getGitWorkspaceOverview(cwd, { home, git, dockerWorkspaces: [dock] });
      expect(o).toMatchObject({ state: 'unsupported', reason: 'docker', repos: [] });
      expect(git).not.toHaveBeenCalled();
    }
    expect(existsSync(join(dock, 'RAN'))).toBe(false);
  });

  it('sees through a symlink to the workspace', async () => {
    const dock = booby(join(home, 'dock'));
    const ws = join(home, 'case');
    mkdir(ws, { recursive: true });
    symlink(dock, join(ws, 'link'));
    const o = await getGitWorkspaceOverview(join(ws, 'link'), { home, dockerWorkspaces: [dock] });
    expect(o.state).toBe('unsupported');
    expect(existsSync(join(dock, 'RAN'))).toBe(false);
  });

  it('a folder next to the workspace, and one whose name merely starts the same, are not excluded', async () => {
    const dock = join(home, 'dock');
    const sibling = repoAt(join(home, 'dock-two'));
    mkdir(dock, { recursive: true });
    const o = await getGitWorkspaceOverview(sibling, { home, dockerWorkspaces: [dock] });
    expect(o.state).toBe('ok');
  });
});
