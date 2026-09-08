/**
 * @fileoverview Static guards over `install.sh`, the one file in this repo nothing else checks.
 *
 * There is no shellcheck, no bats, and CI is Node-only, so a bash mistake here reaches users
 * through `curl | bash` with nothing in between. The CI workflow now runs `bash -n` and a real
 * `bash:3.2` container (see `.github/workflows/ci.yml`), which catches syntax and the
 * `set -u` classes; this file catches the things that are perfectly valid bash and still wrong
 * for THIS script.
 *
 * Port: none (pure, over one source file).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(fileURLToPath(new URL('../install.sh', import.meta.url)), 'utf-8');

/** Lines with the leading `#` comments removed, so prose quoting a banned form is not a hit. */
const CODE_LINES = SOURCE.split('\n').filter((line) => !/^\s*#/.test(line));
const CODE = CODE_LINES.join('\n');

describe('install.sh stays bash 3.2 compatible', () => {
  // macOS ships bash 3.2 (the last GPLv2 release) and the documented install is
  // `curl -fsSL <url> | bash`, so a bash-4 construct is not a warning on a Mac, it is a
  // syntax error that kills the install mid-run.
  it.each([
    ['associative arrays (`declare -A`)', /\b(?:declare|local|typeset)\s+-[A-Za-z]*A/],
    ['case-conversion expansion (`${x,,}` / `${x^^}`)', /\$\{[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?[,^]{1,2}\}/],
    ['`mapfile` / `readarray`', /\b(?:mapfile|readarray)\b/],
    ['namerefs (`declare -n`)', /\b(?:declare|local|typeset)\s+-[A-Za-z]*n\b/],
    ['here-strings (`<<<`)', /<<</],
  ])('uses no %s', (_label, pattern) => {
    const offenders = CODE_LINES.filter((line) => pattern.test(line));
    expect(offenders, `bash 4+ construct found:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

describe('install.sh generated-catalogue block', () => {
  it('has exactly one matched marker pair', () => {
    expect(SOURCE.split('# >>> BEGIN GENERATED CLI CATALOGUE').length - 1).toBe(1);
    expect(SOURCE.split('# <<< END GENERATED CLI CATALOGUE').length - 1).toBe(1);
    expect(SOURCE.indexOf('# >>> BEGIN GENERATED CLI CATALOGUE')).toBeLessThan(
      SOURCE.indexOf('# <<< END GENERATED CLI CATALOGUE')
    );
  });

  it('declares every array the detection code indexes', () => {
    for (const name of [
      'CLI_IDS',
      'CLI_LABELS',
      'CLI_ENABLED',
      'CLI_KIND',
      'CLI_NPM',
      'CLI_DOCS',
      'CLI_CMD_LINUX',
      'CLI_CMD_DARWIN',
      'CLI_ALL_BINS',
      'CLI_BIN_OFF',
      'CLI_BIN_LEN',
      'CLI_ALL_PATHS',
      'CLI_PATH_OFF',
      'CLI_PATH_LEN',
    ]) {
      expect(new RegExp(`^${name}=\\(`, 'm').test(SOURCE), `${name} is not declared`).toBe(true);
    }
  });

  it('keeps no hand-written per-CLI detection behind', () => {
    // The nine `*_SEARCH_PATHS` arrays and eighteen `check_<cli>`/`get_<cli>_path` pairs are
    // what this change removes. One left behind would be a second source of truth that the
    // generator does not update — the exact shape of upstream b6d0f1fa.
    expect(CODE.match(/_SEARCH_PATHS=\(/g) ?? []).toEqual([]);

    // Keyed on the catalogue's OWN ids and binaries rather than an allowlist of the helpers
    // that may exist. `check_tmux` and `check_cloudflared` are legitimate and unrelated; a
    // `check_claude` or `get_omp_path` is the thing being removed. Deriving the ban from the
    // catalogue means a CLI added later is covered with no edit here.
    const names = new Set<string>();
    for (const arrayName of ['CLI_IDS', 'CLI_ALL_BINS']) {
      const m = new RegExp(`^${arrayName}=\\((.*)\\)$`, 'm').exec(SOURCE);
      for (const token of m?.[1].match(/'([^']*)'/g) ?? []) names.add(token.replace(/'/g, ''));
    }
    expect(names.size, 'could not read the catalogue ids/binaries').toBeGreaterThan(5);

    const perCliFunctions = [...names]
      .flatMap((name) => [`check_${name}()`, `get_${name}_path()`])
      .filter((fn) => new RegExp(`^${fn.replace(/[()]/g, '\\$&')}`, 'm').test(CODE));
    expect(perCliFunctions, `hand-written per-CLI detection still present:\n  ${perCliFunctions.join('\n  ')}`).toEqual(
      []
    );
  });
});

describe('install.sh trust boundary', () => {
  // A command the installer EXECUTES must have arrived embedded in this file, over the same
  // TLS fetch and in the same commit as the script itself — there is no second, network-derived
  // copy of these commands anywhere in the script (an earlier draft that added one, and split
  // a TRUSTED/DISPLAY pair to keep the fetched copy display-only, was dropped before merge:
  // see docs/cli-registry.md). These three assertions are what is left to guard now that the
  // fetch path itself does not exist: everything the installer runs or shows still comes only
  // from the generated block, and nothing in the file eval()s.
  it('writes CLI_INSTALL_CMD_TRUSTED only from the generated per-platform arrays', () => {
    const writes = CODE_LINES.filter((line) => /CLI_INSTALL_CMD_TRUSTED\s*\[[^\]]*\]\s*=/.test(line));
    expect(writes.length, 'expected exactly the two platform assignments').toBe(2);
    for (const line of writes) {
      expect(line, `TRUSTED written from something other than the generated block:\n  ${line}`).toMatch(
        /=\s*"\$\{CLI_CMD_(?:LINUX|DARWIN)\[\$i\]\}"/
      );
    }
  });

  it('fetches no CLI catalogue over the network at install time', () => {
    // The exact shape of the earlier, dropped design: a URL built from the repo/branch this
    // script came from, an opt-in env var to enable it, and a `download()` call feeding
    // straight into the trusted arrays. None of that exists in this file any more; this pins
    // the absence so it cannot quietly come back without a reviewer noticing.
    for (const needle of [
      'cli_catalog_refresh',
      'cli_catalog_default_url',
      'CODEMAN_CLI_CATALOGUE_URL',
      'CODEMAN_REFRESH_CLI_CATALOGUE',
      'CLI_INSTALL_CMD_DISPLAY',
    ]) {
      expect(SOURCE.includes(needle), `${needle} should not exist — the catalogue refresh was dropped`).toBe(false);
    }
  });

  it('never eval()s anything', () => {
    // install.sh has two long-standing, legitimate evals (`eval "$(brew shellenv)"`, Homebrew's
    // documented idiom, and one inside a node -e that reads `tailscale serve status`), both of
    // which operate on output this script itself produced, never on fetched content. With no
    // network-derived catalogue left to eval, the word should not appear at all outside those.
    const offenders = CODE_LINES.filter(
      (line) => /\beval\b/.test(line) && !/eval "\$\(.*shellenv\)"/.test(line) && !line.includes('eval(process.argv')
    );
    expect(offenders, `unexpected eval:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it("redirects stdin for every command it executes on the user's behalf", () => {
    // Under `curl | bash` the script IS stdin, so a child that reads stdin eats the rest of
    // it. Every spawn of an untrusted-length vendor command must carry `</dev/null`.
    const spawns = CODE_LINES.filter((line) => /\bbash -c "\$\{CLI_INSTALL_CMD_TRUSTED/.test(line));
    expect(spawns.length, 'expected the single install-menu spawn').toBe(1);
    for (const line of spawns) {
      expect(line, `install spawn without </dev/null:\n  ${line}`).toContain('</dev/null');
    }
  });
});

describe('install.sh runtime safety', () => {
  it('can be sourced without installing anything', () => {
    // The bash 3.2 CI step sources this file to exercise detect_all_clis. Without the guard
    // the dispatch `case` at the tail would run a real install inside the container.
    expect(SOURCE).toMatch(
      /if \[\[ -n "\$\{CODEMAN_INSTALL_SH_LIB:-\}" \]\]; then return 0 2>\/dev\/null \|\| exit 0; fi/
    );
    const guardAt = SOURCE.indexOf('CODEMAN_INSTALL_SH_LIB');
    const dispatchAt = SOURCE.indexOf('case "${1:-}" in');
    expect(guardAt, 'the sourcing guard must precede the dispatch case').toBeLessThan(dispatchAt);
  });

  it('still sets the strict flags it has always run under', () => {
    expect(SOURCE).toMatch(/^set -euo pipefail$/m);
  });
});
