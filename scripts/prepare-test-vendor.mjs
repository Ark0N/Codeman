#!/usr/bin/env node
/**
 * Populate `src/web/public/vendor/` with the browser bundles the mobile tests need.
 *
 * The mobile suite (test/mobile/**) drives a real browser against a WebServer
 * started from TypeScript source, so fastify-static serves
 * `join(__dirname, 'public')` = `src/web/public`, NOT `dist/web/public`, where
 * `npm run build` puts the vendor bundles. Without them every `/vendor/xterm*`
 * request 404s, so `Terminal` is never defined, `initTerminal()` never runs, and
 * every test touching `app.terminal` dies with `Cannot read properties of null`.
 *
 * That stayed invisible because config/vitest.ci.config.ts excludes
 * `test/mobile/**`, so CI never ran the suite.
 *
 * ⚠️ scripts/postinstall.js:238-303 already writes these same 7 outputs (same
 * names, same alias tail), so a plain `npm install` leaves the suite working. What
 * this script adds is FRESHNESS and independence from install time: a checkout
 * installed with `--ignore-scripts`, or one borrowing another tree's
 * `node_modules`, never ran postinstall, and an edit to the zerolag package after
 * install leaves the bundle stale. It runs as `pretest:mobile` and `pretest:browser`.
 *
 * Mirrors the vendor steps in scripts/build.mjs, targeting the source tree. Same
 * inputs and output names, so the page markup needs no test-only branch. That
 * makes THREE hand-synced copies of this asset table (here, build.mjs:45-51,
 * postinstall.js:255-303); keep them in step or a missing entry becomes a 404 that
 * silently disables the terminal.
 * `src/web/public/vendor/` is gitignored, so these stay build artifacts.
 *
 * Idempotent: skips outputs that are complete and newer than every input they
 * derive from.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'web', 'public', 'vendor');
const NM = join(ROOT, 'node_modules');

/**
 * Every `vendor/` asset index.html requests, minus the two already committed
 * (dompurify, marked). Kept in sync with scripts/build.mjs steps 3-4 — a missing
 * entry here is a 404 that silently disables the terminal in tests.
 *
 * mode: 'copy' | 'minify' | 'bundle'
 */
const ASSETS = [
  { src: join(NM, '@xterm/xterm/css/xterm.css'), out: 'xterm.css', mode: 'copy' },
  { src: join(NM, '@xterm/xterm/lib/xterm.js'), out: 'xterm.min.js', mode: 'minify' },
  { src: join(NM, '@xterm/addon-fit/lib/addon-fit.js'), out: 'xterm-addon-fit.min.js', mode: 'minify' },
  {
    src: join(NM, '@xterm/addon-serialize/lib/addon-serialize.js'),
    out: 'xterm-addon-serialize.min.js',
    mode: 'minify',
  },
  { src: join(NM, '@xterm/addon-search/lib/addon-search.js'), out: 'xterm-addon-search.min.js', mode: 'minify' },
  {
    src: join(NM, '@xterm/addon-unicode11/lib/addon-unicode11.js'),
    out: 'xterm-addon-unicode11.min.js',
    mode: 'minify',
  },
  { src: join(NM, '@xterm/addon-webgl/lib/addon-webgl.js'), out: 'xterm-addon-webgl.min.js', mode: 'copy' },
  {
    src: join(ROOT, 'packages/xterm-zerolag-input/src/zerolag-input-addon.ts'),
    out: 'xterm-zerolag-input.js',
    mode: 'bundle',
    globalName: 'XtermZerolagInput',
    // The alias tail appended below. Its absence means the output is a partial
    // write from an older version of this script, whatever its mtime says.
    mustContain: 'window.LocalEchoOverlay',
  },
];

/**
 * Every input an asset is derived from. For the bundle that is the whole package
 * source dir, not just the entry: esbuild pulls in the entry's siblings, so
 * comparing against the entry alone reports "up to date" after an edit to
 * overlay-renderer.ts and the suite then tests a stale overlay. Editing those
 * siblings is exactly the single-source workflow CLAUDE.md mandates.
 */
function sourcesOf(asset) {
  if (asset.mode !== 'bundle') return [asset.src];
  const dir = dirname(asset.src);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(dir, f));
  } catch {
    return [asset.src];
  }
}

/**
 * A truncated output is the other half of the poisoned-cache problem, and the one
 * `mustContain` cannot cover on its own: an interrupted write leaves a SHORT file
 * carrying a current mtime, which the cache then trusts forever. This script
 * publishes atomically so it can no longer create one, but postinstall.js:266-303
 * still writes this same directory in place, so a Ctrl+C during `npm install`
 * produces exactly that, and a 200-byte xterm.min.js means `Terminal` is undefined
 * and every test dies on a null `app.terminal`.
 *
 * A copy must match its source byte for byte. A derived output is held to a floor
 * far below the real ratios (0.97-1.00 for the minified assets, 0.51 for the
 * bundle), so a dependency upgrade cannot trip it while a truncation misses by
 * orders of magnitude.
 */
const MIN_DERIVED_RATIO = 0.1;

function isCompleteSize(asset, dest) {
  const srcBytes = statSync(asset.src).size;
  const destBytes = statSync(dest).size;
  if (asset.mode === 'copy') return destBytes === srcBytes;
  return destBytes >= srcBytes * MIN_DERIVED_RATIO;
}

