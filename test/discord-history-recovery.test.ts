import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/discord-history.js', async (original) => ({
  ...(await original<typeof import('../src/discord-history.js')>()),
  readDiscordSessionHistory: vi.fn(),
}));
import { readDiscordSessionHistory, DiscordHistoryReadError } from '../src/discord-history.js';
import { readDiscordCanonicalHistory } from '../src/discord-history-recovery.js';
import type { Session } from '../src/session.js';
const id = '019a6ac0-1234-7123-a123-123456789abc';
const composer = '› \x1b[2mAsk Codex to do anything\x1b[22m\n  GPT-6.1-Sol · /work\n  ? for shortcuts';
const history = {
  conversationId: id,
  turns: [
    {
      role: 'assistant' as const,
      cursor: '1',
      text: '| Step | Narration |\n|---|---|\n| 1–2 | Original words |',
      timestamp: '',
    },
  ],
  partial: false,
};
let session: Session, screen: string, write: ReturnType<typeof vi.fn>, allowed: boolean;
beforeEach(() => {
  vi.resetAllMocks();
  screen = composer;
  allowed = true;
  write = vi.fn(async () => {
    screen = '› /status\n│ Model: GPT-6.1-Sol (reasoning medium) │\n│ Session: ' + id + ' │\n' + composer;
    return true;
  });
  session = {
    mode: 'codex',
    id: 'tab-id',
    remote: { remotePath: '/work', hostId: 'host' },
    nativeResumeId: null,
    nativeModelSettingsRevision: 'rev1',
    isWorking: false,
    envOverrideValue: () => undefined,
    setNativeResumeId: vi.fn((id) => {
      Object.assign(session, { nativeResumeId: id });
    }),
    withNativeModelSettings: vi.fn(async (run, current) =>
      run({ current, capture: async () => screen, write, cancelMenu: vi.fn() })
    ),
  } as unknown as Session;
  vi.mocked(readDiscordSessionHistory).mockImplementation(async (_s, _o, recovered) => {
    if (recovered || session.nativeResumeId) return history;
    throw new Error('identity unavailable');
  });
});
it('recovers exact remote identity through a guarded local status command and verified transcript header', async () => {
  expect(await readDiscordCanonicalHistory(session, {}, () => allowed)).toEqual(history);
  expect(write).toHaveBeenCalledExactlyOnceWith('/status\r');
  expect(readDiscordSessionHistory).toHaveBeenCalledWith(session, {}, id);
  expect(session.setNativeResumeId).toHaveBeenCalledExactlyOnceWith(id);
  await readDiscordCanonicalHistory(session, {}, () => allowed);
  expect(write).toHaveBeenCalledTimes(1);
});
it.each(['busy', 'draft', 'not-permitted'] as const)('sends no command when %s', async (state) => {
  if (state === 'busy') Object.assign(session, { isWorking: true });
  if (state === 'draft') screen = '› unfinished user draft\n  GPT-6.1-Sol · /work\n  ? for shortcuts';
  if (state === 'not-permitted') allowed = false;
  await expect(readDiscordCanonicalHistory(session, {}, () => allowed)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
  expect(session.setNativeResumeId).not.toHaveBeenCalled();
});
it('does not adopt a status ID when its exact transcript is unavailable and backs off retries', async () => {
  vi.mocked(readDiscordSessionHistory).mockRejectedValue(new Error('header unavailable'));
  await expect(readDiscordCanonicalHistory(session, {}, () => allowed)).rejects.toThrow('header unavailable');
  await expect(readDiscordCanonicalHistory(session, {}, () => allowed)).rejects.toThrow('header unavailable');
  expect(write).toHaveBeenCalledTimes(1);
  expect(session.setNativeResumeId).not.toHaveBeenCalled();
});
it('rejects a pane/input revision change while the verified transcript is being read', async () => {
  vi.mocked(readDiscordSessionHistory).mockImplementation(async (_s, _o, recovered) => {
    if (!recovered) throw new Error('identity unavailable');
    Object.assign(session, { nativeModelSettingsRevision: 'changed' });
    return history;
  });
  await expect(readDiscordCanonicalHistory(session, {}, () => allowed)).rejects.toThrow('changed');
  expect(session.setNativeResumeId).not.toHaveBeenCalled();
});

it.each(['profile_unverified', 'profile_changed'])('does not issue status commands for a %s error', async (code) => {
  vi.mocked(readDiscordSessionHistory).mockRejectedValue(new DiscordHistoryReadError(code));
  await expect(readDiscordCanonicalHistory(session, {}, () => true)).rejects.toThrow(/profile/);
  expect(write).not.toHaveBeenCalled();
});

it('recovers an unbound local custom-profile conversation through the same guarded lease', async () => {
  Object.assign(session, {
    remote: undefined,
    workingDir: '/work',
    envOverrideValue: () => '/home/test/custom-profile',
  });
  expect(await readDiscordCanonicalHistory(session, {}, () => allowed)).toEqual(history);
  expect(write).toHaveBeenCalledExactlyOnceWith('/status\r');
  expect(readDiscordSessionHistory).toHaveBeenCalledWith(session, {}, id);
  expect(session.setNativeResumeId).toHaveBeenCalledExactlyOnceWith(id);
});
it.each([{ watching: '1 shell' }, { isAdopted: true }, { docker: {} }])(
  'leaves an unavailable local pane untouched for %j',
  async (state) => {
    Object.assign(session, { remote: undefined }, state);
    await expect(readDiscordCanonicalHistory(session, {}, () => true)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  }
);
it('rejects a local profile change before adopting status identity', async () => {
  let home = '/first';
  Object.assign(session, { remote: undefined, envOverrideValue: () => home });
  vi.mocked(readDiscordSessionHistory).mockImplementation(async (_s, _o, recovered) => {
    if (!recovered) throw new Error('unbound');
    home = '/second';
    return history;
  });
  await expect(readDiscordCanonicalHistory(session, {}, () => true)).rejects.toThrow('changed');
  expect(session.setNativeResumeId).not.toHaveBeenCalled();
});
