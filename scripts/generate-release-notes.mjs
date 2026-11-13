#!/usr/bin/env node
// Prints the GitHub release notes for one version, built from its section of CHANGELOG.md.
// The Release workflow sends this to the release it just published. Run it by hand to preview:
//
//   node scripts/generate-release-notes.mjs [version]    default: the version in package.json
//
// Exits 1 with nothing on stdout when the changelog has no section for that version, so the
// workflow keeps the text changesets wrote rather than blanking a published release.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseNotes } from './lib/release-notes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] ?? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const notes = buildReleaseNotes(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'), version);
if (!notes) {
  console.error(`release-notes: CHANGELOG.md has no notes for ${version}`);
  process.exit(1);
}
process.stdout.write(notes);
