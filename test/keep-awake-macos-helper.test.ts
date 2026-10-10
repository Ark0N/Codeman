/**
 * @fileoverview Runs the real macOS lid helper (scripts/keep-awake-macos.sh) in bash
 * against a stub `pmset` that records what it was asked to do. The helper runs as root
 * from a LaunchDaemon, so the cases that matter are the ones where it must NOT act: a
 * stale, dead, foreign or symlinked request, and an administrator's own
 * `disablesleep 1`, which it must never switch off.
 *
 * Only the BSD/GNU-portable tools the script uses (find -mmin, ps -o uid=, ls -ln) run
 * here, so this passes on Linux and macOS alike. Port: none.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HELPER = fileURLToPath(new URL('../scripts/keep-awake-macos.sh', import.meta.url));

let dir: string;
let stateDir: string;
let request: string;

/** Stub pmset: `-g` prints the stored SleepDisabled, `-a disablesleep N` stores N and logs it. */
function writeStubPmset(initial: '0' | '1' | null) {
  const value = join(dir, 'sleepdisabled');
  if (initial !== null) writeFileSync(value, initial);
  const stub = join(dir, 'pmset');
  writeFileSync(
    stub,
    `#!/bin/bash
if [ "$1" = "-g" ]; then
  echo "System-wide power settings:"
  [ -f "${value}" ] && printf ' SleepDisabled\\t\\t%s\\n' "$(cat "${value}")"
  echo "Currently in use:"
  echo " sleep                1"
  exit 0
fi
if [ "$1" = "-a" ] && [ "$2" = "disablesleep" ]; then
  printf '%s' "$3" > "${value}"
  echo "disablesleep $3" >> "${join(dir, 'pmset.log')}"
  exit 0
fi
exit 1
`
  );
  chmodSync(stub, 0o755);
  return stub;
}

function run() {
  const result = spawnSync('bash', [HELPER, request], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CODEMAN_KEEPAWAKE_PMSET: join(dir, 'pmset'),
      CODEMAN_KEEPAWAKE_STATE_DIR: stateDir,
    },
  });
  expect(result.status, result.stderr).toBe(0);
}

const calls = () => (existsSync(join(dir, 'pmset.log')) ? readFileSync(join(dir, 'pmset.log'), 'utf-8') : '');
const sleepDisabled = () => readFileSync(join(dir, 'sleepdisabled'), 'utf-8');
const owned = () => existsSync(join(stateDir, 'keep-awake.owned'));
const requestFromLiveServer = () => writeFileSync(request, `${process.pid}\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keep-awake-helper-'));
  stateDir = join(dir, 'state');
  request = join(dir, 'keep-awake-lid.pid');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('keep-awake-macos.sh', () => {
  it('does nothing without a request', () => {
    writeStubPmset('0');
    run();
    expect(calls()).toBe('');
    expect(owned()).toBe(false);
  });

  it('applies disablesleep for a fresh request from a live process, then undoes it when the request goes', () => {
    writeStubPmset('0');
    requestFromLiveServer();
    run();
    expect(sleepDisabled()).toBe('1');
    expect(owned()).toBe(true);

    run(); // steady state: no repeated pmset call
    expect(calls()).toBe('disablesleep 1\n');

    rmSync(request);
    run();
    expect(sleepDisabled()).toBe('0');
    expect(owned()).toBe(false);
    expect(calls()).toBe('disablesleep 1\ndisablesleep 0\n');
  });

  it("never switches off an administrator's own disablesleep", () => {
    writeStubPmset('1');
    requestFromLiveServer();
    run();
    expect(calls()).toBe('');
    expect(owned()).toBe(false);
    rmSync(request);
    run();
    expect(sleepDisabled()).toBe('1');
    expect(calls()).toBe('');
  });

  it('treats an absent SleepDisabled line as 0', () => {
    writeStubPmset(null);
    requestFromLiveServer();
    run();
    expect(sleepDisabled()).toBe('1');
    expect(owned()).toBe(true);
  });

  it('re-applies after a reboot or OS update reset it, while the request stands', () => {
    writeStubPmset('0');
    requestFromLiveServer();
    run();
    writeFileSync(join(dir, 'sleepdisabled'), '0'); // the reset
    run();
    expect(sleepDisabled()).toBe('1');
  });

  it('ignores a stale request (a crashed or hung server) and releases', () => {
    writeStubPmset('0');
    requestFromLiveServer();
    run();
    expect(sleepDisabled()).toBe('1');
    const threeMinutesAgo = (Date.now() - 3 * 60_000) / 1000;
    utimesSync(request, threeMinutesAgo, threeMinutesAgo);
    run();
    expect(sleepDisabled()).toBe('0');
    expect(owned()).toBe(false);
  });

  it('ignores a request whose pid is not running', () => {
    writeStubPmset('0');
    const gone = spawnSync('true').pid;
    writeFileSync(request, `${gone}\n`);
    run();
    expect(calls()).toBe('');
  });

  it('ignores garbage and refuses a symlinked request', () => {
    writeStubPmset('0');
    writeFileSync(request, 'not-a-pid\n');
    run();
    expect(calls()).toBe('');

    rmSync(request);
    const real = join(dir, 'elsewhere.pid');
    writeFileSync(real, `${process.pid}\n`);
    symlinkSync(real, request);
    run();
    expect(calls()).toBe('');
  });
});
