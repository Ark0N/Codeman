/**
 * @fileoverview Unit tests for the frame renderer.
 *
 * The structural expectations below are full frames with the escapes stripped,
 * which is what makes a layout regression readable in a diff; the escape
 * sequences themselves are asserted separately, including the promise that
 * NO_COLOR leaves nothing but cursor addressing behind.
 */
import { describe, it, expect } from 'vitest';
import { charWidth, stripStyles, toDisplayLines, visibleWidth } from '../../src/tui/tui-ansi.js';
import { composerMove, createComposer } from '../../src/tui/tui-composer.js';
import { computeLayout, needsBanner } from '../../src/tui/tui-layout.js';
import { createTuiModel, type TuiModelStore } from '../../src/tui/tui-model.js';
import type { ApprovalItem } from '../../src/web/approval-inbox.js';
import {
  composerCursorCell,
  detectGlyphTier,
  digestCapacity,
  formatElapsed,
  formatPlanUsage,
  formatTokens,
  glyphsFor,
  pendingApprovalCount,
  renderFrame,
  rowLabel,
  type TuiRenderOptions,
} from '../../src/tui/tui-render.js';

const NOW = 1_700_000_000_000;

const PLAIN: TuiRenderOptions = { color: false, glyphs: 'unicode', tick: 4, now: NOW };

function fixture(): TuiModelStore {
  const model = createTuiModel();
  model.setHeader({ hostname: 'tnode', version: '1.19.0', planUsage: '5h 32% wk 61%' });
  model.replaceSessions([
    {
      sessionId: 'aaa1',
      name: 'w4-api-refactor',
      mode: 'claude',
      status: 'busy',
      isWorking: true,
      workingDir: '/home/dev/api',
      createdAt: NOW - 9_000_000,
      lastActivityAt: NOW - 1_000,
      lastSubmitAt: NOW - 134_000,
      inputTokens: 9_000,
      outputTokens: 3_300,
      sources: ['live', 'persisted'],
    },
    {
      sessionId: 'bbb2',
      name: 'w6-docs',
      mode: 'claude',
      status: 'idle',
      workingDir: '/home/dev/docs',
      createdAt: NOW - 8_000_000,
      lastActivityAt: NOW - 660_000,
      sources: ['live'],
    },
    {
      sessionId: 'ccc3',
      name: 'w1-codeman',
      mode: 'claude',
      status: 'busy',
      isWorking: true,
      workingDir: '/home/dev/codeman',
      createdAt: NOW - 10_000_000,
      lastActivityAt: NOW,
      lastSubmitAt: NOW - 1_020_000,
      inputTokens: 40_000,
      outputTokens: 5_200,
      sources: ['live'],
    },
    {
      sessionId: 'ddd4',
      name: 'w2-gallery',
      mode: 'codex',
      status: 'idle',
      workingDir: '/home/dev/gallery',
      createdAt: NOW - 6_000_000,
      lastActivityAt: NOW - 7_200_000,
      sources: ['live'],
    },
    {
      sessionId: 'eee5',
      firstPrompt: 'fix the release script',
      workingDir: '/home/dev/api',
      lastActivityAt: NOW - 3 * 86_400_000,
      sources: ['history'],
    },
  ]);
  model.setApprovals([
    { id: 'bbb2:1', sessionId: 'bbb2', sessionName: 'w6-docs', kind: 'idle', createdAt: NOW - 680_000 },
    {
      id: 'aaa1:2',
      sessionId: 'aaa1',
      sessionName: 'w4-api-refactor',
      kind: 'permission',
      createdAt: NOW - 120_000,
      toolName: 'Bash',
      toolSummary: 'Bash(git push origin main)',
      options: [
        { n: 1, label: 'Yes' },
        { n: 2, label: "Yes, don't ask again" },
        { n: 3, label: 'No, tell Claude what to do' },
      ],
    },
  ]);
  model.select('aaa1');
  model.setPreview({
    sessionId: 'aaa1',
    lines: toDisplayLines('\x1b[32mActualizing...\x1b[0m (2m 14s)\nrunning tests\n\x1b[31mwarning\x1b[0m here\n'),
  });
  return model;
}

