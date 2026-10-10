/**
 * @fileoverview Shared constants, utility functions, and SSE event type registry for all frontend modules.
 *
 * This is the first script loaded in index.html. Every other frontend module depends on the
 * globals defined here: timing constants, Z-index layers, respawn
 * preset definitions, the SSE_EVENTS registry, and shared utilities (escapeHtml,
 * getEventCoords, scheduleBackground, urlBase64ToUint8Array).
 *
 * @globals {function} urlBase64ToUint8Array - VAPID key conversion for Web Push
 * @globals {function} scheduleBackground - scheduler.postTask wrapper (background priority)
 * @globals {function} getEventCoords - Unified mouse/touch coordinate extractor
 * @globals {function} escapeHtml - XSS-safe HTML escaping
 * @globals {object} SSE_EVENTS - Centralized SSE event type constants (157 event types; must match backend src/web/sse-events.ts)
 * @globals {Array} BUILTIN_RESPAWN_PRESETS - Built-in respawn configuration presets
 *
 * @dependency None (first in load order)
 * @loadorder 1 of 15 — constants.js → mobile-handlers.js → voice-input.js → notification-manager.js
 *   → keyboard-accessory.js → input-cjk.js → app.js → terminal-ui.js → respawn-ui.js
 *   → ralph-panel.js → settings-ui.js → panels-ui.js → session-ui.js → ralph-wizard.js
 *   → api-client.js → subagent-windows.js
 */

// Codeman — Shared constants and utility functions for frontend modules

// ═══════════════════════════════════════════════════════════════
// Reverse-proxy base path
// ═══════════════════════════════════════════════════════════════
// When Codeman is served behind a reverse proxy under a sub-path (e.g. /codeman/),
// the server injects `window.__CODEMAN_BASE__` (normalized: '' for root, or '/foo').
// The `<base href>` tag in index.html already rewrites the RELATIVE asset refs, but
// every URL the frontend builds at RUNTIME is root-absolute (`/api/...`, `/ws/...`)
// and root-absolute URLs ignore `<base>` — so those must be prefixed here instead.
// Rather than touch ~190 call sites, all runtime URL construction routes through this
// ONE choke point: `CodemanBase.url()` is the route builder, and a thin wrapper over
// `fetch` applies it transparently. The handful of EventSource/WebSocket sites call
// `CodemanBase.url()` / `CodemanBase.base` explicitly. No-op when mounted at root.
const CodemanBase = (function () {
  // `window` is absent in some unit-test vm contexts that load this module in
  // isolation; guard so the module still evaluates (base degrades to root).
  const _win = typeof window !== 'undefined' ? window : undefined;
  const base = String((_win && _win.__CODEMAN_BASE__) || '').replace(/\/+$/, '');
  /**
   * Prefix a root-absolute application path with the mount base. Leaves untouched:
   * relative paths and fragments/queries (resolved against `<base>`), protocol-relative
   * (`//host`) and absolute URLs, and paths already carrying the prefix.
   */
  function url(path) {
    if (!base) return path;
    if (typeof path !== 'string' || path.length === 0) return path;
    if (path[0] !== '/') return path; // relative / fragment / query
    if (path[1] === '/') return path; // protocol-relative
    if (path === base || path.startsWith(base + '/') || path.startsWith(base + '?')) return path;
    return base + path;
  }
  return { base, url };
})();
if (typeof window !== 'undefined') window.CodemanBase = CodemanBase;

// Transparently prefix root-absolute app paths on every fetch, so the many
// `/api/...` string literals across the frontend need no per-call edit.
if (typeof window !== 'undefined' && CodemanBase.base && typeof window.fetch === 'function') {
  const _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') return _origFetch(CodemanBase.url(input), init);
    if (typeof Request !== 'undefined' && input instanceof Request) {
      try {
        const u = new URL(input.url);
        if (u.origin === location.origin) {
          const prefixed = CodemanBase.url(u.pathname);
          if (prefixed !== u.pathname) {
            return _origFetch(new Request(u.origin + prefixed + u.search + u.hash, input), init);
          }
        }
      } catch (_e) {
        /* not a parseable URL — fall through */
      }
    }
    return _origFetch(input, init);
  };
}

// ═══════════════════════════════════════════════════════════════
// Web Push Utilities
// ═══════════════════════════════════════════════════════════════

/** Convert a base64-encoded VAPID key to Uint8Array for pushManager.subscribe() */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

// Default terminal scrollback (can be changed via settings)
const DEFAULT_SCROLLBACK = 50000;

// Timing constants
const STUCK_THRESHOLD_DEFAULT_MS = 600000;  // 10 minutes - default for stuck detection
const GROUPING_TIMEOUT_MS = 5000;           // 5 seconds - notification grouping window
const NOTIFICATION_LIST_CAP = 100;          // Max notifications in list
const TITLE_FLASH_INTERVAL_MS = 1500;       // Title flash rate
const BROWSER_NOTIF_RATE_LIMIT_MS = 3000;   // Rate limit for browser notifications
const MOBILE_RESIZE_RETRY_MS = 30000;       // Small-viewport resize re-send while a desktop sizing claim is hot
const AUTO_CLOSE_NOTIFICATION_MS = 8000;    // Auto-close browser notifications
const DEFAULT_TOAST_DURATION_MS = 3000;     // How long a corner toast stays by default
const MIN_NOTIFICATION_DURATION_MS = 1000;  // Shortest configurable toast / browser-notification time
const MAX_NOTIFICATION_DURATION_MS = 300000; // Longest configurable toast / browser-notification time
const THROTTLE_DELAY_MS = 100;              // General UI throttle delay
const TERMINAL_CHUNK_SIZE = 32 * 1024;      // 32KB chunks for terminal buffer loading
const TERMINAL_TAIL_SIZE = 1024 * 1024;     // 1MB tail for initial load (more scrollback on tab switch)
const SYNC_WAIT_TIMEOUT_MS = 50;            // Wait timeout for terminal sync
const STATS_POLLING_INTERVAL_MS = 2000;     // System stats polling
const TUI_REDRAW_SETTLE_MS = 400;           // Grace for a TUI to redraw after a real resize, before fetching its buffer

// Z-index base values for layered floating windows
const ZINDEX_SUBAGENT_BASE = 1000;
const ZINDEX_PLAN_SUBAGENT_BASE = 1100;
const ZINDEX_LOG_VIEWER_BASE = 2000;
const ZINDEX_IMAGE_POPUP_BASE = 3000;

// Subagent/floating window layout
const WINDOW_INITIAL_TOP_PX = 120;
const WINDOW_CASCADE_OFFSET_PX = 30;
const WINDOW_MIN_WIDTH_PX = 200;
const WINDOW_MIN_HEIGHT_PX = 200;
const WINDOW_DEFAULT_WIDTH_PX = 300;

// WebGL renderer auto-fallback thresholds.
// _installWebGLLongTaskGuard() observes longtask entries and disables WebGL
// after LONGTASK_COUNT stalls of >= LONGTASK_MS within WINDOW_MS. GRACE_MS
// suppresses the noisy initial-load stalls. STICKY_EXPIRY_MS is how long
// localStorage's webgl-disabled marker survives before we retry WebGL on a
// fresh load (driver/Chrome may have been updated).
const WEBGL_FALLBACK = {
  LONGTASK_MS: 200,
  LONGTASK_COUNT: 3,
  WINDOW_MS: 30000,
  GRACE_MS: 5000,
  STICKY_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Pure rolling-window trip evaluator for the WebGL longtask guard.
 * Mutates `recent` in place (prunes entries older than `now - WINDOW_MS`)
 * and appends each new duration's startTime that meets the threshold.
 * Returns true when the count inside the window reaches `LONGTASK_COUNT`.
 *
 * Exposed on `window` for unit testing — the production guard in app.js
 * inlines this same logic in its PerformanceObserver callback. Splitting it
 * out keeps the threshold math testable without a real PerformanceObserver.
 *
 * @param {number[]} recent - mutable array of startTimes inside the window
 * @param {{startTime: number, duration: number}[]} entries - new longtask entries
 * @param {number} now - performance.now() at evaluation time
 * @param {typeof WEBGL_FALLBACK} [config=WEBGL_FALLBACK] - thresholds
 * @returns {boolean} true if the rolling window has reached the trip count
 */
function evaluateWebGLLongTaskTrip(recent, entries, now, config = WEBGL_FALLBACK) {
  for (const entry of entries) {
    if (entry.duration >= config.LONGTASK_MS) recent.push(entry.startTime);
  }
  while (recent.length && now - recent[0] > config.WINDOW_MS) recent.shift();
  return recent.length >= config.LONGTASK_COUNT;
}

/**
 * Pure decision for whether to skip the WebGL renderer at terminal init, and
 * whether to clear the auto-fallback sticky marker. Keeps the interaction
 * between device type, URL params, the sticky marker, and the user's settings
 * toggle in one testable place (terminal-ui.js calls this).
 *
 * Precedence (desktop only — mobile always skips):
 *   1. user toggle OFF        -> skip (one-shot opt-out, sticky untouched)
 *   2. ?nowebgl               -> skip (one-shot opt-out, sticky untouched)
 *   3. ?webgl=force           -> enable + clear stale sticky marker
 *   4. toggle ON / untouched  -> respect the auto-fallback sticky marker
 *
 * A stored `true` is treated like the untouched default here: the checkbox
 * ships checked on desktop, so any unrelated settings save stores `true` —
 * letting it clear the marker would permanently defeat the GPU-stall
 * auto-fallback safety net. The marker is only retired by ?webgl=force or by
 * a real OFF->ON toggle flip, which saveAppSettings() detects at save time.
 *
 * @param {{deviceType?: string, noWebglParam?: boolean, forceParam?: boolean,
 *          stickyDisabled?: boolean, userPrefEnabled?: (boolean|undefined)}} [input]
 * @returns {{skip: boolean, clearSticky: boolean}}
 */
function shouldSkipWebGL(input = {}) {
  if (input.deviceType !== 'desktop') return { skip: true, clearSticky: false };
  if (input.userPrefEnabled === false) return { skip: true, clearSticky: false };
  if (input.noWebglParam) return { skip: true, clearSticky: false };
  if (input.forceParam) return { skip: false, clearSticky: true };
  return { skip: !!input.stickyDisabled, clearSticky: false };
}

// Expose for tests. `const` declarations at the top of a non-module script
// are global lexical bindings but not `window` properties, so explicit
// assignment is the test-visible API surface.
// Desktop tab-overflow policy: auto-wrap the session tabs to a second row when
// they overflow one row (and the user hasn't pinned the manual two-row layout).
function shouldAutoWrapTabs(input) {
  if (!input || input.deviceType !== 'desktop') return false;
  if (input.manualTwoRows) return false;
  if ((input.tabCount || 0) < 2) return false;
  // A box in the strip already wraps inside itself (a case cluster wider than the
  // whole strip): the strip has rows although nothing overflows.
  if (input.innerWrap) return true;

  const scrollWidth = Number(input.scrollWidth) || 0;
  const clientWidth = Number(input.clientWidth) || 0;
  return scrollWidth > clientWidth + 1;
}

function resolveTabOrientation(input) {
  if (!input || input.setting !== 'vertical') return 'horizontal';
  if (input.deviceType === 'mobile') return 'horizontal';
  return 'vertical';
}

const TAB_RAIL_MIN_WIDTH = 208;
const TAB_RAIL_DEFAULT_WIDTH = 256;
/** Detailed rows carry a third line, and it ellipsizes at 256px — see the
    rich sidebar's own 300px column. 320px is the existing Wide preset. */
const TAB_RAIL_RICH_DEFAULT_WIDTH = 320;
const TAB_RAIL_MAX_WIDTH = 360;

function resolveTabRailWidth(input = {}) {
  const viewportWidth = Number(input.viewportWidth);
  const mainWidth = Number(input.mainWidth);
  const minTerminalWidth = Number(input.minTerminalWidth);
  const limits = [TAB_RAIL_MAX_WIDTH];
  if (Number.isFinite(viewportWidth) && viewportWidth > 0) limits.push(Math.floor(viewportWidth * 0.4));
  if (Number.isFinite(mainWidth) && mainWidth > 0 && Number.isFinite(minTerminalWidth) && minTerminalWidth > 0) {
    limits.push(Math.floor(mainWidth - minTerminalWidth));
  }
  const effectiveMax = Math.max(TAB_RAIL_MIN_WIDTH, Math.min(...limits));
  const requested = Number(input.width);
  const width = Number.isFinite(requested) ? requested : TAB_RAIL_DEFAULT_WIDTH;
  return Math.round(Math.min(effectiveMax, Math.max(TAB_RAIL_MIN_WIDTH, width)));
}

function resolveTabRailKeyboardWidth(input = {}) {
  let width;
  if (input.key === 'Home') width = TAB_RAIL_MIN_WIDTH;
  else if (input.key === 'End') width = TAB_RAIL_MAX_WIDTH;
  // Enter resets to the caller's effective default (the rich rail's is the
  // Wide preset, not 256 — see _defaultTabRailWidth); absent, the base default.
  else if (input.key === 'Enter') width = Number(input.defaultWidth) || TAB_RAIL_DEFAULT_WIDTH;
  else if (input.key === 'ArrowLeft' || input.key === 'ArrowRight') {
    const direction = input.key === 'ArrowLeft' ? -1 : 1;
    width = (Number(input.currentWidth) || TAB_RAIL_DEFAULT_WIDTH) + direction * (input.shiftKey ? 32 : 8);
  } else return null;
  return resolveTabRailWidth({ ...input, width });
}

// Sliver of the neighbouring tab left visible when the strip scrolls a tab into
// view. Landing a tab flush against the edge reads as "this is the last one";
// the gap is what tells the user there is more strip to swipe to.
const TAB_SCROLL_REVEAL_PX = 16;

// Phone/tablet tab-strip scroll policy (issue #257). Those breakpoints scroll
// the strip horizontally (desktop wraps to a second row instead and never
// scrolls), so the active tab can sit entirely outside the visible slice with
// no way back except a swipe the user may not know is possible.
//
// Returns the scrollLeft that puts the tab inside the window, clamped to the
// scrollable range, and returns the CURRENT scrollLeft when the tab is already
// visible: callers compare and skip the write, so an already-correct strip is
// never nudged. Pure: the caller measures, this decides.
function computeTabScrollLeft(input) {
  const scrollWidth = Number(input?.scrollWidth) || 0;
  const clientWidth = Number(input?.clientWidth) || 0;
  const maxScroll = Math.max(0, scrollWidth - clientWidth);
  if (maxScroll === 0 || clientWidth <= 0) return 0;

  const pad = input?.padding == null ? TAB_SCROLL_REVEAL_PX : Number(input.padding) || 0;
  const tabLeft = Number(input?.tabLeft) || 0;
  const tabWidth = Number(input?.tabWidth) || 0;
  const tabRight = tabLeft + tabWidth;
  const viewLeft = Math.min(Math.max(Number(input?.scrollLeft) || 0, 0), maxScroll);
  const viewRight = viewLeft + clientWidth;

  let target = viewLeft;
  if (tabWidth + pad >= clientWidth) {
    // Tab is as wide as the window (long session name on a narrow phone):
    // there is no position that shows all of it plus padding, so align its
    // start, since the name matters more than the trailing badges.
    target = tabLeft;
  } else if (tabLeft - pad < viewLeft) {
    target = tabLeft - pad;
  } else if (tabRight + pad > viewRight) {
    target = tabRight + pad - clientWidth;
  }
  return Math.min(Math.max(Math.round(target), 0), maxScroll);
}

// Session lineage lines: geometry for the lines joining a tab to the tabs it
// spawned (a worker started through the codeman agent skill, which passes its own
// id as parentSessionId). Pure: the caller measures and appends, this decides.
//
// ONE TREE PER SPAWNING TAB. Every family is drawn, the selected tab's emphasized
// (session-lineage.js). Every route starts at the PARENT and ends at one child, so
// a parent's routes share their first stretch exactly: overlaid, they read as one
// trunk with a branch per child, and a dashed (working) route stays in phase with
// its siblings along the shared part.
//
// ⚠ ROUTES RUN IN THE GAPS, NEVER THROUGH A TAB. This replaced one bezier per
// child hanging below the strip, which in a wrapped strip crossed every lower
// row's labels and the terminal text (owner screenshot 2026-10-06: a parent on
// row 3 with ten children, "too confusing"). A route now moves horizontally only
// inside a row gap, and vertically only along a tab's own stem (its bottom edge to
// the gap right under it) or along the SPINE, a channel left of every row that
// joins the gaps of different rows. styles.css reserves that room
// (`.session-tabs.lineage-tree`: a wider row gap, bottom padding for the last
// row's gap, and the spine channel on the left of a wrapped strip).
//
// The channel is at the strip's left edge, except where a tab arrangement puts
// something there: grouped by state, the edge holds the label column and the
// channel opens between the labels and the tabs. session-lineage.js measures it
// and passes its left edge as `spineLeft`; without one it is the strip's edge.
//
// Rows come from computeLineageRows() over EVERY tab in the strip, not only the
// endpoints: a row's gap sits under its TALLEST tab (the active tab is 2px
// taller), or siblings in one row would hang their bus at different heights.
//
// computeLineageTree() returns null when the parent cannot be drawn (missing or
// degenerate rect, scrolled out of the strip); a child that cannot be drawn is
// left out of `routes`. `.session-tabs` scrolls, so a scrolled-out tab still HAS a
// rect, lying over the logo or the header buttons. Skipping is honest; clamping
// would point at a tab that is not there.
//
// A child is also left out when its route has nowhere to run: rows whose spans
// overlap are one row (no gap between them), a row with no gap under it routes
// nothing, and a route that would still cross a tab is dropped whole. So no tab
// arrangement can put a line through a tab; a layout without the reserved room
// loses lines instead.
const LINEAGE_CORNER_RADIUS_PX = 10;
// Families drawn together take separate lanes: gap lines this far apart, spines
// LINEAGE_SPINE_STEP_PX apart.
const LINEAGE_LANE_STEP_PX = 3.5;
// Every family is drawn at once, and a 12px row gap only fits this many lanes at
// LINEAGE_LANE_STEP_PX; session-lineage.js cycles families through them.
const LINEAGE_MAX_LANES = 3;
const LINEAGE_SPINE_INSET_PX = 6;
const LINEAGE_SPINE_STEP_PX = 4;
// The last row has no row below it; with no strip rect to measure, its gap is
// taken to be this deep.
const LINEAGE_LAST_GAP_PX = 12;
// Narrower than this, the space between two rows is not a gap a route can run in.
const LINEAGE_MIN_GAP_PX = 2;
const LINEAGE_ROW_TOLERANCE_PX = 6;
const LINEAGE_STRIP_TOLERANCE_PX = 4;
// How far the vertical rail's track sits in from the rail's left edge. It has to
// clear the VIEWPORT edge, not just the tabs, or the line reads as a thread pinned
// to the window frame. The rail reserves the channel itself
// (`--lineage-vertical-gutter` on the rail's .session-tabs), and the track is
// still clamped to stay left of every endpoint.
const LINEAGE_VERTICAL_TRACK_INSET_PX = 10;
const LINEAGE_VERTICAL_LANE_STEP_PX = 4;
const LINEAGE_VERTICAL_ANCHOR_CLEARANCE_PX = 4;
// Lineage palette, assigned per SPAWNING TAB in first-seen order and cycled
// (session-lineage.js). Every line leaving one tab shares its colour however many
// workers it spawns; a child that spawns in turn gets its own for the lines below it.
// The empty FIRST entry means "no override": the CSS then falls back to --session-blue,
// which every skin block tunes for its own background, so a lone family keeps the
// skin-aware blue that shipped in 1.18.2. The fixed entries are deliberately vivid
// (owner call 2026-08-15: matrix green, pinkish, violet, red, turquoise "and so on").
const LINEAGE_COLORS = ['', '#00ff66', '#ff5ea8', '#a78bfa', '#ff5252', '#2dd4bf', '#ffa940'];

/** A rect normalized to numbers with its edges and center, or null if unusable. */
function lineageRect(rect) {
  if (!rect) return null;
  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    cx: left + width / 2,
    cy: top + height / 2,
  };
}

