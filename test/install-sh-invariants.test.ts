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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import { CLI_INSTALLED_MARKER } from '../src/utils/cli-executable-resolver.js';
import { ARCHIVE_INSTALL_MARKER } from '../src/web/self-update.js';

const INSTALL_SH = fileURLToPath(new URL('../install.sh', import.meta.url));
const SOURCE = readFileSync(INSTALL_SH, 'utf-8');

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

  it('declares every array install.sh actually reads', () => {
    for (const name of [
      'CLI_IDS',
      'CLI_LABELS',
      'CLI_ENABLED',
      'CLI_LAUNCHER_ONLY',
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

  it('declares no array install.sh never reads', () => {
    // CLI_KIND and CLI_NPM were generated and read by nothing (the .mjs/docker-hosts.ts
    // producers read the JSON's `kind`/`npmPackage` fields directly; only these two bash
    // arrays were dead). A generated-but-unread array is a maintenance trap the generator
    // itself cannot warn about — it has no reader to check against — so this pins the
    // opposite of the test above: naming what must NOT come back rather than what must.
    for (const name of ['CLI_KIND', 'CLI_NPM']) {
      expect(new RegExp(`^${name}=\\(`, 'm').test(SOURCE), `${name} is declared but nothing reads it`).toBe(false);
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

  it('keeps no dead generic-lookup helpers behind', () => {
    // _cli_index/check_cli/get_cli_path were the ungenericized precursor to the per-CLI
    // helpers above: same shape, one level of indirection, called from nowhere once the
    // catalogue-driven menu and hints stopped needing a lookup-by-id. Unlike the per-CLI
    // pairs these are exact names, not derived from the catalogue.
    for (const fn of ['_cli_index()', 'check_cli()', 'get_cli_path()']) {
      expect(CODE.includes(fn), `${fn} should have been removed as dead code`).toBe(false);
    }
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
    const dispatchAt = SOURCE.indexOf('case "$SUBCOMMAND" in');
    expect(dispatchAt, 'the dispatch case must exist').toBeGreaterThan(-1);
    expect(guardAt, 'the sourcing guard must precede the dispatch case').toBeLessThan(dispatchAt);
    // parse_flags runs only in the dispatch tail, after the guard: a sourced copy must
    // never consume the harness's own arguments.
    const parseAt = SOURCE.indexOf('\nparse_flags "$@"');
    expect(parseAt, 'parse_flags must be invoked after the sourcing guard').toBeGreaterThan(guardAt);
  });

  it('still sets the strict flags it has always run under', () => {
    expect(SOURCE).toMatch(/^set -euo pipefail$/m);
  });
});

describe('install.sh DeepSeek identity probe', () => {
  it('greps for the same banner the registry identity regex demands', () => {
    // dsh_banner_probe is the ONE hand-written identity check left in the script (the
    // registry's is a JavaScript regex, deliberately not translated into grep at install
    // time). The two are pinned to each other here so an upstream banner change fails
    // this test instead of mis-detecting on one side only.
    const grepLine = CODE_LINES.find((line) => line.includes('grep -qi "DeepSeek Harness"'));
    expect(grepLine, 'the dsh banner grep is gone or its literal changed').toBeDefined();

    const deepseek = STOCK_CLIS.find((entry) => entry.id === 'deepseek');
    const identity = deepseek?.discovery.identity;
    expect(identity, 'the deepseek entry no longer declares an identity probe').toBeDefined();
    expect(identity?.arg).toBe('--help');
    expect(new RegExp(identity!.regex, 'i').test('DeepSeek Harness')).toBe(true);
  });
});

describe('install.sh owns the build and the start', () => {
  it('runs npm install with CODEMAN_NO_AUTOSTART=1', () => {
    // scripts/postinstall.js builds dist/ and starts a detached `codeman web` on its
    // own unless told not to. Under the installer that orphan made the service
    // crash-loop on EADDRINUSE while the done screen reported "running" off the
    // orphan (fresh Ubuntu 24 sandbox, 2026-09-20). Every npm install here must
    // carry the opt-out.
    // Executed installs only: the catalogue's `npm install -g` literals and the
    // failure message that quotes the command are prose here.
    const installs = CODE_LINES.filter(
      (line) => /\bnpm install\b/.test(line) && !/npm install -g/.test(line) && !/\b(error|warn|info|echo) "/.test(line)
    );
    expect(installs.length, 'expected the one npm install call').toBeGreaterThan(0);
    for (const line of installs) {
      expect(line, `npm install without CODEMAN_NO_AUTOSTART=1:\n  ${line}`).toContain('CODEMAN_NO_AUTOSTART=1');
    }
  });
});

describe('install.sh Tailscale safety rules', () => {
  // Every rule here protects config that is not ours. `serve reset` destroys a user's
  // unrelated serve mappings (the maintainer's own node carries two); funnel is the
  // public internet, a different risk class than tailnet-only serve; advertising a
  // Tailscale Service requires a tagged node and admin approval and is documented
  // as a hint only. All three are pinned as absences.
  it('never runs `tailscale serve reset`', () => {
    const offenders = CODE_LINES.filter((line) => /serve\s+reset\b/.test(line));
    expect(offenders).toEqual([]);
  });

  it('never runs `tailscale funnel` and never advertises a Tailscale Service', () => {
    // The installer's own `--service` flag (run as a service) is not Tailscale's
    // `--service=svc:<name>`; the pin keys on the svc: prefix and the serve form.
    const offenders = CODE_LINES.filter(
      (line) => /\bfunnel\b/.test(line) || /\bsvc:/.test(line) || /\bserve\b.*--service/.test(line)
    );
    expect(offenders).toEqual([]);
  });

  it('routes every serve mutation through ts_cmd_serve (the sudo-aware wrapper)', () => {
    // A bare `tailscale serve --bg` or `set --hostname` would fail for a non-operator
    // user on Linux, exactly the state the wrapper exists to handle.
    const mutations = CODE_LINES.filter((line) => /\bserve --(bg|https)/.test(line) || /\bset --hostname\b/.test(line));
    expect(mutations.length).toBeGreaterThan(0);
    for (const line of mutations) {
      // Prose in warn/info strings and manual-command hints are fine; executed lines
      // must start with the wrapper.
      const executed = /^\s*(if\s+)?(!\s*)?(out=\$\()?ts_cmd_serve\b/.test(line);
      const quoted = /(info|warn|echo -e|success) /.test(line) || /Run: /.test(line) || /Configuring: /.test(line);
      expect(executed || quoted, `serve mutation outside ts_cmd_serve:\n  ${line}`).toBe(true);
    }
  });

  it('decides the rename before the serve shape, and applies serve only after the build', () => {
    // Serve config is keyed by the DNS name it was written under: renaming after
    // configuring would orphan the mapping (and only `serve reset` could remove the
    // stale key). tailscale_prepare therefore asks the name first, chooses the shape
    // second, and main() applies the shape only after the build and the service.
    const prepare = SOURCE.slice(SOURCE.indexOf('tailscale_prepare() {'), SOURCE.indexOf('tailscale_apply() {'));
    expect(prepare.indexOf('tailscale_choose_name')).toBeGreaterThan(-1);
    expect(prepare.indexOf('tailscale_choose_name')).toBeLessThan(prepare.indexOf('tailscale_choose_mapping'));
    const main = SOURCE.slice(SOURCE.indexOf('\nmain() {'), SOURCE.indexOf('\npreflight_detect() {'));
    const order = [
      'choose_network_binding',
      'choose_launch_mode',
      'install_or_update_repo',
      'npm_install_deps',
      'run_step "Building Codeman"',
      'tailscale_apply',
      'print_done_screen',
    ];
    const positions = order.map((needle) => main.indexOf(needle));
    for (let i = 0; i < positions.length; i++) {
      expect(positions[i], `${order[i]} missing from main()`).toBeGreaterThan(-1);
      if (i > 0) expect(positions[i], `${order[i]} must come after ${order[i - 1]}`).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('documents every flag it parses', () => {
    // The header comment is the only manual most people read (it is what `curl` shows
    // them if they look). A flag parse_flags accepts and the header does not mention
    // is a flag nobody finds.
    const header = SOURCE.slice(0, SOURCE.indexOf('set -euo pipefail'));
    const parse = SOURCE.slice(SOURCE.indexOf('parse_flags() {'), SOURCE.indexOf('# Sourcing guard'));
    const flags = Array.from(parse.matchAll(/^\s+(--[a-z-]+)(?:[|)=\s])/gm), (m) => m[1]);
    expect(flags.length).toBeGreaterThan(5);
    for (const flag of new Set(flags)) {
      expect(header.includes(flag), `${flag} is parsed but not documented in the header`).toBe(true);
    }
  });

  it('renames only as an opt-in: the question defaults to no and --yes never renames', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('tailscale_choose_name() {'), SOURCE.indexOf('tailscale_rename_node() {'));
    expect(fn).toMatch(/prompt_yes_no "Rename this machine to \$suggested\?" "n"/);
    expect(fn).toMatch(/\[\[ "\$ASSUME_YES" == "1" \]\]/);
  });
});

describe('install.sh AI CLI install menu', () => {
  // The menu is the one interactive path in the script, which is why it used to be the
  // only part nothing exercised: choosing "s" (Skip) once fell straight into the shared
  // "failed to install" gate and aborted the installer before the clone. These drive the
  // real function (offer_ai_cli_install) in a real bash, with detection pointed at
  // nothing so the menu appears, and read_reply scripted.
  const DRIVER = `
    set -euo pipefail
    export CODEMAN_INSTALL_SH_LIB=1
    . "$1"
    k=0; while [[ $k -lt \${#CLI_ALL_BINS[@]} ]]; do CLI_ALL_BINS[$k]="codeman-test-no-such-bin-$k"; k=$((k + 1)); done
    k=0; while [[ $k -lt \${#CLI_ALL_PATHS[@]} ]]; do CLI_ALL_PATHS[$k]="/nonexistent/codeman-test/$k"; k=$((k + 1)); done
    if [[ -n "\${MENU_INSTALL_CMD:-}" ]]; then
      k=0; while [[ $k -lt \${#CLI_INSTALL_CMD_TRUSTED[@]} ]]; do CLI_INSTALL_CMD_TRUSTED[$k]="$MENU_INSTALL_CMD"; k=$((k + 1)); done
    fi
    CLI_DETECT_DONE=""
    detect_all_clis
    echo "found=$CLI_FOUND_COUNT"
    NONINTERACTIVE=0
    DOWNLOADER=curl
    has_tty() { return 0; }
    headless_guard() { return 0; }
    read_reply() { eval "$1=\\"$MENU_ANSWER\\""; }
    offer_ai_cli_install
    echo "REACHED THE STEP AFTER THE MENU"
  `;

  function driveMenu(answer: string, installCommand?: string) {
    const result = spawnSync('bash', ['-c', DRIVER, 'bash', INSTALL_SH], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, MENU_ANSWER: answer, ...(installCommand ? { MENU_INSTALL_CMD: installCommand } : {}) },
    });
    // eslint-disable-next-line no-control-regex
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    return { status: result.status, stdout: strip(result.stdout ?? ''), stderr: strip(result.stderr ?? '') };
  }

  it('offers the menu only when nothing is installed', () => {
    const run = driveMenu('s');
    expect(run.stdout).toContain('found=0');
    expect(run.stderr).toContain('Choose [1-');
  });

  it('continues past the menu when the user skips', () => {
    const run = driveMenu('s');
    expect(run.stderr).toContain('Skipping AI CLI install');
    expect(run.stdout, run.stderr).toContain('REACHED THE STEP AFTER THE MENU');
    expect(run.stderr).not.toContain('failed to install');
    expect(run.status).toBe(0);
  });

  it('still dies when the chosen install leaves nothing behind', () => {
    const run = driveMenu('1', 'false');
    expect(run.stderr).toContain('installation failed');
    expect(run.stderr).toContain('The selected AI CLI failed to install');
    expect(run.stdout).not.toContain('REACHED THE STEP AFTER THE MENU');
    expect(run.status).toBe(1);
  });
});

describe('install.sh --ai-cli answers the menu up front', () => {
  // The desktop app installs with no terminal, so the agent is chosen in its window and
  // arrives as a flag. Everything here runs the real functions in a real bash, with
  // detection pointed at nothing, every trusted command rewritten to record which entry
  // ran, and no tty, which is what the app's child process has.
  const DRIVER = `
    set -euo pipefail
    export CODEMAN_INSTALL_SH_LIB=1
    . "$1"
    set +e
    parse_flags "\${@:2}" || exit 9
    set -e
    k=0; while [[ $k -lt \${#CLI_ALL_BINS[@]} ]]; do CLI_ALL_BINS[$k]="codeman-test-no-such-bin-$k"; k=$((k + 1)); done
    k=0; while [[ $k -lt \${#CLI_ALL_PATHS[@]} ]]; do CLI_ALL_PATHS[$k]="/nonexistent/codeman-test/$k"; k=$((k + 1)); done
    k=0; while [[ $k -lt \${#CLI_INSTALL_CMD_TRUSTED[@]} ]]; do
      if [[ -n "\${CLI_INSTALL_CMD_TRUSTED[$k]}" ]]; then
        if [[ "\${KEEP_BREW:-}" == "1" && "\${CLI_INSTALL_CMD_TRUSTED[$k]}" == brew\\ * ]]; then :; else
          CLI_INSTALL_CMD_TRUSTED[$k]="echo RAN=\${CLI_IDS[$k]}"
        fi
      fi
      k=$((k + 1))
    done
    CLI_DETECT_DONE=""
    detect_all_clis
    NONINTERACTIVE=\${FORCE_NONINTERACTIVE:-0}
    DOWNLOADER=curl
    has_tty() { return 1; }
    offer_ai_cli_install
    echo "REACHED THE STEP AFTER THE MENU"
  `;

  function drive(args: string[], env: Record<string, string> = {}) {
    const result = spawnSync('bash', ['-c', DRIVER, 'bash', INSTALL_SH, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
    const stdout = result.stdout ?? '';
    // Anchored: the skip hints print each command's text, so `echo RAN=x` there ran nothing.
    const ran = [...stdout.matchAll(/^RAN=(.+)$/gm)].map((m) => m[1]);
    return { status: result.status, stdout, stderr: result.stderr ?? '', ran };
  }

  it('none installs nothing and carries on, even with CODEMAN_NONINTERACTIVE', () => {
    const run = drive(['--ai-cli', 'none'], { FORCE_NONINTERACTIVE: '1' });
    expect(run.stdout, run.stderr).toContain('REACHED THE STEP AFTER THE MENU');
    expect(run.ran).toEqual([]);
    expect(run.stderr).toContain('Skipping AI CLI install');
  });

  it('a named CLI runs that entry and no other, without the menu and without a terminal', () => {
    const run = drive(['--ai-cli=codex']);
    expect(run.ran).toEqual(['codex']);
    expect(run.stdout).not.toContain('Which AI CLI');
    expect(run.status).toBe(1); // The stand-in command leaves no binary: the gate below still holds.
    expect(run.stderr).toContain('The selected AI CLI failed to install');
  });

  it('takes the same answer from CODEMAN_AI_CLI', () => {
    expect(drive([], { CODEMAN_AI_CLI: 'gemini' }).ran).toEqual(['gemini']);
  });

  it('a CLI this host cannot install warns and carries on, never installing another', () => {
    const run = drive(['--no-admin', '--ai-cli', 'omp'], { KEEP_BREW: '1' });
    if (process.platform === 'darwin') {
      expect(run.ran).toEqual([]);
      expect(run.stderr).toContain('omp cannot be installed automatically here');
      expect(run.stdout).toContain('REACHED THE STEP AFTER THE MENU');
    } else {
      expect(run.ran).toEqual(['omp']); // Linux installs omp with curl, not brew.
    }
  });

  it('deepseek has no command to run, so it warns and carries on', () => {
    const run = drive(['--ai-cli', 'deepseek']);
    expect(run.ran).toEqual([]);
    expect(run.stderr).toContain('deepseek cannot be installed automatically here');
    expect(run.stdout).toContain('REACHED THE STEP AFTER THE MENU');
  });

  it.each([['cluade'], ['shell'], ['--yes']])('refuses %s before anything runs', (id) => {
    const run = drive([`--ai-cli=${id}`]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Unknown AI CLI');
    expect(run.ran).toEqual([]);
  });

  it('a bare run with no terminal and no answer is still refused by the guard', () => {
    const run = drive([]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No interactive terminal');
    expect(run.ran).toEqual([]);
  });
});

describe('install.sh preflight', () => {
  function preflight(args: string[], env: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), 'codeman-preflight-'));
    try {
      const result = spawnSync('bash', [INSTALL_SH, 'preflight', ...args], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, HOME: home, ...env },
      });
      expect(result.status, result.stderr).toBe(0);
      return { stdout: result.stdout, home };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('prints one JSON object in the shape the desktop app reads', () => {
    const { stdout } = preflight(['--no-admin']);
    const found = JSON.parse(stdout);
    expect(found.schema).toBe(1);
    expect(found.noAdmin).toBe(true);
    expect(typeof found.blocker).toBe('string');
    expect(Object.keys(found.needs).sort()).toEqual(['git', 'node', 'tmux']);
    for (const key of ['node', 'tmux', 'git']) expect(typeof found.needs[key]).toBe('boolean');
    // Exactly what src/gui_install.rs deserializes, or the app calls the answer unreadable.
    for (const cli of found.clis) {
      expect(Object.keys(cli).sort()).toEqual(['docs', 'id', 'installable', 'installed', 'label']);
    }
  });

  it('lists every agent of the catalogue, in its order, and never the shell', () => {
    const ids = JSON.parse(preflight(['--no-admin']).stdout).clis.map((c: { id: string }) => c.id);
    const agents = STOCK_CLIS.filter((c) => c.discovery.binaries.length > 0).sort((a, b) => a.order - b.order);
    expect(ids).toEqual(agents.map((c) => c.id));
  });

  it('never calls an installed CLI installable, and agrees with the menu on the rest', () => {
    for (const cli of JSON.parse(preflight(['--no-admin']).stdout).clis) {
      if (cli.installed) expect(cli.installable, cli.id).toBe(false);
    }
    const deepseek = JSON.parse(preflight(['--no-admin']).stdout).clis.find((c: { id: string }) => c.id === 'deepseek');
    if (!deepseek.installed) expect(deepseek.installable).toBe(false); // A launcher alone cannot drive a pane.
  });

  it('writes nothing into the home folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'codeman-preflight-'));
    try {
      const result = spawnSync('bash', [INSTALL_SH, 'preflight', '--no-admin'], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, HOME: home },
      });
      expect(result.status).toBe(0);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('json_string survives what a path or a message can hold', () => {
    const driver = `
      export CODEMAN_INSTALL_SH_LIB=1
      . "$1"
      set +e
      json_string "$2"
    `;
    const text = 'quote " back\\slash tab\t line\nfeed bell\u0007 é ✓';
    const result = spawnSync('bash', ['-c', driver, 'bash', INSTALL_SH, text], { encoding: 'utf-8', timeout: 30_000 });
    expect(JSON.parse(result.stdout)).toBe(text.replace('\u0007', ''));
  });
});

describe('install.sh agent, one AI CLI and nothing else', () => {
  // The real subcommand in a real bash, with detection pointed at nothing and every
  // trusted command rewritten: LEAVES names the binary a stand-in install leaves
  // behind (on PATH, in the run's own folder), FOUND is a CLI already here.
  const DRIVER = `
    set -euo pipefail
    export CODEMAN_INSTALL_SH_LIB=1
    . "$1"
    set +e
    parse_flags "\${@:2}" || exit 9
    set -e
    bin=$(mktemp -d); trap 'rm -rf "$bin"' EXIT; export PATH="$bin:$PATH"
    k=0; while [[ $k -lt \${#CLI_ALL_BINS[@]} ]]; do CLI_ALL_BINS[$k]="codeman-test-no-such-bin-$k"; k=$((k + 1)); done
    k=0; while [[ $k -lt \${#CLI_ALL_PATHS[@]} ]]; do CLI_ALL_PATHS[$k]="/nonexistent/codeman-test/$k"; k=$((k + 1)); done
    k=0; while [[ $k -lt \${#CLI_INSTALL_CMD_TRUSTED[@]} ]]; do
      if [[ "\${KEEP_COMMANDS:-}" != "1" && -n "\${CLI_INSTALL_CMD_TRUSTED[$k]}" ]]; then
        CLI_INSTALL_CMD_TRUSTED[$k]="echo RAN=\${CLI_IDS[$k]}; if [[ \${CLI_IDS[$k]} == \\"\${LEAVES:-}\\" ]]; then printf '#!/bin/sh\\n' > $bin/codeman-test-left-$k; chmod +x $bin/codeman-test-left-$k; fi"
      fi
      if [[ "\${CLI_IDS[$k]}" == "\${FOUND:-}" ]]; then
        printf '#!/bin/sh\n' > "$bin/codeman-test-found"; chmod +x "$bin/codeman-test-found"
        off=\${CLI_BIN_OFF[$k]}; CLI_ALL_BINS[$off]=codeman-test-found
      fi
      if [[ "\${CLI_IDS[$k]}" == "\${LEAVES:-}" ]]; then
        off=\${CLI_BIN_OFF[$k]}; CLI_ALL_BINS[$off]=codeman-test-left-$k
      fi
      k=$((k + 1))
    done
    if [[ -n "\${NO_NPM:-}" ]]; then check_npm() { return 1; }; fi
    CLI_DETECT_DONE=""
    agent_subcommand
    echo "REACHED THE END"
  `;

  function agent(args: string[], env: Record<string, string> = {}) {
    const result = spawnSync('bash', ['-c', DRIVER, 'bash', INSTALL_SH, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, CODEMAN_PROGRESS: '', ...env },
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { status: result.status, stdout, stderr, ran: [...stdout.matchAll(/^RAN=(.+)$/gm)].map((m) => m[1]) };
  }

  /** The same, in a home folder of its own, reporting whether the marker was written. */
  function agentInHome(args: string[], env: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), 'codeman-agent-marker-'));
    try {
      mkdirSync(join(home, '.codeman'));
      const run = agent(args, { HOME: home, ...env });
      return { ...run, marked: existsSync(join(home, '.codeman', CLI_INSTALLED_MARKER)) };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('tells a running server when the agent landed, and only then', () => {
    expect(agentInHome(['--ai-cli', 'codex', '--no-admin'], { LEAVES: 'codex' }).marked).toBe(true);
    expect(agentInHome(['--ai-cli', 'codex', '--no-admin']).marked).toBe(false);
    // Installed by hand a minute ago, and the server may still remember it as missing.
    expect(agentInHome(['--ai-cli', 'codex', '--no-admin'], { FOUND: 'codex' }).marked).toBe(true);
  });

  it('a home folder with no Codeman in it is no failure', () => {
    const home = mkdtempSync(join(tmpdir(), 'codeman-agent-marker-'));
    try {
      const run = agent(['--ai-cli', 'codex', '--no-admin'], { HOME: home, LEAVES: 'codex' });
      expect(run.status, run.stderr).toBe(0);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes the file the server reads', () => {
    expect(SOURCE).toContain(`"$HOME/.codeman/${CLI_INSTALLED_MARKER}"`);
  });

  it('installs the one it was told to, and says done', () => {
    const run = agent(['--no-admin', '--progress', '--ai-cli', 'codex'], { LEAVES: 'codex' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.ran).toEqual(['codex']);
    expect(run.stderr).toContain('@@codeman phase agent');
    expect(run.stderr).toContain('@@codeman phase done');
  });

  it('never says done when that agent did not land, even with another one here', () => {
    const run = agent(['--no-admin', '--progress', '--ai-cli', 'codex'], { FOUND: 'copilot' });
    expect(run.ran).toEqual(['codex']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('@@codeman error Codex did not install.');
    expect(run.stderr).not.toContain('@@codeman phase done');
    expect(run.stdout).not.toContain('REACHED THE END');
  });

  it('says the same with no other agent here, the way a Mac is after Skip for now', () => {
    const run = agent(['--no-admin', '--progress', '--ai-cli', 'codex']);
    expect(run.ran).toEqual(['codex']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('@@codeman error Codex did not install.');
    expect(run.stderr).not.toContain('re-run the installer');
    expect(run.stderr).not.toContain('@@codeman phase done');
  });

  it('installs nothing for an agent that is here already, and that is a success', () => {
    const run = agent(['--no-admin', '--progress', '--ai-cli', 'codex'], { FOUND: 'codex' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.ran).toEqual([]);
    expect(run.stderr).toContain('@@codeman phase done');
  });

  it('names what is wrong when npm cannot be found, before running anything', () => {
    const run = agent(['--no-admin', '--progress', '--ai-cli', 'codex'], { KEEP_COMMANDS: '1', NO_NPM: '1' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Codex installs with npm, and this run cannot find it');
    expect(run.stderr).toContain('npm install -g @openai/codex');
    expect(run.stderr).not.toContain('@@codeman phase done');
  });

  it('refuses an agent it cannot install, and installs no other in its place', () => {
    const run = agent(['--no-admin', '--progress', '--ai-cli', 'deepseek'], { KEEP_COMMANDS: '1' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('DeepSeek cannot be installed automatically here');
    expect(run.stderr).not.toContain('@@codeman phase done');
  });

  it('it takes the name as a plain word, as a person would type it', () => {
    const driver = `
      export CODEMAN_INSTALL_SH_LIB=1
      . "$1"
      set +e
      parse_flags "\${@:2}" || exit 9
      echo "sub=$SUBCOMMAND cli=$AI_CLI_CHOICE"
    `;
    const parsed = (...args: string[]) =>
      spawnSync('bash', ['-c', driver, 'bash', INSTALL_SH, ...args], { encoding: 'utf-8', timeout: 30_000 });
    expect(parsed('agent', 'codex', '--no-admin').stdout).toContain('sub=agent cli=codex');
    expect(parsed('agent', '--ai-cli', 'codex').stdout).toContain('sub=agent cli=codex');
    expect(parsed('agent', 'codx').stderr).toContain('Unknown AI CLI: codx');
    expect(parsed('agent', 'shell').stderr).toContain('Unknown AI CLI: shell');
    expect(parsed('agent', 'codex', 'copilot').stderr).toContain('Unexpected argument: copilot');
    expect(parsed('codex').stderr).toContain('Unexpected argument: codex');
  });

  it('wants a name, and none is not one', () => {
    expect(agent([]).stderr).toContain('Name the AI CLI to install');
    expect(agent(['--ai-cli', 'none']).stderr).toContain('Name the AI CLI to install');
  });

  it('leaves Codeman alone: nothing in it touches the service, the source or the build', () => {
    const body = SOURCE.slice(
      SOURCE.indexOf('\nagent_subcommand() {'),
      SOURCE.indexOf('\n# Offer to install one AI CLI')
    );
    for (const word of ['launchctl', 'systemctl', 'setup_launchd', 'install_or_update_repo', 'npm run', 'sudo']) {
      expect(body, word).not.toContain(word);
    }
    expect(body).toContain('run_offered_cli "$idx"');
  });
});

describe('install.sh --progress, the protocol the desktop app reads', () => {
  const CONNECT_HTML = readFileSync(
    fileURLToPath(new URL('../packages/desktop/assets/connect.html', import.meta.url)),
    'utf-8'
  );

  function mainBody() {
    const start = SOURCE.indexOf('main() {');
    const end = SOURCE.indexOf('# Phase 0: look', start);
    return SOURCE.slice(start, end);
  }

  it('reports its phases in the order the app draws them, ending on done', () => {
    const phases = [...mainBody().matchAll(/^\s*progress_phase (\w+)$/gm)].map((m) => m[1]);
    const drawn = /var PHASES = \[([^\]]*)\]/.exec(CONNECT_HTML)?.[1].match(/\w+/g);
    expect(phases).toEqual([...(drawn ?? []), 'done']);
  });

  it('reports done after the service step and before a foreground start replaces the shell', () => {
    const main = mainBody();
    expect(main.indexOf('progress_phase done')).toBeGreaterThan(main.indexOf('print_done_screen'));
    expect(main.indexOf('progress_phase done')).toBeLessThan(main.indexOf('exec node'));
  });

  function driveProtocol(env: Record<string, string>) {
    const driver = `
      export CODEMAN_INSTALL_SH_LIB=1
      . "$1"
      set +e
      progress_phase build
      error "first
second"
    `;
    return spawnSync('bash', ['-c', driver, 'bash', INSTALL_SH], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
  }

  it('prints protocol lines on stderr, one line each, so a $( ) capture stays clean', () => {
    const run = driveProtocol({ CODEMAN_PROGRESS: '1' });
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('@@codeman phase build\n');
    expect(run.stderr).toContain('@@codeman error first second\n');
  });

  it('says nothing of it to a person at a terminal', () => {
    expect(driveProtocol({ CODEMAN_PROGRESS: '0' }).stderr).not.toContain('@@codeman');
  });

  it('never prints the password', () => {
    expect(mainBody()).not.toMatch(/progress_phase.*PASSWORD/);
    expect(fnBody('error')).not.toMatch(/PASSWORD/);
  });

  function fnBody(name: string) {
    const start = SOURCE.indexOf(`${name}() {`);
    return SOURCE.slice(start, SOURCE.indexOf('\n}\n', start));
  }
});

describe('install.sh detect_all_clis and a disabled entry', () => {
  // No stock entry ships disabled today, so this is characterization rather than a regression
  // pin on real data: it drives the real function in a real bash with entry 0 fabricated
  // disabled, and points its binary at `bash` — guaranteed resolvable via `command -v` — to
  // prove the entry is genuinely never PROBED (CLI_FOUND_PATH stays empty) rather than merely
  // filtered out downstream by every consumer's own `CLI_ENABLED` check.
  function driveDetect(disableEntry0: boolean) {
    const driver = `
      set -euo pipefail
      export CODEMAN_INSTALL_SH_LIB=1
      . "$1"
      k=0; while [[ $k -lt \${#CLI_ALL_BINS[@]} ]]; do CLI_ALL_BINS[$k]="codeman-test-no-such-bin-$k"; k=$((k + 1)); done
      k=0; while [[ $k -lt \${#CLI_ALL_PATHS[@]} ]]; do CLI_ALL_PATHS[$k]="/nonexistent/codeman-test/$k"; k=$((k + 1)); done
      # Point entry 0's first declared binary at something that WILL resolve, so a probe that
      # runs at all finds it.
      CLI_ALL_BINS[\${CLI_BIN_OFF[0]}]="bash"
      ${disableEntry0 ? 'CLI_ENABLED[0]="0"' : ''}
      CLI_DETECT_DONE=""
      detect_all_clis
      echo "path0=[\${CLI_FOUND_PATH[0]}]"
      echo "found=$CLI_FOUND_COUNT"
    `;
    const result = spawnSync('bash', ['-c', driver, 'bash', INSTALL_SH], { encoding: 'utf-8', timeout: 30_000 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('probes an enabled entry (control case)', () => {
    const run = driveDetect(false);
    expect(run.stdout, run.stderr).not.toContain('path0=[]');
    expect(run.stdout).toContain('found=1');
  });

  it('never probes a disabled entry', () => {
    const run = driveDetect(true);
    expect(run.stdout, run.stderr).toContain('path0=[]');
    expect(run.stdout).toContain('found=0');
  });
});

describe('install.sh review fixes for #460', () => {
  // Each pin here is a finding from the two reviews of PR #460 (the DeepSeek Harness
  // pass, then the Claude pass), kept as a static guard so the fix cannot quietly rot.
  const fn = (name: string, until: string) => {
    const start = SOURCE.indexOf(`${name}() {`);
    expect(start, `${name}() missing`).toBeGreaterThan(-1);
    const end = SOURCE.indexOf(until, start);
    expect(end, `${until} missing after ${name}()`).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  };

  it('keeps an existing password on the flag and env preset paths', () => {
    // `--lan --service` on a unit that carried a password used to rewrite it without the
    // password and with the unauthenticated ack; `--tailscale` dropped it the same way.
    const body = fn('choose_network_binding', 'get_tailscale_path() {');
    expect(body.match(/BIND_PASSWORD="\$\{CODEMAN_PASSWORD:-\$EXISTING_PASSWORD\}"/g)?.length).toBe(2);
    expect(body).not.toMatch(/BIND_PASSWORD="\$\{CODEMAN_PASSWORD:-\}"/);
    // The presets can only keep what was read, so the read comes first.
    expect(body.indexOf('read_existing_binding')).toBeLessThan(body.indexOf('CODEMAN_HOST:-'));
  });

  it('composes the hand-start environment in one place', () => {
    // "Do not start" under a sub-path or a custom port used to print a bare `codeman web`
    // under URLs that carried both.
    const hint = fn('start_command_hint', 'export_bind_env() {');
    const exported = fn('export_bind_env', '# A QR code of the URL');
    for (const key of [
      'CODEMAN_HOST',
      'CODEMAN_PASSWORD',
      'CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK',
      'CODEMAN_BASE_URL',
      'CODEMAN_PORT',
    ]) {
      expect(hint, `${key} missing from start_command_hint`).toContain(key);
      expect(exported, `${key} missing from export_bind_env`).toContain(key);
    }
    const done = fn('print_done_screen', '\nupdate() {');
    expect(done).toContain('$(start_command_hint)');
    expect(done).not.toMatch(/CODEMAN_HOST=0\.0\.0\.0 codeman web/);
  });

  it('flips RECONFIGURE for --password and --port', () => {
    // Neither used to, so on a completed install both took the quiet update path, which
    // never rewrites the unit: the password never landed and the port stayed at 3000.
    const parse = fn('parse_flags', '# Sourcing guard');
    for (const label of ['--password)', '--password=*)', '--port)', '--port=*)']) {
      const at = parse.indexOf(label);
      expect(at, `${label} missing`).toBeGreaterThan(-1);
      expect(parse.slice(at, parse.indexOf(';;', at)), `${label} does not reconfigure`).toContain('RECONFIGURE="1"');
    }
  });

  it('ends the sudo keepalive and exports the binding before the exec', () => {
    // exec skips the EXIT trap, and the keepalive keys on $$, which becomes the server's
    // pid: it refreshed the sudo timestamp for the server's whole life.
    const execAt = SOURCE.indexOf('exec node "$INSTALL_DIR/dist/index.js" web');
    expect(execAt).toBeGreaterThan(-1);
    const before = SOURCE.slice(SOURCE.lastIndexOf('source "$profile"', execAt), execAt);
    expect(before).toContain('export_bind_env');
    expect(before).toContain('stop_background_helpers');
  });

  it('lets Ctrl+C skip the HTTPS-toggle poll instead of ending the run', () => {
    const body = fn('ensure_tailnet_https', 'tailnet_https_poll() {');
    expect(body).toMatch(/trap '[^']*' INT/);
    expect(body).toContain('trap - INT');
    expect(fn('tailnet_https_poll', '# Everything Tailscale that needs a human')).toContain('sleep 5 || true');
  });

  it('asks before removing a LaunchDaemon it never wrote', () => {
    const body = fn('uninstall', '\nusage() {');
    const ask = body.indexOf('prompt_yes_no "Remove that LaunchDaemon too');
    expect(ask).toBeGreaterThan(-1);
    expect(body.indexOf('sudo rm -f "$daemon_plist"')).toBeGreaterThan(ask);
  });

  it('re-syncs the unit after `install.sh name` re-adds the mapping, and ends an update on the done screen', () => {
    const name = fn('setup_name_subcommand', '\nstatus_subcommand() {');
    expect(name.indexOf('sync_service_base_url')).toBeGreaterThan(name.indexOf('tailscale_choose_mapping'));
    expect(name.indexOf('sync_service_base_url')).toBeLessThan(name.indexOf('tailscale_apply'));
    expect(fn('update', '\nuninstall() {')).toContain('print_done_screen "" ""');
  });

  it('reads the Tailscale state in the preflight without node, and no longer records TS_JOINED_HERE', () => {
    const preflight = fn('preflight_detect', '\nprint_preflight_summary() {');
    expect(preflight).toContain('ts_backend_state');
    expect(preflight).not.toContain('command -v node');
    expect(fn('ts_backend_state', '\nts_dns_name() {')).toContain('sed -n');
    expect(SOURCE).not.toContain('TS_JOINED_HERE');
    expect(CODE).not.toContain('at port 3000');
  });

  it('drives the kept password and the start line in a real bash', () => {
    const DRIVER = `
      set -euo pipefail
      export CODEMAN_INSTALL_SH_LIB=1
      . "$1"
      read_existing_binding() { EXISTING_FOUND=1; EXISTING_HOST=0.0.0.0; EXISTING_PASSWORD=s3cret; EXISTING_ACK=0; EXISTING_BASE_URL=""; }
      tailscale_prepare() { return 0; }
      parse_flags $DRIVE_FLAGS
      choose_network_binding >/dev/null 2>&1
      echo "host=$BIND_HOST pw=$BIND_PASSWORD ack=$BIND_ACK"
      BIND_HOST=0.0.0.0; BIND_PASSWORD=x; BIND_ACK=0; BIND_BASE_URL=/codeman; CODEMAN_PORT=4000
      echo "hint=$(start_command_hint)"
      BIND_HOST=127.0.0.1; BIND_PASSWORD=""; BIND_BASE_URL=""; CODEMAN_PORT=""
      echo "bare=$(start_command_hint)"
    `;
    const drive = (flags: string) => {
      const env = { ...process.env, DRIVE_FLAGS: flags };
      delete env.CODEMAN_PASSWORD;
      const result = spawnSync('bash', ['-c', DRIVER, 'bash', INSTALL_SH], { encoding: 'utf-8', timeout: 30_000, env });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const lan = drive('--lan');
    expect(lan).toContain('host=0.0.0.0 pw=s3cret ack=0');
    expect(lan).toContain(
      "hint=CODEMAN_HOST=0.0.0.0 CODEMAN_PASSWORD='<your-password>' CODEMAN_BASE_URL=/codeman CODEMAN_PORT=4000 codeman web"
    );
    expect(lan).toContain('bare=codeman web');
    expect(drive('--tailscale')).toContain('host=127.0.0.1 pw=s3cret ack=0');
  });
});

it('install.sh never contains the unauthenticated tunnel opt-in', () => {
  expect(SOURCE).not.toContain('CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL');
  expect(SOURCE).not.toContain('--allow-unauthenticated-tunnel');
});

describe('install.sh no-admin route', () => {
  // The route that installs without administrator rights: Node.js and tmux are downloaded
  // into the home folder, and a machine with no working git gets the source as an archive.
  // What can go wrong here is quiet: a sudo prompt that cannot succeed, a binary unpacked
  // before its checksum was checked, Apple's git stub opening a dialog. So each is pinned.
  const fn = (name: string, until: string) => {
    const start = SOURCE.indexOf(`${name}() {`);
    expect(start, `${name}() missing`).toBeGreaterThan(-1);
    const end = SOURCE.indexOf(until, start);
    expect(end, `${until} missing after ${name}()`).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  };
  const sectionStart = SOURCE.indexOf('# No-admin route: everything into the home folder');
  const sectionEnd = SOURCE.indexOf('# ---- End of the no-admin route');
  const section = SOURCE.slice(sectionStart, sectionEnd);
  const sectionCode = section.split('\n').filter((line) => !/^\s*#/.test(line));

  /** Run a snippet with install.sh sourced as a library, in a real bash. */
  const drive = (script: string, env: NodeJS.ProcessEnv = {}) => {
    const clean = { ...process.env, ...env };
    for (const key of ['CODEMAN_NO_ADMIN', 'CODEMAN_TARBALL_URL', 'CODEMAN_REPO_URL', 'CODEMAN_BRANCH']) {
      if (!(key in env)) delete clean[key];
    }
    const full = `set -euo pipefail\nexport CODEMAN_INSTALL_SH_LIB=1\n. "$1"\n${script}`;
    return spawnSync('bash', ['-c', full, 'bash', INSTALL_SH], { encoding: 'utf-8', timeout: 30_000, env: clean });
  };

  it('has its section markers, in order', () => {
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    expect(sectionCode.length).toBeGreaterThan(100);
  });

  it('never runs sudo, Homebrew or the Xcode tools installer', () => {
    // Command position only: the messages in this section name `brew install tmux` and
    // `apt-get install` as things an administrator can run, which is prose.
    const banned =
      /(?:^|[;&|]|\b(?:if|then|else|do|while|until)\s|!\s)\s*(?:sudo|brew|ensure_sudo|run_as_root|ensure_homebrew|sudo_session_start|sudo_session_try)\b/;
    const offenders = sectionCode.filter((line) => banned.test(line) || /xcode-select\s+--install/.test(line));
    expect(offenders, `privileged call on the no-admin route:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('pins a SHA-256 for every tmux build it can download', () => {
    const digests = fn('tmux_build_sha256', '\n}\n');
    for (const platform of ['linux-x86_64', 'linux-arm64', 'macos-arm64', 'macos-x86_64']) {
      expect(digests, `no digest for ${platform}`).toMatch(new RegExp(`${platform}\\)\\s+printf '[0-9a-f]{64}'`));
      // Every platform the name mapper can produce has a digest, and nothing else does.
      expect(fn('userspace_tmux_platform', '\n}\n')).toContain(`printf '${platform}'`);
    }
    expect(digests.match(/[0-9a-f]{64}/g)?.length).toBe(4);
    // The asset name and URL are built from the same version the digests were taken for.
    const install = fn('install_tmux_userspace', '\n}\n');
    expect(install).toContain('name="tmux-$TMUX_BUILD_VERSION-$platform.tar.gz"');
    expect(install).toContain('tmux-builds/releases/download/v$TMUX_BUILD_VERSION/$name');
  });

  it('checks a download before unpacking or running it', () => {
    for (const name of ['install_node_userspace', 'install_tmux_userspace']) {
      const body = fn(name, '\n}\n');
      const verify = body.indexOf('verify_sha256 "$tmp/$name" "$sha"');
      expect(verify, `${name} never verifies its download`).toBeGreaterThan(-1);
      expect(body.indexOf('tar -xzf'), `${name} unpacks before verifying`).toBeGreaterThan(verify);
    }
    // An empty expected digest must never pass (a lookup that came back with nothing).
    expect(fn('verify_sha256', '\n}\n')).toContain('[[ -n "$want" ]] || return 1');
  });

  it('never executes /usr/bin/git on a Mac before the developer tools are proven', () => {
    // Without the Command Line Tools that path is a stub that opens Apple's install dialog.
    const body = fn('check_git', '\n}\n');
    const apple = body.indexOf('"$git_bin" == "/usr/bin/git"');
    const gate = body.indexOf('xcode-select -p');
    const run = body.indexOf('"$git_bin" --version');
    expect(apple).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(apple);
    // The Apple branch returns on its own evidence; only other gits are executed.
    expect(body.slice(gate, run)).toMatch(/\n\s+return 1\n\s+fi\n/);
  });

  it('judges git by whether it runs', () => {
    const result = drive(`
      bin=$(mktemp -d); trap 'rm -rf "$bin"' EXIT
      printf '#!/bin/sh\\nexit 127\\n' > "$bin/git"; chmod +x "$bin/git"
      PATH="$bin:$PATH"; hash -r
      check_git && echo "broken=present" || echo "broken=missing"
      printf '#!/bin/sh\\nexit 0\\n' > "$bin/git"
      check_git && echo "working=present" || echo "working=missing"
      # A Mac whose only git is Apple's stub, with and without the developer tools.
      uname() { echo Darwin; }
      command() { if [[ "$1" == "-v" && "$2" == "git" ]]; then echo /usr/bin/git; else builtin command "$@"; fi; }
      xcode-select() { return 2; }
      check_git && echo "stub=present" || echo "stub=missing"
      mkdir -p "$bin/dev/usr/bin"; cp "$bin/git" "$bin/dev/usr/bin/git"
      xcode-select() { echo "$bin/dev"; }
      check_git && echo "tools=present" || echo "tools=missing"
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('broken=missing');
    expect(result.stdout).toContain('working=present');
    expect(result.stdout).toContain('stub=missing');
    expect(result.stdout).toContain('tools=present');
  });

  it('decides the route from what the account may do, without asking for a password', () => {
    // `sudo -v` would prompt, and a refused password is reported to the administrator.
    expect(fn('resolve_admin_mode', '\n}\n')).not.toMatch(/sudo -v/);
    const result = drive(`
      [[ $EUID -ne 0 ]] || { echo "skipped=root"; exit 0; }
      has_sudo=1
      command() { if [[ "$1" == "-v" && "$2" == "sudo" ]]; then [[ "$has_sudo" == "1" ]]; elif [[ "$1" == "-v" && "$2" == "brew" ]]; then return 1; else builtin command "$@"; fi; }
      groups="users"; id() { echo "$groups"; }
      sudo_ok=1; sudo() { return "$sudo_ok"; }
      probe() { NO_ADMIN="$1"; NO_ADMIN_REASON=""; resolve_admin_mode; echo "$2=$NO_ADMIN"; }
      uname() { echo Linux; }
      has_sudo=0; probe "" linux_no_sudo; has_sudo=1
      probe "" linux_not_in_group
      groups="users sudo"; probe "" linux_sudo_group
      groups="users wheel"; probe "" linux_wheel_group
      groups="users"; sudo_ok=0; probe "" linux_passwordless; sudo_ok=1
      probe 0 forced_off
      groups="users sudo"; probe 1 forced_on
      uname() { echo Darwin; }
      groups="staff everyone"; probe "" mac_standard
      groups="staff admin"; probe "" mac_admin
    `);
    expect(result.status, result.stderr).toBe(0);
    if (result.stdout.includes('skipped=root')) return;
    for (const expected of [
      'linux_no_sudo=1',
      'linux_not_in_group=1',
      'linux_sudo_group=0',
      'linux_wheel_group=0',
      'linux_passwordless=0',
      'forced_off=0',
      'forced_on=1',
      'mac_standard=1',
      'mac_admin=0',
    ]) {
      expect(result.stdout, result.stdout).toContain(expected);
    }
  });

  it('stops before the first download when the machine cannot finish the install', () => {
    // No compiler on Linux, or a Mac older than the tmux build supports: say so while it
    // costs nothing, not after 50 MB of Node.js.
    const stop = (env: Record<string, string>) => {
      const r = drive(
        `
        NONINTERACTIVE=1; NO_ADMIN=1; NO_ADMIN_REASON=test
        download() { echo "DOWNLOAD $1"; }
        download_to_stdout() { echo "DOWNLOAD $1"; }
        check_node() { return 1; }; check_tmux() { return 1; }; check_git() { return 0; }
        detect_arch() { echo "$DRIVE_ARCH"; }
        check_build_tools() { [[ "$DRIVE_TOOLS" == "1" ]]; }; missing_build_tools() { printf 'make, g++'; }
        macos_major_version() { printf '%s' "$DRIVE_MACOS"; }
        is_musl_libc() { [[ "$DRIVE_MUSL" == "1" ]]; }
        ask_dependencies_no_admin "$DRIVE_OS"
      `,
        { DRIVE_ARCH: 'x64', DRIVE_TOOLS: '1', DRIVE_MACOS: '26', DRIVE_MUSL: '0', ...env }
      );
      expect(r.status, 'the installer must stop').toBe(1);
      expect(r.stdout + r.stderr, 'something was downloaded before the stop').not.toContain('DOWNLOAD');
      return r.stderr;
    };
    expect(stop({ DRIVE_OS: 'linux', DRIVE_TOOLS: '0' })).toMatch(/make, g\+\+[\s\S]*administrator/);
    expect(stop({ DRIVE_OS: 'macos', DRIVE_ARCH: 'arm64', DRIVE_MACOS: '14' })).toMatch(/macOS 15 or newer/);
    expect(stop({ DRIVE_OS: 'linux', DRIVE_MUSL: '1' })).toMatch(/musl/);
    expect(stop({ DRIVE_OS: 'linux', DRIVE_ARCH: 'armv7' })).toMatch(/no Node\.js download/);
  });

  it('picks the right Node.js tarball out of SHASUMS256.txt', () => {
    const sha = (c: string) => c.repeat(64);
    const sums = [
      `${sha('a')}  node-v22.23.4-aix-ppc64.tar.gz`,
      `${sha('b')}  node-v22.23.4-darwin-arm64.tar.gz`,
      `${sha('c')}  node-v22.23.4-darwin-arm64.tar.xz`,
      `${sha('d')}  node-v22.23.4-linux-x64-musl.tar.gz`,
      `${sha('e')}  node-v22.23.4-linux-x64.tar.gz`,
      `nothex  node-v22.23.4-linux-arm64.tar.gz`,
    ].join('\n');
    const result = drive(
      `
      printf '%s\\n' "$SUMS" | pick_node_tarball linux-x64
      printf '%s\\n' "$SUMS" | pick_node_tarball darwin-arm64
      printf '%s\\n' "$SUMS" | pick_node_tarball linux-arm64 || echo "arm64=refused"
      printf '%s\\n' "$SUMS" | pick_node_tarball linux-s390x || echo "s390x=none"
    `,
      { SUMS: sums }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${sha('e')} node-v22.23.4-linux-x64.tar.gz`);
    expect(result.stdout).toContain(`${sha('b')} node-v22.23.4-darwin-arm64.tar.gz`);
    expect(result.stdout).not.toContain('musl');
    // A line whose checksum is not 64 hex digits is not a checksum to trust.
    expect(result.stdout).toContain('arm64=refused');
    expect(result.stdout).toContain('s390x=none');
  });

  it('refuses a download whose checksum does not match', () => {
    const result = drive(`
      f=$(mktemp); trap 'rm -f "$f"' EXIT
      printf 'codeman' > "$f"
      good=$(sha256_file "$f")
      echo "len=\${#good}"
      verify_sha256 "$f" "$good" && echo "match=ok"
      verify_sha256 "$f" "\${good%?}x" && echo "tampered=accepted" || echo "tampered=refused"
      verify_sha256 "$f" "" && echo "empty=accepted" || echo "empty=refused"
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('len=64');
    expect(result.stdout).toContain('match=ok');
    expect(result.stdout).toContain('empty=refused');
    // The last digit swapped for a character no digest contains.
    expect(result.stdout).toContain('tampered=refused');
  });

  it('installs from an archive without git, then replaces that install beside itself', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'codeman-archive-install-'));
    try {
      const make = (version: string) => {
        const tree = join(scratch, `src-${version}`, `Codeman-${version}`);
        mkdirSync(join(tree, 'src'), { recursive: true });
        writeFileSync(join(tree, 'package.json'), `{ "version": "${version}" }\n`);
        writeFileSync(join(tree, 'src', `only-in-${version}.ts`), '');
        const tarball = join(scratch, `${version}.tar.gz`);
        const tar = spawnSync('tar', ['-czf', tarball, '-C', join(scratch, `src-${version}`), `Codeman-${version}`]);
        expect(tar.status, String(tar.stderr)).toBe(0);
        return tarball;
      };
      const first = make('1.0.0');
      const second = make('2.0.0');
      const app = join(scratch, 'app');
      const script = `
        LOG_FILE=/dev/null
        check_git() { return 1; }
        download() { cp "\${1#file://}" "$2"; }
        run_step() { shift; "$@"; }
        install_or_update_repo
        echo "staging=[$SOURCE_STAGING] cwd=$(pwd)"
        finish_source_swap
        echo "after=$(pwd)"
      `;
      const run = (tarball: string) =>
        drive(script, { CODEMAN_INSTALL_DIR: app, CODEMAN_TARBALL_URL: `file://${tarball}`, HOME: scratch });

      // First install: straight into the install directory, marked as an archive install.
      const fresh = run(first);
      expect(fresh.status, fresh.stderr).toBe(0);
      expect(fresh.stdout).toContain('staging=[]');
      expect(readFileSync(join(app, 'package.json'), 'utf-8')).toContain('1.0.0');
      expect(existsSync(join(app, ARCHIVE_INSTALL_MARKER))).toBe(true);

      // Second run: the new tree is built BESIDE the old one, which stays whole until the swap.
      writeFileSync(join(app, 'built-by-1.0.0'), '');
      const update = run(second);
      expect(update.status, update.stderr).toBe(0);
      expect(update.stdout).toContain(`staging=[${app}.new] cwd=${app}.new`);
      expect(update.stdout).toContain(`after=${app}`);
      expect(readFileSync(join(app, 'package.json'), 'utf-8')).toContain('2.0.0');
      // A whole replacement: what the old version had and the new one dropped is gone.
      expect(existsSync(join(app, 'src', 'only-in-1.0.0.ts'))).toBe(false);
      expect(existsSync(join(app, 'built-by-1.0.0'))).toBe(false);
      expect(existsSync(join(app, ARCHIVE_INSTALL_MARKER))).toBe(true);
      expect(existsSync(`${app}.new`)).toBe(false);
      expect(existsSync(`${app}.old`)).toBe(false);

      // A trailing slash on the setting must not put the staging folder inside the install.
      const slashed = drive(script, {
        CODEMAN_INSTALL_DIR: `${app}/`,
        CODEMAN_TARBALL_URL: `file://${first}`,
        HOME: scratch,
      });
      expect(slashed.status, slashed.stderr).toBe(0);
      expect(slashed.stdout).toContain(`staging=[${app}.new] cwd=${app}.new`);
      expect(readFileSync(join(app, 'package.json'), 'utf-8')).toContain('1.0.0');
      expect(existsSync(`${app}.new`)).toBe(false);
      expect(existsSync(`${app}.old`)).toBe(false);

      // A folder that is neither a checkout nor one of ours is never written into.
      const foreign = join(scratch, 'foreign');
      mkdirSync(foreign);
      writeFileSync(join(foreign, 'notes.txt'), 'mine');
      const refused = drive(script, {
        CODEMAN_INSTALL_DIR: foreign,
        CODEMAN_TARBALL_URL: `file://${first}`,
        HOME: scratch,
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('is not a Codeman install');
      expect(readFileSync(join(foreign, 'notes.txt'), 'utf-8')).toBe('mine');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('downloads from a subcommand that never ran the full flow', () => {
    // DOWNLOADER used to be set only by main(), so `install.sh cloudflared` (and now the
    // update of an archive install) died inside download() on an unbound variable.
    const result = drive(`
      unset DOWNLOADER
      curl() { echo "FETCH $*"; }
      wget() { echo "FETCH $*"; }
      download https://example.invalid/a /tmp/never-written
      unset DOWNLOADER
      download_to_stdout https://example.invalid/b
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/FETCH .*example\.invalid\/a/);
    expect(result.stdout).toMatch(/FETCH .*example\.invalid\/b/);
  });

  it('builds the archive URL from the repository and branch, on GitHub only', () => {
    const url = (env: NodeJS.ProcessEnv) => drive('source_tarball_url || echo REFUSED', env).stdout.trim();
    expect(url({})).toBe('https://github.com/Ark0N/Codeman/archive/master.tar.gz');
    expect(url({ CODEMAN_REPO_URL: 'https://github.com/someone/fork.git', CODEMAN_BRANCH: 'feat/x' })).toBe(
      'https://github.com/someone/fork/archive/feat/x.tar.gz'
    );
    expect(url({ CODEMAN_REPO_URL: 'https://gitlab.com/someone/fork.git' })).toBe('REFUSED');
    expect(url({ CODEMAN_REPO_URL: 'git@github.com:someone/fork.git' })).toBe('REFUSED');
    expect(url({ CODEMAN_TARBALL_URL: 'https://mirror.example/codeman.tar.gz' })).toBe(
      'https://mirror.example/codeman.tar.gz'
    );
  });

  it('shares the archive marker name with the in-app updater', () => {
    // install.sh writes it, src/web/self-update.ts reads it to tell such an install how to
    // update. A rename on one side would send archive installs back to the npm advice.
    expect(SOURCE).toContain(`SOURCE_MARKER="${ARCHIVE_INSTALL_MARKER}"`);
  });

  it('treats a completed archive install as an install: quiet update on a re-run', () => {
    const dispatch = SOURCE.slice(SOURCE.indexOf('\nparse_flags "$@"'));
    expect(dispatch).toMatch(
      /-f "\$INSTALL_DIR\/\.install-complete" \]\] && \[\[ -d "\$INSTALL_DIR\/\.git" \|\| -f "\$INSTALL_DIR\/\$SOURCE_MARKER" \]\]/
    );
    const update = fn('update', '\nuninstall() {');
    expect(update).toContain('! -f "$INSTALL_DIR/$SOURCE_MARKER"');
    // The swap happens only after the build has succeeded.
    expect(update.indexOf('finish_source_swap')).toBeGreaterThan(update.indexOf('npm run build'));
    const main = fn(
      'main',
      '\n# ----------------------------------------------------------------------------\n# Phase 0'
    );
    expect(main.indexOf('finish_source_swap')).toBeGreaterThan(main.indexOf('npm run build'));
    expect(main.indexOf('finish_source_swap')).toBeLessThan(main.indexOf('install_symlink'));
  });

  it('documents --no-admin where people look for flags, and resolves the route before any work', () => {
    expect(fn('usage', '\n}\n')).toContain('--no-admin');
    const dispatch = SOURCE.slice(SOURCE.indexOf('\nparse_flags "$@"'));
    expect(dispatch.indexOf('resolve_admin_mode')).toBeGreaterThan(-1);
    expect(dispatch.indexOf('resolve_admin_mode')).toBeLessThan(dispatch.lastIndexOf('case "$SUBCOMMAND" in'));
    expect(dispatch.indexOf('adopt_userspace_runtime')).toBeLessThan(dispatch.indexOf('resolve_admin_mode'));
  });

  it('puts the downloaded runtime on the LaunchAgent PATH', () => {
    // The agent's PATH is a fixed list (Homebrew, /usr/local, ~/.local/bin, the system). A
    // Node.js in the home folder is outside it, and so is everything `npm install -g` puts
    // beside that Node.js: the AI CLIs, whose launchers start with `#!/usr/bin/env node`.
    // A machine with a real LaunchDaemon makes the function stand down, so skip there.
    if (existsSync('/Library/LaunchDaemons/com.codeman.web.plist')) return;
    const home = mkdtempSync(join(tmpdir(), 'codeman-agent-path-'));
    const result = drive(
      `
      mkdir -p "$RUNTIME_DIR/node/bin" "$RUNTIME_DIR/bin" "$HOME/.local/bin"
      printf '#!/bin/sh\n' > "$RUNTIME_DIR/node/bin/node"; chmod +x "$RUNTIME_DIR/node/bin/node"
      printf '#!/bin/sh\n' > "$RUNTIME_DIR/bin/tmux"; chmod +x "$RUNTIME_DIR/bin/tmux"
      ln -s "$RUNTIME_DIR/node/bin/node" "$HOME/.local/bin/node"
      PATH="$HOME/.local/bin:$PATH"; hash -r
      launchctl() { return 0; }
      sleep() { :; }
      BIND_HOST=127.0.0.1
      setup_launchd_service >/dev/null 2>&1
      cat "$HOME/Library/LaunchAgents/com.codeman.web.plist"
    `,
      { HOME: home }
    );
    rmSync(home, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
    const path = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(result.stdout)?.[1] ?? '';
    const dirs = path.split(':');
    expect(dirs).toContain(`${home}/.codeman/runtime/node/bin`);
    expect(dirs).toContain(`${home}/.codeman/runtime/bin`);
    expect(dirs).toContain(`${home}/.local/bin`);
    expect(dirs).toContain('/usr/bin');
    expect(new Set(dirs).size, `duplicate PATH entries: ${path}`).toBe(dirs.length);
    expect(result.stdout).toContain(`<string>${home}/.local/bin/node</string>`);
  });

  it('links only into its own runtime, and removes only its own links', () => {
    // ~/.local/bin is the user's folder: a tmux or node they put there is never replaced on
    // install and never deleted on uninstall.
    const home = mkdtempSync(join(tmpdir(), 'codeman-links-'));
    const result = drive(
      `
      mkdir -p "$HOME/.local/bin" "$RUNTIME_DIR/bin"
      touch "$RUNTIME_DIR/bin/tmux" "$RUNTIME_DIR/bin/node"
      printf 'mine' > "$HOME/.local/bin/tmux"
      link_into_local_bin "$RUNTIME_DIR/bin/tmux" tmux && echo "foreign=replaced" || echo "foreign=kept"
      link_into_local_bin "$RUNTIME_DIR/bin/node" node && echo "fresh=linked"
      link_into_local_bin "$RUNTIME_DIR/bin/node" node && echo "ours=relinked"
      echo "tmux=$(cat "$HOME/.local/bin/tmux") node=$(readlink "$HOME/.local/bin/node")"
    `,
      { HOME: home }
    );
    rmSync(home, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('foreign=kept');
    expect(result.stdout).toContain('fresh=linked');
    expect(result.stdout).toContain('ours=relinked');
    expect(result.stdout).toMatch(/tmux=mine node=.*\/\.codeman\/runtime\/bin\/node/);

    const body = fn('uninstall', '\nusage() {');
    const rm = body.indexOf('rm -f "$symlink_dir/$runtime_tool"');
    expect(rm).toBeGreaterThan(-1);
    expect(body.slice(body.lastIndexOf('if [[', rm), rm)).toContain('== "$RUNTIME_DIR/"*');
  });

  it('says the rights were not confirmed, and names the way back to sudo, when it chose this route itself', () => {
    // A sudoers entry cannot be read without a probe that reports to the administrator, so an
    // account listed by name, with a password, lands on this route too. It must not be told it
    // may not use sudo, and every place that ends or sums up the route must name the override.
    const stops = `
      detect_arch() { echo x64; }
      download() { echo "DOWNLOAD $1"; }; download_to_stdout() { echo "DOWNLOAD $1"; }
      check_node() { return 1; }; check_tmux() { return 1; }; check_git() { return 0; }
      missing_build_tools() { printf 'make'; }; is_musl_libc() { return 1; }
      ts_cmd() { return 1; }; check_tailscale() { return 1; }
      CLI_IDS=(); TS_STATE=""; MISSING_PKGS=""; EXISTING_FOUND=""; EXISTING_VERSION=""
      section() { echo "== $1"; }
      NONINTERACTIVE=1
      section blocker; check_build_tools() { return 1; }; (ask_dependencies_no_admin linux) 2>&1 || true
      check_build_tools() { return 0; }
      section declined; prompt_yes_no() { return 1; }; (ask_dependencies_no_admin linux) 2>&1 || true
      section ensure_sudo; (ensure_sudo) 2>&1 || true
      section operator; (ensure_tailscale_operator) 2>&1 || true
      section summary; (print_preflight_summary linux x64 ubuntu) 2>&1
      NONINTERACTIVE=0
      section tailscale; (offer_install_tailscale) 2>&1 || true
    `;
    const sections = (stdout: string) =>
      Object.fromEntries(
        stdout
          .split(/^== /m)
          .slice(1)
          .map((part) => [part.slice(0, part.indexOf('\n')), part])
      );
    const detected = drive(`
      [[ $EUID -ne 0 ]] || { echo "skipped=root"; exit 0; }
      uname() { echo Linux; }
      command() { if [[ "$1" == "-v" && "$2" == "sudo" ]]; then return 0; else builtin command "$@"; fi; }
      id() { echo users; }
      sudo() { return 1; }
      NO_ADMIN=""; resolve_admin_mode
      echo "route=$NO_ADMIN reason=$NO_ADMIN_REASON"
      ${stops}
    `);
    expect(detected.status, detected.stderr).toBe(0);
    if (detected.stdout.includes('skipped=root')) return;
    expect(detected.stdout).toMatch(/route=1 reason=.*could not confirm/);
    expect(detected.stdout).not.toContain('may not use sudo');
    const parts = sections(detected.stdout);
    for (const name of ['blocker', 'declined', 'ensure_sudo', 'operator', 'summary', 'tailscale']) {
      expect(parts[name], `${name}: ${detected.stdout}`).toContain('CODEMAN_NO_ADMIN=0');
    }

    // Asked for, or sudo really tried: there is no way back to name.
    for (const reason of ['--no-admin', 'sudo is not installed', 'sudo was refused']) {
      const other = drive(`
        uname() { echo Linux; }
        NO_ADMIN=1; NO_ADMIN_REASON="${reason}"
        ${stops}
      `);
      expect(other.status, other.stderr).toBe(0);
      expect(other.stdout, reason).not.toContain('CODEMAN_NO_ADMIN=0');
    }
  });

  it('proves a downloaded tmux and cloudflared in the home folder, not in the temp folder', () => {
    // /tmp is commonly mounted noexec on the shared hosts this route is for. The stand-in
    // below refuses to run from TMPDIR the way such a mount does (126, not a shell error).
    const home = mkdtempSync(join(tmpdir(), 'codeman-noexec-'));
    try {
      const noexec = join(home, 'noexec-tmp');
      const fake = join(home, 'fake');
      mkdirSync(noexec);
      mkdirSync(fake);
      for (const tool of ['tmux', 'cloudflared']) {
        writeFileSync(join(fake, tool), `#!/bin/sh\ncase "$0" in "${noexec}"/*) exit 126 ;; esac\necho ok\n`, {
          mode: 0o755,
        });
      }
      const tarball = join(home, 'tmux.tar.gz');
      const tar = spawnSync('tar', ['-czf', tarball, '-C', fake, 'tmux']);
      expect(tar.status, String(tar.stderr)).toBe(0);
      const result = drive(
        `
        run_step() { shift; "$@"; }
        ensure_on_path() { :; }
        tmux_build_sha256() { sha256_file "$DRIVE_FAKE/../tmux.tar.gz"; }
        download() { case "$1" in *tmux*) cp "$DRIVE_FAKE/../tmux.tar.gz" "$2" ;; *) cp "$DRIVE_FAKE/cloudflared" "$2" ;; esac; }
        (install_tmux_userspace linux x64) && echo "tmux=installed"
        (install_cloudflared_userspace linux x64) && echo "cloudflared=installed"
        ls -A "$RUNTIME_DIR" | tr '\n' ' '; echo
        ls -A "$HOME/.local" | tr '\n' ' '; echo
        ls -A "$HOME/.local/bin" | tr '\n' ' '; echo
      `,
        { HOME: home, TMPDIR: noexec, DRIVE_FAKE: fake }
      );
      expect(result.stderr).not.toContain('does not run');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('tmux=installed');
      expect(result.stdout).toContain('cloudflared=installed');
      expect(existsSync(join(home, '.codeman/runtime/bin/tmux'))).toBe(true);
      expect(existsSync(join(home, '.local/bin/cloudflared'))).toBe(true);
      // Nothing left beside them: the listings hold the final names and nothing else.
      const [runtime, local, bin] = result.stdout.trim().split('\n').slice(-3);
      expect(runtime.trim()).toBe('bin');
      expect(local.trim()).toBe('bin');
      expect(bin.trim().split(' ').sort()).toEqual(['cloudflared', 'tmux']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('survives an environment with no USER', () => {
    // docker run -u gives a process no USER, and set -u turns a message that prints it into a
    // crash. The no-admin route reaches several such lines, and such a container is its first home.
    const result = drive(
      `
      uname() { echo Linux; }
      NO_ADMIN=1; NO_ADMIN_REASON=test; NONINTERACTIVE=0
      ts_cmd() { return 1; }; check_tailscale() { return 1; }
      (ensure_tailscale_operator) 2>&1 || true
      (offer_install_tailscale) 2>&1 || true
      BIND_HOST=0.0.0.0; BIND_PASSWORD=""
      (print_security_notice) 2>&1
    `,
      { USER: undefined }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('unbound variable');
    expect(result.stdout.match(/--operator=\S/g)?.length).toBe(2);
  });

  it('drops a trailing slash from CODEMAN_INSTALL_DIR', () => {
    // "$INSTALL_DIR.new" must sit beside the install, and app/.new sits inside it.
    const dir = (value: string) => drive('echo "$INSTALL_DIR"', { CODEMAN_INSTALL_DIR: value }).stdout.trim();
    expect(dir('/x/app/')).toBe('/x/app');
    expect(dir('/x/app//')).toBe('/x/app');
    expect(dir('/x/app')).toBe('/x/app');
    expect(dir('/')).toBe('/');
  });

  it('warns that removing the data directory takes a kept runtime with it', () => {
    // The runtime lives inside ~/.codeman, so the yes to the data directory removes what the
    // user chose to keep one prompt earlier. Read from the source, never driven: uninstall()
    // calls `systemctl --user`, which HOME does not redirect, so a drive stops and disables
    // the real codeman-web of whoever runs this test.
    const body = fn('uninstall', '\nusage() {');
    const prompt = body.indexOf('Remove data directory ($data_dir)?');
    expect(prompt).toBeGreaterThan(-1);
    const note = body.lastIndexOf('[[ -d "$RUNTIME_DIR" ]]', prompt);
    expect(note, 'the kept runtime is not looked at before that prompt').toBeGreaterThan(
      body.indexOf('Kept $RUNTIME_DIR')
    );
    expect(body.slice(note, prompt)).toMatch(/data_note=" .*\$RUNTIME_DIR/);
    expect(body.slice(prompt)).toMatch(/^Remove data directory \(\$data_dir\)\?\$data_note"/);
  });
});
