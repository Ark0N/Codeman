# iOS keyboard ownership (#830)

On iOS WebKit touch devices, `terminal-ios-native-input.js` owns the terminal's native textarea. Its support check shares `MobileImePreview.isIosWebKitTouch`; it loads after the preview and before the primary terminal and tile hosts. These hosts do not also install keyCode-229 recovery on iOS. Other coarse-pointer devices retain that recovery.

The native field retains the editable line, including dictation hypotheses and native newlines. Reconciliation emits shell-safe transactions rather than forwarding each browser event. A dictated line break must never send CR or LF. Trackpad movement changes only the visual caret; it sends no terminal arrows, never focuses the field and never changes its selection.

The owner exposes `caret(): { visible, text, offset }`, with projected text and a UTF-16 offset into that projection (CRLF and LF each become one space). The marker has two authoritative positioning modes:

- **Local echo:** the field must be an exact suffix of the overlay's last displayed `committedText`. The marker queries `getInputAnchor(base + offset)` for the painted cell, including wide-character wraps. A mismatch or unavailable/clipped layout hides it.
- **Parsed buffer:** with echo off, passthrough, tiles or Pane B, the marker matches the full native text backwards from xterm's cursor, crossing only soft wraps. It skips wide-glyph continuation cells and validated empty wrap padding, then maps the offset to an actual buffer cell. A mismatch, an identical preceding repetition, an offset inside a combined cell (such as a combining mark or ZWJ cluster), or an offscreen row hides it. After a native text change it also hides until the next `onWriteParsed`, rather than mistaking old output for a delivered edit.

Both modes hide for an unfocused field, composition, a range selection, the end of the field, a pending/unreconciled edit, an invalidated baseline, a failed transaction sink or a borrowed clipboard snapshot. No mode estimates the caret by subtracting a text width from an end anchor.

Programmatic input calls `_prepareExternalInput` on the captured pane before sending. Toolbar Enter calls `submitFromToolbar()`. The per-session FIFO reserves pending local-echo text, an 80ms gap, and CR together, so switching sessions cannot redirect CR or let later edits overtake it. This is enqueue ordering, not an acknowledgement-completion fence. Logical ACK fences, tagged HTTP success semantics, HTTP/WebSocket handover gating and `/send-key` ACK fencing are outside this fix.

## Browser regression suite

```sh
node scripts/prepare-test-vendor.mjs
npm run test:browser -- test/ios-native-input.browser.test.ts
```

The browser runner also prepares the source-served vendor overlay through `pretest:browser`. `src/web/public/vendor/` is gitignored; source vendor is generated, not tracked. Production builds independently regenerate the overlay from `packages/xterm-zerolag-input` and content-hash it. The overlay must include `getInputAnchor` and `committedText` before running these tests.

The suite serves the real application with Chromium, an iPhone user agent, touch points and a coarse pointer. It observes `_enqueueReliableInput` without replacing `_sendInputAsync`, and reuses the phone-validated WebKit replay defaults. Assertions cover suggestion op boundaries, phrase replacement, held delete, dictation newline suppression, toolbar submission and subsequent suggestions, old-session CR ownership during the gap, trusted CDP paste, caret geometry in both echo modes, emoji deletion, tile session ownership and non-iOS recovery.

These are browser wiring tests, not a substitute for device replay. The logged iPhone event sequences they replay are in [#830](https://github.com/Ark0N/Codeman/issues/830).
