/**
 * A session whose turn ended waiting for workers it started counts as working.
 *
 * The bug this pins: when Claude hands work to background agents or an ultracode
 * workflow, it ends its turn and closes it with `✻ Waiting for 1 dynamic workflow to
 * finish` instead of `✻ Brewed for 1m 18s`. The pane goes quiet with the composer up, so
 * every other signal called the session idle while it was plainly busy, and it resumes
 * on its own the moment the workers report back.
 *
 * The chrome rows below (the closing row, the right-aligned hint, the composer rules, the
 * footer, the workflow progress row) are verbatim from a live Claude Code 2.1.283 pane on
 * 2026-09-28 (`tmux -L codeman capture-pane -p`, 64 columns). The prose and the names are
 * invented.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import { isAwaitingWorkers, AWAITING_SEARCH_ROWS, IDLE_SILENCE_MS } from '../src/session-activity.js';

/** The registry's own pattern, which is what every consumer runs. */
const CLAUDE_AWAITING = compileVersionRegex(getCli('claude')!.capabilities.workDetect!.awaitingLine!)!;

const RULE = '────────────────────────────────────────────────────────────────';
const NAMED_RULE = '──────────────────────────────────────────────────── w1-demo ─';

/** Everything Claude draws from the composer down while a workflow runs. */
const COMPOSER_AND_FOOTER = [
  NAMED_RULE,
  '❯ sounds good, go ahead',
  RULE,
  '  Opus 5.5 (1M context)  in:285,618 out:581  ctx:29%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents',
  '',
  '  ◯ docs-research  ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  ↓ 1.1m',
];

/** A pane whose newest turn closed with `closing`, then the optional hint row. */
function frame(closing: string, { hint = true, body = [] as string[] } = {}): string {
  return [
    '⏺ The research is running now: three tracks, each checked by',
    '  a second agent.',
    '',
    '  When it is done I will rewrite the plan.',
    '',
    ...body,
    closing,
    ...(hint ? ['                                                 286199 tokens'] : []),
    ...COMPOSER_AND_FOOTER,
    '',
  ].join('\n');
}

const WAITING_WORKFLOW = frame('✻ Waiting for 1 dynamic workflow to finish');
const WAITING_BOTH = frame('✻ Waiting for 2 background agents and 1 dynamic workflow to finish');
const WAITING_AGENT = frame('✻ Waiting for 1 background agent to finish', { hint: false });
const DONE = frame('✻ Brewed for 1m 18s · done 3:04 PM');

/**
 * The same screen after the workers reported back and the follow-up turn ended. The
 * waiting row is a snapshot Claude never redraws, so it is STILL on screen, just no longer
 * the newest row.
 */
const FOLLOW_UP_DONE = frame('✻ Cooked for 12s', {
  body: [
    '✻ Waiting for 1 dynamic workflow to finish',
    '',
    '⏺ All three tracks are back. The plan is rewritten and pushed.',
    '',
  ],
});

describe('isAwaitingWorkers', () => {
  it('reads the closing row of a turn that handed off to a workflow', () => {
    expect(isAwaitingWorkers(WAITING_WORKFLOW, CLAUDE_AWAITING, '❯')).toBe(true);
  });

  it('reads every form Claude builds the row in', () => {
    expect(isAwaitingWorkers(WAITING_BOTH, CLAUDE_AWAITING, '❯')).toBe(true);
    expect(isAwaitingWorkers(WAITING_AGENT, CLAUDE_AWAITING, '❯')).toBe(true);
    expect(isAwaitingWorkers(frame('✻ Waiting for 3 background agents to finish'), CLAUDE_AWAITING, '❯')).toBe(true);
    expect(isAwaitingWorkers(frame('✻ Waiting for 2 dynamic workflows to finish'), CLAUDE_AWAITING, '❯')).toBe(true);
  });

  it('leaves an ordinary turn end alone', () => {
    expect(isAwaitingWorkers(DONE, CLAUDE_AWAITING, '❯')).toBe(false);
  });

  it('ignores a stale waiting row once a newer turn has closed below it', () => {
    // The trap the whole positional walk exists for: matching the words anywhere on the
    // screen would pin the session busy until they scrolled away.
    expect(FOLLOW_UP_DONE).toContain('Waiting for 1 dynamic workflow to finish');
    expect(isAwaitingWorkers(FOLLOW_UP_DONE, CLAUDE_AWAITING, '❯')).toBe(false);
  });

  it('refuses the words when the agent wrote them', () => {
    // Claude's own rows start in column 0; the agent's prose sits behind `⏺ ` or is
    // indented, so an agent cannot keep itself busy by printing the sentence.
    expect(isAwaitingWorkers(frame('⏺ ✻ Waiting for 1 background agent to finish'), CLAUDE_AWAITING, '❯')).toBe(false);
    expect(isAwaitingWorkers(frame('  ✻ Waiting for 1 background agent to finish'), CLAUDE_AWAITING, '❯')).toBe(false);
  });

  it('says nothing about a screen with no composer on it', () => {
    const noComposer = WAITING_WORKFLOW.replace('❯ sounds good, go ahead', '  1. Yes  2. No');
    expect(isAwaitingWorkers(noComposer, CLAUDE_AWAITING, '❯')).toBe(false);
    expect(isAwaitingWorkers('', CLAUDE_AWAITING, '❯')).toBe(false);
    expect(isAwaitingWorkers(null, CLAUDE_AWAITING, '❯')).toBe(false);
  });

  it('finds the composer in the boxed layout too', () => {
    const boxed = [
      '✻ Waiting for 1 dynamic workflow to finish',
      '╭──────────────────────────────────────╮',
      '│ ❯                                    │',
      '╰──────────────────────────────────────╯',
      '  ⏵⏵ bypass permissions on · ← 1 agent',
    ].join('\n');
    expect(isAwaitingWorkers(boxed, CLAUDE_AWAITING, '❯')).toBe(true);
  });

  it('reads a coloured capture', () => {
    const coloured = WAITING_WORKFLOW.replace(
      '✻ Waiting for 1 dynamic workflow to finish',
      '\u001b[2m✻\u001b[0m \u001b[2mWaiting for \u001b[1m1\u001b[22m dynamic workflow to finish\u001b[0m'
    );
    expect(isAwaitingWorkers(coloured, CLAUDE_AWAITING, '❯')).toBe(true);
  });

  it('stops looking a few rows above the composer', () => {
    const farAway = [
      '✻ Waiting for 1 dynamic workflow to finish',
      ...Array.from({ length: AWAITING_SEARCH_ROWS }, () => ''),
      ...COMPOSER_AND_FOOTER,
    ].join('\n');
    expect(isAwaitingWorkers(farAway, CLAUDE_AWAITING, '❯')).toBe(false);
  });

  it('survives a pattern handed to it with the global flag set', () => {
    const global = new RegExp(CLAUDE_AWAITING.source, 'g');
    expect(isAwaitingWorkers(WAITING_WORKFLOW, global, '❯')).toBe(true);
    expect(isAwaitingWorkers(WAITING_WORKFLOW, global, '❯')).toBe(true);
  });
});

