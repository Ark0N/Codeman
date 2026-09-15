// Port: none (static source contract — no browser, no server).
//
// The service worker's precache list used to be maintained by hand with the
// PRE-hash filenames, while scripts/build.mjs renamed those same files to
// content-hashed names and rewrote only index.html. So in production every
// precache entry pointed at a file that no longer existed, and
// `cache.add(url).catch(() => {})` in the install handler swallowed all of it.
// Measured against a running instance: 15 of 23 entries 404'd.
//
// Nothing caught it because nothing could: the two lists lived in different
// files, in different languages, with no shared symbol. The fix is to derive
// the list from the build's own manifest — and this test pins the contract that
// makes that derivation possible, because the failure mode is silent in both
// directions. A renamed anchor in sw.js means the build throws (loud, fine). A
// build that stops rewriting means the worker precaches nothing while still
// looking correct (silent, not fine).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const sw = readFileSync(resolve(root, 'src/web/public/sw.js'), 'utf8');
const build = readFileSync(resolve(root, 'scripts/build.mjs'), 'utf8');

// The exact declarations scripts/build.mjs rewrites. They must appear EXACTLY
// once: the build asserts the same thing and throws otherwise, so a second
// occurrence (in a comment, say) fails the build rather than shipping stale.
const BUILD_ID_ANCHOR = "const BUILD_ID = 'dev';";
const HASHED_ASSETS_ANCHOR = 'const HASHED_ASSETS = [];';

describe('service worker precache contract', () => {
  it('sw.js carries exactly one of each anchor the build rewrites', () => {
    expect(sw.split(BUILD_ID_ANCHOR).length - 1).toBe(1);
    expect(sw.split(HASHED_ASSETS_ANCHOR).length - 1).toBe(1);
  });

  it('build.mjs rewrites those exact anchors', () => {
    expect(build).toContain(BUILD_ID_ANCHOR);
    expect(build).toContain(HASHED_ASSETS_ANCHOR);
  });

  // The cache key must vary per build, or `activate`'s cleanup — which deletes
  // every cache whose key is not the current one — never deletes anything, and
  // hashed assets from every past release accumulate until the origin hits its
  // storage quota. That is what the old constant 'codeman-v1' did.
  it('derives the cache name from the build id rather than a constant', () => {
    expect(sw).toContain('const CACHE_NAME = `codeman-${BUILD_ID}`;');
    expect(sw).not.toMatch(/const CACHE_NAME = ['"]codeman-v\d+['"]/);
  });

  // The whole point of the rewrite: the shell is derived, not hand-listed.
  it('builds the app shell from the hashed manifest', () => {
    expect(sw).toContain("...HASHED_ASSETS.map((p) => '/' + p)");
  });

  // The regression itself. These are the pre-hash names the build renames, so
  // any of them appearing in the shell list means someone hand-added an entry
  // that will 404 in production.
  it('never hand-lists a filename the build content-hashes', () => {
    const shell = sw.slice(sw.indexOf('const APP_SHELL'), sw.indexOf('].map(B);'));
    const hashedByBuild = [
      'app.js',
      'constants.js',
      'terminal-ui.js',
      'session-ui.js',
      'settings-ui.js',
      'panels-ui.js',
      'styles.css',
      'mobile.css',
      'i18n.js',
      'mobile-handlers.js',
      'keyboard-accessory.js',
      'notification-manager.js',
      'voice-input.js',
      'api-client.js',
      'vendor/xterm-zerolag-input.js',
      'vendor/xterm-predictive-echo.js',
    ];
    for (const name of hashedByBuild) {
      expect(shell, `APP_SHELL must not hand-list ${name} — the build renames it`).not.toContain(`'/${name}'`);
    }
  });

  // Dev serves sw.js unrewritten, so the literals must be valid on their own:
  // an empty precache plus the unhashed modules cached on first use.
  it('is valid unrewritten, for dev', () => {
    expect(() => new Function(sw.replace(/self\./g, 'globalThis.'))).not.toThrow();
  });
});
