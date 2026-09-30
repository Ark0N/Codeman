/**
 * @fileoverview Tests for remote (SSH) file access (`src/remote-files.ts`).
 *
 * Two layers are covered:
 *
 * 1. PURE builders/parsers — command construction, escaping and probe parsing, no
 *    connection involved.
 * 2. The probe SCRIPT itself, executed by a real `/bin/sh` against a real temp
 *    directory. The remote shell is the one place where a quoting mistake becomes an
 *    injection, and it cannot be exercised by an ssh-less unit test any other way: the
 *    script IS the remote command, so `sh -c <script>` reproduces exactly what sshd
 *    runs on the other end.
 *
 * Port: N/A (no HTTP server).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  RemoteFileAccessError,
  buildRemoteFileCommand,
  buildRemoteProbeCommand,
  buildRemoteReadCommand,
  buildRemoteWriteCommand,
  parseRemoteProbeRecord,
  parseRemoteProbeOutput,
  remoteEnsureDir,
  remoteProbePaths,
  remoteReadFile,
  remoteCreateReadStream,
  remoteWriteFile,
} from '../src/remote-files.js';
import type { SessionRemote } from '../src/types/session.js';

/**
 * Run a shell line through a real `/bin/sh` and return its `$@` as an argv array,
 * WITHOUT executing anything. This is how the tests see the exact argument vector a
 * command line would hand to the process — the local-shell half of the escaping chain.
 */
