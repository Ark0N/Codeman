/**
 * @fileoverview Read/write-array store for user-configured custom OpenAI-compatible
 * model endpoints (local or cloud — docs/custom-model-endpoints-plan.md). Same
 * shape as `remote-hosts.ts` / `webview-store.ts`: `~/.codeman/custom-model-hosts.json`
 * holding a plain array, read/written whole. The file can hold API keys, so it is
 * written 0600 via tmp+rename like `intents.json` (`mode` on `writeFile` applies only
 * to a file being created; the rename is what keeps an existing file's bytes and
 * mode from ever being observable half-written or world-readable).
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';

const CUSTOM_MODEL_HOSTS_FILE = 'custom-model-hosts.json';

export type CustomModelAuthStyle = 'bearer' | 'api-key';

export interface CustomModelHost {
  id: string;
  label: string;
  /** Root URL, local or cloud — e.g. "http://192.168.1.50:8080" or an Azure AI Foundry URL. */
  baseUrl: string;
  apiKey?: string;
  /**
   * Defaults to 'bearer' (the common `Authorization: Bearer` convention — matches
   * llama.cpp, OpenAI-compatible servers, and most gateways). Pick 'api-key' for
   * endpoints that specifically want the `api-key` header, e.g. Azure AI Foundry.
   *
   * ⚠️ There is deliberately NO 'both' option. An earlier design sent BOTH headers
   * on every discovery request on the theory that an unused header is harmless —
   * live-tested against a real llama-swap server, sending both reliably HUNG the
   * request indefinitely (reproduced 3× — Bearer alone: ~500ms, api-key alone:
   * ~600ms, both together: no response inside a 15s timeout). Whatever auth
   * middleware some servers run apparently does not handle two simultaneous
   * credential conventions gracefully, so "send everything and let the server
   * ignore what it doesn't need" is not a safe default — it can silently turn a
   * working endpoint into one that always times out.
   */
  authStyle?: CustomModelAuthStyle;
  models?: string[];
  lastDiscoveredAt?: string;
  /**
   * The model the Run-menu picker (docs/custom-model-endpoints-plan.md) applies when
   * this endpoint is picked with no further choice — one generated menu entry per
   * (CLI, endpoint) pair, not per (CLI, endpoint, model), so it needs a single answer.
   * Must be a member of `models` when set; the picker falls back to `models[0]` when
   * this is unset, and disables the entry entirely when `models` is empty (nothing to
   * default to). Never auto-set on discovery — the previous default staying valid
   * after a re-discover is a property worth keeping even if the model list changes.
   */
  defaultModelId?: string;
  /**
   * Discovered context-window size (tokens) per model id, keyed by the same strings as
   * `models`. Populated opportunistically during discovery (`custom-model-routes.ts`) from
   * llama.cpp/llama-swap's `GET /props?model=<id>` — the plain OpenAI-shaped `/v1/models`
   * response has no such field. Only ever probed for a model the server already reports as
   * loaded (llama-swap's `status.value === 'loaded'`); an unloaded one is deliberately never
   * probed, since llama-swap treats `/props?model=` as a routing hint that can trigger an
   * actual (slow, GPU-swapping) model load as a side effect of merely asking. A model this
   * has no entry for simply gets no context-length env override applied — never a guess.
   */
  modelContextLengths?: Record<string, number>;
  /**
   * Discovered number of parallel server slots per model id, keyed like `modelContextLengths`
   * and populated on the same loaded-models-only basis. Read from the launch command's
   * `--parallel`/`-np` when it states one, otherwise from llama.cpp's own `/props`
   * `total_slots` (a llama-server started without `--parallel` picks the count itself, so
   * the command cannot say). llama-server splits its context across these slots (by default
   * they share one unified KV pool) and Claude Code sends several requests at once (the
   * main session plus each parallel subagent), so with N slots each request can only rely
   * on roughly `contextLength / N` tokens. Used only by the context warning; a model this
   * has no entry for is treated as a single slot, never a guess.
   */
  modelSlotCounts?: Record<string, number>;
  /**
   * The context the running server itself reports (`/props`'s `n_ctx`) per model id, recorded
   * whenever discovery had to probe `/props` for the slot count. NOT a replacement for
   * `modelContextLengths`, which keeps coming from the launch command: it is used only to
   * divide the context across `modelSlotCounts`. A launch command's `--fit-ctx` is just the
   * auto-fitter's floor, so the real context is at least that and often far larger (a small
   * model on a big card was measured at 262,144 against a floor of 65,536); dividing the
   * floor by the slot count would warn about a server that has plenty of room.
   */
  modelServerContexts?: Record<string, number>;
  /**
   * Discovered file size (GB) per model id, keyed by the same strings as `models`.
   * Populated during discovery by parsing llama-swap's own `description` field for an
   * auto-discovered model ("Auto-discovered 16.35 GB - parameters auto-fitted by
   * llama.cpp") — a hand-configured profile's own description has no such figure and
   * correctly gets no entry, never a guess. Used only to label the Run-menu picker's
   * "loading model" banner with a rough, unmeasured expected-time estimate
   * (the Run-menu picker's loading banner in session-ui.js) — never a guarantee, and never anything a
   * server-side check relies on.
   */
  modelSizesGB?: Record<string, number>;
}

export function customModelHostsPath(configDir: string): string {
  return join(configDir, CUSTOM_MODEL_HOSTS_FILE);
}

export async function readCustomModelHosts(configDir: string): Promise<CustomModelHost[]> {
  try {
    const raw = await fs.readFile(customModelHostsPath(configDir), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CustomModelHost[]) : [];
  } catch {
    return [];
  }
}

export async function writeCustomModelHosts(configDir: string, hosts: CustomModelHost[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  const target = customModelHostsPath(configDir);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(hosts, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}
