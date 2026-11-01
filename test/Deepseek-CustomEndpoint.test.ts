import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCli } from '../src/config/cli-registry/index.js';
import { buildCustomModelInjection } from '../src/custom-model-injection.js';
import {
  applyCustomModelInjection,
  removeConfigDir,
  customModelConfigDir,
} from '../src/custom-model-injection-apply.js';

afterEach(() => {
  removeConfigDir(customModelConfigDir('deepseek-probe'));
  vi.unstubAllEnvs();
});

describe('DeepSeek custom endpoint isolation', () => {
  it('uses the chosen model and limits without changing installed profiles or embedding the key', () => {
    const realHome = join(homedir(), '.dsh');
    const profile = join(realHome, 'profiles', 'dsh-tui');
    mkdirSync(profile, { recursive: true });
    const original = join(profile, 'cordis.patch.yml');
    writeFileSync(original, 'original profile');
    vi.stubEnv('DSH_HOME', realHome);
    const entry = getCli('deepseek');
    if (!entry) throw new Error('Missing DeepSeek entry');
    const endpoint = { id: 'local', label: 'Local', baseUrl: 'http://box:8080', apiKey: 'private-probe-key' };
    const applied = applyCustomModelInjection(entry, endpoint, 'chosen-model', 'deepseek-probe', 131072);
    if (!applied?.configDir) throw new Error('Missing isolated profile');
    const content = readFileSync(join(applied.configDir, 'cordis.patch.yml'), 'utf8');
    expect(content).not.toContain(endpoint.apiKey);
    expect(applied.envOverrides.DEEPSEEK_API_KEY).toBe(endpoint.apiKey);
    const patch = JSON.parse(content);
    const provider = patch.find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers['codeman-custom'];
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseURL).toBe('http://box:8080/v1');
    expect(provider.models).toEqual([
      { id: 'chosen-model', name: 'chosen-model', contextWindow: 131072, maxTokens: 8192 },
    ]);
    expect(patch.find((row: { id: string }) => row.id === 'dsh-tui').config).toEqual({
      provider: 'codeman-custom',
      model: 'chosen-model',
    });
    expect(realpathSync(join(applied.configDir, 'profiles'))).toBe(join(realHome, 'profiles'));
    removeConfigDir(applied.configDir);
    expect(readFileSync(original, 'utf8')).toBe('original profile');
  });

  it('gives Codex its known context and compaction budget', () => {
    const entry = getCli('codex');
    if (!entry) throw new Error('Missing Codex entry');
    const injection = buildCustomModelInjection(
      entry,
      { id: 'local', label: 'Local', baseUrl: 'http://box' },
      'chosen-model',
      131072
    );
    if (injection.kind !== 'configDir') throw new Error('Expected isolated Codex config');
    expect(injection.files[0].content).toContain('model_context_window = 131072');
    expect(injection.files[0].content).toContain('model_auto_compact_token_limit = 98304');
    expect(injection.launchModel).toBe('chosen-model');
  });
});