function shellArgv(command: string): string[] {
  const out = execFileSync('sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`]);
  // The trailing empty element is the printf format terminator.
  return out.toString().split('\0').slice(0, -1);
}

/** A remote session fixture; every field is optional in production, so keep it minimal. */
function remoteFixture(overrides: Partial<SessionRemote> = {}): SessionRemote {
  return {
    hostId: 'host-1',
    label: 'testhost',
    host: '192.0.2.10',
    username: 'j',
    remotePath: '/srv/case',
    ...overrides,
  };
}

describe('buildRemoteFileCommand', () => {
  it('builds the ssh line from the shared connection args and one shellescaped command', () => {
    const argv = shellArgv(buildRemoteFileCommand(remoteFixture(), 'cat /etc/hostname'));

    // buildSshConnectionArgs returns tokens, and the shell re-splits them into the
    // flags ssh actually wants (`-o` + `BatchMode=yes`), which is what this pins.
    expect(argv.slice(0, 3)).toEqual(['ssh', '-o', 'BatchMode=yes']);
    expect(argv).toContain('ConnectTimeout=10');
    expect(argv).toContain('j@192.0.2.10');
    // The remote command is ONE argument, whatever it contains.
    expect(argv[argv.length - 1]).toBe('cat /etc/hostname');
    expect(argv[argv.length - 2]).toBe('j@192.0.2.10');
  });

  it('routes port, identity, jump host and extra options through buildSshConnectionArgs', () => {
    const argv = shellArgv(
      buildRemoteFileCommand(
        remoteFixture({
          port: 2222,
          identityFile: '~/.ssh/id_ed25519',
          jumpHost: 'bastion.example.com',
          extraSshOptions: ['StrictHostKeyChecking=accept-new'],
        }),
        'true'
      )
    );

    expect(argv).toContain('-p');
    expect(argv).toContain('2222');
    expect(argv).toContain('-J');
    expect(argv).toContain('bastion.example.com');
    expect(argv).toContain('StrictHostKeyChecking=accept-new');
    // `~` is expanded before escaping: ssh does not expand it inside -i.
    expect(argv).toContain(join(homedir(), '.ssh/id_ed25519'));
  });

  it('keeps a shell-metacharacter command as a single opaque argument', () => {
    const command = "cat '/tmp/it''s here' ; rm -rf ~ #";
    const argv = shellArgv(buildRemoteFileCommand(remoteFixture(), command));

    expect(argv[argv.length - 1]).toBe(command);
    expect(argv).not.toContain('rm');
    expect(argv).not.toContain('-rf');
  });
});

describe('buildRemoteProbeCommand', () => {
  it('probes every path exactly once, each as its own shell-quoted token', () => {
    const script = buildRemoteProbeCommand(['/srv/case/a.png', '/srv/case']);
    const probeCalls = script.split('\n').filter((line) => line.startsWith('probe '));

    // The index is what the parser keys records on, so it is part of the call.
    expect(probeCalls).toEqual(["probe 0 '/srv/case/a.png'", "probe 1 '/srv/case'"]);
  });

  it('quotes a path with spaces, quotes and a command substitution', () => {
    const nasty = "/srv/case/it's $(touch /tmp/pwned).txt";
    const script = buildRemoteProbeCommand([nasty]);

    expect(script).toContain(`probe 0 '/srv/case/it'\\''s $(touch /tmp/pwned).txt'`);
    expect(shellArgv(buildRemoteFileCommand(remoteFixture(), script)).at(-1)).toBe(script);
  });
});

/**
 * Run the probe script through a real `/bin/sh`. With `shadowReadlinkF` the PATH is
 * fronted by a `readlink` that rejects `-f` the way macOS < 12.3 does (`illegal
 * option -- f`) and otherwise defers to the real one, which forces the portable
 * fallback branch on a host that natively has `readlink -f`.
 */
function runProbe(paths: string[], options: { cwd?: string; shadowReadlinkF?: boolean; shimDir?: string } = {}) {
  const env =
    options.shadowReadlinkF && options.shimDir
      ? { ...process.env, PATH: `${options.shimDir}:${process.env.PATH}` }
      : process.env;
  const stdout = execFileSync('sh', ['-c', buildRemoteProbeCommand(paths)], { cwd: options.cwd, env }).toString();
  return parseRemoteProbeOutput(stdout, paths);
}

describe('the probe script on a real shell', () => {
  let root: string;
  let shimDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-remote-probe-'));
    shimDir = join(root, 'shim-bin');
    mkdirSync(shimDir);
    const realReadlink = execFileSync('sh', ['-c', 'command -v readlink']).toString().trim();
    writeFileSync(
      join(shimDir, 'readlink'),
      `#!/bin/sh\ncase "$1" in -f) echo 'readlink: illegal option -- f' >&2; exit 1;; esac\nexec ${realReadlink} "$@"\n`
    );
    chmodSync(join(shimDir, 'readlink'), 0o755);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the fallback branch on a shell whose readlink has no -f', () => {
    // Sanity check on the shim itself: without it this whole describe would be
    // exercising the native branch twice.
    expect(() =>
      execFileSync('sh', ['-c', 'readlink -f / 2>/dev/null'], {
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      })
    ).toThrow();
  });

  it.each([
    ['readlink -f', false],
    ['portable fallback', true],
  ])('refuses to report a symlink by its own path (%s): the target is what is served', (_label, shadow) => {
    // The reviewer's exact reproduction: ws/notes.txt -> secret/id_rsa. The old
    // fallback resolved only the DIRECTORY chain, returned `ws/notes.txt` as the
    // realpath (with the TARGET's size), containment passed, and `cat` served the key.
    const ws = join(root, `escape-${shadow ? 'fallback' : 'native'}`);
    const secret = join(root, `secret-${shadow ? 'fallback' : 'native'}`);
    mkdirSync(ws);
    mkdirSync(secret);
    writeFileSync(join(secret, 'id_rsa'), 'KEYKEYKEYKEY1');
    execFileSync('ln', ['-s', join(secret, 'id_rsa'), join(ws, 'notes.txt')]);

    const [probe] = runProbe([join(ws, 'notes.txt')], { shadowReadlinkF: shadow, shimDir });

    expect(probe?.realPath).toBe(join(secret, 'id_rsa'));
    expect(probe?.size).toBe(13);
  });

  it('follows a relative symlink chain through a symlinked directory on the fallback branch', () => {
    const ws = join(root, 'chain');
    mkdirSync(join(ws, 'sub'), { recursive: true });
    writeFileSync(join(ws, 'sub', 'real.txt'), 'inside');
    execFileSync('ln', ['-s', 'real.txt', join(ws, 'sub', 'hop1.txt')]);
    execFileSync('ln', ['-s', 'hop1.txt', join(ws, 'sub', 'hop2.txt')]);
    execFileSync('ln', ['-s', 'sub', join(ws, 'subl')]);

    const probes = runProbe([join(ws, 'subl', 'hop2.txt'), join(ws, 'subl')], { shadowReadlinkF: true, shimDir });

    expect(probes[0]).toMatchObject({ kind: 'file', size: 6, realPath: join(ws, 'sub', 'real.txt') });
    expect(probes[1]).toMatchObject({ kind: 'directory', realPath: join(ws, 'sub') });
  });

  it.each([
    ['readlink -f', false],
    ['portable fallback', true],
  ])('fails CLOSED on a symlink loop (%s), never reporting the unresolved path', (_label, shadow) => {
    const ws = join(root, `loop-${shadow ? 'fallback' : 'native'}`);
    mkdirSync(ws);
    execFileSync('ln', ['-s', 'b', join(ws, 'a')]);
    execFileSync('ln', ['-s', 'a', join(ws, 'b')]);

    const [probe] = runProbe([join(ws, 'a')], { shadowReadlinkF: shadow, shimDir });

    expect(probe).toBeNull();
  });

  it('reports kind, size and realpath for a file, a directory and a missing path', () => {
    const filePath = join(root, 'image.png');
    writeFileSync(filePath, 'fake png bytes');

    const probes = parseRemoteProbeOutput(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([filePath, root, join(root, 'nope.png')])]).toString(),
      [filePath, root, join(root, 'nope.png')]
    );

    expect(probes[0]).toMatchObject({ kind: 'file', size: 14, realPath: filePath });
    expect(probes[0]?.mtimeMs).toBeGreaterThan(0);
    expect(probes[1]).toMatchObject({ kind: 'directory', size: 0, realPath: root });
    expect(probes[2]).toBeNull();
  });

  it('resolves a symlink to its target', () => {
    const target = join(root, 'target.txt');
    const link = join(root, 'link.txt');
    writeFileSync(target, 'x');
    execFileSync('ln', ['-s', target, link]);

    const [probe] = parseRemoteProbeOutput(execFileSync('sh', ['-c', buildRemoteProbeCommand([link])]).toString(), [
      link,
    ]);

    expect(probe?.realPath).toBe(target);
  });

  it('treats a hostile filename as data, never as a command', () => {
    // No slashes in the payload: it has to be a legal FILENAME on this host while
    // still being a command substitution to a shell.
    const marker = `codeman_pwned_${process.pid}`;
    const hostile = join(root, `it's; touch ${marker}; $(id).txt`);
    writeFileSync(hostile, 'hostile');

    const [probe] = parseRemoteProbeOutput(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([hostile])], { cwd: root }).toString(),
      [hostile]
    );

    expect(probe?.realPath).toBe(hostile);
    expect(existsSync(join(root, marker))).toBe(false);
  });

  it('keeps a filename containing a newline aligned with its own index', () => {
    // One record per LINE would have made this two lines, shifting every record
    // after it by one; records are NUL-terminated and index-keyed instead.
    const weird = join(root, 'a\nb.txt');
    writeFileSync(weird, 'nl');
    const after = join(root, 'after.txt');
    writeFileSync(after, 'after');

    const probes = runProbe([weird, after, join(root, 'nope')]);

    expect(probes[0]).toMatchObject({ kind: 'file', size: 2, realPath: weird });
    expect(probes[1]).toMatchObject({ kind: 'file', size: 5, realPath: after });
    expect(probes[2]).toBeNull();
  });

  it('discards a login banner and rc-file chatter printed before the records', () => {
    const filePath = join(root, 'banner.txt');
    writeFileSync(filePath, 'b');

    const stdout = execFileSync('sh', [
      '-c',
      `echo 'Welcome to box'; printf '0|f|9|9|/etc/shadow\\n'; ${buildRemoteProbeCommand([filePath])}`,
    ]).toString();

    // The chatter even LOOKS like a record; the leading NUL is what fences it off.
    expect(parseRemoteProbeOutput(stdout, [filePath])[0]).toMatchObject({ realPath: filePath, size: 1 });
  });

  it('handles a path containing the field separator', () => {
    const pipePath = join(root, 'a|b.txt');
    writeFileSync(pipePath, 'xy');

    const [probe] = parseRemoteProbeOutput(execFileSync('sh', ['-c', buildRemoteProbeCommand([pipePath])]).toString(), [
      pipePath,
    ]);

    expect(probe?.realPath).toBe(pipePath);
    expect(probe?.size).toBe(2);
  });

  it('walks into a nested directory that exists', () => {
    const nested = join(root, 'sub');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'f.txt'), 'abc');

    const [probe] = parseRemoteProbeOutput(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([join(nested, 'f.txt')])]).toString(),
      [join(nested, 'f.txt')]
    );

    expect(probe?.size).toBe(3);
    expect(statSync(join(nested, 'f.txt')).size).toBe(3);
  });
});

