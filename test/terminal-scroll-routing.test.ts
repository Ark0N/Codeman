/**
 * Issue #205, round 2: the 1.12.0 retest still reported unusable scrollback —
 * a completely dead wheel on Firefox/macOS (while Fn+Up paged back through
 * intact text), and history on iPhone that went back a little, repeated blocks
 * and got worse the further up it went.
 *
 * Both signatures come from a Claude pane's LOCAL buffer being hollow. tmux
 * keeps no history for a repaint-mode pane (`history_size≈0`), so:
 *   - any gesture routed to local scrollback scrolls nothing, and
 *   - the scroll-to-top `?full=1` re-pull replaces a multi-frame buffer with a
 *     single captured frame, deleting history mid-scroll.
 *
 * These cover the two guards that fix it: `_replayWouldShrinkBuffer` (refuse a
 * downgrading re-pull) and `_maybePageCliTranscript` (page the CLI's own
 * transcript when there is nothing local to scroll), plus the diagnostic that
 * makes the routing decision visible instead of guessable.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  const logs: string[] = [];
  const context = vm.createContext({
    window: {},
    CodemanApp,
    console: { warn: vi.fn(), log: (msg: string) => logs.push(msg) },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => 1_000 },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:yield', revokeObjectURL: () => {} },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => true },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });
  return { app: new (CodemanApp as any)(), logs };
}

/** A Claude session whose local buffer holds exactly one screen (baseY 0). */
function hollowClaudeApp(overrides: { cliVersion?: string; rows?: number } = {}) {
  const { app, logs } = loadTerminalUiHarness();
  const sent: Array<{ id: string; data: string }> = [];
  app.activeSessionId = 'sess-1';
  app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: overrides.cliVersion }]]);
  app._sendInputEphemeral = (id: string, data: string) => sent.push({ id, data });
  app.terminal = {
    cols: 80,
    rows: overrides.rows ?? 36,
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0, length: 36 } },
  };
  return { app, sent, logs };
}

describe('full-history re-pull downgrade guard (issue #205 round 2)', () => {
  it('estimates replayed rows from wrapped, escape-laden capture text', () => {
    const { app } = loadTerminalUiHarness();

    expect(app._estimateReplayRows('a\r\nb\r\nc', 80)).toBe(3);
    // SGR colour runs occupy no cells, so they must not inflate the estimate.
    expect(app._estimateReplayRows('\x1b[38;5;196mred\x1b[0m\r\nplain', 80)).toBe(2);
    // capture-pane -J joins wrapped rows, so a long logical line re-wraps on
    // write — counting newlines alone would undershoot by 2 rows here.
    expect(app._estimateReplayRows('x'.repeat(25), 10)).toBe(3);
    expect(app._estimateReplayRows('', 80)).toBe(0);
    expect(app._estimateReplayRows(undefined, 80)).toBe(0);
  });

  it('refuses a capture that would leave LESS history than the terminal holds', () => {
    const { app } = loadTerminalUiHarness();
    app.terminal = { cols: 80, rows: 36, buffer: { active: { length: 300 } } };

    // Claude pane: tmux has no history, so the capture is one frame while xterm
    // holds hundreds of replayed rows. Rewriting would delete them mid-scroll.
    const oneFrame = Array.from({ length: 36 }, (_, i) => `frame line ${i}`).join('\r\n');
    expect(app._replayWouldShrinkBuffer(oneFrame)).toBe(true);

    // Shell pane after a burst/tab-switch collapse: tmux really does hold more.
    const realHistory = Array.from({ length: 800 }, (_, i) => `history ${i}`).join('\r\n');
    expect(app._replayWouldShrinkBuffer(realHistory)).toBe(false);
  });

  it('tolerates a one-screen shortfall so ordinary recoveries still replay', () => {
    const { app } = loadTerminalUiHarness();
    // buffer.active.length counts the blank rows under the last line and the row
    // estimate can only approximate wrapping, so a near-tie must NOT read as a
    // downgrade — only a capture worse by more than a full screen does.
    app.terminal = { cols: 80, rows: 36, buffer: { active: { length: 120 } } };
    expect(app._replayWouldShrinkBuffer(Array.from({ length: 100 }, () => 'x').join('\r\n'))).toBe(false);
    expect(app._replayWouldShrinkBuffer(Array.from({ length: 40 }, () => 'x').join('\r\n'))).toBe(true);
  });

  it('never refuses when the terminal has no buffer to protect', () => {
    const { app } = loadTerminalUiHarness();
    app.terminal = { cols: 80, rows: 36, buffer: { active: { length: 0 } } };
    expect(app._replayWouldShrinkBuffer('anything')).toBe(false);
  });

  it('is wired into _maybeRefetchFullHistory BEFORE the destructive reset', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    // Anchor on the open paren, not the full empty signature: the method takes
    // options since #258 ({ force }) and this guard is about ORDER, not arity.
    const start = source.indexOf('async _maybeRefetchFullHistory(');
    // Also anchored on the open paren: the guard is handed the rows the caller
    // already estimated, and this test is about ORDER, not the argument list.
    const guard = source.indexOf('this._replayWouldShrinkBuffer(buffer', start);
    const boundedSkip = source.indexOf('boundedShellPull && windowRows <=', start);
    const reset = source.indexOf('this._resetTerminalForReplay()', start);

    expect(start).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(start);
    expect(guard).toBeLessThan(reset); // refuse first, only then reset+rewrite
    // A bounded shell window is skipped BEFORE the guard sees it: the guard reads
    // "smaller than the browser" as "tmux has nothing more", which a window cut at
    // the tail size does not mean (see shell-scroll-history-pull.test.ts).
    expect(boundedSkip).toBeGreaterThan(start);
    expect(boundedSkip).toBeLessThan(guard);
    // A hollow pane must also stop re-fetching megabytes on every scroll-up.
    expect(source).toContain('this._fullHistoryRepullUseless');
    expect(source).toContain('this._fullHistoryRepullUseless?.has(sessionId) ? 60000 : 4000');
  });
});

