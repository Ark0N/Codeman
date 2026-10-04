/**
 * @fileoverview "What has this session's workspace not committed or pushed?": a read-only git
 * snapshot of a session's working directory, for the bottom-bar Git indicator and its panel
 * (`GET /api/sessions/:id/git-status`). Agents leave work uncommitted and unpushed; this makes that
 * visible without leaving Codeman.
 *
 * Split so the parts that matter test without a repo:
 *   - pure: `parsePorcelainV2` (status output → branch, upstream, ahead/behind, per-file entries),
 *     `parseCommitLog`
 *   - IO: `getGitWorkspaceStatus` (a handful of async, bounded, read-only `git` calls), with a short
 *     single-flight cache so several tabs polling one repo cost one set of git processes
 *
 * WHICH repositories. `getGitWorkspaceOverview` answers for the session's working directory:
 *   - inside a repository (or at its root): that one repository. git finds it by walking UP, so a
 *     subfolder reports its whole enclosing repo; a nested repo below it is just an untracked folder
 *     to the outer one, and is not scanned;
 *   - NOT inside one (a folder that holds several projects): every repository found up to two levels
 *     DOWN (`MAX_REPOS` of them, skipping dot-folders, `node_modules` and the like, never following
 *     symlinks), each reported separately;
 *   - a repository that merely sits ABOVE the workspace and is the home folder or higher (a dotfiles
 *     repo in `$HOME`, or `/`) is ignored: its dirty files are not this session's work.
 *
 * Rules the code keeps and the tests pin:
 *   - READ-ONLY and OFFLINE. It never fetches, pulls, commits or writes. "Behind" therefore reflects
 *     the last fetch (the UI says so); "ahead" and the unpushed list are exact against the
 *     remote-tracking refs already on disk. `--no-optional-locks` keeps `git status` from even
 *     refreshing the index, so polling cannot contend with the agent's own git commands.
 *   - Every call is async (`execFile`), bounded by a timeout, and never interpolates a path into a
 *     shell: the working directory is the process `cwd`, and the only operand-like input is a fixed
 *     revision range.
 *   - Output is capped: the counts are exact, the lists are not (`filesTruncated`).
 *   - git can run helpers a repository configures (`core.fsmonitor`, clean filters). A LOCAL session
 *     already runs as this same OS user, so polling adds no privilege; `core.fsmonitor` is turned off
 *     anyway. Remote and Docker sessions are never inspected (the route answers `unsupported`):
 *     a Docker workspace is writable from inside a sandbox and git here would run on the host.
 *   - Remote URLs and git's stderr can embed `user:token@host`; anything that reaches a client goes
 *     through `redactGitCredentials`.
 *
 * @module git-workspace-status
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gitNonInteractiveEnv, redactGitCredentials } from './git-clone.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
/** `git status` on a huge tree can print a lot; a bound on what we will hold. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Max file rows returned. The counts stay exact. */
export const MAX_FILES = 300;
/** Max unpushed commits listed. The count stays exact. */
export const MAX_COMMITS = 50;
/** A fresh-enough result is reused, so N tabs on one repo cost one set of git calls. */
const CACHE_TTL_MS = 4000;
const CACHE_MAX_ENTRIES = 64;

export type GitFileKind = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

export interface GitFileEntry {
  /** Path relative to the repository root, as git reports it. */
  path: string;
  /** Rename/copy source, when the entry is one. */
  origPath?: string;
  /** Status letter in the index (`M`, `A`, `D`, `R`, `C`, `T`, `.`). */
  index: string;
  /** Status letter in the working tree (`M`, `D`, `T`, `.`, ...). `?` for untracked. */
  worktree: string;
  kind: GitFileKind;
}

export interface GitCommitEntry {
  hash: string;
  author: string;
  /** Seconds since the epoch. */
  time: number;
  subject: string;
}

export interface GitWorkspaceStatus {
  /**
   * `ok`: a repository, the rest of the fields are meaningful. `not-a-repo`: nothing to show.
   * `unsupported`: a remote or Docker session (never inspected). `error`: git failed; see `error`.
   */
  state: 'ok' | 'not-a-repo' | 'unsupported' | 'error';
  reason?: 'remote' | 'docker';
  error?: string;
  repoRoot?: string;
  /** Null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  /** Behind the remote-tracking ref as of the LAST FETCH; this module never fetches. */
  behind: number;
  /** Whether the repository has any remote at all. */
  hasRemote: boolean;
  counts: {
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
    /** Distinct paths that are not committed. */
    uncommitted: number;
    stashes: number;
  };
  files: GitFileEntry[];
  filesTruncated: boolean;
  /** Commits on this branch that no remote has: exact. */
  unpushedCount: number;
  unpushed: GitCommitEntry[];
  checkedAt: number;
}

