/**
 * @fileoverview jcode (1jehuang/jcode) as a run mode: its wire config, its spawn command,
 * its capability flags, and the screen-reading patterns that tell a working jcode pane from
 * one at rest.
 *
 * The pane fixtures are verbatim captures (`tmux capture-pane -p`, rows shortened to their
 * tail) and verbatim tmux CLIENT stream chunks, both from a live jcode v0.98.1 pane driven
 * through real turns on 2026-10-16: a plain reply, a bash tool call, and a streamed answer.
 * The client stream matters because that is what Codeman's PTY reads, and tmux redraws only
 * the cells that changed, so the composer glyph has to survive that diffing.
 *
 * Port: none (pure functions plus a Session with a scripted fake pane).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { defaultDockerCommandForMode } from '../src/docker-hosts.js';
import { defaultRemoteCommandForMode } from '../src/remote-hosts.js';
import { Session, isExternalCliMode, isAltScreenStripMode } from '../src/session.js';
import { hooksAvailableForMode } from '../src/web/session-wait-registry.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import { promptStillInComposer } from '../src/session-submit-verifier.js';
import { isExternalCliTranscriptMode } from '../src/web/response-viewer-transcript.js';

const jcode = getCli('jcode');
const workDetect = jcode?.capabilities.workDetect;
const workingLine = compileVersionRegex(workDetect?.workingLine ?? '');

/** The composer and the status bar under it, as every capture ends (bar shortened). */
const FOOTER_REST = '\n5>\n                     …/scratchpad/jwork  master ?1 17k/252k ▰▱▱▱▱▱▱▱▱▱ 7% qwen5090 qwen3.8 27b\n';
const FOOTER_BUSY = '\n5…\n                     …/scratchpad/jwork  master ?1 17k/252k ▰▱▱▱▱▱▱▱▱▱ 7% qwen5090 qwen3.8 27b\n';
const PROMPT_ROW = ' 4› Use your bash tool to run exactly: sleep 8; echo slept. Then write a 40 word paragraph.\n\n';

/** One status row per phase a turn goes through, each verbatim from a capture. */
const WORKING_ROWS = [
  '⠋ sending… 0s',
  '⠦ thinking… 2s · https',
  '⠼ waiting for response… 3s · https',
  '⠧ running bash · Run user-requested sleep probe · https · 2s · Alt+B bg',
  '⠙ 11s · 182.7 tps · ↑17k ↓156 · https',
];

const atRest =
  `${PROMPT_ROW} The command ran and printed slept after 8 seconds.\n\n` +
  ` Donuts are ring-shaped treats, glazed with sugary sweetness.\n` +
  // The turn's summary row: a time, but no spinner, so it must never read as work.
  `   21s · 199.6 tps · ↑17k ↓2k\n${FOOTER_REST}`;

/**
 * The tmux client stream (what Codeman's PTY reads). Mid-turn it is the spinner cell being
 * repainted on its own; the turn's end repaints the composer row, and the only cell there
 * that changes is `…` turning into `>` (the prompt number is not resent).
 */
const SPINNER_CHUNK = '\x1b[38;1H\x1b[38;5;114m⠏\x1b[39;4H\x1b(B\x1b[m';
const TURN_END_CHUNK =
  '\x1b[40;2H\x1b[38;5;251mDONE\x1b[41;2H\x1b[39m  \x1b[38;5;239m10s · 189.1 tps · ↑16k ↓15\r\n' +
  '\x1b[39m                                    \x1b[43;2H\x1b[38;5;111m> \x1b(B\x1b[m';

