/**
 * @fileoverview Git worktrees for a LOCAL case: list, create and remove the worktrees a
 * repository-backed case keeps under `<repo>/.claude/worktrees/<name>`, so several agents working
 * on one repository each get their own working tree instead of sharing the case folder (sessions
 * in one case share its folder, and two agents editing, building and committing in one checkout
 * step on each other). Routes: `src/web/routes/worktree-routes.ts`; a session starts in one
 * through the existing create paths (`POST /api/quick-start` with `worktree`, or
 * `POST /api/sessions` with the worktree as `workingDir`).
 *
 * WHERE. `<repo>/.claude/worktrees/<name>` on a new branch `worktree-<name>` is Claude Code's own
 * `--worktree` layout (measured in Claude Code 2.1.296: path `<repo>/.claude/worktrees/<name>`,
 * branch `worktree-<name>`, names of letters, digits, `.`, `_`, `-`, at most 64 characters), and
 * Codeman already recognizes it (the worktree pill, `CLAUDE_WORKTREE_PATH` in session-routes.ts).
 * Names here are a strict subset of Claude's (one segment, starting with a letter or digit), so a
 * worktree made here is one `claude --worktree <name>` would also find. The main checkout must not
 * show the worktrees as untracked, so `/.claude/worktrees/` is appended to the repository's LOCAL
 * `info/exclude` (in the real common git dir, never a tracked `.gitignore`) when git does not
 * already ignore it. `/.claude/settings.local.json` gets the same treatment: Codeman installs its
 * hooks there for every claude session, and an untracked copy in a worktree makes
 * `git worktree remove` refuse forever (Claude Code itself ignores that file through the global
 * excludes file, which is not guaranteed to be set up on a given machine). The copy of Codeman's
 * agent skill (`<skills dir>/codeman/`, injected while `agentSkillEnabled` is on) is excluded for
 * the same reason, for every skills folder the registry names (`WorktreeOptions.agentSkillDirs`).
 *
 * Split like the other git modules: a PURE half (name and branch validation, `worktree list`
 * parsing, exclude text, the managed-path rule) unit-tested without git, and an IO half that
 * spawns git through an injectable runner.
 *
 * Rules the code keeps and the tests pin:
 *   - git is spawned with an argv array, never a shell, with `--` before every path operand, the
 *     non-interactive environment of `gitNonInteractiveEnv()`, a timeout that kills the whole
 *     process group, and capped output. Read-only calls add `--no-optional-locks`.
 *   - Names and branches are validated BEFORE they reach git (charset, length, then
 *     `git check-ref-format --branch`, whose answer must equal the input: `@{-1}` style shorthands
 *     are refused up front, since `--branch` would expand them).
 *   - Only `<repo>/.claude/worktrees/<valid-name>` is ever created or removed. Every component of
 *     that path is `lstat`ed (a symlinked `.claude` or `worktrees` directory, or a symlink at the
 *     worktree itself, is refused) and its real path must be exactly the expected one, so a
 *     repository cannot redirect a create or a remove outside itself. What is left is a same-user
 *     race (an agent swapping a directory between the check and git), which is accepted: that
 *     agent already runs code as this user.
 *   - Removal is `git worktree remove` WITHOUT `--force` (git refuses a tree with modified or
 *     untracked files, and that refusal is the answer), refused while a live session runs inside
 *     the worktree, and the optional branch delete is `git branch -d` (never `-D`, so an unmerged
 *     branch survives).
 *   - git never runs for a case at or inside a Docker case workspace (or whose common git dir is
 *     there): a container could plant a checkout filter or a hook, and `git worktree add` runs the
 *     repository's post-checkout hook and filters on the HOST. On a local case that is acceptable,
 *     since the user's agent runs code there anyway. A managed worktree that is, sits inside, or
 *     holds a Docker case workspace is never removed either: `git worktree remove` runs a status
 *     inside the tree, then deletes it under the container.
 *   - A repository that merely encloses the case and is the home folder or above (a dotfiles repo
 *     in `$HOME`) is not the case's repository, and a case folder below a repository's top level
 *     is refused: the worktrees would not be where the case is.
 *
 * @module git-worktrees
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gitNonInteractiveEnv, isSafeGitRef, sanitizeGitOutput } from './git-clone.js';
import { isInsideAny, isUnrelatedAncestor } from './git-workspace-status.js';

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Claude Code's own limit for a `--worktree` name (2.1.296). */
export const MAX_WORKTREE_NAME_LENGTH = 64;
/** Longest accepted branch name. git allows more; 200 covers every real one. */
export const MAX_WORKTREE_BRANCH_LENGTH = 200;
/** A read-only git call (rev-parse, worktree list, check-ignore, check-ref-format). */
export const WORKTREE_READ_TIMEOUT_MS = 15_000;
/**
 * `git worktree add` checks out a whole tree and runs the repository's post-checkout hook and
 * smudge filters (Git LFS downloads objects there), so it gets the longest budget.
 */
