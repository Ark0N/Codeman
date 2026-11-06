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
    // lstat guard must skip every existing link, which the old existsSync check missed:
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
      // The missing FILE target is skipped outright, not a dangling link either: lstat
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

  it('links from the SESSION-supplied DSH_HOME, not the server environment one', () => {
    // Both web routes pass the session's own env-override lookup as the seventh
    // argument; a user who relocated the dsh home via an allowlisted DSH_HOME
    // override must get their state linked from THAT directory, not the server's.
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-session-home-'));
    const serverHome = join(sandbox, 'server-home');
    const sessionHome = join(sandbox, 'session-home');
    mkdirSync(join(sessionHome, 'sessions'), { recursive: true });
    mkdirSync(join(sessionHome, 'profiles'), { recursive: true });
    writeFileSync(join(sessionHome, 'settings.yaml'), 'theme: light');
    vi.stubEnv('CODEMAN_DATA_DIR', join(sandbox, 'data'));
    vi.stubEnv('DSH_HOME', serverHome);
    try {
      const entry = getCli('deepseek');
      if (!entry) throw new Error('Missing DeepSeek entry');
      const endpoint = { id: 'local', label: 'Local', baseUrl: 'http://box:8080', apiKey: 'private-probe-key' };
      const applied = applyCustomModelInjection(
        entry,
        endpoint,
        'chosen-model',
        'deepseek-probe',
        131072,
        undefined,
        (k) => (k === 'DSH_HOME' ? sessionHome : undefined)
      );
      if (!applied?.configDir) throw new Error('Missing isolated profile');
      expect(realpathSync(join(applied.configDir, 'sessions'))).toBe(join(sessionHome, 'sessions'));
      expect(realpathSync(join(applied.configDir, 'profiles'))).toBe(join(sessionHome, 'profiles'));
      expect(realpathSync(join(applied.configDir, 'settings.yaml'))).toBe(join(sessionHome, 'settings.yaml'));
      // The server-environment home was never consulted, let alone created.
      expect(existsSync(serverHome)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('never self-links when the session override IS its own config dir; falls through to the server home', () => {
    // Boot recovery re-applies onto a session already holding a previous injection's
    // DSH_HOME value; linking that value would point the isolated directory at itself.
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-self-home-'));
    const serverHome = join(sandbox, 'server-home');
    mkdirSync(join(serverHome, 'sessions'), { recursive: true });
    vi.stubEnv('CODEMAN_DATA_DIR', join(sandbox, 'data'));
    vi.stubEnv('DSH_HOME', serverHome);
    try {
      const entry = getCli('deepseek');
      if (!entry) throw new Error('Missing DeepSeek entry');
      const endpoint = { id: 'local', label: 'Local', baseUrl: 'http://box:8080', apiKey: 'private-probe-key' };
      const applied = applyCustomModelInjection(
        entry,
        endpoint,
        'chosen-model',
        'deepseek-probe',
        131072,
        undefined,
        (k) => (k === 'DSH_HOME' ? customModelConfigDir('deepseek-probe') : undefined)
      );
      if (!applied?.configDir) throw new Error('Missing isolated profile');
      expect(realpathSync(join(applied.configDir, 'sessions'))).toBe(join(serverHome, 'sessions'));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('skips a relative DSH_HOME rather than creating it under the server cwd', () => {
    // A session may supply DSH_HOME; `work` would otherwise mkdir `work/sessions` in
    // the SERVER's working directory and leave relative links that dangle (a relative
    // home resolves against the CLI's cwd, which the server cannot know). Skipping it
    // falls through to the recipe's `realHomeFallback`, and nothing is created under cwd.
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-relative-home-'));
    const fallbackHome = join(sandbox, '.dsh');
    mkdirSync(fallbackHome, { recursive: true });
    const relativeHome = `dsh-relative-probe-${process.pid}-${Date.now()}`;
    vi.stubEnv('HOME', sandbox); // the fallback resolves under homedir()
    vi.stubEnv('CODEMAN_DATA_DIR', join(sandbox, 'data'));
    vi.stubEnv('DSH_HOME', relativeHome);
    try {
      const entry = getCli('deepseek');
      if (!entry) throw new Error('Missing DeepSeek entry');
      const endpoint = { id: 'local', label: 'Local', baseUrl: 'http://box:8080', apiKey: 'private-probe-key' };
      const applied = applyCustomModelInjection(entry, endpoint, 'chosen-model', 'deepseek-probe', 131072);
      if (!applied?.configDir) throw new Error('Missing isolated profile');
      expect(existsSync(join(process.cwd(), relativeHome))).toBe(false);
      expect(realpathSync(join(applied.configDir, 'sessions'))).toBe(join(fallbackHome, 'sessions'));
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