const EMPTY: Omit<GitWorkspaceStatus, 'state' | 'checkedAt'> = {
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  hasRemote: false,
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, uncommitted: 0, stashes: 0 },
  files: [],
  filesTruncated: false,
  unpushedCount: 0,
  unpushed: [],
};

export const emptyStatus = (
  state: GitWorkspaceStatus['state'],
  extra: Partial<GitWorkspaceStatus> = {}
): GitWorkspaceStatus => ({ ...EMPTY, counts: { ...EMPTY.counts }, state, checkedAt: Date.now(), ...extra });

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

export interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileEntry[];
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. Entries are NUL-separated and paths are NOT quoted,
 * so a name with spaces, quotes or a newline arrives intact. A rename/copy (`2 ...`) is followed by
 * one more NUL-terminated token holding the original path.
 */
export function parsePorcelainV2(text: string): ParsedStatus {
  const out: ParsedStatus = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = text.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [key, ...rest] = t.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') {
        out.detached = value === '(detached)';
        out.branch = out.detached ? null : value;
      } else if (key === 'branch.upstream') {
        out.upstream = value;
      } else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          out.ahead = Number(m[1]);
          out.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = t[0];
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = t.split(' ');
      const xy = f[1] ?? '..';
      out.files.push(...entriesFor(xy, f.slice(8).join(' ')));
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path  <NUL> origPath
      const f = t.split(' ');
      const xy = f[1] ?? '..';
      const path = f.slice(9).join(' ');
      const origPath = tokens[++i] ?? '';
      out.files.push(...entriesFor(xy, path, origPath));
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = t.split(' ');
      out.files.push({
        path: f.slice(10).join(' '),
        index: f[1]?.[0] ?? 'U',
        worktree: f[1]?.[1] ?? 'U',
        kind: 'conflicted',
      });
    } else if (type === '?') {
      out.files.push({ path: t.slice(2), index: '?', worktree: '?', kind: 'untracked' });
    }
    // '!' (ignored) is not requested; anything unknown is skipped rather than guessed at.
  }
  return out;
}

/** One porcelain entry can be both staged AND modified in the tree: that is two rows, one per kind. */
function entriesFor(xy: string, path: string, origPath?: string): GitFileEntry[] {
  const index = xy[0] ?? '.';
  const worktree = xy[1] ?? '.';
  const rows: GitFileEntry[] = [];
  const base = origPath ? { path, origPath } : { path };
  if (index !== '.') rows.push({ ...base, index, worktree, kind: 'staged' });
  if (worktree !== '.') rows.push({ ...base, index, worktree, kind: 'unstaged' });
  return rows;
}

