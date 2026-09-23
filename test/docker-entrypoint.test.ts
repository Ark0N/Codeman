/**
 * @fileoverview Static and fixture checks for the Docker Compose deployment's
 * privilege handling: `docker/entrypoint.sh` starts as root, corrects bind-mount
 * ownership and drops to PUID:PGID, which only works while three files agree.
 *
 * 1. The capabilities `docker-compose.yaml` adds back on top of `cap_drop: ALL`
 *    must be exactly what the entrypoint and `init: true` need. This is the
 *    drift that shipped once already: the `USER` instruction became a root
 *    entrypoint, tini stayed root while the server became PUID, and with no
 *    CAP_KILL every `docker compose down` ended in tini failing to forward
 *    SIGTERM and the server being SIGKILLed. The list is derived here from what
 *    the scripts actually do, not copied.
 * 2. The runtime-owned CLI prefix must never sit ahead of the system
 *    directories on the PATH the root entrypoint resolves commands through: a
 *    planted `setpriv` in a PUID-writable prefix ran as uid 0 (measured with a
 *    minimal image of the same shape).
 * 3. `Start-Codeman.sh` derives PUID/PGID BEFORE it creates
 *    `CODEMAN_CASES_PATH`, so the directory it creates has the owner the
 *    container will accept, and its `git_head_commit` helper (a pure function
 *    over `.git`) resolves the three ref layouts a checkout can have.
 * 4. `Update-Codeman.sh` (the scripted major update) runs its collision guard
 *    before its own `--no-cache` build and `down`, removes exactly the two
 *    build-artefact volumes rather than every volume in the project, and hands
 *    off to `Start-Codeman.sh`; checked statically and by an end-to-end run
 *    against a stub `docker`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

const compose = read('docker/docker-compose.yaml');
const entrypoint = read('docker/entrypoint.sh');
const dockerfile = read('docker/server.Dockerfile');
const startScript = read('docker/Start-Codeman.sh');
const updateScript = read('docker/Update-Codeman.sh');

/** The `- NAME` entries under `cap_add:` (the block ends at the next key at the same indent). */
function composeCapAdd(text: string): string[] {
  const m = text.match(/^(\s*)cap_add:\n((?:\1\s+.*\n)*)/m);
  if (!m) return [];
  return m[2]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .sort();
}

/**
 * What the deployment needs, derived from the scripts. Each rule names the
 * line that needs it, so a capability cannot be added or removed here without
 * the reason changing too.
 */
function requiredCaps(): string[] {
  const caps = new Set<string>();
  if (/\bchown\b/.test(entrypoint)) {
    // chown of a root-owned bind source, and traversing trees root cannot
    // otherwise read on a mount with restrictive modes.
    caps.add('CHOWN');
    caps.add('DAC_OVERRIDE');
  }
  if (/setpriv .*--reuid/.test(entrypoint)) caps.add('SETUID');
  if (/setpriv .*--(regid|groups|clear-groups)/.test(entrypoint)) caps.add('SETGID');
  const dropsUid = /setpriv .*--reuid/.test(entrypoint);
  if (/^\s*init:\s*true\s*$/m.test(compose) && dropsUid) {
    // tini is PID 1 and stays root; signalling the PUID server needs CAP_KILL.
    caps.add('KILL');
  }
  return [...caps].sort();
}

