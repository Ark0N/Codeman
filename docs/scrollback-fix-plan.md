# Scrollback fix plan (issue #205)

Status: IMPLEMENTED on `fix/scrollback-shell-alt-screen` (2026-08-07), with one deliberate
divergence from the recommendation below. Kept for the diagnosis record; the measured evidence
behind it is `docs/scrollback-issues-analysis.md`, and the mechanisms as shipped are documented
in `docs/architecture-invariants.md` (§ Full-scrollback replay, § Terminal scrollback: strip
flavors and wheel/touch forwarding).

What shipped vs. what this doc proposed:

- **Bug A (deltaMode)**: implemented as specified (`_wheelScrollLines()` normalizes
  line/page/pixel units, Shift-axis trap kept).
- **Bug B (shell scrollback)**: implemented via the NARROW alt-screen strip for tmux-backed
  shell/opencode/antigravity plus the scroll-to-top `full=1` re-pull, NOT the recommended
  approach (a) `tmux mouse on`. The measurements in the analysis doc showed the alt buffer
  comes from tmux's own client-side `smcup` at attach (tmux never forwards a pane program's
  alt-screen toggles), so stripping that one sequence fixes both symptoms with no selection
  tradeoff, keeps vim/less/htop untouched, and the re-pull also covers the repaint-burst
  history loss that `mouse on` would not have addressed.
- **Invariant change**: the "viewport-at-bottom gate stays" invariant below was deliberately
  DROPPED for forwarding modes: a repaint-mode CLI keeps no real terminal scrollback, so the
  gate pinned users to a buffer of stale frames whenever the viewport parked off-bottom.
  Forwarding now snaps to bottom first; Shift+wheel and the opt-out setting keep local
  scrollback reachable. Touch forwards through the same gate (the mobile half of the fix).
- **Finding 5 (remote probe)**: implemented (`probeRemoteCliVersion` over ssh, deferred at
  session start, same login-shell wrapper as the launch).

## RETEST FAILED (2026-08-07, after v1.12.0 shipped) — analysis round 2

mtiller retested on 1.12.0 and reports it is NOT fixed (issue #205 comment, 2026-08-07 12:12 UTC;
issue reopened same day with clarifying questions: mouse vs trackpad, Shift+scroll behavior,
Claude vs shell session on the phone, and an iOS full-tab-kill to rule out stale JS). Two
failure signatures, now analyzed against the SHIPPED 1.12.0 code (not the pre-fix code):

1. **iPhone Safari (Claude session assumed)**: touch scrollback goes back only a limited
   amount and sometimes REPEATS blocks of text; unreliable.
2. **Firefox on macOS (mouse)**: wheel does NOTHING at all, while Fn+Up (= PageUp) pages back
   through INTACT text.

### Ruled out by code reading

- deltaMode mishandling: `_wheelScrollLinesFloat` normalizes line/page/pixel units correctly;
  a Firefox line-mode notch yields ±3 lines. Not the bug.
- Ephemeral transport: `_sendInputEphemeral` (app.js) has a POST fallback when WS is down.
- Service worker: sw.js is network-first with cache fallback; it serves stale JS only when the
  fetch FAILS (flaky mobile connection can do this — relevant to "unreliable" on the phone,
  and the fixed `CACHE_NAME = 'codeman-v1'` never invalidates that offline copy).

### The load-bearing observation: PageUp works, the wheel does not

Fn+Up is a KEYBOARD event: xterm encodes PageUp and Claude pages its own transcript (intact
text proves Claude-side history is fine and the PTY input path is fine). The wheel path is the
capture-phase handler, and for a Claude session it has exactly two branches:

- **Forwarding branch** (`_shouldForwardWheelToApp` true): snap-to-bottom + SGR reports. If
  this branch ran, the user would see the same paging motion Fn+Up produces. They see nothing.
