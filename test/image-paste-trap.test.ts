/**
 * @fileoverview Unit tests for the Ctrl+V paste trap in image-input.js.
 *
 * `_handleImagePaste()` appends a hidden contenteditable div (the "paste
 * trap"), focuses it, and reads the clipboard out of the paste event the
 * browser delivers there. Two things can deliver that event for a single
 * Ctrl+V: the `document.execCommand('paste')` the function issues itself, and
 * the keydown's own default action, which still runs because xterm's custom key
 * handler returns false without cancelling the event. A browser that honours
 * execCommand('paste') therefore fires the trap's listener twice, and the
 * clipboard text used to reach the PTY twice with it — while right-click →
 * Paste, which involves no keydown, stayed correct.
 *
 * Loads the browser module into a vm sandbox with a fake document, so the tests
 * drive the trap's listener directly rather than through a real browser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const imageInputSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/image-input.js'), 'utf8');

interface TrapListener {
  (e: Record<string, unknown>): void;
}

interface FakeTrap {
  contentEditable: string;
  style: { cssText: string };
  parentNode: unknown;
  focus: () => void;
  addEventListener: (ev: string, fn: TrapListener) => void;
}

interface SentInput {
  sessionId: string;
  data: string;
}

interface TargetTerminal {
  input: (data: string) => void;
  paste?: (text: string) => void;
  focus?: () => void;
}

interface Harness {
  /** Fire a paste event on the trap the last _handleImagePaste() call created. */
  firePaste: (payload: { text?: string; images?: string[] }) => void;
  /** Text handed to xterm's terminal.paste(), one entry per call. */
  pastedText: string[];
  /** Frames handed to the primary terminal's input(), one entry per call. */
  inputted: string[];
  /** Frames handed to _sendInputAsync(), in order. The trap must not deliver text this way. */
  sentInputs: SentInput[];
  /** How many times predictive-echo predictions were cleared by the trap. */
  predictionsCleared: () => number;
  /** Unsent overlay text still held after the paste. Empty when local echo was not set up. */
  pendingEcho: () => string;
  /** Image batches handed to _uploadAndInsertImages(), one entry per call. */
  uploadedBatches: Array<Array<{ type: string }>>;
  /** Messages handed to showToast(), one entry per call. */
  toasts: string[];
  /** How many trap divs are still attached to the fake body. */
  attachedTraps: () => number;
  runTimers: () => void;
}

interface PasteHarnessOptions {
  /** Session the paste trap is aimed at. Defaults to the active session. */
  sessionId?: string;
  /** Unsent overlay text. The trap must leave this for onData to flush. */
  localEchoPending?: string;
  /** Terminal the Ctrl+V came from, when it is not the primary pane. */
  terminal?: TargetTerminal;
}

function loadPasteHarness(options: PasteHarnessOptions = {}): Harness {
  const traps: FakeTrap[] = [];
  const listeners: TrapListener[] = [];
  const attached = new Set<FakeTrap>();
  const timers: Array<() => void> = [];

  const documentObj = {
    createElement: (): FakeTrap => {
      const trap: FakeTrap = {
        contentEditable: '',
        style: { cssText: '' },
        parentNode: null,
        focus: () => {},
        addEventListener: (ev: string, fn: TrapListener) => {
          if (ev === 'paste') listeners.push(fn);
        },
      };
      traps.push(trap);
      return trap;
    },
    body: {
      appendChild: (el: FakeTrap) => {
        attached.add(el);
        el.parentNode = documentObj.body;
      },
      removeChild: (el: FakeTrap) => {
        attached.delete(el);
        el.parentNode = null;
      },
    },
    // A browser that honours the command fires the trap's paste listener from
    // here as well; the tests model that by firing the listener twice.
    execCommand: () => true,
    getElementById: () => null,
  };

  const context = vm.createContext({
    window: {},
    document: documentObj,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    console,
  });

  vm.runInContext('class CodemanApp {}', context);
  vm.runInContext(imageInputSource, context, { filename: 'image-input.js' });
  const CodemanApp = vm.runInContext('CodemanApp', context) as new () => Record<string, unknown>;

  const pastedText: string[] = [];
  const inputted: string[] = [];
  const sentInputs: SentInput[] = [];
  const uploadedBatches: Array<Array<{ type: string }>> = [];
  let predictionsCleared = 0;
  let pendingEcho = '';
  const app = new CodemanApp();
  app.activeSessionId = 'session-1';
  // Replay leaves xterm's DECSET 2004 mirror off. Text must still go out bracketed,
  // and must not ask terminal.paste() to consult that mirror (#716). input() is
  // what a real xterm fires onData from, with wasUserInput (scroll + clear selection).
  app.terminal = {
    paste: (text: string) => pastedText.push(text),
    input: (data: string) => inputted.push(data),
    focus: () => {},
    modes: { bracketedPasteMode: false },
  };
  app._sendInputAsync = (sessionId: string, data: string) => {
    sentInputs.push({ sessionId, data });
  };
  app._predictiveEcho = {
    clearPredictions: () => {
      predictionsCleared += 1;
    },
  };
  app._uploadAndInsertImages = (files: Array<{ type: string }>) => {
    uploadedBatches.push(Array.from(files));
  };
  if (options.localEchoPending !== undefined) {
    pendingEcho = options.localEchoPending;
    app._localEchoEnabled = true;
    app._pendingInput = '';
    app._localEchoOverlay = {
      get pendingText() {
        return pendingEcho;
      },
      set pendingText(value: string) {
        pendingEcho = value;
      },
      clear() {
        this.pendingText = '';
      },
      suppressBufferDetection() {},
    };
    app._flushedOffsets = new Map();
    app._flushedTexts = new Map();
    app._flushLocalEchoPending = function (this: Record<string, any>) {
      const pending = this._localEchoOverlay?.pendingText || '';
      this._localEchoOverlay.clear();
      this._localEchoOverlay.suppressBufferDetection();
      this._flushedOffsets?.delete(this.activeSessionId);
      this._flushedTexts?.delete(this.activeSessionId);
      if (pending) this._pendingInput += pending;
    };
  }
  const toasts: string[] = [];
  app.showToast = (message: string) => toasts.push(message);

  const target =
    options.sessionId || options.terminal
      ? { terminal: options.terminal ?? app.terminal, sessionId: options.sessionId || 'session-1' }
      : undefined;
  (app._handleImagePaste as (t?: object) => void).call(app, target);

  return {
    firePaste({ text = '', images = [] }) {
      const items = images.map((type) => ({ type, getAsFile: () => ({ type }) }));
      const event = {
        clipboardData: {
          items,
          getData: () => text,
        },
        preventDefault: () => {},
        stopPropagation: () => {},
      };
      for (const fn of listeners) fn(event);
    },
    pastedText,
    inputted,
    sentInputs,
    predictionsCleared: () => predictionsCleared,
    pendingEcho: () => pendingEcho,
    uploadedBatches,
    toasts,
    attachedTraps: () => attached.size,
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
    },
  };
}

