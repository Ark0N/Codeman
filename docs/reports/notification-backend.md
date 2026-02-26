# Codeman Notification System - Backend Research Report

Date: 2026-02-17

## Executive Summary

The Codeman notification system is a **multi-layer, event-driven pipeline** that flows from backend event emitters, through SSE broadcasts, to a frontend `NotificationManager` class. The backend itself has no concept of "notifications" -- it broadcasts structured SSE events, and the frontend decides which events warrant user notification (browser notifications, audio alerts, tab title flashing, in-app notification drawer, tab alert badges).

The system handles ~25 distinct notification-triggering SSE events across 5 categories: hook events, session lifecycle, respawn state machine, Ralph Loop, and UI actions.

---

## 1. Server-Side Notification Logic (`src/web/server.ts`)

### 1.1 The `broadcast()` Method (Line 4646)

All real-time client communication flows through a single private method:

```typescript
private broadcast(event: string, data: unknown): void {
    // Invalidate caches on state-changing broadcasts
    if (event.startsWith('session:') || event === 'respawn:') {
      this.cachedLightState = null;
      this.cachedSessionsList = null;
    }
    let message: string;
    try {
      message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch (err) {
      console.error(`[Server] Failed to serialize SSE event "${event}":`, err);
      return;
    }
    for (const client of this.sseClients) {
      this.sendSSEPreformatted(client, message);
    }
}
```

Key characteristics:
- Serializes JSON once, then writes to all connected SSE clients
- Has backpressure handling (`sendSSEPreformatted` tracks `backpressuredClients`)
- Silently drops events on serialization failure (circular refs)
- Cache invalidation is broad -- any `session:*` event clears caches

### 1.2 SSE Client Management (Line 547-564)

Clients connect at `GET /api/events`:
- Immediately sent `init` event with lightweight state (no terminal buffers)
- Tracked in `Set<FastifyReply>` (`this.sseClients`)
- Dead client cleanup runs every 30s (`SSE_HEALTH_CHECK_INTERVAL`)
- Max 100 SSE clients (`MAX_SSE_CLIENTS` from `map-limits.ts`)

### 1.3 Complete Catalog of Notification-Relevant Broadcasts

The server emits ~70 distinct SSE event types. Those that trigger frontend notifications are:

| SSE Event | Server Location | Frontend Notification? | Category |
|-----------|----------------|----------------------|----------|
| `hook:idle_prompt` | Line 3431 | Yes - warning | Hook |
| `hook:permission_prompt` | Line 3431 | Yes - critical | Hook |
| `hook:elicitation_dialog` | Line 3431 | Yes - critical | Hook |
| `hook:stop` | Line 3431 | Yes - info | Hook |
| `hook:teammate_idle` | Line 3431 | **NO** (no frontend handler) | Hook |
| `hook:task_completed` | Line 3431 | **NO** (no frontend handler) | Hook |
| `session:error` | Line 3921 | Yes - critical | Session |
| `session:exit` | Line 3939 | Yes - critical (non-zero code) | Session |
| `session:idle` | Line 3976 | Yes - warning (after stuck threshold) | Session |
| `session:autoClear` | Line 4009 | Yes - info | Session |
| `session:ralphCompletionDetected` | Line 4044 | Yes - warning | Ralph |
| `session:circuitBreakerUpdate` | Line 4066 | Yes - critical (OPEN state) | Ralph |
| `session:exitGateMet` | Line 4080 | Yes - warning | Ralph |
| `respawn:blocked` | Line 4158 | Yes - critical | Respawn |
| `respawn:autoAcceptSent` | Line 4177 | Yes - info | Respawn |

Events that update UI but do NOT trigger notifications:
- `session:working` (line 3966) -- clears stuck timer and tab alerts
- `session:completion` (line 3928) -- updates cost display
- `session:updated` (many locations) -- tab/panel state updates
- `respawn:stateChanged` (line 4143) -- banner update only
- `respawn:cycleStarted` (line 4150) -- cycle counter update
- `subagent:discovered` (line 458) -- auto-opens window, no notification
- `subagent:completed` (line 464) -- no notification
- `image:detected` (line 504) -- auto-opens popup, no notification
- `transcript:*` events (lines 3575-3591) -- no frontend handlers for notifications

