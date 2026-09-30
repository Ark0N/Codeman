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

interface FirePayload {
  text?: string;
  /** image/* items whose getAsFile() returns a blob (the healthy path) */
  images?: string[];
  /** image/* items whose getAsFile() returns null (the intermittent failure) */
  nullImages?: string[];
  /** kind='file' items with an empty MIME type whose getAsFile() returns a blob of the given type */
  emptyMimeFiles?: string[];
  /** clipboardData.files entries, by MIME type */
  dtFiles?: string[];
}

interface ClipboardItemLike {
  types: string[];
  getType: (t: string) => Promise<unknown>;
}

interface HarnessOptions {
  secureContext?: boolean;
  /** navigator.clipboard.read implementation; absent means the API does not exist */
  clipboardRead?: () => Promise<ClipboardItemLike[]>;
}

interface Harness {
  /** Fire a paste event on the trap the last _handleImagePaste() call created. */
  firePaste: (payload: FirePayload) => void;
  /** Let the async clipboard.read() fallback settle (uses real node timers). */
  awaitFallback: () => Promise<void>;
  /** Text handed to xterm's terminal.paste(), one entry per call. */
  pastedText: string[];
  /** Image batches handed to _uploadAndInsertImages(), one entry per call. */
  uploadedBatches: Array<Array<{ type: string }>>;
  /** Toasts shown, in order. */
  toasts: Array<{ message: string; kind: string }>;
  /** How many times navigator.clipboard.read() was invoked. */
  clipboardReadCalls: () => number;
  /** How many trap divs are still attached to the fake body. */
  attachedTraps: () => number;
  runTimers: () => void;
}

function loadPasteHarness(options: HarnessOptions = {}): Harness {
  const traps: FakeTrap[] = [];
  const listeners: TrapListener[] = [];
  const attached = new Set<FakeTrap>();
  const timers: Array<() => void> = [];
  let clipboardReadCalls = 0;

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

  const navigatorObj: Record<string, unknown> = {};
  if (options.clipboardRead) {
    const readImpl = options.clipboardRead;
    navigatorObj.clipboard = {
      read: () => {
        clipboardReadCalls++;
        return readImpl();
      },
    };
  }

  const context = vm.createContext({
    window: { isSecureContext: options.secureContext ?? true },
    navigator: navigatorObj,
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
  const uploadedBatches: Array<Array<{ type: string }>> = [];
  const toasts: Array<{ message: string; kind: string }> = [];
  const app = new CodemanApp();
  app.activeSessionId = 'session-1';
  app.terminal = {
    paste: (text: string) => pastedText.push(text),
    focus: () => {},
  };
  app._uploadAndInsertImages = (files: Array<{ type: string }>) => {
    uploadedBatches.push(Array.from(files));
  };
  app.showToast = (message: string, kind: string) => {
    toasts.push({ message, kind });
  };

  (app._handleImagePaste as () => void).call(app);

  return {
    firePaste({ text = '', images = [], nullImages = [], emptyMimeFiles = [], dtFiles = [] }) {
      const items = [
        ...images.map((type) => ({ type, kind: 'file', getAsFile: () => ({ type }) })),
        ...nullImages.map((type) => ({ type, kind: 'file', getAsFile: () => null })),
        ...emptyMimeFiles.map((blobType) => ({ type: '', kind: 'file', getAsFile: () => ({ type: blobType }) })),
      ];
      const files = dtFiles.map((type) => ({ type }));
      const event = {
        clipboardData: {
          items,
          files,
          getData: () => text,
        },
        preventDefault: () => {},
        stopPropagation: () => {},
      };
      for (const fn of listeners) fn(event);
    },
    awaitFallback: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    pastedText,
    uploadedBatches,
    toasts,
    clipboardReadCalls: () => clipboardReadCalls,
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
  app._normalizeImageForUpload = vi.fn(async (file) => file);
  app._uploadPasteImage = vi.fn(async (_sessionId, file: { path: string }) => file.path);
  return app as Record<string, any>;
}

describe('Ctrl+V paste trap', () => {
  it('sends clipboard text to the terminal once for a single paste event', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: 'hello world' });

    expect(h.pastedText).toEqual(['hello world']);
  });

  it('ignores a second paste event for the same Ctrl+V', () => {
    const h = loadPasteHarness();

    // execCommand('paste') and the uncancelled keydown's default action both
    // land on the same trap in browsers that honour the command.
    h.firePaste({ text: 'hello world' });
    h.firePaste({ text: 'hello world' });

    expect(h.pastedText).toEqual(['hello world']);
  });

  it('uploads a pasted image once when the trap sees two paste events', () => {
    const h = loadPasteHarness();

    h.firePaste({ images: ['image/png'] });
    h.firePaste({ images: ['image/png'] });

    expect(h.uploadedBatches).toHaveLength(1);
    expect(h.uploadedBatches[0]).toEqual([{ type: 'image/png' }]);
    expect(h.pastedText).toEqual([]);
  });

  it('removes the trap and hands focus back after the paste it accepted', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: 'hello world' });
    expect(h.attachedTraps()).toBe(1);

    h.runTimers();
    expect(h.attachedTraps()).toBe(0);
  });
});

