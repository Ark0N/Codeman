/**
 * @fileoverview Pure builder for the Custom Model Endpoint Profiles feature
 * (deployment_plan.md): turns a CLI registry entry's
 * `capabilities.customModelInjection` declaration, a configured endpoint,
 * and a chosen model id into the concrete env vars / config-file content
 * that would redirect that CLI's session at the endpoint.
 *
 * No IO here on purpose (mirrors `session-cli-builder.ts`) — a caller
 * writes `ConfigDirInjection.files` to disk under an isolated per-session
 * directory and points `dirEnvVar` at it; this module only computes what
 * those files/env vars should contain.
 *
 * Confidence: `claude` and `opencode` are verified end-to-end against a real
 * llama-swap server (a real "hello world" reply came back). `codex`'s
 * config.toml STRUCTURE is now verified (an earlier `[model].default` table
 * shape was rejected by a real codex binary with "invalid type: map,
 * expected a string" — caught by `scripts/test-local-llm-harnesses.ts`),
 * but `wire_api = "responses"` is the only value codex still accepts
 * (support for `"chat"` was dropped in Feb 2026), and a plain OpenAI
 * Chat-Completions server (llama.cpp, llama-swap, most local setups) does
 * NOT implement the Responses API — so codex may still fail at the
 * PROTOCOL level even with a correctly-shaped config file. That gap is
 * real and current, not a stale warning; see deployment_plan.md. The rest
 * (gemini/pi/grok/deepseek/omp) have their ONE-SHOT INVOCATION flags
 * confirmed against real installed binaries' own `--help` output, but
 * their custom-endpoint env/config conventions remain web-researched,
 * unverified.
 */

import type { CliEntry } from './config/cli-registry/types.js';

export interface CustomModelEndpoint {
  id: string;
  label: string;
  /** Root URL, no trailing slash required — e.g. "http://192.168.1.50:8080" or an Azure AI Foundry URL. */
  baseUrl: string;
  /** Falls back to a harmless placeholder for endpoints (llama.cpp) that don't check it. */
  apiKey?: string;
}

export interface EnvInjection {
  kind: 'env';
  /** Ready to merge into a session's envOverrides. */
  envOverrides: Record<string, string>;
}

export interface ConfigDirInjection {
  kind: 'configDir';
  /** Env var that must be set to the directory the caller writes `files` under. */
  dirEnvVar: string;
  files: Array<{ relPath: string; content: string }>;
  /**
   * Env vars the written config file REFERENCES by name rather than embedding a
   * literal value (codex's `env_key = "..."` convention: config.toml never carries
   * the API key itself, only the name of an env var codex reads it from). Merge
   * these into the session's envOverrides alongside `dirEnvVar` — never skip them,
   * or the config points at a credential that was never actually set.
   */
  extraEnv?: Record<string, string>;
}

export interface UnsupportedInjection {
  kind: 'unsupported';
}

export type CustomModelInjectionResult = EnvInjection | ConfigDirInjection | UnsupportedInjection;

const DEFAULT_API_KEY = 'local-dummy-key';

/** Normalizes a base URL to end in exactly one trailing `/v1`, for CLIs whose config expects the OpenAI-style suffix. */
export function withV1Suffix(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** JSON-escapes a string for embedding in a TOML/YAML double-quoted scalar — a safe superset of both grammars' basic escapes. */
function quoted(value: string): string {
  return JSON.stringify(value);
}

export function buildCustomModelInjection(
  entry: Pick<CliEntry, 'capabilities'>,
  endpoint: CustomModelEndpoint,
  modelId: string
): CustomModelInjectionResult {
  const cap = entry.capabilities.customModelInjection;
  const apiKey = endpoint.apiKey?.trim() || DEFAULT_API_KEY;

  switch (cap.kind) {
    case 'env': {
      const envOverrides: Record<string, string> = {
        [cap.baseUrlVar]: endpoint.baseUrl,
        [cap.apiKeyVar]: apiKey,
      };
      for (const modelVar of cap.modelVars) envOverrides[modelVar] = modelId;
      return { kind: 'env', envOverrides };
    }

    case 'configContentEnv': {
      const content = renderConfigContent(cap.template, endpoint, modelId, apiKey);
      return { kind: 'env', envOverrides: { [cap.envVar]: content } };
    }

    case 'configDir': {
      const { content, extraEnv } = renderConfigFile(cap.template, endpoint, modelId, apiKey);
      return { kind: 'configDir', dirEnvVar: cap.dirEnvVar, files: [{ relPath: cap.fileName, content }], extraEnv };
    }

    case 'unsupported':
      return { kind: 'unsupported' };
  }
}

function renderConfigContent(
  template: 'opencode-json',
  endpoint: CustomModelEndpoint,
  modelId: string,
  apiKey: string
): string {
  switch (template) {
    case 'opencode-json':
      return JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          custom: {
            options: { baseURL: withV1Suffix(endpoint.baseUrl), apiKey },
            models: { [modelId]: {} },
          },
        },
        model: `custom/${modelId}`,
      });
  }
}