describe('parseRemoteProbeRecord', () => {
  it('parses a file record and converts mtime to milliseconds', () => {
    expect(parseRemoteProbeRecord('f|1234|1700000000|/srv/case/a.png')).toEqual({
      realPath: '/srv/case/a.png',
      kind: 'file',
      size: 1234,
      mtimeMs: 1700000000 * 1000,
    });
  });

  it('keeps a path that itself contains the separator', () => {
    expect(parseRemoteProbeRecord('f|7|0|/srv/ca|se/a b.txt')?.realPath).toBe('/srv/ca|se/a b.txt');
  });

  it('maps directories, other kinds, the not-found and the unresolvable markers', () => {
    expect(parseRemoteProbeRecord('d|0|5|/srv/case')?.kind).toBe('directory');
    expect(parseRemoteProbeRecord('o|0|0|/srv/case/sock')?.kind).toBe('other');
    expect(parseRemoteProbeRecord('n')).toBeNull();
    // Exists but could not be canonicalized: refused like a missing file, never
    // served under a path whose real target is unknown.
    expect(parseRemoteProbeRecord('x')).toBeNull();
    expect(parseRemoteProbeRecord('')).toBeNull();
  });

  it('rejects malformed lines instead of inventing a path', () => {
    expect(parseRemoteProbeRecord('f|1|2')).toBeNull();
    expect(parseRemoteProbeRecord('x|1|2|/p')).toBeNull();
    expect(parseRemoteProbeRecord('f|1|2|')).toBeNull();
  });
});

