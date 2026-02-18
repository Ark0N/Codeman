# Notification Blinking & Visual Alert System - Deep Dive

## Overview

Claudeman implements a **4-layer notification system** managed by the `NotificationManager` class (app.js lines 860-1265). The layers are:

1. **In-app notification drawer** (Layer 1) - badge + list UI
2. **Document title flashing** (Layer 2) - tab title blinks when hidden
3. **Browser Web Notifications** (Layer 3) - OS-level popups
4. **Audio alerts** (Layer 4) - Web Audio API beeps

In addition, there are **CSS-based tab alert animations** that are independent of NotificationManager and driven by the pending hooks state machine.

---

## 1. Document Title Blinking

### Location
`src/web/public/app.js` lines 1082-1104

### Mechanism
The title blink uses `setInterval` to toggle `document.title` between two states every 1500ms:

```js
// Constants (line 14)
const TITLE_FLASH_INTERVAL_MS = 1500;

// updateTabTitle() - line 1082
updateTabTitle() {
  if (this.unreadCount > 0 && !this.isTabVisible) {
    if (!this.titleFlashInterval) {
      this.titleFlashInterval = setInterval(() => {
        this.titleFlashState = !this.titleFlashState;
        document.title = this.titleFlashState
          ? `\u26A0\uFE0F (${this.unreadCount}) Claudeman`
          : this.originalTitle;
      }, TITLE_FLASH_INTERVAL_MS);
      // Set immediately
      document.title = `\u26A0\uFE0F (${this.unreadCount}) Claudeman`;
    }
  }
}
```

The title alternates between:
- Warning emoji + unread count: `"(3) Claudeman"`
- Original title: `"Claudeman"`

### What Triggers It
Title flashing starts when `notify()` is called **while the tab is not visible** (`!this.isTabVisible`). The check is at lines 1026-1028:

```js
if (!this.isTabVisible) {
  this.updateTabTitle();
}
```

Every event that calls `notificationManager.notify()` can trigger title blinking. This includes:
- `session:error` - Session errors (critical)
- `session:exit` - Unexpected exits with non-zero codes (critical)
- `session:idle` - Stuck detection after threshold (warning)
- `hook:idle_prompt` - Claude waiting for input (warning)
- `hook:permission_prompt` - Tool approval needed (critical)
- `hook:elicitation_dialog` - Claude asking a question (critical)
- `hook:stop` - Response complete (info)
- `respawn:blocked` - Respawn blocked (critical)
- `respawn:autoAcceptSent` - Plan accepted (info)
- `session:autoClear` - Auto-cleared context (info)
- `session:ralphCompletionDetected` - Loop complete (warning)
- `session:circuitBreakerUpdate` (when OPEN) - Critical
- `session:exitGateMet` - Exit gate met (warning)
- Various Ralph/fix-plan operations

### What Stops It
Title flashing stops via `stopTitleFlash()` (lines 1097-1104):

```js
stopTitleFlash() {
  if (this.titleFlashInterval) {
    clearInterval(this.titleFlashInterval);
    this.titleFlashInterval = null;
    this.titleFlashState = false;
    document.title = this.originalTitle;
  }
}
```

Called from:
1. **`onTabVisible()`** (line 1242) - When tab becomes visible again
2. **`markAllRead()`** (line 1218) - When user marks all notifications read
3. **`clearAll()`** (line 1226) - When user clears all notifications
4. **`handleInit()` cleanup** (lines 3294-3298) - On SSE reconnect

### Interval Safety
The interval guard (`if (!this.titleFlashInterval)`) at line 1084 prevents stacking - only one interval can exist at a time. New notifications while blinking update the `unreadCount` displayed but don't create additional intervals. This is **correct and safe**.

### Memory Leak Risk: LOW
The interval is properly cleaned up in:
- `onTabVisible()` - on every tab return
- `handleInit()` - on SSE reconnect (lines 3294-3298)
- `markAllRead()` and `clearAll()` - user actions

