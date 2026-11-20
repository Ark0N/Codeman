import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CleanupApp {
  _disconnectWs?: () => void;
  _predictiveEcho?: { clearPredictions: () => void };
  _clearTimer?: (name: string) => void;
}

function harness() {
  const fetchMock = vi.fn().mockResolvedValue({});
  const context = vm.createContext({
    console,
    _crashDiag: { log: vi.fn() },
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class {},
    WebSocket: { OPEN: 1 },
    fetch: fetchMock,
    document: { addEventListener: vi.fn(), getElementById: () => null, activeElement: null },
    localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), length: 0, key: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => true },
  });
  const dir = resolve(import.meta.dirname, '../src/web/public');
  vm.runInContext(
    `${readFileSync(resolve(dir, 'constants.js'), 'utf8')}\n${readFileSync(resolve(dir, 'app.js'), 'utf8')}\nglobalThis.App = CodemanApp;`,
    context
  );
  vm.runInContext(readFileSync(resolve(dir, 'terminal-ui.js'), 'utf8'), context);
  const app = Object.create(context.App.prototype);
  app.activeSessionId = 'old';
  app.sessions = new Map([
    ['old', { mode: 'claude' }],
    ['new', { mode: 'claude' }],
  ]);
  app._localEchoEnabled = true;
  app._flushedOffsets = new Map();
  app._flushedTexts = new Map();
  app._predictHookOnData = vi.fn();
  app._localEchoOverlay = {
    pendingText: '',
    flushed: '',
    addChar(text: string) {
      this.pendingText += text;
    },
    appendText(text: string) {
      this.pendingText += text;
    },
    clear() {
      this.pendingText = '';
      this.flushed = '';
    },
    suppressBufferDetection: vi.fn(),
    getFlushed() {
      return { count: this.flushed.length, text: this.flushed };
    },
    setPrompt: vi.fn(),
    removeChar() {
      const key = this.pendingText ? 'pendingText' : this.flushed ? 'flushed' : null;
      if (!key) return false;
      this[key] = Array.from(this[key]).slice(0, -1).join('');
      return key === 'pendingText' ? 'pending' : 'flushed';
    },
    getInputEndAnchor: vi.fn(() => ({ col: 8, row: 2 })),
  };
  const wire: Array<[string, string]> = [];
  app._enqueueReliableInput = vi.fn((id: string, text: string) => wire.push([id, text]));
  app.terminal = { focus: vi.fn() };
  return { app, wire, context, fetchMock };
}

function loadProducerModules(app: object, context: vm.Context) {
  context.__app = app;
  vm.runInContext('app = globalThis.__app;', context);
  const dir = resolve(import.meta.dirname, '../src/web/public');
  for (const file of ['keyboard-accessory.js', 'voice-input.js', 'image-input.js']) {
    vm.runInContext(readFileSync(resolve(dir, file), 'utf8'), context);
  }
}

function attachCjk(
  app: { _focusedPane: () => { sessionId: string } | null; _handleCjkInput: (text: string, sessionId: string) => void },
  context: vm.Context
) {
  const listeners = new Map<string, (event: object) => void>();
  const field = {
    value: '',
    selectionStart: 1,
    selectionEnd: 1,
    setSelectionRange: vi.fn(),
    addEventListener: (name: string, fn: (event: object) => void) => listeners.set(name, fn),
    removeEventListener: vi.fn(),
  };
  context.navigator = { userAgent: 'iPhone' };
  context.document.getElementById = () => field;
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/input-cjk.js'), 'utf8'), context);
  const cjk = vm.runInContext('CjkInput', context);
  cjk.init({
    captureTarget: () => app._focusedPane()?.sessionId,
    send: (text: string, sessionId: string) => app._handleCjkInput(text, sessionId),
  });
  return { cjk, field, fire: (name: string, event = {}) => listeners.get(name)!(event) };
}

