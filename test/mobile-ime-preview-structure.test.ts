/**
 * @fileoverview Wiring tests for the iOS IME preview (mobile-ime-preview.js).
 *
 * The controller itself is covered by test/mobile-ime-preview.test.ts. These
 * pin how terminal-ui.js and the delivery graph consume it: script order,
 * build registration and CSS, the _init/_destroyMobileImePreview lifecycle,
 * the onData routing of an IME commit, and the rule that only output accepted
 * AFTER a commit may clear the committed preview.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');
const indexSource = read('src/web/public/index.html');
const buildSource = read('scripts/build.mjs');
const terminalSource = read('src/web/public/terminal-ui.js');
const cssSource = read('src/web/public/styles.css');

type Fn = ReturnType<typeof vi.fn>;
type App = Record<string, any>;

function loadMixin(globals: Record<string, unknown> = {}) {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const windowStub = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...(globals.window as object),
  } as Record<string, unknown>;
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
    URLSearchParams,
    location: { search: '' },
    localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    document: { addEventListener: vi.fn(), createElement: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
    CodemanApp: FakeCodemanApp,
    _crashDiag: { log: vi.fn() },
    ...globals,
    window: windowStub,
  });
  vm.runInContext(terminalSource, context, { filename: 'terminal-ui.js' });
  return { mixin: FakeCodemanApp.prototype, context, windowStub };
}

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: vi.fn((value: string) => values.add(value)),
    remove: vi.fn((value: string) => values.delete(value)),
    toggle: vi.fn((value: string, force?: boolean) => {
      const enabled = force === undefined ? !values.has(value) : force;
      if (enabled) values.add(value);
      else values.delete(value);
      return enabled;
    }),
    contains: (value: string) => values.has(value),
  };
}

function createPreviewHarness(
  options: {
    eligible?: boolean;
    createThrows?: boolean;
    omitGlobal?: boolean;
    themeForeground?: string;
    themeGetterThrows?: boolean;
  } = {}
) {
  const compositionView = {
    style: {
      fontFamily: '"Fira Code"',
      fontSize: '10px',
      fontWeight: '500',
      fontStyle: 'italic',
      lineHeight: '12px',
      height: '12px',
      color: 'rgb(255, 255, 255)',
    },
  };
  const helpers = {
    classList: fakeClassList(),
    children: [] as Array<Record<string, unknown>>,
    querySelector: (selector: string) => (selector === '.composition-view' ? compositionView : null),
    appendChild(node: Record<string, unknown>) {
      this.children.push(node);
    },
  };
  const createdControllers: Array<Record<string, any>> = [];
  const previewNodes: Array<Record<string, any>> = [];
  const documentStub = {
    addEventListener: vi.fn(),
    createElement: vi.fn(() => {
      const node = {
        className: '',
        hidden: false,
        textContent: '',
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          this.attributes[name] = value;
        },
        remove: vi.fn(),
      };
      previewNodes.push(node);
      return node;
    }),
  };
  const mobileImePreview = options.omitGlobal
    ? undefined
    : {
        isIosWebKitTouch: vi.fn(() => options.eligible ?? true),
        create: vi.fn((callbacks: Record<string, unknown>) => {
          if (options.createThrows) throw new Error('controller unavailable');
          const controller = {
            destroy: vi.fn(),
            reset: vi.fn(),
            consumeTerminalData: vi.fn(() => false),
            completeCommit: vi.fn(),
            noteAuthoritativeOutput: vi.fn(),
            callbacks,
          };
          createdControllers.push(controller);
          return controller;
        }),
      };
  const { mixin, windowStub } = loadMixin({
    document: documentStub,
    MobileImePreview: mobileImePreview,
    getComputedStyle: (node: { style: Record<string, string> }) => node.style,
  });
  windowStub.codemanCurrentXtermTheme = () => {
    if (options.themeGetterThrows) throw new Error('theme unavailable');
    return { foreground: '#334455' };
  };
  const app: App = Object.assign(Object.create(mixin), {
    terminal: {
      textarea: {},
      options: { theme: options.themeForeground ? { foreground: options.themeForeground } : undefined },
      element: { querySelector: (selector: string) => (selector === '.xterm-helpers' ? helpers : null) },
    },
    activeSessionId: 'session-a',
  });
  return { app, helpers, compositionView, previewNodes, createdControllers, mobileImePreview, windowStub };
}

describe('mobile IME preview delivery graph', () => {
  it('loads the controller after xterm and before terminal wiring', () => {
    const at = indexSource.indexOf('<script defer src="mobile-ime-preview.js"></script>');
    expect(at).toBeGreaterThan(indexSource.indexOf('vendor/xterm.min.js'));
    expect(at).toBeLessThan(indexSource.indexOf('<script defer src="terminal-ui.js"></script>'));
    expect(at).toBeLessThan(indexSource.indexOf('<script defer src="app.js"></script>'));
  });

  it('is minified and content-hashed by the build', () => {
    expect(buildSource).toContain("run('minify mobile-ime-preview.js'");
    expect(buildSource).toMatch(/const HASHABLE = \[[^\]]*'mobile-ime-preview\.js'/);
  });

  it('scopes preview presentation and native composition suppression to touch ownership', () => {
    expect(cssSource).toContain('.xterm-helpers .codeman-ime-preview {');
    expect(cssSource).toContain(".xterm-helpers .codeman-ime-preview[data-phase='provisional'] {");
    expect(cssSource).toContain('.touch-device .xterm-helpers.codeman-ime-preview-owned .composition-view.active {');
    const rule = cssSource.slice(cssSource.indexOf('.xterm-helpers .codeman-ime-preview {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('left: var(--xterm-helper-left, 0px)');
    expect(rule.slice(0, rule.indexOf('}'))).toContain('top: var(--xterm-helper-top, 0px)');
  });

  it('initializes the preview right after the terminal opens', () => {
    expect(terminalSource).toMatch(/this\.terminal\.open\(container\);\s*this\._initMobileImePreview\(\);/);
  });
});

describe('mobile IME preview lifecycle', () => {
  it('fails open when the global is absent or create throws', () => {
    for (const options of [{ omitGlobal: true }, { createThrows: true }]) {
      const { app } = createPreviewHarness(options);
      expect(() => app._initMobileImePreview()).not.toThrow();
      expect(app._mobileImePreview).toBeNull();
    }
  });

  it('does not create a controller on unsupported input platforms', () => {
    const { app, mobileImePreview, previewNodes } = createPreviewHarness({ eligible: false });
    app._initMobileImePreview();
    expect(mobileImePreview?.create).not.toHaveBeenCalled();
    expect(previewNodes).toHaveLength(0);
    expect(app._mobileImePreview).toBeNull();
  });

  it('creates one controller bound to the terminal textarea and one hidden preview node', () => {
    const { app, helpers, previewNodes, mobileImePreview } = createPreviewHarness();
    app._initMobileImePreview();
    expect(mobileImePreview?.create).toHaveBeenCalledOnce();
    expect(mobileImePreview?.create.mock.calls[0][0].textarea).toBe(app.terminal.textarea);
    expect(helpers.children).toEqual([previewNodes[0]]);
    expect(previewNodes[0]).toMatchObject({ className: 'codeman-ime-preview', hidden: true });
    expect(previewNodes[0].attributes['aria-hidden']).toBe('true');
  });

  it('destroys prior ownership on repeated initialization and keeps one active controller', () => {
    const { app, createdControllers, previewNodes, windowStub } = createPreviewHarness();
    app._initMobileImePreview();
    const first = createdControllers[0];
    app._initMobileImePreview();
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(previewNodes[0].remove).toHaveBeenCalledOnce();
    expect(createdControllers).toHaveLength(2);
    expect(app._mobileImePreview).toBe(createdControllers[1]);
    // Window listeners are released with the controller that owned them.
    expect((windowStub.removeEventListener as Fn).mock.calls.map((call) => call[0]).sort()).toEqual([
      'offline',
      'pagehide',
    ]);
  });

  it('destroy releases the controller, the node and the listeners', () => {
    const { app, createdControllers, previewNodes, windowStub } = createPreviewHarness();
    app._initMobileImePreview();
    app._destroyMobileImePreview();
    expect(createdControllers[0].destroy).toHaveBeenCalledOnce();
    expect(previewNodes[0].remove).toHaveBeenCalledOnce();
    expect(app._mobileImePreview).toBeNull();
    expect(windowStub.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('resets the controller exactly once when the active session changes', () => {
    const { app, createdControllers } = createPreviewHarness();
    app._initMobileImePreview();
    app.activeSessionId = 'session-b';
    app.loadAppSettingsFromStorage = () => ({ localEchoEnabled: false });
    app.sessions = new Map();
    app._updateLocalEchoState();
    app._updateLocalEchoState();
    expect(createdControllers[0].reset).toHaveBeenCalledOnce();
  });

  it('renders and clears owned preview state', () => {
    const { app, helpers, previewNodes, createdControllers } = createPreviewHarness();
    app._initMobileImePreview();
    const callbacks = createdControllers[0].callbacks;
    callbacks.render({ text: '你好', phase: 'provisional' });
    expect(previewNodes[0]).toMatchObject({ textContent: '你好', hidden: false, dataset: { phase: 'provisional' } });
    expect(helpers.classList.contains('codeman-ime-preview-owned')).toBe(true);
    callbacks.clear();
    expect(previewNodes[0]).toMatchObject({ textContent: '', hidden: true, dataset: {} });
    expect(helpers.classList.contains('codeman-ime-preview-owned')).toBe(false);
  });

  it('uses the terminal foreground while mirroring native composition font metrics', () => {
    const { app, compositionView, previewNodes, createdControllers } = createPreviewHarness({
      themeForeground: '#1f2328',
    });
    app._initMobileImePreview();
    createdControllers[0].callbacks.render({ text: '入力', phase: 'provisional' });
    expect(previewNodes[0].style).toMatchObject({
      fontFamily: compositionView.style.fontFamily,
      fontSize: compositionView.style.fontSize,
      fontWeight: compositionView.style.fontWeight,
      fontStyle: compositionView.style.fontStyle,
      lineHeight: compositionView.style.lineHeight,
      height: compositionView.style.height,
      color: '#1f2328',
    });
  });

  it('keeps rendering with a safe foreground when the theme getter throws', () => {
    const { app, previewNodes, createdControllers } = createPreviewHarness({ themeGetterThrows: true });
    app._initMobileImePreview();
    expect(() => createdControllers[0].callbacks.render({ text: '安全', phase: 'provisional' })).not.toThrow();
    expect(previewNodes[0].textContent).toBe('安全');
    expect(previewNodes[0].style.color).toBe('#e0e0e0');
  });

  it.each(['query', 'create', 'append', 'className', 'hidden'] as const)(
    'removes partial DOM ownership when %s fails',
    (failure) => {
      const removed = vi.fn();
      const owner = fakeClassList();
      const preview = new Proxy(
        { dataset: {}, remove: removed, setAttribute: vi.fn() },
        {
          set(target, property, value) {
            if (property === failure) throw new Error(`${failure} failed`);
            return Reflect.set(target, property, value);
          },
        }
      );
      const helpers = {
        classList: owner,
        appendChild:
          failure === 'append'
            ? () => {
                throw new Error('append failed');
              }
            : vi.fn(),
      };
      const documentStub = {
        addEventListener: vi.fn(),
        createElement:
          failure === 'create'
            ? () => {
                throw new Error('create failed');
              }
            : () => preview,
      };
      const MobileImePreview = { isIosWebKitTouch: () => true, create: vi.fn() };
      const { mixin } = loadMixin({ document: documentStub, MobileImePreview });
      const app: App = Object.assign(Object.create(mixin), {
        terminal: {
          textarea: {},
          element: {
            querySelector:
              failure === 'query'
                ? () => {
                    throw new Error('query failed');
                  }
                : () => helpers,
          },
        },
      });
      expect(() => app._initMobileImePreview()).not.toThrow();
      expect(app._mobileImePreview).toBeNull();
      expect(MobileImePreview.create).not.toHaveBeenCalled();
      expect(owner.contains('codeman-ime-preview-owned')).toBe(false);
      if (!['query', 'create'].includes(failure)) expect(removed).toHaveBeenCalled();
    }
  );
});

/**
 * Rebuilds the real `handleTerminalData` closure from initTerminal's source,
 * so these cases exercise the shipped routing rather than a copy of it.
 */
