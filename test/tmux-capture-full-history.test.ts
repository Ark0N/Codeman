/**
 * COD-47: full tmux scrollback replay on reload.
 *
 * Under VITEST, TmuxManager no-ops execSync (IS_TEST_MODE), so we can't drive
 * real tmux. Instead we assert the capture-arg construction directly from
 * source (same approach as tmux-capture-color.test.ts): a full-history capture
 * must use `capture-pane -p -e -J -S -<N>` (bounded to the configured history
 * limit, with an explicit exec maxBuffer) and skip the single-screen snapshot
 * repaint, while the visible capture keeps `capture-pane -p -e`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatCursorRestore, hasVisibleContent } from '../src/tmux-manager.js';

describe('tmux full-history pane capture (COD-47)', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/tmux-manager.ts'), 'utf8');
  const methodStart = source.indexOf('capturePaneBuffer(muxName: string');
  // Bounded at the next method so `methodBody` really is one method: the
  // ordering assertions below would otherwise be satisfiable by a neighbour.
  const methodEnd = source.indexOf('captureActivePaneBuffer(muxName: string', methodStart);
  const methodBody = source.slice(methodStart, methodEnd);

  it('capturePaneBuffer accepts pane-capture options with a fullHistory flag', () => {
    expect(methodStart).toBeGreaterThan(-1);
    // The method signature must carry the opts channel...
    expect(source.slice(methodStart, methodStart + 160)).toContain('PaneCaptureOptions');
    // ...and the body must branch on opts.fullHistory.
    expect(methodBody).toContain('opts?.fullHistory === true');
  });

  it('full-history mode captures scrollback bounded to the configured history limit (-J -S -<N>)', () => {
    // `-S -<N>` (not unbounded `-S -`) keeps tmux from serializing more
    // scrollback than the configured history limit retains; `-J` re-joins
    // lines hard-wrapped at the capture-time pane width.
    expect(source).toContain('capture-pane -p -e -J -S -${historyLines}');
  });

  it('full-history exec sets an explicit maxBuffer (default 1MB would ENOBUFS multi-MB dumps)', () => {
    expect(methodBody).toContain('maxBuffer');
    expect(methodBody).toContain('FULL_HISTORY_CAPTURE_SLACK_BYTES');
  });

  it('still offers the visible single-screen capture for fast tab switches', () => {
    expect(source).toContain("'capture-pane -p -e'");
  });

  it('returns full-history capture as raw scrollback (skips the single-screen repaint)', () => {
    // The fullHistory branch returns before the formatPaneSnapshot repaint,
    // which is single-screen and would clip a multi-screen history.
    const branch = methodBody.indexOf('if (fullHistory) {\n        // Without geometry');
    const snapshot = methodBody.indexOf('formatPaneSnapshot(');
    expect(branch).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(snapshot);
    // …and what it returns is normalized linear scrollback, not a repaint.
    expect(methodBody.slice(branch, snapshot)).toContain('normalizeScrollbackEol(');
  });

  it('appends the pane cursor to the full-history capture', () => {
    // A linear replay leaves the caret wherever the last character landed — the
    // status line, for an agent CLI — and every cursor-relative update the CLI
    // sends afterwards is then measured from the wrong row.
    const restore = methodBody.indexOf('formatCursorRestore(geometry)');
    const snapshot = methodBody.indexOf('formatPaneSnapshot(');
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(snapshot);
  });

  it('keeps the trailing rows only when a cursor move will follow', () => {
    // Trailing blank rows are the bottom of the screen and the cursor move counts
    // up from them, so the two decisions travel together: no geometry, no move,
    // and the old trim applies instead.
    expect(methodBody).toContain("rawCapture.replace(/\\n$/, '')");
    expect(methodBody).toContain("if (!geometry) return normalizeScrollbackEol(rawCapture.replace(/\\n+$/g, ''))");
  });

  it('defers to the byte history when the pane holds nothing visible', () => {
    expect(methodBody).toContain("if (!hasVisibleContent(trimmed)) return ''");
  });

  it('captureActivePaneBuffer forwards the capture options', () => {
    const sig = source.indexOf('captureActivePaneBuffer(muxName: string');
    expect(sig).toBeGreaterThan(-1);
    const body = source.slice(sig, sig + 800);
    expect(body).toContain('opts');
    expect(body).toContain('this.capturePaneBuffer(muxName, target, opts)');
  });
});

describe('full-history cursor restore', () => {
  it('counts up from the last replayed row rather than down from the top', () => {
    // Relative, not `CUP`: absolute row addressing is only correct while the
    // browser's row count equals the pane's, and resizeWindow does not wait for
    // tmux, so a capture can be taken before a requested resize has applied.
    expect(formatCursorRestore({ cols: 80, rows: 24, cursorX: 2, cursorY: 20 })).toBe('\x1b[3A\r\x1b[2C');
  });

  it('emits no row move when the caret is already on the last row', () => {
    expect(formatCursorRestore({ cols: 80, rows: 24, cursorX: 5, cursorY: 23 })).toBe('\r\x1b[5C');
  });

  it('emits no column move for column zero', () => {
    expect(formatCursorRestore({ cols: 80, rows: 10, cursorX: 0, cursorY: 0 })).toBe('\x1b[9A\r');
  });
});

describe('hasVisibleContent', () => {
  it('is false for a pane of blank rows', () => {
    expect(hasVisibleContent('\n'.repeat(23))).toBe(false);
  });

  it('is false for blank rows carrying only SGR attributes', () => {
    // `capture-pane -e` styles every row, so an all-blank pane is not an empty
    // string. Treating it as content would replace the byte history with a
    // blank screen.
    expect(hasVisibleContent('\x1b[m   \x1b[0m\n\x1b[m   \x1b[0m')).toBe(false);
  });

  it('is true as soon as one row carries a character', () => {
    expect(hasVisibleContent('\x1b[m   \x1b[0m\n\x1b[m x \x1b[0m')).toBe(true);
  });
});
