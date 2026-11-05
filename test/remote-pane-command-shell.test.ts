/**
 * @fileoverview Which shell parses a remote pane command (#760).
 *
 * tmux runs a ONE-argument command through the remote default-shell, the user's login shell, and
 * bypasses it for two or more arguments. Codeman's own text carries `"${SHELL:-/bin/sh}"`, a parse
 * error in fish that kills the pane with status 127, so it must reach `/bin/sh -c` as separate
 * arguments. A per-host `commands.*` override is the user's text for their own shell: `source` and
 * `[[` work in bash and zsh and die under a dash `/bin/sh`, so it must stay one argument.
 *
 * CI has no fish, so this reads the argv tmux would receive instead: the real builder's string goes
 * through a real sh with `ssh` and `tmux` defined as functions that report their arguments.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { listClis } from '../src/config/cli-registry/registry.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import type { SessionMode, SessionRemote } from '../src/types.js';

const SESSION_ID = 'abcd1234-0000-0000-0000-000000000000';
const remote: SessionRemote = {
  hostId: 'gpu',
  label: 'GPU',
  host: '10.0.0.42',
  username: 'ubuntu',
  remotePath: '/home/ubuntu/it is work',
};

/** The one argument ssh would send, as the login shell on the far end receives it. */
function sshArgument(launch: string): string {
  return execFileSync('/bin/sh', ['-c', `ssh() { for a; do l="$a"; done; printf '%s' "$l"; }; ${launch}`], {
    encoding: 'utf8',
  });
}

/** What follows `new-session … -c <dir>`, up to the end of that tmux command. */
function paneArgv(launch: string): string[] {
  const argv = execFileSync('/bin/sh', ['-c', `tmux() { printf '%s\\0' "$@"; }; ${sshArgument(launch)}`], {
    encoding: 'utf8',
  })
    .split('\0')
    .slice(0, -1);
  const head = argv.slice(0, argv.indexOf(';'));
  return head.slice(head.indexOf('-c', head.indexOf('new-session')) + 2);
}

const launches: Array<[string, Parameters<typeof buildRemoteLaunchCommand>[0]]> = [
  ...listClis().map((cli): [string, Parameters<typeof buildRemoteLaunchCommand>[0]] => [
    cli.id,
    { mode: cli.id as SessionMode, remote, sessionId: SESSION_ID },
  ]),
  ['shell', { mode: 'shell', remote, sessionId: SESSION_ID }],
  ['claude resume', { mode: 'claude', remote, sessionId: SESSION_ID, resumeSessionId: SESSION_ID }],
  ['omp resume', { mode: 'omp', remote, sessionId: SESSION_ID, resumeSessionId: 'abc123' }],
];

describe('the shell that parses a remote pane command', () => {
  it.each(launches)('%s: Codeman text goes to /bin/sh, never the default-shell', (_name, options) => {
    const argv = paneArgv(buildRemoteLaunchCommand(options));
    expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(argv).toHaveLength(3);
    expect(argv[2]).toContain(`cd '/home/ubuntu/it is work' && `);
  });

  it('leaves an override as one argument, parsed by the remote default-shell', () => {
    const override = 'source ~/env.sh && [[ -x ~/.local/bin/codx ]] && exec codx';
    const argv = paneArgv(
      buildRemoteLaunchCommand({
        mode: 'codex',
        remote: { ...remote, commands: { codex: override } },
        sessionId: SESSION_ID,
      })
    );
    expect(argv).toEqual([`cd '/home/ubuntu/it is work' && ${override}`]);
  });

  it('keeps the rest of the tmux chain behind the longer pane command', () => {
    const sent = sshArgument(buildRemoteLaunchCommand({ mode: 'shell', remote, sessionId: SESSION_ID }));
    expect(sent).toContain(String.raw` \; set -t codeman-ssh-abcd1234 status off \; `);
    expect(sent).toMatch(/set -t codeman-ssh-abcd1234 remain-on-exit failed$/);
  });
});
