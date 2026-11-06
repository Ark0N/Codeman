/**
 * @fileoverview XLSX preview asset delivery contracts.
 *
 * The parser bundles (exceljs ~950 KB, fflate ~33 KB) must never cost a page
 * load: the page loads only spreadsheet-preview.js, and the vendor files are
 * pulled by the worker when a spreadsheet is actually opened. These checks pin
 * that shape plus the pinned versions and the dev/prod vendoring steps.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_ATTACHMENT_EXTENSIONS, isSupportedAttachmentExtension } from '../src/attachment-registry.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('spreadsheet preview assets', () => {
  it('pins the browser parser packages exactly, as build-time (dev) dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.exceljs).toBe('4.4.0');
    expect(pkg.devDependencies?.fflate).toBe('0.8.3');
    // They are vendored into dist/ at build time; a runtime install never needs them.
    expect(pkg.dependencies?.exceljs).toBeUndefined();
    expect(pkg.dependencies?.fflate).toBeUndefined();
  });

  it('prepares the vendor bundles for development and production', () => {
    const postinstall = read('scripts/postinstall.js');
    const build = read('scripts/build.mjs');
    const prepare = read('scripts/prepare-spreadsheet-assets.mjs');

    expect(postinstall).toContain('prepare-spreadsheet-assets.mjs');
    expect(build).toContain('node scripts/prepare-spreadsheet-assets.mjs dist/web/public/vendor');
    expect(prepare).toContain('exceljs.min.js');
    expect(prepare).toContain('fflate.min.js');
    expect(prepare).toContain('sourceMappingURL');
    // Output lands in a gitignored dir, so the ~1 MB never gets committed.
    expect(read('.gitignore')).toMatch(/^src\/web\/public\/vendor\/$/m);
  });

  it('loads only the small renderer on the page; the worker pulls the parser on demand', () => {
    const html = read('src/web/public/index.html');
    expect(html).toContain('<script defer src="spreadsheet-preview.js"></script>');
    for (const lazy of ['spreadsheet-preview-worker.js', 'spreadsheet-xlsx-core.js', 'exceljs', 'fflate']) {
      expect(html, lazy).not.toContain(lazy);
    }
    const sw = read('src/web/public/sw.js');
    expect(sw).not.toContain('exceljs');

    const worker = read('src/web/public/spreadsheet-preview-worker.js');
    // ExcelJS loads only after admission, inside loadWorkbook().
    const admit = worker.indexOf('core.admitXlsx(');
    const excel = worker.indexOf('vendor/exceljs.min.js');
    expect(admit).toBeGreaterThan(-1);
    expect(excel).toBeGreaterThan(admit);

    const build = read('scripts/build.mjs');
    expect(build).toContain("'spreadsheet-preview.js',");
    // The worker is a stable URL busted by SPREADSHEET_ASSET_VERSION, not a hashed name.
    expect(build).not.toContain("'spreadsheet-preview-worker.js'");
  });

  it('routes an agent-printed .xlsx path to the preview overlay, but not .xls/.ods', () => {
    const constants = read('src/web/public/constants.js');
    const previewList = /FILE_PREVIEW_EXTENSIONS = new Set\(\s*\('([^']+)'\)/.exec(constants)?.[1].split(' ') ?? [];
    expect(previewList).toContain('xlsx');
    expect(previewList).not.toContain('xls');
    expect(previewList).not.toContain('ods');
    expect(constants).toMatch(/\|pptx\|xlsx\|/);
  });

  it('checks the combined size budget and the content-derived asset version', () => {
    const check = read('scripts/check-public-assets.mjs');
    expect(check).toContain('SPREADSHEET_VENDOR_MAX_BYTES = 1_100_000');
    expect(check).toContain('SPREADSHEET_ASSET_VERSION');
    expect(check).toContain('spreadsheet-preview-worker.js');
    expect(check).toContain('spreadsheet-xlsx-core.js');
    expect(check).toContain("createHash('sha256')");
    expect(read('src/web/public/spreadsheet-preview.js')).toMatch(/const SPREADSHEET_ASSET_VERSION = '[a-f0-9]{12}'/);
  });

  it('names every accepted document type in the attachments panel help', () => {
    expect(DOCUMENT_ATTACHMENT_EXTENSIONS).toContain('xlsx');
    const help = /<div>Supports ([^<]+)<\/div>/.exec(read('src/web/public/panels-ui.js'))?.[1] || '';
    for (const extension of DOCUMENT_ATTACHMENT_EXTENSIONS) {
      expect(isSupportedAttachmentExtension(extension)).toBe(true);
      expect(help).toContain(`.${extension}`);
    }
    // The CLI's refusal text is built from the same list rather than restating it.
    expect(read('src/cli.ts')).toContain("DOCUMENT_ATTACHMENT_EXTENSIONS.join(', ')");
  });
});

/**
 * The build deletes dist/web/public and only then copies the vendor bundles out of
 * node_modules. A tree whose node_modules predate exceljs/fflate (a deploy that pulled
 * but never ran `npm install`) failed there, with the live assets already gone. The
 * preflight at the top of build.mjs resolves them before anything is touched.
 */
