import { describe, expect, it } from 'vitest';
import { resolveDiscordCase, type DiscordCaseSession } from '../src/discord-case-identity.js';
import type { CaseInfo, SessionRemote, SessionDocker } from '../src/types.js';
const cases: CaseInfo[] = [
  { name: 'saif', path: '/work/saif' },
  { name: 'nested', path: '/work/saif/nested' },
];
const local = (id = 'w1', workingDir = '/work/saif'): DiscordCaseSession => ({ id, workingDir });
const remote = (hostId = 'mac', username = 'user'): SessionRemote => ({
  hostId,
  host: 'test.invalid',
  label: 'Mac',
  username,
  remotePath: '/work/saif',
});
describe('Discord case identity', () => {
  it('groups sessions by case root independently of tab names or CLI', () => {
    expect(resolveDiscordCase(local('w1'), cases)).toEqual(resolveDiscordCase(local('w2', '/work/saif/src'), cases));
    expect(resolveDiscordCase(local(), cases).name).toBe('saif');
    expect(resolveDiscordCase(local('other', '/work/saif/nested/src'), cases).name).toBe('nested');
  });
  it('keeps same-name cases and path siblings separate', () => {
    const a = resolveDiscordCase(local(), cases);
    expect(resolveDiscordCase(local('w2', '/other/saif'), cases).key).not.toBe(a.key);
    expect(resolveDiscordCase(local('w3', '/work/saif-copy'), cases).key).not.toBe(a.key);
    expect(resolveDiscordCase({ ...local(), owner: 'other' }, cases).key).not.toBe(a.key);
  });
  it('groups SSH sessions on the same host and case, keeping other users and transports separate', () => {
    const r = remote();
    const rc: CaseInfo[] = [{ name: 'remote-saif', path: '/local/alias', remote: { ...r, path: r.remotePath } }];
    const a = resolveDiscordCase({ ...local(), remote: r }, rc);
    expect(a.name).toBe('remote-saif');
    expect(resolveDiscordCase({ ...local('w2'), remote: { ...r, remotePath: '/work/saif/src' } }, rc)).toEqual(a);
    for (const different of [remote('other'), remote('mac', 'other')])
      expect(resolveDiscordCase({ ...local(), remote: different }, rc).key).not.toBe(a.key);
    expect(resolveDiscordCase(local(), rc).key).not.toBe(a.key);
  });
  it('groups Docker sessions in the same case container and distinguishes hosts and containers', () => {
    const docker = {
      hostId: 'docker1',
      containerName: 'saif',
      containerWorkdir: '/workspace',
      hostWorkspacePath: '/work/saif',
    } as SessionDocker;
    const a = resolveDiscordCase({ ...local(), docker }, cases);
    expect(resolveDiscordCase({ ...local('w2'), docker }, cases)).toEqual(a);
    expect(resolveDiscordCase({ ...local(), docker: { ...docker, containerName: 'other' } }, cases).key).not.toBe(
      a.key
    );
    expect(resolveDiscordCase({ ...local(), docker: { ...docker, hostId: 'docker2' } }, cases).key).not.toBe(a.key);
  });
  it('groups unlinked shells only by exact absolute workspace and isolates missing metadata', () => {
    expect(resolveDiscordCase(local('w1', '/shell'), [])).toEqual(resolveDiscordCase(local('w2', '/shell'), []));
    expect(resolveDiscordCase(local('w1', ''), []).key).not.toBe(resolveDiscordCase(local('w2', ''), []).key);
  });
  it('keeps aliases at the same physical root in one channel', () => {
    expect(resolveDiscordCase(local(), cases).key).toBe(
      resolveDiscordCase(local(), [{ name: 'alias', path: '/work/saif' }]).key
    );
  });
});
