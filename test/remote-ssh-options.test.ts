/**
 * @fileoverview COD-107 — Remote-host SSH: custom port + advanced connection options.
 *
 * Unit tests for the shared, pure `buildSshConnectionArgs(remote)` and its two
 * consumers (`buildRemoteLaunchCommand`, `buildRemoteTmuxCheckCommand`). The
 * acceptance target is the aa-desktop option set (custom port 2222, ed25519
 * identity under `~`, a cloudflared SOCKS5 ProxyCommand, plus an arbitrary
 * `-o` escape-hatch option) — the same connection `~/repos/claude-config/bin/
 * ssh-aa-desktop` makes, WITHOUT shelling out to that wrapper.
 *
 * Critical, easy-to-break invariants pinned here:
 *  - `%h %p` in the ProxyCommand reach ssh LITERALLY (one shellescaped
 *    `-o ProxyCommand=…` token; the local shell must not expand/mangle them).
 *  - a leading `~`/`$HOME` in `identityFile` is expanded to an absolute path at
 *    build time (ssh does NOT expand `~` in `-i`), then shellescaped.
 *  - empty options retain the SSH option order; tmux gets the shared PATH wrapper.
 *
 * Pure command-string construction; no real tmux, no ssh. Port: N/A.
 */

import { homedir } from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  buildSshConnectionArgs,
  buildRemoteTmuxCheckCommand,
  buildRemoteCliVersionProbeCommand,
  remoteSshTarget,
  shellescape,
  withRemoteTmuxPath,
} from '../src/remote-hosts.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types.js';

const HOME = homedir();

const baseRemote: SessionRemote = {
  hostId: 'gpu-box',
  label: 'GPU Box',
  host: '10.0.0.42',
  username: 'ubuntu',
  remotePath: '/home/ubuntu/work',
};

// The acceptance host: aa-desktop reached over the cloudflared SOCKS5 proxy.
const aaDesktop: SessionRemote = {
  hostId: 'aa-desktop',
  label: 'aa-desktop',
  host: '192.168.55.170',
  username: 'aakht',
  port: 2222,
  remotePath: '/tmp',
  identityFile: '~/.ssh/remote_ed25519',
  socksProxy: '127.0.0.1:1080',
  extraSshOptions: ['StrictHostKeyChecking=accept-new'],
  commands: { shell: 'exec bash -l' },
};

const SESSION_ID = 'cod107chk';