export const WORKTREE_ADD_TIMEOUT_MS = 180_000;
/** `git worktree remove` runs a status of the tree first, then deletes it. */
export const WORKTREE_REMOVE_TIMEOUT_MS = 60_000;
/** Captured stdout. `worktree list` is one short block per worktree. */
const MAX_STDOUT_BYTES = 1_000_000;
/** Captured stderr tail. */
const MAX_STDERR_BYTES = 8_192;
/** Worktrees listed. A repository with more is unusual; the count says when it was cut. */
export const MAX_WORKTREES_LISTED = 200;

/** Path segments of the managed worktrees folder, relative to the repository root. */
export const WORKTREES_DIR_SEGMENTS = ['.claude', 'worktrees'] as const;
/** The `info/exclude` line that hides the managed worktrees from the main checkout. */
export const WORKTREES_EXCLUDE_LINE = '/.claude/worktrees/';
/** The `info/exclude` line for the hooks file Codeman writes into every claude workspace. */
export const SETTINGS_LOCAL_EXCLUDE_LINE = '/.claude/settings.local.json';

/** A workspace-relative skills folder (`.claude/skills`, `.agents/skills`): plain segments only. */
const SKILLS_DIR_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * The `info/exclude` line for the copy of Codeman's agent skill in `skillsDir` of a workspace
 * (`<skillsDir>/codeman/`, written into the folder a session runs in while `agentSkillEnabled`
 * is on), or null for a folder that is not a plain relative path.
 */
export function agentSkillExcludeLine(skillsDir: string): string | null {
  if (!SKILLS_DIR_RE.test(skillsDir) || skillsDir.split('/').some((s) => s === '.' || s === '..')) return null;
  return `/${skillsDir}/codeman/`;
}

// ─── Pure: names ─────────────────────────────────────────────────────────────

const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Why `name` cannot be a worktree name, or null when it can. One path segment of letters, digits,
 * `.`, `_` and `-`, starting with a letter or digit, at most 64 characters, never `..` (the
 * session path schema refuses any path containing it), and not ending in `.` or `.lock` (git's
 * own ref rules, since the default branch is derived from the name).
 */
export function worktreeNameError(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'A worktree name is required.';
  if (name.length > MAX_WORKTREE_NAME_LENGTH)
    return `A worktree name is at most ${MAX_WORKTREE_NAME_LENGTH} characters.`;
  if (!WORKTREE_NAME_RE.test(name))
    return 'A worktree name may contain only letters, digits, ".", "_" and "-", and must start with a letter or digit.';
  if (name.includes('..')) return 'A worktree name may not contain "..".';
  if (name.endsWith('.') || name.toLowerCase().endsWith('.lock'))
    return 'A worktree name may not end with "." or ".lock".';
  return null;
}

/** The branch a new worktree gets when the caller names none: Claude Code's `worktree-<name>`. */
export function defaultWorktreeBranch(name: string): string {
  return `worktree-${name}`;
}

/**
 * Why `branch` cannot be a new branch name, or null when it passes the charset gate. The final
 * word is `git check-ref-format --branch` (see `createCaseWorktree`); this gate exists so nothing
 * option-shaped, `@{...}`-shaped or otherwise surprising ever reaches git at all.
 */
export function worktreeBranchError(branch: unknown): string | null {
  if (typeof branch !== 'string' || branch.length === 0) return 'A branch name is required.';
  if (branch.length > MAX_WORKTREE_BRANCH_LENGTH)
    return `A branch name is at most ${MAX_WORKTREE_BRANCH_LENGTH} characters.`;
  if (!BRANCH_NAME_RE.test(branch))
    return 'A branch name may contain only letters, digits, ".", "_", "-" and "/", and must start with a letter or digit.';
  if (branch.includes('..') || branch.includes('//')) return 'A branch name may not contain ".." or "//".';
  if (branch.endsWith('/') || branch.endsWith('.') || branch.toLowerCase().endsWith('.lock'))
    return 'A branch name may not end with "/", "." or ".lock".';
  if (branch.split('/').some((part) => part.startsWith('.'))) return 'No part of a branch name may start with ".".';
  return null;
}

/** Why `base` cannot be a start point, or null. The same gate Clone Repo uses for a ref. */
export function worktreeBaseError(base: unknown): string | null {
  if (typeof base !== 'string' || !isSafeGitRef(base))
    return 'The base must be a branch, tag or commit (letters, digits, ".", "_", "-", "/" and "+").';
  return null;
}

// ─── Pure: paths ─────────────────────────────────────────────────────────────

/** `<repo>/.claude/worktrees`. */
export function managedWorktreesDir(repoRoot: string): string {
  return join(repoRoot, ...WORKTREES_DIR_SEGMENTS);
}

