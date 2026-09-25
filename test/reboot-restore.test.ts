/**
 * @fileoverview The decision half of reboot restore, and proof that the existing
 * recovery construction path can CREATE a resumed pane.
 *
 * Three things are under test. `src/reboot-restore.ts` decides whether the
 * machine rebooted and which dead sessions may be offered back. The plan
 * registry in `src/web/reboot-restore-registry.ts` holds that offer between the
 * boot that builds it and the click that spends it. The third is the claim the
 * whole feature rests on: a `Session` built the way `restoreMuxSessions()`
 * already builds one, but given no `muxSession` and a `resumeSessionId`, creates
 * a fresh pane that resumes the old conversation. If that holds, the restore
 * needs no new session-creation service.
 *
 * `reconcileSessions()` reports every session ALIVE under vitest, so the
 * server's own boot pass cannot be reached from here. The decision logic is
 * therefore driven directly, and the construction claim is driven through a real
 * `Session` against the in-memory tmux layer vitest substitutes.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { SessionState } from '../src/types.js';
import {
  looksLikeHostReboot,
  newestPersistedActivity,
  planRebootRestore,
  rejectAlreadyLive,
  resolveResumeConversationId,
  type RebootRestoreEntry,
} from '../src/reboot-restore.js';
import { RebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

function persistedSession(overrides: Partial<SessionState> & { id: string }): SessionState {
  return {
    // A live agent's record carries its process id; `/exit` persists null instead.
    pid: 99999,
    status: 'idle',
    workingDir: '/tmp/spike',
    currentTaskId: null,
    createdAt: NOW - 4 * HOUR,
    lastActivityAt: NOW - 2 * HOUR,
    mode: 'claude',
    ...overrides,
  } as SessionState;
}

describe('reboot detection', () => {
  const base = {
    livePaneCount: 0,
    deadSessionCount: 2,
    // The host came up 10 minutes ago, well after the sessions were last active.
    uptimeSeconds: 600,
    newestPersistedActivityAt: NOW - 2 * HOUR,
    now: NOW,
  };

  it('calls it a reboot when the socket is empty and the host booted after the last activity', () => {
    expect(looksLikeHostReboot(base)).toBe(true);
  });

  it('refuses when some panes survived, which is an ordinary server restart', () => {
    expect(looksLikeHostReboot({ ...base, livePaneCount: 3 })).toBe(false);
  });

  it('refuses on a long-uptime host, where someone wiped the tmux socket by hand', () => {
    // Up for 30 days: the sessions were active long AFTER this boot, so the panes
    // went away for some reason other than the machine restarting.
    expect(looksLikeHostReboot({ ...base, uptimeSeconds: 30 * 24 * 60 * 60 })).toBe(false);
  });

  it('refuses when nothing died', () => {
    expect(looksLikeHostReboot({ ...base, deadSessionCount: 0 })).toBe(false);
  });

  it('reads the newest activity stamp across the persisted records', () => {
    const persisted = {
      a: persistedSession({ id: 'a', lastActivityAt: NOW - 5 * HOUR }),
      b: persistedSession({ id: 'b', lastActivityAt: NOW - 1 * HOUR }),
    };
    expect(newestPersistedActivity(persisted)).toBe(NOW - 1 * HOUR);
  });
});

describe('which dead sessions may be rebuilt', () => {
  it('rebuilds a session that was simply running when the power went out', () => {
    const persisted = { live: persistedSession({ id: 'live', status: 'busy' }) };
    const plan = planRebootRestore(['live'], persisted, () => true);
    expect(plan.restore.map((s) => s.sessionId)).toEqual(['live']);
  });

  it('never revives a session the user killed while pinned (COD-142 demotes it to stopped)', () => {
    const persisted = { killed: persistedSession({ id: 'killed', status: 'stopped', pinned: true }) };
    const plan = planRebootRestore(['killed'], persisted, () => true);
    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: 'killed', reason: 'intentionally-ended' }]);
  });

  it('never revives a session whose record an unpinned kill already deleted', () => {
    const plan = planRebootRestore(['gone'], {}, () => true);
    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: 'gone', reason: 'no-persisted-record' }]);
  });

  it('never revives a session whose agent the user ended with a clean exit (#446)', () => {
    // The clean-exit sweep would have closed it, had the power not gone first.
    const persisted = { exited: persistedSession({ id: 'exited', paneExit: { status: 0, at: NOW - HOUR } }) };
    const plan = planRebootRestore(['exited'], persisted, () => true);
    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: 'exited', reason: 'agent-exited' }]);
  });

  it('still offers a crashed agent, and one whose exit status tmux never reported', () => {
    // Same explicit-0 rule as the sweep: an absent status is unknown, not clean,
    // and a crash keeps its row on the board, so it stays eligible here too.
    const persisted = {
      crashed: persistedSession({ id: 'crashed', paneExit: { status: 137, at: NOW - HOUR } }),
      killed: persistedSession({ id: 'killed', paneExit: { at: NOW - HOUR } }),
    };
    const plan = planRebootRestore(['crashed', 'killed'], persisted, () => true);
    expect(plan.restore.map((s) => s.sessionId)).toEqual(['crashed', 'killed']);
  });

  it('never revives a pane whose PTY-exit breaker had tripped', () => {
    const persisted = { crashy: persistedSession({ id: 'crashy', respawnBlocked: true }) };
    expect(planRebootRestore(['crashy'], persisted, () => true).skipped[0].reason).toBe('respawn-blocked');
  });

  it('leaves remote sessions to the COD-108 reconnect watcher', () => {
    const persisted = {
      r: persistedSession({
        id: 'r',
        remote: { hostId: 'h', host: 'example.test', username: 'u', sessionName: 'n', owned: true },
      } as Partial<SessionState> & { id: string }),
    };
    expect(planRebootRestore(['r'], persisted, () => true).skipped[0].reason).toBe('remote-or-docker');
  });

  it('leaves docker sessions alone, since the container may not be up', () => {
    const persisted = {
      d: persistedSession({ id: 'd', docker: { containerId: 'abc', caseId: 'c' } } as Partial<SessionState> & {
        id: string;
      }),
    };
    expect(planRebootRestore(['d'], persisted, () => true).skipped[0].reason).toBe('remote-or-docker');
  });

  it('skips a CLI whose history the claude transcript reader does not understand', () => {
    const persisted = { c: persistedSession({ id: 'c', mode: 'codex' }) };
    expect(planRebootRestore(['c'], persisted, () => true).skipped[0].reason).toBe('unsupported-mode');
  });
});

describe('a session with no attach process in its record', () => {
  it('is refused, because there was nothing running to bring back', () => {
    // A session that never started, or whose pane died outright. NOT a session
    // the user ended with `/exit`: that keeps its pid, because the pid is the
    // tmux attach process and `remain-on-exit` keeps the pane alive.
    const persisted = { exited: persistedSession({ id: 'exited', status: 'idle', pid: null }) };
    const plan = planRebootRestore(['exited'], persisted, () => true);
    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: 'exited', reason: 'not-running' }]);
  });

  it('still restores the session beside it that was attached when the power went', () => {
    const persisted = {
      exited: persistedSession({ id: 'exited', pid: null }),
      running: persistedSession({ id: 'running', pid: 4242 }),
    };
    const plan = planRebootRestore(['exited', 'running'], persisted, () => true);
    expect(plan.restore.map((entry) => entry.sessionId)).toEqual(['running']);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['not-running']);
  });

  it('refuses a record with no pid field at all', () => {
    const persisted = { odd: persistedSession({ id: 'odd', pid: undefined as unknown as null }) };
    expect(planRebootRestore(['odd'], persisted, () => true).skipped[0].reason).toBe('not-running');
  });
});

describe('a workspace that is no longer on disk', () => {
  it('is kept out of the offer, so a click cannot scaffold a deleted repo', () => {
    const persisted = { gone: persistedSession({ id: 'gone', workingDir: '/tmp/deleted-repo' }) };
    const plan = planRebootRestore(['gone'], persisted, () => false);
    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: 'gone', reason: 'workspace-missing' }]);
  });

  it('is judged per session, not for the batch', () => {
    const persisted = {
      kept: persistedSession({ id: 'kept', workingDir: '/tmp/still-here' }),
      gone: persistedSession({ id: 'gone', workingDir: '/tmp/deleted-repo' }),
    };
    const plan = planRebootRestore(['kept', 'gone'], persisted, (dir) => dir === '/tmp/still-here');
    expect(plan.restore.map((entry) => entry.sessionId)).toEqual(['kept']);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['workspace-missing']);
  });
});

describe('a conversation that came back on its own before the click', () => {
  const entry: RebootRestoreEntry = {
    sessionId: 'abc',
    workingDir: '/tmp/spike',
    mode: 'claude',
    resumeConversationId: 'conv-1',
    state: persistedSession({ id: 'abc' }),
  };

  it('is skipped when the user resumed it by hand from the Resume list', () => {
    // Same conversation, different session id: the Resume list creates a NEW id.
    const result = rejectAlreadyLive([entry], new Set(['other']), new Set(['conv-1']));
    expect(result.restore).toEqual([]);
    expect(result.skipped).toEqual([{ sessionId: 'abc', reason: 'already-live' }]);
  });

  it('is skipped when a session with that id is already on the board', () => {
    const result = rejectAlreadyLive([entry], new Set(['abc']), new Set());
    expect(result.skipped).toEqual([{ sessionId: 'abc', reason: 'already-live' }]);
  });

  it('is rebuilt when neither its id nor its conversation is live', () => {
    const result = rejectAlreadyLive([entry], new Set(['other']), new Set(['conv-other']));
    expect(result.restore.map((e) => e.sessionId)).toEqual(['abc']);
    expect(result.skipped).toEqual([]);
  });
});

describe('the plan the banner spends', () => {
  const all = () => true;
  const entryFor = (sessionId: string, owner?: string): RebootRestoreEntry => ({
    sessionId,
    owner,
    workingDir: '/tmp/spike',
    mode: 'claude',
    resumeConversationId: `conv-${sessionId}`,
    state: persistedSession({ id: sessionId, owner }),
  });

  it('hands an entry to the first caller and nothing to the second', () => {
    const registry = new RebootRestoreRegistry();
    registry.set([entryFor('a'), entryFor('b')]);
    expect(registry.take(all, undefined, undefined).map((e) => e.sessionId)).toEqual(['a', 'b']);
    // The double-click: two panes on one conversation is what this prevents.
    expect(registry.take(all, undefined, undefined)).toEqual([]);
  });

  it('spends only the ids a caller asked for', () => {
    const registry = new RebootRestoreRegistry();
    registry.set([entryFor('a'), entryFor('b')]);
    expect(registry.take(all, ['b'], undefined).map((e) => e.sessionId)).toEqual(['b']);
    expect(registry.list(all).map((e) => e.sessionId)).toEqual(['a']);
  });

  it("shows a user their own sessions and leaves another owner's alone", () => {
    const registry = new RebootRestoreRegistry();
    registry.set([entryFor('mine', 'alice'), entryFor('theirs', 'bob')]);
    const asAlice = (owner: string | undefined) => owner === 'alice';
    expect(registry.list(asAlice).map((e) => e.sessionId)).toEqual(['mine']);
    expect(registry.take(asAlice, undefined, 'alice').map((e) => e.sessionId)).toEqual(['mine']);
    // Bob's entry is still on offer for Bob.
    expect(registry.list(() => true).map((e) => e.sessionId)).toEqual(['theirs']);
  });

  it('puts back an entry that no pane was created for', () => {
    const registry = new RebootRestoreRegistry();
    registry.set([entryFor('a')]);
    const taken = registry.take(all, undefined, undefined);
    registry.releaseFlight(undefined, taken);
    expect(registry.list(all).map((e) => e.sessionId)).toEqual(['a']);
  });

  it('runs one restore at a time', () => {
    const registry = new RebootRestoreRegistry();
    expect(registry.beginSpending()).toBe(true);
    expect(registry.beginSpending()).toBe(false);
    registry.endSpending();
    expect(registry.beginSpending()).toBe(true);
  });

  it('drops what a dismiss cleared', () => {
    const registry = new RebootRestoreRegistry();
    registry.set([entryFor('a'), entryFor('b')]);
    expect(registry.clear(all)).toBe(2);
    expect(registry.list(all)).toEqual([]);
  });

  it('forgets a plan nobody took for a day', () => {
    const registry = new RebootRestoreRegistry();
    registry.set([entryFor('a')]);
    const dayLater = Date.now() + 25 * HOUR;
    const realNow = Date.now;
    Date.now = () => dayLater;
    try {
      expect(registry.list(all)).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('which conversation a rebuilt pane resumes', () => {
  it('prefers the chain tail, the conversation the CLI reported last', () => {
    const state = persistedSession({
      id: 'sess-1',
      resumeSessionId: 'launch-id',
      claudeSessionChain: ['launch-id', 'after-clear'],
    });
    expect(resolveResumeConversationId(state)).toBe('after-clear');
  });

  it('falls back to the id the session originally resumed', () => {
    const state = persistedSession({ id: 'sess-1', resumeSessionId: 'resumed-id' });
    expect(resolveResumeConversationId(state)).toBe('resumed-id');
  });

  it('falls back to the session id, which is what Claude was launched with', () => {
    expect(resolveResumeConversationId(persistedSession({ id: 'sess-1' }))).toBe('sess-1');
  });
});

describe('the recovery construction path can create a resumed pane', () => {
  const workingDir = join(homedir(), 'codeman-cases', 'reboot-restore-spike');
  const sessions: Session[] = [];

  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    rmSync(workingDir, { recursive: true, force: true });
  });

  /** Built exactly as the reboot pass builds one: no `muxSession`, plus a resume id. */
  function rebuildFromPersistedState(state: SessionState, mux: TmuxManager): Session {
    mkdirSync(workingDir, { recursive: true });
    const session = new Session({
      id: state.id,
      workingDir,
      mode: state.mode,
      name: state.name,
      createdAt: state.createdAt,
      mux,
      useMux: true,
      resumeSessionId: resolveResumeConversationId(state),
      owner: state.owner,
      lastActivityAt: state.lastActivityAt,
      claudeSessionChain: state.claudeSessionChain,
    });
    sessions.push(session);
    return session;
  }

  it('creates a NEW mux session rather than needing one to attach to', async () => {
    const mux = new TmuxManager();
    const state = persistedSession({ id: 'aaaaaaa1-1111-4111-8111-111111111111', name: 'w1-spike' });
    const session = rebuildFromPersistedState(state, mux);

    expect(mux.getSessions()).toHaveLength(0);
    await session.startInteractive();

    const created = mux.getSessions();
    expect(created).toHaveLength(1);
    expect(created[0].sessionId).toBe('aaaaaaa1-1111-4111-8111-111111111111');
    expect(created[0].workingDir).toBe(workingDir);
  });

  it('comes back pointed at the conversation the pane was holding', async () => {
    const mux = new TmuxManager();
    const state = persistedSession({
      id: 'aaaaaaa2-2222-4222-8222-222222222222',
      resumeSessionId: 'launch-id',
      claudeSessionChain: ['launch-id', 'after-clear'],
    });
    const session = rebuildFromPersistedState(state, mux);

    await session.startInteractive();

    // The chain tail wins: a `/clear` before the reboot moved the CLI off the launch id.
    expect(session.claudeSessionId).toBe('after-clear');
  });

  it('comes back idle, with no prompt sent and no autonomous loop armed', async () => {
    const mux = new TmuxManager();
    const state = persistedSession({
      id: 'aaaaaaa3-3333-4333-8333-333333333333',
      ralphEnabled: true,
      respawnEnabled: true,
    });
    const session = rebuildFromPersistedState(state, mux);

    await session.startInteractive();

    // No prompt was queued: nothing is waiting on a task. The status itself is not
    // assertable here, because the test PTY echoes and the activity detector reads
    // that echo as work; in production the pane settles once the CLI finishes booting.
    expect(session.currentTaskId).toBeNull();
    // The pass never touches the tracker, so a persisted Ralph loop stays cold.
    expect(session.ralphTracker.enabled).toBe(false);
  });

  it('keeps the owner it was persisted with, there being no request to read one from', async () => {
    const mux = new TmuxManager();
    const state = persistedSession({ id: 'aaaaaaa4-4444-4444-8444-444444444444', owner: 'alice' });
    const session = rebuildFromPersistedState(state, mux);

    await session.startInteractive();

    expect(session.owner).toBe('alice');
    expect(mux.getSessions()[0].owner).toBe('alice');
  });
});
