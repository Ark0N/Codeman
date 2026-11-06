// Port: none (a pure function in a vm context — no browser, no server).
//
// `terminalLogicalLine` (constants.js) reconstructs the logical line a terminal row
// belongs to. Two consumers depend on it and must not disagree: the link provider
// matches its patterns over this text, and touch selection measures words and whole
// lines with it.
//
// The bug it exists to fix, reported from a phone: an agent printing a numbered list
//
//     1. https://github.com/users/someone/packages/container/p
//        ackage/thing
//
// opened only `…/container/p`. Ink wraps its own output and emits a real newline, so
// nothing is flagged `isWrapped`, and the continuation carries the list's indent —
// joining the rows verbatim put whitespace in the middle of the URL, where the
// pattern stops. "Line" was broken by the same shape: it walked `isWrapped` only, so
// it grabbed the single row on screen.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');

type Row = { text: string; wrapped?: boolean };
type Logical = {
  startRow: number;
  endRow: number;
  text: string;
  offsetToCell: (offset: number) => { row: number; col: number };
  cellToOffset: (row: number, col: number) => number;
} | null;

const COLS = 60;

function load(): (buffer: unknown, row: number, cols: number, maxRows?: number) => Logical {
  const context = vm.createContext({ console, window: undefined });
  vm.runInContext(`${SOURCE}\nglobalThis.__fn = terminalLogicalLine;`, context, { filename: 'constants.js' });
  return (context as { __fn: never })['__fn'] as never;
}

/** An xterm-shaped buffer: untrimmed rows pad to the full width, as xterm's do. */
function buffer(rows: Row[]) {
  return {
    length: rows.length,
    getLine: (r: number) =>
      r >= 0 && r < rows.length
        ? {
            isWrapped: !!rows[r].wrapped,
            translateToString: (trim?: boolean) => (trim === false ? rows[r].text.padEnd(COLS) : rows[r].text),
          }
        : undefined,
  };
}

const terminalLogicalLine = load();
const URL_RE = /https?:\/\/(?:[^\s"'<>|;&)\]\x00-\x1f]|&(?!&))+/;

describe('terminalLogicalLine', () => {
  // Row 0 runs to the last column — the only trace a hard wrap leaves — and row 1
  // carries the three spaces the list indent put there.
  const HEAD = '1. https://example.com/';
  const ROW0 = HEAD + 'a'.repeat(COLS - HEAD.length);
  const ROW1 = '   ackage/thing';
  const HARD = [{ text: ROW0 }, { text: ROW1 }];

  it('keeps full-width dividers out of link and touch-selection text', () => {
    const rows = buffer([{ text: '─'.repeat(COLS) }, { text: 'https://example.com/docs' }]);
    expect(terminalLogicalLine(rows, 0, COLS)).toMatchObject({ startRow: 0, endRow: 0, text: '─'.repeat(COLS) });
    expect(terminalLogicalLine(rows, 1, COLS)).toMatchObject({ startRow: 1, endRow: 1, text: 'https://example.com/docs' });
  });

  it('stitches a hard wrap and drops the indent the continuation carries', () => {
    const line = terminalLogicalLine(buffer(HARD), 0, COLS)!;

    expect(line.startRow).toBe(0);
    expect(line.endRow).toBe(1);
    expect(line.text).toBe(ROW0 + 'ackage/thing');
    // The whole URL now matches, which is the entire point.
    expect(line.text.match(URL_RE)![0]).toBe('https://example.com/' + 'a'.repeat(COLS - HEAD.length) + 'ackage/thing');
  });

  it('finds the same line from the continuation row', () => {
    // A tap or hover lands on either row; both must resolve the whole thing.
    const line = terminalLogicalLine(buffer(HARD), 1, COLS)!;

    expect([line.startRow, line.endRow]).toEqual([0, 1]);
    expect(line.text).toBe(ROW0 + 'ackage/thing');
  });

  it('maps offsets back to the right cell across the dropped indent', () => {
    const line = terminalLogicalLine(buffer(HARD), 0, COLS)!;
    const at = line.text.indexOf('ackage/thing');

    // 'a' of 'ackage' is the 4th cell of row 1 (0-based col 3), after the indent.
    expect(line.offsetToCell(at)).toEqual({ row: 1, col: 3 });
    // …and the reverse direction agrees.
    expect(line.cellToOffset(1, 3)).toBe(at);
    // Row 0 is unshifted.
    expect(line.offsetToCell(3)).toEqual({ row: 0, col: 3 });
    expect(line.cellToOffset(0, 3)).toBe(3);
  });

  it('keeps a SOFT continuation verbatim, indent and all', () => {
    // The emulator inserts nothing when it wraps, so leading spaces there are real
    // content and dropping them would corrupt the text.
    const soft = [{ text: 'x'.repeat(COLS) }, { text: '   tail', wrapped: true }];
    const line = terminalLogicalLine(buffer(soft), 1, COLS)!;

    expect(line.text).toBe('x'.repeat(COLS) + '   tail');
    expect(line.offsetToCell(COLS)).toEqual({ row: 1, col: 0 });
  });

  it('does not stitch a row that stops short of the last column', () => {
    // A line that genuinely ended is not a wrap, and over-reaching would glue
    // unrelated output into one link.
    const rows = [{ text: 'short line' }, { text: 'next line' }];
    const line = terminalLogicalLine(buffer(rows), 0, COLS)!;

    expect([line.startRow, line.endRow]).toEqual([0, 0]);
    expect(line.text).toBe('short line');
  });

  it('bounds the span so a screenful of full-width output cannot be re-scanned per hover', () => {
    const rows = Array.from({ length: 40 }, () => ({ text: 'y'.repeat(COLS) }));
    const line = terminalLogicalLine(buffer(rows), 30, COLS, 4)!;

    expect(line.endRow - line.startRow).toBeLessThanOrEqual(4);
  });

  it('trims only the final row, so every earlier offset stays aligned to a cell', () => {
    const rows = [{ text: 'z'.repeat(COLS) }, { text: 'tail' }];
    const line = terminalLogicalLine(buffer(rows), 0, COLS)!;

    // Row 0 contributes exactly COLS characters; the last row is trimmed.
    expect(line.text).toBe('z'.repeat(COLS) + 'tail');
    expect(line.offsetToCell(COLS)).toEqual({ row: 1, col: 0 });
  });

  it('answers null for a row that does not exist', () => {
    expect(terminalLogicalLine(buffer([{ text: 'a' }]), 5, COLS)).toBeNull();
  });
});
