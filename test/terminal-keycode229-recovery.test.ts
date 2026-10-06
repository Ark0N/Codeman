/**
 * Orphaned-input recovery for xterm's helper textarea (PR #388 / COD-27).
 *
 * xterm's CoreBrowserTerminal._inputEvent only forwards an `insertText` input
 * event when `(!ev.composed || !this._keyDownSeen)`. Chrome-on-Android's soft
 * keyboard produces `composed: true` input events preceded by a keydown, so
 * that guard is false and the committed character is silently dropped.
 *
 * The controller under test forwards the event's own `data` when — and only
 * when — xterm produced no canonical data for that keystroke. These tests
 * drive it with synthetic events and an injected timer; no browser is needed.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;

function makeTextarea() {
  const listeners = new Map<string, Set<Listener>>();
  const registrations: Array<{ type: string; capture: unknown }> = [];
  return {
    addEventListener(type: string, listener: Listener, capture?: unknown) {
      const bucket = listeners.get(type) ?? new Set<Listener>();
      bucket.add(listener);
      listeners.set(type, bucket);
      registrations.push({ type, capture });
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string, event: Record<string, unknown> = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...event });
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, bucket) => total + bucket.size, 0);
    },
    registrations() {
      return [...registrations];
    },
  };
}

/** A committed-text `input` event of the shape Chrome-on-Android delivers. */
function inputEvent(data: string, overrides: Record<string, unknown> = {}) {
  return { data, inputType: 'insertText', isComposing: false, ...overrides };
}

function harness({ screenReader = false } = {}) {
  const source = readFileSync(new URL('../src/web/public/terminal-keycode229-recovery.js', import.meta.url), 'utf8');
  const exposed: Record<string, any> = {};
  vm.runInNewContext(source, { window: exposed, globalThis: exposed }, { filename: 'terminal-keycode229-recovery.js' });

  const textarea = makeTextarea();
  const emitted: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;

  const controller = exposed.CodemanKeyCode229Recovery.create({
    textarea,
    emitRecovered: (data: string) => emitted.push(data),
    isScreenReaderMode: () => screenReader,
    setTimer: (callback: () => void) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id: number) => timers.delete(id),
  });

  return {
    controller,
    emitted,
    textarea,
    /** A keydown that carries NO usable key identity, exactly like GBoard's. */
    keydown(overrides: Record<string, unknown> = {}) {
      controller.handleKeyEvent({ type: 'keydown', key: 'Unidentified', keyCode: 229, ...overrides });
    },
    input(data: string, overrides: Record<string, unknown> = {}) {
      textarea.fire('input', inputEvent(data, overrides));
    },
    flushTimers() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    pendingTimers: () => timers.size,
  };
}