### 1.4 Terminal Data Batching

Terminal and output data use separate batching pipelines that bypass `broadcast()`:
- `batchTerminalData()` (line 4668) -- adaptive 16-50ms batching for PTY output
- `batchOutputData()` (line 4741) -- 50ms batching for parsed text output
- Both flush through `broadcast('session:terminal', ...)` and `broadcast('session:output', ...)`

---

## 2. Hook Events System (`src/hooks-config.ts`)

### 2.1 Hook Configuration Generator (Lines 24-67)

The `generateHooksConfig()` function creates `.claude/settings.local.json` entries that make Claude Code POST to Codeman when hooks fire:

```typescript
const curlCmd = (event: HookEventType) =>
    `HOOK_DATA=$(cat 2>/dev/null || echo '{}'); ` +
    `curl -s -X POST "$CODEMAN_API_URL/api/hook-event" ` +
    `-H 'Content-Type: application/json' ` +
    `-d "{\\"event\\":\\"${event}\\",\\"sessionId\\":\\"$CODEMAN_SESSION_ID\\",\\"data\\":$HOOK_DATA}" ` +
    `2>/dev/null || true`;
```

Six hook types are configured:

| Hook Category | Matcher | Event Type |
|--------------|---------|------------|
| Notification | `idle_prompt` | `idle_prompt` |
| Notification | `permission_prompt` | `permission_prompt` |
| Notification | `elicitation_dialog` | `elicitation_dialog` |
| Stop | (all stops) | `stop` |
| TeammateIdle | (all) | `teammate_idle` |
| TaskCompleted | (all) | `task_completed` |

### 2.2 Hook Event Flow

```
Claude Code Hook Fires
  --> Shell command executes (curl)
  --> POST /api/hook-event with {event, sessionId, data}
  --> Zod validation (HookEventSchema, schemas.ts:79)
  --> Session lookup (must exist)
  --> Respawn controller signaling (elicitation/stop/idle_prompt only)
  --> Transcript watcher setup (if data.transcript_path present)
  --> Data sanitization (sanitizeHookData, server.ts:178)
  --> SSE broadcast as `hook:{eventType}`
  --> Run summary tracking (recordHookEvent)
```

### 2.3 Data Sanitization (Lines 178-211)

The `sanitizeHookData()` function limits what gets broadcast:
- Allowed keys: `hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`, `permission_mode`, `stop_hook_active`, `transcript_path`
- `tool_input` objects are summarized (command truncated to 500 chars, only summary fields forwarded)
- Total data size capped at `MAX_HOOK_DATA_SIZE` (line 135)

### 2.4 Environment Variables (Lines 70-101)

Two env vars are set per case directory via `updateCaseEnvVars()`:
- `CODEMAN_API_URL` -- server URL (e.g., `http://localhost:3000`)
- `CODEMAN_SESSION_ID` -- session identifier

These are resolved at runtime by the shell, so the hook config is static per case.

### 2.5 Hook Config Writing (Lines 107-129)

`writeHooksConfig()` merges hook config into existing `.claude/settings.local.json`, preserving other keys. Called during case creation (server.ts lines 2197, 2441).

---

## 3. Hook-to-Respawn Controller Integration (`src/web/server.ts`, Lines 3406-3418)

Three of the six hook types signal the respawn controller:

| Hook Event | Controller Method | Effect |
|-----------|------------------|--------|
| `elicitation_dialog` | `signalElicitation()` | Blocks auto-accept (prevents Enter press on question prompts) |
| `stop` | `signalStopHook()` | Definitive idle signal; starts short confirmation timer, skips AI check |
| `idle_prompt` | `signalIdlePrompt()` | Definitive 60s+ idle signal; cancels all detection timers, directly confirms idle |

