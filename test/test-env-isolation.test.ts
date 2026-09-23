/**
 * @fileoverview Pins the environment isolation `test/setup.ts` provides.
 *
 * The suite's hermeticity rests on a temp `HOME` plus a short list of env vars that are
 * deleted before any application module loads. That list is easy to under-maintain: it grew
 * once for auth (`CODEMAN_PASSWORD`/`CODEMAN_USERNAME`) and once for `CODEMAN_GESTURE`, both
 * times only after a leak had already produced a confusing failure, and it was still missing
 * the three INSTANCE-selection vars.
 *
 * Those three matter more than the ones already on the list, because `src/config/instance.ts`
 * derives BOTH the data dir and the tmux socket from them, and `CODEMAN_DATA_DIR` is an
 * absolute path that bypasses `HOME` entirely — so a developer who exports it has the suite
 * reading and writing their real `state.json` rather than a throwaway tree.
 *
 * ⚠️ The runtime half of this file cannot fail on a machine where the vars were never set, so
 * it is not enough on its own: a `delete` line removed from `setup.ts` would still pass here
 * on almost every developer's box and on CI. The STATIC half is what actually guards the
 * list — it reads `setup.ts` and asserts each name is deleted there, which fails wherever the
 * suite runs. Both halves are deliberate; do not drop the static one as redundant.
 *
 * Port: none (pure, over process.env and one source file).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every env var `setup.ts` must strip, with why it would otherwise leak. */
const STRIPPED_ENV_VARS: Array<[name: string, why: string]> = [
  ['CODEMAN_PASSWORD', 'auth from a running instance would make protected routes behave differently'],
  ['CODEMAN_USERNAME', 'same, and it changes which owner scoping resolves to'],
  ['CODEMAN_GESTURE', 'flips renderIndexHtml output and breaks byte-identity assertions'],
  ['CODEMAN_BASE_URL', 'mounts the server under a sub-path and breaks the root-install byte-identity assertions'],
  ['CODEMAN_INSTANCE', 'moves the data dir to ~/.codeman-<name> and the tmux socket to codeman-<name>'],
  ['CODEMAN_DATA_DIR', 'ABSOLUTE override: bypasses the temp HOME and points the suite at a real data dir'],
  ['CODEMAN_TMUX_SOCKET', 'renames the socket resolveTmuxSocketName() returns'],
  ['CODEMAN_CASES_PATH', 'bypasses the temporary HOME and points case routes at a deployment bind mount'],
  ['CLAUDE_CONFIG_DIR', 'relocates the Claude tree, so transcript fixtures under the temp HOME read as missing'],
];

const SETUP_SOURCE = readFileSync(fileURLToPath(new URL('./setup.ts', import.meta.url)), 'utf-8');

/**
 * Just the top-of-file STRIP section, cut at the first hook.
 *
 * The teardown below it restores HOME/USERPROFILE/VITEST/PLAYWRIGHT_BROWSERS_PATH with the
 * same `delete` syntax, and those are the opposite of a strip — counting them would make the
 * anti-drift check demand a reason for a var the suite deliberately puts back.
 */
const SETUP_STRIP_SECTION = SETUP_SOURCE.split(/^afterEach\(/m)[0];

describe('test environment isolation', () => {
  it('removes every inherited CODEMAN_* environment variable', () => {
    expect(Object.keys(process.env).filter((key) => key.startsWith('CODEMAN_'))).toEqual([]);
  });

  it.each(STRIPPED_ENV_VARS)('%s is unset while the suite runs', (name) => {
    expect(process.env[name], `${name} leaked into the test environment`).toBeUndefined();
  });

  it.each(STRIPPED_ENV_VARS)('setup.ts deletes %s (%s)', (name) => {
    // The half that fails everywhere, not just on a machine that happens to export the var.
    expect(SETUP_SOURCE, `setup.ts no longer deletes ${name}`).toContain(`delete process.env.${name};`);
  });

  it('runs against a throwaway HOME, not the real one', () => {
    // The property every other test's isolation is built on: `~/.codeman` and `~/codeman-cases`
    // both resolve under here, so a test that writes state cannot reach the developer's own.
    const home = process.env.HOME ?? process.env.USERPROFILE;
    expect(home).toBeTruthy();
    expect(home).toContain('codeman-vitest-');
  });

  it('lists every name the setup file strips (anti-drift)', () => {
    // Catches the other direction: a var added to setup.ts but never given a reason here, so
    // the next person cannot tell whether it is load-bearing or left over.
    const deleted = [...SETUP_STRIP_SECTION.matchAll(/delete process\.env\.([A-Z0-9_]+);/g)].map((m) => m[1]).sort();
    expect(deleted).toEqual(STRIPPED_ENV_VARS.map(([name]) => name).sort());
  });
});
