# Codeman Frontend Notification System -- Detailed Report

> Generated: 2026-02-17
> Source files analyzed:
> - `/home/arkon/default/codeman/src/web/public/app.js` (main frontend, ~15k lines)
> - `/home/arkon/default/codeman/src/web/public/index.html`
> - `/home/arkon/default/codeman/src/web/public/styles.css`
> - `/home/arkon/default/codeman/src/web/public/mobile.css`

---

## 1. Architecture Overview

The notification system is a **4-layer** design, all implemented in the `NotificationManager` class (lines 860-1268 of `app.js`). The layers are:

| Layer | Mechanism | When Active |
|-------|-----------|-------------|
| 1 | In-app notification drawer | Always (when enabled) |
| 2 | Tab title flashing | When tab is hidden (background) |
| 3 | Browser Notification API (OS-level) | When enabled + permission granted |
| 4 | Audio alert (Web Audio API) | When enabled for specific events |

The `NotificationManager` is instantiated once at line 1404:
```js
this.notificationManager = new NotificationManager(this);
```

---

## 2. NotificationManager Class (lines 860-1268)

### 2.1 Constructor (lines 861-893)

State initialized:
- `this.notifications = []` -- in-memory log (max 100 items)
- `this.unreadCount = 0` -- badge counter
- `this.isTabVisible = !document.hidden` -- visibility tracking
- `this.isDrawerOpen = false`
- `this.originalTitle = document.title` -- saved for flash restore
- `this.titleFlashInterval = null` -- interval ID for title flashing
- `this.titleFlashState = false` -- toggle state for flash
- `this.lastBrowserNotifTime = 0` -- rate-limit timestamp
- `this.audioCtx = null` -- lazily created Web Audio context
- `this.groupingMap = new Map()` -- debounce grouping (5s window)

Visibility listeners:
- `document.visibilitychange` -- updates `isTabVisible`, calls `onTabVisible()` when tab becomes visible
- `window.pageshow` (with `e.persisted` check) -- handles iOS Safari back-forward cache (bfcache) restore

### 2.2 Preferences System (lines 896-960)

#### Default Event-Type Preferences (lines 897-908)

```js
const defaultEventTypes = {
  permission_prompt:  { enabled: true,  browser: true,  audio: true  },
  elicitation_dialog: { enabled: true,  browser: true,  audio: true  },
  idle_prompt:        { enabled: true,  browser: true,  audio: false },
  stop:               { enabled: true,  browser: false, audio: false },
  session_error:      { enabled: true,  browser: true,  audio: false },
  respawn_cycle:      { enabled: true,  browser: false, audio: false },
  token_milestone:    { enabled: true,  browser: false, audio: false },
  ralph_complete:     { enabled: true,  browser: true,  audio: true  },
  subagent_spawn:     { enabled: false, browser: false, audio: false },
  subagent_complete:  { enabled: false, browser: false, audio: false },
};
```

#### Device-Specific Defaults (lines 910-923)

Mobile devices (`MobileDetection.getDeviceType() === 'mobile'`) get notifications **disabled by default**:
```js
const isMobile = MobileDetection.getDeviceType() === 'mobile';
const defaults = {
  enabled: !isMobile,           // OFF on mobile
  browserNotifications: !isMobile,  // OFF on mobile
  audioAlerts: false,           // OFF everywhere
  stuckThresholdMs: 600000,     // 10 minutes
  muteCritical: false,          // Legacy urgency muting
  muteWarning: false,
  muteInfo: false,
  eventTypes: defaultEventTypes,
  _version: 3,
};
```

#### Storage Keys (lines 952-956)

Device-specific localStorage keys prevent mobile settings from overriding desktop settings:
- Desktop: `codeman-notification-prefs`
- Mobile: `codeman-notification-prefs-mobile`

#### Version Migrations (lines 928-940)

- v1 -> v2: `browserNotifications` default changed from `false` to `true`
- v2 -> v3: Added `eventTypes` object with per-event-type preferences

#### Server Sync (lines 9470-9475, 9787-9828)

Notification preferences are saved to the server alongside app settings via `PUT /api/settings`:
```js
body: JSON.stringify({ ...settings, notificationPreferences: notifPrefsToSave })
```