/**
 * Group tab rects into the strip's visual rows, top to bottom. A row spans from its
 * highest top to its LOWEST bottom, so a taller tab (the active one) sets the row's
 * gap for everyone in it.
 *
 * ⚠ Rows never overlap. Tabs whose spans overlap are in one row however far apart
 * their tops are: case clusters stack and centre tabs inside their boxes, and two
 * overlapping "rows" put the gap of one in the middle of the other's tabs.
 */
function computeLineageRows(rects) {
  const sorted = [];
  for (const raw of rects || []) {
    const r = lineageRect(raw);
    if (r) sorted.push(r);
  }
  sorted.sort((a, b) => a.top - b.top);
  const rows = [];
  for (const r of sorted) {
    // Sorted by top, so only the last row can take this rect, and merging into it
    // keeps every earlier row clear of it.
    const row = rows[rows.length - 1];
    if (row && (r.top < row.bottom || r.top - row.top <= LINEAGE_ROW_TOLERANCE_PX)) {
      row.bottom = Math.max(row.bottom, r.bottom);
    } else {
      rows.push({ top: r.top, bottom: r.bottom });
    }
  }
  return rows;
}

/** Does an axis-aligned segment pass through the inside of a rect? Touching an edge is fine. */
function lineageSegmentCrosses([x1, y1], [x2, y2], r) {
  const eps = 0.5;
  if (Math.max(x1, x2) <= r.left + eps || Math.min(x1, x2) >= r.right - eps) return false;
  return Math.max(y1, y2) > r.top + eps && Math.min(y1, y2) < r.bottom - eps;
}

/**
 * An orthogonal polyline as an SVG path, each corner rounded by up to `radius`
 * (never more than half of either segment, so short stems stay short). Repeated and
 * collinear points are dropped first, so a degenerate corner draws nothing odd.
 */
function lineagePolylinePath(points, radius) {
  const pts = [];
  for (const p of points) {
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 0.5 && Math.abs(prev[1] - p[1]) < 0.5) continue;
    const before = pts[pts.length - 2];
    if (before && prev) {
      const cross = (prev[0] - before[0]) * (p[1] - prev[1]) - (prev[1] - before[1]) * (p[0] - prev[0]);
      if (Math.abs(cross) < 0.01) pts.pop();
    }
    pts.push(p);
  }
  if (pts.length < 2) return null;
  let d = `M ${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const lenIn = Math.hypot(x1 - x0, y1 - y0);
    const lenOut = Math.hypot(x2 - x1, y2 - y1);
    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    if (!(r > 0.5)) {
      d += ` L ${r1(x1)} ${r1(y1)}`;
      continue;
    }
    const ax = x1 - ((x1 - x0) / lenIn) * r;
    const ay = y1 - ((y1 - y0) / lenIn) * r;
    const bx = x1 + ((x2 - x1) / lenOut) * r;
    const by = y1 + ((y2 - y1) / lenOut) * r;
    d += ` L ${r1(ax)} ${r1(ay)} Q ${r1(x1)} ${r1(y1)} ${r1(bx)} ${r1(by)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${r1(last[0])} ${r1(last[1])}`;
}

/**
 * Routes from one parent tab to each of its children.
 *
 * input: { parent, children: [{ id, rect }], strip?, tabs?, spineLeft?,
 *          orientation?, lane?, laneCount?, radius? }. `tabs` is every tab rect in
 *          the strip (rows are derived from it); `spineLeft` is the left edge of the
 *          spine channel (default: the strip's left edge); `lane`/`laneCount`
 *          separate families drawn together.
 * Returns { routes: [{ id, points, d, endX, endY }] } or null.
 */
function computeLineageTree(input) {
  const parent = lineageRect(input?.parent);
  if (!parent) return null;
  const strip = lineageRect(input?.strip);
  const orientation = input?.orientation === 'vertical' ? 'vertical' : 'horizontal';
  const laneCount = Math.max(1, Math.floor(Number(input?.laneCount)) || 1);
  const lane = Math.max(0, Math.min(laneCount - 1, Math.floor(Number(input?.lane)) || 0));
  const radius = Number.isFinite(Number(input?.radius)) ? Math.max(0, Number(input.radius)) : LINEAGE_CORNER_RADIUS_PX;
  const children = [];
  for (const child of input?.children || []) {
    const rect = lineageRect(child?.rect);
    if (rect) children.push({ id: child.id, rect });
  }

  const tol = LINEAGE_STRIP_TOLERANCE_PX;
  const inStripY = (r) => !strip || (r.cy >= strip.top - tol && r.cy <= strip.bottom + tol);
  const inStripX = (r) => !strip || (r.cx >= strip.left - tol && r.cx <= strip.right + tol);
  const routes = [];

  if (orientation === 'vertical') {
    // The rail: one track down the empty left gutter, shared by every sibling.
    if (!inStripY(parent)) return null;
    const visible = children.filter((c) => inStripY(c.rect));
    if (visible.length === 0) return { routes };
    const minLeft = Math.min(parent.left, ...visible.map((c) => c.rect.left));
    const base = strip ? strip.left : minLeft - LINEAGE_VERTICAL_TRACK_INSET_PX * 2;
    const trackX = Math.min(
      base + LINEAGE_VERTICAL_TRACK_INSET_PX + lane * LINEAGE_VERTICAL_LANE_STEP_PX,
      minLeft - LINEAGE_VERTICAL_ANCHOR_CLEARANCE_PX
    );
    for (const { id, rect } of visible) {
      const points = [
        [parent.left, parent.cy],
        [trackX, parent.cy],
        [trackX, rect.cy],
        [rect.left, rect.cy],
      ];
      const d = lineagePolylinePath(points, radius);
      if (d) routes.push({ id, points: roundPoints(points), d, endX: r1(rect.left), endY: r1(rect.cy) });
    }
    return { routes };
  }

  if (!inStripX(parent) || !inStripY(parent)) return null;
  const visible = children.filter((c) => inStripX(c.rect) && inStripY(c.rect));
  if (visible.length === 0) return { routes };

  const rows = computeLineageRows([...(input?.tabs || []), parent, ...visible.map((c) => c.rect)]);
  const rowOf = (r) => rows.findIndex((row) => r.cy >= row.top - tol && r.cy <= row.bottom + tol);
  const laneOffset = (lane - (laneCount - 1) / 2) * LINEAGE_LANE_STEP_PX;
  // Y of the gap under row i, this family's lane. The offset is clamped so a busy
  // gap never pushes a lane into the tabs on either side of it. Null when there is
  // no gap: the row is not found, or the next row starts (nearly) where it ends.
  const gapUnder = (i) => {
    const row = rows[i];
    if (!row) return null;
    const next = rows[i + 1];
    let bottom;
    if (next) bottom = next.top;
    else if (strip && strip.bottom > row.bottom + 1) bottom = strip.bottom;
    else bottom = row.bottom + LINEAGE_LAST_GAP_PX;
    if (!(bottom - row.bottom >= LINEAGE_MIN_GAP_PX)) return null;
    const half = Math.max(0, (bottom - row.bottom) / 2 - 1);
    return (row.bottom + bottom) / 2 + Math.max(-half, Math.min(half, laneOffset));
  };
  const pRow = rowOf(parent);
  const gp = gapUnder(pRow);
  if (gp === null) return { routes };
  // The spine runs from one row's gap to another's, so it only ever passes BESIDE
  // rows after the first, and only their tabs bound it. The first row may start
  // left of the channel (grouped by state it starts after the brand and a label
  // of its own width), and clamping to it would pull the spine back over the
  // label column.
  const lowerLefts = [parent, ...visible.map((c) => c.rect), ...(input?.tabs || []).map(lineageRect)]
    .filter((r) => r && rowOf(r) > 0)
    .map((r) => r.left);
  const minLeft = lowerLefts.length
    ? Math.min(...lowerLefts)
    : Math.min(parent.left, ...visible.map((c) => c.rect.left));
  const channelLeft = Number(input?.spineLeft);
  const spineBase = strip
    ? Math.max(strip.left, Number.isFinite(channelLeft) ? channelLeft : strip.left)
    : minLeft - LINEAGE_SPINE_INSET_PX * 2;
  const spineX = Math.min(spineBase + LINEAGE_SPINE_INSET_PX + lane * LINEAGE_SPINE_STEP_PX, minLeft - 2);

  // Every tab a route must stay out of. A segment can only cross one if the rows
  // above failed to describe the layout, so this is a backstop that drops the
  // route whole rather than drawing it through a tab.
  const obstacles = [parent, ...visible.map((c) => c.rect), ...(input?.tabs || []).map(lineageRect)].filter(Boolean);
  for (const { id, rect } of visible) {
    const cRow = rowOf(rect);
    const gc = gapUnder(cRow);
    if (gc === null) continue;
    const points =
      cRow === pRow
        ? [
            [parent.cx, parent.bottom],
            [parent.cx, gp],
            [rect.cx, gp],
            [rect.cx, rect.bottom],
          ]
        : [
            [parent.cx, parent.bottom],
            [parent.cx, gp],
            [spineX, gp],
            [spineX, gc],
            [rect.cx, gc],
            [rect.cx, rect.bottom],
          ];
    // The rounded corners cut inside each turn by a few pixels at most
    // (lineagePolylinePath), so the segments are what has to clear the tabs.
    const blocked = points.some((p, i) => i > 0 && obstacles.some((r) => lineageSegmentCrosses(points[i - 1], p, r)));
    if (blocked) continue;
    const d = lineagePolylinePath(points, radius);
    if (d) routes.push({ id, points: roundPoints(points), d, endX: r1(rect.cx), endY: r1(rect.bottom) });
  }
  return { routes };
}

function roundPoints(points) {
  return points.map(([x, y]) => [r1(x), r1(y)]);
}

// One decimal is plenty for a screen-space path and keeps the `d` string short.
function r1(n) {
  return Math.round(n * 10) / 10;
}

// COD-134 — Terminal WebSocket reconnect policy.
//
// Decide what to do after a terminal WebSocket closes, given the close `code`
// and `attempt` (0-based count of consecutive reconnects already made):
//   - transient closes (code < 4004: 1000/1001/1005/1006/etc.) → 'reconnect'
//     with exponential backoff (0 on the first attempt; the caller adds jitter),
//     250ms → 500 → 1000 → ... capped at 10s.
//   - 4004 (session not found) / 4009 (session terminated) → 'give-up': the
//     session is gone, retrying only wastes connections.
//   - 4008 (too many connections) and any other code >= 4004 → 'retry-fallback':
//     show the HTTP fallback but keep retrying on a bounded 5s timer so the
//     transport returns to WS once the transient condition clears (un-stick).
// Pure: no DOM, no side effects.
function planWsReconnect(code, attempt) {
  if (code === 4004 || code === 4009) {
    return { action: 'give-up', delayMs: 0 };
  }
  if (code >= 4004) {
    return { action: 'retry-fallback', delayMs: 5000 };
  }
  const delayMs = attempt <= 0 ? 0 : Math.min(250 * Math.pow(2, attempt - 1), 10000);
  return { action: 'reconnect', delayMs };
}

// Connection-loss UI policy.
//
// With the service worker serving the cached app shell, Codeman still *renders*
// when the server is unreachable (phone off the tailnet, VPN down, server
// stopped): a dashboard with no sessions and an 8px red dot in the header
// corner. That reads as "there are no sessions", not "you are not connected".
// This decides what the app surfaces instead:
//
//   'overlay': full-screen "can't reach Codeman". Used while the page has
//               never loaded server state, where the UI behind it is empty
//               anyway, so blocking it costs nothing and explains everything.
//   'banner':  non-blocking bar under the header. Used once state HAS loaded,
//               so the terminal scrollback stays readable while the link is down.
//   'hidden':  connected, or still inside the grace window.
//
// Grace: a COM deploy restarts the server and SSE is back in ~200ms. Shouting
// on every deploy trains the user to ignore the warning, so a transport that is
// merely *not yet connected* gets CONNECTION_LOSS_GRACE_MS to recover.
// `navigator.onLine === false` skips the grace entirely: the device itself is
// saying there is no network, which is never a 200ms blip.
//
// Pure: no DOM, no timers, no side effects. `now` is passed in.
const CONNECTION_LOSS_GRACE_MS = 2500;

function computeConnectionLossUi(input) {
  const {
    isOnline = true,
    status = 'connected',
    everLoaded = false,
    downSince = null,
    now = 0,
    nextRetryAt = null,
    overlayDismissed = false,
    retryPending = false,
  } = input || {};

  const hidden = { mode: 'hidden', kind: 'connected', title: '', detail: '', retryInSec: null };

  // The browser's own offline flag outranks the transport state: no network
  // means no reconnect is coming until it returns.
  const hardOffline = !isOnline || status === 'offline';
  if (!hardOffline) {
    if (status === 'connected') return hidden;
    const downMs = downSince == null ? 0 : Math.max(0, now - downSince);
    if (downMs < CONNECTION_LOSS_GRACE_MS) return { ...hidden, kind: 'connecting' };
  }

  // Dismissing the overlay ("show cached view") demotes it to the banner for
  // the rest of this outage, never back to invisible.
  const mode = everLoaded || overlayDismissed ? 'banner' : 'overlay';
  // A retry the user just triggered has no scheduled time; the caller renders
  // an indeterminate "Retrying…" for null.
  const retryInSec =
    retryPending || nextRetryAt == null ? null : Math.max(0, Math.ceil((nextRetryAt - now) / 1000));

  if (hardOffline) {
    return {
      mode,
      kind: 'offline',
      title: 'No network connection',
      detail: 'This device is offline. Codeman is showing the last cached view.',
      retryInSec,
    };
  }
  return {
    mode,
    kind: 'unreachable',
    title: "Can't reach the Codeman server",
    detail:
      'This device has a network, but the Codeman server is not answering. ' +
      'If you reach Codeman over Tailscale or a VPN, check that it is connected.',
    retryInSec,
  };
}

// SSE staleness policy: is this stream a zombie?
//
// An EventSource that stops delivering does not always error. A proxy that
// idle-closed the connection, a laptop resumed from sleep, a tailnet
// reconnect: `onerror` never fires, the header dot stays green, and every
// SSE-driven surface (tab status dots, sessions created on another device,
// renames) freezes until the user reloads. The server writes a
// `sse:heartbeat` frame every 15s, so silence longer than three of them means
// the stream is dead even though the transport still claims otherwise.
//
// Stale ONLY when the transport believes it is 'connected': the other states
// already have the reconnect/backoff machinery running, and re-firing on top
// of them would stack reconnects. That guard is also the loop breaker: a
// forced reconnect leaves 'connected' immediately, so the watchdog cannot
// fire again while one is in flight. `navigator.onLine === false` is not
// staleness either; there is nothing to reconnect to yet.
//
// Pure: no DOM, no timers, no side effects. `now` is passed in.
const SSE_STALE_TIMEOUT_MS = 45000; // three missed 15s heartbeats

function computeSseStale(input) {
  const {
    lastMessageAt = null,
    now = 0,
    status = 'connected',
    isOnline = true,
    timeoutMs = SSE_STALE_TIMEOUT_MS,
  } = input || {};
  if (!isOnline || status !== 'connected') return false;
  // No frame has ever arrived: `init` lands on connect, so this is a stream
  // that has not opened yet rather than one that went quiet.
  if (typeof lastMessageAt !== 'number' || !(lastMessageAt > 0)) return false;
  return now - lastMessageAt >= timeoutMs;
}

// Home-screen session order: one comparator for both overviews.
//
// The phone overview (mobile-overview.js) and the desktop tab rail
// (home-sessions.js) list the same sessions, so they answer the same question
// and must answer it the same way: "which of these wants me next?".
//
//   1. Anything blocked on a human first (red question, then error, then a
//      yellow idle prompt), longest-blocked at the top: a session that has been
//      sitting on a permission dialog for 20 minutes is starving, one that
//      raised it 5 seconds ago is not.
//   2. Then whatever is running, LONGEST-RUNNING first, since that is the turn most
//      likely to be finished, or stuck, by the time you look.
//   3. Then everything quiet, MOST RECENTLY quiet first: when nothing is
//      running, the session that just finished is the one you came back for,
//      and the one you abandoned yesterday sinks.
//
// So the tiebreak flips direction halfway down the list, and that is the point:
// for a state something is still doing, longer = more urgent; for a state
// something has stopped in, more recent = more relevant.
//
// Pure: no DOM, no clock (every input is an epoch-ms stamp already on the
// session payload), no `this`. Unit-tested in test/session-overview-order.test.ts.
const SESSION_ACTIVITY_RANK = {
  needs: 0,
  error: 1,
  waiting: 2,
  working: 3,
  idle: 4,
  done: 5,
};

/** States still in progress, where the OLDEST stamp sorts first. */
const SESSION_ACTIVITY_OLDEST_FIRST = ['needs', 'error', 'waiting', 'working'];

/**
 * When the row entered the state it is in.
 *
 * For everything quiet that is `lastActivityAt`, the last byte the pane printed:
 * a Claude pane sitting at its composer prints nothing, so the end of the last
 * turn is exactly when it went quiet.
 *
 * A WORKING pane is the opposite: it repaints about once a second, so its
 * last-activity stamp is always "now" and would rank every running turn as
 * freshly started. Its real start is the pane's last Enter (`lastSubmitAt`),
 * persisted server-side and therefore stable across a Codeman restart. A
 * working pane that has never submitted (spawned with its prompt on the command
 * line, or an external CLI) falls back to last activity, which puts it at the
 * short end of the running group rather than falsely at the head of it.
 */
function sessionActivityAnchor(row) {
  const activeAt = Number(row && row.lastActivityAt) || 0;
  if (row && row.state === 'working') return Number(row.lastSubmitAt) || activeAt;
  return activeAt;
}

/**
 * Sort comparator for one overview row against another.
 * @param {{state: string, lastActivityAt?: number, lastSubmitAt?: number, orderIndex?: number}} a
 * @param {{state: string, lastActivityAt?: number, lastSubmitAt?: number, orderIndex?: number}} b
 */
function compareSessionActivity(a, b) {
  const rankA = SESSION_ACTIVITY_RANK[a.state];
  const rankB = SESSION_ACTIVITY_RANK[b.state];
  const rank = (rankA === undefined ? 99 : rankA) - (rankB === undefined ? 99 : rankB);
  if (rank !== 0) return rank;

  const atA = sessionActivityAnchor(a);
  const atB = sessionActivityAnchor(b);
  if (atA !== atB) {
    // A row with no stamp at all gets no opinion: it sorts last either way
    // rather than claiming to be the oldest (0) thing on the screen.
    if (!atA) return 1;
    if (!atB) return -1;
    return SESSION_ACTIVITY_OLDEST_FIRST.includes(a.state) ? atA - atB : atB - atA;
  }

  // Equal stamps (or two unstamped rows): fall back to the user's tab order so
  // the list is deterministic and cannot shuffle between renders.
  const orderA = Number.isFinite(a.orderIndex) ? a.orderIndex : Number.MAX_SAFE_INTEGER;
  const orderB = Number.isFinite(b.orderIndex) ? b.orderIndex : Number.MAX_SAFE_INTEGER;
  return orderA - orderB;
}

/** Copy of `rows`, in overview order. Never sorts in place, so callers keep their array. */
function sortSessionsByActivity(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort(compareSessionActivity);
}

// Tab grouping by state (`tabArrangement: 'state'`, Discussion #426 option C).
//
// The tab list answers "who wants me?" the way the home screens do: a row (the
// header strip) or a section (the flat side rail, the sidebar) per state, most
// urgent on top. The states are the home screens' own, from
// `_mobileOverviewState()` (mobile-overview.js); this only folds the six into
// four groups a strip can hold:
//
//   needs   red: a permission or question dialog is blocking the agent. A
//           failed session joins it, since it also needs a human and the home
//           screens rank it right below.
//   waiting yellow: the agent finished its turn and is waiting on you.
//   working a turn is running.
//   idle    everything quiet: idle, ended, and an agent that exited inside a
//           live pane (#446), which may still read as working on screen but is
//           running nothing. Web tabs close the group.
//
// Applied as the flex `order` property, never by reordering the DOM, the same
// design as the sorted rail (`_tabRailSortOrder`, app.js): `#sessionTabs` stays
// in `sessionOrder`, so Alt+N, drag-and-drop and the keyboard walk keep reading
// the list they always read, and a state change moves one inline style instead
// of rebuilding the strip. Each group owns a band of `TAB_TRIAGE_STRIDE` order
// values: its heading at the start of the band, its rows after it, its web tabs
// after those and the line break that ends the header row at the very end.
//
// Pure: no DOM, no `this`. Unit-tested in test/tab-triage.test.ts.
// `quiet` groups keep their heading element (it anchors the row and holds the
// row's place beside the brand) but draw no text: everything quiet is the
// default state of a tab, so naming it only adds noise.
const TAB_TRIAGE_GROUPS = [
  { key: 'needs', label: 'Needs you' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'working', label: 'Working' },
  { key: 'idle', label: 'Idle', quiet: true },
];

const TAB_TRIAGE_GROUP_OF_STATE = {
  needs: 'needs',
  error: 'needs',
  waiting: 'waiting',
  working: 'working',
  idle: 'idle',
  done: 'idle',
};

const TAB_TRIAGE_STRIDE = 10000;
/** Offset of a group's web tabs inside its band, past any plausible session count. */
const TAB_TRIAGE_WEB_OFFSET = 5000;

/**
 * Which group a session belongs to.
 * @param {string} state a `_mobileOverviewState()` value
 * @param {boolean} exited the agent inside the pane has exited (`_mobileOverviewExit()` non-null)
 * @returns {'needs'|'waiting'|'working'|'idle'}
 */
function tabTriageGroupFor(state, exited) {
  const group = TAB_TRIAGE_GROUP_OF_STATE[state] || 'idle';
  return exited && group === 'working' ? 'idle' : group;
}

/**
 * Order values and visible groups for one pass.
 *
 * @param {Array<{id: string, state: string, exited?: boolean, pos?: number}>} rows
 *   live sessions; `pos` ranks a row inside its group (tab order on the header
 *   strip, the activity sort's position on a sorted rail). Rows without one keep
 *   the order they were passed in.
 * @param {Array<string>} webviewIds open web tabs, in their own tab order
 * @param {{reverse?: boolean}} [options] `reverse` puts the groups the other
 *   way up (`tabStateOrder: 'urgent-last'`): idle first, needs you last, for a
 *   strip read from the bottom. Rows inside a group keep their order.
 * @returns {{
 *   order: Map<string, number>,
 *   webOrder: Map<string, number>,
 *   groups: Array<{key: string, label: string, quiet: boolean, count: number, headOrder: number, breakOrder: number}>
 * }} `groups` lists only the non-empty groups, in display order (most urgent
 *   first, or last with `reverse`).
 */
function computeTabTriageLayout(rows, webviewIds, options) {
  const list = Array.isArray(rows) ? rows : [];
  const webs = Array.isArray(webviewIds) ? webviewIds : [];
  const sequence = options && options.reverse ? TAB_TRIAGE_GROUPS.slice().reverse() : TAB_TRIAGE_GROUPS;
  const baseOf = {};
  const counts = {};
  sequence.forEach((group, i) => {
    baseOf[group.key] = (i + 1) * TAB_TRIAGE_STRIDE;
    counts[group.key] = 0;
  });

  const placed = list
    .filter((row) => row && typeof row.id === 'string')
    .map((row, i) => ({
      id: row.id,
      group: tabTriageGroupFor(row.state, !!row.exited),
      pos: Number.isFinite(row.pos) ? row.pos : i,
      index: i,
    }));
  const byGroup = {};
  for (const row of placed) (byGroup[row.group] = byGroup[row.group] || []).push(row);

  const order = new Map();
  for (const key of Object.keys(byGroup)) {
    // Stable: equal positions keep the order the caller passed.
    byGroup[key].sort((a, b) => a.pos - b.pos || a.index - b.index);
    byGroup[key].forEach((row, i) => order.set(row.id, baseOf[key] + 1 + i));
    counts[key] = byGroup[key].length;
  }

  const webOrder = new Map();
  webs.forEach((id, i) => {
    if (typeof id === 'string' && id) webOrder.set(id, baseOf.idle + TAB_TRIAGE_WEB_OFFSET + i);
  });
  counts.idle += webOrder.size;

  const groups = sequence.filter((group) => counts[group.key] > 0).map((group) => ({
    key: group.key,
    label: group.label,
    quiet: !!group.quiet,
    count: counts[group.key],
    headOrder: baseOf[group.key],
    breakOrder: baseOf[group.key] + TAB_TRIAGE_STRIDE - 1,
  }));

  return { order, webOrder, groups };
}

// Tab clusters by case (`tabArrangement: 'case'`, Discussion #426 option A).
//
// One cluster per case, in the order the case first appears in the tab order,
// so the strip keeps the user's arrangement at the case level. Inside a cluster
// with two or more tabs the `-<case>` part of a generated `w<n>-<case>` name is
// redundant and is hidden (`tabClusterNameSplit()`), which is what lets 18 tabs
// read as 7 things. A case with one tab is still its own (unlabelled) box.
//
// Cluster colours come from the session palette (`--session-<colour>`) by a
// stable hash of the case key, so a case keeps its colour across reloads and
// devices without anything being stored.
//
// Pure: no DOM, no `this`. Unit-tested in test/tab-clusters.test.ts.
const TAB_CLUSTER_COLORS = ['blue', 'green', 'purple', 'orange', 'pink', 'yellow', 'red'];

/** Palette colour for a cluster key: a djb2 hash, so the same key always gets the same colour. */
function tabClusterColorFor(key) {
  const text = String(key || '');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return TAB_CLUSTER_COLORS[Math.abs(hash) % TAB_CLUSTER_COLORS.length];
}

/**
 * Group tabs by case.
 * @param {Array<{id: string, key: string, label: string}>} rows live sessions in
 *   tab order; `key` identifies the case (its path), `label` names it
 * @returns {Array<{key: string, label: string, color: string, ids: string[]}>}
 *   clusters in first-appearance order, members in tab order
 */
function computeTabClusters(rows) {
  const clusters = [];
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.id !== 'string') continue;
    const key = typeof row.key === 'string' && row.key ? row.key : `session:${row.id}`;
    let cluster = byKey.get(key);
    if (!cluster) {
      cluster = { key, label: typeof row.label === 'string' ? row.label : '', color: tabClusterColorFor(key), ids: [] };
      byKey.set(key, cluster);
      clusters.push(cluster);
    }
    cluster.ids.push(row.id);
  }
  return clusters;
}

