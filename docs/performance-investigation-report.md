# Codeman Performance Investigation Report

**Date**: 2026-02-20
**Scope**: Why Codeman feels sluggish when multiple Claude tabs are very busy
**Method**: 4-agent parallel analysis of server, PTY pipeline, frontend, and background systems

---

## Executive Summary

When multiple Claude sessions are actively producing heavy terminal output (e.g., building, writing files, running tests), Codeman's UI becomes sluggish. This investigation identified **14 bottlenecks** across 4 layers of the stack. The root cause is **cumulative event loop blocking** — no single operation is catastrophically slow, but dozens of small synchronous operations run on every PTY data chunk, and with N busy sessions producing chunks every few milliseconds, the event loop gets saturated.

The most impactful findings are ranked by severity below.

---

## Critical Findings (Event Loop Blockers)

### 1. PTY Data Handler Chain — O(output_volume) per session, synchronous
**File**: `src/session.ts:986-1086`
**Severity**: CRITICAL

Every chunk of PTY output from a busy Claude session runs through this synchronous chain on the Node.js event loop:

```
PTY onData → ANSI strip regex → ralph-tracker → bash-tool-parser →
             token parser → CLI info parser → task description parser →
             idle/working detection → emit('terminal') → emit('output')
```

**Key costs per chunk:**
- `ANSI_ESCAPE_PATTERN_FULL` regex (line 999): Complex regex with alternation, runs on every chunk where any consumer needs clean data
- `ralphTracker.processCleanData()` (line 1014): Splits into lines, runs regex per line, checks multi-line patterns
- `bashToolParser.processCleanData()` (line 1020): Similar line-by-line regex processing
- `parseTaskDescriptionsFromTerminalData()` (line 1038): Regex scan for parenthesized descriptions
- Working/idle detection (lines 1043-1085): Multiple `includes()` checks plus `getCleanData()` calls

**The lazy `getCleanData()` pattern (line 997-1002)** was a good optimization — it avoids ANSI stripping when no consumer needs it. But when Ralph tracking is enabled (common during active work), `getCleanData()` is called on every chunk, negating the optimization.

**With 5 busy sessions** producing 50+ chunks/second each, this means 250+ synchronous processing chains per second on the event loop. Each chain involves string allocation, regex matching, and line splitting.

### 2. Broadcast Serialization — JSON.stringify on every flush
**File**: `src/web/server.ts:4941-4967`
**Severity**: CRITICAL

The `broadcast()` method calls `JSON.stringify(data)` synchronously for every event. Terminal data is the highest-frequency event. During `flushTerminalBatches()` (line 5030), broadcast is called once per session with pending data. With 10 busy sessions flushing every 16-50ms, that's 200-625 `JSON.stringify` calls per second on terminal data alone.

The terminal data payload is a string that gets double-encoded: the raw terminal string is embedded inside a JSON object `{id, data}`, then that object is JSON.stringify'd. For large chunks (up to 32KB per the `BATCH_FLUSH_THRESHOLD`), this creates significant garbage collection pressure.

**Additionally**, the `session:updated` broadcast includes `toLightDetailedState()` which serializes `taskTree`, `tokens`, `bufferStats`, and `respawnConfig` — this is called on many state changes, not just terminal data.

### 3. Single-Timer Batching — All sessions share one setTimeout
**File**: `src/web/server.ts:5017-5027`
**Severity**: HIGH

The `batchTerminalData()` method uses a **single shared timer** (`this.terminalBatchTimer`) for all sessions. When the timer fires, `flushTerminalBatches()` iterates ALL pending sessions and broadcasts each one. This means:

- One extremely busy session's rapid data can force the timer to fire at the minimum interval (16ms), flushing ALL sessions at that rate
- The flush itself iterates all pending sessions synchronously
- The `_minBatchInterval` optimization (line 5003) means the fastest session dictates the timer for everyone

This creates a **thundering herd** effect: all session flushes happen in a single synchronous burst rather than being staggered.

### 4. State Persistence Storms
**File**: `src/web/server.ts:3879-3917`
**Severity**: HIGH

`persistSessionState()` is called from **28+ locations** in server.ts. Each call sets a 100ms debounce timer per session. During heavy activity, this means:

- Frequent timer creation/cancellation (GC pressure)
- The actual persist (`_persistSessionStateNow`) calls `session.toState()` which creates a new object, then `store.setSession()` which triggers `JSON.stringify` of the entire state store and `writeFileSync` to disk

The `StateStore` (via `state-store.ts`) debounces its own write, but the overhead is in the per-session `toState()` serialization and object creation, not just the disk write.

---

## High-Severity Findings

### 5. Ralph Tracker Line Processing — O(lines) per chunk
**File**: `src/ralph-tracker.ts:1337-1375`
**Severity**: HIGH (when Ralph tracking is enabled)