The `handleInit()` cleanup is particularly important because SSE reconnects reset all state. The explicit cleanup at lines 3294-3298 prevents orphaned intervals:

```js
// Clear notification manager title flash interval to prevent memory leak
if (this.notificationManager?.titleFlashInterval) {
  clearInterval(this.notificationManager.titleFlashInterval);
  this.notificationManager.titleFlashInterval = null;
}
```

---

## 2. Favicon Changes

### Current State: NO dynamic favicon changes

The favicon is defined as an **inline SVG data URI** in `index.html` line 9:

```html
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,...">
```

It shows a lightning bolt icon on a dark background. The favicon is **static** and never changes programmatically.

Browser notifications reference `/favicon.ico` as their icon (line 1130):
```js
const notif = new Notification(`Claudeman: ${title}`, {
  body,
  tag,
  icon: '/favicon.ico',
  silent: true,
});
```

This is for the OS notification popup icon, not the browser tab favicon. There is no code that manipulates `link[rel="icon"]` or swaps the favicon for attention.

---

## 3. CSS Animations for Attention

### 3.1 Tab Alert Animations (styles.css lines 328-345)

Two CSS animation classes are applied to session tabs:

```css
/* Red blinking tab - for action-required hooks */
.session-tab.tab-alert-action {
  animation: tab-blink-red 2.5s ease-in-out infinite;
}

/* Yellow blinking tab - for idle hooks */
.session-tab.tab-alert-idle {
  animation: tab-blink-yellow 3.5s ease-in-out infinite;
}

@keyframes tab-blink-red {
  0%, 100% { background: transparent; border-color: transparent; }
  50% { background: rgba(239, 68, 68, 0.12); border-color: var(--red); }
}

@keyframes tab-blink-yellow {
  0%, 100% { background: transparent; border-color: transparent; }
  50% { background: rgba(234, 179, 8, 0.1); border-color: var(--yellow); }
}
```

- **Red blink (2.5s cycle)**: Permission prompts, elicitation dialogs - requires user action
- **Yellow blink (3.5s cycle)**: Idle prompt - Claude waiting for input

These are **CSS-only infinite animations** with no JavaScript timer overhead. They are performant and have zero memory leak risk.

### 3.2 Tab Switch Glow (styles.css lines 241-251)

```css
.session-tab.tab-glow {
  animation: tab-glow 0.35s ease-out forwards;
}
```

A one-shot green glow burst when switching tabs. Applied in `selectSession()` (app.js line 3985) and cleaned up via `animationend` event with `{ once: true }`:

```js
activeTab.classList.add('tab-glow');
activeTab.addEventListener('animationend', () => activeTab.classList.remove('tab-glow'), { once: true });
```

This is **safe** - `{ once: true }` auto-removes the listener.

### 3.3 Notification Badge Pulse (styles.css lines 3978-4000)

```css
.notification-badge {
  animation: notif-badge-pulse 2s ease-in-out infinite;
}

@keyframes notif-badge-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
}
```

The red notification count badge in the header bell icon pulses continuously when visible. Pure CSS, no memory concerns.

### 3.4 Status Dot Pulse (styles.css lines 261-265, 347-350)

