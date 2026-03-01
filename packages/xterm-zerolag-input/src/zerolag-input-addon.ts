import type {
    XtermTerminal,
    XtermAddon,
    ZerolagInputOptions,
    ZerolagInputState,
    PromptPosition,
    PromptFinder,
    FontStyle,
} from './types.js';
import { getCellDimensions } from './cell-dimensions.js';
import { findPrompt, readTextAfterPrompt } from './prompt-finder.js';
import { renderOverlay } from './overlay-renderer.js';

const DEFAULT_PROMPT: PromptFinder = { type: 'character', char: '>', offset: 2 };
const DEFAULT_Z_INDEX = 7;
const DEFAULT_SCROLL_DEBOUNCE_MS = 50;
const DEFAULT_BG = '#0d0d0d';
const DEFAULT_FG = '#eeeeee';
const DEFAULT_CURSOR = '#e0e0e0';

/**
 * xterm.js addon that provides instant keystroke feedback via a DOM overlay.
 *
 * Eliminates perceived input latency over high-RTT connections (SSH, remote
 * terminals, mobile) by rendering typed characters immediately as a DOM
 * overlay, without waiting for the PTY round-trip.
 *
 * The addon does NOT hook `terminal.onData` — the consumer wires their
 * own input handler and calls `addChar()`, `removeChar()`, `clear()`, etc.
 *
 * Compatible with both `xterm` (pre-5.4) and `@xterm/xterm` (5.4+).
 *
 * @example
 * ```typescript
 * import { Terminal } from '@xterm/xterm';
 * import { ZerolagInputAddon } from 'xterm-zerolag-input';
 *
 * const terminal = new Terminal();
 * const zerolag = new ZerolagInputAddon({
 *   prompt: { type: 'character', char: '$', offset: 2 },
 * });
 * terminal.open(document.getElementById('terminal')!);
 * terminal.loadAddon(zerolag);
 *
 * terminal.onData((data) => {
 *   if (data === '\r') {
 *     const text = zerolag.pendingText;
 *     zerolag.clear();
 *     ws.send(text + '\r');
 *   } else if (data === '\x7f') {
 *     const source = zerolag.removeChar();
 *     if (source === 'flushed') ws.send(data); // only send if text was already in PTY
 *   } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
 *     zerolag.addChar(data);
 *   }
 * });
 * ```
 */
export class ZerolagInputAddon implements XtermAddon {
    private _terminal: XtermTerminal | null = null;
    private _overlay: HTMLDivElement | null = null;
    private _options: Required<
        Pick<ZerolagInputOptions, 'zIndex' | 'showCursor' | 'scrollDebounceMs'>
    > & ZerolagInputOptions;

    // Text state
    private _pendingText = '';
    private _flushedOffset = 0;
    private _flushedText = '';
    private _bufferDetectDone = false;

    // Render cache
    private _lastRenderKey = '';
    private _lastPromptPos: PromptPosition | null = null;

    // Font cache
    private _font: FontStyle = {
        fontFamily: 'monospace',
        fontSize: '14px',
        fontWeight: 'normal',
        color: DEFAULT_FG,
        backgroundColor: DEFAULT_BG,
        letterSpacing: '',
    };

    // Scroll handling
    private _scrollTimer: ReturnType<typeof setTimeout> | null = null;
    private _scrollHandler: (() => void) | null = null;
    private _scrollViewport: Element | null = null;

    constructor(options?: ZerolagInputOptions) {
        this._options = {
            prompt: options?.prompt ?? DEFAULT_PROMPT,
            zIndex: options?.zIndex ?? DEFAULT_Z_INDEX,
            showCursor: options?.showCursor ?? true,
            scrollDebounceMs: options?.scrollDebounceMs ?? DEFAULT_SCROLL_DEBOUNCE_MS,
            backgroundColor: options?.backgroundColor,
            foregroundColor: options?.foregroundColor,
            cursorColor: options?.cursorColor,
        };
    }

    // ─── Lifecycle ────────────────────────────────────────────────────

