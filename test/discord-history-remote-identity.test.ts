import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/discord-remote-conversation.js', () => ({
  probeRemoteDiscordConversation: vi.fn(),
  probeRemoteDiscordRuntime: vi.fn(),
}));
vi.mock('../src/discord-file-transfers.js', () => ({ runDiscordRemoteRead: vi.fn() }));
import { probeRemoteDiscordConversation, probeRemoteDiscordRuntime } from '../src/discord-remote-conversation.js';
import { runDiscordRemoteRead } from '../src/discord-file-transfers.js';
import { readDiscordSessionHistory } from '../src/discord-history.js';
import type { Session } from '../src/session.js';
const id = '01a1a603-1c4a-7f12-b20d-117d6b4da904';
let session: Session;
const packet = Buffer.from(JSON.stringify({ offset: 0, data: '', partial: false }));
beforeEach(() => {
  vi.resetAllMocks();
  session = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    mode: 'codex',
    workingDir: '/local/alias',
    remote: { hostId: 'test', host: 'test.invalid', username: 'test', remotePath: '/remote/work' },
    nativeResumeId: null,
    envOverrideValue: () => undefined,
    setNativeResumeId: vi.fn(),
  } as unknown as Session;
  vi.mocked(probeRemoteDiscordConversation).mockResolvedValue(id);
  vi.mocked(probeRemoteDiscordRuntime).mockResolvedValue({
    id,
    configHome: '/home/test/.codex-personal',
    fingerprint: 'a'.repeat(64),
  });
  vi.mocked(runDiscordRemoteRead).mockResolvedValue(packet);
});
describe('verified remote history identity adoption', () => {
  it('adopts the discovered ID only after its exact transcript read succeeds', async () => {
    const h = await readDiscordSessionHistory(session);
    expect(h.conversationId).toBe(id);
    expect(runDiscordRemoteRead).toHaveBeenCalledExactlyOnceWith(session.remote, expect.stringContaining(id));
    expect(session.setNativeResumeId).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('does not publish an ID when its transcript is unavailable', async () => {
    vi.mocked(runDiscordRemoteRead).mockRejectedValue(new Error('missing'));
    await expect(readDiscordSessionHistory(session)).rejects.toThrow();
    expect(session.setNativeResumeId).not.toHaveBeenCalled();
  });
  it('never substitutes a workspace guess when process ownership is ambiguous', async () => {
    vi.mocked(probeRemoteDiscordRuntime).mockResolvedValue(undefined);
    await expect(readDiscordSessionHistory(session)).rejects.toThrow(/profile/);
    expect(runDiscordRemoteRead).not.toHaveBeenCalled();
    expect(session.setNativeResumeId).not.toHaveBeenCalled();
  });
  it('keeps an existing identity while verifying its implicit runtime home', async () => {
    Object.assign(session, { nativeResumeId: id });
    await readDiscordSessionHistory(session);
    expect(probeRemoteDiscordConversation).not.toHaveBeenCalled();
    expect(probeRemoteDiscordRuntime).toHaveBeenCalledTimes(2);
    expect(session.setNativeResumeId).not.toHaveBeenCalled();
  });
  it('rejects a conflicting adoption that happened while the transcript read was pending', async () => {
    vi.mocked(runDiscordRemoteRead).mockImplementation(async () => {
      Object.assign(session, { nativeResumeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
      return packet;
    });
    await expect(readDiscordSessionHistory(session)).rejects.toThrow(/changed/);
    expect(session.setNativeResumeId).not.toHaveBeenCalled();
  });
  it('accepts a concurrent adoption of the same verified native conversation', async () => {
    vi.mocked(runDiscordRemoteRead).mockImplementation(async () => {
      Object.assign(session, { nativeResumeId: id });
      return packet;
    });
    await expect(readDiscordSessionHistory(session)).resolves.toHaveProperty('conversationId', id);
    expect(session.setNativeResumeId).not.toHaveBeenCalled();
  });
  it('uses an explicit home override without reading process environment', async () => {
    Object.assign(session, { envOverrideValue: () => './account' });
    await readDiscordSessionHistory(session);
    expect(runDiscordRemoteRead).toHaveBeenCalledWith(session.remote, expect.stringContaining('/remote/work/account'));
    expect(probeRemoteDiscordRuntime).not.toHaveBeenCalled();
  });
  it.each(['fingerprint', 'configHome', 'id'] as const)(
    'refuses a changed runtime %s after the file read',
    async (field) => {
      vi.mocked(probeRemoteDiscordRuntime)
        .mockResolvedValueOnce({ id, configHome: '/account', fingerprint: 'a'.repeat(64) })
        .mockResolvedValueOnce({
          id,
          configHome: '/account',
          fingerprint: 'a'.repeat(64),
          [field]: field === 'id' ? 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' : 'changed',
        });
      await expect(readDiscordSessionHistory(session)).rejects.toThrow(/changed/);
      expect(session.setNativeResumeId).not.toHaveBeenCalled();
    }
  );
  it('never reads a different process conversation over a pinned identity', async () => {
    Object.assign(session, { nativeResumeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    await expect(readDiscordSessionHistory(session)).rejects.toThrow(/changed/);
    expect(runDiscordRemoteRead).not.toHaveBeenCalled();
  });
  it('reuses the verified home but checks the process again on every subsequent read', async () => {
    Object.assign(session, { setNativeResumeId: vi.fn((value) => Object.assign(session, { nativeResumeId: value })) });
    await readDiscordSessionHistory(session);
    await readDiscordSessionHistory(session);
    expect(probeRemoteDiscordRuntime).toHaveBeenCalledTimes(3);
    expect(runDiscordRemoteRead).toHaveBeenLastCalledWith(
      session.remote,
      expect.stringContaining('/home/test/.codex-personal')
    );
  });
  it('can read a pinned default-home transcript after the agent has exited', async () => {
    Object.assign(session, { nativeResumeId: id, paneExit: { exitCode: 0 } });
    vi.mocked(probeRemoteDiscordRuntime).mockResolvedValue(undefined);
    await expect(readDiscordSessionHistory(session)).resolves.toHaveProperty('conversationId', id);
    expect(session.setNativeResumeId).not.toHaveBeenCalled();
  });
});
