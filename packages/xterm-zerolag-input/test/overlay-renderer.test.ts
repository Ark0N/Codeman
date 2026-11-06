import { describe, it, expect } from 'vitest';
import { renderOverlay, charCellWidth, stringCellWidth } from '../src/overlay-renderer.js';
import type { RenderParams, FontStyle } from '../src/types.js';
import { lineSpans } from './helpers.js';

const FONT: FontStyle = {
  fontFamily: 'monospace',
  fontSize: '14px',
  fontWeight: 'normal',
  color: '#eeeeee',
  backgroundColor: '#0d0d0d',
  letterSpacing: '',
};

function makeParams(overrides: Partial<RenderParams> = {}): RenderParams {
  return {
    lines: ['hello'],
    startCol: 2,
    totalCols: 80,
    cellW: 8.4,
    cellH: 17,
    charTop: 2,
    charHeight: 14,
    promptRow: 10,
    font: FONT,
    showCursor: true,
    cursorColor: '#e0e0e0',
    ...overrides,
  };
}

describe('renderOverlay', () => {
  it('positions container at prompt row', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ promptRow: 5 }));
    expect(container.style.top).toBe(5 * 17 + 'px');
    expect(container.style.left).toBe('0px');
  });

  it('creates per-character spans in a line div', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['abc'], cellW: 10 }));

    // Line div + cursor span
    expect(container.children.length).toBe(2);

    const lineDiv = container.children[0] as HTMLDivElement;
    expect(lineDiv.children.length).toBe(3); // a, b, c

    const [a, b, c] = lineSpans(lineDiv);
    expect([a.text, a.left, a.width]).toEqual(['a', 0, 10]);
    expect([b.text, b.left, b.width]).toEqual(['b', 10, 10]);
    expect([c.text, c.left, c.width]).toEqual(['c', 20, 10]);
  });

  it('lays the spans out in a flex row, not absolutely positioned (one paint layer per line)', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['ab'] }));
    const lineDiv = container.children[0] as HTMLDivElement;
    expect(lineDiv.style.position).toBe('absolute');
    expect(lineDiv.style.display).toBe('flex');
    for (const { el } of lineSpans(lineDiv)) {
      expect(el.style.position).toBe('');
      expect(el.style.left).toBe('');
      // flex: none, so a span is never stretched or squeezed off its cells.
      expect(el.style.flexGrow).toBe('0');
      expect(el.style.flexShrink).toBe('0');
    }
  });

  it('snaps cell edges to a quarter pixel so a fractional cell width never drifts', () => {
    const container = document.createElement('div');
    const cellW = 8.4;
    renderOverlay(container, makeParams({ lines: ['x'.repeat(78) + '你'], startCol: 0, totalCols: 80, cellW }));
    const spans = lineSpans(container.children[0]);
    let col = 0;
    for (const span of spans) {
      // Every width is a whole number of quarter pixels, which Blink, WebKit
      // and Gecko all store exactly, so the browser adds them up exactly too.
      expect(Number.isInteger(span.width * 4)).toBe(true);
      expect(Math.abs(span.left - col * cellW)).toBeLessThanOrEqual(0.125);
      col += span.text === '你' ? 2 : 1;
    }
    // The far edge is still on the grid after 80 columns.
    const last = spans[spans.length - 1];
    expect(Math.abs(last.left + last.width - 80 * cellW)).toBeLessThanOrEqual(0.125);
  });

  it('sets span width to cellW', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['x'], cellW: 9.5 }));
    const lineDiv = container.children[0] as HTMLDivElement;
    const span = lineDiv.children[0] as HTMLSpanElement;
    expect(span.style.width).toBe('9.5px');
  });

  it('applies font styles once on the line, for its spans to inherit', () => {
    const font: FontStyle = {
      fontFamily: 'Fira Code',
      fontSize: '16px',
      fontWeight: 'bold',
      color: '#ff0000',
      backgroundColor: '#000000',
      letterSpacing: '0.5px',
    };
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['A'], font }));

    const lineDiv = container.children[0] as HTMLDivElement;
    // jsdom normalizes hex to rgb()
    expect(lineDiv.style.backgroundColor).toBe('rgb(0, 0, 0)');

    expect(lineDiv.style.fontFamily).toBe('Fira Code');
    expect(lineDiv.style.fontSize).toBe('16px');
    expect(lineDiv.style.fontWeight).toBe('bold');
    expect(lineDiv.style.color).toBe('rgb(255, 0, 0)');
    expect(lineDiv.style.letterSpacing).toBe('0.5px');

    // Inherited, so a span sets none of them itself.
    const span = lineDiv.children[0] as HTMLSpanElement;
    expect(span.style.fontFamily).toBe('');
    expect(span.style.color).toBe('');
  });

  it('offsets first line by startCol', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['hi'], startCol: 5, cellW: 10 }));
    const lineDiv = container.children[0] as HTMLDivElement;
    // First line left = startCol * cellW
    expect(lineDiv.style.left).toBe('50px');
  });

  it('renders cursor at end of text', () => {
    const container = document.createElement('div');
    renderOverlay(
      container,
      makeParams({
        lines: ['ab'],
        startCol: 3,
        cellW: 10,
        cellH: 20,
        showCursor: true,
        cursorColor: '#ff00ff',
      })
    );

    // Last child is cursor (after line div)
    const cursor = container.children[container.children.length - 1] as HTMLSpanElement;
    // cursorCol = startCol(3) + text.length(2) = 5
    expect(cursor.style.left).toBe('50px');
    expect(cursor.style.width).toBe('10px');
    expect(cursor.style.height).toBe('20px');
    // jsdom normalizes hex to rgb()
    expect(cursor.style.backgroundColor).toBe('rgb(255, 0, 255)');
  });

  it('does not render cursor when showCursor is false', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['ab'], showCursor: false }));
    // Only line div, no cursor
    expect(container.children.length).toBe(1);
  });

  it('renders multi-line text', () => {
    const container = document.createElement('div');
    renderOverlay(
      container,
      makeParams({
        lines: ['first', 'second'],
        startCol: 5,
        cellW: 10,
        cellH: 20,
      })
    );

    // 2 line divs + cursor
    expect(container.children.length).toBe(3);

    const line1 = container.children[0] as HTMLDivElement;
    expect(line1.style.left).toBe('50px'); // startCol * cellW
    expect(line1.style.top).toBe('0px');
    expect(line1.children.length).toBe(5); // 'first'

    const line2 = container.children[1] as HTMLDivElement;
    expect(line2.style.left).toBe('0px'); // wrapped lines start at col 0
    expect(line2.style.top).toBe('20px'); // second row
    expect(line2.children.length).toBe(6); // 'second'
  });

  it('clears previous content on re-render', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['abc'] }));
    expect(container.children.length).toBe(2); // line + cursor

    renderOverlay(container, makeParams({ lines: ['xy'] }));
    expect(container.children.length).toBe(2); // line + cursor (rebuilt)

    const lineDiv = container.children[0] as HTMLDivElement;
    expect(lineDiv.children.length).toBe(2); // x, y
  });

  it('shows container (display not none)', () => {
    const container = document.createElement('div');
    container.style.display = 'none';
    renderOverlay(container, makeParams());
    expect(container.style.display).toBe('');
  });

  // ─── Anti-flicker / compositing seam tests ────────────────────

  it('line div height extends 1px past cellH to cover compositing seam', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['abc'], cellH: 19 }));
    const lineDiv = container.children[0] as HTMLDivElement;
    // cellH + 1 = 20px — the extra 1px covers the compositing seam
    expect(lineDiv.style.height).toBe('20px');
  });

  it('line div height is cellH+1 for various cell heights', () => {
    for (const cellH of [15, 17, 19, 22]) {
      const container = document.createElement('div');
      renderOverlay(container, makeParams({ lines: ['x'], cellH }));
      const lineDiv = container.children[0] as HTMLDivElement;
      expect(lineDiv.style.height).toBe(cellH + 1 + 'px');
    }
  });

  it('multi-line overlay has cellH+1 height on each line div', () => {
    const container = document.createElement('div');
    renderOverlay(
      container,
      makeParams({
        lines: ['first', 'second'],
        cellH: 19,
      })
    );
    const line1 = container.children[0] as HTMLDivElement;
    const line2 = container.children[1] as HTMLDivElement;
    expect(line1.style.height).toBe('20px');
    expect(line2.style.height).toBe('20px');
  });

  // ─── Span vertical centering tests ────────────────────────────

  it('span uses full cellH for height and lineHeight (CSS centering)', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['a'], cellH: 19 }));
    const lineDiv = container.children[0] as HTMLDivElement;
    const span = lineDiv.children[0] as HTMLSpanElement;
    expect(span.style.height).toBe('19px');
    // Set on the line and inherited by the span.
    expect(lineDiv.style.lineHeight).toBe('19px');
  });

  it('span has no vertical offset and no transform', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['a'], cellH: 19 }));
    const lineDiv = container.children[0] as HTMLDivElement;
    const span = lineDiv.children[0] as HTMLSpanElement;
    // A flex item starts at the top of its line; nothing shifts it down.
    expect(span.style.top).toBe('');
    expect(span.style.marginTop).toBe('');
    // No translateY transform — sub-pixel overhang causes artifacts
    expect(span.style.transform).toBe('');
  });

  // ─── Font rendering tests ─────────────────────────────────────

  // These are inherited properties, set once on the line for every span.

  it('line disables ligatures via font-feature-settings', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['fi'] }));
    const lineDiv = container.children[0] as HTMLDivElement;
    // Check cssText includes the ligature-disabling settings
    // jsdom may normalize whitespace; check that both liga and calt are disabled
    expect(lineDiv.style.cssText).toContain('font-feature-settings:');
    expect(lineDiv.style.cssText).toContain("'liga' 0");
    expect(lineDiv.style.cssText).toContain("'calt' 0");
  });

  it('line has text-align: center for glyph centering', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['m'] }));
    const lineDiv = container.children[0] as HTMLDivElement;
    expect(lineDiv.style.textAlign).toBe('center');
  });

  it('line has pointer-events: none', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['a'] }));
    const lineDiv = container.children[0] as HTMLDivElement;
    expect(lineDiv.style.pointerEvents).toBe('none');
  });

  // ─── Multi-line cursor positioning ────────────────────────────

  it('cursor on wrapped line uses col 0 as base', () => {
    const container = document.createElement('div');
    renderOverlay(
      container,
      makeParams({
        lines: ['first', 'ab'],
        startCol: 5,
        cellW: 10,
        cellH: 20,
        showCursor: true,
      })
    );
    // Cursor at end of second line: col = 0 + 2 = 2
    const cursor = container.children[container.children.length - 1] as HTMLSpanElement;
    expect(cursor.style.left).toBe('20px'); // 2 * 10
    expect(cursor.style.top).toBe('20px'); // row 1 * cellH
  });

  // ─── charTop/charHeight passed through ────────────────────────

  it('accepts charTop and charHeight params without error', () => {
    const container = document.createElement('div');
    expect(() =>
      renderOverlay(
        container,
        makeParams({
          lines: ['test'],
          charTop: 2,
          charHeight: 14,
        })
      )
    ).not.toThrow();
    expect(container.children.length).toBeGreaterThan(0);
  });

  // ─── Line div positioning regression ──────────────────────────

  it('line div background color matches font.backgroundColor', () => {
    const container = document.createElement('div');
    const font: FontStyle = { ...FONT, backgroundColor: '#1a1a1a' };
    renderOverlay(container, makeParams({ lines: ['x'], font }));
    const lineDiv = container.children[0] as HTMLDivElement;
    // jsdom normalizes hex to rgb()
    expect(lineDiv.style.backgroundColor).toBe('rgb(26, 26, 26)');
  });

  it('empty line produces line div with no spans', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: [''] }));
    const lineDiv = container.children[0] as HTMLDivElement;
    expect(lineDiv.children.length).toBe(0);
  });

  // ─── CJK wide character support ───────────────────────────────

  it('CJK characters get double-width spans', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['a你b'], cellW: 10 }));
    const lineDiv = container.children[0] as HTMLDivElement;
    expect(lineDiv.children.length).toBe(3);

    const [spanA, spanCJK, spanB] = lineSpans(lineDiv);
    expect(spanA.text).toBe('a');
    expect(spanA.left).toBe(0);
    expect(spanA.width).toBe(10); // 1 cell

    expect(spanCJK.text).toBe('你');
    expect(spanCJK.left).toBe(10); // col 1
    expect(spanCJK.width).toBe(20); // 2 cells

    expect(spanB.text).toBe('b');
    expect(spanB.left).toBe(30); // col 3
    expect(spanB.width).toBe(10); // 1 cell
  });

  it('cursor position accounts for CJK width', () => {
    const container = document.createElement('div');
    renderOverlay(
      container,
      makeParams({
        lines: ['你好'],
        startCol: 2,
        cellW: 10,
        showCursor: true,
      })
    );
    // 你(2) + 好(2) = 4 visual cols, cursor at startCol(2) + 4 = 6
    const cursor = container.children[container.children.length - 1] as HTMLSpanElement;
    expect(cursor.style.left).toBe('60px');
  });

  it('mixed ASCII and CJK characters position correctly', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['hi你'], cellW: 8 }));
    const lineDiv = container.children[0] as HTMLDivElement;
    // h(col 0), i(col 1), 你(col 2, width 2)
    const [spanH, spanI, spanCJK] = lineSpans(lineDiv);
    expect(spanH.left).toBe(0);
    expect(spanI.left).toBe(8);
    expect(spanCJK.left).toBe(16);
    expect(spanCJK.width).toBe(16);
  });
});