/** terminal-ui.js's exported predicates, loaded the same way as in test/mobile-shell-keyboard.test.ts. */
function loadTerminalInput() {
  const source = readFileSync(new URL('../src/web/public/terminal-ui.js', import.meta.url), 'utf8');
  const win: Record<string, any> = {
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const sandbox: Record<string, any> = {
    window: win,
    globalThis: win,
    document: { addEventListener() {} },
    CodemanApp: class {},
  };
  win.CodemanApp = sandbox.CodemanApp;
  vm.runInNewContext(source, sandbox, { filename: 'terminal-ui.js' });
  return win.CodemanTerminalInput as {
    shouldSuppressTerminalQueryResponse(data: string): boolean;
    isTerminalFocusOrMouseReport(data: string): boolean;
  };
}

describe('orphaned terminal input recovery', () => {
  it('forwards the committed text when xterm stayed silent', () => {
    const h = harness();
    h.keydown();
    h.input('x');
    expect(h.emitted).toEqual([]);
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);
  });

  it('forwards nothing when xterm emitted canonical data after the keydown', () => {
    // The "xterm handled it" case is decided by the COUNTER, never by assuming
    // the input event does not reach us. On capture it always does (xterm's
    // cancel() only stops later BUBBLE listeners), so this test dispatches the
    // real input event AND has xterm emit canonical data for that keystroke.
    const h = harness();
    h.keydown();
    h.input('x');
    h.controller.notifyCanonicalData();
    h.flushTimers();
    expect(h.emitted).toEqual([]);
  });

  it('registers the input listener in the CAPTURE phase', () => {
    // Measured in jsdom and headless chromium: a capture-phase listener on the
    // TARGET calling stopPropagation() (which is what xterm's cancel() does in
    // the branch where it handled the input) stops later BUBBLE listeners on
    // that same target, because the target is visited twice in the event path.
    //
    //   capture-then-BUBBLE,  stopPropagation:  ours NEVER fires
    //   capture-then-CAPTURE, stopPropagation:  ours still fires
    //
    // So this must not be "tidied" to bubble: on bubble we would silently stop
    // seeing exactly the events xterm handled, and whether we saw them at all
    // would depend on xterm's `options.cancelEvents`, which Codeman never sets.
    const h = harness();
    const input = h.textarea.registrations().filter((entry) => entry.type === 'input');
    expect(input).toHaveLength(1);
    expect(input[0].capture).toBe(true);
    for (const entry of h.textarea.registrations()) expect(entry.capture).toBe(true);
  });

  it('forwards nothing on the keypress path, where canonical data precedes the input event', () => {
    // xterm's _keyPress calls triggerDataEvent() and sets _keyPressHandled
    // BEFORE the input event fires. The "did xterm speak?" snapshot therefore
    // has to be taken at keydown; taken at input time it would already include
    // this emission and the character would be delivered twice.
    const h = harness();
    h.keydown();
    h.controller.notifyCanonicalData();
    h.input('x');
    h.flushTimers();
    expect(h.emitted).toEqual([]);
  });

  it('does not let a stale candidate swallow a later identical keystroke (defect 1)', () => {
    const h = harness();

    // First keystroke: orphaned, recovered.
    h.keydown();
    h.input('x');
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);

    // Second identical keystroke, handled by xterm itself.
    h.keydown();
    h.input('x');
    h.controller.notifyCanonicalData();
    h.flushTimers();

    // Exactly one recovery total, and the second keystroke's canonical byte was
    // never claimed or suppressed by the first one.
    expect(h.emitted).toEqual(['x']);
  });

  it('forwards committed text that no keydown key could describe, exactly once (defect 2)', () => {
    const h = harness();
    h.keydown({ key: 'Enter' });
    h.input('a longer commit');
    h.flushTimers();
    h.flushTimers();
    expect(h.emitted).toEqual(['a longer commit']);
  });

  it('recovers a GBoard keydown and never reads key or keyCode (defect 3)', () => {
    const h = harness();
    const reads: string[] = [];
    h.controller.handleKeyEvent({
      type: 'keydown',
      get key() {
        reads.push('key');
        return 'Unidentified';
      },
      get keyCode() {
        reads.push('keyCode');
        return 229;
      },
      get which() {
        reads.push('which');
        return 229;
      },
    });
    h.input('x');
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);
    expect(reads).toEqual([]);
  });

  it('delivers the last character BEFORE the Enter that submits it (defect 4)', () => {
    // Android soft keyboards commit the last character and send the Enter key in
    // ONE InputConnection transaction, so the `input` event and the Enter keydown
    // are processed before any zero-delay timer runs. Two things then went wrong
    // with a candidate that only resolved on its timer:
    //
    //   1. ORDER — xterm emits '\r' synchronously from the Enter keydown, and the
    //      local-echo composer submits `pendingText` right there. The recovered
    //      character arrived one macrotask too late to be part of the prompt.
    //   2. LOSS — that '\r' bumps the canonical counter, so by the time the
    //      candidate resolved, `canonicalCount > snapshot` read as "xterm spoke
    //      for this keystroke" and stood the recovery down. The character was
    //      dropped outright: every message sent from the phone lost its last
    //      character.
    //
    // Resolving pending candidates synchronously at the NEXT keydown fixes both:
    // the counter still holds the value it had when that candidate was created,
    // and the byte reaches the composer ahead of the Enter.
    const h = harness();
    h.keydown();
    h.input('o');
    expect(h.emitted).toEqual([]);

    h.keydown({ key: 'Enter' });
    expect(h.emitted).toEqual(['o']);

    // xterm now emits '\r' for the Enter. The already-resolved candidate must
    // not fire a second time when its timer is flushed.
    h.controller.notifyCanonicalData();
    h.flushTimers();
    expect(h.emitted).toEqual(['o']);
    expect(h.pendingTimers()).toBe(0);
  });

  it('still stands down at the next keydown when xterm spoke for the candidate', () => {
    // The synchronous resolve must not become a "forward everything" path: a
    // keystroke xterm delivered itself is still a duplicate if recovered.
    const h = harness();
    h.keydown();
    h.input('x');
    h.controller.notifyCanonicalData();
    h.keydown({ key: 'Enter' });
    h.flushTimers();
    expect(h.emitted).toEqual([]);
  });

  it('ignores input events that are not committed text', () => {
    const h = harness();
    for (const inputType of ['insertCompositionText', 'deleteContentBackward', 'insertLineBreak', 'insertFromPaste']) {
      h.keydown();
      h.input('x', { inputType });
    }
    h.keydown();
    h.input('');
    h.keydown();
    h.textarea.fire('input', { data: null, inputType: 'insertText' });
    h.flushTimers();
    expect(h.emitted).toEqual([]);
  });

  it('ignores composition and cancels pending candidates on compositionstart', () => {
    const composing = harness();
    composing.keydown();
    composing.input('x', { isComposing: true });
    composing.flushTimers();
    expect(composing.emitted).toEqual([]);

    const lifecycle = harness();
    lifecycle.textarea.fire('compositionstart');
    lifecycle.keydown();
    lifecycle.input('中');
    lifecycle.flushTimers();
    expect(lifecycle.emitted).toEqual([]);

    // compositionstart arriving after a candidate is queued must cancel it.
    const cancelled = harness();
    cancelled.keydown();
    cancelled.input('x');
    cancelled.textarea.fire('compositionstart');
    cancelled.flushTimers();
    expect(cancelled.emitted).toEqual([]);

    // compositionend releases the gate again.
    cancelled.textarea.fire('compositionend');
    cancelled.keydown();
    cancelled.input('y');
    cancelled.flushTimers();
    expect(cancelled.emitted).toEqual(['y']);
  });

  it('stays out of the way in screen reader mode', () => {
    const h = harness({ screenReader: true });
    h.keydown();
    h.input('x');
    h.flushTimers();
    expect(h.emitted).toEqual([]);
  });

  it('recovers an input event that arrives with no preceding keydown', () => {
    const h = harness();
    h.input('x');
    h.flushTimers();
    expect(h.emitted).toEqual(['x']);
  });

  it('clears timers and listeners on destroy', () => {
    const h = harness();
    expect(h.textarea.listenerCount()).toBeGreaterThan(0);
    h.keydown();
    h.input('x');
    expect(h.pendingTimers()).toBe(1);

    h.controller.destroy();
    expect(h.pendingTimers()).toBe(0);
    expect(h.textarea.listenerCount()).toBe(0);

    h.flushTimers();
    expect(h.emitted).toEqual([]);

    // Nothing fires after destroy, even if a stray event is delivered.
    h.textarea.fire('input', inputEvent('y'));
    h.flushTimers();
    expect(h.emitted).toEqual([]);
  });
});

