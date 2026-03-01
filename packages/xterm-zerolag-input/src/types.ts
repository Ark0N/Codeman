/**
 * Minimal terminal interface required by the addon.
 *
 * Compatible with both `xterm` (pre-5.4) and `@xterm/xterm` (5.4+).
 * Consumers pass their real Terminal instance — we only use these properties.
 */
export interface XtermTerminal {
    readonly element: HTMLElement | undefined;
    readonly cols: number;
    readonly rows: number;
    readonly options: {
        fontFamily?: string;
        fontSize?: number;
        fontWeight?: string | number;
        theme?: {
            background?: string;
            foreground?: string;
            cursor?: string;
        };
    };
    readonly buffer: {
        readonly active: {
            readonly viewportY: number;
            readonly baseY: number;
            getLine(y: number): {
                translateToString(trimRight?: boolean): string;
            } | undefined;
        };
    };
}

/**
 * Minimal addon interface matching xterm.js ITerminalAddon.
 *
 * The consumer calls `terminal.loadAddon(addon)` which invokes `activate()`.
 */
export interface XtermAddon {
    activate(terminal: XtermTerminal): void;
    dispose(): void;
}

/**
 * Position of the prompt in the terminal viewport.
 */
export interface PromptPosition {
    /** Viewport-relative row (0 = top of viewport) */
    row: number;
    /** Column of the prompt marker character */
    col: number;
}

/**
 * Prompt detection strategy.
 *
 * The overlay needs to know where user input starts on the terminal line.
 * Three strategies are supported:
 *
 * - `character`: Scan bottom-up for a specific character (e.g., `$`, `>`, `❯`)
 * - `regex`: Scan each line with a regex pattern
 * - `custom`: Full escape hatch — provide your own finder function
 */
export type PromptFinder =
    | { type: 'character'; char: string; offset?: number }
    | { type: 'regex'; pattern: RegExp; offset?: number }
    | { type: 'custom'; find: (terminal: XtermTerminal) => PromptPosition | null; offset?: number };

/**
 * Configuration options for ZerolagInputAddon.
 */
export interface ZerolagInputOptions {
    /**
     * How to find the prompt in the terminal buffer.
     *
     * The `offset` controls how many characters after the prompt marker
     * the user input begins (e.g., `"> "` = offset 2).
     *
     * @default { type: 'character', char: '>', offset: 2 }
     */
    prompt?: PromptFinder;

    /**
     * Z-index for the overlay element.
     * @default 7
     */
    zIndex?: number;

    /**
     * Background color for the overlay.
     * Set to `'transparent'` to disable the opaque background.
     * @default Read from terminal.options.theme.background
     */
    backgroundColor?: string;

    /**
     * Foreground color for overlay text.
     * @default Read from terminal.options.theme.foreground
     */
    foregroundColor?: string;

    /**
     * Whether to show a block cursor at the end of the overlay text.
     * @default true
     */
    showCursor?: boolean;

    /**
     * Cursor color (block cursor at end of text).
     * @default Read from terminal.options.theme.cursor
     */
    cursorColor?: string;

    /**
     * Scroll debounce time in ms for re-rendering when user scrolls
     * back to the bottom of the terminal.
     * @default 50
     */
    scrollDebounceMs?: number;
}

/**
 * Read-only state snapshot of the overlay.
 */
export interface ZerolagInputState {
    /** Characters typed but not yet acknowledged by the server */
    pendingText: string;
    /** Number of characters flushed to PTY but echo not yet received */
    flushedLength: number;
    /** Text content of the flushed portion */
    flushedText: string;
    /** Whether the overlay is currently visible */
    visible: boolean;
    /** Last detected prompt position, if any */
    promptPosition: PromptPosition | null;
}

/** Cell dimensions in CSS pixels. */
export interface CellDimensions {
    width: number;
    height: number;
    /** Vertical offset (px) from cell top to where characters render. */
    charTop: number;
    /** Height of the character rendering area (px). */
    charHeight: number;
}

/** Parameters for the overlay renderer. */
export interface RenderParams {
    lines: string[];
    startCol: number;
    totalCols: number;
    cellW: number;
    cellH: number;
    /** Vertical offset (px) from cell top to character rendering area. */
    charTop: number;
    /** Height of the character rendering area (px). */
    charHeight: number;
    promptRow: number;
    font: FontStyle;
    showCursor: boolean;
    cursorColor: string;
}

/** Cached font style properties for overlay rendering. */
export interface FontStyle {
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    color: string;
    backgroundColor: string;
    letterSpacing: string;
}
