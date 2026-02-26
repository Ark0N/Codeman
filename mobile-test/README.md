# Codeman Mobile Test Suite

Comprehensive mobile UI testing for Codeman's web interface using Playwright with dual-engine support (Chromium + WebKit).

**325 tests across 135 devices — all passing.**

## Purpose

Validates Codeman's mobile UI across 135 devices, covering:

- **Keyboard simulation** — 3-layer approach to emulate virtual keyboards in headless browsers
- **Touch/swipe interactions** — CDP trusted events (Chromium) + synthetic fallback (WebKit)
- **Responsive layout** — CSS breakpoints, device classes, safe areas, overflow prevention
- **Visual regression** — Pixel-level screenshot comparison at key breakpoints
- **Accessibility** — WCAG 2.5.5 touch targets, zoom, focus management, semantic HTML

## Quick Start

```bash
# Run all mobile tests
npx vitest run --config mobile-test/vitest.config.ts

# Run a single test file
npx vitest run --config mobile-test/vitest.config.ts mobile-test/keyboard.test.ts

# Quick mode — 6 representative devices, skip full matrix
CI_QUICK=1 npx vitest run --config mobile-test/vitest.config.ts

# Full device matrix only (135 devices)
npx vitest run --config mobile-test/vitest.config.ts mobile-test/device-matrix.test.ts

# Update visual baselines (delete old baselines, re-run)
rm -rf mobile-test/snapshots/*.png
npx vitest run --config mobile-test/vitest.config.ts mobile-test/visual-regression.test.ts
```

## Test Files

| File | Port | Description |
|------|------|-------------|
| `keyboard.test.ts` | 3200 | Virtual keyboard simulation (3-layer: CDP, mock, DOM) |
| `tabs.test.ts` | 3201 | Tab switching, swipe navigation, keyboard nav |
| `subagent-windows.test.ts` | 3202 | Mobile subagent card dimensions, stacking, interactions |
| `settings.test.ts` | 3203 | Settings modal, mobile defaults, persistence |
| `layout.test.ts` | 3204 | General mobile layout, fixed elements, device classes |
| `device-matrix.test.ts` | 3205 | Cross-device parametric tests (135 devices) |
| `visual-regression.test.ts` | 3206 | Screenshot comparison at key breakpoints |
| `accessibility.test.ts` | 3207 | WCAG touch targets, zoom, focus, ARIA |

## Device Matrix

| Category | Width Range | Count | Representative |
|----------|-------------|-------|----------------|
| small-phone | < 375px | ~10 | iPhone SE |
| standard-phone | 375–429px | ~35 | iPhone 14 Pro |
| large-phone | 430–599px | ~10 | iPhone 15 Pro Max |
| small-tablet | 600–767px | ~8 | Nexus 7 |
| standard-tablet | 768–834px | ~8 | iPad Mini |
| large-tablet | 835px+ | ~5 | iPad Pro 11" |

135 devices are defined in `devices.ts` — 68 from Playwright's built-in device profiles plus 67 custom entries for newer devices (iPhone 16/17, Pixel 9, Galaxy S25, iPad Air M2, Surface Pro, etc.).

### How Devices Are Differentiated

Each device is identified by a combination of properties, not just screen size:

| Property | What It Controls | Example Impact |
|----------|-----------------|----------------|
| **Viewport width/height** | CSS breakpoint selection, layout mode | 393px → phone layout, 768px → tablet layout |
| **User agent string** | Body classes (`ios-device`, `safari-browser`) | iOS devices get safe-area padding, Safari gets CSS workarounds |
| **Device scale factor** | Retina rendering (1x, 2x, 3x DPR) | Visual regression baselines are DPR-aware |
| **`isMobile` flag** | Browser viewport behavior | Mobile viewports don't have scrollbars |
| **`hasTouch` flag** | Touch device detection → `touch-device` class | Enables `KeyboardHandler`, `SwipeHandler`, touch target checks |
| **`defaultBrowserType`** | Chromium vs WebKit engine | Dual-engine tests catch Safari CSS rendering differences |

