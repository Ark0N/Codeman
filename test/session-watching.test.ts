/**
 * The badge a session wears while work it started in the background is still running.
 *
 * The bug this pins: an agent that arms a monitor, backgrounds a shell or hands work to a
 * cloud session is told to end its turn, so the pane falls quiet, Claude Code's idle
 * notification arrives a minute later, and every Codeman surface files the session under
 * NEEDS YOU. Nothing wants the user there. The CLI itself says so on the last row of its
 * screen (`⏵⏵ bypass permissions on · 1 monitor · ← for agents`), and reading that row is
 * what tells a session waiting for its own background work from one waiting for a human.
 *
 * The pane fixtures below are verbatim captures (`tmux -L codeman capture-pane -p`) from a
 * live Claude Code 2.1.278 session on 2026-09-21.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import {
  watchingLabel,
  WATCHING_TAIL_LINES,
  MAX_WATCHING_LABEL_CHARS,
  IDLE_SILENCE_MS,
} from '../src/session-activity.js';

/** The registry's own patterns, which are what every consumer runs. */
const CLAUDE_WATCHING = compileVersionRegex(getCli('claude')!.capabilities.workDetect!.watchingLine!)!;
const CODEX_WATCHING = compileVersionRegex(getCli('codex')!.capabilities.workDetect!.watchingLine!)!;
const CODEX_TAIL = getCli('codex')!.capabilities.workDetect!.watchingLines!;

/**
 * The foot of a Codex pane, verbatim (codex-cli 0.154.0, 2026-09-22). Codex does not
 * write on its last row: the status line is there, the composer above it, and the
 * background-terminal row above that, which is why codex declares its own window.
 */
const CODEX_STATUS =
  '  gpt-5.6-sol medium · Context 98% left · ~/codeman-cases/codex-probe · 5h 99% left · weekly 94% left';
const CODEX_WITH_TERMINAL = [
  '• OK',
  '',
  '  1 background terminal running · /ps to view · /stop to close',
  '',
  '',
  '› Ask Codex to do anything',
  '',
  CODEX_STATUS,
  '',
].join('\n');
const CODEX_STOPPED = [
  '• OK',
  '',
  '• Stopping all background terminals.',
  '',
  '',
  '› Ask Codex to do anything',
  '',
  CODEX_STATUS,
  '',
].join('\n');

/** The bottom of a Claude pane: composer, the user's status line, the footer row. */
function pane(footer: string, body = ''): string {
  return (
    body +
    '╭──────────────────────────────────────╮\n' +
    '│ ❯                                    │\n' +
    '╰──────────────────────────────────────╯\n' +
    '  ~/innovi/gtd-board [main] Opus 5 ctx: 11%\n' +
    `  ${footer}\n`
  );
}

const WITH_MONITOR = pane('⏵⏵ bypass permissions on · 1 monitor · ← for agents');
const WITH_SHELL = pane('⏵⏵ bypass permissions on · 1 shell · ← for agents');
const NOTHING_RUNNING = pane('⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents');

/** A composer repaint: the frame Claude ships roughly once a second while working. */
const COMPOSER_REPAINT =
  '\x1b[31;1H\x1b[38;5;246m❯\xa0\x1b[39m\x1b[0m\x1b[33;1H  \x1b[38;5;246mOpus 5  in:143,699 out:669  ctx:14%\x1b[39m';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _detectInteractiveActivity(data: string): void;
};

/** One PTY chunk, exactly as the interactive handler sees it. */
function feed(session: Session, data: string): void {
  const internals = session as unknown as SessionInternals;
  internals._handleTerminalOutput(data);
  internals._detectInteractiveActivity(data);
}

