/**
 * Reusable async test helpers.
 */

import { rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/** Wait for an EventEmitter to emit a specific event, with timeout */
export function waitForEvent(
  emitter: { once: (event: string, listener: (...args: unknown[]) => void) => void },
  event: string,
  timeoutMs = 5000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`)),
      timeoutMs
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/** Create a deferred promise with external resolve/reject */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Prefix of the throwaway HOME `test/setup.ts` creates (`mkdtempSync(join(tmpdir(), 'codeman-vitest-'))`).
 * Pinned by test/test-env-isolation.test.ts, so renaming one without the other fails there.
 */
export const TEST_HOME_PREFIX = 'codeman-vitest-';

/**
 * True only when `process.env.HOME` is the throwaway directory `test/setup.ts` made.
 *
 * ⚠️ This is what the helpers below hang on, and it exists because "is the path under HOME"
 * is a vacuous question when setup never ran: a bare `vitest` invocation has no setupFiles,
 * HOME is the developer's REAL home, and every real file is then "under the test HOME". That is
 * how a bare run on 2026-10-10 deleted the real linked-cases registry through a guard that was
 * written to prevent exactly that. The temp directory's name is the only thing a real home
 * cannot have.
 */
export function isSandboxedHome(): boolean {
  const home = process.env.HOME;
  return !!home && basename(resolve(home)).startsWith(TEST_HOME_PREFIX);
}

/**
 * Throw unless the suite is running under `test/setup.ts`'s temp HOME. The shared route harness
 * (`createRouteTestHarness`) calls this, so a route test built on it refuses to start against a real
 * `~/.codeman`. A route test that builds its own app from `createMockRouteContext` is not covered.
 */
export function assertSandboxedHome(what = 'this test'): void {
  if (!isSandboxedHome()) {
    throw new Error(
      `${what} reads and writes Codeman's data files and must run under test/setup.ts's temp HOME ` +
        `(HOME=${process.env.HOME ?? '(unset)'}). Run it with \`npm test\` or ` +
        `\`npx vitest run --config config/vitest.ci.config.ts <file>\`, never with a bare vitest.`
    );
  }
}

/**
 * Delete a directory tree, but ONLY when it lives inside the test HOME.
 *
 * SAFETY (2026-08-29, tightened 2026-10-12): `test/setup.ts` redirects `process.env.HOME` to a
 * throwaway dir and `os.homedir()` follows it, so a `rmSync(CASES_DIR, recursive)` normally
 * lands inside the fixture. This gate is defense in depth for the day that stops being true
 * (a test that runs outside setup.ts, an env override that anchors a path elsewhere): it
 * refuses to delete anything unless HOME IS the throwaway dir ({@link isSandboxedHome}) and the
 * target is under it, so the failure mode is a leftover temp dir rather than a deleted
 * PRODUCTION `~/codeman-cases`. The first version only checked "under HOME", which a run
 * without setup.ts satisfied for the user's real home.
 * Lexical `resolve()` is used because the leaf often does not exist and
 * `realpathSync` would throw.
 */
export function safeRmHomeTree(path: string): void {
  if (!isUnderTestHome(path)) return;
  rmSync(resolve(path), { recursive: true, force: true });
}

/**
 * True when `path` resolves strictly inside the throwaway test HOME (or to it), and false
 * whenever HOME is anything else. Same rationale as `safeRmHomeTree`; use for guarded
 * non-recursive deletes (single files like `linked-cases.json`) so they can never touch
 * prod state.
 */
export function isUnderTestHome(path: string): boolean {
  if (!isSandboxedHome()) return false;
  const root = resolve(process.env.HOME as string);
  const target = resolve(path);
  return target === root || target.startsWith(root + '/');
}
