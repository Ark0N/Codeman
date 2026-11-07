import { expect, it, vi } from 'vitest';
import { registerDiscordLaunchCommands, launchDescription } from '../src/discord-launch-commands.js';
it('registers guild CLI commands without overwriting unrelated commands or duplicating existing commands', async () => {
  const request = vi.fn(async (method: string, _path: string, body?: any) =>
    method === 'GET'
      ? [
          { id: 'existing', type: 1, name: 'codex', description: launchDescription('codex') },
          { id: 'foreign', type: 1, name: 'shell', description: 'Another integration' },
        ]
      : { ...body, id: 'new' }
  );
  const result = await registerDiscordLaunchCommands(
    { request },
    'app',
    'guild',
    ['codex', 'claude', 'shell', 'BAD'],
    () => true
  );
  expect([...result]).toEqual([
    ['codex', 'existing'],
    ['claude', 'new'],
  ]);
  expect(request.mock.calls.filter(([method]) => method !== 'GET')).toEqual([
    [
      'POST',
      '/applications/app/guilds/guild/commands',
      { type: 1, name: 'claude', description: launchDescription('claude'), options: [] },
    ],
  ]);
});
it('stops registration when config changes and surfaces permission failure', async () => {
  const request = vi.fn(async () => []);
  await expect(registerDiscordLaunchCommands({ request }, 'app', 'guild', ['codex'], () => false)).rejects.toThrow(
    'changed'
  );
  expect(request).toHaveBeenCalledTimes(1);
  await expect(
    registerDiscordLaunchCommands(
      {
        request: async () => {
          throw new Error('403');
        },
      },
      'app',
      'guild',
      ['codex'],
      () => true
    )
  ).rejects.toThrow('403');
});
