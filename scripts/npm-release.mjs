#!/usr/bin/env node
/**
 * @fileoverview `npm run release`: `changeset publish` with the translated READMEs moved aside.
 *
 * npmjs.com renders the package's top-level `readme`, and npm picks it at publish time:
 * @npmcli/package-json's normalize globs `{README,README.*}` in the package root UNSORTED and
 * keeps the first `.md` it sees. With `README.zh-CN.md` next to `README.md` that was the
 * Chinese one on this machine and on CI, so npmjs.com showed the Chinese README for months.
 * Every translated root README (`README.zh-CN.md`, `README.ja.md`) is moved aside the same way.
 * `files` cannot help: npm-packlist always includes every root `README.*`.
 *
 * Renaming the files would break every link to them, so for the length of the publish only each
 * moves to a name npm does not treat as a readme (a leading dot), and is put back afterwards,
 * whatever the publish did. The move happens HERE, inside the publish command, never as a
 * step before `changesets/action` in release.yml: that action also runs the version path and
 * commits the working tree into its version PR, which would commit the deletion.
 *
 * A previous run killed between the move and the restore leaves an aside copy behind; the
 * next run puts it back first. `xterm-zerolag-input` (packages/) has only a README.md.
 *
 *   node scripts/npm-release.mjs    what the Release workflow runs (via `npm run release`)
 */
import { existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HIDDEN_READMES = ['README.zh-CN.md', 'README.ja.md'];
/** @param {string} name */
export const asideName = (name) => `.${name}.release-aside`;
export const HIDDEN_README = HIDDEN_READMES[0];
export const ASIDE_NAME = asideName(HIDDEN_README);

/**
 * Runs `publish` with every `HIDDEN_READMES` file moved aside in `root`, restoring them
 * afterwards, also when `publish` fails or throws. Returns the exit code `publish` returned.
 *
 * @param {{ root: string, publish: () => number, log?: (msg: string) => void }} opts
 * @returns {number}
 */
export function publishWithReadmeAside({ root, publish, log = (msg) => console.log(msg) }) {
  const moved = [];
  try {
    for (const name of HIDDEN_READMES) {
      const original = join(root, name);
      const aside = join(root, asideName(name));
      if (existsSync(aside) && !existsSync(original)) {
        renameSync(aside, original);
        log(`npm-release: restored ${name} left aside by an earlier run`);
      }
      if (existsSync(original)) {
        renameSync(original, aside);
        moved.push(name);
        log(`npm-release: ${name} moved aside so npm picks README.md as the readme`);
      }
    }
    return publish();
  } finally {
    for (const name of moved) {
      renameSync(join(root, asideName(name)), join(root, name));
      log(`npm-release: ${name} restored`);
    }
  }
}

function runChangesetPublish() {
  const result = spawnSync('changeset', ['publish'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(`npm-release: could not run changeset publish: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  process.exitCode = publishWithReadmeAside({ root, publish: runChangesetPublish });
}