function loadHandleTerminalData(app: App, sent: string[]) {
  const marker = 'const handleTerminalData = (data) => {';
  const start = terminalSource.indexOf(marker);
  if (start < 0) throw new Error('handleTerminalData definition not found');
  const bodyStart = start + marker.length;
  const end = terminalSource.indexOf('\n    };', bodyStart);
  if (end < 0) throw new Error('handleTerminalData boundary not found');
  const timers: Array<() => void> = [];
  app._sendInputAsync = (_sessionId: string, data: string) => sent.push(data);
  const context = vm.createContext({
    console,
    performance,
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: vi.fn(),
    document: { activeElement: null, getElementById: vi.fn(() => null) },
    window: {
      cjkActive: false,
      CodemanTerminalInput: {
        BRACKETED_PASTE_START: '\x1b[200~',
        shouldSuppressTerminalQueryResponse: () => false,
        isTerminalFocusOrMouseReport: () => false,
        isComposerNavKey: () => false,
      },
    },
    _crashDiag: { log: vi.fn() },
    flushInput: () => {
      app._inputFlushTimeout = null;
      if (app._pendingInput && app.activeSessionId) {
        const input = app._pendingInput;
        app._pendingInput = '';
        app._sendInputAsync(app.activeSessionId, input);
      }
    },
  });
  const handler = vm.runInContext(`(function (data) {${terminalSource.slice(bodyStart, end)}\n})`, context) as (
    this: App,
    data: string
  ) => void;
  return { handle: (data: string) => handler.call(app, data), timers };
}

