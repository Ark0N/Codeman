/**
 * @fileoverview Route tests for /api/mcp-sync. Only CLIs that are ENABLED in the registry take
 * part; enabled agent CLIs with no known MCP config are reported as unsupported.
 *
 * ⚠️ test/setup.ts gives the whole FILE one temp HOME, so each test wipes the config files it
 * creates. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerMcpSyncRoutes } from '../../src/web/routes/mcp-sync-routes.js';
import { registryFilePath, reloadCliRegistry } from '../../src/config/cli-registry/registry.js';

const home = () => homedir();
const write = (rel: string, text: string) => {
  const f = join(home(), rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
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
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
  for (const d of ['.claude.json', '.codex', '.gemini', '.config'])
    rmSync(join(home(), d), { recursive: true, force: true });
  write(CLAUDE, JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: 'npx', args: ['-y', 'fs'] } } }));
});
afterEach(() => {
  delete process.env.CODEMAN_MULTIUSER;
  rmSync(registryFilePath(), { force: true });
  reloadCliRegistry();
});

describe('/api/mcp-sync', () => {
  it('GET previews without writing', async () => {
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/mcp-sync' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.applied).toBe(false);
    expect(body.data.targets.find((t: { id: string }) => t.id === 'codex').added).toEqual(['fs']);
    expect(existsSync(join(home(), CODEX))).toBe(false);
  });

  it('POST adds the server to every enabled CLI', async () => {
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    expect(res.json().data.applied).toBe(true);
    expect(readFileSync(join(home(), CODEX), 'utf8')).toContain('[mcp_servers.fs]');
    expect(JSON.parse(readFileSync(join(home(), GEMINI), 'utf8')).mcpServers.fs.command).toBe('npx');
  });

  it('never touches a CLI that is disabled in the registry', async () => {
    disable('codex');
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/mcp-sync' });
    const ids = res.json().data.targets.map((t: { id: string }) => t.id);
    expect(ids).not.toContain('codex');
    expect(ids).toContain('gemini');
    expect(existsSync(join(home(), '.codex'))).toBe(false);
    expect(existsSync(join(home(), GEMINI))).toBe(true);
  });

  it('lists enabled agent CLIs without MCP support, and omits disabled ones and the shell', async () => {
    disable('pi');
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes);
    const { unsupported } = (await app.inject({ method: 'GET', url: '/api/mcp-sync' })).json().data;
    expect(unsupported).toContain('Grok');
    expect(unsupported).not.toContain('Pi');
    expect(unsupported.some((l: string) => /shell|terminal/i.test(l))).toBe(false);
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

  it('multi-user: a non-admin is refused on both verbs and nothing is written', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes, {
      authUser: { username: 'bob', role: 'user' },
    });
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({ method, url: '/api/mcp-sync' });
      expect(res.json().success, method).toBe(false);
    }
    expect(existsSync(join(home(), CODEX))).toBe(false);
  });

  it('multi-user: an admin is allowed', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await createRouteTestHarness(registerMcpSyncRoutes, {
      authUser: { username: 'root', role: 'admin' },
    });
    expect((await app.inject({ method: 'GET', url: '/api/mcp-sync' })).json().success).toBe(true);
  });
});
