import type { RenderParams, FontStyle, XtermTerminal } from './types.js';

// ─── CJK / fullwidth character width detection ───────────────────────

/**
 * Get visual cell width of a single character.
 * CJK wide characters occupy 2 cells, others occupy 1.
 * Prefers the terminal's Unicode addon when available.
 */
export function charCellWidth(terminal: XtermTerminal | null | undefined, ch: string): number {
  if (terminal?.unicode?.getStringCellWidth) {
    return terminal.unicode.getStringCellWidth(ch);
  }
  // Fallback: detect CJK wide characters by Unicode range
  const code = ch.codePointAt(0);
  if (
    code !== undefined &&
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo
      (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals, Kangxi, Ideographic
      (code >= 0x3040 && code <= 0x33bf) || // Hiragana, Katakana, Bopomofo, CJK Compat
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ext A
      (code >= 0x4e00 && code <= 0xa4cf) || // CJK Unified, Yi
      (code >= 0xa960 && code <= 0xa97c) || // Hangul Jamo Extended-A
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compat Forms
      (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
      (code >= 0x1f000 && code <= 0x1fbff) || // Mahjong, Domino, Emoji
      (code >= 0x20000 && code <= 0x2ffff) || // CJK Unified Ext B-F
      (code >= 0x30000 && code <= 0x3ffff)) // CJK Unified Ext G+
  )
    return 2;
  return 1;
}

/**
 * Get visual cell width of a string (sum of all character widths).
 */
export function stringCellWidth(terminal: XtermTerminal | null | undefined, str: string): number {
  let w = 0;
  for (const ch of str) w += charCellWidth(terminal, ch);
  return w;
}

// ─── Overlay rendering ────────────────────────────────────────────────

/**
 * Cell edges are snapped to this fraction of a CSS pixel.
 *
 * The glyph spans sit in normal flow, so each one starts where the widths
 * before it add up to, and a width the layout engine cannot store exactly
 * would carry its rounding error into every later cell (the drift that plain
 * DOM text shows against the canvas grid). A quarter pixel is exact in
 * Blink and WebKit (1/64 px layout units) and in Gecko (1/60 px app units),
 * so the widths always add up to the snapped edge: no drift at any column,
 * and every edge is within 1/8 px of `col * cellW`.
 */
const EDGE_SNAP = 4;

function cellEdge(col: number, cellW: number): number {
  return Math.round(col * cellW * EDGE_SNAP) / EDGE_SNAP;
}

/** What the last render left in a container, so the next one rebuilds only the lines that changed. */
interface RenderedLines {
  /** Everything a line's markup depends on besides its own text and position. */
  styleKey: string;
  lines: HTMLDivElement[];
  lineKeys: string[];
  cursor: HTMLSpanElement | null;
}

const rendered = new WeakMap<HTMLDivElement, RenderedLines>();

/**
 * False once anything else has emptied or edited the container (the addon's
 * hide path clears it): the children must be exactly the recorded lines, in
 * order, then the cursor.
 */
function holdsOnlyRendered(container: HTMLDivElement, state: RenderedLines): boolean {
  const children = container.children;
  if (children.length !== state.lines.length + (state.cursor ? 1 : 0)) return false;
  for (let i = 0; i < state.lines.length; i++) {
    if (children[i] !== state.lines[i]) return false;
  }
  return !state.cursor || children[state.lines.length] === state.cursor;
}

/**
 * Render the overlay content into the container element.
 *
 * Each line is a `<div>` holding one `<span>` per character on the cell grid
 * of xterm.js's canvas renderer (see makeLine). CJK wide characters get
 * double-width spans.
 *
 * Only lines whose content or position changed since the previous render
 * into the same container are rebuilt. Typing a character changes just the
 * last line, so a keystroke costs one line of DOM work however long the
 * prompt is; rebuilding everything made each keystroke O(prompt length) in
 * DOM work, layout and paint, which a long prompt on a phone paid for in
 * dropped frames.
 */
export function renderOverlay(container: HTMLDivElement, params: RenderParams): void {
  const {
    lines,
    compositionStart,
    startCol,
    totalCols,
    cellW,
    cellH,
    charTop,
    charHeight,
    promptRow,
    totalRows,
    font,
    showCursor,
    cursorColor,
    terminal,
  } = params;

  // ── Keep what is being typed ON SCREEN ────────────────────────────
  //
  // The overlay lays its wrapped lines out DOWNWARD from the prompt row, and
  // nothing past the last terminal row is visible. On a phone the strip left
  // above the on-screen keyboard is only a handful of rows, so a prompt long
  // enough to wrap ran off the bottom and the user was typing blind — the tail
  // of their own sentence, the part they are actually looking at, hidden behind
  // the keyboard.
  //
  // So the composer grows UPWARD once it reaches the last row, exactly as a real
  // terminal's does: every line div is opaque (see makeLine), so the lines cover
  // transcript rows above instead of vanishing under the keyboard below, and the
  // newest text stays where the eye is. A prompt taller than the whole viewport
  // keeps its TAIL for the same reason.
  //
  // `startCol` indents only the line that begins at the prompt marker, so it is
  // dropped along with that line when the tail is all that fits.
  const rows = totalRows && totalRows > 0 ? totalRows : terminal?.rows;
  // Code-point offset of each line in the whole text, so the composition
  // styling survives the tail slice below.
  const lineOffsets: number[] = [];
  const lineLengths: number[] = [];
  {
    let offset = 0;
    for (const line of lines) {
      const length = [...line].length;
      lineOffsets.push(offset);
      lineLengths.push(length);
      offset += length;
    }
  }
  let visibleLines = lines;
  let firstVisible = 0;
  let keepsPromptLine = true;
  let topRow = promptRow;
  if (rows && rows > 0) {
    if (lines.length > rows) {
      firstVisible = lines.length - rows;
      visibleLines = lines.slice(firstVisible);
      keepsPromptLine = false;
      topRow = 0;
    } else if (promptRow + lines.length > rows) {
      topRow = rows - lines.length;
    }
  }
  topRow = Math.max(0, topRow);

  container.style.left = '0px';
  container.style.top = topRow * cellH + 'px';

  // Reuse the previous render's lines when nothing they depend on but their
  // own text and position changed; otherwise start from an empty container.
  const styleKey = [
    cellW,
    cellH,
    font.fontFamily,
    font.fontSize,
    font.fontWeight,
    font.color,
    font.backgroundColor,
    font.letterSpacing,
    terminal?.unicode?.activeVersion ?? '',
  ].join('\n');
  let state = rendered.get(container);
  if (!state || state.styleKey !== styleKey || !holdsOnlyRendered(container, state)) {
    container.innerHTML = '';
    state = { styleKey, lines: [], lineKeys: [], cursor: null };
    rendered.set(container, state);
  }
  // Taken out while the lines change, so it is appended last again below.
  state.cursor?.remove();
  state.cursor = null;

  const fullWidthPx = totalCols * cellW;

  for (let i = 0; i < visibleLines.length; i++) {
    const indents = i === 0 && keepsPromptLine;
    const leftPx = indents ? startCol * cellW : 0;
    const widthPx = indents ? fullWidthPx - leftPx : fullWidthPx;
    const topPx = i * cellH;
    // Clamped to the line, so a line the composition does not reach keeps
    // the same key (and its element) while the composition moves along.
    let lineCompositionFrom: number | undefined;
    if (compositionStart !== undefined) {
      const from = compositionStart - lineOffsets[firstVisible + i];
      if (from < lineLengths[firstVisible + i]) lineCompositionFrom = Math.max(0, from);
    }
    // Text goes last, so no character in it can make two different lines collide.
    const key = `${leftPx}|${topPx}|${widthPx}|${lineCompositionFrom ?? ''}|${visibleLines[i]}`;
    if (state.lineKeys[i] === key) continue;
    const lineEl = makeLine(
      visibleLines[i],
      leftPx,
      topPx,
      widthPx,
      cellH,
      cellW,
      charTop,
      charHeight,
      font,
      terminal,
      lineCompositionFrom
    );
    const previous = state.lines[i];
    if (previous) container.replaceChild(lineEl, previous);
    else container.appendChild(lineEl);
    state.lines[i] = lineEl;
    state.lineKeys[i] = key;
  }
  for (let i = state.lines.length - 1; i >= visibleLines.length; i--) state.lines[i].remove();
  state.lines.length = visibleLines.length;
  state.lineKeys.length = visibleLines.length;

  // Block cursor at end of last line (use visual width for CJK support)
  if (showCursor) {
    const lastLine = visibleLines[visibleLines.length - 1];
    const lastLineLeft = visibleLines.length === 1 && keepsPromptLine ? startCol : 0;
    const cursorCol = lastLineLeft + stringCellWidth(terminal, lastLine);
    if (cursorCol < totalCols) {
      const cursor = document.createElement('span');
      cursor.style.cssText = 'position:absolute;display:inline-block';
      cursor.style.left = cursorCol * cellW + 'px';
      cursor.style.top = (visibleLines.length - 1) * cellH + 'px';
      cursor.style.width = cellW + 'px';
      cursor.style.height = cellH + 'px';
      cursor.style.backgroundColor = cursorColor;
      container.appendChild(cursor);
      state.cursor = cursor;
    }
  }

  container.style.display = '';
}

/**
 * Create a styled line `<div>` with one `<span>` per character on the cell grid.
 *
 * The spans sit side by side in a flex row, each exactly as wide as its cells
 * (CJK wide characters occupy 2), with every edge snapped by cellEdge() so the
 * widths add up to the grid without drifting. They are deliberately not
 * absolutely positioned: a positioned element gets its own paint layer, and
 * with one per character a long prompt left the browser re-layerizing and
 * repainting thousands of them on every keystroke. Everything the spans share
 * (font, colour, line height, centring, ligatures off) is set once on the
 * line and inherited.
 *
 * Characters at or after `compositionFrom` (a code-point index into `text`)
 * are IME composition text: underlined, like xterm's own composition view, and
 * marked `data-zerolag-composition` + `aria-hidden` since they are provisional.
 */
function makeLine(
  text: string,
  leftPx: number,
  topPx: number,
  widthPx: number,
  cellH: number,
  cellW: number,
  _charTop: number,
  _charHeight: number,
  font: FontStyle,
  terminal?: XtermTerminal | null,
  compositionFrom?: number
): HTMLDivElement {
  const el = document.createElement('div');
  // No ligatures: the canvas renders each glyph independently.
  el.style.cssText =
    "position:absolute;display:flex;pointer-events:none;text-align:center;font-feature-settings:'liga' 0,'calt' 0";
  el.style.backgroundColor = font.backgroundColor;
  el.style.left = leftPx + 'px';
  el.style.top = topPx + 'px';
  el.style.width = widthPx + 'px';
  // Extend background 1px past cell boundary to cover the compositing
  // seam between the overlay layer (z-index:7) and the canvas layer below.
  // The extra 1px lands in the next row's charTop gap (empty area before
  // text rendering starts), so no canvas content is obscured.
  el.style.height = cellH + 1 + 'px';
  el.style.lineHeight = cellH + 'px';
  el.style.fontFamily = font.fontFamily;
  el.style.fontSize = font.fontSize;
  el.style.fontWeight = font.fontWeight;
  el.style.color = font.color;
  if (font.letterSpacing) el.style.letterSpacing = font.letterSpacing;

  // Each span runs from the previous snapped edge to its own, so the spans
  // land on the grid by visual column (CJK wide chars span 2 cells).
  const spanHeight = ';height:' + cellH + 'px';
  let col = 0;
  let edge = 0;
  let index = 0;
  for (const ch of text) {
    col += charCellWidth(terminal, ch);
    const nextEdge = cellEdge(col, cellW);
    const span = document.createElement('span');
    span.style.cssText = 'flex:none;width:' + (nextEdge - edge) + 'px' + spanHeight;
    if (compositionFrom !== undefined && index >= compositionFrom) {
      span.style.textDecoration = 'underline';
      span.setAttribute('data-zerolag-composition', '');
      span.setAttribute('aria-hidden', 'true');
    }
    span.textContent = ch;
    el.appendChild(span);
    edge = nextEdge;
    index++;
  }

  return el;
}
