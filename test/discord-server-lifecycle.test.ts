/** @fileoverview Real WebServer Discord lifecycle adapters; only external launch/probe IO is replaced. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
const remote = vi.hoisted(() => ({ alive: true as boolean | undefined, hosts: [] as any[], cases: [] as any[] }));
vi.mock('../src/remote-hosts.js', async (original) => ({
  ...(await original<typeof import('../src/remote-hosts.js')>()),
  readRemoteHosts: vi.fn(async () => remote.hosts),
  readRemoteCases: vi.fn(async () => remote.cases),
  checkRemoteTmuxAvailable: vi.fn(async () => ({ ok: true, tmuxPath: '/usr/bin/tmux' })),
  remoteTmuxSessionAlive: vi.fn(async () => remote.alive),
}));
let server: WebServer;
let s: any;
beforeEach(async () => {
  remote.alive = true;
  remote.hosts = [];
  remote.cases = [];
  vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
  vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
  server = new WebServer(0, false, true);
  s = server as any;
  await server.start();
  vi.spyOn(s.discordBridge, 'acceptsControls', 'get').mockReturnValue(true);
  vi.spyOn(s.remoteWake, 'ensureHostAwake').mockResolvedValue('ready');
});
afterEach(async () => {
  await server.stop();
  vi.restoreAllMocks();
});
it.each(['local', 'remote'])(
  'launches the actual %s case through shared quick-start and exposes its metadata over HTTP',
  async (location) => {
    const name = 'discord-review-' + location;
    const path = join(homedir(), 'codeman-cases', name);
    await mkdir(path, { recursive: true });
    if (location === 'remote') {
      remote.hosts = [{ id: 'test-host', label: 'test-host', host: 'test.invalid', username: 'tester', port: 22 }];
      remote.cases = [{ name, location: 'remote', hostId: 'test-host', remotePath: '/work/review' }];
    }
    const id = await s.discordCreate({ caseName: name, mode: 'shell' });
    const session = s.sessions.get(id);
    expect(session.name).toContain(name);
    expect(session.workingDir).toBe(location === 'local' ? path : '/work/review');
    if (location === 'remote')
      expect(session.remote).toMatchObject({ hostId: 'test-host', remotePath: '/work/review' });
    else expect(session.remote).toBeUndefined();
    expect(Session.prototype.startShell).toHaveBeenCalledTimes(1);
    const { stdout } = await promisify(execFile)('curl', [
      '-fsS',
      `http://127.0.0.1:${server.boundPort}/api/sessions/${id}`,
    ]);
    expect(JSON.parse(stdout).data.id).toBe(id);
  }
);
it.each([false, undefined])('refuses reconnect without confirmed native existence (%s)', async (alive) => {
  remote.alive = alive;
  const reattachRemote = vi.fn(async () => true);
  s.sessions.set('missing', {
    id: 'missing',
    remote: { host: 'test.invalid' },
    muxName: 'codeman-missing',
    reattachRemote,
  });
  expect(await s.discordSessionManager.deps.reconnect('missing')).toBe(false);
  expect(reattachRemote).not.toHaveBeenCalled();
  s.sessions.delete('missing');
});
it('clears auto-reconnect in-flight on the early ambiguous/alive pane result without claiming success', async () => {
  const reattachRemote = vi.fn(async () => true);
  s.sessions.set('alive', { id: 'alive', muxName: 'codeman-alive', reattachRemote });
  vi.spyOn(s.mux, 'isPaneDead').mockResolvedValue(false);
  const note = vi.spyOn(s, 'noteRemoteReconnect');
  expect(await s.handleRemoteSessionDropped('alive')).toBe(false);
  expect(note).toHaveBeenCalledExactlyOnceWith('alive', false);
  expect(reattachRemote).not.toHaveBeenCalled();
  s.sessions.delete('alive');
});
it('clears auto-reconnect bookkeeping if the pane probe rejects', async () => {
  const reattachRemote = vi.fn(async () => true);
  s.sessions.set('failed', { id: 'failed', muxName: 'codeman-failed', reattachRemote });
  vi.spyOn(s.mux, 'isPaneDead').mockRejectedValue(new Error('tmux unavailable'));
  const note = vi.spyOn(s, 'noteRemoteReconnect');
  expect(await s.handleRemoteSessionDropped('failed')).toBe(false);
  expect(note).toHaveBeenCalledExactlyOnceWith('failed', false);
  expect(reattachRemote).not.toHaveBeenCalled();
  s.sessions.delete('failed');
});
it('cancels a quick-start if Discord authorization is revoked while resolving the remote case', async () => {
  remote.hosts = [{ id: 'test-host', label: 'test-host', host: 'test.invalid', username: 'tester', port: 22 }];
  remote.cases = [{ name: 'cancelled-remote', hostId: 'test-host', remotePath: '/work/review' }];
  vi.spyOn(s.remoteWake, 'ensureHostAwake').mockImplementation(async () => {
    vi.spyOn(s.discordBridge, 'acceptsControls', 'get').mockReturnValue(false);
    return 'ready';
  });
  const before = s.sessions.size;
  await expect(s.discordCreate({ caseName: 'cancelled-remote', mode: 'shell' })).rejects.toThrow('creation refused');
  expect(Session.prototype.startShell).not.toHaveBeenCalled();
  expect(s.sessions.size).toBe(before);
});
it('refuses a reconnect requested under a superseded Discord configuration', async () => {
  const reattachRemote = vi.fn(async () => true);
  s.sessions.set('superseded', {
    id: 'superseded',
    remote: { host: 'test.invalid' },
    muxName: 'codeman-superseded',
    reattachRemote,
  });
  vi.spyOn(s.discordBridge, 'controlScope', 'get').mockReturnValueOnce('old').mockReturnValue('new');
  expect(await s.discordSessionManager.deps.reconnect('superseded')).toBe(false);
  expect(reattachRemote).not.toHaveBeenCalled();
  s.sessions.delete('superseded');
});
