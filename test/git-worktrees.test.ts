/**
 * @fileoverview src/git-worktrees.ts: the pure rules (worktree and branch names, `worktree list`
 * parsing, the managed-path rule, exclude text) without git, then the IO half against a REAL temp
 * repository (create, list, exclude, symlink guards, remove without --force, `branch -d`), plus an
 * injected runner proving the Docker refusal never spawns git at all. Port: N/A.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentSkillExcludeLine,
  createCaseWorktree,
  defaultWorktreeBranch,
  excludeAppendText,
  gitRefusalText,
  isPathWithin,
  listCaseWorktrees,
  managedWorktreeName,
  parseWorktreeList,
  removeCaseWorktree,
  resolveCaseRepository,
  resolveManagedWorktree,
  respellUnder,
  runWorktreeGit,
  unquoteGitPath,
  worktreeBaseError,
  worktreeBranchError,
  worktreeNameError,
  type CaseRepository,
  type WorktreeGitRunner,
} from '../src/git-worktrees.js';

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

describe('worktreeNameError', () => {
  it.each(['fix-login', 'a', 'v1.2', 'under_score', 'A9', 'x'.repeat(64)])('accepts %s', (name) => {
    expect(worktreeNameError(name)).toBeNull();
  });
  it.each([
    ['', 'required'],
    ['x'.repeat(65), 'at most 64'],
    ['-flag', 'start with a letter'],
    ['.hidden', 'start with a letter'],
    ['a/b', 'only letters'],
    ['a b', 'only letters'],
    ['a..b', '".."'],
    ['name.', 'end with'],
    ['name.lock', 'end with'],
    ['semi;colon', 'only letters'],
    ['ünï', 'only letters'],
  ])('refuses %j', (name, why) => {
    expect(worktreeNameError(name)).toContain(why);
  });
  it('refuses a non-string', () => {
    expect(worktreeNameError(undefined)).not.toBeNull();
    expect(worktreeNameError(42)).not.toBeNull();
  });
});

describe('branch and base gates', () => {
  it('derives Claude Code’s default branch name', () => {
    expect(defaultWorktreeBranch('fix-login')).toBe('worktree-fix-login');
  });
  it.each(['main', 'feat/login', 'worktree-a.b', 'user/x_y-z'])('accepts branch %s', (b) => {
    expect(worktreeBranchError(b)).toBeNull();
  });
  it.each(['-D', '@{-1}', 'a..b', 'a//b', 'trail/', 'x.lock', 'feat/.hidden', 'sp ace', 'a~1', 'a^', 'a:b'])(
    'refuses branch %j',
    (b) => {
      expect(worktreeBranchError(b)).not.toBeNull();
    }
  );
  it('gates the base like Clone Repo’s ref', () => {
    expect(worktreeBaseError('HEAD')).toBeNull();
    expect(worktreeBaseError('origin/main')).toBeNull();
    expect(worktreeBaseError('--upload-pack=x')).not.toBeNull();
    expect(worktreeBaseError('HEAD@{1}')).not.toBeNull();
  });
});

describe('paths', () => {
  it('names only <repo>/.claude/worktrees/<valid-name>', () => {
    expect(managedWorktreeName('/r', '/r/.claude/worktrees/a')).toBe('a');
    expect(managedWorktreeName('/r', '/r/.claude/worktrees/a/')).toBe('a');
    expect(managedWorktreeName('/r', '/r/.claude/worktrees/a/sub')).toBeNull();
    expect(managedWorktreeName('/r', '/r/.claude/worktrees/')).toBeNull();
    expect(managedWorktreeName('/r', '/r/../x/.claude/worktrees/a')).toBeNull();
    expect(managedWorktreeName('/r', '/other/.claude/worktrees/a')).toBeNull();
    expect(managedWorktreeName('/r', '/r/.claude/worktrees/-x')).toBeNull();
  });
  it('isPathWithin is a segment match, not a string prefix', () => {
    expect(isPathWithin('/r/.claude/worktrees/a', '/r/.claude/worktrees/a')).toBe(true);
    expect(isPathWithin('/r/.claude/worktrees/a/src', '/r/.claude/worktrees/a')).toBe(true);
    expect(isPathWithin('/r/.claude/worktrees/ab', '/r/.claude/worktrees/a')).toBe(false);
  });
  it('respellUnder moves a path named through the case link onto the real repository root', () => {
    expect(respellUnder('/link/.claude/worktrees/a', '/link', '/real')).toBe('/real/.claude/worktrees/a');
    expect(respellUnder('/link/.claude/worktrees/a/src/', '/link', '/real')).toBe('/real/.claude/worktrees/a/src');
    expect(respellUnder('/link', '/link', '/real')).toBe('/real');
    // Not under the alias (a segment match, never a string prefix), or no alias at all: unchanged.
    expect(respellUnder('/linked/x', '/link', '/real')).toBe('/linked/x');
    expect(respellUnder('/real/.claude/worktrees/a', '/link', '/real')).toBe('/real/.claude/worktrees/a');
    expect(respellUnder('/real/x', '/real', '/real')).toBe('/real/x');
  });
});

describe('parseWorktreeList', () => {
  it('parses main, branch, detached, locked and prunable records', () => {
    const text = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/.claude/worktrees/a',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/worktree-a',
      'locked busy agent',
      '',
      'worktree /elsewhere/b',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    const list = parseWorktreeList(text);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ path: '/repo', branch: 'main', detached: false, locked: false });
    expect(list[1]).toMatchObject({ branch: 'worktree-a', locked: true, lockReason: 'busy agent' });
    expect(list[2]).toMatchObject({ branch: null, detached: true, prunable: true });
  });
  it('reads a bare record and a record with no trailing blank line', () => {
    const list = parseWorktreeList('worktree /bare.git\nbare\n\nworktree /w\nHEAD abc\nbranch refs/heads/x');
    expect(list[0]).toMatchObject({ bare: true, head: null });
    expect(list[1]).toMatchObject({ path: '/w', branch: 'x' });
  });
  it('unquotes a C-quoted path', () => {
    expect(parseWorktreeList('worktree "/r/a\\"b\\303\\251"\nHEAD x\n')[0].path).toBe('/r/a"bé');
  });
});

describe('unquoteGitPath', () => {
  it('leaves plain text alone and decodes escapes', () => {
    expect(unquoteGitPath('/plain path')).toBe('/plain path');
    expect(unquoteGitPath('"/a\\tb\\\\c"')).toBe('/a\tb\\c');
    expect(unquoteGitPath('"/\\344\\275\\240"')).toBe('/你');
  });
});

describe('excludeAppendText', () => {
  it('adds only what is missing, after a newline the file lacked', () => {
    const r = excludeAppendText('*.log', ['/.claude/worktrees/', '/.claude/settings.local.json']);
    expect(r.added).toEqual(['/.claude/worktrees/', '/.claude/settings.local.json']);
    expect(r.text.startsWith('\n# Added by Codeman')).toBe(true);
    expect(r.text.endsWith('/.claude/settings.local.json\n')).toBe(true);
  });
  it('is a no-op when every line is present', () => {
    expect(excludeAppendText('/.claude/worktrees/\n', ['/.claude/worktrees/'])).toEqual({ text: '', added: [] });
  });
  it('agentSkillExcludeLine names the skill copy of a plain relative skills folder only', () => {
    expect(agentSkillExcludeLine('.claude/skills')).toBe('/.claude/skills/codeman/');
    expect(agentSkillExcludeLine('.agents/skills')).toBe('/.agents/skills/codeman/');
    for (const bad of ['', '/abs', 'a/../b', 'a//b', '.', 'x/', 'a b', '*', '!neg']) {
      expect(agentSkillExcludeLine(bad), bad).toBeNull();
    }
  });
});

describe('gitRefusalText', () => {
  it('keeps fatal/error lines, drops hints and control bytes', () => {
    const t = gitRefusalText(
      "fatal: '.claude/worktrees/a' contains modified or untracked files, use --force to delete it\nhint: x\n\u001b[31m"
    );
    expect(t).toBe("fatal: '.claude/worktrees/a' contains modified or untracked files, use --force to delete it");
  });
});

// ─── IO against a real repository ────────────────────────────────────────────

describe('git worktrees on a real repository', () => {
  let dir: string;
  let repoDir: string;
  let repo: CaseRepository;

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-worktrees-')));
    repoDir = join(dir, 'repo');
    mkdirSync(repoDir);
    git(repoDir, 'init', '-q', '-b', 'main');
    writeFileSync(join(repoDir, 'a.txt'), '1\n');
    git(repoDir, 'add', 'a.txt');
    git(repoDir, 'commit', '-q', '-m', 'base');
    const resolved = await resolveCaseRepository(repoDir, { home: '/nonexistent-home' });
    if (!resolved.ok) throw new Error(resolved.message);
    repo = resolved.repo;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the repository root and the real common git dir', () => {
    expect(repo.repoRoot).toBe(repoDir);
    expect(repo.commonDir).toBe(join(repoDir, '.git'));
  });

  it('refuses a folder that is not a repository, and one below the top level', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const notRepo = await resolveCaseRepository(plain, { home: '/nonexistent-home' });
    expect(notRepo).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    mkdirSync(join(repoDir, 'sub'));
    const sub = await resolveCaseRepository(join(repoDir, 'sub'), { home: '/nonexistent-home' });
    expect(sub.ok).toBe(false);
    if (!sub.ok) expect(sub.message).toContain('top of a git repository');
  });

  it('treats a repository at the home folder above the case as no repository', async () => {
    mkdirSync(join(repoDir, 'proj'));
    const r = await resolveCaseRepository(join(repoDir, 'proj'), { home: repoDir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('This case folder is not a git repository.');
  });

  it('never spawns git for a case inside a Docker case workspace', async () => {
    let spawned = 0;
    const spy: WorktreeGitRunner = async () => {
      spawned++;
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    const r = await resolveCaseRepository(repoDir, { git: spy, dockerWorkspaces: [dir] });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(spawned).toBe(0);
  });

  it('creates <repo>/.claude/worktrees/<name> on worktree-<name>, excluded from the main checkout', async () => {
    const created = await createCaseWorktree(repo, { name: 'fix-login' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const wtPath = join(repoDir, '.claude', 'worktrees', 'fix-login');
    expect(created.worktree).toMatchObject({ path: wtPath, branch: 'worktree-fix-login', base: 'HEAD' });
    expect(created.worktree.excludeAdded).toEqual(['/.claude/worktrees/', '/.claude/settings.local.json']);
    expect(readFileSync(join(wtPath, 'a.txt'), 'utf-8')).toBe('1\n');
    expect(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('worktree-fix-login');
    // The main checkout stays clean: the worktree folder is excluded, not untracked.
    expect(git(repoDir, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repoDir, '.git', 'info', 'exclude'), 'utf-8')).toContain('/.claude/worktrees/');
    // A hooks file Codeman would write into the worktree does not make it dirty either.
    mkdirSync(join(wtPath, '.claude'), { recursive: true });
    writeFileSync(join(wtPath, '.claude', 'settings.local.json'), '{}');
    expect(git(wtPath, 'status', '--porcelain')).toBe('');

    // A second create with the same lines already present appends nothing.
    const second = await createCaseWorktree(repo, { name: 'other', branch: 'feat/other' });
    expect(second.ok && second.worktree.excludeAdded).toEqual([]);
    const listed = await listCaseWorktrees(repo);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.worktrees.map((w) => [w.main, w.isCase, w.managed, w.name ?? null, w.branch])).toEqual([
      [true, true, false, null, 'main'],
      [false, false, true, 'fix-login', 'worktree-fix-login'],
      [false, false, true, 'other', 'feat/other'],
    ]);
  });

  it('refuses an existing branch, a bad base, a bad branch and a taken folder before touching anything', async () => {
    git(repoDir, 'branch', 'worktree-taken');
    expect(await createCaseWorktree(repo, { name: 'taken' })).toMatchObject({ ok: false, code: 'ALREADY_EXISTS' });
    expect(await createCaseWorktree(repo, { name: 'x', base: 'nosuchref' })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await createCaseWorktree(repo, { name: 'x', branch: '@{-1}' })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await createCaseWorktree(repo, { name: '../escape' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    mkdirSync(join(repoDir, '.claude', 'worktrees', 'busy'), { recursive: true });
    expect(await createCaseWorktree(repo, { name: 'busy' })).toMatchObject({ ok: false, code: 'ALREADY_EXISTS' });
    expect(git(repoDir, 'branch', '--list', 'worktree-busy')).toBe('');
  });

  it('names a taken worktree name as such, not as its derived branch', async () => {
    expect((await createCaseWorktree(repo, { name: 'dup' })).ok).toBe(true);
    const again = await createCaseWorktree(repo, { name: 'dup' });
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_EXISTS' });
    if (!again.ok) expect(again.message).toBe('A worktree named "dup" already exists in this case.');
  });

  it('says a bare repository is bare', async () => {
    const bare = join(dir, 'bare.git');
    git(dir, 'init', '-q', '--bare', bare);
    const r = await resolveCaseRepository(bare, { home: '/nonexistent-home' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('bare git repository');
  });

  it('starts from a named base', async () => {
    git(repoDir, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repoDir, 'b.txt'), '2\n');
    git(repoDir, 'add', 'b.txt');
    git(repoDir, 'commit', '-q', '-m', 'side');
    git(repoDir, 'checkout', '-q', 'main');
    const created = await createCaseWorktree(repo, { name: 'from-side', base: 'side' });
    expect(created.ok).toBe(true);
    expect(readFileSync(join(repoDir, '.claude', 'worktrees', 'from-side', 'b.txt'), 'utf-8')).toBe('2\n');
  });

  it('refuses to create through a symlinked .claude or worktrees directory', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(join(outside, 'worktrees'), { recursive: true });
    symlinkSync(outside, join(repoDir, '.claude'));
    const viaClaude = await createCaseWorktree(repo, { name: 'evil' });
    expect(viaClaude).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    if (!viaClaude.ok) expect(viaClaude.message).toContain('symlink');
    rmSync(join(repoDir, '.claude'));
    mkdirSync(join(repoDir, '.claude'));
    symlinkSync(join(outside, 'worktrees'), join(repoDir, '.claude', 'worktrees'));
    expect(await createCaseWorktree(repo, { name: 'evil' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(git(repoDir, 'worktree', 'list', '--porcelain')).not.toContain('evil');
  });

  it('removes a clean worktree, refuses a dirty one and a live one, and never force-deletes', async () => {
    const created = await createCaseWorktree(repo, { name: 'w1' });
    expect(created.ok).toBe(true);
    const wtPath = join(repoDir, '.claude', 'worktrees', 'w1');

    const live = await removeCaseWorktree(repo, { name: 'w1', isInUse: (p) => p === wtPath });
    expect(live).toMatchObject({ ok: false, code: 'CONFLICT' });

    writeFileSync(join(wtPath, 'scratch.txt'), 'untracked work');
    const dirty = await removeCaseWorktree(repo, { name: 'w1', isInUse: () => false });
    expect(dirty).toMatchObject({ ok: false, code: 'CONFLICT' });
    if (!dirty.ok) expect(dirty.gitMessage).toContain('contains modified or untracked files');
    expect(readFileSync(join(wtPath, 'scratch.txt'), 'utf-8')).toBe('untracked work');

    rmSync(join(wtPath, 'scratch.txt'));
    const clean = await removeCaseWorktree(repo, { name: 'w1', deleteBranch: true, isInUse: () => false });
    expect(clean).toMatchObject({ ok: true, removed: { name: 'w1', branch: 'worktree-w1', branchDeleted: true } });
    expect(git(repoDir, 'branch', '--list', 'worktree-w1')).toBe('');
    expect(git(repoDir, 'worktree', 'list', '--porcelain')).not.toContain('w1');
  });

  it('never removes a worktree that is, or holds, a Docker case workspace', async () => {
    const made = await createCaseWorktree(repo, { name: 'boxed' });
    if (!made.ok) throw new Error(made.message);
    const wtPath = made.worktree.path;
    mkdirSync(join(wtPath, 'sandbox'));
    // The worktree IS a Docker case's workspace, or one sits inside it: refused before git runs,
    // and nothing is deleted. git still lists it.
    for (const dockerWorkspaces of [[wtPath], [join(wtPath, 'sandbox')]]) {
      let spawned = 0;
      const counting: WorktreeGitRunner = async (cwd, args, o) => {
        if (args.includes('remove')) spawned++;
        return runWorktreeGit(cwd, args, o);
      };
      const r = await removeCaseWorktree(
        repo,
        { name: 'boxed', isInUse: () => false },
        { git: counting, dockerWorkspaces }
      );
      expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      if (!r.ok) expect(r.message).toContain('Docker case workspace');
      expect(spawned).toBe(0);
      expect(existsSync(join(wtPath, 'a.txt'))).toBe(true);
    }
    expect(git(repoDir, 'worktree', 'list', '--porcelain')).toContain('boxed');
    // An unrelated Docker workspace does not get in the way.
    rmSync(join(wtPath, 'sandbox'), { recursive: true });
    const elsewhere = join(dir, 'other-box');
    mkdirSync(elsewhere);
    const ok = await removeCaseWorktree(
      repo,
      { name: 'boxed', isInUse: () => false },
      { dockerWorkspaces: [elsewhere] }
    );
    expect(ok.ok).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('keeps an unmerged branch: git branch -d refuses, never -D', async () => {
    await createCaseWorktree(repo, { name: 'w2' });
    const wtPath = join(repoDir, '.claude', 'worktrees', 'w2');
    writeFileSync(join(wtPath, 'new.txt'), 'x');
    git(wtPath, 'add', 'new.txt');
    git(wtPath, 'commit', '-q', '-m', 'work');
    const r = await removeCaseWorktree(repo, { name: 'w2', deleteBranch: true, isInUse: () => false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed.branchDeleted).toBe(false);
    expect(r.removed.branchError).toContain('not fully merged');
    expect(git(repoDir, 'branch', '--list', 'worktree-w2')).toContain('worktree-w2');
  });

  it('only removes a registered worktree that is a real directory', async () => {
    mkdirSync(join(repoDir, '.claude', 'worktrees', 'stray'), { recursive: true });
    expect(await removeCaseWorktree(repo, { name: 'stray', isInUse: () => false })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await removeCaseWorktree(repo, { name: 'missing', isInUse: () => false })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    // A symlink at the worktree's own place is refused, never followed.
    await createCaseWorktree(repo, { name: 'real' });
    symlinkSync(join(repoDir, '.claude', 'worktrees', 'real'), join(repoDir, '.claude', 'worktrees', 'link'));
    expect(await resolveManagedWorktree(repo, 'link')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('refuses a locked worktree', async () => {
    await createCaseWorktree(repo, { name: 'locked' });
    git(repoDir, 'worktree', 'lock', '--reason', 'agent busy', join(repoDir, '.claude', 'worktrees', 'locked'));
    const r = await removeCaseWorktree(repo, { name: 'locked', isInUse: () => false });
    expect(r).toMatchObject({ ok: false, code: 'CONFLICT' });
    if (!r.ok) expect(r.message).toContain('agent busy');
  });

  it('removes a worktree whose folder was deleted by hand, so its name can be used again', async () => {
    const made = await createCaseWorktree(repo, { name: 'gone' });
    if (!made.ok) throw new Error(made.message);
    rmSync(made.worktree.path, { recursive: true, force: true });
    const listed = await listCaseWorktrees(repo);
    expect(listed.ok && listed.worktrees.find((w) => w.name === 'gone')).toMatchObject({
      managed: true,
      prunable: true,
    });
    // A session never starts in it; only removal accepts a missing folder.
    expect(await resolveManagedWorktree(repo, 'gone')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    // Before the fix this was NOT_FOUND, and both ways of reusing the name failed.
    const r = await removeCaseWorktree(repo, { name: 'gone', deleteBranch: true, isInUse: () => false });
    expect(r).toMatchObject({ ok: true, removed: { name: 'gone', branch: 'worktree-gone', branchDeleted: true } });
    expect(git(repoDir, 'worktree', 'list', '--porcelain')).not.toContain('gone');
    expect((await createCaseWorktree(repo, { name: 'gone' })).ok).toBe(true);
  });

  it('refuses a missing worktree that a live session still names, or that is locked', async () => {
    const made = await createCaseWorktree(repo, { name: 'held' });
    if (!made.ok) throw new Error(made.message);
    git(repoDir, 'worktree', 'lock', '--reason', 'on a removable disk', made.worktree.path);
    rmSync(made.worktree.path, { recursive: true, force: true });
    expect(await removeCaseWorktree(repo, { name: 'held', isInUse: () => true })).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    });
    const locked = await removeCaseWorktree(repo, { name: 'held', isInUse: () => false });
    expect(locked).toMatchObject({ ok: false, code: 'CONFLICT' });
    if (!locked.ok) expect(locked.message).toContain('removable disk');
  });

  it('never follows a symlink on the way to a missing worktree', async () => {
    const made = await createCaseWorktree(repo, { name: 'via' });
    if (!made.ok) throw new Error(made.message);
    // The whole worktrees folder replaced by a link to somewhere else.
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(join(repoDir, '.claude', 'worktrees'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(repoDir, '.claude', 'worktrees'));
    expect(await removeCaseWorktree(repo, { name: 'via', isInUse: () => false })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });
});
