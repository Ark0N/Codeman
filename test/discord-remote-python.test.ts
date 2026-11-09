import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
import { discordRemoteReadCommand, runDiscordRemoteRead } from '../src/discord-file-transfers.js';
it('checks for python before running the guarded remote file reader', () => {
  const command = discordRemoteReadCommand('/workspace', '/workspace/output.png');
  expect(command.indexOf('command -v python3')).toBeLessThan(command.indexOf('python3 -c'));
  expect(command).toContain('CODEMAN_DISCORD_PYTHON_REQUIRED');
});
it('reports a missing remote Python installation without surfacing arbitrary stderr', async () => {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stderr.write('private host detail\nCODEMAN_DISCORD_PYTHON_');
      child.stderr.write('REQUIRED\n');
      child.emit('close', 72);
    });
    return child;
  });
  await expect(
    runDiscordRemoteRead({ host: 'test.invalid', username: 'tester', remotePath: '/workspace' }, 'probe')
  ).rejects.toThrow('Install Python 3 on that host');
});
