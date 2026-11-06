#!/usr/bin/env node
// Writes src/web/public/whats-new.json for the version in package.json from CHANGELOG.md.
// Runs as part of `npm run version-packages`, so every release carries its own notes and the
// UI can announce them once per version without anyone remembering to.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWhatsNew } from './lib/whats-new.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const notes = buildWhatsNew(changelog, version);
if (notes.highlights.length === 0) {
  console.warn(`whats-new: no bold highlights found for ${version}; the in-app announcement will be skipped`);
}
writeFileSync(resolve(root, 'src/web/public/whats-new.json'), JSON.stringify(notes, null, 2) + '\n');
console.log(`whats-new: ${version} -> ${notes.highlights.length} highlight(s)`);
