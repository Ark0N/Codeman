/**
 * @fileoverview Tests for the Git panel's Fetch button (src/git-fetch.ts): the one git command Codeman
 * runs that writes, and the one that runs a repository's own hooks — which is why it is a click, not a poll.
 *
 * Two halves, mirroring the module:
 *
 * 1. The PURE half — the fixed argv, the failure classification, and the two reads the interval scheduler
 *    depends on: what the settings say (`gitFetchSettingsFrom`) and what a run did
 *    (`gitFetchStatusFrom`). No spawning.
 * 2. The IO half — a REAL git fetching a REAL local bare repo, so that "remote-tracking refs only" is
 *    proven against git's actual behavior: HEAD, the index and the working tree must be exactly what they
 *    were while the remote-tracking ref moves. The rest of the half uses an injected runner over real
 *    repositories on disk, because what is being pinned is WHICH repositories git is allowed to touch.
 *
 * Port: N/A (no server).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyGitFailure, isGitAvailable } from '../src/git-clone.js';
import {
  FETCH_CONCURRENCY,
  buildFetchArgs,
  describeFetchFailure,
  fetchGitWorkspaceOverview,
  gitFetchSettingsFrom,
  gitFetchStatusFrom,
  type GitFetchReport,
} from '../src/git-fetch.js';
import { runGit, type GitRunner } from '../src/git-workspace-status.js';

const ENV = {
  ...process.env,
  // As the production runner: git's messages are matched in English, and nothing reads the host's config.
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ─── The pure half ───────────────────────────────────────────────────────────

describe('buildFetchArgs', () => {
  it('pins the argv to a fetch and nothing else', () => {
    expect(buildFetchArgs()).toEqual(['fetch', '--quiet']);
    // Not just the first word: the whole argv is fixed, so no verb that changes the repository can slip in.
    for (const verb of ['commit', 'pull', 'merge', 'checkout', 'reset', 'clean', 'prune', 'gc', 'amend']) {
      expect(buildFetchArgs().join(' ')).not.toContain(verb);
    }
  });

  it('names no repository, so the repository can only be the process cwd', () => {
    // An operand-shaped argument would let a path or a URL choose the repository; the fixed argv cannot.
    for (const arg of buildFetchArgs()) {
      expect(arg.startsWith('-')).toBe(arg === '--quiet');
    }
  });
});

describe('describeFetchFailure', () => {
  it("calls a repository with no remote a fact, not a fault, in each of git's wordings", () => {
    for (const stderr of [
      'fatal: no default remote repository -- use --remote or specify a repository',
      'No remote configured',
      'fatal: nothing to fetch from remote repository',
    ]) {
      const failure = describeFetchFailure({ stderr });
      expect(failure.code).toBe('NO_REMOTE');
      expect(failure.message).toMatch(/no remote/i);
      expect(failure.message).not.toMatch(/fail|error|unable/i);
    }
  });

  it('writes its own timeout message, because the one to reuse was written for clones', () => {
    const failure = describeFetchFailure({ code: 'ETIMEDOUT', stderr: 'fatal: repository not found' });
    expect(failure.code).toBe('TIMEOUT');
    expect(failure.message).toMatch(/Git status: git timeout/);
    expect(failure.message).toMatch(/fetch from a shell/i);
    expect(failure.message).not.toBe(classifyGitFailure('fatal: repository not found', true).message);
    expect(describeFetchFailure({ killed: true, stderr: '' }).code).toBe('TIMEOUT');
  });

  it('reuses the network reasons it already knows', () => {
    const prompt = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    expect(describeFetchFailure({ stderr: prompt }).code).toBe('AUTH_REQUIRED');
    expect(describeFetchFailure({ stderr: 'git@github.com: Permission denied (publickey).' }).code).toBe(
      'AUTH_REQUIRED'
    );
    expect(describeFetchFailure({ message: 'Error: spawn git ENOENT' }).code).toBe('GIT_MISSING');
    expect(describeFetchFailure({ stderr: 'fatal: unable to access: Could not resolve host: nope.invalid' }).code).toBe(
      'HOST_UNREACHABLE'
    );
  });

  it('hands the client a redacted, control-stripped tail, never what git printed', () => {
    const failure = describeFetchFailure({
      stderr: "fatal: unable to access 'https://bob:ghp_secret@github.com/x.git/'\u001b[31m",
    });
    expect(failure.stderr).toBe("fatal: unable to access 'https://***:***@github.com/x.git/'[31m");
  });
});

// ─── The two reads the interval feature depends on ───────────────────────────

describe('gitFetchSettingsFrom', () => {
  it('is off until the user turns it on, and 300 s when nothing was chosen', () => {
    // Absent means off: a quiet install must not start running git on a timer nobody asked for.
    for (const settings of [undefined, {}, { gitFetchEnabled: false }, { gitFetchEnabled: 'true' }]) {
      expect(gitFetchSettingsFrom(settings).enabled).toBe(false);
    }
    expect(gitFetchSettingsFrom({ gitFetchEnabled: true }).enabled).toBe(true);
    expect(gitFetchSettingsFrom({}).intervalSeconds).toBe(300);
  });

  it('clamps a number outside the schema instead of trusting it, because a persisted value can predate the bounds', () => {
    expect(gitFetchSettingsFrom({ gitFetchIntervalSeconds: 1 }).intervalSeconds).toBe(30);
    expect(gitFetchSettingsFrom({ gitFetchIntervalSeconds: 99999 }).intervalSeconds).toBe(3600);
    expect(gitFetchSettingsFrom({ gitFetchIntervalSeconds: 120.6 }).intervalSeconds).toBe(121);
    expect(gitFetchSettingsFrom({ gitFetchIntervalSeconds: -300 }).intervalSeconds).toBe(30);
    // A hand-edited 0 is still a number it can act on, and acting on it means the smallest interval that runs.
    expect(gitFetchSettingsFrom({ gitFetchIntervalSeconds: 0 }).intervalSeconds).toBe(30);
  });

  it('falls back to the default on a value it cannot act on, which is what a hand-edited settings.json can hold', () => {
    for (const raw of ['300', undefined, null, NaN, Infinity, true]) {
      expect(gitFetchSettingsFrom({ gitFetchIntervalSeconds: raw }).intervalSeconds, String(raw)).toBe(300);
    }
  });
});

describe('gitFetchStatusFrom', () => {
  it('counts what a run covered and what it could not do, and names the first failure', () => {
    const report: GitFetchReport = {
      state: 'ok',
      repos: [
        { name: 'Codeman', path: '.', ok: true },
        { name: 'api', path: 'api', ok: false, failure: { code: 'NO_REMOTE', message: 'no remote', stderr: '' } },
      ],
      reposTruncated: false,
      fetchedAt: 1700,
    };
    expect(gitFetchStatusFrom(report, 'interval')).toEqual({
      ranAt: 1700,
      trigger: 'interval',
      state: 'ok',
      repos: 2,
      failed: 1,
      firstFailure: { name: 'api', code: 'NO_REMOTE' },
    });
  });

  it('keeps the trigger, because a number the user did not ask for should read differently from one they did', () => {
    const empty: GitFetchReport = { state: 'ok', repos: [], reposTruncated: false, fetchedAt: 1000 };
    expect(gitFetchStatusFrom(empty, 'click').trigger).toBe('click');
    expect(gitFetchStatusFrom(empty, 'interval').trigger).toBe('interval');
  });

  it('records a state that stopped the run, with nothing to count and no failure to name', () => {
    const status = gitFetchStatusFrom(
      { state: 'unsupported', reason: 'docker', repos: [], reposTruncated: false, fetchedAt: 5 },
      'interval'
    );
    expect(status.state).toBe('unsupported');
    expect(status.repos).toBe(0);
    expect(status.failed).toBe(0);
    expect(status.firstFailure).toBeUndefined();
  });
});

// ─── Real git, real local repository ─────────────────────────────────────────

const gitPresent = isGitAvailable();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'git-fetch-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function initRepo(path: string, remote?: string) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  // So a `file://` remote stays allowed for the production runner too, not only for this test's own git calls.
  git(path, 'config', 'protocol.file.allow', 'always');
  writeFileSync(join(path, 'f.txt'), '1\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'init');
  if (remote) git(path, 'remote', 'add', 'origin', remote);
  return path;
}

/** Records what each repository was asked to do, and lets real git answer the rest. */
function recordingRunner() {
  const calls: Array<[string, string[]]> = [];
  const runner: GitRunner = async (cwd, args, opts) => {
    calls.push([cwd, args]);
    return runGit(cwd, args, opts);
  };
  return { calls, runner };
}

