/**
 * @fileoverview Clone a Git repository into a case (issue #236).
 *
 * Split deliberately into a PURE half (URL parsing, argv/env construction,
 * `ls-remote` output parsing, git-stderr classification) and a thin IO half
 * (`probeGitRemote`, `cloneRepository`). The pure half is where every security
 * decision lives, so it is unit-testable without spawning anything.
 *
 * ## Why the URL is parsed rather than passed through
 *
 * `git clone` accepts far more than "a URL". Two families are dangerous:
 *
 * - **Transport helpers** — `ext::sh -c <cmd>` makes git execute an arbitrary
 *   command as the transport. `fd::`, and any other `<name>::<payload>` form,
 *   dispatch to a `git-remote-<name>` helper. A clone endpoint that forwards
 *   these is remote code execution, so `::` forms are rejected outright.
 * - **Option-shaped operands** — a repository starting with `-` is read by git
 *   as a flag (`--upload-pack=...`). We reject leading `-` AND pass `--` before
 *   the operands, because either alone is one typo away from being a hole.
 *
 * Everything is spawned with an argv array and NEVER through a shell, so quoting
 * is not part of the threat model here (unlike the ssh path in remote-hosts.ts,
 * which genuinely does build a shell line and must `shellescape`).
 *
 * ## Credentials are deliberately absent
 *
 * Codeman collects no tokens, and a URL carrying `user:password@` is rejected —
 * it would end up in error text, logs and (via the case name suggestion) the UI.
 * `GIT_TERMINAL_PROMPT=0` plus the askpass/BatchMode env below guarantees a
 * private repo fails FAST instead of hanging the open HTTP request on an
 * invisible username prompt. If the host's own git config (a credential helper,
 * an ssh agent, `insteadOf` rules) happens to authenticate, that is the user's
 * existing setup working — Codeman neither supplies nor stores anything.
 *
 * ## Bounded by construction
 *
 * Every git spawn has a timeout, a hard kill escalation, captured-output caps,
 * and shares a small global concurrency pool (same reasoning as
 * `document-conversion-limiter.ts`: N simultaneous clones of large repos is a
 * localhost resource-exhaustion vector). The pool's waiter queue is itself
 * bounded (overflow answers BUSY immediately), and time spent queued counts
 * against the operation's own deadline, so a caller's timeout bounds the whole
 * call rather than starting when a slot happens to free up. Cloning is
 * otherwise unbounded in disk and time, which is exactly why the caller must
 * treat the timeout as normal.
 *
 * @module git-clone
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Read a positive-integer env override, clamped into [min, max]. */
function envMs(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

/**
 * Wall-clock budget for one `git clone`. Deliberately generous (a real repo over
 * a slow link legitimately takes minutes) but always finite: the HTTP request is
 * held open for the duration, so an unbounded clone would be an unbounded
 * request. Override with CODEMAN_GIT_CLONE_TIMEOUT_MS.
 */
export const GIT_CLONE_TIMEOUT_MS = envMs('CODEMAN_GIT_CLONE_TIMEOUT_MS', 300_000, 10_000, 3_600_000);

/**
 * Budget for the `ls-remote` preflight. Short on purpose — it exists to answer
 * "can this be cloned without credentials?" while the user is still typing.
 * Override with CODEMAN_GIT_LS_REMOTE_TIMEOUT_MS.
 */
export const GIT_LS_REMOTE_TIMEOUT_MS = envMs('CODEMAN_GIT_LS_REMOTE_TIMEOUT_MS', 20_000, 2_000, 120_000);

/** Concurrent git network operations allowed process-wide. Override with CODEMAN_MAX_GIT_OPERATIONS. */
const MAX_CONCURRENT_GIT_OPERATIONS = (() => {
  const raw = Number(process.env.CODEMAN_MAX_GIT_OPERATIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
})();

/**
 * Waiters allowed BEHIND the pool before new work is refused outright with
 * BUSY. Without a bound, every queued request holds its HTTP connection (and
 * its closure) open indefinitely, so a burst of clone requests becomes the
 * memory/socket exhaustion the pool exists to prevent. Override with
 * CODEMAN_MAX_GIT_QUEUE (0 disables queuing entirely).
 */
const MAX_QUEUED_GIT_OPERATIONS = (() => {
  const raw = Number(process.env.CODEMAN_MAX_GIT_QUEUE);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 16;
})();

/** Longest accepted repository operand. Real URLs are far shorter; this bounds abuse. */
const MAX_REPOSITORY_LENGTH = 2048;
/** Longest accepted branch/tag. git's own limit is much higher; 200 covers every real ref. */
const MAX_REF_LENGTH = 200;
/** Captured stderr returned to the client, in bytes (the tail is the useful part). */
const MAX_STDERR_BYTES = 8_192;
/** Captured `ls-remote` stdout. A busy monorepo can list tens of thousands of refs. */
const MAX_LS_REMOTE_BYTES = 2_000_000;
/** Refs of each kind surfaced to the UI picker. */
const MAX_REFS_RETURNED = 500;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Transports Codeman is willing to hand to git. */
export type GitTransport = 'https' | 'http' | 'ssh' | 'git' | 'local';

export type GitUrlRejectionCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'CONTROL_CHARS'
  | 'OPTION_LIKE'
  | 'TRANSPORT_HELPER'
  | 'UNSUPPORTED_TRANSPORT'
  | 'CREDENTIALS_IN_URL'
  | 'NO_REPOSITORY_NAME'
  | 'BAD_SYNTAX';

/** A repository operand Codeman is willing to clone. */
export interface GitUrlAccepted {
  cloneable: true;
  /** The exact operand handed to git, after `--`. Never shell-interpolated. */
  repository: string;
  transport: GitTransport;
  /** Hostname (empty for `local`). */
  host: string;
  /** Owner/org path prefix, `/`-joined; empty when the URL has none. */
  owner: string;
  /** Final path segment with any `.git` suffix removed. */
  repo: string;
  /** Display label for the host, e.g. `GitHub`. Falls back to the bare host. */
  provider: string;
  /** Case-name suggestion derived from `repo`; `''` when nothing usable survives. */
  suggestedName: string;
  /** Non-blocking advisories to show next to the input. */
  warnings: string[];
}

/** A repository operand Codeman refuses, with the reason to show the user. */
export interface GitUrlRejected {
  cloneable: false;
  code: GitUrlRejectionCode;
  /** User-facing, safe to render as text. */
  message: string;
}

export type GitUrlParse = GitUrlAccepted | GitUrlRejected;

/** What `ls-remote` told us about a remote. */
export interface GitRemoteProbe {
  reachable: boolean;
  /** Branch `HEAD` points at, when the remote advertises a symref. */
  defaultBranch?: string;
  branches: string[];
  tags: string[];
  /** Set when `reachable` is false. */
  failure?: GitFailure;
  /** True when refs were dropped to stay under the surfaced-refs cap. */
  truncated?: boolean;
}

export type GitFailureCode =
  | 'GIT_MISSING'
  | 'TIMEOUT'
  | 'AUTH_REQUIRED'
  | 'NOT_FOUND'
  | 'REF_NOT_FOUND'
  | 'HOST_UNREACHABLE'
  | 'DESTINATION_EXISTS'
  | 'BUSY'
  | 'FAILED';

export interface GitFailure {
  code: GitFailureCode;
  /** User-facing summary. */
  message: string;
  /** Tail of git's own stderr, control-stripped and credential-redacted. */
  stderr: string;
}

export interface CloneOptions {
  /** Pre-validated operand from `parseGitRepositoryUrl`. */
  repository: string;
  /** Absolute destination directory. Must NOT exist; created by git. */
  destination: string;
  /** Optional branch or tag (`--branch <ref> --single-branch`). */
  ref?: string;
  /** `--depth 1`: history-less but much faster on large repos. */
  shallow?: boolean;
  timeoutMs?: number;
  /** Clear every git credential helper for this run (see `GIT_NO_CREDENTIAL_HELPERS`). */
  withoutCredentialHelpers?: boolean;
}

export type CloneResult = { ok: true; stderr: string } | { ok: false; failure: GitFailure };

// ─── Pure: repository URL parsing ────────────────────────────────────────────

/** Hosts worth naming in the UI. Anything else shows its bare hostname. */
const PROVIDER_LABELS: Record<string, string> = {
  'github.com': 'GitHub',
  'www.github.com': 'GitHub',
  'gist.github.com': 'GitHub Gist',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
  'git.sr.ht': 'SourceHut',
  'dev.azure.com': 'Azure DevOps',
  'ssh.dev.azure.com': 'Azure DevOps',
  'huggingface.co': 'Hugging Face',
};

/** `scheme://` prefix. */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
/** `<helper>::<payload>` — git transport helper dispatch (includes `ext::`). */
const TRANSPORT_HELPER_RE = /^[a-zA-Z0-9][a-zA-Z0-9+.-]*::/;
/** scp-like `[user@]host:path`, the form GitHub prints as "SSH". */
const SCP_LIKE_RE = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/)(.+)$/;
/** `C:\repos\x` / `C:/repos/x` — a Windows path, not an scp-like host. */
const WINDOWS_PATH_RE = /^[a-zA-Z]:[\\/]/;
/** Hostname or bracketed IPv6 literal, with an optional `:port`. */
const HOST_RE = /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9\-.]*[a-zA-Z0-9])?)(?::\d{1,5})?$/;
/** Anything git would not accept quietly in a branch/tag name. */
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/\-+]*$/;

