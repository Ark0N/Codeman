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
