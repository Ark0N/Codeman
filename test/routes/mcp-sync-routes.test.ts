/**
 * @fileoverview Route tests for /api/mcp-sync. The feature is OPT-IN (`mcpSyncEnabled`, default
 * OFF): both verbs answer 403 until it is on. Only CLIs that are ENABLED in the registry take
 * part, and only if installed or already configured; enabled agent CLIs with no known MCP
 * config are reported as unsupported.
 *
 * ⚠️ test/setup.ts gives the whole FILE one temp HOME, so each test wipes the config files it
 * creates. Port: N/A (app.inject()).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerMcpSyncRoutes } from '../../src/web/routes/mcp-sync-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { registryFilePath, reloadCliRegistry } from '../../src/config/cli-registry/registry.js';
import { STOCK_CLIS } from '../../src/config/cli-registry/stock.js';
import { MCP_SYNC_ONLY_TOOLS } from '../../src/mcp-sync-targets.js';

// Which CLIs are installed on the machine running the tests must not decide the outcome: nothing
// is installed, so only a CLI whose config file exists takes part.
// Lets a test hold the module's real apply lock open: the first apply parks inside the mock
// (after taking the lock) until released, so a second POST deterministically overlaps it.
const hold = vi.hoisted(() => ({ release: null as null | (() => void), entered: null as null | (() => void) }));
vi.mock('../../src/mcp-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp-sync.js')>();
  return {
    ...actual,
    syncMcpServers: async (...args: Parameters<typeof actual.syncMcpServers>) => {
      if (!hold.release || !args[1].apply) return actual.syncMcpServers(...args);
      const parked = new Promise<void>((resolve) => (hold.release = resolve));
      hold.entered?.();
      const pending = actual.syncMcpServers(...args); // takes the lock synchronously
      await parked;
      return pending;
    },
  };
});

// Nothing is installed unless a test adds the id here.
const installed = vi.hoisted(() => new Set<string>());
vi.mock('../../src/utils/cli-installed-probes.js', () => ({
  probeStockCliAvailability: async () => ({}),
  isCliEntryInstalled: (e: { id: string }) => installed.has(e.id),
}));
// The sync-only tools (Copilot) probe the real PATH for their binary; route that through the same set.
vi.mock('../../src/mcp-sync-targets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp-sync-targets.js')>();
  return {
    ...actual,
    mcpSyncOnlyTargets: (taken: ReadonlySet<string>) =>
      actual.mcpSyncOnlyTargets(taken, (binary) => installed.has(binary)),
  };
});

// The route follows each CLI's relocation env var (CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME,
// ...) from process.env, so the runner's own values (CI images set XDG_CONFIG_HOME) must never
// aim a test write outside the temp HOME. Cleared before every test, restored after the file.
const RELOCATION_VARS = [
  ...STOCK_CLIS.flatMap((e) => {
    const envVar = e.capabilities.mcpConfig?.relocation?.envVar;
    return envVar ? [envVar] : [];
  }),
  ...MCP_SYNC_ONLY_TOOLS.flatMap((t) => (t.relocation ? [t.relocation.envVar] : [])),
];
const savedEnv = Object.fromEntries(RELOCATION_VARS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const home = () => homedir();
const write = (rel: string, text: string) => {
  const f = join(home(), rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
};
const setEnabled = (on: boolean | undefined) => {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(on === undefined ? {} : { mcpSyncEnabled: on }));
};
const disable = (...ids: string[]) => {
  const file = registryFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const clis = Object.fromEntries(ids.map((id) => [id, { enabled: false }]));
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, clis }), { mode: 0o600 });
  reloadCliRegistry();
};

const CLAUDE = '.claude.json';
const CODEX = '.codex/config.toml';
const GEMINI = '.gemini/settings.json';

beforeEach(() => {
  for (const k of RELOCATION_VARS) delete process.env[k];
  installed.clear();
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
  for (const d of ['.claude.json', '.codex', '.gemini', '.config', 'relocated'])
    rmSync(join(home(), d), { recursive: true, force: true });
  write(CLAUDE, JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'npx', args: ['-y', 'fs'] } } }));
  // Codex and Gemini have been set up on this machine (their config files exist).
  write(CODEX, 'model = "gpt-5"\n');
  write(GEMINI, '{}');
  setEnabled(true);
});
afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  rmSync(registryFilePath(), { force: true });
  rmSync(SETTINGS_PATH, { force: true });
  reloadCliRegistry();
});

describe('/api/mcp-sync — opt-in', () => {
  it.each([
    ['absent', undefined],
    ['false', false],
  ])('answers 403 on both verbs and writes nothing while the setting is %s', async (_label, value) => {
    setEnabled(value);
    const before = readFileSync(join(home(), CODEX), 'utf8');
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({ method, url: '/api/mcp-sync' });
      expect(res.statusCode, method).toBe(403);
      expect(res.json().error).toMatch(/disabled/i);
    }
    expect(readFileSync(join(home(), CODEX), 'utf8')).toBe(before);
  });

  it('applies the toggle on the next request, with no restart', async () => {
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    setEnabled(false);
    expect((await app.inject({ method: 'GET', url: '/api/mcp-sync' })).statusCode).toBe(403);
    setEnabled(true);
    expect((await app.inject({ method: 'GET', url: '/api/mcp-sync' })).statusCode).toBe(200);
  });
});

describe('/api/mcp-sync', () => {
  it('GET previews without writing', async () => {
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const before = readFileSync(join(home(), CODEX), 'utf8');
    const res = await app.inject({ method: 'GET', url: '/api/mcp-sync' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.applied).toBe(false);
    expect(body.data.targets.find((t: { id: string }) => t.id === 'codex').added).toEqual(['fs']);
    expect(readFileSync(join(home(), CODEX), 'utf8')).toBe(before);
  });

  it('POST adds the server to every enabled, set-up CLI', async () => {
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    expect(res.json().data.applied).toBe(true);
    expect(readFileSync(join(home(), CODEX), 'utf8')).toContain('[mcp_servers.fs]');
    expect(JSON.parse(readFileSync(join(home(), GEMINI), 'utf8')).mcpServers.fs.command).toBe('npx');
  });

  it('never creates config for an enabled CLI that is not installed and has no config file', async () => {
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    const opencode = res.json().data.targets.find((t: { id: string }) => t.id === 'opencode');
    // Nothing is installed (mocked) and opencode has no config under the temp HOME.
    expect(opencode.status).toBe('absent');
    expect(existsSync(join(home(), '.config'))).toBe(false);
  });

  it('never touches a CLI that is disabled in the registry', async () => {
    disable('codex');
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const before = readFileSync(join(home(), CODEX), 'utf8');
    const res = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    const ids = res.json().data.targets.map((t: { id: string }) => t.id);
    expect(ids).not.toContain('codex');
    expect(ids).toContain('gemini');
    expect(readFileSync(join(home(), CODEX), 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(join(home(), GEMINI), 'utf8')).mcpServers.fs.command).toBe('npx');
  });

  it('lists installed, enabled agent CLIs without MCP support, and omits disabled, uninstalled ones and the shell', async () => {
    installed.add('grok').add('pi');
    disable('pi');
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const { unsupported } = (await app.inject({ method: 'GET', url: '/api/mcp-sync' })).json().data;
    expect(unsupported).toEqual(['Grok']);
  });

  it('follows CODEX_HOME from the server env instead of writing the default ~/.codex', async () => {
    const codexHome = join(home(), 'relocated/codex');
    process.env.CODEX_HOME = codexHome;
    write('relocated/codex/config.toml', 'model = "gpt-5"\n');
    const before = readFileSync(join(home(), CODEX), 'utf8');
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    const codex = res.json().data.targets.find((t: { id: string }) => t.id === 'codex');
    expect(codex.file).toBe(join(codexHome, 'config.toml'));
    expect(codex.added).toEqual(['fs']);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain('[mcp_servers.fs]');
    expect(readFileSync(join(home(), CODEX), 'utf8')).toBe(before);
  });

  it('reports a relative CODEX_HOME as skipped and writes no codex file', async () => {
    process.env.CODEX_HOME = 'relative/codex';
    installed.add('codex');
    const before = readFileSync(join(home(), CODEX), 'utf8');
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    const codex = res.json().data.targets.find((t: { id: string }) => t.id === 'codex');
    expect(codex.status).toBe('skipped');
    expect(codex.error).toMatch(/CODEX_HOME/);
    expect(readFileSync(join(home(), CODEX), 'utf8')).toBe(before);
  });

  it('never echoes the text of a config file it cannot parse', async () => {
    write(CODEX, 'model = "gpt-5"\n[mcp_servers.linear]\nenv = { LINEAR_API_KEY = "lin_SECRET_abc" broken }\n');
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/mcp-sync' });
    const codex = res.json().data.targets.find((t: { id: string }) => t.id === 'codex');
    expect(codex.status).toBe('unreadable');
    expect(codex.error).toMatch(/^not valid TOML \(line 3, column \d+\)$/);
    expect(res.body).not.toContain('lin_SECRET_abc');
  });

  it('never returns env values or headers', async () => {
    write(
      CLAUDE,
      JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'npx', env: { TOKEN: 'sekrit-value' } } } })
    );
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    expect(res.body).not.toContain('sekrit-value');
  });

  it('answers 409 to an apply that overlaps another, and a later apply succeeds', async () => {
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    hold.release = () => undefined;
    const entered = new Promise<void>((resolve) => (hold.entered = resolve));
    const first = app.inject({ method: 'POST', url: '/api/mcp-sync' });
    await entered; // the first apply now holds the lock
    const release = hold.release;
    hold.release = null; // the overlapping request goes straight to the real function
    const second = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    expect(second.statusCode).toBe(409);
    expect(second.json().errorCode).toBe('CONFLICT');
    release?.();
    expect((await first).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/mcp-sync' })).statusCode).toBe(200);
  });

  it('multi-user: a non-admin is refused on both verbs and nothing is written', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    const before = readFileSync(join(home(), CODEX), 'utf8');
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({ method, url: '/api/mcp-sync' });
      expect(res.statusCode, method).toBe(403);
    }
    expect(readFileSync(join(home(), CODEX), 'utf8')).toBe(before);
  });

  it('multi-user: an admin is allowed', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    expect((await app.inject({ method: 'GET', url: '/api/mcp-sync' })).json().success).toBe(true);
  });
});