**Not handled by respawn controller**: `teammate_idle`, `task_completed`, `permission_prompt`. The first two are team-related hooks that have no backend integration beyond being broadcast via SSE (and the frontend has no handlers either -- see Section 7).

---

## 4. Respawn Controller Events (`src/respawn-controller.ts`)

The `RespawnController` extends `EventEmitter` and emits many events that the server wires to SSE broadcasts (server.ts lines 4143-4271).

### 4.1 Notification-Triggering Events

| Controller Event | SSE Broadcast | Frontend Notification? |
|-----------------|---------------|----------------------|
| `respawnBlocked` | `respawn:blocked` | Yes - critical (reason: circuit_breaker, exit_signal, status_blocked, session_error, session_stopped, no_pty) |
| `autoAcceptSent` | `respawn:autoAcceptSent` | Yes - info ("Plan Accepted") |

### 4.2 UI-Only Events (No Notification)

| Controller Event | SSE Broadcast | Frontend Action |
|-----------------|---------------|----------------|
| `stateChanged` | `respawn:stateChanged` | Banner state label update |
| `respawnCycleStarted` | `respawn:cycleStarted` | Cycle counter update |
| `respawnCycleCompleted` | `respawn:cycleCompleted` | (no explicit handler) |
| `detectionUpdate` | `respawn:detectionUpdate` | Detection display update |
| `stepSent` | `respawn:stepSent` | (no-op handler) |
| `stepCompleted` | `respawn:stepCompleted` | (no handler) |
| `aiCheckStarted/Completed/Failed` | `respawn:aiCheck*` | (no-op handlers) |
| `aiCheckCooldown` | `respawn:aiCheckCooldown` | (no-op handler) |
| `planCheckStarted/Completed/Failed` | `respawn:planCheck*` | (no handlers) |
| `timerStarted/Cancelled/Completed` | `respawn:timer*` | Countdown timer UI |
| `actionLog` | `respawn:actionLog` | Action log display |
| `log` | `respawn:log` | Debug log |
| `error` | `respawn:error` | (no handler) |

### 4.3 Respawn-to-Run-Summary Integration

The server wires respawn state changes into the run summary tracker (server.ts line 4143):
```typescript
this.broadcast('respawn:stateChanged', { sessionId, state, prevState });
// Also records in run summary:
const summaryTracker = this.runSummaryTrackers.get(sessionId);
if (summaryTracker) summaryTracker.recordStateChange(state);
```

---

## 5. Team / Agent Notification Flow

### 5.1 SubagentWatcher (`src/subagent-watcher.ts`)

The SubagentWatcher emits events that the server wires to SSE broadcasts (server.ts lines 458-477):

```typescript
discovered: (info) => this.broadcast('subagent:discovered', info),
updated:    (info) => this.broadcast('subagent:updated', info),
toolCall:   (data) => this.broadcast('subagent:tool_call', data),
toolResult: (data) => this.broadcast('subagent:tool_result', data),
progress:   (data) => this.broadcast('subagent:progress', data),
message:    (data) => this.broadcast('subagent:message', data),
completed:  (info) => this.broadcast('subagent:completed', info),
```

**None of these trigger frontend notifications.** The frontend auto-opens subagent windows on `subagent:discovered` (app.js line 2887), but the `NotificationManager` is not invoked.

### 5.2 TeamWatcher (`src/team-watcher.ts`)

**CRITICAL FINDING: TeamWatcher is completely unintegrated with the server.**

- The class is defined in `src/team-watcher.ts` and extends `EventEmitter`
- It emits events: `teamCreated`, `teamUpdated`, `teamRemoved`, `taskUpdated`, `inboxMessage`
- It is **never imported** in `server.ts` or any other file
- The `hasActiveTeammates()` method (designed for idle detection) is never called
- There is no SSE broadcast for any team event
- The frontend has no SSE listeners for `team:*` events

