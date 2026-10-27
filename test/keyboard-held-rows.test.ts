// Port: none (pure logic and a real headless xterm in vm contexts: no browser,
// no server).
//
// Rows held under the on-screen keyboard (`keyboardHoldsRows`, per-device,
// default ON). Every PTY height change makes Claude Code clear the screen and
// reprint only the transcript tail that fits, and the keyboard opening and
// closing used to be such a change each time (measured on the dev tier: tmux
// went 62x38 -> 62x15 -> 62x38 with a SIGWINCH per transition). Now the rows
// captured at the show transition are held, columns still follow the box, and
// the over-tall screen is scrolled up instead (keyboardClipPx).
//
// Outside test/mobile/ on purpose: that suite is not in the CI gate.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import xtermHeadless from '@xterm/headless';

type HeadlessBuffer = {
  viewportY: number;
  baseY: number;
  cursorY: number;
  length: number;
  getLine(y: number): { translateToString(trim?: boolean): string } | undefined;
};
const { Terminal: HeadlessTerminal } = xtermHeadless as unknown as {
  Terminal: new (opts: Record<string, unknown>) => {
    rows: number;
    write(data: string, cb?: () => void): void;
    buffer: { active: HeadlessBuffer };
  };
};

const read = (file: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8');

type Geometry = {
  keyboardClipPx(input: Record<string, number | boolean>): number;
  keyboardVisibleRowLimit(clipPx: number, viewHeight: number, cellHeight: number): number;
};

function loadGeometry(): Geometry {
  const window: Record<string, unknown> = {};
  vm.runInContext(read('constants.js'), vm.createContext({ console, window, URLSearchParams }));
  return window.CodemanTerminalGeometry as Geometry;
}

describe('keyboardClipPx', () => {
  const g = loadGeometry();
  // 38 held rows of 17px in a 255px box (15 rows visible): 391px of overflow.
  const base = { rows: 38, cellHeight: 17, viewHeight: 255, following: true, viewportY: 100, baseY: 100 };

  it('puts the last content row at the bottom of the box', () => {
    // Claude: composer and footer run to the last row, cursor in the composer.
    expect(g.keyboardClipPx({ ...base, cursorRow: 34, lastContentRow: 37 })).toBe(38 * 17 - 255);
    // Content ends at row 20: rows 6..20 are in view.
    expect(g.keyboardClipPx({ ...base, cursorRow: 20, lastContentRow: 20 })).toBe(21 * 17 - 255);
  });

  it('counts a cursor just below the content (an empty prompt line)', () => {
    expect(g.keyboardClipPx({ ...base, cursorRow: 22, lastContentRow: 20 })).toBe(23 * 17 - 255);
  });

  it('ignores a cursor parked far below the content (codex dialogs)', () => {
    // Measured on the dev tier: codex's update dialog on rows 1-8 of 42, its
    // cursor on row 38 of an otherwise blank screen. Anchoring to the cursor
    // scrolled the dialog out of view; the top stays in view instead.
    expect(g.keyboardClipPx({ ...base, cursorRow: 37, lastContentRow: 8 })).toBe(0);
  });

  it('shows the top for a prompt near the top (a fresh shell), and uses the cursor on a blank screen', () => {
    expect(g.keyboardClipPx({ ...base, cursorRow: 1, lastContentRow: 1, viewportY: 0, baseY: 0 })).toBe(0);
    expect(g.keyboardClipPx({ ...base, cursorRow: 37, lastContentRow: -1 })).toBe(38 * 17 - 255);
  });

  it('follows the scroll position while reading history, top of scrollback included', () => {
    const max = 38 * 17 - 255;
    expect(g.keyboardClipPx({ ...base, following: false, viewportY: 0, cursorRow: 37, lastContentRow: 37 })).toBe(0);
    expect(g.keyboardClipPx({ ...base, following: false, viewportY: 50, cursorRow: 37, lastContentRow: 37 })).toBe(
      Math.round(max / 2)
    );
  });

  it('is 0 when nothing overflows or the terminal cannot be measured', () => {
    expect(g.keyboardClipPx({ ...base, viewHeight: 38 * 17, cursorRow: 37, lastContentRow: 37 })).toBe(0);
    expect(g.keyboardClipPx({ ...base, cellHeight: 0, cursorRow: 37, lastContentRow: 37 })).toBe(0);
  });

  it('bounds the overlay to the fully visible rows', () => {
    expect(g.keyboardVisibleRowLimit(0, 255, 17)).toBe(15);
    expect(g.keyboardVisibleRowLimit(38 * 17 - 255, 255, 17)).toBe(38);
    expect(g.keyboardVisibleRowLimit(10, 255, 17)).toBe(15);
  });
});

type Proto = Record<string, (this: Record<string, unknown>, ...args: unknown[]) => unknown>;

function loadTerminalProto(keyboard: Record<string, unknown> = { keyboardVisible: true }) {
  const windowStub: Record<string, unknown> = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const context = vm.createContext({
    console,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    URLSearchParams,
    document: { addEventListener: vi.fn(), documentElement: { dataset: {} }, getElementById: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: windowStub,
    MobileDetection: { isTouchDevice: () => true, isHandheldDevice: () => false, getDeviceType: () => 'mobile' },
    KeyboardHandler: keyboard,
  });
  vm.runInContext(
    `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  const proto = (context as unknown as { __CodemanApp: { prototype: Proto } }).__CodemanApp.prototype;
  return { proto, keyboard, windowStub };
}

describe('getTerminalDimensions holds the rows while the keyboard is up', () => {
  const { proto, keyboard } = loadTerminalProto();
  const fake = (held: number) => ({
    _keyboardHeldRows: held,
    _keyboardHeldRowsActive: proto._keyboardHeldRowsActive,
    fitAddon: { proposeDimensions: () => ({ cols: 62, rows: 15 }) },
  });

  it('reports the held rows and the container columns', () => {
    keyboard.keyboardVisible = true;
    expect(proto.getTerminalDimensions.call(fake(38))).toEqual({ cols: 62, rows: 38 });
  });

  it('follows the container once the keyboard is gone, or with no hold', () => {
    keyboard.keyboardVisible = false;
    expect(proto.getTerminalDimensions.call(fake(38))).toEqual({ cols: 62, rows: 15 });
    keyboard.keyboardVisible = true;
    expect(proto.getTerminalDimensions.call(fake(0))).toEqual({ cols: 62, rows: 15 });
  });

  it('never holds fewer rows than the box offers', () => {
    keyboard.keyboardVisible = true;
    expect(proto.getTerminalDimensions.call(fake(12))).toEqual({ cols: 62, rows: 15 });
  });

  it('skips the raw fit while held, so xterm never visits the short size', () => {
    keyboard.keyboardVisible = true;
    const fit = vi.fn();
    const resizes: unknown[] = [];
    const self = {
      ...fake(38),
      fitAddon: { fit, proposeDimensions: () => ({ cols: 62, rows: 15 }) },
      terminal: { cols: 62, rows: 38, resize: (c: number, r: number) => resizes.push([c, r]) },
      getTerminalDimensions: proto.getTerminalDimensions,
      _resizeTerminalTo: proto._resizeTerminalTo,
      _scheduleOverflowAffordanceSync: () => {},
    };
    expect(proto.syncTerminalGeometry.call(self)).toEqual({ cols: 62, rows: 38 });
    expect(fit).not.toHaveBeenCalled();
    expect(resizes).toEqual([]);
  });
});

describe('only inline renderers hold, and a hold is released when the session stops qualifying', () => {
  const { proto, windowStub } = loadTerminalProto();
  windowStub.__codemanKeyboardHoldModes = ['claude'];
  const appWith = (session: Record<string, unknown> | null, settings: Record<string, unknown> = {}) => ({
    activeSessionId: session ? 's1' : null,
    sessions: new Map(session ? [['s1', session]] : []),
    loadAppSettingsFromStorage: () => settings,
    _keyboardHoldEligible: proto._keyboardHoldEligible,
    _releaseKeyboardHold: proto._releaseKeyboardHold,
  });
  const eligible = (session: Record<string, unknown> | null, settings?: Record<string, unknown>) =>
    proto._keyboardHoldEligible.call(appWith(session, settings));

  it('holds for an inline renderer (the keyboardHold capability), mode defaulting to claude', () => {
    expect(eligible({ mode: 'claude' })).toBe(true);
    expect(eligible({})).toBe(true);
  });

  it('never holds a full-height CLI, fullscreen Claude, a remote or docker pane, or with the setting off', () => {
    expect(eligible({ mode: 'codex' })).toBe(false);
    expect(eligible({ mode: 'shell' })).toBe(false);
    expect(eligible({ mode: 'claude', cliMouseTracking: true })).toBe(false);
    expect(eligible({ mode: 'claude', remote: { hostId: 'h' } })).toBe(false);
    expect(eligible({ mode: 'claude', docker: { caseName: 'c' } })).toBe(false);
    expect(eligible({ mode: 'claude' }, { keyboardHoldsRows: false })).toBe(false);
    expect(eligible(null)).toBe(false);
  });

  it('holds nothing when the server sent no list', () => {
    const saved = windowStub.__codemanKeyboardHoldModes;
    delete windowStub.__codemanKeyboardHoldModes;
    try {
      expect(eligible({ mode: 'claude' })).toBe(false);
    } finally {
      windowStub.__codemanKeyboardHoldModes = saved;
    }
  });

  const reconcile = (session: Record<string, unknown>, opts?: Record<string, unknown>) => {
    const app = {
      ...appWith(session),
      _keyboardHeldRows: 38,
      _applyKeyboardClip: vi.fn(),
      sendResize: vi.fn(() => Promise.resolve(true)),
    };
    proto._reconcileKeyboardHold.call(app, opts);
    return app;
  };

  it('releases and resizes once the active session no longer qualifies', () => {
    const app = reconcile({ mode: 'claude', cliMouseTracking: true });
    expect(app._keyboardHeldRows).toBe(0);
    expect(app._applyKeyboardClip).toHaveBeenCalled();
    expect(app.sendResize).toHaveBeenCalledWith('s1');
  });

  it('leaves the resize to a caller that does its own (selectSession)', () => {
    const app = reconcile({ mode: 'codex' }, { resize: false });
    expect(app._keyboardHeldRows).toBe(0);
    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('keeps a hold the session still qualifies for', () => {
    const app = reconcile({ mode: 'claude' });
    expect(app._keyboardHeldRows).toBe(38);
    expect(app.sendResize).not.toHaveBeenCalled();
  });

  // session:updated is how a running Claude session reports entering its
  // fullscreen renderer (cliMouseTracking), so the shipped handler must release.
  const updatedApp = () => ({
    ...appWith({ mode: 'claude' }),
    _keyboardHeldRows: 38,
    _applyKeyboardClip: vi.fn(),
    sendResize: vi.fn(() => Promise.resolve(true)),
    _reconcileKeyboardHold: proto._reconcileKeyboardHold,
    renderSessionTabs: vi.fn(),
    updateCost: vi.fn(),
    updateSubagentParentNames: vi.fn(),
  });

  it('a session:updated that turns mouse tracking on releases the hold and resizes', () => {
    const app = updatedApp();
    app.sendResize.mockClear();
    proto._onSessionUpdated.call(app, { session: { id: 's1', mode: 'claude', cliMouseTracking: true } });
    expect(app._keyboardHeldRows).toBe(0);
    expect(app.sendResize).toHaveBeenCalledWith('s1');
  });

  it('a session:updated for another session, or one that still qualifies, keeps it', () => {
    const app = updatedApp();
    app.sessions.set('s2', { id: 's2', mode: 'claude' });
    proto._onSessionUpdated.call(app, { session: { id: 's2', mode: 'claude', cliMouseTracking: true } });
    proto._onSessionUpdated.call(app, { session: { id: 's1', mode: 'claude' } });
    expect(app._keyboardHeldRows).toBe(38);
    expect(app.sendResize).not.toHaveBeenCalled();
  });
});

// The composer must stay on screen with the rows held. The COLUMNS ONLY rule in
// reconcilePtyGeometry exists because a screen taller than its box once hid the
// CLI's input line with nothing able to reach it; the hold makes the screen
// taller on purpose, and this pins that the clip puts the composer back in view.
// A real headless xterm holds Claude's inline frame at the held 38 rows, and the
// shipped getTerminalDimensions and _applyKeyboardClip run against it.
describe('the composer row stays visible with the rows held', () => {
  const ROWS = 38;
  const COLS = 62;
  const CELL = 17;
  const BOX = 15 * CELL; // the box left above the keyboard: 15 rows

  async function heldApp(transcriptLines: number) {
    const { proto, keyboard } = loadTerminalProto();
    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
    // Claude's inline renderer: the transcript, then its composer between two
    // rules with the footer under it, the cursor parked after the prompt glyph.
    const rule = '\u2500'.repeat(COLS);
    const transcript = Array.from({ length: transcriptLines }, (_, i) => `KBTEST-${String(i + 1).padStart(3, '0')}`);
    const frame = [...transcript, rule, '\u276f ', rule, '  ? for shortcuts'].join('\r\n');
    await new Promise<void>((done) => term.write(`${frame}\x1b[2A\x1b[3G`, () => done()));
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const container = { clientHeight: BOX, style };
    const app: Record<string, unknown> = {
      _keyboardHeldRows: 0,
      fitAddon: { proposeDimensions: () => ({ cols: COLS, rows: 15 }) },
      terminal: {
        rows: term.rows,
        buffer: term.buffer,
        element: { parentElement: container },
        _core: { _renderService: { dimensions: { css: { cell: { height: CELL } } } } },
      },
      _localEchoOverlay: { setRowLimit: vi.fn() },
      _keyboardHeldRowsActive: proto._keyboardHeldRowsActive,
      getTerminalDimensions: proto.getTerminalDimensions,
      _applyKeyboardClip: proto._applyKeyboardClip,
    };
    const buffer = term.buffer.active;
    const screenRow = (pattern: RegExp) => {
      for (let row = 0; row < ROWS; row++) {
        if (pattern.test(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')) return row;
      }
      return -1;
    };
    return { app, keyboard, style, buffer, screenRow };
  }

  /** The --kb-clip offset last written to the container, 0 when removed or never set. */
  function clipOf(style: { setProperty: ReturnType<typeof vi.fn>; removeProperty: ReturnType<typeof vi.fn> }) {
    const set = style.setProperty.mock.calls.at(-1);
    return set ? parseFloat(String(set[1])) : 0;
  }

  /** Is screen row `row` wholly inside the box once the screen is translated up by `clip` px? */
  const fullyVisible = (row: number, clip: number) => row * CELL >= clip && (row + 1) * CELL <= clip + BOX;

  it('a long transcript: the composer and the footer under it sit at the bottom of the box', async () => {
    const { app, keyboard, style, buffer, screenRow } = await heldApp(100);
    keyboard.keyboardVisible = true;
    app._keyboardHeldRows = ROWS; // what KeyboardHandler captures on the show transition

    // The PTY keeps its rows while the box shrinks to 15; columns still follow the box.
    expect((app.getTerminalDimensions as () => unknown).call(app)).toEqual({ cols: COLS, rows: ROWS });

    (app._applyKeyboardClip as () => void).call(app);
    const composer = screenRow(/^\u276f/);
    const footer = screenRow(/\? for shortcuts/);
    expect([composer, footer, buffer.cursorY]).toEqual([35, 37, 35]);
    const clip = clipOf(style);
    expect(clip).toBe(ROWS * CELL - BOX);
    expect(fullyVisible(composer, clip)).toBe(true);
    expect(fullyVisible(footer, clip)).toBe(true);
    // The local-echo overlay may draw down to the last visible row, the composer's included.
    const limit = (app._localEchoOverlay as { setRowLimit: ReturnType<typeof vi.fn> }).setRowLimit.mock.calls.at(
      -1
    )![0];
    expect(limit).toBe(ROWS);
  });

  it('a fresh session whose frame ends near the top: no offset, the composer already in view', async () => {
    const { app, keyboard, style, screenRow } = await heldApp(5);
    keyboard.keyboardVisible = true;
    app._keyboardHeldRows = ROWS;
    (app._applyKeyboardClip as () => void).call(app);
    const composer = screenRow(/^\u276f/);
    expect(composer).toBe(6);
    expect(clipOf(style)).toBe(0);
    expect(fullyVisible(composer, 0)).toBe(true);
    // Rows 0..14 are the visible ones: the overlay must grow upward from row 14,
    // not from row 37 under the keyboard.
    expect((app._localEchoOverlay as { setRowLimit: ReturnType<typeof vi.fn> }).setRowLimit).toHaveBeenLastCalledWith(
      15
    );
  });

  it('keyboard closed: the offset and the overlay bound are both removed', async () => {
    const { app, keyboard, style } = await heldApp(100);
    keyboard.keyboardVisible = true;
    app._keyboardHeldRows = ROWS;
    (app._applyKeyboardClip as () => void).call(app);
    expect(clipOf(style)).toBeGreaterThan(0);

    keyboard.keyboardVisible = false;
    const overlay = app._localEchoOverlay as { setRowLimit: ReturnType<typeof vi.fn> };
    overlay.setRowLimit.mockClear();
    style.setProperty.mockClear();
    (app._applyKeyboardClip as () => void).call(app);
    expect(style.removeProperty).toHaveBeenCalledWith('--kb-clip');
    expect(style.setProperty).not.toHaveBeenCalled();
    expect(overlay.setRowLimit).toHaveBeenCalledWith(null);
    expect(app._keyboardClipPx).toBe(0);
  });
});

type ManualTimers = { setTimeout(fn: () => void): number; clearTimeout(id: number): void; run(): void };

/** setTimeout/clearTimeout whose callbacks run only when the test says so. */
function manualTimers(): ManualTimers {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    setTimeout(fn) {
      pending.set(++next, fn);
      return next;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    run() {
      for (let round = 0; pending.size && round < 10; round++) {
        for (const [id, fn] of [...pending]) {
          pending.delete(id);
          fn();
        }
      }
    },
  };
}

function loadKeyboardHandler(enabled: boolean, opts: { app?: Record<string, unknown>; timers?: ManualTimers } = {}) {
  const viewport = { width: 390, height: 664, offsetTop: 0, addEventListener: () => {}, removeEventListener: () => {} };
  const layout = { height: 664 };
  const app = opts.app ?? {
    terminal: { rows: 38 },
    _keyboardHeldRows: 0,
    _keyboardHoldEligible: () => enabled,
    _applyKeyboardClip: vi.fn(),
    // The shipped release, so a hide or a shape change goes through the real helper.
    _releaseKeyboardHold: loadTerminalProto().proto._releaseKeyboardHold,
    relayoutMobileSubagentWindows: () => {},
  };
  const context = vm.createContext({
    console,
    app,
    navigator: { userAgent: 'iPhone', maxTouchPoints: 5 },
    window: {
      get innerWidth() {
        return viewport.width;
      },
      get innerHeight() {
        return layout.height;
      },
      visualViewport: viewport,
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: true }),
      scrollTo: () => {},
    },
    document: {
      body: { classList: { add: () => {}, remove: () => {} } },
      documentElement: { style: { setProperty: () => {} } },
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementById: () => null,
      querySelector: () => null,
    },
    setTimeout: opts.timers ? opts.timers.setTimeout : () => 1,
    clearTimeout: opts.timers ? opts.timers.clearTimeout : () => {},
  });
  vm.runInContext(`${read('mobile-handlers.js')}\nglobalThis.__KH = KeyboardHandler;`, context);
  const handler = (context as unknown as { __KH: { init(): void; handleViewportResize(): void } }).__KH;
  handler.init();
  const resizeTo = (width: number, height: number, layoutHeight = height) => {
    viewport.width = width;
    viewport.height = height;
    layout.height = layoutHeight;
    handler.handleViewportResize();
  };
  return { app: app as typeof app & Record<string, any>, handler, resizeTo };
}

describe('KeyboardHandler captures and releases the hold', () => {
  it('captures the keyboard-free rows on show and releases them on hide', () => {
    const { app, resizeTo } = loadKeyboardHandler(true);
    resizeTo(390, 364, 664);
    expect(app._keyboardHeldRows).toBe(38);
    app._applyKeyboardClip.mockClear();
    resizeTo(390, 664);
    expect(app._keyboardHeldRows).toBe(0);
    expect(app._applyKeyboardClip).toHaveBeenCalledTimes(1);
  });

  it('holds nothing for a session that does not qualify (setting off, a full-height CLI)', () => {
    const { app, resizeTo } = loadKeyboardHandler(false);
    resizeTo(390, 364, 664);
    expect(app._keyboardHeldRows).toBe(0);
  });

  it('releases on a shape change with the keyboard still up', () => {
    const { app, resizeTo } = loadKeyboardHandler(true);
    resizeTo(390, 364, 664);
    resizeTo(664, 90, 390); // rotated, keyboard still up
    expect(app._keyboardHeldRows).toBe(0);
  });
});

// A rotation (or fold) with the keyboard still up releases the hold, since its
// rows belong to the display that is gone. The keyboard is still visible, so
// throttledResize stands aside and only the viewport settle can refit: the
// release has to arm it, or xterm keeps the held rows with no clip and the
// composer sits under the keyboard until it closes. The real KeyboardHandler
// drives the real terminal-ui methods over a headless xterm, with the timers
// run by hand so the opening settle finishes before the rotation.
describe('a rotation with the keyboard up', () => {
  const CELL = 17;

  async function rotationSetup(eligible: boolean) {
    const box = { cols: 44, rows: 38 };
    const term = new HeadlessTerminal({ cols: box.cols, rows: box.rows, scrollback: 1000, allowProposedApi: true });
    const rule = '\u2500'.repeat(40);
    const transcript = Array.from({ length: 100 }, (_, i) => `KBTEST-${String(i + 1).padStart(3, '0')}`);
    const frame = [...transcript, rule, '\u276f ', rule, '  ? for shortcuts'].join('\r\n');
    await new Promise<void>((done) => term.write(`${frame}\x1b[2A\x1b[3G`, () => done()));
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    const container = {
      get clientHeight() {
        return box.rows * CELL;
      },
      style,
    };
    const sent: unknown[] = [];
    const app: Record<string, any> = {
      activeSessionId: 's1',
      sessions: new Map([['s1', { id: 's1', mode: eligible ? 'claude' : 'codex' }]]),
      _keyboardHeldRows: 0,
      loadAppSettingsFromStorage: () => ({}),
      relayoutMobileSubagentWindows: () => {},
      isTerminalAtBottom: () => true,
      _scheduleOverflowAffordanceSync: () => {},
      _syncMobileHelperTextareaToCursor: () => {},
      fitAddon: { proposeDimensions: () => ({ ...box }), fit: () => term.resize(box.cols, box.rows) },
      terminal: {
        get rows() {
          return term.rows;
        },
        get cols() {
          return term.cols;
        },
        get buffer() {
          return term.buffer;
        },
        resize: (cols: number, rows: number) => term.resize(cols, rows),
        scrollToBottom: () => {},
        element: { parentElement: container },
        _core: { _renderService: { dimensions: { css: { cell: { height: CELL } } } } },
      },
      sendResize: vi.fn(() => {
        sent.push(app.getTerminalDimensions());
        return Promise.resolve(true);
      }),
    };
    const timers = manualTimers();
    const { handler, resizeTo } = loadKeyboardHandler(eligible, { app, timers });
    const { proto, windowStub } = loadTerminalProto(handler as unknown as Record<string, unknown>);
    windowStub.__codemanKeyboardHoldModes = ['claude'];
    // Every method not stubbed above is the shipped one.
    Object.setPrototypeOf(app, proto);
    const buffer = term.buffer.active;
    const composerRow = () => {
      for (let row = 0; row < term.rows; row++) {
        if (/^\u276f/.test(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')) return row;
      }
      return -1;
    };
    // Keyboard up over a portrait display, and the opening settle runs to the end.
    box.rows = 15;
    resizeTo(390, 364, 664);
    timers.run();
    return { app, box, term, style, sent, timers, resizeTo, composerRow };
  }

  it('refits to the new display and tells the PTY, so the composer is back in the box', async () => {
    const { app, box, term, style, sent, timers, resizeTo, composerRow } = await rotationSetup(true);
    // The hold is in place after the opening settle: 38 rows in a 15-row box, clipped.
    expect([term.cols, term.rows, app._keyboardHeldRows]).toEqual([44, 38, 38]);
    expect(app._keyboardClipPx).toBe((38 - 15) * CELL);

    // Rotate to landscape with the keyboard still up: a 12-row, 76-column box.
    box.cols = 76;
    box.rows = 12;
    app.sendResize.mockClear();
    sent.length = 0;
    style.removeProperty.mockClear();
    resizeTo(664, 120, 390);
    timers.run();

    expect(app._keyboardHeldRows).toBe(0);
    expect([term.cols, term.rows]).toEqual([76, 12]);
    expect(app.sendResize).toHaveBeenCalledWith('s1');
    expect(sent).toEqual([{ cols: 76, rows: 12 }]);
    // No clip left, and with the rows fitted to the box the composer is inside it.
    expect(style.removeProperty).toHaveBeenCalledWith('--kb-clip');
    expect(app._keyboardClipPx).toBe(0);
    // Shrinking the rows, xterm keeps the cursor row (the composer) on the last
    // screen row; Claude redraws its footer under it after the SIGWINCH.
    const composer = composerRow();
    expect(composer).toBe(11);
    expect((composer + 1) * CELL).toBeLessThanOrEqual(box.rows * CELL);
  });

  it('with no hold, a rotation arms nothing, as before', async () => {
    const { app, box, term, timers, resizeTo } = await rotationSetup(false);
    // Not eligible: the opening settle fitted the short box, as before the hold existed.
    expect([term.rows, app._keyboardHeldRows]).toEqual([15, 0]);
    box.cols = 76;
    box.rows = 12;
    app.sendResize.mockClear();
    resizeTo(664, 120, 390);
    timers.run();
    expect(app.sendResize).not.toHaveBeenCalled();
    expect([term.cols, term.rows]).toEqual([44, 15]);
  });
});

describe('keyboardHoldsRows is a per-device setting', () => {
  const settingsUi = read('settings-ui.js');
  const html = read('index.html');
  const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');

  it('is a display key, stripped from the PUT and absent from the strict schema', () => {
    const start = settingsUi.indexOf('const displayKeys = new Set([');
    expect(settingsUi.slice(start, settingsUi.indexOf('])', start))).toContain("'keyboardHoldsRows'");
    expect(settingsUi).toContain('keyboardHoldsRows: _khr,');
    expect(schemas).not.toContain('keyboardHoldsRows');
  });

  it('defaults ON and loads/saves by id', () => {
    expect(html).toContain('id="appSettingsKeyboardHoldsRows"');
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsKeyboardHoldsRows').checked = settings.keyboardHoldsRows !== false;"
    );
    expect(settingsUi).toContain("keyboardHoldsRows: document.getElementById('appSettingsKeyboardHoldsRows').checked,");
  });
});
