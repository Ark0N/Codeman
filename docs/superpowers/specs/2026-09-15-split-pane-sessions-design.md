# Split-Pane Sessions — Design Spec

**Status**: Draft, pending review
**Author**: Claude (session with Tim), 2026-09-15
**Scope**: v1 only. v2 items are named and explicitly deferred, not designed.

## Problem

Codeman's terminal area shows exactly one active session (pane) at a time —
switching panes re-binds the single xterm instance and the single WebSocket
to a different session. Multi-monitor spanning (`scripts/span-codeman.sh` /
`span-codeman.ps1`) turned out to solve a different problem: it makes one
browser window bigger, but that window still shows one session; floating
subagent windows are draggable overlays on top of it, not tiled panes. There
is no way today to see two live sessions (e.g. `w1-codeman` and
`w1-mcp-memory`) side-by-side in one window, even on a monitor wide enough to
fit both.

## Goal (v1)

From the active session, open a **second, independent, fully live session**
in a pane beside it — draggable divider, side-by-side only. Closing the
second pane collapses back to today's normal single-pane view. No
persistence: a page reload always returns to single-pane. Floating
subagent/Ultracode windows keep their current behavior unchanged (global,
unconstrained across the whole viewport, split or not).

Explicitly out of scope for v1 (v2 candidates, not designed here):
- More than 2 panes / grid layouts
- Vertical (stacked) splits
- Drag-a-tab-to-split as a trigger (v1 trigger is an explicit button + picker)
- Persisting the split layout across reload or across devices
- Mobile/tablet layouts (viewport is too narrow for this to make sense; gated
  to desktop widths the same way `home-sessions.js`'s rail is)
- Feature parity between the two panes (see "Pane B is deliberately plainer"
  below)

## Current architecture (why this isn't a CSS change)

`terminal-ui.js` is built entirely around **singleton** state: `this.terminal`
(one xterm instance), `this._ws`/`this._wsSessionId` (one WebSocket, rebound
on every pane switch via `_disconnectWs()` + `_connectWs(newId)`), a
`this._xtermSnapshots` map used only to restore scrollback into that one
terminal when switching back to a session. Roughly 280 references to this
singleton state exist across the file (input handling, resize/fit, sizing-
token claims, mobile touch gestures, CJK IME, local-echo overlay wiring,
keyboard accessory bar, link providers, etc.).

Showing two sessions at once therefore requires a second, independently
alive xterm + WebSocket pair running concurrently — not a layout change to
one shared instance.

**Related prior art**: `detachSession(id)` (app.js) already opens one session
in a genuinely separate browser window (`isSoloWindow` mode) with its own
independent WebSocket, and two of those can already be snapped side-by-side
today with zero new code. That covers "two sessions visible at once" but not
what this spec is for: one Codeman window with two panes and a divider you
can drag without leaving your seat, each still a full participant in that
window's floating subagent windows, header, and settings. This spec builds
past detach, not a duplicate of it.

**Server-side check (done, not just assumed)**: `MAX_WS_PER_SESSION = 5`
(`src/web/routes/ws-routes.ts`), scoped by `clientId:tabNonce`
(`ws-connection-registry.ts`). Splitting always opens a *different* session
in the second pane (self-splitting is disallowed, see below), so this is two
sessions each getting their normal one connection — the existing cap is
irrelevant here and needs no server change.

## Key design decision: Pane B is deliberately plainer than Pane A

Porting all ~280 singleton behaviors to a second, symmetric pane is not
worth it for v1 — most of that code is input-quality-of-life for **mobile/
touch** (local-echo overlay, CJK IME textarea, touch gesture handling,
keyboard accessory bar), and this feature is desktop-only by nature (a split
view needs a wide viewport). So:

- **Pane A** (the session that was already active when you opened the split)
  stays exactly what it is today — `this.terminal`, `this._ws`, unchanged
  code path, zero regression risk.
- **Pane B** is a new, smaller `SplitTerminalPane` object: its own xterm
  instance + fit addon, its own WebSocket to `/ws/sessions/:id/terminal`,
  resize-on-divider-drag, and plain keyboard input. It does **not** get the
  local-echo overlay, CJK IME composition, touch/mobile handlers, or the
  keyboard accessory bar. On a desktop, typing directly into an xterm
  instance with no overlay is exactly how Codeman behaved before the local-
  echo overlay existed for touch devices — normal, not degraded, for a
  keyboard-and-mouse user.

If this asymmetry actually bothers you in daily use, promoting Pane B to full
parity is a scoped v2 (extract the shared logic already once you have two
call sites to compare, rather than guessing the right abstraction now).

## Components

### 1. `SplitTerminalPane` (new, `terminal-split.js`)

A small class, one instance per secondary pane:
- `constructor(sessionId, mountEl)`
- `connect()` — creates the xterm instance (same theme/font config as the
  primary, read from the same settings so it doesn't visually clash), opens
  `/ws/sessions/:id/terminal`, wires input → WS, WS → terminal write
- `fit()` — calls the fit addon; called on divider drag (rAF-throttled) and
  on window resize
- `destroy()` — disposes the xterm instance, closes the WS cleanly

No snapshot/scrollback-restore map is needed the way `_xtermSnapshots` exists
for Pane A — Pane B is destroyed on close, not hidden-and-restored, since
there's no persistence requirement.

### 2. Split container (layout)

```
.terminal-split-container         (flex row, only rendered when split is active)
├── .terminal-wrap                (existing element, Pane A — untouched)
├── .split-divider                (new, draggable seam)
└── .terminal-pane-b              (new, hosts SplitTerminalPane's xterm + a
                                    small header: session name + × close button)
```

When not split, `.terminal-wrap` renders exactly as it does today (no
wrapping container at all, to keep the no-split path byte-identical to
current behavior). Splitting inserts the container and reparents
`.terminal-wrap` into it as the first child — same reparenting pattern
already used by `applySessionListLayout()` for `#sessionTabs`, so this isn't
a new pattern for the codebase.

Default split is 50/50 (`flex-basis: 50%` each). Divider drag updates both
panes' `flex-basis` live (rAF-throttled) and calls `fit()` on **both**
terminals per tick, clamped to 20%/80% so neither pane can be dragged into an
unusably thin sliver.

### 3. Trigger UI

A **"Split"** button (header, opt-in like the other header buttons —
`showSplitButton`, default off, same pattern as `showMultiMonitorButton`)
opens a small picker listing your other open sessions (reuses
`this.sessions`/`sessionOrder`, filtered to exclude the currently active
session — you cannot split a session against itself). Picking one:
1. Creates the split container, reparents `.terminal-wrap`
2. Instantiates `SplitTerminalPane` for the chosen session in `.terminal-pane-b`
3. Button state flips to "close split" (or Pane B's own header × does it)

Closing (via Pane B's × or the header button toggling off):
1. `SplitTerminalPane.destroy()`
2. Removes `.terminal-split-container`, reparents `.terminal-wrap` back to
   its original location at 100% width
3. Fires a resize/fit on Pane A (same `ResizeObserver`-driven fit already in
   place today — no new code needed here, it fires naturally once the
   container's size changes)

v2 note (not designed): dragging a session tab onto the active pane as an
alternate trigger. You confirmed right-click doesn't work today (Codeman
doesn't intercept it) and declined a keybind, so v1 is button+picker only.

### 4. Failure / edge cases

- **The Pane B session ends or is deleted while split is active** → treat
  identically to the user closing Pane B manually: destroy the pane, collapse
  to Pane A at full width.
- **The Pane A session ends while split is active** → Pane B is promoted:
  it becomes the new single full-width pane (reusing today's normal
  single-pane code path means Pane B's `SplitTerminalPane` must hand off to
  a real `this.terminal`/`this._ws` binding — simplest correct approach is
  to just collapse the split and let normal session-select logic reopen
  Pane B's session as the new primary, rather than trying to promote the
  lightweight pane object in place).
- **Both end** → falls through to today's normal "no active session" /
  welcome-screen state.
- **Subagent/Ultracode floating windows** → no design work needed; they're
  already positioned independent of `.terminal-wrap`'s layout, so they
  continue to float over whichever pane(s) are on screen, unconstrained,
  exactly as today.

## Testing

- Unit: `SplitTerminalPane` connect/fit/destroy lifecycle (mock WS, like
  existing terminal tests use `TEST_PTY_SCRIPT`).
- Route/integration: opening two WS connections to two different sessions
  from one simulated client concurrently — confirms the existing per-session
  cap and connection registry need no changes.
- Browser (Playwright, `test/browser` since this is desktop-viewport-gated
  UI): open split via button+picker, verify both panes render live output
  independently, drag divider and confirm both refit, close Pane B and
  confirm Pane A returns to full width, kill the Pane B session externally
  and confirm auto-collapse.

## Open questions for review

None blocking — the scope-narrowing decisions above (Pane B feature parity,
no persistence, side-by-side only, button+picker trigger) came directly from
your answers during brainstorming. Flag anything here you want reconsidered.
