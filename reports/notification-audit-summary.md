# Notification System Audit - Summary Report

Date: 2026-02-17

## Scope

Full audit of the Claudeman notification system covering:
- Backend event pipeline (server.ts, hooks-config.ts, team-watcher.ts, subagent-watcher.ts)
- Frontend notification manager (app.js NotificationManager class, 4-layer architecture)
- Settings UI and persistence (localStorage + server backup)
- Blinking/visual alerts (title flash, CSS tab animations, badge pulse)
- Desktop vs mobile behavior
- Team agent integration

## Architecture

4-layer notification system in `NotificationManager` class:
1. **In-app drawer** - Sliding panel with badge on bell icon, grouping within 5s windows
2. **Tab title flash** - `setInterval` at 1500ms, warning emoji + unread count when tab hidden
3. **Browser Notification API** - OS-level notifications, rate-limited 1 per 3s, auto-close at 8s
4. **Audio alerts** - Web Audio API 660Hz sine wave beep, 150ms duration

Separate from NotificationManager: **CSS tab alert system** driven by `pendingHooks` state machine (red blink for action, yellow for idle).

## Bugs Found & Fixed

### CRITICAL

| # | Bug | Fix | Files |
|---|-----|-----|-------|
| 1 | **Category/EventType key mismatch** - Per-event notification settings (On/Browser/Sound checkboxes) were completely non-functional. `notify()` used categories like `hook-permission` but `eventTypes` keys were `permission_prompt`. Lookup always failed, falling through to legacy urgency-based logic. | Added `categoryToEventType` mapping object in `notify()` method | `app.js:966-984` |
| 2 | **Cache invalidation bug** - `broadcast()` checked `event === 'respawn:'` (exact match) but all respawn events are `respawn:stateChanged` etc. Respawn state changes never invalidated cached state. | Changed to `event.startsWith('respawn:')` | `server.ts:4648` |

### HIGH

| # | Bug | Fix | Files |
|---|-----|-----|-------|
| 3 | **`session_error.browser` setting** used wrong checkbox - saved from `eventPermissionBrowser` instead of its own value | Changed to preserve current pref value with fallback | `app.js:9516` |
| 4 | **Dead hook events** - `hook:teammate_idle` and `hook:task_completed` broadcast by backend but no frontend handlers | Added SSE listeners with appropriate notifications | `app.js:2924-2950` |
| 5 | **`respawn:error` silently dropped** - No frontend handler for respawn errors | Added SSE listener with critical notification | `app.js:2630-2642` |
| 6 | **Subagent notifications decorative** - Settings had toggles but no code dispatched notifications | Wired `notify()` calls into subagent:discovered and subagent:completed handlers | `app.js:2989,3107` |

### MEDIUM

| # | Bug | Fix | Files |
|---|-----|-----|-------|
| 7 | **AudioContext autoplay policy** - No `resume()` call, first audio silently fails on browsers with autoplay restrictions | Added `audioCtx.state === 'suspended'` check with `resume()` | `app.js:1191` |

## What Works Well (No Changes Needed)

- **Title blinking**: Properly guarded against interval stacking, comprehensive cleanup (onTabVisible, handleInit, markAllRead, clearAll)
- **CSS tab alerts**: Pure CSS infinite animations, zero JS timer overhead, correctly wired to pendingHooks state machine
- **Notification grouping**: 5s sliding window dedup prevents spam, triple-layered stacking protection
- **Mobile/desktop separation**: Separate localStorage keys (`-mobile` suffix), separate defaults (mobile OFF by default)
- **Memory cleanup**: Thorough in handleInit (SSE reconnect), removeSession, all timer paths
- **Browser notification rate limiting**: Global 3s rate limit with auto-close at 8s
- **Visibility API usage**: Correct modern approach (visibilitychange + pageshow for iOS bfcache, no focus/blur)
- **Notification drawer UX**: Urgency-colored borders, relative timestamps, click-to-switch-session, slide-in animations

## Detailed Reports

| Report | File |
|--------|------|
| Backend analysis | `reports/notification-backend.md` |
| Frontend analysis | `reports/notification-frontend.md` |
| Settings flow | `reports/notification-settings.md` |
| Blinking/visual alerts | `reports/notification-blinking.md` |

## Changes Summary

### `src/web/public/app.js`
- Added `categoryToEventType` mapping in `notify()` (lines 966-984)
- Added `hook:teammate_idle` SSE handler (lines 2924-2936)
- Added `hook:task_completed` SSE handler (lines 2938-2950)
- Added `respawn:error` SSE handler (lines 2630-2642)
- Wired `subagent:discovered` → `notify()` call (line 2989)
- Wired `subagent:completed` → `notify()` call (line 3107)
- Fixed `session_error.browser` setting save (line 9516)
- Added `AudioContext.resume()` for autoplay policy (line 1191)

### `src/web/server.ts`
- Fixed cache invalidation: `event === 'respawn:'` → `event.startsWith('respawn:')` (line 4648)

## Known Limitations (Not Addressed)

- **TeamWatcher is unintegrated** - The class exists in `team-watcher.ts` but is never imported in `server.ts`. Team events (member join/leave, task updates, inbox messages) are not broadcast via SSE. This is a larger feature gap, not a notification bug.
- **Browser notification rate limit is global** - A rapid succession of different event types only shows the first browser notification within 3s. This is by design for spam prevention.
- **No dynamic favicon** - Tab favicon is static; could be enhanced to show red/orange badge for unread notifications.
- **Per-session notification settings** - All notification prefs are global, no per-session customization.
