# Tile Grid: Design Spec

**Status**: PR 1 (tile foundation) implemented on `feat/terminal-tile`; PR 2 (the grid) implemented on `feat/tile-grid`, both local only. Builds on `docs/split-pane-sessions-plan.md`; the split pane stays.
**Author**: Claude (planning session with the maintainer), 2026-10-06
**Branches**: PR 1 `feat/terminal-tile`, PR 2 `feat/tile-grid` stacked on it (worktrees `claudeman-tiles`, `claudeman-tilegrid`)
**Scope**: v1 is fully designed here; follow-ups are named at the end and explicitly deferred.

## As built: where PR 2 differs from this spec

The design below stands; these are the places the built grid deliberately went another way,
or settled a question the spec left open. The invariants as built are in
`docs/architecture-invariants.md#tile-grid`.

- **An agent that exited in a live pane (`paneExit`) gets no Attach button.** Both attach
  routes (`/interactive`, `/shell`) refuse while the pane's tmux client still runs ("Session
  already has a running process") and report that in the envelope of a 200, so the
  edge-case row below cannot work without a server change. The tile shows the exit and
  points at Close session. A session with no PTY (`pid === null`) and a socket closed with
  4009 do get Attach. Restarting an exited agent in place is a follow-up.
- **`Ctrl+Shift+G` follows `showTileGridButton`** (decided by the owner, decision 6): with
  the setting off the toggle chord is inert. A grid opened another
  way (Ctrl/Cmd+click, a dropped tab, "Open group as tiles") keeps all its chords.
- **Dividers are grid tracks.** Each gap between columns and rows is its own 6px track (the
  grid gap is 0) and every tile and every empty slot is placed explicitly in its cell
  (`grid.cells`, see "Tiles move"). Fractions reset when the column or row count changes.
- **Zoom follows tmux.** Moving focus to another tile restores the grid; an automatic zoom
  (window too small for the minimum tile) follows focus instead.
- **Tile loads are bounded** (`boundedLoad`), carry a fetch deadline covering the body (Pane
  B too), and a refresh clears the screen at its turn in the queue, so a waiting tile keeps
  its last frame.
- **4009 lands on the Attach overlay**, and 4003/4004/4010 remove the tile.
- **Tile header buttons are 26px targets with 16 to 19px glyphs** (owner feedback: the
  first build's 12px glyphs read as tiny next to the name), the size of the app header's own
  icon buttons; the header grew from 24 to 28px to hold them.
- **The grid is translated for 简体中文 (zh-CN)** (owner request): 平铺 for the feature, 窗格 for
  one tile, key names untranslated, mouse actions in the Help modal's key column (`Click`,
  `Right-click`) and `Arrows` translated. Every string has its own entry or pattern; refreshes
  compare with the last English value, not the translated DOM.
- **The Tiles button opens the grid at once** (owner decision 8, with the count of
  decision 10): a click (and `Ctrl+Shift+G`, the same `toggleTileGrid`) opens the remembered
  count of tiles (default 6, at most what the window fits). `tileGridOpenSet`
  (constants.js) picks the grid this tab last had, else an open split's two sessions, else
  the open sessions in tab order, the active one always included and focused, and
  `tileGridSetForCount` trims it (from the end, the session to focus kept) or fills it
  (from tab order) to the count. A remembered grid comes back with its tiles first, in
  their cells, then sessions in tab order, to the count in total: the count is a shape
  change under the cell model's rule (`reformTileCells`: the tiles keep their row and
  column when all fit, else they pack in reading order) and the added tiles fill the empty
  cells first. This supersedes decision 8's "exactly the stored set" (owner answer). A
  remembered grid still wins over an open split: the split closes and its sessions are not
  seeded first. A page-load restore brings back exactly the stored grid, whatever the
  count. Ctrl/Cmd+click on a tab with the grid closed opens the count in total, that
  session among them and focused (owner answer: N, not N+1).