describe('the first input event of a page load, with no keydown before it', () => {
  it('stands down when xterm already delivered it, instead of duplicating the text', () => {
    // Dictation (Android voice typing, desktop dictation, any `insertText` with
    // no key held) reaches xterm with `_keyDownSeen` false, so xterm's OWN capture
    // listener forwards it and bumps the canonical counter before this controller's
    // listener runs. The snapshot baseline has to predate that bump, or the
    // candidate reads "xterm stayed silent" and emits the text a second time.
    const h = harness();
    h.controller.notifyCanonicalData(); // xterm delivered it first
    h.input('hello');
    h.flushTimers();
    expect(h.emitted, 'xterm already delivered this text').toEqual([]);
  });

  it('still recovers one that xterm genuinely dropped', () => {
    const h = harness();
    h.input('hello'); // nothing from xterm for it
    h.flushTimers();
    expect(h.emitted).toEqual(['hello']);
  });
});

describe('terminal-ui wiring: what counts as "xterm spoke for this keystroke"', () => {
  const terminalSource = readFileSync(new URL('../src/web/public/terminal-ui.js', import.meta.url), 'utf8');

  it('gates notifyCanonicalData on the two predicates this file already owns', () => {
    // onData does NOT only carry keystrokes: xterm answers DA/DSR/CPR/OSC
    // queries through it during Ink redraws, and emits SGR mouse and focus
    // reports on its own initiative. Counting one of those as canonical data
    // for the pending keystroke stands the recovery down and leaves the
    // character dropped, worst on a busy agent pane, which is the case this
    // exists for. Same gate, same two predicates, as the one-shot Ctrl
    // modifier uses for the same question (test/mobile-shell-keyboard.test.ts).
    const notify = terminalSource.indexOf('_keyCode229Recovery?.notifyCanonicalData?.()');
    expect(notify).toBeGreaterThan(0);

    const gate = terminalSource.lastIndexOf(
      '!input?.shouldSuppressTerminalQueryResponse(data) && !input?.isTerminalFocusOrMouseReport(data)',
      notify
    );
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(notify);

    // ⚠️ The predicates live inside the module IIFE that ends long before this
    // call site, so they are reachable ONLY through the global. Bare references
    // would throw a ReferenceError straight into the surrounding try/catch,
    // which swallows it, and notifyCanonicalData would then NEVER run: the
    // recovery would re-emit a character xterm already delivered.
    expect(terminalSource.slice(gate - 120, notify)).toContain('window.CodemanTerminalInput');
  });

  it('stands down for a real keystroke, but not for a mouse report or a query reply', () => {
    // The gate as terminal-ui.js writes it. The wiring test above pins the real
    // source; this proves the behaviour it buys.
    const input = loadTerminalInput();
    const onData = (h: ReturnType<typeof harness>, data: string) => {
      if (!input.shouldSuppressTerminalQueryResponse(data) && !input.isTerminalFocusOrMouseReport(data)) {
        h.controller.notifyCanonicalData();
      }
    };

    for (const noise of ['\x1b[<0;10;5M', '\x1b[I', '\x1b[?1;2c']) {
      const h = harness();
      h.keydown();
      h.input('x');
      onData(h, noise);
      h.flushTimers();
      expect(h.emitted, `${JSON.stringify(noise)} must not stand the recovery down`).toEqual(['x']);
    }

    const typed = harness();
    typed.keydown();
    typed.input('x');
    onData(typed, 'x');
    typed.flushTimers();
    expect(typed.emitted, 'xterm really did deliver this one').toEqual([]);
  });
});

