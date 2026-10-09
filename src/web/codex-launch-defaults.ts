/**
 * @fileoverview Launch-time defaults for Codex sessions.
 *
 * Resolves the synced App Settings `codexModel` / `codexReasoningEffort` into the
 * `codexConfig` a launch uses, filling ONLY the fields the caller left unset.
 * Persisted values are re-validated with `SettingsUpdateSchema`, so a hand-edited
 * settings.json can never smuggle an unchecked value onto the codex command line.
 *
 * Scope is the caller's decision: the create and quick-start routes apply it to
 * local launches only, never to remote, Docker or custom-endpoint launches.
 * Nothing here writes Codex's own config files.
 */

import type { CodexConfig } from '../types.js';
import { SettingsUpdateSchema } from './schemas.js';
import { readJsonConfig, SETTINGS_PATH } from './route-helpers.js';

/** Resolve launch-only defaults without changing Codex's own configuration files. */
export async function resolveCodexLaunchDefaults(
  config: CodexConfig | undefined,
  customEndpoint = false
): Promise<CodexConfig | undefined> {
  if (customEndpoint) return config;
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'Codex launch defaults', {});
  const model = SettingsUpdateSchema.shape.codexModel.safeParse(settings.codexModel);
  const effort = SettingsUpdateSchema.shape.codexReasoningEffort.safeParse(settings.codexReasoningEffort);
  const defaultModel = model.success ? model.data || undefined : undefined;
  const defaultEffort = effort.success ? effort.data || undefined : undefined;
  if (!defaultModel && !defaultEffort) return config;
  return {
    ...config,
    model: config?.model ?? defaultModel,
    reasoningEffort: config?.reasoningEffort ?? defaultEffort,
  };
}
