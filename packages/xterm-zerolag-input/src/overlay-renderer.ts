import type { RenderParams, FontStyle } from './types.js';

/**
 * Render the overlay content into the container element.
 *
 * Creates per-character `<span>` elements positioned on an exact grid
 * matching xterm.js's canvas renderer. This avoids sub-pixel drift that
 * occurs with normal DOM text flow.
 */
export function renderOverlay(container: HTMLDivElement, params: RenderParams): void {
    const { lines, startCol, totalCols, cellW, cellH, charTop, charHeight, promptRow, font, showCursor, cursorColor } = params;

    // Position container at prompt row.
    container.style.left = '0px';
    container.style.top = (promptRow * cellH) + 'px';

    // Clear and rebuild (typically 1-3 line divs, negligible cost)
    container.innerHTML = '';
    const fullWidthPx = totalCols * cellW;

    for (let i = 0; i < lines.length; i++) {
        const leftPx = i === 0 ? startCol * cellW : 0;
        const widthPx = i === 0 ? (fullWidthPx - leftPx) : fullWidthPx;
        const topPx = i * cellH;
        const lineEl = makeLine(lines[i], leftPx, topPx, widthPx, cellH, cellW, charTop, charHeight, font);
        container.appendChild(lineEl);
    }

    // Block cursor at end of last line
    if (showCursor) {
        const lastLine = lines[lines.length - 1];
        const lastLineLeft = lines.length === 1 ? startCol : 0;
        const cursorCol = lastLineLeft + lastLine.length;
        if (cursorCol < totalCols) {
            const cursor = document.createElement('span');
            cursor.style.cssText = 'position:absolute;display:inline-block';
            cursor.style.left = (cursorCol * cellW) + 'px';
            cursor.style.top = ((lines.length - 1) * cellH) + 'px';
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
 * Each character gets its own `<span>` placed at `i * cellW` pixels.
 * This matches xterm's canvas renderer where each glyph occupies exactly
 * one cell width, regardless of the actual glyph metrics.
 */
function makeLine(
    text: string,
    leftPx: number,
    topPx: number,
    widthPx: number,
    cellH: number,
    cellW: number,
    charTop: number,
    charHeight: number,
    font: FontStyle,
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
    el.style.height = (cellH + 1) + 'px';

    // Spans fill the full cell height with matching lineHeight for natural
    // CSS vertical centering.  No transform — any sub-pixel overhang past
    // the line div causes visible anti-aliasing artifacts at the boundary.
    // The ≤0.5px difference from canvas ceil() rounding is imperceptible.

    for (let i = 0; i < text.length; i++) {
        const span = document.createElement('span');
        // No ligatures — canvas renders each glyph independently.
        span.style.cssText =
            'position:absolute;display:inline-block;text-align:center;pointer-events:none;' +
            "font-feature-settings:'liga' 0,'calt' 0";
        span.style.left = (i * cellW) + 'px';
        span.style.top = '0px';
        span.style.width = cellW + 'px';
        span.style.height = cellH + 'px';
        span.style.lineHeight = cellH + 'px';
        span.style.fontFamily = font.fontFamily;
        span.style.fontSize = font.fontSize;
        span.style.fontWeight = font.fontWeight;
        span.style.color = font.color;
        if (font.letterSpacing) span.style.letterSpacing = font.letterSpacing;
        span.textContent = text[i];
        el.appendChild(span);
    }

    return el;
}
