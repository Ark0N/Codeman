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
import { describe, expect, it } from 'vitest';

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

interface Harness {
  /** Fire a paste event on the trap the last _handleImagePaste() call created. */
  firePaste: (payload: { text?: string; images?: string[] }) => void;
  /** Text handed to xterm's terminal.paste(), one entry per call. */
  pastedText: string[];
  /** Image batches handed to _uploadAndInsertImages(), one entry per call. */
  uploadedBatches: Array<Array<{ type: string }>>;
  /** How many trap divs are still attached to the fake body. */
  attachedTraps: () => number;
  runTimers: () => void;
}

function loadPasteHarness(): Harness {
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
  const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/image-input.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'image-input.js' });
  const CodemanApp = vm.runInContext('CodemanApp', context) as new () => Record<string, unknown>;

  const pastedText: string[] = [];
  const uploadedBatches: Array<Array<{ type: string }>> = [];
  const app = new CodemanApp();
  app.activeSessionId = 'session-1';
  app.terminal = {
    paste: (text: string) => pastedText.push(text),
    focus: () => {},
  };
  app._uploadAndInsertImages = (files: Array<{ type: string }>) => {
    uploadedBatches.push(Array.from(files));
  };
  app.showToast = () => {};

  (app._handleImagePaste as () => void).call(app);

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
    uploadedBatches,
    attachedTraps: () => attached.size,
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
    },
  };
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