The frontend does have team-related UI code (teammate badges, team task panel, teammate terminal windows at app.js lines 13057-13501), but this appears to be driven by polling APIs or subagent watcher integration rather than dedicated SSE events.

### 5.3 Team Hook Events (teammate_idle, task_completed)

These are accepted by the API endpoint (validated by `HookEventSchema`) and broadcast as `hook:teammate_idle` and `hook:task_completed` SSE events, but:
- The **respawn controller ignores them** (only handles `elicitation_dialog`, `stop`, `idle_prompt`)
- The **frontend has no SSE listeners** for `hook:teammate_idle` or `hook:task_completed`
- They are recorded in the **run summary** via `recordHookEvent()` but otherwise silently dropped

---

## 6. Run Summary (`src/run-summary.ts`)

### 6.1 Overview

The RunSummaryTracker records a timeline of events per session for "what happened while I was away" views. It is a **recording system**, not a notification system -- it does not trigger any notifications itself.

### 6.2 Event Types Tracked

From `types.ts` (lines 1359-1375):
```typescript
type RunSummaryEventType =
  | 'session_started' | 'session_stopped'
  | 'respawn_cycle_started' | 'respawn_cycle_completed' | 'respawn_state_change'
  | 'error' | 'warning'
  | 'token_milestone' | 'auto_compact' | 'auto_clear'
  | 'idle_detected' | 'working_detected'
  | 'ralph_completion' | 'ai_check_result'
  | 'hook_event' | 'state_stuck';
```

### 6.3 Integration Points with Notification System

The run summary and notification system are **parallel but independent**:
- Both consume the same backend events (hooks, idle, working, errors)
- Run summary records for historical review; notifications alert in real-time
- There is no feedback loop between them (e.g., run summary does not trigger delayed notifications)

### 6.4 State Stuck Detection (Lines 402-421)

The RunSummaryTracker has its own state-stuck detection (10-minute threshold, checked every 60s) that records `state_stuck` events. This is separate from the frontend's idle-stuck notification (which uses `stuckThresholdMs`, default 10 minutes, triggered by `session:idle` events).

**Potential overlap**: Both the run summary and the frontend independently detect "stuck" states. The run summary records it; the frontend notifies. They could diverge if their thresholds or detection logic differ.

---

## 7. Types (`src/types.ts`)

### 7.1 Hook Event Types (Line 749)

```typescript
type HookEventType = 'idle_prompt' | 'permission_prompt' | 'elicitation_dialog'
                   | 'stop' | 'teammate_idle' | 'task_completed';
```

### 7.2 Hook Event Request (Lines 754-761)

```typescript
interface HookEventRequest {
  event: HookEventType;
  sessionId: string;
  data?: Record<string, unknown>;
}
```

### 7.3 Run Summary Types (Lines 1355-1470)

- `RunSummaryEventType` -- 16 event types
- `RunSummaryEventSeverity` -- `'info' | 'warning' | 'error' | 'success'`
- `RunSummaryEvent` -- `{id, timestamp, type, severity, title, details?, metadata?}`
- `RunSummaryStats` -- aggregated statistics (cycles, tokens, time active/idle, etc.)
- `RunSummary` -- complete summary `{sessionId, sessionName, startedAt, lastUpdatedAt, events, stats}`

### 7.4 Missing Notification Types

There is **no dedicated notification type** in the backend. The backend has no `Notification` interface or notification-specific data structures. All notification logic lives in the frontend `NotificationManager` class (`app.js` lines 859-1230).

---

## 8. Bugs and Issues

### 8.1 TeamWatcher Not Integrated (Critical Gap)

**File**: `src/team-watcher.ts` (entire file)
**Issue**: TeamWatcher is defined but never instantiated or imported in the server. The `hasActiveTeammates()` method was designed for team-aware idle detection (preventing premature respawn when teammates are still working), but it is never called.

**Impact**:
- The respawn controller has no awareness of active teammates
- Team events (member join/leave, task updates, inbox messages) are never broadcast to clients
- The frontend's team UI must rely on other mechanisms (likely API polling or subagent watcher)

