import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  let now = 1_000;
  let keyboardVisible = false;
  let activeElement: unknown = null;
  // The module hangs its constants off window (CodemanTerminalInput) and the URL branch of
  // the link provider opens through window.open, so tests need a handle on the same object.
  const windowRef: Record<string, any> = {};
  const context = vm.createContext({
    window: windowRef,
    document: {
      body: { classList: { contains: () => false } },
      get activeElement() {
        return activeElement;
      },
      getElementById: () => null,
    },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => now },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => 'blob:yield',
      revokeObjectURL: () => {},
    },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: {
      isTouchDevice: () => true,
    },
    KeyboardHandler: {
      get keyboardVisible() {
        return keyboardVisible;
      },
    },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  // constants.js first: the link provider calls absoluteFilePathPattern() and
  // previewsInFileViewer() at scan time, and the SHIPPED definitions are what keep a tap and
  // a hover resolving the same links.
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(constants, context, { filename: 'constants.js' });
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  return {
    app,
    windowRef,
    setNow: (value: number) => {
      now = value;
    },
    setKeyboardVisible: (visible: boolean) => {
      keyboardVisible = visible;
    },
    setActiveElement: (element: unknown) => {
      activeElement = element;
    },
  };
}

function createElementHarness() {
  const listeners = new Map<string, (ev: any) => void>();
  return {
    element: {
      addEventListener: vi.fn((type: string, listener: (ev: any) => void) => {
        listeners.set(type, listener);
      }),
    },
    dispatch(type: string, event: any) {
      listeners.get(type)?.(event);
    },
  };
}

function createTerminalGrid(lines: string[], cursorY: number, wrappedRows = new Set<number>()) {
  const textarea = {
    classList: { contains: (name: string) => name === 'xterm-helper-textarea' },
    blur: vi.fn(),
  };
  return {
    cols: 80,
    rows: lines.length,
    modes: { mouseTrackingMode: 'none' },
    buffer: {
      active: {
        viewportY: 0,
        baseY: 0,
        length: lines.length,
        cursorY,
        getLine: (row: number) =>
          row >= 0 && row < lines.length
            ? {
                isWrapped: wrappedRows.has(row),
                // xterm pads an UNTRIMMED row to the full width; the selection offset
                // math is linear over joined rows and would shift without it.
                translateToString: (trim?: boolean) => (trim === false ? lines[row].padEnd(80) : lines[row]),
              }
            : undefined,
      },
    },
    select: vi.fn(),
    clearSelection: vi.fn(),
    hasSelection: () => false,
    getSelectionPosition: () => undefined,
    element: {
      querySelector: (selector: string) =>
        selector === '.xterm-screen' ? { getBoundingClientRect: () => ({ left: 0, top: 0 }) } : null,
    },
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    textarea,
    focus: vi.fn(),
  };
}

