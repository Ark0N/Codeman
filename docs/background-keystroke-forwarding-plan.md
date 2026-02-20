# Plan: Background Keystroke Forwarding (Local Echo Mode)

## Problem

When local echo is enabled, keystrokes accumulate **only** in `LocalEchoOverlay.pendingText` (a client-side string). Nothing reaches the server PTY until Enter is pressed. This creates three failure modes:

1. **Tab switch loses PTY state** — switching sessions saves overlay text to `localEchoTextCache` (a Map), but the actual Claude Code Ink process has no knowledge of what was typed. If respawn or `/clear` fires on that session, the cached text is meaningless.
2. **Session death loses input** — if the session crashes or respawns while text is pending in the overlay, that input is gone (localStorage backup `claudeman_local_echo_pending` only survives page reloads, not session resets).
3. **Tab completion impossible** — pressing Tab with pending overlay text sends the raw Tab character to a PTY that has no knowledge of the typed text, so completion fails.

## Goal

Send every keystroke to the server in the background (debounced), while the overlay continues providing instant visual feedback. The overlay sits at z-index 7 with an opaque background over `.xterm-screen`, masking Ink's echo of the background-sent characters. Input persists in the actual Claude Code readline buffer across tab switches and respawns.

## Architecture

```
User keystroke
      |
      v
xterm.js onData(data)
      |
      +---> LocalEchoOverlay.addChar(data)     [instant visual feedback]
      |
      +---> _localEchoBgBuffer += data          [queue for background send]
      |     clearTimeout + setTimeout(50ms)
      |            |
      |            v  (50ms debounce fires)
      |     _flushBgInput()
      |            |
      |            v
      |     _sendInputAsync(sessionId, buffer)  [promise chain preserves order]
      |            |
      |            v
      |     POST /api/sessions/:id/input        [{ input: "hel" }]
      |            |
      |            v
      |     session.write(inputStr)             [direct PTY write, synchronous]
      |            |
      |            v
      |     Ink readline echoes "hel"           [hidden behind overlay's opaque bg]
      |
      +--- On Enter:
             1. clearTimeout(_localEchoBgTimer)
             2. flush _localEchoBgBuffer via _sendInputAsync  (remaining chars)
             3. clear overlay
             4. 120ms later: send \r via _sendInputAsync      (Ink text/Enter split)
             5. Ink processes "hello\r" → overlay gone, terminal visible with output
```

### Two Input Paths (important context)

The codebase has **two separate input paths** to the server:

| Path | Used by | Promise chain? | `useMux`? |
|------|---------|---------------|-----------|
| `_sendInputAsync()` (line 3626) | `onData` handler, `flushInput()` | Yes (`_inputSendChain`) | No (direct PTY write) |
| `sendInput()` (line 8755) | Mobile accessory bar, programmatic commands | **No** (raw `fetch`) | Yes (tmux `send-keys`) |

Background keystroke forwarding uses **only** the `_sendInputAsync` path, which guarantees ordering via the promise chain. The `sendInput()` path is unaffected and unmodified.

### Server-Side Input Flow

```
POST /api/sessions/:id/input  { input: "hel" }
      |
      +-- useMux? No (default)
      |     session.write("hel")          → ptyProcess.write("hel")  [sync]
      |
      +-- useMux? Yes
            session.writeViaMux("hel")    → tmux send-keys -l "hel"  [async]
```

Background sends use the default path (no `useMux`), which is a synchronous direct PTY write — faster than spawning a tmux subprocess for each character batch.

## Implementation

All changes in **one file**: `src/web/public/app.js`

### Step 1: Add background send state (in terminal setup, after line ~1999)

```js
this._localEchoBgBuffer = '';   // Characters queued for background send
this._localEchoBgTimer = null;  // 50ms debounce timer ID
```

Add an atomic drain helper alongside existing `flushInput` (after line ~2008):

