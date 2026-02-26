# Notification Settings & Configuration System - Deep Dive

## 1. Settings UI

The notification settings live in the **App Settings modal** under the "Notifications" tab. The modal is opened via `openAppSettings()` at line 9234 of `src/web/public/app.js`, and the HTML structure is in `src/web/public/index.html` starting at line 974.

### Settings Tab Layout (5 tabs total)

The App Settings modal has tabs: Display, Claude CLI, Models, Paths, **Notifications**. The Notifications tab contains:

#### Master Control Section
| Setting | Element ID | Type | Default (Desktop) | Default (Mobile) |
|---------|-----------|------|-------------------|-------------------|
| Enable Notifications | `appSettingsNotifEnabled` | checkbox | `true` | `false` |
| Browser Notifications | `appSettingsNotifBrowser` | checkbox | `true` | `false` |
| Browser Permission | `notifPermissionStatus` | status badge | shows checkmark/X/? | same |

The Browser row includes an "Ask" button that calls `requestPermission()` and a status badge showing the current `Notification.permission` state.

There is also a hint: _"For remote access, HTTPS is required. Start with: `codeman web --https`"_

#### Alerts Section
| Setting | Element ID | Type | Default |
|---------|-----------|------|---------|
| Audio Alerts | `appSettingsNotifAudio` | checkbox | `false` |
| Idle Threshold | `appSettingsNotifStuckMins` | number input (1-120) | `10` minutes |

#### Notification Levels Section (3-column grid)
| Level | Element ID | Default |
|-------|-----------|---------|
| Critical | `appSettingsNotifCritical` | checked |
| Warning | `appSettingsNotifWarning` | checked |
| Info | `appSettingsNotifInfo` | checked |

These map to legacy `muteCritical`/`muteWarning`/`muteInfo` boolean fields (inverted: checked = not muted).

#### Per-Event Settings (4-column grid: Event / On / Browser / Sound)
| Event | Enabled | Browser | Audio |
|-------|---------|---------|-------|
| Permission prompts | `eventPermissionEnabled` (default: on) | `eventPermissionBrowser` (on) | `eventPermissionAudio` (on) |
| Questions from Claude | `eventQuestionEnabled` (on) | `eventQuestionBrowser` (on) | `eventQuestionAudio` (on) |
| Session idle | `eventIdleEnabled` (on) | `eventIdleBrowser` (on) | `eventIdleAudio` (off) |
| Response complete | `eventStopEnabled` (on) | `eventStopBrowser` (off) | `eventStopAudio` (off) |
| Respawn cycles | `eventRespawnEnabled` (on) | `eventRespawnBrowser` (off) | `eventRespawnAudio` (off) |
| Task complete | `eventRalphEnabled` (on) | `eventRalphBrowser` (on) | `eventRalphAudio` (on) |
| Subagent activity | `eventSubagentEnabled` (off) | `eventSubagentBrowser` (off) | `eventSubagentAudio` (off) |


## 2. Settings Persistence

### Dual-layer persistence: localStorage + Server

Notification preferences are stored in **two places simultaneously**:

#### Layer 1: localStorage (primary, device-specific)

- **Storage key**: `codeman-notification-prefs` (desktop) or `codeman-notification-prefs-mobile` (mobile)
- Determined by `NotificationManager.getStorageKey()` at line 953, which calls `MobileDetection.getDeviceType()`
- Device type is based on `window.innerWidth`: `<430` = mobile, `430-768` = tablet, `>=768` = desktop
- Read in `loadPreferences()` (line 896), written in `savePreferences()` (line 958)

#### Layer 2: Server-side (`~/.codeman/settings.json`)

- On save, notification prefs are bundled with app settings: `{ ...settings, notificationPreferences: notifPrefsToSave }` (line 9475)
- Sent via `PUT /api/settings` to the Fastify server
- Server does a shallow merge: `const merged = { ...existing, ...settings }` then writes to `~/.codeman/settings.json` (line 3098 of server.ts)
- The `notificationPreferences` key sits at the top level of the settings JSON alongside app settings

#### Load priority