/** A composer repaint: the frame Claude ships roughly once a second while working. */
const COMPOSER_REPAINT =
  '\x1b[31;1H\x1b[38;5;246m❯\xa0\x1b[39m\x1b[0m\x1b[33;1H  \x1b[38;5;246mOpus 5  in:143,699 out:669  ctx:14%\x1b[39m';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _detectInteractiveActivity(data: string): void;
};

function feed(session: Session, data: string): void {
  const internals = session as unknown as SessionInternals;
  internals._handleTerminalOutput(data);
  internals._detectInteractiveActivity(data);
}

/** A session whose mux reports a scripted screen for the pane probe to read. */
function withFakePane(read: () => string, mode: 'claude' | 'codex' = 'claude'): Session {
  const mux = {
    isAvailable: () => true,
    capturePaneText: () => read(),
  } as unknown as NonNullable<ConstructorParameters<typeof Session>[0]>['mux'];
  return new Session({
    workingDir: '/tmp',
    mode,
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
  } as ConstructorParameters<typeof Session>[0]);
}

/** Run one turn and let it end, which is when the probe reads the screen. */
function runAndSettle(session: Session, repaint: string = COMPOSER_REPAINT): void {
  for (let i = 0; i < 3; i++) {
    feed(session, repaint);
    vi.advanceTimersByTime(1000);
  }
  vi.advanceTimersByTime(IDLE_SILENCE_MS + 2000);
}

describe('Session status while its workers run', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays working when the turn ends waiting for a workflow', () => {
    vi.useFakeTimers();
    const session = withFakePane(() => WAITING_WORKFLOW);

    runAndSettle(session);

    expect(session.status).toBe('busy');
    expect(session.isWorking).toBe(true);
  });

  it('goes idle once the follow-up turn closes, although the old row is still on screen', () => {
    vi.useFakeTimers();
    const screen = { text: WAITING_WORKFLOW };
    const session = withFakePane(() => screen.text);
    runAndSettle(session);
    expect(session.status).toBe('busy');

    screen.text = FOLLOW_UP_DONE;
    // The probe keeps re-reading the screen on its own slow cadence while it says busy,
    // with no PTY output needed to trigger it.
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 10_000);

    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
  });

  it('reports an ordinary turn end as idle, as before', () => {
    vi.useFakeTimers();
    const session = withFakePane(() => DONE);

    runAndSettle(session);

    expect(session.status).toBe('idle');
  });

  it('does not apply to a CLI whose registry entry declares no awaitingLine', () => {
    vi.useFakeTimers();
    expect(getCli('codex')?.capabilities.workDetect?.awaitingLine).toBeUndefined();
    const codexScreen = ['✻ Waiting for 1 dynamic workflow to finish', '', '› Ask Codex to do anything', ''].join('\n');
    const session = withFakePane(() => codexScreen, 'codex');

    runAndSettle(session, '\x1b[31;1H\x1b[38;5;246m›\xa0\x1b[39m\x1b[0m');

    expect(session.status).toBe('idle');
  });
});
