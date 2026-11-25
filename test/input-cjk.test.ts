/**
 * @fileoverview Unit tests for the CJK IME input module (input-cjk.js).
 *
 * Loads the browser module into a vm sandbox (no real DOM) and drives fake
 * composition/keydown/input event sequences against a stub textarea.
 * Focus: the intermittent "Chinese characters silently lost" failure modes —
 * stuck composition state, deferred flush racing the next composition, and
 * physical-key punctuation transformed into full-width IME output.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PHANTOM = '​';

interface FakeTextarea {
  value: string;
  valueWrites: number;
  blur: () => void;
  focus: () => void;
  classList: { contains: (c: string) => boolean };
  setSelectionRange: () => void;
  addEventListener: (ev: string, fn: (e?: unknown) => void) => void;
  removeEventListener: (ev: string, fn: (e?: unknown) => void) => void;
  fire: (ev: string, arg?: Record<string, unknown>) => void;
}

function makeTextarea(): FakeTextarea {
  const listeners = new Map<string, Array<(e?: unknown) => void>>();
  let val = '';
  return {
    get value() {
      return val;
    },
    set value(v: string) {
      this.valueWrites++;
      val = v;
    },
    valueWrites: 0,
    blur: () => {},
    focus: () => {},
    classList: { contains: (c: string) => c === 'cjk-input-visible' },
    setSelectionRange: () => {},
    addEventListener: (ev, fn) => {
      const list = listeners.get(ev) ?? [];
      listeners.set(ev, [...list, fn]);
    },
    removeEventListener: (ev, fn) => {
      const list = listeners.get(ev) ?? [];
      listeners.set(
        ev,
        list.filter((f) => f !== fn)
      );
    },
    fire(ev, arg = {}) {
      const base = { preventDefault: () => {}, stopPropagation: () => {}, ...arg };
      for (const fn of listeners.get(ev) ?? []) fn(base);
    },
  };
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

function loadCjkHarness({ ua = ANDROID_UA, captureTarget }: { ua?: string; captureTarget?: () => string } = {}) {
  const textarea = makeTextarea();
  const sent: string[] = [];
  const targets: Array<string | undefined> = [];
  const windowObj: Record<string, unknown> = {};
  const documentObj = {
    getElementById: (id: string) => (id === 'cjkInput' ? textarea : null),
    activeElement: null as unknown,
  };

  // Delegating closures so vitest fake timers (which patch the test realm's
  // globals) govern the vm context's timers/clock too.
  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    navigator: { userAgent: ua },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    performance: { now: () => performance.now() },
    console,
  });

  const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/input-cjk.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'input-cjk.js' });
  const CjkInput = vm.runInContext('CjkInput', context);

  CjkInput.init({
    captureTarget,
    send: (text: string, target?: string) => {
      sent.push(text);
      targets.push(target);
    },
  });
  textarea.fire('focus');

  return { CjkInput, textarea, sent, targets, windowObj, documentObj };
}

describe('CJK input module', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['input', 'keydown', 'compositionstart'])(
    'captures the destination at the first %s and releases it after flush',
    (start) => {
      let target = 'B';
      const captureTarget = vi.fn(() => target);
      const { CjkInput, textarea, sent, targets } = loadCjkHarness({ captureTarget });
      if (start === 'keydown') textarea.fire('keydown', { key: 'x' });
      if (start === 'compositionstart') textarea.fire('compositionstart');
      textarea.value = PHANTOM + '你好';
      if (start === 'input') textarea.fire('input', { inputType: 'insertText', isComposing: false });
      target = 'A';
      if (start === 'keydown') textarea.fire('input', { inputType: 'insertText', isComposing: false });
      if (start === 'compositionstart') textarea.fire('compositionend');
      vi.runAllTimers();
      CjkInput.flushNow();
      expect(sent).toEqual(['你好']);
      expect(targets).toEqual(['B']);
      expect(captureTarget).toHaveBeenCalledTimes(1);
      textarea.value = PHANTOM + '再见';
      textarea.fire('input', { inputType: 'insertText', isComposing: false });
      vi.runAllTimers();
      expect(targets).toEqual(['B', 'A']);
    }
  );

  it.each(['clear', 'escape'])('drops the held destination on %s', (action) => {
    let target = 'B';
    const { CjkInput, textarea, targets } = loadCjkHarness({ captureTarget: () => target });
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + 'discard';
    if (action === 'clear') CjkInput.clear();
    else textarea.fire('keydown', { key: 'Escape' });
    target = 'A';
    textarea.value = PHANTOM + 'send';
    textarea.fire('input', { inputType: 'insertText', isComposing: false });
    vi.runAllTimers();
    expect(targets).toEqual(['A']);
  });

  it.each([
    { key: 'Enter' },
    { key: 'c', ctrlKey: true },
    { key: 'ArrowUp' },
    { key: 'End', ctrlKey: true },
    { key: 'Backspace' },
  ])('routes direct $key control keys through the held or fresh destination', (key) => {
    let target = 'B';
    const { CjkInput, textarea, targets } = loadCjkHarness({ captureTarget: () => target });
    textarea.fire('compositionstart');
    textarea.fire('compositionend');
    target = 'A';
    textarea.fire('keydown', key);
    expect(targets).toEqual(['B']);
    CjkInput.clear();
    textarea.fire('keydown', key);
    expect(targets).toEqual(['B', 'A']);
  });

  it('routes phantom deletion to a freshly captured destination', () => {
    const { textarea, sent, targets } = loadCjkHarness({ captureTarget: () => 'B' });
    textarea.value = '';
    textarea.fire('input', { inputType: 'deleteContentBackward', isComposing: false });
    expect(sent).toEqual(['\x7f']);
    expect(targets).toEqual(['B']);
  });

  it('flushNow leaves provisional composition untouched until it commits', () => {
    const { CjkInput, textarea, sent } = loadCjkHarness();
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好';
    CjkInput.flushNow();
    vi.runAllTimers();
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM + '你好');
    textarea.fire('compositionend');
    CjkInput.flushNow();
    expect(sent).toEqual(['你好']);
    vi.runAllTimers();
    expect(sent).toEqual(['你好']);
  });

  it('sends committed text after a normal composition cycle', () => {
    const { textarea, sent } = loadCjkHarness();

    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好';
    textarea.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    textarea.fire('compositionend');
    vi.advanceTimersByTime(10);

    expect(sent).toEqual(['你好']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('lets the IME transform printable keys before sending full-width punctuation', () => {
    const { textarea, sent } = loadCjkHarness();
    const committed = Array.from('，。！？；：“”、《》、（）');
    const physicalKeys = [',', '.', '!', '?', ';', ':', '"', '"', '\\', '<', '>', '\\', '(', ')'];

    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '中文';
    textarea.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    textarea.fire('compositionend');
    vi.advanceTimersByTime(10);
    vi.advanceTimersByTime(1000);

    for (const [index, punctuation] of committed.entries()) {
      const preventDefault = vi.fn();
      textarea.fire('keydown', {
        key: physicalKeys[index],
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault,
      });
      expect(preventDefault).not.toHaveBeenCalled();

      textarea.value = PHANTOM + punctuation;
      textarea.fire('input', { isComposing: false, inputType: 'insertText' });
    }

    expect(sent).toEqual(['中文', ...committed]);
  });

  it('forwards Ctrl/Alt-modified navigation keys to the PTY, modifier intact', () => {
    // claude prints "Jump to bottom (ctrl+End)" and the shortcut has to REACH it.
    // PASSTHROUGH_KEYS carries only the plain forms, so Ctrl+End used to fail in
    // both directions: with an empty field it went out as a bare `\x1b[F` (a
    // plain End), and with any text in the field it was not forwarded at all —
    // the browser default then moved the caret to the end of the composer, which
    // is what the user sees as "the shortcut acts on the input box instead".
    const { textarea, sent } = loadCjkHarness();
    const preventDefault = vi.fn();
    textarea.fire('keydown', {
      key: 'End',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(sent).toEqual(['\x1b[1;5F']);
  });

  it('forwards a modified navigation key even when the composer has text', () => {
    // The empty-field rule belongs to PLAIN navigation (which really is local
    // editing); a Ctrl-modified one is a command for the CLI either way.
    const { textarea, sent } = loadCjkHarness();
    textarea.value = PHANTOM + '未发送的草稿';
    textarea.fire('keydown', {
      key: 'Home',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    });
    expect(sent).toEqual(['\x1b[1;5H']);
  });

  it('encodes the modifier bitmask, Shift included when it rides along', () => {
    const { textarea, sent } = loadCjkHarness();
    textarea.fire('keydown', {
      key: 'ArrowUp',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    });
    expect(sent).toEqual(['\x1b[1;6A']); // 1 + shift(1) + ctrl(4)
  });

  it('leaves Shift-ALONE navigation local, so selecting in the composer still works', () => {
    const { textarea, sent } = loadCjkHarness();
    textarea.value = PHANTOM + '草稿';
    const preventDefault = vi.fn();
    textarea.fire('keydown', {
      key: 'ArrowLeft',
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault,
    });
    expect(sent).toEqual([]);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('recovers committed text when compositionend never fires (stuck composition)', () => {
    const { textarea, sent } = loadCjkHarness();

    // IME fires compositionstart but never compositionend (WeChat/Sogou quirk).
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好';
    // The commit arrives as a plain input event outside composition.
    textarea.fire('input', { isComposing: false, inputType: 'insertText' });
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(200);

    expect(sent).toEqual(['你好']);
  });

  it('does not flush or reset the textarea while the next composition is active', () => {
    const { textarea, sent } = loadCjkHarness();

    // Word 1 commits; the deferred flush is queued but has not run yet.
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好';
    textarea.fire('compositionend');
    // Word 2 composition begins immediately (fast continuous typing).
    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '你好世界';

    // Deferred flush from word 1 fires now — it must NOT touch the textarea
    // (a programmatic reset here cancels the live IME composition on iOS).
    vi.advanceTimersByTime(10);
    expect(sent).toEqual([]);
    expect(textarea.value).toBe(PHANTOM + '你好世界');

    textarea.fire('compositionend');
    vi.advanceTimersByTime(10);
    expect(sent).toEqual(['你好世界']);
  });

  it('sends the transformed IME commit that follows a printable keydown', () => {
    const { textarea, sent } = loadCjkHarness();

    vi.advanceTimersByTime(1000);
    // The physical key is not committed text and must not be sent by itself.
    textarea.fire('keydown', { key: 'a', ctrlKey: false, altKey: false, metaKey: false });
    expect(sent).toEqual([]);

    // The browser/IME supplies the canonical text in the following input.
    vi.advanceTimersByTime(50);
    textarea.value = PHANTOM + '你好';
    textarea.fire('input', { isComposing: false, inputType: 'insertText' });

    expect(sent).toEqual(['你好']);
  });

  it('sends a printable physical key exactly once after its input event', () => {
    const { textarea, sent } = loadCjkHarness();

    textarea.fire('keydown', { key: 'a', ctrlKey: false, altKey: false, metaKey: false });
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(10);
    textarea.value = PHANTOM + 'a';
    textarea.fire('input', { isComposing: false, inputType: 'insertText' });
    vi.advanceTimersByTime(300);

    expect(sent).toEqual(['a']);
    expect(textarea.value).toBe(PHANTOM);
  });

  it('re-tapping the focused empty field restarts the IME session (wedged-IME recovery)', () => {
    const { textarea, documentObj } = loadCjkHarness();
    documentObj.activeElement = textarea;
    let blurred = 0;
    let focused = 0;
    textarea.blur = () => {
      blurred++;
    };
    textarea.focus = () => {
      focused++;
    };

    textarea.fire('pointerdown');
    expect(blurred).toBe(1);
    vi.advanceTimersByTime(10);
    expect(focused).toBe(1);

    // First tap on an unfocused field must NOT cycle (normal focus flow).
    documentObj.activeElement = null;
    textarea.fire('pointerdown');
    expect(blurred).toBe(1);
  });

  it('does not run the wedged-IME pointerdown recovery on iOS (Android-only)', () => {
    // On iOS, tapping the focused empty field is normal (paste callout,
    // habitual tap), and the async refocus runs outside the user-gesture
    // stack — the blur→focus cycle must never fire there.
    const { textarea, documentObj } = loadCjkHarness({ ua: IOS_UA });
    documentObj.activeElement = textarea;
    let blurred = 0;
    let focused = 0;
    textarea.blur = () => {
      blurred++;
    };
    textarea.focus = () => {
      focused++;
    };

    textarea.fire('pointerdown');
    vi.advanceTimersByTime(10);
    expect(blurred).toBe(0);
    expect(focused).toBe(0);
  });

  it('never records typed content in the diagnostic trace (privacy)', () => {
    // The trace mirrors into crash-diag, which persists to localStorage and
    // beacons to the server — it must stay content-free: lengths, key
    // classes, and event names only. Drive every path that formerly embedded
    // the value or key literal (composition, keydown send, input, blur).
    const { CjkInput, textarea, sent } = loadCjkHarness();

    textarea.fire('compositionstart');
    textarea.value = PHANTOM + '秘密口令';
    textarea.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    textarea.fire('compositionend');
    vi.advanceTimersByTime(10);

    textarea.fire('keydown', { key: '囍', ctrlKey: false, altKey: false, metaKey: false });
    textarea.value = PHANTOM + '囍';
    textarea.fire('input', { isComposing: false, inputType: 'insertText' });
    textarea.value = PHANTOM + '秘密';
    textarea.fire('blur');
    expect(sent).toEqual(['秘密口令', '囍']);

    const trace = CjkInput.getTrace().join('\n');
    for (const ch of '秘密口令囍') expect(trace).not.toContain(ch);
    // Lengths and key classes are still traced for diagnostics.
    expect(trace).toContain('flush send len=4');
    expect(trace).toContain('keydown printable');
  });

  it('skips redundant textarea writes when already reset (Android IME desync guard)', () => {
    const { CjkInput, textarea } = loadCjkHarness();
    const before = textarea.valueWrites;

    // Value is already the phantom — external clears (session switch / SSE
    // reconnect) must not rewrite it, or they race the IME session setup.
    CjkInput.clear();
    CjkInput.clear();

    expect(textarea.valueWrites).toBe(before);
  });

  it('routes terminal.focus() to the CJK field while it is visible (focus router)', () => {
    // Regression guard for the intermittent "Chinese input goes nowhere" bug:
    // session-select / SSE-reconnect paths call terminal.focus(), which lands
    // on xterm's hidden textarea; with the CJK gate active, everything typed
    // there is swallowed. terminal-ui must (a) route focus() to the CJK field
    // when visible and (b) self-heal inside the onData gate.
    const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

    expect(src).toContain('Focus router');
    expect(src).toMatch(/this\.terminal\.focus = \(\) => \{/);
    expect(src).toContain("cjkEl?.classList.contains('cjk-input-visible')");
    expect(src).toContain('CJK regain-focus (onData swallowed input)');

    // The self-heal must only fire for GENUINE typed input: onData also fires
    // for xterm's self-generated query replies (DA/DSR/CPR/OSC during Ink
    // redraws), which arrive while e.g. the rename input or search box has
    // focus — refocusing on those steals focus mid-typing. Guard: focus must
    // be on xterm's own textarea AND the data must not be a query reply.
    const selfHeal = src.slice(src.indexOf('Self-heal'), src.indexOf('CJK regain-focus'));
    expect(selfHeal).toContain('document.activeElement === this.terminal.textarea');
    expect(selfHeal).toContain('shouldSuppressTerminalQueryResponse(data)');
  });

  it('sends text plus carriage return on Enter', () => {
    const { textarea, sent } = loadCjkHarness();

    textarea.value = PHANTOM + '你好';
    textarea.fire('keydown', { key: 'Enter' });

    expect(sent).toEqual(['你好\r']);
    expect(textarea.value).toBe(PHANTOM);
  });
});