On load, server prefs are applied **only if localStorage has none** (line 9815-9818):
```js
if (notificationPreferences && this.notificationManager) {
  const localNotifPrefs = localStorage.getItem(this.notificationManager.getStorageKey());
  if (!localNotifPrefs) {
    this.notificationManager.preferences = notificationPreferences;
    this.notificationManager.savePreferences();
  }
}
```

This means localStorage always takes precedence over server-stored prefs.

---

## 3. The `notify()` Flow (lines 962-1038)

```
notify() called
  |
  +-- preferences.enabled === false? --> RETURN (no-op)
  |
  +-- Check per-event-type preferences (eventTypes[category])
  |     |
  |     +-- Found: eventPref.enabled === false? --> RETURN
  |     |   shouldBrowserNotify = eventPref.browser && prefs.browserNotifications
  |     |   shouldAudioAlert = eventPref.audio && prefs.audioAlerts
  |     |
  |     +-- Not found: fall back to legacy urgency-based muting
  |         if muteCritical/muteWarning/muteInfo matches --> RETURN
  |         shouldBrowserNotify = prefs.browserNotifications && (critical/warning/!tabVisible)
  |         shouldAudioAlert = critical && prefs.audioAlerts
  |
  +-- Grouping: same category+session within 5s? --> increment count, update message, RETURN
  |
  +-- Create notification object { id, urgency, category, sessionId, sessionName, title, message, timestamp, read, count }
  |
  +-- Add to this.notifications[] (max 100, FIFO eviction)
  |
  +-- Track in groupingMap (5s TTL)
  |
  +-- unreadCount++; updateBadge(); scheduleRender()
  |
  +-- Layer 2: if tab NOT visible --> updateTabTitle() (start title flashing)
  |
  +-- Layer 3: if shouldBrowserNotify --> sendBrowserNotif()
  |
  +-- Layer 4: if shouldAudioAlert --> playAudioAlert()
```

### 3.1 Notification Grouping (lines 986-997)

Within a 5-second window, notifications with the same `category:sessionId` key are grouped:
- Count is incremented on existing notification
- Message is updated to latest
- Timestamp refreshed
- No new notification entry is created
- The grouping timeout is reset (sliding window)

This prevents notification spam for rapid-fire events.

---

## 4. Layer 1: In-App Notification Drawer

### 4.1 HTML Structure (index.html lines 1394-1406)

```html
<div class="notification-drawer" id="notifDrawer">
  <div class="notif-drawer-header">
    <span class="notif-drawer-title">Notifications</span>
    <div class="notif-drawer-actions">
      <button onclick="markAllRead()">checkmark</button>
      <button onclick="clearAll()">trash</button>
      <button onclick="toggleNotifications()">X</button>
    </div>
  </div>
  <div class="notif-drawer-list" id="notifList"></div>
  <div class="notif-drawer-empty" id="notifEmpty">No notifications</div>
</div>
```

### 4.2 Bell Button (index.html lines 63-66)

```html
<button class="btn-icon-header btn-notifications" onclick="app.toggleNotifications()">
  <svg><!-- bell icon --></svg>
  <span class="notification-badge" id="notifBadge" style="display:none;">0</span>
</button>
```

The bell button visibility is controlled by the `enabled` preference (line 9647-9652):
```js
const notifEnabled = this.notificationManager?.preferences?.enabled ?? true;
const notifBtn = document.querySelector('.btn-notifications');
if (notifBtn) {
  notifBtn.style.display = notifEnabled ? '' : 'none';
}
```

### 4.3 Badge (lines 1230-1238)

The red badge on the bell shows unread count. It pulses via CSS animation:
```css
.notification-badge {
  position: absolute; top: 2px; right: 2px;
  background: var(--red); color: #fff;
  animation: notif-badge-pulse 2s ease-in-out infinite;
}
@keyframes notif-badge-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
}
```

Display logic: `badge.style.display = unreadCount > 0 ? 'flex' : 'none'`.
Shows `99+` if count exceeds 99.

### 4.4 Drawer Rendering (lines 1041-1079)

Uses `requestAnimationFrame` for debounced rendering. Each notification item shows:
- Urgency color (left border: red/yellow/blue)
- Title with count multiplier (e.g., "Permission Required x3")
- Relative timestamp ("now", "5m ago", "2h ago")
- Message (truncated with ellipsis)
- Session chip (session name)
- Unread highlight (subtle blue background)
- Slide-in animation (`notif-slide-in`)

