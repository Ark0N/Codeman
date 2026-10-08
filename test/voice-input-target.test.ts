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

function load(opts: { insertMode?: string; localEcho?: boolean; focused?: string } = {}) {
  const sendInput = vi.fn(async () => {});
  const sendInputAsync = vi.fn();
  const appendText = vi.fn();
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
    sendInput,
    _sendInputAsync: sendInputAsync,
    showToast,
    terminal: { focus: vi.fn() },
    _localEchoEnabled: !!opts.localEcho,
    _localEchoOverlay: opts.localEcho ? { appendText, pendingText: '', clear: vi.fn() } : null,
  };
  if (opts.focused) app._focusedPane = () => ({ sessionId: opts.focused });
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
    document: {
      querySelector: (sel: string) => (sel === '.btn-settings' ? gear : null),
      createElement: () => ({}),
      body: { appendChild: () => {} },
    },
    window: {},
    navigator: {},
  });
  vm.runInContext(`${voiceSource}\nglobalThis.__VoiceInput = VoiceInput;`, context);
  const voice = (context as unknown as { __VoiceInput: Voice }).__VoiceInput;
  // Recording itself is out of scope: start() only has to pick the target.
  voice._resolveProvider = () => 'webspeech';
  voice._startWebSpeech = vi.fn();
  return { voice, app, sendInput, sendInputAsync, appendText, showToast, gear };
}

describe('dictation target', () => {
  it('sends to the session recording started in, even after a tab switch', () => {
    const { voice, app, sendInput, sendInputAsync } = load();
    voice.start();
    app.activeSessionId = 'session-b'; // user switched tabs while speaking

    voice._insertText('fix the login bug');

    expect(sendInputAsync).toHaveBeenCalledWith('session-a', 'fix the login bug', { useMux: true });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps the existing path when the target is still the active session', () => {
    const { voice, sendInput, sendInputAsync } = load();
    voice.start();

    voice._insertText('hello');

    expect(sendInput).toHaveBeenCalledWith('hello');
    expect(sendInputAsync).not.toHaveBeenCalled();
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
    const { voice, appendText, sendInput } = load({ localEcho: true });
    voice.start();

    voice._insertText('typed locally');

    expect(appendText).toHaveBeenCalledWith('typed locally');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('takes its target from the focused pane when one is reported', () => {
    const { voice, sendInputAsync } = load({ focused: 'session-b' });
    voice.start();

    voice._insertText('into pane b');

    expect(sendInputAsync).toHaveBeenCalledWith('session-b', 'into pane b', { useMux: true });
  });

  it('the green send button sends Enter to the dictation target', () => {
    const { voice, app, gear, sendInput, sendInputAsync } = load();
    voice.start();
    voice._insertText('ship it');
    app.activeSessionId = 'session-b';
    const handler = gear.addEventListener.mock.calls.find((c: unknown[]) => c[0] === 'click')?.[1] as () => void;

    handler();

    expect(sendInputAsync).toHaveBeenLastCalledWith('session-a', '\r', { useMux: true });
    // Only the original insert went through sendInput (target was active then).
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('drops dictation for a session that closed meanwhile, with a toast', () => {
    const { voice, app, sendInput, sendInputAsync, showToast } = load();
    voice.start();
    app.activeSessionId = 'session-b';
    (app.sessions as Map<string, unknown>).delete('session-a');

    voice._insertText('too late');

    expect(sendInput).not.toHaveBeenCalled();
    expect(sendInputAsync).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('That session has closed; dictation not sent', 'warning');
  });

  it('refuses to start with no session at all', () => {
    const { voice, app, showToast } = load();
    app.activeSessionId = null;

    voice.start();

    expect(showToast).toHaveBeenCalledWith('No active session', 'warning');
    expect(voice._targetSessionId).toBeNull();
  });
});
