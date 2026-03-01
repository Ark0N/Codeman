# Phase 5: Frontend Modularization — Implementation Plan

**Date**: 2026-03-01
**Prerequisites**: Phase 1-4 complete (utils cleanup, CleanupManager/Debouncer, route extraction, domain splitting)
**Goal**: Split the 15,196-line `app.js` monolith into focused, independently-loadable modules while preserving the proven `Object.assign(CodemanApp.prototype, ...)` pattern from `ralph-wizard.js`.

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Architectural Decisions](#2-architectural-decisions)
3. [Module Dependency Graph](#3-module-dependency-graph)
4. [Step 1: Extract Constants & Utilities](#step-1-extract-constants--utilities)
5. [Step 2: Extract Mobile Handlers](#step-2-extract-mobile-handlers)
6. [Step 3: Extract Voice Input](#step-3-extract-voice-input)
7. [Step 4: Extract NotificationManager](#step-4-extract-notificationmanager)
8. [Step 5: Extract FocusTrap & KeyboardAccessoryBar](#step-5-extract-focustrap--keyboardaccessorybar)
9. [Step 6: Replace Inlined xterm-zerolag-input](#step-6-replace-inlined-xterm-zerolag-input)
10. [Step 7: Create ApiClient Wrapper](#step-7-create-apiclient-wrapper)
11. [Step 8: Extract Subagent Window Manager](#step-8-extract-subagent-window-manager)
12. [Execution Order & Dependencies](#execution-order--dependencies)
13. [Validation Checklist](#validation-checklist)
14. [Risk Assessment](#risk-assessment)

---

## Safety Constraints

Before starting ANY work, read and follow these rules:

1. **Never run `npx vitest run`** (full suite) — it kills tmux sessions. You are running inside a Codeman-managed tmux session.
2. **Never test on port 3000** — the live dev server runs there. Tests use ports 3150+.
3. **After TypeScript changes**: Run `tsc --noEmit` to verify type checking passes.
4. **Before considering done**: Run `npm run lint` and `npm run format:check` to ensure CI passes.
5. **Never kill tmux sessions** — check `echo $CODEMAN_MUX` first.
6. **Frontend changes require browser verification**: After each step, use Playwright to load the page and verify the UI renders. Use `waitUntil: 'domcontentloaded'` (not `networkidle` — SSE keeps the connection open). Wait 3-4s for polling/async data to populate, then check element visibility, text content, and CSS values.
7. **Cache busting**: Update the `?v=` query strings in `index.html` for any modified/new JS files after each step.
8. **Verify dev server**: `npx tsx src/index.ts web --port 3099 &` on a non-production port, confirm `curl -s http://localhost:3099/api/status | jq .status` returns `"ok"`, then kill the background process.

---

## 1. Current State Analysis

### File Structure (Before)

```
src/web/public/
├── app.js                 (15,196 lines — EVERYTHING)
├── ralph-wizard.js        (1,037 lines — already extracted)
├── index.html             (1,040 lines)
├── styles.css             (main styling)
├── mobile.css             (responsive overrides)
├── sw.js                  (service worker)
├── manifest.json          (PWA manifest)
├── upload.html            (screenshot upload)
└── vendor/                (xterm.js + addons)
```

### app.js Section Map

| Section | Lines | Size | Standalone? |
|---------|-------|------|-------------|
| Web Push utils (`urlBase64ToUint8Array`), `scheduleBackground`, constants | 1-159 | 159 | Yes |
| `MobileDetection` object | 168-271 | ~104 | Yes |
| `getEventCoords()` function | 273-285 | 13 | Yes |
| `KeyboardHandler` object | 292-567 | ~276 | No (refs `app`, `KeyboardAccessoryBar`, `MobileDetection`) |
| `SwipeHandler` object | 569-628 | ~60 | No (refs `app`) |
| `DeepgramProvider` object | 631-841 | 211 | Yes (WebSocket-only) |
| `VoiceInput` object | 842-1479 | 638 | No (refs `app`, `DeepgramProvider`) |
| `KeyboardAccessoryBar` object | 1480-1688 | ~209 | No (refs `app`, `MobileDetection`) |
| `FocusTrap` class | 1689-1748 | 60 | Yes |
| xterm-zerolag-input (inlined copy) | 1756-2153 | ~398 | No (refs xterm internals) |
| `extractSyncSegments()` | 2173-2215 | 43 | Yes |
| `NotificationManager` class | 2218-2663 | ~446 | No (refs `app`, `MobileDetection`; has own `escapeHtml` method) |
| **`CodemanApp` class | 2665-15176 | **12,512** | No (depends on all above) |
| Initialization + export | 15178-15196 | 19 | — |

### Cross-Reference Pattern

All top-level objects use `typeof X !== 'undefined'` guards for optional dependencies. This pattern enables **graceful degradation** if a module fails to load and must be preserved in extracted files.

```javascript
// Pattern used everywhere — must be preserved:
if (typeof app !== 'undefined') app.someMethod();
if (typeof KeyboardAccessoryBar !== 'undefined') KeyboardAccessoryBar.show();
if (typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice()) { ... }
```

### escapeHtml — Two Independent Copies

There are **two** `escapeHtml` methods in app.js:

1. **`NotificationManager.escapeHtml()`** (line 2659) — instance method, used internally by `NotificationManager` at lines 2461-2467
2. **`CodemanApp.escapeHtml()`** (line 15172) — instance method with static lookup maps (`_htmlEscapeMap`, `_htmlEscapePattern`) for performance. Used ~70 times throughout CodemanApp, and by `ralph-wizard.js` (3 calls via `this.escapeHtml`)

These are independent. Each class owns its own copy. The plan extracts a shared global `escapeHtml()` in `constants.js` and updates both classes + `ralph-wizard.js` to use it.

### Proven Extraction Pattern (ralph-wizard.js)

The `ralph-wizard.js` extraction established the pattern all further extractions will follow:

```javascript
// File loaded after app.js via <script defer src="ralph-wizard.js">
Object.assign(CodemanApp.prototype, {
  methodName() { /* has access to `this` = CodemanApp instance */ },
  anotherMethod() { ... },
});
```

**Key properties of this pattern:**
- No import/export — uses globals (vanilla JS, no bundler)
- `Object.assign` adds methods to prototype at load time
- Loaded with `defer` after `app.js` — guarantees `CodemanApp` exists
- Zero circular dependencies (one-way from module → CodemanApp prototype)
- HTML controls load order via `<script defer>` tag ordering

---

## 2. Architectural Decisions

### Decision 1: Vanilla JS + Script Tags (No Bundler)

**Rationale**: The frontend is a vanilla JS application with no build step. Introducing a bundler (webpack, Vite, rollup) would:
- Add build complexity and tooling dependencies
- Break the current `npm run dev` workflow (just serves files directly)
- Require source maps for debugging
- Conflict with the hot-reload-free development model

**Alternative considered**: ES modules with `<script type="module">`. Rejected because:
- Would require rewriting all globals as imports/exports
- `typeof X !== 'undefined'` guards would need replacement
- Service worker and `index.html` inline scripts would need adaptation
- Bigger migration risk for limited benefit at this stage

**Decision**: Continue with `<script defer>` tags and global objects. Each extracted file defines a global (object, class, or set of functions) that subsequent scripts can access. This matches `ralph-wizard.js`.

### Decision 2: Extraction Scope

Extract **pre-CodemanApp top-level objects** first (Steps 1-6), then **CodemanApp methods** using `Object.assign` (Steps 7-8). Do NOT attempt to break up the CodemanApp constructor or its core session/terminal management in this phase — that's a Phase 6+ effort requiring more invasive changes.

### Decision 3: Module Granularity

Target **5-8 new files** at 100-700 lines each. Avoid both micro-modules (<50 lines, not worth the HTTP request) and oversized modules (>1000 lines, defeats purpose). Each file should represent a **cohesive domain** with clear boundaries.

### Decision 4: File Naming Convention

Follow existing convention: `kebab-case.js` in `src/web/public/`. No subdirectories (keeps serving simple).

---

## 3. Module Dependency Graph

```
                     index.html (load order)
                          │
              ┌───────────┤ (defer scripts, in order)
              │           │
    vendor/xterm*.js    constants.js (NEW)
              │           │
              │     mobile-handlers.js (NEW)
              │           │
              │     voice-input.js (NEW)
              │           │
              │     notification-manager.js (NEW)
              │           │
              │     keyboard-accessory.js (NEW)
              │           │
              │           │ (xterm-zerolag-input — inline or import from packages/)
              │           │
              ├───────────┤
              │           │
              │        app.js (REDUCED — ~10,500 lines → ~8,500 lines)
              │           │
              │     ralph-wizard.js (existing)
              │           │
              │     api-client.js (NEW — Object.assign to prototype)
              │           │
              │     subagent-windows.js (NEW — Object.assign to prototype)
              └───────────┘
```

**Key constraint**: Each script can only reference globals defined by scripts loaded BEFORE it. This is enforced by `<script defer>` ordering in `index.html`.

---

## Step 1: Extract Constants & Utilities

**New file**: `src/web/public/constants.js`
**Lines moved from app.js**: 1-159 (constants), 273-285 (`getEventCoords`), 2173-2215 (`extractSyncSegments`)
**Estimated size**: ~230 lines
**Time**: ~1 hour

### What Moves

**All top-level constants** (lines 1-159):

```javascript
// constants.js — Shared constants and utility functions for Codeman frontend

// Web Push
function urlBase64ToUint8Array(base64String) { ... }

// Timing constants
const DEFAULT_SCROLLBACK = 5000;
const STUCK_THRESHOLD_DEFAULT_MS = 600000;
const GROUPING_TIMEOUT_MS = 5000;
const NOTIFICATION_LIST_CAP = 100;
const TITLE_FLASH_INTERVAL_MS = 1500;
const BROWSER_NOTIF_RATE_LIMIT_MS = 3000;
const AUTO_CLOSE_NOTIFICATION_MS = 8000;
const THROTTLE_DELAY_MS = 100;
const TERMINAL_CHUNK_SIZE = 128 * 1024;
const TERMINAL_TAIL_SIZE = 256 * 1024;
const SYNC_WAIT_TIMEOUT_MS = 50;
const STATS_POLLING_INTERVAL_MS = 2000;

// Z-index layers
const ZINDEX_SUBAGENT_BASE = 1000;
const ZINDEX_PLAN_SUBAGENT_BASE = 1100;
const ZINDEX_LOG_VIEWER_BASE = 2000;
const ZINDEX_IMAGE_POPUP_BASE = 3000;

// Floating window layout
const WINDOW_INITIAL_TOP_PX = 120;
const WINDOW_CASCADE_OFFSET_PX = 30;
const WINDOW_MIN_WIDTH_PX = 200;
const WINDOW_MIN_HEIGHT_PX = 200;
const WINDOW_DEFAULT_WIDTH_PX = 300;

// Scheduler API helper
const _hasScheduler = typeof globalThis.scheduler?.postTask === 'function';
function scheduleBackground(fn) { ... }

// DEC mode 2026 - Synchronized Output
const DEC_SYNC_START = '\x1b[?2026h';
const DEC_SYNC_END = '\x1b[?2026l';
const DEC_SYNC_STRIP_RE = /\x1b\[\?2026[hl]/g;

// Built-in respawn presets
const BUILTIN_RESPAWN_PRESETS = [ ... ];

// DEC 2026 sync segment parser
function extractSyncSegments(data) { ... }

// HTML escape utility (shared by NotificationManager and CodemanApp)
const _htmlEscapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _htmlEscapePattern = /[&<>"']/g;
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(_htmlEscapePattern, (ch) => _htmlEscapeMap[ch]);
}

// Unified event coordinate extraction (mouse + touch)
function getEventCoords(e) { ... }
```

### What Changes in app.js

1. **Delete lines 1-159** (constants section) — moved to `constants.js`
2. **Delete lines 273-285** (`getEventCoords`) — moved to `constants.js`
3. **Delete lines 2173-2215** (`extractSyncSegments`) — moved to `constants.js`
4. **Delete `escapeHtml` instance method** from CodemanApp class (lines 15162-15175, including static maps) — replaced by global `escapeHtml()` in `constants.js`
5. **Delete `escapeHtml` instance method** from NotificationManager class (line 2659-2662) — replaced by global
6. **Replace `this.escapeHtml(...)` calls** throughout CodemanApp (~70 occurrences) with `escapeHtml(...)` (global)
7. **Replace `this.escapeHtml(...)` calls** in NotificationManager (lines 2461-2467, 4 calls) with `escapeHtml(...)`

### What Changes in ralph-wizard.js

Replace 3 `this.escapeHtml(...)` calls (lines 364, 727, 850) with `escapeHtml(...)` (global function from `constants.js`, loaded before both `app.js` and `ralph-wizard.js`).

### What Changes in index.html

Add the new script tag BEFORE `app.js`:

```html
<script defer src="constants.js?v=VERSION"></script>
<script defer src="app.js?v=VERSION"></script>
<script defer src="ralph-wizard.js?v=VERSION"></script>
```

### Verification

1. All constant names are already globals — no reference changes needed in app.js for constants
2. `escapeHtml` usage changes from `this.escapeHtml()` → `escapeHtml()` (global) in CodemanApp, NotificationManager, and ralph-wizard.js
3. `extractSyncSegments` is already called as a global function — no change needed
4. Browser test: load page, verify terminal renders, tabs work, notifications fire

---

## Step 2: Extract Mobile Handlers

**New file**: `src/web/public/mobile-handlers.js`
**Lines moved from app.js**: 168-628 (`MobileDetection`, `KeyboardHandler`, `SwipeHandler`)
**Estimated size**: ~460 lines
**Time**: ~2 hours

### What Moves

Three related mobile objects that form a cohesive unit:

```javascript
// mobile-handlers.js — Device detection, keyboard handling, and swipe navigation

const MobileDetection = {
  isTouchDevice() { ... },
  isIOS() { ... },
  isSafari() { ... },
  isSmallScreen() { ... },
  isMediumScreen() { ... },
  getDeviceType() { ... },
  updateBodyClass() { ... },
  init() { ... },
  cleanup() { ... }
};

const KeyboardHandler = {
  lastViewportHeight: 0,
  keyboardVisible: false,
  initialViewportHeight: 0,
  init() { ... },
  cleanup() { ... },
  handleViewportResize() { ... },
  updateLayoutForKeyboard() { ... },
  resetLayout() { ... },
  onKeyboardShow() { ... },
  onKeyboardHide() { ... },
  _sendTerminalResize() { ... },
  isInputElement(el) { ... },
  scrollInputIntoView(input) { ... }
};

const SwipeHandler = {
  startX: 0,
  startY: 0,
  startTime: 0,
  minSwipeDistance: 80,
  maxSwipeTime: 300,
  maxVerticalDrift: 100,
  init() { ... },
  onTouchStart(e) { ... },
  onTouchEnd(e) { ... }
};
```

### Cross-Reference Analysis

| Object | References to... | How to handle |
|--------|-----------------|---------------|
| `MobileDetection` | None (standalone) | Works as-is |
| `KeyboardHandler` | `MobileDetection` (direct calls) | Guaranteed loaded before (same file) |
| `KeyboardHandler` | `typeof app !== 'undefined'` (6 guards) | Preserved as-is — `app` defined later |
| `KeyboardHandler` | `typeof KeyboardAccessoryBar !== 'undefined'` (2 guards) | Preserved — `KeyboardAccessoryBar` defined in later file, guards handle deferral |
| `SwipeHandler` | `MobileDetection.isTouchDevice()` (1 call) | Same file, no issue |
| `SwipeHandler` | `typeof app !== 'undefined'` (2 guards) | Preserved as-is |

### What Changes in app.js

1. **Delete lines 160-628** (MobileDetection section header through end of SwipeHandler)
2. `getEventCoords()` (lines 273-285) already moved to `constants.js` in Step 1 — verify deleted
3. No reference changes needed — all three objects are already globals accessed by name

### What Changes in index.html

```html
<script defer src="constants.js?v=VERSION"></script>
<script defer src="mobile-handlers.js?v=VERSION"></script>  <!-- NEW -->
<script defer src="app.js?v=VERSION"></script>
<script defer src="ralph-wizard.js?v=VERSION"></script>
```

### CodemanApp.init() Update

The `init()` method initializes mobile handlers. Verify this code path still works:

```javascript
// In app.js CodemanApp.init():
MobileDetection.init();      // Now global from mobile-handlers.js
KeyboardHandler.init();      // Now global from mobile-handlers.js
SwipeHandler.init();         // Now global from mobile-handlers.js
```

These are already called as globals, so no changes needed.

### Verification

1. Load page on desktop — verify MobileDetection sets correct body classes
2. Load page on mobile viewport (DevTools device mode, ≤768px) — verify:
   - Touch detection works
   - Keyboard show/hide repositions toolbar
   - Swipe left/right switches sessions
3. Check that `window.MobileDetection` is still set (line 15196 of app.js). `MobileDetection` is now a global from `mobile-handlers.js` — the assignment still works.

---

## Step 3: Extract Voice Input

**New file**: `src/web/public/voice-input.js`
**Lines moved from app.js**: 631-1479 (`DeepgramProvider`, `VoiceInput`)
**Estimated size**: ~850 lines
**Time**: ~3 hours

### What Moves

```javascript
// voice-input.js — Multi-provider voice input (Deepgram Nova-3 + Web Speech API)

const DeepgramProvider = {
  _ws: null,
  _mediaRecorder: null,
  _stream: null,
  // ... 200+ lines
  async start(opts) { ... },
  stop() { ... },
  cleanup() { ... }
};

const VoiceInput = {
  recognition: null,
  isRecording: false,
  supported: false,
  _activeProvider: null,
  // ... 630+ lines
  init() { ... },
  toggle() { ... },
  start() { ... },
  stop() { ... },
  _startDeepgram() { ... },
  _startWebSpeech() { ... },
  // Audio level meter, config persistence, UI updates
  cleanup() { ... }
};
```

### Cross-Reference Analysis

| Object | References to... | How to handle |
|--------|-----------------|---------------|
| `DeepgramProvider` | None (standalone WebSocket) | Works as-is |
| `VoiceInput` | `DeepgramProvider` (direct calls) | Same file — guaranteed available |
| `VoiceInput` | `typeof app !== 'undefined'` (~15 guards) | Preserved — `app` defined later |

**Note**: VoiceInput does NOT reference `MobileDetection`. Its only external dependency is `app` (via `typeof` guards) and `DeepgramProvider` (same file).

### What Changes in app.js

1. **Delete lines 631-1479** (DeepgramProvider + VoiceInput sections)
2. No reference changes — `VoiceInput` and `DeepgramProvider` are accessed as globals throughout app.js

### What Changes in index.html

```html
<script defer src="constants.js?v=VERSION"></script>
<script defer src="mobile-handlers.js?v=VERSION"></script>
<script defer src="voice-input.js?v=VERSION"></script>  <!-- NEW -->
<script defer src="app.js?v=VERSION"></script>
<script defer src="ralph-wizard.js?v=VERSION"></script>
```

### Important: VoiceInput ↔ CodemanApp References

VoiceInput accesses `app` through `typeof app !== 'undefined'` guards in these cases:
- `app.activeSessionId` — to know which session receives voice input
- `app.terminal` — to focus terminal after voice input
- `app._sendInputAsync()` — to send transcribed text
- `app.notificationManager` — to show voice-related notifications
- `app.sessions.get()` — to check session state

All of these use the existing guard pattern and will continue to work because `app` is initialized in `app.js` which loads after `voice-input.js`. The guards handle the case where `VoiceInput.init()` is called before `app` exists (which doesn't happen in practice, but is safe regardless).

### Verification

1. Load page — verify no console errors related to voice/Deepgram
2. If Deepgram API key is configured in settings, test voice toggle
3. Verify `typeof VoiceInput !== 'undefined'` checks in app.js still resolve correctly

---

## Step 4: Extract NotificationManager

**New file**: `src/web/public/notification-manager.js`
**Lines moved from app.js**: 2218-2663 (`NotificationManager` class)
**Estimated size**: ~450 lines
**Time**: ~2 hours

### What Moves

```javascript
// notification-manager.js — Multi-layer notification system
// 5 layers: in-app drawer, tab flash, browser Notification API, Web Push, audio beep

class NotificationManager {
  constructor(app) {
    this.app = app;
    this.notifications = [];
    this.unreadCount = 0;
    this.isTabVisible = !document.hidden;
    this.isDrawerOpen = false;
    this.originalTitle = document.title;
    this.preferences = this.loadPreferences();
    // Visibility change listeners...
  }

  loadPreferences() { ... }     // localStorage with v1→v4 migration
  savePreferences() { ... }
  notify({ urgency, category, sessionId, title, message }) { ... }
  _addNotification() { ... }
  _broadcastNotification() { ... }
  _flashTab() { ... }
  _showBrowserNotification() { ... }
  _playAudio() { ... }
  _sendPushNotification() { ... }
  onTabVisible() { ... }
  markAllRead() { ... }
  clearAll() { ... }
  removeNotification(id) { ... }
  getUnreadCount() { ... }
  relativeTime(ts) { ... }
  cleanup() { ... }
  // Note: escapeHtml() already removed in Step 1 — uses global escapeHtml()
}
```

### Cross-Reference Analysis

| Reference | Direction | How to handle |
|-----------|-----------|---------------|
| `NotificationManager` → `this.app` | Constructor injection | Already uses `this.app` — works unchanged |
| `NotificationManager` → `MobileDetection` | Direct calls (2 places: lines 2269, 2324) | `mobile-handlers.js` loaded first |
| `CodemanApp` → `NotificationManager` | `this.notificationManager = new NotificationManager(this)` | Constructor creates instance — needs class available |
| `NotificationManager` → `escapeHtml()` | Global function (4 calls) | Already migrated in Step 1 to `constants.js` |

**Note**: NotificationManager does NOT reference VoiceInput.

### What Changes in app.js

1. **Delete lines 2218-2663** (NotificationManager class, including the `relativeTime` and old `escapeHtml` utilities at lines 2650-2662)
2. The CodemanApp constructor already creates the instance:
   ```javascript
   this.notificationManager = new NotificationManager(this);
   ```
   This works because `notification-manager.js` loads before `app.js`.

### What Changes in index.html

```html
<script defer src="constants.js?v=VERSION"></script>
<script defer src="mobile-handlers.js?v=VERSION"></script>
<script defer src="voice-input.js?v=VERSION"></script>
<script defer src="notification-manager.js?v=VERSION"></script>  <!-- NEW -->
<script defer src="app.js?v=VERSION"></script>
<script defer src="ralph-wizard.js?v=VERSION"></script>
```

### Verification

1. Load page — verify notification badge appears in header
2. Trigger a notification event (e.g., create a session, send input) — verify:
   - In-app notification appears in drawer
   - Tab title flashes when not focused
   - Browser notification appears if enabled
3. Open Settings → Notifications — verify preferences load/save correctly

---

## Step 5: Extract FocusTrap & KeyboardAccessoryBar

**New file**: `src/web/public/keyboard-accessory.js`
**Lines moved from app.js**: 1480-1748 (`KeyboardAccessoryBar`, `FocusTrap`)
**Estimated size**: ~270 lines
**Time**: ~1 hour

### Why Combine These Two?

`FocusTrap` (60 lines) is too small for its own file but doesn't naturally belong in any other module. `KeyboardAccessoryBar` (200 lines) is mobile-focused but depends on `MobileDetection` (which is in `mobile-handlers.js`). Combining them creates a cohesive "keyboard interaction" module at a reasonable size.

### What Moves

```javascript
// keyboard-accessory.js — Mobile keyboard accessory bar + modal focus trapping

class FocusTrap {
  constructor(element) { ... }
  activate() { ... }
  deactivate() { ... }
  getFocusableElements() { ... }
  handleKeydown(e) { ... }
}

const KeyboardAccessoryBar = {
  element: null,
  _confirmTimer: null,
  _confirmAction: null,
  init() { ... },             // Creates DOM, mobile-only
  handleAction(action, btn) { ... },
  setConfirm(action, btn) { ... },
  clearConfirm() { ... },
  sendCommand(command) { ... },
  sendKey(escapeSequence) { ... },
  pasteFromClipboard() { ... },
  show() { ... },
  hide() { ... }
};
```

### Cross-Reference Analysis

| Reference | Direction | How to handle |
|-----------|-----------|---------------|
| `FocusTrap` | Standalone | No dependencies |
| `KeyboardAccessoryBar` → `MobileDetection` | Direct call in `init()` | `mobile-handlers.js` loaded first |
| `KeyboardAccessoryBar` → `typeof app` | 8+ guards for sending input | `app` defined later |
| `CodemanApp` → `FocusTrap` | `this.activeFocusTrap = new FocusTrap(el)` | Needs class available |
| `CodemanApp` → `KeyboardAccessoryBar` | `KeyboardAccessoryBar.init()` in init() | Needs object available |
| `KeyboardHandler` → `typeof KeyboardAccessoryBar` | 2 guards for show/hide | `keyboard-accessory.js` loaded after `mobile-handlers.js` — **LOAD ORDER MATTERS** |
| `ralph-wizard.js` → `FocusTrap` | `new FocusTrap(modal)` (direct usage) | `keyboard-accessory.js` loaded before `ralph-wizard.js` |

### Critical: Load Order for KeyboardHandler ↔ KeyboardAccessoryBar

`KeyboardHandler` (in `mobile-handlers.js`) references `typeof KeyboardAccessoryBar !== 'undefined'`. For this to resolve as `true`, `keyboard-accessory.js` must load BEFORE `mobile-handlers.js`... but `KeyboardAccessoryBar` depends on `MobileDetection` (in `mobile-handlers.js`).

**This is a circular dependency!**

**Resolution**: The `typeof` guard in `KeyboardHandler` already handles the case where `KeyboardAccessoryBar` doesn't exist yet. The guard runs at **runtime** (when `onKeyboardShow/Hide()` fires), not at **load time**. By the time the keyboard actually shows/hides (user interaction), all scripts have loaded. So the current load order works:

```
mobile-handlers.js   → defines MobileDetection, KeyboardHandler (with typeof guards)
keyboard-accessory.js → defines KeyboardAccessoryBar (MobileDetection available)
app.js               → calls KeyboardHandler.init(), KeyboardAccessoryBar.init()
```

When `KeyboardHandler.onKeyboardShow()` fires at runtime, `KeyboardAccessoryBar` is already defined.

### What Changes in app.js

1. **Delete lines 1480-1748** (KeyboardAccessoryBar + FocusTrap)

### What Changes in index.html

```html
<script defer src="constants.js?v=VERSION"></script>
<script defer src="mobile-handlers.js?v=VERSION"></script>
<script defer src="voice-input.js?v=VERSION"></script>
<script defer src="notification-manager.js?v=VERSION"></script>
<script defer src="keyboard-accessory.js?v=VERSION"></script>  <!-- NEW -->
<script defer src="app.js?v=VERSION"></script>
<script defer src="ralph-wizard.js?v=VERSION"></script>
```

### Verification

1. Load page on mobile viewport — verify accessory bar appears when keyboard opens
2. Test arrow keys, /init, /clear, /compact, paste buttons in accessory bar
3. Open a modal (e.g., Settings) — verify Tab key cycles within modal (FocusTrap)
4. Open Ralph Wizard — verify focus trap works there too

---

## Step 6: Replace Inlined xterm-zerolag-input

**Lines removed from app.js**: 1756-2153 (~398 lines of inlined overlay code)
**New script tag**: Load built file from `packages/xterm-zerolag-input/`
**Time**: ~1.5 hours

### Current Problem

`app.js` contains a full copy of the `xterm-zerolag-input` package (7 helper functions + `ZerolagInputAddon` class + `LocalEchoOverlay` subclass). This code is also maintained in `packages/xterm-zerolag-input/src/`. Changes must be applied to both copies.

### Strategy

Build the package and serve its output as a separate script, then remove the inlined copy from `app.js`.

### Steps

1. **Build the package**:
   ```bash
   cd packages/xterm-zerolag-input
   npm run build
   ```
   This produces `dist/` output via tsup.

2. **Check build output format**: The package's `tsup.config.ts` builds for ESM/CJS. We need an IIFE or global build that exposes `LocalEchoOverlay` as a global. Options:
   - **Option A**: Add an IIFE build target to tsup config
   - **Option B**: Create a small wrapper script that imports from the built package
   - **Option C (simplest)**: Keep a thin wrapper in app.js that references the package's globals

**Recommended: Option A** — Add IIFE build to `packages/xterm-zerolag-input/tsup.config.ts`:

```typescript
export default defineConfig({
  // ... existing config
  format: ['esm', 'cjs', 'iife'],
  globalName: 'XtermZerolagInput',
});
```

Then in the built IIFE file, `LocalEchoOverlay` would be available as `XtermZerolagInput.LocalEchoOverlay`.

3. **Copy built IIFE to vendor/**:
   ```bash
   cp packages/xterm-zerolag-input/dist/index.global.js src/web/public/vendor/xterm-zerolag-input.js
   ```

4. **Add to index.html** (after xterm.js, before app.js):
   ```html
   <script defer src="vendor/xterm-zerolag-input.js?v=VERSION"></script>
   ```

5. **Update app.js**: Delete lines 1756-2153 (inlined copy). In CodemanApp where `LocalEchoOverlay` is instantiated, update the reference:
   ```javascript
   // Old:
   this._localEchoOverlay = new LocalEchoOverlay(this.terminal);
   // New (if IIFE exposes as global):
   this._localEchoOverlay = new (XtermZerolagInput?.LocalEchoOverlay || LocalEchoOverlay)(this.terminal);
   ```
   Or simpler: ensure the IIFE wrapper also exposes `LocalEchoOverlay` as a direct global:
   ```javascript
   // At end of IIFE wrapper:
   window.LocalEchoOverlay = XtermZerolagInput.LocalEchoOverlay;
   window.ZerolagInputAddon = XtermZerolagInput.ZerolagInputAddon;
   ```

### Important: Build Pipeline Integration

After this step, the workflow for overlay changes becomes:
1. Edit source in `packages/xterm-zerolag-input/src/`
2. Run `npm run build` in the package directory
3. Copy built output to `src/web/public/vendor/`
4. Bump version query string in `index.html`

Consider adding a `scripts/build-overlay.sh` script to automate steps 2-3.

### Alternative: Simpler Approach (Skip Build)

If the IIFE build adds too much complexity, a simpler alternative is to keep the inlined code but add a comment marking it as generated:

```javascript
// ============================================================================
// xterm-zerolag-input — AUTO-GENERATED from packages/xterm-zerolag-input/
// Do NOT edit directly. Modify packages/xterm-zerolag-input/src/ and copy.
// ============================================================================
```

This documents the duplication without adding build complexity. The actual code reduction (398 lines) is the same either way since the copy in `app.js` is removed.

**Recommendation**: Go with the IIFE build approach. The 398-line reduction is worth the small build step addition.

### Verification

1. Load page — verify terminal renders
2. Type text — verify local echo overlay shows instant keystroke feedback
3. Type on mobile — verify overlay appears above keyboard
4. Verify no ghost artifacts when Claude is processing (overlay should hide)

---

## Step 7: Create ApiClient Wrapper

**New file**: `src/web/public/api-client.js`
**Pattern**: `Object.assign(CodemanApp.prototype, { ... })`
**Estimated size**: ~150 lines
**Time**: ~2 hours

### Problem

~98 `fetch()` calls scattered through CodemanApp with identical boilerplate:

```javascript
// Repeated pattern:
fetch(`/api/sessions/${sessionId}/something`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: value })
}).catch(() => {});
```

### What Moves

Extract a centralized API helper and replace repetitive patterns. This doesn't move existing methods — it adds new helper methods and gradually migrates call sites.

```javascript
// api-client.js — Centralized API fetch helper for CodemanApp

Object.assign(CodemanApp.prototype, {
  /**
   * Send a JSON API request. Handles Content-Type, JSON serialization, and error swallowing.
   * @param {string} path - API path (e.g., '/api/sessions/123/input')
   * @param {object} [opts] - { method, body, signal }
   * @returns {Promise<Response|null>} Response or null on error
   */
  async _api(path, opts = {}) {
    const { method = 'GET', body, signal } = opts;
    const fetchOpts = { method, signal };
    if (body !== undefined) {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
      fetchOpts.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(path, fetchOpts);
      return res;
    } catch {
      return null;
    }
  },

  /**
   * Send a JSON API request and parse the response as JSON.
   * @param {string} path - API path
   * @param {object} [opts] - { method, body, signal }
   * @returns {Promise<any|null>} Parsed JSON or null on error
   */
  async _apiJson(path, opts = {}) {
    const res = await this._api(path, opts);
    if (!res || !res.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  },

  /**
   * POST JSON to an API endpoint (most common pattern).
   * @param {string} path - API path
   * @param {object} body - JSON body
   * @returns {Promise<Response|null>}
   */
  async _apiPost(path, body) {
    return this._api(path, { method: 'POST', body });
  },

  /**
   * DELETE an API resource.
   * @param {string} path - API path
   * @returns {Promise<Response|null>}
   */
  async _apiDelete(path) {
    return this._api(path, { method: 'DELETE' });
  },
});
```

### Migration Strategy

Do NOT replace all 98 fetch calls in this step. Instead:

1. Add the `_api`/`_apiJson`/`_apiPost`/`_apiDelete` helpers via `Object.assign`
2. Migrate **10 of the most repeated patterns** as proof of concept:
   - Session input: `_sendInputAsync()`
   - Session resize: in `KeyboardHandler._sendTerminalResize()` and `setupEventListeners()`
   - Session create: `quickStartSession()`
   - Session delete: `deleteSession()`
   - Respawn start/stop: `startRespawn()` / `stopRespawn()`
   - Settings save: `saveSettings()`
   - Ralph state: `sendRalphInput()`
   - Subagent kill: `killSubagent()`
   - File browse: `browseFiles()`
   - Hook response: `respondToHook()`
3. Leave remaining fetch calls for incremental migration in future PRs

### What Changes in index.html

```html
<script defer src="app.js?v=VERSION"></script>
<script defer src="ralph-wizard.js?v=VERSION"></script>
<script defer src="api-client.js?v=VERSION"></script>  <!-- NEW — after app.js -->
```

### Why After app.js?

`api-client.js` uses `Object.assign(CodemanApp.prototype, ...)`, which requires `CodemanApp` to be defined. Since `app.js` defines the class and immediately instantiates `const app = new CodemanApp()`, the prototype methods will be available on the `app` instance because JavaScript prototype lookup is dynamic.

**However**: Methods added via `Object.assign` AFTER instantiation are still available because JS reads the prototype at call time, not at creation time. So this works:

```javascript
// app.js:
class CodemanApp { ... }
const app = new CodemanApp();
// api-client.js (loaded after):
Object.assign(CodemanApp.prototype, { _api() { ... } });
// Later:
app._api('/api/status'); // ✓ Works — looks up prototype chain at call time
```

### Verification

1. Load page — verify no console errors
2. Create a session — verify `quickStartSession()` works
3. Send input — verify text is delivered
4. Delete a session — verify it's removed
5. Open/close subagent windows — verify kill works

---

## Step 8: Extract Subagent Window Manager

**New file**: `src/web/public/subagent-windows.js`
**Pattern**: `Object.assign(CodemanApp.prototype, { ... })`
**Estimated size**: ~700 lines
**Time**: ~3 hours

### Problem

Subagent window management is the largest self-contained system within CodemanApp. It handles:
- Floating terminal windows with drag/resize
- Parent-child connection lines (canvas/SVG)
- Minimized state + badge indicators
- Window Z-ordering and cascading layout
- Mobile-specific stacking

### What Moves

Extract all subagent window methods from CodemanApp. The actual method names and their locations in app.js:

```javascript
// subagent-windows.js — Floating subagent terminal window management

Object.assign(CodemanApp.prototype, {
  // Tab badge (minimized agents indicator)
  renderSubagentTabBadge(sessionId, minimizedAgents) { ... },  // line 5642
  restoreMinimizedSubagent(agentId, sessionId) { ... },        // line 5800
  permanentlyCloseMinimizedSubagent(agentId, sessionId) { ... }, // line 5908

  // State persistence
  async saveSubagentWindowStates() { ... },                    // line 9760
  async restoreSubagentWindowStates() { ... },                 // line 9834

  // Connection lines (parent ↔ child visual links)
  updateConnectionLines() { ... },                             // line 11998
  _updateConnectionLinesImmediate() { ... },                   // line 12010

  // Window lifecycle
  openSubagentWindow(agentId) { ... },                         // line 12274 (~280 LOC)
  closeSubagentWindow(agentId) { ... },                        // line 12551 (~40 LOC)
  relayoutMobileSubagentWindows() { ... },                     // line 12590 (~90 LOC)
  cleanupAllFloatingWindows() { ... },                         // line 12680 (~170 LOC)

  // Shared drag utility (used by subagent + teammate + log viewer windows)
  makeWindowDraggable(win, handle) { ... },                    // line 12849 (~50 LOC)
});
```

### What Stays in app.js

- The `subagentWindows`, `minimizedSubagents`, `subagentWindowZIndex` **properties** stay in the CodemanApp constructor (they are state, not methods)
- SSE event handlers for `subagent:discovered`, `subagent:updated`, `subagent:completed` stay in `handleSSEEvent()` — they call into the extracted methods
- The subagent panel rendering stays (it's part of the main UI, not the floating windows)

### Important: Non-contiguous Methods

Unlike Steps 1-6 (which moved contiguous blocks), the subagent window methods are scattered across CodemanApp:
- Tab badge methods: lines ~5642-5926
- State persistence: lines ~9760-9906
- Connection lines + window lifecycle: lines ~11998-12900

The extraction requires cutting from **3 separate regions** of app.js. Be careful to:
1. Cut each method completely (including any JSDoc comments above it)
2. Leave surrounding methods intact
3. Verify no shared local variables between cut and remaining methods

### `makeWindowDraggable` Dependency

`makeWindowDraggable()` is used by subagent windows, teammate terminal windows (line 13298), and log viewer windows. If it moves to `subagent-windows.js`, it's still accessible via prototype — teammate/log-viewer code in `app.js` can call `this.makeWindowDraggable()` without issue.

### What Changes in index.html

```html
<script defer src="app.js?v=VERSION"></script>
<script defer src="ralph-wizard.js?v=VERSION"></script>
<script defer src="api-client.js?v=VERSION"></script>
<script defer src="subagent-windows.js?v=VERSION"></script>  <!-- NEW -->
```

### Verification

1. Start a session that spawns subagents — verify floating windows appear
2. Drag a window — verify smooth movement
3. Resize a window — verify constraints (min width/height)
4. Minimize a window — verify badge appears on session tab
5. Click badge — verify dropdown, click to restore
6. Switch sessions — verify windows for other session hide
7. Mobile viewport — verify windows stack from bottom when keyboard visible
8. Open a teammate terminal window — verify `makeWindowDraggable` still works from app.js

---

## Execution Order & Dependencies

Execute steps in this order. Each step is independently deployable and verifiable.

```
Step 1: constants.js              (self-contained, no deps)
  ↓
Step 2: mobile-handlers.js        (depends on constants.js for getEventCoords)
  ↓
Step 3: voice-input.js            (standalone; only needs `app` at runtime via typeof guard)
  ↓
Step 4: notification-manager.js   (depends on mobile-handlers.js for MobileDetection)
  ↓
Step 5: keyboard-accessory.js     (depends on mobile-handlers.js for MobileDetection)
  ↓
Step 6: xterm-zerolag-input       (depends on vendor/xterm.js)
  ↓
Step 7: api-client.js             (depends on CodemanApp — loads after app.js)
  ↓
Step 8: subagent-windows.js       (depends on CodemanApp — loads after app.js)
```

**Parallelization opportunities**:
- Steps 3 + 5 can run in parallel (no cross-dependencies)
- Steps 4 + 5 can run in parallel (both depend on mobile-handlers but not each other)
- Steps 7 + 8 can run in parallel (both extend CodemanApp prototype independently)

### index.html Final Script Order

```html
<!-- Vendor: xterm.js + addons -->
<script defer src="vendor/xterm.min.js"></script>
<script defer src="vendor/xterm-addon-fit.min.js"></script>
<script defer src="vendor/xterm-addon-webgl.min.js"></script>
<script defer src="vendor/xterm-addon-unicode11.min.js"></script>
<script defer src="vendor/xterm-zerolag-input.js"></script>     <!-- Step 6 -->

<!-- Codeman: utilities & standalone modules (no CodemanApp dependency) -->
<script defer src="constants.js"></script>                       <!-- Step 1 -->
<script defer src="mobile-handlers.js"></script>                 <!-- Step 2 -->
<script defer src="voice-input.js"></script>                     <!-- Step 3 -->
<script defer src="notification-manager.js"></script>            <!-- Step 4 -->
<script defer src="keyboard-accessory.js"></script>              <!-- Step 5 -->

<!-- Codeman: core application -->
<script defer src="app.js"></script>                             <!-- REDUCED -->

<!-- Codeman: prototype extensions (loaded after CodemanApp defined) -->
<script defer src="ralph-wizard.js"></script>                    <!-- Existing -->
<script defer src="api-client.js"></script>                      <!-- Step 7 -->
<script defer src="subagent-windows.js"></script>                <!-- Step 8 -->
```

---

## Validation Checklist

After EACH step, verify:

- [ ] Page loads without console errors
- [ ] All `<script defer>` tags reference correct files with updated `?v=` versions
- [ ] Terminals render and accept input
- [ ] Session tabs work (create, switch, delete, drag reorder)
- [ ] Notifications fire (create session → notification in drawer)
- [ ] Subagent windows appear when Claude spawns agents
- [ ] Mobile viewport works (resize to ≤768px, verify keyboard, swipe, accessory bar)
- [ ] `npm run lint` passes (app.js is excluded from lint, but check for syntax errors)
- [ ] `npm run format:check` passes
- [ ] Dev server restarts cleanly: `npx tsx src/index.ts web`

### Additional checks after all steps complete:

- [ ] Local echo overlay shows instant keystrokes
- [ ] Ralph wizard opens and functions
- [ ] Voice input toggle works (if configured)
- [ ] Settings modal opens with focus trap
- [ ] Respawn UI (timer banner, countdown) functions
- [ ] Run `du -b src/web/public/app.js` — target: ≤10,000 lines (down from 15,196)

### Size Targets

| File | Before | After |
|------|--------|-------|
| `app.js` | 15,196 lines | ~11,500 lines |
| `constants.js` | — | ~230 lines |
| `mobile-handlers.js` | — | ~460 lines |
| `voice-input.js` | — | ~850 lines |
| `notification-manager.js` | — | ~450 lines |
| `keyboard-accessory.js` | — | ~270 lines |
| `api-client.js` | — | ~150 lines |
| `subagent-windows.js` | — | ~700 lines |
| `ralph-wizard.js` (existing) | 1,037 lines | 1,037 lines (unchanged) |
| **Total new files** | — | **7 files** |
| **Net LOC change** | — | ~0 (refactor only) |
| **app.js reduction** | — | **~3,700 lines removed** (~24%) |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Script load order breaks a cross-reference | Medium | HIGH | All existing `typeof X !== 'undefined'` guards handle missing globals; verify with manual browser test after each step |
| `Object.assign` prototype methods unavailable at call time | Low | HIGH | JS prototype lookup is dynamic — works even when methods added after instantiation. Test key flows (input, delete, window open) |
| Missing constant in extracted file | Low | MEDIUM | TypeScript won't help (vanilla JS). Search for all constant names before extraction with `grep -n 'CONSTANT_NAME' app.js` |
| Cache busting failure (users see stale JS) | Medium | MEDIUM | Always update `?v=` version string. Note: production caches static files for 1 hour (`maxAge: '1h'`). Users may need Ctrl+Shift+R |
| Mobile regression (keyboard, swipe, overlay) | Medium | HIGH | Test on actual mobile device or DevTools device mode after Steps 2, 3, 5 |
| Performance regression from additional HTTP requests | Low | LOW | 7 new script files × ~5KB each = ~35KB total. With HTTP/2 multiplexing and browser caching, negligible impact. All files are `defer` (non-blocking) |
| `ralph-wizard.js` breaks after `escapeHtml` change | Low | MEDIUM | Step 1 migrates `this.escapeHtml()` → `escapeHtml()` in ralph-wizard.js. Verify all 3 call sites (lines 364, 727, 850) |
| Non-contiguous extraction in Step 8 | Medium | HIGH | Subagent methods span 3 regions of app.js. Use grep to verify all references before and after extraction |

### What NOT to Touch in This Phase

- **CodemanApp constructor** — Do not split the 42+ properties into sub-objects. That's a Phase 6+ effort requiring careful state management.
- **SSE event handling** — The `handleSSEEvent()` method is the spine of the app. Keep it in app.js.
- **Terminal rendering pipeline** — `batchTerminalWrite()`, `flushPendingWrites()`, `chunkedTerminalWrite()` are performance-critical and deeply coupled to xterm.js state. Keep in app.js.
- **`selectSession()`** — 266-line method with complex state transitions. Keep in app.js for now.
- **`renderAppSettings()`** — Settings UI is deeply coupled to server-backed settings. Keep in app.js.
- **Session lifecycle methods** — `quickStartSession()`, `deleteSession()`, `stopSession()` — these coordinate too many subsystems to extract cleanly.

### Patterns to Preserve

These working patterns should NOT be changed:
- `typeof X !== 'undefined'` guards for optional globals
- `Object.assign(CodemanApp.prototype, ...)` for method injection
- `<script defer>` for load ordering
- `window.app = app` for debugging access
- `app._elemCache` for DOM element caching
- All `requestAnimationFrame`-based batching in terminal writes

---

## Future Phases (Not in Scope)

For reference, these are natural follow-up phases after Phase 5:

**Phase 6 — Config Consolidation** (from findings roadmap):
- Create `src/config/server-config.ts`, `src/config/timing-config.ts`
- Move 40+ scattered backend constants

**Phase 7 — Test Infrastructure** (from findings roadmap):
- Consolidate MockSession into `test/mocks/`
- Add server.ts route tests

**Phase 8 — CodemanApp Class Decomposition** (future, requires Phase 5):
- Extract `SessionUI` class (session lifecycle, tab management)
- Extract `TerminalRenderer` class (batching, sync, flicker filter)
- Extract `SubagentTracker` class (agent discovery, tool call tracking)
- Extract `RalphStateUI` class (Ralph panel, state rendering)
- Extract `SSEConnector` class (EventSource, reconnect, backoff)
- Reduce CodemanApp to orchestrator (~2000 lines)

**Phase 9 — ES Module Migration** (future, if bundler adopted):
- Convert all `.js` files to ES modules
- Replace globals with import/export
- Add build step with Vite or esbuild
- Enable tree-shaking