describe('COD-107 buildSshConnectionArgs — shared ssh connection tokens', () => {
  it('always leads with -o BatchMode=yes then the default -o ConnectTimeout=10', () => {
    expect(buildSshConnectionArgs(baseRemote)).toEqual(['ssh', '-o BatchMode=yes', '-o ConnectTimeout=10']);
  });

  it('emits the full aa-desktop option set in order with escaping + %h %p intact', () => {
    const args = buildSshConnectionArgs(aaDesktop);
    const joined = args.join(' ');

    // -p before -i before the proxy -o; identity ~ expanded absolute, then escaped.
    expect(joined).toContain('-o BatchMode=yes');
    expect(joined).toContain('-p 2222');
    expect(joined).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    // No literal tilde survives into the -i token.
    expect(joined).not.toContain('-i ~');
    expect(joined).not.toContain("-i '~");

    // The whole ProxyCommand (with its spaces and %h %p) is ONE shellescaped -o token.
    expect(joined).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    // %h %p must survive verbatim — they are ssh tokens, not shell tokens.
    expect(joined).toContain('%h %p');

    // The escape-hatch extra option, shellescaped.
    expect(joined).toContain("-o 'StrictHostKeyChecking=accept-new'");

    // Ordering: BatchMode -> port -> identity -> ProxyCommand -> extras.
    const idxBatch = joined.indexOf('BatchMode=yes');
    const idxPort = joined.indexOf('-p 2222');
    const idxIdentity = joined.indexOf('-i ');
    const idxProxy = joined.indexOf('ProxyCommand=');
    const idxExtra = joined.indexOf('StrictHostKeyChecking');
    expect(idxBatch).toBeLessThan(idxPort);
    expect(idxPort).toBeLessThan(idxIdentity);
    expect(idxIdentity).toBeLessThan(idxProxy);
    expect(idxProxy).toBeLessThan(idxExtra);
  });

  it('supports an explicit -J jump host (shellescaped, like its siblings)', () => {
    const args = buildSshConnectionArgs({ ...baseRemote, jumpHost: 'bastion@10.0.0.1:22' });
    expect(args.join(' ')).toContain("-J 'bastion@10.0.0.1:22'");
  });

  it('shellescapes a -J jump host containing shell metacharacters (no injection)', () => {
    // Defense-in-depth: even if a metachar-laden value slipped past schema validation,
    // it must stay a single shell token and never break out of the ssh command.
    const args = buildSshConnectionArgs({ ...baseRemote, jumpHost: 'x; touch /tmp/pwned' });
    const joined = args.join(' ');
    // The whole value is wrapped in single quotes — the `;` cannot start a new command.
    expect(joined).toContain("-J 'x; touch /tmp/pwned'");
    expect(joined).not.toContain('-J x;');
  });

  it('expands a $HOME-prefixed identity path', () => {
    const args = buildSshConnectionArgs({ ...baseRemote, identityFile: '$HOME/.ssh/id_ed25519' });
    expect(args.join(' ')).toContain(`-i '${HOME}/.ssh/id_ed25519'`);
  });

  it('empty options ⇒ BatchMode + the default ConnectTimeout (+ -p only when set)', () => {
    expect(buildSshConnectionArgs(baseRemote)).toEqual(['ssh', '-o BatchMode=yes', '-o ConnectTimeout=10']);
    expect(buildSshConnectionArgs({ ...baseRemote, port: 2200 })).toEqual([
      'ssh',
      '-o BatchMode=yes',
      '-o ConnectTimeout=10',
      '-p 2200',
    ]);
  });

  it('omits the default ConnectTimeout when extraSshOptions already sets it (operator wins)', () => {
    const args = buildSshConnectionArgs({ ...baseRemote, extraSshOptions: ['ConnectTimeout=3'] });
    expect(args.filter((a) => a.includes('ConnectTimeout'))).toEqual(["-o 'ConnectTimeout=3'"]);
  });
});

describe('COD-107 buildRemoteLaunchCommand — threads connection args', () => {
  it('emits the aa-desktop ssh connection options ahead of -t and the target', () => {
    const command = buildRemoteLaunchCommand({ mode: 'shell', remote: aaDesktop, sessionId: SESSION_ID });

    expect(command).toContain('-p 2222');
    expect(command).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    expect(command).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    expect(command).toContain("-o 'StrictHostKeyChecking=accept-new'");
    expect(command).toContain('-t');
    expect(command).toContain('aakht@192.168.55.170');
    expect(command).toContain('tmux -L codeman-remote new-session -A');

    // Connection options come BEFORE -t / the target / the tmux command.
    const idxProxy = command.indexOf('ProxyCommand=');
    const idxTarget = command.indexOf('aakht@192.168.55.170');
    expect(idxProxy).toBeLessThan(idxTarget);
  });

  it('preserves the no-options launch command inside the shared remote PATH wrapper', () => {
    const command = buildRemoteLaunchCommand({ mode: 'shell', remote: baseRemote, sessionId: SESSION_ID });
    // Reconstruct the command using the SAME nested POSIX single-quote escaping the
    // production code uses, preserving the payload inside the PATH wrapper. The DEDICATED
    // `-L codeman-remote` socket under a `codeman-ssh-` name that a remote Codeman's
    // discovery ignores; set-options are scoped per-session (never `-g`).
    const sh = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const remoteName = `codeman-ssh-${SESSION_ID.slice(0, 8)}`;
    const path = sh('/home/ubuntu/work');
    const paneCommand = `cd ${path} && exec "\${SHELL:-/bin/sh}" -i -l`;
    const tmuxInvocation = [
      `tmux -L codeman-remote new-session -A -s ${remoteName} -c ${path} ${sh(paneCommand)}`,
      `set -t ${remoteName} status off`,
      `set -t ${remoteName} mouse off`,
      `set -t ${remoteName} prefix C-q`,
      'set -s escape-time 0',
      // COD-106 — shared/collaborative sizing, per-session scoped (never -g).
      `set -t ${remoteName} window-size latest`,
      // #671 — the nested server's prefix table is stock unless this chain
      // reduces it. Ctrl+Q then ) would switch-client onto a sibling session.
      // Bind first: a user config that emptied the prefix table makes
      // `unbind-key -a` fail and tmux drops the rest of the `\;` chain,
      // including the bind and remain-on-exit. That option stays last because
      // a remote tmux that rejects `failed` aborts the rest of the chain.
      'bind-key -T prefix C-q send-prefix',
      'unbind-key -a -T prefix',
      'bind-key -T prefix C-q send-prefix',
      // #210 — keep a CRASHED pane for diagnosis. `failed` (not `on`, which would
      // also strand a pane after a clean `exit`), and LAST because tmux aborts the
      // remaining commands of a `\;` chain on error and `failed` needs tmux >= 3.2.
      `set -t ${remoteName} remain-on-exit failed`,
    ].join(' \\; ');
    // Connection args (with the default -o ConnectTimeout=10) sit after -t.
    const expected = `ssh -o BatchMode=yes -t -o ConnectTimeout=10 ${remoteSshTarget(baseRemote)} ${sh(withRemoteTmuxPath(tmuxInvocation))}`;
    expect(command).toBe(expected);
  });

  it('port-only remote places -p after the -t/ConnectTimeout tokens', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'shell',
      remote: { ...baseRemote, port: 2222 },
      sessionId: SESSION_ID,
    });
    expect(command).toMatch(/^ssh -o BatchMode=yes -t -o ConnectTimeout=10 -p 2222 ubuntu@10\.0\.0\.42 /);
  });
});