    /**
     * Called by `terminal.loadAddon()`. Do not call directly.
     */
    activate(terminal: XtermTerminal): void {
        this._terminal = terminal;

        // Create overlay container
        this._overlay = document.createElement('div');
        this._overlay.style.cssText =
            `position:absolute;z-index:${this._options.zIndex};pointer-events:none;display:none`;

        // Insert into xterm DOM
        const screen = terminal.element?.querySelector('.xterm-screen');
        if (screen) {
            screen.appendChild(this._overlay);
        }

        // Cache font properties
        this._cacheFont();

        // Scroll detection: hide overlay when scrolled away from bottom
        this._scrollHandler = () => {
            try {
                const buf = this._terminal!.buffer.active;
                if (buf.viewportY !== buf.baseY) {
                    this._overlay!.style.display = 'none';
                    if (this._scrollTimer) {
                        clearTimeout(this._scrollTimer);
                        this._scrollTimer = null;
                    }
                } else if (this._pendingText || this._flushedOffset > 0) {
                    if (this._scrollTimer) clearTimeout(this._scrollTimer);
                    this._scrollTimer = setTimeout(() => {
                        this._scrollTimer = null;
                        this._lastRenderKey = '';
                        this._render();
                    }, this._options.scrollDebounceMs);
                }
            } catch { /* ignore */ }
        };

        const viewport = terminal.element?.querySelector('.xterm-viewport');
        if (viewport) {
            viewport.addEventListener('scroll', this._scrollHandler, { passive: true });
            this._scrollViewport = viewport;
        }
    }

    /**
     * Remove the overlay, clean up listeners.
     */
    dispose(): void {
        this.clear();
        if (this._scrollTimer) {
            clearTimeout(this._scrollTimer);
            this._scrollTimer = null;
        }
        if (this._scrollViewport && this._scrollHandler) {
            this._scrollViewport.removeEventListener('scroll', this._scrollHandler);
        }
        this._overlay?.remove();
        this._overlay = null;
        this._scrollViewport = null;
        this._scrollHandler = null;
        this._terminal = null;
    }

    // ─── Input methods ────────────────────────────────────────────────

    /**
     * Add a single printable character to the overlay.
     * Call this when the user types a character (charCode >= 32, length === 1).
     */
    addChar(char: string): void {
        if (!this._pendingText && !this._flushedOffset) this._detectBufferText();
        this._pendingText += char;
        this._render();
    }

    /**
     * Append multiple characters at once (e.g., paste).
     */
    appendText(text: string): void {
        if (!text) return;
        if (!this._pendingText && !this._flushedOffset) this._detectBufferText();
        this._pendingText += text;
        this._render();
    }

    /**
     * Remove the last character from the overlay.
     *
     * Cascade order:
     * 1. Remove from `pendingText` if non-empty → returns `'pending'`
     * 2. Decrement `flushedOffset` if pending is empty but flushed exists → returns `'flushed'`
     * 3. Try `detectBufferText()` if both are empty, then decrement → returns `'flushed'`
     *
     * @returns The source of the removed character, or `false` if nothing to remove.
     *
     * - `'pending'`: A character was removed from unsent text. The consumer
     *   should NOT send backspace to the PTY (the text was never transmitted).
     * - `'flushed'`: A character was removed from text already sent to the PTY.
     *   The consumer SHOULD send backspace to the PTY.
     * - `false`: Nothing to remove. The consumer should NOT send backspace.
     */
    removeChar(): 'pending' | 'flushed' | false {
        if (this._pendingText.length > 0) {
            this._pendingText = this._pendingText.slice(0, -1);
            if (this._pendingText.length > 0 || this._flushedOffset > 0) {
                this._render();
            } else {
                this._hide();
            }
            return 'pending';
        }

        if (this._flushedOffset > 0) {
            this._flushedOffset--;
            this._flushedText = this._flushedText.slice(0, -1);
            if (this._flushedOffset > 0) {
                this._render();
            } else {
                this._hide();
            }
            return 'flushed';
        }

        // Both empty — try detecting text already on the prompt line
        // (handles tab completion, arrow-key edits, etc.)
        this._detectBufferText();
        if (this._flushedOffset > 0) {
            this._flushedOffset--;
            this._flushedText = this._flushedText.slice(0, -1);
            if (this._flushedOffset > 0) {
                this._render();
            } else {
                this._hide();
            }
            return 'flushed';
        }

        return false;
    }