/** `<repo>/.claude/worktrees/<name>`. The caller validates `name` first. */
export function managedWorktreePath(repoRoot: string, name: string): string {
  return join(managedWorktreesDir(repoRoot), name);
}

/**
 * The managed worktree name of `path`, or null when it is not exactly
 * `<repoRoot>/.claude/worktrees/<valid-name>`. Lexical: both sides must already be real paths.
 */
export function managedWorktreeName(repoRoot: string, path: string): string | null {
  const dir = managedWorktreesDir(repoRoot) + sep;
  const clean = path.endsWith(sep) && path.length > 1 ? path.slice(0, -1) : path;
  if (!clean.startsWith(dir)) return null;
  const name = clean.slice(dir.length);
  if (!name || name.includes(sep)) return null;
  return worktreeNameError(name) === null ? name : null;
}

/** True when `child` is `root` or inside it (lexical, on resolved paths). */
export function isPathWithin(child: string, root: string): boolean {
  const c = resolve(child);
  const r = resolve(root);
  return c === r || c.startsWith(r === sep ? r : r + sep);
}

/**
 * `path` as the repository spells it: a path under `alias` (the case folder as its case resolves
 * it, which can run through a symlink) moved under `root` (the repository's real top level), else
 * `path` unchanged. Lexical, so it costs no filesystem call per session. Sessions keep the
 * `workingDir` they were created with, while the worktree paths git lists are real, so without
 * this a session spelled through the case's link counted for no worktree and did not block its
 * removal.
 */
export function respellUnder(path: string, alias: string, root: string): string {
  const p = resolve(path);
  const a = resolve(alias);
  if (a === resolve(root) || !isPathWithin(p, a)) return p;
  return join(root, p.slice(a.length));
}

// ─── Pure: `git worktree list --porcelain` ───────────────────────────────────

export interface ParsedWorktree {
  path: string;
  /** Commit checked out (absent for a bare entry). */
  head: string | null;
  /** Short branch name (`refs/heads/` stripped), null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
}

/**
 * Undo git's C-style path quoting (`"a\\"b\\303\\251"` → `a"bé`). Paths are printed quoted when
 * they hold a `"`, a `\` or a control character even with `core.quotePath=false`; octal escapes are
 * raw bytes, decoded as UTF-8. Text that is not quoted comes back unchanged.
 */
export function unquoteGitPath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const body = text.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf-8')) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else if (next !== undefined && next in simple) {
      bytes.push(simple[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Parse `git worktree list --porcelain` (newline-terminated form: `-z` needs git 2.36, and Ubuntu
 * 22.04 ships 2.34). Records are separated by blank lines; the first is the main worktree. Paths
 * are read through `unquoteGitPath`, which together with `-c core.quotePath=false` keeps non-ASCII
 * repository paths readable.
 */
export function parseWorktreeList(text: string): ParsedWorktree[] {
  const out: ParsedWorktree[] = [];
  let cur: ParsedWorktree | null = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      flush();
      cur = {
        path: unquoteGitPath(value),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!cur) continue;
    const entry: ParsedWorktree = cur;
    if (key === 'HEAD') entry.head = value || null;
    else if (key === 'branch') entry.branch = value.startsWith('refs/heads/') ? value.slice(11) : value || null;
    else if (key === 'detached') entry.detached = true;
    else if (key === 'bare') entry.bare = true;
    else if (key === 'locked') {
      entry.locked = true;
      if (value) entry.lockReason = value;
    } else if (key === 'prunable') {
      entry.prunable = true;
      if (value) entry.prunableReason = value;
    }
  }
  flush();
  return out;
}

// ─── Pure: exclude file ──────────────────────────────────────────────────────

/**
 * What to append to an `info/exclude` holding `existing` so that every line of `lines` is in it:
 * the text ('' when nothing is missing) and the lines it adds. A file that does not end in a
 * newline gets one first, so an appended pattern never fuses with the user's last line.
 */
export function excludeAppendText(existing: string, lines: readonly string[]): { text: string; added: string[] } {
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const added = lines.filter((l) => !present.has(l));
  if (added.length === 0) return { text: '', added };
  const lead = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  return {
    text: `${lead}# Added by Codeman: git worktrees and the files Codeman writes into each workspace stay local\n${added.join('\n')}\n`,
    added,
  };
}

// ─── Pure: git's answers ─────────────────────────────────────────────────────

/**
 * The part of git's stderr a user should see: its `fatal:`/`error:` lines (with any `hint:` lines
 * dropped, they repeat what the UI says), sanitized and capped. Shown through `textContent` only.
 */
export function gitRefusalText(stderr: string): string {
  const clean = sanitizeGitOutput(stderr, 2000);
  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/i.test(l));
  const diagnostic = lines.filter((l) => /^(fatal|error|warning):/i.test(l));
  const text = (diagnostic.length ? diagnostic : lines).join('\n');
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

// ─── IO: git runner ──────────────────────────────────────────────────────────

export interface WorktreeGitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/** Runs `git <args>` in `cwd`; never throws. Injected so tests can refuse to run git at all. */
export type WorktreeGitRunner = (
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<WorktreeGitResult>;

/**
 * Global options for a call that only reads: no optional index refresh, no filesystem monitor,
 * no path quoting of non-ASCII names. Must precede the subcommand.
 */
const READ_ONLY_GIT_OPTIONS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];

/**
 * The production runner: argv only (no shell), the non-interactive environment, captured output
 * caps, and a timeout that signals the whole process group (`detached: true`), because
 * `git worktree add` fans out into checkout children, hooks and filters that a signal to the
 * parent alone would leave running.
 */
export const runWorktreeGit: WorktreeGitRunner = (cwd, args, opts) =>
  new Promise<WorktreeGitResult>((resolveRun) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, {
        cwd,
        env: { ...gitNonInteractiveEnv(), GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolveRun({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: String(err) });
      return;
    }
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 3_000);
    }, opts?.timeoutMs ?? WORKTREE_READ_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
      if (stderr.length > MAX_STDERR_BYTES * 2) stderr = stderr.slice(-MAX_STDERR_BYTES);
    });
    const finish = (result: WorktreeGitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveRun(result);
    };
    child.on('error', (err) => finish({ code: null, stdout, stderr, timedOut, spawnError: String(err) }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
  });