describe('COD-107 buildRemoteTmuxCheckCommand — same connection options as the launch', () => {
  it('uses the shared connection args (proxy/identity/port) plus ConnectTimeout', () => {
    const cmd = buildRemoteTmuxCheckCommand(aaDesktop);
    expect(cmd).toContain('-o BatchMode=yes');
    expect(cmd).toContain('-o ConnectTimeout=10');
    expect(cmd).toContain('-p 2222');
    expect(cmd).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    expect(cmd).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    expect(cmd).toContain('aakht@192.168.55.170');
    expect(cmd).toContain(shellescape(withRemoteTmuxPath('command -v tmux')));
  });

  it('no advanced options preserve the ssh prefix and wrap the tmux probe', () => {
    expect(buildRemoteTmuxCheckCommand({ username: 'ubuntu', host: '10.0.0.42' })).toBe(
      `ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@10.0.0.42 ${shellescape(withRemoteTmuxPath('command -v tmux'))}`
    );
    expect(buildRemoteTmuxCheckCommand({ username: 'ubuntu', host: '10.0.0.42', port: 2222 })).toContain('-p 2222');
  });
});

describe('buildRemoteCliVersionProbeCommand: remote CLI version over the same connection (#205)', () => {
  it('routes the version query through the interactive-login shell wrapper, like the launch', () => {
    const cmd = buildRemoteCliVersionProbeCommand(baseRemote, 'claude');
    // Same PATH-resolution wrapper as defaultRemoteCommandForMode: a bare
    // `claude --version` over ssh sees only sshd's minimal PATH (exit 127).
    expect(cmd).toBe(
      'ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@10.0.0.42 ' +
        `'exec "\${SHELL:-/bin/sh}" -i -l -c '\\''claude --version'\\'''`
    );
  });

  it('uses the shared connection args (proxy/identity/port), so it reaches what the launch reaches', () => {
    const cmd = buildRemoteCliVersionProbeCommand(aaDesktop, 'claude');
    expect(cmd).toContain('-o BatchMode=yes');
    expect(cmd).toContain('-p 2222');
    expect(cmd).toContain(`-i '${HOME}/.ssh/remote_ed25519'`);
    expect(cmd).toContain("-o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'");
    expect(cmd).toContain('aakht@192.168.55.170');
  });

  it('maps antigravity to its real binary name and shell to no probe at all', () => {
    expect(buildRemoteCliVersionProbeCommand(baseRemote, 'antigravity')).toContain('agy --version');
    expect(buildRemoteCliVersionProbeCommand(baseRemote, 'shell')).toBeNull();
  });
});