function isFresh(asset, dest) {
  if (!existsSync(dest)) return false;
  try {
    // Size and content checks before the mtime check, because mtime cannot see a
    // WRONG file.
    if (!isCompleteSize(asset, dest)) return false;
    // The atomic rename below stops this script from ever publishing a half-written
    // bundle, but it cannot repair one already on disk: anyone who ran an earlier
    // version that appended the aliases in place has a complete-looking file with a
    // current mtime and no alias tail, and a pure mtime cache calls that "up to
    // date" forever while the suite dies on `LocalEchoOverlay is not defined`.
    if (asset.mustContain && !readFileSync(dest, 'utf-8').includes(asset.mustContain)) return false;
    const destMs = statSync(dest).mtimeMs;
    return sourcesOf(asset).every((src) => destMs >= statSync(src).mtimeMs);
  } catch {
    // an unreadable or vanished input: rebuild rather than trust the cache
    return false;
  }
}

mkdirSync(OUT, { recursive: true });

// A run killed between its build and its rename leaks a temp, and the per-pid
// names above mean nothing reclaims it later. Sweep the ones whose owning process
// is gone, and ONLY those: deleting a live run's temp is the collision the per-pid
// name exists to prevent. `kill(pid, 0)` throws ESRCH only when no such process
// exists (EPERM means it does, owned by someone else, so leave it alone).
for (const name of readdirSync(OUT)) {
  const owner = /\.(\d+)\.tmp$/.exec(name);
  const pid = owner ? Number(owner[1]) : 0;
  // 0 is never a real owner: to kill(2) it means "this process group".
  if (!pid) continue;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // ESRCH alone means the owner is gone. Anything else (EPERM = alive under
    // another user, a pid too large to be valid) leaves the file where it is.
    if (err.code !== 'ESRCH') continue;
    try {
      rmSync(join(OUT, name), { force: true });
    } catch {
      // Reclaiming litter must never fail the run: a leftover temp is inert
      // (gitignored, referenced by nothing), a crashed prepare step is not.
    }
  }
}

let built = 0;
let skipped = 0;
for (const asset of ASSETS) {
  const dest = join(OUT, asset.out);
  if (!existsSync(asset.src)) {
    console.error(`[test-vendor] missing input: ${asset.src}\n  run \`npm install\` first`);
    process.exit(1);
  }
  if (isFresh(asset, dest)) {
    skipped += 1;
    continue;
  }
  // Build into a temp path and rename into place at the very end. The zerolag
  // bundle is finished by a SECOND step (the alias append below), so writing
  // `dest` directly leaves a window where a complete-looking file with a current
  // mtime is missing its tail: `isFresh` then reports "up to date" forever and the
  // suite dies on `LocalEchoOverlay is not defined`, which is the exact failure
  // this script exists to prevent. An interrupted esbuild or copy poisons the
  // cache the same way. rename(2) is atomic within a directory, so a reader sees
  // either the old file or the finished new one, never a half-written one.
  // The name carries our pid: the path must be private to this run. Two runs
  // sharing one temp path fight over it, and losing that fight is not just a
  // crash — a sibling's `rmSync` landing between the esbuild and the append below
  // makes appendFileSync CREATE the file, so the rename publishes a bundle-less
  // file consisting only of the alias tail. That file still contains
  // `mustContain`, so the cache would bless it forever.
  const tmp = `${dest}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  // cwd: ROOT so `npx` resolves the repo's pinned esbuild. Without it a run from
  // another directory misses the local install and fetches an unpinned one.
  const run = (args) => execFileSync('npx', args, { stdio: 'inherit', cwd: ROOT });
  try {
    if (asset.mode === 'copy') {
      copyFileSync(asset.src, tmp);
    } else if (asset.mode === 'minify') {
      run(['esbuild', asset.src, '--minify', `--outfile=${tmp}`]);
    } else {
      run([
        'esbuild',
        asset.src,
        '--bundle',
        '--minify',
        '--format=iife',
        `--global-name=${asset.globalName}`,
        `--outfile=${tmp}`,
      ]);
    }

    // The zerolag bundle exports only `XtermZerolagInput`. app.js constructs
    // `new LocalEchoOverlay(terminal)` directly, so scripts/build.mjs appends
    // global aliases after esbuild — without them initTerminal() throws
    // `LocalEchoOverlay is not defined` at the point it builds the overlay, and
    // every later step (including the mobile touch handlers) silently never runs.
    if (asset.out === 'xterm-zerolag-input.js') {
      appendFileSync(
        tmp,
        '\n// Global aliases for browser usage\n' +
          'if(typeof window!=="undefined"){' +
          'window.ZerolagInputAddon=XtermZerolagInput.ZerolagInputAddon;' +
          'window.LocalEchoOverlay=class extends XtermZerolagInput.ZerolagInputAddon{' +
          'constructor(terminal){' +
          'super({prompt:{type:"character",char:"\\u276f",offset:2}});' +
          'this.activate(terminal);' +
          '}' +
          '};' +
          '}\n'
      );
    }

    // Only now is the output complete, so publish it. The append and the rename
    // are inside this try as well: a failure there has to clean the temp up and
    // report like any other, not leak it behind a raw stack trace.
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    console.error(`[test-vendor] failed to produce ${asset.out} from ${asset.src}\n  ${err.message}`);
    process.exit(1);
  }
  built += 1;
}

console.log(`[test-vendor] ${built} built, ${skipped} up to date -> src/web/public/vendor/`);
