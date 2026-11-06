/**
 * @fileoverview Accessory keys that keep the keyboard up must not take focus on
 * press. A tap used to blur the terminal's textarea and the click handler then
 * refocused it, so every arrow/Tab/Esc tap started a keyboard dismissal. The bar
 * now cancels the mousedown default for exactly those keys (and the first,
 * arming tap of clear/compact); every other key keeps the old behavior.
 *
 * Loaded with `vm` against a minimal fake DOM, like the other accessory-bar tests.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Listener = (e: unknown) => void;
type Bar = {
  init(): void;
  _confirmAction: string | null;
  syncReadMyMind(): void;
  syncCodexKeys(): void;
  _syncComposerDraftIndicator(): void;
};

function loadBar() {
  const listeners: Record<string, Listener> = {};
  const element = {
    className: '',
    innerHTML: '',
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
  };
  const context = vm.createContext({
    console,
    document: { createElement: () => element, querySelector: () => null },
    MobileDetection: { isTouchDevice: () => true },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(
    `${readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8')}\nglobalThis.__bar = KeyboardAccessoryBar;`,
    context
  );
  const bar = (context as unknown as { __bar: Bar }).__bar;
  bar.syncReadMyMind = () => {};
  bar.syncCodexKeys = () => {};
  bar._syncComposerDraftIndicator = () => {};
  bar.init();
  // `null` is a press on the bar itself (padding, a gap): closest() finds no key.
  const press = (action: string | null) => {
    const preventDefault = vi.fn();
    listeners.mousedown({
      target: { closest: () => (action === null ? null : { dataset: { action } }) },
      preventDefault,
    });
    return preventDefault.mock.calls.length > 0;
  };
  return { bar, press };
}

describe('accessory keys keep the terminal focused on press', () => {
  it('cancels the press default for keys that leave the keyboard up', () => {
    const { press } = loadBar();
    for (const action of [
      'scroll-up',
      'scroll-down',
      'arrow-left',
      'arrow-right',
      'tab',
      'shift-tab',
      'shift-left',
      'shift-right',
      'ctrl',
      'ctrl-o',
      'opt-enter',
      'esc',
      'effort-max',
      'clear-input',
    ]) {
      expect(press(action), action).toBe(true);
    }
  });

  it('leaves keys that move focus or dismiss the keyboard alone', () => {
    const { press } = loadBar();
    for (const action of ['compose', 'readmymind', 'pick-path', 'paste', 'dismiss', 'init']) {
      expect(press(action), action).toBe(false);
    }
  });

  it('cancels only the arming tap of clear/compact, not the confirming one', () => {
    const { bar, press } = loadBar();
    bar._confirmAction = null;
    expect(press('clear')).toBe(true);
    bar._confirmAction = 'clear';
    expect(press('clear')).toBe(false);
    expect(press('compact')).toBe(true);
    bar._confirmAction = 'compact';
    expect(press('compact')).toBe(false);
  });

  it('ignores a press outside a key', () => {
    const { press } = loadBar();
    expect(press(null)).toBe(false);
  });
});
