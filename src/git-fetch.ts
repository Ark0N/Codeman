/**
 * @fileoverview `git fetch` for the repositories the Git panel shows, on the user's click
 * (`POST /api/sessions/:id/git-fetch`) or on an interval the user turned on
 * (`src/git-fetch-scheduler.ts`).
 *
 * The status module (src/git-workspace-status.ts) is deliberately offline: "behind" is as of the last
 * fetch, so a number that is stale can only be made current by fetching. This is the one place Codeman
 * runs a git command that writes, and on a timer it is also the only one that can run without being asked.
 * Nothing here commits, checks out, merges or touches the working tree: `git fetch` updates remote-tracking
 * refs and nothing else, so an agent working in the same repository is not disturbed.
 *
 * Same split as git-clone.ts: the pure half (`buildFetchArgs`, `describeFetchFailure`,
 * `gitFetchSettingsFrom`, `gitFetchStatusFrom`) holds every decision and tests without spawning, and the IO
 * half runs one bounded `git fetch --quiet` per repository.
 *
 * Rules the code keeps and the tests pin:
 *   - The repository set is `resolveWorkspaceRepos`, the single source the panel and the diff route
 *     already use, so Fetch cannot reach a repository the panel would not show. The Docker rule is
 *     checked before any git runs: a repository a container can write to is refused outright, because a
 *     planted config would run on the host — and `git fetch` is exactly the command that runs a
 *     repository's own hooks (`fetch-post`), which is why a timer only runs it after the user opts in.
 *   - Bounded: the git timeout from Settings → Bottom bar per repository, `FETCH_CONCURRENCY` at a time,
 *     `MAX_REPOS_LIMIT` repositories at most, and a hard `timeout` on each spawn.
 *   - Non-interactive: `GIT_TERMINAL_PROMPT=0` and BatchMode ssh, so a private repository that needs a
 *     login fails fast instead of hanging the request on an invisible username prompt. Codeman collects
 *     no credentials; a repository the user's own git is already signed in to works because that is the
 *     user's existing setup, so unlike a clone no credential helper is disabled here.
 *   - Failure text reaching a client is control-stripped and credential-redacted (`sanitizeGitOutput`),
 *     and the browser writes it with `textContent` only.
 *
 * @module git-fetch
 */

import { execFile } from 'node:child_process';
import { basename, relative } from 'node:path';
import { promisify } from 'node:util';
import { classifyGitFailure, gitNonInteractiveEnv, sanitizeGitOutput, type GitFailureCode } from './git-clone.js';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  mapLimited,
  resolveOverviewLimits,
  resolveWorkspaceRepos,
  type GitRunner,
} from './git-workspace-status.js';

const execFileAsync = promisify(execFile);

/** Fetches in flight at once: each is one git process, and a folder can hold up to `MAX_REPOS_LIMIT`. */
export const FETCH_CONCURRENCY = 4;
/** A fetch on a busy remote can print a lot; a bound on what we will hold. */
const MAX_FETCH_OUTPUT_BYTES = 2 * 1024 * 1024;

/** The interval the user can turn on (Settings → Bottom bar, and Session Options → Git): bounds and default. */
export const DEFAULT_GIT_FETCH_INTERVAL_SECONDS = 300;
export const MIN_GIT_FETCH_INTERVAL_SECONDS = 30;
export const MAX_GIT_FETCH_INTERVAL_SECONDS = 3600;

export interface GitFetchSettings {
  enabled: boolean;
  intervalSeconds: number;
}

/**
 * A settings object as the scheduler should read it: absent means OFF, because nothing runs on a timer
 * until the user turns this on, and a number outside the schema's bounds is clamped rather than trusted.
 * Pure, so the reading itself is testable without a settings file.
 */
export function gitFetchSettingsFrom(settings: Record<string, unknown> | undefined): GitFetchSettings {
  const raw = settings?.gitFetchIntervalSeconds;
  const seconds =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_GIT_FETCH_INTERVAL_SECONDS;
  return {
    enabled: settings?.gitFetchEnabled === true,
    intervalSeconds: Math.min(MAX_GIT_FETCH_INTERVAL_SECONDS, Math.max(MIN_GIT_FETCH_INTERVAL_SECONDS, seconds)),
  };
}

/**
 * The only git command this module runs. Kept as a function so a test can pin the verb: nothing here
 * commits, checks out, merges or prunes, and no operand is interpolated — the repository is the process
 * `cwd` and the argv is fixed.
 */
export function buildFetchArgs(): string[] {
  return ['fetch', '--quiet'];
}

/**
 * A repository with no remote is a fact, not a fault. Git's wordings for it differ by version — 2.47
 * exits quietly and this code is never reached, older git says "no default remote repository" — so the
 * branch is pinned on literal fixtures and the code the panel shows is the code this writes.
 */
export type FetchFailureCode = GitFailureCode | 'NO_REMOTE';

export interface FetchFailure {
  code: FetchFailureCode;
  /** User-facing summary. */
  message: string;
  /** Tail of git's own stderr, control-stripped and credential-redacted. */
  stderr: string;
}

/**
 * A thrown git error as the panel should show it. `classifyGitFailure` (git-clone.ts) already knows the
 * network reasons — auth, an unreachable host, a missing git — so they are reused here; only its timeout
 * wording is written for clones, so the fetch path replaces it with what the user can actually do.
 */