Clicking a notification: marks as read, decrements unread count, switches to the notification's session.

### 4.5 Drawer Toggle (lines 1183-1192)

`toggleDrawer()` adds/removes the `open` class. The drawer slides in from the right via CSS transform:
```css
.notification-drawer {
  transform: translateX(100%);
  transition: transform 0.2s ease;
}
.notification-drawer.open {
  transform: translateX(0);
}
```

### 4.6 CSS Styling (styles.css lines 3965-4151)

Drawer is 340px wide, fixed position, full height below header, z-index 10001.
Items have color-coded left borders: red (critical), yellow (warning), blue (info).
Mobile override: full-width with safe area padding (mobile.css lines 1049-1058).

---

## 5. Layer 2: Tab Title Flashing (lines 1082-1103)

### Behavior

When the tab is not visible and there are unread notifications:
1. `setInterval` at 1500ms toggles between:
   - Warning emoji + unread count: `"(3) Codeman"`
   - Original title: `"Codeman"`
2. Set immediately on first notification (no wait for first interval tick)

### Stopping

`onTabVisible()` (line 1241) calls `stopTitleFlash()`, which:
1. Clears the interval
2. Resets `titleFlashState = false`
3. Restores `document.title = this.originalTitle`

If the drawer is open when tab becomes visible, all notifications are marked as read.

### Memory Leak Prevention (lines 3294-3304)

On SSE reconnect (`handleInit()`), the title flash interval is explicitly cleared:
```js
if (this.notificationManager?.titleFlashInterval) {
  clearInterval(this.notificationManager.titleFlashInterval);
  this.notificationManager.titleFlashInterval = null;
}
```
Grouping timeouts are also cleared to prevent orphaned timers.

### Potential Issue

The title flash uses a Unicode warning emoji (`\u26A0\uFE0F`). This displays correctly on all modern browsers but may not render on very old terminals/browsers.

---

## 6. Layer 3: Browser Notification API (lines 1106-1161)

### Permission Flow (lines 1107-1120)

```
sendBrowserNotif() called
  |
  +-- prefs.browserNotifications === false? --> RETURN
  +-- Notification API undefined? --> RETURN
  +-- Notification.permission === 'default'?
  |     --> Auto-request permission
  |     --> If granted, re-call sendBrowserNotif() recursively
  |     --> RETURN (wait for permission dialog)
  +-- Notification.permission !== 'granted'? --> RETURN
  +-- Rate limit: < 3s since last? --> RETURN
  +-- Create Notification
```

### Notification Object (lines 1127-1143)

```js
new Notification(`Codeman: ${title}`, {
  body,
  tag,           // Groups same-tag notifications (replaces previous with same tag)
  icon: '/favicon.ico',
  silent: true,  // We handle audio ourselves
});
```

- **onclick**: focuses window, switches to session, closes notification
- **Auto-close**: 8 seconds via `setTimeout(() => notif.close(), 8000)`
- **Rate limit**: Max 1 browser notification per 3 seconds (`BROWSER_NOTIF_RATE_LIMIT_MS`)

### Manual Permission Request (lines 1146-1161)

The settings UI has an "Ask" button that calls `requestPermission()`:
- Shows toast on success/failure
- Updates permission status display (checkmark/X/?)
- Auto-enables `browserNotifications` preference on grant

### Permission Status Display

In settings (index.html line 993), a `<span class="settings-status" id="notifPermissionStatus">?</span>` shows:
- `granted` -> checkmark with green background
- `denied` -> X with red background
- `default` -> `?`

### HTTPS Requirement

The settings UI shows a hint (index.html line 996):
```
For remote access, HTTPS is required. Start with: codeman web --https
```

Browser Notification API requires a secure context (HTTPS or localhost). This hint warns users who access Codeman remotely over HTTP.

---

## 7. Layer 4: Audio Alerts (lines 1163-1181)

### Implementation

Uses Web Audio API to generate a short sine wave beep:
```js
playAudioAlert() {
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(660, ctx.currentTime);      // 660 Hz (high E)
  gain.gain.setValueAtTime(0.15, ctx.currentTime);                // Low volume
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15); // 150ms fade
  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.15);                        // 150ms duration
}
```

The `AudioContext` is lazily created and reused across alerts. Errors are silently caught.

### Potential Issues

