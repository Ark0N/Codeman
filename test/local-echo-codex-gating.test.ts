/**
 * @fileoverview Local-echo gating and input-ordering helpers for codex
 * sessions (issues #218/#219/#220/#222).
 *
 * Codex's composer is interactive per keystroke: typing "/" pops a
 * live-filtering command picker (#222), the composer grows as it wraps
 * (#220), pastes arrive bracketed (#219) and arrows edit server-side state
 * (#218). The buffer-until-Enter local echo overlay starves all of that, so
 * codex-mode sessions must use plain PTY echo like shell. The shared overlay
 * branch (claude/gemini/opencode) additionally flushes typed-but-unsent text
 * before forwarding bracketed pastes and composer nav keys, and hands the
 * session to pass-through after a nav key.
 *
 * Loaded via `vm` with a stubbed context (no jsdom), mirroring
 * test/input-send-order.test.ts. End-to-end behavior was verified against a
 * real codex 0.147.0 TUI in tmux through a headless browser.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type OverlayStub = {
  pendingText: string;
  cleared: number;
  suppressed: number;
  prompts: unknown[];
  clear(): void;
  suppressBufferDetection(): void;
  setPrompt(p: unknown): void;
  appendText: ReturnType<typeof vi.fn>;
};

type AppInstance = {
  activeSessionId: string | null;
  sessions: Map<string, { mode: string }>;
  terminal?: { focus: () => void };
  _localEchoEnabled?: boolean;
  _localEchoOverlay?: OverlayStub;
  _pendingInput: string;
  _flushedOffsets?: Map<string, number>;
  _flushedTexts?: Map<string, string>;
  _echoPassthroughSessions?: Set<string>;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
  sendInput: ReturnType<typeof vi.fn>;
  _updateLocalEchoState(): void;
  _flushLocalEchoPending(): void;
  insertTerminalText(text: string): void;
};

function loadContext() {
  const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
  const windowStub: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: vi.fn(),
    document: { addEventListener: vi.fn(), documentElement: { dataset: {} } },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: windowStub,
    MobileDetection: {
      isTouchDevice: () => true,
      isHandheldDevice: () => false,
      getDeviceType: () => 'desktop',
    },
  });
  vm.runInContext(
    `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
  return {
    CodemanApp,
    terminalInput: (windowStub as { CodemanTerminalInput?: Record<string, unknown> }).CodemanTerminalInput!,
  };
}

const { CodemanApp, terminalInput } = loadContext();
const isComposerNavKey = terminalInput.isComposerNavKey as (data: string) => boolean;

function makeOverlay(pending = ''): OverlayStub {
  return {
    pendingText: pending,
    cleared: 0,
    suppressed: 0,
    prompts: [],
    clear() {
      this.cleared++;
      this.pendingText = '';
    },
    suppressBufferDetection() {
      this.suppressed++;
    },
    setPrompt(p: unknown) {
      this.prompts.push(p);
    },
    appendText: vi.fn(),
  };
}

function makeApp(mode: string, overlay = makeOverlay()): AppInstance {
  const app = Object.create(CodemanApp.prototype) as AppInstance;
  app.activeSessionId = 's1';
  app.sessions = new Map([['s1', { mode }]]);
  app._localEchoOverlay = overlay;
  app._pendingInput = '';
  app._flushedOffsets = new Map([['s1', 3]]);
  app._flushedTexts = new Map([['s1', 'abc']]);
  app.loadAppSettingsFromStorage = () => ({ localEchoEnabled: true });
  app.sendInput = vi.fn().mockResolvedValue(undefined);
  return app;
}

describe('CodemanTerminalInput.isComposerNavKey', () => {
  it.each([
    '\x1b[A',
    '\x1b[B',
    '\x1b[C',
    '\x1b[D',
    '\x1b[H',
    '\x1b[F',
    '\x1bOA',
    '\x1bOD',
    '\x1bOH',
    '\x1bOF',
    '\x1b[1;5C', // Ctrl+Right
    '\x1b[1;2A', // Shift+Up
    '\x1b[3~', // Delete
    '\x1b[3;5~', // Ctrl+Delete
    '\x1b[5~', // PgUp
    '\x1b[6~', // PgDn
    '\x1b[1~', // Home variant
    '\x1b[4~', // End variant
  ])('classifies %j as a composer nav key', (seq) => {
    expect(isComposerNavKey(seq)).toBe(true);
  });

  it.each([
    '\x1b[?1;2c', // DA1 response
    '\x1b[>0;276;0c', // DA2 response
    '\x1b[12;34R', // CPR response
    '\x1b[1;3R', // CPR response (small coords)
    '\x1b[0n', // DSR response
    '\x1b[15~', // F5 (function keys stay out)
    '\x1b[200~hi\x1b[201~', // bracketed paste
    '\x1b[?u', // kitty keyboard query response
    '\x1bOP', // F1
    '\x1b',
    'a',
    'abc',
    '\r',
  ])('does NOT classify %j as a composer nav key', (seq) => {
    expect(isComposerNavKey(seq)).toBe(false);
  });

  it('exports the bracketed paste prefix xterm puts on terminal.paste()', () => {
    expect(terminalInput.BRACKETED_PASTE_START).toBe('\x1b[200~');
  });
});

describe('_updateLocalEchoState mode gating', () => {
  it('disables the overlay for codex sessions even with the setting ON (issues #218/#219/#220/#222)', () => {
    const overlay = makeOverlay('pending');
    const app = makeApp('codex', overlay);
    app._updateLocalEchoState();
    expect(app._localEchoEnabled).toBe(false);
    expect(overlay.cleared).toBeGreaterThan(0);
  });

  it('disables the overlay for shell sessions (PTY provides its own echo)', () => {
    const app = makeApp('shell');
    app._updateLocalEchoState();
    expect(app._localEchoEnabled).toBe(false);
  });

  it.each(['claude', 'gemini', 'opencode', 'pi', 'grok'])('keeps the overlay enabled for %s sessions', (mode) => {
    const overlay = makeOverlay();
    const app = makeApp(mode, overlay);
    app._updateLocalEchoState();
    expect(app._localEchoEnabled).toBe(true);
    expect(overlay.prompts.length).toBeGreaterThan(0);
  });
});

describe('_flushLocalEchoPending', () => {
  it('moves pending text into _pendingInput and resets overlay + flushed tracking', () => {
    const overlay = makeOverlay('hello');
    const app = makeApp('claude', overlay);
    app._flushLocalEchoPending();
    expect(app._pendingInput).toBe('hello');
    expect(overlay.cleared).toBe(1);
    expect(overlay.suppressed).toBe(1);
    expect(app._flushedOffsets!.has('s1')).toBe(false);
    expect(app._flushedTexts!.has('s1')).toBe(false);
  });

  it('appends nothing when the overlay is empty', () => {
    const app = makeApp('claude', makeOverlay(''));
    app._flushLocalEchoPending();
    expect(app._pendingInput).toBe('');
  });
});

describe('insertTerminalText pass-through routing', () => {
  it('appends to the overlay while local echo is buffering', () => {
    const overlay = makeOverlay();
    const app = makeApp('claude', overlay);
    app._localEchoEnabled = true;
    app.insertTerminalText('path.txt');
    expect(overlay.appendText).toHaveBeenCalledWith('path.txt');
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it('sends directly while the session is in nav-key pass-through', () => {
    const overlay = makeOverlay();
    const app = makeApp('claude', overlay);
    app._localEchoEnabled = true;
    app._echoPassthroughSessions = new Set(['s1']);
    app.insertTerminalText('path.txt');
    expect(app.sendInput).toHaveBeenCalledWith('path.txt');
    expect(overlay.appendText).not.toHaveBeenCalled();
  });
});

// ─── Predictive write-through echo (codex) ──────────────────────────────────

type PredictorStub = {
  predictChar: ReturnType<typeof vi.fn>;
  predictBackspace: ReturnType<typeof vi.fn>;
  clearPredictions: ReturnType<typeof vi.fn>;
};

type PredictiveApp = AppInstance & {
  _localEchoPolicy?: string;
  _predictiveEcho?: PredictorStub | null;
  _predictHookOnData(data: string): void;
};

function makePredictor(): PredictorStub {
  return {
    predictChar: vi.fn().mockReturnValue(true),
    predictBackspace: vi.fn().mockReturnValue(true),
    clearPredictions: vi.fn(),
  };
}

const classifyPredictInput = terminalInput.classifyPredictInput as (data: string) => string;
const isCodexComposerRow = terminalInput.isCodexComposerRow as (t: unknown) => boolean;

describe('CodemanTerminalInput.classifyPredictInput', () => {
  it.each([
    ['a', 'char'],
    [' ', 'char'],
    ['€', 'char'],
    ['你', 'char'],
    ['😀', 'char'], // single astral codepoint
    ['\x7f', 'backspace'],
    ['\r', 'clear'],
    ['\n', 'clear'],
    ['\t', 'clear'],
    ['\x03', 'clear'], // Ctrl+C
    ['\x15', 'clear'], // Ctrl+U
    ['\x1b', 'clear'], // bare ESC
    ['\x1b[A', 'clear'], // arrow
    ['\x1bOA', 'clear'], // SS3 arrow
    ['\x1b[3~', 'clear'], // Delete
    ['\x1b[200~hi\x1b[201~', 'clear'], // bracketed paste
    ['\x1b[<0;10;5M', 'clear'], // mouse SGR report
    ['abc', 'text'], // plain multi-char paste
    ['👨‍👩‍👧', 'text'], // ZWJ emoji cluster
    ['\r\n', 'clear'],
  ])('classifies %j as %s', (data, expected) => {
    expect(classifyPredictInput(data)).toBe(expected);
  });
});

describe('CodemanTerminalInput.isCodexComposerRow', () => {
  function terminalWithCursorRow(text: string | null) {
    return {
      buffer: {
        active: {
          baseY: 4,
          cursorY: 2,
          getLine: (y: number) => (y === 6 && text !== null ? { translateToString: () => text } : undefined),
        },
      },
    };
  }

  it.each([
    '› ', // empty composer
    '› Use /skills to list available skills', // placeholder
    '› hello', // typed text
    '› /mo', // slash picker filtering
  ])('matches the composer row %j', (row) => {
    expect(isCodexComposerRow(terminalWithCursorRow(row))).toBe(true);
  });

  it.each([
    '  Press enter to continue', // trust/approval modal
    '  this line twice over', // wrapped continuation row (2-space indent)
    '›no-space',
    '1. Yes, continue',
    '',
  ])('rejects the non-composer row %j', (row) => {
    expect(isCodexComposerRow(terminalWithCursorRow(row))).toBe(false);
  });

  it('reads the cursor row baseY-relative (baseY + cursorY)', () => {
    // terminalWithCursorRow only answers getLine(6) = baseY 4 + cursorY 2;
    // a viewportY-based read would ask for a different line and get undefined
    expect(isCodexComposerRow(terminalWithCursorRow('› x'))).toBe(true);
  });

  it('returns false when the row is missing or getLine throws', () => {
    expect(isCodexComposerRow(terminalWithCursorRow(null))).toBe(false);
    const hostile = {
      buffer: {
        active: {
          baseY: 0,
          cursorY: 0,
          getLine: () => {
            throw new Error('boom');
          },
        },
      },
    };
    expect(isCodexComposerRow(hostile)).toBe(false);
  });
});

describe('_updateLocalEchoState echo policy', () => {
  it("codex + setting ON -> policy 'predict' while _localEchoEnabled stays false", () => {
    const app = makeApp('codex') as PredictiveApp;
    app._predictiveEcho = makePredictor();
    app._updateLocalEchoState();
    expect(app._localEchoPolicy).toBe('predict');
    expect(app._localEchoEnabled).toBe(false); // 1.12.2 invariant untouched
    expect(app._predictiveEcho.clearPredictions).not.toHaveBeenCalled();
  });

  it("codex + setting OFF -> policy 'off' and predictions cleared (kill switch)", () => {
    const app = makeApp('codex') as PredictiveApp;
    app._predictiveEcho = makePredictor();
    app.loadAppSettingsFromStorage = () => ({ localEchoEnabled: false });
    app._updateLocalEchoState();
    expect(app._localEchoPolicy).toBe('off');
    expect(app._predictiveEcho.clearPredictions).toHaveBeenCalled();
  });

  it("shell -> policy 'off'", () => {
    const app = makeApp('shell') as PredictiveApp;
    app._predictiveEcho = makePredictor();
    app._updateLocalEchoState();
    expect(app._localEchoPolicy).toBe('off');
    expect(app._predictiveEcho.clearPredictions).toHaveBeenCalled();
  });

  it.each(['claude', 'gemini', 'opencode', 'pi', 'grok'])(
    "%s -> policy 'buffer' + overlay enabled (existing behavior)",
    (mode) => {
      const overlay = makeOverlay();
      const app = makeApp(mode, overlay) as PredictiveApp;
      app._predictiveEcho = makePredictor();
      app._updateLocalEchoState();
      expect(app._localEchoPolicy).toBe('buffer');
      expect(app._localEchoEnabled).toBe(true);
      expect(overlay.prompts.length).toBeGreaterThan(0); // setPrompt still called
      expect(app._predictiveEcho.clearPredictions).toHaveBeenCalled(); // not predict -> stray spans cleared
    }
  );

  it('no active session -> policy off, no crash without a predictor instance', () => {
    const app = makeApp('codex') as PredictiveApp;
    app._predictiveEcho = null;
    app.activeSessionId = null;
    expect(() => app._updateLocalEchoState()).not.toThrow();
    expect(app._localEchoPolicy).toBe('off');
  });
});

describe('_predictHookOnData (wire neutrality)', () => {
  function makePredictApp(): PredictiveApp {
    const app = makeApp('codex') as PredictiveApp;
    app._predictiveEcho = makePredictor();
    app._updateLocalEchoState(); // -> 'predict'
    return app;
  }

  it('routes char/backspace/clear kinds to the predictor', () => {
    const app = makePredictApp();
    app._predictHookOnData('h');
    expect(app._predictiveEcho!.predictChar).toHaveBeenCalledWith('h');
    app._predictHookOnData('\x7f');
    expect(app._predictiveEcho!.predictBackspace).toHaveBeenCalled();
    app._predictHookOnData('\r');
    expect(app._predictiveEcho!.clearPredictions).toHaveBeenCalled();
  });

  it("kind 'text' (plain paste, IME commit) clears the run like 'clear'", () => {
    // Review finding: an IME word-commit changes the composer without a
    // prediction; new predictions after it would mis-anchor until cascade.
    const app = makePredictApp();
    app._predictHookOnData('pasted text');
    expect(app._predictiveEcho!.predictChar).not.toHaveBeenCalled();
    expect(app._predictiveEcho!.clearPredictions).toHaveBeenCalled();
  });

  it('never touches _pendingInput and never sends (visual-only pin)', () => {
    const app = makePredictApp();
    app._pendingInput = 'queued';
    for (const data of ['h', 'i', '\x7f', '\r', '\x1b[A', 'multi char', '\x1b[200~x\x1b[201~']) {
      app._predictHookOnData(data);
    }
    expect(app._pendingInput).toBe('queued');
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it('is inert under buffer/off policies and without a predictor', () => {
    const buffered = makeApp('claude') as PredictiveApp;
    buffered._predictiveEcho = makePredictor();
    buffered._updateLocalEchoState(); // 'buffer'
    buffered._predictHookOnData('h');
    expect(buffered._predictiveEcho.predictChar).not.toHaveBeenCalled();

    const bundleless = makeApp('codex') as PredictiveApp;
    bundleless._predictiveEcho = null;
    bundleless._updateLocalEchoState();
    expect(() => bundleless._predictHookOnData('h')).not.toThrow();
  });

  it('a throwing predictor cannot break the hook (exception pin)', () => {
    const app = makePredictApp();
    app._predictiveEcho!.predictChar.mockImplementation(() => {
      throw new Error('boom');
    });
    app._pendingInput = 'queued';
    expect(() => app._predictHookOnData('h')).not.toThrow();
    expect(app._pendingInput).toBe('queued');
    expect(app.sendInput).not.toHaveBeenCalled();
  });
});

describe('insertTerminalText under predict policy', () => {
  it('routes to sendInput (not the overlay) and clears predictions', () => {
    const overlay = makeOverlay();
    const app = makeApp('codex', overlay) as PredictiveApp;
    app._predictiveEcho = makePredictor();
    app._updateLocalEchoState(); // predict; _localEchoEnabled false
    app.insertTerminalText('path.txt');
    expect(app.sendInput).toHaveBeenCalledWith('path.txt');
    expect(overlay.appendText).not.toHaveBeenCalled();
    expect(app._predictiveEcho.clearPredictions).toHaveBeenCalled();
  });
});

describe('CodemanTerminalInput.cursorViewportRow', () => {
  const cursorViewportRow = terminalInput.cursorViewportRow as (t: unknown) => number | null;
  const term = (viewportY: number, baseY: number, cursorY: number, rows = 24) => ({
    rows,
    buffer: { active: { viewportY, baseY, cursorY } },
  });

  it('equals cursorY while the viewport sits at the bottom', () => {
    expect(cursorViewportRow(term(10, 10, 3))).toBe(3);
  });

  it('shifts by baseY - viewportY when the viewport is parked above the bottom', () => {
    // scrollToLastNonEmptyLine() parked the viewport at 47 of a baseY of 83: the
    // cursor on line 83 is screen row 36, where a bare cursorY would say row 0
    expect(cursorViewportRow(term(47, 83, 0, 38))).toBe(36);
  });

  it('is null once the cursor row is scrolled off screen', () => {
    expect(cursorViewportRow(term(0, 83, 0, 38))).toBeNull();
  });

  it('is null when the buffer is unreadable', () => {
    expect(cursorViewportRow({ rows: 24, buffer: null })).toBeNull();
  });
});

describe('local-echo prompt finders with the viewport parked above the bottom', () => {
  type Finder = { type: string; find: (t: unknown) => { row: number; col: number } | null };
  function finderFor(mode: string): Finder {
    const overlay = makeOverlay();
    const app = makeApp(mode, overlay);
    app._updateLocalEchoState();
    return overlay.prompts[overlay.prompts.length - 1] as Finder;
  }
  function terminal(
    lines: Record<number, string>,
    geom: { viewportY: number; baseY: number; cursorY: number; cursorX?: number; rows?: number; cols?: number }
  ) {
    return {
      rows: geom.rows ?? 38,
      cols: geom.cols ?? 80,
      buffer: {
        active: {
          viewportY: geom.viewportY,
          baseY: geom.baseY,
          cursorY: geom.cursorY,
          cursorX: geom.cursorX ?? 5,
          getLine: (y: number) => (y in lines ? { translateToString: () => lines[y] } : undefined),
        },
      },
    };
  }

  it('claude: the cursor fallback reports the cursor screen row, not cursorY', () => {
    const { find } = finderFor('claude');
    const parked = terminal({ 83: 'user@host:~$ ' }, { viewportY: 47, baseY: 83, cursorY: 0, cursorX: 13 });
    expect(find(parked)).toEqual({ row: 36, col: 13 });
  });

  it('claude: reports no prompt once the cursor row is scrolled off screen', () => {
    const { find } = finderFor('claude');
    expect(find(terminal({ 83: 'user@host:~$ ' }, { viewportY: 0, baseY: 83, cursorY: 0 }))).toBeNull();
  });

  it('claude: a prompt glyph on the cursor row wins over the cursor fallback', () => {
    const { find } = finderFor('claude');
    const parked = terminal({ 83: '\u276f ' }, { viewportY: 47, baseY: 83, cursorY: 0, cursorX: 2 });
    expect(find(parked)).toEqual({ row: 36, col: 2 });
  });

  it('claude: a history glyph right above the live screen is ignored, however close to the cursor', () => {
    const { find } = finderFor('claude');
    // line 82 is scrollback (baseY is 83): one row above the cursor on screen, still not the composer
    const parked = terminal(
      { 82: '\u276f old prompt', 83: 'user@host:~$ ' },
      { viewportY: 47, baseY: 83, cursorY: 0, cursorX: 13 }
    );
    expect(find(parked)).toEqual({ row: 36, col: 13 });
  });

  it('claude: a composer taller than a handful of rows still finds its glyph', () => {
    const { find } = finderFor('claude');
    // glyph on line 70, cursor thirteen continuation rows below it on line 83, all live screen
    const parked = terminal(
      { 70: '\u276f a very long pasted prompt', 83: 'still typing' },
      { viewportY: 47, baseY: 70, cursorY: 13, cursorX: 12 }
    );
    expect(find(parked)).toEqual({ row: 23, col: 2 });
  });

  it('opencode: reads the border on the cursor screen row when parked', () => {
    const { find } = finderFor('opencode');
    const parked = terminal({ 83: '\u2503  hello' }, { viewportY: 47, baseY: 83, cursorY: 0 });
    expect(find(parked)).toEqual({ row: 36, col: 0 });
  });
});
