import type { XtermTerminal, CellDimensions } from './types.js';

/**
 * Get cell dimensions from the terminal, handling xterm.js v5 (private API)
 * and v7+ (public API).
 *
 * Returns CSS-pixel values.  xterm's `device.char` is in device pixels, so
 * we divide by `devicePixelRatio` to stay consistent with `css.cell`.
 *
 * Returns `null` if the terminal is not yet rendered or dimensions are
 * unavailable.
 */
export function getCellDimensions(terminal: XtermTerminal): CellDimensions | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = terminal as any;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0
        ? devicePixelRatio : 1;

    // Try v7+ public API first
    if (t.dimensions?.css?.cell) {
        const cellH = t.dimensions.css.cell.height;
        return {
            width: t.dimensions.css.cell.width,
            height: cellH,
            charTop: (t.dimensions?.device?.char?.top ?? 0) / dpr,
            charHeight: (t.dimensions?.device?.char?.height ?? (cellH * dpr)) / dpr,
        };
    }

    // Fall back to v5 private API
    try {
        const dims = t._core?._renderService?.dimensions;
        if (dims?.css?.cell) {
            const cellH = dims.css.cell.height;
            return {
                width: dims.css.cell.width,
                height: cellH,
                charTop: (dims.device?.char?.top ?? 0) / dpr,
                charHeight: (dims.device?.char?.height ?? (cellH * dpr)) / dpr,
            };
        }
    } catch {
        // Private API may throw in some environments
    }

    return null;
}