function attachCleanupStubs(app: CleanupApp) {
  app._disconnectWs = vi.fn();
  app._predictiveEcho = { clearPredictions: vi.fn() };
  app._clearTimer = vi.fn();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('session-owned main input FIFO', () => {
  it('keeps Enter on the old session through a switch and before later old-session writes', () => {
    const { app, wire } = harness();
    attachCleanupStubs(app);
    app._handleTerminalData('before', 'old');
    app._handleTerminalData('\r', 'old');
    vi.advanceTimersByTime(30);
    app._cleanupPreviousSession('new');
    app.activeSessionId = 'new';
    app._sendInputAsync('old', 'after');
    app._sendInputAsync('new', 'independent');
    expect(wire).toEqual([
      ['old', 'before'],
      ['new', 'independent'],
    ]);
    vi.advanceTimersByTime(50);
    expect(wire).toEqual([
      ['old', 'before'],
      ['new', 'independent'],
      ['old', '\r'],
      ['old', 'after'],
    ]);
  });

  it('queues typing after Enter behind the reserved CR', () => {
    const { app, wire } = harness();
    app._handleTerminalData('first', 'old');
    app._handleTerminalData('\r', 'old');
    app._localEchoEnabled = false;
    app._handleTerminalData('x', 'old');
    vi.advanceTimersByTime(0);
    expect(wire).toEqual([['old', 'first']]);
    vi.advanceTimersByTime(80);
    expect(wire).toEqual([
      ['old', 'first'],
      ['old', '\r'],
      ['old', 'x'],
    ]);
  });

  it('queues a later local echo flush behind the reservation', () => {
    const { app, wire } = harness();
    app._handleTerminalData('first', 'old');
    app._handleTerminalData('\r', 'old');
    app._handleTerminalData('later', 'old');
    app._flushLocalEchoTo('old');
    expect(wire).toEqual([['old', 'first']]);
    vi.advanceTimersByTime(80);
    expect(wire).toEqual([
      ['old', 'first'],
      ['old', '\r'],
      ['old', 'later'],
    ]);
  });

  it('seals a printable batch before switching and never reads the new destination in its timer', () => {
    const { app, wire } = harness();
    attachCleanupStubs(app);
    app._localEchoEnabled = false;
    app._handleTerminalData('a', 'old');
    app._handleTerminalData('b', 'old');
    expect(wire).toEqual([]);
    app._cleanupPreviousSession('new');
    app.activeSessionId = 'new';
    vi.runAllTimers();
    expect(wire).toEqual([['old', 'ab']]);
  });

  it('seals a printable batch before control input as distinct ordered writes', () => {
    const { app, wire } = harness();
    app._localEchoEnabled = false;
    app._handleTerminalData('a', 'old');
    app._handleTerminalData('\r', 'old');
    expect(wire).toEqual([
      ['old', 'a'],
      ['old', '\r'],
    ]);
  });

  it('reserves a delayed bracketed paste ahead of later input', () => {
    const { app, wire } = harness();
    const paste = '\x1b[200~pasted\x1b[201~';
    app._flushedOffsets.set('old', 3);
    app._flushedTexts.set('old', 'pre');
    app._handleTerminalData('prefix', 'old');
    app._handleTerminalData(paste, 'old');
    expect(app._localEchoOverlay.pendingText).toBe('');
    expect(app._localEchoOverlay.suppressBufferDetection).toHaveBeenCalledOnce();
    expect(app._flushedOffsets.has('old')).toBe(false);
    expect(app._flushedTexts.has('old')).toBe(false);
    app._sendInputAsync('old', 'suffix');
    expect(wire).toEqual([['old', 'prefix']]);
    vi.advanceTimersByTime(80);
    expect(wire).toEqual([
      ['old', 'prefix'],
      ['old', paste],
      ['old', 'suffix'],
    ]);
  });

  it.each(['S-Enter', 'C-Enter'])('orders text, gap, %s, then later writes', (key) => {
    const { app, wire, fetchMock } = harness();
    app._handleTerminalData('line', 'old');
    app._submitModifiedEnter('old', key);
    app.activeSessionId = 'new';
    app._sendInputAsync('old', 'next');
    expect(wire).toEqual([['old', 'line']]);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/old/send-key',
      expect.objectContaining({ body: JSON.stringify({ key }) })
    );
    expect(wire).toEqual([
      ['old', 'line'],
      ['old', 'next'],
    ]);
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(app._enqueueReliableInput.mock.invocationCallOrder[1]);
  });

  it('runs two session FIFOs independently', () => {
    const { app, wire } = harness();
    app._enqueueInput('old', [{ write: 'a' }, { gap: 120 }, { write: 'b' }]);
    app._enqueueInput('new', [{ write: 'c' }, { gap: 80 }, { write: 'd' }]);
    vi.advanceTimersByTime(80);
    expect(wire).toEqual([
      ['old', 'a'],
      ['new', 'c'],
      ['new', 'd'],
    ]);
    vi.advanceTimersByTime(40);
    expect(wire.at(-1)).toEqual(['old', 'b']);
  });

  it('drops deleted-session reservations and batches without redirecting', () => {
    const { app, wire } = harness();
    app._enqueueInput('old', [{ write: 'a' }, { gap: 80 }, { write: '\r' }]);
    for (const name of [
      'terminalBuffers',
      'terminalBufferCache',
      'ralphStates',
      'ralphClosedSessions',
      'projectInsights',
      'pendingHooks',
      'tabAlerts',
      'attachmentHistoryCounts',
      'terminalLoadStates',
      'idleTimers',
    ])
      app[name] = new Map();
    for (const name of [
      '_markTerminalBufferReconciled',
      '_clearHistoryTruncation',
      '_persistReliableState',
      'clearCountdownTimers',
      'closeSessionLogViewerWindows',
      'closeSessionImagePopups',
      'closeSessionAttachmentCards',
      'closeSessionSubagentWindows',
    ])
      app[name] = vi.fn();
    for (const name of ['respawnStatus', 'respawnTimers', 'respawnCountdownTimers', 'respawnActionLogs'])
      app[name] = {};
    app.sessionOrder = ['old', 'new'];
    app._localEchoEnabled = false;
    app._handleTerminalData('pending', 'old');
    app._cleanupSessionData('old');
    app.activeSessionId = 'new';
    app._sendInputAsync('old', 'never');
    vi.runAllTimers();
    expect(wire).toEqual([['old', 'a']]);
    expect(app._inputFifos.has('old')).toBe(false);
    expect(app._pendingInput.has('old')).toBe(false);
  });
});

