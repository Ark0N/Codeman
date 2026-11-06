# gesture-proto

A Jarvis-style hand-tracking input layer for the Codeman dashboard. Your webcam
sees your hands; you pinch-drag session tabs between columns. Runs entirely
in-browser — **the camera feed never leaves the machine.**

> **This build is pinch-drag only.** The discrete gesture commands (halt-all /
> approve / new-session) were built in Phase 4 but are **intentionally not wired
> up** — an open palm while reaching to pinch kept charging the hold-to-halt. The
> `GestureController` core still emits `command`/`haltProgress` for any future
> consumer; the demo just no longer listens.

This is a standalone prototype (own folder, fake tabs) so the input *feel* can
be validated on real hardware before integrating with Codeman. The canonical
spec is **[`docs/BUILD_PLAN.md`](./docs/BUILD_PLAN.md)** — read it before
continuing the build.

---

## Status: Phase 0–4 complete

| Phase | What | State |
|-------|------|-------|
| 0 | Vite+TS scaffold, mirrored webcam preview, start button | ✅ done |
| 1 | MediaPipe `GestureRecognizer` (VIDEO mode, CDN model+wasm), rAF loop, debug skeleton overlay, HUD | ✅ done |
| — | **Checkpoint: ≥25fps on real camera/lighting** | ✅ 60fps (iPhone 17 Pro / Continuity Camera) |
| 2 | One-Euro–filtered cursor + pinch detection (hysteresis) | ✅ done |
| 3 | Drag fake tabs across 3 columns (state machine) — go/no-go | ✅ done (two-handed) |
| 4 | Discrete gesture→command bus (👍 approve · ✌️ new-session · ✋-hold halt-all) + toast | ✅ built, ⛔ **unwired in the demo** (pinch-only) |
| 5 | Integrate `gesture/` into real Codeman (`src/codeman/entry.ts`) | ✅ **working at the desk** — see [Codeman integration](#codeman-integration) |

Also done beyond the original plan: **two-hand tracking** (drag two tabs at
once) and a **live camera picker** (front-facing iPhone 17 Pro by default; the
superwide / Desk View camera now works too — see the camera note below).

Also: **fullscreen mode** (toggle button — the board fills the display, so grab
targets get big).

**Phase 5 is live** in the real Codeman dashboard. The Codeman-side detach +
instance isolation + base gesture overlay are committed on `Ark0N/Codeman`
branch `beta/session-detach` (open as **PR #103**) — including this session's
gesture *improvements* (direct-detach, Run/Run Shell taps, self-hosted MediaPipe,
cache-bust), ported onto the PR in commit `eea84db` (CI green). See
[Codeman integration](#codeman-integration) below and the hand-off brief
[`../docs/CODEMAN_DETACH_BRIEF.md`](../docs/CODEMAN_DETACH_BRIEF.md).

**Multi-monitor mode — built & validated at the desk (2026-06-08).** Approach
**A+C** (see [`../docs/MULTIMONITOR_DESIGN.md`](../docs/MULTIMONITOR_DESIGN.md)):
(A) gesture "detach" now pops a session into a re-grabbable **in-page floating
panel** (an `<iframe src="/session/:id">`, not an OS window — so the hand keeps
control); (C) `scripts/span-codeman.sh` runs Codeman in a **single window spanned
across both monitors** (Brave-first; needs macOS "Displays have separate Spaces"
OFF + re-login), launchable one-click from a new **multi-monitor button** in
Codeman's header. Confirmed: a panel drags across the monitor seam. Still pending:
`getScreenDetails` screen-snapping (C-snap) and the re-dock gesture.

---

## Run it

```bash
cd gesture-proto
npm install
npm run dev
```

Open the URL Vite prints (http://localhost:5173). `getUserMedia` requires a
secure context — `localhost` qualifies, so the dev server is fine. Click
**Start camera**, allow the camera, hold a hand up. You should see each hand's
21-point skeleton, a cursor ring per hand (cyan = left, violet = right, green
while pinching), and a live HUD.

**Choosing a camera:** after Start, the dropdown lists every video device. On a
Mac with an iPhone nearby (Continuity Camera) you'll typically see the built-in
FaceTime cam, the **iPhone Camera** (main/wide lens), and a **Desk View Camera**
— the latter is driven by the iPhone's ultra-wide lens aimed down at the desk
(the overhead angle). Switching is live; no restart needed. The browser can't
select the ultra-wide lens directly, so Desk View is how you reach it. **The
Desk View / superwide camera now works with no issues and tracking is confirmed
on it** — earlier it was Safari-only and rendered stretched; that's resolved.

**Using it:** point at a tab (it highlights), **pinch** thumb+index to grab,
move to another Screen column, release to drop. Both hands work at once. **⛶
Fullscreen** makes the board fill the display (Esc exits). No open-hand gesture
commands in this build — it's pinch-drag only (see the note up top).

Other scripts: `npm run build` (tsc + vite build), `npm run preview`.

### Developing on the Mac mini, running on the MacBook

The prototype is *run/tested* on the MacBook (better for sitting at the desk
with the camera). To sync:

```bash
git pull          # on the MacBook
cd gesture-proto && npm install && npm run dev
```

No machine-specific state is committed (`node_modules/`, `dist/`, and
`.claude/settings.local.json` are gitignored).

### Framerate note

The HUD fps turns **green at ≥ 25**, amber below. Confirmed **60fps** on the
iPhone 17 Pro (Continuity Camera). If it's ever low, improve **even, frontal
lighting on the hand zone** first — that matters more than the sensor.

---

## Codeman integration

Phase 5 ships a **separate consumer**, `src/codeman/entry.ts` (the demo +
`main.ts` are untouched — they stay as a desk-testing harness). It imports the
same unchanged `src/gesture/` core and binds its events to the **real** Codeman
dashboard. Build it standalone (MediaPipe inlined) with:

```bash
npm run build:codeman      # esbuild → dist-codeman/gesture-codeman.js
```

Codeman serves that bundle at `/gesture/gesture-codeman.js` and injects it into
the dashboard **only when started with `CODEMAN_GESTURE=1`** (which also widens
its CSP for WebAssembly). Deploy = copy the bundle into Codeman's
`src/web/public/gesture/` and reload (static is served from disk).

**Gestures (all off one pinch, routed by what's under your fingertips):**
- **Fullscreen camera** by default — mirrored, dimmed, full-viewport so you see
  your hands over the real tabs; the **⛶** button toggles a corner preview.
- **Grab → in-page floating panel** *(pivoted 2026-06-08 — replaced the old
  OS-window detach)* — pinch a session tab, a ghost of it follows your hand, pull
  it out of the strip (>70px) and release → the session pops into a **re-grabbable
  in-page `.cg-float` panel** (an `<iframe src="/session/:id">`, 640×420) at the
  drop point. Pinch the panel again to move it anywhere. It stays inside the
  camera-owning page, so the hand keeps control (the old `window.app.detachSession`
  `window.open` was a one-way trip). A small twitch-and-release cancels.
- **Tiles** (tile grid open): pinch anywhere on a tile and carry it onto
  another tile (the two trade places) or an empty cell (it moves there). A
  session tab carried onto a tile or an empty cell joins the grid there. With
  **Detach Tiles** on (App Settings, per device, off by default) a tile let go
  outside the grid opens as a window of its own, which needs the site's pop-ups
  allowed (a hand is no click). The moves are tile-grid.js's own
  (`tileDropTargetAt` / `dropOnTileTarget` / `detachTileAtPoint`).
- **Run / Run Shell** — pinch over the **Run** (`#runBtn`) or **Run Shell**
  (`.btn-shell`) toolbar button and release in place to fire it; drifting too
  far first cancels the tap. The button list is `CLICK_SELECTOR` in `entry.ts`.

**Self-hosted MediaPipe.** The Codeman consumer loads the wasm runtime + the
`gesture_recognizer.task` model **same-origin** from `/gesture/` (via
`wasmBase`/`modelUrl` options), not the CDN — a browser content/ad blocker can
otherwise block the CDN and startup fails with `failed: {"isTrusted":true}`.

**Multi-monitor button.** Codeman's header has a **multi-monitor button** (it
replaced the notification bell) → `POST /api/system/span-displays` → spawns
`scripts/span-codeman.sh`, opening a fresh browser `--app` window spanned across
all displays so floating panels can cross the monitor seam (PR #103 `95b0035`).

**Caveats:** Codeman serves static with a 1-year **`immutable`** cache, so
`server.ts` `cacheBustAssets()` appends `?v=<mtime>` to **every** same-origin
`.js`/`.css` (and the gesture bundle), re-stat'd per render — without it an edited
module stays cached until a hard refresh (PR #103 `b5ea711`). The old OS-window
detach verb (kept only as a deliberate, non-default action) does `window.open`,
which a pinch can get popup-blocked — allow popups once if you ever wire it back.

---

## Layout

```
gesture-proto/
├── index.html              # demo page: video, tab board, HUD, controls
├── docs/
│   └── BUILD_PLAN.md       # canonical spec: goals, algorithms, phases, tuning
├── src/
│   ├── main.ts             # wires GestureController -> demo UI (board, HUD, camera, fullscreen)
│   ├── gesture/
│   │   ├── GestureController.ts   # camera + recognizer + loop + per-hand state + event bus
│   │   ├── OneEuroFilter.ts       # per-axis cursor smoothing
│   │   ├── pinch.ts               # pinch distance + hysteresis detector
│   │   ├── commands.ts            # debounced gesture→command bus (Phase 4)
│   │   ├── landmarks.ts           # landmark indices, connections, helpers
│   │   └── types.ts               # event payload types + config (full API surface)
│   ├── demo/
│   │   ├── overlay.ts             # draws the hand skeleton + per-hand cursors
│   │   └── tabs.ts                # the 3-column board: hit-testing + drag mechanics
│   └── codeman/
│       └── entry.ts              # Phase 5 Codeman consumer (real tabs + Run/Run Shell);
│                                 #   esbuild-bundled by `npm run build:codeman`
```

---

## `GestureController` API

Transport-agnostic: it owns the camera, recognizer, per-hand smoothing, pinch
state machine, and gesture→command bus, and emits **coordinate-only** events. It
knows nothing about tabs or the DOM — hit-testing lives in the consumer (the
demo's `tabs.ts`, later Codeman). Integration (Phase 5) is just subscribing and
calling Codeman's existing tab-move / command functions.

```ts
const gc = new GestureController({
  video: videoEl,
  surface: stageEl,        // normalized coords map against this element's rect
  numHands: 2,
  pinchOn: 0.35, pinchOff: 0.5,   // pinch hysteresis (fractions of hand size)
  minCutoff: 1.0, beta: 0.01,     // One-Euro cursor smoothing
  palmHoldMs: 1000,               // Open_Palm hold before halt-all fires
  deviceId: "",                   // specific camera; "" = default user-facing
});

// Drag events — surface pixels (X already mirrored), with a per-hand id.
gc.on("grab", ({ hand, x, y }) => {});  // pinch closed → start drag
gc.on("drag", ({ hand, x, y }) => {});  // moving while pinched (per frame)
gc.on("drop", ({ hand, x, y }) => {});  // released (or hand vanished mid-pinch)

// Discrete commands: "halt-all" | "approve" | "new-session".
// Still emitted by the controller, but THIS build's demo does not subscribe
// (pinch-only). Wire these up in Codeman (Phase 5) or re-enable in the demo.
gc.on("command", ({ name }) => {});

// Per-frame snapshot for HUD / hover highlighting / debug overlay.
// `haltProgress` (0–1 Open_Palm charge) is also still emitted but unused here.
gc.on("status", ({ fps, hands, haltProgress }) => {});
//   hands: { handedness, cursor:{x,y}/*normalized*/, pinchDist, pinching, gesture }[]
gc.on("results", ({ result, timestampMs }) => {}); // raw recognizer result

await gc.start();              // requests camera, loads model
await gc.useCamera(deviceId);  // switch camera live
await gc.listCameras();        // enumerate video inputs
gc.stop();
```

All events are live. Hover highlighting is derived from the `status` snapshot
(not a dedicated event), since only the consumer can hit-test against its tabs.
Full types in [`src/gesture/types.ts`](./src/gesture/types.ts).

---

## Tuning defaults (start here, then adjust by feel)

- **One-Euro filter:** `minCutoff ≈ 1.0`, `beta ≈ 0.01`. Raise `beta` if drag
  lags during fast moves; lower `minCutoff` if it jitters when still.
- **Pinch:** `PINCH_ON 0.35`, `PINCH_OFF 0.5` (fractions of hand-size reference
  distance, wrist→middle-MCP). Two thresholds = hysteresis = no flicker.
- **Confidence:** detection/tracking ≈ 0.6. Lower if quick gestures get missed,
  raise if you get false hands.
- **Camera:** target 30–60fps, even frontal lighting on the hand zone.

---

## Design notes

- **Standalone first.** Fake tabs let us validate feel before touching Codeman.
- **Main thread first.** Inference runs on the main thread (60fps, no stutter);
  a Web Worker stays an optional optimization only if the UI ever stutters.
- **Two hands** (`numHands: 2`). Each hand keeps its own cursor + pinch state,
  keyed by handedness so filters don't swap when MediaPipe reorders the hands.
- **Camera angle: front-facing default; superwide now usable too** — iPhone 17
  Pro main lens via Continuity Camera, pointing / pinch-to-grab grammar. The
  superwide / Desk View (overhead, ultra-wide) camera now works with no issues
  and tracking is confirmed on it; the earlier Safari-only / stretched blocker is
  resolved. The in-app picker switches cameras live.
- **Transport-agnostic controller.** It emits coordinate-only `grab`/`drag`/
  `drop` + `command`; the consumer hit-tests. So Phase 5 only swaps the demo's
  `tabs.ts` for Codeman wiring — the controller is untouched.