describe('docker-compose.yaml cap_add covers what entrypoint.sh and init:true need', () => {
  it('the compose file adds back exactly the derived capability set', () => {
    expect(composeCapAdd(compose)).toEqual(requiredCaps());
  });

  it('cap_drop: ALL is still the baseline', () => {
    expect(compose).toMatch(/^\s*cap_drop:\n\s*- ALL\s*$/m);
  });

  it("the entrypoint's own diagnosis names the same list, so a missing cap gets a one-line fix", () => {
    const m = entrypoint.match(/^required_caps='([^']+)'/m);
    expect(m, 'entrypoint.sh must declare required_caps').not.toBeNull();
    const named = m![1]
      .split(',')
      .map((c) => c.trim())
      .sort();
    expect(named).toEqual(composeCapAdd(compose));
  });

  it('the user-facing docs quote the same cap_add list', () => {
    for (const rel of ['docker/README.md', 'CLAUDE.md']) {
      const text = read(rel);
      const quoted = [...text.matchAll(/cap_add: \[([^\]]+)\]/g)].map((m) =>
        m[1]
          .split(',')
          .map((c) => c.trim())
          .sort()
      );
      expect(quoted.length, `${rel} should quote the cap_add list at least once`).toBeGreaterThan(0);
      for (const list of quoted) expect(list, rel).toEqual(composeCapAdd(compose));
    }
  });
});

describe('the runtime-owned CLI prefix never shadows root commands', () => {
  it('server.Dockerfile appends /opt/codeman-cli/bin to PATH rather than prepending it', () => {
    const pathLines = dockerfile.split('\n').filter((l) => /^ENV PATH=/.test(l));
    expect(pathLines.length).toBeGreaterThan(0);
    for (const line of pathLines) {
      expect(line, 'a writable prefix ahead of $PATH lets a planted setpriv run as root').not.toMatch(
        /^ENV PATH=\/opt\/codeman-cli/
      );
    }
    expect(pathLines).toContain('ENV PATH=$PATH:/opt/codeman-cli/bin');
  });

  it('entrypoint.sh pins PATH to the system directories before its first command', () => {
    const lines = entrypoint.split('\n');
    const pinIdx = lines.findIndex((l) => l === 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(pinIdx, 'the PATH pin must exist').toBeGreaterThan(-1);
    const firstToolIdx = lines.findIndex((l) => !l.trim().startsWith('#') && /\b(setpriv|chown|stat)\b/.test(l));
    expect(firstToolIdx).toBeGreaterThan(pinIdx);
    // The only thing allowed before the pin is the `user:` short-circuit.
    const before = lines
      .slice(0, pinIdx)
      .filter((l) => l.trim() && !l.trim().startsWith('#') && !/^(set -eu|runtime_path=\$PATH)$/.test(l.trim()));
    expect(before).toEqual(['if [ "$(id -u)" -ne 0 ]; then', '  exec "$@"', 'fi']);
  });

  it("entrypoint.sh hands the image's full PATH back to the server at the drop", () => {
    expect(entrypoint).toMatch(/exec setpriv [^\n]*\\\n\s*env PATH="\$runtime_path" "\$@"/);
  });

  it('entrypoint.sh no longer passes --bounding-set (a silent no-op without CAP_SETPCAP)', () => {
    const code = entrypoint
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/--bounding-set/);
    expect(composeCapAdd(compose)).not.toContain('SETPCAP');
  });
});

