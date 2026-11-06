/**
 * @fileoverview `findLiveWorktree()` for a worktree OUTSIDE the session's folder (#765 follow-up).
 *
 * Such a worktree becomes a second root the file routes serve, so what matters is what must NOT be
 * followed: a folder the session's repository does not list, a forged `.git` file with no registry
 * entry naming it back, another repository, the home folder or anything above it, a folder holding
 * the session's folder, a Docker case workspace, and a folder the multi-user rule refuses. Runs
 * against worktrees real git made, since the registry files are the thing being read.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative as posixRelative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLiveWorktree, findOutsideWorktree } from '../src/live-worktree.js';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
};

describe('findLiveWorktree outside the session folder', () => {
  let base: string;
  let repo: string;
  let sibling: string;
  /** Not the user's real home: the base folder must not count as "home or above". */
  let home: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'outside-worktree-')));
    home = join(base, 'home');
    mkdirSync(home);
    repo = join(base, 'myapp');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), 'main');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'init');
    sibling = join(base, 'myapp-feature');
    git(repo, 'worktree', 'add', '-q', sibling);
    mkdirSync(join(sibling, 'src', 'deep'), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const expected = () => ({ name: 'myapp-feature', path: sibling, outside: true });

  it('follows a sibling worktree of the session repository, from its root and from below it', async () => {
    expect(await findLiveWorktree(repo, sibling, { home })).toEqual(expected());
    expect(await findLiveWorktree(repo, join(sibling, 'src', 'deep'), { home })).toEqual(expected());
  });

  it('follows nothing outside the folder unless the caller passes the outside rules', async () => {
    expect(await findLiveWorktree(repo, sibling)).toBeUndefined();
  });

  it('follows a worktree whose gitdir links are relative paths, whatever the git version', async () => {
    // Hand-written, since git older than 2.48 cannot make this layout itself.
    const relative = join(base, 'myapp-relative');
    const entry = join(repo, '.git', 'worktrees', 'myapp-relative');
    mkdirSync(relative);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'gitdir'), `${posixRelative(entry, join(relative, '.git'))}\n`);
    writeFileSync(join(relative, '.git'), `gitdir: ${posixRelative(relative, entry)}\n`);
    expect(await findLiveWorktree(repo, relative, { home })).toEqual({
      name: 'myapp-relative',
      path: relative,
      outside: true,
    });
  });

  it('follows a worktree made with --relative-paths', async (ctx) => {
    const relative = join(base, 'myapp-relative-git');
    try {
      git(repo, 'worktree', 'add', '-q', '--relative-paths', relative);
    } catch {
      ctx.skip(); // git older than 2.48 has no --relative-paths
      return;
    }
    expect(await findLiveWorktree(repo, relative, { home })).toEqual({
      name: 'myapp-relative-git',
      path: relative,
      outside: true,
    });
  });

  it('follows the main worktree and other worktrees from a session started in a linked one', async () => {
    const other = join(base, 'myapp-other');
    git(repo, 'worktree', 'add', '-q', other);
    expect(await findLiveWorktree(sibling, repo, { home })).toEqual({ name: 'myapp', path: repo, outside: true });
    expect(await findLiveWorktree(sibling, other, { home })).toEqual({
      name: 'myapp-other',
      path: other,
      outside: true,
    });
  });

  it('answers with the real path when the pane reached the worktree through a symlink', async () => {
    const link = join(base, 'link-to-feature');
    symlinkSync(sibling, link);
    expect(await findLiveWorktree(repo, join(link, 'src'), { home })).toEqual(expected());
  });

  it('refuses a folder in another repository, and one in no repository at all', async () => {
    const otherRepo = join(base, 'other');
    mkdirSync(otherRepo);
    git(otherRepo, 'init', '-q');
    expect(await findLiveWorktree(repo, otherRepo, { home })).toBeUndefined();
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(await findLiveWorktree(repo, plain, { home })).toBeUndefined();
  });

  it('refuses a worktree of ANOTHER repository, even one laid out the same way', async () => {
    const otherRepo = join(base, 'other');
    mkdirSync(otherRepo);
    git(otherRepo, 'init', '-q');
    writeFileSync(join(otherRepo, 'a'), 'a');
    git(otherRepo, 'add', 'a');
    git(otherRepo, 'commit', '-q', '-m', 'a');
    const otherWorktree = join(base, 'other-feature');
    git(otherRepo, 'worktree', 'add', '-q', otherWorktree);
    expect(await findLiveWorktree(repo, otherWorktree, { home })).toBeUndefined();
  });

  it('refuses a forged .git file that the registry does not name back', async () => {
    const forged = join(base, 'forged');
    mkdirSync(forged);
    // Points at the real registry entry of the sibling, whose `gitdir` names the sibling.
    const entry = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: sibling, encoding: 'utf8' }).trim();
    writeFileSync(join(forged, '.git'), `gitdir: ${entry}\n`);
    expect(await findLiveWorktree(repo, forged, { home })).toBeUndefined();
  });

  it('refuses a registry entry that names a .git symlink back', async () => {
    const entry = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: sibling, encoding: 'utf8' }).trim();
    // The symlink leads to a copy of the original `gitdir` file, whose text is `<sibling>/.git`,
    // so only the refusal of a symlink can stop it: followed, it would name the sibling back.
    const copy = join(base, 'gitdir-copy');
    writeFileSync(copy, readFileSync(join(entry, 'gitdir')));
    rmSync(join(entry, 'gitdir'));
    symlinkSync(copy, join(entry, 'gitdir'));
    expect(await findLiveWorktree(repo, sibling, { home })).toBeUndefined();
  });

  it('refuses a .git file that is a symlink', async () => {
    const text = execFileSync('cat', [join(sibling, '.git')], { encoding: 'utf8' });
    const copy = join(base, 'dot-git-copy');
    writeFileSync(copy, text);
    rmSync(join(sibling, '.git'));
    symlinkSync(copy, join(sibling, '.git'));
    expect(await findLiveWorktree(repo, sibling, { home })).toBeUndefined();
  });

  it('refuses a folder whose .git is a symlink to the repository’s .git folder', async () => {
    const fake = join(base, 'fake');
    mkdirSync(fake);
    symlinkSync(join(repo, '.git'), join(fake, '.git'));
    // From a session in the main checkout.
    expect(await findLiveWorktree(repo, fake, { home })).toBeUndefined();
    // From a session in a linked worktree.
    expect(await findLiveWorktree(sibling, fake, { home })).toBeUndefined();
    // The real main worktree is still followed from the same session.
    expect(await findLiveWorktree(sibling, repo, { home })).toEqual({ name: 'myapp', path: repo, outside: true });
  });

  it('follows nothing from a session started in a subfolder of its repository', async () => {
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    expect(await findLiveWorktree(sub, sibling, { home })).toBeUndefined();
  });

  it('refuses a worktree at or above the home folder', async () => {
    expect(await findLiveWorktree(repo, sibling, { home: join(sibling, 'src') })).toBeUndefined();
    expect(await findLiveWorktree(repo, sibling, { home: sibling })).toBeUndefined();
  });

  it('refuses a worktree that holds the session folder', async () => {
    // A registry entry forged around the session's own folder: `base` holds `repo`. Both halves
    // of the link are in place, so only the containment rule can refuse it.
    const entry = join(repo, '.git', 'worktrees', 'around');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'gitdir'), `${join(base, '.git')}\n`);
    writeFileSync(join(base, '.git'), `gitdir: ${entry}\n`);
    const elsewhereHome = realpathSync(mkdtempSync(join(tmpdir(), 'outside-worktree-home-')));
    try {
      expect(await findOutsideWorktree(repo, base, { home: elsewhereHome })).toBeUndefined();
      // The same forged link around a folder that does NOT hold the session folder is followed,
      // which shows the refusal above came from the containment rule.
      const loose = join(base, 'loose');
      mkdirSync(loose);
      const looseEntry = join(repo, '.git', 'worktrees', 'loose');
      mkdirSync(looseEntry, { recursive: true });
      writeFileSync(join(looseEntry, 'gitdir'), `${join(loose, '.git')}\n`);
      writeFileSync(join(loose, '.git'), `gitdir: ${looseEntry}\n`);
      expect(await findOutsideWorktree(repo, loose, { home: elsewhereHome })).toEqual({
        name: 'loose',
        path: loose,
        outside: true,
      });
    } finally {
      rmSync(elsewhereHome, { recursive: true, force: true });
    }
  });

  it('refuses a worktree at, inside or around a Docker case workspace', async () => {
    const at = async () => [sibling];
    const around = async () => [join(sibling, 'src')];
    const above = async () => [base];
    expect(await findLiveWorktree(repo, sibling, { home, dockerWorkspaces: at })).toBeUndefined();
    expect(await findLiveWorktree(repo, sibling, { home, dockerWorkspaces: around })).toBeUndefined();
    expect(await findLiveWorktree(repo, sibling, { home, dockerWorkspaces: above })).toBeUndefined();
    const elsewhere = async () => [join(base, 'elsewhere')];
    expect(await findLiveWorktree(repo, sibling, { home, dockerWorkspaces: elsewhere })).toEqual(expected());
  });

  it('follows nothing while the Docker case list cannot be read', async () => {
    const unreadable = async (): Promise<string[]> => {
      throw new Error('docker-cases.json mid-write');
    };
    expect(await findLiveWorktree(repo, sibling, { home, dockerWorkspaces: unreadable })).toBeUndefined();
  });

  it('lets allowRoot refuse the worktree, and passes it the real path', async () => {
    const seen: string[] = [];
    const refuse = (root: string) => {
      seen.push(root);
      return false;
    };
    expect(await findLiveWorktree(repo, sibling, { home, allowRoot: refuse })).toBeUndefined();
    expect(seen).toEqual([sibling]);
    expect(await findLiveWorktree(repo, sibling, { home, allowRoot: async () => true })).toEqual(expected());
  });

  it('treats an allowRoot that rejects as a refusal', async () => {
    const reject = async () => {
      throw new Error('settings unreadable');
    };
    expect(await findLiveWorktree(repo, sibling, { home, allowRoot: reject })).toBeUndefined();
  });

  it('clears when the pane comes back to the session folder', async () => {
    expect(await findLiveWorktree(repo, repo, { home })).toBeUndefined();
    expect(await findLiveWorktree(repo, join(repo, 'src'), { home })).toBeUndefined();
  });
});