On startup, `loadAppSettingsFromServer()` (line 9787) fetches from server and:
1. Extracts `notificationPreferences` from the response (line 9793)
2. Only applies server notification prefs **if localStorage has none** (line 9816): `if (!localNotifPrefs)`
3. This means **localStorage always wins** over server for notification prefs, making the server copy essentially a backup for new devices

### Preferences schema (version 3)

```javascript
{
  enabled: true,              // Master toggle
  browserNotifications: true, // Browser Notification API toggle
  audioAlerts: false,         // Web Audio API toggle
  stuckThresholdMs: 600000,   // 10 minutes default
  muteCritical: false,        // Legacy urgency muting
  muteWarning: false,
  muteInfo: false,
  eventTypes: {               // Per-event-type prefs (added in v3)
    permission_prompt:   { enabled: true, browser: true, audio: true },
    elicitation_dialog:  { enabled: true, browser: true, audio: true },
    idle_prompt:         { enabled: true, browser: true, audio: false },
    stop:                { enabled: true, browser: false, audio: false },
    session_error:       { enabled: true, browser: true, audio: false },
    respawn_cycle:       { enabled: true, browser: false, audio: false },
    token_milestone:     { enabled: true, browser: false, audio: false },
    ralph_complete:      { enabled: true, browser: true, audio: true },
    subagent_spawn:      { enabled: false, browser: false, audio: false },
    subagent_complete:   { enabled: false, browser: false, audio: false },
  },
  _version: 3,
}
```

### Migration path

- **v1 -> v2**: `browserNotifications` was changed from defaulting `false` to `true` (line 932)
- **v2 -> v3**: Added `eventTypes` object (line 937)
- Migration happens on load and writes back to localStorage immediately

### App settings (separate from notification prefs)

App settings use a different device-specific localStorage key:
- Desktop: `codeman-app-settings`
- Mobile: `codeman-app-settings-mobile`
- Determined by `getSettingsStorageKey()` at line 9562


## 3. Settings Application - How Toggles Take Effect

### The `notify()` method decision tree (line 962)

When `notify()` is called:

1. **Master check**: If `!preferences.enabled`, return immediately (no notification at all)
2. **Event type lookup**: Look up `preferences.eventTypes[category]`
3. **If event type found**:
   - If `!eventPref.enabled`, return (event type disabled)
   - `shouldBrowserNotify = eventPref.browser && preferences.browserNotifications`
   - `shouldAudioAlert = eventPref.audio && preferences.audioAlerts`
4. **If event type NOT found** (fallback for unknown categories):
   - Check legacy `muteCritical`/`muteWarning`/`muteInfo` based on urgency
   - `shouldBrowserNotify` = global browser toggle AND (critical/warning OR tab hidden)
   - `shouldAudioAlert` = critical urgency AND global audio toggle

### CRITICAL BUG: Category Key Mismatch

The `eventTypes` keys in the preferences schema do NOT match the `category` values used in actual `notify()` calls. This means **per-event-type settings have no effect for most notification categories**:

| eventTypes Key | Actual category Used in notify() | Match? |
|---------------|----------------------------------|--------|
| `permission_prompt` | `hook-permission` | NO |
| `elicitation_dialog` | `hook-elicitation` | NO |
| `idle_prompt` | `hook-idle` | NO |
| `stop` | `hook-stop` | NO |
| `session_error` | `session-error` | NO |
| `respawn_cycle` | `respawn-blocked` | NO |
| `token_milestone` | (not used anywhere) | N/A |
| `ralph_complete` | `ralph-complete` | NO |
| `subagent_spawn` | (used in subagent code) | Needs verification |
| `subagent_complete` | (used in subagent code) | Needs verification |

**Impact**: When `notify()` receives `category: 'hook-permission'`, it looks up `eventTypes['hook-permission']`, finds nothing, and falls through to the legacy urgency-based logic. The per-event toggles in the settings UI are effectively non-functional for all hook-based and most other notifications.

The only categories that have a chance of matching are those used in subagent notification code, which would need separate verification.

Additional uncategorized notifications that always fall through to urgency-based logic:
- `session-crash`
- `session-stuck`
- `auto-accept`
- `auto-clear`
- `circuit-breaker`
- `exit-gate`
- `fix-plan`