/**
 * Turn a repository name into a Codeman case name.
 *
 * Case names are `[a-zA-Z0-9_-]+` everywhere else in the app (`SAFE_CASE_NAME`
 * in case-routes.ts, `CreateCaseSchema`), so anything else collapses to `-`.
 * Returns `''` when nothing usable survives, which the UI treats as "the user
 * must type a name" rather than silently inventing one.
 */
export function suggestCaseNameFromRepo(repo: string): string {
  const cleaned = repo
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)
    .replace(/[-_]+$/g, '');
  return /^[a-zA-Z0-9_-]+$/.test(cleaned) ? cleaned : '';
}

function reject(code: GitUrlRejectionCode, message: string): GitUrlRejected {
  return { cloneable: false, code, message };
}

/** Split `owner/sub/repo(.git)` into its owner prefix and repo name. */
function splitRepoPath(rawPath: string): { owner: string; repo: string } {
  const segments = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  const last = segments.pop() ?? '';
  return { owner: segments.join('/'), repo: last.replace(/\.git$/i, '') };
}

function accept(
  parts: Omit<GitUrlAccepted, 'cloneable' | 'provider' | 'suggestedName'> & { warnings: string[] }
): GitUrlParse {
  if (!parts.repo) {
    return reject(
      'NO_REPOSITORY_NAME',
      'That URL has no repository name in it. Expected something like https://github.com/owner/repo.git'
    );
  }
  return {
    cloneable: true,
    ...parts,
    provider: PROVIDER_LABELS[parts.host.toLowerCase()] || parts.host || 'local path',
    suggestedName: suggestCaseNameFromRepo(parts.repo),
  };
}