/** A session whose mux reports a fixed (or scripted) screen for the pane probe to read. */
function withFakePane(screen: string | (() => string), mode: 'claude' | 'codex' = 'claude'): Session {
  const read = typeof screen === 'function' ? screen : () => screen;
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

/** Codex's own composer repaint, the frame that arms its idle confirmation. */
const CODEX_COMPOSER_REPAINT = '\x1b[31;1H\x1b[38;5;246m›\xa0\x1b[39m\x1b[0m';

/** Run one turn and let it end, which is when the probe reads the screen. */
function runAndSettle(session: Session, repaint: string = COMPOSER_REPAINT): void {
  for (let i = 0; i < 3; i++) {
    feed(session, repaint);
    vi.advanceTimersByTime(1000);
  }
  vi.advanceTimersByTime(IDLE_SILENCE_MS + 2000);
}

describe('watchingLabel', () => {
  it('reads the label off the footer row', () => {
    expect(watchingLabel(WITH_MONITOR, CLAUDE_WATCHING)).toBe('1 monitor');
    expect(watchingLabel(WITH_SHELL, CLAUDE_WATCHING)).toBe('1 shell');
  });

  it('reads every kind of background work the CLI names', () => {
    const labels = [
      '2 monitors',
      '3 shells',
      '1 cloud session',
      '2 cloud sessions',
      '1 local agent',
      '4 background tasks',
      '1 MCP task',
      '1 background dynamic workflow',
      '2 remote dynamic workflows',
      '2 teams',
    ];
    for (const label of labels) {
      expect(watchingLabel(pane(`⏵⏵ bypass permissions on · ${label} · ← for agents`), CLAUDE_WATCHING)).toBe(label);
    }
  });

  it('reports no watching while the agent waits for comments on an artifact', () => {
    // An agent that publishes an artifact arms a monitor for its comments and ends its
    // turn. That monitor waits on the user, so the idle alert has to reach them. The
    // singular footer is a live capture from 2026-09-25; the plural is assumed.
    expect(
      watchingLabel(pane('⏵⏵ bypass permissions on · 1 Artifact comment monitor · ← for agents'), CLAUDE_WATCHING)
    ).toBeNull();
    expect(
      watchingLabel(pane('⏵⏵ bypass permissions on · 2 Artifact comment monitors · ← for agents'), CLAUDE_WATCHING)
    ).toBeNull();
  });

  it('lets a comment monitor outrank other background work on the same row', () => {
    // A shell beside the monitor is still running, but the agent needs the user all the
    // same, and the chip order on the footer must not decide that. The second row is
    // the one that needs the `^` in front of the lookahead.
    expect(
      watchingLabel(
        pane('⏵⏵ bypass permissions on · 1 shell · 1 Artifact comment monitor · ← for agents'),
        CLAUDE_WATCHING
      )
    ).toBeNull();
    expect(
      watchingLabel(
        pane('⏵⏵ bypass permissions on · 1 Artifact comment monitor · 1 shell · ← for agents'),
        CLAUDE_WATCHING
      )
    ).toBeNull();
  });

  it('still refuses a footer cut off in the middle of the comment monitor', () => {
    expect(
      watchingLabel(pane('⏵⏵ bypass permissions on · 1 shell · 1 Artifact comment moni…'), CLAUDE_WATCHING)
    ).toBeNull();
  });

  it('says nothing about a pane that is running nothing', () => {
    expect(watchingLabel(NOTHING_RUNNING, CLAUDE_WATCHING)).toBeNull();
    expect(watchingLabel('', CLAUDE_WATCHING)).toBeNull();
    expect(watchingLabel(null, CLAUDE_WATCHING)).toBeNull();
  });

  it('ignores the same words in the transcript above the composer', () => {
    // The whole reason the search is confined to the foot of the screen: a session that
    // PRINTS "1 monitor" (this one has been discussing exactly that) is not running one.
    const transcript =
      '> does Codeman know about watching?\n' +
      '⏺ The footer says · 1 monitor · while a monitor is armed, and · 2 shells · for\n' +
      '  backgrounded commands. Codeman reads neither today.\n' +
      '  Nothing else on the screen means background work is running.\n';
    expect(watchingLabel(pane('⏵⏵ bypass permissions on · ← for agents', transcript), CLAUDE_WATCHING)).toBeNull();
  });

  it('looks no further up the screen than the tail it declares', () => {
    const chip = '⏵⏵ bypass permissions on · 1 monitor · ← for agents';
    const below = Array(WATCHING_TAIL_LINES).fill('  still here').join('\n');
    // Blank lines are dropped before the tail is taken, so a pane padded with them must
    // still read its own footer.
    expect(watchingLabel(`${chip}\n\n\n\n\n\n`, CLAUDE_WATCHING)).toBe('1 monitor');
    expect(watchingLabel(`${chip}\n${below}\n`, CLAUDE_WATCHING)).toBeNull();
  });

  it('refuses a chip on the row above the footer, which the agent can write', () => {
    // The status line is one row up, its text comes from a `statusLine` command, and a
    // session running with permissions bypassed can write that command into
    // `.claude/settings.json` in its own workspace. The window is what keeps that row
    // out, so this is the test that would fail if somebody widened it.
    const forged = pane('⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents').replace(
      '  ~/innovi/gtd-board [main] Opus 5 ctx: 11%',
      '  ~/innovi/gtd-board [main] Opus 5 ctx: 11% · 1 monitor'
    );
    expect(watchingLabel(forged, CLAUDE_WATCHING)).toBeNull();
    // And with the window widened by one, the same screen does match — which is the
    // whole reason the default is one row.
    expect(watchingLabel(forged, CLAUDE_WATCHING, 2)).toBe('1 monitor');
  });

  it('keeps Claude on the default window, because its chip is the last row', () => {
    expect(getCli('claude')?.capabilities.workDetect?.watchingLines).toBeUndefined();
    expect(WATCHING_TAIL_LINES).toBe(1);
  });

  it('refuses a label the footer did not separate, which is the injection guard', () => {
    // The pattern anchors on the `·` the footer joins its items with. Without that
    // anchor an agent could silence its own idle alert by printing the words, since the
    // only rows it cannot write are the footer and the status line.
    expect(watchingLabel(pane('1 monitor'), CLAUDE_WATCHING)).toBeNull();
    expect(watchingLabel(pane('running 2 shells for the build'), CLAUDE_WATCHING)).toBeNull();
    expect(watchingLabel(pane('⏵⏵ bypass permissions on · 1 monitor'), CLAUDE_WATCHING)).toBe('1 monitor');
  });

  it('reads a coloured footer, because a capture may carry ANSI', () => {
    const coloured = pane('\u001b[2m⏵⏵ bypass permissions on\u001b[0m · \u001b[36m1 monitor\u001b[0m · ← for agents');
    expect(watchingLabel(coloured, CLAUDE_WATCHING)).toBe('1 monitor');
  });

  it('caps the label, because it ends up on a badge and in an approval card', () => {
    const long = `· ${'9'.repeat(MAX_WATCHING_LABEL_CHARS * 2)} monitors`;
    const label = watchingLabel(pane(`⏵⏵ bypass permissions on ${long} · ← for agents`), CLAUDE_WATCHING);
    expect(label?.length).toBe(MAX_WATCHING_LABEL_CHARS);
  });

  it('survives a pattern handed to it with the global flag set', () => {
    // compileVersionRegex() never sets `g`, but a test or a reloaded config might, and a
    // sticky lastIndex would make the same screen match every other call.
    const global = new RegExp(CLAUDE_WATCHING.source, 'g');
    expect(watchingLabel(WITH_MONITOR, global)).toBe('1 monitor');
    expect(watchingLabel(WITH_MONITOR, global)).toBe('1 monitor');
  });
});

describe('Session.watching', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries what the pane reported once the turn ends', () => {
    vi.useFakeTimers();
    const session = withFakePane(WITH_MONITOR);
    expect(session.watching).toBeNull();

    runAndSettle(session);

    expect(session.status).toBe('idle');
    expect(session.watching).toBe('1 monitor');
  });

  it('lets the badge go when the background work is over', () => {
    vi.useFakeTimers();
    const screen = { text: WITH_MONITOR };
    const session = withFakePane(() => screen.text);

    runAndSettle(session);
    expect(session.watching).toBe('1 monitor');

    screen.text = NOTHING_RUNNING;
    runAndSettle(session);
    expect(session.watching).toBeNull();
  });

  it('announces the change, because the session status does not move with it', () => {
    // Measured on codex: a background terminal finishing repaints the row away and the
    // session is idle before and after, so no other event fires. Without this one the
    // server drops the label and every open page goes on drawing the badge.
    vi.useFakeTimers();
    const screen = { text: WITH_MONITOR };
    const session = withFakePane(() => screen.text);
    const changes: (string | null)[] = [];
    session.on('watchingChanged', () => changes.push(session.watching));

    runAndSettle(session);
    expect(changes).toEqual(['1 monitor']);

    // A repaint that carries the composer glyph but no chip: the pane went quiet again
    // without a turn, which is exactly the case the event exists for.
    screen.text = NOTHING_RUNNING;
    feed(session, COMPOSER_REPAINT);
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 2000);
    expect(changes).toEqual(['1 monitor', null]);
    expect(session.status).toBe('idle');
  });

  it('says nothing while the answer stays the same', () => {
    vi.useFakeTimers();
    const session = withFakePane(WITH_MONITOR);
    const changes: (string | null)[] = [];
    session.on('watchingChanged', () => changes.push(session.watching));

    runAndSettle(session);
    runAndSettle(session);
    runAndSettle(session);
    expect(changes).toEqual(['1 monitor']);
  });

  it('drops its answer when the screen cannot be read, and says so', () => {
    vi.useFakeTimers();
    const screen: { text: string | null } = { text: WITH_MONITOR };
    const session = withFakePane(() => screen.text as string);
    const changes: (string | null)[] = [];
    session.on('watchingChanged', () => changes.push(session.watching));

    runAndSettle(session);
    expect(session.watching).toBe('1 monitor');

    // A stale label would open the next idle prompt already acknowledged, so a failed
    // capture must degrade toward the alert, not toward silence. The page is told too,
    // or every open tab would go on drawing the badge.
    screen.text = null;
    runAndSettle(session);
    expect(session.watching).toBeNull();
    expect(changes).toEqual(['1 monitor', null]);
  });

  it('reads Codex own row, three up from the bottom of its screen', () => {
    vi.useFakeTimers();
    const session = withFakePane(CODEX_WITH_TERMINAL, 'codex');
    runAndSettle(session, CODEX_COMPOSER_REPAINT);
    expect(session.status).toBe('idle');
    expect(session.watching).toBe('1 background terminal');
  });

  it('reports nothing for a CLI whose screen nobody has characterised', () => {
    vi.useFakeTimers();
    expect(getCli('gemini')?.capabilities.workDetect).toBeUndefined();
    const session = withFakePane(WITH_MONITOR, 'gemini');
    runAndSettle(session);
    expect(session.watching).toBeNull();
  });

  it('never reads another CLI screen', () => {
    vi.useFakeTimers();
    // Each pattern is anchored on chrome its own CLI draws, so neither can fire on the
    // other's pane. A shared fallback would have both reading a screen nobody measured.
    const codexOnClaudeScreen = withFakePane(WITH_MONITOR, 'codex');
    runAndSettle(codexOnClaudeScreen, CODEX_COMPOSER_REPAINT);
    expect(codexOnClaudeScreen.watching).toBeNull();

    const claudeOnCodexScreen = withFakePane(CODEX_WITH_TERMINAL, 'claude');
    runAndSettle(claudeOnCodexScreen);
    expect(claudeOnCodexScreen.watching).toBeNull();
  });

  it('rides along on the payload every session surface reads', () => {
    vi.useFakeTimers();
    const session = withFakePane(WITH_SHELL);
    runAndSettle(session);

    expect(session.toLightDetailedState().watching).toBe('1 shell');
  });
});