describe('paste trap clipboard fallback', () => {
  it('recovers via navigator.clipboard.read() when getAsFile() returns null', async () => {
    const h = loadPasteHarness({
      clipboardRead: async () => [{ types: ['image/png'], getType: async () => ({ type: 'image/png' }) }],
    });

    h.firePaste({ nullImages: ['image/png'] });
    await h.awaitFallback();

    expect(h.uploadedBatches).toHaveLength(1);
    expect(h.uploadedBatches[0]).toEqual([{ type: 'image/png' }]);
    expect(h.pastedText).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it('toasts instead of failing silently when the Clipboard API is absent', async () => {
    const h = loadPasteHarness();

    h.firePaste({ nullImages: ['image/png'] });
    await h.awaitFallback();

    expect(h.uploadedBatches).toEqual([]);
    expect(h.pastedText).toEqual([]);
    expect(h.toasts).toEqual([{ message: 'Could not read the pasted image from the clipboard', kind: 'warning' }]);
  });

  it('toasts when the Clipboard API is unavailable on a non-secure context', async () => {
    const h = loadPasteHarness({
      secureContext: false,
      clipboardRead: async () => {
        throw new Error('must not be called without a secure context');
      },
    });

    h.firePaste({ nullImages: ['image/png'] });
    await h.awaitFallback();

    expect(h.uploadedBatches).toEqual([]);
    expect(h.toasts).toHaveLength(1);
  });

  it('toasts when clipboard.read() is denied', async () => {
    const h = loadPasteHarness({
      clipboardRead: async () => {
        throw new Error('denied');
      },
    });

    h.firePaste({ nullImages: ['image/png'] });
    await h.awaitFallback();

    expect(h.uploadedBatches).toEqual([]);
    expect(h.toasts).toHaveLength(1);
  });

  it('resolves the fallback when clipboard.read() never settles (unanswerable permission prompt)', async () => {
    const h = loadPasteHarness({
      // Some engines leave read() pending forever instead of rejecting.
      clipboardRead: () => new Promise<ClipboardItemLike[]>(() => {}),
    });

    h.firePaste({ nullImages: ['image/png'] });
    await h.awaitFallback();

    // Still waiting: no toast yet, and the read was attempted once.
    expect(h.clipboardReadCalls()).toBe(1);
    expect(h.uploadedBatches).toEqual([]);
    expect(h.toasts).toEqual([]);

    // The bounded wait elapses; the toast appears instead of silence.
    h.runTimers();
    await h.awaitFallback();

    expect(h.uploadedBatches).toEqual([]);
    expect(h.toasts).toEqual([{ message: 'Could not read the pasted image from the clipboard', kind: 'warning' }]);
  });

  it('never touches the async Clipboard API for plain-text pastes', async () => {
    const h = loadPasteHarness({
      clipboardRead: async () => {
        throw new Error('must not prompt for a text paste');
      },
    });

    h.firePaste({ text: 'hello world' });
    await h.awaitFallback();

    expect(h.pastedText).toEqual(['hello world']);
    expect(h.clipboardReadCalls()).toBe(0);
    expect(h.toasts).toEqual([]);
  });

  it('uploads empty-MIME file items through the synchronous path', async () => {
    const h = loadPasteHarness({
      clipboardRead: async () => {
        throw new Error('must not be called when the sync path succeeds');
      },
    });

    h.firePaste({ emptyMimeFiles: ['image/png'] });
    await h.awaitFallback();

    expect(h.uploadedBatches).toHaveLength(1);
    expect(h.uploadedBatches[0]).toEqual([{ type: 'image/png' }]);
    expect(h.clipboardReadCalls()).toBe(0);
    expect(h.toasts).toEqual([]);
  });

  it('uploads clipboardData.files entries through the synchronous path', async () => {
    const h = loadPasteHarness({
      clipboardRead: async () => {
        throw new Error('must not be called when the sync path succeeds');
      },
    });

    h.firePaste({ dtFiles: ['image/jpeg'] });
    await h.awaitFallback();

    expect(h.uploadedBatches).toHaveLength(1);
    expect(h.clipboardReadCalls()).toBe(0);
  });

  it('attempts the fallback only once when two paste events arrive', async () => {
    const h = loadPasteHarness({ clipboardRead: async () => [] });

    h.firePaste({ nullImages: ['image/png'] });
    h.firePaste({ nullImages: ['image/png'] });
    await h.awaitFallback();

    expect(h.clipboardReadCalls()).toBe(1);
    expect(h.toasts).toHaveLength(1);
  });
});

describe('pasted image collection', () => {
  it('collects the same blob once when a browser exposes it via both items and files', () => {
    const app = loadImageInputApp();
    const blob = { type: 'image/png' };

    const collected = app._collectPastedImages({
      items: [{ type: 'image/png', kind: 'file', getAsFile: () => blob }],
      files: [blob],
    });

    expect(collected.files).toEqual([blob]);
    expect(collected.sawImageData).toBe(true);
  });

  it('keeps distinct blobs collected from items and files', () => {
    const app = loadImageInputApp();
    const fromItems = { type: 'image/png' };
    const fromFiles = { type: 'image/png' };

    const collected = app._collectPastedImages({
      items: [{ type: 'image/png', kind: 'file', getAsFile: () => fromItems }],
      files: [fromFiles],
    });

    expect(collected.files).toEqual([fromItems, fromFiles]);
    expect(collected.sawImageData).toBe(true);
  });
});

describe('image upload insertion policy', () => {
  it('returns ordered paths without terminal insertion when requested by the composer', async () => {
    const app = loadImageInputApp();
    const files = [{ path: '/tmp/first.png' }, { path: '/tmp/second.png' }];

    const paths = await app._uploadAndInsertImages(files, { insert: false });

    expect(Array.from(paths)).toEqual(['/tmp/first.png', '/tmp/second.png']);
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it('preserves terminal insertion by default', async () => {
    const app = loadImageInputApp();

    const paths = await app._uploadAndInsertImages([{ path: '/tmp/legacy.png' }]);

    expect(Array.from(paths)).toEqual(['/tmp/legacy.png']);
    expect(app.sendInput).toHaveBeenCalledWith('/tmp/legacy.png');
  });
});
