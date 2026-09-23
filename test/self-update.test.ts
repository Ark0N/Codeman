/**
 * @fileoverview Unit tests for the self-updater's pure logic: release-tag/semver
 * parsing, "update available" computation, and the boot-time reconcile state
 * machine. No IO, no tmux, no port — safe to run individually.
 *
 *   npm test -- test/self-update.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  parseVersionFromTag,
  compareVersions,
  isNewerStableVersion,
  pickLatestStableTag,
  isValidReleaseTag,
  parseGitHubRepo,
  reconcileStatusDecision,
  expireStalledStatus,
} from '../src/web/self-update.js';
import type { UpdateStatus } from '../src/types/update.js';

describe('parseVersionFromTag', () => {
  it('parses the codeman@ / aicodeman@ / v / bare forms', () => {
    expect(parseVersionFromTag('codeman@0.9.3')).toMatchObject({ major: 0, minor: 9, patch: 3, prerelease: '' });
    expect(parseVersionFromTag('aicodeman@1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersionFromTag('v0.10.0')).toMatchObject({ major: 0, minor: 10, patch: 0 });
    expect(parseVersionFromTag('0.9.3')).toMatchObject({ major: 0, minor: 9, patch: 3 });
  });

  it('captures a prerelease suffix', () => {
    expect(parseVersionFromTag('codeman@0.9.3-rc1')).toMatchObject({ patch: 3, prerelease: 'rc1' });
  });

  it('returns null when there is no X.Y.Z', () => {
    expect(parseVersionFromTag('codeman@latest')).toBeNull();
    expect(parseVersionFromTag('garbage')).toBeNull();
  });
});

describe('compareVersions', () => {
  const v = (s: string) => parseVersionFromTag(s)!;
  it('orders by major/minor/patch', () => {
    expect(compareVersions(v('0.10.0'), v('0.9.3'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.9.3'), v('0.10.0'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0'), v('0.99.99'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.9.3'), v('0.9.3'))).toBe(0);
  });

  it('ranks a release above a prerelease of the same core', () => {
    expect(compareVersions(v('0.9.3'), v('0.9.3-rc1'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.9.3-rc1'), v('0.9.3'))).toBeLessThan(0);
  });
});

describe('isNewerStableVersion', () => {
  it('true only for a strictly newer stable release', () => {
    expect(isNewerStableVersion('0.9.3', '0.9.4')).toBe(true);
    expect(isNewerStableVersion('0.9.3', '0.10.0')).toBe(true);
  });
  it('false for same/older', () => {
    expect(isNewerStableVersion('0.9.3', '0.9.3')).toBe(false);
    expect(isNewerStableVersion('0.9.4', '0.9.3')).toBe(false);
  });
  it('never offers a prerelease as an update', () => {
    expect(isNewerStableVersion('0.9.3', '0.9.4-rc1')).toBe(false);
  });
  it('false on unparseable input', () => {
    expect(isNewerStableVersion('0.9.3', 'nope')).toBe(false);
  });
});

describe('pickLatestStableTag', () => {
  it('picks the highest stable tag from ls-remote-style refs', () => {
    const refs = [
      'deadbeef\trefs/tags/codeman@0.8.2',
      'cafef00d\trefs/tags/codeman@0.9.3',
      'abc123\trefs/tags/codeman@0.10.0',
      'abc123\trefs/tags/codeman@0.10.0^{}', // dereferenced dup
    ];
    expect(pickLatestStableTag(refs)).toEqual({ tag: 'codeman@0.10.0', version: '0.10.0' });
  });

  it('skips prereleases and unrecognized tags', () => {
    const refs = ['x\trefs/tags/codeman@0.9.3', 'y\trefs/tags/codeman@0.9.4-rc1', 'z\trefs/tags/some-random-tag'];
    expect(pickLatestStableTag(refs)).toEqual({ tag: 'codeman@0.9.3', version: '0.9.3' });
  });

  it('returns null when nothing matches', () => {
    expect(pickLatestStableTag([])).toBeNull();
    expect(pickLatestStableTag(['refs/tags/nightly', 'refs/heads/master'])).toBeNull();
  });
});

describe('isValidReleaseTag', () => {
  it('accepts only codeman@/aicodeman@ X.Y.Z (shell-injection guard)', () => {
    expect(isValidReleaseTag('codeman@0.9.4')).toBe(true);
    expect(isValidReleaseTag('aicodeman@1.0.0')).toBe(true);
    expect(isValidReleaseTag('v0.9.4')).toBe(false);
    expect(isValidReleaseTag('codeman@0.9.4; rm -rf /')).toBe(false);
    expect(isValidReleaseTag('codeman@latest')).toBe(false);
  });
});

describe('parseGitHubRepo', () => {
  it('handles SSH and HTTPS remotes', () => {
    expect(parseGitHubRepo('git@github.com:Ark0N/Codeman.git')).toEqual({ owner: 'Ark0N', repo: 'Codeman' });
    expect(parseGitHubRepo('https://github.com/Ark0N/Codeman.git')).toEqual({ owner: 'Ark0N', repo: 'Codeman' });
    expect(parseGitHubRepo('https://github.com/Ark0N/Codeman')).toEqual({ owner: 'Ark0N', repo: 'Codeman' });
  });
  it('returns null for non-GitHub remotes', () => {
    expect(parseGitHubRepo('https://gitlab.com/x/y.git')).toBeNull();
  });
});

describe('reconcileStatusDecision (boot handoff state machine)', () => {
  const NOW = 1_000_000_000_000;
  const base = (over: Partial<UpdateStatus>): UpdateStatus => ({
    updateId: 'u1',
    phase: 'restarting',
    message: '',
    fromVersion: '0.9.3',
    toVersion: '0.9.4',
    startedAt: NOW - 5_000,
    updatedAt: NOW - 5_000,
    ...over,
  });

  it('no status / terminal status → untouched', () => {
    expect(reconcileStatusDecision(null, '0.9.4', NOW)).toBeNull();
    expect(reconcileStatusDecision(base({ phase: 'completed' }), '0.9.4', NOW)).toBeNull();
    expect(reconcileStatusDecision(base({ phase: 'failed' }), '0.9.4', NOW)).toBeNull();
  });

  it('restarting + running version matches target → completed', () => {
    const out = reconcileStatusDecision(base({ phase: 'restarting' }), '0.9.4', NOW);
    expect(out?.phase).toBe('completed');
    expect(out?.updatedAt).toBe(NOW);
  });

  it('restarting + version unchanged → failed', () => {
    const out = reconcileStatusDecision(base({ phase: 'restarting' }), '0.9.3', NOW);
    expect(out?.phase).toBe('failed');
    expect(out?.error).toContain('0.9.4');
  });

  it('a fresh non-restart in-flight phase is left for the live updater', () => {
    expect(reconcileStatusDecision(base({ phase: 'building' }), '0.9.3', NOW)).toBeNull();
    expect(reconcileStatusDecision(base({ phase: 'installing' }), '0.9.3', NOW)).toBeNull();
  });

  it('a stale (abandoned) in-flight phase is failed by the backstop', () => {
    const stale = base({ phase: 'building', startedAt: NOW - 20 * 60 * 1000 });
    const out = reconcileStatusDecision(stale, '0.9.3', NOW);
    expect(out?.phase).toBe('failed');
    expect(out?.error).toContain('building');
  });

  it('needs-manual-restart + now running the target version → completed', () => {
    const out = reconcileStatusDecision(base({ phase: 'completed-needs-manual-restart' }), '0.9.4', NOW);
    expect(out?.phase).toBe('completed');
    expect(out?.message).toContain('0.9.4');
    expect(out?.updatedAt).toBe(NOW);
  });

  it('needs-manual-restart + still on the old version → untouched (restart pending)', () => {
    expect(reconcileStatusDecision(base({ phase: 'completed-needs-manual-restart' }), '0.9.3', NOW)).toBeNull();
    const noTarget = base({ phase: 'completed-needs-manual-restart', toVersion: undefined });
    expect(reconcileStatusDecision(noTarget, '0.9.4', NOW)).toBeNull();
  });
});

describe('expireStalledStatus (runtime staleness backstop)', () => {
  const NOW = 1_000_000_000_000;
  const MIN = 60 * 1000;
  const base = (over: Partial<UpdateStatus>): UpdateStatus => ({
    updateId: 'u1',
    phase: 'queued',
    message: '',
    fromVersion: '1.24.7',
    toVersion: '1.29.0',
    startedAt: NOW - 5_000,
    updatedAt: NOW - 5_000,
    ...over,
  });

  it('leaves a heartbeating update alone', () => {
    expect(
      expireStalledStatus(base({ phase: 'installing', startedAt: NOW - 60 * MIN, updatedAt: NOW - 3_000 }), NOW)
    ).toBeNull();
  });

  it('fails a status that stopped heartbeating (queued forever: status writes were failing)', () => {
    const out = expireStalledStatus(
      base({ startedAt: NOW - 8 * 24 * 60 * MIN, updatedAt: NOW - 8 * 24 * 60 * MIN }),
      NOW
    );
    expect(out?.phase).toBe('failed');
    expect(out?.error).toContain('queued');
    expect(out?.updatedAt).toBe(NOW);
  });

  it('never touches terminal phases or a missing status', () => {
    expect(expireStalledStatus(null, NOW)).toBeNull();
    expect(expireStalledStatus(base({ phase: 'completed', updatedAt: NOW - 60 * MIN }), NOW)).toBeNull();
    expect(expireStalledStatus(base({ phase: 'failed', updatedAt: NOW - 60 * MIN }), NOW)).toBeNull();
  });
});