function loadImageInputApp() {
  const context = vm.createContext({ console, window: {}, document: {} });
  vm.runInContext('class CodemanApp {}', context);
  vm.runInContext(imageInputSource, context, { filename: 'image-input.js' });
  const CodemanApp = vm.runInContext('CodemanApp', context) as new () => Record<string, unknown>;
  const app = new CodemanApp();
  app.activeSessionId = 'session-1';
  app.showToast = vi.fn();
  app.sendInput = vi.fn(async () => {});
  app._sendInputAsync = vi.fn();
  app._normalizeImageForUpload = vi.fn(async (file) => file);
  app._uploadPasteImage = vi.fn(async (_sessionId, file: { path: string }) => file.path);
  return app as Record<string, any>;
}

describe('Ctrl+V paste trap', () => {
  it('hands clipboard text to terminal.input as one bracketed paste, not through paste() or the session path', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: 'hello world' });

    // terminal.paste() would drop the markers: the harness mirror is off, which
    // is what a replay leaves behind. input() is the public entry that fires
    // onData with wasUserInput, so the pane scrolls and the selection clears.
    // Delivery belongs to that onData handler, not a second write from here.
    expect(h.pastedText).toEqual([]);
    expect(h.inputted).toEqual(['\x1b[200~hello world\x1b[201~']);
    expect(h.sentInputs).toEqual([]);
    expect(h.predictionsCleared()).toBe(0);
  });

  it('brackets a multi-line paste and strips nested paste markers', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: 'line one\nline two\r\n\x1b[200~nested\x1b[201~\n' });

    expect(h.pastedText).toEqual([]);
    expect(h.inputted).toEqual(['\x1b[200~line one\rline two\rnested\r\x1b[201~']);
    expect(h.sentInputs).toEqual([]);
  });

  it('addresses the bracketed paste to the pane that received Ctrl+V', () => {
    const paneInputs: string[] = [];
    const pane: TargetTerminal = {
      input: (data) => paneInputs.push(data),
      paste: () => {
        throw new Error('paste() must not run');
      },
      focus: () => {},
    };
    const h = loadPasteHarness({ sessionId: 'pane-b', terminal: pane });

    h.firePaste({ text: 'into pane b' });

    expect(paneInputs).toEqual(['\x1b[200~into pane b\x1b[201~']);
    expect(h.inputted).toEqual([]);
    expect(h.sentInputs).toEqual([]);
    expect(h.pastedText).toEqual([]);
  });

  it('leaves unsent local-echo text for onData, instead of flushing it itself', () => {
    const h = loadPasteHarness({ localEchoPending: 'hi' });

    h.firePaste({ text: 'world\n' });
    h.runTimers();

    // terminal.input() fires the main pane's onData, whose bracketed-paste
    // branch flushes the overlay and delays the frame (#219). Flushing here
    // as well would put the prefix on the wire twice.
    expect(h.pendingEcho()).toBe('hi');
    expect(h.inputted).toEqual(['\x1b[200~world\r\x1b[201~']);
    expect(h.sentInputs).toEqual([]);
    expect(h.pastedText).toEqual([]);
  });

  it('keeps a clipboard that looks like a query reply or a mouse report inside the frame', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: '\x1b[?1;2c\n\x1b[<0;10;5M\n\x1b[I' });

    expect(h.inputted).toEqual(['\x1b[200~\x1b[?1;2c\r\x1b[<0;10;5M\r\x1b[I\x1b[201~']);
    expect(h.sentInputs).toEqual([]);
    expect(h.pastedText).toEqual([]);
  });

  it('ignores a second paste event for the same Ctrl+V', () => {
    const h = loadPasteHarness();

    // execCommand('paste') and the uncancelled keydown's default action both
    // land on the same trap in browsers that honour the command.
    h.firePaste({ text: 'hello world' });
    h.firePaste({ text: 'hello world' });

    expect(h.inputted).toEqual(['\x1b[200~hello world\x1b[201~']);
    expect(h.sentInputs).toEqual([]);
    expect(h.pastedText).toEqual([]);
  });

  it('uploads a pasted image once when the trap sees two paste events', () => {
    const h = loadPasteHarness();

    h.firePaste({ images: ['image/png'] });
    h.firePaste({ images: ['image/png'] });

    expect(h.uploadedBatches).toHaveLength(1);
    expect(h.uploadedBatches[0]).toEqual([{ type: 'image/png' }]);
    expect(h.pastedText).toEqual([]);
    expect(h.sentInputs).toEqual([]);
  });

  it('a paste mixing an image with a refused file uploads the image and says what it skipped', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: 'shot.png', images: ['image/png', 'application/x-sh'] });

    expect(h.uploadedBatches).toEqual([[{ type: 'image/png' }]]);
    expect(h.toasts).toEqual(['1 file skipped: unsupported type']);
  });

  it('a paste whose only file is refused pastes its text instead, without a toast', () => {
    const h = loadPasteHarness();

    // Copying from a document can carry both: the text is what the user gets.
    h.firePaste({ text: 'echo hi', images: ['application/x-sh'] });

    expect(h.inputted).toEqual(['\x1b[200~echo hi\x1b[201~']);
    expect(h.sentInputs).toEqual([]);
    expect(h.pastedText).toEqual([]);
    expect(h.uploadedBatches).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it('a paste of a refused file and no text says so instead of doing nothing', () => {
    const h = loadPasteHarness();

    h.firePaste({ images: ['application/x-sh'] });

    expect(h.pastedText).toEqual([]);
    expect(h.uploadedBatches).toEqual([]);
    expect(h.toasts).toEqual(['Unsupported file type']);
  });

  it('removes the trap and hands focus back after the paste it accepted', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: 'hello world' });
    expect(h.attachedTraps()).toBe(1);

    h.runTimers();
    expect(h.attachedTraps()).toBe(0);
  });
});

