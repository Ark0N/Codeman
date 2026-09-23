import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXEC_TIMEOUT_MS } from '../src/config/exec-timeout.js';
import {
  cliResolveRetryDelayMs,
  createCliExecutableResolver,
  createProductionCliResolverHost,
  formatCliNotFoundMessage,
  invalidateCliExecutableResolvers,
  type CliResolverHost,
} from '../src/utils/cli-executable-resolver.js';

// Pass-through spy on execFileSync so the vitest-hermeticity test below can
// PROVE the un-injected production host never spawns anything.
const { execFileSyncSpy } = vi.hoisted(() => ({ execFileSyncSpy: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  execFileSyncSpy.mockImplementation(actual.execFileSync as (...args: unknown[]) => unknown);
  return { ...actual, execFileSync: execFileSyncSpy };
});

const BEGIN_MARKER = '__CODEMAN_CLI_RESOLVE_BEGIN__';
const END_MARKER = '__CODEMAN_CLI_RESOLVE_END__';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function host(overrides: Partial<CliResolverHost> = {}): CliResolverHost {
  return {
    processPath: '/usr/bin:/bin',
    shellPath: '/bin/bash',
    shellArgs: ['-i', '-l'],
    findOnProcessPath: vi.fn(() => null),
    findInLoginShell: vi.fn(() => null),
    exists: vi.fn(() => false),
    ...overrides,
  };
}

describe('createCliExecutableResolver', () => {
  it('prefers the server process PATH over common directories and the login shell', () => {
    const h = host({
      findOnProcessPath: vi.fn(() => '/process/bin/codex'),
      findInLoginShell: vi.fn(() => '/shell/bin/codex'),
      exists: vi.fn(() => true),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/known/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({ binaryPath: '/process/bin/codex', source: 'process-path' });
    expect(h.exists).toHaveBeenCalledTimes(1);
    expect(h.findInLoginShell).not.toHaveBeenCalled();
  });

  it('prefers common directories in order over the login shell', () => {
    const h = host({
      findInLoginShell: vi.fn(() => '/shell/bin/codex'),
      exists: vi.fn((path) => path === '/second/bin/codex' || path === '/shell/bin/codex'),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/first/bin', '/second/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({ binaryPath: '/second/bin/codex', source: 'common-directory' });
    expect(h.exists).toHaveBeenNthCalledWith(1, '/first/bin/codex');
    expect(h.exists).toHaveBeenNthCalledWith(2, '/second/bin/codex');
    expect(h.findInLoginShell).not.toHaveBeenCalled();
  });

  it('finds an executable exposed only by the interactive login shell', () => {
    const h = host({
      findInLoginShell: vi.fn(() => '/home/u/.nvm/versions/node/v22/bin/codex'),
      exists: vi.fn((path) => path === '/home/u/.nvm/versions/node/v22/bin/codex'),
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: ['/known/bin'] }, h);

    expect(resolver.resolve()).toMatchObject({
      binaryPath: '/home/u/.nvm/versions/node/v22/bin/codex',
      directory: '/home/u/.nvm/versions/node/v22/bin',
      source: 'login-shell',
    });
  });

  it('continues after a validator rejects an earlier candidate', () => {
    const h = host({
      findOnProcessPath: vi.fn(() => '/usr/bin/pi'),
      findInLoginShell: vi.fn(() => '/home/u/.npm/bin/pi'),
      exists: vi.fn(() => true),
    });
    const resolver = createCliExecutableResolver(
      {
        binary: 'pi',
        searchDirs: [],
        validateCandidate: (path) =>
          path.includes('.npm') ? { accepted: true, metadata: '0.84.1' } : { accepted: false },
      },
      h
    );

    expect(resolver.resolve()).toMatchObject({
      binaryPath: '/home/u/.npm/bin/pi',
      source: 'login-shell',
      metadata: '0.84.1',
    });
  });

  it('caches success, and retries a miss only after the backoff elapses', () => {
    let now = 0;
    const findInLoginShell = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValue('/new/bin/codex');
    const h = host({ findInLoginShell, exists: vi.fn((path) => path === '/new/bin/codex') });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [], now: () => now }, h);

    expect(resolver.resolve()).toBeNull();
    // Within the backoff window the miss is answered from the negative cache:
    // the chain — whose login-shell tail is a synchronous 5s-bounded spawn —
    // must NOT re-run per call, or a missing CLI stalls every status request.
    now = cliResolveRetryDelayMs(1) - 1;
    expect(resolver.resolve()).toBeNull();
    expect(findInLoginShell).toHaveBeenCalledTimes(1);

    // Once the backoff elapses the retry runs, so installing a CLI while the
    // server is up is still picked up without a restart.
    now = cliResolveRetryDelayMs(1);
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/codex');
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/codex');
    expect(findInLoginShell).toHaveBeenCalledTimes(2);
  });

  it('invalidation drops a negative-cache backoff immediately (a CLI installed from Settings)', () => {
    let now = 0;
    const findInLoginShell = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValue('/new/bin/grokx');
    const h = host({ findInLoginShell, exists: vi.fn((path) => path === '/new/bin/grokx') });
    const resolver = createCliExecutableResolver({ binary: 'grokx', searchDirs: [], now: () => now }, h);

    expect(resolver.resolve()).toBeNull();
    // Still inside the backoff window: without invalidation this answers from the
    // negative cache for up to five minutes after a successful install.
    now = 1;
    invalidateCliExecutableResolvers(['grokx']);
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/grokx');
    expect(findInLoginShell).toHaveBeenCalledTimes(2);
  });

  it('invalidation drops a cached success too, so an edited binary is re-resolved', () => {
    const findOnProcessPath = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('/old/bin/editedx')
      .mockReturnValue('/new/bin/editedx');
    const h = host({ findOnProcessPath, exists: vi.fn(() => true) });
    const resolver = createCliExecutableResolver({ binary: 'editedx', searchDirs: [] }, h);

    expect(resolver.resolve()?.binaryPath).toBe('/old/bin/editedx');
    expect(resolver.resolve()?.binaryPath).toBe('/old/bin/editedx');
    invalidateCliExecutableResolvers(['editedx']);
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/editedx');
    // And the fresh result is cached again rather than re-probed every call.
    expect(resolver.resolve()?.binaryPath).toBe('/new/bin/editedx');
    expect(findOnProcessPath).toHaveBeenCalledTimes(2);
  });

  it('invalidation is scoped to the named binaries and leaves every other cache alone', () => {
    const findOnProcessPath = vi.fn(() => '/bin/untouchedx');
    const h = host({ findOnProcessPath, exists: vi.fn(() => true) });
    const resolver = createCliExecutableResolver({ binary: 'untouchedx', searchDirs: [] }, h);

    resolver.resolve();
    invalidateCliExecutableResolvers(['some-other-binary']);
    resolver.resolve();
    expect(findOnProcessPath).toHaveBeenCalledTimes(1);
  });

  it('doubles the retry delay per consecutive miss and caps it at five minutes', () => {
    let now = 0;
    const findInLoginShell = vi.fn(() => null);
    const resolver = createCliExecutableResolver(
      { binary: 'codex', searchDirs: [], now: () => now },
      host({ findInLoginShell })
    );

    expect(cliResolveRetryDelayMs(0)).toBe(0);
    expect(cliResolveRetryDelayMs(1)).toBe(60_000);
    expect(cliResolveRetryDelayMs(2)).toBe(120_000);
    expect(cliResolveRetryDelayMs(3)).toBe(240_000);
    expect(cliResolveRetryDelayMs(4)).toBe(300_000);
    expect(cliResolveRetryDelayMs(60)).toBe(300_000);

    // Consecutive misses stack: after the second miss the SECOND delay applies.
    expect(resolver.resolve()).toBeNull();
    now += cliResolveRetryDelayMs(1);
    expect(resolver.resolve()).toBeNull();
    expect(findInLoginShell).toHaveBeenCalledTimes(2);
    now += cliResolveRetryDelayMs(2) - 1;
    expect(resolver.resolve()).toBeNull();
    expect(findInLoginShell).toHaveBeenCalledTimes(2);
    now += 1;
    expect(resolver.resolve()).toBeNull();
    expect(findInLoginShell).toHaveBeenCalledTimes(3);
  });

  it('rejects unsafe binary names', () => {
    const h = host();

    expect(() => createCliExecutableResolver({ binary: 'codex;id', searchDirs: [] }, h)).toThrow(
      'Unsafe CLI binary name'
    );
    expect(() => createCliExecutableResolver({ binary: '../codex', searchDirs: [] }, h)).toThrow(
      'Unsafe CLI binary name'
    );
  });

  it('rejects relative and nonexistent candidates', () => {
    let now = 0;
    const findInLoginShell = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('relative/codex')
      .mockReturnValue('/missing/codex');
    const h = host({ findInLoginShell, exists: vi.fn(() => false) });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [], now: () => now }, h);

    expect(resolver.resolve()).toBeNull();
    now = cliResolveRetryDelayMs(1);
    expect(resolver.resolve()).toBeNull();
    expect(h.exists).toHaveBeenCalledTimes(1);
    expect(h.exists).toHaveBeenCalledWith('/missing/codex');
  });
});

describe('formatCliNotFoundMessage', () => {
  it('includes only the base install hint and bounded resolution diagnostics', () => {
    const base = 'Codex CLI not found. Install with: npm install -g @openai/codex';
    const diagnostics = {
      binary: 'codex',
      processPath: '/usr/bin:/bin',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      searchDirs: ['/home/u/.local/bin', '/usr/local/bin'],
      API_KEY: 'super-secret',
    };
    const message = formatCliNotFoundMessage(base, diagnostics);

    expect(message).toContain(base);
    expect(message).toContain('Server PATH: /usr/bin:/bin');
    expect(message).toContain('Login shell: /bin/bash -i -l');
    expect(message).toContain('Checked directories: /home/u/.local/bin, /usr/local/bin');
    expect(message).not.toContain('API_KEY');
    expect(message).not.toContain('super-secret');
  });

  it('marks empty diagnostic values without dumping arbitrary environment data', () => {
    const message = formatCliNotFoundMessage('Missing CLI', {
      binary: 'codex',
      processPath: '',
      shellPath: '',
      shellArgs: [],
      searchDirs: [],
    });

    expect(message).toBe('Missing CLI\nServer PATH: (empty)\nLogin shell: (none)\nChecked directories: (none)');
    expect(message).not.toContain('HOME=');
    expect(message).not.toContain('TOKEN=');
  });

  it('flattens control characters and bounds every diagnostic field', () => {
    const pathological = `first\r\nforged label: value\u0000${'x'.repeat(10_000)}`;
    const message = formatCliNotFoundMessage('Missing CLI', {
      binary: 'codex',
      processPath: pathological,
      shellPath: pathological,
      shellArgs: [pathological],
      searchDirs: [pathological, pathological],
    });
    const lines = message.split('\n');

    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^Server PATH: first forged label: value x+…$/);
    expect(lines[2]).toMatch(/^Login shell: first forged label: value x+…$/);
    expect(lines[3]).toMatch(/^Checked directories: first forged label: value x+…$/);
    expect(lines.slice(1).every((line) => line.length <= 1_050)).toBe(true);
  });
});

