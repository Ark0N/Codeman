# Split-Pane Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Codeman window show two live sessions side-by-side in one browser tab, with a draggable divider, without touching the existing single-pane session (Pane A).

**Architecture:** Pane A stays exactly what it is today (`this.terminal`/`this._ws`, untouched). A new `SplitTerminalPane` class owns a second, independent xterm instance + WebSocket for Pane B. A new orchestration module (`terminal-split.js`) creates/destroys the split container, reparents the existing `.terminal-wrap`, wires the divider drag, and handles the session picker + auto-collapse edge cases.

**Tech Stack:** Vanilla JS (xterm.js, `xterm-addon-fit`), Fastify WebSocket routes (unchanged), Vitest (pure-logic unit tests via `vm`), Playwright (`test/browser`) for live behavior.

**Spec:** `docs/superpowers/specs/2026-09-15-split-pane-sessions-design.md`

## Global Constraints

- Pane A's existing code path (`this.terminal`, `this._ws`, `_connectWs`, `sendResize`, etc.) is never modified — zero regression risk on the primary pane.
- Pane B does not get the local-echo overlay, CJK IME, touch/mobile handlers, or keyboard accessory bar (desktop-only feature; see spec's "Pane B is deliberately plainer").
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

```typescript
// test/routes/system-routes-split-button-setting.test.ts
import { describe, it, expect } from 'vitest';
import { buildTestApp } from './_route-test-utils';

describe('showSplitButton setting', () => {
  it('round-trips through PUT and GET /api/settings', async () => {
    const app = await buildTestApp();
    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { showSplitButton: true },
    });
    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(getRes.body);
    expect(body.data.showSplitButton).toBe(true);
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
- Test: `test/browser/split-pane-terminal.test.ts` (new, Playwright — this is browser-only behavior: a real xterm instance and a real WebSocket, which is exactly what `test/browser` exists for per the Testing section of CLAUDE.md)

**Interfaces:**
- Consumes: global `window.CodemanTerminalFont.resolve()` / `.resolveWeights()`, `window.codemanCurrentXtermTheme()`, `window.codemanCurrentSkinIsLight()` (all already attached to `window` by `terminal-ui.js`), global `Terminal`/`FitAddon` (vendor libs, already loaded before this script per load order)
- Produces: `class SplitTerminalPane { constructor(sessionId, mountEl); connect(): void; fit(): void; destroy(): void; }`, exposed as `window.SplitTerminalPane`

- [ ] **Step 1: Write the failing test**

```typescript
// test/browser/split-pane-terminal.test.ts
import { test, expect } from '@playwright/test';

// Assumes a live dev server is reachable at BASE_URL (see docs/browser-testing-guide.md
// for the standard live-server fixture other test/browser specs use).
const BASE_URL = process.env.CODEMAN_TEST_URL || 'http://localhost:3151';

test('SplitTerminalPane connects, renders output, and cleans up on destroy', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  // Create a throwaway shell session to point Pane B at.
  const sessionId = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
    });
    const body = await res.json();
    return body.data.id;
  });

  const result = await page.evaluate(async (id) => {
    const mount = document.createElement('div');
    mount.style.width = '400px';
    mount.style.height = '300px';
    document.body.appendChild(mount);

    const pane = new window.SplitTerminalPane(id, mount);
    pane.connect();

    // Wait for the WS to open and at least one output frame to render.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const hasContent = mount.querySelector('.xterm-rows') !== null;

    pane.destroy();
    const cleanedUp = mount.querySelector('.xterm') === null;
    document.body.removeChild(mount);

    return { hasContent, cleanedUp };
  }, sessionId);

  expect(result.hasContent).toBe(true);
  expect(result.cleanedUp).toBe(true);

  await page.evaluate(async (id) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  }, sessionId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:browser -- test/browser/split-pane-terminal.test.ts`
Expected: FAIL — `window.SplitTerminalPane` is undefined.

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

In `src/web/public/index.html`, find the `<script src="terminal-ui.js">` tag and add immediately after it:

```html
<script src="terminal-split.js"></script>
```

In `CLAUDE.md`, find the Frontend load-order line (`... → terminal-ui.js(7) → respawn-ui.js(8) → ...`) and insert `terminal-split.js(7.5)` between them, matching the existing `X.Y of 16` `@loadorder` numbering convention already used for other `.5`-numbered modules (e.g. `tab-rail-resize.js(6.5)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:browser -- test/browser/split-pane-terminal.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full gate to check for regressions**