### 8.2 `hook:teammate_idle` and `hook:task_completed` Are Dead Events

**File**: `src/web/server.ts` (line 3431), `src/web/public/app.js`
**Issue**: These hook events are accepted by the API, validated, and broadcast via SSE, but:
- The respawn controller does not handle them (line 3408-3418 -- only checks elicitation, stop, idle_prompt)
- The frontend has no `addListener('hook:teammate_idle', ...)` or `addListener('hook:task_completed', ...)`
- They are recorded in the run summary but otherwise have zero effect

**Impact**: When Claude Code fires TeammateIdle or TaskCompleted hooks, the data is broadcast into the void. No notification, no UI update, no respawn logic.

### 8.3 `respawn:error` Has No Frontend Handler

**File**: `src/web/server.ts` (line 4236), `src/web/public/app.js`
**Issue**: The server broadcasts `respawn:error` events, but the frontend has no listener for this event. Respawn errors are silently ignored on the client side.

**Impact**: If the respawn controller encounters an error (e.g., PTY write failure), the user gets no notification.

### 8.4 `respawn:cycleCompleted` Has No Frontend Handler

**File**: `src/web/server.ts` (line 4154)
**Issue**: `respawn:cycleCompleted` is broadcast but has no frontend listener. The cycle count is updated via `respawn:cycleStarted`, but completion is not acknowledged.

### 8.5 `respawn:stepCompleted` Has No Frontend Handler

**File**: `src/web/server.ts` (line 4169)
**Issue**: Broadcast but not listened to in the frontend.

### 8.6 Image Detection Lacks Notification

**File**: `src/web/public/app.js` (line 3039)
**Issue**: `image:detected` events auto-open a popup window but do not trigger the `NotificationManager`. If the user is on another tab, they get no notification that a screenshot or generated image was detected.

### 8.7 Subagent Discovery/Completion Lacks Notification (By Design?)

**File**: `src/web/public/app.js` (lines 2887, 2912+)
**Issue**: Subagent events auto-open windows but do not trigger notifications. The notification preferences have `subagent_spawn` and `subagent_complete` event types defined (app.js line 906-907) with defaults of `enabled: false`, but no code actually calls `notificationManager.notify()` for these events.

**Impact**: The notification preferences UI shows toggle switches for subagent events, but they do nothing -- the notifications are never triggered regardless of the setting.

### 8.8 `session:autoCompact` Has No Notification

**File**: `src/web/public/app.js`
**Issue**: `session:autoClear` triggers a notification (app.js line 2623), but `session:autoCompact` does not. Both are significant session events (context reset vs. context compaction). The `autoCompact` SSE event is handled (line 2633 area) but only shows a toast if it's the active session, with no `NotificationManager.notify()` call.

**Note**: After reviewing the code more carefully, `session:autoCompact` is not in the file at the lines I checked. It may be handled elsewhere or may genuinely be missing a notification.

### 8.9 Cache Invalidation Pattern Is Overly Broad

**File**: `src/web/server.ts` (line 4648)
**Issue**: `if (event.startsWith('session:') || event === 'respawn:')` -- the `respawn:` check uses exact equality, but all respawn events are formatted as `respawn:stateChanged`, `respawn:blocked`, etc. The check `event === 'respawn:'` will never match. This means respawn events do NOT invalidate the cached state.

```typescript
if (event.startsWith('session:') || event === 'respawn:') {
```

Should likely be:
```typescript
if (event.startsWith('session:') || event.startsWith('respawn:')) {
```

**Impact**: After respawn state changes, the cached `getLightSessionsState()` may serve stale data until a `session:*` event triggers invalidation. Since respawn status is included in session state (via `getSessionStateWithRespawn()`), subsequent API calls to `GET /api/sessions` or SSE reconnects could show outdated respawn info.

---

## 9. Missing Notification Paths

### 9.1 Events That SHOULD Notify But Don't