### Settings application timing

Settings changes take effect immediately because:
1. `saveAppSettings()` sets `this.notificationManager.preferences = notifPrefsToSave` directly (line 9459)
2. Calls `savePreferences()` to persist to localStorage (line 9460)
3. Calls `applyHeaderVisibilitySettings()` which hides/shows the notification bell icon (line 9647-9657)

### Bell icon visibility

The notification bell icon in the header (`btn-notifications`) is hidden when `preferences.enabled` is `false` (line 9649-9651). If notifications are disabled while the drawer is open, the drawer is force-closed (line 9654-9657).


## 4. Default Values

### Desktop defaults
| Setting | Default | Source |
|---------|---------|--------|
| enabled | `true` | `loadPreferences()` line 913 |
| browserNotifications | `true` | line 914, negated `isMobile` |
| audioAlerts | `false` | line 915 |
| stuckThresholdMs | `600000` (10 min) | `STUCK_THRESHOLD_DEFAULT_MS` constant, line 11 |
| muteCritical/Warning/Info | `false` (not muted) | lines 918-920 |

### Mobile defaults
| Setting | Default | Source |
|---------|---------|--------|
| enabled | `false` | line 913, negated `!isMobile` |
| browserNotifications | `false` | line 914 |
| audioAlerts | `false` | line 915 |

### CLAUDE.md documentation

CLAUDE.md states: _"Key defaults: Most panels hidden (monitor, subagents shown), notifications enabled (audio disabled), subagent tracking on, Ralph tracking off."_

This is accurate for desktop but does not mention the mobile-specific defaults where notifications are entirely disabled.

### Constants (line 11-16 of app.js)
```javascript
const STUCK_THRESHOLD_DEFAULT_MS = 600000;  // 10 minutes
const GROUPING_TIMEOUT_MS = 5000;           // 5 seconds - notification grouping window
const NOTIFICATION_LIST_CAP = 100;          // Max notifications in list
const TITLE_FLASH_INTERVAL_MS = 1500;       // Title flash rate
const BROWSER_NOTIF_RATE_LIMIT_MS = 3000;   // Rate limit for browser notifications
const AUTO_CLOSE_NOTIFICATION_MS = 8000;    // Auto-close browser notifications
```


## 5. Desktop vs Mobile Settings

### Separate storage keys - YES

Desktop and mobile use completely separate localStorage keys:
- **Notification prefs**: `codeman-notification-prefs` vs `codeman-notification-prefs-mobile`
- **App settings**: `codeman-app-settings` vs `codeman-app-settings-mobile`

### Different defaults - YES

Mobile defaults disable everything:
- `enabled: false` (master toggle off)
- `browserNotifications: false`
- All tracking features disabled
- All panels hidden

Desktop defaults enable notifications but keep audio off.

### Server-side sync behavior

When loading from server, display settings (which include panel visibility, tracking toggles, etc.) are filtered out to avoid overwriting mobile-specific defaults (lines 9796-9806). Notification prefs from the server only apply if the device has no local prefs yet (line 9816).

### Mobile CSS adjustments

`mobile.css` line 1050 makes the notification drawer full-width on mobile:
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

### Device type detection

`MobileDetection.getDeviceType()` (line 153) uses a simple width check:
- `< 430px` = mobile
- `430-768px` = tablet (treated as desktop for settings keys)
- `>= 768px` = desktop

Note: Only `mobile` vs non-mobile matters for settings keys. Tablet uses the desktop key.


## 6. Notification Permission Flow

### Auto-request on first notification

When `sendBrowserNotif()` is called and `Notification.permission === 'default'` (never asked), the app **auto-requests permission** (line 1110-1118):
```javascript
if (Notification.permission === 'default') {
  Notification.requestPermission().then(result => {
    if (result === 'granted') {
      this.sendBrowserNotif(title, body, tag, sessionId);  // Re-send
    }
  });
  return;
}
```

The first notification that would trigger a browser notification causes the permission prompt. If granted, the notification is re-sent.

### Manual request via settings