// ─── IO: results ─────────────────────────────────────────────────────────────

/** Failure codes, named after the API error codes the routes map them to. */
export type WorktreeFailureCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'CONFLICT' | 'OPERATION_FAILED';

export interface WorktreeFailure {
  ok: false;
  code: WorktreeFailureCode;
  message: string;
  /** git's own words, when git refused (sanitized; render as text). */
  gitMessage?: string;
}

const fail = (code: WorktreeFailureCode, message: string, gitMessage?: string): WorktreeFailure => ({
  ok: false,
  code,
  message,
  ...(gitMessage ? { gitMessage } : {}),
});

function gitFailure(run: WorktreeGitResult, what: string): WorktreeFailure {
  if (run.spawnError && /enoent/i.test(run.spawnError))
    return fail('OPERATION_FAILED', 'git is not installed on this machine (or not on the server’s PATH).');
  if (run.timedOut) return fail('OPERATION_FAILED', `git timed out while ${what}.`);
  const text = gitRefusalText(run.stderr);
  return fail('OPERATION_FAILED', text ? `git failed while ${what}: ${text}` : `git failed while ${what}.`, text);
}

// ─── IO: the case's repository ───────────────────────────────────────────────

export interface CaseRepository {
  /** The repository's top level, which is the case folder (real path). */
  repoRoot: string;
  /** The real common git dir (`.git` of the main checkout), where `info/exclude` lives. */
  commonDir: string;
}

export interface WorktreeOptions {
  git?: WorktreeGitRunner;
  /** Host paths of every Docker case workspace: git never runs at or inside one. */
  dockerWorkspaces?: string[];
  /** Overrides `os.homedir()` for the unrelated-ancestor rule (tests). */
  home?: string;
  /**
   * Every workspace skills folder a session can get Codeman's agent skill in (the registry's
   * `capabilities.agentSkillDir` values, passed in as data by the caller). A create excludes
   * `<dir>/codeman/` for each, like the hooks file: a session in a worktree gets an untracked
   * copy there, and `git worktree remove` would refuse that worktree forever.
   */
  agentSkillDirs?: readonly string[];
}

const realOr = async (p: string): Promise<string> => {
  try {
    return await fs.realpath(p);
  } catch {
    return resolve(p);
  }
};

const DOCKER_REFUSAL =
  'Worktrees are not available for a folder inside a Docker case workspace: a container can write there, and git would run its hooks and filters on this machine.';

const DOCKER_WORKTREE_REFUSAL =
  'This worktree is, or holds, a Docker case workspace: git would run inside a folder a container can write, and removing it would delete that workspace. Remove the Docker case first.';

/**
 * The repository a case folder IS, or why it is not one Codeman makes worktrees for. Never runs
 * git when the folder (or the repository's common git dir) is at or inside a Docker case workspace.
 */
