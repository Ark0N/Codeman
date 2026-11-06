/**
 * @fileoverview `findLiveWorktree()` (#765): which linked worktree a session's pane is in.
 *
 * The answer moves the Files panel's listing, so what matters is what it must NOT answer: the
 * session folder itself, a folder outside it, a plain subfolder (a `cd` in a shell must not re-root
 * the panel), a repository or submodule nested in the folder, and a `.git` that is not a regular
 * file. Runs against a real filesystem, and one case against a worktree real git made.
 */
import { execFileSync } from 'node:child_process';
import { constants, mkdirSync, mkdtempSync, promises as fsPromises, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findLiveWorktree, isLinkedWorktreeGitFile } from '../src/live-worktree.js';

describe('isLinkedWorktreeGitFile', () => {
  it('accepts what git writes for a linked worktree, absolute or relative', () => {
    expect(isLinkedWorktreeGitFile('gitdir: /home/me/repo/.git/worktrees/probe\n')).toBe(true);
    expect(isLinkedWorktreeGitFile('gitdir: ../../../.git/worktrees/probe\n')).toBe(true);
  });

  it('refuses a submodule, a bare path and text that is not a gitdir line', () => {
    expect(isLinkedWorktreeGitFile('gitdir: ../.git/modules/lib\n')).toBe(false);
    expect(isLinkedWorktreeGitFile('gitdir: worktrees\n')).toBe(false);
    expect(isLinkedWorktreeGitFile('/home/me/repo/.git/worktrees/probe\n')).toBe(false);
    expect(isLinkedWorktreeGitFile('')).toBe(false);
  });
});

describe('findLiveWorktree', () => {
  let base: string;
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'live-worktree-'));
    repo = join(base, 'repo');
    worktree = join(repo, '.claude', 'worktrees', 'probe');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(worktree, 'src', 'deep'), { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${repo}/.git/worktrees/probe\n`);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('finds the worktree from its own root and from below it', async () => {
    const expected = { name: 'probe', path: worktree };
    expect(await findLiveWorktree(repo, worktree)).toEqual(expected);
    expect(await findLiveWorktree(repo, join(worktree, 'src', 'deep'))).toEqual(expected);
  });

  it('answers the same for a workingDir spelled with a trailing slash', async () => {
    expect(await findLiveWorktree(`${repo}/`, worktree)).toEqual({ name: 'probe', path: worktree });
  });

  it('does not treat the session folder as a worktree of itself', async () => {
    writeFileSync(join(worktree, 'marker'), '');
    expect(await findLiveWorktree(worktree, worktree)).toBeUndefined();
    expect(await findLiveWorktree(worktree, join(worktree, 'src'))).toBeUndefined();
  });

  it('stays on the session folder for a plain subfolder, so a shell cd moves nothing', async () => {
    mkdirSync(join(repo, 'src'));
    expect(await findLiveWorktree(repo, repo)).toBeUndefined();
    expect(await findLiveWorktree(repo, join(repo, 'src'))).toBeUndefined();
  });

  it('never answers outside the session folder', async () => {
    const outside = join(base, 'repo-feature');
    mkdirSync(outside);
    writeFileSync(join(outside, '.git'), `gitdir: ${repo}/.git/worktrees/feature\n`);
    // A sibling sharing the folder's name as a prefix is the case a bare startsWith gets wrong.
    expect(await findLiveWorktree(repo, outside)).toBeUndefined();
    expect(await findLiveWorktree(repo, '/')).toBeUndefined();
  });

  it('stops at a submodule and at a repository of its own', async () => {
    const submodule = join(repo, 'lib');
    mkdirSync(submodule);
    writeFileSync(join(submodule, '.git'), 'gitdir: ../.git/modules/lib\n');
    expect(await findLiveWorktree(repo, submodule)).toBeUndefined();

    const nested = join(worktree, 'vendored');
    mkdirSync(join(nested, '.git'), { recursive: true });
    expect(await findLiveWorktree(repo, nested)).toBeUndefined();
  });

  it('refuses a .git that is not a regular file', async () => {
    const linked = join(repo, 'linked');
    mkdirSync(linked);
    symlinkSync(join(worktree, '.git'), join(linked, '.git'));
    expect(await findLiveWorktree(repo, linked)).toBeUndefined();

    // A FIFO would block open() for good: the test would time out rather than fail.
    const piped = join(repo, 'piped');
    mkdirSync(piped);
    execFileSync('mkfifo', [join(piped, '.git')]);
    expect(await findLiveWorktree(repo, piped)).toBeUndefined();
  });

  it('refuses a FIFO swapped in after the probe, without waiting for a writer', async () => {
    const swapped = join(repo, 'swapped');
    mkdirSync(swapped);
    execFileSync('mkfifo', [join(swapped, 'fifo')]);
    const flagsSeen: unknown[] = [];
    const realOpen = fsPromises.open.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, 'open').mockImplementationOnce((_path, flags) => {
      flagsSeen.push(flags);
      // The test's own open never blocks, so a change that loses the flag fails on the assert below.
      return realOpen(join(swapped, 'fifo'), constants.O_RDONLY | constants.O_NONBLOCK);
    });
    try {
      // The probe and the open disagree here, which is what a swap between the two looks like.
      writeFileSync(join(swapped, '.git'), 'gitdir: /home/me/repo/.git/worktrees/swapped\n');
      expect(await findLiveWorktree(repo, swapped)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(Number(flagsSeen[0]) & constants.O_NONBLOCK).toBeTruthy();
    expect(Number(flagsSeen[0]) & constants.O_NOFOLLOW).toBeTruthy();
  });

  it('answers nothing without an absolute reading', async () => {
    expect(await findLiveWorktree(repo, undefined)).toBeUndefined();
    expect(await findLiveWorktree(repo, '')).toBeUndefined();
    expect(await findLiveWorktree(repo, '.claude/worktrees/probe')).toBeUndefined();
  });

  it('recognises a worktree real git made', async () => {
    const real = join(base, 'real');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: real,
        stdio: 'ignore',
      });
    mkdirSync(real);
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', '.claude/worktrees/made', '-b', 'worktree-made');
    expect(await findLiveWorktree(real, join(real, '.claude', 'worktrees', 'made'))).toEqual({
      name: 'made',
      path: join(real, '.claude', 'worktrees', 'made'),
    });
  });
});