1. **Autoplay policy**: Modern browsers block `AudioContext` creation until user interaction. The first `playAudioAlert()` call may silently fail if the user hasn't clicked anything yet. The code handles this gracefully via try/catch, but the user gets no feedback that audio failed.

2. **Mobile iOS restrictions**: iOS Safari requires `AudioContext.resume()` after user gesture. The current code does not call `resume()`, so audio alerts may never work on iOS unless the user has already interacted with an `AudioContext` (e.g., by clicking something that triggers audio).

3. **No audio indicator**: There is no visual feedback that an audio alert played (or failed to play).

---

## 8. SSE Event -> Notification Mapping

The following table maps every SSE event that triggers a notification, with exact line numbers:

| SSE Event | Category | Urgency | Line | Condition |
|-----------|----------|---------|------|-----------|
| `session:error` | `session-error` | critical | 2341 | Always |
| `session:exit` | `session-crash` | critical | 2360 | Non-zero exit code only |
| `session:idle` | `session-stuck` | warning | 2386 | After stuck threshold timeout (default 10min), only if respawn not enabled |
| `respawn:blocked` | `respawn-blocked` | critical | 2488 | Always (circuit breaker, exit signal, or status blocked) |
| `respawn:autoAcceptSent` | `auto-accept` | info | 2513 | Always |
| `session:autoClear` | `auto-clear` | info | 2623 | Always |
| `session:ralphCompletionDetected` | `ralph-complete` | warning | 2746 | Deduped by completion key (30s cooldown) |
| `session:circuitBreakerUpdate` | `circuit-breaker` | critical | 2772 | Only when state === 'OPEN' |
| `session:exitGateMet` | `exit-gate` | warning | 2787 | Always |
| `hook:idle_prompt` | `hook-idle` | warning | 2823 | Always |
| `hook:permission_prompt` | `hook-permission` | critical | 2841 | Always |
| `hook:elicitation_dialog` | `hook-elicitation` | critical | 2858 | Always |
| `hook:stop` | `hook-stop` | info | 2875 | Always |
| Circuit breaker reset | `circuit-breaker` | info | 10634 | On successful reset |
| Fix plan error | `fix-plan` | error | 10657 | On API error |
| Fix plan copied | `fix-plan` | info | 10719 | On clipboard copy |
| Fix plan written | `fix-plan` | info | 10738 | On successful write |
| Fix plan write error | `fix-plan` | error | 10746 | On write failure |
| Fix plan imported | `fix-plan` | info | 10768 | On successful import |
| Fix plan not found | `fix-plan` | warning | 10777 | When file not found |

### Category-to-EventType Mapping Gap

**Bug identified**: The notification categories used in `notify()` calls do NOT always match the event type keys in `preferences.eventTypes`. For example:

- Category `session-error` is used (line 2343) but the eventType key is `session_error` (underscore, line 902)
- Category `session-crash` (line 2362) has no corresponding eventType entry
- Category `session-stuck` (line 2388) has no corresponding eventType entry
- Category `respawn-blocked` (line 2490) has no corresponding eventType entry
- Category `auto-accept` (line 2515) has no corresponding eventType entry
- Category `auto-clear` (line 2625) has no corresponding eventType entry
- Category `circuit-breaker` (lines 2774, 10636) has no corresponding eventType entry
- Category `exit-gate` (line 2789) has no corresponding eventType entry
- Category `hook-idle` (line 2825) -- should map to `idle_prompt`, but it does not match the key
- Category `hook-permission` (line 2843) -- should map to `permission_prompt`, but does not match
- Category `hook-elicitation` (line 2860) -- should map to `elicitation_dialog`, but does not match
- Category `hook-stop` (line 2877) -- should map to `stop`, but does not match
- Category `fix-plan` (lines 10659, 10721, etc.) has no corresponding eventType entry

**Impact**: When `notify()` is called with a category that does not exist in `preferences.eventTypes`, the code falls through to the legacy urgency-based muting path (lines 976-983). This means per-event-type browser/audio toggles in the settings UI have **no effect** on the actual hook events, because the hook events use different category strings (`hook-permission`) than the eventType keys (`permission_prompt`).

For example, unchecking "Browser" for "Permission prompts" in settings sets `eventTypes.permission_prompt.browser = false`. But the actual notification uses category `hook-permission`, which is not found in eventTypes, so it falls back to urgency-based logic where `critical` urgency always gets browser notifications when `browserNotifications` is enabled.

