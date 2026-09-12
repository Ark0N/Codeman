/**
 * @fileoverview Contract tests for Custom Model Endpoint Profiles
 * (deployment_plan.md chunk 7): for every CLI with a `customModelInjection`
 * capability, build the real injection via `buildCustomModelInjection()`,
 * then replay those exact values through an HTTP request shaped the way that
 * CLI is documented to send it, against the in-process mock server
 * (`test/fixtures/mock-openai-server.ts`). Asserts the mock received the
 * request at the injected base URL, with the injected API key in the
 * expected header, and the injected model id in the body.
 *
 * LIMITATION (stated here and in deployment_plan.md, not left implicit): this
 * proves "if the CLI honors its documented env/config contract, it will hit
 * the right endpoint with the right model." It does NOT prove the real CLI
 * binary actually reads that env var / config file the way its docs say —
 * that's still the job of `scripts/test-local-llm-harnesses.ts` against a
 * real endpoint and real binaries. This suite catches regressions in
 * Codeman's own injection logic; it cannot catch a CLI changing its env-var
 * name in a future release.
 *
 * Port: N/A (mock server binds a random free port, not a fixed one)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCli } from '../src/config/cli-registry/index.js';
import { buildCustomModelInjection, type CustomModelEndpoint } from '../src/custom-model-injection.js';
import { startMockOpenAiServer, type MockOpenAiServer } from './fixtures/mock-openai-server.js';

let mock: MockOpenAiServer;

beforeEach(async () => {
  mock = await startMockOpenAiServer();
});

afterEach(async () => {
  await mock.close();
});

function entryOrThrow(id: string) {
  const entry = getCli(id);
  if (!entry) throw new Error(`missing CLI registry entry: ${id}`);
  return entry;
}

function endpointFor(mock: MockOpenAiServer): CustomModelEndpoint {
  return { id: 'ep1', label: 'mock', baseUrl: mock.baseUrl, apiKey: 'contract-test-key' };
}

/** Replays an OpenAI-shaped chat-completions call using the given base URL/key/model. */
async function callOpenAiCompat(baseUrl: string, apiKey: string, model: string) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello world' }] }),
  });
}

