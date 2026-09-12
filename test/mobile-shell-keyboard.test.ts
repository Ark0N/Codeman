/**
 * @fileoverview Shell-specific mobile keyboard bar and its one-shot Ctrl
 * modifier (issue #262).
 *
 * The bar is a `const` singleton in a non-module script, so it is loaded with
 * `vm` against a small fake DOM (no jsdom in this repo), the same approach as
 * test/path-picker-ui.test.ts. What matters here is the state machine: which
 * layout a session gets, when the modifier arms, what byte a keystroke turns
 * into, and every path that must disarm it. Behavior against a real shell
 * (Ctrl+C reaching the PTY) is covered in test/mobile/keyboard.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const keyboardSource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');
const terminalSource = readFileSync(resolve('src/web/public/terminal-ui.js'), 'utf8');

type TerminalInput = { isTerminalFocusOrMouseReport(data: string): boolean };
type TerminalModule = {
  terminalInput: TerminalInput;
  CodemanApp: { prototype: Record<string, (...args: never[]) => unknown> };
  bar: Bar;
};
let terminalModule: TerminalModule | null = null;

/**
 * terminal-ui.js in a vm, with the REAL accessory bar in the same script scope
 * (it is a `const` singleton, so only a shared scope makes the bare
 * `KeyboardAccessoryBar` reference in the CJK path resolve). Its IIFE only
 * needs a window to hang `CodemanTerminalInput` on, but the rest of the file
 * assigns to CodemanApp.prototype at top level, so constants.js + app.js load
 * first — the same recipe as test/local-echo-codex-gating.test.ts.
 */
function loadTerminalModule(): TerminalModule {
  if (terminalModule) return terminalModule;
  const read = (file: string) => readFileSync(resolve(`src/web/public/${file}`), 'utf8');
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
    MobileDetection: { isTouchDevice: () => true, isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
  });
  vm.runInContext(
    `${read('constants.js')}\n${keyboardSource}\n${read('app.js')}\n${terminalSource}\n` +
      `globalThis.__CodemanApp = CodemanApp; globalThis.__bar = KeyboardAccessoryBar;`,
    context
  );
  const exported = context as unknown as { __CodemanApp: TerminalModule['CodemanApp']; __bar: Bar };
  terminalModule = {
    terminalInput: (windowStub as { CodemanTerminalInput?: TerminalInput }).CodemanTerminalInput!,
    CodemanApp: exported.__CodemanApp,
    bar: exported.__bar,
  };
  return terminalModule;
}

function loadTerminalInput(): TerminalInput {
  return loadTerminalModule().terminalInput;
}

type FakeButton = {
  dataset: { action: string };
  classList: { has: Set<string>; toggle(name: string, on: boolean): void; contains(name: string): boolean };
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
};

function fakeButton(action: string): FakeButton {
  const has = new Set<string>();
  return {
    dataset: { action },
    classList: {
      has,
      toggle(name: string, on: boolean) {
        if (on) has.add(name);
        else has.delete(name);
      },
      contains: (name: string) => has.has(name),
    },
    attrs: {},
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
  };
}

/** Fake bar element: tracks the button set parsed out of the assigned HTML. */
function fakeBarElement() {
  let html = '';
  let buttons = new Map<string, FakeButton>();
  const classes = new Set<string>();
  return {
    className: '',
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      // init() calls syncReadMyMind(), which toggles the 🧠 marker class on the
      // bar with an explicit force argument.
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(next: string) {
      html = next;
      buttons = new Map();
      for (const match of next.matchAll(/data-action="([^"]+)"/g)) {
        buttons.set(match[1], fakeButton(match[1]));
      }
    },
    get actions() {
      return [...buttons.keys()];
    },
    querySelector(selector: string) {
      const match = /\[data-action="([^"]+)"\]/.exec(selector);
      return match ? (buttons.get(match[1]) ?? null) : null;
    },
    addEventListener: vi.fn(),
  };
}

