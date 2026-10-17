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
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

/**
 * The run modes whose CLI can page its own transcript with PageUp/PageDown, read
 * off the shipped registry exactly as the server builds `__codemanTranscriptPageKeys`,
 * so these tests break if a stock entry loses (or quietly gains) the capability.
 */
const PAGE_KEY_MODES = STOCK_CLIS.filter((e) => e.capabilities.transcriptPageKeys === true).map((e) => e.id);

function loadTerminalUiHarness(
  windowGlobals: Record<string, unknown> = { __codemanTranscriptPageKeys: PAGE_KEY_MODES }
) {
  const CodemanApp = function CodemanApp(this: any) {};
  const logs: string[] = [];
  // terminal-ui.js hangs CodemanTerminalInput off window; tests read it there.
  const windowRef: Record<string, any> = { ...windowGlobals };
  // Mutable so a test can move time (gesture gaps); defaults to a frozen clock.
  const clock = { now: () => 1_000 };
  const context = vm.createContext({
    window: windowRef,
    CodemanApp,
    console: { warn: vi.fn(), log: (msg: string) => logs.push(msg) },
    _crashDiag: { log: vi.fn() },
    performance: clock,
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:yield', revokeObjectURL: () => {} },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => true },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    OSC52_STRIP_RE: /\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });
  return { app: new (CodemanApp as any)(), logs, windowRef, clock };
}

/** A session whose local buffer holds exactly one screen (baseY 0) — a hollow pane. */
function hollowApp(overrides: { mode?: string; cliVersion?: string; rows?: number; cliMouseTracking?: boolean } = {}) {
  const { app, logs, windowRef, clock } = loadTerminalUiHarness();
  const sent: Array<{ id: string; data: string }> = [];
  app.activeSessionId = 'sess-1';
  app.sessions = new Map([
    [
      'sess-1',
      {
        mode: overrides.mode ?? 'claude',
        cliVersion: overrides.cliVersion,
        cliMouseTracking: overrides.cliMouseTracking,
      },
    ],
  ]);
  app._sendInputEphemeral = (id: string, data: string) => sent.push({ id, data });
  app.terminal = {
    cols: 80,
    rows: overrides.rows ?? 36,
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0, length: 36 } },
  };
  return { app, sent, logs, windowRef, clock };
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
    const boundedSkip = source.indexOf('boundedShellPull && (windowRows <= rowsNow || browserFull)', start);
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
    const { app, sent } = hollowApp(); // cliVersion unknown → gate false

    // Half a screen of travel (rows 36 → 18 lines) buys exactly one PageUp.
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);

    // Downward travel pages back toward the live screen.
    app._maybePageCliTranscript({ shiftKey: false }, 18);
    app._flushWheelSgrQueue();
    expect(sent[1]).toEqual({ id: 'sess-1', data: '\x1b[6~' });
  });

  it('answers the first event of a gesture at once and owes the travel back', () => {
    const { app, sent } = hollowApp();

    // A trackpad flick opens with a small delta and stays far short of half a
    // screen (18 rows here). It used to send nothing at all, so a session that
    // always lands here looked dead.
    expect(app._maybePageCliTranscript({ shiftKey: false }, -1)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);

    // The pre-paid page is owed back: the rest of this page's travel sends nothing…
    app._maybePageCliTranscript({ shiftKey: false }, -17);
    app._flushWheelSgrQueue();
    expect(sent).toHaveLength(1);

    // …and the next page arrives after a further half screen, so the rate is unchanged.
    app._maybePageCliTranscript({ shiftKey: false }, -17);
    app._flushWheelSgrQueue();
    expect(sent).toHaveLength(1);
    app._maybePageCliTranscript({ shiftKey: false }, -1);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([
      { id: 'sess-1', data: '\x1b[5~' },
      { id: 'sess-1', data: '\x1b[5~' },
    ]);
  });

  it('starts a new gesture after a pause or a direction change', () => {
    const { app, sent, clock } = hollowApp();
    let now = 1_000;
    clock.now = () => now;

    app._maybePageCliTranscript({ shiftKey: false }, -1); // first event: one PageUp
    app._maybePageCliTranscript({ shiftKey: false }, 1); // reversal inside the gap: accumulates, no page
    now += 200;
    app._maybePageCliTranscript({ shiftKey: false }, -1); // a reversal after the gap: a PageUp at once
    now += 1_100;
    app._maybePageCliTranscript({ shiftKey: false }, 1); // after a pause: a PageDown at once
    app._maybePageCliTranscript({ shiftKey: false }, 0.05); // sub-row jitter in the same gesture: nothing
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~\x1b[5~\x1b[6~' }]);
  });

  it('lets wheel notches accumulate instead of paging a full screen on each one', () => {
    // A 100 px notch is 4 rows. Only a trackpad-sized opening event (under 2 rows)
    // pages at once; a notch adds up toward half a screen as it always did, so
    // slow notches (each one its own gesture by the 150 ms gap) still page once
    // per 18 rows here, not once per notch.
    for (const gapMs of [250, 40]) {
      const { app, sent, clock } = hollowApp();
      let now = 1_000;
      clock.now = () => now;
      for (let i = 0; i < 5; i++) {
        expect(app._maybePageCliTranscript({ shiftKey: false, deltaY: -100 }, -4)).toBe(true);
        now += gapMs;
      }
      app._flushWheelSgrQueue();
      expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);
    }
  });

  it('consumes a mostly horizontal swipe without paging', () => {
    const { app, sent } = hollowApp();

    // A sideways trackpad swipe carries a little vertical drift (3 px is 0.12 rows,
    // above the jitter floor). It must not page the transcript.
    for (let i = 0; i < 6; i++) {
      expect(app._maybePageCliTranscript({ shiftKey: false, deltaX: 60, deltaY: 3 }, 0.12)).toBe(true);
    }
    app._flushWheelSgrQueue();
    expect(sent).toEqual([]);

    // A mostly vertical swipe with some sideways drift still pages.
    app._maybePageCliTranscript({ shiftKey: false, deltaX: 3, deltaY: -25 }, -1);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);
  });

  it('consumes a trackpad pinch without paging', () => {
    const { app, sent } = hollowApp();

    // Chrome reports a pinch as wheel events with ctrlKey set.
    for (let i = 0; i < 4; i++) {
      expect(app._maybePageCliTranscript({ shiftKey: false, ctrlKey: true, deltaY: 4 }, 0.16)).toBe(true);
    }
    app._flushWheelSgrQueue();
    expect(sent).toEqual([]);
  });

  it('does not page while the session is showing a dialog', () => {
    const { app, sent } = hollowApp();
    // 'action' is set while a permission_prompt or elicitation_dialog is pending
    // (updateTabAlertFromHooks in app.js). Page keys must not reach that selector.
    app.tabAlerts = new Map([['sess-1', 'action']]);

    expect(app._maybePageCliTranscript({ shiftKey: false }, -1)).toBe(true);
    expect(app._maybePageCliTranscript({ shiftKey: false }, -40)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([]);

    // Once the dialog is answered (an idle alert, or none) paging resumes.
    app.tabAlerts.set('sess-1', 'idle');
    app._maybePageCliTranscript({ shiftKey: false }, 1);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[6~' }]);
  });

  it("reads the ACTIVE session's dialog, not some other tab's", () => {
    const { app, sent } = hollowApp();
    // A tile or a background tab with a pending prompt does not block this pane.
    app.tabAlerts = new Map([['tile-1', 'action']]);

    app._maybePageCliTranscript({ shiftKey: false }, -1);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);
  });

  it('does not page on sub-row jitter that opens a gesture', () => {
    const { app, sent } = hollowApp();

    expect(app._maybePageCliTranscript({ shiftKey: false }, -0.05)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([]);
  });

  it('caps the keys one gesture batch can emit', () => {
    const { app, sent } = hollowApp();

    app._maybePageCliTranscript({ shiftKey: false }, -1000); // 55 pages of travel
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~'.repeat(3) }]);
  });

  it('pages a Copilot pane when the tracking flag is stale, so the wheel never goes dead', () => {
    // Copilot pages its own transcript on PageUp/PageDown (three PageUp moved lines 109-140 to
    // 010-042 against a 140-line answer in tmux, and PageDown returned). While it tracks the mouse
    // the wheel is forwarded as SGR reports; with the flag stale (a server restart) this is the
    // gesture's fallback, on an alternate-screen TUI whose local buffer is one screen.
    const { app, sent } = hollowApp({ mode: 'copilot', cliMouseTracking: false });

    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);

    app._maybePageCliTranscript({ shiftKey: false }, 18);
    app._flushWheelSgrQueue();
    expect(sent[1]).toEqual({ id: 'sess-1', data: '\x1b[6~' });
  });

  it('does not page a Copilot pane that has real local scrollback', () => {
    const { app, sent } = hollowApp({ mode: 'copilot' });
    app.terminal.buffer.active.baseY = 200;
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([]);
  });

  it('pages an OpenCode pane too, whose TUI never fills the local buffer', () => {
    // OpenCode's TUI runs on the ALTERNATE SCREEN (measured on 1.18.31: tmux
    // `alternate_on=1`, `history_size=0`), so the browser's normal buffer stays at
    // one screen exactly like a repaint-mode Claude pane. The difference is that
    // OpenCode IGNORES SGR wheel reports (verified against an idle pane: six
    // `\x1b[<64;…M` reports left the capture byte-identical), so PageUp/PageDown
    // — its `messages_page_up/down` binds — is the ONLY gesture that reaches its
    // transcript. Without this the wheel was silently dead in every OpenCode tab.
    const { app, sent } = hollowApp({ mode: 'opencode' });

    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);

    app._maybePageCliTranscript({ shiftKey: false }, 18);
    app._flushWheelSgrQueue();
    expect(sent[1]).toEqual({ id: 'sess-1', data: '\x1b[6~' });
  });

  it('leaves every session that has real local scrollback alone', () => {
    const { app } = hollowApp();

    // Shift is the explicit "give me local scrollback" gesture — never paged.
    expect(app._maybePageCliTranscript({ shiftKey: true }, -18)).toBe(false);

    // A buffer with history scrolls locally, as before.
    app.terminal.buffer.active.baseY = 120;
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);
    app.terminal.buffer.active.baseY = 0;

    // Modes whose CLI does not declare transcriptPageKeys keep their existing
    // behavior (shell/pi own tmux history through the alt-screen strip;
    // gemini/antigravity/… page-key behaviour is unverified — docs/scrollback-fix-plan.md).
    app.sessions = new Map([['sess-1', { mode: 'shell' }]]);
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);
    app.sessions = new Map([['sess-1', { mode: 'gemini' }]]);
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);
    app.sessions = new Map([['sess-1', { mode: 'antigravity' }]]);
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);

    // An alternate-screen pane belongs to xterm's own alt-scroll handling.
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal.buffer.active.type = 'alternate';
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(false);
  });

  it('pages a Codex transcript only while its local scrollback is empty', () => {
    // Codex is never sent SGR wheel reports (it ignores them); this is the
    // separate PageUp/PageDown fallback, which codex does honour.
    const { app, sent } = hollowApp();
    app.sessions = new Map([['sess-1', { mode: 'codex' }]]);

    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);

    app.terminal.buffer.active.baseY = 40;
    expect(app._maybePageCliTranscript({ shiftKey: false }, 18)).toBe(false);
    expect(app._maybePageCliTranscript({ shiftKey: true }, 18)).toBe(false);
  });

  it('reads the paging modes from the injected capability map, never an id list of its own', () => {
    // No map (a page rendered without it) means no mode pages, the same fail-safe
    // direction the transcript-gutter map takes.
    const bare = loadTerminalUiHarness({}).app;
    bare.activeSessionId = 'sess-1';
    bare.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    bare.terminal = { rows: 36, buffer: { active: { type: 'normal', baseY: 0 } } };
    expect(bare._localScrollbackIsHollow()).toBe(false);

    // A mode the map names pages even if no stock entry has that id.
    const custom = loadTerminalUiHarness({ __codemanTranscriptPageKeys: ['my-cli'] }).app;
    custom.activeSessionId = 'sess-1';
    custom.sessions = new Map([['sess-1', { mode: 'my-cli' }]]);
    custom.terminal = { rows: 36, buffer: { active: { type: 'normal', baseY: 0 } } };
    expect(custom._localScrollbackIsHollow()).toBe(true);

    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    const helper = source.slice(
      source.indexOf('  _localScrollbackIsHollow(target = {}) {'),
      source.indexOf('  _maybePageCliTranscript(ev, lines) {')
    );
    expect(helper).toContain('window.__codemanTranscriptPageKeys');
    expect(helper).not.toMatch(/=== '(?:claude|codex)'|!== '(?:claude|codex)'/);
  });

  it('rescues the local-scrollback opt-out footgun instead of silently dying', () => {
    // "Wheel scrolls local history" ON pins the wheel to a buffer that, for a
    // repaint-mode CLI, is empty — a user who flipped it while hunting for a fix
    // on 1.11.x would have ended up with a completely dead wheel on 1.12.0.
    // Version and tracking both qualify, so the opt-out is the only thing saying no.
    const { app, sent } = hollowApp({ cliVersion: '2.1.223', cliMouseTracking: true }); // gate would forward…
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: true });

    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false); // …but the opt-out wins
    expect(app._maybePageCliTranscript({ shiftKey: false }, -18)).toBe(true);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[5~' }]);
  });

  it('drops travel accumulated on another tab', () => {
    const { app, sent } = hollowApp();

    app._maybePageCliTranscript({ shiftKey: false }, -1); // first event pages sess-1 at once
    app._maybePageCliTranscript({ shiftKey: false }, -34); // just short of sess-1's second page
    app._flushWheelSgrQueue();
    app.activeSessionId = 'sess-2';
    app.sessions.set('sess-2', { mode: 'claude' });
    app._maybePageCliTranscript({ shiftKey: false }, -1); // a NEW gesture on sess-2, never sess-1's page
    app._flushWheelSgrQueue();
    expect(sent).toEqual([
      { id: 'sess-1', data: '\x1b[5~' },
      { id: 'sess-2', data: '\x1b[5~' },
    ]);
  });

  it('is reachable from both the wheel and the touch paths', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    // Wheel: after the forwarding gate, before the local smooth scroll.
    expect(source).toContain('if (this._maybePageCliTranscript(ev, lines)) return;');
    // Touch: touchmove and the momentum loop both fall through to it.
    expect(
      source.match(
        /else if \(!this\._maybePageCliTranscript\(\{ shiftKey: false, touchId: touchContactId \}, lines\)\)/g
      )
    ).toHaveLength(2);
    // ...and every contact gets its own id at touchstart, so a contact is one gesture.
    expect(source).toContain('touchContactId++;');
  });
});

