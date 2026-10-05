import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;
type ListenerOptions = boolean | { capture?: boolean };
type RegisteredListener = { listener: Listener; capture: boolean };

/**
 * A DOM node with just enough event dispatch to reproduce listener ORDER: an
 * ancestor's capture listeners, then the target's capture listeners, then the
 * target's bubble listeners (at-target capture-first, as in Chromium 89+ and
 * WebKit), then the ancestor's bubble listeners.
 */
class FakeNode {
  parent: FakeNode | null = null;
  protected listeners = new Map<string, RegisteredListener[]>();

  addEventListener(type: string, listener: Listener, options?: ListenerOptions) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, capture: options === true || options?.capture === true });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener, options?: ListenerOptions) {
    const capture = options === true || options?.capture === true;
    const listeners = this.listeners.get(type) ?? [];
    const index = listeners.findIndex(
      (registered) => registered.listener === listener && registered.capture === capture
    );
    if (index >= 0) listeners.splice(index, 1);
  }

  run(type: string, capture: boolean, event: Record<string, unknown>) {
    for (const registered of [...(this.listeners.get(type) ?? [])]) {
      if (registered.capture === capture) registered.listener(event);
    }
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    const full = { type, target: this, ...event };
    const ancestors: FakeNode[] = [];
    for (let node = this.parent; node; node = node.parent) ancestors.unshift(node);
    for (const ancestor of ancestors) ancestor.run(type, true, full);
    this.run(type, true, full);
    this.run(type, false, full);
    for (const ancestor of [...ancestors].reverse()) ancestor.run(type, false, full);
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.length, 0);
  }
}

class FakeTextarea extends FakeNode {
  value = 'unchanged';
}

type Scheduled = { id: number; callback: () => void; delay?: number };

function harness(
  overrides: Record<string, unknown> = {},
  beforeCreate?: (textarea: FakeTextarea, getController: () => Record<string, any> | undefined) => void
) {
  const source = readFileSync(new URL('../src/web/public/mobile-ime-preview.js', import.meta.url), 'utf8');
  const context = vm.createContext({ navigator: {} });
  vm.runInContext(source, context, { filename: 'mobile-ime-preview.js' });
  const api = vm.runInContext('MobileImePreview', context);
  // The terminal element: an ancestor of the helper textarea, like xterm's
  // `.xterm` root is of `.xterm-helper-textarea`.
  const element = new FakeNode();
  const textarea = new FakeTextarea();
  textarea.parent = element;
  const frames: Scheduled[] = [];
  const timers: Scheduled[] = [];
  let nextId = 1;
  const render = vi.fn();
  const clear = vi.fn();
  const onCommit = vi.fn();
  const scheduleFrame = vi.fn((callback: () => void) => {
    const id = nextId++;
    frames.push({ id, callback });
    return id;
  });
  const cancelFrame = vi.fn((id: number) => {
    const index = frames.findIndex((frame) => frame.id === id);
    if (index >= 0) frames.splice(index, 1);
  });
  const setTimer = vi.fn((callback: () => void, delay: number) => {
    const id = nextId++;
    timers.push({ id, callback, delay });
    return id;
  });
  const clearTimer = vi.fn((id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  });
  let controller: Record<string, unknown> | undefined;
  beforeCreate?.(textarea, () => controller);
  controller = api.create({
    textarea,
    keydownTarget: element,
    render,
    clear,
    onCommit,
    scheduleFrame,
    cancelFrame,
    setTimer,
    clearTimer,
    ...overrides,
  });
  const flushFrame = () => frames.shift()?.callback();
  const flushTimer = () => timers.shift()?.callback();

  return {
    api,
    element,
    textarea,
    frames,
    timers,
    render,
    clear,
    onCommit,
    scheduleFrame,
    cancelFrame,
    setTimer,
    clearTimer,
    controller,
    flushFrame,
    flushTimer,
  };
}