describe('parseRemoteProbeOutput', () => {
  it('keys records by index after the leading NUL, so a login banner cannot shift the mapping', () => {
    const stdout = 'welcome to the remote box\n\x000|f|3|1|/srv/a.txt\x001|n\x00';
    expect(parseRemoteProbeOutput(stdout, ['/srv/a.txt', '/srv/b.txt'])).toEqual([
      { realPath: '/srv/a.txt', kind: 'file', size: 3, mtimeMs: 1000 },
      null,
    ]);
  });

  it('accepts records in any order and ignores duplicates of an index', () => {
    const stdout = '\x001|d|0|0|/srv\x000|f|3|1|/srv/a.txt\x000|f|9|9|/evil\x00';
    expect(parseRemoteProbeOutput(stdout, ['/srv/a.txt', '/srv'])).toEqual([
      { realPath: '/srv/a.txt', kind: 'file', size: 3, mtimeMs: 1000 },
      { realPath: '/srv', kind: 'directory', size: 0, mtimeMs: 0 },
    ]);
  });

  it('throws when a requested path has no record (transport or shell failure, never a 404)', () => {
    expect(() => parseRemoteProbeOutput('\x000|f|3|1|/srv/a.txt\x00', ['/a', '/b'])).toThrow(RemoteFileAccessError);
    expect(() => parseRemoteProbeOutput('', ['/a'])).toThrow(RemoteFileAccessError);
    // No leading NUL at all: the script never ran, whatever the shell printed.
    expect(() => parseRemoteProbeOutput('0|f|3|1|/srv/a.txt', ['/srv/a.txt'])).toThrow(RemoteFileAccessError);
  });
});

describe('under vitest', () => {
  const remote = remoteFixture();

  it('never opens a connection: probes and reads reject with a clear error', async () => {
    // Mirrors checkRemoteTmuxAvailable's guard. The route tests mock this module, so
    // this is the backstop for the next test that reaches the real one.
    await expect(remoteProbePaths(remote, ['/srv/case'])).rejects.toThrow(/disabled under test/);
    await expect(remoteReadFile(remote, '/srv/case/a.txt', 1024)).rejects.toThrow(/disabled under test/);
  });

  it('never opens a connection: writes and mkdir reject with a clear error', async () => {
    await expect(remoteEnsureDir(remote, '/srv/case/.claude-images')).rejects.toThrow(/disabled under test/);
    await expect(remoteWriteFile(remote, '/srv/case/.claude-images/paste-1.png', Buffer.from('x'))).rejects.toThrow(
      /disabled under test/
    );
  });

  it('never opens a connection: a stream fails through its own error path', async () => {
    const { stream, close } = remoteCreateReadStream(remote, '/srv/case/a.mp4');
    const failure = await new Promise<Error>((resolveError) => stream.on('error', resolveError));
    expect(failure).toBeInstanceOf(RemoteFileAccessError);
    expect(() => close()).not.toThrow();
  });
});

describe('buildRemoteReadCommand', () => {
  it('streams the whole file with cat', () => {
    expect(buildRemoteReadCommand("/srv/case/it's.mp4")).toBe("cat '/srv/case/it'\\''s.mp4'");
  });

  it('turns a byte range into a constant-memory tail | head', () => {
    expect(buildRemoteReadCommand('/srv/case/v.mp4', { start: 2, end: 5 })).toBe(
      "tail -c +3 '/srv/case/v.mp4' | head -c 4"
    );
  });

  it('covers the first byte of the file (tail -c +1, not +0)', () => {
    expect(buildRemoteReadCommand('/f', { start: 0, end: 0 })).toBe("tail -c +1 '/f' | head -c 1");
  });
});

describe('buildRemoteWriteCommand', () => {
  it('reads stdin into one shellescaped token', () => {
    expect(buildRemoteWriteCommand("/srv/case/it's.png")).toBe("cat > '/srv/case/it'\\''s.png'");
  });

  it('quotes spaces, globs and command substitution as literal filename text', () => {
    expect(buildRemoteWriteCommand('/srv/case/$(touch pwned) *.png')).toBe("cat > '/srv/case/$(touch pwned) *.png'");
  });
});
