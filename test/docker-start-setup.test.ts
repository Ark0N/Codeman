/**
 * @fileoverview The Docker Compose deployment's first-run path: what
 * `docker/Start-Codeman.sh` does on a machine that has never run it.
 *
 * 1. Preflight: a missing `docker`, a missing or too-old Compose plugin and an
 *    unreachable daemon each stop the script with the fix named, before any
 *    question is asked or any file is written. The permission case points at
 *    the docker group, never at sudo (a root run cannot do the first-run setup).
 * 2. Setup: with no `docker/.env`, the script writes one generated FROM
 *    `.env.example`, so every key the example sets is present. That is the
 *    exact check the in-app updater runs (`diffRequiredEnvKeys`), and a
 *    generated file missing a key would block the user's next update. The file
 *    is 0600, the generated password is alphanumeric (Compose's dotenv
 *    interpolates `$` and treats ` #` as a comment) and shown only on a
 *    terminal, and a data folder that would collide with a native install's
 *    `~/.codeman`, `$HOME` itself or the image build context is refused.
 * 3. An existing `docker/.env` is never rewritten: the update path
 *    (Update-Codeman.sh hands off to this script) must stay byte-for-byte.
 * 4. A `.env` still carrying the example password `changeme` is refused before
 *    anything is built or started.
 *
 * Runs the REAL script against a stub `docker` on PATH with stdin not a TTY,
 * which is also the "no terminal attached, take the defaults" path. The tests
 * of the questions themselves run on a real pty.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:net';
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
  lstatSync,
  existsSync,
  symlinkSync,
  readdirSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffRequiredEnvKeys, parseEnvKeys } from '../src/web/self-update.js';

const ROOT = process.cwd();
const startScript = readFileSync(join(ROOT, 'docker/Start-Codeman.sh'), 'utf-8');
const updateScript = readFileSync(join(ROOT, 'docker/Update-Codeman.sh'), 'utf-8');
const example = readFileSync(join(ROOT, 'docker/.env.example'), 'utf-8');
const compose = readFileSync(join(ROOT, 'docker/docker-compose.yaml'), 'utf-8');
/** Absolute, so a run whose PATH deliberately lacks most tools can still start bash. */
const BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf-8' }).trim();

/** The run on a real terminal needs util-linux `script`; BSD's takes different arguments. */
const HAS_PTY = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;

/** The values the first run fills in; every other line must be the example's. */
const REWRITTEN_KEYS = ['TZ', 'CODEMAN_APPDATA_PATH', 'CODEMAN_CASES_PATH', 'CODEMAN_PORT', 'CODEMAN_PASSWORD'];

/**
 * A stub `docker` that logs every invocation and answers the calls the script
 * makes. `compose ... config --environment` sources the env file and prints the
 * keys the script reads, with the shell environment beating the file as it does
 * in Compose. Bash reads a single-quoted value the way Compose's dotenv does
 * except for a backslash before the closing quote: see `composeReads`.
 */
