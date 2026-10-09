import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

type PackageLockPackage = {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type PackageLock = {
  packages: Record<string, PackageLockPackage>;
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8')) as T;
}

function compareVersions(actual: string, expected: string): number {
  const actualParts = actual.split('.').map((part) => Number(part.replace(/\D.*/, '')) || 0);
  const expectedParts = expected.split('.').map((part) => Number(part.replace(/\D.*/, '')) || 0);
  for (let i = 0; i < Math.max(actualParts.length, expectedParts.length); i++) {
    const left = actualParts[i] ?? 0;
    const right = expectedParts[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function packageNameFromLockPath(lockPath: string): string | null {
  const parts = lockPath.split('node_modules/');
  if (parts.length < 2) return null;
  return parts[parts.length - 1] ?? null;
}

function lockedVersions(lock: PackageLock, packageName: string): string[] {
  const versions = new Set<string>();
  for (const [lockPath, pkg] of Object.entries(lock.packages)) {
    if (packageNameFromLockPath(lockPath) === packageName && pkg.version) {
      versions.add(pkg.version);
    }
  }
  return [...versions].sort();
}

function expectEveryLockedVersionAtLeast(
  lock: PackageLock,
  packageName: string,
  minimum: string,
  /** Exact versions deliberately outside this policy; each call site says why. */
  exempt: string[] = []
): void {
  const versions = lockedVersions(lock, packageName);
  expect(versions, `${packageName} should be present in package-lock.json`).not.toHaveLength(0);
  for (const version of versions) {
    if (exempt.includes(version)) continue;
    expect(
      compareVersions(version, minimum),
      `${packageName}@${version} should be >= ${minimum}`
    ).toBeGreaterThanOrEqual(0);
  }
}

function expectNoVulnerableVite(lock: PackageLock): void {
  const versions = lockedVersions(lock, 'vite');
  expect(versions, 'vite should be present in package-lock.json').not.toHaveLength(0);
  for (const version of versions) {
    const major = Number(version.split('.')[0]);
    if (major === 6) {
      expect(compareVersions(version, '6.4.2'), `vite@${version} should be >= 6.4.2`).toBeGreaterThanOrEqual(0);
    } else if (major === 7) {
      expect(compareVersions(version, '7.3.2'), `vite@${version} should be >= 7.3.2`).toBeGreaterThanOrEqual(0);
    } else {
      expect(major, `vite@${version} should be on a supported patched major`).toBeGreaterThanOrEqual(8);
    }
  }
}

function expectNoVulnerablePicomatch(lock: PackageLock): void {
  const versions = lockedVersions(lock, 'picomatch');
  expect(versions, 'picomatch should be present in package-lock.json').not.toHaveLength(0);
  for (const version of versions) {
    const major = Number(version.split('.')[0]);
    if (major === 2) {
      expect(compareVersions(version, '2.3.2'), `picomatch@${version} should be >= 2.3.2`).toBeGreaterThanOrEqual(0);
    } else if (major === 4) {
      expect(compareVersions(version, '4.0.4'), `picomatch@${version} should be >= 4.0.4`).toBeGreaterThanOrEqual(0);
    }
  }
}

function expectNoVulnerableBraceExpansion(lock: PackageLock): void {
  const versions = lockedVersions(lock, 'brace-expansion');
  expect(versions, 'brace-expansion should be present in package-lock.json').not.toHaveLength(0);
  for (const version of versions) {
    const major = Number(version.split('.')[0]);
    // GHSA-3jxr-9vmj-r5cp (exponential-time expansion DoS) covers <=1.1.17 || 3.0.0 - 5.0.8,
    // which is why both live branches moved up rather than just the 5.x one.
    if (major === 1) {
      expect(
        compareVersions(version, '1.1.18'),
        `brace-expansion@${version} should be >= 1.1.18`
      ).toBeGreaterThanOrEqual(0);
    } else if (major === 4) {
      expect(
        compareVersions(version, '5.0.5'),
        `brace-expansion@${version} should not remain on vulnerable 4.x`
      ).toBeGreaterThanOrEqual(0);
    } else if (major === 5) {
      expect(compareVersions(version, '5.0.9'), `brace-expansion@${version} should be >= 5.0.9`).toBeGreaterThanOrEqual(
        0
      );
    }
  }
}

describe('dependency security policy', () => {
  it('keeps direct security-sensitive dependency ranges on patched versions', () => {
    const rootPackage = readJson<PackageLockPackage>('package.json');
    const xtermPackage = readJson<PackageLockPackage>('packages/xterm-zerolag-input/package.json');

    expect(rootPackage.dependencies?.['@fastify/static']).toBe('^10.1.3');
    expect(rootPackage.dependencies?.fastify).toBe('^5.8.5');
    expect(rootPackage.dependencies?.uuid).toBe('^14.0.0');
    expect(rootPackage.devDependencies?.['@remotion/cli']).toBe('4.0.473');
    expect(rootPackage.devDependencies?.remotion).toBe('4.0.473');
    expect(rootPackage.devDependencies?.['@remotion/transitions']).toBe('4.0.473');
    expect(rootPackage.devDependencies?.vitest).toBe('^4.1.8');
    expect(rootPackage.devDependencies?.['@vitest/coverage-v8']).toBe('^4.1.8');
    expect(xtermPackage.devDependencies?.vitest).toBe('^4.1.8');
  });

  it('keeps critical and high audit findings resolved in the lockfile', () => {
    const lock = readJson<PackageLock>('package-lock.json');

    expectEveryLockedVersionAtLeast(lock, 'vitest', '4.1.0');
    expectEveryLockedVersionAtLeast(lock, '@vitest/coverage-v8', '4.1.0');
    expectEveryLockedVersionAtLeast(lock, 'fastify', '5.8.5');
    // GHSA-8pvw-jcv7-9cmj (authorization bypass via non-canonical URL paths) covers
    // <=10.1.1, so every 9.x is affected and the fix is only on the 10.x line.
    expectEveryLockedVersionAtLeast(lock, '@fastify/static', '10.1.2');
    expectEveryLockedVersionAtLeast(lock, 'ip-address', '10.2.0');
    // Our own uuid stays >= 14. exceljs@4.4.0 (devDependency, vendored into the
    // XLSX preview worker at build time) pins uuid@8.3.2 and only calls v4();
    // GHSA-w5hq-g745-h8pq is MODERATE and covers v3/v5/v6 with a caller buffer,
    // so it is outside this CRITICAL/HIGH policy and unreachable from exceljs.
    expectEveryLockedVersionAtLeast(lock, 'uuid', '14.0.0', ['8.3.2']);
    // ⚠️ Floor stays 8.20.1, NOT 8.21.0. Production ws is already 8.21.0 and clear of
    // GHSA-96hv-2xvq-fx4p, but @remotion/renderer bundles its own ws@8.20.1 and remotion
    // is pinned to 4.0.473 on purpose (the compositor refuses to start on a version
    // mismatch). That copy is devDependencies-only and never ships to users.
    expectEveryLockedVersionAtLeast(lock, 'ws', '8.20.1');
    // GHSA-v2hh-gcrm-f6hx (host confusion via literal backslash authority delimiter)
    // covers 3.0.0 - 3.1.4.
    expectEveryLockedVersionAtLeast(lock, 'fast-uri', '3.1.5');
    // GHSA-c96f-x56v-gq3h (HTTP/2 DDoS) covers <=9.6.0.
    expectEveryLockedVersionAtLeast(lock, 'find-my-way', '9.7.0');
    expectEveryLockedVersionAtLeast(lock, 'basic-ftp', '5.3.1');
    expectEveryLockedVersionAtLeast(lock, 'flatted', '3.4.2');
    // GHSA-px8p-9vwx-vf98 (unbounded loop on a ZIP64 marker in a local header)
    // covers <=0.8.2. The XLSX preview worker streams untrusted files through
    // fflate's Unzip before any admission callback runs.
    expectEveryLockedVersionAtLeast(lock, 'fflate', '0.8.3');
    expectNoVulnerableBraceExpansion(lock);
    expectNoVulnerableVite(lock);
    expectNoVulnerablePicomatch(lock);
  });

  it('keeps standalone workspace lockfiles on patched test tooling', () => {
    const lock = readJson<PackageLock>('packages/xterm-zerolag-input/package-lock.json');

    expect(lock.packages['']?.devDependencies?.vitest).toBe('^4.1.8');
    expectEveryLockedVersionAtLeast(lock, 'vitest', '4.1.0');
    expectEveryLockedVersionAtLeast(lock, 'ws', '8.20.1');
    expectNoVulnerableVite(lock);
    expectNoVulnerablePicomatch(lock);
  });
});