    /**
     * Clear all overlay state (pending + flushed). Hides the overlay.
     * Call on Enter, Ctrl+C, or any action that submits/cancels input.
     */
    clear(): void {
        this._pendingText = '';
        this._flushedOffset = 0;
        this._flushedText = '';
        this._bufferDetectDone = false;
        this._lastRenderKey = '';
        this._lastPromptPos = null;
        this._hide();
    }

    // ─── Flushed text tracking ────────────────────────────────────────

    /**
     * Mark characters as "flushed" — sent to PTY but echo not yet received.
     *
     * The overlay renders flushed text (from the stored string) with an opaque
     * background to cover the terminal's canvas text, preventing a visible
     * font mismatch between canvas and DOM rendering.
     *
     * @param count - Number of characters flushed
     * @param text - The actual flushed text (avoids reading stale terminal buffer)
     * @param render - Whether to re-render immediately (default: `true`).
     *   Pass `false` when restoring flushed state during a tab/session switch
     *   before the new buffer has loaded — rendering against a stale buffer
     *   would lock the prompt column to the wrong position. Call `rerender()`
     *   explicitly after the buffer finishes loading.
     */
    setFlushed(count: number, text: string, render = true): void {
        this._flushedOffset = count;
        this._flushedText = text;
        if (render) this._render();
    }

    /**
     * Get current flushed state.
     */
    getFlushed(): { count: number; text: string } {
        return { count: this._flushedOffset, text: this._flushedText };
    }

    /**
     * Clear flushed state. Call when server echo has arrived and the terminal
     * buffer now contains the flushed text.
     */
    clearFlushed(): void {
        this._flushedOffset = 0;
        this._flushedText = '';
        if (this._pendingText) {
            this._render();
        } else {
            this._hide();
        }
    }

    // ─── Rendering control ────────────────────────────────────────────

    /**
     * Force a re-render of the overlay at the current prompt position.
     * Call after terminal resets, buffer reloads, or full-screen redraws
     * that move the prompt.
     */
    rerender(): void {
        if (this._pendingText || this._flushedOffset > 0) {
            this._lastRenderKey = '';
            this._render();
        }
    }

    /**
     * Re-read font properties from the terminal and re-render.
     * Call after font size changes, theme changes, etc.
     */
    refreshFont(): void {
        this._cacheFont();
        this._lastRenderKey = '';
        if (this._pendingText || this._flushedOffset > 0) this._render();
    }

    // ─── Buffer detection ─────────────────────────────────────────────

    /**
     * Scan the terminal buffer for text after the prompt marker.
     * If found, sets it as flushed text in the overlay.
     *
     * Use case: Tab completion filled text on the prompt that the overlay
     * doesn't know about. Call this to sync overlay state with the buffer.
     *
     * @returns The detected text, or `null` if no prompt or no text found.
     */
    detectBufferText(): string | null {
        return this._detectBufferText();
    }

    /**
     * Reset the buffer detection guard. After `clear()`, detection is
     * automatically re-enabled. Call this manually if you need to force
     * re-detection (e.g., after a tab completion response arrives).
     */
    resetBufferDetection(): void {
        this._bufferDetectDone = false;
    }

    /**
     * Undo the last `detectBufferText()` call — clears flushed state and
     * re-enables detection.
     *
     * Use case: Tab completion detection found text that matches the
     * pre-tab baseline (no real completion happened). Call this to undo
     * the detection so it can retry on the next flush cycle.
     */
    undoDetection(): void {
        this._flushedOffset = 0;
        this._flushedText = '';
        this._bufferDetectDone = false;
    }