/** Parse `git log --format=%h%x1f%an%x1f%ct%x1f%s%x1e`. */
export function parseCommitLog(text: string): GitCommitEntry[] {
  const out: GitCommitEntry[] = [];
  for (const record of text.split('\x1e')) {
    const r = record.replace(/^\n+/, '');
    if (!r) continue;
    const [hash, author, time, ...subject] = r.split('\x1f');
    if (!hash) continue;
    out.push({ hash, author: author ?? '', time: Number(time) || 0, subject: subject.join('\x1f') });
  }
  return out;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/** Runs `git <args>` in `cwd` and returns stdout. Injected so the cache and error paths test without git. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const runGit: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync(
    'git',
    // --no-optional-locks: never touch the index just to look. core.fsmonitor=false: do not start or
    // consult a filesystem monitor on behalf of a poll.
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...gitNonInteractiveEnv(), LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0' },
    }
  );
  return stdout;
};

function describeFailure(err: unknown): { notARepo: boolean; message: string } {
  const e = err as { code?: unknown; stderr?: unknown; message?: string };
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  if (/not a git repository/i.test(stderr)) return { notARepo: true, message: '' };
  if (e.code === 'ENOENT') return { notARepo: false, message: 'git is not installed (or the folder no longer exists)' };
  if (e.code === 'ETIMEDOUT' || (err as { killed?: boolean }).killed)
    return { notARepo: false, message: 'git timed out' };
  const text = (stderr || e.message || 'git failed').trim().split('\n')[0];
  return { notARepo: false, message: redactGitCredentials(text).slice(0, 300) };
}

async function collect(cwd: string, git: GitRunner): Promise<GitWorkspaceStatus> {
  let statusText: string;
  try {
    statusText = await git(cwd, [
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=normal',
      '--ignore-submodules=dirty',
    ]);
  } catch (err) {
    const f = describeFailure(err);
    return f.notARepo ? emptyStatus('not-a-repo') : emptyStatus('error', { error: f.message });
  }
  const parsed = parsePorcelainV2(statusText);

  const safe = async (args: string[]): Promise<string> => {
    try {
      return await git(cwd, args);
    } catch {
      return '';
    }
  };

  const hasUpstream = parsed.upstream !== null;
  // With an upstream: what is ahead of it. Without one (a branch never pushed, or a detached HEAD):
  // what is on HEAD but on no remote-tracking ref at all.
  const range = hasUpstream ? ['@{upstream}..HEAD'] : ['HEAD', '--not', '--remotes'];
  const [root, remotes, stash, countText, logText] = await Promise.all([
    safe(['rev-parse', '--show-toplevel']),
    safe(['remote']),
    safe(['stash', 'list', '--format=%gd']),
    safe(['rev-list', '--count', ...range]),
    safe(['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x1f%an%x1f%ct%x1f%s%x1e', ...range]),
  ]);

  const hasRemote = remotes.trim().length > 0;
  // A repository with no remote has nothing to push to, so "unpushed" would be every commit it has.
  const unpushedCount = hasUpstream || hasRemote ? Number(countText.trim()) || 0 : 0;
  const unpushed = unpushedCount > 0 ? parseCommitLog(logText) : [];

  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, uncommitted: 0, stashes: 0 };
  const distinct = new Set<string>();
  for (const f of parsed.files) {
    counts[f.kind]++;
    distinct.add(f.path);
  }
  counts.uncommitted = distinct.size;
  counts.stashes = stash.split('\n').filter(Boolean).length;

  return {
    state: 'ok',
    repoRoot: root.trim() || undefined,
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    hasRemote,
    counts,
    files: parsed.files.slice(0, MAX_FILES),
    filesTruncated: parsed.files.length > MAX_FILES,
    unpushedCount,
    unpushed,
    checkedAt: Date.now(),
  };
}

interface CacheEntry {
  at: number;
  value?: GitWorkspaceStatus;
  inflight?: Promise<GitWorkspaceStatus>;
}
const cache = new Map<string, CacheEntry>();

/** For tests. */
export function clearGitStatusCache(): void {
  cache.clear();
  discoveryCache.clear();
}

/**
 * The git snapshot of `cwd`. Concurrent callers share one in-flight computation, and a result younger
 * than a few seconds is reused, so several tabs polling one repo cost one set of git processes.
 * `fresh` skips the reuse (a person pressed Refresh and expects the truth) but still joins a
 * computation that is already running, which is as current as a new one would be.
 */
export async function getGitWorkspaceStatus(
  cwd: string,
  opts: { git?: GitRunner; now?: () => number; fresh?: boolean } = {}
): Promise<GitWorkspaceStatus> {
  const git = opts.git ?? runGit;
  const now = opts.now ?? Date.now;
  const hit = cache.get(cwd);
  if (hit?.inflight) return hit.inflight;
  if (!opts.fresh && hit?.value && now() - hit.at < CACHE_TTL_MS) return hit.value;

  const inflight = collect(cwd, git);
  cache.set(cwd, { at: now(), inflight });
  try {
    const value = await inflight;
    cache.set(cwd, { at: now(), value });
    if (cache.size > CACHE_MAX_ENTRIES) {
      for (const [k, v] of cache) {
        if (cache.size <= CACHE_MAX_ENTRIES) break;
        if (k !== cwd && !v.inflight) cache.delete(k);
      }
    }
    return value;
  } catch (err) {
    cache.delete(cwd);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Which repositories: the overview
// ---------------------------------------------------------------------------

/** How far below the working directory to look for repositories (`cwd/a/b` is found, `cwd/a/b/c` is not). */
const DISCOVERY_MAX_DEPTH = 2;
/** Directory entries inspected per folder, so a folder with thousands of children costs a bounded readdir. */
const DISCOVERY_MAX_ENTRIES = 300;
/** Repositories reported for one workspace. */
export const MAX_REPOS = 12;
/** The list of repositories under a folder changes rarely, so it is re-scanned far less often than status. */
const DISCOVERY_TTL_MS = 30_000;
/** Folders that are never worth descending into when looking for projects. */
const DISCOVERY_SKIP = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__', 'venv', 'vendor']);
/** Status calls in flight at once for one overview: each is several git processes. */
const STATUS_CONCURRENCY = 4;

export interface GitRepoEntry {
  /** Folder name of the repository (its root's basename). */
  name: string;
  /** The repository root relative to the working directory: `.`, `..`, `api`, `apps/web`. */
  path: string;
  status: GitWorkspaceStatus;
}

export interface GitWorkspaceOverview {
  /** `ok` when at least one repository was found; the other states are as in `GitWorkspaceStatus`. */
  state: 'ok' | 'not-a-repo' | 'unsupported' | 'error';
  reason?: 'remote' | 'docker';
  error?: string;
  repos: GitRepoEntry[];
  /** More than `MAX_REPOS` repositories were found; only the first are reported. */
  reposTruncated: boolean;
  checkedAt: number;
}

export const emptyOverview = (
  state: GitWorkspaceOverview['state'],
  extra: Partial<GitWorkspaceOverview> = {}
): GitWorkspaceOverview => ({ state, repos: [], reposTruncated: false, checkedAt: Date.now(), ...extra });

const realOr = async (p: string): Promise<string> => {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
};

/**
 * True when `repoRoot` is a repository that merely contains the workspace and is the home folder or
 * above it (`$HOME` managed as a dotfiles repo, `/`, `/home`): its changes are not the session's work.
 * A workspace that IS the repository root is never "unrelated", even when that root is the home folder.
 */
export async function isUnrelatedAncestor(repoRoot: string, cwd: string, home: string): Promise<boolean> {
  const [root, here, h] = await Promise.all([realOr(repoRoot), realOr(cwd), realOr(home)]);
  if (root === here) return false;
  return root === sep || h === root || h.startsWith(root + sep);
}

async function hasDotGit(dir: string): Promise<boolean> {
  try {
    await fs.lstat(join(dir, '.git')); // a directory, or a file (worktrees and submodules)
    return true;
  } catch {
    return false;
  }
}

/** Repositories up to `DISCOVERY_MAX_DEPTH` levels below `cwd`, nearest and alphabetical first. Never follows symlinks. */
export async function discoverChildRepos(cwd: string): Promise<{ dirs: string[]; truncated: boolean }> {
  const found: string[] = [];
  let level = [cwd];
  for (let depth = 1; depth <= DISCOVERY_MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = (await fs.readdir(dir, { withFileTypes: true })).slice(0, DISCOVERY_MAX_ENTRIES);
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        // isDirectory() is false for a symlink, which is how a link to elsewhere is never followed.
        if (!e.isDirectory() || e.name.startsWith('.') || DISCOVERY_SKIP.has(e.name)) continue;
        const child = join(dir, e.name);
        if (await hasDotGit(child)) found.push(child);
        else next.push(child);
      }
    }
    level = next;
  }
  return { dirs: found.slice(0, MAX_REPOS), truncated: found.length > MAX_REPOS };
}

const discoveryCache = new Map<string, { at: number; value: { dirs: string[]; truncated: boolean } }>();

/** Run `fn` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Everything git knows about the session's workspace: the enclosing repository when there is one,
 * otherwise each repository found below the working directory. See the module header for the rules.
 */
export async function getGitWorkspaceOverview(
  cwd: string,
  opts: { git?: GitRunner; now?: () => number; fresh?: boolean; home?: string } = {}
): Promise<GitWorkspaceOverview> {
  const now = opts.now ?? Date.now;
  const primary = await getGitWorkspaceStatus(cwd, opts);
  if (primary.state === 'error') return emptyOverview('error', { error: primary.error });

  const home = opts.home ?? homedir();
  if (primary.state === 'ok' && !(primary.repoRoot && (await isUnrelatedAncestor(primary.repoRoot, cwd, home)))) {
    const root = primary.repoRoot ?? cwd;
    return {
      state: 'ok',
      repos: [{ name: basename(root), path: relative(cwd, root) || '.', status: primary }],
      reposTruncated: false,
      checkedAt: primary.checkedAt,
    };
  }

  // Not inside a repository of this workspace: look below for projects.
  const hit = discoveryCache.get(cwd);
  let found: { dirs: string[]; truncated: boolean };
  if (!opts.fresh && hit && now() - hit.at < DISCOVERY_TTL_MS) found = hit.value;
  else {
    found = await discoverChildRepos(cwd);
    discoveryCache.set(cwd, { at: now(), value: found });
    if (discoveryCache.size > CACHE_MAX_ENTRIES) discoveryCache.delete(discoveryCache.keys().next().value as string);
  }
  const statuses = await mapLimited(found.dirs, STATUS_CONCURRENCY, (dir) => getGitWorkspaceStatus(dir, opts));
  const repos: GitRepoEntry[] = [];
  found.dirs.forEach((dir, i) => {
    const status = statuses[i];
    if (status.state === 'ok') repos.push({ name: basename(dir), path: relative(cwd, dir), status });
  });
  if (!repos.length) return emptyOverview('not-a-repo');
  return { state: 'ok', repos, reposTruncated: found.truncated, checkedAt: Date.now() };
}
