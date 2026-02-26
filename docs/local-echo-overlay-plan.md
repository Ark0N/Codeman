# Local Echo Overlay — Implementation Plan

## Context

User accesses Codeman remotely from Thailand to Switzerland over Tailscale (~200-300ms RTT).
Every keystroke is invisible for 200-300ms before the server echoes it back. This makes typing
painfully slow on mobile. Previous attempts to write directly to xterm.js buffer failed because
Ink (Claude Code's terminal framework) does full-screen redraws that corrupt injected characters.

## Approach: DOM Overlay (Mosh-inspired)

A single absolutely-positioned `<span>` inside xterm.js's `.xterm-screen` element that shows
typed characters at the cursor position. This completely avoids buffer conflicts with Ink because
we never write to xterm.js's buffer — the overlay is a pure DOM element sitting on top.

**Why this works when buffer writes don't:** Ink owns the terminal buffer and does full-line
redraws. A DOM overlay sits in a separate rendering layer (z-index 7) and doesn't interfere
with Ink's cursor management or screen redraws at all. When Ink redraws (server output arrives),
we simply hide the overlay.

**Why it will look indistinguishable:** We use the DOM renderer (not canvas/WebGL) in our
xterm.js v5.3.0, so both terminal text and overlay text are rendered by the same browser
font engine with identical sub-pixel rendering.

## Key Technical Details (from research)

### Pixel Positioning Formula
```js
// Same formula used by BufferDecorationRenderer, CompositionHelper, Terminal._syncTextArea
const dims = terminal._core._renderService.dimensions;
const left = cursorX * dims.css.cell.width;   // CSS pixels, relative to .xterm-screen
const top  = cursorY * dims.css.cell.height;  // CSS pixels, relative to .xterm-screen
```

- `cursorX` = `terminal.buffer.active.cursorX` (0 to terminal.cols)
- `cursorY` = `terminal.buffer.active.cursorY` (0 to terminal.rows-1, ALREADY viewport-relative)
- No scroll offset math needed

### Cell Dimensions (v5.3.0 — no public API, use internal)
```js
const dims = terminal._core._renderService.dimensions;
dims.css.cell.width   // e.g., 8.4px
dims.css.cell.height  // e.g., 17px
```
Public `terminal.dimensions` only available in v7.0.0+.

### xterm.js DOM Structure
```
div.terminal.xterm
  ├── div.xterm-viewport (overflow-y: scroll)
  └── div.xterm-screen (position: relative) ← INSERT OVERLAY HERE
        ├── div.xterm-helpers (z-index: 5)
        ├── div.xterm-rows (the actual text) (z-index: auto/0)
        ├── div.xterm-selection (z-index: 1)
        └── div.xterm-decoration-container (z-index: 6-7)
```

### Z-Index Layers
| Layer | Z-Index |
|-------|---------|
| textarea | -5 |
| row content (DOM renderer) | auto (0) |
| selection | 1 |
| composition (IME) | 1 |
| helpers | 5 |
| decorations | 6 |
| decorations (top layer) | 7 ← OUR OVERLAY |
| overview ruler | 8 |
| accessibility | 10 |

### Font Matching CSS
```css
.local-echo-overlay {
    position: absolute;
    z-index: 7;
    pointer-events: none;
    white-space: pre;
    font-kerning: none;
    overflow: hidden;
    display: none;
    /* Set dynamically: left, top, height, line-height, font-family, font-size, color, letter-spacing */
}
```

Critical: match `letter-spacing` from `.xterm-rows` container (DPR rounding compensation).

### Font Properties from Terminal
```js
terminal.options.fontFamily   // '"Fira Code", "Cascadia Code", ...'
terminal.options.fontSize     // 14 (10 on mobile)
terminal.options.fontWeight   // 'normal'
terminal.options.letterSpacing // 0
terminal.options.lineHeight   // 1.2
```

Use actual `dims.css.cell.height` for line-height (not the multiplier).

## Files to Modify

### `src/web/public/app.js` — All logic

1. **Constructor** (~line 1455): Initialize overlay state variables
2. **After terminal creation** (in `setupTerminal` or similar): Create overlay DOM element
3. **`terminal.onData` handler** (~line 1801): Echo printable chars to overlay when idle
4. **`flushPendingWrites`** (~line 2083): Hide overlay when server output arrives
5. **SSE event handlers**: Update overlay state on session:idle/working/exit
6. **`selectSession`**: Clear overlay on tab switch
7. **`handleInit`**: Clear overlay on SSE reconnect
8. **Settings load/save** (`openAppSettings`/`saveAppSettings`): Toggle checkbox

### `src/web/public/index.html` — Settings toggle

After Image Watcher section (~line 878), add "Input" section with checkbox.

## Implementation Details

### Overlay Class (inline in app.js, near extractSyncSegments)

```js
class LocalEchoOverlay {
    constructor(terminal) {
        this.terminal = terminal;
        this.overlay = document.createElement('span');
        // ... CSS setup ...
        const screen = terminal.element.querySelector('.xterm-screen');
        screen.appendChild(this.overlay);
        this.pendingText = '';
        this.timeout = null;
    }

    addChar(char) {
        this.pendingText += char;
        this._render();
        this._resetTimeout();
    }

    removeChar() {
        if (this.pendingText.length > 0) {
            this.pendingText = this.pendingText.slice(0, -1);
            this._render();
            if (this.pendingText.length > 0) this._resetTimeout();
            else this._clearTimeout();
        }
    }

    clear() {
        this.pendingText = '';
        this.overlay.textContent = '';
        this.overlay.style.display = 'none';
        this._clearTimeout();
    }

    _render() {
        if (!this.pendingText) { this.clear(); return; }
        const dims = this.terminal._core._renderService.dimensions;
        const cellW = dims.css.cell.width;
        const cellH = dims.css.cell.height;
        const cursorX = this.terminal.buffer.active.cursorX;
        const cursorY = this.terminal.buffer.active.cursorY;

        this.overlay.style.left = (cursorX * cellW) + 'px';
        this.overlay.style.top = (cursorY * cellH) + 'px';
        this.overlay.style.height = cellH + 'px';
        this.overlay.style.lineHeight = cellH + 'px';
        this.overlay.textContent = this.pendingText;
        this.overlay.style.display = '';
    }

    _resetTimeout() {
        this._clearTimeout();
        this.timeout = setTimeout(() => this.clear(), 2000);
    }

    _clearTimeout() {
        if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
    }

    get hasPending() { return this.pendingText.length > 0; }

    dispose() {
        this.clear();
        this.overlay.remove();
    }
}
```

### Integration Points

**Input handler (`terminal.onData`):**
- Backspace (`\x7f`): if overlay has pending + echo enabled → `overlay.removeChar()`
- Enter (`\r`/`\n`): `overlay.clear()`, disable echo (session goes busy)
- Other control chars / multi-char (paste): `overlay.clear()`
- Single printable char (charCode >= 32, length === 1): if echo enabled → `overlay.addChar(data)`

**Output handler (`flushPendingWrites`):**
- After writing segments: if overlay has pending text → `overlay.clear()` (server confirmed)

**State management:**
- `_localEchoEnabled` boolean, updated on session status change + settings change
- Only enabled when: setting on + active session is idle
- On idle→busy transition: clear overlay
- On tab switch: clear overlay
- On SSE reconnect: clear overlay

### Settings

**index.html:** Checkbox `appSettingsLocalEcho` under "Input" section header
**openAppSettings:** Load `settings.localEchoEnabled ?? false`
**saveAppSettings:** Save checkbox + call `_updateLocalEchoState()`
Default: **disabled** (opt-in)

## Edge Cases

| Case | Handling |
|---|---|
| Paste (multi-char onData) | data.length > 1 → NOT echoed. Server echoes it. |
| Misprediction | Server output arrives → overlay cleared → server redraws correctly |
| Idle→busy race | _updateLocalEchoState() disables + clears overlay |
| Server unresponsive | 2s timeout → overlay cleared |
| Tab switch | selectSession() clears overlay |
| SSE reconnect | handleInit() clears overlay |
| Terminal resize | Overlay position recalculated on next _render() |
| Scrolled back | cursorY is viewport-relative, position stays correct |
| Unicode/emoji | data.length > 1 → not echoed (ASCII-only) |

## What NOT to Do

- Do NOT write to `terminal.write()` — Ink conflicts
- Do NOT use `registerDecoration` — requires markers, can't follow cursor smoothly
- Do NOT try to match predictions against server output — Ink's full-line redraws make this impossible
- Do NOT use `stripAnsiForMatch` / `findEscapeEnd` — removed, not needed for overlay approach
