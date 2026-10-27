/**
 * @fileoverview Issue #706 keeps LAN acknowledgement separate from public tunnel consent. A login, tunnel-specific env opt-in, launch flag or per-request acknowledgement permits enabling. Early refusals persist nothing; late race refusals save unrelated settings without enabling the tunnel. Status reports login configuration independently of exposure opt-ins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// Settings are written to disk via fs/promises; stub so the guard test never
// touches the real settings.json, and so we can assert "not persisted on refusal".
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
    // settings.json is written to a temp file and renamed over the real one (settings-writer.ts).
    realpath: vi.fn(async (p: string) => p),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

import fs from 'node:fs/promises';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedRename = vi.mocked(fs.rename);

/**
 * settings.json writes as [path, contents]. The writer (settings-writer.ts) writes each one to a
 * temp file and renames it over settings.json, so a write counts once its rename lands. Every
 * writeFile must be such a temp file and every one must be renamed into place: a direct write to
 * settings.json, or any other write that was never renamed, fails here rather than going unseen.
 */
function settingsWrites(): [string, string][] {
  const writes = mockedWriteFile.mock.calls.map(([path, contents]) => [String(path), String(contents)]);
  const renames = mockedRename.mock.calls.map(([from, to]) => [String(from), String(to)]);
  const isTemp = (path: string) => path.startsWith(`${SETTINGS_PATH}.`) && path.endsWith('.tmp');
  const notRenamed = writes.filter(([path]) => !isTemp(path) || !renames.some(([from]) => from === path));
  expect(
    notRenamed.map(([path]) => path),
    'writes that were not a temp file renamed into place'
  ).toEqual([]);
  expect(renames.length, 'one rename per write').toBe(writes.length);
  return renames.map(([from, to]) => {
    const write = writes.find(([path]) => path === from);
    expect(write, `rename of ${from}, which was never written`).toBeDefined();
    return [to, String(write?.[1])];
  });
}

const STATUS = { running: false, url: null };

function makeTunnelManager() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => false),
    getUrl: vi.fn(() => null),
    getStatus: vi.fn(() => ({ ...STATUS })),
  };
}

