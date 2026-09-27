#!/usr/bin/env node
/**
 * Copy the XLSX preview's browser bundles (exceljs, fflate) into a public vendor
 * dir. Run by postinstall for dev (src/web/public/vendor, gitignored) and by
 * build.mjs for prod (dist/web/public/vendor). Both packages are pinned exactly
 * in package.json, and check-public-assets.mjs hashes the output into
 * SPREADSHEET_ASSET_VERSION (the worker's cache-bust token), so a version bump
 * that changes the bytes fails that check until the token is refreshed.
 * Source-map comments are stripped: the maps are not shipped.
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const outputDir = resolve(process.argv[2] || join(import.meta.dirname, '..', 'src', 'web', 'public', 'vendor'));
const excelSource = require.resolve('exceljs/dist/exceljs.min.js');
const fflateSource = join(dirname(require.resolve('fflate')), '..', 'umd', 'index.js');

function copyBrowserBundle(source, outputName) {
  const content = readFileSync(source, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*(?:\n|$)/g, '\n');
  if (/sourceMappingURL/.test(content)) {
    throw new Error(`Failed to strip sourceMappingURL from ${outputName}`);
  }
  writeFileSync(join(outputDir, outputName), content, 'utf8');
}

mkdirSync(outputDir, { recursive: true });
copyBrowserBundle(excelSource, 'exceljs.min.js');
copyBrowserBundle(fflateSource, 'fflate.min.js');
