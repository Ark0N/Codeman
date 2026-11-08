/** Explicit lifecycle choices and confirmation safety using injected shared-service doubles. */
import { it, expect, vi } from 'vitest';
import { DiscordSessionManagement, type DiscordSessionManagementDeps } from '../src/discord-session-management.js';
import type { CaseInfo } from '../src/types.js';
import type { DiscordRecoveryRecord } from '../src/discord-session-management.js';
function setup() {
  let allowed = true;
  let cases: CaseInfo[] = [
    { name: 'localcase', path: '/work' },
    {
      name: 'remote',
      path: 'user@box:/work',
      location: 'remote',
      remote: { hostId: 'host1', host: 'box', username: 'user', path: '/work' },
    },
  ];
  const records: DiscordRecoveryRecord[] = [
    {
      id: 'r1',
      sourceSessionId: 'dead',
      name: 'old',
      tabGroupId: 'g1',
      mode: 'codex',
      workingDir: '/work',
      transport: 'remote',
      remote: { hostId: 'host1' },
      nativeResumeId: '12345678-1234-1234-1234-123456789abc',
      status: 'resumable',
      launch: { kind: 'built-in' },
      createdAt: 1,
    },
  ];
  const deps: DiscordSessionManagementDeps = {
    allowed: () => allowed,
    cases: async () => cases,
    groups: async () => [{ id: 'g1', name: 'Work' }],
    sessions: async () => [
      { id: 's1', host: 'box', caseName: 'remote', group: 'Work', mode: 'codex', state: 'working' },
    ],
    modes: () => ['claude', 'codex'],
    create: vi.fn(async () => 'new1'),
    recoveries: () => records,
    recover: vi.fn(async () => 'restored1'),
    reconnect: vi.fn(async () => true),
  };
  return {
    deps,
    manager: new DiscordSessionManagement(deps),
    disallow: () => {
      allowed = false;
    },
    changeCase: () => {
      cases = cases.map((c) => ({ ...c, path: c.path + '/changed' }));
    },
    records,
  };
}
it.each([
  ['localcase', 'local'],
  ['remote', 'host1'],
])('confirms %s creation with explicit host/CLI/group and consumes the confirmation once', async (name, host) => {
  const { manager, deps } = setup();
  const review = await manager.control('channel', `create ${name} ${host} codex g1`);
  expect(deps.create).not.toHaveBeenCalled();
  expect(review?.actions).toHaveLength(1);
  const command = review!.actions![0].command;
  await manager.control('wrong-channel', command);
  expect(deps.create).not.toHaveBeenCalled();
  const result = await manager.control('channel', command);
  expect(result?.locateSessionId).toBe('new1');
  expect(deps.create).toHaveBeenCalledExactlyOnceWith({
    caseName: name,
    name: `w1-${name}`,
    mode: 'codex',
    tabGroupId: 'g1',
  });
  await manager.control('channel', command);
  expect(deps.create).toHaveBeenCalledTimes(1);
});
it('rejects host/group/CLI mismatch, changed configuration and revoked access before creation', async () => {
  const { manager, deps, changeCase, disallow } = setup();
  for (const command of [
    'create remote local codex g1',
    'create localcase local bad g1',
    'create localcase local codex bad',
  ])
    expect((await manager.control('scope', command))?.actions).toBeUndefined();
  const first = await manager.control('scope', 'create localcase local claude default');
  changeCase();
  await manager.control('scope', first!.actions![0].command);
  expect(deps.create).not.toHaveBeenCalled();
  const second = await manager.control('scope', 'create localcase local claude default');
  disallow();
  await manager.control('scope', second!.actions![0].command);
  expect(deps.create).not.toHaveBeenCalled();
});
it('resumes only an explicit exact recovery record after confirmation and rejects changed evidence or ambiguous identity', async () => {
  const { manager, deps, records } = setup();
  const review = await manager.control('scope', 'recover r1 resume');
  expect(deps.recover).not.toHaveBeenCalled();
  const result = await manager.control('scope', review!.actions![0].command);
  expect(result?.locateSessionId).toBe('restored1');
  expect(deps.recover).toHaveBeenCalledExactlyOnceWith('r1', 'resume');
  records[0].nativeResumeId = undefined;
  expect((await manager.control('scope', 'recover r1 resume'))?.actions).toBeUndefined();
});
it('lists and locates existing sessions without model work and refuses lifecycle access without a user mapping', async () => {
  const { manager, deps, disallow } = setup();
  expect((await manager.control('scope', 'sessions'))?.text).toContain('Work');
  expect((await manager.control('scope', 'open s1'))?.locateSessionId).toBe('s1');
  const review = await manager.control('scope', 'reconnect s1');
  expect(deps.reconnect).not.toHaveBeenCalled();
  await manager.control('scope', review!.actions![0].command);
  expect(deps.reconnect).toHaveBeenCalledExactlyOnceWith('s1');
  expect(deps.create).not.toHaveBeenCalled();
  disallow();
  expect((await manager.control('scope', 'sessions'))?.text).toContain('single-user');
});