/**
 * xterm's `_handleAnyTextareaChanges` diffs the helper textarea with
 * `newValue.replace(oldValue, '')`, which only works when the keyboard appended.
 * Autocorrect on space (SwiftKey, Gboard) deletes the word and inserts the corrected
 * one, and xterm answers by sending the WHOLE value, then the inserted text again:
 * a real device log produced `testing the peompttesting the prompt rompt `.
 */
function editSyncHarness() {
  const source = readFileSync(new URL('../src/web/public/terminal-keycode229-recovery.js', import.meta.url), 'utf8');
  const exposed: Record<string, any> = {};
  vm.runInNewContext(source, { window: exposed, globalThis: exposed }, { filename: 'terminal-keycode229-recovery.js' });

  const textarea = Object.assign(makeTextarea(), { value: '' });
  const sent: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  // xterm's own (flawed) diff, as shipped, so the control case can prove the bug.
  const xtermOriginal = function (this: any) {
    const oldValue = textarea.value;
    exposed.__timers.set(++timerId, () => {
      const newValue = textarea.value;
      const diff = newValue.replace(oldValue, '');
      if (newValue.length > oldValue.length) sent.push(diff);
      else if (newValue.length < oldValue.length) sent.push('\x7f');
      else if (newValue !== oldValue) sent.push(newValue);
    });
  };
  exposed.__timers = timers;
  const helper = {
    _isComposing: false,
    _dataAlreadySent: '',
    _handleAnyTextareaChanges: xtermOriginal,
    _coreService: { triggerDataEvent: (data: string) => sent.push(data) },
  };
  const create = (withSync: boolean) =>
    exposed.CodemanKeyCode229Recovery.create({
      textarea,
      emitRecovered: (data: string) => sent.push(data),
      getCompositionHelper: withSync ? () => helper : undefined,
      setTimer: (callback: () => void) => {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
      },
      clearTimer: (id: number) => timers.delete(id),
    });
  return {
    exposed,
    helper,
    textarea,
    sent,
    create,
    /** One keydown, whose xterm timer is registered at keydown time like the real one. */
    keydown() {
      helper._handleAnyTextareaChanges();
    },
    edit(value: string) {
      textarea.value = value;
    },
    flush() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    /** What the shell line holds once every DEL has been applied. */
    line() {
      const out: string[] = [];
      for (const ch of sent.join('')) {
        if (ch === '\x7f') out.pop();
        else out.push(ch);
      }
      return out.join('');
    },
  };
}