```js
// Atomically drain background buffer — returns contents and cancels pending timer.
// Single point of extraction prevents double-flush race conditions.
const drainBgBuffer = () => {
    if (this._localEchoBgTimer) {
        clearTimeout(this._localEchoBgTimer);
        this._localEchoBgTimer = null;
    }
    const buf = this._localEchoBgBuffer;
    this._localEchoBgBuffer = '';
    return buf;
};

const scheduleBgFlush = () => {
    if (this._localEchoBgTimer) clearTimeout(this._localEchoBgTimer);
    this._localEchoBgTimer = setTimeout(() => {
        this._localEchoBgTimer = null;
        const buf = this._localEchoBgBuffer;
        this._localEchoBgBuffer = '';
        if (buf && this.activeSessionId) {
            this._sendInputAsync(this.activeSessionId, buf);
        }
    }, 50);
};
```

**Why `drainBgBuffer` exists**: Every exit path (Enter, Ctrl+C, tab switch, echo disable) needs to flush the buffer AND cancel the timer atomically. Without a single extraction point, it's easy to forget one of the two operations, leading to double-sends when the timer fires after a manual flush.

### Step 2: Modify `onData` handler — local echo path (lines 2023–2067)

**Printable characters** (lines 2063–2067 → replace):
```js
if (data.length === 1 && data.charCodeAt(0) >= 32) {
    this._localEchoOverlay?.addChar(data);
    // Background: queue char for server send (50ms debounce batches rapid typing)
    this._localEchoBgBuffer += data;
    scheduleBgFlush();
    return;
}
```

**Backspace** (lines 2024–2028 → replace):
```js
if (data === '\x7f') {
    this._localEchoOverlay?.removeChar();
    // Background: queue DEL for server (Ink's readline handles backspace via \x7f)
    this._localEchoBgBuffer += '\x7f';
    scheduleBgFlush();
    return;
}
```

**Enter** (lines 2029–2050 → replace):
```js
if (/^[\r\n]+$/.test(data)) {
    this._localEchoOverlay?.clear();
    if (this._inputFlushTimeout) {
        clearTimeout(this._inputFlushTimeout);
        this._inputFlushTimeout = null;
    }
    // Flush any remaining background chars (e.g., last 50ms batch not yet sent)
    const remaining = drainBgBuffer();
    if (remaining) {
        this._sendInputAsync(this.activeSessionId, remaining);
    }
    // Send \r after 120ms — Ink needs text and Enter as separate events.
    // The promise chain in _sendInputAsync guarantees the remaining chars
    // are dispatched before \r, regardless of timing.
    setTimeout(() => {
        this._pendingInput += '\r';
        flushInput();
    }, 120);
    return;
}
```

**Key change from original plan**: The Enter handler no longer checks `if (text)` and branches on whether the overlay had content. With background sends, the PTY already has most/all of the text. We just flush any remainder and unconditionally send `\r` after 120ms. This simplifies the flow and handles edge cases like "user typed nothing but pressed Enter" (remainder is empty, just `\r` is sent).

**Control characters and paste** (lines 2052–2061 → replace):
```js
if (data.charCodeAt(0) < 32 || data.length > 1) {
    this._localEchoOverlay?.clear();
    // Flush background buffer so PTY has full text state before control char
    // (critical for Tab completion — PTY needs typed text to complete against)
    const remaining = drainBgBuffer();
    if (remaining) {
        this._sendInputAsync(this.activeSessionId, remaining);
    }
    // Send control char / paste text via normal path
    this._pendingInput += data;
    if (this._inputFlushTimeout) {
        clearTimeout(this._inputFlushTimeout);
        this._inputFlushTimeout = null;
    }
    flushInput();
    return;
}
```

**Note on paste**: Desktop paste arrives via `onData` as a single multi-character string (`data.length > 1`). This falls into the control char path above, which:
1. Clears the overlay (existing behavior)
2. Flushes background buffer (new — ensures PTY has prefix text)
3. Sends paste text immediately (existing behavior)

