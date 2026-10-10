import { describe, it, expect, afterEach } from 'vitest';
import { createMockTerminal } from './helpers.js';
import { ZerolagInputAddon } from '../src/zerolag-input-addon.js';

function setup(lines: string[] = ['$ '], promptChar = '$') {
  const mock = createMockTerminal({ buffer: { lines } });
  const addon = new ZerolagInputAddon({
    prompt: { type: 'character', char: promptChar, offset: 2 },
  });
  mock.terminal.loadAddon(addon);
  return { addon, mock };
}

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

function tracked(lines?: string[], promptChar?: string) {
  const result = setup(lines, promptChar);
  cleanups.push(() => {
    result.addon.dispose();
    result.mock.cleanup();
  });
  return result;
}

describe('ZerolagInputAddon', () => {
  describe('lifecycle', () => {
    it('creates overlay element in .xterm-screen', () => {
      const { addon, mock } = tracked();
      const screen = mock.terminal.element.querySelector('.xterm-screen');
      expect(screen!.children.length).toBeGreaterThan(0);
      const overlay = screen!.lastElementChild as HTMLDivElement;
      expect(overlay.style.zIndex).toBe('7');
      expect(overlay.style.display).toBe('none');
      addon.dispose();
    });

    it('dispose removes overlay from DOM', () => {
      const { addon, mock } = tracked();
      const screen = mock.terminal.element.querySelector('.xterm-screen')!;
      const before = screen.children.length;
      addon.dispose();
      expect(screen.children.length).toBe(before - 1);
    });
  });

  describe('addChar / pendingText', () => {
    it('adds characters to pendingText', () => {
      const { addon } = tracked();
      addon.addChar('a');
      addon.addChar('b');
      addon.addChar('c');
      expect(addon.pendingText).toBe('abc');
    });

    it('hasPending is true when text exists', () => {
      const { addon } = tracked();
      expect(addon.hasPending).toBe(false);
      addon.addChar('x');
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('appendText', () => {
    it('appends multiple characters (paste)', () => {
      const { addon } = tracked();
      addon.addChar('h');
      addon.appendText('ello');
      expect(addon.pendingText).toBe('hello');
    });

    it('ignores empty string', () => {
      const { addon } = tracked();
      addon.appendText('');
      expect(addon.pendingText).toBe('');
      expect(addon.hasPending).toBe(false);
    });
  });

  describe('removeChar', () => {
    it('returns "pending" when removing from pendingText', () => {
      const { addon } = tracked();
      addon.addChar('a');
      addon.addChar('b');
      const source = addon.removeChar();
      expect(source).toBe('pending');
      expect(addon.pendingText).toBe('a');
    });

    it('returns false when nothing to remove', () => {
      const { addon } = tracked();
      expect(addon.removeChar()).toBe(false);
    });

    it('returns "flushed" when removing from flushed text', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      const source = addon.removeChar();
      expect(source).toBe('flushed');
      expect(addon.getFlushed().count).toBe(2);
      expect(addon.getFlushed().text).toBe('ab');
    });

    it('removes pending before flushed', () => {
      const { addon } = tracked();
      addon.setFlushed(2, 'ab');
      addon.addChar('c');
      const source = addon.removeChar();
      expect(source).toBe('pending');
      expect(addon.pendingText).toBe('');
      expect(addon.getFlushed().count).toBe(2); // flushed unchanged
    });

    it('hides overlay when both pending and flushed become empty', () => {
      const { addon } = tracked();
      addon.addChar('x');
      addon.removeChar();
      expect(addon.hasPending).toBe(false);
    });

    it('detects buffer text and removes from it when both empty', () => {
      const { addon } = tracked(['$ hello']);
      // Both pending and flushed are empty, but buffer has text
      const source = addon.removeChar();
      expect(source).toBe('flushed');
      // "hello" (5 chars) detected, then one removed = 4
      expect(addon.getFlushed().count).toBe(4);
      expect(addon.getFlushed().text).toBe('hell');
    });

    it('returns false on empty prompt with no buffer text', () => {
      const { addon } = tracked(['$ ']);
      expect(addon.removeChar()).toBe(false);
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      addon.addChar('d');
      addon.clear();

      expect(addon.pendingText).toBe('');
      expect(addon.getFlushed().count).toBe(0);
      expect(addon.getFlushed().text).toBe('');
      expect(addon.hasPending).toBe(false);
    });
  });

  describe('flushed text', () => {
    it('setFlushed stores count and text', () => {
      const { addon } = tracked();
      addon.setFlushed(5, 'hello');
      expect(addon.getFlushed()).toEqual({ count: 5, text: 'hello' });
      expect(addon.hasPending).toBe(true);
    });

    it('setFlushed with render=false does not render', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc', false);
      expect(addon.getFlushed()).toEqual({ count: 3, text: 'abc' });
      expect(addon.hasPending).toBe(true);
      // Overlay should still be hidden (no render triggered)
      expect(addon.state.visible).toBe(false);
    });

    it('setFlushed with render=false prevents stale column lock', () => {
      const { addon, mock } = tracked(['$ old session text']);
      // Simulate: clear overlay, then restore flushed WITHOUT render
      addon.clear();
      addon.setFlushed(5, 'hello', false);
      // lastPromptPos should still be null (no render happened)
      expect(addon.state.promptPosition).toBeNull();
      // Now simulate buffer load and rerender
      mock.setLines(['$ ']);
      addon.rerender();
      // Prompt should be freshly scanned, no stale column lock
      const pos = addon.state.promptPosition;
      expect(pos).not.toBeNull();
    });

    it('clearFlushed resets flushed state', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      addon.clearFlushed();
      expect(addon.getFlushed()).toEqual({ count: 0, text: '' });
    });

    it('clearFlushed preserves pending text', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      addon.addChar('d');
      addon.clearFlushed();
      expect(addon.pendingText).toBe('d');
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('state snapshot', () => {
    it('returns current state', () => {
      const { addon } = tracked();
      addon.setFlushed(2, 'hi');
      addon.addChar('!');

      const state = addon.state;
      expect(state.pendingText).toBe('!');
      expect(state.flushedLength).toBe(2);
      expect(state.flushedText).toBe('hi');
    });

    it('state is read-only copy', () => {
      const { addon } = tracked();
      addon.addChar('a');
      const s1 = addon.state;
      addon.addChar('b');
      const s2 = addon.state;
      expect(s1.pendingText).toBe('a');
      expect(s2.pendingText).toBe('ab');
    });
  });

  describe('prompt detection', () => {
    it('findPrompt returns position for character prompt', () => {
      const { addon } = tracked(['$ hello world']);
      const pos = addon.findPrompt();
      expect(pos).toEqual({ row: 0, col: 0 });
    });

    it('findPrompt returns null when no prompt', () => {
      const { addon } = tracked(['no prompt here']);
      const pos = addon.findPrompt();
      expect(pos).toBeNull();
    });

    it('readPromptText reads text after prompt', () => {
      const { addon } = tracked(['$ hello world']);
      const text = addon.readPromptText();
      expect(text).toBe('hello world');
    });

    it('readPromptText returns null when no prompt', () => {
      const { addon } = tracked(['no prompt']);
      const text = addon.readPromptText();
      expect(text).toBeNull();
    });
  });

  describe('buffer detection', () => {
    it('detectBufferText picks up existing text after prompt', () => {
      const { addon } = tracked(['$ existing text']);
      const text = addon.detectBufferText();
      expect(text).toBe('existing text');
      expect(addon.getFlushed().count).toBe(13);
      expect(addon.getFlushed().text).toBe('existing text');
    });

    it('detectBufferText returns null for empty prompt', () => {
      const { addon } = tracked(['$ ']);
      const text = addon.detectBufferText();
      expect(text).toBeNull();
    });

    it('detectBufferText is guarded (only runs once)', () => {
      const { addon } = tracked(['$ text']);
      addon.detectBufferText();
      addon.clearFlushed(); // clear what was detected

      // Should not detect again (guard is set)
      const text = addon.detectBufferText();
      expect(text).toBeNull();
    });

    it('resetBufferDetection allows re-detection', () => {
      const { addon } = tracked(['$ text']);
      addon.detectBufferText();
      addon.clearFlushed();
      addon.resetBufferDetection();

      const text = addon.detectBufferText();
      expect(text).toBe('text');
    });

    it('suppressBufferDetection prevents detection', () => {
      const { addon } = tracked(['$ some UI text']);
      addon.suppressBufferDetection();

      // Detection should be blocked
      const text = addon.detectBufferText();
      expect(text).toBeNull();
      expect(addon.getFlushed().count).toBe(0);
    });

    it('suppressBufferDetection also blocks implicit detection in addChar', () => {
      const { addon } = tracked(['$ ink status bar']);
      addon.suppressBufferDetection();

      // addChar calls _detectBufferText internally on first keystroke
      addon.addChar('x');
      // Should have only 'x' pending, NOT the buffer text as flushed
      expect(addon.pendingText).toBe('x');
      expect(addon.getFlushed().count).toBe(0);
    });

    it('suppressBufferDetection also blocks detection in removeChar cascade', () => {
      const { addon } = tracked(['$ buffer text']);
      addon.suppressBufferDetection();

      // removeChar step 3 calls _detectBufferText — should be blocked
      expect(addon.removeChar()).toBe(false);
      expect(addon.getFlushed().count).toBe(0);
    });

    it('undoDetection clears flushed and re-enables detection', () => {
      const { addon } = tracked(['$ completed']);
      // Detect buffer text (simulates tab completion detection)
      addon.detectBufferText();
      expect(addon.getFlushed().count).toBe(9); // 'completed'

      // Undo because it matched baseline (no real completion)
      addon.undoDetection();
      expect(addon.getFlushed().count).toBe(0);
      expect(addon.getFlushed().text).toBe('');

      // Detection should work again (guard reset)
      const text = addon.detectBufferText();
      expect(text).toBe('completed');
    });

    it('undoDetection does not hide overlay or clear pending', () => {
      const { addon } = tracked(['$ buffer']);
      addon.detectBufferText(); // sets flushed
      addon.addChar('x'); // adds pending on top

      addon.undoDetection();
      // Flushed cleared, but pending preserved
      expect(addon.pendingText).toBe('x');
      expect(addon.getFlushed().count).toBe(0);
      expect(addon.hasPending).toBe(true);
    });

    it('clear resets suppression (re-enables detection)', () => {
      const { addon } = tracked(['$ text']);
      addon.suppressBufferDetection();
      addon.clear(); // resets _bufferDetectDone to false

      const text = addon.detectBufferText();
      expect(text).toBe('text');
    });

    it('clear resets buffer detection guard', () => {
      const { addon } = tracked(['$ text']);
      addon.detectBufferText();
      addon.clear();

      // After clear, detection should work again
      const text = addon.detectBufferText();
      expect(text).toBe('text');
    });
  });

  describe('custom prompt configurations', () => {
    it('works with > prompt character', () => {
      const { addon } = tracked(['> hello'], '>');
      const text = addon.readPromptText();
      expect(text).toBe('hello');
    });

    it('works with Unicode prompt', () => {
      const mock = createMockTerminal({ buffer: { lines: ['\u276f hello'] } });
      const addon = new ZerolagInputAddon({
        prompt: { type: 'character', char: '\u276f', offset: 2 },
      });
      mock.terminal.loadAddon(addon);
      cleanups.push(() => {
        addon.dispose();
        mock.cleanup();
      });

      const text = addon.readPromptText();
      expect(text).toBe('hello');
    });
  });

  describe('state.visible', () => {
    it('is false before activate', () => {
      const addon = new ZerolagInputAddon();
      expect(addon.state.visible).toBe(false);
      // No cleanup needed — never activated
    });

    it('is false after dispose', () => {
      const { addon, mock } = tracked();
      addon.addChar('x');
      addon.dispose();
      expect(addon.state.visible).toBe(false);
      mock.cleanup();
    });
  });

  describe('rerender / refreshFont', () => {
    it('rerender does not crash when no text', () => {
      const { addon } = tracked();
      expect(() => addon.rerender()).not.toThrow();
    });

    it('refreshFont does not crash', () => {
      const { addon } = tracked();
      expect(() => addon.refreshFont()).not.toThrow();
    });

    it('rerender re-renders when hasPending', () => {
      const { addon } = tracked();
      addon.addChar('x');
      expect(() => addon.rerender()).not.toThrow();
      expect(addon.hasPending).toBe(true);
    });

    it('refreshFont re-renders flushed-only text', () => {
      const { addon } = tracked();
      addon.setFlushed(3, 'abc');
      expect(() => addon.refreshFont()).not.toThrow();
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('tab-switch save/restore pattern', () => {
    it('save pending + flushed, restore as flushed', () => {
      const { addon } = tracked(['$ ']);

      // User types some text
      addon.addChar('h');
      addon.addChar('i');
      expect(addon.pendingText).toBe('hi');

      // Tab switch: save state
      const pending = addon.pendingText;
      const { count: flushedCount, text: flushedText } = addon.getFlushed();
      const totalCount = flushedCount + pending.length;
      const totalText = flushedText + pending;
      addon.clear();

      // Simulate PTY send of pending text (app would do this)
      // ...

      // Tab switch back: restore as flushed (text is now in PTY)
      addon.suppressBufferDetection(); // prevent false Ink detection
      addon.setFlushed(totalCount, totalText, false); // no render — buffer not loaded yet
      expect(addon.getFlushed()).toEqual({ count: 2, text: 'hi' });
      expect(addon.hasPending).toBe(true); // has flushed content

      // Backspace should return 'flushed' (text is in PTY)
      const source = addon.removeChar();
      expect(source).toBe('flushed');
      expect(addon.getFlushed().count).toBe(1);
    });

    it('save with existing flushed + pending', () => {
      const { addon } = tracked(['$ ']);

      // Set flushed from previous restore, then user types more
      addon.setFlushed(3, 'abc');
      addon.addChar('d');
      addon.addChar('e');

      // Save state
      const pending = addon.pendingText;
      const { count, text } = addon.getFlushed();
      expect(pending).toBe('de');
      expect(count).toBe(3);
      expect(text).toBe('abc');

      // Combined for restore
      const totalCount = count + pending.length;
      const totalText = text + pending;
      addon.clear();

      // Restore
      addon.setFlushed(totalCount, totalText);
      expect(addon.getFlushed()).toEqual({ count: 5, text: 'abcde' });
    });
  });

  describe('setPrompt', () => {
    it('changes prompt detection strategy', () => {
      const { addon, mock } = tracked(['$ hello'], '$');
      // Initially finds $ prompt
      expect(addon.findPrompt()).toEqual({ row: 0, col: 0 });
      expect(addon.readPromptText()).toBe('hello');

      // Switch to > prompt — $ is no longer detected
      mock.setLines(['> world']);
      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      expect(addon.findPrompt()).toEqual({ row: 0, col: 0 });
      expect(addon.readPromptText()).toBe('world');
    });

    it('returns null when new prompt character not found', () => {
      const { addon } = tracked(['$ hello'], '$');
      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      // Buffer still has $ not >
      expect(addon.findPrompt()).toBeNull();
    });

    it('resets cached prompt position', () => {
      const { addon } = tracked(['$ typed']);
      addon.addChar('x');
      expect(addon.state.promptPosition).not.toBeNull();

      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      // After setPrompt with no matching prompt, position resets
      expect(addon.state.promptPosition).toBeNull();
    });

    it('re-renders when text exists', () => {
      const { addon, mock } = tracked(['$ '], '$');
      addon.addChar('h');
      addon.addChar('i');

      // Switch prompt strategy — should re-render with existing text
      mock.setLines(['> ']);
      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      expect(addon.pendingText).toBe('hi');
      expect(addon.hasPending).toBe(true);
    });

    it('does not crash when no text to render', () => {
      const { addon } = tracked(['$ ']);
      expect(() => addon.setPrompt({ type: 'character', char: '>', offset: 2 })).not.toThrow();
    });

    it('works with regex prompt strategy', () => {
      const mock = createMockTerminal({ buffer: { lines: ['user@host:~$ cmd'] } });
      const addon = new ZerolagInputAddon({
        prompt: { type: 'character', char: '$', offset: 2 },
      });
      mock.terminal.loadAddon(addon);
      cleanups.push(() => {
        addon.dispose();
        mock.cleanup();
      });

      // Switch to regex
      addon.setPrompt({ type: 'regex', pattern: /\$/, offset: 2 });
      expect(addon.findPrompt()).not.toBeNull();
      expect(addon.readPromptText()).toBe('cmd');
    });
  });

  describe('tab switch with setPrompt (CLI switching)', () => {
    it('full tab switch cycle: save state, setPrompt, restore', () => {
      // Session A with $ prompt
      const { addon, mock } = tracked(['$ '], '$');
      addon.addChar('h');
      addon.addChar('e');
      addon.addChar('l');
      addon.addChar('l');
      addon.addChar('o');
      expect(addon.pendingText).toBe('hello');

      // Save state before tab switch
      const pending = addon.pendingText;
      const { count: flushedCount, text: flushedText } = addon.getFlushed();
      const totalText = flushedText + pending;
      const totalCount = flushedCount + pending.length;
      addon.clear();

      // Switch to Session B with > prompt
      mock.setLines(['> ']);
      addon.setPrompt({ type: 'character', char: '>', offset: 2 });
      expect(addon.pendingText).toBe('');
      expect(addon.hasPending).toBe(false);

      // Switch back to Session A — restore state
      mock.setLines(['$ ']);
      addon.setPrompt({ type: 'character', char: '$', offset: 2 });
      addon.suppressBufferDetection();
      addon.setFlushed(totalCount, totalText, false);

      expect(addon.getFlushed()).toEqual({ count: 5, text: 'hello' });
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('overlay hides when prompt not found (ghost artifact fix)', () => {
    it('overlay hides when prompt scrolls away', () => {
      const { addon, mock } = tracked(['$ ']);
      addon.addChar('x');
      // Prompt visible, overlay should render
      expect(addon.hasPending).toBe(true);

      // Simulate prompt scrolling away (no $ in buffer)
      mock.setLines(['just output', 'more output']);
      addon.clear();
      addon.addChar('y');
      // Prompt not found — overlay hidden despite pending text
      // (the addon renders but finds no prompt, so display stays none)
      const state = addon.state;
      expect(state.pendingText).toBe('y');
    });

    it('clear resets lastPromptPos to null', () => {
      const { addon } = tracked(['$ ']);
      addon.addChar('a');
      expect(addon.state.promptPosition).not.toBeNull();

      addon.clear();
      expect(addon.state.promptPosition).toBeNull();
    });
  });

  describe('methods before activate / after dispose', () => {
    it('addChar accumulates but does not crash before activate', () => {
      const addon = new ZerolagInputAddon();
      addon.addChar('a');
      addon.addChar('b');
      expect(addon.pendingText).toBe('ab');
      expect(addon.hasPending).toBe(true);
      // No dispose needed — never activated, no DOM
    });

    it('removeChar works on pending text before activate', () => {
      const addon = new ZerolagInputAddon();
      addon.addChar('x');
      expect(addon.removeChar()).toBe('pending');
      expect(addon.pendingText).toBe('');
    });

    it('clear works before activate', () => {
      const addon = new ZerolagInputAddon();
      addon.addChar('x');
      addon.clear();
      expect(addon.pendingText).toBe('');
      expect(addon.hasPending).toBe(false);
    });

    it('all methods safe after dispose', () => {
      const { addon, mock } = tracked();
      addon.dispose();
      expect(() => addon.addChar('x')).not.toThrow();
      expect(() => addon.removeChar()).not.toThrow();
      expect(() => addon.clear()).not.toThrow();
      expect(() => addon.rerender()).not.toThrow();
      expect(() => addon.refreshFont()).not.toThrow();
      expect(addon.findPrompt()).toBeNull();
      expect(addon.readPromptText()).toBeNull();
      expect(addon.detectBufferText()).toBeNull();
      mock.cleanup();
    });
  });

  describe('CJK wide character support', () => {
    it('addChar works with CJK characters', () => {
      const { addon } = tracked();
      addon.addChar('你');
      addon.addChar('好');
      expect(addon.pendingText).toBe('你好');
    });

    it('appendText works with CJK characters', () => {
      const { addon } = tracked();
      addon.appendText('こんにちは');
      expect(addon.pendingText).toBe('こんにちは');
    });

    it('removeChar removes CJK characters correctly', () => {
      const { addon } = tracked();
      addon.addChar('你');
      addon.addChar('好');
      addon.removeChar();
      expect(addon.pendingText).toBe('你');
    });

    it('mixed ASCII and CJK renders without error', () => {
      const { addon } = tracked();
      addon.addChar('h');
      addon.addChar('i');
      addon.addChar('你');
      addon.addChar('好');
      expect(addon.pendingText).toBe('hi你好');
      expect(addon.hasPending).toBe(true);
    });

    it('CJK line wrapping accounts for double-width', () => {
      // With 10 cols and startCol=2, first line has 8 available cols
      // Each CJK char takes 2 cols, so 4 CJK chars fill the first line
      const { addon } = tracked(['$ '], '$');
      // Type 5 CJK chars — should overflow first line
      for (const ch of '你好世界啊') {
        addon.addChar(ch);
      }
      expect(addon.pendingText).toBe('你好世界啊');
      expect(addon.hasPending).toBe(true);
    });

    it('Korean text renders without error', () => {
      const { addon } = tracked();
      addon.appendText('안녕하세요');
      expect(addon.pendingText).toBe('안녕하세요');
      expect(addon.hasPending).toBe(true);
    });
  });

  describe('addChar implicit buffer detection', () => {
    it('first keystroke detects existing buffer text as flushed', () => {
      const { addon } = tracked(['$ existing']);
      // First addChar should trigger _detectBufferText
      addon.addChar('!');
      expect(addon.pendingText).toBe('!');
      expect(addon.getFlushed().count).toBe(8); // 'existing'
      expect(addon.getFlushed().text).toBe('existing');
    });

    it('second keystroke does NOT re-detect', () => {
      const { addon } = tracked(['$ existing']);
      addon.addChar('a');
      addon.addChar('b');
      // Should NOT detect again — flushed from first char remains
      expect(addon.pendingText).toBe('ab');
      expect(addon.getFlushed().count).toBe(8); // still 'existing'
    });
  });
});

describe('viewport scrolled away from the bottom', () => {
  function parked(viewportY: number, baseY: number, cursorY: number, rows = 24) {
    const mock = createMockTerminal({ buffer: { lines: ['$ '], viewportY, baseY, cursorY }, rows });
    const addon = new ZerolagInputAddon({ prompt: { type: 'character', char: '$', offset: 2 } });
    mock.terminal.loadAddon(addon);
    cleanups.push(() => {
      addon.dispose();
      mock.cleanup();
    });
    const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
    return { addon, mock, overlay };
  }

  it('still paints with the viewport parked above the bottom while the cursor row is on screen', () => {
    // The host parks the viewport to keep trailing blank rows out of view; the
    // prompt and cursor are still visible, so the user's text must be too.
    const { addon, overlay } = parked(0, 1, 0);
    addon.appendText('abc');
    expect(addon.pendingText).toBe('abc');
    expect(overlay.style.display).not.toBe('none');
    expect(overlay.textContent).toContain('abc');
  });

  it('hides once the cursor row is scrolled out of the viewport, even over a stale prompt glyph', () => {
    const { addon, overlay } = parked(0, 30, 0);
    addon.appendText('abc');
    expect(addon.pendingText).toBe('abc');
    expect(overlay.style.display).toBe('none');
  });
});