describe('the row Codex draws', () => {
  it('reads the label, and only while a terminal is running', () => {
    expect(watchingLabel(CODEX_WITH_TERMINAL, CODEX_WATCHING, CODEX_TAIL)).toBe('1 background terminal');
    expect(watchingLabel(CODEX_STOPPED, CODEX_WATCHING, CODEX_TAIL)).toBeNull();
  });

  it('counts terminals', () => {
    const three = CODEX_WITH_TERMINAL.replace('1 background terminal running', '3 background terminals running');
    expect(watchingLabel(three, CODEX_WATCHING, CODEX_TAIL)).toBe('3 background terminals');
  });

  it('needs the window Codex declares: its row is not the last one', () => {
    // Pins WHY `watchingLines` exists. Claude's default of two rows reaches the status
    // line and the composer, and Codex's row sits one further up.
    expect(watchingLabel(CODEX_WITH_TERMINAL, CODEX_WATCHING, 2)).toBeNull();
    expect(CODEX_TAIL).toBeGreaterThanOrEqual(3);
  });

  it('refuses a mention that is not the whole row', () => {
    // The pattern matches Codex's row end to end, so prose about background terminals —
    // including prose quoting part of the row — is not enough.
    for (const line of [
      '• I left 1 background terminal running for you.',
      '  1 background terminal running · /ps to view',
      '  see: 1 background terminal running · /ps to view · /stop to close',
    ]) {
      const claim = CODEX_STOPPED.replace('• Stopping all background terminals.', line);
      expect(watchingLabel(claim, CODEX_WATCHING, CODEX_TAIL)).toBeNull();
    }
  });

  it('CAN be forged by Codex own output, and is contained by Codex having no hooks', () => {
    // Codex's row is third from the bottom only while a terminal runs; with none running
    // that slot is the last row of the transcript, which the agent writes. Matching the
    // complete row raises the bar but closes nothing, so this test states the limitation
    // rather than a protection the code does not have.
    const forged = CODEX_STOPPED.replace(
      '• Stopping all background terminals.',
      '  1 background terminal running · /ps to view · /stop to close'
    );
    expect(watchingLabel(forged, CODEX_WATCHING, CODEX_TAIL)).toBe('1 background terminal');

    // What makes that cost a wrong badge and nothing more: no hook event from a codex
    // session reaches the approvals inbox, so there is no idle item to pre-acknowledge
    // and no alert to silence. A CLI that gains hook signals needs a harder anchor first.
    expect(getCli('codex')?.capabilities.hooks).toBe('none');
  });
});

describe('the registry pattern Claude declares', () => {
  it('is one the config-regex guard accepts', () => {
    // Same guard as `workingLine`: ~/.codeman/clis.json can set this field, and the
    // compiled pattern runs over a pane capture on a timer.
    expect(compileVersionRegex(getCli('claude')!.capabilities.workDetect!.watchingLine!)).not.toBeNull();
  });

  it('does not fire on the status line a user configured', () => {
    // Plan-usage and context figures live one row above the footer and carry numbers.
    const statusLine = '  ~/innovi/gtd-board [main] Opus 5 (1M context) high ctx: 10% 5h: 48% (32m) 7d: 15% (6d10h)';
    expect(CLAUDE_WATCHING.test(statusLine)).toBe(false);
  });
});
