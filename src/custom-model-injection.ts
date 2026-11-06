/**
 * @fileoverview Pure builder for the Custom Model Endpoint Profiles feature
 * (docs/custom-model-endpoints-plan.md): turns a CLI registry entry's
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
 * (support for `"chat"` was dropped in Feb 2026). ⚠️ Re-verified live
 * against a llama-swap deployment that DOES answer `/v1/responses`: a
 * plain, no-tool-call turn gets a real reply, but a real tool-call attempt
 * comes back as `agent_message` TEXT (the tool-call JSON printed as the
 * answer) rather than a `function_call` item codex would execute —
 * confirmed via `codex exec --json`'s raw event stream. Tool execution is
 * what makes codex a coding agent, so this remains not usable for real
 * work even where plain chat succeeds; see docs/custom-model-endpoints-plan.md
 * for the full picture (including the harmless `Model metadata ... not
 * found` warning every custom-endpoint codex session prints — sourced from
 * a local cache of OpenAI's OWN hosted model catalog that a custom model
 * can never appear in, confirmed to have no effect on the outcome above).
 * The rest (gemini/pi/grok/deepseek/omp) have their ONE-SHOT INVOCATION
 * flags confirmed against real installed binaries' own `--help` output,
 * but their custom-endpoint env/config conventions remain web-researched,
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
  /** See {@link ConfigDirInjection.launchModel}. */
  launchModel?: string;
  /**
   * Name of the env var the caller should point at an isolated, credential-free config
   * directory for this session (claude's `CLAUDE_CONFIG_DIR`), from the registry entry's
   * `customModelInjection.configDirVar`. The actual directory value isn't computed here —
   * this module is pure and has no sessionId to derive one from — the IO wrapper
   * (`custom-model-injection-apply.ts`) creates it and adds it to `envOverrides`.
   */
  configDirVar?: string;
  /** See `customModelInjection.apiKeyTrustFile` — carried through so the IO wrapper can seed it. */
  apiKeyTrustFile?: { relPath: string; shape: 'claude-api-key-responses' };
  /** The literal API key value this injection used, for `apiKeyTrustFile` to pre-approve. */
  apiKey?: string;
  /** See `customModelInjection.skipFirstRunPrompts` — carried through so the IO wrapper can seed it. */
  skipFirstRunPrompts?: boolean;
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
  /**
   * The value the CLI's `model` launch param must carry for it to SELECT the injected
   * provider (pi/omp: `custom/<modelId>`; grok: the `[model.<name>]` block name). Absent
   * when the config alone selects the model. Rendered from the registry entry's
   * `customModelInjection.launchModel` template, never hand-built per CLI.
   */
  launchModel?: string;
  /** Carried from the registry recipe, see `cli-registry/types.ts` `linkFromRealHome`. */
  linkFromRealHome?: string[];
  /** Carried from the registry recipe, see `cli-registry/types.ts` `linkFromRealHomeDirs`. */
  linkFromRealHomeDirs?: string[];
  /** Carried from the registry recipe, see `cli-registry/types.ts` `realHomeFallback`. */
  realHomeFallback?: string;
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
  modelId: string,
  /** Discovered context-window size for `modelId`, if known — see `contextLengthVar`. */
  contextLength?: number
): CustomModelInjectionResult {
  const cap = entry.capabilities.customModelInjection;
  const apiKey = endpoint.apiKey?.trim() || DEFAULT_API_KEY;

  switch (cap.kind) {
    case 'env': {
      const envOverrides: Record<string, string> = {
        [cap.baseUrlVar]: cap.appendV1Suffix ? withV1Suffix(endpoint.baseUrl) : endpoint.baseUrl,
        [cap.apiKeyVar]: apiKey,
      };
      for (const modelVar of cap.modelVars) envOverrides[modelVar] = modelId;
      if (cap.contextLengthVar && contextLength !== undefined && Number.isFinite(contextLength)) {
        envOverrides[cap.contextLengthVar] = String(Math.trunc(contextLength));
      }
      let result: EnvInjection = withLaunchModel({ kind: 'env', envOverrides }, cap.launchModel, modelId);
      if (cap.configDirVar) result = { ...result, configDirVar: cap.configDirVar };
      if (cap.apiKeyTrustFile) result = { ...result, apiKeyTrustFile: cap.apiKeyTrustFile, apiKey };
      if (cap.skipFirstRunPrompts) result = { ...result, skipFirstRunPrompts: true };
      return result;
    }

    case 'configContentEnv': {
      const content = renderConfigContent(cap.template, endpoint, modelId, apiKey, contextLength);
      return withLaunchModel({ kind: 'env', envOverrides: { [cap.envVar]: content } }, cap.launchModel, modelId);
    }

    case 'configDir': {
      const { content, extraEnv } = renderConfigFile(cap.template, endpoint, modelId, apiKey, contextLength);
      return withLaunchModel(
        {
          kind: 'configDir',
          dirEnvVar: cap.dirEnvVar,
          files: [{ relPath: cap.fileName, content }],
          extraEnv,
          ...(cap.linkFromRealHome ? { linkFromRealHome: cap.linkFromRealHome } : {}),
          ...(cap.linkFromRealHomeDirs ? { linkFromRealHomeDirs: cap.linkFromRealHomeDirs } : {}),
          ...(cap.realHomeFallback ? { realHomeFallback: cap.realHomeFallback } : {}),
        },
        cap.launchModel,
        modelId
      );
    }

    case 'unsupported':
      return { kind: 'unsupported' };
  }
}