const STUB = [
  '#!/usr/bin/env bash',
  'echo "docker $*" >> "$CMDLOG"',
  // Docker CLI 24 to 27 answer `info --format` with exit 0 and the error on
  // stderr when the daemon is unreachable (measured on 27.5.1); `version --format`
  // exits 1 on every release.
  'if [[ "$1" == "info" ]]; then',
  '  if [[ -n "${STUB_DAEMON_ERR:-}" ]]; then echo "$STUB_DAEMON_ERR" >&2; exit 0; fi',
  '  echo 27.0.0; exit 0',
  'fi',
  'if [[ "$1" == "version" ]]; then',
  '  if [[ -n "${STUB_DAEMON_ERR:-}" ]]; then echo "$STUB_DAEMON_ERR" >&2; exit 1; fi',
  '  echo 27.0.0; exit 0',
  'fi',
  'if [[ "$1" == "compose" ]]; then',
  '  if [[ -n "${STUB_NO_COMPOSE:-}" ]]; then echo "docker: unknown command: docker compose" >&2; exit 1; fi',
  '  if [[ "$2" == "version" ]]; then',
  '    if [[ "${3:-}" == "--short" ]]; then echo "${STUB_COMPOSE_VERSION:-2.30.0}"; else echo "Docker Compose version v${STUB_COMPOSE_VERSION:-2.30.0}"; fi',
  '    exit 0',
  '  fi',
  '  prev=""; envfile=""',
  '  for a in "$@"; do',
  '    if [[ "$prev" == "--env-file" ]]; then envfile="$a"; fi',
  '    prev="$a"',
  '  done',
  '  if [[ " $* " == *" config "* && " $* " == *" --environment "* ]]; then',
  '    keys="CODEMAN_APPDATA_PATH CODEMAN_CASES_PATH DOCKER_SOCKET CODEMAN_PORT CODEMAN_USERNAME CODEMAN_PASSWORD"',
  '    for k in $keys; do if [[ -n "${!k+x}" ]]; then printf -v "shell_$k" %s "${!k}"; fi; done',
  '    set -a; source "$envfile"; set +a',
  '    DOCKER_SOCKET="${STUB_DOCKER_SOCKET:-$DOCKER_SOCKET}"',
  '    for k in $keys; do',
  '      shell="shell_$k"',
  '      printf "%s=%s\\n" "$k" "${!shell-${!k}}"',
  '    done',
  '    exit 0',
  '  fi',
  '  if [[ " $* " == *" config "* && " $* " == *" --format json "* ]]; then printf \'{\\n  "name": "codeman"\\n}\\n\'; exit 0; fi',
  '  if [[ " $* " == *" up "* && -n "${STUB_UP_FAIL:-}" ]]; then echo "network error pulling a layer" >&2; exit 1; fi',
  '  if [[ " $* " == *" ps -q codeman "* ]]; then echo cid123; exit 0; fi',
  '  if [[ " $* " == *" port codeman "* ]]; then echo "0.0.0.0:${@: -1}"; exit 0; fi',
  '  if [[ " $* " == *" logs "* ]]; then echo "FAKE-LOG: server crashed"; exit 0; fi',
  '  exit 0',
  'fi',
  'if [[ "$1" == "inspect" ]]; then echo "${STUB_STATE:-running|healthy|0}"; exit 0; fi',
  'if [[ "$1" == "exec" ]]; then exit 1; fi',
  'exit 0',
].join('\n');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  log: string[];
  env: string | null;
  envMode: number | null;
  home: string;
  dir: string;
  /** What was in HOME when the run ended; the sandbox is gone by the time a test reads this. */
  homeEntries: string[];
  /** What `docker/.env` is when the run ended, without following a symlink. */
  envKind: 'file' | 'directory' | 'symlink' | null;
  /** What a `docker/.env` that is a directory holds. */
  envDirEntries: string[];
}

/**
 * Lays out `<dir>/repo/docker/{Start-Codeman.sh,.env.example,docker-compose.yaml}`
 * plus a stub `docker`, runs the script with a temp HOME and stdin closed (not a
 * TTY), and returns what happened. `existingEnv` seeds `docker/.env` first.
 */
