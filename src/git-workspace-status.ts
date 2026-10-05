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
 *   - git can run helpers a repository configures: a clean filter (`filter.<name>.clean`) still runs
 *     during `git status` and `git diff`, as it does for any `git status`. A LOCAL session already
 *     runs as this same OS user, so polling adds no privilege there. What is turned off: the
 *     filesystem monitor (`core.fsmonitor`), external diff and textconv drivers, and the signature
 *     program (`log.showSignature`). A repository a container can write to is NOT inspected: a
 *     Docker session answers `unsupported`, and any repository whose root is, or is inside, a Docker
 *     case workspace is dropped from the walk-up, the scan below a folder, and the diff route, because
 *     the container could have planted that config and git here would run it on the host.
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
  /**
   * The configured upstream does not exist on the remote (deleted and pruned, or never pushed, as after
   * cloning an empty repository and committing): nothing is tracked.
   */
  upstreamGone: boolean;
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
  upstreamGone: false,
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
  /** `# branch.upstream` was printed but `# branch.ab` was not: no such remote branch (deleted and pruned, or never pushed). */
  upstreamGone: boolean;
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
  const out: ParsedStatus = {
    branch: null,
    detached: false,
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    files: [],
  };
  let sawAb = false;
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
        sawAb = true;
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
  out.upstreamGone = out.upstream !== null && !sawAb;
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
    // consult a filesystem monitor on behalf of a poll. log.showSignature=false: `git log` must not run
    // a configured gpg.program to verify signatures.
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', ...args],
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

  // A configured upstream whose remote branch is gone has no `branch.ab`, and `@{upstream}` no longer
  // resolves: treat it as no usable upstream rather than letting the failed rev-list read as 0.
  const hasUpstream = parsed.upstream !== null && !parsed.upstreamGone;
  // With an upstream: what is ahead of it. Without one (a branch never pushed, a detached HEAD, or an
  // upstream that is gone): what is on HEAD but on no remote-tracking ref at all.
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
    upstreamGone: parsed.upstreamGone,
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

interface CacheEntry<T> {
  at: number;
  value?: T;
  inflight?: Promise<T>;
}
const cache = new Map<string, CacheEntry<GitWorkspaceStatus>>();

/** For tests. */
export function clearGitStatusCache(): void {
  cache.clear();
  toplevelCache.clear();
  discoveryCache.clear();
}

/**
 * `compute()` for `key`, single-flight and briefly cached: concurrent callers share the computation in
 * flight, and a result younger than `CACHE_TTL_MS` is reused. `fresh` skips the reuse (a person pressed
 * Refresh and expects the truth) but still joins a computation that is already running, which is as
 * current as a new one would be.
 */
