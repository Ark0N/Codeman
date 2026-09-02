import { describe, it, expect } from 'vitest';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import { parseRemoteSessionList } from '../src/remote-hosts.js';
import type { SessionRemote } from '../src/types.js';

// COD-106 — shared/collaborative remote sessions: window-size policy so concurrent
// clients don't fight, and a client-count surfaced for the "shared · N" badge.
describe('COD-106 shared remote sessions', () => {
  const remote: SessionRemote = {
    hostId: 'h',
    label: 'aa',
    host: '192.168.55.170',
    username: 'aakht',
    remotePath: '/tmp',
    commands: { shell: 'exec bash -l' },
  };

  it('launch command sets window-size latest (so multi-client attach does not clamp to smallest)', () => {
    const cmd = buildRemoteLaunchCommand({ mode: 'shell', remote, sessionId: 'cod106aaa' });
    // Per-session scoped on the dedicated `codeman-remote` socket (PR #145 hardening).
    expect(cmd).toContain('set -t codeman-ssh-cod106aa window-size latest');
    // still has the COD-104 config (no regression)
    expect(cmd).toContain('set -t codeman-ssh-cod106aa status off');
    expect(cmd).toContain('new-session -A -s codeman-ssh-cod106aa');
  });

  it('remote omp relaunch resumes the pinned conversation instead of starting fresh (2026-08-29)', () => {
    const cmd = buildRemoteLaunchCommand({
      mode: 'omp',
      remote,
      sessionId: 'cod106aaa',
      ompConfig: { model: 'llm-proxy/crof/glm-5.3-flash' },
      resumeSessionId: '01a04eb1-d883-75f0-bdfa-74cc315b09ce',
    });
    // The remote pane command must carry the pinned omp session id so a
    // dead-pane respawn lands back in the same conversation.
    expect(cmd).toContain('omp --model llm-proxy/crof/glm-5.3-flash --resume 01a04eb1-d883-75f0-bdfa-74cc315b09ce');
    // still a durable, idempotent remote tmux session
    expect(cmd).toContain('new-session -A -s codeman-ssh-cod106aa');
  });

  it('remote omp relaunch falls back to --continue when no id is pinned', () => {
    const cmd = buildRemoteLaunchCommand({
      mode: 'omp',
      remote,
      sessionId: 'cod106aaa',
      ompConfig: { continueSession: true },
    });
    expect(cmd).toContain('omp --continue');
  });

  it('parses session_attached as a CLIENT COUNT (>1 = shared)', () => {
    const rows = parseRemoteSessionList(
      ['codeman-solo\\t1\\t100\\t1', 'codeman-shared\\t2\\t200\\t3', 'codeman-idle\\t0\\t300\\t1'].join('\n')
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName['codeman-solo'].attachedClients).toBe(1);
    expect(byName['codeman-solo'].attached).toBe(true);
    expect(byName['codeman-shared'].attachedClients).toBe(2); // shared
    expect(byName['codeman-shared'].attached).toBe(true);
    expect(byName['codeman-idle'].attachedClients).toBe(0);
    expect(byName['codeman-idle'].attached).toBe(false);
  });
});