Two devices can have the **same viewport** but behave differently — an iPad Mini (768x1024, Safari UA, iOS, WebKit) and a Galaxy Tab S7 (800x1280, Chrome UA, Android, Chromium) hit different CSS paths due to user agent detection and engine rendering.

### CSS Breakpoints

Matching `app.js MobileDetection` and `mobile.css` media queries:

| Breakpoint | Width | CSS Class | Header | Toolbar |
|------------|-------|-----------|--------|---------|
| **Phone** | ≤ 430px | `device-mobile` | Fixed at top | Fixed at bottom |
| **Tablet** | 431–768px | `device-tablet` | Fixed at top | Relative (in flow) |
| **Desktop** | > 768px | `device-desktop` | Relative (in flow) | Relative (in flow) |

Breakpoint boundaries (430px, 768px) use `max-width` which is **inclusive** — a 430px device is phone, a 768px device is tablet.

## Architecture

```
Test File
  ├─ helpers/server.ts      → WebServer(port, false, testMode=true)
  ├─ helpers/browser.ts      → Playwright Chromium / WebKit
  ├─ helpers/cdp.ts          → Chrome DevTools Protocol (Chromium only)
  ├─ helpers/keyboard-sim.ts → 3-layer keyboard simulation
  ├─ helpers/touch-sim.ts    → CDP trusted touch / synthetic fallback
  ├─ helpers/assertions.ts   → Layout, CSS, accessibility assertions
  ├─ helpers/visual.ts       → pixelmatch screenshot comparison
  └─ devices.ts              → 135-device registry
```

### Keyboard Simulation — 3-Layer Approach

Headless browsers cannot trigger real virtual keyboards. We use three layers, auto-selecting the best available:

| Layer | Method | Engine | Fidelity |
|-------|--------|--------|----------|
| **1. CDP Metrics** | `Emulation.setDeviceMetricsOverride` — shrinks device height, fires real `visualViewport` resize | Chromium only | Highest — triggers `KeyboardHandler.handleViewportResize()` natively |
| **2. VisualViewport Mock** | `addInitScript()` that wraps `visualViewport.height` getter and dispatches resize events | Cross-engine | High — same event path, mocked height value |
| **3. Direct DOM** | Sets `keyboard-visible` class, inline transforms on toolbar/accessory/main | Cross-engine | CSS-level only — skips handler chain |

The unified `showKeyboard(page, height, options?)` tries Layer 1 → 2 → 3 automatically.

### Touch Simulation

| Method | Engine | `isTrusted` | Usage |
|--------|--------|-------------|-------|
| **CDP `Input.dispatchTouchEvent`** | Chromium | `true` | Default for swipe/tap tests |
| **Synthetic `TouchEvent`** | Cross-engine | `false` | WebKit fallback, still triggers handlers |

Swipe simulation includes intermediate move points and timing to satisfy `SwipeHandler` thresholds (≥80px distance, ≤300ms duration, ≤100px vertical drift).

### Visual Regression

Uses `pixelmatch` + `pngjs` (both in devDeps) for pixel-level comparison:

- **Baselines** stored in `mobile-test/snapshots/` (git-tracked)
- **Tolerance**: 0.5% pixel diff (handles anti-aliasing)
- **On failure**: `.actual.png` and `.diff.png` generated (gitignored)
- **Update**: Delete baseline PNGs and re-run — new baselines auto-created

Snapshots at 10 key breakpoints: 320, 375, 390, 393, 430, 440, 600, 768, 834, 1024px.

## Helpers Reference

### `helpers/constants.ts`
All magic numbers centralized: ports, CSS selectors, breakpoint thresholds, keyboard constants, swipe parameters, touch target minimums, body CSS classes, localStorage keys.

### `helpers/server.ts`
`createTestServer(port)` / `stopTestServer(server)` — wraps `WebServer` with `testMode=true`.