function render(model: TuiModelStore, cols: number, rows: number, opts: Partial<TuiRenderOptions> = {}): string {
  const layout = computeLayout(cols, rows, { banner: needsBanner(model.connection) });
  return renderFrame(model, layout, { ...PLAIN, ...opts });
}

/** The frame as visible lines: escapes stripped, trailing padding trimmed. */
function frameLines(frame: string): string[] {
  return frame
    .split(/\x1b\[\d+;1H/)
    .slice(1)
    .map((part) => stripStyles(part).trimEnd());
}

describe('renderFrame structure', () => {
  it('paints the wide layout at 100x30', () => {
    expect(frameLines(render(fixture(), 100, 30))).toEqual([
      ' codeman  ▲ 2  tnode · v1.19.0 · 4 sessions · 5h 32% wk 61%                          ? help  q quit',
      ' NEEDS YOU ─────────────────────────│ w4-api-refactor · claude · /home/dev/api · blocked',
      '  1 w6-docs                    ! 11m│ ▲ requests: Bash(git push origin main)',
      '▶ 2 w4-api-refactor       ▲ 2m 12.3k│   1. Yes',
      " WORKING ───────────────────────────│   2. Yes, don't ask again",
      '  3 w1-codeman           ▖ 17m 45.2k│   3. No, tell Claude what to do',
      ' IDLE ──────────────────────────────│ y approve · n deny · digit chooses',
      '  4 w2-gallery codex            ○ 2h│',
      ' RECENT ────────────────────────────│ Actualizing... (2m 14s)',
      '  5 fix the release script      ✔ 3d│ running tests',
      '                                    │ warning here',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      '                                    │',
      ' ↑↓ select · ↵ attach · 1-9 switch · y/n answer · p prompt · n new · x kill · / search · g digest ·',
    ]);
  });

  it('paints the narrow two-line layout at 44x20', () => {
    expect(frameLines(render(fixture(), 44, 20))).toEqual([
      ' codeman  ▲ 2  tnode · v1.19.0 · 4 sessions',
      ' NEEDS YOU ─────────────────────────────────',
      '  1 w6-docs                            ! 11m',
      '    /home/dev/docs',
      '▶ 2 w4-api-refactor                     ▲ 2m',
      '    /home/dev/api · 12.3k',
      ' WORKING ───────────────────────────────────',
      '  3 w1-codeman                         ▖ 17m',
      '    /home/dev/codeman · 45.2k',
      ' IDLE ──────────────────────────────────────',
      '  4 w2-gallery codex                    ○ 2h',
      '    /home/dev/gallery · codex',
      ' RECENT ────────────────────────────────────',
      '  5 fix the release script              ✔ 3d',
      '    /home/dev/api',
      '',
      '',
      '',
      '',
      ' ↑↓ select · ↵ attach · 1-9 switch · y/n ans',
    ]);
  });

  it('addresses every line absolutely and erases its tail', () => {
    const frame = render(fixture(), 100, 30);
    const addresses = [...frame.matchAll(/\x1b\[(\d+);1H/g)].map((match) => Number(match[1]));
    expect(addresses).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(frame.split('\x1b[K')).toHaveLength(31);
    expect(frame).not.toContain('\n');
  });

  it('never lets a line exceed the terminal width', () => {
    for (const [cols, rows] of [
      [100, 30],
      [44, 20],
      [72, 8],
      [30, 6],
    ] as const) {
      for (const line of frameLines(render(fixture(), cols, rows))) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('is deterministic for identical inputs', () => {
    expect(render(fixture(), 100, 30)).toBe(render(fixture(), 100, 30));
  });

  it('degrades to a header-only frame on a 5x5 terminal without throwing', () => {
    expect(() => render(fixture(), 5, 5)).not.toThrow();
    expect(frameLines(render(fixture(), 5, 5))).toHaveLength(5);
  });
});

describe('color', () => {
  it('paints states and chrome when color is on', () => {
    const model = fixture();
    model.select('eee5');
    const frame = render(model, 100, 30, { color: true });
    expect(frame).toContain('\x1b[32m▖');
    expect(frame).toContain('\x1b[31m▲');
    expect(frame).toContain('\x1b[33m!');
    expect(frame).toContain('\x1b[1mcodeman');
  });

  it('paints the selected row as one inverse block with no styling inside it', () => {
    // An inner reset would punch a hole in the highlight, so the selected row
    // is built unpainted and wrapped instead.
    const frame = render(fixture(), 100, 30, { color: true });
    const highlighted = frame.split('\x1b[7m')[1]?.split('\x1b[0m')[0] ?? '';
    expect(highlighted).toContain('w4-api-refactor');
    expect(highlighted).toContain('▲');
    expect(highlighted).not.toContain('\x1b[');
  });

  it('emits nothing but cursor addressing when color is off', () => {
    const frame = render(fixture(), 100, 30, { color: false });
    const withoutAddressing = frame.replace(/\x1b\[\d+;1H/g, '').replace(/\x1b\[K/g, '');
    expect(withoutAddressing).not.toContain('\x1b');
  });

  it('strips the session own colors out of the preview under NO_COLOR', () => {
    const model = fixture();
    model.setPreview({ sessionId: 'aaa1', lines: toDisplayLines('\x1b[31mred tail\x1b[0m') });
    expect(render(model, 100, 30, { color: false })).not.toContain('\x1b[31m');
    expect(render(model, 100, 30, { color: true })).toContain('\x1b[31m');
  });
});

describe('glyph tiers', () => {
  it('falls back to bracketed ASCII tokens', () => {
    const lines = frameLines(render(fixture(), 100, 30, { glyphs: 'ascii' }));
    const list = lines.map((line) => line.split('|')[0]);
    expect(list[2]).toContain('[w]');
    expect(list[3]).toContain('[!]');
    expect(list[5]).toContain('[*]');
    expect(list[7]).toContain('[-]');
    expect(list[9]).toContain('[v]');
    expect(list[3].startsWith('>')).toBe(true);
    expect(lines.join('')).not.toContain('▝');
    expect(lines.join('')).not.toContain('─');
  });

  it('animates the working glyph with the tick, and cycles', () => {
    const model = fixture();
    const frames = [0, 1, 2, 3, 4, 5].map((tick) => frameLines(render(model, 100, 30, { tick }))[5]);
    // Quadrant blocks, rotating. Four of them, so the tick wraps every four
    // frames rather than every six.
    expect(frames[0]).toContain('▖');
    expect(frames[1]).toContain('▘');
    expect(frames[2]).toContain('▝');
    expect(frames[3]).toContain('▗');
    expect(frames[4]).toBe(frames[0]);
    expect(frames[5]).toBe(frames[1]);
    expect(new Set(frames).size).toBe(4);
  });

  it('detects a tier from the environment', () => {
    expect(detectGlyphTier({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' })).toBe('unicode');
    expect(detectGlyphTier({ TERM: 'xterm-kitty', LANG: 'en_US.UTF-8' })).toBe('nerd');
    expect(detectGlyphTier({ TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', LANG: 'en_US.UTF-8' })).toBe('nerd');
    expect(detectGlyphTier({ TERM: 'xterm-256color', LANG: 'C' })).toBe('ascii');
    expect(detectGlyphTier({ TERM: 'dumb' })).toBe('ascii');
    expect(detectGlyphTier({})).toBe('ascii');
    expect(detectGlyphTier({ TERM: 'xterm-kitty', LANG: 'en_US.UTF-8', CODEMAN_TUI_GLYPHS: 'ascii' })).toBe('ascii');
  });
});

describe('overlays', () => {
  it('draws the help box over the body', () => {
    const model = fixture();
    model.setMode('help');
    const lines = frameLines(render(model, 100, 30));
    expect(lines.join('\n')).toContain('┌ Keys ');
    expect(lines.some((line) => line.includes('attach'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('close');
  });

  it('names what a kill would destroy, and asks for one key', () => {
    const model = fixture();
    model.beginConfirmKill(model.rows()[0], 'w6-docs');
    const text = frameLines(render(model, 100, 30)).join('\n');
    expect(text).toContain('Kill w6-docs?');
    expect(text).toContain('press y to kill, any other key cancels');
    // The name is the point of the dialog: it is what tells the user WHICH
    // session a keystroke is about to destroy.
    expect(text).not.toContain('Type the name to confirm');
  });

  it('draws a message box', () => {
    const model = fixture();
    model.setMessage({ text: 'session refused to start: tmux is not installed', tone: 'err' });
    const text = frameLines(render(model, 100, 30)).join('\n');
    expect(text).toContain('Error');
    expect(text).toContain('tmux is not installed');
  });

  it('skips the overlay when the body is too small to hold a box', () => {
    const model = fixture();
    model.setMode('help');
    expect(frameLines(render(model, 100, 4)).join('\n')).not.toContain('Keys');
  });
});

describe('connection states', () => {
  it('banners a degraded server and says the preview is gone', () => {
    const model = fixture();
    model.setConnection('degraded');
    const lines = frameLines(render(model, 100, 30));
    expect(lines[1]).toContain('server not running: attach only');
    expect(lines.join('\n')).toContain('preview unavailable while the server is down');
  });

  it('banners reconnecting and down differently', () => {
    const model = fixture();
    model.setConnection('reconnecting');
    expect(frameLines(render(model, 100, 30))[1]).toContain('reconnecting');
    model.setConnection('down');
    expect(frameLines(render(model, 100, 30))[1]).toContain('server unreachable');
  });
});

describe('empty and partial states', () => {
  it('shows the empty hint when there are no sessions', () => {
    const model = createTuiModel();
    const lines = frameLines(render(model, 100, 30));
    expect(lines.join('\n')).toContain('No sessions. n to start one, q to quit.');
    expect(lines[1]).not.toContain('NEEDS YOU');
  });

  it('says the preview is still loading when it belongs to another session', () => {
    const model = fixture();
    model.setPreview({ sessionId: 'bbb2', lines: ['other session'] });
    const text = frameLines(render(model, 100, 30)).join('\n');
    expect(text).toContain('loading preview…');
    expect(text).not.toContain('other session');
  });

  it('surfaces a preview error instead of a stale tail', () => {
    const model = fixture();
    model.setPreview({ sessionId: 'aaa1', lines: [], error: 'terminal capture failed' });
    expect(frameLines(render(model, 100, 30)).join('\n')).toContain('terminal capture failed');
  });

  it('scrolls the list so the selected row stays visible', () => {
    const model = createTuiModel();
    model.replaceSessions(
      Array.from({ length: 30 }, (_, i) => ({
        sessionId: `s${String(i).padStart(2, '0')}`,
        name: `session-${String(i).padStart(2, '0')}`,
        sources: ['live'],
        status: 'idle',
        lastActivityAt: NOW - i * 1000,
      }))
    );
    model.select('s29');
    const text = frameLines(render(model, 100, 12)).join('\n');
    expect(text).toContain('session-29');
    expect(text).not.toContain('session-00');
  });
});

describe('formatting helpers', () => {
  it('formats elapsed time compactly', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(11 * 60_000)).toBe('11m');
    expect(formatElapsed(2 * 3_600_000)).toBe('2h');
    expect(formatElapsed(3 * 86_400_000)).toBe('3d');
    expect(formatElapsed(-1)).toBe('');
    expect(formatElapsed(Number.NaN)).toBe('');
  });

  it('formats token counts compactly', () => {
    expect(formatTokens(0)).toBe('');
    expect(formatTokens(842)).toBe('842');
    expect(formatTokens(45_200)).toBe('45.2k');
    expect(formatTokens(45_000)).toBe('45k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });

  it('names a row the way the web history list does', () => {
    expect(rowLabel({ sessionId: 'abcdef12', name: 'w1', sources: [] })).toBe('w1');
    expect(rowLabel({ sessionId: 'abcdef12', firstPrompt: 'do the thing', sources: [] })).toBe('do the thing');
    expect(rowLabel({ sessionId: 'abcdef12', firstPrompt: '(no content)', workingDir: '/a/b/case', sources: [] })).toBe(
      'case'
    );
    expect(rowLabel({ sessionId: 'abcdef1234', sources: [] })).toBe('abcdef12');
  });

  it('names a LIVE pane after its case, never after scraped output', () => {
    // Regression: a session started from the TUI before the user typed anything
    // had no name and no prompt, so the fallback took the CLI's first line of
    // output. A healthy new session showed up in the list called
    // "Login interrupted", which reads like a failure.
    expect(
      rowLabel({
        sessionId: 'abcdef12',
        firstPrompt: 'Login interrupted',
        workingDir: '/home/u/codeman-cases/mirofish',
        muxName: 'codeman-abcdef12',
        sources: [],
      })
    ).toBe('mirofish');
  });

  it('still names a HISTORY row by its prompt, where the prompt IS the identity', () => {
    expect(
      rowLabel({
        sessionId: 'abcdef12',
        firstPrompt: 'do the thing',
        workingDir: '/home/u/codeman-cases/mirofish',
        sources: [],
      })
    ).toBe('do the thing');
  });

  it('prefers a real name over both, on a live row and a history row alike', () => {
    const base = { sessionId: 'abcdef12', firstPrompt: 'Login interrupted', workingDir: '/a/b/case', sources: [] };
    expect(rowLabel({ ...base, name: 'w2-case' })).toBe('w2-case');
    expect(rowLabel({ ...base, name: 'w2-case', muxName: 'codeman-abcdef12' })).toBe('w2-case');
  });
});

describe('the approval card', () => {
  it('draws the dialog above the tail, with its digits', () => {
    const text = frameLines(render(fixture(), 100, 30)).join('\n');
    expect(text).toContain('▲ requests: Bash(git push origin main)');
    expect(text).toContain('1. Yes');
    expect(text).toContain('3. No, tell Claude what to do');
    expect(text).toContain('y approve · n deny · digit chooses');
    // The tail is still there, below the card.
    expect(text).toContain('Actualizing...');
  });

  it('paints a dialog red and a waiting prompt yellow', () => {
    const model = fixture();
    const frame = render(model, 100, 30, { color: true });
    expect(frame).toContain('\x1b[31m ▲ requests');

    model.select('bbb2');
    const idle = render(model, 100, 30, { color: true });
    expect(idle).toContain('\x1b[33m !');
    expect(idle).toContain('p to reply');
  });

  it('never lets the card push the tail off the pane', () => {
    const model = fixture();
    const lines = frameLines(render(model, 100, 10));
    // 8 body lines: the card gets at most half, so some tail survives.
    expect(lines.join('\n')).toContain('warning here');
  });

  it('counts pending prompts in the header badge', () => {
    expect(frameLines(render(fixture(), 100, 30))[0]).toContain('▲ 2');
    const model = createTuiModel();
    model.replaceSessions([{ sessionId: 'aaa1', name: 'w1', sources: ['live'], status: 'idle' }]);
    expect(frameLines(render(model, 100, 30))[0]).not.toContain('▲');
  });
});

describe('the preview title', () => {
  it('names the session, its CLI, its directory and its state', () => {
    expect(frameLines(render(fixture(), 100, 30))[1]).toContain('w4-api-refactor · claude · /home/dev/api · blocked');
  });

  it('sacrifices the path rather than the state word when the pane is narrow', () => {
    const model = fixture();
    model.setApprovals([]);
    model.select('ccc3');
    const title = frameLines(render(model, 80, 30))[1];
    expect(title).toContain('w1-codeman');
    expect(title).toContain('working');
  });

  it('says a history row has nothing to show rather than claiming to load it', () => {
    const model = fixture();
    model.select('eee5');
    model.setPreview({ sessionId: 'eee5', lines: [], note: 'this session is not running: no live output to show' });
    expect(frameLines(render(model, 100, 30)).join('\n')).toContain('no live output to show');
  });
});

describe('the prompt composer', () => {
  function composing(text: string, cursorAt?: number): TuiModelStore {
    const model = fixture();
    let composer = createComposer(text);
    if (cursorAt !== undefined) composer = composerMove(composer, cursorAt - text.length);
    model.setPrompt({ sessionId: 'aaa1', label: 'w4-api-refactor', composer });
    return model;
  }

  it('replaces the footer keys with the line being typed', () => {
    const lines = frameLines(render(composing('deploy the thing'), 100, 30));
    expect(lines[lines.length - 1]).toBe(' > deploy the thing');
  });

  it('puts the terminal cursor where the caret is', () => {
    const layout = computeLayout(100, 30);
    expect(composerCursorCell(composing('abc'), layout)).toEqual({ row: 30, col: 7 });
    expect(composerCursorCell(composing('abc', 1), layout)).toEqual({ row: 30, col: 5 });
    // No composer, no cursor: a blinking cursor in a dashboard reads as a bug.
    expect(composerCursorCell(fixture(), layout)).toBeNull();
  });

  it('scrolls a long line so the caret stays on screen', () => {
    const long = 'x'.repeat(200);
    const lines = frameLines(render(composing(long), 100, 30));
    const footer = lines[lines.length - 1];
    expect(visibleWidth(footer)).toBeLessThanOrEqual(100);
    const cursor = composerCursorCell(composing(long), computeLayout(100, 30));
    expect(cursor?.col).toBeLessThanOrEqual(100);
  });
});

describe('the search overlay', () => {
  function searching(): TuiModelStore {
    const model = fixture();
    model.setSearch({
      composer: createComposer('alpha'),
      query: 'alpha',
      status: 'done',
      note: '2 results',
      index: 1,
      entries: [
        { kind: 'header', text: 'SESSIONS' },
        { kind: 'result', text: 'w1-alpha', detail: '/tmp/alpha', sessionId: 'aaa1', live: true },
        { kind: 'result', text: 'w9-old', detail: '/tmp/old', sessionId: 'zzz9', live: false },
      ],
    });
    return model;
  }

  it('shows the query with a caret, the count and the rows', () => {
    const text = frameLines(render(searching(), 100, 30)).join('\n');
    expect(text).toContain('┌ Search ');
    expect(text).toContain('alpha_');
    expect(text).toContain('2 results');
    expect(text).toContain('SESSIONS');
    expect(text).toContain('▶ w1-alpha  /tmp/alpha');
    expect(text).toContain('w9-old');
  });

  it('invites a query before anything has been typed', () => {
    const model = fixture();
    model.setSearch({ composer: createComposer(), query: '', entries: [], index: -1, status: 'idle' });
    expect(frameLines(render(model, 100, 30)).join('\n')).toContain('type to search');
  });
});

describe('the digest overlay', () => {
  it('windows the lines it was given and scrolls with the offset', () => {
    const model = fixture();
    const lines = Array.from({ length: 40 }, (_, i) => `digest line ${i}`);
    model.setDigest({ title: 'Away digest', lines, offset: 0 });
    const top = frameLines(render(model, 100, 12)).join('\n');
    expect(top).toContain('┌ Away digest ');
    expect(top).toContain('digest line 0');
    expect(top).not.toContain('digest line 30');

    model.scrollDigest(30, digestCapacity(computeLayout(100, 12)));
    const scrolled = frameLines(render(model, 100, 12)).join('\n');
    expect(scrolled).toContain('digest line 30');
    expect(scrolled).not.toContain('digest line 0\n');
  });
});

describe('formatPlanUsage', () => {
  it('mirrors the web chip, both windows and either alone', () => {
    expect(
      formatPlanUsage({ fiveHour: { usedPercentage: 32.4, resetAt: 1 }, sevenDay: { usedPercentage: 61, resetAt: 2 } })
    ).toBe('5h 32% · wk 61%');
    expect(formatPlanUsage({ fiveHour: { usedPercentage: 5, resetAt: 1 } })).toBe('5h 5%');
    expect(formatPlanUsage({ sevenDay: { usedPercentage: 90, resetAt: 1 } })).toBe('wk 90%');
  });

  it('punctuates with the separator it is given, so an ASCII terminal gets none', () => {
    const usage = { fiveHour: { usedPercentage: 32, resetAt: 1 }, sevenDay: { usedPercentage: 61, resetAt: 2 } };
    expect(formatPlanUsage(usage, ' - ')).toBe('5h 32% - wk 61%');
  });

  it('is empty when there is nothing to report, so the header shows no placeholder', () => {
    expect(formatPlanUsage(null)).toBe('');
    expect(formatPlanUsage(undefined)).toBe('');
    expect(formatPlanUsage({})).toBe('');
  });
});

describe('the unicode glyph set is safe to render', () => {
  // Two failures this pins, both found on one beta tester's terminal:
  // a double-width glyph shifting every cell after it, and a codepoint their
  // font had no glyph for at all.
  const UNICODE = glyphsFor('unicode');
  const every = [
    UNICODE.blockedPermission,
    UNICODE.blockedQuestion,
    UNICODE.waiting,
    ...UNICODE.working,
    UNICODE.idle,
    UNICODE.recent,
    UNICODE.cursor,
    UNICODE.rule,
    UNICODE.divider,
    UNICODE.boxTopLeft,
    UNICODE.boxTopRight,
    UNICODE.boxBottomLeft,
    UNICODE.boxBottomRight,
    UNICODE.boxHorizontal,
    UNICODE.boxVertical,
    UNICODE.enter,
    UNICODE.updown,
    UNICODE.separator,
    UNICODE.ellipsis,
  ];

  it('has no double-width glyph, which would shift every cell after it', () => {
    for (const glyph of every) {
      for (const char of glyph) {
        expect({ glyph, width: charWidth(char.codePointAt(0) ?? 0) }).toEqual({ glyph, width: 1 });
      }
    }
  });

  it('uses the arrow-block return symbol, not the one fonts lack', () => {
    // U+23CE rendered as an empty box on a font that drew everything else here.
    expect(UNICODE.enter).toBe('\u21B5');
    expect(UNICODE.enter).not.toBe('\u23CE');
  });

  it('draws only from blocks a plain terminal font actually carries', () => {
    // The rule, as a CLASS rather than one glyph at a time. Three separate
    // "why are there boxes" reports came from this list, each fixed alone:
    // ❯ (U+276F, sparse Dingbats), ⏵ (U+23F5) and ⏎ (U+23CE, both Misc
    // Technical). The same font drew Box Drawing, Block Elements, Geometric
    // Shapes and Latin-1 perfectly, so those are what the set may use.
    const BANNED: Array<[number, number, string]> = [
      [0x2300, 0x23ff, 'Miscellaneous Technical'],
      [0x2600, 0x26ff, 'Miscellaneous Symbols'],
      [0x2700, 0x27bf, 'Dingbats'],
    ];
    // U+2714 is the one Dingbat kept: it was observed rendering on the very
    // font that failed the others, and it is the list's "done" mark.
    const ALLOWED = new Set([0x2714]);
    for (const glyph of every) {
      for (const char of glyph) {
        const cp = char.codePointAt(0) ?? 0;
        if (ALLOWED.has(cp)) continue;
        const banned = BANNED.find(([lo, hi]) => cp >= lo && cp <= hi);
        expect({ glyph, block: banned?.[2] ?? null }).toEqual({ glyph, block: null });
      }
    }
  });

  it('has no emoji where a text glyph belongs', () => {
    // U+270B is Wide AND emoji-presentation: it drew at emoji size mid-row.
    expect(every.join('')).not.toContain('\u270B');
  });
});

describe('pendingApprovalCount', () => {
  const prompt = (over: Partial<ApprovalItem>): ApprovalItem => ({
    id: 'bbb2:1',
    sessionId: 'bbb2',
    sessionName: 'w6-docs',
    kind: 'idle',
    createdAt: NOW - 30_000,
    ...over,
  });

  it('counts a prompt nobody has seen', () => {
    const model = fixture();
    model.setApprovals([prompt({})]);
    expect(pendingApprovalCount(model)).toBe(1);
  });

  it('does not count one whose alert is already spent', () => {
    // Both ways an item gets acknowledged: a human opening the session elsewhere, and the
    // inbox opening it that way for a session watching its own background work. The row
    // has left NEEDS YOU by the same flag, so a number in the header would point at a
    // group the reader can see is empty.
    const model = fixture();
    model.setApprovals([prompt({ acknowledgedAt: NOW - 20_000 })]);
    expect(pendingApprovalCount(model)).toBe(0);

    model.setApprovals([prompt({ acknowledgedAt: NOW - 20_000, acknowledgedReason: 'watching 1 monitor' })]);
    expect(pendingApprovalCount(model)).toBe(0);
  });
});
