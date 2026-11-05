import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/discord-remote-conversation.js', () => ({ probeRemoteDiscordConversation: vi.fn() }));
vi.mock('../src/discord-file-transfers.js', () => ({ runDiscordRemoteRead: vi.fn() }));
import { probeRemoteDiscordConversation } from '../src/discord-remote-conversation.js';
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
    vi.mocked(probeRemoteDiscordConversation).mockResolvedValue(undefined);
    await expect(readDiscordSessionHistory(session)).rejects.toThrow(/identity/);
    expect(runDiscordRemoteRead).not.toHaveBeenCalled();
    expect(session.setNativeResumeId).not.toHaveBeenCalled();
  });
  it('keeps an existing identity and does not probe another', async () => {
    Object.assign(session, { nativeResumeId: id });
    await readDiscordSessionHistory(session);
    expect(probeRemoteDiscordConversation).not.toHaveBeenCalled();
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
});
