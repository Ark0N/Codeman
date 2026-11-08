import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const h = vi.hoisted(() => ({
  allowed: true,
  roots: [] as Array<{ hostWorkspacePath: string }>,
  broken: false,
  exec: vi.fn(async () => ({ stdout: '' })),
  remote: vi.fn(async () => Buffer.from('')),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: h.exec });
  return { ...actual, execFile };
});
vi.mock('../src/utils/git-availability.js', () => ({
  gitSpawnAllowed: () => h.allowed,
  gitMissingError: () => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
}));
vi.mock('../src/docker-hosts.js', () => ({
  readDockerCasesOrThrow: async () => {
    if (h.broken) throw new Error('Docker cases unavailable');
    return h.roots;
  },
}));
vi.mock('../src/discord-file-transfers.js', () => ({
  runDiscordRemoteRead: h.remote,
  readDiscordSessionFile: vi.fn(),
}));
import { discordWorkspaceHasChanges, discordWorkspaceResults } from '../src/discord-workspace-results.js';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-git-guard-'));
  h.allowed = true;
  h.roots = [];
  h.broken = false;
  h.exec.mockClear();
  h.remote.mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it('returns missing-git ENOENT before starting the macOS placeholder', async () => {
  h.allowed = false;
  await expect(discordWorkspaceHasChanges({ workingDir: dir })).rejects.toMatchObject({ code: 'ENOENT' });
  expect(h.exec).not.toHaveBeenCalled();
});
it.each([{ docker: {} }, { isAdopted: true }])(
  'refuses unsupported session scope %j before git',
  async (unsupported) => {
    await expect(discordWorkspaceResults({ workingDir: dir, ...unsupported })).rejects.toThrow('unavailable');
    expect(h.exec).not.toHaveBeenCalled();
  }
);
it('refuses registered Docker roots, descendants and symlink aliases before git', async () => {
  const root = join(dir, 'container'),
    child = join(root, 'child'),
    alias = join(dir, 'alias');
  await mkdir(child, { recursive: true });
  await symlink(root, alias);
  h.roots = [{ hostWorkspacePath: root }];
  for (const workingDir of [root, child, alias]) {
    await expect(discordWorkspaceHasChanges({ workingDir })).rejects.toThrow('Docker');
  }
  expect(h.exec).not.toHaveBeenCalled();
});
it('fails closed when the Docker ownership inventory cannot be read', async () => {
  h.broken = true;
  await expect(discordWorkspaceHasChanges({ workingDir: dir })).rejects.toThrow('Docker');
  expect(h.exec).not.toHaveBeenCalled();
});
it('disables optional index locks on every local git call', async () => {
  expect(await discordWorkspaceHasChanges({ workingDir: dir })).toBe(false);
  expect(h.exec).toHaveBeenCalledExactlyOnceWith(
    'git',
    expect.arrayContaining(['--no-optional-locks', '-c', 'core.fsmonitor=false']),
    expect.any(Object)
  );
});
