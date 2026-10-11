# Predictive write-through echo for codex

Zero-lag local echo for codex sessions via a second, mosh-style mode in the
`xterm-zerolag-input` package: every keystroke goes to the PTY exactly as the
1.12.2 overlay-disabled path did (byte-identical wire behavior), while a
`PredictiveEchoAddon` simultaneously paints the predicted glyph at the predicted
cell. When the real echo lands, the prediction is confirmed and its span removed
(invisible swap: identical glyph beneath). Mispredictions drop via a mismatch
cascade + TTL. Visual-only, self-healing.

## Why this exists

Issues #218/#219/#220/#222 (one root cause) forced 1.12.2 to disable the
LocalEchoOverlay for codex: buffer-until-Enter starves codex's per-keystroke TUI
(live slash picker, arrows editing server-side composer state, composer
rewrap/growth, paste_burst classification). Buffer mode is structurally
incompatible with codex; write-through prediction is the only echo mode that
can coexist with it.

## The reconciliation lesson (do not regress this)

`docs/local-echo-overlay-plan.md` ("What NOT to Do") documented that matching
predictions against the raw output STREAM fails against Ink/TUI full-line
redraws. This design reads the parsed terminal BUFFER instead (cells after
xterm's parser ran), which converges to the same cells no matter how the bytes
arrived. The Phase 0 recordings prove the point twice over: tmux converts
codex's full-line redraws into minimal in-place deltas (an echo arrives as
`e\x1b[K\x1b[20;80H...`), and codex itself paints word gaps with ECH+cursor-forward
instead of spaces. Stream matching can never survive that; buffer diffing does
not care.

## Phase 0 measurements (codex-cli 0.147.0 via tmux, 100x30, 2026-08-09)

Recorded with `scripts/dev/record-codex-frames.mjs` (production pipeline:
codex inside tmux `status off`, chunks passed through the same full strip
`session.ts _handleTerminalOutput()` applies to codex mode). Fixtures in
`packages/xterm-zerolag-input/test/fixtures/codex/`; replay/measure with
`scripts/dev/analyze-codex-frames.mjs <fixture>`.