/** Render a `launchModel` template (`{modelId}` = the chosen id) onto an injection result. */
function withLaunchModel<T extends EnvInjection | ConfigDirInjection>(
  result: T,
  template: string | undefined,
  modelId: string
): T {
  if (!template) return result;
  return { ...result, launchModel: template.split('{modelId}').join(modelId) };
}

/**
 * One quarter of the window is held back for the reply, capped at 8192 tokens (a small local
 * model's window must not lose a disproportionate slice to the reservation). Returns undefined
 * for an unknown or non-finite size: opencode then keeps its own default guess, which is the
 * pre-fix behaviour; never invent a limit here.
 */
function opencodeModelLimit(contextLength: number | undefined): { context: number; output: number } | undefined {
  if (contextLength === undefined || !Number.isFinite(contextLength)) return undefined;
  const total = Math.trunc(contextLength);
  if (total <= 0) return undefined;
  const output = Math.max(1, Math.min(8192, Math.floor(total / 4)));
  // `limit.context` is the FULL window as far as opencode is concerned: it reserves for
  // the reply itself, so the discovered total is passed through, never a shrunk figure.
  return { context: total, output };
}

function renderConfigContent(
  template: 'opencode-json',
  endpoint: CustomModelEndpoint,
  modelId: string,
  apiKey: string,
  contextLength?: number
): string {
  switch (template) {
    case 'opencode-json': {
      // `limit` carries the discovered context window (issue #749): without it opencode assumes
      // a large default window for an unrecognized model id and eventually overflows a much
      // smaller local server. `context` is the FULL window and opencode reserves for the reply
      // inside it itself, so `opencodeModelLimit` passes the real total through and only
      // `output` gets the capped reservation.
      const limit = opencodeModelLimit(contextLength);
      return JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          custom: {
            options: { baseURL: withV1Suffix(endpoint.baseUrl), apiKey },
            models: { [modelId]: limit ? { limit } : {} },
          },
        },
        model: `custom/${modelId}`,
      });
    }
  }
}

/** The DEDICATED env var carrying a custom endpoint's API key for config-file recipes that
 *  reference keys by name (codex's `env_key`, deepseek's `apiKeyEnv`). Never a CLI-native
 *  name: dsh's own `llm-deepseek`/`web-search-deepseek` rows read `DEEPSEEK_API_KEY` too,
 *  so an in-session `/model` switch back to `deepseek-official` (or a profile with web
 *  search on) would otherwise send the custom endpoint's key to api.deepseek.com. Both
 *  entries list it in `privilegedEnvKeys` (stock.ts) like each other's redirect vars.
 */
