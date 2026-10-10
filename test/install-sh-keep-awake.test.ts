/**
 * @fileoverview install.sh's keep-awake follow-up, driven in a real bash where it can be
 * (laptop detection over a fake sysfs, the settings.json write, the --yes default) and
 * pinned statically where it cannot (the macOS root helper needs sudo and launchd).
 *
 * The rules: never turned on by --yes or a headless run; the setting is written before
 * the service starts; the root helper runs from a ROOT-OWNED copy, never from the
 * user-writable install dir; uninstall undoes only what the helper set.
 *
 * Port: none.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const INSTALL_SH = fileURLToPath(new URL('../install.sh', import.meta.url));
const SOURCE = readFileSync(INSTALL_SH, 'utf-8');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-keep-awake-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Source install.sh (library mode) in a real bash with HOME in the temp dir, then run `body`. */
function drive(body: string, env: Record<string, string> = {}) {
  const script = `
    set -euo pipefail
    export CODEMAN_INSTALL_SH_LIB=1
    . "$1"
    ${body}
  `;
  const result = spawnSync('bash', ['-c', script, 'bash', INSTALL_SH], {
    encoding: 'utf-8',
    timeout: 30_000,
    input: '',
    env: { ...process.env, HOME: join(dir, 'home'), ...env },
  });
  return result;
}

function fakeSupply(name: string, files: Record<string, string>) {
  const d = join(dir, 'ps', name);
  mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), `${v}\n`);
}

const laptopCheck = `
  POWER_SUPPLY_ROOT="${'$'}FAKE_PS"; LID_BUTTON_ROOT="${'$'}FAKE_LID"
  if is_laptop linux; then echo laptop; else echo desktop; fi
`;

describe('is_laptop (Linux)', () => {
  const run = () => drive(laptopCheck, { FAKE_PS: join(dir, 'ps'), FAKE_LID: join(dir, 'lid') }).stdout.trim();

  it('a machine with no battery and no lid is not a laptop', () => {
    mkdirSync(join(dir, 'ps'), { recursive: true });
    fakeSupply('AC', { type: 'Mains', online: '1' });
    expect(run()).toBe('desktop');
  });

  it("a wireless mouse's battery does not make a desktop a laptop", () => {
    fakeSupply('hidpp_battery_0', { type: 'Battery', scope: 'Device', status: 'Discharging' });
    expect(run()).toBe('desktop');
  });

  it('a system battery or a lid does', () => {
    fakeSupply('BAT0', { type: 'Battery', status: 'Charging' });
    expect(run()).toBe('laptop');
    rmSync(join(dir, 'ps'), { recursive: true });
    mkdirSync(join(dir, 'lid', 'LID0'), { recursive: true });
    expect(run()).toBe('laptop');
  });

  it('copes with a missing power_supply tree', () => {
    expect(run()).toBe('desktop');
  });
});

describe('write_keep_awake_setting', () => {
  const settings = () => join(dir, 'home', '.codeman', 'settings.json');

  it('creates settings.json with the setting on and AC-only on', () => {
    const r = drive('write_keep_awake_setting');
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(settings(), 'utf-8'))).toEqual({ keepAwakeEnabled: true, keepAwakeAcOnly: true });
  });

  it('keeps every other key, and an explicit AC-only choice', () => {
    mkdirSync(join(dir, 'home', '.codeman'), { recursive: true });
    writeFileSync(settings(), JSON.stringify({ theme: 'dark', keepAwakeAcOnly: false }, null, 2));
    expect(drive('write_keep_awake_setting').status).toBe(0);
    expect(JSON.parse(readFileSync(settings(), 'utf-8'))).toEqual({
      theme: 'dark',
      keepAwakeAcOnly: false,
      keepAwakeEnabled: true,
    });
  });

  it('leaves a settings file that does not parse untouched', () => {
    mkdirSync(join(dir, 'home', '.codeman'), { recursive: true });
    writeFileSync(settings(), '{ not json');
    const r = drive('write_keep_awake_setting || echo refused');
    expect(r.stdout).toContain('refused');
    expect(readFileSync(settings(), 'utf-8')).toBe('{ not json');
  });

  it('is what keep_awake_enabled_now reads back', () => {
    const r = drive(
      'keep_awake_enabled_now && echo before; write_keep_awake_setting >/dev/null 2>&1; keep_awake_enabled_now && echo after'
    );
    expect(r.stdout.trim()).toBe('after');
  });
});

