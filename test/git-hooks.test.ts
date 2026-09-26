/**
 * @fileoverview The pre-push hook that scripts/postinstall.js installs (scripts/git-hooks.mjs).
 *
 * Two properties matter more than the hook's contents, because the older pre-commit
 * installer gets both wrong and this one must not copy it:
 *   1. It is MARKER-OWNED: a hook the developer wrote by hand is never overwritten.
 *   2. The hooks directory is resolved via `git rev-parse --git-path hooks`, since in a
 *      worktree `.git` is a FILE and `<root>/.git/hooks` does not exist.
 *
 * ⚠️ Every filesystem/git test here runs against THROWAWAY repositories under a temp dir.
 * Never point the installer at this checkout: its hooks directory is shared with every
 * worktree of it, including whatever the developer is running right now.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PRE_PUSH_CHECKS,
  PRE_PUSH_MARKER,
  installPrePushHook,
  planHookInstall,
  renderPrePushHook,
  resolveGitHooksDir,
} from '../scripts/git-hooks.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

/** git with no user/system config leaking in (a global core.hooksPath would redirect everything). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  CODEMAN_SKIP_PREPUSH: '',
};

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = GIT_ENV): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'codeman-git-hooks-')));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
function newRepo(): string {
  const dir = join(scratch, `repo-${++counter}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

describe('pre-push hook body', () => {
  const hook = renderPrePushHook();

  it('carries the ownership marker', () => {
    expect(hook).toContain(PRE_PUSH_MARKER);
  });

  it('runs every configured check through npm, and nothing slow', () => {
    for (const args of PRE_PUSH_CHECKS) {
      expect(hook).toContain(`run_check ${args.join(' ')}`);
    }
    expect(hook).toContain('npm run --silent "$@"');
    // The whole point of the tier: the minutes-long suites stay out of a per-push hook.
    expect(hook).not.toMatch(/\btest:(ci|browser|mobile|perf|all)\b/);
  });

  it('is POSIX sh', () => {
    expect(hook.startsWith('#!/bin/sh\n')).toBe(true);
    const r = spawnSync('sh', ['-n'], { input: hook });
    expect(r.status).toBe(0);
  });
});

describe('pre-push checks match the static CI job', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  const ci = read('.github/workflows/ci.yml');

  it.each(PRE_PUSH_CHECKS.map((args) => [args.join(' ')] as const))('%s is a real script that CI runs', (joined) => {
    const [name] = joined.split(' ');
    expect(scripts[name], `package.json has no "${name}" script`).toBeTypeOf('string');
    expect(ci).toContain(`npm run ${joined}`);
  });
});

describe('planHookInstall', () => {
  const hook = renderPrePushHook();

  it('writes when no hook exists', () => {
    expect(planHookInstall({ existing: null, next: hook })).toBe('write');
  });

  it('refuses to clobber a hook it does not own', () => {
    expect(planHookInstall({ existing: '#!/bin/sh\nmake lint\n', next: hook })).toBe('skip-foreign');
  });

  it('refreshes its own hook when the body changed', () => {
    expect(planHookInstall({ existing: `#!/bin/sh\n${PRE_PUSH_MARKER}\necho old\n`, next: hook })).toBe('write');
  });

  it('is idempotent when already current', () => {
    expect(planHookInstall({ existing: hook, next: hook })).toBe('up-to-date');
  });

  it('treats an empty file as absent rather than foreign', () => {
    expect(planHookInstall({ existing: '   \n', next: hook })).toBe('write');
  });
});

describe('resolveGitHooksDir (temp repos)', () => {
  it('resolves <root>/.git/hooks in a plain checkout', () => {
    const repo = newRepo();
    expect(resolveGitHooksDir(repo)).toBe(join(repo, '.git', 'hooks'));
  });

  it('resolves the SHARED hooks dir from a worktree, where .git is a file', () => {
    const repo = newRepo();
    const wt = join(scratch, `wt-${counter}`);
    git(repo, ['worktree', 'add', '-q', wt, '-b', 'wt-branch']);
    expect(statSync(join(wt, '.git')).isFile()).toBe(true);
    expect(resolveGitHooksDir(wt)).toBe(join(repo, '.git', 'hooks'));
  });

  it('returns null outside any git checkout', () => {
    const dir = join(scratch, `plain-${++counter}`);
    mkdirSync(dir);
    expect(resolveGitHooksDir(dir)).toBeNull();
  });

  it("returns null for a copy nested inside someone else's repo (e.g. under node_modules)", () => {
    const repo = newRepo();
    const nested = join(repo, 'node_modules', 'aicodeman');
    mkdirSync(nested, { recursive: true });
    expect(resolveGitHooksDir(nested)).toBeNull();
  });
});

describe('installPrePushHook (temp repos)', () => {
  it('writes an executable hook into a fresh repo', () => {
    const hooks = join(newRepo(), '.git', 'hooks');
    expect(installPrePushHook(hooks)).toBe('write');
    const path = join(hooks, 'pre-push');
    expect(readFileSync(path, 'utf8')).toBe(renderPrePushHook());
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(installPrePushHook(hooks)).toBe('up-to-date');
  });

  it('leaves a foreign pre-push hook byte-identical', () => {
    const hooks = join(newRepo(), '.git', 'hooks');
    const path = join(hooks, 'pre-push');
    const mine = '#!/bin/sh\n# my own hook\nexit 0\n';
    writeFileSync(path, mine, { mode: 0o755 });
    expect(installPrePushHook(hooks)).toBe('skip-foreign');
    expect(readFileSync(path, 'utf8')).toBe(mine);
  });

  it('refreshes a stale managed hook and keeps it executable', () => {
    const hooks = join(newRepo(), '.git', 'hooks');
    const path = join(hooks, 'pre-push');
    writeFileSync(path, `#!/bin/sh\n${PRE_PUSH_MARKER}\necho old\n`, { mode: 0o644 });
    expect(installPrePushHook(hooks)).toBe('write');
    expect(readFileSync(path, 'utf8')).toBe(renderPrePushHook());
    expect(statSync(path).mode & 0o111).not.toBe(0);
  });
});

/**
 * Drive the rendered hook through a real `git push` to a local bare remote. The repo gets a
 * stub package.json whose check scripts only record that they ran, so this exercises the
 * hook's control flow (ref parsing, skips, blocking) without running the real checks.
 */