export function describeFetchFailure(err: unknown): FetchFailure {
  const e = err as { code?: unknown; stderr?: unknown; message?: string; killed?: boolean };
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  const spawnError = typeof e.message === 'string' ? e.message : undefined;
  const clean = sanitizeGitOutput(stderr);
  const lower = `${clean}\n${spawnError ?? ''}`.toLowerCase();
  if (/no default remote repository|no remote configured|nothing to fetch/.test(lower)) {
    return {
      code: 'NO_REMOTE',
      message: 'This repository has no remote, so there is nothing to fetch.',
      stderr: clean,
    };
  }
  const timedOut = e.code === 'ETIMEDOUT' || e.killed === true;
  const failure = classifyGitFailure(stderr, timedOut, spawnError);
  if (failure.code === 'TIMEOUT')
    failure.message = 'Git timed out. Raise “Git status: git timeout” in Settings → Bottom bar, or fetch from a shell.';
  return failure;
}

/** Fetch is allowed to write refs, so this runner does not carry `--no-optional-locks`: fetch takes a required lock anyway. */
export const runFetch: GitRunner = async (cwd, args, opts) => {
  const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    timeout: opts?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: MAX_FETCH_OUTPUT_BYTES,
    env: gitNonInteractiveEnv(),
  });
  return stdout;
};

export interface GitFetchEntry {
  /** Folder name of the repository (its root's basename), as the panel names it. */
  name: string;
  /** The repository root relative to the working directory: `.`, `..`, `api`, `apps/web`. */
  path: string;
  ok: boolean;
  failure?: FetchFailure;
}

export interface GitFetchReport {
  /** `ok` when at least one repository was fetched (or attempted); the other states are as in the overview. */
  state: 'ok' | 'not-a-repo' | 'unsupported' | 'error';
  reason?: 'remote' | 'docker';
  error?: string;
  /** One entry per repository fetched, in the same order the panel lists them. */
  repos: GitFetchEntry[];
  /** More than `repoLimit` repositories were found; only the first were fetched. */
  reposTruncated: boolean;
  /** The most repositories this fetch would list (the caller's setting, or `MAX_REPOS`). */
  repoLimit?: number;
  /** When the last repository finished, so the panel can say what the "behind" number is now based on. */
  fetchedAt: number;
}

/**
 * What one run did, in the shape a session keeps and the Session Options Git row shows. `trigger` says
 * whether the user clicked or the interval fired, because a number the user did not ask for should read
 * differently from one they did.
 */
export interface GitFetchStatus {
  ranAt: number;
  trigger: 'click' | 'interval';
  /** As in the report: `ok`, or the state that stopped the run. */
  state: GitFetchReport['state'];
  /** Repositories this run covered. */
  repos: number;
  /** How many of them could not be fetched. */
  failed: number;
  /** The first failure, named: enough for one row without reprinting the whole list. */
  firstFailure?: { name: string; code: FetchFailureCode };
}

export function gitFetchStatusFrom(report: GitFetchReport, trigger: GitFetchStatus['trigger']): GitFetchStatus {
  const failed = report.repos.filter((r) => !r.ok);
  const status: GitFetchStatus = {
    ranAt: report.fetchedAt,
    trigger,
    state: report.state,
    repos: report.repos.length,
    failed: failed.length,
  };
  const first = failed[0];
  if (first?.failure) status.firstFailure = { name: first.name, code: first.failure.code };
  return status;
}

/** Options for the fetch path: the same repository rules and limits as an overview, without its cache clock. */
export interface GitFetchOptions {
  git?: GitRunner;
  home?: string;
  dockerWorkspaces?: string[];
  maxRepos?: number;
  timeoutMs?: number;
}

export const emptyReport = (state: GitFetchReport['state'], extra: Partial<GitFetchReport> = {}): GitFetchReport => ({
  state,
  repos: [],
  reposTruncated: false,
  fetchedAt: Date.now(),
  ...extra,
});

async function fetchOne(dir: string, git: GitRunner, timeoutMs: number): Promise<FetchFailure | null> {
  try {
    await git(dir, buildFetchArgs(), { timeoutMs });
    return null;
  } catch (err) {
    return describeFetchFailure(err);
  }
}

/**
 * Fetch every repository the panel would show for `cwd`, through the same resolver so the two cannot
 * disagree. A repository that failed keeps its row with the reason, exactly as an unreadable repository
 * stays in the status list: the panel must show that something was not fetched rather than quietly skip it.
 */
export async function fetchGitWorkspaceOverview(cwd: string, opts: GitFetchOptions = {}): Promise<GitFetchReport> {
  const where = await resolveWorkspaceRepos(cwd, opts);
  if (where.kind === 'docker') return emptyReport('unsupported', { reason: 'docker' });
  if (where.kind === 'error') return emptyReport('error', { error: where.error });
  const dirs = where.kind === 'enclosing' ? [where.root] : where.dirs;
  if (!dirs.length) return emptyReport('not-a-repo');
  const { timeoutMs } = resolveOverviewLimits(opts);
  const runner = opts.git ?? runFetch;
  const failures = await mapLimited(dirs, FETCH_CONCURRENCY, (dir) => fetchOne(dir, runner, timeoutMs));
  const repos: GitFetchEntry[] = dirs.map((dir, i) => {
    const base = { name: basename(dir), path: relative(cwd, dir) || '.' };
    const failure = failures[i];
    return failure ? { ...base, ok: false, failure } : { ...base, ok: true };
  });
  return {
    state: 'ok',
    repos,
    reposTruncated: where.kind === 'children' ? where.truncated : false,
    repoLimit: resolveOverviewLimits(opts).maxRepos,
    fetchedAt: Date.now(),
  };
}