export async function resolveCaseRepository(
  casePath: string,
  opts: WorktreeOptions = {}
): Promise<{ ok: true; repo: CaseRepository } | WorktreeFailure> {
  const git = opts.git ?? runWorktreeGit;
  const dockerRoots = await Promise.all((opts.dockerWorkspaces ?? []).filter(Boolean).map(realOr));
  if (await isInsideAny(casePath, dockerRoots)) return fail('INVALID_INPUT', DOCKER_REFUSAL);

  const run = await git(casePath, [...READ_ONLY_GIT_OPTIONS, 'rev-parse', '--show-toplevel', '--git-common-dir'], {
    timeoutMs: WORKTREE_READ_TIMEOUT_MS,
  });
  if (run.code !== 0 || run.spawnError || run.timedOut) {
    if (/must be run in a work tree/i.test(run.stderr)) {
      return fail('INVALID_INPUT', 'This case folder is a bare git repository, which has no work tree to branch from.');
    }
    if (/not a git repository/i.test(run.stderr)) {
      return fail('INVALID_INPUT', 'This case folder is not a git repository.');
    }
    return gitFailure(run, 'reading the repository');
  }
  const [top, common] = run.stdout.split('\n').map((l) => l.trim());
  if (!top || !common) return fail('OPERATION_FAILED', 'git did not report the repository root.');
  const [repoRoot, caseReal] = await Promise.all([realOr(top), realOr(casePath)]);
  const commonDir = await realOr(resolve(casePath, common));
  if (await isInsideAny(commonDir, dockerRoots)) return fail('INVALID_INPUT', DOCKER_REFUSAL);
  if (repoRoot !== caseReal) {
    if (await isUnrelatedAncestor(repoRoot, caseReal, opts.home ?? homedir())) {
      return fail('INVALID_INPUT', 'This case folder is not a git repository.');
    }
    return fail(
      'INVALID_INPUT',
      `Worktrees need the case folder to be the top of a git repository; this folder is inside ${repoRoot}.`
    );
  }
  return { ok: true, repo: { repoRoot, commonDir } };
}

// ─── IO: listing ─────────────────────────────────────────────────────────────

export interface CaseWorktree extends ParsedWorktree {
  /** The repository's main checkout (git lists it first). */
  main: boolean;
  /** The case folder itself (the main checkout, or a linked worktree linked as the case). */
  isCase: boolean;
  /** Under `<repo>/.claude/worktrees/<valid-name>`: Codeman may start sessions in it and remove it. */
  managed: boolean;
  /** The managed name, when `managed`. */
  name?: string;
}

export async function listCaseWorktrees(
  repo: CaseRepository,
  opts: WorktreeOptions = {}
): Promise<{ ok: true; worktrees: CaseWorktree[]; truncated: boolean } | WorktreeFailure> {
  const git = opts.git ?? runWorktreeGit;
  const run = await git(repo.repoRoot, [...READ_ONLY_GIT_OPTIONS, 'worktree', 'list', '--porcelain'], {
    timeoutMs: WORKTREE_READ_TIMEOUT_MS,
  });
  if (run.code !== 0 || run.spawnError || run.timedOut) return gitFailure(run, 'listing worktrees');
  const parsed = parseWorktreeList(run.stdout);
  const truncated = parsed.length > MAX_WORKTREES_LISTED;
  const worktrees = parsed.slice(0, MAX_WORKTREES_LISTED).map((wt, index): CaseWorktree => {
    const name = index === 0 ? null : managedWorktreeName(repo.repoRoot, wt.path);
    return {
      ...wt,
      main: index === 0,
      isCase: wt.path === repo.repoRoot,
      managed: name !== null,
      ...(name ? { name } : {}),
    };
  });
  return { ok: true, worktrees, truncated };
}

// ─── IO: path guards ─────────────────────────────────────────────────────────

type DirState = 'dir' | 'absent' | 'symlink' | 'other';

async function lstatState(path: string): Promise<DirState> {
  try {
    const st = await fs.lstat(path);
    if (st.isSymbolicLink()) return 'symlink';
    return st.isDirectory() ? 'dir' : 'other';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    throw err;
  }
}

/**
 * Make sure `<repo>/.claude` and `<repo>/.claude/worktrees` are real directories (created when
 * absent, refused when a symlink or a file) whose real path is exactly the lexical one.
 */
async function prepareWorktreesDir(repoRoot: string): Promise<{ ok: true; dir: string } | WorktreeFailure> {
  let cur = repoRoot;
  for (const segment of WORKTREES_DIR_SEGMENTS) {
    cur = join(cur, segment);
    const state = await lstatState(cur);
    if (state === 'symlink') {
      return fail(
        'INVALID_INPUT',
        `${cur} is a symlink. Codeman will not create worktrees through a link that could point outside the repository.`
      );
    }
    if (state === 'other') return fail('INVALID_INPUT', `${cur} exists and is not a directory.`);
    if (state === 'absent') {
      try {
        await fs.mkdir(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          return fail('OPERATION_FAILED', `Could not create ${cur}: ${(err as Error).message}`);
        }
        if ((await lstatState(cur)) !== 'dir') return fail('INVALID_INPUT', `${cur} is not a plain directory.`);
      }
    }
  }
  if ((await realOr(cur)) !== cur) {
    return fail('INVALID_INPUT', `${cur} does not resolve to itself; refusing to create a worktree there.`);
  }
  return { ok: true, dir: cur };
}

