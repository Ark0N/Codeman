/**
 * @fileoverview Launch-time defaults from synced App Settings, driven by registry data.
 *
 * A CLI entry declares `capabilities.launchDefaults` (launch param -> settings key; today
 * only codex, `{ model: 'codexModel', reasoningEffort: 'codexReasoningEffort' }`), and
 * `applyLaunchDefaults()` fills those settings into the entry's `launch.legacyConfigField`
 * object, setting ONLY the fields the caller left unset. Persisted values are re-validated
 * with `SettingsUpdateSchema`, so a hand-edited settings.json can never smuggle an
 * unchecked value onto the command line.
 *
 * Scope is the caller's decision: the create and quick-start routes apply it to local
 * launches only, never to remote, Docker or custom-endpoint launches. Nothing here writes
 * a CLI's own config files.
 */

import { getCli } from '../config/cli-registry/registry.js';
import { SettingsUpdateSchema } from './schemas.js';
import { readJsonConfig, SETTINGS_PATH } from './route-helpers.js';

/**
 * Return `configs` with the launch defaults of `mode`'s registry entry filled into its
 * legacy config object (e.g. `codexConfig`). Every other field of `configs` is passed
 * through untouched, and `configs` itself comes back unchanged (same object) when the entry
 * declares no defaults, `customEndpoint` is set, or no setting names a value.
 */
export async function applyLaunchDefaults<T extends object>(
  mode: string,
  configs: T,
  customEndpoint = false
): Promise<T> {
  const entry = getCli(mode);
  const declared = entry?.capabilities.launchDefaults;
  const field = entry?.launch.legacyConfigField;
  if (customEndpoint || !declared || field === undefined) return configs;

  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'CLI launch defaults', {});
  const aliases = entry.launch.legacyConfigAliases ?? {};
  const current = (configs as Record<string, unknown>)[field] as Record<string, unknown> | undefined;
  const defaults: Record<string, unknown> = {};
  for (const [param, settingKey] of Object.entries(declared)) {
    const parsed = SettingsUpdateSchema.shape[settingKey].safeParse(settings[settingKey]);
    // '' is the settings' "leave it to the CLI" value, the same as unset.
    const value = parsed.success ? parsed.data || undefined : undefined;
    const wireKey = aliases[param] ?? param;
    if (value !== undefined && (current?.[wireKey] ?? undefined) === undefined) defaults[wireKey] = value;
  }
  if (Object.keys(defaults).length === 0) return configs;
  return { ...configs, [field]: { ...current, ...defaults } };
}
