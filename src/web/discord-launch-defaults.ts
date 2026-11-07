/** Match the web Codex Run button for Discord launches before normal route validation/clamping. */
import { getCli } from '../config/cli-registry/registry.js';
import { SettingsUpdateSchema } from './schemas.js';
import { readJsonConfig, SETTINGS_PATH } from './route-helpers.js';

export async function applyDiscordLaunchDefaults(body: unknown): Promise<unknown> {
  if (
    !body ||
    typeof body !== 'object' ||
    !('mode' in body) ||
    typeof body.mode !== 'string' ||
    getCli(body.mode)?.launch.legacyConfigField !== 'codexConfig'
  )
    return body;
  const request = body as Record<string, unknown>;
  const config = request.codexConfig;
  // Leave invalid payloads to the create route's validator.
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) return body;
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'Discord launch defaults', {});
  const bypass = SettingsUpdateSchema.shape.codexDangerouslyBypassApprovals.safeParse(
    settings.codexDangerouslyBypassApprovals
  );
  const animations = SettingsUpdateSchema.shape.codexAnimationsEnabled.safeParse(settings.codexAnimationsEnabled);
  return {
    ...request,
    codexConfig: {
      dangerouslyBypassApprovals: bypass.success ? (bypass.data ?? false) : false,
      ...(animations.success && typeof animations.data === 'boolean' ? { animations: animations.data } : {}),
      renderMode: 'hybrid',
      ...config,
    },
  };
}
