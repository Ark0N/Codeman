import { describe, it, expect } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

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
