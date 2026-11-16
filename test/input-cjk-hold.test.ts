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

function load({ hold = true, promptResult = true } = {}) {
  const textarea = makeTextarea();
  const sent: string[] = [];
  const prompts: string[] = [];
  const layout = vi.fn();
  // The shell bar's one-shot Ctrl, reduced to its armed flag.
  const bar = {
    armed: false,
    isCtrlArmed() {
      return this.armed;
    },
    clearCtrl() {
      this.armed = false;
    },
  };
  const context = vm.createContext({
    window: {},
    document: { getElementById: (id: string) => (id === 'cjkInput' ? textarea : null), activeElement: null },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' },
    KeyboardHandler: { updateLayoutForKeyboard: layout },
    KeyboardAccessoryBar: bar,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    performance: { now: () => performance.now() },
    console,
  });
  const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/input-cjk.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'input-cjk.js' });
  const CjkInput = vm.runInContext('CjkInput', context);
  CjkInput.init({
    send: (t: string) => sent.push(t),
    sendPrompt: (t: string) => {
      prompts.push(t);
      return promptResult;
    },
  });
  CjkInput.setHoldUntilEnter(hold);
  textarea.fire('focus');
  return { CjkInput, textarea, sent, prompts, layout, bar };
}

function type(textarea: ReturnType<typeof makeTextarea>, text: string) {
  textarea.value = PHANTOM + text;
  textarea.fire('input', { isComposing: false, inputType: 'insertText' });
}

function backspace(textarea: ReturnType<typeof makeTextarea>, valueAfter: string) {
  textarea.value = valueAfter;
  textarea.fire('input', { isComposing: false, inputType: 'deleteContentBackward' });
}

const enter = (textarea: ReturnType<typeof makeTextarea>) =>
  textarea.fire('keydown', { key: 'Enter', keyCode: 13, shiftKey: false });

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

  it('sends a long single line as a prompt, never as one <text>\\r burst', () => {
    // Claude Code takes a burst of ~100+ characters as a paste and its \r as a
    // newline, so the answer would sit unsent (src/web/route-helpers.ts).
    const { textarea, sent, prompts } = load();
    const long = 'x'.repeat(150);
    type(textarea, long);
    enter(textarea);
    expect(sent).toEqual([]);
    expect(prompts).toEqual([long]);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('keeps a line at the direct-write limit as one write, one over it as a prompt', () => {
    const { textarea, sent, prompts } = load();
    type(textarea, 'a'.repeat(64));
    enter(textarea);
    type(textarea, 'b'.repeat(65));
    enter(textarea);
    expect(sent).toEqual(['a'.repeat(64) + '\r']);
    expect(prompts).toEqual(['b'.repeat(65)]);
  });

  it('sends several lines as a prompt (bracketed paste + session-bound Enter)', () => {
    const { textarea, sent, prompts } = load();
    type(textarea, 'line one\nline two');
    enter(textarea);
    vi.advanceTimersByTime(500);
    expect(prompts).toEqual(['line one\nline two']);
    expect(sent).toEqual([]);
  });

  it('keeps the text in the field when the prompt is refused (too long, no session)', () => {
    const { textarea, prompts } = load({ promptResult: false });
    type(textarea, 'line one\nline two');
    enter(textarea);
    expect(prompts).toHaveLength(1);
    expect(textarea.value).toBe(PHANTOM + 'line one\nline two');
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

  it('does not send Backspace when deleting the last held character', () => {
    // The CLI's own composer may hold text (Attach, image paste, Path, mic):
    // a stray DEL would eat its last character.
    const { textarea, sent } = load();
    type(textarea, 'a');
    type(textarea, 'ab');
    backspace(textarea, PHANTOM + 'a');
    backspace(textarea, PHANTOM);
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('sends Backspace once the field is empty and the phantom itself is deleted', () => {
    const { textarea, sent } = load();
    type(textarea, 'a');
    backspace(textarea, PHANTOM);
    backspace(textarea, '');
    expect(sent).toEqual(['\x7f']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('does not send Backspace for select-all + delete of held text', () => {
    const { textarea, sent } = load();
    type(textarea, 'abc');
    backspace(textarea, '');
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('deletes held text right after typing it, before any debounce, without a DEL', () => {
    const { textarea, sent } = load();
    type(textarea, 'a');
    backspace(textarea, PHANTOM);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([]);
  });

  it('puts the phantom back when Backspace at the start of the text deleted it', () => {
    const { textarea, sent } = load();
    type(textarea, 'abc');
    backspace(textarea, 'abc');
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM + 'abc');
  });

  it('one-shot Ctrl: the next typed character goes out instead of being held', () => {
    // _handleCjkInput turns the single character into the control byte.
    const { textarea, sent, bar } = load();
    bar.armed = true;
    type(textarea, 'c');
    expect(sent).toEqual(['c']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('one-shot Ctrl: held text stays and only the new character leaves the field', () => {
    const { textarea, sent, bar } = load();
    type(textarea, 'ab');
    bar.armed = true;
    type(textarea, 'abc');
    expect(sent).toEqual(['c']);
    expect(textarea.value).toBe(PHANTOM + 'ab');
  });

  it('one-shot Ctrl: a character committed by an IME composition also goes out', () => {
    const { textarea, sent, bar } = load();
    bar.armed = true;
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + 'c';
    textarea.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    textarea.fire('compositionend');
    vi.advanceTimersByTime(10);
    expect(sent).toEqual(['c']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('one-shot Ctrl: a multi-character commit stays held and spends the modifier', () => {
    const { textarea, sent, bar } = load();
    bar.armed = true;
    type(textarea, 'hello');
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM + 'hello');
    expect(bar.armed).toBe(false);
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
