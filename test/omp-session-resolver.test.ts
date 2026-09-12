/**
 * @fileoverview Tests for OMP session-id resolution from disk.
 *
 * Pins the home-relative directory mangling bug found 2026-08-27: omp
 * collapses a home-relative workingDir to its home-relative remainder BEFORE
 * dash-replacing (`/home/user/dev/foo` -> `-dev-foo`), unlike Claude Code's
 * `~/.claude/projects/*` convention (`-home-user-dev-foo`) this module was
 * originally written to mirror. Getting this wrong doesn't throw — it just
 * makes findLatestOmpSessionId() silently return null for every case under
 * $HOME (virtually all real Codeman cases), so continuation pinning quietly
 * degraded to omp's own ambiguous `--continue` while appearing to work in
 * manual testing done entirely under /tmp (which sits outside $HOME and was
 * mangled correctly by coincidence).
 *
 * test/setup.ts gives this file its own temp $HOME, so homedir() below is
 * already sandboxed — writing real files under it is safe and exercises the
 * exact home-relative path the bug hid behind.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findLatestOmpSessionId,
  mangleOmpWorkingDir,
  resolveAndClaimOmpSessionId,
} from '../src/utils/omp-session-resolver.js';
import { resolveOmpConfigForCreate } from '../src/web/routes/session-routes.js';

describe('mangleOmpWorkingDir', () => {
  it('strips the home prefix before dash-replacing a home-relative path', () => {
    const home = homedir();
    expect(mangleOmpWorkingDir(join(home, 'codeman-cases', 'testcase'))).toBe('-codeman-cases-testcase');
  });

  it('dash-replaces a path outside $HOME as-is', () => {
    expect(mangleOmpWorkingDir('/tmp/omp-verify-case')).toBe('-tmp-omp-verify-case');
  });

  it('treats workingDir === home as the empty remainder', () => {
    expect(mangleOmpWorkingDir(homedir())).toBe('');
  });

  it('does not false-positive on a sibling directory sharing a prefix with $HOME', () => {
    const sibling = `${homedir()}-other/dev/foo`;
    expect(mangleOmpWorkingDir(sibling)).toBe(sibling.replace(/\//g, '-'));
  });

  it('normalizes a trailing slash so a remote case path resolves to the same dir', () => {
    // Regression (2026-08-29): remote case paths are stored verbatim with a
    // trailing slash (e.g. `/home/user/dotfiles/`), but omp persists sessions
    // under the slash-less mangle (`-dotfiles`). Before the fix this produced
    // `-dotfiles-`, readdirSync returned null for an existing dir, and OMP
    // respawn pinning silently degraded to the ambiguous `--continue`.
    expect(mangleOmpWorkingDir(join(homedir(), 'dotfiles') + '/')).toBe('-dotfiles');
  });
});

describe('findLatestOmpSessionId', () => {
  const sessionDir = join(homedir(), '.omp', 'agent', 'sessions', '-codeman-cases-testcase');

  afterEach(() => {
    rmSync(join(homedir(), '.omp'), { recursive: true, force: true });
  });

  it('finds the newest session file under a home-relative workingDir', () => {
    const workingDir = join(homedir(), 'codeman-cases', 'testcase');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '2026-08-27T17-15-57-989Z_older-id.jsonl'), '{}');
    const newer = join(sessionDir, '2026-08-27T17-31-08-001Z_newer-id.jsonl');
    writeFileSync(newer, '{}');
    // Force a deterministic mtime order regardless of filesystem timestamp resolution.
    const now = Date.now() / 1000;
    utimesSync(join(sessionDir, '2026-08-27T17-15-57-989Z_older-id.jsonl'), now, now);
    utimesSync(newer, now + 1, now + 1);

    expect(findLatestOmpSessionId(workingDir)).toBe('newer-id');
  });

  it('returns null when the mangled directory does not exist', () => {
    expect(findLatestOmpSessionId(join(homedir(), 'never-launched'))).toBeNull();
  });
});

describe('resolveAndClaimOmpSessionId: header-cwd trailing-slash normalization', () => {
  // Sibling of the directory-mangle trailing-slash regression above, but for
  // the OTHER half of the same fix: resolveAndClaimOmpSessionId additionally
  // verifies each candidate file's own header `cwd` against workingDir (the
  // mangle is lossy, so the filename-derived id alone isn't enough — see the
  // function's doc comment). A remote case's workingDir carries a trailing
  // slash (e.g. `/home/user/dotfiles/`) but omp's header `cwd` never does;
  // without stripTrailingSlash() on BOTH sides of that comparison, a real
  // on-disk session would be found by directory but rejected by the cwd
  // check, silently degrading pinning to the ambiguous `--continue`.
  const workingDirNoSlash = join(homedir(), 'dotfiles');
  const workingDirWithSlash = `${workingDirNoSlash}/`;
  const sessionDir = join(homedir(), '.omp', 'agent', 'sessions', '-dotfiles');

  afterEach(() => {
    rmSync(join(homedir(), '.omp'), { recursive: true, force: true });
  });

  it('matches a header cwd with no trailing slash against a workingDir that has one', () => {
    mkdirSync(sessionDir, { recursive: true });
    const header = `${JSON.stringify({ type: 'session', id: 'remote-dotfiles-uuid', cwd: workingDirNoSlash })}\n`;
    writeFileSync(join(sessionDir, '2026-08-29T00-00-00-000Z_remote-dotfiles-uuid.jsonl'), header);

    expect(resolveAndClaimOmpSessionId(workingDirWithSlash)).toBe('remote-dotfiles-uuid');
  });
});

describe('resolveOmpConfigForCreate', () => {
  // The exact pipeline "resume this OMP row from the history list" drives:
  // POST /api/sessions with mode:'omp' + ompConfig:{continueSession:true}
  // must come back with resumeSessionId PINNED to the real omp transcript
  // uuid, not left as the ambiguous continueSession flag alone. This was the
  // one path flagged by review as having zero coverage despite being the
  // exact mechanism the whole resolver module exists to serve.
  const workingDir = join(homedir(), 'codeman-cases', 'resume-test');
  const sessionDir = join(homedir(), '.omp', 'agent', 'sessions', '-codeman-cases-resume-test');

  afterEach(() => {
    rmSync(join(homedir(), '.omp'), { recursive: true, force: true });
  });

  it('pins resumeSessionId from disk when resuming with only continueSession set', () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '2026-08-27T17-31-08-001Z_real-omp-uuid.jsonl'), '{}');

    const resolved = resolveOmpConfigForCreate('omp', workingDir, { continueSession: true });

    expect(resolved).toEqual({ continueSession: true, resumeSessionId: 'real-omp-uuid' });
  });

  it('does not attempt resolution when resumeSessionId is already explicit', () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '2026-08-27T17-31-08-001Z_disk-uuid.jsonl'), '{}');

    const resolved = resolveOmpConfigForCreate('omp', workingDir, {
      continueSession: true,
      resumeSessionId: 'already-pinned',
    });

    // Must return the caller's id unchanged, never overwrite it with whatever
    // happens to be newest on disk.
    expect(resolved).toEqual({ continueSession: true, resumeSessionId: 'already-pinned' });
  });

  it('leaves ompConfig unchanged when continueSession is not set', () => {
    const resolved = resolveOmpConfigForCreate('omp', workingDir, {});
    expect(resolved).toEqual({});
  });

  it('leaves ompConfig unchanged when nothing is on disk to resolve', () => {
    const resolved = resolveOmpConfigForCreate('omp', join(homedir(), 'never-launched'), {
      continueSession: true,
    });
    expect(resolved).toEqual({ continueSession: true });
  });

  it('returns undefined for a non-omp mode regardless of ompConfig', () => {
    expect(resolveOmpConfigForCreate('claude', workingDir, { continueSession: true })).toBeUndefined();
  });

  it('returns undefined when ompConfig is undefined', () => {
    expect(resolveOmpConfigForCreate('omp', workingDir, undefined)).toBeUndefined();
  });
});
