/**
 * @fileoverview The gate in front of every `git` the server starts (src/utils/git-availability.ts).
 *
 * On a Mac without the developer tools, `/usr/bin/git` is Apple's placeholder: running it, even as
 * `git --version`, opens the system's "install the command line developer tools" window. The server did
 * exactly that on the first page load after a no-admin install (found 2026-11-06 on a new MacBook: the
 * system log named the Codeman server as the parent of that `git`).
 *
 * Two halves: the pure decision, and a scan of `src/` that fails when a file starts git without going
 * through the gate, so the next git caller cannot bring the window back.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLE_GIT_PLACEHOLDER,
  developerDirHoldsGit,
  findOnPath,
  gitMissingError,
  gitSpawnAllowed,
  gitSpawnWouldPrompt,
  resetGitGateForTests,
} from '../src/utils/git-availability.js';

const never = (): boolean => {
  throw new Error('must not be asked');
};

describe('gitSpawnWouldPrompt', () => {
  it('is true only for Apple’s placeholder on a Mac without developer tools', () => {
    expect(
      gitSpawnWouldPrompt({ platform: 'darwin', gitPath: APPLE_GIT_PLACEHOLDER, developerToolsPresent: () => false })
    ).toBe(true);
  });

  it('lets the placeholder run once the developer tools are there', () => {
    expect(
      gitSpawnWouldPrompt({ platform: 'darwin', gitPath: APPLE_GIT_PLACEHOLDER, developerToolsPresent: () => true })
    ).toBe(false);
  });

  it('never asks about developer tools for a git that is not the placeholder', () => {
    for (const gitPath of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/nix/store/x/bin/git']) {
      expect(gitSpawnWouldPrompt({ platform: 'darwin', gitPath, developerToolsPresent: never })).toBe(false);
    }
  });

  it('leaves a Mac with no git on the PATH to the spawn’s own ENOENT', () => {
    expect(gitSpawnWouldPrompt({ platform: 'darwin', gitPath: null, developerToolsPresent: never })).toBe(false);
  });

  it('is never true off macOS, where /usr/bin/git is a real git', () => {
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      expect(gitSpawnWouldPrompt({ platform, gitPath: APPLE_GIT_PLACEHOLDER, developerToolsPresent: never })).toBe(
        false
      );
    }
  });
});

describe('findOnPath', () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it('returns the first match in PATH order', () => {
    const exists = has('/opt/homebrew/bin/git', '/usr/bin/git');
    expect(findOnPath('git', '/opt/homebrew/bin:/usr/bin', exists)).toBe('/opt/homebrew/bin/git');
    expect(findOnPath('git', '/usr/bin:/opt/homebrew/bin', exists)).toBe('/usr/bin/git');
  });

  it('skips empty and relative entries, which mean the current directory', () => {
    const exists = has('git', 'bin/git', '/usr/bin/git');
    expect(findOnPath('git', ':.:bin:/usr/bin', exists)).toBe('/usr/bin/git');
  });

  it('is null when nothing matches or there is no PATH', () => {
    expect(findOnPath('git', '/a:/b', () => false)).toBeNull();
    expect(findOnPath('git', undefined, () => true)).toBeNull();
    expect(findOnPath('git', '', () => true)).toBeNull();
  });
});

describe('developerDirHoldsGit', () => {
  it('needs a git inside the folder xcode-select names', () => {
    const exists = (p: string) => p === '/Library/Developer/CommandLineTools/usr/bin/git';
    expect(developerDirHoldsGit('/Library/Developer/CommandLineTools\n', exists)).toBe(true);
    // A selected Xcode that was deleted since: the placeholder would open its window after all.
    expect(developerDirHoldsGit('/Applications/Xcode.app/Contents/Developer\n', exists)).toBe(false);
  });

  it('refuses empty and relative answers', () => {
    expect(developerDirHoldsGit('', () => true)).toBe(false);
    expect(developerDirHoldsGit('   \n', () => true)).toBe(false);
    expect(developerDirHoldsGit('relative/dir', () => true)).toBe(false);
  });
});

describe('gitMissingError', () => {
  it('reads as the ENOENT every caller already answers with "git is not installed"', () => {
    const err = gitMissingError();
    expect(err.code).toBe('ENOENT');
    expect(err.message).toBe('spawn git ENOENT');
    expect(String(err)).toMatch(/enoent/i); // git-worktrees.ts and git-clone.ts match the string form
  });
});

describe('gitSpawnAllowed', () => {
  it.skipIf(process.platform === 'darwin')('is always true off macOS and does no IO there', () => {
    resetGitGateForTests();
    expect(gitSpawnAllowed()).toBe(true);
    expect(gitSpawnAllowed()).toBe(true);
  });
});

// ─── Scan: no git spawn outside the gate ─────────────────────────────────────

const SRC = join(__dirname, '..', 'src');

/** A call that starts `git` as the program (argv form; the server never builds a git shell string). */
const GIT_SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|exec|execSync|tryExec)\(\s*['"`]git['"`]/g;

/**
 * Files that start git, with how many call sites each has. A new site in one of them, or a new file,
 * fails here on purpose: add `gitSpawnAllowed()` in front of it (see the module's fileoverview), then
 * update this table.
 */
const GATED: Record<string, number> = {
  'git-clone.ts': 2,
  'git-fetch.ts': 2,
  'git-workspace-status.ts': 1,
  'git-worktrees.ts': 1,
  'readmymind-collectors.ts': 1,
  'web/repo-status.ts': 1,
  'web/self-update.ts': 8,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'public' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('every git the server starts goes through the gate', () => {
  const found: Record<string, number> = {};
  const ungated: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    const sites = text.match(GIT_SPAWN)?.length ?? 0;
    if (!sites) continue;
    const rel = relative(SRC, file).split(sep).join('/');
    found[rel] = sites;
    if (!/\bgitSpawnAllowed\(\)/.test(text)) ungated.push(rel);
  }

  it('finds the spawn sites at all (the pattern still matches the code)', () => {
    expect(Object.keys(found).length).toBeGreaterThan(0);
  });

  it('has no file that starts git without calling gitSpawnAllowed()', () => {
    expect(ungated).toEqual([]);
  });

  it('matches the reviewed list of sites, so a new one is looked at', () => {
    expect(found).toEqual(GATED);
  });

  it('keeps the gate itself free of git', () => {
    const gate = readFileSync(join(SRC, 'utils', 'git-availability.ts'), 'utf8');
    expect(gate.match(GIT_SPAWN)).toBeNull();
  });
});