**This is the most significant bug in the notification system.**

---

## 9. Tab Alert System (Separate from NotificationManager)

### How It Works

Tab alerts are a separate visual indicator system that shows blinking session tabs:

1. **State tracking** (lines 1349-1354):
   - `tabAlerts: Map<sessionId, 'action' | 'idle'>` -- current alert state per tab
   - `pendingHooks: Map<sessionId, Set<hookType>>` -- pending hook events

2. **setPendingHook()** (lines 1445-1451): Adds hook type to session's pending set, calls `updateTabAlertFromHooks()`.

3. **clearPendingHooks()** (lines 1453-1464): Removes specific hook type or all hooks, calls `updateTabAlertFromHooks()`.

4. **updateTabAlertFromHooks()** (lines 1467-1477):
   ```
   No hooks -> remove alert
   Has permission_prompt OR elicitation_dialog -> 'action' alert (red blink)
   Has idle_prompt -> 'idle' alert (yellow blink)
   ```

5. **Visual rendering** (lines 3497-3504, 3581-3582):
   Tab elements get CSS classes `tab-alert-action` or `tab-alert-idle`.

### CSS Animations (styles.css lines 329-345)

```css
.session-tab.tab-alert-action {
  animation: tab-blink-red 2.5s ease-in-out infinite;
}
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

### Alert Clearing

- **`session:working` event** (line 2406-2408): Clears tab alert **only if no pending hooks** remain for that session. This correctly preserves alerts for permission prompts even when Claude starts working again.
- **`hook:stop` event** (line 2873): Clears ALL pending hooks for the session (response complete means all hooks resolved).
- **`selectSession()`** (line 3977): Clears `idle_prompt` hooks (viewing the session means you saw the idle state) but keeps `action` hooks.
- **`sendInput()`** (line 3148): Clears all pending hooks (user sent input, so hooks are resolved).
- **Session deletion** (line 4128-4129): Clears both pending hooks and tab alerts.
- **SSE reconnect** (lines 3287-3289): Clears all pending hooks and tab alerts.

### Tab Glow Effect (lines 3983-3986)

When switching sessions, the newly-active tab gets a brief green glow animation:
```css
@keyframes tab-glow {
  0%   { box-shadow: none; }
  10%  { box-shadow: 0 0 18px 6px rgba(34, 197, 94, 0.7); }
  100% { box-shadow: none; }
}
```
This is purely cosmetic and not notification-related.

---

## 10. Notification Settings UI (lines 9272-9461)

### Settings Location

Under App Settings modal -> "Notifications" tab (if using tabbed settings layout).

### Controls

**Global Controls** (index.html lines 981-1013):
| Setting | Element ID | Default | Purpose |
|---------|-----------|---------|---------|
| Enabled | `appSettingsNotifEnabled` | true (desktop), false (mobile) | Master switch |
| Browser | `appSettingsNotifBrowser` | true (desktop), false (mobile) | OS-level notifications |
| Audio Alerts | `appSettingsNotifAudio` | false | Beep sounds |
| Idle Threshold | `appSettingsNotifStuckMins` | 10 | Minutes before "stuck" warning |

**Legacy Urgency Levels** (index.html lines 1019-1039):
| Setting | Element ID | Default | Purpose |
|---------|-----------|---------|---------|
| Critical | `appSettingsNotifCritical` | checked | Show critical urgency |
| Warning | `appSettingsNotifWarning` | checked | Show warning urgency |
| Info | `appSettingsNotifInfo` | checked | Show info urgency |

These are stored inverted as `muteCritical`, `muteWarning`, `muteInfo`.

**Per-Event-Type Grid** (index.html lines 1046-1086):
A 4-column grid (Event / On / Browser / Sound) for 7 event types:

| Event | On Default | Browser Default | Sound Default |
|-------|-----------|-----------------|---------------|
| Permission prompts | on | on | on |
| Questions from Claude | on | on | on |
| Session idle | on | on | off |
| Response complete | on | off | off |
| Respawn cycles | on | off | off |
| Task complete | on | on | on |
| Subagent activity | off | off | off |

### Save Flow (lines 9362-9488)

1. Collect all UI values into a `notifPrefsToSave` object
2. Set `this.notificationManager.preferences = notifPrefsToSave`
3. Call `this.notificationManager.savePreferences()` (writes to localStorage)
4. Send to server via `PUT /api/settings` with `notificationPreferences` field
5. Call `applyHeaderVisibilitySettings()` which hides/shows the bell button

### Session Error Event Type Bug (line 9425-9429)

The `session_error` event type in the save flow reuses the `permission_prompt`'s browser checkbox:
```js
session_error: {
  enabled: true,
  browser: document.getElementById('eventPermissionBrowser').checked,  // BUG: wrong checkbox
  audio: false,
},
```
This means toggling "Permission prompts -> Browser" also affects `session_error` browser notifications, which is likely unintentional.

---

## 11. Mobile-Specific Behavior

### Device Detection (lines 119-198)

`MobileDetection` object detects:
- Touch capability (via `ontouchstart`, `maxTouchPoints`, media query)
- iOS devices
- Safari browser
- Screen size categories: mobile (<430px), tablet (430-768px), desktop (768px+)

Body classes set: `device-mobile`, `device-tablet`, `device-desktop`, `touch-device`, `ios-device`, `safari-browser`.

### Mobile Notification Defaults (lines 910-914)

On mobile devices:
- `enabled: false` -- notifications disabled by default
- `browserNotifications: false` -- browser notifications disabled
- `audioAlerts: false` -- audio disabled (same as desktop)

### Mobile Storage Key (lines 952-956)

Mobile uses a separate localStorage key (`codeman-notification-prefs-mobile`) so that enabling notifications on desktop does not accidentally enable them on a mobile device viewing the same Codeman instance.

### Mobile Drawer Styling (mobile.css lines 1049-1058)

```css
.notification-drawer {
  width: 100%;
  max-width: 100%;
  right: 0;
  border-radius: 0;
  padding-left: var(--safe-area-left);
  padding-right: var(--safe-area-right);
  padding-bottom: var(--safe-area-bottom);
}
```

The drawer takes full width on mobile and respects iOS safe areas (notch, home indicator).

### Mobile Tab Ordering (lines 3566-3568)

On mobile, the active session tab is always rendered first:
```js
if (MobileDetection.getDeviceType() === 'mobile' && this.activeSessionId) {
  tabOrder = [this.activeSessionId, ...this.sessionOrder.filter(id => id !== this.activeSessionId)];
}
```

This ensures the active tab's alert animation is always visible.

---

## 12. Team/Agent Notifications

### Subagent Event Handling

Subagent events (`subagent:discovered`, `subagent:updated`, etc.) do NOT directly call `notificationManager.notify()`. There are no direct notification calls for subagent spawn/complete events in the SSE handlers.

The `subagent_spawn` and `subagent_complete` event types exist in the preferences (lines 906-907) and settings UI, but no code currently dispatches notifications with these categories.

### Teammate Badges (lines 13063-13095)

Teammate badges are purely visual UI elements on subagent windows -- they are not part of the notification system. They show `@name` with team color (blue, green, yellow).

### Missing Subagent Notifications

Despite having settings for "Subagent activity" (on/browser/sound), the system **never dispatches** notifications with category `subagent_spawn` or `subagent_complete`. The UI settings exist but are non-functional for these event types.

---

## 13. Visual Indicators Summary

### Notification-Related

| Indicator | Element | Behavior |
|-----------|---------|----------|
| Bell badge | `#notifBadge` | Red circle with count, pulsing animation |
| Tab blink (action) | `.tab-alert-action` | Red blink, 2.5s cycle |
| Tab blink (idle) | `.tab-alert-idle` | Yellow blink, 3.5s cycle |
| Title flash | `document.title` | Alternates with unread count, 1.5s interval |
| Drawer slide-in | `.notification-drawer.open` | Right-to-left slide, 0.2s |
| Item slide-in | `.notif-item` | Right-to-left slide, 0.2s |
| Item urgency border | `.notif-item-critical/warning/info` | Red/yellow/blue left border |
| Unread highlight | `.notif-item.unread` | Subtle blue background |

