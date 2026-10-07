import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';
import { CASES_DIR, SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { resolveCodexLaunchDefaults } from '../../src/web/codex-launch-defaults.js';
import { buildCodexCommand } from '../../src/tmux-manager.js';
import { Session } from '../../src/session.js';
import { safeRmHomeTree } from '../mocks/index.js';

vi.mock('../../src/utils/cli-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/cli-launcher.js')>();
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

describe('Codex launch defaults', () => {
  let harness: RouteTestHarness;
  const workingDir = join(homedir(), 'codex-default-test');

  beforeEach(async () => {
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
});