/**
 * Split a generated `w<n>-<case>` / `s<n>-<case>` name into the part a cluster
 * shows and the case suffix it hides, or null when the name is anything else
 * (a custom name, a described `w3-x: fix login`, another case's name). Case is
 * compared case-insensitively; the hidden part keeps its original spelling so
 * the full name is still in the DOM.
 * @returns {{shown: string, hidden: string}|null}
 */
function tabClusterNameSplit(name, label) {
  if (typeof name !== 'string' || typeof label !== 'string' || !label) return null;
  const match = name.match(/^([ws]\d+)(-.+)$/);
  if (!match) return null;
  return match[2].slice(1).toLowerCase() === label.toLowerCase() ? { shown: match[1], hidden: match[2] } : null;
}

/**
 * Session-list search: the vertical rail's search box and the sidebar's filter
 * box. Trimmed, case-insensitive substring; a whitespace-only query is no query.
 * Lower-cased with toLowerCase(), never toLocaleLowerCase(): under a Turkish or
 * Azeri browser locale "API" lowers to "apı" and a search for "api" would miss it.
 * @param {unknown} query
 * @returns {string} the needle, '' when there is nothing to search for
 */
function tabSearchNeedle(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

/**
 * Which rows a search hides. Pure: the caller reads the rows off the list it
 * rendered and applies the result as classes, so the list itself (grouping,
 * order, Alt+N badges) is never rebuilt or reordered by a search.
 *
 * A row flagged `keep: true` is never hidden, matching or not (the caller keeps
 * a tab with an alert on screen: a prompt waiting on you is never hidden by a
 * view filter). It counts toward its section, so its group stays on screen with
 * it, but not toward `matchCount`.
 *
 * @param {Array<{key: unknown, text: string, section?: unknown, keep?: boolean}>} rows
 *   in list order; `section` is the row's group or case box, null/undefined for none.
 * @param {unknown} query
 * @returns {{active: boolean, hidden: Set<unknown>, counts: Map<unknown, number>, matchCount: number}}
 *   `counts` is the rows left showing per section (kept rows included), every
 *   section seen, an emptied one as 0, so it can be hidden; `matchCount` is the
 *   number of rows whose TEXT matched, so it can be 0 above a lone kept row.
 */
function filterTabSearchRows(rows, query) {
  const needle = tabSearchNeedle(query);
  const hidden = new Set();
  const counts = new Map();
  let matchCount = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const hasSection = row.section !== null && row.section !== undefined;
    if (hasSection && !counts.has(row.section)) counts.set(row.section, 0);
    const text = typeof row.text === 'string' ? row.text.toLowerCase() : '';
    const matches = !needle || text.includes(needle);
    if (!matches && row.keep !== true) {
      hidden.add(row.key);
      continue;
    }
    if (matches) matchCount++;
    if (hasSection) counts.set(row.section, counts.get(row.section) + 1);
  }
  return { active: needle.length > 0, hidden, counts, matchCount };
}

// Terminal font stack — the single source for every xterm surface (the main
// terminal in terminal-ui.js, the log-viewer terminal in panels-ui.js).
// "Symbols Nerd Font Mono" is a bundled icons-only webfont (fonts/ +
// @font-face in styles.css): browsers fall back PER GLYPH, so Nerd Font
// prompt icons (powerline segments, folder/git glyphs from p10k, starship,
// oh-my-posh) render even though the text fonts carry no private-use-area
// symbols — while all readable text keeps coming from the text fonts.
/**
 * How long a terminal fit will wait for the terminal font, in ms.
 *
 * `FontFaceSet.ready` has no deadline of its own and the wait sits in front of
 * the buffer replay, so a font request that never settles would leave the
 * session unpainted. Past this we measure whatever is painted.
 */
const TERMINAL_FONT_WAIT_MS = 2000;

/**
 * Families in the stack that cannot move the measured cell, so nothing waits on
 * them: the generics match no `FontFace`, and the bundled symbols face carries
 * private-use-area glyphs only (xterm measures `W`) while weighing ~1.2MB.
 */
const TERMINAL_FONT_UNMEASURED = new Set(['monospace', 'serif', 'sans-serif', 'system-ui', 'symbols nerd font mono']);

const TERMINAL_FONT_DEFAULT_STACK =
  '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, "Symbols Nerd Font Mono", monospace';

/**
 * Resolve the xterm fontFamily from the per-device `terminalFontFamily`
 * setting. A user-set family (or comma-separated list) is PREPENDED to the
 * built-in stack, never a replacement — the symbols fallback and a final
 * `monospace` must survive whatever the user types. Blank input yields the
 * default. Unquoted names that need quoting for CSS (spaces, digits leading,
 * etc.) are quoted; embedded quotes are stripped rather than escaped, since
 * a font name cannot contain them anyway.
 */
function resolveTerminalFontFamily(custom) {
  const raw = typeof custom === 'string' ? custom.trim() : '';
  if (!raw) return TERMINAL_FONT_DEFAULT_STACK;
  const families = raw
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').replace(/["']/g, '').trim())
    .filter(Boolean)
    // Drop generic families the user may append — the default stack already
    // ends in `monospace`, and a duplicate earlier entry would shadow the
    // symbols fallback behind it.
    .filter((f) => !/^(monospace|serif|sans-serif|system-ui)$/i.test(f))
    .map((f) => (/^[A-Za-z][A-Za-z0-9-]*$/.test(f) ? f : `"${f}"`));
  if (!families.length) return TERMINAL_FONT_DEFAULT_STACK;
  return `${families.join(', ')}, ${TERMINAL_FONT_DEFAULT_STACK}`;
}

/**
 * xterm's own defaults for the two weight slots, one per slot.
 *
 * They are deliberately kept apart rather than collapsed into a single
 * fallback: handing the bold slot `normal` (or the normal slot `bold`) would
 * turn an unset setting into a visible change, which is exactly the thing this
 * feature exists to make controllable.
 */
const TERMINAL_FONT_WEIGHT_DEFAULTS = { fontWeight: 'normal', fontWeightBold: 'bold' };

/**
 * Resolve ONE weight slot against xterm's validation rules.
 *
 * xterm accepts a number in 1..1000, or one of its own keyword/numeric-string
 * options, and silently falls back to the slot default for anything else
 * (`OptionsService._sanitizeAndValidateOption`). Resolving here instead means a
 * stored value the picker does not list (a hand-set 350) still reaches the
 * terminal, while junk in localStorage never does.
 */
function resolveTerminalFontWeightSlot(value, fallback) {
  if (value === 'normal' || value === 'bold') return value;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 1000) return fallback;
  return Math.round(numeric);
}

/**
 * Resolve both xterm weight slots from the per-device settings blob.
 *
 * Bold text on the theme's default foreground carries exactly ONE cue, the
 * weight step: Claude Code marks its markdown bold with a bare `ESC[1m` and no
 * colour, and xterm's bold-to-bright substitution only fires for palette
 * indices 0-7, so it never applies to default-foreground text. A family that
 * ships only a regular and a bold face keeps that step small, and 400 stays
 * 400 whatever family is chosen — lowering the NORMAL weight is the only way
 * to widen the gap.
 */
function resolveTerminalFontWeights(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    fontWeight: resolveTerminalFontWeightSlot(s.terminalFontWeight, TERMINAL_FONT_WEIGHT_DEFAULTS.fontWeight),
    fontWeightBold: resolveTerminalFontWeightSlot(
      s.terminalFontWeightBold,
      TERMINAL_FONT_WEIGHT_DEFAULTS.fontWeightBold
    ),
  };
}

// ---------------------------------------------------------------------------
// Auto Copy (copy-on-select). Pure decision, so every guard below is testable
// without a terminal, a clipboard, or a browser.
// ---------------------------------------------------------------------------

/**
 * Largest single input frame the server accepts, in UTF-16 code units.
 * ⚠️ Must equal MAX_INPUT_LENGTH in src/config/terminal-limits.ts (pinned by
 * test/input-size-limit.test.ts). Both transports reject a longer frame, and
 * before issue #484 the durable input queue retried such a frame forever.
 */
const INPUT_FRAME_MAX_CHARS = 64 * 1024;

/**
 * Largest paste the client will deliver at all. Anything up to this is split
 * into INPUT_FRAME_MAX_CHARS frames that go out in seq order, so the PTY sees
 * one contiguous byte stream (bracketed-paste markers included). Past it the
 * input is refused with a toast rather than queued: every frame is persisted
 * and retried until ACKed, so a multi-megabyte paste would pin the queue.
 */
const INPUT_PASTE_MAX_CHARS = 1024 * 1024;

/**
 * Split input into frames no longer than `max` code units, never cutting a
 * surrogate pair in half (a lone surrogate reaches the PTY as U+FFFD).
 *
 * @param {string} data
 * @param {number} [max]
 * @returns {string[]}
 */
