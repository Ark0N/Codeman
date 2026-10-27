/**
 * Mock terminal factory for unit tests.
 *
 * Creates a minimal Terminal-like object that satisfies the addon's
 * requirements without needing a real xterm.js instance or DOM renderer.
 *
 * PredictiveEchoAddon additions (all ADDITIVE, existing tests unchanged):
 * mutable cursor via setCursor(), wide-char-aware getCell() on mock lines,
 * onWriteParsed/onResize emitters with fire* triggers, and opt-outs for
 * getCell support and the emitters (getCellSupport / emitters options).
 */
import { charCellWidth } from '../src/overlay-renderer.js';

interface MockLine {
  translateToString(_trimRight?: boolean): string;
  getCell?(x: number): { getChars(): string; getWidth(): number } | undefined;
}

interface MockBufferOptions {
  lines: string[];
  viewportY?: number;
  baseY?: number;
  cursorX?: number;
  cursorY?: number;
}

interface MockTerminalOptions {
  buffer?: MockBufferOptions;
  cols?: number;
  rows?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  theme?: {
    background?: string;
    foreground?: string;
    cursor?: string;
  };
  cellWidth?: number;
  cellHeight?: number;
  /** Device-pixel char top offset (for charTop calculation). Default: 0 */
  deviceCharTop?: number;
  /** Device-pixel char height (for charHeight calculation). Default: cellHeight * dpr */
  deviceCharHeight?: number;
  /** Provide getCell() on mock lines (PredictiveEchoAddon). Default: true */
  getCellSupport?: boolean;
  /** Provide onWriteParsed/onResize emitters (PredictiveEchoAddon). Default: true */
  emitters?: boolean;
}

/** Column-indexed cell access over a plain string, wide-char aware. */
function cellAt(text: string, col: number): { getChars(): string; getWidth(): number } {
  let c = 0;
  for (const ch of text) {
    const w = charCellWidth(null, ch);
    if (col === c) return { getChars: () => ch, getWidth: () => w };
    if (w === 2 && col === c + 1) return { getChars: () => '', getWidth: () => 0 };
    c += w;
  }
  return { getChars: () => '', getWidth: () => 1 };
}

export function createMockTerminal(opts: MockTerminalOptions = {}) {
  const bufOpts = opts.buffer ?? { lines: ['$ '] };
  const viewportY = bufOpts.viewportY ?? 0;
  const baseY = bufOpts.baseY ?? viewportY;
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? Math.max(bufOpts.lines.length, 24);
  const cellW = opts.cellWidth ?? 8.4;
  const cellH = opts.cellHeight ?? 17;
  const getCellSupport = opts.getCellSupport ?? true;
  const emitters = opts.emitters ?? true;

  const makeLine = (text: string): { line: MockLine; set(t: string): void } => {
    let current = text;
    const line: MockLine = {
      translateToString: () => current,
    };
    if (getCellSupport) {
      line.getCell = (x: number) => cellAt(current, x);
    }
    return { line, set: (t: string) => (current = t) };
  };

  let mockLines = bufOpts.lines.map(makeLine);

  // Create minimal DOM structure
  const element = document.createElement('div');
  element.className = 'terminal xterm';

  const viewport = document.createElement('div');
  viewport.className = 'xterm-viewport';

  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  screen.style.position = 'relative';

  const xtermRows = document.createElement('div');
  xtermRows.className = 'xterm-rows';

  element.appendChild(viewport);
  element.appendChild(screen);
  screen.appendChild(xtermRows);

  // Append to document so getComputedStyle works
  document.body.appendChild(element);

  const writeParsedCbs = new Set<() => void>();
  const resizeCbs = new Set<(s: { cols: number; rows: number }) => void>();

  const terminal = {
    element,
    cols,
    rows,
    options: {
      fontFamily: opts.fontFamily ?? 'monospace',
      fontSize: opts.fontSize ?? 14,
      fontWeight: opts.fontWeight ?? 'normal',
      theme: opts.theme ?? {},
    },
    buffer: {
      active: {
        viewportY,
        baseY,
        cursorX: bufOpts.cursorX ?? 0,
        cursorY: bufOpts.cursorY ?? 0,
        getLine: (absRow: number): MockLine | undefined => {
          return mockLines[absRow - viewportY]?.line;
        },
      },
    },
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: { width: cellW, height: cellH },
          },
          device: {
            char: {
              top: opts.deviceCharTop ?? 0,
              height: opts.deviceCharHeight ?? cellH,
            },
          },
        },
      },
    },
    ...(emitters
      ? {
          onWriteParsed(cb: () => void) {
            writeParsedCbs.add(cb);
            return { dispose: () => writeParsedCbs.delete(cb) };
          },
          onResize(cb: (s: { cols: number; rows: number }) => void) {
            resizeCbs.add(cb);
            return { dispose: () => resizeCbs.delete(cb) };
          },
        }
      : {}),
    // Simulate loadAddon
    loadAddon(addon: { activate: (t: unknown) => void }) {
      addon.activate(this);
    },
  };

  return {
    terminal,
    /** Update buffer lines for subsequent calls */
    setLines(newLines: string[]) {
      mockLines = newLines.map(makeLine);
    },
    /** Update one line's text in place (PredictiveEchoAddon echo simulation) */
    setLine(index: number, text: string) {
      mockLines[index]?.set(text);
    },
    /** Move the mock cursor (PredictiveEchoAddon) */
    setCursor(x: number, y: number) {
      terminal.buffer.active.cursorX = x;
      terminal.buffer.active.cursorY = y;
    },
    /** Set scroll state (viewportY / baseY) */
    setScroll(newViewportY: number, newBaseY: number) {
      terminal.buffer.active.viewportY = newViewportY;
      terminal.buffer.active.baseY = newBaseY;
    },
    /** Fire the onWriteParsed emitter (PredictiveEchoAddon reconcile trigger) */
    fireWriteParsed() {
      for (const cb of [...writeParsedCbs]) cb();
    },
    /** Fire the onResize emitter */
    fireResize(newCols = cols, newRows = rows) {
      for (const cb of [...resizeCbs]) cb({ cols: newCols, rows: newRows });
    },
    /** Number of live onWriteParsed listeners (dispose assertions) */
    writeParsedListenerCount() {
      return writeParsedCbs.size;
    },
    /** Number of live onResize listeners (dispose assertions) */
    resizeListenerCount() {
      return resizeCbs.size;
    },
    /** Clean up DOM */
    cleanup() {
      element.remove();
    },
  };
}

/**
 * The glyph spans of a rendered overlay line, with each one's left edge and
 * width in px. The spans sit side by side in a flex row, so a span's left
 * edge is the sum of the widths before it (what the browser lays out), not a
 * style property of its own; jsdom does no layout, so this adds them up.
 */
export function lineSpans(lineDiv: Element): { text: string; left: number; width: number; el: HTMLSpanElement }[] {
  const spans: { text: string; left: number; width: number; el: HTMLSpanElement }[] = [];
  let left = 0;
  for (const child of Array.from(lineDiv.children)) {
    const el = child as HTMLSpanElement;
    const width = parseFloat(el.style.width);
    spans.push({ text: el.textContent || '', left, width, el });
    left += width;
  }
  return spans;
}