describe('PageUp/PageDown fallback for a hollow local buffer (issue #205 round 2)', () => {
  it('pages the CLI transcript when the wheel gate is false and there is no scrollback', () => {
    const { app, sent } = hollowClaudeApp(); // cliVersion unknown → gate false

    // Half a screen of travel (rows 36 → 18 lines) buys exactly one PageUp.
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);

    // Downward travel pages back toward the live screen.
    app._maybePageCliTranscript({ shiftKey: false }, 18);
    app._flushWheelSgrQueue();
    expect(sent[1]).toEqual({ id: 'sess-1', data: '\x1b[6~' });
  });

  it('accumulates sub-page travel instead of dropping or over-sending it', () => {
    const { app, sent } = hollowClaudeApp();

    expect(app._maybePageCliTranscript({ shiftKey: false }, -10)).toBe(true); // consumed…
    app._flushWheelSgrQueue();
    expect(sent).toEqual([]); // …but below the threshold, so nothing sent yet

    app._maybePageCliTranscript({ shiftKey: false }, -8); // -18 total → one page
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);
  });

  it('caps the keys one gesture batch can emit', () => {
    const { app, sent } = hollowClaudeApp();

    app._maybePageCliTranscript({ shiftKey: false }, -1000); // 55 pages of travel
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~'.repeat(3) }]);
  });

  it('leaves every session that has real local scrollback alone', () => {
    const { app } = hollowClaudeApp();

    // Shift is the explicit "give me local scrollback" gesture — never paged.
    expect(app._maybePageCliTranscript({ shiftKey: true }, -18)).toBe(false);

    // A buffer with history scrolls locally, as before.
    app.terminal.buffer.active.baseY = 120;
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);
    app.terminal.buffer.active.baseY = 0;

    // Non-Claude modes keep their existing behavior (shell scrolls tmux history
    // through the alt-screen strip; codex/gemini page keys are unverified).
    app.sessions = new Map([['sess-1', { mode: 'shell' }]]);
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);
    app.sessions = new Map([['sess-1', { mode: 'codex' }]]);
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);

    // An alternate-screen pane belongs to xterm's own alt-scroll handling.
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal.buffer.active.type = 'alternate';
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);
  });

  it('rescues the local-scrollback opt-out footgun instead of silently dying', () => {
    // "Wheel scrolls local history" ON pins the wheel to a buffer that, for a
    // repaint-mode CLI, is empty — a user who flipped it while hunting for a fix
    // on 1.11.x would have ended up with a completely dead wheel on 1.12.0.
    const { app, sent } = hollowClaudeApp({ cliVersion: '2.1.223' }); // gate would forward…
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: true });

    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false); // …but the opt-out wins
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);
  });

  it('drops travel accumulated on another tab', () => {
    const { app, sent } = hollowClaudeApp();

    app._maybePageCliTranscript({ shiftKey: false }, -17); // just short of a page
    app.activeSessionId = 'sess-2';
    app.sessions.set('sess-2', { mode: 'claude' });
    app._maybePageCliTranscript({ shiftKey: false }, -1); // must not complete sess-1's page
    app._flushWheelSgrQueue();
    expect(sent).toEqual([]);
  });

  it('is reachable from both the wheel and the touch paths', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    // Wheel: after the forwarding gate, before the local smooth scroll.
    expect(source).toContain('if (this._maybePageCliTranscript(ev, lines)) return;');
    // Touch: touchmove and the momentum loop both fall through to it.
    expect(source.match(/else if \(!this\._maybePageCliTranscript\(\{ shiftKey: false \}, lines\)\)/g)).toHaveLength(2);
  });
});

describe('scroll routing diagnostic (issue #205 round 2)', () => {
  it('prints the decision and its inputs once per session, and again when it changes', () => {
    const { app, logs } = hollowClaudeApp({ cliVersion: '2.1.100' });
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: false });

    app._logScrollRouting('local-scrollback');
    app._logScrollRouting('local-scrollback'); // same decision → stays quiet
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('sess-1 → local-scrollback');
    expect(logs[0]).toContain('mode=claude');
    expect(logs[0]).toContain('cliVersion=2.1.100');
    expect(logs[0]).toContain('localScrollbackOptOut=false');
    expect(logs[0]).toContain('mouseTracking=none');

    app._logScrollRouting('page-keys'); // a changed route still prints
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('page-keys');
  });

  it('reports an unknown CLI version, the false-path that disables forwarding', () => {
    const { app, logs } = hollowClaudeApp(); // no cliVersion — the probe failed
    app._logScrollRouting('page-keys');
    expect(logs[0]).toContain('cliVersion=unknown');
  });
});