describe('image upload insertion policy', () => {
  it('returns ordered paths without terminal insertion when requested by the composer', async () => {
    const app = loadImageInputApp();
    const files = [{ path: '/tmp/first.png' }, { path: '/tmp/second.png' }];

    const paths = await app._uploadAndInsertImages(files, { insert: false });

    expect(Array.from(paths)).toEqual(['/tmp/first.png', '/tmp/second.png']);
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('preserves terminal insertion by default', async () => {
    const app = loadImageInputApp();

    const paths = await app._uploadAndInsertImages([{ path: '/tmp/legacy.png' }]);

    expect(Array.from(paths)).toEqual(['/tmp/legacy.png']);
    // The same delivery sendInput() uses (durable queue, useMux for the POST
    // fallback), but addressed to the session the batch was uploaded to.
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '/tmp/legacy.png', { useMux: true });
  });

  it('inserts into the session the upload started in, even after a tab switch mid-upload', async () => {
    const app = loadImageInputApp();
    // The user switches tabs while the upload is in flight. sendInput() re-read
    // activeSessionId after the awaits, so the paths used to land in session-2.
    app._uploadPasteImage = vi.fn(async (_sessionId, file: { path: string }) => {
      app.activeSessionId = 'session-2';
      return file.path;
    });

    await app._uploadAndInsertImages([{ path: '/tmp/shot.png' }]);

    expect(app._uploadPasteImage).toHaveBeenCalledWith('session-1', { path: '/tmp/shot.png' });
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '/tmp/shot.png', { useMux: true });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it('uploads to and inserts into an explicitly named session', async () => {
    const app = loadImageInputApp();

    await app._uploadAndInsertImages([{ path: '/tmp/pane-b.png' }], { sessionId: 'session-b' });

    expect(app._uploadPasteImage).toHaveBeenCalledWith('session-b', { path: '/tmp/pane-b.png' });
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-b', '/tmp/pane-b.png', { useMux: true });
  });

  it('shows the server reason in the toast when an upload fails', async () => {
    const app = loadImageInputApp();
    const reason = 'Prompt uploads are not supported for remote (SSH) sessions';
    app._uploadPasteImage = vi.fn(async () => {
      throw new Error(reason);
    });

    await app._uploadAndInsertImages([{ path: '/tmp/shot.png' }]);

    expect(app.showToast).toHaveBeenCalledWith(`1 failed: ${reason}`, 'error');
  });
});