/**
 * Decide whether `input` is something Codeman will hand to `git clone`, and pull
 * the pieces the UI needs (provider, owner/repo, suggested case name) out of it.
 *
 * This is the security boundary for the clone endpoint. Read the module header
 * before loosening any branch here — `ext::`-style transports and
 * option-shaped operands are the two that turn a clone into arbitrary code
 * execution.
 *
 * Accepting a URL says nothing about whether the remote EXISTS or is public;
 * only `probeGitRemote` can answer that.
 */
export function parseGitRepositoryUrl(input: string): GitUrlParse {
  const raw = (input ?? '').trim();
  if (!raw) return reject('EMPTY', 'Enter a repository URL.');
  if (raw.length > MAX_REPOSITORY_LENGTH) {
    return reject('TOO_LONG', `Repository URL is too long (max ${MAX_REPOSITORY_LENGTH} characters).`);
  }
  // eslint-disable-next-line no-control-regex -- deliberate: reject C0/C1 and DEL.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) {
    return reject('CONTROL_CHARS', 'Repository URL contains control characters.');
  }
  if (raw.startsWith('-')) {
    // git would read this as a flag. `--` before the operands makes this
    // defence redundant; both stay, because either one alone is fragile.
    return reject('OPTION_LIKE', 'Repository URL may not start with "-".');
  }
  if (TRANSPORT_HELPER_RE.test(raw)) {
    return reject(
      'TRANSPORT_HELPER',
      'Transport helpers such as "ext::" are refused: they let a URL run commands on this machine.'
    );
  }

  const schemeMatch = SCHEME_RE.exec(raw);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'file') return parseLocalSource(raw.slice('file://'.length), raw);
    if (scheme !== 'https' && scheme !== 'http' && scheme !== 'ssh' && scheme !== 'git') {
      return reject(
        'UNSUPPORTED_TRANSPORT',
        `Unsupported transport "${scheme}://". Use https://, ssh://, git:// or an SSH address like git@host:owner/repo.git`
      );
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return reject('BAD_SYNTAX', 'That does not look like a valid URL.');
    }
    if (url.password) {
      return reject(
        'CREDENTIALS_IN_URL',
        'Remove the password from the URL. Codeman never accepts or stores Git credentials.'
      );
    }
    const host = url.host;
    if (!host || !HOST_RE.test(host)) return reject('BAD_SYNTAX', 'That URL has no usable hostname.');
    // `new URL` tolerates malformed percent-escapes ("%zz" passes through), but
    // decodeURIComponent throws on them: uncaught, that URIError was a 500 for
    // what is simply a malformed URL.
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return reject('BAD_SYNTAX', 'That URL contains an invalid percent-escape.');
    }
    const { owner, repo } = splitRepoPath(pathname);

    const warnings: string[] = [];
    if (scheme === 'http') warnings.push('Plain http:// is unencrypted. Prefer https:// when the host offers it.');
    if (scheme === 'git') warnings.push('git:// is unauthenticated and unencrypted. Prefer https:// when possible.');
    if (scheme === 'ssh') warnings.push(sshWarning(host));
    if (url.username && scheme !== 'ssh') {
      warnings.push('The username in the URL is passed to git as-is; Codeman supplies no password for it.');
    }
    return accept({
      repository: raw,
      transport: scheme as GitTransport,
      host,
      owner,
      repo,
      warnings,
    });
  }

  if (raw.startsWith('/')) return parseLocalSource(raw, raw);
  if (WINDOWS_PATH_RE.test(raw)) return parseLocalSource(raw, raw);
  if (raw.startsWith('~') || raw.startsWith('./') || raw.startsWith('../')) {
    return reject(
      'BAD_SYNTAX',
      'Use an absolute path for a local repository (no "~" or relative paths), or a full URL.'
    );
  }

  const scp = SCP_LIKE_RE.exec(raw);
  if (scp) {
    const host = scp[2];
    if (!HOST_RE.test(host)) return reject('BAD_SYNTAX', 'That does not look like a valid SSH address.');
    if (scp[1]?.includes(':')) {
      return reject(
        'CREDENTIALS_IN_URL',
        'Remove the password from the address. Codeman never accepts or stores Git credentials.'
      );
    }
    const { owner, repo } = splitRepoPath(scp[3]);
    return accept({
      repository: raw,
      transport: 'ssh',
      host,
      owner,
      repo,
      warnings: [sshWarning(host)],
    });
  }

  return reject(
    'BAD_SYNTAX',
    'Enter a full repository URL, e.g. https://github.com/owner/repo.git or git@github.com:owner/repo.git'
  );
}