- **Local branch** (gate false): `_smoothScrollBy` over xterm's local buffer. For a Claude
  pane in repaint mode, tmux keeps `history_size≈0`, so `?full=1` returns roughly one frame:
  the local buffer is structurally HOLLOW, the top-of-buffer re-pull recovers nothing, and the
  wheel looks completely dead. **This matches every observed detail on Firefox.**

So the working hypothesis is that mtiller's sessions evaluate the gate FALSE. The gate
(`_shouldForwardWheelToApp`) has exactly four false-paths worth checking, in likelihood order:

1. **`terminalWheelLocalScrollback` opt-out is ON.** Plausible: a user whose scrolling was
   broken on 1.11.x may well have toggled "Wheel scrolls local history" while trying to fix
   it. On 1.12.0 that setting now routes the wheel to a hollow local buffer = dead wheel on
   desktop AND the stale-repaint-frames experience on the phone (see below). Ask, or check
   what the setting does on their export.
2. **`cliVersion` missing — CONFIRMED BUG, independent of whether it is mtiller's**:
   `getClaudeCliVersion()` (utils/claude-cli-resolver.ts:124-148) caches its result
   process-wide including FAILURE: on any exception it sets `_claudeVersion = null`, and the
   guard is `!== undefined`, so a single failed/timed-out probe (5s `EXEC_TIMEOUT_MS`; PATH
   under systemd/launchd; transient fs hiccup) at the FIRST Claude session start disables
   wheel forwarding for every Claude session until the server restarts. Fix: cache success
   permanently, but let failure retry (retry on next call, or a short negative-cache TTL).
   Note that mtiller sees identical breakage on phone + iPad + laptop, which points at a
   SERVER-side/session-side cause exactly like this (cliVersion is shared by all devices)
   rather than anything browser-specific.
3. **Claude Code genuinely < 2.1.187** on their machine: gate false BY DESIGN, but the
   resulting UX is a dead-end (no local history to fall back on).
4. mouseTrackingMode non-none (a DECSET leaked past the strip, e.g. emitted before attach or
   split across chunks in a way the carry missed): would also kill the container handler via
   the early return. Least likely, checkable via `terminal.modes.mouseTrackingMode` in console.

### The iPhone symptoms fit the same gate-false story

Touch with gate false = local `scrollLines()` over whatever repaint frames accumulated:
"repeats blocks of text" is literally what a buffer of successive overlapping repaint frames
looks like; "limited amount" is its thinness; "unreliable" is burst-dependence (finding 2)
PLUS the new re-pull being actively DESTRUCTIVE for repaint panes: `_maybeRefetchFullHistory`
does `_resetTerminalForReplay()` then writes the fetched capture, and when that capture is
one frame (Claude pane, `history_size≈0`) it REPLACES a multi-frame buffer with less than the
user had, mid-scroll. Stale pre-1.12 JS on the phone (suspended Safari tab) remains possible
until they confirm the tab kill.

### Fix directions, ranked

1. **Make the re-pull refuse downgrades** (`_maybeRefetchFullHistory`, app.js): if the fetched
   capture would yield FEWER buffer rows than currently present, skip the reset+rewrite and
   keep the richer buffer (optionally cache-mark the session "re-pull useless"). Small, safe,
   kills the "got worse after scrolling to top" class. Consider skipping the re-pull entirely
   for forwarding-capable modes where tmux keeps no history.
2. **Rescue the gate-false Claude dead-end with PageUp forwarding**: when mode is `claude`,
   the gate is false, AND the local buffer has no scrollback (`baseY === 0`), translate wheel
   lines into coalesced PageUp/PageDown key sends (mtiller just proved Claude pages correctly
   on PageUp even on their version). Zero regression risk under that triple guard: sessions
   with real local history keep local scrolling; only the currently-dead path changes.
   Caveat: older Claude menus may react to PageUp; acceptable against "completely dead".
3. **Audit `getClaudeCliVersion()` failure caching** (utils/claude-cli-resolver.ts): a cached
   empty probe must retry (with backoff), not poison the process.
