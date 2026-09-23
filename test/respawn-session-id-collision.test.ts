/**
 * @fileoverview Relaunching a pane must resume its conversation, not collide
 * with it, and must not resume somebody else's.
 *
 * A CLI that launches with `--session-id <id>` refuses an id that is already in
 * use (claude: `Error: Session ID ... is already in use.`), and every session
 * whose agent has been prompted owns a transcript under that id. A relaunch
 * that passes the bare launch line therefore dies on startup, the pane goes
 * dead again at once, and the conversation is stranded.
 *
 * `restartCli()` has pinned a resume id for this reason since the custom-model
 * work. The dead-pane respawn in `_setupOrAttachMuxSession()` did not, and its
 * comment said so explicitly — "Unlike the dead-pane respawn, this one kills a
 * WORKING pane whose conversation already has a transcript". That assumption is
 * what these tests refute: a pane whose agent exited has a transcript too.
 *
 * The pin walks three candidates — the conversation chain's tail, the launch
 * seed, then the session's own id — and takes the first one a transcript backs.
 * Most of these tests are about the four gates on that walk rather than about
 * the pin, because each gate stands for a way of resuming the WRONG
 * conversation or of making a working relaunch fail. Two more are about what
 * the walk does when a candidate misses: it carries on to the next, and pinning
 * nothing is the right answer only once every candidate has missed.
 *
 * Port: N/A
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import { claudeTranscriptExists } from '../src/utils/claude-transcript.js';
import type {
  CreateSessionOptions,
  MuxSession,
  RespawnPaneOptions,
  TerminalMultiplexer,
} from '../src/mux-interface.js';

/** Captures the options each respawn is invoked with. */
function recordingMux() {
  const calls: RespawnPaneOptions[] = [];
  const mux = {
    isAvailable: () => true,
    muxSessionExists: () => true,
    isPaneDead: () => true,
    // Called by the PTY-exit handler during teardown. Absent, it throws
    // asynchronously after the test body has already passed, which vitest
    // reports as an unhandled error rather than a failure.
    setAttached: () => {},
    respawnPane: async (options: RespawnPaneOptions) => {
      calls.push(options);
      return 4242;
    },
  };
  return { mux: mux as unknown as TerminalMultiplexer, calls };
}

const muxSession = (muxName = 'codeman-aaaa') => ({ muxName, sessionId: 'aaaa' }) as unknown as MuxSession;

/**
 * A mux whose `respawnPane` fails, which is what sends
 * `_setupOrAttachMuxSession()` down its create-a-new-session fallback — the
 * path that has to pin too, since it meets the same refusal the respawn just
 * lost to.
 */
function failingRespawnMux() {
  const calls: CreateSessionOptions[] = [];
  const mux = {
    isAvailable: () => true,
    muxSessionExists: () => true,
    isPaneDead: () => true,
    setAttached: () => {},
    respawnPane: async () => 0,
    createSession: async (options: CreateSessionOptions) => {
      calls.push(options);
      return muxSession('codeman-recreated');
    },
  };
  return { mux: mux as unknown as TerminalMultiplexer, calls };
}

/**
 * A mux whose tmux lost the WHOLE session (tmux kill-server, a crash, an
 * external kill-session), not just the pane. `_setupOrAttachMuxSession()` drops
 * its stale handle and goes straight to `createSession()`, relaunching the CLI
 * exactly as the failed-respawn fallback does.
 */
function vanishedSessionMux() {
  const calls: CreateSessionOptions[] = [];
  const respawns: RespawnPaneOptions[] = [];
  const mux = {
    isAvailable: () => true,
    muxSessionExists: () => false,
    isPaneDead: () => false,
    setAttached: () => {},
    respawnPane: async (options: RespawnPaneOptions) => {
      respawns.push(options);
      return 4242;
    },
    createSession: async (options: CreateSessionOptions) => {
      calls.push(options);
      return muxSession('codeman-recreated');
    },
  };
  return { mux: mux as unknown as TerminalMultiplexer, calls, respawns };
}