function sshWarning(host: string): string {
  return `SSH clones use this machine's existing ssh keys and known_hosts for ${host}. Codeman adds no credentials, so an unconfigured key fails immediately instead of prompting.`;
}

/**
 * A local source (`file://…` or an absolute path). Kept because cloning a repo
 * that already exists on this machine is genuinely useful and involves no
 * network at all. Existence is NOT checked here (this half stays free of IO):
 * git reports a missing path perfectly well, and the preflight surfaces it.
 *
 * The route gates local sources to admins in multi-user mode: a per-user case
 * space is a read boundary, and a local clone would read straight through it
 * (the same reason `/api/cases/link` is admin-only there).
 */
function parseLocalSource(path: string, original: string): GitUrlParse {
  const cleaned = path.replace(/\/+$/, '');
  if (!cleaned || (!cleaned.startsWith('/') && !WINDOWS_PATH_RE.test(cleaned))) {
    return reject('BAD_SYNTAX', 'Local repository paths must be absolute.');
  }
  const { owner, repo } = splitRepoPath(cleaned);
  return accept({
    repository: original,
    transport: 'local',
    host: '',
    owner: owner ? `/${owner}` : '',
    repo,
    warnings: ['Local clone: git copies from this machine, no network involved.'],
  });
}

/** Is `ref` safe to pass as `--branch <ref>`? Rejects flags, spaces and `..`. */
export function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > MAX_REF_LENGTH) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.endsWith('.lock') || ref.endsWith('/')) return false;
  return SAFE_REF_RE.test(ref);
}

