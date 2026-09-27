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
 * Render the overlay content into the container element.
 *
 * Creates per-character `<span>` elements positioned on an exact grid
 * matching xterm.js's canvas renderer. This avoids sub-pixel drift that
 * occurs with normal DOM text flow.
 *
 * CJK wide characters are rendered with double-width spans.
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
  {
    let offset = 0;
    for (const line of lines) {
      lineOffsets.push(offset);
      offset += [...line].length;
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

  // Clear and rebuild (typically 1-3 line divs, negligible cost)
  container.innerHTML = '';
  const fullWidthPx = totalCols * cellW;

  for (let i = 0; i < visibleLines.length; i++) {
    const indents = i === 0 && keepsPromptLine;
    const leftPx = indents ? startCol * cellW : 0;
    const widthPx = indents ? fullWidthPx - leftPx : fullWidthPx;
    const topPx = i * cellH;
    const lineCompositionFrom =
      compositionStart === undefined ? undefined : compositionStart - lineOffsets[firstVisible + i];
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
    container.appendChild(lineEl);
  }

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
    }
  }

  container.style.display = '';
}

/**
 * Create a styled line `<div>` with per-character grid positioning.
 *
 * Each character gets its own `<span>` positioned by visual column offset.
 * CJK wide characters occupy 2 cell widths. Characters at or after
 * `compositionFrom` (a code-point index into `text`, may be negative) are IME
 * composition text: underlined, like xterm's own composition view, and marked
 * `data-zerolag-composition` + `aria-hidden` since they are provisional.
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
  el.style.cssText = 'position:absolute;pointer-events:none';
  el.style.backgroundColor = font.backgroundColor;
  el.style.left = leftPx + 'px';
  el.style.top = topPx + 'px';
  el.style.width = widthPx + 'px';
  // Extend background 1px past cell boundary to cover the compositing
  // seam between the overlay layer (z-index:7) and the canvas layer below.
  // The extra 1px lands in the next row's charTop gap (empty area before
  // text rendering starts), so no canvas content is obscured.
  el.style.height = cellH + 1 + 'px';

  // CJK wide chars occupy 2 cells — position by visual column offset
  let colOffset = 0;
  let index = 0;
  for (const ch of text) {
    const cw = charCellWidth(terminal, ch);
    const span = document.createElement('span');
    // No ligatures — canvas renders each glyph independently.
    span.style.cssText =
      'position:absolute;display:inline-block;text-align:center;pointer-events:none;' +
      "font-feature-settings:'liga' 0,'calt' 0";
    span.style.left = colOffset * cellW + 'px';
    span.style.top = '0px';
    span.style.width = cw * cellW + 'px';
    span.style.height = cellH + 'px';
    span.style.lineHeight = cellH + 'px';
    span.style.fontFamily = font.fontFamily;
    span.style.fontSize = font.fontSize;
    span.style.fontWeight = font.fontWeight;
    span.style.color = font.color;
    if (font.letterSpacing) span.style.letterSpacing = font.letterSpacing;
    if (compositionFrom !== undefined && index >= compositionFrom) {
      span.style.textDecoration = 'underline';
      span.setAttribute('data-zerolag-composition', '');
      span.setAttribute('aria-hidden', 'true');
    }
    span.textContent = ch;
    el.appendChild(span);
    colOffset += cw;
    index++;
  }

  return el;
}