describe('Start-Codeman.sh', () => {
  it('parses under bash -n', () => {
    execFileSync('bash', ['-n', join(ROOT, 'docker/Start-Codeman.sh')]);
    execFileSync('sh', ['-n', join(ROOT, 'docker/entrypoint.sh')]);
  });

  it('derives PUID/PGID before creating CODEMAN_CASES_PATH, so the new directory gets that owner', () => {
    const puid = startScript.indexOf('export PUID=');
    const mkdirCases = startScript.indexOf('mkdir -p -- "$cases_path"');
    expect(puid).toBeGreaterThan(-1);
    expect(mkdirCases).toBeGreaterThan(puid);
    expect(startScript).toMatch(/chown -- "\$PUID:\$PGID" "\$cases_path"/);
  });

  it('builds before taking the stack down, and writes the source marker only after a refresh', () => {
    const build = startScript.indexOf('"${compose_command[@]}" build');
    const down = startScript.indexOf('"${compose_command[@]}" down');
    const marker = startScript.indexOf('>"$source_state_file.tmp"');
    expect(build).toBeGreaterThan(-1);
    expect(down).toBeGreaterThan(build);
    expect(marker).toBeGreaterThan(down);
    expect(startScript).toMatch(/if \[\[ "\$refreshed" == '1' \]\]; then\n\s*printf '\{\\n {2}"headCommit"/);
    // A failed volume removal must not abort under set -e with the stack down.
    expect(startScript).not.toMatch(/\[\[ -n "\$volume_name" \]\] && docker volume rm/);
    expect(startScript).toMatch(/&& ! docker volume rm -- "\$volume_name"; then/);
  });

  it('falls back to `down --volumes` when the Compose project name cannot be resolved', () => {
    expect(startScript).toMatch(/if \[\[ -z "\$project_name" \]\]; then[\s\S]*down --volumes/);
  });
});

describe('Update-Codeman.sh (the scripted major-update path — docker/README.md "Major updates")', () => {
  it('parses under bash -n', () => {
    execFileSync('bash', ['-n', join(ROOT, 'docker/Update-Codeman.sh')]);
  });

  it('force-rebuilds with --no-cache BEFORE stopping the stack, THEN hands off to Start-Codeman.sh via `bash`', () => {
    const build = updateScript.indexOf('"${compose_command[@]}" build --no-cache');
    const down = updateScript.indexOf('"${compose_command[@]}" down');
    const handoff = updateScript.indexOf('exec bash "$script_dir/Start-Codeman.sh"');
    expect(build).toBeGreaterThan(-1);
    expect(down).toBeGreaterThan(build);
    expect(handoff).toBeGreaterThan(down);
    // A bare `exec "$script_dir/Start-Codeman.sh"` fails EACCES — Start-Codeman.sh
    // is committed non-executable (100644), same as this script.
    expect(updateScript).not.toMatch(/exec "\$script_dir\/Start-Codeman\.sh"/);
  });

  it('resolves the collision guard BEFORE the --no-cache build and the down, not after', () => {
    // Start-Codeman.sh has no such guard, so this is the only one, and it has
    // to run before this script's own build, down and volume removal.
    const projectName = updateScript.indexOf('project_name=$(');
    const guard = updateScript.indexOf('other_working_dir=$(');
    const build = updateScript.indexOf('"${compose_command[@]}" build --no-cache');
    const down = updateScript.indexOf('"${compose_command[@]}" down');
    expect(projectName).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(projectName);
    expect(guard).toBeLessThan(build);
    expect(guard).toBeLessThan(down);
    expect(updateScript).toMatch(/label=com\.docker\.compose\.project=\$project_name/);
    expect(updateScript).toMatch(/\{\{\.Label "com\.docker\.compose\.project\.working_dir"\}\}/);
    expect(updateScript).toMatch(/grep -v -F -x -- "\$script_dir"/);
  });

  it('clears exactly the two build-artefact volumes by DEFAULT, by label, scoped to the project', () => {
    expect(updateScript).toMatch(/--keep-volumes\)\s*\n\s*keep_volumes=1/);
    expect(updateScript).toMatch(/for key in codeman-node-modules codeman-dist; do/);
    expect(updateScript).toMatch(/--filter "label=com\.docker\.compose\.volume=\$key"/);
    expect(updateScript).toMatch(/docker volume rm -- "\$volume_name"/);
    // `down --volumes` survives only as the fallback for an unresolvable
    // project name, where the label filter could not match anything.
    const fallback = updateScript.indexOf('"${compose_command[@]}" down --volumes');
    const warning = updateScript.indexOf('could not resolve the Compose project name');
    expect(warning).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(warning);
  });

  it('--help/-h prints usage and exits 0, rather than falling into the unrecognised-argument branch', () => {
    expect(updateScript).toMatch(/--help \| -h\)\s*\n\s*printf 'Usage:/);
    const helpBlock = updateScript.slice(updateScript.indexOf('--help | -h)'), updateScript.indexOf('*)'));
    expect(helpBlock).toMatch(/exit 0/);
  });

  it('rejects an unrecognised argument rather than silently ignoring it', () => {
    expect(updateScript).toMatch(/Error: unrecognised argument/);
    expect(updateScript).toMatch(/exit 1/);
  });

  it('resolves the override file exactly like Start-Codeman.sh, so `down` and `up` never target different Compose files', () => {
    // \r stripped before comparing: git's autocrlf normalises the COMMITTED blob to LF
    // either way, but a Windows checkout can have already converted one file's line
    // endings on disk and not the other's (e.g. Start-Codeman.sh checked out before this
    // script existed), which would fail a raw byte comparison for a reason that has
    // nothing to do with the two scripts actually agreeing.
    const normalise = (s: string) => s.replace(/\r\n/g, '\n');
    const overrideBlock = (script: string) =>
      normalise(script.slice(script.indexOf('override_yml='), script.indexOf('compose_command=(docker compose')));
    expect(overrideBlock(updateScript)).toBe(overrideBlock(startScript));
  });

  it('derives PUID/PGID from the SAME owner_of() helper Start-Codeman.sh uses, so the --no-cache build gets the right build args', () => {
    const normalise = (s: string) => s.replace(/\r\n/g, '\n');
    const ownerOfBlock = (script: string) => {
      const start = script.indexOf('owner_of() {');
      const end = script.indexOf('\n}', start) + '\n}'.length;
      return normalise(script.slice(start, end));
    };
    expect(ownerOfBlock(updateScript)).toBe(ownerOfBlock(startScript));
    expect(updateScript).toMatch(/export PUID=\$\{owner_ids%%:\*\}/);
    expect(updateScript).toMatch(/export PGID=\$\{owner_ids##\*:\}/);
    // The build must come AFTER PUID/PGID are resolved and exported, or Compose
    // falls back to its own default of 1000:1000 for the build args.
    const puidExport = updateScript.indexOf('export PUID=');
    const build = updateScript.indexOf('"${compose_command[@]}" build --no-cache');
    expect(puidExport).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(puidExport);
  });

  describe('end-to-end smoke test (a stub `docker` on PATH, logging every invocation)', () => {
    /**
     * Reproduces the exact scenario the review on PR #465 caught by hand: a bare
     * `exec` of a non-executable script exits 126 with no further `docker` calls
     * at all. Runs the REAL Update-Codeman.sh against a synthetic deployment,
     * asserting the actual command sequence a shell would issue — string-matching
     * the source (the tests above) cannot tell a working `exec bash "…"` apart
     * from a silently-broken bare `exec "…"` the way actually running it can.
     *
     * The harness intentionally does NOT create a real Unix socket for
     * DOCKER_SOCKET (net.createServer().listen(path) is unreliable off Linux —
     * measured EACCES on this Windows sandbox even outside any container). So the
     * handoff to Start-Codeman.sh is real and fully exercises this script's own
     * build/down/handoff sequence, but Start-Codeman.sh's OWN socket check is
     * expected to then fail — which is itself the proof the handoff worked: a
     * process that failed to exec would never reach a Start-Codeman.sh-only error
     * message, and would exit 126, not 1.
     */
    // Windows join()/mkdtempSync() paths carry backslashes, which the stub
    // `docker`'s naive `source "$envfile"` (a shortcut for `docker compose
    // config --environment`'s own real parsing, which handles this fine) reads
    // as bash ESCAPE characters and silently drops — `C:\Users\x` becomes
    // `C:Usersx`. Forward slashes are accepted by git-bash/MSYS on Windows and
    // by every POSIX shell, so normalising once here sidesteps a harness
    // artifact that has nothing to do with the scripts under test.
    const posix = (p: string) => p.replace(/\\/g, '/');

    function runSmokeTest(
      args: string[],
      extraEnv: Record<string, string> = {}
    ): { status: number; stderr: string; log: string[] } {
      const dir = mkdtempSync(join(tmpdir(), 'codeman-update-smoke-'));
      try {
        const dockerDir = join(dir, 'docker');
        mkdirSync(dockerDir);
        writeFileSync(join(dockerDir, 'Update-Codeman.sh'), updateScript);
        writeFileSync(join(dockerDir, 'Start-Codeman.sh'), startScript);
        writeFileSync(join(dockerDir, 'docker-compose.yaml'), compose);

        const appdataPath = join(dir, 'appdata');
        const casesPath = join(dir, 'cases');
        const socketPath = join(dir, 'docker.sock'); // deliberately NOT a real socket — see above
        mkdirSync(appdataPath);
        mkdirSync(casesPath);
        writeFileSync(socketPath, '');

        writeFileSync(
          join(dockerDir, '.env'),
          [
            `CODEMAN_APPDATA_PATH=${posix(appdataPath)}`,
            `CODEMAN_CASES_PATH=${posix(casesPath)}`,
            `DOCKER_SOCKET=${posix(socketPath)}`,
            'CODEMAN_RUNTIME_USER=codeman',
            'CODEMAN_PORT=3000',
            'CODEMAN_HOST=127.0.0.1',
            'CODEMAN_PASSWORD=x',
            'CODEMAN_USERNAME=admin',
            'GEMINI_API_KEY=',
            'CODEMAN_DOCKER_BRIDGE_HOOKS=',
            'CODEMAN_DOCKER_DISABLE_SWAP_LIMIT=',
            'TZ=UTC',
            'CODEMAN_IMAGE=codeman:test',
            '',
          ].join('\n')
        );

        // A stub `docker` that only understands the two `compose config` shapes
        // both scripts actually issue, and logs every invocation verbatim —
        // written and chmod+x'd from WITHIN one bash invocation (not
        // fs.chmodSync, whose Win32 backing does not reliably set the bit this
        // MSYS bash's own PATH lookup honours — measured, differs from a plain
        // `chmod +x` issued by bash itself).
        const binDir = join(dir, 'bin');
        mkdirSync(binDir);
        const stub = [
          '#!/usr/bin/env bash',
          'echo "docker $*" >> "$CMDLOG"',
          'if [[ "$1" == "compose" ]]; then',
          '  shift',
          '  prev=""',
          '  envfile=""',
          '  for a in "$@"; do',
          '    if [[ "$prev" == "--env-file" ]]; then envfile="$a"; fi',
          '    prev="$a"',
          '  done',
          '  if [[ " $* " == *" config "* && " $* " == *" --environment "* ]]; then',
          '    source "$envfile"',
          '    echo "CODEMAN_APPDATA_PATH=$CODEMAN_APPDATA_PATH"',
          '    echo "CODEMAN_CASES_PATH=$CODEMAN_CASES_PATH"',
          '    echo "DOCKER_SOCKET=$DOCKER_SOCKET"',
          '    exit 0',
          '  fi',
          '  if [[ " $* " == *" config "* && " $* " == *" --format json "* ]]; then',
          '    if [[ -n "${STUB_CONFIG_JSON_FAIL:-}" ]]; then echo "unknown flag: --format" >&2; exit 1; fi',
          // Real `docker compose config --format json` pretty-prints, so
          // `"name"` starts its OWN line rather than sharing one with `{` -
          // the sed extraction both scripts use anchors on that, and a
          // compact one-liner here would silently resolve project_name to
          // empty, exercising neither script's guard the way real Compose
          // output does.
          '    printf \'{\\n  "name": "codeman"\\n}\\n\'',
          '    exit 0',
          '  fi',
          '  exit 0',
          'fi',
          // Mirrors the guard's own `docker ps -a --filter ... --format
          // '{{.Label "com.docker.compose.project.working_dir"}}'` call.
          // Empty by default (no collision) so the existing smoke tests above
          // see no output here and proceed exactly as before; a test that
          // wants to exercise the guard itself sets STUB_PS_WORKING_DIR.
          'if [[ "$1" == "ps" && -n "${STUB_PS_WORKING_DIR:-}" ]]; then',
          '  printf "%s\\n" "$STUB_PS_WORKING_DIR"',
          '  exit 0',
          'fi',
          // `docker volume ls -q --filter label=com.docker.compose.volume=<key> ...`:
          // answer with the Compose-style `<project>_<key>` name for that key.
          'if [[ "$1" == "volume" && "$2" == "ls" ]]; then',
          '  for a in "$@"; do',
          '    case "$a" in label=com.docker.compose.volume=*) echo "codeman_${a#label=com.docker.compose.volume=}" ;; esac',
          '  done',
          '  exit 0',
          'fi',
          'exit 0',
        ].join('\n');
        const stubPath = join(binDir, 'docker');
        writeFileSync(stubPath, stub);
        execFileSync('bash', ['-c', `chmod +x '${stubPath}'`]);

        const logPath = join(dir, 'cmdlog.txt');
        writeFileSync(logPath, '');

        let status = 0;
        let stderr = '';
        try {
          execFileSync('bash', [join(dockerDir, 'Update-Codeman.sh'), ...args], {
            env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CMDLOG: logPath, ...extraEnv },
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          const e = err as { status?: number; stderr?: string };
          status = e.status ?? 1;
          stderr = e.stderr ?? '';
        }

        const log = readFileSync(logPath, 'utf-8')
          .split('\n')
          .filter((l) => l.trim());
        return { status, stderr, log };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('default: build --no-cache, THEN a plain down, THEN removes exactly the two volumes, THEN the handoff runs Start-Codeman.sh', () => {
      const { status, stderr, log } = runSmokeTest([]);

      const buildIdx = log.findIndex((l) => l.includes('build --no-cache'));
      const downIdx = log.findIndex((l) => / down(\s|$)/.test(l));
      expect(buildIdx).toBeGreaterThan(-1);
      expect(downIdx).toBeGreaterThan(buildIdx);
      expect(log[downIdx]).not.toContain('--volumes');
      expect(log.some((l) => l.includes('down --volumes'))).toBe(false);
      const removed = log.filter((l) => l.startsWith('docker volume rm'));
      expect(removed).toEqual([
        'docker volume rm -- codeman_codeman-node-modules',
        'docker volume rm -- codeman_codeman-dist',
      ]);
      expect(log.findIndex((l) => l.startsWith('docker volume rm'))).toBeGreaterThan(downIdx);

      // Proof the handoff really executed Start-Codeman.sh rather than dying
      // with EACCES right after printing "Handing off...": more `docker`
      // invocations appear AFTER the down, which only Start-Codeman.sh's own
      // config-resolution lines would produce.
      const configCallsAfterDown = log.slice(downIdx + 1).filter((l) => l.includes('config'));
      expect(configCallsAfterDown.length).toBeGreaterThan(0);

      // A working handoff fails HONESTLY at Start-Codeman.sh's own socket
      // check (this harness deliberately supplies no real Unix socket) — never
      // with an EACCES/126 from a broken `exec`.
      expect(status).toBe(1);
      expect(stderr).toMatch(/DOCKER_SOCKET is not a Unix socket/);
      expect(stderr).not.toMatch(/permission denied/i);
    });

    it('--keep-volumes: a plain `down`, with no --volumes flag', () => {
      const { log } = runSmokeTest(['--keep-volumes']);
      const downLine = log.find((l) => / down(\s|$)/.test(l));
      expect(downLine).toBeDefined();
      expect(downLine).not.toContain('--volumes');
      expect(log.some((l) => l.startsWith('docker volume rm'))).toBe(false);
    });

    it('reports a failing first `docker compose config` call instead of exiting silently', () => {
      const { status, stderr, log } = runSmokeTest([], { STUB_CONFIG_JSON_FAIL: '1' });
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/docker compose config --format json` failed/);
      expect(stderr).toMatch(/unknown flag: --format/);
      expect(log.some((l) => l.includes('build --no-cache'))).toBe(false);
    });

    it('still refuses when an unlabelled container prints an empty line ahead of the other checkout', () => {
      const { status, stderr, log } = runSmokeTest([], { STUB_PS_WORKING_DIR: '\n/some/other/checkout/docker' });
      expect(status).toBe(1);
      expect(stderr).toMatch(/already in use by a DIFFERENT checkout/);
      expect(log.some((l) => l.includes('build --no-cache'))).toBe(false);
    });

    it('refuses BEFORE the --no-cache build when the resolved project belongs to a different checkout', () => {
      // Start-Codeman.sh has no such guard, so nothing downstream of this
      // script would catch the collision.
      const { status, stderr, log } = runSmokeTest([], { STUB_PS_WORKING_DIR: '/some/other/checkout/docker' });
      expect(status).toBe(1);
      expect(stderr).toMatch(/already in use by a DIFFERENT checkout/);
      expect(stderr).toContain('/some/other/checkout/docker');
      expect(log.some((l) => l.includes('build --no-cache'))).toBe(false);
      expect(log.some((l) => / down(\s|$)/.test(l))).toBe(false);
    });
  });
});

describe('git_head_commit resolves every ref layout a checkout can have', () => {
  let base: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    }).trim();

  /** Runs the function exactly as the script defines it, extracted by its own delimiters. */
  const headCommit = (repo: string): { out: string; status: number } => {
    const script = [`eval "$(sed -n '/^git_head_commit() {/,/^}/p' "$1")"`, 'git_head_commit "$2"'].join('\n');
    try {
      const out = execFileSync('bash', ['-c', script, '_', join(ROOT, 'docker/Start-Codeman.sh'), repo], {
        encoding: 'utf-8',
      });
      return { out: out.trim(), status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { out: (e.stdout ?? '').trim(), status: e.status ?? 1 };
    }
  };

  const makeRepo = (name: string): string => {
    const dir = join(base, name);
    git(base, 'init', '-q', '-b', 'master', dir);
    writeFileSync(join(dir, 'f'), 'x');
    git(dir, 'add', 'f');
    git(dir, 'commit', '-q', '-m', 'one');
    return dir;
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'codeman-head-commit-'));
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('symbolic ref with a loose ref file', () => {
    const dir = makeRepo('loose');
    expect(headCommit(dir)).toEqual({ out: git(dir, 'rev-parse', 'HEAD'), status: 0 });
  });

  it('detached HEAD', () => {
    const dir = makeRepo('detached');
    const sha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', '--detach', sha);
    expect(headCommit(dir)).toEqual({ out: sha, status: 0 });
  });

  it('packed refs after gc', () => {
    const dir = makeRepo('packed');
    const sha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'pack-refs', '--all');
    expect(readFileSync(join(dir, '.git/packed-refs'), 'utf-8')).toContain('refs/heads/master');
    expect(headCommit(dir)).toEqual({ out: sha, status: 0 });
  });

  it('a linked worktree (.git is a file) resolves nothing rather than something wrong', () => {
    const dir = makeRepo('main');
    const wt = join(base, 'wt');
    git(dir, 'worktree', 'add', '-q', wt);
    const result = headCommit(wt);
    expect(result.out).toBe('');
    expect(result.status).not.toBe(0);
  });

  it('a directory that is not a checkout fails', () => {
    const result = headCommit(base);
    expect(result.out).toBe('');
    expect(result.status).not.toBe(0);
  });
});
