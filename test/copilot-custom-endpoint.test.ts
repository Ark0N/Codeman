import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import { _clampEnvOverridesForOwner } from '../src/web/routes/session-routes.js';
import { CreateSessionSchema } from '../src/web/schemas.js';

const copilot = STOCK_CLIS.find((c) => (c.id as string) === 'copilot')!;

describe('GitHub Copilot custom endpoint (BYOK)', () => {
  it('injects its COPILOT_PROVIDER_* variables, with the /v1 suffix an OpenAI route needs', () => {
    expect(copilot.capabilities.customModelInjection).toEqual({
      kind: 'env',
      baseUrlVar: 'COPILOT_PROVIDER_BASE_URL',
      apiKeyVar: 'COPILOT_PROVIDER_API_KEY',
      modelVars: ['COPILOT_MODEL'],
      appendV1Suffix: true,
    });
  });

  it('keeps every injected variable privileged, so a non-granted owner cannot set them by hand', () => {
    const injection = copilot.capabilities.customModelInjection;
    if (injection.kind !== 'env') throw new Error('expected env injection');
    for (const name of [injection.baseUrlVar, injection.apiKeyVar, ...injection.modelVars]) {
      expect(copilot.capabilities.privilegedEnvKeys).toContain(name);
      expect(name.startsWith('COPILOT_')).toBe(true); // reachable through the prefix allowlist
    }
  });
});

describe('GitHub Copilot environment and sync declarations', () => {
  it('admits only its own COPILOT_ namespace, never the shared GitHub token names', () => {
    // The env allowlist is one global list with no mode context, so a foreign key here would be
    // settable on every session. COPILOT_GITHUB_TOKEN is already reachable through the prefix.
    expect(copilot.env.allowedPrefixes).toEqual(['COPILOT_']);
    expect(copilot.env.allowedKeys).toEqual([]);
  });

  it('declares its own MCP config so Settings does not list it as unsupported', () => {
    expect(copilot.capabilities.mcpConfig).toEqual({
      path: '.copilot/mcp-config.json',
      format: 'copilot-json',
      relocation: { envVar: 'COPILOT_HOME', path: 'mcp-config.json' },
    });
  });

  it('seeds no credentials into a Docker case', () => {
    expect(copilot.overlays?.credStore).toBeUndefined();
  });
});

describe('GitHub Copilot multi-user clamp: the env-var half', () => {
  // COPILOT_ is an allowlisted prefix, so every variable below would otherwise pass the schema.
  // Each one hands back what the allowAll clamp removed: an approval switch, code that runs with no
  // approval row (a CLI build, an editor, a key command, skills, hooks), or the sign-in token sent to
  // a host of the caller's choosing.
  const DANGEROUS: Record<string, string> = {
    COPILOT_ALLOW_ALL: 'true',
    COPILOT_PLAN_THEN_AUTOPILOT: '1',
    COPILOT_HOME: '/tmp/planted-copilot-home',
    COPILOT_CLI_DIST_DIR: '/tmp/planted-dist',
    COPILOT_PKG_CACHE_HOME: '/tmp/planted-cache',
    COPILOT_CACHE_HOME: '/tmp/planted-cache',
    COPILOT_EDITOR: 'sh -c planted',
    COPILOT_PROVIDER_API_KEY_COMMAND: 'sh -c planted',
    COPILOT_SKILLS_DIRS: '/tmp/planted-skills',
    COPILOT_PROVIDERS_CONFIG: '/tmp/planted-providers.json',
    COPILOT_API_URL: 'https://attacker.example',
    COPILOT_GH_HOST: 'attacker.example',
    COPILOT_PROVIDER_BASE_URL: 'https://attacker.example/v1',
    COPILOT_PROVIDER_HEADERS: 'X-Planted: 1',
  };
  const ORIGINAL = process.env.CODEMAN_MULTIUSER;
  beforeEach(() => {
    process.env.CODEMAN_MULTIUSER = '1';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = ORIGINAL;
  });

  it('passes the env allowlist, so only the clamp stands between these and the pane', () => {
    expect(() =>
      CreateSessionSchema.parse({ workingDir: '/tmp', mode: 'copilot', envOverrides: DANGEROUS })
    ).not.toThrow();
  });

  it("strips every one of them from a non-granted owner's overrides and keeps the harmless knobs", async () => {
    const out = await _clampEnvOverridesForOwner('nobody', {
      ...DANGEROUS,
      COPILOT_GITHUB_TOKEN: 'own-token',
      COPILOT_AUTO_UPDATE: 'false',
    });
    expect(out).toEqual({ COPILOT_GITHUB_TOKEN: 'own-token', COPILOT_AUTO_UPDATE: 'false' });
  });
});