### Non-Notification Visual Indicators

| Indicator | Element | Purpose |
|-----------|---------|---------|
| Tab status dot | `.tab-status` | Green (idle), pulsing green (busy), red (error) |
| Tab glow | `.tab-glow` | Brief green glow on tab switch |
| Connection indicator | `#connectionIndicator` | Shows offline/reconnecting/draining state |
| Ralph status badge | `#ralphStatusBadge` | Active/completed/tracking state |
| Subagent count badge | `#subagentCountBadge` | Active agent count |
| Task badge | `.tab-badge` | Running task count on session tab |

---

## 14. Bugs and Issues

### 14.1 Category/EventType Mismatch (CRITICAL)

**Location**: Lines 962-984 (notify flow) vs lines 897-908 (eventTypes definition)

The categories used in `notify()` calls (`hook-permission`, `hook-idle`, `session-error`, etc.) do not match the eventType keys in preferences (`permission_prompt`, `idle_prompt`, `session_error`, etc.). This means the per-event-type checkboxes in settings have no effect on most notifications.

**Impact**: Users who disable "Permission prompts -> Browser" in settings still get browser notifications for permission prompts, because the notification uses category `hook-permission` which falls through to urgency-based logic.

**Fix**: Either change the categories in `notify()` calls to match the eventType keys, or add a mapping layer in `notify()`.

