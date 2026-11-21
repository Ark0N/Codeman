/**
 * @fileoverview Fast VM/static regressions for the shared filesystem picker and
 * extended mobile keyboard actions. No browser or real server required.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const keyboardSource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');
const terminalSource = readFileSync(resolve('src/web/public/terminal-ui.js'), 'utf8');
const sessionSource = readFileSync(resolve('src/web/public/session-ui.js'), 'utf8');
const indexSource = readFileSync(resolve('src/web/public/index.html'), 'utf8');

function loadTerminalMixin() {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> };
  const cjkClear = vi.fn();
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    CjkInput: { clear: cjkClear },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
  });
  vm.runInContext(terminalSource, context, { filename: 'terminal-ui.js' });
  return { mixin: FakeCodemanApp.prototype, cjkClear };
}

const terminalHarness = loadTerminalMixin();

function loadKeyboardModule() {
  const app = {
    activeSessionId: 'session-1',
    sessions: new Map([['session-1', { workingDir: '/mnt/d/AI' }]]),
    terminal: { focus: vi.fn() },
    clearTerminalInput: vi.fn(),
    insertTerminalText: vi.fn(),
    _enqueueInput: vi.fn(),
    _sendInputAsync: vi.fn(),
    _focusedPane: () => ({ sessionId: 'session-1', isPrimary: true }),
    _paneForSession: (sessionId: string) => ({ sessionId, isPrimary: true }),
    _localEchoEnabled: false,
    _localEchoPolicy: 'off',
    _predictiveEcho: { clearPredictions: vi.fn() },
    _localEchoOverlay: { appendText: vi.fn() },
    _prepareExternalInput: vi.fn(),
  };
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  const context = vm.createContext({
    app,
    MobileDetection: { isTouchDevice: () => false },
    URLSearchParams,
    fetch: fetchMock,
    document: {},
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
  vm.runInContext(
    `${keyboardSource}\nglobalThis.__bar = KeyboardAccessoryBar; globalThis.__picker = PathPicker;`,
    context
  );
  return {
    app,
    fetchMock,
    bar: (context as unknown as { __bar: { handleAction(action: string): void } }).__bar,
    picker: (context as unknown as { __picker: { open: ReturnType<typeof vi.fn> } }).__picker,
  };
}

describe('accessory Tab key', () => {
  it('replaced /clear in the simple bar; /clear stays extended-only', () => {
    const simple = keyboardSource.slice(
      keyboardSource.indexOf('_simpleButtons'),
      keyboardSource.indexOf('_extendedButtons')
    );
    expect(simple).toContain('data-action="tab"');
    expect(simple).not.toContain('data-action="clear" title="/clear"');
    expect(simple).not.toContain('data-action="compact"');
  });

  it('sends a bare \\t when nothing is buffered locally', () => {
    const { app, bar, fetchMock } = loadKeyboardModule();
    bar.handleAction('tab');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(app._enqueueInput).toHaveBeenCalledWith('session-1', [{ write: '\t' }]);
  });

  it('prepares the native owner before sending to the captured session', () => {
    const { app, bar } = loadKeyboardModule();
    Object.assign(app, {
      _localEchoEnabled: true,
      _localEchoOverlay: { pendingText: 'queued text', clear: vi.fn() },
    });
    app._prepareExternalInput.mockImplementation(() => {
      app.activeSessionId = 'session-2';
    });
    bar.handleAction('tab');
    expect(app._prepareExternalInput).toHaveBeenCalledWith(
      { sessionId: 'session-1', isPrimary: true },
      'accessory-key'
    );
    expect(app._enqueueInput).toHaveBeenCalledExactlyOnceWith('session-1', [
      { write: 'queued text', useMux: true },
      { gap: 120 },
      { write: '\t' },
    ]);
    expect(app._prepareExternalInput.mock.invocationCallOrder[0]).toBeLessThan(
      app._enqueueInput.mock.invocationCallOrder[0]
    );
  });

  it('flushes locally-buffered prompt text to the PTY before sending Tab', () => {
    const { app, bar, fetchMock } = loadKeyboardModule() as ReturnType<typeof loadKeyboardModule> & {
      app: Record<string, unknown>;
    };
    const overlay = {
      pendingText: 'git sta',
      clear: vi.fn(),
      suppressBufferDetection: vi.fn(),
    };
    Object.assign(app, {
      _localEchoEnabled: true,
      _localEchoOverlay: overlay,
      _flushedOffsets: new Map([['session-1', 3]]),
      _flushedTexts: new Map([['session-1', 'git']]),
    });

    bar.handleAction('tab');

    expect(overlay.clear).toHaveBeenCalledOnce();
    expect(overlay.suppressBufferDetection).toHaveBeenCalledOnce();
    expect((app as { _flushedOffsets: Map<string, number> })._flushedOffsets.has('session-1')).toBe(false);
    expect((app as { _flushedTexts: Map<string, string> })._flushedTexts.has('session-1')).toBe(false);
    expect(app._enqueueInput).toHaveBeenCalledWith('session-1', [
      { write: 'git sta', useMux: true },
      { gap: 120 },
      { write: '\t' },
    ]);
  });
});

describe('toolbar Enter', () => {
  it('uses semantic submit instead of replaying native textarea data', () => {
    const context = vm.createContext({ CodemanApp: function () {} });
    vm.runInContext(`${sessionSource}\nglobalThis.__mixin = CodemanApp.prototype;`, context);
    const submitFromToolbar = vi.fn();
    context.__mixin.sendEnterKey.call({ submitFromToolbar });
    expect(submitFromToolbar).toHaveBeenCalledOnce();
  });
});

describe('mobile filesystem picker actions', () => {
  it('keeps clear-input separate from the destructive /clear command', () => {
    const { app, bar } = loadKeyboardModule();
    bar.handleAction('clear-input');

    expect(app.clearTerminalInput).toHaveBeenCalledOnce();
    expect(keyboardSource).toContain('data-action="clear-input"');
    expect(keyboardSource).toContain('data-action="clear" title="/clear"');
  });

  it('opens at the active working directory and inserts the selected path without Enter', () => {
    const { app, bar, picker } = loadKeyboardModule();
    picker.open = vi.fn();

    bar.handleAction('pick-path');

    expect(picker.open).toHaveBeenCalledOnce();
    const options = picker.open.mock.calls[0][0];
    expect(options).toMatchObject({
      sessionId: 'session-1',
      initialPath: '/mnt/d/AI',
      directoriesOnly: false,
    });
    options.onSelect('/mnt/d/AI/project/file.ts');
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '/mnt/d/AI/project/file.ts', { useMux: true });
  });

  it.each([false, true])('clears primary predictions before inserting a path (buffered=%s)', (buffered) => {
    const { app, bar, picker } = loadKeyboardModule();
    app._localEchoPolicy = 'predict';
    app._localEchoEnabled = buffered;
    picker.open = vi.fn();
    bar.handleAction('pick-path');

    picker.open.mock.calls[0][0].onSelect('/project/file.ts');

    expect(app._predictiveEcho.clearPredictions).toHaveBeenCalledOnce();
    const insert = buffered ? app._localEchoOverlay.appendText : app._sendInputAsync;
    expect(app._predictiveEcho.clearPredictions.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0]
    );
  });

  it.each([false, true])(
    'appends a picked path to the destination primary overlay without flushing (focus moved=%s)',
    (moved) => {
      const { app, bar, picker } = loadKeyboardModule();
      app._localEchoEnabled = true;
      picker.open = vi.fn();
      bar.handleAction('pick-path');
      if (moved) app._focusedPane = () => ({ sessionId: 'tile-2', isPrimary: false });
      picker.open.mock.calls[0][0].onSelect('/project/file.ts');
      expect(app._prepareExternalInput).toHaveBeenCalledWith(
        { sessionId: 'session-1', isPrimary: true },
        'accessory-path'
      );
      expect(app._localEchoOverlay.appendText).toHaveBeenCalledWith('/project/file.ts');
      expect(app._sendInputAsync).not.toHaveBeenCalled();
      expect(app.terminal.focus).toHaveBeenCalledOnce();
    }
  );

  it('prepares an unfocused tile destination with flushEcho before directly writing its path', () => {
    const { app, bar, picker } = loadKeyboardModule();
    app._localEchoEnabled = true;
    app._focusedPane = () => ({ sessionId: 'tile-2', isPrimary: false });
    app._paneForSession = (sessionId: string) => ({ sessionId, isPrimary: false });
    picker.open = vi.fn();
    bar.handleAction('pick-path');
    app._focusedPane = () => ({ sessionId: 'session-1', isPrimary: true });
    picker.open.mock.calls[0][0].onSelect('/project/file.ts');
    expect(app._prepareExternalInput).toHaveBeenCalledWith(
      { sessionId: 'tile-2', isPrimary: false },
      'accessory-path',
      { flushEcho: true }
    );
    expect(app._sendInputAsync).toHaveBeenCalledWith('tile-2', '/project/file.ts', { useMux: true });
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
  });

  it('wires Link Existing to the shared folder-only picker', () => {
    expect(indexSource).toContain('onclick="app.openLinkCasePathPicker()"');
    expect(indexSource).toContain('id="linkCasePath"');
    expect(sessionSource).toContain('openLinkCasePathPicker()');
    expect(sessionSource).toContain('directoriesOnly: true');
  });

  it('keeps Choose separate from safe inline file preview', () => {
    expect(keyboardSource).toContain('openPreview(entry)');
    expect(keyboardSource).toContain('/api/filesystem/preview?');
    expect(keyboardSource).toContain("entry.previewKind === 'image'");
    expect(keyboardSource).toContain("entry.previewKind === 'text'");
    expect(keyboardSource).toContain("choose.textContent = 'Choose'");
    expect(keyboardSource).toContain('pre.textContent = content');
  });

  it('inserts a selected path into the editable local-echo prompt without sending it', () => {
    const appendText = vi.fn();
    const focus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _localEchoEnabled: true,
      _localEchoOverlay: { appendText },
      terminal: { focus },
      _focusedPane: () => ({ terminal: app.terminal, sessionId: app.activeSessionId, isPrimary: true }),
      _prepareExternalInput: vi.fn(),
    };

    terminalHarness.mixin.insertTerminalText.call(app, '/mnt/d/AI/project');

    expect(appendText).toHaveBeenCalledWith('/mnt/d/AI/project');
    expect(focus).toHaveBeenCalledOnce();
  });

  it('clears pending and already-flushed prompt text without invoking /clear', () => {
    const clear = vi.fn();
    const suppressBufferDetection = vi.fn();
    const showToast = vi.fn();
    const focus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _inputFlushTimeout: null,
      _localEchoEnabled: true,
      _localEchoOverlay: {
        getFlushed: () => ({ count: 4, text: 'a😀b' }),
        clear,
        suppressBufferDetection,
      },
      _flushedOffsets: new Map([['session-1', 4]]),
      _flushedTexts: new Map([['session-1', 'a😀b']]),
      _sendInputAsync: vi.fn(),
      _focusedPane: () => ({ terminal: app.terminal, sessionId: app.activeSessionId, isPrimary: true }),
      _prepareExternalInput: vi.fn(),
      showToast,
      terminal: { focus },
    };

    terminalHarness.mixin.clearTerminalInput.call(app);

    expect(app._prepareExternalInput).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      'clear'
    );
    expect(clear).toHaveBeenCalledOnce();
    expect(suppressBufferDetection).toHaveBeenCalledOnce();
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x7f'.repeat(3), { useMux: true });
    expect(app._flushedOffsets.size).toBe(0);
    expect(app._flushedTexts.size).toBe(0);
    expect(showToast).toHaveBeenCalledWith('Input cleared', 'success');
    expect(focus).toHaveBeenCalledOnce();
    expect(terminalHarness.cjkClear).toHaveBeenCalled();
  });

  it('sends a picked path to the tile or Pane B that holds the keyboard, never the parked main overlay', () => {
    const appendText = vi.fn();
    const _sendInputAsync = vi.fn();
    const mainFocus = vi.fn();
    const tileFocus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _localEchoEnabled: true,
      _localEchoOverlay: { appendText },
      terminal: { focus: mainFocus },
      _sendInputAsync,
      _prepareExternalInput: vi.fn(),
      _focusedPane: () => ({ terminal: { focus: tileFocus }, sessionId: 'tile-2', isPrimary: false, tile: {} }),
    };

    terminalHarness.mixin.insertTerminalText.call(app, '/mnt/d/AI/project');

    expect(_sendInputAsync).toHaveBeenCalledWith('tile-2', '/mnt/d/AI/project');
    expect(appendText).not.toHaveBeenCalled();
    expect(tileFocus).toHaveBeenCalledOnce();
    expect(mainFocus).not.toHaveBeenCalled();
  });

  it('clears the prompt of the tile or Pane B that holds the keyboard with Ctrl+U, leaving the main overlay alone', () => {
    const clear = vi.fn();
    const _sendInputAsync = vi.fn();
    const showToast = vi.fn();
    const tileFocus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _inputFlushTimeout: null,
      _localEchoEnabled: true,
      _localEchoOverlay: { getFlushed: () => ({ count: 0, text: '' }), clear, suppressBufferDetection: vi.fn() },
      _sendInputAsync,
      _prepareExternalInput: vi.fn(),
      showToast,
      terminal: { focus: vi.fn() },
      _focusedPane: () => ({ terminal: { focus: tileFocus }, sessionId: 'tile-2', isPrimary: false, tile: {} }),
    };

    terminalHarness.mixin.clearTerminalInput.call(app);

    expect(_sendInputAsync).toHaveBeenCalledWith('tile-2', '\x15');
    expect(clear).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Input cleared', 'success');
    expect(tileFocus).toHaveBeenCalledOnce();
  });

  it('uses Ctrl+U to clear the TUI-owned prompt when local echo is disabled', () => {
    const app = {
      activeSessionId: 'session-1',
      _inputFlushTimeout: null,
      _localEchoEnabled: false,
      _localEchoOverlay: null,
      _sendInputAsync: vi.fn(),
      _focusedPane: () => ({ terminal: app.terminal, sessionId: app.activeSessionId, isPrimary: true }),
      _prepareExternalInput: vi.fn(),
      showToast: vi.fn(),
      terminal: { focus: vi.fn() },
    };

    terminalHarness.mixin.clearTerminalInput.call(app);

    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x15', { useMux: true });
  });
});