- **Right-click on Tiles is a 2 / 4 / 6 count menu** (owner decision 10; the session
  picker is gone). Three counts with their shapes (the grid's own 2x1, 2x2, 3x2 drawn as
  cells), the remembered one checked. A count the window cannot fit is greyed out with the
  reason ("This window fits N tiles"); a remembered count that does not fit stays checked
  but greyed, the keyboard starts on the largest that fits, and a click opens what fits.
  Shift+F10 and the Menu key open it too (the browser's contextmenu event). Arrows move
  over the counts that fit, Enter or Space picks, Escape closes it alone (the global
  Escape handler gives it the key first, like the tab-group menu) and puts the keyboard
  back on the Tiles button, Tab and a click elsewhere close it. A pick is remembered per
  device in `codeman:tile-count` (`codeman:tile-grid` stays ids only) and opens that many
  tiles; with the grid open it re-forms it (`_reformTileGrid`): the focused tile always
  stays, the others leave from the end or join from tab order, filling empty cells first,
  every joining tile mounted and laid out before any connects (one fit, one PTY resize
  each), and a zoom the user chose ends. The other ways in (Ctrl/Cmd+click, a dragged tab,
  "Open group as tiles", Run) still add up to the cap of 6.
- **The grid opens and closes with a short animation, on by default** (owner request:
  "when clicking on the tile button first make this animation nicer"). It is the grid's
  own, not an `entrance-animations.js` theme (those are off by default). Opening, each tile
  fades and settles in (opacity, translateY 6px and scale .97), 180 ms, 24 ms apart in
  reading order (`--tile-enter-index`): the last of six is done at 300 ms; a tile added
  later enters the same way. Its terminal stays transparent (`.tile--revealing`) until the
  load queue reports its first capture done, then fades in whole (160 ms), so no replay
  scrolls by. Closing with the toggle (button, Ctrl+Shift+G; owner answer: only these), a
  still copy of the tiles (`_ghostTileGrid`: clones, no xterm, socket or listener; inert,
  `aria-hidden`, no pointer) dims at once over the stage (so the click is answered) and
  stays until the single view's `selectSession` has replayed its session, at most 700 ms,
  then fades: no empty single view between the two. A re-form fades the old grid's copy at
  once. The count menu fades in (140 ms). Every one animates opacity and transform only, so
  FitAddon measures the final cell and each tile still sends one PTY resize; under
  `prefers-reduced-motion` nothing moves and no copy is made. A web tab hides the copy.
- **Opening paints the frames first** (owner answer: "paced connect: in"). The six
  terminals used to be built inside the click (about 100 of its 140 ms before the first
  frame). `_connectTilesPaced` builds one per animation frame, the focused tile's first,
  so the click paints its empty tiles in about 20 ms and the entrance plays while they are
  built. The time until all tiles have painted is unchanged: the load queue serves one
  capture at a time, so only the focused tile's connect is on its path, one frame later.
  `openTileGrid` therefore returns before the terminals exist: a selection that focuses a
  tile whose terminal is not built yet hands the keyboard over in `_connectTile`
  (`focusOnConnect`), never when `focus: false` was asked.
- **The grid holds at most 6 tiles** (owner decision 7). `TILE_GRID_MAX` in constants.js is
  the one cap every limit reads; the layout table keeps 7 to 9 (`TILE_LAYOUT_MAX`), unreachable,
  so going back to nine is that one line. A stored grid with more ids comes back as its first
  six. Where this spec says nine, read six.
- **Each header names the harness and the model** (owner request): the tile header is
  `● [logo] name · model ……… ⋯ ⤢ ×`. The logo is PR #532's `run-mode-dot <cliId>` slot
  (the id is data), the model the session's `displayModel` (custom endpoint, else what the
  CLI itself reports: claude's statusline, a footer read with `capabilities.modelDetect`
  for dsh and codex; else what the CLI's config pins, dsh-TUI's route (owner feedback 1:
  a dsh session with its status bar's model field off shows `qwen3.8-27b (from config)`);
  else the launch model; else nothing, the logo alone). Both split
  panes carry the same strip: Pane B's header, and Pane A's while the split is open. Pane
  B's close is a tile button (26px).
- **No + in the tile header** (owner decision 9): the header is `● name ……… ⋯ ⤢ ×`. The
  + menu and its "New session in this case" are gone; tiles are added from the Tiles
  button (and its right-click count menu), Ctrl/Cmd+click on a tab, a dragged tab, "Open
  group as tiles" and Run joining the open grid. Where this spec describes a `+`, it no
  longer exists.
- **No SSE terminal stream while tiles own the terminal** (performance pass): the filter
  names a fixed id no session takes (`TILE_GRID_SSE_FILTER`), not `[activeSessionId]` as
  "Parking the main terminal" below says; the server's filter gates only terminal
  batches, so lifecycle and hook events are unaffected, and leaving the grid
  re-subscribes the shown session.
- **Tiles move** (owner request: "give me the option to move the tiles around"; not a
  numbered decision). The grid is CELLS, not a packed list (owner: "the empty tab doesnt
  always have to be the last one ... it can also be tab nr 4 or 3"): `grid.cells` holds a
  session id or `null` per cell and is the one source of truth, `grid.ids` the tiles in
  reading order derived from it. The shape still comes from the tile count (the layout
  table), the cap counts tiles, never empty cells, and an empty cell can be any cell (in
  practice one at most: a 3x2 holds 5 or 6 tiles, a 2x2 3 or 4). A tile's header, its free
  area (not the buttons, not the rename input), drags it: onto another tile the two trade
  places, onto an empty cell it moves there and leaves its own cell empty, nothing else
  moving; a tiled session's tab does the same, and a tab of a session not tiled yet joins in
  the cell it is dropped on. It is a native drag through the tab drop targets (capture
  phase, stopped before xterm), carrying a type of its own and never text, and it is not
  `draggedTabId`, so neither a text field nor the tab strip takes it; Escape or a drop
  anywhere else cancels with nothing changed, focus included: the header focuses its tile on
  click, not on press (owner's answer: best practice; the body keeps press-to-focus, so
  focus moves before a press reaches xterm). `Ctrl+Shift+Arrows` (Move Tile
  Left/Right/Up/Down, registry, rebindable) move the focused tile to the adjacent cell: into
  it when empty, trading places when a tile is there, never jumping a cell; focus stays on
  it. Every move goes through `_reorderTiles`: no remount, reconnect or reload; divider
  sizes belong to the cells, so only a tile whose cell size changed fits (one PTY resize,
  #464). Removing a tile leaves its cell empty where it was, and adding one takes the first
  empty cell (or the one a tab was dropped on), while the shape stays; a shape change
  (`fitTileCells`, constants.js) keeps each tile's row and column when all fit and otherwise
  packs the tiles in reading order, which differs from plain packing only when a 2x2 grows
  to a 3x2 (the four tiles stay put). Focus never lands on an empty cell: Alt+Shift+Arrows
  go along the row past one, or to the nearest row with a tile (the same column, else the
  nearest), and Ctrl+Tab and Alt+[ / ] cycle the tiles only. `codeman:tile-grid` stays ids
  only: its `ids` are the cells, `null` for an empty one (a build before cells drops the
  nulls and reads them packed); a reload brings the holes back when the shape is the same, a
  session gone by then leaves its cell empty, another shape packs, and the old packed format
  reads unchanged. A fresh grid (Ctrl/Cmd+click with the grid closed, "Open group as
  tiles") opens packed; only the toggle and the page-load restore bring holes back (the
  toggle through `reformTileCells` when the count changes the set). Moving is off while a tile is zoomed (the chords still apply there, as a no-op, so
  their keys never reach the CLI; a tiled tab dropped on the zoomed tile is refused too, as
  the owner confirmed) and with a single tile. Both arrow chord families, focus and move,
  skip a text field, where shifted arrows select (owner's answer: best practice). Default
  keys: every other two-modifier arrow chord is taken (Ctrl+Alt switches workspaces,
  Ctrl+Alt+Shift moves a window to another workspace in GNOME, Alt is back/forward,
  Alt+Shift focuses tiles); Ctrl+Shift+Arrows is unclaimed by the browsers, GNOME, KDE,
  macOS and Claude Code, and costs only a terminal editor's word selection inside a tile
  while the grid is open.
- **A tile that joins before its pane exists resends its size when the pid appears**
  (`TerminalTile.paneStarted()`): the server drops a resize for a session with no PTY and
  spawns at 120x40, and Run's own resize measures the parked main terminal. Applying a
  pre-spawn resize at spawn time on the server would make this unnecessary (follow-up).

## Problem

Codeman's terminal area shows exactly one session at a time. The split pane
(`showSplitButton`, `src/web/public/terminal-split.js`) added a second live
session beside the active one, but stops at two, gives the second pane
("Pane B") a deliberately reduced feature set, and has no reconnect: every
Codeman restart (every release deploy) leaves Pane B dead until the split is
closed and reopened.

The goal is a dashboard of agents: four, six or nine live Claude sessions on
one monitor, each readable and typeable, with its state visible at a glance.
The target picture is a 3x2 grid of tiles, each tile a full terminal with a
small header: status dot, session name, a `⋯` menu, maximize, `+` and `×` (as built:
no `+`, owner decision 9).

## Goal (v1)

- A **tile grid** of 1 to 9 live sessions in one Codeman window, laid out
  automatically by count, with draggable column and row dividers.
- Every tile is equal: same terminal class, same features, same header. One
  tile is **focused** and receives the keyboard.
- The rest of the app follows the focused tile: files panel, git status,
  respawn and Ralph panels, subagent windows, voice, image paste.
- Tiles survive a Codeman restart (reconnect) and a page reload (per-device
  persistence).
- The split pane stays as it is for now (decided). The grid is a separate
  mode that shares the same tile class with it; the two are never open at the
  same time (see "Coexistence with the split pane").

## Non-goals (v1)

- Phones and tablets. The grid is desktop-only, gated at 1180 px like the
  split (`SPLIT_PANE_MIN_WIDTH`) and the home rail (`HOME_SESSIONS_MIN_WIDTH`).
- More than 9 tiles.
- WebGL rendering inside tiles (see "Rendering" below).
- Full parity with the main terminal's touch and IME features: local-echo
  overlay, the CJK input textarea, the keyboard accessory bar, touch gestures,
  mouse-wheel forwarding to Claude's fullscreen renderer, the "Load full
  history" banner. These exist for touch devices or rare cases; a desktop
  keyboard user types straight into xterm, which is how Codeman behaved before
  those features existed.
- Server-side persistence of grids (named presets per owner).
- Pop-out windows (`/session/:id`, solo mode) showing a grid.

## Current architecture (why this is not a CSS change)

`terminal-ui.js` is built around ONE terminal: `this.terminal` (one xterm),
`this._ws` / `this._wsSessionId` (one WebSocket, rebound on every tab switch
via `_disconnectWs()` + `_connectWs(id)`), `this._xtermSnapshots` (scrollback
snapshots restored into that one terminal), and about 280 references to that
singleton across input handling, sizing, link providers, local echo, IME,
touch handling and the keyboard accessory bar.

The split pane works around it with a second, independent object,
`SplitTerminalPane`: its own xterm, its own fit addon, its own
`/ws/sessions/:id/terminal` socket. That class is the seed of this feature.
It already handles, and this design keeps:

- single-flight buffer loads (`_loadBuffer` / `_refreshBuffer` /
  `_endBufferLoad`), so two replays never interleave;
- the "disconnected" marker that must be the LAST thing on screen
  (`_markerOwed`, `_stampMarkerIfOwed`);
- the bounded scroll-to-top history pull for shell sessions (`_pullHistory`);
- its own key handler gating app chords (palette, Alt nav, Ctrl+Z, Shift/Ctrl+Enter
  via `send-key`, smart copy);
- divider drag with pointer capture, rAF-coalesced local fit, one PTY resize at
  pointer-up, and teardown when the split collapses mid-drag.

## Key decision: equal tiles, main terminal parked

Three ways to put N sessions on screen were evaluated:

| Approach | How | Verdict |
|---|---|---|
| A. Anchor plus light tiles | The main terminal stays as tile 1; other tiles are Pane-B style | Rejected. Tile 1 is privileged. The panels follow tile 1, not the tile you are typing in. Making another tile the "main" one costs two buffer reloads per click. |
| B. Equal tiles, main parked | Every tile is a `TerminalTile`. The main terminal is hidden and disconnected while the grid is open. `activeSessionId` always equals the focused tile's session. | **Chosen** |
| C. iframes of solo windows | Each tile is `/session/:id` in an iframe | Rejected. All frames share `codeman:clientId` (localStorage), and `SseStreamManager.addClient` evicts the previous stream with the same clientId, so frames knock each other's SSE offline about every 45 s (the staleness watchdog reconnects, evicting the next one). They also share `codeman:pendingInput`, load N full copies of the app, and play N notification sounds. |

Why B:

- **Focus changes are instant.** Moving focus is `xterm.focus()` plus an
  `activeSessionId` update. No fetch, no replay, no flicker.
- **Panels follow focus for free.** Everything keyed on `activeSessionId`
  (files panel, git status poll, respawn and Ralph panels, subagent window
  visibility, voice, image upload, kill/close, tab highlight) follows the
  focused tile once the tile branch of `selectSession` runs the same panel
  refresh as a normal switch.
- **Hiding the main terminal is already proven safe.** Web tabs set
  `display:none` on `.terminal-wrap` today (`.main.webview-active`). With the
  container hidden, FitAddon's `proposeDimensions()` reads `auto` widths and
  returns NaN, `clampTerminalDimensions` returns null, and no resize is sent.
- **The end state is clean.** Long term, the main terminal can itself become a
  1x1 grid of the same class, which deletes the singleton. B moves toward that;
  A entrenches it.

The cost of B is that tiles must reach desktop parity with the main terminal
on the features that matter at a desk: reliable input, reconnect, file-path
links, copy, image paste, voice. Those are listed under "Seams". Most of that
work also fixes gaps the split pane has today.

## User-facing behavior

### Entry points

- **Header Tiles button** (its own button, beside Split). As built (decision 8)
  a click opens the grid at once, the same as the toggle shortcut; right-click
  is the 2 / 4 / 6 count menu (decision 10; the session picker it replaced is
  gone). When the grid is open, a click closes it.
- **Ctrl/Cmd+click a tab**: add that session to the grid (opens the grid if
  closed).
- **Drag a tab** from the strip onto a tile to replace it, or onto an empty
  slot to add it.
- **"Open group as tiles"** in the tab-group menu (vertical rail, where group
  menus exist).
- **New sessions started from this browser tab's Run button** while the grid is
  open join the next free slot and take focus. Sessions created elsewhere
  (agents, other devices, cron) do not join.
- **Toggle shortcut** (registry action `toggleTileGrid`).

### Layout

Automatic by tile count, computed by a pure helper:

| Tiles | Layout |
|---|---|
| 1 | 1x1 |
| 2 | 2x1 |
| 3 | 3x1 if the grid area is at least ~1800 px wide, else 2x2 with one empty slot |
| 4 | 2x2 |
| 5-6 | 3x2 |
| 7-9 | 3x3 |

Hard cap 9. Capacity is also bounded by a minimum tile size (about 480x240 px,
roughly 60 columns at the default tile font), so the count menu greys out the
counts the window cannot fit.

Column and row dividers are draggable (generalizing the split divider): the
grid stores track fractions (`grid-template-columns: <a>fr <b>fr …`), each
drag clamps both neighbors to the minimum tile size, reflows locally per
animation frame, and sends one resize per affected tile at pointer-up.

### Tile header

`● name ……… ⋯ ⤢ + ×` (as built: `● [logo] name · model ……… ⋯ ⤢ ×`, owner decision 9 and
the harness/model request; see "As built")

- **●** status dot from the existing six-state classifier
  (`app._sidebarRichRow(id, session)`, built on `_mobileOverviewState`):
  `needs`, `error`, `waiting`, `working`, `idle`, `done`, styled with the
  existing unscoped `.home-sessions-dot--*` classes. A `needs` tile also gets a
  pulsing red border so a permission prompt is visible across the room. The
  label ("working 3m") shows on hover via `_mobileOverviewSince` /
  `_mobileOverviewStampText`.
- **name** via `textContent` with `data-i18n-skip` (a session literally named
  "Sessions" must not be translated). Double-click renames through
  `_queueInlineSessionName(id, name)`.
- **⋯** reuses `openTabRailActionMenu(event, id)` (tab-rail-resize.js): Session
  options, Open in a new window, Close session.
- **⤢** zooms the tile to fill the grid, like tmux zoom. The other tiles stay
  connected but hidden; hidden tiles measure NaN and send no resizes. Pressing
  it again (or the shortcut) restores the grid.
- **+** adds a session: a picker of open sessions not yet tiled, plus "New
  session in this case", which runs the normal quick-start for the tile's case
  and drops the result into the next slot. (Built, then removed by owner
  decision 9.)
- **×** removes the tile ONLY. The session keeps running. Killing stays behind
  `⋯ → Close session` and its existing confirm modal (`requestCloseSession`).

### Focus and keyboard

- The focused tile gets an accent border; its session is `activeSessionId`.
- Tabs of tiled sessions carry an `.in-tiles` marker; the focused one is
  `.active` as usual.
- Clicking a tile focuses it (a human selection, see "Focus and alert rules").
- New registry actions (all rebindable, all swallowed in every xterm key
  handler so the chord never reaches a PTY):
  - `toggleTileGrid` (proposed Ctrl+Shift+G)
  - `focusTileLeft/Right/Up/Down` (proposed Alt+Shift+Arrows)
  - `zoomTile` (proposed Alt+Shift+Enter)
  - `removeTile` (unbound by default)

  The defaults must be checked against xterm passthrough, Claude Code's own
  bindings and browser chords before they are fixed.
- While the grid is open, Ctrl+Tab and Alt+[ / Alt+] cycle through tiles.
- A USER-initiated selection of a session that is NOT tiled (clicking its tab,
  Alt+1-9 onto it, the command palette) leaves the grid and shows that session
  in the normal single view; the grid is remembered and one click on Tiles
  brings it back (decision 1). An app-driven selection (`auto: true`)
  never collapses the grid; see "Selections while the grid is open".
- Ctrl+L clears the focused tile; Ctrl+W is delete-word in the focused tile
  (it is not an app shortcut, decision 5); Ctrl +/-
  changes the tile font size; Ctrl+Shift+R restores the focused tile's size.

### Persistence

Decided: per device, restored on reload. Stored in localStorage key
`codeman:tile-grid`:

```json
{ "v": 1, "open": true, "ids": ["…", "…"], "focused": "…", "zoomed": null,
  "colFr": [1, 1, 1], "rowFr": [1, 1] }
```

Ids only, never content. A pure sanitizer drops unknown, deleted, detached and
duplicate ids on load. Never restored in a solo window.

The restore runs INSIDE `handleInit`, in place of its initial
`selectSession(restoreId, { auto: true })` (the non-`keepTerminal` branch), not
after it. Otherwise the page first selects the active session in the main
terminal, whose first non-shell select per page pulls an unbounded `?full=1`
capture, only to park that terminal a moment later. With a stored open grid,
the main terminal never loads on that page load. A later `handleInit` (SSE
reconnect after a server restart, the `keepTerminal` branch) reconciles ids
against the live list without rebuilding tiles that are still alive.

### Gating

- Setting `showTileGridButton`, per device (in `displayKeys`, stripped from the
  settings PUT, NOT in `SettingsUpdateSchema`), default OFF. Independent of
  `showSplitButton`, which is unchanged; a desk can show both buttons.
- Hidden below 1180 px by both a JS width check with a `matchMedia` listener and
  a CSS `@media (max-width: 1179px)` backstop, exactly like the split button.
  Narrowing the window while the grid is open returns to the single view and
  keeps the stored grid.
- Hidden in solo windows (`body.solo-mode`).
- `test/mobile-header-buttons-policy.test.ts` keeps it off phones.
- The toggle chord follows the setting (decision 6): with `showTileGridButton`
  off, `Ctrl+Shift+G` is inert and reaches the terminal like any unbound key; on,
  it toggles the grid. A grid opened another way keeps all its chords.

## Components

### 1. `TerminalTile` (`terminal-tile.js`, load order 7.4, PR 1)

The `SplitTerminalPane` class moves out of `terminal-split.js` into a new
`src/web/public/terminal-tile.js` and is renamed `TerminalTile`, keeping every
behavior listed under "Current architecture". The split orchestration stays in
`terminal-split.js` and constructs a `TerminalTile` for Pane B; the grid (PR 2)
constructs one per tile. New in the class:

**Reconnect.** The primary pane's backoff ladder (`CodemanWsReconnect`,
constants.js: 0, 250 ms, 500 ms, ... capped at 10 s) plus up to 250 ms of
jitter, the attempt count reset only by a successful open. A reconnect is also kicked when SSE `handleInit` reports the
server is back. After every reopen the tile runs a bounded refresh (the same
in-stream `\x1bc` clear plus replay as `_refreshBuffer`), because output
frames carry no sequence number and a gap cannot be replayed otherwise. That
refresh goes through the grid's load queue like every other load (see "Load
cost"): after a deploy restart all N tiles reopen within the same second, and
N unqueued refreshes are exactly the capture storm the queue exists to
prevent. Close codes that must NOT reconnect:

| Code | Meaning | Tile does | Owner decides (via `onExit`) |
|---|---|---|---|
| 4009 | Session exited | Stops reconnecting, reports the code | PR 1 split: an "exited" marker in Pane B (the split's existing delete path collapses it if the session is removed). PR 2 grid: the Attach overlay |
| 4003 / 4004 | Forbidden / session gone | Stops reconnecting, reports the code (4003 is stopped by the tile itself: `CodemanWsReconnect` classes it as transient) | PR 1 split: a marker saying why. PR 2 grid: removes the tile |
| 4010 | Superseded by a socket with the same cid | Stops, but only for the CURRENT socket (see below) | Same marker as 4003 |

The class never decides what happens to its container; it reports the close
code through the `onExit` callback and the owner (split or grid) acts.

**Replacing a socket is race-free.** A reconnect can be kicked (by
`handleInit`) while the old socket still looks open on the client: a half-open
connection whose `onclose` has not fired yet. The new socket carries the same
cid, so the server supersedes the old one with a 4010, and that late `onclose`
would run the "4010: stop" branch on a perfectly healthy tile. So before
opening a replacement the tile detaches the old socket's handlers (as
`destroy()` already does: null `onopen`/`onmessage`/`onclose`/`onerror`, then
`close()`), and every handler checks `event.target === this.ws` and ignores
events from any socket that is no longer current.

The marker text becomes `[disconnected, reconnecting…]` (a stop writes
`[disconnected: <why>]`, `TerminalTile.STOP_MARKERS`) and keeps its "last
thing on screen" rule. On reopen the closed state is cleared BEFORE the gap
refresh, or the refresh re-owes the marker and stamps it under a healthy
pane. `reconnectNow()` skips the backoff and never replaces an open socket.

**Client id on the upgrade URL.** `cid=${clientId}:${tabNonce}:tile`. The
connection registry supersedes by cid PER SESSION, so a distinct suffix means a
tile can never evict the main terminal's socket in a 4010 loop even if the same
session were ever on both. Input frames keep the BARE `clientId` (that is what
the server dedups on).

**Reliable input.** `terminal.onData` calls
`app._sendInputAsync(this.sessionId, data)`, which rides the tile's own socket
through the input-socket map (see "Seams"). This gives the tile the same
exactly-once delivery as the main terminal (per-session `seq`, ACKed, persisted
until ACK), and through `_ackDelivery` it clears the session's idle alert when
you type, which Pane B never did.

**Geometry** (rules from #464, see `docs/architecture-invariants.md`):

- One method, `syncGeometry()`, measures (`proposeDimensions()`), resizes the
  xterm and sends `{t:'z', c, r, v:'desktop'}` with THE SAME raw dimensions.
  The xterm and the PTY never disagree. There is deliberately NO 40x10 floor
  (unlike the main terminal's `clampTerminalDimensions`): commit `57406f6c`
  removed it from Pane B because the split's 20% divider clamp can leave Pane
  B at about 240 px, roughly 28 columns, and a floored xterm is wider than its
  container and clips columns. The server's own range (columns 1-500, rows
  1-200) is the only bound. Grid tiles never get that narrow anyway (the
  minimum tile size keeps them near 60 columns).
- Unchanged dimensions are not resent (Pane B had no such dedupe and fanned out
  a `tmux resize-window` per animation frame during drags before the rAF fix).
- The `{t:'zc'}` reply is handled: adopt the PTY's COLUMNS only, keep local
  rows, via the pure `reconcilePtyGeometry` (constants.js). Pane B ignores
  `zc` today.
- A hidden tile (zoomed out, web tab active) measures NaN and does nothing; it
  syncs when shown again.
- Detached sessions are never tiled, so the split's `detachedSessions` yield in
  `_sendResize` becomes a removal (see "Edge cases").

**Rendering.** DOM renderer, no WebGL addon, as Pane B does today. Chrome
allows roughly 16 live WebGL contexts per page and the main terminal keeps
one. Measure nine busy tiles on the DOM renderer before considering WebGL
(follow-up).

**Scrollback.** Tiles use their own cap, `TILE_SCROLLBACK` (proposed 10,000
lines), not `DEFAULT_SCROLLBACK` (50,000). Nine DOM-rendered xterms at 50k
lines each is a real memory cost, and a tile's initial load is already bounded
to a 1 MiB window, so a larger buffer only fills with live output over time.
The shell history pull's "pane full" check reads `term.options.scrollback`, so
it adapts to the lower cap unchanged.

**Key handler.** Pane B's `attachCustomKeyEventHandler` stays in
`TerminalTile` (every tile IS a `TerminalTile`, so no separate factory is
needed), plus:

- Ctrl+V routes into the image-paste trap with this tile's terminal and session;
- the new tile chords are swallowed (return false) so they never reach the PTY.

**Links and copy.** The tile registers the file-path link provider and uses the
shared copy helper (see "Seams"), so clicking a path printed in a tile opens the
file preview for THAT session.

**Disposal.** `destroy()` closes the socket (handlers nulled first, as today),
unregisters from the input-socket map, removes listeners and disposes the
xterm. Nothing may outlive a removed tile (24-hour sessions rule).

### 2. `TileGrid` controller and layout helper

- `computeTileLayout({ count, width, height })` and
  `tileGridCapacity({ width, height })` (against the minimum tile size,
  `TILE_MIN_W` x `TILE_MIN_H`): pure, in `constants.js`, exported on
  `window.CodemanTileGrid` beside the existing helper namespaces.
  `sanitizeTileGridState(raw, liveSessions, detachedIds)`: pure, same place.
- The controller (in a new `src/web/public/tile-grid.js`, load order 7.6, as
  `CodemanApp.prototype` methods like the split code) owns: the ordered tile list, `focusedId`,
  `zoomedId`, track fractions, the `<section class="tile-grid">` element, one
  `ResizeObserver` on that section (the main terminal's observer watches a
  hidden node and stops firing), the divider drags and the load queue.
- DOM: the grid is a NEW sibling of `.terminal-wrap` inside `.main`, toggled by
  `.main.tiles-active`. Unlike the split there is no reparenting of
  `.terminal-wrap`. CSS adds `.main.webview-active .tile-grid { display: none }`
  beside the existing `.terminal-split-container` rule.

### 3. Parking the main terminal

**Enter:**

1. `_cleanupPreviousSession()` once. Its snapshot of the current session is
   correct at that moment, and it disconnects the main socket and flushes local
   echo.
2. Add `.main.tiles-active`: `.terminal-wrap` hidden, `.tile-grid` shown.
3. `hideWelcome()`.

**Guards.** With the main socket closed, `_wsReady` is false and the SSE
terminal fallback would start writing the focused session's output into the
hidden xterm (every handler keys on `activeSessionId`). One predicate,
`_tilesOwnTerminal()`, turns these into no-ops while the grid is open:

- `_onSessionTerminal`, `_onSessionClearTerminal`, `_onSessionNeedsRefresh`
  (it would fetch `?full=1` for nothing), `_scheduleDroppedOutputRecovery`;
- the `terminal.writeln` calls in `_onSessionCompletion` and `_onSessionError`;
- `retryConnection` and the `keepTerminal` branch of `handleInit`, which would
  reconnect the main socket;
- as a backstop, beside the existing `detachedSessions` checks in
  `sendResize`, `throttledResize`, `_maybeRefetchFullHistory` and
  `restoreTerminalSize`;
- the WebGL long-task guard (`_installWebGLLongTaskGuard`). Its
  `PerformanceObserver` watches the WHOLE page and counts every long task while
  the main terminal's WebGL addon exists, so long tasks caused by tile rendering
  or tile replays would trip it and write the sticky `codeman-webgl-disabled`
  marker (7 days), silently moving the main terminal to the DOM renderer for
  reasons that have nothing to do with WebGL. While tiles own the terminal the
  observer callback must not count entries.

A missed guard is mostly harmless (exit replays from scratch) but costs fetches
and CPU, so the guard test enumerates them.

`_computeConnectionDescriptor` must derive the header connection state from the
tile sockets while the grid is open (all open: connected; any reconnecting:
degraded), or the header shows "Connecting" forever.

The SSE subscription stays `[activeSessionId]` as in single view. Those frames
are dropped by the guards. (An empty list means "all sessions", so there is no
"none" to subscribe to; this matches today's single-view duplication anyway.)

**Exit:**

1. Destroy every tile, remove `.main.tiles-active`.
2. `this._lastResizeDims = null` (as `_redock` does).
3. Invalidate the main terminal's cached content for EVERY tiled id, not just
   the focused one: the `_xtermSnapshots` entry, the `codeman-xs-<id>`
   localStorage key and the buffer-cache entry. Those were written before the
   grid opened, possibly hours earlier, and `selectSession` paints a snapshot as
   a first frame before its fetch replaces it, so the next switch to a formerly
   tiled session would flash content from before the grid.
4. `selectSession(focusedId, { forceReload: true, auto: true })`. For the
   already-active id that path drops the stale snapshot and nulls
   `activeSessionId` BEFORE `_cleanupPreviousSession`, so nothing wrong is
   saved, then reconnects and replays normally.

### 4. The tile branch of `selectSession`

Placed in `app.js` directly after the "already active" early return (~7876),
so tapping the focused tab still acknowledges its alert and the detached-window
check (~7855) still runs first:

```js
if (this._tileGrid?.open) {
  if (this._tileGrid.has(sessionId)) return this._selectTiledSession(sessionId, options);
  // Decision 1: only a USER-initiated pick (or an explicit leaveTiles) of a
  // non-tiled session leaves the grid. An app-driven one never collapses it.
  if (options.auto === true && !options.leaveTiles) return;
  this.closeTileGrid({ keepStored: true });
}
```

`_selectTiledSession` keeps:

- `++this._selectGeneration` (aborts any in-flight normal select at its next
  `_isStaleSelect` check);
- `_hideWebviewLayer()`; `activeSessionId = id`; `_activateFileBrowserSession`;
  the `codeman-active-session` key; `hideWelcome()`;
- `markIdleAlertSeen(id)` only when user-initiated (`options.auto !== true`);
- `_updateActiveTabImmediate`, tab glow, `renderSessionTabs`,
  `closeSessionSidebarOnHandheld`;
- `updateAttachmentHistoryBadge`, `KeyboardAccessoryBar.refreshForActiveSession`,
  `refreshHostWakeBanner`, `currentSessionWorkingDir`;
- the deferred panel block (respawn banner and countdown, action log, task
  panel, Ralph state, CLI info, project insights, subagent window visibility,
  file browser). That block (~8452-8523) is first extracted into
  `_refreshSessionPanels(id, generation)` so both paths share one copy;
- focusing the tile's xterm.

It skips everything bound to the main terminal: `terminal.focus()`,
`_cleanupPreviousSession`, the truncation banner, `playTerminalEntrance`,
local-echo state, `_beginBufferLoad`, `syncTerminalGeometry`, both
`sendResize` calls, snapshot/cache/fetch replay, `_fullHistoryLoaded`,
`_markTerminalBufferReconciled`, `_connectWs`, scroll-to-bottom, the resize
retry, and the `pid === null` attach POST (the tile's Attach overlay owns it).

The split's own `selectSession` and `_onSessionDeleted` wrappers stay. They
act only while `this._splitPane` is set, and the grid never opens alongside a
split (see "Coexistence with the split pane"), so the two never compete.

#### Selections while the grid is open

Several app-driven paths call `selectSession` on their own, and without the
`auto` rule above each of them would land on a non-tiled session and collapse
the grid. Each one gets an explicit grid-aware behavior:

| Path | Today | With the grid open |
|---|---|---|
| Close session on the focused tile (`closeSession`, from its menu or a user-bound key) | Reads `wasActive` before its `await`, adds the id to `_closingSessions`, then selects the first remaining `sessionOrder` entry with `auto: true`, which is often NOT tiled | A grid-aware fallback picker: remove the tile, then focus the neighboring tile (next in grid order, else previous). Only with no tiles left does it fall back to the `sessionOrder` pick, which closes the grid. Note the split's `_onSessionDeleted` wrapper deliberately skips selection for ids in `_closingSessions`, so the fallback MUST live in `closeSession` itself, not in the delete wrapper. |
| Session deleted elsewhere (`_onSessionDeleted`) | The handoff selects the first remaining `sessionOrder` entry | If it was tiled: remove the tile and focus a neighbor with `auto: true`. If it was not tiled it was not active, so there is no handoff. |
| Boot restore (`handleInit`) | `selectSession(restoreId, { auto: true })` | Replaced by the grid restore when a stored grid is open (see "Persistence") |
| URL `#session=<id>` link | `selectSession(id, { auto: true })` | Following a link is navigation, so this path passes `leaveTiles: true`: a tiled id focuses its tile, a non-tiled id opens the single view (grid kept in storage) |
| Pane promotion after a delete (split) | `selectSession(promoted, { auto: true })` | Unchanged for the split; unreachable while the grid is open, since no split can be open then |
| Auto-join of a session created by this tab's Run | Run selects the new session | The session joins the grid first, then is selected through the tile branch |

### 5. Focus and alert rules

These follow the Approvals Inbox acknowledgement rule
(`docs/architecture-invariants.md#approvals-inbox`):

| Event | Acknowledges the idle alert? |
|---|---|
| Pointerdown on a tile, a tile-nav chord, a click on its tab | Yes (human selection) |
| Typing into a tile | Yes, via `_ackDelivery` on the input ACK |
| Opening the grid, restoring it, promoting a neighbor after a delete, auto-join of a new session | No (`auto: true`) |
| A tile merely being visible | No |
| Anything | Never clears permission/question (action) alerts; those clear only on resolution |

Notifications are unchanged: a visible but unfocused tile still raises its
sound/title/desktop notification, so nothing is silently swallowed.

### 6. Seams (small refactors, no behavior change on their own)

| Feature | Today | Change |
|---|---|---|
| Input socket | `_drainSession`, `_sendInputEphemeral`, `_redeliverSweep` and `_onWsInputAck` assume the single `_ws` / `_wsSessionId` / `_wsLastRecvAt` | An `_inputSocketFor(sessionId)` map that the main terminal and each tile register into (`{ ws, ready(), lastRecvAt }`). `{t:'ia'}` acks carry no session id, so each socket's `onmessage` passes its own: `_onWsInputAck(seq, msg, sessionId)`. Without the map, tile input still works through the HTTP POST fallback (durable, but one awaited POST per record). |
| File-path links | `registerFilePathLinkProvider()` reads `self.terminal` and opens with `self.activeSessionId` | `registerFilePathLinkProvider(terminal = this.terminal, getSessionId = () => this.activeSessionId)` returning the provider; about five references change |
| Copy | `copyTerminalSelection` / `cleanedTerminalSelection` read `this.terminal`; Pane B re-implements them | Both take `(terminal, sessionId)`; Pane B's copy is deleted |
| Image paste | `_handleImagePaste()` uses the main terminal; `_uploadAndInsertImages` inserts with `sendInput()`, which re-reads `activeSessionId` AFTER the upload (an existing bug: switch tabs mid-upload and the paths land in the wrong session) | `_handleImagePaste({ terminal, sessionId })`; insert with `_sendInputAsync(sessionId, paths, { useMux: true })` |
| Voice | `_insertText` re-reads `app.activeSessionId` at insert time and appends to the main local-echo overlay | Capture the target in `start()`; send with `_sendInputAsync(target, …)`; skip the overlay when the target is not the main terminal |
| Shortcuts | Ctrl+L (`clearTerminal`) and Ctrl+Shift+R (`restoreTerminalSize`) act on `this.terminal` | Resolve through `_focusedPane()` returning `{ terminal, sessionId, isPrimary }`; Close Session (no default key) already takes an id |
| Font, family, weight, skin | `setFontSize` / `setFontFamily` / `setFontWeight` / `applyTerminalSkin` special-case `this._splitPane` | Loop over all tiles |

### 7. Fonts

Tiles get their own per-device font size, `codeman-tile-font-size` (default
13), because a tile is a fraction of the screen. While the grid is open,
Ctrl +/- changes the tile font for all tiles. A font change is a geometry
change (#464): every tile re-runs `syncGeometry()` afterwards.

### 8. Load cost

`GET /api/sessions/:id/terminal` runs three SYNCHRONOUS tmux calls
(`list-panes`, `capture-pane`, `display-message` via `execSync`, each with a
5 s timeout). Nine `full=1` loads at once would not run in parallel; they would
run back to back on the event loop and stall every WS and SSE stream on the
server for seconds.

So EVERY tile load goes through ONE grid-level client queue (PR 2, plugged in
through a `scheduleLoad` option PR 2 adds to `TerminalTile`): the initial load,
the refresh after a reconnect, a server `{t:'r'}` refresh, and the shell
history pull. No tile calls `fetch('/terminal…')` on its own. The tile's
single-flight flag stays (it is what keeps one tile's replays from
interleaving); the queue sits in front of it and bounds the whole grid.

- concurrency 1, focused tile first, then reading order (a user-triggered
  history pull jumps ahead of background refreshes);
- after a deploy restart, the N reconnect refreshes drain one at a time
  instead of hitting the server together;
- each load uses the BOUNDED window `?full=1&tail=TERMINAL_TAIL_SIZE` (1 MiB)
  for TUI sessions and `?tail=…` for shells, never an unbounded `full=1`;
- a tile shows a quiet "loading" state until its turn;
- full history is one action away: zoom then exit tiles, or exit tiles.

### 9. Coexistence with the split pane

Decided: the split pane stays for now. The two modes are mutually exclusive
and share one tile class:

- Opening the grid while a split is open closes the split first and seeds the
  grid with both of its sessions (Pane A's focused, Pane B's beside it), so
  "split, then want more" is one click.
- While the grid is open, `openSplitPicker` and `openSplitPane` refuse and the
  Split button shows as disabled (`aria-disabled`), the same refusal pattern
  `openSplitPane` already uses for web tabs and the welcome screen.
- Closing the grid never reopens a split.
- The split's wrappers (`selectSession`, `_onSessionDeleted`) key on
  `this._splitPane`, which is null whenever the grid is open, so they stay
  inert there without changes.
- Shared code lives in `TerminalTile` and the seams from PR 1, so a fix to tile
  behavior reaches both modes. Whether to retire the split later (a 2-tile grid
  covers it) is left for after the grid has been used for a while.

## Edge cases

| Situation | Behavior |
|---|---|
| A tiled session is deleted (here or elsewhere) | Tile removed; a neighbor gets focus with `auto: true`; the last tile gone falls through to the normal handoff |
| Closing the focused tile's session | The grid stays open and the neighboring tile takes focus (grid-aware fallback in `closeSession`, see "Selections while the grid is open") |
| A tiled session is popped out to its own window | Tile removed: that window now owns the PTY size |
| Session exited or not attached (`pid === null`, `paneExit`) | The tile body shows "Not attached" with an Attach button: `POST /interactive` (or `/shell` for shell mode) with NO body, at most one in flight per session (the route has no in-flight guard of its own). A tripped PTY-exit breaker goes through the existing confirm before `clearBreaker: true`; no automatic path ever sends it |
| A web tab is opened | Grid hidden by CSS; sockets stay up; hidden tiles send no resizes. Selecting a tiled session's tab brings the grid back |
| Window narrower than 1180 px | Back to single view of the focused session; stored grid kept |
| Window shrinks below the tiles' minimum size | The focused tile zooms with a short hint; widening restores the grid |
| Codeman restarts (deploy) | Tiles reconnect; their refreshes drain through the load queue one at a time; `handleInit` reconciles ids without rebuilding live tiles |
| A half-open tile socket when a reconnect is kicked | The old socket's handlers are detached before the replacement opens, so its late 4010 close is ignored |
| A phone opens a tiled session | Its resize is declined while the desktop holds a sizing claim and was active in the last 90 s (existing `Session.resize` arbitration) |
| A second desktop browser shows a tiled session full-size | Last resize wins and only the resizing socket hears `zc` (existing behavior, see follow-up 2) |
| Split collapses or a tile is removed mid-divider-drag | Drag teardown first (carried over from the split's mid-drag fix) |
| Remote (SSH) and Docker sessions | Work unchanged: their pane is a local tmux pane like any other |
| Multi-user mode | The grid only ever opens visible sessions (the client map is already scoped); the socket upgrade checks ownership server-side |
| Solo window | Tiles unavailable |

## Server

**No server change is required.**

- N sockets to N different sessions each use one slot of that session's
  `MAX_WS_PER_SESSION = 5` (`ws-routes.ts`). There is no per-client or global WS
  cap.
- One `/api/events` SSE stream already carries every session's lifecycle and
  hook events, so tiles need no extra stream for their status dots.
- `v:'desktop'` resizes already register a sizing claim, so a phone cannot
  shrink a tiled session while the desktop is active.
- The WS sends nothing on connect, which is why each tile loads its buffer
  first (already true for Pane B).

Separate follow-up PRs worth doing (see "Follow-ups").

## Invariants this feature must keep

- **#464 geometry**: a tile's xterm and its PTY never disagree; one function
  sizes both; `zc` adoption is columns only; withhold the fit wherever the
  resize is withheld.
- **Grid and split are never open together**: opening the grid closes a split;
  the split refuses to open while the grid is open.
- **One place per session in this browser tab**: the main terminal is parked
  while the grid is open, a session is in at most one tile, detached sessions
  are never tiled.
- **App-driven selections never collapse the grid**: only a user-initiated pick
  (or an explicit `leaveTiles`) of a non-tiled session leaves it; every
  app-driven fallback (close, delete, restore) picks a tile.
- **One load queue**: no tile fetches `/terminal` outside the grid's queue
  (initial, reconnect, `{t:'r'}`, history pull), because each capture blocks
  the server's event loop.
- **Only the current socket counts**: a tile ignores events from any socket
  that is no longer `this.ws`, and detaches handlers before replacing one.
- **Tiles never touch main-terminal state**: no long tasks counted against the
  main terminal's WebGL, and its snapshots for tiled ids are invalidated on
  exit.
- **Alerts**: visible is not acknowledged; only a human selection or delivered
  input acknowledges idle; action alerts are never cleared by view or input;
  app-driven selections pass `auto: true`.
- **PTY-exit breaker**: never `clearBreaker` from an automatic path.
- **Replay clears are in-stream** (`\x1bc` queued in the write stream), never
  `reset()`.
- **Capture fetches carry deadlines that cover the body** (reuse
  `CodemanFetchDeadline`, as `_pullHistory` does).
- **Per-device setting**: in `displayKeys`, stripped from the PUT, not in the
  `.strict()` schema; the `--hidden` marker class has a `display: none` rule.
- **Palette chords** are swallowed in every xterm key handler.
- **Escape**: the count menu's close method returns early when the menu is not
  open, and an open menu owns the Escape (it closes alone and the keyboard goes
  back to the Tiles button, like the tab-group menu).
- **User text** (names) via `textContent` / attributes, never `innerHTML`.
- **No secrets in localStorage**: the stored grid holds ids only.
- **Memory**: everything a tile creates is released in `destroy()`.

## Delivery: two PRs

Decided: the work ships as two PRs. PR 1 stands on its own: it builds the tile
class and the seams, and the existing split pane runs on them, so users get a
better split before the grid exists. PR 2 adds the grid on top.

### PR 1: tile foundation (the split pane gets better)

Commits:

1. **Seams.** The input-socket map; the parameterized link provider, copy,
   image paste and voice target; `_focusedPane()`; a `_forEachTile()` helper
   that replaces the `this._splitPane` special cases in the font, family,
   weight and skin setters. No behavior change on its own. Unit tests for each.
2. **`TerminalTile`.** The class moves out of `terminal-split.js` into a new
   `src/web/public/terminal-tile.js` (load order 7.4, before
   `terminal-split.js` at 7.5) and is renamed from `SplitTerminalPane`. The
   split's orchestration (`openSplitPane`, `closeSplitPane`, the picker, the
   divider drag, the wrappers) stays in `terminal-split.js` and constructs a
   `TerminalTile` for Pane B. New in the class: reconnect with race-free socket
   replacement and the close-code table, the `:tile` cid suffix, reliable input
   through the socket map, `zc` handling with one geometry method, the
   file-path link provider and image paste, and an `onExit` callback. The
   `scrollback` and `scheduleLoad` options were deferred to PR 2, which
   introduces them together with the grid's load queue, their first user.
3. **Split pane follows focus.** `_focusedPane()` returns Pane B while its
   xterm has focus, so Ctrl+L, Ctrl+Shift+R, voice and image paste act on the
   pane you are typing in. This removes most of the asymmetry the split-pane
   spec documented and accepted for its v1 ("Ctrl+L or Ctrl+W typed while Pane
   B has focus clears or closes Pane A"). Typing into Pane B now clears its
   idle alert through `_ackDelivery`, which it never did.
   **Ctrl+W no longer closes anything** (decision 5): Close Session has no
   default key, so Ctrl+W reaches the focused pane as delete-word.
4. **Docs.** Update the split-pane paragraph in CLAUDE.md and
   `docs/architecture-invariants.md#split-pane-sessions` (Pane B now
   reconnects, delivers input exactly once, has links and image paste, and
   follows focus; the "deliberately plainer" list shrinks accordingly), add
   `terminal-tile.js`(7.4) to the frontend load order, add a note at the top of
   `docs/split-pane-sessions-plan.md` pointing here.

What users get from PR 1 alone: a split pane that survives deploys, never
loses or doubles a keystroke across a reconnect, has clickable file paths and
image paste, and whose shortcuts act on the pane that has focus.

PR 1 tests (gate):

- `test/terminal-tile-unit.test.ts`, moved from
  `split-pane-terminal-unit.test.ts` with every existing case kept
  (single-flight, marker-last including the async-parse fake, history pull),
  plus: reconnect backoff and each close code, a late `onclose` (4010) from a
  replaced socket is ignored and the tile keeps running, `zc` columns-only
  adoption, the cid suffix, input routed through `_sendInputAsync` (as built:
  `test/terminal-tile-input.test.ts`, which runs `connect()` for real).
- `test/input-socket-map.test.ts`: acks routed to the right session's queue,
  redelivery per socket, POST fallback when no socket is registered.
- `test/focused-pane-shortcuts.test.ts`: with Pane B focused, Ctrl+L clears
  Pane B, Ctrl+Shift+R restores Pane B's size, voice and image paste target
  Pane B's session, and a user-bound Close Session still targets the active
  session; `test/ctrl-w-never-closes.test.ts` pins that no default shortcut
  answers Ctrl+W;
  with Pane A focused nothing changes.
- Geometry: with the split divider at its 20% clamp, Pane B's xterm and the
  size it sends are both under 40 columns and equal (no floor regression).
- `onExit`: each close code is reported once to the owner and stops
  reconnecting; the split shows the matching marker.
- The image-paste wrong-session fix: an upload that finishes after a tab switch
  still inserts into the session it started in.
- Every existing `split-pane-*` test keeps passing (class name updated where it
  is referenced).

PR 1 browser tests: the existing `split-pane-*.browser.test.ts` files (they
match master, one pre-existing environmental failure in both). Pane B
reconnecting after a server restart and a click on a printed path opening
Pane B's file preview are covered by unit tests and checked live on the beta
instance rather than as browser tests (the harness cannot restart its own
server).

PR 1 verification: a split with two real Claude sessions on the beta instance;
restart the server mid-typing in Pane B (reconnect, refresh, no lost or doubled
input); type into Pane B while it has an idle alert (the alert clears); Ctrl+L
in Pane B; image paste into Pane B.

### PR 2: tile grid

Commits:

1. **Grid core.** `_refreshSessionPanels()` extraction from `selectSession`
   (no behavior change, its own commit first), layout helpers, the grid section
   and CSS, parking with guards (SSE handlers, reconnect paths, WebGL long-task
   observer), the `selectSession` tile branch with the `auto` rule, the
   grid-aware `closeSession` fallback, focus rules, tile chords in the shortcut
   registry, the single grid-level load queue that every tile load goes
   through (a new `scheduleLoad` option on `TerminalTile`, plus a `scrollback`
   option for `TILE_SCROLLBACK`), coexistence with the split.
2. **Tile chrome and entry points.** Header (dot, name, menu, zoom, add,
   remove), the Attach overlay, picker, dividers, drag-a-tab, Ctrl/Cmd+click,
   "Open group as tiles".
3. **Persistence.** `codeman:tile-grid` restore inside `handleInit` (in place
   of the initial select), snapshot invalidation on exit, auto-join of new
   sessions from this tab, the `showTileGridButton` setting.
4. **Docs.** A tile-grid paragraph in CLAUDE.md beside the split-pane one,
   `tile-grid.js`(7.6) in the load order, header-button and z-index notes,
   `docs/architecture-invariants.md#tile-grid`, a wiki page under
   `docs/wiki/`.

## Testing (PR 2)

**Gate (`npm test`):**

- `test/tile-grid-layout.test.ts`: `computeTileLayout`, `tileGridCapacity`,
  `sanitizeTileGridState` (unknown, deleted, detached, duplicate ids).
- `test/tile-grid-select-branch.test.ts` and an extension of
  `test/session-select-ack-gate.test.ts`: the branch never calls `_connectWs` or
  `_cleanupPreviousSession`; acknowledgement only when user-initiated; an
  `auto: true` selection of a non-tiled session leaves the grid open; a
  user-initiated one closes it; `leaveTiles: true` closes it.
- `test/tile-grid-close-fallback.test.ts`: closing (`closeSession`) the
  focused tile keeps the grid open and focuses the neighboring tile, even when
  the first `sessionOrder` entry is not tiled; closing the last tile falls back
  to the normal pick.
- `test/tile-grid-park-guards.test.ts`: every guarded SSE handler is a no-op
  while tiles own the terminal, and the WebGL long-task observer counts nothing
  while tiles own the terminal.
- `test/tile-grid-load-queue.test.ts`: N tiles reconnecting together produce at
  most one in-flight `/terminal` fetch at a time; `{t:'r'}` and history pulls go
  through the same queue; a destroyed tile's queued load is dropped.
- `test/tile-grid-restore.test.ts`: with a stored open grid, `handleInit`
  restores the grid and never calls the main terminal's buffer load; on exit,
  snapshot and cache entries for every tiled id are invalidated.
- `test/tile-grid-split-coexistence.test.ts`: opening the grid closes an open
  split and seeds the grid with both of its sessions; the split cannot open
  while the grid is open; the split's wrappers do nothing while the grid is
  open.
- `test/tile-grid-per-device-setting.test.ts` and a hidden-button CSS case, in
  the shape of the split-pane ones: `showTileGridButton` is in `displayKeys`,
  stripped from the PUT, not in the schema, and `.btn-tile-grid--hidden` has a
  `display: none` rule.
- Shortcut tests: the new chords are swallowed in the main and tile key
  handlers; `mobile-header-buttons-policy` keeps the button off phones.

**Browser (`npm run test:browser -- <file>`, NOT in the gate):**

- Open 4 tiles; all render live output independently.
- Click-to-focus routes keystrokes to the right PTY (assert with
  `tmux capture-pane`, never on HTTP 200).
- Ctrl+L clears only the focused tile; Shift+Enter inserts a newline in a tile.
- Zoom and unzoom refit; a divider drag sends exactly one resize per affected
  tile at pointer-up.
- Deleting a tiled session removes its tile and moves focus.
- Reload restores the grid; a server restart reconnects every tile.
- Narrowing below 1180 px returns to the single view.

Reminder: `npm test -- <browser file>` matches nothing, runs zero tests and
exits green. Use the browser runner for those files and read the file count.

## Verification before merging PR 2

- Build in the worktree and run an isolated beta instance (its own
  `CODEMAN_INSTANCE`, so its own data dir and tmux socket), reached through
  `tailscale serve` on a never-used port.
- Six throwaway Claude sessions, as in the target picture; Playwright captures
  at `deviceScaleFactor: 1`, unique filenames.
- A Chrome performance trace with all six tiles working at once for 60 s,
  recorded in the PR, with pass/fail bars:
  - p95 frame time at or below 25 ms (40 fps or better);
  - no long task of 200 ms or more after the initial load settles (three of
    those in 30 s is what trips the WebGL fallback, so the bar matches the
    codebase's own threshold);
  - JS heap within ±10% between minute 1 and minute 10 of a ten-minute run
    (no growth from tile churn: add and remove tiles and zoom a few times in
    between);
  - the initial load of six tiles completes with the server's event loop never
    blocked for more than one capture at a time (check `Server-Timing` on each
    `/terminal` response).

  Missing a bar blocks the merge or lowers the tile cap, not the bar.
- A server restart while typing into a tile: reconnect, refresh, no lost or
  doubled input.
- A phone opened on one tiled session: the desktop tile keeps its size while
  active.

## Follow-ups (not in these PRs)

1. Make `captureActivePaneBuffer` async (`execFile`) and add a server-side limit
   on concurrent captures, so no client can stall the event loop with captures.
2. When a session's PTY size changes, send `zc` to EVERY socket on that
   session. Today only the resizing socket hears back, so a second desktop
   viewer keeps a stale width and renders garbled output (#464).
3. WebSocket backpressure (`bufferedAmount` threshold, drop and send `{t:'r'}`
   on drain) for grids over slow links.
4. Tile parity extras: mouse-wheel forwarding for Claude's fullscreen renderer,
   a "Load full history" action inside a tile.
5. WebGL in tiles, after measuring the DOM renderer with nine busy tiles.
6. Named grid presets, possibly per owner on the server.
7. The end state: the main terminal becomes a 1x1 grid of `TerminalTile`,
   which removes the singleton from `terminal-ui.js`.

## Decisions

1. **Clicking a tab that is not tiled.** Decided: a user-initiated pick
   leaves the grid and shows that session in the single
   view; the grid is kept for one-click return. App-driven selections never
   leave it either way. Alternative: swap that session into the focused tile.
2. **The split pane.** Decided: keep it alongside the grid for now; the two
   share `TerminalTile` and never open together.
3. **Persistence.** Decided: per device, restored on reload.
4. **PR shape.** Decided: two PRs. PR 1 is the tile foundation (the split
   improves on its own), PR 2 is the grid.
5. **Ctrl+W.** Decided: it never closes a session. Close Session has no
   default key (Ctrl+W is delete-word in every shell and agent CLI, and it
   killed sessions with no confirm); it stays bindable in App Settings →
   Shortcuts.
6. **`Ctrl+Shift+G` with the Tiles setting off.** Decided by the owner: the
   chord is inert while `showTileGridButton` is off (it passes through like any
   unbound key) and toggles the grid while it is on, so one setting governs both
   the button and the chord.
7. **The tile cap.** Decided by the owner: at most 6 tiles for now. Six was
   tested and is smooth on the owner's desktop; nine missed the headless frame
   bar (p95 33 ms at 6 and 9 tiles under load, 16.8 ms at 4) and is untested on
   real hardware. The cap is one constant (`TILE_GRID_MAX`), the layout table
   keeps 7 to 9 working but unreachable, and the user-facing texts say "at most
   6 tiles" when the cap, not the window, is what limits the grid.
8. **The Tiles button opens the grid directly.** Decided by the owner ("when I
   hit the tiles button, open the tiles already!"): a click opens the grid with
   no picker in the way, choosing the grid this tab last had, else an open
   split's two sessions, else the open sessions in tab order up to the cap with
   the active one focused; `Ctrl+Shift+G` runs the same function. The picker
   is on right-click of the button (its title says so, as do the wiki and the
   Help modal). Superseded in part by decision 10: right-click is now the count
   menu, and a remembered grid is filled to the count instead of opening
   exactly as stored.
9. **No + in the tile header.** Decided by the owner ("remove the + button from
   these views"): the header is `● name ……… ⋯ ⤢ ×`. The + menu and its "New
   session in this case" went with it. Tiles are added from the Tiles button
   and its right-click count menu, Ctrl/Cmd+click on a tab, a dragged tab,
   "Open group as tiles" and Run joining the open grid.
10. **Right-click Tiles is a 2 / 4 / 6 count menu.** Decided by the owner
   ("give me then the option to choose only HOW many tiles, 2,4,6 default is 6
   so the menu is easier"; asked where it lives: "Click opens 6"): a click
   still opens the grid at once, with the remembered count (default 6); the
   right-click menu offers 2, 4 and 6, remembered per device; the session
   picker is gone, and decision 8's "picker on right-click" is superseded. The
   owner's answers on the details: the count wins over a remembered grid's
   size (its tiles first, in their cells, holes filled first, then tab order);
   Ctrl/Cmd+click with the grid closed opens the count in total, that session
   focused; shrinking keeps the focused tile; only the toggle animates the
   close; a remembered count larger than the window stays checked but greyed
   and a click opens what fits; the close keeps its dimmed still until the
   single view has painted (at most 700 ms); paced connect is in.

## Code anchors

Line numbers are approximate (as of 1.35.0) and drift; the names are stable.

| Area | Where |
|---|---|
| Split pane class and orchestration | `src/web/public/terminal-split.js` (`SplitTerminalPane`, `openSplitPane`, `closeSplitPane`, `_installSplitDividerDrag`, the `selectSession` and `_onSessionDeleted` wrappers) |
| Split helpers | `src/web/public/constants.js` ~1592-1634 (`SPLIT_PANE_MIN_WIDTH`, `clampDividerPercent`, `buildSplitPickerSessions`), exported as `window.CodemanSplitPane` |
| `selectSession` | `src/web/public/app.js` ~7844-8644; early return ~7868-7876; deferred panels ~8452-8523 |
| `_cleanupPreviousSession` | `app.js` ~7377 |
| Reliable input | `app.js` ~3558-3920 (`_sendInputAsync`, `_reliableSend`, `_nextSeq`, `_drainSession`, `_ackDelivery`, `_onWsInputAck`, `_redeliverSweep`); main socket URL ~3341 |
| SSE terminal fallback | `app.js` `_onSessionTerminal` ~2192, `_onSessionNeedsRefresh` ~2916, `_onSessionClearTerminal` ~3020 |
| Geometry | `terminal-ui.js` `syncTerminalGeometry` ~5894, `sendResize` ~5981, `_onPtyGeometryReport` ~6072, `throttledResize` ~1292-1429; `constants.js` `reconcilePtyGeometry` ~1850 |
| Link provider | `terminal-ui.js` `registerFilePathLinkProvider` ~1831 |
| Main key handler | `terminal-ui.js` ~552-718 |
| Shortcut registry | `app.js` `DEFAULT_SHORTCUTS` ~406-557, `SHORTCUT_ACTIONS` ~1248, capture handler ~1263-1363 |
| Status classifier | `app.js` `_sidebarRichRow` ~5058; `mobile-overview.js` `_mobileOverviewState` ~130; dot CSS `.home-sessions-dot--*` in styles.css |
| Session action menu | `tab-rail-resize.js` `openTabRailActionMenu` ~318 |
| Tab drag | `app.js` `setupTabDragHandlers` ~7137 |
| Tab-group menu | `app.js` `openTabGroupMenu` ~6737 |
| Image paste | `image-input.js` `_handleImagePaste` ~53, `_uploadAndInsertImages` ~130 |
| Voice target | `voice-input.js` `start` ~666, `_insertText` ~962 |
| WS route and caps | `src/web/routes/ws-routes.ts` (`MAX_WS_PER_SESSION`, frame handling), `src/web/ws-connection-registry.ts` |
| Resize arbitration | `src/session.ts` `resize` / `claimDesktopSizing` ~4339-4426 |
| Terminal capture | `src/web/routes/session-routes.ts` `GET /api/sessions/:id/terminal` ~2986; `src/tmux-manager.ts` `captureActivePaneBuffer` ~3825 |
| Attach | `session-routes.ts` `POST /api/sessions/:id/interactive` ~1566 |