describe('build preflight for the spreadsheet vendor packages', () => {
  const preflightModules = (build: string): string[] => {
    const list = /const BUILD_TIME_MODULES = \[([^\]]*)\]/.exec(build)?.[1] ?? '';
    return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  it('covers every package prepare-spreadsheet-assets.mjs resolves, and runs before tsc and the clean', () => {
    const build = read('scripts/build.mjs');
    const preflight = preflightModules(build);
    const resolvedByPrepare = [
      ...read('scripts/prepare-spreadsheet-assets.mjs').matchAll(/require\.resolve\('([^']+)'\)/g),
    ].map((m) => m[1]);
    // Parse sanity; the loop below is the actual coverage check.
    expect(resolvedByPrepare).toContain('exceljs/dist/exceljs.min.js');
    expect(resolvedByPrepare).toContain('fflate');
    for (const specifier of resolvedByPrepare) expect(preflight, specifier).toContain(specifier);

    const bail = build.indexOf('[build] run `npm install` first');
    expect(bail).toBeGreaterThan(-1);
    expect(bail).toBeLessThan(build.indexOf("run('tsc', 'tsc')"));
    expect(bail).toBeLessThan(build.indexOf("'rm -rf dist/web/public'"));
  });

  it('resolves every preflight package in this installed tree', () => {
    const requireFromBuild = createRequire(resolve(root, 'scripts/build.mjs'));
    const preflight = preflightModules(read('scripts/build.mjs'));
    expect(preflight.length).toBeGreaterThan(0);
    for (const specifier of preflight) expect(() => requireFromBuild.resolve(specifier), specifier).not.toThrow();
  });

  it('exits with an npm install hint, and touches nothing, where the packages do not resolve', () => {
    // A copy of build.mjs outside the repo: nothing resolves from there, and its ROOT
    // (derived from its own location) is the temp dir, so a missing preflight could
    // only ever act on that throwaway tree.
    const tree = mkdtempSync(join(tmpdir(), 'codeman-build-preflight-'));
    try {
      mkdirSync(join(tree, 'scripts'));
      const copy = join(tree, 'scripts', 'build.mjs');
      copyFileSync(resolve(root, 'scripts/build.mjs'), copy);
      const requireFromCopy = createRequire(copy);
      const unresolvable = ['exceljs/dist/exceljs.min.js', 'fflate'].filter((specifier) => {
        try {
          requireFromCopy.resolve(specifier);
          return false;
        } catch {
          return true;
        }
      });
      // Precondition: this host has no stray node_modules above the temp dir.
      expect(unresolvable.length).toBeGreaterThan(0);

      const result = spawnSync(process.execPath, [copy], { cwd: tree, encoding: 'utf8', timeout: 20_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`[build] missing build dependency: ${unresolvable.join(', ')}`);
      expect(result.stderr).toContain('run `npm install` first');
      expect(result.stdout).not.toContain('[build] tsc');
      expect(existsSync(join(tree, 'dist'))).toBe(false);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