Run: `npm test`
Expected: PASS (this task adds no vitest-visible surface, so this just confirms nothing broke)

- [ ] **Step 6: Commit**

```bash
git add src/web/public/terminal-split.js src/web/public/index.html CLAUDE.md test/browser/split-pane-terminal.test.ts
git commit -m "feat(split-pane): add SplitTerminalPane class for Pane B"
```

---

### Task 5: Split orchestration — open/close, session picker, reparenting

**Files:**
- Modify: `src/web/public/terminal-split.js` (add orchestration methods, mixed into `CodemanApp.prototype`)
- Test: `test/browser/split-pane-orchestration.test.ts` (new, Playwright)

**Interfaces:**
- Consumes: `window.SplitTerminalPane` (Task 4), `window.CodemanSplitPane.buildSplitPickerSessions` (Task 1), `app.sessions` (`Map<string, {name, ...}>`), `app.sessionOrder` (`string[]`), `app.activeSessionId` (`string | null`)
- Produces: `app.openSplitPicker()`, `app.openSplitPane(sessionId)`, `app.closeSplitPane()`, `app._splitPane` (the live `SplitTerminalPane` instance or `null`), `app._splitSessionId` (the Pane B session id or `null`)

- [ ] **Step 1: Write the failing test**

```typescript
// test/browser/split-pane-orchestration.test.ts
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.CODEMAN_TEST_URL || 'http://localhost:3151';

test('opening and closing a split reparents and restores .terminal-wrap', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000); // let SSE/handleInit settle

  const sessionIds = await page.evaluate(async () => {
    const create = async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      return (await res.json()).data.id;
    };
    return { a: await create(), b: await create() };
  });

  await page.evaluate((id) => window.app.selectSession(id), sessionIds.a);
  await page.waitForTimeout(500);

  const beforeSplit = await page.evaluate(
    () => document.querySelector('.terminal-split-container') === null
  );
  expect(beforeSplit).toBe(true);

  await page.evaluate((id) => window.app.openSplitPane(id), sessionIds.b);
  await page.waitForTimeout(1000);

  const duringSplit = await page.evaluate(() => ({
    hasContainer: document.querySelector('.terminal-split-container') !== null,
    wrapIsChildOfContainer:
      document.querySelector('.terminal-split-container > .terminal-wrap') !== null,
    hasPaneB: document.querySelector('.terminal-pane-b') !== null,
  }));
  expect(duringSplit.hasContainer).toBe(true);
  expect(duringSplit.wrapIsChildOfContainer).toBe(true);
  expect(duringSplit.hasPaneB).toBe(true);

  await page.evaluate(() => window.app.closeSplitPane());
  await page.waitForTimeout(500);

  const afterClose = await page.evaluate(() => ({
    hasContainer: document.querySelector('.terminal-split-container') === null,
    wrapRestored: document.querySelector('.main .terminal-wrap') !== null,
  }));
  expect(afterClose.hasContainer).toBe(true);
  expect(afterClose.wrapRestored).toBe(true);

  await page.evaluate(async (ids) => {
    await fetch(`/api/sessions/${ids.a}`, { method: 'DELETE' });
    await fetch(`/api/sessions/${ids.b}`, { method: 'DELETE' });
  }, sessionIds);
});

test('the split picker excludes the active session', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const sessionId = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
    });
    return (await res.json()).data.id;
  });

  await page.evaluate((id) => window.app.selectSession(id), sessionId);
  await page.waitForTimeout(500);

  const pickerExcludesActive = await page.evaluate((id) => {
    window.app.openSplitPicker();
    const items = Array.from(document.querySelectorAll('.split-picker-item'));
    return !items.some((el) => el.getAttribute('data-session-id') === id);
  }, sessionId);
  expect(pickerExcludesActive).toBe(true);

  await page.evaluate(async (id) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  }, sessionId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:browser -- test/browser/split-pane-orchestration.test.ts`
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

Run: `npm run test:browser -- test/browser/split-pane-orchestration.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full gate to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/public/terminal-split.js test/browser/split-pane-orchestration.test.ts
git commit -m "feat(split-pane): add open/close orchestration, picker, and divider drag"
```

