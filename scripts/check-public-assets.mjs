#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(repoRoot, 'src/web/public');
const prettierBin = resolve(repoRoot, 'node_modules/.bin/prettier');
const checkedExtensions = new Set(['.js', '.css', '.html', '.json']);
// Combined budget for the two XLSX-preview vendor bundles (exceljs + fflate).
// They load only inside the spreadsheet worker, but a dependency bump that
// balloons them should be a deliberate decision, not a silent one.
const SPREADSHEET_VENDOR_MAX_BYTES = 1_100_000;

function collectTextAssets(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTextAssets(fullPath));
      continue;
    }
    if (checkedExtensions.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function findNullByte(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) return i;
  }
  return -1;
}

const files = collectTextAssets(publicRoot);
const failures = [];

// The spreadsheet worker is a stable (unhashed) URL, cache-busted by the
// SPREADSHEET_ASSET_VERSION token in spreadsheet-preview.js. That token must be
// the content hash of everything the worker loads, or a deploy can pair a new
// worker with a stale cached core/vendor file (static assets are cached 1y).
const spreadsheetWorker = join(publicRoot, 'spreadsheet-preview-worker.js');
const spreadsheetCore = join(publicRoot, 'spreadsheet-xlsx-core.js');
const spreadsheetEntry = join(publicRoot, 'spreadsheet-preview.js');
const spreadsheetVendors = [join(publicRoot, 'vendor', 'exceljs.min.js'), join(publicRoot, 'vendor', 'fflate.min.js')];

if ([spreadsheetWorker, spreadsheetCore, spreadsheetEntry, ...spreadsheetVendors].every(existsSync)) {
  const vendorBytes = spreadsheetVendors.reduce((total, file) => total + readFileSync(file).length, 0);
  if (vendorBytes > SPREADSHEET_VENDOR_MAX_BYTES) {
    failures.push(`Spreadsheet vendor bundles exceed ${SPREADSHEET_VENDOR_MAX_BYTES} bytes (${vendorBytes} bytes)`);
  }

  const expectedVersion = createHash('sha256')
    .update(readFileSync(spreadsheetWorker))
    .update(readFileSync(spreadsheetCore))
    .update(readFileSync(spreadsheetVendors[0]))
    .update(readFileSync(spreadsheetVendors[1]))
    .digest('hex')
    .slice(0, 12);
  const entrySource = readFileSync(spreadsheetEntry, 'utf8');
  const actualVersion = entrySource.match(/const SPREADSHEET_ASSET_VERSION = '([a-f0-9]+)'/)?.[1];
  if (actualVersion !== expectedVersion) {
    failures.push(
      `SPREADSHEET_ASSET_VERSION mismatch: expected ${expectedVersion}, found ${actualVersion || 'missing'}`
    );
  }
} else {
  failures.push('Spreadsheet preview assets are missing; run `node scripts/prepare-spreadsheet-assets.mjs`');
}

for (const file of files) {
  const rel = relative(repoRoot, file);
  const data = readFileSync(file);
  const nullByteIndex = findNullByte(data);
  if (nullByteIndex !== -1) {
    failures.push(`${rel}: contains literal NUL byte at offset ${nullByteIndex}`);
  }

  if (extname(file) === '.js') {
    try {
      execFileSync(process.execPath, ['--check', file], { cwd: repoRoot, stdio: 'pipe' });
    } catch (err) {
      failures.push(`${rel}: JavaScript syntax check failed\n${String(err.stderr || err.message).trim()}`);
    }
  }
}

try {
  execFileSync(prettierBin, ['--check', ...files], { cwd: repoRoot, stdio: 'pipe' });
} catch (err) {
  failures.push(`Prettier public asset check failed\n${String(err.stdout || err.stderr || err.message).trim()}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log(`Public asset checks passed (${files.length} files).`);
