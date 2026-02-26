<p align="center">
  <h1 align="center">xterm-zerolag-input</h1>
  <p align="center">
    Instant keystroke feedback overlay for <a href="https://xtermjs.org/">xterm.js</a><br>
    <em>Eliminates perceived input latency over high-RTT connections</em>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/xterm-zerolag-input"><img src="https://img.shields.io/npm/v/xterm-zerolag-input?style=flat-square&color=22c55e" alt="npm"></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-1e3a5f?style=flat-square" alt="MIT"></a>
    <img src="https://img.shields.io/badge/Dependencies-0-22c55e?style=flat-square" alt="Zero deps">
    <img src="https://img.shields.io/badge/Tests-78-22c55e?style=flat-square" alt="78 tests">
    <img src="https://img.shields.io/badge/xterm.js-v5%20%7C%20v7+-3b82f6?style=flat-square" alt="xterm.js">
  </p>
</p>

---

## The Problem

When using xterm.js over a remote connection (SSH web clients, cloud IDEs, mobile terminals), every keystroke takes a full round-trip to the server before appearing on screen. At 100-500ms RTT, typing feels sluggish and unresponsive. Users type blind, make mistakes they can't see, and the experience feels broken.

## The Solution

`xterm-zerolag-input` renders typed characters **immediately** as a pixel-perfect DOM overlay positioned on the terminal's character grid. The overlay covers the terminal canvas at the prompt location, showing characters instantly while the server echo travels back. Once the server responds, the overlay seamlessly disappears and the real terminal text takes over.

```
Keystroke Flow:
                                    ┌─── DOM overlay (instant, 0ms)
User types 'h' ─── onData('h') ───┤
                                    └─── Your app sends to PTY ──→ Server
                                                                      │
Server echoes 'h' ←──────────────────────────────────────────────────┘
         │                                                  (200-500ms RTT)
         └──→ terminal.write('h') ──→ overlay.clear()
              (server output replaces overlay — seamless transition)
```

**No changes to your backend needed.** The addon is purely client-side.

## Origin