/**
 * The managed worktree `name` of `repo` as it is on disk now: every component a real directory
 * (no symlinks), the real path the expected one, and git listing it as a worktree of this
 * repository. Used by removal and by starting a session in it.
 *
 * `allowMissing` (removal only, never a session start) also accepts a worktree whose folder is
 * GONE (deleted by hand, or by an agent) while git still lists it, as prunable, at exactly the
 * managed path: no component on the way may be a symlink or a file, and `missing` says so.
 * Without it such a worktree was a dead end: it could not be removed, and its name could not be
 * used again (the branch exists, then git refuses "a missing but already registered worktree").
 */
export async function resolveManagedWorktree(
  repo: CaseRepository,
  name: string,
  opts: WorktreeOptions & { allowMissing?: boolean } = {}
): Promise<{ ok: true; path: string; worktree: CaseWorktree; missing: boolean } | WorktreeFailure> {
  const nameError = worktreeNameError(name);
  if (nameError) return fail('INVALID_INPUT', nameError);
  const target = managedWorktreePath(repo.repoRoot, name);
  let cur = repo.repoRoot;
  let missing = false;
  for (const segment of [...WORKTREES_DIR_SEGMENTS, name]) {
    cur = join(cur, segment);
    const state = await lstatState(cur);
    if (state === 'absent') {
      if (!opts.allowMissing) return fail('NOT_FOUND', `No worktree named "${name}" in this case.`);
      // Nothing below an absent folder exists, so nothing below it can redirect anything.
      missing = true;
      break;
    }
    if (state === 'symlink') {
      return fail('INVALID_INPUT', `${cur} is a symlink. Codeman only manages worktrees that are real directories.`);
    }
    if (state === 'other') return fail('INVALID_INPUT', `${cur} is not a directory.`);
  }
  if (!missing && (await realOr(target)) !== target) {
    return fail('INVALID_INPUT', `${target} does not resolve to itself; refusing to use it.`);
  }
  const listed = await listCaseWorktrees(repo, opts);
  if (!listed.ok) return listed;
  for (const wt of listed.worktrees) {
    if (wt.main) continue;
    if (missing) {
      // Lexical only: the folder is gone, so there is no real path to compare. git never calls a
      // LOCKED worktree prunable (prune skips it), so a locked one is taken too, and the caller's
      // lock check then refuses it with git's lock reason.
      if (wt.path === target && (wt.prunable || wt.locked)) {
        return { ok: true, path: target, worktree: { ...wt, managed: true, name }, missing: true };
      }
      continue;
    }
    if (wt.path === target || (await realOr(wt.path)) === target) {
      return { ok: true, path: target, worktree: { ...wt, managed: true, name }, missing: false };
    }
  }
  if (missing) return fail('NOT_FOUND', `No worktree named "${name}" in this case.`);
  return fail(
    'NOT_FOUND',
    `${target} is not a registered git worktree of this repository (a leftover folder, or one git no longer knows about).`
  );
}

// ─── IO: excludes ────────────────────────────────────────────────────────────

/**
 * Append each of `lines` that git does not already ignore to `<commonDir>/info/exclude`. Returns
 * the lines written. A symlinked `info` dir or `exclude` file is left alone (reported, never
 * written through).
 */
async function ensureExcluded(
  repo: CaseRepository,
  probes: Array<{ line: string; probe: string }>,
  git: WorktreeGitRunner
): Promise<{ added: string[]; warning?: string }> {
  const needed: string[] = [];
  for (const { line, probe } of probes) {
    const run = await git(repo.repoRoot, [...READ_ONLY_GIT_OPTIONS, 'check-ignore', '-q', '--', probe], {
      timeoutMs: WORKTREE_READ_TIMEOUT_MS,
    });
    // 0: ignored. 1: not ignored. Anything else (128) is a git error: assume not ignored, since an
    // extra exclude line is harmless and a missing one leaves the worktrees untracked.
    if (run.code !== 0) needed.push(line);
  }
  if (needed.length === 0) return { added: [] };
  const infoDir = join(repo.commonDir, 'info');
  const excludePath = join(infoDir, 'exclude');
  try {
    const infoState = await lstatState(infoDir);
    if (infoState === 'absent') await fs.mkdir(infoDir);
    else if (infoState !== 'dir')
      return { added: [], warning: `${infoDir} is not a plain directory; nothing was excluded.` };
    const fileState = await lstatState(excludePath);
    if (fileState === 'symlink' || fileState === 'dir') {
      return { added: [], warning: `${excludePath} is not a plain file; nothing was excluded.` };
    }
    const existing = fileState === 'absent' ? '' : await fs.readFile(excludePath, 'utf-8');
    const { text, added } = excludeAppendText(existing, needed);
    if (text) await fs.appendFile(excludePath, text, { mode: 0o644 });
    return { added };
  } catch (err) {
    return { added: [], warning: `Could not update ${excludePath}: ${(err as Error).message}` };
  }
}

