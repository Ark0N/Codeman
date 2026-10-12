/**
 * @fileoverview The test-only deletion guards must treat a REAL home as "not the test HOME".
 *
 * `safeRmHomeTree` and `isUnderTestHome` were written so a test could never delete production
 * state, and they asked "is this path under `process.env.HOME`?". With `test/setup.ts` skipped
 * (a bare `vitest`), HOME is the developer's real home, so that answer is "yes" for every real
 * file, and on 2026-10-10 they approved wiping the real linked-cases registry. They now also
 * require HOME to be the throwaway directory setup.ts made.
 *
 * Port: none. Everything happens in a temp tree; HOME is stubbed for the duration of a test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEST_HOME_PREFIX,
  assertSandboxedHome,
  isSandboxedHome,
  isUnderTestHome,
  safeRmHomeTree,
} from './mocks/index.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

const made: string[] = [];
/** A stand-in for a developer's REAL home: a real directory with real files, not a sandbox name. */
function fakeRealHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'not-the-sandbox-'));
  made.push(dir);
  mkdirSync(join(dir, '.codeman'));
  writeFileSync(join(dir, '.codeman', 'linked-cases.json'), '{"keep":"/me"}');
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('test HOME guards', () => {
  it('this suite really runs under the sandboxed HOME', () => {
    expect(isSandboxedHome()).toBe(true);
    expect(() => assertSandboxedHome()).not.toThrow();
  });

  it('pins the prefix test/setup.ts creates', () => {
    expect(TEST_HOME_PREFIX).toBe('codeman-vitest-');
  });

  it('safeRmHomeTree does not delete anything under a real home', () => {
    const home = fakeRealHome();
    vi.stubEnv('HOME', home);
    safeRmHomeTree(join(home, '.codeman'));
    expect(existsSync(join(home, '.codeman', 'linked-cases.json'))).toBe(true);
  });

  it('isUnderTestHome is false for a real home, even for a file inside it', () => {
    const home = fakeRealHome();
    vi.stubEnv('HOME', home);
    expect(isSandboxedHome()).toBe(false);
    expect(isUnderTestHome(join(home, '.codeman', 'linked-cases.json'))).toBe(false);
  });

  it('still deletes inside the real sandbox', () => {
    const inside = mkdtempSync(join(process.env.HOME as string, 'guard-'));
    writeFileSync(join(inside, 'f'), 'x');
    expect(isUnderTestHome(inside)).toBe(true);
    safeRmHomeTree(inside);
    expect(existsSync(inside)).toBe(false);
  });

  it('the route harness refuses to start against a real home', async () => {
    const home = fakeRealHome();
    vi.stubEnv('HOME', home);
    await expect(createRouteTestHarness(() => undefined)).rejects.toThrow(/temp HOME/);
    expect(existsSync(join(home, '.codeman', 'linked-cases.json'))).toBe(true);
  });
});
