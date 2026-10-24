/**
 * @fileoverview Unit tests for the decisions `codeman tui` makes, without a
 * terminal.
 *
 * Everything the app does that can be stated as a function of its inputs is
 * exported from `tui-app.ts` for exactly this reason: the attach handoff (which
 * changes shape inside tmux), the typed kill confirmation, the footer's honest
 * key inventory, the repaint test and the row building for degraded mode. The
 * full-screen loop itself is covered end-to-end under node-pty in
 * `tui-e2e.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  applyLiveMetrics,
  applyMuxNames,
  beginAttachHandoff,
  buildAttachBanner,
  buildListLines,
  confirmKillStep,
  detachChord,
  heldCtrlAlias,
  ONE_KEY_DETACH,
  buildAttachTabs,
  nextSessionName,
  footerKeysFor,
  formatPrefixKey,
  helpKeysFor,
  isSelfSession,
  planAttach,
  planResume,
  previewIntervalMs,
  previewNoteFor,
  resyncDelayMs,
  sameFrame,
  samePreview,
  shouldAnimate,
  shouldFetchPreview,
  tmuxRowsToSessions,
  tmuxSocketFromEnv,
} from '../../src/tui/tui-app.js';
import { createTuiModel, stateSince } from '../../src/tui/tui-model.js';
import type { TuiClient } from '../../src/tui/tui-client.js';
import { glyphsFor } from '../../src/tui/tui-render.js';
import type { TuiLiveSessionMetrics, TuiTmuxSession } from '../../src/tui/tui-client.js';
import type { TuiConfirmState, TuiRow, TuiSessionRow } from '../../src/tui/tui-types.js';

const GLYPHS = glyphsFor('unicode');

function tmuxSession(overrides: Partial<TuiTmuxSession> & { muxName: string }): TuiTmuxSession {
  return {
    sessionIdPrefix: overrides.muxName.replace(/^codeman-/, ''),
    attached: false,
    ...overrides,
  };
}

function row(state: TuiRow['state'], sessionId = 'abcdef0123'): TuiRow {
  const session: TuiSessionRow = { sessionId, sources: ['live'] };
  return { session, state, group: state === 'working' ? 'working' : 'idle', since: 0 };
}

describe('tmuxSocketFromEnv', () => {
  it('reads the socket name out of a $TMUX value', () => {
    expect(tmuxSocketFromEnv('/tmp/tmux-1000/codeman,31415,0')).toBe('codeman');
    expect(tmuxSocketFromEnv('/tmp/tmux-1000/codeman-beta,7,2')).toBe('codeman-beta');
    // A bare default socket is still the name a `-L` comparison needs.
    expect(tmuxSocketFromEnv('/tmp/tmux-1000/default,7,2')).toBe('default');
  });

  it('reports "not inside tmux" for an absent or empty value', () => {
    expect(tmuxSocketFromEnv(undefined)).toBeNull();
    expect(tmuxSocketFromEnv('')).toBeNull();
    expect(tmuxSocketFromEnv('   ')).toBeNull();
  });
});

describe('planAttach', () => {
  it('attaches with the instance socket when the terminal is not inside tmux', () => {
    const plan = planAttach('codeman-abcdef01', { socket: 'codeman' });
    expect(plan).toEqual({
      kind: 'attach',
      file: 'tmux',
      args: ['-L', 'codeman', 'attach-session', '-t', 'codeman-abcdef01'],
    });
  });

  it('switches the current client when already inside tmux on the same socket', () => {
    const plan = planAttach('codeman-abcdef01', { socket: 'codeman', tmux: '/tmp/tmux-1000/codeman,31415,0' });
    expect(plan).toEqual({
      kind: 'switch',
      file: 'tmux',
      args: ['-L', 'codeman', 'switch-client', '-t', 'codeman-abcdef01'],
    });
  });

  it('refuses to nest when the surrounding tmux is a different server', () => {
    const plan = planAttach('codeman-abcdef01', { socket: 'codeman', tmux: '/tmp/tmux-1000/default,31415,0' });
    expect(plan.kind).toBe('refuse');
    if (plan.kind !== 'refuse') throw new Error('expected a refusal');
    expect(plan.reason).toBe('nested-foreign-socket');
    expect(plan.message).toContain('default');
    expect(plan.message).toContain('codeman');
  });

  it('refuses a row with no tmux session behind it', () => {
    for (const name of [undefined, '', '   ']) {
      const plan = planAttach(name, { socket: 'codeman' });
      expect(plan.kind).toBe('refuse');
      if (plan.kind !== 'refuse') throw new Error('expected a refusal');
      expect(plan.reason).toBe('no-mux-name');
    }
  });

  it('never builds a shell string: every field is its own argv entry', () => {
    const plan = planAttach('codeman-abcdef01', { socket: 'codeman' });
    if (plan.kind !== 'attach') throw new Error('expected an attach');
    expect(plan.args.some((arg) => arg.includes(' '))).toBe(false);
  });
});

describe('isSelfSession', () => {
  const id = 'abcdef01-2345-6789-abcd-ef0123456789';

  it('recognizes the session the TUI runs in, however the id was truncated', () => {
    expect(isSelfSession(id, { CODEMAN_SESSION_ID: id })).toBe(true);
    expect(isSelfSession(id, { CODEMAN_SESSION_ID: 'abcdef01' })).toBe(true);
    expect(isSelfSession('abcdef01', { CODEMAN_SESSION_ID: id })).toBe(true);
  });

  it('is false for another session, and for env that identifies nothing', () => {
    expect(isSelfSession(id, { CODEMAN_SESSION_ID: 'ffffffff' })).toBe(false);
    expect(isSelfSession(id, {})).toBe(false);
    expect(isSelfSession(id, { CODEMAN_SESSION_ID: 'abc' })).toBe(false);
  });
});

describe('the kill confirmation', () => {
  const state: TuiConfirmState = { sessionId: 'abcdef01-2345', name: 'w4-api', typed: '' };

  it('kills on y, upper or lower', () => {
    // Was: type the session's full name. The tester's verdict on that was
    // "thats stupid, just make me type Y to confirm", and they were right —
    // `x` then `y` is already two deliberate keystrokes on a selected row.
    expect(confirmKillStep(state, { type: 'char', value: 'y' })).toEqual({ kind: 'confirm' });
    expect(confirmKillStep(state, { type: 'char', value: 'Y' })).toEqual({ kind: 'confirm' });
  });

  it('cancels on every other key, rather than leaving the prompt armed', () => {
    // A dialog that ignores unknown keys sits there consuming whatever the
    // user types next, which for a destructive prompt is the wrong default.
    expect(confirmKillStep(state, { type: 'char', value: 'n' })).toEqual({ kind: 'cancel' });
    expect(confirmKillStep(state, { type: 'char', value: 'x' })).toEqual({ kind: 'cancel' });
    expect(confirmKillStep(state, { type: 'escape' })).toEqual({ kind: 'cancel' });
    expect(confirmKillStep(state, { type: 'ctrl', key: 'c' })).toEqual({ kind: 'cancel' });
  });

  it('does NOT kill on Enter, the key most likely to be hit by reflex', () => {
    expect(confirmKillStep(state, { type: 'enter' })).toEqual({ kind: 'cancel' });
  });
});

describe('footerKeysFor', () => {
  it('advertises only the verbs this build implements', () => {
    const keys = footerKeysFor('list', GLYPHS, { server: true }).join(' ');
    expect(keys).toContain('attach');
    expect(keys).toContain('1-9 switch');
    expect(keys).toContain('n new');
    expect(keys).toContain('p prompt');
    expect(keys).toContain('/ search');
    expect(keys).toContain('g digest');
    expect(keys).toContain('x kill');
    expect(keys).toContain('q quit');
    // Resuming a RECENT row is still phase 3.
    expect(keys).not.toContain('resume');
  });

  it('swaps in the answer keys while a dialog is on the selected row', () => {
    const keys = footerKeysFor('list', GLYPHS, { server: true, approval: 'menu' }).join(' ');
    expect(keys).toContain('y approve');
    expect(keys).toContain('n deny');
    expect(keys).toContain('1-9 option');
    // `n` cannot mean two things at once, and denying is what it does here.
    expect(keys).not.toContain('n new');
    expect(keys).not.toContain('1-9 switch');
  });

  it('sends an idle prompt to the composer instead of offering approve/deny', () => {
    const keys = footerKeysFor('list', GLYPHS, { server: true, approval: 'idle' }).join(' ');
    expect(keys).toContain('p reply');
    expect(keys).toContain('n new');
    expect(keys).not.toContain('y approve');
  });

  it('drops the server-only verbs in degraded mode', () => {
    const keys = footerKeysFor('list', GLYPHS, { server: false }).join(' ');
    expect(keys).toContain('attach');
    expect(keys).not.toContain('kill');
    expect(keys).not.toContain('new');
    expect(keys).not.toContain('search');
  });

  it('keeps the help overlay to the same inventory', () => {
    const help = helpKeysFor(GLYPHS, { server: true });
    expect(help.map(([, description]) => description)).toEqual(
      expect.arrayContaining([
        'attach — on a RECENT row, resume that conversation',
        'new session',
        'kill (y to confirm)',
        'quit',
      ])
    );
    expect(help.flat().join(' ')).toContain('search');
    const degraded = helpKeysFor(GLYPHS, { server: false }).flat().join(' ');
    expect(degraded).not.toContain('kill');
    expect(degraded).not.toContain('search');
  });

  it('follows the overlay that owns the keyboard', () => {
    expect(footerKeysFor('help', GLYPHS, { server: true })).toEqual(['esc close']);
    expect(footerKeysFor('confirm-kill', GLYPHS, { server: true }).join(' ')).toContain('y kill');
    expect(footerKeysFor('message', GLYPHS, { server: true })).toEqual(['esc dismiss']);
    expect(footerKeysFor('new-session', GLYPHS, { server: true }).join(' ')).toContain('type to filter');
    expect(footerKeysFor('prompt', GLYPHS, { server: true }).join(' ')).toContain('send');
    expect(footerKeysFor('search', GLYPHS, { server: true }).join(' ')).toContain('open');
    expect(footerKeysFor('digest', GLYPHS, { server: true }).join(' ')).toContain('scroll');
  });
});

describe('the preview policy', () => {
  const live: TuiRow = { ...row('idle', 'aaaaaaaa11'), group: 'idle' };
  const history: TuiRow = { ...row('recent', 'bbbbbbbb22'), group: 'recent' };

  it('polls a live row only while the plain list is on screen and wide', () => {
    const base = { mode: 'list' as const, narrow: false, connection: 'connected' as const, row: live };
    expect(shouldFetchPreview(base)).toBe(true);
    expect(shouldFetchPreview({ ...base, mode: 'prompt' })).toBe(false);
    expect(shouldFetchPreview({ ...base, mode: 'search' })).toBe(false);
    expect(shouldFetchPreview({ ...base, narrow: true })).toBe(false);
    expect(shouldFetchPreview({ ...base, connection: 'degraded' })).toBe(false);
    expect(shouldFetchPreview({ ...base, row: history })).toBe(false);
    expect(shouldFetchPreview({ ...base, row: null })).toBe(false);
  });

  it('explains a history row instead of polling one', () => {
    expect(previewNoteFor(history, 'connected')).toContain('not running');
    expect(previewNoteFor(live, 'connected')).toBeNull();
    // The renderer already says why a degraded server has no preview.
    expect(previewNoteFor(history, 'degraded')).toBeNull();
    expect(previewNoteFor(null, 'connected')).toBeNull();
  });

  it('treats an unchanged tail as nothing to repaint', () => {
    const preview = { sessionId: 'a', lines: ['one', 'two'] };
    expect(samePreview(preview, { sessionId: 'a', lines: ['one', 'two'] })).toBe(true);
    expect(samePreview(preview, { sessionId: 'a', lines: ['one', 'three'] })).toBe(false);
    expect(samePreview(preview, { sessionId: 'a', lines: ['one'] })).toBe(false);
    expect(samePreview(preview, { sessionId: 'b', lines: ['one', 'two'] })).toBe(false);
    expect(samePreview(preview, { sessionId: 'a', lines: ['one', 'two'], error: 'boom' })).toBe(false);
    expect(samePreview(preview, { sessionId: 'a', lines: ['one', 'two'], note: 'history' })).toBe(false);
    expect(samePreview(null, null)).toBe(true);
    expect(samePreview(null, preview)).toBe(false);
  });
});

describe('the refetch and tail-read cadence', () => {
  it('debounces a burst but paces a stream, measured from the last start', () => {
    // Nothing has been refetched yet: pay the debounce and nothing more.
    expect(resyncDelayMs(10_000, 0, 250, 3_000)).toBe(250);
    // A refetch that started 2.9s ago: wait out the rest of the floor.
    expect(resyncDelayMs(10_000, 9_900, 250, 3_000)).toBe(2_900);
    // Past the floor: back to the debounce, never below it.
    expect(resyncDelayMs(10_000, 6_000, 250, 3_000)).toBe(250);
    expect(resyncDelayMs(10_000, 1_000, 250, 3_000)).toBe(250);
  });

  it('reads a printing pane every second and a quiet one every five', () => {
    expect(previewIntervalMs(0, 1_000, 5_000)).toBe(1_000);
    expect(previewIntervalMs(1, 1_000, 5_000)).toBe(2_000);
    expect(previewIntervalMs(2, 1_000, 5_000)).toBe(4_000);
    // The ceiling holds however long the pane stays quiet, and a silly counter
    // cannot overflow the doubling into Infinity.
    expect(previewIntervalMs(3, 1_000, 5_000)).toBe(5_000);
    expect(previewIntervalMs(50, 1_000, 5_000)).toBe(5_000);
    expect(previewIntervalMs(-5, 1_000, 5_000)).toBe(1_000);
  });
});

describe('the repaint test', () => {
  const key = { revision: 3, cols: 100, rows: 30, tick: 0 };

  it('repaints on a first frame, a state change, a resize and a tick', () => {
    expect(sameFrame(null, key)).toBe(false);
    expect(sameFrame(key, { ...key, revision: 4 })).toBe(false);
    expect(sameFrame(key, { ...key, cols: 80 })).toBe(false);
    expect(sameFrame(key, { ...key, rows: 24 })).toBe(false);
    expect(sameFrame(key, { ...key, tick: 1 })).toBe(false);
  });

  it('writes nothing when nothing changed', () => {
    expect(sameFrame(key, { ...key })).toBe(true);
  });

  it('only animates while a WORKING row is on screen', () => {
    expect(shouldAnimate([row('idle'), row('recent')])).toBe(false);
    expect(shouldAnimate([row('idle'), row('working', 'bbbb1111')])).toBe(true);
    expect(shouldAnimate([])).toBe(false);
  });
});

describe('degraded-mode rows', () => {
  const sessions: TuiTmuxSession[] = [
    tmuxSession({ muxName: 'codeman-abcdef01', sessionId: 'abcdef01-2345', name: 'w4-api', workingDir: '/dev/api' }),
    tmuxSession({ muxName: 'codeman-99887766', createdAt: 1_000_000 }),
  ];

  it('keeps the tmux name and falls back to it as the row key', () => {
    const rows = tmuxRowsToSessions(sessions);
    expect(rows[0]).toMatchObject({
      sessionId: 'abcdef01-2345',
      muxName: 'codeman-abcdef01',
      name: 'w4-api',
      workingDir: '/dev/api',
    });
    // No state.json entry: the mux name is the only identity there is.
    expect(rows[1].sessionId).toBe('codeman-99887766');
    expect(rows[1].muxName).toBe('codeman-99887766');
  });

  it('classifies a running pane as IDLE rather than history', () => {
    const model = createTuiModel();
    model.replaceSessions(tmuxRowsToSessions(sessions));
    const groups = model.groups();
    expect(groups.find((group) => group.key === 'idle')?.rows).toHaveLength(2);
    expect(groups.find((group) => group.key === 'recent')?.rows).toHaveLength(0);
    expect(model.sessionCount).toBe(2);
  });
});

describe('applyMuxNames', () => {
  const tmux: TuiTmuxSession[] = [
    tmuxSession({ muxName: 'codeman-abcdef01', sessionId: 'abcdef01-2345-6789' }),
    tmuxSession({ muxName: 'codeman-99887766' }),
  ];

  it('joins on the 8-character prefix a mux name carries', () => {
    const rows = applyMuxNames(
      [
        { sessionId: 'abcdef01-2345-6789', sources: ['live'] },
        { sessionId: '99887766-0000-1111', sources: ['live'] },
        { sessionId: 'deadbeef-0000-1111', sources: ['history'] },
      ],
      tmux
    );
    expect(rows[0].muxName).toBe('codeman-abcdef01');
    expect(rows[1].muxName).toBe('codeman-99887766');
    // Nothing in tmux backs it, so attach has to refuse rather than guess.
    expect(rows[2].muxName).toBeUndefined();
  });

  it('copies rather than mutating its input, and survives an empty tmux list', () => {
    const input: TuiSessionRow[] = [{ sessionId: 'abcdef01-2345-6789', sources: ['live'] }];
    const rows = applyMuxNames(input, []);
    expect(rows[0]).not.toBe(input[0]);
    expect(rows[0].muxName).toBeUndefined();
    expect(input[0].muxName).toBeUndefined();
  });
});

describe('applyLiveMetrics', () => {
  const metrics: TuiLiveSessionMetrics[] = [
    { sessionId: 'aaaa1111', lastSubmitAt: 5_000, inputTokens: 900, outputTokens: 100 },
    { sessionId: 'bbbb2222', lastSubmitAt: 0, inputTokens: 0, outputTokens: 0 },
  ];

  it('folds the turn stamp and the token totals onto the matching row', () => {
    const rows = applyLiveMetrics(
      [
        { sessionId: 'aaaa1111', sources: ['live'] },
        { sessionId: 'cccc3333', sources: ['live'] },
      ],
      metrics
    );
    expect(rows[0]).toMatchObject({ lastSubmitAt: 5_000, inputTokens: 900, outputTokens: 100 });
    // No live counterpart (a history row): nothing to fold, nothing invented.
    expect(rows[1].lastSubmitAt).toBeUndefined();
    expect(rows[1].inputTokens).toBeUndefined();
  });

  it('treats a zero as unknown, so a never-submitted session is not dated to the epoch', () => {
    const [merged] = applyLiveMetrics([{ sessionId: 'bbbb2222', sources: ['live'], createdAt: 1_000 }], metrics);
    expect(merged.lastSubmitAt).toBeUndefined();
    expect(merged.inputTokens).toBeUndefined();
    expect(stateSince('working', merged)).toBe(1_000);
  });

  it('copies rather than mutating its input, and survives an empty metrics list', () => {
    const input: TuiSessionRow[] = [{ sessionId: 'aaaa1111', sources: ['live'] }];
    const rows = applyLiveMetrics(input, []);
    expect(rows[0]).not.toBe(input[0]);
    expect(rows[0].lastSubmitAt).toBeUndefined();
    expect(input[0].lastSubmitAt).toBeUndefined();
  });

  it('orders the WORKING group by when the turn started, not by session age', () => {
    // The regression this merge exists for: `old` was created a day before
    // `fresh` but started its turn a minute AFTER it, so `fresh` has been
    // working longer and has to lead. Without the merge both fall back to
    // createdAt and `old` wins.
    const unified: TuiSessionRow[] = [
      { sessionId: 'old00000', name: 'old', sources: ['live'], isWorking: true, createdAt: 1_000 },
      { sessionId: 'fresh000', name: 'fresh', sources: ['live'], isWorking: true, createdAt: 500_000 },
    ];
    const turns: TuiLiveSessionMetrics[] = [
      { sessionId: 'old00000', lastSubmitAt: 900_000 },
      { sessionId: 'fresh000', lastSubmitAt: 600_000 },
    ];

    const before = createTuiModel();
    before.replaceSessions(unified);
    expect(before.rows().map((r) => r.session.name)).toEqual(['old', 'fresh']);

    const after = createTuiModel();
    after.replaceSessions(applyLiveMetrics(unified, turns));
    expect(after.rows().map((r) => r.session.name)).toEqual(['fresh', 'old']);
    expect(after.rows()[0].since).toBe(600_000);
  });
});

describe('buildListLines', () => {
  it('numbers rows in the dashboard order, so `tui <n>` and `tui --list` agree', () => {
    const model = createTuiModel();
    model.replaceSessions([
      { sessionId: 'aaaa1111', name: 'quiet', sources: ['live'], lastActivityAt: 10 },
      { sessionId: 'bbbb2222', name: 'busy', sources: ['live'], isWorking: true, lastSubmitAt: 5 },
      { sessionId: 'cccc3333', name: 'past', sources: ['history'], lastActivityAt: 1 },
    ]);
    expect(buildListLines(model.rows())).toEqual([
      { index: 1, state: 'working', label: 'busy', workingDir: '' },
      { index: 2, state: 'idle', label: 'quiet', workingDir: '' },
      { index: 3, state: 'recent', label: 'past', workingDir: '' },
    ]);
  });

  it('truncates the label so one long prompt cannot pad the whole table', () => {
    const model = createTuiModel();
    model.replaceSessions([{ sessionId: 'aaaa1111', firstPrompt: 'x'.repeat(200), sources: ['history'] }]);
    const [line] = buildListLines(model.rows(), 20);
    expect(line.label).toHaveLength(20);
    expect(line.label.endsWith('…')).toBe(true);
  });
});

describe('the dead-row resume offer', () => {
  it('advertises r on the message footer only while an offer is armed', () => {
    const base = { server: true } as const;
    expect(footerKeysFor('message', GLYPHS, { ...base, resumeOffer: true })).toEqual(['r resume', 'esc dismiss']);
    // Without an offer the card is a plain notice, and a footer promising `r`
    // would be advertising a key that does nothing.
    expect(footerKeysFor('message', GLYPHS, base)).toEqual(['esc dismiss']);
  });
});

describe('the one-key way out', () => {
  it('names a single key with no modifier at all', () => {
    // The whole point: three beta rounds died on a chord that had to be typed
    // in the right order with the modifier released at the right moment. F1
    // rather than F12 so it sits beside Esc, where a hand backing out goes.
    expect(ONE_KEY_DETACH).toBe('F1');
    expect(ONE_KEY_DETACH).not.toContain('C-');
    expect(ONE_KEY_DETACH).not.toContain('+');
  });

  it('advertises alt+1-9 only once those keys were really claimed', () => {
    // Same rule as the way-out key: never name a key that does nothing. That
    // is the bug this whole series started with.
    const withSwitch = buildAttachBanner({ oneKey: 'F1', switchKeys: true, cols: 150 })['status-format[0]'];
    expect(withSwitch).toContain('alt+1-9 switch');
    expect(withSwitch).toContain('back to the codeman dashboard');
    expect(buildAttachBanner({ oneKey: 'F1', cols: 150 })['status-format[0]']).not.toContain('alt+1-9');
  });

  it('still fits the strip once the switch hint has taken its space', () => {
    for (const cols of [80, 100, 120, 190]) {
      const bar = buildAttachBanner({
        oneKey: 'F1',
        switchKeys: true,
        cols,
        tabs: Array.from({ length: 12 }, (_, i) => ({
          index: i + 1,
          label: `w${i + 1}-session-name`,
          active: i === 1,
        })),
      })['status-format[0]'];
      const visible = bar.replace(/#\[[^\]]*\]/g, '');
      expect({ cols, fits: visible.length <= cols }).toEqual({ cols, fits: true });
      expect(visible).toContain('alt+1-9 switch');
      expect(visible).toContain('back to the codeman dashboard');
    }
  });

  it('puts ONE instruction on the bar, not a menu of ways out', () => {
    const banner = buildAttachBanner({ prefix: 'C-b', detachKey: 'd', heldAlias: 'C-d', oneKey: 'F1' });
    const bar = banner['status-format[0]'];
    expect(bar).toContain('#[bold]F1#[nobold] back to the codeman dashboard');
    // Even though both fallbacks still work, the bar must not offer them: a bar
    // listing three ways to leave is what the tester called way too complicated.
    expect(bar).not.toContain('Ctrl+B');
    expect(bar).not.toContain('or Ctrl+D');
  });

  it('falls back to the chord when the key could not be claimed', () => {
    // Never advertise a key we did not get: a bar naming an inert key is the
    // original bug, in a new costume.
    const bar = buildAttachBanner({ prefix: 'C-b', detachKey: 'd', heldAlias: 'C-d' })['status-format[0]'];
    expect(bar).toContain('Ctrl+B then d');
    expect(bar).toContain('(or Ctrl+D)');
    expect(bar).not.toContain('F12');
  });
});

describe('the attach tab strip', () => {
  const tabs = (count: number, activeIndex: number) =>
    Array.from({ length: count }, (_, i) => ({ index: i + 1, label: `w${i + 1}-case`, active: i === activeIndex }));

  it('draws every session when they all fit, numbered as the dashboard numbers them', () => {
    const strip = buildAttachTabs(tabs(3, 1));
    expect(strip).toContain('1 w1-case');
    expect(strip).toContain('2 w2-case');
    expect(strip).toContain('3 w3-case');
    expect(strip).not.toContain('…');
  });

  it('inverts the session you are actually in', () => {
    const strip = buildAttachTabs(tabs(3, 1));
    expect(strip).toContain('#[reverse] 2 w2-case #[noreverse]');
    expect(strip).not.toContain('#[reverse] 1 w1-case');
  });

  it('windows around the active tab rather than overflowing the bar', () => {
    // Overflow would push the way-out hint off the end, which is the one thing
    // on the bar that must survive.
    const strip = buildAttachTabs(tabs(20, 9), 6);
    expect(strip).toContain('10 w10-case');
    expect(strip.startsWith('…')).toBe(true);
    expect(strip.endsWith('…')).toBe(true);
    expect(strip).not.toContain('1 w1-case ');
  });

  it('marks only the end that is actually cut', () => {
    const first = buildAttachTabs(tabs(20, 0), 6);
    expect(first.startsWith('…')).toBe(false);
    expect(first.endsWith('…')).toBe(true);
    const last = buildAttachTabs(tabs(20, 19), 6);
    expect(last.startsWith('…')).toBe(true);
    expect(last.endsWith('…')).toBe(false);
  });

  it('truncates a long session name instead of eating the whole strip', () => {
    const strip = buildAttachTabs([{ index: 1, label: 'w1-an-extremely-long-session-name', active: true }]);
    expect(strip).toContain('…');
    expect(strip.length).toBeLessThan(60);
  });

  it('is empty with no sessions, so the bar falls back to the plain label', () => {
    expect(buildAttachTabs([])).toBe('');
  });

  it('escapes a name that would otherwise open a tmux format', () => {
    expect(buildAttachTabs([{ index: 1, label: 'fix #42', active: false }])).toContain('fix ##42');
  });
});

describe('the held-Ctrl detach alias', () => {
  it('names the key a user produces when they never let go of Ctrl', () => {
    // The failure this exists for: "Ctrl+B then d" typed as one held chord
    // sends 0x02 then 0x04, and tmux leaves C-d unbound, so nothing happens.
    expect(heldCtrlAlias('d')).toBe('C-d');
  });

  it('lowercases, so a rebound uppercase key still yields the chord it produces', () => {
    expect(heldCtrlAlias('Q')).toBe('C-q');
  });

  it('has no alias for a key with no held-Ctrl form', () => {
    expect(heldCtrlAlias('F1')).toBeNull();
    expect(heldCtrlAlias('C-d')).toBeNull();
    expect(heldCtrlAlias('')).toBeNull();
    expect(heldCtrlAlias('1')).toBeNull();
  });

  it('advertises the alias on the bar only once it has been claimed', () => {
    const withAlias = buildAttachBanner({ prefix: 'C-b', detachKey: 'd', heldAlias: 'C-d' });
    expect(withAlias['status-format[0]']).toContain('Ctrl+B then d');
    expect(withAlias['status-format[0]']).toContain('(or Ctrl+D)');
    // Not claimed (the key was already bound to something of the user's) means
    // not advertised: a bar naming a key that does nothing is the original bug.
    expect(buildAttachBanner({ prefix: 'C-b', detachKey: 'd' })['status-format[0]']).not.toContain('or Ctrl');
  });
});

describe('the way out when F1 is taken, on a socket with no detach key', () => {
  // Codeman keeps only `<prefix> send-prefix` in its socket's prefix table
  // (src/tmux-prefix-table.ts), so tmux's stock `Ctrl+B then d` does nothing there.
  it('names the held-Ctrl chord on the bar instead of the stock d', () => {
    const bar = buildAttachBanner({ prefix: 'C-b', heldAlias: 'C-d' })['status-format[0]'];
    expect(bar).toContain('#[bold]Ctrl+B then Ctrl+D#[nobold]');
    expect(bar).not.toContain('then d');
  });

  it('hands the same chord back from the attach handoff, for the help overlay and the hint line', async () => {
    const free = new Set(['C-d', 'M-1']);
    const client = {
      readPrefixKey: async () => 'C-b',
      readDetachKey: async () => null,
      readPrefixBinding: async (key: string) => (free.has(key) ? null : 'display-message mine'),
      bindDetachKey: async () => true,
      unbindDetachKey: async () => true,
      bindSwitchKey: async () => true,
      unbindSwitchKey: async () => true,
      readSessionOptions: async () => null,
      applySessionOptions: async () => true,
      restoreSessionOptions: async () => true,
      readWindowSizing: async () => null,
      presizeWindow: async () => true,
      followAttachingClient: async () => true,
      restoreWindowSizing: async () => true,
    } as unknown as TuiClient;

    const handoff = await beginAttachHandoff(client, 'codeman-abc12345', 'w1-case');

    expect(handoff.chord).toBe('Ctrl+B then Ctrl+D');
  });
});

describe('naming a session the TUI starts', () => {
  it("follows the web UI's w<n>-<case> convention", () => {
    expect(nextSessionName('mirofish', [])).toBe('w1-mirofish');
    expect(nextSessionName('mirofish', ['w1-codeman', 'w2-codeman'])).toBe('w3-mirofish');
  });

  it('counts past names that are not w<n>- at all', () => {
    // A session named by hand, or by another surface, must not reset the run.
    expect(nextSessionName('demo', ['tui-demo-agent', 'w4-codeman', ''])).toBe('w5-demo');
  });

  it('never returns an empty name, which is what caused the bad label', () => {
    // An unnamed session falls through rowLabel() to the transcript's first
    // line, which put "Login interrupted" in the list as a session name.
    expect(nextSessionName('c', [])).not.toBe('');
    expect(nextSessionName('c', ['w9007199254740991-x'])).toMatch(/^w\d+-c$/);
  });
});

describe('the way out of an attach', () => {
  it('spells the prefix the way a human reads it, and never assumes C-b', () => {
    expect(formatPrefixKey('C-b')).toBe('Ctrl+B');
    // A user who remapped the prefix must not be told to press Ctrl+B.
    expect(formatPrefixKey('C-a')).toBe('Ctrl+A');
    expect(formatPrefixKey('M-x')).toBe('Alt+X');
    // Nothing to go on: the tmux default is the honest guess.
    expect(formatPrefixKey(undefined)).toBe('Ctrl+B');
    expect(formatPrefixKey('   ')).toBe('Ctrl+B');
    // A shape we do not recognise passes through rather than being mangled.
    expect(formatPrefixKey('F1')).toBe('F1');
  });

  it('names the chord, not just the prefix', () => {
    expect(detachChord('C-a', 'd')).toBe('Ctrl+A then d');
    expect(detachChord()).toBe('Ctrl+B then d');
  });

  it('names the LOWERCASE detach key, because capital D is choose-client', () => {
    // Regression: the bar shipped reading `Ctrl+B D`, and a beta tester pressing
    // exactly that landed in tmux's client chooser while staying attached. tmux
    // key tables are case-sensitive and `D` is bound to a different command.
    expect(detachChord()).not.toContain(' D');
    expect(detachChord()).toMatch(/ then d$/);
    expect(buildAttachBanner({})['status-format[0]']).not.toContain('#[bold]Ctrl+B D#[nobold]');
  });

  it('prints a rebound detach key verbatim, never uppercased like the prefix', () => {
    // formatPrefixKey() uppercases (`C-a` → `Ctrl+A`); running the detach key
    // through it would reintroduce the same class of bug on a rebound tmux.
    expect(detachChord('C-a', 'q')).toBe('Ctrl+A then q');
    expect(buildAttachBanner({ prefix: 'C-a', detachKey: 'q' })['status-format[0]']).toContain('Ctrl+A then q');
  });

  it('builds ONE status-format option, so tmux draws no window list beside it', () => {
    const banner = buildAttachBanner({ prefix: 'C-b', label: 'w3-codeman' });
    expect(Object.keys(banner).sort()).toEqual(['status', 'status-format[0]', 'status-position', 'status-style']);
    expect(banner.status).toBe('on');
    // Top, where the web UI keeps its tabs.
    expect(banner['status-position']).toBe('top');
    expect(banner['status-format[0]']).toContain('#[bold]Ctrl+B then d#[nobold]');
    // With no strip to draw, the session's own name is the fallback.
    expect(banner['status-format[0]']).toContain('w3-codeman');
  });

  it('sets status-style, or tmux paints its stock green bar under the bar', () => {
    // Regression: styling only status-format[0] left tmux's default
    // `bg=green,fg=black` status-style underneath, which a beta tester saw as a
    // full-width bright green slab across the bottom of the pane.
    const banner = buildAttachBanner({ prefix: 'C-b' });
    expect(banner['status-style']).toBe('bg=default,fg=default');
    expect(banner['status-format[0]']).not.toContain('#[reverse]');
  });

  it('carries the remapped prefix into the bar', () => {
    expect(buildAttachBanner({ prefix: 'C-a' })['status-format[0]']).toContain('Ctrl+A then d');
  });

  it('escapes a label that would otherwise open a tmux format', () => {
    const banner = buildAttachBanner({ label: 'fix #42 #[bold]' });
    expect(banner['status-format[0]']).toContain('fix ##42 ##[bold]');
  });

  it('truncates a long label instead of pushing the instruction off the bar', () => {
    const banner = buildAttachBanner({ label: 'w12-codeman: a very long session label indeed' });
    const left = (banner['status-format[0]'].split('#[align=right]')[0] ?? '').replace('#[align=left]', '');
    // 28 characters of label plus the space either side.
    expect(left.length).toBeLessThanOrEqual(30);
    expect(left).toContain('…');
    expect(banner['status-format[0]']).toContain('back to the codeman dashboard');
  });

  it('always keeps the way out on the bar, whatever else is on it', () => {
    // The hint is the one thing that must never be crowded off: it is the only
    // instruction a user gets while tmux owns the terminal.
    const crowded = buildAttachBanner({
      oneKey: 'F1',
      tabs: Array.from({ length: 20 }, (_, i) => ({
        index: i + 1,
        label: `w${i + 1}-a-long-session-name`,
        active: i === 9,
      })),
    });
    expect(crowded['status-format[0]']).toContain('#[bold]F1#[nobold] back to the codeman dashboard');
  });

  it('fits the strip to the terminal, measuring VISIBLE columns not format bytes', () => {
    // The test above only checks the hint is in the format STRING, which it
    // always was. tmux truncates what it cannot fit and drops the right-aligned
    // segment, so on a real terminal the hint vanished at every width tested
    // while that assertion stayed green.
    const hint = ' F1 back to the codeman dashboard ';
    for (const cols of [80, 100, 120, 176]) {
      const bar = buildAttachBanner({
        oneKey: 'F1',
        cols,
        tabs: Array.from({ length: 12 }, (_, i) => ({
          index: i + 1,
          label: `w${i + 1}-session-name`,
          active: i === 1,
        })),
      })['status-format[0]'];
      const visible = bar.replace(/#\[[^\]]*\]/g, '');
      expect({ cols, fits: visible.length <= cols }).toEqual({ cols, fits: true });
      expect(visible.length).toBeGreaterThanOrEqual(hint.length);
    }
  });

  it('keeps at least one tab even when the hint eats almost the whole bar', () => {
    const bar = buildAttachBanner({
      oneKey: 'F1',
      cols: 40,
      tabs: [{ index: 1, label: 'w1-case', active: true }],
    })['status-format[0]'];
    expect(bar).toContain('1 w1-case');
    expect(bar).toContain('back to the codeman dashboard');
  });

  it("tells the help overlay how to get back, in the socket's own prefix", () => {
    const keys = helpKeysFor(GLYPHS, { server: true, detach: 'Ctrl+A then d' });
    const detach = keys.find(([key]) => key === 'Ctrl+A then d');
    expect(detach?.[1]).toContain('detach');
    // Degraded mode still attaches, so it still needs the way out. Before the first
    // attach that is F1: Codeman's socket has no `d` in its prefix table to name.
    const before = helpKeysFor(GLYPHS, { server: false }).map(([key]) => key);
    expect(before).toContain(ONE_KEY_DETACH);
    expect(before).not.toContain('Ctrl+B then d');
  });
});

describe('planResume', () => {
  const base = { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', sources: ['transcript'] } as const;

  it('resumes the CONVERSATION id, not the row id', () => {
    const plan = planResume({
      ...base,
      claudeSessionId: 'bbbbbbbb-5555-6666-7777-888888888888',
      workingDir: '/home/dev/codeman',
      name: 'w7-codeman',
    });
    expect(plan).toEqual({
      kind: 'resume',
      workingDir: '/home/dev/codeman',
      resumeSessionId: 'bbbbbbbb-5555-6666-7777-888888888888',
      sessionName: 'w7-codeman',
    });
  });

  it('falls back to the row id when the row IS the transcript', () => {
    const plan = planResume({ ...base, workingDir: '/home/dev/codeman' });
    expect(plan).toMatchObject({ kind: 'resume', resumeSessionId: base.sessionId });
    // No name to keep: the server names it rather than the TUI inventing one.
    expect(plan).not.toHaveProperty('sessionName');
  });

  it('refuses a row with nowhere to run', () => {
    expect(planResume({ ...base })).toMatchObject({ kind: 'refuse' });
  });

  it('refuses a non-claude row, since resume is a Claude Code feature', () => {
    const plan = planResume({ ...base, workingDir: '/home/dev/codeman', mode: 'codex' });
    expect(plan.kind).toBe('refuse');
    if (plan.kind === 'refuse') expect(plan.message).toContain('codex');
  });

  it('refuses an id the server would reject anyway', () => {
    // The route validates `/^[a-f0-9-]+$/`; a mux-derived row id is not that.
    expect(planResume({ ...base, sessionId: 'codeman-w1', workingDir: '/home/dev' })).toMatchObject({
      kind: 'refuse',
    });
  });
});