```css
.session-tab .tab-status.busy {
  background: var(--green);
  animation: pulse 1.5s infinite;
  will-change: opacity;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

The green status dot pulses when a session is busy/working. Pure CSS.

### 3.5 Connection Status Animations (styles.css lines 405-413)

```css
.connection-dot.warning {
  animation: connection-pulse 1.5s ease-in-out infinite;
}
.connection-dot.error {
  animation: connection-pulse 0.8s ease-in-out infinite;
}
```

Connection indicator pulses differently for warning vs error states.

### 3.6 Other CSS Animations

| Animation | Location | Purpose |
|-----------|----------|---------|
| `respawn-blocked-pulse` | styles.css:798 | Respawn blocked indicator |
| `pulse-hook` | styles.css:899 | Hook event indicator |
| `ralph-pulse` | styles.css:1013 | Ralph tracker active state |
| `circuit-breaker-pulse` | styles.css:1057 | Circuit breaker warning |
| `wizard-pulse` | styles.css:5541 | Ralph wizard active indicator |
| `plan-subagent-pulse` | styles.css:5558 | Plan subagent active |
| `notif-slide-in` | styles.css:4088 | Notification drawer slide |

### 3.7 Mobile-Specific Animations (mobile.css)

Mobile CSS is minimal for animations:
- `slideUp` (line 1091) - Mobile toolbar slide animation
- `caseModalSlideUp` (line 1204) - Case modal bottom-sheet animation

No mobile-specific blinking or notification animations exist.

---

## 4. Tab Visibility API

### Implementation (app.js lines 881-893)

The `NotificationManager` constructor sets up two visibility listeners:

```js
// Standard visibility change
document.addEventListener('visibilitychange', () => {
  this.isTabVisible = !document.hidden;
  if (this.isTabVisible) {
    this.onTabVisible();
  }
});