describe('jcode wire config', () => {
  it('accepts a model and a resume id or short name on both create paths', () => {
    const created = CreateSessionSchema.parse({
      workingDir: '/tmp',
      mode: 'jcode',
      jcodeConfig: { model: 'claude-opus-4-8', resumeSessionId: 'session_fox_1792160401272_f5b47ce47d631006' },
    });
    expect(created.jcodeConfig?.resumeSessionId).toBe('session_fox_1792160401272_f5b47ce47d631006');
    const quick = QuickStartSchema.parse({ caseName: 'jc', mode: 'jcode', jcodeConfig: { resumeSessionId: 'fox' } });
    expect(quick.jcodeConfig?.resumeSessionId).toBe('fox');
  });

  it('refuses a resume value that would parse as a flag, and an unsafe model', () => {
    // --resume takes an OPTIONAL value, so `--resume --no-update` would read as two flags.
    for (const resumeSessionId of ['--no-update', '-x', 'fox; rm -rf ~', 'a b']) {
      expect(
        CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'jcode', jcodeConfig: { resumeSessionId } }).success,
        resumeSessionId
      ).toBe(false);
    }
    expect(
      CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'jcode', jcodeConfig: { model: 'a`b' } }).success
    ).toBe(false);
  });

  it('admits no JCODE_* env override', () => {
    // Most of that namespace is read by jcode's shared daemon, hooks and command paths
    // included, so a per-session value would either do nothing or reach every session.
    expect(
      CreateSessionSchema.safeParse({ workingDir: '/tmp', mode: 'jcode', envOverrides: { JCODE_HOME: '/tmp/x' } })
        .success
    ).toBe(false);
    expect(jcode?.env.allowedPrefixes).toEqual([]);
  });
});

describe('jcode spawn command', () => {
  const spawn = (jcodeConfig?: Parameters<typeof buildSpawnCommand>[0]['jcodeConfig']) =>
    buildSpawnCommand({ mode: 'jcode', sessionId: 'abc12345', jcodeConfig });

  it('spawns bare, then with --model and --resume when asked', () => {
    expect(spawn()).toBe('jcode');
    expect(spawn({ model: 'gpt-5.5' })).toBe('jcode --model gpt-5.5');
    expect(spawn({ resumeSessionId: 'session_fox_1792160401272_f5b47ce47d631006' })).toBe(
      'jcode --resume session_fox_1792160401272_f5b47ce47d631006'
    );
    expect(spawn({ model: 'gpt-5.5', resumeSessionId: 'fox' })).toBe('jcode --model gpt-5.5 --resume fox');
  });

  it('drops a value the schema would have refused rather than emit it', () => {
    // Defence in depth behind the schema: the argv engine re-checks every token.
    expect(spawn({ resumeSessionId: '--no-update' })).toBe('jcode');
    expect(spawn({ model: 'a`b' })).toBe('jcode');
  });

  it('has remote and docker pane commands', () => {
    expect(defaultDockerCommandForMode('jcode')).toBe('exec jcode');
    expect(defaultRemoteCommandForMode('jcode')).toBe('exec "${SHELL:-/bin/sh}" -i -l -c \'jcode\'');
  });
});

describe('jcode capabilities', () => {
  it('is an external CLI with no hooks, its own strip, and no agent skill', () => {
    expect(isExternalCliMode('jcode')).toBe(true);
    expect(isAltScreenStripMode('jcode')).toBe(false);
    expect(hooksAvailableForMode('jcode')).toBe(false);
    expect(jcode?.capabilities.altScreen).toBe('strip-mux-and-mouse');
    expect(jcode?.capabilities.transcriptPageKeys).toBe(true);
    // Its tools run in the shared daemon, under whichever session started it, so an
    // injected skill would act as that session.
    expect(jcode?.capabilities.agentSkillInjection).toBe(false);
    expect(jcode?.capabilities.privilegedParams).toEqual([]);
  });

  it('anchors its version probe on the `jcode v` banner', () => {
    const version = jcode?.discovery.version;
    expect(version?.requireVersionMatch).toBe(true);
    const re = compileVersionRegex(version?.regex ?? '');
    expect(re?.exec('jcode v0.98.1 (1c7426eb1)')?.[1]).toBe('0.98.1');
    // The unrelated npm package of the same name, or any other `jcode`, is absent.
    expect(re?.exec('1.0.0')).toBeNull();
  });

  it('is never segmented off its pane by the response viewer', () => {
    expect(isExternalCliTranscriptMode('jcode')).toBe(false);
  });
});

