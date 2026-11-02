import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
    // The dedicated key var, never DEEPSEEK_API_KEY: dsh's own llm-deepseek/web-search
    // rows read that too, and an in-session /model switch back to the official route must
    // not take the custom endpoint's key to api.deepseek.com with it.
    expect(applied.envOverrides.CODEMAN_CUSTOM_MODEL_API_KEY).toBe(endpoint.apiKey);
    expect(applied.envOverrides.DEEPSEEK_API_KEY).toBeUndefined();
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
    // Re-apply onto the same config dir (boot recovery re-runs this every restart): the
    // lstat guard must skip every existing link, which the old existsSync check missed —
    // recreating them would raise EEXIST.
    const reapplied = applyCustomModelInjection(entry, endpoint, 'chosen-model', 'deepseek-probe', 131072);
    expect(reapplied?.envOverrides.DSH_HOME).toBe(applied.configDir);
    removeConfigDir(applied.configDir);
    expect(readFileSync(original, 'utf8')).toBe('original profile');
  });

  it('creates missing directory targets before linking, skips a missing file target, stays fine on re-apply', () => {
    // A fresh install (or relocated DSH_HOME) has never run a turn, so the real home
    // carries none of the linked entries. Linking a missing DIRECTORY left a dangling
    // symlink whose every write dsh attempts THROUGH it failed with ENOENT on EVERY turn,
    // and the lstat guard kept that dangling link forever. Directories are now created
    // (0700, what dsh itself does on a first turn) before linking; a missing FILE
    // (`settings.yaml`) is simply skipped. A stubbed HOME and CODEMAN_DATA_DIR keep both
    // the fake real home and the generated dir off the developer's own dotfiles.
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-fresh-home-'));
    const realHome = join(sandbox, '.dsh');
    mkdirSync(realHome, { recursive: true }); // exists, but no sessions/, no profiles/, no settings.yaml
    vi.stubEnv('HOME', sandbox);
    vi.stubEnv('CODEMAN_DATA_DIR', join(sandbox, 'data'));
    vi.stubEnv('DSH_HOME', ''); // force resolution down to the recipe's `realHomeFallback`
    try {
      const entry = getCli('deepseek');
      if (!entry) throw new Error('Missing DeepSeek entry');
      const endpoint = { id: 'local', label: 'Local', baseUrl: 'http://box:8080', apiKey: 'private-probe-key' };
      const applied = applyCustomModelInjection(entry, endpoint, 'chosen-model', 'deepseek-probe', 131072);
      if (!applied?.configDir) throw new Error('Missing isolated profile');

      expect(realpathSync(join(applied.configDir, 'sessions'))).toBe(join(realHome, 'sessions'));
      expect(realpathSync(join(applied.configDir, 'profiles'))).toBe(join(realHome, 'profiles'));
      expect(statSync(join(realHome, 'sessions')).mode & 0o777).toBe(0o700);
      // The missing FILE target is skipped outright: not a dangling link either — lstat
      // must find nothing, so a later apply (once the file exists for real) links it.
      expect(existsSync(join(realHome, 'settings.yaml'))).toBe(false);
      expect(readlinkSafe(join(applied.configDir, 'settings.yaml'))).toBeUndefined();

      // Re-apply stays fine (boot recovery re-runs it every restart): idempotent...
      const reapplied = applyCustomModelInjection(entry, endpoint, 'chosen-model', 'deepseek-probe', 131072);
      expect(reapplied?.envOverrides.DSH_HOME).toBe(applied.configDir);
      // ...and a target deleted AFTER linking keeps the existing link untouched (the
      // lstat guard), rather than recreating it and throwing EEXIST.
      rmSync(join(realHome, 'sessions'), { recursive: true, force: true });
      expect(
        applyCustomModelInjection(entry, endpoint, 'chosen-model', 'deepseek-probe', 131072)?.envOverrides.DSH_HOME
      ).toBe(applied.configDir);
      expect(readlinkSync(join(applied.configDir, 'sessions'))).toBe(join(realHome, 'sessions'));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

/** readlinkSync without the throw an absent link causes (ENOENT -> undefined). */
function readlinkSafe(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}