The "Ask" button in the Notifications settings tab calls `requestPermission()` (line 1146):
```javascript
async requestPermission() {
  if (typeof Notification === 'undefined') {
    this.app.showToast('Browser notifications not supported', 'warning');
    return;
  }
  const result = await Notification.requestPermission();
  // Update status badge
  if (result === 'granted') {
    this.preferences.browserNotifications = true;
    this.savePreferences();
    this.app.showToast('Notifications enabled', 'success');
  }
}
```

**Side effect**: Granting permission also auto-enables `browserNotifications` toggle (line 1155).

### Permission status display

The settings UI shows the current permission state via a status badge:
- Checkmark (granted) - green background
- X (denied) - red background
- ? (default/not asked) - neutral

### HTTPS requirement

Browser notifications require HTTPS for remote access. The settings UI includes a hint: _"For remote access, HTTPS is required. Start with: `codeman web --https`"_. On localhost, HTTP works fine.


## 7. Audio Setting

### Toggle: `audioAlerts`

The global `audioAlerts` toggle (default: `false`) controls whether audio can play at all. Per-event `audio` toggles further refine which events produce sound.

### Audio generation

Audio is generated via the Web Audio API (line 1163-1181), NOT via audio file playback:
```javascript
playAudioAlert() {
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(660, ctx.currentTime);   // 660 Hz (E5)
  gain.gain.setValueAtTime(0.15, ctx.currentTime);              // Low volume
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);  // 150ms fade
  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.15);
}
```

This produces a short 150ms sine wave beep at 660 Hz with a quick exponential fade.

### Audio decision logic

For audio to play, ALL of these must be true:
1. `preferences.enabled` = true (master toggle)
2. `preferences.audioAlerts` = true (global audio toggle)
3. For known event types: `eventTypes[category].audio` = true
4. For unknown categories (fallback): urgency must be `'critical'`

### AudioContext lazy initialization

The `AudioContext` is created lazily on first use (line 1166-1168). This is important because browsers require a user gesture before creating an AudioContext. The first audio alert may silently fail if no user interaction has occurred.

### Does it actually work?

Yes, given the prerequisites above are met. However, due to the category key mismatch (Section 3), per-event audio settings are mostly non-functional. The fallback logic means audio only plays for `critical` urgency notifications when the category is unrecognized (which is most of them).


## 8. Per-Session vs Global Settings

### Global only

Notification preferences are **strictly global**. There is no per-session notification configuration.

- The `NotificationManager` is a singleton on the `CodemanApp` instance (line 1404)
- Preferences are loaded once from localStorage (line 878)
- All sessions share the same notification rules

### Per-session data in notifications

While settings are global, each notification carries `sessionId` and `sessionName` for:
- Displaying which session triggered the notification (session chip in drawer items)
- Click-to-switch: clicking a notification selects that session tab (line 1206-1208)
- Browser notification onclick: focuses the window and selects the session (line 1134-1139)

### Stuck detection is per-session

The idle/stuck detection timer is per-session (using `this.idleTimers` Map at line 2383), but the threshold comes from the global `stuckThresholdMs` setting. Respawn-enabled sessions are excluded from stuck detection (line 2381).

### Case settings (separate system)

There is a separate "case settings" system (`caseSettings_<caseName>` in localStorage, lines 14513-14520) but it does not include notification preferences.


## 9. Notification Layers (4-layer system)

The notification system operates in 4 independent layers:

| Layer | Description | Always On? | Controlled By |
|-------|-------------|-----------|--------------|
| 1. Drawer | In-app notification list (slide-out panel) | Yes (if enabled) | `preferences.enabled` |
| 2. Tab Title | Flashing title with unread count when tab unfocused | Yes (if enabled) | `preferences.enabled` + tab visibility |
| 3. Browser | OS-level Web Notifications | Conditional | `preferences.browserNotifications` + per-event `browser` + `Notification.permission` |
| 4. Audio | Web Audio API beep | Conditional | `preferences.audioAlerts` + per-event `audio` |

### Rate limiting

Browser notifications are rate-limited to 1 per 3 seconds (line 1124, `BROWSER_NOTIF_RATE_LIMIT_MS`).

