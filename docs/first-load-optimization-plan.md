# First-Load Performance Optimization Plan

**Date**: 2026-02-18
**Audit by**: 4-agent team (css-analyst, js-analyst, server-analyst, deps-analyst)
**Scope**: First browser load of Codeman web UI at `/`

---

## Current State (Baseline)

### Payload

| Asset | Raw | Compressed | Render-Blocking? |
|-------|-----|-----------|-----------------|
| `index.html` | 82 KB | ~15 KB | N/A (document) |
| `styles.css` | 154 KB | ~25 KB | **YES** |
| `mobile.css` | 34 KB | ~7 KB | **YES** (missing media query) |
| `xterm.css` (CDN) | 2 KB | ~2 KB | No (preload pattern) |
| `xterm.min.js` (CDN) | 67 KB | ~65 KB | No (defer) |
| `xterm-addon-fit` (CDN) | 1 KB | ~1 KB | No (defer) |
| `app.js` | 563 KB | ~126 KB | No (defer) |
| **Total** | **903 KB** | **~241 KB** | |

### Request Waterfall (13 requests on first load)

```
T=0     GET /                              (82KB doc)
T+20ms  ├── styles.css?v=0.1536            (154KB — BLOCKS RENDER)
        ├── mobile.css?v=0.1536            (34KB — BLOCKS RENDER on all viewports!)
        ├── xterm.css (CDN, preloaded)     (2KB — non-blocking, already async)
        ├── xterm.min.js (CDN, defer)      (67KB)
        ├── xterm-addon-fit.min.js (CDN)   (1KB)
        └── app.js?v=0.1536 (defer)        (563KB)

[FIRST PAINT blocked by: styles.css + mobile.css]

T+200ms JS execution starts
        ├── new Terminal() + terminal.open()    ← HEAVY sync (canvas creation)
        ├── connectSSE() → /api/events          ← SSE stream
        ├── loadState() → /api/status           ← DUPLICATE of SSE init!
        ├── loadQuickStartCases()
        │   ├── /api/settings                   ← fetched TWICE
        │   └── /api/cases?_t=<timestamp>       ← cache-busted unnecessarily
        ├── startSystemStatsPolling()
        │   └── /api/system/stats               ← starts immediately, every 2s
        └── loadAppSettingsFromServer()
            └── /api/settings                   ← DUPLICATE #2

T+500ms First Meaningful Paint (terminal + header visible)
```

### Problems

1. **2 render-blocking CSS files** — mobile.css blocks desktop for no reason
2. **Double handleInit()** — SSE init + /api/status both call full state reset
3. **Duplicate /api/settings** — fetched twice in init chain
4. **563KB unminified JS monolith** — no build minification at all
5. **154KB unminified CSS** — 70% is for modals/wizards (below-the-fold)
6. **Sync terminal.open()** — heaviest single call, blocks before first paint
7. **12 modals pre-rendered** — ~600+ hidden DOM nodes, ~60KB HTML
8. **Stats polling starts immediately** — even with 0 sessions
9. **No loading skeleton** — blank black screen until all CSS+JS loads
10. **CDN dependency** — 3 xterm files from jsdelivr (DNS+TLS latency)
11. **1h cache for versioned assets** — could be 1yr+immutable with ?v= busting
12. **No HTTP/2** — 6-connection limit queues some requests
13. **On-the-fly compression** — no pre-compressed .gz/.br files

### What's Already Good (don't touch)

- Single shared Terminal instance (buffer swapping)
- Teammate terminals created lazily on window open
- Subagent windows use HTML logs, not Terminal instances
- `getLightState()` has 1s TTL cache
- SSE init sends lightweight state (no terminal buffers)
- Buffer hydration uses chunked writes (128KB via rAF)
- `selectSession()` defers secondary panels via requestIdleCallback
- System fonts only — zero web font loading
- xterm.css already uses async preload pattern
- Proper SSE reconnection with exponential backoff
- CSS `contain` on header/tabs for layout isolation

---

## Implementation Plan (15 steps, ordered by impact/effort)

### Phase 1: Quick Wins (1-line to 15-min changes)

#### Step 1: Add media attribute to mobile.css
**Impact**: HIGH — 34KB stops blocking render on desktop
**File**: `src/web/public/index.html:14`

```html
<!-- BEFORE -->
<link rel="stylesheet" href="mobile.css?v=0.1536">

<!-- AFTER -->
<link rel="stylesheet" href="mobile.css?v=0.1536" media="(max-width: 1023px)">
```

Browser still downloads it (for potential resize) but won't block rendering on desktop. The mobile.css file header says this was intended but never implemented.

---

#### Step 2: Remove duplicate /api/status + double handleInit()
**Impact**: HIGH — eliminates redundant API call + double state reset (clears 15+ Maps, 7+ timers, runs cleanupAllFloatingWindows(), double renderSessionTabs())
**Files**: `src/web/public/app.js`

