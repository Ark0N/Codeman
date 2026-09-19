# Split-Pane Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Codeman window show two live sessions side-by-side in one browser tab, with a draggable divider, without touching the existing single-pane session (Pane A).

**Architecture:** Pane A stays exactly what it is today (`this.terminal`/`this._ws`, untouched). A new `SplitTerminalPane` class owns a second, independent xterm instance + WebSocket for Pane B. A new orchestration module (`terminal-split.js`) creates/destroys the split container, reparents the existing `.terminal-wrap`, wires the divider drag, and handles the session picker + auto-collapse edge cases.

**Tech Stack:** Vanilla JS (xterm.js, `xterm-addon-fit`), Fastify WebSocket routes (unchanged), Vitest (pure-logic unit tests via `vm`), Playwright (`test/browser`) for live behavior.

**Spec:** `docs/superpowers/specs/2026-09-15-split-pane-sessions-design.md`

## Execution Environment

This plan is implemented entirely inside the existing worktree at
`.worktrees/split-pane-sessions` (branch `feat/split-pane-sessions`), created
before brainstorming started — **not** in the main checkout. Every task's
commit step assumes `cwd` is that worktree. Before each commit, run
`git branch --show-current` and confirm it prints `feat/split-pane-sessions`
(CLAUDE.md's worktree/branch-safety rule) — this repo runs multiple Codeman
sessions concurrently, so verifying is cheap insurance, not ceremony.
All commit steps in this plan already stage explicit paths (never `git add -A`),
in line with the same rule.

## Global Constraints

- Pane A's existing code path (`this.terminal`, `this._ws`, `_connectWs`, `sendResize`, etc.) is never modified — zero regression risk on the primary pane.
- Local-echo overlay, CJK IME, and the keyboard accessory bar are **mobile/touch-only** subsystems in this codebase (`localEchoEnabled` defaults to `MobileDetection.isTouchDevice()`; the accessory bar is phone-toolbar-specific). Pane B gets none of them — not because they're being cut down for desktop, but because split-pane itself is a **desktop-only feature** (it needs a wide viewport), so a mobile-only subsystem has nothing to do there regardless. See the spec's "Key design decision: Pane B is deliberately plainer than Pane A" section for the full reasoning.
- No persistence: a page reload always returns to single-pane view. No localStorage key stores split state.
- Side-by-side only, exactly 2 panes, draggable divider, default 50/50, clamped 20%–80%.
- The "Split" header button follows the existing opt-in header-button pattern: ships with a `btn-split--hidden` marker class, gated by a `showSplitButton` setting (default `false`), so it needs no addition to `test/mobile-header-buttons-policy.test.ts`'s default-visible enumeration (mirrors `showMultiMonitorButton`).
- Splitting a session against itself is disallowed — the picker excludes the currently active session.
- `MAX_WS_PER_SESSION = 5` (`src/web/routes/ws-routes.ts`) is per-session, and Pane A/B are always different sessions, so no server-side change is needed for the connection cap.

---

### Task 1: Pure helpers — divider clamp math and picker list builder

**Files:**
- Modify: `src/web/public/constants.js` (append a new `window.CodemanSplitPane` namespace, following the existing `window.CodemanLineage`/`window.CodemanSessionOrder` pattern already in this file)
- Test: `test/split-pane-helpers.test.ts` (new)

**Interfaces:**
- Produces: `window.CodemanSplitPane.clampDividerPercent(rawPercent, min = 20, max = 80)` → `number`
- Produces: `window.CodemanSplitPane.buildSplitPickerSessions(sessions, sessionOrder, excludeId)` → `Array<{id: string, label: string}>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/split-pane-helpers.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadSplitPaneHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanSplitPane: any }).CodemanSplitPane;
}

describe('CodemanSplitPane.clampDividerPercent', () => {
  it('passes through a value inside the clamp range', () => {
    const { clampDividerPercent } = loadSplitPaneHelper();
    expect(clampDividerPercent(50)).toBe(50);
    expect(clampDividerPercent(35.5)).toBe(35.5);
  });

  it('clamps below the floor to the floor', () => {
    const { clampDividerPercent } = loadSplitPaneHelper();
    expect(clampDividerPercent(5)).toBe(20);
  });

  it('clamps above the ceiling to the ceiling', () => {
    const { clampDividerPercent } = loadSplitPaneHelper();
    expect(clampDividerPercent(95)).toBe(80);
  });

  it('honors custom min/max', () => {
    const { clampDividerPercent } = loadSplitPaneHelper();
    expect(clampDividerPercent(10, 15, 85)).toBe(15);
    expect(clampDividerPercent(90, 15, 85)).toBe(85);
  });
});

describe('CodemanSplitPane.buildSplitPickerSessions', () => {
  it('excludes the active session and preserves tab order', () => {
    const { buildSplitPickerSessions } = loadSplitPaneHelper();
    const sessions = new Map([
      ['a', { name: 'w1-codeman' }],
      ['b', { name: 'w1-mcp-memory' }],
      ['c', { name: null }],
    ]);
    const sessionOrder = ['a', 'b', 'c'];
    const result = buildSplitPickerSessions(sessions, sessionOrder, 'a');
    expect(result).toEqual([
      { id: 'b', label: 'w1-mcp-memory' },
      { id: 'c', label: 'Session' },
    ]);
  });

  it('drops order entries with no matching session (stale ids)', () => {
    const { buildSplitPickerSessions } = loadSplitPaneHelper();
    const sessions = new Map([['a', { name: 'w1-codeman' }]]);
    const sessionOrder = ['a', 'ghost'];
    const result = buildSplitPickerSessions(sessions, sessionOrder, null);
    expect(result).toEqual([{ id: 'a', label: 'w1-codeman' }]);
  });

  it('returns an empty list when only the excluded session exists', () => {
    const { buildSplitPickerSessions } = loadSplitPaneHelper();
    const sessions = new Map([['a', { name: 'w1-codeman' }]]);
    const result = buildSplitPickerSessions(sessions, ['a'], 'a');
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/split-pane-helpers.test.ts`
Expected: FAIL — `CodemanSplitPane` is `undefined` (not yet added to `constants.js`).

- [ ] **Step 3: Write minimal implementation**

Append near the other `window.Codeman*` namespace assignments at the bottom of `src/web/public/constants.js` (same file that already defines `window.CodemanLineage`, `window.CodemanSessionOrder`, etc. — search for `global.CodemanLineage =` to find the right neighborhood):

```javascript
// ═══════════════════════════════════════════════════════════════
// Split-Pane Sessions — pure helpers (divider math, picker list)
// ═══════════════════════════════════════════════════════════════

function clampDividerPercent(rawPercent, min = 20, max = 80) {
  if (rawPercent < min) return min;
  if (rawPercent > max) return max;
  return rawPercent;
}

function buildSplitPickerSessions(sessions, sessionOrder, excludeId) {
  const result = [];
  for (const id of sessionOrder) {
    if (id === excludeId) continue;
    const session = sessions.get(id);
    if (!session) continue;
    result.push({ id, label: session.name || 'Session' });
  }
  return result;
}

global.CodemanSplitPane = {
  clampDividerPercent,
  buildSplitPickerSessions,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/split-pane-helpers.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/public/constants.js test/split-pane-helpers.test.ts
git commit -m "feat(split-pane): add pure divider-clamp and picker-list helpers"
```

---

### Task 2: `showSplitButton` setting + header button (wiring only, no split behavior yet)

**Files:**
- Modify: `src/web/schemas.ts` (add one field next to `showMultiMonitorButton`)
- Modify: `src/web/public/index.html` (header button markup + App Settings checkbox chip)
- Modify: `src/web/public/settings-ui.js` (load/save/defaults/apply, mirroring `showMultiMonitorButton` exactly)
- Test: `test/routes/system-routes-split-button-setting.test.ts` (new)

**Interfaces:**
- Consumes: none (self-contained wiring task)
- Produces: a `.btn-split` element in the header (hidden by default via `btn-split--hidden`), toggled by `applyHeaderVisibilitySettings()`, whose `onclick` will be wired to `app.openSplitPicker()` in Task 5 (not yet — for this task, leave the `onclick` attribute pointing at `app.openSplitPicker()`, a no-op stub is fine since it doesn't exist until Task 5; clicking it before Task 5 lands will throw in the console, which is acceptable mid-plan and is fixed by Task 5).

- [ ] **Step 1: Write the failing test**

This mirrors the existing `test/routes/system-routes-settings-partial-put.test.ts` pattern exactly — there is no `buildTestApp()` helper in this codebase; route tests go through `createRouteTestHarness(registerFn)` from `test/routes/_route-test-utils.ts`, and `GET`/`PUT /api/settings` are NOT wrapped in the `{success,data}` envelope (see `src/web/routes/system-routes.ts:938`, `app.get('/api/settings', ...)` returns the raw settings object directly — read its own comment there for why). `registerSystemRoutes` also drives three watcher singletons on every PUT, so they must be mocked or the route throws.

```typescript
// test/routes/system-routes-split-button-setting.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

const { subagentWatcher, imageWatcher, workflowRunWatcher } = vi.hoisted(() => {
  const makeWatcher = () => ({
    isRunning: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn(() => ({})),
    watchSession: vi.fn(),
    getRecentRunSummaries: vi.fn(() => []),
  });
  return { subagentWatcher: makeWatcher(), imageWatcher: makeWatcher(), workflowRunWatcher: makeWatcher() };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify({})),
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

vi.mock('../../src/subagent-watcher.js', () => ({ subagentWatcher }));
vi.mock('../../src/image-watcher.js', () => ({ imageWatcher }));
vi.mock('../../src/workflow-run-watcher.js', () => ({ workflowRunWatcher }));

describe('showSplitButton setting', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('round-trips through PUT and GET /api/settings', async () => {
    const putRes = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { showSplitButton: true },
    });
    expect(putRes.statusCode).toBe(200);

    const getRes = await harness.app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(getRes.body);
    expect(body.showSplitButton).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/routes/system-routes-split-button-setting.test.ts`
Expected: FAIL — `SettingsUpdateSchema` is `.strict()` and rejects the unknown `showSplitButton` key with a 400.

- [ ] **Step 3: Write minimal implementation**

In `src/web/schemas.ts`, find the line `showMultiMonitorButton: z.boolean().optional(),` and add directly after it:

```typescript
    showSplitButton: z.boolean().optional(),
```

In `src/web/public/index.html`, find the multi-monitor header button (`class="btn-icon-header btn-multimonitor btn-multimonitor--hidden"`) and add a sibling button immediately after it:

```html
<button class="btn-icon-header btn-split btn-split--hidden" onclick="app.openSplitPicker()" title="Split: open a second session beside this one" aria-label="Split: open a second session beside this one"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg></button>
```

In `index.html`'s App Settings → Header & Panels checkbox list (find the `appSettingsShowMultiMonitorButton` chip, `id="appSettingsShowMultiMonitorButton"`), add a sibling chip immediately after its closing `</label>`:

```html
<label class="set-chip" data-preview="header" data-preview-order="12"><input type="checkbox" id="appSettingsShowSplitButton"><svg class="set-chip-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg><span>Split</span></label>
```

In `src/web/public/settings-ui.js`, mirror every `showMultiMonitorButton` line for `showSplitButton`. Four call sites (find each `showMultiMonitorButton` occurrence and add the twin directly after it):

```javascript
// In the load function (near appSettingsShowMultiMonitorButton.checked = ...):
document.getElementById('appSettingsShowSplitButton').checked = settings.showSplitButton ?? defaults.showSplitButton ?? false;

// In the save function (near showMultiMonitorButton: document.getElementById(...).checked,):
showSplitButton: document.getElementById('appSettingsShowSplitButton').checked,

// In the defaults object (near showMultiMonitorButton: false,):
showSplitButton: false,

// In applyHeaderVisibilitySettings() (near the multiMonitorBtn toggle block):
const showSplitButton = settings.showSplitButton ?? defaults.showSplitButton ?? false;
const splitBtn = document.querySelector('.btn-split');
if (splitBtn) {
  splitBtn.classList.toggle('btn-split--hidden', !showSplitButton);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/routes/system-routes-split-button-setting.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full gate to check for regressions**

Run: `npm test`
Expected: PASS (including `test/mobile-header-buttons-policy.test.ts`, which should not flag `.btn-split` since it ships with `btn-split--hidden` and is therefore not in the default-visible enumeration)

- [ ] **Step 6: Commit**

```bash
git add src/web/schemas.ts src/web/public/index.html src/web/public/settings-ui.js test/routes/system-routes-split-button-setting.test.ts
git commit -m "feat(split-pane): add showSplitButton setting and header button"
```

---

### Task 3: Split layout CSS

**Files:**
- Modify: `src/web/public/styles.css` (new rules, no existing rules touched)

**Interfaces:**
- Consumes: none
- Produces: CSS classes `.terminal-split-container`, `.split-divider`, `.terminal-pane-b`, `.terminal-pane-b-header`, `.terminal-pane-b-close` that Task 5's orchestration code creates elements with.

- [ ] **Step 1: Add the CSS**

Append to `src/web/public/styles.css` (place near the end, or near other layout-container rules — exact location doesn't affect behavior since these are new, non-conflicting class names):

```css
/* Split-Pane Sessions: container inserted only while a split is active.
   .terminal-wrap (Pane A) is reparented into this as the first child; it
   keeps every existing rule unchanged since nothing here restyles it. */
.terminal-split-container {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.terminal-split-container > .terminal-wrap {
  flex: 0 0 auto;
  min-width: 240px;
  overflow: hidden;
}

.split-divider {
  flex: 0 0 6px;
  cursor: col-resize;
  background: var(--border-color, #333);
  position: relative;
}

.split-divider:hover,
.split-divider.dragging {
  background: var(--accent-color, #4a9eff);
}

.terminal-pane-b {
  flex: 0 0 auto;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.terminal-pane-b-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--bg-secondary, #1a1a1a);
  border-bottom: 1px solid var(--border-color, #333);
  flex: 0 0 auto;
}

.terminal-pane-b-close {
  cursor: pointer;
  padding: 0 6px;
  opacity: 0.7;
}

.terminal-pane-b-close:hover {
  opacity: 1;
}

.terminal-pane-b-container {
  flex: 1 1 auto;
  min-height: 0;
}
```

- [ ] **Step 2: Visually verify (no automated test for pure CSS)**

Run: `npm run check:public-assets` (Prettier-checks `src/web/public/**`; catches formatting issues, not behavior)
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/web/public/styles.css
git commit -m "feat(split-pane): add split container/divider/pane-b CSS"
```

---

### Task 4: `SplitTerminalPane` class (Pane B's xterm + WebSocket lifecycle)

**Files:**
- Create: `src/web/public/terminal-split.js`
- Modify: `src/web/public/index.html` (add the `<script>` tag)
- Modify: `CLAUDE.md` (append `terminal-split.js` to the Frontend load-order list)
- Test: `test/split-pane-terminal.browser.test.ts` (new)
- Modify: `config/test-suites.ts` (register the new test file path in `BROWSER_TEST_GLOBS`, or `npm run test:browser` silently never runs it — vitest treats "no files matched" as success, and a glob-less array here means literally nothing runs this file unless it's listed)

**Interfaces:**
- Consumes: global `window.CodemanTerminalFont.resolve()` / `.resolveWeights()`, `window.codemanCurrentXtermTheme()`, `window.codemanCurrentSkinIsLight()` (all already attached to `window` by `terminal-ui.js`), global `Terminal`/`FitAddon` (vendor libs, already loaded before this script per load order)
- Produces: `class SplitTerminalPane { constructor(sessionId, mountEl); connect(): void; fit(): void; destroy(): void; }`, exposed as `window.SplitTerminalPane`

⚠️ **This codebase's browser tests do NOT use `@playwright/test`'s own runner, and there is no `test/browser/` directory.** They are ordinary vitest `describe`/`it` files that import `chromium` from the raw `playwright` package and spin up a REAL in-process server via `new WebServer(PORT, false, true)` (port, https=false, testMode=true — testMode makes `TmuxManager`/`Session` spawn a real echo PTY instead of real tmux, per `test/terminal-copy-shortcut.test.ts`, `test/tab-rail-resize.browser.test.ts`). Test files live at the top of `test/`, individually named, and `npm run test:browser`/CI only run files explicitly listed in `config/test-suites.ts`'s `BROWSER_TEST_GLOBS` array — there is no directory glob. Port 3175 (checked against every existing `const PORT =` in `test/*.ts` and the mobile suite's port constants file at plan-writing time — free).

- [ ] **Step 1: Write the failing test**

```typescript
// test/split-pane-terminal.browser.test.ts
/** @fileoverview Real Chromium + real WebSocket coverage for SplitTerminalPane (Task 4 of the split-pane-sessions plan). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3175;
const BASE_URL = `http://localhost:${PORT}`;

describe('SplitTerminalPane in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  it('connects, echoes real PTY output, and cleans up on destroy', async () => {
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      // POST /api/sessions nests the session under data.session, and mode:'shell'
      // does not spawn a PTY on creation alone (pid: null, no pane) — an explicit
      // POST .../shell is what actually starts it (both were bugs in this plan's
      // original text, found and fixed by Task 4's implementer against the real
      // server; corrected here to match what was actually committed).
      const id = (await res.json()).data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id;
    });

    const result = await page.evaluate(async (id) => {
      const mount = document.createElement('div');
      mount.style.width = '400px';
      mount.style.height = '300px';
      document.body.appendChild(mount);

      const pane = new (window as any).SplitTerminalPane(id, mount);
      pane.connect();

      // Wait for the WS to open, then send a real input frame — testMode's
      // echo PTY (TEST_PTY_SCRIPT) echoes each byte back exactly once, which
      // is what proves the WS round-trip actually reaches a real PTY and back,
      // not just that xterm can render locally-written text.
      await new Promise((resolve) => {
        const check = () => (pane._wsReady ? resolve(undefined) : setTimeout(check, 100));
        check();
      });
      pane.ws.send(JSON.stringify({ t: 'i', d: 'SPLITPANE_MARKER\r' }));

      const hasEcho = await new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const buf = pane.terminal.buffer.active;
          for (let i = 0; i < buf.length; i++) {
            if (buf.getLine(i)?.translateToString(true).includes('SPLITPANE_MARKER')) {
              resolve(true);
              return;
            }
          }
          if (Date.now() > deadline) resolve(false);
          else setTimeout(poll, 100);
        };
        poll();
      });

      pane.destroy();
      const cleanedUp = mount.querySelector('.xterm') === null;
      document.body.removeChild(mount);

      return { hasEcho, cleanedUp };
    }, sessionId);

    expect(result.hasEcho).toBe(true);
    expect(result.cleanedUp).toBe(true);

    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, sessionId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:browser -- test/split-pane-terminal.browser.test.ts`
Expected: This file is not yet listed in `config/test-suites.ts`'s `BROWSER_TEST_GLOBS`, so vitest reports 0 files matched and exits 0 (a vacuous "pass" — read the file count, not the color, per CLAUDE.md's Testing section). Register the file in `BROWSER_TEST_GLOBS` FIRST (add `'test/split-pane-terminal.browser.test.ts',` to the array in `config/test-suites.ts`), then re-run: now it actually executes and FAILs — `window.SplitTerminalPane` is undefined.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/web/public/terminal-split.js

/**
 * @fileoverview SplitTerminalPane — a second, independent live terminal pane
 * ("Pane B") for split-view sessions. Deliberately plainer than the primary
 * pane (this.terminal/this._ws in terminal-ui.js): no local-echo overlay, no
 * CJK IME, no touch/mobile handlers, no keyboard accessory bar. Desktop-only
 * feature by nature — see docs/superpowers/specs/2026-09-15-split-pane-sessions-design.md.
 *
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js
 * @dependency terminal-ui.js (window.CodemanTerminalFont, codemanCurrentXtermTheme, codemanCurrentSkinIsLight)
 * @loadorder 7.5 of 16 — loaded after terminal-ui.js, before respawn-ui.js
 */

(function (global) {
  class SplitTerminalPane {
    constructor(sessionId, mountEl) {
      this.sessionId = sessionId;
      this.mountEl = mountEl;
      this.terminal = null;
      this.fitAddon = null;
      this.ws = null;
      this._wsReady = false;
    }

    connect() {
      this.terminal = new Terminal({
        theme: { ...global.codemanCurrentXtermTheme() },
        fontFamily: global.CodemanTerminalFont.resolve(),
        ...global.CodemanTerminalFont.resolveWeights({}),
        fontSize: 14,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: 'block',
        minimumContrastRatio: global.codemanCurrentSkinIsLight() ? 4.5 : 1,
        scrollback: 5000,
        allowTransparency: true,
        allowProposedApi: true,
      });

      this.fitAddon = new FitAddon.FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.open(this.mountEl);
      this.fitAddon.fit();

      this.terminal.onData((data) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ t: 'i', d: data }));
        }
      });

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}${window.CodemanBase.base}/ws/sessions/${this.sessionId}/terminal`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this._wsReady = true;
        this._sendResize();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.t === 'o') {
            this.terminal.write(msg.d);
          } else if (msg.t === 'c') {
            this.terminal.clear();
          }
        } catch {
          /* Malformed frame — ignore, matches primary pane's tolerance. */
        }
      };
    }

    fit() {
      if (!this.fitAddon) return;
      this.fitAddon.fit();
      this._sendResize();
    }

    _sendResize() {
      if (!this._wsReady || !this.fitAddon) return;
      const dims = this.fitAddon.proposeDimensions();
      if (!dims) return;
      const cols = Math.max(dims.cols, 40);
      const rows = Math.max(dims.rows, 10);
      this.ws.send(JSON.stringify({ t: 'z', c: cols, r: rows, v: 'desktop' }));
    }

    destroy() {
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.close();
        this.ws = null;
      }
      if (this.terminal) {
        this.terminal.dispose();
        this.terminal = null;
      }
      this.fitAddon = null;
    }
  }

  global.SplitTerminalPane = SplitTerminalPane;
})(window);
```

In `src/web/public/index.html`, find the `<script src="terminal-ui.js">` tag — check whether it (and its neighbors) actually carry a `defer` attribute in the real file before copying this verbatim; match whatever the surrounding block's real convention is — and add immediately after it:

```html
<script defer src="terminal-split.js"></script>
```

In `CLAUDE.md`, find the Frontend load-order line (`... → terminal-ui.js(7) → respawn-ui.js(8) → ...`) and insert `terminal-split.js(7.5)` between them, matching the existing `X.Y of 16` `@loadorder` numbering convention already used for other `.5`-numbered modules (e.g. `tab-rail-resize.js(6.5)`).

In `config/test-suites.ts`, add `'test/split-pane-terminal.browser.test.ts',` to the `BROWSER_TEST_GLOBS` array (any position — it's a flat list, not order-sensitive).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:browser -- test/split-pane-terminal.browser.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Run the full gate to check for regressions**

Run: `npm test`
Expected: PASS (this task adds no vitest-visible surface to the CI gate itself, so this just confirms nothing broke — `test/split-pane-terminal.browser.test.ts` is excluded from `npm test` by the same `BROWSER_TEST_GLOBS` exclusion list, which is why Step 4 uses `test:browser` instead)

- [ ] **Step 6: Commit**

```bash
git add src/web/public/terminal-split.js src/web/public/index.html CLAUDE.md config/test-suites.ts test/split-pane-terminal.browser.test.ts
git commit -m "feat(split-pane): add SplitTerminalPane class for Pane B"
```

---

### Task 5: Split orchestration — open/close, session picker, reparenting

**Files:**
- Modify: `src/web/public/terminal-split.js` (add orchestration methods, mixed into `CodemanApp.prototype`)
- Test: `test/split-pane-orchestration.browser.test.ts` (new)
- Modify: `config/test-suites.ts` (register the new test file in `BROWSER_TEST_GLOBS`, same reason as Task 4)

**Interfaces:**
- Consumes: `window.SplitTerminalPane` (Task 4), `window.CodemanSplitPane.buildSplitPickerSessions` (Task 1), `app.sessions` (`Map<string, {name, ...}>`), `app.sessionOrder` (`string[]`), `app.activeSessionId` (`string | null`)
- Produces: `app.openSplitPicker()`, `app.openSplitPane(sessionId)`, `app.closeSplitPane()`, `app._splitPane` (the live `SplitTerminalPane` instance or `null`), `app._splitSessionId` (the Pane B session id or `null`)

⚠️ Same test-infrastructure note as Task 4: vitest + raw `playwright` + a real `WebServer(PORT, false, true)`, file at the top of `test/`, registered by exact path in `config/test-suites.ts`. Port 3176 (checked free at plan-writing time, alongside 3175 used by Task 4 — the two suites never run concurrently since `fileParallelism: false` in `config/vitest.browser.config.ts`, but distinct ports avoid any doubt).

- [ ] **Step 1: Write the failing test**

```typescript
// test/split-pane-orchestration.browser.test.ts
/** @fileoverview Real Chromium coverage for split open/close orchestration and the session picker (Task 5). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3176;
const BASE_URL = `http://localhost:${PORT}`;

describe('split-pane orchestration in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  async function createShellSession(): Promise<string> {
    return page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      // POST /api/sessions nests the session under data.session, and mode:'shell'
      // does not spawn a PTY on creation alone (pid: null, no pane) — an explicit
      // POST .../shell is what actually starts it (both found and fixed by Task 4's
      // implementer against this exact pattern; carried forward here so this task
      // does not rediscover the same two bugs).
      const id = (await res.json()).data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id;
    });
  }

  it('opening and closing a split reparents and restores .terminal-wrap', async () => {
    const idA = await createShellSession();
    const idB = await createShellSession();

    await page.evaluate((id) => (window as any).app.selectSession(id), idA);
    await page.waitForFunction((id) => (window as any).app.activeSessionId === id, idA, { timeout: 10000 });

    expect(await page.evaluate(() => document.querySelector('.terminal-split-container') === null)).toBe(true);

    await page.evaluate((id) => (window as any).app.openSplitPane(id), idB);
    await page.waitForSelector('.terminal-pane-b', { timeout: 10000 });

    const duringSplit = await page.evaluate(() => ({
      hasContainer: document.querySelector('.terminal-split-container') !== null,
      wrapIsChildOfContainer: document.querySelector('.terminal-split-container > .terminal-wrap') !== null,
      hasPaneB: document.querySelector('.terminal-pane-b') !== null,
    }));
    expect(duringSplit.hasContainer).toBe(true);
    expect(duringSplit.wrapIsChildOfContainer).toBe(true);
    expect(duringSplit.hasPaneB).toBe(true);

    await page.evaluate(() => (window as any).app.closeSplitPane());
    await page.waitForFunction(() => document.querySelector('.terminal-split-container') === null, null, {
      timeout: 10000,
    });

    const afterClose = await page.evaluate(() => ({
      hasContainer: document.querySelector('.terminal-split-container') === null,
      wrapRestored: document.querySelector('.main .terminal-wrap') !== null,
    }));
    expect(afterClose.hasContainer).toBe(true);
    expect(afterClose.wrapRestored).toBe(true);

    await page.evaluate(async (ids) => {
      await fetch(`/api/sessions/${ids.a}`, { method: 'DELETE' });
      await fetch(`/api/sessions/${ids.b}`, { method: 'DELETE' });
    }, { a: idA, b: idB });
  });

  it('the split picker excludes the active session', async () => {
    const id = await createShellSession();

    await page.evaluate((sid) => (window as any).app.selectSession(sid), id);
    await page.waitForFunction((sid) => (window as any).app.activeSessionId === sid, id, { timeout: 10000 });

    const pickerExcludesActive = await page.evaluate((sid) => {
      (window as any).app.openSplitPicker();
      const items = Array.from(document.querySelectorAll('.split-picker-item'));
      return !items.some((el) => el.getAttribute('data-session-id') === sid);
    }, id);
    expect(pickerExcludesActive).toBe(true);

    await page.evaluate(async (sid) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: register `'test/split-pane-orchestration.browser.test.ts',` in `config/test-suites.ts`'s `BROWSER_TEST_GLOBS` first, then `npm run test:browser -- test/split-pane-orchestration.browser.test.ts`
Expected: FAIL — `app.openSplitPane`/`closeSplitPane`/`openSplitPicker` are undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `src/web/public/terminal-split.js`, after the `SplitTerminalPane` class and its `global.SplitTerminalPane = SplitTerminalPane;` line, still inside the same IIFE closure is not required — this part attaches to `CodemanApp.prototype` at module scope like every other UI mixin file:

```javascript
Object.assign(CodemanApp.prototype, {
  openSplitPicker() {
    if (this._splitPane) {
      this.closeSplitPane();
      return;
    }
    const candidates = window.CodemanSplitPane.buildSplitPickerSessions(
      this.sessions,
      this.sessionOrder,
      this.activeSessionId
    );
    const existing = document.getElementById('splitPickerMenu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'splitPickerMenu';
    menu.className = 'split-picker-menu';
    if (candidates.length === 0) {
      menu.innerHTML = '<div class="split-picker-empty">No other sessions to split with</div>';
    } else {
      menu.innerHTML = candidates
        .map(
          (c) =>
            `<div class="split-picker-item" data-session-id="${escapeHtml(c.id)}" onclick="app.openSplitPane(${escapeHtml(JSON.stringify(c.id))}); document.getElementById('splitPickerMenu')?.remove();">${escapeHtml(c.label)}</div>`
        )
        .join('');
    }
    document.body.appendChild(menu);
    const splitBtn = document.querySelector('.btn-split');
    if (splitBtn) {
      const rect = splitBtn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.right = `${window.innerWidth - rect.right}px`;
    }
  },

  openSplitPane(sessionId) {
    if (this._splitPane) this.closeSplitPane();

    const wrap = document.querySelector('.terminal-wrap');
    const parent = wrap.parentElement;

    const container = document.createElement('div');
    container.className = 'terminal-split-container';

    const divider = document.createElement('div');
    divider.className = 'split-divider';

    const paneB = document.createElement('div');
    paneB.className = 'terminal-pane-b';
    const session = this.sessions.get(sessionId);
    paneB.innerHTML = `
      <div class="terminal-pane-b-header">
        <span>${escapeHtml(session?.name || 'Session')}</span>
        <span class="terminal-pane-b-close" onclick="app.closeSplitPane()">&times;</span>
      </div>
      <div class="terminal-pane-b-container"></div>
    `;

    parent.insertBefore(container, wrap);
    container.appendChild(wrap);
    wrap.style.flexBasis = '50%';
    container.appendChild(divider);
    container.appendChild(paneB);
    paneB.style.flexBasis = '50%';

    this._splitPane = new window.SplitTerminalPane(sessionId, paneB.querySelector('.terminal-pane-b-container'));
    this._splitPane.connect();
    this._splitSessionId = sessionId;

    this._installSplitDividerDrag(divider, wrap, paneB);
  },

  closeSplitPane() {
    if (!this._splitPane) return;
    this._splitPane.destroy();
    this._splitPane = null;
    this._splitSessionId = null;

    const container = document.querySelector('.terminal-split-container');
    if (!container) return;
    const wrap = container.querySelector('.terminal-wrap');
    const parent = container.parentElement;
    wrap.style.flexBasis = '';
    parent.insertBefore(wrap, container);
    container.remove();

    if (this.fitAddon) this.fitAddon.fit();
    this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
  },

  _installSplitDividerDrag(divider, wrap, paneB) {
    let dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      const container = divider.parentElement;
      const rect = container.getBoundingClientRect();
      const rawPercent = ((e.clientX - rect.left) / rect.width) * 100;
      const percent = window.CodemanSplitPane.clampDividerPercent(rawPercent);
      wrap.style.flexBasis = `${percent}%`;
      paneB.style.flexBasis = `${100 - percent}%`;
      if (this.fitAddon) this.fitAddon.fit();
      this._splitPane?.fit();
    };

    const onUp = () => {
      dragging = false;
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    divider.addEventListener('mousedown', () => {
      dragging = true;
      divider.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:browser -- test/split-pane-orchestration.browser.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full gate to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/public/terminal-split.js config/test-suites.ts test/split-pane-orchestration.browser.test.ts
git commit -m "feat(split-pane): add open/close orchestration, picker, and divider drag"
```

---

### Task 6: Auto-collapse on either session ending

**Files:**
- Modify: `src/web/public/terminal-split.js` (hook into existing SSE session-lifecycle handlers)
- Test: `test/split-pane-auto-collapse.browser.test.ts` (new)
- Modify: `config/test-suites.ts` (register the new test file in `BROWSER_TEST_GLOBS`, same reason as Tasks 4-5)

**Interfaces:**
- Consumes: the existing `_onSessionDeleted(data)` handler in `app.js` (find it via `[SSE_EVENTS.SESSION_DELETED, '_onSessionDeleted']` in the `app.js` handler map) — this task wraps it rather than replacing it.
- Produces: no new public interface; behavior only.

⚠️ Same test-infrastructure note as Tasks 4-5: vitest + raw `playwright` + a real `WebServer(PORT, false, true)`. Port 3177 (checked free at plan-writing time, alongside 3175/3176 from Tasks 4-5).

- [ ] **Step 1: Write the failing test**

```typescript
// test/split-pane-auto-collapse.browser.test.ts
/** @fileoverview Real Chromium coverage for split auto-collapse when either session ends (Task 6). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3177;
const BASE_URL = `http://localhost:${PORT}`;

describe('split-pane auto-collapse in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  async function createShellSession(): Promise<string> {
    return page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      // POST /api/sessions nests the session under data.session, and mode:'shell'
      // does not spawn a PTY on creation alone (pid: null, no pane) — an explicit
      // POST .../shell is what actually starts it (both found and fixed by Task 4's
      // implementer against this exact pattern; carried forward here so this task
      // does not rediscover the same two bugs).
      const id = (await res.json()).data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id;
    });
  }

  it('deleting the Pane B session auto-collapses the split', async () => {
    const idA = await createShellSession();
    const idB = await createShellSession();

    await page.evaluate((id) => (window as any).app.selectSession(id), idA);
    await page.waitForFunction((id) => (window as any).app.activeSessionId === id, idA, { timeout: 10000 });
    await page.evaluate((id) => (window as any).app.openSplitPane(id), idB);
    await page.waitForSelector('.terminal-pane-b', { timeout: 10000 });

    // Delete Pane B's session from "outside" (simulating the SSE event another
    // client's delete would produce, by hitting the DELETE route directly).
    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, idB);
    await page.waitForFunction(() => document.querySelector('.terminal-split-container') === null, null, {
      timeout: 10000,
    });

    const collapsed = await page.evaluate(() => ({
      hasContainer: document.querySelector('.terminal-split-container') === null,
      splitPaneNulled: (window as any).app._splitPane === null,
    }));
    expect(collapsed.hasContainer).toBe(true);
    expect(collapsed.splitPaneNulled).toBe(true);

    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, idA);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: register `'test/split-pane-auto-collapse.browser.test.ts',` in `config/test-suites.ts`'s `BROWSER_TEST_GLOBS` first, then `npm run test:browser -- test/split-pane-auto-collapse.browser.test.ts`
Expected: FAIL — deleting Pane B's session leaves the split container in place with a dead `SplitTerminalPane`.

- [ ] **Step 3: Write minimal implementation**

⚠️ **This must wrap the PROTOTYPE method at module-evaluation time, not the instance inside a `DOMContentLoaded` listener.** `connectSSE()` in app.js builds `this._sseHandlerWrappers` once, on first connect, and each wrapper closure captures the handler function by value — `const fn = this[method]` (see the `_SSE_HANDLER_MAP` loop in app.js) — then always invokes that CAPTURED `fn`, never re-reading `this._onSessionDeleted` later. So patching the live instance's `_onSessionDeleted` after `connectSSE()` has already run (which a `DOMContentLoaded` listener cannot guarantee happens before) would silently never fire — the wrapper keeps calling the pre-patch original forever. Patching `CodemanApp.prototype._onSessionDeleted` directly at the top level of `terminal-split.js` sidesteps this entirely: script tags evaluate synchronously in document order, so this patch runs and completes before `app.js`'s own `DOMContentLoaded`-triggered bootstrap ever constructs an instance or calls `connectSSE()` — by the time `this[method]` is looked up, the prototype it falls through to is already the wrapped version.

Append to `src/web/public/terminal-split.js`, after the `Object.assign(CodemanApp.prototype, {...})` block from Task 5, as top-level module code (not inside any function, not inside a `DOMContentLoaded` listener):

```javascript
const _originalOnSessionDeleted = CodemanApp.prototype._onSessionDeleted;
CodemanApp.prototype._onSessionDeleted = function (data) {
  if (this._splitSessionId === data.id) {
    this.closeSplitPane();
  } else if (this._splitPane && this.activeSessionId === data.id) {
    // Pane A's session ended: promote Pane B by closing the split and
    // selecting its session as the new (single) active pane.
    const promoted = this._splitSessionId;
    this.closeSplitPane();
    if (promoted) this.selectSession(promoted);
  }
  return _originalOnSessionDeleted.call(this, data);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:browser -- test/split-pane-auto-collapse.browser.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full gate to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/public/terminal-split.js config/test-suites.ts test/split-pane-auto-collapse.browser.test.ts
git commit -m "feat(split-pane): auto-collapse split when either session ends"
```

---

### Task 7: Documentation — architecture-invariants.md entry

**Files:**
- Modify: `docs/architecture-invariants.md` (one new section, following the existing pattern for feature write-ups in this file)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write the section**

Add a new section (placed near other terminal/session-UI entries, e.g. after "Header button visibility"):

```markdown
**Split-pane sessions** (`showSplitButton`, header button, default OFF): shows two live sessions side-by-side in one Codeman window. Pane A is the untouched, existing singleton terminal (`this.terminal`/`this._ws` in terminal-ui.js); Pane B is a new, independent `SplitTerminalPane` (terminal-split.js) with its own xterm instance and its own `/ws/sessions/:id/terminal` WebSocket. ⚠️ **Pane B is deliberately plainer than Pane A** — no local-echo overlay, no CJK IME, no touch/mobile handlers, no keyboard accessory bar — since this is a desktop-only feature (a split view needs a wide viewport) and those features exist for mobile/touch input. No persistence: closing the browser tab or reloading always returns to the normal single-pane view; there is no localStorage key for split state. ⚠️ Splitting a session against itself is disallowed (the picker excludes the active session), and `MAX_WS_PER_SESSION` needs no change since Pane A/B are always two different sessions. ⚠️ Either pane's session ending (deleted locally or from another client) auto-collapses the split — Pane A's session ending promotes Pane B to the new single pane via `selectSession()`, never by trying to hot-swap the lightweight `SplitTerminalPane` object into the primary singleton state. Related but distinct: `detachSession()` already opens one session in a separate OS-level browser window (`isSoloWindow`) — that is prior art for "two sessions visible at once" but not for one window with a draggable in-page divider, which is what this feature adds. Design: `docs/superpowers/specs/2026-09-15-split-pane-sessions-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture-invariants.md
git commit -m "docs: add split-pane sessions architecture-invariants entry"
```

---

## Self-Review Notes (completed during plan authoring)

- **Spec coverage**: side-by-side split (Task 5), draggable divider (Task 5), 50/50 default clamped 20–80% (Task 1 + Task 5), button+picker trigger excluding active session (Task 2 + Task 5), Pane A untouched (Global Constraints + every task explicitly avoids editing `terminal-ui.js`), Pane B feature-reduced (Task 4's fileoverview comment + Global Constraints), no persistence (no task writes a localStorage key), auto-collapse both directions (Task 6), subagent windows unchanged (no task touches `subagent-windows.js` or `ultracode-windows.js` — confirmed nothing in this plan needs to, since they already float independent of `.terminal-wrap`'s layout).
- **Placeholder scan**: none found — every step has real code or a real doc paragraph.
- **Type/name consistency checked**: `SplitTerminalPane` (class name) used identically in Tasks 4, 5, 6; `_splitPane`/`_splitSessionId` (instance state) used identically in Tasks 5, 6; `openSplitPicker`/`openSplitPane`/`closeSplitPane` (method names) used identically in Tasks 2 (button onclick), 5 (definition), 6 (auto-collapse caller).
- **Post-approval fixes (SDD pre-flight, before Task 1 dispatch):** Task 2's test originally invented a `buildTestApp()` helper and a `{data:...}` envelope that don't exist for `/api/settings` — corrected against the real `createRouteTestHarness`/`registerSystemRoutes` pattern in `test/routes/system-routes-settings-partial-put.test.ts`. Tasks 4-6 originally used `@playwright/test`'s own runner against a `test/browser/` directory that does not exist in this codebase — corrected to the real pattern (vitest `describe`/`it` + raw `playwright` package + `new WebServer(PORT, false, true)`, files at the top of `test/`, individually registered in `config/test-suites.ts`'s `BROWSER_TEST_GLOBS`) found in `test/terminal-copy-shortcut.test.ts` and `test/tab-rail-resize.browser.test.ts`. Ports assigned: 3175 (Task 4), 3176 (Task 5), 3177 (Task 6), checked against every existing `const PORT =` in `test/*.ts` plus the mobile suite's port constants at fix-time.