type Bar = {
  element: ReturnType<typeof fakeBarElement>;
  _mode: string;
  init(): void;
  setMode(mode: string): void;
  refreshForActiveSession(): void;
  handleAction(action: string, btn?: unknown): void;
  isCtrlArmed(): boolean;
  toggleCtrl(): void;
  clearCtrl(): void;
  consumeCtrl(data: string): string;
  ctrlByteFor(char: string): string | null;
  hide(): void;
  show(): void;
};

function loadBar(sessionMode = 'claude') {
  const app = {
    activeSessionId: 'session-1',
    sessions: new Map<string, { mode: string }>([['session-1', { mode: sessionMode }]]),
    terminal: { focus: vi.fn() },
  };
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, catch: () => {} }));
  const barElement = fakeBarElement();
  const context = vm.createContext({
    app,
    MobileDetection: { isTouchDevice: () => true },
    URLSearchParams,
    fetch: fetchMock,
    document: {
      createElement: () => barElement,
      querySelector: () => ({ parentNode: { insertBefore: vi.fn() } }),
    },
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
  vm.runInContext(`${keyboardSource}\nglobalThis.__bar = KeyboardAccessoryBar;`, context, {
    filename: 'keyboard-accessory.js',
  });
  const bar = (context as unknown as { __bar: Bar }).__bar;
  bar.init();
  return { app, bar, barElement, fetchMock };
}

describe('ctrlByteFor: character to control byte', () => {
  const { bar } = loadBar();

  it.each([
    ['c', '\x03'], // interrupt
    ['d', '\x04'], // EOF
    ['z', '\x1a'], // suspend
    ['r', '\x12'], // reverse search
    ['l', '\x0c'], // clear
    ['a', '\x01'],
    ['e', '\x05'],
    ['w', '\x17'],
    ['u', '\x15'],
    ['k', '\x0b'],
  ])('maps %s to its control byte', (char, byte) => {
    expect(bar.ctrlByteFor(char)).toBe(byte);
  });

  it('maps uppercase the same as lowercase (Ctrl+C == Ctrl+c)', () => {
    expect(bar.ctrlByteFor('C')).toBe('\x03');
    expect(bar.ctrlByteFor('D')).toBe('\x04');
  });

  it('maps the punctuation controls a terminal defines', () => {
    expect(bar.ctrlByteFor('@')).toBe('\x00');
    expect(bar.ctrlByteFor('[')).toBe('\x1b'); // Ctrl+[ is Escape
    expect(bar.ctrlByteFor('\\')).toBe('\x1c');
    expect(bar.ctrlByteFor(']')).toBe('\x1d');
    expect(bar.ctrlByteFor('^')).toBe('\x1e');
    expect(bar.ctrlByteFor('_')).toBe('\x1f');
    expect(bar.ctrlByteFor(' ')).toBe('\x00'); // Ctrl+Space = NUL
    expect(bar.ctrlByteFor('?')).toBe('\x7f'); // Ctrl+? = DEL
  });

  it('returns null for characters with no control equivalent', () => {
    // A hardware keyboard types these straight through under Ctrl.
    for (const char of ['1', '9', '.', ',', '/', '-', '=', 'é']) {
      expect(bar.ctrlByteFor(char)).toBeNull();
    }
    expect(bar.ctrlByteFor('ab')).toBeNull();
    expect(bar.ctrlByteFor('')).toBeNull();
  });
});

describe('shell keyboard bar selection', () => {
  it('gives a shell session the terminal bar', () => {
    const { bar, barElement } = loadBar('shell');
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('shell');
    expect(barElement.actions).toEqual([
      'ctrl',
      'esc',
      'tab',
      'scroll-up',
      'scroll-down',
      'arrow-left',
      'arrow-right',
      'paste',
      'dismiss',
    ]);
  });

  it.each(['claude', 'codex', 'opencode', 'gemini', 'antigravity'])('leaves a %s session on the agent bar', (mode) => {
    const { bar, barElement } = loadBar(mode);
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
    expect(barElement.actions).toContain('init');
    expect(barElement.actions).not.toContain('ctrl');
  });

  it('remembers the extended-bar preference across a shell session', () => {
    const { app, bar, barElement } = loadBar('claude');
    bar.setMode('extended');
    expect(bar._mode).toBe('extended');

    app.sessions.set('shell-1', { mode: 'shell' });
    app.activeSessionId = 'shell-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('shell');

    // Settings saved while the shell bar is up must not yank it away...
    bar.setMode('extended');
    expect(bar._mode).toBe('shell');

    // ...and switching back to the agent session restores the user's choice.
    app.activeSessionId = 'session-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('extended');
    expect(barElement.actions).toContain('compact');
  });

  it('falls back to the agent bar with no active session', () => {
    const { app, bar } = loadBar('shell');
    app.activeSessionId = null as unknown as string;
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
  });
});

describe('one-shot Ctrl modifier', () => {
  function shellBar() {
    const loaded = loadBar('shell');
    loaded.bar.refreshForActiveSession();
    return loaded;
  }

  it('is disarmed until the Ctrl key is tapped', () => {
    const { bar } = shellBar();
    expect(bar.isCtrlArmed()).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('arms visibly and rewrites the next character as its control byte', () => {
    const { bar, barElement } = shellBar();
    bar.handleAction('ctrl');

    expect(bar.isCtrlArmed()).toBe(true);
    const button = barElement.querySelector('[data-action="ctrl"]')!;
    expect(button.classList.contains('armed')).toBe(true);
    expect(button.attrs['aria-pressed']).toBe('true');

    expect(bar.consumeCtrl('c')).toBe('\x03');

    // One shot: spent, and the button says so.
    expect(bar.isCtrlArmed()).toBe(false);
    expect(button.classList.contains('armed')).toBe(false);
    expect(button.attrs['aria-pressed']).toBe('false');
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('sends Ctrl+D for the next key too', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('d')).toBe('\x04');
  });

  it('cancels on a second tap of Ctrl', () => {
    const { bar, barElement } = shellBar();
    bar.handleAction('ctrl');
    bar.handleAction('ctrl');
    expect(bar.isCtrlArmed()).toBe(false);
    expect(barElement.querySelector('[data-action="ctrl"]')!.classList.contains('armed')).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });

  it('passes a character with no control byte through unchanged, spending the modifier', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('7')).toBe('7');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('spends the modifier on a paste instead of leaving it armed for the next keystroke', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.consumeCtrl('git status')).toBe('git status');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('is cancelled by any other accessory key', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    bar.handleAction('esc');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('is cancelled by a session switch', () => {
    const { app, bar } = shellBar();
    bar.handleAction('ctrl');
    expect(bar.isCtrlArmed()).toBe(true);

    app.sessions.set('shell-2', { mode: 'shell' });
    app.activeSessionId = 'shell-2';
    bar.refreshForActiveSession();

    // Same layout, but the modifier must not survive into the next session.
    expect(bar._mode).toBe('shell');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('is cancelled when the keyboard is dismissed', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    bar.hide();
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('drops the armed state when the layout is swapped out from under it', () => {
    const { app, bar } = shellBar();
    bar.handleAction('ctrl');
    app.sessions.set('agent-1', { mode: 'claude' });
    app.activeSessionId = 'agent-1';
    bar.refreshForActiveSession();
    expect(bar._mode).toBe('simple');
    expect(bar.isCtrlArmed()).toBe(false);
    expect(bar.consumeCtrl('c')).toBe('c');
  });
});

describe('terminal input wiring', () => {
  it('applies the modifier in onData after the query-response filter and before the send paths', () => {
    const hook = terminalSource.indexOf('KeyboardAccessoryBar.consumeCtrl(data)');
    const queryFilter = terminalSource.indexOf('shouldSuppressTerminalQueryResponse(data)', hook - 4000);
    const firstSend = terminalSource.indexOf('this._lastTerminalData', hook - 4000);

    expect(hook).toBeGreaterThan(0);
    // xterm answers DA/CPR queries through onData as well; letting one of those
    // spend the modifier would silently eat the user's Ctrl.
    expect(queryFilter).toBeGreaterThan(0);
    expect(queryFilter).toBeLessThan(hook);
    // Every send path (local echo, predictive echo, plain flush) reads `data`
    // after this point, so the control byte reaches the PTY unchanged.
    expect(firstSend).toBeGreaterThan(hook);
  });

  it('guards the hook so a page without the bar (desktop) still types normally', () => {
    expect(terminalSource).toContain("typeof KeyboardAccessoryBar !== 'undefined'");
  });

  it('skips terminal-generated focus and mouse reports', () => {
    // Pins the gate itself: without it the modifier is spent by the `\x1b[I`
    // that the Ctrl button's own refocus emits (see the describe below).
    expect(terminalSource).toContain('!window.CodemanTerminalInput?.isTerminalFocusOrMouseReport(data)');
  });
});

describe('CodemanTerminalInput.isTerminalFocusOrMouseReport', () => {
  const isReport = loadTerminalInput().isTerminalFocusOrMouseReport;

  it.each([
    ['\x1b[I', 'focus in (DECSET 1004)'],
    ['\x1b[O', 'focus out (DECSET 1004)'],
    ['\x1b[<0;10;5M', 'SGR mouse press'],
    ['\x1b[<0;10;5m', 'SGR mouse release'],
    ['\x1b[<64;10;5M', 'SGR wheel up'],
    ['\x1b[M !!', 'legacy X10 mouse'],
  ])('classifies %j as terminal-generated (%s)', (data) => {
    expect(isReport(data)).toBe(true);
  });

  it.each([
    ['c', 'a typed character'],
    ['\x03', 'a control byte'],
    ['\r', 'Enter'],
    ['\x1b', 'the Escape key'],
    ['\x1b[A', 'an arrow key'],
    ['\x1b[200~hi\x1b[201~', 'a bracketed paste'],
    ['\x1b[?1;2c', 'a DA reply'],
    ['I', 'the letter I'],
  ])('leaves %j alone (%s)', (data) => {
    expect(isReport(data)).toBe(false);
  });
});

describe('one-shot Ctrl vs terminal-generated reports', () => {
  // The onData gate, as terminal-ui.js writes it. The wiring test above pins
  // the real source; this proves the behavior the gate buys.
  function feed(bar: Bar, data: string): string {
    const isReport = loadTerminalInput().isTerminalFocusOrMouseReport;
    return bar.isCtrlArmed() && !isReport(data) ? bar.consumeCtrl(data) : data;
  }

  function shellBar() {
    const loaded = loadBar('shell');
    loaded.bar.refreshForActiveSession();
    return loaded;
  }

  it('survives a tap once an app in the pane turns mouse reporting on', () => {
    const { bar } = shellBar();
    // The live case: a shell session keeps the narrow scrollback strip, so mouse
    // DECSETs reach the browser. Measured against a real shell with vim-style
    // tracking on, one tap on the terminal spent the armed modifier silently.
    bar.handleAction('ctrl');
    expect(feed(bar, '\x1b[<0;10;5M')).toBe('\x1b[<0;10;5M');
    expect(feed(bar, '\x1b[<0;10;5m')).toBe('\x1b[<0;10;5m');
    expect(bar.isCtrlArmed()).toBe(true);

    // ...so the character the user actually types is still the one modified.
    expect(feed(bar, 'd')).toBe('\x04');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('survives a focus report, should one ever reach xterm', () => {
    // Defense in depth: FOCUS_ESCAPE_FILTER (session.ts) strips `\x1b[?1004h`
    // from every PTY read, so sendFocusMode never turns on today. If it did,
    // the bar's own post-key refocus would emit `\x1b[I` and eat the modifier
    // before the user typed a single character.
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(feed(bar, '\x1b[I')).toBe('\x1b[I');
    expect(bar.isCtrlArmed()).toBe(true);
    expect(feed(bar, 'c')).toBe('\x03');
  });

  it('still spends the modifier on a paste, which is real input', () => {
    const { bar } = shellBar();
    bar.handleAction('ctrl');
    expect(feed(bar, 'git status')).toBe('git status');
    expect(bar.isCtrlArmed()).toBe(false);
  });
});

describe('one-shot Ctrl through the CJK input field', () => {
  // The CJK textarea swallows keystrokes before onData sees them, so the CJK
  // send path needs the modifier applied too. These drive the REAL
  // _handleCjkInput against the REAL bar, both loaded into one vm scope.
  function cjkApp() {
    const { CodemanApp, bar } = loadTerminalModule();
    bar.clearCtrl();
    const app = Object.create(CodemanApp.prototype) as {
      activeSessionId: string;
      _sendInputAsync: ReturnType<typeof vi.fn>;
      _handleCjkInput(text: string): void;
    };
    app.activeSessionId = 'cjk-session';
    app._sendInputAsync = vi.fn();
    return { app, bar };
  }

  it('sends the control byte for a character typed into the CJK field', () => {
    const { app, bar } = cjkApp();
    bar.toggleCtrl();
    app._handleCjkInput('c');
    expect(app._sendInputAsync).toHaveBeenCalledWith('cjk-session', '\x03');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('leaves ordinary CJK input untouched when nothing is armed', () => {
    const { app } = cjkApp();
    app._handleCjkInput('你好');
    expect(app._sendInputAsync).toHaveBeenCalledWith('cjk-session', '你好');
  });

  it('spends the modifier on a committed IME word instead of stranding it', () => {
    // The gap this closes: with the field focused the modifier could neither
    // fire nor be spent, so it survived to bite a later innocent keystroke.
    const { app, bar } = cjkApp();
    bar.toggleCtrl();
    app._handleCjkInput('你好');
    expect(app._sendInputAsync).toHaveBeenCalledWith('cjk-session', '你好');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('spends the modifier on Enter, like every other non-character key', () => {
    const { app, bar } = cjkApp();
    bar.toggleCtrl();
    app._handleCjkInput('\r');
    expect(app._sendInputAsync).toHaveBeenCalledWith('cjk-session', '\r');
    expect(bar.isCtrlArmed()).toBe(false);
  });

  it('drops the input, and does not spend the modifier, with no active session', () => {
    const { app, bar } = cjkApp();
    (app as unknown as { activeSessionId: string | null }).activeSessionId = null;
    bar.toggleCtrl();
    app._handleCjkInput('c');
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(bar.isCtrlArmed()).toBe(true);
  });
});

describe('armed styling survives the light-skin overrides', () => {
  const mobileCss = readFileSync(resolve('src/web/public/mobile.css'), 'utf8');

  it('excludes .armed from the light-skin .accessory-btn repaint', () => {
    // That selector is (0,3,1): `:is()` takes the specificity of its most
    // specific argument and the list holds `.btn-toolbar.btn-shell`. It
    // therefore OUTRANKS the (0,3,0) armed rules in both stylesheets, and a
    // bare `.accessory-btn` there paints the armed modifier back to a resting
    // button on all four light skins (measured across every skin at 390px).
    const lightSkinRule = mobileCss
      .split('\n')
      .find((line) => line.includes('[data-skin="paper-gray"]') && line.includes('.btn-voice-mobile,'));

    expect(lightSkinRule).toBeDefined();
    expect(lightSkinRule).toContain('.accessory-btn:not(.armed)');
  });

  it('keeps an armed rule in both stylesheets', () => {
    // mobile.css hardcodes the phone palette, styles.css carries the
    // skin-aware one for everything wider.
    expect(mobileCss).toContain('.accessory-btn.accessory-btn-ctrl.armed');
    expect(readFileSync(resolve('src/web/public/styles.css'), 'utf8')).toContain(
      '.accessory-btn.accessory-btn-ctrl.armed'
    );
  });
});

describe('composer nav keys from the bar', () => {
  /** loadBar()'s app stub plus the local-echo state the flush path reads. */
  function barWithDraft(draft: string) {
    const loaded = loadBar('claude');
    const overlay = {
      pendingText: draft,
      clear: vi.fn(() => {
        overlay.pendingText = '';
      }),
      suppressBufferDetection: vi.fn(),
    };
    const app = loaded.app as unknown as Record<string, unknown>;
    app._localEchoEnabled = true;
    app._localEchoOverlay = overlay;
    app.sendInput = vi.fn();
    app._flushedOffsets = new Map([['session-1', 3]]);
    app._flushedTexts = new Map([['session-1', 'dra']]);
    return { ...loaded, app, overlay };
  }

  const sentKeys = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body).input);

  it.each(['simple', 'extended'])('exposes Shift arrows in the %s agent layout', (mode) => {
    const { bar, barElement } = loadBar('codex');
    bar.setMode(mode);
    expect(barElement.actions).toContain('shift-left');
    expect(barElement.actions).toContain('shift-right');
  });

  it.each([
    ['shift-left', '\x1b[1;2D'],
    ['shift-right', '\x1b[1;2C'],
  ])('%s flushes the draft before navigation and hands editing to the PTY', (action, sequence) => {
    const { bar, app, overlay, fetchMock } = barWithDraft('unfinished follow-up');
    const events: string[] = [];
    app.sendInput = vi.fn(() => events.push('draft'));
    fetchMock.mockImplementation(() => {
      events.push('key');
      return Promise.resolve({ ok: true, catch: () => {} });
    });

    bar.handleAction(action);

    expect(app.sendInput).toHaveBeenCalledWith('unfinished follow-up');
    expect(events).toEqual(['draft', 'key']);
    expect(sentKeys(fetchMock)).toEqual([sequence]);
    expect(overlay.pendingText).toBe('');
    expect([...(app._echoPassthroughSessions as Set<string>)]).toEqual(['session-1']);
  });

  it('flushes the unsent draft before sending the arrow', () => {
    // On a phone the typed text lives in the overlay and has NEVER reached the
    // PTY, so an arrow sent on its own arrives at a composer the CLI still
    // considers empty: Up recalls a history entry into it while the overlay
    // goes on painting the draft over the same row and still believes it is
    // pending. Flushing first is also what makes the draft recoverable: the
    // CLI stashes the live composer and hands it back on Down.
    const { bar, app, overlay, fetchMock } = barWithDraft('draft I typed');

    bar.handleAction('scroll-up');

    expect(app.sendInput).toHaveBeenCalledWith('draft I typed');
    expect(sentKeys(fetchMock)).toEqual(['\x1b[A']);
    expect(overlay.pendingText).toBe('');
    expect(overlay.suppressBufferDetection).toHaveBeenCalled();
    // The overlay's bookkeeping for this session has to go with it.
    expect((app._flushedOffsets as Map<string, number>).has('session-1')).toBe(false);
    expect((app._flushedTexts as Map<string, string>).has('session-1')).toBe(false);
  });

  it('hands the session to plain PTY echo, like a typed nav key does', () => {
    // After a nav key the real cursor can sit mid-text, where the overlay's
    // append-only buffering cannot track edits (issue #218). terminal-ui.js's
    // onData branch does exactly this for a nav key typed on a keyboard.
    const { bar, app } = barWithDraft('');

    bar.handleAction('arrow-left');

    expect([...(app._echoPassthroughSessions as Set<string>)]).toEqual(['session-1']);
  });

  it('sends all four arrows and skips the flush when there is no draft', () => {
    const { bar, app, fetchMock } = barWithDraft('');

    bar.handleAction('scroll-up');
    bar.handleAction('scroll-down');
    bar.handleAction('arrow-left');
    bar.handleAction('arrow-right');

    expect(sentKeys(fetchMock)).toEqual(['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
    expect(app.sendInput).not.toHaveBeenCalled();
  });
});