describe.skipIf(!gitPresent)('fetchGitWorkspaceOverview (real git)', () => {
  let work: string;

  const snapshot = (path: string) => ({
    head: git(path, 'rev-parse', 'HEAD').trim(),
    tree: readdirSync(path, { withFileTypes: true })
      .filter((e) => e.name !== '.git' && e.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `${e.name}=${readFileSync(join(path, e.name), 'utf8')}`),
    // The global option has to come before the verb, exactly as the read-only status module runs it.
    index: git(path, '--no-optional-locks', 'status', '--porcelain=v2').trim(),
  });

  beforeEach(() => {
    const origin = join(dir, 'origin.git');
    mkdirSync(origin);
    git(origin, 'init', '--bare', '--quiet', '-b', 'main');
    work = initRepo(join(dir, 'work'), origin);
    git(work, 'push', '-q', 'origin', 'main');

    // A commit made elsewhere and pushed: work's origin/main cannot hear about it until a fetch runs.
    // This has to be a clone of origin, not a fresh init — a commit on its own root commit is no
    // descendant of what origin already holds, so pushing it is rejected as non-fast-forward.
    const other = join(dir, 'other');
    git(dir, 'clone', '-q', origin, 'other');
    git(other, 'config', 'protocol.file.allow', 'always');
    writeFileSync(join(other, 'g.txt'), '2\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'second');
    git(other, 'push', '-q', 'origin', 'main');

    // Left dirty on purpose, so the snapshot has something proving it was not touched.
    writeFileSync(join(work, 'untracked.txt'), 'u\n');
    writeFileSync(join(work, 'f.txt'), 'modified\n');
  });

  it('fetches through the production runner, moving remote-tracking refs and writing nothing else', async () => {
    // A push does not update the remote-tracking ref, so the fetch is what has to move it: 0 before, 1 after.
    expect(git(work, 'rev-list', '--count', 'main..origin/main').trim()).toBe('0');
    const before = snapshot(work);

    const report = await fetchGitWorkspaceOverview(work);
    expect(report.state).toBe('ok');
    expect(report.repos).toHaveLength(1);
    expect(report.repos[0]).toMatchObject({ name: 'work', path: '.', ok: true });
    expect(report.fetchedAt).toBeGreaterThan(0);

    expect(snapshot(work)).toEqual(before); // HEAD, the working tree and the index are exactly as they were
    expect(git(work, 'rev-list', '--count', 'main..origin/main').trim()).toBe('1');
  });

  it('fetches exactly the repositories the panel would show, in the panel order', async () => {
    const folder = join(dir, 'folder');
    for (const name of ['api', 'web']) initRepo(join(folder, name));
    mkdirSync(join(folder, 'node_modules', 'pkg'), { recursive: true }); // never a project the panel lists
    const { calls, runner } = recordingRunner();
    const report = await fetchGitWorkspaceOverview(folder, { git: runner });
    expect(report.state).toBe('ok');
    expect(report.repos.map((r) => [r.name, r.path])).toEqual([
      ['api', 'api'],
      ['web', 'web'],
    ]);
    // Only the fetches, not the resolver's own `rev-parse`: the repositories touched are the point.
    // A bounded run does not promise which one starts first, so compare the set.
    expect(calls.filter(([, args]) => args[0] === 'fetch').sort()).toEqual([
      [join(folder, 'api'), ['fetch', '--quiet']],
      [join(folder, 'web'), ['fetch', '--quiet']],
    ]);
  });

  it('never reaches an unrelated repository above the workspace', async () => {
    const home = join(dir, 'home');
    initRepo(home);
    const caseDir = join(home, 'case');
    mkdirSync(caseDir);
    const { calls, runner } = recordingRunner();
    const report = await fetchGitWorkspaceOverview(caseDir, { git: runner, home });
    expect(report.state).toBe('not-a-repo');
    expect(calls.filter(([, args]) => args[0] === 'fetch')).toEqual([]);
  });

  it('refuses a repository at or inside a Docker case workspace before any git runs', async () => {
    initRepo(join(dir, 'repo'));
    const { calls, runner } = recordingRunner();
    const report = await fetchGitWorkspaceOverview(dir, { git: runner, dockerWorkspaces: [dir] });
    expect(report).toMatchObject({ state: 'unsupported', reason: 'docker' });
    expect(calls).toEqual([]);
  });

  it('keeps a repository that could not be fetched, with its reason', async () => {
    for (const name of ['ok', 'private']) initRepo(join(dir, 'folder', name));
    const runner: GitRunner = async (cwd) => {
      if (basename(cwd) === 'private') {
        throw Object.assign(new Error('Command failed'), {
          stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        });
      }
      return '';
    };
    const report = await fetchGitWorkspaceOverview(join(dir, 'folder'), { git: runner });
    expect(report.state).toBe('ok');
    const priv = report.repos.find((r) => r.name === 'private');
    expect(priv?.ok).toBe(false);
    expect(priv?.failure?.code).toBe('AUTH_REQUIRED');
    expect(priv?.failure?.message).toMatch(/authentication/i);
    expect(report.repos.find((r) => r.name === 'ok')?.ok).toBe(true);
  });

  it("runs at most FETCH_CONCURRENCY fetches at a time, with the setting's timeout", async () => {
    const folder = join(dir, 'folder');
    for (let i = 0; i < FETCH_CONCURRENCY + 2; i++) initRepo(join(folder, `r${i}`));
    let inFlight = 0;
    let max = 0;
    const seenTimeouts = new Set<number | undefined>();
    const runner: GitRunner = async (cwd, args, opts) => {
      seenTimeouts.add(opts?.timeoutMs);
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return '';
    };
    const report = await fetchGitWorkspaceOverview(folder, { git: runner, timeoutMs: 7000 });
    expect(report.repos).toHaveLength(FETCH_CONCURRENCY + 2);
    expect(report.repos.every((r) => r.ok)).toBe(true);
    expect(max).toBe(FETCH_CONCURRENCY);
    expect(seenTimeouts).toEqual(new Set([7000]));
  });

  it('answers not-a-repo for a folder that is not a repository, running no fetch', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const { calls, runner } = recordingRunner();
    expect(await fetchGitWorkspaceOverview(plain, { git: runner })).toMatchObject({ state: 'not-a-repo', repos: [] });
    expect(calls.filter(([, args]) => args[0] === 'fetch')).toEqual([]);
  });
});
