/**
 * @fileoverview Dictation lands in the session it was started for.
 *
 * `VoiceInput` (voice-input.js) used to read `app.activeSessionId` when the
 * transcript ARRIVED, and again when the green send button or the compose
 * overlay's Send was pressed. Both happen seconds after recording started, so a
 * user who switched tabs in between had their dictation typed into the other
 * session. The target is now captured in `start()` (through `_focusedPane()`,
 * so a second terminal pane can claim it later) and every send path uses it.
 *
 * With the tile grid open the main terminal (and with it the local-echo
 * overlay) is parked with `display: none`, so direct-mode dictation used to be
 * typed into an invisible overlay and never reached the focused tile. While
 * `_tilesOwnTerminal()` is true the overlay is skipped and the keyboard goes
 * back to the focused tile, not the parked main terminal.
 *
 * Loaded via `vm` with a stubbed `app` (no jsdom).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const voiceSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-input.js'), 'utf8');

type Voice = {
  start: () => void;
  _insertText: (text: string) => void;
  _resolveProvider: () => string;
  _startWebSpeech: () => void;
  _showComposeOverlay: (text: string) => void;
  _voiceSendHandler: (() => void) | null;
  _targetSessionId: string | null;
};

type Pane = { sessionId: string; isPrimary?: boolean; terminal?: { focus: () => void } };

function load(opts: { insertMode?: string; localEcho?: boolean; focused?: string; tiles?: boolean; pane?: Pane } = {}) {
  const sendInputAsync = vi.fn();
  const appendText = vi.fn();
  const overlayClear = vi.fn();
  const showToast = vi.fn();
  const gear = {
    classList: { contains: () => false, add: vi.fn(), remove: vi.fn() },
    innerHTML: '',
    title: '',
    getAttribute: () => null,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const app: Record<string, unknown> = {
    activeSessionId: 'session-a',
    sessions: new Map([
      ['session-a', {}],
      ['session-b', {}],
    ]),
    _sendInputAsync: sendInputAsync,
    _enqueueInput: vi.fn(),
    _prepareExternalInput: vi.fn(),
    showToast,
    terminal: { focus: vi.fn() },
    _localEchoEnabled: !!opts.localEcho,
    _localEchoOverlay: opts.localEcho
      ? { appendText, pendingText: '', clear: overlayClear, suppressBufferDetection: vi.fn() }
      : null,
    _predictiveEcho: { clearPredictions: vi.fn() },
  };
  if (opts.focused) app._focusedPane = () => ({ sessionId: opts.focused });
  // A full pane record, as terminal-ui.js _focusedPane() returns it. Reassign
  // app._focusedPane in a test to move focus between panes.
  if (opts.pane) {
    const pane = opts.pane;
    app._focusedPane = () => pane;
  }
  app._paneForSession = (id: string) => (opts.pane?.sessionId === id ? opts.pane : null);
  if (opts.tiles) app._tilesOwnTerminal = () => true;
  const doc = {
    querySelector: (sel: string): unknown => (sel === '.btn-settings' ? gear : null),
    createElement: (): unknown => ({}),
    body: { appendChild: () => {} },
  };
  const context = vm.createContext({
    console,
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    app,
    localStorage: {
      getItem: (key: string) =>
        key === 'codeman-voice-settings' ? JSON.stringify({ insertMode: opts.insertMode || 'direct' }) : null,
      setItem: () => {},
    },
    document: doc,
    window: {},
    navigator: {},
  });
  vm.runInContext(`${voiceSource}\nglobalThis.__VoiceInput = VoiceInput;`, context);
  const voice = (context as unknown as { __VoiceInput: Voice }).__VoiceInput;
  // Recording itself is out of scope: start() only has to pick the target.
  voice._resolveProvider = () => 'webspeech';
  voice._startWebSpeech = vi.fn();
  return { voice, app, sendInputAsync, appendText, overlayClear, showToast, gear, doc };
}

function clickGreenSend(gear: { addEventListener: { mock: { calls: unknown[][] } } }) {
  const handler = gear.addEventListener.mock.calls.find((c: unknown[]) => c[0] === 'click')?.[1] as () => void;
  handler();
}

describe('dictation target', () => {
  it('sends to the session recording started in, even after a tab switch', () => {
    const { voice, app, sendInputAsync } = load();
    voice.start();
    app.activeSessionId = 'session-b'; // user switched tabs while speaking

    voice._insertText('fix the login bug');

    expect(sendInputAsync).toHaveBeenCalledWith('session-a', 'fix the login bug', { useMux: true });
  });

  it('uses the session-bound path even while the target is still active', () => {
    const { voice, app, sendInputAsync } = load({ pane: { sessionId: 'session-a', isPrimary: true } });
    voice.start();

    voice._insertText('hello');

    expect(sendInputAsync).toHaveBeenCalledWith('session-a', 'hello', { useMux: true });
    expect(app._prepareExternalInput).toHaveBeenCalledWith({ sessionId: 'session-a', isPrimary: true }, 'voice-send');
  });

  it('never types another session dictation into the active local-echo overlay', () => {
    const { voice, app, appendText, sendInputAsync } = load({ localEcho: true });
    voice.start();
    app.activeSessionId = 'session-b';

    voice._insertText('for session a');

    expect(appendText).not.toHaveBeenCalled();
    expect(sendInputAsync).toHaveBeenCalledWith('session-a', 'for session a', { useMux: true });
  });

  it('still uses the local-echo overlay for the active session', () => {
    const { voice, app, appendText } = load({
      localEcho: true,
      pane: { sessionId: 'session-a', isPrimary: true },
    });
    voice.start();

    voice._insertText('typed locally');

    expect(appendText).toHaveBeenCalledWith('typed locally');
    expect(app._prepareExternalInput).toHaveBeenCalledWith({ sessionId: 'session-a', isPrimary: true }, 'voice-insert');
  });

  it('takes its target from the focused pane when one is reported', () => {
    const { voice, sendInputAsync } = load({ focused: 'session-b' });
    voice.start();

    voice._insertText('into pane b');

    expect(sendInputAsync).toHaveBeenCalledWith('session-b', 'into pane b', { useMux: true });
  });

  it('the green send button sends Enter to the dictation target', () => {
    const { voice, app, gear, sendInputAsync } = load();
    voice.start();
    voice._insertText('ship it');
    app.activeSessionId = 'session-b';
    const handler = gear.addEventListener.mock.calls.find((c: unknown[]) => c[0] === 'click')?.[1] as () => void;

    handler();

    expect(sendInputAsync).toHaveBeenLastCalledWith('session-a', '\r', { useMux: true });
  });

  it('drops dictation for a session that closed meanwhile, with a toast', () => {
    const { voice, app, sendInputAsync, showToast } = load();
    voice.start();
    app.activeSessionId = 'session-b';
    (app.sessions as Map<string, unknown>).delete('session-a');

    voice._insertText('too late');

    expect(sendInputAsync).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('That session has closed; dictation not sent', 'warning');
  });

  it('with the tile grid open, dictation goes to the focused tile, not the parked overlay', () => {
    const tileTerminal = { focus: vi.fn() };
    const { voice, app, appendText, sendInputAsync } = load({
      localEcho: true,
      tiles: true,
      pane: { sessionId: 'session-a', isPrimary: false, terminal: tileTerminal },
    });
    voice.start();

    voice._insertText('into the tile');

    expect(appendText).not.toHaveBeenCalled();
    expect(sendInputAsync).toHaveBeenCalledWith('session-a', 'into the tile', { useMux: true });
    // The keyboard goes back to the tile; the main terminal is display: none.
    expect(tileTerminal.focus).toHaveBeenCalled();
    expect((app.terminal as { focus: ReturnType<typeof vi.fn> }).focus).not.toHaveBeenCalled();
  });

  it('with the tile grid open, the green send button sends only Enter to the tile session', () => {
    const tileTerminal = { focus: vi.fn() };
    const { voice, app, gear, sendInputAsync, overlayClear } = load({
      localEcho: true,
      tiles: true,
      pane: { sessionId: 'session-a', isPrimary: false, terminal: tileTerminal },
    });
    voice.start();
    voice._insertText('ship it');
    // Something stale in the parked main overlay must not ride along.
    (app._localEchoOverlay as { pendingText: string }).pendingText = 'stale main-terminal text';

    clickGreenSend(gear);

    expect(overlayClear).not.toHaveBeenCalled();
    expect(sendInputAsync).toHaveBeenLastCalledWith('session-a', '\r', { useMux: true });
    // The parked main terminal's predictions are not this pane's.
    expect(
      (app._predictiveEcho as { clearPredictions: ReturnType<typeof vi.fn> }).clearPredictions
    ).not.toHaveBeenCalled();
  });

  it('preserves Pane A pending text and dictation ordering when focus moves to B', () => {
    const paneB = { focus: vi.fn() };
    const { voice, app, appendText, overlayClear, gear, sendInputAsync } = load({
      localEcho: true,
      focused: 'session-a',
    });
    const overlay = app._localEchoOverlay as { pendingText: string };
    overlay.pendingText = 'earlier text ';
    appendText.mockImplementation((text: string) => {
      overlay.pendingText += text;
    });
    overlayClear.mockImplementation(() => {
      overlay.pendingText = '';
    });
    voice.start();
    // Keep B focused even when the production code requests main-terminal focus.
    app._focusedPane = () => ({ sessionId: 'session-b', isPrimary: false, terminal: paneB });

    voice._insertText('for pane a');

    expect(appendText).toHaveBeenCalledWith('for pane a');
    expect(overlay.pendingText).toBe('earlier text for pane a');
    expect(sendInputAsync).not.toHaveBeenCalled();
    expect(app._enqueueInput).not.toHaveBeenCalled();

    clickGreenSend(gear);

    expect(app._enqueueInput).toHaveBeenCalledWith('session-a', [
      { write: 'earlier text for pane a', useMux: true },
      { gap: 80 },
      { write: '\r', useMux: true },
    ]);
    expect(overlay.pendingText).toBe('');
    expect(sendInputAsync).not.toHaveBeenCalled();
    expect(app._prepareExternalInput).toHaveBeenNthCalledWith(
      1,
      { sessionId: 'session-a', isPrimary: true, tile: null, terminal: app.terminal },
      'voice-insert'
    );
    expect(app._prepareExternalInput).toHaveBeenNthCalledWith(
      2,
      { sessionId: 'session-a', isPrimary: true, tile: null, terminal: app.terminal },
      'voice-submit'
    );
    // load() creates this terminal mock; its Record boundary erases the shape.
    const mainTerminal = app.terminal as { focus: (...args: unknown[]) => void };
    expect(mainTerminal.focus).toHaveBeenCalled();
    expect(paneB.focus).not.toHaveBeenCalled();
  });

  it('compose Send delivers only the reviewed dictation and leaves the typed draft in the overlay', () => {
    const { voice, app, appendText, overlayClear, sendInputAsync, doc } = load({
      insertMode: 'compose',
      localEcho: true,
      pane: { sessionId: 'session-a', isPrimary: true },
    });
    const overlay = app._localEchoOverlay as { pendingText: string };
    overlay.pendingText = 'hel';
    const handlers = new Map<string, () => void>();
    const textarea = { value: '', focus: vi.fn(), blur: vi.fn(), selectionStart: 0, selectionEnd: 0 };
    doc.createElement = () => ({
      className: '',
      innerHTML: '',
      remove: vi.fn(),
      addEventListener: vi.fn(),
      querySelector: (sel: string) =>
        sel === 'textarea'
          ? textarea
          : { addEventListener: (_type: string, handler: () => void) => handlers.set(sel, handler) },
    });
    voice.start();

    voice._insertText('Please fix the bug');
    // The dialog's <textarea> gets the text through innerHTML; this stub has no
    // HTML parser, so the user's reviewed text is set directly before Send.
    textarea.value = 'Please fix the bug';
    handlers.get('.paste-send')!();

    expect(sendInputAsync).toHaveBeenCalledOnce();
    expect(sendInputAsync).toHaveBeenCalledWith('session-a', 'Please fix the bug\r', { useMux: true });
    expect(app._prepareExternalInput).toHaveBeenCalledWith({ sessionId: 'session-a', isPrimary: true }, 'voice-send');
    expect(overlay.pendingText).toBe('hel');
    expect(appendText).not.toHaveBeenCalled();
    expect(overlayClear).not.toHaveBeenCalled();
  });

  it('refuses to start with no session at all', () => {
    const { voice, app, showToast } = load();
    app.activeSessionId = null;

    voice.start();

    expect(showToast).toHaveBeenCalledWith('No active session', 'warning');
    expect(voice._targetSessionId).toBeNull();
  });
});