// ─── Pure: argv + env ────────────────────────────────────────────────────────

/**
 * Global git options that empty the credential-helper list for one run.
 *
 * Every Codeman user in multi-user mode runs git as the SAME OS account, so a
 * helper that account has (the Docker image's opt-in `gh`/`az` helpers, or a
 * user's own `gh auth setup-git`) would read private repositories on the
 * signed-in admin's behalf for anyone who can reach Clone Repo. An empty
 * `credential.helper` resets the helper list, and a command-line `-c` is read
 * last, so it also drops the URL-scoped `credential.<url>.helper` entries the
 * image configures (verified against a real private repo: refs with the helper,
 * `could not read Username` with it cleared). Public repositories are
 * unaffected. It must precede the subcommand.
 */
export const GIT_NO_CREDENTIAL_HELPERS: readonly string[] = ['-c', 'credential.helper='];

/**
 * argv for the clone. `--` separates flags from operands so neither the
 * repository nor the destination can ever be read as an option.
 */
export function buildCloneArgs(opts: CloneOptions): string[] {
  const args = [...(opts.withoutCredentialHelpers ? GIT_NO_CREDENTIAL_HELPERS : []), 'clone'];
  // `--single-branch` is what makes "just this tag/branch" cheap on a big repo.
  if (opts.ref) args.push('--single-branch', '--branch', opts.ref);
  if (opts.shallow) args.push('--depth', '1');
  args.push('--', opts.repository, opts.destination);
  return args;
}

/** argv for the preflight. `--symref` is what reveals the remote's default branch. */
export function buildLsRemoteArgs(repository: string, opts: { withoutCredentialHelpers?: boolean } = {}): string[] {
  return [
    ...(opts.withoutCredentialHelpers ? GIT_NO_CREDENTIAL_HELPERS : []),
    'ls-remote',
    '--symref',
    '--',
    repository,
  ];
}

/**
 * Environment that makes git fail instead of blocking on a prompt.
 *
 * Every entry closes one way an interactive git can hang a request that has no
 * terminal attached: the built-in prompt, a GUI/askpass helper, an ssh
 * host-key or passphrase prompt, and Git Credential Manager. `HOME` and `PATH`
 * are inherited on purpose — a user whose own ssh agent or credential helper
 * already works should keep working.
 */
export function gitNonInteractiveEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    DISPLAY: '',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND:
      base.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new -oConnectTimeout=10',
  };
}

// ─── Pure: output handling ───────────────────────────────────────────────────

/**
 * Redact any `scheme://user:secret@host` credential pair embedded in text — a
 * remote URL stored with an inline token, or git stderr echoing such a URL
 * back. Shared by the clone error path (`sanitizeGitOutput`) and the
 * repository-status card fields (`web/repo-status.ts`).
 */
export function redactGitCredentials(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]*:[^/@\s]*@/g, '$1***:***@');
}

/**
 * Make git's stderr safe to show in the browser: strip ANSI/control bytes,
 * redact any `scheme://user:secret@host` that a credential helper echoed back,
 * and keep only the tail (the last lines are the ones that say why it failed).
 */
export function sanitizeGitOutput(text: string, maxBytes = MAX_STDERR_BYTES): string {
  const redacted = redactGitCredentials(text)
    // eslint-disable-next-line no-control-regex -- deliberate: strip C0/C1 and DEL.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .trim();
  return redacted.length > maxBytes ? `…${redacted.slice(-maxBytes)}` : redacted;
}

