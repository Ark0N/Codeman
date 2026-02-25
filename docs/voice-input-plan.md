# Voice Input V2 — Implementation Plan

## Executive Summary

Fix and improve the existing VoiceInput implementation. The core class is solid but has **critical integration bugs** that prevent it from working on mobile, plus several UX improvements needed to make it feel fast and polished.

---

## Current State: What Exists

The `VoiceInput` singleton (app.js:602-830) is already committed and uses the Web Speech API with:
- Toggle mode (tap start/stop), 5s silence auto-stop
- `interimResults: true` for streaming transcription preview
- iOS Safari `isFinal` workaround (750ms stability timer)
- Desktop button in `toolbar-right`, mobile button in `KeyboardAccessoryBar`
- `voice-pulse` CSS animation, `.voice-preview` overlay
- Cleanup on SSE reconnect, haptic feedback on mobile

## Critical Bugs Found (Must Fix)

### Bug 1: Mobile button NEVER shows (CRITICAL)
`KeyboardAccessoryBar.init()` runs at line 2239, BEFORE `VoiceInput.init()` at line 2240. The accessory bar template checks `VoiceInput.supported` at render time — but `init()` hasn't run yet, so `supported` is still `false`. The inline `style="${VoiceInput.supported ? '' : 'display:none'}"` always resolves to `display:none`.

**Fix:** Move `VoiceInput.init()` BEFORE `KeyboardAccessoryBar.init()`, OR remove the inline style check and have `VoiceInput.init()` show/hide the mobile button after the fact (like it does for desktop).

### Bug 2: `_showButtons()` ignores mobile button
`_showButtons()` only targets `#voiceInputBtn` (desktop). It never removes `display:none` from the mobile `[data-action="voice"]` button.

**Fix:** Add mobile button selector to `_showButtons()`.

### Bug 3: Recognition instance leak on cleanup
`cleanup()` stops recording and removes the preview element, but doesn't null out `this.recognition`. After `cleanup()` + `init()` on SSE reconnect, the old `SpeechRecognition` instance with its handlers is orphaned.

**Fix:** Add `this.recognition = null` in `cleanup()`.

## UX Improvements (Should Fix)

### Improvement 1: Consider auto-sending after voice
Currently, voice text is inserted but the user must press Enter. This is safe but adds friction. Two options:
- **Option A (safe, current):** Insert text, user presses Enter — good for a terminal where wrong commands matter
- **Option B (fast):** Insert text + auto-send `\r` after a brief 500ms delay — feels more "voice assistant"-like
- **Recommendation:** Keep Option A as default, but add an optional setting for auto-send

### Improvement 2: Shorter silence timeout for commands
5 seconds of silence before auto-stop feels slow for short terminal commands. Consider:
- 3 seconds for auto-stop (still generous for natural pauses)
- Or make it configurable via settings

### Improvement 3: Better visual state on mobile
The blue-tinted voice button in the accessory bar is distinctive but subtle. When recording:
- The `.recording` class turns it red with pulse — good
- But the button is small among other buttons — easy to miss the state change
- Consider: also show a small red dot indicator in the header or terminal area during recording

## Architecture Decision: Keep Web Speech API

Confirmed by research: Web Speech API is the right choice.
- **Free, fast (150-300ms interim), trivial complexity**
- Chrome + Safari = ~70% of users, ~95% of Claudeman's target audience (devs on Chrome)
- Works on localhost without HTTPS
- Accuracy is adequate for English command dictation
- Deepgram streaming (Phase 2 optional) only if accuracy complaints arise
- Skip Whisper batch entirely (too slow for interactive voice input)

## Implementation Plan

### Phase 1: Fix Critical Bugs (Priority)

**File: `src/web/public/app.js`**

1. **Fix init order** — Move `VoiceInput.init()` BEFORE `KeyboardAccessoryBar.init()`:
```
// Current (broken):
KeyboardAccessoryBar.init();
VoiceInput.init();

// Fixed:
VoiceInput.init();
KeyboardAccessoryBar.init();
```

2. **Fix `_showButtons()` to handle mobile** — Add mobile button selector:
```javascript
_showButtons() {
  const desktopBtn = document.getElementById('voiceInputBtn');
  if (desktopBtn) desktopBtn.style.display = '';
  // Also show mobile button (may not exist yet if KeyboardAccessoryBar hasn't init'd)
  const mobileBtn = document.querySelector('[data-action="voice"]');
  if (mobileBtn) mobileBtn.style.display = '';
}
```

3. **Fix cleanup leak** — Null out recognition instance:
```javascript
cleanup() {
  if (this.isRecording) this.stop();
  if (this.previewEl) {
    this.previewEl.remove();
    this.previewEl = null;
  }
  this.recognition = null;  // <-- add this
  clearTimeout(this.silenceTimeout);
  clearTimeout(this._stabilityTimer);
  // ... rest
}
```

4. **Remove inline style from mobile button template** — Since `_showButtons()` will handle visibility, the template should always render the button visible and let `init()` hide it if unsupported:
```
// Current (broken):
style="${VoiceInput.supported ? '' : 'display:none'}"

// Fixed: remove the style attr entirely, let _showButtons/_hideButtons manage it
```
Actually better: **always show the button** if we init VoiceInput before KeyboardAccessoryBar. The `VoiceInput.supported` will be set correctly by then.

### Phase 2: UX Polish

5. **Reduce silence timeout** from 5s to 3s for snappier feel

6. **Add recording indicator** — When recording, add a subtle pulsing red dot to the session header or status area so the recording state is visible even if the button is off-screen

7. **Voice input setting** — Add a toggle in App Settings to enable/disable voice input (some users may not want the button). Default: enabled on supported browsers.

### Phase 3: Future Enhancements (Not in this PR)

- Language selector (currently hardcoded `en-US`)
- Auto-send option (insert text + `\r` automatically)
- Deepgram WebSocket fallback for Firefox/Edge
- Waveform visualization during recording
- Voice command recognition ("clear", "compact", "new session")

## Files to Modify

| File | Changes |
|------|---------|
| `src/web/public/app.js` | Fix init order, fix `_showButtons()`, fix `cleanup()`, remove inline style, reduce silence timeout |
| `src/web/public/mobile.css` | (optional) Adjust voice preview positioning if needed |

## Testing Plan

1. **Desktop Chrome:** Verify mic button visible in toolbar-right, click toggles recording state, interim text shows in preview, final text inserted at prompt
2. **Mobile Chrome (emulated):** Verify mic button visible in accessory bar, tap toggles recording, pulse animation plays
3. **Firefox:** Verify mic button is hidden (no SpeechRecognition support)
4. **SSE reconnect:** Verify cleanup stops recording and re-init works
5. **No active session:** Verify toast "No active session" shows when tapping mic with no session

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| iOS Safari isFinal bug | Medium | Already handled by 750ms stability timer |
| Chrome auto-stops after 60s | Low | Prompts are short; 3s silence timeout covers this |
| Mic permission denied | Low | Error toast with clear message |
| Init order regression | High | Integration test to verify button visibility |
