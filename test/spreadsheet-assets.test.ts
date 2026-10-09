/**
 * @fileoverview XLSX preview asset delivery contracts.
 *
 * The parser bundles (exceljs ~950 KB, fflate ~33 KB) must never cost a page
 * load: the page loads only spreadsheet-preview.js, and the vendor files are
 * pulled by the worker when a spreadsheet is actually opened. These checks pin
 * that shape plus the pinned versions and the dev/prod vendoring steps.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
