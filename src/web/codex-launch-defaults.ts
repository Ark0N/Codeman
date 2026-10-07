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