function splitInputFrames(data, max = INPUT_FRAME_MAX_CHARS) {
  if (typeof data !== 'string' || data.length === 0) return [];
  if (!(max >= 2)) max = 2;
  if (data.length <= max) return [data];
  const frames = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + max, data.length);
    if (end < data.length) {
      const code = data.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--; // keep the pair together
    }
    frames.push(data.slice(start, end));
    start = end;
  }
  return frames;
}

/**
 * Upper bound on an AUTO-copied selection.
 *
 * A drag that runs off the top of the viewport autoscrolls, so one gesture can
 * sweep the entire 50k-line scrollback (millions of characters), and writing
 * that to the clipboard on every mouseup is a real hazard on a phone. Past the
 * cap the copy is REFUSED rather than truncated (half a selection on the
 * clipboard is worse than none) and the user is told to press Ctrl+C, which
 * still copies the whole thing through the explicit path.
 */
const AUTO_COPY_MAX_CHARS = 1_000_000;

/**
 * What an auto-copy attempt should do at the end of a selection gesture.
 *
 * `pending` is set by xterm's onSelectionChange and cleared on every flush;
 * `lastCopied` is the text this surface auto-copied last. Either one alone is
 * wrong, which is why both are here:
 *
 *  - onSelectionChange does not reliably fire BEFORE the mouseup that ends the
 *    drag (xterm fires it from its own document-level mouseup handler, and
 *    listener order between the two is registration order, not something this
 *    code controls). Gating on `pending` alone would silently drop the first
 *    copy of a drag-selection.
 *  - Gating on `text !== lastCopied` alone drops a deliberate re-selection of
 *    the same text after the user copied something else in between, and it
 *    would let any unrelated mouseup on the page re-copy a stale selection.
 *
 * So: a genuine selection change (`pending`) always copies, and otherwise only
 * text that differs from the last auto-copy does.
 *
 * @param {{enabled?: boolean, text?: string, lastCopied?: string, pending?: boolean}} params
 * @returns {'copy'|'skip'|'too-large'}
 */
function decideAutoCopy({ enabled, text, lastCopied, pending } = {}) {
  if (!enabled) return 'skip';
  // Whitespace-only is what a drag across blank cells produces; putting a wall
  // of spaces on the clipboard is never what the gesture meant.
  if (typeof text !== 'string' || !text.trim()) return 'skip';
  if (!pending && text === lastCopied) return 'skip';
  if (text.length > AUTO_COPY_MAX_CHARS) return 'too-large';
  return 'copy';
}

// The text a copy should put on the clipboard, given xterm's raw selection.
// Pure: the caller reads the selection and decides the mode, this transforms.
//
// xterm hands back whole screen ROWS, and its own trim only drops cells that
// were never written to. A full-screen TUI writes real spaces across the part
// of a row it is not using, so that padding counts as content and rides along
// to the clipboard: measured against Claude Code in a 282-column pane, single
// lines arrived carrying 138 trailing spaces. Native terminals trim it on copy
// (Windows Terminal, iTerm2 and GNOME Terminal all do), decideAutoCopy above
// already calls a wall of spaces "never what the gesture meant", and
// _selectTouchSelectionLine already treats those cells as padding. This is that
// same rule for the mouse and keyboard paths, which never had it.
//
// A LEADING margin is stripped too, but only the one the CLI in the pane
// DECLARES as its transcript gutter, passed in as `options.margin`. Called with
// no options this trims trailing padding and nothing else, which is what keeps
// every caller that has no declared gutter on the old behaviour.
//
// ⚠ The failure modes are not symmetrical, and that asymmetry sets how much
// evidence a leading strip has to show before it fires. A wrong trailing trim
// costs nothing. A wrong dedent silently deletes information that was on the
// screen, with no signal to the user and nothing in the clipboard to hint at
// it, and it is wrong on `git log` bodies, on indented code read out of `cat`
// (semantic in Python), on `git diff` context rows where the leading space is
// the marker, and on stack traces.
//
// ⚠ The declared gutter is a CEILING, not the answer. The strip is the lesser
// of it and the run every selected line shares, so a block can only ever shift
// as a unit: the relative structure inside a selection survives by
// construction, and a selection reaching column 0 loses nothing at all.
//
// ⚠ Deriving the width from the text instead is what fails, twice over. The
// selection's own shared indent cannot tell a margin from content, because a
// three-row window of nested YAML shares an indent for the same reason a margin
// does — it fired on 73% of ordinary indented text. Taking the narrowest indent
// on the surrounding rows fails more quietly: a file listing inside the
// transcript can be the narrowest thing on screen, which over-stripped about 1%
// of selections across six pane widths.
function cleanCopiedSelection(text, options) {
  if (typeof text !== 'string' || !text) return '';
  // Split on \n and leave any \r in place: xterm joins rows with \r\n on
  // Windows, and the clipboard should keep the endings xterm chose.
  // Scanned rather than matched. A selection can run to the 50 000-row
  // scrollback ceiling, and `/[ \t]+(\r?)$/` is QUADRATIC on a line whose spaces
  // are followed by any non-space character, which is what right-aligned or
  // centred TUI content looks like: the engine retries the run from every
  // whitespace position and backtracks over it. Measured over 50 000 rows with a
  // 280-column run, that regex took 2.9s against 1.3ms for the scan below, and a
  // 2 000-column run took 16s. It is also the faster of the two on an ordinary
  // padded row. A length is returned rather than a trimmed string so a
  // \r-terminated line costs no substring either.
  const trimEnd = (line) => {
    let end = line.length;
    if (end > 0 && line[end - 1] === '\r') end--;
    let cut = end;
    while (cut > 0 && (line[cut - 1] === ' ' || line[cut - 1] === '\t')) cut--;
    return cut === end ? line : line.slice(0, cut) + line.slice(end);
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) lines[i] = trimEnd(lines[i]);

  const margin = Math.max(0, Math.trunc(Number(options?.margin) || 0));
  if (!margin) return lines.join('\n');

  // The first line of a selection that began mid-row carries no margin — the
  // mousedown cut it off — so it neither votes on the shared indent nor gets
  // stripped. This is the ONE thing the mousedown column still decides, and it
  // decides it for that line alone. Whether the rest of the block is dedented
  // no longer depends on where the click landed, which is what made the same
  // three rows produce three different clipboard results before.
  const from = options?.firstLinePartial === true ? 1 : 0;

  // The pane's margin is a ceiling, not the answer. Strip the narrower of it
  // and what every selected line shares, so the block shifts as a unit and no
  // line can lose indentation another line keeps.
  let shared = margin;
  for (let i = from; i < lines.length && shared > 0; i++) {
    const line = lines[i];
    if (!line || line === '\r') continue; // a padding-only row, already trimmed away
    let run = 0;
    while (run < line.length && line[run] === ' ') run++;
    if (run < shared) shared = run;
  }
  if (!shared) return lines.join('\n');
  for (let i = from; i < lines.length; i++) {
    if (lines[i] && lines[i] !== '\r') lines[i] = lines[i].slice(shared);
  }
  return lines.join('\n');
}

// ── Markdown heading anchors ────────────────────────────────────────────────
// marked emits no `id` on headings, so a rendered document's own `[Install](#installation)` links had
// nothing to jump to. And with `<base href="/">` a bare `#installation` href points at the dashboard's
// root, not at the page, so letting the browser follow it navigates the app away. The click delegate
// (`_bindResponseViewerInteractions`) therefore resolves in-document links itself, with the helpers
// below. Anchors are `data-md-anchor` attributes, NOT `id`s: a heading titled "Settings" must not claim
// the id of an element in the app's own DOM, and the lookup is scoped to the rendered document.

/**
 * GitHub's heading slug: lower-cased, anything that is not a letter, mark, number, `_`, `-` or space
 * dropped, each space a hyphen (`Why `codeman`? → `why-codeman`, `Über uns` → `über-uns`).
 */
function markdownHeadingSlug(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');
}

/** Give every h1..h6 under `root` its slug in `data-md-anchor`; a repeat gets `-1`, `-2`, ... as on GitHub. Idempotent. */
function assignMarkdownHeadingAnchors(root) {
  const used = new Set();
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = markdownHeadingSlug(heading.textContent);
    let slug = base;
    for (let n = 1; used.has(slug); n += 1) slug = `${base}-${n}`;
    used.add(slug);
    heading.dataset.mdAnchor = slug;
  }
}

/**
 * The element inside `root` that an in-document link (`#installation`, `#Installation`, `#my%20title`)
 * points at, or null. An empty fragment (`#`) means the top of the document. Headings are matched by
 * slug, then a heading the author wrote an explicit `<a id="...">`/`id` for, looked up INSIDE `root`
 * only (never `document.getElementById`, which could find an app element of the same name).
 */
function findMarkdownAnchorTarget(root, href) {
  let fragment = String(href ?? '').replace(/^#/, '');
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    /* a malformed escape: use it as written */
  }
  if (!fragment) return root;
  assignMarkdownHeadingAnchors(root);
  const wanted = [fragment.toLowerCase(), markdownHeadingSlug(fragment)];
  for (const heading of root.querySelectorAll('[data-md-anchor]')) {
    if (wanted.includes(heading.dataset.mdAnchor)) return heading;
  }
  for (const el of root.querySelectorAll('[id]')) {
    if (el.id === fragment) return el;
  }
  return null;
}

if (typeof window !== 'undefined') {
  window.WEBGL_FALLBACK = WEBGL_FALLBACK;
  window.evaluateWebGLLongTaskTrip = evaluateWebGLLongTaskTrip;
  window.shouldSkipWebGL = shouldSkipWebGL;
  window.CodemanTabOverflow = {
    shouldAutoWrapTabs,
    resolveTabOrientation,
    computeTabScrollLeft,
    TAB_SCROLL_REVEAL_PX,
  };
  window.CodemanTabRail = {
    DEFAULT_WIDTH: TAB_RAIL_DEFAULT_WIDTH,
    RICH_DEFAULT_WIDTH: TAB_RAIL_RICH_DEFAULT_WIDTH,
    MIN_WIDTH: TAB_RAIL_MIN_WIDTH,
    MAX_WIDTH: TAB_RAIL_MAX_WIDTH,
    resolveWidth: resolveTabRailWidth,
    resolveKeyboardWidth: resolveTabRailKeyboardWidth,
  };
  window.CodemanWsReconnect = {
    plan: planWsReconnect,
  };
  window.CodemanLineage = {
    computeTree: computeLineageTree,
    computeRows: computeLineageRows,
    CORNER_RADIUS_PX: LINEAGE_CORNER_RADIUS_PX,
    LANE_STEP_PX: LINEAGE_LANE_STEP_PX,
    MAX_LANES: LINEAGE_MAX_LANES,
    SPINE_INSET_PX: LINEAGE_SPINE_INSET_PX,
    VERTICAL_TRACK_INSET_PX: LINEAGE_VERTICAL_TRACK_INSET_PX,
    COLORS: LINEAGE_COLORS,
  };
  window.CodemanConnectionLoss = {
    compute: computeConnectionLossUi,
    GRACE_MS: CONNECTION_LOSS_GRACE_MS,
  };
  window.CodemanSseStale = {
    compute: computeSseStale,
    TIMEOUT_MS: SSE_STALE_TIMEOUT_MS,
  };
  window.CodemanSessionOrder = {
    RANK: SESSION_ACTIVITY_RANK,
    anchor: sessionActivityAnchor,
    compare: compareSessionActivity,
    sort: sortSessionsByActivity,
  };
  window.CodemanTabClusters = {
    COLORS: TAB_CLUSTER_COLORS,
    colorFor: tabClusterColorFor,
    compute: computeTabClusters,
    nameSplit: tabClusterNameSplit,
  };
  window.CodemanTabTriage = {
    GROUPS: TAB_TRIAGE_GROUPS,
    STRIDE: TAB_TRIAGE_STRIDE,
    groupFor: tabTriageGroupFor,
    layout: computeTabTriageLayout,
  };
  window.CodemanTabSearch = {
    needle: tabSearchNeedle,
    filter: filterTabSearchRows,
  };
  window.CodemanInputLimit = {
    FRAME_MAX_CHARS: INPUT_FRAME_MAX_CHARS,
    PASTE_MAX_CHARS: INPUT_PASTE_MAX_CHARS,
    split: splitInputFrames,
  };
  window.CodemanAutoCopy = {
    decide: decideAutoCopy,
    MAX_CHARS: AUTO_COPY_MAX_CHARS,
  };
  window.CodemanCopySelection = {
    clean: cleanCopiedSelection,
  };
  window.CodemanMarkdownAnchors = {
    slug: markdownHeadingSlug,
    assign: assignMarkdownHeadingAnchors,
    find: findMarkdownAnchorTarget,
  };
  window.CodemanTerminalFont = {
    DEFAULT_STACK: TERMINAL_FONT_DEFAULT_STACK,
    resolve: resolveTerminalFontFamily,
    WEIGHT_DEFAULTS: TERMINAL_FONT_WEIGHT_DEFAULTS,
    resolveWeights: resolveTerminalFontWeights,
  };
}

// Scheduler API — prioritize terminal writes over background UI updates.
// scheduler.postTask('background') defers non-critical work (connection lines, panel renders)
// so the main thread stays free for terminal rendering at 60fps.
const _hasScheduler = typeof globalThis.scheduler?.postTask === 'function';
function scheduleBackground(fn) {
  if (_hasScheduler) { scheduler.postTask(fn, { priority: 'background' }); }
  else { requestAnimationFrame(fn); }
}