    /**
     * Suppress buffer detection until the next `clear()` or
     * `resetBufferDetection()` call.
     *
     * Use case: When switching to a session whose buffer contains UI
     * framework text (e.g., Ink status bars) after the prompt marker,
     * `detectBufferText()` would falsely pick up that text as user input.
     * Call this after switching to prevent false detection until the user
     * actually presses Enter (which calls `clear()` and re-enables detection).
     */
    suppressBufferDetection(): void {
        this._bufferDetectDone = true;
    }

    // ─── Prompt configuration ──────────────────────────────────────────

    /**
     * Change the prompt detection strategy at runtime.
     * Call this when switching between CLI modes (e.g., Claude Code vs OpenCode)
     * that use different prompt characters.
     */
    setPrompt(finder: PromptFinder): void {
        this._options.prompt = finder;
        this._lastPromptPos = null;
        this._lastRenderKey = '';
        if (this._pendingText || this._flushedOffset > 0) this._render();
    }

    // ─── Prompt utilities ─────────────────────────────────────────────

    /**
     * Find the prompt in the terminal buffer using the configured strategy.
     * @returns The position or `null` if not found.
     */
    findPrompt(): PromptPosition | null {
        if (!this._terminal) return null;
        return findPrompt(this._terminal, this._options.prompt ?? DEFAULT_PROMPT);
    }

    /**
     * Read text after the prompt marker on the prompt line.
     * Convenience method for consumers that need to snapshot prompt content.
     */
    readPromptText(): string | null {
        if (!this._terminal) return null;
        const prompt = this.findPrompt();
        if (!prompt) return null;
        const offset = this._getPromptOffset();
        const text = readTextAfterPrompt(this._terminal, prompt, offset);
        return text || null;
    }

    // ─── Public state ─────────────────────────────────────────────────

    /** Current pending (unacknowledged) text. */
    get pendingText(): string {
        return this._pendingText;
    }

    /** Whether there is any overlay content (pending or flushed). */
    get hasPending(): boolean {
        return this._pendingText.length > 0 || this._flushedOffset > 0;
    }

    /** Read-only state snapshot. */
    get state(): ZerolagInputState {
        return {
            pendingText: this._pendingText,
            flushedLength: this._flushedOffset,
            flushedText: this._flushedText,
            visible: this._overlay !== null && this._overlay.style.display !== 'none',
            promptPosition: this._lastPromptPos ? { ...this._lastPromptPos } : null,
        };
    }

    // ─── Private methods ──────────────────────────────────────────────

    private _getPromptOffset(): number {
        const prompt = this._options.prompt ?? DEFAULT_PROMPT;
        return prompt.offset ?? 2;
    }

    private _detectBufferText(): string | null {
        if (this._bufferDetectDone) return null;
        if (!this._terminal) return null;

        try {
            const prompt = this.findPrompt();
            if (!prompt) return null;

            const offset = this._getPromptOffset();
            const afterPrompt = readTextAfterPrompt(this._terminal, prompt, offset);

            if (afterPrompt.length > 0) {
                this._flushedOffset = afterPrompt.length;
                this._flushedText = afterPrompt;
                this._lastPromptPos = prompt;
                this._bufferDetectDone = true;
                return afterPrompt;
            }
        } catch { /* ignore */ }

        return null;
    }

    private _cacheFont(): void {
        if (!this._terminal) return;

        const t = this._terminal;
        this._font.fontFamily = t.options.fontFamily || 'monospace';
        this._font.fontSize = (t.options.fontSize || 14) + 'px';
        this._font.fontWeight = String(t.options.fontWeight || 'normal');
        this._font.backgroundColor =
            this._options.backgroundColor ??
            t.options.theme?.background ??
            DEFAULT_BG;
        this._font.color =
            this._options.foregroundColor ??
            t.options.theme?.foreground ??
            DEFAULT_FG;
        this._font.letterSpacing = '';

        // Prefer computed styles from rendered rows (matches actual rendering)
        const rows = t.element?.querySelector('.xterm-rows');
        if (rows) {
            const cs = getComputedStyle(rows);
            this._font.letterSpacing = cs.letterSpacing;
            if (!this._options.foregroundColor && cs.color) {
                this._font.color = cs.color;
            }
        }
    }

