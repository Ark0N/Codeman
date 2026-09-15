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
