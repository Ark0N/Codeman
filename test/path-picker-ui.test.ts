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
    sendInput: vi.fn(),
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

    expect(app.sendInput).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sessions/session-1/input');
    expect(JSON.parse(init.body)).toEqual({ input: '\t' });
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
    expect(app.sendInput).toHaveBeenCalledWith('git sta');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ input: '\t' });
    // Text must reach the PTY before the completion request.
    const sendInputOrder = (app.sendInput as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const fetchOrder = fetchMock.mock.invocationCallOrder[0];
    expect(sendInputOrder).toBeLessThan(fetchOrder);
  });
});

describe('mobile filesystem picker actions', () => {
  it('keeps clear-input separate from the destructive /clear command', () => {
    const { app, bar } = loadKeyboardModule();
    bar.handleAction('clear-input');

    expect(app.clearTerminalInput).toHaveBeenCalledOnce();
    expect(app.sendInput).not.toHaveBeenCalled();
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
    expect(app.insertTerminalText).toHaveBeenCalledWith('/mnt/d/AI/project/file.ts');
    expect(app.sendInput).not.toHaveBeenCalled();
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
    const sendInput = vi.fn();
    const focus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _localEchoEnabled: true,
      _localEchoOverlay: { appendText },
      terminal: { focus },
      sendInput,
    };

    terminalHarness.mixin.insertTerminalText.call(app, '/mnt/d/AI/project');

    expect(appendText).toHaveBeenCalledWith('/mnt/d/AI/project');
    expect(sendInput).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('clears pending and already-flushed prompt text without invoking /clear', () => {
    const clear = vi.fn();
    const suppressBufferDetection = vi.fn();
    const sendInput = vi.fn(() => Promise.resolve());
    const showToast = vi.fn();
    const focus = vi.fn();
    const app = {
      activeSessionId: 'session-1',
      _inputFlushTimeout: null,
      _pendingInput: 'pending text',
      _localEchoEnabled: true,
      _localEchoOverlay: {
        getFlushed: () => ({ count: 4, text: 'a😀b' }),
        clear,
        suppressBufferDetection,
      },
      _flushedOffsets: new Map([['session-1', 4]]),
      _flushedTexts: new Map([['session-1', 'a😀b']]),
      sendInput,
      showToast,
      terminal: { focus },
    };

    terminalHarness.mixin.clearTerminalInput.call(app);

    expect(app._pendingInput).toBe('');
    expect(clear).toHaveBeenCalledOnce();
    expect(suppressBufferDetection).toHaveBeenCalledOnce();
    expect(sendInput).toHaveBeenCalledWith('\x7f'.repeat(3));
    expect(sendInput).not.toHaveBeenCalledWith('/clear');
    expect(app._flushedOffsets.size).toBe(0);
    expect(app._flushedTexts.size).toBe(0);
    expect(showToast).toHaveBeenCalledWith('Input cleared', 'success');
    expect(focus).toHaveBeenCalledOnce();
    expect(terminalHarness.cjkClear).toHaveBeenCalled();
  });

  it('uses Ctrl+U to clear the TUI-owned prompt when local echo is disabled', () => {
    const sendInput = vi.fn(() => Promise.resolve());
    const app = {
      activeSessionId: 'session-1',
      _inputFlushTimeout: null,
      _pendingInput: '',
      _localEchoEnabled: false,
      _localEchoOverlay: null,
      sendInput,
      showToast: vi.fn(),
      terminal: { focus: vi.fn() },
    };

    terminalHarness.mixin.clearTerminalInput.call(app);

    expect(sendInput).toHaveBeenCalledWith('\x15');
  });
});