describe('tunnel authentication policy', () => {
  let harness: RouteTestHarness;
  let tunnel: ReturnType<typeof makeTunnelManager>;
  const envKeys = [
    'CODEMAN_PASSWORD',
    'CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK',
    'CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL',
    'CODEMAN_MULTIUSER',
  ] as const;
  let savedEnv: (string | undefined)[];

  beforeEach(async () => {
    savedEnv = envKeys.map((key) => process.env[key]);
    for (const key of envKeys) delete process.env[key];
    harness = await createRouteTestHarness(registerSystemRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    vi.clearAllMocks();
    vi.mocked(fs.readFile).mockResolvedValue('{}');
    mockedWriteFile.mockResolvedValue(undefined);
    tunnel = makeTunnelManager();
    (harness.ctx as unknown as { tunnelManager: unknown }).tunnelManager = tunnel;
    (harness.ctx as unknown as { allowUnauthenticatedTunnel: boolean }).allowUnauthenticatedTunnel = false;
  });

  afterEach(async () => {
    try {
      await harness?.app.close();
    } finally {
      envKeys.forEach((key, i) => {
        if (savedEnv[i] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[i];
      });
    }
  });

  const put = (payload: Record<string, boolean> = { tunnelEnabled: true }) =>
    harness.app.inject({ method: 'PUT', url: '/api/settings', payload });

  function expectRefused(res: Awaited<ReturnType<typeof put>>) {
    expect.soft(res.statusCode).toBe(403);
    expect.soft(res.json()).toEqual({
      success: false,
      errorCode: 'OPERATION_FAILED',
      error: expect.any(String),
    });
    expect.soft(tunnel.start.mock.calls).toEqual([]);
    expect.soft(mockedWriteFile.mock.calls).toEqual([]);
  }

  function expectEnabled(res: Awaited<ReturnType<typeof put>>) {
    expect(res.statusCode).toBe(200);
    expect(tunnel.start.mock.calls).toEqual([[harness.ctx.port, harness.ctx.https]]);
    expect(tunnel.stop.mock.calls).toEqual([]);
    expect(settingsWrites()).toEqual([[SETTINGS_PATH, JSON.stringify({ tunnelEnabled: true }, null, 2)]]);
  }

  it('refuses the incident: network acknowledgement does not authorize a public tunnel', async () => {
    process.env.CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK = '1';
    const res = await put();
    expectRefused(res);
    expect.soft(res.json().error).toContain('CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL');
    expect.soft(res.json().error).toContain('CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK');
    expect.soft(res.json().error).toMatch(/no longer/i);
  });

  it('refuses without credentials or acknowledgement and names the tunnel opt-in', async () => {
    const res = await put();
    expectRefused(res);
    expect(res.json().error).toContain('CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL');
  });

  it.each(['1', 'true', 'yes', 'on', ' TRUE '])(
    'allows tunnel env value %j without an acknowledgement',
    async (value) => {
      process.env.CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL = value;
      expectEnabled(await put());
    }
  );

  it('allows the route context flag without an env opt-in or acknowledgement', async () => {
    (harness.ctx as unknown as { allowUnauthenticatedTunnel: boolean }).allowUnauthenticatedTunnel = true;
    expectEnabled(await put());
  });

  it('allows acknowledgement alone and persists only tunnelEnabled', async () => {
    expectEnabled(await put({ tunnelEnabled: true, acknowledgeUnauthTunnel: true }));
  });

  it('refuses a false acknowledgement', async () => {
    expectRefused(await put({ tunnelEnabled: true, acknowledgeUnauthTunnel: false }));
  });

  it('allows a configured password without acknowledgement', async () => {
    process.env.CODEMAN_PASSWORD = 'test-password';
    expectEnabled(await put());
  });

  it('allows a multi-user admin without acknowledgement', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    expectEnabled(await put());
  });

  it.each(['0', 'false', '', 'enabled'])('refuses non-true tunnel env value %j', async (value) => {
    process.env.CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL = value;
    expectRefused(await put());
  });

  it('does not guard disabling a running tunnel', async () => {
    tunnel.isRunning.mockReturnValue(true);
    const res = await put({ tunnelEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(tunnel.start.mock.calls).toEqual([]);
    expect(tunnel.stop.mock.calls).toEqual([[]]);
    expect(settingsWrites()).toEqual([[SETTINGS_PATH, JSON.stringify({ tunnelEnabled: false }, null, 2)]]);
  });

  it.each([
    ['password', 'CODEMAN_PASSWORD', 'test-password', false, true],
    ['multi-user', 'CODEMAN_MULTIUSER', '1', false, true],
    ['neither', undefined, undefined, false, false],
    ['empty password', 'CODEMAN_PASSWORD', '', false, false],
    ['network opt-in only', 'CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK', '1', false, false],
    ['tunnel opt-in only', 'CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL', '1', false, false],
    ['tunnel flag only', undefined, undefined, true, false],
  ] as const)('status reports loginConfigured for %s', async (_label, key, value, flag, loginConfigured) => {
    if (key !== undefined) process.env[key] = value;
    (harness.ctx as unknown as { allowUnauthenticatedTunnel: boolean }).allowUnauthenticatedTunnel = flag;
    const res = await harness.app.inject({ method: 'GET', url: '/api/tunnel/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...STATUS, loginConfigured });
    expect(tunnel.getStatus.mock.calls).toEqual([[]]);
    expect(mockedWriteFile.mock.calls).toEqual([]);
  });
});

describe('tunnel enable authorization across a concurrent stop', () => {
  let harness: RouteTestHarness;
  let tunnel: ReturnType<typeof makeTunnelManager>;
  let running: boolean;
  let stopDuringWrite: boolean;
  let afterWrite: (() => void) | undefined;
  let storedSettings: Record<string, boolean>;
  const envKeys = [
    'CODEMAN_PASSWORD',
    'CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK',
    'CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL',
    'CODEMAN_MULTIUSER',
  ] as const;
  let savedEnv: (string | undefined)[];

  beforeEach(async () => {
    savedEnv = envKeys.map((key) => process.env[key]);
    for (const key of envKeys) delete process.env[key];
    harness = await createRouteTestHarness(registerSystemRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    vi.clearAllMocks();
    running = true;
    stopDuringWrite = true;
    afterWrite = undefined;
    storedSettings = { tunnelEnabled: false, subagentTrackingEnabled: false };
    tunnel = makeTunnelManager();
    tunnel.isRunning.mockImplementation(() => running);
    (harness.ctx as unknown as { tunnelManager: unknown }).tunnelManager = tunnel;
    (harness.ctx as unknown as { allowUnauthenticatedTunnel: boolean }).allowUnauthenticatedTunnel = false;
    vi.mocked(fs.readFile).mockImplementation(async (path) => {
      expect(path).toBe(SETTINGS_PATH);
      return JSON.stringify(storedSettings);
    });
    const pending = new Map<string, string>();
    const store = (contents: string) => {
      storedSettings = JSON.parse(contents);
      // The stop becomes visible during the awaited write, regardless of isRunning() call count.
      if (stopDuringWrite) running = false;
      afterWrite?.();
    };
    mockedWriteFile.mockImplementation(async (path, contents) => {
      // A direct write to settings.json lands at once, so the stored file is what the route really left;
      // settingsWrites() then fails it for not going through a temp file and a rename.
      if (path === SETTINGS_PATH) store(contents as string);
      else pending.set(String(path), contents as string);
    });
    mockedRename.mockImplementation(async (from, to) => {
      expect(to).toBe(SETTINGS_PATH);
      store(pending.get(String(from)) as string);
    });
  });

  afterEach(async () => {
    try {
      await harness?.app.close();
    } finally {
      envKeys.forEach((key, i) => {
        if (savedEnv[i] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[i];
      });
      vi.mocked(fs.readFile).mockResolvedValue('{}');
      mockedWriteFile.mockResolvedValue(undefined);
      mockedRename.mockResolvedValue(undefined);
    }
  });

  const put = (acknowledgement: Record<string, boolean> = {}) =>
    harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { tunnelEnabled: true, autoNameSessions: false, ...acknowledgement },
    });

  function expectWritten(tunnelEnabled: boolean) {
    const expected = { tunnelEnabled, subagentTrackingEnabled: false, autoNameSessions: false };
    // Check every write so a transient unauthorized enable followed by a rollback also fails.
    expect
      .soft(settingsWrites().map(([path, contents]) => ({ path, settings: JSON.parse(contents) })))
      .toEqual([{ path: SETTINGS_PATH, settings: expected }]);
    expect.soft(storedSettings).toEqual(expected);
  }

  function expectLateRefusal(res: Awaited<ReturnType<typeof put>>) {
    expect.soft(res.statusCode).toBe(403);
    expect.soft(res.json()).toEqual({
      success: false,
      errorCode: 'OPERATION_FAILED',
      error: expect.any(String),
    });
    expect.soft(res.json().error).toContain('CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL');
    expect.soft(res.json().error).toMatch(/not (re)?start/i);
    expect.soft(tunnel.start.mock.calls).toEqual([]);
    expect.soft(tunnel.stop.mock.calls).toEqual([]);
    expectWritten(false);
  }

  function expectAuthorizedRestart(res: Awaited<ReturnType<typeof put>>) {
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(tunnel.start.mock.calls).toEqual([[harness.ctx.port, harness.ctx.https]]);
    expect(tunnel.stop.mock.calls).toEqual([]);
    expectWritten(true);
  }

  it('refuses an unauthorized restart after a concurrent stop while saving other settings', async () => {
    expectLateRefusal(await put());
  });

  it.each(['password', 'tunnel env', 'route flag', 'per-request acknowledgement', 'multi-user admin'] as const)(
    'allows a restart with %s authorization',
    async (authorization) => {
      if (authorization === 'password') process.env.CODEMAN_PASSWORD = 'test-password';
      if (authorization === 'tunnel env') process.env.CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL = '1';
      if (authorization === 'route flag') {
        (harness.ctx as unknown as { allowUnauthenticatedTunnel: boolean }).allowUnauthenticatedTunnel = true;
      }
      if (authorization === 'multi-user admin') process.env.CODEMAN_MULTIUSER = '1';
      expectAuthorizedRestart(
        await put(authorization === 'per-request acknowledgement' ? { acknowledgeUnauthTunnel: true } : {})
      );
    }
  );

  it.each([false, true])(
    'preserves stored tunnelEnabled=%s when an unauthorized tunnel stays running',
    async (tunnelEnabled) => {
      stopDuringWrite = false;
      storedSettings.tunnelEnabled = tunnelEnabled;
      const res = await put();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
      expect(tunnel.start.mock.calls).toEqual([]);
      expect(tunnel.stop.mock.calls).toEqual([]);
      expectWritten(tunnelEnabled);
    }
  );

  it('does not acquire restart authorization from an env opt-in added during the write', async () => {
    afterWrite = () => {
      process.env.CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL = '1';
    };
    expectLateRefusal(await put());
  });

  it('retains the request authorization when the env opt-in is removed during the write', async () => {
    process.env.CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL = '1';
    afterWrite = () => {
      delete process.env.CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL;
    };
    expectAuthorizedRestart(await put());
  });
});