The SSE `init` event (server.ts:618) sends `getLightState()`. The `loadState()` in `init()` at `app.js:1554` fetches identical data from `/api/status`. Both call `handleInit()` which wipes state. The `_initGeneration` guard only protects session-restore, NOT the expensive cleanup (lines 3389-3503).

```js
// In init() — REMOVE this.loadState(), add SSE fallback:
this.connectSSE();
// Remove: this.loadState();
this._initFallbackTimer = setTimeout(() => {
  if (this._initGeneration === 0) this.loadState();
}, 3000);

// In handleInit() — clear fallback timer:
handleInit(data) {
  if (this._initFallbackTimer) {
    clearTimeout(this._initFallbackTimer);
    this._initFallbackTimer = null;
  }
  // ... rest of handleInit
}
```

---

#### Step 3: Deduplicate /api/settings fetch
**Impact**: MEDIUM — removes 1 redundant API call
**Files**: `src/web/public/app.js:7341` (loadQuickStartCases), `app.js:9964` (loadAppSettingsFromServer)

```js
// In init() — fetch settings once, share the promise:
const settingsPromise = fetch('/api/settings').then(r => r.json());
this.loadQuickStartCases(null, settingsPromise);
this.loadAppSettingsFromServer(settingsPromise);
```

Both functions need to accept an optional pre-fetched settings promise parameter.

---

#### Step 4: Remove cache-busting from /api/cases
**Impact**: LOW — allows browser caching
**File**: `src/web/public/app.js:7351`

```js
// BEFORE
const res = await fetch('/api/cases?_t=' + Date.now());
// AFTER
const res = await fetch('/api/cases');
```

---

#### Step 5: Defer system stats polling
**Impact**: MEDIUM — removes API call every 2s when idle
**Files**: `src/web/public/app.js:1567`, `app.js:15261`

Move `startSystemStatsPolling()` out of `init()`. Start it in `handleInit()` only when `data.sessions.length > 0`.

---

### Phase 2: Build Pipeline (30-min changes, highest payload impact)

#### Step 6: Self-host xterm.js assets
**Impact**: MEDIUM-HIGH — eliminates CDN DNS/TLS latency (~100ms even with preconnect)
**Files**: `src/web/public/index.html`, `package.json` build script

xterm is NOT in package.json — add it:
```bash
npm install xterm@5.3.0 @xterm/addon-fit@0.8.0 --save
```

Build script addition:
```bash
mkdir -p dist/web/public/vendor
cp node_modules/xterm/css/xterm.css dist/web/public/vendor/
cp node_modules/xterm/lib/xterm.min.js dist/web/public/vendor/
cp node_modules/@xterm/addon-fit/lib/xterm-addon-fit.min.js dist/web/public/vendor/
```

Update index.html CDN URLs to `/vendor/xterm.min.js` etc. Remove preconnect/dns-prefetch for jsdelivr.

---

#### Step 7: Add esbuild minification to build
**Impact**: HIGH — biggest single optimization for payload size
**File**: `package.json` build script

Current build just does `cp -r src/web/public dist/web/`. No minification.

app.js stats: 1,525 comment lines (10%), 89 console.* statements, 23% whitespace.

```bash
# Add to build script after cp:
npx esbuild dist/web/public/app.js --minify --drop:console --outfile=dist/web/public/app.js --allow-overwrite
npx esbuild dist/web/public/styles.css --minify --outfile=dist/web/public/styles.css --allow-overwrite
npx esbuild dist/web/public/mobile.css --minify --outfile=dist/web/public/mobile.css --allow-overwrite
```

Expected savings:
| File | Before (gzip) | After (gzip) | Saved |
|------|---------------|-------------|-------|
| app.js | ~126 KB | ~85 KB | ~41 KB (33%) |
| styles.css | ~25 KB | ~18 KB | ~7 KB (28%) |
| mobile.css | ~7 KB | ~5 KB | ~2 KB (29%) |
| **Total** | **~158 KB** | **~108 KB** | **~50 KB** |

---

#### Step 8: Pre-compress static assets at build time
**Impact**: MEDIUM — eliminates per-request CPU compression
**Files**: `package.json` build script, potentially `src/web/server.ts`

```bash
# Add to build script after minification:
for f in dist/web/public/*.{js,css,html}; do
  gzip -9 -k "$f"
  brotli -9 -k "$f"
done
```

Check if `@fastify/static` supports `preCompressed: true` option. If not, serve pre-compressed files via custom Accept-Encoding check.

---

#### Step 9: Extend cache duration for versioned assets
**Impact**: LOW (first load) / HIGH (repeat visits)
**File**: `src/web/server.ts:601`

```js
// BEFORE
maxAge: '1h'

// AFTER
maxAge: '1y',
immutable: true
```

Safe because all assets use `?v=0.1536` cache-busting. First-load unaffected, but all repeat visits serve from disk cache instantly.

---

### Phase 3: Perceived Performance (30-60min, user experience)