function runStart(
  args: string[],
  opts: {
    env?: Record<string, string>;
    existingEnv?: string;
    /** Makes `docker/.env` something other than a regular file. */
    envShape?: 'directory' | 'dangling-symlink' | 'symlink-to-file';
    noDocker?: boolean;
    /** A real Unix socket to use as DOCKER_SOCKET (the start path checks `-S`). */
    socket?: string;
    /** Run Update-Codeman.sh (which hands off to Start-Codeman.sh) instead. */
    update?: boolean;
    /** CODEMAN_APPDATA_PATH preset, built from the sandbox's own paths. */
    appdata?: (p: { home: string; repo: string }) => string;
    /**
     * Keystrokes for a run on a REAL terminal (a pty from util-linux `script`,
     * so Linux only), which is the only way to reach the questions: the script
     * reads stdin only when `-t 0` holds.
     */
    terminal?: string;
  } = {}
): Run {
  const dir = mkdtempSync(join(tmpdir(), 'codeman-start-setup-'));
  try {
    const home = join(dir, 'home');
    const dockerDir = join(dir, 'repo', 'docker');
    mkdirSync(home);
    mkdirSync(dockerDir, { recursive: true });
    writeFileSync(join(dockerDir, 'Start-Codeman.sh'), startScript);
    writeFileSync(join(dockerDir, 'Update-Codeman.sh'), updateScript);
    writeFileSync(join(dockerDir, '.env.example'), example);
    writeFileSync(join(dockerDir, 'docker-compose.yaml'), compose);
    // Hashed by the start path for the updater's fingerprint baseline.
    writeFileSync(join(dockerDir, 'server.Dockerfile'), readFileSync(join(ROOT, 'docker/server.Dockerfile')));
    if (opts.existingEnv !== undefined) writeFileSync(join(dockerDir, '.env'), opts.existingEnv);
    if (opts.envShape === 'directory') mkdirSync(join(dockerDir, '.env'));
    if (opts.envShape === 'dangling-symlink') symlinkSync(join(dir, 'no-such-file'), join(dockerDir, '.env'));
    if (opts.envShape === 'symlink-to-file') {
      writeFileSync(join(dir, 'real.env'), 'CODEMAN_PASSWORD=mine-and-only-mine\n');
      symlinkSync(join(dir, 'real.env'), join(dockerDir, '.env'));
    }

    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    let path: string;
    if (opts.noDocker) {
      // Only what the script runs before its `command -v docker` check, so the
      // host's own docker (if any) cannot be found.
      symlinkSync(
        execFileSync('bash', ['-c', 'command -v dirname'], { encoding: 'utf-8' }).trim(),
        join(binDir, 'dirname')
      );
      path = binDir;
    } else {
      const stubPath = join(binDir, 'docker');
      writeFileSync(stubPath, STUB);
      execFileSync('bash', ['-c', `chmod +x '${stubPath}'`]);
      path = `${binDir}:${process.env.PATH}`;
    }

    const logPath = join(dir, 'cmdlog.txt');
    writeFileSync(logPath, '');
    const env: Record<string, string> = { ...process.env, HOME: home, PATH: path, CMDLOG: logPath } as Record<
      string,
      string
    >;
    // A developer shell exporting any of these would change the defaults under test.
    for (const k of ['CODEMAN_APPDATA_PATH', 'CODEMAN_PORT', 'CODEMAN_PASSWORD', 'CODEMAN_NONINTERACTIVE'])
      delete env[k];
    Object.assign(env, opts.env ?? {});
    if (opts.appdata) env.CODEMAN_APPDATA_PATH = opts.appdata({ home, repo: join(dir, 'repo') });
    if (opts.socket) env.STUB_DOCKER_SOCKET = opts.socket;

    const entry = join(dockerDir, opts.update ? 'Update-Codeman.sh' : 'Start-Codeman.sh');
    const res =
      opts.terminal === undefined
        ? spawnSync(BASH, [entry, ...args], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        : spawnSync('script', ['-qefc', [BASH, entry, ...args].join(' '), '/dev/null'], {
            env,
            encoding: 'utf-8',
            input: opts.terminal,
          });
    const envPath = join(dockerDir, '.env');
    const envEntry = lstatSync(envPath, { throwIfNoEntry: false });
    const envKind = !envEntry
      ? null
      : envEntry.isSymbolicLink()
        ? 'symlink'
        : envEntry.isDirectory()
          ? 'directory'
          : 'file';
    const hasEnv = envKind === 'file' || (envKind === 'symlink' && existsSync(envPath));
    return {
      status: res.status ?? 1,
      // A terminal turns every line end into CRLF.
      stdout: res.stdout.replace(/\r/g, ''),
      stderr: res.stderr,
      log: readFileSync(logPath, 'utf-8')
        .split('\n')
        .filter((l) => l.trim()),
      env: hasEnv ? readFileSync(envPath, 'utf-8') : null,
      envMode: hasEnv ? statSync(envPath).mode & 0o777 : null,
      home,
      dir,
      homeEntries: readdirSync(home),
      envKind,
      envDirEntries: envKind === 'directory' ? readdirSync(envPath) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single (unquoted or single-quoted) value of KEY in a dotenv text. */
function envValue(text: string, key: string): string | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  if (line === undefined) return undefined;
  const raw = line.slice(key.length + 1);
  return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
}

/**
 * What Compose reads from a single-quoted dotenv value, or null when it refuses
 * the file with `unterminated quoted value`. A backslash there escapes the next
 * character, so `'longpass\\'` never closes, while bash (and so the stub) ends
 * the same value at that quote. Measured on Compose 2.33.0 and 5.5.0.
 */
function composeReads(quoted: string): string | null {
  let escaped = false;
  for (let i = 1; i < quoted.length; i++) {
    if (quoted[i] === "'" && !escaped) return i === quoted.length - 1 ? quoted.slice(1, i) : null;
    escaped = quoted[i] === '\\' && !escaped;
  }
  return null;
}

describe('Start-Codeman.sh first run (no docker/.env yet)', () => {
  it('parses under bash -n', () => {
    execFileSync('bash', ['-n', join(ROOT, 'docker/Start-Codeman.sh')]);
  });

  it('writes docker/.env from .env.example with every key the updater requires, mode 0600', () => {
    const r = runStart(['--setup-only']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.env).not.toBeNull();
    const env = r.env as string;
    expect(r.envMode).toBe(0o600);
    // The in-app updater's own check: no key the example sets may be missing.
    expect(diffRequiredEnvKeys(example, env)).toEqual([]);
    expect(parseEnvKeys(env)).toEqual(parseEnvKeys(example));
    // --setup-only stops before Compose is asked anything about the stack.
    expect(r.log.some((l) => / (up|build|config)( |$)/.test(l))).toBe(false);
  });

  it('changes only the five first-run values and keeps every other line of the example', () => {
    const r = runStart(['--setup-only']);
    const generated = (r.env as string).split('\n');
    const exampleLines = example.split('\n');
    // Header comments first, then the example line for line.
    const offset = generated.length - exampleLines.length;
    expect(offset).toBeGreaterThan(0);
    for (let i = 0; i < exampleLines.length; i++) {
      const want = exampleLines[i];
      const got = generated[i + offset];
      const key = want.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1];
      if (key && REWRITTEN_KEYS.includes(key)) {
        expect(got.startsWith(`${key}=`)).toBe(true);
      } else {
        expect(got).toBe(want);
      }
    }
  });

  it('defaults: a data folder of its own under HOME, cases inside it, a strong alphanumeric password', () => {
    const r = runStart(['--setup-only']);
    const env = r.env as string;
    const appdata = envValue(env, 'CODEMAN_APPDATA_PATH');
    expect(appdata).toBe(join(r.home, 'codeman-docker'));
    expect(envValue(env, 'CODEMAN_CASES_PATH')).toBe(join(r.home, 'codeman-docker', 'codeman-cases'));
    expect(appdata).not.toContain('.codeman');
    const password = envValue(env, 'CODEMAN_PASSWORD') as string;
    expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(password).not.toBe('changeme');
    expect(envValue(env, 'CODEMAN_PORT')).toMatch(/^\d+$/);
    expect(envValue(env, 'TZ')).toMatch(/^[A-Za-z0-9_+/-]+$/);
    // No terminal here, and a captured log must not hold the password.
    expect(r.stdout).not.toContain(password);
    expect(r.stdout).toMatch(/generated; read it from docker\/\.env/);
    expect(r.stdout).toMatch(/No questions asked/);
  });

  it('takes presets from the environment and quotes values Compose would otherwise interpolate', () => {
    const r = runStart(['--setup-only'], {
      env: { CODEMAN_PASSWORD: 'pa$$ #word', CODEMAN_PORT: '4567', CODEMAN_APPDATA_PATH: '/srv/My Data/codeman/' },
    });
    expect(r.status, r.stderr).toBe(0);
    const lines = (r.env as string).split('\n');
    expect(lines).toContain("CODEMAN_PASSWORD='pa$$ #word'");
    expect(lines).toContain('CODEMAN_PORT=4567');
    // Trailing slash dropped, the space kept by quoting.
    expect(lines).toContain("CODEMAN_APPDATA_PATH='/srv/My Data/codeman'");
    expect(lines).toContain("CODEMAN_CASES_PATH='/srv/My Data/codeman/codeman-cases'");
    // A password the user chose is never echoed.
    expect(r.stdout).not.toContain('pa$$ #word');
  });

  it.each([
    ['HOME itself', ({ home }: { home: string }) => home, /folder of its own/],
    ['HOME typed as ~', () => '~', /folder of its own/],
    ['a native install state dir', ({ home }: { home: string }) => join(home, '.codeman'), /installed directly/],
    ['inside a native install state dir', () => '~/.codeman/docker', /installed directly/],
    ['a relative path', () => 'codeman-data', /absolute path/],
    ['the checkout, which is the image build context', ({ repo }: { repo: string }) => repo, /copied into the image/],
    ['a folder inside the checkout', ({ repo }: { repo: string }) => join(repo, 'data'), /copied into the image/],
    // join() would resolve these, which is the whole point: the refusals above compare strings.
    ['HOME spelled through ..', ({ home }: { home: string }) => `${home}/../home`, /without \. or \.\./],
    ['the checkout spelled through ..', ({ home }: { home: string }) => `${home}/../repo/data`, /without \. or \.\./],
    ['a path ending in ..', ({ home }: { home: string }) => `${home}/data/..`, /without \. or \.\./],
    ['a native install spelled through .', ({ home }: { home: string }) => `${home}/./.codeman`, /without \. or \.\./],
    [
      'a native install behind a doubled slash',
      ({ home }: { home: string }) => `${home}//.codeman`,
      /installed directly/,
    ],
    ['the checkout behind a doubled slash', ({ repo }: { repo: string }) => `${repo}//data`, /copied into the image/],
  ])('refuses %s as the data folder and writes nothing', (_name, appdata, reason) => {
    const r = runStart(['--setup-only'], { appdata });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(reason);
    expect(r.env).toBeNull();
  });

  it.each([
    ['a single quote', "it's-a-password"],
    ['the example placeholder', 'changeme'],
    ['fewer than 8 characters', 'short'],
    ['a trailing backslash, which would escape the closing quote', 'longpass\\'],
  ])('refuses a preset password with %s', (_name, password) => {
    const r = runStart(['--setup-only'], { env: { CODEMAN_PASSWORD: password } });
    expect(r.status).toBe(1);
    expect(r.env).toBeNull();
  });

  it('refuses a data folder ending in a backslash, even behind a trailing slash', () => {
    for (const path of ['/srv/data\\', '/srv/data\\/']) {
      const r = runStart(['--setup-only'], { env: { CODEMAN_APPDATA_PATH: path } });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/cannot end in a backslash/);
      expect(r.env).toBeNull();
    }
  });

  it.each(['mid\\dle-pass', 'pa$$ #word', 'back`tick"quote', 'tab\there'])(
    'writes %j so Compose reads it back exactly',
    (password) => {
      const r = runStart(['--setup-only'], { env: { CODEMAN_PASSWORD: password } });
      expect(r.status, r.stderr).toBe(0);
      const line = (r.env as string).split('\n').find((l) => l.startsWith('CODEMAN_PASSWORD=')) as string;
      expect(composeReads(line.slice('CODEMAN_PASSWORD='.length))).toBe(password);
    }
  );

  it('refuses a dangling docker/.env symlink instead of replacing the link', () => {
    const r = runStart(['--setup-only'], { envShape: 'dangling-symlink' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a regular file/);
    expect(r.envKind).toBe('symlink');
  });

  it('refuses a docker/.env directory instead of writing a password file into it', () => {
    const r = runStart(['--setup-only'], { envShape: 'directory' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a regular file/);
    expect(r.envKind).toBe('directory');
    expect(r.envDirEntries).toEqual([]);
  });

  it('treats a docker/.env symlink to a real file as an existing install', () => {
    const r = runStart(['--setup-only'], { envShape: 'symlink-to-file' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/already exists/);
    expect(r.envKind).toBe('symlink');
  });

  it('keeps a folder name that merely starts with a dot or dots', () => {
    const r = runStart(['--setup-only'], { appdata: ({ home }) => `${home}/..data/.state` });
    expect(r.status, r.stderr).toBe(0);
    expect(envValue(r.env as string, 'CODEMAN_APPDATA_PATH')).toBe(`${r.home}/..data/.state`);
  });

  it('never rewrites an existing docker/.env', () => {
    const existing = '# hand-written\nCODEMAN_PASSWORD=mine-and-only-mine\nCODEMAN_APPDATA_PATH=/x\n';
    const r = runStart(['--setup-only'], { existingEnv: existing });
    expect(r.status, r.stderr).toBe(0);
    expect(r.env).toBe(existing);
    expect(r.stdout).toMatch(/already exists/);
  });
});

describe('Start-Codeman.sh preflight', () => {
  it('names the docker group (not sudo) when the account cannot reach the daemon', () => {
    const r = runStart(['--setup-only'], {
      env: {
        STUB_DAEMON_ERR: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/sudo usermod -aG docker /);
    expect(r.stderr).toMatch(/log out and back in/);
    expect(r.env).toBeNull();
  });

  it('says to start Docker when the daemon is not running, quoting what Docker said', () => {
    const r = runStart(['--setup-only'], {
      env: { STUB_DAEMON_ERR: 'failed to connect to the docker API at unix:///var/run/docker.sock' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/daemon is not reachable/);
    expect(r.stderr).toContain('failed to connect to the docker API');
    expect(r.env).toBeNull();
  });

  it('refuses a Compose older than 2.27.2, which has no `config --environment`', () => {
    const r = runStart(['--setup-only'], { env: { STUB_COMPOSE_VERSION: '2.27.0' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Compose 2\.27\.0 is too old; Codeman needs 2\.27\.2 or newer/);
    expect(r.env).toBeNull();
  });

  it('accepts newer Compose majors (v5 here) and a v-prefixed version', () => {
    expect(runStart(['--setup-only'], { env: { STUB_COMPOSE_VERSION: '5.5.0' } }).status).toBe(0);
    expect(runStart(['--setup-only'], { env: { STUB_COMPOSE_VERSION: 'v2.27.2' } }).status).toBe(0);
  });

  it('explains a missing Compose plugin', () => {
    const r = runStart(['--setup-only'], { env: { STUB_NO_COMPOSE: '1' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Compose v2 plugin is missing/);
  });

  it('explains a missing docker command', () => {
    const r = runStart(['--setup-only'], { noDocker: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Docker is not installed/);
  });
});

describe('Start-Codeman.sh on an existing install', () => {
  it('refuses to start while CODEMAN_PASSWORD is still `changeme`, before building anything', () => {
    const existing = example; // a straight copy of the example, never edited
    const r = runStart([], { existingEnv: existing });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/still the example value "changeme"/);
    expect(r.log.some((l) => / (up|build|down)( |$)/.test(l))).toBe(false);
    expect(r.env).toBe(existing);
  });

  it('Update-Codeman.sh refuses `changeme` BEFORE its build and `down`, so the stack is never left stopped', () => {
    // An existing appdata dir, so the check this is about is the one reached.
    const existing = example.replace(/^CODEMAN_APPDATA_PATH=.*$/m, `CODEMAN_APPDATA_PATH=${tmpdir()}`);
    const r = runStart([], { existingEnv: existing, update: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/still the example value "changeme"/);
    expect(r.stderr).toMatch(/Nothing was stopped/);
    expect(r.log.some((l) => / (build|down|up)( |$)/.test(l))).toBe(false);
  });

  it('rejects an unrecognised argument and prints usage for --help', () => {
    expect(runStart(['--bogus']).status).toBe(1);
    const help = runStart(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/--setup-only/);
  });
});

/**
 * The whole start path against the stub: no `docker/.env`, so setup, then
 * `up`, the readiness wait and the summary. Needs a real Unix socket for the
 * `DOCKER_SOCKET` check, which Windows cannot provide reliably (see the note in
 * docker-entrypoint.test.ts), so it runs on Linux and macOS only.
 */
describe.skipIf(process.platform === 'win32')('Start-Codeman.sh first run, start to summary', () => {
  let sockDir = '';
  let sockPath = '';
  let server: Server | null = null;

  beforeAll(async () => {
    sockDir = mkdtempSync(join(tmpdir(), 'codeman-start-sock-'));
    sockPath = join(sockDir, 'docker.sock');
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(sockDir, { recursive: true, force: true });
  });

  it('ends on the URL, where the password is and the log/stop commands once the container is healthy', () => {
    const r = runStart([], { socket: sockPath, env: { CODEMAN_PORT: '4321' } });
    expect(r.status, r.stderr).toBe(0);
    const password = envValue(r.env as string, 'CODEMAN_PASSWORD') as string;
    expect(r.stdout).toMatch(/Waiting for Codeman to answer\.\.\. ready\./);
    expect(r.stdout).toContain('http://localhost:4321');
    // Stdout is captured here, so docker/.env is the only place the password appears.
    expect(r.stdout).not.toContain(password);
    expect(r.stdout).toMatch(/Sign in +admin, with the CODEMAN_PASSWORD from .*docker\/\.env/);
    expect(r.stdout).toMatch(/Logs +cd .* && docker compose logs -f codeman/);
    expect(r.stdout).toMatch(/Stop +cd .* && docker compose down/);
    // Rerunning alone rebuilds the same checkout: nothing here fetches.
    expect(r.stdout).toMatch(/Update +App Settings > Updates in the dashboard, or git pull and rerun this script/);
    const up = r.log.findIndex((l) => / up --build -d/.test(l));
    expect(up).toBeGreaterThan(-1);
    expect(r.log.findIndex((l) => l.startsWith('docker inspect'))).toBeGreaterThan(up);
  });

  it('runs on the port docker/.env holds, not on the preset the shell still exports', () => {
    const r = runStart([], { socket: sockPath, env: { CODEMAN_PORT: '04444' } });
    expect(r.status, r.stderr).toBe(0);
    expect(envValue(r.env as string, 'CODEMAN_PORT')).toBe('4444');
    expect(r.stdout).toContain('http://localhost:4444');
    expect(r.stdout).not.toContain('04444');
  });

  it.skipIf(!HAS_PTY)('a typed answer beats a preset for the stack itself, not just the file', () => {
    const r = runStart([], {
      socket: sockPath,
      appdata: ({ home }) => join(home, 'preset-data'),
      env: { CODEMAN_PORT: '4444' },
      terminal: '~/typed-data\n5555\n\n',
    });
    expect(r.status, r.stdout).toBe(0);
    const env = r.env as string;
    expect(envValue(env, 'CODEMAN_APPDATA_PATH')).toBe(join(r.home, 'typed-data'));
    expect(envValue(env, 'CODEMAN_PORT')).toBe('5555');
    expect(r.stdout).toContain('http://localhost:5555');
    expect(r.homeEntries).toContain('typed-data');
    expect(r.homeEntries).not.toContain('preset-data');
  });

  it.skipIf(!HAS_PTY)('shows a generated password twice at a terminal', () => {
    const r = runStart([], { socket: sockPath, terminal: '\n\n\n' });
    expect(r.status, r.stdout).toBe(0);
    const password = envValue(r.env as string, 'CODEMAN_PASSWORD') as string;
    // Again at the end, since the build output has scrolled the first one away.
    expect(r.stdout.split(password).length - 1).toBe(2);
  });

  it.skipIf(!HAS_PTY)('promises no second showing after --setup-only', () => {
    const r = runStart(['--setup-only'], { terminal: '\n\n\n' });
    expect(r.status, r.stdout).toBe(0);
    const password = envValue(r.env as string, 'CODEMAN_PASSWORD') as string;
    expect(r.stdout.split(password).length - 1).toBe(1);
    expect(r.stdout).toMatch(/it stays in docker\/\.env/);
    expect(r.stdout).not.toMatch(/shown again/);
  });

  it('reports a container that keeps restarting, with its last log lines, and exits 1', () => {
    const r = runStart([], { socket: sockPath, env: { STUB_STATE: 'restarting||1' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did not come up \(container restarting\)/);
    expect(r.stderr).toContain('FAKE-LOG: server crashed');
    expect(r.stdout).not.toMatch(/http:\/\/localhost/);
  });

  it('names the next step when `docker compose up` fails', () => {
    const r = runStart([], { socket: sockPath, env: { STUB_UP_FAIL: '1' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/`docker compose up --build` failed/);
    expect(r.stderr).toMatch(/rerunning this script resumes/);
  });

  it('--no-wait prints the summary without waiting on the container', () => {
    const r = runStart(['--no-wait'], { socket: sockPath, env: { STUB_STATE: 'running|starting|0' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/--no-wait given/);
    expect(r.log.some((l) => l.startsWith('docker inspect'))).toBe(false);
  });
});

describe('version_older_than', () => {
  const cases: Array<[string, string, boolean]> = [
    ['2.27.0', '2.27.2', true],
    ['2.27.1', '2.27.2', true],
    ['2.27.2', '2.27.2', false],
    ['2.28.0', '2.27.2', false],
    ['2.9.0', '2.27.2', true],
    ['5.5.0', '2.27.2', false],
    ['1.29.2', '2.27.2', true],
    ['', '2.27.2', false],
    ['dev', '2.27.2', false],
    ['2.27.2-desktop.1', '2.27.2', false],
  ];
  it.each(cases)('%s older than %s: %s', (have, need, older) => {
    const script = [
      'set -euo pipefail',
      `eval "$(sed -n '/^version_older_than() {/,/^}/p' "$1")"`,
      'if version_older_than "$2" "$3"; then echo yes; else echo no; fi',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script, '_', join(ROOT, 'docker/Start-Codeman.sh'), have, need], {
      encoding: 'utf-8',
    }).trim();
    expect(out).toBe(older ? 'yes' : 'no');
  });
});