describe('charCellWidth', () => {
  it('returns 1 for ASCII characters', () => {
    expect(charCellWidth(null, 'a')).toBe(1);
    expect(charCellWidth(null, '!')).toBe(1);
    expect(charCellWidth(null, ' ')).toBe(1);
  });

  it('returns 2 for CJK ideographs', () => {
    expect(charCellWidth(null, '你')).toBe(2);
    expect(charCellWidth(null, '好')).toBe(2);
    expect(charCellWidth(null, '中')).toBe(2);
  });

  it('returns 2 for Japanese hiragana', () => {
    expect(charCellWidth(null, 'こ')).toBe(2);
    expect(charCellWidth(null, 'ん')).toBe(2);
  });

  it('returns 2 for Korean syllables', () => {
    expect(charCellWidth(null, '안')).toBe(2);
    expect(charCellWidth(null, '녕')).toBe(2);
  });

  it('returns 2 for fullwidth forms', () => {
    expect(charCellWidth(null, '\uff01')).toBe(2); // ！
    expect(charCellWidth(null, '\uff21')).toBe(2); // Ａ
  });

  it('uses terminal unicode addon when available', () => {
    const mockTerminal = {
      unicode: { getStringCellWidth: (s: string) => (s === 'W' ? 2 : 1) },
    } as any;
    expect(charCellWidth(mockTerminal, 'W')).toBe(2);
    expect(charCellWidth(mockTerminal, 'n')).toBe(1);
  });
});

