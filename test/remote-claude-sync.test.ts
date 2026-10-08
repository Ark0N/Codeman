import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RemoteClaudeSync,
  buildRsyncArgs,
  claudeProjectRootForHost,
  listClaudeProjectRoots,
  remoteClaudeProjectsDir,
} from '../src/remote-claude-sync.js';
import { writeRemoteHosts } from '../src/remote-hosts.js';
import { claudeProjectsDir } from '../src/utils/claude-transcript.js';

describe('remote-claude-sync', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  function dataDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'codeman-remote-claude-'));
    return dir;
  }

  it('lists the local tree first and only hosts whose mirror exists on disk', async () => {
    const root = dataDir();
    await writeRemoteHosts(root, [
      { id: 'box-a', label: 'Box A', host: '10.0.0.1', username: 'u' },
      { id: 'box-b', label: 'Box B', host: '10.0.0.2', username: 'u' },
    ]);
    // Only box-a has been synced.
    mkdirSync(remoteClaudeProjectsDir(root, 'box-a'), { recursive: true });

    const roots = await listClaudeProjectRoots(root);
    expect(roots[0]).toEqual({ projectsDir: claudeProjectsDir() });
    expect(roots.slice(1)).toEqual([
      { projectsDir: remoteClaudeProjectsDir(root, 'box-a'), hostId: 'box-a', hostLabel: 'Box A' },
    ]);
    expect(await claudeProjectRootForHost(root, 'box-b')).toBeUndefined();
    expect((await claudeProjectRootForHost(root, 'box-a'))?.hostLabel).toBe('Box A');
  });

  it('builds a read-only rsync line that pulls only transcripts and sidecars with the host ssh options', () => {
    const args = buildRsyncArgs(
      { id: 'h', label: 'H', host: 'example.net', username: 'me', port: 2222, identityFile: '/k/id with space' },
      '/cache/projects'
    );
    expect(args).toContain('--delete');
    expect(args).toContain('--include=*.jsonl');
    expect(args).toContain('--exclude=*');
    const e = args[args.indexOf('-e') + 1];
    expect(e).toMatch(/^ssh -o BatchMode=yes/);
    expect(e).toContain('-p 2222');
    expect(e).toContain("-i '/k/id with space'");
    // Source is the host, destination the cache: never the other way round.
    expect(args[args.length - 2]).toBe('me@example.net:.claude/projects/');
    expect(args[args.length - 1]).toBe('/cache/projects/');
  });

  it('runs one rsync per host per cycle, records status, and skips when disabled', async () => {
    const root = dataDir();
    await writeRemoteHosts(root, [
      { id: 'ok-host', label: 'OK', host: 'a', username: 'u' },
      { id: 'bad-host', label: 'Bad', host: 'b', username: 'u' },
    ]);
    const calls: string[][] = [];
    let enabled = false;
    const sync = new RemoteClaudeSync(root, {
      isEnabled: () => enabled,
      intervalSec: () => 60,
      runner: async (args) => {
        calls.push(args);
        if (args[args.length - 2].startsWith('u@b:')) {
          const err = Object.assign(new Error('rsync failed'), {
            stderr: 'ssh: connect to host b port 22: No route to host',
          });
          throw err;
        }
      },
    });

    await sync.runCycle();
    expect(calls).toHaveLength(0);

    enabled = true;
    await sync.runCycle();
    expect(calls).toHaveLength(2);
    const status = Object.fromEntries(sync.getStatus().map((s) => [s.hostId, s]));
    expect(status['ok-host'].lastOkAt).toBeDefined();
    expect(status['ok-host'].lastError).toBeUndefined();
    expect(status['bad-host'].lastOkAt).toBeUndefined();
    expect(status['bad-host'].lastError).toContain('No route to host');
    expect(status['bad-host'].consecutiveFailures).toBe(1);
    // The cache directory exists after a pass, so the root now lists.
    expect((await listClaudeProjectRoots(root)).map((r) => r.hostId)).toEqual([undefined, 'ok-host', 'bad-host']);
  });
});