describe('MobileImePreview', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('collapses 500 composition updates into one latest-state frame', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    for (let i = 0; i < 500; i += 1) h.textarea.dispatch('compositionupdate', { data: `value-${i}` });

    expect(h.scheduleFrame).toHaveBeenCalledTimes(1);
    expect(h.render).not.toHaveBeenCalled();
    h.flushFrame();
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.render).toHaveBeenLastCalledWith({ text: 'value-499', phase: 'provisional' });
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.textarea.value).toBe('unchanged');
  });

  test('replaces provisional text for replacement, backspace, and composing input', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'abcdef' });
    h.textarea.dispatch('compositionupdate', { data: 'xy' });
    h.flushFrame();
    expect(h.render).toHaveBeenLastCalledWith({ text: 'xy', phase: 'provisional' });

    h.textarea.dispatch('input', { data: '', isComposing: true });
    h.flushFrame();
    expect(h.render).toHaveBeenLastCalledWith({ text: '', phase: 'provisional' });
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  test('caps the preview without changing the terminal handoff value', () => {
    const h = harness();
    const value = '界'.repeat(2050);
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: value });
    h.flushFrame();
    expect(h.render.mock.calls[0][0].text).toHaveLength(2048);
    h.textarea.dispatch('compositionend', { data: value });
    expect(h.controller.consumeTerminalData(value)).toBe(true);
    expect(h.onCommit).toHaveBeenCalledWith(value);
  });

  test('hands off only the first safe xterm onData value after finalization', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: '日本語' });
    h.textarea.dispatch('compositionend', { data: '日本語' });

    expect(h.controller.consumeTerminalData('日本語')).toBe(true);
    expect(h.controller.consumeTerminalData('日本語')).toBe(false);
    expect(h.onCommit).toHaveBeenCalledOnce();
    expect(h.render).not.toHaveBeenCalled();
    expect(h.frames).toHaveLength(1);
    h.flushFrame();
    expect(h.render).toHaveBeenLastCalledWith({ text: '日本語', phase: 'committed' });
    expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), 2000);
  });

  test('defers finalization rendering and updates the queued frame phase to committed', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'draft' });
    h.textarea.dispatch('compositionend');
    expect(h.render).not.toHaveBeenCalled();
    expect(h.frames).toHaveLength(1);

    expect(h.controller.consumeTerminalData('final')).toBe(true);
    expect(h.frames).toHaveLength(1);
    expect(h.render).not.toHaveBeenCalled();
    h.flushFrame();
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.render).toHaveBeenCalledWith({ text: 'final', phase: 'committed' });
  });

  test('treats the first safe xterm onData value as authoritative over stale provisional data', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'teh' });
    h.textarea.dispatch('compositionend');

    expect(h.controller.consumeTerminalData('the')).toBe(true);
    expect(h.onCommit).toHaveBeenCalledOnce();
    expect(h.onCommit).toHaveBeenCalledWith('the');
    expect(h.controller.consumeTerminalData('teh')).toBe(false);
  });

  test.each(['', '\n', 'line\rbreak', 'two\nlines', '\u0003', '\u007f'])(
    'rejects non-printable or multiline terminal data %j without consuming the pending value',
    (rejected) => {
      const h = harness();
      h.textarea.dispatch('compositionstart');
      h.textarea.dispatch('compositionend', { data: rejected });
      expect(h.controller.consumeTerminalData(rejected)).toBe(false);
      expect(h.onCommit).not.toHaveBeenCalled();
    }
  );

  test.each(['line\u2028break', 'line\u2029break'])(
    'rejects Unicode line separator terminal data %j without consuming the finalization fence',
    (rejected) => {
      const h = harness();
      h.textarea.dispatch('compositionstart');
      h.textarea.dispatch('compositionend');
      expect(h.controller.consumeTerminalData(rejected)).toBe(false);
      expect(h.controller.consumeTerminalData('safe')).toBe(true);
    }
  );

  test('keydown can finalize composition before a late compositionend', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: '確定' });
    h.textarea.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
    expect(h.controller.consumeTerminalData('確定')).toBe(true);
    h.textarea.dispatch('compositionend', { data: 'stale' });
    expect(h.controller.consumeTerminalData('stale')).toBe(false);
  });

  /**
   * Stand-in for xterm 6.0: `terminal.open()` registers a CAPTURE keydown
   * listener on the helper textarea (CoreBrowserTerminal.ts:379), and
   * CompositionHelper.keydown (CompositionHelper.ts:94-108) finalizes the
   * composition there, emitting the commit through onData synchronously, for
   * every keyCode except 20/229 and 16/17/18. It is registered BEFORE the
   * controller is created, exactly as terminal.open() precedes
   * _initMobileImePreview().
   */
  function withXtermStandIn() {
    const emitted: Array<{ data: string; consumed: boolean }> = [];
    let composing = false;
    let composition = '';
    const h = harness({}, (textarea, getController) => {
      const emit = (data: string) => emitted.push({ data, consumed: getController()?.consumeTerminalData(data) });
      textarea.addEventListener('compositionstart', () => {
        composing = true;
        composition = '';
      });
      textarea.addEventListener('compositionupdate', (event) => {
        composition = String(event.data ?? '');
      });
      textarea.addEventListener(
        'keydown',
        (event) => {
          if (composing && ![20, 229, 16, 17, 18].includes(event.keyCode as number)) {
            composing = false;
            emit(composition);
          }
          if (event.keyCode === 13) emit('\r');
        },
        true
      );
    });
    return { ...h, emitted, isXtermComposing: () => composing };
  }

  test('Enter mid-composition hands the commit xterm emits in its capture keydown to the preview', () => {
    const h = withXtermStandIn();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: '確定' });
    h.flushFrame();
    h.textarea.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false });

    expect(h.emitted).toEqual([
      { data: '確定', consumed: true },
      { data: '\r', consumed: false },
    ]);
    expect(h.onCommit).toHaveBeenCalledWith('確定');
    expect(h.controller.state).toMatchObject({ composing: false, awaitingCommit: false, committed: true });
    h.flushFrame();
    expect(h.render).toHaveBeenLastCalledWith({ text: '確定', phase: 'committed' });

    // The next unrelated keystroke is ordinary input, not an IME commit.
    expect(h.controller.consumeTerminalData('x')).toBe(false);
  });

  test.each([
    // keyCode 229 with isComposing:false and a real key identity: xterm keeps
    // composing, so the controller must too.
    ['the IME composition character', 'k', 229],
    ['CapsLock', 'CapsLock', 20],
    ['Shift', 'Shift', 16],
    ['Control', 'Control', 17],
    ['Alt', 'Alt', 18],
  ])('a keydown for %s keeps tracking the composition xterm is still composing', (_label, key, keyCode) => {
    const h = withXtermStandIn();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'か' });
    h.textarea.dispatch('keydown', { key, keyCode, isComposing: false });
    expect(h.isXtermComposing()).toBe(true);
    expect(h.controller.state).toMatchObject({ composing: true, awaitingCommit: false });

    // The preview follows the composition instead of freezing on the old value.
    h.textarea.dispatch('compositionupdate', { data: 'かな' });
    h.flushFrame();
    expect(h.render).toHaveBeenLastCalledWith({ text: 'かな', phase: 'provisional' });
    expect(h.emitted).toEqual([]);
  });

  test('ignores keydowns that did not target the helper textarea', () => {
    const h = harness();
    const sibling = new FakeNode();
    sibling.parent = h.element;
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: '漢字' });
    sibling.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
    expect(h.controller.state).toMatchObject({ composing: true, awaitingCommit: false });
  });

  test('destroy stops the controller observing keydown on the terminal element', () => {
    const h = withXtermStandIn();
    h.controller.destroy();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'later' });
    h.textarea.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
    expect(h.emitted).toEqual([
      { data: 'later', consumed: false },
      { data: '\r', consumed: false },
    ]);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.element.listenerCount()).toBe(0);
  });

  describe('a commit that never reaches onData', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function realTimerHarness() {
      return harness({
        setTimer: (callback: () => void, delay: number) => setTimeout(callback, delay),
        clearTimer: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      });
    }

    test.each([
      ['compositionend', (h: ReturnType<typeof harness>) => h.textarea.dispatch('compositionend', { data: '' })],
      [
        'a finalizing keydown',
        (h: ReturnType<typeof harness>) => h.textarea.dispatch('keydown', { key: 'Enter', keyCode: 13 }),
      ],
    ])('stops waiting after the same 2 s bound when finalized by %s', (_label, finalize) => {
      const h = realTimerHarness();
      h.textarea.dispatch('compositionstart');
      h.textarea.dispatch('compositionupdate', { data: 'deleted' });
      finalize(h);
      h.clear.mockClear();
      expect(h.controller.state).toMatchObject({ awaitingCommit: true, timerPending: true });

      vi.advanceTimersByTime(1999);
      expect(h.controller.state.awaitingCommit).toBe(true);
      vi.advanceTimersByTime(1);
      expect(h.controller.state).toMatchObject({ awaitingCommit: false, latest: '', timerPending: false });
      expect(h.clear).toHaveBeenCalledOnce();

      // The next unrelated keystroke or paste is not adopted as the IME commit.
      expect(h.controller.consumeTerminalData('x')).toBe(false);
      expect(h.controller.consumeTerminalData('pasted line')).toBe(false);
      expect(h.onCommit).not.toHaveBeenCalled();
    });

    test('a commit that arrives in time replaces the wait bound with the committed one', () => {
      const h = realTimerHarness();
      h.textarea.dispatch('compositionstart');
      h.textarea.dispatch('compositionend', { data: '日本' });
      vi.advanceTimersByTime(1500);
      expect(h.controller.consumeTerminalData('日本')).toBe(true);
      // The wait bound would have fired at 2000 ms; the committed bound runs
      // a full 2 s from the commit instead.
      vi.advanceTimersByTime(1000);
      expect(h.controller.state.committed).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(h.controller.state.committed).toBe(false);
    });

    test('a new composition cancels the previous wait bound', () => {
      const h = realTimerHarness();
      h.textarea.dispatch('compositionstart');
      h.textarea.dispatch('compositionend', { data: '' });
      vi.advanceTimersByTime(1500);
      h.textarea.dispatch('compositionstart');
      h.textarea.dispatch('compositionupdate', { data: 'next' });
      vi.advanceTimersByTime(1000);
      expect(h.controller.state).toMatchObject({ composing: true, latest: 'next' });
    });
  });

  test('generation fences stale frames and timers', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'old' });
    const staleFrame = h.frames[0].callback;
    h.textarea.dispatch('compositionstart');
    staleFrame();
    expect(h.render).not.toHaveBeenCalled();

    h.textarea.dispatch('compositionend', { data: 'first' });
    h.controller.consumeTerminalData('first');
    const staleTimer = h.timers[0].callback;
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'new' });
    h.flushFrame();
    staleTimer();
    expect(h.render).toHaveBeenLastCalledWith({ text: 'new', phase: 'provisional' });
  });

  test('predicted completion clears immediately while fallback waits for output or TTL', () => {
    const predicted = harness();
    predicted.textarea.dispatch('compositionstart');
    predicted.clear.mockClear();
    predicted.textarea.dispatch('compositionend', { data: 'one' });
    predicted.controller.consumeTerminalData('one');
    expect(predicted.frames).toHaveLength(1);
    predicted.controller.completeCommit({ predicted: true });
    expect(predicted.clear).toHaveBeenCalledOnce();
    expect(predicted.frames).toHaveLength(0);
    expect(predicted.timers).toHaveLength(0);
    expect(predicted.controller.state.latest).toBe('');
    expect(predicted.controller.state.committed).toBe(false);

    const fallback = harness();
    fallback.textarea.dispatch('compositionstart');
    fallback.clear.mockClear();
    fallback.textarea.dispatch('compositionend', { data: 'two' });
    fallback.controller.consumeTerminalData('two');
    fallback.controller.completeCommit({ predicted: false });
    expect(fallback.clear).not.toHaveBeenCalled();
    fallback.controller.noteAuthoritativeOutput();
    expect(fallback.clear).toHaveBeenCalledOnce();
    expect(fallback.frames).toHaveLength(0);
    expect(fallback.timers).toHaveLength(0);
    expect(fallback.controller.state.latest).toBe('');
    expect(fallback.controller.state.committed).toBe(false);

    const ttl = harness();
    ttl.textarea.dispatch('compositionstart');
    ttl.clear.mockClear();
    ttl.textarea.dispatch('compositionend', { data: 'three' });
    ttl.controller.consumeTerminalData('three');
    ttl.controller.completeCommit({ predicted: false });
    ttl.flushTimer();
    expect(ttl.clear).toHaveBeenCalledOnce();
    expect(ttl.frames).toHaveLength(0);
    expect(ttl.timers).toHaveLength(0);
    expect(ttl.controller.state.latest).toBe('');
    expect(ttl.controller.state.committed).toBe(false);
  });

  test('contains re-entrant reset and destroy from commit callbacks without resurrecting work', () => {
    let resetController: { reset(): void };
    const reset = harness({ onCommit: () => resetController.reset() });
    resetController = reset.controller;
    reset.textarea.dispatch('compositionstart');
    reset.textarea.dispatch('compositionupdate', { data: 'draft' });
    reset.textarea.dispatch('compositionend');
    expect(reset.controller.consumeTerminalData('final')).toBe(true);
    expect(reset.frames).toHaveLength(0);
    expect(reset.timers).toHaveLength(0);
    expect(reset.controller.state.latest).toBe('');

    let destroyController: { destroy(): void };
    const destroy = harness({ onCommit: () => destroyController.destroy() });
    destroyController = destroy.controller;
    destroy.textarea.dispatch('compositionstart');
    destroy.textarea.dispatch('compositionend');
    expect(destroy.controller.consumeTerminalData('final')).toBe(true);
    expect(destroy.textarea.listenerCount()).toBe(0);
    expect(destroy.element.listenerCount()).toBe(0);
    expect(destroy.frames).toHaveLength(0);
    expect(destroy.timers).toHaveLength(0);
    expect(destroy.controller.state.latest).toBe('');
  });

  test('contains re-entrant render and clear callbacks', () => {
    let renderController: { reset(): void };
    const render = harness({ render: () => renderController.reset() });
    renderController = render.controller;
    render.textarea.dispatch('compositionstart');
    render.textarea.dispatch('compositionupdate', { data: 'draft' });
    expect(() => render.flushFrame()).not.toThrow();
    expect(render.frames).toHaveLength(0);
    expect(render.timers).toHaveLength(0);
    expect(render.controller.state.latest).toBe('');

    let clearController: { destroy(): void };
    const clear = harness({ clear: () => clearController?.destroy() });
    clearController = clear.controller;
    expect(() => clear.textarea.dispatch('compositionstart')).not.toThrow();
    expect(clear.textarea.listenerCount()).toBe(0);
    expect(clear.element.listenerCount()).toBe(0);
    expect(clear.frames).toHaveLength(0);
    expect(clear.timers).toHaveLength(0);
  });

  test('fails open when frame or timer schedulers throw', () => {
    const frame = harness({
      scheduleFrame: () => {
        throw new Error('frame scheduler');
      },
    });
    frame.textarea.dispatch('compositionstart');
    expect(() => frame.textarea.dispatch('compositionupdate', { data: 'safe' })).not.toThrow();
    expect(frame.controller.state.framePending).toBe(false);

    let lateFrame: (() => void) | undefined;
    const timer = harness({
      scheduleFrame: (callback: () => void) => {
        lateFrame = callback;
        return 1;
      },
      cancelFrame: () => {},
      setTimer: () => {
        throw new Error('timer scheduler');
      },
    });
    timer.textarea.dispatch('compositionstart');
    timer.clear.mockClear();
    timer.textarea.dispatch('compositionend');
    expect(() => timer.controller.consumeTerminalData('safe')).not.toThrow();
    expect(timer.controller.state.committed).toBe(false);
    expect(timer.controller.state.latest).toBe('');
    expect(timer.controller.state.framePending).toBe(false);
    expect(timer.controller.state.timerPending).toBe(false);
    expect(timer.clear).toHaveBeenCalledOnce();
    lateFrame?.();
    expect(timer.render).not.toHaveBeenCalled();

    const tokenlessTimer = harness({ setTimer: () => undefined });
    tokenlessTimer.textarea.dispatch('compositionstart');
    tokenlessTimer.clear.mockClear();
    tokenlessTimer.textarea.dispatch('compositionend');
    expect(tokenlessTimer.controller.consumeTerminalData('safe')).toBe(true);
    expect(tokenlessTimer.controller.state.committed).toBe(false);
    expect(tokenlessTimer.controller.state.latest).toBe('');
    expect(tokenlessTimer.controller.state.framePending).toBe(false);
    expect(tokenlessTimer.controller.state.timerPending).toBe(false);
    expect(tokenlessTimer.frames).toHaveLength(0);
    expect(tokenlessTimer.timers).toHaveLength(0);
    expect(tokenlessTimer.clear).toHaveBeenCalledOnce();

    const cancellation = harness({
      cancelFrame: () => {
        throw new Error('frame cancellation');
      },
      clearTimer: () => {
        throw new Error('timer cancellation');
      },
    });
    cancellation.textarea.dispatch('compositionstart');
    cancellation.textarea.dispatch('compositionupdate', { data: 'draft' });
    cancellation.textarea.dispatch('compositionend');
    cancellation.controller.consumeTerminalData('final');
    expect(() => cancellation.controller.reset()).not.toThrow();
    expect(cancellation.controller.state.framePending).toBe(false);
    expect(cancellation.controller.state.timerPending).toBe(false);
  });

  test('authoritative output never clears active provisional composition', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.clear.mockClear();
    h.textarea.dispatch('compositionupdate', { data: 'active' });
    h.flushFrame();
    h.controller.noteAuthoritativeOutput();
    expect(h.clear).not.toHaveBeenCalled();
  });

  test('blur and reset cancel scheduled work and clear visual state', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.clear.mockClear();
    h.textarea.dispatch('compositionupdate', { data: 'pending' });
    h.textarea.dispatch('blur');
    expect(h.frames).toHaveLength(0);
    expect(h.clear).toHaveBeenCalledOnce();

    h.textarea.dispatch('compositionstart');
    h.clear.mockClear();
    h.textarea.dispatch('compositionupdate', { data: 'again' });
    h.controller.reset();
    expect(h.frames).toHaveLength(0);
    expect(h.clear).toHaveBeenCalledOnce();
    expect(h.controller.state.latest).toBe('');
    expect(h.controller.state.committed).toBe(false);
  });

  test('destroy is idempotent and removes listeners and scheduled work', () => {
    const h = harness();
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'pending' });
    expect(h.textarea.listenerCount()).toBe(5);
    expect(h.element.listenerCount()).toBe(1);
    h.controller.destroy();
    h.controller.destroy();
    expect(h.textarea.listenerCount()).toBe(0);
    expect(h.element.listenerCount()).toBe(0);
    expect(h.frames).toHaveLength(0);
    h.textarea.dispatch('compositionupdate', { data: 'ignored' });
    expect(h.scheduleFrame).toHaveBeenCalledOnce();
    expect(() => h.controller.reset()).not.toThrow();
    expect(h.controller.state.latest).toBe('');
    expect(h.controller.state.framePending).toBe(false);
    expect(h.controller.state.timerPending).toBe(false);
  });

  test('contains render, clear, and commit callback exceptions', () => {
    const h = harness({
      render: vi.fn(() => {
        throw new Error('render');
      }),
      clear: vi.fn(() => {
        throw new Error('clear');
      }),
      onCommit: vi.fn(() => {
        throw new Error('commit');
      }),
    });
    h.textarea.dispatch('compositionstart');
    h.textarea.dispatch('compositionupdate', { data: 'safe' });
    expect(() => h.flushFrame()).not.toThrow();
    h.textarea.dispatch('compositionend', { data: 'safe' });
    expect(() => h.controller.consumeTerminalData('safe')).not.toThrow();
    expect(() => h.controller.reset()).not.toThrow();
  });

  test.each([
    [{ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Mozilla/5.0 (iPad) AppleWebKit/605.1.15', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Mozilla/5.0 (iPod) AppleWebKit/605.1.15', maxTouchPoints: 1 }, true],
    [{ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 2 }, true],
    [{ userAgent: 'CriOS/120.0 (iPhone) AppleWebKit/605.1.15', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Mozilla/5.0 (iPhone) Gecko/120', maxTouchPoints: 5 }, false],
    [{ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15', maxTouchPoints: 0 }, false],
    [{ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 1 }, false],
    [{ userAgent: 'Mozilla/5.0 (Android) AppleWebKit/537.36', maxTouchPoints: 5 }, false],
  ])('detects iOS WebKit touch eligibility for %j', (nav, expected) => {
    expect(harness().api.isIosWebKitTouch(nav)).toBe(expected);
  });
});