describe('createProductionCliResolverHost', () => {
  // Hermeticity gate (the guards PR #329 deleted, restored shared): under
  // vitest an un-injected host must neither scan the machine nor spawn a login
  // shell — route tests hitting the per-CLI status endpoints would otherwise
  // walk the real PATH and execute real binaries on whatever box runs the suite.
  it('never scans the machine or spawns a login shell under vitest without injected IO', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeman-cli-vitest-gate-'));
    temporaryDirectories.push(root);
    writeFileSync(join(root, 'codex'), '#!/bin/sh\n');
    chmodSync(join(root, 'codex'), 0o755);
    execFileSyncSpy.mockClear();

    const gatedHost = createProductionCliResolverHost({
      processPath: root,
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
    });

    // The real, executable candidate is invisible: the filesystem predicate is inert.
    expect(gatedHost.findOnProcessPath('codex')).toBeNull();
    expect(gatedHost.exists(join(root, 'codex'))).toBe(false);
    // The login-shell step yields nothing and never reaches execFileSync.
    expect(gatedHost.findInLoginShell('codex')).toBeNull();
    expect(execFileSyncSpy).not.toHaveBeenCalled();

    // The same fixture through the test-only real-IO opt-in IS found, proving
    // the nulls above come from the vitest gate rather than from the fixture.
    const optedInHost = createProductionCliResolverHost({
      processPath: root,
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      runCommand: () => '',
      allowRealIoUnderVitest: true,
    });
    expect(optedInHost.findOnProcessPath('codex')).toBe(join(root, 'codex'));
  });

  it('resolves through injected IO hooks under vitest (injection is the opt-in)', () => {
    const runCommand = vi.fn(() => `${BEGIN_MARKER}\n/home/u/.nvm/bin/codex\n${END_MARKER}`);
    const productionHost = createProductionCliResolverHost({
      processPath: '',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      runCommand,
      isExecutableFile: () => true,
    });
    const resolver = createCliExecutableResolver({ binary: 'codex', searchDirs: [] }, productionHost);

    expect(resolver.resolve()).toMatchObject({
      binaryPath: '/home/u/.nvm/bin/codex',
      source: 'login-shell',
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('searches the captured process PATH directly in directory order without running a command', () => {
    const runCommand = vi.fn(() => '');
    const isExecutableFile = vi.fn((path: string) => path === '/second/bin/codex');
    const productionHost = createProductionCliResolverHost({
      processPath: '/first/bin:/second/bin:/third/bin',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      runCommand,
      isExecutableFile,
    });

    expect(productionHost.findOnProcessPath('codex')).toBe('/second/bin/codex');
    expect(isExecutableFile).toHaveBeenNthCalledWith(1, '/first/bin/codex');
    expect(isExecutableFile).toHaveBeenNthCalledWith(2, '/second/bin/codex');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('accepts only executable regular files with the production predicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeman-cli-resolver-'));
    temporaryDirectories.push(root);
    const executableDirectory = join(root, 'executable');
    const plainDirectory = join(root, 'plain');
    const directoryCandidate = join(root, 'directory');
    mkdirSync(executableDirectory);
    mkdirSync(plainDirectory);
    mkdirSync(directoryCandidate);
    writeFileSync(join(executableDirectory, 'codex'), '#!/bin/sh\n');
    chmodSync(join(executableDirectory, 'codex'), 0o755);
    writeFileSync(join(plainDirectory, 'codex'), '#!/bin/sh\n');
    mkdirSync(join(directoryCandidate, 'codex'));
    const productionHost = createProductionCliResolverHost({
      processPath: [directoryCandidate, plainDirectory, executableDirectory].join(':'),
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      // This test exists to exercise the REAL executable-regular-file predicate
      // against its own temp fixtures, so it opts out of the vitest inert-IO
      // gate; the stubbed runCommand keeps the login-shell path inert anyway.
      runCommand: () => '',
      allowRealIoUnderVitest: true,
    });

    expect(productionHost.findOnProcessPath('codex')).toBe(join(executableDirectory, 'codex'));
  });

  it('uses the resolved shell, allowlisted args, tagged command, and bounded timeout', () => {
    const runCommand = vi.fn(() =>
      ['/profile/absolute-noise', BEGIN_MARKER, '/home/u/.nvm/bin/codex', END_MARKER, '/exit-trap/absolute-noise'].join(
        '\n'
      )
    );
    const productionHost = createProductionCliResolverHost({
      processPath: '',
      shellPath: '/usr/bin/fish',
      shellArgs: ['-i', '-l'],
      runCommand,
      isExecutableFile: () => true,
    });

    expect(productionHost.findInLoginShell('codex')).toBe('/home/u/.nvm/bin/codex');
    expect(runCommand).toHaveBeenCalledWith(
      '/usr/bin/fish',
      ['-i', '-l', '-c', `printf '%s\\n' '${BEGIN_MARKER}'; command -v -- codex; printf '%s\\n' '${END_MARKER}'`],
      {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        // SIGKILL is load-bearing: interactive bash ignores SIGTERM, and
        // execFileSync's timeout only sends the signal, then keeps waiting.
        killSignal: 'SIGKILL',
      }
    );
  });

  it.each([
    ['mismatched basename', `${BEGIN_MARKER}\n/opt/bin/not-codex\n${END_MARKER}`],
    ['missing begin marker', `/opt/bin/codex\n${END_MARKER}`],
    ['missing end marker', `${BEGIN_MARKER}\n/opt/bin/codex`],
    ['absolute output outside markers', `/profile/codex\n${BEGIN_MARKER}\nrelative/codex\n${END_MARKER}\n/exit/codex`],
  ])('rejects malformed tagged shell output: %s', (_name, output) => {
    const productionHost = createProductionCliResolverHost({
      processPath: '',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      runCommand: () => output,
      isExecutableFile: () => true,
    });

    expect(productionHost.findInLoginShell('codex')).toBeNull();
  });

  it('returns null when the shell command throws', () => {
    const productionHost = createProductionCliResolverHost({
      processPath: '',
      shellPath: '/bin/bash',
      shellArgs: ['-i', '-l'],
      runCommand: () => {
        throw new Error('exit 1');
      },
      isExecutableFile: () => true,
    });

    expect(productionHost.findInLoginShell('codex')).toBeNull();
  });
});
