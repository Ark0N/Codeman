import { mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    mkdirSync(join(realHome, 'sessions'), { recursive: true });
    writeFileSync(join(realHome, 'settings.yaml'), 'theme: dark');
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
    // The rest of the linkFromRealHome list, consumed generically: `sessions` is the
    // transcript root removeConfigDir would otherwise delete, and the user's settings.yaml
    // must keep applying through the redirect.
    expect(realpathSync(join(applied.configDir, 'sessions'))).toBe(join(realHome, 'sessions'));
    expect(realpathSync(join(applied.configDir, 'settings.yaml'))).toBe(join(realHome, 'settings.yaml'));
    // Re-apply onto the same config dir (boot recovery re-runs this every restart) with one
    // link dangling: the lstat guard must skip every existing link, broken ones included,
    // which the old existsSync check missed — recreating them would raise EEXIST.
    rmSync(join(realHome, 'sessions'), { recursive: true, force: true });
    const reapplied = applyCustomModelInjection(entry, endpoint, 'chosen-model', 'deepseek-probe', 131072);
    expect(reapplied?.envOverrides.DSH_HOME).toBe(applied.configDir);
    expect(readlinkSync(join(applied.configDir, 'sessions'))).toBe(join(realHome, 'sessions'));
    expect(readFileSync(original, 'utf8')).toBe('original profile');
    removeConfigDir(applied.configDir);
    expect(readFileSync(original, 'utf8')).toBe('original profile');
  });
});
