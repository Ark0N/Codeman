/** Real shell/argv regression for every remote tmux builder. No network or real tmux runs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRemoteTmuxCheckCommand,
  buildRemoteSessionAliveCommand,
  buildRemoteListSessionsCommand,
} from '../src/remote-hosts.js';
import {
  buildRemoteLaunchCommand,
  buildRemoteAttachCommand,
  buildRemoteKillCommand,
  remoteTmuxSessionName,
} from '../src/tmux-manager.js';
import { buildRemoteScrollbackCommand, parseRemoteScrollbackOutput } from '../src/remote-pane-history.js';
import type { SessionRemote } from '../src/types/session.js';

const id = '663e3eae-8da6-4c7f-9231-611eb2840641';
const marker = 'path-history-marker';
const remote: SessionRemote = {
  hostId: 'offline',
  label: 'Offline fixture',
  host: 'never-connect.invalid',
  username: 'tester',
  port: 2222,
  identityFile: '/tmp/key with spaces',
  jumpHost: 'jump.invalid',
  socksProxy: '127.0.0.1:1080',
  extraSshOptions: ['StrictHostKeyChecking=accept-new'],
  remotePath: '/tmp/project with spaces',
};
const discovered = "team's session $literal";
const cases = [
  { name: 'link preflight', build: () => buildRemoteTmuxCheckCommand(remote), command: null, socket: null },
  {
    name: 'launch',
    build: () => buildRemoteLaunchCommand({ remote, sessionId: id, mode: 'shell' }),
    command: 'new-session',
    socket: 'codeman-remote',
  },
  { name: 'attach', build: () => buildRemoteAttachCommand(remote, discovered), command: 'attach', socket: 'codeman' },
  {
    name: 'alive probe',
    build: () => buildRemoteSessionAliveCommand(remote, remoteTmuxSessionName(id)),
    command: 'has-session',
    socket: 'codeman-remote',
  },
  {
    name: 'discovery',
    build: () => buildRemoteListSessionsCommand(remote),
    command: 'list-sessions',
    socket: 'codeman',
  },
  {
    name: 'history and screen capture',
    build: () => buildRemoteScrollbackCommand(remote, id, 100, 0, marker),
    command: 'capture-pane',
    socket: 'codeman-remote',
  },
  {
    name: 'cleanup',
    build: () => buildRemoteKillCommand({ remote, sessionId: id }),
    command: 'kill-session',
    socket: 'codeman-remote',
  },
];

describe('remote tmux PATH under a sparse non-interactive shell', () => {
  let root: string;
  let home: string;
  let sshBin: string;
  let tmuxPath: string;
  let tmuxLog: string;
  let sshLog: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'remote-tmux-path-'));
    home = join(root, 'remote home with spaces');
    sshBin = join(root, 'ssh tools');
    tmuxPath = join(home, '.local', 'bin', 'tmux');
    tmuxLog = join(root, 'tmux-args');
    sshLog = join(root, 'ssh-args');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    mkdirSync(sshBin);
    writeFileSync(
      join(sshBin, 'ssh'),
      `#!/bin/sh
for arg do printf '%s\\n' "$arg" >> "$TEST_SSH_LOG"; command="$arg"; done
exec "$TEST_REMOTE_SHELL" -c "$command"
`,
      { mode: 0o755 }
    );
    writeFileSync(
      tmuxPath,
      `#!/bin/sh
for arg do printf '%s\\n' "$arg" >> "$TEST_TMUX_LOG"; done
case "$*" in
  *capture-pane*) printf 'older row\\n${marker}\\n1\\ncurrent screen\\n' ;;
  *list-sessions*) printf 'discovered\\t0\\t123\\t1\\n' ;;
esac
`,
      { mode: 0o755 }
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const shell of ['/bin/sh', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])]) {
    for (const item of cases) {
      it(`${item.name} finds the remote-user tmux with ${shell} and preserves targeting/options`, () => {
        writeFileSync(tmuxLog, '');
        writeFileSync(sshLog, '');
        const stdout = execFileSync('/bin/sh', ['-c', item.build()], {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home,
            // Only the SSH stub is initially on PATH; an unwrapped command cannot
            // accidentally run this machine's real tmux during a negative test.
            PATH: sshBin,
            TEST_REMOTE_SHELL: shell,
            TEST_TMUX_LOG: tmuxLog,
            TEST_SSH_LOG: sshLog,
          },
        });
        const sshArgs = readFileSync(sshLog, 'utf8').trimEnd().split('\n');
        expect(sshArgs).toContain('tester@never-connect.invalid');
        expect(sshArgs).toContain('ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p');
        expect(sshArgs).toContain('StrictHostKeyChecking=accept-new');
        expect(sshArgs.slice(sshArgs.indexOf('-p'), sshArgs.indexOf('-p') + 2)).toEqual(['-p', '2222']);
        expect(sshArgs.slice(sshArgs.indexOf('-i'), sshArgs.indexOf('-i') + 2)).toEqual(['-i', '/tmp/key with spaces']);
        expect(sshArgs.slice(sshArgs.indexOf('-J'), sshArgs.indexOf('-J') + 2)).toEqual(['-J', 'jump.invalid']);
        if (item.command === null) {
          expect(stdout.trim()).toBe(tmuxPath);
          return;
        }
        const args = readFileSync(tmuxLog, 'utf8').trimEnd().split('\n');
        expect(args.slice(0, 2)).toEqual(['-L', item.socket]);
        expect(args).toContain(item.command);
        if (item.name === 'attach') expect(args).toContain(discovered);
        if (item.name === 'launch') {
          expect(args).toContain(remote.remotePath);
          expect(sshArgs).toContain('-t');
        }
        if (['alive probe', 'cleanup'].includes(item.name)) expect(args).toContain(remoteTmuxSessionName(id));
        if (item.name === 'history and screen capture') {
          expect(args).toContain(`=${remoteTmuxSessionName(id)}:`);
          expect(parseRemoteScrollbackOutput(stdout, marker, 0)).toEqual({
            scrollback: 'older row\n',
            screen: 'current screen\n',
          });
        }
      });
    }
  }
});