When enabled, `processCleanData()`:
1. Appends to a line buffer (string concatenation)
2. Splits on `\n` (creates array)
3. Calls `processLine()` on each line (regex matching per line)
4. Calls `checkMultiLinePatterns()` (additional regex on full chunk)
5. Calls `maybeCleanupExpiredTodos()` (iterates todos Map)

For a busy session producing 100+ lines/second, this is significant. The line buffer can grow up to `MAX_LINE_BUFFER_SIZE` before being truncated, and the split/iterate pattern creates garbage on every chunk.

### 6. Subagent Watcher Polling — O(agents) every 1-10 seconds
**File**: `src/subagent-watcher.ts:225-274`
**Severity**: MEDIUM-HIGH

Three periodic operations:
- **Poll interval** (1s): Lightweight check, but full directory scan every 5th poll (5s)
- **Liveness check** (10s): Runs `pgrep` (child process spawn), then iterates ALL tracked agents to check if alive. With 50+ subagents (common with agent teams), this is a non-trivial burst.
- **File watchers**: One `chokidar` watcher per tracked agent directory, plus transcript file watchers. With many agents, this means many active file watchers consuming kernel inotify resources.

The `getClaudePids()` call spawns a child process (`pgrep`) every 10 seconds. Under heavy load, child process spawning competes with the event loop.

### 7. SSE Client Iteration — O(clients) per broadcast
**File**: `src/web/server.ts:4964-4966`
**Severity**: MEDIUM

Every `broadcast()` iterates all SSE clients to send the pre-formatted message. With multiple browser tabs or mobile clients, each flush sends data to every client. The `reply.raw.write()` call goes through Node's HTTP stream, which is generally non-blocking but can cause backpressure cascades.

The backpressure handling (line 4916-4938) correctly skips backpressured clients, but the `once('drain')` handler sends a `session:needsRefresh` event, which the client responds to by fetching the full buffer — potentially a 2MB request — amplifying the problem.

### 8. Event Emitter Fan-Out in Session
**File**: `src/session.ts:1008-1009`
**Severity**: MEDIUM

Every PTY data chunk emits TWO events: `terminal` and `output`. The `terminal` event triggers `batchTerminalData()` in server.ts. The `output` event may trigger additional handlers. EventEmitter dispatch is synchronous — all listeners run before the next operation in the PTY handler continues.

With busy sessions, this means every chunk blocks the event loop for: PTY processing + all terminal listeners + all output listeners.

---

## Medium-Severity Findings

### 9. Respawn Controller Timer Accumulation
**File**: `src/respawn-controller.ts` (various)
**Severity**: MEDIUM

Each session with respawn enabled runs multiple timers:
- Idle detection timeout
- AI checker interval (when active)
- Output silence detection interval
- Token stability interval
- Circuit breaker state timeouts

With 10 sessions with respawn, that's 50+ active timers. While individual timers are cheap, the cumulative effect on the event loop's timer queue is non-trivial — the libuv timer heap has O(log n) insertion but all callbacks run synchronously.

### 10. Team Watcher Polling
**File**: `src/team-watcher.ts`
**Severity**: MEDIUM (when agent teams are active)

Polls `~/.claude/teams/` directory every few seconds. Each poll reads config.json files and task files. With active teams, this adds filesystem reads to the event loop's I/O budget.

### 11. Frontend Terminal Write Batching
**File**: `src/web/public/app.js` (batchTerminalWrite/flushPendingWrites)
**Severity**: MEDIUM

The frontend batches terminal writes at `requestAnimationFrame` rate (16ms). When receiving SSE events from multiple busy sessions:
- `batchTerminalWrite()` is called for EVERY session's data, even sessions not currently displayed
- Terminal instances exist for all sessions (not just the active tab)
- Each `flushPendingWrites()` calls `terminal.write()` which triggers xterm.js rendering

Hidden tabs still process terminal writes, consuming CPU for rendering that's never displayed.

### 12. Frontend Connection Line Rendering
**File**: `src/web/public/app.js` (updateConnectionLines)
**Severity**: LOW-MEDIUM

Connection lines between parent/child agent windows are recalculated on window moves, resizes, and potentially on terminal writes. With many subagent windows open, this involves DOM reads (getBoundingClientRect) that force layout recalculation.

### 13. Image Watcher File System Events
**File**: `src/image-watcher.ts`
**Severity**: LOW

Uses chokidar to watch for image files in session working directories. With many sessions in the same or overlapping directories, watchers may generate redundant events. The `awaitWriteFinish` and burst throttling mitigate this, but the kernel inotify resources add up.

### 14. ANSI Escape Regex Complexity
**File**: `src/session.ts:999`
**Severity**: LOW (but cumulative)

