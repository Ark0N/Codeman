/**
 * @fileoverview Send-on-Enter mode of the CJK input field (input-cjk.js,
 * setting cjkInputHoldUntilEnter): typed text stays in the field until Enter,
 * so a phone user can scroll the terminal and edit an answer before sending.
 *
 * Same vm-sandbox approach as input-cjk.test.ts, with a stub textarea that also
 * carries the attributes and style the mode touches.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PHANTOM = '​';

function makeTextarea() {
  const listeners = new Map<string, Array<(e?: unknown) => void>>();
  const attrs: Record<string, string> = {};
  return {
    value: '',
    placeholder: '',
    style: { height: '' } as Record<string, string>,
    scrollHeight: 34,
    attrs,
    blur: () => {},
    focus: () => {},
    classList: { contains: (c: string) => c === 'cjk-input-visible' },
    setSelectionRange: () => {},
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    addEventListener: (ev: string, fn: (e?: unknown) => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
    },
    removeEventListener: (ev: string, fn: (e?: unknown) => void) => {
      listeners.set(
        ev,
        (listeners.get(ev) ?? []).filter((f) => f !== fn)
      );
    },
    fire(ev: string, arg: Record<string, unknown> = {}) {
      const base = { preventDefault: () => {}, stopPropagation: () => {}, ...arg };
      for (const fn of listeners.get(ev) ?? []) fn(base);
    },
  };
}

function load({ hold = true } = {}) {
  const textarea = makeTextarea();
  const sent: string[] = [];
  const layout = vi.fn();
  const context = vm.createContext({
    window: {},
    document: { getElementById: (id: string) => (id === 'cjkInput' ? textarea : null), activeElement: null },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' },
    KeyboardHandler: { updateLayoutForKeyboard: layout },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    performance: { now: () => performance.now() },
    console,
  });
  const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/input-cjk.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'input-cjk.js' });
  const CjkInput = vm.runInContext('CjkInput', context);
  CjkInput.init({ send: (t: string) => sent.push(t) });
  CjkInput.setHoldUntilEnter(hold);
  textarea.fire('focus');
  return { CjkInput, textarea, sent, layout };
}

function type(textarea: ReturnType<typeof makeTextarea>, text: string) {
  textarea.value = PHANTOM + text;
  textarea.fire('input', { isComposing: false, inputType: 'insertText' });
}

describe('CJK input: Send on Enter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps typed text in the field instead of streaming it', () => {
    const { textarea, sent } = load();
    type(textarea, 'use Postgres');
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM + 'use Postgres');
  });

  it('keeps text after a physical keystroke (no zero-latency flush)', () => {
    const { textarea, sent } = load();
    textarea.fire('keydown', { key: 'a', keyCode: 65, ctrlKey: false, altKey: false, metaKey: false });
    type(textarea, 'a');
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });

  it('keeps text across a composition cycle and autocorrect rewrites', () => {
    const { textarea, sent } = load();
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + 'teh';
    textarea.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    textarea.fire('compositionend');
    textarea.value = PHANTOM + 'the';
    textarea.fire('input', { isComposing: false, inputType: 'insertReplacementText' });
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM + 'the');
  });

  it('sends one line as text + CR on Enter, then clears the field', () => {
    const { textarea, sent } = load();
    type(textarea, 'yes, use Postgres');
    const preventDefault = vi.fn();
    textarea.fire('keydown', { key: 'Enter', keyCode: 13, shiftKey: false, preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(sent).toEqual(['yes, use Postgres\r']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('sends a digit as typed so CLI menus still answer to it', () => {
    const { textarea, sent } = load();
    type(textarea, '2');
    textarea.fire('keydown', { key: 'Enter', keyCode: 13, shiftKey: false });
    expect(sent).toEqual(['2\r']);
  });

  it('sends several lines as one bracketed paste, Enter as a later write', () => {
    const { textarea, sent } = load();
    type(textarea, 'line one\nline two');
    textarea.fire('keydown', { key: 'Enter', keyCode: 13, shiftKey: false });
    expect(sent).toEqual(['\x1b[200~line one\rline two\x1b[201~']);
    vi.advanceTimersByTime(150);
    expect(sent).toEqual(['\x1b[200~line one\rline two\x1b[201~', '\r']);
  });

  it('drops paste markers inside the held text', () => {
    const { textarea, sent } = load();
    type(textarea, 'a\x1b[201~b\nc');
    textarea.fire('keydown', { key: 'Enter', keyCode: 13, shiftKey: false });
    expect(sent[0]).toBe('\x1b[200~ab\rc\x1b[201~');
  });

  it('treats Shift+Enter as a newline, never a send', () => {
    const { textarea, sent } = load();
    type(textarea, 'first');
    const preventDefault = vi.fn();
    textarea.fire('keydown', { key: 'Enter', keyCode: 13, shiftKey: true, preventDefault });
    vi.advanceTimersByTime(10);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('sends a bare Enter when the field is empty (accepting a default answer)', () => {
    const { textarea, sent } = load();
    textarea.fire('keydown', { key: 'Enter', keyCode: 13, shiftKey: false });
    expect(sent).toEqual(['\r']);
  });

  it('still forwards Backspace on an empty field to the PTY', () => {
    const { textarea, sent } = load();
    textarea.fire('keydown', { key: 'Backspace', keyCode: 8 });
    expect(sent).toEqual(['\x7f']);
  });

  it('Escape clears the held text without sending', () => {
    const { textarea, sent } = load();
    type(textarea, 'never mind');
    textarea.fire('keydown', { key: 'Escape', keyCode: 27 });
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('turns autocorrect on in the mode and back off without it', () => {
    const { CjkInput, textarea } = load();
    expect(textarea.attrs.autocorrect).toBe('on');
    expect(textarea.attrs.spellcheck).toBe('true');
    CjkInput.setHoldUntilEnter(false);
    expect(textarea.attrs.autocorrect).toBe('off');
    expect(textarea.attrs.spellcheck).toBe('false');
    expect(CjkInput.holdUntilEnter).toBe(false);
  });

  it('grows the field with its text and re-runs the keyboard layout', () => {
    const { textarea, layout } = load();
    layout.mockClear();
    textarea.scrollHeight = 60;
    type(textarea, 'a\nb\nc');
    vi.advanceTimersByTime(1000);
    expect(textarea.style.height).toBe('60px');
    expect(layout).toHaveBeenCalled();
  });

  it('live mode is unchanged: text streams after the debounce', () => {
    const { textarea, sent } = load({ hold: false });
    type(textarea, 'hi');
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual(['hi']);
  });
});
