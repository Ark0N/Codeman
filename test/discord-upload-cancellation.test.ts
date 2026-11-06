/** @fileoverview Remote uploads recheck authorization after probes and before each queued write. */
import { afterEach, expect, it, vi } from 'vitest';
import { writeDiscordRemoteAttachment } from '../src/discord-file-transfers.js';
import type { SessionRemote } from '../src/types/session.js';
const io = vi.hoisted(() => ({ probe: vi.fn(), write: vi.fn() }));
vi.mock('../src/remote-files.js', async (original) => ({
  ...(await original<typeof import('../src/remote-files.js')>()),
  remoteProbePaths: io.probe,
}));
vi.mock('../src/remote-file-transfer.js', async (original) => ({
  ...(await original<typeof import('../src/remote-file-transfer.js')>()),
  writeRemoteFileBytes: io.write,
}));
const remote = {
  hostId: 'test',
  host: 'test.invalid',
  username: 'tester',
  port: 22,
  remotePath: '/work',
} as SessionRemote;
afterEach(() => {
  vi.resetAllMocks();
});
it('does not write when permission changes during remote path probing', async () => {
  let allowed = true;
  io.probe.mockImplementation(async () => {
    allowed = false;
    return [{ kind: 'directory', realPath: '/work' }];
  });
  await expect(writeDiscordRemoteAttachment(remote, 'image.png', new Uint8Array([1]), () => allowed)).rejects.toThrow(
    'scope changed'
  );
  expect(io.write).not.toHaveBeenCalled();
});
it('rechecks authorization separately for the attachment write after the ignore-file write', async () => {
  let allowed = true;
  io.probe.mockResolvedValue([{ kind: 'directory', realPath: '/work' }]);
  io.write.mockImplementation(async () => {
    allowed = false;
  });
  await expect(writeDiscordRemoteAttachment(remote, 'image.png', new Uint8Array([1]), () => allowed)).rejects.toThrow(
    'scope changed'
  );
  expect(io.write).toHaveBeenCalledTimes(1);
  expect(io.write.mock.calls[0][1].filePath).toBe('/work/.codeman-discord/.gitignore');
});
