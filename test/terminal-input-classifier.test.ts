import { describe, expect, it } from 'vitest';
import { isKeyboardTerminalInput } from '../src/terminal-input-classifier.js';

describe('isKeyboardTerminalInput', () => {
  it.each([
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['SGR press', '\x1b[<0;10;5M'],
    ['SGR release', '\x1b[<0;10;5m'],
    ['SGR wheel', '\x1b[<64;999;1000M'],
    ['X10 mouse', '\x1b[M !!'],
    ['coalesced reports', '\x1b[<0;10;5M\x1b[O\x1b[M !!'],
  ])('classifies %s as report-only', (_name, data) => {
    expect(isKeyboardTerminalInput(data)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['text', 'continue'],
    ['paste', 'git status'],
    ['Enter', '\r'],
    ['Escape', '\x1b'],
    ['arrow', '\x1b[A'],
    ['control key', '\x03'],
    ['truncated SGR', '\x1b[<0;10;5'],
    ['truncated X10', '\x1b[M !'],
    ['X10 with a control button byte', '\x1b[M\r!!'],
    ['X10 with a control coordinate byte', '\x1b[M \x1b!'],
    ['X10-shaped navigation input', '\x1b[M\x1b[A'],
    ['X10 with a zero coordinate', '\x1b[M  !'],
    ['report then text', '\x1b[<0;10;5Mx'],
    ['text then report', 'x\x1b[<0;10;5M'],
    ['report then Enter', '\x1b[O\r'],
  ])('classifies %s as keyboard-bearing', (_name, data) => {
    expect(isKeyboardTerminalInput(data)).toBe(true);
  });
});