### `helpers/browser.ts`
`createDevicePage(device, url, engine?)` — creates a Playwright browser context with the device's viewport, DPR, UA, touch support, navigates to the URL.

### `helpers/cdp.ts`
Low-level CDP wrappers: `getCDP()`, `setVisualViewportHeight()`, `dispatchTouchEvent()`, `setCPUThrottle()`, `setNetworkThrottle()`.

### `helpers/keyboard-sim.ts`
Unified `showKeyboard()` / `hideKeyboard()` with auto layer selection. Also exports per-layer functions for targeted testing.

### `helpers/touch-sim.ts`
Unified `swipe()` / `tap()` with auto CDP/synthetic selection. Also exports per-method functions.

### `helpers/assertions.ts`
- `assertTouchTarget(locator, minSize)` — WCAG 2.5.5 check
- `assertNoHorizontalOverflow(page)` — no scrollbar
- `assertFixedPosition(page, selector)` — computed position check
- `assertDeviceClasses(page, width)` — correct body classes
- `assertAccessibleTouchTargets(page)` — batch scan all interactive elements
- `assertFontSizeNoZoom(page, selector)` — ≥16px input prevention
- `assertZoomNotDisabled(page)` — viewport meta check
- `getCSSProperty()` / `getCSSNumericValue()` — computed style helpers

### `helpers/visual.ts`
`compareScreenshot(page, name, options?)` / `assertScreenshotMatch(page, name, options?)` — pixelmatch-based comparison with baseline management.

## Known Limitations

1. **Headless keyboards are simulated** — No real iOS/Android virtual keyboard; CDP metrics override is the closest approximation
2. **CDP is Chromium-only** — WebKit tests use synthetic touch events (`isTrusted: false`) and viewport mocking instead of CDP
3. **Playwright WebKit ≠ Safari** — Uses the WebKit engine but not the Safari app; catches CSS rendering differences but not Safari-specific app behavior
4. **Visual baselines are OS-dependent** — Linux CI renders differently from macOS; maintain separate baselines per platform
5. **No real device testing** — Would need BrowserStack/Sauce Labs integration for real-device coverage
6. **SSE keeps connections open** — Use `waitUntil: 'domcontentloaded'` not `'networkidle'`

## Dependencies

**Already available** (no install needed):
- `playwright` ^1.58.0
- `pixelmatch` ^6.0.0
- `pngjs` ^7.0.0
- `vitest` ^4.0.18

**Optional** (not installed):
- `@axe-core/playwright` — Full automated WCAG scanning (manual checks implemented instead)

## Adding New Tests

1. Pick a unique port (next: 3208+) — search `const PORT =` across test files
2. Add the port to `helpers/constants.ts` PORTS object
3. Use the standard test pattern:

```typescript
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';

describe('My Test', () => {
  let server;
  beforeAll(async () => { server = await createTestServer(MY_PORT); });
  afterAll(async () => { await stopTestServer(server); await closeAllBrowsers(); });

  it('works on phone', async () => {
    const device = REPRESENTATIVE_DEVICES['standard-phone'];
    const { page, context } = await createDevicePage(device, `http://localhost:${MY_PORT}`);
    try {
      // ... assertions ...
    } finally {
      await context.close();
    }
  });
});
```

4. For new devices: add to `devices.ts` with correct category, viewport, UA, DPR

## Findings Log

Accessibility issues discovered by the test suite (tracked for future fixes):

- **Toolbar buttons undersized**: `btn-claude`, `btn-stop`, `btn-shell`, `btn-settings-mobile`, `btn-case-mobile` are ~26px height (WCAG 2.5.5 minimum is 44px)
- **Notification action buttons**: `btn-notif-action` delete/dismiss buttons are 26x26px
- **Keyboard accessory bar buttons**: 19–23px height (inside 44px bar, but individual buttons are small)
- **Header settings icon on tablet**: 32x32px (below 44px minimum)
- **Text input font sizes**: ~14 inputs inherit default browser font-size below 16px (causes iOS auto-zoom on focus)
