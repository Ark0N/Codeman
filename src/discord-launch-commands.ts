/** Guild-scoped launch commands. Never bulk-overwrite another integration's commands. */
export interface DiscordLaunchApi {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}
export const launchDescription = (mode: string): string => `Codeman: start a new ${mode} session in this case`;
export async function registerDiscordLaunchCommands(
  api: DiscordLaunchApi,
  appId: string,
  guildId: string,
  modes: string[],
  current: () => boolean
): Promise<Map<string, string>> {
  const path = `/applications/${appId}/guilds/${guildId}/commands`;
  const existing = await api.request('GET', path);
  if (!Array.isArray(existing)) throw new Error('Discord command list unavailable');
  const result = new Map<string, string>();
  for (const mode of [...new Set(modes)].filter((m) => /^[a-z][a-z0-9-]{0,23}$/.test(m)).slice(0, 100)) {
    if (!current()) throw new Error('Discord command configuration changed');
    const found = existing.find((c) => c.name === mode && c.type === 1);
    const description = launchDescription(mode);
    // Matching names belong to other functionality unless they have our exact marker.
    if (found && found.description !== description) continue;
    const command = found ?? (await api.request('POST', path, { type: 1, name: mode, description, options: [] }));
    if (!current()) throw new Error('Discord command configuration changed');
    if (!command || typeof command !== 'object' || !('id' in command) || typeof command.id !== 'string')
      throw new Error('Discord command registration failed');
    result.set(mode, command.id);
  }
  return result;
}
