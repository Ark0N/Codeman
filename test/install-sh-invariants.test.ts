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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

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