| Question              | Measured answer                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer signature    | Cursor row starts `"› "` (U+203A + space), text begins col 2. Present when empty (placeholder), while typing, and while the slash picker filters. `CODEX_COMPOSER_ROW_RE = /^› /` |
| Composer text color   | Plain default foreground, zero SGR around echoed chars. Span `foregroundColor` default (theme fg) is an exact match                                                            |
| Placeholder           | Cycling hint text ("Use /skills...", "Improve documentation in @filename", ...) rendered AT the cursor cell. First prediction lands over placeholder glyphs: covered by the snapshot + cursor-advance rules |
| Wrap                  | Word-wrap near `cols - 2`; continuation rows are indented 2 spaces WITHOUT `› `. The gate therefore suppresses predictions on wrapped lines: deliberate fallback to real echo, wrap was the #220 ghost zone. `edgeMarginCells = 4` |
| Modal (trust dialog)  | Cursor parks on `"  Press enter to continue"`: no `› ` prefix, gate false, zero predictions painted while keystrokes still reach the PTY (the ghost eliminator)                 |
| Streaming             | Error/reconnect bursts render above a re-rendered composer that keeps the `› ` signature; end-of-frame cursor parks at the insertion point (col 2 of the composer row). Confirms the cursor-advance confirm rule and the no-drop-on-baseY rule |
| Echo shape under tmux | tmux emits minimal deltas for simple echoes and full repaints for busy frames; both converge in the parsed buffer                                                              |
| Slash picker          | Picker rows render below; the cursor row keeps the composer signature and advances per filter char, so predictions stay active while filtering (#222 surface)                 |

Constants decided at the Phase 0 gate: `CODEX_COMPOSER_ROW_RE = /^› /`,
`ttlMs = 1000`, `maxPending = 32`, `cursorGraceMs = 150`, `edgeMarginCells = 4`,
span colors = theme defaults, `underlinePredictions = false`.

## Algorithm

See `PredictiveEchoAddon` in
`packages/xterm-zerolag-input/src/predictive-echo-addon.ts`. Summary of the
rules and why each exists:

- **State**: ordered `PredictionRecord[]` (`seq`, `char`, `width`, cumulative
  `offsetCells`, `snapshot` of the cell at predict time, `sentAt`,
  `mismatches`), plus a run `_anchor {row, col}` captured when the outstanding
  count goes 0 -> 1. Positions are FIXED at predict time; confirmation deletes
  spans and never re-lays-out, so partial confirmation causes zero jitter.
- **predictChar(ch)** runs an inline reconcile first and re-anchors whenever
  outstanding drains to zero (absorbs the echo-landed-between-keystrokes race).
  Guards: dims present, cursor numbers present, `viewportY === baseY`,
  `predictWhen` gate, single codepoint >= 0x20 (not 0x7f), width <= 2,
  `maxPending`, edge margin. Returns false = suppressed; the consumer sends the
  keystroke regardless.
- **Coordinate base is `baseY`**: xterm's `cursorY` is baseY-relative, so
  absolute buffer line = `baseY + row`. `viewportY` would only coincide while
  the scrolled-to-bottom guards hold; the addon never relies on that.
- **reconcile()** (debounced `onWriteParsed` microtask, inline in predictChar,
  TTL timer): clears everything when scrolled up; off-anchor-row cursor
  tolerated for `cursorGraceMs` then clears; PREFIX-ONLY confirm loop requiring
  cell match AND cursor advanced past the record (prevents false confirms
  against placeholder glyphs and makes identical in-place tmux repaints a
  no-op); TWO-PASS mismatch rule (a cell that is neither snapshot nor predicted
  char must persist across two passes before cascading the drop: a half-parsed
  row on pass N is fully redrawn a few ms later); TTL drop of the stale suffix.
- **No drop on baseY change**: codex streams push lines to history while the
  composer stays viewport-pinned; predictions are row-relative to the pinned
  composer and remain valid (measured above).
- **Anchor hold** (added by the independent post-build review): after any wire
  input whose cursor effect the display has not shown yet (backspace with
  nothing outstanding = deleting echoed text, every 'clear'-classified input,
  an IME/plain-paste 'text' commit, and the bypass send paths), new
  predictions are suppressed until the next PARSED write. Anchoring on the
  stale cursor painted ghosts one cell off ("tehh" on backspace-then-retype
  within RTT), blank-neutral and therefore TTL-lived. Worst case is exactly
  one unpredicted keystroke: its own echo is a write, which releases the hold.
- **predictBackspace()** pops the newest outstanding record (informational
  return; the consumer forwards `\x7f` unconditionally). Deleting already-echoed
  text renders at RTT in v1.
- **CJK/wide**: 2-cell spans, stacking by cumulative visual width, leading-cell
  confirm. In Codeman, IME input never reaches the hook (`window.cjkActive`
  returns from onData first); package support exists for other consumers.

## Integration map (Codeman)

- Policy: `_localEchoPolicy` (`'buffer' | 'predict' | 'off'`) computed at the
  end of `_updateLocalEchoState()`; codex + `localEchoEnabled` -> `'predict'`
  while `_localEchoEnabled` stays false (every 1.12.2 consumer unchanged).
- onData hook sits between the buffer block and Normal Mode, classifies via
  `classifyPredictInput()` (pure, on `window.CodemanTerminalInput`), never
  returns, try/catch-wrapped: the wire path below is byte-identical with the
  predictor active, absent, or throwing.
- Composer gate: `isCodexComposerRow()` set via `setPredictWhen()` at
  construction (the vendor footer stays package-agnostic).
- Mobile Compose handoff reads the active Codex prompt from xterm's parsed
  composer rows and appends `PredictiveEchoAddon.pendingText` for glyphs not
  echoed yet. The Codex-only editor path then keeps the textarea and TUI prompt
  synchronized with a debounced Ctrl+U + bracketed-paste replacement; Send
  queues Enter after that replacement. Claude and other buffered-local-echo
  sessions retain their existing handoff behavior.
- Second vendor bundle `vendor/xterm-predictive-echo.js` (postinstall + build);
  the zerolag bundle build command is untouched and its output byte-identical.
  Missing/broken bundle = plain 1.12.2 echo (`typeof PredictiveEchoOverlay ===
  'undefined'` guard).
- Prediction clears on: tab switch, SSE reconnect init, `insertTerminalText`,
  `clearTerminalInput`, voice send, keyboard-accessory `sendKey`, resize, skin
  and font changes re-read style via `refreshFont()`.

## Risk register

Eliminated structurally: other-mode regression (zero edits to buffer
addon/branches, byte-identical existing bundle, policy-matrix + byte-identity
tests); bundle breakage (separate bundle, graceful degradation); wire
corruption (no-return fall-through + try/catch + byte-identity pins at vm and
E2E level); modal ghosts (measured predictWhen gate); false confirms
(cursor-advance rule); mid-parse flicker drops (two-pass rule); wrap
misplacement (edge margin + continuation-row gate fallback + off-row grace).

Accepted residuals (visual-only, self-healing <= ttlMs, kill-switchable via
`localEchoEnabled` per device): no predictions on wrapped continuation lines
(gate false there, deliberate); brief dropout during composer growth; DOM-span
vs WebGL glyph rendering can differ subtly (same trade-off as the buffer
overlay, same font recipe); typing during an unsynchronized half-frame can
mis-anchor one run (mismatch/TTL cleans within 1s).

## Future work

RTT-adaptive TTL; mosh-style confidence gating (paint only after the link
proves laggy); predicted backspace into echoed text; predict mode for shell
prompts; unifying the small font/container duplication between the two addons
once predict mode has proven out; continuation-line prediction behind a
smarter composer-extent detector.
