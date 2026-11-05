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
  expect(deps.create).toHaveBeenCalledExactlyOnceWith({ caseName: name, mode: 'codex', tabGroupId: 'g1' });
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
  await manager.control('scope', 'reconnect s1');
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
  expect(deps.recover).not.toHaveBeenCalled();
});