// DEC mode 2026 marker stripping — xterm.js 6.0 handles sync natively,
// but server-sent terminal buffers may still contain markers from Claude CLI.
const DEC_SYNC_STRIP_RE = /\x1b\[\?2026[hl]/g;

// Built-in respawn configuration presets
const BUILTIN_RESPAWN_PRESETS = [
  {
    id: 'solo-work',
    name: 'Solo',
    description: 'Claude working alone — fast respawn cycles with context reset',
    config: {
      idleTimeoutMs: 3000,
      updatePrompt: 'summarize your progress so far before the context reset.',
      interStepDelayMs: 2000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'continue working. Pick up where you left off based on the context above.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 60,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'subagent-workflow',
    name: 'Subagents',
    description: 'Lead session with Task tool subagents — longer idle tolerance',
    config: {
      idleTimeoutMs: 45000,
      updatePrompt: 'check on your running subagents and summarize their results before the context reset. If all subagents have finished, note what was completed and what remains.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'check on your running subagents and continue coordinating their work. If all subagents have finished, summarize their results and proceed with the next step.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 240,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'team-lead',
    name: 'Team',
    description: 'Leading an agent team via TeamCreate — tolerates long silences',
    config: {
      idleTimeoutMs: 90000,
      updatePrompt: 'review the task list and teammate progress. Summarize the current state before the context reset.',
      interStepDelayMs: 5000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'check on your teammates by reviewing the task list and any messages in your inbox. Assign new tasks if teammates are idle, or continue coordinating the team effort.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'ralph-todo',
    name: 'Ralph/Todo',
    description: 'Ralph Loop task list — works through todos with progress tracking',
    config: {
      idleTimeoutMs: 8000,
      updatePrompt: 'update CLAUDE.md with discoveries and progress notes, mark completed tasks in @fix_plan.md, write a brief summary so the next cycle can continue seamlessly.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'read @fix_plan.md for task status, continue on the next uncompleted task. When ALL tasks are complete, output <promise>COMPLETE</promise>.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'overnight-autonomous',
    name: 'Overnight',
    description: 'Unattended overnight runs with full context reset between cycles',
    config: {
      idleTimeoutMs: 10000,
      updatePrompt: 'summarize what you accomplished so far and write key progress notes to CLAUDE.md so the next cycle can pick up where you left off.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'continue working on the task. Pick up where you left off based on the context above.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
];

// ═══════════════════════════════════════════════════════════════
// SSE Event Types
// ═══════════════════════════════════════════════════════════════

/** @type {Record<string, string>} Centralized SSE event type constants */
const SSE_EVENTS = {
  // Core
  INIT: 'init',

  // Transport
  HEARTBEAT: 'sse:heartbeat',

  // Session lifecycle
  SESSION_CREATED: 'session:created',
  SESSION_UPDATED: 'session:updated',
  SESSION_DELETED: 'session:deleted',
  SESSION_TERMINAL: 'session:terminal',
  SESSION_NEEDS_REFRESH: 'session:needsRefresh',
  SESSION_CLEAR_TERMINAL: 'session:clearTerminal',
  SESSION_COMPLETION: 'session:completion',
  SESSION_ERROR: 'session:error',
  SESSION_EXIT: 'session:exit',
  SESSION_IDLE: 'session:idle',
  SESSION_WORKING: 'session:working',
  SESSION_AUTO_CLEAR: 'session:autoClear',
  SESSION_AUTO_COMPACT: 'session:autoCompact',
  SESSION_LIMIT_PAUSE_SCHEDULED: 'session:limitPauseScheduled',
  SESSION_LIMIT_RESUME: 'session:limitResume',
  SESSION_LIMIT_RESUME_CANCELLED: 'session:limitResumeCancelled',
  SESSION_RESPAWN_BREAKER_TRIPPED: 'session:respawnBreakerTripped',
  SESSION_CLI_INFO: 'session:cliInfo',
  SESSION_PINNED: 'session:pinned',
  SESSION_MESSAGE: 'session:message',
  SESSION_INTERACTIVE: 'session:interactive',
  SESSION_RUNNING: 'session:running',
  SESSION_STATUS_TELEMETRY: 'session:statusTelemetry',

  // Scheduled runs
  SCHEDULED_CREATED: 'scheduled:created',
  SCHEDULED_UPDATED: 'scheduled:updated',
  SCHEDULED_COMPLETED: 'scheduled:completed',
  SCHEDULED_STOPPED: 'scheduled:stopped',
  SCHEDULED_LOG: 'scheduled:log',
  SCHEDULED_DELETED: 'scheduled:deleted',

  // Cron jobs
  CRON_JOBS_CHANGED: 'cron:jobsChanged',
  CRON_JOB_DELETED: 'cron:jobDeleted',
  CRON_RUN_CREATED: 'cron:runCreated',
  CRON_RUN_UPDATED: 'cron:runUpdated',

  // Respawn
  RESPAWN_STARTED: 'respawn:started',
  RESPAWN_STOPPED: 'respawn:stopped',
  RESPAWN_STATE_CHANGED: 'respawn:stateChanged',
  RESPAWN_CYCLE_STARTED: 'respawn:cycleStarted',
  RESPAWN_CYCLE_COMPLETED: 'respawn:cycleCompleted',
  RESPAWN_BLOCKED: 'respawn:blocked',
  RESPAWN_STEP_SENT: 'respawn:stepSent',
  RESPAWN_STEP_COMPLETED: 'respawn:stepCompleted',
  RESPAWN_DETECTION_UPDATE: 'respawn:detectionUpdate',
  RESPAWN_AUTO_ACCEPT_SENT: 'respawn:autoAcceptSent',
  RESPAWN_AI_CHECK_STARTED: 'respawn:aiCheckStarted',
  RESPAWN_AI_CHECK_COMPLETED: 'respawn:aiCheckCompleted',
  RESPAWN_AI_CHECK_FAILED: 'respawn:aiCheckFailed',
  RESPAWN_AI_CHECK_COOLDOWN: 'respawn:aiCheckCooldown',
  RESPAWN_PLAN_CHECK_STARTED: 'respawn:planCheckStarted',
  RESPAWN_PLAN_CHECK_COMPLETED: 'respawn:planCheckCompleted',
  RESPAWN_PLAN_CHECK_FAILED: 'respawn:planCheckFailed',
  RESPAWN_TIMER_STARTED: 'respawn:timerStarted',
  RESPAWN_TIMER_CANCELLED: 'respawn:timerCancelled',
  RESPAWN_TIMER_COMPLETED: 'respawn:timerCompleted',
  RESPAWN_ACTION_LOG: 'respawn:actionLog',
  RESPAWN_LOG: 'respawn:log',
  RESPAWN_ERROR: 'respawn:error',
  RESPAWN_CONFIG_UPDATED: 'respawn:configUpdated',

  // Tasks
  TASK_CREATED: 'task:created',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  TASK_UPDATED: 'task:updated',

  // Mux (tmux)
  MUX_CREATED: 'mux:created',
  MUX_KILLED: 'mux:killed',
  MUX_DIED: 'mux:died',
  MUX_STATS_UPDATED: 'mux:statsUpdated',

  // Remote auto-reconnect (COD-108)
  REMOTE_SESSION_DROPPED: 'remote:sessionDropped',
  REMOTE_SESSION_RECONNECTED: 'remote:sessionReconnected',
  REMOTE_RECONNECT_EXHAUSTED: 'remote:reconnectExhausted',
  // Wake-on-LAN from user input on a sleeping remote host
  REMOTE_HOST_WAKING: 'remote:hostWaking',
  REMOTE_HOST_WAKE_FAILED: 'remote:hostWakeFailed',

  // Ralph
  SESSION_RALPH_LOOP_UPDATE: 'session:ralphLoopUpdate',
  SESSION_RALPH_TODO_UPDATE: 'session:ralphTodoUpdate',
  SESSION_RALPH_COMPLETION_DETECTED: 'session:ralphCompletionDetected',
  SESSION_RALPH_STATUS_UPDATE: 'session:ralphStatusUpdate',
  SESSION_CIRCUIT_BREAKER_UPDATE: 'session:circuitBreakerUpdate',
  SESSION_EXIT_GATE_MET: 'session:exitGateMet',

  // Bash tools
  SESSION_BASH_TOOL_START: 'session:bashToolStart',
  SESSION_BASH_TOOL_END: 'session:bashToolEnd',
  SESSION_BASH_TOOLS_UPDATE: 'session:bashToolsUpdate',

  // Session: Plan
  SESSION_PLAN_TASK_UPDATE: 'session:planTaskUpdate',
  SESSION_PLAN_CHECKPOINT: 'session:planCheckpoint',
  SESSION_PLAN_ROLLBACK: 'session:planRollback',
  SESSION_PLAN_TASK_ADDED: 'session:planTaskAdded',

  // Hooks (Claude Code hook events)
  HOOK_IDLE_PROMPT: 'hook:idle_prompt',
  HOOK_PERMISSION_PROMPT: 'hook:permission_prompt',
  HOOK_ELICITATION_DIALOG: 'hook:elicitation_dialog',
  HOOK_ELICITATION_COMPLETE: 'hook:elicitation_complete',
  HOOK_ELICITATION_RESPONSE: 'hook:elicitation_response',
  HOOK_STOP: 'hook:stop',
  HOOK_AGENT_WORKING: 'hook:agent_working',
  HOOK_TEAMMATE_IDLE: 'hook:teammate_idle',
  HOOK_TASK_COMPLETED: 'hook:task_completed',
  HOOK_PROMPT_SUBMITTED: 'hook:prompt_submitted',

  // Approvals Inbox
  APPROVAL_PENDING: 'approval:pending',
  APPROVAL_UPDATED: 'approval:updated',
  APPROVAL_RESOLVED: 'approval:resolved',

  // Custom Model Endpoint Profiles
  CUSTOM_MODEL_SWAPPED_OUT: 'custom-model:swapped-out',

  // Subagents (Claude Code background agents)
  SUBAGENT_DISCOVERED: 'subagent:discovered',
  SUBAGENT_UPDATED: 'subagent:updated',
  SUBAGENT_TOOL_CALL: 'subagent:tool_call',
  SUBAGENT_PROGRESS: 'subagent:progress',
  SUBAGENT_MESSAGE: 'subagent:message',
  SUBAGENT_TOOL_RESULT: 'subagent:tool_result',
  SUBAGENT_COMPLETED: 'subagent:completed',

  // Workflow runs (ultracode / Workflow tool)
  WORKFLOW_RUN_DISCOVERED: 'workflow:run_discovered',
  WORKFLOW_RUN_UPDATED: 'workflow:run_updated',
  WORKFLOW_RUN_REMOVED: 'workflow:run_removed',

  // Images
  IMAGE_DETECTED: 'image:detected',
  ATTACHMENT_DETECTED: 'attachment:detected',

  // Tunnel
  TUNNEL_STARTED: 'tunnel:started',
  TUNNEL_STOPPED: 'tunnel:stopped',
  TUNNEL_PROGRESS: 'tunnel:progress',
  TUNNEL_ERROR: 'tunnel:error',
  TUNNEL_QR_ROTATED: 'tunnel:qrRotated',
  TUNNEL_QR_REGENERATED: 'tunnel:qrRegenerated',
  TUNNEL_QR_AUTH_USED: 'tunnel:qrAuthUsed',

  // Plan orchestration
  PLAN_SUBAGENT: 'plan:subagent',
  PLAN_PROGRESS: 'plan:progress',
  PLAN_STARTED: 'plan:started',
  PLAN_CANCELLED: 'plan:cancelled',
  PLAN_COMPLETED: 'plan:completed',

  // Orchestrator Loop
  ORCHESTRATOR_STATE_CHANGED: 'orchestrator:stateChanged',
  ORCHESTRATOR_PLAN_PROGRESS: 'orchestrator:planProgress',
  ORCHESTRATOR_PLAN_READY: 'orchestrator:planReady',
  ORCHESTRATOR_PHASE_STARTED: 'orchestrator:phaseStarted',
  ORCHESTRATOR_PHASE_COMPLETED: 'orchestrator:phaseCompleted',
  ORCHESTRATOR_PHASE_FAILED: 'orchestrator:phaseFailed',
  ORCHESTRATOR_VERIFICATION: 'orchestrator:verification',
  ORCHESTRATOR_TASK_ASSIGNED: 'orchestrator:taskAssigned',
  ORCHESTRATOR_TASK_COMPLETED: 'orchestrator:taskCompleted',
  ORCHESTRATOR_TASK_FAILED: 'orchestrator:taskFailed',
  ORCHESTRATOR_COMPLETED: 'orchestrator:completed',
  ORCHESTRATOR_ERROR: 'orchestrator:error',

  // Teams (agent teams)
  TEAM_CREATED: 'team:created',
  TEAM_UPDATED: 'team:updated',
  TEAM_REMOVED: 'team:removed',
  TEAM_TASK_UPDATED: 'team:taskUpdated',

  // Transcript
  TRANSCRIPT_COMPLETE: 'transcript:complete',
  TRANSCRIPT_PLAN_MODE: 'transcript:plan_mode',
  TRANSCRIPT_TOOL_START: 'transcript:tool_start',
  TRANSCRIPT_TOOL_END: 'transcript:tool_end',

  // Clipboard
  CLIPBOARD_WRITE: 'clipboard:write',

  // Cases
  CASE_CREATED: 'case:created',
  CASE_LINKED: 'case:linked',
  CASE_DELETED: 'case:deleted',
  CASE_ORDER_CHANGED: 'case:order-changed',
  DOCKER_EXPORT_COMPLETE: 'docker:exportComplete',
  DOCKER_EXPORT_FAILED: 'docker:exportFailed',
  DOCKER_IMPORT_COMPLETE: 'docker:importComplete',
  DOCKER_IMAGE_BUILD_STARTED: 'docker:imageBuildStarted',
  DOCKER_IMAGE_BUILD_PROGRESS: 'docker:imageBuildProgress',
  DOCKER_IMAGE_BUILD_COMPLETE: 'docker:imageBuildComplete',
  DOCKER_IMAGE_BUILD_FAILED: 'docker:imageBuildFailed',
  // Multi-user (admin-only / targeted)
  ADMIN_USERS_CHANGED: 'admin:usersChanged',
  AUTH_PASSWORD_CHANGE_REQUIRED: 'auth:passwordChangeRequired',
  DOCKER_CONTAINER_RECREATED: 'docker:containerRecreated',

  // Session order (global tab order sync)
  SESSION_ORDER_CHANGED: 'session:orderChanged',

  // Web tabs (dashboard URLs)
  WEBVIEW_CHANGED: 'webview:changed',
  TAB_LAYOUT_CHANGED: 'tab:layoutChanged',
};

// ═══════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════

/**
 * Get unified coordinates from mouse or touch event.
 * @param {MouseEvent|TouchEvent} e - The event
 * @returns {{ clientX: number, clientY: number }} Coordinates
 */
function getEventCoords(e) {
  if (e.touches && e.touches.length > 0) {
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  if (e.changedTouches && e.changedTouches.length > 0) {
    return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
  }
  return { clientX: e.clientX, clientY: e.clientY };
}

// HTML escape utility (shared by NotificationManager, CodemanApp, and ralph-wizard.js)
const _htmlEscapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _htmlEscapePattern = /[&<>"']/g;
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(_htmlEscapePattern, (ch) => _htmlEscapeMap[ch]);
}

/**
 * Human-readable byte size for the partial-history banner (#258).
 *
 * Deliberately coarse: the banner is telling the user roughly how much of a
 * transcript they are looking at, not accounting for bytes. Sub-KB amounts read
 * as "less than 1 KB" rather than an exact count nobody can act on.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatHistoryBytes(bytes) {
  const n = typeof bytes === 'number' && isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return 'less than 1 KB';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Decide what the partial-history banner should say (#258).
 *
 * PURE so the three states can be tested without a DOM. They exist because one
 * `truncated` boolean could not distinguish messages the user acts on very
 * differently:
 *   - recoverable: we tailed for speed and the rest is still retained
 *   - atCeiling:   the FULL capture itself hit the byte ceiling
 *   - exhausted:   a full pull was refused as a downgrade, so this is all there is
 *
 * @param {{truncated?: boolean, reason?: string|null, source?: string|null,
 *          fullSize?: number, retainedBytes?: number, exhausted?: boolean}} state
 * @returns {{visible: boolean, message: string, canLoadMore: boolean}}
 */
function computeHistoryTruncationNotice(state = {}) {
  if (!state.truncated) return { visible: false, message: '', canLoadMore: false };

  const retained = Math.max(0, state.retainedBytes || 0);
  const dropped = Math.max(0, (state.fullSize || 0) - retained);
  const shown = formatHistoryBytes(retained);
  // A full-history capture that was STILL capped is already everything tmux
  // holds, so the remainder is out of reach rather than one request away.
  const atCeiling = state.source === 'mux-full-history' && state.reason === 'capped';

  if (state.exhausted) {
    return {
      visible: true,
      message: `Showing all ${shown} of retained history. Earlier output is no longer kept for this session.`,
      canLoadMore: false,
    };
  }
  if (atCeiling) {
    return {
      visible: true,
      message: `Showing the most recent ${shown}. Earlier output exceeds the retained history limit and cannot be recovered.`,
      canLoadMore: false,
    };
  }
  return {
    visible: true,
    message: `Showing the most recent ${shown} of this session. ${formatHistoryBytes(dropped)} more may still be retained.`,
    canLoadMore: true,
  };
}

/**
 * Where to land after a rewrite that REPLACES the whole buffer (#259).
 *
 * The backpressure refresh clears the terminal and reloads it from a freshly
 * fetched capture, so an absolute viewportY captured beforehand means nothing
 * afterwards: the line it pointed at may not even exist. Distance from the
 * BOTTOM is the anchor that survives a rewrite, so a reader stays roughly
 * where they were reading.
 *
 * Returns null when the user was following live output, which the caller reads
 * as "scroll to bottom" — the historical behavior, kept for that case.
 *
 * @param {{linesFromBottom?: number, baseY?: number}} input
 * @returns {number|null}
 */
function computeRewriteScrollLine(input) {
  const linesFromBottom = input?.linesFromBottom || 0;
  if (!(linesFromBottom > 0)) return null;
  return Math.max(0, (input?.baseY || 0) - linesFromBottom);
}

/**
 * Absolute file paths in agent output, as ONE pattern with two consumers: the
 * xterm link provider (terminal-ui.js) and the response viewer's markdown
 * linkifier (app.js). They used to be able to drift, and a path that is
 * clickable in the terminal but inert in the chat reads as a bug, not a policy.
 *
 * Anchored on a known absolute root (so an ordinary fraction or a date can
 * never match) and terminated by a known extension (so the end of the path is
 * unambiguous — a trailing `)` or `.` after the extension stays out). Longer
 * extensions come first in each family (`tsx|ts`), so the trailing `\b` cannot
 * be satisfied by the shorter branch mid-word. `/etc` is deliberately NOT a
 * root: DEFAULT_BLOCKED_TREES (config/attachment-guard.ts) refuses the whole
 * tree server-side, so every `/etc/...` link was a guaranteed 403 — a link
 * that renders clickable and then dies is worse than plain text.
 *
 * ⚠ Consumers must never share one instance: `lastIndex` is per-object state on
 * a `/g` regex, so {@link absoluteFilePathPattern} mints a fresh one per call.
 */
const FILE_PATH_LINK_PATTERN =
  /(\/(?:home|Users|tmp|var|private|opt|mnt|srv|media|data|workspace)\/[^\s"'<>|;&\n\x00-\x1f]*\.(?:log|txt|json|md|ya?ml|csv|xml|sh|py|tsx|ts|jsx|js|mjs|cjs|css|html|toml|ini|sql|png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|docx|pptx|xlsx|mp4|webm|mov|mp3|wav))\b/g;

/** A fresh, zero-state instance of {@link FILE_PATH_LINK_PATTERN}. */
function absoluteFilePathPattern() {
  return new RegExp(FILE_PATH_LINK_PATTERN.source, 'g');
}

/**
 * Extensions the file-preview overlay renders itself. Everything else a link
 * points at goes to the tail/log viewer, which is the right home for a growing
 * text file and the wrong one for bytes (tailing a PNG shows binary noise).
 *
 * The media entries mirror VIDEO_ATTACHMENT_EXTENSIONS/AUDIO_ATTACHMENT_EXTENSIONS
 * (src/attachment-registry.ts, the single source) — they diverged once and an
 * in-workspace `.m4a` opened as binary noise in the log viewer while the same
 * file in /tmp played fine. test/media-extension-parity.test.ts pins the sync.
 */
const FILE_PREVIEW_EXTENSIONS = new Set(
  ('png jpg jpeg gif webp avif bmp ico svg pdf docx pptx xlsx mp4 webm mov m4v ogv mp3 wav ogg oga m4a aac flac opus').split(' ')
);

/** Whether a path's extension is one {@link FILE_PREVIEW_EXTENSIONS} covers. */
function previewsInFileViewer(filePath) {
  const ext = String(filePath || '').split('.').pop().toLowerCase();
  return FILE_PREVIEW_EXTENSIONS.has(ext);
}

/**
 * Home-relative and relative file paths: `~/repos/x/garage.png` (how Claude Code
 * echoes an attached image), `builds/captures/shot.png`, `./a.md`, `../b.json`,
 * or a bare `look_montage.png`. Same extension list and body as
 * {@link FILE_PATH_LINK_PATTERN} (test/link-provider-regex.test.ts pins the two
 * equal).
 *
 * Without a known root to anchor on, the START is what has to be unambiguous:
 * group 1 is the boundary in front of the path (line start, whitespace, a quote,
 * an opening bracket, `=`, `,`, `>`), so a match can never begin in the middle of
 * a word, of an absolute path (`/nix/store/x.png` is not `nix/store/x.png`) or of
 * a URL. The path itself is group 2. Its first character is never `/`: absolute
 * paths belong to the rooted pattern, which deliberately leaves `/etc` out. A
 * token containing `://` is a URL, never a path. Brackets, `=` and `,` end a
 * relative path (unlike a rooted one): `(garage.png)` and `OUT=shots/a.png` link
 * the file, not the punctuation around it.
 *
 * ⚠ Like its sibling, never share an instance (`lastIndex`): use
 * {@link findFilePathLinks}.
 */
const RELATIVE_FILE_PATH_LINK_PATTERN =
  /(^|[\s"'`(\[{<>=,])((?![^\s"'`<>|;&()[\]{}=,\n\x00-\x1f]*:\/\/)(?:~\/|[^\s"'`<>|;&()[\]{}=,\/~\n\x00-\x1f])[^\s"'`<>|;&()[\]{}=,\n\x00-\x1f]*\.(?:log|txt|json|md|ya?ml|csv|xml|sh|py|tsx|ts|jsx|js|mjs|cjs|css|html|toml|ini|sql|png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|docx|pptx|xlsx|mp4|webm|mov|mp3|wav))\b/g;

/** The `(?:log|txt|…)` extension group, read off the rooted pattern so it cannot drift. */
const FILE_LINK_EXTENSION_GROUP = /\\\.(\(\?:[^()]*\))\)\\b$/.exec(FILE_PATH_LINK_PATTERN.source)[1];

/**
 * Every linkable file path in `text`, in order: absolute (rooted) paths first,
 * then `~/` and relative ones that do not overlap them or a URL.
 *
 * The one entry point for both consumers (terminal link provider, response
 * viewer), so a path form is clickable in both or in neither.
 *
 * @param {string} text
 * @returns {Array<{path: string, index: number}>} `index` is where `path` starts in `text`.
 */
function findFilePathLinks(text) {
  const value = String(text || '');
  const found = [];
  const overlaps = (index, length) => found.some((f) => index < f.index + f.path.length && f.index < index + length);
  // Web URLs are never cut into a path: `https://x.io/a/home/b.png` and
  // `?img=b.png` belong to the URL link, not to a second, overlapping file link.
  // (`file:///home/x.png` is not one of them: its path is the file.)
  const urls = [];
  const urlPattern = /\bhttps?:\/\/\S+/gi;
  let match;
  while ((match = urlPattern.exec(value)) !== null) urls.push({ index: match.index, path: match[0] });
  const inUrl = (index, length) => urls.some((u) => index < u.index + u.path.length && u.index < index + length);

  const absolute = absoluteFilePathPattern();
  while ((match = absolute.exec(value)) !== null) {
    if (!inUrl(match.index, match[1].length)) found.push({ path: match[1], index: match.index });
  }
  const relative = new RegExp(RELATIVE_FILE_PATH_LINK_PATTERN.source, 'g');
  while ((match = relative.exec(value)) !== null) {
    const path = match[2];
    const index = match.index + match[1].length;
    if (overlaps(index, path.length) || inUrl(index, path.length)) continue;
    found.push({ path, index });
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Where a clicked path points, as the preview routes need it.
 *
 * Absolute and `~/` paths pass through unchanged — `~` is the home of the
 * session's HOST, which only the server knows (a remote case's home is on the
 * remote machine), so the server expands it. A relative path is resolved
 * against the session's working directory, `.` and `..` collapsed, so a
 * `../other/x.png` ends up outside the workspace and routes like any other
 * external path. Without a working directory it is returned as is.
 *
 * @param {string} filePath
 * @param {string} [workingDir]
 * @returns {string}
 */
function resolveLinkedFilePath(filePath, workingDir) {
  const path = String(filePath || '');
  if (!path || path.startsWith('/') || path.startsWith('~/') || !workingDir) return path;
  const parts = [];
  for (const part of `${workingDir}/${path}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}


/**
 * The LOGICAL line a terminal row belongs to — the rows it spans, its text as one
 * string, and a two-way map between that string and terminal cells.
 *
 * One definition, two consumers: the link provider matches its patterns over this
 * text (`registerFilePathLinkProvider`) and touch selection measures words and
 * whole lines with it (`_touchSelectionLogicalLine`). They MUST agree — a link that
 * spans a wrap and a "Line" that stops at the screen edge is the same bug twice.
 *
 * Two kinds of continuation, and handling only the first is not enough:
 *
 *   1. **Soft wrap** — the emulator ran out of columns and flags the next row
 *      `isWrapped`. It inserts nothing, so the row's text is joined verbatim.
 *   2. **Hard wrap** — the program wrapped the text itself and emitted a real
 *      newline, so nothing is flagged. A row that fills the last column is taken
 *      as continuing into the next; that is the only trace a hard wrap leaves.
 *
 * ⚠️ A hard-wrapped continuation may carry the program's own INDENT, and joining
 * that verbatim puts whitespace in the middle of the token being stitched. That is
 * why an agent's numbered list —
 *
 *     1. https://github.com/users/someone/packages/container/p
 *        ackage/thing
 *
 * — opened only `…/container/p`: the URL pattern stops at the space the indent
 * contributed. So the leading whitespace of a HARD continuation is dropped, and
 * `colStart` on that segment records how much, keeping the cell mapping exact. A
 * soft continuation keeps its leading whitespace, since the terminal never adds
 * any and it is therefore real content.
 *
 * ⚠️ Only the final row is trimmed. Continuation rows are read UNTRIMMED so each
 * contributes exactly `cols` cells; trimming one would shift every later offset.
 *
 * The row span is bounded by `maxRows` (12 by default): this runs on every hover,
 * and a screenful of full-width output would otherwise re-scan the viewport each
 * time.
 *
 * @param {{getLine: (row: number) => any, length: number}} buffer xterm buffer.
 * @param {number} row 0-based ABSOLUTE buffer row to expand around.
 * @param {number} cols Terminal width.
 * @param {number} [maxRows] Row-span bound.
 * @returns {{startRow: number, endRow: number, text: string,
 *            offsetToCell: (offset: number) => {row: number, col: number},
 *            cellToOffset: (row: number, col: number) => number} | null}
 *          0-based rows and columns throughout; null when the row does not exist.
 */
function terminalLogicalLine(buffer, row, cols, maxRows) {
  if (!buffer || typeof buffer.getLine !== 'function') return null;
  const width = Math.max(1, cols || 1);
  const bound = Math.max(1, maxRows || 12);
  const lineAt = (r) => (r >= 0 ? buffer.getLine(r) : undefined);
  if (!lineAt(row)) return null;

  const continuesPrevious = (r) => {
    if (r <= 0) return false;
    if (lineAt(r)?.isWrapped) return true;
    const prev = lineAt(r - 1);
    return !!prev && (prev.translateToString(true) || '').length >= width;
  };

  let startRow = row;
  while (startRow > 0 && row - startRow < bound && continuesPrevious(startRow)) startRow--;
  let endRow = row;
  const length = Number.isFinite(buffer.length) ? buffer.length : endRow + 1;
  while (endRow + 1 < length && endRow - startRow < bound && continuesPrevious(endRow + 1)) endRow++;

  const segments = [];
  let text = '';
  for (let r = startRow; r <= endRow; r++) {
    const line = lineAt(r);
    if (!line) break;
    let rowText = line.translateToString(r === endRow) || '';
    let colStart = 0;
    if (r > startRow && !line.isWrapped) {
      const indent = rowText.length - rowText.replace(/^\s+/, '').length;
      colStart = indent;
      rowText = rowText.slice(indent);
    }
    segments.push({ row: r, textStart: text.length, colStart, length: rowText.length });
    text += rowText;
  }

  const offsetToCell = (offset) => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (offset >= seg.textStart || i === 0) {
        return { row: seg.row, col: seg.colStart + (offset - seg.textStart) };
      }
    }
    return { row: startRow, col: offset };
  };

  const cellToOffset = (targetRow, targetCol) => {
    for (const seg of segments) {
      if (seg.row !== targetRow) continue;
      return seg.textStart + Math.max(0, targetCol - seg.colStart);
    }
    return -1;
  };

  return { startRow, endRow, text, offsetToCell, cellToOffset };
}

/** Roots of {@link FILE_PATH_LINK_PATTERN}, read off its source (`home|Users|…`). */
const FILE_LINK_ROOT_GROUP = /^\(\\\/\(\?:([^()]*)\)/.exec(FILE_PATH_LINK_PATTERN.source)[1];
const PATH_TOKEN_ENDS_WITH_EXTENSION = new RegExp(`\\.${FILE_LINK_EXTENSION_GROUP}$`);
const PATH_TOKEN_HAS_EXTENSION = new RegExp(`\\.${FILE_LINK_EXTENSION_GROUP}\\b`);
const PATH_TOKEN_STARTS_NEW_PATH = new RegExp(`^(?:~\\/|\\/(?:${FILE_LINK_ROOT_GROUP})\\/)`);

/**
 * Whether the line `nextText` carries on a file path `prevText` broke off.
 *
 * Answers `'join'` when the path ends (reaches a known extension) on the next
 * line, `'chain'` when the next line is nothing but more of the path (a path
 * spanning three or more lines; only worth keeping once a later line ends it),
 * and `null` otherwise. The broken-off token must already look like a path in
 * progress: it contains a `/`, ends on a path character and does not yet end
 * on an extension. A next line that opens a NEW rooted path (`/home/…`, `~/…`)
 * is never glued on.
 */
function pathContinuation(prevText, nextText) {
  const tail = /[^\s"'<>|;&]+$/.exec(String(prevText || '').replace(/\s+$/, ''))?.[0] || '';
  if (!tail.includes('/') || !/[\w\-.~+@%/]$/.test(tail) || PATH_TOKEN_ENDS_WITH_EXTENSION.test(tail)) return null;
  const next = String(nextText || '').replace(/^\s+/, '');
  const head = /^[^\s"'<>|;&]+/.exec(next)?.[0] || '';
  if (!head || PATH_TOKEN_STARTS_NEW_PATH.test(head)) return null;
  if (PATH_TOKEN_HAS_EXTENSION.test(head)) return 'join';
  return head === next.replace(/\s+$/, '') ? 'chain' : null;
}

/**
 * {@link terminalLogicalLine}, extended across the line breaks a program puts
 * INSIDE a file path. Used by the link provider only; touch selection keeps the
 * plain logical line.
 *
 * Claude Code wraps its tool output itself, a few columns short of the terminal
 * edge, so neither continuation signal of terminalLogicalLine fires (no
 * `isWrapped`, the row does not reach the last column) and a long path was only
 * linked up to the break:
 *
 *       ⎿  BILD /mnt/build/neon_getaway-mgr-hebel/builds/captures/2
 *          026-10-10/ghost1b_gameplay.png err=0 …
 *
 * A following logical line is glued on (its indent dropped, cell mapping kept
 * exact) when {@link pathContinuation} says it carries the path on and the row it
 * broke off is at least as long as the row it continues on. Bounded by the same
 * `maxRows` as the logical line.
 *
 * @returns Same shape as {@link terminalLogicalLine}; null when the row does not exist.
 */
function terminalPathLine(buffer, row, cols, maxRows) {
  const base = terminalLogicalLine(buffer, row, cols, maxRows);
  if (!base) return null;
  const bound = Math.max(1, maxRows || 12);
  const lineAt = (r) => terminalLogicalLine(buffer, r, cols, bound);
  const rowsOf = (line) => line.endRow - line.startRow + 1;
  // A program breaking a long token fills the row to its wrap width, and no
  // later row of that block is wider. So the row a path broke off is at least as
  // long as the row it continues on — which keeps `cd /mnt/foo` from being glued
  // to a longer `  file.png written` below it.
  const rowLength = (r) => (buffer.getLine(r)?.translateToString(true) || '').length;
  const continues = (prev, next, prevText) =>
    rowLength(prev.endRow) >= rowLength(next.startRow) && pathContinuation(prevText, next.text);

  /** `first` and the lines a path carries on into, stopping at the last confirmed join. */
  const extend = (first) => {
    const parts = [first];
    let text = first.text;
    let rows = rowsOf(first);
    let confirmed = 1;
    for (;;) {
      const next = lineAt(parts[parts.length - 1].endRow + 1);
      if (!next || rows + rowsOf(next) > bound) break;
      const kind = continues(parts[parts.length - 1], next, text);
      if (!kind) break;
      parts.push(next);
      text += next.text.replace(/^\s+/, '');
      rows += rowsOf(next);
      if (kind === 'join') confirmed = parts.length;
    }
    return parts.slice(0, confirmed);
  };

  // The hovered row may be the second or third line of a broken path: walk back
  // to where it could start, then let the forward pass decide what really joins.
  let first = base;
  let rows = rowsOf(base);
  while (first.startRow > 0) {
    const prev = lineAt(first.startRow - 1);
    if (!prev || rows + rowsOf(prev) > bound || !continues(prev, first, prev.text)) break;
    first = prev;
    rows += rowsOf(prev);
  }
  let parts = extend(first);
  if (parts[parts.length - 1].endRow < base.startRow) parts = extend(base);
  if (parts.length === 1) return parts[0];

  const segments = [];
  let text = '';
  for (const [i, part] of parts.entries()) {
    const skip = i === 0 ? 0 : part.text.length - part.text.replace(/^\s+/, '').length;
    segments.push({ part, textStart: text.length, skip });
    text += part.text.slice(skip);
  }
  const offsetToCell = (offset) => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (offset >= seg.textStart || i === 0) return seg.part.offsetToCell(offset - seg.textStart + seg.skip);
    }
    return segments[0].part.offsetToCell(offset);
  };
  const cellToOffset = (targetRow, targetCol) => {
    for (const seg of segments) {
      if (targetRow < seg.part.startRow || targetRow > seg.part.endRow) continue;
      const offset = seg.part.cellToOffset(targetRow, targetCol);
      return offset < 0 ? -1 : seg.textStart + Math.max(0, offset - seg.skip);
    }
    return -1;
  };
  return { startRow: parts[0].startRow, endRow: parts[parts.length - 1].endRow, text, offsetToCell, cellToOffset };
}

// ═══════════════════════════════════════════════════════════════
// Split-Pane Sessions — pure helpers (divider math, picker list)
// ═══════════════════════════════════════════════════════════════

// Desktop-only, same reasoning and same threshold as HOME_SESSIONS_MIN_WIDTH
// (home-sessions.js): two 240px min-width panes plus the divider need ~486px,
// which a phone or narrow tablet cannot give them, and the divider has no
// touch handlers. A dedicated constant rather than reusing
// HOME_SESSIONS_MIN_WIDTH directly — that name lives in home-sessions.js,
// which loads AFTER this file (load order 12.56 vs 7.5), so referencing it
// from module-evaluation-time code here would be a ReferenceError.
const SPLIT_PANE_MIN_WIDTH = 1180;

function clampDividerPercent(rawPercent, min = 20, max = 80) {
  if (rawPercent < min) return min;
  if (rawPercent > max) return max;
  return rawPercent;
}

function buildSplitPickerSessions(sessions, sessionOrder, excludeId, detachedIds) {
  const result = [];
  for (const id of sessionOrder) {
    if (id === excludeId) continue;
    // A detached (popped-out) session's own window owns its PTY size (see
    // sendResize's detachedElsewhere guard in terminal-ui.js;
    // TerminalTile._sendResize() stands aside the same way), so Pane B could
    // only show it at a size it cannot set.
    if (detachedIds?.has?.(id)) continue;
    const session = sessions.get(id);
    if (!session) continue;
    // A session with no PTY attached (exited CLI, a crash-looped session
    // whose breaker tripped, a restore that failed to re-attach) has nothing
    // reading its tmux pane, and the split never does selectSession()'s
    // re-attach POST: Pane B would open a healthy-looking socket onto a pane
    // that nothing feeds and nothing reads.
    if (session.pid === null) continue;
    result.push({ id, label: session.name || 'Session' });
  }
  return result;
}

// ── Tile grid (tile-grid.js) ───────────────────────────────────────────────
//
// Pure layout and state helpers for the tile grid (docs/tile-grid-plan.md):
// 1 to TILE_GRID_MAX live sessions side by side, each in its own TerminalTile.
// Desktop only, behind the same 1180px gate as the split pane.

/**
 * Hard cap on tiles in one grid: the ONE place it is set (owner decision 7 in
 * docs/tile-grid-plan.md). Six was tested smooth on a real desktop; nine missed
 * the headless frame bar and is untested on hardware. Everything that limits
 * the grid reads this, and the layout table still covers up to TILE_LAYOUT_MAX,
 * so raising the cap is this one line.
 */
const TILE_GRID_MAX = 6;
/** The largest count the layout table covers (3x3). Never a cap by itself. */
const TILE_LAYOUT_MAX = 9;
// The smallest tile worth showing: about 60 columns and a dozen rows at the
// default tile font. Bounds how many tiles a window can hold.
const TILE_MIN_W = 480;
const TILE_MIN_H = 240;
// Three tiles go side by side (3x1) only when each still gets ~600px;
// otherwise they take three cells of a 2x2.
const TILE_GRID_WIDE_3X1 = 1800;
// A tile's xterm keeps this many lines, not DEFAULT_SCROLLBACK: a grid of DOM
// renderers at 50k lines each is a real memory cost, and a tile's load is a
// bounded 1 MiB window anyway, so more scrollback only fills with live output.
const TILE_SCROLLBACK = 10000;
// Tiles have their own per-device font size (a tile is a fraction of the screen).
const TILE_FONT_SIZE_DEFAULT = 13;
// What the page's SSE filter names while tiles own the terminal: a value no
// session id takes (ids are UUIDs), so the server, whose filter gates only
// session:terminal batches, sends none. The tiles carry their own output over
// their own sockets, and the parked main terminal only parsed those frames to
// drop them (16 to 18 a second for one busy shell). Every other event still
// arrives (test/sse-tile-grid-filter.test.ts pins the server's side of this).
const TILE_GRID_SSE_FILTER = 'tile-grid';

/**
 * Columns and rows for `count` tiles, by count (the spec's table), and whether
 * that layout gives every cell at least the minimum tile size (TILE_MIN_W x
 * TILE_MIN_H) in a grid area of `width` x `height` px.
 *
 * @param {{count: number, width?: number, height?: number}} p
 * @returns {{cols: number, rows: number, fits: boolean}}
 */
function computeTileLayout({ count, width = Infinity, height = Infinity }) {
  const n = Math.min(Math.max(0, Math.floor(Number(count) || 0)), TILE_LAYOUT_MAX);
  let cols;
  let rows;
  if (n === 0) return { cols: 0, rows: 0, fits: true };
  if (n === 1) { cols = 1; rows = 1; }
  else if (n === 2) { cols = 2; rows = 1; }
  else if (n === 3) {
    if (width >= TILE_GRID_WIDE_3X1) { cols = 3; rows = 1; }
    else { cols = 2; rows = 2; }
  }
  else if (n === 4) { cols = 2; rows = 2; }
  else if (n <= 6) { cols = 3; rows = 2; }
  else { cols = 3; rows = 3; }
  const fits = width / cols >= TILE_MIN_W && height / rows >= TILE_MIN_H;
  return { cols, rows, fits };
}

/**
 * How many tiles a grid area can hold: the largest count up to TILE_GRID_MAX
 * whose layout, and every smaller count's layout, fits. 0 when not even one
 * tile fits.
 *
 * @param {{width: number, height: number}} p
 * @returns {number}
 */
function tileGridCapacity({ width, height }) {
  let capacity = 0;
  for (let n = 1; n <= TILE_GRID_MAX; n++) {
    if (!computeTileLayout({ count: n, width, height }).fits) break;
    capacity = n;
  }
  return capacity;
}

/**
 * The stored grid (`codeman:tile-grid`: session ids and the layout, never
 * content) made safe to apply: unknown, deleted, detached and duplicate ids
 * are dropped, the list is capped at TILE_GRID_MAX, `focused` / `zoomed` must
 * name a kept id, and track fractions must be 1 to 3 finite positive numbers.
 * Anything that is not a v1 object (or its JSON) gives null.
 *
 * The stored `ids` are the grid's CELLS in reading order, `null` for an empty
 * one (a hole can be any cell). The old packed list (no nulls) reads as cells
 * with no hole. `ids` comes back packed (the tiles in reading order, what
 * every list consumer wants) and `cells` keeps the holes: a dropped id (gone,
 * detached, a duplicate, past the cap) becomes `null` there, never a shift.
 *
 * `freed` names the cells whose session no longer exists (or was popped out
 * to its own window) since the grid was stored: the ranking fills those first
 * when the grid comes back (restoreTileGridCells). A hole the user left empty
 * is not freed. `count` is how many tiles the grid had after the user's own
 * last change (a session that went away by itself does not lower it), so the
 * grid comes back to that many when there are sessions to fill it; a value
 * stored before it existed, or a malformed one, reads as the number of
 * sessions the stored cells name.
 *
 * @param {unknown} raw - the parsed value, or the stored JSON string
 * @param {{has(id: string): boolean}|Iterable<string>} liveSessions - ids that exist now
 * @param {{has(id: string): boolean}} [detachedIds] - sessions popped out to their own window
 * @returns {{v: 1, open: boolean, ids: string[], cells: (string|null)[], freed: number[], count: number,
 *   focused: string|null, zoomed: string|null, colFr: number[]|null, rowFr: number[]|null}|null}
 */
function sanitizeTileGridState(raw, liveSessions, detachedIds) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1) return null;
  const live = liveSessions && typeof liveSessions.has === 'function' ? liveSessions : new Set(liveSessions || []);
  const ids = [];
  const cells = [];
  const freed = [];
  const named = [];
  for (const id of (Array.isArray(value.ids) ? value.ids : []).slice(0, TILE_LAYOUT_MAX)) {
    const isId = typeof id === 'string' && id !== '';
    const present = isId && live.has(id) && !detachedIds?.has?.(id);
    const keep = present && !ids.includes(id) && ids.length < TILE_GRID_MAX;
    if (keep) ids.push(id);
    // Its session went away since: the cell is freed for the ranking to fill.
    if (isId && !present && !named.includes(id)) freed.push(cells.length);
    if (isId && !named.includes(id)) named.push(id);
    // A malformed entry (not a string, not null) is a hole too.
    cells.push(keep ? id : null);
  }
  const fractions = (fr) => {
    if (!Array.isArray(fr) || fr.length < 1 || fr.length > 3) return null;
    return fr.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) ? fr.slice() : null;
  };
  const count =
    Number.isInteger(value.count) && value.count >= 1 && value.count <= TILE_GRID_MAX
      ? value.count
      : Math.min(named.length, TILE_GRID_MAX);
  return {
    v: 1,
    open: value.open === true && ids.length > 0,
    ids,
    cells,
    freed,
    count,
    focused: ids.includes(value.focused) ? value.focused : (ids[0] ?? null),
    zoomed: ids.includes(value.zoomed) ? value.zoomed : null,
    colFr: fractions(value.colFr),
    rowFr: fractions(value.rowFr),
  };
}

/**
 * A stored grid as it comes back (the Tiles button, a page reload): its cells
 * exactly as stored, holes the user left included, and its focus (or the tile
 * it had zoomed). Only when it holds fewer tiles than its `count` (sessions
 * that went away since, or by themselves while it was open) does it fill, from
 * `ranked` (best first, never a session already in it): the freed cells first,
 * then the other empty cells, in reading order; more than the cells hold join
 * after them (the shape grows when the grid lays them out, reformTileCells).
 * A cell stays empty only when no other session is left to place. Never
 * trimmed to the window: a grid larger than the window fits shows its focused
 * tile alone until the window fits it again, and the arrangement stays.
 *
 * @param {{cells?: (string|null)[], ids?: string[], freed?: number[], count?: number,
 *   focused?: string|null, zoomed?: string|null}|null} stored - sanitized (sanitizeTileGridState)
 * @param {string[]} ranked - the sessions that may fill a cell, best first (rankTileSessions)
 * @returns {{ids: string[], cells: (string|null)[], focusedId: string}|null} null when none of its sessions survive
 */
function restoreTileGridCells(stored, ranked) {
  const source = Array.isArray(stored?.cells) ? stored.cells : Array.isArray(stored?.ids) ? stored.ids : [];
  const cells = [];
  for (const id of source) cells.push(typeof id === 'string' && id && !cells.includes(id) ? id : null);
  const tiles = cells.filter(Boolean);
  if (tiles.length === 0) return null;
  const focusedId =
    [stored.zoomed, stored.focused].find((id) => typeof id === 'string' && tiles.includes(id)) ?? tiles[0];
  const target = Math.min(Math.max(tiles.length, Math.floor(Number(stored.count)) || 0), TILE_GRID_MAX);
  const fillers = [];
  for (const id of ranked || []) {
    if (typeof id === 'string' && id && !cells.includes(id) && !fillers.includes(id)) fillers.push(id);
  }
  const freed = new Set(Array.isArray(stored.freed) ? stored.freed : []);
  const empty = [];
  cells.forEach((id, k) => {
    if (id === null) empty.push(k);
  });
  // Freed cells first, each group in reading order.
  empty.sort((a, b) => Number(freed.has(b)) - Number(freed.has(a)) || a - b);
  let count = tiles.length;
  for (const k of empty) {
    if (count >= target || fillers.length === 0) break;
    cells[k] = fillers.shift();
    count++;
  }
  const extra = fillers.slice(0, Math.max(0, target - count));
  return { ids: [...cells.filter(Boolean), ...extra], cells, focusedId };
}

/**
 * New track fractions after a divider drag (grid-template `fr` values): the two
 * tracks either side of divider `index` trade `deltaPx` of size, each kept at
 * least `minPx` (or half the pair, if the pair cannot give both the minimum).
 * Every other track keeps its size. Computed from the fractions the drag
 * STARTED with and the pointer's total travel, so a drag never drifts.
 *
 * @param {number[]} fr - the fractions when the drag started
 * @param {number} index - the divider: between track `index` and `index + 1`
 * @param {number} deltaPx - pointer travel since the drag started
 * @param {number} totalPx - the size the tracks share (dividers and padding excluded)
 * @param {number} minPx - the smallest a track may get
 * @returns {number[]} new fractions, same length
 */
function dragTrackFractions(fr, index, deltaPx, totalPx, minPx) {
  const out = fr.slice();
  if (index < 0 || index + 1 >= fr.length || !(totalPx > 0)) return out;
  const sum = fr.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return out;
  const a = (fr[index] / sum) * totalPx;
  const b = (fr[index + 1] / sum) * totalPx;
  const pair = a + b;
  const lo = Math.min(minPx, pair / 2);
  const hi = pair - lo;
  const nextA = Math.min(Math.max(a + (Number(deltaPx) || 0), lo), hi);
  out[index] = (nextA / totalPx) * sum;
  out[index + 1] = ((pair - nextA) / totalPx) * sum;
  return out;
}

/**
 * The sessions the Tiles button can open (case c of tileGridOpenSet, and the
 * ones a count fills a grid with), in the order given (tab order, or the
 * ranking): live ones only, never a session popped out to
 * its own window (that window owns its PTY size). A session with no PTY
 * attached IS offered: its tile shows the Attach overlay.
 *
 * @param {Map<string, {name?: string}>} sessions
 * @param {string[]} sessionOrder
 * @param {{has(id: string): boolean}} [detachedIds]
 * @returns {Array<{id: string, label: string}>}
 */
function buildTilePickerSessions(sessions, sessionOrder, detachedIds) {
  const result = [];
  for (const id of sessionOrder) {
    if (detachedIds?.has?.(id)) continue;
    const session = sessions.get(id);
    if (!session || result.some((r) => r.id === id)) continue;
    result.push({ id, label: session.name || 'Session' });
  }
  return result;
}

// Ranking groups (rankTileSessions): working first, then the sessions waiting
// on the user, then everything else.
const TILE_RANK_GROUP = { working: 0, needs: 1, waiting: 1 };

/**
 * The stamp a session is ranked by inside its group. A WORKING session keys
 * off the pane's last Enter (`lastSubmitAt`) ONLY: a working pane repaints
 * about once a second, so its last-activity stamp is always "now", and one
 * that never submitted would otherwise claim the head of the group. 0 means
 * unknown. Every other state is the home screens' anchor (sessionActivityAnchor:
 * the last byte the pane printed, i.e. when it went quiet).
 */
function tileRankStamp(row) {
  if (row.state === 'working') return Number(row.lastSubmitAt) || 0;
  return sessionActivityAnchor(row);
}

/**
 * Which open sessions the tile grid shows when nobody said which (the Tiles
 * button with no stored grid to bring back, and every place the grid fills a
 * tile on its own: a count picked in its menu, a freed cell), best first
 * (owner request: "prefer to load in tiles that are working and then the most
 * recent, so the oldest don't get opened"):
 *   1. WORKING, the most recently started turn first;
 *   2. then the ones that NEED INPUT, the red and yellow tab alerts (`needs`: a
 *      permission or question dialog; `waiting`: a finished turn not seen
 *      yet), most recent first;
 *   3. then every other one (idle, done, error), most recently active first.
 * Inside a group the newest stamp wins (tileRankStamp) and a session with no
 * stamp (0) sorts last; the final tiebreak is the tab order (`orderIndex`), so
 * the result never shuffles. The states are the home screens' own
 * (`_mobileOverviewState()`, mobile-overview.js), as are the stamps; only the
 * order differs: the home screens put the longest-running turn first, the grid
 * the most recent.
 *
 * Pure. Unit-tested in test/tile-grid-ranking.test.ts.
 *
 * @param {Array<{id: string, state: string, lastActivityAt?: number, lastSubmitAt?: number, orderIndex?: number}>} rows
 * @returns {string[]} the ids, best first, each once
 */
function rankTileSessions(rows) {
  const group = (row) => TILE_RANK_GROUP[row.state] ?? 2;
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row.id === 'string' && row.id);
  list.sort((a, b) => {
    const byGroup = group(a) - group(b);
    if (byGroup !== 0) return byGroup;
    const atA = tileRankStamp(a);
    const atB = tileRankStamp(b);
    if (atA !== atB) {
      if (!atA) return 1;
      if (!atB) return -1;
      return atB - atA;
    }
    const orderA = Number.isFinite(a.orderIndex) ? a.orderIndex : Number.MAX_SAFE_INTEGER;
    const orderB = Number.isFinite(b.orderIndex) ? b.orderIndex : Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });
  const ids = [];
  for (const row of list) if (!ids.includes(row.id)) ids.push(row.id);
  return ids;
}

/**
 * What the Tiles button and Ctrl+Shift+G open, at once and without asking
 * (owner decision 8). In order:
 *   a. the grid this tab last had (`stored`, already sanitized: live, not
 *      detached, at most the cap), if any of its sessions survive, exactly
 *      as it was (restoreTileGridCells: its cells and holes, a cell its
 *      session freed filled from the ranking);
 *   b. else an open split's two sessions, Pane A focused;
 *   c. else the open sessions in `ranked` order (rankTileSessions: working,
 *      then needing input, then the most recent; tab order when no ranking is
 *      given), detached ones never, up to `limit`, the active session always
 *      among them and focused (when it ranks past the limit, the first
 *      `limit - 1` others come with it).
 * Null when there is nothing to open.
 *
 * @param {{stored?: {ids: string[], cells?: (string|null)[], freed?: number[], count?: number,
 *   focused: string|null, zoomed: string|null}|null,
 *   split?: string[]|null, ranked?: string[]|null, sessions: Map<string, object>, sessionOrder: string[],
 *   detachedIds?: {has(id: string): boolean}, activeId?: string|null, limit: number}} p
 * @returns {{source: 'stored'|'split'|'ranked', ids: string[], cells?: (string|null)[],
 *   focusedId: string|null}|null}
 */
function tileGridOpenSet({
  stored = null,
  split = null,
  ranked = null,
  sessions,
  sessionOrder,
  detachedIds,
  activeId = null,
  limit,
}) {
  const all = buildTilePickerSessions(sessions, Array.isArray(ranked) ? ranked : sessionOrder, detachedIds).map(
    (c) => c.id
  );
  const restored = stored ? restoreTileGridCells(stored, all) : null;
  if (restored) return { source: 'stored', ...restored };
  const usable = (id) => typeof id === 'string' && sessions.has(id) && !detachedIds?.has?.(id);
  const pair = (split || []).filter(usable);
  if (split && pair.length) return { source: 'split', ids: [...new Set(pair)], focusedId: pair[0] };
  const max = Math.max(1, Math.min(Math.floor(Number(limit) || 0), TILE_GRID_MAX));
  if (all.length === 0) return null;
  let ids = all.slice(0, max);
  if (all.includes(activeId) && !ids.includes(activeId)) {
    ids = [...all.filter((id) => id !== activeId).slice(0, max - 1), activeId];
  }
  return { source: 'ranked', ids, focusedId: ids.includes(activeId) ? activeId : ids[0] };
}

/**
 * The tile counts the Tiles button's right-click menu offers, and the count a
 * click opens until one is picked (owner decision 10 in docs/tile-grid-plan.md).
 */
const TILE_GRID_COUNTS = [2, 4, 6];
const TILE_GRID_COUNT_DEFAULT = 6;

/** A remembered tile count made safe: one of TILE_GRID_COUNTS, else the default. */
function sanitizeTileCount(raw) {
  const n = Number(raw);
  return TILE_GRID_COUNTS.includes(n) ? n : TILE_GRID_COUNT_DEFAULT;
}

/**
 * `base` (what the grid would open, or what an open grid shows, in its order)
 * trimmed or filled to `n` tiles: trimmed from the end, the session to focus
 * (`keepId`) always kept (it takes the last place when it sat past `n`, as in
 * tileGridOpenSet's case c); filled from `all` (the open sessions, best first:
 * the app passes the ranking, rankTileSessions) with the ones not in it yet.
 * Fewer sessions than `n` give fewer tiles.
 *
 * @param {string[]} base
 * @param {string[]} all
 * @param {number} n - at most TILE_GRID_MAX
 * @param {string|null} [keepId]
 * @returns {string[]}
 */
function tileGridSetForCount(base, all, n, keepId = null) {
  const max = Math.max(1, Math.min(Math.floor(Number(n) || 0), TILE_GRID_MAX));
  const ids = [];
  for (const id of [...(base || []), ...(all || [])]) {
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  // Every `base` id comes before every filler, so a trim never drops a base id
  // in favour of one.
  let out = ids.slice(0, max);
  if (keepId && ids.includes(keepId) && !out.includes(keepId)) out = [...out.slice(0, max - 1), keepId];
  return out;
}

/**
 * Which tile takes focus when `id` leaves the grid: the next one in grid
 * order, else the previous one, else null.
 *
 * @param {string[]} ids - the grid's tiles, in reading order
 * @param {string} id - the tile that is leaving
 * @returns {string|null}
 */
function tileNeighbor(ids, id) {
  const i = ids.indexOf(id);
  if (i === -1) return ids[0] ?? null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/**
 * The tile a directional focus chord moves to, in a row-major grid of `cols`
 * columns whose empty cells are `null` (a hole can be any cell) or simply
 * missing at the end. Focus never lands on a hole. Left and right go along
 * the row, past any hole, and never leave it. Up and down take the nearest
 * row in that direction that has a tile: the tile in the same column, else
 * the one in the nearest column (the lower column on a tie), so moving down
 * onto a short or holed last row lands on its nearest tile. Null when there
 * is no tile in that direction.
 *
 * @param {(string|null)[]} cells - the grid's cells in reading order (or its packed tiles)
 * @param {string} focusedId - the tile the keyboard is in
 * @param {'left'|'right'|'up'|'down'} direction
 * @param {number} cols - the layout's column count
 * @returns {string|null}
 */
function tileInDirection(cells, focusedId, direction, cols) {
  const i = focusedId ? cells.indexOf(focusedId) : -1;
  if (i === -1 || !(cols >= 1)) return null;
  const rows = Math.ceil(cells.length / cols);
  const row = Math.floor(i / cols);
  const col = i % cols;
  const at = (r, c) => cells[r * cols + c] || null;
  if (direction === 'left' || direction === 'right') {
    const step = direction === 'left' ? -1 : 1;
    for (let c = col + step; c >= 0 && c < cols; c += step) {
      if (at(row, c)) return at(row, c);
    }
    return null;
  }
  if (direction !== 'up' && direction !== 'down') return null;
  const step = direction === 'up' ? -1 : 1;
  for (let r = row + step; r >= 0 && r < rows; r += step) {
    let best = null;
    let bestDistance = Infinity;
    for (let c = 0; c < cols; c++) {
      const id = at(r, c);
      if (id && Math.abs(c - col) < bestDistance) {
        best = id;
        bestDistance = Math.abs(c - col);
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * The cell next to cell `index` in that direction (Move Tile: a tile moves
 * into an empty neighbour cell, or swaps with a tiled one), or -1 at the
 * edge. Adjacent only: a move never jumps over a cell.
 *
 * @param {number} index - the cell, in reading order
 * @param {'left'|'right'|'up'|'down'} direction
 * @param {number} cols - the layout's column count
 * @param {number} cellCount - cols x rows
 * @returns {number}
 */
function tileCellInDirection(index, direction, cols, cellCount) {
  if (!(cols >= 1) || index < 0 || index >= cellCount) return -1;
  const col = index % cols;
  let j = -1;
  if (direction === 'left') j = col > 0 ? index - 1 : -1;
  else if (direction === 'right') j = col < cols - 1 ? index + 1 : -1;
  else if (direction === 'up') j = index - cols;
  else if (direction === 'down') j = index + cols;
  return j >= 0 && j < cellCount ? j : -1;
}

/**
 * The grid's cells after its shape changed (or to fill one for the first
 * time): `cols` x `rows` cells, `null` for an empty one. The same shape keeps
 * every cell as it is. A new shape keeps each tile at its row and column when
 * every tile still fits there (2x2 growing to 3x2: the four tiles stay put),
 * and otherwise packs the tiles in reading order from the first cell, holes
 * collapsed (positions do not map between shapes). `oldCols` 0 (no layout
 * yet) always packs.
 *
 * @param {(string|null)[]} cells - the current cells, laid out `oldCols` wide
 * @param {number} oldCols - the column count they were laid out with
 * @param {number} cols
 * @param {number} rows
 * @returns {(string|null)[]}
 */
function fitTileCells(cells, oldCols, cols, rows) {
  const size = Math.max(0, cols * rows);
  if (oldCols === cols && cells.length === size) return cells.slice();
  const out = new Array(size).fill(null);
  const placed = cells.map((id, k) => (id ? { id, row: Math.floor(k / oldCols), col: k % oldCols } : null));
  const keep = oldCols >= 1 && placed.every((p) => !p || (p.row < rows && p.col < cols));
  if (keep) {
    for (const p of placed) if (p) out[p.row * cols + p.col] = p.id;
    return out;
  }
  cells.filter(Boolean).slice(0, size).forEach((id, k) => {
    out[k] = id;
  });
  return out;
}

/**
 * How many columns a grid of `length` cells was laid out with: stored cells
 * carry no shape of their own, and the layout table gives each cell count one
 * shape (computeTileLayout: 1x1, 2x1, 3x1, 2x2, 3x2, 3x3). 0 for any other
 * length (fitTileCells then packs).
 *
 * @param {number} length
 * @returns {number}
 */
function tileCellCols(length) {
  // Every cell count is some count's shape on a wide grid area (2x2, the
  // narrow 3-tile shape, is also the 4-tile one).
  for (let n = 1; n <= TILE_LAYOUT_MAX; n++) {
    const { cols, rows } = computeTileLayout({ count: n });
    if (cols * rows === length) return cols;
  }
  return 0;
}

/**
 * The cells of a grid re-formed to another set of tiles (a count picked in the
 * Tiles menu, or the Tiles button bringing back a remembered grid with more or
 * fewer tiles): the tiles in `keep` stay in their cells and every other cell
 * empties, then the cell model's shape rule (fitTileCells: each tile keeps its
 * row and column when all fit, else they pack in reading order), then the
 * tiles in `add` fill the empty cells in reading order, holes first.
 *
 * @param {(string|null)[]} cells - the cells now, laid out `oldCols` wide
 * @param {number} oldCols
 * @param {string[]} keep - tiles that stay
 * @param {string[]} add - tiles that join, in the order they fill
 * @param {number} cols - the new shape
 * @param {number} rows
 * @returns {(string|null)[]}
 */
function reformTileCells(cells, oldCols, keep, add, cols, rows) {
  const kept = (cells || []).map((id) => (id && keep.includes(id) ? id : null));
  const out = fitTileCells(kept, oldCols, cols, rows);
  for (const id of add) {
    if (!id || out.includes(id)) continue;
    const k = out.indexOf(null);
    // Not for a shape made for the count; a full grid takes no more.
    if (k === -1) break;
    out[k] = id;
  }
  return out;
}

/**
 * The tile Ctrl+Tab / Alt+] (delta 1) or Alt+[ (delta -1) moves to while the
 * grid is open: tiles cycle in reading order and wrap.
 *
 * @param {string[]} ids
 * @param {string} focusedId
 * @param {number} delta - +1 or -1
 * @returns {string|null}
 */
function cycleTile(ids, focusedId, delta) {
  if (ids.length === 0) return null;
  const i = ids.indexOf(focusedId);
  if (i === -1) return ids[0];
  return ids[(i + delta + ids.length) % ids.length];
}

// ── Renderer liveness ──────────────────────────────────────────────────────
//
// iOS DISCARDS scheduled requestAnimationFrame callbacks when a PWA goes to
// the background — not deferred, never delivered. xterm's RenderDebouncer only
// clears its `_animationFrame` handle from INSIDE that callback:
//
//   refresh() {
//     if (this._animationFrame !== undefined) return;   // <- stale forever
//     this._animationFrame = requestAnimationFrame(() => this._innerRefresh());
//   }
//   _innerRefresh() { this._animationFrame = undefined; ... }   // never runs
//
// So after one backgrounding the handle is permanently non-undefined and EVERY
// later render request returns on line one. Parsing is decoupled from
// rendering, so bytes keep filling the buffer correctly and nothing throws —
// the terminal is simply frozen. Closing and reopening fixes it because that
// constructs a new Terminal, and therefore a new debouncer.
//
// Codeman is MORE exposed than a per-session-terminal app: there is exactly one
// xterm instance for the whole page load, so a single backgrounding can wedge
// it until a full reload.
//
// This is the pure decision half. The signature that distinguishes this from
// every other way a terminal can look stuck is that bytes were WRITTEN and the
// element is VISIBLE, yet onRender has not fired since:
//
//   frozen   = wroteAt > renderedAt && now - wroteAt >= threshold && visible
//
// Deliberately NOT a "no output at all" check: a quiet terminal is the normal
// state and must never be kicked. And `visible` is required because a hidden
// terminal legitimately stops rendering (xterm pauses it), so kicking there
// would fire constantly on every backgrounded tab.
const RENDER_STALL_MS = 4000;

// How often the watchdog checks. Deliberately coarse: the failure it catches is
// permanent until healed, so detecting it a second late costs nothing, while a
// tight interval would burn a wakeup per second on every idle phone.
const RENDER_LIVENESS_POLL_MS = 2000;

/**
 * Should the renderer be kicked? Pure so the CI gate can cover it — the DOM
 * half (cancelling the stale handle) lives in terminal-ui.js.
 *
 * @param {{wroteAt:number, renderedAt:number, now:number, visible:boolean,
 *          thresholdMs?:number}} s
 * @returns {boolean}
 */
function shouldKickRenderer(s) {
  if (!s || !s.visible) return false;
  const wroteAt = Number(s.wroteAt) || 0;
  const renderedAt = Number(s.renderedAt) || 0;
  const now = Number(s.now) || 0;
  // Nothing written yet — a fresh terminal has no render to be missing.
  if (wroteAt <= 0) return false;
  // A render landed at or after the last write: the pipeline is alive.
  if (renderedAt >= wroteAt) return false;
  const threshold = Number.isFinite(s.thresholdMs) && s.thresholdMs > 0 ? s.thresholdMs : RENDER_STALL_MS;
  return now - wroteAt >= threshold;
}

// ── Fetch deadlines ────────────────────────────────────────────────────────
//
// No terminal fetch carried any deadline, including `?full=1`, which the code
// itself describes as "unbounded-ish work: at the default history limit it can
// be megabytes". On a stalled mobile link that request hangs on the browser
// default with no retry and no path back to a usable terminal short of a
// reload.
//
// A single fixed timeout is wrong in both directions — too short for a full
// scrollback capture on a slow uplink, too long for a small tail on a dead
// connection. So the deadline is scaled by what is actually being asked for,
// and by how many captures are already in flight: on a slow link those bytes
// must drain before this request's own bytes start moving, and its timer is
// already running the whole time.
const FETCH_DEADLINE_TAIL_MS = 15000;
const FETCH_DEADLINE_FULL_MS = 45000;
const FETCH_DEADLINE_MAX_MS = 120000;

/**
 * Deadline in ms for a terminal capture.
 *
 * @param {{full?:boolean, inflight?:number}} s - `full` = the ?full=1 capture;
 *   `inflight` = captures already running (this one included or not, it only
 *   scales the budget).
 * @returns {number}
 */
function terminalFetchDeadlineMs(s) {
  const full = !!(s && s.full);
  const base = full ? FETCH_DEADLINE_FULL_MS : FETCH_DEADLINE_TAIL_MS;
  const inflight = Math.max(0, Number(s && s.inflight) || 0);
  // Each already-queued capture gets the newcomer one more base budget to wait
  // through. Linear rather than clever: the point is only that eight tabs
  // resuming do not all time out together because each assumed it was alone.
  return Math.min(FETCH_DEADLINE_MAX_MS, base * (1 + inflight));
}

// ── Diagnostics hygiene ────────────────────────────────────────────────────
//
// The crash trail is joined with '\n' into ONE localStorage value and beaconed
// to the server, and at least one call site interpolates server-controlled text
// (a WebSocket close `reason`). An embedded newline there forges extra entries
// in the trail; an unbounded string can fill the storage quota. Both are cheap
// to close, and the trail is something a user may be asked to paste into an
// issue.
const DIAG_ENTRY_MAX_CHARS = 300;

/** Flatten a diagnostic message to one bounded, newline-free line. */
function sanitizeDiagEntry(msg) {
  return String(msg == null ? '' : msg)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .slice(0, DIAG_ENTRY_MAX_CHARS);
}

// ── Recovering a dropped output frame ──────────────────────────────────────
//
// `_onSessionTerminal` drops an incoming frame when the app-owned render queues
// already hold 128KB, which is the right call — the alternative is an unbounded
// backlog — but a hole in a TUI byte stream is a desynced cursor, and a desynced
// cursor is muffled text (issue #464). So the drop is only half of it: the
// recovery has to actually happen.
//
// ⚠️ It used to be a fire-and-forget timer. `_onSessionNeedsRefresh` opens with
// four early returns, and two of them — a buffer load in flight, a refresh
// already owning this session — are MOST likely to be true during exactly the
// output burst that caused the drop. The timer nulled itself before the call,
// so a skipped refresh lost the recovery silently and the dropped bytes were
// never replayed.
//
// Bounded, because the early returns it retries past are transient contention
// that clears in seconds, and a permanently failing refresh must not become a
// forever-loop against the API. A refresh that hit the capture fetch DEADLINE
// is not contention but a stalled link, and is not retried at all: each retry
// would be another `?full=1` capture waiting out a deadline of up to two
// minutes, where the old code cost exactly one. Giving up after the cap leaves
// exactly the garbled frames the old code left, so the floor is no worse.
const DROP_RECOVERY_DELAY_MS = 2000;
const DROP_RECOVERY_MAX_ATTEMPTS = 5;

/**
 * Should a dropped-output recovery run again?
 *
 * @param {{repainted: boolean, timedOut?: boolean, attempt: number, stillActive: boolean}} state
 *   `repainted` — whether `_onSessionNeedsRefresh` actually rewrote the buffer.
 *   `timedOut`  - whether it failed at the capture fetch deadline.
 *   `attempt`   — how many have already run, zero-based.
 *   `stillActive` — whether the dropped session is still the one on screen.
 * @returns {boolean}
 */
function shouldRetryDroppedOutputRecovery({ repainted, timedOut = false, attempt, stillActive }) {
  // Switched away: `selectSession` repaints from the server on its own, so a
  // retry here would be a second replay of a buffer that is about to be written.
  if (!stillActive) return false;
  if (repainted) return false;
  if (timedOut) return false;
  return attempt + 1 < DROP_RECOVERY_MAX_ATTEMPTS;
}

// ── Terminal geometry: xterm and the PTY must never disagree ───────────────
//
// Issue #464 ("text gets muffled"). Claude Code's TUI repaints by wrapping its
// frame at the width the PTY reported and walking the cursor up that many
// ROWS. So a browser terminal whose width differs from the PTY's makes every
// repaint arithmetic wrong: a logical line occupies more physical rows than
// Ink counted, `eraseLines(n)` clears too few of them, and the new frame paints
// over rows that were never erased. Measured against a real xterm — a PTY
// believing 120 columns against a 62-column terminal renders each wrapped line
// twice, and a shorter replacement line leaves the tail of the old one behind.
// That is exactly the doubled rows and half-overwritten prose in the report.
//
// The floor exists because a PTY a handful of columns wide makes any CLI wrap
// every word; it is NOT a display preference, so the browser terminal has to
// honour it too. Three separate call sites used to fit xterm to the RAW
// proposal and report the CLAMPED one, which is how the two drifted apart with
// nothing to notice: resize is write-only, so nobody could see the disagreement.
const TERMINAL_MIN_COLS = 40;
const TERMINAL_MIN_ROWS = 10;

/**
 * The geometry to apply AND report — there is only ever one answer to both.
 * @param {{cols: number, rows: number}|null|undefined} proposed
 * @returns {{cols: number, rows: number}|null}
 */
function clampTerminalDimensions(proposed) {
  if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
  return {
    cols: Math.max(Math.trunc(proposed.cols), TERMINAL_MIN_COLS),
    rows: Math.max(Math.trunc(proposed.rows), TERMINAL_MIN_ROWS),
  };
}

/**
 * What to do when the server reports the PTY's real geometry.
 *
 * The server is the authority: it owns the PTY the CLI is drawing for, and it
 * can refuse a resize outright (`Session.resize` ignores small-viewport
 * requests while a desktop connection holds an active sizing claim) without
 * the asking client ever being told. A terminal that keeps its own WIDTH after
 * such a refusal renders garbage, because Ink wraps its frame and counts its
 * erase rows at the width it was told.
 *
 * ⚠️ COLUMNS ONLY. Rows are deliberately left alone, and adopting them was a
 * real regression: a phone that took a desktop's 43 rows into a viewport with
 * room for 18 painted an `.xterm-screen` far taller than its container, and
 * because xterm's own viewport then had nothing to scroll, the bottom of the
 * frame — the CLI's input line — sat below the container with no gesture that
 * could reach it. Output visible, typing invisible, for as long as the claim
 * stayed hot. Width is the axis the wrap arithmetic depends on; rows only
 * decide how much is on screen at once, and keeping the local row count keeps
 * the composer at the bottom of a viewport that scrolls.
 *
 * @param {{cols: number, rows: number}|null} local - what xterm currently holds
 * @param {{cols: number, rows: number}|null} pty - what the server just reported
 * @returns {{adopt: boolean, cols: number|null}}
 */
function reconcilePtyGeometry(local, pty) {
  if (!pty || !Number.isFinite(pty.cols)) return { adopt: false, cols: null };
  if (!local || !Number.isFinite(local.cols) || local.cols === pty.cols) return { adopt: false, cols: null };
  return { adopt: true, cols: pty.cols };
}

/**
 * Which session does a dashboard URL's fragment ask for? Another page that
 * holds the dashboard's window, such as a task board, points it at
 * `/#session=<id>`. Only the fragment changes between two such links, so the
 * browser keeps the page loaded and fires `hashchange`, and the dashboard
 * switches tabs without reloading. Any other fragment asks for nothing.
 *
 * @param {string} hash - `location.hash`, with or without its leading `#`
 * @returns {string|null} the session id, or null
 */
function sessionIdFromFragment(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const id = params.get('session');
  return id && id.trim() ? id.trim() : null;
}

/** Longest model name a session header shows (the server caps it as well). */
const SESSION_MODEL_MAX_CHARS = 64;
/** A CLI registry id (src/config/cli-registry/schema.ts); anything else is not a class name. */
const CLI_ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * What a session's header says about its harness: the CLI id (the
 * `run-mode-dot <id>` logo class), the registry's label for it, the model the
 * session runs when the server knows it (`SessionState.displayModel`), and the
 * tooltip naming both.
 *
 * The id is data: the label comes from the injected CLI catalog and falls back
 * to the id, so a CLI added through clis.json still gets a name. The model is
 * untrusted text (read off a pane, or a CLI's own report): control characters
 * are dropped and the length capped here too, and callers render it with
 * textContent. The tooltip says where a model that is not the CLI's own report
 * came from, so it never claims more than the server knows: one the session
 * was launched with may have been switched since, one read from the CLI's
 * config is what it is configured to run, and a custom endpoint's model is the
 * endpoint's, whatever the CLI calls it.
 *
 * @param {object} session - a session from app.sessions
 * @param {Array<{id: string, label?: string}>} [catalog] - window.__codemanCliCatalog
 * @returns {{id: string, label: string, model: string, title: string}}
 */
function describeSessionHarness(session, catalog) {
  const id = typeof session?.mode === 'string' && CLI_ID_PATTERN.test(session.mode) ? session.mode : '';
  const entry = id && Array.isArray(catalog) ? catalog.find((cli) => cli?.id === id) : null;
  const label = (typeof entry?.label === 'string' && entry.label.trim()) || id;
  const raw = session?.displayModel?.model;
  const model =
    typeof raw === 'string'
      ? raw
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
          .trim()
          .slice(0, SESSION_MODEL_MAX_CHARS)
      : '';
  const source = session?.displayModel?.source;
  const qualifier = !model
    ? ''
    : source === 'launch'
      ? ' (set at launch)'
      : source === 'custom-endpoint'
        ? ' (custom endpoint)'
        : source === 'config'
          ? ' (from config)'
          : '';
  const title = [label, model].filter(Boolean).join(' \u00B7 ') + qualifier;
  return { id, label, model, title };
}

if (typeof window !== 'undefined') {
  window.CodemanSessionHarness = { describeSessionHarness, SESSION_MODEL_MAX_CHARS };
  window.CodemanHistoryFormat = { formatHistoryBytes, computeHistoryTruncationNotice, computeRewriteScrollLine };
  window.CodemanFilePaths = {
    absoluteFilePathPattern,
    findFilePathLinks,
    resolveLinkedFilePath,
    previewsInFileViewer,
    FILE_PREVIEW_EXTENSIONS,
  };
  window.CodemanTerminalLines = { terminalLogicalLine, terminalPathLine };
  window.CodemanUrlSession = { sessionIdFromFragment };
  window.CodemanSplitPane = {
    clampDividerPercent,
    buildSplitPickerSessions,
    SPLIT_PANE_MIN_WIDTH,
  };
  window.CodemanTileGrid = {
    computeTileLayout,
    tileGridCapacity,
    sanitizeTileGridState,
    buildTilePickerSessions,
    dragTrackFractions,
    tileNeighbor,
    tileInDirection,
    tileCellInDirection,
    fitTileCells,
    cycleTile,
    tileGridOpenSet,
    restoreTileGridCells,
    rankTileSessions,
    sanitizeTileCount,
    tileGridSetForCount,
    tileCellCols,
    reformTileCells,
    TILE_GRID_COUNTS,
    TILE_GRID_COUNT_DEFAULT,
    TILE_GRID_MAX,
    TILE_LAYOUT_MAX,
    TILE_MIN_W,
    TILE_MIN_H,
    TILE_SCROLLBACK,
    TILE_FONT_SIZE_DEFAULT,
    TILE_GRID_SSE_FILTER,
  };
  window.CodemanRenderLiveness = { shouldKickRenderer, RENDER_STALL_MS, RENDER_LIVENESS_POLL_MS };
  window.CodemanFetchDeadline = {
    terminalFetchDeadlineMs,
    FETCH_DEADLINE_TAIL_MS,
    FETCH_DEADLINE_FULL_MS,
    FETCH_DEADLINE_MAX_MS,
  };
  window.CodemanDiag = { sanitizeDiagEntry, DIAG_ENTRY_MAX_CHARS };
  window.CodemanDroppedOutput = {
    shouldRetryDroppedOutputRecovery,
    DROP_RECOVERY_DELAY_MS,
    DROP_RECOVERY_MAX_ATTEMPTS,
  };
  window.CodemanTerminalGeometry = {
    clampTerminalDimensions,
    reconcilePtyGeometry,
    TERMINAL_MIN_COLS,
    TERMINAL_MIN_ROWS,
  };
}
