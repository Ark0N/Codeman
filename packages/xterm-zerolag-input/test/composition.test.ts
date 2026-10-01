import { describe, it, expect, afterEach } from 'vitest';
import { createMockTerminal } from './helpers.js';
import { ZerolagInputAddon } from '../src/zerolag-input-addon.js';

// setComposition(): IME text still being composed, drawn as an underlined tail
// after the pending text. Visual only, never part of what a consumer sends.

const CELL_W = 10;

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

function setup(opts: { lines?: string[]; cols?: number; rows?: number } = {}) {
  const mock = createMockTerminal({
    buffer: { lines: opts.lines ?? ['$ '] },
    cols: opts.cols,
    rows: opts.rows,
    cellWidth: CELL_W,
    cellHeight: 20,
  });
  const addon = new ZerolagInputAddon({ prompt: { type: 'character', char: '$', offset: 2 } });
  mock.terminal.loadAddon(addon);
  cleanups.push(() => {
    addon.dispose();
    mock.cleanup();
  });
  const overlay = mock.terminal.element.querySelector('.xterm-screen')!.lastElementChild as HTMLDivElement;
  return { addon, mock, overlay };
}

/** Line divs of the overlay (the block cursor is a bare span, not a div). */
function lineDivs(overlay: HTMLDivElement): HTMLDivElement[] {
  return Array.from(overlay.children).filter((el) => el.tagName === 'DIV') as HTMLDivElement[];
}

function lineText(line: HTMLDivElement): string {
  return Array.from(line.children)
    .map((s) => s.textContent)
    .join('');
}

function compositionText(overlay: HTMLDivElement): string {
  return Array.from(overlay.querySelectorAll('[data-zerolag-composition]'))
    .map((s) => s.textContent)
    .join('');
}