4. **Guard the opt-out setting's footgun**: if `terminalWheelLocalScrollback` is ON for a
   repaint-mode CLI session, local history is hollow; either scope the setting's effect to
   modes with real local scrollback, or pair it with fix 2's PageUp fallback so it still
   scrolls SOMETHING.
5. **Add a one-line gate diagnostic**: log (once per session, console) WHY the wheel chose
   local vs forward: `{mode, cliVersion, optOut, trackingMode}`. The #205 thread is now two
   rounds deep on guesswork a single console line would have answered.

### What shipped for round 2 (branch `fix/scrollback-205-round2`)

All five directions above, implemented as ranked:

1. **Downgrade guard** — `_replayWouldShrinkBuffer()` (terminal-ui.js) estimates the rows a
   capture will occupy (ANSI stripped, `capture-pane -J` re-wrapping accounted for) and
   `_maybeRefetchFullHistory` (app.js) skips the reset+rewrite when that is more than one
   screen short of what xterm already holds. A refused session goes on
   `_fullHistoryRepullUseless`, which raises its re-pull cooldown from 4s to 60s so a hollow
   pane stops re-fetching. Measured A/B on a live Claude pane, same gesture, same buffer:
   guard off → 341 rows collapse to 42 and every seeded row is gone; guard on → 341 rows
   preserved. The tab-switch recovery it must not break still runs (shell buffer 401 → 44 on
   a tab switch → 401 again after scrolling to the top).
2. **PageUp/PageDown fallback** — `_maybePageCliTranscript()` translates wheel/touch travel
   into coalesced `\x1b[5~` / `\x1b[6~` under the triple guard (claude mode, forwarding gate
   false, `baseY === 0`), through the same 40ms queue as the SGR reports. Half a screen of
   travel per page: the page key always jumps a whole screen, and a 1:1 mapping was
   unusably slow with a discrete wheel. Shift is excluded — it keeps meaning "local
   scrollback". Verified live: opt-out ON on a Claude session sends real PageUp/PageDown to
   the PTY where the wheel previously did nothing.
3. **Probe caching** — `getClaudeCliVersion()` no longer caches failure. Success is kept for
   the process lifetime; a failed probe retries with a 1/2/4…15min backoff. The cache policy
   is a pure function (`resolveClaudeCliVersion`) so the retry semantics are unit-testable
   without spawning `claude`. The VITEST short-circuit now records nothing, where before it
   wrote a permanent null.
4. **Opt-out footgun** — handled by pairing rather than by scoping: the setting keeps meaning
   exactly what it says (the wheel goes local), and fix 2 catches the case where "local" is
   empty. Scoping the setting away from repaint-mode CLIs would have silently overridden an
   explicit user choice. The App Settings tooltip now says to leave it off for Claude/Codex.
5. **Diagnostic** — `_logScrollRouting()` prints one line per session per distinct decision:
   `[scroll] <id> → forward-sgr|page-keys|local-scrollback|repull-refused-downgrade (mode=…,
   cliVersion=…, localScrollbackOptOut=…, mouseTracking=…, localScrollbackRows=…)`. That
   single line answers every open question in the list below.

Still unanswered by code alone: whether mtiller's Claude Code is genuinely older than
2.1.187 (false-path 3), and whether the iPhone was running stale JS. The diagnostic makes
both self-reporting, so the retest ask is now "open the console and paste the `[scroll]` line".

### What to get from mtiller (some already asked)

- Shift+scroll behavior on Firefox (distinguishes hollow-local from handler-not-firing).
- `claude --version` on the Mac (decides false-paths 2 vs 3).
- App Settings → Input → "Wheel scrolls local history" state (false-path 1).
- iPhone: Claude or shell session, and whether a full tab kill changes anything.
- Browser console: `app.terminalUi?.terminal?.modes?.mouseTrackingMode` (false-path 4).