describe('mobile IME commit onData routing', () => {
  function onDataApp(options: {
    localEcho: boolean;
    tagged?: boolean;
    overlayMissing?: boolean;
    addThrows?: boolean;
    appendThrows?: boolean;
    consumeThrows?: boolean;
  }) {
    const { mixin } = loadMixin();
    const sent: string[] = [];
    const controller = {
      consumeTerminalData: options.consumeThrows
        ? vi.fn(() => {
            throw new Error('consume failed');
          })
        : vi
            .fn()
            .mockReturnValueOnce(options.tagged ?? true)
            .mockReturnValue(false),
      completeCommit: vi.fn(),
      noteAuthoritativeOutput: vi.fn(),
    };
    const overlay = {
      pendingText: '',
      appendText: vi.fn((data: string) => {
        if (options.appendThrows) throw new Error('overlay failed');
        overlay.pendingText += data;
      }),
      addChar: vi.fn((data: string) => {
        if (options.addThrows) throw new Error('overlay failed');
        overlay.pendingText += data;
      }),
      clear: vi.fn(() => {
        overlay.pendingText = '';
      }),
      suppressBufferDetection: vi.fn(),
    };
    const app: App = Object.assign(Object.create(mixin), {
      activeSessionId: 'session-a',
      _localEchoEnabled: options.localEcho,
      _localEchoOverlay: options.overlayMissing ? null : overlay,
      _echoPassthroughSessions: new Set(),
      _flushedOffsets: new Map(),
      _flushedTexts: new Map(),
      _pendingInput: '',
      _inputFlushTimeout: null,
      _lastKeystrokeTime: 0,
      _terminalOutputSeq: 5,
      _mobileImePreview: controller,
    });
    return { app, controller, overlay, sent, ...loadHandleTerminalData(app, sent) };
  }

  it('moves a multi-character commit into local echo and submits it only on Enter', () => {
    const { app, controller, overlay, sent, handle, timers } = onDataApp({ localEcho: true });
    handle('你好');
    expect(controller.consumeTerminalData).toHaveBeenCalledOnce();
    expect(overlay.appendText).toHaveBeenCalledWith('你好');
    expect(controller.completeCommit).toHaveBeenCalledWith({ predicted: true });
    expect(app._mobileImeCommitOutputSeq).toBeNull();
    expect(sent).toEqual([]);

    handle('\r');
    expect(sent).toEqual(['你好']);
    timers.shift()?.();
    expect(sent).toEqual(['你好', '\r']);
  });

  it('moves a single-character commit into local echo through addChar', () => {
    const { controller, overlay, sent, handle } = onDataApp({ localEcho: true });
    handle('界');
    expect(overlay.addChar).toHaveBeenCalledWith('界');
    expect(overlay.appendText).not.toHaveBeenCalled();
    expect(controller.completeCommit).toHaveBeenCalledWith({ predicted: true });
    expect(sent).toEqual([]);
  });

  it.each([
    ['the overlay is missing', { overlayMissing: true }, '日本'],
    ['appendText throws', { appendThrows: true }, '失敗'],
    ['addChar throws', { addThrows: true }, '字'],
  ])('sends the committed text exactly once when %s', (_label, extra, text) => {
    const { controller, sent, handle } = onDataApp({ localEcho: true, ...extra });
    expect(() => handle(text)).not.toThrow();
    expect(sent).toEqual([text]);
    // Nothing else shows the text yet, so the preview keeps it.
    expect(controller.completeCommit).not.toHaveBeenCalled();
  });

  it('keeps an untagged paste on the existing local echo path', () => {
    const { controller, overlay, sent, handle } = onDataApp({ localEcho: true, tagged: false });
    handle('plain paste');
    expect(overlay.pendingText).toBe('plain paste');
    expect(controller.completeCommit).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('sends a commit once without local echo and holds the preview until output arrives', () => {
    const { app, controller, sent, handle } = onDataApp({ localEcho: false });
    handle('日本語');
    expect(controller.consumeTerminalData).toHaveBeenCalledOnce();
    expect(sent).toEqual(['日本語']);
    expect(controller.completeCommit).not.toHaveBeenCalled();
    expect(app._mobileImeCommitOutputSeq).toBe(5);
  });

  it('sends the original bytes exactly once when the controller throws', () => {
    const { sent, handle } = onDataApp({ localEcho: false, consumeThrows: true });
    expect(() => handle('你好')).not.toThrow();
    expect(sent).toEqual(['你好']);
  });
});

describe('mobile IME commit and authoritative terminal output', () => {
  function outputHarness(mode = 'claude') {
    const { mixin } = loadMixin();
    const parses: Array<() => void> = [];
    const written: string[] = [];
    const controller = {
      consumeTerminalData: vi.fn(() => true),
      noteAuthoritativeOutput: vi.fn(),
    };
    const app: App = Object.assign(Object.create(mixin), {
      pendingWrites: [],
      terminal: {
        rows: 24,
        write: vi.fn((data: string, callback?: () => void) => {
          written.push(data);
          if (callback) parses.push(callback);
        }),
        buffer: { active: { viewportY: 0 } },
        scrollToBottom: vi.fn(),
      },
      activeSessionId: 'session-a',
      sessions: new Map([['session-a', { mode }]]),
      isTerminalAtBottom: () => true,
      _hasRecentUserScrollUp: () => false,
      _safeYield: vi.fn(),
      _localEchoOverlay: null,
      _mobileImePreview: controller,
    });
    const flush = () => {
      app.writeFrameScheduled = false;
      app.flushPendingWrites();
    };
    const parseNext = () => parses.shift()?.();
    return { app, controller, written, flush, parseNext };
  }

  it('clears the committed preview once output accepted after the commit is parsed', () => {
    const { app, controller, flush, parseNext } = outputHarness();
    app._consumeMobileImeTerminalData('你好');
    app.batchTerminalWrite('echo');
    flush();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
    parseNext();
    expect(controller.noteAuthoritativeOutput).toHaveBeenCalledOnce();
  });

  it('does not let output queued before the commit clear it, even when it parses after', () => {
    const { app, controller, flush, parseNext } = outputHarness();
    app.batchTerminalWrite('before');
    flush();
    app._consumeMobileImeTerminalData('你好');
    parseNext();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();

    app.batchTerminalWrite('after');
    flush();
    parseNext();
    expect(controller.noteAuthoritativeOutput).toHaveBeenCalledOnce();
  });

  it('does not let a split chunk clear the commit before its remainder is written', () => {
    const { app, controller, written, flush, parseNext } = outputHarness('codex');
    app._consumeMobileImeTerminalData('你好');
    app.batchTerminalWrite('x'.repeat(40000));
    flush();
    parseNext();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
    flush();
    parseNext();
    expect(written.join('')).toBe('x'.repeat(40000));
    expect(controller.noteAuthoritativeOutput).toHaveBeenCalledOnce();
  });

  it('does not let output parsed after a session switch clear the new session preview', () => {
    const { app, controller, flush, parseNext } = outputHarness();
    app._consumeMobileImeTerminalData('你好');
    app.batchTerminalWrite('echo');
    flush();
    app.activeSessionId = 'session-b';
    parseNext();
    expect(controller.noteAuthoritativeOutput).not.toHaveBeenCalled();
  });

  it('notifies once per commit, never for later output', () => {
    const { app, controller, flush, parseNext } = outputHarness();
    app._consumeMobileImeTerminalData('你好');
    for (const chunk of ['a', 'b']) {
      app.batchTerminalWrite(chunk);
      flush();
      parseNext();
    }
    expect(controller.noteAuthoritativeOutput).toHaveBeenCalledOnce();
  });
});
