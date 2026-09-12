/**
 * @fileoverview Read/write-array store for user-configured custom OpenAI-compatible
 * model endpoints (local or cloud — deployment_plan.md). Same shape as
 * `remote-hosts.ts` / `webview-store.ts`: `~/.codeman/custom-model-hosts.json`
 * holding a plain array, read/written whole.
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
  await fs.writeFile(customModelHostsPath(configDir), JSON.stringify(hosts, null, 2));
}
