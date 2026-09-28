/**
 * @fileoverview scripts/check-browser-test-excludes.mjs: the detection side (which test
 * files need a real browser) and the leak computation. The exclusion side is vitest's own
 * `vitest list`, which `npm run check:browser-excludes` exercises for real in CI.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  findBrowserTests,
  findLeaks,
  findTestFiles,
  importsBrowserDriver,
  listingMatchesTree,
  parseVitestFileList,
} from '../scripts/check-browser-test-excludes.mjs';
import { BROWSER_TEST_GLOBS } from '../config/test-suites';

const repoRoot = resolve(import.meta.dirname, '..');

// Fixture sources are assembled from the module name at runtime, so THIS file never contains
// a literal driver import and is not itself flagged by the checker it tests.
const fromImport = (mod: string) => `import { chromium, type Browser } from '${mod}';\n`;

describe('importsBrowserDriver', () => {
  it.each([
    fromImport('playwright'),
    fromImport('playwright-core').replace(/'/g, '"'),
    fromImport('@playwright/test'),
    fromImport('puppeteer'),
    `import type { Page } from '${'playwright'}';`,
    `const { chromium } = require('${'playwright'}');`,
    `const pw = await import('${'playwright'}');`,
  ])('flags %s', (src) => {
    expect(importsBrowserDriver(src)).toBe(true);
  });

  it.each([
    "import { describe } from 'vitest';",
    "// needs ms-playwright's cache dir\nconst dir = '.cache/ms-playwright';",
    fromImport('./playwright-helpers'),
    fromImport('playwright-extra-thing'),
  ])('ignores %s', (src) => {
    expect(importsBrowserDriver(src)).toBe(false);
  });
});

describe('findBrowserTests (fixture tree)', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-browser-excludes-'));
    const put = (rel: string, src: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), src);
    };
    put('test/unit.test.ts', "import { it } from 'vitest';\n");
    put('test/legacy-name.test.ts', fromImport('playwright'));
    put('test/new.browser.test.ts', fromImport('playwright'));
    put('test/nested/deep.test.ts', fromImport('puppeteer'));
    put('test/helpers/browser.ts', fromImport('playwright')); // not a test file
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds driver imports by content, recursively, as sorted repo-relative paths', () => {
    expect(findBrowserTests(root)).toEqual([
      'test/legacy-name.test.ts',
      'test/nested/deep.test.ts',
      'test/new.browser.test.ts',
    ]);
  });

  it('lists every test file, browser-driven or not, in the same form', () => {
    expect(findTestFiles(root)).toEqual([
      'test/legacy-name.test.ts',
      'test/nested/deep.test.ts',
      'test/new.browser.test.ts',
      'test/unit.test.ts',
    ]);
  });
});

describe('parseVitestFileList + findLeaks', () => {
  it('keeps only test paths and normalizes a leading ./', () => {
    const out = '\n./test/a.test.ts\ntest/b.test.ts\nsome banner line\n  test/c.test.ts  \n';
    expect([...parseVitestFileList(out)].sort()).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts']);
  });

  it('reports exactly the browser tests the CI set still collects', () => {
    const ci = new Set(['test/unit.test.ts', 'test/legacy-name.test.ts']);
    expect(findLeaks(['test/legacy-name.test.ts', 'test/new.browser.test.ts'], ci)).toEqual([
      'test/legacy-name.test.ts',
    ]);
    expect(findLeaks(['test/new.browser.test.ts'], ci)).toEqual([]);
  });

  it('flags a non-empty listing whose paths never match the tree instead of passing vacuously', () => {
    const tree = ['test/legacy-name.test.ts', 'test/unit.test.ts'];
    // e.g. a vitest upgrade that starts printing absolute paths: nothing leaks, but only
    // because nothing matches, so the checker must refuse rather than report success.
    const drifted = parseVitestFileList('/repo/test/legacy-name.test.ts\n/repo/test/unit.test.ts\n');
    expect(drifted.size).toBe(2);
    expect(findLeaks(['test/legacy-name.test.ts'], drifted)).toEqual([]);
    expect(listingMatchesTree(drifted, tree)).toBe(false);

    const healthy = parseVitestFileList('test/legacy-name.test.ts\ntest/unit.test.ts\n');
    expect(listingMatchesTree(healthy, tree)).toBe(true);
  });
});

describe('against this repository', () => {
  it('detects every file already listed in BROWSER_TEST_GLOBS', () => {
    // If detection stopped recognising a known browser test, the checker would go blind to
    // exactly the class of file it exists for.
    const detected = new Set(findBrowserTests(repoRoot));
    const literals = BROWSER_TEST_GLOBS.filter((g) => !/[*?[{]/.test(g));
    expect(literals.length).toBeGreaterThan(0);
    for (const file of literals) expect(detected, file).toContain(file);
  });
});