describe('native main transactions and boundaries', () => {
  it('handles each DEL separately with local echo: unsent deletes stay local, flushed deletes reach wire', () => {
    const { app, wire } = harness();
    app._localEchoOverlay.pendingText = 'ab';
    app._localEchoOverlay.flushed = 'XY';
    app._flushedOffsets.set('old', 2);
    app._flushedTexts.set('old', 'XY');
    app._sendNativeInputTransaction(['\x7f', '\x7f', '\x7f', 'Z']);
    expect(wire).toEqual([['old', '\x7f']]);
    expect(app._localEchoOverlay.pendingText).toBe('Z');
    expect(app._flushedOffsets.get('old')).toBe(1);
    expect(app._flushedTexts.get('old')).toBe('X');
  });

  it('bypasses printable batching and preserves op boundaries with local echo off', () => {
    const { app, wire } = harness();
    app._localEchoEnabled = false;
    app._handleTerminalData('a', 'old');
    app._sendNativeInputTransaction(['\x7f', '\x7f', 'replacement']);
    expect(wire).toEqual([
      ['old', 'a'],
      ['old', '\x7f'],
      ['old', '\x7f'],
      ['old', 'replacement'],
    ]);
  });

  it('captures the session once even if preprocessing changes the active pane', () => {
    const { app, wire } = harness();
    app._localEchoEnabled = false;
    app._predictHookOnData = () => {
      app.activeSessionId = 'new';
    };
    app._sendNativeInputTransaction(['\x7f', 'replacement']);
    expect(wire).toEqual([
      ['old', '\x7f'],
      ['old', 'replacement'],
    ]);
  });

  it.each([true, false])('consumes one-shot Ctrl once per transaction (echo %s)', (echo) => {
    const { app, wire, context } = harness();
    app._localEchoEnabled = echo;
    app._iosNativeInput = { reset: vi.fn() };
    const ctrl = { isCtrlArmed: () => true, consumeCtrl: vi.fn(() => '\x03') };
    context.KeyboardAccessoryBar = ctrl;
    if (echo) app._localEchoOverlay.pendingText = 'ab';
    app._sendNativeInputTransaction(['\x7f', '\x7f', 'c']);
    expect(ctrl.consumeCtrl).toHaveBeenCalledExactlyOnceWith('c');
    expect(app._iosNativeInput.reset).toHaveBeenCalledExactlyOnceWith('ctrl');
    expect(wire).toEqual(
      echo
        ? [['old', '\x03']]
        : [
            ['old', '\x7f'],
            ['old', '\x7f'],
            ['old', '\x03'],
          ]
    );
  });

  it('settles, seals, flushes, resets owner and preview before session cleanup', () => {
    const { app, wire } = harness();
    attachCleanupStubs(app);
    const order: string[] = [];
    app._iosNativeInput = {
      settle: () => {
        order.push('settle');
        app._handleTerminalData('native', 'old');
      },
      reset: (reason: string) => order.push(`reset:${reason}`),
    };
    app._mobileImePreview = { reset: () => order.push('preview') };
    app._disconnectWs = () => order.push('cleanup');
    app._cleanupPreviousSession('new');
    expect(wire).toEqual([['old', 'native']]);
    expect(order).toEqual(['settle', 'reset:session', 'preview', 'cleanup']);
  });

  it('settles and flushes before disabling the echo policy', () => {
    const { app, wire } = harness();
    app.loadAppSettingsFromStorage = () => ({ localEchoEnabled: false });
    app._localEchoOverlay.pendingText = 'retained';
    app._iosNativeInput = { settle: vi.fn(), reset: vi.fn() };
    app._updateLocalEchoState();
    expect(wire).toEqual([['old', 'retained']]);
    expect(app._localEchoOverlay.pendingText).toBe('');
    expect(app._iosNativeInput.reset).toHaveBeenCalledWith('echo-policy');
  });

  it('retires flushed snapshots when local echo hands the line to PTY echo', () => {
    const { app, wire } = harness();
    app.loadAppSettingsFromStorage = () => ({ localEchoEnabled: false });
    app._handleTerminalData('abc', 'old');
    app._updateLocalEchoState();
    expect(wire).toEqual([['old', 'abc']]);
    expect(app._flushedOffsets.has('old')).toBe(false);
    expect(app._flushedTexts.has('old')).toBe(false);
    app._updateLocalEchoState();
    expect(wire).toEqual([['old', 'abc']]);
  });

  it('resolves primary, split and grid owners independently of focus', () => {
    const { app } = harness();
    const split = { sessionId: 'new', terminal: {}, _destroyed: false };
    app._splitPane = split;
    app._focusedTile = split;
    expect(app._paneForSession('old')).toEqual({
      terminal: app.terminal,
      sessionId: 'old',
      isPrimary: true,
      tile: null,
    });
    expect(app._paneForSession('new')?.tile).toBe(split);
    app._tilesOwnTerminal = () => true;
    const grid = { sessionId: 'old', terminal: {}, _destroyed: false };
    app._tileFor = (id: string) => (id === 'old' ? grid : null);
    expect(app._paneForSession('old')?.tile).toBe(grid);
    split._destroyed = true;
    expect(app._paneForSession('new')).toBeNull();
    grid._destroyed = true;
    expect(app._paneForSession('old')).toBeNull();
    expect(app._paneForSession('absent')).toBeNull();
  });

  it.each(['insertText', 'insertReplacementText', 'compositionend'])(
    'flushes real CJK %s timers to the outgoing pane before focus changes',
    (event) => {
      const { app, wire, context } = harness();
      const listeners = new Map<string, (event: object) => void>();
      const field = {
        value: '',
        selectionStart: 1,
        selectionEnd: 1,
        setSelectionRange: vi.fn(),
        addEventListener: (name: string, fn: (event: object) => void) => listeners.set(name, fn),
        removeEventListener: vi.fn(),
      };
      context.navigator = { userAgent: 'iPhone' };
      context.document.getElementById = () => field;
      vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/input-cjk.js'), 'utf8'), context);
      const cjk = vm.runInContext('CjkInput', context);
      cjk.init({
        captureTarget: () => app._focusedPane()?.sessionId,
        send: (text: string, sessionId: string) => app._handleCjkInput(text, sessionId),
      });
      field.value = '你好';
      if (event === 'compositionend') {
        listeners.get('compositionstart')!({});
        listeners.get('compositionend')!({});
      } else listeners.get('input')!({ inputType: event, isComposing: false });
      expect(wire).toEqual([]);
      const tile = { sessionId: 'new', terminal: {} };
      app._noteFocusedTile(tile);
      expect(wire).toEqual([['old', '你好']]);
      field.value = '再见';
      listeners.get('input')!({ inputType: 'insertText', isComposing: false });
      app._noteFocusedTile(null);
      expect(wire).toEqual([
        ['old', '你好'],
        ['new', '再见'],
      ]);
      vi.runAllTimers();
      expect(wire).toHaveLength(2);
      cjk.destroy();
    }
  );

  it('flushes CJK text to Pane B before its real teardown destroys the owner', () => {
    const { app, wire, context } = harness();
    const { cjk, field, fire } = attachCjk(app, context);
    context.window.app = app;
    vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-tile.js'), 'utf8'), context);
    const tile = {
      sessionId: 'new',
      terminal: { dispose: vi.fn() },
      _destroyIosNativeInput: vi.fn(() => expect(wire).toEqual([['new', '你好']])),
      _resetLiveFlow: vi.fn(),
      _detachSocket: vi.fn(),
      _destroyKeyCode229Recovery: vi.fn(),
    };
    app._splitPane = tile;
    app._noteFocusedTile(tile);
    field.value = '你好';
    fire('input', { inputType: 'insertText', isComposing: false });
    context.window.TerminalTile.prototype.destroy.call(tile);
    vi.runAllTimers();
    expect(wire).toEqual([['new', '你好']]);
    expect(app._focusedPane().sessionId).toBe('old');
    cjk.destroy();
  });

  it('keeps an unfinished CJK composition on B after focus moves to A', () => {
    const { app, wire, context } = harness();
    const { cjk, field, fire } = attachCjk(app, context);
    const tile = { sessionId: 'new', terminal: {} };
    app._splitPane = tile;
    app._noteFocusedTile(tile);
    fire('compositionstart');
    field.value = '你好';
    fire('input', { inputType: 'insertCompositionText', isComposing: true });
    app._noteFocusedTile(null);
    expect(wire).toEqual([]);
    fire('compositionend');
    vi.runAllTimers();
    expect(wire).toEqual([['new', '你好']]);
    cjk.destroy();
  });

  it('flushes a normal CJK buffer to the current pane', () => {
    const { app, wire, context } = harness();
    const { cjk, field, fire } = attachCjk(app, context);
    field.value = '你好';
    fire('input', { inputType: 'insertText', isComposing: false });
    vi.runAllTimers();
    expect(wire).toEqual([['old', '你好']]);
    cjk.destroy();
  });

  it.each([false, true])(
    'delivers a captured CJK commit without a pane only while its session exists (removed=%s)',
    (removed) => {
      const { app, wire, context } = harness();
      const { cjk, field, fire } = attachCjk(app, context);
      const tile = { sessionId: 'new', terminal: {}, _destroyed: false };
      app._splitPane = tile;
      app._noteFocusedTile(tile);
      fire('compositionstart');
      field.value = '你好';
      app._noteFocusedTile(null);
      tile._destroyed = true;
      if (removed) app.sessions.delete('new');
      const prepare = vi.spyOn(app, '_prepareExternalInput');
      fire('compositionend');
      vi.runAllTimers();
      expect(wire).toEqual(removed ? [] : [['new', '你好']]);
      expect(prepare).not.toHaveBeenCalled();
      cjk.destroy();
    }
  );

  it.each(['split', 'grid'])('resets the captured unfocused %s path-picker owner before direct delivery', (layout) => {
    const { app, wire, context } = harness();
    loadProducerModules(app, context);
    const owner = { settle: vi.fn(), reset: vi.fn() };
    const tile = { sessionId: 'new', terminal: {}, _iosNativeInput: owner };
    if (layout === 'split') app._splitPane = tile;
    else {
      app._tilesOwnTerminal = () => true;
      app._tileFor = (id: string) => (id === 'new' ? tile : null);
    }
    app._noteFocusedTile(tile);
    const open = vi.fn();
    context.__openPicker = open;
    vm.runInContext('PathPicker.open = globalThis.__openPicker; KeyboardAccessoryBar.pickPath();', context);
    app._noteFocusedTile(null);
    const prepare = vi.spyOn(app, '_prepareExternalInput');
    open.mock.calls[0][0].onSelect('/project/file.ts');
    expect(owner.settle).toHaveBeenCalledOnce();
    expect(owner.reset).toHaveBeenCalledWith('accessory-path');
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ tile }), 'accessory-path', { flushEcho: true });
    expect(wire).toEqual([['new', '/project/file.ts']]);
  });

  it.each([false, true])('keeps the primary path-picker prefix in its overlay when focus moves (%s)', (moved) => {
    const { app, wire, context } = harness();
    loadProducerModules(app, context);
    app._localEchoOverlay.pendingText = 'prefix ';
    app._iosNativeInput = { settle: vi.fn(), reset: vi.fn() };
    const open = vi.fn();
    context.__openPicker = open;
    vm.runInContext('PathPicker.open = globalThis.__openPicker; KeyboardAccessoryBar.pickPath();', context);
    if (moved) app._noteFocusedTile({ sessionId: 'new', terminal: {} });
    const prepare = vi.spyOn(app, '_prepareExternalInput');
    open.mock.calls[0][0].onSelect('/project/file.ts');
    expect(app._iosNativeInput.reset).toHaveBeenCalledWith('accessory-path');
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ isPrimary: true, sessionId: 'old' }),
      'accessory-path'
    );
    expect(app._localEchoOverlay.pendingText).toBe('prefix /project/file.ts');
    expect(wire).toEqual([]);
  });

  it.each(['voice', 'accessory', 'upload', 'toolbar-attachment'])(
    '%s prepares an unfocused live destination owner, but still sends without a pane',
    async (producer) => {
      for (const live of [true, false]) {
        const { app, wire, context } = harness();
        loadProducerModules(app, context);
        app._localEchoEnabled = false;
        const owner = { settle: vi.fn(), reset: vi.fn() };
        app._iosNativeInput = { settle: vi.fn(), reset: vi.fn() };
        const tile = { sessionId: 'new', terminal: {}, _iosNativeInput: owner };
        if (live) app._splitPane = tile;
        app.showToast = vi.fn();
        app._normalizeImageForUpload = vi.fn(async (file: object) => file);
        app._uploadPasteImage = vi.fn(async () => '/image.png');
        if (producer === 'voice') {
          await vm.runInContext("VoiceInput._sendToTarget('new', 'inserted')", context);
        } else if (producer === 'accessory') {
          const target = vm.runInContext(
            "KeyboardAccessoryBar._prepareInput('new', 'accessory-compose-send')",
            context
          );
          app._enqueueInput(target, [{ write: 'inserted' }]);
        } else if (producer === 'upload') {
          await app._uploadAndInsertImages([{}], { sessionId: 'new' });
        } else {
          app._admitPromptAttachments = (files: object[]) => files;
          await app._attachFromToolbar([{}], 'new');
        }
        expect(wire.length).toBeGreaterThan(0);
        expect(wire.every(([id]) => id === 'new')).toBe(true);
        expect(owner.reset).toHaveBeenCalledTimes(live ? 1 : 0);
        expect(owner.settle).toHaveBeenCalledTimes(live ? 1 : 0);
        expect(app._iosNativeInput.reset).not.toHaveBeenCalled();
      }
    }
  );

  it.each(['upload', 'voice', 'Esc', 'paste'])(
    '%s preserves the typed prefix before direct writes with echo on or off',
    async (producer) => {
      for (const echo of [true, false]) {
        const { app, wire, context } = harness();
        loadProducerModules(app, context);
        app._localEchoEnabled = echo;
        app._handleTerminalData('hel', 'old');
        app.showToast = vi.fn();
        app._normalizeImageForUpload = vi.fn(async (file: object) => file);
        app._uploadPasteImage = vi.fn(async () => '/p');
        if (producer === 'upload') {
          await app._uploadAndInsertImages([{}], { sessionId: 'old' });
          expect(wire).toEqual([
            ['old', 'hel'],
            ['old', '/p'],
          ]);
          app.submitFromToolbar();
          expect(wire).toEqual(
            echo
              ? [
                  ['old', 'hel'],
                  ['old', '/p'],
                ]
              : [
                  ['old', 'hel'],
                  ['old', '/p'],
                  ['old', '\r'],
                ]
          );
          vi.advanceTimersByTime(80);
          expect(wire).toEqual([
            ['old', 'hel'],
            ['old', '/p'],
            ['old', '\r'],
          ]);
        } else if (producer === 'voice') {
          await vm.runInContext("VoiceInput._sendToTarget('old', 'world')", context);
          expect(wire).toEqual([
            ['old', 'hel'],
            ['old', 'world'],
          ]);
        } else if (producer === 'Esc') {
          vm.runInContext("KeyboardAccessoryBar.sendKey('\\x1b')", context);
          expect(wire).toEqual([
            ['old', 'hel'],
            ['old', '\x1b'],
          ]);
        } else {
          vm.runInContext("KeyboardAccessoryBar._sendBracketedPaste('old', 'world', 'Paste')", context);
          expect(wire).toEqual([
            ['old', 'hel'],
            ['old', '\x1b[200~world\x1b[201~'],
          ]);
        }
        expect(app._localEchoOverlay.pendingText).toBe('');
      }
    }
  );

  it('sends a slash command without submitting the unsent local-echo draft', () => {
    for (const echo of [true, false]) {
      const { app, wire, context } = harness();
      loadProducerModules(app, context);
      app._localEchoEnabled = echo;
      app._handleTerminalData('hel', 'old');
      vm.runInContext("KeyboardAccessoryBar.sendCommand('/help')", context);
      vi.advanceTimersByTime(120);
      // Echo on: `hel` stays in the overlay. Echo off: it was already typed into the PTY.
      expect(wire).toEqual([...(echo ? [] : [['old', 'hel']]), ['old', '/help'], ['old', '\r']]);
      expect(app._localEchoOverlay.pendingText).toBe(echo ? 'hel' : '');
    }
  });

  it('keeps the typed prefix in the overlay when a toolbar attachment appends', async () => {
    const { app, wire, context } = harness();
    loadProducerModules(app, context);
    app._handleTerminalData('hel', 'old');
    app._admitPromptAttachments = (files: object[]) => files;
    app._normalizeImageForUpload = vi.fn(async (file: object) => file);
    app._uploadPasteImage = vi.fn(async () => '/p');
    app.showToast = vi.fn();
    await app._attachFromToolbar([{}], 'old');
    expect(wire).toEqual([]);
    expect(app._localEchoOverlay.pendingText).toBe('hel /p ');
  });

  it('hides the caret when a buffering overlay cannot supply an anchor', () => {
    const { app } = harness();
    expect(app._nativeInputAnchor()).toBeNull();
    app._localEchoOverlay.pendingText = 'text';
    expect(app._nativeInputAnchor()).toEqual({ col: 8, row: 2 });
    app._localEchoOverlay.getInputEndAnchor = () => null;
    expect(app._nativeInputAnchor()).toBe('hide');
    delete app._localEchoOverlay.getInputEndAnchor;
    expect(app._nativeInputAnchor()).toBe('hide');
    app._echoPassthroughSessions = new Set(['old']);
    expect(app._nativeInputAnchor()).toBeNull();
  });

  it('prepares only the captured tile owner, not the primary owner', () => {
    const { app } = harness();
    app._iosNativeInput = { settle: vi.fn(), reset: vi.fn() };
    const tile = { _iosNativeInput: { settle: vi.fn(), reset: vi.fn() } };
    app._prepareExternalInput({ terminal: {}, sessionId: 'new', isPrimary: false, tile }, 'external');
    expect(tile._iosNativeInput.settle).toHaveBeenCalledOnce();
    expect(tile._iosNativeInput.reset).toHaveBeenCalledWith('external');
    expect(app._iosNativeInput.settle).not.toHaveBeenCalled();
  });

  it('submits the toolbar through the main echo reservation and never falls back from a dead pane', () => {
    const { app, wire } = harness();
    const focusedPane = vi.fn(() => ({ terminal: app.terminal, sessionId: 'old', isPrimary: true }));
    app._focusedPane = focusedPane;
    app._localEchoOverlay.pendingText = 'toolbar';
    app.submitFromToolbar();
    expect(focusedPane).toHaveBeenCalledOnce();
    expect(wire).toEqual([['old', 'toolbar']]);
    vi.advanceTimersByTime(80);
    expect(wire.at(-1)).toEqual(['old', '\r']);
    focusedPane.mockReturnValue({ terminal: {}, sessionId: 'gone', isPrimary: false });
    app.submitFromToolbar();
    expect(wire).toHaveLength(2);
  });
  it('resets native ownership before dispatching synthetic compositionend', () => {
    const { app, context } = harness();
    attachCleanupStubs(app);
    const order: string[] = [];
    app._iosNativeInput = { settle: vi.fn(), reset: () => order.push('reset') };
    context.CompositionEvent = class {
      constructor(public type: string) {}
    };
    app.terminal = {
      _core: { _compositionHelper: { _isComposing: true } },
      element: { querySelector: () => ({ dispatchEvent: () => order.push('compositionend') }) },
    };
    app._cleanupPreviousSession('new');
    expect(order).toEqual(['reset', 'compositionend']);
  });

  it('creates an iOS owner instead of recovery, connects transaction/preview/anchor callbacks and disposes prior owners', () => {
    const { app, wire, context } = harness();
    const owner = { destroy: vi.fn() };
    const disposeMarker = vi.fn();
    const native = {
      isSupported: () => true,
      create: vi.fn(
        (_options: {
          terminal: object;
          sendTransaction: (ops: string[]) => void;
          onTransaction: (transaction: { inserted: string; deleted: number; composition: boolean }) => void;
          isScreenReaderMode: () => boolean;
        }) => owner
      ),
      attachCaretMarker: vi.fn(
        (
          _terminal: object,
          _owner: object,
          _options: {
            anchor: () => unknown;
            subscribe: (callback: () => void) => unknown;
          }
        ) => disposeMarker
      ),
    };
    const recovery = { create: vi.fn() };
    context.window.CodemanIosNativeInput = native;
    context.window.CodemanKeyCode229Recovery = recovery;
    app._mobileImePreview = { nativeTransaction: vi.fn() };
    const unsubscribe = vi.fn();
    app._localEchoOverlay.onLayout = vi.fn(() => unsubscribe);
    app._initTerminalInputOwner();
    expect(native.create).toHaveBeenCalledOnce();
    expect(recovery.create).not.toHaveBeenCalled();
    const options = native.create.mock.calls[0][0];
    expect(options.terminal).toBe(app.terminal);
    app._localEchoEnabled = false;
    options.sendTransaction(['\x7f', 'native']);
    expect(wire).toEqual([
      ['old', '\x7f'],
      ['old', 'native'],
    ]);
    const transaction = { inserted: '', deleted: 1, composition: true };
    options.onTransaction(transaction);
    expect(app._mobileImePreview.nativeTransaction).toHaveBeenCalledWith(transaction);
    const markerOptions = native.attachCaretMarker.mock.calls[0][2];
    expect(markerOptions.anchor()).toBeNull();
    expect(markerOptions.subscribe(vi.fn())).toBe(unsubscribe);
    app._initTerminalInputOwner();
    expect(owner.destroy).toHaveBeenCalledOnce();
    expect(disposeMarker).toHaveBeenCalledOnce();
    expect(native.create).toHaveBeenCalledTimes(2);
  });

  it('retains the recovery path when the iOS module is absent', () => {
    const { app, wire, context } = harness();
    const recovery = { destroy: vi.fn() };
    const create = vi.fn((_options: { emitRecovered: (data: string) => void }) => recovery);
    context.window.CodemanKeyCode229Recovery = { create };
    app._localEchoEnabled = false;
    app._initTerminalInputOwner();
    create.mock.calls[0][0].emitRecovered('recovered');
    expect(wire).toEqual([['old', 'recovered']]);
    app._initTerminalInputOwner();
    expect(recovery.destroy).toHaveBeenCalledOnce();
  });
  it('settles and resets native ownership before inserting external text into the overlay', () => {
    const { app } = harness();
    app._iosNativeInput = {
      settle: () => {
        app._localEchoOverlay.pendingText = 'native';
      },
      reset: vi.fn(),
    };
    app.insertTerminalText('external');
    expect(app._localEchoOverlay.pendingText).toBe('nativeexternal');
    expect(app._iosNativeInput.reset).toHaveBeenCalledWith('insert');
  });

  it('seals accepted printable input before clear, discarding only unsent overlay text', () => {
    const { app, wire } = harness();
    app._appendPendingInput('old', 'accepted');
    app._localEchoOverlay.pendingText = 'discard';
    app._localEchoOverlay.flushed = 'XY';
    app._iosNativeInput = { settle: vi.fn(), reset: vi.fn() };
    app.clearTerminalInput();
    expect(wire).toEqual([
      ['old', 'accepted'],
      ['old', '\x7f\x7f'],
    ]);
    expect(app._pendingInput.get('old')).toBeUndefined();
    expect(app._localEchoOverlay.pendingText).toBe('');
    expect(app._iosNativeInput.reset).toHaveBeenCalledWith('clear');
  });

  it('captures the CJK target before preparing its native owner', () => {
    const { app, wire } = harness();
    app._iosNativeInput = {
      settle: vi.fn(),
      reset: () => {
        app.activeSessionId = 'new';
      },
    };
    app._handleCjkInput('composed');
    expect(wire).toEqual([['old', 'composed']]);
  });
});