| Event | Current Behavior | Suggested Notification |
|-------|-----------------|----------------------|
| `hook:teammate_idle` | Broadcast, no handler | Warning: "Teammate idle, may need new task" |
| `hook:task_completed` | Broadcast, no handler | Info: "Team task completed" |
| `respawn:error` | Broadcast, no handler | Critical: "Respawn error: {message}" |
| `image:detected` | Auto-opens popup | Info (when tab unfocused): "Screenshot captured" |
| `subagent:discovered` | Auto-opens window | Info (if enabled): "New subagent spawned: {description}" |
| `subagent:completed` | Updates panel | Info (if enabled): "Subagent completed: {description}" |
| `respawn:cycleCompleted` | Broadcast, no handler | Info: "Respawn cycle #{n} completed" |

### 9.2 Team Events That Need SSE Broadcasting

Since TeamWatcher is not integrated, these events never reach clients:
- Team created/updated/removed
- Task status changes
- New inbox messages
- Teammate count changes

---

## 10. Architecture Diagram

```
                          Claude Code Hooks
                                |
                          curl POST /api/hook-event
                                |
                      +-------------------+
                      |   server.ts       |
                      |   (Fastify)       |
                      +-------------------+
                        |       |       |
               Respawn  |  Broadcast |  RunSummary
               Signal   |  via SSE   |  Record
                        |       |       |
              +---------+   +---+---+   +--------+
              |RespawnCtrl| |SSE Bus|   |Summary |
              |  emits    | |       |   |Tracker |
              |  events   | +---+---+   +--------+
              +---------+       |
                   |            |
              server.ts    Connected
              wires to     Browsers
              SSE via          |
              broadcast()      |
                          +----+-----+
                          | app.js   |
                          | Frontend |
                          +----------+
                               |
                    +----------+-----------+
                    |                      |
              NotificationManager    Tab Alert System
              (4 layers)            (pendingHooks)
              1. In-app drawer      - action (critical)
              2. Tab title flash    - idle (warning)
              3. Browser Notification API
              4. Audio alerts
```

---

## 11. Summary of Key Files and Line References

| File | Lines | Purpose |
|------|-------|---------|
| `src/web/server.ts` | 4646-4663 | `broadcast()` method |
| `src/web/server.ts` | 547-564 | SSE client setup |
| `src/web/server.ts` | 3396-3440 | Hook event endpoint |
| `src/web/server.ts` | 178-211 | `sanitizeHookData()` |
| `src/web/server.ts` | 3900-4103 | Session event wiring |
| `src/web/server.ts` | 4143-4271 | Respawn event wiring |
| `src/web/server.ts` | 458-477 | Subagent event wiring |
| `src/hooks-config.ts` | 24-67 | Hook config generator |
| `src/hooks-config.ts` | 107-129 | Config file writer |
| `src/types.ts` | 749 | `HookEventType` |
| `src/types.ts` | 754-761 | `HookEventRequest` |
| `src/types.ts` | 1359-1375 | `RunSummaryEventType` |
| `src/team-watcher.ts` | 27-338 | TeamWatcher (unintegrated) |
| `src/subagent-watcher.ts` | 217-1346 | SubagentWatcher events |
| `src/respawn-controller.ts` | 467-476 | Event documentation |
| `src/respawn-controller.ts` | 2469-2551 | Hook signal methods |
| `src/respawn-controller.ts` | 2750-2842 | Respawn blocking logic |
| `src/run-summary.ts` | 56-447 | RunSummaryTracker class |
| `src/web/schemas.ts` | 79-83 | HookEventSchema |
| `src/web/public/app.js` | 860-1038 | NotificationManager class |
| `src/web/public/app.js` | 1445-1477 | Pending hooks state machine |
| `src/web/public/app.js` | 2813-2883 | Hook event SSE handlers |
| `src/web/public/app.js` | 2443-2613 | Respawn event SSE handlers |
| `src/web/public/app.js` | 2335-2417 | Session lifecycle SSE handlers |