const CODEX_API_KEY_ENV_VAR = 'CODEMAN_CUSTOM_MODEL_API_KEY';

/** The `[model.<name>]` block name grok's config.toml uses for the injected model — also
 *  what `-m <name>` in the standalone script's ONE_SHOT argv must reference to select it. */
export const GROK_CUSTOM_MODEL_NAME = 'codeman-custom';

function renderConfigFile(
  template: 'codex-toml' | 'pi-models-json' | 'omp-models-yml' | 'grok-toml',
  endpoint: CustomModelEndpoint,
  modelId: string,
  apiKey: string
): { content: string; extraEnv?: Record<string, string> } {
  const baseUrl = withV1Suffix(endpoint.baseUrl);
  switch (template) {
    case 'codex-toml': {
      // Verified against real codex (>= Feb 2026): `model` is a top-level STRING, never
      // a `[model].default` table — codex rejects that with "invalid type: map, expected
      // a string" (caught by scripts/test-local-llm-harnesses.ts against a real llama-swap
      // server). The API key is NEVER a literal TOML field: codex's schema only supports
      // `env_key`, the NAME of an env var it reads the credential from at runtime, so the
      // actual value must ride along as an extra env var, never embedded in the file.
      // ⚠️ `wire_api = "responses"` is the only value codex still accepts (it dropped
      // `"chat"` support in Feb 2026) — a plain OpenAI Chat-Completions server (llama.cpp,
      // llama-swap, most local setups) does NOT implement the Responses API, so this
      // recipe may still fail at the PROTOCOL level even though the file now parses
      // correctly. That is a real, currently-unresolved compatibility gap, not a syntax
      // bug — track it before calling codex support done.
      const content = [
        `model = ${quoted(modelId)}`,
        `model_provider = "custom"`,
        '',
        '[model_providers.custom]',
        `name = "Custom Endpoint"`,
        `base_url = ${quoted(baseUrl)}`,
        `env_key = ${quoted(CODEX_API_KEY_ENV_VAR)}`,
        `wire_api = "responses"`,
        '',
      ].join('\n');
      return { content, extraEnv: { [CODEX_API_KEY_ENV_VAR]: apiKey } };
    }
    case 'pi-models-json':
      // Verified against pi's OWN bundled docs (models.md): `models` is an ARRAY of
      // `{id: "..."}` objects, NOT an object keyed by model id — the earlier shape here
      // silently loaded zero models ("No models available"), confirmed live. `authHeader:
      // true` is required too: pi does not automatically send `Authorization: Bearer
      // <apiKey>` just because `apiKey` is set (per the same doc) — without it, a real
      // (non-llama.cpp) endpoint that actually checks the key would reject every request.
      return {
        content: JSON.stringify(
          {
            providers: {
              custom: {
                baseUrl,
                apiKey,
                api: 'openai-completions',
                authHeader: true,
                models: [{ id: modelId }],
              },
            },
          },
          null,
          2
        ),
      };
    case 'omp-models-yml':
      // Mirrors the pi-models-json fix above (omp shares pi's config lineage per
      // CLAUDE.md — it reads several of pi's own env vars): a flat list of bare model
      // name strings under `models` is UNCONFIRMED against real omp docs (none are
      // bundled with the binary) — this now matches pi's `{id: "..."}` object-list
      // shape and adds `authHeader: true` on the same reasoning, but has not itself
      // been live-tested the way pi's fix was. Verify before raising its confidence.
      return {
        content: `providers:\n  custom:\n    baseUrl: ${quoted(baseUrl)}\n    apiKey: ${quoted(apiKey)}\n    api: openai-completions\n    authHeader: true\n    models:\n      - id: ${quoted(modelId)}\n`,
      };
    case 'grok-toml': {
      // Verified against xAI's own docs (docs.x.ai/build/settings/reference): a
      // `[model.<name>]` block, NOT plain env vars — an earlier `env`-kind recipe for
      // grok was wrong, not just unverified (see the customModelInjection doc comment
      // in cli-registry/types.ts). `api_backend = "chat_completions"` is explicitly
      // supported (unlike codex, which dropped it after Feb 2026), so this one CAN
      // talk to a plain OpenAI-compatible server directly. `env_key` reuses grok's own
      // documented fallback var name (XAI_API_KEY) rather than inventing a new one.
      const content = [
        `[model.${GROK_CUSTOM_MODEL_NAME}]`,
        `model = ${quoted(modelId)}`,
        `base_url = ${quoted(baseUrl)}`,
        `name = "Custom Endpoint"`,
        `env_key = "XAI_API_KEY"`,
        `api_backend = "chat_completions"`,
        '',
      ].join('\n');
      return { content, extraEnv: { XAI_API_KEY: apiKey } };
    }
  }
}
