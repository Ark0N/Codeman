import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';
import { CASES_DIR, SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { resolveCodexLaunchDefaults } from '../../src/web/codex-launch-defaults.js';
import { buildCodexCommand } from '../../src/tmux-manager.js';
import { Session } from '../../src/session.js';
import { safeRmHomeTree } from '../mocks/index.js';
import { getDataDir } from '../../src/config/instance.js';
import { SettingsUpdateSchema } from '../../src/web/schemas.js';

vi.mock('../../src/utils/cli-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/cli-launcher.js')>();
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

describe('Codex launch defaults', () => {
  let harness: RouteTestHarness;
  const workingDir = join(homedir(), 'codex-default-test');

  beforeEach(async () => {
    for (const name of ['docker-hosts.json', 'docker-cases.json', 'remote-hosts.json', 'remote-cases.json']) {
      await rm(join(getDataDir(), name), { force: true });
    }
    await mkdir(workingDir, { recursive: true });
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify({ codexModel: 'gpt-6.1', codexReasoningEffort: 'high' }));
    harness = await createRouteTestHarness(registerSessionRoutes);
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await harness.app.close();
    safeRmHomeTree(CASES_DIR);
    safeRmHomeTree(workingDir);
    vi.restoreAllMocks();
  });

  async function createdConfig(url: string, overrides: Record<string, unknown> = {}) {
    const payload =
      url === '/api/sessions'
        ? { workingDir, mode: 'codex', ...overrides }
        : { caseName: 'codex-default-test', mode: 'codex', ...overrides };
    const res = await harness.app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().success, res.body).not.toBe(false);
    const session = [...harness.ctx.sessions.values()].at(-1) as Session | undefined;
    expect(session).toBeDefined();
    return session!.codexConfig;
  }

  for (const url of ['/api/sessions', '/api/quick-start']) {
    it(`applies persisted defaults at ${url} and emits the CLI options`, async () => {
      const config = await createdConfig(url);
      expect(config).toMatchObject({ model: 'gpt-6.1', reasoningEffort: 'high' });
      expect(buildCodexCommand(config)).toContain('--model gpt-6.1');
      expect(buildCodexCommand(config)).toContain('--config model_reasoning_effort=high');
    });

    it(`preserves explicit model and effort at ${url}`, async () => {
      expect(await createdConfig(url, { codexConfig: { model: 'gpt-other', reasoningEffort: 'low' } })).toMatchObject({
        model: 'gpt-other',
        reasoningEffort: 'low',
      });
    });
  }

  it('leaves empty defaults to Codex and ignores malformed persisted values', async () => {
    for (const settings of [
      { codexModel: '', codexReasoningEffort: '' },
      { codexModel: 'bad;command', codexReasoningEffort: 'invalid' },
    ]) {
      await writeFile(SETTINGS_PATH, JSON.stringify(settings));
      expect(await resolveCodexLaunchDefaults(undefined)).toBeUndefined();
      expect(buildCodexCommand(await resolveCodexLaunchDefaults(undefined))).toBe('codex');
    }
  });

  it('keeps defaults out of custom endpoint launches', async () => {
    const config = { model: 'local-model', animations: false };
    expect(await resolveCodexLaunchDefaults(config, true)).toBe(config);
  });

  it('does not record unused defaults for a Docker quick-start', async () => {
    await writeFile(
      join(getDataDir(), 'docker-hosts.json'),
      JSON.stringify([{ id: 'docker1', label: 'Docker', image: 'codeman/agent:base' }])
    );
    await writeFile(
      join(getDataDir(), 'docker-cases.json'),
      JSON.stringify([
        {
          name: 'codex-default-test',
          type: 'docker',
          hostId: 'docker1',
          hostWorkspacePath: workingDir,
          container: 'codeman-default-test',
        },
      ])
    );
    expect(await createdConfig('/api/quick-start')).toBeUndefined();
    const session = [...harness.ctx.sessions.values()].at(-1) as Session;
    expect(session.docker?.containerName).toBe('codeman-default-test');
    expect(session.toState().model).toBeUndefined();
  });

  it('does not record unused defaults for a remote attach', async () => {
    await writeFile(
      join(getDataDir(), 'remote-hosts.json'),
      JSON.stringify([{ id: 'remote1', label: 'Remote', host: '10.0.0.5', username: 'dev' }])
    );
    expect(
      await createdConfig('/api/sessions', {
        workingDir: undefined,
        attachRemoteSession: { hostId: 'remote1', remoteSessionName: 'codeman-existing' },
      })
    ).toBeUndefined();
    const session = [...harness.ctx.sessions.values()].at(-1) as Session;
    expect(session.toState().remote?.hostId).toBe('remote1');
    expect(session.toState().model).toBeUndefined();
  });

  it('does not record unused defaults for a remote quick-start', async () => {
    await writeFile(
      join(getDataDir(), 'remote-hosts.json'),
      JSON.stringify([{ id: 'remote1', label: 'Remote', host: '10.0.0.5', username: 'dev' }])
    );
    await writeFile(
      join(getDataDir(), 'remote-cases.json'),
      JSON.stringify([{ name: 'codex-default-test', type: 'remote', hostId: 'remote1', remotePath: '/home/dev/work' }])
    );
    expect(await createdConfig('/api/quick-start')).toBeUndefined();
    const session = [...harness.ctx.sessions.values()].at(-1) as Session;
    expect(session.toState().remote?.hostId).toBe('remote1');
    expect(session.toState().model).toBeUndefined();
  });

  it('accepts, persists, clears and validates synced settings via HTTP', async () => {
    const system = await createRouteTestHarness(registerSystemRoutes);
    try {
      const put = (payload: unknown) => system.app.inject({ method: 'PUT', url: '/api/settings', payload });
      expect((await put({ codexModel: 'gpt-6.1', codexReasoningEffort: 'xhigh' })).statusCode).toBe(200);
      const read = await system.app.inject({ method: 'GET', url: '/api/settings' });
      expect(read.json()).toMatchObject({ codexModel: 'gpt-6.1', codexReasoningEffort: 'xhigh' });
      expect((await put({ codexReasoningEffort: 'bogus' })).statusCode).toBe(400);
      expect((await put({ codexModel: 'bad;command' })).statusCode).toBe(400);
      expect((await put({ codexModel: '', codexReasoningEffort: '' })).statusCode).toBe(200);
      expect(await resolveCodexLaunchDefaults(undefined)).toBeUndefined();
    } finally {
      await system.app.close();
    }
  });

  it('the App Settings client check mirrors SettingsUpdateSchema.codexModel and runs before the local write', () => {
    // SettingsUpdateSchema is .strict(), so a codexModel the schema refuses 400s the
    // WHOLE settings PUT while the toast still says "Settings saved". saveAppSettings()
    // refuses it client-side with a copy of the schema's pattern; a looser copy brings
    // that silent 400 back, a stricter one refuses valid model ids. Length is left
    // out on purpose: the input's maxlength="100" covers .max(100).
    const src = readFileSync(resolve(import.meta.dirname, '../../src/web/public/settings-ui.js'), 'utf8');
    const start = src.indexOf('async saveAppSettings() {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    const m = body.match(/if \(!\/(\^\[[^\]\n]+\]\*\$)\/\.test\(settings\.codexModel\)\)/);
    expect(m).not.toBeNull();
    const client = new RegExp(m![1]);
    for (const v of ['', 'gpt-5.1', 'org/model_1-x', 'gpt-oss:20b', 'a b', 'bad;cmd', '-x', 'é']) {
      expect(client.test(v), v).toBe(SettingsUpdateSchema.safeParse({ codexModel: v }).success);
    }
    const guardAt = body.indexOf(m![0]);
    const writeAt = body.indexOf('this.saveAppSettingsToStorage(settings);');
    expect(writeAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(writeAt);
  });
});