## ROUND 3 (2026-08-09): Codex wheel dead — CONFIRMED AND FIXED

DodgyBadger (Codex latest, Chrome, Windows 11): mouse wheel does nothing in a CODEX session
while working fine in shell and web tabs; DRAGGING THE SCROLLBAR WORKS, so xterm's local
buffer demonstrably has content for their codex pane. Analysis against the shipped code:

- `_shouldForwardWheelToApp` returns true UNCONDITIONALLY for `codex` (no version gate, unlike
  claude's `>= 2.1.187`), so every plain wheel tick is sent as SGR reports to Codex.
- The "verified to scroll its transcript on SGR wheel reports" claim for codex predates
  current Codex builds; if Codex latest ignores SGR wheel, forwarding eats the gesture while
  the healthy local scrollback (proven by the working scrollbar) sits unused.
- The #227 PageUp fallback cannot rescue this: it is gated to `claude` mode AND `baseY === 0`,
  and codex here has real local scrollback. The `[scroll]` diagnostic will still say
  `forward-sgr (mode=codex, ...)`, confirming the branch, worth asking the reporter to paste.

**CONFIRMED by the reporter's `[scroll]` line (2026-08-09, PR #227 comment)**:
`forward-sgr (mode=codex, cliVersion=unknown, localScrollbackOptOut=false, mouseTracking=none,
localScrollbackRows=967)`. Forwarding branch active, 967 rows of healthy local scrollback
unused, Codex ignoring the SGR reports. Environment: Codex latest, Chrome, Windows 11.

**Measured against codex-cli 0.147.0** (isolated `tmux -L codexwheel`, fake `CODEX_HOME/auth.json`,
history built with 401ing prompts), which settles it without needing a version gate at all:

| Probe                                          | Result                                          |
| ---------------------------------------------- | ----------------------------------------------- |
| `#{mouse_any_flag}` once the TUI is up         | `0`: codex never enables mouse tracking         |
| `#{alternate_on}`                              | `0`: inline viewport, not an alt-screen pager   |
| `#{history_size}` while prompting              | grows 3 → 32: the transcript goes to scrollback |
| 6 × `\x1b[<64;10;10M` written to the pane      | pane capture byte-identical, nothing happens    |
| control: literal `zz`                          | pane changes, so the probe can see changes      |
| `\x1b[<0;12;5M` + release (the click-tap path) | no change either: taps are no-ops, not garbage  |

Codex has no in-app pager to drive: its history lives in the terminal's own scrollback, which is
exactly what forwarding was stealing the gesture from. A version gate would be the wrong fix (and
`cliVersion=unknown` means there is no codex probe to gate on anyway).

**Fix (shipped):** `_shouldForwardWheelToApp` now returns true for `claude >= 2.1.187` and nothing
else. Codex falls to the normal local-scrollback path like shell/gemini/opencode, so wheel and touch
scroll the same history the scrollbar drag was already scrolling. The claude-only PageUp fallback is
untouched: codex never needs it, its local buffer is real. Taps stay hand-encoded for codex
(`_sessionUsesServerMouseStrip`), measured harmless, so click-to-position is merely unavailable
there rather than damaging. Lesson for the next mode added to the forward list: "it is a strip mode"
proves nothing, write a real SGR report into a live pane and diff the capture first.

Verified end-to-end in Chromium against a live codex session on an isolated instance
(`CODEMAN_INSTANCE=codexwheel`, port 5055, `envOverrides.CODEX_HOME` pointing at the fake auth
dir): trusted `page.mouse.wheel` up now logs
`[scroll] … → local-scrollback (mode=codex, …, localScrollbackRows=43)`, moves the viewport
39 → 4 (back to the Codex banner), and sends ZERO bytes to the PTY. Unit coverage:
`test/terminal-touch-tap.test.ts` ("only claude forwards — codex and gemini keep the local wheel").

Original plan follows.

## Reports

- **Issue #205** (https://github.com/Ark0N/Codeman/issues/205), OPEN:
  - **jonocodes** (author, 2026-08-03): SHELL session. Host Mac M4, brew tmux. On Android, touch-scrolling the terminal does nothing. On desktop, the mouse wheel cycles shell command history (acts like Up/Down arrows) instead of scrolling the screen.
  - **mtiller** (comment, 2026-08-06): "similar issue just with scrolling backward to see agent output. This is with Firefox on MacOS." (Claude session implied.)
- **Reddit r/selfhosted** comment `p21x6ts` by mmtiller (= mtiller on GitHub): scrolling broken enough across phone/iPad/laptop that they fall back to Claude's own remote-control feature. Churn-risk user who otherwise loves the product; fixing this has promo value beyond the bug itself.

## How scrolling works today (read this before touching anything)

Three independent paths, all in `src/web/public/terminal-ui.js` unless noted:

1. **Desktop wheel** (container `wheel` listener, ~line 421): ALWAYS `preventDefault()`s, then either
   - forwards synthetic SGR wheel reports to the app (`_sendSyntheticSgrWheel`, coalesced every 40ms, fire-and-forget) when `_shouldForwardWheelToApp(ev)` (~line 2823) passes: no Shift held, opt-out setting `terminalWheelLocalScrollback` off, xterm `mouseTrackingMode === 'none'`, session mode is `claude` with `cliVersion >= 2.1.187` or `codex`, and viewport is at bottom;
   - otherwise scrolls xterm's LOCAL scrollback via `terminal.scrollLines(lines)`.
   - `lines` comes from `_wheelScrollLines(ev)` (~line 2818): `delta / 25`, i.e. it assumes PIXEL deltas.
   - NOTE: xterm.js's own internal wheel handler sits on an element INSIDE the container, so it runs FIRST (bubble order) and is not suppressed by the container's `preventDefault`.
2. **Touch** (touchstart/move/end, ~lines 441-585): converts touch deltas to `terminal.scrollLines()` with momentum. Touch is ALWAYS local-scrollback, never forwarded to the app. Tap-to-position (touchend, ~line 533) is separate and already handles both mouse-tracking-on and server-strip cases.
3. **Server-side strip** (`_handleTerminalOutput`, `src/session.ts:1384`): for modes in `isAltScreenStripMode()` (`src/session.ts:179` = `codex | claude | gemini`), strips alt-screen switches (`?47/?1047/?1049`), scrollback erase (`3J`), and mouse-tracking DECSETs (`?1000-?1007` except `?1004` focus) so content stays in xterm's normal buffer with scrollback intact. Includes a chunk-boundary carry so split sequences can't leak. `shell` and `opencode` (and `antigravity`) are deliberately EXCLUDED: arbitrary shell programs (vim/less/htop) legitimately need the alt screen. There is a parity copy of this strip on the replay path (`src/web/routes/session-routes.ts`, ~line 1697) and a frontend parity check `_sessionUsesServerMouseStrip()` (terminal-ui.js ~line 2751). All three must stay in sync.
4. Related: full-scrollback replay (`GET .../terminal?full=1` on first buffer load) fills xterm local scrollback; client scrollback is hardcoded 50k (`DEFAULT_SCROLLBACK`, constants.js) vs tmux 100k.

## Diagnosis

### Bug A: Firefox wheel deltas (mtiller's desktop case)

`_wheelScrollLines()` divides by 25 assuming `WheelEvent.deltaY` is pixels (`deltaMode === 0`, Chrome/Safari behavior). Firefox commonly fires `deltaMode === 1` (LINE units, deltaY around 1-3 per notch), so `Math.round(3/25) = 0` and the `|| ±1` fallback yields 1 line per event. With a discrete mouse wheel that is 1 line per notch: scrolling feels dead/broken. This hits BOTH the local-scroll path and the forwarded path, since both use the same function.

**Fix**: normalize by `ev.deltaMode` in `_wheelScrollLines()`:
- `deltaMode 0` (pixels): current behavior, `delta / 25`.
- `deltaMode 1` (lines): use the delta directly (round, keep sign fallback).
- `deltaMode 2` (pages): `delta * terminal.rows` (or a sane page size).
Keep the existing Shift-axis trap intact: on macOS trackpads Shift+two-finger scroll arrives as a HORIZONTAL wheel (deltaX carries the magnitude, deltaY ~0); that's why the function reads deltaX when Shift is held (issue #154). Don't lose it.

**Verify**: don't trust this diagnosis blindly. First reproduce in real Firefox on macOS and log `deltaMode`/`deltaY` (Firefox trackpad input can arrive as pixels; external mouse as lines). Also confirm the session's `cliVersion` probe succeeded (a failed probe disables forwarding entirely, which would point elsewhere). Unit-test by dispatching synthetic `WheelEvent`s with explicit `deltaMode` values; a Playwright `firefox` project pass is the end-to-end check.

### Bug B: shell mode has NO working scrollback at all (jonocodes)

Chain: shell mode is excluded from the alt-screen strip (correctly) → tmux attaches on the alternate screen → xterm's alt buffer has zero scrollback. Consequences:
- **Wheel**: xterm's own internal wheel handler runs first and, in the alt buffer, converts wheel ticks into Up/Down arrow keys (alternateScroll behavior). The shell receives arrows → command history cycles. That is jonocodes' exact desktop symptom. The container handler's `scrollLines()` afterwards is a no-op (no scrollback in alt buffer).
- **Touch**: the touch handler's `scrollLines()` is equally a no-op → "scrolling does nothing" on Android. Exact symptom two.
- The real history exists the whole time in tmux's 100k-line buffer; nothing exposes it.

**Fix, recommended approach (a): enable tmux `mouse on` for shell sessions.**
- Server-side, set `mouse on` scoped to shell sessions' tmux sessions (`tmux set-option -t <session> mouse on` at create + on attach of recovered sessions). Do NOT set it globally on the socket: claude/codex/gemini sessions rely on the DECSET strip and must not change.
- What this buys, all natively: tmux enables mouse tracking on the outer terminal → xterm `mouseTrackingMode` goes non-none → the container handler stands down (line ~2830 check) and xterm's own encoder forwards wheel as SGR reports → tmux scrolls its OWN copy-mode history on wheel-up, auto-exits at bottom. The alt-scroll arrow conversion disappears too (tracking mode takes precedence). Desktop is fully fixed with no new endpoints.
- **Touch**: still needs one small client change: in the touchmove path, when the active session is `shell` AND `mouseTrackingMode !== 'none'`, convert accumulated lines to `_sendSyntheticSgrWheel(x, y, lines)` instead of `scrollLines()`. The 40ms coalescing already prevents the tmux process storm (each send is a tmux send-keys server-side; unbatched flicks would spawn dozens of processes: this constraint is documented at `_sendSyntheticSgrWheel`, do not bypass it).
- **Selection tradeoff to verify**: with tracking on, xterm hands drag events to tmux instead of doing local browser selection. Shift+drag still does local selection (xterm shift-override). Verify this UX on desktop before shipping; if it's unacceptable, fall back to approach (b).
- **Also verify**: vim/less/htop inside the shell still behave (they'll now receive real mouse events via tmux, generally an improvement); remote shell sessions run tmux on the REMOTE host (`tmux -L codeman-remote`) and need the same option set there if remote shells are in scope (fine to defer, note it in the changeset if skipped).

**Fallback approach (b), only if (a)'s selection tradeoff fails testing**: keep mouse off; when a shell session is in the alt buffer, have the client send scroll intents to a small server endpoint that drives `tmux copy-mode -e -t <pane>` + `send-keys -X -N <n> scroll-up/down`. Preserves selection semantics exactly, but needs a new endpoint, server-side batching, AND suppression of xterm's native alt-scroll arrow conversion (capture-phase wheel listener with `stopPropagation`, or `attachCustomWheelEventHandler` if the vendored xterm version has it). More moving parts; (a) should be tried first.

**Not acceptable**: adding `shell` to `isAltScreenStripMode()`. vim/less/htop need the alt screen; that exclusion is deliberate and documented.

### Bug C: mtiller's phone/iPad case — UNREPRODUCED, do not guess

Touch is always-local by design, and Claude sessions keep content in the normal buffer (strip), so touch scrollback "should" work there. Before coding anything: build a repro matrix (iPhone Safari / iPad Safari / Android Chrome × claude / shell) on the current release. Plausible candidates if it does reproduce: auto-scroll-to-bottom fighting user scrolls (`_noteTerminalUserScroll`, ~line 2004), or they were in shell sessions on mobile too (then Bug B covers it). Ask mtiller on #205 for session mode + Codeman version if the matrix comes up clean.

## Invariants the implementation MUST respect

- Shift+wheel always scrolls local scrollback; the trackpad Shift-axis handling from #154 stays.
- The `terminalWheelLocalScrollback` opt-out setting keeps working (pins plain wheel to local).
- The viewport-at-bottom gate stays: once the user scrolled up locally, wheel stays local until they return to bottom.
- 40ms SGR coalescing: never send per-event writes to the server.
- Strip parity triangle: `session.ts` live strip ↔ `session-routes.ts` replay strip ↔ `_sessionUsesServerMouseStrip()` in the frontend. If you touch mode lists, update all three.
- Don't add `opencode`/`antigravity` to any strip/forward list; their TUI wheel behavior is unverified (documented at `_shouldForwardWheelToApp`). ⚠️ 2026-09-16: opencode's half is now MEASURED — 1.18.31 ignores SGR wheel reports but pages its transcript on PageUp/PageDown — so it belongs in the **paging** list (`_localScrollbackIsHollow`), which is not a strip/forward list. antigravity/grok/deepseek/omp remain unverified.
- The chunk-boundary sequence carry in `_handleTerminalOutput` must not be weakened.

## Testing (per repo rules)

- `npm test -- test/<file>.test.ts` only; never bare `npm test`. New test ports 3150+, never 3000.
- Browser-test traps (documented in CLAUDE.md Testing): drive input/scroll through real events (`page.mouse.wheel`, real touch), not app internals; headless Chromium reports `isTouchDevice()` false even with `hasTouch: true`; assert on real state (xterm viewport position, `tmux -L codeman capture-pane`), not HTTP 200.
- Shell-mode E2E: create a throwaway shell session, `seq 1 500`, then (1) wheel up on desktop shows earlier lines, not history cycling; (2) touch-scroll on a phone shows earlier lines; (3) `vim` + `less` still enter/leave the alt screen cleanly; (4) Shift+drag still selects text.
- Firefox E2E: Playwright `firefox` project, wheel over a Claude session's finished output, assert viewport moved more than 1 line per notch.
- End-to-end against the REAL environment before claiming done (standing user rule). w1/w2/w3 tmux sessions are the user's live sessions: never send input to them; create your own throwaway session and DELETE it by exact id when done.

## Related observation (not a reported bug, worth a look while in there)

The `claude --version` probe that feeds the forwarding gate runs only for local and docker sessions (`src/session.ts:1490` gates `!this._remote`; docker handled at :1507). Remote Claude sessions therefore never get `cliVersion` and silently keep local-only wheel. Harmless (local scrollback works) but inconsistent; cheap to fix by probing over ssh, or document as intended.

## Rollout

1. Bug A (deltaMode) is small and independent: can ship alone as a patch.
2. Bug B (shell scrollback) is the headline fix for #205: patch or minor per COM flow.
3. After deploy + verification: comment on #205 (what was fixed, what needs their retest), then reply to the Reddit comment `p21x6ts` with the release version. Both reporters gave environment details; address them specifically.