Mobile paste via `KeyboardAccessoryBar.pasteFromClipboard()` uses `app.sendInput()` which bypasses `onData` entirely — no change needed.

### Step 3: Flush on tab switch (`selectSession()`, line ~4533)

Insert before the existing overlay save/clear block (before line 4534):

```js
// Flush background send buffer for outgoing session
if (this.activeSessionId) {
    const remaining = drainBgBuffer();
    if (remaining) {
        this._sendInputAsync(this.activeSessionId, remaining);
    }
}
```

This ensures the PTY receives all typed characters before the tab switch. When the user switches back, the terminal buffer will show the text (echoed by Ink) and the overlay will restore its cached copy on top.

### Step 4: Cleanup on local echo disable (`_updateLocalEchoState()`, lines 2362–2371)

Expand the disable transition (line 2367–2368):
```js
if (this._localEchoEnabled && !shouldEnable) {
    this._localEchoOverlay?.clear();
    // Flush any pending background chars before disabling
    const remaining = drainBgBuffer();
    if (remaining && this.activeSessionId) {
        this._sendInputAsync(this.activeSessionId, remaining);
    }
}
```

### Step 5: Cleanup on session delete (`deleteSession()`)

When a session is deleted, cancel any pending background timer for that session:
```js
// In deleteSession(), after removing the session from this.sessions:
drainBgBuffer();  // Discard — session is gone, nowhere to send
this.localEchoTextCache.delete(sessionId);
```

## Visual Timeline

```
t=0ms     User types "h"     → overlay: "h"     bgBuffer: "h"     timer: 50ms
t=30ms    User types "e"     → overlay: "he"    bgBuffer: "he"    timer: reset 50ms
t=60ms    User types "l"     → overlay: "hel"   bgBuffer: "hel"   timer: reset 50ms
t=110ms   Debounce fires     → overlay: "hel"   bgBuffer: ""      POST "hel" → PTY
t=115ms   Ink echoes "hel"   → terminal: "❯ hel" (hidden behind overlay)
t=140ms   User types "l"     → overlay: "hell"  bgBuffer: "l"     timer: 50ms
t=170ms   User types "o"     → overlay: "hello" bgBuffer: "lo"    timer: reset 50ms
t=220ms   Debounce fires     → overlay: "hello" bgBuffer: ""      POST "lo" → PTY
t=250ms   User hits Enter    → drainBgBuffer()=""  overlay: cleared
t=370ms   \r sent via chain  → Ink processes "hello\r" → output appears
```

**Tab switch scenario:**
```
t=0ms     User types "wor"   → overlay: "wor"   bgBuffer: "wor"   timer: 50ms
t=25ms    User switches tab  → drainBgBuffer() sends "wor" to old session PTY
                                overlay text "wor" saved to localEchoTextCache
                                overlay cleared, new session loaded
...later...
t=5000ms  User switches back → terminal shows "❯ wor" (Ink echo from background send)
                                overlay restores "wor" from cache, masks terminal
                                user continues typing seamlessly
```

## Edge Cases & Mitigations

### Confirmed Safe (JS single-threaded guarantee)

| Scenario | Why it's safe |
|----------|--------------|
| **Debounce fires during Enter handler** | Impossible. JS event loop is single-threaded — the Enter handler runs atomically. `drainBgBuffer()` cancels the timer before it can fire. |
| **Debounce fires during tab switch** | Same reason. `selectSession()` calls `drainBgBuffer()` synchronously, canceling the timer. |
| **Double-send of background buffer** | `drainBgBuffer()` atomically clears both buffer and timer. Once drained, subsequent drain returns empty string. |
| **`_pendingInput` conflict** | In local echo mode, `_pendingInput` is only used for Enter (`\r`) and control chars. Background chars use a separate `_localEchoBgBuffer`. No overlap. |

### Handled by Design