    private _hide(): void {
        if (!this._overlay) return;
        this._lastRenderKey = '';
        this._lastPromptPos = null;
        this._overlay.innerHTML = '';
        this._overlay.style.display = 'none';
    }

    private _render(): void {
        if (!this._terminal || !this._overlay) return;
        if (!this._pendingText && !(this._flushedOffset > 0)) {
            this._overlay.style.display = 'none';
            return;
        }

        try {
            const buf = this._terminal.buffer.active;

            // Hide overlay when scrolled up — prompt is at bottom, not in viewport
            if (buf.viewportY !== buf.baseY) {
                this._overlay.style.display = 'none';
                return;
            }

            // Re-scan for prompt on every render (full-screen redraws can move it)
            const prompt = this.findPrompt();
            if (prompt) {
                // When flushed text exists, lock column to prevent jitter from
                // redraws that temporarily shift the prompt marker. Allow row changes.
                if (this._lastPromptPos && this._flushedOffset > 0) {
                    this._lastPromptPos = { row: prompt.row, col: this._lastPromptPos.col };
                } else {
                    this._lastPromptPos = prompt;
                }
            } else if (!this._lastPromptPos) {
                this._overlay.style.display = 'none';
                return;
            }
            const activePrompt = this._lastPromptPos!;

            const dims = getCellDimensions(this._terminal);
            if (!dims) {
                this._overlay.style.display = 'none';
                return;
            }

            const { width: cellW, height: cellH, charTop, charHeight } = dims;
            const totalCols = this._terminal.cols;
            const offset = this._getPromptOffset();
            const startCol = activePrompt.col + offset;

            // Build display text: flushed chars + pending chars
            let displayText = this._pendingText;
            if (this._flushedOffset > 0) {
                if (this._flushedText && this._flushedText.length === this._flushedOffset) {
                    displayText = this._flushedText + this._pendingText;
                } else {
                    // Fallback: read flushed chars from terminal buffer
                    const absRow = buf.viewportY + activePrompt.row;
                    const line = buf.getLine(absRow);
                    if (line) {
                        const lineText = line.translateToString(true);
                        const flushedChars = lineText.slice(startCol, startCol + this._flushedOffset);
                        displayText = flushedChars + this._pendingText;
                    }
                }
            }

            // Skip redundant re-renders — include text content to detect
            // same-length changes (e.g., setFlushed with different text)
            const renderKey = `${displayText}:${startCol}:${activePrompt.row}:${activePrompt.col}:${totalCols}:${this._flushedOffset}`;
            if (renderKey === this._lastRenderKey && this._overlay.style.display !== 'none') return;
            this._lastRenderKey = renderKey;

            // Split text into visual lines matching terminal character-wrap
            const firstLineCols = Math.max(1, totalCols - startCol);
            const lines: string[] = [];
            let remaining = displayText;
            lines.push(remaining.slice(0, firstLineCols));
            remaining = remaining.slice(firstLineCols);
            while (remaining.length > 0) {
                lines.push(remaining.slice(0, totalCols));
                remaining = remaining.slice(totalCols);
            }

            const cursorColor =
                this._options.cursorColor ??
                this._terminal.options.theme?.cursor ??
                DEFAULT_CURSOR;

            renderOverlay(this._overlay, {
                lines,
                startCol,
                totalCols,
                cellW,
                cellH,
                charTop,
                charHeight,
                promptRow: activePrompt.row,
                font: this._font,
                showCursor: this._options.showCursor,
                cursorColor,
            });
        } catch {
            // Hide on render error but preserve pendingText —
            // next rerender() will retry when terminal is ready.
            if (this._overlay) {
                this._overlay.innerHTML = '';
                this._overlay.style.display = 'none';
            }
        }
    }
}