/** Parse `git ls-remote --symref` output into a default branch plus ref lists. */
export function parseLsRemoteOutput(stdout: string): {
  defaultBranch?: string;
  branches: string[];
  tags: string[];
  truncated: boolean;
} {
  let defaultBranch: string | undefined;
  const branches: string[] = [];
  const tags: string[] = [];
  let truncated = false;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(trimmed);
    if (symref) {
      defaultBranch = symref[1];
      continue;
    }
    const ref = /^[0-9a-f]{40,64}\s+(\S+)$/.exec(trimmed);
    if (!ref) continue;
    const name = ref[1];
    // Peeled tags (`refs/tags/v1^{}`) duplicate their tag; drop them.
    if (name.endsWith('^{}')) continue;
    if (name.startsWith('refs/heads/')) {
      if (branches.length < MAX_REFS_RETURNED) branches.push(name.slice('refs/heads/'.length));
      else truncated = true;
    } else if (name.startsWith('refs/tags/')) {
      if (tags.length < MAX_REFS_RETURNED) tags.push(name.slice('refs/tags/'.length));
      else truncated = true;
    }
  }
  return { defaultBranch, branches, tags, truncated };
}

/**
 * Turn a git failure into something actionable.
 *
 * The AUTH_REQUIRED wording matters: GitHub answers "Repository not found" for a
 * private repo AND for a typo when unauthenticated, so a bare "not found" would
 * send people hunting for a spelling mistake that isn't there.
 */