describe('custom-model-injection contract (mock server)', () => {
  it('claude: ANTHROPIC_BASE_URL/API_KEY reach a real Anthropic-shaped /v1/messages call', async () => {
    const injection = buildCustomModelInjection(entryOrThrow('claude'), endpointFor(mock), 'qwen3');
    if (injection.kind !== 'env') throw new Error('unreachable');

    await fetch(`${injection.envOverrides.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': injection.envOverrides.ANTHROPIC_API_KEY },
      body: JSON.stringify({
        model: injection.envOverrides.ANTHROPIC_DEFAULT_SONNET_MODEL,
        messages: [{ role: 'user', content: 'hello world' }],
      }),
    });

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].path).toBe('/v1/messages');
    expect(mock.requests[0].headers['x-api-key']).toBe('contract-test-key');
    expect((mock.requests[0].body as { model: string }).model).toBe('qwen3');
  });

  it('opencode: OPENCODE_CONFIG_CONTENT decodes to a baseURL/apiKey that reach the mock', async () => {
    const injection = buildCustomModelInjection(entryOrThrow('opencode'), endpointFor(mock), 'qwen3');
    if (injection.kind !== 'env') throw new Error('unreachable');
    const config = JSON.parse(injection.envOverrides.OPENCODE_CONFIG_CONTENT);
    const { baseURL, apiKey } = config.provider.custom.options;
    expect(baseURL).toBe(`${mock.baseUrl}/v1`);

    await callOpenAiCompat(baseURL, apiKey, 'qwen3');

    expect(mock.requests[0].path).toBe('/v1/chat/completions');
    expect(mock.requests[0].headers.authorization).toBe('Bearer contract-test-key');
    expect((mock.requests[0].body as { model: string }).model).toBe('qwen3');
  });

  it('codex: config.toml decodes to a base_url/model, and env_key/extraEnv reach the mock over /v1/responses', async () => {
    const injection = buildCustomModelInjection(entryOrThrow('codex'), endpointFor(mock), 'qwen3');
    if (injection.kind !== 'configDir') throw new Error('unreachable');
    const toml = injection.files[0].content;
    const baseUrl = /base_url = "([^"]+)"/.exec(toml)?.[1];
    const model = /^model = "([^"]+)"/m.exec(toml)?.[1];
    const envKeyName = /env_key = "([^"]+)"/.exec(toml)?.[1];
    expect(baseUrl).toBe(`${mock.baseUrl}/v1`);
    expect(model).toBe('qwen3');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).not.toContain('api_key ='); // never a literal TOML field
    expect(envKeyName).toBe('CODEMAN_CUSTOM_MODEL_API_KEY');
    expect(injection.extraEnv).toEqual({ CODEMAN_CUSTOM_MODEL_API_KEY: 'contract-test-key' });

    // The real credential rides as an env var (env_key names it) — replay it, not a
    // value read from the file, since the file itself never carries the secret.
    const apiKey = injection.extraEnv!.CODEMAN_CUSTOM_MODEL_API_KEY;
    await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: 'hello world' }),
    });

    expect(mock.requests[0].path).toBe('/v1/responses');
    expect(mock.requests[0].headers.authorization).toBe('Bearer contract-test-key');
  });

  it('pi: models.json decodes to a baseUrl/apiKey that reach the mock', async () => {
    const injection = buildCustomModelInjection(entryOrThrow('pi'), endpointFor(mock), 'qwen3');
    if (injection.kind !== 'configDir') throw new Error('unreachable');
    const parsed = JSON.parse(injection.files[0].content);
    const { baseUrl, apiKey } = parsed.providers.custom;
    expect(baseUrl).toBe(`${mock.baseUrl}/v1`);

    await callOpenAiCompat(baseUrl, apiKey, 'qwen3');

    expect(mock.requests[0].path).toBe('/v1/chat/completions');
    expect(mock.requests[0].headers.authorization).toBe('Bearer contract-test-key');
  });

  it('omp: models.yml decodes to a baseUrl/apiKey that reach the mock', async () => {
    const injection = buildCustomModelInjection(entryOrThrow('omp'), endpointFor(mock), 'qwen3');
    if (injection.kind !== 'configDir') throw new Error('unreachable');
    const yml = injection.files[0].content;
    const baseUrl = JSON.parse(/baseUrl: (".*")\n/.exec(yml)![1]);
    const apiKey = JSON.parse(/apiKey: (".*")\n/.exec(yml)![1]);
    expect(baseUrl).toBe(`${mock.baseUrl}/v1`);

    await callOpenAiCompat(baseUrl, apiKey, 'qwen3');

    expect(mock.requests[0].path).toBe('/v1/chat/completions');
    expect(mock.requests[0].headers.authorization).toBe('Bearer contract-test-key');
  });

  // gemini/deepseek's `env` kind passes the base URL through UNCHANGED (unlike
  // opencode/codex/pi/omp/grok, which build a structured config and explicitly append
  // /v1) — matching Anthropic's own convention for claude's ANTHROPIC_BASE_URL, where the
  // SDK appends the path itself. Whether each of these TWO CLIs' own OpenAI-compatible
  // client expects the var to already include /v1 (the common OpenAI-SDK convention) or
  // appends it itself is genuinely CLI-specific and UNVERIFIED (see the confidence table
  // in deployment_plan.md) — these tests model the common OpenAI-SDK convention (base_url
  // ends in /v1) since that's the more likely behavior for an OpenAI-compatible client,
  // but that assumption should be corrected here the moment it's checked against a real
  // binary. (grok WAS in this group too, until live-testing showed the whole `env` recipe
  // was wrong for it — see its own test below.)

  it('gemini: GOOGLE_GEMINI_BASE_URL/GEMINI_API_KEY reach the mock', async () => {
    const injection = buildCustomModelInjection(entryOrThrow('gemini'), endpointFor(mock), 'qwen3');
    if (injection.kind !== 'env') throw new Error('unreachable');

    await callOpenAiCompat(
      `${injection.envOverrides.GOOGLE_GEMINI_BASE_URL}/v1`,
      injection.envOverrides.GEMINI_API_KEY,
      injection.envOverrides.GEMINI_MODEL
    );

    expect(mock.requests[0].path).toBe('/v1/chat/completions');
    expect(mock.requests[0].headers.authorization).toBe('Bearer contract-test-key');
    expect((mock.requests[0].body as { model: string }).model).toBe('qwen3');
  });

  it('grok: config.toml [model.<name>] block base_url/env_key + extraEnv reach the mock over /v1/chat/completions', async () => {
    const injection = buildCustomModelInjection(entryOrThrow('grok'), endpointFor(mock), 'qwen3');
    if (injection.kind !== 'configDir') throw new Error('unreachable');
    const toml = injection.files[0].content;
    const baseUrl = /base_url = "([^"]+)"/.exec(toml)?.[1];
    const model = /^model = "([^"]+)"/m.exec(toml)?.[1];
    expect(baseUrl).toBe(`${mock.baseUrl}/v1`);
    expect(model).toBe('qwen3');
    expect(toml).toContain('api_backend = "chat_completions"');
    expect(injection.extraEnv).toEqual({ XAI_API_KEY: 'contract-test-key' });

    await callOpenAiCompat(baseUrl!, injection.extraEnv!.XAI_API_KEY, model!);

    expect(mock.requests[0].path).toBe('/v1/chat/completions');
    expect(mock.requests[0].headers.authorization).toBe('Bearer contract-test-key');
  });

  it('deepseek: DEEPSEEK_BASE_URL/DEEPSEEK_API_KEY reach the mock (base URL/key only, no model var)', async () => {
    const injection = buildCustomModelInjection(entryOrThrow('deepseek'), endpointFor(mock), 'qwen3');
    if (injection.kind !== 'env') throw new Error('unreachable');
    expect(Object.keys(injection.envOverrides).sort()).toEqual(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']);

    await callOpenAiCompat(
      `${injection.envOverrides.DEEPSEEK_BASE_URL}/v1`,
      injection.envOverrides.DEEPSEEK_API_KEY,
      'qwen3'
    );

    expect(mock.requests[0].path).toBe('/v1/chat/completions');
    expect(mock.requests[0].headers.authorization).toBe('Bearer contract-test-key');
  });

  it('antigravity: unsupported, never reaches the mock', () => {
    const injection = buildCustomModelInjection(entryOrThrow('antigravity'), endpointFor(mock), 'qwen3');
    expect(injection).toEqual({ kind: 'unsupported' });
    expect(mock.requests).toHaveLength(0);
  });

  it('mock server also answers GET /v1/models for the discovery route', async () => {
    const res = await fetch(`${mock.baseUrl}/v1/models`);
    const body = await res.json();
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(['qwen3', 'llama3']);
  });
});
