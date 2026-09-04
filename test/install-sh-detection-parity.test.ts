/**
 * @fileoverview Pins `install.sh`'s CLI detection paths BEFORE they are generated.
 *
 * PR B replaces nine hand-written `*_SEARCH_PATHS` arrays in `install.sh` with one block
 * generated from `STOCK_CLIS`. The arrays are NOT uniform — claude alone has
 * `~/.claude/local`, opencode alone has `~/go/bin`, opencode/codex/gemini/pi/omp have
 * `~/.bun/bin` while dsh/grok/agy do not, and omp's `~/.omp/bin` sits SECOND rather than
 * first — so "generate them from the registry" is a claim that has to be proved, not
 * assumed. If the generated list silently narrows, a user with that CLI installed stops
 * being detected and is told no AI CLI was found: exactly the bug upstream `b6d0f1fa` fixed
 * for omp by hand.
 *
 * This file is deliberately written FIRST, against the hand-written arrays, and kept
 * afterwards as a regression pin. It asserts a three-way identity:
 *
 *   1. the literals below === what `install.sh` actually contains today
 *   2. the literals below === `searchDirs x binaries` from the registry
 *
 * Together those mean the generator can only produce what is already shipping. (1) fails if
 * `install.sh` drifts from the pin; (2) fails if a registry entry's `searchDirs` drifts from
 * the installer — which, once the block is generated, is the same statement.
 *
 * ⚠️ The literals are the SOURCE OF TRUTH here and were transcribed from `install.sh` at
 * `72fd231d`. Do not "fix" a failure by re-copying the current file into them; that turns
 * the pin into a mirror and it stops guarding anything. Work out which side moved.
 *
 * Port: none (pure, over one source file and the registry).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const INSTALL_SH = readFileSync(fileURLToPath(new URL('../install.sh', import.meta.url)), 'utf-8');

/**
 * The nine arrays exactly as `install.sh` declares them, in declaration order, with the
 * shell-variable form (`$HOME/...`) they carry there rather than the registry's `~/...`.
 *
 * Keyed by the array's own prefix, which is NOT always the registry id: DeepSeek's entry is
 * `deepseek` but its binary and array are `DSH`, and antigravity's binary is `agy`.
 */
const LITERAL_SEARCH_PATHS: Record<string, string[]> = {
  CLAUDE: [
    '$HOME/.local/bin/claude',
    '$HOME/.claude/local/claude',
    '/usr/local/bin/claude',
    '$HOME/.npm-global/bin/claude',
    '$HOME/bin/claude',
  ],
  OPENCODE: [
    '$HOME/.opencode/bin/opencode',
    '$HOME/.local/bin/opencode',
    '/usr/local/bin/opencode',
    '$HOME/go/bin/opencode',
    '$HOME/.bun/bin/opencode',
    '$HOME/.npm-global/bin/opencode',
    '$HOME/bin/opencode',
  ],
  CODEX: [
    '$HOME/.codex/bin/codex',
    '$HOME/.local/bin/codex',
    '/usr/local/bin/codex',
    '$HOME/.bun/bin/codex',
    '$HOME/.npm-global/bin/codex',
    '$HOME/bin/codex',
  ],
  GEMINI: [
    '$HOME/.gemini/bin/gemini',
    '$HOME/.local/bin/gemini',
    '/usr/local/bin/gemini',
    '$HOME/.bun/bin/gemini',
    '$HOME/.npm-global/bin/gemini',
    '$HOME/bin/gemini',
  ],
  PI: ['$HOME/.local/bin/pi', '/usr/local/bin/pi', '$HOME/.bun/bin/pi', '$HOME/.npm-global/bin/pi', '$HOME/bin/pi'],
  DSH: ['$HOME/.local/bin/dsh', '/usr/local/bin/dsh', '$HOME/.npm-global/bin/dsh', '$HOME/bin/dsh'],
  GROK: ['$HOME/.grok/bin/grok', '$HOME/.local/bin/grok', '/usr/local/bin/grok', '$HOME/bin/grok'],
  ANTIGRAVITY: ['$HOME/.local/bin/agy', '$HOME/.antigravity/bin/agy', '/usr/local/bin/agy', '$HOME/bin/agy'],
  OMP: [
    '$HOME/.local/bin/omp',
    '$HOME/.omp/bin/omp',
    '/usr/local/bin/omp',
    '$HOME/.bun/bin/omp',
    '$HOME/.npm-global/bin/omp',
    '$HOME/bin/omp',
  ],
};