describe('terminal touch tap mouse guard', () => {
  it('recognizes focus only when a terminal input owns the active element', () => {
    const { app, setActiveElement } = loadTerminalUiHarness();
    const textarea = { classList: { contains: () => true } };
    app.terminal = { textarea };

    setActiveElement(null);
    expect(app._isMobileTerminalInputFocused()).toBe(false);

    setActiveElement(textarea);
    expect(app._isMobileTerminalInputFocused()).toBe(true);
  });

  it('routes a readback row to the TUI while keeping the prompt row as keyboard input', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'codex', cliMouseTracking: true }]]);
    app.terminal = createTerminalGrid(
      ['Agent readback mentions › inline', '  tap to collapse', '', '', '› ask', 'gpt-5 · Context 80% left'],
      4
    );

    expect(app._classifyMobileTerminalTap(9, 1)).toBe('content'); // inline marker is not a prompt
    expect(app._classifyMobileTerminalTap(9, 17)).toBe('content'); // row 2: readback
    expect(app._classifyMobileTerminalTap(9, 65)).toBe('input'); // row 5: prompt
    expect(app._classifyMobileTerminalTap(9, 81)).toBe('content'); // row 6: status
  });

  it('classifies Claude background-agent status as content rather than keyboard input', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.220', cliMouseTracking: true }]]);
    app.terminal = createTerminalGrid(
      ['', '', '', '• Working (1m 50s • esc to ', 'interrupt) · 1 background teammate', ''],
      4,
      new Set([4])
    );

    expect(app._classifyMobileTerminalTap(9, 65)).toBe('content');
  });

  it('keeps the live cursor focusable when Claude temporarily omits its prompt glyph', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app.terminal = createTerminalGrid(['Prior response', '', 'ready for input', '', 'status footer', ''], 2);

    expect(app._classifyMobileTerminalTap(9, 33)).toBe('input');
    expect(app._classifyMobileTerminalTap(9, 1)).toBe('content');
  });

  it('treats a highlighted numbered choice as TUI content, not an input prompt', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app.terminal = createTerminalGrid(['Would you like to proceed?', '', '❯ 1. Yes', '  2. No', '', ''], 2);

    expect(app._classifyMobileTerminalTap(9, 33)).toBe('content');
    expect(app._classifyMobileTerminalTap(9, 49)).toBe('content');
  });

  it('keeps the keyboard reachable while a selection dialog is on screen', () => {
    // The lock this pins: a visible dialog used to make EVERY row of the
    // terminal "actionable" (both menu tests scanned the whole viewport), so
    // every tap blurred and the on-screen keyboard could not be opened until
    // the dialog was answered, leaving tapping an option (the one gesture that
    // commits an answer) as the only thing a phone could do.
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app.terminal = createTerminalGrid(
      ['Do you want to proceed?', '', '❯ 1. Yes', '  2. No, tell Claude what to do', '', ''],
      2
    );
    app._sendInputAsync = vi.fn();
    setActiveElement(null);

    // The dialog's own rows stay TUI-owned: report the tap, keep the keyboard down.
    expect(app._isActionableMobileTerminalTap(9, 33)).toBe(true); // ❯ 1. Yes
    expect(app._isActionableMobileTerminalTap(9, 49)).toBe(true); // 2. No, …
    // Everything else is inert, and must still be able to summon the keyboard.
    expect(app._isActionableMobileTerminalTap(9, 1)).toBe(false); // question title
    expect(app._isActionableMobileTerminalTap(9, 65)).toBe(false); // blank row

    app._handleMobileTerminalTap({ clientX: 9, clientY: 1 }, false);
    expect(app.terminal.focus).toHaveBeenCalledOnce();

    app.terminal.focus.mockClear();
    app._handleMobileTerminalTap({ clientX: 9, clientY: 33 }, false);
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('collapses TUI readback content without opening or retaining the keyboard', () => {
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'codex', cliMouseTracking: true }]]);
    app.terminal = createTerminalGrid(
      ['Agent readback', '  tap to collapse', '', '', '› ask', 'gpt-5 · Context 80% left'],
      4
    );
    app._sendInputAsync = vi.fn();
    setActiveElement(app.terminal.textarea);

    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 17 }, true)).toBe('content');
    expect(app._sendInputAsync).toHaveBeenCalledWith('sess-1', '\x1b[<0;2;2M\x1b[<0;2;2m');
    expect(app.terminal.textarea.blur).toHaveBeenCalledOnce();
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('keeps the first prompt tap focus-only so it cannot activate a CLI row', () => {
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'codex' }]]);
    app.terminal = createTerminalGrid(
      ['Agent readback', '  tap to collapse', '', '', '› ask', 'gpt-5 · Context 80% left'],
      4
    );
    app._sendInputAsync = vi.fn();
    setActiveElement(null);

    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 65 }, false)).toBe('input');
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app.terminal.focus).toHaveBeenCalledOnce();
  });

  it('closes the keyboard on a second tap of INERT transcript content', () => {
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app.terminal = createTerminalGrid(['transcript line', '', '', '', '❯ ', ''], 4);
    app._sendInputAsync = vi.fn();

    // Keyboard DOWN: the tap opens it.
    setActiveElement(null);
    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 1 }, false)).toBe('content');
    expect(app.terminal.focus).toHaveBeenCalledOnce();
    expect(app.terminal.textarea.blur).not.toHaveBeenCalled();

    // Keyboard UP on the same inert row: the tap closes it.
    app.terminal.focus.mockClear();
    setActiveElement(app.terminal.textarea);
    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 1 }, true)).toBe('content');
    expect(app.terminal.textarea.blur).toHaveBeenCalledOnce();
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('keeps the prompt row focusing rather than toggling, so the caret can still be placed', () => {
    // The toggle is scoped to 'content' on purpose: a second tap on the PROMPT
    // must still position the cursor. This is the guarantee that makes the
    // change safe to make, so it is pinned separately.
    const { app, setActiveElement } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal = createTerminalGrid(['transcript line', '', '', '', '❯ ask', ''], 4);
    app._sendInputAsync = vi.fn();

    setActiveElement(app.terminal.textarea);
    expect(app._handleMobileTerminalTap({ clientX: 9, clientY: 65 }, true)).toBe('input');
    expect(app.terminal.textarea.blur).not.toHaveBeenCalled();
    expect(app.terminal.focus).toHaveBeenCalledOnce();
  });

  it('suppresses browser trusted compatibility mouse events during the tap window', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    const event = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it('allows the app synthetic mouse event through the tap window', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    const event = {
      isTrusted: false,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('encodes a tap as an SGR press+release when the server strips mouse DECSETs (claude mode)', () => {
    const { app } = loadTerminalUiHarness();
    const sent: Array<{ id: string; data: string }> = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app._sendInputAsync = (id: string, data: string) => sent.push({ id, data });
    app.terminal = {
      cols: 80,
      rows: 24,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    expect(app._shouldReportMouseToCli()).toBe(true);
    // touch at x=10+8*20+1, y=20+16*5+1 → col 21, row 6 (1-based)
    app._sendSyntheticSgrTap(171, 101);

    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[<0;21;6M\x1b[<0;21;6m' }]);
  });

  it('clamps SGR tap coordinates to the terminal grid', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = {
      cols: 80,
      rows: 24,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._sendSyntheticSgrTap(-50, 99999);

    expect(sent).toEqual(['\x1b[<0;1;24M\x1b[<0;1;24m']);
  });

  it('never hand-reports for a shell session, even with tracking somehow set', () => {
    // Shell DECSETs are NOT stripped (narrow strip), so xterm's own encoder owns
    // the mouse there and a second, hand-encoded report would double-report.
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'shell', cliMouseTracking: true }]]);

    expect(app._shouldReportMouseToCli()).toBe(false);
  });

  it('hand-reports only while the CLI actually has mouse tracking on', () => {
    // The server strips the DECSETs, so xterm can never see them and the browser
    // reported EVERY click. A claude pane sitting at its composer, or one that
    // fell back to a shell prompt, was receiving mouse reports it never asked
    // for; a shell prints those as literal text and they garble the next line.
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';

    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    expect(app._shouldReportMouseToCli()).toBe(false);

    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: false }]]);
    expect(app._shouldReportMouseToCli()).toBe(false);

    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    expect(app._shouldReportMouseToCli()).toBe(true);
  });

  it('desktop click: sends nothing while the CLI has no mouse mode on', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = createTerminalGrid(['some output', '', '\u276f '], 2);
    app._linkHovered = false;

    app._handleDesktopTerminalClick({
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 40,
      clientY: 10,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
    });

    expect(sent).toEqual([]);
  });

  it('desktop click: encodes SGR press+release for a plain left-click in strip mode', () => {
    const { app } = loadTerminalUiHarness();
    const sent: Array<{ id: string; data: string }> = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app._sendInputAsync = (id: string, data: string) => sent.push({ id, data });
    app.terminal = {
      cols: 80,
      rows: 24,
      modes: { mouseTrackingMode: 'none' },
      hasSelection: () => false,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._handleDesktopTerminalClick({
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 171,
      clientY: 101,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
    });

    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[<0;21;6M\x1b[<0;21;6m' }]);
  });

  it('desktop click: skips clicks that already have a meaning elsewhere', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    const terminal = () => ({
      cols: 80,
      rows: 24,
      modes: { mouseTrackingMode: 'none' } as { mouseTrackingMode: string },
      hasSelection: () => false,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    });
    const click = (overrides: Record<string, unknown> = {}) => ({
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 50,
      clientY: 50,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
      ...overrides,
    });

    app.terminal = terminal();
    app._handleDesktopTerminalClick(click({ isTrusted: false })); // synthetic
    app._handleDesktopTerminalClick(click({ button: 1 })); // middle button
    app._handleDesktopTerminalClick(click({ detail: 2 })); // double-click word select
    app._handleDesktopTerminalClick(click({ shiftKey: true })); // selection override
    app._handleDesktopTerminalClick(click({ target: { closest: () => null } })); // outside grid

    app.terminal = { ...terminal(), hasSelection: () => true }; // drag-selection just ended
    app._handleDesktopTerminalClick(click());

    app.terminal = { ...terminal(), modes: { mouseTrackingMode: 'vt200' } }; // xterm encoder live
    app._handleDesktopTerminalClick(click());

    app.terminal = terminal();
    app.sessions = new Map([['sess-1', { mode: 'shell' }]]); // not a strip mode
    app._handleDesktopTerminalClick(click());

    expect(sent).toEqual([]);
  });

  it('desktop click: skips the click while a terminal link is hovered (activate() handles it)', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = {
      cols: 80,
      rows: 24,
      modes: { mouseTrackingMode: 'none' },
      hasSelection: () => false,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };
    const click = {
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 50,
      clientY: 50,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
    };

    app._linkHovered = true; // link provider hover() fired — this click opens the link
    app._handleDesktopTerminalClick(click);
    expect(sent).toEqual([]);

    app._linkHovered = false; // leave() fired — plain clicks report again
    app._handleDesktopTerminalClick(click);
    expect(sent).toEqual(['\x1b[<0;7;4M\x1b[<0;7;4m']);
  });

  it('desktop click: skips the compat click that follows a touch tap', () => {
    const { app, setNow } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = {
      cols: 80,
      rows: 24,
      modes: { mouseTrackingMode: 'none' },
      hasSelection: () => false,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };
    const click = {
      isTrusted: true,
      button: 0,
      detail: 1,
      clientX: 50,
      clientY: 50,
      target: { closest: (sel: string) => (sel === '.xterm-screen' ? {} : null) },
    };

    app._suppressTrustedTapMouseEvents(); // touchend just handled the tap
    app._handleDesktopTerminalClick(click);
    expect(sent).toEqual([]);

    setNow(10_000); // window expired — a genuine mouse click reports again
    app._handleDesktopTerminalClick(click);
    expect(sent).toEqual(['\x1b[<0;7;4M\x1b[<0;7;4m']);
  });

  it('tap: does nothing while the viewport is scrolled up into local scrollback', () => {
    const { app } = loadTerminalUiHarness();
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = {
      cols: 80,
      rows: 24,
      buffer: { active: { viewportY: 10, baseY: 50 } }, // scrolled up
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._sendSyntheticSgrTap(50, 50);
    expect(sent).toEqual([]);

    app.terminal.buffer.active.viewportY = 50; // back at the bottom
    app._sendSyntheticSgrTap(50, 50);
    expect(sent).toEqual(['\x1b[<0;7;4M\x1b[<0;7;4m']);
  });

  it('wheel: forwards to the app for verified sessions without Shift, at ANY scroll position', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.187', cliMouseTracking: true }]]);
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };

    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
    expect(app._shouldForwardWheelToApp({ shiftKey: true })).toBe(false); // Shift = local scrollback

    // Scrolled up into local scrollback still forwards. Gating this on the
    // viewport being at the bottom is what let a repaint-mode CLI's own prompt
    // box scroll off the screen: scrollToLastNonEmptyLine() parks the viewport
    // above the bottom, so a tab switch silently pinned the wheel to local
    // scrollback full of stale replayed frames. The wheel handler snaps the
    // viewport back to the bottom before encoding the report instead.
    app.terminal.buffer.active.viewportY = 10;
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
    app.terminal.buffer.active.viewportY = 50;

    app.terminal.modes.mouseTrackingMode = 'vt200'; // xterm's own encoder live
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    app.terminal.modes.mouseTrackingMode = 'none';

    app.sessions = new Map([['sess-1', { mode: 'shell' }]]); // not a strip mode
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
  });

  it('wheel: converts deltaMode line/page units instead of assuming pixels', () => {
    const { app } = loadTerminalUiHarness();
    app.terminal = { rows: 40 };

    // DOM_DELTA_PIXEL (Chrome/WebKit, and every trackpad): ~110px per notch.
    expect(app._wheelScrollLines({ deltaY: 110, deltaX: 0, deltaMode: 0, shiftKey: false })).toBe(4);
    // DOM_DELTA_LINE (Firefox mouse wheel): deltaY is already lines. Read as
    // pixels this rounded to 0 and fell through to the ±1 fallback.
    expect(app._wheelScrollLines({ deltaY: 3, deltaX: 0, deltaMode: 1, shiftKey: false })).toBe(3);
    expect(app._wheelScrollLines({ deltaY: -3, deltaX: 0, deltaMode: 1, shiftKey: false })).toBe(-3);
    // DOM_DELTA_PAGE: one page is one screenful.
    expect(app._wheelScrollLines({ deltaY: 1, deltaX: 0, deltaMode: 2, shiftKey: false })).toBe(40);
    // A pure horizontal swipe must not fall through to a phantom -1.
    expect(app._wheelScrollLines({ deltaY: 0, deltaX: 90, deltaMode: 0, shiftKey: false })).toBe(0);
    // Shift + macOS trackpad reports the magnitude on deltaX (issue #154).
    expect(app._wheelScrollLines({ deltaY: 0, deltaX: -100, deltaMode: 0, shiftKey: true })).toBe(-4);
  });

  it('wheel: gates claude forwarding on CLI version 2.1.187+ (unknown or older stays local)', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };
    const withVersion = (cliVersion?: string) => {
      app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion, cliMouseTracking: true }]]);
      return app._shouldForwardWheelToApp({ shiftKey: false });
    };

    expect(withVersion(undefined)).toBe(false); // banner not parsed yet → assume older
    expect(withVersion('2.1.186')).toBe(false); // last version whose menus capture wheel
    expect(withVersion('2.1.187')).toBe(true); // first version verified safe
    expect(withVersion('2.2.0')).toBe(true);
    expect(withVersion('3.0.0')).toBe(true);
    expect(withVersion('garbage')).toBe(false); // unparseable → assume older
  });

  it('wheel: inline claude (no mouse tracking) keeps the local wheel', () => {
    // Claude 2.1.280's default inline renderer never enables mouse tracking and
    // keeps its transcript in real scrollback, so SGR wheel reports are ignored.
    // Forwarding there made every swipe dead on iOS Safari while codex scrolled.
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.280' }]]);
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.280', cliMouseTracking: false }]]);
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    // Fullscreen (CLAUDE_CODE_NO_FLICKER=1) turns tracking on → forwarding resumes.
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.280', cliMouseTracking: true }]]);
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
  });

  it('wheel: only claude forwards — codex and gemini keep the local wheel', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };

    // Codex used to forward unconditionally, which is PR #227's regression: measured
    // on codex-cli 0.147.0, it never enables mouse tracking and ignores SGR wheel
    // reports outright, so forwarding ate every tick while its real local scrollback
    // (the codex transcript lives there — inline viewport, no in-app pager) sat unused.
    app.sessions = new Map([['sess-1', { mode: 'codex' }]]);
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
    app.sessions = new Map([['sess-1', { mode: 'codex', cliVersion: '9.9.9' }]]); // no version rescues it
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);

    app.sessions = new Map([['sess-1', { mode: 'gemini', cliVersion: '9.9.9' }]]); // unverified TUI
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);
  });

  it('wheel: the local-scrollback opt-out pins the plain wheel to local scrollback (issue #154)', () => {
    const { app } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliVersion: '2.1.187', cliMouseTracking: true }]]);
    app.terminal = {
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { viewportY: 50, baseY: 50 } },
    };

    // Default (setting absent) forwards the plain wheel to the CLI transcript.
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);

    // Opt-out ON → the plain wheel stays on xterm's own scrollback (pre-#144).
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: true });
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(false);

    // OFF again → forwarding resumes.
    app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: false });
    expect(app._shouldForwardWheelToApp({ shiftKey: false })).toBe(true);
  });

  it('wheel: reads the dominant axis under Shift so a macOS trackpad can page scrollback (issue #154)', () => {
    const { app } = loadTerminalUiHarness();

    // Plain vertical wheel: unchanged, driven by deltaY.
    expect(app._wheelScrollLines({ shiftKey: false, deltaX: 0, deltaY: 100 })).toBe(4);
    expect(app._wheelScrollLines({ shiftKey: false, deltaX: 0, deltaY: -50 })).toBe(-2);

    // Shift on a macOS trackpad: deltaY≈0, deltaX carries direction+magnitude.
    // Old code collapsed this to a fixed -1; now it tracks the horizontal delta.
    expect(app._wheelScrollLines({ shiftKey: true, deltaX: -100, deltaY: 0 })).toBe(-4); // scroll up
    expect(app._wheelScrollLines({ shiftKey: true, deltaX: 75, deltaY: 0 })).toBe(3); // scroll down

    // Shift with a real vertical wheel (mouse): deltaY dominates, deltaX ignored.
    expect(app._wheelScrollLines({ shiftKey: true, deltaX: 2, deltaY: 100 })).toBe(4);

    // Sub-25px delta still nudges one line in the gesture's direction.
    expect(app._wheelScrollLines({ shiftKey: true, deltaX: -5, deltaY: 0 })).toBe(-1);
  });

  it('wheel: encodes SGR 64/65 ticks, caps per event, and coalesces into one flush', () => {
    const { app } = loadTerminalUiHarness();
    const sent: Array<{ id: string; data: string }> = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    // Wheel reports flush via the ephemeral (fire-and-forget) path, not the
    // durable queue — so they never show in the pending-bytes indicator (#154).
    app._sendInputEphemeral = (id: string, data: string) => sent.push({ id, data });
    app.terminal = {
      cols: 80,
      rows: 24,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._sendSyntheticSgrWheel(50, 50, -2); // 2 ticks up
    app._sendSyntheticSgrWheel(50, 50, 9); // capped at 5 ticks down
    expect(sent).toEqual([]); // nothing until the flush timer fires

    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[<64;7;4M'.repeat(2) + '\x1b[<65;7;4M'.repeat(5) }]);

    app._flushWheelSgrQueue(); // queue drained — no duplicate send
    expect(sent).toHaveLength(1);
  });

  it('forwarded scrolls (wheel AND touch) snap the viewport home first, then encode SGR ticks', () => {
    const { app } = loadTerminalUiHarness();
    const sent: Array<{ id: string; data: string }> = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputEphemeral = (id: string, data: string) => sent.push({ id, data });
    const scrolledToBottom: boolean[] = [];
    app.terminal = {
      cols: 80,
      rows: 24,
      // Scrolled up into local scrollback: SGR coordinates address the LIVE
      // screen, so the report would hit-test the wrong row without the snap.
      buffer: { active: { viewportY: 10, baseY: 50 } },
      scrollToBottom: () => scrolledToBottom.push(true),
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    };

    app._forwardScrollToApp(50, 50, -3);
    expect(scrolledToBottom).toEqual([true]);
    app._flushWheelSgrQueue();
    expect(sent).toEqual([{ id: 'sess-1', data: '\x1b[<64;7;4M'.repeat(3) }]);

    // Already at the bottom: no snap, just the report.
    app.terminal.buffer.active.viewportY = 50;
    app._forwardScrollToApp(50, 50, 2);
    expect(scrolledToBottom).toHaveLength(1);
    app._flushWheelSgrQueue();
    expect(sent).toHaveLength(2);
  });

  it('allows trusted mouse events after the tap window expires', () => {
    const { app, setNow } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();
    setNow(2_000);

    const event = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});

describe('terminal link tap', () => {
  // xterm resolves a link from mousemove and activates it on mouseup over its SCREEN element.
  // A touch tap produces none of those (touch-action:none and touchstart's preventDefault
  // suppress the compatibility mouse events, the post-tap guard drops the rest, and the
  // synthetic pair this app dispatches for mouse REPORTING lands on the .xterm root, an
  // ancestor of the node the linkifier listens on). So the tap path activates the link
  // itself, through the same provider, or every URL and path in the terminal stays inert on
  // a phone.
  //
  // Grid geometry from createTerminalGrid: 8×16 cells, screen rect at (0,0), viewportY 0 —
  // so 0-based character index i on 0-based row r sits at (i * 8 + 4, r * 16 + 8).
  const at = (index: number, row = 0) => ({ clientX: index * 8 + 4, clientY: row * 16 + 8 });

  /** A claude-mode app with the shipped link provider registered over `lines`. */
  function linkHarness(lines: string[], cursorY = lines.length - 1) {
    const harness = loadTerminalUiHarness();
    const { app, windowRef } = harness;
    const sent: string[] = [];
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude', cliMouseTracking: true }]]);
    app._sendInputAsync = (_id: string, data: string) => sent.push(data);
    app.terminal = createTerminalGrid(lines, cursorY);
    app.terminal.registerLinkProvider = vi.fn();
    app.openFilePreview = vi.fn();
    app.openLogViewerWindow = vi.fn();
    app._isExternalPreviewPath = () => false;
    windowRef.open = vi.fn();
    app.registerFilePathLinkProvider();
    return { app, windowRef, sent };
  }

  it('opens a URL under the finger in a new tab', () => {
    const line = 'Login at https://claude.ai/oauth/authorize?code=true&client_id=abc to finish';
    const { app, windowRef } = linkHarness([line, '', '❯ ']);

    expect(app._handleMobileTerminalTap(at(line.indexOf('https')), false, 'content')).toBe('link');
    expect(windowRef.open).toHaveBeenCalledWith(
      'https://claude.ai/oauth/authorize?code=true&client_id=abc',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('sends no mouse report for the tap it just spent on a link', () => {
    // The CLI must not also see a click there: that is how a tap on a URL printed inside a
    // permission dialog would answer the dialog. Desktop already skips the SGR tap for a
    // hovered link (_handleDesktopTerminalClick).
    const line = 'see https://example.com/x for more';
    const { app, sent } = linkHarness([line, '', '❯ ']);

    expect(app._shouldReportMouseToCli()).toBe(true);
    app._handleMobileTerminalTap(at(line.indexOf('https')), false, 'content');

    expect(sent).toEqual([]);
  });

  it('leaves a tap beside the link as an ordinary tap', () => {
    // Containment is xterm's own rule (flattened cell index), so tap and click agree on
    // where a link ends; a tap on the prose around it keeps its mouse report.
    const line = 'see https://example.com/x for more';
    const { app, windowRef, sent } = linkHarness([line, '', '❯ ']);

    expect(app._handleMobileTerminalTap(at(line.indexOf('for more') + 3), false, 'content')).toBe('content');
    expect(windowRef.open).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('opens a tapped file path in the preview overlay', () => {
    const line = 'wrote the chart to /tmp/out/chart.png just now';
    const { app } = linkHarness([line, '', '❯ ']);

    expect(app._handleMobileTerminalTap(at(line.indexOf('/tmp')), false, 'content')).toBe('link');
    expect(app.openFilePreview).toHaveBeenCalledWith('/tmp/out/chart.png', 'sess-1');
    expect(app.openLogViewerWindow).not.toHaveBeenCalled();
  });

  it('sends a tapped log path to the log viewer', () => {
    const line = 'tail -f /var/log/app.log';
    const { app } = linkHarness([line, '', '❯ ']);

    expect(app._handleMobileTerminalTap(at(line.indexOf('/var')), false, 'content')).toBe('link');
    expect(app.openLogViewerWindow).toHaveBeenCalledWith('/var/log/app.log', 'sess-1');
  });

  it('activates a link in scrollback, where the tap sends no report at all', () => {
    // A scrolled-up tap deliberately reports nothing (it would land on whatever row now
    // occupies the cell), but reading old output and tapping a URL in it is the common case.
    const line = 'docs at https://example.com/guide';
    const { app, windowRef, sent } = linkHarness([line, '', '']);

    expect(app._handleMobileTerminalTap(at(line.indexOf('https')), false, 'history')).toBe('link');
    expect(windowRef.open).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
  });

  it('never hijacks a TUI-owned choice row that happens to carry a path', () => {
    // On a phone the dialog is the only interaction that matters, and its rows routinely
    // name the very file a link would open — answering it must keep winning.
    // ⚠️ The caret is parked on the QUESTION row, not the choice: with the caret on the
    // tapped row this would pass through _tapIsOnCaretLine and pin nothing.
    const line = '❯ 1. Yes, edit /home/user/src/app.ts';
    const { app, windowRef, sent } = linkHarness(['Do you want to make this edit?', line, '  2. No, keep it as is'], 0);

    expect(app._handleMobileTerminalTap(at(line.indexOf('/home'), 1), false, 'content')).toBe('content');
    expect(windowRef.open).not.toHaveBeenCalled();
    expect(app.openFilePreview).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1); // the choice still reaches the CLI
  });

  it('leaves a URL the user typed in the composer editable', () => {
    // Tapping your own prompt text means "put the caret here". Opening it instead would
    // punish the phone gesture for fixing a typo in a pasted link.
    const composer = '❯ summarize https://example.com/guide for me';
    const { app, windowRef, sent } = linkHarness(['earlier output', '', composer], 2);

    expect(app._handleMobileTerminalTap(at(composer.indexOf('https'), 2), true, 'input')).toBe('input');
    expect(windowRef.open).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1); // the tap still positions the caret via the mouse report
  });

  it('activates a link in a plain shell session, where every tap classifies as input', () => {
    // A shell has no TUI to own taps, so _classifyMobileTerminalTap short-circuits to
    // 'input' for the whole screen — gating link taps on the intent would leave every URL
    // in shell output (curl, npm, git remote) inert. The caret line is the real boundary.
    const line = 'remote: https://github.com/Ark0N/Codeman.git';
    const harness = loadTerminalUiHarness();
    const { app, windowRef } = harness;
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'shell' }]]);
    app._sendInputAsync = vi.fn();
    app.terminal = createTerminalGrid([line, '', 'bash-5.3$ '], 2);
    app.terminal.registerLinkProvider = vi.fn();
    windowRef.open = vi.fn();
    app.registerFilePathLinkProvider();

    // No cachedIntent below: real classification runs, and for a shell it answers 'input'.
    const point = at(line.indexOf('https'));
    expect(app._classifyMobileTerminalTap(point.clientX, point.clientY)).toBe('input');
    expect(app._handleMobileTerminalTap(point, false)).toBe('link');
    expect(windowRef.open).toHaveBeenCalledWith(
      'https://github.com/Ark0N/Codeman.git',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('keeps taps working when no provider was ever registered', () => {
    const harness = loadTerminalUiHarness();
    const { app } = harness;
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal = createTerminalGrid(['plain output', '', '❯ '], 2);

    expect(app._terminalLinkAtPoint(4, 8)).toBeNull();
    expect(app._activateTerminalLinkAtPoint(4, 8)).toBe(false);
  });
});

describe('terminal touch selection', () => {
  // Copying from a phone was impossible in three layers at once: `user-select: none`
  // on the whole terminal subtree, a WebGL renderer that draws glyphs as pixels with
  // only the accessibility tree behind them, and xterm's selection being a mouse DRAG
  // while the tap path dispatches a zero-movement mousedown/mouseup pair. The gesture
  // therefore drives xterm's own `select()`, which is renderer-independent.
  //
  // Grid geometry (createTerminalGrid): 80 cols, 8×16 cells, screen rect at (0,0),
  // viewportY 0 — 0-based index i on 0-based row r sits at (i * 8 + 4, r * 16 + 8).
  const at = (index: number, row = 0) => ({ clientX: index * 8 + 4, clientY: row * 16 + 8 });
  const press = (app: any, index: number, row = 0) =>
    app._beginTouchSelection(at(index, row).clientX, at(index, row).clientY);
  const dragTo = (app: any, index: number, row = 0) =>
    app._extendTouchSelection(at(index, row).clientX, at(index, row).clientY);
  const COLS = 80;
  const LINE = 'wrote the chart to /tmp/out/chart.png just now';
  const PATH_AT = LINE.indexOf('/tmp');

  function selectionHarness(lines = [LINE, '', '❯ '], cursorY = 2, wrapped = new Set<number>()) {
    const { app, setNow } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = vi.fn();
    app.terminal = createTerminalGrid(lines, cursorY, wrapped);
    return { app, setNow, select: app.terminal.select as ReturnType<typeof vi.fn> };
  }

  it('selects the whitespace-delimited token under a long press', () => {
    // Whitespace is the only delimiter on purpose: a punctuation-aware word rule
    // cuts a path, a URL or a hash in half, which is exactly what you came to copy.
    const { app, select } = selectionHarness();

    expect(press(app, PATH_AT + 4)).toBe(true);
    expect(select).toHaveBeenCalledWith(PATH_AT, 0, '/tmp/out/chart.png'.length);
  });

  it('swallows a blank-space long press without creating a selection', () => {
    const { app, select } = selectionHarness();
    app._blurMobileTerminalInput = vi.fn();
    app._suppressTrustedTapMouseEvents = vi.fn();
    app._armTouchSelectionFocusGuard = vi.fn();
    app._showTouchSelectionBar = vi.fn();

    expect(press(app, LINE.length + 10)).toBe(false);
    expect(app._blurMobileTerminalInput).toHaveBeenCalledOnce();
    expect(app._suppressTrustedTapMouseEvents).toHaveBeenCalledOnce();
    expect(app._armTouchSelectionFocusGuard).toHaveBeenCalledOnce();
    // touchend keys off this state to preventDefault the compatibility mouse
    // sequence even though blank space produced no selection to keep alive.
    expect(app._touchSelecting).toBe(true);
    expect(app._touchSelectionActive).toBeFalsy();
    expect(app._touchSelectionAnchor).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(app._showTouchSelectionBar).not.toHaveBeenCalled();
  });

  it('grows the selection as the finger drags past the anchor word', () => {
    const { app, select } = selectionHarness();
    press(app, PATH_AT + 4);
    select.mockClear();

    dragTo(app, LINE.length - 1);

    // From the word's start through the cell under the finger, inclusive.
    expect(select).toHaveBeenCalledWith(PATH_AT, 0, LINE.length - PATH_AT);
  });

  it('keeps the anchor word inside the selection when the drag goes backwards', () => {
    const { app, select } = selectionHarness();
    press(app, PATH_AT + 4);
    select.mockClear();

    dragTo(app, 6);

    const wordEnd = PATH_AT + '/tmp/out/chart.png'.length;
    expect(select).toHaveBeenCalledWith(6, 0, wordEnd - 6);
  });

  it('extends across rows, where a linear length is what xterm wants', () => {
    const { app, select } = selectionHarness(['first row text', 'second row text', '❯ '], 2);
    press(app, 0);
    select.mockClear();

    dragTo(app, 5, 1);

    // Row 1 cell 5 is absolute cell 85; the selection runs from 0 through it.
    expect(select).toHaveBeenCalledWith(0, 0, COLS + 6);
  });

  it('Line takes the whole logical line, wraps included, without the padding', () => {
    const wrappedTail = 'tail';
    const { app, select } = selectionHarness(['x'.repeat(COLS), wrappedTail, '❯ '], 2, new Set([1]));
    press(app, 2, 1);
    select.mockClear();

    app._selectTouchSelectionLine();

    expect(select).toHaveBeenCalledWith(0, 0, COLS + wrappedTail.length);
  });

  it('a tap while a selection is up extends it instead of moving the cursor', () => {
    const { app, select } = selectionHarness();
    press(app, PATH_AT + 4);
    select.mockClear();

    expect(app._handleMobileTerminalTap(at(LINE.length - 1), false, 'content')).toBe('select');
    expect(select).toHaveBeenCalledWith(PATH_AT, 0, LINE.length - PATH_AT);
    // and the CLI never sees a click it would act on
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('copies through the shared clipboard path and drops the selection', () => {
    // copyTerminalSelection is the one that falls back to execCommand, which is the
    // only route that works on the plain-HTTP LAN install the installer offers.
    const { app } = selectionHarness();
    app.copyTerminalSelection = vi.fn().mockResolvedValue(true);
    press(app, PATH_AT + 4);

    return app._copyTouchSelection().then(() => {
      expect(app.copyTerminalSelection).toHaveBeenCalledOnce();
      expect(app._touchSelectionActive).toBe(false);
      expect(app._touchSelectionAnchor).toBeNull();
      expect(app.terminal.clearSelection).toHaveBeenCalled();
    });
  });

  it('lifting the finger cannot let a compat mousedown steal focus and drop the selection', () => {
    // The bug this pins: on lift the browser synthesizes a trusted mousedown, xterm
    // focuses on it (keyboard up) and SelectionService resets the model (bar gone).
    // Ending the gesture arms the same guard the tap path uses.
    const { app } = selectionHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal.element = { ...app.terminal.element, addEventListener: element.addEventListener };
    app._installMobileTapMouseGuard();

    press(app, PATH_AT + 4);
    app._endTouchSelectionGesture();

    const ev = { isTrusted: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    dispatch('mousedown', ev);

    expect(ev.preventDefault).toHaveBeenCalledOnce();
    expect(ev.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(app._touchSelecting).toBe(false);
    expect(app._touchSelectionActive).toBe(true); // the selection outlives the gesture
  });

  it('copying does not pop the on-screen keyboard back over the text', () => {
    // copyTerminalSelection hands focus to the terminal, which on a phone means the
    // keyboard covers what you just copied with nothing waiting to be typed.
    const { app } = selectionHarness();
    app.copyTerminalSelection = vi.fn().mockResolvedValue(true);
    press(app, PATH_AT + 4);
    app._blurMobileTerminalInput = vi.fn(); // stubbed AFTER the press, which blurs too

    return app._copyTouchSelection().then(() => {
      expect(app._blurMobileTerminalInput).toHaveBeenCalledOnce();
    });
  });

  it('blurs the terminal input if anything focuses it during the gesture', () => {
    // The one that matters on Android: Chrome runs its own long-press handling at
    // ~500ms and focuses the helper textarea directly — no mouse event to guard, so
    // the keyboard shot up over the selection the instant it appeared.
    const { app, setNow } = selectionHarness();
    const listeners = new Map<string, () => void>();
    app.terminal.textarea = {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      classList: { contains: (n: string) => n === 'xterm-helper-textarea' },
      blur: vi.fn(),
    };
    app._installTouchSelectionFocusGuard();
    press(app, PATH_AT + 4);
    app._endTouchSelectionGesture();

    // Whatever focused it, the guard takes the focus straight back off.
    app._blurMobileTerminalInput = vi.fn();
    listeners.get('focus')?.();
    expect(app._blurMobileTerminalInput).toHaveBeenCalledOnce();

    // …and the guard expires on its own, so a stuck flag can never make the
    // keyboard permanently unreachable.
    setNow(1_000 + 5_000);
    app._blurMobileTerminalInput = vi.fn();
    listeners.get('focus')?.();
    expect(app._blurMobileTerminalInput).not.toHaveBeenCalled();
  });

  it('survives a missing bar container instead of throwing mid-gesture', () => {
    // index.html is read once at server start, so the bar is built in JS — and a
    // solo popup or an early gesture can run before the container exists.
    const { app } = selectionHarness();

    expect(() => app._showTouchSelectionBar()).not.toThrow();
    expect(app._ensureTouchSelectionBar()).toBeNull();
  });
});

describe('terminal wrapped-line handling', () => {
  // Reported from a phone against the shipped fix: an agent's numbered list wraps its
  // URL, and tapping it opened only the part on screen. Ink emits a real newline (so
  // nothing is flagged isWrapped) and indents the continuation under the list marker,
  // so joining the rows verbatim put whitespace inside the URL. "Line" broke the same
  // way, grabbing the one visible row.
  //
  // Grid: 80 cols, 8×16 cells, screen rect at (0,0), viewportY 0.
  const COLS = 80;
  const at = (index: number, row = 0) => ({ clientX: index * 8 + 4, clientY: row * 16 + 8 });
  const press = (app: any, index: number, row = 0) =>
    app._beginTouchSelection(at(index, row).clientX, at(index, row).clientY);
  const HEAD = '1. https://example.com/';
  // Row 0 runs to the last column, which is the only trace a hard wrap leaves.
  const ROW0 = HEAD + 'a'.repeat(COLS - HEAD.length);
  const ROW1 = '   ackage/thing';
  const FULL_URL = 'https://example.com/' + 'a'.repeat(COLS - HEAD.length) + 'ackage/thing';

  function wrappedHarness() {
    const { app, windowRef } = loadTerminalUiHarness();
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app._sendInputAsync = vi.fn();
    app.terminal = createTerminalGrid([ROW0, ROW1, '❯ '], 2);
    app.terminal.registerLinkProvider = vi.fn();
    app.openFilePreview = vi.fn();
    app.openLogViewerWindow = vi.fn();
    app._isExternalPreviewPath = () => false;
    windowRef.open = vi.fn();
    app.registerFilePathLinkProvider();
    return { app, windowRef, select: app.terminal.select as ReturnType<typeof vi.fn> };
  }

  it('opens the WHOLE wrapped URL, not the part on screen', () => {
    const { app, windowRef } = wrappedHarness();

    expect(app._handleMobileTerminalTap(at(HEAD.length + 5), false, 'content')).toBe('link');
    expect(windowRef.open).toHaveBeenCalledWith(FULL_URL, '_blank', 'noopener,noreferrer');
  });

  it('opens the whole URL from the continuation row too', () => {
    // Tapping the second half is the natural gesture when that is what you can see.
    const { app, windowRef } = wrappedHarness();

    expect(app._handleMobileTerminalTap(at(5, 1), false, 'content')).toBe('link');
    expect(windowRef.open).toHaveBeenCalledWith(FULL_URL, '_blank', 'noopener,noreferrer');
  });

  it('selects a token that spans the wrap, across both rows', () => {
    const { app, select } = wrappedHarness();

    press(app, 5, 1); // inside 'ackage/thing' on the continuation row
    // From the URL's first cell (row 0, col 3) through the token's last cell
    // (row 1, col 14). The run covers the indent cells between the halves, because
    // an xterm selection is one contiguous run and a gap cannot be expressed.
    const index = 3;
    const end = COLS + ROW1.length - 1;
    expect(select).toHaveBeenCalledWith(3, 0, end - index + 1);
  });

  it('Line takes every row of a HARD-wrapped line, not just the visible one', () => {
    const { app, select } = wrappedHarness();
    press(app, HEAD.length + 5);
    select.mockClear();

    app._selectTouchSelectionLine();

    // Row 0 col 0 through row 1's last non-blank cell.
    expect(select).toHaveBeenCalledWith(0, 0, COLS + ROW1.length);
  });

  it('does not reach into the next line when a row stops short of the edge', () => {
    // Over-reaching would glue unrelated output into one link or one "Line".
    const { app, select } = loadTerminalUiHarness();
    void select;
    app.activeSessionId = 'sess-1';
    app.sessions = new Map([['sess-1', { mode: 'claude' }]]);
    app.terminal = createTerminalGrid(['short output', 'https://example.com/next', '❯ '], 2);
    app.terminal.registerLinkProvider = vi.fn();
    app.registerFilePathLinkProvider();

    press(app, 2); // inside 'short'
    app._selectTouchSelectionLine();

    expect(app.terminal.select).toHaveBeenCalledWith(0, 0, 'short output'.length);
  });
});
