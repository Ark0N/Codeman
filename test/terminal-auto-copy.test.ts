/**
 * Auto Copy (copy-on-select) guards.
 *
 * The feature is invisible when it works, so every bug in it is silent: a
 * clipboard that quietly stops updating, or one that quietly overwrites itself
 * on an unrelated click. These tests drive the SHIPPED decision helper
 * (constants.js) and the SHIPPED flush (terminal-ui.js), plus the settings
 * wiring that decides whether the toggle reaches the code at all.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

function loadHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  const windowRef: Record<string, any> = {};
  const documentListeners = new Map<string, ((ev: any) => void)[]>();
  let activeElement: any = null;
  let now = 1_000;

  const RealDate = Date;
  const DateStub: any = function DateStub(this: any, ...args: any[]) {
    return new (RealDate as any)(...args);
  };
  DateStub.now = () => now;

  const context = vm.createContext({
    window: windowRef,
    document: {
      body: { classList: { contains: () => false } },
      get activeElement() {
        return activeElement;
      },
      getElementById: () => null,
      addEventListener: (type: string, listener: (ev: any) => void) => {
        const list = documentListeners.get(type) ?? [];
        list.push(listener);
        documentListeners.set(type, list);
      },
    },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
    _crashDiag: { log: vi.fn() },
    Date: DateStub,
    performance: { now: () => now },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:yield', revokeObjectURL: () => {} },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => false },
    KeyboardHandler: { keyboardVisible: false },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    OSC52_STRIP_RE: /\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  const toasts: { message: string; type: string }[] = [];
  app.showToast = (message: string, type: string) => toasts.push({ message, type });
  app._copyText = vi.fn(async () => true);
  app.loadAppSettingsFromStorage = () => ({ autoCopySelection: true });
  app.terminal = {
    hasSelection: () => true,
    getSelection: () => 'copied text',
    clearSelection: vi.fn(),
    focus: vi.fn(),
  };

  return {
    app,
    windowRef,
    toasts,
    setNow: (value: number) => {
      now = value;
    },
    setActiveElement: (element: any) => {
      activeElement = element;
    },
  };
}

describe('decideAutoCopy', () => {
  const decide = (params: Record<string, unknown>) => loadHarness().windowRef.CodemanAutoCopy.decide(params);

  it('does nothing while the setting is off', () => {
    expect(decide({ enabled: false, text: 'hello', pending: true })).toBe('skip');
  });

  it('ignores a blank or whitespace-only selection', () => {
    // A drag across empty cells; a wall of spaces is never what the gesture meant.
    expect(decide({ enabled: true, text: '   \n  ', pending: true })).toBe('skip');
    expect(decide({ enabled: true, text: '', pending: true })).toBe('skip');
  });

  it('copies a genuine selection change even when the text repeats', () => {
    // Re-selecting the same text after copying something else in between is a
    // deliberate act, so `pending` outranks the text dedupe.
    expect(decide({ enabled: true, text: 'same', lastCopied: 'same', pending: true })).toBe('copy');
  });

  it('copies changed text when onSelectionChange has not fired yet', () => {
    // xterm fires onSelectionChange from its OWN document mouseup handler, and
    // listener order between the two is not something the app controls, so the
    // first copy of a drag must not depend on `pending`.
    expect(decide({ enabled: true, text: 'fresh', lastCopied: 'stale', pending: false })).toBe('copy');
  });

  it('leaves an unchanged selection alone on an unrelated mouseup', () => {
    expect(decide({ enabled: true, text: 'same', lastCopied: 'same', pending: false })).toBe('skip');
  });

  it('refuses a selection past the size cap instead of truncating it', () => {
    const { windowRef } = loadHarness();
    const huge = 'x'.repeat(windowRef.CodemanAutoCopy.MAX_CHARS + 1);
    expect(windowRef.CodemanAutoCopy.decide({ enabled: true, text: huge, pending: true })).toBe('too-large');
  });
});

describe('_flushAutoCopySelection', () => {
  it('copies the selection without clearing it or stealing focus', async () => {
    const { app } = loadHarness();
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();

    expect(app._copyText).toHaveBeenCalledWith('copied text');
    // The two things copyTerminalSelection does and this path must not: clearing
    // makes the text vanish under the cursor that highlighted it, and focusing
    // opens the on-screen keyboard over it on a phone.
    expect(app.terminal.clearSelection).not.toHaveBeenCalled();
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  it('starts the copy synchronously, inside the gesture that triggered it', () => {
    // Both clipboard paths need user activation: Firefox gates
    // navigator.clipboard.writeText on it, and execCommand('copy') (the
    // plain-HTTP fallback) must run in the gesture's own task.
    const { app } = loadHarness();
    app._autoCopyPending = true;

    void app._flushAutoCopySelection();

    expect(app._copyText).toHaveBeenCalledTimes(1);
  });

  it('stays silent while the setting is off', async () => {
    const { app, toasts } = loadHarness();
    app.loadAppSettingsFromStorage = () => ({ autoCopySelection: false });
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();

    expect(app._copyText).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it('treats a missing setting as off', async () => {
    const { app } = loadHarness();
    app.loadAppSettingsFromStorage = () => ({});
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();

    expect(app._copyText).not.toHaveBeenCalled();
  });

  it('announces itself once per page load, then goes quiet', async () => {
    const { app, toasts } = loadHarness();
    let text = 'first';
    app.terminal.getSelection = () => text;

    app._autoCopyPending = true;
    await app._flushAutoCopySelection();
    text = 'second';
    app._autoCopyPending = true;
    await app._flushAutoCopySelection();

    expect(app._copyText).toHaveBeenCalledTimes(2);
    expect(toasts).toEqual([{ message: 'Auto Copy: selection copied', type: 'success' }]);
  });

  it('disarms the pending flag so the next unrelated mouseup copies nothing', async () => {
    const { app } = loadHarness();
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();
    await app._flushAutoCopySelection();

    expect(app._autoCopyPending).toBe(false);
    expect(app._copyText).toHaveBeenCalledTimes(1);
  });

  it('hands focus back when the execCommand fallback took it', async () => {
    const { app, setActiveElement } = loadHarness();
    const terminalTextarea = { focus: vi.fn(), isConnected: true };
    setActiveElement(terminalTextarea);
    // The fallback appends a temp textarea, selects it, then removes it, which
    // leaves the document with no focused element at all.
    app._copyText = vi.fn(async () => {
      setActiveElement(null);
      return true;
    });
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();

    expect(terminalTextarea.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves focus alone when the clipboard API never moved it', async () => {
    const { app, setActiveElement } = loadHarness();
    const terminalTextarea = { focus: vi.fn(), isConnected: true };
    setActiveElement(terminalTextarea);
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();

    expect(terminalTextarea.focus).not.toHaveBeenCalled();
  });

  it('reports a blocked clipboard and lets the next gesture retry the same text', async () => {
    const { app, toasts } = loadHarness();
    app._copyText = vi.fn(async () => false);
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();
    expect(toasts).toEqual([{ message: 'Auto Copy failed: the browser blocked clipboard access', type: 'error' }]);

    // Without the reset, the dedupe would swallow every retry of the same text.
    app._autoCopyPending = false;
    await app._flushAutoCopySelection();
    expect(app._copyText).toHaveBeenCalledTimes(2);
  });

  it('throttles the failure toast so a blocked clipboard cannot spam every drag', async () => {
    const { app, toasts, setNow } = loadHarness();
    app._copyText = vi.fn(async () => false);

    app._autoCopyPending = true;
    await app._flushAutoCopySelection();
    setNow(2_000);
    app._autoCopyPending = true;
    await app._flushAutoCopySelection();
    expect(toasts).toHaveLength(1);

    setNow(1_000 + 10_001);
    app._autoCopyPending = true;
    await app._flushAutoCopySelection();
    expect(toasts).toHaveLength(2);
  });

  it('refuses an oversized selection and says how to copy it anyway', async () => {
    const { app, toasts, windowRef } = loadHarness();
    const huge = 'x'.repeat(windowRef.CodemanAutoCopy.MAX_CHARS + 1);
    app.terminal.getSelection = () => huge;
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();

    expect(app._copyText).not.toHaveBeenCalled();
    expect(toasts).toEqual([{ message: 'Selection too large to copy automatically. Press Ctrl+C.', type: 'warning' }]);
  });

  it('does nothing when the selection was already dropped', async () => {
    const { app } = loadHarness();
    app.terminal.hasSelection = () => false;
    app._autoCopyPending = true;

    await app._flushAutoCopySelection();

    expect(app._copyText).not.toHaveBeenCalled();
  });
});

describe('Auto Copy wiring', () => {
  const terminalUi = read('terminal-ui.js');
  const settingsUi = read('settings-ui.js');
  const html = read('index.html');
  const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');

  it('arms on a selection change and disarms when the selection is dropped', () => {
    const start = terminalUi.indexOf('this.terminal.onSelectionChange?.(');
    expect(start).toBeGreaterThan(-1);
    const body = terminalUi.slice(start, start + 1200);
    expect(body).toContain('this._autoCopyPending = false;');
    expect(body).toContain('this._autoCopyPending = true;');
  });

  it('flushes from the document mouseup, not from the selection change', () => {
    // Copying inside onSelectionChange would be one clipboard write per cell the
    // drag crosses.
    expect(terminalUi).toContain("document.addEventListener('mouseup', () => this._flushAutoCopySelection());");
    const start = terminalUi.indexOf('this.terminal.onSelectionChange?.(');
    const body = terminalUi.slice(start, terminalUi.indexOf('_autoCopyListenerInstalled', start));
    expect(body).not.toContain('_flushAutoCopySelection');
  });

  it('flushes from the touch gesture end, which never produces a mouseup', () => {
    // The touch path preventDefaults its touchend to stop the compat mouse pair
    // from stealing the selection back, so phones need their own call.
    const start = terminalUi.indexOf('_endTouchSelectionGesture() {');
    expect(start).toBeGreaterThan(-1);
    expect(terminalUi.slice(start, start + 900)).toContain('this._flushAutoCopySelection();');
  });

  it('keeps the toggle per-device: display key, stripped from the PUT, absent from the schema', () => {
    const displayKeys = settingsUi.slice(
      settingsUi.indexOf('const displayKeys = new Set(['),
      settingsUi.indexOf('])', settingsUi.indexOf('const displayKeys = new Set(['))
    );
    expect(displayKeys).toContain("'autoCopySelection'");
    // SettingsUpdateSchema is .strict(), so a key it does not declare 400s the
    // whole settings PUT if the client sends it.
    expect(settingsUi).toContain('autoCopySelection: _acs,');
    expect(schemas).not.toContain('autoCopySelection');
  });

  it('keeps the control loadable and savable by id', () => {
    expect(html).toContain('id="appSettingsAutoCopySelection"');
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsAutoCopySelection').checked = settings.autoCopySelection === true;"
    );
    expect(settingsUi).toContain("autoCopySelection: document.getElementById('appSettingsAutoCopySelection').checked,");
  });
});