describe('page-key gestures across slow touch drags, slow wheel ticks and jitter (#527 review)', () => {
  const UP = '\x1b[5~';
  const DOWN = '\x1b[6~';

  /** A hollow 38-row pane (19 rows a page) on a hand-moved clock, with every key sent. */
  function pane(mode = 'codex') {
    const h = hollowApp({ mode, rows: 38 });
    let now = 10_000;
    h.clock.now = () => now;
    const keys = () => {
      h.app._flushWheelSgrQueue();
      return h.sent.map((s) => s.data).join('');
    };
    return { ...h, keys, advance: (ms: number) => (now += ms) };
  }
  const count = (keys: string, key: string) => keys.split(key).length - 1;

  it('keeps one touch contact one gesture, however slowly the finger moves', () => {
    const p = pane();
    // touchmove calls once per whole cell, so a slow drag arrives as single lines
    // 170 ms apart, each past the 150 ms gesture gap. It sent one PageUp per line.
    for (let i = 0; i < 12; i++) {
      expect(p.app._maybePageCliTranscript({ shiftKey: false, touchId: 1 }, -1)).toBe(true);
      p.advance(170);
    }
    expect(p.keys()).toBe(UP);

    // A new contact is a new gesture: its first line pages at once.
    p.app._maybePageCliTranscript({ shiftKey: false, touchId: 2 }, -1);
    expect(p.keys()).toBe(UP + UP);
  });

  it('pages a slow 40-line drag twice, and keeps momentum in the same gesture', () => {
    const p = pane();
    for (let i = 0; i < 40; i++) {
      p.app._maybePageCliTranscript({ shiftKey: false, touchId: 7 }, -1);
      p.advance(170);
    }
    // 1 at once, then 18 owed back, then 19 more: two pages by line 38.
    expect(count(p.keys(), UP)).toBe(2);

    // Momentum frames after the finger lifts carry the same contact: they
    // continue the drag's travel instead of opening a gesture of their own.
    for (let i = 0; i < 10; i++) {
      p.app._maybePageCliTranscript({ shiftKey: false, touchId: 7 }, -1);
      p.advance(16);
    }
    expect(count(p.keys(), UP)).toBe(2);
  });

  it('never splits a contact on a pause, but does not carry its debt into the next contact', () => {
    const p = pane();
    p.app._maybePageCliTranscript({ shiftKey: false, touchId: 3 }, -1); // pages, owes 18
    p.advance(5_000); // the finger rests, still down
    p.app._maybePageCliTranscript({ shiftKey: false, touchId: 3 }, -1);
    expect(p.keys()).toBe(UP);
    p.advance(10);
    p.app._maybePageCliTranscript({ shiftKey: false, touchId: 4 }, -1); // a new contact pages at once
    expect(p.keys()).toBe(UP + UP);
  });

  it('pages slow small wheel ticks once per half screen, not once per tick', () => {
    // Five 40 px ticks 250 ms apart (1.6 rows each, under the 2-row trackpad
    // size) used to page once per tick. The first one still pages at once.
    const p = pane();
    for (let i = 0; i < 5; i++) {
      p.app._maybePageCliTranscript({ shiftKey: false, deltaY: -40, deltaMode: 0 }, -1.6);
      p.advance(250);
    }
    expect(p.keys()).toBe(UP);

    // Firefox reports a notch as 1 line (deltaMode 1): the same.
    const f = pane();
    for (let i = 0; i < 5; i++) {
      f.app._maybePageCliTranscript({ shiftKey: false, deltaY: -1, deltaMode: 1 }, -1);
      f.advance(250);
    }
    expect(f.keys()).toBe(UP);
  });

  it('lets a pre-paid debt lapse after a second of quiet, so the next tick pages at once again', () => {
    const p = pane();
    p.app._maybePageCliTranscript({ shiftKey: false, deltaY: -40 }, -1.6);
    p.advance(900);
    p.app._maybePageCliTranscript({ shiftKey: false, deltaY: -40 }, -1.6); // inside the second: owed
    expect(p.keys()).toBe(UP);
    p.advance(1_100);
    p.app._maybePageCliTranscript({ shiftKey: false, deltaY: -40 }, -1.6); // debt lapsed: pages
    expect(p.keys()).toBe(UP + UP);
  });

  it('does not page back and forth on a +/-3 px trackpad wobble', () => {
    const p = pane();
    for (let i = 0; i < 20; i++) {
      const dy = i % 2 ? 3 : -3;
      p.app._maybePageCliTranscript({ shiftKey: false, deltaY: dy }, dy / 25);
      p.advance(16);
    }
    // The opening event is a fresh gesture and pages; no reversal inside the
    // gap pre-pays, so the wobble sends nothing after it.
    expect(p.keys()).toBe(UP);
  });

  it('still pages a deliberate reversal at once after a pause', () => {
    const p = pane();
    p.app._maybePageCliTranscript({ shiftKey: false, deltaY: -25 }, -1);
    p.advance(200);
    p.app._maybePageCliTranscript({ shiftKey: false, deltaY: 25 }, 1);
    expect(p.keys()).toBe(UP + DOWN);
  });

  it('does not let a reversal inherit the other direction’s debt', () => {
    const p = pane();
    p.app._maybePageCliTranscript({ shiftKey: false, deltaY: -25 }, -1); // UP, owes 18 upward
    p.advance(16);
    // Downward travel just short of a page: the upward debt must not count toward it.
    p.app._maybePageCliTranscript({ shiftKey: false, deltaY: 25 * 18 }, 18);
    expect(p.keys()).toBe(UP);
    p.advance(16);
    p.app._maybePageCliTranscript({ shiftKey: false, deltaY: 25 }, 1);
    expect(p.keys()).toBe(UP + DOWN);
  });

  it('ends the one-second debt lifetime once the debt is repaid, exactly or overpaid', () => {
    // 38 rows: 19 a page. The opening -1 pre-pays and owes 18; 18 more lines at
    // 32 ms repay it EXACTLY. Nothing is owed any more, so the 150 ms gap applies
    // again and a -1 300 ms later is a new gesture that pages at once.
    const exact = pane();
    for (let i = 0; i < 19; i++) {
      exact.app._maybePageCliTranscript({ shiftKey: false }, -1);
      exact.advance(32);
    }
    expect(exact.keys()).toBe(UP);
    expect(exact.app._pageKeyGesture).toMatchObject({ pending: 0, prepaid: false });
    exact.advance(300 - 32);
    exact.app._maybePageCliTranscript({ shiftKey: false }, -1);
    expect(exact.keys()).toBe(UP + UP);

    // Overpaid: 19 lines after the opening one leave 1 row of plain travel.
    const over = pane();
    for (let i = 0; i < 20; i++) {
      over.app._maybePageCliTranscript({ shiftKey: false }, -1);
      over.advance(32);
    }
    expect(over.keys()).toBe(UP);
    expect(over.app._pageKeyGesture).toMatchObject({ pending: -1, prepaid: false });
    over.advance(300 - 32);
    over.app._maybePageCliTranscript({ shiftKey: false }, -1);
    expect(over.keys()).toBe(UP + UP);

    // One line short of repaid: still owed, so 300 ms later is the same gesture.
    const owed = pane();
    for (let i = 0; i < 18; i++) {
      owed.app._maybePageCliTranscript({ shiftKey: false }, -1);
      owed.advance(32);
    }
    expect(owed.app._pageKeyGesture).toMatchObject({ pending: 1, prepaid: true });
    owed.advance(300 - 32);
    owed.app._maybePageCliTranscript({ shiftKey: false }, -1);
    expect(owed.keys()).toBe(UP);
  });

  it('keeps a touch contact one gesture after its debt is repaid', () => {
    const p = pane();
    for (let i = 0; i < 19; i++) {
      p.app._maybePageCliTranscript({ shiftKey: false, touchId: 5 }, -1);
      p.advance(32);
    }
    p.advance(2_000); // the finger rests, still down
    p.app._maybePageCliTranscript({ shiftKey: false, touchId: 5 }, -1);
    expect(p.keys()).toBe(UP); // accumulates; no fresh pre-pay inside the contact
  });

  it('logs a wheel the dialog check consumed', () => {
    const p = pane();
    p.app.tabAlerts = new Map([['sess-1', 'action']]);
    expect(p.app._maybePageCliTranscript({ shiftKey: false }, -1)).toBe(true);
    expect(p.keys()).toBe('');
    expect(p.logs.some((line) => line.includes('[scroll] sess-1 → page-keys-dialog-open'))).toBe(true);
  });
});