export function classifyGitFailure(stderr: string, timedOut: boolean, spawnError?: string): GitFailure {
  const clean = sanitizeGitOutput(stderr);
  const lower = `${clean}\n${spawnError ?? ''}`.toLowerCase();

  if (spawnError && /enoent/i.test(spawnError)) {
    return {
      code: 'GIT_MISSING',
      message: 'git is not installed on this machine (or not on the server\u2019s PATH).',
      stderr: clean,
    };
  }
  if (spawnError && spawnError.startsWith('EBUSY')) {
    return {
      code: 'BUSY',
      message: 'Too many git operations are already running on this server. Try again in a moment.',
      stderr: clean,
    };
  }
  if (timedOut) {
    return {
      code: 'TIMEOUT',
      message:
        'Git timed out. Large repositories may need the shallow option, or a longer CODEMAN_GIT_CLONE_TIMEOUT_MS.',
      stderr: clean,
    };
  }
  if (
    /could not read username|authentication failed|terminal prompts disabled|permission denied \(publickey\)|invalid username or password|access denied/.test(
      lower
    )
  ) {
    return {
      code: 'AUTH_REQUIRED',
      message:
        "That repository needs authentication. Codeman never asks for credentials, so sign this server's git in first (for example `gh auth login` or `az login` from a shell session; the Docker image can include both, see docker/README.md), or clone it outside Codeman and add it with Link Existing.",
      stderr: clean,
    };
  }
  if (/remote branch .* not found|could not find remote branch|pathspec .* did not match/.test(lower)) {
    return { code: 'REF_NOT_FOUND', message: 'That branch or tag does not exist on the remote.', stderr: clean };
  }
  if (
    /repository not found|not found|does not exist|does not appear to be a git repository|no such file or directory/.test(
      lower
    )
  ) {
    return {
      code: 'NOT_FOUND',
      message:
        'Repository not found. Check the URL, since hosts also answer "not found" for private repositories when no credentials are supplied.',
      stderr: clean,
    };
  }
  if (/could not resolve host|connection refused|connection timed out|network is unreachable|ssl|tls/.test(lower)) {
    return { code: 'HOST_UNREACHABLE', message: 'Could not reach that host from this machine.', stderr: clean };
  }
  if (/already exists and is not an empty directory|destination path .* already exists/.test(lower)) {
    return { code: 'DESTINATION_EXISTS', message: 'The destination directory already exists.', stderr: clean };
  }
  return { code: 'FAILED', message: clean ? `git failed: ${firstLine(clean)}` : 'git failed.', stderr: clean };
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

// ─── IO: bounded git spawns ──────────────────────────────────────────────────

let activeGitOperations = 0;

type SlotAcquisition = 'acquired' | 'queue-full' | 'timed-out';
interface GitSlotWaiter {
  grant: () => void;
}
const gitWaiters: GitSlotWaiter[] = [];

/** Test/diagnostic hook: git operations currently holding a slot. */
export function getActiveGitOperationCount(): number {
  return activeGitOperations;
}

/** Test/diagnostic hook: git operations currently queued behind the pool. */
export function getQueuedGitOperationCount(): number {
  return gitWaiters.length;
}

/**
 * Acquire a pool slot, waiting at most `maxWaitMs` in a BOUNDED queue.
 *
 * Both failure modes resolve (never reject): a full queue answers immediately,
 * and a queue wait that exhausts the caller's deadline removes itself before
 * resolving, so an abandoned waiter can never be granted a slot later and leak
 * it.
 */
function acquireGitSlot(maxWaitMs: number): Promise<SlotAcquisition> {
  if (activeGitOperations < MAX_CONCURRENT_GIT_OPERATIONS) {
    activeGitOperations++;
    return Promise.resolve('acquired');
  }
  if (gitWaiters.length >= MAX_QUEUED_GIT_OPERATIONS) return Promise.resolve('queue-full');
  return new Promise<SlotAcquisition>((resolve) => {
    const waiter: GitSlotWaiter = {
      grant: () => {
        clearTimeout(timer);
        resolve('acquired');
      },
    };
    const timer = setTimeout(() => {
      const idx = gitWaiters.indexOf(waiter);
      if (idx !== -1) gitWaiters.splice(idx, 1);
      resolve('timed-out');
    }, maxWaitMs);
    gitWaiters.push(waiter);
  });
}

function releaseGitSlot(): void {
  const next = gitWaiters.shift();
  // Hand the slot straight over so the active count can never exceed the cap.
  if (next) next.grant();
  else activeGitOperations--;
}

interface GitRun {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Run git with a hard wall-clock bound and capped output capture.
 *
 * SIGTERM then SIGKILL, because `git clone` fans out into `git-remote-https` /
 * `git index-pack` children: a single polite signal to the parent can leave the
 * fetch running. `detached: true` puts the whole tree in its own process group
 * so the escalation kills the children too, which is also why the negative-pid
 * signal is used rather than `child.kill()`.
 */
async function runGit(args: string[], timeoutMs: number, maxStdoutBytes: number): Promise<GitRun> {
  // The queue wait spends the SAME deadline as the operation: `timeoutMs` is a
  // promise about the whole call, not about git's runtime after some unbounded
  // wait. A full queue is refused outright rather than queued.
  const queuedAt = Date.now();
  const slot = await acquireGitSlot(timeoutMs);
  if (slot === 'queue-full') {
    return { stdout: '', stderr: '', code: null, timedOut: false, spawnError: 'EBUSY: git operation queue is full' };
  }
  if (slot === 'timed-out') {
    return { stdout: '', stderr: '', code: null, timedOut: true };
  }
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - queuedAt));
  try {
    return await new Promise<GitRun>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('git', args, {
          env: gitNonInteractiveEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (err) {
        resolve({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: String(err) });
        return;
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
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
      }, remainingMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= maxStdoutBytes) stdout += chunk.toString('utf-8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
        // Keep a bounded tail rather than the whole (potentially huge) stream.
        if (stderr.length > MAX_STDERR_BYTES * 2) stderr = stderr.slice(-MAX_STDERR_BYTES);
      });

      const finish = (result: GitRun) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };

      child.on('error', (err) => finish({ stdout, stderr, code: null, timedOut, spawnError: String(err) }));
      child.on('close', (code) => finish({ stdout, stderr, code, timedOut }));
    });
  } finally {
    releaseGitSlot();
  }
}