describe('the installed hook on a real push (temp repos)', () => {
  function setup(opts: { failing?: string; nodeModules?: boolean } = {}) {
    const repo = newRepo();
    const remote = join(scratch, `remote-${counter}.git`);
    git(scratch, ['init', '-q', '--bare', remote]);
    git(repo, ['remote', 'add', 'origin', remote]);
    const log = join(repo, 'ran.log');
    const scripts: Record<string, string> = {};
    for (const [name] of PRE_PUSH_CHECKS) {
      scripts[name] =
        name === opts.failing ? `echo ${name} >> ran.log && echo boom-${name} && exit 1` : `echo ${name} >> ran.log`;
    }
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'hook-fixture', private: true, scripts }));
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\nran.log\n');
    git(repo, ['add', 'package.json', '.gitignore']);
    git(repo, ['commit', '-q', '-m', 'fixture']);
    if (opts.nodeModules !== false) mkdirSync(join(repo, 'node_modules'));
    installPrePushHook(join(repo, '.git', 'hooks'));
    chmodSync(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    const ran = () => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    const push = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSync('git', ['push', ...args], { cwd: repo, env: { ...GIT_ENV, ...env }, encoding: 'utf8' });
    return { repo, remote, ran, push };
  }

  /** What the stubs record: npm appends the args after `--` to the script, so they prove forwarding. */
  const expectedRuns = PRE_PUSH_CHECKS.map((args) => args.filter((a) => a !== '--').join(' '));

  it('runs every check before a push, in order', () => {
    const { ran, push } = setup();
    const r = push(['-q', 'origin', 'main']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(ran()).toEqual(expectedRuns);
  });

  it('blocks the push when a check fails, but still runs the rest', () => {
    const { ran, push, remote } = setup({ failing: 'lint' });
    const r = push(['origin', 'main']);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('pre-push: FAILED  npm run lint');
    expect(r.stdout + r.stderr).toContain('boom-lint');
    expect(ran()).toEqual(expectedRuns);
    expect(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/main'], { cwd: remote }).status).not.toBe(0);
  });

  it('CODEMAN_SKIP_PREPUSH=1 skips every check', () => {
    const { ran, push } = setup({ failing: 'lint' });
    const r = push(['-q', 'origin', 'main'], { CODEMAN_SKIP_PREPUSH: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(ran()).toEqual([]);
  });

  it('a delete-only push skips the checks', () => {
    const { ran, push, repo } = setup({ failing: 'lint' });
    expect(push(['-q', 'origin', 'main'], { CODEMAN_SKIP_PREPUSH: '1' }).status).toBe(0);
    git(repo, ['branch', 'doomed']);
    expect(push(['-q', 'origin', 'doomed'], { CODEMAN_SKIP_PREPUSH: '1' }).status).toBe(0);
    const r = push(['-q', 'origin', '--delete', 'doomed']);
    expect(r.status, r.stderr).toBe(0);
    expect(ran()).toEqual([]);
  });

  it('skips (never blocks) when node_modules is absent', () => {
    const { ran, push } = setup({ failing: 'lint', nodeModules: false });
    const r = push(['origin', 'main']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toContain('node_modules missing');
    expect(ran()).toEqual([]);
  });
});

describe('postinstall wiring', () => {
  const postinstall = read('scripts/postinstall.js');

  it('installs the pre-push hook through the shared module', () => {
    expect(postinstall).toContain("import('./git-hooks.mjs')");
    expect(postinstall).toContain('installPrePushHook(gitHooksDir)');
  });

  it('resolves the hooks dir through git, so worktrees work', () => {
    expect(postinstall).toContain('resolveGitHooksDir(');
    expect(postinstall).not.toContain("join(import.meta.dirname, '..', '.git', 'hooks')");
  });
});