// iOS Safari: pageshow fires on back-forward cache restore (bfcache)
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    this.isTabVisible = true;
    this.onTabVisible();
  }
});
```

### Behavior When Tab Hidden
- `isTabVisible` set to `false`
- New notifications trigger `updateTabTitle()` which starts the title blink interval
- Browser notifications are sent (subject to per-event preferences)

### Behavior When Tab Becomes Visible (`onTabVisible()` - line 1241)
```js
onTabVisible() {
  this.stopTitleFlash();         // Stop title blinking
  if (this.isDrawerOpen) {
    this.markAllRead();          // Mark all read if drawer is open
  }
  // Re-fit terminal dimensions
  if (this.app?.fitAddon && this.app?.activeSessionId) {
    this.app.fitAddon.fit();
    this.app.sendResize(this.app.activeSessionId);
  }
}
```

Key detail: Title flash always stops when tab becomes visible, but **unread count is NOT reset** unless the notification drawer is open. This means the badge count persists until the user interacts with it.

---

## 5. Focus/Blur Handling

### No window focus/blur listeners
Claudeman does **not** use `window.addEventListener('focus')` or `window.addEventListener('blur')`. It relies solely on the Page Visibility API (`visibilitychange` + `pageshow`).

This is the correct modern approach. The `focus`/`blur` events are unreliable (fire for devtools, iframe changes, etc.) while `visibilitychange` accurately reflects whether the user can see the tab.

### Other focus-related listeners
- `document.addEventListener('focusin')` (line 238) - Mobile keyboard handler for scrolling inputs into view
- Various `element.focus()` calls for modal focus trapping (`FocusTrap` class, line 742)
- `window.focus()` in browser notification click handler (line 1135) to bring window to front

None of these are related to notification/blinking behavior.

---

## 6. Multiple Notification Stacking

### Can intervals stack? NO

The `updateTabTitle()` method has a guard (line 1084):

```js
if (!this.titleFlashInterval) {
  this.titleFlashInterval = setInterval(() => { ... }, TITLE_FLASH_INTERVAL_MS);
}
```

Only one interval is ever created. Subsequent notifications while the tab is hidden simply update `this.unreadCount` which is read by the existing interval callback. The displayed count stays current without creating new intervals.

### Notification Grouping

Notifications within the same category + session within 5 seconds are **grouped** instead of creating new entries (lines 986-997):

```js
const groupKey = `${category}:${sessionId || 'global'}`;
const existing = this.groupingMap.get(groupKey);
if (existing) {
  existing.notification.count = (existing.notification.count || 1) + 1;
  existing.notification.message = message;
  existing.notification.timestamp = Date.now();
  clearTimeout(existing.timeout);
  existing.timeout = setTimeout(() => this.groupingMap.delete(groupKey), GROUPING_TIMEOUT_MS);
  this.scheduleRender();
  return; // <-- Early return prevents duplicate badge/title/browser/audio triggers
}
```

The grouping early return prevents:
- Duplicate badge increments
- Duplicate title updates
- Duplicate browser notifications
- Duplicate audio alerts

### Browser Notification Rate Limiting

Even without grouping, browser notifications are rate-limited to 1 per 3 seconds (lines 1122-1125):

```js
const now = Date.now();
if (now - this.lastBrowserNotifTime < 3000) return;
this.lastBrowserNotifTime = now;
```

### Notification List Cap

The notification list is capped at 100 entries (line 1014):
```js
if (this.notifications.length > 100) this.notifications.pop();
```

### Grouping Timeout Cleanup

Grouping map entries self-clean after 5 seconds via `setTimeout`. These timeouts are also explicitly cleaned up in `handleInit()` (lines 3299-3304):

```js
if (this.notificationManager?.groupingMap) {
  for (const { timeout } of this.notificationManager.groupingMap.values()) {
    clearTimeout(timeout);
  }
  this.notificationManager.groupingMap.clear();
}
```

### Rapid Event Scenario

If 50 events fire while the tab is hidden:
1. First event: creates notification, starts title flash, sends browser notif
2. Events 2-N within 5s of same category+session: grouped (count increments, no new intervals)
3. Events of different categories: new notifications, but title flash interval is singular
4. Browser notifications: only 1 per 3s gets through

**Verdict**: Well-protected against stacking/compounding.

---

## 7. Team Agent Blinking

### Current State: NO team-specific blinking

Searching for `team:` SSE event listeners finds **none**. There are no `addListener('team:...')` handlers in app.js.

Team agent data (teammates, tasks, colors) is tracked via:
- `this.teammateMap` (Map of agent info)
- `this.teammatePanesByName` (Map of pane targets)
- `this.teammateTerminals` (Map of terminal instances)

But these are populated from **subagent data**, not dedicated team events. Teammates appear as standard subagents and are detected by `subagent-watcher.ts` (as noted in MEMORY.md: "Teammates appear as standard subagents").

### What team events could trigger blinking?

Currently, subagent events have their own notification category:
```js
// Default event type preferences (line 906-907)
subagent_spawn: { enabled: false, browser: false, audio: false },
subagent_complete: { enabled: false, browser: false, audio: false },
```

Both are **disabled by default**. Even if enabled, they go through the standard `notify()` path which would trigger title blinking only when the tab is hidden.

### Should team events trigger blinking?

The MEMORY.md implementation priority notes:
> 1. Team-aware idle detection (prevent premature respawn)

There is no `TeammateIdle` or `TaskCompleted` hook handler in the frontend. The hooks are mentioned in MEMORY.md as valid settings schema keys but have no frontend implementation yet.

If/when team hooks are implemented, they should:
- Potentially trigger tab-alert-action (red blink) for teammate stuck/blocked states
- Use the notification system for teammate task completions
- Consider a new notification category (e.g., `teammate_idle`, `team_task_complete`) with configurable per-event preferences

---

## 8. Cleanup Analysis

### All Interval/Timeout Cleanup Points

| Timer | Created | Cleared | Risk |
|-------|---------|---------|------|
| `titleFlashInterval` | `updateTabTitle()` L1085 | `stopTitleFlash()` L1099, `onTabVisible()` L1242, `handleInit()` L3296 | LOW - guarded + multi-path cleanup |
| Grouping timeouts | `notify()` L994/L1017 | Self-expire 5s, `handleInit()` L3301 | LOW - TTL + explicit cleanup |
| Browser notif auto-close | `sendBrowserNotif()` L1143 | Self-expire 8s (via `setTimeout`) | NONE - fires once |
| Audio oscillator | `playAudioAlert()` L1178 | Self-stops 0.15s | NONE - Web Audio manages it |
| Idle timer per session | `session:idle` handler L2384 | `session:working` L2415, `handleInit()` L3269, `removeSession()` L4138 | LOW - cleaned in all paths |

### handleInit Cleanup (SSE Reconnect)

The `handleInit()` method (called on every SSE reconnect) performs comprehensive cleanup (lines 3260-3321):

1. Clears all Maps (sessions, ralphStates, terminalBuffers, etc.)
2. Clears all idle timers
3. Clears flicker filter state
4. Clears pending terminal writes
5. Clears pending hooks and tab alerts
6. **Clears notification title flash interval** (L3295-3298)
7. **Clears notification grouping timeouts** (L3300-3304)
8. Disconnects terminal resize observer
9. Clears plan loading timers
10. Clears countdown intervals
11. Clears run summary auto-refresh timer

### removeSession Cleanup (line 4120-4139)

When a session is removed:
- `pendingHooks.delete(sessionId)` (L4128)
- `tabAlerts.delete(sessionId)` (L4129)
- Idle timer cleared (L4136-4139)
- All floating windows closed

### Browser Notification Auto-Close

The `setTimeout(() => notif.close(), 8000)` at line 1143 creates an anonymous closure over the `notif` variable. This is safe because:
1. The timeout fires once and is garbage collected
2. `notif.close()` is idempotent
3. 8 seconds is short enough to not accumulate

### Edge Case: AudioContext

The `AudioContext` (line 1167) is created once and reused:
```js
if (!this.audioCtx) {
  this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
```

This is never explicitly closed, but `AudioContext` is lightweight when idle and the singleton pattern prevents accumulation. Not a practical concern.

---

## Architecture Diagram

```
                     notify() called
                          |
              +-----------+-----------+
              |                       |
        enabled check          preferences check
              |                       |
    [Layer 1: Drawer]        [Layer 2: Title Flash]
    - Add to notifications[]   - Only if tab hidden
    - Cap at 100               - Single interval guard
    - Update badge count       - Toggles every 1500ms
    - requestAnimationFrame
              |                       |
    [Layer 3: Browser Notif]  [Layer 4: Audio]
    - Per-event prefs          - Per-event prefs
    - Rate limit 3s            - Web Audio API
    - Auto-close 8s            - 0.15s beep
    - Permission check         - Singleton AudioContext

                 INDEPENDENT:
    [Tab CSS Alerts]
    - Driven by pendingHooks state machine
    - tab-alert-action (red, 2.5s cycle)
    - tab-alert-idle (yellow, 3.5s cycle)
    - Pure CSS animation, no JS timers
```

---

## Summary of Findings

| Aspect | Status | Notes |
|--------|--------|-------|
| Title blink interval safety | SAFE | Guard prevents stacking; 3-path cleanup |
| Favicon changes | NOT IMPLEMENTED | Static inline SVG; no dynamic swapping |
| CSS tab animations | SAFE | Pure CSS infinite animations; no JS timer cost |
| Visibility API usage | CORRECT | `visibilitychange` + `pageshow` (bfcache) |
| Focus/blur handling | NOT USED (correct) | Relies on Visibility API instead |
| Notification stacking | WELL PROTECTED | Grouping, rate limiting, single interval |
| Team agent blinking | NOT IMPLEMENTED | No `team:` SSE handlers; teammates use subagent path |
| Interval cleanup | COMPREHENSIVE | `handleInit`, `onTabVisible`, `removeSession`, `markAllRead`, `clearAll` |
| Memory leak risk | LOW | All timers have explicit cleanup paths |

### Potential Improvements

1. **Dynamic favicon**: Could swap favicon to a red/orange variant when there are unread critical notifications (common pattern in web apps).

2. **Team agent notifications**: When `TeammateIdle` and `TaskCompleted` hooks are implemented, add dedicated notification categories with configurable preferences in the per-event settings grid.

3. **Unread count on tab return**: Currently, returning to the tab stops the title flash but does NOT reset the unread count. The user must open the drawer or click individual notifications. Consider auto-marking as read after a brief delay when the tab becomes visible.

4. **Notification sound variety**: Currently all audio alerts use the same 660Hz sine wave. Different categories could use different tones (e.g., lower pitch for info, higher for critical).