describe('setComposition', () => {
  it('renders the composition after pendingText, underlined and aria-hidden', () => {
    const { addon, overlay } = setup();
    addon.appendText('abc');
    addon.setComposition('xy');

    const [line] = lineDivs(overlay);
    expect(lineText(line)).toBe('abcxy');
    const spans = Array.from(line.children) as HTMLSpanElement[];
    for (const span of spans.slice(0, 3)) {
      expect(span.hasAttribute('data-zerolag-composition')).toBe(false);
      expect(span.style.textDecoration).toBe('');
    }
    for (const span of spans.slice(3)) {
      expect(span.hasAttribute('data-zerolag-composition')).toBe(true);
      expect(span.getAttribute('aria-hidden')).toBe('true');
      expect(span.style.textDecoration).toBe('underline');
    }
    // Grid positions continue straight on from the pending text.
    expect(spans[3].style.left).toBe(3 * CELL_W + 'px');
    expect(spans[4].style.left).toBe(4 * CELL_W + 'px');
    expect(overlay.style.display).toBe('');
  });

  it('places a wide composition by cell width after wide pending text', () => {
    const { addon, overlay } = setup();
    addon.appendText('今日は');
    addon.setComposition('天気');
    const spans = Array.from(lineDivs(overlay)[0].children) as HTMLSpanElement[];
    expect(spans.map((s) => s.textContent).join('')).toBe('今日は天気');
    expect(spans[3].style.left).toBe(6 * CELL_W + 'px');
    expect(spans[3].style.width).toBe(2 * CELL_W + 'px');
    expect(spans[4].style.left).toBe(8 * CELL_W + 'px');
  });

  it('does not touch pendingText, hasPending, flushed state or the state snapshot', () => {
    const { addon } = setup();
    addon.appendText('abc');
    addon.setFlushed(2, 'zz');
    addon.setComposition('xy');
    expect(addon.pendingText).toBe('abc');
    expect(addon.getFlushed()).toEqual({ count: 2, text: 'zz' });
    expect(addon.composition).toBe('xy');
    expect(addon.state.pendingText).toBe('abc');
    expect(addon.state.flushedText).toBe('zz');
  });

  it('shows on an empty prompt without making anything pending', () => {
    const { addon, overlay } = setup();
    addon.setComposition('かな');
    expect(addon.pendingText).toBe('');
    expect(addon.hasPending).toBe(false);
    expect(addon.state.visible).toBe(true);
    expect(compositionText(overlay)).toBe('かな');
  });

  it('wraps with the pending text: the tail continues onto the next line', () => {
    // 12 cols, prompt at col 0 + offset 2 = 10 cells on the first line.
    const { addon, overlay } = setup({ cols: 12 });
    addon.appendText('abcdefgh');
    addon.setComposition('WXYZ');
    const lines = lineDivs(overlay);
    expect(lines.map(lineText)).toEqual(['abcdefghWX', 'YZ']);
    expect(compositionText(overlay)).toBe('WXYZ');
    const second = Array.from(lines[1].children) as HTMLSpanElement[];
    expect(second.every((s) => s.hasAttribute('data-zerolag-composition'))).toBe(true);
    expect(second[0].style.left).toBe('0px');
  });

  it('keeps the composition styling when only the tail of a tall prompt fits', () => {
    // 2 visible rows, 3 lines of text: the first line is dropped.
    const { addon, overlay } = setup({ cols: 6, rows: 2 });
    addon.appendText('abcdefghij');
    addon.setComposition('XYZ');
    const lines = lineDivs(overlay);
    expect(lines.map(lineText)).toEqual(['efghij', 'XYZ']);
    expect(compositionText(overlay)).toBe('XYZ');
    const first = Array.from(lines[0].children);
    expect(first.some((s) => s.hasAttribute('data-zerolag-composition'))).toBe(false);
  });

  it("setComposition('') removes the tail and keeps the pending text", () => {
    const { addon, overlay } = setup();
    addon.appendText('abc');
    addon.setComposition('xy');
    addon.setComposition('');
    expect(lineText(lineDivs(overlay)[0])).toBe('abc');
    expect(compositionText(overlay)).toBe('');
    expect(addon.pendingText).toBe('abc');
  });

  it("setComposition('') on an otherwise empty overlay hides it", () => {
    const { addon, overlay } = setup();
    addon.setComposition('xy');
    addon.setComposition('');
    expect(overlay.style.display).toBe('none');
    expect(overlay.innerHTML).toBe('');
  });

  it('clear() (Enter, Ctrl+C) drops the composition with everything else', () => {
    const { addon, overlay } = setup();
    addon.appendText('abc');
    addon.setComposition('xy');
    addon.clear();
    expect(addon.composition).toBe('');
    expect(overlay.style.display).toBe('none');
    addon.addChar('q');
    expect(lineText(lineDivs(overlay)[0])).toBe('q');
  });

  it('removeChar() drops the composition and removes a pending char, not a composed one', () => {
    const { addon, overlay } = setup();
    addon.appendText('abc');
    addon.setComposition('xy');
    expect(addon.removeChar()).toBe('pending');
    expect(addon.pendingText).toBe('ab');
    expect(addon.composition).toBe('');
    expect(lineText(lineDivs(overlay)[0])).toBe('ab');
  });

  it('text appended while composing lands before the tail', () => {
    const { addon, overlay } = setup();
    addon.appendText('ab');
    addon.setComposition('xy');
    addon.addChar('c');
    expect(lineText(lineDivs(overlay)[0])).toBe('abcxy');
    expect(compositionText(overlay)).toBe('xy');
  });

  it('rerender() and refreshFont() keep the composition', () => {
    const { addon, overlay } = setup();
    addon.appendText('abc');
    addon.setComposition('xy');
    addon.rerender();
    expect(compositionText(overlay)).toBe('xy');
    addon.refreshFont();
    expect(compositionText(overlay)).toBe('xy');
    expect(lineText(lineDivs(overlay)[0])).toBe('abcxy');
  });

  it('re-renders when only the composition changes', () => {
    const { addon, overlay } = setup();
    addon.appendText('abc');
    addon.setComposition('x');
    addon.setComposition('xy');
    expect(lineText(lineDivs(overlay)[0])).toBe('abcxy');
  });

  it('strips control characters and line breaks from the composition', () => {
    const { addon, overlay } = setup();
    addon.setComposition('a\nb\u0007c ');
    expect(addon.composition).toBe('abc');
    expect(compositionText(overlay)).toBe('abc');
  });

  it('draws the block cursor after the composition', () => {
    const { addon, overlay } = setup();
    addon.appendText('ab');
    addon.setComposition('xy');
    const cursor = Array.from(overlay.children).find((el) => el.tagName === 'SPAN') as HTMLSpanElement;
    // prompt col 0 + offset 2 + 4 cells
    expect(cursor.style.left).toBe(6 * CELL_W + 'px');
  });
});