### 14.2 Session Error Browser Setting Reuse (MINOR)

**Location**: Line 9427

`session_error.browser` reuses `eventPermissionBrowser` checkbox instead of having its own control.

### 14.3 No Subagent Notifications Dispatched (MINOR)

**Location**: Event types `subagent_spawn` and `subagent_complete` exist in defaults (lines 906-907) and UI (lines 1082-1085), but no code ever calls `notify()` with these categories.

### 14.4 AudioContext Autoplay Policy (MINOR)

**Location**: Line 1167

`AudioContext` creation may be blocked by browser autoplay policy. No `resume()` call is made. First audio alert after page load may silently fail.

### 14.5 Rate Limit Applies Across All Events (MINOR)

**Location**: Line 1124

The 3-second rate limit for browser notifications is global -- a rapid succession of different event types (e.g., permission prompt + session error) will only show the first browser notification.

### 14.6 Title Flash Shows Emoji That May Not Gate Properly

**Location**: Line 1088

Title flash always shows when tab is hidden and there are unread notifications, regardless of which event types are enabled/disabled. If a user disables all event types but one, the title flash still fires for all unread items.

This is correct behavior (the flash indicates unread items in the drawer), but it could be confusing if a user thinks disabling an event type should prevent all visual indicators.

### 14.7 onTabVisible Marks All Read If Drawer Open

**Location**: Lines 1243-1246

When the tab becomes visible and the drawer is open, ALL notifications are marked as read. This could be surprising if the user quickly switches tabs and back -- they lose their unread state.

---

## 15. Cleanup and Memory Safety

### SSE Reconnect Cleanup (lines 3280-3305)

On `handleInit()` (SSE reconnect), the following notification state is cleaned up:
- `pendingHooks.clear()` -- prevents stale hook alerts
- `tabAlerts.clear()` -- prevents stale tab blinking
- `_shownCompletions.clear()` -- allows re-notification
- `titleFlashInterval` cleared -- prevents orphaned intervals
- `groupingMap` timeouts cleared -- prevents orphaned timeouts

### Session Deletion Cleanup (lines 4128-4129)

When a session is deleted:
- `pendingHooks.delete(sessionId)`
- `tabAlerts.delete(sessionId)`

### Idle Timer Cleanup (lines 2412-2417)

When session starts working, its stuck detection timer is cleared:
```js
const timer = this.idleTimers.get(data.id);
if (timer) {
  clearTimeout(timer);
  this.idleTimers.delete(data.id);
}
```

---

## 16. Constants Reference

| Constant | Value | Purpose |
|----------|-------|---------|
| `GROUPING_TIMEOUT_MS` | 5000 | Notification grouping window |
| `NOTIFICATION_LIST_CAP` | 100 | Max notifications in drawer |
| `TITLE_FLASH_INTERVAL_MS` | 1500 | Title blink rate |
| `BROWSER_NOTIF_RATE_LIMIT_MS` | 3000 | Min time between browser notifications |
| `AUTO_CLOSE_NOTIFICATION_MS` | 8000 | Browser notification auto-dismiss |
| `STUCK_THRESHOLD_DEFAULT_MS` | 600000 | Default idle-stuck detection (10 min) |
| `THROTTLE_DELAY_MS` | 100 | General UI throttle |