// ─── IO: one operation per repository at a time ──────────────────────────────

const repoLocks = new Map<string, Promise<unknown>>();

/** Serialize create/remove per repository: two creates must not both pass the "absent" check. */
async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoRoot) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  repoLocks.set(repoRoot, tail);
  try {
    return await next;
  } finally {
    if (repoLocks.get(repoRoot) === tail) repoLocks.delete(repoRoot);
  }
}

// ─── IO: create ──────────────────────────────────────────────────────────────

export interface CreateWorktreeRequest {
  name: string;
  /** New branch; default `worktree-<name>`. */
  branch?: string;
  /** Start point; default `HEAD` (the case's current commit). */
  base?: string;
}

export interface CreatedWorktree {
  name: string;
  path: string;
  branch: string;
  base: string;
  /** The commit the new branch starts at. */
  head: string;
  /** Lines appended to the repository's `info/exclude` (empty when git already ignored them). */
  excludeAdded: string[];
  warnings: string[];
}

export async function createCaseWorktree(
  repo: CaseRepository,
  req: CreateWorktreeRequest,
  opts: WorktreeOptions = {}
): Promise<{ ok: true; worktree: CreatedWorktree } | WorktreeFailure> {
  const git = opts.git ?? runWorktreeGit;
  const nameError = worktreeNameError(req.name);
  if (nameError) return fail('INVALID_INPUT', nameError);
  const branch = req.branch || defaultWorktreeBranch(req.name);
  const branchError = worktreeBranchError(branch);
  if (branchError) return fail('INVALID_INPUT', branchError);
  const base = req.base || 'HEAD';
  const baseError = worktreeBaseError(base);
  if (baseError) return fail('INVALID_INPUT', baseError);

  return withRepoLock(repo.repoRoot, async () => {
    // A name already taken says so in those words, before the branch check would report the
    // derived branch instead. Rechecked after the folders are prepared, below.
    try {
      if ((await lstatState(managedWorktreePath(repo.repoRoot, req.name))) !== 'absent') {
        return fail('ALREADY_EXISTS', `A worktree named "${req.name}" already exists in this case.`);
      }
    } catch {
      /* unreadable: the check after the folders are prepared reports it */
    }
    // git's own word on the branch name. The output must be the input: `--branch` expands
    // shorthands, and anything it rewrote is not the name the user typed.
    const refFormat = await git(repo.repoRoot, [...READ_ONLY_GIT_OPTIONS, 'check-ref-format', '--branch', branch], {
      timeoutMs: WORKTREE_READ_TIMEOUT_MS,
    });
    if (refFormat.code !== 0 || refFormat.stdout.trim() !== branch) {
      return fail('INVALID_INPUT', `"${branch}" is not a valid branch name.`, gitRefusalText(refFormat.stderr));
    }
    const existingBranch = await git(
      repo.repoRoot,
      [...READ_ONLY_GIT_OPTIONS, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { timeoutMs: WORKTREE_READ_TIMEOUT_MS }
    );
    if (existingBranch.code === 0) {
      return fail('ALREADY_EXISTS', `A branch named "${branch}" already exists. Pick another worktree name or branch.`);
    }
    const resolved = await git(
      repo.repoRoot,
      // No `--end-of-options` (git 2.30+): the base already passed the ref gate, which refuses a
      // leading `-`, so it cannot be read as an option.
      [...READ_ONLY_GIT_OPTIONS, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`],
      { timeoutMs: WORKTREE_READ_TIMEOUT_MS }
    );
    const head = resolved.stdout.trim();
    if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head)) {
      return fail('INVALID_INPUT', `"${base}" is not a commit in this repository (an empty repository has none yet).`);
    }

    const prepared = await prepareWorktreesDir(repo.repoRoot);
    if (!prepared.ok) return prepared;
    const target = join(prepared.dir, req.name);
    try {
      if ((await lstatState(target)) !== 'absent') {
        return fail('ALREADY_EXISTS', `${target} already exists. Pick another worktree name.`);
      }
    } catch (err) {
      return fail('OPERATION_FAILED', `Could not inspect ${target}: ${(err as Error).message}`);
    }

    const skillProbes: Array<{ line: string; probe: string }> = [];
    for (const dir of new Set(opts.agentSkillDirs ?? [])) {
      const line = agentSkillExcludeLine(dir);
      if (line) skillProbes.push({ line, probe: `${dir}/codeman` });
    }
    const excluded = await ensureExcluded(
      repo,
      [
        { line: WORKTREES_EXCLUDE_LINE, probe: `${WORKTREES_DIR_SEGMENTS.join('/')}/${req.name}` },
        { line: SETTINGS_LOCAL_EXCLUDE_LINE, probe: '.claude/settings.local.json' },
        ...skillProbes,
      ],
      git
    );

    // The resolved commit, not the ref text, after `--`: nothing here can be read as an option,
    // and `--no-track` keeps a worktree started from `origin/main` from tracking (and pulling) main.
    const add = await git(repo.repoRoot, ['worktree', 'add', '--no-track', '-b', branch, '--', target, head], {
      timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
    });
    if (add.code !== 0 || add.spawnError || add.timedOut) {
      const text = gitRefusalText(add.stderr);
      if (/already exists/i.test(text)) return fail('ALREADY_EXISTS', `git refused: ${text}`, text);
      return gitFailure(add, 'creating the worktree');
    }
    return {
      ok: true,
      worktree: {
        name: req.name,
        path: target,
        branch,
        base,
        head,
        excludeAdded: excluded.added,
        warnings: excluded.warning ? [excluded.warning] : [],
      },
    };
  });
}

// ─── IO: remove ──────────────────────────────────────────────────────────────

export interface RemoveWorktreeRequest {
  name: string;
  /** Also `git branch -d` the worktree's branch (never `-D`). */
  deleteBranch?: boolean;
  /** True when a live session runs at or inside `path`: the removal is refused. */
  isInUse: (path: string) => boolean | Promise<boolean>;
}

export interface RemovedWorktree {
  name: string;
  path: string;
  branch: string | null;
  branchDeleted: boolean;
  /** git's refusal to delete the branch (typically "not fully merged"); the worktree is gone regardless. */
  branchError?: string;
}

export async function removeCaseWorktree(
  repo: CaseRepository,
  req: RemoveWorktreeRequest,
  opts: WorktreeOptions = {}
): Promise<{ ok: true; removed: RemovedWorktree } | WorktreeFailure> {
  const git = opts.git ?? runWorktreeGit;
  return withRepoLock(repo.repoRoot, async () => {
    // A worktree whose folder is gone is removable too: `git worktree remove` then only drops
    // git's record of it (measured on git 2.43: exit 0, nothing on disk touched).
    const found = await resolveManagedWorktree(repo, req.name, { ...opts, allowMissing: true });
    if (!found.ok) return found;
    // The case passed the Docker rule, but the worktree folder itself can be a Docker case's
    // workspace (a Docker case linked to it), or hold one. `git worktree remove` runs a status
    // INSIDE the tree first (container-written files, checkout filters on this machine), then
    // deletes the whole tree, ignored files included, under a container that still mounts it.
    // A folder that is gone has neither problem: git only drops its record.
    if (!found.missing) {
      const dockerRoots = await Promise.all((opts.dockerWorkspaces ?? []).filter(Boolean).map(realOr));
      if (dockerRoots.some((root) => isPathWithin(found.path, root) || isPathWithin(root, found.path))) {
        return fail('INVALID_INPUT', DOCKER_WORKTREE_REFUSAL);
      }
    }
    if (await req.isInUse(found.path)) {
      return fail(
        'CONFLICT',
        `A live session is still running in worktree "${req.name}". Close it first, then remove the worktree.`
      );
    }
    if (found.worktree.locked) {
      return fail(
        'CONFLICT',
        `Worktree "${req.name}" is locked${found.worktree.lockReason ? ` (${found.worktree.lockReason})` : ''}. Unlock it with git first.`
      );
    }
    const removed = await git(repo.repoRoot, ['worktree', 'remove', '--', found.path], {
      timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
    });
    if (removed.code !== 0 || removed.spawnError || removed.timedOut) {
      if (removed.timedOut || removed.spawnError) return gitFailure(removed, 'removing the worktree');
      const text = gitRefusalText(removed.stderr);
      // git's own refusal (modified or untracked files, a lock): Codeman never forces, so this is
      // the answer, in git's words.
      return fail(
        'CONFLICT',
        text ? `git refused to remove the worktree: ${text}` : 'git refused to remove the worktree.',
        text
      );
    }
    const branch = found.worktree.branch;
    let branchDeleted = false;
    let branchError: string | undefined;
    if (req.deleteBranch && branch) {
      const del = await git(repo.repoRoot, ['branch', '-d', '--', branch], { timeoutMs: WORKTREE_READ_TIMEOUT_MS });
      if (del.code === 0) branchDeleted = true;
      else branchError = gitRefusalText(del.stderr) || 'git refused to delete the branch.';
    }
    return {
      ok: true,
      removed: {
        name: req.name,
        path: found.path,
        branch,
        branchDeleted,
        ...(branchError ? { branchError } : {}),
      },
    };
  });
}