describe('pageKeysForGesture, the pure gesture rules both panes share', () => {
  const UP = '\x1b[5~';
  const DOWN = '\x1b[6~';
  const helper = () => loadTerminalUiHarness().windowRef.CodemanTerminalInput.pageKeysForGesture;
  type Step = { state: unknown; keys: string };
  /** Runs [lines, msSinceStart, extra] events through the helper; returns every step. */
  function run(events: Array<[number, number, Record<string, unknown>?]>, rows = 36) {
    const pageKeysForGesture = helper();
    let state: unknown = null;
    return events.map(([lines, at, extra]) => {
      const step: Step = pageKeysForGesture(state, { shiftKey: false, ...extra }, lines, rows, 10_000 + at);
      state = step.state;
      return step;
    });
  }

  it('pages a trackpad-sized opening event at once and owes the half screen back', () => {
    const steps = run([
      [-1, 0],
      [-16, 10],
      [-18, 20],
      [-1, 30],
    ]);
    expect(steps.map((s) => s.keys)).toEqual([UP, '', '', UP]);
  });

  it('accumulates a notch-sized opening event, and carries plain travel across notches', () => {
    // Five 4-row notches 400 ms apart: each is a new gesture, none pages alone.
    const steps = run([
      [-4, 0],
      [-4, 400],
      [-4, 800],
      [-4, 1200],
      [-4, 1600],
    ]);
    expect(steps.map((s) => s.keys).join('')).toBe(UP);
  });

  it('keeps a same-direction pre-paid debt for PAGE_KEY_DEBT_MS, then drops it with its gesture', () => {
    const { PAGE_KEY_DEBT_MS } = loadTerminalUiHarness().windowRef.CodemanTerminalInput;
    expect(PAGE_KEY_DEBT_MS).toBe(1000);
    // A tick 500 ms later, past the 150 ms gap, pays the debt back instead of
    // pre-paying a second page; a flick after a second of quiet pages at once.
    const steps = run([
      [-1, 0],
      [-1, 500],
      [-1, 1600],
    ]);
    expect(steps.map((s) => s.keys)).toEqual([UP, '', UP]);
  });

  it('pre-pays a reversal only after the gap, and ignores sub-row jitter', () => {
    const steps = run([
      [-1, 0],
      [1, 10], // reversal inside the gap: accumulates, no page
      [-1, 20], // and back: still nothing
      [1, 300], // a reversal after the gap is a new gesture: pages at once
      [0.05, 310],
      [-0.05, 1500],
    ]);
    expect(steps.map((s) => s.keys)).toEqual([UP, '', '', DOWN, '', '']);
  });

  it('treats one touch contact as one gesture, and a new contact as a new one', () => {
    const steps = run([
      [-1, 0, { touchId: 1 }],
      [-1, 5_000, { touchId: 1 }], // same contact, any pause: owed
      [1, 5_010, { touchId: 1 }], // a reversal within the contact never pre-pays
      [-1, 5_020, { touchId: 2 }], // a new contact pages at once
      [-1, 5_030], // a wheel event is not that contact: a new gesture
    ]);
    expect(steps.map((s) => s.keys)).toEqual([UP, '', '', UP, UP]);
  });

  it('sends nothing for a pinch or a mostly horizontal swipe, and leaves the state as it was', () => {
    const pageKeysForGesture = helper();
    const state = { pending: -7, lastAt: 9_990, dir: -1, prepaid: false };
    const pinch = pageKeysForGesture(state, { ctrlKey: true, deltaY: -900 }, -36, 36, 10_000);
    const swipe = pageKeysForGesture(state, { deltaX: -1000, deltaY: -900 }, -36, 36, 10_000);
    expect(pinch).toEqual({ state, keys: '' });
    expect(swipe).toEqual({ state, keys: '' });
    // A mostly VERTICAL swipe with some sideways drift still pages.
    expect(pageKeysForGesture(state, { deltaX: -100, deltaY: -900 }, -36, 36, 10_000).keys).toBe(UP.repeat(2));
  });

  it('caps a fling at PAGE_KEY_MAX_PER_BATCH keys', () => {
    expect(run([[-1000, 0]])[0].keys).toBe(UP.repeat(3));
  });
});