describe('choose_keep_awake', () => {
  it('--yes on a laptop never turns it on', () => {
    fakeSupply('BAT0', { type: 'Battery', status: 'Charging' });
    const r = drive(
      `POWER_SUPPLY_ROOT="$FAKE_PS"; ASSUME_YES=1
       choose_keep_awake linux
       echo "keep=[$KEEP_AWAKE] helper=[$KEEP_AWAKE_LID_HELPER]"`,
      { FAKE_PS: join(dir, 'ps') }
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('keep=[] helper=[]');
  });

  it('asks nothing on a desktop', () => {
    const r = drive(
      `POWER_SUPPLY_ROOT="$FAKE_PS"; LID_BUTTON_ROOT="$FAKE_PS"
       choose_keep_awake linux 2>&1
       echo "keep=[$KEEP_AWAKE]"`,
      { FAKE_PS: join(dir, 'nothing') }
    );
    expect(r.stdout.trim()).toBe('keep=[]');
  });

  it('only notes an existing setting, without re-asking', () => {
    mkdirSync(join(dir, 'home', '.codeman'), { recursive: true });
    writeFileSync(join(dir, 'home', '.codeman', 'settings.json'), JSON.stringify({ keepAwakeEnabled: true }, null, 2));
    const r = drive(`choose_keep_awake linux force 2>&1; echo "keep=[$KEEP_AWAKE]"`);
    expect(r.stdout).toContain('already on');
    expect(r.stdout).toContain('keep=[]');
  });

  it('defaults to no in the prompt itself', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('choose_keep_awake() {'), SOURCE.indexOf('write_keep_awake_setting() {'));
    expect(fn).toMatch(/prompt_yes_no "Keep this machine awake[^"]*" "n"/);
    // The sudo-needing helper is offered only to a person at a terminal.
    expect(fn).toMatch(/"\$NONINTERACTIVE" != "1" && "\$ASSUME_YES" != "1" \]\] && has_tty/);
  });
});

describe('install.sh keep-awake wiring', () => {
  const fn = (name: string, next: string) => SOURCE.slice(SOURCE.indexOf(`${name}() {`), SOURCE.indexOf(next));

  it('asks after question 3 and applies before the service starts', () => {
    const main = fn('main', '\npreflight_detect() {');
    const ask = main.indexOf('choose_keep_awake "$os"');
    const apply = main.indexOf('apply_keep_awake');
    expect(ask).toBeGreaterThan(main.indexOf('choose_launch_mode "$os"'));
    expect(ask).toBeLessThan(main.indexOf('install_or_update_repo'));
    expect(apply).toBeGreaterThan(main.indexOf('run_step "Building Codeman"'));
    expect(apply).toBeLessThan(main.indexOf('setup_launchd_service'));
    expect(apply).toBeLessThan(main.indexOf('setup_systemd_service'));
  });

  it('runs the root helper from a root-owned copy, never from the install dir', () => {
    const body = fn('install_keep_awake_lid_helper', '\nremove_keep_awake_lid_helper() {');
    expect(body).toContain('install -m 755 -o root -g wheel "$src" "$script"');
    expect(body).toContain('local script="$KEEP_AWAKE_HELPER_DIR/keep-awake-macos.sh"');
    const programArgs = body.slice(body.indexOf('<key>ProgramArguments</key>'), body.indexOf('</array>'));
    expect(programArgs).toContain('$(xml_escape "$script")');
    expect(programArgs).not.toContain('INSTALL_DIR');
    // The request path must match what the server writes (dataPath('keep-awake-lid.pid')).
    expect(body).toContain('local request="$HOME/.codeman/keep-awake-lid.pid"');
  });

  it('uninstall removes the helper and undoes only a disablesleep it set', () => {
    expect(fn('uninstall', '\nusage() {')).toContain('remove_keep_awake_lid_helper');
    const remove = fn('remove_keep_awake_lid_helper', '\napply_keep_awake() {');
    const owned = remove.indexOf('keep-awake.owned');
    expect(owned).toBeGreaterThan(-1);
    expect(remove.indexOf('pmset -a disablesleep 0')).toBeGreaterThan(owned);
  });

  it('dispatches the keep-awake subcommand and documents it', () => {
    expect(SOURCE).toMatch(/update\|uninstall\|tailscale\|name\|status\|cloudflared\|keep-awake\)/);
    expect(SOURCE).toMatch(/\n {4}keep-awake\) {2}keep_awake_subcommand ;;/);
    const header = SOURCE.slice(0, SOURCE.indexOf('set -euo pipefail'));
    expect(header).toContain('install.sh keep-awake');
    expect(fn('usage', '\nparse_flags() {')).toContain('keep-awake');
  });

  it('update and keep-awake share one restart path', () => {
    expect(fn('update', '\nuninstall() {')).toContain('restart_running_service');
    expect(fn('keep_awake_subcommand', '\nverify_systemd_active() {')).toContain('restart_running_service');
  });
});
