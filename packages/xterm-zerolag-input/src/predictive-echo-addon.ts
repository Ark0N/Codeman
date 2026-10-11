/**
 * PredictiveEchoAddon: mosh-style write-through local echo.
 *
 * The consumer sends every keystroke to the PTY unchanged (write-through);
 * this addon simultaneously paints the predicted glyph at the predicted cell.
 * When the real echo lands, the prediction is confirmed and its span removed
 * (an invisible swap: identical glyph beneath). Mispredictions self-heal via
 * a mismatch cascade and a TTL. Everything here is visual-only: no method
 * gates, delays, or rewrites what the consumer sends.
 *
 * Reconciliation reads the parsed terminal BUFFER (cells after xterm's parser
 * ran), never the raw output stream. Full-line redraws, ECH-based gap
 * painting, and tmux's in-place deltas all converge to the same cells; stream
 * matching cannot survive them (see docs/local-echo-overlay-plan.md's
 * "What NOT to Do" in the consuming repo).
 *
 * Coordinate base: xterm's `cursorY` is relative to `baseY`, so the absolute
 * buffer line for a viewport row is `baseY + row`. `viewportY` would only
 * coincide while scrolled to the bottom; this file never relies on that.
 */
import { getCellDimensions } from './cell-dimensions.js';
import { charCellWidth } from './overlay-renderer.js';
import { addPredictionSpan, clearAllSpans, removePredictionSpan } from './prediction-renderer.js';
import type { FontStyle, XtermAddon, XtermTerminal } from './types.js';

export interface PredictiveEchoOptions {
  /** Z-index of the span container. @default 7 (same layer as the buffer overlay) */
  zIndex?: number;
  /** Render predicted glyphs underlined (visual hedge on unreliable links). @default false */
  underlinePredictions?: boolean;
  /** Predicted glyph color. @default theme foreground / computed .xterm-rows color */
  foregroundColor?: string;
  /** Predicted glyph background. @default theme background */
  backgroundColor?: string;
  /** Drop predictions older than this. @default 1000 */
  ttlMs?: number;
  /** Maximum outstanding predictions per run. @default 32 */
  maxPending?: number;
  /** How long the cursor may sit off the anchor row before predictions clear. @default 150 */
  cursorGraceMs?: number;
  /** Suppress predictions that would land within this many cells of the right edge. @default 4 */
  edgeMarginCells?: number;
  /** Gate: return false to suppress prediction (e.g. cursor not on a composer row). */
  predictWhen?: (terminal: XtermTerminal) => boolean;
}

export interface PredictionState {
  outstanding: number;
  confirmedTotal: number;
  droppedTotal: number;
  anchor: { row: number; col: number } | null;
}

interface PredictionRecord {
  seq: number;
  char: string;
  /** Cells this glyph occupies. */
  width: 1 | 2;
  /** Cumulative cell offset from the anchor column BEFORE this char. */
  offsetCells: number;
  /** Cell content at predict time, '' normalized to ' '. */
  snapshot: string;
  sentAt: number;
  /** Consecutive reconcile passes that saw foreign non-blank content. */
  mismatches: number;
}

const DEFAULT_OPTIONS = {
  zIndex: 7,
  underlinePredictions: false,
  ttlMs: 1000,
  maxPending: 32,
  cursorGraceMs: 150,
  edgeMarginCells: 4,
} as const;

const DEFAULT_BG = '#000000';
const DEFAULT_FG = '#ffffff';

export class PredictiveEchoAddon implements XtermAddon {
  private _terminal: XtermTerminal | null = null;
  private _container: HTMLDivElement | null = null;
  private _spans = new Map<number, HTMLSpanElement>();
  private _outstanding: PredictionRecord[] = [];
  private _anchor: { row: number; col: number } | null = null;
  private _cursorOffRowSince: number | null = null;
  private _seq = 0;
  private _confirmedTotal = 0;
  private _droppedTotal = 0;
  private _ttlTimer: ReturnType<typeof setTimeout> | null = null;
  /** Anchor hold: set after an unpredicted wire edit (backspace into echoed
   *  text, any cleared input, an IME text commit). While held, new
   *  predictions are suppressed: the displayed cursor is stale until the
   *  next parsed write, and anchoring on it paints ghosts one cell off
   *  (found by review: backspace-then-retype within RTT). Cleared by the
   *  onWriteParsed pass and by public reconcile(), never by the inline
   *  predictChar pass (which runs before the display could catch up). */
  private _anchorHold = false;
  private _reconcileScheduled = false;
  private _disposables: Array<{ dispose(): void }> = [];
  private _predictWhen: ((terminal: XtermTerminal) => boolean) | null;
  private _options: Required<Omit<PredictiveEchoOptions, 'foregroundColor' | 'backgroundColor' | 'predictWhen'>> &
    Pick<PredictiveEchoOptions, 'foregroundColor' | 'backgroundColor'>;
  private _font: FontStyle = {
    fontFamily: 'monospace',
    fontSize: '14px',
    fontWeight: 'normal',
    color: DEFAULT_FG,
    backgroundColor: DEFAULT_BG,
    letterSpacing: '',
  };

