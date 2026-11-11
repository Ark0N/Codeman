/**
 * @fileoverview Tests for the Custom Model Endpoint Profiles pure builder.
 * Uses the real CLI registry entries (getCli) rather than hand-rolled
 * fixtures, so a change to a real entry's customModelInjection declaration
 * is exercised here automatically instead of silently diverging.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { getCli } from '../src/config/cli-registry/index.js';
import {
  buildCustomModelInjection,
  withV1Suffix,
  GROK_CUSTOM_MODEL_NAME,
  type CustomModelEndpoint,
} from '../src/custom-model-injection.js';

const endpoint: CustomModelEndpoint = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'my-key',
};

function entryOrThrow(id: string) {
  const entry = getCli(id);
  if (!entry) throw new Error(`missing CLI registry entry: ${id}`);
  return entry;
}

describe('withV1Suffix', () => {
  it('appends /v1 when missing', () => {
    expect(withV1Suffix('http://host:8080')).toBe('http://host:8080/v1');
  });

  it('is idempotent when already present', () => {
    expect(withV1Suffix('http://host:8080/v1')).toBe('http://host:8080/v1');
    expect(withV1Suffix('http://host:8080/v1/')).toBe('http://host:8080/v1');
  });

  it('strips a trailing slash with no /v1', () => {
    expect(withV1Suffix('http://host:8080/')).toBe('http://host:8080/v1');
  });
});

describe('buildCustomModelInjection', () => {
  it('claude: env kind sets base URL, api key, and all three tier model vars', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3');
    expect(result.kind).toBe('env');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides).toEqual({
      ANTHROPIC_BASE_URL: 'http://192.168.1.50:8080',
      ANTHROPIC_API_KEY: 'my-key',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3',
    });
  });

  it('claude: also declares configDirVar (CLAUDE_CONFIG_DIR isolation) on the env-kind result', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.configDirVar).toBe('CLAUDE_CONFIG_DIR');
  });

  it('claude: injects CLAUDE_CODE_MAX_CONTEXT_TOKENS when a context length is known', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', 16384);
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('16384');
  });

  it('claude: omits CLAUDE_CODE_MAX_CONTEXT_TOKENS when the context length is unknown', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('claude: also declares apiKeyTrustFile, carrying the literal apiKey used', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.apiKeyTrustFile).toEqual({ relPath: '.claude.json', shape: 'claude-api-key-responses' });
    expect(result.apiKey).toBe('my-key');
  });

  it('claude: also declares skipFirstRunPrompts on the env-kind result', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.skipFirstRunPrompts).toBe(true);
  });

  it('opencode: has no skipFirstRunPrompts (no apiKeyTrustFile/configDirVar concept for it either)', () => {
    const result = buildCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.skipFirstRunPrompts).toBeUndefined();
  });

  it('claude: falls back to a dummy key when the endpoint has none', () => {
    const result = buildCustomModelInjection(entryOrThrow('claude'), { ...endpoint, apiKey: undefined }, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides.ANTHROPIC_API_KEY).toBe('local-dummy-key');
  });

  it('opencode: configContentEnv carries a JSON blob in OPENCODE_CONFIG_CONTENT', () => {
    const result = buildCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3');
    expect(result.kind).toBe('env');
    if (result.kind !== 'env') throw new Error('unreachable');
    const parsed = JSON.parse(result.envOverrides.OPENCODE_CONFIG_CONTENT);
    expect(parsed.model).toBe('custom/qwen3');
    expect(parsed.provider.custom.options.baseURL).toBe('http://192.168.1.50:8080/v1');
    expect(parsed.provider.custom.options.apiKey).toBe('my-key');
    expect(parsed.provider.custom.models.qwen3).toEqual({});
  });

  it('opencode: threads a discovered context length into the model limit as the full window (issue #749)', () => {
    const result = buildCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3', 16384);
    if (result.kind !== 'env') throw new Error('unreachable');
    const parsed = JSON.parse(result.envOverrides.OPENCODE_CONFIG_CONTENT);
    // `limit.context` IS the full window to opencode (it reserves for the reply itself),
    // so the discovered total passes through; `output` only caps the reply at a quarter.
    expect(parsed.provider.custom.models.qwen3).toEqual({ limit: { context: 16384, output: 4096 } });
  });

  it('opencode: caps the response headroom reservation at 8192 for big windows', () => {
    const result = buildCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3', 262144);
    if (result.kind !== 'env') throw new Error('unreachable');
    const parsed = JSON.parse(result.envOverrides.OPENCODE_CONFIG_CONTENT);
    expect(parsed.provider.custom.models.qwen3).toEqual({ limit: { context: 262144, output: 8192 } });
  });

  it('opencode: never invents a limit for an unknown or non-finite context length (issue #749 regression)', () => {
    for (const contextLength of [undefined, NaN]) {
      const result = buildCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3', contextLength);
      if (result.kind !== 'env') throw new Error('unreachable');
      const parsed = JSON.parse(result.envOverrides.OPENCODE_CONFIG_CONTENT);
      expect(parsed.provider.custom.models.qwen3).toEqual({});
    }
  });

  it('codex: configDir writes an isolated config.toml with model/base_url, and the key rides as extraEnv (never a literal TOML field)', () => {
    const result = buildCustomModelInjection(entryOrThrow('codex'), endpoint, 'qwen3');
    expect(result.kind).toBe('configDir');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.dirEnvVar).toBe('CODEX_HOME');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relPath).toBe('config.toml');
    expect(result.files[0].content).toContain('model = "qwen3"');
    expect(result.files[0].content).toContain('base_url = "http://192.168.1.50:8080/v1"');
    expect(result.files[0].content).toContain('wire_api = "responses"');
    expect(result.files[0].content).not.toContain('api_key ='); // never a literal TOML field
    expect(result.files[0].content).toContain('env_key = "CODEMAN_CUSTOM_MODEL_API_KEY"');
    expect(result.extraEnv).toEqual({ CODEMAN_CUSTOM_MODEL_API_KEY: 'my-key' });
  });

  it('codex: escapes a quote in the model id so it cannot break out of the TOML string', () => {
    const result = buildCustomModelInjection(entryOrThrow('codex'), endpoint, 'weird"model');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.files[0].content).toContain('model = "weird\\"model"');
  });

  it('codex: writes the discovered window as TOP-LEVEL model_context_window with a 75% compact limit (issue #750)', () => {
    const result = buildCustomModelInjection(entryOrThrow('codex'), endpoint, 'qwen3', 16384);
    if (result.kind !== 'configDir') throw new Error('unreachable');
    const doc = parseToml(result.files[0].content) as Record<string, unknown>;
    // Top-level is the shape codex reads: parked under [model_providers.custom] (its
    // provider table) the same keys would be silently ignored by codex itself.
    expect(doc.model_context_window).toBe(16384);
    expect(doc.model_auto_compact_token_limit).toBe(12288); // 75% of the window, floored
    const provider = (doc.model_providers as Record<string, Record<string, unknown>>).custom;
    expect(provider.model_context_window).toBeUndefined();
    expect(provider.model_auto_compact_token_limit).toBeUndefined();
  });

  it('codex: writes neither context line for an unknown, non-finite or zero context length', () => {
    for (const contextLength of [undefined, NaN, 0]) {
      const result = buildCustomModelInjection(entryOrThrow('codex'), endpoint, 'qwen3', contextLength);
      if (result.kind !== 'configDir') throw new Error('unreachable');
      const doc = parseToml(result.files[0].content) as Record<string, unknown>;
      expect(doc.model_context_window, String(contextLength)).toBeUndefined();
      expect(doc.model_auto_compact_token_limit, String(contextLength)).toBeUndefined();
      expect(doc.model).toBe('qwen3'); // the rest of the file is still written
    }
  });

  it('pi: configDir writes .pi/agent/models.json, redirected via HOME (verified live — PI_CONFIG_DIR does nothing for pi)', () => {
    const result = buildCustomModelInjection(entryOrThrow('pi'), endpoint, 'qwen3');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.dirEnvVar).toBe('HOME');
    expect(result.files[0].relPath).toBe('.pi/agent/models.json');
    const parsed = JSON.parse(result.files[0].content);
    expect(parsed.providers.custom.baseUrl).toBe('http://192.168.1.50:8080/v1');
    expect(parsed.providers.custom.authHeader).toBe(true);
    expect(parsed.providers.custom.models).toEqual([{ id: 'qwen3' }]); // array, NOT keyed by id
  });

  it('pi: the model entry carries the endpoint window and a reply share of it, or pi takes the model for a 128k one', () => {
    const models = (contextLength?: number) => {
      const result = buildCustomModelInjection(entryOrThrow('pi'), endpoint, 'qwen3.6:35b-a3b', contextLength);
      if (result.kind !== 'configDir') throw new Error('unreachable');
      return JSON.parse(result.files[0].content).providers.custom.models;
    };
    // The full window, and 8192 reply tokens at most (measured on pi 1.5.2: the request then
    // carries max_tokens 8192 instead of its own 16384).
    expect(models(65536)).toEqual([{ id: 'qwen3.6:35b-a3b', contextWindow: 65536, maxTokens: 8192 }]);
    expect(models(131072.9)).toEqual([{ id: 'qwen3.6:35b-a3b', contextWindow: 131072, maxTokens: 8192 }]);
    // A small window keeps three quarters for the prompt.
    expect(models(16384)).toEqual([{ id: 'qwen3.6:35b-a3b', contextWindow: 16384, maxTokens: 4096 }]);
    // Unknown stays unknown: no limit is invented.
    for (const contextLength of [undefined, NaN, 0, -1, Infinity]) {
      expect(models(contextLength), String(contextLength)).toEqual([{ id: 'qwen3.6:35b-a3b' }]);
    }
  });

  it('omp: configDir writes .omp/agent/models.yml, redirected via HOME (verified live end-to-end)', () => {
    const result = buildCustomModelInjection(entryOrThrow('omp'), endpoint, 'qwen3');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.dirEnvVar).toBe('HOME');
    expect(result.files[0].relPath).toBe('.omp/agent/models.yml');
    expect(result.files[0].content).toContain('baseUrl: "http://192.168.1.50:8080/v1"');
    expect(result.files[0].content).toContain('authHeader: true');
    expect(result.files[0].content).toContain('- id: "qwen3"');
  });

  it('gemini: env kind sets GOOGLE_GEMINI_BASE_URL/GEMINI_API_KEY/GEMINI_MODEL', () => {
    const result = buildCustomModelInjection(entryOrThrow('gemini'), endpoint, 'qwen3');
    if (result.kind !== 'env') throw new Error('unreachable');
    expect(result.envOverrides).toEqual({
      GOOGLE_GEMINI_BASE_URL: 'http://192.168.1.50:8080',
      GEMINI_API_KEY: 'my-key',
      GEMINI_MODEL: 'qwen3',
    });
  });

  it('grok: configDir writes a config.toml [model.<name>] block, key rides as extraEnv (XAI_API_KEY)', () => {
    const result = buildCustomModelInjection(entryOrThrow('grok'), endpoint, 'qwen3');
    expect(result.kind).toBe('configDir');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.dirEnvVar).toBe('GROK_HOME');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relPath).toBe('config.toml');
    expect(result.files[0].content).toContain('model = "qwen3"');
    expect(result.files[0].content).toContain('base_url = "http://192.168.1.50:8080/v1"');
    expect(result.files[0].content).toContain('api_backend = "chat_completions"');
    expect(result.files[0].content).toContain('env_key = "XAI_API_KEY"');
    expect(result.files[0].content).not.toContain('api_key ='); // never a literal TOML field
    expect(result.extraEnv).toEqual({ XAI_API_KEY: 'my-key' });
  });

  it('deepseek: isolates the selected model route and passes its key by reference', () => {
    const result = buildCustomModelInjection(entryOrThrow('deepseek'), endpoint, 'qwen3');
    if (result.kind !== 'configDir') throw new Error('Expected isolated DeepSeek config');
    expect(result.dirEnvVar).toBe('DSH_HOME');
    expect(result.extraEnv).toEqual({ CODEMAN_CUSTOM_MODEL_API_KEY: 'my-key' });
    expect(result.files[0].content).not.toContain('my-key');
    const patch = JSON.parse(result.files[0].content);
    // The patch references the DEDICATED var by name, never dsh's own DEEPSEEK_API_KEY:
    // dsh's llm-deepseek/web-search rows read that too and would leak this key to
    // api.deepseek.com on an in-session /model switch back to the official route.
    expect(
      patch.find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers['codeman-custom'].apiKeyEnv
    ).toBe('CODEMAN_CUSTOM_MODEL_API_KEY');
    expect(result.files[0].content).not.toContain('DEEPSEEK_API_KEY');
    expect(patch.find((row: { id: string }) => row.id === 'dsh-tui').config.model).toBe('qwen3');
  });

  it('deepseek: preserves an existing version suffix', () => {
    const result = buildCustomModelInjection(
      entryOrThrow('deepseek'),
      { ...endpoint, baseUrl: endpoint.baseUrl + '/v1' },
      'qwen3'
    );
    if (result.kind !== 'configDir') throw new Error('Expected isolated DeepSeek config');
    expect(result.files[0].content).toContain('http://192.168.1.50:8080/v1');
    expect(result.files[0].content).not.toContain('/v1/v1');
  });

  it('antigravity: unsupported', () => {
    const result = buildCustomModelInjection(entryOrThrow('antigravity'), endpoint, 'qwen3');
    expect(result).toEqual({ kind: 'unsupported' });
  });

  it('shell: unsupported', () => {
    const result = buildCustomModelInjection(entryOrThrow('shell'), endpoint, 'qwen3');
    expect(result).toEqual({ kind: 'unsupported' });
  });
});

describe('launchModel (the model launch param that selects the injected provider)', () => {
  it('pi and omp get --model custom/<modelId>: the config file alone leaves them on their default provider', () => {
    for (const id of ['pi', 'omp']) {
      const result = buildCustomModelInjection(entryOrThrow(id), endpoint, 'qwen3.5-0.8b');
      if (result.kind !== 'configDir') throw new Error('unreachable');
      expect(result.launchModel, id).toBe('custom/qwen3.5-0.8b');
    }
  });

  it('grok gets the [model.<name>] block name, pinned to the constant the config template writes', () => {
    const result = buildCustomModelInjection(entryOrThrow('grok'), endpoint, 'qwen3');
    if (result.kind !== 'configDir') throw new Error('unreachable');
    expect(result.launchModel).toBe(GROK_CUSTOM_MODEL_NAME);
    expect(result.files[0].content).toContain(`[model.${GROK_CUSTOM_MODEL_NAME}]`);
  });

  it('CLIs whose config selects the model on its own declare none', () => {
    // codex now declares launchModel (selected-model launch override) and is covered by
    // its own restart coverage, not here.
    for (const id of ['claude', 'opencode', 'gemini', 'deepseek']) {
      const result = buildCustomModelInjection(entryOrThrow(id), endpoint, 'qwen3');
      if (result.kind === 'unsupported') throw new Error('unreachable');
      expect(result.launchModel, id).toBeUndefined();
    }
  });
});