This library was extracted from [Codeman](https://github.com/Ark0N/Codeman), a Claude Code session manager that runs 20+ autonomous AI agents over 24-hour sessions. The local echo system was built to make mobile and remote access feel instant, then battle-tested across thousands of hours of real usage. After 3 deep code audits, it was extracted into this standalone library with 78 tests covering every state transition.

## Install

```bash
npm install xterm-zerolag-input
```

- **Zero runtime dependencies**
- Compatible with both `xterm` (pre-5.4) and `@xterm/xterm` (5.4+)
- Dual CJS/ESM build with full TypeScript declarations
- Works with canvas, WebGL, and DOM renderers

## Quick Start

```typescript
import { Terminal } from '@xterm/xterm';
import { ZerolagInputAddon } from 'xterm-zerolag-input';

const terminal = new Terminal();
terminal.open(document.getElementById('terminal')!);

// 1. Create addon with your prompt character
const zerolag = new ZerolagInputAddon({
  prompt: { type: 'character', char: '$', offset: 2 },
});
terminal.loadAddon(zerolag);

// 2. Wire your input handler
terminal.onData((data) => {
  if (data === '\r') {
    const text = zerolag.pendingText;
    zerolag.clear();
    ws.send(text + '\r');
  } else if (data === '\x7f') {
    const source = zerolag.removeChar();
    if (source === 'flushed') ws.send(data); // only backspace text already in PTY
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    zerolag.addChar(data);
  }
});

// 3. Re-render after terminal output (for full-screen TUI frameworks like Ink)
terminal.onWriteParsed(() => {
  if (zerolag.hasPending) zerolag.rerender();
});
```

## Why This Is Hard

Most terminal UIs can't do local echo because:

1. **Buffer writes corrupt**: Frameworks like [Ink](https://github.com/vadimdemedes/ink) (React for terminals) redraw the entire screen on every state change. Writing directly to the terminal buffer gets immediately overwritten.

2. **Cursor position lies**: In Ink, `buffer.cursorY` reflects internal state (near the status bar), not the visible prompt. You can't trust it.

3. **Font matching**: Canvas/WebGL renderers use their own text shaping. A DOM overlay must pixel-match the canvas grid — normal DOM text flow drifts due to sub-pixel glyph width differences.

This library solves all three by:
- Using a **DOM overlay** that Ink can't touch (separate z-index layer)
- **Scanning the buffer** bottom-up for the prompt character instead of trusting cursor position
- Rendering each character as an **absolutely-positioned `<span>`** at exact cell-grid coordinates

---

## Prompt Detection

The addon needs to know where user input starts. It scans the terminal buffer bottom-up for the prompt. Three strategies:

### Character (default)

```typescript
// Bash: user@host:~$
{ type: 'character', char: '$', offset: 2 }

// Zsh: user@host ~ %
{ type: 'character', char: '%', offset: 2 }

// Fish / Starship: ❯
{ type: 'character', char: '\u276f', offset: 2 }

// Simple arrow: >
{ type: 'character', char: '>', offset: 2 }
```

`offset` = characters between the prompt marker and where user input begins (e.g., `"$ "` = 2).

### Regex

For complex prompts. The `g` flag is safely stripped to prevent `lastIndex` mutation.

```typescript
{ type: 'regex', pattern: /\$\s*$/, offset: 2 }
{ type: 'regex', pattern: /\(venv\)\s+\w+\s+%/, offset: 2 }
```

### Custom

Full control:

```typescript
{
  type: 'custom',
  offset: 0,
  find: (terminal) => {
    // Return { row, col } or null. Row is viewport-relative.
    return { row: terminal.rows - 1, col: 0 };
  },
}
```

---

## API Reference

### `ZerolagInputAddon`

Implements xterm.js `ITerminalAddon`. The addon does **not** hook `terminal.onData()` — you wire your own input handler and call these methods. This gives you full control over which keystrokes are echoed vs forwarded.

### Input

| Method | Returns | Description |
|--------|---------|-------------|
| `addChar(char)` | `void` | Add a single printable character. Auto-detects existing buffer text on first keystroke. |
| `appendText(text)` | `void` | Append multiple characters (paste). |
| `removeChar()` | `'pending'` \| `'flushed'` \| `false` | Remove last char. See [backspace handling](#backspace-handling). |
| `clear()` | `void` | Clear all state, hide overlay. Call on Enter/Ctrl+C/Escape. |

### Backspace Handling

`removeChar()` cascades through three layers and tells you what it removed:

| Return | Source | Your action |
|--------|--------|-------------|
| `'pending'` | Unsent text (never transmitted to PTY) | Do nothing |
| `'flushed'` | Text already sent to PTY | Send `\x7f` backspace to PTY |
| `false` | Nothing to remove | Do nothing |

The cascade: pending text first, then flushed text, then auto-detect buffer text (handles tab completion). This means backspace "just works" through any combination of typed, flushed, and tab-completed text.

### Flushed Text

"Flushed" = sent to PTY but echo hasn't arrived yet. Happens during tab switches and tab completion.

| Method | Description |
|--------|-------------|
| `setFlushed(count, text, render?)` | Mark text as flushed. Pass `render=false` during tab-switch restore (buffer not loaded yet). |
| `getFlushed()` | Returns `{ count, text }`. |
| `clearFlushed()` | Clear flushed state when server echo arrives. |

### Buffer Detection

Scan the terminal for text that exists after the prompt but wasn't typed through the overlay.

| Method | Description |
|--------|-------------|
| `detectBufferText()` | Scan and return detected text (or `null`). Sets it as flushed. Guarded: runs once per `clear()` cycle. |
| `resetBufferDetection()` | Re-enable detection. |
| `suppressBufferDetection()` | Block detection until next `clear()`. Use for sessions with UI framework text after the prompt. |
| `undoDetection()` | Undo last detection — clears flushed state, re-enables detection. For tab completion retry. |

### Rendering

| Method | Description |
|--------|-------------|
| `rerender()` | Force re-render. Call after buffer reloads, screen redraws, resizes, reconnects. |
| `refreshFont()` | Re-cache font properties from terminal. Call after font size or theme changes. |

### Prompt Utilities

| Method | Description |
|--------|-------------|
| `findPrompt()` | Find prompt position. Returns `{ row, col }` or `null`. |
| `readPromptText()` | Read text after prompt marker. Returns string or `null`. |

### State

| Property | Type | Description |
|----------|------|-------------|
| `pendingText` | `string` | Unacknowledged text (read-only) |
| `hasPending` | `boolean` | `true` if overlay has any content |
| `state` | `ZerolagInputState` | Full snapshot: pendingText, flushedLength, flushedText, visible, promptPosition |

### Options

```typescript
{
  prompt?: PromptFinder,       // Default: { type: 'character', char: '>', offset: 2 }
  zIndex?: number,             // Default: 7
  backgroundColor?: string,    // Default: from terminal theme
  foregroundColor?: string,    // Default: from computed .xterm-rows style
  showCursor?: boolean,        // Default: true
  cursorColor?: string,        // Default: from terminal theme
  scrollDebounceMs?: number,   // Default: 50
}
```

---

## Integration Patterns

### Buffered Input (hold until Enter)

The quick start example above. Characters accumulate in the overlay and are sent on Enter. Best for remote shells where you want to batch input.

### Char-at-a-Time (send immediately)

```typescript
terminal.onData((data) => {
  if (data === '\r') {
    zerolag.clear();
    ws.send('\r');
  } else if (data === '\x7f') {
    zerolag.removeChar();
    ws.send(data);
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    zerolag.addChar(data);
    ws.send(data); // send immediately — overlay shows while echo travels back
  }
});
```

### Tab Switching (multi-session)

```typescript
function switchToSession(newId: string) {
  // Save
  const pending = zerolag.pendingText;
  const { count, text } = zerolag.getFlushed();
  if (pending) sendToPty(currentId, pending);
  savedState.set(currentId, { count: count + pending.length, text: text + pending });
  zerolag.clear();

  // Load new buffer...
  loadBuffer(newId);

  // Restore
  zerolag.suppressBufferDetection();
  const saved = savedState.get(newId);
  if (saved) zerolag.setFlushed(saved.count, saved.text, false); // silent

  // Render after buffer loads
  terminal.write('', () => zerolag.rerender());
}
```

### Tab Completion

```typescript
const baseline = zerolag.readPromptText();
zerolag.clear();
sendToPty('\t');

// After response:
zerolag.resetBufferDetection();
const detected = zerolag.detectBufferText();
if (detected && detected !== baseline) {
  zerolag.rerender(); // completion happened
} else if (detected) {
  zerolag.undoDetection(); // same text, retry next cycle
}
```

### Resize / Font / Reconnect

```typescript
fitAddon.fit();
zerolag.rerender();

terminal.options.fontSize = 18;
zerolag.refreshFont();

function onReconnect() { zerolag.rerender(); }
```

---

## How It Works

### DOM Structure

```
div.xterm-screen (position: relative)
  ├── div.xterm-rows (z-index: auto)     ← terminal owns this
  ├── div.xterm-selection (z-index: 1)
  ├── div.xterm-helpers (z-index: 5)
  ├── div.xterm-decoration-container (z-index: 6-7)
  └── div[zerolag overlay] (z-index: 7)  ← our overlay (invisible to Ink)
```

### Per-Character Grid Alignment

Each character is an absolutely-positioned `<span>`:

```
left  = charIndex * cellWidth   (CSS pixels)
top   = lineIndex * cellHeight  (CSS pixels)
width = cellWidth               (exact cell width)
```

This avoids sub-pixel drift from normal DOM text flow.

### Font Matching

1. `fontFamily`, `fontSize`, `fontWeight` from `terminal.options`
2. `letterSpacing` from computed style of `.xterm-rows`
3. `-webkit-font-smoothing: antialiased` (matches canvas grayscale)
4. `font-feature-settings: 'liga' 0, 'calt' 0` (no ligatures)
5. `text-rendering: geometricPrecision`

### Cell Dimensions

- **xterm.js v5.x**: `terminal._core._renderService.dimensions.css.cell` (private API)
- **xterm.js v7+**: `terminal.dimensions.css.cell` (public API, auto-detected)

### Prompt Column Locking

When flushed text exists, the prompt column is locked to prevent jitter from full-screen redraws. Row changes are allowed (output can scroll the prompt).

### Scroll Awareness

Overlay hides when scrolled up (`viewportY !== baseY`). Debounced re-render when scrolling back to bottom.

---

## Known Limitations

- **Canvas/WebGL font mismatch**: Minor sub-pixel differences possible. Per-character absolute positioning minimizes this.
- **Unicode/emoji**: Multi-byte characters occupy variable cell widths — rendered at single-cell width, causing misalignment.
- **Password prompts**: Overlay shows characters that aren't echoed. Call `clear()` when you detect no-echo mode.
- **Prompt in output**: If `$` appears in command output, prompt detection may find the wrong position. Use regex or custom finder.

---

## License

MIT — [Codeman](https://github.com/Ark0N/Codeman) Contributors