### Notification grouping

Same-category notifications for the same session within 5 seconds are grouped (count incremented) instead of creating new entries (line 986-996, `GROUPING_TIMEOUT_MS`).

### Auto-close

Browser notifications auto-close after 8 seconds (line 1143, `AUTO_CLOSE_NOTIFICATION_MS`).

### List cap

The in-app notification list is capped at 100 entries (line 1014, FIFO eviction).


## 10. Key Issues and Recommendations

### Issue 1: Category Key Mismatch (HIGH PRIORITY)

The per-event settings in the UI are effectively non-functional because the category strings used in `notify()` calls (`hook-permission`, `hook-idle`, `session-error`, etc.) do not match the `eventTypes` keys in preferences (`permission_prompt`, `idle_prompt`, `session_error`, etc.).

**Fix options**:
- A) Change all `notify()` category values to match the `eventTypes` keys
- B) Change the `eventTypes` keys to match the categories used in `notify()` calls
- C) Add a mapping function in `notify()` that normalizes categories to eventType keys

Option A is the cleanest since the eventTypes keys match the hook event names from Claude Code.

### Issue 2: `session_error` hardcoded in save

In `saveAppSettings()` at line 9425-9429, `session_error` has its browser setting hardcoded to mirror `permission_prompt`'s browser toggle and its audio is always `false`. There is no dedicated UI row for session errors. Similarly, `token_milestone` is hardcoded to `enabled: true, browser: false, audio: false` with no UI controls (lines 9435-9439).

### Issue 3: Subagent spawn/complete share a single UI row

Both `subagent_spawn` and `subagent_complete` are controlled by a single "Subagent activity" row in the UI (lines 9445-9454). This is intentional but worth noting.

### Issue 4: Mobile default discoverability

Mobile users have notifications disabled by default. There is no onboarding prompt or toast suggesting they enable notifications. A user on mobile would need to find Settings > Notifications and enable the master toggle.

### Issue 5: Server-side prefs are write-only in practice

Because localStorage always wins over server prefs (unless localStorage is empty), the server copy of notification preferences is effectively a one-time bootstrap for new devices. Changes made on one device do not propagate to another device that already has local prefs.


## 11. File Reference

| File | Lines | What |
|------|-------|------|
| `src/web/public/app.js` | 11-16 | Constants (thresholds, caps, intervals) |
| `src/web/public/app.js` | 120-180 | `MobileDetection` utility |
| `src/web/public/app.js` | 859-1253 | `NotificationManager` class |
| `src/web/public/app.js` | 896-950 | `loadPreferences()` with migration |
| `src/web/public/app.js` | 952-960 | `getStorageKey()` and `savePreferences()` |
| `src/web/public/app.js` | 962-1039 | `notify()` decision logic |
| `src/web/public/app.js` | 1106-1161 | Browser notification + permission request |
| `src/web/public/app.js` | 1163-1181 | Audio alert via Web Audio API |
| `src/web/public/app.js` | 9234-9338 | `openAppSettings()` - populates notification UI |
| `src/web/public/app.js` | 9362-9487 | `saveAppSettings()` - saves all prefs |
| `src/web/public/app.js` | 9562-9624 | Device-aware settings storage keys |
| `src/web/public/app.js` | 9626-9657 | `applyHeaderVisibilitySettings()` - bell icon visibility |
| `src/web/public/app.js` | 9787-9828 | `loadAppSettingsFromServer()` - server sync |
| `src/web/public/app.js` | 2335-2883 | SSE event handlers that call `notify()` |
| `src/web/public/index.html` | 63-66 | Notification bell button + badge |
| `src/web/public/index.html` | 974-1092 | Notifications settings tab HTML |
| `src/web/public/index.html` | 1395-1406 | Notification drawer HTML |
| `src/web/public/styles.css` | 2586-2748 | Settings grid + event type grid CSS |
| `src/web/public/styles.css` | 3978-4151 | Notification badge, drawer, items CSS |
| `src/web/public/mobile.css` | 1050-1058 | Mobile notification drawer override |
| `src/web/server.ts` | 3073-3129 | `GET/PUT /api/settings` endpoints |