`ANSI_ESCAPE_PATTERN_FULL` is a complex regex with multiple alternation branches. While V8's regex engine handles this well for typical terminal data, adversarial input (deeply nested escape sequences) could cause superlinear matching time. The `FOCUS_ESCAPE_FILTER` regex runs first on every chunk.

---

## Scaling Analysis

| Resource | Per Session | 10 Sessions | 20 Sessions |
|----------|-------------|-------------|-------------|
| PTY data handlers | 1 synchronous chain | 10 chains competing for event loop | 20 chains — event loop saturation likely |
| Broadcast calls (terminal only) | 20-60/sec | 200-600/sec | 400-1200/sec |
| JSON.stringify (terminal) | 20-60/sec | 200-600/sec | 400-1200/sec |
| Active timers | ~5 | ~50 | ~100 |
| File watchers (subagents) | 2-5 | 20-50 | 40-100 |
| SSE writes per flush | N clients | N clients x 10 sessions | N clients x 20 sessions |
| Ralph line processing | O(lines/sec) | O(10 x lines/sec) | O(20 x lines/sec) |

**The critical threshold appears to be 5-8 simultaneously busy sessions**, where the cumulative PTY processing + broadcast serialization + timer callbacks start to exceed the event loop's capacity for responsive handling.

---

## Root Cause Architecture Diagram

```
 Busy Claude Session 1 ─┐
 Busy Claude Session 2 ─┤    ┌──────────────────────┐
 Busy Claude Session 3 ─┼───→│  Node.js Event Loop   │
 Busy Claude Session 4 ─┤    │  (SINGLE THREAD)      │
 Busy Claude Session 5 ─┘    │                        │
                              │  PTY handlers (sync)   │◄── BOTTLENECK 1
                              │  ANSI strip regex      │
                              │  Ralph tracker         │
                              │  Bash tool parser      │
                              │  Idle detection        │
                              │         │              │
                              │         ▼              │
                              │  EventEmitter.emit()   │◄── BOTTLENECK 2
                              │         │              │
                              │         ▼              │
                              │  batchTerminalData()   │
                              │  (shared timer)        │◄── BOTTLENECK 3
                              │         │              │
                              │         ▼              │
                              │  flushTerminalBatches() │
                              │  broadcast() per session│
                              │  JSON.stringify() each  │◄── BOTTLENECK 4
                              │  write() to N clients   │
                              │                        │
                              │  + persistSessionState  │◄── BOTTLENECK 5
                              │  + respawn timers       │
                              │  + subagent polling     │
                              │  + team watcher         │
                              └────────────────────────┘
```

---

## Recommendations (Not Implemented — For Discussion)

### Tier 1: Highest Impact, Lowest Risk
1. **Disable processing for non-visible sessions**: Skip Ralph tracking, bash tool parsing, and task description parsing for sessions that no active SSE client is viewing. Only buffer terminal data.
2. **Per-session flush staggering**: Instead of one shared timer flushing all sessions, use individual timers offset by `index * (interval/N)` to spread flushes across the batch window.
3. **Skip hidden tab terminal writes on frontend**: Don't call `terminal.write()` for terminals not in the active tab. Lazy-load on tab switch.

### Tier 2: Medium Impact
4. **Worker thread for ANSI stripping and parsing**: Move the regex-heavy ANSI strip + Ralph parsing to a worker thread pool. PTY data → worker → clean data back to main thread.
5. **Pre-formatted SSE messages for terminal data**: Since terminal events are just `{id, data}`, build the SSE message string directly without `JSON.stringify`.
6. **Adaptive processing based on load**: When event loop lag exceeds a threshold (measured via `setTimeout(0)` drift), reduce processing — skip Ralph, increase batch intervals, reduce subagent poll frequency.

### Tier 3: Longer-Term Architectural
7. **Process-per-session or cluster mode**: Move each session's PTY handling to a separate Node.js worker or process, communicating to the main server via IPC.
8. **Binary protocol for terminal data**: Replace JSON-encoded SSE terminal events with binary frames (e.g., MessagePack or raw binary WebSocket frames) to eliminate double-encoding.
9. **Selective SSE subscriptions**: Clients subscribe to specific sessions instead of receiving all events. The server only broadcasts to interested clients.

---

## How to Validate

To confirm these findings, instrument with:
```typescript
// Add to event loop — measures how long synchronous work takes
let lastCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastCheck - 100; // 100ms interval
  if (lag > 10) console.log(`[PERF] Event loop lag: ${lag}ms`);
  lastCheck = now;
}, 100);
```

And in `flushTerminalBatches()`:
```typescript
const start = performance.now();
// ... existing flush logic ...
const elapsed = performance.now() - start;
if (elapsed > 5) console.log(`[PERF] Flush took ${elapsed.toFixed(1)}ms for ${this.terminalBatches.size} sessions`);
```

This will show exactly when and how much the event loop is being blocked during heavy session activity.
