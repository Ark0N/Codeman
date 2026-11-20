# iOS keyboard ownership (#830)

On iOS WebKit touch devices, `terminal-ios-native-input.js` owns the terminal's native textarea. Its support check shares `MobileImePreview.isIosWebKitTouch`; it loads after the preview and before the primary terminal and tile hosts. These hosts do not also install keyCode-229 recovery on iOS. Other coarse-pointer devices retain that recovery.

The native field retains the editable line, including dictation hypotheses and native newlines. Reconciliation emits shell-safe transactions rather than forwarding each browser event. A dictated line break must never send CR or LF. Trackpad movement changes only the visual caret; it sends no terminal arrows. With local echo, caret geometry comes from the overlay's input-end anchor, and unavailable geometry hides the marker.

Programmatic input calls `_prepareExternalInput` on the captured pane before sending. Toolbar Enter calls `submitFromToolbar()`. The per-session FIFO reserves pending local-echo text, an 80ms gap, and CR together, so switching sessions cannot redirect CR or let later edits overtake it. This is enqueue ordering, not an acknowledgement-completion fence. Logical ACK fences, tagged HTTP success semantics, HTTP/WebSocket handover gating and `/send-key` ACK fencing are outside this fix.

## Browser regression suite

```sh
node scripts/prepare-test-vendor.mjs
npm run test:browser -- test/ios-native-input.browser.test.ts
```

The browser runner also prepares the source-served vendor overlay through `pretest:browser`. `src/web/public/vendor/` is gitignored; the source vendor is generated, not tracked. Production builds independently regenerate the overlay from `packages/xterm-zerolag-input` and content-hash it. The overlay must include `getInputEndAnchor` before running these tests.

The suite serves the real application with Chromium, an iPhone user agent, touch points and a coarse pointer. It observes `_enqueueReliableInput` without replacing `_sendInputAsync`, and reuses the phone-validated WebKit replay defaults. Assertions cover suggestion op boundaries, phrase replacement, held delete, dictation newline suppression, toolbar submission and subsequent suggestions, old-session CR ownership during the gap, trusted CDP paste, caret geometry in both echo modes, emoji deletion, tile session ownership and non-iOS recovery.

These are browser wiring tests, not a substitute for device replay. The logged iPhone event sequences they replay are in [#830](https://github.com/Ark0N/Codeman/issues/830).
