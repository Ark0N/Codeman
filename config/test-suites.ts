/**
 * The test suites that `npm test` deliberately does NOT run, in one place.
 *
 * Why this file exists: the exclusion list used to live only in
 * config/vitest.ci.config.ts, as literals. Anything excluded there was
 * therefore reachable only by running the everything-config by hand and reading
 * past its failures — and a newly excluded file was reachable by nothing at
 * all, silently, because nothing pointed at it. Both configs now derive their
 * globs from the arrays below, so adding a suite here puts it in exactly one
 * runner and takes it out of exactly one gate.
 *
 * Adding a new test that cannot run in CI: put its glob in the array that
 * describes WHY it cannot, not in whichever one is shortest.
 */

/**
 * Playwright-driven: needs chromium and, in most cases, a live Codeman server
 * on a real port. Deterministic where the environment provides both, which is
 * why these are a runnable suite (`npm run test:browser`) rather than skipped.
 */
export const BROWSER_TEST_GLOBS = [
  'test/tab-rail-resize.browser.test.ts',
  'test/session-sidebar-ux.browser.test.ts',
  'test/session-options-responsive.browser.test.ts',
  'test/inline-rename.test.ts',
  'test/opencode-resize.test.ts',
  'test/webgl-fallback.test.ts',
  'test/terminal-copy-shortcut.test.ts',
  'test/terminal-keycode229-recovery.browser.test.ts',
  'test/codex-predictive-echo.test.ts', // also needs a real codex binary
];

/**
 * Wall-clock benchmarks. They assert on durations, so a loaded shared runner
 * fails them for reasons that have nothing to do with the diff under test.
 */
export const PERF_TEST_GLOBS = ['test/perf-*.test.ts'];

/**
 * Browser + visual regression: chromium AND environment-specific PNG baselines
 * that are generated per machine. Has its own config
 * (test/mobile/vitest.config.ts) because it needs serial execution, a longer
 * timeout and the `pretest:mobile` vendor step — run it with
 * `npm run test:mobile`, not through the configs here.
 */
export const MOBILE_TEST_GLOBS = ['test/mobile/**'];

/** Everything `npm test` skips. */
export const NON_CI_TEST_GLOBS = [...MOBILE_TEST_GLOBS, ...PERF_TEST_GLOBS, ...BROWSER_TEST_GLOBS];
