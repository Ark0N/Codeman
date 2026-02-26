# Terminal Anti-Flicker System

Claude Code uses [Ink](https://github.com/vadimdemedes/ink) (React for terminals), which redraws the entire screen on every state change. Without special handling, users see constant flickering. Codeman implements a 6-layer anti-flicker pipeline.

## Pipeline Overview

```
PTY Output → Server Batching → DEC 2026 Wrap → SSE → Client rAF → Sync Parser → xterm.js
```

| Layer | Location | Technique | Latency |
|-------|----------|-----------|---------|
| **1. Server Batching** | `server.ts:batchTerminalData()` | Adaptive 16-50ms collection window | 16-50ms |
| **2. DEC Mode 2026** | `server.ts:flushTerminalBatches()` | Wraps with `\x1b[?2026h`...`\x1b[?2026l` | 0ms |
| **3. SSE Broadcast** | `server.ts:broadcast()` | JSON serialize once, send to all clients | 0ms |
| **4. Client rAF** | `app.js:batchTerminalWrite()` | `requestAnimationFrame` batching | 0-16ms |
| **5. Sync Block Parser** | `app.js:extractSyncSegments()` | Strips DEC 2026 markers, waits for complete blocks | 0-50ms |
| **6. Chunked Loading** | `app.js:chunkedTerminalWrite()` | 64KB/frame for large buffers | variable |

## Server-Side Implementation (`server.ts`)

### Constants

```typescript
const TERMINAL_BATCH_INTERVAL = 16;      // Base: 60fps
const BATCH_FLUSH_THRESHOLD = 32 * 1024; // Flush immediately if >32KB
const DEC_SYNC_START = '\x1b[?2026h';    // Begin synchronized update
const DEC_SYNC_END = '\x1b[?2026l';      // End synchronized update
```

### Adaptive Batching (`batchTerminalData()`)

- Tracks event frequency per session via `lastTerminalEventTime` Map
- Event gap <10ms → 50ms batch window (rapid-fire Ink redraws)
- Event gap <20ms → 32ms batch window
- Otherwise → 16ms (60fps)
- Flushes immediately if batch exceeds 32KB for responsiveness

### Flush Logic (`flushTerminalBatches()`)

```typescript
const syncData = DEC_SYNC_START + data + DEC_SYNC_END;
this.broadcast('session:terminal', { id: sessionId, data: syncData });
```

## Client-Side Implementation (`app.js`)

### `batchTerminalWrite(data)`

1. Checks if flicker filter is enabled (optional, per-session)
2. If flicker filter active: buffers screen-clear patterns (`ESC[2J`, `ESC[H ESC[J`, `ESC[nA`)
3. Accumulates data in `pendingWrites`
4. Schedules `requestAnimationFrame` if not already scheduled
5. On rAF callback: checks for incomplete sync blocks (start without end)
6. If incomplete: waits up to 50ms via `syncWaitTimeout`
7. Calls `flushPendingWrites()` when complete

### `extractSyncSegments(data)`

- Parses DEC 2026 markers, returns array of content segments
- Content before sync blocks returned as-is
- Content inside sync blocks returned without markers
- Incomplete blocks (start without end) returned with marker for next chunk

### `flushPendingWrites()`

```javascript
const segments = extractSyncSegments(this.pendingWrites);
this.pendingWrites = '';  // Clear before writing
for (const segment of segments) {
  if (segment && !segment.startsWith(DEC_SYNC_START)) {
    terminal.write(segment);  // Skip incomplete blocks (start with marker)
  }
}
```

Note: Segments starting with `DEC_SYNC_START` are incomplete blocks awaiting more data. These are skipped (discarded if timeout forces flush).

### `chunkedTerminalWrite(buffer, chunkSize=128KB)`

- For large buffer restoration (session switch, reconnect)
- Writes 128KB per `requestAnimationFrame` to avoid UI jank
- Strips any embedded DEC 2026 markers from historical data

### `selectSession()` Optimizations

- Starts buffer fetch immediately before other setup
- Shows "Loading session..." indicator while fetching
- Parallelizes session attach with buffer fetch
- Fire-and-forget resize (doesn't block tab switch)

## Optional Flicker Filter

Per-session toggle via Session Settings. Adds ~50ms latency but eliminates remaining flicker on problematic terminals.

### Detection Patterns

- `ESC[2J` — Clear entire screen
- `ESC[H ESC[J` — Cursor home + clear to end
- `ESC[?25l ESC[H` — Hide cursor + home (Ink pattern)
- `ESC[nA` (n≥1) — Cursor up (Ink line redraw)

When detected, buffers 50ms of subsequent output before flushing atomically.

## Latency Analysis

| Source | Best Case | Worst Case | Notes |
|--------|-----------|------------|-------|
| Server batching | 0ms (flush) | 50ms (rapid events) | Immediate flush if >32KB |
| Sync block wait | 0ms | 50ms | Only if marker split across packets |
| Flicker filter | 0ms (disabled) | 50ms (enabled) | Optional per-session |
| rAF scheduling | 0ms | 16ms | Display refresh sync |
| **Total** | **0ms** | **~115ms** | Worst case rare in practice |

**Typical latency:** 16-32ms (server batch + rAF)

## Edge Cases

- **Incomplete sync blocks**: 50ms timeout forces flush (content discarded to prevent freeze)
- **Large buffers**: Chunked writing prevents UI freeze
- **Server shutdown**: Skips batching via `_isStopping` flag
- **Session switch**: Clears flicker filter state, pending writes, and sync timeout (prevents cross-session data bleed)
- **SSE reconnect**: `handleInit()` clears all pending write state

**Trade-off:** If a sync block is split across SSE packets and the end marker doesn't arrive within 50ms, the incomplete content is discarded. This prioritizes responsiveness over completeness. In practice this is rare since the server always sends complete `SYNC_START...SYNC_END` pairs and SSE typically delivers them atomically.

## DEC Mode 2026 Compatibility

Terminals that natively support DEC 2026 will buffer and render atomically. Terminals that don't support it ignore the escape sequences harmlessly. xterm.js doesn't support DEC 2026 natively, so the client implements its own buffering by parsing the markers.

**Supporting terminals:** WezTerm, Kitty, Ghostty, iTerm2 3.5+, Windows Terminal, VSCode terminal

## Files Involved

| File | Key Functions |
|------|---------------|
| `src/web/server.ts` | `batchTerminalData()`, `flushTerminalBatches()`, `broadcast()` |
| `src/web/public/app.js` | `batchTerminalWrite()`, `extractSyncSegments()`, `flushPendingWrites()`, `flushFlickerBuffer()`, `chunkedTerminalWrite()` |