async function singleFlight<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  opts: { now: () => number; fresh?: boolean },
  compute: () => Promise<T>
): Promise<T> {
  const hit = map.get(key);
  if (hit?.inflight) return hit.inflight;
  if (!opts.fresh && hit?.value !== undefined && opts.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const inflight = compute();
  map.set(key, { at: opts.now(), inflight });
  try {
    const value = await inflight;
    map.set(key, { at: opts.now(), value });
    if (map.size > CACHE_MAX_ENTRIES) {
      for (const [k, v] of map) {
        if (map.size <= CACHE_MAX_ENTRIES) break;
        if (k !== key && !v.inflight) map.delete(k);
      }
    }
    return value;
  } catch (err) {
    map.delete(key);
    throw err;
  }
}

/**
 * The git snapshot of `cwd`. Concurrent callers share one in-flight computation, and a result younger
 * than a few seconds is reused, so several tabs polling one repo cost one set of git processes.
 * `fresh` skips the reuse but still joins a computation already running (see `singleFlight`).
 */
export async function getGitWorkspaceStatus(
  cwd: string,
  opts: { git?: GitRunner; now?: () => number; fresh?: boolean } = {}
): Promise<GitWorkspaceStatus> {
  const git = opts.git ?? runGit;
  return singleFlight(cache, cwd, { now: opts.now ?? Date.now, fresh: opts.fresh }, () => collect(cwd, git));
}

type RepoToplevel = { state: 'ok'; root: string } | { state: 'not-a-repo' } | { state: 'error'; error: string };
const toplevelCache = new Map<string, CacheEntry<RepoToplevel>>();

/** The root of the repository enclosing `cwd` (git walks up), from one cheap `rev-parse`. Cached like the status. */
function enclosingRepoRoot(
  cwd: string,
  opts: { git?: GitRunner; now?: () => number; fresh?: boolean }
): Promise<RepoToplevel> {
  const git = opts.git ?? runGit;
  return singleFlight(toplevelCache, cwd, { now: opts.now ?? Date.now, fresh: opts.fresh }, async () => {
    try {
      const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
      return root ? { state: 'ok', root } : { state: 'not-a-repo' };
    } catch (err) {
      const f = describeFailure(err);
      return f.notARepo ? { state: 'not-a-repo' } : { state: 'error', error: f.message };
    }
  });
}

// ---------------------------------------------------------------------------
// Which repositories: the overview
// ---------------------------------------------------------------------------

/** How far below the working directory to look for repositories (`cwd/a/b` is found, `cwd/a/b/c` is not). */
const DISCOVERY_MAX_DEPTH = 2;
/** Directory entries inspected per folder (after sorting), so a folder with thousands of children stays cheap. */
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

/** Real paths of `dirs` (a Docker case workspace may be reached through a symlink). */
const realAll = (dirs: string[]): Promise<string[]> => Promise.all(dirs.map(realOr));

const isWithin = (child: string, root: string): boolean => child === root || child.startsWith(root + sep);

/**
 * True when `path` is, or is inside, any of the (already real) `roots`. Used for Docker case
 * workspaces: a container can write there, so git must not run on its behalf on the host.
 */
export async function isInsideAny(path: string, realRoots: string[]): Promise<boolean> {
  if (!realRoots.length) return false;
  const real = await realOr(path);
  return realRoots.some((r) => isWithin(real, r));
}

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

/** Most directory entries READ from one folder before sorting and slicing, so the scan of a huge folder is bounded. */
const DISCOVERY_MAX_SCAN = 5000;

/** Up to `DISCOVERY_MAX_SCAN` entries of `dir` (null when unreadable). */
async function readDirBounded(dir: string): Promise<import('node:fs').Dirent[] | null> {
  let handle;
  try {
    handle = await fs.opendir(dir);
  } catch {
    return null;
  }
  const out: import('node:fs').Dirent[] = [];
  try {
    for await (const e of handle) {
      out.push(e);
      if (out.length >= DISCOVERY_MAX_SCAN) break;
    }
  } catch {
    /* a folder that fails mid-read: use what was read */
  } finally {
    await handle.close().catch(() => {});
  }
  return out;
}

/** Repositories up to `DISCOVERY_MAX_DEPTH` levels below `cwd`, nearest and alphabetical first. Never follows symlinks. */
export async function discoverChildRepos(
  cwd: string,
  excludeRealRoots: string[] = []
): Promise<{ dirs: string[]; truncated: boolean }> {
  const found: string[] = [];
  let level = [cwd];
  for (let depth = 1; depth <= DISCOVERY_MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readDirBounded(dir);
      if (!entries) continue;
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      entries.length = Math.min(entries.length, DISCOVERY_MAX_ENTRIES);
      for (const e of entries) {
        // isDirectory() is false for a symlink, which is how a link to elsewhere is never followed.
        if (!e.isDirectory() || e.name.startsWith('.') || DISCOVERY_SKIP.has(e.name)) continue;
        const child = join(dir, e.name);
        // A Docker case workspace (or anything inside one) is never inspected, nor descended into.
        if (await isInsideAny(child, excludeRealRoots)) continue;
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

export interface GitOverviewOptions {
  git?: GitRunner;
  now?: () => number;
  fresh?: boolean;
  home?: string;
  /** Docker case workspaces (host paths): repositories at or inside these are never inspected. */
  dockerWorkspaces?: string[];
}

type WorkspaceRepos =
  | { kind: 'docker' }
  | { kind: 'error'; error: string }
  | { kind: 'enclosing'; root: string }
  | { kind: 'children'; dirs: string[]; truncated: boolean };

/**
 * WHICH repositories belong to the workspace (the module header has the rules), without a full
 * status of any of them: one cached `rev-parse` for the enclosing repository, else the cached scan
 * below the folder. The overview and the diff route both go through here, so they cannot disagree.
 */
async function resolveWorkspaceRepos(cwd: string, opts: GitOverviewOptions): Promise<WorkspaceRepos> {
  const now = opts.now ?? Date.now;
  const dockerRoots = await realAll(opts.dockerWorkspaces ?? []);
  // Checked BEFORE any git runs: git walks up from cwd, and a repository the container can write to
  // could carry config (a clean filter) that runs on the host.
  if (await isInsideAny(cwd, dockerRoots)) return { kind: 'docker' };
  // The enclosing repository is identified before its full status runs, so an unrelated one above the
  // workspace (a dotfiles repo in $HOME) costs one rev-parse, and its status failing cannot hide the
  // repositories below.
  const top = await enclosingRepoRoot(cwd, opts);
  if (top.state === 'error') return { kind: 'error', error: top.error };
  if (top.state === 'ok') {
    if (await isInsideAny(top.root, dockerRoots)) return { kind: 'docker' };
    if (!(await isUnrelatedAncestor(top.root, cwd, opts.home ?? homedir())))
      return { kind: 'enclosing', root: top.root };
  }

  // Not inside a repository of this workspace: look below for projects.
  const hit = discoveryCache.get(cwd);
  let found: { dirs: string[]; truncated: boolean };
  if (!opts.fresh && hit && now() - hit.at < DISCOVERY_TTL_MS) found = hit.value;
  else {
    found = await discoverChildRepos(cwd, dockerRoots);
    discoveryCache.set(cwd, { at: now(), value: found });
    if (discoveryCache.size > CACHE_MAX_ENTRIES) discoveryCache.delete(discoveryCache.keys().next().value as string);
  }
  // The cached list can predate a Docker case linked since: filter it against the roots as they are NOW.
  const dirs: string[] = [];
  for (const dir of found.dirs) if (!(await isInsideAny(dir, dockerRoots))) dirs.push(dir);
  return { kind: 'children', dirs, truncated: found.truncated };
}

/**
 * Everything git knows about the session's workspace: the enclosing repository when there is one,
 * otherwise each repository found below the working directory. See the module header for the rules.
 */
export async function getGitWorkspaceOverview(
  cwd: string,
  opts: GitOverviewOptions = {}
): Promise<GitWorkspaceOverview> {
  const where = await resolveWorkspaceRepos(cwd, opts);
  if (where.kind === 'docker') return emptyOverview('unsupported', { reason: 'docker' });
  if (where.kind === 'error') return emptyOverview('error', { error: where.error });
  if (where.kind === 'enclosing') {
    const primary = await getGitWorkspaceStatus(cwd, opts);
    if (primary.state === 'error') return emptyOverview('error', { error: primary.error });
    if (primary.state !== 'ok') return emptyOverview('not-a-repo');
    const root = primary.repoRoot ?? where.root;
    return {
      state: 'ok',
      repos: [{ name: basename(root), path: relative(cwd, root) || '.', status: primary }],
      reposTruncated: false,
      checkedAt: primary.checkedAt,
    };
  }

  const statuses = await mapLimited(where.dirs, STATUS_CONCURRENCY, (dir) => getGitWorkspaceStatus(dir, opts));
  const repos: GitRepoEntry[] = [];
  where.dirs.forEach((dir, i) => {
    const status = statuses[i];
    if (status.state === 'ok') repos.push({ name: basename(dir), path: relative(cwd, dir), status });
  });
  if (!repos.length) return emptyOverview('not-a-repo');
  return { state: 'ok', repos, reposTruncated: where.truncated, checkedAt: Date.now() };
}

/**
 * `repo` when it is the root of one of the repositories the overview reports for `cwd` (the same rules
 * and caches, and the Docker roots as they are now), else null. The diff route checks a requested
 * repository with this rather than recomputing every repository's status.
 */
export async function findWorkspaceRepo(
  cwd: string,
  repo: string,
  opts: GitOverviewOptions = {}
): Promise<string | null> {
  const where = await resolveWorkspaceRepos(cwd, opts);
  const roots = where.kind === 'enclosing' ? [where.root] : where.kind === 'children' ? where.dirs : [];
  // git reports a repository root with symlinks resolved; a discovered folder may be reached through one.
  for (const root of roots) if (root === repo || (await realOr(root)) === repo) return repo;
  return null;
}

// ── Per-file diff ──────────────────────────────────────────────────────────

/** Longest diff handed to the browser; beyond this it is cut at a line boundary and flagged. */
export const MAX_DIFF_BYTES = 400 * 1024;

export interface GitFileDiff {
  /** Unified diff text (empty when git reports no textual change, e.g. a mode-only edit shows its header). */
  diff: string;
  truncated: boolean;
  binary: boolean;
}

/** A repo-relative path git reported, minus anything that could escape the repo. (A leading `-` is fine: every operand follows `--`.) */
export function isSafeRepoRelativePath(p: string): boolean {
  if (!p || p.length > 4096 || p.includes('\0') || p.startsWith('/')) return false;
  return !p.split('/').includes('..');
}

/**
 * The diff of one changed file, as the panel's rows describe it: `staged` is index vs HEAD,
 * `unstaged`/`conflicted` is working tree vs index (a conflict shows git's combined diff), and
 * `untracked` is the whole file as additions. Read-only. `--no-ext-diff --no-textconv` stop the external
 * diff and textconv drivers a repository configures; a clean filter still runs, as it does for any
 * `git diff`, which is why a container-writable repository never reaches this function.
 */
export async function getGitFileDiff(
  repoRoot: string,
  file: { path: string; origPath?: string; kind: GitFileKind },
  opts: { git?: GitRunner } = {}
): Promise<GitFileDiff> {
  if (!isSafeRepoRelativePath(file.path) || (file.origPath && !isSafeRepoRelativePath(file.origPath))) {
    throw new Error('Invalid path');
  }
  const git = opts.git ?? runGit;
  const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3'];
  let args: string[];
  if (file.kind === 'untracked') args = [...base, '--no-index', '--', '/dev/null', file.path];
  else {
    const paths = file.origPath ? [file.origPath, file.path] : [file.path];
    args = file.kind === 'staged' ? [...base, '--cached', '-M', '--', ...paths] : [...base, '--', ...paths];
  }
  let out: string;
  let cutShort = false;
  try {
    out = await git(repoRoot, args);
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown };
    // `--no-index` exits 1 when the files differ, which is the normal case for it.
    if (file.kind === 'untracked' && e.code === 1 && typeof e.stdout === 'string') out = e.stdout;
    // A diff past runGit's output bound: git was stopped, and what it printed so far is cut below like
    // any oversized diff.
    else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof e.stdout === 'string') {
      out = e.stdout;
      cutShort = true;
    } else throw err;
  }
  const binary = /^Binary files .* differ$/m.test(out) || /^GIT binary patch$/m.test(out);
  if (out.length <= MAX_DIFF_BYTES) return { diff: out, truncated: cutShort, binary };
  const cut = out.lastIndexOf('\n', MAX_DIFF_BYTES);
  return { diff: out.slice(0, cut > 0 ? cut : MAX_DIFF_BYTES), truncated: true, binary };
}