describe('edit-based sync of the helper textarea (autocorrect replacements)', () => {
  const typeKeys = (h: ReturnType<typeof editSyncHarness>, text: string) => {
    for (const ch of text) {
      h.keydown();
      h.edit(h.textarea.value + ch);
      h.flush();
    }
  };

  // The exact event shape from a device log: per-key appends, then ONE keydown deleting five
  // characters and a SECOND keydown inserting `rompt `, both landing before any timer runs.
  const autocorrect = (h: ReturnType<typeof editSyncHarness>) => {
    typeKeys(h, 'testing the peompt');
    h.keydown();
    h.edit('testing the p');
    h.keydown();
    h.edit('testing the prompt ');
    h.flush();
  };

  // The batched Android shape (#441): the last character's keydown and `insertText` arrive in the
  // SAME page task as Enter's keydown. xterm's own Enter handling clears the textarea before the
  // edit's timer runs, so a timer left pending would diff the whole line against '' and send one
  // DEL per character AHEAD of the submitted line. The edit is therefore settled at the next
  // keydown, before xterm sees that key.
  it('settles a pending edit at the next keydown, so Enter in the same task cannot erase the line', () => {
    const h = editSyncHarness();
    const controller = h.create(true);
    typeKeys(h, 'hell');
    h.keydown();
    h.edit('hello');
    controller.handleKeyEvent({ type: 'keydown', key: 'Enter', keyCode: 13 });
    h.textarea.value = ''; // xterm's CR handling, which runs after the custom key handler
    h.flush();
    expect(h.sent.join('')).toBe('hello');
    expect(h.sent).not.toContain('\x7f');
  });

  it('autocorrect and Enter in one task submits the corrected line, not a run of DELs', () => {
    const h = editSyncHarness();
    const controller = h.create(true);
    typeKeys(h, 'testing the peompt');
    h.keydown();
    h.edit('testing the p');
    h.keydown();
    h.edit('testing the prompt ');
    controller.handleKeyEvent({ type: 'keydown', key: 'Enter', keyCode: 13 });
    h.textarea.value = '';
    h.flush();
    expect(h.line()).toBe('testing the prompt ');
    expect(h.sent.filter((c) => c === '\x7f')).toHaveLength(5); // the five deleted characters, nothing more
  });

  it('settling first stands the same keystroke’s orphan candidate down (no double send)', () => {
    const h = editSyncHarness();
    const controller = h.create(true);
    // xterm's canonical-data hook, as terminal-ui.js wires it.
    const origTrigger = h.helper._coreService.triggerDataEvent;
    h.helper._coreService.triggerDataEvent = (data: string) => {
      origTrigger(data);
      controller.notifyCanonicalData();
    };
    controller.handleKeyEvent({ type: 'keydown', key: 'Unidentified', keyCode: 229 });
    h.keydown();
    h.edit('o');
    h.textarea.fire('input', inputEvent('o'));
    controller.handleKeyEvent({ type: 'keydown', key: 'Enter', keyCode: 13 });
    h.flush();
    expect(h.sent.join('')).toBe('o');
  });

  it('control: xterm alone duplicates the line when the keyboard autocorrects', () => {
    const h = editSyncHarness();
    h.create(false);
    autocorrect(h);
    expect(h.sent.join('')).toBe('testing the peompttesting the prompt rompt ');
  });

  it('with edit sync the line ends up exactly as the textarea reads', () => {
    const h = editSyncHarness();
    h.create(true);
    autocorrect(h);
    expect(h.line()).toBe('testing the prompt ');
    expect(h.sent.filter((s) => s === '\x7f')).toHaveLength(5);
  });

  it('plain typing is still one chunk per keystroke, and a single delete is one DEL', () => {
    const h = editSyncHarness();
    h.create(true);
    typeKeys(h, 'abc');
    h.keydown();
    h.edit('ab');
    h.flush();
    expect(h.sent).toEqual(['a', 'b', 'c', '\x7f']);
  });

  it('a multi-character delete sends one DEL per character, not one DEL in total', () => {
    const h = editSyncHarness();
    h.create(true);
    typeKeys(h, 'hello');
    h.keydown();
    h.edit('he');
    h.flush();
    expect(h.sent.slice(5)).toEqual(['\x7f', '\x7f', '\x7f']);
  });

  it('an equal-length rewrite is a delete and a retype, not the whole value again', () => {
    const h = editSyncHarness();
    h.create(true);
    typeKeys(h, 'cat');
    h.keydown();
    h.edit('cut');
    h.flush();
    expect(h.sent.slice(3)).toEqual(['\x7f', '\x7f', 'ut']);
    expect(h.line()).toBe('cut');
  });

  it('does not resend after xterm clears the textarea (Enter), and counts emoji as one character', () => {
    const h = editSyncHarness();
    h.create(true);
    typeKeys(h, 'hi');
    h.textarea.value = ''; // xterm's own reset after Enter: no input event, no emission
    typeKeys(h, 'yo');
    expect(h.sent).toEqual(['h', 'i', 'y', 'o']);

    const e = editSyncHarness();
    e.create(true);
    typeKeys(e, 'a😀');
    e.keydown();
    e.edit('a');
    e.flush();
    expect(e.sent.slice(2)).toEqual(['\x7f']);
  });

  it('stays out of the way while composing, and leaves xterm alone without its internals', () => {
    const h = editSyncHarness();
    h.create(true);
    h.helper._isComposing = true;
    h.keydown();
    h.edit('x');
    h.flush();
    expect(h.sent).toEqual([]);

    const bare = editSyncHarness();
    const original = bare.helper._handleAnyTextareaChanges;
    bare.create(false);
    expect(bare.helper._handleAnyTextareaChanges).toBe(original);
  });

  it('restores xterm’s own handler on destroy', () => {
    const h = editSyncHarness();
    const original = h.helper._handleAnyTextareaChanges;
    const controller = h.create(true);
    expect(h.helper._handleAnyTextareaChanges).not.toBe(original);
    controller.destroy();
    expect(h.helper._handleAnyTextareaChanges).toBe(original);
  });

  it('terminal-ui.js hands the controller xterm’s composition helper', () => {
    const terminalSource = readFileSync(new URL('../src/web/public/terminal-ui.js', import.meta.url), 'utf8');
    expect(terminalSource).toMatch(/getCompositionHelper:\s*\(\)\s*=>\s*this\.terminal\?\._core\?\._compositionHelper/);
  });

  it('editBetween counts code points and replaces everything after the common prefix', () => {
    const { editBetween } = editSyncHarness().exposed.CodemanKeyCode229Recovery;
    expect(editBetween('abc', 'abcd')).toEqual({ deleted: 0, inserted: 'd' });
    expect(editBetween('abc', 'ab')).toEqual({ deleted: 1, inserted: '' });
    expect(editBetween('testing the peompt', 'testing the prompt ')).toEqual({ deleted: 5, inserted: 'rompt ' });
    expect(editBetween('x😀', 'x')).toEqual({ deleted: 1, inserted: '' });
    expect(editBetween('', '')).toEqual({ deleted: 0, inserted: '' });
  });
});