| Scenario | Handling |
|----------|---------|
| **Rapid typing / paste** | 50ms debounce batches rapid chars. At 100 WPM (~50ms/char), sends ~1 char per batch. For paste (multi-char string, `data.length > 1`), the control char path bypasses the buffer entirely and sends immediately. |
| **Network failure** | `_sendInputAsync` catches fetch failures and calls `_enqueueInput()` for retry. `_drainInputQueues()` replays on reconnect. Background chars use the same retry path. |
| **Offline mode** | `_sendInputAsync` checks `this.isOnline` and immediately enqueues if offline. Same behavior for background sends. 64KB queue cap prevents memory growth. |
| **Tab completion** | Ctrl+Tab path flushes background buffer BEFORE sending Tab char. PTY has full text for readline completion. |
| **Session respawn** | PTY already has typed text (sent in background). On respawn, Claude exits and restarts — Ink's readline buffer is lost, but the text was already processed or is no longer relevant. The overlay clears on session status change via `_updateLocalEchoState()`. |
| **SSE reconnect** | `handleInit()` saves overlay text before `selectSession()` clears it, then restores after reload (line ~3945–3966). Background buffer is cleared on reconnect since state is reset. |

### Network Ordering

**Question**: Can background sends arrive at the server out of order?

**Answer**: No, for practical purposes.

1. `_sendInputAsync` uses a **promise chain** (`_inputSendChain`) — each fetch is dispatched only after the previous one has been dispatched. This means requests are sent in order.
2. Localhost connections (HTTP/1.1) are inherently sequential on a single TCP connection.
3. Even with HTTP/2 multiplexing, Fastify (Node.js) is single-threaded — request handlers execute via the event loop in arrival order.
4. The server's `session.write()` is synchronous — it writes to the PTY immediately within the request handler.

### Known Limitations (Not Addressed)

| Limitation | Impact | Notes |
|-----------|--------|-------|
| **IME composition** | CJK input via IME would send partial composition sequences to PTY | No IME handling exists in the codebase today (line count: 0 references to `compositionstart/end/update`). Fixing this is a separate feature. |
| **`sendInput()` ordering** | Mobile accessory bar commands (`/init`, `/clear`, paste) use `sendInput()` which bypasses `_inputSendChain` — no ordering guarantee relative to background sends | Unlikely to conflict in practice: accessory bar clears the overlay first, and the commands are typically sent when no typing is in progress. |
| **localStorage stale text** | After background sends, localStorage still has overlay text. On hard reload, overlay restores text that the PTY already has → visual duplicate behind overlay | Harmless — overlay masks the terminal. On Enter, overlay clears and terminal shows correct state. Could be fixed by clearing localStorage after successful background flush, but adds complexity for minimal benefit. |

## Verification Checklist

1. **Basic typing**: Enable local echo → type "hello" → overlay shows instantly → check Network tab for batched POST requests (~50ms intervals) → press Enter → command executes
2. **Tab switch persistence**: Type "test" → switch to another tab → switch back → text visible in both overlay AND terminal prompt
3. **Backspace**: Type "helloo" → press backspace → overlay shows "hello" → check PTY received \x7f
4. **Paste**: Type "hel" → paste "lo world" → overlay clears → "lo world" sent immediately → PTY has "hello world"
5. **Tab completion**: Type "src/w" → press Tab → PTY completes to "src/web/" (background send gave PTY the prefix)
6. **Ctrl+C**: Type "hello" → press Ctrl+C → overlay clears → PTY receives pending chars + \x03
7. **Network tab**: Verify POST /api/sessions/:id/input requests appear as you type (batched ~50ms)
8. **Offline resilience**: Disconnect network → type "hello" → reconnect → verify chars are replayed via drain queue
9. **Session delete**: Type text → delete session → no console errors from orphaned timer
10. **Mobile keyboard**: Test on mobile device — typing goes through same onData path, same behavior expected

## Files Modified

| File | Changes |
|------|---------|
| `src/web/public/app.js` | ~40 lines changed across 5 locations (Steps 1–5) |

No server-side changes. No new files. No new dependencies.