const CUSTOM_MODEL_API_KEY_ENV_VAR = 'CODEMAN_CUSTOM_MODEL_API_KEY';

/** The `[model.<name>]` block name grok's config.toml uses for the injected model — also
 *  what `-m <name>` in the standalone script's ONE_SHOT argv must reference to select it. */
export const GROK_CUSTOM_MODEL_NAME = 'codeman-custom';

function renderConfigFile(
  template: 'codex-toml' | 'pi-models-json' | 'omp-models-yml' | 'grok-toml' | 'deepseek-patch-json',
  endpoint: CustomModelEndpoint,
  modelId: string,
  apiKey: string,
  contextLength?: number
): { content: string; extraEnv?: Record<string, string> } {
  const baseUrl = withV1Suffix(endpoint.baseUrl);
  switch (template) {
    case 'deepseek-patch-json': {
      const route = { provider: 'codeman-custom', model: modelId };
      return {
        content: JSON.stringify(
          [
            {
              id: 'llm-pi-ai',
              name: '@deepseek-ai/dsh-llm-pi-ai',
              config: {
                providers: {
                  'codeman-custom': {
                    // By NAME only (never the literal key, see CUSTOM_MODEL_API_KEY_ENV_VAR).
                    apiKeyEnv: CUSTOM_MODEL_API_KEY_ENV_VAR,
                    api: 'openai-completions',
                    baseURL: baseUrl,
                    models: [
                      {
                        id: modelId,
                        name: modelId,
                        ...(contextLength !== undefined && Number.isFinite(contextLength) && contextLength > 0
                          ? {
                              contextWindow: Math.trunc(contextLength),
                              // A quarter of the window keeps the reply inside the prompt's share; 8192 caps it on a large window.
                              maxTokens: Math.max(1, Math.min(8192, Math.floor(contextLength / 4))),
                            }
                          : {}),
                      },
                    ],
                  },
                },
              },
            },
            { id: 'dsh-tui', name: '@deepseek-harness-tui/dsh-tui', config: route },
            { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: route },
          ],
          null,
          2
        ),
        extraEnv: { [CUSTOM_MODEL_API_KEY_ENV_VAR]: apiKey },
      };
    }
    case 'codex-toml': {
      // Verified against real codex (>= Feb 2026): `model` is a top-level STRING, never
      // a `[model].default` table — codex rejects that with "invalid type: map, expected
      // a string" (caught by scripts/test-local-llm-harnesses.ts against a real llama-swap
      // server). The API key is NEVER a literal TOML field: codex's schema only supports
      // `env_key`, the NAME of an env var it reads the credential from at runtime, so the
      // actual value must ride along as an extra env var, never embedded in the file.
      // ⚠️ `wire_api = "responses"` is the only value codex still accepts (it dropped
      // `"chat"` support in Feb 2026). Even against a llama-swap deployment that DOES
      // answer `/v1/responses`, a real tool-call attempt came back as plain TEXT (the
      // tool-call JSON printed as the model's answer) rather than an executable
      // `function_call` item — confirmed live via `codex exec --json`. Tool execution is
      // what makes codex a coding agent, so this remains not usable for real work even
      // where plain chat succeeds — see the confidence table in
      // docs/custom-model-endpoints-plan.md, not a syntax bug in this file.
      const content = [
        `model = ${quoted(modelId)}`,
        `model_provider = "custom"`,
        ...(contextLength !== undefined && Number.isFinite(contextLength) && contextLength > 0
          ? [
              `model_context_window = ${Math.trunc(contextLength)}`,
              `model_auto_compact_token_limit = ${Math.max(1, Math.floor(contextLength * 0.75))}`,
            ]
          : []),
        '',
        '[model_providers.custom]',
        `name = "Custom Endpoint"`,
        `base_url = ${quoted(baseUrl)}`,
        `env_key = ${quoted(CUSTOM_MODEL_API_KEY_ENV_VAR)}`,
        `wire_api = "responses"`,
        '',
      ].join('\n');
      return { content, extraEnv: { [CUSTOM_MODEL_API_KEY_ENV_VAR]: apiKey } };
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