---

### Task 6: Auto-collapse on either session ending

**Files:**
- Modify: `src/web/public/terminal-split.js` (hook into existing SSE session-lifecycle handlers)
- Test: `test/browser/split-pane-auto-collapse.test.ts` (new, Playwright)

**Interfaces:**
- Consumes: the existing `_onSessionDeleted(data)` handler in `app.js` (find it via `[SSE_EVENTS.SESSION_DELETED, '_onSessionDeleted']` in the `app.js` handler map) — this task wraps it rather than replacing it.
- Produces: no new public interface; behavior only.

- [ ] **Step 1: Write the failing test**

```typescript
// test/browser/split-pane-auto-collapse.test.ts
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.CODEMAN_TEST_URL || 'http://localhost:3151';

test('deleting the Pane B session auto-collapses the split', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const sessionIds = await page.evaluate(async () => {
    const create = async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      return (await res.json()).data.id;
    };
    return { a: await create(), b: await create() };
  });

  await page.evaluate((id) => window.app.selectSession(id), sessionIds.a);
  await page.waitForTimeout(500);
  await page.evaluate((id) => window.app.openSplitPane(id), sessionIds.b);
  await page.waitForTimeout(1000);

  // Delete Pane B's session from "outside" (simulating the SSE event another
  // client's delete would produce, by hitting the DELETE route directly).
  await page.evaluate(async (id) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  }, sessionIds.b);
  await page.waitForTimeout(1000);

  const collapsed = await page.evaluate(() => ({
    hasContainer: document.querySelector('.terminal-split-container') === null,
    splitPaneNulled: window.app._splitPane === null,
  }));
  expect(collapsed.hasContainer).toBe(true);
  expect(collapsed.splitPaneNulled).toBe(true);

  await page.evaluate(async (id) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  }, sessionIds.a);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:browser -- test/browser/split-pane-auto-collapse.test.ts`
Expected: FAIL — deleting Pane B's session leaves the split container in place with a dead `SplitTerminalPane`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/web/public/terminal-split.js`, inside the same `Object.assign(CodemanApp.prototype, {...})` block from Task 5, add one more method and wrap the existing handler registration. Since `_onSessionDeleted` is defined in `app.js` and this file loads after it (load order 7.5 vs app.js's 6), monkey-patch it here rather than editing `app.js` — this keeps all split-pane logic in one file per the "files that change together live together" principle:

```javascript
  _wireSplitAutoCollapse() {
    const original = this._onSessionDeleted.bind(this);
    this._onSessionDeleted = (data) => {
      if (this._splitSessionId === data.id) {
        this.closeSplitPane();
      } else if (this._splitPane && this.activeSessionId === data.id) {
        // Pane A's session ended: promote Pane B by closing the split and
        // selecting its session as the new (single) active pane.
        const promoted = this._splitSessionId;
        this.closeSplitPane();
        if (promoted) this.selectSession(promoted);
      }
      original(data);
    };
  },
```

Then, at the bottom of `terminal-split.js` (module scope, after the `Object.assign` call), wire it once at load time:

```javascript
document.addEventListener('DOMContentLoaded', () => {
  if (window.app && typeof window.app._wireSplitAutoCollapse === 'function') {
    window.app._wireSplitAutoCollapse();
  }
});
```

Note: `window.app` is assigned during `app.js` init, which per load order runs before `terminal-split.js`'s `DOMContentLoaded` listener fires (both are deferred to the same event, and script *evaluation* order — app.js at position 6, terminal-split.js at 7.5 — determines listener *registration* order, so app.js's own init logic that creates `window.app` runs first). If this ordering assumption proves wrong when this step is actually run, the fallback is to call `_wireSplitAutoCollapse()` directly from the end of `terminal-split.js` at module-evaluation time instead of inside `DOMContentLoaded`, since `window.app` is what needs to exist, not the DOM.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:browser -- test/browser/split-pane-auto-collapse.test.ts`
Expected: PASS. If it fails specifically because `window.app._onSessionDeleted` was undefined at wire time, switch the wiring approach per the note in Step 3 (call `_wireSplitAutoCollapse()` at module scope, not inside `DOMContentLoaded`) and re-run.

- [ ] **Step 5: Run the full gate to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/public/terminal-split.js test/browser/split-pane-auto-collapse.test.ts
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