describe("jcode's work-detection descriptor", () => {
  it('compiles through the regex guard', () => {
    expect(workingLine).not.toBeNull();
  });

  it('matches every status row a turn shows, in a full capture', () => {
    for (const row of WORKING_ROWS) {
      expect(workingLine!.test(`${PROMPT_ROW}${row}${FOOTER_BUSY}`), row).toBe(true);
    }
  });

  it('reads past a minute and an hour, a dropped network, and a centred layout', () => {
    expect(workingLine!.test(`${PROMPT_ROW}⠸ thinking… 1m 3s · https${FOOTER_BUSY}`)).toBe(true);
    expect(workingLine!.test(`${PROMPT_ROW}⠸ running bash · build · 1h 2m · Alt+B bg${FOOTER_BUSY}`)).toBe(true);
    expect(
      workingLine!.test(`${PROMPT_ROW}↻ network disconnected, waiting to retry · sse · 5s${FOOTER_BUSY}`)
    ).toBe(true);
    expect(workingLine!.test(`${PROMPT_ROW}                    ⠸ thinking… 4s${FOOTER_BUSY}`)).toBe(true);
  });

  it('does not match a pane at rest, its summary row, or a braille glyph in the transcript', () => {
    expect(workingLine!.test(atRest)).toBe(false);
    expect(workingLine!.test(`${PROMPT_ROW} the spinner looked like ⠋ for 3s\n${FOOTER_REST}`)).toBe(false);
  });

  it('arms the idle check from the turn-ending repaint, and nothing mid-turn carries the glyph', () => {
    expect(TURN_END_CHUNK).toContain(workDetect!.promptGlyph);
    expect(SPINNER_CHUNK).not.toContain(workDetect!.promptGlyph);
  });

  it('leaves the submit verifier inert: no screen row starts with the glyph', () => {
    // The composer row is `<n>> …`, so the verifier finds no composer line and never presses
    // Enter on its own (jcode has no early-Enter defect for it to work around).
    const typed = `${PROMPT_ROW}${FOOTER_REST.replace('5>', '5> say ok')}`;
    expect(promptStillInComposer(typed, 'say ok', workDetect!.promptGlyph)).toBeUndefined();
    expect(promptStillInComposer(atRest, 'say ok', workDetect!.promptGlyph)).toBeUndefined();
  });
});

describe('jcode interactive idle detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type SessionInternals = {
    _handleTerminalOutput(data: string): void;
    _detectInteractiveActivity(data: string): void;
  };

  function feed(session: Session, data: string): void {
    const internals = session as unknown as SessionInternals;
    internals._handleTerminalOutput(data);
    internals._detectInteractiveActivity(data);
  }

  function withFakePane(read: () => string): Session {
    const mux = {
      isAvailable: () => true,
      capturePaneText: () => read(),
    } as unknown as NonNullable<ConstructorParameters<typeof Session>[0]>['mux'];
    return new Session({
      workingDir: '/tmp',
      mode: 'jcode',
      mux,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    } as ConstructorParameters<typeof Session>[0]);
  }

  /** The spinner cell repainted every 80 ms, as jcode's ~12 fps indicator does. */
  function spin(session: Session, ms: number): void {
    for (let t = 0; t < ms; t += 80) {
      feed(session, SPINNER_CHUNK);
      vi.advanceTimersByTime(80);
    }
  }

  it('marks a turn working off its spinner and ends it on the composer repaint', () => {
    vi.useFakeTimers();
    let screen = `${PROMPT_ROW}${WORKING_ROWS[3]}${FOOTER_BUSY}`;
    const session = withFakePane(() => screen);
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    spin(session, 8000);
    expect(events).toEqual(['working']);
    expect(session.status).toBe('busy');

    screen = atRest;
    feed(session, TURN_END_CHUNK);
    vi.advanceTimersByTime(20_000);
    expect(events).toEqual(['working', 'idle']);
    expect(session.status).toBe('idle');
  });

  it('does not end a turn while the status row is still on screen', () => {
    vi.useFakeTimers();
    // A quiet pane whose screen still shows the spinner row (a stalled stream): the
    // screen says working, so silence alone must not conclude idle.
    const screen = `${PROMPT_ROW}${WORKING_ROWS[2]}${FOOTER_BUSY}`;
    const session = withFakePane(() => screen);
    const events: string[] = [];
    session.on('working', () => events.push('working'));
    session.on('idle', () => events.push('idle'));

    spin(session, 4000);
    feed(session, TURN_END_CHUNK);
    vi.advanceTimersByTime(20_000);
    expect(events).toEqual(['working']);
    expect(session.status).toBe('busy');
  });
});
