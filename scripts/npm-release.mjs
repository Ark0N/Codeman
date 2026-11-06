#!/usr/bin/env node
/**
 * @fileoverview `npm run release`: `changeset publish` with `README.zh-CN.md` moved aside.
 *
 * npmjs.com renders the package's top-level `readme`, and npm picks it at publish time:
 * @npmcli/package-json's normalize globs `{README,README.*}` in the package root UNSORTED and
 * keeps the first `.md` it sees. With `README.zh-CN.md` next to `README.md` that was the
 * Chinese one on this machine and on CI, so npmjs.com showed the Chinese README for months.
 * `files` cannot help: npm-packlist always includes every root `README.*`.
 *
 * Renaming the file would break every link to it, so for the length of the publish only it
 * moves to a name npm does not treat as a readme (a leading dot), and is put back afterwards,
 * whatever the publish did. The move happens HERE, inside the publish command, never as a
 * step before `changesets/action` in release.yml: that action also runs the version path and
 * commits the working tree into its version PR, which would commit the deletion.
 *
 * A previous run killed between the move and the restore leaves the aside copy behind; the
 * next run puts it back first. `xterm-zerolag-input` (packages/) has only a README.md.
 *
 *   node scripts/npm-release.mjs    what the Release workflow runs (via `npm run release`)
 */
import { existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HIDDEN_README = 'README.zh-CN.md';
export const ASIDE_NAME = '.README.zh-CN.md.release-aside';

/**
 * Runs `publish` with `HIDDEN_README` moved aside in `root`, restoring it afterwards, also
 * when `publish` fails or throws. Returns the exit code `publish` returned.
 *
 * @param {{ root: string, publish: () => number, log?: (msg: string) => void }} opts
 * @returns {number}
 */
export function publishWithReadmeAside({ root, publish, log = (msg) => console.log(msg) }) {
  const original = join(root, HIDDEN_README);
  const aside = join(root, ASIDE_NAME);
  if (existsSync(aside) && !existsSync(original)) {
    renameSync(aside, original);
    log(`npm-release: restored ${HIDDEN_README} left aside by an earlier run`);
  }
  const moved = existsSync(original);
  if (moved) {
    renameSync(original, aside);
    log(`npm-release: ${HIDDEN_README} moved aside so npm picks README.md as the readme`);
  }
  try {
    return publish();
  } finally {
    if (moved) {
      renameSync(aside, original);
      log(`npm-release: ${HIDDEN_README} restored`);
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