#### Step 10: Add loading skeleton
**Impact**: MEDIUM-HIGH — instant visual structure instead of black screen
**File**: `src/web/public/index.html`

Add minimal inline `<style>` + skeleton HTML in `<body>`:

```html
<style>
  .skeleton { display: flex; flex-direction: column; height: 100vh; background: #0a0a0a; }
  .skeleton-header { height: 40px; background: #111; border-bottom: 1px solid #222; }
  .skeleton-terminal { flex: 1; background: #0d0d0d; }
  .app-loaded .skeleton { display: none; }
</style>
<div class="skeleton">
  <div class="skeleton-header"></div>
  <div class="skeleton-terminal"></div>
</div>
```

In `app.js` init() end: `document.body.classList.add('app-loaded');`

---

#### Step 11: Defer terminal creation to after first paint
**Impact**: MEDIUM-HIGH — terminal.open() is heaviest sync call
**File**: `src/web/public/app.js:1545`

```js
init() {
  // ... mobile detection, visibility settings ...
  document.documentElement.classList.remove('mobile-init');

  // Show skeleton immediately, defer heavy terminal init
  requestAnimationFrame(() => {
    this.initTerminal();
    this.connectSSE();
    // ... rest of init
  });
}
```

Lets browser paint header/tabs/skeleton before canvas creation.

---

### Phase 4: DOM + Payload Reduction (1-3 hours)

#### Step 12: Lazy-create modals on first open
**Impact**: HIGH — removes ~600+ DOM nodes, ~60KB hidden HTML
**Files**: `src/web/public/index.html`, `src/web/public/app.js`

12 modals pre-rendered in index.html:
- `helpModal` (lines 227-447)
- `sessionOptionsModal` (lines 448-714) — 266 lines
- `appSettingsModal` (lines 715-900+)
- `createCaseModal`, `mobileCasePickerModal`, `ralphWizardModal`, `killAllModal`, `closeConfirmModal`, `savePresetModal`, `tokenStatsModal`, `filePreviewModal`, notification drawer

Replace each modal's HTML with `<div id="helpModal" class="modal"></div>`. On first open, inject full HTML via template function. Cache after creation.

---

#### Step 13: Batch initial API calls into one endpoint
**Impact**: MEDIUM — reduces 4+ API calls to 1
**Files**: `src/web/server.ts`, `src/web/public/app.js`

Create `GET /api/init-bundle`:
```json
{
  "status": { /* getLightState() */ },
  "cases": [ /* case list */ ],
  "settings": { /* user settings */ }
}
```

Use as SSE init fallback (step 2's timeout). Saves HTTP round trips.

---

#### Step 14: Trim SSE init payload
**Impact**: LOW-MEDIUM — reduces init payload by removing data not needed for first paint
**File**: `src/web/server.ts`

Remove from SSE init event: `taskTree`, `ralphTodos`, `ralphTodoStats` per session. These can be fetched on-demand when user opens a session's details panel.

---

#### Step 15: Enable HTTP/2
**Impact**: MEDIUM — multiplexed loading over single connection
**File**: `src/web/server.ts`

```js
// BEFORE
const server = Fastify({ logger: false });

// AFTER (when HTTPS is enabled)
const server = Fastify({
  logger: false,
  http2: true  // Only works with HTTPS
});
```

Only applicable for `--https` mode. HTTP/2 multiplexing eliminates the 6-connection limit queuing.

---

## Expected Combined Impact

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| First Paint | ~300ms | ~100ms | **-200ms** (skeleton visible instantly) |
| First Contentful Paint | ~400ms | ~200ms | **-200ms** (no mobile.css blocking desktop) |
| Time to Interactive | ~600ms | ~350ms | **-250ms** (fewer API calls, deferred terminal) |
| Total compressed payload | ~241 KB | ~191 KB | **-50 KB (21%)** via minification |
| Init API calls | 6-7 (2 dupes) | 2-3 | **-60%** fewer requests |
| Initial DOM nodes | ~1800+ | ~1200 | **-600** (lazy modals) |

---

## Verification

After each step, verify with Playwright:

```js
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();

// Measure first paint
await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000); // Wait for async data

// Check UI renders correctly
const header = await page.locator('.header').isVisible();
const tabs = await page.locator('.session-tabs').isVisible();
const terminal = await page.locator('.terminal-container').isVisible();
console.log({ header, tabs, terminal });

await browser.close();
```

---

## Files Changed Per Step (for implementation agent)

| Step | Files Modified |
|------|---------------|
| 1 | `index.html` |
| 2 | `app.js` |
| 3 | `app.js` |
| 4 | `app.js` |
| 5 | `app.js` |
| 6 | `index.html`, `package.json` |
| 7 | `package.json` |
| 8 | `package.json`, optionally `server.ts` |
| 9 | `server.ts` |
| 10 | `index.html`, `app.js` |
| 11 | `app.js` |
| 12 | `index.html`, `app.js` |
| 13 | `server.ts`, `app.js` |
| 14 | `server.ts` |
| 15 | `server.ts` |