describe('GitHub Copilot wheel forwarding', () => {
  // Copilot's mouse DECSETs are stripped so a drag selects locally, which stops xterm from
  // encoding the wheel for it; the gate must therefore forward by hand, but only while tracking.
  it('forwards the wheel while the CLI tracks the mouse, with no version gate', () => {
    const { app } = hollowApp({ mode: 'copilot', cliMouseTracking: true });
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
  });

  it('keeps Shift+wheel on local scrollback and falls back to paging when not tracking', () => {
    const tracking = hollowApp({ mode: 'copilot', cliMouseTracking: true });
    expect(tracking.app._shouldForwardWheelToApp({ shiftKey: true })).toBe(false);
    const idle = hollowApp({ mode: 'copilot', cliMouseTracking: false });
    expect(idle.app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
  });

  it('does not change what other non-claude modes do', () => {
    for (const mode of ['codex', 'opencode', 'grok', 'gemini']) {
      const { app } = hollowApp({ mode, cliMouseTracking: true });
      expect(app._shouldForwardWheelToApp({ shiftKey: false }), mode).toBe(false);
    }
  });
});

describe('the paging gates asked for another pane (a TerminalTile)', () => {
  it('exports the paging math, and the primary pane runs on it', () => {
    const { app, sent, windowRef } = hollowApp();
    const { wheelDeltaLines, pageKeysForTravel, pageKeysForGesture } = windowRef.CodemanTerminalInput;

    expect(wheelDeltaLines({ deltaY: -50, deltaMode: 0 }, 36)).toBe(-2); // pixels, 25 a line
    expect(wheelDeltaLines({ deltaY: 3, deltaMode: 1 }, 36)).toBe(3); // lines (Firefox)
    expect(wheelDeltaLines({ deltaY: 1, deltaMode: 2 }, 36)).toBe(36); // pages: the given rows
    expect(wheelDeltaLines({ deltaY: 0, deltaX: -75, shiftKey: true, deltaMode: 0 }, 36)).toBe(-3); // Shift axis
    expect(pageKeysForTravel(0, -10, 36)).toEqual({ pending: -10, keys: '' });
    expect(pageKeysForTravel(-10, -8, 36)).toEqual({ pending: 0, keys: '\x1b[5~' });
    expect(pageKeysForTravel(0, -1000, 36).keys).toBe('\x1b[5~'.repeat(3));
    expect(pageKeysForTravel(0, 40, 36)).toEqual({ pending: 4, keys: '\x1b[6~'.repeat(2) });

    // The primary pane's own methods agree with them.
    const ev = { deltaY: -250, deltaMode: 2 };
    expect(app._wheelScrollLinesFloat(ev)).toBe(wheelDeltaLines(ev, 36));
    let state: unknown = null;
    let expected = '';
    // Mixed: a trackpad opening, a notch-sized opening, a reversal, a pinch and
    // a sideways swipe, all under a frozen clock (one gesture per direction).
    const steps: Array<[number, Record<string, unknown>]> = [
      [-1, {}],
      [-10, {}],
      [-30, {}],
      [25, {}], // a reversal inside the gap pages by travel (net of the -5 plain travel left), not at once
      [-5, { ctrlKey: true }],
      [-5, { deltaX: 400, deltaY: -125 }],
      [-1000, {}],
      [-7, {}],
    ];
    for (const [lines, extra] of steps) {
      const event = { shiftKey: false, ...extra };
      const step = pageKeysForGesture(state, event, lines, 36, 1_000);
      state = step.state;
      expected += step.keys;
      app._maybePageCliTranscript(event, lines);
    }
    app._flushWheelSgrQueue();
    expect(app._pageKeyGesture).toEqual(state);
    expect(expected).toContain('\x1b[5~');
    expect(expected).toContain('\x1b[6~');
    expect(sent).toEqual([{ id: 'sess-1', data: expected }]);
  });

  it("_localScrollbackIsHollow reads the target's session, buffer and rows, never the active ones", () => {
    const { app } = hollowApp({ mode: 'shell' }); // the ACTIVE session is a shell
    app.sessions.set('tile-1', { mode: 'opencode' });
    const tileBuffer = { type: 'normal', viewportY: 16, baseY: 16 };
    const tileTerminal = { rows: 24, buffer: { active: tileBuffer } };

    expect(app._localScrollbackIsHollow()).toBe(false); // the primary's own answer
    // 16 rows above the tile's screen, all of them its own overflow: hollow.
    expect(app._localScrollbackIsHollow({ sessionId: 'tile-1', terminal: tileTerminal, localRows: 0 })).toBe(true);
    // Real history in the tile: not hollow, whatever the primary holds.
    expect(app._localScrollbackIsHollow({ sessionId: 'tile-1', terminal: tileTerminal, localRows: 3 })).toBe(false);
    // No localRows: the tile's own baseY decides.
    expect(app._localScrollbackIsHollow({ sessionId: 'tile-1', terminal: tileTerminal })).toBe(false);
    tileBuffer.type = 'alternate';
    expect(app._localScrollbackIsHollow({ sessionId: 'tile-1', terminal: tileTerminal, localRows: 0 })).toBe(false);
    tileBuffer.type = 'normal';
    app.sessions.set('tile-1', { mode: 'gemini' });
    expect(app._localScrollbackIsHollow({ sessionId: 'tile-1', terminal: tileTerminal, localRows: 0 })).toBe(false);
  });

  it("_shouldForwardWheelToApp reads the target's session and the target terminal's tracking mode", () => {
    const { app } = hollowApp({ mode: 'opencode' }); // the ACTIVE session would never forward
    app.sessions.set('tile-1', { mode: 'claude', cliVersion: '2.1.223', cliMouseTracking: true });
    const tileTerminal = { rows: 24, modes: { mouseTrackingMode: 'none' } };

    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    expect(app._shouldForwardWheelToApp({ shiftKey: false }, { sessionId: 'tile-1', terminal: tileTerminal })).toBe(
      true
    );
    // The tile's own xterm encoder owns the wheel while its tracking is on.
    tileTerminal.modes.mouseTrackingMode = 'any';
    expect(app._shouldForwardWheelToApp({ shiftKey: false }, { sessionId: 'tile-1', terminal: tileTerminal })).toBe(
      false
    );
    // And the primary's tracking mode does not leak into the tile's answer.
    tileTerminal.modes.mouseTrackingMode = 'none';
    app.terminal.modes.mouseTrackingMode = 'any';
    expect(app._shouldForwardWheelToApp({ shiftKey: false }, { sessionId: 'tile-1', terminal: tileTerminal })).toBe(
      true
    );
  });
});

describe('scroll routing diagnostic (issue #205 round 2)', () => {
  it('prints the decision and its inputs once per session, and again when it changes', () => {
    const { app, logs } = hollowApp({ cliVersion: '2.1.100' });
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: false });

    app._logScrollRouting('local-scrollback');
    app._logScrollRouting('local-scrollback'); // same decision → stays quiet
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('sess-1 → local-scrollback');
    expect(logs[0]).toContain('mode=claude');
    expect(logs[0]).toContain('cliVersion=2.1.100');
    expect(logs[0]).toContain('localScrollbackOptOut=false');
    expect(logs[0]).toContain('mouseTracking=none');
    // The gate's real tracking input: xterm's own mode above is always 'none'
    // for Claude, since the server strips the DECSETs.
    expect(logs[0]).toContain('cliMouseTracking=false');

    app._logScrollRouting('page-keys'); // a changed route still prints
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('page-keys');

    // The CLI turning tracking on changes the gate, so it prints again.
    app.sessions.get('sess-1').cliMouseTracking = true;
    app._logScrollRouting('page-keys');
    expect(logs).toHaveLength(3);
    expect(logs[2]).toContain('cliMouseTracking=true');
  });

  it('reports an unknown CLI version, the false-path that disables forwarding', () => {
    const { app, logs } = hollowApp(); // no cliVersion — the probe failed
    app._logScrollRouting('page-keys');
    expect(logs[0]).toContain('cliVersion=unknown');
  });
});
