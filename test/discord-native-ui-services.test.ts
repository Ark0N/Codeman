import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDiscordNativeUiServices } from '../src/web/discord-native-ui-services.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import type { Session } from '../src/session.js';
beforeEach(async () => {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify({ theme: 'dark', codexDangerouslyBypassApprovals: true }));
});
describe('native Discord server services', () => {
  const services = (allowed = () => true) =>
    createDiscordNativeUiServices({
      sessions: () => new Map<string, Session>(),
      cases: async () => [],
      allowed,
      url: () => undefined,
    });
  it('validates and serializes future defaults while preserving other settings', async () => {
    const s = services();
    await s.saveDefaults({ model: 'gpt-6.1-sol', effort: 'high', approval: 'ask' }, () => true);
    expect(await s.defaults()).toEqual({ model: 'gpt-6.1-sol', effort: 'high', approval: 'ask' });
    expect(JSON.parse(await readFile(SETTINGS_PATH, 'utf8')).theme).toBe('dark');
  });
  it('rejects invalid values and revoked settings scope without a write', async () => {
    const original = await readFile(SETTINGS_PATH, 'utf8');
    await expect(
      services().saveDefaults({ model: 'bad;command', effort: 'high', approval: 'ask' }, () => true)
    ).rejects.toThrow();
    await expect(
      services().saveDefaults({ model: '', effort: 'unknown', approval: 'ask' }, () => true)
    ).rejects.toThrow();
    await expect(services().saveDefaults({ model: '', effort: '', approval: 'yes' }, () => true)).rejects.toThrow();
    await expect(services().saveDefaults({ model: '', effort: '', approval: 'ask' }, () => false)).rejects.toThrow(
      'context changed'
    );
    expect(await readFile(SETTINGS_PATH, 'utf8')).toBe(original);
  });
  it('disables the entire native UI surface without mapped single-user authorization', async () => {
    const s = services(() => false);
    expect(s.enabled()).toBe(false);
    expect(await s.sessions()).toEqual([]);
    expect(await s.cases()).toEqual([]);
    await expect(s.saveDefaults({ model: '', effort: '', approval: 'ask' }, () => true)).rejects.toThrow(
      'context changed'
    );
  });
});

it('projects background work as busy and captures only ready Claude suggestions', async () => {
  const s = {
    id: 's1',
    name: 'Claude',
    mode: 'claude',
    nativeResumeId: 'stale-codex-id',
    claudeSessionIdIsFirstHand: true,
    claudeSessionId: 'conversation',
    discordQueueRevision: 'revision',
    isWorking: false,
    watching: null,
    activityProjection: { activityStatus: 'idle' },
    workingDir: '/tmp',
  } as unknown as Session;
  let captures = 0;
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([['s1', s]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
    capture: () => {
      captures++;
      return '────────\n❯ \x1b[2mWrite regression tests\x1b[0m\n────────';
    },
  });
  expect((await services.sessions())[0]).toMatchObject({
    working: false,
    ready: true,
    promptSuggestion: 'Write regression tests',
  });
  Object.assign(s, { watching: '1 background task' });
  expect((await services.sessions())[0]).toMatchObject({ working: true, ready: false, promptSuggestion: undefined });
  Object.assign(s, { watching: null, activityProjection: { activityStatus: 'waiting_agents' } });
  expect((await services.sessions())[0]).toMatchObject({ working: true, ready: false, promptSuggestion: undefined });
  Object.assign(s, { mode: 'codex', activityProjection: { activityStatus: 'idle' } });
  expect((await services.sessions())[0].promptSuggestion).toBeUndefined();
  expect(captures).toBe(1);
});

it.each([
  ['claude', 'claude-conversation', 'stale-codex-id', undefined, 'claude-conversation'],
  ['codex', 'unrelated-claude-id', 'codex-conversation', undefined, 'codex-conversation'],
  ['codex', 'unrelated-claude-id', undefined, 'resume-conversation', 'resume-conversation'],
  ['claude', undefined, 'stale-codex-id', undefined, undefined],
  ['claude', null, 'stale-codex-id', undefined, undefined],
])(
  'projects %s conversation using its native protocol',
  async (mode, claudeSessionId, nativeResumeId, resumeSessionId, expected) => {
    const s = {
      id: 's1',
      mode,
      claudeSessionIdIsFirstHand: true,
      claudeSessionId,
      nativeResumeId,
      codexConfig: { resumeSessionId },
      isWorking: true,
      activityProjection: { activityStatus: 'busy' },
    } as unknown as Session;
    const services = createDiscordNativeUiServices({
      sessions: () => new Map([['s1', s]]),
      cases: async () => [],
      allowed: () => true,
      url: () => undefined,
    });
    expect((await services.sessions())[0].conversation).toBe(expected);
  }
);
it('guards Claude queued submission with the real Claude conversation, revision and idle state', async () => {
  const attempts: boolean[] = [];
  const s = {
    id: 's1',
    mode: 'claude',
    claudeSessionIdIsFirstHand: true,
    claudeSessionId: 'claude-one',
    nativeResumeId: undefined,
    discordQueueRevision: 'revision',
    isWorking: false,
    activityProjection: { activityStatus: 'idle' },
    submitDiscordFollowup: async (_text: string, current: () => boolean) => {
      const ok = current();
      attempts.push(ok);
      return ok ? 'accepted' : 'blocked';
    },
  } as unknown as Session;
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([['s1', s]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
  });
  expect(await services.submitQueued('s1', 'Follow up\r', 'claude-one', () => true, 'revision')).toBe('accepted');
  expect(await services.submitQueued('s1', 'Follow up\r', 'stale', () => true, 'revision')).toBe('blocked');
  expect(await services.submitQueued('s1', 'Follow up\r', 'claude-one', () => true, 'old-revision')).toBe('blocked');
  Object.assign(s, { isWorking: true });
  expect(await services.submitQueued('s1', 'Follow up\r', 'claude-one', () => true, 'revision')).toBe('blocked');
  expect(attempts).toEqual([true, false, false, false]);
});
it('refuses a Claude suggestion if its real conversation changes during capture', async () => {
  const s = {
    id: 's1',
    mode: 'claude',
    claudeSessionIdIsFirstHand: true,
    claudeSessionId: 'before',
    isWorking: false,
    discordQueueRevision: 'revision',
    activityProjection: { activityStatus: 'idle' },
  } as unknown as Session;
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([['s1', s]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
    capture: () => {
      Object.assign(s, { claudeSessionId: 'after' });
      return '────────\n❯ \x1b[2mWrite tests\x1b[0m\n────────';
    },
  });
  expect((await services.sessions())[0].promptSuggestion).toBeUndefined();
});
it('does not use an unvouched Claude cwd neighbor as the controls conversation', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const s = {
    id,
    mode: 'claude',
    claudeSessionId: 'foreign',
    claudeSessionIdIsFirstHand: false,
    isWorking: true,
  } as unknown as Session;
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([[id, s]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
  });
  expect((await services.sessions())[0].conversation).toBe(id);
  Object.assign(s, { claudeSessionChain: ['chain-start', 'chain-tail'] });
  expect((await services.sessions())[0].conversation).toBe('chain-tail');
});
it('refuses adopted-session workspace actions', async () => {
  const s = { id: 's1', isAdopted: true, workingDir: '/tmp' } as unknown as Session;
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([['s1', s]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
  });
  await expect(services.workspace('s1')).rejects.toThrow('Session unavailable');
});
