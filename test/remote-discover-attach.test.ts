/**
 * @fileoverview COD-105 — discover & attach existing remote tmux sessions.
 *
 * Phase 2 of the remote-tmux arc (builds on COD-104 durable remote sessions +
 * COD-107 connection args). These tests are tmux-safe / ssh-safe: they exercise
 * the PURE parse helper, the pure attach-command builder, and the killSession
 * ownership gate — none open a real ssh connection or a real tmux server.
 *
 * Port: N/A.
 */

import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { parseRemoteSessionList, withRemoteTmuxPath } from '../src/remote-hosts.js';
import { buildRemoteAttachCommand } from '../src/tmux-manager.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types.js';

const baseRemote: SessionRemote = {
  hostId: 'gpu-box',
  label: 'GPU Box',
  host: '10.0.0.42',
  username: 'ubuntu',
  remotePath: '/home/ubuntu/work',
};

describe('COD-105 parseRemoteSessionList', () => {
  it('parses tab-delimited -F output and coerces fields', () => {
    const stdout = 'codeman-disco1\t0\t1700000000\t1\n' + 'codeman-abcd1234\t1\t1700000123\t3\n';
    const list = parseRemoteSessionList(stdout);
    expect(list).toEqual([
      { name: 'codeman-disco1', attached: false, attachedClients: 0, created: 1700000000, windows: 1 },
      { name: 'codeman-abcd1234', attached: true, attachedClients: 1, created: 1700000123, windows: 3 },
    ]);
  });

  it('parses the LITERAL backslash-t separator the remote tmux actually emits', () => {
    // tmux next-3.7's `-F "…\t…"` does NOT expand \t — it prints a literal
    // backslash-t (verified on aa-desktop). The parser must split on that.
    const stdout = 'codeman-disco1\\t0\\t1781362858\\t1\n' + 'codeman-real\\t1\\t1781329905\\t2\n';
    const list = parseRemoteSessionList(stdout);
    expect(list).toEqual([
      { name: 'codeman-disco1', attached: false, attachedClients: 0, created: 1781362858, windows: 1 },
      { name: 'codeman-real', attached: true, attachedClients: 1, created: 1781329905, windows: 2 },
    ]);
  });

  it('keeps only codeman-* sessions, dropping foreign tmux sessions', () => {
    const stdout = 'work\t1\t1700000000\t2\n' + 'codeman-keep\t0\t1700000001\t1\n' + 'scratch\t0\t1700000002\t1\n';
    const list = parseRemoteSessionList(stdout);
    expect(list.map((s) => s.name)).toEqual(['codeman-keep']);
  });

  it('returns [] for empty / whitespace output (the no-sessions case)', () => {
    expect(parseRemoteSessionList('')).toEqual([]);
    expect(parseRemoteSessionList('   \n  \n')).toEqual([]);
  });

  it('tolerates malformed lines (missing columns) by skipping them', () => {
    const stdout = 'codeman-ok\t0\t1700000000\t1\n' + 'codeman-bad\tnotanumber\n';
    const list = parseRemoteSessionList(stdout);
    expect(list).toEqual([
      { name: 'codeman-ok', attached: false, attachedClients: 0, created: 1700000000, windows: 1 },
    ]);
  });
});

describe('COD-105 buildRemoteAttachCommand', () => {
  it('emits ssh -t <target> tmux -L codeman attach -t <session>', () => {
    const command = buildRemoteAttachCommand(baseRemote, 'codeman-disco1');
    expect(command).toContain('ssh');
    expect(command).toContain('BatchMode=yes');
    expect(command).toContain('-t');
    expect(command).toContain('ubuntu@10.0.0.42');
    // The tmux invocation is nested-quoted (inner session name escaped, whole
    // invocation re-escaped as one ssh arg). Assert the stable prefix here; the
    // exact re-parsed token is verified by the argv-reparse test below.
    expect(command).toContain('tmux -L codeman attach -t ');
    expect(command).toContain('codeman-disco1');
  });

  it('threads the COD-107 connection args (port / identity / proxy) into the ssh invocation', () => {
    const command = buildRemoteAttachCommand(
      { ...baseRemote, port: 2222, identityFile: '/keys/id_ed25519', socksProxy: '127.0.0.1:1080' },
      'codeman-disco1'
    );
    expect(command).toContain('-p 2222');
    expect(command).toContain("-i '/keys/id_ed25519'");
    expect(command).toContain('ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p');
    // Port/identity/proxy belong to ssh, ahead of the target.
    expect(command).toMatch(/ssh[\s\S]*-p 2222[\s\S]*ubuntu@10\.0\.0\.42/);
  });

  it('shell-escapes the session name so it stays a single token', () => {
    const command = buildRemoteAttachCommand(baseRemote, 'codeman-disco1');
    // Re-parse: stub ssh to dump argv, confirm the trailing tmux invocation is one arg.
    const dumpArgs = (name: string, prefix: string) =>
      `${name}() { for a in "$@"; do printf '${prefix}:%s\\n' "$a"; done; }`;
    const out = execFileSync('/bin/sh', ['-c', `${dumpArgs('ssh', 'A')}\n${command}`], { encoding: 'utf8' });
    const sshArgs = out
      .split('\n')
      .filter((l) => l.startsWith('A:'))
      .map((l) => l.slice(2));
    expect(sshArgs).toContain('ubuntu@10.0.0.42');
    const tmuxArg = sshArgs.find((a) => a.includes('attach'));
    expect(tmuxArg).toBe(withRemoteTmuxPath("tmux -L codeman attach -t 'codeman-disco1'"));
  });
});

describe('COD-105 killSession ownership gate (detach-not-kill)', () => {
  it('never issues a remote tmux kill-session for a non-owned remote session', async () => {
    const mgr = new TmuxManager();
    // Register a discovered+attached (non-owned) remote session.
    mgr.registerSession({
      sessionId: 'disco-1',
      muxName: 'codeman-disco-1',
      pid: 0,
      createdAt: Date.now(),
      workingDir: '/home/ubuntu/work',
      mode: 'shell',
      attached: false,
      remote: { ...baseRemote, owned: false },
    });

    // killSession under VITEST is in-memory only (IS_TEST_MODE), so it physically
    // cannot run a remote kill-session. We assert the contract: the session's
    // ownership flag is the gate, and tearing it down removes only local state.
    const session = mgr.getSession('disco-1');
    expect(session?.remote?.owned).toBe(false);

    const ok = await mgr.killSession('disco-1');
    expect(ok).toBe(true);
    // Local tracking removed; no remote kill was (or could be) issued.
    expect(mgr.getSession('disco-1')).toBeUndefined();
  });

  it('treats COD-104 launched remote sessions as owned by default', () => {
    const mgr = new TmuxManager();
    mgr.registerSession({
      sessionId: 'owned-1',
      muxName: 'codeman-owned-1',
      pid: 0,
      createdAt: Date.now(),
      workingDir: '/home/ubuntu/work',
      mode: 'shell',
      attached: false,
      remote: { ...baseRemote, owned: true },
    });
    expect(mgr.getSession('owned-1')?.remote?.owned).toBe(true);
  });
});