describe('stringCellWidth', () => {
  it('sums individual character widths', () => {
    expect(stringCellWidth(null, 'abc')).toBe(3);
    expect(stringCellWidth(null, '你好')).toBe(4);
    expect(stringCellWidth(null, 'a你b')).toBe(4);
  });

  it('returns 0 for empty string', () => {
    expect(stringCellWidth(null, '')).toBe(0);
  });
});

describe('renderOverlay — staying on screen (totalRows)', () => {
  // A phone with the keyboard up leaves only a handful of terminal rows. The
  // overlay lays its wrapped lines out downward from the prompt row, so a long
  // prompt used to run off the bottom edge and the user typed blind, with the
  // tail of their own sentence behind the keyboard. With totalRows known, the
  // composer grows UPWARD instead — the line divs are opaque, so they cover
  // transcript above rather than disappearing below.
  const linesOf = (n: number) => Array.from({ length: n }, (_, i) => `line${i}`);
  const lineDivs = (container: HTMLDivElement) =>
    Array.from(container.children).filter((el) => el.tagName === 'DIV') as HTMLDivElement[];

  it('lifts the block so its last line lands on the last visible row', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: linesOf(5), promptRow: 10, totalRows: 12, cellH: 17 }));

    // 10 + 5 would end on row 14 of a 12-row screen; the block starts at 7 instead.
    expect(container.style.top).toBe(7 * 17 + 'px');
    expect(lineDivs(container)).toHaveLength(5);
  });

  it('leaves the prompt row alone when the block already fits', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: linesOf(3), promptRow: 5, totalRows: 24, cellH: 17 }));

    expect(container.style.top).toBe(5 * 17 + 'px');
  });

  it('keeps the TAIL when the prompt is taller than the whole viewport', () => {
    // The end is where the cursor is, and where the user is looking.
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: linesOf(6), promptRow: 2, totalRows: 3, cellH: 20 }));

    const divs = lineDivs(container);
    expect(container.style.top).toBe('0px');
    expect(divs).toHaveLength(3);
    expect(divs.map((d) => d.textContent)).toEqual(['line3', 'line4', 'line5']);
  });

  it('drops the prompt indent once the prompt line is no longer shown', () => {
    // startCol indents only the line that begins at the prompt marker.
    const container = document.createElement('div');
    renderOverlay(
      container,
      makeParams({ lines: linesOf(6), promptRow: 2, totalRows: 3, startCol: 5, cellW: 10, totalCols: 80 })
    );

    const first = lineDivs(container)[0];
    expect(first.style.left).toBe('0px');
    expect(first.style.width).toBe(80 * 10 + 'px');
  });

  it('rides the cursor on the last VISIBLE line', () => {
    const container = document.createElement('div');
    renderOverlay(
      container,
      makeParams({ lines: ['aaa', 'bbb', 'ccc', 'ddd'], promptRow: 9, totalRows: 3, cellH: 20, cellW: 10, startCol: 4 })
    );

    const cursor = Array.from(container.children).find((el) => el.tagName === 'SPAN') as HTMLSpanElement;
    // Tail is the last 3 lines, so the cursor sits on row 2 (0-based) of the block…
    expect(cursor.style.top).toBe(2 * 20 + 'px');
    // …at column 3, NOT startCol + 3: the indented prompt line is not shown.
    expect(cursor.style.left).toBe(3 * 10 + 'px');
  });

  it('lays out straight down when totalRows is absent (unchanged behaviour)', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: linesOf(9), promptRow: 20, cellH: 17 }));

    expect(container.style.top).toBe(20 * 17 + 'px');
    expect(lineDivs(container)).toHaveLength(9);
  });

  it('falls back to the terminal row count when totalRows is not passed', () => {
    // The addon passes totalRows, but a stale bundle / third-party caller may not.
    const container = document.createElement('div');
    renderOverlay(
      container,
      makeParams({ lines: linesOf(4), promptRow: 8, cellH: 17, terminal: { rows: 10, cols: 80 } as never })
    );

    expect(container.style.top).toBe(6 * 17 + 'px');
  });
});