const CONVERSATION = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';

let configDir: string;

/** A relocated Claude config dir, so the transcript gate reads a real fixture. */
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codeman-transcript-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** Write the `<id>.jsonl` Claude would have written for a conversation. */
function giveTranscript(conversationId: string): void {
  const projectDir = join(configDir, 'projects', '-tmp-case');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${conversationId}.jsonl`), '{"type":"user"}\n');
}

function localSession(extra: Record<string, unknown> = {}, mux?: TerminalMultiplexer) {
  return new Session({
    workingDir: '/tmp',
    mode: 'claude',
    useMux: true,
    mux,
    muxSession: muxSession(),
    envOverrides: { CLAUDE_CONFIG_DIR: configDir },
    ...extra,
  });
}

describe('pinning a conversation onto a relaunch', () => {
  it('pins the chain tail on the DEAD-PANE respawn, which is the bug', async () => {
    // The path a recovered `/exit`ed session takes, and the one that was
    // missing the pin. Driven through `startInteractive()` rather than asserted
    // from source: a comment claiming a thing happens is exactly what was wrong
    // here before.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);

    await session.startInteractive();
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].resumeSessionId).toBe(CONVERSATION);
    } finally {
      await session.stop();
    }
  });

  it('pins the chain tail on a custom-model restart too', async () => {
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBe(CONVERSATION);
  });

  it('prefers the live chain tail over the launch seed', async () => {
    // `_resumeSessionId` is written once at construction and never moves, so a
    // `/clear` after launch leaves it pointing at the predecessor. Resuming
    // that would reopen an abandoned conversation and strand the live one.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession(
      { resumeSessionId: 'bbbbcccc-dddd-eeee-ffff-000011112222', claudeSessionChain: [CONVERSATION] },
      mux
    );

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBe(CONVERSATION);
  });

  it('falls back to the launch seed when no conversation was ever recorded', async () => {
    const seed = 'bbbbcccc-dddd-eeee-ffff-000011112222';
    giveTranscript(seed);
    const { mux, calls } = recordingMux();
    const session = localSession({ resumeSessionId: seed }, mux);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBe(seed);
  });

  it('never resumes an id the conversation chain did not vouch for', async () => {
    // `_claudeSessionId` also holds history-CORRELATED guesses, keyed on the
    // working directory, which the chain deliberately refuses. Launching from
    // one would open and WRITE to a conversation that was never this pane's —
    // worse than the display bug that rule exists to prevent.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession({}, mux);
    // Backed, so the walk reaching it pins it. Without this the session would
    // land unpinned for want of a transcript rather than for refusing the
    // guess, and the test would pass while proving nothing.
    giveTranscript(session.id);
    session.adoptClaudeSessionId(CONVERSATION); // no firstHand flag: a guess
    expect(session.claudeSessionId).toBe(CONVERSATION);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).not.toBe(CONVERSATION);
    expect(calls[0].resumeSessionId).toBe(session.id);
  });

  it('degrades to the session id rather than to the colliding bare command', async () => {
    // The chain tail is gone from disk but the session's own id is not, which
    // is every session prompted before its first `/clear`. Dropping the pin
    // outright hands back `--session-id <this.id>` alone — the very refusal
    // this whole mechanism removes — so the walk carries on to the next
    // candidate instead of stopping at the first miss.
    const { mux, calls } = recordingMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);
    giveTranscript(session.id);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBe(session.id);
  });

  it('pins nothing at all when no candidate has a transcript', async () => {
    // Falling off the end of the walk is the one case where the bare
    // `--session-id <this.id>` is right: nothing on disk can collide with it,
    // and pinning anyway would cost a brand-new pane claude's "No conversation
    // found" line plus the `nice` priority on the branch that actually runs.
    // The walk only ever ADDS a pin, so a session launched as a resume keeps
    // the seed its options already carried — see the custom-model restart
    // tests, which cover that case.
    const { mux, calls } = recordingMux();
    const session = localSession({}, mux);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBeUndefined();
  });

  it('pins the create-path fallback after a failed respawn', async () => {
    // The recovery of last resort would otherwise meet the same refusal that
    // made it the fallback, since the create options were built eagerly from
    // the unpinned launch seed.
    giveTranscript(CONVERSATION);
    const { mux, calls } = failingRespawnMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);

    await session.startInteractive();
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].resumeSessionId).toBe(CONVERSATION);
    } finally {
      await session.stop();
    }
  });

  it('leaves the session naming the conversation the create path resumed', async () => {
    // That path leaves `isRestored` false, so `_claudeSessionId` is recomputed
    // from the launch fields and lands on `this.id` unless the pin is written
    // back to `_resumeSessionId` as well. The response viewer, Read My Mind and
    // the unified-list alias map read that field until the next first-hand
    // hook, so a mismatch points all three at a conversation claude never
    // opened.
    giveTranscript(CONVERSATION);
    const { mux } = failingRespawnMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);

    await session.startInteractive();
    try {
      expect(session.claudeSessionId).toBe(CONVERSATION);
    } finally {
      await session.stop();
    }
  });

  it('pins the create path when tmux lost the whole session, not just the pane', async () => {
    // The stale-session branch nulls the handle and never sets the failed-respawn
    // flag, so without its own pin the relaunch carried the bare launch line and
    // met the same `--session-id ... already in use` refusal.
    giveTranscript(CONVERSATION);
    const { mux, calls, respawns } = vanishedSessionMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);

    await session.startInteractive();
    try {
      expect(respawns).toHaveLength(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].resumeSessionId).toBe(CONVERSATION);
      expect(session.claudeSessionId).toBe(CONVERSATION);
    } finally {
      await session.stop();
    }
  });

  it('leaves a genuinely new session unpinned on the create path', async () => {
    // No mux handle to begin with, so the stale-session flag is never set and
    // the create options keep their original shape.
    const { mux, calls } = vanishedSessionMux();
    const session = localSession({ muxSession: undefined }, mux);
    giveTranscript(session.id);

    await session.startInteractive();
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0].resumeSessionId).toBeUndefined();
    } finally {
      await session.stop();
    }
  });

  it('names the conversation the dead-pane respawn actually resumed', async () => {
    // The chain tail has no transcript, so the walk degrades to the session id.
    // The session must then report that id, not the chain tail claude never
    // opened: the response viewer, Read My Mind and the alias map all read it.
    const { mux, calls } = recordingMux();
    const session = localSession({ claudeSessionChain: [CONVERSATION] }, mux);
    giveTranscript(session.id);

    await session.startInteractive();
    try {
      expect(calls[0].resumeSessionId).toBe(session.id);
      expect(session.claudeSessionId).toBe(session.id);
    } finally {
      await session.stop();
    }
  });

  it('pins nothing for a remote session, whose conversation lives elsewhere', async () => {
    // The dead-pane respawn is reached by every session shape, unlike
    // `restartCli()` whose route refuses remote. A local id pinned onto a
    // remote pane resolves to nothing there, and the `--session-id` fallback
    // then collides with the transcript the remote host really does hold.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession(
      {
        remote: { hostId: 'h1', label: 'box', host: 'box', username: 'dev', remotePath: '/tmp' },
        claudeSessionChain: [CONVERSATION],
      },
      mux
    );

    await session.startInteractive();
    try {
      expect(calls[0].resumeSessionId).toBeUndefined();
    } finally {
      await session.stop();
    }
  });

  it('pins nothing for a docker case, whose pane execs into the container', async () => {
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession(
      {
        docker: { hostId: 'd1', label: 'ctr', containerName: 'ctr' },
        claudeSessionChain: [CONVERSATION],
      },
      mux
    );

    await session.startInteractive();
    try {
      expect(calls[0].resumeSessionId).toBeUndefined();
    } finally {
      await session.stop();
    }
  });

  it('pins nothing for a CLI that mints its own resume id', async () => {
    // codex/pi/omp/grok declare no `fallback` chain and read their resume id
    // from their own config, so a top-level pin would be meaningless at best.
    const { mux, calls } = recordingMux();
    const session = localSession({ mode: 'codex' }, mux);

    expect(await session.restartCli()).toBe(true);

    expect(calls[0].resumeSessionId).toBeUndefined();
  });

  it('documents that a remote reattach carries no pin', async () => {
    // `reattachRemote()` re-runs the remote session command, which attaches to
    // the durable remote tmux with the agent still running inside it.
    // ⚠️ Documentation, not a regression guard: `reattachRemote()` only runs for
    // a remote session, and the pin builder refuses remote sessions on its own,
    // so this would still pass if `reattachRemote()` were switched to the pinned
    // builder. The builder's remote guard is what the test above pins.
    giveTranscript(CONVERSATION);
    const { mux, calls } = recordingMux();
    const session = localSession(
      {
        remote: { hostId: 'h1', label: 'box', host: 'box', username: 'dev', remotePath: '/tmp' },
        claudeSessionChain: [CONVERSATION],
      },
      mux
    );

    expect(await session.reattachRemote()).toBe(true);

    expect(calls[0].resumeSessionId).toBeUndefined();
  });
});

describe('what the pin renders', () => {
  // The rendered command is what actually runs, and it is where each gate's
  // reason shows. Asserting here rather than counting call sites in the source
  // is what would have caught the divergent-pin and synthetic-id cases.
  const SID = '0f9c2b14-1111-2222-3333-444455556666';
  const entry = getCli('claude');
  const render = (resumeSessionId?: string) => {
    if (!entry) throw new Error('no registry entry for claude');
    return buildSpawnCommandFromRegistry(entry, {
      mode: 'claude',
      sessionId: SID,
      claudeCliVersion: null,
      resumeSessionId,
    });
  };

  it('renders the colliding bare form with no pin — the bug itself', () => {
    expect(render()).toContain(`--session-id "${SID}"`);
    expect(render()).not.toContain('--resume');
  });

  it('renders a self-healing resume-or-new when the pin is the session id', () => {
    expect(render(SID)).toBe(
      `claude --dangerously-skip-permissions --resume "${SID}" || claude --dangerously-skip-permissions --session-id "${SID}"`
    );
  });

  it('keeps the SESSION id in the fallback branch when the pin diverges', () => {
    // Which is why a pin with no transcript behind it has to be dropped: the
    // fallback is the colliding form, so a failed resume dies twice.
    expect(render(CONVERSATION)).toContain(`--resume "${CONVERSATION}"`);
    expect(render(CONVERSATION)).toContain(`--session-id "${SID}"`);
  });

  it('drops a synthetic discovered id, which fails the uuid token pattern', () => {
    // `reconcileSessions()` mints `restored-<fragment>` for a tmux session
    // Codeman found but does not own. The renderer emits the unpinned command,
    // so those panes keep the pre-existing behaviour.
    expect(render('restored-40568a29')).not.toContain('--resume');
  });
});

describe('where the transcript lookup reads', () => {
  it("honours the server process's own CLAUDE_CONFIG_DIR", async () => {
    // A pane inherits the server environment through tmux, so on an install
    // that exports this the CLI writes its transcripts there. Reading `~/.claude`
    // regardless answers "no transcript" for every conversation on the host,
    // and under the walk above that means the colliding bare command.
    giveTranscript(CONVERSATION);
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      expect(await claudeTranscriptExists(CONVERSATION)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it("prefers the session's own relocated dir over the process one", async () => {
    // A session pointed at a separate Claude account (#255) reads its own tree,
    // not the server's.
    giveTranscript(CONVERSATION);
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(configDir, 'nowhere');
    try {
      expect(await claudeTranscriptExists(CONVERSATION, configDir)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });
});