it('reports unsupported saved recovery explicitly instead of offering a blank replacement', async () => {
  const { deps } = setup();
  deps.recoveryUnavailableReason = 'Saved recovery unavailable; use the web UI.';
  const manager = new DiscordSessionManagement(deps);
  for (const command of ['recoveries', 'recover r1 resume']) {
    const reply = await manager.control('scope', command);
    expect(reply?.text).toBe(deps.recoveryUnavailableReason);
    expect(reply?.actions).toBeUndefined();
  }
});
it.each(['localcase', 'remote'])(
  'launches from exact configured %s channel identity with default placement',
  async (name) => {
    const { configuredDiscordCaseKey } = await import('../src/discord-case-identity.js');
    const { manager, deps } = setup();
    const c = (await deps.cases()).find((c) => c.name === name)!;
    const review = await manager.launch('owned-channel', configuredDiscordCaseKey(c)!, 'codex');
    expect(review.text).toContain(c.remote?.hostId || 'local');
    expect(deps.create).not.toHaveBeenCalled();
    await manager.control('owned-channel', review.actions![0].command);
    expect(deps.create).toHaveBeenCalledExactlyOnceWith({
      caseName: name,
      name: `w1-${name}`,
      mode: 'codex',
      tabGroupId: undefined,
    });
    await manager.control('owned-channel', review.actions![0].command);
    expect(deps.create).toHaveBeenCalledTimes(1);
  }
);

it('names Discord agents after the case and highest existing instance, rather than a UUID', async () => {
  const { manager, deps } = setup();
  deps.sessions = async () => [
    {
      id: 'old',
      name: 'w14-localcase - work',
      host: 'local',
      caseName: 'localcase',
      group: '',
      mode: 'codex',
      state: 'idle',
    },
    {
      id: 'other',
      name: 'w98-localcase-other',
      host: 'local',
      caseName: 'other',
      group: '',
      mode: 'codex',
      state: 'idle',
    },
    {
      id: 'shell',
      name: 's99-localcase',
      host: 'local',
      caseName: 'localcase',
      group: '',
      mode: 'shell',
      state: 'idle',
    },
  ];
  const review = await manager.control('scope', 'create localcase local claude default');
  await manager.control('scope', review!.actions![0].command);
  expect(deps.create).toHaveBeenCalledExactlyOnceWith({
    caseName: 'localcase',
    name: 'w15-localcase',
    mode: 'claude',
    tabGroupId: undefined,
  });
});
it('uses sN-case for shell launches', async () => {
  const { manager, deps } = setup();
  deps.modes = () => ['shell'];
  const review = await manager.control('scope', 'create localcase local shell default');
  await manager.control('scope', review!.actions![0].command);
  expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ name: 's1-localcase', mode: 'shell' }));
});
it('reserves unique names across concurrent agent-mode confirmations', async () => {
  const { manager, deps } = setup();
  const release: Array<() => void> = [];
  deps.create = vi.fn(async () => {
    await new Promise<void>((resolve) => release.push(resolve));
    return 'new';
  });
  const a = await manager.control('a', 'create localcase local claude default'),
    b = await manager.control('b', 'create localcase local codex default');
  const first = manager.control('a', a!.actions![0].command),
    second = manager.control('b', b!.actions![0].command);
  await vi.waitFor(() => expect(deps.create).toHaveBeenCalledTimes(2));
  expect(vi.mocked(deps.create).mock.calls.map(([body]) => body.name)).toEqual(['w1-localcase', 'w2-localcase']);
  for (const resolve of release) resolve();
  await Promise.all([first, second]);
});
it('releases a failed name reservation and rechecks authorization after listing sessions', async () => {
  const { manager, deps, disallow } = setup();
  vi.mocked(deps.create).mockRejectedValueOnce(Error('Refused'));
  const first = await manager.control('a', 'create localcase local claude default');
  await expect(manager.control('a', first!.actions![0].command)).rejects.toThrow('Refused');
  const second = await manager.control('a', 'create localcase local claude default');
  await manager.control('a', second!.actions![0].command);
  expect(vi.mocked(deps.create).mock.calls[1][0].name).toBe('w1-localcase');
  deps.sessions = async () => {
    disallow();
    return [];
  };
  const third = await manager.control('a', 'create localcase local claude default');
  await expect(manager.control('a', third!.actions![0].command)).rejects.toThrow('no longer allowed');
  expect(deps.create).toHaveBeenCalledTimes(2);
});