  constructor(options?: PredictiveEchoOptions) {
    this._options = {
      zIndex: options?.zIndex ?? DEFAULT_OPTIONS.zIndex,
      underlinePredictions: options?.underlinePredictions ?? DEFAULT_OPTIONS.underlinePredictions,
      ttlMs: options?.ttlMs ?? DEFAULT_OPTIONS.ttlMs,
      maxPending: options?.maxPending ?? DEFAULT_OPTIONS.maxPending,
      cursorGraceMs: options?.cursorGraceMs ?? DEFAULT_OPTIONS.cursorGraceMs,
      edgeMarginCells: options?.edgeMarginCells ?? DEFAULT_OPTIONS.edgeMarginCells,
      foregroundColor: options?.foregroundColor,
      backgroundColor: options?.backgroundColor,
    };
    this._predictWhen = options?.predictWhen ?? null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /** Called by `terminal.loadAddon()`. Do not call directly. */
  activate(terminal: XtermTerminal): void {
    this._terminal = terminal;

    this._container = document.createElement('div');
    this._container.setAttribute('data-predictive-echo', '');
    this._container.style.cssText = `position:absolute;left:0;top:0;z-index:${this._options.zIndex};pointer-events:none`;
    const screen = terminal.element?.querySelector('.xterm-screen');
    if (screen) screen.appendChild(this._container);

    this._readFontStyle();

    // Debounced post-parse reconcile: xterm fires onWriteParsed after the
    // parser finishes a write chunk, so buffer reads see consistent state.
    // The microtask coalesces multi-chunk bursts into one pass.
    if (typeof terminal.onWriteParsed === 'function') {
      try {
        this._disposables.push(
          terminal.onWriteParsed(() => {
            if (this._reconcileScheduled) return;
            this._reconcileScheduled = true;
            queueMicrotask(() => {
              this._reconcileScheduled = false;
              this._anchorHold = false; // a parse pass ran: the display caught up
              this._safeReconcile();
            });
          })
        );
      } catch {
        /* consumers without a working emitter fall back to manual reconcile() */
      }
    }
    if (typeof terminal.onResize === 'function') {
      try {
        this._disposables.push(terminal.onResize(() => this.clearPredictions()));
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    this.clearPredictions();
    for (const d of this._disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this._disposables = [];
    this._container?.remove();
    this._container = null;
    this._terminal = null;
  }

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Predict a single typed character at the current insertion point.
   * Returns false when suppressed; the consumer sends the keystroke to the
   * PTY either way (the return value is informational, never a send gate).
   */
  predictChar(ch: string): boolean {
    try {
      this._reconcile();
      if (this._anchorHold) return false; // display has not caught up with a wire edit

      const t = this._terminal;
      if (!t || !this._container) return false;
      const dims = getCellDimensions(t);
      if (!dims) return false;
      const buf = t.buffer.active;
      if (typeof buf.cursorX !== 'number' || typeof buf.cursorY !== 'number') return false;
      if (buf.viewportY !== buf.baseY) return false;
      if (this._predictWhen && this._predictWhen(t) === false) return false;

      const cps = Array.from(ch);
      if (cps.length !== 1) return false;
      const cp = cps[0].codePointAt(0)!;
      if (cp < 0x20 || cp === 0x7f) return false;
      const w = charCellWidth(t, cps[0]);
      if (w !== 1 && w !== 2) return false;
      if (w === 2 && !this._hasGetCell()) return false; // ASCII fallback misaligns on wide cols
      if (this._outstanding.length >= this._options.maxPending) return false;

      if (this._outstanding.length === 0) {
        this._anchor = { row: buf.cursorY, col: buf.cursorX };
        this._cursorOffRowSince = null;
      }
      const anchor = this._anchor!;
      const last = this._outstanding[this._outstanding.length - 1];
      const offset = last ? last.offsetCells + last.width : 0;
      const col = anchor.col + offset;
      if (col + w > t.cols - this._options.edgeMarginCells) return false;

      const rec: PredictionRecord = {
        seq: this._seq++,
        char: cps[0],
        width: w,
        offsetCells: offset,
        snapshot: this._readCell(anchor.row, col),
        sentAt: performance.now(),
        mismatches: 0,
      };
      this._outstanding.push(rec);
      addPredictionSpan(this._container, this._spans, {
        seq: rec.seq,
        row: anchor.row,
        col,
        char: rec.char,
        width: w,
        dims,
        font: this._font,
        underline: this._options.underlinePredictions,
      });
      this._armTtl();
      return true;
    } catch {
      return false;
    }
  }

  /** Characters painted ahead of Codex's parsed terminal echo. */
  get pendingText(): string {
    return this._outstanding.map((record) => record.char).join('');
  }

  /**
   * Pop the newest outstanding prediction (visual only). Returns false when
   * none are outstanding. The consumer forwards \x7f UNCONDITIONALLY either
   * way; deleting already-echoed text renders at RTT.
   */
  predictBackspace(): boolean {
    try {
      const rec = this._outstanding.pop();
      if (!rec) {
        // \x7f goes to the wire and will delete ECHOED text: the cursor is
        // about to move in a way we cannot see yet
        this._anchorHold = true;
        return false;
      }
      removePredictionSpan(this._spans, rec.seq);
      if (this._outstanding.length === 0) this._resetRun();
      return true;
    } catch {
      return false;
    }
  }

  /** Drop every outstanding prediction and its spans. Also arms the anchor
   *  hold: consumers clear on inputs (Enter, Esc, arrows, pastes) whose
   *  cursor effect is unknown until the next parsed write. */
  clearPredictions(): void {
    try {
      this._anchorHold = true;
      this._droppedTotal += this._outstanding.length;
      this._outstanding = [];
      clearAllSpans(this._spans);
      this._resetRun();
    } catch {
      /* ignore */
    }
  }

  /** Manual reconcile pass, for consumers without onWriteParsed. By contract
   *  it is called after writes parsed, so it also releases the anchor hold. */
  reconcile(): void {
    this._anchorHold = false;
    this._safeReconcile();
  }

  /** Swap the prediction gate at runtime (mirrors the buffer addon's setPrompt). */
  setPredictWhen(fn: ((terminal: XtermTerminal) => boolean) | null): void {
    this._predictWhen = fn;
  }

  /** Re-read font/theme (call after skin or font-size changes). */
  refreshFont(): void {
    this._readFontStyle();
  }

  get hasPredictions(): boolean {
    return this._outstanding.length > 0;
  }

  get state(): PredictionState {
    return {
      outstanding: this._outstanding.length,
      confirmedTotal: this._confirmedTotal,
      droppedTotal: this._droppedTotal,
      anchor: this._anchor ? { ...this._anchor } : null,
    };
  }

  // ─── Reconciliation ───────────────────────────────────────────────

  private _safeReconcile(): void {
    try {
      this._reconcile();
    } catch {
      /* predictions may degrade, never break input */
    }
  }

  private _reconcile(): void {
    const t = this._terminal;
    if (!t) return;
    if (this._outstanding.length === 0) return; // streaming cost: one boolean
    const buf = t.buffer.active;
    if (buf.viewportY !== buf.baseY) {
      this.clearPredictions(); // user scrolled up
      return;
    }
    if (typeof buf.cursorX !== 'number' || typeof buf.cursorY !== 'number') return; // TTL will clean
    const anchor = this._anchor!;
    const now = performance.now();

    // Off-row grace: transient cursor excursions (repaints park the cursor
    // elsewhere mid-frame) are tolerated; a sustained move means the composer
    // relocated or the user navigated, so predictions are stale.
    if (buf.cursorY !== anchor.row) {
      this._cursorOffRowSince ??= now;
      if (now - this._cursorOffRowSince > this._options.cursorGraceMs) {
        this.clearPredictions();
        return;
      }
    } else {
      this._cursorOffRowSince = null;
    }

    // Confirm loop: PREFIX-ONLY, and only with the cursor advanced past the
    // record. Cell match alone is not enough: the predicted char may equal
    // pre-existing content (placeholder glyphs), and an identical in-place
    // tmux repaint must be a no-op (cells match snapshots, cursor unmoved).
    while (this._outstanding.length > 0) {
      const rec = this._outstanding[0];
      const cell = this._readCell(anchor.row, anchor.col + rec.offsetCells);
      if (cell === rec.char && buf.cursorY === anchor.row && buf.cursorX >= anchor.col + rec.offsetCells + rec.width) {
        this._outstanding.shift();
        removePredictionSpan(this._spans, rec.seq);
        this._confirmedTotal++;
      } else {
        break;
      }
    }

    // Mismatch scan (two-pass rule): a half-parsed row on pass N is fully
    // redrawn a few ms later, so only content foreign on TWO consecutive
    // passes cascades. Blank cells are NEUTRAL, not foreign: codex clears its
    // placeholder on the first echo, and the blanks left under later
    // predictions are what "not yet echoed" looks like, not evidence of a
    // redraw (measured 2026-08-09; without this, fast typing over the
    // placeholder cascades exactly when RTT is high). TTL still bounds them.
    let dropFrom = -1;
    for (let i = 0; i < this._outstanding.length; i++) {
      const rec = this._outstanding[i];
      const cell = this._readCell(anchor.row, anchor.col + rec.offsetCells);
      if (cell !== rec.snapshot && cell !== rec.char && cell !== ' ') {
        rec.mismatches++;
        if (rec.mismatches >= 2) {
          dropFrom = i;
          break;
        }
      } else {
        rec.mismatches = 0;
      }
    }
    if (dropFrom !== -1) this._dropFrom(dropFrom);

    // TTL: the first stale record drops itself and everything after it.
    for (let i = 0; i < this._outstanding.length; i++) {
      if (now - this._outstanding[i].sentAt > this._options.ttlMs) {
        this._dropFrom(i);
        break;
      }
    }

    if (this._outstanding.length === 0) {
      this._resetRun();
    } else {
      this._armTtl();
    }
  }

  private _dropFrom(index: number): void {
    const dropped = this._outstanding.splice(index);
    for (const rec of dropped) removePredictionSpan(this._spans, rec.seq);
    this._droppedTotal += dropped.length;
  }

  private _resetRun(): void {
    this._anchor = null;
    this._cursorOffRowSince = null;
    if (this._ttlTimer !== null) {
      clearTimeout(this._ttlTimer);
      this._ttlTimer = null;
    }
  }

  private _armTtl(): void {
    if (this._ttlTimer !== null) return;
    const oldest = this._outstanding[0];
    if (!oldest) return;
    const delay = Math.max(0, oldest.sentAt + this._options.ttlMs - performance.now()) + 1;
    this._ttlTimer = setTimeout(() => {
      this._ttlTimer = null;
      this._safeReconcile();
      this._armTtl();
    }, delay);
  }

  // ─── Cell access ──────────────────────────────────────────────────

  private _hasGetCell(): boolean {
    const buf = this._terminal?.buffer.active;
    if (!buf) return false;
    const line = buf.getLine(buf.baseY + (buf.cursorY ?? 0));
    return typeof line?.getCell === 'function';
  }

  /** Read one cell's chars at (viewport-relative row, col); '' -> ' '. */
  private _readCell(row: number, col: number): string {
    const buf = this._terminal!.buffer.active;
    const line = buf.getLine(buf.baseY + row);
    if (!line) return ' ';
    if (typeof line.getCell === 'function') {
      const chars = line.getCell(col)?.getChars() ?? '';
      return chars === '' ? ' ' : chars;
    }
    // ASCII fallback: code-unit index, misaligns after wide columns, which is
    // why width-2 predictions are suppressed without getCell.
    const text = line.translateToString(true);
    return text[col] ?? ' ';
  }

  // ─── Font ─────────────────────────────────────────────────────────

  /** Same recipe as the buffer addon's _cacheFont (kept private on purpose:
   *  zerolag-input-addon.ts must stay untouched by this feature). */
  private _readFontStyle(): void {
    const t = this._terminal;
    if (!t) return;
    this._font.fontFamily = t.options.fontFamily || 'monospace';
    this._font.fontSize = (t.options.fontSize || 14) + 'px';
    this._font.fontWeight = String(t.options.fontWeight || 'normal');
    this._font.backgroundColor = this._options.backgroundColor ?? t.options.theme?.background ?? DEFAULT_BG;
    this._font.color = this._options.foregroundColor ?? t.options.theme?.foreground ?? DEFAULT_FG;
    this._font.letterSpacing = '';
    const rows = t.element?.querySelector('.xterm-rows');
    if (rows) {
      const cs = getComputedStyle(rows);
      this._font.letterSpacing = cs.letterSpacing;
      if (!this._options.foregroundColor && cs.color) this._font.color = cs.color;
    }
  }
}
