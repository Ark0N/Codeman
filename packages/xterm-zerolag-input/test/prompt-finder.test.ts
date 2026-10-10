import { describe, it, expect } from 'vitest';
import { createMockTerminal } from './helpers.js';
import { promptRowInViewport, findPrompt, readTextAfterPrompt } from '../src/prompt-finder.js';
import type { XtermTerminal, PromptFinder } from '../src/types.js';

function term(lines: string[]) {
  return createMockTerminal({ buffer: { lines } });
}

describe('findPrompt', () => {
  describe('character strategy', () => {
    it('finds $ prompt at column 0', () => {
      const { terminal, cleanup } = term(['output line', '$ ls -la']);
      const finder: PromptFinder = { type: 'character', char: '$' };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toEqual({ row: 1, col: 0 });
      cleanup();
    });

    it('finds > prompt', () => {
      const { terminal, cleanup } = term(['> hello']);
      const finder: PromptFinder = { type: 'character', char: '>' };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toEqual({ row: 0, col: 0 });
      cleanup();
    });

    it('finds prompt with prefix (user@host)', () => {
      const { terminal, cleanup } = term(['user@host:~$ command']);
      const finder: PromptFinder = { type: 'character', char: '$' };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toEqual({ row: 0, col: 11 });
      cleanup();
    });

    it('scans bottom-up and returns lowest match', () => {
      const { terminal, cleanup } = term(['$ old prompt', 'output', '$ current prompt']);
      const finder: PromptFinder = { type: 'character', char: '$' };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toEqual({ row: 2, col: 0 });
      cleanup();
    });

    it('returns null when no prompt found', () => {
      const { terminal, cleanup } = term(['no prompt here', 'or here']);
      const finder: PromptFinder = { type: 'character', char: '$' };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toBeNull();
      cleanup();
    });

    it('finds Unicode prompt character', () => {
      const { terminal, cleanup } = term(['\u276f hello']);
      const finder: PromptFinder = { type: 'character', char: '\u276f' };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toEqual({ row: 0, col: 0 });
      cleanup();
    });
  });

  describe('regex strategy', () => {
    it('finds regex prompt', () => {
      const { terminal, cleanup } = term(['user@host:~/dir$ ls']);
      const finder: PromptFinder = { type: 'regex', pattern: /\$/ };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).not.toBeNull();
      expect(pos!.col).toBe(15);
      cleanup();
    });

    it('matches complex PS1 patterns', () => {
      const { terminal, cleanup } = term(['(venv) user % cmd']);
      const finder: PromptFinder = { type: 'regex', pattern: /%/ };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).not.toBeNull();
      expect(pos!.col).toBe(12);
      cleanup();
    });

    it('returns null on no match', () => {
      const { terminal, cleanup } = term(['just output']);
      const finder: PromptFinder = { type: 'regex', pattern: /\$\s*$/ };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toBeNull();
      cleanup();
    });

    it('handles global flag safely (strips g to avoid lastIndex)', () => {
      const { terminal, cleanup } = term(['user@host:~$ cmd']);
      const finder: PromptFinder = { type: 'regex', pattern: /\$/g };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).not.toBeNull();
      expect(pos!.col).toBe(11);
      // Call again — should return same result (no lastIndex drift)
      const pos2 = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos2).toEqual(pos);
      cleanup();
    });
  });

  describe('custom strategy', () => {
    it('uses custom finder function', () => {
      const { terminal, cleanup } = term(['anything']);
      const finder: PromptFinder = {
        type: 'custom',
        find: () => ({ row: 5, col: 10 }),
      };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toEqual({ row: 5, col: 10 });
      cleanup();
    });

    it('handles null from custom finder', () => {
      const { terminal, cleanup } = term(['anything']);
      const finder: PromptFinder = {
        type: 'custom',
        find: () => null,
      };
      const pos = findPrompt(terminal as unknown as XtermTerminal, finder);
      expect(pos).toBeNull();
      cleanup();
    });
  });
});

describe('readTextAfterPrompt', () => {
  it('reads text after prompt with offset', () => {
    const { terminal, cleanup } = term(['$ hello world']);
    const prompt = { row: 0, col: 0 };
    const text = readTextAfterPrompt(terminal as unknown as XtermTerminal, prompt, 2);
    expect(text).toBe('hello world');
    cleanup();
  });

  it('returns empty string for empty prompt line', () => {
    const { terminal, cleanup } = term(['$ ']);
    const prompt = { row: 0, col: 0 };
    const text = readTextAfterPrompt(terminal as unknown as XtermTerminal, prompt, 2);
    expect(text).toBe('');
    cleanup();
  });

  it('trims trailing whitespace', () => {
    const { terminal, cleanup } = term(['$ hello   ']);
    const prompt = { row: 0, col: 0 };
    const text = readTextAfterPrompt(terminal as unknown as XtermTerminal, prompt, 2);
    expect(text).toBe('hello');
    cleanup();
  });

  it('handles offset for complex prompts', () => {
    const { terminal, cleanup } = term(['user@host:~$ ls -la']);
    const prompt = { row: 0, col: 11 };
    const text = readTextAfterPrompt(terminal as unknown as XtermTerminal, prompt, 2);
    expect(text).toBe('ls -la');
    cleanup();
  });
});

describe('promptRowInViewport', () => {
  const term = (viewportY: number, baseY: number, cursorY: number | undefined, rows = 24) =>
    ({ rows, buffer: { active: { viewportY, baseY, cursorY, getLine: () => undefined } } }) as never;

  it('is true at the bottom regardless of the cursor', () => {
    expect(promptRowInViewport(term(10, 10, undefined))).toBe(true);
  });

  it('is true for a viewport parked above the bottom while the cursor row is on screen', () => {
    // scrollToLastNonEmptyLine() parks rows - 2 above the last non-empty row
    expect(promptRowInViewport(term(0, 16, 5))).toBe(true);
    // cursor exactly on the last visible row
    expect(promptRowInViewport(term(0, 23, 0))).toBe(true);
  });

  it('is false once the cursor row is scrolled out of the viewport', () => {
    expect(promptRowInViewport(term(0, 24, 0))).toBe(false); // one past the last row
    expect(promptRowInViewport(term(0, 200, 3))).toBe(false); // deep in history
  });

  it('keeps the bottom-only rule when the buffer has no cursorY', () => {
    expect(promptRowInViewport(term(0, 1, undefined))).toBe(false);
  });
});
