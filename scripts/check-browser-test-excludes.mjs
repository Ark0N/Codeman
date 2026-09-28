#!/usr/bin/env node
/**
 * Browser-test exclusion check.
 *
 * `npm run test:ci` must never try to drive a real browser: CI runners (and any
 * clean checkout) have no chromium, so such a file dies with
 * `browserType.launch: Executable doesn't exist` and takes the whole suite with
 * it. `config/vitest.ci.config.ts` therefore excludes every browser-driven test
 * via `BROWSER_TEST_GLOBS` in `config/test-suites.ts`. That list is maintained
 * BY HAND, and a new browser test simply does not appear in it unless someone
 * remembers. The omission is invisible on a developer machine that has run
 * `npx playwright install`, where the test passes, and only shows up on a clean
 * runner.
 *
 * Two deliberate design choices:
 *
 * 1. **Detection is by CONTENT, not filename.** Matching `*.browser.test.ts`
 *    would miss the browser tests that predate that convention
 *    (`inline-rename`, `opencode-resize`, `webgl-fallback`,
 *    `terminal-copy-shortcut`, `codex-predictive-echo`). What actually makes a
 *    file dangerous is importing a browser driver, so that is what is tested.
 *    ⚠️ Only a DIRECT import is seen: a test that reaches playwright through a
 *    helper module (e.g. `test/mobile/helpers/browser.ts`) is not detected, so
 *    such a test still has to be added to `BROWSER_TEST_GLOBS` by hand.
 *
 * 2. **The exclusion side is answered by vitest itself**, via
 *    `vitest list --filesOnly`, rather than by re-implementing glob matching
 *    against the config's `exclude` array. Patterns there include `test/mobile/**`
 *    and `perf-*`; a hand-rolled matcher that disagreed with vitest by even one
 *    edge case would report a gap that does not exist, or miss one that does.
 *    Asking the real resolver cannot drift from the real behaviour.
 *
 * The pure pieces are exported for test/check-browser-test-excludes.test.ts; the
 * check itself only runs when this file is executed directly.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI_CONFIG = join('config', 'vitest.ci.config.ts');
const SUITES_FILE = join('config', 'test-suites.ts');

/** Importing any one of these means the test needs a real browser binary. */
const BROWSER_DRIVER =
  /\bfrom\s+['"](?:playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)['"]|\b(?:require|import)\(\s*['"](?:playwright|playwright-core|@playwright\/test|puppeteer|puppeteer-core)['"]\s*\)/;

/** @param {string} source */
export function importsBrowserDriver(source) {
  return BROWSER_DRIVER.test(source);
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/**
 * Every `*.test.ts` under `<root>/test`, as sorted repo-relative POSIX paths (the form
 * `vitest list` prints).
 *
 * @param {string} root
 * @returns {string[]}
 */
export function findTestFiles(root) {
  return walk(join(root, 'test'))
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort();
}

/**
 * The subset of {@link findTestFiles} that imports a browser driver.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function findBrowserTests(root) {
  return findTestFiles(root).filter((file) => importsBrowserDriver(readFileSync(join(root, file), 'utf8')));
}

/**
 * Parse `vitest list --filesOnly` output into a set of repo-relative paths. Stray
 * blank or decorative lines are ignored rather than assuming the format is pristine.
 *
 * @param {string} output
 * @returns {Set<string>}
 */
export function parseVitestFileList(output) {
  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.test.ts'))
      .map((line) => line.replace(/^\.\//, ''))
  );
}

/**
 * Whether the `vitest list` paths and the walked tree name at least one file in common.
 * False means the two sides are not speaking the same path format (absolute paths, backslashes
 * or a new prefix after a vitest upgrade), and then {@link findLeaks} would find nothing
 * against a perfectly non-empty listing.
 *
 * @param {Set<string>} ciFiles
 * @param {string[]} testFiles
 */
export function listingMatchesTree(ciFiles, testFiles) {
  return testFiles.some((file) => ciFiles.has(file));
}

/**
 * @param {string[]} browserTests
 * @param {Set<string>} ciFiles
 * @returns {string[]} browser-driven files that the CI config would still collect
 */
export function findLeaks(browserTests, ciFiles) {
  return browserTests.filter((file) => ciFiles.has(file));
}

function main() {
  const testFiles = findTestFiles(ROOT);
  const browserTests = findBrowserTests(ROOT);

  let collected;
  try {
    collected = execFileSync('npx', ['vitest', 'list', '--config', CI_CONFIG, '--filesOnly'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('✗ could not enumerate the CI test set via `vitest list`.');
    console.error(err.stderr ? err.stderr.toString() : String(err));
    process.exit(1);
  }

  const ciFiles = parseVitestFileList(collected);
  if (ciFiles.size === 0) {
    // An empty list would make every browser test look excluded: fail rather than pass vacuously.
    console.error('✗ `vitest list` reported no test files; refusing to pass on an empty CI set.');
    process.exit(1);
  }
  // Same vacuous pass, one step removed: a listing whose paths never match the tree. This guard,
  // not `vitest list --json`, is the answer to format drift: the JSON form prints absolute paths
  // that would need canonicalizing against ROOT (symlinked checkouts), and its shape can drift too.
  if (!listingMatchesTree(ciFiles, testFiles)) {
    const sample = [...ciFiles].slice(0, 3).join(', ');
    console.error(
      `✗ none of the ${ciFiles.size} paths \`vitest list\` reported (e.g. ${sample}) is one of the ${testFiles.length} test/**/*.test.ts files; its output format has probably changed.`
    );
    process.exit(1);
  }

  const leaked = findLeaks(browserTests, ciFiles);

  if (leaked.length > 0) {
    console.error(`✗ ${leaked.length} browser-driven test file(s) are NOT excluded from ${CI_CONFIG}:\n`);
    for (const file of leaked) console.error(`    ${file}`);
    console.error(`
These import a browser driver, so on a runner with no chromium they fail with
"browserType.launch: Executable doesn't exist" and take the suite down. Add each
to BROWSER_TEST_GLOBS in ${SUITES_FILE} (${CI_CONFIG} derives its excludes from
it, and \`npm run test:browser\` its includes).

They may well pass on this machine; that is the trap. To reproduce a clean
runner locally:
  PLAYWRIGHT_BROWSERS_PATH=\$(mktemp -d) PUPPETEER_CACHE_DIR=\$(mktemp -d) npm run test:ci`);
    process.exit(1);
  }

  console.log(
    `✓ all ${browserTests.length} browser-driven test files are excluded from the CI suite (${ciFiles.size} files collected)`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