/** Is a usable `git` on this machine? Memoized: the answer cannot change without a restart. */
let gitAvailable: boolean | null = null;
export function isGitAvailable(): boolean {
  if (gitAvailable !== null) return gitAvailable;
  try {
    execFileSync('git', ['--version'], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

/**
 * Ask the remote what it has, without cloning: reachability, whether it can be
 * read anonymously, its default branch, and its branch/tag lists (which the UI
 * turns into a ref picker instead of a free-text field).
 *
 * Never throws — an unreachable remote is a normal answer here, not an error.
 */
export async function probeGitRemote(
  repository: string,
  timeoutMs = GIT_LS_REMOTE_TIMEOUT_MS,
  opts: { withoutCredentialHelpers?: boolean } = {}
): Promise<GitRemoteProbe> {
  if (!isGitAvailable()) {
    return {
      reachable: false,
      branches: [],
      tags: [],
      failure: classifyGitFailure('', false, 'ENOENT: git not found'),
    };
  }
  const run = await runGit(buildLsRemoteArgs(repository, opts), timeoutMs, MAX_LS_REMOTE_BYTES);
  if (run.code !== 0 || run.spawnError) {
    return {
      reachable: false,
      branches: [],
      tags: [],
      failure: classifyGitFailure(run.stderr, run.timedOut, run.spawnError),
    };
  }
  const parsed = parseLsRemoteOutput(run.stdout);
  return {
    reachable: true,
    ...(parsed.defaultBranch ? { defaultBranch: parsed.defaultBranch } : {}),
    branches: parsed.branches,
    tags: parsed.tags,
    ...(parsed.truncated ? { truncated: true } : {}),
  };
}

/**
 * Clone `repository` into `destination`.
 *
 * git clones into an ATTEMPT-OWNED temp sibling (`.<name>.cloning-<random>`,
 * dot-prefixed so an orphan from a crash never shows up as a case), which is
 * atomically renamed into place on success. Two concurrent requests for the
 * same destination used to both pass the existence check, and the loser's
 * failure cleanup then deleted the WINNER's freshly cloned tree; now each
 * attempt only ever creates and removes its own directory, the rename decides
 * the winner, and the loser reports DESTINATION_EXISTS. The upfront existence
 * check stays as the fast path for the common non-racing case.
 *
 * Never throws; every outcome is a `CloneResult`.
 */
export async function cloneRepository(opts: CloneOptions): Promise<CloneResult> {
  if (!isGitAvailable()) {
    return { ok: false, failure: classifyGitFailure('', false, 'ENOENT: git not found') };
  }
  if (opts.ref && !isSafeGitRef(opts.ref)) {
    return {
      ok: false,
      failure: { code: 'REF_NOT_FOUND', message: 'Invalid branch or tag name.', stderr: '' },
    };
  }
  if (existsSync(opts.destination)) {
    return {
      ok: false,
      failure: { code: 'DESTINATION_EXISTS', message: 'The destination directory already exists.', stderr: '' },
    };
  }

  // Sibling of the destination (same filesystem), so the rename is atomic.
  const attemptDir = join(
    dirname(opts.destination),
    `.${basename(opts.destination)}.cloning-${randomBytes(6).toString('hex')}`
  );
  const run = await runGit(
    buildCloneArgs({ ...opts, destination: attemptDir }),
    opts.timeoutMs ?? GIT_CLONE_TIMEOUT_MS,
    MAX_STDERR_BYTES
  );
  if (run.code === 0 && !run.spawnError) {
    try {
      await rename(attemptDir, opts.destination);
      return { ok: true, stderr: sanitizeGitOutput(run.stderr) };
    } catch (err) {
      // Renaming a directory onto an existing non-empty one fails: someone
      // else won the race. Clean up OUR tree only; theirs is never touched.
      await rm(attemptDir, { recursive: true, force: true }).catch(() => {});
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EPERM') {
        return {
          ok: false,
          failure: { code: 'DESTINATION_EXISTS', message: 'The destination directory already exists.', stderr: '' },
        };
      }
      return {
        ok: false,
        failure: {
          code: 'FAILED',
          message: `Could not move the finished clone into place: ${String(err)}`,
          stderr: '',
        },
      };
    }
  }

  // Remove ONLY this attempt's temp directory (git may have written a partial
  // tree, or nothing at all). The destination is never deleted on failure.
  await rm(attemptDir, { recursive: true, force: true }).catch(() => {});
  return { ok: false, failure: classifyGitFailure(run.stderr, run.timedOut, run.spawnError) };
}