describe('renderOverlay: rebuilding only the lines that changed', () => {
  const lineEls = (container: HTMLDivElement) =>
    Array.from(container.children).filter((el) => el.tagName === 'DIV') as HTMLDivElement[];
  const text = (line: HTMLDivElement) => Array.from(line.children, (s) => s.textContent).join('');

  it('appending to the last line keeps every earlier line element', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['first', 'second', 'th'] }));
    const [first, second, third] = lineEls(container);

    renderOverlay(container, makeParams({ lines: ['first', 'second', 'thi'] }));
    const after = lineEls(container);
    expect(after[0]).toBe(first);
    expect(after[1]).toBe(second);
    expect(after[2]).not.toBe(third);
    expect(after.map(text)).toEqual(['first', 'second', 'thi']);
  });

  it('keeps the cursor as the last child and moves it with the text', () => {
    const container = document.createElement('div');
    const params = { startCol: 0, cellW: 10 };
    renderOverlay(container, makeParams({ ...params, lines: ['ab'] }));
    renderOverlay(container, makeParams({ ...params, lines: ['ab', 'c'] }));
    const children = Array.from(container.children) as HTMLElement[];
    expect(children.length).toBe(3);
    const cursor = children[2];
    expect(cursor.tagName).toBe('SPAN');
    expect(cursor.style.left).toBe('10px');
    expect(cursor.style.top).toBe(17 + 'px');
    expect(container.querySelectorAll(':scope > span').length).toBe(1);
  });

  it('a wrapped line coming back (backspace) removes the extra line', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['abc', 'd'] }));
    const [first] = lineEls(container);
    renderOverlay(container, makeParams({ lines: ['abc'] }));
    expect(lineEls(container)).toEqual([first]);
    expect(container.children.length).toBe(2); // line + cursor
  });

  it('removes the cursor when the next render does not show one', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['ab'] }));
    renderOverlay(container, makeParams({ lines: ['ab'], showCursor: false }));
    expect(container.children.length).toBe(1);
    expect(container.children[0].tagName).toBe('DIV');
  });

  it('a font, colour or cell size change rebuilds every line', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['one', 'two'] }));
    const before = lineEls(container);

    renderOverlay(container, makeParams({ lines: ['one', 'two'], font: { ...FONT, color: '#ff0000' } }));
    const recoloured = lineEls(container);
    expect(recoloured[0]).not.toBe(before[0]);
    expect(recoloured[0].style.color).toBe('rgb(255, 0, 0)');

    renderOverlay(container, makeParams({ lines: ['one', 'two'], font: { ...FONT, color: '#ff0000' }, cellW: 12 }));
    const resized = lineEls(container);
    expect(resized[1]).not.toBe(recoloured[1]);
    expect(lineSpans(resized[1])[1].left).toBe(12);
  });

  it('a Unicode version switch rebuilds lines whose text did not change', () => {
    const container = document.createElement('div');
    const unicode = { activeVersion: '6', getStringCellWidth: (s: string) => (s === 'W' ? 1 : 1) };
    const terminal = { unicode } as any;
    renderOverlay(container, makeParams({ lines: ['aW'], cellW: 10, terminal }));
    const before = lineEls(container)[0];

    unicode.activeVersion = '11';
    unicode.getStringCellWidth = (s: string) => (s === 'W' ? 2 : 1);
    renderOverlay(container, makeParams({ lines: ['aW'], cellW: 10, terminal }));
    const after = lineEls(container)[0];
    expect(after).not.toBe(before);
    expect(lineSpans(after)[1].width).toBe(20);
  });

  it('starts over when something else emptied the container', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['one', 'two'] }));
    container.innerHTML = '';
    renderOverlay(container, makeParams({ lines: ['one', 'two'] }));
    expect(lineEls(container).map(text)).toEqual(['one', 'two']);
    expect(container.children.length).toBe(3);
  });

  it('starts over when something else reordered the lines', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['one', 'two'] }));
    const [one, two] = lineEls(container);
    container.insertBefore(two, one);
    renderOverlay(container, makeParams({ lines: ['one', 'two'] }));
    expect(lineEls(container).map(text)).toEqual(['one', 'two']);
    expect(container.children.length).toBe(3);
  });

  it('starts over when something else added to the container', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['one'] }));
    container.appendChild(document.createElement('div'));
    renderOverlay(container, makeParams({ lines: ['one'] }));
    expect(container.children.length).toBe(2);
    expect(text(lineEls(container)[0])).toBe('one');
  });

  it('a composition growing on the last line leaves the lines it does not reach alone', () => {
    const container = document.createElement('div');
    // 'first' (5) + 'abc' pending, composition starts at code point 8.
    renderOverlay(container, makeParams({ lines: ['first', 'abcx'], compositionStart: 8 }));
    const [first] = lineEls(container);
    renderOverlay(container, makeParams({ lines: ['first', 'abcxy'], compositionStart: 8 }));
    const after = lineEls(container);
    expect(after[0]).toBe(first);
    const marked = Array.from(after[1].children).filter((s) => s.hasAttribute('data-zerolag-composition'));
    expect(marked.map((s) => s.textContent).join('')).toBe('xy');
  });

  it('a composition that starts on an earlier line marks the whole later line', () => {
    const container = document.createElement('div');
    renderOverlay(container, makeParams({ lines: ['abXY', 'ZW'], compositionStart: 2 }));
    const [first, second] = lineEls(container);
    const marked = (line: HTMLDivElement) =>
      Array.from(line.children)
        .filter((s) => s.hasAttribute('data-zerolag-composition'))
        .map((s) => s.textContent)
        .join('');
    expect(marked(first)).toBe('XY');
    expect(marked(second)).toBe('ZW');
  });

  it('two containers keep separate records', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    renderOverlay(a, makeParams({ lines: ['same'] }));
    renderOverlay(b, makeParams({ lines: ['same'] }));
    expect(lineEls(a)[0]).not.toBe(lineEls(b)[0]);
    expect(text(lineEls(a)[0])).toBe('same');
    expect(text(lineEls(b)[0])).toBe('same');
  });
});