/** Array prefix in `install.sh` -> registry id, for the two that differ. */
const ARRAY_PREFIX_TO_CLI_ID: Record<string, string> = {
  CLAUDE: 'claude',
  OPENCODE: 'opencode',
  CODEX: 'codex',
  GEMINI: 'gemini',
  PI: 'pi',
  DSH: 'deepseek',
  GROK: 'grok',
  ANTIGRAVITY: 'antigravity',
  OMP: 'omp',
};

/** Every `NAME_SEARCH_PATHS=( "a" "b" )` block in install.sh, in declaration order. */
function parseInstallShSearchPaths(source: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const block = /^([A-Z0-9_]+)_SEARCH_PATHS=\(\s*\n([\s\S]*?)^\)/gm;
  for (const match of source.matchAll(block)) {
    const entries = [...match[2].matchAll(/^\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
    out[match[1]] = entries;
  }
  return out;
}

/**
 * What the generated block must contain for one entry: `searchDirs x binaries`, in that
 * nesting order, with `~` rewritten to `$HOME` the way the generator will emit it.
 *
 * The dir-major order matters and is not arbitrary — it is the order the resolvers probe in,
 * so a binary-major flattening would still contain every path while checking them in the
 * wrong sequence, and the first hit would change on a machine with two installs.
 */
function registrySearchPaths(cliId: string): string[] {
  const entry = STOCK_CLIS.find((e) => (e.id as string) === cliId);
  if (!entry) throw new Error(`no stock entry ${cliId}`);
  return entry.discovery.searchDirs.flatMap((dir) =>
    entry.discovery.binaries.map((bin) => `${dir.startsWith('~/') ? `$HOME/${dir.slice(2)}` : dir}/${bin}`)
  );
}

describe('install.sh CLI detection parity', () => {
  const parsed = parseInstallShSearchPaths(INSTALL_SH);

  it('finds every declared search-path array (anti-vacuity)', () => {
    // If the parse returns nothing, every it.each below passes by comparing [] to [].
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(LITERAL_SEARCH_PATHS).sort());
    for (const [name, paths] of Object.entries(parsed)) {
      expect(paths.length, `${name}_SEARCH_PATHS parsed empty`).toBeGreaterThan(0);
    }
  });

  it.each(Object.keys(LITERAL_SEARCH_PATHS))('%s_SEARCH_PATHS matches the pinned literals', (prefix) => {
    expect(parsed[prefix]).toEqual(LITERAL_SEARCH_PATHS[prefix]);
  });

  it.each(Object.entries(ARRAY_PREFIX_TO_CLI_ID))(
    '%s_SEARCH_PATHS is reproduced by registry entry "%s"',
    (prefix, cliId) => {
      // The claim the generator rests on: the registry already knows every path the
      // installer probes, in the same order. A failure here means the generated block would
      // detect a different set than the hand-written one it replaces.
      expect(registrySearchPaths(cliId)).toEqual(LITERAL_SEARCH_PATHS[prefix]);
    }
  );

  it('covers every stock CLI that has a binary to find', () => {
    // `shell` declares no binaries, so it has nothing to detect and no array. Everything
    // else must be pinned above, or a new CLI could land with no installer coverage — which
    // is the omp bug (upstream b6d0f1fa) restated as a test.
    const detectable = STOCK_CLIS.filter((e) => e.discovery.binaries.length > 0).map((e) => e.id as string);
    expect(detectable.sort()).toEqual(Object.values(ARRAY_PREFIX_TO_CLI_ID).sort());
  });
});
